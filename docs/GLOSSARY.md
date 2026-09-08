# 术语表（Glossary）：名词 → 含义 → 代码路径 → 依赖

> **用途**：改 bug / 做需求时快速定位「这个词在代码里叫什么、在哪个文件、牵动谁」。
> **用法**：`Ctrl+F` 搜中文词或英文标识符；每行是「术语 · 含义 · 代码位置 · 关联」。
> **与 `ARCHITECTURE.md` 的分工**：架构文档讲「为什么这样设计」，本文讲「这东西在哪、改它要动谁」。
> 适用版本：`main`（2026-09-09，`MIGRATION_HEAD = e007`）。

**目录**：§1 领域名词 · §2 数据模型与字段 · §3 抓取与调度 · §4 认证与凭据 ·
§5 前端与界面 · §6 工程与流程 · §7 配置项速查 · §8 不变量与常见坑 · §9 需求 → 代码入口。

---

## 1. 领域名词

| 术语 | 含义 | 代码位置 | 关联 |
|---|---|---|---|
| **VTuber / 主播本体** | 平台无关的主播实体（名字/阵营/生日/出道日/设定/头像/自定义背景） | `app/models/vtuber.py::VTuber`；`VTuberRepo` | 一个 V 挂多个 `accounts` |
| **账号 / account** | V 在某平台的账号（昵称/签名/头像/粉丝数/直播字段） | `models/vtuber.py::Account`；`AccountRepo`；`services/platforms/` | 唯一键 `(platform, platform_uid)` |
| **主账号 / primary account** | 每个 V 按 `PRIMARY_PLATFORM_ORDER`（bilibili > weibo）取的首个账号 | `scheduler._primary_accounts()` | 动态流只跑主账号 |
| **帖子 / post** | 动态/投稿/专栏/转发/音乐的统称（证据档案的主体） | `models/vtuber.py::Post`；`PostRepo`；`components/PostCard.tsx` | 唯一键 `(platform, uid, pid)` |
| **动态 / dynamic** | B 站 `feed/space` 流（`type=text/image/video_dynamic/…`） | `fetcher.fetch_bilibili_dynamics`；`scheduler._fetch_posts_core` | 微博单流等价物：`_fetch_platform_posts` |
| **投稿 / video** | B 站 `arc/search` 视频流（`type=video`） | `fetcher.fetch_bilibili_videos` | 与 video_dynamic 同一条视频的两个来源 |
| **图文 / image** | 图片动态（`type=image`，`body_json.images`） | `fetcher._extract_body_extras` | 前端 `ProxyImage` 渲染 |
| **转发 / repost** | 转发的他人动态（`type=repost`，`body_json.origin`） | `fetcher._extract_origin` | `scripts/repair_repost_origin.py` |
| **专栏 / article** | B 站 cv 长文（`type=article`，Quill Delta 富文本） | `fetcher.fetch_article_detail`；`_delta_to_plain_text` | `RichText` 渲染 |
| **直播卡片 / live_rcmd** | 动态流里的开播卡片，**不入 posts**，转存 `live_sessions` | `fetcher._is_live_rcmd/_map_live_rcmd`；`scheduler._route_live_item` | 见「直播场次」 |
| **直播场次 / live session** | 一次开播（标题/起止/分区/收益/弹幕数），三源合一 | `models/vtuber.py::LiveSession`；`LiveSessionRepo.merged()` | danmakus + feed + self 快照 |
| **统计快照 / snapshot** | 账号粉丝数/直播状态时间序列（涨粉趋势、场次推导的数据源） | `models/vtuber.py::AccountStatSnapshot`；`scheduler._record_stat_snapshot` | T0 直播跳变也写一条 |
| **礼物日聚合 / gift day** | 第三方日粒度礼物/大航海/SC 金额 | `models/vtuber.py::LiveGiftDay`；`externals/zeroroku.py` | 金额存字符串保精度 |
| **分类校正 / override** | 用户对某场次分类的手工校正（推断最高优先级信号） | `models/vtuber.py::LiveCategoryOverride`；`LiveCategoryOverrideRepo` | 反哺词库 `live_type.build_learned` |
| **9 类分类 / categories** | 杂谈/游戏/观影/投稿/歌回/健身/电台/联动/特殊 + live 兜底 | `services/live_type.py::CATEGORY_KEYS`；`infer_category()` | 前端 `utils/liveType.ts` 同步 |
| **墓碑 / tombstone** | 帖子从平台消失的删除检测（两击 + 已验证窗口） | `services/tombstone.py::apply_tombstone_scan`；`posts.deleted_detected_at` | 前端「已删」筛选/角标 |
| **归档 / archive** | 早于 N 天的帖子不再参与抓取遍历 | `PostRepo.archive_before`；`scheduler.archive_old_posts` | `is_archived` |
| **候选池 / pool** | 离线待选 VTuber 索引（`vtubers.csv`） | `services/pool.py`；`GET /vtuber/pool/search` | 收录（adopt）的唯一入口 |
| **收录 / adopt** | 从候选池把 V+账号入库，并立刻抓账号信息 + 回填第三方历史 | `routers/vtuber.py::adopt_vtuber`；`_fetch_adopted`；`_backfill_adopted_history` | 添加账号走同款 |
| **解除订阅 / unsubscribe** | 删 V：清帖子 + 4 张子表 + 活动条目，再级联删账号 | `routers/vtuber.py::delete_vtuber`；**`services/purge.py`** | 外键全开，漏清即回滚 |
| **回填 / backfill** | 用第三方数据补历史（粉丝/场次/正文/时间） | `externals/runner.run_external_interval(account_ids=…)`；`scripts/backfill_*.py` | 收录时按账号白名单回填 |
| **重要日期 / 活动** | 手动维护的纪念日/活动条目 | `models/vtuber.py::VtuberEvent`；`VtuberEventRepo` | 前端 `vtuber_events` 增删 |
| **预约 / reservation** | 动态里的直播预约（未来场次） | `fetcher._extract_reservation`；`VtuberEventRepo.future_reservations` | `body_json.reservation` |
| **第三方源 / externals** | 只读拉取「已固定化数据」（zeroroku/danmakus/laplace） | `services/externals/{base,registry,runner}.py` + 各源 | 与直采 `platforms/` 分离 |
| **档案视图 / archive view** | 右栏四视图之一（直播日历 + 粉丝趋势） | `pages/PostsPage.tsx`（`view==='archive'`）；`components/LiveCalendar.tsx`、`FanTrendChart.tsx` | 展示页 cards / 列表 list / 档案卡 profile |

