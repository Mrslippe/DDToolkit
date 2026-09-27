"""JSON 解析的**安全版**（第 4 阶段 ① 第二刀，devlog/236）。

## 为什么单独一处

`scheduler._safe_json_parse` 与 `fetcher._safe_json_parse` **长得像、语义不同**：

| 版本 | 保证 | 拿它当什么用 |
|---|---|---|
| scheduler 这份 | 一定给 **dict**（空/非法/非 dict → fallback） | `body_json` / `stats_json` 这些**约定是对象**的列 |
| `fetcher` 那份 | 失败给 `default`（可能是 list / 数字 / None） | 上游响应里形状不定的片段 |

第二刀把 B 站专属实现搬进 `platforms/bilibili_posts.py` 时，新模块两边都不能 import
（import `scheduler` 会成环）⇒ 把 **scheduler 那一版**提到这里，scheduler 用
`from app.core.jsonsafe import safe_json_dict as _safe_json_parse` 继续用旧名字，
11 处调用点与既有判据一行都不用改。

⚠️ **没顺手合并 fetcher 那份**：合并等于把两种语义悄悄改成一种，而调用方是照着自己那份的
语义写的（list / str 都会被读出来）—— "顺手改口径"正是本仓最忌讳的一类改动。
"""
from __future__ import annotations

import json


def safe_json_dict(s: str | None, fallback: dict | None = None) -> dict:
    """安全解析 JSON 字符串为**字典**。

    空值 / 非法 JSON / 解析出来不是 dict ⇒ 一律返回 `fallback`（默认空字典）。
    """
    if fallback is None:
        fallback = {}
    if not s:
        return fallback
    try:
        parsed = json.loads(s)
        return parsed if isinstance(parsed, dict) else fallback
    except (json.JSONDecodeError, TypeError):
        return fallback
