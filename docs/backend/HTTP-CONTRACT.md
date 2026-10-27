---
doc: backend/http-contract
class: module
scope: HTTP 契约层：路由清单与分组、各端点的语义（状态码 / 忙判定 / 幂等）、请求体与出参形状，以及 409 等错误语义的统一口径
not-scope: 表结构与 Repository 方法 → backend/DATA-MODEL.md；抓取怎么被触发 → backend/FETCH-PIPELINE.md；鉴权与能力闸门 → backend/AUTH-CAPABILITIES.md
sot: app/routers/, app/schemas/
verify: python -m pytest -q tests/test_vtuber_api.py tests/test_api_auth.py
budget: 700
retire-when: HTTP 层换框架，或路由整体重排
---


## 1. Routers

> 路由数有三种口径，**真源**：`python scripts/gen_doc_numbers.py --list`。

> 口径说明（**三种数法别混**）：
>
> | 数法 | 值 | 怎么数 |
> |---|---|---|
> | **装饰器**（下文「N」用它） | **77** | `vtuber 56` + `auth 4` + `img_proxy 1` + `video_proxy 1` + `settings 12` + `messages 2` + `messages_debug 1`（dev-only）；其中 2 个是 `api_route(methods=["GET","POST"])`（`/vtuber/fetch`、`/vtuber/{id}/fetch`）—— ⚠️ **数装饰器必须把这 2 条算进去**，只数 `@router.get/post/...` 会少 2 |
> | **OpenAPI 方法×路径** | **79** | `sum(len(methods) for p in app.openapi()["paths"].values())`；**这是唯一与实现无关的数法** ⇒ 日常复核用它 |
> | OpenAPI 路径数 | **65** | `len(app.openapi()["paths"])`（同路径多方法只算 1 条；dev-only 的 `_debug` 路由**不在**，它要 dev token 才挂） |
>
> ⚠️ **2026-10-03 重新数过**（B站取流 `GET /bili/play/{post_id}` + 视频代理 `GET /video-proxy`，
> devlog/289）：实测装饰器 **77** / OpenAPI 方法×路径 **79** / 路径数 **65**。
> ⚠️ **2026-10-04：三个数各 +1**（S2 加了 `GET /bili/segments/{post_id}`，devlog/312）——
> 这一批只记**增量**、没重数全量：本机用同一套数法量到的基线已经比上面这行高 2（说明中间还有别的改动
> 没同步到这里），所以别把 78/80/66 当"重数过的值"，复核时**照本节第一条那样现数**。
> ⚠️ **2026-10-13：再各 +2**（录播播放加了 `GET /bili/play-by-bvid` 与
> `GET /bili/segments-by-bvid`，`devlog/479`），**同日晚些再 +1**（表情解析
> `GET /emoji/resolve`，`devlog/482`），**同日晚些再 +1**（表情索引诊断
> `GET /emoji/packages`，`devlog/483`），**再 +1**（示例表情 `GET /emoji/sample`，
> `devlog/487`）—— 同样只记增量。**别照抄任何一行当基线**：
> 这一段的三个数已经漂过至少两次（每次都是"改的人只记增量、下一个人照抄"）。
> 更早的版本：75/77/63（2026-09-29 M5-1 + L2）、66/—/—（批次 16）、64/70/67（R42-A）
> —— 三种数法本来就容易漂。
> ⚠️ **新增 `/vtuber/xxx` 这类"看起来不像参数"的路径时必须注册在 `/vtuber/{vtuber_id}` 之前**：
> M5-1 第一版把 `/vtuber/notices` 放在文件下面，`GET` 直接被 `{vtuber_id}: int` 捕获、恒定 422
> （`tests/test_notices.py::test_route_serves_notices` 当场抓住）。FastAPI 按**注册顺序**匹配。
>
> ⚠️ **"`app.routes` 对象数"这个口径在新版 FastAPI 下失效了（2026-09-27 实测）**：
> `include_router()` 现在只往 `app.routes` 里放一个 **`_IncludedRouter` 标记对象**
> （实测：`app.routes` = 11 = `_IncludedRouter` 5 + `Route` 4 + `Mount` 1 + `/healthz` 1），
> 子路由要请求时才展开 ⇒ 旧的"66 个 router 对象 + healthz + 4 + Mount = 71"再也量不出来
> （本仓 fastapi **0.141.1** / starlette **1.7.0**）。**别再引用那个口径**，
> 也**不要**用 `{r.path for r in app.routes}` 做判据 —— 它会 `AttributeError`
> （`tests/test_messages.py::_app_paths` 就是为这条踩坑写的注释）。
>
> **只有「装饰器」这一口径有门禁**（`scripts/gen_doc_numbers.py`），另两种要人肉重数。
> 复核命令：`python -c "import app.main as m; s=m.app.openapi()['paths']; print(len(s), sum(len([k for k in v if k in ('get','post','put','patch','delete')]) for v in s.values()))"`。
> 这类数字会随批次漂：漂了就重新数一遍再改，别留着当装饰（`dev_check.py --docs` 只查
> 版本号/索引/链接这类可机械判定的，**数不出来** —— 所以口径要写清"怎么数的"）。
> ⚠️ **dev-only 路由也会进"装饰器"计数**：所以它单独一个模块 + 标准名 `router`
> （`app/routers/messages_debug.py`）—— 用 `debug_router` 这种名字会让它从计数里消失。

### 3.1 `app/routers/vtuber.py` — 主业务路由（56，44 条路径）

路径直接 `/vtuber/...`、`/account/...`、`/posts...`、`/post/...`、`/externals/...`；
响应模型走 `app/schemas/vtuber.py`（`Out` 为 `from_attributes`）。

> **冷启动优化**：scheduler 依赖链（apscheduler/tenacity/httpx/fetcher）较重，路由内不直接
> import，经 `_sched()` 缓存包装首次调用才导入；测试 monkeypatch 本模块属性即可替换。
>
> **手动动作会推消息**（M2，devlog/244）：三个"点按钮"端点（`POST /vtuber/{id}/fetch`、
> `POST /vtuber/fetch-posts`、`POST /vtuber/update-posts`）各在**受理时**推一条
> `notice.progress`、**完成时**推一条 `notice.message`（带 `originator` = 请求头
> `X-DDToolkit-Host`，见 `client_host` 依赖；发起方自己的窗口据此**不重复提示**）。
> ⚠️ 被守卫拒绝（`skipped`）的任务**不发**受理消息；逐项进度仍由状态通道（轮询）负责。

**VTuber**

