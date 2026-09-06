import json
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from app.models.vtuber import (VTuber, Account, Post, AccountStatSnapshot,
                               LiveGiftDay, ThirdpartyVtuber, VtuberEvent,
                               LiveSession)


# ── VTuber ─────────────────────────────────────────────────────────

class VTuberRepo:
    def __init__(self, db: Session):
        self.db = db

    def all(self) -> list[VTuber]:
        return self.db.query(VTuber).options(joinedload(VTuber.accounts)).all()

    def get(self, id: int) -> VTuber | None:
        return self.db.query(VTuber).options(joinedload(VTuber.accounts)).filter(VTuber.id == id).first()

    def create(self, data: dict) -> VTuber:
        obj = VTuber(**data)
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def update(self, id: int, data: dict) -> VTuber | None:
        obj = self.get(id)
        if not obj:
            return None
        for k, v in data.items():
            setattr(obj, k, v)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def delete(self, id: int) -> bool:
        obj = self.get(id)
        if not obj:
            return False
        self.db.delete(obj)
        self.db.commit()
        return True


# ── Account ────────────────────────────────────────────────────────

class AccountRepo:
    def __init__(self, db: Session):
        self.db = db

    def by_vtuber(self, vtuber_id: int) -> list[Account]:
        return self.db.query(Account).filter(Account.vtuber_id == vtuber_id).all()

    def get(self, id: int) -> Account | None:
        return self.db.query(Account).filter(Account.id == id).first()

    def create(self, vtuber_id: int, data: dict) -> Account:
        obj = Account(vtuber_id=vtuber_id, **data)
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def update(self, id: int, data: dict) -> Account | None:
        obj = self.get(id)
        if not obj:
            return None
        for k, v in data.items():
            setattr(obj, k, v)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def delete(self, id: int) -> bool:
        obj = self.get(id)
        if not obj:
            return False
        self.db.delete(obj)
        self.db.commit()
        return True

    def all_for_fetch(self, platform: str | None = None) -> list[Account]:
        """返回所有可用于抓取的 Account（有 platform_uid 的）；platform 可选过滤"""
        q = self.db.query(Account).filter(
            Account.platform_uid != None, Account.platform_uid != ""  # noqa: E711
        )
        if platform:
            q = q.filter(Account.platform == platform)
        return q.all()


# ── Account 统计快照（P0，v0.5.0） ─────────────────────────────────

