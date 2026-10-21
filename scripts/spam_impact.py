"""独轮车对结果的影响有多大？（一次性评估脚本）

三种口径对比：

- **基线**：现有口径，互动轴 = `(m + sc_cnt) / att_n`（原始条数，含刷屏）
- **去重**：互动轴 = `(uniq + sc_cnt) / att_n`（同场同文本只算一次）
- **剔除**：把 `is_spam` 判为真的用户从池里整个移除，其余不变

比较：强度 S 的 Spearman、Top-100 重合、类型分布变化、收入效标 R²。
"""

from __future__ import annotations

from dataclasses import replace
from statistics import mean

from app.services.fan import load_window
from app.services.fan.axes import AXIS_ATTENDANCE, AXIS_INTERACTION, AXIS_PAYMENT, build_axis_table
from app.services.fan.compose import income_outcome, participation_strength, rank, type_label
from app.services.fan.spam import is_spam

VS = ("弥月", "明前奶绿", "星瞳")


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


def dedup_window(w):
    users = {}
    for u, f in w.users.items():
        users[u] = replace(f, m=f.uniq) if f.text_tracked else f
    return type(w)(vtuber=w.vtuber, requested_n=w.requested_n,
                   sessions=w.sessions, users=users, warnings=list(w.warnings))


def drop_spam_window(w):
    users = {}
    dropped = 0
    for u, f in w.users.items():
        flag = is_spam(uniq=f.uniq, maxrep=f.maxrep, m=f.m) if f.text_tracked else None
        if flag:
            dropped += 1
            continue
        users[u] = f
    return type(w)(vtuber=w.vtuber, requested_n=w.requested_n,
                   sessions=w.sessions, users=users, warnings=list(w.warnings)), dropped


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


def main() -> None:
    for short in VS:
        w = load_window(short, 75)
        base = build_axis_table(w)
        s_base = participation_strength(base)
        order_base = rank(base, s_base)
        top_base = set(order_base[:100])
        dist_base = type_label(base)

        w_dedup = dedup_window(w)
        t_dedup = build_axis_table(w_dedup)
        s_dedup = participation_strength(t_dedup)

        w_drop, dropped = drop_spam_window(w)
        t_drop = build_axis_table(w_drop)
        s_drop = participation_strength(t_drop)
        order_drop = rank(t_drop, s_drop)

        common_d = [u for u in base.uids if u in t_dedup.uids]
        common_s = [u for u in base.uids if u in t_drop.uids]
        rho_d = spearman([s_base[u] for u in common_d], [s_dedup[u] for u in common_d])
        rho_s = spearman([s_base[u] for u in common_s], [s_drop[u] for u in common_s])

        top_d = set(order_drop[:100])
        dist_drop = type_label(t_drop)
        changes = sum(1 for u in dist_base if u in dist_drop and dist_base[u] != dist_drop[u])

        print(f"\n{short}：池 {len(base.uids):,} · 判为独轮车 {dropped:,} 人"
              f"（{dropped/len(w.users):.2%}）")
        print(f"  去重后 S 的 ρ = {rho_d:.4f} · 剔除后 S 的 ρ = {rho_s:.4f}")
        print(f"  剔除后 Top-100 重合 {len(top_base & top_d)}/100 · 类型改变 {changes:,} 人"
              f"（{changes/max(1,len(dist_base)):.2%}）")
        print(f"  类型分布  基线 {dict(sorted(_dist(dist_base).items()))}")
        print(f"            剔除 {dict(sorted(_dist(dist_drop).items()))}")


def _dist(labels: dict[str, str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for v in labels.values():
        out[v] = out.get(v, 0) + 1
    return out


if __name__ == "__main__":
    main()
