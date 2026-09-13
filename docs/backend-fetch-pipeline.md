# 后端抓取链路详解（v0.9.4）

> 覆盖范围：账号信息抓取 + 帖子抓取两条链路的触发入口、任务模型、API 清单、
> 节流/频率、风控判定与处理策略。代码位置：`app/services/scheduler.py`
> （调度与循环）、`app/services/fetcher.py`（B 站请求）、
> `app/services/platforms/{bilibili,weibo}.py`（平台适配）、
> `app/core/http.py`（共享 HTTP 客户端构造）、`app/routers/vtuber.py`（HTTP 入口）。
> 本文档记录 **2026-09-09 当前实现**，与代码同步维护。
> 总览/数据模型见 `docs/ARCHITECTURE.md`；表结构/仓储/接口见 `docs/backend-repositories-and-routers.md`；
> 名词与代码路径速查见 `docs/GLOSSARY.md`。

---

## 1. 总览：两条链路

```
触发源                                锁                循环框架
─────────────────────────────────────────────────────────────
综合档·账号流（数据到期 ≈24h）         _fetch_lock      async_fetch_and_update(auto=True)
/vtuber/fetch、/vtuber/{id}/fetch      _fetch_lock      async_fetch_and_update / async_fetch_vtuber
/vtuber/adopt、POST /{id}/accounts     _fetch_lock      async_fetch_accounts（后台，只抓新账号）
/vtuber/fetch-accounts（批量面板）      _fetch_lock      async_fetch_and_update（后台）
─────────────────────────────────────────────────────────────
综合档·动态流（预算自适应，约 30s 起一轮）   _post_fetch_lock  run_latest_dynamics_sweep（每主账号 1 页 + 限 2 帖）
收录首屏（adopt / 加账号）              _post_fetch_lock  async_fetch_first_screen（1 页投稿 + 1 页动态限 3）
/vtuber/fetch-posts（快速/全量）        _post_fetch_lock  _fetch_posts_core（B站双流）
/vtuber/fetch-all-posts                _post_fetch_lock  async_fetch_all_posts → 逐账号
/vtuber/update-posts                   _post_fetch_lock  async_update_unarchived_posts → 增量
/vtuber/batch/*                        _post_fetch_lock  （批量面板，同上框架）
```

- **账号信息抓取**：刷新账号资料（昵称/签名/头像）+ 粉丝数 + **直播状态**（B 站），
  成功后写一行统计快照（`account_stat_snapshots`，P0）。
- **帖子抓取**：按平台拉帖子列表（B 站 = 视频流 + 动态流；微博 = 单流），
  新帖逐个补详情，入库去重；模式：全量 / 快速 / 增量 / 最新 N 条 / 仅动态 / **收录首屏**。
- 两条链路**互斥运行**（各自独立锁）；**手动任务优先于自动档**（自动档轮次断点让位，见 §3.2）；
  综合档内**动态流与账号流并发**、每条流内**按平台并发**（v0.9.3）；
  **收录/加账号**时账号信息与首屏内容也**并发**（v0.9.4，见 §4.4）。

---

## 2. 触发入口清单

| 端点 | 说明 | 默认参数 |
|---|---|---|
| `POST /vtuber/{id}/fetch` | 手动抓取单个 VTuber 全部账号信息（账号抓取） | — |
| `POST /vtuber/fetch-accounts` | 批量面板：全部账号信息 | — |
| `POST /vtuber/adopt` | 候选池收录 → 后台并发「新账号信息 + 首屏内容」+ 第三方历史 | — |
| `POST /vtuber/{id}/accounts` | 添加平台账号 → 同上，只针对新账号（v0.9.4） | — |
| `POST /vtuber/fetch-posts?name=&full=` | 按名字抓帖子；`full=true` 后台全量（视频+动态拉到底） | 非 full：video 3 页 / dyn 5 页（前端快速抓取实际传 2/3） |
| `POST /vtuber/fetch-all-posts` | 全部账号全量抓帖子（同步等待） | -1/-1 |
| `POST /vtuber/update-posts?name=` | 更新未归档动态：先跑归档规则（30 天）再增量抓取，归档边界即停 | 不含视频；`stop_on_existing=true` |
| `POST /vtuber/batch/fetch-all-posts` | 批量面板：全部账号全量帖子 | -1/-1 |
| `POST /vtuber/batch/update-unarchived` | 批量面板：全部账号增量动态 | 同 update-posts |
| `POST /posts/archive?days=30` | 归档规则（幂等）：published_at 早于 N 天前 → archived | 30 |

