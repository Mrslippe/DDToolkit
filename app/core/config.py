import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# 项目根（源码所在位置）；PyInstaller frozen 后指向打包目录（_MEIPASS）
# —— alembic.ini / alembic/ 迁移脚本由 build_backend.py 的 --add-data 打入
PROJECT_ROOT = Path(
    getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent.parent)
) if getattr(sys, "frozen", False) else Path(__file__).resolve().parent.parent.parent

# 数据根目录：桌面端打包后通过环境变量重定向（如 %APPDATA%/DDtoolkit）；
# 缺省 = 项目根，开发行为不变。数据库/日志/缓存/凭据均落在此处。
DATA_DIR = Path(os.getenv("DDTOOLKIT_DATA_DIR", str(PROJECT_ROOT))).resolve()

load_dotenv(DATA_DIR / ".env")


class Settings:
    APP_NAME: str = "Better DD Toolkit"
    VERSION: str = "0.9.2"   # 与 devlog 最新版本保持一致（v0.9.2：扫码登录修复·直装版资源打包修复·布局滚动条·首启登录浮窗·用户 LOGO）

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

    # 启动链（v0.6.0）：应用启动后依次执行 直播状态 → 主要账号信息 → 最新动态
    STARTUP_CHAIN_ENABLED: bool = True
    STARTUP_CHAIN_DELAY: float = 4.0    # 启动后延迟秒数（等后端/前端就绪）
    STARTUP_LIVE_INTERVAL_MIN: float = 0.3   # 直播状态：批量接口（每 100 uid 1 请求），近连续
    STARTUP_LIVE_INTERVAL_MAX: float = 0.6
    STARTUP_MAIN_INTERVAL_MIN: float = 2.0   # 主要账号信息：每 V 1 账号（1~2 请求）
    STARTUP_MAIN_INTERVAL_MAX: float = 3.5
    STARTUP_DYNAMICS_LIMIT: int = 2          # 最新动态：每个主要账号仅入库最新 N 条新帖
    STARTUP_DYNAMICS_INTERVAL_MIN: float = 3.0
    STARTUP_DYNAMICS_INTERVAL_MAX: float = 5.0
    # 主要活动平台优先级（每 VTuber 仅更新优先级最高的账号）
    PRIMARY_PLATFORM_ORDER: list[str] = ["bilibili", "weibo"]

    # 时效分层调度（v0.6.1）：T0 直播状态独立线程 + T1/T2/T3a 分层轮询
    TIER_TICK_SECONDS: int = 10                  # 分层调度心跳（检查到期/让位）
    LIVE_POLL_SECONDS: float = 60.0              # T0 直播状态轮询周期（0=禁用；独立线程，不占锁）
    LIVE_POLL_JITTER_SECONDS: float = 15.0
    ACCOUNT_PRIMARY_INTERVAL_MINUTES: int = 5    # T1 主要账号信息（每 V 主账号，≤0=禁用）
    ACCOUNT_PRIMARY_JITTER_SECONDS: float = 30.0
    DYNAMICS_LATEST_INTERVAL_MINUTES: int = 15   # T2 最新动态（每 V 主账号限 2 帖，≤0=禁用）
    DYNAMICS_LATEST_JITTER_SECONDS: float = 120.0
    # T3a 全量账号（含非主账号）随 T2 周期执行（紧接 T2 之后，频率相同，2026-09-05 定稿）
    FULL_ACCOUNT_AFTER_T2: bool = True

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
