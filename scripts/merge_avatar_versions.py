# -*- coding: utf-8 -*-
"""一次性整理：把账本里**同一张头像的多行**并成一行（L4，devlog/262）。

## 起因（真实形态）

R47 的账本按**完整 URL** 记账，而微博每轮抓取都换签名 ⇒ 同一张脸会各留一行；
R47 之前本地文件名还是**固定**的，同一张图会先落 `{platform}_{uid}.jpg`、之后又落
`{platform}_{uid}_{摘要}.jpg` ⇒ **两个文件名、同一张脸**（实测：两个文件 sha256 逐字节相同，
样本在 `tests/fixtures/light_assets.json`）。选择器里因此会出现两张一模一样的选项。

## 三条纪律

- **只并"行"，绝不删文件**（方案 §4 S-1）：被合并掉的路径指向的图仍然是同一张，
  文件留在盘上；要回收空间走设置页的「清理未使用的轻资产」（那边有引用保护）；
- **用户选中的那行必须活下来**（否则"当前用的是哪张"这个标记会丢）；
- **默认 dry-run**：先看要并哪些，加 `--apply` 才真写。

## 幂等

并完之后同一张图只剩一行 ⇒ 再跑一次 `groups=0`。

## 用法

    python scripts/merge_avatar_versions.py                # 只报告（默认）
    python scripts/merge_avatar_versions.py --apply        # 真写库（**先备份数据目录！**）
    python scripts/merge_avatar_versions.py --vtuber 15 --apply
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core.database import SessionLocal
from app.services import vtuber_avatars as VA


def main() -> int:
    parser = argparse.ArgumentParser(description="把账本里同一张头像的多行并成一行")
    parser.add_argument("--apply", action="store_true", help="真写库（默认只 dry-run）")
    parser.add_argument("--vtuber", type=int, default=None, help="只处理这个 V")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        report = VA.merge_duplicate_versions(db, vtuber_id=args.vtuber, dry_run=not args.apply)
        print(f"扫描 {report['vtubers']} 个 V：发现 {report['groups']} 组重复"
              f"（共 {report['merged']} 行可并）")
        for k in report["kept"]:
            print(f"  [保留] V#{k['vtuber_id']} {k['path']} ← 并掉 {k['rows'] - 1} 行")
        for d in report["dropped"][:40]:
            print(f"  [并入] V#{d['vtuber_id']} row#{d['id']} {d['path']}")
        if args.apply:
            db.commit()
            print(f"完成：并掉 {report['merged']} 行（**没有删除任何文件**）")
        else:
            print("dry-run 结束；加 --apply 才写库（写前请先备份数据目录）")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
