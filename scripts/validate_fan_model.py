"""在 323 场新基线上重跑模型验证（可复用脚本）。

跑四件事：
1. 分半信度（场次奇偶拆半，共同用户）；
2. 出席轴**样本外**预测：前半的出席轴 vs 后半的真实出席率，并与"纯出席率"对照；
3. 效标：前半三轴 → 后半收入 / 后半是否留存（线性 R²）；
4. 跨 V：三个试点 V 的受众重叠 lift 与超几何 p。

用法：python scripts/validate_fan_model.py
"""

from __future__ import annotations

from statistics import mean

from app.services.fan import load_window
from app.services.fan.axes import (
    AXIS_ATTENDANCE,
    AXIS_INTERACTION,
    AXIS_PAYMENT,
    build_axis_table,
)
from app.services.fan.cross_v import overlap, profile

VS = ("弥月", "明前奶绿", "星瞳")
N = 75


def spearman(a, b) -> float:
    n = len(a)
    if n < 3:
        return float("nan")
    ra = _rank(a)
    rb = _rank(b)
    ma, mb = mean(ra), mean(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    da = sum((x - ma) ** 2 for x in ra) ** 0.5
    db = sum((y - mb) ** 2 for y in rb) ** 0.5
    return num / (da * db) if da and db else float("nan")


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


def _solve(a: list[list[float]], b: list[float]) -> list[float]:
    """高斯消元解 a·x = b（不引 numpy）。"""
    n = len(a)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        m[col], m[piv] = m[piv], m[col]
        if abs(m[col][col]) < 1e-12:
            raise ZeroDivisionError
        for r in range(n):
            if r != col:
                f = m[r][col] / m[col][col]
                for c in range(col, n + 1):
                    m[r][c] -= f * m[col][c]
    return [m[i][n] / m[i][i] for i in range(n)]


def r2(pred: list[list[float]], y: list[float]) -> float:
    k = len(pred[0]) + 1
    X = [[1.0] + list(p) for p in pred]
    xtx = [[sum(row[i] * row[j] for row in X) for j in range(k)] for i in range(k)]
    xty = [sum(row[i] * yy for row, yy in zip(X, y)) for i in range(k)]
    try:
        coef = _solve(xtx, xty)
    except ZeroDivisionError:
        return float("nan")
    mu = mean(y)
    ss_res = sum((yy - sum(c * v for c, v in zip(coef, row))) ** 2 for row, yy in zip(X, y))
    ss_tot = sum((yy - mu) ** 2 for yy in y)
    return 1 - ss_res / ss_tot if ss_tot else float("nan")


def main() -> None:
    print("=== 1. 分半信度（Spearman-Brown 换算）===")
    print(f"{'V':<8}{'用户':>9}{'出席':>9}{'互动':>9}{'付费':>9}")
    for short in VS:
        w = load_window(short, N)
        ids = [s.live_id for s in w.sessions]
        t1 = build_axis_table(load_window(short, N, live_ids=ids[::2]))
        t2 = build_axis_table(load_window(short, N, live_ids=ids[1::2]))
        common = sorted(set(t1.uids) & set(t2.uids))
        vals = []
        for axis in (AXIS_ATTENDANCE, AXIS_INTERACTION, AXIS_PAYMENT):
            pairs = [(t1.pct[u][axis], t2.pct[u][axis]) for u in common
                     if t1.pct.get(u, {}).get(axis) is not None
                     and t2.pct.get(u, {}).get(axis) is not None]
            r = spearman([p[0] for p in pairs], [p[1] for p in pairs])
            vals.append(2 * r / (1 + r))
        print(f"{short:<8}{len(common):>9,}" + "".join(f"{v:>9.3f}" for v in vals))

    print("\n=== 2. 出席轴样本外（前半 → 后半真实出席率）===")
    print(f"{'V':<8}{'用户':>9}{'出席轴 ρ':>12}{'纯出席率 ρ':>13}")
    for short in VS:
        w = load_window(short, N)
        ids = [s.live_id for s in w.sessions]
        w1 = load_window(short, N, live_ids=ids[::2])
        w2 = load_window(short, N, live_ids=ids[1::2])
        t1 = build_axis_table(w1)
        n2 = len(w2.sessions) or 1
        us = [u for u in t1.uids if u in w2.users]
        axis_v = [t1.pct[u][AXIS_ATTENDANCE] for u in us]
        rate1 = [w1.users[u].att_n / max(1, len(w1.sessions)) for u in us]
        rate2 = [w2.users[u].att_n / n2 for u in us]
        print(f"{short:<8}{len(us):>9,}{spearman(axis_v, rate2):>12.3f}{spearman(rate1, rate2):>13.3f}")

    print("\n=== 3. 效标（前半三轴 → 后半收入 / 留存）===")
    print(f"{'V':<8}{'用户':>9}{'收入 R²':>10}{'留存 R²':>10}")
    for short in VS:
        w = load_window(short, N)
        ids = [s.live_id for s in w.sessions]
        w1 = load_window(short, N, live_ids=ids[::2])
        w2 = load_window(short, N, live_ids=ids[1::2])
        t1 = build_axis_table(w1)
        us = list(t1.uids)                       # 后半没出现 = 留存 0（不能只取交集）
        pred = [[t1.pct[u][a] for a in (AXIS_ATTENDANCE, AXIS_INTERACTION, AXIS_PAYMENT)]
                for u in us]
        income = [float(w2.users[u].pay or 0) if u in w2.users else 0.0 for u in us]
        retain = [1.0 if (u in w2.users and w2.users[u].att_n > 0) else 0.0 for u in us]
        print(f"{short:<8}{len(us):>9,}{r2(pred, income):>10.3f}{r2(pred, retain):>10.3f}"
              f"  留存率 {sum(retain)/len(retain):.1%}")

    print("\n=== 4. 跨 V 受众重叠 ===")
    profs = {s: profile(load_window(s, N)) for s in VS}
    for i, a in enumerate(VS):
        for b in VS[i + 1:]:
            ov = overlap(profs[a], profs[b])
            fields = {k: v for k, v in vars(ov).items()
                      if isinstance(v, (int, float)) and k != "shared"}
            print(f"  {a} × {b}: {fields}")


if __name__ == "__main__":
    main()
