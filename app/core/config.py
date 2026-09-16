import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# R14a：可热更键的覆盖层（默认值真源在那边）。注意这里是模块级 import，
# 而 runtime_settings 不反向 import config —— 单向依赖，不会成环。
from app.core import runtime_settings

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
    """进程级配置。

    R14a（devlog/091）加了一道**覆盖层**拦截：`runtime_settings.SPECS` 里的键
    （即"每轮读取、可以热更"的那些）在读取时先问覆盖层，见 `__getattribute__`。
    没进 SPECS 的键（数据目录/端口/凭据/日志/CORS/cron 时刻…）行为完全不变。
    """

    APP_NAME: str = "Better DD Toolkit"
    VERSION: str = "1.0.2"   # 与 devlog 最新版本保持一致（v1.0.0：档案完整性收口 —— 迁移 f004、动态按平台名单、签名来源/覆盖、账号信息历史、日志轮转；覆盖 devlog 060→081）

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
    # ⚠️ R14a（devlog/091）：带「可热更」注释的键会被 `Settings.__getattribute__`
    # 拦一道 —— 读的时候先问 `app/core/runtime_settings.py` 的覆盖层。
    # **这里写的值仍是默认值的真源**（覆盖层里有一份同样的默认值，两者不一致时契约测试会红）。
    # 不改成 property 的原因是：测试与脚本一直用 `monkeypatch.setattr(settings, "X", 0.0)`
    # 这种"临时改一个数"的办法（有时还要改成界面范围外的值，比如 0 秒把流程压快），
    # property 会把这条路堵死。现在的优先级是：**实例属性 > 覆盖层 > 这里的默认值**。
    FETCH_INTERVAL_MINUTES: int = 5
    FETCH_JITTER_SECONDS: int = 30
    REQUEST_INTERVAL_MIN: float = 3.0       # 账号间隔下限（可热更）
    REQUEST_INTERVAL_MAX: float = 5.0       # 账号间隔上限（可热更）
    FETCH_BATCH_SIZE: int = 10          # 每处理 N 个用户休息一次（可热更）
    FETCH_BATCH_COOLDOWN: int = 60      # 休息秒数（可热更）
    RATE_LIMIT_COOLDOWN: int = 600      # 触发风控后冷却秒数（10 分钟；可热更）

    # 收录 / 加账号的快速链路（v0.9.4）：目标「3~6s 内看到账号信息 + 首屏内容」
    MANUAL_FAST_INTERVAL_MIN: float = 0.5   # 单V/收录路径的账号间隔（只在账号之间生效；可热更）
    MANUAL_FAST_INTERVAL_MAX: float = 1.0   # 可热更
    FIRST_SCREEN_VIDEO_PAGES: int = 1       # 首屏：投稿 1 页（列表自带封面/时长/统计；可热更）
    FIRST_SCREEN_DYNAMICS_PAGES: int = 1    # 首屏：动态 1 页（可热更）
    FIRST_SCREEN_DYNAMICS_LIMIT: int = 3    # 首屏：动态最多入库 N 条新帖（每条 1 次详情；可热更）

    # 启动链（v0.6.0）：应用启动后依次执行 直播状态 → 综合档（动态流 + 账号流）
    STARTUP_CHAIN_ENABLED: bool = True
    STARTUP_CHAIN_DELAY: float = 4.0    # 启动后延迟秒数（等后端/前端就绪）
    STARTUP_LIVE_INTERVAL_MIN: float = 0.3   # 直播状态：批量接口（每 100 uid 1 请求），近连续
    STARTUP_LIVE_INTERVAL_MAX: float = 0.6
    STARTUP_DYNAMICS_LIMIT: int = 2          # 最新动态：每个主要账号仅入库最新 N 条新帖
    STARTUP_DYNAMICS_INTERVAL_MIN: float = 3.0
    STARTUP_DYNAMICS_INTERVAL_MAX: float = 5.0
    # 主要活动平台优先级（每 VTuber 仅更新优先级最高的账号）
    PRIMARY_PLATFORM_ORDER: list[str] = ["bilibili", "weibo"]

    # 时效分层调度（v0.6.1；v0.9.3 合并为「综合档」）：T0 直播状态独立线程 +
    # 综合档（动态流每档跑 + 账号流数据驱动到期才跑，两条流同档并发）
    TIER_TICK_SECONDS: int = 10                  # 分层调度心跳（检查到期/让位；只读）
    LIVE_POLL_SECONDS: float = 60.0              # T0 直播状态轮询周期（0=禁用；可热更）
    LIVE_POLL_JITTER_SECONDS: float = 15.0

    # 动态流固定周期：**故意不做可热更**（自适应预算开着时它不参与决策，
    # 放进设置界面就是让人白改）；只读分区里如实列出它为什么不给改。
    DYNAMICS_LATEST_INTERVAL_MINUTES: int = 15   # 动态流（每 V 主账号限 2 帖，≤0=禁用）
    DYNAMICS_LATEST_JITTER_SECONDS: float = 120.0
    # 动态流自适应节奏（v0.9.8，P9-5 用户）：一轮接一轮跑，轮间随机间隔；
    # 频率由**按平台的请求预算**兜底（DYNAMICS_BUDGET_RPM>0 时启用自适应，
    # 否则退回上面的固定周期）
    DYNAMICS_BUDGET_RPM: int = 12                # 单平台每分钟请求预算（可热更）；
                                                 # **自适应**：单平台一轮需求 > 该值时，本平台生效预算
                                                 # 抬到「至少装得下一轮」（平台间独立，见
                                                 # _PlatformBudget._rpm_for）——避免账号数增长后
                                                 # 动态流每轮空等一个整窗口（devlog/055）
    DYNAMICS_MIN_GAP_SECONDS: float = 30.0       # 轮间最小间隔（可热更）
    DYNAMICS_JITTER_SECONDS: float = 15.0        # 轮间随机抖动（±）
    # 需求 R6（2026-09-13 用户定，devlog/070）：「先按平台分类取任务名单，然后并行按名单抓；
    # 一轮 <1min 就休息到 1min，>1min 就按预算休息、不触上限」
    # 需求 R7（同日二次口径，devlog/078）：名单 = **库里所有 V 的所有平台账号**按平台分组，
    # 名单之间并行、**名单内部串行**；间隔按名单长度自适应摊平（见下面三个参数）。
    DYNAMICS_CONCURRENCY: int = 1                # **紧急开关**：1 = 名单内串行（R7 默认）；
                                                 # >1 = 回到 R6 的"平台内并发 N + 起跑闸门"，
                                                 # 仅在需要压缩一轮墙钟时临时启用
    DYNAMICS_MIN_CYCLE_SECONDS: float = 60.0     # 一轮的**周期下限**（按轮**开始**计时，
                                                 # 而不是"轮结束后再睡这么久"；可热更）
    # 名单内间隔（自适应摊平）：gap = clamp((目标时长 − 账号数 × 抓取耗时估计) / 账号数,
    # 下限, 上限) —— 短名单直接命中上限（最保守），长名单才逐档压紧，压到下限还装不下就让
    # 周期自然超过 1 分钟（不为凑时长去猛发请求）。
    DYNAMICS_LANE_TARGET_SECONDS: float = 50.0  # 一条名单的目标轮长（给 60s 周期留余量）
    DYNAMICS_LANE_FETCH_ESTIMATE: float = 1.5   # 单账号抓取耗时估计（用于扣减名额）
    DYNAMICS_LANE_GAP_MIN: float = 2.0          # 名单内间隔下限（再快就谈不上拟人）
    DYNAMICS_LANE_GAP_MAX: float = 5.0          # 名单内间隔上限（与账号流 3~5s 同款）
    # 账号流（原 T1 主账号 + T3a 全量合并）：账号字段变化慢，按「上次抓取时间」判断到期
    ACCOUNT_SWEEP_STALE_HOURS: float = 24.0      # 账号超期阈值（可热更）
    ACCOUNT_SWEEP_MIN_GAP_SECONDS: int = 600     # 两次账号流的硬下限（可热更）

    # 外部第三方数据源（P4）：zeroroku/danmakus 等「已固定化数据」采集
    # 三个开关都可热更（`externals/runner.py::_source_enabled` 每次运行都查一遍），
    # 但 **cron 的时刻** EXTERNAL_RUN_HOUR 只在启动时注册 → 那个键归只读。
    EXTERNAL_ENABLED: bool = True                    # 总开关（可热更）
    EXTERNAL_ZEROROKU_ENABLED: bool = True           # 可热更
    EXTERNAL_DANMAKUS_ENABLED: bool = True           # 可热更
    EXTERNAL_RUN_HOUR: int = 3          # 日任务执行时钟点（3AM，避开抓取高峰；只读：cron 启动时注册）
    # 启动时的外部补抓（v0.9.8，P9-4 用户）：只跑每 V 主账号（更新直播日历/粉丝趋势），
    # 距上次运行不足 STALE_HOURS 则跳过；时间戳存 app_meta（迁移 f003）
    EXTERNAL_STARTUP_CATCHUP_ENABLED: bool = True
    EXTERNAL_STARTUP_STALE_HOURS: float = 24.0

    # VTuber 列表文件
    VTUBER_LIST_FILE: str = str(DATA_DIR / "vtubers.csv")

    # CORS（逗号分隔；"*" 表示全部来源——此时不允许携带凭据，符合浏览器 CORS 规范）
    CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "*")

    # 日志
    LOG_LEVEL: str = "INFO"
    LOG_FILE: str = str(DATA_DIR / "logs" / "app.log")
    # 日志轮转（2026-09-13，devlog/077）：按天切（`app.log.YYYY-MM-DD`）+ 保留 N 份。
    # 原先单文件不轮转，实测长到 5.2MB / 33963 行、跨数月 —— 排查前必须先"按天切一刀"。
    LOG_BACKUP_DAYS: int = int(os.getenv("DDTOOLKIT_LOG_BACKUP_DAYS", "7"))

    # 图片代理（/img-proxy 兜底链路）：B 站图床 + 微博图床
    IMG_PROXY_ALLOWED_HOSTS: str = os.getenv("IMG_PROXY_ALLOWED_HOSTS", "hdslb.com,sinaimg.cn,wbcdn.cn")
    IMG_CACHE_DIR: str = str(DATA_DIR / "static" / "img-cache")
    # 图片磁盘缓存的**容量上限**（R22，2026-09-16）：原来只管时间（TTL 7 天）不管体积，
    # 实测开发档就到 101.7MB / 271 文件，而它是数据目录里涨得最快的一块。
    # 超限后按"最久未用"淘汰（命中会刷新 mtime）——缓存是纯可再生数据，删了只是重下。
    # **不做成界面设置项**：这是个"多大算大"的运维参数，放环境变量 + 让「关于」页显示占用即可，
    # 免得设置窗口又多一行没人看得懂的旋钮。
    IMG_CACHE_MAX_MB: int = int(os.getenv("DDTOOLKIT_IMG_CACHE_MAX_MB", "300"))

    # ── 覆盖层（R14a，devlog/091）──────────────────────────────────────
    def __getattribute__(self, name: str):
        """**可热更键**（SPECS 里的）读取时先问运行时覆盖层。

        优先级：**实例属性 > 覆盖层 > 类属性（默认值）**。

        - 实例属性优先是**刻意保留的后门**：测试与脚本一直用
          `monkeypatch.setattr(settings, "REQUEST_INTERVAL_MIN", 0.0)` 把流程压快，
          那些值常常在设置界面的合法范围之外（例如 0 秒）；这条通路不能被界面口径挡住，
          否则"改一个数让流程跑快"这种最常用的调试手段就没了。
        - 覆盖层是**校验过**的（白名单/类型/范围/跨字段，见 `runtime_settings`），
          只有 `PUT /settings` 和启动时的 `load()` 能写它。
        - 类属性兜底：没人改过就是它。它与覆盖层里的默认值**必须一致**
          （`tests/test_runtime_settings.py` 双向对账），否则就是两份口径。

        代价：所有 `settings.X` 读多一次函数调用 + 集合判断（纳秒级，调用点都是网络/IO 边界）。
        """
        if name in _HOT:
            d = object.__getattribute__(self, "__dict__")
            if name not in d:               # 没有实例属性 → 覆盖层（内部再退回默认值）
                return runtime_settings.get(name)
        return object.__getattribute__(self, name)


# 可热更键集合（SPECS 的键名）。放模块级常量：`__getattribute__` 是热路径，
# 每次读都构造 set 就白费了。
_HOT = frozenset(runtime_settings.SPECS)

settings = Settings()
