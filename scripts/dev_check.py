"""开发态快速自检：不打包（或只重打后端）就能验证后端链路。

为什么需要它：打包版的问题往往只在「全新数据目录 / 冻结运行时」暴露，而
`npm run release` 一次要 4-6 分钟（PyInstaller + cargo + NSIS）。绝大多数
后端/登录/首启类改动用这个脚本秒级就能验完，只在改到 Rust / tauri.conf /
前端打包产物时才需要整包重建（见 docs/DEV-LOOP.md）。

用法:
    python scripts/dev_check.py             # 单测 + 开发态后端冒烟（秒级）
    python scripts/dev_check.py --docs      # 追加文档漂移门禁（devlog 索引/版本号/发布说明，只读）
    python scripts/dev_check.py --upstream  # 追加端到端上游冒烟（真打 B 站/danmakus，约 1 分钟）
    python scripts/dev_check.py --frozen    # 追加：冻结后端 exe 冒烟（先跑 build_backend.py）
    python scripts/dev_check.py --portable  # 追加：重打便携 zip（约 2 分钟，免 cargo/NSIS）
    python scripts/dev_check.py --full      # = 上面全部

冒烟内容（后端，空数据目录）：
    1) /healthz 就绪
    2) /auth/bilibili/qr/start 返回 qr_id + 扫码 URL
    3) 连续 2 次 /auth/bilibili/qr/check 必须停在 waiting
       —— 防「读外层 code 把未扫码误判为已确认」回归（2026-09-08 事故）
"""
import argparse
import ast
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
FROZEN_EXE = ROOT / "frontend" / "src-tauri" / "binaries" / "backend" / "ddtoolkit-backend.exe"

OK = "[ok]"
FAIL = "[FAIL]"
SKIP = "[skip]"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def project_python() -> str:
    """跑子步骤用的解释器：**优先项目 venv**（2026-09-25，devlog/197）。

    依赖的真源是 `uv.lock`，而"按锁装出来的环境"是仓库根的 `.venv`。用户完全可能用
    系统 Python 调本脚本（`python scripts/dev_check.py`）——那时 `sys.executable`
    指向**另一套版本**：轻则用错依赖跑测试，重则因缺包直接崩
    （实测缺 `python-multipart` 时 4 个测试文件收集失败）。有 `.venv` 就用它，
    没有就退回 `sys.executable`（不强迫每个人先装环境）。
    """
    venv_py = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return str(venv_py) if venv_py.exists() else sys.executable


PY = project_python()


def _http(method: str, url: str, timeout: float = 10.0):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        import json
        body = r.read().decode("utf-8", "replace")
        return r.status, (json.loads(body) if body.strip() else None)


def _run_pytest() -> bool:
    print(f"\n=== 1/3 单元测试（tests/，回归网） ===")
    rc = subprocess.run([PY, "-m", "pytest", "tests/", "-q", "-p", "no:cacheprovider"],
                        cwd=ROOT).returncode
    print(f"{OK if rc == 0 else FAIL} pytest rc={rc}")
    return rc == 0


def _run_frontend_check() -> bool:
    """前端三条：eslint（`--max-warnings 0`）+ vitest（纯函数单测）+ 日期区间断言。

    项目没有前端验证基建是长期缺口（`docs/FRONTEND-ARCH.md` §5 P3）；
    2026-09-13 起补了 vitest 与 eslint，这里把它们接进一键自检 —— 否则
    「加了检查但没人跑」等于没加（`test_version_synced_with_devlog` 曾长期红着
    就是同一类教训）。缺 node_modules 时不算失败（前端不是每次都要验），
    但要显式说明「没验」。
    """
    print(f"\n=== 前端静态与纯逻辑（eslint + vitest + 日期区间） ===")
    if not (FRONTEND / "node_modules").exists():
        print(f"{SKIP} frontend/node_modules 不存在：前端检查未运行（cd frontend && npm install）")
        return True
    npx = "npx.cmd" if os.name == "nt" else "npx"
    ok = True
    # eslint 用 `--max-warnings 0`：基线已清到 0 warning，新增即拦截
    # （规则集刻意只留"行为类"少数几条 + 5 处带理由的 disable，见 frontend/eslint.config.js）
    rc0 = subprocess.run([npx, "eslint", "src", "--max-warnings", "0"],
                         cwd=FRONTEND, shell=(os.name == "nt")).returncode
    print(f"{OK if rc0 == 0 else FAIL} eslint rc={rc0}")
    ok = ok and rc0 == 0
    rc = subprocess.run([npx, "vitest", "run"], cwd=FRONTEND, shell=(os.name == "nt")).returncode
    print(f"{OK if rc == 0 else FAIL} vitest rc={rc}")
    ok = ok and rc == 0
    rc2 = subprocess.run(["node", "scripts/check_date_range.mjs"], cwd=ROOT,
                         shell=(os.name == "nt")).returncode
    print(f"{OK if rc2 == 0 else FAIL} check_date_range rc={rc2}")
    return ok and rc2 == 0


