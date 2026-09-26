# 数据层与接口层文档（数据库 · Repositories · Routers）

> 适用版本：`main`（2026-09-23，`MIGRATION_HEAD = f007`，迁移链 20 个版本、12 张表；**路由计数的三种数法见 §3**，别处不要再复述数字）。
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
| `accounts 1—N vtuber_field_history` | FK，无 ORM 级联（`account_id` **可空**） | 同上；可空意味着删 V 时还要**按 `vtuber_id` 再清一遍** |
| `vtubers 1—N vtuber_events` | FK，无 ORM 级联 | 同上 |
| `vtubers 1—N vtuber_field_history` | FK，无 ORM 级联 | 同上 |
| `posts` ↔ `accounts` | **无外键**（`platform + platform_uid` 逻辑关联） | 需按平台+UID 显式清 |
| `thirdparty_vtubers` | 无外键 | 独立，随源整表刷新 |

> 因为 `foreign_keys=ON`，**删 V / 删账号必须走 `app/services/purge.py`**：
> 帖子按 `(platform, platform_uid)`、5 张子表按 `account_id`、活动条目 / 曾用值 / **卡片布局（f006）** 按 `vtuber_id`。
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
| `sign_override` | TEXT | 手改的签名（**覆盖**，f004）。不写 `accounts.sign`；清空 = 撤销覆盖 |
| `sign_source_account_id` | INTEGER | 卡片签名跟随哪个账号（**无外键**，f004）；NULL = 主账号，指向不存在的 id 时回落主账号 |
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
| `sort_order` | INTEGER | 默认 0：平台徽章展示顺序（f002） |
| ~~`locked_fields`~~ | — | **f004 已删除**（字段锁定退役，改为"允许覆盖 + 记曾用值"） |

> `display_name` / `sign` 被抓取覆盖**之前**，旧值会记进 `vtuber_field_history`
> （`scheduler._fetch_one_account` 与 `PUT /account/{id}` 两个写入点）。

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
| `is_pinned` | BOOLEAN | NOT NULL 默认 0（f005）：平台置顶（B 站「置顶」/ 微博 `isTop`）。每轮抓取按**第一页**的置顶集合同步（新置顶标记、取消置顶撤销） |
| `pinned_refreshed_at` | DATETIME | 置顶帖最近一次走**详情接口**刷正文的时刻（f005，节流窗口见 `settings.PINNED_DETAIL_REFRESH_HOURS`） |
| `last_seen_at` | DATETIME | 最近一次确认仍在线（墓碑，e002） |
| `deleted_detected_at` | DATETIME | 判定已删除的时刻（墓碑，e002） |
| `created_at` | DATETIME | 入库时间 |

索引：`ix_posts_platform_uid_published (platform, platform_uid, published_at)` 覆盖分页；
`ix_posts_platform_uid_pinned (platform, platform_uid, is_pinned)` 覆盖置顶排序（f005）；
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

#### `profile_cards` — 档案视图的卡片布局（f006，R37-P2）

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK |
| `vtuber_id` | INTEGER | NOT NULL，FK → vtubers.id（**删 V 必走 `services/purge.py`**） |
| `card_key` | TEXT | NOT NULL：**实例 id**（内置卡 = kind；P3 自定义卡允许同 kind 多实例） |
| `kind` | TEXT | NOT NULL：渲染类型（前端卡片注册表认它；后端**不校验取值** —— 扩展点在前端） |
| `x` / `y` | INTEGER | NOT NULL：12 列网格里的列起点（0–11）与行起点 |
| `w` / `h` | INTEGER | NOT NULL：列宽（1–12）与行数 |
| `config_json` | TEXT | 可空：卡片自定义配置（P3 用，P2 不写） |
| `created_at` / `updated_at` | DATETIME | 写入 / 更新时刻 |

约束与索引：唯一键 `uq_profile_card_vtuber_key (vtuber_id, card_key)`；
`ix_profile_cards_vtuber (vtuber_id, y, x)` 覆盖"按 V 取出、按阅读顺序排"。

**写入口径**：整版替换（`ProfileCardRepo.replace_all` = 一个事务里 delete + insert），
前端是"编辑一整张画布、松手存一次"；**格位越界 / card_key 重复由路由层 422 拦下，不做静默夹取**
（夹取会把前端 bug 写进库，用户下次打开只会觉得"卡片自己动了"）。

