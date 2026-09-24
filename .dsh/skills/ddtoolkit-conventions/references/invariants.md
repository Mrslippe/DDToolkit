# DDToolkit 架构不变量派生索引

> **条文真源只有一处**：`docs/ARCHITECTURE.md` **§6 不变量与纪律（改代码前必读）** ——**冲突以它为准**。
> 本文不重抄条文，补的是 §6 没有的那一层：每条**落在哪个文件、被哪个测试守着**（`## 1 … ## 15` = §6.1–§6.15）。
> 括号里的 devlog 编号是 §6 原文标注；标 `GLOSSARY §8.x` 的补充曾是**另一组**（编号不对应）—— 现已全部并入 §6，换算见文末。
> ⚠️ 会漂的"当前值"一类**测量值本文一律不写死** —— 真源：`python scripts/gen_doc_numbers.py --list`。

---

## 1. 库内时间一律 naive UTC

库内 datetime 一律 **naive UTC**；路由层比较参数同为 naive；输出模型补 `+00:00`。

- **出处**：`ARCHITECTURE.md` §6.1；同义见 `GLOSSARY.md` §8.1。
- **落点**：`app/core/database.py`、`app/schemas/vtuber.py`（`PostOut` / `AccountStatSnapshotOut` 等序列化补 `+00:00`，避免前端按本地时区偏移 8 小时 —— `backend-repositories-and-routers.md` §1.4）。

## 2. `posts` 无外键 —— 删除必须走 `purge.py`

**posts 无外键**——删除 V / 账号必须走 `app/services/purge.py`（帖子按 `platform+uid`，
5 张子表按 `account_id`，活动条目与曾用值按 `vtuber_id`），漏清一张就会被 `foreign_keys=ON`
整次回滚（v0.9.3 修复的事故；f004 的 `vtuber_field_history` 两个外键都有，删 V 必须再按
`vtuber_id` 清一遍——`account_id=NULL` 的行按 account 清不到）。

- **出处**：`ARCHITECTURE.md` §6.2；事故编号见 `GLOSSARY.md` §8.2（**devlog/040**）。
- **触发面**：`DELETE /vtuber/{vtuber_id}`（解除订阅）、`DELETE /account/{account_id}`；
  外键关系逐条见 `backend-repositories-and-routers.md` §1.1（**5 张子表**按 `account_id`，
  活动条目与曾用值按 `vtuber_id`；`purge.py` 文档头同口径）。

## 3. 新增迁移必须同步 `MIGRATION_HEAD`

**新增迁移必须同步 `MIGRATION_HEAD`**（`tests/test_services.py` 断言它与 alembic head 一致），
否则快路径会把旧库误判为已最新。

- **出处**：`ARCHITECTURE.md` §6.3；`GLOSSARY.md` §8.3 补充：旧库桥接（`main._sync_legacy_schema`，
  补列/补索引）**补不了唯一约束**，因此 stamp head 前必须过 `main._missing_unique_keys`
  —— 不一致就拒绝启动，不许写「本库已等于 head」的假承诺（**devlog/053**）。
- **当前值**：**不写死** —— 查 `python scripts/gen_doc_numbers.py --list`（`migration_head` / `migration_count`）；
  `MIGRATION_HEAD` 写在 `app/main.py`（把这一处抄成常量的代价见 `docs/DEV-LOOP.md` §0.4）。
- **等价性护栏**：`tests/test_services.py::test_orm_metadata_matches_migration_chain`
  （`backend-repositories-and-routers.md` §1.3）。

## 4. 唯一约束去重

唯一约束：账号 `(platform, platform_uid)`、帖子 `(platform, platform_uid, platform_post_id)`、
场次 `(account_id, live_id)`、礼物日 `(account_id, source, gift_date)`。

- **出处**：`ARCHITECTURE.md` §6.4；`GLOSSARY.md` §2「唯一约束」。
- **行为**：`IntegrityError` 统一 `rollback → 409`，覆盖 V/账号/帖子建改入口与并发收录竞态
  （`backend-repositories-and-routers.md` §4）。

