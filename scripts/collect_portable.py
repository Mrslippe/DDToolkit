"""组装便携版（免安装）：release 主程序 + 后端 sidecar 打包为 zip。

用法: python scripts/collect_portable.py
产物: dist-portable/DDtoolkit/ 目录 与 DDtoolkit-portable-win64.zip
"""
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
RELEASE = FRONTEND / "src-tauri" / "target" / "release"
SIDECAR_SRC = FRONTEND / "src-tauri" / "binaries" / "ddtoolkit-backend-x86_64-pc-windows-msvc.exe"

OUT_DIR = ROOT / "dist-portable" / "DDtoolkit"
ZIP_PATH = ROOT / "dist-portable" / "DDtoolkit-portable-win64.zip"


def _find_app_exe() -> Path | None:
    for name in ("ddtoolkit.exe", "DDtoolkit.exe"):
        p = RELEASE / name
        if p.exists():
            return p
    return None


def main() -> None:
    app_exe = _find_app_exe()
    if app_exe is None:
        raise SystemExit(f"[portable] 未找到主程序（{RELEASE}），请先运行 tauri build")
    if not SIDECAR_SRC.exists():
        raise SystemExit(f"[portable] 未找到后端 {SIDECAR_SRC}，请先运行 npm run build:backend")

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True)

    shutil.copy2(app_exe, OUT_DIR / app_exe.name)
    # 关键：运行时 shell 插件按「主程序旁的无后缀名」解析 sidecar，
    # 必须去掉 target-triple 后缀（NSIS 安装包由 bundler 自动完成此改名）
    shutil.copy2(SIDECAR_SRC, OUT_DIR / "ddtoolkit-backend.exe")

    if ZIP_PATH.exists():
        ZIP_PATH.unlink()
    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in OUT_DIR.iterdir():
            zf.write(f, f"DDtoolkit/{f.name}")

    size_mb = ZIP_PATH.stat().st_size / 1024 / 1024
    print(f"[portable] {ZIP_PATH}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
