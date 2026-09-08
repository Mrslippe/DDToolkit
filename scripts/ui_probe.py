"""UI 布局探针（机器可验证的布局回归）。

配合 `frontend/src/dev/probe.ts`：在 dev 构建下用 `?probe=1` 触发页面自测，
把「窗口滚动条 / 元素出窗 / 原生滚动条」三组不变量写成 JSON 落到 DOM，
本脚本负责起后端 + Vite + 无头浏览器并断言。

用法:
    python scripts/ui_probe.py            # 1100 / 1280 / 1440 三档宽度
    python scripts/ui_probe.py --width 1100

前置: 需要一个有数据的后端（默认用开发数据目录的副本，避免污染真实数据）。
需要完整权限运行（Vite 的 esbuild 子进程与无头浏览器在受限沙箱会失败）。
"""
import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
DEV_DATA = Path(os.environ.get("APPDATA", "")) / "com.ddtoolkit.app-dev"
WORK = ROOT / "_ui_probe_tmp"
EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _wait(url: str, timeout: float, proc: subprocess.Popen | None = None) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if proc is not None and proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                if r.status < 500:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def _find_edge() -> str | None:
    for p in EDGE_CANDIDATES:
        if Path(p).exists():
            return p
    return None


def _prepare_data(empty: bool = False) -> Path:
    """开发数据目录副本（只拷库与名单，静态缓存不需要）。

    empty=True 时给一个全新空目录——用来验证「首次启动」相关行为
    （后端 first_run=true、前端自动弹登录浮窗）。
    """
    data = WORK / "data"
    data.mkdir(parents=True, exist_ok=True)
    if empty:
        return data
    for f in ("vtuber.db", "vtuber.db-wal", "vtuber.db-shm", ".env", "vtubers.csv"):
        src = DEV_DATA / f
        if src.exists():
            shutil.copy2(src, data / f)
    return data


def _first_vtuber(port: int) -> int | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/vtuber/list", timeout=10) as r:
            items = json.loads(r.read().decode("utf-8"))
        return int(items[0]["id"]) if items else None
    except Exception:
        return None


def _run_probe(edge: str, url: str, width: int, height: int, out_dir: Path, tag: str) -> dict | None:
    dom_file = out_dir / f"dom-{tag}-{width}.html"
    profile = out_dir / f"edge-{tag}-{width}"
    cmd = [
        edge, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
        f"--window-size={width},{height}", f"--user-data-dir={profile}",
        "--virtual-time-budget=45000", "--dump-dom", url,
    ]
    with open(dom_file, "wb") as fh:
        subprocess.run(cmd, stdout=fh, stderr=subprocess.DEVNULL, timeout=180)
    text = dom_file.read_text(encoding="utf-8", errors="replace")
    m = re.search(r'<pre id="ui-probe">(.*?)</pre>', text, re.S)
    if not m:
        print(f"  [FAIL] {tag} @{width}: 未拿到探针输出（页面未跑完？见 {dom_file}）")
        return None
    return {"views": json.loads(m.group(1)), "dom": dom_file}


# 设计上就要横向滚动的容器（白名单）：type-chips 胶囊行超宽时行内横滚
# （scrollbar 已隐藏），属于有意行为，不算布局缺陷。
H_SCROLL_ALLOWLIST = ("type-chips",)


def _assert(views: list[dict], width: int) -> list[str]:
    bad: list[str] = []
    for v in views:
        tag = v.get("tag")
        if v.get("scrollbarPx") != [0, 0]:
            bad.append(f"@{width} {tag}: 文档层出现滚动条 scrollbarPx={v['scrollbarPx']}")
        for item in v.get("overflowing", []):
            bad.append(f"@{width} {tag}: 元素可见出窗 {item}")
        for sc in v.get("scrollers", []):
            el = sc.get("el", "")
            if sc.get("nativeBarW", 0) > 0 or sc.get("nativeBarH", 0) > 0:
                bad.append(
                    f"@{width} {tag}: 原生滚动条 {el} "
                    f"nativeBar={sc['nativeBarW']}x{sc['nativeBarH']}"
                )
            if (
                sc.get("hOverflow")
                and sc.get("overflowX") in ("auto", "scroll")
                and not any(a in el for a in H_SCROLL_ALLOWLIST)
            ):
                bad.append(
                    f"@{width} {tag}: 容器横向溢出 {el} "
                    f"client={sc['client'][0]} scroll={sc['scroll'][0]}"
                )
    return bad


