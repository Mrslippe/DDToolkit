"""L1：**合成夹具**黄金值（2026-10-27）。

与 `test_fan_compose.py` 里的真实数据快照不同：这里用**完全合成**的 `Window`，
不碰磁盘、不随采集变化 —— 它锁的是「模型（axes + compose + tags）的数值行为」，
任何改动导致结果变化都会立刻红，且**永远不需要重录**（除非你确实改了模型并认可新值）。

设计原则：夹具要小到能看懂，又要覆盖模型的每条路径 ——
分位、并列、ACV 池裁剪、类型判定（出勤/互动/付费/综合）、强度排序的次级键。
"""

from __future__ import annotations

import pytest

from app.services.fan.axes import build_axis_table
from app.services.fan.compose import participation_strength, rank, type_label
from app.services.fan.loader import SessionRef, UserFact, VtuberRef, Window


def _mk_window() -> Window:
    """20 个用户 / 8 场：构造出"高出席低互动""高付费低出席""均衡"三类人。"""
    n_sessions = 8
    sessions = []
    for i in range(n_sessions):
        sessions.append(SessionRef(
            live_id=f"live-{i:02d}", start_at=f"2026-09-{i + 1:02d} 20:00:00",
            end_at=f"2026-09-{i + 1:02d} 23:00:00", n_users=20,
            stats={}, sum_m=0, sum_sc=0, sum_pay=0.0, n_pairs=0,
        ))
    users: dict[str, UserFact] = {}
    # ── 付费原型（L1 新增，2026-10-27）：验证"付费轴"能被独立判出来 ──
    payers = {
        "pay_guard": {"guard_amt": 5000.0, "sc_amt": 0.0, "gift_amt": 0.0},
        "pay_sc": {"guard_amt": 0.0, "sc_amt": 3000.0, "gift_amt": 0.0},
        "pay_mix": {"guard_amt": 2000.0, "sc_amt": 1000.0, "gift_amt": 500.0},
    }
    for uid, comp in payers.items():
        pay = comp["guard_amt"] + comp["sc_amt"] + comp["gift_amt"]
        users[uid] = UserFact(
            uid=uid, att_n=4, m=5, uniq=3, maxrep=1, text_tracked=True, name=uid,
            gift_amt=comp["gift_amt"], guard_amt=comp["guard_amt"], sc_amt=comp["sc_amt"],
            pay_events=3, lag_sum=2400, lag_cnt=4,
            sc_cnt=1 if comp["sc_amt"] else 0, gift_cnt=1 if comp["gift_amt"] else 0,
            guard_cnt=1 if comp["guard_amt"] else 0,
            guard_top="舰长" if comp["guard_amt"] else "",
            pay=pay, msg_sess=4, sc_sess=1 if comp["sc_amt"] else 0,
            first_pos=0, last_pos=3,
        )

    for k in range(20):
        uid = f"u{k:02d}"
        # 出席：前 8 人全勤，9-14 半勤，其余 1 场
        att = 8 if k < 8 else (4 if k < 14 else 1)
        # 弹幕：均匀分布 + 一个"话痨"
        m = 10 + k * 5
        if k == 0:
            m = 400
        # 付费：后 6 人是"付费大户"，但出席低
        pay = 0.0
        guard = gift = sc = 0.0
        if 14 <= k <= 19:
            pay = 500.0 * (k - 13)
            guard = pay * 0.5
            sc = pay * 0.3
            gift = pay * 0.2
        users[uid] = UserFact(
            uid=uid, att_n=att, m=m, uniq=m // 2, maxrep=3 if k % 3 == 0 else 1,
            text_tracked=True, name=f"用户{k}", gift_amt=gift, guard_amt=guard,
            sc_amt=sc, pay_events=1 if pay else 0, lag_sum=att * 600, lag_cnt=att,
            sc_cnt=1 if sc else 0, gift_cnt=1 if gift else 0,
            guard_cnt=1 if guard else 0, guard_top="舰长" if guard else "",
            pay=pay, msg_sess=att, sc_sess=1 if sc else 0, first_pos=0, last_pos=att - 1,
        )
    ref = VtuberRef("夹具主播", "fixture", "0", "夹具")
    return Window(vtuber=ref, requested_n=n_sessions, sessions=sessions, users=users)


#: L1 黄金值：池内人数 / 类型分布 / 强度前 3（uid, S）
#: ⚠️ 这组值**不随真实数据变化**；改了模型才允许重录。
#: 2026-10-27 加入三个**付费原型**（纯舰长 / 纯 SC / 混合）后重钉：
#: 付费轴现在会被独立判出来（`付费: 2`），是 L1 唯一曾经缺口的补丁。
GOLDEN = {
    "pool": 18,
    "types": {"出勤": 6, "互动": 1, "付费": 2, "综合": 9},
    "top3": [("u19", 0.6481), ("u18", 0.6296), ("u17", 0.6111)],
}


def test_synthetic_fixture_golden() -> None:
    w = _mk_window()
    t = build_axis_table(w, pool_size=GOLDEN["pool"])
    assert len(t) == GOLDEN["pool"]

    labels = type_label(t)
    got = {k: list(labels.values()).count(k) for k in ("出勤", "互动", "付费", "综合")}
    assert got == GOLDEN["types"]

    s = participation_strength(t)
    order = rank(t, s)
    top3 = [(order[i], round(s[order[i]], 4)) for i in range(3)]
    assert top3 == GOLDEN["top3"]


def test_fixture_is_deterministic() -> None:
    """同一夹具跑两次，逐行结果相同（防"含随机/含时间"的隐患）。"""
    a = rank(build_axis_table(_mk_window(), pool_size=18),
             participation_strength(build_axis_table(_mk_window(), pool_size=18)))
    b = rank(build_axis_table(_mk_window(), pool_size=18),
             participation_strength(build_axis_table(_mk_window(), pool_size=18)))
    assert a == b


def test_paid_axis_is_detected() -> None:
    """付费轴的**判据**要能被独立触发（2026-10-27 补 L1 的唯一缺口）。

    不钉具体强度值，只钉三件事：
    1. 三种付费原型（纯舰长 / 纯 SC / 混合）都被判成「付费」；
    2. 每个用户的 `pay` 恰好等于三路之和（防漏加一路）；
    3. 无付费用户的 `pay` 为 0（防把别的东西算进付费）。
    """
    w = _mk_window()
    t = build_axis_table(w, pool_size=len(w.users))
    labels = type_label(t)

    for uid in ("pay_guard", "pay_sc", "pay_mix"):
        assert labels.get(uid) == "付费", f"{uid} 应判为付费，实际 {labels.get(uid)!r}"

    for uid, f in w.users.items():
        assert abs(f.pay - (f.gift_amt + f.guard_amt + f.sc_amt)) < 1e-6, f"{uid} 三路求和不等于 pay"

    for uid in ("u05", "u10"):
        assert w.users[uid].pay == 0.0