#### `vtuber_field_history` — 曾用名 / 曾用签名（f004）

| 列 | 类型 | 约束/说明 |
|---|---|---|
| `id` | INTEGER | PK |
| `vtuber_id` | INTEGER | NOT NULL，FK → vtubers.id |
| `account_id` | INTEGER | **可空**，FK → accounts.id（账号已删的历史行留空） |
| `field` | TEXT | NOT NULL：`display_name` / `sign`（登记表见 `services/vtuber_history.py::FIELDS`） |
| `value` | TEXT | NOT NULL：被覆盖掉的旧值 |
| `changed_at` | DATETIME | NOT NULL，写入时刻 |

索引：`ix_vtuber_field_history_vtuber (vtuber_id, field)`。

**写入策略**：值**真的变了**才追加一行（相同值不重记，A→B→A 只留 A、B）；
**只有一个写入点**——抓取回写（`scheduler._fetch_one_account`，平台侧旧值）；
`PUT /account/{id}` **不入账**（手改不是"平台上曾经用过的"，devlog/075）。
读取走 `GET /vtuber/{id}/former-values`（各字段最多 5 条、最近优先、按值去重），
**该端点当前未接入 UI**（展示归入「账号信息历史快照」，见 TODO R9）。
**为什么必须记账**：`account_stat_snapshots` 只存粉丝数/直播状态/开播标题，
**不含昵称与签名** —— 不记账就是永久丢失（devlog/074 纠正的前提）。

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

### 1.3 迁移链（alembic，20 版本，head = `f007`）

| 版本 | 内容 |
|---|---|
| `a001` init_v2 | 建 `vtubers` + `accounts`（含账号唯一约束） |
| `b001` posts_v2 | 建 `posts`（含 (platform, platform_post_id) 唯一约束） |
| `c001` post_archived | `posts.is_archived` |
| `c002` posts_per_uid_dedup | 唯一约束改为 (platform, platform_uid, platform_post_id)（SQLite 重建表） |
| `d001` columns_and_indexes | `vtubers.faction` + 三个热路径索引（分页 / 归档 / by_vtuber） |
| `d002` vtuber_background | `vtubers.background_path` |
| `e001` account_stat_snapshots | 建快照表 + 两索引 |
| `e002` post_tombstone | `posts.last_seen_at / deleted_detected_at` + `accounts.posts_last_scan_at` + 墓碑索引（含一次性数据回填） |
| `e003` post_body_text | `posts.body_text`（全文搜索） |
| `e004` external_sources | 快照表加 `source` + 建 `live_gift_days` / `thirdparty_vtubers` |
| `e005` vtuber_events | 建活动条目表 |
| `e006` live_sessions | 建直播场次表 |
| `e007` live_category_overrides | 建分类校正表 |
| `f001` post_note | `posts.note`（投稿动态并入后的 UP 主附言，v0.9.6） |
| `f002` account_order_and_locks | `accounts.sort_order` + `accounts.locked_fields`（v0.9.7） |
| `f003` app_meta | 建通用 KV 表 `app_meta`（v0.9.8，键 `external.startup.last_run`） |
| `f004` sign_source_and_field_history | `vtubers.sign_override / sign_source_account_id` + 建 `vtuber_field_history` + **删 `accounts.locked_fields`**（devlog/074） |
| `f005` post_pinned | `posts.is_pinned`（NOT NULL 默认 0）+ `posts.pinned_refreshed_at` + 索引 `ix_posts_platform_uid_pinned`（R35，devlog/139） |
| `f006` profile_cards | 建 `profile_cards`（档案视图卡片布局；唯一键 `(vtuber_id, card_key)`，**挂 vtubers 外键 ⇒ purge 必清**）（R37-P2，devlog/142） |
| `f007` event_kind_emoji | `vtuber_events` 加 `kind`（NOT NULL 默认 `event`，**回填既有行**）+ `emoji`（可空）+ 索引 `ix_vtuber_events_vtuber_kind`；⚠️ **SQLite 不支持 `ALTER COLUMN` ⇒ 走 `batch_alter_table`**（R42-A，devlog/162） |

