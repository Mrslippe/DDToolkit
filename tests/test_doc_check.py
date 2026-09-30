# -*- coding: utf-8 -*-
"""文档漂移门禁自身的用例（`scripts/doc_check.py`，devlog/085）。

为什么给它写用例：门禁的价值全在"**它会不会红**"。

（它的前提是那张索引表），依赖它的 11 个用例一并删除 —— 判据的前提消失就该退役。
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

# 受限沙箱下系统临时目录不可写（同 test_services 首启用例），假仓库建在工作区内。
_TEST_TMP = ROOT / "_test_tmp" / "doc_check"


def test_devlog_numbers_are_read_from_filenames():
    nums = D.devlog_numbers()
    assert len(nums) >= 80, f"只解析出 {len(nums)} 篇 devlog（命名规范变了？）"
    assert nums == sorted(nums), "devlog 编号应当递增有序"
    assert 1 in nums and nums[-1] >= 84
    assert len(nums) == len(set(nums)), "有重复编号"


def _fake_devlog_names(monkeypatch, names: list[str]):
    """造一个假 `devlog/`，文件名随便给（要能构造重号）。"""
    import shutil

    shutil.rmtree(_TEST_TMP, ignore_errors=True)
    dl = _TEST_TMP / "devlog"
    dl.mkdir(parents=True)
    for n in names:
        (dl / n).write_text("x", encoding="utf-8")
    monkeypatch.setattr(D, "DEVLOG", dl)


def test_duplicate_devlog_filenames_are_reported(monkeypatch):
    """同号两个文件 → FAIL（且只报那一组，别的编号不许被牵连）。"""
    _fake_devlog_names(monkeypatch, ["183-a.md", "183-b.md", "184-c.md"])
    fails, warns = D.check_devlog_duplicates()
    assert len(fails) == 1, fails
    assert "183" in fails[0], fails
    assert warns == []


def test_missing_devlog_number_is_not_a_duplicate(monkeypatch):
    """⚠️ **缺号不是重号** —— 本仓 068 / 161 就是缺号，别把 `count < max` 误判成撞号。"""
    _fake_devlog_names(monkeypatch, ["183-a.md", "185-b.md", "186-c.md"])   # 184 缺
    fails, warns = D.check_devlog_duplicates()
    assert fails == [], fails
    assert warns == []


def test_versions_and_notes_are_consistent():
    fails, _warns = D.check_versions()
    assert fails == [], "；".join(fails)
    fails2, _warns2 = D.check_release_notes()
    assert fails2 == [], "；".join(fails2)


def test_full_run_on_current_repo_is_clean():
    """整仓当前状态：不允许有 FAIL（警告可以有 —— 历史遗留项，不逼考古）。"""
    fails, _warns = D.run(quiet=True)
    assert fails == [], "文档漂移：" + "；".join(fails)


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


def test_spec_claim_trigger_is_word_order_proof(monkeypatch):
    """⚠️ **判据不许"枚举措辞"** —— 这是 2026-09-25 两次失败的固化用例。

    历史：初版只认「现状基线 / 已在用」⇒「现状：」整类逃逸；扩到四个词之后
    「（与顶栏同族，现状）」**又**逃逸。⇒ 改成判不变量：**凡提「现状」就要交代**
    （带日期或指向 `UI-MAP`）。这条用例把三种**语序**都钉住：
    """
    for line in (
        "现状是三处零散时长（220 / 180 / rise-in）。\n",
        "| 底 | 浅粉底（与顶栏同族，现状） | 深底 |\n",
        "方案对比：现状：浅粉底；目标：深底。\n",
    ):
        _fake_design(monkeypatch, line)
        _f, warns = D.check_spec_claims()
        assert warns, f"这个语序又溜过去了：{line!r}"


def test_spec_claim_pointing_at_uimap_is_not_warned(monkeypatch):
    """指向 `UI-MAP`（现状的唯一真源）= 合格 —— 不必再抄一遍现状，自然也不会漂。"""
    _fake_design(monkeypatch, "> 现状细节看 `UI-MAP.md` §A1-a-w2。\n")
    _f, warns = D.check_spec_claims()
    assert warns == [], warns


def test_spec_dated_claim_is_not_warned(monkeypatch):
    """带核实日期的算"快照"，是合法的（三分法里的第三类）。"""
    _fake_design(monkeypatch, "> **现状基线（2026-09-17 快照）**：`si-panel-in` 220ms\n")
    _f, warns = D.check_spec_claims()
    assert warns == [], warns


def test_spec_quoted_claim_is_not_warned(monkeypatch):
    """`「…」`/`"…"` 里的算**提及**不算断言 —— 纠正记录要引用错误原文。"""
    _fake_design(monkeypatch,
                 "| 2 | §2「现状是三处零散时长」 | **错**，实际 5 处 |\n")
    _f, warns = D.check_spec_claims()
    assert warns == [], warns
