"""B站认证管理器：心跳保活 → refresh_token 续期 → 前端扫码登录（UI 驱动）

扫码登录（QR）经 /auth/bilibili/qr/* 端点由前端驱动：
BilibiliLoginSession.start/poll/complete 三步，替代旧终端 ASCII 二维码流程。
"""
import asyncio
import logging
import re
from typing import Optional

import httpx

from app.core.config import settings
from app.services.env_store import save_env_keys

logger = logging.getLogger(__name__)

# 凭据文件随数据目录走（桌面端 = %APPDATA%/DDtoolkit/.env，开发 = 项目根 .env）
ENV_PATH = settings.DATA_DIR / ".env"

BASE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0"
    ),
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Connection": "keep-alive",
}

_ATTR_MAP = {
    "SESSDATA": "sessdata",
    "bili_jct": "bili_jct",
    "DedeUserID": "dede_user_id",
    "bvuid3": "buvid3",
}

# QR 轮询状态码
QR_SUCCESS = {0, "0"}
QR_EXPIRED = {86038, "86038"}
QR_WAITING = {86090, "86090"}
QR_SCANNED = {86101, "86101"}


class BilibiliAuth:
    """B站认证单例，管理 Cookie 生命周期"""

    def __init__(self):
        self.sessdata: str = settings.BILI_SESSDATA
        self.bili_jct: str = settings.BILI_BIJI_JCT
        self.dede_user_id: str = settings.BILI_DEDE_USER_ID
        self.buvid3: str = settings.BILI_BUVID_3
        self.refresh_token: str = settings.BILI_REFRESH_TOKEN
        self.uname: str = ""            # 昵称（登录后 nav 回填，供登录态展示）
        self._needs_login: bool = not self.is_logged_in
        self._lock = asyncio.Lock()

    def needs_login(self) -> bool:
        return self._needs_login

    # ── cookie / headers ──────────────────────────────────────────

    @property
    def cookie_str(self) -> str:
        parts = [
            f"SESSDATA={self.sessdata}",
            f"bili_jct={self.bili_jct}",
            f"DedeUserID={self.dede_user_id}",
            f"bvuid3={self.buvid3}",
        ]
        return "; ".join(p for p in parts if "=" in p and not p.endswith("="))

    def build_headers(self) -> dict:
        return {**BASE_HEADERS, "Cookie": self.cookie_str}

    @property
    def is_logged_in(self) -> bool:
        return bool(self.sessdata and self.bili_jct)

    # ── .env 持久化 ───────────────────────────────────────────────

    def _save_to_env(self):
        if not ENV_PATH.exists():
            logger.warning(f".env 文件不存在: {ENV_PATH}")
            return
        values = {
            "BILI_SESSDATA": self.sessdata,
            "BILI_BIJI_JCT": self.bili_jct,
            "BILI_DEDE_USER_ID": self.dede_user_id,
            "BILI_BUVID_3": self.buvid3,
            "BILI_REFRESH_TOKEN": self.refresh_token,
        }
        save_env_keys(values)

    def _parse_set_cookie(self, response: httpx.Response) -> dict:
        """从响应中提取 cookie：先试 httpx cookie jar，再试原始 Set-Cookie 头"""
        extracted: dict[str, str] = {}

        # 方式 1: httpx.Cookies
        for name in ("SESSDATA", "bili_jct", "DedeUserID", "bvuid3"):
            val = response.cookies.get(name)
            if val:
                extracted[name] = val

        # 方式 2: 原始 Set-Cookie 头（兜底，有些响应 httpx 解析不全）
        set_cookie_header = response.headers.get("set-cookie", "")
        if set_cookie_header:
            for part in set_cookie_header.split(","):
                for name in ("SESSDATA", "bili_jct", "DedeUserID", "bvuid3"):
                    if name not in extracted:
                        m = re.search(rf"{name}=([^;,]+)", part)
                        if m:
                            extracted[name] = m.group(1).strip()

        return extracted

    def _update_from_response(self, response: httpx.Response):
        extracted = self._parse_set_cookie(response)
        changed = False
        for key, val in extracted.items():
            attr = _ATTR_MAP.get(key)
            if attr and val and val != getattr(self, attr, ""):
                setattr(self, attr, val)
                changed = True
                logger.info(f"Cookie 已更新: {key}={val[:20]}...")
        if changed:
            self._save_to_env()
            return True
        return False

    # ── 阶段 1：心跳 / 状态检查 ───────────────────────────────────

    async def check_session(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    "https://api.bilibili.com/x/web-interface/nav",
                    headers=self.build_headers(),
                )
                data = resp.json()
                code = data.get("code")
                is_login = data.get("data", {}).get("isLogin")
                if code in (0, "0") and is_login:
                    self.uname = data.get("data", {}).get("uname") or ""
                    self._needs_login = False
                    logger.info(f"Session 有效 (mid={data['data'].get('mid')})")
                    return True
                logger.warning(f"Session 已过期: code={code}, msg={data.get('message')}")
                return False
        except Exception as e:
            logger.error(f"Session 检查异常: {e}")
            return False

    # ── 阶段 2：refresh_token 续期 ────────────────────────────────

    async def try_refresh(self) -> bool:
        if not self.refresh_token:
            logger.info("没有 refresh_token，跳过续期")
            return False

        try:
            logger.info("尝试使用 refresh_token 续期...")
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    "https://passport.bilibili.com/x/passport-login/web/cookie/refresh",
                    data={
                        "csrf": self.bili_jct,
                        "refresh_token": self.refresh_token,
                        "source": "main_web",
                    },
                    headers=self.build_headers(),
                )
                data = resp.json()
                if data.get("code") not in (0, "0"):
                    logger.warning(f"refresh_token 续期失败: code={data.get('code')}, msg={data.get('message')}")
                    return False

                updated = self._update_from_response(resp)

                new_rt = data.get("data", {}).get("refresh_token")
                if new_rt:
                    self.refresh_token = new_rt

                if updated or new_rt:
                    self._save_to_env()
                    logger.info("Session 续期成功")
                    return True

                logger.warning("续期响应中未找到新 cookie")
                return False
        except Exception as e:
            logger.error(f"续期请求异常: {e}")
            return False

    async def _fetch_refresh_token(self) -> Optional[str]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    "https://passport.bilibili.com/x/passport-login/web/cookie/info",
                    headers=self.build_headers(),
                )
                data = resp.json()
                if data.get("code") in (0, "0"):
                    token = data.get("data", {}).get("refresh_token")
                    if token:
                        self.refresh_token = token
                        self._save_to_env()
                        logger.info("refresh_token 已更新")
                        return token
                    logger.info(f"cookie/info 返回中无 refresh_token (code={data.get('code')})")
                else:
                    logger.info(f"获取 refresh_token 失败: code={data.get('code')}, msg={data.get('message')}")
                return None
        except Exception as e:
            logger.error(f"获取 refresh_token 异常: {e}")
            return None

    # ── 阶段 3：扫码登录（UI 驱动：start → poll → complete） ────────

    def begin_login(self) -> "BilibiliLoginSession":
        """开启一次扫码登录会话（/auth/bilibili/qr/* 端点驱动）。"""
        return BilibiliLoginSession(self)

    # ── 主循环 ────────────────────────────────────────────────────

    async def run_maintenance(self):
        """后台持续维护登录态：检查 → 续期；失败置 needs_login（前端徽章提示扫码）"""
        logger.info("Auth 维护循环已启动")

        while True:
            try:
                if await self.check_session():
                    self._needs_login = False
                    await self._fetch_refresh_token()
                elif await self.try_refresh():
                    self._needs_login = False
                    logger.info("Session 续期成功")
                else:
                    self._needs_login = True
                    logger.warning("会话无效，等待前端扫码登录...")

                logger.info("Auth 维护周期完成，30 分钟后下一次检查")
                await asyncio.sleep(1800)

            except Exception as e:
                logger.error(f"Auth 维护异常: {e}", exc_info=True)
                await asyncio.sleep(60)


