---
doc:         analysis-model/05-pipeline-ops
class:       module
scope:       采集链路：场次枚举、分页取全（大页 200k / 以 total 为准 / 合并去重）、重试与超时、固定并发 1、聚合与修复顺序、质量闸、gzip 落盘、进度字段、任务级补采、落盘回读校验、重采运维
not-scope:   数据层字段与窗口口径 → analysis-model/01-data.md；三轴与类型 → analysis-model/02-model.md；独轮车与 bp → analysis-model/03-tags-spam.md
sot:         app/services/fan/collector.py, app/services/fan/quality_gate.py, app/services/fan/quality.py, app/services/fan/duration.py, app/services/fan/sysmsg.py, app/services/fan/acv.py, app/routers/fan.py
verify:      .\.venv\Scripts\python.exe -m pytest -q tests/test_fan_collector.py tests/test_fan_gate.py；python scripts/verify_recollect.py --help
budget:      380
retire-when: 采集链路换成数据库直连或上游接口换代
---
# 05 · 采集链路与运维

## 0. 本文管什么

fan 模块的数据不是主抓取链路顺带采的，而是一个**用户显式触发、独立并发、可取消**的采集任务：
每场几 MB、连续几十场。本文写它怎么取、怎么重试、怎么落盘、怎么报进度、失败后怎么补，
以及重采/回填脚本的准入条件。

> 采集只写**数据根**，不写业务库；分析只读数据根（`loader` 不写文件）。
> 采集链路与主抓取链路分开，避免拖慢主循环、避免撞 `backend/ARCHITECTURE.md` 的并发不变量。

## 1. 一次采集的流程

```
枚举场次（本地 live_sessions 优先；缺失才问上游 channel）
  → 按 since/until 闭区间筛
  → 逐场：fetch_records（大页 200k；不够再 5000/页翻页）
  → aggregate（有效窗口过滤 → 逐人聚合 → 文本指纹 → stats）
  → apply_replay_cut（后段回放）
  → apply_rate_end（弹幕率骤降）
  → apply_sys_end（系统消息下播）
  → quality_gate.evaluate（L1/L2/L3，只标记）
  → acv_from_online_rank（ACV / 峰值）
  → coverage（平台计数 vs 实拉）
  → _write（先 raw.gz 后 stats）
  → _verify（回读校验）
```

`SessionPlan` 带 `live_id`、`start_at`、`stop_at`、平台 `danmakus_count`、`income`。
`stop_at` 有就用平台时间算跨度；没有则由 `aggregate` 回退到弹幕跨度。

**本地优先**：`list_sessions_from_db` 只取 B 站账号下 `live_id` 长度 >20 的行；
本地查不到才调上游 `/api/v2/channel`。原因是已归档场次不该再问上游，且 channel 端点
实测会 502（2026-10-18）。

## 2. 取数：分页、超时、重试

### 2.1 常量

| 常量 | 值 | 含义 |
|---|---|---|
| `COLLECT_PAGE_SIZE_BIG` | 200,000 | 首次请求的大页（不带 `pageNum`） |
| `COLLECT_PAGE_SIZE` | 5,000 | 翻页页大小 |
| `COLLECT_MAX_PAGES` | 60 | 单场最多翻 60 页（30 万条） |
| `FETCH_EMPTY_ATTEMPTS` | 3 | 单页返回空但 total>0 时的重试次数 |
| `COLLECT_ATTEMPTS` | 3 | 单个请求的重试次数（含首次） |
| `COLLECT_TIMEOUT_S` | 120 s | 基础超时 |
| `COLLECT_GAP_S` | 0.2 s | 相邻请求最小间隔 |
| `COLLECT_CONCURRENCY` | **1** | 并发度固定串行 |
| `ENUM_TIMEOUT_S` / `ENUM_ATTEMPTS` | 15 s / 2 | 枚举场次的快速失败预算 |
| `RETRY_BASE_S` / `RETRY_MAX_S` | 0.8 / 20 s | 指数退避基数 / 单次上限 |
| 抖动 | ±30% | `_retry_delay` 的 jitter |

### 2.2 为什么要大页 + 翻页 + 合并

上游有三类坑（2026-10-20 实测）：

1. 超大 `pageSize`（100,000）会**静默截断**并谎报 `hasMore=false`（100k → 55,264，
   实际 155,264）；
2. 部分场次**带上 `pageNum` 就返回 0 条 / total=0**，不带则正常；
3. 并发时偶发空页；`total` 也可能被谎报成 100,000（正好等于大页上限）；
4. 同一场不同时间查询，结果会变（镜像在持续补索引）—— 本模块每次重采都可能得到不同集合，
   所以事实表落盘即冻结，不覆盖。

