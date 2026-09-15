"""能力矩阵实测：**未登录 / 已登录**两态下，逐个上游接口量"到底能不能用"。

## 为什么需要它（devlog/086）

用户要"没登录也尽可能用所有功能，并明确告知限制"。"哪些能用"必须**实测**：
2026-09-15 首测就发现匿名打 B 站空间接口会 `412 request was banned`（IP 级、会持续），
而账号信息/粉丝数/直播状态/检索全都能用 —— 这条边界直接决定产品承诺。

## 纪律（踩过的坑都写在这儿）

1. **一个进程只发一条请求**（`--probe <name>` 子进程模式）：实测里"前一条请求的失败"
   会波及后面的请求，混在一个进程里量出来的矩阵是错的（第一版就量错过）。
2. **冷态要显式清空凭据**：`config.py` 读 `os.getenv`，shell 里残留的 `BILI_SESSDATA`
   会被子进程继承 ⇒ 测出来的是"登录态"。
3. **默认只量轻量接口**；`--include-content` 才量投稿/动态 —— 匿名打它们会触发 IP 级
   412，要等它过期（登录态不受影响，已实测）。别勤跑。
4. 每条之间 `--gap` 秒（默认 6），不做任何重试。

## 用法

    python scripts/capability_matrix.py                    # 两态 × 轻量接口，打印矩阵
    python scripts/capability_matrix.py --state anon        # 只量未登录
    python scripts/capability_matrix.py --include-content   # 额外量投稿/动态（有代价）
    python scripts/capability_matrix.py --write             # 结果写 tests/fixtures/capability_matrix.json
    python scripts/capability_matrix.py --probe topic --state anon   # 内部用：单条探测（子进程）
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "capability_matrix.json"
MID = 1265680561        # 永雏塔菲（与既有用例同一个 mid，便于比对）
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# 轻量接口（匿名实测可用；代价小）
LIGHT = {
    "info": "账号信息 acc/info（签名）",
    "stat": "粉丝数 relation/stat（未签名）",
    "live": "直播状态 live batch",
    "search": "名称模糊搜 wbi/search/type（签名）",
}
# 内容接口（匿名会被 412；只在 --include-content 时量）
CONTENT = {
    "topic": "投稿列表 arc/search（签名）",
    "dynamics": "动态流 polymer feed/space（未签名）",
}

OK, BAD = "[ok]", "[FAIL]"


def _probe(name: str) -> dict:
    """在**本进程**里跑一条探测（由子进程调用；环境已由父进程摆好）。"""
    import asyncio

    import httpx

    if str(ROOT) not in sys.path:       # 脚本跑起来时 sys.path[0] 是 scripts/
        sys.path.insert(0, str(ROOT))
    from app.core.http import new_async_client
    from app.services import wbi
    from app.services.auth import auth_manager

    logged_in = auth_manager.is_logged_in
    headers = {**auth_manager.build_headers(), "User-Agent": UA,
               "Referer": "https://space.bilibili.com/",
               "Accept": "application/json, text/plain, */*",
               "Accept-Language": "zh-CN,zh;q=0.9"}

    async def run() -> dict:
        # 签名一律 `allow_anonymous=True`（两态同一套代码）：这才是"方案落地后的行为"。
        # 不 monkeypatch `wbi` —— 直接测真实实现，免得量到的是我自己搭的假路径。
        async with new_async_client(15.0) as c:
            if name == "info":
                p = await wbi.sign_params({"mid": MID}, allow_anonymous=True)
                url = f"https://api.bilibili.com/x/space/wbi/acc/info?{urllib.parse.urlencode(p)}"
            elif name == "stat":
                url = f"https://api.bilibili.com/x/relation/stat?vmid={MID}"
            elif name == "live":
                url = "https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids"
            elif name == "search":
                p = await wbi.sign_params({"search_type": "bili_user",
                                           "keyword": "塔菲", "page": 1},
                                          allow_anonymous=True)
                url = ("https://api.bilibili.com/x/web-interface/wbi/search/type?"
                       + urllib.parse.urlencode(p))
            elif name == "topic":
                p = await wbi.sign_params({"mid": MID, "ps": 5, "pn": 1, "order": "pubdate"},
                                          allow_anonymous=True)
                url = ("https://api.bilibili.com/x/space/wbi/arc/search?"
                       + urllib.parse.urlencode(p))
            elif name == "dynamics":
                url = ("https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?"
                       + urllib.parse.urlencode({"host_mid": MID}))
            else:
                raise SystemExit(f"未知探测 {name!r}")

            params = [("uids[]", str(MID))] if name == "live" else None
            t0 = time.time()
            try:
                r = await c.get(url, params=params, headers=headers)
            except Exception as e:                                # noqa: BLE001
                return {"probe": name, "logged_in": logged_in, "http": None,
                        "code": None, "message": f"{type(e).__name__}: {e}",
                        "items": None, "ms": round((time.time() - t0) * 1000)}
            try:
                body = r.json()
            except Exception:                                     # noqa: BLE001
                body = {}
            data = body.get("data") or {}
            items = None
            for key in ("list", "items", "result"):
                v = data.get(key)
                if isinstance(v, list):
                    items = len(v)
                elif isinstance(v, dict):
                    items = len(v.get("vlist") or []) or None
                if items is not None:
                    break
            return {"probe": name, "logged_in": logged_in, "http": r.status_code,
                    "code": body.get("code"), "message": body.get("message"),
                    "items": items, "ms": round((time.time() - t0) * 1000)}

    return asyncio.run(run())


def _spawn_probe(name: str, state: str, data_dir: Path) -> dict:
    """父进程：摆好环境，起一个**全新子进程**跑单条探测。"""
    env = {**os.environ, "DDTOOLKIT_DATA_DIR": str(data_dir),
           "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "DDTOOLKIT_PARENT_PID": "0"}
    if state == "anon":
        # 冷态：显式清空凭据（否则 shell 里残留的 SESSDATA 会被继承 → 测成登录态）
        for k in ("BILI_SESSDATA", "BILI_BIJI_JCT", "BILI_DEDE_USER_ID",
                  "BILI_REFRESH_TOKEN", "WEIBO_COOKIE", "WEIBO_UID", "WEIBO_NAME"):
            env[k] = ""
    r = subprocess.run([sys.executable, str(Path(__file__).resolve()),
                        "--probe", name, "--state", state],
                       cwd=ROOT, env=env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=120)
    for line in reversed((r.stdout or "").strip().splitlines()):
        if line.startswith("{"):
            return json.loads(line)
    return {"probe": name, "logged_in": None, "http": None, "code": None,
            "message": f"子进程没给出结果（rc={r.returncode}）：{(r.stderr or '')[-200:]}"}


def _judge(row: dict) -> str:
    if row.get("http") == 200 and row.get("code") == 0:
        return "✓"
    if row.get("http") == 412 or row.get("code") in (-352, -412, -509):
        return "✗ 风控"
    if row.get("code") == -101:
        return "✗ 未登录"
    if row.get("http") is None:
        return "✗ 异常"
    return "✗"


def _state_dir() -> Path:
    """两态各自的数据目录：anon = 空目录（无 .env）；login = 开发目录副本（带凭据）。"""
    return ROOT / "_ui_probe_tmp" / "capability_matrix"


def _data_dir(state: str) -> Path:
    base = _state_dir()
    base.mkdir(parents=True, exist_ok=True)
    if state == "anon":
        d = base / "anon"
        if d.exists():
            import shutil
            shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
        return d
    # 登录态：复用探针那套"开发数据目录副本"（含 .env；不碰真库）
    sys.path.insert(0, str(ROOT / "scripts"))
    import ui_probe
    return ui_probe._prepare_data()


def main() -> int:
    ap = argparse.ArgumentParser(description="能力矩阵实测（两态 × 逐接口）")
    ap.add_argument("--probe", help="内部用：只跑这一条（子进程模式）")
    ap.add_argument("--state", choices=["anon", "login"], default="login")
    ap.add_argument("--include-content", action="store_true",
                    help="额外量投稿/动态（匿名会触发 IP 级 412，别勤跑）")
    ap.add_argument("--gap", type=float, default=6.0, help="两条之间的间隔秒数")
    ap.add_argument("--write", action="store_true", help="写 tests/fixtures/capability_matrix.json")
    args = ap.parse_args()

    if args.probe:                       # 子进程模式：直接量一条
        print(json.dumps(_probe(args.probe), ensure_ascii=False))
        return 0

    probes = dict(LIGHT)
    if args.include_content:
        probes.update(CONTENT)

    matrix: dict[str, dict[str, dict]] = {"anon": {}, "login": {}}
    for state in ("anon", "login"):
        data_dir = _data_dir(state)
        print(f"\n=== 状态 {state}（数据目录 {data_dir}）===")
        for i, (name, label) in enumerate(probes.items()):
            if i:
                time.sleep(args.gap)
            row = _spawn_probe(name, state, data_dir)
            matrix[state][name] = row
            print(f"  {_judge(row)} {label:<34} "
                  f"HTTP {row.get('http')} code={row.get('code')!r} "
                  f"条数={row.get('items')} {row.get('ms')}ms "
                  f"msg={str(row.get('message'))[:40]!r}")

    print("\n=== 矩阵（✓=匿名可用 · ✗=需要登录/被风控）===")
    print(f"  {'接口':<34} {'未登录':<10} {'已登录':<10} 依据")
    for name, label in probes.items():
        a, l = matrix["anon"][name], matrix["login"][name]
        print(f"  {label:<34} {_judge(a):<10} {_judge(l):<10} "
              f"anon code={a.get('code')!r}/http={a.get('http')}")

    if args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps({
            "captured_from": "python scripts/capability_matrix.py --write"
                             + (" --include-content" if args.include_content else ""),
            "captured_at": time.strftime("%Y-%m-%d"),
            "probes": {**LIGHT, **CONTENT},
            "matrix": matrix,
            "note": "两态各一条进程一条请求实测；✗ 多因平台风控（412/-352），"
                    "不是我们实现的问题 —— 详见 app/services/capabilities.py 的表",
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(f"\n  fixtures 已更新: {FIXTURE.relative_to(ROOT)}")

    bad = [n for n in probes if matrix["login"][n].get("code") != 0]
    if bad:
        print(f"\n{BAD} 登录态下也有量不到的：{bad}（先确认本机 B 站登录态/网络）")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