定时档由 `_tier_loop` 驱动：启动链语义并入首轮，之后心跳
（`TIER_TICK_SECONDS=10s`）检查到期；APScheduler 仅保留 T4 外部数据 cron（每日/每周），
原 5min 的 `fetch_vtubers` IntervalTrigger 已由 T1/T3a 取代（见 §4.3）。

---

## 3. 任务模型：锁、让位、状态

### 3.1 全局单飞

- `_fetch_lock`（账号）与 `_post_fetch_lock`（帖子）：手动任务拿不到锁时先请求
  自动档让位（见 3.2），仍拿不到才返回 `skipped`；两把锁独立，综合档两条流因此可并发。
- `any_fetch_running()` = 账号在跑 ∨ 帖子在跑 ∨ 有手动任务在等让位（让位窗口也视为忙）
  ——外部数据批次（T4）据此排队等待。
- `manual_task_running()` = 是否有**手动**任务在跑（自动档持锁不算）——
  手动端点用它做 409 判定，这样用户手动请求不会被自动档挡在门外（v0.9.3）。

### 3.2 手动任务优先：自动档让位（v0.9.3，devlog/040）

用户手动任务（收录新 V 拉起的单V抓取、抓取账号/帖子/更新动态）优先级高于自动档：
手动侧拿不到锁且**占用者是自动档**时置位抢占信号（`_preempt_account` / `_preempt_post`）
并轮询等锁；自动档在**轮次断点**（每平台每账号之间）看到信号后提交会话 → 释放锁
→ 等信号清除 → 重新拿锁 → 从原序号续跑。

- `_acquire_manual_account()/ _acquire_manual_post()`：手动侧抢锁（最多等
  `MANUAL_PREEMPT_WAIT_SECONDS=120s`，超时按原语义跳过）；占用者是**另一个
  手动任务**时不抢（手动之间不互相打断）。
- **抢锁失败排队兜底（v0.9.4）**：收录 / 加账号拉起的抓取失败时不静默丢弃，
  而是入队（`_pending_account_ids` / `_pending_first_screen_ids`），由综合档心跳
  `_drain_pending_fetches()` 在锁空闲时优先消费（见 §4.4）。
- `_auto_yield_account_with(commit)` / `_auto_yield_post_with(commit)`：多平台会话版
  让位（先提交各平台会话再交锁）；单会话版 `_auto_yield_account/_post` 供旧路径/测试用。
- 自动档自身起跑时仍是"锁被占就跳过"（不打断手动任务）——两条方向合起来才是
  "手动 > 自动"。

### 3.3 进度状态 & 结果

- `_status["account"]`：`running/current/index/total/recent[≤100]` + `last_result{seq,...}`；
- `_status["post"]`：`running/target` + `last_result{kind, stored, skipped, issues, video_missing}`；
- `_status["external"]`（v0.9.4）：`running/label/last_label/seq` —— 外部第三方数据任务
  （收录回填、每日/周批次）的进度；`seq` 每次结束自增，前端据此发 `fetch-idle`，
  让档案视图的粉丝趋势/直播日历卡片自动重拉（否则停在该视图的用户看不到新数据）；
