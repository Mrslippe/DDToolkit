# 改动配方：想做什么 → 改哪里

> 主表照抄 `docs/ARCHITECTURE.md` **§7 扩展点**与 `docs/GLOSSARY.md` **§9 需求/缺陷 → 代码入口**；
> 步骤里的纪律来自 `docs/ARCHITECTURE.md` §5/§6、`docs/backend-repositories-and-routers.md` §3.1/§4。
> 路径均为**仓库相对路径**。

---

## A. 扩展点总表（`ARCHITECTURE.md` §7）

| 想做什么 | 改哪里 |
|---|---|
| 接入新平台（抖音/小红书…） | 继承 `platforms/base.py::BasePlatform` → `platforms/registry.py` 注册 → 前端平台常量；调度器自动接管 |
| 接入新第三方源 | 实现 `externals/base.py::ExternalSource` → `externals/__init__.py` 注册（声明 `jobs` 与周期） |
| 新增表/列 | 新建 `alembic/versions/{fNNN}_*.py`（编号按**实际实施顺序**顺延，当前 head `f007`）→ 同步 `MIGRATION_HEAD` → 补 `models` 与 Repo → 若挂 `accounts/vtubers` 外键，**同步 `services/purge.py`** |
| 用户手改的字段被抓取覆盖 | **不再需要锁定**（`accounts.locked_fields` 已随 f004 删除）：抓取照常覆盖，覆盖前把旧值写进 `services/vtuber_history.py::record_field_change()`。⚠️ 只在**平台侧覆盖前**发生（手改不入账，devlog/075） |
| 调整抓取频率/节流 | `app/core/config.py`（T0-T4 周期、请求间隔、批量休息、风控冷却） |
| 新增前端视图 | `docs/UI-MAP.md`（右栏视图光条 + 场景状态机） |
| 改抓取/布局后的验证 | `python scripts/dev_check.py`、`python scripts/ui_probe.py` |

## B. 需求 / 缺陷 → 代码入口（`GLOSSARY.md` §9）

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

（前端文件的相对根是 `frontend/src/`，上表沿用原文写法。）

---

## C. 分步配方

### C1. 加一张表 / 加一列（最常走）

1. 新建 `alembic/versions/{fNNN}_*.py` —— 编号按**实际实施顺序**顺延（当前 head `f007`）；
2. 同步 `app/main.py::MIGRATION_HEAD`（`tests/test_services.py` 断言它与 alembic head 一致，
   否则冷启动快路径会把旧库误判为已最新）；
3. 补 ORM：`app/models/vtuber.py`（单文件 12 表；唯一约束/索引与迁移链一致）；
4. 补 Repo 方法：`app/repositories/vtuber_repo.py`（多数写方法**末尾 commit**；级联清理
   `delete_by_*` 与 `AccountStatSnapshotRepo.add` **不提交**、由调用方**一个**事务收口 ——
   判据 `tests/test_repository_commit_convention.py`。纯函数别让仓库层去 import 服务层，
   下沉到 `app/domain/`）；
5. **若挂 `accounts` / `vtubers` 外键 → 必须同步 `app/services/purge.py`**，
   否则解除订阅会被 `foreign_keys=ON` 整次回滚；
6. 验证：`python -m pytest -q`（含 `test_orm_metadata_matches_migration_chain`）。

⚠️ 旧库桥接（`main._sync_legacy_schema`，补列/补索引）**补不了唯一约束**（SQLite 无
`ADD CONSTRAINT`），stamp head 前必须过 `main._missing_unique_keys` —— 不一致**拒绝启动**（devlog/053）。

### C2. 接一个新平台

1. 继承 `app/services/platforms/base.py::BasePlatform`，实现 `fetch_user_info` /
   `fetch_post_page`（`enrich` 可选）；
2. 在 `app/services/platforms/registry.py` **注册一行**；
3. 补前端平台常量；
4. 调度器自动获得账号抓取、全量/增量帖子抓取、风控退避与完成报告；
5. 若该平台要扫码登录：`app/routers/auth.py` 的 `_PLATFORMS` 注册 + 提供 `begin_login` 实现
   （`backend-repositories-and-routers.md` §3.2）；
6. 参考 `docs/platforms-extension-guide.md`。

### C3. 接一个新第三方源

1. 实现 `app/services/externals/base.py::ExternalSource`（契约
   `run_job(kind, db, client, account_ids)`）；
2. 在 `app/services/externals/__init__.py` 注册（声明 `jobs` 与周期）；
3. 守两条纪律：**幂等**（重复执行不产生重复行）+ **只在每日/每周低频**访问第三方站点；
4. `account_ids` 白名单用于收录/加账号时只回填该账号，避免全量扫第三方站点；
5. `runner.py` 负责调度；T4 批次周期/时刻在 `app/core/config.py`。

