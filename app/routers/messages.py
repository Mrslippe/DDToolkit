"""推送通道（M0，devlog/241）：`GET /messages/stream`（SSE over fetch）。

## 为什么是 "SSE over fetch" 而不是 `EventSource`

业务端点全要 `X-DDToolkit-Token`（`app/core/api_auth.py`），而浏览器原生 `EventSource`
**不支持自定义请求头** ⇒ 它只能把 token 拼进 URL —— 那是方案里的**硬停止条件**
（token 会进日志/历史）。所以这里用 `fetch` + `ReadableStream` 读同一个 `text/event-stream`：
**token 走 header，不进 URL**（前端侧见 M0b 的 `utils/eventStream.ts`）。

## 帧格式

```
: connected                ← 首帧注释行：客户端据此知道"流真的建起来了"
id: 42                     ← 消息序号（重连时前端回填到 Last-Event-ID）
data: {"type": ..., ...}

: ping                     ← 心跳（注释行），防中间层掐掉空闲连接
```

⚠️ **只在带 `Last-Event-ID` 时补发历史**（重连语义）：首次订阅不重播 ——
否则每开一次窗都会重放整段历史（前端会弹一串历史 toast）。补发的帧里 `replay: true`。

## 与 `fetch-status` 轮询的关系

**并存**：轮询是一致性兜底（推送漏发、重连窗口内的消息）。本模块**不退役**轮询。

## dev-only 的合成发布钩子

在 `app/routers/messages_debug.py`（单独模块、单独 include、带守卫），入口是本文件的
`include_debug_routes(app)` —— 生产态返回 False，路由表里**根本没有**那条路径。
"""
import asyncio
import json
import logging
from typing import AsyncIterator, Optional

from fastapi import APIRouter, Header, Request
from fastapi.responses import StreamingResponse

from app.core.config import settings
from app.services import messages as M

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/messages", tags=["messages"])


def _frame(msg: M.Message) -> str:
    """一条消息 → SSE 帧（`id:` + `data:` + 空行）。"""
    return (f"id: {msg.seq}\n"
            f"data: {json.dumps(msg.to_json(), ensure_ascii=False, separators=(',', ':'))}\n\n")


async def stream_events(last_event_id: Optional[str] = None,
                        request: Request | None = None) -> AsyncIterator[str]:
    """SSE 生成器：首帧注释行 →（可选）补发历史 → 一直推、中间夹心跳。

    ⚠️ 生成器被关闭（客户端断开）时**必须退订** —— 那是 V4（不留悬挂订阅）的真实路径。
    """
    hub = M.HUB
    sub = hub.subscribe()
    try:
        # 首帧立刻给一条注释行：客户端据此知道"流真的建起来了"，测试/探针也不必去赌心跳周期。
        yield ": connected\n\n"
        if last_event_id:
            try:
                since = int(str(last_event_id).strip())
            except (TypeError, ValueError):
                since = 0
            for msg in hub.replay_since(since):
                yield _frame(msg)
        while True:
            try:
                msg = await asyncio.wait_for(sub.queue.get(), timeout=M.HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                yield ": ping\n\n"          # 空闲：发心跳（客户端忽略注释行）
                continue
            except asyncio.CancelledError:
                raise
            yield _frame(msg)
    finally:
        hub.unsubscribe(sub)


@router.get("/stream")
async def messages_stream(request: Request,
                          last_event_id: Optional[str] = Header(None, alias="Last-Event-ID")):
    """推送通道（**不在公开白名单**：token 由中间件校验，走 header）。"""
    return StreamingResponse(
        stream_events(last_event_id=last_event_id, request=request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def dev_mode() -> bool:
    """是不是开发态（探针 / `npm run dev`）：**只有** `DEV_API_TOKEN` 非空才算。

    ⚠️ 不用"`API_TOKEN` 空"当判据：真机与生产都有 `API_TOKEN`，而**都没有** dev token。
    """
    return bool((getattr(settings, "DEV_API_TOKEN", "") or "").strip())


def include_debug_routes(app) -> bool:
    """把合成发布钩子挂到 `app` 上（**仅 dev**），返回是否挂了。生产态返回 False。"""
    if not dev_mode():
        return False
    from app.routers import messages_debug
    app.include_router(messages_debug.router)
    return True
