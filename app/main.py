from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import asyncio
import logging
import os
import time
from datetime import datetime, timezone

from sqlalchemy import inspect, text

from app.core.config import settings
from app.core.database import engine, Base
from app.routers import vtuber, img_proxy, auth

# --- 日志 ---
os.makedirs(settings.DATA_DIR / "logs", exist_ok=True)
logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(settings.LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
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
    """
    try:
        from app.services.wbi import get_wbi_keys
        await get_wbi_keys()
        logger.info("WBI 密钥预热完成")
    except Exception as e:  # 预热失败不影响启动与后续抓取
        logger.warning(f"WBI 密钥预热失败（不影响启动）: {type(e).__name__}: {e}")


# ── 统一 schema 管理（alembic 迁移链为准） ──────────────────────────────

# 迁移链最新版本。新加迁移时必须同步更新（tests 会断言与 alembic head 一致）。
MIGRATION_HEAD = "f001"


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


def _sync_legacy_schema() -> None:
    """把 create_all 时代生成的旧库同步到与 ORM 模型一致（补列/索引），再 stamp head。

    仅对「有表但无 alembic_version」的旧库生效；全新库直接 alembic upgrade head。
    幂等：缺列补列、缺索引建索引。彻底取代旧 _migrate() 的硬编码 ALTER。
    """
    inspector = inspect(engine)
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
    """
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    if not tables:
        _perf("迁移: 全新库")
        from alembic import command
        command.upgrade(_alembic_config(), "head")
        return
    if "alembic_version" not in tables:
        _perf("迁移: create_all 旧库桥接")
        _sync_legacy_schema()
        from alembic import command
        command.stamp(_alembic_config(), "head")
        return
    with engine.connect() as conn:
        current = conn.execute(
            text("SELECT version_num FROM alembic_version")
        ).scalar_one_or_none()
    if current == MIGRATION_HEAD:
        return  # 快路径：已是最新，跳过 alembic 模块加载
    _perf(f"迁移: {current} -> {MIGRATION_HEAD}")
    from alembic import command
    command.upgrade(_alembic_config(), "head")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("启动中...")
    _perf("lifespan 开始")

    # 延迟导入：apscheduler/tenacity/httpx/auth 不参与 app 构建期导入，
    # 让 uvicorn 尽可能早绑定端口（冷启动优化）
    from app.services.scheduler import (
        start_scheduler, shutdown_scheduler, start_live_poller, start_tier_scheduler,
    )
    from app.services.auth import auth_manager

    _run_migrations()
    _perf("迁移完成")

    scheduler = start_scheduler()
    auth_task = asyncio.create_task(auth_manager.run_maintenance())
    # WBI 密钥预热（v0.9.4）：与 auth 心跳并行，让首次收录不必等一次 nav 往返
    wbi_task = asyncio.create_task(_warm_wbi())
    # 时效分层调度（v0.6.1）：T0 直播状态独立线程（60s）+ T1/T2/T3a 分层轮询
    # （启动链语义并入 T1→T2 首轮；手动任务优先，仅 T0 与之并行）
    start_live_poller()
    start_tier_scheduler()
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

# CORS：来源列表可配置（CORS_ORIGINS）。通配符 "*" 与 allow_credentials=True
# 的组合不符合 CORS 规范（浏览器会拒绝带凭据的跨域响应），因此仅在
# 显式配置来源列表时允许携带凭据。
_cors_origins = [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=(_cors_origins != ["*"]),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(vtuber.router)
app.include_router(img_proxy.router)
app.include_router(auth.router)

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
    """
    first_run = not FIRST_RUN_MARKER.exists()
    if first_run:
        try:
            FIRST_RUN_MARKER.write_text(
                datetime.now(timezone.utc).isoformat(), encoding="utf-8"
            )
        except OSError as e:
            logger.warning(f"首次启动标记写入失败: {e}")
    return {"ok": True, "version": settings.VERSION, "first_run": first_run}