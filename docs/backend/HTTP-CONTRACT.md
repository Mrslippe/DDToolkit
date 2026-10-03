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
| GET `/vtuber/notices` | **通知汇总**（M5-1，devlog/253）：`{now, notices[]}`，**已按优先级排序**；`now` = 服务端毫秒（ttl 判定基准）。⚠️ 路径必须注册在 `/vtuber/{vtuber_id}` **之前**（否则被 int 参数捕获 ⇒ 422） |
| POST `/vtuber/notices/ack` | 记一条通知**已读**（`{id}` → 落 `app_meta` 的 `notices.acked`，上限 50）；**幂等**；空 id 422。修的是"刷新/深休眠重建后完成报告复活" |
| POST `/vtuber/{vtuber_id}/background` | 上传自定义背景（jpeg/png/webp/gif，≤10MB，否则 415/413）；**类型按文件头判、限额流式读取、临时文件原子 rename、提交成功后才删旧文件**（`services/vtuber_background.py`，M3b devlog/214）；时间戳后缀防缓存 |
| DELETE `/vtuber/{vtuber_id}/background` | 清除背景回退头像铺底 |
| DELETE `/vtuber/{vtuber_id}` | 解除订阅：`purge_vtuber()` 清 posts + 5 张子表 + 活动条目 + 曾用值 + **卡片布局（f006）**，再级联删 V+accounts；外键挡下 → 409 |

**Account**

| 方法 + 路径 | 说明 |
|---|---|
| GET `/vtuber/{id}/accounts` | 某 V 的账号列表 |
| POST `/vtuber/{id}/accounts` | 建账号；(platform, platform_uid) 重复 409；成功后**只抓该新账号的账号信息 + 首屏内容**（v0.9.4：`async_fetch_accounts(fast=True)` + `async_fetch_first_screen`，不再重抓该 V 全部账号） |
| PUT `/account/{account_id}` | 更新账号；唯一冲突 409。**不记曾用值**（手改 ≠ 平台上曾经用过的，devlog/075）；字段锁定已退役（f004） |
| PUT `/vtuber/{id}/account-order` | 平台徽章拖拽重排：批量写 `accounts.sort_order`（v0.9.7） |
| DELETE `/account/{account_id}` | 删账号 + `purge_account()` 清理帖子与 5 张子表（卡片布局按 V 挂，不经这条） |
| GET `/account/{id}/stat-snapshots?limit=` | 统计快照历史（默认 100，上限 1000，时间倒序，UTC 补时区） |
| GET `/account/{id}/gift-days?limit=` | 礼物日聚合 |
| GET `/account/{id}/fan-trend` | 粉丝趋势点（按天分桶） |

**直播场次 / 分类**

| 方法 + 路径 | 说明 |
|---|---|
| GET `/account/{id}/live-sessions` | 合并场次列表（表内 ∪ 快照推导）+ 分类推断结果 |
| GET `/account/{id}/live-sessions/{live_id}` | 场次详情：**只回本地库可推导的内容**（场次 + 分类推断 + analysis 预留），**不发起第三方请求**（2026-09-13，devlog/063） |
| GET `/account/{id}/live-sessions/{live_id}/upstream` | 该场次的第三方取数：弹幕词云 + 场次指标 + 直播动态；进程内缓存 10 分钟 + **同场次单飞**（并发调用共享一轮上游，devlog/081），失败如实降级为 `fetch_failed`/`no_danmaku`（同 devlog/063） |
| GET `/account/{id}/live-sessions/{live_id}/wordcloud` | 按需自建词云（v3 原始弹幕 + jieba 分词；**用户点按钮才调**，不落库，devlog/061） |
| PUT `/account/{id}/live-sessions/{live_id}/category` | 手工校正分类（反哺词库） |
| DELETE `/account/{id}/live-sessions/{live_id}/category` | 取消校正 |

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

**播放（B站取流，C1+C2，devlog/289）**

