# -*- coding: utf-8 -*-
"""自绘提示窗：品牌配色的无边框置顶小窗（R50，devlog/219）。

## 它和「通知区域气泡」的分工

| | 系统通知区域气泡（**已下线**，实现留在 `notifier._Balloon`） | 本模块的自绘窗 |
|---|---|---|
| 谁画 | **Windows**（配色/字体由系统主题决定，改不了） | **我们自己**（GDI 自绘，配色即品牌色） |
| 去哪 | 通知区域 → 操作中心留档、受"勿扰"管辖 | 只在屏幕上停几秒，不进历史 |
| 位置 | 固定在主显示器右下角 | **鼠标所在那块屏**的右下角（多显示器不再错过） |
| 交互 | 整条气泡可点 | 整张卡片可点（悬停变亮 + 手型光标），带"点击进入直播间"提示行 |

两者**同时展示**：气泡负责"留档 + 交给系统统一管理"，自绘窗负责"一定看得见、看得出是我们的"。

## 实现要点（都是坑）

- **必须同一个线程**：窗口消息得有人泵。本窗由 notifier 的投递线程创建，
  复用它已有的 `pump()`/`wait()`（`PeekMessageW(..., None, ...)` 是按线程取消息，
  所以同一个泵能把本窗的消息一起派发掉）。
- **不许抢焦点**：`WS_EX_NOACTIVATE` + `SW_SHOWNOACTIVATE` —— 否则弹一下就把用户
  正在打字的应用打断（通知最忌讳这个）。
- **不进任务栏**：`WS_EX_TOOLWINDOW`。
- **圆角靠逐像素 alpha**：整窗是一张 32bpp 预乘 ARGB 位图（GDI+ 抗锯齿绘制 →
  `UpdateLayeredWindow` 直贴屏幕）。老做法「窗口 Region + GDI `RoundRect`」是
  **1 位形状**，圆角只能整像素取舍、看着一圈毛刺（用户实测："角还是有点糊"）；
  现在圆弧的每个像素都有 0~255 的覆盖率，直边又落在像素边界上（干净）。
- **DPI**：按目标显示器 DPI 缩放全部尺寸与字号（`GetDpiForWindow`），
  150% 缩放下不能变成小字模式。
- **文字量两遍**：先 `DT_CALCRECT` 量高度（正文按宽度自动折行），再真正画。
"""

from __future__ import annotations

import ctypes
import logging
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Callable

from app.core.config import settings

logger = logging.getLogger(__name__)

IS_WINDOWS = sys.platform == "win32"

# ── 品牌配色（与 `frontend/src/styles/tokens.css` 同源）─────────────────
RGB_BG = (255, 162, 180)        # --c-primary: #ffa2b4（顶栏粉）
RGB_BG_HOVER = (255, 179, 194)  # 悬停提亮一档
RGB_BAR = (251, 119, 161)       # --c-primary-deep: #fb77a1（左侧强调条）
RGB_BORDER = (240, 140, 160)    # 1px 描边：浅色背景上也有边界
RGB_TITLE = (255, 255, 255)     # 白字（对 #ffa2b4 = 4.72:1，达 AA）
RGB_BODY = (255, 232, 236)      # 正文：白向底色混一点，层次低一档
RGB_HINT = (255, 255, 255)

FONT_FACE = "Microsoft YaHei UI"   # 中文 + 屏幕渲染清晰度都稳

# 96 DPI 基准尺寸（其余按 DPI 比例缩放）
# 96 DPI 基准宽度（DIP）：2026-09-26 用户把默认从 380 调到 450
BASE_WIDTH = 450
BASE_PAD = 16
BASE_RADIUS = 10
BASE_BAR_W = 4
BASE_TEXT_INSET = 12       # 文字相对内距再内缩（给左侧强调条让位）
BASE_TITLE_SIZE = 15
BASE_BODY_SIZE = 13        # 正文比标题小一档（2026-09-26：从 12 提到 13，缩放更看得出来）
BASE_HINT_SIZE = 12
BASE_ICON = 30            # 卡片左上角的自家图标（DIP）
BASE_ICON_GAP = 10        # 图标与标题之间的间距
BASE_GAP_TITLE = 6
BASE_GAP_HINT = 10
# 折叠：多张卡片同时来时不铺开，改成"叠一摞"——后面的卡片只露出顶边
STACK_OFFSET = 8           # 每一层向上错开的像素（DIP）
STACK_MAX = 10             # 一摞最多容纳 10 条（用户 2026-09-26 口径；再多的丢掉最旧的）
STACK_VISIBLE_EDGES = 4    # 画面上最多画 4 条"露头"边（10 层全画会高得离谱，其余用 ＋N 表示）
# 鼠标停在卡片上多少秒自动消除（用户 2026-09-26 口径：3 秒）
HOVER_DISMISS_SECONDS = 3.0


@dataclass(frozen=True)
class PopupLayout:
    """纯几何（可单测，不碰 Win32）：像素尺寸 + 各块矩形 + 圆角。"""

    width: int
    height: int
    radius: int
    pad: int
    bar: tuple[int, int, int, int]
    title: tuple[int, int, int, int]
    body: tuple[int, int, int, int]
    hint: tuple[int, int, int, int]
    has_hint: bool
    icon: tuple[int, int, int, int] | None = None


@dataclass(frozen=True)
class _Entry:
    """一摞里的一条通知（顶层显示它的文字/图标/链接，收走一层就露出下一条）。"""

    title: str
    body: str
    url: str | None
    hint: str
    icon: int = 0


def _scale(dpi: int) -> float:
    return max(1.0, dpi / 96.0)


def popup_scale() -> float:
    """**字号**缩放（`settings.NOTIFY_FONT_PCT`，默认 150 = 界面上的 150%）—— 只放大文字。

    图标与内距跟着它走（保持与文字的比例）；**卡片宽度不跟** —— 那是独立的
    「弹窗大小」设置（`popup_width_dip()`）。用户口径："弹窗大小和字号大小分开设置"。

    上限 3.0（= 界面上的 300%）：用户 2026-09-27 把范围从 200% 放到 300%，
    这里必须同步放宽 —— 否则界面允许 300%、绘制层却按 200% 画，
    表现为"拉到 250% 以上就没变化"（正是本仓最怕的那类静默不算数）。
    """
    try:
        value = float(getattr(settings, "NOTIFY_FONT_PCT", 150)) / 100.0
    except (TypeError, ValueError):
        value = 1.50
    return max(0.8, min(3.0, value))


def popup_width_dip() -> int:
    """**弹窗大小**：卡片宽度（DIP，300-620，默认 450，见 `NOTIFY_POPUP_WIDTH`）。与字号互不影响。"""
    try:
        value = int(getattr(settings, "NOTIFY_POPUP_WIDTH", BASE_WIDTH))
    except (TypeError, ValueError):
        value = BASE_WIDTH
    return max(300, min(620, value))


def width_px(dpi: int, width_dip: int | None = None) -> int:
    """卡片宽度（像素）：按 **DPI × 弹窗大小**，**不含**字号缩放。"""
    w = popup_width_dip() if width_dip is None else int(width_dip)
    return max(160, round(w * _scale(dpi)))


def _px(base_dip: float, dpi: int) -> int:
    """文字相关的 DIP → 像素：DPI × **字号缩放**（内距/图标/圆角都用它）。"""
    return max(1, round(base_dip * _scale(dpi) * popup_scale()))


def text_width(dpi: int, width_dip: int | None = None) -> int:
    """正文可用宽度（像素）—— 测量与排版共用它，避免两处算不一致。

    `width_dip=None` 表示用当前设置里的「弹窗大小」。
    """
    return width_px(dpi, width_dip) - 2 * _px(BASE_PAD, dpi) - _px(BASE_TEXT_INSET, dpi)


def compute_layout(dpi: int, *, title_h: int, body_h: int, hint_h: int,
                   width_dip: int | None = None, has_hint: bool = True,
                   icon_px: int = 0, stack: int = 1) -> PopupLayout:
    """按 DPI 缩放并排版；各块矩形为 `(left, top, right, bottom)`（像素）。

    `title_h/body_h/hint_h` 由 GDI 实测（`DrawTextW + DT_CALCRECT`）传入 ——
    中文折行与字号差异都自动对得上，不用猜行高。

    `icon_px > 0` 时在标题左侧排自家图标（标题与图标垂直居中对齐）——
    这是"一眼看得出是 DDToolkit"的关键一笔。

    `width_dip=None` = 用设置里的「弹窗大小」（`popup_width_dip()`）。

    `stack>1` = **折叠显示**：后面 `stack-1` 张卡片只露出顶边（每层向上错开
    `STACK_OFFSET`），所以窗口要高一点、主卡片整体下移 (stack-1)×offset。
    """
    pad = _px(BASE_PAD, dpi)
    radius = _px(BASE_RADIUS, dpi)
    bar_w = max(2, _px(BASE_BAR_W, dpi))
    gap_title = _px(BASE_GAP_TITLE, dpi)
    gap_hint = _px(BASE_GAP_HINT, dpi)
    width = width_px(dpi, width_dip)     # 宽度只跟「弹窗大小」，不跟字号
    text_left = pad + _px(BASE_TEXT_INSET, dpi)
    text_right = width - pad

    top = pad
    icon: tuple[int, int, int, int] | None = None
    title_left = text_left
    row_h = title_h
    if icon_px > 0:
        row_h = max(title_h, icon_px)
        icon_top = top + (row_h - icon_px) // 2
        icon = (text_left, icon_top, text_left + icon_px, icon_top + icon_px)
        title_left = text_left + icon_px + _px(BASE_ICON_GAP, dpi)
    title_top = top + (row_h - title_h) // 2
    title = (title_left, title_top, text_right, title_top + title_h)
    top = top + row_h + gap_title
    body = (text_left, top, text_right, top + body_h)
    top = body[3]
    if has_hint:
        top += gap_hint
        hint = (text_left, top, text_right, top + hint_h)
    else:
        hint = (text_left, top, text_right, top)
    height = (hint[3] if has_hint else body[3]) + pad
    bar = (pad, pad, pad + bar_w, max(pad + 1, height - pad))
    # 折叠：整体下移，给后面几层的"露头"留位置
    depth = max(1, min(STACK_MAX, int(stack))) - 1
    if depth:
        shift = depth * _px(STACK_OFFSET, dpi)
        def _shift(r: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
            return (r[0], r[1] + shift, r[2], r[3] + shift)

        bar, title, body, hint = _shift(bar), _shift(title), _shift(body), _shift(hint)
        if icon is not None:
            icon = _shift(icon)
        height += shift

    return PopupLayout(width=width, height=height, radius=radius, pad=pad, bar=bar,
                       title=title, body=body, hint=hint, has_hint=has_hint, icon=icon)


def app_icon_path() -> "Path | None":
    """自家图标（`icon.ico`）位置；找不到返回 None（气泡/卡片退回无图标）。

    三级查找：**打包态 `_MEIPASS`**（PyInstaller onedir 的 `_internal/`，由
    `scripts/build_backend.py` 的 `--add-data` 放进去）→ exe 同级 → 仓库里那份。
    气泡（`notifier`）与本模块共用，避免两处各写一套路径逻辑。
    """
    from pathlib import Path

    candidates: list[Path] = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "icon.ico")
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).parent / "icon.ico")
    candidates.append(Path(__file__).resolve().parents[2]
                      / "frontend" / "src-tauri" / "icons" / "icon.ico")
    for path in candidates:
        if path.exists():
            return path
    return None


