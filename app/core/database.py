from sqlalchemy import create_engine, event, Column, Integer, String, Boolean
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker, Session

from app.core.config import settings

engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,
)

# SQLite 并发加固（调度器线程与 HTTP API 写操作并存）：
# - journal_mode=WAL：读写不互斥，避免调度器写入时 API 读被锁
# - busy_timeout=30s：写锁冲突时等待而非立即抛 "database is locked"
#   （v0.6.1 提升：T0 直播轮询独立线程随时与各抓取任务并发写同表，
#   其事务毫秒级，30s 排队兜底足够且不必参与锁协议）
# - synchronous=NORMAL：WAL 下兼顾持久性与写吞吐（每次 commit 少一次 fsync）
# - foreign_keys=ON：ORM 未显式开外键时 SQLite 默认关闭，行为易漂移
@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
