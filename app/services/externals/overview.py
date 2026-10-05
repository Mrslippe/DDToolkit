"""「这个 V 的第三方数据现在有什么」—— 给 UI 的现状汇总（2026-10-05，`devlog/354`）。

## 为什么要有它

第三方数据来自两个站点（zeroroku 的粉丝历史 / 礼物日、danmakus 的直播场次），
而它们的**入库只靠每日批次与收录回填**：抓取失败（WAF 拦、上游抖动）或数据被清掉之后，
用户在界面上**看不出缺了什么**，也没有任何入口能手动补一次 —— 只能等下一次定时任务，
或者把 V 删掉重收（`devlog/275` 那次的形态：弥月缺 11 场，全库 danmakus 行停在 09-28）。

所以这里把"库里现在到底有多少、最新到哪一天"如实算出来：它既是**诊断**
（对着 9.28–10.2 那段缺口一眼能看出最新日期停在哪），也是那个「重新拉取」按钮的**前提**。

## 数据来源与口径

| 块 | 表 | 判据 |
|---|---|---|
| 粉丝历史 | `account_stat_snapshots` | `source='zeroroku'`（第三方）/ `'self'`（本工具直采，分开报，别混成一个数）|
| 直播场次 | `live_sessions` | `source='danmakus'`（第三方）/ `'feed'`（B站实时，分开报）|
| 礼物日 | `live_gift_days` | 日聚合（`source` 同 zeroroku 口径）|

⚠️ **只算 bilibili 账号**：两个源都是按 B 站 mid/room 抓的（见 `zeroroku._bili_accounts`
与 `danmakus._bili_accounts`）—— 把微博/小红书账号列进来只会让人以为"它们也有第三方数据"。
"""
from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.vtuber import Account, AccountStatSnapshot, LiveGiftDay, LiveSession

#: 两个源在库里留下的 `source` 标记（写路径见各自适配器；这里是**读**口径）
THIRDPARTY_SOURCES = {
    "fan_history": "zeroroku",
    "live_sessions": "danmakus",
    "gift_days": "zeroroku",
}


def _iso(v) -> str | None:
    """聚合结果里的时间/日期 → 字符串。

    ⚠️ 不能一律 `.isoformat()`：`live_gift_days.gift_date` 是**字符串列**（"2026-09-04"，
    见模型注释——保精度防漂移），`func.min/max` 给回来的就是 str；而场次/快照那两张是
    DateTime。两种都要认，否则礼物那一块会 500。
    """
    if v is None:
        return None
    return v.isoformat() if hasattr(v, "isoformat") else str(v)


def _stat_blocks(db: Session, account_ids: list[int]) -> dict[int, dict[str, dict]]:
    """粉丝历史：`account_id → {source: {条数/首/末}}`（第三方与直采**分开**报）。

    ⚠️ **必须按账号分别算**（`group_by(account_id, source)`）：第一版是"整批聚合一次、
    每个账号都填同一份数字"，于是在两个账号的 V 上直接把同一个数抄了两遍
    （对着真库实测就露馅了：恬豆发芽了的两个账号给出完全相同的 2643 条）——
    "这个账号缺了哪段"这种问题在那份数字上根本答不出来。
    """
    out: dict[int, dict[str, dict]] = {aid: {} for aid in account_ids}
    rows = (
        db.query(AccountStatSnapshot.account_id, AccountStatSnapshot.source,
                 func.count(AccountStatSnapshot.id),
                 func.min(AccountStatSnapshot.captured_at),
                 func.max(AccountStatSnapshot.captured_at))
        .filter(AccountStatSnapshot.account_id.in_(account_ids))
        .group_by(AccountStatSnapshot.account_id, AccountStatSnapshot.source)
        .all()
    )
    for aid, source, n, first, last in rows:
        out.setdefault(aid, {})[source] = {
            "rows": int(n or 0), "first_at": _iso(first), "last_at": _iso(last)}
    for aid in out:
        for source in ("zeroroku", "self"):
            out[aid].setdefault(source, {"rows": 0, "first_at": None, "last_at": None})
    return out


