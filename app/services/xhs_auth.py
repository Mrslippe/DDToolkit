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
        #: 这条 cookie 是什么时候粘进来的（`devlog/330`）。有它才能回答"它活了多久" ——
        #: 平台**不给**任何标称寿命（实测：API 响应里没有 `Set-Cookie`，cookie 自带的 `ets`
        #: 是个陈旧值），所以只能记下起点、失效时算差值。
        self.set_at: str = getattr(settings, "XHS_COOKIE_SET_AT", "")
        #: 本次进程里已经报过"失效"没有（失效会连续发生很多次，只该报一次）
        self._reported_invalid = False
        #: 抓取时**确认过**这条 cookie 已失效（`devlog/353`）。与"配齐了没"分开：
        #: 只有真机失败才算证据（`status()` 刻意不探活），拿到证据后能力矩阵/登录窗
        #: 都要如实显示"需要重新登录"，而不是继续写"已配置 Cookie"。
        #: ⚠️ 进程内状态：重启后回到"按配置判断"（用户没重新粘就可能再报一次 —— 这是可接受的，
        #:    宁可多报一次，也不要让"过期"永远沉默）。
        self.invalidated = False

    @property
    def is_configured(self) -> bool:
        return not missing_keys(self.cookie)

    def age_days(self) -> float | None:
        """这条 cookie 粘进来多久了（天）；没记过起点 ⇒ `None`。"""
        if not self.set_at:
            return None
        try:
            from datetime import datetime

            t0 = datetime.fromisoformat(self.set_at)
        except ValueError:
            return None
        return max(0.0, (datetime.now() - t0).total_seconds() / 86400.0)

    def status(self) -> dict:
        """给 UI 的登录态。

        ⚠️ 这里**不做**"真实有效性探测"：小红书没有免签名的探活端点（B 站/微博那两条路
        都要签名），硬探只会白挨一次风控。所以状态口径是"**配置齐了**"，
        真实失效由抓取时的 `classify_http() == 'cookie_invalid'` 反映（会记
        `last_error`、并调 `note_invalid()` 报一句"活了多久"），那时用户重新粘一次即可。

        ⚠️ 2026-10-05（`devlog/353`）：`invalidated` 一旦置上就**如实报**「登录已过期」——
        此前 `classify_http` 把 `HTTP 200 + code=-100 登录已过期` 判成 `ok`，
        于是失效永远沉默：矩阵写"已配置 Cookie"、日志里也没有一句，用户只能自己发现抓不到东西。
        """
        miss = missing_keys(self.cookie)
        age = self.age_days()
        note = ""
        if miss:
            note = (f"cookie 缺少 {'、'.join(miss)} —— 小红书至少要 a1 与 web_session 两件"
                    f"（缺 a1 时签名器会直接报 Missing 'a1' in cookies）")
        elif self.invalidated:
            lived = f"（这条活了 {age:.1f} 天）" if age is not None else ""
            note = ("登录已过期 —— 抓取时平台回了「登录已过期」，到「设置 → 登录 → 小红书」"
                    f"重新粘一次整条 Cookie{lived}")
        elif age is not None:
            # 平台不给标称寿命 ⇒ 至少把"起点 + 已用多久"如实说出来（devlog/330）
            note = f"已配置 {age:.1f} 天（{self.set_at[:10]} 粘贴）"
        return {
            "logged_in": not miss and not self.invalidated,
            "needs_login": bool(miss) or self.invalidated,
            "configured": bool(self.cookie),
            "missing": miss,
            "set_at": self.set_at,
            "age_days": age,
            "invalidated": self.invalidated,
            "note": note,
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
        from datetime import datetime

        self.cookie = cookie
        self.set_at = datetime.now().isoformat(timespec="seconds")
        self._reported_invalid = False          # 新粘的这条重新开始算
        self.invalidated = False                # 失效标记一并清掉（`devlog/353`）
        save_env_keys({"XHS_COOKIE": cookie, "XHS_COOKIE_SET_AT": self.set_at})
        logger.info("小红书 cookie 已保存（%d 个键，起点 %s）",
                    len(cookie_keys(cookie)), self.set_at)
        return True, ""

    def note_invalid(self, why: str = "") -> None:
        """抓取时确认这条 cookie 已失效 ⇒ **报一次"它活了多久"**（`devlog/330`）。

        为什么要它：平台不告诉你标称寿命，`status()` 又刻意不做探活（见上）⇒
        唯一能拿到"真实寿命"的时刻就是**失效的那一刻**。只报一次：失效会连续发生很多次。

        ⚠️ 同时置 `invalidated`（`devlog/353`）：能力矩阵与登录窗据此**如实**显示
        「登录已过期」，不再写"已配置 Cookie"。
        """
        self.invalidated = True
        if self._reported_invalid:
            return
        self._reported_invalid = True
        age = self.age_days()
        lived = f"活了 {age:.1f} 天" if age is not None else "（没记过粘贴时刻，算不出活了多久）"
        logger.warning("小红书 cookie 已失效：%s%s。到「设置 → 登录 → 小红书」重新粘一次"
                       "（整条 Cookie，至少含 a1 与 web_session）",
                       lived, f"（{why}）" if why else "")

    def clear(self) -> None:
        self.cookie = ""
        self.set_at = ""
        save_env_keys({"XHS_COOKIE": "", "XHS_COOKIE_SET_AT": ""})


xhs_auth_manager = XhsAuth()
