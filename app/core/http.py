"""共享 HTTP 客户端构造（v0.9.4 抓取提速）。

**问题**：`httpx.AsyncClient()` 每次构造都会新建 `ssl.SSLContext` 并
`load_verify_locations`（本机实测 ~0.4s/个，且是**同步阻塞**，会卡住事件循环）。
抓取任务每个都要建 1~2 个客户端，等于白付 ~1s；收录新 V 时账号信息与首屏内容
各建一个，串行叠加 ≈2s，比真实网络往返还贵。

**做法**：把 SSLContext 做成进程级缓存（与 httpx 默认行为等价：certifi 证书链，
并尊重 `SSL_CERT_FILE` / `SSL_CERT_DIR`），所有抓取客户端复用同一个上下文，
构造耗时降到 ~0.1s。SSLContext 与事件循环无关，因此在
「每个档位 `asyncio.run()` 各起一个循环」的调度模型下也可以安全共享。

用法：新代码一律 `new_async_client(timeout)` 代替 `httpx.AsyncClient(timeout=...)`。
"""
from __future__ import annotations

import os
import ssl

import certifi
import httpx

_SSL_CONTEXT: ssl.SSLContext | None = None


def ssl_context() -> ssl.SSLContext:
    """进程级缓存的默认 SSL 上下文（等价于 httpx `verify=True` 的默认构造）。"""
    global _SSL_CONTEXT
    if _SSL_CONTEXT is None:
        if os.environ.get("SSL_CERT_FILE"):
            _SSL_CONTEXT = ssl.create_default_context(cafile=os.environ["SSL_CERT_FILE"])
        elif os.environ.get("SSL_CERT_DIR"):
            _SSL_CONTEXT = ssl.create_default_context(capath=os.environ["SSL_CERT_DIR"])
        else:
            _SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
    return _SSL_CONTEXT


def new_async_client(timeout: float = 15.0, **kwargs) -> httpx.AsyncClient:
    """抓取/探活用的 AsyncClient：复用进程级 SSL 上下文。

    其余参数原样透传（headers 等）；调用方语义不变，仍需自行 `aclose()`。
    """
    kwargs.setdefault("verify", ssl_context())
    return httpx.AsyncClient(timeout=timeout, **kwargs)
