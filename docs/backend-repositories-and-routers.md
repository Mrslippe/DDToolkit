# 数据层与接口层文档（数据库 · Repositories · Routers）

> 适用版本：`main`（2026-09-09，`MIGRATION_HEAD = e007`，迁移链 13 个版本、9 张表、47 个端点）。
> 阅读路径：HTTP 入口（`app/routers`）→ SQL 封装（`app/repositories`）→ 表映射（`app/models`）→ 迁移（`alembic/versions`）。
> 系统全貌见 `docs/ARCHITECTURE.md`；抓取链路细节见 `docs/backend-fetch-pipeline.md`；
> 名词与代码路径速查见 `docs/GLOSSARY.md`；文档索引见 `docs/README.md`。
> 会话注入：`Depends(get_db)`（`app/core/database.py`）用毕自动 close；每个 SQLite 连接统一 PRAGMA：
> `journal_mode=WAL`（读写不互斥）、`busy_timeout=30000`（写锁等待而非抛错）、`synchronous=NORMAL`、**`foreign_keys=ON`**。

---

## 1. 数据库结构（SQLite，`vtuber.db`）

### 1.1 ER 总览

```
                        ┌─────────────┐
                        │  vtubers    │  主播本体（平台无关）
                        └──────┬──────┘
                    级联删除（ORM delete-orphan）
                               │ 1:N
                        ┌──────▼──────┐
        ┌───────────────┤  accounts   ├───────────────┐
        │               └──────┬──────┘               │
        │ 1:N（不级联，外键在）   │ 逻辑关联（无外键）      │
        │                      │  platform+platform_uid │
  ┌─────▼─────┐ ┌────────────┐ │                ┌───────▼──────┐
  │account_   │ │live_       │ │                │   posts      │
  │stat_snap- │ │sessions    │ │                │（独立表，联合  │
  │shots      │ ├────────────┤ │                │投稿每 V 各一份）│
  ├───────────┤ │live_gift_  │ │                └──────────────┘
  │（粉丝/直播  │ │days        │ │
  │状态时序）   │ ├────────────┤ │                ┌──────────────┐
  └───────────┘ │live_categ- │ │                │thirdparty_   │
                │ory_overr-  │ │                │vtubers       │
                │ides        │ │                │（候选索引，无 FK）│
                └────────────┘ │                └──────────────┘
                               │ 1:N（不级联）
                        ┌──────▼──────┐
                        │vtuber_events│  纪念日 / 活动（手动维护）
                        └─────────────┘
```

（带箭头的 mermaid 版见 `docs/ARCHITECTURE.md` §2.1。）

**外键与级联规则（重要）**：

| 关系 | 约束 | 删除行为 |
|---|---|---|
| `vtubers 1—N accounts` | FK + `cascade="all, delete-orphan"` | 删 V 连带删账号 |
| `accounts 1—N account_stat_snapshots` | FK，无 ORM 级联 | **不自动删**，需显式清理 |
| `accounts 1—N live_sessions` | FK，无 ORM 级联 | 同上（一个账号可上千条） |
| `accounts 1—N live_gift_days` | FK，无 ORM 级联 | 同上 |
| `accounts 1—N live_category_overrides` | FK，无 ORM 级联 | 同上 |
| `vtubers 1—N vtuber_events` | FK，无 ORM 级联 | 同上 |
| `posts` ↔ `accounts` | **无外键**（`platform + platform_uid` 逻辑关联） | 需按平台+UID 显式清 |
| `thirdparty_vtubers` | 无外键 | 独立，随源整表刷新 |

> 因为 `foreign_keys=ON`，**删 V / 删账号必须走 `app/services/purge.py`**：
> 帖子按 `(platform, platform_uid)`、4 张子表按 `account_id`、活动条目按 `vtuber_id`。
> 漏清任何一张 → `DELETE FROM accounts` 被外键挡下 → 整次事务回滚（v0.9.3 修复的
> 「解除订阅失败」事故，见 devlog/040）。

