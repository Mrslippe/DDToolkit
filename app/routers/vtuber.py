import asyncio
import logging
from datetime import date, datetime, timedelta, timezone

from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models.vtuber import VTuber, Post, Account
from app.repositories.vtuber_repo import (
    VTuberRepo, AccountRepo, PostRepo, AccountStatSnapshotRepo,
    LiveGiftDayRepo, ThirdpartyVtuberRepo, VtuberEventRepo, LiveSessionRepo,
    LiveCategoryOverrideRepo,
)
from app.schemas.vtuber import (
    VTuberOut, VTuberCreate, VTuberUpdate,
    AccountOut, AccountCreate, AccountUpdate,
    PostOut, PostCreate, PostUpdate, PostPage, PostStats,
    AccountStatSnapshotOut, LiveGiftDayOut, ThirdpartyVtuberOut,
    FanTrendPoint, LiveSessionOut, LiveCategoryOut, LiveSessionDetailOut,
    VtuberEventOut, VtuberEventCreate, FutureReservationOut,
)
from app.services import pool
from app.services.live_type import (
    infer_category, plan_series, build_learned, EDITABLE_CATEGORY_KEYS,
)
from app.services.externals.danmakus import fetch_live_summary, fetch_live_events
from app.schemas.vtuber import (LiveDanmakuInfo, LiveMetricsOut, LiveEventOut,
                                LiveWordOut)
from app.services.post_text import extract_post_text

logger = logging.getLogger(__name__)

router = APIRouter()

# 冷启动优化：scheduler 依赖链（apscheduler/tenacity/httpx/fetcher）较重，
# 经此包装函数延迟到首次调用才 import。调用点写法不变；测试 monkeypatch
# 直接 setattr 本模块属性即可替换包装函数，行为与直接导入完全一致。
_sch_cache = None


def _sched():
    global _sch_cache
    if _sch_cache is None:
        from app.services import scheduler
        _sch_cache = scheduler
    return _sch_cache


async def async_fetch_and_update():
    return await _sched().async_fetch_and_update()


async def async_fetch_vtuber(vtuber_id: int):
    return await _sched().async_fetch_vtuber(vtuber_id)


def is_fetch_running():
    return _sched().is_fetch_running()


async def async_fetch_posts(platform: str, uid: str, video_pages: int, dynamics_pages: int):
    return await _sched().async_fetch_posts(platform, uid, video_pages, dynamics_pages)


async def async_fetch_all_posts():
    return await _sched().async_fetch_all_posts()


async def async_fetch_vtuber_posts(name: str, platform: str = "bilibili"):
    return await _sched().async_fetch_vtuber_posts(name, platform)


def is_post_fetch_running():
    return _sched().is_post_fetch_running()


def any_fetch_running():
    """全局单飞：账号/帖子任一在跑，或定时任务正请求让位 → 均视为忙。"""
    return _sched().any_fetch_running()


async def async_update_unarchived_posts(name: str | None = None):
    return await _sched().async_update_unarchived_posts(name)


def get_fetch_status():
    return _sched().get_fetch_status()


def archive_old_posts(cutoff_days: int = 30, db=None):
    return _sched().archive_old_posts(cutoff_days, db)


# ── VTuber CRUD ────────────────────────────────────────────────────

@router.get("/vtuber/list", response_model=list[VTuberOut])
def list_vtubers(db: Session = Depends(get_db)):
    return [VTuberOut.model_validate(v, from_attributes=True) for v in VTuberRepo(db).all()]


# 注意：本路由必须注册在 /vtuber/{vtuber_id} 之前，否则会被 int 路径参数捕获并 422
@router.get("/vtuber/fetch-status")
def fetch_status():
    """抓取任务实时状态（TopBar 轮询用）：
    account=账号信息抓取（running/current/index/total），post=帖子抓取（running/target）。"""
    return get_fetch_status()


@router.get("/vtuber/{vtuber_id}", response_model=VTuberOut)
def get_vtuber(vtuber_id: int, db: Session = Depends(get_db)):
    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    return VTuberOut.model_validate(v, from_attributes=True)


@router.post("/vtuber", response_model=VTuberOut, status_code=status.HTTP_201_CREATED)
def create_vtuber(data: VTuberCreate, db: Session = Depends(get_db)):
    try:
        v = VTuberRepo(db).create(data.model_dump())
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "创建失败：数据违反唯一约束")
    return VTuberOut.model_validate(v, from_attributes=True)