**纪律**：新增迁移后必须同步 `app/main.py` 的 `MIGRATION_HEAD`（`tests/test_services.py`
断言与 alembic head 一致），否则冷启动快路径会把旧库误判为已最新。启动迁移四形态：
全新库 `upgrade head` / create_all 旧库补列补索引后 `stamp head` / 版本落后增量升级 /
已最新零开销返回。

> ⚠️ **桥接路径补不了唯一约束**（SQLite 无 `ADD CONSTRAINT`）：`_sync_legacy_schema`
> 只补列与索引，因此 stamp 前会先过 `main._missing_unique_keys`，不一致即**拒绝启动**
> 而不是写下一个「本库已等于 head」的假承诺（devlog/053）。
> ORM 元数据与迁移链的结构等价性由
> `tests/test_services.py::test_orm_metadata_matches_migration_chain` 看住。

### 1.4 存储约定

- **时区**：库内 datetime 一律 **naive UTC**（SQLite 抹掉 tz）；路由层比较参数须同为 naive；
  `PostOut` / `AccountStatSnapshotOut` 等序列化时补 `+00:00`，避免前端按本地时区偏移 8 小时。
- **文件**：头像 / 背景存 `static/` 相对路径（`avatar_path`、`background_path`），随
  `DDTOOLKIT_DATA_DIR` 走；`static/img-cache/` 是图片代理磁盘缓存，可随时重建。
- **删除**：见 §1.1 外键表 —— 一律经 `app/services/purge.py`。

---

## 2. Repositories（`app/repositories/vtuber_repo.py`，13 个类）

构造注入会话：`Repo(db)`。CRUD 惯例：`create` 用 `model_dump()` 展开；`update` 逐个
`setattr`；`get` 返回 `None` 表示不存在。

**提交约定（R3 逐方法核实，devlog/212）**：多数写方法在**方法末尾** `commit`（下表
`✅ 末尾`）；三类例外才是"原子性靠什么"的关键，别只看默认那一行：

| 例外 | 谁提交 | 为什么 |
|---|---|---|
| 级联清理 `delete_by_account` / `delete_by_vtuber` / `delete_by_platform_uids` | **调用方**（`services/purge.py` 或具体流程） | purge 必须"要么全删要么不动" ⇒ `purge.py` 里**一个 `.commit()` 都不许有**（判据 `tests/test_repository_commit_convention.py`） |
| `AccountStatSnapshotRepo.add` | 调用方 | 快照必须与业务写入**同一个事务** —— T0 的直播跳变边沿就靠这条（两笔 commit 会把边沿永久吞掉，devlog/212） |
| `LiveSessionRepo.upsert_feed` | 调用方（`_route_live_item` 之后由 `_flush_pending` 落盘） | ⚠️ 与隔壁 `upsert_danmakus`（自己 commit）**不一致**。今天两者都对，但这正是"owner 看不出来"的标本 |

多表流程的事务 owner（五个流程逐条核实过，判据全部在 `tests/test_transaction_boundaries.py`）：

| 流程 | owner | 中途失败会怎样 |
|---|---|---|
| (a) 删账号 / (b) 删 VTuber | Router 端点：`purge_*` 不提交 + `Repo.delete` 末尾 commit | 全回滚，一行不少 |
| (c) T0 live 字段 + 跳变快照 | `live_sweep_core` 的**单次** `commit()`（R3 修；原先是两笔） | 全回滚，边沿下一轮还能补上 |
| (d) 档案布局 `ProfileCardRepo.replace_all` | Repo 自己（全仓唯一在 Repo 内成对 commit/rollback） | 保留旧布局 |
| (e) 收录 V + Account | Router 端点（单事务两行） | 409 且不留孤儿 V |

### 2.1 `VTuberRepo`

| 方法 | 语义 | 提交 |
|---|---|---|
| `all()` | 全部 V，`joinedload(accounts)` 预取 | — |
| `get(id)` | 按主键取（带 accounts 预取） | — |
| `create(data)` / `update(id, data)` | 插入 / 部分更新（+commit/refresh） | ✅ 末尾 |
| `delete(id)` | 删除；accounts 级联（**子表需先经 purge 清空**） | ✅ 末尾 |

### 2.2 `AccountRepo`

| 方法 | 语义 | 提交 |
|---|---|---|
| `by_vtuber(vtuber_id)` | 某 V 的全部账号 | — |
| `get(id)` / `create(vtuber_id, data)` / `update(id, data)` / `delete(id)` | 标准 CRUD | ✅ 末尾 |
| `all_for_fetch(platform=None)` | 可抓取账号（`platform_uid` 非空），可按平台过滤 | — |

