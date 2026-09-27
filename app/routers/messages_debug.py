"""**dev-only** 的合成发布钩子（M0，devlog/241；方案 `docs/design/notices/message-hub-execution.md` §8.3）。

## 为什么单独一个模块

两个理由，都不是洁癖：

1. **它不许进生产** —— 所以它必须和真正的端点**分开 include**（`messages.include_debug_routes(app)`
   里带守卫）。放同一个 router 里就只能"注册了再关掉"，而那是另一回事。
2. **路由计数口径**（`scripts/gen_doc_numbers.py` 只数 `@router.<verb>`）—— 用 `debug_router`
   这种名字会让新端点从计数里消失，于是"路由表漂了"这件事没人发现。**单独模块 + 标准名
   `router`** 让它老实出现在计数里。

## 探针为什么需要它

探针没法让后端**自然**产生一条通知（开播要真开播、风控要真被限流），而"通道通了"
恰恰是 M0 唯一的产出 ⇒ 给探针一条能自己造消息的路。生产态这条路**不存在**（不是关着）。
"""
from fastapi import APIRouter, HTTPException

from app.services import messages as M

router = APIRouter(prefix="/messages/_debug", tags=["messages"])


@router.post("/publish")
async def debug_publish(payload: dict):
    """合成一条消息推进 hub（仅 dev 注册）。

    body：`{"type": "notice.message", "payload": {"text": "…"}}`；
    `type` 不在 `messages.KNOWN_TYPES` 里 ⇒ **400**（并把合法值列出来）。
    """
    msg_type = str((payload or {}).get("type") or "")
    body = (payload or {}).get("payload") or {}
    try:
        seq = M.HUB.publish(msg_type, body if isinstance(body, dict) else {})
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return {"status": "published", "seq": seq}
