"""端到端上游冒烟：**数据目录副本 + 真后端 + 真上游**跑一遍只有真环境才暴露的链路。

## 为什么需要它（devlog/085）

2026-09-15 那次 R11 开发里，我写了 5 个一次性临时脚本，其中 3 个产出了决定性证据
（"未登录会怎样""索引条目是否真的不在候选池里""池外收录 404 → 201"）——**但它们跑完就删了**。
于是同一类问题（"上游/登录态/真数据形态"）下次还得靠**用户实测**才发现。

本脚本把那些临时脚本固化成常驻护栏，并且专门编码两条纪律：

1. **冷进程**（`--cold`）：凡"某情况下也能/不能工作"的结论，必须在**空数据目录 + 全新进程**
   里复现一次。R11 的"不需要登录"就是缺了这一步：当时在 WBI 密钥已缓存 / 带已登录 `.env`
   的环境里测的，结论完全反过来。
2. **真实现场**：默认模式全程打真上游、走真 HTTP、用**开发数据目录的副本**（不是真库），
   所以"上游到底返回什么形态"不用猜。

## 用法

    python scripts/smoke_upstream.py                 # 默认检查（B 站检索 + 池外收录 + 场次上游）
    python scripts/smoke_upstream.py --only bili     # 只跑名字里含 bili 的检查
    python scripts/smoke_upstream.py --cold          # 冷进程/空数据目录：断言"未登录时的降级形态"
    python scripts/smoke_upstream.py --capture       # 顺带把真实回包刷进 tests/fixtures/
    python scripts/smoke_upstream.py --list          # 只列检查名

接进一把梭：`python scripts/dev_check.py --upstream`

## 判定口径（skip 与 fail 分得很清）

- `[ok]`   真验到了；
- `[skip]` **因为环境不成立而没验到**（未登录 / 上游此刻不可用）——**必须打印原因**，
  绝不冒充通过（本仓"探针空转却全绿"踩过三次）；
- `[FAIL]` 链路真的坏了（HTTP 5xx、结构不对、状态码与设计不符）。

⚠️ 池外收录检查会**在副本里真的建一个 V**（因此绝不是真库；副本每次重建）。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import ui_probe  # noqa: E402  （复用它的"数据目录副本 + 起后端 + 空闲端口"）

FIXTURES = ROOT / "tests" / "fixtures"
OK, SKIP, FAIL = "[ok]", "[skip]", "[FAIL]"


class Ctx:
    def __init__(self, base: str, data_dir: Path, capture: bool, cold: bool):
        self.base = base
        self.data_dir = data_dir
        self.capture = capture
        self.cold = cold
        self.results: list[tuple[str, str, str]] = []      # (状态, 名字, 说明)
        self.fixtures_written: list[str] = []

    # ── HTTP ──
    def get(self, path: str, timeout: float = 90.0):
        with urllib.request.urlopen(f"{self.base}{path}", timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))

    def post(self, path: str, payload: dict, timeout: float = 120.0):
        req = urllib.request.Request(f"{self.base}{path}", method="POST",
                                     data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(body or "{}")
            except json.JSONDecodeError:
                return e.code, {"detail": body[:200]}

    def record(self, status: str, name: str, detail: str) -> None:
        self.results.append((status, name, detail))
        print(f"  {status} {name}: {detail}")

    def write_fixture(self, name: str, payload) -> None:
        if not self.capture:
            return
        FIXTURES.mkdir(parents=True, exist_ok=True)
        path = FIXTURES / name
        text = payload if isinstance(payload, str) else \
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        path.write_text(text, encoding="utf-8", newline="\n")
        self.fixtures_written.append(name)


# ── 检查项 ────────────────────────────────────────────────────────────

def check_bili_search_name(ctx: Ctx) -> None:
    """名称模糊搜：真打 B 站，验证"能搜到"这条链路（未登录则 skip，不算通过）。"""
    status, body = ctx.get("/vtuber/bili/search?kw=" + urllib.parse.quote("塔菲"))
    if status != 200:
        ctx.record(FAIL, "bili_search_name", f"HTTP {status}: {str(body)[:120]}")
        return
    if body.get("error"):
        detail = f"error={body['error']!r} hint={body.get('hint')!r}"
        ctx.record(SKIP if body["error"] in ("not_logged_in",) else FAIL,
                   "bili_search_name", detail + ("（未登录 → 环境不成立，不是链路坏）"
                                                 if body["error"] == "not_logged_in" else ""))
        return
    items = body.get("items") or []
    if not items:
        ctx.record(FAIL, "bili_search_name", "200 但 0 条 —— 上游形态变了？")
        return
    top = items[0]
    ctx.record(OK, "bili_search_name",
               f"{len(items)} 条 / numPages={body.get('total_pages')} / 首位={top['name']!r}"
               f"(uid {top['platform_uid']}, {top['followers']} 粉)")
    ctx.write_fixture("bili_search_endpoint.json", {
        "captured_from": "GET /vtuber/bili/search?kw=塔菲（真上游，经本服务映射）",
        "captured_at": time.strftime("%Y-%m-%d"),
        "body": {**body, "items": items[:5]},
    })


def check_bili_exact_uid(ctx: Ctx) -> None:
    """UID 直查：搜索接口搜不到 uid，必须走 acc/info 精确通道。"""
    uid = "1265680561"
    status, body = ctx.get(f"/vtuber/bili/search?kw={uid}")
    if status != 200:
        ctx.record(FAIL, "bili_exact_uid", f"HTTP {status}: {str(body)[:120]}")
        return
    if body.get("error"):
        ctx.record(SKIP if body["error"] == "not_logged_in" else FAIL, "bili_exact_uid",
                   f"error={body['error']!r} hint={body.get('hint')!r}")
        return
    items = body.get("items") or []
    ok = bool(items) and body.get("exact") is True and str(items[0]["platform_uid"]) == uid
    ctx.record(OK if ok else FAIL, "bili_exact_uid",
               f"exact={body.get('exact')} 条数={len(items)} 名称={items[0]['name']!r}"
               if items else "0 条（UID 通道没走通？）")


def _find_index_row(ctx: Ctx, keywords: list[str]) -> dict | None:
    """在候选池检索里找一条**索引来源**（即不在 csv 池里）的条目 —— 池外收录的现场。"""
    for kw in keywords:
        try:
            status, rows = ctx.get("/vtuber/pool/search?kw=" + urllib.parse.quote(kw))
        except Exception as e:                                    # noqa: BLE001
            print(f"    （关键词 {kw!r} 检索失败：{type(e).__name__}: {e}）")
            continue
        if status != 200 or not isinstance(rows, list):
            continue
        for row in rows:
            if row.get("origin") == "index" and row.get("platform") == "bilibili":
                return row
    return None


def check_pool_search_labels(ctx: Ctx) -> None:
    """候选池检索的两个来源标注（`origin`）必须齐全 —— 前端按它决定收录路径。"""
    status, rows = ctx.get("/vtuber/pool/search?kw=" + urllib.parse.quote("a"))
    if status != 200 or not isinstance(rows, list) or not rows:
        ctx.record(FAIL, "pool_search_labels", f"HTTP {status}，返回 {type(rows).__name__}")
        return
    bad = [r for r in rows if r.get("origin") not in ("pool", "index")]
    counts = {o: sum(1 for r in rows if r.get("origin") == o) for o in ("pool", "index")}
    if bad:
        ctx.record(FAIL, "pool_search_labels", f"{len(bad)} 条没带合法 origin（前端无法分流）")
        return
    ctx.record(OK, "pool_search_labels", f"{len(rows)} 条 / 来源分布={counts}")


def check_pool_external_adopt(ctx: Ctx) -> None:
    """**池外收录**（用户实测报过的那条链路，devlog/083 §十一）：

    索引来源的条目不在 csv 池里 ⇒ 不带 source 必须 404（"池内查不到"），
    带 `source='bilibili'` 必须 201（服务端实查 acc/info 复核后建库），再点一次 409。
    """
    row = _find_index_row(ctx, ["以太", "a", "i", "小"])
    if not row:
        ctx.record(SKIP, "pool_external_adopt",
                   "本地索引里没找到「不在池内」的条目（换关键词或等索引更新）")
        return
    uid, name = str(row["platform_uid"]), row.get("name")
    payload = {"platform": row["platform"], "platform_uid": uid}

    code, body = ctx.post("/vtuber/adopt", payload)
    if code != 404:
        ctx.record(FAIL, "pool_external_adopt",
                   f"不带 source 期望 404（池内查不到），实得 {code} {str(body)[:100]}")
        return
    code2, body2 = ctx.post("/vtuber/adopt", {**payload, "source": "bilibili"})
    if code2 != 201:
        detail = str(body2.get("detail") or body2)[:140]
        ctx.record(SKIP if code2 == 503 else FAIL, "pool_external_adopt",
                   f"带 source='bilibili' 期望 201，实得 {code2}：{detail}")
        return
    code3, _ = ctx.post("/vtuber/adopt", {**payload, "source": "bilibili"})
    ok = code3 == 409
    ctx.record(OK if ok else FAIL, "pool_external_adopt",
               f"索引条目 {name!r}(uid {uid})：不带 source→404、带 source→201 "
               f"（服务端复核名={body2.get('name')!r}）、重复→{code3}")
    ctx.write_fixture("pool_search_index_row.json", {
        "captured_from": "GET /vtuber/pool/search + 池外收录实测（真上游复核）",
        "captured_at": time.strftime("%Y-%m-%d"),
        "row": {**row, "in_pool": False},
        "note": "origin='index' 的条目**不在 vtubers.csv 里**：前端必须送 source='bilibili'",
    })


def check_live_upstream(ctx: Ctx) -> None:
    """场次级第三方取数（danmakus）：断言**结构 + 降级口径**，上游不可用时 skip。

    三种结果各有含义（devlog/063）：`upstream` / `upstream_absent` = 真拿到了；
    `fetch_failed` = **我们没拉到**（上游此刻不行 → skip 而不是 fail，也不许当成"没弹幕"）；
    `no_danmaku` = 本场没有 danmakus 收录（与"拉取失败"必须区分）。
    """
    status, vtubers = ctx.get("/vtuber/list")
    if status != 200 or not vtubers:
        ctx.record(SKIP, "live_upstream", "库里没有 V（数据目录副本是空的？）")
        return
    acc = next((a for v in vtubers for a in (v.get("accounts") or [])
                if a.get("platform") == "bilibili"), None)
    if not acc:
        ctx.record(SKIP, "live_upstream", "没有 bilibili 账号")
        return
    _, sessions = ctx.get(f"/account/{acc['id']}/live-sessions")
    items = sessions if isinstance(sessions, list) else (sessions.get("items") or [])
    sess = next((s for s in items if (s.get("source") or "").startswith("danmakus")), None)
    if not sess:
        ctx.record(SKIP, "live_upstream", "该账号没有 danmakus 来源的场次")
        return

    code, body = ctx.get(f"/account/{acc['id']}/live-sessions/{sess['live_id']}/upstream")
    if code != 200:
        ctx.record(FAIL, "live_upstream", f"HTTP {code}: {str(body)[:120]}")
        return
    dm = body.get("danmaku") or {}
    wc = dm.get("wc_status")
    metrics, events = body.get("metrics"), body.get("events")
    where = f"场次 {sess['live_id'][:8]} wc_status={wc!r}"

    if wc == "fetch_failed":
        ctx.record(SKIP, "live_upstream", where + " —— 上游此刻取不到（环境问题，非链路坏）")
    elif wc == "no_danmaku":
        # 我挑的是 danmakus 来源的场次：这里报"没有可统计弹幕"说明两处口径不一致，值得看一眼
        ctx.record(SKIP, "live_upstream", where + " —— 与场次来源标注不一致（供排查）")
    elif wc in ("upstream", "upstream_absent"):
        if not isinstance(events, list):
            ctx.record(FAIL, "live_upstream", where + f" 但 events 不是列表（{type(events).__name__}）")
        elif metrics is not None and not isinstance(metrics, dict):
            ctx.record(FAIL, "live_upstream", where + f" 但 metrics 类型不对（{type(metrics).__name__}）")
        else:
            words = len(dm.get("word_cloud") or [])
            ctx.record(OK, "live_upstream",
                       where + f" · 热词 {words} · metrics={'有' if metrics else '无'}"
                              f" · events {len(events)}")
    else:
        ctx.record(FAIL, "live_upstream", where + " —— 不在设计的四种状态里")


def check_cold_degradation(ctx: Ctx) -> None:
    """冷进程/空数据目录：**未登录时的降级形态**（R11 两个错结论的回归护栏）。

    断言的是"设计形态"，不是"能不能用"：
    1. B 站检索 → 200 + `error='not_logged_in'` + 有 hint（**不是 500**）；
    2. 池外收录 → 503 + hint 提到登录（**不是 404「没有这个 UID」、不是 500**）；
    3. 本地候选检索 → 200。

    ⚠️ 两个**实测澄清**（2026-09-15，都是本检查第一次跑出来的）：

    - **"空数据目录"不等于"候选池为空"**：`backend_main.py` 首启会把随包分发的
      `vtubers.csv` 引导复制进数据目录（"首次运行时把随包分发的 vtubers.csv 引导复制"）。
      所以池内 uid 仍然命中、走**池内路径**（`来源=pool`）—— 池外收录检查必须挑一个
      **不在池里**的 uid，否则它测的根本不是池外通道。
    - 凭证要**显式清空**才算冷：本机 shell 里若残留 `BILI_SESSDATA` 等，子进程会继承
      （`config.py` 读 `os.getenv`）→ 测出来的是"登录态"，不是"未登录态"。
    """
    status, body = ctx.get("/vtuber/bili/search?kw=" + urllib.parse.quote("塔菲"))
    if status != 200:
        ctx.record(FAIL, "cold_bili_search", f"期望 200 + not_logged_in，实得 HTTP {status}")
    elif body.get("error") != "not_logged_in":
        ctx.record(FAIL if not body.get("items") else SKIP, "cold_bili_search",
                   f"空数据目录下 error={body.get('error')!r}（期望 not_logged_in）"
                   if not body.get("items") else "居然搜到了（凭证没清干净？）")
    else:
        ctx.record(OK, "cold_bili_search",
                   f"200 + error='not_logged_in' + hint={(body.get('hint') or '')[:34]}…")

    # 池外通道：uid 必须**不在候选池里**，否则走的是池内路径（见 docstring）
    uid = _uid_not_in_pool(ctx)
    if uid is None:
        ctx.record(SKIP, "cold_pool_external_adopt", "找不到池外 uid（池检索异常）")
    else:
        code, payload = ctx.post("/vtuber/adopt",
                                 {"platform": "bilibili", "platform_uid": uid,
                                  "source": "bilibili"})
        if code == 503 and "登录" in str(payload.get("detail") or ""):
            ctx.record(OK, "cold_pool_external_adopt",
                       f"uid {uid}（池外）→ 503 + 登录提示：{payload['detail'][:30]}…")
        elif code == 404:
            ctx.record(FAIL, "cold_pool_external_adopt",
                       "未登录被报成 404「没有这个 UID」—— 正是要避免的误导（devlog/083 §十）")
        else:
            ctx.record(FAIL, "cold_pool_external_adopt",
                       f"期望 503，实得 {code} {str(payload)[:100]}")

    status3, rows = ctx.get("/vtuber/pool/search?kw=a")
    ok3 = status3 == 200 and isinstance(rows, list)
    ctx.record(OK if ok3 else FAIL, "cold_pool_search",
               f"HTTP {status3}，{len(rows) if isinstance(rows, list) else '?'} 条"
               f"（纯本地链路，任何时候都该通；csv 由首启引导复制进来）")


def _uid_not_in_pool(ctx: Ctx) -> str | None:
    """找一个候选池里确实没有的 uid（池检索对纯数字按 uid 前缀匹配，所以空结果=池外）。"""
    for uid in ("8888888888", "7777777777", "6666666666"):
        try:
            status, rows = ctx.get(f"/vtuber/pool/search?kw={uid}")
        except Exception:                                        # noqa: BLE001
            return None
        if status == 200 and isinstance(rows, list) and not rows:
            return uid
    return None


CHECKS = {
    "bili_search_name": check_bili_search_name,
    "bili_exact_uid": check_bili_exact_uid,
    "pool_search_labels": check_pool_search_labels,
    "pool_external_adopt": check_pool_external_adopt,
    "live_upstream": check_live_upstream,
}
COLD_CHECKS = {"cold_degradation": check_cold_degradation}


def _capture_raw_upstream(ctx: Ctx) -> None:
    """把 B 站搜索接口的**原始回包**（未映射）存成 fixture。

    为什么要原始回包：`map_search_item` 的字段映射（`mid`/`uname`/`fans`/`official_verify.desc`…）
    只有拿真形状才测得准 —— 上游哪天改字段名，用真 fixture 的单测会立刻红，
    而用自造样本的测试照样绿（R11 的"打平判据"就是这么漏的）。
    """
    if not ctx.capture:
        return
    # 懒导入 + 先设 DATA_DIR：app 模块在导入时读环境变量（否则拿到的是真库配置）；
    # 仓库根也要进 sys.path（脚本跑起来时 sys.path[0] 是 scripts/，`import app` 会找不到）
    os.environ["DDTOOLKIT_DATA_DIR"] = str(ctx.data_dir)
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    try:
        import asyncio
        import urllib.parse as up

        import httpx

        from app.core.http import new_async_client
        from app.services import bili_search as bs
        from app.services import wbi

        async def fetch_raw():
            params = await wbi.sign_params({"search_type": "bili_user", "keyword": "塔菲",
                                            "page": 1})
            url = f"{bs.SEARCH_URL}?{up.urlencode(params)}"
            async with new_async_client(15.0) as c:
                r = await c.get(url, headers=bs._headers("塔菲"))
                return r.json()

        body = asyncio.run(fetch_raw())
        if body.get("code") != 0:
            print(f"  [注] 原始回包 code={body.get('code')!r}（未登录？）→ 跳过原始 fixture")
            return
        raw = body.get("data", {}).get("result") or []
        trimmed = {
            "captured_from": "https://api.bilibili.com/x/web-interface/wbi/search/type"
                             "?search_type=bili_user&keyword=塔菲（原始回包，未映射）",
            "captured_at": time.strftime("%Y-%m-%d"),
            "code": body.get("code"), "message": body.get("message"),
            "data": {**{k: v for k, v in body.get("data", {}).items() if k != "result"},
                     "result": raw[:3]},
        }
        ctx.write_fixture("bili_user_search_raw.json", trimmed)
        print(f"  [注] 原始回包 fixture：{len(raw[:3])} 条（上游共 {len(raw)} 条）")
    except Exception as e:                                        # noqa: BLE001
        print(f"  [注] 原始回包捕获失败（{type(e).__name__}: {e}）→ 跳过该 fixture")


def _capture_nsis_fixture(ctx: Ctx) -> None:
    """把真实 `installer.nsi` 的若干行存成 fixture（NSIS 判据要有真形状可测）。"""
    if not ctx.capture:
        return
    nsi = ROOT / "frontend" / "src-tauri" / "target" / "release" / "nsis" / "x64" / "installer.nsi"
    if not nsi.exists():
        print("  [注] 本机没有构建产物 installer.nsi，跳过该 fixture")
        return
    lines = [l for l in nsi.read_text(encoding="utf-8", errors="replace").splitlines()
             if "oname=binaries" in l][:12]
    ctx.write_fixture("nsis_installer_excerpt.txt", "\n".join(lines) + "\n")
    print(f"  [注] NSIS fixture: {len(lines)} 行真实内容")


def main() -> int:
    ap = argparse.ArgumentParser(description="端到端上游冒烟（数据目录副本 + 真后端 + 真上游）")
    ap.add_argument("--cold", action="store_true",
                    help="空数据目录 + 全新进程：断言未登录时的降级形态（不是测「能不能用」）")
    ap.add_argument("--only", default="", help="只跑名字里含该子串的检查")
    ap.add_argument("--list", action="store_true", help="只列检查名")
    ap.add_argument("--capture", action="store_true", help="把真实回包刷进 tests/fixtures/")
    args = ap.parse_args()

    checks = dict(COLD_CHECKS if args.cold else CHECKS)
    if args.only:
        checks = {k: v for k, v in checks.items() if args.only in k}
    if args.list:
        print("可用检查（默认模式）: " + ", ".join(CHECKS))
        print("冷进程模式(--cold): " + ", ".join(COLD_CHECKS))
        return 0
    if not checks:
        print(f"[FAIL] --only {args.only!r} 没匹配到任何检查")
        return 1

    ui_probe.WORK.mkdir(parents=True, exist_ok=True)
    data = ui_probe._prepare_data(empty=args.cold)
    port = ui_probe._free_port()
    env = {**os.environ, "DDTOOLKIT_DATA_DIR": str(data), "DDTOOLKIT_PORT": str(port),
           "DDTOOLKIT_PARENT_PID": "0", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    if args.cold:
        # 冷进程必须**显式清空凭证**：`config.py` 读 os.getenv，shell 里残留的
        # BILI_SESSDATA 会被子进程继承 → 测出来的是"登录态"，结论会完全反过来
        # （这正是 R11 那个错结论的成因，devlog/083 §十）。
        for key in ("BILI_SESSDATA", "BILI_BIJI_JCT", "BILI_DEDE_USER_ID",
                    "BILI_REFRESH_TOKEN", "WEIBO_COOKIE", "WEIBO_UID", "WEIBO_NAME"):
            env[key] = ""
    mode = "冷进程（空数据目录）" if args.cold else "真上游（数据目录副本）"
    print(f"[smoke] {mode}｜起后端 :{port}｜数据目录 {data}")
    log = open(ui_probe.WORK / "smoke_upstream.log", "wb")
    be = subprocess.Popen([sys.executable, "backend_main.py"], cwd=ROOT, env=env,
                          stdout=log, stderr=subprocess.STDOUT)
    try:
        if not ui_probe._wait(f"http://127.0.0.1:{port}/healthz", 90, be):
            print(f"[FAIL] 后端未就绪，见 {ui_probe.WORK / 'smoke_upstream.log'}")
            return 1
        ctx = Ctx(f"http://127.0.0.1:{port}", data, args.capture, args.cold)
        for name, fn in checks.items():
            try:
                fn(ctx)
            except Exception as e:                                # noqa: BLE001
                ctx.record(FAIL, name, f"检查自身抛异常：{type(e).__name__}: {e}")
        if args.capture:
            _capture_raw_upstream(ctx)
            _capture_nsis_fixture(ctx)
    finally:
        be.terminate()
        try:
            be.wait(timeout=15)
        except subprocess.TimeoutExpired:
            be.kill()
        log.close()
        time.sleep(0.3)

    fails = [r for r in ctx.results if r[0] == FAIL]
    skips = [r for r in ctx.results if r[0] == SKIP]
    print(f"\n[smoke] {len(ctx.results)} 项："
          f"{len(ctx.results) - len(fails) - len(skips)} ok / {len(skips)} skip / {len(fails)} FAIL")
    for _, name, detail in skips:
        print(f"  [skip] {name}: {detail}")
    if ctx.fixtures_written:
        print(f"  fixtures 已刷新: {', '.join(ctx.fixtures_written)}")
    if fails:
        for _, name, detail in fails:
            print(f"  [FAIL] {name}: {detail}")
        print("  （现场保留在 " + str(ui_probe.WORK) + "）")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
