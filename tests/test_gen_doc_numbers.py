# -*- coding: utf-8 -*-
"""文档数字门禁自身的用例（`scripts/gen_doc_numbers.py`）。

为什么给它写用例：这个脚本的价值全在"**它算得对不对**"。
2026-09-23 首版就漏算了 `@router.api_route(...)`（把 64 数成 62）—— 而**派生器算错比不查更糟**：
它会把错值写进文档，还一路绿灯。所以这里既验"能不能抓到漂移"，也验"会不会误报"。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import gen_doc_numbers as G  # noqa: E402

# 受限沙箱下系统临时目录不可写（同 test_doc_check），假文档建在工作区内。
_TEST_TMP = ROOT / "_test_tmp" / "gen_numbers"


def test_derived_values_are_in_sane_ranges():
    t = G.derive_all()
    assert 1 <= t["table_count"] <= 60, t["table_count"]
    assert 1 <= t["migration_count"] <= 200, t["migration_count"]
    assert 1 <= t["route_decorators"] <= 400, t["route_decorators"]
    assert t["devlog_max"] > 0


def test_declared_head_matches_alembic_head():
    """不变量 §6.3：`app/main.py::MIGRATION_HEAD` 必须等于 alembic 链的 head。"""
    t = G.derive_all()
    assert t["declared_head"] == t["migration_head"], (
        f"main.py 写 `{t['declared_head']}`，alembic head 是 `{t['migration_head']}`"
        " —— 不同步会让冷启动快路径把旧库误判为已最新")


def test_route_count_includes_api_route():
    """回归：装饰器口径必须含 `@router.api_route(...)`（首版漏算它，把 64 数成 62）。"""
    n_single = n_api = 0
    for p in (ROOT / "app" / "routers").glob("*.py"):
        text = p.read_text(encoding="utf-8")
        n_single += len(re.findall(r"@router\.(?:get|post|put|patch|delete)\b", text))
        n_api += len(re.findall(r"@router\.api_route\(", text))
    assert n_api > 0, "本仓应当有 api_route 装饰器；没有的话这条护栏失去意义"
    assert G.derive_routes() == n_single + n_api


def test_sanity_flags_out_of_range():
    t = G.derive_all()
    t["route_decorators"] = 0                     # 明显异常
    assert G.check_sanity(t), "越界值必须被 check_sanity 抓到"


def test_sanity_passes_on_real_values():
    assert G.check_sanity(G.derive_all()) == []


def _fake_doc(monkeypatch, text: str):
    """把扫描范围换成一份假文档（不动真仓库）。"""
    import shutil

    shutil.rmtree(_TEST_TMP, ignore_errors=True)
    _TEST_TMP.mkdir(parents=True)
    f = _TEST_TMP / "FAKE.md"
    f.write_text(text, encoding="utf-8")
    monkeypatch.setattr(G, "scan_targets", lambda: [f])
    return f


def test_claim_mismatch_is_reported(monkeypatch):
    _fake_doc(monkeypatch, "迁移链 a001 → f001，共 3 个版本\n")
    assert G.check_claims(G.derive_all()), "文档里的错值必须被报出来"


def test_claim_match_is_not_reported(monkeypatch):
    t = G.derive_all()
    _fake_doc(monkeypatch, f"迁移链 a001 → {t['migration_head']}\n")
    assert G.check_claims(t) == []


def test_historical_mentions_are_not_flagged(monkeypatch):
    """历史引用（"某表由 f004 引入"）不该被当成漂移 —— 这是本脚本最关键的误报防线。

    本仓 `f006` 有 20+ 处提及，其中大多数是正确的历史引用，改它们反而错。
    """
    t = G.derive_all()
    _fake_doc(monkeypatch, "| `f004` | 建 `vtuber_field_history`（devlog/074） |\n")
    assert G.check_claims(t) == [], "历史引用被误判成了当前状态声明"


def test_current_head_pattern_takes_the_last_number_on_the_line(monkeypatch):
    """迁移表同一行常同时出现历史编号与当前 head ⇒ 必须取 `当前 head` 之前**最后**一个。"""
    t = G.derive_all()
    head = t["migration_head"]
    # 历史编号 f004 在前、当前 head 在后 —— 不该报 f004
    _fake_doc(monkeypatch, f"| `f004` | 老迁移 | `{head}` | 新迁移 = **当前 head** |\n")
    assert G.check_claims(t) == [], "同一行里的历史编号被误判成当前 head"


def test_full_run_on_current_repo_is_clean():
    fails, _warns = G.run(quiet=True)
    assert fails == [], "文档数字漂移：" + "；".join(fails)
