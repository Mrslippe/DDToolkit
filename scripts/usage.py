# -*- coding: utf-8 -*-
"""读**本会话的真实用量**：每轮多少模型步、上下文多大、花了多少钱。

## 为什么要它

2026-09-25 实测一次"改 1 行 CSS"的批次：**12.0 分钟 / 15.05M token**。
拆开看才发现成本公式是

    花费 ≈ 步数 × 每步上下文 × 缓存单价 + 输出 × 输出单价

那一轮是 **101 步 × 148k 上下文**，其中 **99.4% 的量是缓存命中读入**。
⇒ 所以"贵不贵"**与需求大小几乎无关**，只与"跑了几步、每步带着多大的上下文"有关。
没有这个读数，任何"效率优化"都只能凭感觉 —— 所以它必须先落地。

## 数据来源（DSH 自己落的盘，不是估的）

    %DSH_HOME%/sessions/<cwd 变体>/<DSH_SESSION_ID>/session.v3.jsonl.zstd

每条 `assistant/message` 事件都带
`usage = {inputTokens, outputTokens, totalTokens, cacheReadTokens}`，
且 **totalTokens = inputTokens + cacheReadTokens + outputTokens**（实测确认）——
即它把**命中缓存的输入也算进去了**，所以别把 totalTokens 当"新输入量"看。

用法：
    python scripts/usage.py              # 最后一轮（= 本批）
    python scripts/usage.py --all        # 全会话按轮列表
    python scripts/usage.py --turn 55    # 指定轮
    python scripts/usage.py --all --top 10
"""
from __future__ import annotations

import argparse
import collections
import io
import json
import os
import re
import sys
from pathlib import Path

# ── 价目快照（deepseek-flash，元 / 百万 tokens；2026-09-25 取自官方价目表）
#    https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
#    ⚠️ 单价是**外部事实**，会变 —— 用之前顺手核一眼；改这一处即可。
PRICE = {
    "in_miss_off": 1.0, "in_miss_peak": 2.0,      # 输入·缓存未命中
    "in_hit_off": 0.02, "in_hit_peak": 0.04,      # 输入·缓存命中（1/50）
    "out_off": 4.0, "out_peak": 8.0,              # 输出
}


def transcript() -> Path | None:
    home = os.environ.get("DSH_HOME")
    sid = os.environ.get("DSH_SESSION_ID")
    if not home or not sid:
        return None
    slug = "--" + os.getcwd().replace(":", "").replace("\\", "-") + "--"
    p = Path(home) / "sessions" / slug / sid / "session.v3.jsonl.zstd"
    if p.exists():
        return p
    # 退路（cwd 变体名对不上时）：全库找最新的
    cands = sorted(Path(home).glob("sessions/*/*/session.v3.jsonl.zstd"),
                   key=lambda q: q.stat().st_mtime, reverse=True)
    return cands[0] if cands else None


def read_turns(path: Path) -> list[dict]:
    import zstandard  # 会话记录是 zstd 压缩的 JSONL

    turns: list[dict] = []
    cur: dict | None = None
    last_user = ""
    last_t = 0
    with open(path, "rb") as f:
        t = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(f), encoding="utf-8")
        for line in t:
            try:
                ev = json.loads(line)
            except Exception:
                continue
            ty, d, ts = ev.get("type"), ev.get("data") or {}, ev.get("time") or 0
            last_t = max(last_t, ts)
            if ty == "turn/start":
                cur = dict(idx=d.get("turn"), t0=ts, t1=0, steps=0, tools=0,
                           inp=0, out=0, cache=0, umsg="")
                turns.append(cur)
            elif ty == "turn/end" and cur is not None:
                cur["t1"] = ts
                cur = None
            elif ty == "user/message":
                txt = "".join(c.get("text") or "" for c in (d.get("content") or [])
                              if isinstance(c, dict) and c.get("type") == "text")
                txt = re.sub(r"<system-reminder>.*?</system-reminder>", "", txt, flags=re.S)
                # 后台作业完成通知也算"用户消息位"，它通常才是该轮真正的起因
                if txt.strip():
                    last_user = re.sub(r"\s+", " ", txt.strip())
            elif ty == "assistant/message" and cur is not None:
                u = d.get("usage") or {}
                cur["steps"] += 1
                cur["inp"] += u.get("inputTokens") or 0
                cur["out"] += u.get("outputTokens") or 0
                cur["cache"] += u.get("cacheReadTokens") or 0
                cur["umsg"] = last_user
            elif ty == "tool/call" and cur is not None:
                cur["tools"] += 1
    for t_ in turns:            # 未闭合的最后一轮：用最后一条事件当结束时间
        t_["t1"] = t_["t1"] or last_t
    return turns


