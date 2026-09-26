from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import asyncio
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import inspect, text, PrimaryKeyConstraint, UniqueConstraint

from app.core.config import settings
from app.core import runtime_settings
from app.core.api_auth import require_token, token_configured
from app.core.logging_setup import setup_logging
from app.core.database import engine, Base
from app.routers import vtuber, img_proxy, auth
from app.routers import settings as settings_router

# --- 日志 ---
# 双通道（轮转文件 + 控制台）配置在 `app/core/logging_setup.py`：
# 搬出去是为了**可测**（basicConfig 在 pytest 下不生效，配置本身测不到），
# 轮转策略与历史事故见该模块 docstring（devlog/077）。
setup_logging(settings.LOG_LEVEL, settings.LOG_FILE, settings.LOG_BACKUP_DAYS)
logger = logging.getLogger(__name__)

# 启动计时：冷启动优化（devlog/021）——各阶段毫秒时间戳，对照方案 0 基线
_t0 = time.monotonic()

# 首次启动标记（数据目录内）：存在即表示「本机已经启动过一次」。
# /healthz 首次返回 first_run=true 时写入，前端据此自动弹登录浮窗。
FIRST_RUN_MARKER = settings.DATA_DIR / ".first-run-done"


def _perf(step: str) -> None:
    logger.info(f"[perf] {step} +{int((time.monotonic() - _t0) * 1000)}ms")


async def _warm_wbi() -> None:
    """WBI 密钥预热（v0.9.4 收录提速）：1 个请求，避免首次收录多付一次 nav 往返。

    B 站 `acc/info`、`arc/search` 都要 WBI 签名，密钥缓存 30 分钟；进程冷启动后
    第一次签名请求会先打一次 nav。启动时并行预热，用户点「添加 VTuber」时密钥已就绪。
    失败只记日志——真到抓取时还会自行重试。

    2026-09-15（devlog/086）：改成**允许匿名** —— 未登录时 nav 也下发 `wbi_img`，
    预热成功意味着"未登录也能搜 V"，而内容抓取另有登录闸门（`capabilities`）。
    """
    try:
        from app.services.wbi import get_wbi_keys, wbi_status
        await get_wbi_keys(allow_anonymous=True)
        st = wbi_status()
        logger.info("WBI 密钥预热完成" + ("（匿名）" if st.get("anonymous") else ""))
    except Exception as e:  # 预热失败不影响启动与后续抓取
        logger.warning(f"WBI 密钥预热失败（不影响启动）: {type(e).__name__}: {e}")


async def _warm_tokenizer() -> None:
    """分词词典预热（2026-09-13，词云自建）：避免用户**首次点「用弹幕自建」时**卡 0.7s。

    jieba 首次 `cut` 要构建前缀词典（本机实测 0.70s，之后 ~0.1ms/条）。
    本函数是 async 但 jieba 是同步 CPU 活，因此丢到线程里跑，别堵事件循环 ——
    与 `_warm_wbi` 并行，两者都在 lifespan 里 create_task，不拖慢就绪。
    失败只记日志：真到用时 `get_tokenizer` 会退回 regex 引擎，功能在、精度降。
    """
    try:
        from app.services.danmaku_words import get_tokenizer
        await asyncio.to_thread(get_tokenizer().warmup)
        logger.info("分词词典预热完成")
    except Exception as e:  # 预热失败不影响启动
        logger.warning(f"分词词典预热失败（词云将退回正则分词）: {type(e).__name__}: {e}")


# ── 统一 schema 管理（alembic 迁移链为准） ──────────────────────────────

# 迁移链最新版本。新加迁移时必须同步更新（tests 会断言与 alembic head 一致）。
MIGRATION_HEAD = "f007"


