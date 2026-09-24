# 术语表（Glossary）：名词 → 含义 → 代码路径 → 依赖

> **用途**：改 bug / 做需求时快速定位「这个词在代码里叫什么、在哪个文件、牵动谁」。
> **用法**：`Ctrl+F` 搜中文词或英文标识符；每行是「术语 · 含义 · 代码位置 · 关联」。
> **与 `ARCHITECTURE.md` 的分工**：架构文档讲「为什么这样设计」，本文讲「这东西在哪、改它要动谁」。
> 适用版本：`main`（2026-09-23，`MIGRATION_HEAD = f007`）。

**目录**：§1 领域名词 · §2 数据模型与字段 · §3 抓取与调度 · §4 认证与凭据 ·
§5 前端与界面 · §6 工程与流程 · §7 配置项速查 · §8 不变量与常见坑 · §9 需求 → 代码入口。

---

## 1. 领域名词

| 术语 | 含义 | 代码位置 | 关联 |
|---|---|---|---|
| **VTuber / 主播本体** | 平台无关的主播实体（名字/阵营/生日/出道日/设定/头像/自定义背景） | `app/models/vtuber.py::VTuber`；`VTuberRepo` | 一个 V 挂多个 `accounts` |
| **账号 / account** | V 在某平台的账号（昵称/签名/头像/粉丝数/直播字段） | `models/vtuber.py::Account`；`AccountRepo`；`services/platforms/` | 唯一键 `(platform, platform_uid)` |
| **主账号 / primary account** | 每个 V 按 `PRIMARY_PLATFORM_ORDER`（bilibili > weibo）取的首个账号 | `scheduler._primary_accounts()` | **只用于第三方历史回填**（动态流已改为全部账号，见「动态名单」） |
| **动态名单 / dynamics lane** | 动态流按平台分组的账号名单：**库里所有 V 的所有平台账号**各占一格；名单之间并行、**名单内部串行**，名单内间隔自适应摊平（R7，devlog/078） | `scheduler._dynamics_lanes()` / `_active_dynamics_lanes()` / `_lane_gap()` | 微博未登录时整条 weibo 名单跳过 |
| **帖子 / post** | 动态/投稿/专栏/转发/音乐的统称（证据档案的主体） | `models/vtuber.py::Post`；`PostRepo`；`components/PostCard.tsx` | 唯一键 `(platform, uid, pid)` |
| **动态 / dynamic** | B 站 `feed/space` 流（`type=text/image/video_dynamic/…`） | `fetcher.fetch_bilibili_dynamics`；`scheduler._fetch_posts_core` | 微博单流等价物：`_fetch_platform_posts` |
| **投稿 / video** | B 站 `arc/search` 视频流（`type=video`） | `fetcher.fetch_bilibili_videos` | 与 video_dynamic 同一条视频的两个来源 |
| **投稿动态 / video_dynamic** | 动态流里的投稿卡片（`type=video_dynamic`，`body_json.bvid` 指向同一视频） | `_map_dynamic_type` | **抓取侧并入 video**（v0.9.6）：不重复入库，附言写 `posts.note` |
| **UP 主附言 / note** | 投稿动态并入后保留的动态文本 | `scheduler._absorb_video_dynamic`；`posts.note` | 卡片/详情以「UP 主附言」标注 |
| **系统帖 / system** | 微博平台自动发帖（会员升级/签到/推广），B 站没有这一类 | `weibo._is_system_mblog` → `type=system` | v0.9.6；前端微博 chips 有独立「系统」组 |
| **场次并入 / self 快照合并** | self 快照推导场次并入表内场次的判定 | `LiveSessionRepo._find_group`（**区间重叠优先**）、`_overlap_seconds` | v0.9.6 由「start 差≤90min」改来 |
| **场次对外 id 定权** | 多源合并后 `live_id` 取**最高优先级源**的 id（danmakus uuid > feed 数字 id） | `LiveSessionRepo._SRC_IDS_KEY` + `merged()` 收尾 | v0.9.9/052：弹幕详情端点只认 danmakus uuid（数字 id → HTTP 400） |
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
| **归档三态 / archived filter** | 列表页归档筛选：全部 / 仅未归档（`is_archived=false`）/ 仅已归档 | `PostFilterPop`（v0.9.9 P10-A 接线 `unarchived`） | 后端参数本就支持，此前前端只接了「仅已归档」 |
| **时间范围 / date range** | 帖子发布时间过滤（`date_from`/`date_to`，本地日期串，`to` = 次日零点排他即含当天） | `utils/dateRange.ts`；`common/DateRangePicker.tsx` | 双月历 + 预设（量纲**含今天**），草稿制确认后生效 |
| **候选池 / pool** | 离线待选 VTuber 索引（`vtubers.csv`，快照式名单） | `services/pool.py`；`GET /vtuber/pool/search` | 收录（adopt）的**池内**入口（R11 起不再是唯一入口）；**索引来源不在池里**，要走池外通道（见下） |
| **索引来源 / index origin** | `thirdparty_vtubers`（danmakus 周级索引）命中、但 **`vtubers.csv` 里没有**的条目 —— 正是"池快照之后的新 V" | `GET /vtuber/pool/search` 返回项 `origin='index'` | 收录必须走池外通道（`source='bilibili'`）；标成 `pool` 会 404（devlog/083 §十一） |
| **B 站直查 / bili search** | 池外收录通道：按 uid 精确查（`acc/info`）或按名称模糊搜（`wbi/search/type`） | `services/bili_search.py`；`GET /vtuber/bili/search` | **只在显式触发时**打上游（devlog/083）；搜不到 uid，uid 走精确通道；**未登录也能用**（匿名 WBI 签名，devlog/086） |
| **能力矩阵 / capabilities** | 本机"未登录/已登录"两态下各能用什么；三态 `full`/`degraded`/`requires_login` | `services/capabilities.py`；`GET /capabilities`；实测脚本 `scripts/capability_matrix.py` | 策略 vs 实测**双向契约**（`tests/test_capabilities.py`）：实测可用 ⇒ 不得标 requires_login；被 412 硬拒 ⇒ 必须标 |
| **内容抓取闸门** | 未登录时**不发起**投稿/动态抓取（连 DB 与网络都不碰），端点直接 403 | `capabilities.content_fetch_allowed()`；`scheduler.async_fetch_posts` / `_lane_skip_reason` | 匿名硬撞会被平台 412 封 IP；账号信息/粉丝数/直播状态**不挡** |
| **在线检索（前端两个来源）** | 添加 V 浮窗里「本地候选」（输入即防抖）与「B 站」（回车/按钮才发）两种触发方式 | `components/AddVtuberDialog.tsx`；`utils/addVtuberSearch.ts` | 敲键**不打上游**由探针 `--add-v` 守着 |
| **池外收录校验** | `source='bilibili'` 时服务端必须自己打一次 `acc/info` 校验，客户端给的名字不算数 | `routers/vtuber.py::adopt_vtuber` | 非 bilibili 平台走池外 → 400；"确实没这个人" → 404，"没问到"（未登录/网络/风控）→ **503** |
| **收录 / adopt** | 把 V+账号入库，并立刻抓账号信息 + **首屏内容** + 回填第三方历史 | `routers/vtuber.py::adopt_vtuber`、**`_adopt_background`** | 添加账号走同款（只抓新账号） |
| **收录首屏 / first screen** | 新账号立刻抓到的第一屏内容（投稿 1 页 + 动态 1 页限 3 条） | `scheduler.async_fetch_first_screen` | v0.9.4，devlog/044 |
| **解除订阅 / unsubscribe** | 删 V：清帖子 + 5 张子表 + 活动条目 + 卡片布局（f006），再级联删账号 | `routers/vtuber.py::delete_vtuber`；**`services/purge.py`** | 外键全开，漏清即回滚 |
| **回填 / backfill** | 用第三方数据补历史（粉丝/场次/正文/时间） | `externals/runner.run_external_interval(account_ids=…)`；`scripts/backfill_*.py` | 收录时按账号白名单回填 |
| **重要日期 / 活动** | 手动维护的纪念日/活动条目 | `models/vtuber.py::VtuberEvent`；`VtuberEventRepo` | 前端 `vtuber_events` 增删 |
| **预约 / reservation** | 动态里的直播预约（未来场次） | `fetcher._extract_reservation`；`VtuberEventRepo.future_reservations` | `body_json.reservation` |
| **第三方源 / externals** | 只读拉取「已固定化数据」（zeroroku/danmakus/laplace） | `services/externals/{base,registry,runner}.py` + 各源 | 与直采 `platforms/` 分离 |
| **数据视图 / archive view** | 右栏四视图之一（直播日历 + 粉丝趋势）。⚠️ 2026-09-17 前叫「档案」 | `pages/PostsPage.tsx`（`view==='archive'`）；`components/LiveCalendar.tsx`、`FanTrendChart.tsx` | 展示页 cards / 列表 list / **档案视图 profile** |
| **档案视图 / profile board** | 右栏四视图之一：**卡片画布**（R37-P1 起）。⚠️ 2026-09-17 前叫「档案卡」，当时是占位页 | `components/profile/ProfileBoardView.tsx`（`view==='profile'`）；`layoutModel.ts`（几何）/ `cardRegistry.ts`（扩展点） | 卡片默认两张：纪念日 / 优质投稿 |
| **占位串 / placeholder** | B 站动态里那些**不是内容**的值：`cv<数字>`（专栏/opus id）、`[9P]`（图片张数）、`[OP]`（opus 正文占位）。展示侧一律跳过（`utils/format.ts::isPlaceholderText`），否则卡片上会出现「标题 = cv409088396」 | `frontend/src/utils/format.ts`；后端只在**专栏**缺标题时用 `cv<id>` 兜底（`fetcher._extract_dynamic_title`） | devlog/143 |
| **大事记 / vtuber_events** | 手动维护的重要日期与大型活动（演唱会/周年庆…）；`event_date` 是 `YYYY-MM-DD` **本地**日期串（别用 `new Date(s)` 解析，会按 UTC 退一天） | `models/vtuber.py::VtuberEvent`；`GET /vtuber/{id}/events`；前端 `components/profile/events.ts` + `EventsCard`（R37-P3 起接进档案视图） | devlog/145 |
| **卡片注册表 / cardRegistry** | 「支持拓展」的唯一入口：`registerCardKind({kind,title,defaultSize,render})`，重复 kind 抛错、顺序 = 注册顺序 | `components/profile/cardRegistry.ts` + `cards/index.tsx`（内置卡片注册点） | 同 `registerIdleProvider` 的先例；视图**不认识**任何具体卡片 |

