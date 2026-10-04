"""统一扫码登录端点（B 站 / 微博共用 UI 流程）：

POST /auth/{platform}/qr/start   → {qr_id, url?(bilibili) / image?(weibo)}
GET  /auth/{platform}/qr/check?qr_id=  → waiting / scanned / confirmed / expired / failed
                                        （confirmed 时同步完成登录并持久化凭据）
GET  /auth/{platform}/status     → {logged_in, needs_login, uid, name}
"""
import logging
import time
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException

from app.services.auth import auth_manager
from app.services.douyin_auth import douyin_auth_manager
from app.services.weibo_auth import weibo_auth_manager
from app.services.xhs_auth import xhs_auth_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

_PLATFORMS = {"bilibili", "weibo", "xiaohongshu", "douyin"}
_QR_TTL = 180  # 二维码有效期（秒）

# 活跃扫码会话：qr_id → {"platform", "impl", "deadline"}
_sessions: dict[str, dict] = {}


def _manager(platform: str):
    if platform == "bilibili":
        return auth_manager
    return weibo_auth_manager


async def _invalidate_platform(platform: str) -> None:
    """同平台只保留最新会话：作废旧会话并关闭其 HTTP client。"""
    stale = [k for k, s in _sessions.items() if s["platform"] == platform]
    for k in stale:
        try:
            await _sessions.pop(k)["impl"].close()
        except Exception:
            pass


@router.post("/{platform}/qr/start")
async def qr_start(platform: str):
    if platform not in _PLATFORMS:
        raise HTTPException(404, "不支持的平台")
    impl = _manager(platform).begin_login()
    try:
        data = await impl.start()
    except Exception as e:
        await impl.close()
        logger.error(f"{platform} 生成二维码异常: {e}")
        raise HTTPException(500, f"生成二维码失败: {e}")
    if not data:
        await impl.close()
        raise HTTPException(502, "生成二维码失败，请稍后重试")

    await _invalidate_platform(platform)
    qr_id = uuid.uuid4().hex
    _sessions[qr_id] = {"platform": platform, "impl": impl,
                        "deadline": time.monotonic() + _QR_TTL}
    return {"qr_id": qr_id, **data}


@router.get("/{platform}/qr/check")
async def qr_check(platform: str, qr_id: str):
    if platform not in _PLATFORMS:
        raise HTTPException(404, "不支持的平台")
    sess = _sessions.get(qr_id)
    if not sess or sess["platform"] != platform:
        raise HTTPException(404, "二维码会话不存在或已过期，请重新生成")
    if time.monotonic() > sess["deadline"]:
        await _invalidate_platform(platform)
        return {"status": "expired"}

    try:
        status, payload = await sess["impl"].poll()
    except Exception as e:
        logger.warning(f"{platform} 轮询异常: {e}")
        return {"status": "waiting"}

    if status == "confirmed":
        try:
            ok, detail = await sess["impl"].complete(payload)
        except Exception as e:
            logger.error(f"{platform} 登录完成异常: {e}")
            ok, detail = False, str(e)
        finally:
            await _invalidate_platform(platform)
        if ok:
            return {"status": "confirmed", "detail": detail}
        return {"status": "failed", "detail": detail}
    return {"status": status}


@router.get("/{platform}/status")
async def auth_status(platform: str):
    """登录态查询。B 站走内存维护结果；微博做真实有效性探测（60s 缓存）——
    Cookie 过期后不能仅凭存在性报已登录，否则前端不出现重新扫码入口（2026-09 修复）。"""
    if platform not in _PLATFORMS:
        raise HTTPException(404, "不支持的平台")
    if platform == "bilibili":
        return {
            "logged_in": auth_manager.is_logged_in,
            "needs_login": auth_manager.needs_login(),
            "uid": auth_manager.dede_user_id or None,
            "name": auth_manager.uname or None,
        }
    if platform == "xiaohongshu":
        # ⚠️ 它**不做**真实有效性探测：没有免签名的探活端点，硬探只会白挨一次风控
        #    （见 `services/xhs_auth.py::status` 的说明）。
        return xhs_auth_manager.status()
    if platform == "douyin":
        # 同小红书：不做探活（探活也要签名）。真实失效由抓取侧的响应分类反映
        # —— ⚠️ 抖音的失效形态常是 **200 + 空体**，不是 401/403（devlog/333）。
        return douyin_auth_manager.status()
    valid = await weibo_auth_manager.check_valid()
    return {
        "logged_in": valid,
        "needs_login": not valid,
        "uid": weibo_auth_manager.uid or None,
        "name": weibo_auth_manager.name or None,
    }


# ── 小红书：**粘贴 cookie**（第 4 阶段 ④，devlog/233）──────────────────────
# 为什么不做扫码：它的二维码/状态接口**也**要签名与设备 cookie（鸡生蛋）；
# cookie 复用是调研 §2.8 与 MediaCrawler 共同的选择。

@router.post("/xiaohongshu/cookie")
def save_xhs_cookie(payload: dict):
    """保存小红书 cookie（body: `{"cookie": "a1=…; web_session=…"}`）。

    ⚠️ 校验不过 **400 且不落盘** —— 缺 `a1` 时签名器会直接报 `Missing 'a1' in cookies`，
    那种"存进去了但永远抓不到"最难排查，挡在入口更省事。
    """
    ok, why = xhs_auth_manager.apply_cookie(str((payload or {}).get("cookie") or ""))
    if not ok:
        raise HTTPException(400, why)
    return {"status": "saved", **xhs_auth_manager.status()}


# ── 抖音：**粘贴 cookie + UA**（第 4 阶段 ④ 第二刀，devlog/334）──────────────
# 为什么连 UA 一起收：`a_bogus` 把 UA 算进签名，而 UA 填错的症状是**静默的**
# （HTTP 200 + 0 字节空体，devlog/333）⇒ 让它跟 cookie 一起进来，别躺在默认值里。

@router.post("/douyin/cookie")
def save_douyin_cookie(payload: dict):
    """保存抖音 cookie（body: `{"cookie": "uifid=…; s_v_web_id=…; ttwid=…", "user_agent": "…"}`）。

    `user_agent` 可选：不给就沿用上次存的那份（或 `core/useragent.py` 的默认 Edge UA），
    但那只有在"cookie 也是同一个浏览器导的"时才自洽。
    """
    body = payload or {}
    ok, why = douyin_auth_manager.apply_cookie(str(body.get("cookie") or ""),
                                              str(body.get("user_agent") or ""))
    if not ok:
        raise HTTPException(400, why)
    return {"status": "saved", **douyin_auth_manager.status()}
