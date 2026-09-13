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
import urllib.parse
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
    data = json.loads(m.group(1))
    if isinstance(data, dict):                     # 2026-09-10 起：{views, topbar, ...}
        return {
            "views": data.get("views") or [],
            "topbar": data.get("topbar"),
            "calendar": data.get("calendar"),
            "dom": dom_file,
        }
    return {"views": data, "topbar": None, "calendar": None, "dom": dom_file}   # 旧格式兼容


def _run_shot(edge: str, url: str, width: int, height: int, out_png: Path) -> None:
    """截一张「筛选弹窗打开态」的图（视觉存档；不参与不变量断言）。

    与 `_run_probe` 同款：`--virtual-time-budget` 让页面跑完 `?probe=filter-pop`
    的短序列（切到列表视图 → 点开筛选弹窗 → 可选点一个预设 → 停住），再落盘 PNG。
    2× 设备像素比：弹窗只有 512 宽，1× 下看不清区间色带与端点态。
    """
    profile = out_png.with_suffix("")
    cmd = [
        edge, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
        f"--window-size={width},{height}", f"--user-data-dir={profile}",
        "--force-device-scale-factor=2",
        "--virtual-time-budget=45000", f"--screenshot={out_png}", url,
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
    except Exception as exc:  # 截图失败不影响断言
        print(f"  [warn] 截图失败：{exc}")


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
        bad += _assert_cards(v, width)
        bad += _assert_filter_pop(v, width)
        bad += _assert_filter_chain(v, width)
    return bad


def _assert_topbar(tb: dict | None, width: int) -> list[str]:
    """顶栏展示策略（2026-09-10 用户：频繁的动态轮询不必占顶栏）。

    只在**采样当时恰好只有自动节拍在跑**时才断言（其余情形空过，不制造假失败）：
    此时顶栏必须保持空闲态——不亮容器、文案不是任务进度。
    """
    if not tb or not tb.get("ok"):
        return []
    running_visible = (tb.get("postRunning") and not tb.get("postAuto")) or (
        tb.get("accountRunning") and not tb.get("accountAuto")
    )
    quiet = (tb.get("postRunning") and tb.get("postAuto")) or (
        tb.get("accountRunning") and tb.get("accountAuto")
    )
    if not quiet or running_visible or tb.get("manualRunning") is True:
        return []
    bad: list[str] = []
    text = tb.get("pillText") or ""
    if tb.get("pillOn"):
        bad.append(f"@{width} 顶栏：只有自动节拍在跑却亮起了事件容器（text={text!r}）")
    if "轮询" in text or "账号信息抓取中" in text:
        bad.append(f"@{width} 顶栏：自动节拍占了状态文案（{text!r}）")
    return bad


# ── 筛选弹窗（P10-A）──
# `.posts-panel` 是 overflow:hidden：双月历弹窗（宽 520）一旦越出右栏就会被裁掉左月历。
# 这条不变量只能靠真实浏览器量，固化为断言（1100 档是最紧的一档：面板 558 vs 弹窗 536）。
FILTER_PILL_EXPECT = {
    "list-filter-pop": "筛选",
    "list-filter-applied": "筛选 · 1",
    "list-filter-reset": "筛选",
}


def _assert_filter_pop(v: dict, width: int) -> list[str]:
    fp = v.get("filterPop")
    if fp is None:
        return []
    tag = v.get("tag")
    if not fp.get("ok"):
        return [f"@{width} {tag}: 筛选弹窗未出现（{fp.get('reason')}）"]
    bad: list[str] = []
    if not fp.get("insidePanel"):
        bad.append(
            f"@{width} {tag}: 筛选弹窗越出右栏可视区（会被 .posts-panel 裁掉）"
            f" pop={fp.get('pop')} panel={fp.get('panel')}"
        )
    per = fp.get("perPanelDays") or []
    if any(c != 42 for c in per):
        bad.append(f"@{width} {tag}: 月历格数 {per} ≠ 42（恒 6 行 × 7 列）")
    if fp.get("visibleMonthPanels") != 2:
        bad.append(f"@{width} {tag}: 可见月份面板 {fp.get('visibleMonthPanels')} ≠ 2（双月历并排）")
    if fp.get("presets") != 6:
        bad.append(f"@{width} {tag}: 预设钮 {fp.get('presets')} ≠ 6")
    if fp.get("confirmDisabled"):
        bad.append(f"@{width} {tag}: 「确认」初始态被禁用（区间为空时应可用）")
    return bad


def _assert_filter_chain(v: dict, width: int) -> list[str]:
    """筛选钮文案全链路：草稿不生效 → 确认后计数 1 → 重置/Esc 回默认。"""
    tag = v.get("tag")
    if tag not in FILTER_PILL_EXPECT:
        return []
    bad: list[str] = []
    got = v.get("pill")
    if got != FILTER_PILL_EXPECT[tag]:
        bad.append(f"@{width} {tag}: 筛选钮文案 {got!r} ≠ {FILTER_PILL_EXPECT[tag]!r}")
    if tag == "list-filter-applied":
        if v.get("popOpen"):
            bad.append(f"@{width} {tag}: 点「确认」后弹窗未关闭")
        if v.get("draftPill") != "筛选":
            bad.append(f"@{width} {tag}: 草稿态就改了触发器（{v.get('draftPill')!r}）—— 草稿制被破坏")
        if not v.get("draftMarked"):
            bad.append(f"@{width} {tag}: 点预设后未高亮该预设")
    if tag == "list-filter-reset" and v.get("popOpen"):
        bad.append(f"@{width} {tag}: Esc 未关闭筛选弹窗")
    return bad


# 列表卡片列宽契约（2026-09-08 回归事故固化）：列宽恒为 min(900, 可用宽)、
# 卡片铺满该列、封面 220 且不被裁。曾经 `.list-scroll > .list-inner` 因
# OverlayScroll 插层失效 → 列宽随内容变（短标题缩到 566px，长串撑到 1350px 并裁封面）。
CARD_COLUMN_MAX = 900
CARD_COVER_W = 220


def _assert_cards(v: dict, width: int) -> list[str]:
    cards = v.get("cards")
    if not cards or not cards.get("n"):
        return []
    tag = v.get("tag")
    bad: list[str] = []
    inner_w = cards.get("innerW")
    # 契约是否生效（与页面内容无关的硬断言）：max-width 计算值必须是 px 上限，
    # 一旦选择器踩空就退化成 none（列宽随内容变，正是 2026-09-08 那次回归）
    max_w = cards.get("innerMaxW")
    if max_w == "none" or (max_w and max_w.endswith("px") and float(max_w[:-2]) > 1000):
        bad.append(f"@{width} {tag}: 列表列宽契约未生效（.list-inner max-width={max_w}）")
    if inner_w is not None and inner_w > CARD_COLUMN_MAX + 1:
        bad.append(f"@{width} {tag}: 列表列宽 {inner_w} > {CARD_COLUMN_MAX}（列宽随内容膨胀）")
    if inner_w is not None and cards["widthMax"] - inner_w > 1:
        bad.append(
            f"@{width} {tag}: 卡片 {cards['widthMax']} 未铺满列表列 {inner_w}"
        )
    if cards["widthMax"] - cards["widthMin"] > 1:
        bad.append(
            f"@{width} {tag}: 卡片宽度不一致 min={cards['widthMin']} max={cards['widthMax']}"
        )
    if cards.get("coverW") is not None and cards["coverW"] != CARD_COVER_W:
        bad.append(f"@{width} {tag}: 卡片封面宽 {cards['coverW']} ≠ {CARD_COVER_W}")
    if cards.get("coverClipped"):
        bad.append(f"@{width} {tag}: {cards['coverClipped']} 张卡片封面被左缘裁切")
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


def _kill_tree(proc: subprocess.Popen | None) -> None:
    """收掉进程树。

    Windows 上 Vite 是用 `shell=True` 起的（npx 是 .cmd），terminate 只杀得掉
    外层 cmd、留下 node 子进程常驻监听（2026-09-08 实测：连跑几轮后攒了 10 个
    残留 dev server 锁住日志文件）——必须 taskkill /T 连树一起杀。
    """
    if proc is None or proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       capture_output=True)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, action="append", help="窗口宽度（可多次，默认 1100/1280/1440）")
    ap.add_argument("--height", type=int, default=760)
    ap.add_argument(
        "--first-run",
        action="store_true",
        help="用空数据目录起后端，验证「首次启动自动弹登录浮窗 + 本地存储说明」",
    )
    ap.add_argument(
        "--shot",
        action="store_true",
        help="额外存图：每档宽度截一张「筛选弹窗打开态」（_ui_probe_tmp/shot-<宽>.png），供视觉比对",
    )
    ap.add_argument(
        "--shot-preset",
        default="",
        help="存图时先点一个预设（如 近一月），用于看区间色带/端点态",
    )
    ap.add_argument(
        "--archive",
        action="store_true",
        help="只跑一档宽度，打印直播日历每格的**实渲染文本**（排查「某些天不显示信息」）",
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

        if args.archive:
            w = widths[0]
            res = _run_probe(edge, f"http://localhost:{vite_port}{route}?probe=archive",
                             w, args.height, WORK, "archive")
            cal = (res or {}).get("calendar") or {}
            print(f"\n=== 直播日历实渲染（@{w}）{cal.get('title')!r} note={cal.get('note')!r} ===")
            for c in cal.get("cells") or []:
                mark = "●" if c.get("body") else "·"
                print(f"  {mark} {c.get('day'):>3} [{c.get('badge')}] {c.get('body')}")
            d = cal.get("detail")
            print("\n=== 最近一场的详情弹窗实渲染 ===")
            if not d:
                print("  （未打开：当月没有带场次的格子）")
            else:
                print(f"  {d.get('name')!r} {d.get('sub')!r}")
                print(f"  弹幕行: {d.get('danmakuRows')}")
                print(f"  词云格: {d.get('cloudCells')} · 动态行: {d.get('eventRows')}")
                print(f"  占位文案: {d.get('placeholders')}")
            return 0

        for w in widths:
            url = f"http://localhost:{vite_port}{route}{extra}"
            print(f"[probe] 宽度 {w} → {url}")
            res = _run_probe(edge, url, w, args.height, WORK, "main")
            if not res:
                failures.append(f"@{w}: 无探针输出")
                continue
            bad = _assert(res["views"], w)
            bad += _assert_topbar(res.get("topbar"), w)
            if args.first_run:
                bad += _assert_first_run(res["dom"])
            failures.extend(bad)
            tags = [v.get("tag") for v in res["views"]]
            print(f"  views={tags}  问题={len(bad)}")
            tb = res.get("topbar") or {}
            print(
                "  顶栏采样: "
                f"ok={tb.get('ok')} text={tb.get('pillText')!r} on={tb.get('pillOn')} "
                f"post={tb.get('postRunning')}/auto={tb.get('postAuto')} "
                f"acc={tb.get('accountRunning')}/auto={tb.get('accountAuto')} "
                f"manual={tb.get('manualRunning')}"
            )
            for b in bad[:8]:
                print("   -", b)
            # 视觉存档：另起一次浏览器，只把筛选弹窗打开并停住后截图
            # （probe.ts 的 `?probe=filter-pop` 短模式；不参与断言）
            if args.shot and not args.first_run:
                shot = WORK / f"shot-{w}.png"
                preset = f"&preset={urllib.parse.quote(args.shot_preset)}" if args.shot_preset else ""
                _run_shot(
                    edge,
                    f"http://localhost:{vite_port}{route}?probe=filter-pop{preset}",
                    w,
                    args.height,
                    shot,
                )
                print(f"  截图 → {shot}")

        print("\n=== 汇总 ===")
        if failures:
            print(f"[FAIL] {len(failures)} 处不变量被破坏")
            return 1
        print("[ok] 全部宽度 × 视图通过（无窗口滚动条 / 无出窗元素 / 无原生滚动条）")
        return 0
    finally:
        _kill_tree(vite)
        _kill_tree(be)
        be_log.close()
        # 失败时保留现场；`--shot` 时保留截图（两者都在 _ui_probe_tmp/ 下）
        if not failures and not args.shot:
            shutil.rmtree(WORK, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