| 方法 + 路径 | 说明 |
|---|---|
| GET `/bili/play/{post_id}?qn=&fallback=` | 取播放地址：**用户点播放才调**（地址短时效 + 绑 IP ⇒ 120s 短缓存、**不落库**）。`qn` = "想要哪档"（实际档看账号权益，响应里的 `quality` 才是真给的）；`fallback=true` ⇒ 换 `fnval=1` 取 **durl 单 mp4**（720P 封顶，DASH 播不动时用）。响应只给前端要用的 `{quality, accept[], dash:{video[],audio[]}, durl[], expires_in, kernel}`；**Cookie 只在请求头**。错误如实分级：帖子不存在 404 / 非 B站帖或缺 bvid 400 / 上游 `-404` 404、`-403` 403（充电专属等）、`-352` 429 |

**抓取 / 归档 / 候选池**

> ⚠️ **未登录闸门**（devlog/086）：下面带「内容接口」标记的端点在未登录时**直接 403**
> （`capabilities.content_fetch_allowed()`）—— 匿名打 B 站空间接口会被平台 `412 request
> was banned`（IP 级），所以"试了失败"不可接受。账号信息类与归档类**不挡**。

| 方法 + 路径 | 说明 |
|---|---|
| GET `/capabilities` | 本机能力矩阵：`features`（三态 `full`/`degraded`/`requires_login` + 用户说明 + 实测依据）/ `limited` / `wbi` / `measured_at`。前端据此**标注**受限功能而不是隐藏（devlog/086） |
| GET/POST `/vtuber/fetch` | 手动全量抓账号信息；自动档在跑时**抢占**，仅另一个手动任务在跑才 skipped |
| GET/POST `/vtuber/{id}/fetch` | 抓单个 V 账号信息（同样可抢占自动档） |
| POST `/vtuber/fetch-posts?name=&platform=&video_pages=&dynamics_pages=&full=` | 按名字抓帖子（-1 全量；`full=true` 后台执行）；**抓前先跑归档规则**。内容接口 → 未登录 **403** |
| POST `/vtuber/fetch-all-posts` | 全部账号全量抓（视频+动态）。内容接口 → 未登录 **403** |
| POST `/posts/archive?days=30` | 归档规则；幂等，返回 cutoff/unarchived_total。**纯本地，不需登录** |
| POST `/vtuber/update-posts?name=` | 更新未归档动态：先归档再抓动态，整页已归档即停。内容接口 → 未登录 **403** |
| GET `/vtuber/pool/search?kw=` | 本地候选检索（R11，devlog/083）：`vtubers.csv`（`origin='pool'`）+ `thirdparty_vtubers` 索引（`origin='index'`）两来源合并，按 `(platform, uid)` 去重（池优先）、剔除已入库 |
| GET `/vtuber/bili/search?kw=&page=` | **直接从 B 站检索**（池外收录通道，R11）：纯数字 ≥5 位 → `acc/info` + `relation/stat` 精确查；否则 `wbi/search/type` 模糊搜；结果带 `in_library`。⚠️ **路径是两段**：`/vtuber/bili-search` 会被先注册的 `/vtuber/{vtuber_id}` 吃掉 → 422 `int_parsing`。**未登录也能用**（匿名 WBI 签名，devlog/086；`acc/info` 可能被平台间歇风控 → `upstream_degraded`）。上游失败如实回 `error`+`hint`（`rate_limited` / `page_limit` / `upstream_degraded` / `network_error` / `not_found`）；预算：0.8s 串行 + 20 次/分 + 5 分钟缓存 + 最多 3 页 |
| POST `/vtuber/adopt` | 收录 V+账号。`source=None/'pool'` → 必须在候选池内，名称以池为准（池内无 404）；`source='bilibili'` → **池外通道**：platform 必须是 bilibili（否则 400）且**服务端自己打一次 `acc/info` 校验**（**客户端给的名字永不被信任**）：确实没这个人 → 404，**没问到**（未登录且拿不到密钥/网络/风控）→ **503** + 原因。已入库/并发冲突 409；成功后后台抓该 V + 回填历史（未登录时**首屏内容跳过**，账号信息与第三方历史照常） |
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

