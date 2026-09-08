# 后端抓取链路详解（v0.9.3）

> 覆盖范围：账号信息抓取 + 帖子抓取两条链路的触发入口、任务模型、API 清单、
> 节流/频率、风控判定与处理策略。代码位置：`app/services/scheduler.py`
> （调度与循环）、`app/services/fetcher.py`（B 站请求）、
> `app/services/platforms/{bilibili,weibo}.py`（平台适配）、
> `app/routers/vtuber.py`（HTTP 入口）。
> 本文档记录 **2026-09-09 当前实现**，与代码同步维护。
> 总览/数据模型见 `docs/ARCHITECTURE.md`；表结构/仓储/接口见 `docs/backend-repositories-and-routers.md`。

---

## 1. 总览：两条链路

```
触发源                                锁                循环框架
─────────────────────────────────────────────────────────────
T1 主要账号（5min）/ T3a 全量（随 T2） _fetch_lock      run_main_account_sweep / async_fetch_and_update(auto=True)
/vtuber/fetch、/vtuber/{id}/fetch      _fetch_lock      async_fetch_and_update / async_fetch_vtuber
/vtuber/adopt、POST /{id}/accounts     _fetch_lock      _fetch_adopted → async_fetch_vtuber（后台）
/vtuber/fetch-accounts（批量面板）      _fetch_lock      async_fetch_and_update（后台）
─────────────────────────────────────────────────────────────
T2 最新动态（15min）                   _post_fetch_lock  run_latest_dynamics_sweep（每主账号 1 页 + 限 2 帖）
/vtuber/fetch-posts（快速/全量）        _post_fetch_lock  _fetch_posts_core（B站双流）
/vtuber/fetch-all-posts                _post_fetch_lock  async_fetch_all_posts → 逐账号
/vtuber/update-posts                   _post_fetch_lock  async_update_unarchived_posts → 增量
/vtuber/batch/*                        _post_fetch_lock  （批量面板，同上框架）
```

- **账号信息抓取**：刷新账号资料（昵称/签名/头像）+ 粉丝数 + **直播状态**（B 站），
  成功后写一行统计快照（`account_stat_snapshots`，P0）。
- **帖子抓取**：按平台拉帖子列表（B 站 = 视频流 + 动态流；微博 = 单流），
  新帖逐个补详情，入库去重；模式：全量 / 快速 / 增量 / 最新 N 条 / 仅动态。
- 两条链路**互斥运行**（各自独立锁）；**手动任务优先于定时档**（自动档断点让位，见 §3.2）。

---

## 2. 触发入口清单

| 端点 | 说明 | 默认参数 |
|---|---|---|
| `POST /vtuber/{id}/fetch` | 手动抓取单个 VTuber 全部账号信息（账号抓取） | — |
| `POST /vtuber/fetch-accounts` | 批量面板：全部账号信息 | — |
| `POST /vtuber/adopt` | 候选池收录 → 后台自动抓一次账号信息 + 回填该账号第三方历史 | — |
| `POST /vtuber/{id}/accounts` | 添加平台账号 → 后台抓该 V 账号信息 + 回填新账号第三方历史（v0.9.3） | — |
| `POST /vtuber/fetch-posts?name=&full=` | 按名字抓帖子；`full=true` 后台全量（视频+动态拉到底） | 非 full：video 3 页 / dyn 5 页（前端快速抓取实际传 2/3） |
| `POST /vtuber/fetch-all-posts` | 全部账号全量抓帖子（同步等待） | -1/-1 |
| `POST /vtuber/update-posts?name=` | 更新未归档动态：先跑归档规则（30 天）再增量抓取，归档边界即停 | 不含视频；`stop_on_existing=true` |
| `POST /vtuber/batch/fetch-all-posts` | 批量面板：全部账号全量帖子 | -1/-1 |
| `POST /vtuber/batch/update-unarchived` | 批量面板：全部账号增量动态 | 同 update-posts |
| `POST /posts/archive?days=30` | 归档规则（幂等）：published_at 早于 N 天前 → archived | 30 |

