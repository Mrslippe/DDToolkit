import logging as _logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status

logger = _logging.getLogger(__name__)
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.repositories.vtuber_repo import VTuberRepo, AccountRepo, PostRepo
from app.models.vtuber import VTuber, Post
from app.schemas.vtuber import (
    VTuberOut, VTuberCreate, VTuberUpdate,
    AccountOut, AccountCreate, AccountUpdate,
    PostOut, PostCreate, PostUpdate, PostPage, PostStats,
)
from app.services.scheduler import (
    async_fetch_and_update, async_fetch_vtuber, is_fetch_running,
    async_fetch_posts, async_fetch_all_posts, is_post_fetch_running,
    async_update_unarchived_posts, get_fetch_status, archive_old_posts,
)

router = APIRouter()


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
    return VTuberOut.model_validate(
        VTuberRepo(db).create(data.model_dump()), from_attributes=True
    )


@router.put("/vtuber/{vtuber_id}", response_model=VTuberOut)
def update_vtuber(vtuber_id: int, data: VTuberUpdate, db: Session = Depends(get_db)):
    v = VTuberRepo(db).update(vtuber_id, data.model_dump(exclude_unset=True))
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    return VTuberOut.model_validate(v, from_attributes=True)


@router.delete("/vtuber/{vtuber_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_vtuber(vtuber_id: int, db: Session = Depends(get_db)):
    if not VTuberRepo(db).delete(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")


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
    return AccountOut.model_validate(
        AccountRepo(db).create(vtuber_id, data.model_dump()), from_attributes=True
    )


@router.put("/account/{account_id}", response_model=AccountOut)
def update_account(account_id: int, data: AccountUpdate, db: Session = Depends(get_db)):
    acc = AccountRepo(db).update(account_id, data.model_dump(exclude_unset=True))
    if not acc:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    return AccountOut.model_validate(acc, from_attributes=True)


@router.delete("/account/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(account_id: int, db: Session = Depends(get_db)):
    if not AccountRepo(db).delete(account_id):
        raise HTTPException(404, f"Account id={account_id} 不存在")


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
    db: Session = Depends(get_db),
):
    """服务端分页 + 过滤（type / is_archived），供前端帖子列表使用。"""
    repo = PostRepo(db)
    total, items = repo.paginated(platform, platform_uid, page, page_size,
                                  post_type, is_archived)
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
    return PostOut.model_validate(
        PostRepo(db).create(data.model_dump()), from_attributes=True
    )


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
    if is_fetch_running():
        return {"status": "skipped", "message": "抓取任务正在进行中"}
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
    if is_fetch_running():
        return {"status": "skipped", "message": "抓取任务正在进行中"}
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
async def fetch_posts_by_name(name: str, platform: str = "bilibili",
                              video_pages: int = 3, dynamics_pages: int = 5,
                              db: Session = Depends(get_db)):
    """
    按 VTuber 名字抓取帖子。name 支持模糊匹配。
    video_pages=-1 全量拉取视频，dynamics_pages=-1 全量拉取动态。
    抓取前先执行归档规则刷新 is_archived，使抓取循环的归档边界剪枝
    立即生效——已归档条目不再产生任何网络请求（v0.4.7）。
    示例: POST /vtuber/fetch-posts?name=明前奶绿&video_pages=-1&dynamics_pages=-1
    """
    if is_post_fetch_running():
        return {"status": "skipped", "message": "帖子抓取任务正在进行中"}

    vtubers = db.query(VTuber).filter(VTuber.name.contains(name)).all()
    if not vtubers:
        raise HTTPException(404, f"未找到名字包含 '{name}' 的 VTuber")

    # 前置归档：让 archived_ids 尽量完整，边界后的历史页零请求跳过
    archived_first = archive_old_posts(db=db)

    acc_repo = AccountRepo(db)
    total = {"videos": 0, "dynamics": 0, "stored": 0, "skipped": 0}
    results = []

    for v in vtubers:
        for acc in acc_repo.by_vtuber(v.id):
            if acc.platform == platform and acc.platform_uid:
                r = await async_fetch_posts(int(acc.platform_uid), video_pages, dynamics_pages)
                results.append({"vtuber": v.name, "account": acc.platform_uid,
                                "videos": r.videos, "dynamics": r.dynamics,
                                "stored": r.stored, "skipped": r.skipped})
                for k in ("videos", "dynamics", "stored", "skipped"):
                    total[k] += getattr(r, k)

    return {"status": "done", "archived_first": archived_first,
            "total": total, "details": results}


@router.post("/vtuber/fetch-all-posts")
async def fetch_all_posts():
    """
    对库中所有 VTuber 的 bilibili 账号逐个全量抓取帖子（视频+动态）。
    示例: POST /vtuber/fetch-all-posts
    """
    if is_post_fetch_running():
        return {"status": "skipped", "message": "帖子抓取任务正在进行中"}
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
    if is_post_fetch_running():
        return {"status": "skipped", "message": "帖子抓取任务正在进行中"}
    return await async_update_unarchived_posts(name)
