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
)
from app.schemas.vtuber import (
    VTuberOut, VTuberCreate, VTuberUpdate,
    AccountOut, AccountCreate, AccountUpdate,
    PostOut, PostCreate, PostUpdate, PostPage, PostStats,
    AccountStatSnapshotOut,
)
from app.services import pool
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
                                db: Session = Depends(get_db)):
    """账号统计快照历史（P0，v0.5.0）：粉丝数/直播状态时间序列，时间倒序。

    本期只读端点备用（不做可视化）；limit 上限 1000。
    """
    if not AccountRepo(db).get(account_id):
        raise HTTPException(404, f"Account id={account_id} 不存在")
    return [
        AccountStatSnapshotOut.model_validate(s, from_attributes=True)
        for s in AccountStatSnapshotRepo(db).recent(account_id, limit)
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
