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


def _seed_reservation(data: Path, vtuber_id: int) -> str:
    """往**副本**里种一条明天的预约（R13 探针的确定性现场）。

    为什么要种：开发库里未必有未来的预约帖，而"有预约的格子长什么样"是这条需求的
    全部内容 —— 靠数据碰运气会让断言空转（本仓反复踩过的坑）。
    描述用**完整日期**（`YYYY-MM-DD HH:mm`）而不是"今天/明天"：后者按帖子发布日推断，
    与探针运行时刻耦合；日期取**本地明天**，保证 `start > now`（服务端会过滤过期预约）。
    返回：种下的标题（供断言比对）。
    """
    import sqlite3
    from datetime import datetime, timedelta

    title = "探针预约占位"
    start = datetime.now() + timedelta(days=1)
    start = start.replace(hour=21, minute=0, second=0, microsecond=0)
    con = sqlite3.connect(data / "vtuber.db")
    try:
        row = con.execute(
            "SELECT platform_uid FROM accounts WHERE vtuber_id=? AND platform='bilibili' "
            "ORDER BY sort_order, id LIMIT 1", (vtuber_id,)).fetchone()
        if not row:
            raise SystemExit(f"[probe] VTuber#{vtuber_id} 没有 bilibili 账号，种不了预约")
        uid = row[0]
        con.execute("DELETE FROM posts WHERE platform_post_id LIKE 'PROBE-RESV%'")
        now_str = datetime.utcnow().isoformat(sep=" ")
        con.execute(
            "INSERT INTO posts (platform, platform_uid, platform_post_id, type, title, "
            "body_json, published_at, is_archived, last_seen_at, created_at) "
            "VALUES (?,?,?,?,?,?,?,0,?,?)",
            ("bilibili", uid, "PROBE-RESV-1", "text", title,
             json.dumps({"reservation": {
                 "button_text": "预约", "title": f"直播预约|{title}",
                 "desc1": start.strftime("%Y-%m-%d %H:%M 直播"),
                 "reserve_total": 128, "rid": "21452505",
             }}, ensure_ascii=False),
             now_str, now_str, now_str))
        con.commit()
    finally:
        con.close()
    return title


def _prepare_logged_out() -> Path:
    """有数据但**未登录**的现场（devlog/086）：开发目录副本 + 删掉 `.env`。

    为什么不能直接空目录：未登录提示要验的是"有内容可看时界面怎么标注"——
    空库连侧栏与列表都没有，量不到"受限功能仍然可见/可用"。
    删 `.env` 之后后端读不到凭据 ⇒ 真未登录（`config.py` 只认 DATA_DIR 下的 .env）。
    """
    data = _prepare_data()
    env = data / ".env"
    if env.exists():
        env.unlink()
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
            "scene": data.get("scene"),
            "addv": data.get("addv"),
            "capabilities": data.get("capabilities"),
            "polish": data.get("polish"),
            "reservations": data.get("reservations"),
            "statusIsland": data.get("statusIsland"),
            "appSettings": data.get("appSettings"),
            "degraded": data.get("degraded") or [],
            "dom": dom_file,
        }
    return {"mode": None, "views": data, "topbar": None, "calendar": None,
            "settings": None, "scene": None, "addv": None, "capabilities": None,
            "polish": None, "reservations": None, "statusIsland": None,
            "appSettings": None, "degraded": [], "dom": dom_file}


# ── 展示页 hero 药丸签名（P2 分层收敛 A 批次的位级回归护栏）─────────────
# 动机：`orderAccounts`（拖拽排序）/ `chunkBy`（每 3 枚切集）/ `accountHomeUrl`（主页兜底）
# 只在 cards 视图 + 药丸有内容时渲染，而布局不变量对「药丸少一排 / 顺序变了 / 切集错了」
# 完全无感 —— 即"搬坏了但探针全绿"。这里把 `hero.signature` 规范化后哈希比对。

