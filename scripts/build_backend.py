"""打包桌面端后端为 Tauri 资源目录（PyInstaller --onedir）。

onedir 相比 onefile：免去每次启动解压 %TEMP% 的开销（冷启动 2-4s → <0.5s），
杀软误报率也更低；代价是分发形态为目录，由 Tauri resources 机制整体打包。

用法:
    uv sync              # 先按 uv.lock 把环境装好（唯一真源）
    python scripts/build_backend.py

产物:
    frontend/src-tauri/binaries/backend/   （ddtoolkit-backend.exe + _internal/）
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME = "ddtoolkit-backend"
BINARIES = ROOT / "frontend" / "src-tauri" / "binaries"
BACKEND_DIR = BINARIES / "backend"

# ── 环境守卫（2026-09-25，devlog/197）──────────────────────────────────────
# 为什么需要它：本脚本**不安装任何依赖**，它用"当前解释器里装了什么"去冻结产物。
# 于是在迁移到 uv.lock 之前，`requirements.txt` 只写着 `>=` ⇒ 冻结出来的 exe
# 装的是"跑构建那天的版本"，**发布产物不可复现**。
# 现在：环境必须由 `uv sync` 按 uv.lock 装出（即仓库根 `.venv`），否则直接停。
#
# ⚠️ 为什么"直接停"而不是警告一下：本仓的实测口径是「能写成机器判据的就别写成散文」
#    （`docs/DEV-LOOP.md` §0.1），而"警告"在这种场景下等于没有——见 `docs/ARCHITECTURE.md`
#    §6 第 22 条那类"判据看起来在工作却永不命中"的事故。修复只有一条命令，成本可忽略。
LOCK_FILE = ROOT / "uv.lock"
VENV_DIR = ROOT / ".venv"


def _find_uv() -> list[str] | None:
    """找到能跑 `uv` 的命令行。

    ⚠️ 不能写 `sys.executable -m uv`（第一版就踩了）：**venv 里没有 uv** ——
    uv 是"装环境的工具"，它自己在哪个解释器里无所谓。这里按 ① PATH 上的 uv 可执行文件
    ② 宿主解释器（`VIRTUAL_ENV` 的父进程惯例 / 默认 python）能不能 `-m uv` 依次找。
    都找不到就返回 None：**那是环境问题，不是产物问题**，不该拦住构建。
    """
    exe = shutil.which("uv")
    if exe:
        return [exe]
    for py in (os.environ.get("DDTOOLKIT_UV_PYTHON"), "python"):
        if not py:
            continue
        try:
            probe = subprocess.run([py, "-m", "uv", "--version"],
                                   capture_output=True, text=True, timeout=30)
            if probe.returncode == 0:
                return [py, "-m", "uv"]
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def _assert_locked_environment() -> None:
    """构建必须跑在 `uv sync` 装出来的环境里，否则停手并打印修复命令。"""
    if not LOCK_FILE.exists():
        raise SystemExit(
            f"[build] 找不到 {LOCK_FILE.name} —— 依赖来源的真源是 uv.lock（pyproject.toml 是它的输入）。\n"
            f"        先跑：uv lock && uv sync")

    running = Path(sys.prefix).resolve()
    expected = VENV_DIR.resolve()
    if running != expected:
        raise SystemExit(
            "[build] 拒绝在**非锁环境**里冻结后端 —— 那样打出来的 exe 不可复现。\n"
            f"        当前解释器：{sys.executable}\n"
            f"        期望环境：  {expected}（由 uv sync 按 uv.lock 装出）\n"
            f"        修复：      uv sync\n"
            f"        然后用：    {expected / 'Scripts' / 'python.exe'} scripts/build_backend.py")

    # 环境对了还不够：**锁文件必须没被本地改动偷偷绕过**（例如有人手 pip install 了别的版本）。
    # 用 `uv sync --frozen --dry-run` 问一句"这个环境与锁文件一致吗"，不一致就停。
    uv = _find_uv()
    if uv is None:
        print("[build] 提示：环境里找不到 uv，跳过「环境与锁文件一致」的复核"
              "（prefix 已确认是 .venv；如需复核请把 uv 放上 PATH）")
    else:
        r = subprocess.run([*uv, "sync", "--frozen", "--dry-run"],
                           cwd=ROOT, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise SystemExit(
                "[build] `uv sync --frozen --dry-run` 失败 —— 锁文件与环境或平台不匹配：\n"
                + (r.stdout or "") + (r.stderr or ""))
        # uv 把"需要装/卸什么"打在 stderr（进度类输出也走 stderr），所以判据取两者的并集：
        # 出现 `+ pkg` 或 `- pkg` 就说明环境与锁文件不一致。
        combined = (r.stdout or "") + (r.stderr or "")
        drift = [ln.strip() for ln in combined.splitlines()
                 if ln.strip().startswith(("+ ", "- "))]
        if drift:
            raise SystemExit(
                "[build] 环境与 uv.lock 不一致（下面这些包会被增删）：\n"
                + "\n".join("        " + d for d in drift)
                + "\n        修复：uv sync")

    # PyInstaller 住在 `build` 依赖组里，而 **`uv sync` 默认只装 `dev`** —— 所以
    # "刚 sync 完"的开发机通常没有它。这里**按锁文件自动补装那一个组**，而不是让人记住
    # `uv sync --group build`：本仓的操作习惯是"一条命令跑通"（`release.py` / `dev_check.py`），
    # 多一个必须记住的开关就会在下次换机器时变成一道坑。
    if subprocess.run([sys.executable, "-c", "import PyInstaller"],
                      capture_output=True).returncode != 0:
        if uv is None:
            raise SystemExit(
                "[build] 当前环境没有 PyInstaller，且找不到 uv 无法自动补装。\n"
                "        手动：uv sync --group build")
        print("[build] 环境缺 PyInstaller（在 build 组里），按 uv.lock 补装…")
        r = subprocess.run([*uv, "sync", "--frozen", "--group", "build"],
                           cwd=ROOT, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise SystemExit("[build] 补装 build 组失败：\n" + (r.stdout or "") + (r.stderr or ""))
        if subprocess.run([sys.executable, "-c", "import PyInstaller"],
                          capture_output=True).returncode != 0:
            raise SystemExit(
                "[build] 补装后仍导入不到 PyInstaller —— 锁文件里没有它？查 pyproject.toml 的 build 组。")


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
    # 词云分词（devlog/061）：jieba 是延迟导入的（不进冷启动关键路径），
    # PyInstaller 的静态分析看不到它 → 必须显式声明，否则冻结版一用词云就 ImportError。
    # 它的词典数据（dict.txt，约 5MB）由 PyInstaller 的 jieba hook 自动带上；
    # 若某次打包后兜底成了 regex 引擎，先查这里（/v3 wordcloud 会照常工作，只是精度下降）。
    "jieba",
]


def main() -> None:
    _assert_locked_environment()
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