- 前端经 `GET /vtuber/fetch-status` 每 ~2s（空闲 10s）轮询；`recent` 增长驱动侧栏就地合并；
  外部任务运行期间状态胶囊显示「正在同步{label}」，完成后弹一条
  「{last_label}同步完成」并触发刷新。

### 3.4 风控状态隔离（ContextVar）

风控标志是**任务上下文**级而不是模块级（`fetcher.py:16-21`）：
账号抓取与帖子抓取可能先后运行于同一进程/不同线程，模块级全局变量会导致
**跨任务污染**（帖子任务的风控被账号任务误读、错误进入冷却）。因此
`_rate_limit_ctx: ContextVar` 默认 `(False, "")`，进入任务时 `clear_rate_limit()`。

---

## 4. 账号信息抓取

### 4.1 循环节奏（`async_fetch_and_update`）

```
账号流（按平台并发；每平台一条串行队列）:
  for 每个平台（并行）:
      for 该平台每个账号:
          fetch_user_info(1~N req) → 风控? 该平台冷却 600s（其它平台继续）
          → sleep(3~5s 随机)     # REQUEST_INTERVAL_MIN/MAX
          → 成功: 写快照 + commit + push实时快照
          每 10 个账号: sleep 60s   # FETCH_BATCH_SIZE / FETCH_BATCH_COOLDOWN（各平台各自计数）
  轮与轮之间：手动任务请求优先 → 交还锁让位，恢复后从原序号续跑
```

- 账号列表：`AccountRepo.all_for_fetch()`（有 platform_uid 的全部账号），按平台分组。
- 单账号请求量：B 站 = `acc/info`(WBI) + `relation/stat` 共 **2 req**（+头像下载 1 req，仅 URL 变化或文件缺失时）；
  微博 = `profile/info` **1 req**（+头像下载）。v0.9.4 起 B 站两个请求**并行**发出。
- 直播状态来自 `acc/info` 的 `live_room.liveStatus/title/roomid`（B 站专属）。

### 4.2 定时频率上限测算（以 16 账号为例）

| 项 | 值 |
|---|---|
| 一轮请求量 | 16 × 2 ≈ 32 req（B 站） |
| 一轮耗时 | 32 req × ~4s 间隔 + 1 次 60s 批次休息 + 网络 ≈ 2.5~4 min |
| 平均速率 | ≈ 32 req / 5 min ≈ **7 req/min** ✅（< 20/min） |
| 突发速率 | 2 req / 3~5 s ≈ 24~40 req/min ⚠️（仅该值瞬时，靠批次休息摊平） |

结论：账号链路的**平均速率安全**，突发略高于 20/min 但空间接口阈值较宽。

### 4.3 综合档调度（v0.9.3：原 T1/T2/T3a 合并，devlog/042）

按**时效敏感度**分层，v0.9.3 把三个账号/动态档合并为一个「综合档」：
动态流每档跑，账号流按**数据到期**跑，两者同档并发。

| 层 | 内容 | 形态 | 周期 | 冲突策略 |
|---|---|---|---|---|
| **T0 直播状态** | 批量接口仅回写 live 字段（跳变落统计快照） | **独立守护线程**（不占锁/不进状态通道/不写 last_result） | 60s ± 15s | 与一切任务并行（SQLite busy_timeout=30s 排队兜底） |
| **综合档·动态流** | 每 VTuber 主账号 1 页 + `limit_latest=2` | 调度线程（帖子锁） | **预算自适应**：12 req·min⁻¹/平台，轮间 `max(30s, 预算等待) ±15s`（v0.9.8，§4.3.1）；仅 `DYNAMICS_BUDGET_RPM<=0` 时退回 15min ± 2min | 起跑时手动任务在跑 → **跳过本轮**；持锁期间手动请求 → **轮次断点让位** |
| **综合档·账号流** | 全部账号全字段（原 T1 主账号 + T3a 全量合并） | 调度线程（账号锁） | **数据驱动**：任一账号 `last_fetched_at` 超 `ACCOUNT_SWEEP_STALE_HOURS=24h`（或为空）即到期，另受 `ACCOUNT_SWEEP_MIN_GAP_SECONDS=600s` 硬下限保护 | 同上 |
| **T3 手动全量/补档** | 用户触发（全量账号/全量帖子/单 V/未归档批量端点） | — | 手动 | 永远优先于综合档（拿不到锁时请求自动档让位）；仅被 T0 并行（互不打扰） |
| **T4 外部数据** | zeroroku/danmakus | APScheduler cron | 3AM 日/周 | 手动任务在跑 → **排队等待**（最多 30min）后执行；运行期间自动档跳过本轮 |
| **启动补抓** | 每 V **主账号**的第三方数据（粉丝历史/场次/礼物日） | **独立守护线程**（`startup-external`） | 启动一次，<24h 跳过（`app_meta.external.startup.last_run`） | 与综合档互斥（`_external_running`），但不占两把锁、不挡手动任务 |

