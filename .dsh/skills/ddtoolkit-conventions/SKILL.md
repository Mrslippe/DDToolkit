---
name: ddtoolkit-conventions
description: Use when 修改 DDToolkit 的后端抓取/数据层/迁移/路由，或排查线上事故类 bug；给出改前必查项、分层纪律、15 条架构不变量与验收命令。
---

# DDToolkit 工程约定（后端 · 数据层 · 验证）

> 项目：本地优先的个人 VTuber 证据归档工具 —— Tauri v2 桌面壳 + Python 3.14 / FastAPI / SQLAlchemy 2.0 / SQLite(WAL) / Alembic 后端 + Vite / React 18 / TS / Tailwind v4 前端。
> 本技能只做**路由 + 清单 + 指向源头**；细节一律回 `docs/` 原文（项目文档是中文，代码/路径/命令保持原文）。

## 1. 触发场景

改动落在**后端抓取链路、数据层（models / repositories / purge）、迁移、路由契约**，或要排查"事故类" bug（删除后回滚、旧库启动失败、增量漏帖、抓取卡死、第二轮必抛异常）→ **先加载本技能**。
只改前端布局/视觉时，本技能只提供验收命令（`python scripts/ui_probe.py` 那条线）。

## 2. 开工前三步

| 步 | 读什么 | 拿到什么 |
|---|---|---|
| 1 | `docs/GLOSSARY.md` | 术语 → 代码路径 → 依赖：§1 领域名词 · §2 数据模型与字段 · §3 抓取与调度 · §8 不变量与常见坑 · §9 需求/缺陷 → 代码入口 |
| 2 | `docs/ARCHITECTURE.md` **§6 不变量与纪律** | **15 条不变量**（改代码前必读）；速查见本文 §4，完整表述见 `references/invariants.md` |
| 3 | `docs/ARCHITECTURE.md` **§5 分层与依赖方向** | 判断改动落在哪一层，再决定动哪个文件 |

补充入口：`docs/backend-repositories-and-routers.md`（12 张表列级定义 / 12 个 Repository / 路由计数三种口径）、`docs/backend-fetch-pipeline.md`（抓取链路细节）、`docs/DEV-LOOP.md`（验收命令）。

## 3. 分层纪律

| 层 | 职责 | 硬约束 |
|---|---|---|
| `app/routers/` | HTTP 契约、状态码语义（404/409/415/413）、`Depends(get_db)` | **不写 SQL**；抓取类端点做忙判定 |
| `app/repositories/` | 11 个 Repo，批量删除/分页/统计等 SQL | 写操作当场 commit；`PostRepo.create(commit=False)` 与各 `delete_by_*` 由调用方事务收口 |
| `app/models/` | SQLAlchemy 2.0 ORM（单文件 11 表） | 唯一约束/索引与迁移链一致 |
| `app/schemas/` | Pydantic 输入输出模型 | `Out` 用 `from_attributes` |
| `app/services/` | 调度、抓取、平台适配、第三方源、认证、类型引擎、墓碑、清理 | 不碰 HTTP；重依赖延迟 import |
| `app/core/` | 配置、引擎与 PRAGMA、`get_db`、共享 HTTP 客户端构造 | 新代码发请求一律 `new_async_client()` |

依赖方向（`ARCHITECTURE.md` §5）：routers → services / repositories；services → repositories / `platforms/` / `externals/`；repositories → models；`schemas/` 挂 routers、`core/` 挂 routers 与 repositories（是横向关联，不是调用方向）。

**新增一个 HTTP 操作**（分步配方见 `references/change-recipes.md` C5）：

1. 路由进 `app/routers/vtuber.py` + `app/schemas/vtuber.py`；**SQL 进 repository**；
2. 抓取类端点忙判定 `manual_task_running()`（自动档持锁不算忙），外部批次用 `any_fetch_running()`；
3. 具体路径必须注册在 `/vtuber/{vtuber_id}` **之前**，子资源用两段式（是 `/vtuber/bili/search`，不是 `/vtuber/bili-search`）；
4. 同步端点里的后台抓取走 `BackgroundTasks` / `routers/vtuber.py::_spawn_background`，别直接 `asyncio.create_task`；
5. 唯一约束冲突统一 `IntegrityError → rollback → 409`；删除类端点接 `app/services/purge.py`。

