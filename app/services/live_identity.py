"""场次身份（f017）的**装配**：把"哪些行是同一场、哪一行代表它"落库。

## 它解决什么

`live_sessions` 里同一场直播可能有多行（两个录制源 / danmakus + feed），而"哪些行是同一场"
只有**读取时的合并规则**说了算（`LiveSessionRepo.merged()`）。按类型聚合若直接
`GROUP BY category`，数的是**行**、不是**场次**（真机实测多算 123 行），而两个界面都不会报错。
`live_settle` 定义了记法（`session_key` + 兜底也落库），本模块负责**装配**：
拿到一个账号的全部行 → 跑一次 `merged(with_ids=True)` → 交给 `group_states` 定代表行与类型 →
由仓库一次性写回（`LiveSessionRepo.materialize_sessions`）。

## ⚠️ 为什么不是"读的时候顺手补"（`devlog/471` 的第一版就是这么做的）

第一版把补齐放在读路径（`routers/vtuber.py::_stored_by_live_id`），代价是**第一次打开最慢**：
真机账号 22 实测 `/live-sessions` **464ms**（冷）vs 170ms（热）—— 而前端恰恰在
"还没有任何场次"时才显示加载块，用户**看得见**这一下。修补（`devlog/473`）：

| 时机 | 谁调 | 为什么 |
|---|---|---|
| **启动期**（迁移之后） | `app/main.py::lifespan` → `materialize_all` | 与迁移同一个模式：自动跑、用户不用管；把"一次性的补齐"搬出请求 |
| **写点之后** | 同步收尾 / 手动增删改之后 | "写这一行就定稿这一行"（用户口径），顺手把身份也定了 |
| ~~读路径~~ | —— | 读端点**只读**：`mode=ro` 的库也能读，第一次打开不再是最慢的一次 |

## ⚠️ 启动期**只在"有账号需要补"时才扫**（`devlog/475`）

`materialize_all` 一开始是无条件全库扫一遍比对：真机实测**正常启动 485ms**（14 账号 /
8,527 行，写 0）—— 一次都不写却每次开应用都要付。现在每个账号在 `app_meta` 里留一个
**记号**（`live_identity_v<版本>:<account_id>`）：

- 跑过 ⇒ 写记号；启动期只处理**没记号 / 记号版本旧**的账号（算法变了就调 `IDENTITY_VERSION`，
  全库重补一次）；
- 增量同步置空它自己那个账号的记号（那一批行变了）⇒ 下次启动（或那次同步收尾）重补；
- **purge / 手动删除**也置空 ⇒ 不留"行没了、身份还指着旧代表"的账。

⇒ 正常启动只剩**一次 GROUP BY + 读记号**（毫秒级），而"该补的"一个都跑不掉。

## 分层

服务层（这里）只做装配；**推断**在 `live_settle`（纯函数）、**落库**在 `LiveSessionRepo`
（只 setattr）。三条边都朝下，没有回边 —— 判据 `tests/test_dependency_direction.py`。

⚠️ 本模块**不 import `app.routers`**：代表行的选法（"对外 `live_id` 那一行"）由
`group_states` 自己从 `s["live_id"]` 读，不依赖路由层的任何实现（那条曾经让
"物化写 A 行、读取查 B 行"的分叉，见 `devlog/471`§三）。
"""
from __future__ import annotations

from app.services.live_settle import group_states

#: 装配算法的版本。**改了代表行的选法 / 类型来源就 +1** —— 否则老账号会带着旧结论被跳过。
IDENTITY_VERSION = 1


def _mark_key(account_id: int) -> str:
    return f"live_identity_v{IDENTITY_VERSION}:{account_id}"


def identity_mark_key(account_id: int) -> str:
    """这一账号的"已按本版算法装配过"记号（`app_meta` 的键）。

    给路由层用（手动增删改之后的回执要打记号）；键的构造只有一处，别在别处拼。
    """
    return _mark_key(account_id)


