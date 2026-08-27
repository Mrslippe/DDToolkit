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
from app.services.weibo_auth import weibo_auth_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

_PLATFORMS = {"bilibili", "weibo"}
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
    if platform not in _PLATFORMS:
        raise HTTPException(404, "不支持的平台")
    if platform == "bilibili":
        return {
            "logged_in": auth_manager.is_logged_in,
            "needs_login": auth_manager.needs_login(),
            "uid": auth_manager.dede_user_id or None,
            "name": auth_manager.uname or None,
        }
    return {
        "logged_in": weibo_auth_manager.is_logged_in,
        "needs_login": False,
        "uid": weibo_auth_manager.uid or None,
        "name": weibo_auth_manager.name or None,
    }
