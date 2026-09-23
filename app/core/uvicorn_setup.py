"""uvicorn 服务器构造（R43-A，devlog/163）。

**为什么单独抽出来**：`backend_main.py` 里的 `uvicorn.Config(...)` 是那次
"`logs/app.log` 恒为 0 字节"事故的发生点，而它原来内联在脚本里 ⇒ **测不到**
（脚本 import 就跑主流程，pytest 里没法安全地构造一次）。抽成纯函数之后，
`tests/test_uvicorn_logging.py` 能照着**启动路径**复现那个机制并断言日志真的落盘。
"""
import uvicorn


def build_uvicorn_config(app, port: int) -> uvicorn.Config:
    """按启动路径构造 uvicorn 配置。

    ⚠️ **`log_config=None` 是必须的**（2026-09-23 事故的修复）：
    uvicorn 的 `Config` 默认带 `log_config=LOGGING_CONFIG`，**启动时会
    `dictConfig(...)`，而它默认 `disable_existing_loggers: True`** ——
    `import app.main` 时装好的应用 logger（`app.services.scheduler` 等）会被整体禁用
    ⇒ 文件 handler 在、却一条都写不进去（实测 `app.log` 0 字节、mtime 是启动时刻）。
    这与本仓记录过的"basicConfig 先执行 ⇒ 文件 handler 被静默忽略"是**同一类事故**。

    `log_config=None` 表示"uvicorn 不要碰日志配置"：应用自己的 handler 原样保留，
    uvicorn 的日志则走 root（也就一起进 `app.log`，正是排查时想要的）。
    """
    return uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
