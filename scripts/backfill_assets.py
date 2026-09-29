# -*- coding: utf-8 -*-
"""一次性登记：把盘上**已有**的头像文件收进轻资产索引（L1，devlog/257）。

## 为什么需要它

L1 之前抓下来的头像落在 `static/avatars/`，轻资产索引 `local_assets` 是空的
⇒ 这些文件既不受 `prune` 保护，也享受不到"稳定键命中 ⇒ 不发请求"。
本脚本按**库里已有的路径**把它们登记进来（`assets.remember`）。

## 三条硬纪律（方案 §4）

- **只登记，不动文件**：不下载、不复制、不搬迁、不改名、不删除 ——
  `static/avatars/` 里的历史文件**留在原地**（S-1：用户磁盘上的文件只许增）；
- **只认盘上真有的**：路径不存在就跳过（先文件后索引，不留指向虚空的索引行）；
- **当前选中的那张顺手 pin**（`vtubers.avatar` 命中的那个稳定键）——
  用户的显式选择不该被清理掉（`assets._referenced_keys` 是第二道保护）。

## 幂等

按 `(kind, 稳定键)` upsert（`assets.remember`）⇒ 可重复执行；
重跑只会把 `url` 跟到最新、`last_used_at` 前移。

## 用法

    python scripts/backfill_assets.py --dry-run     # 只报告要登记什么（默认也是 dry-run）
    python scripts/backfill_assets.py --apply       # 真写库（先备份数据目录！）
    python scripts/backfill_assets.py --kind avatar --apply

⚠️ 动真机数据目录前先备份（`app/services/db_maintenance.py::backup_database` 或手工复制）。
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core.database import SessionLocal
from app.models.vtuber import Account, VTuber, VtuberAvatarHistory
from app.services import assets


def _collect(db, kind: str) -> dict[str, tuple[str, str]]:
    """`{稳定键: (url, 相对路径)}` —— 从库里已有的 (url, path) 组合出发。

    两个来源：历次头像账本（R47 起最全）+ 账号现值（升级前就有的那些）。
    同一个稳定键出现多次时**先到的赢**（和 `remember` 的口径一致：不改已登记的路径）。
    """
    found: dict[str, tuple[str, str]] = {}
    if kind != assets.KIND_AVATAR:
        return found
    sources = [
        db.query(VtuberAvatarHistory.avatar_url, VtuberAvatarHistory.avatar_path).all(),
        db.query(Account.avatar_url, Account.avatar_path).all(),
    ]
    for rows in sources:
        for url, path in rows:
            u = (url or "").strip()
            p = (path or "").strip().replace("\\", "/")
            if not u or not p:
                continue
            key = assets.key_of(u)
            if key and key not in found:
                found[key] = (u, p)
    return found


def _selected_keys(db) -> set[str]:
    """用户显式选中过的那些稳定键（`vtubers.avatar`）⇒ 登记时顺手 pin。"""
    keys = set()
    for (url,) in db.query(VTuber.avatar).filter(VTuber.avatar.isnot(None)).all():
        key = assets.key_of((url or "").strip())
        if key:
            keys.add(key)
    return keys


def main() -> int:
    parser = argparse.ArgumentParser(description="把盘上已有的头像文件登记进 local_assets")
    parser.add_argument("--apply", action="store_true", help="真写库（默认只 dry-run）")
    parser.add_argument("--kind", default=assets.KIND_AVATAR, choices=list(assets.KINDS))
    args = parser.parse_args()

    db = SessionLocal()
    try:
        candidates = _collect(db, args.kind)
        selected = _selected_keys(db) if args.kind == assets.KIND_AVATAR else set()
        print(f"候选 {len(candidates)} 条（kind={args.kind}，其中 pin {len(selected & set(candidates))} 条）")
        added = merged = missing = 0
        for key, (url, rel) in sorted(candidates.items()):
            on_disk = assets.abs_path(rel).exists()
            pin = key in selected
            if not on_disk:
                missing += 1
                print(f"  [跳过·盘上没有] {rel}")
                continue
            before = assets.lookup(db, args.kind, url)
            if not args.apply:
                print(f"  [dry-run] {'已登记' if before else '将登记'} pin={pin} {rel}")
                continue
            row = assets.remember(db, args.kind, url, rel, pinned=pin)
            if row is None:
                missing += 1
                print(f"  [跳过·登记失败] {rel}")
            elif before is None:
                added += 1
                print(f"  [新增] pin={pin} {rel}")
            else:
                merged += 1
                print(f"  [已有·只更新 url/时间] pin={row.pinned} {rel}")
        if args.apply:
            db.commit()
            print(f"完成：新增 {added}、更新 {merged}、跳过 {missing}")
            print("（没有文件被复制/搬迁/删除 —— 登记只写索引行）")
        else:
            print(f"dry-run 结束：盘上缺 {missing} 条；加 --apply 才写库")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
