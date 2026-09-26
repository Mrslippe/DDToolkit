# -*- coding: utf-8 -*-
"""桌面通知：开播 / 新动态提醒（R50，devlog/219）。

## 用户要的是什么

用户口径（2026-09-26）：「当我关注的主播开播或更新动态时，电脑信息栏弹出弹窗通知」，
随后追加「增加点气泡直接开直播间/帖子页」。所以这条链路有两半：

1. **看得见**：`app/services/desktop_popup.py` 画的品牌色卡片（粉底、主播头像、
   悬停变亮、可点、折叠最多 10 层）；本模块负责**什么时候弹、弹什么**；
2. **点得开**：点卡片用默认浏览器打开 —— 开播 → 该场直播间，新动态 → 该条内容，
   都没有就退到主播主页。

## 为什么不用系统通知（WinRT Toast / 通知区域气泡）

- `Windows.UI.Notifications`（Win10/11 原生 Toast）要求进程带一个**已注册**的
  AppUserModelID —— 未注册的 AUMID 会被**静默丢弃**：不报错、不显示，跟"已发出"
  长得一模一样（本仓最怕的那类失败）。后端是 Tauri 拉起的 PyInstaller 子进程，
  安装包里没有这条注册链。
- 通知区域气泡（`Shell_NotifyIcon`）虽然不需要注册，但**样式由系统主题决定**
  （改不了配色/字号）、只在主屏右下角停几秒、还受"勿扰"管辖 —— 与"一定看得见、
  看得出是我们的"这个目标冲突。这条通路按用户口径**已下线**（`_make_balloon()`
  恒返回 None，实现保留作参考）。

## 硬约束：通知绝不能拖累抓取

- **零第三方依赖**：只用 ctypes 调 Win32（`gdiplus` / `user32` / `gdi32`），
  不动 `requirements.txt`；
- **不阻塞调用方**：`notify*()` 只做「判据 + 入队」，真正的弹窗在**守护线程**里；
- **静默失败**：非 Windows / 建窗失败 / 绘制失败 —— 一律只记日志、返回 False，
  调用方（调度线程）永远不为此抛错；
- **可关**：`settings.NOTIFY_ENABLED`（设置窗口的「弹出通知」总开关）。

## 降噪三件套

抓取是常态节拍（默认最快 1 分钟一轮），通知必须只对**新事件**开口：

1. **合并**：一个 V 一轮只出一条（"X 更新了动态：B站｜2 条新内容（投稿、动态）"），
   而不是每条帖子一条；
2. **去重**：`_seen` 按事件键（`live:{平台}:{uid}` / `post:{平台}:{pid}`）带 TTL
   记账 —— 同一场直播、同一条帖子不会被两个调用点弹两次；
3. **限流**：`NOTIFY_RATE_MAX` 条 / `NOTIFY_RATE_WINDOW_SECONDS`（滑窗）。
   超出的**丢弃并记日志**（不是排队补弹）：久别重逢式的开机场景里，一次补弹
   十几条比少弹几条更烦人，具体内容本来就在库里。

## 谁调用它

- **开播**：`scheduler._refresh_live_core()` 的 T0 边沿（`0/2 → 1`）；
- **新动态**：`scheduler._fetch_posts_core()` 里**真的入库成功**的那几条
  （只有增量轮询会通知；首次收录/手动全量补档不通知，否则一口气几十条）。

## 测试

单测用 `set_sink(fn)` 换掉真实后端（同步投递，不起线程、不建窗），
见 `tests/test_notifier.py`；绘图层另有 `tests/test_desktop_popup.py`。
"""

from __future__ import annotations

import ctypes
import logging
import os
import queue
import sys
import threading
import time
import uuid
import webbrowser
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence

from app.core.config import settings
from app.services import desktop_popup

logger = logging.getLogger(__name__)

IS_WINDOWS = sys.platform == "win32"

# 事件种类（去重 TTL 按种类取，见 `_dedupe_ttl`）
KIND_LIVE = "live"
KIND_POST = "post"

# 帖子类型 → 中文标签（与前端 `utils/postTypes.ts` 的展示口径一致；未知类型退「动态」）
POST_TYPE_LABELS: dict[str, str] = {
    "video": "投稿",
    "video_dynamic": "投稿",
    "article": "专栏",
    "music": "音乐",
    "image": "图文",
    "text": "动态",
    "repost": "转发",
    "live": "直播",
}

PLATFORM_LABELS: dict[str, str] = {"bilibili": "B站", "weibo": "微博"}

# 气泡字段硬上限（Win32 `NOTIFYICONDATAW`：szInfoTitle 64 / szInfo 256，留余量）
TITLE_LIMIT = 60
BODY_LIMIT = 180

# 有链接时在正文尾上挂一句提示：气泡没有按钮，不告诉用户"能点"就没人会点
CLICK_HINT = "｜点击打开"


@dataclass(frozen=True)
class Notification:
    """一条待弹的通知（标题 / 正文 / 事件键 / **点击要打开的链接**）。

    `url` 是「点气泡直达」的目标：开播→直播间，新动态→该条内容（没有 permalink 时
    退回该 V 的主页，见 `account_home_url`）。空串/None = 这条气泡不可点。
    """

    kind: str
    title: str
    body: str
    key: str = ""
    url: str | None = None
    # 气泡/卡片上的图标（主播头像的**本地文件路径**）；空 = 用 App 图标兜底
    icon_path: str | None = None


# ── 进程内投递状态 ────────────────────────────────────────────────────

_queue: "queue.Queue[Notification]" = queue.Queue(maxsize=64)
_state_lock = threading.Lock()
_worker: threading.Thread | None = None
# 投递线程退出闸门（**测试/take-home 用**：正常运行时线程是 daemon，随进程一起走）
_stop = threading.Event()
# 测试钩子：装上后通知**同步**送达该函数（不起线程、不建窗、不真弹）
_sink: Callable[[Notification], None] | None = None
# 事件键 → 过期时刻（monotonic）
_seen: dict[str, float] = {}
# 已弹时刻（滑窗限流）
_sent: deque[float] = deque()
# 最近一次**气泡投递**的结果（探针/端到端脚本要一个确定判据；见 `last_delivery`）
_last_delivery: dict | None = None