| 方法 + 路径 | 说明 |
|---|---|
| GET `/vtuber/list` | 全部 VTuber（含 accounts） |
| GET `/vtuber/fetch-status` | 抓取实时状态（TopBar 轮询）：account 跑动/当前/总数 + recent 增量快照，post 跑动/目标 + last_result |
| GET `/vtuber/{vtuber_id}` | 单 V；不存在 404 |
| POST `/vtuber` | 建 V；唯一约束冲突 409 |
| PUT `/vtuber/{vtuber_id}` | 部分更新；404。f004 起可写 `sign_override`（`null` = 撤销覆盖）与 `sign_source_account_id` |
| GET `/vtuber/{vtuber_id}/profile-cards` | 档案视图卡片布局（按 `y, x`）；空数组 = 还没排过（前端用默认布局渲染）（f006，R37-P2） |
| PUT `/vtuber/{vtuber_id}/profile-cards` | **整版保存**卡片布局；格位越界 / `card_key` 重复 / 超过 50 张 → 422（**不静默夹取**）；V 不存在 404（f006，R37-P2） |
| GET `/vtuber/{vtuber_id}/former-values` | 曾用名 / 曾用签名（各最多 5 条、最近优先、按值去重，含平台标注；f004）。**当前未接入 UI**（devlog/075：归「账号信息历史快照」，先不展示） |
| GET `/vtuber/{vtuber_id}/avatars` | **历次头像可选项**（新的在前）+ `current_url`（当前用的那张，后端推导）；账本为空时用账号现值兜底（`id`/`first_seen_at` 为 null）；V 不存在 404（f008，R47，devlog/249）。只读 —— 记账在抓取侧 |
| GET `/vtuber/notices` | **通知汇总**（M5-1，devlog/253）：`{now, notices[]}`，**已按优先级排序**；`now` = 服务端毫秒（ttl 判定基准）。每条含 `id/kind/text/value/detail/source/sticky/expiresAt/action` + **L1 新增 `form`（`state`/`notice`/`action`）与 `createdAt`**（面板据此显示"3 分钟前"）+ **L4 新增 `read`（`auto`/`confirm`，已读方式的显式口径）**。⚠️ 路径必须注册在 `/vtuber/{vtuber_id}` **之前**（否则被 int 参数捕获 ⇒ 422） |
| POST `/vtuber/notices/ack` | 记通知**已读**（落 `app_meta` 的 `notices.acked`，上限 50）；**幂等**；**两者都空 ⇒ 422**。单条用 `{id}`，**批量用 `{ids: [...]}`**（L1：面板的「一键已读」一次清「需要处理」整组）。⚠️ **状态类 id（`rate-limit`/`login-expired`/`progress-*`）一律拒收**（L4）：它们 id 稳定，一旦进已读集合，同一条状态**再次成立**时会被误判成已读（症状：再次限流却什么都不显示）。修的是"刷新/深休眠重建后完成报告复活" |
| POST `/vtuber/{vtuber_id}/background` | 上传自定义背景（jpeg/png/webp/gif，≤10MB，否则 415/413）；**类型按文件头判、限额流式读取、临时文件原子 rename、提交成功后才删旧文件**（`services/vtuber_background.py`，M3b devlog/214）；时间戳后缀防缓存 |
| DELETE `/vtuber/{vtuber_id}/background` | 清除背景回退头像铺底 |
| POST `/vtuber/{vtuber_id}/background-video` | 上传背景**视频**（需求 9，f011，`devlog/423`）：mp4/webm，≤50MB，否则 415/413；与图片那条**同纪律**（按文件头判类型、限额流式读取、原子 rename、提交成功后才删旧视频）。★ **不动背景图**（图是视频的 poster 与降级兜底）；文件名前缀 `_bgv_` 与背景图区分 |
| DELETE `/vtuber/{vtuber_id}/background-video` | 清除背景视频。⚠️ **不动背景图本身**（与上面那条 DELETE 对称） |
| PUT `/vtuber/{vtuber_id}/background-focus` | 保存背景**取景**（需求 7，f011）：`{x:0..1, y:0..1, scale:1..3}`，**归一化**存；越界 ⇒ 422。★ `x`/`y` 是**图片锚点**（V1b-3，`devlog/420`）：与 CSS `object-position` 同向（`x=1` ⇒ 看图片右边缘），锚点位置与窗口宽度、与缩放都无关 |
| DELETE `/vtuber/{vtuber_id}/background-focus` | 清除取景 ⇒ 原样铺满。⚠️ **不动背景图本身**（那是上面那条 DELETE 的事），也**不动视频那份取景**（两份分开存） |
| PUT `/vtuber/{vtuber_id}/background-video-focus` | 保存**视频**的取景（需求 9 补丁，f012，`devlog/426`）：请求体与上面那条**同一个模型**（`{x:0..1, y:0..1, scale:1..3}`，越界 ⇒ 422），存**另一列** —— 用户口径"视频的取景和图片的取景**分开**，用一个按钮切换" |
| DELETE `/vtuber/{vtuber_id}/background-video-focus` | 清除视频的取景（视频回到原样铺）。⚠️ **不动视频文件、也不动图片那份取景** |
| DELETE `/vtuber/{vtuber_id}` | 解除订阅：`purge_vtuber()` 清 posts + 5 张子表 + 活动条目 + 曾用值 + **卡片布局（f006）**，再级联删 V+accounts；外键挡下 → 409 |

**Account**

| 方法 + 路径 | 说明 |
|---|---|
| GET `/vtuber/{id}/accounts` | 某 V 的账号列表 |
| POST `/vtuber/{id}/accounts` | 建账号；(platform, platform_uid) 重复 409；成功后**只抓该新账号的账号信息 + 首屏内容**（v0.9.4：`async_fetch_accounts(fast=True)` + `async_fetch_first_screen`，不再重抓该 V 全部账号） |
| PUT `/account/{account_id}` | 更新账号；唯一冲突 409。**不记曾用值**（手改 ≠ 平台上曾经用过的，devlog/075）；字段锁定已退役（f004） |
| PUT `/vtuber/{id}/account-order` | 平台徽章拖拽重排：批量写 `accounts.sort_order`（v0.9.7） |
| PUT `/vtuber-order` | **左栏**拖拽重排：批量写 `vtubers.sort_order`（需求 4/5，f010）。⚠️ 语义与上面那条**不同**：可以只给**一部分** id（带筛选时就是可见的那几条），**没给的原地不动**（"填回原位"，不是"排在其后"）；重复/不存在的 id ⇒ 400 |
| DELETE `/account/{account_id}` | 删账号 + `purge_account()` 清理帖子与 5 张子表（卡片布局按 V 挂，不经这条） |
| GET `/account/{id}/stat-snapshots?limit=` | 统计快照历史（默认 100，上限 1000，时间倒序，UTC 补时区） |
| GET `/account/{id}/gift-days?limit=` | 礼物日聚合 |
| GET `/account/{id}/fan-trend` | 粉丝趋势点（按天分桶） |

**直播场次 / 分类**

