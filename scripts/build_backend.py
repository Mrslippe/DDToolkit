"""打包桌面端后端为 Tauri sidecar 可执行文件（PyInstaller --onefile）。

用法:
    python scripts/build_backend.py

产物:
    frontend/src-tauri/binaries/ddtoolkit-backend-x86_64-pc-windows-msvc.exe
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME = "ddtoolkit-backend"
TRIPLE = "x86_64-pc-windows-msvc"
BINARIES = ROOT / "frontend" / "src-tauri" / "binaries"

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
           "--onefile", "--name", NAME,
           "--distpath", str(ROOT / "dist"),
           "--workpath", str(ROOT / "build"),
           "--specpath", str(ROOT / "scripts"),
           "--add-data", f"{ROOT / 'vtubers.csv'};."]
    for h in HIDDEN_IMPORTS:
        cmd += ["--hidden-import", h]
    cmd.append(str(ROOT / "backend_main.py"))

    print("[build]", " ".join(cmd))
    subprocess.run(cmd, cwd=ROOT, check=True)

    src = ROOT / "dist" / f"{NAME}.exe"
    BINARIES.mkdir(parents=True, exist_ok=True)
    dst = BINARIES / f"{NAME}-{TRIPLE}.exe"
    shutil.copy2(src, dst)
    size_mb = dst.stat().st_size / 1024 / 1024
    print(f"[build] sidecar -> {dst}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
