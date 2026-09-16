# 后端架构总览：数据模型 + 抓取技术架构

> 适用版本：`main`（2026-09-13，`MIGRATION_HEAD = f004`）。
> 本文是**入口文档**：先看这里建立全貌，再按需进两份深度文档——
> - `docs/GLOSSARY.md`：**查名词/代码路径**（改 bug 或做需求第一步）；
> - `docs/backend-repositories-and-routers.md`：11 张表的列级定义、11 个仓储类、HTTP 路由计数（三种数法见该文 §3）；
> - `docs/backend-fetch-pipeline.md`：抓取链路细节（API 清单、节流测算、风控判定、停止原因）。
> 前端形态见 `docs/UI-MAP.md`；本地开发/验证见 `docs/DEV-LOOP.md`；全部文档索引见 `docs/README.md`。

---

## 0. 一句话定位

**本地优先的个人 VTuber 证据归档系统**：Tauri 桌面壳拉起一个 FastAPI sidecar，
把 B 站 / 微博的账号资料、动态投稿、直播场次与第三方历史**固定化**到单机 SQLite；
前端只读渲染，所有抓取由后端的**分层调度 + 手动任务优先**驱动，第三方站点只在
每日/每周低频拉取。

---

## 1. 运行时形态（进程 / 线程 / 协程）

```mermaid
flowchart TB
  subgraph Shell["Tauri v2 桌面壳（Rust）"]
    W[窗口/托盘] --> L[启动器：挑空闲端口]
  end
  L -->|"DDTOOLKIT_PORT / DATA_DIR / PARENT_PID"| S

  subgraph S["Python sidecar（backend_main.py）"]
    BM["资源引导 vtubers.csv<br/>父进程看门狗<br/>uvicorn Server API（bind 后就绪）"]
    BM --> APP["FastAPI app（app/main.py）<br/>lifespan：迁移 → 调度器 → auth 维护"]
    APP --> HTTP["HTTP API 事件循环<br/>vtuber / auth / img-proxy / 手动抓取 / BackgroundTasks"]
    APP --> T0["T0 线程：直播轮询 60s<br/>批量接口，不占锁"]
    APP --> TIER["综合档调度线程：动态流 + 账号流<br/>asyncio.run 同档并发"]
    APP --> APS["APScheduler 线程：T4 外部数据<br/>每日 3AM / 每周"]
    APP --> AUTH["auth 维护协程<br/>B 站 cookie 续期"]
  end

  S --> DB[("SQLite vtuber.db（WAL）<br/>11 张表 / alembic a001→f004")]
  S --> FS["DATA_DIR/static：头像 / 自定义背景 / 图片代理缓存"]
  HTTP --> UI["前端 Vite + React（只读渲染 + 轮询 fetch-status）"]
```

| 并发单元 | 载体 | 职责 | 是否占抓取锁 |
|---|---|---|---|
| HTTP API | FastAPI 事件循环 | 路由、手动抓取（同步端点在线程池） | 手动抢锁（可抢占自动档） |
| BackgroundTasks | 事件循环（响应之后） | 收录 / 加账号后的抓取 + 第三方回填 | 同上 |
| T0 直播状态 | 独立守护线程 | 每 60s ±15s 批量回写 `live_*` 字段 | **不占锁**（与一切任务并行） |
| 综合档 | 调度线程 | 动态流（预算自适应，见 §3.1）+ 账号流（数据到期，约 24h）**同档并发** | 两把锁 |
| T4 外部数据 | APScheduler 线程 | zeroroku / danmakus cron | 手动任务在跑则**排队等待**（v0.9.3，不再跳过） |
| auth 维护 | 事件循环协程 | B 站 cookie 心跳/续期、微博登录态探测 | — |

**冷启动优化**：`app/routers/vtuber.py` 不直接 import `scheduler`（依赖链重：apscheduler /
tenacity / httpx / fetcher），经 `_sched()` 缓存包装首次调用才导入；`main.py` 的 lifespan
也把调度器 import 放在函数内——让 uvicorn 尽快 bind 端口。

**数据目录**：一切可变数据都在 `DDTOOLKIT_DATA_DIR`（桌面端 = `%APPDATA%\com.ddtoolkit.app`，
开发态 = `…-dev`）：`vtuber.db`（+ WAL/SHM）、`.env`（凭据）、`vtubers.csv`（候选池）、
`logs/{app,sidecar}.log`、`static/{avatars,custom_bg,img-cache}`。

---

## 2. 数据模型（11 张表 · 迁移链 a001 → f004）

### 2.1 ER 总览

```mermaid
erDiagram
  VTUBERS ||--o{ ACCOUNTS : "1:N 级联删除"
  ACCOUNTS ||--o{ ACCOUNT_STAT_SNAPSHOTS : "1:N 不级联"
  ACCOUNTS ||--o{ LIVE_SESSIONS : "1:N 不级联"
  ACCOUNTS ||--o{ LIVE_GIFT_DAYS : "1:N 不级联"
  ACCOUNTS ||--o{ LIVE_CATEGORY_OVERRIDES : "1:N 不级联"
  VTUBERS ||--o{ VTUBER_EVENTS : "1:N 不级联"
  ACCOUNTS ||..o{ POSTS : "逻辑关联（无外键）"
  THIRDPARTY_VTUBERS }o..|| ACCOUNTS : "候选索引（无外键）"

  VTUBERS {
    int id PK
    string name
    string faction
    string birthday
    string debut_date
    string background_path
  }
  ACCOUNTS {
    int id PK
    int vtuber_id FK
    string platform
    string platform_uid
    int followers_count
    int live_status
    datetime last_fetched_at
    datetime posts_last_scan_at
  }
  POSTS {
    int id PK
    string platform
    string platform_uid
    string platform_post_id
    string type
    datetime published_at
    bool is_archived
    datetime last_seen_at
    datetime deleted_detected_at
  }
  ACCOUNT_STAT_SNAPSHOTS {
    int id PK
    int account_id FK
    int followers_count
    int live_status
    datetime captured_at
    string source
  }
  LIVE_SESSIONS {
    int id PK
    int account_id FK
    string live_id
    string source
    datetime start_at
    datetime end_at
  }
  LIVE_GIFT_DAYS {
    int id PK
    int account_id FK
    string source
    string gift_date
  }
  LIVE_CATEGORY_OVERRIDES {
    int id PK
    int account_id FK
    string live_id
    string category
  }
  VTUBER_EVENTS {
    int id PK
    int vtuber_id FK
    string title
    string event_date
  }
  THIRDPARTY_VTUBERS {
    int id PK
    string platform_uid
    string name
    string group_name
    string source
  }
  APP_META {
    string key PK
    text value
    datetime updated_at
  }
  VTUBER_FIELD_HISTORY {
    int id PK
    int vtuber_id FK
    int account_id FK
    string field
    string value
    datetime changed_at
  }
```

