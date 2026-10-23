"""新分池（2×ACV）到底丢掉了谁？—— 检查被分流走的人里有没有"有效样本"。

看四件事：
1. 被排除的人占多少**付费**、多少**弹幕**；
2. **头部付费者**（前 1%）有多少没进池 —— 这是最可能被误伤的群体；
3. 被排除者的出席率分布（是"来一两次的路人"还是"来得少但花得多"）；
4. 如果把"高付费但低出席"的人强行并回池，结论会不会变。
"""

from __future__ import annotations

import statistics as st

from app.services.fan import load_window
from app.services.fan.pool import pool_size_for

VS = ("弥月", "明前奶绿", "星瞳")


def main() -> None:
    for short in VS:
        w = load_window(short, 75)
        n = max(1, w.n)
        users = sorted(w.users.values(), key=lambda u: (-u.att_n, u.uid))
        ps = pool_size_for(w) or 0
        pool, out = users[:ps], users[ps:]

        pay_all = sum(u.pay for u in users) or 1.0
        msg_all = sum(u.m for u in users) or 1
        pay_pool = sum(u.pay for u in pool)
        pay_out = sum(u.pay for u in out)

        # 头部付费者（全体前 1%）
        by_pay = sorted(users, key=lambda u: -u.pay)
        top_pay = by_pay[:max(1, len(users) // 100)]
        top_in_pool = sum(1 for u in top_pay if u.att_n >= (pool[-1].att_n if pool else 0))

        # 被排除者里"高付费"的人
        pays_in_pool = sorted((u.pay for u in pool if u.pay > 0))
        p95 = pays_in_pool[int(len(pays_in_pool) * 0.95)] if pays_in_pool else 0
        rich_out = [u for u in out if u.pay >= p95 and u.pay > 0]

        att_out = [u.att_n / n for u in out]
        print(f"\n{short}: 池 {len(pool):,} · 分流走 {len(out):,}")
        print(f"  付费：池 {pay_pool:,.0f} 元（{pay_pool/pay_all:.1%}）"
              f" · 分流走 {pay_out:,.0f} 元（{pay_out/pay_all:.1%}）")
        print(f"  弹幕：分流走占 {sum(u.m for u in out)/msg_all:.1%}")
        print(f"  头部付费者(前1%, {len(top_pay)} 人)：进池 {top_in_pool} 人")
        if out:
            print(f"  被排除者出席率：中位 {st.median(att_out):.1%}"
                  f" · p90 {sorted(att_out)[int(len(att_out)*0.9)]:.1%}")
        print(f"  被排除者中「付费 ≥ 池内 p95（{p95:,.0f} 元）」的：{len(rich_out)} 人"
              f"，合计 {sum(u.pay for u in rich_out):,.0f} 元")
        for u in sorted(rich_out, key=lambda x: -x.pay)[:3]:
            print(f"    uid {u.uid}: 出席 {u.att_n}/{n}（{u.att_n/n:.0%}）· 付费 {u.pay:,.0f}"
                  f" · 弹幕 {u.m:,}")


if __name__ == "__main__":
    main()
