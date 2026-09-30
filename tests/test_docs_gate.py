# -*- coding: utf-8 -*-
"""文档结构门禁自身的用例（`scripts/docs_gate.py`）。

为什么给它写用例：**门禁的价值全在"它会不会红"**。
本仓为此付过两次学费 ——

1. `tests/test_gate.py` 的 CI 断言第一版在**全文**里找 `uv sync` / `cargo test`，
   而两个 workflow 的注释里恰好都写着它们 ⇒ 把命令删掉、注释留着，断言照样绿；
2. `tests/test_gate.py:45` 引用 `alembic/versions/f007_vtuber_events_kind.py`，
   真实文件叫 `f007_event_kind_emoji.py` —— 因为判档走 `alembic/` 前缀，断言照绿。

⇒ 所以本文件的用例**每条检查都配一个反例**（`_goes_red_*`），而且最后一条断言
「真仓库当前是干净的」—— 它让结构退化在 pytest 里就红。
"""
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import docs_gate as D  # noqa: E402

# 受限沙箱下系统临时目录不可写（同 test_services 首启用例），假仓库建在工作区内。
_TEST_TMP = ROOT / "_test_tmp" / "docs_gate"


@pytest.fixture
def fake_docs(monkeypatch):
    """把 `D.DOCS` 指到一个可控的假 docs 目录（用于检查 3 的指向校验）。"""
    shutil.rmtree(_TEST_TMP, ignore_errors=True)
    ( _TEST_TMP / "backend").mkdir(parents=True)
    (_TEST_TMP / "backend" / "DATA-MODEL.md").write_text("x", encoding="utf-8")
    monkeypatch.setattr(D, "DOCS", _TEST_TMP)
    yield _TEST_TMP
    shutil.rmtree(_TEST_TMP, ignore_errors=True)


GOOD = """---
doc: backend/fetch-pipeline
class: module
scope: 调度与节流
not-scope: 表结构 → backend/DATA-MODEL.md
sot: app/services/scheduler.py
verify: python -m pytest -q tests/test_services.py
budget: 400
retire-when: scheduler.py 被拆分
---
正文
"""


# ── 头块解析 ────────────────────────────────────────────────────────────────
def test_parser_accepts_the_canonical_form():
    fields, errs = D.parse_header(GOOD)
    assert errs == [], errs
    assert fields["class"] == "module"
    assert fields["budget"] == "400"


def test_parser_goes_red_without_a_header():
    """反例：没有头块必须报错 —— 否则整份文档静默逃过全部检查。"""
    _fields, errs = D.parse_header("# 标题\n正文\n")
    assert errs and "缺少头块" in errs[0]


def test_parser_goes_red_on_array_or_nested_value():
    """反例：头块刻意不支持数组/嵌套 —— 值以 `-`/`{`/`[` 开头即报错。"""
    for bad in ("- a", "{a: b}", "[1, 2]"):
        text = f"---\ndoc: x\nclass: nav\nscope: {bad}\n---\n"
        _fields, errs = D.parse_header(text)
        assert any("不得以" in e for e in errs), (bad, errs)


def test_parser_goes_red_on_duplicate_field():
    text = "---\ndoc: x\ndoc: y\nclass: nav\nscope: s\n---\n"
    _fields, errs = D.parse_header(text)
    assert any("重复" in e for e in errs), errs


def test_parser_goes_red_on_unterminated_header():
    _fields, errs = D.parse_header("---\ndoc: x\nclass: nav\nscope: s\n")
    assert any("结束行" in e for e in errs), errs


# ── class / 预算的约定必须自洽（钉住 2026-09-30 定下的数字） ────────────────
def test_class_fields_and_ceilings_are_consistent():
    for cls in D.CLASS_FIELDS:
        assert cls in D.BUDGET_CEILING, f"class `{cls}` 没有行数上限"
    for cls, fields in D.CLASS_FIELDS.items():
        if "budget" in fields:
            assert D.BUDGET_CEILING[cls] > 0


