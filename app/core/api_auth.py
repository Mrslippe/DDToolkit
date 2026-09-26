# -*- coding: utf-8 -*-
"""sidecar 会话 token 的校验层（S1，devlog/201）。

## 为什么需要它

后端监听 `127.0.0.1:<随机端口>`，而**端口可以扫**。在此之前，本机任何进程、
以及任何网页（`CORS_ORIGINS` 默认 `"*"`）都能读到全部归档、改数据、触发抓取；
而 `.env` 里躺着**活的登录凭据**（B 站 SESSDATA + refresh token、微博 cookie）。

## 口径

- token 由 Tauri **每次启动生成**、只存内存，经 sidecar 的 env 传入（`DDTOOLKIT_API_TOKEN`）；
- 请求头固定为 `X-DDToolkit-Token`（**不用 Authorization**：`/img-proxy` 的响应可能被
  `<img>` 直接消费，少一个有语义的公共头就少一类误用；也不用 cookie —— 那会引入 CSRF 面）；
- 比较走 `hmac.compare_digest`（常量时间）；
- **失败统一 401，绝不回显 token**；
- 开发态（没有 Tauri、或用户显式指定）允许 `DDTOOLKIT_DEV_API_TOKEN` 当固定 token ——
  探针 `scripts/ui_probe.py` 与 `npm run dev` 走这条，否则整条布局回归网会集体 401 假绿。

## 为什么有"公开路径"这个白名单

`<img>` 直连（`/static/*` 与 `/img-proxy`）**带不了自定义头**；给它们加鉴权就得把整条
图片链路改成 blob 拉取再转 objectURL（母计划把它列为停止条件之一）。
`/healthz` 还兼着桌面端的就绪探活（`main.tsx` 轮询它 240 次），也必须公开。

⇒ 这**三处是本机可读的**，这是**有意留下的**，不是漏配。它们的边界是：
`/healthz` 只返回最小启动信息；`/static/*` 只是图片与自绘背景；
`/img-proxy` 有主机白名单 + 逐跳校验 + 类型/体积上限，且**只能取图床**。

## 反过来说：这条中间件不是"防住本机攻击者"

同机同用户下能读进程内存的攻击者本来就赢了。它挡的是**"本机随机进程/网页顺手打一发"**
这一类（含 DNS rebinding 绕过 CORS 的那一类），并且让"以后要放宽 CORS"不再等于"交出数据"。
"""
from __future__ import annotations

import hmac
import logging

from fastapi import Request
from fastapi.responses import JSONResponse

from app.core.config import settings

logger = logging.getLogger(__name__)

TOKEN_HEADER = "X-DDToolkit-Token"

# 公开路径（**精确前缀**，见模块 docstring 的取舍说明）
PUBLIC_PREFIXES = ("/healthz", "/static/")
# 公开的**单个路径 + 方法**组合（`/img-proxy` 只在 GET 上公开：
# 它没有写语义，但把方法限死可以让"以后给它加个 POST"自动落进要鉴权的那一侧）
PUBLIC_EXACT = {("GET", "/img-proxy")}

# 前端在没有 token 时会看到一串 401；把这一句做成常量，测试与文档都引用它
MISSING_TOKEN_DETAIL = "缺少或无效的访问令牌（本机应用启动时生成）"


def _expected_token() -> str:
    """当前应当接受的 token：生产用启动注入的，开发态回退到显式固定值。

    ⚠️ **每次读**而不是模块级快照：Tauri 注入的是进程环境变量，而测试要在用例里换值。
    读两次 `settings.X` 的成本相对一次 HTTP 请求可以忽略。
    """
    return (getattr(settings, "API_TOKEN", "") or "").strip() or \
           (getattr(settings, "DEV_API_TOKEN", "") or "").strip()


def token_configured() -> bool:
    """有没有配到 token（两种来源任一即可）。

    为什么需要一个显式函数：**没配 token 时应用一切正常**，只是门没了 ——
    这正是最容易被忽略的一类失效。启动时会拿它决定要不要**大声告警**。
    """
    return bool(_expected_token())


def is_public(method: str, path: str) -> bool:
    """这条请求是否属于"公开路径"（纯函数，便于单测与排查）。"""
    if (method.upper(), path) in PUBLIC_EXACT:
        return True
    return any(path == p or path.startswith(p) for p in PUBLIC_PREFIXES)


def is_authorized(method: str, path: str, presented: str | None) -> tuple[bool, str]:
    """返回 `(是否放行, 原因)`。**原因只用于日志，绝不含 token 本身。**

    分开成纯函数是为了能直接测"哪条路径该公开"，而不必每次发一个真请求。
    """
    if is_public(method, path):
        return True, "public"
    expected = _expected_token()
    if not expected:
        # ⚠️ **没配 token ⇒ 拒绝**（S1 收口，devlog/202）。
        #
        # 批次 1 期间这里是"放行"（让"前端 token 注入尚未落地"时应用仍可用）。
        # 现在前端两个入口都会注入，放行只剩坏处：**"没配"与"配了"在行为上无法区分**，
        # 而症状恰恰是"一切正常" —— 本仓最忌讳的那类静默失效。
        #
        # 真机不可能走到这里（Tauri 一定注入）；开发态走 `DDTOOLKIT_DEV_API_TOKEN`。
        # 真走到了，说明启动方式不对 —— 每个请求各回一个 401 是**吵闹**的失败，
        # 比安静地不设防好。
        return False, "no-token-configured"
    if not presented:
        return False, "missing"
    if hmac.compare_digest(presented, expected):
        return True, "ok"
    return False, "mismatch"


async def require_token(request: Request, call_next):
    """FastAPI 中间件：按上面的分级放行或 401。"""
    allowed, why = is_authorized(
        request.method,
        request.url.path,
        request.headers.get(TOKEN_HEADER),
    )
    if not allowed:
        # 日志留痕但**不回显任何 token 片段**（连长度都不写）
        logger.warning("拒绝未授权请求：%s %s（%s）", request.method, request.url.path, why)
        return JSONResponse(status_code=401, content={"detail": MISSING_TOKEN_DETAIL})
    return await call_next(request)