### 1.2 表定义

#### `vtubers` — 主播本体（平台无关）

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK |
| `name` | TEXT | NOT NULL，索引 `ix_vtubers_name` |
| `faction` | TEXT | 阵营（手动维护，d001） |
| `birthday` | TEXT | MM-DD |
| `debut_date` | TEXT | YYYY-MM-DD 或仅 YYYY |
| `setting` | TEXT | 角色设定 |
| `avatar` | TEXT | 默认头像 URL |
| `background_path` | TEXT | 卡片页自定义背景，`static/custom_bg/` 相对路径（d002） |
| `notes` | TEXT | 备注 |
| `created_at` / `updated_at` | DATETIME | UTC now |

#### `accounts` — 各平台账号

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK |
| `vtuber_id` | INTEGER | NOT NULL，FK → vtubers.id；索引 `ix_accounts_vtuber_id` |
| `platform` | TEXT | NOT NULL：bilibili / weibo / … |
| `platform_uid` | TEXT | NOT NULL；与 platform 组成 **UNIQUE `uq_account_platform_uid`** |
| `display_name` / `avatar_url` / `avatar_path` | TEXT | 平台昵称 / 头像 URL / 本地缓存相对路径 |
| `sign` / `url` | TEXT | 签名 / 主页链接 |
| `followers_count` | INTEGER | 默认 0；**每次抓取覆盖，历史在快照表** |
| `room_id` | TEXT | 直播间 ID |
| `live_status` | INTEGER | 0=离线 1=直播中 |
| `live_title` / `live_url` | TEXT | 开播标题 / 直播间链接 |
| `last_fetched_at` | DATETIME | 最近一次账号抓取成功时间 |
| `posts_last_scan_at` | DATETIME | 帖子扫描上一轮完成时间（墓碑判定的比较基准，e002） |

#### `posts` — 动态 / 投稿 / 专栏 / 转发 / 音乐

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK |
| `platform` / `platform_uid` / `platform_post_id` | TEXT | 三元组 **UNIQUE `uq_post_platform_uid_pid`**（c002） |
| `type` | TEXT | video / video_dynamic / image / article / text / repost / music（live 卡片转存 live_sessions 后不入表） |
| `title` / `summary` | TEXT | 标题 / 前 200 字摘要 |
| `body_text` | TEXT | 正文纯文本（P2 全文搜索，e003） |
| `cover_url` / `permalink` | TEXT | 封面 / 原文链接 |
| `body_json` | TEXT | 结构化类型差异数据（图片/视频/预约/富文本 Delta…） |
| `stats_json` | TEXT | `{"view":N,"like":N,"comment":N,"forward":N}` |
| `published_at` | DATETIME | 发布时间（naive UTC） |
| `raw_json` | TEXT | 平台原始响应（证据保真层） |
| `is_archived` | BOOLEAN | 默认 0（c001）；归档后不参与更新抓取遍历 |
| `last_seen_at` | DATETIME | 最近一次确认仍在线（墓碑，e002） |
| `deleted_detected_at` | DATETIME | 判定已删除的时刻（墓碑，e002） |
| `created_at` | DATETIME | 入库时间 |

索引：`ix_posts_platform_uid_published (platform, platform_uid, published_at)` 覆盖分页；
`ix_posts_published_at` 覆盖归档规则；`ix_posts_deleted_detected` 覆盖墓碑筛选。

#### `account_stat_snapshots` — 账号统计快照历史（P0，e001；e004 加 `source`）

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK |
| `account_id` | INTEGER | NOT NULL，FK → accounts.id；索引 `ix_account_stat_snapshots_account_id` |
| `followers_count` | INTEGER | 抓取后的最新粉丝数 |
| `live_status` | INTEGER | 顺手记录：0=离线 1=直播中 |
| `live_title` | TEXT | 开播标题快照 |
| `captured_at` | DATETIME | NOT NULL，抓取时刻；索引 `ix_account_stat_snapshots_captured_at` |
| `source` | TEXT | `self`（本工具直采）/ `zeroroku`（第三方回填） |