def load_icon_file(path: "Path | None", size: int) -> int:
    """从 .ico 按**指定尺寸**加载图标（返回 HICON，失败 0）。

    ⚠️ 关键是"按用途给对的尺寸"：拿 32×32 去当 16×16 的托盘图标、或反过来放大，都会糊
    （用户实测反馈"图标分辨率有点低"）。`icon.ico` 备了 16/20/24/28/32/40/48/64/96/128/256
    共 11 档，请求哪一档就能匹配到哪一档。
    """
    if path is None:
        return 0
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.LoadImageW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint,
                                      ctypes.c_int, ctypes.c_int, ctypes.c_uint]
        user32.LoadImageW.restype = ctypes.c_void_p
        # IMAGE_ICON=1 / LR_LOADFROMFILE=0x10
        return int(user32.LoadImageW(None, str(path), 1, int(size), int(size), 0x10) or 0)
    except Exception as e:      # pragma: no cover - 极端环境
        logger.warning(f"图标加载失败（{size}px）: {type(e).__name__}: {e}")
        return 0


# ── 头像（图片文件 → HICON）────────────────────────────────────────────
# 主播头像是 jpg/png 这类**位图**，`LoadImageW` 只认 .ico/.bmp，所以要走 GDI+。
# 进程内只需启动一次 GDI+；失败就退回 App 图标（通知不能因为头像加载不了而不弹）。

PIXEL_FORMAT_32BPP_ARGB = 0x0026200A
INTERPOLATION_HIGH_QUALITY_BICUBIC = 7

_gdiplus_lock = threading.Lock()
_gdiplus_lib = None

_dpi_lock = threading.Lock()
_dpi_aware: bool | None = None


def ensure_dpi_awareness() -> bool:
    """把本进程设为 **Per-Monitor DPI 感知**（幂等，best-effort）。

    **为什么必须**：DPI 不感知的进程，在高分屏（如 150%）上由 Windows 把窗口**按 96 DPI
    渲染后整幅拉伸** —— 圆角、文字、图标全部发糊（用户实测："最底层弹窗的角像素有点糊"）。
    实测：本项目后端进程 `GetProcessDpiAwareness() = 0`（unaware）、`GetDpiForSystem() = 96`，
    而 PyInstaller 打出来的 exe 清单里也没有 dpiAware 声明。

    必须在**创建任何窗口之前**调用（Windows 的硬性要求），所以 `open()` 的第一步就调它。

    ⚠️ 进程已经感知时，`SetProcessDpiAwarenessContext` 会**返回失败**（ERROR_ACCESS_DENIED）——
      `backend_main._enable_dpi_awareness()` 先设过一次，这里再设就"失败"了。所以失败后要
      **回查当前状态**：能读到"已经感知"就当作成功，别在日志里留下误导性的"设置失败"
      （实测踩过：日志里一条 `DPI 感知设置失败（高分屏下可能发糊）`，其实早就设好了）。
    """
    global _dpi_aware
    with _dpi_lock:
        if _dpi_aware is not None:
            return _dpi_aware
        if not IS_WINDOWS:
            _dpi_aware = False
            return False
        ok = False
        try:
            # -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2（Win10 1703+）
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
            user32.SetProcessDpiAwarenessContext.restype = ctypes.c_int
            ok = bool(user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4 & 0xFFFFFFFFFFFFFFFF)))
        except Exception:
            ok = False
        if not ok:
            try:  # 老系统兜底：PROCESS_PER_MONITOR_DPI_AWARE = 2
                ok = ctypes.WinDLL("shcore").SetProcessDpiAwareness(2) == 0
            except Exception:
                ok = False
        if not ok:
            ok = _current_awareness() > 0     # 已经设过（例如 backend_main 先设了）
        _dpi_aware = ok
        logger.info(f"DPI 感知设置{'成功（卡片按真实 DPI 渲染，高分屏不再被拉伸）' if ok else '失败（高分屏下可能发糊）'}")
        return ok


def _current_awareness() -> int:
    """当前进程的 DPI 感知级别（0=unaware / 1=system / 2=per-monitor）；查不到返回 -1。"""
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        ctx = user32.GetThreadDpiAwarenessContext()
        user32.GetAwarenessFromDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        user32.GetAwarenessFromDpiAwarenessContext.restype = ctypes.c_int
        return int(user32.GetAwarenessFromDpiAwarenessContext(ctx))
    except Exception:
        pass
    try:      # Windows 8.1 之前的垫片；现在基本走不到
        value = ctypes.c_int()
        ctypes.WinDLL("shcore").GetProcessDpiAwareness(None, ctypes.byref(value))
        return int(value.value)
    except Exception:
        return -1


class _GdiplusStartupInput(ctypes.Structure):
    _fields_ = [("GdiplusVersion", ctypes.c_uint32),
                ("DebugEventCallback", ctypes.c_void_p),
                ("SuppressBackgroundThread", ctypes.c_int),
                ("SuppressExternalCodecs", ctypes.c_int)]


class _RectF(ctypes.Structure):
    """GDI+ 的 `RectF`（成员是 REAL = float）。"""

    _fields_ = [("X", ctypes.c_float), ("Y", ctypes.c_float),
                ("Width", ctypes.c_float), ("Height", ctypes.c_float)]


# GDI+ 常量
PIXEL_FORMAT_32BPP_PARGB = 0x000E200B     # 预乘 ARGB：`UpdateLayeredWindow` 要的格式
SMOOTHING_ANTIALIAS = 4
TEXT_HINT_ANTIALIAS_GRIDFIT = 3
FILL_MODE_ALTERNATE = 0
UNIT_PIXEL = 2
COMBINE_REPLACE = 0
STRING_ALIGN_NEAR, STRING_ALIGN_FAR = 0, 2
STRING_FLAG_NO_WRAP = 0x00001000
STRING_FLAG_LINE_LIMIT = 0x00002000
STRING_TRIMMING_ELLIPSIS_CHARACTER = 3
FONT_STYLE_REGULAR, FONT_STYLE_BOLD = 0, 1

# 字体粗细（GDI 的 lfWeight 与 GDI+ 的 style 共用一套口径）
FONT_WEIGHT_NORMAL = 400
FONT_WEIGHT_SEMIBOLD = 600

# 分层窗口（`UpdateLayeredWindow`）
ULW_ALPHA = 0x02
AC_SRC_OVER, AC_SRC_ALPHA = 0, 1
BI_RGB = 0
DIB_RGB_COLORS = 0

# 渲染管线只记一次日志（每次通知都记会把日志刷满；但"到底走的哪条路"是排查第一问）
_logged_pipeline = False


class _BitmapInfoHeader(ctypes.Structure):
    """`BITMAPINFOHEADER`（建 32 位 DIB 用；负高度 = 自上向下的行序，GDI+ 要的）。"""

    _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
                ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
                ("biClrImportant", ctypes.c_uint32)]


class _BlendFunction(ctypes.Structure):
    """`BLENDFUNCTION`（4 个字节，必须 pack=1）。

    ⚠️ `SourceConstantAlpha` 是**无符号**字节：用 `c_byte` 的话 >127 会变成负数
    （默认不透明度 232 正好中招），合成出来会直接全透明。
    """

    _pack_ = 1
    _fields_ = [("BlendOp", ctypes.c_ubyte), ("BlendFlags", ctypes.c_ubyte),
                ("SourceConstantAlpha", ctypes.c_ubyte), ("AlphaFormat", ctypes.c_ubyte)]


def _argb(color: tuple[int, int, int], alpha: int = 255) -> int:
    """(r,g,b[,a]) → GDI+ 的 ARGB 整数（0xAARRGGBB）。"""
    r, g, b = color
    return (max(0, min(255, alpha)) << 24) | (r << 16) | (g << 8) | b


# GDI+ 的整数坐标落在**像素中心**（GDI 是像素左上角）。要让一幅画布正好盖住
# 第 0..w-1 列像素，整条路径得整体挪 -0.5px；不挪的话四周会留一圈 **50% 半透边**
# （实测：整行 alpha=0x80），看着就是"边缘发糊"——用户口径"角还是有点糊"里的一半。
GP_HALF_PIXEL = 0.5


def _rounded_path(gfx, x: float, y: float, w: float, h: float, r: float) -> int:
    """给 Graphics 建一条圆角矩形路径（四个 `AddPathArc` 拼起来）。返回 GpPath。

    入参是**像素格坐标**（0 = 第 0 个像素的左/上边），内部按 GDI+ 的像素中心
    口径挪 `GP_HALF_PIXEL`，所以直边落在像素边界上（干脆），圆弧仍然是抗锯齿的（平滑）。
    """
    lib = _gdiplus()
    path = ctypes.c_void_p()
    if lib.GdipCreatePath(FILL_MODE_ALTERNATE, ctypes.byref(path)) != 0:
        return 0
    x, y = x - GP_HALF_PIXEL, y - GP_HALF_PIXEL
    d = r * 2.0
    # 左上 → 右上 → 右下 → 左下（角度制，0° 在 3 点钟方向，顺时针为正）
    lib.GdipAddPathArc(path, x, y, d, d, 180.0, 90.0)
    lib.GdipAddPathArc(path, x + w - d, y, d, d, 270.0, 90.0)
    lib.GdipAddPathArc(path, x + w - d, y + h - d, d, d, 0.0, 90.0)
    lib.GdipAddPathArc(path, x, y + h - d, d, d, 90.0, 90.0)
    lib.GdipClosePathFigure(path)
    return int(path.value or 0)


def _fill_round_rect(gfx, x: float, y: float, w: float, h: float, r: float,
                     argb: int) -> None:
    """用纯色填充一个圆角矩形（**抗锯齿**：圆角处写进 alpha 的是覆盖率，不是 0/1）。

    这是"角不糊"的关键一笔 —— GDI 的 `RoundRect` 与窗口 Region 都只有整像素取舍。
    """
    lib = _gdiplus()
    if not lib:
        return
    w = max(1.0, float(w))
    h = max(1.0, float(h))
    r = max(0.0, min(float(r), w / 2.0, h / 2.0))
    path = _rounded_path(gfx, x, y, w, h, r)
    if not path:
        return
    brush = ctypes.c_void_p()
    try:
        if lib.GdipCreateSolidFill(ctypes.c_uint(argb), ctypes.byref(brush)) != 0:
            return
        lib.GdipFillPath(gfx, ctypes.c_void_p(brush.value), ctypes.c_void_p(path))
    finally:
        if brush:
            lib.GdipDeleteBrush(ctypes.c_void_p(brush.value))
        lib.GdipDeletePath(ctypes.c_void_p(path))