## 4. 15 条不变量速查

出处列 `§6.N` = `docs/ARCHITECTURE.md` §6；带 `GLOSSARY §8.x` 的补充出自**另一组**不变量（编号不对应，对照见 `references/invariants.md` 文末）。

| # | 一句话 | 出处 |
|---|---|---|
| 1 | 库内时间一律 **naive UTC**，输出补 `+00:00`；比较参数同为 naive | §6.1 |
| 2 | **`posts` 无外键** —— 删 V/账号必须走 `app/services/purge.py`（帖子按 platform+uid、5 张子表按 account_id、活动条目与曾用值按 vtuber_id）；漏清一张被 `foreign_keys=ON` 整次回滚。f004 的 `vtuber_field_history` 两个外键都有，删 V 还要按 `vtuber_id` 再清一遍 | §6.2（v0.9.3 修复的事故；devlog/040 ← GLOSSARY §8.2） |
| 3 | **新增迁移必须同步 `app/main.py::MIGRATION_HEAD`**（`tests/test_services.py` 断言与 alembic head 一致），否则快路径把旧库误判为已最新。当前值 `"f004"`（17 个版本） | §6.3（桥接守卫 devlog/053 ← GLOSSARY §8.3） |
| 4 | **唯一约束去重**：账号 `(platform, platform_uid)`、帖子 `(platform, platform_uid, platform_post_id)`、场次 `(account_id, live_id)`、礼物日 `(account_id, source, gift_date)` | §6.4 |
| 5 | **抓取去重靠内存集合**，不靠捕获 `IntegrityError`（避免事务回滚污染整批） | §6.5 |
| 6 | **归档边界剪枝**：抓取前先跑归档规则，已归档帖零网络请求 | §6.6 |
| 7 | **手动任务优先于定时档**：自动档**起跑**让位 + **持锁断点**让位，两个方向都要在 | §6.7 |
| 8 | **外部源幂等**（重复执行不产生重复行），且只在每日/每周低频访问第三方站点 | §6.8 |
| 9 | **冻结运行时路径**：`PROJECT_ROOT = sys._MEIPASS`（打包后 `alembic.ini` / 迁移脚本随包） | §6.9 |
| 10 | **凭据只落本机** `DATA_DIR/.env`（原子替换），不进仓库、不上传 | §6.10 |
| 11 | **HTTP 客户端统一走 `app/core/http.py::new_async_client()`**：直接 `httpx.AsyncClient()` 每次构造都要 `load_verify_locations`（~1s，同步阻塞事件循环） | §6.11 |
| 12 | **增量停止必须整页扫完 + 豁免置顶帖**（微博 `isTop` 可多条、B 站 `module_tag.text=置顶`）；"遇已入库即 break"会漏掉同页靠后的新帖 | §6.12（devlog/045） |
| 13 | **多来源在写入侧合并**：`video`（arc/search）与 `video_dynamic`（动态流，同 bvid）只保留前者，动态附言进 `posts.note` | §6.13（devlog/047） |
| 14 | **场次合并防「开放式区间」**：假定时长上界 + 双缺 `end_at` 时只认同标题，否则旧记录会吞掉今天的场次 | §6.14（devlog/047） |
| 15 | **模块级对象不得持有 asyncio 原语**（`Lock`/`Semaphore`/`Event`/`Queue`）：综合档每轮一个 `asyncio.run()`，第二轮必抛 `is bound to a different event loop`；跨轮复用请存同步状态或按循环惰性创建 | §6.15（devlog/076；护栏 `test_platform_pacer_survives_new_event_loops`、`test_module_level_pacers_hold_no_event_loop_primitives`） |

## 5. 改动类型 → 验收命令

