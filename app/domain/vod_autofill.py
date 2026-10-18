# -*- coding: utf-8 -*-
"""把「录播条目」对到「场次」上（C1 扩展，2026-10-14，`docs/plans/vod-autofill.md` B1/B2）。

## 口径（全部来自 2026-10-14 的真机实测，见方案 §1）

| 实测 | 设计后果 |
|---|---|
| 942/942 条录播标题含 `YYYY年M月D日HH点场` | 时间是**读数**，不是猜数 ⇒ 高置信路径 |
| 库里的 `start_at` 是 **UTC**，标题是**北京墙上时间**（+8 后命中 884/942，不加只有 7/942） | 入口显式 `to_beijing()`，别让它散在各处 |
| 标题时刻与 `start_at` 有系统偏移：中位 **−48 分**、p90 **0 分** | 容差 `DEFAULT_TOLERANCE = 90 分` |
| 28 场对到多条录播（同场拆段） | 一场只写一条 `vod_url`，其余标 `alternates` 进审查表 |
| 6–10% 的场次**真的没有录播** | 返回 `unmatched` 而不是硬凑 —— 那是"手动补"的入口 |

⚠️ **本模块只排队、不写库**（与 `vod-candidates` 同一条纪律）：写由调用方拿 `match.primary` 显式执行。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from app.domain.vod_source import (MIN_FALLBACK_SECONDS, TimeHint,
                                   matching_tolerance)

#: 场次时间（UTC）→ 北京墙上时间。实测依据见模块头：不加这 8 小时，命中率从 94% 掉到 0.7%。
BEIJING = timezone(timedelta(hours=8))

#: 标题时刻与场次开播的允许偏差（分钟）。
#: 实测（2026-10-15，真库真上游 249 场）：中位 48–52 分，而**尾巴到 138 分**都是同一天的
#: —— 那是"录播号晚开录"（用户指出的形态：非官方录播号与直播时间有差距）。
#: 取 **200 分**：够覆盖到 138 分，又远小于"隔天"（实测最近的不同日条目差 1142 分以上），
#: 所以不会把邻日的那一场配进来。
DEFAULT_TOLERANCE_MINUTES = 200

#: **"晚传"的判据**（用户 2026-10-15 提出的第三种形态）：「非官方录播号可能上传时间和直播时间
#: 有很大差距，但会在标题中标明日期」。
#: 这类条目的匹配**只看标题日期**（同一天即算），`published_at` 只用来补年份 ——
#: 所以它们**不需要**兜底路径那条"发布日必须同一天"的限制。
#: 这条常量只用于**日志与文案**（说清"这条是隔了很久才传的"，不是判据本身）。
LATE_UPLOAD_DAYS = 2

#: **中断续播**共用一份录播时，时长未知的兜底跨度（分钟）。实测一场直播 4–6 小时，
#: 取 4 小时：够覆盖"断一次、隔一会儿又开"的常见形态，又不会把隔夜的两场并进来。
SHARE_FALLBACK_MINUTES = 240

#: 置信度（数字越小越可信，直接当排序键）。**必须在结果里带出去**：
#: 审查表要按它决定"默认勾选"还是"要你看一眼"。
CONF_TITLE = 0      # 标题时间对得上 且 标题含回放词（`replay`）
CONF_DATED = 1      # 标题时间对得上，但没有回放词（`dated`）
CONF_FALLBACK = 2   # 没有可读时间，只能靠"同一天 + 时长不短"兜底 —— 默认**不勾选**


def to_beijing(dt: datetime) -> datetime:
    """UTC（或带时区）→ 北京**墙上**时间（朴素 datetime，用于和标题里的时间比）。

    ⚠️ 朴素值**按 UTC 解释**（本仓所有落库时间都是朴素 UTC）。传进来的若是带时区的，
    先归一到 UTC 再换。
    """
    if dt.tzinfo is not None:
        return dt.astimezone(BEIJING).replace(tzinfo=None)
    return dt + timedelta(hours=8)


@dataclass
class SourceItem:
    """一条**已经过前处理**的录播候选（来自某个 mid 的某个来源）。"""

    bvid: str
    title: str
    #: 秒（上游给的是秒；库里的投稿是 `"5:00:09"` 串，由服务层转好再进来）
    duration_seconds: int | None = None
    #: 发布时刻（朴素 UTC）
    published_at: datetime | None = None
    permalink: str = ""
    cover_url: str = ""
    #: 来自哪个录播号 / 哪个来源（审查表要显示"为什么是它"）
    mid: str = ""
    source_name: str = ""
    #: `replay` / `dated` / `weak`（见 `vod_source.classify`）
    tier: str = "weak"
    #: 从标题读出来的场次时刻（北京墙上时间）
    hint: TimeHint | None = None


@dataclass
class Match:
    """一条"场次 ↔ 录播"的配对。"""

    live_id: str
    start_at: datetime
    candidate: SourceItem
    confidence: int
    #: 标题时刻 − 场次开播（分钟，正=录播标的时刻更晚）；兜底路径为 `None`
    minutes_delta: float | None = None
    #: 场次标题（**审查表要显示"这是哪一场"** —— 只有 `live_id` 人认不出来）
    live_title: str | None = None
    #: 同一场次的**其他**分段/其他号命中（供审查表切换）
    alternates: list[SourceItem] = field(default_factory=list)

    @property
    def auto_ok(self) -> bool:
        """默认勾选吗：只有**读出来的时间**对得上才算（兜底那条要人看一眼）。"""
        return self.confidence != CONF_FALLBACK


def _fallback_ok(item: SourceItem, start_beijing: datetime) -> bool:
    """兜底判据（**标题里什么日期都没有**时才走到这里）：满足其一即算。

    1. **发布日同一天**（北京）：录播当天传的，最常见；
    2. **发布远晚于场次**（≥ `LATE_UPLOAD_DAYS`）：非官方录播号会隔几天甚至更久才补传
       （用户 2026-10-15 指出的形态）。这一类**没有标题日期可依**，所以只收"长视频"
       （≥30 分）并交给审查表里的人看 —— 默认**不勾选**。

    ⚠️ 这里刻意**不**看时长像不像本场：本模块拿不到场次时长（`merged()` 的
    `duration_minutes` 只在有 `end_at` 时才有），而"同日 + ≥30 分钟"已经能把
    切片/动态/转载滤掉。像不像交给审查表上的人看 —— 这正是"先审查再写"的意义。
    """
    if item.duration_seconds is not None and item.duration_seconds < MIN_FALLBACK_SECONDS:
        return False
    if item.published_at is None:
        return False
    pub_cn = to_beijing(item.published_at)
    if pub_cn.date() == start_beijing.date():
        return True
    return (pub_cn - start_beijing).days >= LATE_UPLOAD_DAYS


def match_sessions(rows: list[dict], items: list[SourceItem], *,
                   tolerance_minutes: int = DEFAULT_TOLERANCE_MINUTES,
                   include_matched: bool = False
                   ) -> list[Match]:
    """`(场次行, 候选条目)` → 配对列表（按置信度、再按时间差排序）。

    `rows` 用到的键：`live_id`（**必须有**，虚拟场次/self 快照行没有 id，会被跳过）、
    `start_at`（**朴素 UTC**）、`vod_url`（已有录播的场次**不参与匹配** —— 用户手填的
    地址（不变量 39）绝不能被自动匹配覆盖）。

    ## 三条匹配路径（2026-10-15 补齐第三条）

    - **标题带时刻** ⇒ `|标题时刻 − 场次开播| ≤ 该条目的窗口`
      （窗口**按条目算**：早场用 `EARLY_TOLERANCE_MINUTES`，其余用 `tolerance_minutes`）；
      置信度 = `replay` → 0 / `dated` → 1；
    - **标题只有日期** ⇒ 北京**同一天**即算（`minutes_delta` 记 `None`：没有可比时刻）；置信度同上；
    - **标题什么都没有** ⇒ 兜底（`_fallback_ok`：发布日同一天 **或** 发布远晚于场次）；
      置信度 2 ⇒ 审查表默认**不勾**。

    ⚠️ 第二条是非官方录播号的常见形态（用户 2026-10-15：「上传时间和直播时间有很大差距，
    但会在标题中标明日期」）—— 拿那个补出来的 00:00 去算时间差会把它判成差 20 小时。

    `include_matched=True` ⇒ **已有 `vod_url` 的场次也进池子**（默认排除，保护用户手填的
    地址 —— 不变量 39）。⚠️ 2026-10-15（f018）之后**没有任何调用方**：清空改成了按
    `vod_source` 记账的纯数据库操作。**刻意留着它**（而不是删）是因为它带着"写入路径永远
    不许用"这条警告 —— 删掉之后，下一个人很可能自己加回一个"把已匹配的也放进来"的开关，
    而那正是"自动匹配覆盖用户手填地址"的入口。

    多条候选命中同一场次时：按 `(置信度, |时间差|, 时长降序)` 选**主选**，
    其余进 `alternates`。同一场次只出现一次。
    """
    # 没有 live_id 的场次没法写；已有录播的场次默认排除（`include_matched` 见 docstring）
    pool = [r for r in rows
            if r.get("live_id") and r.get("start_at")
            and (include_matched or not r.get("vod_url"))]
    by_id = {str(r["live_id"]): r for r in pool}
    # ⚠️ **北京墙上时间只算一次**（2026-10-15）：原来在 `items × pool` 的内层循环里现算，
    #    满池（927 × 942）时那是 **87 万次** `to_beijing` —— 单这一项就 0.9s。
    start_cn = {lid: to_beijing(r["start_at"]) for lid, r in by_id.items()}

    # ① 先算出**全部合法的 (场次, 条目)**，附上置信度与"代价"
    pairs: list[tuple[str, int, float, SourceItem]] = []
    for item in items:
        for live_id, row in by_id.items():
            cn = start_cn[live_id]
            if item.hint is not None:
                if item.hint.date_only:
                    # 标题只给日期 ⇒ **同一天**即算（不拿 00:00 算差）；
                    # 代价给一个中间值：同一天的条目之间无法用时间分优劣
                    if item.hint.at.date() != cn.date():
                        continue
                    pairs.append((live_id,
                                  CONF_TITLE if item.tier == "replay" else CONF_DATED,
                                  240.0, item))
                    continue
                # ⚠️ 窗口**按条目**算，不是全局一个数：早场（0–5 点）的日期
                #    可能是前一天（录播号惯例），单一窗口会把它全判成配不上
                window = matching_tolerance(item.hint, tolerance_minutes)
                delta = (item.hint.at - cn).total_seconds() / 60.0
                if abs(delta) > window:
                    continue
                conf = CONF_TITLE if item.tier == "replay" else CONF_DATED
                pairs.append((live_id, conf, abs(delta), item))
            elif item.tier == "weak" and _fallback_ok(item, cn):
                # 兜底没有可比时刻 ⇒ 代价取得很大：**永远让位给有时间的那条**
                pairs.append((live_id, CONF_FALLBACK, 9999.0, item))

    # ② 贪心分配（按 置信度 → 代价 排序），然后把"两边都更近"的交换过来。
    #    ⚠️ 只用贪心会**饿死**真场次：2026-10-15 真机实测三条录播被分给了同一天里
    #    "更近"的那一场，而它们真正对应的场次（差 119–138 分）成了漏配 ——
    #    两条都合法、且两条都只能各拿一条时，必须让他们换。
    # ⚠️ 等代价时的次序 **`-(时长)`**：同一场命中的多条里选**最长**的那条当主选
    #    （实测 28 场有拆段，主段总是更长的那一份）—— 漏了这一项，主选会退化成
    #    "先遍历到的那条"（`test_longest_recording_wins_and_others_become_alternates` 守着）。
    pairs.sort(key=lambda t: (t[1], t[2], -(t[3].duration_seconds or 0)))
    # ⚠️ **代价查表必须在排序之后建**（2026-10-15 性能修复）：交换那一轮要对每个
    #    (场次, 条目) 问"这一对合法吗、代价多少"，原来每个问题都**线性扫一遍 `pairs`**
    #    —— 满池实测 **160 万次** `_cost_of`、占 57s 里的 **54s**（94%）。
    #    `setdefault` = 保留**第一个**命中的那条，与旧 `_cost_of` 的语义逐字一致
    #    （排序之后第一个就是最优的），所以结果不变、只是不再线性扫。
    cost_by: dict[tuple[str, str], float] = {}
    for pid, _conf, cost, pitem in pairs:
        cost_by.setdefault((pid, pitem.bvid), cost)

    assigned: dict[str, tuple[int, float, SourceItem]] = {}
    for live_id, conf, cost, item in pairs:
        if live_id in assigned:
            continue
        if _may_share(item, live_id, assigned, by_id, tolerance_minutes):
            # 中断续播：同一份录播也配给它（见 `_may_share`），但**主选优先**
            assigned[live_id] = (conf, cost, item)
            continue
        if any(it.bvid == item.bvid for _c, _k, it in assigned.values()):
            continue
        assigned[live_id] = (conf, cost, item)

    for live_id in [k for k in assigned]:
        for other_id, oconf, ocost, oitem in pairs:
            if other_id not in assigned or other_id == live_id:
                continue
            my_conf, my_cost, my_item = assigned[live_id]
            if oconf > my_conf:                 # 只换"置信度不更差"的
                continue
            # 我这条给 other、other 那条给我，两边是否都更近（或至少都不更远）
            d_me_other = cost_by.get((other_id, my_item.bvid))
            d_other_me = cost_by.get((live_id, oitem.bvid))
            if d_me_other is None or d_other_me is None:
                continue
            if d_me_other <= ocost and d_other_me <= my_cost and (d_me_other < ocost or d_other_me < my_cost):
                assigned[live_id] = (oconf, d_other_me, oitem)
                assigned[other_id] = (my_conf, d_me_other, my_item)
                break

    # ③ 每个场次的**全部**合法条目（含已分配的）→ 主选 + alternates
    hits_by_session: dict[str, list[tuple[int, float, SourceItem]]] = {}
    for live_id, conf, cost, item in pairs:
        hits_by_session.setdefault(live_id, []).append((conf, cost, item))

    out: list[Match] = []
    for live_id, (conf, cost, primary) in assigned.items():
        row = by_id[live_id]
        # 时间差按**主选那条标题时刻**算（兜底/仅日期没有可比时刻 ⇒ None）
        delta: float | None = None
        if primary.hint is not None and not primary.hint.date_only:
            delta = (primary.hint.at - start_cn[live_id]).total_seconds() / 60.0
        others = [it for _c, _k, it in hits_by_session.get(live_id, [])
                  if it.bvid != primary.bvid]
        out.append(Match(live_id=live_id, start_at=row["start_at"], candidate=primary,
                         confidence=conf, minutes_delta=delta,
                         live_title=row.get("live_title") or row.get("title"),
                         alternates=others))
    out.sort(key=lambda m: (m.confidence, m.start_at))
    return out


def _may_share(item: SourceItem, live_id: str,
               assigned: dict[str, tuple[int, float, SourceItem]],
               by_id: dict[str, dict], tolerance_minutes: int) -> bool:
    """**中断续播**：这条录播能不能也配给 `live_id`（= 同一份录播被两场共用）。

    用户 2026-10-15：「同一场直播被中途切断了，录播就变成了两场，这种情况也要纳入考虑，
    让这两场时间上非常相近的直播合并作为一场直播的录播」。

    实测形态：一场直播中途断了，`live_sessions` 里是**两行**（两个 `live_id`），
    而录播号只发**一条**（标题写的是开播那一刻）。用"一条录播只许配一场"的规则，
    第二段永远配不上 —— 而它其实**就是那一场**的后半段。

    判据（三个都要成立）：
    1. 这条录播**已经**配给了另一场（`owner`），否则走"独占"那条路；
    2. 两场的开播相差 **≤ 时长 + 边距**：录播就是那一场，第二段必然落在它的覆盖区间内；
       时长未知时退回一个保守值（`SHARE_FALLBACK_MINUTES`）；
    3. 两场**都不早于** 8 小时前开始（防跨天串味：隔夜的两场不该共用一份录播）。

    ⚠️ 主选仍然是**配得最准**的那一场（`owner`）—— `assigned` 里先来先占，
    而 `pairs` 已按 `(置信度, 代价)` 排过序，所以先到的那条就是更准的。
    """
    owner = next(((oid, it) for oid, (_c, _k, it) in assigned.items()
                  if it.bvid == item.bvid), None)
    if owner is None:
        return False
    owner_id, owner_item = owner
    me, other = by_id.get(live_id), by_id.get(owner_id)
    if not me or not other:
        return False
    span = owner_item.duration_seconds
    limit = ((span / 60.0) if span else float(SHARE_FALLBACK_MINUTES))
    gap = abs((me["start_at"] - other["start_at"]).total_seconds()) / 60.0
    if gap > limit + tolerance_minutes:
        return False
    # 两场必须落在同一个"夜晚"（8 小时内）—— 否则是隔天的两场，不该共用
    return gap <= 8 * 60


def unmatched_sessions(rows: list[dict], matches: list[Match]) -> list[dict]:
    """没配上的场次（**要有 `live_id`**）—— 就是审查表里"需要手动补"的那一列。"""
    hit = {m.live_id for m in matches}
    return [r for r in rows
            if r.get("live_id") and r.get("start_at")
            and not r.get("vod_url") and str(r["live_id"]) not in hit]