定时档（T1/T2/T3a）由 `_tier_loop` 驱动：启动链语义并入首轮，之后心跳
（`TIER_TICK_SECONDS=10s`）检查到期；APScheduler 仅保留 T4 外部数据 cron（每日/每周），
原 5min 的 `fetch_vtubers` IntervalTrigger 已由 T1/T3a 取代（见 §4.3）。

---

## 3. 任务模型：锁、让位、状态

### 3.1 全局单飞

- `_fetch_lock`（账号）与 `_post_fetch_lock`（帖子）：手动任务拿不到锁时先请求
  自动任务让位（见 3.2），仍拿不到才返回 `skipped`。
- `any_fetch_running()` = 账号在跑 ∨ 帖子在跑 ∨ 定时任务正请求让位 ∨
  有手动任务在等让位（让位窗口也视为忙，防真空期钻空并发）——外部数据批次
  （T4）等自动任务据此跳过。
- `manual_task_running()` = 是否有**手动**任务在跑（自动档持锁不算）——
  手动端点用它做 409 判定，这样用户手动请求不会被定时档挡在门外（v0.9.3）。

### 3.2 手动任务优先：自动任务让位（v0.9.3，devlog/040）

用户手动任务（收录新 V 拉起的单V抓取、抓取账号/帖子/更新动态）优先级高于
定时档 T1/T2/T3a：手动侧拿不到锁且**占用者是自动档**时置位抢占信号
（`_preempt_account` / `_preempt_post`）并轮询等锁；自动档在**断点**（账号之间）
看到信号后 `db.commit()` → 释放锁 → 等信号清除 → 重新拿锁 → 从原序号续跑。

- `_acquire_manual_account()/ _acquire_manual_post()`：手动侧抢锁（最多等
  `MANUAL_PREEMPT_WAIT_SECONDS=120s`，超时按原语义跳过）；占用者是**另一个
  手动任务**时不抢（手动之间不互相打断）。
- `_maybe_preempt_account(db)` / `_maybe_preempt_post(db)`：自动侧断点检查；
  让位辅助 `_auto_yield_account` / `_auto_yield_post` 保存并恢复 `_fetch_scope`。
- 自动档自身起跑时仍是"锁被占就跳过"（不打断手动任务）——两条方向合起来才是
  "手动 > 自动"。
- **旧机制**：`_yield_request`（定时任务置位、手动让位）自 v0.6.0 起已无置位方，
  代码保留但不再参与；方向由本节取代。

### 3.3 进度状态 & 结果

- `_status["account"]`：`running/current/index/total/recent[≤100]` + `last_result{seq,...}`；
- `_status["post"]`：`running/target` + `last_result{kind, stored, skipped, issues, video_missing}`；
- 前端经 `GET /vtuber/fetch-status` 每 ~2s 轮询；`recent` 增长驱动侧栏就地合并。

### 3.4 风控状态隔离（ContextVar）

风控标志是**任务上下文**级而不是模块级（`fetcher.py:16-21`）：
账号抓取与帖子抓取可能先后运行于同一进程/不同线程，模块级全局变量会导致
**跨任务污染**（帖子任务的风控被账号任务误读、错误进入冷却）。因此
`_rate_limit_ctx: ContextVar` 默认 `(False, "")`，进入任务时 `clear_rate_limit()`。

---

## 4. 账号信息抓取

### 4.1 循环节奏（`async_fetch_and_update`）

```
for 每个账号:
    让位检查 → fetch_user_info(1~N req) → 风控? 冷却 600s 续跑
    → sleep(3~5s 随机)     # REQUEST_INTERVAL_MIN/MAX
    → 成功: 写快照 + commit + push实时快照
    每 10 个账号: sleep 60s   # FETCH_BATCH_SIZE / FETCH_BATCH_COOLDOWN
```

- 账号列表：`AccountRepo.all_for_fetch()`（有 platform_uid 的全部账号）。
- 单账号请求量：B 站 = `acc/info`(WBI) + `relation/stat` 共 **2 req**（+头像下载 1 req，仅 URL 变化或文件缺失时）；
  微博 = `profile/info` **1 req**（+头像下载）。
- 直播状态来自 `acc/info` 的 `live_room.liveStatus/title/roomid`（B 站专属）。