| 方法 + 路径 | 说明 |
|---|---|
| GET `/account/{id}/live-sessions` | 合并场次列表（表内 ∪ 快照推导）+ 类型。**T4（`devlog/467`）加查询参数 `types=`**（逗号分隔的类型 key）⇒ 只返回这几类；不传/空 = 全部。⚠️ 筛在**合并结果**上（不是 SQL `WHERE` —— 一场可能由 danmakus+feed 两行组成，按列筛会筛掉一半）；认不出的 key **不报错**（只是筛不出东西：体系调整期前端可能带旧值来） |
| GET `/account/{id}/live-type-stats` | **按类型统计场次数**（T4，`devlog/467`；f017 改直查索引）⇒ `{total, items:[{category,count}], classified}`。`items` 按固定展示顺序、只含非零项、兜底 `live` 永远最后；`total` = 日历上能看到的场次数，`classified` = **定稿过**的场次数（`category_from` 不是 `fallback`；差 = 规则还没定出来的那批）。⚠️ f017（`devlog/471`）起三段拼成：**代表行的 `category` 走 `(account_id, category)` 索引聚合** + 校正叠加 + **虚拟场次现算**（它们没有表内行）。与 `/live-sessions` 的分组计数**逐类等数**（真机 14 账号对照 + 反向验证）。**读端点不写库**（身份补齐在启动期与写点之后，`devlog/473`） |
| GET `/account/{id}/live-sessions/{live_id}` | 场次详情：**只回本地库可推导的内容**（场次 + 类型 + analysis 预留），**不发起第三方请求**（2026-09-13，devlog/063） |
| GET `/account/{id}/live-sessions/{live_id}/upstream` | 该场次的第三方取数：弹幕词云 + 场次指标 + 直播动态；进程内缓存 10 分钟 + **同场次单飞**（并发调用共享一轮上游，devlog/081），失败如实降级为 `fetch_failed`/`no_danmaku`（同 devlog/063） |
| GET `/account/{id}/live-sessions/{live_id}/wordcloud` | 按需自建词云（v3 原始弹幕 + jieba 分词；**用户点按钮才调**，不落库，devlog/061） |
| PUT `/account/{id}/live-sessions/{live_id}/category` | 手工校正分类（**只影响被点的这一场**；`series`/`learned` 两档随类型落库下线，见 `devlog/467`） |
| DELETE `/account/{id}/live-sessions/{live_id}/category` | 取消校正 |
| POST `/account/{id}/live-sessions` | **手动记录一场**（B2，devlog/454）：体 `{start_at, end_at?, title?, vod_url?}` ⇒ **201** + 合并后的场次详情。时段与**表内已有记录**重叠 ⇒ **409**（`detail` 是一句点名撞上哪一场的中文）；录播地址不合格 / 结束早于开始 / 标题超 80 字 ⇒ **422** + 中文原因；账号不存在 ⇒ 404。只有 self 快照的时段**放行**（合并会把快照并进这一组） |
| PATCH `/account/{id}/live-sessions/{live_id}` | 编辑场次（B2）：只传要改的字段（`exclude_unset`；`end_at: null` = 清空改回"进行中"，`vod_url: ""` = 清空录播）。**自动抓来的场次只允许 `vod_url`** ⇒ 其余字段 **400**（下次同步会覆盖回去）；不在表内（self 推导的虚拟场次）⇒ **404**；空体 ⇒ 422 |
| DELETE `/account/{id}/live-sessions/{live_id}` | 删除**手动记录**的场次（B2）⇒ `{deleted, live_id}`；自动抓来的 ⇒ **400**（下次同步会放回来）；不在表内 ⇒ 404。同时清掉该场的分类校正（不留悬空记录） |
| GET `/account/{id}/live-sessions/{live_id}/vod-candidates` | **给这一场找录播候选**（C1，`devlog/464`）：扫该 V 的 B 站号 + 录播号（`mid=` 可临时再加一个）的投稿，**只读**、给打分的候选与理由，由用户点一下确认（计划口径「误配比漏配更糟」） |
| GET `/account/{id}/vod-sources` | **列一个号的可扫来源**（B3，`docs/plans/vod-autofill.md`）：`{mid, sources:[{kind: series\|season\|uploads, id, name, total, picked}], picked_id, error}`。`mid` 省略 ⇒ 用该 V 记住的录播号（`vod_account_uid`，**左 = 高优先**），没有则回落到它自己的 B 站号。⚠️ **取不到时 `error` 非空**（不许让"没取到"看起来像"这个号没有合集"）。**只读、不写库** |
| GET `/vtuber/vod-accounts/resolve` | **录播号资料卡**（2026-10-15，小窗那一行 `\| 昵称 mid 投稿数 \|`）：`?mids=1,2,3`（**中文逗号也认**）⇒ `{items:[{mid, name, avatar, uploads, last_published_at, name_error, uploads_error}]}`，**顺序与请求一致**。昵称/头像走匿名的 `x/web-interface/card`、投稿数走登录态的 `arc/search` ⇒ **两半各自独立失败**（号有效但昵称没取到时界面标黄、仍允许保存）；`uploads` 取不到是 **`null` 不是 0**；每个 mid 两次上游 ⇒ 超过 12 个**截断**。⚠️ 路径形状不许被 `{vtuber_id}` 路由撞上（一段式与 `/vtuber/vod/accounts` 都撞过，症状是 422 `int_parsing`） |
| POST `/account/{id}/vod-scan` | **整号批量扫描**（B3）⇒ 审查表用的「场次 ↔ 录播」配对：体 `{mids?, sources?, tolerance_minutes=90}`（`mids` 省略 = 记住的录播号 + 自己的号兜底，**顺序即优先级**）。**只读、一个字节都不写**。每条匹配带 `confidence`（0 标题时间+回放词 / 1 有时间无回放词 / 2 同日+时长兜底）、`auto_ok`、`minutes_delta`、`alternates`；配不上的进 `unmatched`（**已有 `vod_url` 的场次既不匹配也不算漏配**，不变量 39）。无可扫的号 ⇒ 422 |
| POST `/account/{id}/vod-apply` | **把审查表里勾中的写进 `vod_url`**（B3，**整条链路上唯一会写的端点**）：体 `{items:[{live_id, vod_url}]}` ⇒ `{applied, failed, results:[{live_id, ok, vod_url, error}]}`。地址走与手动填**同一个** `normalize_vod`；**逐条独立**（一条不合格不让别的白写，失败原因逐条列出）；空 `items` ⇒ 422；账号不存在 ⇒ 404 |
| POST `/account/{id}/vod-clear` | **硬清这个账号下所有已匹配的录播地址**（B4 第三版，`devlog/502`）：体 `{dry_run=false}` ⇒ `{cleared, auto, manual, untracked, dry_run, results}`。按 `vod_url IS NOT NULL` **全清**（用户口径「硬性清除所有已匹配项」，不分类）、**一个上游请求都不发**、**只清地址不删场次**；`auto/manual/untracked` 只是分类报数（确认窗要先把"其中手填 N 条"摆出来）。`dry_run=true` 只数不写（也照给 `cleared`）。账号不存在 ⇒ 404 |

**活动 / 预约 / 第三方索引**

| 方法 + 路径 | 说明 |
|---|---|
| GET `/vtuber/{id}/events` / POST 同名 | 手动活动条目列表 / 新增 |
| DELETE `/vtuber/event/{event_id}` | 删除活动条目 |
| GET `/vtuber/{id}/future-reservations?days=` | 未来直播预约（解析预约帖） |
| GET `/externals/vtubers?kw=&source=` | 第三方索引搜索 |
| GET `/externals/vtubers/by-uid?uid=&source=` | 按 uid 取第三方条目 |

**帖子**