def test_budget_ceilings_match_the_agreed_numbers():
    """钉住上限 —— 改这里必须是有意的，且要一起改 `docs_gate.BUDGET_CEILING`。

    2026-09-30 用户点名的四个：总览 150 / 框架 300 / 术语 300 / TODO 150。
    同日 P1 开工时**重新校准过子目录类的上限**（P0 拍的 module/spec 400、snapshot 400、
    plan 600 比现实紧，实测 6 份文档一搬就超，会逼人拆"本来就只干一件事"的文档）——
    校准记录见 `BUDGET_CEILING` 上方的注释。
    """
    # 根目录与框架类：用户点名，不动
    assert D.BUDGET_CEILING["overview"] == 150
    assert D.BUDGET_CEILING["framework"] == 300
    assert D.BUDGET_CEILING["glossary"] == 300
    assert D.BUDGET_CEILING["nav"] == 60          # README
    assert D.BUDGET_CEILING["tracker"] == 150     # TODO
    # 子目录类：2026-09-30 校准，宽于 P0 的初值
    # ⚠️ `module` 700 → 900 是 P2 拆完 ARCHITECTURE 之后调的：唯一的超标项是
    #    `backend/FETCH-PIPELINE.md` 810 行，而它对应的 `scheduler.py` 是 3524 行
    #    （全仓最大源文件，第二名的 3 倍）。上限的作用是拦失控，不是逼着把内聚的模块
    #    文档劈成两半。**改这个数要连同 `docs_gate.BUDGET_CEILING` 的注释一起改。**
    assert D.BUDGET_CEILING["module"] == 900
    assert D.BUDGET_CEILING["spec"] == 700
    assert D.BUDGET_CEILING["index"] == 1600      # UI-MAP：索引靠 Ctrl+F，砍长度=砍覆盖率
    assert D.BUDGET_CEILING["plan"] == 1000
    assert D.BUDGET_CEILING["snapshot"] == 1000
    for cls in ("module", "spec", "index", "plan", "snapshot"):
        assert D.BUDGET_CEILING[cls] >= D.BUDGET_CEILING["framework"], \
            f"{cls}（只在改那个模块时读）不该比 framework 更严"


# ── 检查 2 的路径规整 ───────────────────────────────────────────────────────
def test_normalize_path_skips_families_and_placeholders():
    """`*` `?` `{}` `<>` 是"一族文件"/占位符，不是可验证的具体路径。"""
    for tok in ("alembic/versions/eNNN_*.py", "app/services/platforms/{a,b}.py",
                "tests/test_migration_safety.py::test_diagnostics_*", "app/<name>.py"):
        assert D._normalize_path(tok) is None, tok


def test_normalize_path_accepts_prefixes_and_root_files():
    assert D._normalize_path("app/main.py") == "app/main.py"
    assert D._normalize_path("frontend/src/styles/tokens.css") == "frontend/src/styles/tokens.css"
    assert D._normalize_path("backend_main.py") == "backend_main.py"
    assert D._normalize_path("docs/UI-MAP.md") is None, "文档路径不归检查 2 管"


def test_normalize_path_skips_doc_paths_under_code_prefixes():
    """检查 2 只管**代码**路径；`frontend/UI-MAP.md` 会撞上 `frontend/` 这个代码前缀。

    2026-09-30 实测：新 README 按目标结构引用 `frontend/UI-MAP.md`（P1 才建），
    不排除 `.md` 就会把一条**文档间指向**误判成"代码路径缺失"。
    """
    assert D._normalize_path("frontend/UI-MAP.md") is None
    assert D._normalize_path("backend/ARCHITECTURE.md") is None
    assert D._normalize_path("frontend/src/api/api.ts") == "frontend/src/api/api.ts"


def test_resolve_handles_this_repos_reference_styles():
    """本仓通行的三种写法都必须能落到文件上（实测占检查 2 假阳性的 25/37）。

    `app/main.py::MIGRATION_HEAD` 是符号、`scripts/x.py:86/87` 是行号列表、
    `app/core/http.py:a/b` 是混合 —— 逐级砍 `:` 之后的部分即可。
    """
    assert D._resolve("app/main.py::MIGRATION_HEAD")
    assert D._resolve("app/main.py")
    assert D._resolve("scripts/docs_gate.py:86/87")
    assert D._resolve("scripts/docs_gate.py")


def test_resolve_goes_red_on_a_genuinely_missing_path():
    """反例：这就是那条真实案例的形状（引用不存在的迁移文件）。"""
    assert not D._resolve("alembic/versions/f007_vtuber_events_kind.py")
    assert not D._resolve("app/services/platforms/definitely_not_here.py")