---

## 2. 数据模型与字段

**9 张表**：`vtubers` / `accounts` / `posts` / `account_stat_snapshots` / `live_sessions` /
`live_gift_days` / `live_category_overrides` / `vtuber_events` / `thirdparty_vtubers`。
列级定义见 `docs/backend-repositories-and-routers.md` §1；ER 图见 `docs/ARCHITECTURE.md` §2。

| 字段/术语 | 含义 | 写入方 | 关联 |
|---|---|---|---|
| `accounts.last_fetched_at` | 账号信息最近一次**成功**抓取时间 | 账号流 / 单V抓取 / T0 不写 | **账号流到期判据**（`account_sweep_due`） |
| `accounts.posts_last_scan_at` | 帖子扫描上一轮完成时间 | 墓碑判定 | 两击判定的比较基准 |
| `posts.last_seen_at` | 最近一次确认仍在线 | 每次扫描刷新 | 墓碑 |
| `posts.deleted_detected_at` | 判定被删的时刻（非空=墓碑） | `tombstone.apply_tombstone_scan` | 前端「已删」 |
| `posts.is_archived` | 归档标记（不再追新） | `PostRepo.archive_before` | 抓取边界剪枝 |
| `posts.body_json` | 类型差异结构化数据（images/video/reservation/delta…） | 抓取入库 | 前端解析、抽屉渲染 |
| `posts.stats_json` | `{view, like, comment, forward}` | 抓取入库 | `StatBadge` |
| `posts.raw_json` | 平台原始响应（证据保真层） | 抓取入库 | `scripts/repair_*.py` 回填依据 |
| `posts.body_text` | 正文纯文本（全文搜索用） | `services/post_text.py` | `scripts/backfill_post_body_text.py` |
| `…source`（快照/场次/礼物日） | 数据来源：`self` / `zeroroku` / `danmakus` / `feed` | 各写入方 | 前端区分展示 |
| `accounts.platform_uid` | 平台侧 UID（B 站 mid / 微博 uid） | 收录/加账号 | 唯一键的一半 |
| **naive UTC** | 库内 datetime 一律无时区；输出补 `+00:00` | — | 比较参数必须同为 naive |
| **唯一约束** | 账号 `(platform, uid)`、帖子 `(platform, uid, pid)`、场次 `(account_id, live_id)` | — | 冲突统一 409 |
| **外键/级联** | 只有 `vtubers→accounts` 有 ORM 级联；其余 5 条不级联 | `models/vtuber.py` | 删除必须过 `services/purge.py` |