| 方法 + 路径 | 说明 |
|---|---|
| GET `/posts/{platform}/{uid}` | 某账号全部帖子（旧接口） |
| GET `/posts/{platform}/{uid}/paginated` | 服务端分页；`type`/`is_archived`/`is_deleted`/`q`/`date_from`/`date_to`（`page_size` 1-200） |
| GET `/posts/{platform}/{uid}/stats` | 统计概览 |
| POST `/posts` | 建帖；三元组重复 409 |
| PUT `/post/{post_id}` / DELETE `/post/{post_id}` | 更帖 / 删帖；404 |
| POST `/posts/{post_id}/refresh-media` | **重取这一帖的媒体地址**（devlog/320，批次 3）：本地没有固化副本而远端图床签名过期时的备选路径（详情页**媒体**回落全失败时**一帖只调一次** —— 图床四级与**视频整条链**都走这条，后者见 `devlog/363`；B站视频帖前端不调，理由见下）。走平台自己的详情补全（`BasePlatform.enrich`），写回**只动 `cover_url`/`body_json`/`raw_json`/`stats_json`**（标题/发布时间不动 ⇒ 列表顺序不因重取而变），随后顺手固化一次（**已归档的帖不固化** —— 保护名单只认未归档帖，下了也会被归档清理删掉）。如实分级：404 帖不存在 / **403 该平台未就绪**（内容接口闸门：B站要登录、微博要登录、**小红书要 Cookie**，理由由 `capabilities` 下发）/ **409 平台没有详情补全**（如 B站视频帖）/ **429 同帖 30s 内重来**（图床地址限时，重取太频只会白跑）/ 502 上游失败。⚠️ 撞上**我们自己的令牌桶**（`identity_limit`：抖音详情 `aweme_detail` 0.12/s ≈8.3s 一发）时**排队等它**（`REFRESH_MEDIA_WAIT_MAX` 秒封顶）再试，而不是立刻 502 —— 用户主动点开一帖，等几秒是合理的；**额度照算**（等 = 按配置的节奏来，不是绕开限速），等不完才 502 并说清"这是我们自己的限速"（2026-10-06 真机：连着点开两条抖音视频，第二条就是这么废掉的，`devlog/366`）。响应 `{ok, pinned, post}`——`post` 是最新的一整帖，前端直接就地替换 |

**播放（B站取流，C1+C2，devlog/289）**

| 方法 + 路径 | 说明 |
|---|---|
| GET `/bili/play/{post_id}?qn=&fallback=&cid=` | 取播放地址：**用户点播放才调**（地址短时效 + 绑 IP ⇒ 120s 短缓存、**不落库**）。`qn` = "想要哪档"（实际档看账号权益，响应里的 `quality` 才是真给的）；`fallback=true` ⇒ 换 `fnval=1` 取 **durl 单 mp4**（720P 封顶，DASH 播不动时用）；**`cid` = 哪一 P**（`devlog/329`，不传 = 第 1 P）。响应只给前端要用的 `{quality, accept[], dash:{video[],audio[]}, durl[], expires_in, kernel, pages[], page}`——`pages` 是分P 列表（`[{cid,page,part,duration_s}]`，单P 视频为空）。⚠️ **上游 `view.duration` 是各 P 之和**，别拿它当片长；**Cookie 只在请求头**。错误如实分级：帖子不存在 404 / 非 B站帖或缺 bvid 400 / 上游 `-404` 404、`-403` 403（充电专属等）、`-352` 429 / 要的那一 P 不在该视频里 404 |
| GET `/bili/segments/{post_id}?qn=&cid=` | **段表**（devlog/312）：MSE 内核靠它"跳到第 N 秒就取那一段"。`cid` = 哪一 P（devlog/329）——⚠️ **必须与 `/bili/play` 同一条流**（段表按 P1、地址按 P2 会退化成 devlog/327 那类"取回来落不下"）。响应 `{bvid, quality, duration_s, video:{mime,urls[],init,segments[],duration_s}, audio:{…同形…}}`——`mime` 是 `MediaSource.isTypeSupported` 要的**精确 codecs 串**（缺 codecs 时只给容器类型，前端据此判"不支持"并退渐进式），`init`/`segments[].start|end` 是**闭区间字节偏移**（直接喂 `Range`）。⚠️ 每段还带 **`t` = 精确起点（秒，按原始 tick 累加）**（`devlog/324`）：`dur_s` 是三位小数四舍五入的（音频 5.0155 → 5.016，每段多 0.0005s，531 段累计**偏晚 0.26s**）⇒ 前端若拿它累加，"缓冲末尾之后该取哪一段"会永远算回刚取过的那一段（真机"一直转圈"）；整表另有 `duration_exact_s`。两条流各取 64KB 头部解析 `ftyp/moov/sidx`（110s 缓存，跟着取流那 120s 走）。错误与 `/bili/play` 同一套分级，另加 **502**：拿不到段表（没有 `sidx` / 上游取头部失败）——前端把 502 当"这条路不成立"，**静默退回渐进式**，不打扰用户 |
| GET `/bili/play-by-bvid?bvid=&qn=&fallback=&cid=` | **按 BV 号取流**（2026-10-13，用户 3.2 录播播放 / `devlog/479`）：与 `/bili/play/{post_id}` **同一套口径**（同一个 `play_info`、同一套错误分级、同样 120s 短缓存、同样不落库），差别只有"bvid 从哪来"。为什么必须单开一条：上面那条的前提是"这条视频是一个**帖子**"（要查库把 post_id 翻成 bvid），而**录播不是帖子** —— `live_sessions.vod_url` 指向的多半是录播组发的视频，库里没有那条 post。`bvid` 收 **BV 号或链接**（与入库时同一个抠号函数 `domain/live_manual.py::bvid_of`）；抠不到 → **400 + 中文原因**（不是 500） |
| GET `/bili/segments-by-bvid?bvid=&qn=&cid=` | **按 BV 号取段表**（同上）：与 `/bili/segments/{post_id}` 逐字一致。⚠️ 前端必须拿**与 `/bili/play-by-bvid` 同一组 `qn`/`cid`**（两条端点不同流 = 段表与地址对不上，切 P/换清晰度时尤其明显） |
| GET `/emoji/resolve?names=a,b,c` | **表情名 → 图片地址 + 大小**（2026-10-13，用户第 5 条 / `devlog/482`；**两级解析** `devlog/483`；**两类大小** `devlog/485`）：正文里的 `[UPOWER_<uid>_贴贴]`、`[包名_石化]` 这类 token 要画成真表情。**两级**：①**第一源 = 我们自己载荷**（`posts.raw_json` 里 `rich_text_nodes[*].emoji`，离线、实测覆盖 **99.0%** 种类 / 96.8% 次数）→ ②**第二源 = 上游整表**（全局动态包 + 本机账号面板，出网、**账号相关**、实测 28%）。第一源命中就**不问上游**。⚠️ 第一源在**启动期**建索引（`warm_raw_index`：0.71s / 5,060 行，增量靠 `app_meta` 记号 ⇒ 读路径**不写库、不扫表**，`devlog/473`；索引格式带版本号 `{"v":2,…}`，读到旧格式会**全量重扫一次**）；第二源**按需**拉（只在第一源漏项时出网一次，进程内缓存 **30 分钟**，失败后 **60s** 内不重试 —— 防"上游一挂就每个请求打一次"）。响应 `{items: {token: {url, size}}, count, origin, why}`：⚠️ **查不到的条目不出现在 `items` 里**（前端据此渲染名字 chip；返回空串会让它分不清"没这个表情"与"取失败了"）。**`size` 是 B站 自己的字段**（`1` = 小表情/与文字同大小、`2` = 大表情/贴纸、`null` = 上游没给 ⇒ 按小表情画）：⚠️ 判别**不能**按"官方还是自定义"—— 走官方 `/bfs/emote/` 路径的 `[明前奶绿_灰头土脸]` 之类也是 `size=2`（实测 812 个）；第二源给同一件事（脸的 `meta.size`）。`origin` 是诊断（`payload`/`panel`）；`why` 是第二源最近一次**拉取失败**的原因（载荷全中时按设计不出网 ⇒ 那时它恒为 `null`）。上游怎么坏都**不 500**（返回已命中的 + `why`）。`names` 超过 `MAX_TOKENS`（200）**明确 400**，不悄悄截断 |
| GET `/emoji/sample` | **示例用的一对真表情**（2026-10-14 / `devlog/487`）：给「设置 → 外观 → 大表情大小」的图文混排示例挑**一大一小**两枚，返回 `{names, small: {name,url,size}\|null, large: …｜null}`。⚠️ 从**已经热好的第一源索引**里挑（纯内存、不出网、不扫库），且**确定性**（名字排序后取第一枚）—— 每次打开设置看到同一对，用户才能"上次调到 40 是这个效果"地复现。索引没热上 ⇒ 两个字段都是 `null`，界面据此**不显示**示例（宁可不显示，也不画空框） |
| GET `/emoji/packages` | **表情索引诊断**（2026-10-13 / `devlog/483`；两类大小 `devlog/485`）：`{payload_names, payload_packages, payload_package_ids, payload_small, payload_large, payload_size_unknown, panel_names, panel_at, panel_why}`。为什么留：载荷里的 `package_id` 是"将来要整包"时的**种子**（官方 `EmoteService/PackageDetail`、第三方快照都按包 id 查），而重扫全库要 0.7s ⇒ 扫描时顺手存下来；这个端点让那份数据**取得到**（不然就埋在内存里没人能用）。只读内存，不触上游 |

