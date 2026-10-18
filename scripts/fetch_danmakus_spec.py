# -*- coding: utf-8 -*-
"""抓 danmakus 的 swagger spec 并存档到 `docs/reference/`（只读工具，不改仓库其它东西）。

## 为什么需要它（2026-10-14 实测踩到的三件事）

1. **上游的 swagger.json 是坏 JSON**：两份文档各有 **11 处** `"kindValue": ,`
   （.NET 把值为 null 的枚举序列化成了空），`json.loads` 直接抛
   `Expecting value: line 7529 column 26`。**不修就没法当契约用**，所以本脚本自带修复。
2. **`/swagger/combined/swagger.json` 是空壳**：HTTP 200、**12 字节**、体是 `{}`。
   想"合并两份"的人会在这一步白花时间 —— 真相是 **v2 与 v3 本来就是同一份文档**
   （路径集合、schema 集合全等，只差 `info.version` 一个字符串）。
3. **`Invoke-WebRequest` 抓不到**（连接被上游关掉），而带 `Origin`/`Referer` 的
   httpx/requests 可以 —— 与业务端点同一条 WAF 规则（见 `app/services/externals/danmakus.py`）。

## 用法

    python scripts/fetch_danmakus_spec.py              # 抓 v2/v3，报告差异，写存档
    python scripts/fetch_danmakus_spec.py --diff-only  # 只报告，不写文件
    python scripts/fetch_danmakus_spec.py --check      # 与存档比对，有差异退出 1（给 CI/人工巡检用）

存档文件名固定为 `docs/reference/danmakus-api-<version>-swagger.json`。
抓下来的**是修复后**的文本（可直接 `json.loads`），并在同目录写一份
`danmakus-api-fetch.log`（时间 / 字节 / sha256 / 差异结论），便于下次比对。

索引文档：`docs/backend/DANMAKUS-API.md`（改上游端点后按它 §7 刷新）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "docs" / "reference"

BASE = "https://ukamnads.icu"
SPEC_PATHS = ("/swagger/v2/swagger.json", "/swagger/v3/swagger.json",
              "/swagger/combined/swagger.json")
TIMEOUT = 90.0

# 与业务端点同一套头：缺 Origin/Referer 会被 WAF 关连接（实测 2026-10-14）
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Origin": BASE,
    "Referer": BASE + "/",
}
try:                                     # UA 全仓单一来源；单独跑也能退化成普通浏览器串
    sys.path.insert(0, str(ROOT))
    from app.core.useragent import UA_CHROME as _UA
except Exception:                        # noqa: BLE001 - 只为抓一份文档，不值得失败
    _UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
HEADERS["User-Agent"] = _UA

#: 坏 JSON 的修复：`"key": ,` → `"key": null,`
_EMPTY_VALUE = re.compile(r"(:\s*),")


def repair(text: str) -> tuple[str, int]:
    """返回 `(修好的文本, 修了几处)`。0 处也算成功（上游哪天修好了）。"""
    fixed, n = _EMPTY_VALUE.subn(r"\1null,", text)
    return fixed, n


def fetch(path: str) -> tuple[bytes, str]:
    import httpx

    resp = httpx.get(BASE + path, headers=HEADERS, timeout=TIMEOUT, follow_redirects=True)
    resp.raise_for_status()
    return resp.content, resp.text


def summarize(name: str, raw: bytes, text: str) -> dict:
    fixed, fixes = repair(text)
    info: dict = {"name": name, "bytes": len(raw),
                  "sha256": hashlib.sha256(raw).hexdigest()[:16], "repairs": fixes}
    try:
        spec = json.loads(fixed)
    except Exception as e:                                   # noqa: BLE001
        info["parse"] = f"FAIL {type(e).__name__}: {e}"
        return info
    info["parse"] = "ok"
    info["title"] = spec.get("info", {}).get("title")
    info["version"] = spec.get("info", {}).get("version")
    info["paths"] = len(spec.get("paths") or {})
    info["operations"] = sum(
        1 for ops in (spec.get("paths") or {}).values() for m in ops
        if m in ("get", "post", "put", "delete", "patch"))
    info["schemas"] = len((spec.get("components") or {}).get("schemas") or {})
    info["_paths"] = set(spec.get("paths") or {})
    info["_schemas"] = set((spec.get("components") or {}).get("schemas") or {})
    return info


def main() -> int:
    ap = argparse.ArgumentParser(description="抓并归档 danmakus swagger spec")
    ap.add_argument("--diff-only", action="store_true", help="只报告差异，不写文件")
    ap.add_argument("--check", action="store_true",
                    help="与 docs/reference 下的存档比对，有差异退出 1")
    args = ap.parse_args()

    fetched: dict[str, dict] = {}
    texts: dict[str, str] = {}          # name -> 修复后的文本（写盘直接用这份，不重复请求）
    for path in SPEC_PATHS:
        name = path.rstrip("/").split("/")[-2]           # v2 / v3 / combined
        try:
            raw, text = fetch(path)
        except Exception as e:                            # noqa: BLE001
            print(f"[ERR ] {name:9s} {path} -> {type(e).__name__}: {e}")
            continue
        info = summarize(name, raw, text)
        info["_text"] = repair(text)[0]
        fetched[name] = info
        texts[name] = info["_text"]
        # 空体当"不可用"，不算解析失败：combined 永远是 12 字节的 `{}`（见文件头第 2 条），
        # 每跑一次都报 FAIL 只会训练人忽略这个输出。
        if info["bytes"] < 100:
            info["parse"] = "skip（空壳）"
        print(f"[{info.get('parse','?'):4s}] {name:9s} bytes={info['bytes']:<7} "
              f"sha={info['sha256']} repairs={info['repairs']} "
              f"paths={info.get('paths','-')} ops={info.get('operations','-')} "
              f"schemas={info.get('schemas','-')} version={info.get('version','-')}")

    if len(fetched) >= 2:
        names = [n for n in ("v2", "v3") if n in fetched]
        if len(names) == 2:
            a, b = fetched[names[0]], fetched[names[1]]
            same_paths = a.get("_paths") == b.get("_paths")
            same_schemas = a.get("_schemas") == b.get("_schemas")
            print(f"\n[结论] v2 vs v3：路径集合{'相等' if same_paths else '不同'}、"
                  f"schema 集合{'相等' if same_schemas else '不同'}"
                  f"（字节 {a['bytes']} vs {b['bytes']}）")
            if not same_paths:
                only_a = sorted(a["_paths"] - b["_paths"])[:10]
                only_b = sorted(b["_paths"] - a["_paths"])[:10]
                print(f"        只在 v2：{only_a}\n        只在 v3：{only_b}")
    if "combined" in fetched and fetched["combined"]["bytes"] < 100:
        print(f"[注意] combined 只有 {fetched['combined']['bytes']} 字节 ⇒ 空壳，别用它")

    if args.diff_only:
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    changed: list[str] = []
    lines = [f"# {datetime.now(timezone.utc).isoformat(timespec='seconds')} fetch"]
    for name, info in fetched.items():
        if info.get("parse") != "ok" or info["bytes"] < 100:
            # combined 是空壳、坏 JSON 没修好：都不写盘（写进去只会污染存档）
            lines.append(f"{name}\tskip\tparse={info.get('parse')} bytes={info['bytes']}")
            continue
        target = OUT_DIR / f"danmakus-api-{name}-swagger.json"
        fixed = texts[name]
        old = target.read_text(encoding="utf-8") if target.exists() else None
        if old != fixed:
            target.write_text(fixed, encoding="utf-8")
            changed.append(name)
            state = "更新" if old is not None else "新建"
        else:
            state = "无变化"
        lines.append(f"{name}\t{state}\t{info['sha256']}\t{info['bytes']}B\t"
                     f"repairs={info['repairs']}\tpaths={info.get('paths')}\t"
                     f"ops={info.get('operations')}")
        print(f"[存档] {target.relative_to(ROOT)} → {state}")
    (OUT_DIR / "danmakus-api-fetch.log").write_text("\n".join(lines) + "\n", encoding="utf-8")

    if args.check and changed:
        print(f"\n[FAIL] 上游已变（{changed}）⇒ 按 docs/backend/DANMAKUS-API.md §7 刷新索引")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