### 2.3 `AccountStatSnapshotRepo`

| 方法 | 语义 | 提交 |
|---|---|---|
| `add(account_id, followers_count, live_status=None, live_title=None, captured_at=None)` | 追加一行（不 commit） | ❌ 调用方 |
| `recent(account_id, limit=100, source=None)` | 按 `captured_at` 倒序取最近 N 条 | — |
| `fan_trend_points(account_id)` | 粉丝趋势点：`self` 按天取最后一条（降抖动）、`zeroroku` 全量点（补历史） | — |
| `live_sessions(account_id)` | 由快照推导直播场次（`live_status` 边沿配对，读取时合并用） | — |
| `delete_by_account(account_id)` | 批量删除（级联清理，不提交） | ❌ 调用方 |

### 2.4 `LiveSessionRepo`

| 方法 | 语义 | 提交 |
|---|---|---|
| `upsert_danmakus(account_id, items, *, platform)` | 第三方场次批量幂等 upsert（**平台由调用方传入**，M1a） | ✅ 末尾 |
| `upsert_feed(account_id, live_id, fields)` | B 站动态直播卡片幂等 upsert，返回是否新增 | ❌ 调用方 ⚠️ |
| `list_by_account(account_id)` | 表内场次（按 `start_at`） | — |
| `merged(account_id)` | **读取时合并**：表内场次 ∪ self 快照虚拟场次；同场去重（同 room 90min）、中断续播并段（同标题 60min）、`end_at` 补全、来源标记 `danmakus+self` 等 | — |
| `delete_by_account(account_id)` | 批量删除（级联清理，不提交） | ❌ 调用方 |

> ⚠️ `upsert_feed` 与 `upsert_danmakus` 的提交行为**不一致**（见本节开头的例外表）：
> 前者靠调用方后续的 `_flush_pending()` 落盘。今天两条路都对，但改它的人看不出这件事。

### 2.5 `LiveCategoryOverrideRepo`

| 方法 | 语义 | 提交 |
|---|---|---|
| `map_by_account(account_id)` | `{live_id: category}`（推断时 override 最高优先级） | — |
| `upsert(account_id, live_id, category)` | 校正写入 | ✅ 末尾 |
| `delete(account_id, live_id)` | 取消校正 | ✅ 末尾 |
| `delete_by_account(account_id)` | 批量删除（级联清理，不提交） | ❌ 调用方 |

### 2.6 `PostRepo`

| 方法 | 语义 | 提交 |
|---|---|---|
| `by_uid(platform, platform_uid)` | 该账号全部帖子（旧接口，`published_at` 倒序） | — |
| `paginated(platform, platform_uid, page, page_size, post_type, is_archived, is_deleted, q, date_from, date_to)` | 服务端分页 + 过滤，返回 `(total, items)` | — |
| `stats(platform, platform_uid)` | 总数 / 归档数 / 墓碑数 / 类型分布 / 时间跨度 | — |
| `archive_before(cutoff)` | 归档规则：`is_archived=0 且 published_at<cutoff` → 置 1，幂等，返回条数 | ✅ 末尾 |
| `get(id)` / `create(data, commit=True)` / `update(id, data)` / `delete(id)` | 标准 CRUD | ✅ 末尾（`commit=False` 时 ❌） |
| `delete_by_platform_uids(list[(platform, uid)])` | 按「平台+UID」组清空（解订阅/删账号用；跨平台同 UID 不误删，不提交） | ❌ 调用方 |
| `by_pid(platform, platform_uid, platform_post_id)` | 按唯一键取单条（f005：置顶刷新要读 `id`/`type`/`pinned_refreshed_at`） | — |
| `sync_pinned(platform, platform_uid, pinned_ids)` | 置顶集合同步（f005）：标记新置顶、**撤销**已取消的；返回 `{marked, cleared}`。**只在第一页解析成功后调用** | ✅ 末尾 |

