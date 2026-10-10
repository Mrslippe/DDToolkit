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

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services import cookie_import, pairing
from app.services.auth import SESSDATA_WARN_DAYS, auth_manager
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
        # 与小红书/抖音同口径地给出**起点与活了多久**（2026-10-08，`devlog/455`）：
        # 用户问"登录怎么失效了"时，`note` 里那句「已配置 N 天」就是唯一能分辨
        # "刚配两天就挂（风控/多端踢）"与"用满一个月自然到期"的信息。
        age = auth_manager.age_days()
        if auth_manager.needs_login():
            note = ("B 站登录已失效" + auth_manager._lived_note()
                    + "；重新扫码或重新粘贴整条 Cookie 即可恢复")
            if not auth_manager.dede_user_id_ckmd5:
                note += "（缺 DedeUserID__ckMd5 ⇒ 平台不会下发续期令牌）"
        elif age is not None:
            note = f"已登录 {age:.1f} 天（{auth_manager.set_at[:10]} 起）"
            if age >= SESSDATA_WARN_DAYS:
                note += "—— 已接近平台标称寿命（约 1 个月），建议抽空重登一次"
        else:
            note = ""
        return {
            # ⚠️ `logged_in` 说的是**现在能不能用**，不是"凭据还在不在"（2026-10-08，`devlog/456`）：
            #    B 站是唯一一个"凭据在、但维护循环已判它失效"会同时成立的平台，而 Tab 标签原先
            #    只看这一位 ⇒ 界面上同时出现「B 站 · 已登录」与「B 站登录已失效」（用户截图）。
            #    凭据在不在另给 `configured`（口径与小红书/抖音一致）。
            "logged_in": auth_manager.is_logged_in and not auth_manager.needs_login(),
            "configured": auth_manager.is_logged_in,
            "needs_login": auth_manager.needs_login(),
            "uid": auth_manager.dede_user_id or None,
            "name": auth_manager.uname or None,
            "set_at": auth_manager.set_at or "",
            "age_days": age,
            "note": note,
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
        # ⚠️ **2026-10-10 补上**（自审的一致性扫描，`devlog/460`）：这里是四家平台里
        #    唯一**没给 `configured`** 的一家，而前端 `utils/platformLogin.ts` 靠它区分
        #    「从没配过」（无后缀）与「配过但挂了」（`· 已失效`）。缺了它，微博在
        #    cookie 过期时 Tab 上**一个字都不说** —— 看起来像从来没配过，
        #    正是 `devlog/456` 用户对 B 站报的那类困惑（那次只修了 B 站这一家）。
        #    取值与 B 站分支同义：`is_logged_in` = **凭据在不在**（不是能不能用）。
        "configured": weibo_auth_manager.is_logged_in,
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


# ── 浏览器扩展：配对凭证 + 一键导入（E1，2026-10-06）──────────────────────────
#
# 为什么要有这一组（用户的痛点）：B 站/微博今天只能扫码，小红书/抖音要手抄整条 Cookie
# （抖音还要手抄 UA），而**抄漏了键在导入那一刻不报**、要等抓取才炸。扩展一键同步
# 解决的正是这件事；本组的三个端点就是它的应用侧。
#
# ⚠️ 安全形状（细节见 `services/pairing.py` 与 `services/cookie_import.py`）：
#   · `GET /auth/pairing` 与 `POST /auth/pairing/reset` **要应用 token**（它们给的就是钥匙本身）；
#   · `POST /auth/import` 是**公开路径**（`api_auth.PUBLIC_EXACT` 里那一条）——
#     扩展拿不到应用 token，所以凭证校验挪进端点：**配对 token + 回环 + 失败节流**。

@router.get("/pairing")
def pairing_status(db: Session = Depends(get_db)):
    """给「设置 → 登录 → 浏览器扩展」那一栏用：当前配对 token + **上次同步**摘要。

    ⚠️ **没有就生成一个**（幂等）：打开那一栏就该有东西可复制，而不是先点一次「生成」。
    ⚠️ 返回值**只**该出现在那个界面与用户的粘贴板里 —— 不进日志、不进通知、不进诊断。
    `last_sync` 里只有键名与计数（`services/pairing.note_sync` 保证不落 cookie 值）。
    """
    return {"token": pairing.current_token(db), "last_sync": pairing.last_sync(db)}


@router.post("/pairing/reset")
def pairing_reset(db: Session = Depends(get_db)):
    """换一把新的配对 token（旧值**立即失效**）。用户点「重置」时调用。"""
    return {"token": pairing.reset_token(db)}


@router.post("/import")
async def import_cookie(request: Request, payload: dict, db: Session = Depends(get_db)):
    """**浏览器扩展推凭据的入口**（body: `{platform, cookie, ua?}` + 头 `X-DDToolkit-Pair`）。

    三层门（顺序有意）：
      ① 回环来源（端口可扫 ⇒ 挡的是"同网段的另一台机器"）；
      ② 失败节流（公开端点不许是无限次数的猜谜机）；
      ③ 配对 token（与应用 token **分开**的另一把钥匙）。

    回执**成功与失败同一形状**（`services/cookie_import.ImportReceipt`）：扩展侧一套解析；
    失败是 400 而不是 500 —— "缺键/过期"是**正常的业务结果**，用户要看到的是"缺哪个"。
    """
    host = request.client.host if request.client else None
    if not cookie_import.is_loopback(host):
        logger.warning("拒绝非回环来源的凭据导入：%s", host)
        raise HTTPException(403, "只接受来自本机（127.0.0.1）的导入")

    if pairing.is_throttled():
        # 不给"再试一次"的暗示：冷却窗口是 60s（`pairing.WINDOW_SECONDS`）
        raise HTTPException(429, "配对失败次数过多，请等一分钟再试")

    if not pairing.verify(db, request.headers.get(cookie_import.PAIR_HEADER)):
        pairing.note_failure()
        # ⚠️ 日志只说"失败了几次"，**绝不回显 token**（连长度都不写 —— 同 `api_auth` 的口径）
        logger.warning("凭据导入的配对 token 不对（本窗口内第 %d 次）",
                       pairing.recent_failures())
        raise HTTPException(401, "配对 token 不对 —— 到「设置 → 登录 → 浏览器扩展」复制当前那一条")

    body = payload or {}
    receipt = await cookie_import.apply(
        str(body.get("platform") or "").strip(),
        str(body.get("cookie") or ""),
        str(body.get("ua") or body.get("user_agent") or ""),
    )
    pairing.note_success()
    if not receipt.ok:
        return JSONResponse(status_code=400, content=receipt.as_dict())
    pairing.note_sync(db, platform=receipt.platform,
                      label=cookie_import.PLATFORM_LABELS.get(receipt.platform, receipt.platform),
                      keys=receipt.keys, cookie_keys=receipt.cookie_keys,
                      verified=receipt.verified)
    logger.info("扩展导入凭据：%s（%d 个键，%d 个可用键，verified=%s）",
                receipt.platform, receipt.cookie_keys, len(receipt.keys), receipt.verified)
    return receipt.as_dict()
