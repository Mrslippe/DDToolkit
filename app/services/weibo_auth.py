"""微博认证管理器：扫码登录 → cookie 持久化（.env），供抓取器与 auth 路由使用。

流程（实测 2026-08）：
1. 二维码  GET passport.weibo.com/sso/v2/qrcode/image?entry=mweibo&size=180&res=wel&cdult=3
           → {retcode:20000000, data:{qrid, image=图片 URL(v2.qr.weibo.cn/inf/gen)}}
           失败回退 login.sina.com.cn/sso/qrcode/image（JSONP，image 为外部 URL）
2. 轮询    GET …/sso/v2/qrcode/check?entry=mweibo&qrid={qrid}&cdult=3
           retcode：50114001 未扫码 / 50114002 已扫码待确认 /
           20000000 已确认（data.url = 完整登录 URL，内嵌 alt）/ 50114004 失效
3. 换登录态 从 data.url 提取 alt → 调 passport.weibo.com/sso/v2/login（JSONP 形态，带
           callback 参数；直 GET data.url 返回 HTML 无效）→ 回退 login.sina.com.cn/sso/login.php
           → 各自返回 uid/nick/crossDomainUrlList，并种 SUB/SUBP/SSOLoginState/M_WEIBOCN_PARAMS
4. 补种    依次 GET crossDomainUrlList（尤其 passport.weibo.com/wbsso/login）
"""
import asyncio
import json
import logging
import re
import time
from typing import Optional

import httpx

from app.core.config import settings
from app.core.http import new_async_client
from app.services.env_store import save_env_keys

logger = logging.getLogger(__name__)

_BASE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
    ),
    "Referer": "https://passport.weibo.com/",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": "https://passport.weibo.com",
}

_V2_IMAGE_URL = "https://passport.weibo.com/sso/v2/qrcode/image"
_V2_CHECK_URL = "https://passport.weibo.com/sso/v2/qrcode/check"
_V2_LOGIN_URL = "https://passport.weibo.com/sso/v2/login"
_FB_IMAGE_URL = "https://login.sina.com.cn/sso/qrcode/image"
_FB_CHECK_URL = "https://login.sina.com.cn/sso/qrcode/check"
_LOGIN_URL = "https://login.sina.com.cn/sso/login.php"

# retcode 语义（v2 JSON 与 login.sina JSONP 一致）
RC_OK = {20000000, "20000000"}
RC_WAITING = {50114001, "50114001"}    # 未扫码
RC_SCANNED = {50114002, "50114002"}    # 已扫码待确认
RC_EXPIRED = {50114004, "50114004"}    # 二维码失效


