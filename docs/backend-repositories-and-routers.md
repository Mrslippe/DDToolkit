# DDtoolkit 数据库结构 · Repositories · Routers 文档

> 适用版本：**v0.5.0**（迁移链 head = `e001`，`MIGRATION_HEAD` 同步）
> 阅读路径：HTTP 入口（`app/routers`）→ SQL 封装（`app/repositories`）→ 表映射（`app/models`）→ 迁移（`alembic/versions`）。
> 会话依赖注入：`Depends(get_db)`（`app/core/database.py`）用毕自动 close；SQLite 连接时统一 PRAGMA：
> `journal_mode=WAL`（读写不互斥）、`busy_timeout=10000`（写锁等待而非抛错）、`synchronous=NORMAL`、`foreign_keys=ON`。

---

## 1. 数据库结构（SQLite，`vtuber.db`）

### 1.1 ER 总览

```
┌─────────────┐ 1      N ┌──────────────┐ 1      N ┌────────────────────────┐
│   vtubers   │──────────│   accounts   │──────────│ account_stat_snapshots │
│ (VTuber本体) │ 级联删除   │ (平台账号)     │ 无级联(手工) │ (统计快照历史, P0)        │
└─────────────┘          └──────────────┘          └────────────────────────┘
                                   │
                        posts 独立表，无外键
                        （联合投稿在每个 V 的账号下各存一份；
                          删除需显式按 platform+platform_uid 清理）
```

- `vtubers 1—N accounts`：`cascade="all, delete-orphan"`，删 V 连带删账号；
- `accounts 1—N account_stat_snapshots`：外键存在但**不级联**，快照是历史证据不随账号删除；
- `posts`：**无外键**，靠 `(platform, platform_uid, platform_post_id)` 唯一约束去重。

### 1.2 表定义

#### `vtubers` — VTuber 本体（平台无关）

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK，索引 `ix_vtubers_id` |
| `name` | TEXT | NOT NULL，索引 `ix_vtubers_name` |
| `faction` | TEXT | 阵营（手动维护，d001） |
| `birthday` | TEXT | MM-DD |
| `debut_date` | TEXT | YYYY-MM-DD 或仅 YYYY |
| `setting` | TEXT | 角色设定 |
| `avatar` | TEXT | 默认头像 URL |
| `background_path` | TEXT | 卡片页自定义背景，`static/custom_bg/` 相对路径（d002） |
| `notes` | TEXT | 备注 |
| `created_at` / `updated_at` | DATETIME | 默认/更新时取 UTC now |

#### `accounts` — 各平台账号

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK，索引 `ix_accounts_id` |
| `vtuber_id` | INTEGER | NOT NULL，FK → vtubers.id；索引 `ix_accounts_vtuber_id`（d001，覆盖 by_vtuber 查询） |
| `platform` | TEXT | NOT NULL：bilibili / youtube / twitter … |
| `platform_uid` | TEXT | NOT NULL；与 platform 组成 **UNIQUE `uq_account_platform_uid`** |
| `display_name` / `avatar_url` / `avatar_path` | TEXT | 平台昵称 / 平台头像 URL / 本地缓存相对路径 |
| `sign` / `url` | TEXT | 签名 / 主页链接 |
| `followers_count` | INTEGER | 默认 0；**每次抓取覆盖，历史在快照表** |
| `room_id` | TEXT | 直播间 ID |
| `live_status` | INTEGER | 默认 0：0=离线 1=直播中 |
| `live_title` / `live_url` | TEXT | 开播标题 / 直播间链接 |
| `last_fetched_at` | DATETIME | 最近一次抓取成功时间 |