**写入策略**：账号抓取成功后追加一行（全量/单 V/T0 直播跳变共用挂点
`scheduler._record_stat_snapshot`，随事务提交），全量记录不降噪。

#### `live_sessions` — 直播场次（e006）

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK |
| `account_id` | INTEGER | NOT NULL，FK → accounts.id |
| `platform` / `source` | TEXT | `danmakus`（第三方历史/同步）/ `feed`（B 站动态直播卡片） |
| `live_id` | TEXT | 平台级场次 key；**UNIQUE(account_id, live_id)** |
| `title` / `room_id` / `cover_url` | TEXT | 标题 / 房间 / 封面 |
| `start_at` / `end_at` | DATETIME | 起止（`end_at` 由快照或次日 danmakus 补全） |
| `parent_area_name` / `area_name` | TEXT | 分区 |
| `total_income` | FLOAT | danmakus 收益（元） |
| `max_online_count` / `danmakus_count` | INTEGER | 峰值人气 / 弹幕数 |
| `raw_json` | TEXT | 原始场次数据保真 |
| `created_at` / `updated_at` | DATETIME | UTC now |

索引：`ix_live_sessions_account_start (account_id, start_at)`。
**self 快照推导的虚拟场次不落表**，读取时由 `LiveSessionRepo.merged()` 合并。

#### `live_gift_days` — 礼物 / 大航海 / SC 日聚合（e004）

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK |
| `account_id` | INTEGER | NOT NULL，FK → accounts.id |
| `source` | TEXT | 默认 `zeroroku` |
| `gift_date` | TEXT | `YYYY-MM-DD`；**UNIQUE(account_id, source, gift_date)** |
| `gift_amount` / `guard_amount` / `sc_amount` / `total_amount` | TEXT | 金额保字符串精度（站点返回 `"1234.500"`） |
| `room_id` | TEXT | 房间 |
| `created_at` | DATETIME | UTC now |

#### `live_category_overrides` — 直播分类校正（e007）

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK |
| `account_id` | INTEGER | NOT NULL，FK → accounts.id |
| `live_id` | TEXT | NOT NULL；**UNIQUE(account_id, live_id)** |
| `category` | TEXT | 9 类之一（不含 live 兜底） |
| `created_at` / `updated_at` | DATETIME | UTC now |

校正既是最高优先级推断信号，也反哺该账号的词库（`live_type.build_learned`）。

#### `vtuber_events` — 重要日期 / 活动（e005）

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK |
| `vtuber_id` | INTEGER | NOT NULL，FK → vtubers.id |
| `title` | TEXT | 活动名（如「生日歌回」） |
| `event_date` | TEXT | `YYYY-MM-DD` |
| `created_at` | DATETIME | UTC now |

索引：`ix_vtuber_events_vtuber_date (vtuber_id, event_date)`。

#### `thirdparty_vtubers` — 第三方 VTuber 索引（e004）

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK |
| `platform` / `platform_uid` | TEXT | 默认 bilibili；uid 索引；**UNIQUE(source, platform_uid)** |
| `name` | TEXT | NOT NULL |
| `type` | TEXT | vtuber / group / fan / unknown |
| `room_id` | TEXT | 房间 |
| `group_name` | TEXT | 企划 / 公会（阵营自动打标候选） |
| `source` | TEXT | 来源（danmakus） |
| `updated_at` | DATETIME | 周级整表刷新 |

### 1.3 迁移链（alembic，13 版本）

