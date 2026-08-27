# 后端数据访问层（Repositories）与路由层（Routers）文档

> 结构：`app/routers`（HTTP 入口，参数/状态码/响应模型）→ `app/repositories`（SQL 封装，事务/查询语义）→ `app/models`（SQLAlchemy 表映射）。
> 依赖注入：`Depends(get_db)` 经 `app/core/database.py` 提供会话，`get_db` 用毕自动 close；SQLite 已开 WAL + busy_timeout=10s + synchronous=NORMAL + foreign_keys=ON（连接时 PRAGMA）。

---

## 1. Repositories（`app/repositories/vtuber_repo.py`）

每类以会话为构造注入：`Repo(db)` 写法，`db` 即 `Session`。CRUD 惯例：`create` 空 `model_dump()` 展开建对象；`update` 逐个 `setattr`；`get` 返回 `None` 表示不存在；写操作均当场 `commit`。

### 1.1 `VTuberRepo` — VTuber 本体（平台无关）

| 方法 | 签名 | 语义 |
|---|---|---|
| `all` | `() -> list[VTuber]` | 全部 VTuber，`joinedload(accounts)` 预取账号 |
| `get` | `(id) -> VTuber \| None` | 按主键取（带 accounts 预取） |
| `create` | `(data: dict) -> VTuber` | 插入 + commit + refresh |
| `update` | `(id, data) -> VTuber \| None` | 部分字段更新；不存在返回 `None` |
| `delete` | `(id) -> bool` | 删除；accounts 由 `cascade="all, delete-orphan"` 级联 |

### 1.2 `AccountRepo` — 各平台账号

| 方法 | 签名 | 语义 |
|---|---|---|
| `by_vtuber` | `(vtuber_id) -> list[Account]` | 某 V 的全部账号 |
| `get` | `(id) -> Account \| None` | 按主键取 |
| `create` | `(vtuber_id, data) -> Account` | 归属父 V 创建 |
| `update` | `(id, data) -> Account \| None` | 部分更新 |
| `delete` | `(id) -> bool` | 删除 |
| `all_for_fetch` | `(platform=None) -> list[Account]` | 可抓取账号（`platform_uid` 非空），可按平台过滤 |

### 1.3 `PostRepo` — 帖子（独立于 account，无外键）

| 方法 | 签名 | 语义 |
|---|---|---|
| `by_uid` | `(platform, platform_uid) -> list[Post]` | 该账号全部帖子，`published_at` 倒序（旧接口） |
| `paginated` | `(platform, platform_uid, page=1, page_size=50, post_type=None, is_archived=None, q=None, date_from=None, date_to=None) -> (total, items)` | 服务端分页 + 过滤。说明见 §1.4 |
| `stats` | `(platform, platform_uid) -> dict` | 总数/归档数/类型分布/最早最晚时间 |
| `archive_before` | `(cutoff) -> int` | 归档规则：`is_archived=0 且 published_at<cutoff` → 置 1，幂等，返回条数 |
| `get` / `create` / `update` / `delete` | — | 标准 CRUD |
| `create` | `(data, commit=True)` | `commit=False` 仅 `add`，供批量入库（scheduler `_fetch_posts_core`） |
| `delete_by_platform_uids` | `(list[(platform, platform_uid)]) -> int` | 按「平台+UID」组清空帖子（解订阅/删账号用） |

**§1.4 `paginated` 过滤语义**
- `q`：`title` / `summary` 的 `ilike` 模糊匹配，OR 语义，默认去空白；
- `date_from`/`date_to`：`published_at` 范围。路由层将日期换算为 naive UTC datetime（`date_to` 为次日零点排他 → 含结束日全天）；设范围时 `published_at` 为空的帖子被排除；
- `is_archived`/`post_type`：等值过滤；
- 排序恒为 `published_at desc`；已加复合索引 `ix_posts_platform_uid_published (platform, platform_uid, published_at)`，与归档查询的 `ix_posts_published_at`。

---

## 2. Routers

### 2.1 `app/routers/vtuber.py` — 主业务路由

前缀无统一 `vtuber` 前缀，路径直接 `/vtuber/...`、`/account/...`、`/posts...`、`/post/...`。响应模型统一走 `app/schemas/vtuber.py`（`Out` 为 `from_attributes` 转 dict）。

**前置说明 — 延迟导入（冷启动优化）**：`scheduler` 依赖链（apscheduler/tenacity/httpx/fetcher）较重，路由内不直接 `import scheduler`，而是 `_sched()` 缓存包装 → 首次调用才导入。测试 monkeypatch `setattr` 本模块属性即可替换。