### 2.2 表职责

| 表 | 定位 | 关键约束 / 索引 | 写入方 |
|---|---|---|---|
| `vtubers` | 主播本体（平台无关）：名字/阵营/生日/出道日/设定/默认头像/自定义背景 + 签名**来源/覆盖**（`sign_override` / `sign_source_account_id`） | `ix_vtubers_name` | 手动 CRUD、候选池收录 |
| `accounts` | 各平台账号：昵称/头像/签名/粉丝数/直播字段/`last_fetched_at`/`posts_last_scan_at` | **UNIQUE(platform, platform_uid)**；`ix_accounts_vtuber_id` | 收录/加账号、T0/综合档抓取回写 |
| `posts` | 动态 / 投稿 / 专栏 / 转发 / 音乐 / 直播卡片（直播卡片转存后不入表） | **UNIQUE(platform, platform_uid, platform_post_id)**；复合索引 `(platform, platform_uid, published_at)`、`ix_posts_published_at`、`ix_posts_deleted_detected` | 帖子抓取（批量攒批 commit） |
| `account_stat_snapshots` | 粉丝数 / 直播状态时间序列（涨粉趋势、直播日历的地基） | `ix_..._account_id`、`ix_..._captured_at`；`source` 区分自采/第三方 | 每次账号抓取成功后追加一行 |
| `live_sessions` | 直播场次（标题/起止/分区/封面/收益/弹幕数） | **UNIQUE(account_id, live_id)**；`ix_live_sessions_account_start` | danmakus 回填、B 站 `feed` 直播卡片、读取时并入 self 快照 |
| `live_gift_days` | 礼物 / 大航海 / SC 日聚合（金额保字符串精度） | **UNIQUE(account_id, source, gift_date)** | zeroroku |
| `live_category_overrides` | 用户对场次分类的手工校正（9 类引擎最高优先级信号） | **UNIQUE(account_id, live_id)** | 前端分类下拉 |
| `vtuber_events` | 手动维护的纪念日 / 活动（一次性日期） | `ix_vtuber_events_vtuber_date` | 前端增删 |
| `thirdparty_vtubers` | 第三方 VTuber 索引（企划 / 公会），供候选池搜索增强 | **UNIQUE(source, platform_uid)** | danmakus vup-list（周级整表刷新） |
| `app_meta` | 通用 KV（进程外需要记住的少量状态，如 `external.startup.last_run`） | `key` 主键 | 启动外部补抓时间戳（f003） |
| `vtuber_field_history` | **曾用值**：昵称/签名被**平台侧覆盖前**的旧值（f004 起取代字段锁定；手改不入账） | `ix_vtuber_field_history_vtuber`（`vtuber_id`, `field`） | 只由抓取回写记账（`scheduler._fetch_one_account` → `services/vtuber_history.py`） |

### 2.3 迁移链与启动迁移

| 版本 | 内容 | 版本 | 内容 |
|---|---|---|---|
| `a001` | 建 `vtubers` + `accounts` | `e001` | `account_stat_snapshots` |
| `b001` | 建 `posts` | `e002` | 墓碑：`posts.last_seen_at / deleted_detected_at` + `accounts.posts_last_scan_at` |
| `c001` | `posts.is_archived` | `e003` | `posts.body_text`（全文搜索） |
| `c002` | 唯一约束改为 (platform, uid, pid) | `e004` | 外部源：`thirdparty_vtubers` / `live_gift_days` + 快照 `source` |
| `d001` | `vtubers.faction` + 3 个热路径索引 | `e005` | `vtuber_events` |
| `d002` | `vtubers.background_path` | `e006` | `live_sessions` |
| `f001` | `posts.note`（投稿动态并入后的 UP 主附言） | `e007` | `live_category_overrides` |
| `f002` | `accounts.sort_order` + `accounts.locked_fields`（后者 f004 已删） | `f003` | `app_meta`（KV 表） |
| `f004` | `vtubers.sign_override / sign_source_account_id` + `vtuber_field_history`，**删除 `accounts.locked_fields`** = 当前 head（devlog/074） | | |

> 共 **17** 个版本（`alembic/versions/` 实际文件数：`a001`–`f004`）。f001–f003 由 v0.9.6–v0.9.8 批次引入，f004 见 devlog/074。

启动迁移四形态（`app/main.py::_run_migrations`，冷启动快路径）：

1. **全新库**（无任何表）→ `alembic upgrade head`；
2. **旧库**（有表无 `alembic_version`）→ 补列补索引后 `stamp head`（⚠️ 补不了唯一约束，
   故 `stamp` 前先过 `app/main.py::_missing_unique_keys`，不一致**拒绝启动**，见 devlog/053）；
3. **落后版本** → `upgrade head` 增量升级；
4. **版本 == `MIGRATION_HEAD`** → 直接返回，零 alembic 开销。

> 纪律：新增迁移必须同步 `app/main.py` 的 `MIGRATION_HEAD`（`tests/test_services.py`
> 断言它与 alembic head 一致），否则快路径会把旧库误判为已最新。

### 2.4 存储约定

- **时区**：库内 datetime 一律 **naive UTC**；路由层比较参数同为 naive；输出模型补 `+00:00`。
- **SQLite PRAGMA**（`app/core/database.py`，每个连接）：`journal_mode=WAL`、
  `busy_timeout=30000`、`synchronous=NORMAL`、**`foreign_keys=ON`**。