# 最近两组通知图标（主播头像转成的 HICON）：气泡/卡片可能还在屏幕上，
# 提前释放会变成白块 —— 保留两组，第三组到来时再释放最早那组。
_recent_icons: list[list[int]] = []


def enabled() -> bool:
    """通知总开关（设置窗口里那个；默认值来自 `NOTIFY_ENABLED`/环境变量）。"""
    return bool(getattr(settings, "NOTIFY_ENABLED", True))


def kind_enabled(kind: str) -> bool:
    """按事件种类判断要不要提醒（开播 / 更新动态各自一个开关）。

    `kind="test"`（设置窗口里的「发一条测试通知」）**不受这两个开关影响**：
    它存在的意义就是"验证通道与外观"，被事件开关拦住会让人以为通知坏了
    （实测踩过：关掉开播提示后点测试按钮毫无反应）。
    """
    if kind == KIND_LIVE:
        return bool(getattr(settings, "NOTIFY_LIVE", True))
    if kind == KIND_POST:
        return bool(getattr(settings, "NOTIFY_POST", True))
    return True


def set_sink(sink: Callable[[Notification], None] | None) -> None:
    """装/卸测试投递钩子（装上后 `notify()` 同步调用它，不碰真实气泡）。"""
    global _sink
    with _state_lock:
        _sink = sink


def reset_state() -> None:
    """清空去重/限流记账、最近投递结果与测试钩子（测试与探针共用）。"""
    global _sink, _last_delivery
    with _state_lock:
        _seen.clear()
        _sent.clear()
        _last_delivery = None
        _sink = None
        _stop.clear()
        for icons in _recent_icons:
            for hicon in icons:
                desktop_popup.destroy_icon(hicon)
        _recent_icons.clear()


def _keep_icons(icons: list[int]) -> None:
    """保住最近两组图标（气泡/卡片还在屏幕上时不能提前释放）。"""
    with _state_lock:
        _recent_icons.append(icons)
        while len(_recent_icons) > 2:
            for hicon in _recent_icons.pop(0):
                desktop_popup.destroy_icon(hicon)


def stop_worker() -> None:
    """请求投递线程退出（测试收尾用；正常运行不需要 —— 线程本来就是 daemon）。"""
    _stop.set()


def last_delivery() -> dict | None:
    """最近一次**气泡投递**的结果：`{title, body, url, ok, detail, at}`。

    队列版通知是"投出去就不管"，没有返回值可断言；端到端脚本要回答的正是
    "这条气泡到底交给 shell 了没有、没交出去是为什么"，所以由投递线程在这里
    留一份事实（`ok=False` 时 `detail` 写原因）。
    """
    with _state_lock:
        return dict(_last_delivery) if _last_delivery else None


def _record_delivery(item: Notification, *, ok: bool, detail: str = "",
                     balloon: bool = False, popup: bool = False,
                     icon: bool = False, stack: int = 1) -> None:
    """记下这次投递的判据：通道成败 + 是否用上主播头像 + **折叠层数** + 一句可读的原因。"""
    global _last_delivery
    with _state_lock:
        _last_delivery = {
            "title": item.title, "body": item.body, "url": item.url,
            "kind": item.kind, "key": item.key, "ok": bool(ok),
            "balloon": bool(balloon), "popup": bool(popup),
            "icon": bool(icon), "icon_path": item.icon_path,
            "stack": int(stack),
            "detail": detail, "at": time.time(),
        }


def _dedupe_ttl(kind: str) -> float:
    if kind == KIND_LIVE:
        # 60s ≈ T0 轮询周期：只挡住「同一轮里被两个调用点弹两次」，不禁掉"下播后马上又开"
        return float(getattr(settings, "NOTIFY_LIVE_DEDUPE_SECONDS", 60.0))
    return float(getattr(settings, "NOTIFY_POST_DEDUPE_SECONDS", 900.0))


def _trim(text: str | None, limit: int) -> str:
    """压平空白 + 剥掉零宽字符 + 截断（气泡不换行，多行文本会被挤成一条长条）。

    **为什么要剥零宽/变体字符**：通知的两条通道最后都由 **GDI** 画文字，而 GDI 不认
    emoji 的"变体选择符"（U+FE0F）、零宽连接符（U+200D）、肤色修饰符等 ——
    实测 `➡️`、`✅` 里的变体选择符会渲染成一个**空方块**（emoji 本体是好的：
    😭/⭐ 都能画出来）。这些字符本身没有可见内容，剥掉只会让排版更干净。
    """
    s = " ".join(str(text or "").split())
    s = "".join(ch for ch in s if not _is_invisible_mark(ch))
    return s if len(s) <= limit else s[: max(1, limit - 1)] + "…"


# 无可见内容、且 GDI 画成空方块的字符（变体选择符/零宽/肤色修饰/键帽圈）
_INVISIBLE_RANGES = (
    (0x200B, 0x200F),      # 零宽空格 / ZWNJ / ZWJ / LRM / RLM
    (0x2060, 0x2060),      # word joiner
    (0x20E3, 0x20E3),      # combining enclosing keycap
    (0xFE00, 0xFE0F),      # variation selectors（emoji 的 ️ 就是它）
    (0xFEFF, 0xFEFF),      # BOM / 零宽不换行空格（抓来的正文里偶尔混进来的）
    (0x1F3FB, 0x1F3FF),    # 肤色修饰符
)


def _is_invisible_mark(ch: str) -> bool:
    code = ord(ch)
    return any(lo <= code <= hi for lo, hi in _INVISIBLE_RANGES)


def _http_url(url: str | None) -> str | None:
    """只认 http/https 的链接（其余一律当"没有链接"）。

    链接来自平台数据（permalink / live_url），不是用户输入；但把 `os.startfile`
    的入参收窄到两种协议是**便宜的护栏** —— 万一上游数据脏了（`file:` / 自定义协议），
    点一下气泡不该变成"执行本机路径"。
    """
    u = (url or "").strip()
    return u if u[:7].lower() == "http://" or u[:8].lower() == "https://" else None