def _smoke_backend(label: str, cmd: list[str], cwd: Path) -> bool:
    """空数据目录起后端 → healthz + 扫码轮询状态机。"""
    print(f"\n=== 后端冒烟：{label} ===")
    port = _free_port()
    # 数据目录放工作区内（受限沙箱下系统 temp 可能不可写）
    data_dir = ROOT / "_devcheck_tmp" / f"run-{int(time.time() * 1000)}"
    data_dir.mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "DDTOOLKIT_DATA_DIR": str(data_dir),
        "DDTOOLKIT_PORT": str(port),
        "DDTOOLKIT_PARENT_PID": "0",  # 无效 pid：不启用看门狗
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    log = open(data_dir / "console.log", "wb")
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    ok = False
    try:
        ready = False
        for _ in range(120):  # 最多 60s（首启要跑迁移）
            if proc.poll() is not None:
                break
            try:
                st, _ = _http("GET", f"{base}/healthz", timeout=3)
                if st == 200:
                    ready = True
                    break
            except Exception:
                pass
            time.sleep(0.5)
        if not ready:
            print(f"{FAIL} 后端未就绪（退出码={proc.poll()}，日志：{data_dir / 'console.log'}）")
            return False
        print(f"{OK} /healthz 就绪")

        try:
            _, start = _http("POST", f"{base}/auth/bilibili/qr/start", timeout=20)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            # 离线时**不能**当成通过：扫码状态机回归守卫（2026-09-08「读错 code 字段」
            # 事故的固化用例）恰恰是在这里验的，旧写法打印 [skip] 后 `ok = True`
            # 退出 0 —— 最需要它的场景里它不验却报通过（审计 2026-09-11）。
            print(f"{SKIP} 扫码链路需要访问 B 站，当前网络不可达：{e}")
            print(f"{SKIP} 本次**未验证** qr/start → qr/check 状态机，按失败计"
                  f"（不是「通过」，也不是「无结论」）")
            return False
        if not start or not start.get("qr_id"):
            print(f"{FAIL} qr/start 未返回 qr_id：{start}")
            return False
        print(f"{OK} qr/start → qr_id={start['qr_id'][:8]}…  url={str(start.get('url'))[:56]}…")

        for i in (1, 2):
            _, chk = _http("GET", f"{base}/auth/bilibili/qr/check?qr_id={start['qr_id']}", timeout=20)
            status = (chk or {}).get("status")
            if status != "waiting":
                print(f"{FAIL} 第 {i} 次 qr/check 应为 waiting，实得 {status!r} —— "
                      f"扫码状态判定回归（读错 code 字段？）")
                return False
            print(f"{OK} qr/check #{i} → waiting")
            time.sleep(1)
        ok = True
        return True
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        if ok:
            shutil.rmtree(data_dir, ignore_errors=True)   # 通过：不留痕
            try:
                data_dir.parent.rmdir()                   # 父目录空了也收掉
            except OSError:
                pass
        else:
            print(f"      现场保留：{data_dir}（console.log / logs/sidecar.log）")


def _run_syntax_check() -> bool:
    """全仓 Python 语法扫描（秒级，**默认就跑**）。

    为什么需要它（2026-09-16 实测踩到）：改 `scripts/ui_probe.py` 的一句 help 文案时，
    我在**双引号字符串里写了直引号**（`"隐藏后零请求"`）⇒ 那个脚本变成语法错误 ——
    而 pytest / tsc / eslint / doc_check **没有一个会编译 scripts/**，
    于是"探针脚本坏了"这件事在任何门禁里都不红，直到下次真要跑探针才发现。
    这类"工具坏了但没人报"正是仓库最忌讳的静默失败，所以用一次 ast.parse 全仓扫一遍。
    """
    print(f"\n=== 全仓 Python 语法（scripts / app / tests / 根） ===")
    root = Path(__file__).resolve().parent.parent
    bad: list[str] = []
    files: list[Path] = []
    for pat in ("scripts/*.py", "app/**/*.py", "tests/*.py", "*.py"):
        files += sorted(root.glob(pat))
    for p in files:
        try:
            ast.parse(p.read_text(encoding="utf-8"), filename=str(p))
        except SyntaxError as e:
            bad.append(f"{p.relative_to(root)}:{e.lineno}: {e.msg}")
    if bad:
        for line in bad:
            print(f"{FAIL} {line}")
        return False
    print(f"{OK} {len(files)} 个文件语法通过")
    return True


