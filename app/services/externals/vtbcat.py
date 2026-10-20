"""vtb.cat 适配器（**最小面**）：只取 `/live/list` 的聚合字段，用于质量闸对账。

## 为什么只做这一层

`plans/fan-model-plan.md` §质量闸 定的口径：外部源的职责是**校验器**，不是真源。
校验只要"每场有多少条弹幕 / 多少钱"，而 `/live/list` 一次请求就给全部场次，
不需要 protobuf、不需要逐分钟曲线。逐分钟（`/chart/live`）留给后续的 C4。

## 两个已知坑（沿用 2026-10-17 实测）

1. `https://vtb.cat/api/*` 被 Cloudflare 人机验证挡住，**只能用 `api.vtb.cat` 的无前缀路径**；
2. `StartAt` 存的是"把北京墙上时间当 UTC 的 epoch" ⇒ 真实 UTC epoch = `StartAt - 8h`；
   `EndAt` 是坏的，**不能**用来判重叠或时长。
"""

from __future__ import annotations

import httpx

from app.core.useragent import UA_CHROME

BASE = "https://api.vtb.cat"
#: StartAt 与真实 UTC epoch 的固定偏移（见模块头 ②）
START_OFFSET_S = 8 * 3600
#: 匹配容差：同一场在两个源的开播时刻可能差几分钟
MATCH_TOLERANCE_S = 3600
#: vtb 自己收录过少的场次不参与"我们是不是漏了"的判断（它没索引完）
MIN_VTB_MESSAGES = 100

HEADERS = {"User-Agent": UA_CHROME, "Accept": "application/json"}


async def fetch_lives(mid: str, *, limit: int = 1000,
                      client: httpx.AsyncClient | None = None) -> list[dict]:
    """取该 V 在 vtb.cat 上的全部场次（一次请求）。失败返回空列表，**不抛**。"""
    own = client is None
    client = client or httpx.AsyncClient(timeout=30, headers=HEADERS, trust_env=False)
    try:
        r = await client.get(f"{BASE}/live/list",
                             params={"uid": str(mid), "limit": limit, "page": 1})
        if r.status_code != 200 or r.content[:1] != b"{":
            return []
        return list((r.json() or {}).get("lives") or [])
    except (httpx.HTTPError, ValueError):
        return []
    finally:
        if own:
            await client.aclose()


def match_session(lives: list[dict], our_start_ms: int,
                  *, tolerance_s: int = MATCH_TOLERANCE_S) -> dict | None:
    """按开播时刻把我们的场次对上 vtb 的一条；对不上返回 `None`。

    比较的是"vtb.StartAt"与"我们的 UTC epoch + 8h"，因为两者基准差 8 小时。
    """
    if not lives:
        return None
    target = our_start_ms / 1000 + START_OFFSET_S
    best = min(lives, key=lambda x: abs(float(x.get("StartAt") or 0) - target))
    if abs(float(best.get("StartAt") or 0) - target) > tolerance_s:
        return None
    return best