def _session_blocks(db: Session, account_ids: list[int]) -> dict[int, dict[str, dict]]:
    """直播场次：`account_id → {source: …}`（danmakus 第三方 / feed 实时）。"""
    out: dict[int, dict[str, dict]] = {aid: {} for aid in account_ids}
    rows = (
        db.query(LiveSession.account_id, LiveSession.source,
                 func.count(LiveSession.id),
                 func.min(LiveSession.start_at), func.max(LiveSession.start_at))
        .filter(LiveSession.account_id.in_(account_ids))
        .group_by(LiveSession.account_id, LiveSession.source)
        .all()
    )
    for aid, source, n, first, last in rows:
        out.setdefault(aid, {})[source] = {
            "rows": int(n or 0), "first_at": _iso(first), "last_at": _iso(last)}
    for aid in out:
        for source in ("danmakus", "feed"):
            out[aid].setdefault(source, {"rows": 0, "first_at": None, "last_at": None})
    return out


def _gift_blocks(db: Session, account_ids: list[int]) -> dict[int, dict]:
    """礼物日聚合（日粒度；danmakus 不提供这一项，只有 zeroroku）。同样按账号分开。"""
    out: dict[int, dict] = {
        aid: {"rows": 0, "first_at": None, "last_at": None} for aid in account_ids}
    rows = (
        db.query(LiveGiftDay.account_id, func.count(LiveGiftDay.id),
                 func.min(LiveGiftDay.gift_date), func.max(LiveGiftDay.gift_date))
        .filter(LiveGiftDay.account_id.in_(account_ids))
        .group_by(LiveGiftDay.account_id)
        .all()
    )
    for aid, n, first, last in rows:
        out[aid] = {"rows": int(n or 0), "first_at": _iso(first), "last_at": _iso(last)}
    return out


def overview(db: Session, vtuber_id: int) -> dict:
    """这个 V 的第三方数据现状（按账号列出；没有 bilibili 账号时 `thirdparty_accounts` 为空）。

    返回的键集合被 `tests/test_thirdparty_overview.py` 逐字钉住 —— 前端 dialog 直接照它渲染，
    少一个键就是界面上一格空白（不是"没有数据"）。
    """
    accounts = (
        db.query(Account)
        .filter(Account.vtuber_id == vtuber_id, Account.platform == "bilibili")
        .order_by(Account.id)
        .all()
    )
    ids = [a.id for a in accounts]
    rows: list[dict] = []
    if ids:
        stats = _stat_blocks(db, ids)
        sessions = _session_blocks(db, ids)
        gifts = _gift_blocks(db, ids)
        for a in accounts:
            rows.append({
                "account_id": a.id,
                "platform_uid": a.platform_uid,
                "display_name": a.display_name,
                # 第三方三块（界面按这三行显示"有多少 / 最新到哪天"）
                "fan_history": stats[a.id]["zeroroku"],
                "fan_history_local": stats[a.id]["self"],
                "live_sessions": sessions[a.id]["danmakus"],
                "live_sessions_feed": sessions[a.id]["feed"],
                "gift_days": gifts[a.id],
            })
    return {"vtuber_id": vtuber_id, "thirdparty_accounts": rows}


def sources_state() -> list[dict]:
    """两个源**现在开没开**（三层开关的实际结果）—— 关着时按钮要能说清为什么。

    复用 runner 的判定（同一个 `_source_enabled`），不在这里另写一份开关逻辑：
    两处口径一旦分叉，"界面说能拉、实际一条都不发"就是最难查的那种 bug。
    """
    from app.services.externals.registry import iter_external_sources
    from app.services.externals.runner import _source_enabled

    out: list[dict] = []
    for s in iter_external_sources():
        if not s.jobs:          # 空壳源（laplace：无 API）不进 UI
            continue
        out.append({
            "name": s.name,
            "enabled": bool(_source_enabled(s)),
            "jobs": [{"kind": j.kind, "label": j.label, "interval": j.interval}
                     for j in s.jobs],
        })
    return out
