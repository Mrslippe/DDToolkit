"""场次身份（f017）的**装配**：把"哪些行是同一场、哪一行代表它"落库。

## 它解决什么

`live_sessions` 里同一场直播可能有多行（两个录制源 / danmakus + feed），而"哪些行是同一场"
只有**读取时的合并规则**说了算（`LiveSessionRepo.merged()`）。按类型聚合若直接
`GROUP BY category`，数的是**行**、不是**场次**（真机实测多算 123 行），而两个界面都不会报错。
`live_settle` 定义了记法（`session_key` + 兜底也落库），本模块负责**装配**：
拿到一个账号的全部行 → 跑一次 `merged(with_ids=True)` → 交给 `group_states` 定代表行与类型 →
由仓库一次性写回（`LiveSessionRepo.materialize_sessions`）。

## ⚠️ 为什么不是"读的时候顺手补"（`devlog/471` 的第一版就是这么做的）

第一版把补齐放在读路径（`routers/vtuber.py::_stored_by_lid_id`），代价是**第一次打开最慢**：
真机账号 22 实测 `/live-sessions` **464ms**（冷）vs 170ms（热）—— 而前端恰恰在
"还没有任何场次"时才显示加载块，用户**看得见**这一下。修补（`devlog/473`）：

| 时机 | 谁调 | 为什么 |
|---|---|---|
| **启动期**（迁移之后） | `app/main.py::lifespan` → `materialize_all` | 与迁移同一个模式：自动跑、用户不用管；把"一次性的补齐"搬出请求 |
| **写点之后** | 同步收尾 / 手动增删改之后 | "写这一行就定稿这一行"（用户口径），顺手把身份也定了 |
| ~~读路径~~ | —— | 读端点**只读**：`mode=ro` 的库也能读，第一次打开不再是最慢的一次 |

## 分层

服务层（这里）只做装配；**推断**在 `live_settle`（纯函数）、**落库**在 `LiveSessionRepo`
（只 setattr）。三条边都朝下，没有回边 —— 判据 `tests/test_dependency_direction.py`。

⚠️ 本模块**不 import `app.routers`**：代表行的选法（"对外 `live_id` 那一行"）由
`group_states` 自己从 `s["live_id"]` 读，不依赖路由层的任何实现（那条曾经让
"物化写 A 行、读取查 B 行"的分叉，见 `devlog/471`§三）。
"""
from __future__ import annotations

from app.services.live_settle import group_states


def _attach_stored(sessions: list[dict], rows: list) -> None:
    """把每个合并组**代表行**的落库原始值挂到 `s["stored_category"]`。

    代表行 = `merged()` 给这个组定的对外 `live_id` 那一行（与 `group_states` 同一条）。
    """
    by_live = {r.live_id: r for r in rows if r.live_id}
    for s in sessions:
        rep = s.get("live_id")
        row = by_live.get(rep) if rep else None
        s["stored_category"] = ((row.category, row.category_from)
                                if row is not None else None)


def materialize_account(db, account_id: int) -> tuple[dict, list]:
    """给**一个账号**算好场次身份并落库（装配 + 写）。

    返回 `(仓库计数, 物化目标)`。启动期补齐与"写点顺手补"两条路共用本函数 ——
    两条路必须走**同一个**装配口径，否则物化出来的身份会与读取时看到的不一致。
    """
    from app.repositories.vtuber_repo import LiveSessionRepo

    repo = LiveSessionRepo(db)
    rows = [r for r in repo.list_by_account(account_id) if r.live_id]
    sessions = repo.merged(account_id, with_ids=True)
    _attach_stored(sessions, rows)
    states = group_states(sessions)
    return repo.materialize_sessions(account_id, states, rows=rows), states


def materialize_all(db) -> dict:
    """**启动期**给所有账号补齐场次身份（返回计数）。

    与迁移同一个时机（`app/main.py` 的 lifespan，迁移之后）：迁移会自动跑，
    这个补齐同理 —— 用户不需要跑任何脚本。幂等（值一样就不写），所以每次启动都跑得起。
    """
    from app.models.vtuber import LiveSession

    account_ids = [row[0] for row in
                   db.query(LiveSession.account_id).group_by(LiveSession.account_id).all()]
    total = {"accounts": 0, "scanned": 0, "written": 0}
    for account_id in account_ids:
        stats, _states = materialize_account(db, account_id)
        total["accounts"] += 1
        total["scanned"] += stats["scanned"]
        total["written"] += stats["written"]
    return total


__all__ = ["materialize_account", "materialize_all"]