| 改动类型 | 必跑 |
|---|---|
| 改抓取 / 调度 / 后端逻辑 | `python scripts/dev_check.py`（单测 + 开发态后端冒烟）；细跑 `python -m pytest -q` |
| 改布局 / 前端交互 | `python scripts/ui_probe.py`（三档宽度）+ 改动相关模式（`--polish` / `--add-v` / `--settings` / `--filter-pill` …）；位级回归 `--hero-expect <sha256>` / `--calendar-expect <sha256>` |
| 改数据层（models / Repo / purge） | `python -m pytest -q`（含 `test_orm_metadata_matches_migration_chain`）+ `python scripts/dev_check.py` |
| 加迁移 | 先同步 `MIGRATION_HEAD`，再 `python -m pytest -q` |
| 改前端 | `npx tsc --noEmit` + `npm --prefix frontend run lint` + `npm --prefix frontend run test` |
| 真上游链路（登录 / 池外收录 / 场次） | `python scripts/smoke_upstream.py --cold`；或 `python scripts/dev_check.py --upstream` |
| 未登录能力边界 | `python scripts/capability_matrix.py` + `python scripts/ui_probe.py --capabilities` |
| 文档 / 索引 | `python scripts/doc_check.py`（`release.py` 预检也会调） |
| 动 Rust 壳 / `tauri.conf.json` / 安装包布局 | 只能整包重建 `npm run tauri:build`；发布 `python scripts/release.py <版本>` |

逐字命令全表、探针各模式与门禁基线数值（`pytest` 432 passed 等）见 `references/verification.md`。

## 6. 高危清单（最容易造成事故）

| 高危动作 | 为什么会炸 |
|---|---|
| 模块级放 `asyncio.Lock/Semaphore/Event/Queue` | 综合档"每轮一个 `asyncio.run()`"：原语首次 await 就绑死当轮循环，第二轮必抛 `is bound to a different event loop` —— 2026-09-13 实际事故，起跑闸门把动态流**每轮**打成异常（devlog/076） |
| 删 V / 账号不走 `services/purge.py` | posts 无外键 + **5 张子表**挂外键且不级联（`foreign_keys=ON`）→ `DELETE FROM accounts` 被外键挡下，**整次事务回滚**（devlog/040） |
| 新迁移不同步 `MIGRATION_HEAD` | 冷启动快路径（版本 == head 直接返回）会把旧库误判为已最新，迁移永不执行 |
| 直接 `httpx.AsyncClient()` | 每次构造都要 `load_verify_locations`（~1s，**同步阻塞事件循环**） |
| 增量抓取"遇已入库即 break" | 平台在流首插置顶/乱序条目 → 漏掉同页靠后的新帖（devlog/045） |
| 靠捕获 `IntegrityError` 去重 | 事务回滚污染整批入库 → 抓取前先一次性查库取 `existing_ids` |
| 未登录硬撞空间内容接口 | 匿名 `arc/search` / 动态 `feed/space` → `-352` 后 **HTTP 412 `request was banned`**（IP 级、会持续）→ 必须过 `services/capabilities.content_fetch_allowed()` 闸门，未登录**一次请求都不发** |
| `asyncio.create_task` 不留强引用 / 在同步端点里直接调 | 前者任务被 GC 回收（回填静默不跑）；后者工作线程无事件循环 → `RuntimeError`；统一走 `BackgroundTasks` / `_spawn_background` |
| 给被 OverlayScroll 包裹的容器写**直系子**选择器 | OverlayScroll 会插一层 `.os-scroll`，直系子选择器**静默失效**（devlog/039，列表列宽事故） |
| 在"WBI 密钥已缓存"的环境下下结论 | 上游结论必须在**冷进程 + 空数据目录 + 显式清空凭据**下复现一次，否则结论会完全反过来（devlog/085） |

## 7. references

- `references/invariants.md` —— 15 条不变量完整表述 + `GLOSSARY.md` §8 那组 14 条的差异对照
- `references/verification.md` —— 验收/门禁命令全表（逐字命令 + TODO §6.2 基线数值）
- `references/change-recipes.md` —— 改动 → 文件对照（扩展点总表 + 分步配方 + 文档同步约定）
- 记 devlog / 同步活文档 / 发版 → 用 `ddtoolkit-docs-devlog` 技能；本技能只管代码侧不变量与验收命令