对策：

- **首次不带 `pageNum`**，`pageSize=200,000`；拿到的条数若已 ≥ `total` 且 < 200,000，
  直接就是全量（小场次快路径）。
- 否则按 `5,000/页` 翻页；**以 `total` 为准**，`hasMore` 只作辅助。
  2026-10-27 实测：平台计数 128,623，第 25 页 `hasMore=False`，只拿到 123,623 ——
  正好少一页 5,000。所以「没拉够就继续翻」。
- 翻页第 1 页若返回空，退回首次大页结果（有些场次不认 `pageNum`）。
- 最后把「大页」与「翻页」两份记录**按 `(type, uId, sendDate, message, price)` 合并去重**：
  实测有场次大页残缺、翻页完整，也有反过来的；合并才稳。
- 合并后若比大页还少，退回大页（保守，不丢数据）。

### 2.3 超时按记录数自适应

固定 120 s 会把 15 万条的场次腰斩。翻页请求用：

```
timeout = min(600, max(120, total / 1000 * 3))
```

| 记录数 | 超时 |
|---|---|
| ≤ 4 万 | 120 s（保底） |
| 5 万 | 150 s |
| 15 万 | 450 s |
| ≥ 20 万 | 600 s（上限） |

### 2.4 重试与状态分类

- 重试前等待 `min(20, 0.8 × 2^(attempt−1)) × (1 ± 0.3)`：**指数退避 + 抖动**。
  抖动是为了打散并发任务的重试时刻，避免 504 风暴叠在同一秒。
- 4xx 里只有 **408（超时）与 429（限流）**值得重试；`404/403` 直接放弃（以前会白等 3 轮）。
- 非 JSON 响应、网络异常重试；每次失败后至少 `COLLECT_GAP_S`。
- 枚举场次用独立预算（15 s / 2 次），上游挂掉时快速失败，不让界面像卡死。

### 2.5 并发固定 1（不是没试过更高）

2026-10-27 实测：

- **短请求**并发有效：同一主播 4 场、每场 `pageSize=5000&pageNum=1`，串行 1.68 s，
  4 路并发 0.90 s（比值 0.53）。
- **整场抓取**并发无效甚至更慢：两场 12 万+ 条，串行 57.1 s，2 路并发 66.6 s（0.86×）。
  上游对「同一场的长分页流」基本是串行服务的，并发只会放大 504。

⇒ `COLLECT_CONCURRENCY = 1` 保留。**不要为了「看起来快」改回 3**。

## 3. 聚合与修复顺序

`collect()` 在拿到记录后按固定顺序调用（后三步都**只让场次变短**）：

1. **有效窗口**：优先 `sys_start/sys_end`（type 11/12），其次平台跨度，最后事件跨度；
   窗口外 ±60 秒的记录丢掉，避免 `live_id` 复用/平台 `start_at` 偏早把别场弹幕混进来。
2. `aggregate`：逐人聚合、文本哈希、`uniq/maxrep`、`msh`、`stats`、`bp`。
3. `apply_replay_cut`：按小时比较 `(uid, 文本哈希)` 多重集合，≥80% 且 ≥50 条 ⇒ 判回放，
   从第一个回放小时起丢弃弹幕。
4. `apply_rate_end`：5 分钟桶 / 前 5 小时 p75 基线 / 10% 阈值 / 第 5 小时后 / +30 分钟宽限。
5. `apply_sys_end`：取最晚的 type 7/12 系统消息 + 1 分钟，只允许变短。
6. `quality_gate.evaluate`：三层对账，**只标记不丢弃**。
7. `acv_from_online_rank`：ACV / 点数 / 峰值；没有 `onlineRank` 记 `None`。
8. `coverage`：平台计数 vs 实拉；低于 95% 且平台给了计数 ⇒ `quality.status = partial`
   （不覆盖更严重状态），并写 `note`。
9. `_write` + `_verify`。

> 回放/率降/系统消息的判据细节见 `01-data.md` §9；不要在采集器里另写一套。

## 4. 质量闸（L1/L2/L3）

| 层 | 对账 | 抓什么 |
|---|---|---|
| L1 | 自己的 `type_hist` 求和 vs `records` | 聚合写错 |
| L2 | 平台 `danmakusCount` / `totalIncome` | 抓取截断、收入缺失 |
| L3 | vtb.cat `/live/list` 的 `Message` / `Money` | 我们漏采（仅当 vtb 自己也收得够多） |