---

## 3. 抓取与调度

| 术语 | 含义 | 代码位置 | 关联 |
|---|---|---|---|
| **综合档 / combined tier** | v0.9.3 后唯一的定时档：动态流 + 账号流同档并发 | `scheduler._run_combined_tier`、`_tier_loop` | 取代旧 T1/T2/T3a |
| **动态流 / dynamics stream** | 每 V 主账号 1 页 + 限 2 帖（15min ±2min） | `scheduler.run_latest_dynamics_sweep` | 帖子锁 |
| **账号流 / account stream** | 全量账号信息，**数据驱动到期**（默认 24h） | `scheduler.async_fetch_and_update(auto=True)`、`account_sweep_due` | 账号锁 |
| **T0 直播轮询** | 60s 批量回写 `live_*`（不占锁、不写 last_result） | `scheduler._live_poller_loop`、`live_sweep_core` | 跳变落快照 |
| **T4 外部批次** | zeroroku/danmakus 的 3AM 日/周 cron | `scheduler.run_external_{daily,weekly}_jobs`、`_wait_for_manual_tasks` | 手动任务在跑则排队等 |
| **两把锁** | `_fetch_lock`（账号）/ `_post_fetch_lock`（帖子），互相独立 | `scheduler.py` 顶部 | 两条流因此可并发 |
| **手动优先 / 抢占** | 手动任务拿不到锁时请求自动档让位 | `_preempt_account/_preempt_post`、`_acquire_manual_*`、`_auto_yield_*_with` | 端点 409 判定 `manual_task_running()` |
| **轮次执行器** | 按平台并发的调度原语：每轮各平台各处理一个元素 | `scheduler._run_platform_rounds` | 平台内串行、平台间并行、单平台风控单独冷却 |
| **平台适配器** | `fetch_user_info` / `fetch_post_page` / `enrich` 三方法 | `services/platforms/base.py`、`registry.py`、`{bilibili,weibo}.py` | 接新平台只加一行注册 |
| **抓取模式** | 全量 / 快速 / 增量 / 最新 N 条 / 仅动态 | `_fetch_posts_core(video_pages, dynamics_pages, include_videos, stop_on_existing, limit_latest)` | 见 `backend-fetch-pipeline.md` §5.2 |
| **停止原因** | `done/page_limit/rate_limited/network_error/archived_boundary/stopped_early/error` | `PostFetchResult.stop_reason` | 前端区分「预期停止」与「丢数据」 |
| **归档边界剪枝** | 整页已归档 → 更早的页不再请求 | `_fetch_posts_core` | `archive_old_posts` 前置 |
| **风控 / rate limit** | 412/-412/-509/-799 判定 + 冷却 | `fetcher.RATE_LIMIT_CODES`、`was_rate_limited`、`clear_rate_limit` | ContextVar 任务隔离 |
| **WBI 签名** | B 站接口签名（混钥，缓存 30min） | `services/wbi.py` | 所有 `x/space/wbi/*` 请求 |
| **状态通道** | 前端轮询的抓取进度 | `scheduler._status`、`_push_account_snapshot`、`get_fetch_status`、`GET /vtuber/fetch-status` | 前端 ~2s 轮询 |
| **进度事件** | 前端跨组件刷新信号 | `ddtoolkit:account-progress` / `:fetch-idle` / `:data-changed` | `TopBar` / `VtuberSidebar` / `PostsPage` |

