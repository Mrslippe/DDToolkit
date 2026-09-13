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
import hashlib
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


# 探针用的数据目录源文件（静态图片缓存不需要）
_SEED_FILES = ("vtuber.db", "vtuber.db-wal", "vtuber.db-shm", ".env", "vtubers.csv")


def _prepare_data(empty: bool = False) -> Path:
    """开发数据目录副本（只拷库与名单，静态缓存不需要）。

    empty=True 时给一个**真正的全新空目录**——用来验证「首次启动」相关行为
    （后端 first_run=true、前端自动弹登录浮窗）。

    ⚠️ 两种模式都必须**每次重建** `data/`（审计 2026-09-11 记录的缺口，本次修）：
    - 旧写法 `empty=True` 直接 `return data`，**从不清理上一次运行留下的内容** ——
      一次普通探针之后紧接着跑 `--first-run`，那次「首启」其实是在**已初始化过的数据
      目录**上跑的（`.first-run-done` 已存在 → `first_run=false` → 浮窗不弹），
      却仍然报出「首启」结论；更糟的是目录里还留着 `vtuber.db` 与 **`.env`（真实凭据）**，
      于是「空数据目录」这一前提整个不成立。
    - 所以：源文件先归拢到 `seed/`，再把 `data/` 整棵删掉重建，两种模式都从干净状态起步。
    """
    seed = WORK / "seed"
    seed.mkdir(parents=True, exist_ok=True)
    for f in _SEED_FILES:
        src = DEV_DATA / f
        if src.exists():
            shutil.copy2(src, seed / f)

    data = WORK / "data"
    if data.exists():                      # 上一次运行的残留：整棵清掉（含 .first-run-done）
        shutil.rmtree(data, ignore_errors=True)
    data.mkdir(parents=True, exist_ok=True)
    if empty:
        return data                        # 真的空：无库、无 .env、无首启标记
    for f in _SEED_FILES:
        src = seed / f
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
    try:
        with open(dom_file, "wb") as fh:
            subprocess.run(cmd, stdout=fh, stderr=subprocess.DEVNULL, timeout=180)
    except subprocess.TimeoutExpired:
        # 超时必须自己接住：异常穿出 main 时 `failures` 还是空的，
        # 而 finally 里会把 `_ui_probe_tmp/` 整目录删掉 —— 于是「失败保留现场」的承诺落空，
        # 恰恰在最难复现的挂起场景下把证据丢了。也报告成 `_killed` 以便和「没起来」区分。
        print(f"  [FAIL] {tag} @{width}: 浏览器超时（180s）未产出 DOM；"
              f"该档视为未量到（现场已保留：{out_dir}）")
        return None
    except OSError as exc:
        print(f"  [FAIL] {tag} @{width}: 无法启动浏览器（{exc}）")
        return None
    text = dom_file.read_text(encoding="utf-8", errors="replace")
    m = re.search(r'<pre id="ui-probe">(.*?)</pre>', text, re.S)
    if not m:
        print(f"  [FAIL] {tag} @{width}: 未拿到探针输出（页面未跑完？见 {dom_file}）")
        return None
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError as exc:
        # 解析失败必须当作「没量到」，不能让异常穿透 finally 把现场一起删掉
        # （审计 2026-09-11：原来 json.loads 未捕获，异常直接冒泡出 main）。
        print(f"  [FAIL] {tag} @{width}: 探针 JSON 解析失败（{exc}）；见 {dom_file}")
        return None
    if isinstance(data, dict):                     # 2026-09-10 起：{views, topbar, ...}
        # ⚠️ 这里是**白名单**：探针页面新产出的字段必须在这里登记，否则会被静默丢掉 ——
        # 2026-09-13 加"场景切换"探针时踩到过：页面明明写了 `sceneSwitch`，
        # 脚本侧只拿到一排 None（看起来像"探针没跑"，实际是被丢在这一层）。
        return {
            "mode": data.get("mode"),
            "views": data.get("views") or [],
            "topbar": data.get("topbar"),
            "calendar": data.get("calendar"),
            "settings": data.get("settings"),
            "degraded": data.get("degraded") or [],
            "dom": dom_file,
        }
    return {"mode": None, "views": data, "topbar": None, "calendar": None,
            "settings": None, "degraded": [], "dom": dom_file}


