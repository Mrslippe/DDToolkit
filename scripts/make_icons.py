"""从用户设计 LOGO 生成桌面端图标（窗口 / 任务栏 / 安装包 / 商店资源）。

源（用户设计，`docs/design/`）：
- `svg/LOGO.svg`  矢量主稿（唯一真源；前端顶栏/启动幕内联同一路径）
- `svg/LOGO-small.svg` / `png/LOGO-small.png`  **可选的小尺寸专用稿**（见下）
- `png/NGNlogo无底.png` 早期栅格导出，保留备查，本脚本不再使用

输出：`frontend/src-tauri/icons/`
- 品牌粉圆角底 + 白色猫脸；`icon.ico`（11 层）、`icon.png`(512)、32/64/128/128@2x、
  Windows 商店 Square*Logo.png / StoreLogo.png、`icon.icns`（macOS，失败则跳过）

为什么改成「按尺寸补偿描边」+「ICO 首项换任务栏专用层」（2026-09-09）
--------------------------------------------------------------------
用户反馈「任务栏里的 LOGO 太模糊」。根因在构建链路，两层叠加：

1. **Tauri 只拿 ICO 目录的第一项当窗口图标。**
   `tauri-codegen/src/image.rs::CachedIcon::new_ico` 取的是 `icon_dir.entries()[0]`，
   而 ico crate 的 `IconDir::read` 按文件顺序入表（不排序）；`PIL` 的 ICO 写入器
   又固定按尺寸升序写目录。于是旧 `icon.ico` 的第一项是 16×16，Tauri 把它
   当作 `default_window_icon` 交给 tao（`IconType::Small`），Win11 任务栏再把它
   放大到 24/36px —— 等于拿 16px 的位图放大当图标用，必然糊。
2. **线稿猫在 ≤32px 下描边不足 1px。**
   按原比例（LOGO 视觉高占图标 60%）渲染到 24px 时描边只有 0.7px，
   抗锯齿直接把它抹成灰雾。

对策：
- `icon.ico` 目录顺序改为 **48 优先**（首项 = 任务栏专用层），其余按标准尺寸；
- 首项 48px 用**简化加粗版**（只留头部轮廓 + 两个圆点眼，描边 ≈2.9px）：
  Windows 把它缩到 24/36px 后描边仍有 1.4px，这才是任务栏不糊的关键；
- ≥64px 完全按设计稿渲染（stroke 7.5，全细节），描边由矢量反解，不再栅格缩放；
- ≤48px 按尺寸补偿描边（目标 ≈5.8% 边长，下限 1px）。

注：设计稿 `LOGO.svg` 的 stroke-width = 7.5（视觉高 5.7%）；旧图标是从
`NGNlogo无底.png` 栅格导出后等比拉伸的，描边只有约 4.4%，比设计稿细两成。
本脚本统一按设计稿渲染 —— 应用图标与顶栏/启动幕里的 LOGO 因此同粗细。

小尺寸专用稿（可选，用户自绘）
------------------------------
主稿是线稿，缩到 ≤32px 时「X 眼 + 5 根胡须」物理上撑不住（一根胡须在 24px 下
只有 2.2px 长、1.1px 宽），程序化的按尺寸补偿只能把它们放大成点，**丢掉细节是
几何限制、不是渲染方法问题**。想让小尺寸保住角色辨识度，正解是**单独画一版
小尺寸稿**（各家平台图标规范都是这么要求的：大图追求细节、小图追求识别）。

脚本的接入约定 —— 存在下面任一文件即自动启用，**≤48px 全部改用它**（≥64px 仍用主稿）：

| 文件 | 说明 |
|---|---|
| `docs/design/svg/LOGO-small.svg`（优先） | 矢量小稿：**每个 `<path>` 的 `stroke-width` / `fill` 原样使用**（不再按尺寸补偿）；视觉外接框（含描边）等比缩放到图标的 60% 高 × 78% 宽以内、居中；颜色可显式写（`#fff` 白、`#ffa2b4` 品牌粉=挖空、`none` 不画）；建议只保留「头部轮廓 + 耳朵 + 圆点眼 + 每侧 2–3 根短胡须」 |
| `docs/design/png/LOGO-small.png` | 透明底白描边；按 alpha 包围盒裁剪后等比缩放到图标高 60%（不做描边补偿，请自行按 48px 观感绘制） |

> 为什么推荐 SVG 而不是 PNG：脚本要按 16/20/24/28/32/40/48 逐个尺寸栅格化，
> 矢量稿能给出每个尺寸的干净像素；PNG 只能再重采样一次，等于把「任务栏糊」
> 的老问题换个地方复发。若你更想逐尺寸手工点像素（16px 单独描一遍），
> 把 PNG 按尺寸命名（如 `LOGO-small-16.png`）告诉我，我再加多档覆盖。

渲染规则（两条稿都适用）
------------------------
- 每个子路径（M 起新段）按 `<path>` 的 fill/stroke 绘制；描边用「圆头圆角」：
  折线 + 每个顶点补圆点（PIL 的 line 只做斜接）；
- 颜色：**纯黑 / 未指定 → 白色前景**（主稿的描边是黑色、在应用里走 currentColor，
  图标里统一是白的）；其余颜色按字面用（如实心版挖空眼写 `#ffa2b4`）；
- 坐标系统无关，脚本按视觉外接框缩放，只关心形状与相对比例。

用法: python scripts/make_icons.py [--verify]
      --verify 额外打印 16/24/32/48 层的 ASCII 预览（无图形界面时自检用）
"""
from __future__ import annotations