### 4.2 定时频率上限测算（以 16 账号为例）

| 项 | 值 |
|---|---|
| 一轮请求量 | 16 × 2 ≈ 32 req（B 站） |
| 一轮耗时 | 32 req × ~4s 间隔 + 1 次 60s 批次休息 + 网络 ≈ 2.5~4 min |
| 平均速率 | ≈ 32 req / 5 min ≈ **7 req/min** ✅（< 20/min） |
| 突发速率 | 2 req / 3~5 s ≈ 24~40 req/min ⚠️（仅该值瞬时，靠批次休息摊平） |

结论：账号链路的**平均速率安全**，突发略高于 20/min 但空间接口阈值较宽。

### 4.3 时效分层调度（v0.6.1，devlog/028）

按**时效敏感度**把周期抓取任务分层（原「APScheduler 5min 全量账号任务 + 启动链」
合并为该模型）：

| 层 | 内容 | 形态 | 默认周期 | 冲突策略 |
|---|---|---|---|---|
| **T0 直播状态** | 批量接口仅回写 live 字段（跳变落统计快照） | **独立守护线程**（不占锁/不进状态通道/不写 last_result） | 60s ± 15s | 与一切任务并行（SQLite busy_timeout=30s 排队兜底） |
| **T1 主要账号信息** | 每 VTuber 主账号全字段（`PRIMARY_PLATFORM_ORDER` 优先） | 分层调度线程（账号锁） | 5min ± 30s | 起跑时手动任务在跑 → **跳过本轮**；持锁期间手动请求 → **断点让位**（v0.9.3） |
| **T2 最新动态** | 每主账号 1 页 + `limit_latest=2` | 分层调度线程（帖子锁） | 15min ± 2min | 同上 |
| **T3a 全量账号** | 全部账号全字段（含非主账号，补足 T1 不覆盖的账号） | **紧接 T2 之后串行执行（与 T2 同频率 15min）**，`FULL_ACCOUNT_AFTER_T2=false` 关闭 | 随 T2 | 同上 |
| **T3 手动全量/补档** | 用户触发（全量账号/全量帖子/单 V/未归档批量端点） | — | 手动 | 永远优先于 T1/T2/T3a（拿不到锁时请求自动档让位）；仅被 T0 并行（互不打扰） |
| **T4 外部数据** | zeroroku/danmakus | APScheduler cron | 3AM 日/周 | 保持现状 |

调度细节：

- `start_live_poller()`：T0 线程；首轮于 `STARTUP_CHAIN_DELAY` 后立即执行
  （启动即最快刷新直播），之后循环轮询；`LIVE_POLL_SECONDS<=0` 关闭；
- `start_tier_scheduler()`：T1/T2/T3a 调度线程；启动后先按启动链语义
  立即跑 T1→T2→T3a（`STARTUP_CHAIN_ENABLED`），然后心跳
  （`TIER_TICK_SECONDS=10s`）检查到期；任一手动抓取在跑 → 本轮全部定时档
  跳过；到期档位按 T1→T2 贪心串行（单线程任务，无档间并发），
  **T2 执行完立即接 T3a 全量账号**（同一档期，与 T2 同频率）；
- 每档周期带抖（`_tier_delay`）；interval<=0 的档位禁用；
- T1/T2 不写 `last_result`（5~15 分钟弹一次完成胶囊会刷屏；前端完成汇总
  只服务手动任务）；T3a 走 `async_fetch_and_update`（与 T2 同频，汇总随
  手动任务口径不弹——T2 档期以 T2 的任务名计）；
- T0 的进度反馈 = `account-progress` 快照驱动的左右栏徽标（无进度条/无胶囊）；
- 冲突方向（v0.9.3 定稿）：**手动 > 自动**——自动档起跑时见手动任务即跳过，
  持锁期间见手动请求则断点让位；旧「定时任务优先让位协议」（`_yield_request`）
  已无置位方，代码保留但不参与调度；原 APScheduler 的 5min `fetch_vtubers`
  job 已移除，仅保留外部数据 cron。