def live_room_url(platform: str, room_id: str | None) -> str | None:
    """由房间号拼出的直播间直链（目前只有 B 站有"房间号"这个概念）。

    `room_id` 不是数字就当没有（上游字段脏了不该拼出一个能点的错链接）。
    """
    rid = str(room_id or "").strip()
    if platform == "bilibili" and rid.isdigit():
        return f"https://live.bilibili.com/{rid}"
    return None


def account_home_url(platform: str, uid: str | None) -> str | None:
    """账号主页兜底链接（与前端 `utils/postTypes.ts::accountHomeUrl` 同口径）。

    用途：某条内容自己的 permalink 为空时，气泡点击至少落在"这个 V 的主页"上，
    而不是点了没反应。B 站 `accounts.url` 实测常为空（devlog/048），所以这条兜底
    不是可选项。
    """
    u = str(uid or "").strip()
    if not u:
        return None
    if platform == "bilibili":
        return f"https://space.bilibili.com/{u}"
    if platform == "weibo":
        return f"https://weibo.com/u/{u}"
    return None


def brand_icon_path() -> Path | None:
    """自家图标（`icon.ico`）的位置，找不到返回 None（退化成系统信息图标）。

    实现放在 `desktop_popup.app_icon_path()`（气泡与自绘卡片共用一套查找逻辑），
    这里保留同名入口给探针与测试用。
    """
    return desktop_popup.app_icon_path()


def _system_dpi() -> int:
    """系统 DPI（拿不到按 96 算）。托盘/气泡/卡片图标尺寸都按它缩放。"""
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.GetDpiForSystem.restype = ctypes.c_uint
        return int(user32.GetDpiForSystem() or 96)
    except Exception:
        return 96


def _icon_base_size() -> int:
    """一次通知里图标的目标边长（像素）：32 @100% / 48 @150% / 64 @200%。"""
    return max(32, round(32 * max(1.0, _system_dpi() / 96.0)))


def click_hint(kind: str) -> str:
    """自绘窗底部那行提示（告诉用户"这张卡片能点"）。"""
    if kind == KIND_LIVE:
        return "点击进入直播间 ›"
    if kind == KIND_POST:
        return "点击查看这条内容 ›"
    return "点击打开 ›"


def _open_url(url: str) -> None:
    """打开链接（默认浏览器）。**任何失败只记日志** —— 点击是用户动作，不能反过来炸线程。

    Windows 用 `os.startfile`（默认程序打开、会把错误抛出来，比 `webbrowser` 的
    静默 False 好排查），其它平台退回 `webbrowser`（非 Windows 本来也不弹气泡）。
    """
    target = _http_url(url)
    if target is None:
        logger.warning(f"气泡点击：链接不可打开（只认 http/https）: {url!r}")
        return
    try:
        if IS_WINDOWS:
            os.startfile(target)      # noqa: S606 - 用户点通知就是要"用默认浏览器打开它"
        else:
            webbrowser.open(target)
        logger.info(f"气泡点击：已打开 {target}")
    except Exception as e:
        logger.warning(f"气泡点击打开失败（忽略）: {type(e).__name__}: {e}")


def _dispatch(item: Notification, keys: Sequence[str], *, kind: str,
              force: bool = False) -> bool:
    """统一投递口：开关 → 去重 → 限流 →（sink | 队列）。

    **顺序有讲究**：限流判定在记账之前 —— 被限流掉的事件不该在 `_seen` 里留下
    痕迹（否则用户手动重试也永远弹不出来）。

    `force=True`（设置窗口的「发一条测试通知」用它）：**跳过限流，也不占用配额** ——
    测试通知是给用户快速试样式的，连点几下就被自己人限流掉纯属自找麻烦
    （2026-09-26 实测：用户拖滑杆连测 8 次后，测试按钮"突然失效"）。
    总开关、事件开关、去重仍然生效。
    """
    if not enabled():
        logger.debug(f"桌面通知已关闭（NOTIFY_ENABLED=0），跳过: {item.title}")
        return False
    if not kind_enabled(kind):
        # 开播提示 / 动态更新提示各自的开关（设置窗口里可分开关）
        logger.debug(f"{kind} 类通知已关闭，跳过: {item.title}")
        return False

    now = time.monotonic()
    window = float(getattr(settings, "NOTIFY_RATE_WINDOW_SECONDS", 60.0))
    rate_max = int(getattr(settings, "NOTIFY_RATE_MAX", 32))
    with _state_lock:
        for k, expiry in list(_seen.items()):
            if expiry <= now:
                del _seen[k]
        while _sent and now - _sent[0] > window:
            _sent.popleft()
        if any(k in _seen for k in keys):
            logger.debug(f"通知去重命中，跳过: {item.title}")
            return False
        if not force and len(_sent) >= rate_max:
            logger.info(f"通知限流（{window:.0f}s 内已弹 {len(_sent)} 条），本轮跳过: {item.title}")
            return False
        ttl = _dedupe_ttl(kind)
        for k in keys:
            _seen[k] = now + ttl
        if not force:
            _sent.append(now)          # 测试通知不进滑窗：不吃真实通知的配额
        sink = _sink

    if sink is not None:
        try:
            sink(item)
        except Exception as e:  # 测试钩子自身炸了也不能影响抓取
            logger.warning(f"通知投递钩子异常（忽略）: {type(e).__name__}: {e}")
        return True

    _ensure_worker()
    try:
        _queue.put_nowait(item)
    except queue.Full:
        logger.info(f"通知队列已满，丢弃: {item.title}")
        return False
    return True


def notify(kind: str, title: str, body: str, *, key: str = "",
           url: str | None = None, icon_path: str | None = None,
           force: bool = False) -> bool:
    """通用入口：弹一条通知（返回是否**真的投递**了，仅供测试/日志用）。

    `icon_path` 给本地图片路径时用它当图标（主播头像）——
    探针的 `--queue` 模式与端到端脚本都走这个入口。
    `force=True`：跳过限流（设置窗口的测试通知用，见 `_dispatch`）。
    """
    item = Notification(kind=kind, title=_trim(title, TITLE_LIMIT),
                        body=_trim(body, BODY_LIMIT), key=key,
                        url=_http_url(url), icon_path=icon_path)
    return _dispatch(item, [key or f"{kind}:{item.title}"], kind=kind, force=force)


