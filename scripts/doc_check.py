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
| 1 | devlog 索引覆盖 | **最近 5 篇** devlog 必须有索引行（缺 → FAIL）；更早的缺口 → WARN（不逼考古） |
| 2 | 六处版本号一致 | 复用 `release.py` 的 `version_drift()`（同一份清单，不另写一遍） |
| 3 | 当前版本的发布说明存在 | `docs/releases/v<config.VERSION>.md` |
| 4 | 发布说明都在导航里 | `docs/releases/*.md` 每个文件都要在 `docs/README.md` 出现 |

用法:

    python scripts/doc_check.py            # 打印全表，有 FAIL 退出 1
    python scripts/doc_check.py --quiet    # 只印失败/警告（供 dev_check.py --docs 调用）
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

DEVLOG = ROOT / "devlog"
ROADMAP_DONE = ROOT / "docs" / "ROADMAP-DONE.md"
DOCS_README = ROOT / "docs" / "README.md"
RELEASES = ROOT / "docs" / "releases"
INDEX_SECTION = "批次 → devlog 索引"
RECENT_MUST_BE_INDEXED = 5


def devlog_numbers() -> list[int]:
    return sorted(int(m.group(1)) for p in DEVLOG.glob("*.md")
                  if (m := re.match(r"(\d{3})-", p.name)))


def indexed_numbers() -> set[int]:
    """索引表里出现过的 devlog 编号（表格末列）。"""
    if not ROADMAP_DONE.exists():
        return set()
    text = ROADMAP_DONE.read_text(encoding="utf-8")
    start = text.find(INDEX_SECTION)
    seg = text[start:] if start >= 0 else text
    return {int(n) for n in re.findall(r"\|\s*(\d{3})\s*\|\s*$", seg, re.M)}


def check_devlog_index() -> tuple[list[str], list[str]]:
    nums = devlog_numbers()
    if not nums:
        return ["devlog/ 里一篇都没有？"], []
    indexed = indexed_numbers()
    if not indexed:
        return [f"「{INDEX_SECTION}」表里一行编号都没解析到（表格式变了？）"], []
    missing = [n for n in nums if n not in indexed]
    recent = [n for n in missing if n > nums[-1] - RECENT_MUST_BE_INDEXED]
    older = [n for n in missing if n not in recent]
    fails = []
    if recent:
        fails.append("最近 5 篇 devlog 有未回填索引的："
                     + "、".join(f"{n:03d}" for n in recent)
                     + f"（在 {ROADMAP_DONE.relative_to(ROOT)} 的「{INDEX_SECTION}」表里补一行）")
    warns = []
    if older:
        # 不逐条列：索引表历史上是"按批次"建的（早期 devlog 没进），列 43 个编号只是噪音
        sample = "、".join(f"{n:03d}" for n in older[:6])
        warns.append(f"另有 {len(older)} 篇更早的 devlog 不在索引里（{sample}…）—— "
                     f"索引按批次建立，非逐篇；不阻塞")
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


CHECKS = [
    ("devlog 索引覆盖", check_devlog_index),
    ("六处版本号一致", check_versions),
    ("发布说明与导航", check_release_notes),
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
