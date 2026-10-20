"""`fan.quality` 的用例：回放段识别与裁剪。"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from app.services.fan.quality import apply_replay_cut, find_replay_from

CN = timezone(timedelta(hours=8))


def _raw_with_replay() -> dict:
    """构造 raw：第 1、2 小时各 60 条不同文本；第 3 小时把第 1 小时的 60 条**原样复制**。"""
    base = datetime(2026, 10, 3, 19, 0, tzinfo=CN)
    mt, mh = [], []
    for i in range(60):
        t = int((base + timedelta(seconds=i * 60)).timestamp() * 1000)
        mt.append(t)
        mh.append(1000 + i)                     # 第一小时：哈希 1000..1059
    for i in range(60):
        t = int((base + timedelta(hours=1, seconds=i * 60)).timestamp() * 1000)
        mt.append(t)
        mh.append(2000 + i)                     # 第二小时：全新内容
    for i in range(60):
        t = int((base + timedelta(hours=3, seconds=i * 60)).timestamp() * 1000)
        mt.append(t)
        mh.append(1000 + i)                     # 第三小时：复制第一小时
    raw = {"u1": {"m": len(mt), "mt": mt, "mh": mh, "uniq": len(set(mh)),
                  "maxrep": 1, "e": 0, "et": [], "p": 0.0, "pe": 0, "pt": [],
                  "pl": [], "g": 0.0, "gd": 0.0, "sc": 0.0, "sc_cnt": 0,
                  "gift_cnt": 0, "guard_cnt": 0, "guard_top": None}}
    return raw


def test_find_replay_from_detects_replayed_hour():
    raw = _raw_with_replay()
    start, dropped, ratio = find_replay_from(raw)
    assert start is not None
    assert dropped == 60, dropped
    assert ratio == 1.0, ratio
    when = datetime.fromtimestamp(start / 1000, tz=CN)
    assert when.hour == 22 and when.day == 3, when   # 19 点 + 3 小时


def test_apply_replay_cut_trims_danmaku_and_stats():
    raw = _raw_with_replay()
    stats = {
        "records": 180, "type0": 180, "type_hist": {"0": 180},
        "uniq_total": 120, "dup_rate": 0.333,
        "end_at": "2026-10-03 23:00:00.000000",       # 故意给晚一点，验证取较早者
    }
    assert apply_replay_cut(raw, stats) is True

    u = raw["u1"]
    assert u["m"] == 120, u["m"]                       # 只留前两小时
    assert len(u["mt"]) == len(u["mh"]) == 120
    assert u["uniq"] == 120 and u["maxrep"] == 1
    assert stats["type0"] == 120 and stats["records"] == 120
    assert stats["dropped_replay"] == 60
    assert stats["replay_from"].startswith("2026-10-03 22:00")
    assert stats["end_at"] <= "2026-10-03 23:00:00.000000"

    # 幂等：再跑一次不应再裁
    before = json.dumps(raw, sort_keys=True)
    assert apply_replay_cut(raw, stats) is False
    assert json.dumps(raw, sort_keys=True) == before


def test_no_replay_when_content_is_all_new():
    base = datetime(2026, 10, 3, 19, 0, tzinfo=CN)
    mt, mh = [], []
    for i in range(120):
        mt.append(int((base + timedelta(minutes=i)).timestamp() * 1000))
        mh.append(5000 + i)
    raw = {"u1": {"m": 120, "mt": mt, "mh": mh, "uniq": 120, "maxrep": 1}}
    start, dropped, _ = find_replay_from(raw)
    assert start is None and dropped == 0