**匹配规则**：vtb 的 `StartAt` = 我们的 UTC epoch **+8 小时**（它的坑）；容差 1 小时；
`Message < 100` 视为「对方没索引」，不参与判定。

**处置口径（2026-10-17 定案，2026-10-21 修正）**：只标记，不丢弃。外部源只是校验器，
danmakus 是超集；只有「**我们比对方少 10% 以上**且对方收得够多」才说明可能漏了。

现行状态：

| 状态 | 触发 |
|---|---|
| `ok` | 三层都过 |
| `inconsistent` | L1 直方图求和 ≠ records（最高优先级） |
| `low_coverage` | 平台与 vtb **都**说我们少；或只有平台可用且说我们少 |
| `platform_suspect` | 平台说我们少，但 vtb 说我们够（平台的数偏大） |
| `vtb_suspect` | 平台说够，vtb 说我们少（vtb 侧合并/错配） |
| `low_income` | 弹幕够，但收入比任一侧少 10% |
| `no_external` | 没有 vtb 数据，且平台侧没有异常 |
| `partial` | 实拉 < 平台计数 95%（collector 额外补的状态） |

**为什么要求双源**：2026-10-21 抽查 17 场 `low_coverage` 里 13 场是单侧误报。
单侧「少」不足以定罪，只有两边都说少才是真截断。

## 5. 落盘：gzip、去 `pl`、原子写、回读

### 5.1 体积

| 变化 | 效果 |
|---|---|
| raw 改写 `.json.gz`（gzip level 6） | 实测 **1,023 KB → 93 KB（9.1%）** |
| 去掉死字段 `pl`（逐笔金额，无人读取） | 未压缩 -2.2% |
| 新增 `msh`（simhash） | 每条 8 字节，压缩后约 **+10%** |
| 保留 `mh` | 删掉只省压缩后约 10%，却永久失去事后重算能力 |

2026-10-27 四 V 重采后：raw **309 场 / 307.4 MB**（含 55 MB 头像缓存），
平均约 **0.82 MB/场**（压缩后；重采前 3.7 MB/场）。

### 5.2 写入顺序

1. `raw/<live_id>.json.gz`：先写 `.tmp`，`os.replace` 原子替换；
2. `stats/<live_id>.json`：先写 `.json.tmp`，`os.replace` 原子替换。

**先 raw 后 stats**：stats 存在就代表这一场齐了。读取侧兼容老明文：
`loader` 先找 `.json.gz`，没有再回落 `.json`；`_raw_path` 与跳过判断同样认两种。

### 5.3 回读校验

`_verify(base, live_id)` 检查三件事：两个文件都在、`stats` 能解析、`live_id` 对得上。
不通过 ⇒ 该场 `failed`，逐场列表写「落盘后校验失败」。这样「文件写了但内容不对」
这种静默损坏会被当场抓住（2026-10-27 新增）。

### 5.4 跳过已采

`stats` 与 `raw`（`.json.gz` 或 `.json`）都存在 ⇒ `skipped`，不覆盖。
**这是有意的**：上游会漂移，覆盖等于销毁证据；要更新必须显式重采（见 §8）。

## 6. 进度字段

`CollectProgress.as_dict()` 是前端唯一读的结构。字段：

| 字段 | 含义 |
|---|---|
| `state` | `running / done / failed / cancelled` |
| `total` / `done` / `failed` / `skipped` | 场次计数 |
| `failures[]` | 逐场失败 `{live_id, start_at, reason}` |
| `current` / `message` | 当前场次开始时间 / 人话提示 |
| `phase` | `fetch / aggregate / write / verify`（`enumerate` 是预留值：枚举在并发前完成，未单独打点） |
| `page` / `pages` | 当前场次翻页进度（仅 fetch 阶段） |
| `records` | 本次任务累计拉到的记录数 |
| `throughput` | `{records_per_s, sessions_per_min}`（实时算） |
| `eta_s` | 按已处理场次均耗时 × 剩余场次估算；样本不足 1 场为 `None` |
| `sessions_detail[]` | 逐场状态 `{live_id, start_at, state, records, reason}`（同一场只保留一条） |
| `elapsed` | 已耗时（秒） |

**教训（2026-10-27）**：字段在对象上赋值成功 ≠ 前端能拿到。`as_dict()` 曾漏掉
`phase/page/pages/records/throughput/eta_s/sessions_detail`，界面永远显示「准备中」。
进度类改动必须有「序列化」这一层的用例。

## 7. 失败、跳过与任务级补采

单场失败的三类原因：

1. 上游没有返回该场弹幕（可能下架/接口无数据）；
2. 返回记录太少（< `MIN_RECORDS` = 100）；
3. 落盘后回读校验失败。