#### `posts` — 动态 / 投稿 / 直播记录

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK，索引 `ix_posts_id` |
| `platform` | TEXT | NOT NULL，索引 `ix_posts_platform` |
| `platform_uid` | TEXT | NOT NULL，索引 `ix_posts_platform_uid` |
| `platform_post_id` | TEXT | NOT NULL；与 platform+platform_uid 组成 **UNIQUE `uq_post_platform_uid_pid`**（c002，替代旧的 (platform, post_id)） |
| `type` | TEXT | NOT NULL 默认 `text`：video / video_dynamic / image / article / text / repost / live / music |
| `title` / `summary` | TEXT | 标题 / 前 200 字摘要（列表展示与搜索用） |
| `cover_url` / `permalink` | TEXT | 封面 / 原文链接 |
| `body_json` | TEXT | 结构化类型差异数据 |
| `stats_json` | TEXT | `{"view":N,"like":N,"comment":N,"forward":N}` |
| `published_at` | DATETIME | 发布时间（naive UTC，见 §1.4） |
| `raw_json` | TEXT | 平台原始响应（证据保真层，可回填） |
| `is_archived` | BOOLEAN | 默认 0（c001）；归档后不参与更新抓取遍历 |
| `created_at` | DATETIME | 入库时间 |

热路径索引（d001）：`ix_posts_platform_uid_published (platform, platform_uid, published_at)` — 覆盖分页查询；
`ix_posts_published_at` — 覆盖归档规则（`is_archived=0 AND published_at < cutoff`）。

#### `account_stat_snapshots` — 账号统计快照历史（P0，e001）

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK |
| `account_id` | INTEGER | NOT NULL，FK → accounts.id；索引 `ix_account_stat_snapshots_account_id` |
| `followers_count` | INTEGER | 抓取后的最新粉丝数 |
| `live_status` | INTEGER | 顺手记录：0=离线 1=直播中 |
| `live_title` | TEXT | 开播标题快照（可还原"某天开播放了什么"） |
| `captured_at` | DATETIME | NOT NULL，抓取时刻；索引 `ix_account_stat_snapshots_captured_at` |

**写入策略（v0.5.0 定案）**：简单优先，**全量记录**——账号信息抓取成功后追加一行（全量/单 V 共用挂点
`scheduler._record_stat_snapshot`，随事务提交），数值无变化不降噪。本期只采集入库，不做可视化。

### 1.3 迁移链（alembic）

| 版本 | 内容 |
|---|---|
| `a001` init_v2 | 建 `vtubers` + `accounts`（含账号唯一约束） |
| `b001` posts_v2 | 建 `posts`（含 (platform, platform_post_id) 唯一约束） |
| `c001` post_archived | `posts.is_archived` 列 |
| `c002` posts_per_uid_dedup | 唯一约束改为 (platform, platform_uid, platform_post_id) |
| `d001` columns_and_indexes | `vtubers.faction` + 三个热路径索引（分页/归档/by_vtuber） |
| `d002` vtuber_background | `vtubers.background_path` |
| `e001` account_stat_snapshots | 建 `account_stat_snapshots` + 两索引 |

**纪律**：新增迁移后必须同步 `app/main.py` 的 `MIGRATION_HEAD`（tests 断言与 alembic head 一致），
否则冷启动快路径会把旧库误判为已最新。启动迁移四形态：全新库 `upgrade head` /
create_all 旧库补列补索引后 stamp / 版本落后增量升级 / 已最新零开销返回。

### 1.4 存储约定

- **时区**：库内 datetime 一律 **naive UTC**（SQLite 存储抹掉 tz）；路由层比较参数须同为 naive；
  `PostOut`/`AccountStatSnapshotOut` 序列化时补 `+00:00`，避免前端按本地时区解析偏移 8 小时。
- **头像/背景文件**：存 `static/` 相对路径（`avatar_path`、`background_path`），随 `DDTOOLKIT_DATA_DIR` 走；
  `static/img-cache/` 为图片代理磁盘缓存，可随时重建。

---

## 2. Repositories（`app/repositories/vtuber_repo.py`）

构造注入会话：`Repo(db)`。CRUD 惯例：`create` 用 `model_dump()` 展开；`update` 逐个 `setattr`；
`get` 返回 `None` 表示不存在；写操作均当场 `commit`（`PostRepo.create(commit=False)` 例外，供批量入库）。