def compose_live_start(vtuber_name: str, *, live_title: str | None = None,
                       platform: str = "bilibili", platform_uid: str = "",
                       url: str | None = None, room_id: str | None = None,
                       icon_path: str | None = None) -> Notification:
    """开播通知文案：「{V} 开播了」+ 直播标题（无标题时退回直播间链接）。

    点击目标优先级：显式 `url`（直播间）→ 由 `room_id` 拼出的直播间 → 该 V 在该平台的
    主页 → 不可点。`room_id` 这一档是**实测补的**：B 站账号的 `live_url` 常常是空的
    （`accounts.url` 同理），而房间号几乎总在 `accounts.room_id` 里 —— 少了它，
    用户点了卡片只会落到主播主页，而不是正在播的那一间（用户口径："点气泡直接开直播间"）。
    """
    target = (_http_url(url) or live_room_url(platform, room_id)
              or account_home_url(platform, platform_uid))
    # 预算里先扣掉「点击打开」提示的位置，免得提示被截断（截断的提示等于没有提示）
    budget = BODY_LIMIT - (len(CLICK_HINT) if target else 0)
    label = PLATFORM_LABELS.get(platform, platform)
    body = f"{label}直播间"
    if (live_title or "").strip():
        body += f"｜{_trim(live_title, budget - len(body) - 1)}"
    elif (url or "").strip():
        body += f"｜{url}"
    body = _trim(body, budget) + (CLICK_HINT if target else "")
    return Notification(kind=KIND_LIVE, title=_trim(f"{vtuber_name} 开播了", TITLE_LIMIT),
                        body=body, key=f"live:{platform}:{platform_uid}",
                        url=target, icon_path=icon_path)


def notify_live_start(vtuber_name: str, *, live_title: str | None = None,
                      platform: str = "bilibili", platform_uid: str = "",
                      url: str | None = None, room_id: str | None = None,
                      icon_path: str | None = None) -> bool:
    """开播提醒（投递；文案见 `compose_live_start`）。"""
    item = compose_live_start(vtuber_name, live_title=live_title, platform=platform,
                              platform_uid=platform_uid, url=url, room_id=room_id,
                              icon_path=icon_path)
    return _dispatch(item, [item.key], kind=KIND_LIVE)


