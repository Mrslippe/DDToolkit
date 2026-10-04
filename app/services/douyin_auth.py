"""抖音登录态：**粘贴 cookie**（第 4 阶段 ④ 第二刀，devlog/334）。

照 `xhs_auth.py` 的形状做（那套已经被真机验过两轮：入口校验 → 落 `.env` → 失效时报一次寿命），
差异只有两处，都来自抖音自己的口径：

| 差异 | 为什么 |
|---|---|
| 必需键是 `s_v_web_id` + **`uifid`（或 `UIFID_TEMP`）** + `ttwid` | 签名绑 `uifid`，`verifyFp`/`fp` 必须是 `s_v_web_id` 的原值；`ttwid` 是设备 id。真机导出的那份就带这三样（`devlog/333`）|
| **多存一个 UA** | `a_bogus` 把 UA 算进签名（`vendor/dtksign/` 的 `user_agent_digest`）⇒ UA 与 cookie 必须来自**同一个浏览器会话**。UA 不一致的症状是**静默的**（200 + 0 字节空体），所以这里把它当凭据的一部分存起来，而不是让它躺在默认值里 |

⚠️ 与小红书同一条：**不做探活**（抖音的探活端点也要签名，硬探只会白挨一次风控）——
状态口径是"配置齐了"，真实失效由抓取时的 `classify_http() == 'cookie_invalid'` 反映。
"""
from __future__ import annotations

import logging

from app.core.config import settings
from app.services.env_store import save_env_keys

logger = logging.getLogger(__name__)

#: 必需的 cookie 键（少一个都过不去）。`uifid` 有两种拼写，任一即可。
REQUIRED_ANY = (("uifid", "uifid_temp", "uifidtemp"),)
REQUIRED_KEYS = ("s_v_web_id", "ttwid")


def cookie_keys(cookie: str) -> set[str]:
    """从 cookie 串里取出**小写**键名（`k=v; k2=v2`）。"""
    keys: set[str] = set()
    for part in (cookie or "").split(";"):
        part = part.strip()
        if part and "=" in part:
            keys.add(part.split("=", 1)[0].strip().lower())
    return keys


def missing_keys(cookie: str) -> list[str]:
    """还缺哪些必需键（空列表 = 齐了）。"""
    have = cookie_keys(cookie)
    miss = [k for k in REQUIRED_KEYS if k not in have]
    for group in REQUIRED_ANY:
        if not (have & set(group)):
            miss.append(group[0])
    return miss


class DouyinAuth:
    """抖音登录态（内存 + `.env` 持久化）。"""

    def __init__(self) -> None:
        self.cookie: str = getattr(settings, "DOUYIN_COOKIE", "")
        self.set_at: str = getattr(settings, "DOUYIN_COOKIE_SET_AT", "")
        self.user_agent: str = getattr(settings, "DOUYIN_UA", "")
        self._reported_invalid = False

    @property
    def is_configured(self) -> bool:
        return not missing_keys(self.cookie)

    def age_days(self) -> float | None:
        if not self.set_at:
            return None
        try:
            from datetime import datetime

            t0 = datetime.fromisoformat(self.set_at)
        except ValueError:
            return None
        return max(0.0, (datetime.now() - t0).total_seconds() / 86400.0)

    def status(self) -> dict:
        """给 UI 的登录态（`configured` = 粘过；`logged_in` = 必需键齐了）。"""
        miss = missing_keys(self.cookie)
        age = self.age_days()
        note = ""
        if miss:
            note = (f"cookie 缺少 {'、'.join(miss)} —— 抖音至少要 uifid（或 UIFID_TEMP）、"
                    f"s_v_web_id、ttwid 三样；缺了签名器直接报错，或更糟：**静默**返回空数据")
        elif age is not None:
            note = f"已配置 {age:.1f} 天（{self.set_at[:10]} 粘贴）"
        return {
            "logged_in": not miss,
            "needs_login": bool(miss),
            "configured": bool(self.cookie),
            "missing": miss,
            "set_at": self.set_at,
            "age_days": age,
            # ⚠️ 只报"配没配"，**不回显 UA 全文**（它是身份指纹的一部分，没必要进响应/日志）
            "ua_configured": bool(self.user_agent),
            "note": note,
        }

    def apply_cookie(self, cookie: str, user_agent: str = "") -> tuple[bool, str]:
        """校验并保存；返回 `(是否成功, 原因)`。**校验不过不落盘**。"""
        cookie = (cookie or "").strip()
        if not cookie:
            return False, "cookie 是空的"
        miss = missing_keys(cookie)
        if miss:
            return False, (f"cookie 缺少 {'、'.join(miss)} —— 从浏览器复制**整条** Cookie 头"
                           f"（F12 → Network → 任意 www.douyin.com 请求 → Request Headers → cookie）")
        from datetime import datetime

        self.cookie = cookie
        self.set_at = datetime.now().isoformat(timespec="seconds")
        self._reported_invalid = False
        values = {"DOUYIN_COOKIE": cookie, "DOUYIN_COOKIE_SET_AT": self.set_at}
        ua = (user_agent or "").strip()
        if ua:
            self.user_agent = ua
            values["DOUYIN_UA"] = ua
        save_env_keys(values)
        logger.info("抖音 cookie 已保存（%d 个键，UA %s，起点 %s）",
                    len(cookie_keys(cookie)), "已一并保存" if ua else "沿用上次/默认",
                    self.set_at)
        return True, ""

    def note_invalid(self, why: str = "") -> None:
        """抓取时确认这条 cookie 已失效 ⇒ **报一次"它活了多久"**（口径同 `xhs_auth`）。"""
        if self._reported_invalid:
            return
        self._reported_invalid = True
        age = self.age_days()
        lived = f"活了 {age:.1f} 天" if age is not None else "（没记过粘贴时刻，算不出活了多久）"
        logger.warning("抖音 cookie 已失效：%s%s。到「设置 → 登录 → 抖音」重新粘一次"
                       "（整条 Cookie，含 uifid / s_v_web_id / ttwid）",
                       lived, f"（{why}）" if why else "")

    def clear(self) -> None:
        self.cookie = ""
        self.set_at = ""
        self.user_agent = ""
        save_env_keys({"DOUYIN_COOKIE": "", "DOUYIN_COOKIE_SET_AT": "", "DOUYIN_UA": ""})


douyin_auth_manager = DouyinAuth()