### 2.1 `VTuberRepo` — VTuber 本体

| 方法 | 签名 | 语义 |
|---|---|---|
| `all` | `() -> list[VTuber]` | 全部 VTuber，`joinedload(accounts)` 预取账号 |
| `get` | `(id) -> VTuber \| None` | 按主键取（带 accounts 预取） |
| `create` | `(data: dict) -> VTuber` | 插入 + commit + refresh |
| `update` | `(id, data) -> VTuber \| None` | 部分字段更新；不存在返回 `None` |
| `delete` | `(id) -> bool` | 删除；accounts 级联（`delete-orphan`） |

### 2.2 `AccountRepo` — 平台账号

| 方法 | 签名 | 语义 |
|---|---|---|
| `by_vtuber` | `(vtuber_id) -> list[Account]` | 某 V 的全部账号 |
| `get` | `(id) -> Account \| None` | 按主键取 |
| `create` | `(vtuber_id, data) -> Account` | 归属父 V 创建 |
| `update` | `(id, data) -> Account \| None` | 部分更新 |
| `delete` | `(id) -> bool` | 删除 |
| `all_for_fetch` | `(platform=None) -> list[Account]` | 可抓取账号（`platform_uid` 非空），可按平台过滤 |

### 2.3 `PostRepo` — 帖子

| 方法 | 签名 | 语义 |
|---|---|---|
| `by_uid` | `(platform, platform_uid) -> list[Post]` | 该账号全部帖子，`published_at` 倒序（旧接口，兼容保留） |
| `paginated` | `(platform, platform_uid, page=1, page_size=50, post_type=None, is_archived=None, q=None, date_from=None, date_to=None) -> (total, items)` | 服务端分页 + 过滤，语义见下 |
| `stats` | `(platform, platform_uid) -> dict` | 总数 / 归档数 / 类型分布 / 最早最晚时间 |
| `archive_before` | `(cutoff) -> int` | 归档规则：`is_archived=0 且 published_at<cutoff` → 置 1，幂等，返回条数 |
| `get` / `update` / `delete` | `(id, ...)` | 标准 CRUD；不存在返回 `None`/`False` |
| `create` | `(data, commit=True) -> Post` | `commit=False` 仅 `add`（scheduler 批量入库用） |
| `delete_by_platform_uids` | `(list[(platform, platform_uid)]) -> int` | 按「平台+UID」组清空帖子（解订阅/删账号用；修复跨平台同 UID 误删） |

**`paginated` 过滤语义**：
- `q`：`title`/`summary` 的 `ilike` 模糊匹配，OR 语义，默认去空白；
- `date_from`/`date_to`：`published_at` 范围（路由层换算 naive UTC，`date_to` 为次日零点排他 → 含结束日全天）；设范围时 `published_at` 为空的帖子被排除；
- `post_type`：逗号分隔多型（如 `video,video_dynamic`），单值天然兼容；
- 排序恒为 `published_at desc`，命中复合索引 `ix_posts_platform_uid_published`。

### 2.4 `AccountStatSnapshotRepo` — 统计快照（P0）

| 方法 | 签名 | 语义 |
|---|---|---|
| `add` | `(account_id, followers_count, live_status=None, live_title=None, captured_at=None)` | 追加一行（不 commit，随调用方事务落盘） |
| `recent` | `(account_id, limit=100) -> list[AccountStatSnapshot]` | 按 `captured_at` 倒序取最近 N 条 |

---

## 3. Routers

### 3.1 `app/routers/vtuber.py` — 主业务路由

前缀无统一 `vtuber`，路径直接 `/vtuber/...`、`/account/...`、`/posts...`、`/post/...`；响应模型走
`app/schemas/vtuber.py`（`Out` 为 `from_attributes` 转 dict）。