import io
import re
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "docs" / "design" / "svg" / "LOGO.svg"
SMALL_SVG = ROOT / "docs" / "design" / "svg" / "LOGO-small.svg"
SMALL_PNG = ROOT / "docs" / "design" / "png" / "LOGO-small.png"
OUT = ROOT / "frontend" / "src-tauri" / "icons"

BG = (255, 162, 180, 255)      # 品牌粉 --c-primary #ffa2b4
FG = (255, 255, 255, 255)
RADIUS_RATIO = 0.22            # 圆角半径 / 边长（旧图标观感）
LOGO_H_RATIO = 0.60            # LOGO 视觉外接框高 / 边长（旧图标观感）
LOGO_W_RATIO = 0.78            # 视觉外接框宽上限 / 边长（胡须外扩时按宽收敛）
DESIGN_STROKE = 7.5            # 主稿 stroke-width 兜底值（优先读 SVG 属性）
SMALL_MAX = 48                 # ≤ 该尺寸可用小尺寸专用稿
MAX_CANVAS = 2048              # 超采样画布上限（1024 图标用 2× 即可）

# ICO 层顺序：首项 = Tauri 的 default_window_icon → tao 设为 ICON_SMALL
# → Win11 任务栏图标就是它。48px 简化加粗版缩到 24/36px 后描边仍 ≥1.4px。
ICO_SIZES = [48, 256, 128, 96, 64, 40, 32, 28, 24, 20, 16]
PNGS = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    # Windows 商店资源（tauri 打包非 MSIX 时用不到，保留以免缺文件）
    "StoreLogo.png": 50,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
}


# ── 路径解析（矢量 → 折线，只认绝对坐标 M/L/C）────────────────────────
def _flatten(d: str, curve_steps: int = 24) -> tuple[tuple[tuple[float, float], ...], ...]:
    tokens = re.findall(r"[MLCmlcZz]|-?\d*\.?\d+(?:e-?\d+)?", d)
    subs: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []
    cmd = None
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t.isalpha():
            cmd = t
            i += 1
            if cmd in "Zz":
                continue
        if cmd in ("M", "L"):
            x, y = float(tokens[i]), float(tokens[i + 1])
            i += 2
            if cmd == "M":
                if cur:
                    subs.append(cur)
                cur = [(x, y)]
            else:
                cur.append((x, y))
        elif cmd == "C":
            x1, y1, x2, y2, x3, y3 = (float(v) for v in tokens[i:i + 6])
            i += 6
            x0, y0 = cur[-1]
            for s in range(1, curve_steps + 1):
                u = s / curve_steps
                v = 1 - u
                cur.append((
                    v ** 3 * x0 + 3 * v ** 2 * u * x1 + 3 * v * u ** 2 * x2 + u ** 3 * x3,
                    v ** 3 * y0 + 3 * v ** 2 * u * y1 + 3 * v * u ** 2 * y2 + u ** 3 * y3,
                ))
            x, y = x3, y3
        else:
            raise SystemExit(f"不支持的路径指令: {cmd}")
    if cur:
        subs.append(cur)
    return tuple(tuple(s) for s in subs)


