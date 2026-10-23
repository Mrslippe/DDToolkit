"""用「平均同接（ACV）」检验分层人数假设。

用户假设（2026-10-23）：
- 核心层 ≈ 0.75 × ACV
- 次核心层 ≈ 0.75×ACV ~ 2×ACV（人数 1.25×ACV）
- 外层 ≈ 2×ACV ~ 5×ACV（人数 3×ACV）
⇒ 三层合计 ≈ 5×ACV

做法：
1. 从 vtb.cat 的 `/live/list` 拿该 V 的场次，按 `StartAt - 8h` 与我们的 `start_at` 对齐；
2. 对匹配上的场次取 `/online` 逐分钟同接，求均值（ACV）；
3. 与我们池子里"按强度分位切出的三层人数"对照。

用法：python scripts/tier_vs_acv.py [--sample 12]
"""

from __future__ import annotations

import argparse
import json
import statistics as st
from datetime import datetime, timezone
from pathlib import Path

import httpx

from app.services.fan.loader import list_vtubers, resolve_data_dir

K = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
BASE = "https://api.vtb.cat"
OFFSET = 8 * 3600          # vtb StartAt = 我们的 UTC epoch + 8h（2026-10-21 实测）
ROOT = resolve_data_dir()


def our_sessions(subdir: str) -> list[dict]:
    out = []
    for f in sorted((ROOT / subdir / "stats").glob("*.json")):
        s = json.loads(f.read_text(encoding="utf-8"))
        if not s.get("start_at"):
            continue
        try:
            ms = int(datetime.strptime(str(s["start_at"])[:19], "%Y-%m-%d %H:%M:%S")
                     .replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
        out.append({"live_id": s["live_id"], "start": ms,
                    "type0": int(s.get("type0") or 0)})
    out.sort(key=lambda r: r["start"])
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=12, help="每个 V 抽多少场算 ACV")
    args = ap.parse_args()

    refs = list_vtubers(None, root=ROOT)
    for v in refs:
        with httpx.Client(timeout=40, headers=K, trust_env=False) as c:
            r = c.get(f"{BASE}/live/list", params={"uid": v.mid, "limit": 1000, "page": 1})
            if r.status_code != 200:
                print(f"{v.name}: vtb 取不到（HTTP {r.status_code}）")
                continue
            lives = (r.json() or {}).get("lives") or []
            by_start = {int(x.get("StartAt") or 0): x for x in lives}

            ours = our_sessions(v.subdir)
            matched = []
            for s in ours:
                hit = by_start.get(s["start"] + OFFSET)
                if hit:
                    matched.append((s, hit))
            sample = matched[-args.sample:] if len(matched) > args.sample else matched

            acvs = []
            for s, hit in sample:
                try:
                    o = c.get(f"{BASE}/online", params={"id": hit.get("ID")})
                    pts = (o.json() or {}).get("data") or [] if o.status_code == 200 else []
                except (httpx.HTTPError, ValueError):
                    pts = []
                counts = [float(p.get("Count") or 0) for p in pts if p.get("Count") is not None]
                if counts:
                    acvs.append(st.mean(counts))

        if not acvs:
            print(f"{v.name}: 没有可用的同接数据（匹配 {len(matched)} 场）")
            continue
        acv = st.median(acvs)
        pool = len(ours)  # 占位：真正的池子在下面用 ranked 算
        print(f"\n{v.name}：匹配 {len(matched)}/{len(ours)} 场 · 取 {len(acvs)} 场算 ACV")
        print(f"  ACV（逐场均值的中位）= {acv:,.0f}")
        print(f"  假设三层人数：核心 {acv*0.75:,.0f} · 次核心 {acv*1.25:,.0f} · 外层 {acv*3:,.0f}"
              f" · 合计 {acv*5:,.0f}")


if __name__ == "__main__":
    main()
