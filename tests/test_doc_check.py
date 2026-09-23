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
    indexed = set(D.index_rows())
    assert len(indexed) >= 30, f"只解析到 {len(indexed)} 行索引（表格式变了？）"
    assert 78 in indexed and 83 in indexed


def test_devlogs_above_watermark_must_be_indexed():
    """有则必填：编号 > 历史水位线的 devlog 必须在索引里（水位线以下不逼考古）。

    2026-09-23 起取代旧的「最近 5 篇」滑动窗口 —— 那个窗口在欠 10 篇时只红最后 5 篇。
    """
    fails, _warns = D.check_devlog_index()
    assert fails == [], "有 devlog 未回填索引：" + "；".join(fails)


# 受限沙箱下系统临时目录不可写（同 test_services 首启用例），假仓库建在工作区内。
_TEST_TMP = ROOT / "_test_tmp" / "doc_check"


def _fake_repo(monkeypatch, devlog_nums, index_nums, label="条目"):
    """造一个假仓库：`devlog/` 里有这些编号的文件，索引表里有这些编号的行。

    注：不用 pytest 的 `tmp_path` —— 受限沙箱下系统临时目录不可写（`test_services`
    首启用例记过同一条）；`_test_tmp/` 已在 .gitignore 里。
    """
    import shutil

    shutil.rmtree(_TEST_TMP, ignore_errors=True)
    dl = _TEST_TMP / "devlog"
    dl.mkdir(parents=True)
    for n in devlog_nums:
        (dl / f"{n:03d}-x.md").write_text("x", encoding="utf-8")
    rows = "\n".join(f"| {label} {n} | {n:03d} |" for n in index_nums)
    rm = _TEST_TMP / "ROADMAP-DONE.md"
    rm.write_text(f"## {D.INDEX_SECTION}\n\n{rows}\n", encoding="utf-8")
    monkeypatch.setattr(D, "DEVLOG", dl)
    monkeypatch.setattr(D, "ROADMAP_DONE", rm)


def test_orphan_devlog_above_watermark_fails(monkeypatch):
    """水位线以上的正向孤儿必须红（这是「有则必填」的核心断言）。"""
    monkeypatch.setattr(D, "LEGACY_UNINDEXED_THROUGH", 5)
    _fake_repo(monkeypatch, [4, 6], [4])
    fails, warns = D.check_devlog_index()
    assert any("未回填索引" in f for f in fails), fails
    assert warns == [], warns


def test_legacy_devlog_below_watermark_only_warns(monkeypatch):
    """水位线以下的历史欠账只警告，不阻塞。"""
    monkeypatch.setattr(D, "LEGACY_UNINDEXED_THROUGH", 5)
    _fake_repo(monkeypatch, [4, 6], [6])
    fails, warns = D.check_devlog_index()
    assert fails == [], fails
    assert any("历史 devlog" in w for w in warns), warns


def test_duplicate_index_rows_are_reported(monkeypatch):
    """重号必须红 —— 旧实现返回 set，把它静默去重了（2026-09-23 实测 162 就是两行）。"""
    _fake_repo(monkeypatch, [10, 11], [10, 11, 11])
    fails, _warns = D.check_devlog_index()
    assert any("重复编号" in f for f in fails), fails


def test_ghost_index_rows_are_reported(monkeypatch):
    """幽灵行（索引指向不存在的 devlog）要报出来，但不阻塞。"""
    _fake_repo(monkeypatch, [10, 11], [10, 11, 12])
    fails, warns = D.check_devlog_index()
    assert fails == [], fails
    assert any("幽灵行" in w for w in warns), warns


def test_fat_index_label_is_reported(monkeypatch):
    """第一列过肥要红 —— 2026-09-23 瘦身前这一列漂到过 600–1900 字符（占全文 60%）。"""
    _fake_repo(monkeypatch, [10], [10], label="长" * 300)
    fails, _warns = D.check_devlog_index()
    assert any("第一列超过" in f for f in fails), fails


def test_normal_index_label_is_not_flagged(monkeypatch):
    """正常长度的标签不该被误报（现有最长 151 字符）。"""
    _fake_repo(monkeypatch, [10], [10], label="R40 数据视图改牌堆：一次只显示一张卡")
    fails, _warns = D.check_devlog_index()
    assert not any("第一列超过" in f for f in fails), fails


def test_index_section_is_scoped_to_its_own_section(monkeypatch):
    """切段必须停在下一个 `## `。

    回归：旧实现用 `text.find(INDEX_SECTION)` —— 而本仓**文件开头导语里也出现过这几个字**
    （第 8 行），于是它从那里一路扫到文件尾，把需求清单、能力现状等别的表全算进来了
    （2026-09-23 实测：覆盖 802 行，正确范围只有 153 行）。
    """
    import shutil

    shutil.rmtree(_TEST_TMP, ignore_errors=True)
    _TEST_TMP.mkdir(parents=True)
    f = _TEST_TMP / "ROADMAP-DONE.md"
    f.write_text(
        f"导语里提到 {D.INDEX_SECTION} 一次\n\n"
        f"## {D.INDEX_SECTION}\n\n| a | 010 |\n\n"
        "## 别的章节\n\n| 不该被扫到 | 011 |\n",
        encoding="utf-8")
    monkeypatch.setattr(D, "ROADMAP_DONE", f)
    assert D.index_rows() == [10], f"切段没停在本节，扫到了 {D.index_rows()}"