> **冷启动优化**：scheduler 依赖链（apscheduler/tenacity/httpx/fetcher）较重，路由内不直接 import，
> 经 `_sched()` 缓存包装首次调用才导入；测试 monkeypatch 本模块属性即可替换。

| 方法 + 路径 | 说明 |
|---|---|
| GET `/vtuber/list` | 全部 VTuber（含 accounts） |
| GET `/vtuber/fetch-status` | 抓取实时状态（TopBar 轮询）：account 跑动/当前/总数 + recent 增量快照，post 跑动/目标 |
| GET `/vtuber/{vtuber_id}` | 单 V；不存在 404 |
| POST `/vtuber` | 建 V；唯一约束冲突 409 |
| PUT `/vtuber/{vtuber_id}` | 部分更新；404 |
| POST `/vtuber/{vtuber_id}/background` | 上传自定义背景（jpeg/png/webp/gif，≤10MB，否则 415/413）；时间戳后缀防缓存，替换删旧文件 |
| DELETE `/vtuber/{vtuber_id}/background` | 清除背景回退头像铺底 |
| DELETE `/vtuber/{vtuber_id}` | 解除订阅：先按账号清 posts，再级联删 V+accounts（避免孤儿数据） |
| GET `/vtuber/{id}/accounts` | 某 V 的账号列表 |
| POST `/vtuber/{id}/accounts` | 建账号；(platform, platform_uid) 重复 409 |
| PUT `/account/{account_id}` | 更新账号；唯一冲突 409 |
| DELETE `/account/{account_id}` | 删账号并同步清理其帖子 |
| GET `/account/{account_id}/stat-snapshots?limit=` | **P0**：统计快照历史（默认 100，上限 1000，时间倒序，UTC 补时区） |
| GET `/posts/{platform}/{platform_uid}` | 某账号全部帖子（旧接口） |
| GET `/posts/{platform}/{platform_uid}/paginated` | 服务端分页；`type`/`is_archived`/`q`/`date_from`/`date_to`（`page_size` 1-200） |
| GET `/posts/{platform}/{platform_uid}/stats` | 帖子统计概览 |
| POST `/posts` | 建帖；三元组重复 409 |
| PUT `/post/{post_id}` / DELETE `/post/{post_id}` | 更帖 / 删帖；404 |
| GET/POST `/vtuber/fetch` | 手动全量抓取账号信息；跑动中返回 skipped |
| GET/POST `/vtuber/{vtuber_id}/fetch` | 抓单个 V 账号信息；与全局互斥 |
| POST `/vtuber/fetch-posts?name=&platform=&video_pages=&dynamics_pages=&full=` | 按名字抓帖子（-1 全量；`full=true` 后台执行）；**抓前先跑归档规则** |
| POST `/vtuber/fetch-all-posts` | 全部 bilibili 账号全量抓（视频+动态） |
| POST `/posts/archive?days=30` | 归档规则：早于 days 天 → `is_archived=1`；幂等，返回 cutoff/unarchived_total |
| POST `/vtuber/update-posts?name=` | 更新未归档动态：先归档旧帖再抓动态，整页已归档即停（name 省略 → 全部） |
| GET `/vtuber/pool/search?kw=` | 候选池检索（csv 离线索引），自动剔除已入库账号 |
| POST `/vtuber/adopt` | 从候选池收录 V+账号（名称以池为准）；池内无 404、已入库/并发冲突 409；成功后 `BackgroundTasks` 异步抓该 V |
| POST `/vtuber/fetch-accounts` | 批量：后台抓全部账号信息，立即返回；跑动中 409 |
| POST `/vtuber/batch/fetch-all-posts` | 批量：后台全量抓帖子；跑动中 409 |
| POST `/vtuber/batch/update-unarchived` | 批量：后台更新未归档；跑动中 409 |
| POST `/vtuber/batch/archive?days=30` | 批量归档，同步执行 |