调度细节：

- `start_live_poller()`：T0 线程；首轮于 `STARTUP_CHAIN_DELAY` 后立即执行
  （启动即最快刷新直播），之后循环轮询；`LIVE_POLL_SECONDS<=0` 关闭；
- `start_tier_scheduler()`：综合档线程；启动后跑一次综合档（动态流必跑，账号流按
  到期判定），之后心跳（`TIER_TICK_SECONDS=10s`）检查：手动抓取 / 外部批次在跑 →
  本轮跳过；动态流到期或账号流到期 → `asyncio.run(_run_combined_tier(...))`，
  两条流 `asyncio.gather` 并发；
- 并发粒度 = 平台（`_run_platform_rounds`）：每轮各就绪平台各抓一个账号，
  平台之间并行、平台内部串行；某平台风控只冷却该平台；
- 每档周期带抖（`_tier_delay`）；interval<=0 的档位禁用；
- 两条流都不写 `last_result` 的完成胶囊？——动态流不写（15 分钟弹一次会刷屏），
  账号流写（一天一次，作为「账号信息已更新」的汇总）；
- T0 的进度反馈 = `account-progress` 快照驱动的左右栏徽标（无进度条/无胶囊）；
- 冲突方向（v0.9.3 定稿）：**手动 > 自动**——自动档起跑时见手动任务即跳过，
  持锁期间见手动请求则轮次断点让位；原 APScheduler 的 5min `fetch_vtubers`
  job 已移除，仅保留外部数据 cron。

配置：`TIER_TICK_SECONDS`、`LIVE_POLL_SECONDS/JITTER`、`DYNAMICS_BUDGET_RPM`（动态流预算）、
`ACCOUNT_SWEEP_STALE_HOURS`（账号流数据到期阈值）、`ACCOUNT_SWEEP_MIN_GAP_SECONDS`（失败重试下限）
（+ 启动链/限帖配置沿用）。

### 4.3.1 动态流自适应节奏（v0.9.8，P9-5）

用户口径「一轮接一轮尽量高频，轮间穿插随机间隔，保证频率不超上限且拟人」：

- `_PlatformBudget`：**按平台的 60s 滑动窗口预算**（`DYNAMICS_BUDGET_RPM=12`），
  平台间独立（某平台用满不影响另一个）；
- 记账：**轮前**按估算记（每主账号 1 次 feed 页），**轮后**补差额（新帖详情 =
  `stored`）——按轮末整笔记账会白等一个轮次时长；
- 下一轮到期 = `time.monotonic() + max(DYNAMICS_MIN_GAP_SECONDS(30s), 预算等待)
  ± DYNAMICS_JITTER_SECONDS(15s)`；`DYNAMICS_BUDGET_RPM<=0` 时退回固定
  `DYNAMICS_LATEST_INTERVAL_MINUTES=15min`；
- 动态流返回 `requests: {platform: n}` 便于观测；风控冷却（按平台 600s）语义不变。