| 版本 | 内容 |
|---|---|
| `a001` init_v2 | 建 `vtubers` + `accounts`（含账号唯一约束） |
| `b001` posts_v2 | 建 `posts`（含 (platform, platform_post_id) 唯一约束） |
| `c001` post_archived | `posts.is_archived` |
| `c002` posts_per_uid_dedup | 唯一约束改为 (platform, platform_uid, platform_post_id)（SQLite 重建表） |
| `d001` columns_and_indexes | `vtubers.faction` + 三个热路径索引（分页 / 归档 / by_vtuber） |
| `d002` vtuber_background | `vtubers.background_path` |
| `e001` account_stat_snapshots | 建快照表 + 两索引 |
| `e002` post_tombstone | `posts.last_seen_at / deleted_detected_at` + `accounts.posts_last_scan_at` + 墓碑索引 |
| `e003` post_body_text | `posts.body_text`（全文搜索） |
| `e004` external_sources | 快照表加 `source` + 建 `live_gift_days` / `thirdparty_vtubers` |
| `e005` vtuber_events | 建活动条目表 |
| `e006` live_sessions | 建直播场次表 |
| `e007` live_category_overrides | 建分类校正表 |

**纪律**：新增迁移后必须同步 `app/main.py` 的 `MIGRATION_HEAD`（`tests/test_services.py`
断言与 alembic head 一致），否则冷启动快路径会把旧库误判为已最新。启动迁移四形态：
全新库 `upgrade head` / create_all 旧库补列补索引后 `stamp head` / 版本落后增量升级 /
已最新零开销返回。

### 1.4 存储约定

- **时区**：库内 datetime 一律 **naive UTC**（SQLite 抹掉 tz）；路由层比较参数须同为 naive；
  `PostOut` / `AccountStatSnapshotOut` 等序列化时补 `+00:00`，避免前端按本地时区偏移 8 小时。
- **文件**：头像 / 背景存 `static/` 相对路径（`avatar_path`、`background_path`），随
  `DDTOOLKIT_DATA_DIR` 走；`static/img-cache/` 是图片代理磁盘缓存，可随时重建。
- **删除**：见 §1.1 外键表 —— 一律经 `app/services/purge.py`。

---

## 2. Repositories（`app/repositories/vtuber_repo.py`，9 个类）

构造注入会话：`Repo(db)`。CRUD 惯例：`create` 用 `model_dump()` 展开；`update` 逐个
`setattr`；`get` 返回 `None` 表示不存在；写操作当场 `commit`（`PostRepo.create(commit=False)`
与各 `delete_by_*` 例外，后者不提交、由调用方事务统一收口）。

### 2.1 `VTuberRepo`

| 方法 | 语义 |
|---|---|
| `all()` | 全部 V，`joinedload(accounts)` 预取 |
| `get(id)` | 按主键取（带 accounts 预取） |
| `create(data)` / `update(id, data)` | 插入 / 部分更新（+commit/refresh） |
| `delete(id)` | 删除；accounts 级联（**子表需先经 purge 清空**） |

### 2.2 `AccountRepo`

| 方法 | 语义 |
|---|---|
| `by_vtuber(vtuber_id)` | 某 V 的全部账号 |
| `get(id)` / `create(vtuber_id, data)` / `update(id, data)` / `delete(id)` | 标准 CRUD |
| `all_for_fetch(platform=None)` | 可抓取账号（`platform_uid` 非空），可按平台过滤 |

### 2.3 `AccountStatSnapshotRepo`

| 方法 | 语义 |
|---|---|
| `add(account_id, followers_count, live_status=None, live_title=None, captured_at=None)` | 追加一行（不 commit） |
| `recent(account_id, limit=100, source=None)` | 按 `captured_at` 倒序取最近 N 条 |
| `fan_trend_points(account_id)` | 粉丝趋势点：`self` 按天取最后一条（降抖动）、`zeroroku` 全量点（补历史） |
| `live_sessions(account_id)` | 由快照推导直播场次（`live_status` 边沿配对，读取时合并用） |
| `delete_by_account(account_id)` | 批量删除（级联清理，不提交） |