def test_check_paths_goes_red_on_a_bogus_path():
    bad = "见 `app/services/nope.py::thing` 与 `tests/nope_test.py`。\n"
    fails = D.check_paths(bad)
    assert len(fails) == 2, fails


def test_check_paths_respects_both_escape_markers():
    """两个标记的语义不同：一个是本仓未建，一个是引用别人的仓库。"""
    ok = (f"`scripts/export_archive.py` {D.NOT_BUILT_MARK}\n"
          f"`{chr(46)}github/workflows/release.yml` {D.FOREIGN_MARK}\n")
    assert D.check_paths(ok) == []
    assert D.check_paths("`scripts/export_archive.py`\n") != [], "去掉标记就该红"


def test_check_paths_ignores_gitignored_paths():
    """`scripts/backend-8000.bat` 是有意不入库的个人脚本（§6 第 19 条），引用它合法。"""
    assert D.check_paths("见 `scripts/backend-8000.bat`。\n") == []


# ── 检查 2 的 `docs/**` 引用（2026-09-30 加）────────────────────────────────
def test_normalize_docs_ref_only_takes_complete_paths():
    """只判**像完整文件路径**的 `docs/**` 引用。

    这样能自动放过两类**不是路径**的写法：带占位符的模板（`docs/releases/v<版本>.md`）、
    以及部分路径（`docs/releases/v`）—— 否则它们会变成噪声，而噪声会让检查被无视。
    """
    assert D._normalize_docs_ref("docs/frontend/UI-MAP.md") == "docs/frontend/UI-MAP.md"
    assert D._normalize_docs_ref("docs/DEV-LOOP.md") == "docs/DEV-LOOP.md"
    for tok in ("docs/releases/v<版本>.md", "docs/releases/v", "docs/design/react-IconRail",
                "app/main.py"):
        assert D._normalize_docs_ref(tok) is None, tok


def test_check_paths_goes_red_on_a_dangling_docs_ref_when_live():
    """反例：活文档引用一份**不存在**的文档必须红。

    起因是真事：文档重构把 `docs/UI-MAP.md` 搬成 `docs/frontend/UI-MAP.md`，
    而引用它的 9 处活文档与代码注释**不会自己红** —— 检查 2 原先只看代码前缀。
    """
    bad = "见 `docs/frontend/UI-MAP.md` 与 `docs/NO-SUCH-DOC.md`。\n"
    assert len(D.check_paths(bad, live=True)) == 1


def test_check_paths_leaves_docs_refs_alone_when_not_live():
    """点时刻文档（plan / snapshot / spec）**不校验** `docs/**` 引用 —— 它记的是当时的事。"""
    bad = "见 `docs/NO-SUCH-DOC.md`。\n"
    assert D.check_paths(bad, live=True) != []
    assert D.check_paths(bad, live=False) == []


def test_code_paths_still_go_through_the_symbol_fallback():
    """**回归**：给检查 2 加 `docs/**` 那条路时，别把代码路径的 `::符号` 回退弄丢。

    2026-09-30 实测踩到：新分支一开始直接 `(ROOT / tok).exists()`，于是
    `app/main.py::_run_migrations(` 这类本仓通行写法集体报红（几十条）。
    """
    ok = "见 `app/main.py::MIGRATION_HEAD` 与 `scripts/docs_gate.py:86/87`。\n"
    assert D.check_paths(ok, live=True) == [], D.check_paths(ok, live=True)


# ── 检查 1 / 3 / 4 的按文档校验 ─────────────────────────────────────────────
def test_check_document_passes_on_a_conforming_doc(fake_docs):
    fails, _warns, fields = D.check_document("docs/backend/fetch-pipeline.md", GOOD, 9)
    assert fails == [], fails
    assert fields["class"] == "module"


def test_check_document_goes_red_on_missing_required_field(fake_docs):
    """反例：`module` 缺 `verify` 与 `retire-when`。"""
    text = GOOD.replace("verify: python -m pytest -q tests/test_services.py\n", "") \
               .replace("retire-when: scheduler.py 被拆分\n", "")
    fails, _w, _f = D.check_document("docs/x.md", text, 9)
    assert any("缺必填字段" in f for f in fails), fails


def test_check_document_goes_red_on_illegal_class(fake_docs):
    fails, _w, _f = D.check_document("docs/x.md", GOOD.replace("class: module", "class: 模块"), 9)
    assert any("非法" in f for f in fails), fails


