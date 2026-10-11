"""核对：**日同步会重新定稿多少历史行**（T1 口径的实测工具）。

## 它回答的问题

T1 定下的口径是「写这一行就定稿这一行，**不回头改别的行**」。但 `upsert_danmakus`
是**按批**写的，而 danmakus 的 `/channel lives` 返回的是**全历史**（不是增量）——
所以"下一次同步"到底会不会把整批老行按**新规则**重判，只能实测，不能想当然。

实测结论（2026-10-12，真机副本）：**会**。一个 426 行的账号同步一次 ⇒ `updated: 426`，
其中 352 行两条类型列被写、74 行落回 NULL（兜底不落库）。
⇒ 「改规则不回填老行」只对**同步碰不到的行**成立（上游索引里没有的那些）；
被索引覆盖的行会在下一次日同步时用新规则重判。

这正是 T3 的机制性依据：**换体系之后老行会自己跟上**，不需要一次性回填脚本，
也不需要"破例跑一次重判"。

## 用法

```bash
python scripts/check_resettle_scope.py            # 挑场次最多的账号量一次
python scripts/check_resettle_scope.py --account 22
python scripts/check_resettle_scope.py --dry-run  # 只看账号与行数，不打上游
```

⚠️ 会**打真上游**（一次 `/channel lives`）。失败时如实报错退出，不把失败写成"0 变化"。
真库只读：全程在副本上跑。
"""
from __future__ import annotations

import argparse
import asyncio
import shutil
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

REAL_DB = Path(r"E:\test\DDToolkit-data\DDToolkit-data\vtuber.db")
COPY = ROOT / "tmp_resettle.db"

#: f010–f016 的**纯加列**部分（真库可能停在旧迁移上；这里只补列，不动约束）
_ADD_COLUMNS = (
    "ALTER TABLE live_sessions ADD COLUMN vod_url TEXT",
    "ALTER TABLE live_sessions ADD COLUMN category TEXT",
    "ALTER TABLE live_sessions ADD COLUMN category_from TEXT",
    "ALTER TABLE vtubers ADD COLUMN sort_order INTEGER DEFAULT 0",
    "ALTER TABLE vtubers ADD COLUMN background_focus TEXT",
    "ALTER TABLE vtubers ADD COLUMN background_video_path VARCHAR",
    "ALTER TABLE vtubers ADD COLUMN background_video_focus TEXT",
    "ALTER TABLE vtubers ADD COLUMN group_name TEXT",
    "ALTER TABLE vtubers ADD COLUMN group_uuid TEXT",
    "ALTER TABLE vtubers ADD COLUMN vod_account_uid TEXT",
)


def _copy() -> None:
    if not REAL_DB.exists():
        raise SystemExit(
            f"找不到真机库：{REAL_DB}\n本脚本用于在开发机上核对重判范围（要真库）。")
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


def main() -> None:
    ap = argparse.ArgumentParser(description="核对日同步的重判范围")
    ap.add_argument("--account", type=int, default=None, help="账号 id（默认挑场次最多的）")
    ap.add_argument("--dry-run", action="store_true", help="不打上游，只看账号与行数")
    args = ap.parse_args()

    _copy()
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.models.vtuber import Account, LiveSession

    engine = create_engine(f"sqlite:///{COPY.as_posix()}")
    db = sessionmaker(bind=engine)()

    if args.account:
        acc = db.query(Account).filter(Account.id == args.account).one_or_none()
    else:
        acc = (db.query(Account).join(LiveSession, LiveSession.account_id == Account.id)
               .group_by(Account.id)
               .order_by(LiveSession.id.desc()).first())
    if acc is None:
        raise SystemExit("没有可核对的账号（库里没有带场次的账号）")

    # 当前规则下"健身类"有多少行（T3 换体系前跑一次，换完再跑一次对账）
    from app.services.live_settle import settle

    def snapshot() -> dict:
        db.expire_all()
        rows = db.query(LiveSession).filter(LiveSession.account_id == acc.id).all()
        return {r.id: (r.category, r.category_from, r.updated_at, r.title,
                       r.area_name, r.parent_area_name) for r in rows}

    before = snapshot()
    fit = [i for i, v in before.items()
           if settle(v[3], v[4], v[5], None)[0] == "fitness"]
    print(f"账号 {acc.id}（{acc.display_name or acc.platform_uid}）：{len(before)} 行，"
          f"按**当前规则**判成 fitness 的 {len(fit)} 行")
    if args.dry_run:
        print("（--dry-run：不打上游）")
        db.close()
        engine.dispose()
        _cleanup()
        return

    from app.core.http import new_async_client
    from app.services.externals.danmakus import DanmakusSource

    async def run() -> dict:
        async with new_async_client(20.0) as client:
            return await DanmakusSource().sync_account(db, acc, client)

    try:
        res = asyncio.run(run())
    except Exception as exc:
        print(f"⚠️ 同步没跑成（{type(exc).__name__}: {exc}）—— **这次没有结论**，"
              f"别把失败写成『0 变化』")
        db.close()
        engine.dispose()
        _cleanup()
        raise SystemExit(1)

    print("同步结果:", res)
    after = snapshot()
    added = [i for i in after if i not in before]
    cat_changed = [i for i in before if i in after and before[i][:2] != after[i][:2]]
    ts_changed = [i for i in before if i in after and before[i][2] != after[i][2]]
    title_changed = [i for i in before if i in after and before[i][3] != after[i][3]]
    print(f"新增 {len(added)} 行 · **类型两列变了 {len(cat_changed)}** · "
          f"`updated_at` 抬过 {len(ts_changed)} · 标题变过 {len(title_changed)}")
    if title_changed:
        print("⚠️ 有标题被刷新 —— 那么两列变化里有一部分是『数据变了』而不是『规则变了』")
    for i in cat_changed[:8]:
        print(f"  id={i}: {before[i][:2]} → {after[i][:2]}  {before[i][3]!r}")

    db.close()
    engine.dispose()
    _cleanup()


if __name__ == "__main__":
    main()