---

## 4. 认证与凭据

| 术语 | 含义 | 代码位置 | 关联 |
|---|---|---|---|
| **B 站登录管理器** | SESSDATA 等 Cookie 管理 + 心跳 + `refresh_token` 续期 | `services/auth.py::BilibiliAuth`、`run_maintenance()` | lifespan 起协程 |
| **扫码登录** | B 站/微博共用流程：start → check → confirmed | `routers/auth.py`、`BilibiliLoginSession`、`WeiboLoginSession` | 状态机 `waiting/scanned/confirmed/expired/failed` |
| **微博登录** | Session v2 扫码 + `_v2_login`/`_sina_login` 回退 | `services/weibo_auth.py` | 登录态**真实探测**（缓存 60s） |
| **凭据持久化** | 写 `DATA_DIR/.env`（临时文件 + 原子替换） | `services/env_store.py::save_env_keys` | 只落本机，不进仓库 |
| **登录态端点** | `{logged_in, needs_login, uid, name}` | `GET /auth/{platform}/status` | 前端 `LoginDialog` |
| **图片代理** | 绕过图床防盗链（白名单 + 磁盘缓存 + 逐跳校验） | `routers/img_proxy.py` | `IMG_PROXY_ALLOWED_HOSTS` |

---

## 5. 前端与界面

| 术语 | 含义 | 代码位置 | 关联 |
|---|---|---|---|
| **四视图状态机** | `cards`（展示页）/ `list`（列表）/ `archive`（档案）/ `profile`（档案卡） | `pages/PostsPage.tsx` 的 `view` | 数据共享不重取 |
| **光条 / glow-bar** | 右栏顶部视图切换条（四枚 `.view-btn`） | `PostsPage.tsx`；`styles/posts.css::.glow-bar` | 顺序：卡片→列表→档案→档案卡 |
| **浮片 / float pill** | 斜切圆角白卡按钮/胶囊（全站按钮语言） | `components/common/FloatPill.tsx`；`.float-pill` | `.stat-pill` 为图像底特例 |
| **覆盖式滚动条** | 不占宽、自动隐藏、可拖拽的滚动条 | `components/OverlayScroll.tsx`；`.os-root/.os-scroll/.os-thumb` | 全站唯一滚动容器 |
| **场景动画** | 视图切换的入场/退场（`scene-in`/`scene-exit`/`anim-rise`） | `styles/layout.css`、`posts.css` | `--rise-i` 序号驱动错峰 |
| **帖子卡片** | 列表页卡片（封面 220 + 正文 + 徽章） | `components/PostCard.tsx`；`.post-card*` | 宽度契约见 `.list-inner` |
| **列宽契约** | 列表列恒为 `min(900, 可用宽)`，卡片铺满 | `styles/posts.css::.list-scroll .list-inner` | 探针断言项（devlog/039） |
| **详情抽屉** | 帖子详情弹窗（正文/统计/墓碑时间线） | `components/PostDetailDrawer.tsx` | `body_json` 解析 |
| **直播日历** | 870 定宽月历卡（9 类色系格） | `components/LiveCalendar.tsx`；`.live-calendar` | `live_type` 分类 |
| **粉丝趋势** | ECharts 双轴卡（粉丝数 + 日增粉） | `components/FanTrendChart.tsx`；`utils/chartTheme.ts` | 快照按天分桶 |
| **图片组件** | 直连 → 代理 → 占位三态 | `components/common/ProxyImage.tsx` | 微博图床直接走代理 |
| **API 客户端** | 统一 `request()` + `setApiBase()` | `api/api.ts`；类型 `api/types.ts` | 桌面端注入 sidecar 端口 |
| **设计令牌** | 颜色/圆角/阴影/字体变量 | `styles/tokens.css` | UI-MAP §D 有全表 |
| **UI 探针** | `?probe=1` 下的机器可判定布局自检 | `dev/probe.ts` + `scripts/ui_probe.py` | 5 组不变量 |

---

## 6. 工程与流程