class BilibiliLoginSession:
    """B 站扫码登录会话（三步：start 生成 → poll 轮询 → confirmed 时 complete）。

    与 auth 路由配合：poll 返回 (status, poll_data)；status=confirmed 时
    由路由调用 complete(poll_data) 完成取 cookie/校验/持久化。
    """

    GENERATE_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
    POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"

    def __init__(self, auth: "BilibiliAuth"):
        self.auth = auth
        self.client = httpx.AsyncClient(timeout=10.0)
        self.qrcode_key = ""

    async def start(self) -> dict | None:
        gen_resp = await self.client.get(self.GENERATE_URL, headers=BASE_HEADERS)
        gen_data = gen_resp.json()
        if gen_data.get("code") not in (0, "0"):
            logger.error(f"生成二维码失败: {gen_data.get('message')}")
            return None
        self.qrcode_key = gen_data["data"]["qrcode_key"]
        return {"url": gen_data["data"]["url"]}

    async def poll(self) -> tuple[str, dict]:
        poll_resp = await self.client.get(
            self.POLL_URL, params={"qrcode_key": self.qrcode_key}, headers=BASE_HEADERS
        )
        poll_data = poll_resp.json()
        code = poll_data.get("code")
        if code in QR_SUCCESS:
            status = "confirmed"
        elif code in QR_EXPIRED:
            status = "expired"
        elif code in QR_SCANNED:
            status = "scanned"
        else:
            status = "waiting"
        return status, poll_data

    async def complete(self, poll_data: dict) -> tuple[bool, str]:
        """扫码确认后：访问回调 URL 种 cookie → 提取凭据 → nav 校验 → 持久化。"""
        auth = self.auth
        logger.info("扫码确认成功，正在获取登录凭据...")

        # B站 QR 登录的关键：poll code=0 后必须访问 data.url
        # 才会通过 302 重定向链下发 Set-Cookie（SESSDATA / bili_jct 等）
        callback_url = poll_data.get("data", {}).get("url")
        poll_resp = None
        if callback_url:
            try:
                poll_resp = await self.client.get(
                    callback_url,
                    headers={**BASE_HEADERS, "Referer": "https://passport.bilibili.com/"},
                    follow_redirects=True,
                )
            except Exception as e:
                logger.warning(f"访问回调 URL 失败: {e}")

        if poll_resp is not None:
            auth._update_from_response(poll_resp)

        rt = poll_data.get("data", {}).get("refresh_token")
        if rt:
            auth.refresh_token = rt

        # 最终验证：用当前 cookie 调 nav 确认登录态
        try:
            nav_resp = await self.client.get(
                "https://api.bilibili.com/x/web-interface/nav",
                headers=auth.build_headers(),
            )
            nav_data = nav_resp.json()
            if nav_data.get("code") in (0, "0") and nav_data.get("data", {}).get("isLogin"):
                uid = str(nav_data["data"].get("mid", ""))
                if uid:
                    auth.dede_user_id = uid
                auth.uname = nav_data["data"].get("uname") or ""
                # nav 响应也会种 cookie，再提取一次
                auth._update_from_response(nav_resp)
            else:
                logger.warning(f"登录验证失败: code={nav_data.get('code')}, msg={nav_data.get('message')}")
                return False, "登录验证失败"
        except Exception as e:
            logger.error(f"登录验证失败: {e}")
            return False, "登录验证失败"

        if not auth.sessdata:
            return False, "未能获取到登录凭据，请重试"

        auth._save_to_env()
        _clear_wbi_cache()
        auth._needs_login = False

        logger.info(f"二维码登录成功 (mid={auth.dede_user_id})")
        return True, auth.dede_user_id

    async def close(self) -> None:
        await self.client.aclose()


# ── 辅助函数 ──────────────────────────────────────────────────────

def _print_status(msg: str):
    """打印状态到终端（print 直接到 stdout，绕过 logger 格式）"""
    print(f"[Auth] {msg}", flush=True)
    logger.info(msg)


def _clear_wbi_cache():
    """清除 WBI 密钥缓存，强制下次请求获取新密钥"""
    try:
        from app.services.wbi import clear_wbi_cache as _clear
        _clear()
        logger.info("WBI 密钥缓存已清除")
    except Exception:
        pass


# 单例
auth_manager = BilibiliAuth()