def compose_new_posts(vtuber_name: str, platform: str,
                      items: Iterable[Mapping],
                      account_url: str | None = None,
                      icon_path: str | None = None) -> Notification | None:
    """新动态通知文案：**一个 V 一条**（多条合并成"N 条新内容（类型）+ 首条标题"）。

    点击目标：**第一条新内容的 permalink** → 账号主页（`account_url`）→ 不可点。
    多条内容只开一条（气泡没有列表可选），开"最新那条"是最不意外的选择。

    没内容返回 None（调用方不必先判空）。
    """
    rows = [it for it in items if it]
    if not rows:
        return None

    labels: list[str] = []
    for it in rows:
        label = POST_TYPE_LABELS.get(str(it.get("type") or ""), "动态")
        if label not in labels:
            labels.append(label)

    target = _http_url(rows[0].get("permalink")) or _http_url(account_url)
    budget = BODY_LIMIT - (len(CLICK_HINT) if target else 0)
    label = PLATFORM_LABELS.get(platform, platform)
    head = _trim(rows[0].get("title") or rows[0].get("summary"), budget // 2)
    body = f"{label}｜{len(rows)} 条新内容（{'、'.join(labels[:3])}）"
    if head:
        body += f"：{head}"
    keys = post_keys(platform, rows)
    body = _trim(body, budget) + (CLICK_HINT if target else "")
    return Notification(kind=KIND_POST, title=_trim(f"{vtuber_name} 更新了动态", TITLE_LIMIT),
                        body=body, key=",".join(keys), url=target, icon_path=icon_path)


def post_keys(platform: str, items: Iterable[Mapping]) -> list[str]:
    """帖子级去重键（同一条帖子被两轮抓到也不会弹两次）。"""
    return [f"post:{platform}:{it.get('platform_post_id')}"
            for it in items if it.get("platform_post_id")]


def notify_new_posts(vtuber_name: str, platform: str, items: Iterable[Mapping],
                     account_url: str | None = None,
                     icon_path: str | None = None) -> bool:
    """新动态提醒（投递；文案与去重键见 `compose_new_posts`）。

    只由自动动态流在入库后调用（收录/全量/手动更新刻意不调 —— 那些是用户自己
    发起的导入，弹通知只会变成噪音；口径见 `docs/backend-fetch-pipeline.md` §11）。
    """
    rows = [it for it in items if it]
    item = compose_new_posts(vtuber_name, platform, rows, account_url=account_url,
                             icon_path=icon_path)
    if item is None:
        return False
    return _dispatch(item, post_keys(platform, rows) or [item.key], kind=KIND_POST)


# ── 投递线程 ──────────────────────────────────────────────────────────

def show_now(title: str, body: str, *, linger: float | None = None,
             url: str | None = None, kind: str = "test",
             popup: bool | None = None, avatar: str | None = None) -> bool:
    """**同步**把一条通知展示出来（自绘窗；系统气泡已下线），返回是否成功显示。

    抓取路径**不要**调它：它会在调用线程里泵消息、等展示结束（`linger` 秒）才返回。
    `scripts/notify_probe.py` 用它拿一个确定的成败判据 —— 队列版通知是"投出去就不管"，
    探针需要一个能判 0/1 的对象；`url` 给上时，还能顺手验"点了会开浏览器"。

    `popup=None` 表示跟随 `NOTIFY_POPUP_ENABLED`（默认开）。
    """
    if not IS_WINDOWS:
        logger.info("非 Windows 平台：无可用的展示后端")
        return False
    wait = float(getattr(settings, "NOTIFY_BALLOON_LINGER_SECONDS", 8.0)) if linger is None else linger
    target = _http_url(url)
    clean_title = _trim(title, TITLE_LIMIT)
    clean_body = _trim(body, BODY_LIMIT)
    icon = 0
    if avatar:
        icon = desktop_popup.image_file_to_hicon(avatar, _icon_base_size())
        if icon:
            _keep_icons([icon])

    # 系统气泡可单独关闭（NOTIFY_BALLOON_ENABLED=0 → 只发自绘卡片）
    # 系统气泡已下线（_make_balloon 恒 None）：show_now 只展示自绘卡片
    balloon: "_Balloon | None" = None
    ok_balloon = False

    use_popup = desktop_popup.popup_enabled() if popup is None else bool(popup)
    popup_window: "desktop_popup.PopupWindow | None" = None
    ok_popup = False
    if use_popup:
        try:
            popup_window = desktop_popup.PopupWindow(on_click=_open_url)
            ok_popup = bool(popup_window.open() and popup_window.show(
                title=clean_title, body=clean_body, url=target,
                hint=click_hint(kind), seconds=wait, icon=icon))
        except Exception as e:
            logger.warning(f"自绘提示窗展示失败（忽略）: {type(e).__name__}: {e}")
            popup_window = None

    # 展示期间必须**泵消息**：气泡点击回调与自绘窗的点击都走这条窗口消息
    deadline = time.monotonic() + max(0.0, wait)
    try:
        while True:
            if balloon is not None:
                balloon.pump()
            elif popup_window is not None:
                popup_window.pump()
            if popup_window is not None:
                popup_window.tick()
            if time.monotonic() >= deadline:
                break
            time.sleep(0.05)
    finally:
        if balloon is not None:
            balloon.close()
        if popup_window is not None:
            popup_window.close()

    _record_delivery(Notification(kind=kind, title=clean_title, body=clean_body, url=target),
                     ok=ok_balloon or ok_popup, balloon=ok_balloon, popup=ok_popup,
                     icon=bool(icon),
                     stack=int(getattr(popup_window, "stack", 1)) if popup_window else 1,
                     detail="" if (ok_balloon or ok_popup) else "两个展示通道都失败")
    return ok_balloon or ok_popup


def _ensure_worker() -> None:
    """确保投递线程活着（懒启动；抓取线程只在这里付一次锁开销）。"""
    global _worker
    with _state_lock:
        if _worker is not None and _worker.is_alive():
            return
        _worker = threading.Thread(target=_worker_loop, name="notifier", daemon=True)
        _worker.start()


def _make_balloon() -> "_Balloon | None":
    """**恒返回 None**：自 2026-09-26 起只用应用自己的弹窗，不再用系统通知区域气泡。

    用户口径：「删除系统弹窗的选择，只保留应用的弹窗」——
    所以系统气泡那条通道**整体下线**（设置窗口里也不再出现这个开关）。
    `_Balloon` 的实现与单测都保留着：它是"系统气泡"这条路的完整参考，
    将来若要恢复（比如想借操作中心留档），把这里改回去即可。
    """
    return None


def _make_popup() -> "desktop_popup.PopupWindow | None":
    """建自绘提示窗（C 方案里"一定看得见"的那条通道）；失败就只用气泡。

    与 `_make_balloon` 一样是**可替换的接缝**：测试塞假实现即可验投递与判据。
    """
    if not IS_WINDOWS or not enabled():
        return None
    try:
        popup = desktop_popup.PopupWindow(on_click=_open_url)
        return popup if popup.open() else None
    except Exception as e:
        logger.warning(f"自绘提示窗初始化失败（只用气泡）: {type(e).__name__}: {e}")
        return None


def _deliver(item: Notification, balloon: "_Balloon | None",
             popup: "desktop_popup.PopupWindow | None" = None) -> bool:
    """把一条通知**同时**用两个通道送出去，并把结果记进 `last_delivery`。

    - **通道一：自绘提示窗**（我们画）—— 品牌配色、弹在鼠标所在那块屏、一定看得见；
    - **通道二：通知区域气泡**（Windows 画）—— 已按用户口径**下线**
      （`_make_balloon()` 恒返回 None），保留参数是为了沿用既有测试与将来可能的恢复。

    只要有一条成功就算投递成功；两条都失败只记日志、返回 False ——
    通知不能成为调用方（抓取线程）的故障点。

    **折叠**由 `desktop_popup` 自己管：上一条还在屏幕上就往上叠一层（上限 10），
    这里只把"叠了几层"读回来记进判据（`last_delivery()["stack"]`）。
    """
    url = _http_url(item.url)
    ok_balloon = ok_popup = False
    problems: list[str] = []

    # 主播头像 → 图标：气泡大图标与卡片左上角各取一档尺寸（按 DPI，不拉伸）。
    # 没有头像文件 / 格式不支持 → 两个通道各自退回 App 图标。
    avatar = 0
    if item.icon_path and IS_WINDOWS:
        try:
            avatar = desktop_popup.image_file_to_hicon(item.icon_path, _icon_base_size())
            if avatar:
                _keep_icons([avatar])      # 气泡与卡片共用同一个 HICON
            else:
                problems.append(f"头像不可用（{Path(item.icon_path).name}），退回 App 图标")
        except Exception as e:
            problems.append(f"头像加载异常 {type(e).__name__}: {e}")

    if balloon is not None:
        try:
            balloon.click_url = url
            ok_balloon = bool(balloon.show(item.title, item.body, icon=avatar))
            if not ok_balloon:
                problems.append("Shell_NotifyIcon 返回失败（通知区域不可用）")
        except Exception as e:
            problems.append(f"气泡异常 {type(e).__name__}: {e}")

    if popup is not None:
        try:
            ok_popup = bool(popup.show(title=item.title, body=item.body, url=url,
                                       hint=click_hint(item.kind), icon=avatar))
        except Exception as e:
            problems.append(f"自绘窗异常 {type(e).__name__}: {e}")

    if balloon is None and popup is None:
        # 两个通道都不可用（非 Windows / 都建窗失败）：至少把内容落到日志里
        logger.info(f"[通知] {item.title}｜{item.body}"
                    + (f"（点击 → {url}）" if url else ""))
        _record_delivery(item, ok=False, detail="无可用展示通道（非 Windows / 建窗失败）")
        return False

    ok = ok_balloon or ok_popup
    # 注意：**失败原因在成功时也要留着** —— "成功但降级了"（例如头像读不出、退回 App 图标，
    # 或只剩自绘窗这一条通道）正是排查时最想看到的上下文。
    detail = "；".join(problems)
    if not ok and not detail:
        detail = "两个通道都未成功"
    if not ok:
        logger.warning(f"通知未能展示（{detail}），通知内容：{item.title}｜{item.body}"
                       + (f"（点击 → {url}）" if url else ""))
    depth = int(getattr(popup, "stack", 1)) if popup is not None else 1
    _record_delivery(item, ok=ok_balloon or ok_popup, detail=detail,
                     balloon=ok_balloon, popup=ok_popup, icon=bool(avatar),
                     stack=depth)
    return ok


def _worker_loop() -> None:
    """弹窗线程：逐条取队列 → 弹气泡；空闲超时后摘掉通知区域图标。

    线程是 daemon：进程退出不等待它（气泡本身也不是必须送达的东西）。
    """
    balloon = _make_balloon()
    popup = _make_popup()
    linger = float(getattr(settings, "NOTIFY_BALLOON_LINGER_SECONDS", 8.0))
    min_gap = float(getattr(settings, "NOTIFY_MIN_INTERVAL_SECONDS", 1.2))
    last_shown = 0.0
    try:
        while not _stop.is_set():
            # 泵窗口消息：气泡点击（NIN_BALLOONUSERCLICK）就是靠它送到窗口过程的。
            # 即使消息来了不处理，也**必须**泵 —— 否则消息堆在线程队列里，
            # 用户在气泡上点的那一下会被当成"没反应"。
            # 两条通道在**同一个线程**里，消息按线程排队 → 一次 pump 就够
            if balloon is not None:
                balloon.pump()
            elif popup is not None:
                popup.pump()
            if popup is not None:
                popup.tick()          # 自绘窗到点自动收（不依赖 WM_TIMER）
            try:
                item = _queue.get(timeout=0.25)
            except queue.Empty:
                # 通知区域不该常驻图标：显示期一过就摘（explorer 里不留垃圾）
                if balloon is not None and last_shown and time.monotonic() - last_shown >= linger:
                    balloon.hide()
                    last_shown = 0.0
                continue
            try:
                if balloon is not None:
                    gap = time.monotonic() - last_shown
                    if last_shown and gap < min_gap:
                        balloon.wait(min_gap - gap)   # 等间隔也泵消息：用户可能点上一枚气泡
                # 折叠由自绘窗自己管（上一条还在屏幕上就往上叠，上限 10 层）
                if _deliver(item, balloon, popup) or (balloon is None and popup is None):
                    last_shown = time.monotonic()
            except Exception as e:   # `_deliver` 自己已兜底，这里是最后一道
                logger.warning(f"投递循环异常（忽略）: {type(e).__name__}: {e}")
    finally:
        if balloon is not None:
            try:
                balloon.close()
            except Exception:
                pass
        if popup is not None:
            try:
                popup.close()
            except Exception:
                pass


# ── Win32 后端（`Shell_NotifyIcon`） ─────────────────────────────────

if IS_WINDOWS:  # pragma: no cover - 平台分支（Linux/mac 下不定义这些结构）
    from ctypes import wintypes

    # LRESULT / WNDPROC：窗口过程必须用**指针宽度**的返回类型，否则 64 位下
    # 返回值被截断成 int32（窗口消息一多就会崩）
    LRESULT = ctypes.c_ssize_t
    WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT,
                                 wintypes.WPARAM, wintypes.LPARAM)

    class _GUID(ctypes.Structure):
        _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort),
                    ("Data3", ctypes.c_ushort), ("Data4", ctypes.c_ubyte * 8)]

    class _NOTIFYICONDATAW(ctypes.Structure):
        """`NOTIFYICONDATAW`（V3 全字段）。

        只填到 `dwInfoFlags` 用不到的部分也要**给全**：`cbSize` 决定 shell 认哪一版
        结构，传全尺寸（V3）最省事；多余的 `guidItem`/`hBalloonIcon` 留零即"用 uID"。
        """

        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("hWnd", wintypes.HWND),
            ("uID", wintypes.UINT),
            ("uFlags", wintypes.UINT),
            ("uCallbackMessage", wintypes.UINT),
            ("hIcon", wintypes.HICON),
            ("szTip", wintypes.WCHAR * 128),
            ("dwState", wintypes.DWORD),
            ("dwStateMask", wintypes.DWORD),
            ("szInfo", wintypes.WCHAR * 256),
            ("uTimeout", wintypes.UINT),
            ("szInfoTitle", wintypes.WCHAR * 64),
            ("dwInfoFlags", wintypes.DWORD),
            ("guidItem", _GUID),
            ("hBalloonIcon", wintypes.HICON),
        ]

    class _WNDCLASSEXW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.UINT),
            ("style", wintypes.UINT),
            ("lpfnWndProc", WNDPROC),
            ("cbClsExtra", ctypes.c_int),
            ("cbWndExtra", ctypes.c_int),
            ("hInstance", wintypes.HINSTANCE),
            ("hIcon", wintypes.HICON),
            ("hCursor", wintypes.HANDLE),
            ("hbrBackground", wintypes.HBRUSH),
            ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR),
            ("hIconSm", wintypes.HICON),
        ]