def _gdiplus():
    """懒启动 GDI+（线程安全；失败返回 None）。"""
    global _gdiplus_lib
    with _gdiplus_lock:
        if _gdiplus_lib is not None:
            return _gdiplus_lib
        try:
            lib = ctypes.WinDLL("gdiplus", use_last_error=True)
            lib.GdiplusStartup.argtypes = [ctypes.POINTER(ctypes.c_void_p),
                                           ctypes.POINTER(_GdiplusStartupInput),
                                           ctypes.c_void_p]
            lib.GdiplusStartup.restype = ctypes.c_int
            token = ctypes.c_void_p()
            if lib.GdiplusStartup(ctypes.byref(token), ctypes.byref(_GdiplusStartupInput(1)),
                                  None) != 0:
                logger.warning("GDI+ 启动失败（头像不可用，退回 App 图标）")
                return None
            lib.GdipCreateBitmapFromFile.argtypes = [ctypes.c_wchar_p,
                                                     ctypes.POINTER(ctypes.c_void_p)]
            lib.GdipCreateBitmapFromHICON.argtypes = [ctypes.c_void_p,
                                                      ctypes.POINTER(ctypes.c_void_p)]
            lib.GdipCreateBitmapFromScan0.argtypes = [ctypes.c_int, ctypes.c_int,
                                                      ctypes.c_int, ctypes.c_int,
                                                      ctypes.c_void_p,
                                                      ctypes.POINTER(ctypes.c_void_p)]
            lib.GdipCreateFromHDC.argtypes = [ctypes.c_void_p,
                                              ctypes.POINTER(ctypes.c_void_p)]
            lib.GdipGetImageGraphicsContext.argtypes = [ctypes.c_void_p,
                                                        ctypes.POINTER(ctypes.c_void_p)]
            lib.GdipSetInterpolationMode.argtypes = [ctypes.c_void_p, ctypes.c_int]
            lib.GdipDrawImageRectI.argtypes = [ctypes.c_void_p, ctypes.c_void_p] + [ctypes.c_int] * 4
            lib.GdipDrawImageRect.argtypes = [ctypes.c_void_p, ctypes.c_void_p] + [ctypes.c_float] * 4
            lib.GdipBitmapGetPixel.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                               ctypes.c_int, ctypes.POINTER(ctypes.c_uint)]
            lib.GdipCreateHICONFromBitmap.argtypes = [ctypes.c_void_p,
                                                      ctypes.POINTER(ctypes.c_void_p)]
            lib.GdipDisposeImage.argtypes = [ctypes.c_void_p]
            lib.GdipDeleteGraphics.argtypes = [ctypes.c_void_p]
            # ── 抗锯齿渲染所需（devlog/219：逐像素 alpha 管线）──
            lib.GdipGraphicsClear.argtypes = [ctypes.c_void_p, ctypes.c_uint]
            lib.GdipSetSmoothingMode.argtypes = [ctypes.c_void_p, ctypes.c_int]
            lib.GdipSetTextRenderingHint.argtypes = [ctypes.c_void_p, ctypes.c_int]
            lib.GdipCreateSolidFill.argtypes = [ctypes.c_uint,
                                                ctypes.POINTER(ctypes.c_void_p)]
            lib.GdipCreatePath.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
            lib.GdipAddPathArc.argtypes = [ctypes.c_void_p] + [ctypes.c_float] * 6
            lib.GdipClosePathFigure.argtypes = [ctypes.c_void_p]
            lib.GdipFillPath.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
            lib.GdipDrawPath.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
            lib.GdipCreatePen1.argtypes = [ctypes.c_uint, ctypes.c_float, ctypes.c_int,
                                           ctypes.POINTER(ctypes.c_void_p)]
            lib.GdipSetClipPath.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
            lib.GdipResetClip.argtypes = [ctypes.c_void_p]
            lib.GdipDeletePath.argtypes = [ctypes.c_void_p]
            lib.GdipDeleteBrush.argtypes = [ctypes.c_void_p]
            lib.GdipCreateFontFamilyFromName.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p,
                                                         ctypes.POINTER(ctypes.c_void_p)]
            lib.GdipCreateFont.argtypes = [ctypes.c_void_p, ctypes.c_float, ctypes.c_int,
                                           ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
            lib.GdipDeleteFont.argtypes = [ctypes.c_void_p]
            lib.GdipDeleteFontFamily.argtypes = [ctypes.c_void_p]
            lib.GdipCreateStringFormat.argtypes = [ctypes.c_int, ctypes.c_ushort,
                                                   ctypes.POINTER(ctypes.c_void_p)]
            lib.GdipSetStringFormatAlign.argtypes = [ctypes.c_void_p, ctypes.c_int]
            lib.GdipSetStringFormatFlags.argtypes = [ctypes.c_void_p, ctypes.c_int]
            lib.GdipSetStringFormatTrimming.argtypes = [ctypes.c_void_p, ctypes.c_int]
            lib.GdipDeleteStringFormat.argtypes = [ctypes.c_void_p]
            lib.GdipMeasureString.argtypes = [
                ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int, ctypes.c_void_p,
                ctypes.POINTER(_RectF), ctypes.c_void_p, ctypes.POINTER(_RectF),
                ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
            lib.GdipDrawString.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int,
                                           ctypes.c_void_p, ctypes.POINTER(_RectF),
                                           ctypes.c_void_p, ctypes.c_void_p]
            for fn in ("GdipCreateBitmapFromFile", "GdipCreateBitmapFromHICON",
                       "GdipCreateBitmapFromScan0", "GdipCreateFromHDC",
                       "GdipGetImageGraphicsContext", "GdipSetInterpolationMode",
                       "GdipDrawImageRectI", "GdipDrawImageRect", "GdipBitmapGetPixel",
                       "GdipCreateHICONFromBitmap",
                       "GdipDisposeImage", "GdipDeleteGraphics", "GdipGraphicsClear",
                       "GdipSetSmoothingMode", "GdipSetTextRenderingHint",
                       "GdipCreateSolidFill", "GdipCreatePath", "GdipAddPathArc",
                       "GdipClosePathFigure", "GdipFillPath", "GdipDrawPath",
                       "GdipCreatePen1", "GdipSetClipPath", "GdipResetClip",
                       "GdipDeletePath", "GdipDeleteBrush",
                       "GdipCreateFontFamilyFromName", "GdipCreateFont",
                       "GdipDeleteFont", "GdipDeleteFontFamily",
                       "GdipCreateStringFormat", "GdipSetStringFormatAlign",
                       "GdipSetStringFormatFlags", "GdipSetStringFormatTrimming",
                       "GdipDeleteStringFormat",
                       "GdipMeasureString", "GdipDrawString"):
                getattr(lib, fn).restype = ctypes.c_int
            _gdiplus_lib = lib
            return lib
        except Exception as e:      # pragma: no cover - 极端环境
            logger.warning(f"GDI+ 不可用（头像退回 App 图标）: {type(e).__name__}: {e}")
            return None


def image_file_to_hicon(path: "Path | str | None", size: int) -> int:
    """把本地图片（头像 jpg/png/gif…）缩放成 `size×size` 并转成 HICON；失败返回 0。

    路线：GDI+ 读原图 → 建一张 **32bppARGB** 目标位图（`GdipCreateHICONFromBitmap`
    只吃这个格式）→ 高质量插值绘制 → 转 HICON。这样头像在任意 DPI 下都是清晰的，
    不会出现"拿 64px 缩到 32px"那种糊。
    """
    if not path:
        return 0
    try:
        from pathlib import Path as _Path

        p = _Path(path)
        if not p.exists():
            return 0
        lib = _gdiplus()
        if lib is None:
            return 0
        size = max(8, int(size))
        src = ctypes.c_void_p()
        if lib.GdipCreateBitmapFromFile(str(p), ctypes.byref(src)) != 0 or not src:
            logger.info(f"头像读取失败（可能是不支持的格式）: {p.name}")
            return 0
        dst = ctypes.c_void_p()
        gfx = ctypes.c_void_p()
        hicon = ctypes.c_void_p()
        try:
            if lib.GdipCreateBitmapFromScan0(size, size, 0, PIXEL_FORMAT_32BPP_ARGB,
                                             None, ctypes.byref(dst)) != 0:
                return 0
            if lib.GdipGetImageGraphicsContext(dst, ctypes.byref(gfx)) != 0:
                return 0
            lib.GdipSetInterpolationMode(gfx, INTERPOLATION_HIGH_QUALITY_BICUBIC)
            lib.GdipDrawImageRectI(gfx, src, 0, 0, size, size)
            lib.GdipDeleteGraphics(gfx)      # 画完立刻还，免得 finally 再删一次
            gfx = ctypes.c_void_p()
            if lib.GdipCreateHICONFromBitmap(dst, ctypes.byref(hicon)) != 0:
                return 0
            return int(hicon.value or 0)
        finally:
            if gfx:
                lib.GdipDeleteGraphics(gfx)
            if dst:
                lib.GdipDisposeImage(dst)
            lib.GdipDisposeImage(src)
    except Exception as e:      # pragma: no cover - 极端环境
        logger.warning(f"头像转图标失败（{size}px）: {type(e).__name__}: {e}")
        return 0


def destroy_icon(hicon: int) -> None:
    """释放 `image_file_to_hicon` / `load_icon_file` 建出来的图标。"""
    if not hicon:
        return
    try:
        ctypes.WinDLL("user32").DestroyIcon(ctypes.c_void_p(hicon))
    except Exception:           # pragma: no cover - 极端环境
        pass


# ── 逐像素 alpha 渲染（devlog/219：抗锯齿圆角）────────────────────────────


class CardPainter:
    """把"一摞卡片"画到任意 GDI+ Graphics 上（**抗锯齿 + 逐像素 alpha**）。

    ## 为什么需要它

    老实现是「窗口 Region 裁圆角 + GDI `RoundRect` 填充」：窗口区域（`SetWindowRgn`）
    本质是**1 位掩码**（在/不在，没有中间态），`RoundRect` 也不抗锯齿。于是圆弧只能
    按整像素取舍，弧线看着就是一圈毛刺（用户口径："角还是有点糊"）。

    现在整窗是一张 32bpp **预乘 ARGB** 位图（由 `UpdateLayeredWindow` 直贴屏幕），
    圆角弧线由 GDI+ 抗锯齿**直接画进 alpha 通道** —— 每个像素都有 0~255 的覆盖率，
    视觉上就是平滑的弧。文字同理（灰度抗锯齿画进 alpha，不再有 ClearType 彩边）。

    窗口绘制（`PopupWindow._present_layered`）与离屏取证/单测走的是**同一段代码**，
    所以"看到的"就是"测到的"。
    """

    def __init__(self) -> None:
        self._fonts: dict[tuple[int, int], int] = {}
        self._formats: dict[tuple[int, bool], int] = {}
        self._family = 0
        self._measure_gfx = 0
        self._em_scale = 0.0

    # ── 句柄缓存（GDI+ 对象都要手动释放，缓存起来别每次重建）──
    def _font_family(self) -> int:
        if self._family:
            return self._family
        lib = _gdiplus()
        if not lib:
            return 0
        fam = ctypes.c_void_p()
        if lib.GdipCreateFontFamilyFromName(FONT_FACE, None, ctypes.byref(fam)) != 0:
            logger.warning(f"GDI+ 找不到字体 {FONT_FACE}（提示窗文字可能退化）")
            return 0
        self._family = int(fam.value or 0)
        return self._family

    def font(self, role: str, size_dip: float, weight: int, dpi: int) -> int:
        """按**实际像素字高**缓存 GDI+ 字体（`unit=pixel`，emSize 就是像素）。

        `role` 只为了和 GDI 那套 `PopupWindow._font(role, size_dip, weight)` 保持同一签名；
        缓存键是"像素字高 + 粗细"，两者都进键 —— 用户改「字号」必须重建字体。

        ⚠️ GDI+ 的 `emSize` 与 GDI `CreateFontW(lfHeight)` 的口径**不一样**：GDI 的
        lfHeight 是**行高**（含行距），emSize 是**字身**。雅黑的行高 ≈ 1.4 字身，
        所以直接把像素高度当 emSize 会让文字整体胖一圈（用户按 120% 调好的观感就变了）。
        这里用 `_em_ratio()` 现场量出这个比值再折算。
        """
        lib = _gdiplus()
        if not lib:
            return 0
        px = max(6, round(_px(size_dip, dpi) * self._em_ratio()))
        key = (px, int(weight))
        handle = self._fonts.get(key)
        if handle:
            return handle
        family = self._font_family()
        if not family:
            return 0
        style = FONT_STYLE_BOLD if weight >= FONT_WEIGHT_SEMIBOLD else FONT_STYLE_REGULAR
        font = ctypes.c_void_p()
        if lib.GdipCreateFont(ctypes.c_void_p(family), ctypes.c_float(px), style,
                              UNIT_PIXEL, ctypes.byref(font)) != 0:
            return 0
        self._fonts[key] = int(font.value or 0)
        return self._fonts[key]

    def _em_ratio(self) -> float:
        """GDI 的"字符高度" → GDI+ `emSize` 的折算系数（现场量，别写死 0.7 之类的魔数）。"""
        if self._em_scale:
            return self._em_scale
        lib = _gdiplus()
        gfx = self._graphics_for_measure()
        family = self._font_family()
        if not lib or not gfx or not family:
            self._em_scale = 1.0
            return self._em_scale
        probe = ctypes.c_void_p()
        try:
            if lib.GdipCreateFont(ctypes.c_void_p(family), ctypes.c_float(100.0),
                                  FONT_STYLE_REGULAR, UNIT_PIXEL,
                                  ctypes.byref(probe)) != 0 or not probe:
                self._em_scale = 1.0
                return self._em_scale
            fmt = self.format(align=STRING_ALIGN_NEAR, wrap=False)
            box = _RectF(0.0, 0.0, 4000.0, 4096.0)
            out = _RectF()
            if lib.GdipMeasureString(ctypes.c_void_p(gfx), "中文Aa", -1,
                                     ctypes.c_void_p(probe.value), ctypes.byref(box),
                                     ctypes.c_void_p(fmt), ctypes.byref(out),
                                     None, None) != 0 or out.Height <= 0:
                self._em_scale = 1.0
            else:
                self._em_scale = 100.0 / float(out.Height)
        finally:
            if probe:
                lib.GdipDeleteFont(ctypes.c_void_p(probe.value))
        return self._em_scale

    def format(self, *, align: int, wrap: bool, ellipsis: bool = False) -> int:
        """字符串格式（左/右对齐 + 是否自动折行 + 单行超长省略号）。"""
        lib = _gdiplus()
        if not lib:
            return 0
        key = (int(align), bool(wrap))
        handle = self._formats.get(key)
        if handle:
            return handle
        fmt = ctypes.c_void_p()
        if lib.GdipCreateStringFormat(0, 0, ctypes.byref(fmt)) != 0:
            return 0
        lib.GdipSetStringFormatAlign(fmt, int(align))
        if not wrap:
            lib.GdipSetStringFormatFlags(fmt, STRING_FLAG_NO_WRAP)
        if ellipsis:
            lib.GdipSetStringFormatTrimming(fmt, STRING_TRIMMING_ELLIPSIS_CHARACTER)
        self._formats[key] = int(fmt.value or 0)
        return self._formats[key]

    def _graphics_for_measure(self) -> int:
        """量文字需要一个 Graphics（挂在屏幕 DC 上就够，不落盘、不建窗）。"""
        if self._measure_gfx:
            return self._measure_gfx
        lib = _gdiplus()
        if not lib:
            return 0
        from ctypes import wintypes

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.GetDC.argtypes = [wintypes.HWND]
        user32.GetDC.restype = wintypes.HDC
        user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
        hdc = user32.GetDC(None)
        gfx = ctypes.c_void_p()
        try:
            if lib.GdipCreateFromHDC(ctypes.c_void_p(hdc), ctypes.byref(gfx)) != 0:
                return 0
        finally:
            user32.ReleaseDC(None, hdc)
        lib.GdipSetTextRenderingHint(gfx, TEXT_HINT_ANTIALIAS_GRIDFIT)
        self._measure_gfx = int(gfx.value or 0)
        return self._measure_gfx

    def measure(self, text: str, size_dip: float, weight: int, width: int, *,
                wrap: bool, dpi: int) -> int:
        """量一段文字在给定宽度下需要多高（**与 `DrawString` 同一个引擎**）。

        两处用不同引擎（GDI 量、GDI+ 画）会错行：量出来 3 行、画上去 4 行，
        最后一行就被卡片下沿切掉。所以量、画都走 GDI+。
        """
        fallback = max(1, _px(size_dip * 1.35, dpi))
        if not text:
            return fallback
        lib = _gdiplus()
        gfx = self._graphics_for_measure()
        font = self.font("", size_dip, weight, dpi)
        if not lib or not gfx or not font:
            return fallback
        fmt = self.format(align=STRING_ALIGN_NEAR, wrap=wrap, ellipsis=not wrap)
        box = _RectF(0.0, 0.0, float(max(1, int(width))), 4096.0)
        box_out = _RectF()
        status = lib.GdipMeasureString(
            ctypes.c_void_p(gfx), text, -1, ctypes.c_void_p(font), ctypes.byref(box),
            ctypes.c_void_p(fmt), ctypes.byref(box_out), None, None)
        if status != 0 or box_out.Height <= 0:
            return fallback
        return max(1, int(box_out.Height + 0.9999))

    # ── 绘制 ──
    def paint(self, gfx, rects: "PopupLayout", *, dpi: int, texts: dict,
              avatar: int = 0, hover: bool = False, behind: int = 0,
              text_color: "tuple[int, int, int] | None" = None) -> None:
        """把整摞卡片画进 `gfx`（画布须是 32bpp 预乘 ARGB，且已 Clear 过）。"""
        lib = _gdiplus()
        if not lib or not gfx:
            return
        lib.GdipSetSmoothingMode(gfx, SMOOTHING_ANTIALIAS)
        lib.GdipSetTextRenderingHint(gfx, TEXT_HINT_ANTIALIAS_GRIDFIT)
        lib.GdipSetInterpolationMode(gfx, INTERPOLATION_HIGH_QUALITY_BICUBIC)

        bg = RGB_BG_HOVER if hover else RGB_BG
        depth = min(max(0, int(behind)), STACK_VISIBLE_EDGES)   # 画面上最多画 4 条露头边
        layer_h = _px(STACK_OFFSET, dpi)
        shift = depth * layer_h                      # 主卡片整体下移（给露头留位置）
        card_h = max(1, rects.height - shift)

        # 后面几层：逐层向上错开，只露一条顶边（从最远的一层先画，近的盖上去）
        for i in range(depth, 0, -1):
            top = shift - i * layer_h
            # 越靠后越接近品牌深粉（别混黑：混黑会发灰，和粉色卡片不搭）
            layer_bg = _mix(bg, RGB_BAR, 0.30 + 0.20 * (depth - i))
            _fill_round_rect(gfx, 0.0, float(top), float(rects.width), float(card_h),
                             float(rects.radius), _argb(layer_bg))
        _fill_round_rect(gfx, 0.0, float(shift), float(rects.width), float(card_h),
                         float(rects.radius), _argb(bg))

        # 左侧强调条：圆头细条（和圆角卡片一个调子）
        bar_left, bar_top, bar_right, bar_bottom = rects.bar
        _fill_round_rect(gfx, float(bar_left), float(bar_top),
                         float(bar_right - bar_left), float(bar_bottom - bar_top),
                         (bar_right - bar_left) / 2.0, _argb(RGB_BAR))

        avatar_icon = int(avatar or 0)
        if rects.icon and avatar_icon:
            self._draw_avatar(gfx, avatar_icon, rects.icon)

        fg = text_color or popup_text_color()
        body_fg = _mix(fg, bg, 0.15)                # 正文：向底色混一点，层次低一档
        title_rect = rects.title
        if behind:
            # 右上角 ＋N：告诉用户"还叠着几张"（点/悬停只收最顶上一层）
            badge_w = _px(60, dpi)
            badge = (title_rect[2] - badge_w, title_rect[1],
                     title_rect[2], title_rect[1] + _px(16, dpi))
            self._draw_text(gfx, f"＋{behind}",
                            self.font("hint", BASE_HINT_SIZE, FONT_WEIGHT_SEMIBOLD, dpi),
                            badge, fg, wrap=False, right=True)
            title_rect = (title_rect[0], title_rect[1],
                          max(title_rect[0], title_rect[2] - badge_w), title_rect[3])
        self._draw_text(gfx, texts.get("title", ""),
                        self.font("title", BASE_TITLE_SIZE, FONT_WEIGHT_SEMIBOLD, dpi),
                        title_rect, fg, wrap=False)
        self._draw_text(gfx, texts.get("body", ""),
                        self.font("body", BASE_BODY_SIZE, FONT_WEIGHT_NORMAL, dpi),
                        rects.body, body_fg, wrap=True)
        if rects.has_hint:
            self._draw_text(gfx, texts.get("hint", ""),
                            self.font("hint", BASE_HINT_SIZE, FONT_WEIGHT_SEMIBOLD, dpi),
                            rects.hint, fg, wrap=False, right=True)

    def _draw_text(self, gfx, text: str, font: int, rect: tuple, color,
                   *, wrap: bool, right: bool = False) -> None:
        if not text or not font:
            return
        lib = _gdiplus()
        fmt = self.format(align=STRING_ALIGN_FAR if right else STRING_ALIGN_NEAR,
                          wrap=wrap, ellipsis=not wrap)
        brush = ctypes.c_void_p()
        if lib.GdipCreateSolidFill(ctypes.c_uint(_argb(color)), ctypes.byref(brush)) != 0:
            return
        try:
            # 底部留 4px 余量：GDI+ 的 bound box 不含降部描边，贴着量出来的高度画会切掉尾巴
            box = _RectF(float(rect[0]), float(rect[1]),
                         float(max(1, rect[2] - rect[0])),
                         float(max(1, rect[3] - rect[1]) + 4))
            lib.GdipDrawString(gfx, text, -1, ctypes.c_void_p(font), ctypes.byref(box),
                               ctypes.c_void_p(fmt), ctypes.c_void_p(brush.value))
        finally:
            lib.GdipDeleteBrush(ctypes.c_void_p(brush.value))

    def _draw_avatar(self, gfx, hicon: int, rect: tuple) -> None:
        """头像：高质量缩放 + 圆角裁剪（裁剪路径也吃抗锯齿 → 头像角同样平滑）。"""
        lib = _gdiplus()
        bmp = ctypes.c_void_p()
        if lib.GdipCreateBitmapFromHICON(ctypes.c_void_p(hicon),
                                         ctypes.byref(bmp)) != 0 or not bmp:
            return
        left, top, right, bottom = rect
        size = float(max(1, min(right - left, bottom - top)))
        path = _rounded_path(gfx, float(left), float(top), size, size, size * 0.30)
        try:
            if path:
                lib.GdipSetClipPath(gfx, ctypes.c_void_p(path), COMBINE_REPLACE)
            # 用**浮点**重载，跟裁剪路径同一套像素中心口径 —— 整数重载会和裁剪差半像素，
            # 表现是头像左/上边被切掉一半、右/下边露出一线。
            lib.GdipDrawImageRect(gfx, bmp,
                                  ctypes.c_float(left - GP_HALF_PIXEL),
                                  ctypes.c_float(top - GP_HALF_PIXEL),
                                  ctypes.c_float(right - left), ctypes.c_float(bottom - top))
        finally:
            if path:
                lib.GdipResetClip(gfx)
                lib.GdipDeletePath(ctypes.c_void_p(path))
            lib.GdipDisposeImage(bmp)

    def close(self) -> None:
        lib = _gdiplus()
        if lib:
            for font in self._fonts.values():
                if font:
                    lib.GdipDeleteFont(ctypes.c_void_p(font))
            for fmt in self._formats.values():
                if fmt:
                    lib.GdipDeleteStringFormat(ctypes.c_void_p(fmt))
            if self._measure_gfx:
                lib.GdipDeleteGraphics(ctypes.c_void_p(self._measure_gfx))
        self._fonts.clear()
        self._formats.clear()
        self._measure_gfx = 0
        # 字族句柄**故意不删**：GDI+ 要求它活得比它建出来的字体久；进程内只建一次，
        # 留着比"删早了导致字体句柄悬空"安全（一个进程一个，可忽略）。


class LayeredSurface:
    """一张 32bpp **预乘 ARGB** 的自绘画布（`CreateDIBSection` + GDI+ Bitmap + 内存 DC）。

    画完可以 `blit()` 到窗口（`UpdateLayeredWindow`：位置、尺寸、内容、alpha 一把设完），
    也可以 `pixel()` 取样 —— 单测就是靠它把"圆角有没有抗锯齿"变成可断言的像素值。
    """

    def __init__(self, width: int, height: int) -> None:
        self.width = max(1, int(width))
        self.height = max(1, int(height))
        self._gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
        self._user32 = ctypes.WinDLL("user32", use_last_error=True)
        self._bind()
        self.memdc = 0
        self.hbmp = 0
        self._old_bmp = 0
        self.bits = ctypes.c_void_p()
        self.bitmap = 0
        self.gfx = 0
        screen = self._user32.GetDC(None)
        if not screen:
            raise OSError("GetDC(NULL) 失败：拿不到屏幕 DC")
        try:
            self.memdc = self._gdi32.CreateCompatibleDC(screen)
            if not self.memdc:
                raise OSError("CreateCompatibleDC 失败")
            info = _BitmapInfoHeader()
            info.biSize = ctypes.sizeof(_BitmapInfoHeader)
            info.biWidth = self.width
            info.biHeight = -self.height       # 负高度：自上而下；GDI+ 的 scan0 就是第一行
            info.biPlanes = 1
            info.biBitCount = 32
            info.biCompression = BI_RGB
            self.hbmp = self._gdi32.CreateDIBSection(
                screen, ctypes.byref(info), DIB_RGB_COLORS, ctypes.byref(self.bits),
                None, 0)
            if not self.hbmp:
                raise OSError("CreateDIBSection 失败")
            self._old_bmp = self._gdi32.SelectObject(self.memdc, self.hbmp)
            lib = _gdiplus()
            if lib is None:
                raise OSError("GDI+ 不可用")
            bmp = ctypes.c_void_p()
            if lib.GdipCreateBitmapFromScan0(self.width, self.height, self.width * 4,
                                             PIXEL_FORMAT_32BPP_PARGB, self.bits,
                                             ctypes.byref(bmp)) != 0 or not bmp:
                raise OSError("GdipCreateBitmapFromScan0 失败")
            self.bitmap = int(bmp.value or 0)
            gfx = ctypes.c_void_p()
            if lib.GdipGetImageGraphicsContext(bmp, ctypes.byref(gfx)) != 0 or not gfx:
                raise OSError("GdipGetImageGraphicsContext 失败")
            self.gfx = int(gfx.value or 0)
            lib.GdipGraphicsClear(ctypes.c_void_p(self.gfx), 0)   # 整幅全透明打底
        except Exception:
            self.close()
            raise
        finally:
            self._user32.ReleaseDC(None, screen)

    def _bind(self) -> None:
        from ctypes import wintypes

        g, u = self._gdi32, self._user32
        u.GetDC.argtypes = [wintypes.HWND]
        u.GetDC.restype = wintypes.HDC
        u.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
        u.UpdateLayeredWindow.argtypes = [
            wintypes.HWND, wintypes.HDC, ctypes.POINTER(wintypes.POINT),
            ctypes.POINTER(wintypes.SIZE), wintypes.HDC,
            ctypes.POINTER(wintypes.POINT), wintypes.DWORD,
            ctypes.POINTER(_BlendFunction), wintypes.DWORD]
        u.UpdateLayeredWindow.restype = wintypes.BOOL
        g.CreateCompatibleDC.argtypes = [wintypes.HDC]
        g.CreateCompatibleDC.restype = wintypes.HDC
        g.DeleteDC.argtypes = [wintypes.HDC]
        g.CreateDIBSection.argtypes = [
            wintypes.HDC, ctypes.POINTER(_BitmapInfoHeader), ctypes.c_uint,
            ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
        g.CreateDIBSection.restype = wintypes.HBITMAP
        g.SelectObject.argtypes = [wintypes.HDC, wintypes.HANDLE]
        g.SelectObject.restype = wintypes.HANDLE
        g.DeleteObject.argtypes = [wintypes.HANDLE]

    def pixel(self, x: int, y: int) -> tuple[int, int, int, int]:
        """取一个像素 `(a, r, g, b)`（走 GDI+ 读位图，测试/取证用）。"""
        lib = _gdiplus()
        argb = ctypes.c_uint(0)
        if not lib or not self.bitmap:
            return (0, 0, 0, 0)
        if lib.GdipBitmapGetPixel(ctypes.c_void_p(self.bitmap), int(x), int(y),
                                  ctypes.byref(argb)) != 0:
            return (0, 0, 0, 0)
        value = int(argb.value)
        return ((value >> 24) & 0xFF, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF)

    def blit(self, hwnd: int, x: int, y: int, alpha: int) -> bool:
        """把画布贴到窗口上（位置/尺寸/内容/不透明度一次设完）。"""
        from ctypes import wintypes

        if self.gfx:                 # 画完立刻把 Graphics 还给 GDI+，别让它挂着画布
            _gdiplus().GdipDeleteGraphics(ctypes.c_void_p(self.gfx))
            self.gfx = 0
        blend = _BlendFunction(AC_SRC_OVER, 0, max(0, min(255, int(alpha))), AC_SRC_ALPHA)
        pt_dst = wintypes.POINT(int(x), int(y))
        size = wintypes.SIZE(self.width, self.height)
        pt_src = wintypes.POINT(0, 0)
        screen = self._user32.GetDC(None)
        try:
            ok = self._user32.UpdateLayeredWindow(
                wintypes.HWND(hwnd), screen, ctypes.byref(pt_dst), ctypes.byref(size),
                self.memdc, ctypes.byref(pt_src), 0, ctypes.byref(blend), ULW_ALPHA)
        finally:
            self._user32.ReleaseDC(None, screen)
        return bool(ok)

    def close(self) -> None:
        lib = _gdiplus()
        if lib:
            if self.gfx:
                lib.GdipDeleteGraphics(ctypes.c_void_p(self.gfx))
            if self.bitmap:
                lib.GdipDisposeImage(ctypes.c_void_p(self.bitmap))
        self.gfx = 0
        self.bitmap = 0
        if self.memdc:
            self._gdi32.SelectObject(self.memdc, self._old_bmp)
            self._gdi32.DeleteDC(self.memdc)
            self.memdc = 0
        if self.hbmp:
            self._gdi32.DeleteObject(self.hbmp)
            self.hbmp = 0


def render_card_surface(rects: "PopupLayout", *, dpi: int, texts: dict, avatar: int = 0,
                        hover: bool = False, behind: int = 0,
                        text_color: "tuple[int, int, int] | None" = None):
    """离屏渲染一摞卡片 → `LayeredSurface`（窗口绘制与取证脚本共用同一段画法）。

    GDI+ 不可用时返回 None（调用方退回老 GDI 画法）。调用方负责 `close()`。
    """
    if not IS_WINDOWS or _gdiplus() is None:
        return None
    surface = LayeredSurface(rects.width, rects.height)
    painter = CardPainter()
    try:
        painter.paint(surface.gfx, rects, dpi=dpi, texts=texts, avatar=avatar,
                      hover=hover, behind=behind, text_color=text_color)
    finally:
        painter.close()
    return surface


def popup_enabled() -> bool:
    """自绘窗开关 = 通知总开关（`NOTIFY_ENABLED`）。

    只有一个展示通道（品牌色卡片），所以不需要再单独设一个"应用弹窗"开关 ——
    多一个开关只会让人分不清"为什么关了总开关还能弹 / 开了总开关却不弹"。
    """
    return bool(getattr(settings, "NOTIFY_ENABLED", True))


def popup_seconds() -> float:
    """自绘窗停留秒数（设置里可改：5 ~ 120 秒，默认 8，键 `NOTIFY_POPUP_SECONDS`）。"""
    try:
        value = float(getattr(settings, "NOTIFY_POPUP_SECONDS", 8.0))
    except (TypeError, ValueError):
        value = 8.0
    return max(5.0, min(120.0, value))


def popup_alpha() -> int:
    """自绘窗不透明度（0-255，来自 `settings.NOTIFY_POPUP_ALPHA_PCT` 的百分数）。

    界面上是百分比（默认 90%），绘制层要 0-255 —— 换算只在这一处做，
    免得两处各写一份（`90% → 230`）。
    """
    try:
        pct = int(getattr(settings, "NOTIFY_POPUP_ALPHA_PCT", 90))
    except (TypeError, ValueError):
        pct = 90
    return max(80, min(255, round(pct * 255 / 100)))


def popup_text_color() -> tuple[int, int, int]:
    """自绘窗**文字颜色**（设置窗口里可改，默认白色 `#ffffff`，键 `NOTIFY_POPUP_COLOR`）。"""
    raw = str(getattr(settings, "NOTIFY_POPUP_COLOR", "#ffffff")).strip().lstrip("#")
    try:
        return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16))
    except (ValueError, IndexError):
        return (255, 255, 255)


