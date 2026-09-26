# -*- coding: utf-8 -*-
"""`/vtuber/fetch-status` 那份跨线程状态的锁约定（批次 5，devlog/210）。

**为什么写这一组**：`scheduler.py` 里原话是"仅简单赋值，GIL 下线程安全" —— **那句话是错的**，
而且已经被自己的代码破坏：

- `recent` 是**读-改-写**（append + 裁到 100），并发抓取时两个线程可以互相踩；
- `external` **一次改 4 个字段**（seq / last_label / running / label）；
- ⚠️ 而 `get_fetch_status()` 给出去的是**浅拷贝** ⇒ `recent` 那个 list 与内部状态**是同一个
  对象**：前端（每几秒轮询一次）一边遍历、抓取线程一边 append ⇒ 读到"改了一半"的状态。

判据分两层：
① **不共享结构**（确定性，主判据）：拿到的 payload 与内部状态互不影响；
② **跨字段一致**（并发，需要放大竞态才红）：任何一份快照都满足
   `running == (label is not None)`（外部任务里这两个字段必须一起变）。
"""
from __future__ import annotations

import threading
import time

from app.services import scheduler as sch


def _reset() -> None:
    """把状态清回出厂（这一组用例自己动手，不靠别的用例的残留）。"""
    with sch._status_lock:
        sch._external_labels.clear()
        sch._status["external"].update(
            {"running": False, "label": None, "last_label": None, "seq": 0})
        sch._status["account"]["recent"] = []


class _Acc:
    """够用的账号替身（`_push_account_snapshot` 只读这几个属性）。"""

    def __init__(self, uid: str) -> None:
        self.platform_uid = uid
        self.display_name = f"V{uid}"
        self.sign = ""
        self.followers_count = 0
        self.live_status = 0
        self.live_title = None
        self.avatar_path = None


# ── ① 不共享结构（把锁去掉这条**必红**）────────────────────────────────

def test_status_payload_does_not_alias_the_internal_state():
    """payload 里的 `recent` / 子字典必须与内部状态**不是同一个对象**。

    反向验证：把 `_status_snapshot()` 改回 `{**_status["account"], …}` 那种浅拷贝 ⇒ 本用例红
    （第二段断言：改 payload 会**改到**内部状态）。
    """
    _reset()
    sch._push_account_snapshot(_Acc("1"))

    payload = sch.get_fetch_status()
    # 往 payload 里乱改：不许影响内部状态
    payload["account"]["recent"].clear()
    payload["account"]["running"] = "tampered"
    payload["external"]["seq"] = 999
    assert sch._status["account"]["recent"], "改 payload 改到了内部状态（还是浅拷贝）"
    assert sch._status["account"]["running"] is not "tampered"      # noqa: F632
    assert sch._status["external"]["seq"] != 999

    # 反方向：拿到 payload 之后内部再变，payload 不许跟着变（快照语义）
    before = list(payload["account"]["recent"])
    sch._push_account_snapshot(_Acc("2"))
    assert payload["account"]["recent"] == before, "payload 是活引用，不是快照"


def test_recent_is_capped_at_100():
    """`recent` 上限 100（前端按增长派事件，无界增长会把轮询 payload 越撑越大）。"""
    _reset()
    for i in range(130):
        sch._push_account_snapshot(_Acc(str(i)))
    assert len(sch._status["account"]["recent"]) == 100
    assert sch.get_fetch_status()["account"]["recent"][-1]["platform_uid"] == "129"


# ── ② 跨字段一致（并发；锁去掉 + 放大竞态才红）──────────────────────────

def test_external_state_is_never_seen_half_updated():
    """并发跑外部任务时，**任何一份快照**都必须自洽：`running == (label is not None)`。

    为什么这条判据成立：`running` 与 `label` 是"一起变"的两个字段
    （`external_task_started` 里先置 running 再拼 label；finished 里反过来）。
    没有锁时读线程正好落在中间 ⇒ 看到 `running=True, label=None`。

    反向验证：把 `external_task_started` 的临界区拆开（两行之间插 `time.sleep(0)`）
    并把锁去掉 ⇒ 本用例必须红。红不了就加大 THREADS / ROUNDS。
    """
    _reset()
    THREADS, ROUNDS = 6, 400
    bad: list[tuple[bool, object]] = []
    stop = threading.Event()

    def worker(tid: int) -> None:
        for i in range(ROUNDS):
            token = f"{tid}:{i}"
            sch.external_task_started(token, f"任务{tid}")
            sch.external_task_finished(token)
        # 收工：把自己登记过的清干净
        with sch._status_lock:
            sch._external_labels.clear()

    def reader() -> None:
        while not stop.is_set():
            st = sch.get_fetch_status()["external"]
            if st["running"] != (st["label"] is not None):
                bad.append((bool(st["running"]), st["label"]))

    threads = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(THREADS)]
    readers = [threading.Thread(target=reader, daemon=True) for _ in range(2)]
    for t in readers:
        t.start()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    stop.set()
    for t in readers:
        t.join(timeout=2)

    assert not bad, f"读到了改了一半的外部状态（前 3 条）：{bad[:3]}"


def test_concurrent_pushes_never_exceed_the_cap():
    """并发 push 之下 `recent` 也不许超过 100（append 与裁剪必须是一个整体）。"""
    _reset()
    THREADS, ROUNDS = 6, 60
    threads = [threading.Thread(target=lambda t=t: [
        sch._push_account_snapshot(_Acc(f"{t}-{i}")) for i in range(ROUNDS)], daemon=True)
        for t in range(THREADS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(sch._status["account"]["recent"]) <= 100
    assert len(sch.get_fetch_status()["account"]["recent"]) == len(
        sch._status["account"]["recent"])
    _reset()


def test_unknown_token_finish_is_harmless():
    """未知 token 的 finish 不该抛（调用点可能重复收尾，也可能跨轮清过表）。"""
    _reset()
    sch.external_task_finished("never-started")
    st = sch.get_fetch_status()["external"]
    assert st["running"] is False and st["label"] is None
    assert st["seq"] >= 1        # seq 照常自增：前端靠它发 fetch-idle