@router.put("/vtuber/{vtuber_id}", response_model=VTuberOut)
def update_vtuber(vtuber_id: int, data: VTuberUpdate, db: Session = Depends(get_db)):
    v = VTuberRepo(db).update(vtuber_id, data.model_dump(exclude_unset=True))
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    return VTuberOut.model_validate(v, from_attributes=True)


CONTENT_TYPE_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}


@router.post("/vtuber/{vtuber_id}/background", response_model=VTuberOut)
async def set_vtuber_background(
    vtuber_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """上传卡片页自定义背景：时间戳后缀防 WebView 缓存，替换时删旧文件。"""
    import time as _time

    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    ext = CONTENT_TYPE_EXT.get(file.content_type or "")
    if not ext:
        raise HTTPException(415, "仅支持 jpeg / png / webp / gif 图片")
    data = await file.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, "图片超过 10MB 限制")
    custom_dir = settings.DATA_DIR / "static" / "custom_bg"
    custom_dir.mkdir(parents=True, exist_ok=True)
    if v.background_path:
        (custom_dir / Path(v.background_path).name).unlink(missing_ok=True)
    name = f"{vtuber_id}_{int(_time.time() * 1000)}.{ext}"
    (custom_dir / name).write_bytes(data)
    v.background_path = f"static/custom_bg/{name}"
    db.add(v)
    db.commit()
    db.refresh(v)
    return VTuberOut.model_validate(v, from_attributes=True)


@router.delete("/vtuber/{vtuber_id}/background", response_model=VTuberOut)
def clear_vtuber_background(vtuber_id: int, db: Session = Depends(get_db)):
    """清除自定义背景，回退到头像铺底。"""
    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    if v.background_path:
        custom_dir = settings.DATA_DIR / "static" / "custom_bg"
        (custom_dir / Path(v.background_path).name).unlink(missing_ok=True)
        v.background_path = None
        db.add(v)
        db.commit()
        db.refresh(v)
    return VTuberOut.model_validate(v, from_attributes=True)


@router.delete("/vtuber/{vtuber_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_vtuber(vtuber_id: int, db: Session = Depends(get_db)):
    """解除订阅：删除 VTuber（accounts 级联）+ 连带清除其全部帖子记录。
    posts 表独立无外键，需按账号 uid 显式清理，避免孤儿数据。"""
    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")

    uids = [(a.platform, a.platform_uid) for a in v.accounts if a.platform_uid]
    n_posts = PostRepo(db).delete_by_platform_uids(uids)
    logger.info(f"解除订阅 VTuber#{vtuber_id} ({v.name})：连带清除帖子 {n_posts} 条")
    VTuberRepo(db).delete(vtuber_id)


# ── Account CRUD ───────────────────────────────────────────────────

@router.get("/vtuber/{vtuber_id}/accounts", response_model=list[AccountOut])
def list_accounts(vtuber_id: int, db: Session = Depends(get_db)):
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    return [
        AccountOut.model_validate(a, from_attributes=True)
        for a in AccountRepo(db).by_vtuber(vtuber_id)
    ]


@router.post("/vtuber/{vtuber_id}/accounts", response_model=AccountOut, status_code=status.HTTP_201_CREATED)
def create_account(vtuber_id: int, data: AccountCreate, db: Session = Depends(get_db)):
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    try:
        acc = AccountRepo(db).create(vtuber_id, data.model_dump())
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"该 (platform, platform_uid) 账号已存在")
    return AccountOut.model_validate(acc, from_attributes=True)


@router.put("/account/{account_id}", response_model=AccountOut)
def update_account(account_id: int, data: AccountUpdate, db: Session = Depends(get_db)):
    try:
        acc = AccountRepo(db).update(account_id, data.model_dump(exclude_unset=True))
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "该 (platform, platform_uid) 账号已存在")
    if not acc:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    return AccountOut.model_validate(acc, from_attributes=True)