**实测**（8 个主账号）：一轮 8 请求 / 33s（下限由平台内 3~5s 节流决定），
相邻两轮 **80s** ≈ 6 req·min⁻¹ 均值（轮内瞬时 ~14）——比 v0.9.3 的 15 分钟快约 11 倍，
均值仍在 12 req·min⁻¹ 预算内。

### 4.3.2 启动外部补抓（v0.9.8，P9-4）

`start_external_catchup()`（独立守护线程）→ `run_startup_external_catchup()`：
每 V **主账号**的 zeroroku 粉丝历史/礼物日 + danmakus 场次；<24h 跳过
（时间戳存 `app_meta.external.startup.last_run`，迁移 f003）；进度走 `external`
状态胶囊；跑期间置 `_external_running`（综合档跳过本轮），不占锁、不挡手动任务。
zeroroku/danmakus 接口一次返回全量、无 limit 参数 —— 「只比对最新几条」由
**账号级新鲜度跳过 + 源幂等落库**实现（实测一次补抓仅新增 12 行快照 / 19 场）。

### 4.4 收录 / 加账号的快速链路（v0.9.4，devlog/044）

用户诉求：「添加一个新 V 的时候信息抓取能够尽可能地快」。收录与「给已有 V 添加账号」
共用一条链路，只针对**新增的那个账号**（不再重抓该 V 全部账号）：

```
POST /vtuber/adopt | POST /vtuber/{id}/accounts
  → 建库并 201 返回（不等待抓取）
  → BackgroundTasks: _adopt_background(vtuber_id, account_id)
        _spawn_background(_backfill_adopted_history(account_id))   第三方历史（无锁）
        asyncio.gather(
          async_fetch_accounts([account_id], fast=True)   账号锁   ← 账号信息
          async_fetch_first_screen(account_id)            帖子锁   ← 首屏内容
        )
```

三条支路**同时起跑**：第三方历史打的是第三方站点、不占两把锁，因此与账号信息 /
首屏内容并行不拖慢首屏，也不占 HTTP 后台槽位（否则响应后台链会挂几十秒）。
`_spawn_background` 保留任务强引用（`_background_tasks`）——`asyncio.create_task`
的返回值无人引用时任务可能被 GC 回收，会造成「回填静默不跑」。

| 项 | 旧实现 | v0.9.4 |
|---|---|---|
| 抓取范围 | 该 V **全部**账号 | 只抓新增账号 |
| 账号信息可见 | 5~12s（串行 2 请求 + 内联头像 + **末尾 3~5s 空转**） | **0.9~3s** |
| 首屏内容 | 不抓（等 15min 动态流或手点） | 投稿 1 页 + 动态 1 页限 3 条，**与账号信息并发** |
| 头像 | 阻塞在 commit 前 | 延后下载，只 UPDATE `avatar_path` 一列 + 二次推快照 |
| 第三方历史 | 顺序 BackgroundTask，占 HTTP 后台槽位 | 独立任务，与关键路径同时起跑、不占槽 |
| 抢锁失败 | 记一行「已跳过」（可能要等 24h） | 入队，综合档心跳 ≤10s 内补抓 |

要点：

- `async_fetch_accounts(ids, fast=True)`：节流只在**账号之间**（0.5~1s，`MANUAL_FAST_INTERVAL_*`），
  每个账号抓完立即 commit + `_push_account_snapshot`；`async_fetch_vtuber` 退化为
  「查该 V 账号 id → 调它」的薄壳（前端「抓取账号」按钮仍用它）。
- `_fetch_one_account(..., pending_avatar=[])`：头像 URL 只落 `avatar_url` 并把 URL 交给调用方，
  由 `_deferred_avatar(account_id, url)` 在快照推送后异步下载、只改 `avatar_path`、再推一次快照
  （前端 `account-progress` 内容 diff 就地替换头像）。账号已被删/下载失败仅记日志，
  `_avatar_missing` 下次抓取自动补。
