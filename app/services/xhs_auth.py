"""小红书登录态：**粘贴 cookie**（第 4 阶段 ④ 第三刀-2，devlog/233）。

为什么不做扫码：调研 `docs/platforms-xhs-douyin-research.md` §2.8 给了三条登录路，
扫码那条的二维码/状态接口**也**要签名与设备 cookie（鸡生蛋），而 **cookie 复用**是
MediaCrawler 与本项目都最省事的一条。

⚠️ **至少要 `a1` + `web_session` 两件**（2026-09-27 实测，devlog/232 §三）：
缺 `a1` 时签名器直接报 `Missing 'a1' in cookies` —— 所以这里**先校验再落盘**，
把"粘了一个 `web_session` 然后永远签不出名"这种最难排查的形态挡在入口。

持久化口径与微博一致（`save_env_keys` → 数据目录 `.env`），重启后仍在。
"""
from __future__ import annotations

import logging
from typing import Optional

from app.core.config import settings
from app.services.env_store import save_env_keys

logger = logging.getLogger(__name__)

# 必需的 cookie 键（少一个都签不出名）
REQUIRED_KEYS = ("a1", "web_session")


def cookie_keys(cookie: str) -> set[str]:
    """从 cookie 串里取出键名（`k=v; k2=v2`；大小写不敏感）。"""
    keys: set[str] = set()
    for part in (cookie or "").split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        keys.add(part.split("=", 1)[0].strip().lower())
    return keys


def missing_keys(cookie: str) -> list[str]:
    """还缺哪些必需键（空列表 = 齐了）。"""
    have = cookie_keys(cookie)
    return [k for k in REQUIRED_KEYS if k not in have]


class XhsAuth:
    """小红书登录态（内存 + `.env` 持久化）。"""

    def __init__(self) -> None:
        self.cookie: str = getattr(settings, "XHS_COOKIE", "")

    @property
    def is_configured(self) -> bool:
        return not missing_keys(self.cookie)

    def status(self) -> dict:
        """给 UI 的登录态。

        ⚠️ 这里**不做**"真实有效性探测"：小红书没有免签名的探活端点（B 站/微博那两条路
        都要签名），硬探只会白挨一次风控。所以状态口径是"**配置齐了**"，
        真实失效由抓取时的 `classify_http() == 'cookie_invalid'` 反映（会清游标 + 记
        `last_error`），那时用户重新粘一次即可。
        """
        miss = missing_keys(self.cookie)
        return {
            "logged_in": not miss,
            "needs_login": bool(miss),
            "configured": bool(self.cookie),
            "missing": miss,
            "note": ("" if not miss else
                     f"cookie 缺少 {'、'.join(miss)} —— 小红书至少要 a1 与 web_session 两件"
                     f"（缺 a1 时签名器会直接报 Missing 'a1' in cookies）"),
        }

    def apply_cookie(self, cookie: str) -> tuple[bool, str]:
        """校验并保存；返回 `(是否成功, 原因)`。**校验不过不落盘**。"""
        cookie = (cookie or "").strip()
        if not cookie:
            return False, "cookie 是空的"
        miss = missing_keys(cookie)
        if miss:
            return False, (f"cookie 缺少 {'、'.join(miss)} —— 从浏览器复制整条 Cookie 头，"
                           f"至少要含 a1 与 web_session")
        self.cookie = cookie
        save_env_keys({"XHS_COOKIE": cookie})
        logger.info("小红书 cookie 已保存（%d 个键）", len(cookie_keys(cookie)))
        return True, ""

    def clear(self) -> None:
        self.cookie = ""
        save_env_keys({"XHS_COOKIE": ""})


xhs_auth_manager = XhsAuth()