class AccountStatSnapshotRepo:
    """账号统计快照历史：粉丝数/直播状态时间序列（涨粉趋势可视化地基）。

    只负责采集与读取，本期不做可视化（TODO P0 范围）。
    """

    def __init__(self, db: Session):
        self.db = db

    def add(self, account_id: int, followers_count: int | None,
            live_status: int | None = None, live_title: str | None = None,
            captured_at: datetime | None = None) -> AccountStatSnapshot:
        """追加一行快照（调用方随后 commit）。简单优先：全量记录，不降噪。"""
        obj = AccountStatSnapshot(
            account_id=account_id,
            followers_count=followers_count,
            live_status=live_status,
            live_title=live_title,
            captured_at=captured_at or datetime.now(timezone.utc),
        )
        self.db.add(obj)
        return obj

    def recent(self, account_id: int, limit: int = 100,
               source: str | None = None) -> list[AccountStatSnapshot]:
        """按时间倒序取最近 limit 条快照（只读端点备用）。

        source（P4）：None=全部来源；'self'=本工具直采；'zeroroku'=第三方回填。
        """
        q = self.db.query(AccountStatSnapshot).filter(
            AccountStatSnapshot.account_id == account_id
        )
        if source is not None:
            q = q.filter(AccountStatSnapshot.source == source)
        return (
            q.order_by(AccountStatSnapshot.captured_at.desc())
            .limit(limit)
            .all()
        )

    def fan_trend_points(self, account_id: int) -> list[dict]:
        """粉丝趋势点序列（P5）：按天分桶，self 取每日最后一条、zeroroku 全量点。

        返回按时间升序的 [{date, fans, source}]：
        - self 5min 直采高频 → 天末一条（曲线不抖动、载荷可控）
        - zeroroku 第三方回填本就日粒度（稀疏）→ 全量保留（补历史空洞）
        """
        rows = (
            self.db.query(AccountStatSnapshot)
            .filter(
                AccountStatSnapshot.account_id == account_id,
                AccountStatSnapshot.followers_count.isnot(None),
            )
            .order_by(AccountStatSnapshot.captured_at.asc(),
                      AccountStatSnapshot.id.asc())
            .all()
        )
        daily_self: dict[str, tuple[datetime, int]] = {}   # date -> (captured_at, fans)
        points: list[dict] = []
        for r in rows:
            date_str = r.captured_at.strftime("%Y-%m-%d") if r.captured_at else ""
            if not date_str:
                continue
            if r.source == "self":
                cur = daily_self.get(date_str)
                if cur is None or r.captured_at >= cur[0]:
                    daily_self[date_str] = (r.captured_at, int(r.followers_count))
            else:
                points.append({"date": date_str, "fans": int(r.followers_count),
                               "source": r.source})
        for date_str, (_ts, fans) in daily_self.items():
            points.append({"date": date_str, "fans": fans, "source": "self"})
        points.sort(key=lambda p: (p["date"], p["source"]))
        return points

    def live_sessions(self, account_id: int) -> list[dict]:
        """直播场次推导（P5）：self 快照 live_status 转移点 = 场次起止。

        0→1 开场、1→0 收场；进行中的场次（无收场转移）end_at=None。
        5min 粒度近似（数据源即本工具 5 分钟轮询快照，非平台精确起止）。
        P7（v0.7.0）：场次标题 = 场次内最后一条非空 live_title 快照
        （live_title 列本就随快照落库，无需迁移）。
        """
        rows = (
            self.db.query(AccountStatSnapshot.captured_at, AccountStatSnapshot.live_status,
                          AccountStatSnapshot.live_title)
            .filter(
                AccountStatSnapshot.account_id == account_id,
                AccountStatSnapshot.source == "self",
                AccountStatSnapshot.live_status.isnot(None),
            )
            .order_by(AccountStatSnapshot.captured_at.asc(),
                      AccountStatSnapshot.id.asc())
            .all()
        )
        sessions: list[dict] = []
        cur_start: datetime | None = None
        cur_title: str | None = None
        for captured_at, status, title in rows:
            if status == 1 and cur_start is None:
                cur_start = captured_at
                cur_title = title
            elif status == 1:
                if title:
                    cur_title = title
            elif status == 0 and cur_start is not None:
                sessions.append({
                    "start_at": cur_start,
                    "end_at": captured_at,
                    "duration_minutes": int((captured_at - cur_start).total_seconds() // 60),
                    "live_title": cur_title,
                })
                cur_start = None
                cur_title = None
        if cur_start is not None:
            sessions.append({"start_at": cur_start, "end_at": None,
                             "duration_minutes": None, "live_title": cur_title})
        return sessions


# ── 直播场次（v0.9.x 内容管道 M1） ─────────────────────────────────

def _ms_to_utc(ms: int) -> datetime | None:
    """毫秒 epoch → naive UTC datetime（库内时间约定，见 devlog/021）。"""
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).replace(tzinfo=None)
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def _num(v, cast):
    """数值字段容错转换（第三方数据不保证类型）。"""
    try:
        return cast(v) if v is not None else None
    except (TypeError, ValueError):
        return None


# 多源合并时主数据优先级（danmakus 字段最全 → feed 秒级开播 → self 观测兜底）
_SOURCE_PRIORITY = {"danmakus": 3, "feed": 2, "self": 1}