def test_versions_and_notes_are_consistent():
    fails, _warns = D.check_versions()
    assert fails == [], "；".join(fails)
    fails2, _warns2 = D.check_release_notes()
    assert fails2 == [], "；".join(fails2)


def test_full_run_on_current_repo_is_clean():
    """整仓当前状态：不允许有 FAIL（警告可以有 —— 历史遗留项，不逼考古）。"""
    fails, _warns = D.run(quiet=True)
    assert fails == [], "文档漂移：" + "；".join(fails)


def test_missing_anchor_is_reported_not_swallowed(monkeypatch):
    """表格式变了要**报错**而不是当"没问题"：把索引段替换成空文本，检查必须红。

    注：不用 `tmp_path` —— 受限沙箱下系统临时目录不可写（同 `_fake_repo`）。
    """
    import shutil

    shutil.rmtree(_TEST_TMP, ignore_errors=True)
    _TEST_TMP.mkdir(parents=True)
    fake = _TEST_TMP / "ROADMAP-DONE.md"
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


# ── TODO §1 的「已落地残留」（2026-09-24 加）──────────────────────────────

def _fake_todo(monkeypatch, rows: list[str]):
    import shutil

    shutil.rmtree(_TEST_TMP, ignore_errors=True)
    _TEST_TMP.mkdir(parents=True)
    f = _TEST_TMP / "TODO.md"
    f.write_text("## 1. 未完成项\n\n| 项 | 性质 | 说明 |\n|---|---|---|\n"
                 + "\n".join(rows) + "\n\n## 2. 能力现状\n", encoding="utf-8")
    monkeypatch.setattr(D, "TODO", f)
    return f


def test_todo_landed_row_is_reported(monkeypatch):
    """性质列说"已落地"的条目必须红 —— 实测 §1.1 堆过 12 条（18 条里 12 条已完成）。"""
    _fake_todo(monkeypatch, ["| **R15 前端三处小改** | ✅ **已落地**（devlog/087） | … |"])
    fails, _w = D.check_todo_not_stale()
    assert fails, "§1 里的已落地条目没被报出来"


def test_todo_partially_landed_row_is_not_reported(monkeypatch):
    """**回归**：一个需求"5 批只落了 1 批"时，行里出现"已落地"是**对的**，不该判红。

    （2026-09-24 首版按整行匹配，把 R38 那行误报了 —— R38 的批 1 落地、批 2–5 还没做。）
    """
    _fake_todo(monkeypatch, [
        "| **R38 状态胶囊形变动效** | 前端（规格已就绪） | ① motion token 化 ✅ 已落地（devlog/167）→ ② 形变 |"])
    fails, _w = D.check_todo_not_stale()
    assert fails == [], fails


# ── 设计规格的「现状断言」（2026-09-24 加）────────────────────────────────

def _fake_design(monkeypatch, text: str):
    import shutil

    shutil.rmtree(_TEST_TMP, ignore_errors=True)
    _TEST_TMP.mkdir(parents=True)
    f = _TEST_TMP / "design-fake.md"
    f.write_text(text, encoding="utf-8")
    monkeypatch.setattr(D, "DOCS", _TEST_TMP)
    return f


def test_spec_undated_claim_is_warned(monkeypatch):
    """无日期的现状断言要提醒 —— 实测规格声称 `--ease-standard`「已在用」，实际是错的，挂了一周。"""
    _fake_design(monkeypatch, "| 曲线 | x | 进入 | **已在用**（`.si-panel` 入场曲线） |\n")
    _f, warns = D.check_spec_claims()
    assert warns, "无日期的现状断言没被提醒"


def test_spec_dated_claim_is_not_warned(monkeypatch):
    """带核实日期的算"快照"，是合法的（三分法里的第三类）。"""
    _fake_design(monkeypatch, "> **现状基线（2026-09-17 快照）**：`si-panel-in` 220ms\n")
    _f, warns = D.check_spec_claims()
    assert warns == [], warns


def test_spec_quoted_claim_is_not_warned(monkeypatch):
    """`「…」`/`"…"` 里的算**提及**不算断言 —— 纠正记录要引用错误原文。"""
    _fake_design(monkeypatch, "| 2 | §2「**已在用**」 | **错**，实际是另一条曲线 |\n")
    _f, warns = D.check_spec_claims()
    assert warns == [], warns