- **外键语义**：只有 `vtubers→accounts` 有 ORM 级联；其余 7 条外键（快照/场次/礼物日/
  分类校正/曾用值 → `accounts`，活动条目 + 曾用值 → `vtubers`）**不级联**——删除必须显式清理，
  见 `app/services/purge.py`（§6）。
- **posts 无外键**：与账号靠 `(platform, platform_uid)` 逻辑关联（联合投稿会在每个 V
  下各存一份），删除时按平台+UID 显式清。

---

## 3. 抓取技术架构

### 3.1 时效分层（谁在什么时候抓）

v0.9.3 把原 T1（主账号 5min）+ T2（最新动态 15min）+ T3a（全量账号随 T2）**合并为一个综合档**：
动态流每档跑，账号流按数据到期跑，两者同档并发。

| 层 | 内容 | 载体 | 周期 | 冲突策略 |
|---|---|---|---|---|
| **T0** 直播状态 | 批量接口只回写 `live_*`（跳变落快照） | 独立线程 | 60s ±15s | 与一切并行（不占锁） |
| **综合档·动态流** | **按平台名单**：全部账号各 1 页 + 每账号限 `STARTUP_DYNAMICS_LIMIT=2` 条新帖；名单间并行、名单内串行（R7，devlog/078） | 调度线程（帖子锁） | **预算自适应**：12 req·min⁻¹/平台，轮间 `max(30s, 预算等待) ±15s`，**再套周期下限 60s（按轮开始计时）** | 起跑见手动任务→跳过；持锁见手动请求→**轮次断点让位** |
| **综合档·账号流** | 全部账号全字段（含主账号；原 T1+T3a 合并） | 调度线程（账号锁） | **数据驱动**：任一账号 `last_fetched_at` 超 `ACCOUNT_SWEEP_STALE_HOURS=24h`（或为空）即到期 | 同上 |
| **T3** 手动全量/补档 | 用户触发（全量账号 / 全量帖子 / 单 V / 更新动态 / 收录 / 加账号） | HTTP + BackgroundTasks | — | **永远优先于综合档**；收录/加账号抢锁失败会入队补抓（v0.9.4） |
| **T4** 外部数据 | zeroroku / danmakus 第三方固定化数据 | APScheduler cron | 3AM 日 / 周 | 手动任务在跑则**排队等待**（最多 30min），不再直接跳过 |

- 启动链（`STARTUP_CHAIN_ENABLED`，`STARTUP_CHAIN_DELAY=4s`）：动态流必跑一次；
  **账号流按同一套数据到期判定**决定要不要跑（用户 2026-09-09 定稿：账号字段变化慢）；
- 两条流在同一事件循环里 `asyncio.gather` 并发起跑，墙钟 ≈ max(两条流) 而不是相加；
- **并发粒度 = 平台**（`_run_platform_rounds`）：每轮各就绪平台各抓一个账号，
  平台之间并行、平台内部串行 —— 单平台请求速率不变，某平台风控只冷却该平台。

### 3.2 任务模型：两把锁 + 手动优先

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> AutoRunning: 自动档非阻塞拿到锁
  Idle --> ManualRunning: 手动任务拿到锁
  AutoRunning --> ManualRunning: 手动请求抢占，自动档轮次断点交还锁
  ManualRunning --> AutoRunning: 手动跑完释放锁，自动档从原序号续跑
  AutoRunning --> Idle: 本轮结束
  ManualRunning --> Idle: 任务结束
```

（自动档**起跑**时若锁被手动任务占着 → 直接跳过本轮，不打断手动任务。）

- 两把独立锁：`_fetch_lock`（账号信息）与 `_post_fetch_lock`（帖子），互不牵连；
  **综合档两条流各持一把**，因此可以同档并发；
- **自动让手动**：手动侧 `_acquire_manual_*()` 拿不到锁且占用者是自动档时，置位
  `_preempt_account/_preempt_post` 并轮询等锁（上限 120s）；自动档在**轮次断点**
  （每平台每账号之间）交还锁、等信号清除、重新拿锁、**从原序号续跑**；
- **手动之间不互相打断**：占用者是另一个手动任务时直接返回 `skipped`；
  **例外（v0.9.4）**：收录 / 加账号拉起的抓取失败时**入队**（`_pending_*`），
  由综合档心跳 `_drain_pending_fetches()` 在锁空闲时补抓 —— 新 V 的信息不会丢；
- 端点 409 判定用 `manual_task_running()`（自动档持锁不算忙），外部批次用
  `any_fetch_running()`（任一在跑或有人在等让位都算忙）；
- 状态通道 `GET /vtuber/fetch-status` 暴露 `account.{running,current,index,total,recent}`、
  `post.{running,target}`、`external.{running,label,last_label,seq}` 与 `last_result`
  （完成胶囊）；前端 ~2s 轮询；并发时 `current/target` 显示当轮就绪的平台名
  （如「bilibili、weibo」）。`external` 是外部第三方数据任务（收录回填 / 每日批次）
  的进度，其 `seq` 每次结束自增 —— 前端据此发 `fetch-idle`，让停在档案视图的
  粉丝趋势/直播日历卡片自动重拉（v0.9.4）。

### 3.2.1 收录 / 加账号链路（v0.9.4，devlog/044）

```mermaid
flowchart LR
  A["POST /vtuber/adopt<br/>POST /vtuber/{id}/accounts"] -->|201 立即返回| B["_adopt_background"]
  B --> C["async_fetch_accounts([新账号], fast=True)<br/>账号锁 · 头像延后 · 无末尾空转"]
  B --> D["async_fetch_first_screen(新账号)<br/>帖子锁 · 投稿1页+动态1页限3"]
  B -.->|create_task| E["_backfill_adopted_history<br/>第三方历史（无锁、不占槽）"]
  C --> F[("accounts / snapshots")]
  D --> G[("posts")]