class WeiboAuth:
    """微博认证单例：持有 cookie 字符串与登录态展示信息。

    登录态判定（修复 2026-09）：is_logged_in 只是 cookie 存在性（同步、无网络）；
    真实有效性经 check_valid() 探测（异步、60s 缓存）——Cookie 过期后
    /auth/weibo/status 才能如实返回 logged_in=False，否则 UI 永远显示
    「已登录」且不出现重新扫码入口。
    """

    _VALIDITY_TTL = 60.0  # 探测结果缓存秒数（TopBar 每 60s 轮询 status）

    def __init__(self):
        self.cookie: str = settings.WEIBO_COOKIE
        self.uid: str = settings.WEIBO_UID
        self.name: str = settings.WEIBO_NAME
        self._valid: bool | None = None    # None=尚未探测
        self._checked_at: float = 0.0

    @property
    def is_logged_in(self) -> bool:
        return bool(self.cookie)

    @property
    def needs_login(self) -> bool:
        """登录态是否不可用：无 cookie，或最近一次探测确认失效。"""
        if not self.cookie:
            return True
        if self._valid is False:
            return True
        return False

    @staticmethod
    def _valid_from_body(data) -> bool:
        """微博 m 站 ok 字段语义：ok=1 有效；ok=-100 未登录/失效（附 login.php url）。"""
        if not isinstance(data, dict):
            return False
        return data.get("ok") == 1

    async def _probe_once(self) -> bool:
        """探测一次：请求与抓取路径一致的登录态接口（未登录返回 ok=-100）。"""
        try:
            async with new_async_client(8.0) as client:
                resp = await client.get(
                    "https://weibo.com/ajax/profile/info",
                    params={"uid": self.uid or "0"},
                    headers=self.build_headers({"Referer": "https://weibo.com/"}),
                )
                if resp.status_code != 200:
                    return False
                try:
                    body = resp.json()
                except ValueError:
                    return False
                return self._valid_from_body(body)
        except Exception as e:
            logger.warning(f"微博登录态探测异常: {e}")
            return False

    async def check_valid(self) -> bool:
        """cookie 是否仍有效（结果缓存 _VALIDITY_TTL 秒，防频繁探测）。"""
        if not self.cookie:
            self._valid = False
            return False
        now = time.monotonic()
        if self._valid is not None and now - self._checked_at < self._VALIDITY_TTL:
            return self._valid
        self._valid = await self._probe_once()
        self._checked_at = now
        logger.info(f"微博登录态探测: {'有效' if self._valid else '失效/未登录'}")
        return self._valid

    def build_headers(self, extra: Optional[dict] = None) -> dict:
        headers = dict(_BASE_HEADERS)
        if extra:
            headers.update(extra)
        if self.cookie:
            headers["Cookie"] = self.cookie
        return headers

    def apply_cookie(self, cookie: str, uid: str = "", name: str = "") -> None:
        self.cookie = cookie
        if uid:
            self.uid = uid
        if name:
            self.name = name
        # 刚登录成功即有效：直接置缓存，避免 UI 紧接着触发一次多余探测
        self._valid = True
        self._checked_at = time.monotonic()
        save_env_keys({
            "WEIBO_COOKIE": cookie,
            "WEIBO_UID": self.uid,
            "WEIBO_NAME": self.name,
        })
        logger.info(f"微博登录态已保存 (uid={self.uid or '-'})")

    def begin_login(self) -> "WeiboLoginSession":
        return WeiboLoginSession(self)