**关键调用点**：
- `/adopt` 为同步端点（线程池执行），后台抓取必须走 `BackgroundTasks`——直接 `asyncio.create_task`
  会因工作线程无事件循环抛 `RuntimeError`（"数据已入库但响应 500"双重故障，v0.5 实测）；
- 路由顺序约束：`/vtuber/fetch-status` 必须注册在 `/vtuber/{vtuber_id}` **之前**（否则被 int 路径参数捕获并 422）；
- 抓取类端点前置检查 `any_fetch_running()`（账号/帖子任一在跑或定时任务请求让位 → 忙）。

### 3.2 `app/routers/auth.py` — 扫码登录（B 站 / 微博共用流程）

| 方法 + 路径 | 说明 |
|---|---|
| POST `/auth/{platform}/qr/start` | 生成二维码会话。bilibili 返回 `{qr_id, url}`；weibo 返回 `{qr_id, image}`（data URL）。同平台旧会话作废 |
| GET `/auth/{platform}/qr/check?qr_id=` | 轮询状态机：`waiting / scanned / confirmed / expired / failed`；`confirmed` 时完成登录并持久化凭据（Cookie 写入 `.env`）；TTL 180s |
| GET `/auth/{platform}/status` | `{logged_in, needs_login, uid, name}`。B 站走内存维护结果；**微博做真实有效性探测**（`weibo.com/ajax/profile/info`，结果缓存 60s）——Cookie 过期不能仅凭存在性报已登录，否则 UI 不出现重新扫码入口（2026-09 修复） |

- 实现分发：bilibili → `app/services/auth.py`（SESSDATA/BILI_JCT 管理、失效续期），weibo → `app/services/weibo_auth.py`（Session v2 扫码）；
- 凭据持久化经 `app/services/env_store.py`（读改写 `.env`，临时文件 + 原子替换）；
- 新增平台只需在 `_PLATFORMS` 注册 + 提供 begin_login 实现（见 `docs/platforms-extension-guide.md`）。

### 3.3 `app/routers/img_proxy.py` — 图片代理（兜底链路）

| 方法 + 路径 | 说明 |
|---|---|
| GET `/img-proxy?url=` | 转发远端图片；磁盘缓存命中直接回，回源失败 502 |

**安全（防 SSRF + 存储型 XSS）**：
- 仅 http/https；主机匹配 `IMG_PROXY_ALLOWED_HOSTS`（默认 `hdslb.com,sinaimg.cn,wbcdn.cn`）；
- `follow_redirects=False` 逐跳重新校验主机（302 跳内网直接拒绝），最多 3 跳；
- 限响应 10MB；`content-type` 仅允许图片/octet-stream（拒绝 html 等）；
- **防盗链**：按主机动态带 Referer（sinaimg/wbcdn → `https://weibo.com/`，hdslb → bilibili）——否则微博图床 403。

**性能**：磁盘缓存 `static/img-cache/{md5}.bin + .json`（TTL 7 天，原子写入，过期 2×TTL 清理）；
模块级共享 `httpx.AsyncClient`（lifespan 关闭时 `close_client()` 释放）；httpx 延迟导入。

---

## 4. 分层注意点

- **posts 无外键**：V/账号删除必须显式经 `PostRepo.delete_by_platform_uids` 清理，已在 DELETE 路由实现（带条数日志）；
- **409 语义**：唯一约束冲突（`IntegrityError`）统一 `rollback → 409`，覆盖 V/账号/帖子建改入口与并发收录竞态；
- **时区**：库内 naive UTC；比较参数须同为 naive；输出模型补 `+00:00`；
- **归档边界剪枝**：抓取任务前置 `archive_old_posts`，已归档条目不再产生任何网络请求（v0.4.7 提速来源）；
- **迁移链纪律**：新迁移必须同步 `MIGRATION_HEAD`（tests 断言）；快路径依赖版本号判断，勿漏 bump；
- **P0 快照**：写入挂点 `scheduler._record_stat_snapshot`（全量/单 V 共用），全量记录、随事务提交。