**抓取 / 归档 / 候选池**

> ⚠️ **未登录闸门**（devlog/086）：下面带「内容接口」标记的端点在未登录时**直接 403**
> （`capabilities.content_fetch_allowed()`）—— 匿名打 B 站空间接口会被平台 `412 request
> was banned`（IP 级），所以"试了失败"不可接受。账号信息类与归档类**不挡**。

| 方法 + 路径 | 说明 |
|---|---|
| GET `/capabilities` | 本机能力矩阵：`features`（**四态** `full`/`degraded`/`requires_login`/`disabled` + 用户说明 + 实测依据）/ `limited` / `wbi` / `measured_at` / **四家**的登录态（`bilibili_logged_in` / `weibo_logged_in` / `xiaohongshu_logged_in` / `douyin_logged_in` = Cookie 配齐没有）**+ 抖音总开关 `douyin_enabled`**（默认 false；与登录态**分开报** —— 关着时 `douyin_content` 的 state 是 **`disabled`**（不是 `requires_login`）、note 指向设置里的开关）。前端据此**标注**受限功能而不是隐藏（devlog/086；小红书那条 2026-10-04 才补上，`devlog/321`；抖音 `devlog/334/335`；`disabled` 第四态 `devlog/338`） |
| GET/POST `/vtuber/fetch` | 手动全量抓账号信息；自动档在跑时**抢占**，仅另一个手动任务在跑才 skipped |
| GET/POST `/vtuber/{id}/fetch` | 抓单个 V 账号信息（同样可抢占自动档） |
| POST `/vtuber/fetch-posts?name=&platform=&video_pages=&dynamics_pages=&full=` | 按名字抓帖子（-1 全量；`full=true` 后台执行）；**抓前先跑归档规则**。内容接口 → 未登录 **403** |
| POST `/vtuber/fetch-all-posts` | 全部账号全量抓（视频+动态）。内容接口 → 未登录 **403** |
| POST `/posts/archive?days=30` | 归档规则；幂等，返回 cutoff/unarchived_total。**纯本地，不需登录** |
| POST `/vtuber/update-posts?name=` | 更新未归档动态：先归档再抓动态，整页已归档即停。内容接口 → 未登录 **403** |
| GET `/vtuber/pool/search?kw=` | 本地候选检索（R11，devlog/083）：`vtubers.csv`（`origin='pool'`）+ `thirdparty_vtubers` 索引（`origin='index'`）两来源合并，按 `(platform, uid)` 去重（池优先）、剔除已入库 |
| GET `/vtuber/bili/search?kw=&page=` | **直接从 B 站检索**（池外收录通道，R11）：纯数字 ≥5 位 → `acc/info` + `relation/stat` 精确查；否则 `wbi/search/type` 模糊搜；结果带 `in_library`。⚠️ **路径是两段**：`/vtuber/bili-search` 会被先注册的 `/vtuber/{vtuber_id}` 吃掉 → 422 `int_parsing`。**未登录也能用**（匿名 WBI 签名，devlog/086；`acc/info` 可能被平台间歇风控 → `upstream_degraded`）。上游失败如实回 `error`+`hint`（`rate_limited` / `page_limit` / `upstream_degraded` / `network_error` / `not_found`）；预算：0.8s 串行 + 20 次/分 + 5 分钟缓存 + 最多 3 页 |
| GET `/vtuber/users/search?kw=&page=&platforms=` | **多平台按名字搜人**（B1，需求 8，`devlog/463`）：一次并发搜四家（B 站 / 微博 / 小红书 / 抖音），按平台**分组**返回（顺序 = 设置界面那四家的顺序），每条带 `in_library`。`platforms` 留空 = 全部。⚠️ **抓取开关关着的平台一个请求都不发**，结果里 `skipped=true` + 「去哪打开」的 `hint`（**与 `error` 是两件事**：关着是用户的设置，不是故障）；每平台各自带 `error`/`hint`（`not_logged_in` / `upstream_degraded` / `network_error` / `not_found` / `empty_kw` / `unsupported`），单平台失败不影响其余。纯数字（≥5 位）= UID ⇒ **只搜 B 站**（那是"按 UID 添加"的既有能力）。预算：每平台 1s 间隔 + 5 分钟缓存。⚠️ **路径同样是两段**（一段式会被 `/vtuber/{vtuber_id}` 吃掉） |
| POST `/vtuber/adopt` | 收录 V+账号。`source=None/'pool'` → 必须在候选池内，名称以池为准（池内无 404）；`source='bilibili'` → **池外通道**：platform 必须是 bilibili（否则 400）且**服务端自己打一次 `acc/info` 校验**（**客户端给的名字永不被信任**）：确实没这个人 → 404，**没问到**（未登录且拿不到密钥/网络/风控）→ **503** + 原因。`source='weibo'/'xiaohongshu'/'douyin'` → 同一条"按 uid 复核主页信息"的通道（`_VERIFY_BY_PROFILE`，三家都在表里；`devlog/234`/`334`，微博 2026-10-11 补）。已入库/并发冲突 409；成功后后台抓该 V + 回填历史（未登录时**首屏内容跳过**，账号信息与第三方历史照常） |
| POST `/vtuber/fetch-accounts` | 批量：后台抓全部账号信息，立即返回；手动任务在跑 409 |
| POST `/vtuber/batch/fetch-all-posts` | 批量：后台全量抓帖子 |
| POST `/vtuber/batch/update-unarchived` | 批量：后台更新未归档 |
| POST `/vtuber/batch/archive?days=30` | 批量归档，同步执行 |