### 2.4 `LiveSessionRepo`

| 方法 | 语义 |
|---|---|
| `upsert_danmakus(account_id, items)` | 第三方场次批量幂等 upsert |
| `upsert_feed(account_id, live_id, fields)` | B 站动态直播卡片幂等 upsert，返回是否新增 |
| `list_by_account(account_id)` | 表内场次（按 `start_at`） |
| `merged(account_id)` | **读取时合并**：表内场次 ∪ self 快照虚拟场次；同场去重（同 room 90min）、中断续播并段（同标题 60min）、`end_at` 补全、来源标记 `danmakus+self` 等 |
| `delete_by_account(account_id)` | 批量删除（级联清理，不提交） |

### 2.5 `LiveCategoryOverrideRepo`

| 方法 | 语义 |
|---|---|
| `map_by_account(account_id)` | `{live_id: category}`（推断时 override 最高优先级） |
| `upsert(account_id, live_id, category)` | 校正写入 |
| `delete(account_id, live_id)` | 取消校正 |
| `delete_by_account(account_id)` | 批量删除（级联清理，不提交） |

### 2.6 `PostRepo`

| 方法 | 语义 |
|---|---|
| `by_uid(platform, platform_uid)` | 该账号全部帖子（旧接口，`published_at` 倒序） |
| `paginated(platform, platform_uid, page, page_size, post_type, is_archived, is_deleted, q, date_from, date_to)` | 服务端分页 + 过滤，返回 `(total, items)` |
| `stats(platform, platform_uid)` | 总数 / 归档数 / 墓碑数 / 类型分布 / 时间跨度 |
| `archive_before(cutoff)` | 归档规则：`is_archived=0 且 published_at<cutoff` → 置 1，幂等，返回条数 |
| `get(id)` / `create(data, commit=True)` / `update(id, data)` / `delete(id)` | 标准 CRUD |
| `delete_by_platform_uids(list[(platform, uid)])` | 按「平台+UID」组清空（解订阅/删账号用；跨平台同 UID 不误删，不提交） |

**`paginated` 过滤语义**：`q` 匹配 `title`/`summary`（OR，`ilike`）；`date_from`/`date_to`
为 `published_at` 范围（`date_to` 次日零点排他 → 含结束日全天，设范围时排除空时间帖）；
`post_type` 逗号分隔多型（如 `video,video_dynamic`）；`is_deleted` 墓碑筛选
（True=仅已删 / False=仅未删 / None=全部）；排序恒为 `published_at desc`。

### 2.7 `LiveGiftDayRepo`

| 方法 | 语义 |
|---|---|
| `list_by_account(account_id, source=None, limit=0)` | 按日期倒序取礼物聚合（limit=0 全量） |
| `delete_by_account(account_id)` | 批量删除（级联清理，不提交） |

### 2.8 `ThirdpartyVtuberRepo`

| 方法 | 语义 |
|---|---|
| `search(kw, source=None, limit=20)` | 名称关键词 / uid 前缀匹配（候选池搜索增强） |
| `by_uid(platform_uid, source=None)` | 按 uid 取索引条目 |

### 2.9 `VtuberEventRepo`

| 方法 | 语义 |
|---|---|
| `list_by_vtuber(vtuber_id)` | 手动条目（按日期升序） |
| `create(vtuber_id, title, event_date)` / `delete(event_id)` | 增删 |
| `future_reservations(vtuber_id, now=None, days=90)` | 从预约帖 `body_json.reservation` 解析未来直播预约（含年份推断） |
| `delete_by_vtuber(vtuber_id)` | 批量删除（级联清理，不提交） |

---

## 3. Routers（47 个端点）

### 3.1 `app/routers/vtuber.py` — 主业务路由（43）

路径直接 `/vtuber/...`、`/account/...`、`/posts...`、`/post/...`、`/externals/...`；
响应模型走 `app/schemas/vtuber.py`（`Out` 为 `from_attributes`）。