def cost(t: dict) -> tuple[float, float]:
    """返回 (空闲时段估算, 高峰时段估算) 元。"""
    m = 1_000_000
    off = (t["inp"] * PRICE["in_miss_off"] + t["cache"] * PRICE["in_hit_off"]
           + t["out"] * PRICE["out_off"]) / m
    peak = (t["inp"] * PRICE["in_miss_peak"] + t["cache"] * PRICE["in_hit_peak"]
            + t["out"] * PRICE["out_peak"]) / m
    return off, peak


def show(t: dict) -> None:
    dur = (t["t1"] - t["t0"]) / 1000 if t["t0"] and t["t1"] else 0
    ctx = int(t["cache"] / t["steps"]) if t["steps"] else 0
    total = t["inp"] + t["cache"] + t["out"]
    off, peak = cost(t)
    print(f"轮 {t['idx']}  「{(t['umsg'] or '')[:56]}」")
    print(f"  时长 {dur/60:.1f} 分钟 · 模型步 {t['steps']} · 工具调用 {t['tools']}"
          f" · **≈每步上下文 {ctx:,}**")
    print(f"  新输入 {t['inp']:>10,} · 缓存读 {t['cache']:>12,}"
          f" · 输出 {t['out']:>9,} · 合计 {total:>12,}")
    print(f"  估算费用：空闲 **{off:.3f} 元** / 高峰 {peak:.3f} 元")


def main() -> int:
    ap = argparse.ArgumentParser(description="本会话用量读数（见文件头注释）")
    ap.add_argument("--all", action="store_true", help="列全会话每一轮")
    ap.add_argument("--turn", type=int, help="只看指定轮")
    ap.add_argument("--top", type=int, default=0, help="配合 --all：只列最贵的 N 轮")
    a = ap.parse_args()

    p = transcript()
    if not p:
        print("找不到会话记录（DSH_HOME / DSH_SESSION_ID 未设？）")
        return 1
    turns = read_turns(p)
    if not turns:
        print("记录里没有轮次")
        return 1

    if a.turn:
        hit = [t for t in turns if t["idx"] == a.turn]
        if not hit:
            print(f"没有第 {a.turn} 轮")
            return 1
        show(hit[0])
        return 0

    if not a.all:
        show(turns[-1])                      # 默认：最后一轮 = 本批
        print("\n（--all 看全会话，--turn N 看指定轮）")
        return 0

    tot = collections.Counter()
    rows = turns
    if a.top:
        rows = sorted(turns, key=lambda t: t["cache"] + t["inp"], reverse=True)[:a.top]
    print(f"{'轮':>3} {'分钟':>6} {'步':>5} {'工具':>5} {'新输入':>10} {'缓存读':>13} "
          f"{'输出':>8} {'≈每步上下文':>11} {'空闲元':>7}  用户消息")
    for t in rows:
        dur = (t["t1"] - t["t0"]) / 1000 if t["t0"] and t["t1"] else 0
        ctx = int(t["cache"] / t["steps"]) if t["steps"] else 0
        off, _ = cost(t)
        print(f"{t['idx']:>3} {dur/60:>6.1f} {t['steps']:>5} {t['tools']:>5} "
              f"{t['inp']:>10,} {t['cache']:>13,} {t['out']:>8,} {ctx:>11,} "
              f"{off:>7.2f}  {(t['umsg'] or '')[:40]}")
        for k in ("inp", "cache", "out", "steps", "tools"):
            tot[k] += t[k]
        tot["off"] += off
    print(f"\n合计（**列出 {len(rows)} 轮**）：{tot['steps']} 步 · 新输入 {tot['inp']:,} "
          f"· 缓存读 {tot['cache']:,} · 输出 {tot['out']:,} · **≈{tot['off']:.2f} 元**（空闲价）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
