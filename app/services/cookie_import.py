# -*- coding: utf-8 -*-
"""浏览器扩展的**凭据导入**（`POST /auth/import`，E1）。

## 这个模块负责什么

把扩展推来的一条 cookie（+ 抖音的 UA）交给**该平台自己的入口**校验并落盘，
然后回一张**同一形状**的回执（成功与否都一个形状，扩展侧不用分两套解析）。

## 三条口径（都是踩过才知道的）

1. **一条判据只留一处**：缺哪些必需键由**各平台自己的校验器**说了算 ——
   小红书/抖音用它们既有的 `missing_keys()`，B 站/微博本批补上（它们此前没有离线键校验，
   B 站只有扫码、微博的 `apply_cookie` 连校验都没有）。这里**不抄一份键清单**去判"缺不缺"，
   只在回执里报"这条 cookie 里有哪些键"。
2. **回执只给键名与数量，绝不回显值**：值进日志/界面就是二次泄露（`devlog/353` 那类事故的邻居）。
3. **"上游说未登录"与"连不上上游"是两件事**：
   - 前者 ⇒ 拒收（400），内存与 `.env` 都还原（不许拿一条过期的冲掉好凭据）；
   - 后者 ⇒ **照样保存**，但 `verified=false` + `note` 如实说"没验成"。
   理由：今天的手抄路径**根本不校验**，网络抖一下就拒绝同步是**倒退**；
   但也不能假装验过了 —— 那会让用户以为"回执绿 = 一定能抓"。
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field

from app.services.auth import auth_manager
from app.services.cookie_parse import cookie_key_names
from app.services.douyin_auth import douyin_auth_manager, missing_keys as douyin_missing
from app.services.weibo_auth import weibo_auth_manager
from app.services.xhs_auth import missing_keys as xhs_missing
from app.services.xhs_auth import xhs_auth_manager

#: 配对凭证的头（凭证本身的生成/校验在 `services/pairing.py`；**与应用 token 分开**）
PAIR_HEADER = "X-DDToolkit-Pair"

#: 平台 → 显示名（回执与日志用；与 `LOGIN_TABS` 同名的四个）
PLATFORM_LABELS = {
    "bilibili": "B 站",
    "weibo": "微博",
    "xiaohongshu": "小红书",
    "douyin": "抖音",
}

#: 回执里 `keys` 显示哪些（**按平台实际会用的键**，不是整条 cookie 的几十个键）。
#: 顺序即显示顺序；`UIFID_TEMP` 与 `uifid` 是同一个位置的两写法（抖音两种都可能出现）。
USED_KEYS: dict[str, tuple[str, ...]] = {
    "bilibili": ("SESSDATA", "bili_jct", "DedeUserID", "buvid3", "buvid4"),
    "weibo": ("SUB", "SUBP", "SSOLoginState", "ALF"),
    "xiaohongshu": ("a1", "web_session", "webId"),
    "douyin": ("uifid", "UIFID_TEMP", "s_v_web_id", "ttwid"),
}

#: B 站/微博的必需键（这两家此前没有离线键校验）。小红书/抖音**不列在这里** ——
#: 它们的必需键由各自模块的 `missing_keys()` 说了算（一条判据只留一处）。
REQUIRED_KEYS: dict[str, tuple[str, ...]] = {
    "bilibili": ("SESSDATA", "bili_jct"),
    "weibo": ("SUB",),
}


@dataclass
class ImportReceipt:
    """回执（成功与失败**同一形状**）。"""

    ok: bool
    platform: str
    #: 这次实际会用到、且确实在 cookie 里的键名（**只有名字**）
    keys: list[str] = field(default_factory=list)
    #: 缺的必需键（`ok=False` 时可能是它，也可能不是 —— 看 `note`）
    missing: list[str] = field(default_factory=list)
    #: 这条 cookie 一共几个键（用户对着 F12 一眼能看出"是不是只复制了半条"）
    cookie_keys: int = 0
    #: 上游**确认过**登录态吗（`false` 而 `ok=true` ⇒ 保存了但没验成，`note` 里说明）
    verified: bool = False
    #: **哪几个有用的键不是这次从浏览器读到的**，而是从"应用里已有那份"补上的
    #: （浏览器里那两类指纹 cookie 是页面 JS 铸的，可能压根没有 —— 见 `merge_cookie_strings`）
    from_stored: list[str] = field(default_factory=list)
    #: 给人看的一句话（失败原因 / 成功备注）
    note: str = ""

    def as_dict(self) -> dict:
        return {
            "ok": self.ok,
            "platform": self.platform,
            "label": PLATFORM_LABELS.get(self.platform, self.platform),
            "keys": self.keys,
            "missing": self.missing,
            "cookie_keys": self.cookie_keys,
            "verified": self.verified,
            "from_stored": self.from_stored,
            "note": self.note,
        }


def is_loopback(host: str | None) -> bool:
    """来源是不是回环地址（纯函数：端点里那一条依赖它，用例直接测它）。

    ⚠️ **`localhost` 不算**：`request.client.host` 是**已经解析过的**对端 IP，
    真出现域名说明有人在前头挂了别的东西 —— 那种情况该拒，不该猜。
    `0.0.0.0` 同理（它是"监听任意地址"的写法，不是某个来源）。
    """
    if not host:
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _used_keys(platform: str, cookie: str) -> list[str]:
    names = set(cookie_key_names(cookie))
    return [k for k in USED_KEYS.get(platform, ()) if k in names]


def stored_cookie(platform: str) -> str:
    """应用**现在存着**的那条 cookie（各平台自己的入口；没配过就是空串）。

    用它做"补齐"的来源，见 `merge_cookie_strings` 的说明。
    """
    if platform == "bilibili":
        return auth_manager.cookie_str
    if platform == "weibo":
        return weibo_auth_manager.cookie
    if platform == "xiaohongshu":
        return xhs_auth_manager.cookie
    return douyin_auth_manager.cookie


def merge_cookie_strings(browser: str, stored: str) -> tuple[str, list[str]]:
    """**浏览器读到的键优先，应用里已有而这次没读到的键保留**。

    为什么需要它（2026-10-06 用户实测）：浏览器里那两类 cookie 是**页面 JS 铸的**
    （小红书 `a1`、抖音 `s_v_web_id`），会被清、会过期、也可能压根没铸过；而**登录凭证**
    （`web_session` / `sessionid` / `SESSDATA`）在。只按"浏览器这一条"判缺键，
    这些平台上就永远同步不了 —— 而应用里那份可能正好有那个指纹键（用户上次手抄的）。

    三条口径：
    - **同名以浏览器为准**（新的那份更新）；
    - **只增不删**（既有 cookie 里浏览器这次没给的键一个都不动 —— 与设计案 §3.3
      "只写不删"同一条），所以这次同步**不会把应用里能用的凭据弄坏**；
    - 返回"哪些键来自应用已有"（`from_stored`），回执与界面**如实说出来**
      （用户要知道"这个键不是这次从浏览器读到的"）。

    ⚠️ 顺序：先应用已有的键、再浏览器新给的键；同名已在前面出现过 ⇒ 只更新值不换位置。
    """
    from app.services.cookie_parse import parse_cookie_header

    stored_map = parse_cookie_header(stored)
    browser_map = parse_cookie_header(browser)
    merged: dict[str, str] = dict(stored_map)
    merged.update(browser_map)                       # 浏览器优先
    parts = [f"{k}={v}" for k, v in merged.items()]
    from_stored = [k for k in stored_map if k not in browser_map]
    return "; ".join(parts), from_stored


def _missing_required(platform: str, cookie: str) -> list[str]:
    """缺的必需键 —— **各平台自己的权威**（见模块 docstring 第 1 条）。"""
    if platform == "xiaohongshu":
        return list(xhs_missing(cookie))
    if platform == "douyin":
        return list(douyin_missing(cookie))
    names = set(cookie_key_names(cookie))
    return [k for k in REQUIRED_KEYS.get(platform, ()) if k not in names]


def _reject(platform: str, cookie: str, why: str,
            missing: list[str] | None = None) -> ImportReceipt:
    return ImportReceipt(ok=False, platform=platform, keys=_used_keys(platform, cookie),
                         missing=list(missing or []), cookie_keys=len(cookie_key_names(cookie)),
                         verified=False, note=why)


async def apply(platform: str, cookie: str, ua: str = "") -> ImportReceipt:
    """校验并落盘一条凭据；返回回执（**不抛异常** —— 失败也是一种回执）。

    流程：**先与"应用里已有那条"合并**（浏览器读到的键优先、已有键保留，理由见
    `merge_cookie_strings`）→ 判缺键 → 交该平台自己的入口校验/落盘。
    """
    cookie = (cookie or "").strip()
    if platform not in PLATFORM_LABELS:
        return ImportReceipt(ok=False, platform=platform,
                             note=f"不认识的平台 {platform!r}（只有 "
                                  f"{'、'.join(PLATFORM_LABELS)}）")
    if not cookie:
        return _reject(platform, cookie, "cookie 是空的")

    merged, from_stored = merge_cookie_strings(cookie, stored_cookie(platform))
    missing = _missing_required(platform, merged)
    if missing:
        note = f"cookie 缺少 {'、'.join(missing)} —— 从浏览器复制**整条** Cookie 头"
        # 如实区分两种"补不上"：应用里根本没有这份 cookie，还是**有但它也缺这个键**
        note += ("（应用里已有的那份也没能补上）" if stored_cookie(platform)
                 else "（应用里现在没有这个平台的 cookie 可以补）")
        return _reject(platform, merged, note, missing)

    if platform == "bilibili":
        ok, why, verified = await auth_manager.apply_cookie_checked(merged)
    elif platform == "weibo":
        ok, why, verified = await weibo_auth_manager.apply_cookie_checked(merged)
    elif platform == "xiaohongshu":
        ok, why = xhs_auth_manager.apply_cookie(merged)
        verified = False
        why = why or "已保存（这个平台只校验必需的键，不做在线探活）"
    else:                                    # douyin
        ok, why = douyin_auth_manager.apply_cookie(merged, ua)
        verified = False
        why = why or "已保存（这个平台只校验必需的键，不做在线探活）"

    if not ok:
        return _reject(platform, merged, why or "校验没过", missing)

    # 哪几个**有用**的键不是浏览器给的（回执单独一个字段，界面据此如实标注）
    used_names = {u.lower() for u in USED_KEYS.get(platform, ())}
    from_stored_used = [k for k in from_stored if k.lower() in used_names]
    return ImportReceipt(ok=True, platform=platform, keys=_used_keys(platform, merged),
                         missing=[], cookie_keys=len(cookie_key_names(merged)),
                         verified=verified, from_stored=from_stored_used, note=why)