def test_check_document_goes_red_on_oversize_budget(fake_docs):
    """反例：超预算必须红，且**不许靠抬 budget 绕过**（见下一条）。"""
    fails, _w, _f = D.check_document("docs/x.md", GOOD, 401)
    assert any("超预算" in f for f in fails), fails


def test_check_document_goes_red_when_budget_exceeds_class_ceiling(fake_docs):
    """反例：budget 是自我豁免的开关 —— 上限必须由 class 兜住。"""
    fails, _w, _f = D.check_document("docs/x.md", GOOD.replace("budget: 400", "budget: 9999"), 9)
    assert any("超过 class" in f for f in fails), fails


def test_check_document_falls_back_to_the_class_ceiling(fake_docs):
    """**没声明 `budget` 也要按 class 上限查** —— 否则上限就是装饰性的。

    2026-09-30（P2 出对照表时发现）：初版只在声明了 `budget` 时才查，而
    `spec` / `plan` / `snapshot` 三类并不强制声明 ⇒ 那 15 份文档的 class 上限
    **一次都没被查过**，`--list` 里显示「无预算」。这正是本仓最反对的
    「红不了的断言等于没有」。
    """
    # `spec` 不要求 budget：去掉声明后，仍应按 spec 的上限判
    spec = ("---\ndoc: frontend/specs/x\nclass: spec\nscope: s\n"
            "not-scope: t\nsot: app/main.py\nverify: x\nretire-when: y\n---\n")
    ceiling = D.BUDGET_CEILING["spec"]
    assert D.check_document("docs/x.md", spec, ceiling)[0] == [], "刚好到上限不该红"
    fails, _w, _f = D.check_document("docs/x.md", spec, ceiling + 1)
    assert any("超预算" in f for f in fails), fails
    assert any("上限" in f for f in fails), "报错里要说清是按 class 上限判的"


def test_check_document_goes_red_on_dangling_not_scope_target(fake_docs):
    """反例：`not-scope` 指向一份不存在的文档 —— 那是把读者引到空气里。"""
    text = GOOD.replace("→ backend/DATA-MODEL.md", "→ backend/NOT-THERE.md")
    fails, _w, _f = D.check_document("docs/x.md", text, 9)
    assert any("not-scope" in f for f in fails), fails


def test_not_scope_targets_parses_multiple_pointers():
    got = D._not_scope_targets("平台字段 → backend/PLATFORMS.md；表结构 → backend/DATA-MODEL.md")
    assert got == ["backend/PLATFORMS.md", "backend/DATA-MODEL.md"], got


# ── 检查 5：豁免清单只能单调缩小 ────────────────────────────────────────────
def test_grandfathered_entries_are_all_real_docs():
    """清单不许腐烂：P1 搬家后旧路径必须从清单里删掉。"""
    missing = sorted(p for p in D.GRANDFATHERED if not (ROOT / p).exists())
    assert missing == [], f"GRANDFATHERED 里有已不存在的路径：{missing}"


def test_grandfathered_docs_have_no_header_yet():
    """豁免与头块互斥 —— 两者同时成立就该红（检查 5 的静态版本）。"""
    clash = []
    for rel in sorted(D.GRANDFATHERED):
        p = ROOT / rel
        if not p.exists():
            continue
        fields, _errs = D.parse_header(p.read_text(encoding="utf-8", errors="replace"))
        if fields.get("class"):
            clash.append(rel)
    assert clash == [], f"这些文档已带头块，请从 GRANDFATHERED 删除：{clash}"


# ── 整体：门禁在真仓库上必须绿，且扫描面不能是空的 ──────────────────────────
def test_scan_set_is_not_empty():
    """扫描面空了会让门禁**静默全绿** —— 本仓为这类假绿踩过三次坑。"""
    files = D.doc_files()
    assert len(files) >= 20, f"只扫到 {len(files)} 份文档（扫描面变了？）"


def test_release_notes_and_reference_are_excluded():
    rel = {p.relative_to(D.DOCS).parts[0] for p in D.doc_files()}
    assert "releases" not in rel and "reference" not in rel


def test_the_real_repo_is_clean():
    """最实用的一条：结构退化要在 pytest 里红，而不是等几个月后有人来查。"""
    fails, _warns = D.run(quiet=True)
    assert fails == [], "文档结构门禁报红：\n" + "\n".join(fails)
