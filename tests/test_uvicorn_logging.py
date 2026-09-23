# -*- coding: utf-8 -*-
"""R43-A：后端日志必须真的落盘（devlog/163）。

**为什么单独有这一支**：2026-09-23 的启动里 `logs/app.log` 是 **0 字节** ——
文件被创建了、一条记录都没写进去。根因：`backend_main.py` 用
`uvicorn.Config(app, ..., log_level="warning")` 构造服务器，而 uvicorn 默认带
`log_config=LOGGING_CONFIG`，**构造/启动时会 `dictConfig(...)`，它默认
`disable_existing_loggers: True`** —— 于是**在它之前**就已创建的应用 logger
（`app.services.scheduler` 等，`import app.main` 时就有了）被整体禁用 ✗。

这正是 `logging_setup.py` docstring 与 `scheduler.py:45` 记录过的**同一类事故**
（"basicConfig 先执行 ⇒ main.py 里的文件 handler 配置被静默忽略 ⇒ app.log 恒为空"），
只是换了个入口。所以护栏要**照着那个机制**写：先装文件 handler，再按启动路径构造服务器
并触发它的日志配置，然后写一条日志 —— **它必须落进文件**。
"""
import logging
from pathlib import Path

from app.core.logging_setup import setup_logging


def _app_logger() -> logging.Logger:
    """模拟 `app.services.scheduler` 这类**在 import app.main 时就存在**的 logger。"""
    return logging.getLogger("app.services.scheduler")


def _reset_root() -> None:
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
        h.close()
    root.setLevel(logging.NOTSET)


def test_uvicorn_log_config_keeps_app_loggers_alive(tmp_path: Path) -> None:
    """**核心护栏**：走启动路径之后，应用 logger 写的东西必须出现在 app.log 里。

    反向验证：把 `build_uvicorn_config` 里的 `log_config=None` 去掉（用 uvicorn 默认配置）
    ⇒ 这条立刻红（文件 0 字节）。
    """
    from app.core.uvicorn_setup import build_uvicorn_config

    _reset_root()
    log_file = tmp_path / "app.log"
    setup_logging("INFO", log_file, 7)          # = `import app.main` 时做的事
    lg = _app_logger()
    assert lg.isEnabledFor(logging.INFO), "装完 handler 之后应用 logger 该是开着的"

    cfg = build_uvicorn_config(object(), 1234)
    cfg.configure_logging()                     # uvicorn 启动时会走这一步（就是事故点）

    lg.info("这条必须落盘：后端就绪")
    for h in logging.getLogger().handlers:
        h.flush()

    assert log_file.exists(), "文件 handler 应当已经创建了 app.log"
    assert "这条必须落盘" in log_file.read_text(encoding="utf-8"), (
        "应用日志没落盘 —— uvicorn 的 dictConfig 把既有 logger 关了"
        "（disable_existing_loggers 默认 True）")


def test_build_uvicorn_config_keeps_uvicorn_quiet_but_present(tmp_path: Path) -> None:
    """顺带钉住：配置本身仍然把 uvicorn 的日志级别留在 warning（不改变既有静音口径）。"""
    from app.core.uvicorn_setup import build_uvicorn_config

    cfg = build_uvicorn_config(object(), 1234)
    assert cfg.log_level == "warning"
    assert cfg.host == "127.0.0.1" and cfg.port == 1234


def test_setup_logging_is_idempotent(tmp_path: Path) -> None:
    """重复调用不该叠加 handler（每次启动只该有一个文件 handler）。"""
    _reset_root()
    log_file = tmp_path / "app.log"
    setup_logging("INFO", log_file, 7)
    n1 = len(logging.getLogger().handlers)
    setup_logging("INFO", log_file, 7)
    assert len(logging.getLogger().handlers) == n1
    _reset_root()