| 术语 | 含义 | 代码位置 | 关联 |
|---|---|---|---|
| **迁移链 / MIGRATION_HEAD** | alembic `a001→e007`；`MIGRATION_HEAD` 必须同步 | `alembic/versions/`、`app/main.py::MIGRATION_HEAD` | 测试断言一致 |
| **启动迁移四形态** | 全新库 upgrade / 旧库 stamp / 落后增量 / 已最新快路径 | `app/main.py::_run_migrations` | 冷启动优化 |
| **冻结后端 / frozen** | PyInstaller onedir 打包的 sidecar（`_MEIPASS` 定位资源） | `scripts/build_backend.py`、`backend_main.py`、`app/core/config.py::PROJECT_ROOT` | 资源打平事故见 devlog/036 |
| **sidecar 就绪信号** | `DDTOOLKIT_READY <url>` + `logs/sidecar.log` 性能打点 | `backend_main.py` | Tauri 启动器据此等就绪 |
| **父进程看门狗** | 壳退出后后端自尽 | `backend_main.py::_watch_parent` | 防孤儿进程 |
| **发布链** | 后端 → 桌面应用 → 聚合产物 | `npm run release`；`scripts/{build_backend,collect_release,upload_release_assets}.py` | 说明 `docs/RELEASE.md` |
| **版本号同步点** | `settings.VERSION` / `package.json` / `tauri.conf.json` / `Cargo.toml` / README badge | 5 处 + devlog | 测试 `test_version_synced_with_devlog` |
| **dev_check** | 一键本地验证（pytest + 后端冒烟） | `scripts/dev_check.py` | 可选 `--frozen` / `--portable` |
| **UI 探针** | 布局不变量机器验证（三档窗口宽） | `scripts/ui_probe.py` | `--first-run` 验首启浮窗 |
| **文档工具** | 架构图 SVG 生成 | `docs/tools/gen_diagrams.py` → `docs/diagrams/` | 只改 `dN()` 函数即可重绘 |
| **术语表 / 本文** | 名词 → 路径 → 依赖速查 | `docs/GLOSSARY.md` | 新术语请随手补一行 |

---

## 7. 配置项速查（`app/core/config.py`）

| 名称 | 默认 | 作用 |
|---|---|---|
| `DATA_DIR` | `DDTOOLKIT_DATA_DIR` 或项目根 | 数据库/日志/凭据/静态资源根目录 |
| `DATABASE_URL` | `sqlite:///<DATA_DIR>/vtuber.db` | SQLite 连接串 |
| `VERSION` | `0.9.2` | 版本号（与 5 处同步） |
| `REQUEST_INTERVAL_MIN/MAX` | 3.0 / 5.0 s | 账号抓取每账号间隔 |
| `FETCH_BATCH_SIZE` / `FETCH_BATCH_COOLDOWN` | 10 / 60 s | 每 N 个账号休息 |
| `RATE_LIMIT_COOLDOWN` | 600 s | 风控冷却（按平台） |
| `TIER_TICK_SECONDS` | 10 s | 综合档心跳 |
| `LIVE_POLL_SECONDS` / `_JITTER` | 60 / 15 s | T0 直播轮询 |
| `DYNAMICS_LATEST_INTERVAL_MINUTES` / `_JITTER` | 15 min / 120 s | 动态流周期 |
| `ACCOUNT_SWEEP_STALE_HOURS` | 24 h | 账号流数据到期阈值 |
| `ACCOUNT_SWEEP_MIN_GAP_SECONDS` | 600 s | 账号流失败重试下限 |
| `STARTUP_CHAIN_ENABLED` / `_DELAY` | True / 4 s | 启动链（动态流必跑、账号流按到期） |
| `STARTUP_DYNAMICS_LIMIT` | 2 | 动态流每账号最多入库新帖数 |
| `PRIMARY_PLATFORM_ORDER` | `["bilibili","weibo"]` | 主账号优先级 |
| `EXTERNAL_ENABLED` / `EXTERNAL_RUN_HOUR` | True / 3 | T4 外部批次开关与时刻 |
| `IMG_PROXY_ALLOWED_HOSTS` | `hdslb.com,sinaimg.cn,wbcdn.cn` | 图片代理白名单 |
| `CORS_ORIGINS` | `*` | 跨域来源（`*` 时不允许带凭据） |