def _unwrap_jsonp(text: str) -> Optional[dict]:
    """JSONP 响应（STK_xxx({...})）→ dict；纯 JSON 直接解析。"""
    if not text:
        return None
    text = text.strip()
    if text.startswith("{"):
        try:
            return json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return None
    m = re.search(r"\((.*)\)", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except (json.JSONDecodeError, TypeError):
        return None


class WeiboLoginSession:
    """微博扫码登录会话（UI 驱动：start → poll → confirmed 时 complete）。

    poll 返回 (status, None)；complete 忽略参数、完成 alt 登录与 cookie 持久化。
    """

    def __init__(self, auth: WeiboAuth):
        self.auth = auth
        self.client = new_async_client(15.0)
        self.qrid = ""
        self._fallback = False

    # ── start ─────────────────────────────────────────────────────

    async def start(self) -> dict | None:
        data = await self._start_v2()
        if data is None:
            self._fallback = True
            data = await self._start_fallback()
        if data is not None:
            self.qrid = data["qrid"]
        return data

    async def _to_data_url(self, value) -> str | None:
        """二维码图片统一转前端可显示的 data URL：
        - 已是 data: 前缀 → 原样
        - http(s) URL → 后端拉取图片字节转 base64（CSP 无需放开图片站）
        - 裸 base64 → 补 data:image/png;base64 前缀
        修复：微博 v2 接口 data.image 实测是图片 URL（v2.qr.weibo.cn/inf/gen），
        此前直接拼「data:image/png;base64,{URL}」→ 前端资源加载失败。"""
        if not value:
            return None
        v = str(value)
        if v.startswith("data:"):
            return v
        if v.startswith("http://") or v.startswith("https://"):
            try:
                img_resp = await self.client.get(v)
                if img_resp.status_code != 200:
                    logger.warning(f"二维码图片下载失败: status={img_resp.status_code}")
                    return None
                import base64
                b64 = base64.b64encode(img_resp.content).decode("ascii")
                return f"data:image/png;base64,{b64}"
            except Exception as e:
                logger.warning(f"二维码图片下载失败: {e}")
                return None
        return f"data:image/png;base64,{v}"

    async def _start_v2(self) -> dict | None:
        resp = await self.client.get(
            _V2_IMAGE_URL,
            params={"entry": "mweibo", "size": "180", "res": "wel", "cdult": "3"},
            headers=self.auth.build_headers({"Referer": "https://passport.weibo.com/sso/signin"}),
        )
        data = resp.json()
        if data.get("retcode") not in RC_OK:
            logger.warning(f"v2 二维码生成失败: retcode={data.get('retcode')}, msg={data.get('msg')}")
            return None
        d = data.get("data") or {}
        qrid = d.get("qrid")
        image = await self._to_data_url(d.get("image"))
        if not qrid or not image:
            logger.warning("v2 二维码响应缺 qrid/image")
            return None
        return {"qrid": str(qrid), "image": image}

    async def _start_fallback(self) -> dict | None:
        ts = str(int(time.time() * 10000))
        resp = await self.client.get(
            _FB_IMAGE_URL,
            params={"entry": "sso", "size": "180", "service_id": "pc_protection",
                    "callback": f"STK_{ts}"},
            headers=self.auth.build_headers(),
        )
        data = _unwrap_jsonp(resp.text)
        if not data or data.get("retcode") not in RC_OK:
            logger.warning(f"login.sina 二维码生成失败: retcode={data and data.get('retcode')}")
            return None
        d = data.get("data") or {}
        qrid = d.get("qrid")
        image = await self._to_data_url(d.get("image"))
        if not qrid or not image:
            return None
        return {"qrid": str(qrid), "image": image}

    # ── poll ──────────────────────────────────────────────────────

    async def poll(self) -> tuple[str, dict | None]:
        ts = str(int(time.time() * 10000))
        if self._fallback:
            resp = await self.client.get(
                _FB_CHECK_URL,
                params={"entry": "sso", "qrid": self.qrid, "callback": f"STK_{ts}"},
                headers=self.auth.build_headers(),
            )
            data = _unwrap_jsonp(resp.text)
        else:
            resp = await self.client.get(
                _V2_CHECK_URL,
                params={"entry": "mweibo", "qrid": self.qrid, "cdult": "3"},
                headers=self.auth.build_headers(),
            )
            try:
                data = resp.json()
            except ValueError:
                data = _unwrap_jsonp(resp.text)
        if not data:
            return "waiting", None
        rc = data.get("retcode")
        if rc in RC_OK:
            return "confirmed", data
        if rc in RC_SCANNED:
            return "scanned", None
        if rc in RC_EXPIRED:
            return "expired", None
        return "waiting", None

    # ── complete ──────────────────────────────────────────────────

    def _extract_alt(self, poll_data: dict | None) -> str:
        """从确认轮询响应中提取登录票据 alt（兼容多种字段位置）。"""
        if not isinstance(poll_data, dict):
            return ""
        d = poll_data.get("data")
        if isinstance(d, dict):
            alt = d.get("alt")
            if alt:
                return str(alt)
        # 顶层 alt / data 直接为票据字符串兜底
        alt = poll_data.get("alt")
        if alt:
            return str(alt)
        if isinstance(d, str) and d:
            return d
        return ""

    def _alt_from_url(self, url: str) -> str:
        """从登录 URL 查询串提取 alt（实测 alt 内嵌在 data.url 的 query）。"""
        m = re.search(r"[?&]alt=([^&]+)", str(url))
        return m.group(1) if m else ""

    def _login_ok(self, data: dict) -> bool:
        return str(data.get("retcode")) in ("0", "20000000")

    async def _v2_login(self, alt: str) -> dict | None:
        """v2 登录 JSONP（entry=mweibo 生态）。直 GET data.url 会返回 HTML，须带 callback。"""
        ts = str(int(time.time() * 10000))
        resp = await self.client.get(
            _V2_LOGIN_URL,
            params={"entry": "mweibo", "returntype": "TEXT", "crossdomain": "1",
                    "cdult": "3", "domain": "weibo.com", "alt": alt,
                    "savestate": "30", "callback": f"STK_{ts}"},
            headers=self.auth.build_headers(),
            follow_redirects=True,
        )
        data = _unwrap_jsonp(resp.text)
        if not data or not self._login_ok(data):
            logger.warning(f"v2 登录失败: {resp.text[:160]}")
            return None
        return data

    async def _sina_login(self, alt: str) -> dict | None:
        """login.sina.com.cn login.php JSONP（PC 生态，回退）。"""
        ts = str(int(time.time() * 10000))
        resp = await self.client.get(
            _LOGIN_URL,
            params={"entry": "qrcodesso", "returntype": "TEXT", "crossdomain": "1",
                    "cdult": "3", "domain": "weibo.com", "alt": alt,
                    "savestate": "30", "callback": f"STK_{ts}"},
            headers=self.auth.build_headers(),
            follow_redirects=True,
        )
        data = _unwrap_jsonp(resp.text)
        if not data or not self._login_ok(data):
            logger.warning(f"login.sina 登录失败: {resp.text[:160]}")
            return None
        return data

    async def complete(self, poll_data: dict | None = None) -> tuple[bool, str]:
        # 实测（2026-08）：v2 确认响应 data.url 内嵌 alt；登录端点直 GET 返回 HTML，
        # 须按 JSONP 形态调用（callback 参数）。v2 失败回退 login.sina login.php。
        d = poll_data.get("data") if isinstance(poll_data, dict) else None
        login_url = d.get("url") if isinstance(d, dict) else None
        alt = self._extract_alt(poll_data) or self._alt_from_url(login_url or "")

        data = {}
        if alt:
            data = await self._v2_login(alt) or await self._sina_login(alt) or {}
            if not self._login_ok(data):
                return False, "登录票据失效，请重新扫码"
        elif login_url:
            # data.url 无 alt 时：直接 GET（仍可能返回 HTML → 失败走诊断日志）
            resp = await self.client.get(
                str(login_url), headers=self.auth.build_headers(), follow_redirects=True
            )
            data = _unwrap_jsonp(resp.text) or {}
            if not self._login_ok(data):
                return False, "登录票据失效，请重新扫码"
        else:
            # 打印完整载荷（不同 entry/版本下字段位置有差异），便于下次精确修正
            try:
                payload_snippet = str(poll_data)[:400]
            except Exception:
                payload_snippet = "<unserializable>"
            logger.warning(f"登录确认响应缺 alt/login_url: {payload_snippet}")
            return False, "登录确认响应缺少 alt，请重新扫码"
        uid = str(data.get("uid") or "")
        nick = str(data.get("nick") or "")
        # 依次访问跨域补种 URL（种全 SUB/SUBP/SSOLoginState/M_WEIBOCN_PARAMS）
        for url in data.get("crossDomainUrlList") or []:
            try:
                await self.client.get(str(url), headers=self.auth.build_headers())
            except Exception as e:
                logger.warning(f"跨域补种请求失败: {e}")

        # 遍历 cookie jar（http.cookiejar 支持同名多 Cookie：登录可能分别种在
        # .weibo.com / .sina.com.cn 等不同域名下）。按名去重置顶——后置的
        # 登录态 cookie（通常 .weibo.com）优先。dict(cookies) 遇同名会抛
        # 「Multiple cookies exist with name=SUB」，不能用。
        jar = self.client.cookies.jar
        cookie_map: dict[str, str] = {}
        for c in jar:
            if c.name in ("SUB", "SUBP", "SSOLoginState", "M_WEIBOCN_PARAMS", "SCF", "ALF"):
                if c.value:
                    cookie_map[c.name] = c.value
        cookie_parts = [f"{k}={v}" for k, v in cookie_map.items()]
        if not any(p.startswith("SUB=") for p in cookie_parts):
            return False, "未获取到登录凭据（SUB cookie 缺失）"
        cookie_str = "; ".join(cookie_parts)
        self.auth.apply_cookie(cookie_str, uid, nick)
        logger.info(f"微博扫码登录成功 (uid={uid}, nick={nick})")
        return True, f"{nick or uid}"

    async def close(self) -> None:
        await self.client.aclose()


# 单例
weibo_auth_manager = WeiboAuth()
