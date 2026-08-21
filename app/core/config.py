import os
from pathlib import Path
from dotenv import load_dotenv

# 项目根（源码所在位置）
PROJECT_ROOT = Path(__file__).parent.parent.parent

# 数据根目录：桌面端打包后通过环境变量重定向（如 %APPDATA%/DDtoolkit）；
# 缺省 = 项目根，开发行为不变。数据库/日志/缓存/凭据均落在此处。
DATA_DIR = Path(os.getenv("DDTOOLKIT_DATA_DIR", str(PROJECT_ROOT))).resolve()

load_dotenv(DATA_DIR / ".env")


class Settings:
    APP_NAME: str = "Better DD Toolkit"
    VERSION: str = "0.3.1"   # 与 devlog 最新版本保持一致（修复：此前停留在 0.1.0）

    # 数据目录
    DATA_DIR: Path = DATA_DIR

    # 数据库
    DATABASE_URL: str = f"sqlite:///{(DATA_DIR / 'vtuber.db').as_posix()}"

    # B站 API
    BILI_SESSDATA: str = os.getenv("BILI_SESSDATA", "")
    BILI_BIJI_JCT: str = os.getenv("BILI_BIJI_JCT", "")
    BILI_DEDE_USER_ID: str = os.getenv("BILI_DEDE_USER_ID", "")
    BILI_BUVID_3: str = os.getenv("BILI_BUVID_3", "")
    BILI_REFRESH_TOKEN: str = os.getenv("BILI_REFRESH_TOKEN", "")

    # 调度器
    FETCH_INTERVAL_MINUTES: int = 5
    FETCH_JITTER_SECONDS: int = 30
    REQUEST_INTERVAL_MIN: float = 3.0
    REQUEST_INTERVAL_MAX: float = 5.0
    FETCH_BATCH_SIZE: int = 10          # 每处理 N 个用户休息一次
    FETCH_BATCH_COOLDOWN: int = 60      # 休息秒数
    RATE_LIMIT_COOLDOWN: int = 600      # 触发风控后冷却秒数（10 分钟）

    # VTuber 列表文件
    VTUBER_LIST_FILE: str = str(DATA_DIR / "vtubers.csv")

    # CORS（逗号分隔；"*" 表示全部来源——此时不允许携带凭据，符合浏览器 CORS 规范）
    CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "*")

    # 日志
    LOG_LEVEL: str = "INFO"
    LOG_FILE: str = str(DATA_DIR / "logs" / "app.log")

    # 图片代理（/img-proxy 兜底链路）
    IMG_PROXY_ALLOWED_HOSTS: str = os.getenv("IMG_PROXY_ALLOWED_HOSTS", "hdslb.com")
    IMG_CACHE_DIR: str = str(DATA_DIR / "static" / "img-cache")


settings = Settings()
