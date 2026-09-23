"""文档数字漂移门禁：把"数字口径"从人肉复核变成机器判据。

## 为什么需要它

本仓的活文档里散着一批**描述当前状态**的数字（迁移 head、表数、路由数、下一篇 devlog 编号）。
它们都能从代码直接算出来，却一直靠人肉手抄 —— 2026-09-23 实测 **23 处声明与代码不符**：

- `MIGRATION_HEAD` 已到 `f007`，9 处仍写 `f006`（含 `ARCHITECTURE` / `GLOSSARY` / `README` / 两个技能）；
- 迁移链版本数已 20，多处仍写 19；
- 路由装饰器已 62，`backend-repositories-and-routers.md` §3 标题写 63、两个技能写 54/58；
- `ddtoolkit-docs-devlog` 技能说"下一篇 devlog 是 098"，实际是 **166**（落后 68 篇）。

这些都不会让测试红、不会让程序坏，只会在**照着文档动手时**才发现口径是错的。

## 检查项

| # | 检查 | 判据 |
|---|---|---|
| 1 | `MIGRATION_HEAD` 与 alembic head 一致 | 直接比 `app/main.py` 的声明与 `alembic/versions/` 的 revision 链（不变量 §6.3） |
| 2 | 活文档里的"当前状态"数字 | 按下方 `CLAIMS` 登记表逐条比对（不一致 → FAIL） |
| 3 | 派生值健全性 | 越界或明显异常 → FAIL（防"派生器自己算错"） |

## 登记表是白名单，不是全文搜索

`f006` 在本仓有 20+ 处提及，其中**大部分是正确的历史引用**（"`profile_cards` 由 f006 引入"）——
改它们反而错。所以本脚本只认 `CLAIMS` 里那几条**明确指当前状态**的写法：

- `MIGRATION_HEAD = fNNN` / `head = fNNN` / `a001 → fNNN`；
- `N 张表`、`N 个路由装饰器`、`N 个版本`（限迁移语境）、`下一篇 … NNN`。

**已知不覆盖**（这类要人肉，别指望本脚本）：迁移链表里"= 当前 head"那格、正文散文里的数字复述、
`ROADMAP-DONE.md` 与 `devlog/` 里的**历史**口径（它们记的是当时的值，本就该与今天不同）、
**路由的另两种口径**（`app.routes` 对象数 / 方法×路径 —— 要实跑 app 才数得准，见 §"为什么不管用例数"）、
以及 `TODO.md` §6.2 那类**基线快照**。

## 为什么不管用例数

`derive_test_counts()` 只数 `def test_` 的**静态条数**，它**不等于实跑 `passed`**：
参数化用例会展开成多条、环境差异会产生 error（本仓在受限沙箱下就有 21 条 `tmp_path` 用例必然 ERROR）。
拿静态条数当判据必然假红，所以它只出现在 `--list` 里供参考，**不进 `CLAIMS`**。
用例数的真源是 `docs/TODO.md` §6.2，现场实跑优先。

用法:

    python scripts/gen_doc_numbers.py            # 打印真值 + 跑检查，有 FAIL 退出 1
    python scripts/gen_doc_numbers.py --list     # 只打印真值（写文档前查这个）
    python scripts/gen_doc_numbers.py --quiet    # 只印失败（供 doc_check.py 调用）
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

MODELS = ROOT / "app" / "models"
ROUTERS = ROOT / "app" / "routers"
ALEMBIC = ROOT / "alembic" / "versions"
DEVLOG = ROOT / "devlog"
TESTS = ROOT / "tests"
FRONTEND_SRC = ROOT / "frontend" / "src"
MAIN_PY = ROOT / "app" / "main.py"
README = ROOT / "README.md"
DOCS = ROOT / "docs"
SKILLS = ROOT / ".dsh" / "skills"

# 扫描范围：活文档（docs 顶层）+ 技能 + 根 README。
# 刻意排除：devlog/ 与 docs/ROADMAP-DONE.md（历史记录，记的是当时的值）、docs/releases/（归档）。
SCAN_EXCLUDE = {"ROADMAP-DONE.md"}


# ── 派生：真值一律从代码算 ────────────────────────────────────────────────

def derive_table_count() -> int:
    names: set[str] = set()
    for p in MODELS.glob("*.py"):
        names |= set(re.findall(r'__tablename__\s*=\s*["\'](\w+)["\']',
                                p.read_text(encoding="utf-8")))
    return len(names)


def derive_migration() -> tuple[str, int]:
    """(head, 版本数) —— head 是链上从不出现在 down_revision 里的那个 revision。"""
    revs: dict[str, str] = {}
    downs: set[str] = set()
    for p in ALEMBIC.glob("*.py"):
        text = p.read_text(encoding="utf-8")
        r = re.search(r'^revision\s*[:=].*?["\'](\w+)["\']', text, re.M)
        d = re.search(r'^down_revision\s*[:=].*?["\'](\w+)["\']', text, re.M)
        if r:
            revs[r.group(1)] = p.name
            if d:
                downs.add(d.group(1))
    heads = sorted(k for k in revs if k not in downs)
    if len(heads) != 1:
        raise RuntimeError(f"alembic 链不唯一，head 候选 {heads}（链断了或分叉了？）")
    return heads[0], len(revs)


def derive_declared_head() -> str | None:
    """`app/main.py` 里手写的 MIGRATION_HEAD（不变量 §6.3 要求它与 alembic head 一致）。"""
    if not MAIN_PY.exists():
        return None
    m = re.search(r'MIGRATION_HEAD\s*[:=].*?["\'](\w+)["\']',
                  MAIN_PY.read_text(encoding="utf-8"))
    return m.group(1) if m else None


def derive_routes() -> int:
    """路由**装饰器**数（`backend-repositories-and-routers.md` §3 的主口径「N」）。

    必须同时数 `@router.get/...` 与 `@router.api_route(...)` —— 后者有 2 条
    （`/vtuber/fetch`、`/vtuber/{id}/fetch`），2026-09-23 实测漏算它会把 64 数成 62。

    另两种口径（`app.routes` 对象数、方法×路径）**不在此派生**：它们要实跑 app 才能数准，
    而本脚本会被 `release.py` 的 preflight 调用，不适合在门禁里导入应用。
    那两种口径按 §3 的口径说明**人肉重新数**。
    """
    n = 0
    for p in ROUTERS.glob("*.py"):
        text = p.read_text(encoding="utf-8")
        n += len(re.findall(r"@router\.(?:get|post|put|patch|delete)\b", text))
        n += len(re.findall(r"@router\.api_route\(", text))
    return n


def derive_devlog() -> tuple[int, int, int]:
    """(篇数, 最大编号, 下一篇编号)。"""
    nums = sorted(int(m.group(1)) for p in DEVLOG.glob("*.md")
                  if (m := re.match(r"(\d{3})-", p.name)))
    if not nums:
        return 0, 0, 1
    return len(nums), nums[-1], nums[-1] + 1


def derive_test_counts() -> tuple[int, int]:
    """(pytest 用例数, vitest 用例数)。"""
    pt = sum(len(re.findall(r"^def test_", p.read_text(encoding="utf-8", errors="replace"), re.M))
             for p in TESTS.glob("*.py"))
    vt = 0
    for p in FRONTEND_SRC.rglob("*.test.ts*"):
        vt += len(re.findall(r"\b(?:it|test)\s*\(",
                             p.read_text(encoding="utf-8", errors="replace")))
    return pt, vt


def derive_all() -> dict[str, object]:
    head, mcount = derive_migration()
    dcount, dmax, dnext = derive_devlog()
    pt, vt = derive_test_counts()
    return {
        "table_count": derive_table_count(),
        "migration_head": head,
        "migration_count": mcount,
        "declared_head": derive_declared_head(),
        "route_decorators": derive_routes(),
        "devlog_count": dcount,
        "devlog_max": dmax,
        "devlog_next": dnext,
        "pytest": pt,
        "vitest": vt,
    }


# ── 声明登记表：只认"明确指当前状态"的写法 ────────────────────────────────

# (度量, 正则, 说明)。正则必须恰有一个捕获组，捕获的就是文档里写的那个值。
CLAIMS: list[tuple[str, str, str]] = [
    ("migration_head", r"MIGRATION_HEAD\s*[:=]\s*[\"'`]?(f\d{3})",
     "`MIGRATION_HEAD = fNNN` 的字面声明"),
    ("migration_head", r"a001`?\s*[→>–-]+\s*`?(f\d{3})",
     "迁移链起止 `a001 → fNNN`"),
    ("migration_head", r"head\s*[:=]\s*[\"'`]?(f\d{3})",
     "`head = fNNN` 的简写声明"),
    ("migration_head", r"`(f\d{3})`(?=(?:(?!`f\d{3}`)[^\n])*当前\s*head)",
     "「`fNNN` = 当前 head」的写法（取该行 `当前 head` 之前**最后**一个编号 —— "
     "迁移表里同一行常同时出现历史编号与当前 head）"),
    ("migration_head", r"当前\s*head\s*[:=]?\s*\*{0,2}`?(f\d{3})",
     "「当前 head `fNNN`」的写法"),
    ("migration_count", r"(?:迁移链|alembic)[^。\n|]{0,40}?(\d+)\s*个?\s*版本",
     "迁移语境下的版本数"),
    ("migration_count", r"(\d+)\s*个?\s*版本[^。\n|]{0,20}?head\s*[:=]",
     "`N 版本，head = …` 的写法"),
    ("migration_count", r"共\s*\*{0,2}(\d+)\*{0,2}\s*个版本",
     "`共 N 个版本`"),
    ("table_count", r"(\d+)\s*张表", "`N 张表`"),
    ("route_decorators", r"(\d+)\s*个路由装饰器", "`N 个路由装饰器`"),
    ("route_decorators", r"装饰器\s*\*{0,2}(\d+)\*{0,2}(?=[\s|（(])", "`装饰器 N` 的语序"),
    ("route_decorators", r"\*\*装饰器\*\*[^|\n]*\|\s*\*{0,2}(\d+)", "口径表里「**装饰器** … | **N**」那一格"),
    ("devlog_next", r"下一篇[^\d\n]{0,12}(\d{3})", "`下一篇 … NNN`"),
]


def scan_targets() -> list[Path]:
    out: list[Path] = []
    out += [p for p in DOCS.glob("*.md") if p.name not in SCAN_EXCLUDE]
    out += list(SKILLS.rglob("*.md"))
    if README.exists():
        out.append(README)
    return sorted({p for p in out if p.exists()})


def check_claims(true: dict[str, object]) -> list[str]:
    fails: list[str] = []
    for p in scan_targets():
        rel = p.relative_to(ROOT)
        for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            for metric, pat, desc in CLAIMS:
                for m in re.finditer(pat, line):
                    got = m.group(1)
                    want = str(true[metric])
                    if got != want:
                        fails.append(f"{rel}:{i} {desc} 写的是 `{got}`，真值 `{want}`")
    return fails


def check_sanity(true: dict[str, object]) -> list[str]:
    """派生器自己算错时的兜底 —— 越界值先红，别把错值写进文档。"""
    fails: list[str] = []
    tc, mc, rd = true["table_count"], true["migration_count"], true["route_decorators"]
    if not 1 <= tc <= 60:
        fails.append(f"派生表数 {tc} 越界（1–60）—— 派生器或 models 布局变了？")
    if not 1 <= mc <= 200:
        fails.append(f"派生迁移版本数 {mc} 越界（1–200）")
    if not 1 <= rd <= 400:
        fails.append(f"派生路由装饰器数 {rd} 越界（1–400）—— 装饰器写法变了？")
    if true["devlog_max"] <= 0:
        fails.append("派生 devlog 最大编号为 0 —— devlog/ 命名规范变了？")
    return fails


def check_declared_head(true: dict[str, object]) -> list[str]:
    """不变量 §6.3：`app/main.py::MIGRATION_HEAD` 必须等于 alembic head。"""
    declared, head = true["declared_head"], true["migration_head"]
    if declared is None:
        return ["读不到 app/main.py 的 MIGRATION_HEAD（改名了？）"]
    if declared != head:
        return [f"app/main.py::MIGRATION_HEAD = `{declared}`，但 alembic head = `{head}`"
                f" —— 不同步会让冷启动快路径把旧库误判为已最新（不变量 §6.3）"]
    return []


# ── 入口 ─────────────────────────────────────────────────────────────────

def run(quiet: bool = False) -> tuple[list[str], list[str]]:
    """返回 (failures, warnings)。只读，不改任何文件。"""
    try:
        true = derive_all()
    except RuntimeError as e:
        return [f"派生失败：{e}"], []

    fails = check_declared_head(true) + check_sanity(true) + check_claims(true)
    warns: list[str] = []

    if not quiet:
        print("[gen] 文档数字真值（从代码派生）")
        for k, v in true.items():
            print(f"         {k:<18} {v}")
        print("  [%s] 数字漂移" % ("FAIL" if fails else "ok"))
        for f in fails:
            print(f"         - {f}")
    return fails, warns


def main() -> int:
    ap = argparse.ArgumentParser(description="文档数字漂移门禁（只读）")
    ap.add_argument("--list", action="store_true", help="只打印派生真值")
    ap.add_argument("--quiet", action="store_true", help="只印失败")
    args = ap.parse_args()

    if args.list:
        for k, v in derive_all().items():
            print(f"{k}\t{v}")
        return 0

    fails, _warns = run(quiet=args.quiet)
    if fails:
        print(f"\n[FAIL] {len(fails)} 处数字与代码不符"
              f"（修法：按 `--list` 的真值改文档；口径说明见本脚本头部）")
        return 1
    print("\n[ok] 文档数字与代码一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