- `async_fetch_first_screen(account_id)`：`FIRST_SCREEN_VIDEO_PAGES=1`、
  `FIRST_SCREEN_DYNAMICS_PAGES=1`、`limit_latest=FIRST_SCREEN_DYNAMICS_LIMIT=3`、
  `stop_on_existing=True`；完成汇总写 `post.last_result.kind="adopt"`
  （顶栏胶囊「新 V 首屏抓取完成 · 投稿 N · 动态 N · 入库 N」）。
- 抢锁失败排队：`_pending_account_ids` / `_pending_first_screen_ids` +
  `_drain_pending_fetches()`（`_tier_loop` 每 tick 调用；消费时若又有任务在跑则放回队列）。
- 第三方历史回填：`_backfill_adopted_history(account_id, label)` 与关键路径同时起跑，
  日志打「收录回填开始 account#N」→ 逐源「外部任务 … 完成」→「收录回填 account#N 完成」，
  收录链路在控制台里连成一条；单源超时/异常只跳过该源（带异常类型打印），不影响其它源。
- 回填进度进状态通道：`external_task_started(token, label)` /
  `external_task_finished(token)`（token 如 `adopt:22` / `daily` / `weekly`，
  并发时标签用「、」合并）；前端顶栏显示「正在同步{label}」，完成时按 `external.seq`
  变化发 `ddtoolkit:fetch-idle` → `PostsPage` 的 `refreshTick` 自增 →
  `LiveCalendar` / `FanTrendChart` / `ProfileView` 重拉数据。
- `main.py` lifespan 起 `_warm_wbi()`：预热 WBI 密钥（1 请求），首次收录不再多付一次 nav 往返。
- 通用提速：`app/core/http.py::new_async_client()` 复用进程级 SSLContext
  （httpx 每次构造客户端要 `load_verify_locations`，本机实测 ~0.98s → ~0.06s）。

实测（模拟时延、内存库，devlog/044 §三）：账号信息可见 **6.04s → 0.91s**，
首屏入库 **0 → 33 条**，墙钟 6.04s → 4.57s（其中 4.1s 是模拟的网络时延）。

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
    → stop_on_existing: **整页扫完**后，页内出现「已入库且非置顶」的帖子 → 立即停止
      （置顶帖 module_tag.text=置顶 不参与判定，见 §5.4）
    → 整页已归档 → archived_boundary 终止
逐帖详情补全（只有【未入库】的帖子才请求）:
    text/image   → web-dynamic/v1/detail (OPUS 全文/大图)      sleep 0.5~2s
    article      → x/article/view (专栏全文, 含 Quill Delta)    sleep 0.5~2s
    video_dynamic→ x/web-interface/view (简介/时长/分区/统计)   sleep 0.5~2s
    ↑ v0.9.6（P9-3）：video_dynamic 若其 bvid 已作为 video 入库 → **不插库**，
      动态附言写进该 video 的 `posts.note`（`_absorb_video_dynamic`）