**关键调用点**：
- `/adopt` 与 `POST /{id}/accounts` 为同步端点（线程池执行），后台抓取必须走
  `BackgroundTasks`——直接 `asyncio.create_task` 会因工作线程无事件循环抛 `RuntimeError`；
- `/adopt` 自 R11（devlog/083）起是 **`async def`**：池外通道要用
  `await bili_search_svc.exact_user(uid)` 做服务端校验（客户端给的名字不算数）；
- 路由顺序约束：`/vtuber/fetch-status` 必须注册在 `/vtuber/{vtuber_id}` **之前**；
  **新增 `/vtuber/xxx/yyy` 之外的子资源端点时更要小心**：`/vtuber/bili-search`
  会被 `/vtuber/{vtuber_id}` 匹配掉（422 `int_parsing`），所以是 `/vtuber/bili/search`；
- 抓取类端点的忙判定用 `manual_task_running()`（自动档持锁不算忙，允许抢占），
  外部批次（T4）用 `any_fetch_running()`。

### 3.2 `app/routers/auth.py` — 登录（7：扫码 3 + 粘贴 cookie 2 + 浏览器扩展 3）

| 方法 + 路径 | 说明 |
|---|---|
| POST `/auth/{platform}/qr/start` | 生成二维码会话。bilibili 返回 `{qr_id, url}`；weibo 返回 `{qr_id, image}`（data URL）。同平台旧会话作废 |
| GET `/auth/{platform}/qr/check?qr_id=` | 轮询状态机：`waiting / scanned / confirmed / expired / failed`；`confirmed` 时完成登录并持久化凭据；TTL 180s |
| GET `/auth/{platform}/status` | `{logged_in, needs_login, uid, name}`；B 站走内存维护结果，**微博做真实有效性探测**（结果缓存 60s），**小红书/抖音只报"配齐了没"**（另带 `configured/missing/note`；两家都没有免签名的探活端点，不做探测。抖音另带 `ua_configured`，**不回显 UA 全文**） |
| POST `/auth/xiaohongshu/cookie` | **粘贴 cookie**（body `{"cookie": "a1=…; web_session=…"}`）。⚠️ 先校验再落盘：缺 `a1`/`web_session` ⇒ **400 且不写 `.env`**；成功回 `{status:"saved", ...status()}`（devlog/233） |
| POST `/auth/douyin/cookie` | **粘贴 cookie + UA**（body `{"cookie": "uifid=…; s_v_web_id=…; ttwid=…", "user_agent": "…"}`；`user_agent` 可省但**强烈建议给**）。⚠️ 先校验再落盘：缺 `s_v_web_id`/`uifid`(或 `UIFID_TEMP`)/`ttwid` ⇒ **400 且不写 `.env`**。UA 是凭据的一部分：`a_bogus` 会把它算进签名，给错的样子是**静默空数据**（HTTP 200 + 0 字节，devlog/333/334）|
| GET `/auth/pairing` | **浏览器扩展的配对 token**（E1）：`{token, last_sync}`。⚠️ 要应用 token（它给的就是钥匙本身）；**没有就生成一个**（幂等）；落 `app_meta` 的 `pairing.token`，**重启不变**，只有 `/pairing/reset` 才换。值不进日志/通知/诊断。`last_sync`（E3）= 上一次**成功**导入的摘要 `{platform, label, keys, cookie_keys, verified, at}`（**只有键名与计数，没有 cookie 值**；从没同步过是 `null`；失败的那次不记）|
| POST `/auth/pairing/reset` | 换一把新的配对 token（旧值**立即失效**）：`{token}` |
| POST `/auth/import` | **浏览器扩展推凭据的入口**（E1）：body `{platform, cookie, ua?}` + 头 **`X-DDToolkit-Pair`**。三层门：**回环来源**（否则 403）· **失败节流**（60s 内失败 ≥10 次 ⇒ 429）· **配对 token**（否则 401，与应用 token 分开的两把钥匙）。⚠️ **先与"应用里已有那条 cookie"合并**（同名以浏览器为准、已有键**只增不删**）—— 浏览器里那两类指纹 cookie（小红书 `a1`、抖音 `s_v_web_id`）是**页面 JS 铸的**，可能被清或压根没有（2026-10-06 用户实测）；`from_stored` 如实回报哪几个有用键不是这次从浏览器来的。回执成功与失败**同一形状**：`{ok, platform, label, keys, missing, cookie_keys, verified, from_stored, note}`（失败是 **400** 而不是 500 —— "缺键/过期"是正常业务结果）；`keys` **只给键名不给值**。校验：B 站/微博**先探活再落盘**（上游说未登录 ⇒ 不落盘且内存还原；网络异常 ⇒ 照样保存但 `verified=false`），小红书/抖音走各自既有的键校验（`verified=false`） |

- 实现分发：bilibili → `app/services/auth.py`（SESSDATA 管理、心跳 + `refresh_token` 续期，
  `run_maintenance()` 由 lifespan 起协程）；weibo → `app/services/weibo_auth.py`（Session v2 扫码）；
  **xiaohongshu → `app/services/xhs_auth.py`**（粘贴 cookie，**不走 `qr/*`**：它连二维码接口都要签名）；
  **扩展导入 → `app/services/cookie_import.py`**（一条校验链 + 同一形状的回执；配对凭证在
  `app/services/pairing.py`；cookie 串解析在 `app/services/cookie_parse.py`）；
- 凭据持久化经 `app/services/env_store.py`（读改写 `.env`，临时文件 + 原子替换）；
- 新增平台只需在 `_PLATFORMS` 注册 + 提供 `begin_login` 实现（见 `docs/backend/PLATFORMS.md`）。

### 3.3 `app/routers/img_proxy.py` — 图片代理（1）

| 方法 + 路径 | 说明 |
|---|---|
| GET `/img-proxy?url=` | 转发远端图片；磁盘缓存命中直接回，回源失败 502 |

**安全（防 SSRF + 存储型 XSS）**：仅 http/https；主机匹配 `IMG_PROXY_ALLOWED_HOSTS`
（默认 `hdslb.com,sinaimg.cn,wbcdn.cn`）；`follow_redirects=False` 逐跳重新校验（最多 3 跳）；
限响应 10MB；`content-type` 仅允许图片/octet-stream；按主机带 Referer 防盗链。

**性能**：磁盘缓存 `static/img-cache/{md5}.bin + .json`（TTL 7 天，原子写入，过期 2×TTL 清理）；
模块级共享 `httpx.AsyncClient`（lifespan 关闭时释放）。

### 3.4 `app/routers/video_proxy.py` — 视频代理（1）

| 方法 + 路径 | 说明 |
|---|---|
| GET `/video-proxy?url=` | 流式转发白名单内的**视频** URL（Range 直通、**不落盘**、上游非 2xx 原样回该状态码；上游连不上 502，主机不在白名单 400） |

**为什么必须存在**：`<video>` 设不了 `Referer`，而平台 CDN 要 Referer 才给（`bilivideo.com`
不带 → 403）；同源代理还天然过 CSP 的 `media-src`。