**任务级补采**（2026-10-27）：整轮跑完后，对 `sessions_detail` 里 `state == "failed"` 的场次
**再试一轮**。上游 504 常是分钟级抖动，当场 3 次重试都落在同一窗口里；
整轮后再试等于把重试窗口拉长到几分钟，且不拖慢其他场次。

要点：

- **只补一轮**（再失败就真的失败），避免最坏情况无限延长；
- 补采前**回滚** `failed` 计数与 `failures`，避免重复计数；
- 用户取消（`should_stop`）时不补采；
- 补采异常只记日志，不影响已完成的部分。

最终状态：有取消标志 ⇒ `cancelled`；`done == 0` ⇒ `failed`（全部失败或已存在）；
否则 `done`。已写盘的场次在取消后保留。

## 8. 重采、回填与核对脚本

⚠️ **所有会删/改事实表的脚本，先备份数据根。** `recollect_fan.py` 会检查
`<数据根>.bak-*` 是否存在，没有就拒绝执行。

| 脚本 | 用途 | 危险度 |
|---|---|---|
| `scripts/recollect_fan.py` | 逐 V 删已登记场次后整体重采，并核对文件数/记录数/`uniq` 覆盖 | 高（先备份） |
| `scripts/recollect_all.py` | 按当前链路全量重采四个 V；先备份到 `dev/fan-structure.bak-<ts>` | 高 |
| `scripts/verify_recollect.py --root <根> --backup <备份>` | 重采后核对：场次数、逐场记录数偏差 >20%、`uniq` 覆盖、UTC/跨度、C1 | 只读 |
| `scripts/backfill_acv.py --root <根> [--apply]` | 给已有场次补 ACV（每场一次 `includeExtra`，写回 stats） | 中（先 `.bak-acv`） |
| `scripts/backfill_fan_span.py --root <根> [--dry-run]` | 用 raw 重算并回填被离群时间戳拉长的 `start_at`/`end_at` | 中（默认 dry-run） |
| `scripts/cut_replay.py --root <根> [--apply]` | 对已有数据执行回放裁剪 | 中（先 `.bak-replay`） |
| `scripts/spam_impact.py` | 三种口径对比独轮车影响（基线 / 去重 / 剔除） | 只读 |
| `scripts/acv_sensitivity.py` | 池子系数敏感性（1.0–4.0 × ACV） | 只读 |
| `scripts/pool_select_compare.py` | 按出席 vs 按核心度选名单的收入保留对比 | 只读 |
| `scripts/pool_leak_check.py` | 被分流走的人里有没有「高付费但低出席」的有效样本 | 只读 |
| `scripts/validate_fan_model.py` | 信度 / 样本外 / 效标 / 跨 V 全量验证 | 只读 |

> 旧脚本的 docstring 可能还写「2×ACV」。**以 `POOL_MULT = 3.0` 为准**；跑之前先确认
> 它读的是常量还是写死的数。

## 9. 观测与排障

| 症状 | 先看什么 |
|---|---|
| 场次数比请求少 | `Window.warnings` 里带「跳过」的行：记录数 <100 / 无入场事件 / raw 缺文件 |
| 全部 `unverified` | 正常：`/health` 没接外部源；不是数据坏了 |
| 池子为空 | 没有 ACV 且出席率 ≥10% 的人也为空；或窗口过滤后 0 场 |
| 首次分析慢 10–20 秒 | 正常：要读几百 MB JSON 并逐人聚合；之后有进程内缓存（不设失效） |
| 进度一直「准备中」 | 检查 `as_dict()` 是否漏字段（2026-10-27 的坑） |
| 某场缺 5,000 条 | 看 `stats.coverage.ratio` 与 `quality.status=partial`；L3 会抓 <95% |
| 504 一片 | 确认 `COLLECT_CONCURRENCY=1`、抖动生效；跑完后任务级补采 |

2026-10-27 四 V 全量重采耗时（仅作量级参考）：星瞳 628 s、七海 414 s、明前 14 s
（大部分已存在）、弥月 263 s；两场失败都是上游没数据。

## 10. 不要做的事

- **不要提高并发**：整场抓取没有收益，还会放大 504（§2.5）。
- **不要只看 `hasMore`**：它会在尾部提前变 false；以 `total` 为准。
- **不要覆盖已有 raw**：上游会漂移，覆盖等于销毁证据。
- **不要因为「和 vtb.cat 对不上」就弃场**：外部源只是校验器；弃用只认 C1。
- **不要在没备份时跑重采/回填脚本**。
- **不要把「唯一弃用理由」改成外部不一致**：C2–C4 只降级/标未核验。
