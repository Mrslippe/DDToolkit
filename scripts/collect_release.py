"""聚合发布产物到统一目录 dist-release/（安装包 + 便携版 + 主程序）。

用法: python scripts/collect_release.py [--with-main]
产物: dist-release/
  DDtoolkit-portable-win64.zip       便携版（免安装：主程序 + 后端目录）
  DDtoolkit_<version>_x64-setup.exe  NSIS 安装包（如已 tauri build）
  ddtoolkit.exe                      裸主程序（仅 --with-main）

前置: npm run build:backend 与 npm run tauri:build 已执行。
"""
import argparse
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
RELEASE = FRONTEND / "src-tauri" / "target" / "release"
BACKEND_SRC = FRONTEND / "src-tauri" / "binaries" / "backend"

OUT_DIR = ROOT / "dist-release"
ZIP_NAME = "DDtoolkit-portable-win64.zip"


def _find_app_exe() -> Path | None:
    for name in ("ddtoolkit.exe", "DDtoolkit.exe"):
        p = RELEASE / name
        if p.exists():
            return p
    return None


def _portable(work: Path) -> Path:
    """组装便携版目录（release 主程序 + 后端目录拷贝），返回 zip 路径。"""
    app_exe = _find_app_exe()
    if app_exe is None:
        raise SystemExit(f"[release] 未找到主程序（{RELEASE}），请先运行 npm run tauri:build")
    backend_exe = BACKEND_SRC / "ddtoolkit-backend.exe"
    if not backend_exe.exists():
        raise SystemExit(f"[release] 未找到后端目录 {BACKEND_SRC}，请先运行 npm run build:backend")

    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    shutil.copy2(app_exe, work / app_exe.name)
    shutil.copytree(BACKEND_SRC, work / "binaries" / "backend")

    zip_path = OUT_DIR / ZIP_NAME
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(work.rglob("*")):
            if f.is_file():
                # zip 内路径固定 DDtoolkit/...（解压后即便携目录）
                zf.write(f, Path("DDtoolkit") / f.relative_to(work))
    return zip_path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--with-main", action="store_true", help="同时复制裸主程序 ddtoolkit.exe 到输出目录")
    ap.add_argument(
        "--portable-only",
        action="store_true",
        help="只重建便携 zip（跳过安装包复制）——后端改动后的快速验证用，"
             "安装包仍由 npm run tauri:build 产出",
    )
    args = ap.parse_args()

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True)

    # 便携版
    work = OUT_DIR / "_portable_work"
    zip_path = _portable(work)
    shutil.rmtree(work, ignore_errors=True)
    size_mb = zip_path.stat().st_size / 1024 / 1024
    print(f"[release] 便携版 -> {zip_path.name}  ({size_mb:.1f} MB)")

    # NSIS 安装包（tauri build 产物）
    nsis_dir = RELEASE / "bundle" / "nsis"
    setups = sorted(nsis_dir.glob("*.exe")) if nsis_dir.exists() and not args.portable_only else []
    if setups:
        for s in setups:
            dst = OUT_DIR / s.name
            shutil.copy2(s, dst)
            print(f"[release] 安装包 -> {dst.name}  ({dst.stat().st_size / 1024 / 1024:.1f} MB)")
    elif not args.portable_only:
        print(f"[release] WARN: 未找到 NSIS 安装包（{nsis_dir}），跳过")
    else:
        print("[release] --portable-only：跳过安装包（旧安装包可能不含本次后端改动）")

    # 裸主程序（可选）
    if args.with_main:
        app_exe = _find_app_exe()
        if app_exe:
            dst = OUT_DIR / app_exe.name
            shutil.copy2(app_exe, dst)
            print(f"[release] 主程序 -> {dst.name}  ({dst.stat().st_size / 1024 / 1024:.1f} MB)")

    total = sum(f.stat().st_size for f in OUT_DIR.rglob("*") if f.is_file()) / 1024 / 1024
    print(f"[release] {OUT_DIR}  合计 {total:.1f} MB")


if __name__ == "__main__":
    main()