**按主机分策略**（`HOST_POLICY`，2026-10-03 实测两家要求**正好相反**）：`xhscdn.com`
**不带** `Referer`；`bilivideo.com` / `bilivideo.cn` 带 `https://www.bilibili.com/`；
`weibocdn.com` / `sinaimg.cn` 带 `https://weibo.com/`（后两个还要 UA —— 带 UA+Range 而无 Referer
实测 403）。本机送来的请求头里**只转发 `Range`**（`Referer`/`Origin`/`Cookie` 一律丢掉，
就是它们惹的 403）。⚠️ `bilivideo.cn` 是 B站的 **mcdn/P2P 镜像域**，
实测某视频**每一条流的 `baseUrl` 都是它**（`devlog/294`）—— 只认 `.com` 时真机全被 400 挡回。

**安全**：`ALLOWED_HOSTS` 后缀匹配只认五个平台 CDN 域（`host == h or host.endswith("." + h)`，
`xhscdn.com.evil.com` 这类伪装被挡）；⚠️ 它和 `/img-proxy` 一样是**公开端点**
（`api_auth.PUBLIC_EXACT`，`<video>` 带不了 token 头）—— 边界就是这份主机白名单 + 不转发凭据
（devlog/292 记的就是"漏登记 ⇒ 真机全 401"）。
⚠️ 前端拼 URL 必须用 `api.ts` 的 **`videoProxyUrl()`**（带 `apiBase`），且 CSP 的 `media-src`
要放行 `http://127.0.0.1:*` —— 两条都是 `devlog/294` 的真机事故（相对路径落到前端自己、
跨源媒体被 CSP 静默挡掉）。
⚠️ **客户端中止是常态**（`devlog/300`）：拖进度条/切清晰度会让浏览器掐掉在飞的请求，
代理这边把它当**正常收尾**（只记 debug），不做成异常 —— 否则 uvicorn 的 proactor transport
会往日志刷 `ERROR ... ConnectionResetError: WinError 10054` 的 traceback。
上游客户端与 `/img-proxy` 同款**模块级共享**（每请求新建要重做 TCP+TLS，Range 请求很密），
关闭时在 `lifespan` 里释放。

### 3.5 `app/routers/settings.py` — 应用设置与偏好（12，R14a/R14b devlog/091、092）

| 方法 + 路径 | 说明 |
|---|---|
| GET `/settings` | 规格表（`specs`：默认/范围/单位/生效时机/当前值/是否改过）+ `readonly`（只读项**逐条带理由**）+ `info`（版本/数据目录/库/端口/迁移 head/日志/PID） |
| PUT `/settings` | 部分更新：`{"values": {"KEY": 值}}`。白名单 + 类型 + 闭区间 + **跨字段**（上限 ≥ 下限）校验，任一不过 → **400**（detail 是中文原因，前端直接显示）；`null`/空串 = 删覆盖回默认。落库成功后才替换内存快照 |
| POST `/settings/reset` | 全部恢复默认（删掉 `app_meta` 里所有 `settings.*` 行） |
| GET `/settings/prefs` | 界面偏好（R14b：`theme`）+ 允许取值 + **当前能力说明**（"深色主题尚未实现…"由后端下发，界面不自己编）。每条 spec 还可带 **`kind`**：缺省是单选（`options`），`"range"` 是**滑杆**（带 `min/max/step/unit`，2026-10-14 起 —— `post_emoji_big`：大表情尺寸，默认 40，24–64 步 2）。同批还加了 **`group_badge`**（左栏企划徽章显不显示，二值，**默认 `off`** —— 素材保持空缺，那一列默认不占那 54px） |
| PUT `/settings/prefs` | 偏好部分更新（枚举白名单在后端：`light\|system`；`dark` 现在还写不进来 → 400；滑杆那种的**白名单就是它的每一个档位** ⇒ 越界/怪值同样 400）。`null`/空串 = 回默认。存 `app_meta` 的 `prefs.` 命名空间；库里存了白名单外的值 → 记 warning 并按默认值处理（**不覆盖用户数据、不让窗口打不开**） |
| GET `/settings/agreement` | **用户协议（使用须知）闸门状态**（2026-10-06，`devlog/369`/`372`）：`{required, accepted, accepted_at, needed, app_version}` —— `required` 是**声明自己的版本**（`legal_notice.NOTICE_VERSION`，用生效日期，**不是应用版本**），`needed = accepted != required`。前端启动时取一次，`needed` 为真就**盖住整个应用**直到同意；设置 → 关于 那一栏也用它显示"同意到哪一版 / 何时同意" |
| POST `/settings/agreement` | 记下"这一**声明**版本已同意"：`{"version": "2026-10-06"}`。**版本号必须正好是当次要求的那个**，否则 **400 且不改状态**（拿别的号来 = 想绕过闸门）；成功写 `app_meta` 的 `legal.accepted_version` / `legal.accepted_at` 并回新的状态。**幂等**（重复同意只刷新时刻） |

- **协议闸门与 `/healthz` 分开**：那个是"能不能连上"的探活（探针与扩展高频打），
  这个是"要不要弹闸门"的状态 —— 合并会让探活多背一次库读。
- ⚠️ **要同意的版本是"声明版本"而不是应用版本**（用户 2026-10-06 第二次拍板）：
  「**不要每次版本更新都让用户确认一次**，如果用户协议没有更新那么就不用让用户确认了；
  这次推送的版本更新中**所有用户都需要确认**（因为之前并没有用户协议），
  而这次之后则**只有首次使用这个应用的用户**需要确认」⇒ 应用版本怎么涨都不再打扰老用户，
  **只有正文改了、把 `legal_notice.NOTICE_VERSION` 往上提**才会再要求所有人确认一次。
  同意状态跟数据目录走（`app_meta`）。

- **可热更 vs 只读的边界**由 `app/core/runtime_settings.py::SPECS` 定义（16+3=19 个键）；
  只读项写在同文件 `READONLY_NOTES` 里，界面照实列出"为什么不给改"；
- 读取路径：`config.Settings.__getattribute__` 对 SPECS 内的键先问覆盖层
  （优先级 **实例属性 > 覆盖层 > 类属性默认值**）；调用点全在 `services/scheduler.py`，
  都是"每轮/每账号读一次"，所以改完**下一轮生效、不重启**；
- 落库复用 `app_meta`（前缀 `settings.`）而**不新建表**：与 `app_meta` 同构的新表只是
  多一处漂移面 + 一次迁移 + 一次 `MIGRATION_HEAD` 变更，且要让 purge 知道它（应用级配置
  本来就不该随某个 V 被清掉）。偏好同理走 `prefs.` 前缀；
- **为什么 settings 与 prefs 分成两组端点**：语义不同 —— settings 是"抓取参数"（有范围、
  下一轮生效），prefs 是"界面长什么样"（枚举、立即生效）。混在一个 PUT 里会让两套校验
  规则纠缠，也会逼着"外观"分区挂上"下一轮生效"这种不相干的说明。

### 3.6 `app/routers/messages.py` — 推送通道（2）+ `messages_debug.py` — dev-only 合成钩子（1）

