"""三种选名单方式，比谁丢的有效样本少。

A. **按出席**（当前实现）：10% 门槛后按出席场次取前 2×ACV —— 已证明会丢鲸鱼。
B. **按核心度**（用户 2026-10-24 提议）：10% 门槛后按强度 S 取前 2×ACV。
C. **并集**：A ∪ B，看额外捞回多少人、多少收入。

指标：收入占比、头部 1% 付费者保留率、被丢掉的"高付费"人数。
"""

from __future__ import annotations

import statistics as st

from app.services.fan import load_window
from app.services.fan.axes import build_axis_table
from app.services.fan.compose import participation_strength
from app.services.fan.pool import pool_size_for

VS = ("弥月", "明前奶绿", "星瞳")


def main() -> None:
    for short in VS:
        w = load_window(short, 75)
        n = max(1, w.n)
        # 10% 门槛的大盘
        base = build_axis_table(w)                     # 默认 floor=0.10
        strength = participation_strength(base)
        size = pool_size_for(w) or 0

        by_att = sorted(base.uids, key=lambda u: (-w.users[u].att_n, u))[:size]
        by_s = sorted(base.uids, key=lambda u: (-strength[u], u))[:size]
        union = set(by_att) | set(by_s)

        users = w.users
        pay_all = sum(users[u].pay for u in base.uids) or 1.0
        by_pay = sorted(base.uids, key=lambda u: -users[u].pay)
        top_pay = by_pay[:max(1, len(by_pay) // 100)]

        def share(sel: set[str]) -> tuple[float, float, int]:
            pay = sum(users[u].pay for u in sel) / pay_all
            keep_top = sum(1 for u in top_pay if u in sel) / len(top_pay)
            missing = sum(1 for u in base.uids if u not in sel and users[u].pay > 0
                          and users[u].pay >= (st.median([users[x].pay for x in sel]) or 0))
            return pay, keep_top, missing

        print(f"\n{short}: 大盘(10%) {len(base.uids):,} · 名单 {size:,}")
        for label, sel in (("A 按出席", set(by_att)), ("B 按核心度", set(by_s)), ("C A∪B", union)):
            pay, keep, missing = share(sel)
            print(f"  {label:<10} 名单 {len(sel):>6,} · 收入占 {pay:>6.1%}"
                  f" · 头部1%付费者保留 {keep:>5.1%} · 高付费被漏 {missing:>4} 人")

        extra = union - set(by_s)
        print(f"  B 之外额外捞回 {len(extra)} 人 · 收入 "
              f"{sum(users[u].pay for u in extra):,.0f} 元")
        if extra:
            demo = sorted(extra, key=lambda u: -users[u].pay)[:3]
            for u in demo:
                print(f"    uid {u}: 出席 {users[u].att_n}/{n} · 付费 {users[u].pay:,.0f}"
                      f" · S={strength[u]:.3f}")


if __name__ == "__main__":
    main()
