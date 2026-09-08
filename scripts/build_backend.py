"""打包桌面端后端为 Tauri 资源目录（PyInstaller --onedir）。

onedir 相比 onefile：免去每次启动解压 %TEMP% 的开销（冷启动 2-4s → <0.5s），
杀软误报率也更低；代价是分发形态为目录，由 Tauri resources 机制整体打包。

用法:
    python scripts/build_backend.py

产物:
    frontend/src-tauri/binaries/backend/   （ddtoolkit-backend.exe + _internal/）
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME = "ddtoolkit-backend"
BINARIES = ROOT / "frontend" / "src-tauri" / "binaries"
BACKEND_DIR = BINARIES / "backend"

# uvicorn 运行时按字符串动态导入 loop/protocol 实现，需显式声明
HIDDEN_IMPORTS = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
]


def main() -> None:
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
           "--onedir", "--name", NAME,
           "--distpath", str(ROOT / "dist"),
           "--workpath", str(ROOT / "build"),
           "--specpath", str(ROOT / "scripts"),
           "--add-data", f"{ROOT / 'vtubers.csv'};.",
           # alembic 迁移脚本/配置：frozen 后 PROJECT_ROOT=_MEIPASS，运行期按此加载
           "--add-data", f"{ROOT / 'alembic'};alembic",
           "--add-data", f"{ROOT / 'alembic.ini'};."]
    for h in HIDDEN_IMPORTS:
        cmd += ["--hidden-import", h]
    cmd.append(str(ROOT / "backend_main.py"))

    print("[build]", " ".join(cmd))
    subprocess.run(cmd, cwd=ROOT, check=True)

    # 整目录搬运（exe + _internal/ 依赖），Tauri resources 按此路径整体打包
    src_dir = ROOT / "dist" / NAME
    if not (src_dir / f"{NAME}.exe").exists():
        raise SystemExit(f"[build] 未找到 onedir 产物: {src_dir}")
    if BACKEND_DIR.exists():
        shutil.rmtree(BACKEND_DIR)
    shutil.copytree(src_dir, BACKEND_DIR)
    size_mb = sum(f.stat().st_size for f in BACKEND_DIR.rglob("*")) / 1024 / 1024
    print(f"[build] backend dir -> {BACKEND_DIR}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
