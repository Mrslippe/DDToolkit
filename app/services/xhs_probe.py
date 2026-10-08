"""小红书登录态**每日一次轻量探活**（需求 3，2026-10-08 用户口径，`devlog/453`）。

## 为什么现在要做（以及它取代了什么）

`xhs_auth.status()` 里原先写着「**不做**真实有效性探测：小红书没有免签名的探活端点，
硬探只会白挨一次风控」—— 那条口径的结论是"**只能等抓取时失败**"。
代价是：用户不主动抓就**永远不知道**登录态没了（研究结论也说失效主因是**服务端吊销 +
多端互踢**，一天左右就可能发生）。

本批按用户拍板改成「**探活 + 明确提示**」，并明确三件事（研究结论都指向它们）：

1. **只探活、不刷活**：一天**一次**、一次**一个**请求（复用适配器已证实的
   `user/otherinfo` 形状，带签名）—— 没有任何证据表明高频保活能延长会话，而它本身就是风控面；
2. **精细归因，别让用户白重粘**：只有"平台明确说会话没了"才置失效（`xhs_auth.note_invalid`）。
   **被限流 / 网络不通 / 我们自己的签名坏了** 都不置 —— 那三种情况下 cookie 可能完全没问题，
   让用户跑去重粘只会白忙（`devlog/338` 那条教训的同型：**说清该做哪件事**）；
3. **不自动登录、不过验证码**（灰色自动化，且多端互踢会踢掉用户手机端）。

## 状态

模块级记 `last_probe_at` / `last_kind` / `last_note`（进程内）：`xhs_auth.status()` 与
登录窗据此显示**具体原因**，而不是笼统一句"登录已过期"。重启即回到"按配置判断"
（与 `invalidated` 同一口径：宁可多报一次，不要永远沉默）。
"""
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from app.services.xhs_auth import xhs_auth_manager

logger = logging.getLogger(__name__)

#: 探活间隔（秒）：**一天一次**。太勤没有收益（会话不是被"放着"放坏的），只是多一次风控面。
PROBE_MIN_INTERVAL_SEC = 24 * 3600

# ── 归因（纯映射，可单测）────────────────────────────────────────────────

KIND_OK = "ok"
KIND_SESSION_KICKED = "session_kicked"
KIND_CHALLENGE = "challenge"
KIND_OUR_FAULT = "our_fault"
KIND_NETWORK = "network"
KIND_SKIPPED = "skipped"

#: 适配器（`classify_http`）的 kind → 探活归因。没列到的按 `network`（"没验成"）处理。
_KIND_MAP: dict[str, str] = {
    "cookie_invalid": KIND_SESSION_KICKED,
    "captcha": KIND_CHALLENGE,
    "risk_control": KIND_CHALLENGE,
    "signature_invalid": KIND_OUR_FAULT,
    "signer_unavailable": KIND_OUR_FAULT,
    "argus_missing": KIND_OUR_FAULT,
    "network_error": KIND_NETWORK,
    "identity_throttled": KIND_NETWORK,
    "not_found": KIND_OK,        # 业务上"这个人没了"，**登录态是好的**
    "business_error": KIND_OK,
}

#: **只有这一种**才置"登录已过期"（其余三种置了就是让用户白忙）。
INVALIDATING_KINDS = frozenset({KIND_SESSION_KICKED})


def probe_kind(adapter_kind: str) -> str:
    """适配器的失败 kind → 探活归因（未知 kind 按"没验成"= `network`）。"""
    return _KIND_MAP.get(adapter_kind or "", KIND_NETWORK)


def note_for(kind: str, age_days: float | None = None) -> str:
    """给用户的一句话：**发生了什么 + 该做什么**（四种"没验成"要分得开）。"""
    lived = f"（这条 Cookie 活了 {age_days:.1f} 天）" if age_days is not None else ""
    if kind == KIND_OK:
        return f"探活通过：登录态可用{lived}"
    if kind == KIND_SESSION_KICKED:
        return (f"登录态已被平台收回{lived} —— 常见原因是**在别处（含手机 App）登录过**，"
                f"会话被顶掉了。到「设置 → 登录 → 小红书」重新粘贴整条 Cookie 即可")
    if kind == KIND_CHALLENGE:
        return ("平台要求验证码 / 正在风控 —— 先去浏览器打开小红书把验证过掉；"
                "**登录态本身可能还在**，别急着重粘 Cookie")
    if kind == KIND_OUR_FAULT:
        return "没验成：我们这侧的签名不可用（**一个请求都没发**）—— 看日志排查，别重粘 Cookie"
    if kind == KIND_NETWORK:
        return "没验成：网络不通或被限流 —— 这**不代表登录态失效**，稍后会自动再探"
    return "没验（没配 Cookie 或还没有小红书账号）"