> **冷启动优化**：scheduler 依赖链（apscheduler/tenacity/httpx/fetcher）较重，路由内不直接
> import，经 `_sched()` 缓存包装首次调用才导入；测试 monkeypatch 本模块属性即可替换。

**VTuber**

| 方法 + 路径 | 说明 |
|---|---|
| GET `/vtuber/list` | 全部 VTuber（含 accounts） |
| GET `/vtuber/fetch-status` | 抓取实时状态（TopBar 轮询）：account 跑动/当前/总数 + recent 增量快照，post 跑动/目标 + last_result |
| GET `/vtuber/{vtuber_id}` | 单 V；不存在 404 |
| POST `/vtuber` | 建 V；唯一约束冲突 409 |
| PUT `/vtuber/{vtuber_id}` | 部分更新；404 |
| POST `/vtuber/{vtuber_id}/background` | 上传自定义背景（jpeg/png/webp/gif，≤10MB，否则 415/413）；时间戳后缀防缓存，替换删旧文件 |
| DELETE `/vtuber/{vtuber_id}/background` | 清除背景回退头像铺底 |
| DELETE `/vtuber/{vtuber_id}` | 解除订阅：`purge_vtuber()` 清 posts + 4 张子表 + 活动条目，再级联删 V+accounts；外键挡下 → 409 |

**Account**

| 方法 + 路径 | 说明 |
|---|---|
| GET `/vtuber/{id}/accounts` | 某 V 的账号列表 |
| POST `/vtuber/{id}/accounts` | 建账号；(platform, platform_uid) 重复 409；成功后**后台抓该 V 账号信息 + 回填新账号第三方历史**（v0.9.3） |
| PUT `/account/{account_id}` | 更新账号；唯一冲突 409 |
| DELETE `/account/{account_id}` | 删账号 + `purge_account()` 清理帖子与 4 张子表 |
| GET `/account/{id}/stat-snapshots?limit=` | 统计快照历史（默认 100，上限 1000，时间倒序，UTC 补时区） |
| GET `/account/{id}/gift-days?limit=` | 礼物日聚合 |
| GET `/account/{id}/fan-trend` | 粉丝趋势点（按天分桶） |

**直播场次 / 分类**

| 方法 + 路径 | 说明 |
|---|---|
| GET `/account/{id}/live-sessions` | 合并场次列表（表内 ∪ 快照推导）+ 分类推断结果 |
| GET `/account/{id}/live-sessions/{live_id}` | 场次详情（danmakus 摘要 + 事件 + 词云，外部拉取） |
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

**抓取 / 归档 / 候选池**

| 方法 + 路径 | 说明 |
|---|---|
| GET/POST `/vtuber/fetch` | 手动全量抓账号信息；自动档在跑时**抢占**，仅另一个手动任务在跑才 skipped |
| GET/POST `/vtuber/{id}/fetch` | 抓单个 V 账号信息（同样可抢占自动档） |
| POST `/vtuber/fetch-posts?name=&platform=&video_pages=&dynamics_pages=&full=` | 按名字抓帖子（-1 全量；`full=true` 后台执行）；**抓前先跑归档规则** |
| POST `/vtuber/fetch-all-posts` | 全部账号全量抓（视频+动态） |
| POST `/posts/archive?days=30` | 归档规则；幂等，返回 cutoff/unarchived_total |
| POST `/vtuber/update-posts?name=` | 更新未归档动态：先归档再抓动态，整页已归档即停 |
| GET `/vtuber/pool/search?kw=` | 候选池检索（csv 离线索引），自动剔除已入库账号 |
| POST `/vtuber/adopt` | 从候选池收录 V+账号（名称以池为准）；池内无 404、已入库/并发冲突 409；成功后后台抓该 V + 回填历史 |
| POST `/vtuber/fetch-accounts` | 批量：后台抓全部账号信息，立即返回；手动任务在跑 409 |
| POST `/vtuber/batch/fetch-all-posts` | 批量：后台全量抓帖子 |
| POST `/vtuber/batch/update-unarchived` | 批量：后台更新未归档 |
| POST `/vtuber/batch/archive?days=30` | 批量归档，同步执行 |

