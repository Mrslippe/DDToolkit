"""列出 maxrep 最极端的用户，并回取他们的真实弹幕样本供人工审查。

只读 raw（算出 maxrep / 消息量 / 不同文本数 / 占比），再用 danmakus 接口取**那一场**
的原始记录，把该用户的消息打出来 —— 光看数字判断不了是不是独轮车。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx

from app.services.fan.collector import fetch_records

ROOT = Path("E:/work/Project/database/dev/fan-structure")
VS = ("pilot_v3_mingqian", "pilot_v3_xingtong", "pilot_v3_mizuki")
TOP_N = 10


def scan(sub: str) -> list[dict]:
    d = ROOT / sub
    users: dict[str, dict] = {}
    sessions: dict[str, int] = {}
    for idx, f in enumerate(sorted((d / "raw").glob("*.json"))):
        raw = json.loads(f.read_text(encoding="utf-8"))
        sessions[f.stem] = idx
        for uid, a in raw.items():
            if not isinstance(a, dict) or not a.get("mh"):
                continue
            mt = a.get("mt") or []
            mh = a.get("mh") or []
            if len(mh) != len(mt):
                continue
            u = users.setdefault(uid, {"m": 0, "uniq": 0, "maxrep": 0,
                                       "best_live": None, "best_n": 0, "best_mh": None})
            u["m"] += len(mt)
            u["uniq"] += a.get("uniq") or 0
            rep = a.get("maxrep") or 0
            if rep > u["maxrep"]:
                u["maxrep"] = rep
                u["best_live"] = f.stem
                u["best_n"] = len(mt)
                u["best_mh"] = mh
    rows = []
    for uid, u in users.items():
        if u["m"] < 200:
            continue
        rows.append({"uid": uid, **u, "distinct_ratio": u["uniq"] / u["m"]})
    rows.sort(key=lambda r: -r["maxrep"])
    return rows[:TOP_N]


async def show(row: dict, sub: str) -> None:
    sha = row["best_live"]
    if not sha:
        return
    async with httpx.AsyncClient(timeout=180, trust_env=False) as c:
        recs = await fetch_records(c, sha) or []
    mine = [r for r in recs if str(r.get("uId")) == row["uid"] and r.get("type") == 0]
    texts = [str(r.get("message")) for r in mine]
    from collections import Counter
    cnt = Counter(texts)
    top = cnt.most_common(3)
    print(f"\n{row['uid']} · {sub[10:]} 场次 {sha[:8]}（本人该场 {len(mine)} 条）")
    print(f"  全场累计 {row['m']:,} · 不同文本 {row['uniq']:,}（{row['distinct_ratio']:.0%}）"
          f" · 单场最高重复 {row['maxrep']}")
    print(f"  该场最高频文本：{top[0][0]!r} × {top[0][1]}" if top else "  （该场取不到文本）")
    print("  样本：" + " | ".join(repr(t[:20]) for t in texts[:8]))


async def main() -> None:
    for sub in VS:
        rows = scan(sub)
        print(f"\n===== {sub} · maxrep 最高的 {len(rows)} 人 =====")
        for r in rows:
            print(f"  {r['uid']:<12} 消息 {r['m']:>7,} · 不同文本 {r['uniq']:>7,}"
                  f"（{r['distinct_ratio']:>4.0%}）· 单场最高重复 {r['maxrep']:>5}")
        for r in rows[:2]:                     # 只给前两名取样，控制请求量
            try:
                await show(r, sub)
            except Exception as exc:  # noqa: BLE001
                print(f"  取样失败 {r['uid']}: {type(exc).__name__}")


if __name__ == "__main__":
    asyncio.run(main())