## 5. 抓取去重靠内存集合

**抓取去重靠内存集合**，不靠捕获 `IntegrityError`（避免事务回滚污染整批）。

- **出处**：`ARCHITECTURE.md` §6.5；`GLOSSARY.md` §8.6（`existing_ids`）。
- **落点**：抓取前一次性查库取 `existing_ids` / `archived_ids`（`ARCHITECTURE.md` §3.4）。

## 6. 归档边界剪枝

**归档边界剪枝**：抓取前先跑归档规则，已归档帖零网络请求。

- **出处**：`ARCHITECTURE.md` §6.6；实现 `PostRepo.archive_before` + `scheduler.archive_old_posts`。
- **读法**：整页 `is_archived=1` → 更早的页必然也已归档，立即停止翻页（`ARCHITECTURE.md` §3.4）。

## 7. 手动任务优先于定时档

**手动任务优先于定时档**（自动档起跑让位 + 持锁断点让位，**两个方向都要在**）。

- **出处**：`ARCHITECTURE.md` §6.7；`GLOSSARY.md` §8.7。
- **落点**：`_preempt_account/_preempt_post`、`_acquire_manual_*`、`_auto_yield_*_with`；
  端点 409 判定用 `manual_task_running()`（自动档持锁**不算**忙）。

## 8. 外部源幂等 + 低频

**外部源幂等**，且只在每日/每周低频访问第三方站点。

- **出处**：`ARCHITECTURE.md` §6.8；`ARCHITECTURE.md` §4 记契约：`ExternalSource.run_job(...)`
  幂等纪律「重复执行不产生重复行」，`account_ids` 白名单用于只回填该账号。

## 9. 冻结运行时路径

**冻结运行时路径**：`PROJECT_ROOT = sys._MEIPASS`（打包后 `alembic.ini` / 迁移脚本随包）。

- **出处**：`ARCHITECTURE.md` §6.9；`GLOSSARY.md` §6「冻结后端 / frozen」（资源打平事故见 devlog/036）。

## 10. 凭据只落本机

**凭据只落本机** `DATA_DIR/.env`（原子替换），不进仓库、不上传。

- **出处**：`ARCHITECTURE.md` §6.10；`GLOSSARY.md` §8.9 补充：`.env` / `*.db*` / `logs/` / `_tmp_*` 均已 gitignore；写入经 `services/env_store.py::save_env_keys`。

## 11. HTTP 客户端统一走 `new_async_client()`

**HTTP 客户端统一走 `app/core/http.py::new_async_client()`**：直接 `httpx.AsyncClient()`
每次构造都要 `load_verify_locations`（~1s，同步阻塞事件循环）；SSLContext 与事件循环无关，
因此可在「每档 `asyncio.run()` 各起一循环」的模型下安全共享。

- **出处**：`ARCHITECTURE.md` §6.11；`GLOSSARY.md` §3「共享 SSL 上下文」（~1s → ~0.06s）、
  §9「新代码要发 HTTP 请求」。

## 12. 增量停止必须整页扫完 + 豁免置顶帖

**增量停止必须整页扫完 + 豁免置顶帖**：平台会在流首插乱序条目（微博 `isTop` 可多条、
B 站 `module_tag.text=置顶`），「遇已入库即 break」会漏掉同页靠后的新帖（**devlog/045**）。

- **出处**：`ARCHITECTURE.md` §6.12；`GLOSSARY.md` §3「增量停止（整页）」「置顶帖豁免」。
- **落点**：`_fetch_posts_core` / `_fetch_platform_posts` 的 `known_hit`，页面级 `pinned_ids`。

## 13. 多来源数据在写入侧合并

**一条数据的多来源在写入侧合并**：B 站投稿的 `video`（`arc/search`）与 `video_dynamic`
（动态流，同 bvid）只保留前者，动态附言进 `posts.note`（**devlog/047**）。