**`paginated` 过滤语义**：`q` 匹配 `title`/`summary`（OR，`ilike`）；`date_from`/`date_to`
为 `published_at` 范围（`date_to` 次日零点排他 → 含结束日全天，设范围时排除空时间帖）；
`post_type` 逗号分隔多型（如 `video,video_dynamic`）；`is_deleted` 墓碑筛选
（True=仅已删 / False=仅未删 / None=全部）；排序 `is_pinned desc, published_at desc`
（f005 起置顶帖排本账号列表最前，只在第 1 页头部出现一次；`by_uid` 仍是纯时间序）。

### 2.7 `LiveGiftDayRepo`

| 方法 | 语义 | 提交 |
|---|---|---|
| `list_by_account(account_id, source=None, limit=0)` | 按日期倒序取礼物聚合（limit=0 全量） | — |
| `delete_by_account(account_id)` | 批量删除（级联清理，不提交） | ❌ 调用方 |

### 2.8 `ThirdpartyVtuberRepo`

| 方法 | 语义 | 提交 |
|---|---|---|
| `search(kw, source=None, limit=20)` | 名称关键词 / uid 前缀匹配（候选池搜索增强） | — |
| `by_uid(platform_uid, source=None)` | 按 uid 取索引条目 | — |

### 2.9 `VtuberEventRepo`

| 方法 | 语义 | 提交 |
|---|---|---|
| `list_by_vtuber(vtuber_id)` | 手动条目（按日期升序） | — |
| `create(vtuber_id, title, event_date)` / `delete(event_id)` | 增删 | ✅ 末尾 |
| `future_reservations(vtuber_id, now=None, days=90)` | 从预约帖 `body_json.reservation` 解析未来直播预约（含年份推断） | — |
| `delete_by_vtuber(vtuber_id)` | 批量删除（级联清理，不提交） | ❌ 调用方 |

### 2.10 `VtuberFieldHistoryRepo`

| 方法 | 语义 | 提交 |
|---|---|---|
| `delete_by_account(account_id)` | 清该账号的曾用值行（级联清理，不提交） | ❌ 调用方 |
| `delete_by_vtuber(vtuber_id)` | 清该 V 的曾用值行（`account_id` 可为 NULL，删 V 时必须走这条；不提交） | ❌ 调用方 |

### 2.11 `ProfileCardRepo`（f006，R37-P2）

| 方法 | 语义 | 提交 |
|---|---|---|
| `by_vtuber(vtuber_id)` | 该 V 的卡片布局（按 `y, x` = 阅读顺序） | — |
| `replace_all(vtuber_id, cards)` | **整版替换**：一个事务里 delete + insert，失败整体回滚（不留半版布局）；自己 commit | ✅ 自成事务 |
| `delete_by_vtuber(vtuber_id)` | 批量删除（级联清理，不提交） | ❌ 调用方 |

### 2.12 `AppMetaRepo`（f003）

| 方法 | 语义 | 提交 |
|---|---|---|
| `get(key)` / `get_dt(key)` / `all_with_prefix(prefix)` | 通用 KV 读（键如 `external.startup.last_run`、`ratelimit.<平台>`） | — |
| `set(key, value)` | 写一个键 | ✅ 末尾 |
| `set_dt(key, when=None)` | 写一个 UTC 时间戳（**走 `set`** ⇒ 提交行为同它） | ✅ 末尾（间接） |
| `delete(key)` | 删一个键 | ✅ 末尾 |

> 写入不在 Repo（要按"值没变就不记"的业务口径判断）：见
> `services/vtuber_history.py::record_field_change()` 与 `former_values()`。

---

## 3. Routers（65 个路由装饰器 = 68 个方法×路径组合）