class _Balloon:  # pragma: no cover - 需要真实 Windows 桌面会话才有意义
    """通知区域气泡后端（工作线程独占；一次 `open()` 复用全部气泡）。

    - `open()`：注册窗口类 + 建一个**隐藏的顶层窗口**。`Shell_NotifyIcon` 要求
      真实 hWnd —— `HWND_MESSAGE` 消息窗**不行**（消息窗不参与 shell 的图标广播）；
    - `show()`：首次 `NIM_ADD`（带 `NIF_INFO` 即弹气泡），之后 `NIM_MODIFY`
      复用同一个 uID 换文案再弹（避免反复增删图标）；
    - `hide()`：`NIM_DELETE` 摘图标 —— 气泡显示期结束后通知区域不留图标。

    ## 点击直达（`NIN_BALLOONUSERCLICK`）

    shell 在用户**点气泡本体**时会往 `hWnd` 投一条 `uCallbackMessage`（我们传的是
    `WM_APP+1`），`lParam == NIN_BALLOONUSERCLICK`（0x405）。要收到它必须满足两条：
    ① `NIF_MESSAGE` + `uCallbackMessage`（已设）；② **调用方在泵消息**（`pump()`
    或 `wait()`），否则消息只是堆在线程队列里，用户看到的是"点了没反应"。

    ⚠️ 点击只在**图标还在**（`show()` 之后、`hide()` 之前）时有效 —— 所以
    `NOTIFY_BALLOON_LINGER_SECONDS`（默认 8s）决定了"点得动"的窗口有多大。
    气泡已经被收进操作中心之后再点，多半收不到回调（图标已摘）。
    """

    WM_APP = 0x8000
    CALLBACK_MSG = WM_APP + 1
    UID = 1

    NIM_ADD, NIM_MODIFY, NIM_DELETE = 0, 1, 2
    NIF_MESSAGE, NIF_ICON, NIF_TIP, NIF_INFO = 0x1, 0x2, 0x4, 0x10
    NIIF_INFO = 0x1
    NIIF_USER = 0x4          # 用 hBalloonIcon 指定的自家图标，而不是系统信息图标
    NIIF_LARGE_ICON = 0x20   # 32×32（默认 16×16）
    IDI_INFORMATION = 32516
    IDI_APPLICATION = 32512
    ERROR_CLASS_ALREADY_EXISTS = 1410
    # 托盘回调 lParam 语义（NIN_* = "Notify Icon Notification"）
    NIN_BALLOONSHOW, NIN_BALLOONHIDE = 0x402, 0x403
    NIN_BALLOONTIMEOUT, NIN_BALLOONUSERCLICK = 0x404, 0x405
    PM_REMOVE = 0x1

    def __init__(self) -> None:
        # GetModuleHandleW 在 kernel32，其余（窗口类/窗口/图标/窗口过程）在 user32
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._user32 = ctypes.WinDLL("user32", use_last_error=True)
        self._shell32 = ctypes.WinDLL("shell32", use_last_error=True)
        # ⚠️ 必须持有 WNDPROC 的引用：局部对象被回收后窗口过程变成野指针
        self._wndproc = WNDPROC(self._on_message)
        self._hwnd: int | None = None
        self._added = False
        self._icon = 0
        # 自家图标：**按用途分别加载合适尺寸**（用户实测反馈"图标分辨率有点低"——
        # 一个尺寸套所有用途，必然有被拉伸/缩小糊掉的那一处）
        self._brand_tray = 0        # 通知区域小图标（16/24/32…随 DPI）
        self._brand_balloon = 0     # 气泡左侧大图标（32/48/64…随 DPI）
        # 当前这条气泡点开要去的地址（None = 点不动）
        self.click_url: str | None = None
        self._bind()

    # -- 绑定（argtypes 必须显式给：默认 int 转换会在 64 位下截断指针）--
    def _bind(self) -> None:
        from ctypes import wintypes

        k, u, s = self._kernel32, self._user32, self._shell32
        k.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
        k.GetModuleHandleW.restype = wintypes.HINSTANCE
        u.RegisterClassExW.argtypes = [ctypes.POINTER(_WNDCLASSEXW)]
        u.RegisterClassExW.restype = wintypes.WORD
        u.CreateWindowExW.argtypes = [
            wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
        ]
        u.CreateWindowExW.restype = wintypes.HWND
        u.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT,
                                    wintypes.WPARAM, wintypes.LPARAM]
        u.DefWindowProcW.restype = LRESULT
        u.DestroyWindow.argtypes = [wintypes.HWND]
        u.DestroyWindow.restype = wintypes.BOOL
        u.LoadIconW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR]
        u.LoadIconW.restype = wintypes.HICON
        u.GetDpiForSystem.argtypes = []
        u.GetDpiForSystem.restype = wintypes.UINT
        u.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND,
                                   wintypes.UINT, wintypes.UINT, wintypes.UINT]
        u.PeekMessageW.restype = wintypes.BOOL
        u.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
        u.TranslateMessage.restype = wintypes.BOOL
        u.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
        u.DispatchMessageW.restype = LRESULT
        s.Shell_NotifyIconW.argtypes = [wintypes.DWORD, ctypes.POINTER(_NOTIFYICONDATAW)]
        s.Shell_NotifyIconW.restype = wintypes.BOOL

    def _on_message(self, hwnd, msg, wparam, lparam) -> int:
        """窗口过程：接管"点了气泡"这一条，其余交 `DefWindowProcW`。

        ⚠️ 这个函数跑在 ctypes 回调里（C 栈上），**绝不能让异常穿出去** ——
        ctypes 只会打一行 "Exception ignored" 然后返回垃圾值，现场极难查。
        所以整段包 try，失败只记日志。
        """
        try:
            if msg == self.CALLBACK_MSG and int(lparam) == self.NIN_BALLOONUSERCLICK:
                url = self.click_url
                if url:
                    # 就地打开：os.startfile 只是把 URL 交给 shell（几十毫秒），
                    # 且能拿到真实的失败原因；起线程反而让"点了会怎样"不可断言。
                    _open_url(url)
                else:
                    logger.debug("气泡被点击，但这条通知没有链接")
                return 0
        except Exception as e:
            logger.warning(f"气泡点击处理异常（忽略）: {type(e).__name__}: {e}")
        return self._user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def pump(self, budget: int = 64) -> int:
        """派发本线程已到达的窗口消息（点击回调靠这一步才到 `_on_message`）。

        ⚠️ **必须有上限**（`budget`）：窗口消息可能**源源不断**（鼠标扫过通知区域时 shell
        会连续投回调消息），没有上限的 `while PeekMessage` 会把调它的人永远困在里面 ——
        表现是"弹完气泡后进程不走了"。2026-09-26 在真实桌面上踩到（沙箱桌面消息稀少，
        完全看不出来）。返回本轮派发条数。
        """
        from ctypes import wintypes

        msg = wintypes.MSG()
        seen = 0
        while seen < budget and self._user32.PeekMessageW(ctypes.byref(msg), None, 0, 0,
                                                         self.PM_REMOVE):
            self._user32.TranslateMessage(ctypes.byref(msg))
            self._user32.DispatchMessageW(ctypes.byref(msg))
            seen += 1
        return seen

    def wait(self, seconds: float) -> None:
        """在 `seconds` 内泵消息（气泡显示期 / 两条气泡之间的间隔都用它，别用 sleep）。

        泵是**分批 + 带预算**的，所以即使消息刷屏，时间到了也一定返回。
        """
        deadline = time.monotonic() + max(0.0, seconds)
        while True:
            self.pump()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(0.05, remaining))

    def open(self) -> bool:
        from ctypes import wintypes

        inst = self._kernel32.GetModuleHandleW(None)
        class_name = f"DDtoolkitNotify_{uuid.uuid4().hex}"
        wc = _WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(_WNDCLASSEXW)
        wc.lpfnWndProc = self._wndproc
        wc.hInstance = inst
        wc.lpszClassName = class_name
        if not self._user32.RegisterClassExW(ctypes.byref(wc)):
            err = ctypes.get_last_error()
            if err != self.ERROR_CLASS_ALREADY_EXISTS:
                logger.warning(f"通知窗口类注册失败（err={err}）")
                return False
        hwnd = self._user32.CreateWindowExW(
            0, class_name, class_name, 0, 0, 0, 0, 0, None, None, inst, None)
        if not hwnd:
            logger.warning(f"通知窗口创建失败（err={ctypes.get_last_error()}）")
            return False
        self._hwnd = hwnd  # 隐藏窗口：没给 WS_VISIBLE，不 ShowWindow 就永远不显示

        self._icon = self._load_icon(wintypes)
        self._load_brand_icons()
        return True

    def _load_icon(self, wintypes) -> int:
        for res_id in (self.IDI_INFORMATION, self.IDI_APPLICATION):
            icon = self._user32.LoadIconW(
                None, ctypes.cast(ctypes.c_void_p(res_id), wintypes.LPCWSTR))
            if icon:
                return icon
        return 0

    def _icon_size(self, base: int) -> int:
        """按系统 DPI 缩放图标尺寸。

        托盘图标由 shell 按 DPI 渲染：100% 是 16px、150% 是 24px、200% 是 32px；
        气泡大图标同理（32 → 48 → 64）。**按用途给对的尺寸**，`icon.ico` 里这 11 档
        正好一一对得上，不需要任何拉伸。
        """
        try:
            dpi = int(self._user32.GetDpiForSystem() or 96)
        except Exception:
            dpi = 96
        return max(base, round(base * max(1.0, dpi / 96.0)))

    def _load_brand_icons(self) -> None:
        """加载随包分发的 `icon.ico`（猫脸）——托盘与气泡各取一档尺寸。"""
        path = brand_icon_path()
        if path is None:
            logger.info("未找到自家图标（气泡用系统信息图标顶替）")
            return
        self._brand_tray = desktop_popup.load_icon_file(path, self._icon_size(16))
        self._brand_balloon = desktop_popup.load_icon_file(path, self._icon_size(32))
        if not self._brand_balloon:
            logger.info(f"品牌图标加载失败（用系统信息图标顶替）: {path}")

    def _fill(self, title: str, body: str, icon: int = 0) -> "_NOTIFYICONDATAW":
        nid = _NOTIFYICONDATAW()
        nid.cbSize = ctypes.sizeof(_NOTIFYICONDATAW)
        nid.hWnd = self._hwnd or 0
        nid.uID = self.UID
        nid.uCallbackMessage = self.CALLBACK_MSG
        tray_icon = self._brand_tray or self._icon
        nid.hIcon = tray_icon
        nid.szTip = "DDtoolkit"
        nid.uFlags = self.NIF_MESSAGE | self.NIF_TIP | self.NIF_INFO
        if tray_icon:
            nid.uFlags |= self.NIF_ICON
        nid.szInfoTitle = (title or "")[: TITLE_LIMIT - 1]
        nid.szInfo = (body or "")[: BODY_LIMIT]
        nid.uTimeout = int(float(getattr(settings, "NOTIFY_BALLOON_LINGER_SECONDS", 8.0)) * 1000)
        balloon_icon = icon or self._brand_balloon
        if balloon_icon:
            # 气泡图标：优先**主播头像**（一次通知一个 HICON），没有则退回自家 App 图标
            nid.hBalloonIcon = balloon_icon
            nid.dwInfoFlags = self.NIIF_USER | self.NIIF_LARGE_ICON
        else:
            nid.dwInfoFlags = self.NIIF_INFO
        return nid

    def show(self, title: str, body: str, icon: int = 0) -> bool:
        """`icon` 给 HICON 时用它当气泡图标（主播头像），否则用 App 图标。"""
        if self._hwnd is None:
            return False
        nid = self._fill(title, body, icon)
        action = self.NIM_MODIFY if self._added else self.NIM_ADD
        if self._shell32.Shell_NotifyIconW(action, ctypes.byref(nid)):
            self._added = True
            return True
        # 图标可能已被 shell 丢掉（explorer 重启）：重挂一次再试
        if action == self.NIM_MODIFY:
            self._added = False
            if self._shell32.Shell_NotifyIconW(self.NIM_ADD, ctypes.byref(nid)):
                self._added = True
                return True
        logger.warning(f"Shell_NotifyIcon 失败（err={ctypes.get_last_error()}）")
        return False

    def hide(self) -> None:
        if self._hwnd is None or not self._added:
            return
        nid = self._fill("", "")
        self._shell32.Shell_NotifyIconW(self.NIM_DELETE, ctypes.byref(nid))
        self._added = False

    def close(self) -> None:
        self.hide()
        if self._hwnd is not None:
            self._user32.DestroyWindow(self._hwnd)
            self._hwnd = None