**关键调用点**：
- `/adopt` 与 `POST /{id}/accounts` 为同步端点（线程池执行），后台抓取必须走
  `BackgroundTasks`——直接 `asyncio.create_task` 会因工作线程无事件循环抛 `RuntimeError`；
- 路由顺序约束：`/vtuber/fetch-status` 必须注册在 `/vtuber/{vtuber_id}` **之前**；
- 抓取类端点的忙判定用 `manual_task_running()`（自动档持锁不算忙，允许抢占），
  外部批次（T4）用 `any_fetch_running()`。

### 3.2 `app/routers/auth.py` — 扫码登录（3）

| 方法 + 路径 | 说明 |
|---|---|
| POST `/auth/{platform}/qr/start` | 生成二维码会话。bilibili 返回 `{qr_id, url}`；weibo 返回 `{qr_id, image}`（data URL）。同平台旧会话作废 |
| GET `/auth/{platform}/qr/check?qr_id=` | 轮询状态机：`waiting / scanned / confirmed / expired / failed`；`confirmed` 时完成登录并持久化凭据；TTL 180s |
| GET `/auth/{platform}/status` | `{logged_in, needs_login, uid, name}`；B 站走内存维护结果，**微博做真实有效性探测**（结果缓存 60s） |

- 实现分发：bilibili → `app/services/auth.py`（SESSDATA 管理、心跳 + `refresh_token` 续期，
  `run_maintenance()` 由 lifespan 起协程）；weibo → `app/services/weibo_auth.py`（Session v2 扫码）；
- 凭据持久化经 `app/services/env_store.py`（读改写 `.env`，临时文件 + 原子替换）；
- 新增平台只需在 `_PLATFORMS` 注册 + 提供 `begin_login` 实现（见 `docs/platforms-extension-guide.md`）。

### 3.3 `app/routers/img_proxy.py` — 图片代理（1）

| 方法 + 路径 | 说明 |
|---|---|
| GET `/img-proxy?url=` | 转发远端图片；磁盘缓存命中直接回，回源失败 502 |

**安全（防 SSRF + 存储型 XSS）**：仅 http/https；主机匹配 `IMG_PROXY_ALLOWED_HOSTS`
（默认 `hdslb.com,sinaimg.cn,wbcdn.cn`）；`follow_redirects=False` 逐跳重新校验（最多 3 跳）；
限响应 10MB；`content-type` 仅允许图片/octet-stream；按主机带 Referer 防盗链。

**性能**：磁盘缓存 `static/img-cache/{md5}.bin + .json`（TTL 7 天，原子写入，过期 2×TTL 清理）；
模块级共享 `httpx.AsyncClient`（lifespan 关闭时释放）。

---

## 4. 分层注意点

- **删除必须过 purge**：posts 无外键 + 4 张子表有外键且不级联（§1.1）；两个删除端点都已接
  `app/services/purge.py`，返回 409 而不是 500；
- **409 语义**：唯一约束冲突（`IntegrityError`）统一 `rollback → 409`，覆盖 V/账号/帖子建改入口
  与并发收录竞态；
- **时区**：库内 naive UTC；比较参数须同为 naive；输出模型补 `+00:00`；
- **归档边界剪枝**：抓取任务前置 `archive_old_posts`，已归档条目不再产生任何网络请求；
- **迁移链纪律**：新迁移必须同步 `MIGRATION_HEAD`（tests 断言）；快路径依赖版本号判断；
- **新增挂 `accounts`/`vtubers` 外键的表时，必须同步 `app/services/purge.py`**（否则解除订阅
  会被外键整次回滚）。
