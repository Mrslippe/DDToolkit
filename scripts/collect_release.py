"""聚合发布产物到统一目录 dist-release/（安装包 + 便携版 + 主程序 + 应用内更新产物）。

用法: python scripts/collect_release.py [--with-main]
产物: dist-release/
  DDtoolkit-portable-win64.zip            便携版（免安装：主程序 + 后端目录）
  DDtoolkit_<version>_x64-setup.exe       NSIS 安装包（如已 tauri build）
  DDtoolkit_<version>_x64-setup.nsis.zip  **应用内更新的载体**（R23；updater 下载这个）
  latest.json                             **更新清单**（版本/说明/平台资产 url + 签名）
  ddtoolkit.exe                           裸主程序（仅 --with-main）

前置: npm run build:backend 与 npm run tauri:build 已执行。
注意: `latest.json` 里的 `url` 指向 GitHub Release 的资产地址，所以**必须先有 tag**（`v<version>`）；
      签名取自 tauri 产出的 `.sig`（`bundle.createUpdaterArtifacts = true` 才会有）。
"""
import argparse
import datetime as _dt
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
RELEASE = FRONTEND / "src-tauri" / "target" / "release"
BACKEND_SRC = FRONTEND / "src-tauri" / "binaries" / "backend"

OUT_DIR = ROOT / "dist-release"
ZIP_NAME = "DDtoolkit-portable-win64.zip"
REPO = "Mrslippe/DDToolkit"
# `latest.json` 的说明字段：发布说明动辄几千字，更新器弹窗里只要开头一段
NOTES_LIMIT = 1200


def _find_app_exe() -> Path | None:
    for name in ("ddtoolkit.exe", "DDtoolkit.exe"):
        p = RELEASE / name
        if p.exists():
            return p
    return None


def _version() -> str:
    """版本号真源 = `frontend/package.json`（与 tauri.conf.json 六处同步，见 RELEASE.md §2）。"""
    data = json.loads((FRONTEND / "package.json").read_text(encoding="utf-8"))
    return str(data["version"])


def latest_json(version: str, notes: str, signature: str, zip_name: str,
                pub_date: str | None = None, repo: str = REPO) -> dict:
    """生成 updater 的清单（纯函数，便于用例覆盖 —— 它的字段名写错更新就会静默失效）。

    契约（Tauri v2 updater）：`version` 必须**大于**当前版本才会提示；`platforms` 的键是
    `windows-x86_64`；每项要 `signature`（`.sig` 全文）与 `url`（可直接下载的资产地址）。
    URL 走 `releases/download/v<版本>/<资产名>`（**不是** `latest/download`）——
    否则用户会拿到"最新版"的资产却配上旧版本的签名，校验必失败。
    """
    if not signature.strip():
        raise ValueError("签名为空：更新包没签名就等于没更新（updater 会拒绝）")
    body = notes.strip()
    if len(body) > NOTES_LIMIT:
        body = body[:NOTES_LIMIT].rstrip() + "\n\n……（完整说明见发布页）"
    return {
        "version": version,
        "notes": body,
        "pub_date": pub_date or _dt.datetime.now(_dt.timezone.utc)
        .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "platforms": {
            "windows-x86_64": {
                "signature": signature.strip(),
                "url": f"https://github.com/{repo}/releases/download/v{version}/{zip_name}",
            }
        },
    }


def _collect_updater(version: str) -> Path | None:
    """把 `bundle/nsis/*.nsis.zip` + `.sig` 收进输出目录，并写 `latest.json`。"""
    nsis_dir = RELEASE / "bundle" / "nsis"
    if not nsis_dir.exists():
        print(f"[release] WARN: 没有 {nsis_dir}（更新产物缺失：bundle.createUpdaterArtifacts 没开？）")
        return None
    zips = sorted(nsis_dir.glob("*.nsis.zip"))
    if not zips:
        print("[release] WARN: 没找到 *.nsis.zip —— 应用内更新会拿不到包（旧版本仍可手工下载安装）")
        return None
    src = zips[-1]
    sig = src.with_name(src.name + ".sig")
    if not sig.exists():
        print(f"[release] WARN: 缺少签名 {sig.name} —— 更新包无法被校验，跳过 latest.json")
        return None

    dst_zip = OUT_DIR / src.name
    shutil.copy2(src, dst_zip)
    print(f"[release] 更新包 -> {dst_zip.name}  ({dst_zip.stat().st_size / 1024 / 1024:.1f} MB)")

    notes_path = ROOT / "docs" / "releases" / f"v{version}.md"
    notes = notes_path.read_text(encoding="utf-8") if notes_path.exists() else f"DDtoolkit v{version}"
    payload = latest_json(version, notes, sig.read_text(encoding="utf-8"), src.name)
    out = OUT_DIR / "latest.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[release] 更新清单 -> latest.json  (version={payload['version']} · "
          f"签名 {len(payload['platforms']['windows-x86_64']['signature'])} 字符)")
    return out


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
