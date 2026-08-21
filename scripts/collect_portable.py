"""组装便携版（免安装）：release 主程序 + onedir 后端目录打包为 zip。

用法: python scripts/collect_portable.py
产物: dist-portable/DDtoolkit/ 目录 与 DDtoolkit-portable-win64.zip
"""
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
RELEASE = FRONTEND / "src-tauri" / "target" / "release"
BACKEND_SRC = FRONTEND / "src-tauri" / "binaries" / "backend"

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
    backend_exe = BACKEND_SRC / "ddtoolkit-backend.exe"
    if not backend_exe.exists():
        raise SystemExit(f"[portable] 未找到后端目录 {BACKEND_SRC}，请先运行 npm run build:backend")

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True)

    shutil.copy2(app_exe, OUT_DIR / app_exe.name)
    # 后端目录整体拷贝，保持 binaries/backend 子路径
    # （运行时 resource_dir=exe 所在目录，与安装版布局一致）
    shutil.copytree(BACKEND_SRC, OUT_DIR / "binaries" / "backend")

    if ZIP_PATH.exists():
        ZIP_PATH.unlink()
    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(OUT_DIR.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(OUT_DIR.parent))

    size_mb = ZIP_PATH.stat().st_size / 1024 / 1024
    print(f"[portable] {ZIP_PATH}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
