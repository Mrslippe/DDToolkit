# -*- coding: utf-8 -*-
"""cookie 串的解析（浏览器扩展导入链路，E1）。

## 为什么单独一个模块

三个地方都要"把 `name=value; name=value` 拆开"：导入端点（算回执里的键名）、
B 站的新入口（认 `SESSDATA`/`bili_jct`）、微博的新入口（认 `SUB`）。
写在任一侧都会让另两侧 import 回来（`auth.py` ← `cookie_import.py` 是反的依赖方向）。

⚠️ `xhs_auth.py` / `douyin_auth.py` 里各有一份 `cookie_keys()` / `missing_keys()`
（它们先落地、有自己的用例与文案）——本批**不动它们**：那是一次纯重构，
与本批"凭据怎么进来"无关，混在一起只会让回滚变难。新代码一律用这里的两条。
"""
from __future__ import annotations


def parse_cookie_header(cookie: str) -> dict[str, str]:
    """`"a=1; b=2"` → `{"a": "1", "b": "2"}`（**保序**，容忍多余空白与尾分号）。

    口径（与浏览器复制出来的那条头一致）：
    - 分隔符是 `;`（`; ` 也认），值里允许 `=`（只按**第一个** `=` 切）；
    - 空段、没有 `=` 的段直接跳过（真实 cookie 头里出现过 `;;` 与尾分号）；
    - **同名保留最后一个**：浏览器给同名的多条时，请求头里靠后的那条是更具体路径的。
    """
    out: dict[str, str] = {}
    for part in (cookie or "").split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, _, value = part.partition("=")
        name = name.strip()
        if name:
            out[name] = value.strip()
    return out


def cookie_key_names(cookie: str) -> list[str]:
    """这条 cookie 里的键名（保序，供回执与日志用 —— **绝不带值**）。"""
    return list(parse_cookie_header(cookie).keys())