配置：`TIER_TICK_SECONDS`、`LIVE_POLL_SECONDS/JITTER`、
`ACCOUNT_PRIMARY_INTERVAL_MINUTES/JITTER`、`DYNAMICS_LATEST_INTERVAL_MINUTES/JITTER`、
`FULL_ACCOUNT_AFTER_T2`（+ 启动链/限帖配置沿用）。

---

## 5. 帖子抓取（B 站双流核心 `_fetch_posts_core`）

### 5.1 流程

```
前置：existing_ids / archived_ids 全量查库（内存去重，防唯一约束回滚）
视频流（含 video_pages 页数限制）:
    arc/search?ps=30&pn=n&order=pubdate       页间 sleep 1s
    → 整页已归档 → archived_stop 终止
    → 全部已入库 → skipped（不停止，继续翻页）
动态流（含 dynamics_pages）:
    feed/space?host_mid=&offset=              页间 sleep 20s
    → 直播开播动态（LIVE_RCMD）丢弃
    → stop_on_existing: 首页第 1 条豁免（防置顶旧帖误停），
      从第 2 条起遇到已入库 → 立即停止（更早的必然已入库）
    → 整页已归档 → archived_boundary 终止
逐帖详情补全（只有【未入库】的帖子才请求）:
    text/image   → web-dynamic/v1/detail (OPUS 全文/大图)      sleep 0.5~2s
    article      → x/article/view (专栏全文, 含 Quill Delta)    sleep 0.5~2s
    video_dynamic→ x/web-interface/view (简介/时长/分区/统计)   sleep 0.5~2s
批量入库：pending 攒 50 条 commit 一次（SQLite fsync 优化）
```

### 5.2 五种调用模式

| 模式 | 参数 | 特征 |
|---|---|---|
| 快速抓取（前端按钮） | `video_pages=2, dynamics_pages=3` | 小规模，同步等待（非 full 分支） |
| 全量（`full=true`） | `-1/-1` 拉到底 | `BackgroundTasks` 后台跑，进度见顶栏 |
| 更新未归档 | `include_videos=False, stop_on_existing=True` | 只抓动态第一页（通常），归档边界即停 |
| 最新 N 条（T2） | `limit_latest=STARTUP_DYNAMICS_LIMIT(2)` | 同页最多入库 N 条新帖即停，单次时长有上界 |
| 按名抓取 | `video_pages/dynamics_pages` 自定 | 对匹配名字的全部账号逐个调用 |

### 5.3 微博单流（`_fetch_platform_posts`）

```
mymblog?uid=&page=&feature=0         页间 sleep 20s
→ has_more = 有列表且 data.since_id 非空
→ isLongText 的帖 → m.weibo.cn/statuses/extend（PC cookie 可用；手机 UA）
→ 同样支持 stop_on_existing / 归档边界 / 风控页重试
```

---

## 6. API 清单

### 6.1 B 站（全部带 `auth_manager.build_headers()`，UA + 通用 Cookie）

| API | 用途 | 签名 | 风控敏感度 |
|---|---|---|---|
| `GET /x/web-interface/nav` | WBI 密钥（缓存 30min）与登录心跳 | 无 | 低 |
| `GET /x/space/wbi/acc/info` | 账号资料 + live_room（直播状态） | WBI | 中 |
| `GET /x/relation/stat` | 粉丝/关注数 | 无 | 低 |
| `GET /x/space/wbi/arc/search` | 视频投稿列表（30/页，order=pubdate） | WBI | 中（列表） |
| `GET /x/polymer/web-dynamic/v1/feed/space` | 动态流 | 无 | 中（列表） |
| `GET /x/polymer/web-dynamic/v1/detail` | 单条动态详情（OPUS） | 无 | **高（风控最严）** |
| `GET /x/web-interface/view` | 视频详情（bvid） | WBI | 中 |
| `GET /x/article/view` | 专栏全文（cv_id） | 无 | 低 |

### 6.2 微博（PC ajax，Cookie = 扫码登录保存的 WEIBO_COOKIE）

| API | 用途 |
|---|---|
| `GET weibo.com/ajax/profile/info` | 账号资料（screen_name/avatar_hd/followers_count） |
| `GET weibo.com/ajax/statuses/mymblog` | 微博列表（page/feature=0；ok=-100 需登录） |
| `GET m.weibo.cn/statuses/extend` | 长文全文（isLongText 时；PC cookie 可用，wap 登录态不判） |

