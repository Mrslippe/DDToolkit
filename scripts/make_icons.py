"""从用户设计 LOGO 生成桌面端图标（窗口 / 任务栏 / 安装包 / 商店资源）。

源（用户设计，`docs/design/`）：
- `svg/LOGO.svg`  矢量源（唯一真源；前端顶栏/启动幕内联同一路径）
- `png/NGNlogo无底.png` 早期栅格导出（白描边 + 透明底），保留备查，本脚本不再使用

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
- ≤48px 按尺寸补偿描边（目标 ≈5.8% 边长，下限 1px），≤28px 天然不含胡须。

注：设计稿 `LOGO.svg` 的 stroke-width = 7.5（视觉高 5.7%）；旧图标是从
`NGNlogo无底.png` 栅格导出后等比拉伸的，描边只有约 4.4%，比设计稿细两成。
本脚本统一按设计稿渲染 —— 应用图标与顶栏/启动幕里的 LOGO 因此同粗细。

用法: python scripts/make_icons.py [--verify]
      --verify 额外打印 16/24/32/48 层的 ASCII 预览（无图形界面时自检用）
"""
from __future__ import annotations

import io
import re
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "docs" / "design" / "svg" / "LOGO.svg"
OUT = ROOT / "frontend" / "src-tauri" / "icons"

BG = (255, 162, 180, 255)      # 品牌粉 --c-primary #ffa2b4
FG = (255, 255, 255, 255)
RADIUS_RATIO = 0.22            # 圆角半径 / 边长（旧图标观感）
LOGO_H_RATIO = 0.60            # LOGO 视觉外接框高 / 边长（旧图标观感）
DESIGN_STROKE = 7.5            # 设计稿 stroke-width（viewBox 单位）
MAX_CANVAS = 2048              # 超采样画布上限（1024 图标用 2× 即可）

# 子路径下标（见 LOGO.svg 的 d）：0=头部轮廓，1/2=右眼（X 两笔），
# 3/4/5=右胡须，6/7=左眼，8/9=左胡须。简化版只保留 0 + 两个圆点眼。

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
def _load_d() -> str:
    m = re.search(r'\sd="([^"]+)"', SVG.read_text(encoding="utf-8"))
    if not m:
        raise SystemExit(f"未在 {SVG} 找到 path d 属性")
    return m.group(1)


def _flatten(d: str, curve_steps: int = 24) -> list[list[tuple[float, float]]]:
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
    return subs


SUBS = _flatten(_load_d())
if len(SUBS) != 10:
    raise SystemExit(f"LOGO.svg 子路径数变了（{len(SUBS)}），请复核简化版下标假设")

_XS = [p[0] for sub in SUBS for p in sub]
_YS = [p[1] for sub in SUBS for p in sub]
PATH_W = max(_XS) - min(_XS)
PATH_H = max(_YS) - min(_YS)
PATH_CX = (max(_XS) + min(_XS)) / 2
PATH_CY = (max(_YS) + min(_YS)) / 2

# 眼球中心（简化版的圆点眼）：左右眼各由两笔 X 组成，取四笔中点
_EYE_PTS = [(sum(p[0] for p in SUBS[i]) / len(SUBS[i]),
             sum(p[1] for p in SUBS[i]) / len(SUBS[i])) for i in (1, 2, 6, 7)]
EYES = [((_EYE_PTS[0][0] + _EYE_PTS[1][0]) / 2, (_EYE_PTS[0][1] + _EYE_PTS[1][1]) / 2),
        ((_EYE_PTS[2][0] + _EYE_PTS[3][0]) / 2, (_EYE_PTS[2][1] + _EYE_PTS[3][1]) / 2)]


# ── 渲染 ──────────────────────────────────────────────────────────────
def _stroke_for(size: int, target_px: float) -> float:
    """反解 stroke-width：让渲染后的描边像素宽 ≈ target_px（下限取设计值）。"""
    denom = LOGO_H_RATIO * size - target_px
    if denom <= 0:
        return DESIGN_STROKE
    return max(DESIGN_STROKE, target_px * (PATH_H + DESIGN_STROKE) / denom)


def layer_params(size: int) -> tuple[bool, float]:
    """(是否简化版, stroke-width)。≤48px 用简化加粗版，≥64px 按设计稿。"""
    if size <= 48:
        return True, _stroke_for(size, max(1.0, 0.058 * size))
    return False, DESIGN_STROKE


def _logo_layer(size: int, stroke_svg: float, simple: bool) -> Image.Image:
    """白猫栅格层：视觉外接框高 = LOGO_H_RATIO*size，居中（超采样后缩回）。"""
    ss = max(1, min(8, MAX_CANVAS // size))
    n = size * ss
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    scale = LOGO_H_RATIO * n / (PATH_H + stroke_svg)
    w_px = max(1, round(stroke_svg * scale))
    r = stroke_svg * scale / 2
    cx = cy = n / 2

    def tx(p: tuple[float, float]) -> tuple[float, float]:
        return (cx + (p[0] - PATH_CX) * scale, cy + (p[1] - PATH_CY) * scale)

    for idx, sub in enumerate(SUBS):
        if simple and idx != 0:          # 简化版只画头部轮廓
            continue
        pts = [tx(p) for p in sub]
        if len(pts) > 1:
            draw.line(pts, fill=FG, width=w_px, joint="curve")
        # 每个顶点补圆点：round join + round cap（PIL 的 line 只做斜接）
        for px_, py_ in pts:
            draw.ellipse([px_ - r, py_ - r, px_ + r, py_ + r], fill=FG)

    if simple:
        eye_r = stroke_svg * 0.55 * scale
        for ex, ey in EYES:
            px_, py_ = tx((ex, ey))
            draw.ellipse([px_ - eye_r, py_ - eye_r, px_ + eye_r, py_ + eye_r], fill=FG)

    return img.resize((size, size), Image.LANCZOS) if ss > 1 else img


def make_icon(size: int) -> Image.Image:
    """品牌粉圆角底 + 白 LOGO（描边按尺寸补偿）。"""
    simple, stroke = layer_params(size)
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(base).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=max(2, round(size * RADIUS_RATIO)), fill=BG
    )
    return Image.alpha_composite(base, _logo_layer(size, stroke, simple))


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
        raise SystemExit(f"未找到矢量源: {SVG}")
    OUT.mkdir(parents=True, exist_ok=True)

    for name, size in PNGS.items():
        make_icon(size).save(OUT / name, format="PNG", optimize=True)
        print(f"[icons] {name}  {size}×{size}")

    _write_ico(OUT / "icon.ico", ICO_SIZES)
    print(f"[icons] icon.ico  目录顺序（首项 = Tauri 窗口图标 → 任务栏）: {ICO_SIZES}")
    for size in ICO_SIZES:
        simple, stroke = layer_params(size)
        px = stroke * LOGO_H_RATIO * size / (PATH_H + stroke)
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
