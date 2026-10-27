"""对比页 · 帖子评论模式的服务层测试（2026-10-28，P3）。

**不打网络**：用录制的 JSON 形状喂 `fetch_users`，用纯函数测重叠统计。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.routers.fan_compare import overlap_stats
from app.services import bili_replies as br


def _reply(mid: int, uname: str, ctime: int, rpid: int, rcount: int = 0) -> dict:
    return {
        "rpid": rpid, "rpid_str": str(rpid), "ctime": ctime, "rcount": rcount,
        "member": {"mid": mid, "uname": uname},
    }


def test_parse_target_variants() -> None:
    assert br.parse_target("BV1xx411c7mD") == ("bvid", "BV1xx411c7mD")
    assert br.parse_target("av12345") == ("aid", "12345")
    assert br.parse_target("https://t.bilibili.com/998877") == ("dynamic", "998877")
    assert br.parse_target("123456") == ("dynamic", "123456")
    assert br.parse_target("https://www.bilibili.com/video/BV1xx411c7mD")[0] == "bvid"
    with pytest.raises(ValueError):
        br.parse_target("这不是链接")


def test_fetch_users_aggregates_and_marks_partial(monkeypatch) -> None:
    """主楼按 uid 聚合、楼中楼计入 `sub_cnt`；拿不满时标 partial。"""

    pages = {
        1: {"data": {"cursor": {"all_count": 100, "is_end": False, "next": 2}, "replies": [
            _reply(1, "甲", 1700000000, 11, rcount=5),
            _reply(2, "乙", 1700000100, 12),
            _reply(1, "甲", 1700000200, 13),
        ]}},
        2: {"data": {"cursor": {"all_count": 100, "is_end": True, "next": 0}, "replies": [
            _reply(3, "丙", 1700000300, 14),
        ]}},
    }
    subs = {"data": {"replies": [{"member": {"mid": 9, "uname": "丁"}}]}}

    async def fake_get(client, url, params=None, **kw):
        if url.endswith("/x/v2/reply/main"):
            # 第一页不带 next，第二页带 next=2
            nxt = (params or {}).get("next")
            return pages.get(int(nxt) if nxt else 1)
        if url.endswith("/x/v2/reply/reply"):
            return subs
        return None

    monkeypatch.setattr(br, "_get", fake_get)
    monkeypatch.setattr(br, "GAP_S", 0)

    st = br.ScanState(scan_id="t1")
    users = asyncio.run(br.fetch_users(None, "video", "1", with_sub=True, state=st))
    by_uid = {u["uid"]: u for u in users}

    assert by_uid["1"]["cnt"] == 2, "同一用户两条主楼要合并"
    assert by_uid["1"]["first_ms"] and by_uid["1"]["last_ms"]
    # 首页 3 条主楼都进了"楼中楼"清单（SUB_TOP=50），每条各返回同一批子回复 ⇒ 3 次计入
    assert by_uid["9"]["sub_cnt"] == 3, "楼中楼记到 sub_cnt"
    assert st.expected == 100 and st.fetched == 4
    assert st.partial is True, "只拿到 4/100 必须标 partial"
    assert users[0]["uid"] == "1", "名单按评论数降序"


def test_overlap_stats_is_pure_and_bounded() -> None:
    tier = {f"u{i}": ("核心" if i < 2 else "外层") for i in range(10)}
    strength = {f"u{i}": 1.0 - i * 0.05 for i in range(10)}
    users = [{"uid": "u0", "name": "甲", "cnt": 9}, {"uid": "x9", "name": "外", "cnt": 5}]

    out = overlap_stats(tier, strength, users, top_n=500)
    ov = out["overlap"]
    assert ov["shared"] == 1
    assert 0.0 <= ov["jaccard"] <= 1.0
    assert 0.0 <= ov["p_value"] <= 1.0 and 0.0 <= ov["p_value_lower"] <= 1.0
    assert out["tiers"]["核心"] == {"hit": 1, "miss": 1}
    assert out["shared"][0]["uid"] == "u0" and out["shared"][0]["tier"] == "核心"


def test_scan_snapshot_roundtrip(tmp_path: Path) -> None:
    """落盘 → 读回：`users` 不进状态接口，但名单接口能拿到。"""
    st = br.ScanState(scan_id="abc123", input="BV1")
    st.state = "done"
    st.users = [{"uid": "1", "name": "甲", "cnt": 2, "sub_cnt": 0}]
    br.save(st, tmp_path)

    snap = br.load("abc123", tmp_path)
    assert snap is not None
    assert snap["scan_id"] == "abc123"
    assert snap["users"][0]["cnt"] == 2
    assert br.load("nope", tmp_path) is None