- **出处**：`ARCHITECTURE.md` §6.13；`GLOSSARY.md` §1「投稿动态 / video_dynamic」「UP 主附言 / note」。
- **落点**：`scheduler._absorb_video_dynamic`。

## 14. 场次合并要防「开放式区间」

**场次合并要防「开放式区间」**：`end_at` 缺失既可能是「正在直播」也可能是「数据未定稿」，
当无穷大会让很久以前的记录吞掉今天的场次 —— 用假定时长上界 + 双缺 end 时只认同标题
（**devlog/047**）。

- **出处**：`ARCHITECTURE.md` §6.14；`GLOSSARY.md` §1「场次并入 / self 快照合并」
  （`LiveSessionRepo._find_group` **区间重叠优先**、`_overlap_seconds`）。

## 15. 模块级对象不得持有 asyncio 原语

**模块级对象不得持有 asyncio 原语**（`Lock`/`Semaphore`/`Event`/`Queue`）：综合档是
「**每轮一个 `asyncio.run()`**」，`asyncio.Lock` 首次 await 就绑死当时那个循环，第二轮必抛
`is bound to a different event loop` —— 2026-09-13 实际事故：起跑闸门把动态流**每轮**打成异常
（**devlog/076**）。要跨轮复用就存**同步**状态（`threading.Lock` + 时刻表，锁外 `await`），
或把原语按事件循环惰性创建。

- **出处**：`ARCHITECTURE.md` §6.15；`GLOSSARY.md` §3「两把锁」「动态流预算」。
- **护栏**：`test_platform_pacer_survives_new_event_loops`
  + `test_module_level_pacers_hold_no_event_loop_primitives`。

---

## 附：原 `GLOSSARY.md` §8 的条目去哪了

`docs/GLOSSARY.md` §8「不变量与常见坑」原有的那组条目**已全部并入** `docs/ARCHITECTURE.md` §6
（新增部分 = §6.16–§6.23）；**逐条换算表的真源在 `GLOSSARY.md` §8 自己**（本节不再维护）。
本文的 `## 1 … ## 15` 只覆盖 §6.1–§6.15；§6.16 起是后并入的，**尚未建派生条目**。
引号里写"GLOSSARY §8.x"时按下面的换算对照读（要点，非穷举）：

| 原 `GLOSSARY.md` §8 | 现在在 | 要点 |
|---|---|---|
| §8.4 | §6.16 | **新增挂 `accounts`/`vtubers` 外键的表 → 同步 `purge.py`**（`ARCHITECTURE.md` §7 扩展点表也有这句） |
| §8.5 | §6.17 | OverlayScroll 会插一层 `.os-scroll`：给被包容器写 CSS 一律用**后代选择器**，写成直系子会静默失效（devlog/039） |
| §8.8 | §6.18 | 并发粒度是平台：同平台内部串行，不要在一条平台流里再并发放大速率 |
| §8.10 | §6.19 | `scripts/backend-8000.bat` 属个人脚本，**不得提交** |
| §8.11 | §6.20 | `asyncio.create_task` 必须留强引用（fire-and-forget 会被 GC 回收 → 回填静默不跑）；统一走 `routers/vtuber.py::_spawn_background` |
| §8.12 | §6.21 | 上游结论必须在"冷进程 + 空数据目录"里复现一次（devlog/085）；⚠️「空数据目录」≠「候选池为空」，且 shell 里残留的 `BILI_SESSDATA` 会被子进程继承 |
| §8.13 | §6.22 | 判据至少有一条用例吃真实数据（`tests/fixtures/`，由 `scripts/smoke_upstream.py --capture` 刷） |
| §8.14 | §6.23 | 未登录 ≠ 不可用，但**内容抓取必须登录**（匿名 `arc/search` / `feed/space` → `-352` 后 HTTP 412，IP 级）；闸门在 `services/capabilities.content_fetch_allowed()`（devlog/086） |
