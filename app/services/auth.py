"""B站认证管理器：心跳保活 → refresh_token 续期 → 前端扫码登录（UI 驱动）

扫码登录（QR）经 /auth/bilibili/qr/* 端点由前端驱动：
BilibiliLoginSession.start/poll/complete 三步，替代旧终端 ASCII 二维码流程。
"""
import asyncio
import logging
import re
from typing import Optional
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from app.core.config import settings
from app.core.useragent import UA_EDGE
from app.core.http import new_async_client
from app.services.env_store import save_env_keys

logger = logging.getLogger(__name__)

BASE_HEADERS = {
    # UA 从 `core/http` 取（R26③：全仓单一来源，发版时刷新 `UA_MAJOR`）
    "User-Agent": UA_EDGE,
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    # ⚠️ 这里**故意不发** `Connection: keep-alive`（R26②，devlog/128）：
    # 浏览器在 HTTP/1.1 下不显式发它（h2 更不会有），我们却一边声称 Edge 一边发它 ——
    # 那是个比"少一个头"更明显的脚本痕迹。httpx 自己会管理连接复用，不需要这个头。
}

_ATTR_MAP = {
    "SESSDATA": "sessdata",
    "bili_jct": "bili_jct",
    "DedeUserID": "dede_user_id",
    # ⚠️ 设备号有**两个名字**，两个都要认（R26，devlog/126 真机实测）：
    #   · `bvuid3` = B 站**登录/SSO 响应**里用的名字（本仓库原先只认它，值也确实抓到了）；
    #   · `buvid3` = **web API 认的名字**（首次访问主站时由服务端 `Set-Cookie: buvid3=…` 下发）。
    #   只认前者、并把它当 `bvuid3=` 发回去 ⇒ 服务端每次都当"没有设备号的新访客"：
    #   实测带 `bvuid3=` 时它仍会铸一枚新 `buvid3`，带 `buvid3=` 时才不铸。
    # 顺序有意为之：字典后写的规范名覆盖前者（两个同时出现时以 `buvid3` 为准）。
    "bvuid3": "buvid3",
    "buvid3": "buvid3",
    "buvid4": "buvid4",
}

# 设备指纹下发端点（公开免鉴权；浏览器首次访问主站时也走它，与登录态无关）
SPI_URL = "https://api.bilibili.com/x/frontend/finger/spi"


def _pick_cookie(container, name: str) -> str | None:
    """从 httpx cookie 容器（Cookies / CookieJar）取指定名的值，同名多域时不抛异常。

    扫码回调会在 `.bilibili.com` 与 `passport.biligame.com` 等多处各写一份
    SESSDATA/bili_jct；httpx 的 `Cookies.get(name)` 此时抛 CookieConflict
    （"Multiple cookies exist with name=SESSDATA"，2026-09-08 用户实机报错），
    必须按域优先级手挑——api.bilibili.com 认的是 `.bilibili.com` 那一份。
    （微博侧同类问题见 weibo_auth 的同名 SUB 去重注释。）
    """
    try:
        val = container.get(name)
        if val:
            return val
    except Exception:
        pass  # CookieConflict / response 未绑定 request 等，走下面的遍历
    best: tuple[int, str] | None = None
    try:
        jar = getattr(container, "jar", container)
        for c in jar:
            if c.name != name or not c.value:
                continue
            dom = (c.domain or "").lstrip(".").lower()
            if dom == "bilibili.com":
                score = 3
            elif dom.endswith("bilibili.com"):
                score = 2
            elif dom:
                score = 1
            else:
                score = 0
            if best is None or score > best[0]:
                best = (score, c.value)
    except Exception:
        return None
    return best[1] if best else None


def _cookies_from_url(url: str) -> dict[str, str]:
    """从回调 URL 查询串提取凭据。

    B 站扫码回调（passport.biligame.com/crossDomain）把 SESSDATA / bili_jct /
    DedeUserID 直接写在查询串里跨域传递——即使 Set-Cookie 落在中间跳或第三域，
    这里也能拿到，是最稳的凭据来源。
    """
    out: dict[str, str] = {}
    try:
        qs = parse_qs(urlparse(url).query)
    except Exception:
        return out
    for key in _ATTR_MAP:
        vals = qs.get(key)
        if vals and vals[0]:
            out[key] = unquote(vals[0])
    return out

# QR 轮询状态码
# QR 轮询状态码。★ 必须读响应里的 data.code，不是外层 code：
# 外层 code=0 只表示「接口调用成功」，扫码状态在 data.code
# （实测 2026-09-08：未扫码 → {"code":0,...,"data":{"code":86101,"message":"未扫码"}}；
#  失效二维码 → {"code":0,...,"data":{"code":86038,"message":"二维码已失效"}}）。
# 旧实现只读外层 code，于是**每一次轮询都被当成「已确认」**：立刻走 complete()，
# 而 data.url 为空 → 取不到 cookie → nav 返回 -101「账号未登录」，
# 表现为「刷新二维码后立刻提示失效 / 登录无反应」。
QR_SUCCESS = {0, "0"}            # 手机端已确认
QR_EXPIRED = {86038, "86038"}    # 二维码已失效
QR_SCANNED = {86090, "86090"}    # 已扫码，等待手机端确认
QR_WAITING = {86101, "86101"}    # 未扫码


