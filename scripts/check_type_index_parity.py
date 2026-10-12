# -*- coding: utf-8 -*-
"""核对：**按类型聚合（直查索引）与合并视图逐类等数**（f017 的核心判据，只读真库副本）。

## 它回答的问题

类型落库两批（`devlog/467` f016、`devlog/471` f017）之后，"按类型查询/统计"改成直查
`(account_id, category)` 索引。**能不能成立，取决于一条数据不变量**：

    只有"代表行"带 `session_key` 与 `category`，同组其余行两列都是 NULL
    ⇒ `GROUP BY category WHERE session_key IS NOT NULL` = **每场一次**

这条一旦破（物化没跑到、或增量同步留下了旧代表），卡片上的数字就与日历对不上，
而**两个界面都不会报错** —— 用户只会觉得"这工具的数怎么两处不一样"。

## 三个数字各自是什么

| 列 | 口径 |
|---|---|
| `合并` | `merged()` 数出来的**场次**（含虚拟场次）—— 日历那一份 |
| `索引` | 直查索引的聚合（`_category_counts`：代表行 + 校正叠加 + 虚拟场次） |
| `重复代表` | 同一个 `session_key` 上有**多行**带值（不变量破了，按列会多算） |
| `孤儿值` | `session_key IS NULL` 却有 `category` 的行（不变量破了，按列会漏算） |

用法：

```bash
.venv\\Scripts\\python.exe scripts/check_type_index_parity.py            # 全部账号
.venv\\Scripts\\python.exe scripts/check_type_index_parity.py --verbose   # 逐账号打表
```

真库只读：全程在副本上跑（物化会写那份副本，用完删掉）。
⚠️ 真库可能还停在 f016（f017 要等应用重启才跑）⇒ 脚本在副本上补列，
这样"新代码 + 老数据"也能先量一遍 —— 量到的正是**物化跑完之后的终态**。
退出码 1 = 不等价（此时别把统计发给用户，先解释清楚）。
"""
from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

REAL_DB = Path(r"E:\test\DDToolkit-data\DDToolkit-data\vtuber.db")
COPY = ROOT / "tmp_type_index.db"

#: f016→f017 的纯加列部分（真库可能还没跑到）
_ADD_COLUMNS = ("ALTER TABLE live_sessions ADD COLUMN session_key TEXT",)


def _copy() -> None:
    if not REAL_DB.exists():
        raise SystemExit(
            f"找不到真机库：{REAL_DB}\n本脚本用于在开发机上核对口径等价性（要真库）。")
    for suffix in ("", "-wal", "-shm"):
        src = Path(str(REAL_DB) + suffix)
        if src.exists():
            shutil.copyfile(src, str(COPY) + suffix)
    con = sqlite3.connect(COPY)
    for sql in _ADD_COLUMNS:
        try:
            con.execute(sql)
        except sqlite3.OperationalError:
            pass
    con.commit()
    con.close()


def _cleanup() -> None:
    for suffix in ("", "-wal", "-shm"):
        try:
            Path(str(COPY) + suffix).unlink(missing_ok=True)
        except PermissionError:
            pass


def _fmt(counter: dict) -> dict:
    return {k: v for k, v in sorted(counter.items(), key=lambda kv: -kv[1]) if v}


def main() -> None:
    ap = argparse.ArgumentParser(description="核对按类型聚合与合并视图是否等数")
    ap.add_argument("--account", type=int, default=None, help="只量这个账号")
    ap.add_argument("--verbose", action="store_true", help="逐账号打表（含一致的）")
    args = ap.parse_args()

    _copy()
    from sqlalchemy import create_engine, func
    from sqlalchemy.orm import sessionmaker

    from app.models.vtuber import Account, LiveSession
    from app.repositories.vtuber_repo import LiveSessionRepo
    from app.routers.vtuber import (
        _category_counts, _live_infer_ctx, _resolve_categories,
    )

    engine = create_engine(f"sqlite:///{COPY.as_posix()}")
    db = sessionmaker(bind=engine)()

    q = (db.query(Account)
         .join(LiveSession, LiveSession.account_id == Account.id)
         .group_by(Account.id))
    if args.account:
        q = q.filter(Account.id == args.account)
    accounts = q.order_by(Account.id.asc()).all()
    if not accounts:
        raise SystemExit("没有带场次的账号")

    bad: list[int] = []
    totals = {"merge": 0, "index": 0, "virtual": 0, "dup": 0, "orphan": 0}

    for acc in accounts:
        sessions = LiveSessionRepo(db).merged(acc.id, with_ids=True)
        _account, overrides = _live_infer_ctx(db, acc.id)
        # ① 合并路（日历的口径）
        cats = _resolve_categories(db, acc.id, sessions, overrides)
        merge_counts: dict[str, int] = {}
        for cat, _src in cats:
            merge_counts[cat] = merge_counts.get(cat, 0) + 1
        # ② 索引路（卡片的口径；顺带触发物化）
        index_counts, _classified = _category_counts(db, acc.id, sessions, overrides)

        # ③ 不变量：一个 session_key 只许一行带值；NULL key 不许带值
        dup = int(
            db.query(func.count()).select_from(
                db.query(LiveSession.session_key)
                .filter(LiveSession.account_id == acc.id,
                        LiveSession.session_key.isnot(None),
                        LiveSession.category.isnot(None))
                .group_by(LiveSession.session_key)
                .having(func.count(LiveSession.id) > 1)
                .subquery()
            ).scalar() or 0
        )
        orphan = int(
            db.query(func.count(LiveSession.id))
            .filter(LiveSession.account_id == acc.id,
                    LiveSession.session_key.is_(None),
                    LiveSession.category.isnot(None))
            .scalar() or 0
        )

        m, i = _fmt(merge_counts), _fmt(index_counts)
        same = (m == i) and not dup and not orphan
        totals["merge"] += sum(m.values())
        totals["index"] += sum(i.values())
        totals["dup"] += dup
        totals["orphan"] += orphan
        if not same:
            bad.append(acc.id)
        if args.verbose or not same:
            print(f"[{'OK  ' if same else 'DIFF'}] 账号 {acc.id}"
                  f"（{acc.display_name or acc.platform_uid}）："
                  f"合并 {sum(m.values())} 场 / 索引 {sum(i.values())} 场"
                  f" · 重复代表 {dup} · 孤儿值 {orphan}")
            if m != i:
                for k in sorted(set(m) | set(i)):
                    a, b = m.get(k, 0), i.get(k, 0)
                    if a != b:
                        print(f"        {k:>8}: 合并 {a}  索引 {b}  （差 {b - a:+d}）")

    print()
    print(f"账号 {len(accounts)} 个 · 对不上 {len(bad)} 个 · "
          f"合并合计 {totals['merge']} 场 / 索引合计 {totals['index']} 场 · "
          f"重复代表 {totals['dup']} · 孤儿值 {totals['orphan']}")
    if bad:
        print("⚠️ 两条路不等价 ⇒ 先解释清楚差异，别把统计当成能对账的数字。")
    else:
        print("✅ 逐类等数，且没有重复代表 / 孤儿值 ⇒ 直查索引在口径上成立。")

    db.close()
    engine.dispose()
    _cleanup()
    raise SystemExit(1 if bad else 0)


if __name__ == "__main__":
    main()