if IS_WINDOWS:  # pragma: no cover - 平台分支
    from ctypes import wintypes

    LRESULT = ctypes.c_ssize_t
    WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT,
                                 wintypes.WPARAM, wintypes.LPARAM)

    class _WNDCLASSEXW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.UINT), ("style", wintypes.UINT),
            ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int),
            ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE),
            ("hIcon", wintypes.HICON), ("hCursor", wintypes.HANDLE),
            ("hbrBackground", wintypes.HBRUSH), ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR), ("hIconSm", wintypes.HICON),
        ]

    class _MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                    ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

    class _PAINTSTRUCT(ctypes.Structure):
        _fields_ = [("hdc", wintypes.HDC), ("fErase", wintypes.BOOL),
                    ("rcPaint", wintypes.RECT), ("fRestore", wintypes.BOOL),
                    ("fIncUpdate", wintypes.BOOL), ("rgbReserved", ctypes.c_byte * 32)]

    class _TRACKMOUSEEVENT(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                    ("hwndTrack", wintypes.HWND), ("dwHoverTime", wintypes.DWORD)]


def _rgb(color: tuple[int, int, int]) -> int:
    """(r,g,b) → Win32 COLORREF（0x00BBGGRR）。"""
    r, g, b = color
    return r | (g << 8) | (b << 16)


