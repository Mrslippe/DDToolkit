from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import asyncio
import logging
import os
import sqlite3

from app.core.config import settings
from app.core.database import engine, Base
from app.routers import vtuber, img_proxy
from app.services.scheduler import start_scheduler, shutdown_scheduler
from app.services.auth import auth_manager

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


def _migrate() -> None:
    """轻量列迁移：create_all 不会给已存在的表补列，这里显式补齐（幂等）。"""
    db_path = settings.DATABASE_URL.replace("sqlite:///", "")
    with sqlite3.connect(db_path) as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(vtubers)")}
        if "faction" not in cols:
            conn.execute("ALTER TABLE vtubers ADD COLUMN faction VARCHAR")
            logger.info("迁移: vtubers.faction 列已添加")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("启动中...")
    Base.metadata.create_all(bind=engine)
    _migrate()

    scheduler = start_scheduler()
    auth_task = asyncio.create_task(auth_manager.run_maintenance())

    yield
    logger.info("关闭中...")
    auth_task.cancel()
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

# 挂载静态文件目录，头像缓存可通过 /static/avatars/{uid}.jpg 访问
# （目录随数据根 DATA_DIR 走，桌面端打包后位于数据目录）
static_dir = settings.DATA_DIR / "static"
static_dir.mkdir(exist_ok=True)
(static_dir / "avatars").mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/healthz")
def healthz():
    """探活端点：桌面端启动器/前端等待后端就绪用。"""
    return {"ok": True, "version": settings.VERSION}