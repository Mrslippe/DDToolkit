# -*- coding: utf-8 -*-
"""仓库层的提交约定（R3，批次 7）：**级联清理不许自己 commit**。

为什么这条值得一条判据（而不是一条纪律）：`purge.py` 的原子性完全建立在
"**它自己一个 `commit()` 都没有**、由调用方一个事务收口"之上。
给它中间任何一步加一次 `commit()`，删账号 / 删 V 在中途失败时就会留下"删了一半"
的库 —— 而**它不会红**，除非有这条判据。

反向验证（实测）：往 `purge_account` 中间注入一次 `db.commit()` ⇒
`tests/test_transaction_boundaries.py` 的 ① 两条立刻变红（那一批就是本判据的行为版）。

⚠️ 判据一律走 **AST**，不做文本搜索：`purge.py` 的文档串里就写着"**不提交**：由调用方
在同一事务里 commit"，文本搜索会命中那句话（本仓"判据的举例命中判据自己"第 6 次的形态）。
"""
from __future__ import annotations

import ast
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PURGE = REPO / "app" / "services" / "purge.py"
VREPO = REPO / "app" / "repositories" / "vtuber_repo.py"


def _commit_calls(node: ast.AST) -> list[int]:
    """子树里所有 `.commit()` 调用的行号。"""
    out = []
    for sub in ast.walk(node):
        if (isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute)
                and sub.func.attr == "commit"):
            out.append(sub.lineno)
    return out


def _methods(path: Path) -> dict[tuple[str, str], ast.FunctionDef]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: dict[tuple[str, str], ast.FunctionDef] = {}
    for cls in [n for n in tree.body if isinstance(n, ast.ClassDef)]:
        for fn in cls.body:
            if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                out[(cls.name, fn.name)] = fn          # type: ignore[assignment]
    return out


def test_cascade_cleanup_helpers_never_commit():
    """`delete_by_*` 与 `AccountStatSnapshotRepo.add`：只 flush/删除，绝不 commit。

    这三类方法是 purge 与"快照随业务写入同事务"的地基（见
    `docs/backend-repositories-and-routers.md` §2 开头的例外表）。
    """
    offenders = []
    for (cls, name), fn in _methods(VREPO).items():
        if name.startswith("delete_by_") or (cls == "AccountStatSnapshotRepo" and name == "add"):
            lines = _commit_calls(fn)
            if lines:
                offenders.append(f"{cls}.{name}（第 {lines} 行）")
    assert not offenders, (
        "级联清理方法自己 commit 了 —— purge 会变成「删一半就落盘」：" + "、".join(offenders)
    )


def test_purge_module_has_no_commit_at_all():
    """`purge.py` 里**一个 commit 都不许有**（原子性靠调用方那一个事务）。"""
    tree = ast.parse(PURGE.read_text(encoding="utf-8"))
    lines = _commit_calls(tree)
    assert not lines, f"app/services/purge.py 第 {lines} 行出现了 commit()"


def test_layout_replace_is_a_self_contained_transaction():
    """`replace_all` 是"删旧 + 插新"，必须自成事务：**commit 与 rollback 成对**。"""
    fn = _methods(VREPO)[("ProfileCardRepo", "replace_all")]
    src = ast.unparse(fn)
    assert "self.db.commit()" in src, "整版替换没提交 ⇒ 用户保存的布局不会落盘"
    assert "self.db.rollback()" in src, "整版替换失败后没回滚 ⇒ 旧布局被删掉且留不下新的"


def test_the_five_flows_have_failure_path_judgments():
    """五个多表流程的失败路径都要有用例（本批补的就是这五条，防"以后被删掉"）。

    这不是形式检查：`test_transaction_boundaries.py` 里那条 T0 用例是本批修掉真实缺陷
    （两笔 commit ⇒ 直播边沿被永久吞掉）的判据，删掉它这个缺陷就能悄悄回来。
    """
    src = (REPO / "tests" / "test_transaction_boundaries.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    names = {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    for expect in (
        "test_delete_account_rolls_back_when_purge_fails_midway",       # (a)
        "test_delete_vtuber_rolls_back_when_purge_fails_midway",        # (b)
        "test_live_status_rolls_back_when_snapshot_write_fails",        # (c)
        "test_failed_layout_save_keeps_the_old_layout",                 # (d)
        "test_adopt_conflict_leaves_no_orphan_vtuber",                  # (e)
        "test_session_still_usable_after_a_lock_conflict",              # 锁冲突
    ):
        assert expect in names, f"失败路径判据被删了：{expect}"