批量入库：pending 攒 50 条 commit 一次（SQLite fsync 优化）
```

### 5.2 六种调用模式

| 模式 | 参数 | 特征 |
|---|---|---|
| 快速抓取（前端按钮） | `video_pages=2, dynamics_pages=3` | 小规模，同步等待（非 full 分支） |
| 全量（`full=true`） | `-1/-1` 拉到底 | `BackgroundTasks` 后台跑，进度见顶栏 |
| 更新未归档 | `include_videos=False, stop_on_existing=True` | 只抓动态第一页（通常），归档边界即停 |
| 最新 N 条（动态流） | `limit_latest=STARTUP_DYNAMICS_LIMIT(2)` | 同页最多入库 N 条新帖即停，单次时长有上界 |
| 收录首屏（v0.9.4） | `1/1, limit_latest=FIRST_SCREEN_DYNAMICS_LIMIT(3), stop_on_existing=True` | 新账号立刻有内容；微博等单流平台同样支持 `limit_latest` |
| 按名抓取 | `video_pages/dynamics_pages` 自定 | 对匹配名字的全部账号逐个调用 |

### 5.3 微博单流（`_fetch_platform_posts`）

```
mymblog?uid=&page=&feature=0         页间 sleep 20s
→ has_more = 有列表且 data.since_id 非空
→ pinned_ids = 列表里 isTop 非空的 id（置顶帖，可多条）
→ isLongText 的帖 → m.weibo.cn/statuses/extend（PC cookie 可用；手机 UA）
→ 同样支持 stop_on_existing / 归档边界 / 风控页重试 / limit_latest
```

### 5.4 置顶帖与增量停止（v0.9.4，devlog/045）

`stop_on_existing` 的不变量是「流按时间倒序 ⇒ 遇到已入库帖，更早的必然已入库」。
平台会在流首插**乱序条目**，该不变量只在置顶块之后成立：

| 平台 | 标记 | 实测 |
|---|---|---|
| 微博 | `isTop` 非空（**可多条**） | 七海 7198559139：idx0/idx1 均 isTop=1，新帖在 idx2 |
| B 站 | `modules.module_tag.text == "置顶"` | 泽音 1203217682：置顶 2025-08，其后是 2026-09 新帖 |

因此两条循环统一为：**置顶帖不参与停止判定** + **整页扫完再停**（记下页内第一条
「已入库且非置顶」的帖子作为 `stop_existing_pid`，循环结束后再收工）。
旧实现「从第 2 条起遇到已入库就 break」会把同页靠后的新帖整段漏掉
（用户 2026-09-09 反馈「更新动态后微博抓不到新帖」：277 条库里最新是置顶那条，
9/9 的三条新帖一条没进；修复后同参数跑出 stored=29）。

### 5.5 平台化帖子类型（v0.9.6，devlog/047）

后端各平台各自映射，`posts.type` 取值不再强行统一：

| 平台 | 类型 | 说明 |
|---|---|---|
| B 站 | `video` / `video_dynamic` / `image` / `text` / `repost` / `article` / `music` / `live` | 专栏、音乐为 B 站独占 |
| 微博 | `image` / `text` / `repost` / `video` / **`system`** | 无专栏/音乐；`system` = 平台自动发帖 |

- `system`（v0.9.6）：微博会员升级/签到/活动能量/会员购推广等由平台生成的帖，
  由 `weibo._is_system_mblog()` 按**保守句式**匹配（含 `isAd`），**优先于媒体分类**
  （自动帖带图也仍是自动帖）；真人发言里的「会员/签到」等词不误判（有测试锁）。
  不删除、默认列表仍可见，只是单独成组便于过滤。
- 前端 `TYPE_GROUPS` 拆成 B 站/微博两套（`typeGroupsFor(platform)`），
  微博为：图文 / 视频 / 转发 / 系统；B 站为：投稿 / 图文 / 转发 / 专栏 / 音乐 / 直播。
- 实测分布（本地库）：B 站 `image 2453 / video 423 / repost 385 / video_dynamic 369 /
  text 352 / music 2 / article 2`；微博 `text 318 / image 227 / repost 18 / video 1`。

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
| `MANUAL_FAST_INTERVAL_MIN/MAX` | 0.5 / 1.0 s（收录/单V 的账号间隔） | config.py |
| `FIRST_SCREEN_VIDEO_PAGES` / `_DYNAMICS_PAGES` / `_DYNAMICS_LIMIT` | 1 / 1 / 3（收录首屏） | config.py |
| `FETCH_BATCH_SIZE` | 10 账号 | config.py |
| `FETCH_BATCH_COOLDOWN` | 60 s | config.py |
| `RATE_LIMIT_COOLDOWN` | 600 s | config.py |
| `TIER_TICK_SECONDS` | 10 s（综合档心跳） | config.py |
| `LIVE_POLL_SECONDS` / `_JITTER` | 60 ± 15 s（T0） | config.py |
| `DYNAMICS_LATEST_INTERVAL_MINUTES` / `_JITTER` | 15 min ± 120 s（动态流；仅预算关闭时生效） | config.py |
| `DYNAMICS_BUDGET_RPM` | 12 req·min⁻¹（**动态流按平台预算**，v0.9.8；≤0=退回固定周期） | config.py |
| `DYNAMICS_MIN_GAP_SECONDS` / `_JITTER_SECONDS` | 30 s / 15 s（自适应轮间间隔下限与抖动） | config.py |
| `EXTERNAL_STARTUP_CATCHUP_ENABLED` / `_STALE_HOURS` | True / 24 h（启动时外部补抓，v0.9.8） | config.py |
| `ACCOUNT_SWEEP_STALE_HOURS` | 24 h（账号流数据到期阈值） | config.py |
| `ACCOUNT_SWEEP_MIN_GAP_SECONDS` | 600 s（账号流失败重试下限） | config.py |
| `STARTUP_CHAIN_ENABLED` / `_DELAY` | True / 4 s | config.py |
| `STARTUP_DYNAMICS_LIMIT` | 2 条/账号（动态流「最新 N 条」） | config.py |
| `PRIMARY_PLATFORM_ORDER` | `["bilibili", "weibo"]` | config.py |
| `EXTERNAL_ENABLED` / `EXTERNAL_RUN_HOUR` | True / 3AM | config.py |
| `MANUAL_PREEMPT_WAIT_SECONDS` | 120 s（手动等自动让位上限） | scheduler.py |
| `_EXTERNAL_WAIT_SECONDS` | 1800 s（外部批次等手动任务上限） | scheduler.py |
| `_PAGE_RETRIES` | 2 | scheduler.py |
| `_POST_BATCH_SIZE` | 50 条/commit | scheduler.py |
| `RATE_LIMIT_CODES` | {-509, -412, -799, 412} | fetcher.py:23 |
| WBI `CACHE_TTL` | 1800 s | wbi.py:23 |
| B 站超时 | 15s（任务级 client） | scheduler.py |
| 详情间隔 | uniform(0.5, 2.0)s | scheduler.py |
| 视频页间 | 1s | scheduler.py |
| 动态/微博页间 | 20s | scheduler.py |
| SSL 上下文缓存 | 进程级单例（客户端构造 0.98s → 0.06s） | core/http.py |

---

## 10. 已知优化方向（截至 2026-09-09）

1. **详情链节流**：0.5~2s → 2~3s（均匀随机），或按最近风控事件做拥塞窗口自适应
   （风控后速率减半、10 分钟无风控恢复）；
2. **视频翻页 1s → 3s**；
3. ~~账号抓取分层频率~~ **已实施并再收敛（v0.6.1 → v0.9.3）**：T0 只拉直播状态（60s）、
   综合档动态流 15min、账号流数据驱动约 24h——账号字段变化慢，不再每 5/15 分钟刷；
4. **帖子详情合并**：无批量 API，1 帖 1 请求为完整性必要成本，不可再压缩；
5. ~~收录链路提速~~ **已实施（v0.9.4，devlog/044）**：账号信息 ∥ 首屏内容、去掉末尾空转、
   头像延后、WBI 预热、共享 SSLContext、抢锁失败排队；
6. 待观察：`fetch_bilibili_user_info` 的 `@retry(3 次, 2~10s 退避)` 在**风控**时也会重试
   （多付 ~6s 才进冷却）；可考虑「风控结果不重试」以缩短失败路径；
7. 不改动建议：增量模式（stop_on_existing 第 1 页即停）已是当前最优；
   `x/web-interface/card` 合并接口拿不到直播状态且旧接口稳定性差，不采用。