def should_probe(last_ts: float | None, now: float | None = None) -> bool:
    """到点了吗（**每日一次**）。`last_ts` 为 `None`（从没探过）⇒ 探一次。"""
    if last_ts is None:
        return True
    return (time.time() if now is None else now) - last_ts >= PROBE_MIN_INTERVAL_SEC


@dataclass
class ProbeResult:
    kind: str
    note: str
    http: int | None = None
    detail: str = ""
    at: str = ""


#: 进程内的最近一次探活（`xhs_auth.status()` 与登录窗读它显示具体原因）
_state: dict = {"last_ts": None, "last_kind": "", "last_note": "", "at": ""}


def last_probe() -> dict:
    return dict(_state)


def _remember(kind: str, note: str, at: str) -> None:
    _state.update(last_ts=time.time(), last_kind=kind, last_note=note, at=at)


async def probe_once(uid: str | None = None) -> ProbeResult:
    """探一次（**一个请求**）。返回归因结果；只有"会话被收回"才置失效。

    ⚠️ 复用适配器**已经证实过的**请求形状（`/api/sns/web/v1/user/otherinfo` +
    `_signed_headers`）—— 不新造端点：探活本身不该成为新的不确定性来源。
    """
    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if not xhs_auth_manager.is_configured:
        res = ProbeResult(KIND_SKIPPED, note_for(KIND_SKIPPED), at=at)
        _remember(res.kind, res.note, at)
        return res

    target = uid or _any_xhs_uid()
    if not target:
        res = ProbeResult(KIND_SKIPPED, note_for(KIND_SKIPPED), detail="库里还没有小红书账号", at=at)
        _remember(res.kind, res.note, at)
        return res

    from app.services.platforms.xiaohongshu import XiaohongshuPlatform

    plat = XiaohongshuPlatform(cookies=xhs_auth_manager.cookie)
    try:
        info = await plat.fetch_user_info(str(target))
    except Exception as e:  # noqa: BLE001 - 探活绝不许把调用方带崩
        logger.warning("小红书探活异常（按「没验成」处理）: %s: %s", type(e).__name__, e)
        info = None
    if info:
        kind = KIND_OK
    else:
        err = plat.last_error or {}
        kind = probe_kind(str(err.get("kind") or ""))
        # ⚠️ 适配器**没记错误**（例如被自己的节流挡下、压根没发请求）⇒ 那是"没验成"，
        #    不能算失效：`network` 这条分支就是为此存在的。
        if not err:
            kind = KIND_NETWORK
    note = note_for(kind, xhs_auth_manager.age_days())
    res = ProbeResult(kind, note, detail=str((plat.last_error or {}).get("msg") or ""), at=at)
    _remember(kind, note, at)
    # 具体原因写回登录态（`status()` 优先用它；四种归因分开说，别让用户按同一句提示瞎猜）
    xhs_auth_manager.probe_note = "" if kind == KIND_OK else note
    if kind in INVALIDATING_KINDS:
        xhs_auth_manager.note_invalid(res.detail or "探活时平台回「登录已过期」")
        logger.warning("小红书探活：登录态已被收回（%s）", res.detail or "code=-100")
    else:
        logger.info("小红书探活：%s（%s）", kind, res.detail or "无细节")
    return res


def _any_xhs_uid() -> str | None:
    """任取一个已收录的小红书账号 uid（探活只需要"一个能签名的目标"）。"""
    try:
        from app.core.database import SessionLocal
        from app.models.vtuber import Account

        db = SessionLocal()
        try:
            row = (db.query(Account)
                   .filter(Account.platform == "xiaohongshu")
                   .filter(Account.platform_uid.isnot(None))
                   .first())
            return str(row.platform_uid) if row else None
        finally:
            db.close()
    except Exception as e:  # noqa: BLE001 - 读库失败只是"没验成"
        logger.warning("小红书探活取目标失败（按未探处理）: %s: %s", type(e).__name__, e)
        return None


async def run_forever() -> None:
    """每日一次的探活循环（在 lifespan 里 create_task；失败只记日志、绝不退出循环）。"""
    import asyncio

    logger.info("小红书探活循环已启动（每 %d 小时一次）", PROBE_MIN_INTERVAL_SEC // 3600)
    while True:
        try:
            if should_probe(_state["last_ts"]):
                await probe_once()
        except Exception as e:  # noqa: BLE001
            logger.warning("小红书探活循环异常（忽略，稍后再来）: %s: %s", type(e).__name__, e)
        await asyncio.sleep(3600)