def _run_docs_check() -> bool:
    """文档漂移门禁（`scripts/doc_check.py`）：devlog 索引 / 六处版本号 / 发布说明与导航。

    加它的理由很具体：2026-09-15 实测「批次 → devlog 索引」缺了 082 与 084
    （两次都是写完 devlog 忘了回填），`docs/README.md` 的 releases 列表也漏了新版本 ——
    这些都不会让测试红，只会在几个月后想查"那版改了什么"时才发现查不到（devlog/085）。
    """
    print(f"\n=== 文档漂移（devlog 索引 / 版本号 / 发布说明） ===")
    rc = subprocess.run([PY, "scripts/doc_check.py"], cwd=ROOT).returncode
    print(f"{OK if rc == 0 else FAIL} doc_check rc={rc}")
    return rc == 0


def _run_upstream_smoke() -> bool:
    """端到端上游冒烟（`scripts/smoke_upstream.py`）：数据目录副本 + 真后端 + 真上游。

    只在这里（显式 `--upstream`）跑：它会打真上游（B 站检索/复核、danmakus 场次），
    属于"慢且依赖网络"的一类；跑完会打印每项的 ok/skip/FAIL 与原因。
    `--cold` 模式另跑一次（空数据目录 + 清空凭据），断言未登录时的降级形态。
    """
    print(f"\n=== 端到端上游冒烟（真上游；慢，约 1 分钟） ===")
    ok = True
    for extra, label in (([], "真上游"), (["--cold"], "冷进程")):
        rc = subprocess.run([PY, "scripts/smoke_upstream.py", *extra],
                            cwd=ROOT).returncode
        print(f"{OK if rc == 0 else FAIL} smoke_upstream {label} rc={rc}")
        ok = ok and rc == 0
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frozen", action="store_true", help="追加冻结后端 exe 冒烟")
    ap.add_argument("--portable", action="store_true", help="追加重打便携 zip（免 cargo/NSIS）")
    ap.add_argument("--docs", action="store_true", help="追加文档漂移门禁（秒级，只读）")
    ap.add_argument("--upstream", action="store_true",
                    help="追加端到端上游冒烟（真打 B 站/danmakus，约 1 分钟，含冷进程模式）")
    ap.add_argument("--full", action="store_true", help="= --frozen --portable --docs --upstream")
    # 单独暴露第 ① 步（devlog/199）：CI 需要在"还没装前端依赖、也没有浏览器"的 job 里
    # 跑这一步，而它是**唯一会编译 `scripts/`** 的门禁。让 CI 复用这个函数而不是在
    # workflow 里抄一段 `python -c`：抄一份就多一个漂移点（本仓 §0.4 的复述纪律）。
    ap.add_argument("--syntax-only", action="store_true",
                    help="只跑全仓语法扫描并退出（给 CI 用，秒级，不需要任何依赖）")
    args = ap.parse_args()
    if args.full:
        args.frozen = args.portable = args.docs = args.upstream = True
    if args.syntax_only:
        return 0 if _run_syntax_check() else 1

    results: list[tuple[str, bool]] = [("syntax", _run_syntax_check())]
    results.append(("pytest", _run_pytest()))
    results.append(("frontend logic", _run_frontend_check()))
    if args.docs:
        results.append(("docs drift", _run_docs_check()))
    if args.upstream:
        results.append(("upstream smoke", _run_upstream_smoke()))

    print("\n=== 2/3 开发态后端冒烟（源码，秒级） ===")
    results.append(("dev backend", _smoke_backend(
        "python backend_main.py", [PY, "backend_main.py"], ROOT)))

    if args.frozen:
        if FROZEN_EXE.exists():
            results.append(("frozen backend", _smoke_backend(
                "ddtoolkit-backend.exe", [str(FROZEN_EXE)], FROZEN_EXE.parent)))
        else:
            print(f"{SKIP} 未找到冻结后端（{FROZEN_EXE}），先跑 python scripts/build_backend.py")
            results.append(("frozen backend", False))
    else:
        print(f"\n{SKIP} --frozen 未启用：跳过冻结后端冒烟（改动涉及打包才需要）")

    if args.portable:
        print("\n=== 3/3 重打便携 zip（免 cargo/NSIS） ===")
        rc1 = subprocess.run([PY, "scripts/build_backend.py"], cwd=ROOT).returncode
        rc2 = subprocess.run(
            [PY, "scripts/collect_release.py", "--portable-only"], cwd=ROOT
        ).returncode if rc1 == 0 else 1
        results.append(("portable zip", rc1 == 0 and rc2 == 0))
    else:
        print(f"\n{SKIP} --portable 未启用：跳过便携 zip 重打")

    print("\n=== 汇总 ===")
    for name, ok in results:
        print(f"  {OK if ok else FAIL} {name}")
    bad = [n for n, ok in results if not ok]
    print("\n全部通过" if not bad else f"\n失败：{', '.join(bad)}")
    return 0 if not bad else 1


if __name__ == "__main__":
    raise SystemExit(main())
