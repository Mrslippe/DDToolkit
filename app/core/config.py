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
    VERSION: str = "0.6.0"   # 与 devlog 最新版本保持一致（v0.6.0：P4 外部数据源）

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

    # 微博 API（扫码登录后写入：SUB/SUBP/SSOLoginState/M_WEIBOCN_PARAMS 组合串；
    # 未登录时为空。UID/昵称供登录态展示）
    WEIBO_COOKIE: str = os.getenv("WEIBO_COOKIE", "")
    WEIBO_UID: str = os.getenv("WEIBO_UID", "")
    WEIBO_NAME: str = os.getenv("WEIBO_NAME", "")

    # 调度器
    FETCH_INTERVAL_MINUTES: int = 5
    FETCH_JITTER_SECONDS: int = 30
    REQUEST_INTERVAL_MIN: float = 3.0
    REQUEST_INTERVAL_MAX: float = 5.0
    FETCH_BATCH_SIZE: int = 10          # 每处理 N 个用户休息一次
    FETCH_BATCH_COOLDOWN: int = 60      # 休息秒数
    RATE_LIMIT_COOLDOWN: int = 600      # 触发风控后冷却秒数（10 分钟）

    # 外部第三方数据源（P4）：zeroroku/danmakus 等「已固定化数据」采集
    EXTERNAL_ENABLED: bool = True
    EXTERNAL_ZEROROKU_ENABLED: bool = True
    EXTERNAL_DANMAKUS_ENABLED: bool = True
    EXTERNAL_RUN_HOUR: int = 3          # 日任务执行时钟点（3AM，避开抓取高峰）

    # VTuber 列表文件
    VTUBER_LIST_FILE: str = str(DATA_DIR / "vtubers.csv")

    # CORS（逗号分隔；"*" 表示全部来源——此时不允许携带凭据，符合浏览器 CORS 规范）
    CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "*")

    # 日志
    LOG_LEVEL: str = "INFO"
    LOG_FILE: str = str(DATA_DIR / "logs" / "app.log")

    # 图片代理（/img-proxy 兜底链路）：B 站图床 + 微博图床
    IMG_PROXY_ALLOWED_HOSTS: str = os.getenv("IMG_PROXY_ALLOWED_HOSTS", "hdslb.com,sinaimg.cn,wbcdn.cn")
    IMG_CACHE_DIR: str = str(DATA_DIR / "static" / "img-cache")


settings = Settings()