> 口径说明（**三种数法别混**）：
>
> | 数法 | 值 | 怎么数 |
> |---|---|---|
> | **装饰器**（下文「N」用它） | **65** | `vtuber 52` + `auth 3` + `img_proxy 1` + `settings 9`；其中 2 个是 `api_route(methods=["GET","POST"])`（`/vtuber/fetch`、`/vtuber/{id}/fetch`）—— ⚠️ **数装饰器必须把这 2 条算进去**，只数 `@router.get/post/...` 会少 2 |
> | `app.routes` 对象 | **71** | 65 个 router 对象 + `/healthz` + FastAPI 自带 4 条 + `Mount(/static)` |
> | 方法×路径 | **68** | `APIRoute.methods` 求和：64 个单方法 + 2 个双方法；FastAPI 自带那 4 条是 `Route`（GET+HEAD），**不计入**这一口径 |
>
> ⚠️ **2026-09-26 重新数过**（批次 16 加了 `GET /settings/diagnostics`）：实测
> 装饰器 **65** / `app.routes` **71** / 方法×路径 **68**（`APIRoute` 66 条 = 65 + healthz，
> 其中 2 条是双方法 ⇒ 64 + 2×2 = 68）。更早的版本：64/70/67（R42-A）、63/69/66、
> 58/64/69 —— 三种数法本来就容易漂。
> **只有「装饰器」这一口径有门禁**（`scripts/gen_doc_numbers.py`），另两种口径要人肉重数。
> 复核命令：`python -c "import app.main as m; print(len(m.app.routes))"` +
> 按 `len(r.methods)` 分布看（2026-09-17 实测 `{1: 62, 2: 2}`）。
> 这类数字会随批次漂：漂了就重新数一遍再改，别留着当装饰（`dev_check.py --docs` 只查
> 版本号/索引/链接这类可机械判定的，**数不出来** —— 所以口径要写清"怎么数的"）。

### 3.1 `app/routers/vtuber.py` — 主业务路由（51）

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
| PUT `/vtuber/{vtuber_id}` | 部分更新；404。f004 起可写 `sign_override`（`null` = 撤销覆盖）与 `sign_source_account_id` |
| GET `/vtuber/{vtuber_id}/profile-cards` | 档案视图卡片布局（按 `y, x`）；空数组 = 还没排过（前端用默认布局渲染）（f006，R37-P2） |
| PUT `/vtuber/{vtuber_id}/profile-cards` | **整版保存**卡片布局；格位越界 / `card_key` 重复 / 超过 50 张 → 422（**不静默夹取**）；V 不存在 404（f006，R37-P2） |
| GET `/vtuber/{vtuber_id}/former-values` | 曾用名 / 曾用签名（各最多 5 条、最近优先、按值去重，含平台标注；f004）。**当前未接入 UI**（devlog/075：归「账号信息历史快照」，先不展示） |
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

### 3.4 `app/routers/settings.py` — 应用设置与偏好（5，R14a/R14b devlog/091、092）

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

---

## 4. 分层注意点

- **依赖方向只许向下**（M1a，devlog/213）：`routers → services → repositories → models`，
  外加一条**叶子层** `app/domain/`（无 IO 的纯函数，上下都能用）。
  `repositories` **不许** import `app.services`、`models` 不许 import 上面任何一层、
  `domain` 连 `sqlalchemy`/`httpx`/`fastapi` 都不许碰 —— 判据
  `tests/test_dependency_direction.py`（AST 扫 import，不是文本搜索）。
  纯函数要下沉时放 `app/domain/`，别让下层为了一个字符串函数去 import 服务层；
- **上传 / 替换文件类操作的三条纪律**（M3b，devlog/214）：① 限额在**读的时候**生效
  （按块读、超限立刻停；有 `size` 就连读都不读）—— 别先 `await file.read()` 全量进内存；
  ② 类型按**文件头**判，客户端声明的 `content-type` 只是提示（矛盾时 415）；
  ③ **先写临时文件 → 原子 `os.replace` → 提交成功之后才删旧文件**，任何一步失败都要
  保证旧文件 + DB 里的路径原样还在、且不留临时文件。真源与判据：
  `app/services/vtuber_background.py` 头部 + `tests/test_background_upload.py`；
- **删除必须过 purge**：posts 无外键 + 5 张子表（+ f006 的 `profile_cards`，按 vtuber_id）有外键且不级联（§1.1）；两个删除端点都已接
  `app/services/purge.py`，返回 409 而不是 500；
- **409 语义**：唯一约束冲突（`IntegrityError`）统一 `rollback → 409`，覆盖 V/账号/帖子建改入口
  与并发收录竞态；
- **时区**：库内 naive UTC；比较参数须同为 naive；输出模型补 `+00:00`；
- **归档边界剪枝**：抓取任务前置 `archive_old_posts`，已归档条目不再产生任何网络请求；
- **迁移链纪律**：新迁移必须同步 `MIGRATION_HEAD`（tests 断言）；快路径依赖版本号判断；
- **新增挂 `accounts`/`vtubers` 外键的表时，必须同步 `app/services/purge.py`**（否则解除订阅
  会被外键整次回滚）。