---

## 8. 不变量与常见坑

1. **库内时间一律 naive UTC**；比较参数必须同为 naive，输出模型补 `+00:00`。
2. **`posts` 无外键**，`accounts` 之下 5 条外键不级联且 `foreign_keys=ON` →
   删 V / 删账号**必须**走 `app/services/purge.py`，否则整次事务回滚（devlog/040）。
3. **新增迁移必须同步 `MIGRATION_HEAD`**，否则冷启动快路径会把旧库误判为最新。
4. **新增挂 `accounts`/`vtubers` 外键的表 → 同步 `purge.py`**。
5. **OverlayScroll 会插一层 `.os-scroll`**：给被包容器写 CSS 一律用后代选择器
   （`.list-scroll .list-inner`），写成直系子会静默失效（devlog/039）。
6. **抓取去重靠内存集合**（`existing_ids`），不要靠捕获 `IntegrityError`。
7. **手动任务永远优先**：自动档起跑见手动即跳过、持锁见手动则轮次断点让位。
8. **并发粒度是平台**：同平台内部串行，不要在一条平台流里再并发放大速率。
9. **凭据只落本机** `DATA_DIR/.env`；`.env`、`*.db*`、`logs/`、`_tmp_*` 均已 gitignore。
10. **`scripts/backend-8000.bat` 属个人脚本，不得提交**。

---

## 9. 需求 / 缺陷 → 代码入口（速查）

| 想做的事 | 先看这里 |
|---|---|
| 加/改一个后端接口 | `app/routers/vtuber.py`（+ `app/schemas/vtuber.py`）；抓取类端点注意 `manual_task_running()` 判定 |
| 加一张表 / 加一列 | `alembic/versions/eNNN_*.py` → `MIGRATION_HEAD` → `app/models/vtuber.py` → `app/repositories/vtuber_repo.py` →（挂外键时）`app/services/purge.py` |
| 改抓取频率 / 节流 | `app/core/config.py`；调度结构在 `app/services/scheduler.py`（`_tier_loop` / `_run_combined_tier` / `_run_platform_rounds`） |
| 接入新平台 | `app/services/platforms/base.py` + `registry.py`；参考 `docs/platforms-extension-guide.md` |
| 接入新第三方数据源 | `app/services/externals/base.py` + `externals/__init__.py` 注册；`runner.py` 负责调度 |
| 帖子抓取漏数据 / 停止异常 | `_fetch_posts_core` 的 `stop_reason`、`PostFetchResult`；`docs/backend-fetch-pipeline.md` §5 |
| 删除检测（墓碑）行为不对 | `app/services/tombstone.py`（窗口可信性 + 两击）；`posts.last_seen_at/deleted_detected_at` |
| 直播日历/场次数据不对 | `LiveSessionRepo.merged()`（合并/去重/并段）、`app/services/live_type.py`（分类）、`_route_live_item`（feed 源） |
| 粉丝趋势不对 | `AccountStatSnapshotRepo.fan_trend_points`（按天分桶）+ `components/FanTrendChart.tsx` |
| 登录/凭据问题 | `app/services/auth.py`（B 站）、`weibo_auth.py`（微博）、`env_store.py`（写 `.env`）、`routers/auth.py` |
| 图片加载不出来 | `routers/img_proxy.py`（白名单/Referer/缓存）、`components/common/ProxyImage.tsx`（三态） |
| 改右栏视图/布局 | `pages/PostsPage.tsx` + `styles/posts.css`；改完跑 `python scripts/ui_probe.py` |
| 改侧栏/顶栏 | `components/{VtuberSidebar,TopBar,IconRail}.tsx` + `styles/layout.css` |
| 改设计令牌（颜色/圆角/阴影） | `styles/tokens.css` + `docs/UI-MAP.md` §D |
| 打包/发布问题 | `docs/RELEASE.md`、`scripts/{build_backend,collect_release}.py`、`frontend/src-tauri/tauri.conf.json`（resources 必须是**数组形式**） |
| 改完想快速验证 | `python scripts/dev_check.py`；布局类再加 `python scripts/ui_probe.py` |
