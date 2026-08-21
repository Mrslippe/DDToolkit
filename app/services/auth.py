"""B站认证管理器：心跳保活 → refresh_token 续期 → 二维码扫码兜底"""
import asyncio
import logging
import os
import re
import time
from pathlib import Path
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

ENV_PATH = Path(__file__).parent.parent.parent / ".env"

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
        self._lock = asyncio.Lock()

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

        lines = ENV_PATH.read_text(encoding="utf-8").splitlines(keepends=True)
        new_lines = []
        seen = set()
        target_keys = {
            "BILI_SESSDATA", "BILI_BIJI_JCT", "BILI_DEDE_USER_ID",
            "BILI_BUVID_3", "BILI_REFRESH_TOKEN",
        }

        for line in lines:
            key = line.split("=", 1)[0].strip() if "=" in line else ""
            if key in target_keys:
                if key not in seen:
                    seen.add(key)
                    new_lines.append(_env_line_for(key, self))
            else:
                new_lines.append(line)

        for key in target_keys:
            if key not in seen:
                new_lines.append(_env_line_for(key, self))

        ENV_PATH.write_text("".join(new_lines), encoding="utf-8")
        _reload_env()

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

    # ── 阶段 3：二维码扫码登录 ────────────────────────────────────

    async def qr_login(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                # 1. 生成二维码
                gen_resp = await client.get(
                    "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
                    headers=BASE_HEADERS,
                )
                gen_data = gen_resp.json()
                if gen_data.get("code") not in (0, "0"):
                    logger.error(f"生成二维码失败: {gen_data.get('message')}")
                    return False

                url = gen_data["data"]["url"]
                qrcode_key = gen_data["data"]["qrcode_key"]

                # 2. 展示二维码
                _print_qrcode(url)

                # 3. 轮询扫码结果
                _print_status("等待扫码（最长 3 分钟）...")
                deadline = time.time() + 180
                last_state = None
                while time.time() < deadline:
                    await asyncio.sleep(2)
                    poll_resp = await client.get(
                        "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
                        params={"qrcode_key": qrcode_key},
                        headers=BASE_HEADERS,
                    )
                    poll_data = poll_resp.json()
                    code = poll_data.get("code")

                    # 调试：打印每次轮询的完整响应
                    logger.debug(f"QR poll: code={code}, msg={poll_data.get('message')}, "
                                 f"data_keys={list(poll_data.get('data', {}).keys()) if poll_data.get('data') else 'None'}")

                    if code in QR_SUCCESS:
                        # 关键：验证响应中是否真的包含登录凭据
                        if self._has_login_credentials(poll_resp, poll_data):
                            return await self._handle_qr_success(poll_resp, poll_data, client)
                        else:
                            logger.warning(f"收到 code=0 但无登录凭据，忽略并继续轮询")
                            if last_state != "waiting":
                                _print_status("等待扫码...")
                                last_state = "waiting"
                            continue

                    if code in QR_EXPIRED:
                        _print_status("二维码已过期，将重新生成...")
                        return False

                    if code in QR_WAITING and last_state != "waiting":
                        _print_status("已扫码，请在手机上确认...")
                        last_state = "waiting"
                    elif code in QR_SCANNED and last_state != "scanned":
                        _print_status("等待扫码...")
                        last_state = "scanned"
                    elif code not in QR_WAITING and code not in QR_SCANNED:
                        logger.warning(f"未知轮询状态: code={code}, msg={poll_data.get('message')}")

                _print_status("扫码超时")
                return False
        except Exception as e:
            logger.error(f"二维码登录异常: {e}", exc_info=True)
            _print_status(f"二维码登录失败: {e}")
            return False

    def _has_login_credentials(self, response: httpx.Response, data: dict) -> bool:
        """检查响应中是否真的包含登录凭据"""
        # 检查 Set-Cookie 中是否有 SESSDATA
        extracted = self._parse_set_cookie(response)
        if extracted.get("SESSDATA"):
            return True
        # 检查响应体中是否有 refresh_token
        if data.get("data", {}).get("refresh_token"):
            return True
        return False

    async def _handle_qr_success(self, poll_resp, poll_data, client) -> bool:
        """QR 扫码成功后的处理：访问回调 URL 种 cookie → 验证 → 持久化"""
        _print_status("扫码确认成功，正在获取登录凭据...")

        # B站 QR 登录的关键：poll code=0 后必须访问 data.url
        # 才会通过 302 重定向链下发 Set-Cookie（SESSDATA / bili_jct 等）
        callback_url = poll_data.get("data", {}).get("url")
        if callback_url:
            try:
                callback_resp = await client.get(
                    callback_url,
                    headers={**BASE_HEADERS, "Referer": "https://passport.bilibili.com/"},
                    follow_redirects=True,
                )
                logger.debug(f"回调响应: status={callback_resp.status_code}, "
                             f"set_cookie_keys={list(dict(callback_resp.cookies).keys())}")
            except Exception as e:
                logger.warning(f"访问回调 URL 失败: {e}")

        # 从 poll 响应 + 回调响应中提取 cookie
        self._update_from_response(poll_resp)

        rt = poll_data.get("data", {}).get("refresh_token")
        if rt:
            self.refresh_token = rt

        # 最终验证：用当前 cookie 调 nav 确认登录态
        try:
            nav_resp = await client.get(
                "https://api.bilibili.com/x/web-interface/nav",
                headers=self.build_headers(),
            )
            nav_data = nav_resp.json()
            if nav_data.get("code") in (0, "0") and nav_data.get("data", {}).get("isLogin"):
                uid = str(nav_data["data"].get("mid", ""))
                if uid:
                    self.dede_user_id = uid
                # nav 响应也会种 cookie，再提取一次
                self._update_from_response(nav_resp)
            else:
                _print_status(f"登录验证失败: code={nav_data.get('code')}, msg={nav_data.get('message')}")
                return False
        except Exception as e:
            logger.error(f"登录验证失败: {e}")
            return False

        if not self.sessdata:
            _print_status("未能获取到登录凭据，请重试")
            return False

        self._save_to_env()
        _clear_wbi_cache()

        _print_status(f"登录成功！用户 ID: {self.dede_user_id}，凭据已保存到 .env")
        logger.info(f"二维码登录成功 (mid={self.dede_user_id})")
        return True

    # ── 主循环 ────────────────────────────────────────────────────

    async def run_maintenance(self):
        """后台持续维护登录态：检查 → 续期 → 扫码"""
        logger.info("Auth 维护循环已启动")

        while True:
            try:
                if await self.check_session():
                    await self._fetch_refresh_token()
                elif await self.try_refresh():
                    logger.info("Session 续期成功")
                    _print_status("Session 续期成功")
                elif await self.qr_login():
                    pass
                else:
                    logger.warning("所有认证方式均失败，30 分钟后重试...")
                    _print_status("所有认证方式均失败，30 分钟后重试...")

                logger.info("Auth 维护周期完成，30 分钟后下一次检查")
                await asyncio.sleep(1800)

            except Exception as e:
                logger.error(f"Auth 维护异常: {e}", exc_info=True)
                await asyncio.sleep(60)


# ── 辅助函数 ──────────────────────────────────────────────────────

def _env_line_for(key: str, auth: BilibiliAuth) -> str:
    mapping = {
        "BILI_SESSDATA": auth.sessdata,
        "BILI_BIJI_JCT": auth.bili_jct,
        "BILI_DEDE_USER_ID": auth.dede_user_id,
        "BILI_BUVID_3": auth.buvid3,
        "BILI_REFRESH_TOKEN": auth.refresh_token,
    }
    return f"{key}={mapping.get(key, '')}\n"


def _reload_env():
    from dotenv import load_dotenv
    load_dotenv(ENV_PATH, override=True)


def _print_qrcode(url: str):
    """终端打印二维码 — 使用 print 确保在 uvicorn 日志流中可见"""
    print("\n" + "=" * 50)
    print("🔑 请使用 Bilibili App 扫描下方二维码登录：")
    print(f"   链接: {url}")
    print("=" * 50)
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    except ImportError:
        print("   (pip install qrcode 可获得终端二维码)")
    print("=" * 50 + "\n", flush=True)


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
