"""从用户设计 LOGO 生成桌面端图标（窗口 / 任务栏 / 安装包 / 商店资源）。

源（用户设计，`docs/design/`）：
- `svg/LOGO.svg`     矢量源（改动以它为准；前端顶栏/启动幕内联同一路径）
- `png/NGNlogo无底.png` 白色描边 + 透明底（1040×1024），本脚本据此栅格化
- `png/LOGO-black.png`  黑色描边版（备用）

输出：`frontend/src-tauri/icons/`
- 品牌粉圆角底 + 白色猫脸（与替换前的「粉底 + 白圆 + 粉 D」同语言，任何任务栏底色下都可见）
- `icon.ico`（16/24/32/48/64/128/256 多尺寸）、`icon.png`(512)、32/64/128/128@2x
- Windows 商店 Square*Logo.png / StoreLogo.png；`icon.icns`（macOS，失败则跳过）

用法: python scripts/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "design" / "png" / "NGNlogo无底.png"
OUT = ROOT / "frontend" / "src-tauri" / "icons"

BG = (255, 162, 180, 255)      # 品牌粉 --c-primary #ffa2b4
RADIUS_RATIO = 0.22            # 圆角半径 / 边长（旧图标观感）
LOGO_H_RATIO = 0.60            # LOGO 高 / 边长
ASPECT = 167.087 / 131.01      # 矢量 viewBox 宽高比


def _logo_layer(size: int) -> Image.Image:
    """白色 LOGO 栅格层：按 alpha 包围盒裁剪后等比缩放居中。"""
    src = Image.open(SRC).convert("RGBA")
    bbox = src.getchannel("A").getbbox()
    if bbox:
        src = src.crop(bbox)
    target_h = max(1, round(size * LOGO_H_RATIO))
    target_w = max(1, round(target_h * ASPECT))
    logo = src.resize((target_w, target_h), Image.LANCZOS)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.paste(logo, ((size - target_w) // 2, (size - target_h) // 2), logo)
    return layer


def make_icon(size: int) -> Image.Image:
    """品牌粉圆角底 + 白 LOGO。"""
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(base)
    draw.rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=max(2, round(size * RADIUS_RATIO)), fill=BG
    )
    return Image.alpha_composite(base, _logo_layer(size))


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

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"未找到源 LOGO: {SRC}")
    OUT.mkdir(parents=True, exist_ok=True)

    for name, size in PNGS.items():
        make_icon(size).save(OUT / name, format="PNG", optimize=True)
        print(f"[icons] {name}  {size}×{size}")

    # 多尺寸 ICO（Tauri/NSIS 窗口与安装包图标）
    ico_frames = [make_icon(s) for s in ICO_SIZES]
    ico_frames[-1].save(
        OUT / "icon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES]
    )
    print(f"[icons] icon.ico  {ICO_SIZES}")

    try:
        make_icon(1024).save(OUT / "icon.icns", format="ICNS")
        print("[icons] icon.icns 1024（macOS）")
    except Exception as e:  # PIL 的 ICNS 插件对尺寸有要求，失败不影响 Windows 打包
        print(f"[icons] icon.icns 跳过：{e}")


if __name__ == "__main__":
    main()
