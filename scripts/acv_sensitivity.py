"""池子系数敏感性：1.0 / 1.5 / 2.0 / 3.0 / 4.0 × ACV。

选名单方式 = 用户 2026-10-24 方案：**10% 大盘内按核心度 S 取前 N**（N = 系数×ACV）。

每个系数输出：名单人数、收入占比、分半信度（SB）、收入 R²（log）、跨 V lift。
"""

from __future__ import annotations

import math
from dataclasses import replace
from statistics import mean

from app.services.fan import load_window
from app.services.fan.axes import (
    AXIS_ATTENDANCE, AXIS_INTERACTION, AXIS_PAYMENT, build_axis_table,
)
from app.services.fan.compose import income_outcome, participation_strength
from app.services.fan.pool import window_acv

VS = ("弥月", "明前奶绿", "星瞳")
MULTS = (1.0, 1.5, 2.0, 3.0, 4.0)
FLOOR = 0.10


def _rank(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    out = [0.0] * len(xs)
    i = 0
    while i < len(xs):
        j = i
        while j + 1 < len(xs) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1):
            out[order[k]] = r
        i = j + 1
    return out


def spearman(a, b) -> float:
    if len(a) < 3:
        return float("nan")
    ra, rb = _rank(a), _rank(b)
    ma, mb = mean(ra), mean(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    da = sum((x - ma) ** 2 for x in ra) ** 0.5
    db = sum((y - mb) ** 2 for y in rb) ** 0.5
    return num / (da * db) if da and db else float("nan")


def r2(pred, y) -> float:
    n = len(y)
    k = len(pred[0]) + 1
    X = [[1.0] + list(p) for p in pred]
    xtx = [[sum(r[i] * r[j] for r in X) for j in range(k)] for i in range(k)]
    xty = [sum(r[i] * yy for r, yy in zip(X, y)) for i in range(k)]
    m = [row[:] + [xty[i]] for i, row in enumerate(xtx)]
    for c in range(k):
        p = max(range(c, k), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        if abs(m[c][c]) < 1e-12:
            return float("nan")
        for r in range(k):
            if r != c:
                f = m[r][c] / m[c][c]
                for cc in range(c, k + 1):
                    m[r][cc] -= f * m[c][cc]
    coef = [m[i][k] / m[i][i] for i in range(k)]
    mu = mean(y)
    ssr = sum((yy - sum(c * v for c, v in zip(coef, row))) ** 2 for row, yy in zip(X, y))
    sst = sum((yy - mu) ** 2 for yy in y)
    return 1 - ssr / sst if sst else float("nan")


def subset(win, uids):
    return replace(win, users={u: win.users[u] for u in uids if u in win.users})


def main() -> None:
    data = {}
    for short in VS:
        w = load_window(short, 75)
        base = build_axis_table(w, floor=FLOOR)
        s_base = participation_strength(base)
        acv = window_acv(w) or 0
        pay_base = sum(w.users[u].pay for u in base.uids) or 1.0
        data[short] = (w, base, s_base, acv, pay_base)

    for mult in MULTS:
        print(f"\n===== 池子 {mult}×ACV =====")
        print(f"{'V':<8}{'名单':>7}{'收入占比':>9}{'出席σ':>8}{'互动σ':>8}{'付费σ':>8}{'收入R²':>8}")
        picks = {}
        for short in VS:
            w, base, s_base, acv, pay_base = data[short]
            size = round(acv * mult)
            sel = sorted(base.uids, key=lambda u: (-s_base[u], u))[:size]
            picks[short] = set(sel)
            t = build_axis_table(subset(w, sel), floor=0.0)
            pay = sum(w.users[u].pay for u in sel) / pay_base

            ids = [s.live_id for s in w.sessions]
            halves = {}
            for tag, part in (("odd", ids[::2]), ("even", ids[1::2])):
                wh = load_window(short, 75, live_ids=part)
                halves[tag] = build_axis_table(subset(wh, sel), floor=0.0)

            rel = []
            for axis in (AXIS_ATTENDANCE, AXIS_INTERACTION, AXIS_PAYMENT):
                common = [u for u in sel if u in halves["odd"].pct and u in halves["even"].pct]
                a = [halves["odd"].pct[u][axis] for u in common]
                b = [halves["even"].pct[u][axis] for u in common]
                r = spearman(a, b)
                rel.append(2 * r / (1 + r) if r == r else float("nan"))

            pred = [[t.pct[u][axis] for axis in (AXIS_ATTENDANCE, AXIS_INTERACTION, AXIS_PAYMENT)]
                    for u in t.uids]
            inc = [income_outcome(w.users[u].pay) for u in t.uids]
            print(f"{short:<8}{len(sel):>7,}{pay:>9.1%}" +
                  "".join(f"{v:>8.3f}" for v in rel) + f"{r2(pred, inc):>8.3f}")

        for a, b in (("弥月", "明前奶绿"), ("明前奶绿", "星瞳")):
            A, B = picks[a], picks[b]
            inter = len(A & B)
            pop = len(A | B) * 2 - inter      # 近似总体（两盘之和）
            exp = len(A) * len(B) / max(1, pop)
            print(f"  lift {a}×{b}: {inter/max(1e-9, exp):.3f}（交集 {inter}，期望 {exp:.0f}）")


if __name__ == "__main__":
    main()
