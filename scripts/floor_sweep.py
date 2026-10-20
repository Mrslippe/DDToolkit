"""出席门槛（INCLUSION_FLOOR=0.10）够不够高？门槛能抬到多少？

三件事：
1. 出席率分布：用户通过 5%/10%/15%/20%/30%/50% 门槛后的池子有多大；
2. 门槛抬高后**信度**怎么变（分半 + Spearman-Brown）；
3. 门槛抬高后**效标**怎么变（log 收入 / 相对跌幅的 R²）。

用法：python scripts/floor_sweep.py
"""

from __future__ import annotations

from statistics import mean, median

from app.services.fan import load_window
from app.services.fan.axes import AXIS_ATTENDANCE, AXIS_INTERACTION, AXIS_PAYMENT, build_axis_table
from app.services.fan.compose import income_outcome, retention_outcome

VS = ("弥月", "明前奶绿", "星瞳")
N = 75
FLOORS = (0.05, 0.10, 0.15, 0.20, 0.30, 0.50)


def _rank(xs) -> list[float]:
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


def r2(pred: list[list[float]], y: list[float]) -> float:
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


def main() -> None:
    for short in VS:
        w = load_window(short, N)
        n_sess = len(w.sessions)
        rates = sorted((f.att_n / max(1, n_sess), u) for u, f in w.users.items())
        total = len(rates)
        print(f"\n{short}：{n_sess} 场 · 全体用户 {total:,}")
        qs = [rates[int(total * q)][0] for q in (0.5, 0.75, 0.9, 0.95, 0.99)]
        print("  出席率分位 p50/p75/p90/p95/p99: " + " / ".join(f"{q:.1%}" for q in qs))
        for fl in (0.02, 0.05, 0.10, 0.20, 0.30, 0.50):
            keep = [u for r, u in rates if r >= fl]
            att = median([w.users[u].att_n for u in keep]) if keep else 0
            print(f"  门槛 {fl:>4.0%}: 池 {len(keep):>7,}（占 {len(keep)/total:>5.1%}）· 中位出席 {att:.0f} 场")

    print("\n=== 门槛对各指标的影响 ===")
    print(f"{'V':<8}{'门槛':>6}{'池':>9}{'出席信度':>10}{'互动信度':>10}{'付费信度':>10}"
          f"{'收入R²':>9}{'留存R²':>9}")
    for short in VS:
        w = load_window(short, N)
        ids = [s.live_id for s in w.sessions]
        w1 = load_window(short, N, live_ids=ids[::2])
        w2 = load_window(short, N, live_ids=ids[1::2])
        for fl in (0.10, 0.20, 0.30):
            t = build_axis_table(w, floor=fl)
            t1 = build_axis_table(w1, floor=fl)
            t2 = build_axis_table(w2, floor=fl)
            common = sorted(set(t1.uids) & set(t2.uids))
            rel = []
            for axis in (AXIS_ATTENDANCE, AXIS_INTERACTION, AXIS_PAYMENT):
                pairs = [(t1.pct[u][axis], t2.pct[u][axis]) for u in common
                         if t1.pct.get(u, {}).get(axis) is not None
                         and t2.pct.get(u, {}).get(axis) is not None]
                r = spearman([a for a, _ in pairs], [b for _, b in pairs])
                rel.append(2 * r / (1 + r) if r == r else float("nan"))
            us = list(t1.uids)
            pred = [[t1.pct[u][a] for a in (AXIS_ATTENDANCE, AXIS_INTERACTION, AXIS_PAYMENT)]
                    for u in us if all(t1.pct.get(u, {}).get(a) is not None
                                       for a in (AXIS_ATTENDANCE, AXIS_INTERACTION, AXIS_PAYMENT))]
            ids_ok = [u for u in us if all(t1.pct.get(u, {}).get(a) is not None
                                           for a in (AXIS_ATTENDANCE, AXIS_INTERACTION, AXIS_PAYMENT))]
            inc = [income_outcome((w2.users[u].pay or 0.0) if u in w2.users else 0.0) for u in ids_ok]
            ret = [retention_outcome(w1.users[u].att_n,
                                     w2.users[u].att_n if u in w2.users else 0) for u in ids_ok]
            print(f"{short:<8}{fl:>6.0%}{len(t.uids):>9,}"
                  + "".join(f"{v:>10.3f}" for v in rel)
                  + f"{r2(pred, inc):>9.3f}{r2(pred, ret):>9.3f}")


if __name__ == "__main__":
    main()