# ── 展示页 hero 药丸签名（P2 分层收敛 A 批次的位级回归护栏）─────────────
# 动机：`orderAccounts`（拖拽排序）/ `chunkBy`（每 3 枚切集）/ `accountHomeUrl`（主页兜底）
# 只在 cards 视图 + 药丸有内容时渲染，而布局不变量对「药丸少一排 / 顺序变了 / 切集错了」
# 完全无感 —— 即"搬坏了但探针全绿"。这里把 `hero.signature` 规范化后哈希比对。

def _hero_signature(res: dict) -> str | None:
    """取 cards 段的 hero 签名并哈希；量不到返回 None（由调用方按契约判失败）。"""
    for v in res.get("views") or []:
        if v.get("tag") != "cards":
            continue
        hero = v.get("hero")
        if not hero:
            return None
        payload = json.dumps(
            {
                "pillCount": hero.get("pillCount"),
                "setCount": hero.get("setCount"),
                "setSizes": hero.get("setSizes"),
                "hasAddButton": hero.get("hasAddButton"),
                "signature": hero.get("signature"),
            },
            ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return None


def _hero_expect_failures(res: dict, width: int, expect: str) -> list[str]:
    """hero 签名比对（与 `--hero-expect` 配合）。量不到必须判失败，不能静默通过。"""
    bad: list[str] = []
    hero = None
    for v in res.get("views") or []:
        if v.get("tag") == "cards":
            hero = v.get("hero")
    if not hero:
        return [f"@{width} cards: 未量到 hero 药丸段（--hero-expect 无从比对；"
                f"该视图没渲染出 .stat-pill / .stat-set？）"]
    got = _hero_signature(res)
    if got != expect:
        bad.append(
            f"@{width} cards: hero 药丸签名与基线不一致（实现漂移）\n"
            f"      期望 {expect}\n      实得 {got}\n"
            f"      实测 {json.dumps(hero, ensure_ascii=False)}"
        )
    return bad


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
        # 三个列表型字段一律先要求「键存在且是 list」再逐条断言。
        # 旧写法 `v.get(k, [])` 在**选择器踩空/探针少 emit** 时退化成空列表 → 静默空转
        # （同一次加固里 scrollbarPx 用「缺键也判失败」，这三个却用「缺键当空」，口径不一致）。
        for key, label in (("overflowing", "元素可见出窗"),
                           ("scrollers", "滚动容器")):
            items = v.get(key)
            if not isinstance(items, list):
                bad.append(f"@{width} {tag}: 探针未量到 `{key}`（{label}整段断言空转）")
                continue
            if key == "overflowing":
                for item in items:
                    bad.append(f"@{width} {tag}: 元素可见出窗 {item}")
                continue
            for sc in items:
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

    ⚠️ 「采样本身失败」不在这里判（`ok=false`），否则整段会静默空转 ——
    该情形由 `_assert_probe_integrity` 作为契约失败拦下（2026-09-11 二次加固）。
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
    if fp.get("confirmDisabled") is None:
        # 量不到 ≠ 通过（原来 `if fp.get("confirmDisabled")` 在 None 时静默放过）
        bad.append(f"@{width} {tag}: 取不到「确认」钮状态（.drp-confirm 选择器踩空？）")
    elif fp["confirmDisabled"]:
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


# 主模式（?probe=1）应量到的视图标签序列，由 frontend/src/dev/probe.ts 决定：
# 四个视图 + 列表页的筛选弹窗全链路三帧 + 投稿筛选页。少一段就说明「没量到」，
# 必须判失败 —— 否则断言会静默空转而脚本照旧打印 [ok]。
# （2026-09-11 审计加固：`_first_vtuber` 失败 → 路由落到 `/` → 只 emit `empty`，
#   所有卡片/筛选断言全部空过，退出码仍是 0。）
EXPECTED_TAGS = [
    "archive", "cards", "list",
    "list-filter-pop", "list-filter-applied", "list-filter-reset",
    "list-video", "profile",
]


def _assert_probe_integrity(res: dict, width: int, archive: bool = False) -> list[str]:
    """探针自证「确实按契约量到了」——防的最是「跑通了但什么都没测」。

    三类硬失败：
    - 页面自己汇报的 `degraded`（视图钮点不中 / 投稿 chip 缺失 / 无视图光条）；
    - 量到的段数与契约不符（少段 = 某段被跳过）；
    - **顶栏没采到**（`ok=false`，即 `/vtuber/fetch-status` 取不到）——
      旧写法把这一情形交给 `_assert_topbar` 静默 `return []`，于是「顶栏策略」
      这条不变量在网络/端点出错时整段空转却仍报通过。
    `--archive` 模式不产 views，改为要求日历段存在。
    """
    tag = "archive" if archive else "main"
    bad: list[str] = []
    for reason in res.get("degraded") or []:
        bad.append(f"@{width} {tag}: 探针退化（{reason}）—— 该段未被量到，断言不可信")
    if archive:
        if not res.get("calendar"):
            bad.append(f"@{width} {tag}: 未拿到日历段（--archive 的实渲染 dump 落空）")
        return bad
    tb = res.get("topbar")
    if not tb or not tb.get("ok"):
        bad.append(
            f"@{width} {tag}: 未采到顶栏（/vtuber/fetch-status 无响应）—— "
            "顶栏展示策略整段断言空转"
        )
    tags = [v.get("tag") for v in res.get("views") or []]
    if tags == ["empty"]:
        bad.append(
            f"@{width} {tag}: 量到空置页（没有选中 VTuber）—— 布局断言全部空转。"
            "检查开发数据目录里是否有 V、以及路由是否取到了 id"
        )
    missing = [t for t in EXPECTED_TAGS if t not in tags]
    if missing:
        bad.append(f"@{width} {tag}: 缺少量测段 {missing}（实得 {tags}）")
    return bad


def _assert_cards(v: dict, width: int) -> list[str]:
    cards = v.get("cards")
    tag = v.get("tag")
    contract = v.get("contract")
    bad: list[str] = []
    # 列宽契约：**与列表里有没有帖子无关**，优先用常驻量测（见 probe.ts listContract）
    if contract is not None and "list" in str(tag):
        max_w = contract.get("innerMaxW")
        if not contract.get("hasScroller"):
            bad.append(f"@{width} {tag}: 选择不到 .list-scroll .os-scroll（OverlayScroll 插层回归？）")
        if max_w is None:
            bad.append(f"@{width} {tag}: 选择不到 .list-inner（列宽契约无从校验）")
        elif max_w == "none" or (max_w.endswith("px") and float(max_w[:-2]) > 1000):
            bad.append(f"@{width} {tag}: 列表列宽契约未生效（.list-inner max-width={max_w}）")
        iw = contract.get("innerW")
        if iw is not None and iw > CARD_COLUMN_MAX + 1:
            bad.append(f"@{width} {tag}: 列表列宽 {iw} > {CARD_COLUMN_MAX}（列宽随内容膨胀）")
    if not cards or not cards.get("n"):
        return bad
    inner_w = cards.get("innerW")
    # 契约是否生效（与页面内容无关的硬断言）：max-width 计算值必须是 px 上限，
    # 一旦选择器踩空就退化成 none（列宽随内容变，正是 2026-09-08 那次回归）。
    # `None` 必须判失败 —— 旧写法 `max_w == "none" or (max_w and ...)` 在 None 时
    # 两个分支都不成立 → 静默通过（与上面 contract 分支的口径不一致）。
    max_w = cards.get("innerMaxW")
    if max_w is None:
        bad.append(f"@{width} {tag}: 量不到 .list-inner 的 max-width（选择器踩空，契约无从校验）")
    elif max_w == "none" or (max_w.endswith("px") and float(max_w[:-2]) > 1000):
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
    cover_w = cards.get("coverW")
    if cover_w is None:
        # 有卡片却量不到封面 = 选择器踩空，静默放过正是 2026-09-08 那类回归
        bad.append(f"@{width} {tag}: 有 {cards['n']} 张卡片却量不到 .post-card-cover")
    elif cover_w != CARD_COVER_W:
        bad.append(f"@{width} {tag}: 卡片封面宽 {cover_w} ≠ {CARD_COVER_W}")
    if cards.get("coverClipped"):
        bad.append(f"@{width} {tag}: {cards['coverClipped']} 张卡片封面被左缘裁切")
    return bad


def _calendar_signature(cal: dict | None) -> str | None:
    """直播日历 42 格 `day|badge|body` 的 sha256（A-2 取数/月份/分类链路的位级护栏）。

    为什么用「格内文本」而不是几何：A-2 要搬的是**取数与状态**（场次列表、月份、分类桶），
    搬坏了的表现是「某些天没内容了 / 徽章类型变了 / 月份错位」，**不是**元素出窗 ——
    布局不变量对此完全无感。格内文本正是这条链路的最终产物。

    注意：它同时受**第三方数据变化**影响（新场次入库、分类被校正），所以只适合
    「重构前后立刻各跑一次」的短窗口比对，不适合当长期基线（写进报告时要说清）。
    """
    if not cal:
        return None
    cells = cal.get("cells") or []
    if not cells:
        return None
    payload = json.dumps(
        [[c.get("day"), c.get("badge"), c.get("body")] for c in cells],
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


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
    ap.add_argument(
        "--settings",
        action="store_true",
        help="只跑一档宽度：打开「档案设置」→ 展开签名候选面板 → 断言几何不变量"
             "（chevron 完整落在输入框内、面板与输入条同宽、面板不被弹窗裁掉、"
             "收起态不存在面板）",
    )
    ap.add_argument(
        "--hero-expect",
        default="",
        help="cards 视图 hero 药丸签名的期望 sha256（位级回归护栏）。"
             "先跑一次不带该参数，从输出里抄签名；重构后再带上来比对。",
    )
    ap.add_argument(
        "--hero-print",
        action="store_true",
        help="只打印 cards 视图 hero 药丸签名与实测明细，便于建立基线",
    )
    ap.add_argument(
        "--archive-print",
        action="store_true",
        help="（配合 --archive）打印日历 42 格的 sha256 签名，便于建立重构前基线",
    )
    ap.add_argument(
        "--archive-day",
        default="",
        help="（配合 --archive）点**指定日号**的格子而不是最近一格。"
             "最近一场常常刚下播、danmakus 未收录 → 弹幕/词云段等于没验；"
             "要验那两段就回到几天前有收录的场次（如 --archive-day 11）。",
    )
    ap.add_argument(
        "--calendar-expect",
        default="",
        help="（配合 --archive）日历格内文本签名的期望 sha256；不一致判失败。"
             "注意它同时受第三方数据变化影响，只适合重构前后短窗口比对。",
    )
    ap.add_argument(
        "--vtuber",
        type=int,
        default=0,
        help="指定 VTuber id（默认取 /vtuber/list 的第一条）。"
             "用于命中特定形态的数据，例如平台药丸多枚的 V（切集/排序只在 >1 枚时才有意义）。",
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

        vid = args.vtuber or _first_vtuber(be_port)
        if args.first_run:
            # `probe=first-run`：空数据目录下页面落在 `/`，**本来就没有视图光条**，
            # 走四视图量测只会量到 empty+degraded 并被判三条失败（2026-09-11 加固
            # 引入的必然假失败）。首启要验的是登录浮窗，改由 `_assert_first_run`
            # 在落盘 DOM 上断言；此处显式用独立 mode，两个契约互不污染。
            route, extra = "/", "?probe=first-run&firstRun=1"
            print("[probe] 空数据目录模式：验证首启登录浮窗")
        else:
            route = f"/vtubers/{vid}" if vid else "/"
            extra = "?probe=1"
            print(f"[probe] 目标路由 {route}（VTuber #{vid}）")

        if args.archive:
            w = widths[0]
            arch_url = f"http://localhost:{vite_port}{route}?probe=archive"
            if args.archive_day:
                arch_url += f"&day={urllib.parse.quote(args.archive_day)}"
                print(f"[probe] archive 指定日号 = {args.archive_day}")
            res = _run_probe(edge, arch_url, w, args.height, WORK, "archive")
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
            # 这是**排查工具**，但也要能区分「跑成功」与「没量到」：
            # 原来无论拿到什么都 return 0（审计 2026-09-11），
            # 于是「日历根本没渲染」与「日历渲染正常」在退出码上无法区分。
            bad = _assert_probe_integrity(res or {}, w, archive=True)

            # ── 日历格内文本签名（位级回归护栏；与 hero 同源思路）──────────────
            # A-2（拆 `useLiveSessions` 的取数/月份/分类状态）**没有**布局层面的护栏：
            # 布局不变量看不出「场次没拉回来 / 月份错了 / 类型徽章变了」。
            # 日历 42 格的 `day|badge|body` 正好是这条链路（取数 → 分类 → 渲染）的产物，
            # 把它哈希后即可做位级比对。
            cal_sig = _calendar_signature(cal)
            if args.archive_print or args.calendar_expect:
                print(f"\n  日历格签名 = {cal_sig}")
            if args.calendar_expect and cal_sig != args.calendar_expect:
                bad.append(
                    "日历格内文本签名与基线不一致（取数/月份/分类链路漂移）\n"
                    f"      期望 {args.calendar_expect}\n      实得 {cal_sig}"
                )
            elif args.calendar_expect:
                print("  [ok] 日历格签名与基线一致")

            for b in bad:
                print("   -", b)
            if bad:
                print("[FAIL] archive 模式未按契约拿到日历段")
                failures.extend(bad)
                return 1
            return 0

        if args.settings:
            # 档案设置弹窗的几何不变量（devlog/072）。这个弹窗此前无探针覆盖，
            # 而它出过"滚动条压输入框""浮层被滚动体静默裁掉"两类问题。
            w = widths[0]
            url = f"http://localhost:{vite_port}{route}?probe=settings"
            print(f"[probe] settings @{w} → {url}")
            res = _run_probe(edge, url, w, args.height, WORK, "settings")
            st = ((res or {}).get("settings") or {})
            if res and not st:
                print(f"  [!] 探针 mode={res.get('mode')!r} 键={sorted(res.keys())}"
                      f"（新字段需要在 _run_probe 的白名单里登记）")
            print(f"  行数={st.get('rows')} 溢出判定行={st.get('ovfRows')} "
                  f"首行可滚距离={st.get('firstTextScrollable')} "
                  f"输入框右内距={st.get('inputRightPad')}")
            print(f"  chevron 在框内={st.get('chevronInside')} "
                  f"面板同宽={st.get('panelSameWidth')} "
                  f"(输入条 {st.get('inputWidth')} / 面板 {st.get('panelWidth')}) "
                  f"面板出视口={st.get('panelClipped')} "
                  f"浮在内容上={st.get('panelOverContent')} "
                  f"position={st.get('panelPosition')} "
                  f"portal到body={st.get('panelPortaled')} "
                  f"在弹窗内部={st.get('panelInsideDialog')} "
                  f"收起态面板宽度={st.get('panelWidthWhenClosed')}")
            print(f"  再点收起={st.get('toggleClosedOk')} 再点重开={st.get('toggleReopenOk')} "
                  f"面板 DOM 数={st.get('openPanelCount')}")
            if st.get("reason") == "no-settings-dialog":
                failures.append(f"@{w} settings: 没打开档案设置弹窗（.bg-set 没点上？）")
            elif st.get("reason") == "no-settings-trigger":
                failures.append(f"@{w} settings: 页面上找不到 .bg-set 触发钮"
                                f"（卡片视图没渲染出来？）")
            elif st.get("reason") == "dialog-not-opened":
                failures.append(f"@{w} settings: 点了 .bg-set 但弹窗没出现")
            else:
                if st.get("panelWidthWhenClosed", 0) > 0:
                    failures.append(f"@{w} settings: 收起态就已存在面板"
                                    f"（宽 {st.get('panelWidthWhenClosed')}）")
                if not st.get("chevronInside"):
                    failures.append(f"@{w} settings: 内嵌 chevron 没有完整落在输入框内")
                # 图标位置对 ≠ 文字没被压住：内距必须给图标留出空间
                # （2026-09-13 实测踩到：`.vd-sign-field > input` 与 `.vd-field input`
                #  同特异度、后者更靠后 → padding-right 被改回 8px，图标压字）
                pad = st.get("inputRightPad") or "0px"
                try:
                    pad_px = float(str(pad).replace("px", ""))
                except ValueError:
                    pad_px = 0.0
                if pad_px < 26:
                    failures.append(f"@{w} settings: 输入框右内距只有 {pad}，"
                                    f"没给 22px 的内嵌图标留位（文字会被压住）")
                if not st.get("panelSameWidth"):
                    failures.append(f"@{w} settings: 面板宽度与输入条不一致（参考图要求同宽）")
                if st.get("panelClipped"):
                    failures.append(f"@{w} settings: 面板出了视口（浮层会被裁/看不全）")
                if not st.get("panelOverContent"):
                    failures.append(f"@{w} settings: 面板没有浮在弹窗内容之上"
                                    f"（用户 2026-09-13 口径：要浮层，不推挤下方内容）")
                if st.get("panelPosition") != "fixed" or not st.get("panelPortaled"):
                    failures.append(f"@{w} settings: 面板不是 portal+fixed 浮层"
                                    f"（position={st.get('panelPosition')} "
                                    f"portal={st.get('panelPortaled')}）—— "
                                    f"内联面板会被滚动体静默裁掉")
                if st.get("panelInsideDialog"):
                    failures.append(f"@{w} settings: 面板仍在弹窗子树里（会被 overflow:hidden 裁）")
                if (st.get("rows") or 0) <= 0:
                    failures.append(f"@{w} settings: 候选面板一行都没有"
                                    f"（该 V 需要有 ≥1 个带签名的账号）")
                if (st.get("firstTextScrollable") or 0) > 0 and not (st.get("ovfRows") or 0):
                    failures.append(f"@{w} settings: 首行文字可滚动却没挂渐隐（.ovf 判定失效）")
                if not st.get("toggleClosedOk"):
                    failures.append(f"@{w} settings: 面板打开时**再点一次按钮没收起**"
                                    f"（mousedown 判成外部 + click 又打开 = 闪一下没关）")
                if not st.get("toggleReopenOk"):
                    failures.append(f"@{w} settings: 收起后再点按钮没能重新打开")
                if (st.get("openPanelCount") or 0) > 1:
                    failures.append(f"@{w} settings: 同时存在 {st.get('openPanelCount')} "
                                    f"个面板 DOM（重复渲染）")
                if not failures:
                    print("  [ok] 档设置弹窗几何不变量全部通过")
            for b in failures:
                print("   -", b)
            return 1 if failures else 0

        for w in widths:
            url = f"http://localhost:{vite_port}{route}{extra}"
            print(f"[probe] 宽度 {w} → {url}")
            res = _run_probe(edge, url, w, args.height, WORK, "main")
            if not res:
                failures.append(f"@{w}: 无探针输出")
                continue
            # hero 药丸签名（位级回归护栏；与布局不变量独立）
            if args.hero_print or args.hero_expect:
                sig = _hero_signature(res)
                print(f"  hero 签名 = {sig}")
                if args.hero_print:
                    hero = next((v.get("hero") for v in res["views"]
                                 if v.get("tag") == "cards"), None)
                    print(f"  hero 明细 = {json.dumps(hero, ensure_ascii=False)}")
            if args.hero_expect and res.get("mode") != "first-run":
                hb = _hero_expect_failures(res, w, args.hero_expect)
                failures.extend(hb)
                for b in hb:
                    print("   -", b)
                if not hb:
                    print("  [ok] hero 药丸签名与基线一致")
            if args.hero_print:
                continue
            if res.get("mode") == "first-run":
                # 首启契约：**只**断言登录浮窗（页面无视图光条，布局断言不适用）。
                # 仍要求探针自证没退化，避免「浮窗没出现」被当成「没量到」放过。
                for reason in res.get("degraded") or []:
                    failures.append(f"@{w} first-run: 探针退化（{reason}）")
                first_bad = _assert_first_run(res["dom"])
                failures.extend(first_bad)
                print(f"  首启浮窗：{'未通过' if first_bad else '已弹出且有凭据说明'}")
                for b in first_bad:
                    print("   -", b)
                continue
            bad = _assert_probe_integrity(res, w)
            bad += _assert(res["views"], w)
            bad += _assert_topbar(res.get("topbar"), w)
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
            for b in bad:          # 全部打印：原来只印前 8 条，后面的问题被吞掉
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