---

## 2. 数据模型与字段

**12 张表**：`vtubers` / `accounts` / `posts` / `account_stat_snapshots` / `live_sessions` /
`live_gift_days` / `live_category_overrides` / `vtuber_events` / `thirdparty_vtubers` /
`app_meta`（通用 KV，f003）/ `vtuber_field_history`（曾用名·曾用签名，f004）/
`profile_cards`（档案视图卡片布局，f006）。
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
| **外键/级联** | 只有 `vtubers→accounts` 有 ORM 级联；其余 7 条不级联（5 条挂 `accounts`、2 条挂 `vtubers`：`vtuber_events`、`vtuber_field_history`） | `models/vtuber.py` | 删除必须过 `services/purge.py` |

---

## 3. 抓取与调度

| 术语 | 含义 | 代码位置 | 关联 |
|---|---|---|---|
| **综合档 / combined tier** | v0.9.3 后唯一的定时档：动态流 + 账号流同档并发 | `scheduler._run_combined_tier`、`_tier_loop` | 取代旧 T1/T2/T3a |
| **快速账号抓取 / fast path** | 收录/加账号/单V：按 id 抓、无末尾空转、头像延后 | `scheduler.async_fetch_accounts(fast=True)` | v0.9.4；`_fetch_one_account(pending_avatar=…)` |
| **头像延后 / deferred avatar** | 先落账号字段、后下载头像、再推一次快照 | `scheduler._deferred_avatar` | 只 UPDATE `avatar_path` 一列 |
| **排队兜底 / pending queue** | 收录时抢锁失败 → 入队，由综合档心跳补抓 | `scheduler._pending_account_ids`、`_drain_pending_fetches` | 不静默丢任务 |
| **共享 SSL 上下文** | 进程级缓存 SSLContext，客户端构造 ~1s → ~0.06s | `app/core/http.py::ssl_context/new_async_client` | 全仓客户端统一用它 |
| **动态流 / dynamics stream** | **按平台名单**跑（R7）：全部账号各 1 页 + 每账号限 2 帖；名单间并行、名单内串行；周期 = `max(轮开始+60s, 预算等待)`（预算：12 req·min⁻¹/平台、轮间 max(30s, 等待) ±15s；仅预算关闭时退回 15min±2min） | `scheduler.run_latest_dynamics_sweep` | 帖子锁；名单见「动态名单」 |
| **账号流 / account stream** | 全量账号信息，**数据驱动到期**（默认 24h） | `scheduler.async_fetch_and_update(auto=True)`、`account_sweep_due` | 账号锁 |
| **T0 直播轮询** | 60s 批量回写 `live_*`（不占锁、不写 last_result） | `scheduler._live_poller_loop`、`live_sweep_core` | 跳变落快照 |
| **T4 外部批次** | zeroroku/danmakus 的 3AM 日/周 cron | `scheduler.run_external_{daily,weekly}_jobs`、`_wait_for_manual_tasks` | 手动任务在跑则排队等 |
| **两把锁** | `_fetch_lock`（账号）/ `_post_fetch_lock`（帖子），互相独立 | `scheduler.py` 顶部 | 两条流因此可并发 |
| **手动优先 / 抢占** | 手动任务拿不到锁时请求自动档让位 | `_preempt_account/_preempt_post`、`_acquire_manual_*`、`_auto_yield_*_with` | 端点 409 判定 `manual_task_running()` |
| **轮次执行器** | 按平台并发的调度原语：每轮各平台各处理一个元素 | `scheduler._run_platform_rounds` | 平台内串行、平台间并行、单平台风控单独冷却 |
| **签名来源 / 覆盖（A3）** | 卡片签名 = `sign_override` → `sign_source_account_id` 账号 → 主账号 → 空；**平台签名只读**，选来源/打字都不改 `accounts.sign` | `vtubers.sign_override / sign_source_account_id`；前端 `utils/signSource.ts` | f004（devlog/074）；下拉选平台 = 改来源并清覆盖 |
| **曾用值 / vtuber_field_history** | V **在平台上曾经用过的**昵称/签名（按账号记账，抓取覆盖前入库；手改不入账） | `vtuber_field_history`；`services/vtuber_history.py::record_field_change()` | f004；**取代字段锁定**（快照表不含昵称/签名，不记账即永久丢失）；⚠️ 展示暂缓（devlog/075：归入「账号信息历史快照」） |
| **字段锁定 / locked_fields** | ~~用户手改的账号字段抓取时不覆盖~~ **已退役**（f004 删除该列）：改为"允许覆盖 + 记曾用值" | `accounts.locked_fields`（已删）；`scheduler._field_locked()` 恒 False 垫片 | v0.9.7 引入、devlog/074 退役 |
| **账号排序 / sort_order** | 平台徽章展示顺序（拖拽落库） | `accounts.sort_order`；`PUT /vtuber/{id}/account-order` | v0.9.7 |
| **档案设置窗口** | 背景/名称/企划/设定/头像/签名/账号管理（承接原 profile 视图） | `components/VtuberSettingsDialog.tsx` | v0.9.7，devlog/048 |
| **平台适配器** | `fetch_user_info` / `fetch_post_page` / `enrich` 三方法 | `services/platforms/base.py`、`registry.py`、`{bilibili,weibo}.py` | 接新平台只加一行注册 |
| **抓取模式** | 全量 / 快速 / 增量 / 最新 N 条 / 仅动态 / 收录首屏 | `_fetch_posts_core(video_pages, dynamics_pages, include_videos, stop_on_existing, limit_latest)` | 见 `backend-fetch-pipeline.md` §5.2 |
| **停止原因** | `done/page_limit/rate_limited/network_error/archived_boundary/stopped_early/error` | `PostFetchResult.stop_reason` | 前端区分「预期停止」与「丢数据」 |
| **归档边界剪枝** | 整页已归档 → 更早的页不再请求 | `_fetch_posts_core` | `archive_old_posts` 前置 |
| **置顶帖豁免** | 置顶帖排在流首且时间乱序 → 不参与增量停止判定 | 微博 `isTop` / B 站 `module_tag.text=置顶` → 页面级 `pinned_ids` | v0.9.4，devlog/045 |
| **置顶动态 / is_pinned** | 抓到的置顶帖**落库并钉在列表头**：`posts.is_pinned`（列表排序 `is_pinned desc, published_at desc`），且**每轮刷新**（列表页字段免费刷、详情接口按 `PINNED_DETAIL_REFRESH_HOURS` 节流） | `services/pinned_posts.py`（纯判定）、`scheduler._refresh_pinned_post`、`PostRepo.sync_pinned`、`PostCard` 的 `.post-card-pin` | R35，devlog/139；集合只在**第一页**同步（空集合 = 撤销） |
| **增量停止（整页）** | **整页扫完**才停，边界取页内首条「已入库且非置顶」帖 | `_fetch_posts_core` / `_fetch_platform_posts` 的 `known_hit` | 旧「遇已入库即 break」会漏同页新帖 |
| **动态流节流 / dynamics pacing** | 动态流的两条"别把请求打满"规则（R28）：**预算当真上限**（一轮装不下就按 `(n/rpm)×60s` 拉长下一轮，稳态 = `DYNAMICS_BUDGET_RPM` 次/分钟）与**空闲退避**（连续 3/6/12 轮无新帖 ⇒ 间隔下限 2/5/10 分钟） | `scheduler._dynamics_round_budget_seconds` / `dynamics_idle_floor` / `_note_dynamics_round` / `note_dynamics_activity`；常量 `DYNAMICS_IDLE_LADDER` | **R28，devlog/127**（起因见 devlog/124：动态流占日请求量约 90%，且闲时照跑满预算）；**恢复条件 = 抓到新帖 / 手动抓一次 / T0 检测到开播**；⚠️ 开播检测走 T0（1 请求/分钟）⇒ **与 R25 推送时效不冲突**；梯度是**代码常量**、不做成设置项 |
| **风控 / rate limit** | 412/-412/-509/-799 判定 + 冷却 | `fetcher.RATE_LIMIT_CODES`、`was_rate_limited`、`clear_rate_limit` | ContextVar 任务隔离 |
| **风控冷却 / rate-limit cooldown** | 触发后**按平台**冷却，时长由**连续命中次数**决定（1→`RATE_LIMIT_COOLDOWN`（默认 600s）/ 2→2× / ≥3→4×，封顶 **60 分钟**）；连续 **6 小时**无命中归零；状态落 `app_meta`（键 `ratelimit.<平台>`）⇒ **重启不遗忘**；解禁后 **10 分钟恢复期**（动态流轮间隔 ×2 ≈ 半预算） | `app/services/rate_limit.py`（纯逻辑 + 落库）、`scheduler._note_rate_limit` / `_cooldown_for_rate_limit` / `_load_rate_limit_state` / `rate_limit_status` | **R27**（devlog/125，起因见 devlog/124 的盘点）：**自动档**（动态名单 + 账号流）跳过冷却中的平台，**手动档照常受理**（显式意图优先）；顶栏状态岛读 `fetch-status.rate_limit` = `{active, reason, seconds_left, platform, hits}`；梯度/上限/归零/恢复期是**代码常量**（不外露成设置项，同 R22 的判断） |
| **WBI 签名** | B 站接口签名（混钥，缓存 30min） | `services/wbi.py` | 所有 `x/space/wbi/*` 请求 |
| **动态流预算 / dynamics budget** | 按平台的 60s 滑动窗口速率预算（12 req·min⁻¹），轮间自适应等待；**单平台主账号数 > rpm 时退化为每轮空等一个窗口**（不抛错，见 devlog/053） | `scheduler._PlatformBudget`、`_dynamics_next_due` | v0.9.8；轮前估算记账 + 轮后补差 |
| **启动外部补抓** | 启动时对每 V 主账号跑一次第三方数据（<24h 跳过） | `scheduler.start_external_catchup`、`run_startup_external_catchup` | v0.9.8，devlog/049 |
| **app_meta** | 通用 KV（进程外需要记住的少量状态） | `models.AppMeta`、`AppMetaRepo`、迁移 f003 | 键 `external.startup.last_run` |
| **状态通道** | 前端轮询的抓取进度 | `scheduler._status`（account/post/**external**，含 `task`/`vtuber_name`/`index`/`total`）、`_push_account_snapshot`、`get_fetch_status`、`GET /vtuber/fetch-status` | 前端 ~2s 轮询；顶栏文案＝「任务 - V名 - i/N」（P8-C） |
| **进度原语** | 写状态通道的辅助函数 | `_set_account_progress` / `_set_account_vtuber` / `_set_post_progress` / `_vtuber_name_of` | `vtuber_name=None` 表示「不改动」，重置须显式写 None |
| **外部任务状态** | 第三方回填/批次的 running+label+seq（顶栏胶囊 + 卡片刷新信号） | `scheduler.external_task_started/finished` | v0.9.4；`external.seq` 变化 → `fetch-idle` |
| **进度事件** | 前端跨组件刷新信号 | `ddtoolkit:account-progress` / `:fetch-idle` / `:data-changed` / `:pill-message` / `:kick-poll` | `TopBar` / `VtuberSidebar` / `PostsPage` / 档案卡 |
| **弹幕词云来源 / wc_status** | 场次详情里词云的两条来源与五种状态：`upstream`（danmakus `/api/v2/live` 的 `extra.wordCloud`）/ `upstream_absent` / `self_built`（用户点「用弹幕自建」）/ `no_danmaku` / `fetch_failed` | `app/services/{externals/danmakus,danmaku_words,danmaku_cloud}.py`、`GET …/live-sessions/{id}/wordcloud`、`components/live/LiveSessionDialog.tsx` | **上游字段断供过一次**（2026-09-13，devlog/060 → 才有 devlog/061 的自建路径）；**2026-09-16 实测已恢复**（最近 6 场各 40 词条、失败 0/6）⇒ 自建目前只是**断供兜底**。自建 = 按需现拉 v3 原始弹幕 + jieba 分词（**不落库**，与 TODO §1.2「原始弹幕明细库」是两件事），实测单场 32s / 18226 记录；**jieba 只在真点自建时才加载**（R24a 起不预热），一加载就常驻 ~55MB |

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
| **设备指纹 / buvid3·buvid4** | B 站的设备号 cookie，**每个安装自己有**一份（首次运行从 `x/frontend/finger/spi` 领 `b_3`/`b_4`，落 `.env` 的 `BILI_BUVID_3`/`_4`） | `services/auth.py::ensure_device_ids` / `cookie_str` / `_ATTR_MAP`、`config.BILI_BUVID_3/4`、`SPI_URL` | **R26①，devlog/126**：web API 只认 **`buvid3`**（登录响应给的老名字是 `bvuid3`，服务端不认）；⚠️ **绝不写死一份**（全网共享设备身份比没有更糟）；抓取时**只补缺的那个**，不覆盖已有 buvid3（保住账号↔设备关联） |

---

## 5. 前端与界面

| 术语 | 含义 | 代码位置 | 关联 |
|---|---|---|---|
| **四视图状态机** | `cards`（展示页）/ `list`（列表）/ `archive`（档案）/ `profile`（档案卡） | `pages/PostsPage.tsx` 的 `view` | 数据共享不重取 |
| **光条 / glow-bar** | 右栏顶部视图切换条（四枚 `.view-btn` + 一枚**选中块** `.glow-spot`） | `PostsPage.tsx`；`styles/posts.css::.glow-bar` | 顺序：卡片→列表→数据→档案；条身是**毛玻璃工具栏**（R39-D3），选中块是**浅粉底 + 主色粉边**（R39-D4，2026-09-23）—— 见 UI-MAP §B1「光条视图切换」 |
| **浮片 / float pill** | 斜切圆角白卡按钮/胶囊（全站按钮语言） | `components/common/FloatPill.tsx`；`.float-pill` | `.stat-pill` 为图像底特例 |
| **覆盖式滚动条** | 不占宽、自动隐藏、可拖拽的滚动条 | `components/OverlayScroll.tsx`；`.os-root/.os-scroll/.os-thumb` | 全站唯一滚动容器 |
| **场景动画** | 视图切换的入场/退场（`scene-in`/`scene-exit`/`anim-rise`） | `styles/layout.css`、`posts.css` | `--rise-i` 序号驱动错峰；退场时长 `useSceneTransition.EXIT_MS` 必须**长于** `.scene-exit` 动画（单测钉住） |
| **场景机 / sceneStep** | 切 V / 切视图的一步决策：退场 → 提交（`idle`/`commit`/`wait-prefetch`/`exit`） | `utils/sceneStep.ts`（纯函数）+ `hooks/useSceneTransition.ts`（执行） | 退场**只播一次**：退场中再来新目标直接 `commit`（连点不重播，R31/devlog133） |
| **帖子卡片** | 列表页卡片（封面 220 + 正文 + 徽章） | `components/PostCard.tsx`；`.post-card*` | 宽度契约见 `.list-inner` |
| **列宽契约** | 列表列恒为 `min(900, 可用宽)`，卡片铺满 | `styles/posts.css::.list-scroll .list-inner` | 探针断言项（devlog/039） |
| **详情抽屉** | 帖子详情弹窗（正文/统计/墓碑时间线） | `components/PostDetailDrawer.tsx` | `body_json` 解析 |
| **直播日历** | 870 定宽月历卡（9 类色系格） | `components/LiveCalendar.tsx`；`.live-calendar` | `live_type` 分类 |
| **粉丝趋势** | ECharts 双轴卡（粉丝数 + 日增粉） | `components/FanTrendChart.tsx`；`utils/chartTheme.ts` | 快照按天分桶 |
| **图片组件** | 直连 → 代理 → 占位三态 | `components/common/ProxyImage.tsx` | 微博图床直接走代理 |
| **API 客户端** | 统一 `request()` + `setApiBase()` | `api/api.ts`；类型 `api/types.ts` | 桌面端注入 sidecar 端口 |
| **设计令牌** | 颜色/圆角/阴影/字体变量 | `styles/tokens.css` | UI-MAP §D 有全表 |
| **UI 探针** | `?probe=1` 下的机器可判定布局自检 | `dev/probe.ts` + `scripts/ui_probe.py` | 八组不变量（含 `--add-v`：本地/上游来源分流；`--capabilities`：未登录提示**存在**且功能**未过度限制**） |
| **未登录提示 / 能力角标** | 顶栏「未登录 · N 项受限」入口 + 说明窗（先列"现在能做什么"再列受限项 + 去登录）；受限功能**照常可见**，只标不藏 | `hooks/useCapabilities.ts`、`utils/capabilities.ts`、`components/CapabilityLimits.tsx`；`.topbar-limits` / `.cap-limits-dialog` / `.cap-need-login` / `.cap-inline-hint` | 探针 `ui_probe.py --capabilities`（现场 = 数据副本删 `.env`） |
| **顶栏状态岛 / 通知中心** | 顶栏唯一的信息控件：条目优先级 `alert>progress>report>message`、过期与常驻规则、六类信息源（进度/第三方/完成报告/登录失效/风控冷却/瞬时消息）；空闲时**轮播**状态文案与语录 | `utils/notificationHub.ts`（判定，12 单测）、`utils/idleQuotes.ts`（空闲轮播池，15 单测）、`components/StatusIsland.tsx`（渲染）、`scheduler.rate_limit_status()`（风控字段） | 「自动节拍不占顶栏」是该模块的具名规则 + 反向用例；面板 portal+fixed，探针断言"展开不挤动右栏 + 入场动画挂上了 + 空闲轮播在走且不出进度词" |
| **空闲轮播 / 语录池** | 顶栏空闲时的文案轮播（第 0 格固定是「数据服务运行中」，状态信息不被顶掉）；语录里**不许出现进度词**。⚠️ **R19 起暂时下线**：空闲恒为状态文案，池子与扩展点保留 | `utils/idleQuotes.ts`（`IDLE_CAROUSEL_ENABLED` / `idlePool` / `pickIdle` / `registerIdleProvider`）；DOM 见 `data-idle-pool` 与 `data-idle-carousel` | 时钟是组件自己的定时器（不挂抓取轮询，否则调大轮询间隔就静默停住）；上下线要**两处一起改**（常量 + 探针断言） |
| **添加 V 浮窗** | 收录入口浮窗：本地候选（池 + 弹幕索引）与 B 站在线检索两个来源 | `components/AddVtuberDialog.tsx`；`.av-*`（`styles/posts.css`） | 探针 `--add-v`；纯逻辑在 `utils/addVtuberSearch.ts` |
| **应用设置 / 运行时覆盖层** | IconRail 底端齿轮 → **两栏设置弹窗**（左分类导航 + 右内容）：导航**只有 4 项**（外观 / 抓取设置 / 数据源 / 关于，R21 用户口径"可选项太多、设置很杂"）；抓取设置**按用途分小组**（风控与节流 / 开播信息抓取 / 定期动态轮询 / 每日定时任务 / 收录首屏），调优类收进**「高级（默认收起）」**；抓取参数**改完下一轮生效（不用重启）**，只读项逐条写理由 | `app/core/runtime_settings.py`（SPECS + 只读表）、`app/routers/settings.py`、`components/AppSettingsDialog.tsx`、`utils/settingsNav.ts`；`.aps-*` | 落库复用 `app_meta`（前缀 `settings.`）；`Settings.__getattribute__` 拦截热更键，优先级 **实例属性 > 覆盖层 > 类属性**；切页不丢草稿、圆点标未保存页；**导航/小组/折叠三者都由 `specs[].group`·`.section`·`.advanced` 数据驱动**（界面不写死清单）；「哪些算关键项」有后端白名单用例；探针 `--app-settings` |
| **主题 / 深色钩子** | 「浅色 / 跟随系统」偏好（立即生效，存 `prefs.theme`）；**深色样式尚未实现** —— 钩子 = 解析函数 + `html[data-theme]` + 空的深色令牌块 | `utils/theme.ts`（纯逻辑，13 单测）、`hooks/usePrefs.ts`、`styles/tokens.css` 的 `:root[data-theme='dark']` 空块 | `DARK_IMPLEMENTED=false` 时 `system` 解析为浅色，界面**必须**给出那句说明（`themeCaveat`）；跨语言契约把它与 `/settings/prefs` 的 note 绑在一起 |
| **托盘隐藏 / 深休眠** | 点 ✕ → 窗口隐藏到托盘（**后台抓取照常、前端停表**）；隐藏 10 分钟深休眠（销毁 WebView 省内存），唤回重建窗口并回到离开的位置 | `src-tauri/src/lib.rs`（托盘 / 拦 CloseRequested / prevent_exit / `hide_to_tray`·`quit_app` 命令）、`utils/shellLifecycle.ts`、`utils/shellState.ts`、`utils/shellBridge.ts`、`components/CloseActionDialog.tsx` | 关闭语义存 `prefs.close_action`（默认 `ask`）；**R20 起退出不依赖前端**：托盘「退出」由 Rust 先问 `GET /vtuber/fetch-status` 的 `manual_running`，**没任务在跑就 `exit(0)`**，在跑才唤回窗口发 `shell:quit-requested` 走确认 → `quit_app`（判据有 `cargo test` 2 条：字段识别 / 缺失与异常一律当"没在跑"）；停表判据必须读同步源且在"排程 + 触发"两处都判（探针 `--tray-suspend` 抓到过两个真 bug） |

---

## 6. 工程与流程

| 术语 | 含义 | 代码位置 | 关联 |
|---|---|---|---|
| **迁移链 / MIGRATION_HEAD** | alembic `a001→f007`（20 个版本）；`MIGRATION_HEAD` 必须同步 | `alembic/versions/`、`app/main.py::MIGRATION_HEAD` | 测试断言一致 |
| **一键发布 / release.py** | 十步发布编排：预检→版本同步→门禁→打版→产物校验→提交/tag→推送→Release→报告 | `scripts/release.py`；手册 `docs/RELEASE.md`；上传 `scripts/upload_release_assets.py`（幂等） | 守卫：工作树脏/notes 缺失/版本不递增/NSIS 打平/**文档漂移**/tag 冲突 → 停；`--dry-run`、`--from <步骤>` 续跑；推完自动对齐本地 `origin/<分支>` tracking ref（按 URL 推送不会自动更新它） |
| **端到端上游冒烟 / smoke_upstream** | 数据目录副本 + 真后端 + 真上游，跑"只有真环境才暴露"的链路（B 站检索 / uid 直查 / 池外收录 / 场次上游） | `scripts/smoke_upstream.py`（`--cold` = 空数据目录 + 清空凭据）；`dev_check.py --upstream` | `--capture` 顺带刷新真实 fixtures；skip 必须打印原因，不冒充通过 |
| **真实 fixtures** | 真上游回包 / 真 `installer.nsi` 片段 / 真索引条目 —— 判据的"真形状"依据 | `tests/fixtures/`（`smoke_upstream.py --capture` 生成）；用例 `tests/test_real_fixtures.py` | 规矩：**新判据至少一条用例吃真实数据**（§8 第 13 条） |
| **文档漂移门禁 / doc_check** | 判据条目**不在这里复述**（真源 = `scripts/doc_check.py` 的 `CHECKS`，跑 `python scripts/doc_check.py` 会逐条打印）：devlog 索引「有则必填 / 无重号 / 无幽灵行」、**devlog 文件名重号**（2026-09-25 加）、六处版本号一致、发布说明与 `docs/README.md` 导航、**文档数字与代码一致**（`gen_doc_numbers.py`）、**规格现状断言** | `scripts/doc_check.py`；`dev_check.py --docs`；`release.py` 预检会调它 | 这类漂移不会让任何测试红，只会在几个月后查不到"那版改了什么"。⚠️ 本节曾写死「6 项」—— 加一条判据它就漂了（**复述点漂移的活样本**，见 `DEV-LOOP.md` §0.4） |
| **启动迁移四形态** | 全新库 upgrade / 旧库 stamp / 落后增量 / 已最新快路径 | `app/main.py::_run_migrations` | 冷启动优化 |
| **旧库桥接守卫** | 桥接补不了唯一约束 → 不一致**拒绝启动**（不写假 head 承诺） | `app/main.py::_missing_unique_keys` | devlog/053 |
| **冻结后端 / frozen** | PyInstaller onedir 打包的 sidecar（`_MEIPASS` 定位资源） | `scripts/build_backend.py`、`backend_main.py`、`app/core/config.py::PROJECT_ROOT` | 资源打平事故见 devlog/036 |
| **sidecar 就绪信号** | `DDTOOLKIT_READY <url>` + `logs/sidecar.log` 性能打点 | `backend_main.py` | Tauri 启动器据此等就绪 |
| **父进程看门狗** | 壳退出后后端自尽 | `backend_main.py::_watch_parent` | 防孤儿进程 |
| **发布链** | 后端 → 桌面应用 → 聚合产物 | `npm run release`；`scripts/{build_backend,collect_release,upload_release_assets}.py` | 说明 `docs/RELEASE.md`（§3.1 是应用内更新的签名密钥与产物） |
| **应用内更新** | 「设置 → 关于」检查更新 → 下载 → 重启安装；启动后静默查一次 | `tauri-plugin-updater` / `-process`、`plugins.updater`（endpoints + pubkey）、`utils/shellBridge.ts`（`checkForUpdate`/`installUpdate`/`openReleasePage`）、`hooks/useUpdateCheck.ts`；产物 `latest.json` | **更新载体 = NSIS 安装包本身 + `.exe.sig`**（没有 `*.nsis.zip`）；签名私钥在**仓库外**、**密码不能为空**（空密码时 CLI 从终端读、脚本里会挂住）；错误分三类（`remote`=远端还没发布 / `network`=连不上、才试本地代理 / `other`）；便携版不自我更新 |
| **数据目录体检 / 库维护** | 数据目录里谁在长（库 / 图片缓存 / 日志 / 遗留备份 + 磁盘剩余）；删数据后**真的还盘** | `app/services/db_maintenance.py`（`dir_stats` / `sqlite_stats` / `ensure_incremental_autovacuum` / `incremental_vacuum`）、`app/routers/img_proxy.py::prune_cache`、`config.IMG_CACHE_MAX_MB`（默认 300，`DDTOOLKIT_IMG_CACHE_MAX_MB` 可覆盖） | 图片缓存**按 mtime 淘汰 = 近似 LRU**（命中刷新 mtime，热图不会被误删）；库切 `auto_vacuum=INCREMENTAL` **带 512MB 门槛**（全库 VACUUM 的临时空间≈库大小，不在升级路径上冒险）；两条 PRAGMA **不能在事务里**跑（走 DBAPI autocommit）；实测 8 个 V ⇒ 库 54MB（原文 JSON 占 46%）+ 缓存 101MB —— 涨得最快的是缓存 |
| **版本号同步点** | `settings.VERSION` / `package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` / README badge | 6 处 + devlog | 测试 `test_version_synced_with_devlog` |
| **整机占用 / perf_report** | 应用**整棵进程树**（壳 + WebView2 各进程 + 后端 + conhost）的内存 / 线程 / 句柄，外加冷热启动、空闲 CPU、托盘深休眠、单核亲和代理 | `scripts/perf_report.py`；数字与结论：`docs/ARCHITECTURE.md` §3.13 | 内存口径 = 性能计数器 `Working Set - Private`（**任务管理器「内存」列**，不是 `PrivateUsage`）；实测空闲 **243–257MB**（其中 WebView2 占 143–152）、收进托盘十分钟后降到 **~92MB**；**"量到 0"必须区分"没进程"与"没量到"**（devlog/134：PowerShell 终止错误 rc=0 + 空 stdout，第一版打出一排 0） |
| **测试临时目录 / TempRoot** | `cargo test` 建的 `%TEMP%\ddtk-{mig,ptr,shelllog}-*`：`Drop` 时自删 | `frontend/src-tauri/src/testtmp.rs`；三处用例的 `temp_root()` 都用它 | devlog/134：此前**只建不删**，实测堆了 **215 个目录 / 504MB**；`Drop` 两条路都收拾（目录 / 被文件占住）；`Deref<Target=Path>` 让调用点照旧写 `root.join(…)` |
| **头像 / 签名取值链** | 卡片与左栏**同源**：头像 `resolveAvatar`、签名 `resolveSign` | `frontend/src/utils/avatarSource.ts`、`utils/signSource.ts` | R33/devlog135：左栏曾自己写一份"只看平台字段"的链 ⇒ 档案设置改完看着像没生效；护栏 `ui_probe --profile-sync`（+ 单测）；左栏 `Avatar[data-src]` 与 `.hero[data-avatar-src]` 是**为可测性挂的**（虚拟时间下图片加载不完），别删 |
| **窗口圆角（系统 vs 自绘）** | Win11：圆角由 **DWM** 画（`html.dwm-corners` ⇒ CSS 半径 0）；Win10：回退自绘 `--radius-window`（8px） | `lib.rs::apply_dwm_corners` / `window_corners_mode`；`frontend/src/utils/windowCorners.ts`；`layout.css`、`tokens.css` | R34/devlog136：交给系统后**吸附（实测四角全方）、最大化方角全自动**；⚠️ 属性要在 `present_window`（显示之后）设 —— 在 `setup()` 里设会被显示流程冲掉；HRESULT 即能力探测（描边色失败不算失败） |
| **四角白边** | 4px 圆角的抗锯齿像素混到了**白**：① WebView 的背景（壳侧透明）② `.app-shell` 自己的近白底 `--c-bg-page` | 壳侧 `lib.rs::setup()` 的 `set_background_color(Color(0,0,0,0))` + `rebuild_main_window()` 的 `.background_color(...)`；前端 `layout.css` 的 `html.shell-settled .app-shell{background:transparent}` + `main.tsx` 揭幕完成挂类 | R33/devlog135：**两层缺一不可**；壳层不能一开始就透明（揭幕期各区域还在渐显 ⇒ **闪桌面**，实测过）⇒ 用 `shell-settled` 卡在"幕收完、壳画好"之后；护栏 = 默认探针断言 computed 背景透明（反向验证会红）。R34 之后只有 **Win10**（自绘圆角）这条路还会走到 |
| **dev_check** | 一键本地验证（**语法扫描** + pytest + 后端冒烟） | `scripts/dev_check.py` | 可选 `--frozen` / `--portable`；语法步是 2026-09-16 补的（devlog/131：`scripts/` 不被任何其它门禁编译，工具脚本坏了会静默绕过全部红灯） |
| **UI 探针** | 布局不变量机器验证（三档窗口宽） | `scripts/ui_probe.py` | `--first-run` 验首启浮窗 |
| **运行日志 / 日志轮转** | 双通道（轮转文件 + 控制台）：`logs/app.log` 按天切成 `app.log.YYYY-MM-DD`，保留 7 份 | `app/core/logging_setup.py::setup_logging/build_file_handler` | 排查先"按天切一刀"（devlog/076）；配置本身可测（devlog/077） |
| **场次上游取数 / live upstream** | 场次详情里"必须打第三方"的两格取数：一次调用 = **并发 2 个上游请求**（摘要 + 中断/继续事件）；成功进 10 分钟缓存，**同场次并发调用单飞共享一轮** | `services/live_upstream.py::load_live_upstream`；端点 `…/live-sessions/{id}/upstream` | 日志 `场次上游取数` ×2 + `单飞复用` ×1 是正常的（dev 下 StrictMode 会调两次，devlog/081） |
| **文档工具** | 架构图 SVG 生成 | `docs/tools/gen_diagrams.py` → `docs/diagrams/` | 只改 `dN()` 函数即可重绘 |
| **后端常驻内存 / frozen 占用** | 打包版空闲 **128.7MB**（任务管理器口径）；**业务代码只占 ~8MB**，其余是解释器 + FastAPI/SQLAlchemy 等框架地板；打包比 dev 多 ~19MB | 归因表与复测方法：`docs/ARCHITECTURE.md` §3.12；`scripts/check_danmaku_fetch.py`（词云上游现况） | 唯一已知涨点 = **开过一次词云后 jieba 词典常驻 ~55MB**（178 → 128MB 就是 R24a 删预热省下的）；`_internal` 里的 numpy 25.9MB + PIL 12.7MB **在盘不在内存**（`app/` 无人 import，Pillow 的 `fromarray` 把 numpy 带进依赖图）；优化候选见 `docs/TODO.md` §1.4 |
| **静默时段 / quiet hours** | 用户自己指定的本地时段内把**动态流**降到最慢（默认 15 分钟一轮）：睡觉时没人看，少发请求 | `scheduler.quiet_hours_active` / `quiet_dynamics_floor` / `quiet_hours_status`；设置项 `QUIET_HOURS_ENABLED/START/END/DYNAMICS_MIN_SECONDS`（前三项在设置里可见、下限在「高级」） | **R30，devlog/130**（用户口径：vtuber 全天开播但**用户不会全天醒着**）：**默认关闭**（绝不悄悄改变行为）· 支持跨午夜、`START == END` = 不生效 · **只降动态流**，T0 保持 60s（日历场次时间由 live 跳变推导，降它就会变粗）· 与 R24b 不冲突（那条否的是"隐藏就降频"） |
| **浏览器 UA / 请求头纪律** | UA 集中在一个**零依赖**模块（`UA_MAJOR`，**发版时刷新这一处**；零依赖是为了不把 httpx 拽进图片代理的冷启动路径）；口径三条：**不发 client hints**（GREASE 串只能靠猜）· **不开 HTTP/2**（要加 `h2` 依赖）· **不发 `Connection: keep-alive`**（浏览器在 h1.1 下不显式发它） | `app/core/useragent.py`；消费方 = `auth.BASE_HEADERS` / `bili_search` / `img_proxy` / `platforms/weibo` / `weibo_auth` / `danmakus`；护栏 `tests/test_user_agent.py`（结构化扫描：`app/` 下只有它能写 UA 字面量） | **R26②③，devlog/128**：盘点时全仓有 **4 个不同的大版本**（131/150/126/150）；`runner.py` 的自报家门 UA 改从 `settings.VERSION` 取（原来写死 0.5.2）。**HTTP/2 的取舍有实测**：h1.1 25.4ms vs h2 20.5ms（中位）⇒ 每次快 5ms，对后台轮询无意义 |
| **托盘状态行 / tray status** | 收进托盘后用户**唯一能看到的风控信号**：托盘 tooltip 与菜单项 `status` 显示「风控冷却中 · B 站 · 剩余 N 分钟」，冷却结束复位成「后台运行中」 | 壳 `lib.rs::set_tray_status`（改 tooltip + 菜单项文案；`TrayIcon` 没有 `menu()` getter，所以建菜单时把句柄存进 `TrayStatusItem`）、前端 `utils/trayStatus.ts`（纯文案）+ `utils/shellBridge.setTrayStatus` + `hooks/useTrayStatus`（隐藏时 60s 心跳） | **R29，devlog/129**：隐藏期间顶栏那条 2s 轮询本来会停（R18）⇒ hook 自带 **60s 心跳**且**刻意不在隐藏瞬间打第一发**（停表判据看的就是隐藏后有没有请求）；`cargo test` 1 条钉文案复位 |
| **术语表 / 本文** | 名词 → 路径 → 依赖速查 | `docs/GLOSSARY.md` | 新术语请随手补一行 |