### 6.3 登录 / 认证（独立于抓取，见 weibo_auth.py / auth.py）

| API | 用途 | 频率 |
|---|---|---|
| `GET passport.bilibili.com/...qrcode/image?entry=xxx` | B 站二维码生成 | 用户点击触发 |
| `GET passport.bilibili.com/...qrcode/check` | B 站扫码轮询 | 前端 2s/次（仅对话框打开且二维码显示中） |
| `GET weibo.com/ajax/profile/info`（check_valid 探测） | 微博登录态真实性校验 | 仅 `/auth/weibo/status` 调用；60s 缓存 |
| `GET passport.weibo.com/sso/v2/qrcode/image` + `GET v2.qr.weibo.cn/inf/gen` | 微博二维码生成 | 用户点击触发 |
| `GET passport.weibo.com/sso/v2/qrcode/check` | 微博扫码轮询 | 前端 2s/次（同上） |
| B 站 `nav`（run_maintenance） | 会话有效性维护 | **30 分钟一次**（仅 B 站；微博无后台轮询） |

---

## 7. 风控体系

### 7.1 判定代码（`fetcher.py:26-46`）

```python
RATE_LIMIT_CODES = {-509, -412, -799, 412}

def _detect_rate_limit(status_code, data=None):
    # 1) HTTP 层：412（B站风控）、418/429（微博 m 站限流）
    if status_code in (412, 418, 429): ...置位
    # 2) 业务 code：-509 请求过于频繁 / -412 请求被拦截 / -799 / 412
    if code in RATE_LIMIT_CODES: ...置位
    # 3) 文案关键字（B 站 message / 微博 msg）
    elif "频繁" in msg or "请求过于" in msg: ...置位
```

**对应原因**：
- `-509`（请求过于频繁）：固定窗口限流，最常见——对应「某几分钟内请求数超阈值」；
- `-412` / HTTP 412（请求被拦截）：风控/机器人判定触发（UA、频率、行为特征可疑）；
- `-799`：访问过于频繁或 IP 环境不良（数据中心 IP 常见）；
- `HTTP 418/429`：微博 m 站限流（`m.weibo.cn` 对 extend 接口的节流）；
- 文案「频繁/请求过于」：微博 `.msg` 无 code 字段，只能按文案兜底
  （`{"ok":0,"msg":"请求频率过高"}` 之类）。

### 7.2 分层处理策略

| 层级 | 行为 |
|---|---|
| **列表页级**（视频页/动态页/微博页） | 风控 → 落盘已抓数据 → 同页冷却 600s 重试，**上限 2 次**（`_PAGE_RETRIES`）；耗尽 → `stop_reason="rate_limited"`，前端提示 + 断点续抓（后续从该断点继续） |
| **详情级**（每条帖子的 detail/view/article/extend） | 触发风控**不重试、不中断**：该帖跳过详情（保留 feed 数据）；**每条处理完立即 `clear_rate_limit()`**——详情风控标志只用于「列表页判定」（防止污染下一页列表请求的判定，方案 C） |
| **账号级**（账号信息循环） | 风控 → 冷却 600s → **从当前账号续跑**（重查账号列表防 detached 对象） |
| **任务级** | 每次任务开始 `clear_rate_limit()`（ContextVar 隔离，防跨任务污染，见 §3.4） |

### 7.3 为什么这样设计（实际踩坑）

- **详情风控必须即时清零**：`fetch_dynamic_detail` 的 -509 若被后续列表页判定读到，
  会把一个「单帖限流」放大成「整页放弃」；
- **列表页重试上限 2 次**：风控冷却 600s × 2 = 20 分钟仍连续失败说明 IP 环境异常，
  继续重试只会加剧风控，改为中断并如实上报 `video_missing`（方案 2 完整性比对）；
- **风控标志 ContextVar 隔离**：账号与帖子任务各自持有干净初值（历史 bug：模块级
  全局标志导致跨任务误读，见 §3.4 注释）。

---

## 8. 频率 / 节流总表