class BilibiliAuth:
    """B站认证单例，管理 Cookie 生命周期"""

    def __init__(self):
        self.sessdata: str = settings.BILI_SESSDATA
        self.bili_jct: str = settings.BILI_BIJI_JCT
        self.dede_user_id: str = settings.BILI_DEDE_USER_ID
        self.buvid3: str = settings.BILI_BUVID_3
        self.buvid4: str = settings.BILI_BUVID_4
        self.refresh_token: str = settings.BILI_REFRESH_TOKEN
        self.uname: str = ""            # 昵称（登录后 nav 回填，供登录态展示）
        self._needs_login: bool = not self.is_logged_in

    def needs_login(self) -> bool:
        return self._needs_login

    # ── cookie / headers ──────────────────────────────────────────

    @property
    def cookie_str(self) -> str:
        """发给 B 站的 Cookie 头。

        ⚠️ 设备号必须叫 **`buvid3`**（R26，devlog/126）：这里原先写的是 `bvuid3` ——
        那是登录响应里的名字，web API 不认，等于**每次都没带设备指纹**。
        值为空的那条会被下面过滤掉（发 `buvid3=` 空值比不发更可疑）。
        """
        parts = [
            f"SESSDATA={self.sessdata}",
            f"bili_jct={self.bili_jct}",
            f"DedeUserID={self.dede_user_id}",
            f"buvid3={self.buvid3}",
            f"buvid4={self.buvid4}",
        ]
        return "; ".join(p for p in parts if "=" in p and not p.endswith("="))

    def build_headers(self) -> dict:
        return {**BASE_HEADERS, "Cookie": self.cookie_str}

    async def ensure_device_ids(self) -> bool:
        """确保手上有设备指纹（`buvid3` / `buvid4`）——没有就照浏览器那样领一份并落盘。

        为什么要这一步（R26，devlog/126 真机实测）：B 站 web API 读的是 **`buvid3`**，
        而本仓库原先只把登录响应里的 `bvuid3` 当 `bvuid3=` 发回去 ⇒ 服务端每次都把我们当
        "没有设备号的新访客"，还会在响应里塞一枚新 `buvid3`（而我们丢掉不存）。
        修法两条：**名字发对**（见 `cookie_str`）+ **每个安装自己有设备号**。

        ⚠️ **绝不写死一份值**：所有安装共用同一份设备号 = 全网共享一个设备身份，
        比"没有设备号"更糟（这一条是 R26 的硬约束）。
        领号走公开免鉴权端点（`SPI_URL`），与登录态无关；失败只记日志 ——
        少一层指纹不影响任何抓取功能。

        返回 True = 这次领到了新号并已落盘。
        """
        if self.buvid3 and self.buvid4:
            return False
        try:
            async with new_async_client(15.0) as client:
                resp = await client.get(SPI_URL, headers=BASE_HEADERS)
                data = (resp.json() or {}).get("data") or {}
        except Exception as e:              # 网络/解析失败：不拦任何主流程
            logger.warning(f"领取设备指纹失败（照常抓取，只是少一层指纹）: {type(e).__name__}: {e}")
            return False
        changed = False
        for key, attr in (("b_3", "buvid3"), ("b_4", "buvid4")):
            val = str(data.get(key) or "").strip()
            if val and not getattr(self, attr, ""):
                setattr(self, attr, val)
                changed = True
        if changed:
            self._save_to_env()
            logger.info(f"设备指纹已就位并落盘：buvid3 {len(self.buvid3)} 字符 / "
                        f"buvid4 {len(self.buvid4)} 字符")
        return changed

    @property
    def is_logged_in(self) -> bool:
        return bool(self.sessdata and self.bili_jct)

    # ── .env 持久化 ───────────────────────────────────────────────

    def _save_to_env(self):
        """凭据持久化到数据目录 .env。

        2026-09-08 修复：旧逻辑在 `.env` 不存在时直接 warning 返回——而「首次扫码
        登录」恰恰就是数据目录里还没有 .env 的场景（桌面端全新安装），凭据于是只
        活在内存、重启即丢。save_env_keys 本身会创建父目录与文件，交给它即可。
        """
        values = {
            "BILI_SESSDATA": self.sessdata,
            "BILI_BIJI_JCT": self.bili_jct,
            "BILI_DEDE_USER_ID": self.dede_user_id,
            "BILI_BUVID_3": self.buvid3,
            "BILI_BUVID_4": self.buvid4,
            "BILI_REFRESH_TOKEN": self.refresh_token,
        }
        save_env_keys(values)

    def _parse_set_cookie(self, response: httpx.Response) -> dict:
        """从响应中提取 cookie：先试 httpx cookie jar，再试原始 Set-Cookie 头"""
        extracted: dict[str, str] = {}

        # 方式 1: httpx.Cookies（同名多域时按域优先级挑，不抛 CookieConflict）
        for name in _ATTR_MAP:
            val = _pick_cookie(response.cookies, name)
            if val:
                extracted[name] = val

        # 方式 2: 原始 Set-Cookie 头（兜底，有些响应 httpx 解析不全；
        #         多值需用 get_list，否则只看得到第一条）
        for header in response.headers.get_list("set-cookie"):
            for part in header.split(","):
                for name in _ATTR_MAP:
                    if name not in extracted:
                        m = re.search(rf"{name}=([^;,]+)", part)
                        if m:
                            extracted[name] = m.group(1).strip()

        return extracted

    def _collect_cookies(
        self, response: httpx.Response | None = None, jar: httpx.Cookies | None = None
    ) -> dict[str, str]:
        """汇总整条重定向链 + 客户端 cookie jar 里的凭据。

        2026-09-08 修复：httpx 的 `response.cookies` 只含**最后一跳**的 Set-Cookie，
        而扫码回调的 SESSDATA/bili_jct 往往发在中间 302（crossDomain → passport →
        www）上；只看最终响应会一个也拿不到 → nav 校验必然 -101「账号未登录」。
        """
        merged: dict[str, str] = {}
        if response is not None:
            for resp in (response, *response.history):
                for key, val in self._parse_set_cookie(resp).items():
                    merged.setdefault(key, val)
        if jar is not None:
            for name in _ATTR_MAP:
                val = _pick_cookie(jar, name)
                if val and name not in merged:
                    merged[name] = val
        return merged

    def _apply_cookies(self, extracted: dict[str, str]) -> bool:
        """写入内存并落盘；返回是否有变化。

        R26：设备号有两个来源名（`bvuid3` = 登录响应的老名字 / `buvid3` = web API 的规范名），
        两者映射到**同一个属性**。这里**先应用老名字、后应用规范名**，让"同时出现时规范名赢"
        成为确定行为 —— 否则结果取决于 Set-Cookie 的先后顺序（实测过这种脆弱点）。
        """
        changed = False
        order = {"bvuid3": 0}          # 老名字排在前面
        for key, val in sorted(extracted.items(), key=lambda kv: order.get(kv[0], 1)):
            attr = _ATTR_MAP.get(key)
            if attr and val and val != getattr(self, attr, ""):
                setattr(self, attr, val)
                changed = True
                logger.info(f"Cookie 已更新: {key}={val[:20]}...")
        if changed:
            self._save_to_env()
        return changed

    def _update_from_response(
        self, response: httpx.Response | None = None, jar: httpx.Cookies | None = None
    ):
        return self._apply_cookies(self._collect_cookies(response, jar))

    # ── 阶段 1：心跳 / 状态检查 ───────────────────────────────────

    async def check_session(self) -> bool:
        try:
            async with new_async_client(10.0) as client:
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
            async with new_async_client(10.0) as client:
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
            async with new_async_client(10.0) as client:
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
                # R26：设备指纹是**每安装一份**的（首次运行领一次，之后从 .env 读回）。
                # 放在维护循环最前面：即便本轮会话检查失败，指纹也已经就位。
                await self.ensure_device_ids()
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
        self.client = new_async_client(10.0)
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
        # 扫码状态在 data.code（见文件头 QR_* 注释）；外层 code 只表示接口调用成功。
        # 兼容处理：data 缺失时退回外层 code（老结构/异常响应）。
        data = poll_data.get("data") or {}
        code = data.get("code")
        if code is None:
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
        if not callback_url:
            # 走到这里只可能是「外层 code 被误判为确认」之类的异常响应：
            # 没有回调地址就拿不到凭据，直接失败，别让 nav 去撞 -101。
            logger.warning("扫码回调地址为空，无法获取登录凭据")
            return False, "未能获取到登录凭据，请重新扫码"
        # ① 访问回调 URL（重定向链会下发 Set-Cookie，同时种进客户端 jar）
        try:
            poll_resp = await self.client.get(
                callback_url,
                headers={**BASE_HEADERS, "Referer": "https://passport.bilibili.com/"},
                follow_redirects=True,
            )
        except Exception as e:
            logger.warning(f"访问回调 URL 失败: {e}")

        # ② 整条重定向链 + 客户端 cookie jar 补取（同名多域按域优先级挑）
        auth._update_from_response(poll_resp, jar=self.client.cookies)

        # ③ 回调 URL 查询串里的凭据是 crossDomain 的权威值，最后覆盖（最稳的一路）
        auth._apply_cookies(_cookies_from_url(callback_url))

        # ④ R26：登录响应给的设备号名字是 `bvuid3`，而 web API 认 `buvid3` ——
        #    这里补一次"没有就领一份"（有就直接返回，不发请求）。
        await auth.ensure_device_ids()

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