```

- 账号信息与首屏内容**并发**（两把锁独立，墙钟 ≈ max）；第三方历史脱离关键路径；
- 实测（模拟时延）账号信息可见 **6.0s → 0.9s**，首屏入库 **0 → 33 条**（devlog/044）。

### 3.3 平台适配层（直采）

```mermaid
flowchart LR
  S["scheduler 循环"] --> R["platforms.registry.get_fetcher(platform)"]
  R --> B["bilibili.fetcher"]
  R --> W["weibo.fetcher"]
  B -->|fetch_user_info| FI["账号资料 + 直播字段"]
  B -->|fetch_post_page| FP["一页帖子流（统一 item 结构）"]
  B -->|enrich| E["详情补全（长文/视频）"]
  W --> FI
  W --> FP
  FI --> DB[("accounts / snapshots")]
  FP --> DB2[("posts")]
```

- `BasePlatform` 只定义三个方法：`fetch_user_info` / `fetch_post_page` / `enrich`（可选）；
- 新平台 = 继承 + 在 `platforms/registry.py` 注册一行，调度器自动获得账号抓取、
  全量/增量帖子抓取、风控退避与完成报告（详见 `docs/platforms-extension-guide.md`）；
- B 站请求走 `fetcher.py`：WBI 签名（`wbi.py`，混钥缓存）+ `auth_manager.build_headers()`
  注入 Cookie/UA；微博走 PC ajax 端点 + 扫码登录保存的 Cookie。

### 3.4 帖子抓取：模式与停止原因

| 模式 | 参数 | 用途 |
|---|---|---|
| 全量 | `video_pages=-1, dynamics_pages=-1` | 首次收录补档、手动全量 |
| 快速 | `2/3` 页（前端）/ `3/5`（默认） | 手动「抓取帖子」 |
| 增量 | `stop_on_existing=True` | 更新未归档动态：**整页扫完**才停（边界取页内首条「已入库且非置顶」帖）；置顶帖豁免——微博 `isTop` 可多条、B 站 `module_tag.text=置顶`，且会打乱流序，旧「遇已入库即 break」会漏掉同页靠后的新帖（devlog/045） |
| 最新 N 条 | `limit_latest=2` | 综合档动态流每轮消化 2 条新帖，单次时长有上界 |
| 仅动态 | `include_videos=False` | 更新未归档动态（不碰视频流） |

- **归档边界剪枝**：整页帖子都已归档（`is_archived=1`）→ 更早的页必然也已归档，
  立即停止翻页，不再产生任何网络请求；
- **内存去重**：抓取前一次性查库取 `existing_ids` / `archived_ids`，避免唯一约束回滚；
- **批量入库**：攒满 `_POST_BATCH_SIZE` 才 commit；
- **停止原因归类**（前端据此区分「预期停止」与「丢数据」）：`done / page_limit /
  rate_limited / network_error / archived_boundary / stopped_early / error`；
- B 站视频流额外比对 `arc/search.page.count`（参考总数）估算缺失量。

### 3.5 风控与节流

| 机制 | 实现 |
|---|---|
| 风控判定 | `RATE_LIMIT_CODES = {-509, -412, -799, 412}`（HTTP 码或业务码） |
| 状态隔离 | 风控标志放 `ContextVar`（`fetcher.py`），每个并发流/轮次互不污染 |
| 冷却（按平台） | 触发后 `RATE_LIMIT_COOLDOWN=600s`，**只冷却出问题的平台**，其它平台继续推进 |
| 请求间隔 | `REQUEST_INTERVAL_MIN/MAX = 3~5s` 随机；每 10 个账号休息 60s（各平台各自计数） |
| 页间间隔 | 视频页 1s、动态页 20s、账号间 20s（全量帖子） |
| 频率测算 | 16 账号一轮 ≈ 32 req / 5min ≈ 7 req/min（平均安全，突发靠批次休息摊平） |
| 并发影响 | 综合档两条流并发时，重叠窗口内同平台瞬时速率约 2×（仍低于经验阈值）；平台内并发不放大单平台速率 |
| 风控续抓 | 列表页触发风控后同页重试上限 `_PAGE_RETRIES=2` |
| **匿名调用被硬拒** | 未登录调空间内容接口（`arc/search`、动态 `feed/space`）→ `-352` 后转 **HTTP 412 `request was banned`**（IP 级、会持续）；**不连累登录态**。见 §3.9 |
| **实测请求量级**（2026-09-16） | **T0 直播 = 1 请求/分钟**（`get_status_info_by_uids` 批量 ≤100 uid/请求）≈ 1440/天；**动态流才是主力**：实测一轮 8 请求 / 周期 60–70s ≈ **1.1 万/天**（7 V / 10 账号口径） |
| **抖动** | 处处随机，不是固定节拍：T0 `60±15s`、动态轮间 `±15s`、名单内 `2–5s`、手动 `3–5s`、启动链各自随机 |
| ⚠️ **两个已知缺口** | ① 冷却窗口**只在内存**（`scheduler._rate_limit_until` 是模块级变量、不落库）⇒ **重启（含应用内更新后的自动重启）即遗忘并立刻恢复满速**；② `_PlatformBudget._rpm_for()` 会把平台预算抬到"至少装得下一轮" ⇒ **稳态速率随账号数线性上抬且无衰减**（30 个 B 站账号 ≈ 30 req/min ≈ 4.3 万/天）。收口方案见 `docs/TODO.md` §0 的 **R27/R28** |

> **请求头与设备指纹现状**（2026-09-16 盘点，为回答"头信息硬编码会不会更容易被风控"）：
> UA / `Referer` / `Origin` / `Accept-Language` 全是硬编码常量（`auth.py::BASE_HEADERS`、
> `platforms/weibo.py`、`danmakus.py::BROWSER_HEADERS`、`bili_search.py`、`img_proxy._UA`）。
> **共用 UA 本身不是风险**（同版本浏览器本就同 UA，平台按 Cookie/账号 + IP + 设备号归因），
> 但有三处真实的"工具签名"：① 完全没有 `sec-ch-ua` / `Sec-Fetch-*`，且多发一个浏览器不会显式发的
> `Connection: keep-alive`、未开 HTTP/2；② **设备号 cookie 名写错** —— 代码发 `bvuid3=`，
> 而 B 站 web API 读的是 `buvid3`（匿名实测 `x/frontend/finger/spi` 下发 `b_3`(46 字符)/`b_4`，
> 与本机 `.env` 里 `BILI_BUVID_3` 的值同形）⇒ 疑似等于没带设备指纹；③ UA 永久冻结在 Edge 150。
> 收口方案见 `docs/TODO.md` §0 的 **R26**（⚠️ 设备号**必须按安装生成**，写死一份 = 全网共享设备身份）。

### 3.6 删除检测（墓碑机制，v0.5.1）

```mermaid
flowchart LR
  A["每账号帖子扫描结束"] --> B{"窗口可信？<br/>natural_end 或<br/>stop_existing_pid"}
  B -- 否 --> Z["只推进 last_seen / scan 标记"]
  B -- 是 --> C["窗口下界 = 停止帖发布时间<br/>或本轮最旧所见帖"]
  C --> D{"缺席帖 last_seen_at<br/>< 上一轮扫描完成时间？"}
  D -- 是 --> E["两击命中 → deleted_detected_at = 本轮时间"]
  D -- 否 --> F["保持现状，等下一轮"]