# 场景切换护栏的等待上限提示（页面侧上限 12s 虚拟时间，见 probe.ts 的 `mode === 'scene'`）
SCENE_WAIT_HINT = "12s（虚拟时间）"


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

    ⚠️ **外部第三方数据任务不算"安静"**（2026-09-15 修，devlog/083）：顶栏按设计要显示
    `正在同步<label>`（`TopBar.tsx`：`busy = accVisible || postVisible || external.running`）。
    探针起后端后这个任务**往往正在跑**，而旧口径只看 post/account 两位 —— 于是三档宽度
    一起报"只有自动节拍在跑却亮起了事件容器"（把外部同步误当成自动节拍占顶栏）。
    采样已带 `externalRunning`，这里按"能否归因"跳过。
    """
    if not tb or not tb.get("ok"):
        return []
    # 外部任务在跑 ⇒ 亮灯有两种可能，归因不了就别断言（探针不该制造假失败）
    if tb.get("externalRunning"):
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
        "--add-v",
        action="store_true",
        help="只跑一档宽度：打开「添加 VTuber」浮窗 → 打关键词 → 断言三条不变量"
             "（敲键不打上游 / 结果行可命中 / 纯数字输入换成「按 UID 添加」）。"
             "探针**不点结果行、不点「搜索 B 站」**（那是真收录与真上游调用）。",
    )
    ap.add_argument(
        "--status-island",
        action="store_true",
        help="只跑一档宽度：顶栏状态岛（R12a，devlog/089）—— 空闲无容器 / 瞬时消息点亮 / "
             "点开面板条目可命中且不挤动右栏 / Esc 收起 / ttl 到期自动回空闲",
    )
    ap.add_argument(
        "--reservations",
        action="store_true",
        help="只跑一档宽度：**种一条明天的预约**（写进数据目录副本）→ 档案视图断言"
             "「预约」徽章/时刻/标题渲染 + hover 浮层列出预约（R13 的端到端护栏）",
    )
    ap.add_argument(
        "--polish",
        action="store_true",
        help="只跑一档宽度：量 R15 三处前端打磨 —— 顶栏标题粗体（字重 + 文本实际宽）、"
             "筛选钮文字左右间隙（斜切 pill 的视觉中心）、药丸尾部「+」未 hover 不占位 / "
             "hover 展开且可命中（探针派发 pointerover/pointerout，CSS :hover 无法模拟）",
    )
    ap.add_argument(
        "--capabilities",
        action="store_true",
        help="只跑一档宽度：**未登录**现场（数据目录副本 + 删 .env）验能力提示 ——"
             "顶栏「未登录 · N 项受限」入口 + 说明窗（现在能做什么/受限项/去登录），"
             "并断言受限功能**没有被隐藏**（添加 V 仍能搜、批量浮窗里账号信息与归档仍可用）",
    )
    ap.add_argument(
        "--app-settings",
        action="store_true",
        help="只跑一档宽度：应用设置（R14a，devlog/091）—— 齿轮可点 → 独立弹窗几何/命中 → "
             "可写项与只读项都渲染（只读逐条带理由）→ 改值保存后**再问一次后端**对账 → "
             "越界时保存钮禁用+红字 → 恢复默认回默认值",
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
    ap.add_argument(
        "--scene",
        action="store_true",
        help="场景切换机（切 V 的预取门控 + 原子提交）诊断与护栏：打印点击后所有 fetch "
             "（预取有没有回来）+ body class 变化序列 + 提交耗时；未提交即判失败（devlog/080）。"
             "需要数据目录里至少有 2 个已订阅 V。",
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
    # `--capabilities` 要的是"有数据但未登录"（删 .env），其余模式用开发目录副本；
    # `--first-run` 用真正空目录（走独立契约）
    data = _prepare_logged_out() if args.capabilities else _prepare_data(empty=args.first_run)
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

        # R13：预约探针要在**后端起来之前**把预约种进副本（否则首屏拿不到）
        seeded_resv_title = ""
        if args.reservations and vid:
            seeded_resv_title = _seed_reservation(data, vid)
            print(f"[probe] 已种预约：{seeded_resv_title!r}（副本 DB，非真库）")
            print(f"[probe] 目标路由 {route}（VTuber #{vid}）")

        if args.app_settings:
            # 应用设置（R14a，devlog/091）：这一条是**会写盘的探针** —— 它真的改设置、
            # 真的恢复默认。跑在数据目录副本上（`_prepare_data()` 的 `_ui_probe_tmp/`），
            # 与 `--reservations` 同一条纪律：**绝不碰开发库**。
            w = widths[0]
            url = f"http://localhost:{vite_port}{route}?probe=app-settings"
            print(f"[probe] app-settings @{w} → {url}")
            res = _run_probe(edge, url, w, args.height, WORK, "app-settings")
            aps = ((res or {}).get("appSettings") or {})
            if res and not aps:
                print(f"  [!] 探针 mode={res.get('mode')!r} 键={sorted(res.keys())}"
                      f"（新字段需要在 _run_probe 的白名单里登记）")
            print(f"  齿轮：存在={aps.get('gearExists')} 可命中={aps.get('gearHit')} "
                  f"贴栏底={aps.get('gearAtBottom')}")
            print(f"  弹窗：打开={aps.get('dialogOpened')} 在视口内={aps.get('dialogInViewport')} "
                  f"可命中={aps.get('dialogHit')} 可写项={aps.get('rows')} "
                  f"只读项={aps.get('readonlyRows')}（带理由 {aps.get('readonlyReasons')}）")
            print(f"  分区：{aps.get('groups')}")
            print(f"  越界：保存钮禁用={aps.get('overSaveDisabled')} 红字={aps.get('overError')!r}")
            print(f"  保存：{aps.get('beforeValue')} → 服务端 {aps.get('afterValue')} "
                  f"（输入框 {aps.get('inputValueAfter')!r}「已改过」标记={aps.get('badgeShown')}）")
            print(f"  恢复默认：服务端 {aps.get('resetValue')} 仍有「已改过」标记="
                  f"{aps.get('badgeAfterReset')}")
            print(f"  主题：选项={aps.get('themeOptions')} 可命中={aps.get('themeSystemHit')} "
                  f"｜ 服务端 {aps.get('themeServerBefore')} → {aps.get('themeServerAfter')} "
                  f"→ 还原 {aps.get('themeServerRestored')}")
            print(f"       选中={aps.get('themeSelected')} html[data-theme]="
                  f"{aps.get('themeRootAttr')!r} 系统深色={aps.get('themeSystemDark')} "
                  f"说明={aps.get('themeCaveat')!r}")
            print(f"  Esc 关闭={aps.get('closedByEsc')}"
                  f"（关后 data-state={aps.get('dialogStateAfterEsc')!r}）")
            if not aps:
                failures.append(f"@{w} app-settings: 没量到设置弹窗段（探针未跑完？）")
            else:
                if not aps.get("gearExists"):
                    failures.append(f"@{w} app-settings: IconRail 底部没有齿轮"
                                    f"（R14 的入口不存在）")
                elif not aps.get("gearHit"):
                    failures.append(f"@{w} app-settings: 齿轮命中测试失败（点不着）")
                if not aps.get("gearAtBottom"):
                    failures.append(f"@{w} app-settings: 齿轮没贴栏底"
                                    f"（用户口径：最左侧工具栏**底端**给一个齿轮按钮）")
                if not aps.get("dialogOpened"):
                    failures.append(f"@{w} app-settings: 点齿轮没打开设置弹窗")
                else:
                    if not aps.get("dialogInViewport"):
                        failures.append(f"@{w} app-settings: 弹窗越出视口（会被裁）")
                    if not aps.get("dialogHit"):
                        failures.append(f"@{w} app-settings: 弹窗命中测试失败（点不着）")
                    if (aps.get("rows") or 0) < 10:
                        failures.append(f"@{w} app-settings: 弹窗里只有 {aps.get('rows')} 个可写项"
                                        f"（规格表没渲染全？）")
                    if (aps.get("readonlyRows") or 0) < 5:
                        failures.append(f"@{w} app-settings: 只读分区只有 {aps.get('readonlyRows')} 项"
                                        f"—— 「哪些不能改」必须如实列出来")
                    if aps.get("readonlyReasons") != aps.get("readonlyRows"):
                        failures.append(f"@{w} app-settings: 只有 {aps.get('readonlyReasons')}/"
                                        f"{aps.get('readonlyRows')} 个只读项写了原因 —— "
                                        f"用户看到「不能改」时必须同时看到为什么")
                    if (aps.get("effectHints") or 0) < 1:
                        failures.append(f"@{w} app-settings: 分区标题上没有「生效时机」说明"
                                        f"（改完到底什么时候生效是这一批的核心承诺）")
                    if not aps.get("overSaveDisabled"):
                        failures.append(f"@{w} app-settings: 填了越界值（999）保存钮还能点")
                    if not aps.get("overError"):
                        failures.append(f"@{w} app-settings: 越界值没有红字提示")
                    if not aps.get("saveEnabled"):
                        failures.append(f"@{w} app-settings: 合法值下保存钮是禁用的（存不了）")
                    # ⚠️ 判据是**再问一次后端**：界面回显可以来自本地草稿，
                    #    "存了没生效"那种坏法照样能让回显正确。
                    if aps.get("afterValue") != 7:
                        failures.append(f"@{w} app-settings: 保存后**服务端**的值是 "
                                        f"{aps.get('afterValue')}，应为 7（界面回显={aps.get('inputValueAfter')!r}）")
                    if not aps.get("badgeShown"):
                        failures.append(f"@{w} app-settings: 改过的项没有「已改过」标记")
                    if aps.get("resetValue") != aps.get("beforeValue"):
                        failures.append(f"@{w} app-settings: 恢复默认后服务端的值是 "
                                        f"{aps.get('resetValue')}，应回到 {aps.get('beforeValue')}")
                    if aps.get("badgeAfterReset"):
                        failures.append(f"@{w} app-settings: 恢复默认后「已改过」标记还在")
                    # ── 主题（R14b）────────────────────────────────────
                    if aps.get("themeOptions") != ["light", "system"]:
                        failures.append(f"@{w} app-settings: 主题选项是 "
                                        f"{aps.get('themeOptions')}，应为 ['light','system']")
                    if not aps.get("themeSystemHit"):
                        failures.append(f"@{w} app-settings: 「跟随系统」按钮点不着")
                    if aps.get("themeServerAfter") != "system":
                        failures.append(f"@{w} app-settings: 选「跟随系统」后**服务端**偏好是 "
                                        f"{aps.get('themeServerAfter')!r}，应为 'system'")
                    if aps.get("themeSelected") != "true":
                        failures.append(f"@{w} app-settings: 选中的按钮没标记成选中"
                                        f"（aria-checked={aps.get('themeSelected')!r}）")
                    # 深色未实现 ⇒ root 必须是 light（挂上 dark 却没有样式 = "切了没反应"）
                    if aps.get("themeRootAttr") != "light":
                        failures.append(f"@{w} app-settings: html[data-theme]="
                                        f"{aps.get('themeRootAttr')!r}，深色未实现时应为 'light'")
                    if aps.get("themeSystemDark") and not aps.get("themeCaveat"):
                        failures.append(f"@{w} app-settings: 系统是深色且深色未实现，但界面"
                                        f"**没有说明** —— 用户会以为「跟随系统」坏了")
                    if aps.get("themeServerRestored") != aps.get("themeServerBefore"):
                        failures.append(f"@{w} app-settings: 主题没还原回 "
                                        f"{aps.get('themeServerBefore')!r}"
                                        f"（实得 {aps.get('themeServerRestored')!r}）")
                    if not aps.get("closedByEsc"):
                        failures.append(f"@{w} app-settings: Esc 没关掉设置弹窗")
            if not failures:
                print("  [ok] 应用设置：齿轮可点 → 弹窗可命中 → 越界被拦 → 保存到服务端 → 恢复默认")
            for b in failures:
                print("   -", b)
            return 1 if failures else 0

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

        if args.scene:
            # 场景切换机（预取门控 + 原子提交）的诊断 + 护栏（devlog/080）。
            # devlog/071 的三次尝试都卡在"进了 scene-exit 但 200ms 提交定时器没落地"，
            # 当时分不清探针环境还是真 bug —— 所以这个模式**先把 fetch 全程打出来**：
            # 预取请求有没有回来，一次就能定性。
            w = widths[0]
            url = f"http://localhost:{vite_port}{route}?probe=scene"
            print(f"[probe] scene @{w} → {url}")
            res = _run_probe(edge, url, w, args.height, WORK, "scene")
            sc = ((res or {}).get("scene") or {})
            if res and not sc:
                print(f"  [!] 探针 mode={res.get('mode')!r} 键={sorted(res.keys())}"
                      f"（新字段需要在 _run_probe 的白名单里登记）")
            print(f"  候选 V={sc.get('candidates')} 目标={sc.get('targetName')!r} "
                  f"点击前 hero={sc.get('heroBefore')!r}")
            print(f"  提交耗时={sc.get('commitMs')}ms 末态 hero={sc.get('heroAtEnd')!r} "
                  f"末态侧栏={sc.get('sidebarActiveAtEnd')!r} 路由={sc.get('routeAtEnd')!r}")
            print(f"  末态仍在退场={sc.get('exitingAtEnd')} body 变化序列={sc.get('bodySeq')}")
            print(f"  在途请求={sc.get('pendingFetches')}")
            for line in (sc.get("fetches") or []):
                print(f"    · {line}")
            for ev in (sc.get("sceneLog") or []):
                print(f"    # {ev}")
            if sc.get("reason") == "sidebar-too-small":
                failures.append(f"@{w} scene: 侧栏少于 2 个 V，量不到场景切换"
                                f"（需要至少两个已订阅 V）")
            elif not failures:
                if (sc.get("commitMs") or -1) < 0:
                    failures.append(f"@{w} scene: 切 V 后 {SCENE_WAIT_HINT} 仍未提交"
                                    f"（hero={sc.get('heroAtEnd')!r}、"
                                    f"仍在退场={sc.get('exitingAtEnd')}、"
                                    f"在途请求={sc.get('pendingFetches')}）")
                if sc.get("exitingAtEnd"):
                    failures.append(f"@{w} scene: 结束时仍停在 scene-exit（退场态未复位）")
                if sc.get("sidebarActiveAtEnd") and sc.get("heroAtEnd") and \
                        sc.get("sidebarActiveAtEnd") != sc.get("heroAtEnd"):
                    failures.append(f"@{w} scene: 侧栏选中与右栏内容不一致"
                                    f"（侧栏={sc.get('sidebarActiveAtEnd')!r} "
                                    f"hero={sc.get('heroAtEnd')!r}）")
                if not failures:
                    print("  [ok] 场景切换：预取→退场→提交全程落地，侧栏与内容一致")
            for b in failures:
                print("   -", b)
            return 1 if failures else 0

        if args.status_island:
            # 顶栏状态岛（R12a，devlog/089）：把三套并存的信息渲染收成一个控件之后，
            # 要钉的是**四态与两条不变量**（空闲无容器 / 展开不挤动右栏）。
            w = widths[0]
            url = f"http://localhost:{vite_port}{route}?probe=status-island"
            print(f"[probe] status-island @{w} → {url}")
            res = _run_probe(edge, url, w, args.height, WORK, "status-island")
            si = ((res or {}).get("statusIsland") or {})
            if res and not si:
                print(f"  [!] 探针 mode={res.get('mode')!r} 键={sorted(res.keys())}"
                      f"（新字段需要在 _run_probe 的白名单里登记）")
            print(f"  空闲：文案={si.get('idleText')!r} 亮起={si.get('idleLit')} "
                  f"计数={si.get('idleCount')} 右栏宽={si.get('spacerIdle')}")
            print(f"  空闲轮播：池={si.get('idleSize')} 三格={si.get('idleTexts')} "
                  f"索引={si.get('idleIndexes')}")
            print(f"  瞬时消息：文案={si.get('litText')!r} 亮起={si.get('litOn')} "
                  f"chevron={si.get('litHasChevron')}")
            print(f"  面板：打开={si.get('panelOpened')} 条目={si.get('panelItems')} "
                  f"种类={si.get('panelKinds')} 文本={si.get('panelItemText')!r} "
                  f"来源={si.get('panelMetaText')!r}")
            print(f"  可命中：面板={si.get('panelHit')} 首条={si.get('panelItemHit')} "
                  f"在视口内={si.get('panelInViewport')} ｜ 展开后右栏宽={si.get('spacerOpen')} "
                  f"Esc 收起={si.get('panelClosedByEsc')}")
            print(f"  入场动画：name={si.get('panelAnimName')!r} "
                  f"{si.get('panelAnimMs')}ms 条数={si.get('panelAnimCount')} "
                  f"｜ reduce={si.get('motionReduced')}")
            print(f"  chevron：transform={si.get('chevronTransform')!r} "
                  f"过渡={si.get('chevronTransitionMs')}ms")
            print(f"  ttl 到期后：文案={si.get('afterTtlText')!r} 亮起={si.get('afterTtlLit')}")
            if not si:
                failures.append(f"@{w} status-island: 没量到状态岛段（探针未跑完？）")
            else:
                if si.get("idleLit"):
                    failures.append(f"@{w} status-island: 空闲态就亮着容器"
                                    f"（文案={si.get('idleText')!r}）—— 用户 2026-09-10 口径："
                                    f"频繁轮询不占顶栏，空闲只有绿点")
                # ── 空闲轮播（R12b）─────────────────────────────────────
                # 语录是**长期驻留**的文案，一旦写成进度词（「…轮询中」），
                # 「自动节拍不占顶栏」那条口径就被文案本身破坏了：顶栏看起来一直在报进度。
                size = si.get("idleSize") or 0
                idxs = si.get("idleIndexes") or []
                texts = si.get("idleTexts") or []
                pool = si.get("idlePool") or []
                if size < 2:
                    failures.append(f"@{w} status-island: 空闲轮播池只有 {size} 格 —— "
                                    f"除了状态文案还得有话可说（`data-idle-size`）")
                if len(pool) != size:
                    failures.append(f"@{w} status-island: 轮播池内容 {len(pool)} 条与池长 {size} 对不上"
                                    f"（`data-idle-pool` 的分隔编码会因此失真）")
                if pool and pool[0] != "数据服务运行中":
                    failures.append(f"@{w} status-island: 轮播第 0 格是 {pool[0]!r}，"
                                    f"应为「数据服务运行中」—— 状态文案不能被语录顶掉"
                                    f"（它是顶栏的看家职责）")
                for t in pool:
                    for bad in ("轮询", "抓取中", "同步"):
                        if bad in (t or ""):
                            failures.append(f"@{w} status-island: 语录 {t!r} 里出现进度词"
                                            f"「{bad}」—— 空闲文案不许长得像任务进度")
                for i, t in enumerate(texts):
                    if not (t or "").strip():
                        failures.append(f"@{w} status-island: 空闲轮播第 {i} 次采样是空的")
                        continue
                    if pool and t not in pool:
                        failures.append(f"@{w} status-island: 第 {i} 次采样文案 {t!r} 不在轮播池里")
                        continue
                    # 索引↔文案必须对得上（越界单独报，别在这里下标越界）
                    ix = idxs[i] if i < len(idxs) else None
                    if pool and ix is not None and 0 <= ix < len(pool) and t != pool[ix]:
                        failures.append(f"@{w} status-island: 第 {i} 次采样文案 {t!r} 与索引 "
                                        f"{ix} 那一格（{pool[ix]!r}）不符")
                for i, ix in enumerate(idxs):
                    if not (0 <= ix < size):
                        failures.append(f"@{w} status-island: 第 {i} 次采样的轮播索引 {ix} "
                                        f"越出池子（0..{size - 1}）")
                if len(texts) == 3 and len(idxs) == 3:
                    steps = [(idxs[i + 1] - idxs[i]) % size if size else 0 for i in range(2)]
                    if any(s < 1 for s in steps):
                        failures.append(f"@{w} status-island: 空闲轮播没在走"
                                        f"（索引 {idxs}，间隔 7s 虚拟时间/档位 6s；"
                                        f"文案 {texts}）—— 用户期望③：空闲时轮播内容")
                    if texts[0] == texts[1] or texts[1] == texts[2]:
                        failures.append(f"@{w} status-island: 空闲文案三轮里出现重复"
                                        f"（{texts}）—— 索引动了但文案没换")
                if not si.get("litOn"):
                    failures.append(f"@{w} status-island: 派发 pill-message 后状态岛没亮起")
                elif "探针消息" not in (si.get("litText") or ""):
                    failures.append(f"@{w} status-island: 亮起后文案仍是 {si.get('litText')!r}，"
                                    f"没换成瞬时消息")
                if not si.get("panelOpened"):
                    failures.append(f"@{w} status-island: 点状态岛没打开通知面板")
                else:
                    if (si.get("panelItems") or 0) < 1:
                        failures.append(f"@{w} status-island: 面板里一条通知都没有")
                    if not si.get("panelHit"):
                        failures.append(f"@{w} status-island: 面板命中测试失败（点不着）")
                    if not si.get("panelItemHit"):
                        failures.append(f"@{w} status-island: 面板里的条目不可命中")
                    if not si.get("panelInViewport"):
                        failures.append(f"@{w} status-island: 面板越出视口（会被裁）")
                    if " · " not in (si.get("panelMetaText") or ""):
                        failures.append(f"@{w} status-island: 条目没有来源标注"
                                        f"（实得 {si.get('panelMetaText')!r}）")
                    # 入场动画（R12b 用户期望②）：按 `prefers-reduced-motion` 判分支。
                    # 探针只认**计算后样式**（CSS 文件里写了不算数，得真挂到面板上）。
                    want = "si-panel-in-fade" if si.get("motionReduced") else "si-panel-in"
                    got = si.get("panelAnimName")
                    if got != want:
                        failures.append(f"@{w} status-island: 面板入场动画是 {got!r}，"
                                        f"应为 {want!r}（reduce={si.get('motionReduced')}）")
                    if (si.get("panelAnimMs") or 0) <= 0:
                        failures.append(f"@{w} status-island: 面板入场动画时长为 "
                                        f"{si.get('panelAnimMs')}ms —— 没有动画等于硬切")
                    if (si.get("panelAnimCount") or 0) < 1:
                        failures.append(f"@{w} status-island: 面板上一条动画都没有挂上"
                                        f"（getAnimations()={si.get('panelAnimCount')}）")
                    # chevron：展开后必须翻转（计算值是**带 -1 的矩阵**）；过渡时长按 reduce 分派 ——
                    # "减少动效"要去掉的是位移/插值，不是状态指示本身。
                    # 注意判据要具体到 -1：过渡中途会量到 identity 矩阵 `matrix(1,0,0,1,0,0)`，
                    # 只判 `!= none` 会把它当成"翻转了"（2026-09-15 实测漂过一次，已派页面等它到位）。
                    chev_tf = si.get("chevronTransform")
                    if not isinstance(chev_tf, str) or "-1" not in chev_tf:
                        failures.append(f"@{w} status-island: 展开后 chevron 没有翻转"
                                        f"（transform={chev_tf!r}）—— "
                                        f"它是「可收起」的唯一指示，reduce 下也不该丢")
                    want_ms = 0 if si.get("motionReduced") else 200
                    if si.get("chevronTransitionMs") != want_ms:
                        failures.append(f"@{w} status-island: chevron 过渡时长是 "
                                        f"{si.get('chevronTransitionMs')}ms，应为 {want_ms}ms"
                                        f"（reduce={si.get('motionReduced')}）")
                if si.get("spacerOpen") != si.get("spacerIdle"):
                    failures.append(f"@{w} status-island: 展开面板挤动了右栏"
                                    f"（右栏宽 {si.get('spacerIdle')} → {si.get('spacerOpen')}；"
                                    f"面板应当 portal + fixed 悬浮）")
                if not si.get("panelClosedByEsc"):
                    failures.append(f"@{w} status-island: Esc 没收起面板")
                if si.get("afterTtlLit"):
                    failures.append(f"@{w} status-island: 瞬时消息过了 ttl 还亮着"
                                    f"（文案={si.get('afterTtlText')!r}）—— 过期条目必须自己消失")
                if not failures:
                    print("  [ok] 状态岛：空闲无容器 / 消息点亮 / 面板可命中不挤动 / Esc 收起 / 过期自清")
            for b in failures:
                print("   -", b)
            return 1 if failures else 0

        if args.reservations:
            # R13 端到端：种好的预约必须**渲染到日历格**并能在 hover 浮层里看到。
            # 断言的是"从 posts.body_json → 服务端解析 → API → 格子/浮层"整条链路，
            # 不是"函数返回了个对象"。
            w = widths[0]
            url = f"http://localhost:{vite_port}{route}?probe=reservations"
            print(f"[probe] reservations @{w} → {url}")
            res = _run_probe(edge, url, w, args.height, WORK, "reservations")
            rv = ((res or {}).get("reservations") or {})
            if res and not rv:
                print(f"  [!] 探针 mode={res.get('mode')!r} 键={sorted(res.keys())}"
                      f"（新字段需要在 _run_probe 的白名单里登记）")
            print(f"  日历格：找到预约格={rv.get('hasResvCell')} 徽章={rv.get('resvBadge')!r} "
                  f"格内文本={rv.get('resvCellText')!r} 计数槽={rv.get('resvCountText')!r}")
            print(f"  hover 浮层：打开={rv.get('popOpened')} 含预约徽章={rv.get('popHasResvBadge')} "
                  f"抬头={rv.get('popHeadText')!r} 预约行={rv.get('popResvText')!r}")
            print(f"  对照：无预约格数={rv.get('plainCellCount')} "
                  f"今天格徽章={rv.get('todayBadge')!r}")
            if not rv:
                failures.append(f"@{w} reservations: 没量到预约段（探针未跑完？）")
            else:
                if not rv.get("hasResvCell"):
                    failures.append(f"@{w} reservations: 日历里找不到带 `data-resv-count` 的格子"
                                    f"（预约没进日历：种的数据没被解析？接口没通？）")
                else:
                    if rv.get("resvBadge") != "预约":
                        failures.append(f"@{w} reservations: 预约格徽章是 {rv.get('resvBadge')!r}，"
                                        f"不是「预约」（无场次但有预约的日子不该报待定/休息）")
                    if "人预约" not in (rv.get("resvCountText") or ""):
                        failures.append(f"@{w} reservations: 计数槽没显示预约人数"
                                        f"（实得 {rv.get('resvCountText')!r}）")
                    if seeded_resv_title and seeded_resv_title not in (rv.get("resvCellText") or ""):
                        failures.append(f"@{w} reservations: 格内文本没出现预约标题"
                                        f"（期望含 {seeded_resv_title!r}，实得 {rv.get('resvCellText')!r}）")
                    if not rv.get("popOpened"):
                        failures.append(f"@{w} reservations: hover 预约格没弹出浮层"
                                        f"（只有预约的日子也该能看详情）")
                    elif not rv.get("popHasResvBadge"):
                        failures.append(f"@{w} reservations: 浮层里没有预约条目")
                    elif "1 预约" not in (rv.get("popHeadText") or ""):
                        failures.append(f"@{w} reservations: 浮层抬头没写「1 预约」"
                                        f"（实得 {rv.get('popHeadText')!r}）")
                    elif seeded_resv_title and seeded_resv_title not in (rv.get("popResvText") or ""):
                        failures.append(f"@{w} reservations: 浮层预约行没出现标题"
                                        f"（实得 {rv.get('popResvText')!r}）")
                if not failures:
                    print("  [ok] 预约进日历：格子徽章/时刻/标题 + hover 浮层条目全部渲染")
            for b in failures:
                print("   -", b)
            return 1 if failures else 0

        if args.polish:
            # R15 三处前端打磨（devlog/087）：三条都是"差 2px 看不出来"的占位/对齐问题，
            # 所以**全部量出来**再断言（②的期望值就是靠这一跑定下来的）。
            w = widths[0]
            url = f"http://localhost:{vite_port}{route}?probe=polish"
            print(f"[probe] polish @{w} → {url}")
            res = _run_probe(edge, url, w, args.height, WORK, "polish")
            po = ((res or {}).get("polish") or {})
            if res and not po:
                print(f"  [!] 探针 mode={res.get('mode')!r} 键={sorted(res.keys())}"
                      f"（新字段需要在 _run_probe 的白名单里登记）")
            print(f"  顶栏标题：字重={po.get('titleFontWeight')} 字距={po.get('titleLetterSpacing')} "
                  f"文本宽={po.get('titleTextWidth')}px（容器 {po.get('titleBoxWidth')}px）")
            print(f"  筛选钮：文字左/右={po.get('filterPadLeft')}/{po.get('filterPadRight')} "
                  f"差={po.get('filterGapDiff')} 文字中心偏移={po.get('filterTextCenterOffset')} "
                  f"｜组左/右={po.get('filterGroupPadLeft')}/{po.get('filterGroupPadRight')} "
                  f"组差={po.get('filterGroupGapDiff')} caret position={po.get('filterCaretPosition')}")
            print(f"  徽标「+」空闲：高度={po.get('pillAddIdleHeight')} 透明度={po.get('pillAddIdleOpacity')} "
                  f"pointer-events={po.get('pillAddIdlePointerEvents')} 可命中={po.get('pillAddIdleHit')} "
                  f"徽标→分割线={po.get('badgeToDividerIdle')}px data-hover={po.get('hoverAttrIdle')}")
            print(f"  徽标「+」hover：data-hover={po.get('hoverAttrAfterEnter')} "
                  f"高度={po.get('pillAddHoverHeight')} 透明度={po.get('pillAddHoverOpacity')} "
                  f"可命中={po.get('pillAddHoverHit')} 徽标→分割线={po.get('badgeToDividerHover')}px "
                  f"离开后 data-hover={po.get('hoverAttrAfterLeave')} 高度={po.get('pillAddAfterLeaveHeight')}")
            if not po:
                failures.append(f"@{w} polish: 没量到打磨段（探针未跑完？）")
            else:
                # ① 顶栏标题：必须真的粗体，且文本不撑破容器
                if str(po.get("titleFontWeight")) not in ("700", "bold"):
                    failures.append(f"@{w} polish: 顶栏标题字重是 {po.get('titleFontWeight')}，不是粗体")
                tw, bw = po.get("titleTextWidth"), po.get("titleBoxWidth")
                if tw and bw and tw > bw - 4:
                    failures.append(f"@{w} polish: 标题文本 {tw}px 顶到容器 {bw}px"
                                    f"（粗体+字距撑破了定宽，右侧会贴/溢出）")
                # ② 筛选钮：**「文字 + caret」这一组**必须居中（用户看的是这一组；
                #    2026-09-15 实测：文字本身早已居中，偏的是被钉在最右角的 caret）
                gdiff = po.get("filterGroupGapDiff")
                if gdiff is None:
                    failures.append(f"@{w} polish: 量不到筛选钮内容间隙（.pfilter-btn 不在？）")
                elif abs(gdiff) > 1.0:
                    failures.append(f"@{w} polish: 筛选钮「文字+箭头」左右间隙差 {gdiff}px"
                                    f"（左 {po.get('filterGroupPadLeft')} / "
                                    f"右 {po.get('filterGroupPadRight')}）")
                toff = po.get("filterTextCenterOffset")
                if toff is not None and abs(toff) > 6.0:
                    failures.append(f"@{w} polish: 筛选钮文字中心偏移 {toff}px"
                                    f"（组居中后文字允许偏半个箭头宽，但不该超过 6px）")
                if po.get("filterCaretPosition") not in (None, "static"):
                    failures.append(f"@{w} polish: 筛选钮 caret 仍是 {po.get('filterCaretPosition')}"
                                    f"定位（会脱离内容组、看起来不居中）")
                # ③ 徽标「+」：空闲不占位且不可点；hover 展开可点；离开复位
                # ⚠️ 高度 0 是**合法值**，不能用 `or -1` 兜底（0 是 falsy，第一版断言
                #    因此把"已复位"误判成失败 —— 判据里的 falsy 陷阱）
                idle_h = po.get("pillAddIdleHeight")
                if po.get("pillAddPresent") and idle_h is not None and idle_h != 0:
                    failures.append(f"@{w} polish: 「+」空闲时高度 {idle_h}px"
                                    f"（要求不占位 = 0；徽章因此贴不到分割线）")
                if po.get("pillAddIdleHit"):
                    failures.append(f"@{w} polish: 「+」不可见却能命中（看不见的可点区域）")
                if po.get("hoverAttrIdle") != "0":
                    failures.append(f"@{w} polish: `.stat-sets` 初始 data-hover="
                                    f"{po.get('hoverAttrIdle')!r}（期望 '0'）")
                if po.get("hoverAttrAfterEnter") != "1":
                    failures.append(f"@{w} polish: 派发 pointerover 后 data-hover 没变成 1"
                                    f"（探针量不到 hover 态，R15③ 就无法验证）")
                elif (po.get("pillAddHoverHeight") or 0) < 36:
                    failures.append(f"@{w} polish: hover 后「+」高度 {po.get('pillAddHoverHeight')}px"
                                    f"（应展开回 37px）")
                elif not po.get("pillAddHoverHit"):
                    failures.append(f"@{w} polish: hover 后「+」仍不可命中（点不着）")
                leave_attr, leave_h = po.get("hoverAttrAfterLeave"), po.get("pillAddAfterLeaveHeight")
                if leave_attr != "0" or leave_h is None or leave_h != 0:
                    failures.append(f"@{w} polish: 指针离开后没复位"
                                    f"（data-hover={leave_attr} 高度={leave_h}）")
                if not failures:
                    print("  [ok] 前端打磨三处：标题粗体不撑破 / 筛选钮文字居中 / 「+」不占位且 hover 可点")
            for b in failures:
                print("   -", b)
            return 1 if failures else 0

        if args.capabilities:
            # 未登录能力提示（devlog/086，P2 的验收）：现场是"有数据但没登录"的数据目录副本。
            # 断言两条相反方向的错法都不犯：
            #   ① **该说的没说**：顶栏入口/说明窗/受限项/"去登录"缺哪个都算失败；
            #   ② **过度限制**：受限功能被藏起来或整片禁掉 ——
            #      用户要的是"未登录也能尽可能用"，所以添加 V 必须**仍能搜出结果**、
            #      批量浮窗里「账号信息」「归档」必须**仍可点**（只有内容类被标需要登录）。
            w = widths[0]
            url = f"http://localhost:{vite_port}{route}?probe=capabilities"
            print(f"[probe] capabilities @{w} → {url}")
            res = _run_probe(edge, url, w, args.height, WORK, "capabilities")
            cp = ((res or {}).get("capabilities") or {})
            if res and not cp:
                print(f"  [!] 探针 mode={res.get('mode')!r} 键={sorted(res.keys())}"
                      f"（新字段需要在 _run_probe 的白名单里登记）")
            print(f"  顶栏入口={cp.get('hasLimitsBtn')} 文案={cp.get('limitsText')!r} "
                  f"受限数={cp.get('limitsCount')}")
            print(f"  说明窗={cp.get('hasLimitsDialog')} 能用项={cp.get('canDoCount')} "
                  f"受限项={cp.get('limitCount')} {cp.get('limitIds')} "
                  f"去登录={cp.get('hasLoginCta')} {cp.get('loginCtaText')!r}")
            print(f"  添加 V：浮窗={cp.get('addVDialogOpened')} 受限提示={cp.get('addVHasLimitHint')} "
                  f"仍能搜出={cp.get('addVRows')} 行（可点 {cp.get('addVEnabledRows')}）")
            print(f"  批量浮窗={cp.get('batchDialogOpened')} "
                  f"全量帖子禁用={cp.get('batchAllPostsDisabled')}"
                  f"(needs_login={cp.get('batchAllPostsNeedsLogin')}) "
                  f"更新未归档禁用={cp.get('batchUpdateDisabled')} "
                  f"归档可用={cp.get('batchArchiveEnabled')} 账号信息可用={cp.get('batchAccountsEnabled')}")
            if not cp:
                failures.append(f"@{w} capabilities: 没量到能力提示段（探针未跑完？）")
            else:
                if not cp.get("hasLimitsBtn"):
                    failures.append(f"@{w} capabilities: 顶栏没有「未登录 · N 项受限」入口"
                                    f"（未登录时用户无从得知限制）")
                elif not (cp.get("limitsCount") or 0):
                    failures.append(f"@{w} capabilities: 入口没有受限计数")
                if not cp.get("hasLimitsDialog"):
                    failures.append(f"@{w} capabilities: 点了入口没打开说明窗")
                else:
                    if (cp.get("canDoCount") or 0) <= 0:
                        failures.append(f"@{w} capabilities: 说明窗**没列『现在能做什么』**"
                                        f"（只列不能做的等于劝退）")
                    if (cp.get("limitCount") or 0) < 2:
                        failures.append(f"@{w} capabilities: 受限项只有 {cp.get('limitCount')} 条"
                                        f"（未登录至少应有内容抓取 + 微博两项）")
                    ids = cp.get("limitIds") or []
                    if "fetch_posts" not in ids:
                        failures.append(f"@{w} capabilities: 受限项里没有 fetch_posts：{ids}")
                    if not cp.get("hasLoginCta"):
                        failures.append(f"@{w} capabilities: 说明窗没有「去登录」入口")
                # ② 过度限制的反面断言
                if not cp.get("addVDialogOpened"):
                    failures.append(f"@{w} capabilities: 未登录时「添加 V」浮窗打不开"
                                    f"（功能被隐藏了？）")
                elif not (cp.get("addVRows") or 0):
                    failures.append(f"@{w} capabilities: 未登录时添加 V 搜不出任何候选"
                                    f"（本地搜索与匿名检索都该可用）")
                elif not (cp.get("addVEnabledRows") or 0):
                    failures.append(f"@{w} capabilities: 添加 V 的结果行全被禁用"
                                    f"（未登录仍应能收录：只有内容抓取受限）")
                if not cp.get("addVHasLimitHint"):
                    failures.append(f"@{w} capabilities: 添加 V 浮窗没说明"
                                    f"「新 V 的投稿与动态要登录后才抓取」")
                if not cp.get("batchDialogOpened"):
                    failures.append(f"@{w} capabilities: 批量任务浮窗打不开")
                else:
                    if not cp.get("batchAllPostsDisabled") or cp.get("batchAllPostsNeedsLogin") != "1":
                        failures.append(f"@{w} capabilities: 未登录时「全量抓取帖子」没标需要登录/没禁用"
                                        f"（点了会被后端 403）")
                    if not cp.get("batchUpdateDisabled"):
                        failures.append(f"@{w} capabilities: 未登录时「更新未归档帖」没禁用")
                    if not cp.get("batchArchiveEnabled"):
                        failures.append(f"@{w} capabilities: 未登录时「归档旧帖」被禁用了"
                                        f"（它不需要登录，属于过度限制）")
                    if not cp.get("batchAccountsEnabled"):
                        failures.append(f"@{w} capabilities: 未登录时「账号信息」被禁用了"
                                        f"（实测匿名可用，属于过度限制）")
                if not failures:
                    print("  [ok] 未登录能力提示：该说的都说了，且功能没被过度限制")
            for b in failures:
                print("   -", b)
            return 1 if failures else 0

        if args.add_v:
            # 「添加 V」浮窗（R11，devlog/083）：本地候选 + B 站在线检索两个来源。
            # 这里断言的是**来源分流**，不是长相：
            #   ① 敲键只打本地（`/vtuber/pool/search`），**一次都不打** `/vtuber/bili/search`
            #      —— 决策①"B 站检索必须显式触发"的机器判据。少了它，日后有人把 B 站
            #      检索接回"输入即搜"，探针仍会全绿，而风控预算会被无声烧掉。
            #   ② 结果行命中测试：看得见必须点得着（这类浮窗出过 pointer-events 被吃掉）。
            #   ③ 纯数字（UID）输入换档：按钮变「按 UID 添加」且可点（uid 不走搜索接口，
            #      走 `acc/info` 精确通道，用户得能从按钮上看出来）。
            w = widths[0]
            url = f"http://localhost:{vite_port}{route}?probe=addv"
            print(f"[probe] add-v @{w} → {url}")
            res = _run_probe(edge, url, w, args.height, WORK, "addv")
            av = ((res or {}).get("addv") or {})
            if res and not av:
                print(f"  [!] 探针 mode={res.get('mode')!r} 键={sorted(res.keys())}"
                      f"（新字段需要在 _run_probe 的白名单里登记）")
            print(f"  入口={av.get('hasTrigger')} 打开={av.get('opened')} "
                  f"结果区=OverlayScroll {av.get('listIsOverlayScroll')} "
                  f"输入左内距={av.get('inputLeftPad')}（给图标留位={av.get('inputIconRoom')}）")
            print(f"  空态 B 站钮: 禁用={av.get('biliBtnDisabledWhenEmpty')} "
                  f"文案={av.get('biliBtnText')!r}")
            print(f"  关键词={av.get('keyword')!r} 结果行={av.get('rows')} "
                  f"置灰行={av.get('rowsDisabled')} 行可命中={av.get('rowHit')} "
                  f"行带 uid={av.get('rowHasUid')}")
            print(f"  来源→收录路径={av.get('pathCounts')} "
                  f"索引行误走池内={av.get('indexRowsToPool')}（必须 0）")
            print(f"  本地检索真的发生={av.get('localSearchHappened')} "
                  f"（pool 请求 {av.get('poolRequestsBeforeTyping')} → "
                  f"{av.get('poolRequestsAfterTyping')}）· "
                  f"敲键打上游={av.get('biliRequests')} 次（必须 0）")
            print(f"  UID 换档: 文案={av.get('uidBtnText')!r} 可点={av.get('uidBtnEnabled')} "
                  f"清空={av.get('clearOk')} 清空后行数={av.get('afterClearRows')} "
                  f"回提示={av.get('afterClearHint')} 关窗={av.get('closed')} "
                  f"全程上游请求={av.get('biliRequestsTotal')} 次")
            if av.get("reason") == "no-add-trigger":
                failures.append(f"@{w} add-v: 侧栏找不到「添加 V」钮（.list-add-btn）")
            elif av.get("reason") == "dialog-not-opened":
                failures.append(f"@{w} add-v: 点了「添加 V」但浮窗（.av-dialog）没出现")
            elif not av.get("opened"):
                failures.append(f"@{w} add-v: 没打开「添加 V」浮窗（探针未量到 addv 段）")
            else:
                if not av.get("inputIconRoom"):
                    failures.append(f"@{w} add-v: 输入框左内距只有 {av.get('inputLeftPad')}，"
                                    f"没给 14px 的内嵌搜索图标留位（图标会压字）")
                if not av.get("listIsOverlayScroll"):
                    failures.append(f"@{w} add-v: 结果区不是覆盖式滚动条"
                                    f"（要求 .av-list.os-root > .os-scroll：原生滚动条会挤动布局）")
                if not av.get("biliBtnDisabledWhenEmpty"):
                    failures.append(f"@{w} add-v: 空输入时「搜索 B 站」钮仍可点"
                                    f"（没关键词就没什么可搜的）")
                if av.get("rowsSkipped"):
                    print(f"  [跳过] 行级断言：{av.get('rowsSkipped')}"
                          f"（本地候选池没命中，数据形态问题而非回归）")
                else:
                    if not av.get("rows"):
                        failures.append(f"@{w} add-v: 输入 {av.get('keyword')!r} 后一行候选都没有"
                                        f"（本地检索链路断了？）")
                    if not av.get("localSearchHappened"):
                        failures.append(f"@{w} add-v: 敲键后没有发出本地检索请求"
                                        f"（pool 请求数没有增长）")
                    if av.get("biliRequests"):
                        failures.append(f"@{w} add-v: **敲键就打了 B 站上游** "
                                        f"{av.get('biliRequests')} 次 —— "
                                        f"决策①是「显式触发才检索」（fuzzy 搜索必须回车/点按钮）")
                    if not av.get("rowHit"):
                        failures.append(f"@{w} add-v: 结果行命中测试失败"
                                        f"（行被挡住或 pointer-events 被祖先吃掉）")
                    if (av.get("rowsDisabled") or 0) > 0:
                        failures.append(f"@{w} add-v: 本地候选里有 {av.get('rowsDisabled')} 行被置灰"
                                        f"（后端已剔除已入库账号，本地行应当都能点）")
                    # 来源 → 收录路径：索引来源被标成 pool 就是"点一下必 404"（实测过的 bug）
                    if (av.get("indexRowsToPool") or 0) > 0:
                        failures.append(f"@{w} add-v: {av.get('indexRowsToPool')} 条**索引来源**"
                                        f"的行带着 `source=pool` 且可点 —— 后端 find_in_pool 会 miss，"
                                        f"点了必然 404「候选池中不存在该 platform_uid」"
                                        f"（实测分布：{av.get('pathCounts')}）")
                    if (av.get("enabledWithoutSource") or 0) > 0:
                        failures.append(f"@{w} add-v: 有 {av.get('enabledWithoutSource')} 条可点行"
                                        f"没带 data-adopt-source（分流属性丢了）")
                    if not any(str(k).startswith("index→") for k in (av.get("pathCounts") or {})):
                        print("  [注] 本次没量到索引来源的行（关键词命中不到索引条目）"
                              "—— 上面那条断言本轮空过")
                # UID 换档 / 清空 / 关窗：**不依赖关键词命中**（只跟输入框与按钮有关），
                # 所以放在行级断言之外 —— 否则本地池没命中时这几条会一起空转。
                if not av.get("uidSwitchOk"):
                    failures.append(f"@{w} add-v: 输入纯数字 UID 后按钮文案是 "
                                    f"{av.get('uidBtnText')!r}，不是「按 UID 添加」"
                                    f"（uid 不走搜索接口，用户得看得出来）")
                if not av.get("uidBtnEnabled"):
                    failures.append(f"@{w} add-v: UID 输入态「按 UID 添加」钮不可点")
                if not av.get("clearOk"):
                    failures.append(f"@{w} add-v: 点清空钮后输入框没清空")
                if (av.get("afterClearRows") or 0) > 0:
                    failures.append(f"@{w} add-v: 清空后候选行仍留在界面上"
                                    f"（{av.get('afterClearRows')} 行）")
                if not av.get("closed"):
                    failures.append(f"@{w} add-v: 点 X 没能关掉浮窗")
                if av.get("biliRequestsTotal"):
                    failures.append(f"@{w} add-v: 探针全程出现了 {av.get('biliRequestsTotal')} 次"
                                    f" `/vtuber/bili/search` 请求 —— 本模式刻意不触发上游检索，"
                                    f"出现即说明有非显式触发路径")
                if not failures:
                    print("  [ok] 添加 V 浮窗：本地/上游分流、行可点、UID 换档全部通过")
            for b in failures:
                print("   -", b)
            return 1 if failures else 0

        if args.settings:
            # 档案设置弹窗的几何与**可点性**不变量（devlog/072 起；可点性判据 devlog/075）。
            # 这个弹窗此前无探针覆盖，而它出过：滚动条压输入框、浮层被滚动体静默裁掉、
            # 以及"面板看得见却点不着"（portal 继承了 radix 给 body 的 pointer-events:none）。
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
                  f"父级=弹窗内容体={st.get('panelParentIsDialog')} "
                  f"在滚动体之外={st.get('panelOutsideScroller')} "
                  f"按输入条定位={st.get('panelPlacedByRect')} "
                  f"收起态面板宽度={st.get('panelWidthWhenClosed')}")
            print(f"  再点收起={st.get('toggleClosedOk')} 再点重开={st.get('toggleReopenOk')} "
                  f"面板 DOM 数={st.get('openPanelCount')}")
            print(f"  命中测试: 面板={st.get('panelHit')} 候选行={st.get('rowHit')}")
            print(f"  矩形: 输入条={st.get('inputRect')} 面板={st.get('panelRect')} "
                  f"弹窗={st.get('dialogRect')} 面板 offsetParent=内容体="
                  f"{st.get('panelOffsetParentIsDialog')}")
            print(f"  视口={st.get('viewport')} 面板样式={st.get('panelStyleInline')}")
            print(f"  账号信息历史: 有入口={st.get('hasHistoryBtn')} 打开={st.get('historyOpened')} "
                  f"曾用值行={st.get('historyFormerRows')} 快照行={st.get('historySnapRows')} "
                  f"空态={st.get('historyEmpty')} 关闭={st.get('historyClosed')} "
                  f"（档案设置仍开着={st.get('settingsStillOpen')}）")
            print(f"  点击候选行: 换到别的行={st.get('pickTargetIsOther')} "
                  f"值={'…' if st.get('pickedValue') is None else str(st.get('pickedValue'))[:18]} "
                  f"值匹配={st.get('pickValueMatches')} 真的变了={st.get('pickChanged')} "
                  f"面板收起={st.get('pickClosedPanel')} 弹窗仍在={st.get('pickKeepsDialog')} "
                  f"已还原来源={st.get('restoredSource')}")
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
                # 结构 + 相对位置：面板挂在弹窗内容体下、在滚动体之外、位置按输入条算。
                # ⚠️ 别再改回 portal+fixed：那样会继承 radix 给 body 的 pointer-events:none
                #    （hover/点击全失灵），或落回"弹窗之外"（点行把弹窗关掉）。
                if st.get("panelPosition") != "absolute" or not st.get("panelParentIsDialog"):
                    failures.append(f"@{w} settings: 面板不是「弹窗内容体的绝对定位子元素」"
                                    f"（position={st.get('panelPosition')} "
                                    f"父级=内容体={st.get('panelParentIsDialog')}）")
                if not st.get("panelOutsideScroller"):
                    failures.append(f"@{w} settings: 面板落在滚动体里面（会被 overflow:hidden 裁）")
                if not st.get("panelPlacedByRect"):
                    failures.append(f"@{w} settings: 面板没有贴在输入条下方（相对包含块算错了？）")
                # 可点性：命中测试是"看得见却点不着"的唯一机器判据
                if not st.get("panelHit"):
                    failures.append(f"@{w} settings: 面板命中测试失败 —— "
                                    f"elementFromPoint 打不到面板（pointer-events 被祖先吃掉？）")
                if not st.get("rowHit"):
                    failures.append(f"@{w} settings: 候选行命中测试失败（行被挡住或不可点）")
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
                # 真点一行：必须换到那一行的签名，且**不能把整个弹窗关掉**。
                # 只有一个带签名账号的 V（如 V14）没有"另一行"，据此跳过切换断言。
                if st.get("pickSkipped"):
                    print(f"  [跳过] 候选行切换断言：{st.get('pickSkipped')}"
                          f"（该 V 只有 {st.get('rows')} 行，无「另一行」可点）")
                elif not st.get("pickTargetIsOther"):
                    failures.append(f"@{w} settings: 找不到「另一行」可点"
                                    f"（该 V 至少要有两个带签名的平台账号才测得到来源切换）")
                if not st.get("pickValueMatches"):
                    failures.append(f"@{w} settings: 点了候选行但输入框没有变成那行的签名"
                                    f"（值={st.get('pickedValue')!r} 期望={st.get('pickTargetText')!r}）")
                if not st.get("pickClosedPanel"):
                    failures.append(f"@{w} settings: 选完候选行后面板没收起")
                if not st.get("pickKeepsDialog"):
                    failures.append(f"@{w} settings: 点候选行把**整个弹窗**关掉了"
                                    f"（radix 把面板当成了「弹窗之外」）")
                if st.get("pickChanged") and not st.get("restoredSource"):
                    failures.append(f"@{w} settings: 探针没能把签名来源还原"
                                    f"（数据目录会残留「来源被换过」的副作用）")
                # R9（devlog/080）：账号信息历史弹窗必须真的能打开、能拿到数据、能关掉
                if not st.get("hasHistoryBtn"):
                    failures.append(f"@{w} settings: 账号行上没有「账号信息历史」入口"
                                    f"（R9 的展示入口）")
                elif not st.get("historyOpened"):
                    failures.append(f"@{w} settings: 点了历史钮但弹窗没出现")
                elif (st.get("historySnapRows") or 0) <= 0 and not st.get("historyEmpty"):
                    failures.append(f"@{w} settings: 历史弹窗既没有快照行也没有空态提示"
                                    f"（数据没渲染出来？快照={st.get('historySnapRows')}）")
                elif not st.get("settingsStillOpen"):
                    failures.append(f"@{w} settings: 打开历史弹窗把**档案设置**关掉了"
                                    f"（嵌套弹窗层级问题）")
                elif not st.get("historyClosed"):
                    failures.append(f"@{w} settings: 历史弹窗点「关闭」没关掉")
                if not failures:
                    print("  [ok] 档设置弹窗几何与可点性不变量全部通过")
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
                f"external={tb.get('externalRunning')}/{tb.get('externalLabel')!r} "
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