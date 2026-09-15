# -*- coding: utf-8 -*-
"""文档漂移门禁自身的用例（`scripts/doc_check.py`，devlog/085）。

为什么给它写用例：门禁的价值全在"**它会不会红**"。
2026-09-15 实测抓到三处真漂移（082/084 没进 devlog 索引、`v1.0.1.md` 没进 docs/README），
其中"仓库当前是干净的"这条断言本身就是最实用的那条 —— 它让漂移在 pytest 里就红，
而不是等几个月后有人想查"那版改了什么"。
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import doc_check as D  # noqa: E402


def test_devlog_numbers_are_read_from_filenames():
    nums = D.devlog_numbers()
    assert len(nums) >= 80, f"只解析出 {len(nums)} 篇 devlog（命名规范变了？）"
    assert nums == sorted(nums), "devlog 编号应当递增有序"
    assert 1 in nums and nums[-1] >= 84
    assert len(nums) == len(set(nums)), "有重复编号"


def test_index_parsing_finds_the_real_table():
    """索引表解析必须真读到行 —— 解析不到会让门禁**静默全绿**（本仓踩过三次的坑）。"""
    indexed = D.indexed_numbers()
    assert len(indexed) >= 30, f"只解析到 {len(indexed)} 行索引（表格式变了？）"
    assert 78 in indexed and 83 in indexed


def test_recent_devlogs_must_be_indexed():
    """最近 5 篇必须在索引里（放宽的规则：早期 devlog 按批次建索引，不强求逐篇）。"""
    fails, _warns = D.check_devlog_index()
    assert fails == [], "最近 5 篇 devlog 有没回填索引的：" + "；".join(fails)


def test_versions_and_notes_are_consistent():
    fails, _warns = D.check_versions()
    assert fails == [], "；".join(fails)
    fails2, _warns2 = D.check_release_notes()
    assert fails2 == [], "；".join(fails2)


def test_full_run_on_current_repo_is_clean():
    """整仓当前状态：不允许有 FAIL（警告可以有 —— 历史遗留项，不逼考古）。"""
    fails, _warns = D.run(quiet=True)
    assert fails == [], "文档漂移：" + "；".join(fails)


def test_missing_anchor_is_reported_not_swallowed(monkeypatch, tmp_path):
    """表格式变了要**报错**而不是当"没问题"：把索引段替换成空文本，检查必须红。"""
    fake = tmp_path / "ROADMAP-DONE.md"
    fake.write_text("# 没有索引表\n", encoding="utf-8")
    monkeypatch.setattr(D, "ROADMAP_DONE", fake)
    fails, _warns = D.check_devlog_index()
    assert fails, "索引表整段缺失时门禁没报错 —— 它会静默全绿"


@pytest.mark.parametrize("marker", ["TODO", "待填"])
def test_notes_placeholder_detection(marker):
    text = "## v9.9.9\n\n" + ("内容。" * 80) + f"\n{marker}: 补充\n"
    problems = D.__dict__.get("notes_problems")
    if problems is None:            # 复用 release.py 的实现（单一来源）
        import release as R
        problems = R.notes_problems
    assert any("占位符" in p for p in problems(text))