class LiveSessionRepo:
    """直播场次存取与多源合并。

    - 表内：danmakus（M1 回填/同步）/ feed（M3 增量）固定化场次；
    - 读取：merged() = 表内场次 ∪ self 快照推导场次（虚拟，不落表），
      快照场次按 start_at ±90min 窗口与表内场次合并（表内为主数据，
      快照补 end_at/标题，双源并存记 source='xxx+self'）；
    - upsert_danmakus / upsert_feed 是其他数据源的接入接口（回填脚本、
      M3 fetcher 均走这里），用于验证或补充 danmakus 缺失（缺口期/未收录主播）。
    """

    MERGE_WINDOW_MINUTES = 90   # 用户决策（2026-09-07）：±90min 合并窗口

    def __init__(self, db: Session):
        self.db = db

    # ── 写入（其他数据源接入接口） ──

    def _upsert(self, account_id: int, live_id: str, source: str,
                fields: dict) -> bool:
        """按 (account_id, live_id) 幂等 upsert；返回是否新增。"""
        row = (
            self.db.query(LiveSession)
            .filter(LiveSession.account_id == account_id,
                    LiveSession.live_id == live_id)
            .first()
        )
        if row is None:
            self.db.add(LiveSession(account_id=account_id, live_id=live_id,
                                    source=source, **fields))
            return True
        for k, v in fields.items():
            if v is not None:
                setattr(row, k, v)
        return False

    def upsert_danmakus(self, account_id: int, items: list[dict]) -> dict:
        """danmakus 场次批量写入（/api/v2/channel lives 数组，毫秒时间戳）。

        幂等（live_id 唯一）；重跑刷新可变字段（收益/峰值在线等）。
        """
        added = updated = skipped = 0
        for it in items or []:
            live_id = str(it.get("liveId") or "")
            try:
                start_ms = int(it.get("startDate") or 0)
            except (TypeError, ValueError):
                start_ms = 0
            if not live_id or start_ms <= 0:
                skipped += 1
                continue
            start_at = _ms_to_utc(start_ms)
            if start_at is None:
                skipped += 1
                continue
            end_ms = _num(it.get("stopDate"), int) or 0
            fields = {
                "platform": "bilibili",
                "title": str(it.get("title") or "").strip() or None,
                "room_id": str(it.get("roomId") or "") or None,
                "start_at": start_at,
                "end_at": _ms_to_utc(end_ms) if end_ms > 0 else None,
                "parent_area_name": it.get("parentArea"),
                "area_name": it.get("area"),
                "cover_url": it.get("coverUrl"),
                "total_income": _num(it.get("totalIncome"), float),
                "max_online_count": _num(it.get("maxOnlineCount"), int),
                "danmakus_count": _num(it.get("danmakusCount"), int),
                "raw_json": json.dumps(it, ensure_ascii=False, default=str),
            }
            if self._upsert(account_id, live_id, "danmakus", fields):
                added += 1
            else:
                updated += 1
        self.db.commit()
        return {"added": added, "updated": updated, "skipped": skipped}

    def upsert_feed(self, account_id: int, live_id: str, fields: dict) -> bool:
        """B站 live_rcmd 场次接入接口（M3；live_id=B站 live_id 数字串）。

        fields 含 title/start_at/end_at/parent_area_name/area_name/room_id/
        cover_url 等（增量更新用 upsert_feed 可刷新字段）。
        """
        return self._upsert(account_id, live_id, "feed", fields)

    # ── 读取 ──

    def list_by_account(self, account_id: int) -> list[LiveSession]:
        return (
            self.db.query(LiveSession)
            .filter(LiveSession.account_id == account_id)
            .order_by(LiveSession.start_at.asc())
            .all()
        )

    def merged(self, account_id: int) -> list[dict]:
        """多源合并视图（时间升序；字段集见 LiveSessionOut）。

        合并规则（v0.9.x M2，分组式）：
        - 表内场次（danmakus/feed）先分组：同一账号 start_at 相差 ≤90min 的
          视为同一场次（danmakus 与 feed 互为去重/互补——B站 live_id 与
          danmakus uuid 不同键，同一场直播会各有一行）；
        - 分组主数据优先：danmakus > feed（标题/起止/分区/收益以主为准，
          低优源仅补缺失字段）；
        - self 快照推导场次（自观测，不落表）再按 ±90min 并入剩余分组：
          补 end_at（若主缺）/ 标题兜底；未匹配快照 → source='self' 虚拟场次
          （danmakus/feed 均未收录的场次，如 2024 缺口期/未收录主播）。
        """
        table_rows = self.list_by_account(account_id)
        snapshots = AccountStatSnapshotRepo(self.db).live_sessions(account_id)
        window = timedelta(minutes=self.MERGE_WINDOW_MINUTES)

        groups: list[tuple[dict, set[str], str]] = []   # (out, sources, primary)
        for row in table_rows:
            grp = self._find_group(groups, row.start_at, window)
            if grp is None:
                groups.append(self._group_from_row(row))
                continue
            self._merge_row_into_group(grp, row)
        for snap in snapshots:
            grp = self._find_group(groups, snap["start_at"], window)
            if grp is None:
                groups.append(self._group_from_snap(snap))
                continue
            self._merge_snap_into_group(grp, snap)
        out = [g for g, _srcs, _prim in groups]
        out.sort(key=lambda s: s["start_at"])
        return out

    def _find_group(self, groups, start_at: datetime,
                    window: timedelta) -> tuple[dict, set[str], str] | None:
        """找最近（±window 内）分组；贪心按最小 gap。"""
        best, best_gap = None, None
        for grp in groups:
            gap = abs((start_at - grp[0]["start_at"]).total_seconds())
            if gap > window.total_seconds():
                continue
            if best_gap is None or gap < best_gap:
                best, best_gap = grp, gap
        return best

    def _group_from_row(self, row: LiveSession) -> tuple[dict, set[str], str]:
        return self._row_dict(row), {row.source}, row.source

    def _group_from_snap(self, snap: dict) -> tuple[dict, set[str], str]:
        return self._snap_dict(snap), {"self"}, "self"

    def _merge_row_into_group(self, grp: tuple[dict, set[str], str], row: LiveSession) -> None:
        """表内行并入分组：主数据优先（danmakus > feed），低优仅补缺失字段。"""
        g, srcs, primary = grp
        srcs.add(row.source)
        if _SOURCE_PRIORITY.get(row.source, 0) > _SOURCE_PRIORITY.get(primary, 0):
            grp[2] = row.source
            g.update(self._row_dict(row))       # 高优主字段整体替换（含 start/end/标题/分区）
        else:
            if row.title and not g["live_title"]:
                g["live_title"] = row.title
            if row.area_name and not g["area_name"]:
                g["area_name"] = row.area_name
            if row.parent_area_name and not g["parent_area_name"]:
                g["parent_area_name"] = row.parent_area_name
            if row.room_id and not g["room_id"]:
                g["room_id"] = row.room_id
            if row.live_id and not g["live_id"]:
                g["live_id"] = row.live_id
            if row.end_at and not g["end_at"]:
                g["end_at"] = row.end_at
                self._apply_duration(g)
        g["source"] = self._join_sources(srcs)

    def _merge_snap_into_group(self, grp: tuple[dict, set[str], str], snap: dict) -> None:
        """self 快照并入：补 end_at（若主缺）/ 标题兜底；不改主字段。"""
        g, srcs, _primary = grp
        srcs.add("self")
        if snap["end_at"] is not None and g["end_at"] is None:
            g["end_at"] = snap["end_at"]
            self._apply_duration(g)
        if snap["live_title"] and not g["live_title"]:
            g["live_title"] = snap["live_title"]
        g["source"] = self._join_sources(srcs)

    @staticmethod
    def _apply_duration(g: dict) -> None:
        g["duration_minutes"] = int((g["end_at"] - g["start_at"]).total_seconds() // 60) \
            if g["end_at"] else None

    @staticmethod
    def _join_sources(srcs: set[str]) -> str:
        return "+".join(sorted(srcs, key=lambda s: -_SOURCE_PRIORITY.get(s, 0)))

    def _row_dict(self, row: LiveSession) -> dict:
        end_at = row.end_at if row.end_at else None
        return {
            "source": row.source,
            "live_id": row.live_id,
            "room_id": row.room_id,
            "start_at": row.start_at,
            "end_at": end_at,
            "duration_minutes": int((end_at - row.start_at).total_seconds() // 60)
            if end_at else None,
            "live_title": row.title,
            "parent_area_name": row.parent_area_name,
            "area_name": row.area_name,
            "total_income": row.total_income,
            "max_online_count": row.max_online_count,
            "danmakus_count": row.danmakus_count,
        }

    def _snap_dict(self, snap: dict) -> dict:
        return {
            "source": "self",
            "live_id": None,
            "room_id": None,
            "start_at": snap["start_at"],
            "end_at": snap["end_at"],
            "duration_minutes": snap["duration_minutes"],
            "live_title": snap["live_title"],
            "parent_area_name": None,
            "area_name": None,
            "total_income": None,
            "max_online_count": None,
            "danmakus_count": None,
        }


# ── Post ───────────────────────────────────────────────────────────

class PostRepo:
    def __init__(self, db: Session):
        self.db = db

    def by_uid(self, platform: str, platform_uid: str) -> list[Post]:
        return (
            self.db.query(Post)
            .filter(Post.platform == platform, Post.platform_uid == platform_uid)
            .order_by(Post.published_at.desc())
            .all()
        )

    def paginated(self, platform: str, platform_uid: str, page: int = 1,
                  page_size: int = 50, post_type: str | None = None,
                  is_archived: bool | None = None,
                  q: str | None = None,
                  date_from: datetime | None = None,
                  date_to: datetime | None = None,
                  is_deleted: bool | None = None) -> tuple[int, list[Post]]:
        """服务端分页 + 过滤（前端列表用；旧 by_uid 保持兼容）。返回 (total, items)

        q        标题/摘要模糊匹配（OR 语义）
        post_type 逗号分隔多型（如 "video,video_dynamic"）；单值天然兼容
        date_from/date_to 发布时间范围：from 含当天零点起；to 为次日零点排他
                 （即包含结束日全天）；设范围时 published_at 为空的帖子被排除
        is_deleted 墓碑筛选（v0.5.1）：True=仅已删除 False=仅未删除 None=全部
        """
        query = self.db.query(Post).filter(
            Post.platform == platform, Post.platform_uid == platform_uid
        )
        if post_type:
            types = [t.strip() for t in post_type.split(',') if t.strip()]
            if types:
                query = query.filter(Post.type.in_(types))
        if is_archived is not None:
            query = query.filter(Post.is_archived == is_archived)
        if is_deleted is not None:
            query = query.filter(
                Post.deleted_detected_at.isnot(None)
                if is_deleted else Post.deleted_detected_at.is_(None)
            )
        q = (q or "").strip()
        if q:
            kw = f"%{q}%"
            # P2 全文搜索：正文纯文本列纳入 OR 匹配（NULL 列天然不匹配）
            query = query.filter(or_(
                Post.title.ilike(kw),
                Post.summary.ilike(kw),
                Post.body_text.ilike(kw),
            ))
        if date_from is not None:
            query = query.filter(Post.published_at >= date_from)
        if date_to is not None:
            query = query.filter(Post.published_at < date_to)
        total = query.count()
        items = (
            query.order_by(Post.published_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        return total, items

    def stats(self, platform: str, platform_uid: str) -> dict:
        """某账号帖子的统计概览：总数/归档数/删除数/类型分布/时间跨度"""
        q = self.db.query(Post).filter(
            Post.platform == platform, Post.platform_uid == platform_uid
        )
        total = q.count()
        archived = q.filter(Post.is_archived == True).count()  # noqa: E712
        deleted = q.filter(Post.deleted_detected_at.isnot(None)).count()
        by_type = {
            t: n for t, n in q.with_entities(Post.type, func.count(Post.id))
            .group_by(Post.type).all()
        }
        earliest, latest = q.with_entities(
            func.min(Post.published_at), func.max(Post.published_at)
        ).one()
        return {
            "platform": platform,
            "platform_uid": platform_uid,
            "total": total,
            "archived": archived,
            "deleted": deleted,
            "by_type": by_type,
            "earliest": earliest,
            "latest": latest,
        }

    def archive_before(self, cutoff: datetime) -> int:
        """归档规则：published_at 早于 cutoff 的帖子 → is_archived=1（幂等）。返回归档条数。"""
        n = self.db.query(Post).filter(
            Post.is_archived == False,  # noqa: E712
            Post.published_at.isnot(None),
            Post.published_at < cutoff,
        ).update({Post.is_archived: True}, synchronize_session=False)
        self.db.commit()
        return n

    def get(self, id: int) -> Post | None:
        return self.db.query(Post).filter(Post.id == id).first()

    def create(self, data: dict, commit: bool = True) -> Post:
        """新增帖子。commit=False 时仅 add 不提交（批量入库用，见 scheduler._fetch_posts_core）。"""
        obj = Post(**data)
        self.db.add(obj)
        if commit:
            self.db.commit()
            self.db.refresh(obj)
        return obj

    def update(self, id: int, data: dict) -> Post | None:
        obj = self.get(id)
        if not obj:
            return None
        for k, v in data.items():
            setattr(obj, k, v)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def delete(self, id: int) -> bool:
        obj = self.get(id)
        if not obj:
            return False
        self.db.delete(obj)
        self.db.commit()
        return True

    def delete_by_platform_uids(self, platform_uids: list[tuple[str, str]]) -> int:
        """按 (platform, platform_uid) 账号组清空帖子（解订阅用：posts 表独立，无外键联删）。

        修复：原先只按 platform_uid 过滤，同一 V 在 bilibili/youtube 上有相同 UID 时
        会误删另一个平台的帖子；改为平台+UID 组合匹配。
        """
        if not platform_uids:
            return 0
        cond = or_(*[
            (Post.platform == p) & (Post.platform_uid == uid)
            for p, uid in platform_uids
        ])
        n = self.db.query(Post).filter(cond).delete(synchronize_session=False)
        return n


# ── 外部第三方数据（P4） ────────────────────────────────────────────

class LiveGiftDayRepo:
    """直播礼物日聚合读取（写入走 externals 源适配器）。"""

    def __init__(self, db: Session):
        self.db = db

    def list_by_account(self, account_id: int, source: str | None = None,
                        limit: int = 0) -> list[LiveGiftDay]:
        """按日期倒序取某账号礼物聚合；limit=0 全量。"""
        q = self.db.query(LiveGiftDay).filter(LiveGiftDay.account_id == account_id)
        if source is not None:
            q = q.filter(LiveGiftDay.source == source)
        q = q.order_by(LiveGiftDay.gift_date.desc())
        if limit > 0:
            q = q.limit(limit)
        return q.all()


class ThirdpartyVtuberRepo:
    """第三方 VTuber 索引读取（候选池搜索增强 / 企划·公会数据）。"""

    def __init__(self, db: Session):
        self.db = db

    def search(self, kw: str, source: str | None = None, limit: int = 20) -> list[ThirdpartyVtuber]:
        """名称关键词 / uid 前缀匹配（候选池检索用）。"""
        kw = (kw or "").strip()
        if not kw:
            return []
        q = self.db.query(ThirdpartyVtuber).filter(or_(
            ThirdpartyVtuber.name.ilike(f"%{kw}%"),
            ThirdpartyVtuber.platform_uid.like(f"{kw}%"),
        ))
        if source is not None:
            q = q.filter(ThirdpartyVtuber.source == source)
        return q.limit(limit).all()

    def by_uid(self, platform_uid: str, source: str | None = None) -> list[ThirdpartyVtuber]:
        q = self.db.query(ThirdpartyVtuber).filter(
            ThirdpartyVtuber.platform_uid == platform_uid)
        if source is not None:
            q = q.filter(ThirdpartyVtuber.source == source)
        return q.all()


# ── 重要日期·大型活动（P7，v0.7.0） ──────────────────────────────────

_RE_FULL_DT = re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})")
_RE_MM_DT = re.compile(r"(?<!\d)(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?!\d)")
_RE_TODAY = re.compile(r"今天\s+(\d{1,2}):(\d{2})")
_RE_TOMORROW = re.compile(r"明天\s+(\d{1,2}):(\d{2})")


def _parse_reservation_start(pub: datetime | None, desc1: str) -> datetime | None:
    """从 desc1 文本解析预约开始时刻（北京 wall-clock，服务端统一推断年份）。

    实测 desc1 格式：'MM-DD HH:mm 直播'（无年份）、'YYYY-MM-DD HH:mm 直播'、
    '今天 HH:mm 直播'、'明天 HH:mm 直播'、'预约YYYY-MM-DD HH:mm场次'（旧数据）。
    年份推断：无年份时按帖子发布年；若解析结果早于发布日 → 发布年+1 再试。
    解析失败返回 None（safe 降级）。"""
    if not desc1:
        return None
    m = _RE_FULL_DT.search(desc1)
    if m:
        y, mo, d, hh, mi = (int(g) for g in m.groups())
        try:
            return datetime(y, mo, d, hh, mi)
        except ValueError:
            return None
    m = _RE_TODAY.search(desc1)
    if m:
        base = pub or datetime.now()
        hh, mi = int(m.group(1)), int(m.group(2))
        try:
            return datetime(base.year, base.month, base.day, hh, mi)
        except ValueError:
            return None
    m = _RE_TOMORROW.search(desc1)
    if m:
        base = pub or datetime.now()
        hh, mi = int(m.group(1)), int(m.group(2))
        try:
            nd = base + timedelta(days=1)
            return datetime(nd.year, nd.month, nd.day, hh, mi)
        except ValueError:
            return None
    m = _RE_MM_DT.search(desc1)
    if m:
        mo, d, hh, mi = (int(g) for g in m.groups())
        for year_off in (0, 1):
            base_y = (pub or datetime.now()).year + year_off
            try:
                cand = datetime(base_y, mo, d, hh, mi)
            except ValueError:
                continue
            if cand >= (pub or datetime.now()):
                return cand
        try:
            return datetime((pub or datetime.now()).year + 1, mo, d, hh, mi)
        except ValueError:
            return None
    return None


def _reservation_title_reserve(pub: datetime | None, desc1: str,
                               start: datetime | None) -> str:
    """标题降级链：desc1（含日期原文，如 '08-21 20:00 直播'）→ '直播预约'。"""
    return desc1 or ("直播预约" if start else "")


def _normalize_reserve_title(title: str) -> str:
    """预约标题归一化：'直播预约|xxx' → 'xxx'；仅前缀 → 原文去前缀。"""
    title = (title or "").strip()
    if not title:
        return ""
    if "|" in title:
        return title.split("|", 1)[1].strip()
    return title.replace("直播预约", "", 1).strip() if title.startswith("直播预约") else title


class VtuberEventRepo:
    """重要日期·活动手动条目（vtuber_events 表）+ 自动预约帖解析。"""

    def __init__(self, db: Session):
        self.db = db

    # ── 手动条目 CRUD ──

    def list_by_vtuber(self, vtuber_id: int) -> list[VtuberEvent]:
        return (
            self.db.query(VtuberEvent)
            .filter(VtuberEvent.vtuber_id == vtuber_id)
            .order_by(VtuberEvent.event_date.asc(), VtuberEvent.id.asc())
            .all()
        )

    def create(self, vtuber_id: int, title: str, event_date: str) -> VtuberEvent:
        obj = VtuberEvent(vtuber_id=vtuber_id, title=title, event_date=event_date)
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def delete(self, event_id: int) -> bool:
        obj = self.db.query(VtuberEvent).filter(VtuberEvent.id == event_id).first()
        if not obj:
            return False
        self.db.delete(obj)
        self.db.commit()
        return True

    # ── 自动预约帖解析（P7） ──

    def future_reservations(self, vtuber_id: int, now: datetime | None = None,
                            days: int = 90) -> list[dict]:
        """该 V 所有账号的未来直播预约（自动化，来自 reservation 帖）。

        - 源：posts.body_json.reservation（fetcher 已精简），旧帖缺 title →
          回退 raw_json 的 reserve.title（'直播预约|xxx' 去前缀）；
        - 过滤：button_text == '已结束' 剔除；解析时刻 < now 剔除；
          未来超出 days 天剔除（防止陈年旧帖污染卡片）；
        - 返回按 start_at 升序 [{post_id, title, start_at, reserve_total, rid}]。
        """
        now = now or datetime.now()
        uids = [
            a.platform_uid for a in self.db.query(Account).filter(
                Account.vtuber_id == vtuber_id, Account.platform_uid != None,  # noqa: E711
                Account.platform_uid != "",
            ).all()
        ]
        if not uids:
            return []
        rows = (
            self.db.query(Post.id, Post.platform_uid, Post.body_json, Post.raw_json,
                          Post.published_at)
            .filter(
                Post.platform_uid.in_(uids),
                Post.body_json.like("%reservation%"),
            )
            .all()
        )
        out: list[dict] = []
        cut_off = now + timedelta(days=days)
        for post_id, uid, body_json, raw_json, published_at in rows:
            try:
                r = json.loads(body_json).get("reservation") or {}
            except (TypeError, ValueError):
                continue
            if not isinstance(r, dict):
                continue
            if (r.get("button_text") or "").strip() == "已结束":
                continue
            pub = published_at if isinstance(published_at, datetime) else None
            start = _parse_reservation_start(pub, str(r.get("desc1") or ""))
            if start is None:
                continue
            if start < now or start > cut_off:
                continue
            title = _normalize_reserve_title(str(r.get("title") or ""))
            if not title:
                # 回退 raw_json（modules.module_dynamic.additional.reserve.title）
                title = self._raw_reserve_title(raw_json)
            if not title:
                title = _reservation_title_reserve(pub, str(r.get("desc1") or ""), start)
            out.append({
                "post_id": post_id,
                "title": title,
                "start_at": start,
                "reserve_total": int(r.get("reserve_total") or 0),
                "rid": str(r["rid"]) if r.get("rid") else None,
            })
        out.sort(key=lambda x: x["start_at"])
        return out

    @staticmethod
    def _raw_reserve_title(raw_json: str | None) -> str:
        """raw_json（原始动态 JSON）→ reserve.title（'直播预约|xxx' → 去前缀）。"""
        if not raw_json:
            return ""
        try:
            d = json.loads(raw_json)
        except (TypeError, ValueError):
            return ""
        try:
            reserve = d["modules"]["module_dynamic"]["additional"]["reserve"]
        except (KeyError, TypeError):
            return ""
        title = str(reserve.get("title") or "").strip()
        if not title:
            return ""
        # '直播预约|七夕转转转' → '七夕转转转'; 仅前缀情况降级为整个
        if "|" in title:
            return title.split("|", 1)[1].strip()
        return title.replace("直播预约", "", 1).strip()