| 位置 | sleep | 折算速率 | 与 20/min 对比 |
|---|---|---|---|
| 账号间（信息流） | 3~5s | 24~40/min（突发） | ⚠️ 略超（批次休息摊平后 ~7/min ✅） |
| 视频翻页 | 1s | ~60/min | ⚠️ 超出 |
| 动态翻页 | 20s | ~3/min | ✅ |
| 微博翻页 | 20s | ~3/min | ✅ |
| 帖子详情（逐帖） | 0.5~2s | ~30~60/min | ⚠️ 超出（仅新帖发生时） |
| 微博长文 extend | 0.5~1.5s（enrich 后） | ~40/min | ⚠️ 超出（仅长文帖） |
| WBI 密钥 | 30min 缓存 | ~0 | ✅ |
| B 站会话检查 | 30min | ~0 | ✅ |
| 微博登录态 | 无后台轮询 | 0 | ✅ |

> 结论：**列表页翻页与账号信息是安全的；超出预算的是「逐帖详情补全」与
> 「视频翻页 1s」。** 目前靠 §7.2 的风控兜底（事后冷却）而非事前节流，
> 偶发风控属预期行为。

---

## 9. 配置与常量

| 名称 | 值 | 位置 |
|---|---|---|
| `REQUEST_INTERVAL_MIN/MAX` | 3.0 / 5.0 s | config.py |
| `FETCH_BATCH_SIZE` | 10 账号 | config.py |
| `FETCH_BATCH_COOLDOWN` | 60 s | config.py |
| `RATE_LIMIT_COOLDOWN` | 600 s | config.py |
| `TIER_TICK_SECONDS` | 10 s（分层调度心跳） | config.py |
| `LIVE_POLL_SECONDS` / `_JITTER` | 60 ± 15 s（T0） | config.py |
| `ACCOUNT_PRIMARY_INTERVAL_MINUTES` / `_JITTER` | 5 min ± 30 s（T1） | config.py |
| `DYNAMICS_LATEST_INTERVAL_MINUTES` / `_JITTER` | 15 min ± 120 s（T2） | config.py |
| `FULL_ACCOUNT_AFTER_T2` | True（T3a 随 T2） | config.py |
| `STARTUP_CHAIN_ENABLED` / `_DELAY` | True / 4 s | config.py |
| `STARTUP_DYNAMICS_LIMIT` | 2 条/账号（T2「最新 N 条」） | config.py |
| `PRIMARY_PLATFORM_ORDER` | `["bilibili", "weibo"]` | config.py |
| `EXTERNAL_ENABLED` / `EXTERNAL_RUN_HOUR` | True / 3AM | config.py |
| `MANUAL_PREEMPT_WAIT_SECONDS` | 120 s（手动等自动让位上限） | scheduler.py:635 |
| `_PAGE_RETRIES` | 2 | scheduler.py:843 |
| `_POST_BATCH_SIZE` | 50 条/commit | scheduler.py:787 |
| `RATE_LIMIT_CODES` | {-509, -412, -799, 412} | fetcher.py:23 |
| WBI `CACHE_TTL` | 1800 s | wbi.py:23 |
| B 站超时 | 15s（任务级 client） | scheduler.py |
| 详情间隔 | uniform(0.5, 2.0)s | scheduler.py |
| 视频页间 | 1s | scheduler.py |
| 动态/微博页间 | 20s | scheduler.py |

---

## 10. 已知优化方向（截至 2026-09-09）

1. **详情链节流**：0.5~2s → 2~3s（均匀随机），或按最近风控事件做拥塞窗口自适应
   （风控后速率减半、10 分钟无风控恢复）；
2. **视频翻页 1s → 3s**；
3. ~~账号抓取分层频率~~ **已实施（v0.6.1）**：T0 只拉直播状态、T1 主账号 5min、
   T2/T3a 15min——每轮请求量与实时性已按层分配；
4. **帖子详情合并**：无批量 API，1 帖 1 请求为完整性必要成本，不可再压缩；
5. 不改动建议：增量模式（stop_on_existing 第 1 页即停）已是当前最优；
   `x/web-interface/card` 合并接口拿不到直播状态且旧接口稳定性差，不采用。