def _alembic_config():
    """按需加载 alembic（冷启动快路径不 import，慢路径才进）。"""
    from alembic.config import Config
    from app.core.config import PROJECT_ROOT
    cfg = Config(str(PROJECT_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(PROJECT_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", settings.DATABASE_URL)
    # 不让 alembic/env.py 的 fileConfig 重配应用日志：它会摘掉 app.log 的
    # 文件 handler，导致「首次运行（要跑迁移）」的启动日志整段丢失——
    # 恰恰是最需要日志的场景（2026-09-08 排查首启卡幕时踩到）。
    cfg.attributes["configure_logger"] = False
    return cfg


def _live_unique_keys(inspector) -> dict[str, set[tuple[str, ...]]]:
    """库内**实际存在**的唯一键：{表: {列元组, …}}。

    SQLite 里唯一约束与唯一索引是同一套机制，但反射出来的形态因**建库方式**而异：
    - `alembic` 建的表 → `UniqueConstraint(..., name="uq_…")`（`get_unique_constraints`）；
    - `create_all` 建的表 → `Column(unique=True, index=True)` 生成的唯一**索引**
      （`get_indexes`），且 `get_unique_constraints` 在旧版 SQLite 上可能不报告内联约束。
    因此两边都收，并**按列元组而非约束名**比较 —— 名字从来不是不变量的载体，
    「平台+UID 唯一」这件事才是（应用侧也只捕获 IntegrityError，不认名字）。
    """
    live: dict[str, set[tuple[str, ...]]] = {}
    for table in inspector.get_table_names():
        keys: set[tuple[str, ...]] = set()
        for uc in inspector.get_unique_constraints(table):
            cols = uc.get("column_names") or []
            if cols:
                keys.add(tuple(cols))
        for idx in inspector.get_indexes(table):
            cols = idx.get("column_names") or []
            if idx.get("unique") and cols and all(c is not None for c in cols):
                keys.add(tuple(cols))
        live[table] = keys
    return live


def _missing_unique_keys(inspector) -> list[str]:
    """返回「模型要求、但库内没有」的唯一键描述（空列表 = 一致）。

    只比唯一键，不比索引名/默认值/NOT NULL：后者缺失只影响极端写入路径，
    而唯一键缺失会让合法数据被**静默丢弃**（见 `_sync_legacy_schema` 的说明）。
    """
    live = _live_unique_keys(inspector)
    missing: list[str] = []
    for table in Base.metadata.sorted_tables:
        have = live.get(table.name, set())
        for uc in table.constraints:
            # 注意：不要用 `uc.unique` 判据 —— `UniqueConstraint.unique` 是 None
            # （不是 True），`getattr(uc, "unique", False)` 恒为假，会把所有唯一约束
            # 静默跳过（本守卫自身的第一版就踩了这个坑）。按**类型**判，再排掉主键
            # （PrimaryKeyConstraint 是 UniqueConstraint 的子类）。
            if isinstance(uc, PrimaryKeyConstraint) or not isinstance(uc, UniqueConstraint):
                continue
            cols = tuple(c.name for c in uc.columns)
            if cols and cols not in have:
                missing.append(f"{table.name}({', '.join(cols)})")
    return missing


def _sync_legacy_schema() -> None:
    """把 create_all 时代生成的旧库同步到与 ORM 模型一致（补列/索引），再 stamp head。

    仅对「有表但无 alembic_version」的旧库生效；全新库直接 alembic upgrade head。
    幂等：缺列补列、缺索引建索引。彻底取代旧 _migrate() 的硬编码 ALTER。

    **本函数补不了唯一约束**（SQLite 不支持 ADD CONSTRAINT，要改就得整表重建），
    所以调用前必须过 `_missing_unique_keys`：库内唯一键与模型不一致时拒绝 stamp，
    否则会把「唯一性比代码假设更严格」的库标成 `head`，后续每次迁移都会跳过它。
    典型受害者是 `posts`：迁移 `c002` 之前是全局 `UNIQUE(platform, platform_post_id)`，
    而联合投稿（同一 pid 出现在多个 UP 名下）正是要修的场景 —— 被拒后会被当作
    「帖子已存在」静默跳过（scheduler `_safe_store_post`），数据就永久丢了。
    """
    inspector = inspect(engine)
    missing = _missing_unique_keys(inspector)
    if missing:
        raise RuntimeError(
            "旧库唯一键与当前模型不一致，拒绝 stamp head（补列/索引救不了唯一约束）："
            + "、".join(missing)
            + "。请用 alembic upgrade head 走完整迁移链，或从备份重建该库。"
        )
    existing_tables = set(inspector.get_table_names())
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if table.name not in existing_tables:
                table.create(conn)
                continue
            have_cols = {c["name"] for c in inspector.get_columns(table.name)}
            for col in table.columns:
                if col.name in have_cols:
                    continue
                coltype = col.type.compile(dialect=engine.dialect)
                if col.nullable is False and col.server_default is None:
                    coltype += " NOT NULL"
                conn.execute(text(
                    f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {coltype}'
                ))
                logger.info(f"迁移: {table.name}.{col.name} 列已添加")
            have_idx = {i["name"] for i in inspector.get_indexes(table.name)}
            for idx in table.indexes:
                if idx.name and idx.name not in have_idx:
                    cols = ", ".join(f'"{c.name}"' for c in idx.columns)
                    conn.execute(text(f'CREATE INDEX "{idx.name}" ON "{table.name}" ({cols})'))
                    logger.info(f"迁移: 索引 {idx.name} 已创建")


def _run_migrations() -> None:
    """统一 schema 管理：以 alembic 迁移链为准。

    四种库形态（冷启动优化：已是最新版本的库走快路径，不再加载 alembic）：
    - 全新库（无任何表）                → alembic upgrade head 全量建表
    - create_all 时代的旧库              → 补列/索引到与模型一致后 stamp head
    - 迁移链上但版本落后                 → alembic upgrade head 增量升级
    - 版本 == MIGRATION_HEAD（常态）     → 直接返回，零 alembic 开销

    ⚠️ **"要真跑迁移"的那两条会先备份、失败会被隔离**（批次 16，devlog/207）：
    见 `_migrate_with_safety`。结局写在 `_MIGRATION_STATE` 里，由 `/healthz` 带出去给前端。
    """
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    if not tables:
        _perf("迁移: 全新库")
        _set_migration_state(status="fresh")
        from alembic import command
        command.upgrade(_alembic_config(), "head")
        return
    if "alembic_version" not in tables:
        _perf("迁移: create_all 旧库桥接")
        _migrate_with_safety("create_all 旧库桥接", _bridge_legacy)
        return
    with engine.connect() as conn:
        current = conn.execute(
            text("SELECT version_num FROM alembic_version")
        ).scalar_one_or_none()
    if current == MIGRATION_HEAD:
        _set_migration_state(status="fast-path", head=current)
        return  # 快路径：已是最新，跳过 alembic 模块加载
    _perf(f"迁移: {current} -> {MIGRATION_HEAD}")
    _migrate_with_safety(f"{current} -> {MIGRATION_HEAD}", _upgrade_to_head)


# ── 迁移安全网（批次 16，devlog/207）────────────────────────────────
#
# 为什么要有它："很多人用 + 继续发版"之后，**每次升级都会跑 schema 迁移**，而档案在
# 用户自己机器上 —— 你看不见、够不着、无法远程诊断。在此之前这里没有任何退路：
# 中途失败（磁盘满 / 断电 / SQLite locked）= 用户面对"打不开 + 不知道能不能找回"。
#
# 两条口径（不变量见 `docs/ARCHITECTURE.md` §6）：
#   ① **真跑迁移之前先备份**（快路径不备份 —— 别拖慢常态启动）；
#   ② **迁移失败绝不留下打不开的库**：把坏库挪成 `vtuber.db.failed-<时间戳>`，
#      用空库继续启动（应用可用），并把失败**分类**带出去（`/healthz` 的 `migration`）。
#      ⇒ 判据是"用户能自己找回数据"，不是"日志里有异常"。

_MIGRATION_STATE: dict = {"status": "not-run"}


def migration_state() -> dict:
    """本次启动的迁移结局（`/healthz` 与诊断包共用；返回副本，防外部改）。"""
    return dict(_MIGRATION_STATE)


def _set_migration_state(**kw) -> None:
    _MIGRATION_STATE.clear()
    _MIGRATION_STATE.update(kw)


def _bridge_legacy() -> None:
    _sync_legacy_schema()
    from alembic import command
    command.stamp(_alembic_config(), "head")


def _upgrade_to_head() -> None:
    from alembic import command
    command.upgrade(_alembic_config(), "head")


def _quarantine_database() -> str | None:
    """把迁移失败的库挪到一边（`.failed-<时间戳>`），返回新路径；没库可挪则 None。

    ⚠️ 三个细节都不能省：
    - **先 `engine.dispose()`**：连接池还握着句柄时，Windows 上改名会撞"另一个程序正在
      使用此文件"，而且 WAL 里的已提交数据要先落盘；
    - **`-wal` 跟着一起改名**（SQLite 按 `<库名>-wal` 找它）—— 那是**已提交但还没并回主库**
      的数据，丢了就等于丢数据；
    - **`-shm` 直接删**：共享内存索引，SQLite 打开时会重建（`migrate.rs:20-30` 记过同一条）。
    """
    # 按需 import（本文件一贯的冷启动纪律：快路径不 import 这些）
    from app.services import db_maintenance

    db = db_maintenance.database_path()
    if not db.is_file():
        return None
    try:
        engine.dispose()
    except Exception as e:      # noqa: BLE001 - 关不掉也要继续尝试
        logger.warning(f"隔离坏库前 engine.dispose() 失败（继续）: {e}")
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = db.with_name(f"{db.name}.failed-{ts}")
    try:
        db.replace(dst)
    except OSError as e:
        logger.error(f"隔离坏库失败：{e}（库仍在 {db}）")
        return None
    for suffix in ("-wal", "-shm"):
        side = Path(str(db) + suffix)
        if not side.is_file():
            continue
        try:
            if suffix == "-wal":
                side.replace(Path(str(dst) + "-wal"))
            else:
                side.unlink()
        except OSError as e:
            logger.warning(f"隔离 {suffix} 失败：{e}")
    return str(dst)


def _migrate_with_safety(label: str, action) -> None:
    """备份 → 真跑迁移 → 失败则隔离坏库 + 用空库继续启动。见上面那段口径。"""
    from app.services import db_maintenance

    backup: dict | None = None
    try:
        backup = db_maintenance.backup_database(MIGRATION_HEAD)
        if backup.get("path"):
            logger.info(f"迁移前已备份：{backup['name']}（{backup['path']}）")
        # 备份成功与否都顺手清理旧份：清理失败不影响启动
        db_maintenance.prune_backups()
    except Exception as e:      # noqa: BLE001 - 备份失败**不挡住迁移**（见下）
        # 为什么继续：备份失败最常见的原因正是"磁盘满/权限问题"，而那种情况下
        # 拒绝启动 = 用户连界面都进不去、也拿不到任何提示；迁移本身是事务性的。
        # 但这件事必须**说出来**：`/healthz` 的 `migration.backup` 会带上 error。
        logger.warning(f"迁移前备份失败（本次升级没有退路，继续迁移）: "
                       f"{type(e).__name__}: {e}")
        backup = {"error": f"{type(e).__name__}: {e}"}

    try:
        action()
    except Exception as e:      # noqa: BLE001 - 迁移失败必须兜住：绝不让库打不开
        logger.error(f"schema 迁移失败（{label}）: {type(e).__name__}: {e}", exc_info=True)
        quarantined = _quarantine_database()
        recovered = False
        try:
            # 用**空库**继续启动：应用可用 + /healthz 能把"上次迁移失败"带出去
            _upgrade_to_head()
            recovered = True
        except Exception as e2:  # noqa: BLE001 - 空库都建不起来就只能让它启动失败
            logger.error(f"空库重建也失败: {type(e2).__name__}: {e2}", exc_info=True)
        _set_migration_state(
            status="failed", label=label, error=f"{type(e).__name__}: {e}",
            quarantined=quarantined, backup=backup, recovered=recovered,
            failed_at=datetime.now(timezone.utc).isoformat(),
        )
        if not recovered:
            # 走到这里说明"迁移失败"升级成了"应用起不来" —— 让启动失败是唯一诚实的选项
            raise
        logger.warning(
            "已用空库继续启动：旧的库被隔离为 %s —— 档案没有丢，可从这里找回",
            quarantined)
        return

    _set_migration_state(status="ok", label=label, backup=backup)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("启动中...")
    _perf("lifespan 开始")

    # 没配 token = **门不存在**，而症状是"一切正常" ⇒ 必须大声说一次（S1，devlog/201）。
    # 真机走 Tauri 那条路一定有 token；这条只在开发态/裸跑时出现。
    if not token_configured():
        logger.warning(
            "未配置访问令牌（DDTOOLKIT_API_TOKEN / DDTOOLKIT_DEV_API_TOKEN 都为空）——"
            "本机任何进程或网页都能读写本后端的全部数据与凭据。"
            "真机由 Tauri 注入；开发态请设 DDTOOLKIT_DEV_API_TOKEN。"
        )

    # 延迟导入：apscheduler/tenacity/httpx/auth 不参与 app 构建期导入，
    # 让 uvicorn 尽可能早绑定端口（冷启动优化）
    from app.services.scheduler import (
        start_scheduler, shutdown_scheduler, start_live_poller, start_tier_scheduler,
        start_external_catchup,
    )
    from app.services.auth import auth_manager

    _run_migrations()
    _perf("迁移完成")

    # 库维护（R22）：把库切成增量 auto-vacuum，之后删数据才会真的还盘
    # （SQLite 默认只把删掉的行丢进 freelist，文件永不缩小）。
    # 带体积门槛、失败只留日志 —— 这条是"体验优化"，绝不能挡住启动。
    try:
        from app.services.db_maintenance import checkpoint_wal, ensure_incremental_autovacuum
        _av = ensure_incremental_autovacuum()
        if _av != "already":
            logger.info(f"数据库维护：auto_vacuum 切换结果 = {_av}")
        # WAL 回收（R22）：VACUUM 会把整库重写进 WAL（真库实测留下 54MB），
        # 而且只有"最后一个连接关闭"时 SQLite 才 checkpoint —— 应用自己握着连接池，
        # 所以启动时（几乎无并发）显式截断一次。
        checkpoint_wal()
    except Exception as e:
        logger.warning(f"数据库维护跳过（不影响启动）: {type(e).__name__}: {e}")

    # 运行时设置覆盖层（R14a）：必须在调度器启动**之前**载入 ——
    # 否则第一轮会按默认值跑（用户上次改的抓取节奏要等下一轮才生效）。
    try:
        runtime_settings.load()
    except Exception as e:      # 载入失败不能挡住启动：退回默认值并留痕
        logger.error(f"运行时设置载入失败（按默认值启动）: {type(e).__name__}: {e}")

    scheduler = start_scheduler()
    auth_task = asyncio.create_task(auth_manager.run_maintenance())
    # WBI 密钥预热（v0.9.4）：与 auth 心跳并行，让首次收录不必等一次 nav 往返
    wbi_task = asyncio.create_task(_warm_wbi())
    # 分词词典**不再启动预热**（R24/T2，devlog/117）：jieba 前缀词典常驻约 **56MB**
    # （本机分段实测：加载它 +56.4MB），而它换来的只是"首次点词云少等 0.7s"。
    # 内存吃紧的机器上这笔账不划算 ⇒ 改成首次真正要用时再建（一次 0.7s）。
    # 想要老行为的话，在调用点恢复 `asyncio.create_task(_warm_tokenizer())` 即可。
    # 时效分层调度（v0.6.1）：T0 直播状态独立线程（60s）+ T1/T2/T3a 分层轮询
    # （启动链语义并入 T1→T2 首轮；手动任务优先，仅 T0 与之并行）
    start_live_poller()
    start_tier_scheduler()
    # 启动外部补抓（v0.9.8，P9-4）：独立线程，每 V 主账号的第三方数据
    # （直播日历 / 粉丝趋势），<24h 内已跑过则跳过（时间戳存 app_meta）
    start_external_catchup()
    _perf("调度器+auth 就绪")

    yield
    logger.info("关闭中...")
    auth_task.cancel()
    wbi_task.cancel()
    for task in (auth_task, wbi_task):
        try:
            await task
        except asyncio.CancelledError:
            pass  # 正常取消，避免 CancelledError 噪音
    await img_proxy.close_client()
    shutdown_scheduler(scheduler)


app = FastAPI(lifespan=lifespan)

# 会话 token 中间件（S1，devlog/201）。
# ⚠️ **注册顺序即执行顺序的反序**：后加的在外层。这里先加 auth、后加 CORS
# ⇒ CORS 在最外层（预检 OPTIONS 才不会被 401 挡下）。改顺序会让浏览器跨源请求全挂。
app.middleware("http")(require_token)

# CORS（S1，devlog/201 重定口径）。
#
# ## 默认值为什么是 `"*"`
# 我一度把它改成空，想顺便关掉"任意网页可读" —— 但那**同时打断了浏览器形态的开发态**
# （探针 `ui_probe.py` 与 `npm run dev`：页面在 `localhost:<vite>`、后端在
# `127.0.0.1:<port>` ⇒ **跨源** ⇒ 没有允许头时浏览器不让页面读响应）。
# 而**真正的门是 token**（上面那行中间件），CORS 只是纵深防御：
# 拿不到 token 的网页即使读到 401 也什么都得不到。所以默认保持 `"*"`
# （= 恢复原来的开发形态），把"谁在防谁"这件事交给 token 说清楚：
#   · Tauri（真机）    → 带 token ⇒ 一律放行，与 CORS 无关；
#   · 浏览器开发态      → 跨源可读，但要 token 才拿得到数据；
#   · 本机陌生进程/网页 → **没有 token ⇒ 401**。
#
# ## 值可以是字面来源列表，也可以是**正则**
# 探针的 Vite 端口每次随机挑（`_free_port()`），写死字面来源必失效 ⇒ 需要正则。
# 之前这里只把它当字面列表喂给 `allow_origins`，于是探针传进来的正则被当成
# "一个字面 origin"，**永远匹配不上**（实测：只回 `allow-credentials`、不回
# `allow-origin`，浏览器据此拦掉读取；而后端日志里**一条 401 都没有**，
# 症状伪装成"内容为空 ⇒ 布局断言全红"）。
_CORS_ORIGIN_CHARS = set("[](){}|\\^$*+?")
_cors_origins = [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]
# 含正则元字符 ⇒ 按**正则**处理（逗号是分隔符，所以正则里不能带逗号）。
# 一个真实 origin 只会含 `:` `/` `.` `-` 与字母数字，不会命中这个集合。
#
# ⚠️ **`"*"` 必须先排除**（本行第一版就栽在这）：它本身就是正则元字符，会被判成正则，
#    于是走到 `re.compile("*")` ⇒ `re.PatternError: nothing to repeat`，
#    **整个应用起不来**。而它恰恰是默认值 ⇒ 一改就把所有人挡在门外
#    （实测：3 条 CORS 相关用例直接报 PatternError）。
_cors_regex = next(
    (o for o in _cors_origins if o != "*" and set(o) & _CORS_ORIGIN_CHARS), None
)
_cors_literal = [o for o in _cors_origins if o != _cors_regex]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_literal,
    allow_origin_regex=_cors_regex,
    # `*` 与携带凭据的组合不符合规范（浏览器会拒），沿用原口径
    allow_credentials=(_cors_literal != ["*"] and _cors_regex is None),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(vtuber.router)
app.include_router(img_proxy.router)
app.include_router(auth.router)
app.include_router(settings_router.router)

# 挂载静态文件目录，头像缓存可通过 /static/avatars/{uid}.jpg 访问
# （目录随数据根 DATA_DIR 走，桌面端打包后位于数据目录）
static_dir = settings.DATA_DIR / "static"
static_dir.mkdir(exist_ok=True)
(static_dir / "avatars").mkdir(exist_ok=True)
(static_dir / "custom_bg").mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/healthz")
def healthz():
    """探活端点：桌面端启动器/前端等待后端就绪用。

    附带 `first_run`：本次是「数据目录里还没有首次启动标记」的那一次启动——
    前端据此自动弹出登录浮窗（用户 2026-09-08 需求）。标记在首次返回后落盘，
    同一进程内只会报告一次 true，之后启动恒为 false。

    附带 `migration`（批次 16，devlog/207）：本次启动的 schema 迁移结局。
    ⚠️ 这是**唯一**能在"还没拿到 token"时把启动期故障带出去的通路（启动幕就是在轮询
    这个端点），所以"迁移失败要告诉用户"必须走这里，而不是某个要鉴权的端点。
    形如 `{"status": "failed", "error": …, "quarantined": …, "backup": {…}}`。
    """
    first_run = not FIRST_RUN_MARKER.exists()
    if first_run:
        try:
            FIRST_RUN_MARKER.write_text(
                datetime.now(timezone.utc).isoformat(), encoding="utf-8"
            )
        except OSError as e:
            logger.warning(f"首次启动标记写入失败: {e}")
    return {"ok": True, "version": settings.VERSION, "first_run": first_run,
            "migration": migration_state()}