| 方法 + 路径 | 说明 |
|---|---|
| GET `/messages/stream` | **SSE 推送通道**（M0，devlog/241）。首帧 `: connected` 注释行 → 消息帧（`id: <seq>` + `data: <json>`）→ 空闲 15s 发 `: ping`。**只在带 `Last-Event-ID` 时补发**环形缓冲里更新的消息，且帧内 `replay: true` |
| POST `/messages/ack` | **客户端确认"真的读到了流"**（M1，devlog/243）：前端在收到**第一块字节**时发一次（每条连接一次），后端把见证写进日志（`推送通道：客户端已确认读到流`）—— 真机（WebView2）验收靠这一行；同时是 M5「目睹才报」订阅者注册表的雏形 |
| POST `/messages/_debug/publish` | **dev-only**：合成一条消息（`ui_probe` / 端到端测试用）。未知 `type` → 400。`DEV_API_TOKEN` 为空时这条路径**根本不在路由表里** |

- `app/services/messages.py::MessageHub` 是**推送侧唯一产生方**：类型白名单校验 → 环形
  50 条 → 投给所有订阅者（每个订阅者一条有界队列 200，满则丢最旧并计数）。`publish()`
  是**同步的、任何线程可调**（开播边沿产生在 T0 守护线程里，那里没有事件循环）⇒ 经
  `queue.Queue` 中转、由 `start()` 起的 drain 任务在应用循环里投递。**模块级 asyncio
  原语一个都不留**（`docs/backend/ARCHITECTURE.md 不变量 15：综合档每轮一个 `asyncio.run()`）。
- **为什么是 "SSE over fetch" 而不是 `EventSource`**：业务端点全要 `X-DDToolkit-Token`，
  而原生 `EventSource` 不支持自定义请求头 ⇒ 只能把 token 拼进 URL，那是硬停止条件
  （token 进日志/历史）。所以前端用 `fetch` + `ReadableStream` 读同一个 `text/event-stream`。
- **与 `fetch-status` 轮询并存、不替代**：轮询是一致性兜底（推送漏发、重连窗口）。M0
  **不退役**轮询，退役与否是后续批次的事。
- 消息类型是**隐式契约**（`domain.vtuber.updated` / `domain.account.snapshot` /
  `domain.posts.changed` / `domain.live.edge` / `notice.progress` / `notice.alert` /
  `notice.report` / `notice.message`）：前端按它分发，所以 `publish()` 对不认识的
  类型直接抛 `ValueError`。**发布点必须放在 `db.commit()` 之后**（事务可能回滚，
  消息收不回）。真源：`app/services/messages.py` 头部 + `tests/test_messages.py`。

---


### 3.7 `app/routers/fan.py` — 粉丝结构分析（一组端点，2026-10-17 新增）

> 分析端点只读，从 `datasets/fan-structure/` 的 JSON 事实表现算，**不写库**；采集端点只写数据根并访问上游。
> 模型定义见 `docs/analysis-model/README.md`；数据层与采集链路见 `docs/analysis-model/01-data.md`、`docs/analysis-model/05-pipeline-ops.md`。

| 方法 + 路径 | 说明 |
|---|---|
| GET `/fan/vtubers` | 已注册主播 + 数据是否就位。**不加载事实表**（秒回） |
| GET `/fan/{vtuber}/sessions?since=&until=` | 区间内有几场、已采几场（**采集前的预估**）。`source` 说明来源：`local` / `upstream` / `none` |
| POST `/fan/{vtuber}/collect` | 启动采集（body `{since, until}`）。同一主播同时只允许一个任务，已在跑 → **409** |
| GET `/fan/collect/status?vtuber=` | 采集进度（`state` / `done` / `total` / `failed` / `elapsed`）。不传主播则返回全部 |
| POST `/fan/collect/cancel?vtuber=` | 取消采集。**已写盘的场次保留**（重采要几分钟，删了不划算） |
| GET `/fan/{vtuber}/ranked?by=` | 名单。**`by` 必填**（`strength` / `retention` / `income`），缺了 **400** 不是 422；未知主播 404 |
| GET `/fan/{vtuber}/tags` | 10 条展示标签的说明与本窗口占比。**标签不进排序** |
| GET `/fan/{vtuber}/health` | 完整性判据 C1–C4 的汇总。无外部源时全部 `unverified`，但**没有一场被弃** |
| GET `/fan/cross?vtubers=a,b` | 两 V 名单重叠 + **超几何零模型**。**只比层级、不比分数** |
| GET `/fan/{vtuber}/timeline` | **L6 时间动态**：滑动窗（默认 25 场 / 步长 10）→ 层级序列 → 迁移矩阵 + 换血率 + 生存曲线/半衰期。矩阵含**第 4 态「未观测」**；配**独立假设零模型**（看 lift，不看对角线）；半衰期附 `r2` 与 `plateau`（指数不成立时半衰期不可信）。**单次 10~30 秒** |

**模块开关**：整组端点由偏好 `fan_workbench`（默认 `off`）控制。**未启用时一律 404** 并说明原因
（`GET /fan/vtubers` 例外 —— 界面要靠它判断该不该显示入口）。开关**即时生效、不用重启**
（实测写入 0.007~0.010 秒）。

**窗口**：`since` / `until`（`YYYY-MM-DD` 闭合区间）由用户在界面上选。不传则退化为"最近 `window` 场"。
⚠️ 换一个区间 ⇒ 分位参照总体变了 ⇒ **跨区间比绝对分位不合法**（与跨主播同一条纪律）。

- **`by` 没有默认值**（规格 §4.1）：一个叫"核心度"的单一数字会被读成价值判断，而它其实只是
  "行为强度"⇒ 逼调用方显式声明效标。这是**契约层**的选择，不是实现细节。
- **`retention` / `income` 的权重由前半窗口拟合**，后半窗口出结果（规格 §4.3）。
  用全窗口预测子会让 `y` 几乎恒为 1，`β` 退化为噪声 —— `compose.fit_criterion_weights`
  在 `y` 无方差时抛 `DegenerateOutcome` 作为第二道闸门。
- **`/fan/cross` 不返回任何分数比较**：跨 V 的测量不变性已被否证（三轴 75 分位最多差 4.2 倍），
  所以接口只给层级与重叠。判读必须看 `lift` 与**两个方向**的尾概率 —— `lift < 1` 且下尾显著
  是**贫化**（受众在分化），与"无显著差异"是两件事。
- **首次请求会慢**（单 V 约 10~20 秒，要读几百 MB JSON 并逐人聚合）。进程内有一层按
  `(主播, 窗口)` 索引的缓存，**不设失效** —— 事实表是冻结快照（不变量 I1），不会读到旧数据。

## 2. 分层与错误语义

> 依赖方向与文件写入纪律**已是不变量**，不在此复述：
> 依赖方向只许向下 → `docs/backend/ARCHITECTURE.md` 不变量 33；
> 上传/替换文件的三条纪律 → `docs/backend/ASSETS.md` 不变量 34；
> 删除必须过 purge → `docs/backend/DATA-MODEL.md` 不变量 2 / 16。

- **409 语义**：唯一约束冲突（`IntegrityError`）统一 `rollback → 409`，覆盖 V / 账号 /
  帖子建改入口与并发收录竞态（这是本层独有的口径，别处不复述）。