```

- 「已验证窗口」是防误判关键：增量模式停在某帖时，更早的帖子本轮**根本没扫**，
  不参与判定；
- 已归档帖不参与；已墓碑不重复判定、不逆转（复活只刷新 `last_seen_at`）；
- 判定失败只记日志，不影响抓取结果。

### 3.7 直播场次管道（三源合一）

```mermaid
flowchart LR
  D["danmakus（第三方，日）"] --> LS[("live_sessions<br/>source=danmakus")]
  F["B 站动态 feed 直播卡片"] --> LS2[("live_sessions<br/>source=feed")]
  T0["T0 直播状态快照<br/>（live_status 跳变）"] --> M
  LS --> M["LiveSessionRepo.merged()<br/>读取时合并 + 同场去重 + 中断续播并段"]
  LS2 --> M
  M --> API["GET /account/{id}/live-sessions"]
  M --> CAL["前端直播日历"]
  O["用户分类校正"] --> LT["live_type 9 类推断<br/>override(4.0) > 系列(≥2) > learned(2.0) > 标题/分区"]
  M --> LT
```

- 表内场次（danmakus / feed）+ self 快照推导的「虚拟场次」在**读取时**合并，
  不落表；合并窗口 90 分钟，同 `room_id` 去重，同标题中断续播并段；
- `end_at` 由快照/次日 danmakus 补全；收益/弹幕数来自 danmakus。

### 3.8 状态通道

`_status`（模块级 dict）+ `_push_account_snapshot()` 队列 → `GET /vtuber/fetch-status`
→ 前端 TopBar 轮询（~2s）→ 左栏徽标 / 右栏卡片实时合并（`recent` 增量快照）。
T0 的进度反馈就是这条通道（无进度条、无胶囊）。

---

### 3.9 未登录能力矩阵与内容抓取闸门（2026-09-15，devlog/086）

用户要"未登录也能尽可能用所有功能，并明确告知限制"。事实边界由**实测**给出
（`scripts/capability_matrix.py`，两态逐接口、一进程一请求）：

| 能力 | 未登录 | 依据 |
|---|---|---|
| 本地浏览/搜索/筛选/归档、档案视图 | ✅ | 纯本地 |
| 第三方历史（danmakus/zeroroku） | ✅ | 公开接口 |
| 添加 V 的检索（名称模糊搜 / UID 直查） | ✅ | 匿名 `nav` 也下发 `wbi_img`；`search/type` 匿名 `code=0` |
| 账号信息 / 粉丝数 / 直播状态 | ⚠️ 间歇 | `acc/info` 实测一次 `code=0`、一次 `-352`；`stat`/`live` 稳定 |
| **抓投稿与动态内容** | ❌ **要登录** | 匿名 `arc/search` → `-352`；重复后 **412 封禁**；动态流**直接 412** |
| 微博内容 | ❌ **要登录** | 匿名 `mymblog` → `302` 登录页 |

三条实现纪律：

1. **`wbi` 分层**：`get_wbi_keys(allow_anonymous=…)` —— 检索路径放行匿名签名，
   **抓取路径保持严格默认**（未登录快速明确失败）；密钥来源记录在 `wbi_status()` 里。
2. **闸门在入口**（`services/capabilities.content_fetch_allowed()`）：未登录时
   `async_fetch_posts` / `async_fetch_first_screen` **一次请求都不发**（返回 `login_required`），
   动态名单整条跳过（与微博名单同一套 `_lane_skip_reason`），5 个内容端点直接 **403 + 原因**。
   理由不只是省配额：匿名硬撞会把 IP 弄脏，代价由用户承担。
3. **能力是策略，不是断言**：`services/capabilities.py::FEATURES` 是**我们承诺什么**，
   `tests/fixtures/capability_matrix.json` 是**平台当时给什么**；`tests/test_capabilities.py`
   双向约束（实测可用 ⇒ 不得标 `requires_login`；被 412 硬拒 ⇒ 必须标）——
   平台一变，用例先红，逼我们重测再改承诺。

### 3.10 桌面壳生命周期：隐藏 / 深休眠 / 退出（2026-09-15，R18 devlog/095 + R20 devlog/097）

壳（Tauri）与后端是**两个进程**，`✕`、托盘、深休眠各自触发不同的事件。三条规则：

1. **关闭 ≠ 退出**：`CloseRequested` 被拦成 `hide()` + `set_skip_taskbar(true)` + `emit(shell:hidden)`
   （后台抓取照常、前端**停表**）；`RunEvent::ExitRequested` 在非主动退出时 `prevent_exit()`
   —— 深休眠销毁 WebView 也会走到这里，少这一句整个应用会被"休眠"带走。关闭语义由
   `prefs.close_action` 决定（`ask` 默认 / `tray` / `quit`，首次问一次并记住）。
2. **隐藏 ≠ 停止**：隐藏期间前端停掉顶栏两条轮询与状态岛轮播，**恢复时立刻补一轮**。判据必须读
   **同步源** `isShellHidden()`，且"排程"与"触发"两处都要判 —— 只判一处会漏掉隐藏前排下的那一发
   （实测漏网时刻 `22063`，隐藏发生在 `14349`）。
3. **退出路径不依赖前端**（R20 用户实测事故的结论）：原先托盘「退出」只 `emit(shell:quit-requested)`
   等前端确认，而深休眠/未加载时**没人接这个事件** ⇒ 选过"最小化到托盘"后根本退不出去。现在 Rust
   先问后端**单一事实来源**（`GET /vtuber/fetch-status` 的 `manual_running`）：**没任务在跑就 `exit(0)`**，
   有任务才唤回窗口 + 发事件让前端确认（`quit_app` 置 `QUITTING` 再 `exit(0)`）。通用纪律：
   **"必须成功"的动作不能建立在可被销毁的一侧**；判据由 `cargo test` 2 条守着。
4. **隐藏期间后端保持"尽可能快"的抓取节奏 —— 不要降频**（R24b 被明确取消，2026-09-16 用户口径）：
   托盘模式的目的是"后台照抓"，而且**已规划的消息推送（TODO R25：把开播/新动态推到其他平台）
   直接依赖这条** —— 隐藏时把 T0 直播轮询从 60s 调成 5 分钟，就等于把推送时效拖慢 5 倍。
   所以：**隐藏只影响"前端渲染与前端轮询"**（`useShellHidden` 停的是界面自己那两条链），
   **后端调度节奏与隐藏状态无关**。将来若要省电，只能在这条约束之外另找办法
   （例如系统级节能、或用户显式选择"省电模式"，且必须在界面上写清会拖慢推送）。

**深休眠（P2）**：隐藏满 10 分钟销毁 WebView 省内存（`DDTOOLKIT_TRAY_SLEEP_SECONDS` 仅供测试覆盖），
唤回时**重建窗口**并加载 `index.html?restored=1`（SPA 深链接在资源协议下会 404）；位置与视图从
`localStorage` 的 `ddtoolkit.shell-state` 恢复，`?restored=1` 是**唯一的恢复开关**（普通启动不恢复）。

### 3.11 数据目录与磁盘占用（2026-09-16，R22 devlog/103）

数据目录默认在 `%APPDATA%\com.ddtoolkit.app`（便携版可用 `DDTOOLKIT_DATA_DIR` 指定）。
实测开发档（8 个 V / 11 账号）：**库 54.3MB**（其中 `posts.raw_json` 占 **46%**，5.9KB/帖）、
**图片缓存 101.7MB**、日志 5.7MB ⇒ 涨得最快的是**图片缓存**，其次是库里的原文 JSON。

| 机制 | 规则 | 为什么 |
|---|---|---|
| 图片缓存 | TTL 7 天；**容量上限 `IMG_CACHE_MAX_MB`（默认 300）**，超限按 **mtime 最旧优先**淘汰 | 缓存是纯可再生数据。**命中会刷新 mtime** ⇒ 淘汰近似 LRU，热图（头像/常看封面）不会因"抓得早"被误删 |
| 库回收 | 启动时把库切成 `auto_vacuum=INCREMENTAL`（**超 512MB 跳过**）；解除订阅/删账号之后调 `incremental_vacuum()` | SQLite 默认 `NONE`：删掉的行只进 freelist，**文件永不缩小**；而全库 VACUUM 的临时空间≈库大小，不适合在升级路径上做 |
| 体检 | `app/services/db_maintenance.py::dir_stats()`：库（含 `-wal`/`-shm`）/ 缓存 / 日志 / 其余 + 磁盘剩余 + **遗留备份清单** | "哪块在长"必须能被回答；`vtuber.db.bak-*` 这类手工备份不会自己消失 |

> **数据目录怎么定**（`frontend/src-tauri/src/datadir.rs`，devlog/105–112）：优先级 =
> **环境变量 `DDTOOLKIT_DATA_DIR` > 应用内迁移记录（指针） > 默认目录**。默认目录有两份：
> 安装版 `%APPDATA%\com.ddtoolkit.app`、**dev 构建加 `-dev` 后缀**（`lib.rs` 的
> `cfg(debug_assertions)` 分支 —— 免得调试抓取/登录写进生产数据）；**后缀只加在默认目录上**，
> 因为环境变量与迁移指针都是"用户显式指定"，不该被改。指针文件 =
> `%APPDATA%\DDToolkit\data-dir.txt`（**刻意与数据目录平级**：放数据目录里会被"删除旧目录"一起删掉），
> 一行绝对路径、原子写（临时文件 + rename）。目标目录不存在 / 不是绝对路径 / 读失败 ⇒
> **回退默认目录并把原因带给界面（关于页红字），绝不在坏路径上新建空库**。
>
> ⚠️ **指针文件不带构建标识 ⇒ dev 构建与安装版共用同一份迁移记录**（2026-09-16 实测踩到：
> 用户装完构建产物后发现两边用同一个库 —— 在 dev 里迁到 `E:\test\DDToolkit-data`，安装版读到
> 同一条记录就跟了过去）。对**普通用户无影响**（只装一份安装版）；另外**卸载时 NSIS 不会删这个指针**。
> 收口方案（指针按构建分家 + 加"清除迁移记录"入口）记在 `docs/TODO.md` §1.4。

> ⚠️ 两条 PRAGMA（`auto_vacuum` / `VACUUM`）**不能在事务里执行** —— 维护代码走 DBAPI 的
> autocommit 连接，不套 SQLAlchemy 的隐式事务（`tests/test_db_maintenance.py` 用真库钉住）。

### 3.12 后端常驻内存与打包体积（2026-09-16 实测，devlog/121）

> 起因：用户看任务管理器问"后端还是占 128MB"。结论先摆：**这是框架地板的量级，不是缺陷** ——
> 我们自己的业务代码只占其中约 **8MB（6%）**，其余是 Python 运行时与框架依赖。

**打包版空闲**（`binaries/backend/ddtoolkit-backend.exe`，空数据目录，就绪后静置 8s）

| 指标 | 值 |
|---|---|
| **私有工作集（任务管理器"内存"列）** | **128.7 MB** |
| 总工作集 / 提交 | 117.1 MB / 97.8 MB |
| 线程 / 句柄 / 冷启动到就绪 | 12 / 219 / 2.0 s |

**分段归因**（dev 同版本解释器，按组 import 后读工作集；跨口径有 ±10MB 模糊，比例可靠）

| 段 | 累计 | 本段增量 |
|---|---|---|
| 裸 CPython 3.14 → +标准库 | 20.5 MB | 17.3 + 3.2 |
| + FastAPI/Starlette（连带 Pydantic / anyio） | 43.1 MB | **+22.6** |
| + uvicorn | 49.4 MB | +6.3 |
| + SQLAlchemy / Alembic | 77.5 MB | **+28.1**（最大单块） |
| + APScheduler / httpx | 82.7 MB | +5.2 |
| + `app.core`（配置 + 数据库引擎 / PRAGMA） | 89.9 MB | +7.2 |
| + `app.main`（**全部业务代码**：路由与服务） | 98.1 MB | **+8.2** |
| + `import jieba`（只导模块） | 100.8 MB | +2.7 |
| + `jieba.initialize()`（前缀词典常驻） | 155.6 MB | **+54.8** |

打包版比 dev 多 ~19MB（自带一份 `python314.dll`、`base_library.zip`、冻结导入器与额外 MSVC/UCRT DLL）。
**jieba 词典只在真开过一次词云之后才常驻**（R24a 起不再启动预热）：这既是 178MB → 128MB 的来源，
也是"托盘常驻久了内存会不会涨"目前**唯一已知的涨点**。

**打包目录里"在盘不在内存"的东西**（`_internal/` 共 100.6MB，空闲都不驻留）

| 条目 | 体积 | 说明 |
|---|---|---|
| `jieba/` 词典数据 | 29.6 MB | 一开词云就变成内存里那 ~55MB，且不回收 |
| `numpy` + `numpy.libs` | 25.9 MB | **`app/` 里无人 import** —— Pillow `Image.fromarray()` 里那句函数级 `import numpy` 被静态分析跟进来的 |
| `PIL` | 12.7 MB | 同上（由依赖链的钩子带进图） |
| `win32/` `pywin32_system32/` | 1.1 MB | **在 PyInstaller 依赖图里根本不存在** → 历史构建残留（构建产物没被彻底清干净） |

> **复测方法**（本次用的两把尺子）：① 打包版空闲占用 —— 以 `DDTOOLKIT_DATA_DIR` 指空目录起 exe，
> 等 `DDTOOLKIT_READY` 后读性能计数器 `\Process(ddtoolkit-backend)\Working Set - Private`（= 任务管理器口径）；
> ② 分段归因 —— 按上表顺序逐组 `import`，每次读 `GetProcessMemoryInfo().WorkingSetSize`
> （⚠️ ctypes **必须声明 argtypes**：`GetCurrentProcess()` 的伪句柄是 -1，不声明会按 32 位传、读到恒 0）。
> 诊断脚本 `scripts/check_danmaku_fetch.py` 可验词云上游现况（中文控制台需要 `PYTHONIOENCODING=utf-8`）。
>
> **优化候选（都评估过、当前都不做**，用户 2026-09-16 口径"只记账不删"）：词云词典空闲卸载 **−55MB** /
> 打包瘦身（排除 numpy+PIL）**−38.6MB 磁盘、内存无变化** / Alembic 懒加载（几 MB）。详见 `docs/TODO.md` §1.4。

## 4. 数据来源地图

| 来源 | 接口 | 鉴权 | 频率 | 落库 |
|---|---|---|---|---|
| **B 站直采** | `x/space/wbi/acc/info`、`x/relation/stat`、`live/room/v1/Room/get_status_info_by_uids`（批量 100/req）、`arc/search`、`polymer/web-dynamic/v1/feed/space`、`/detail`、`x/web-interface/view`、`x/article/view` | Cookie（SESSDATA 等，扫码登录 + refresh_token 续期）+ WBI 签名 | T0 60s / 动态流 预算自适应（约 30s~）/ 账号流 约 24h / 手动 | accounts、snapshots、posts、live_sessions(feed) |
| **微博直采** | `weibo.com/ajax/profile/info`、PC 时间线 ajax | Cookie（扫码登录保存） | 同上 | accounts、snapshots、posts |
| **zeroroku**（第三方） | `/api/bilibili/author/{mid}/history`、`/live-paid-aggregations` | 无 | 每日 3AM | snapshots(source=zeroroku)、live_gift_days |
| **danmakus**（第三方） | `vup-list`、直播场次接口 | 无 | 每周（索引）/ 每日（场次） | thirdparty_vtubers、live_sessions |
| **laplace** | 声明为源（`jobs=[]`），当前仅作为 danmakus 的辅助 | 无 | — | — |
| **本地名单** | `vtubers.csv`（随包分发，首启引导到数据目录） | — | 手动导入 / 候选池检索 | vtubers + accounts（收录时） |
| **图片代理** | `/img-proxy?url=`（白名单主机 + 磁盘缓存） | 按主机带 Referer | 按需 | `static/img-cache` |

外部源契约（`app/services/externals/`）：`ExternalSource.run_job(kind, db, client,
account_ids)`，幂等纪律「重复执行不产生重复行」；`account_ids` 白名单用于收录/加账号时
只回填该账号，避免全量扫第三方站点。

---

## 5. 分层与依赖方向

```mermaid
flowchart LR
  R["routers/（HTTP 契约）"] --> S["services/（业务与调度）"]
  R --> RP["repositories/（SQL 封装）"]
  S --> RP
  S --> P["services/platforms/（平台适配）"]
  S --> X["services/externals/（第三方源）"]
  RP --> M["models/（ORM 映射）"]
  S --> M
  M --> DB[("SQLite")]
  SCH["schemas/（Pydantic 进出参）"] --- R
  C["core/（config / database / 引擎 PRAGMA）"] --- R
  C --- RP