---

## 7. 配置项速查（`app/core/config.py`）

| 名称 | 默认 | 作用 |
|---|---|---|
| `DATA_DIR` | `DDTOOLKIT_DATA_DIR` 或项目根 | 数据库/日志/凭据/静态资源根目录。桌面端启动优先级（`datadir::resolve_startup`，有单测）：**环境变量 > 应用内迁移指针 > 默认目录**（`%APPDATA%\com.ddtoolkit.app`）。设了环境变量即视为**便携/自定义安装**（界面不给迁移入口）；指针坏了回退默认目录并把原因显示给用户 |
| `DATABASE_URL` | `sqlite:///<DATA_DIR>/vtuber.db` | SQLite 连接串 |
| `LOG_FILE` / `LOG_BACKUP_DAYS` | `logs/app.log` / `7`（`DDTOOLKIT_LOG_BACKUP_DAYS` 可覆盖） | 双通道日志的文件通道：**按天轮转**（`app.log.YYYY-MM-DD`）保留最近 N 份；配置在 `app/core/logging_setup.py`（devlog/077） |
| `VERSION` | `1.0.2` | 版本号（与 6 处同步：本文件 / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` / `package.json` / README 徽章，测试断言一致） |
| `REQUEST_INTERVAL_MIN/MAX` | 3.0 / 5.0 s | 账号抓取每账号间隔 |
| `MANUAL_FAST_INTERVAL_MIN/MAX` | 0.5 / 1.0 s | 收录/单V 的账号间隔（只在账号之间生效） |
| `FIRST_SCREEN_VIDEO_PAGES` / `_DYNAMICS_PAGES` / `_DYNAMICS_LIMIT` | 1 / 1 / 3 | 收录首屏抓取规模 |
| `FETCH_BATCH_SIZE` / `FETCH_BATCH_COOLDOWN` | 10 / 60 s | 每 N 个账号休息 |
| `RATE_LIMIT_COOLDOWN` | 600 s | 风控冷却（按平台） |
| `TIER_TICK_SECONDS` | 10 s | 综合档心跳 |
| `LIVE_POLL_SECONDS` / `_JITTER` | 60 / 15 s | T0 直播轮询 |
| `DYNAMICS_BUDGET_RPM` | 12 | 动态流单平台每分钟请求预算（>0 时启用自适应） |
| `DYNAMICS_MIN_GAP_SECONDS` / `_JITTER` | 30 / 15 s | 动态流轮间最小间隔与抖动 |
| `DYNAMICS_CONCURRENCY` | 1 | **紧急开关**：1 = 名单内串行（R7 默认）；>1 = 回到 R6 的"平台内并发 N + 起跑闸门" |
| `DYNAMICS_MIN_CYCLE_SECONDS` | 60 s | 动态流周期下限（按**轮开始**计时） |
| `DYNAMICS_LANE_TARGET_SECONDS` / `_FETCH_ESTIMATE` / `_GAP_MIN` / `_GAP_MAX` | 50 / 1.5 / 2 / 5 | 名单内间隔自适应摊平：`gap = clamp((目标轮长 − N×抓取估计)/N, 2s, 5s)` |
| `DYNAMICS_LATEST_INTERVAL_MINUTES` / `_JITTER` | 15 min / 120 s | 动态流固定周期（**仅 `DYNAMICS_BUDGET_RPM<=0` 时生效**） |
| `ACCOUNT_SWEEP_STALE_HOURS` | 24 h | 账号流数据到期阈值 |
| `ACCOUNT_SWEEP_MIN_GAP_SECONDS` | 600 s | 账号流失败重试下限 |
| `MANUAL_FAST_INTERVAL_MIN` / `_MAX` | 0.5 / 1.0 s | 收录·单V 快速链路的账号间隔 |
| `FIRST_SCREEN_VIDEO_PAGES` / `_DYNAMICS_PAGES` / `_DYNAMICS_LIMIT` | 1 / 1 / 3 | 收录首屏：投稿 1 页 + 动态 1 页限 3 条 |
| `EXTERNAL_STARTUP_CATCHUP_ENABLED` / `_STALE_HOURS` | True / 24 h | 启动时外部补抓开关与新鲜度 |
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
   `vtuber_field_history` **两个外键都有**（`vtuber_id` + 可空的 `account_id`）：
   删账号按 account 清、删 V 还要按 vtuber 再清一遍，否则 `account_id=NULL` 的行会把 V 挡下
   （f004 起，回归用例 `test_delete_vtuber_cleans_account_children` 看住）。
3. **新增迁移必须同步 `MIGRATION_HEAD`**，否则冷启动快路径会把旧库误判为最新。
   另：旧库桥接（`main._sync_legacy_schema`，补列/补索引）**补不了唯一约束**，
   因此 stamp head 前必须过 `main._missing_unique_keys` —— 不一致就拒绝启动，
   不许写「本库已等于 head」的假承诺（devlog/053）。
4. **新增挂 `accounts`/`vtubers` 外键的表 → 同步 `purge.py`**。
5. **OverlayScroll 会插一层 `.os-scroll`**：给被包容器写 CSS 一律用后代选择器
   （`.list-scroll .list-inner`），写成直系子会静默失效（devlog/039）。
6. **抓取去重靠内存集合**（`existing_ids`），不要靠捕获 `IntegrityError`。
7. **手动任务永远优先**：自动档起跑见手动即跳过、持锁见手动则轮次断点让位。
8. **并发粒度是平台**：同平台内部串行，不要在一条平台流里再并发放大速率。
9. **凭据只落本机** `DATA_DIR/.env`；`.env`、`*.db*`、`logs/`、`_tmp_*` 均已 gitignore。
10. **`scripts/backend-8000.bat` 属个人脚本，不得提交**。
11. **`asyncio.create_task` 必须留强引用**：收录回填是 fire-and-forget，返回值无人
    引用时任务可能被 GC 回收（Python 文档明确警告）→ 表现为「回填静默不跑」。
    统一走 `routers/vtuber.py::_spawn_background`（`_background_tasks` 集合 + done 回调）。
12. **上游结论必须在"冷进程 + 空数据目录"里复现一次**（2026-09-15 立，devlog/085）：
    凡"某情况下也能/不能工作"的判断，都要在**空数据目录 + 全新进程 + 显式清空凭据**下再验一遍
    —— R11 的"B 站检索不需要登录"就是在**WBI 密钥已缓存**的环境里得出的，结论完全反过来。
    工具：`python scripts/smoke_upstream.py --cold`（断言未登录时的降级形态）。
    ⚠️ 两个反直觉前提：① "空数据目录"**不等于**候选池为空（`backend_main.py` 首启会把
    随包的 `vtubers.csv` 引导复制进数据目录）；② shell 里残留的 `BILI_SESSDATA` 会被子进程继承
    （`config.py` 读 `os.getenv`），不清空就测成了"登录态"。
13. **判据至少有一条用例吃真实数据**（同日立）：自造样本会让判据"看起来在工作"却永不命中
    —— 同一批里出现过两次：NSIS「打平」正则的样本漏了目标路径的引号（永远返回 0 行），
    "名字非空"的断言被 `... or str(mid)` 兜底喂成了 uid。真实数据放 `tests/fixtures/`
    （由 `scripts/smoke_upstream.py --capture` 从真上游/真构建产物刷），新判据必须有一条吃它。
14. **未登录 ≠ 不可用，但内容抓取必须登录**（2026-09-15，devlog/086）：
    匿名 `nav` **也下发 `wbi_img`**（WBI 密钥不随登录态变）⇒ 检索/账号信息/粉丝数/直播状态
    未登录都能用；而**空间内容接口**（`arc/search`、动态 `feed/space`）匿名会被平台
    `-352` 之后 **HTTP 412 `request was banned`**（IP 级、会持续，**不连累登录态**）。
    因此：`wbi.sign_params(allow_anonymous=True)` **只给检索路径**；
    内容抓取一律过 `services/capabilities.content_fetch_allowed()` 闸门 ——
    未登录时**一次请求都不发**（`stop_reason="login_required"`，5 个内容端点 403），
    而不是"试了失败"（那会白耗配额并弄脏 IP）。能力边界由
    `scripts/capability_matrix.py` 两态实测，落 `tests/fixtures/capability_matrix.json`。

---

## 9. 需求 / 缺陷 → 代码入口（速查）

| 想做的事 | 先看这里 |
|---|---|
| 加/改一个后端接口 | `app/routers/vtuber.py`（+ `app/schemas/vtuber.py`）；抓取类端点注意 `manual_task_running()` 判定 |
| 改「添加 V / 添加账号」后的抓取 | `routers/vtuber.py::_adopt_background`；账号侧 `scheduler.async_fetch_accounts`、内容侧 `scheduler.async_fetch_first_screen`（devlog/044） |
| 新代码要发 HTTP 请求 | 一律 `app/core/http.py::new_async_client(timeout)`（别直接 `httpx.AsyncClient`：每次构造 ~1s） |
| 加一张表 / 加一列 | `alembic/versions/eNNN_*.py` → `MIGRATION_HEAD` → `app/models/vtuber.py` → `app/repositories/vtuber_repo.py` →（挂外键时）`app/services/purge.py` |
| 改唯一约束 / 怀疑旧库结构不对 | `alembic/versions/c002_*`（加宽 posts 唯一键的先例）、`app/main.py::_missing_unique_keys`（桥接守卫） |
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