### 3.2 `app/routers/auth.py` — 登录（4：扫码 3 + 小红书粘贴 cookie 1）

| 方法 + 路径 | 说明 |
|---|---|
| POST `/auth/{platform}/qr/start` | 生成二维码会话。bilibili 返回 `{qr_id, url}`；weibo 返回 `{qr_id, image}`（data URL）。同平台旧会话作废 |
| GET `/auth/{platform}/qr/check?qr_id=` | 轮询状态机：`waiting / scanned / confirmed / expired / failed`；`confirmed` 时完成登录并持久化凭据；TTL 180s |
| GET `/auth/{platform}/status` | `{logged_in, needs_login, uid, name}`；B 站走内存维护结果，**微博做真实有效性探测**（结果缓存 60s），**小红书只报"配齐了没"**（另带 `configured/missing/note`；没有免签名的探活端点，不做探测） |
| POST `/auth/xiaohongshu/cookie` | **粘贴 cookie**（body `{"cookie": "a1=…; web_session=…"}`）。⚠️ 先校验再落盘：缺 `a1`/`web_session` ⇒ **400 且不写 `.env`**；成功回 `{status:"saved", ...status()}`（devlog/233） |

- 实现分发：bilibili → `app/services/auth.py`（SESSDATA 管理、心跳 + `refresh_token` 续期，
  `run_maintenance()` 由 lifespan 起协程）；weibo → `app/services/weibo_auth.py`（Session v2 扫码）；
  **xiaohongshu → `app/services/xhs_auth.py`**（粘贴 cookie，**不走 `qr/*`**：它连二维码接口都要签名）；
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

### 3.5 `app/routers/settings.py` — 应用设置与偏好（12，R14a/R14b devlog/091、092）

| 方法 + 路径 | 说明 |
|---|---|
| GET `/settings` | 规格表（`specs`：默认/范围/单位/生效时机/当前值/是否改过）+ `readonly`（只读项**逐条带理由**）+ `info`（版本/数据目录/库/端口/迁移 head/日志/PID） |
| PUT `/settings` | 部分更新：`{"values": {"KEY": 值}}`。白名单 + 类型 + 闭区间 + **跨字段**（上限 ≥ 下限）校验，任一不过 → **400**（detail 是中文原因，前端直接显示）；`null`/空串 = 删覆盖回默认。落库成功后才替换内存快照 |
| POST `/settings/reset` | 全部恢复默认（删掉 `app_meta` 里所有 `settings.*` 行） |
| GET `/settings/prefs` | 界面偏好（R14b：`theme`）+ 允许取值 + **当前能力说明**（"深色主题尚未实现…"由后端下发，界面不自己编） |
| PUT `/settings/prefs` | 偏好部分更新（枚举白名单在后端：`light|system`；`dark` 现在还写不进来 → 400）。存 `app_meta` 的 `prefs.` 命名空间；库里存了白名单外的值 → 记 warning 并按默认值处理（**不覆盖用户数据、不让窗口打不开**） |

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

## 2. 分层与错误语义

> 依赖方向与文件写入纪律**已是不变量**，不在此复述：
> 依赖方向只许向下 → `docs/backend/ARCHITECTURE.md` 不变量 33；
> 上传/替换文件的三条纪律 → `docs/backend/ASSETS.md` 不变量 34；
> 删除必须过 purge → `docs/backend/DATA-MODEL.md` 不变量 2 / 16。

- **409 语义**：唯一约束冲突（`IntegrityError`）统一 `rollback → 409`，覆盖 V / 账号 /
  帖子建改入口与并发收录竞态（这是本层独有的口径，别处不复述）。
