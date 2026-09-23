"""文档索引漂移门禁：把"我忘了同步文档"变成机器判据。

## 为什么需要它

本仓的文档纪律是"同一批次同步更新"（`docs/README.md` §5），但**索引类**的同步最容易漏：

- `docs/ROADMAP-DONE.md` 的「批次 → devlog 索引」：2026-09-15 实测**缺 082 与 084**
  （两次都是写完 devlog 就忘了回填索引）；
- `docs/README.md` 的 `releases/` 列表：`v1.0.1.md` 加进去后没人更新那一行；
- 六处版本号（`scripts/release.py` 的 VERSION_FILES）随时可能漂。

这些都不会让测试红、不会让程序坏，只会在**几个月后想查"那版改了什么"时**才发现查不到。

## 检查项

| # | 检查 | 判据 |
|---|---|---|
| 1 | devlog 索引覆盖（正向） | **有则必填**：编号 > `LEGACY_UNINDEXED_THROUGH` 的 devlog 必须有索引行（缺 → FAIL）；历史欠账 → WARN（不逼考古） |
| 2 | devlog 索引无重号 | 同一编号在索引表里出现多次 → FAIL |
| 3 | devlog 索引无幽灵行 | 索引行指向不存在的 devlog → WARN |
| 4 | 六处版本号一致 | 复用 `release.py` 的 `version_drift()`（同一份清单，不另写一遍） |
| 5 | 当前版本的发布说明存在 | `docs/releases/v<config.VERSION>.md` |
| 6 | 发布说明都在导航里 | `docs/releases/*.md` 每个文件都要在 `docs/README.md` 出现 |
| 7 | 文档数字与代码一致 | 复用 `gen_doc_numbers.py` 的派生与比对（同一份实现，不另写一遍） |

## 纪律口径（2026-09-23 修订）

本门禁**只管索引闭环，不管你有没有写 devlog** —— 写不写由
`.dsh/skills/ddtoolkit-docs-devlog` 的「**每批次 / 每需求一篇**」纪律决定，
本脚本不对它加任何额外要求。

这里只加一条：**有则必填** —— 一旦写了 devlog，就必须回填索引。

旧判据是「**最近 5 篇**必须有索引行」（按编号的滑动窗口）。它的缺陷是：
① 欠 10 篇时只有最后 5 篇 FAIL、前 5 篇静默降级为 WARN —— **漏报**；
② 窗口随最大编号滑动，不是「无孤儿」这种闭包条件。
现改为按编号水位的「有则必填」。

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
ROADMAP_DONE = ROOT / "docs" / "ROADMAP-DONE.md"
DOCS_README = ROOT / "docs" / "README.md"
RELEASES = ROOT / "docs" / "releases"
INDEX_SECTION = "批次 → devlog 索引"
# 历史欠账水位线（2026-09-23 冻结）：编号 1–61 里散落 41 篇"按批次建索引"时期的产物，
# 不再要求逐篇考古。> 此编号一律"有则必填"。
# 这是一条**冻结的历史事实**，不是可调参数 —— 不要为了让它变绿而调大它。
LEGACY_UNINDEXED_THROUGH = 61

# 索引行**第一列**的长度上限（2026-09-23 定）。
# 2026-09-23 瘦身前这一列漂到过 600–1900 字符的巨型单元格（占 ROADMAP_DONE 全文 60%）；
# 瘦身后中位 35、最长 151。留到 240 是给"一批做多件事"的长标签余量 ——
# 超过它基本就是又开始把细节抄进索引了（细节属于 devlog/ 或 commit message）。
INDEX_LABEL_MAX = 240


def devlog_numbers() -> list[int]:
    return sorted(int(m.group(1)) for p in DEVLOG.glob("*.md")
                  if (m := re.match(r"(\d{3})-", p.name)))


def _index_section() -> list[str]:
    """`## 批次 → devlog 索引` 段的正文行（到下一个 `## ` 为止）。

    ⚠️ **不能**用 `text.find(INDEX_SECTION)` 直接切：那个词在文件开头的导语里也出现过一次
    （第 8 行），`find` 会从那里一路扫到文件尾，把需求清单、能力现状等**别的表**也算进来
    （2026-09-23 实测：`find` 版本覆盖 802 行，正确范围只有 153 行）。
    """
    if not ROADMAP_DONE.exists():
        return []
    lines = ROADMAP_DONE.read_text(encoding="utf-8").splitlines()
    start = next((i for i, l in enumerate(lines)
                  if l.startswith(f"## {INDEX_SECTION}")), None)
    if start is None:
        return []
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")),
               len(lines))
    return lines[start:end]


def index_rows() -> list[int]:
    """索引表里出现过的 devlog 编号，**按出现顺序、保留重复**（表格末列）。

    旧实现返回 set：既丢掉了顺序，也把"同一编号写了两行"这类重号掩盖掉了
    （2026-09-23 实测 162 就是两行）—— 见 check_devlog_index 的第 2 项。
    """
    seg = "\n".join(_index_section())
    return [int(n) for n in re.findall(r"\|\s*(\d{3})\s*\|\s*$", seg, re.M)]


def check_devlog_index() -> tuple[list[str], list[str]]:
    nums = devlog_numbers()
    if not nums:
        return ["devlog/ 里一篇都没有？"], []
    files = set(nums)
    rows = index_rows()
    if not rows:
        return [f"「{INDEX_SECTION}」表里一行编号都没解析到（表格式变了？）"], []

    fails: list[str] = []
    warns: list[str] = []

    # 1. 重号：同一编号写了多行（旧实现用 set 去重，把它掩盖了）
    dupes = sorted((n, c) for n, c in Counter(rows).items() if c > 1)
    if dupes:
        fails.append("索引表里有重复编号："
                     + "、".join(f"{n:03d}（×{c}）" for n, c in dupes)
                     + f" —— 同一编号只应有一行，请合并（{ROADMAP_DONE.relative_to(ROOT)}）")

    indexed = set(rows)

    # 2. 正向孤儿：有 devlog 没回填索引 —— 「有则必填」
    orphan = sorted(n for n in files - indexed if n > LEGACY_UNINDEXED_THROUGH)
    if orphan:
        fails.append("有 devlog 未回填索引（有则必填）："
                     + "、".join(f"{n:03d}" for n in orphan)
                     + f"（在 {ROADMAP_DONE.relative_to(ROOT)} 的「{INDEX_SECTION}」表里补一行）")

    # 3. 历史欠账：不逼考古
    legacy = sorted(n for n in files - indexed if n <= LEGACY_UNINDEXED_THROUGH)
    if legacy:
        # 不逐条列：列 41 个编号只是噪音
        sample = "、".join(f"{n:03d}" for n in legacy[:6])
        warns.append(f"另有 {len(legacy)} 篇 ≤{LEGACY_UNINDEXED_THROUGH:03d} 的历史 devlog 不在索引里"
                     f"（{sample}…）—— 索引按批次建立，非逐篇；不阻塞")

    # 4. 幽灵行：索引指向不存在的 devlog（devlog 删了/合并了，索引行忘了删）
    ghost = sorted(indexed - files)
    if ghost:
        warns.append("索引行指向不存在的 devlog（幽灵行）："
                     + "、".join(f"{n:03d}" for n in ghost)
                     + " —— 该 devlog 已删或已并入他篇，索引行应一并去掉")

    # 5. 第一列过肥：索引行又在抄细节（2026-09-23 瘦身前漂到 600–1900 字符）
    fat: list[tuple[str, int]] = []
    for line in _index_section():
        s = line.strip()
        if not s.startswith("|") or set(s) <= set("|-: "):
            continue                                    # 非表格行 / 分隔行
        # 取第一个单元格：剥掉首尾竖线后按第一个 | 切开。
        # （正文里的转义竖线 `\|` 会把测量截短，但那只会漏报不会误报。）
        first = s.rstrip("|").lstrip("|").split("|", 1)[0].strip()
        if len(first) > INDEX_LABEL_MAX:
            fat.append((first[:32], len(first)))
    if fat:
        fails.append(f"索引行第一列超过 {INDEX_LABEL_MAX} 字符（{len(fat)} 行）："
                     + "；".join(f"「{t}…」{n} 字符" for t, n in fat[:3])
                     + " —— 索引只做索引，细节属于 devlog/ 或 commit message")

    return fails, warns


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


CHECKS = [
    ("devlog 索引覆盖", check_devlog_index),
    ("六处版本号一致", check_versions),
    ("发布说明与导航", check_release_notes),
    ("文档数字与代码一致", check_doc_numbers),
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