def _color(raw: str | None) -> tuple[int, int, int, int] | None:
    """SVG 颜色 → RGBA；'none'/空 → None。纯黑按「白色前景」处理（见模块注释）。"""
    if not raw or raw.strip() in ("none", "transparent"):
        return None
    s = raw.strip()
    if s.startswith("#"):
        h = s[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    elif s.startswith("rgb"):
        r, g, b = (int(v) for v in re.findall(r"\d+", s)[:3])
    else:
        return FG
    return FG if (r, g, b) == (0, 0, 0) else (r, g, b, 255)


@dataclass(frozen=True)
class Shape:
    """一条子路径 + 它的绘制参数。"""
    pts: tuple
    fill: tuple | None
    stroke: tuple | None
    stroke_w: float


@dataclass(frozen=True)
class Art:
    """一份矢量稿（折线化后）的几何信息。"""
    name: str
    shapes: tuple
    stroke: float          # 代表描边宽度（主稿按尺寸补偿用；小稿原样用）
    w: float               # 路径外接框（不含描边）
    h: float
    cx: float
    cy: float
    eyes: tuple = ()       # 简化版的圆点眼（仅主稿布局有意义）

    @classmethod
    def load(cls, path: Path, name: str) -> "Art":
        text = path.read_text(encoding="utf-8")
        root_tag = re.search(r"<svg\b([^>]*)>", text, re.S)
        root_attrs = root_tag.group(1) if root_tag else ""
        root_fill = re.search(r'\bfill="([^"]*)"', root_attrs)
        default_fill = _color(root_fill.group(1)) if root_fill else FG

        shapes: list[Shape] = []
        for attrs in re.findall(r"<path\b([^>]*?)/?>", text, re.S):
            dm = re.search(r'\sd="([^"]+)"', attrs)
            if not dm:
                continue
            fm = re.search(r'\bfill="([^"]*)"', attrs)
            sm = re.search(r'\bstroke="([^"]*)"', attrs)
            wm = re.search(r'\bstroke-width="([\d.]+)"', attrs)
            fill = _color(fm.group(1)) if fm else default_fill
            stroke = _color(sm.group(1)) if sm else None
            stroke_w = float(wm.group(1)) if wm else 0.0
            for pts in _flatten(dm.group(1)):
                shapes.append(Shape(pts, fill, stroke, stroke_w))

        if not shapes:
            raise SystemExit(f"{path} 里没找到可渲染的 path")

        xs = [p[0] for sh in shapes for p in sh.pts]
        ys = [p[1] for sh in shapes for p in sh.pts]

        subs = [sh.pts for sh in shapes]
        eyes: tuple = ()
        # 主稿布局：0=头部轮廓，1/2=右眼 X 两笔，6/7=左眼 X 两笔
        if len(subs) == 10:
            c = [(sum(p[0] for p in subs[i]) / len(subs[i]),
                  sum(p[1] for p in subs[i]) / len(subs[i])) for i in (1, 2, 6, 7)]
            eyes = (((c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2),
                    ((c[2][0] + c[3][0]) / 2, (c[2][1] + c[3][1]) / 2))

        strokes = [sh.stroke_w for sh in shapes if sh.stroke and sh.stroke_w > 0]
        return cls(
            name=name, shapes=tuple(shapes),
            # 代表描边 = 第一条描边路径的宽度（即轮廓线宽）：视觉外接框的
            # 外扩量按它算——眼点等「内部」元素的粗描边不该撑大外接框
            stroke=strokes[0] if strokes else DESIGN_STROKE,
            w=max(xs) - min(xs), h=max(ys) - min(ys),
            cx=(max(xs) + min(xs)) / 2, cy=(max(ys) + min(ys)) / 2,
            eyes=eyes,
        )


LOGO = Art.load(SVG, "LOGO.svg")
# 小尺寸专用稿（可选）：SVG 优先，PNG 兜底；都没有则用主稿的简化版
SMALL_ART = Art.load(SMALL_SVG, "LOGO-small.svg") if SMALL_SVG.exists() else None
SMALL_RASTER = SMALL_PNG if (SMALL_ART is None and SMALL_PNG.exists()) else None


# ── 渲染 ──────────────────────────────────────────────────────────────
def _stroke_for(size: int, target_px: float) -> float:
    """主稿：反解 stroke-width，让渲染后的描边像素宽 ≈ target_px（下限取设计值）。

    渲染描边 px = stroke * (0.6*size / (LOGO.h + stroke))，令其等于 target 解出上式。
    """
    denom = LOGO_H_RATIO * size - target_px
    if denom <= 0:
        return LOGO.stroke
    return max(LOGO.stroke, target_px * (LOGO.h + LOGO.stroke) / denom)


def layer_params(size: int) -> tuple[bool, float]:
    """(是否简化版, stroke-width)——仅描述主稿路径；小稿存在时另有分支。"""
    if size <= SMALL_MAX:
        return True, _stroke_for(size, max(1.0, 0.058 * size))
    return False, LOGO.stroke


def _supersample(size: int) -> int:
    return max(1, min(8, MAX_CANVAS // size))


def _fit_scale(art: Art, n: int, stroke: float) -> float:
    """视觉外接框（路径外接框 + 描边）在 n×n 画布内的缩放比：高 ≤60%、宽 ≤78%。"""
    return min(LOGO_H_RATIO * n / (art.h + stroke),
               LOGO_W_RATIO * n / (art.w + stroke))


def _vector_layer(size: int, art: Art, stroke_svg: float | None, simple: bool) -> Image.Image:
    """按矢量稿栅格化白猫层（超采样后缩回）。

    stroke_svg=None → 每个 `<path>` 用自己的 stroke-width（小稿约定）；
    否则整份稿统一用给定描边宽（主稿按尺寸补偿）。
    simple=True → 只画第一条子路径（头部轮廓）+ 圆点眼。
    """
    ss = _supersample(size)
    n = size * ss
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 缩放比以「稿子自身的视觉外接框」为准，避免逐条路径各自缩放
    ref_stroke = stroke_svg if stroke_svg is not None else art.stroke
    scale = _fit_scale(art, n, ref_stroke)
    cx = cy = n / 2

    def tx(p: tuple[float, float]) -> tuple[float, float]:
        return (cx + (p[0] - art.cx) * scale, cy + (p[1] - art.cy) * scale)

    for idx, sh in enumerate(art.shapes):
        if simple and idx != 0:
            continue
        pts = [tx(p) for p in sh.pts]
        if sh.fill and len(pts) > 2:
            draw.polygon(pts, fill=sh.fill)
        if sh.stroke:
            w_svg = sh.stroke_w if stroke_svg is None else stroke_svg
            if w_svg <= 0:
                continue
            w_px = max(1, round(w_svg * scale))
            r = w_svg * scale / 2
            if len(pts) > 1:
                draw.line(pts, fill=sh.stroke, width=w_px, joint="curve")
            # 每个顶点补圆点：round join + round cap（PIL 的 line 只做斜接）
            for px_, py_ in pts:
                draw.ellipse([px_ - r, py_ - r, px_ + r, py_ + r], fill=sh.stroke)

    if simple and art.eyes:
        eye_r = stroke_svg * 0.55 * scale if stroke_svg else art.stroke * 0.55 * scale
        for ex, ey in art.eyes:
            px_, py_ = tx((ex, ey))
            draw.ellipse([px_ - eye_r, py_ - eye_r, px_ + eye_r, py_ + eye_r], fill=FG)

    return img.resize((size, size), Image.LANCZOS) if ss > 1 else img


def _raster_layer(size: int) -> Image.Image:
    """按 PNG 小稿栅格化（alpha 包围盒裁剪 → 等比缩放到图标高 60% → 居中）。"""
    src = Image.open(SMALL_RASTER).convert("RGBA")
    bb = src.getchannel("A").getbbox()
    if bb:
        src = src.crop(bb)
    target_h = max(1, round(size * LOGO_H_RATIO))
    target_w = max(1, round(target_h * src.width / src.height))
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    logo = src.resize((target_w, target_h), Image.LANCZOS)
    layer.paste(logo, ((size - target_w) // 2, (size - target_h) // 2), logo)
    return layer


def make_icon(size: int, small_art: Art | None = None, use_small: bool = True) -> Image.Image:
    """品牌粉圆角底 + 白 LOGO（≤48px 若备了小尺寸稿则用它）。"""
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(base).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=max(2, round(size * RADIUS_RATIO)), fill=BG
    )

    small = small_art if small_art is not None else (SMALL_ART if use_small else None)
    if size <= SMALL_MAX:
        if small is not None:
            layer = _vector_layer(size, small, None, simple=False)
        elif use_small and SMALL_RASTER is not None:
            layer = _raster_layer(size)
        else:
            simple, stroke = layer_params(size)
            layer = _vector_layer(size, LOGO, stroke, simple)
    else:
        layer = _vector_layer(size, LOGO, LOGO.stroke, simple=False)

    return Image.alpha_composite(base, layer)


# ── 落盘 ──────────────────────────────────────────────────────────────
def _dib(im: Image.Image) -> bytes:
    """ICO 内的 DIB（BITMAPINFOHEADER + XOR + AND）；<64px 用它兼容性最好。"""
    w, h = im.size
    px = im.convert("RGBA").load()
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, w * h * 4, 0, 0, 0, 0)
    xor = bytearray()
    for y in range(h - 1, -1, -1):          # bottom-up
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))
    and_mask = bytes((((w + 31) // 32) * 4) * h)   # 32bpp 走 alpha，掩码全 0
    return header + bytes(xor) + and_mask


def _write_ico(path: Path, sizes: list[int]) -> None:
    """手写 ICO：目录顺序 = 给定顺序（PIL 的 ICO 写入会按尺寸升序重排，不能用）。"""
    blobs = []
    for size in sizes:
        im = make_icon(size)
        if size < 64:
            blobs.append(_dib(im))
        else:
            buf = io.BytesIO()
            im.save(buf, format="PNG", optimize=True)
            blobs.append(buf.getvalue())

    out = bytearray(struct.pack("<HHH", 0, 1, len(sizes)))
    offset = 6 + 16 * len(sizes)
    for size, blob in zip(sizes, blobs):
        dim = size if size < 256 else 0
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    out += b"".join(blobs)
    path.write_bytes(out)


def _ascii(size: int) -> None:
    px = make_icon(size).convert("RGBA").load()
    print(f"--- {size}x{size} ---")
    for y in range(size):
        line = ""
        for x in range(size):
            r, g, b, a = px[x, y]
            if a < 96:
                line += " "
            elif r > 225 and g > 225 and b > 225:
                line += "#"
            elif r > 225 and g < 215:
                line += "."
            else:
                line += "+"
        print(line)


def main() -> None:
    if not SVG.exists():
        raise SystemExit(f"未找到矢量主稿: {SVG}")
    OUT.mkdir(parents=True, exist_ok=True)

    if SMALL_ART is not None:
        print(f"[icons] 小尺寸专用稿启用（≤{SMALL_MAX}px）: {SMALL_SVG}")
    elif SMALL_RASTER is not None:
        print(f"[icons] 小尺寸专用稿启用（≤{SMALL_MAX}px）: {SMALL_PNG}")
    else:
        print(f"[icons] 未提供小尺寸稿，≤{SMALL_MAX}px 用主稿简化加粗版")

    for name, size in PNGS.items():
        make_icon(size).save(OUT / name, format="PNG", optimize=True)
        print(f"[icons] {name}  {size}×{size}")

    _write_ico(OUT / "icon.ico", ICO_SIZES)
    print(f"[icons] icon.ico  目录顺序（首项 = Tauri 窗口图标 → 任务栏）: {ICO_SIZES}")
    for size in ICO_SIZES:
        if size <= SMALL_MAX and (SMALL_ART is not None or SMALL_RASTER is not None):
            print(f"         {size:3d}px  小尺寸专用稿")
            continue
        simple, stroke = layer_params(size)
        px = stroke * LOGO_H_RATIO * size / (LOGO.h + stroke)
        print(f"         {size:3d}px  {'简化' if simple else '完整'}  "
              f"stroke-width={stroke:5.2f}  ≈{px:4.2f}px")

    try:
        make_icon(1024).save(OUT / "icon.icns", format="ICNS")
        print("[icons] icon.icns 1024（macOS）")
    except Exception as e:  # PIL 的 ICNS 插件对尺寸有要求，失败不影响 Windows 打包
        print(f"[icons] icon.icns 跳过：{e}")

    if "--verify" in sys.argv:
        print("\n=== ASCII 自检（# 白 / . 粉 / + 抗锯齿）===")
        for size in (16, 24, 32, 48):
            _ascii(size)


if __name__ == "__main__":
    main()
