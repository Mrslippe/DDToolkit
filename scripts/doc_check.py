"""文档漂移门禁：把"我忘了同步文档"变成机器判据。

## 为什么需要它

本仓的文档纪律是"同一批次同步更新"，但**索引类**的同步最容易漏：`docs/README.md` 的
`releases/` 列表（`v1.0.1.md` 加进去后没人更新那一行）、六处版本号
（`scripts/release.py` 的 `VERSION_FILES`）随时可能漂。这些都不会让测试红、不会让程序坏，
只会在**几个月后想查"那版改了什么"时**才发现查不到。

## 检查项

> ⚠️ **2026-09-30 退役了一条**：「devlog 索引覆盖」—— 它读的是 `docs/ROADMAP-DONE.md`
> 的「批次 → devlog 索引」表，而那次文档重构把索引表整体删掉了（历史交给 `devlog/` 与 git）。
> 按本仓自己的纪律，**判据的前提消失就该退役**，而不是把它改绿。
> 它守的纪律有替代：devlog 的登记面就是**文件名本身**（编号递增），由下面的
> 「devlog 文件名重号」+ `gen_doc_numbers.py --list` 的 count/max/next 承担。

⚠️ **本表与下面的 `CHECKS` 列表一一对应**（同样 6 项、同样顺序）。
2026-09-25 前两者不一致（表里 9 行、`CHECKS` 6 项），结果 **skill 照抄了这张错表**，
读者按它数条目永远是错的。⇒ 加检查项时**两处一起改**。

| # | 检查（= `CHECKS` 顺序） | 判据 |
|---|---|---|
| 1 | devlog 文件名重号 | 同一编号有 ≥2 个**文件** → FAIL（`gen_doc_numbers.derive_devlog()` 只排序不去重，撞号不会自己响） |
| 2 | 六处版本号一致 | 复用 `release.py` 的 `version_drift()`（同一份清单，不另写一遍） |
| 3 | 发布说明与导航 | `docs/releases/v<config.VERSION>.md` 存在 ＋ 每个 `docs/releases/*.md` 都出现在 `docs/README.md` |
| 4 | 文档数字与代码一致 | 复用 `gen_doc_numbers.py` 的派生与比对（同一份实现，不另写一遍） |
| 5 | TODO 无已落地残留 | `TODO.md` §1「未完成项」的**性质列**（第 2 列）不应说"已落地"（已完成的条目不该堆在待办里） |
| 6 | 规格现状断言 | `docs/frontend/specs/*.md` 与 `docs/design-*.md` 里凡提到「现状」，**要么带核实日期、要么指向 `UI-MAP`**（二者必居其一）。⚠️ 别改回"枚举断言词"：2026-09-25 实测枚举两轮都漏 —— **别追措辞，判不变量** |

## 纪律口径

本门禁**只管索引闭环，不管你有没有写 devlog** —— 写不写、写多长，口径只有一处真源：
`docs/DEV-LOOP.md` §0.1「每批的预算」。本脚本不对它加任何额外要求，**也不复述那个口径**。

用法:

    python scripts/doc_check.py            # 打印全表，有 FAIL 退出 1
    python scripts/doc_check.py --quiet    # 只印失败/警告（供 dev_check.py --docs 调用）
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

DEVLOG = ROOT / "devlog"
DOCS = ROOT / "docs"

DOCS_README = DOCS / "README.md"
RELEASES = DOCS / "releases"
TODO = DOCS / "TODO.md"




def devlog_numbers() -> list[int]:
    return sorted(int(m.group(1)) for p in DEVLOG.glob("*.md")
                  if (m := re.match(r"(\d{3})-", p.name)))




def check_devlog_duplicates() -> tuple[list[str], list[str]]:
    """devlog **文件名**层面的重号 —— 这是原先唯一的"靠人肉自查"的漂移点。

    为什么必须机器判：`gen_doc_numbers.derive_devlog()` 用的是 `nums[-1] + 1`
    （**只排序、不去重、也不查重复**）⇒ 同时存在 `183-…A.md` 与 `183-…B.md` 时，
    它照常报 `count / max / next`，**看不出任何异常**；`doc_check` 的索引检查
    也只看索引表里的编号，不看文件名。
    ⇒ 于是"撞号不会自己变红"，只能靠人在写完 devlog 后手跑一条 PowerShell —— 
    而**写给人做的检查 = 不会做的检查**（2026-09-25 实测：这条在 skill 里挂了很久，
    期间真的出现过重号，是事后才发现并删掉一行的）。

    ⚠️ `devlog_count < devlog_max` **不等于**重号（本仓有缺号），
    所以判据只认"同一编号出现 ≥2 个**文件**"，不碰缺号。
    """
    nums: dict[str, list[str]] = {}
    for p in sorted(DEVLOG.glob("*.md")):
        head = p.name[:3]
        if head.isdigit():
            nums.setdefault(head, []).append(p.name)
    dup = {k: v for k, v in nums.items() if len(v) > 1}
    if not dup:
        return [], []
    return [
        f"devlog 文件名重号：{k} 有 {len(v)} 个文件 —— "
        + "；".join(v)
        + "（索引只会认一个编号 ⇒ 另一篇等于没入账）"
        for k, v in sorted(dup.items())
    ], []


def check_versions() -> tuple[list[str], list[str]]:
    import release as R

    drift = R.version_drift()
    if drift:
        detail = "、".join(f"{k}={v}" for k, v in drift.items())
        return [f"六处版本号不一致（{detail}）—— 跑 python scripts/release.py --check-version"], []
    return [], []


def check_release_notes() -> tuple[list[str], list[str]]:
    import release as R

    version = R.current_version()
    if not version:
        return ["读不到 app/core/config.py 的 VERSION"], []
    fails, warns = [], []
    notes = RELEASES / f"v{version}.md"
    if not notes.exists():
        fails.append(f"当前版本 {version} 没有发布说明 {notes.relative_to(ROOT)}"
                     f"（Release 描述取自它）")
    if not RELEASES.exists():
        return fails or ["docs/releases/ 目录不存在"], warns
    listed = DOCS_README.read_text(encoding="utf-8") if DOCS_README.exists() else ""
    for f in sorted(RELEASES.glob("*.md")):
        if f.name not in listed:
            fails.append(f"{f.name} 没出现在 docs/README.md 的 releases/ 列表里")
    return fails, warns


def check_doc_numbers() -> tuple[list[str], list[str]]:
    """活文档里的"当前状态"数字是否与代码一致（派生实现在 `gen_doc_numbers.py`）。

    2026-09-23 接入时实测抓到 36 处漂移（`MIGRATION_HEAD` 已到 f007 却 9 处写 f006、
    路由装饰器 63 vs 64、技能说下一篇 devlog 是 098 而实际 166 …）。
    """
    import gen_doc_numbers as G

    return G.run(quiet=True)


def check_todo_not_stale() -> tuple[list[str], list[str]]:
    """`TODO.md` §1「未完成项」里**不应有"已落地"条目** —— 完成了就不该还堆在待办里。

    为什么需要它（2026-09-24 实测）：技能里的「已落地 → **移出**待办」只有人知道，
    于是 §1.1「可以立刻动手」堆了 **12 条**带 ✅ 的旧条目（18 条里 12 条已完成）——
    那个清单名义上"能立刻动手"，实际只有 5 条能动手。**"没有门禁的纪律会漂"的又一例。**

    注：§0「待提需求收集区」**允许**写 `✅ 已落地（devlog/0NN）→ 详见 …` —— 那是规定的指针形式，
    所以本检查只看 §1。判据取**性质列（第 2 列）**，不是整行 —— 一个需求可能"5 批只落了 1 批"
    （R38 就是这样），那种行里出现"已落地"是**对的**，不该判红。
    """
    if not TODO.exists():
        return ["docs/TODO.md 不见了？"], []
    lines = TODO.read_text(encoding="utf-8").splitlines()
    start = next((i for i, l in enumerate(lines) if l.startswith("## 1. ")), None)
    if start is None:
        return ["docs/TODO.md 找不到 §1「未完成项」（标题变了？）"], []
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))

    stale: list[str] = []
    for i in range(start, end):
        t = lines[i].strip()
        # 表格数据行 = 以 | 开头结尾，且有"表格语法之外"的内容（排除 |---|---| 分隔行）
        if not (t.startswith("|") and t.endswith("|")) or not set(t) - set("|-: "):
            continue
        cells = t.strip("|").split("|")
        if len(cells) < 2:
            continue
        if "已落地" in cells[1]:                     # 只看「性质」列
            name = cells[0].strip().strip("*~").strip()
            stale.append(f"L{i + 1}「{name[:38]}」")
    if stale:
        return [f"docs/TODO.md §1「未完成项」里有 {len(stale)} 条已落地条目"
                "（完成了就该从待办里移走）：" + "、".join(stale[:4])
                + ("…" if len(stale) > 4 else "")], []
    return [], []


# 规格里描述"现状"的断言词 —— **两个高召回词 + 一个明确的豁免出口**。
#
# ⚠️ 这里改过三轮，前两轮都是错的，值得记下来：
#   ① 初版 `("现状基线", "已在用")` —— 「现状：」「现状是…」**整类逃逸**（审计实测 4 处，
#      其中一处已被证伪）；
#   ② 改成 `("现状：", "现状是", "现状基线", "已在用")` —— 第 101 行
#      「（与顶栏同族，现状）」**又**逃逸；
#   ③ 收成**单词**「现状」 —— 语序问题解决了（触发词不再依赖语序），
#      但**测试立刻抓到它丢了原有的动机用例**：`--ease-standard` 那条断言写的是
#      「**已在用**」，不含"现状"二字 ⇒ 不再报警。**这就是留下那条用例的价值。**
#   ⇒ 最终：`("现状", "已在用")` 两个词负责"召回"，**豁免出口只认两种**
#      （带核实日期 / 指向 `UI-MAP`）—— 出口少而明确，才不用去追语序。
#      **教训：判据要判不变量（"说了现状就得交代来源"），但"什么算说了现状"这一层
#      永远需要一份词表；词表要短、要高召回，靠豁免出口而非穷举来收敛。**
SPEC_CLAIM_WORDS = ("现状", "已在用")
SPEC_CLAIM_OK = "UI-MAP"      # 指向真源 = 合格（不必再抄一遍现状）


def check_spec_claims() -> tuple[list[str], list[str]]:
    """设计规格里的"现状"断言必须带**核实日期**，或指向 `UI-MAP` —— 二者必居其一。

    为什么需要它（2026-09-24 实测）：`design-status-island.md` 声称 `--ease-standard`
    「**已在用**（`.si-panel` 入场曲线）」，而实际那条曲线是 `cubic-bezier(.22,.61,.36,1)` ——
    **全站唯一的异类**。这条断言**从未被验证过**（不是漂移，是一开始就错），挂了一整周，
    直到 R38 批 1 实跑才发现。同一份文档的「现状是三处零散时长」也是同类：
    实际 5 处，且它自己在 §12 里记着这条更正 —— **规格正文留着假事实，更正写在第 300 行**。

    规格与实现之间**没有**一致性门禁（做不到：那要求逐句判真值），但"**断言必须可追溯**"
    是可门禁的 —— 带日期读者就知道它是一份快照、该复核；指向 `UI-MAP` 则根本不抄现状。
    """
    warns: list[str] = []
    for p in sorted(DOCS.glob("design-*.md")):
        for i, l in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            bare = re.sub(r"「[^」]*」", "", l)      # 「…」里算**提及**（引用错误原文不算断言）
            bare = re.sub(r'"[^"]*"', "", bare)
            if not any(w in bare for w in SPEC_CLAIM_WORDS):
                continue
            if re.search(r"20\d{2}-\d{2}-\d{2}", l) or SPEC_CLAIM_OK in l:
                continue
            warns.append(f"{p.relative_to(ROOT)}:{i} 提到「现状」但既没核实日期、"
                         f"也没指向 `UI-MAP` —— 二者必居其一（现状的真源只有 UI-MAP）")
    return [], warns


CHECKS = [
    ("devlog 文件名重号", check_devlog_duplicates),
    ("六处版本号一致", check_versions),
    ("发布说明与导航", check_release_notes),
    ("文档数字与代码一致", check_doc_numbers),
    ("TODO 无已落地残留", check_todo_not_stale),
    ("规格现状断言可追溯", check_spec_claims),
]


def run(quiet: bool = False) -> tuple[list[str], list[str]]:
    """跑全部检查，返回 (failures, warnings)。只读，不改任何文件。"""
    fails: list[str] = []
    warns: list[str] = []
    for name, fn in CHECKS:
        f, w = fn()
        fails += f
        warns += w
        if not quiet:
            flag = "FAIL" if f else ("WARN" if w else "ok")
            print(f"  [{flag}] {name}")
            for line in f:
                print(f"         - {line}")
            for line in w:
                print(f"         ~ {line}")
    return fails, warns


def main() -> int:
    ap = argparse.ArgumentParser(description="文档索引漂移门禁（只读）")
    ap.add_argument("--quiet", action="store_true", help="只印失败与警告")
    args = ap.parse_args()
    print("[doc] 文档索引检查")
    fails, warns = run(quiet=args.quiet)
    if not fails and not warns:
        print("  [ok] 全部一致（devlog 索引 / 版本号 / 发布说明）")
    if fails:
        print(f"\n[FAIL] {len(fails)} 项需要处理")
        return 1
    print(f"\n[ok] 无 FAIL" + (f"（{len(warns)} 条警告）" if warns else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
