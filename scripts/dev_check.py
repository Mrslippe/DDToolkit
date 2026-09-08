"""开发态快速自检：不打包（或只重打后端）就能验证后端链路。

为什么需要它：打包版的问题往往只在「全新数据目录 / 冻结运行时」暴露，而
`npm run release` 一次要 4-6 分钟（PyInstaller + cargo + NSIS）。绝大多数
后端/登录/首启类改动用这个脚本秒级就能验完，只在改到 Rust / tauri.conf /
前端打包产物时才需要整包重建（见 docs/DEV-LOOP.md）。

用法:
    python scripts/dev_check.py            # 单测 + 开发态后端冒烟（秒级）
    python scripts/dev_check.py --frozen   # 追加：冻结后端 exe 冒烟（先跑 build_backend.py）
    python scripts/dev_check.py --portable # 追加：重打便携 zip（约 2 分钟，免 cargo/NSIS）
    python scripts/dev_check.py --full     # = --frozen --portable

冒烟内容（后端，空数据目录）：
    1) /healthz 就绪
    2) /auth/bilibili/qr/start 返回 qr_id + 扫码 URL
    3) 连续 2 次 /auth/bilibili/qr/check 必须停在 waiting
       —— 防「读外层 code 把未扫码误判为已确认」回归（2026-09-08 事故）
"""
import argparse
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
FROZEN_EXE = ROOT / "frontend" / "src-tauri" / "binaries" / "backend" / "ddtoolkit-backend.exe"

OK = "[ok]"
FAIL = "[FAIL]"
SKIP = "[skip]"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _http(method: str, url: str, timeout: float = 10.0):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        import json
        body = r.read().decode("utf-8", "replace")
        return r.status, (json.loads(body) if body.strip() else None)


def _run_pytest() -> bool:
    print(f"\n=== 1/3 单元测试（tests/，回归网） ===")
    rc = subprocess.run([sys.executable, "-m", "pytest", "tests/", "-q"], cwd=ROOT).returncode
    print(f"{OK if rc == 0 else FAIL} pytest rc={rc}")
    return rc == 0


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
            print(f"{SKIP} 扫码链路需要访问 B 站，当前网络不可达：{e}")
            ok = True
            return True
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frozen", action="store_true", help="追加冻结后端 exe 冒烟")
    ap.add_argument("--portable", action="store_true", help="追加重打便携 zip（免 cargo/NSIS）")
    ap.add_argument("--full", action="store_true", help="= --frozen --portable")
    args = ap.parse_args()
    if args.full:
        args.frozen = args.portable = True

    results: list[tuple[str, bool]] = [("pytest", _run_pytest())]

    print("\n=== 2/3 开发态后端冒烟（源码，秒级） ===")
    results.append(("dev backend", _smoke_backend(
        "python backend_main.py", [sys.executable, "backend_main.py"], ROOT)))

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
        rc1 = subprocess.run([sys.executable, "scripts/build_backend.py"], cwd=ROOT).returncode
        rc2 = subprocess.run(
            [sys.executable, "scripts/collect_release.py", "--portable-only"], cwd=ROOT
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