def _mix(front: tuple[int, int, int], back: tuple[int, int, int],
         weight: float) -> tuple[int, int, int]:
    """把 `front` 朝 `back` 混 `weight`（0=纯 front，1=纯 back）。"""
    w = max(0.0, min(1.0, weight))
    return tuple(int(round(f * (1 - w) + b * w)) for f, b in zip(front, back))  # type: ignore[return-value]


class PopupWindow:  # pragma: no cover - 需要真实 Windows 桌面会话才有意义
    """品牌配色自绘提示窗（线程内单例；`show()` 复用同一个窗口）。"""

    WM_PAINT = 0x000F
    WM_ERASEBKGND = 0x0014
    WM_SETCURSOR = 0x0020
    WM_MOUSEMOVE = 0x0200
    WM_LBUTTONUP = 0x0202
    WM_MOUSELEAVE = 0x02A3
    IDC_HAND = 32649
    TME_LEAVE = 0x00000002
    SW_HIDE = 0
    SW_SHOWNOACTIVATE = 4
    HWND_TOPMOST = -1
    SWP_NOACTIVATE = 0x0010
    SWP_SHOWWINDOW = 0x0040
    SWP_NOSIZE = 0x0001
    SWP_NOMOVE = 0x0002
    LWA_ALPHA = 0x00000002
    DI_NORMAL = 0x0003
    MONITOR_DEFAULTTONEAREST = 2
    PM_REMOVE = 0x0001
    DT_LEFT = 0x00000000
    DT_RIGHT = 0x00000002
    DT_SINGLELINE = 0x00000020
    DT_WORDBREAK = 0x00000010
    DT_CALCRECT = 0x00000400
    DT_END_ELLIPSIS = 0x00008000
    DT_NOPREFIX = 0x00000800
    TRANSPARENT = 1
    PS_SOLID = 0
    DEFAULT_CHARSET = 1
    CLEARTYPE_QUALITY = 5
    DEFAULT_PITCH = 0
    FW_NORMAL, FW_SEMIBOLD = FONT_WEIGHT_NORMAL, FONT_WEIGHT_SEMIBOLD
    NULL_BRUSH = 5
    NULL_PEN = 8

    def __init__(self, on_click: Callable[[str], None] | None = None) -> None:
        self.on_click = on_click
        self._gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
        self._user32 = ctypes.WinDLL("user32", use_last_error=True)
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._wndproc = WNDPROC(self._on_message)   # 必须持有引用（否则野指针）
        self._hwnd: int | None = None
        self._class_name = f"DDtoolkitPopup_{uuid.uuid4().hex}"
        self._fonts: dict[str, int] = {}
        self._dpi = 96
        self._url: str | None = None
        self._visible = False
        self._shown_at = 0.0
        self._seconds = 8.0
        self._hover = False
        self._hover_since = 0.0      # 悬停起点：停满 HOVER_DISMISS_SECONDS 就自动消除
        # 一摞通知（最多 STACK_MAX 条）：顶层在最前，收走一层露出下一条
        self._entries: list[_Entry] = []
        self._tracking = False
        self._texts = {"title": "", "body": "", "hint": ""}
        self._rects: PopupLayout | None = None
        self._card_icon = 0          # 卡片左上角的自家图标（按 DPI 加载一次）
        self._card_icon_dpi = 0
        self._supplied_icon = 0      # 外部传入的图标（主播头像）优先于 App 图标
        self._painter_obj: CardPainter | None = None
        self._layered = False        # True = 走逐像素 alpha（GDI+）画法
        self._ulw_used = False       # 是否用过 UpdateLayeredWindow（与 SetLayeredWindowAttributes 互斥）
        self._present_alpha = 0      # 最近一次真正贴上去的不透明度（判据用）
        self._pos = (0, 0)           # 最近一次贴图的目标位置（重画时复用）
        self._bind()

    # ── 绑定（argtypes 必须显式给：64 位下默认 int 转换会截断指针）──
    def _bind(self) -> None:
        from ctypes import wintypes

        u, g, k = self._user32, self._gdi32, self._kernel32
        k.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
        k.GetModuleHandleW.restype = wintypes.HINSTANCE
        u.RegisterClassExW.argtypes = [ctypes.POINTER(_WNDCLASSEXW)]
        u.RegisterClassExW.restype = wintypes.WORD
        u.CreateWindowExW.argtypes = [
            wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
        u.CreateWindowExW.restype = wintypes.HWND
        u.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT,
                                    wintypes.WPARAM, wintypes.LPARAM]
        u.DefWindowProcW.restype = LRESULT
        u.DestroyWindow.argtypes = [wintypes.HWND]
        u.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int,
                                   ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        u.UpdateWindow.argtypes = [wintypes.HWND]
        u.SetWindowRgn.argtypes = [wintypes.HWND, wintypes.HANDLE, wintypes.BOOL]
        u.InvalidateRect.argtypes = [wintypes.HWND, ctypes.c_void_p, wintypes.BOOL]
        u.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
        u.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
        u.MonitorFromPoint.restype = wintypes.HANDLE
        u.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_MONITORINFO)]
        u.GetDpiForWindow.argtypes = [wintypes.HWND]
        u.GetDpiForWindow.restype = wintypes.UINT
        u.LoadCursorW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR]
        u.LoadCursorW.restype = wintypes.HANDLE
        u.SetCursor.argtypes = [wintypes.HANDLE]
        u.SetCursor.restype = wintypes.HANDLE
        u.TrackMouseEvent.argtypes = [ctypes.POINTER(_TRACKMOUSEEVENT)]
        u.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND,
                                   wintypes.UINT, wintypes.UINT, wintypes.UINT]
        u.PeekMessageW.restype = wintypes.BOOL
        u.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
        u.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
        u.DispatchMessageW.restype = LRESULT
        u.BeginPaint.argtypes = [wintypes.HWND, ctypes.POINTER(_PAINTSTRUCT)]
        u.BeginPaint.restype = wintypes.HDC
        u.EndPaint.argtypes = [wintypes.HWND, ctypes.POINTER(_PAINTSTRUCT)]
        u.GetDC.argtypes = [wintypes.HWND]
        u.GetDC.restype = wintypes.HDC
        u.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
        u.DrawTextW.argtypes = [wintypes.HDC, wintypes.LPCWSTR, ctypes.c_int,
                                ctypes.POINTER(wintypes.RECT), wintypes.UINT]
        u.DrawTextW.restype = ctypes.c_int
        u.DrawIconEx.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int,
                                 wintypes.HANDLE, ctypes.c_int, ctypes.c_int,
                                 wintypes.UINT, wintypes.HANDLE, wintypes.UINT]
        u.SetLayeredWindowAttributes.argtypes = [wintypes.HWND, wintypes.DWORD,
                                                 ctypes.c_byte, wintypes.DWORD]
        u.GetLayeredWindowAttributes.argtypes = [wintypes.HWND, ctypes.c_void_p,
                                                 ctypes.POINTER(ctypes.c_byte),
                                                 ctypes.POINTER(wintypes.DWORD)]
        g.CreateSolidBrush.argtypes = [wintypes.DWORD]
        g.CreateSolidBrush.restype = wintypes.HBRUSH
        g.CreatePen.argtypes = [ctypes.c_int, ctypes.c_int, wintypes.DWORD]
        g.CreatePen.restype = wintypes.HANDLE
        g.CreateRoundRectRgn.argtypes = [ctypes.c_int] * 6
        g.CreateRoundRectRgn.restype = wintypes.HANDLE
        # CreateFontW：13 个整型（高/宽/字距/角度/字重/斜体/下划线/删除线/字符集/
        # 输出精度/裁剪精度/质量/字族）+ 字体名
        g.CreateFontW.argtypes = [ctypes.c_int] * 13 + [wintypes.LPCWSTR]
        g.CreateFontW.restype = wintypes.HANDLE
        g.SelectObject.argtypes = [wintypes.HDC, wintypes.HANDLE]
        g.SelectObject.restype = wintypes.HANDLE
        g.DeleteObject.argtypes = [wintypes.HANDLE]
        g.RoundRect.argtypes = [wintypes.HDC] + [ctypes.c_int] * 6
        # ⚠️ FillRect / DrawTextW 都在 **user32**（不是 gdi32）—— 名字容易想当然
        u.FillRect.argtypes = [wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.HBRUSH]
        g.SetBkMode.argtypes = [wintypes.HDC, ctypes.c_int]
        g.SetTextColor.argtypes = [wintypes.HDC, wintypes.DWORD]
        g.GetStockObject.argtypes = [ctypes.c_int]
        g.GetStockObject.restype = wintypes.HANDLE

    def _null_brush(self) -> int:
        """空画刷（`RoundRect` 只描边不填充时用）。"""
        return self._gdi32.GetStockObject(self.NULL_BRUSH)

    def _null_pen(self) -> int:
        """空画笔（只填充不描边用：圆角靠填充弧本身，见 `_draw_card`）。"""
        return self._gdi32.GetStockObject(self.NULL_PEN)

    # ── 窗口生命周期 ──
    def open(self) -> bool:
        from ctypes import wintypes

        if self._hwnd:
            return True
        ensure_dpi_awareness()      # ⚠️ 必须在建窗之前（否则高分屏下整幅被拉伸 → 发糊）
        inst = self._kernel32.GetModuleHandleW(None)
        wc = _WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(_WNDCLASSEXW)
        wc.lpfnWndProc = self._wndproc
        wc.hInstance = inst
        wc.lpszClassName = self._class_name
        if not self._user32.RegisterClassExW(ctypes.byref(wc)):
            logger.warning(f"提示窗类注册失败（err={ctypes.get_last_error()}）")
            return False
        # WS_EX_TOOLWINDOW(0x80) | WS_EX_NOACTIVATE(0x08000000) | WS_EX_TOPMOST(0x8)
        # | WS_EX_LAYERED(0x00080000，负责"粉色半透")
        ex_style = 0x00000080 | 0x08000000 | 0x00000008 | 0x00080000
        hwnd = self._user32.CreateWindowExW(
            ex_style, self._class_name, self._class_name, 0x80000000,   # WS_POPUP
            0, 0, 0, 0, None, None, inst, None)
        if not hwnd:
            logger.warning(f"提示窗创建失败（err={ctypes.get_last_error()}）")
            return False
        self._hwnd = hwnd
        # 半透在 **show() 里每次都设**（见那里的注释）：本窗是复用的，
        # 只在这里设一次的话，用户改了不透明度要重启进程才生效（实测踩过）。
        return True

    def close(self) -> None:
        if self._hwnd:
            self._user32.DestroyWindow(self._hwnd)
            self._hwnd = None
        self._layered = False
        if self._painter_obj is not None:
            self._painter_obj.close()       # GDI+ 字体/格式句柄都得还
            self._painter_obj = None
        for font in self._fonts.values():
            self._gdi32.DeleteObject(font)
        self._fonts.clear()
        if self._card_icon:
            self._gdi32.DeleteObject(self._card_icon)
            self._card_icon = 0
            self._card_icon_dpi = 0

    def _ensure_card_icon(self) -> int:
        """按当前 DPI 加载卡片图标（尺寸变了就重载，别缩放糊掉）。"""
        if self._card_icon and self._card_icon_dpi == self._dpi:
            return self._card_icon
        if self._card_icon:
            self._gdi32.DeleteObject(self._card_icon)
            self._card_icon = 0
        size = max(16, _px(BASE_ICON, self._dpi))
        self._card_icon = load_icon_file(app_icon_path(), size)
        self._card_icon_dpi = self._dpi
        return self._card_icon

    # ── 字体 / 测量 ──
    def _font(self, role: str, size_dip: int, weight: int) -> int:
        """按**实际像素高度**缓存字体。

        ⚠️ 缓存键必须包含**最终像素高度**（= DIP × DPI × 字号缩放），而不是 DIP 与 DPI：
        用后者的话，用户改了"字号"也不会重建字体 —— 已建好的 HFONT 一直被复用，
        表现为"只有重启应用后字号才变"（2026-09-26 用户实测："只有顶上标题会变"，
        本质是标题在重启那次用新字号建过字体，正文那次没赶上）。
        """
        px = -_px(size_dip, self._dpi)                # 负值 = 字符高度（含行距）
        key = f"{weight}:{px}"                        # 像素高度进键：改字号就会重建字体
        font = self._fonts.get(key)
        if font:
            return font
        if len(self._fonts) >= 24:                    # 缩放/DPI 反复调整过：清一次，别攒 HFONT
            for old in self._fonts.values():
                self._gdi32.DeleteObject(old)
            self._fonts.clear()
        font = self._gdi32.CreateFontW(
            px, 0, 0, 0, weight, 0, 0, 0, self.DEFAULT_CHARSET,
            0, 0, self.CLEARTYPE_QUALITY, self.DEFAULT_PITCH, FONT_FACE)
        self._fonts[key] = font
        return font

    def _measure(self, text: str, font: int, width: int, *, wrap: bool) -> int:
        from ctypes import wintypes

        hdc = self._user32.GetDC(self._hwnd)
        old = self._gdi32.SelectObject(hdc, font)
        rect = wintypes.RECT(0, 0, width, 0)
        flags = self.DT_LEFT | self.DT_NOPREFIX | (
            self.DT_WORDBREAK if wrap else self.DT_SINGLELINE)
        self._user32.DrawTextW(hdc, text, -1, ctypes.byref(rect), flags | self.DT_CALCRECT)
        self._gdi32.SelectObject(hdc, old)
        self._user32.ReleaseDC(self._hwnd, hdc)
        return max(1, int(rect.bottom))

    # ── 展示 / 隐藏 ──
    def show(self, *, title: str, body: str, url: str | None = None,
             seconds: float | None = None, hint: str = "", icon: int = 0,
             push: bool = True) -> bool:
        """展示（或**叠上**）一条通知，返回是否成功显示。

        - 窗口没在显示 → 开一摞新的（`push` 参数此时无影响）；
        - 窗口正在显示 → **叠一层**（最多 `STACK_MAX`=10；满了丢最旧那条）；
        - 卡面永远是最上面那条（`_entries[-1]`），点/悬停只收走这一层（见 `_dismiss_top`）。

        `seconds` 不给就用设置里的「弹窗时长」（5~120 秒）。
        """
        if not self.open():
            return False
        if not self._visible:
            self._entries = []
            self._seconds = popup_seconds() if seconds is None else seconds
        if push:
            if len(self._entries) >= STACK_MAX:
                self._entries.pop(0)       # 一摞最多 10 条：满了丢最旧的，新的更重要
            self._entries.append(_Entry(title=title, body=body, url=url,
                                        hint=hint if url else "", icon=icon))
        return self._render(reset_timer=True)

    def _render(self, *, reset_timer: bool) -> bool:
        """按当前顶层条目重排布局、重新定位并重绘（`show` 与"收走一层"共用）。

        绘制优先走**逐像素 alpha**（GDI+ → `UpdateLayeredWindow`，圆角抗锯齿），
        不可用时才退回老的「窗口 Region + GDI RoundRect」。
        """
        from ctypes import wintypes

        if not self._entries or self._hwnd is None:
            return False
        top = self._entries[-1]
        self._dpi = int(self._user32.GetDpiForWindow(self._hwnd) or 96)
        self._supplied_icon = top.icon
        self._url = top.url
        self._texts = {"title": top.title, "body": top.body, "hint": top.hint}

        width_dip = popup_width_dip()    # 设置窗口里的「弹窗大小」
        tw = text_width(self._dpi, width_dip)
        has_hint = bool(top.url and top.hint)
        painter = self._painter()
        if painter is not None:
            # 量、画都走 GDI+（同一个引擎），否则会出现"量 3 行、画 4 行"把末行切掉
            title_h = painter.measure(top.title, BASE_TITLE_SIZE, FONT_WEIGHT_SEMIBOLD,
                                      tw, wrap=False, dpi=self._dpi)
            body_h = painter.measure(top.body, BASE_BODY_SIZE, FONT_WEIGHT_NORMAL,
                                     tw, wrap=True, dpi=self._dpi)
            hint_h = painter.measure(top.hint or "x", BASE_HINT_SIZE,
                                     FONT_WEIGHT_SEMIBOLD, tw, wrap=False,
                                     dpi=self._dpi) if has_hint else 0
        else:
            title_h = self._measure(top.title,
                                   self._font("title", BASE_TITLE_SIZE, self.FW_SEMIBOLD),
                                   tw, wrap=False)
            body_h = self._measure(top.body,
                                   self._font("body", BASE_BODY_SIZE, self.FW_NORMAL),
                                   tw, wrap=True)
            hint_h = self._measure(top.hint or "x",
                                   self._font("hint", BASE_HINT_SIZE, self.FW_SEMIBOLD),
                                   tw, wrap=False) if has_hint else 0
        icon_px = max(16, _px(BASE_ICON, self._dpi)) if self._ensure_card_icon() else 0
        edges = min(len(self._entries) - 1, STACK_VISIBLE_EDGES)
        rects = compute_layout(self._dpi, title_h=title_h, body_h=body_h, hint_h=hint_h,
                               width_dip=width_dip, has_hint=has_hint, icon_px=icon_px,
                               stack=edges + 1)
        self._rects = rects

        # 定位：**鼠标所在那块屏**的工作区右下角（多显示器下不会被错过）
        pt = wintypes.POINT()
        self._user32.GetCursorPos(ctypes.byref(pt))
        mon = self._user32.MonitorFromPoint(pt, self.MONITOR_DEFAULTTONEAREST)
        info = _MONITORINFO()
        info.cbSize = ctypes.sizeof(_MONITORINFO)
        self._user32.GetMonitorInfoW(mon, ctypes.byref(info))
        margin = _px(16, self._dpi)
        x = max(info.rcWork.left, info.rcWork.right - rects.width - margin)
        y = max(info.rcWork.top, info.rcWork.bottom - rects.height - margin)
        self._pos = (x, y)
        # 逐像素 alpha 自己管形状：先清掉老的 1 位裁剪区，否则它会把刚画好的柔和边再切硬
        self._user32.SetWindowRgn(self._hwnd, None, True)
        if self._present_layered(x, y):
            self._layered = True
            self._user32.ShowWindow(self._hwnd, self.SW_SHOWNOACTIVATE)
            self._user32.SetWindowPos(self._hwnd, self.HWND_TOPMOST, 0, 0, 0, 0,
                                      self.SWP_NOACTIVATE | self.SWP_NOMOVE | self.SWP_NOSIZE)
        else:
            self._layered = False
            if self._ulw_used:
                # `UpdateLayeredWindow` 与 `SetLayeredWindowAttributes` 在同一个窗口上互斥，
                # 走过 ULW 之后半透可能设不上（窗口保持上次的 ULW 内容）—— 记一条便于排查。
                logger.warning("本窗曾用 UpdateLayeredWindow：GDI 退路的不透明度可能不生效")
            self._user32.SetWindowPos(self._hwnd, self.HWND_TOPMOST, x, y,
                                      rects.width, rects.height,
                                      self.SWP_NOACTIVATE | self.SWP_SHOWWINDOW)
            # 每次展示都重设一次 alpha：窗口是**复用**的（不是每次新建），
            # 只在建窗时设一次的话，设置里改不透明度得重启进程才生效 —— 用户实测"没生效"就是这个。
            self._user32.SetLayeredWindowAttributes(self._hwnd, 0, popup_alpha(), self.LWA_ALPHA)
            # ⚠️ 裁剪区必须与 `_draw_card` 画的矩形**逐像素对齐**：两边都用
            # (0, 0, width, height) 与同一个半径。曾经这里写成 width+1/height+1，
            # 于是区域圆弧与绘制圆弧错开 1px —— 最外层卡片的角上出现
            # "一边有描边、一边被裁掉"的毛边（用户实测："最底层弹窗的角像素有点糊"）。
            rgn = self._gdi32.CreateRoundRectRgn(0, 0, rects.width, rects.height,
                                                rects.radius * 2, rects.radius * 2)
            if rgn:
                self._user32.SetWindowRgn(self._hwnd, rgn, True)
            self._user32.ShowWindow(self._hwnd, self.SW_SHOWNOACTIVATE)
        # 悬停状态**不要重置**：收走一层时鼠标往往还在卡片上，把它当成"没悬停"会
        # 导致"移开再移回来"才能继续收层（实测）。这里只把 3 秒倒计时重新开始。
        self._hover_since = time.monotonic() if self._hover else 0.0
        self._visible = True
        if reset_timer:
            self._shown_at = time.monotonic()
        if not self._layered:
            self._user32.InvalidateRect(self._hwnd, None, True)
            self._user32.UpdateWindow(self._hwnd)  # 立刻画，不等下一次 pump
        return True

    def _painter(self) -> "CardPainter | None":
        """GDI+ 画笔（懒建；不可用返回 None → 全程退回老 GDI 画法）。"""
        if self._painter_obj is None and IS_WINDOWS and _gdiplus() is not None:
            self._painter_obj = CardPainter()
        return self._painter_obj

    def _present_layered(self, x: int, y: int) -> bool:
        """把整摞卡片画成逐像素 alpha 位图并贴到窗口上（`UpdateLayeredWindow`）。

        失败（GDI+ 不可用 / 画布建不出来）返回 False，调用方会退回老画法 ——
        通知能不能弹是硬要求，渲染管线只是"更好看"。
        """
        global _logged_pipeline

        rects = self._rects
        painter = self._painter()
        if rects is None or not self._hwnd or painter is None:
            return False
        try:
            surface = LayeredSurface(rects.width, rects.height)
        except Exception as e:      # pragma: no cover - 极端环境
            logger.warning(f"提示窗离屏画布创建失败（退回 GDI 画法）: "
                           f"{type(e).__name__}: {e}")
            return False
        try:
            painter.paint(surface.gfx, rects, dpi=self._dpi, texts=self._texts,
                          avatar=self._supplied_icon or self._card_icon,
                          hover=self._hover, behind=max(0, len(self._entries) - 1),
                          text_color=popup_text_color())
            alpha = popup_alpha()
            if not surface.blit(self._hwnd, x, y, alpha):
                logger.warning(f"UpdateLayeredWindow 失败（err={ctypes.get_last_error()}）")
                return False
            if not _logged_pipeline:
                _logged_pipeline = True
                logger.info("提示窗渲染管线：GDI+ 逐像素 alpha（UpdateLayeredWindow，圆角抗锯齿）")
            self._ulw_used = True
            self._present_alpha = alpha     # 记录实际用的不透明度（测试与日志的判据）
            return True
        finally:
            surface.close()

    def _dismiss_top(self) -> None:
        """收走**最顶上一层**（露出下面那条）；收光了才隐藏窗口。"""
        if not self._entries:
            self.hide()
            return
        self._entries.pop()
        if not self._entries:
            self.hide()
            return
        # 还有下层：换文案重排重画，计时**不重置**（整摞仍然按"最后一次更新"到点收走）
        self._render(reset_timer=False)

    def hide(self) -> None:
        if self._hwnd and self._visible:
            self._user32.ShowWindow(self._hwnd, self.SW_HIDE)
        self._visible = False
        self._entries = []              # 整摞清空：下一次通知从单张重新开始

    def tick(self) -> None:
        """到点自动隐藏（投递线程每次循环调用；不依赖 WM_TIMER）。

        两种"到点"：
        - **停留时长**（设置里的「弹窗时长」5~120 秒）；
        - **鼠标停在卡片上满 3 秒**（用户口径：悬停 3 秒即消除，不必等时间到）。
        """
        if not self._visible:
            return
        now = time.monotonic()
        if now - self._shown_at >= self._seconds:
            self.hide()
            return
        if self._hover and self._hover_since and now - self._hover_since >= HOVER_DISMISS_SECONDS:
            # 悬停满 3 秒：只收走**最顶上一层**（下面几层依次露出来）
            self._dismiss_top()

    @property
    def visible(self) -> bool:
        """当前是否正显示（调用方据此判断"上一条还没走"→ 折叠层数 +1）。"""
        return self._visible

    @property
    def stack(self) -> int:
        """当前一摞有几层（1 = 单张）。"""
        return len(self._entries)

    def pump(self, budget: int = 64) -> int:
        """派发本线程消息（有上限：消息刷屏时也必须返回 —— notifier 踩过这个坑）。"""
        from ctypes import wintypes

        msg = wintypes.MSG()
        seen = 0
        while seen < budget and self._user32.PeekMessageW(
                ctypes.byref(msg), None, 0, 0, self.PM_REMOVE):
            self._user32.TranslateMessage(ctypes.byref(msg))
            self._user32.DispatchMessageW(ctypes.byref(msg))
            seen += 1
        return seen

    # ── 绘制 ──
    def _paint(self) -> None:
        from ctypes import wintypes

        if self._layered:
            # 逐像素 alpha 模式下窗口内容由 `UpdateLayeredWindow` 提供，WM_PAINT 只负责
            # **收掉脏区域**：不 BeginPaint/EndPaint 的话更新区域一直非空 → WM_PAINT 死循环。
            ps = _PAINTSTRUCT()
            self._user32.BeginPaint(self._hwnd, ctypes.byref(ps))
            self._user32.EndPaint(self._hwnd, ctypes.byref(ps))
            return
        rects = self._rects
        if rects is None:
            return
        ps = _PAINTSTRUCT()
        hdc = self._user32.BeginPaint(self._hwnd, ctypes.byref(ps))
        try:
            bg = RGB_BG_HOVER if self._hover else RGB_BG
            behind = max(0, len(self._entries) - 1)          # 后面还压着几条
            depth = min(behind, STACK_VISIBLE_EDGES)         # 画面上最多画 4 条露头边
            layer_h = _px(STACK_OFFSET, self._dpi)
            shift = depth * layer_h
            card_h = rects.height - shift          # 主卡片自身高度（不含折叠露出的部分）

            # 后面几层：逐层向上错开，只露一条顶边（从最远的一层先画，近的盖上去）
            for i in range(depth, 0, -1):
                top = shift - i * layer_h
                # 越靠后越接近品牌深粉（别混黑：混黑会发灰，和粉色卡片不搭）
                layer_bg = _mix(bg, RGB_BAR, 0.30 + 0.20 * (depth - i))
                self._draw_card(hdc, top, rects.width, card_h, rects.radius, layer_bg)
            self._draw_card(hdc, shift, rects.width, card_h, rects.radius, bg)

            bar_brush = self._gdi32.CreateSolidBrush(_rgb(RGB_BAR))
            self._user32.FillRect(hdc, ctypes.byref(wintypes.RECT(*rects.bar)), bar_brush)
            self._gdi32.DeleteObject(bar_brush)

            self._gdi32.SetBkMode(hdc, self.TRANSPARENT)
            # 文字颜色可在设置里改（默认白色）；正文/提示由它向底色混一点，保持层次
            text_fg = popup_text_color()
            body_fg = _mix(text_fg, bg, 0.15)
            avatar = self._supplied_icon or self._card_icon
            if rects.icon and avatar:
                left, top, right, bottom = rects.icon
                self._user32.DrawIconEx(hdc, left, top, avatar,
                                        right - left, bottom - top,
                                        0, None, self.DI_NORMAL)
                # 头像圆角：用"和底色同色的粗圆角描边"把四个直角盖掉（比 GDI+ 裁剪省事）
                corner_pen = self._gdi32.CreatePen(
                    self.PS_SOLID, max(2, _px(3, self._dpi)), _rgb(bg))
                old_pen = self._gdi32.SelectObject(hdc, corner_pen)
                old_brush = self._gdi32.SelectObject(hdc, self._null_brush())
                self._gdi32.RoundRect(hdc, left, top, right, bottom,
                                      rects.radius, rects.radius)
                self._gdi32.SelectObject(hdc, old_pen)
                self._gdi32.SelectObject(hdc, old_brush)
                self._gdi32.DeleteObject(corner_pen)
            self._draw_text(hdc, self._texts["title"],
                            self._font("title", BASE_TITLE_SIZE, self.FW_SEMIBOLD),
                            rects.title, text_fg, wrap=False)
            self._draw_text(hdc, self._texts["body"],
                            self._font("body", BASE_BODY_SIZE, self.FW_NORMAL),
                            rects.body, body_fg, wrap=True)
            if rects.has_hint:
                self._draw_text(hdc, self._texts["hint"],
                                self._font("hint", BASE_HINT_SIZE, self.FW_SEMIBOLD),
                                rects.hint, text_fg, wrap=False, right=True)
            if behind:
                # 右上角 ＋N：告诉用户"还叠着几张"（点开只看最新那条）
                badge = (rects.title[2] - _px(60, self._dpi), rects.title[1],
                         rects.title[2], rects.title[1] + _px(16, self._dpi))
                self._draw_text(hdc, f"＋{behind}",
                                self._font("hint", BASE_HINT_SIZE, self.FW_SEMIBOLD),
                                badge, text_fg, wrap=False, right=True)
        finally:
            self._user32.EndPaint(self._hwnd, ctypes.byref(ps))

    def _draw_card(self, hdc: int, top: int, width: int, card_h: int,
                   radius: int, bg: tuple[int, int, int]) -> None:
        """画一张圆角卡片（主卡片与折叠层共用）。

        ⚠️ **不描边**：GDI 的 `RoundRect` 与窗口 Region 都不做抗锯齿，1px 描边在圆角处
        会一段有一像素、一段被裁掉 —— 看起来正是"角上发糊"（2026-09-26 用户实测，
        见 devlog/219）。去掉描边后圆角是干净的填充弧；卡片与桌面的分界靠
        粉色本身 + 半透明就够清楚了。
        """
        brush = self._gdi32.CreateSolidBrush(_rgb(bg))
        old_brush = self._gdi32.SelectObject(hdc, brush)
        old_pen = self._gdi32.SelectObject(hdc, self._null_pen())
        self._gdi32.RoundRect(hdc, 0, top, width, top + card_h, radius * 2, radius * 2)
        self._gdi32.SelectObject(hdc, old_brush)
        self._gdi32.SelectObject(hdc, old_pen)
        self._gdi32.DeleteObject(brush)

    def _draw_text(self, hdc: int, text: str, font: int, rect: tuple,
                   color: tuple[int, int, int], *, wrap: bool, right: bool = False) -> None:
        from ctypes import wintypes

        if not text:
            return
        old = self._gdi32.SelectObject(hdc, font)
        self._gdi32.SetTextColor(hdc, _rgb(color))
        flags = self.DT_NOPREFIX | (self.DT_WORDBREAK if wrap else self.DT_SINGLELINE)
        if not wrap:
            flags |= self.DT_END_ELLIPSIS
        flags |= self.DT_RIGHT if right else self.DT_LEFT
        self._user32.DrawTextW(hdc, text, -1, ctypes.byref(wintypes.RECT(*rect)), flags)
        self._gdi32.SelectObject(hdc, old)

    # ── 窗口过程 ──
    def _on_message(self, hwnd, msg, wparam, lparam) -> int:
        """点击 / 悬停 / 光标 / 重绘；异常绝不穿出（ctypes 回调穿异常 = 现场难查）。"""
        try:
            if msg == self.WM_PAINT:
                self._paint()
                return 0
            if msg == self.WM_ERASEBKGND:
                return 1                      # 全部在 WM_PAINT 里画，免闪
            if msg == self.WM_LBUTTONUP:
                self._handle_click()
                return 0
            if msg == self.WM_MOUSEMOVE:
                self._set_hover(True)
                self._track_leave()
            elif msg == self.WM_MOUSELEAVE:
                self._set_hover(False)
                self._tracking = False
            elif msg == self.WM_SETCURSOR and self._url:
                from ctypes import wintypes

                hand = self._user32.LoadCursorW(
                    None, ctypes.cast(ctypes.c_void_p(self.IDC_HAND), wintypes.LPCWSTR))
                if hand:
                    self._user32.SetCursor(hand)
                    return 1
        except Exception as e:
            logger.warning(f"提示窗消息处理异常（忽略）: {type(e).__name__}: {e}")
        return self._user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _handle_click(self) -> None:
        url = self._url
        if url and self.on_click:
            try:
                self.on_click(url)
            except Exception as e:
                logger.warning(f"提示窗点击处理异常（忽略）: {type(e).__name__}: {e}")
        # 点击：打开这一层的链接 + **只收走这一层**（下面几层依次露出来）
        self._dismiss_top()

    def _set_hover(self, hover: bool) -> None:
        if hover != self._hover:
            self._hover = hover
            # 悬停计时：进入时开始，离开就清零（满 3 秒由 tick() 消除这张卡片）
            self._hover_since = time.monotonic() if hover else 0.0
            self._repaint()

    def _repaint(self) -> None:
        """重画当前这一摞（悬停变色用）。

        逐像素 alpha 模式下窗口内容只有 `UpdateLayeredWindow` 能改（`InvalidateRect`
        触发的 WM_PAINT 在这里是空转），所以直接重贴一次；失败就退回 GDI 画法。
        """
        if self._layered and self._rects is not None and self._present_layered(*self._pos):
            return
        self._layered = False
        self._user32.InvalidateRect(self._hwnd, None, True)

    def _track_leave(self) -> None:
        if self._tracking or not self._hwnd:
            return
        tme = _TRACKMOUSEEVENT(ctypes.sizeof(_TRACKMOUSEEVENT), self.TME_LEAVE,
                               self._hwnd, 0)
        if self._user32.TrackMouseEvent(ctypes.byref(tme)):
            self._tracking = True