### C4. 改抓取频率 / 节流

- 参数全在 `app/core/config.py`（T0 轮询、动态流预算与周期下限、账号流到期阈值、请求间隔、
  批量休息、风控冷却……）；键名与默认值速查见 `docs/GLOSSARY.md` **§7 配置项速查**。
- 运行时可热更的键在 `app/core/runtime_settings.py::SPECS`（19 个可热更键 + `READONLY_NOTES`），
  读取路径经 `config.Settings.__getattribute__` 拦截（优先级 **实例属性 > 覆盖层 > 类属性**），
  调用点都在 `services/scheduler.py` 且"每轮/每账号读一次" ⇒ **改完下一轮生效、不重启**。
- 调度结构本身在 `app/services/scheduler.py`（`_tier_loop` / `_run_combined_tier` /
  `_run_platform_rounds`）；⚠️ 并发粒度 = 平台，同平台内部串行。
- ⚠️ 别在模块级放 asyncio 原语（每轮一个 `asyncio.run()`，见 `invariants.md` 第 15 条）。

### C5. 新增 / 改一个 HTTP 操作

1. 路由加到 `app/routers/vtuber.py`（或 `auth.py` / `img_proxy.py` / `settings.py`），
   进出参补 `app/schemas/vtuber.py`（`Out` 用 `from_attributes`）；
2. **SQL 不得写在路由层** —— 放 `app/repositories/vtuber_repo.py`；
3. 抓取类端点做忙判定：`manual_task_running()`（自动档持锁**不算**忙，允许抢占）；
   外部批次（T4）用 `any_fetch_running()`；
4. **路由顺序**：具体路径必须注册在 `/vtuber/{vtuber_id}` **之前**（`/vtuber/fetch-status` 就是这么放的）；
   新增子资源端点更要用**两段式** —— `/vtuber/bili-search` 会被 `/vtuber/{vtuber_id}` 吃掉
   （422 `int_parsing`），所以实际是 `/vtuber/bili/search`；
5. 同步端点里的后台抓取必须走 `BackgroundTasks`（直接 `asyncio.create_task` 会因工作线程无事件
   循环抛 `RuntimeError`）；fire-and-forget 统一走 `routers/vtuber.py::_spawn_background`
   （`_background_tasks` 集合 + done 回调，避免被 GC 回收）；
6. 唯一约束冲突统一 `IntegrityError → rollback → 409`；删除类端点接 `app/services/purge.py`
   （返回 409 而不是 500）；
7. 未登录时的内容类端点要过 `services/capabilities.content_fetch_allowed()` 闸门（未登录 **403 + 原因**）；
8. 验证：`python -m pytest -q`；涉及前端调用再跑前端三项门禁。

### C6. 新增前端视图

- `docs/UI-MAP.md`（右栏视图光条 + 场景状态机）是唯一入口；四视图状态机在
  `pages/PostsPage.tsx` 的 `view`（`cards` / `list` / `archive` / `profile`），数据共享不重取。
- 改完必跑 `python scripts/ui_probe.py`（三档宽度 + 相关模式）；`docs/UI-MAP.md` §D 是设计令牌全表。

### C7. 改用户手改字段 / 签名来源（A3）

- 卡片签名 = `sign_override` → `sign_source_account_id` 账号 → 主账号 → 空；**平台签名只读**
  （选来源/打字都不改 `accounts.sign`）。
- 抓取覆盖前记账：`services/vtuber_history.py::record_field_change()`；
  `PUT /account/{id}` **不入账**（手改不是"平台上曾经用过的"）。
- ⚠️ 展示暂缓（devlog/075，归入「账号信息历史快照」= TODO R9）；`GET /vtuber/{id}/former-values`
  **当前未接入 UI**。

---

## D. 改完顺手同步的文档（`docs/README.md` §5 维护约定）

1. **新增术语**随手补 `docs/GLOSSARY.md` 对应分组一行（术语 · 含义 · 代码位置 · 关联）；
2. **改数据模型/接口/抓取行为**后同步对应深度文档（表列 / 端点表 / 链路小节）；
3. **改动跨层或影响全局不变量**时更新 `docs/ARCHITECTURE.md`，并在根 `devlog/` 追加一篇；
4. 文档里引用代码一律写**仓库相对路径**；引用其他文档写 `docs/<文件>`；
5. 跑 `python scripts/doc_check.py`（`release.py` 预检也会调它）。
