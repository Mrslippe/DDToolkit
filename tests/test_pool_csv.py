# -*- coding: utf-8 -*-
"""候选池（C2，需求 7，`devlog/457`）：**产物**与**加载/检索**两层判据。

## 为什么把"产物校验"写进用例

池子是**随包的快照**（`vtubers.csv`，由 `scripts/discover_vtubers.py` 从 vdb 生成）。
它坏了不会报错，只会让"添加 V"里少一批人 —— 所以这里对**真的那份文件**做结构校验：
列齐、uid/uuid 唯一、企划与跨平台账号的覆盖率不是 0（刷新脚本静默退化成"只有名册"时红）。

⚠️ 其中两条吃**真实数据**（不造样本）：① 用真文件校验；② 检索用例挑一条**真的带企划**的行，
断言 `group` 出来 —— 造样本的话，"新列没接上"这种错法照样绿。
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

from app.core import config as cfg
from app.services import pool

POOL_CSV = Path(cfg.PROJECT_ROOT) / "vtubers.csv"
POOL_META = Path(cfg.PROJECT_ROOT) / "vtubers.meta.json"

EXPECTED_COLUMNS = ["flag", "vtuber_name", "platform", "platform_uid", "follower",
                    "uuid", "group_name", "group_uuid", "extra_accounts"]


def _rows() -> list[dict]:
    with POOL_CSV.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


# ── 产物 ──────────────────────────────────────────────────────────────

def test_shipped_pool_has_expected_columns():
    fieldnames = _rows()[0].keys()
    assert list(fieldnames) == EXPECTED_COLUMNS, (
        "池子列变过而读取方/用例没跟上（`app/services/pool.py` 的注释里写着这条同步纪律）")


def test_shipped_pool_keys_are_unique_and_nonempty():
    rows = _rows()
    assert len(rows) > 5000, f"池子只剩 {len(rows)} 行（刷新脚本静默退化了？）"
    uids = [r["platform_uid"] for r in rows]
    assert len(uids) == len(set(uids)), "同一个 B 站 uid 出现两次（检索会出重复条目）"
    assert all(uids), "有空 uid（那行点不动）"
    uuids = [r["uuid"] for r in rows if r["uuid"]]
    assert len(uuids) == len(set(uuids)), "uuid 重复（它是跨平台身份键）"
    assert len(uuids) > len(rows) * 0.9, "绝大多数行都该有 vdb uuid"


def test_shipped_pool_carries_groups_and_extra_accounts():
    """覆盖率**不是 0**：这是"刷新脚本把企划/跨平台账号丢了"的唯一机器判据。

    ⚠️ 阈值只做"有没有"的粗筛（实测 1,633 / 557），不写当前精确值 —— 那是测量值，
    每次刷新都会变（见 `docs/DEV-LOOP.md` 的三分法）。
    """
    rows = _rows()
    with_group = [r for r in rows if r["group_name"]]
    with_extra = [r for r in rows if r["extra_accounts"]]
    assert len(with_group) > 1000, f"带企划的行只剩 {len(with_group)}"
    assert len(with_extra) > 100, f"带跨平台账号的行只剩 {len(with_extra)}"
    assert all(r["group_uuid"] for r in with_group), "有企划名却没有企划 uuid（vdb 取值取错列了）"
    assert {r["group_uuid"] for r in with_group} != {""}, "企划 uuid 全是空串"


def test_meta_matches_the_csv():
    """`vtubers.meta.json` 与 CSV 必须对得上（一对产物，别只更新一个）。"""
    meta = json.loads(POOL_META.read_text(encoding="utf-8"))
    rows = _rows()
    assert meta["rows"] == len(rows)
    assert meta["with_group"] == sum(1 for r in rows if r["group_name"])
    assert meta["groups"] == len({r["group_name"] for r in rows if r["group_name"]})
    assert meta["source"].startswith("https://vdb.vtbs.moe"), "meta 里要写清数据来自哪"
    assert meta["fetched_at"], "meta 缺拉取时刻（排查「这批数据是哪天的」要用）"


# ── 加载与检索 ────────────────────────────────────────────────────────

def test_load_reads_new_columns(tmp_path):
    p = tmp_path / "pool.csv"
    p.write_text("flag,vtuber_name,platform,platform_uid,follower,uuid,group_name,"
                 "group_uuid,extra_accounts\n"
                 "0,某人,bilibili,123,50,u-1,某企划,g-1,twitter:abc|youtube:xyz\n",
                 encoding="utf-8")
    items = pool.load_pool(p)
    assert len(items) == 1
    it = items[0]
    assert it["group_name"] == "某企划" and it["group_uuid"] == "g-1"
    assert it["extra_accounts"] == "twitter:abc|youtube:xyz" and it["uuid"] == "u-1"
    assert it["name_l"] == "某人", "内部字段：加载时预计算小写名（检索循环里不再逐行 lower）"


def test_old_csv_without_new_columns_still_loads(tmp_path):
    """**向后兼容**：老快照（只有五列）必须照样能读（新列取空串，不许炸）。"""
    p = tmp_path / "old.csv"
    p.write_text("flag,vtuber_name,platform,platform_uid,follower\n"
                 "0,老条目,bilibili,999,10\n", encoding="utf-8")
    items = pool.load_pool(p)
    assert len(items) == 1
    assert items[0]["group_name"] == "" and items[0]["extra_accounts"] == ""
    assert items[0]["followers"] == 10


def test_missing_file_is_an_empty_pool_not_an_error(tmp_path):
    assert pool.load_pool(tmp_path / "nope.csv") == []


def test_seed_copies_bundled_pool_once(tmp_path, monkeypatch):
    """**新安装的空数据目录**：第一次用池子时要从随包快照引导一份过来。

    这是 2026-10-08 查出来的真问题：运行时读 `DATA_DIR/vtubers.csv`，而没有任何代码把
    随包那份复制过去 ⇒ 全新安装的候选池是空的（界面上"一条都搜不到"，日志里一个字都没有）。
    """
    dst = tmp_path / "data" / "vtubers.csv"
    monkeypatch.setattr(cfg.settings, "VTUBER_LIST_FILE", str(dst))
    monkeypatch.setattr(pool, "_cache", None)          # 别让别的用例的缓存盖住这一条
    first = pool.seed_from_bundle()
    assert first["seeded"] is True and dst.exists()
    assert dst.stat().st_size == POOL_CSV.stat().st_size, "复制的是随包那份快照"

    second = pool.seed_from_bundle()
    assert second["seeded"] is False and second["reason"] == "already-exists", \
        "已有那份不许被覆盖（用户可能自己换过名单）"
    pool.reload_pool()


def test_seed_is_a_noop_when_bundle_missing(tmp_path, monkeypatch):
    """随包那份也没有（极端情形）⇒ 如实返回原因，不抛异常、不建空文件。"""
    monkeypatch.setattr(cfg.settings, "VTUBER_LIST_FILE", str(tmp_path / "d" / "vtubers.csv"))
    monkeypatch.setattr(pool, "bundled_path", lambda: tmp_path / "no-such.csv")
    out = pool.seed_from_bundle()
    assert out["seeded"] is False and out["reason"] == "bundle-missing"
    assert not (tmp_path / "d" / "vtubers.csv").exists()


@pytest.fixture
def real_pool(monkeypatch):
    """把池子指向**真·随包快照**（检索用例吃真实数据，见文件头第 2 条）。"""
    monkeypatch.setattr(cfg.settings, "VTUBER_LIST_FILE", str(POOL_CSV))
    monkeypatch.setattr(pool, "_cache", None)
    yield pool._pool()
    pool.reload_pool()


def test_search_by_name_returns_group_and_extra(real_pool):
    rows = _rows()
    sample = next(r for r in rows
                  if r["group_name"] and len(r["vtuber_name"]) >= 3
                  and r["vtuber_name"].isascii() is False)
    hits = pool.search_pool(sample["vtuber_name"][:3], limit=20)
    assert hits, f"搜「{sample['vtuber_name'][:3]}」一条都没有"
    exact = [h for h in hits if h["platform_uid"] == sample["platform_uid"]]
    assert exact, "按名字搜不到那条真实数据（检索口径变了？）"
    hit = exact[0]
    assert hit["group"] == sample["group_name"], "新列没接到 API 形状上"
    assert "name_l" not in hit, "内部字段漏出去了"
    assert set(hit) <= {"name", "platform", "platform_uid", "group", "group_uuid", "uuid", "extra"}
    # ⚠️ 两列 uuid 不是一回事：`uuid` = 这个人、`group_uuid` = 企划（写这块时搞混过一次）
    assert hit["group_uuid"] == sample["group_uuid"]


def test_search_by_uid_prefix_and_multi_token_and(real_pool):
    """老口径回归：纯数字按 uid 前缀；空格分隔的关键词是 **AND**。"""
    rows = _rows()
    uid = rows[0]["platform_uid"]
    assert any(h["platform_uid"] == uid for h in pool.search_pool(uid[:6], limit=50))
    name = rows[0]["vtuber_name"]
    if len(name) >= 2:
        assert pool.search_pool(f"{name[0]} 不存在的后缀xyz") == [], "AND 口径失效了？"


def test_find_in_pool_is_an_index_lookup(real_pool):
    rows = _rows()
    sample = next(r for r in rows if r["group_name"])
    hit = pool.find_in_pool("bilibili", sample["platform_uid"])
    assert hit and hit["group"] == sample["group_name"]
    assert pool.find_in_pool("bilibili", "000000000000") is None


def test_pool_meta_reports_coverage(real_pool):
    meta = pool.pool_meta()
    assert meta["rows"] > 5000 and meta["with_group"] > 1000
    assert meta["snapshot"]["source"].startswith("https://vdb.vtbs.moe")


# ── 生成脚本的纯逻辑（`scripts/discover_vtubers.py`） ────────────────────
#
# 为什么也要测：脚本的产物是**随包快照**，它错了不会报错（界面只是少一批人）。
# 这两条钉住最容易错的两处：`type=="group"` 的条目要跳过、脏名字键要能兜住。

def _script():
    import importlib.util
    import sys as _sys

    if "discover_vtubers_under_test" in _sys.modules:
        return _sys.modules["discover_vtubers_under_test"]
    spec = importlib.util.spec_from_file_location(
        "discover_vtubers_under_test", Path(cfg.PROJECT_ROOT) / "scripts" / "discover_vtubers.py")
    mod = importlib.util.module_from_spec(spec)
    _sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def test_parse_roster_skips_group_entries_and_keeps_group_fields():
    m = _script()
    doc = {"vtbs": [
        # 企划本身也是条目（group == uuid、无账号）—— 照收会多出一批"没有账号的 V"
        {"uuid": "g-1", "type": "group", "group": "g-1", "group_name": "某企划",
         "name": {"cn": "某企划"}, "accounts": []},
        # 正常的人：official B 站账号 + 企划 + 跨平台账号
        {"uuid": "u-1", "type": "vtuber", "group": "g-1", "group_name": "某企划",
         "name": {"cn": "某人"}, "accounts": [
             {"platform": "bilibili", "id": "123", "type": "official"},
             {"platform": "twitter", "id": "abc", "type": "official"}]},
        # 只有 relay（搬运号）⇒ 不收
        {"uuid": "u-2", "type": "vtuber", "name": {"cn": "搬运"},
         "accounts": [{"platform": "bilibili", "id": "456", "type": "relay"}]},
    ]}
    rows, stats = m.parse_roster(doc)
    assert [r["uid"] for r in rows] == ["123"], rows
    assert rows[0]["group_name"] == "某企划" and rows[0]["group_uuid"] == "g-1"
    assert rows[0]["uuid"] == "u-1", "`uuid` 是这个人的（不是企划的）"
    assert rows[0]["extra_accounts"] == "twitter:abc"
    assert stats["group_entries_skipped"] == 1 and stats["no_official_skipped"] == 1
    assert stats["with_group"] == 1 and stats["with_extra"] == 1


def test_pick_name_survives_dirty_language_keys():
    """实测 vdb 里有 `CN` / `cn+` / `水镜Beryl` / `ID(印度尼西亚)` 这类键 ——
    早先只认 `cn/en/jp`，那些条目会被整条丢掉。"""
    m = _script()
    # ⚠️ 用例必须让**脏键排在正确键前面**：`pick_name` 最后有一条"兜底取第一个非空值"，
    # 脏键在后面时兜底恰好也能取对 ⇒ 那样的断言杀不死"只认三个键"这个变异（第一版就这么假绿过）。
    assert m.pick_name({"name": {"水镜Beryl": "误", "CN": "对"}}) == "对", \
        "`CN` 没被认出来 ⇒ 兜底取到了脏键"
    assert m.pick_name({"name": {"cn": "甲", "JP": "乙"}}) == "甲"
    assert m.pick_name({"name": {"default": "jp", "jp": "默认语言"}}) == "默认语言"
    assert m.pick_name({"name": {"ID(印度尼西亚)": "兜底"}}) == "兜底"
    assert m.pick_name({"name": {}}) == ""