def _clear_mark(db, account_id: int) -> None:
    """把这一账号的记号置空 ⇒ 下次启动（或收尾）重补。

    给"行变过、却没走装配"的路径用：同步抛错、purge、手动删场次。
    ⚠️ 删记号本身也要 commit —— 与 `AppMetaRepo.set` 同一个口径（调用点都是任务边界）。
    """
    from app.models.vtuber import AppMeta

    row = db.query(AppMeta).filter(AppMeta.key == _mark_key(account_id)).first()
    if row is None:
        return
    db.delete(row)
    db.commit()


def mark_dirty(db, account_id: int) -> None:
    """对外名字：这一账号的行变了 ⇒ 把"已装配"的记号作废（见 `_clear_mark`）。"""
    _clear_mark(db, account_id)


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


def materialize_account(db, account_id: int, *, mark: bool = True) -> tuple[dict, list]:
    """给**一个账号**算好场次身份并落库（装配 + 写 + 打记号）。

    返回 `(仓库计数, 物化目标)`。启动期补齐与"写点顺手补"两条路共用本函数 ——
    两条路必须走**同一个**装配口径，否则物化出来的身份会与读取时看到的不一致。

    `mark=False`：**这次没补成**（同步抛错的那条路）⇒ 别打记号，下次还得来。
    """
    from app.repositories.vtuber_repo import AppMetaRepo, LiveSessionRepo

    repo = LiveSessionRepo(db)
    rows = [r for r in repo.list_by_account(account_id) if r.live_id]
    sessions = repo.merged(account_id, with_ids=True)
    _attach_stored(sessions, rows)
    states = group_states(sessions)
    stats = repo.materialize_sessions(account_id, states, rows=rows)
    if mark:
        AppMetaRepo(db).set(_mark_key(account_id), "1")
    else:
        _clear_mark(db, account_id)
    return stats, states


def accounts_needing_materialize(db) -> list[int]:
    """哪些账号**需要**补齐（没记号 / 记号版本旧 / 一个账号都没有记号）。

    ⚠️ 一次查询拿全部记号（不是每账号一次）：正常启动的全部成本就是这一次 GROUP BY
    加这一次 SELECT（真机 14 账号实测 **毫秒级**；无条件扫的旧版是 485ms）。
    """
    from app.models.vtuber import AppMeta, LiveSession

    account_ids = [row[0] for row in
                   db.query(LiveSession.account_id).group_by(LiveSession.account_id).all()]
    if not account_ids:
        return []
    # ⚠️ 只问这 N 个键（不是把 `app_meta` 全表拉回来再过滤）：`app_meta` 里还躺着
    #    别的记账键（补抓时间戳之类），全表扫会随它们增长 —— 而这条路径每次启动都要跑。
    keys = {_mark_key(a): a for a in account_ids}
    marked = {
        keys[key] for (key,) in db.query(AppMeta.key)
        .filter(AppMeta.key.in_(list(keys))).all()
    }
    return [a for a in account_ids if a not in marked]


def materialize_all(db) -> dict:
    """**启动期**给"需要补"的账号补齐场次身份（返回计数）。

    与迁移同一个时机（`app/main.py` 的 lifespan，迁移之后）：迁移会自动跑，这个补齐同理 ——
    用户不需要跑任何脚本。幂等（值一样就不写 + 记号跳过），所以每次启动都跑得起。
    """
    pending = accounts_needing_materialize(db)
    total = {"accounts": len(pending), "scanned": 0, "written": 0}
    for account_id in pending:
        stats, _states = materialize_account(db, account_id)
        total["scanned"] += stats["scanned"]
        total["written"] += stats["written"]
    return total


__all__ = [
    "IDENTITY_VERSION", "accounts_needing_materialize", "identity_mark_key",
    "mark_dirty", "materialize_account", "materialize_all",
]