| 方法 + 路径 | 说明 |
|---|---|
| GET `/vtuber/list` | 全部 VTuber（含 accounts） |
| GET `/vtuber/fetch-status` | 抓取实时状态（TopBar 轮询）：account 跑动/当前/总数，post 跑动/目标 |
| GET `/vtuber/{vtuber_id}` | 单 V；不存在 404 |
| POST `/vtuber` | 建 V；唯一约束冲突 409 |
| PUT `/vtuber/{vtuber_id}` | 部分更新；不存在 404 |
| DELETE `/vtuber/{vtuber_id}` | 解除订阅：先按账号清 posts，再级联删 V+accounts（避免 posts 孤儿数据） |
| GET `/vtuber/{id}/accounts` | 某 V 的账号列表 |
| POST `/vtuber/{id}/accounts` | 建账号；(platform, platform_uid) 重复 409 |
| PUT `/account/{account_id}` | 更新账号；唯一冲突 409 |
| DELETE `/account/{account_id}` | 删账号并同步清理其帖子 |
| GET `/posts/{platform}/{platform_uid}` | 某账号全部帖子（旧接口） |
| GET `/posts/{platform}/{platform_uid}/paginated` | 服务端分页；`type`/`is_archived`/`q`/`date_from`/`date_to` 过滤（`page_size` 1-200） |
| GET `/posts/{platform}/{platform_uid}/stats` | 帖子统计概览 |
| POST `/posts` | 建帖；(platform, platform_uid, platform_post_id) 重复 409 |
| PUT `/post/{post_id}` | 更帖；404 |
| DELETE `/post/{post_id}` | 删帖；404 |
| GET/POST `/vtuber/fetch` | 手动全量抓取账号信息；跑动中返回 skipped |
| GET/POST `/vtuber/{id}/fetch` | 抓单个 V 账号信息；互斥全局抓取 |
| POST `/vtuber/fetch-posts` | 按名字抓帖子；`video_pages`/`dynamics_pages`（-1 全量）；抓前先跑归档规则 |
| POST `/vtuber/fetch-all-posts` | 全部 bilibili 账号全量抓（视频+动态） |
| POST `/posts/archive?days=30` | 归档规则：早于 days 天 → `is_archived=1`；幂等 |
| POST `/vtuber/update-posts?name=` | 更新未归档动态：先归档旧帖再抓动态，整页已归档即停（name 省略 → 全部） |
| GET `/vtuber/pool/search?kw=` | 候选池检索（csv 离线索引），自动剔除已入库账号 |
| POST `/vtuber/adopt` | 从候选池收录 V+账号；池内不存在 404、已入库/并发冲突 409；成功后 `BackgroundTasks` 异步抓该 V 账号信息 |
| POST `/vtuber/fetch-accounts` | 批量：后台抓全部账号信息，立即返回；跑动中 409 |
| POST `/vtuber/batch/fetch-all-posts` | 批量：后台全量抓帖子；跑动中 409 |
| POST `/vtuber/batch/update-unarchived` | 批量：后台更新未归档；跑动中 409 |
| POST `/vtuber/batch/archive?days=30` | 批量归档 |

**关键调用点**
- `/adopt` 为同步端点（线程池执行），后台抓取必须走 `BackgroundTasks`（`background.add_task(_fetch_adopted, id)`）——直接 `asyncio.create_task` 会因工作线程无事件循环抛 `RuntimeError`。
- 路由顺序约束：`/vtuber/fetch-status` 必须注册在 `/vtuber/{vtuber_id}` **之前**（否则被 int 路径参数捕获并 422）。

### 2.2 `app/routers/img_proxy.py` — 图片代理（兜底链路）

前端图片直连 CDN 失败（防盗链/协议/失效）时自动重试经本端点转发；服务器侧请求不带浏览器 Referer，可自由设请求头。

| 方法 + 路径 | 说明 |
|---|---|
| GET `/img-proxy?url=` | 转发远端图片。磁盘缓存命中直接回，回源失败 502 |

**安全约束（防 SSRF）**
- 仅 http/https；主机必须匹配 `IMG_PROXY_ALLOWED_HOSTS`（默认 `hdslb.com` 后缀，或精确相等）；
- `follow_redirects=False`，逐跳重新校验主机（302 跳内网直接拒绝），最多跟随 3 跳；
- 限响应大小 10MB、`content-type` 仅允许图片/octet-stream（拒绝 html 等 → 防存储型 XSS 回吐）。

**性能**
- 磁盘缓存 `static/img-cache/{md5}.bin + .json`，TTL 7 天，原子写入（临时文件 + `os.replace`）；
- 过期清理按 `_CLEANUP_INTERVAL`（1h）节流；
- 模块级共享 `httpx.AsyncClient` 连接池（`close_client()` 在 lifespan 关闭时释放）；
- httpx 延迟导入（路由模块加载不触发 httpx 导入）。

---

## 3. 分层注意点

- **posts 无外键**：V/账号删除需显式经 `PostRepo.delete_by_platform_uids` 清理，已在 DELETE 路由实现（带条数日志）。
- **409 语义**：唯一约束冲突（`IntegrityError`）统一 `rollback → 409`，覆盖 V/账号/帖子三个建改入口与并发收录竞态。
- **日期时区**：库内 `published_at` 为 naive UTC（SQLite 存储抹掉 tz）；比较参数须同为 naive；`PostOut` 序列化时补 `+00:00` 避免前端按本地时区偏移 8 小时。
- **归档边界剪枝**：抓取任务前置跑 `archive_old_posts`，使已归档条目不再产生任何网络请求（v0.4.7 提速来源）。