def _assert_first_run(dom_file: Path) -> list[str]:
    """首启行为：登录浮窗自动出现，且带「凭据仅保存在本机」说明。"""
    text = dom_file.read_text(encoding="utf-8", errors="replace")
    bad: list[str] = []
    if 'role="dialog"' not in text:
        bad.append("首启登录浮窗未自动弹出（?firstRun=1 下应打开）")
    if "仅保存在本机" not in text:
        bad.append("登录浮窗缺少「凭据仅保存在本机」说明文本")
    return bad


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, action="append", help="窗口宽度（可多次，默认 1100/1280/1440）")
    ap.add_argument("--height", type=int, default=760)
    ap.add_argument(
        "--first-run",
        action="store_true",
        help="用空数据目录起后端，验证「首次启动自动弹登录浮窗 + 本地存储说明」",
    )
    args = ap.parse_args()
    widths = args.width or [1100, 1280, 1440]

    edge = _find_edge()
    if not edge:
        print("[FAIL] 未找到 Edge/Chrome")
        return 1
    if not args.first_run and not (DEV_DATA / "vtuber.db").exists():
        print(f"[FAIL] 未找到开发数据目录 {DEV_DATA}（先跑一次 dev 应用）")
        return 1

    WORK.mkdir(parents=True, exist_ok=True)
    data = _prepare_data(empty=args.first_run)
    be_port, vite_port = _free_port(), _free_port()

    be_env = {
        **os.environ,
        "DDTOOLKIT_DATA_DIR": str(data),
        "DDTOOLKIT_PORT": str(be_port),
        "DDTOOLKIT_PARENT_PID": "0",
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    print(f"[probe] 起后端 :{be_port}")
    be_log = open(WORK / "backend.log", "wb")
    be = subprocess.Popen([sys.executable, "backend_main.py"], cwd=ROOT, env=be_env,
                          stdout=be_log, stderr=subprocess.STDOUT)
    vite = None
    failures: list[str] = []
    try:
        if not _wait(f"http://127.0.0.1:{be_port}/healthz", 90, be):
            print("[FAIL] 后端未就绪，见", WORK / "backend.log")
            return 1

        print(f"[probe] 起 Vite :{vite_port}")
        vite_env = {**os.environ, "VITE_API_BASE": f"http://127.0.0.1:{be_port}"}
        vite = subprocess.Popen(
            ["npx", "vite", "--port", str(vite_port), "--strictPort"],
            cwd=FRONTEND, env=vite_env, shell=True,
            stdout=open(WORK / "vite.log", "wb"), stderr=subprocess.STDOUT,
        )
        if not _wait(f"http://localhost:{vite_port}/", 120, vite):
            print("[FAIL] Vite 未就绪，见", WORK / "vite.log")
            return 1

        vid = _first_vtuber(be_port)
        if args.first_run:
            route, extra = "/", "?probe=1&firstRun=1"
            print("[probe] 空数据目录模式：验证首启登录浮窗")
        else:
            route = f"/vtubers/{vid}" if vid else "/"
            extra = "?probe=1"
            print(f"[probe] 目标路由 {route}（VTuber #{vid}）")

        for w in widths:
            url = f"http://localhost:{vite_port}{route}{extra}"
            print(f"[probe] 宽度 {w} → {url}")
            res = _run_probe(edge, url, w, args.height, WORK, "main")
            if not res:
                failures.append(f"@{w}: 无探针输出")
                continue
            bad = _assert(res["views"], w)
            if args.first_run:
                bad += _assert_first_run(res["dom"])
            failures.extend(bad)
            tags = [v.get("tag") for v in res["views"]]
            print(f"  views={tags}  问题={len(bad)}")
            for b in bad[:8]:
                print("   -", b)

        print("\n=== 汇总 ===")
        if failures:
            print(f"[FAIL] {len(failures)} 处不变量被破坏")
            return 1
        print("[ok] 全部宽度 × 视图通过（无窗口滚动条 / 无出窗元素 / 无原生滚动条）")
        return 0
    finally:
        for p in (vite, be):
            if p and p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()
        be_log.close()
        if not failures:
            shutil.rmtree(WORK, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