```

| 目录 | 职责 | 约定 |
|---|---|---|
| `app/routers/` | HTTP 契约、状态码语义（404/409/415/413）、`Depends(get_db)` | 不写 SQL；抓取类端点做忙判定 |
| `app/repositories/` | 按仓库类持会话（11 个 Repo），批量删除/分页/统计等 SQL | 写操作当场 commit；`PostRepo.create(commit=False)` 供批量入库 |
| `app/models/` | SQLAlchemy 2.0 ORM（单文件 11 表） | 唯一约束/索引与迁移链一致 |
| `app/schemas/` | Pydantic 输入输出模型 | `Out` 用 `from_attributes` |
| `app/services/` | 调度、抓取、平台适配、第三方源、认证、类型引擎、墓碑、清理 | 不碰 HTTP；重依赖延迟 import |
| `app/core/` | 配置（数据目录/环境变量）、引擎与 PRAGMA、`get_db`、共享 HTTP 客户端构造（`http.py`） | 新代码发请求一律 `new_async_client()` |

---

## 6. 不变量与纪律（改代码前必读）

1. **库内时间一律 naive UTC**，输出补 `+00:00`；
2. **posts 无外键**——删除 V / 账号必须走 `app/services/purge.py`（帖子按 platform+uid，
   5 张子表按 account_id，活动条目与曾用值按 vtuber_id），漏清一张就会被 `foreign_keys=ON`
   整次回滚（v0.9.3 修复的事故；f004 的 `vtuber_field_history` 两个外键都有，删 V 必须再按
   `vtuber_id` 清一遍——`account_id=NULL` 的行按 account 清不到）；
3. **新增迁移必须同步 `MIGRATION_HEAD`**（测试断言与 alembic head 一致）；
4. **唯一约束去重**：账号 `(platform, platform_uid)`、帖子 `(platform, platform_uid,
   platform_post_id)`、场次 `(account_id, live_id)`、礼物日 `(account_id, source, gift_date)`；
5. **抓取去重靠内存集合**，不靠捕获 IntegrityError（避免事务回滚污染整批）；
6. **归档边界剪枝**：抓取前先跑归档规则，已归档帖零网络请求；
7. **手动任务优先于定时档**（自动档起跑让位 + 持锁断点让位，两个方向都要在）；
8. **外部源幂等**，且只在每日/每周低频访问第三方站点；
9. **冻结运行时路径**：`PROJECT_ROOT = sys._MEIPASS`（打包后 alembic.ini / 迁移脚本随包）；
10. **凭据只落本机** `DATA_DIR/.env`（原子替换），不进仓库、不上传；
11. **HTTP 客户端统一走 `app/core/http.py::new_async_client()`**：直接 `httpx.AsyncClient()`
    每次构造都要 `load_verify_locations`（~1s，同步阻塞事件循环）；SSLContext 与事件循环
    无关，因此可在「每档 `asyncio.run()` 各起一循环」的模型下安全共享；
12. **增量停止必须整页扫完 + 豁免置顶帖**：平台会在流首插乱序条目（微博 `isTop` 可多条、
    B 站 `module_tag.text=置顶`），「遇已入库即 break」会漏掉同页靠后的新帖（devlog/045）；
13. **一条数据的多来源在写入侧合并**：B 站投稿的 `video`（arc/search）与 `video_dynamic`
    （动态流，同 bvid）只保留前者，动态附言进 `posts.note`（devlog/047）；
14. **场次合并要防「开放式区间」**：`end_at` 缺失既可能是「正在直播」也可能是「数据未定稿」，
    当无穷大会让很久以前的记录吞掉今天的场次 —— 用假定时长上界 + 双缺 end 时只认同标题
    （devlog/047）；
15. **模块级对象不得持有 asyncio 原语**（`Lock`/`Semaphore`/`Event`/`Queue`）：综合档是
    「**每轮一个 `asyncio.run()`**」，`asyncio.Lock` 首次 await 就绑死当时那个循环，
    第二轮必抛 `is bound to a different event loop` —— 2026-09-13 实际事故：
    起跑闸门把动态流**每轮**打成异常（devlog/076）。要跨轮复用就存**同步**状态
    （`threading.Lock` + 时刻表，锁外 `await`），或把原语按事件循环惰性创建。
    护栏：`test_platform_pacer_survives_new_event_loops`
    + `test_module_level_pacers_hold_no_event_loop_primitives`。

---

## 7. 扩展点

| 想做什么 | 改哪里 |
|---|---|
| 接入新平台（抖音/小红书…） | 继承 `platforms/base.py::BasePlatform` → `platforms/registry.py` 注册 → 前端平台常量；调度器自动接管 |
| 接入新第三方源 | 实现 `externals/base.py::ExternalSource` → `externals/__init__.py` 注册（声明 `jobs` 与周期） |
| 新增表/列 | 新建 `alembic/versions/{fNNN}_*.py`（编号按**实际实施顺序**顺延，当前 head `f004` = 签名来源/覆盖 + `vtuber_field_history`）→ 同步 `MIGRATION_HEAD` → 补 `models` 与 Repo → 若挂 `accounts/vtubers` 外键，**同步 `services/purge.py`** |
| 用户手改的字段被抓取覆盖 | **不再需要锁定**（`accounts.locked_fields` 已随 f004 删除）：抓取照常覆盖，覆盖前把旧值写进 `services/vtuber_history.py::record_field_change()`。⚠️ 记录只在**平台侧覆盖前**发生（手改不入账，devlog/075）；展示暂缓 —— 归入「账号信息历史快照」那条线（§TODO R9） |
| 调整抓取频率/节流 | `app/core/config.py`（T0-T4 周期、请求间隔、批量休息、风控冷却） |
| 新增前端视图 | `docs/UI-MAP.md`（右栏视图光条 + 场景状态机） |
| 改抓取/布局后的验证 | `python scripts/dev_check.py`（测试 + 后端冒烟）、`python scripts/ui_probe.py`（布局不变量） |