@router.delete("/account/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(account_id: int, db: Session = Depends(get_db)):
    """删除账号并同步清理其帖子（修复：原来只删 account，帖子成孤儿数据）。"""
    repo = AccountRepo(db)
    acc = repo.get(account_id)
    if not acc:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    if acc.platform_uid:
        n_posts = PostRepo(db).delete_by_platform_uids([(acc.platform, acc.platform_uid)])
        logger.info(f"删除 Account#{account_id} ({acc.platform}:{acc.platform_uid})：连带清除帖子 {n_posts} 条")
    repo.delete(account_id)


@router.get("/account/{account_id}/stat-snapshots", response_model=list[AccountStatSnapshotOut])
def list_account_stat_snapshots(account_id: int, limit: int = Query(100, ge=1, le=1000),
                                source: str | None = Query(None),
                                db: Session = Depends(get_db)):
    """账号统计快照历史（P0，v0.5.0）：粉丝数/直播状态时间序列，时间倒序。

    本期只读端点备用（不做可视化）；limit 上限 1000。
    source（P4）：None=全部；'self'=本工具直采；'zeroroku'=第三方回填。
    """
    if not AccountRepo(db).get(account_id):
        raise HTTPException(404, f"Account id={account_id} 不存在")
    return [
        AccountStatSnapshotOut.model_validate(s, from_attributes=True)
        for s in AccountStatSnapshotRepo(db).recent(account_id, limit, source)
    ]


@router.get("/account/{account_id}/gift-days", response_model=list[LiveGiftDayOut])
def list_live_gift_days(account_id: int, limit: int = Query(0, ge=0),
                        source: str | None = Query(None),
                        db: Session = Depends(get_db)):
    """直播礼物日聚合（P4：zeroroku 等第三方固定化数据），日期倒序。

    金额为原始字符串（站点返回小数串，保精度）；limit=0 全量。
    """
    if not AccountRepo(db).get(account_id):
        raise HTTPException(404, f"Account id={account_id} 不存在")
    return [
        LiveGiftDayOut.model_validate(g, from_attributes=True)
        for g in LiveGiftDayRepo(db).list_by_account(account_id, source, limit)
    ]


@router.get("/account/{account_id}/fan-trend", response_model=list[FanTrendPoint])
def fan_trend(account_id: int, db: Session = Depends(get_db)):
    """粉丝趋势点序列（P5）：按天分桶降采样，图表直用。

    self 直采 5min 高频 → 天末一条；zeroroku 回填日粒度全量保留（补历史空洞）。
    返回未排序语义 = 时间升序，前端按 source 分线绘制。
    """
    if not AccountRepo(db).get(account_id):
        raise HTTPException(404, f"Account id={account_id} 不存在")
    return [FanTrendPoint(**p) for p in AccountStatSnapshotRepo(db).fan_trend_points(account_id)]


def _live_infer_ctx(db: Session, account_id: int):
    """场次推断上下文（列表端/详情端共用）：账号/vtuber/事件/校正。"""
    account = AccountRepo(db).get(account_id)
    vtuber = account.vtuber if account else None
    events = VtuberEventRepo(db).list_by_vtuber(vtuber.id) if vtuber else []
    overrides = LiveCategoryOverrideRepo(db).map_by_account(account_id)
    return account, vtuber, [e.event_date for e in events], overrides


@router.get("/account/{account_id}/live-sessions", response_model=list[LiveSessionOut])
def live_sessions(account_id: int, db: Session = Depends(get_db)):
    """直播场次（v0.9.x 内容管道 M1 主源 + v2 多信号类型推断）。

    - 表内场次（danmakus 历史全量，M1 回填；feed M3 增量）
    - self 快照推导场次（5min 粒度，自观测兜底，±90min 窗口合并）
    - 每场附带类型推断（v2 信号栈，读取时计算）：
      override（用户校正）> series（系列聚类）> title（多词评分）>
      learned（校正反哺词库）> area（分区）> date（纪念日）> fallback
    """
    account, vtuber, event_dates, overrides = _live_infer_ctx(db, account_id)
    if not account:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    sessions = LiveSessionRepo(db).merged(account_id)
    series_categories = plan_series(sessions, overrides)
    learned = build_learned(overrides, sessions)
    out = []
    for s in sessions:
        category, category_from = infer_category(
            s["live_title"], s.get("area_name"), s.get("parent_area_name"),
            s["start_at"],
            birthday=vtuber.birthday if vtuber else None,
            debut_date=vtuber.debut_date if vtuber else None,
            event_dates=event_dates,
            live_id=s.get("live_id"), overrides=overrides,
            series_categories=series_categories, learned=learned,
        )
        out.append(LiveSessionOut(account_id=account_id, **s,
                                  category=category, category_from=category_from))
    return out


@router.get("/account/{account_id}/live-sessions/{live_id}",
            response_model=LiveSessionDetailOut)
async def live_session_detail(account_id: int, live_id: str,
                              db: Session = Depends(get_db)):
    """单场次详情（user 2026-09-07：点击日期格 → 独立详情弹窗）。

    与列表端同链路（merged + v2 信号栈）；附预留字段 danmaku（弹幕信息）/
    analysis（内容分析）——弹幕数据已接入（danmakus 公开端点
    /api/v2/live?liveId=&includeExtra=，免鉴权实测：弹幕总数 + 词云），
    分析服务仍预留；网络失败降级为 None。
    """
    account, vtuber, event_dates, overrides = _live_infer_ctx(db, account_id)
    if not account:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    sessions = LiveSessionRepo(db).merged(account_id)
    s = next((x for x in sessions if x.get("live_id") == live_id), None)
    if s is None:
        raise HTTPException(404, f"LiveSession live_id={live_id} 不存在")
    series_categories = plan_series(sessions, overrides)
    learned = build_learned(overrides, sessions)
    category, category_from = infer_category(
        s["live_title"], s.get("area_name"), s.get("parent_area_name"),
        s["start_at"],
        birthday=vtuber.birthday if vtuber else None,
        debut_date=vtuber.debut_date if vtuber else None,
        event_dates=event_dates,
        live_id=live_id, overrides=overrides,
        series_categories=series_categories, learned=learned,
    )
    danmaku = None
    metrics = None
    events: list[LiveEventOut] = []
    if "danmakus" in (s.get("source") or "").split("+"):
        summary, evts = await asyncio.gather(
            fetch_live_summary(live_id), fetch_live_events(live_id))
        if summary:
            danmaku = LiveDanmakuInfo(
                total=summary.get("total"),
                top_keywords=[w for w, _c in (summary.get("word_cloud") or [])][:40],
                top_words=[LiveWordOut(text=w, count=int(c))
                           for w, c in (summary.get("word_cloud") or [])][:40],
            )
            metrics = LiveMetricsOut(
                watch_count=summary.get("watch_count"),
                like_count=summary.get("like_count"),
                pay_count=summary.get("pay_count"),
                interaction_count=summary.get("interaction_count"),
                online_rank=summary.get("online_rank"),
                comment_count=summary.get("comment_count"),
                is_full=summary.get("is_full"),
                is_merged=summary.get("is_merged"),
                peaks=summary.get("peaks") or [],
                versions=summary.get("versions") or [],
                channel=summary.get("channel") or {},
            )
        for ev in evts or []:
            sd = ev.get("send_date_ms")
            events.append(LiveEventOut(
                type=int(ev.get("type") or 0),
                send_date=datetime.fromtimestamp(sd / 1000, tz=timezone.utc)
                .replace(tzinfo=None) if sd else None,
            ))
    return LiveSessionDetailOut(account_id=account_id, **s,
                                category=category, category_from=category_from,
                                danmaku=danmaku, metrics=metrics, events=events)


class LiveCategoryUpdate(BaseModel):
    category: str


@router.put("/account/{account_id}/live-sessions/{live_id}/category",
            response_model=LiveCategoryOut)
def set_live_category(account_id: int, live_id: str, data: LiveCategoryUpdate,
                      db: Session = Depends(get_db)):
    """用户校正场次分类（v0.9.x 类型引擎 v2 第⑦信号）。

    - 校正最高优先级（override 源）；同时反哺账号词库（learned）
      与系列聚类投票（series 传播），下次 GET live-sessions 全链生效；
    - 仅 9 类可校正（不含 live 兜底）；仅表内场次（self 虚拟场次无 live_id）。
    """
    if not AccountRepo(db).get(account_id):
        raise HTTPException(404, f"Account id={account_id} 不存在")
    if data.category not in EDITABLE_CATEGORY_KEYS:
        raise HTTPException(422, detail=f"不支持的分类: {data.category}（可用: "
                                       f"{', '.join(sorted(EDITABLE_CATEGORY_KEYS))}）")
    LiveCategoryOverrideRepo(db).upsert(account_id, live_id, data.category)
    return LiveCategoryOut(category=data.category, category_from="override")


@router.delete("/account/{account_id}/live-sessions/{live_id}/category",
               status_code=status.HTTP_204_NO_CONTENT)
def clear_live_category(account_id: int, live_id: str, db: Session = Depends(get_db)):
    """撤除场次分类校正，恢复自动推断。"""
    if not AccountRepo(db).get(account_id):
        raise HTTPException(404, f"Account id={account_id} 不存在")
    if not LiveCategoryOverrideRepo(db).delete(account_id, live_id):
        raise HTTPException(404, f"无校正记录: live_id={live_id}")


# ── 重要日期·大型活动（P7，v0.7.0） ────────────────────────────────

@router.get("/vtuber/{vtuber_id}/events", response_model=list[VtuberEventOut])
def list_vtuber_events(vtuber_id: int, db: Session = Depends(get_db)):
    """手动维护的重要日期/活动条目（vtuber_events），按日期升序。"""
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    return [
        VtuberEventOut.model_validate(e, from_attributes=True)
        for e in VtuberEventRepo(db).list_by_vtuber(vtuber_id)
    ]


@router.post("/vtuber/{vtuber_id}/events", response_model=VtuberEventOut,
             status_code=status.HTTP_201_CREATED)
def create_vtuber_event(vtuber_id: int, data: VtuberEventCreate,
                        db: Session = Depends(get_db)):
    """手动添加重要日期/活动条目（卡片内「添加活动」入口）。"""
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    e = VtuberEventRepo(db).create(vtuber_id, data.title, data.event_date)
    return VtuberEventOut.model_validate(e, from_attributes=True)


@router.delete("/vtuber/event/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_vtuber_event(event_id: int, db: Session = Depends(get_db)):
    """删除手动条目。"""
    if not VtuberEventRepo(db).delete(event_id):
        raise HTTPException(404, f"Event id={event_id} 不存在")


@router.get("/vtuber/{vtuber_id}/future-reservations",
            response_model=list[FutureReservationOut])
def future_reservations(vtuber_id: int, days: int = Query(90, ge=1, le=365),
                        db: Session = Depends(get_db)):
    """未来直播预约（自动化，来自 reservation 帖 desc1 文本解析）。

    过滤：button_text=已结束 / 时刻已过 / 超出未来 days 天；按开始时间升序。
    start_at 为服务端推断的北京 wall-clock（naive，无时区语义）。
    """
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    return [
        FutureReservationOut(**r)
        for r in VtuberEventRepo(db).future_reservations(vtuber_id, days=days)
    ]


@router.get("/externals/vtubers/by-uid", response_model=list[ThirdpartyVtuberOut])
def externals_vtuber_by_uid(uid: str, source: str | None = Query(None),
                            db: Session = Depends(get_db)):
    """第三方 VTuber 索引精确查询（P5 档案卡：企划/公会/房间号）。"""
    return [
        ThirdpartyVtuberOut.model_validate(v, from_attributes=True)
        for v in ThirdpartyVtuberRepo(db).by_uid(uid, source)
    ]


@router.get("/externals/vtubers", response_model=list[ThirdpartyVtuberOut])
def search_externals_vtubers(kw: str, source: str | None = Query(None),
                             db: Session = Depends(get_db)):
    """第三方 VTuber 索引检索（P4：danmakus vup-list / laplace vup-slim）。

    名称关键词 / uid 前缀匹配；企划（group_name）、房间号随条目返回。
    """
    return [
        ThirdpartyVtuberOut.model_validate(v, from_attributes=True)
        for v in ThirdpartyVtuberRepo(db).search(kw, source)
    ]


# ── Post CRUD ──────────────────────────────────────────────────────

@router.get("/posts/{platform}/{platform_uid}", response_model=list[PostOut])
def list_posts(platform: str, platform_uid: str, db: Session = Depends(get_db)):
    return [
        PostOut.model_validate(p, from_attributes=True)
        for p in PostRepo(db).by_uid(platform, platform_uid)
    ]


@router.get("/posts/{platform}/{platform_uid}/paginated", response_model=PostPage)
def list_posts_paginated(
    platform: str,
    platform_uid: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    post_type: str | None = Query(None, alias="type"),
    is_archived: bool | None = None,
    is_deleted: bool | None = None,
    q: str | None = Query(None, max_length=100),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    db: Session = Depends(get_db),
):
    """服务端分页 + 过滤（type / is_archived / is_deleted / q 搜索 / 发布时间范围）。
    date_to 为排他次日零点换算，包含结束日全天。"""
    repo = PostRepo(db)
    # 库内 published_at 为 naive UTC 字符串：比较参数须同为 naive
    date_from_dt = (
        datetime.combine(date_from, datetime.min.time()) if date_from else None
    )
    date_to_dt = (
        datetime.combine(date_to, datetime.min.time()) + timedelta(days=1) if date_to else None
    )
    total, items = repo.paginated(platform, platform_uid, page, page_size,
                                  post_type, is_archived, q,
                                  date_from_dt, date_to_dt, is_deleted)
    return PostPage(
        items=[PostOut.model_validate(p, from_attributes=True) for p in items],
        total=total, page=page, page_size=page_size,
    )


@router.get("/posts/{platform}/{platform_uid}/stats", response_model=PostStats)
def post_stats(platform: str, platform_uid: str, db: Session = Depends(get_db)):
    """某账号帖子统计概览（总数/归档/类型分布/时间跨度），供前端统计卡片使用。"""
    return PostStats(**PostRepo(db).stats(platform, platform_uid))


@router.post("/posts", response_model=PostOut, status_code=status.HTTP_201_CREATED)
def create_post(data: PostCreate, db: Session = Depends(get_db)):
    # P2 全文搜索：body_text 永远由后端从 body_json 派生，不接受客户端传入
    payload = data.model_dump()
    payload["body_text"] = extract_post_text(payload.get("body_json"))
    try:
        p = PostRepo(db).create(payload)
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "该 (platform, platform_uid, platform_post_id) 帖子已存在")
    return PostOut.model_validate(p, from_attributes=True)


@router.put("/post/{post_id}", response_model=PostOut)
def update_post(post_id: int, data: PostUpdate, db: Session = Depends(get_db)):
    p = PostRepo(db).update(post_id, data.model_dump(exclude_unset=True))
    if not p:
        raise HTTPException(404, f"Post id={post_id} 不存在")
    return PostOut.model_validate(p, from_attributes=True)


@router.delete("/post/{post_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_post(post_id: int, db: Session = Depends(get_db)):
    if not PostRepo(db).delete(post_id):
        raise HTTPException(404, f"Post id={post_id} 不存在")


# ── Fetch ──────────────────────────────────────────────────────────

@router.api_route("/vtuber/fetch", methods=["GET", "POST"])
async def manual_fetch():
    if any_fetch_running():
        return {"status": "skipped", "message": "已有抓取任务正在进行中，请稍后再试"}
    result = await async_fetch_and_update()
    return {
        "status": "done",
        "message": f"成功 {result.success}, 失败 {result.failed}, 跳过 {result.skipped}",
        "result": {
            "success": result.success,
            "failed": result.failed,
            "skipped": result.skipped,
            "details": result.details,
        },
    }


@router.api_route("/vtuber/{vtuber_id}/fetch", methods=["GET", "POST"])
async def fetch_vtuber(vtuber_id: int, db: Session = Depends(get_db)):
    """抓取单个 VTuber 的账号信息（devlog/017）。与全局抓取互斥。"""
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    if any_fetch_running():
        return {"status": "skipped", "message": "已有抓取任务正在进行中，请稍后再试"}
    result = await async_fetch_vtuber(vtuber_id)
    return {
        "status": "done",
        "message": f"成功 {result.success}, 失败 {result.failed}, 跳过 {result.skipped}",
        "result": {
            "success": result.success,
            "failed": result.failed,
            "skipped": result.skipped,
            "details": result.details,
        },
    }


# ── Fetch Posts ─────────────────────────────────────────────────────

@router.post("/vtuber/fetch-posts")
async def fetch_posts_by_name(name: str, background: BackgroundTasks,
                              platform: str = "bilibili",
                              video_pages: int = 3, dynamics_pages: int = 5,
                              full: bool = False,
                              db: Session = Depends(get_db)):
    """
    按 VTuber 名字抓取帖子。name 支持模糊匹配。
    video_pages=-1 全量拉取视频，dynamics_pages=-1 全量拉取动态。
    full=true → 后台全量（视频+动态 -1/-1 拉到底，任务立即返回，
              进度经 /vtuber/fetch-status 的 post.target 轮询可见）。
    抓取前先执行归档规则刷新 is_archived，使抓取循环的归档边界剪枝
    立即生效——已归档条目不再产生任何网络请求（v0.4.7）。
    示例: POST /vtuber/fetch-posts?name=明前奶绿&video_pages=-1&dynamics_pages=-1
          POST /vtuber/fetch-posts?name=明前奶绿&full=true
    """
    if full:
        if any_fetch_running():
            raise HTTPException(409, "已有抓取任务正在进行中，请稍后再试")
        vtubers = db.query(VTuber).filter(VTuber.name.contains(name)).all()
        if not vtubers:
            raise HTTPException(404, f"未找到名字包含 '{name}' 的 VTuber")
        background.add_task(async_fetch_vtuber_posts, name, platform)
        return {"status": "started", "message": "全量帖子抓取已开始（后台执行，进度见顶栏）"}

    if any_fetch_running():
        return {"status": "skipped", "message": "已有抓取任务正在进行中，请稍后再试"}

    vtubers = db.query(VTuber).filter(VTuber.name.contains(name)).all()
    if not vtubers:
        raise HTTPException(404, f"未找到名字包含 '{name}' 的 VTuber")

    # 前置归档：让 archived_ids 尽量完整，边界后的历史页零请求跳过
    archived_first = archive_old_posts(db=db)

    acc_repo = AccountRepo(db)
    total = {"videos": 0, "dynamics": 0, "stored": 0, "skipped": 0}
    total_rl = False   # 任一账号触发风控提前结束 → 置位，前端提示（B）
    total_vm = 0       # 视频缺失估计（方案 2：参考总数 - 本轮已覆盖）
    results = []

    for v in vtubers:
        for acc in acc_repo.by_vtuber(v.id):
            if acc.platform == platform and acc.platform_uid and acc.platform_uid.isdigit():
                r = await async_fetch_posts(acc.platform, acc.platform_uid, video_pages, dynamics_pages)
                vm = None
                if r.video_total is not None and r.stop_reason in ("rate_limited", "network_error"):
                    vm = max(0, r.video_total - r.videos)
                    total_vm += vm
                results.append({"vtuber": v.name, "platform": acc.platform,
                                "account": acc.platform_uid,
                                "videos": r.videos, "dynamics": r.dynamics,
                                "stored": r.stored, "skipped": r.skipped,
                                "rate_limited": r.rate_limited,
                                "stop_reason": r.stop_reason, "video_missing": vm})
                total_rl = total_rl or r.rate_limited
                for k in ("videos", "dynamics", "stored", "skipped"):
                    total[k] += getattr(r, k)

    return {"status": "done", "archived_first": archived_first,
            "total": total, "details": results,
            "rate_limited": total_rl, "video_missing": total_vm or None}


@router.post("/vtuber/fetch-all-posts")
async def fetch_all_posts():
    """
    对库中所有 VTuber 的 bilibili 账号逐个全量抓取帖子（视频+动态）。
    示例: POST /vtuber/fetch-all-posts
    """
    if any_fetch_running():
        return {"status": "skipped", "message": "已有抓取任务正在进行中，请稍后再试"}
    return await async_fetch_all_posts()


# ── 归档规则 + 未归档动态更新（devlog/016） ────────────────────────────

@router.post("/posts/archive")
def archive_posts(days: int = Query(30, ge=1), db: Session = Depends(get_db)):
    """
    归档规则：published_at 早于 days 天前（默认 30 天）的帖子 → is_archived=1。
    幂等；published_at 为空的帖子不参与。归档后的帖子不再参与更新抓取遍历。
    示例: POST /posts/archive?days=30
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    n = PostRepo(db).archive_before(cutoff)
    unarchived = db.query(Post).filter(Post.is_archived == False).count()  # noqa: E712
    return {
        "status": "done",
        "archived": n,
        "cutoff": cutoff.isoformat(),
        "unarchived_total": unarchived,
    }


@router.post("/vtuber/update-posts")
async def update_unarchived_posts(name: str | None = None):
    """
    更新未归档动态贴文（先归档旧帖，再抓取动态，遍历到归档边界即停）：
    1. 执行归档规则（早于 30 天前的帖子 → is_archived=1）；
    2. 抓取目标账号的动态（视频不抓），整页已归档即停止翻页。
    name 省略 → 全部 bilibili 账号；name 支持模糊匹配。
    示例: POST /vtuber/update-posts?name=明前奶绿   |   POST /vtuber/update-posts
    """
    if any_fetch_running():
        return {"status": "skipped", "message": "已有抓取任务正在进行中，请稍后再试"}
    return await async_update_unarchived_posts(name)


# ── 候选池 + 添加 VTuber（v0.5：csv 降级为离线索引，启动不再导入） ──────

class AdoptRequest(BaseModel):
    platform: str = "bilibili"
    platform_uid: str
    faction: str | None = None


async def _fetch_adopted(vtuber_id: int) -> None:
    """BackgroundTasks 回调：响应送达后在事件循环上执行单V账号抓取。"""
    await async_fetch_vtuber(vtuber_id)


@router.get("/vtuber/pool/search")
def search_pool(kw: str, db: Session = Depends(get_db)):
    """候选池检索：本地 csv 索引按 名称关键词/uid前缀 匹配，
    自动剔除已入库账号。示例: GET /vtuber/pool/search?kw=塔菲"""
    kw = (kw or "").strip()
    if not kw:
        return []
    hits = pool.search_pool(kw, limit=20)
    existing = {
        (a.platform, a.platform_uid)
        for a in db.query(Account.platform, Account.platform_uid).all()
    }
    return [h for h in hits if (h["platform"], h["platform_uid"]) not in existing]


@router.post("/vtuber/adopt", response_model=VTuberOut, status_code=status.HTTP_201_CREATED)
def adopt_vtuber(data: AdoptRequest, background: BackgroundTasks, db: Session = Depends(get_db)):
    """从候选池收录 VTuber：建库后立即调度该 V 的账号信息抓取。
    仅接受池内存在的 (platform, platform_uid)，名称以池为准防伪造。

    注意：本端点为同步函数（线程池执行），抓取调度必须走 BackgroundTasks
    ——直接 asyncio.create_task 会因工作线程无事件循环抛 RuntimeError，
    造成「数据已入库但响应 500、抓取未启动」的双重故障（v0.5 实测）。"""
    hit = pool.find_in_pool(data.platform, data.platform_uid)
    if not hit:
        raise HTTPException(404, "候选池中不存在该 platform_uid，请先在添加浮窗中检索选择")

    exists = db.query(Account).filter(
        Account.platform == data.platform,
        Account.platform_uid == data.platform_uid,
    ).first()
    if exists:
        raise HTTPException(409, f"该账号已入库（VTuber#{exists.vtuber_id}）")

    vtuber = VTuber(name=hit["name"], faction=data.faction)
    db.add(vtuber)
    db.flush()
    acc = Account(
        vtuber_id=vtuber.id,
        platform=data.platform,
        platform_uid=data.platform_uid,
        display_name=hit["name"],
    )
    db.add(acc)
    try:
        db.commit()
    except IntegrityError:
        # 并发收录竞态：exists 检查后另一请求先插入，撞唯一约束 → 409 而非 500
        db.rollback()
        raise HTTPException(409, f"该账号已入库（并发收录冲突）") from None
    db.refresh(vtuber)

    # 响应送达后由事件循环执行（BackgroundTasks 原生支持异步回调）
    background.add_task(_fetch_adopted, vtuber.id)
    return VTuberOut.model_validate(vtuber, from_attributes=True)


@router.post("/vtuber/fetch-accounts")
async def batch_fetch_accounts(background: BackgroundTasks):
    """批量任务：全量抓取所有 VTuber 的账号信息（后台执行，立即返回）。"""
    if any_fetch_running():
        raise HTTPException(409, "已有抓取任务正在进行中，请稍后再试")
    background.add_task(async_fetch_and_update)
    return {"status": "started"}


@router.post("/vtuber/batch/fetch-all-posts")
async def batch_fetch_all_posts(background: BackgroundTasks):
    if any_fetch_running():
        raise HTTPException(409, "已有抓取任务正在进行中，请稍后再试")
    background.add_task(async_fetch_all_posts)
    return {"status": "started"}


@router.post("/vtuber/batch/update-unarchived")
async def batch_update_unarchived(background: BackgroundTasks):
    if any_fetch_running():
        raise HTTPException(409, "已有抓取任务正在进行中，请稍后再试")
    background.add_task(async_update_unarchived_posts)
    return {"status": "started"}


@router.post("/vtuber/batch/archive")
def batch_archive(days: int = Query(30, ge=1), db: Session = Depends(get_db)):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    n = PostRepo(db).archive_before(cutoff)
    return {"status": "done", "archived": n}
