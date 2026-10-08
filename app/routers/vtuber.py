import asyncio
import json
import logging
from datetime import date, datetime, timedelta, timezone

from pathlib import Path

from fastapi import (APIRouter, BackgroundTasks, Depends, File, Header, HTTPException,
                     Query, UploadFile, status)
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.domain.live_manual import (VodUrlError, is_manual_source, normalize_vod,
                                    to_utc_naive)
from app.models.vtuber import EVENT_KINDS, VTuber, Post, Account
from app.repositories.vtuber_repo import (
    VTuberRepo, AccountRepo, PostRepo, AccountStatSnapshotRepo,
    LiveGiftDayRepo, ThirdpartyVtuberRepo, VtuberEventRepo, LiveSessionRepo,
    LiveCategoryOverrideRepo, ProfileCardRepo,
)
from app.schemas.vtuber import (
    VTuberOut, VTuberCreate, VTuberUpdate,
    AccountOut, AccountCreate, AccountUpdate,
    PostOut, PostCreate, PostUpdate, PostPage, PostStats,
    AccountStatSnapshotOut, LiveGiftDayOut, ThirdpartyVtuberOut,
    FanTrendPoint, LiveSessionOut, LiveCategoryOut, LiveSessionDetailOut,
    LiveSessionManualIn, LiveSessionUpdateIn, LiveSessionDeleteOut,
    VtuberEventOut, VtuberEventCreate, VtuberEventUpdate, FutureReservationOut,
    ProfileCardOut, ProfileLayoutIn,
    FormerValueOut, VTuberFormerValuesOut,
    VtuberAvatarVersionOut, VTuberAvatarsOut,
    NoticeOut, NoticesOut, NoticeAckIn, NoticeAckOut,
    BiliSearchOut, BiliSearchItemOut,
)
from app.services import pool
from app.services import bili_search as bili_search_svc
from app.services import capabilities
from app.services.platforms import registry
from app.services.purge import purge_account, purge_vtuber
from app.services.live_type import (
    infer_category, plan_series, build_learned, EDITABLE_CATEGORY_KEYS,
)
from app.services.live_upstream import (LOOKUP_FAILED, LOOKUP_RECORDED,
                                        ensure_session_recorded,
                                        has_danmakus_source, load_live_upstream)
from app.services.danmaku_cloud import build_word_cloud
from app.services.danmaku_words import build_extra_words
from app.services.vtuber_history import former_values
from app.services.vtuber_avatars import avatar_versions, local_avatar_map
from app.services import assets
from app.services import notices as notices_service
from app.schemas.vtuber import (LiveDanmakuInfo, LiveMetricsOut, LiveEventOut,
                                LiveWordOut, LiveUpstreamOut)
from app.services.post_text import extract_post_text
from app.services import messages as message_hub

logger = logging.getLogger(__name__)


def client_host(originator: str = Header("", alias=message_hub.HOST_HEADER)) -> str:
    """哪个宿主发起的这个动作（M2，devlog/244；方案 §8.5 E）。

    前端在 `authFetch`/`request` 里统一带 `X-DDToolkit-Host: main|widget`（连接级）。
    取不到就返回空串 —— **空串不等于任何宿主**，于是"不知道谁点的"时消息照常播给所有人
    （宁可重复提示，也不要静默丢掉一条通知）。
    """
    return (originator or "").strip().lower()


def _note_manual_start(task: str, text: str, originator: str) -> None:
    """手动任务开始 ⇒ 推一条进度（M2）。

    为什么值得推：用户点完按钮到"顶栏出现抓取中"原本要等下一次 `fetch-status` 轮询
    （3–10s，`TopBar` 3s 忙 / 10s 闲）—— `kickPoll` 那个补丁就是为这段等待打的。
    ⚠️ **只推"任务已受理"这一条**：逐项进度仍由状态通道（轮询）负责，前端在轮询到位后
    就用轮询那一份（`TopBar` 的 `pushedProgress`），所以不会出现两条重复进度。
    """
    message_hub.HUB.publish(message_hub.MSG_NOTICE_PROGRESS, {
        "task": task, "text": text, "originator": originator,
    })


def _note_manual_done(text: str, originator: str) -> None:
    """手动任务完成 ⇒ 推一条**完成类**提示（M2），并记进通知汇总（M5-1）。

    ⚠️ 带 `originator`：发起方自己的窗口**不重复提示**（它已经从响应里拿到结果并弹了胶囊），
    别的订阅者（小窗 / 将来的第二窗口）才播。
    ⚠️ **同时记进 `services/notices`**（M5-1，devlog/253）：推送是"这一刻的提示"，
    而 M5-2 起汇总端点要能把它作为一条 `message` 通知发出去（带 TTL）。
    两处都写不算双真源：推送是**事件**，汇总是**当前状态**（同一份内容）。
    """
    message_hub.HUB.publish(message_hub.MSG_NOTICE_MESSAGE, {
        "text": text, "originator": originator,
    })
    notices_service.record_message(text)


def _vtuber_out(db: Session, v: VTuber) -> VTuberOut:
    """单个 V → `VTuberOut`（带 `avatar_local` 派生字段，A0/devlog/255）。

    ⚠️ 这一行**必须**是 `VTuberOut.model_validate(...)`，不能是 `_vtuber_out(...)` ——
    用 `replace_all` 把调用点换成这个辅助函数时，**它自己的函数体也被换掉了**，
    于是变成"函数调用自己" ⇒ 递归爆栈（4 条用例当场红）。**改调用点前先数命中次数。**
    """
    out = VTuberOut.model_validate(v, from_attributes=True)
    out.avatar_local = local_avatar_map(db, [v]).get(v.id)
    return out


def _vtuber_outs(db: Session, vs: list[VTuber]) -> list[VTuberOut]:
    """批量版：**一次查完**派生字段（`/vtuber/list` 走这条，不许 N+1）。"""
    locals_ = local_avatar_map(db, vs)
    outs = [VTuberOut.model_validate(v, from_attributes=True) for v in vs]
    for o in outs:
        o.avatar_local = locals_.get(o.id)
    return outs


def _pin_selected_asset(db: Session, v: VTuber) -> None:
    """用户显式选过的那张头像 ⇒ 该资产 `pinned=1`（清理时永不动它）。

    为什么在这里：`vtubers.avatar` 是**唯一**表达"用户选过哪张"的字段，而 pin 的语义就是
    "这是用户的选择，不许被 LRU 淘汰"。挂在保存档案这一条路上，就不会漏掉某条选择路径
    （幂等：已是 pin 的再设一次不产生写入）。
    ⚠️ 失败**不能拖垮保存档案**（pin 只是清理时的保护标记，档案字段才是主产物）⇒ 只 warning。
    """
    url = (v.avatar or "").strip()
    if not url:
        return
    try:
        if assets.pin(db, assets.KIND_AVATAR, url) is not None:
            db.commit()
    except Exception as e:  # noqa: BLE001 —— 标记失败不该让用户保存不了档案
        db.rollback()
        logger.warning(f"头像资产 pin 失败 vtuber#{v.id}: {type(e).__name__}: {e}")


def _post_outs(db: Session, posts: list[Post]) -> list[PostOut]:
    """`Post` 列表 → `PostOut`（带 `cover_local` / `images_local` / `video_local` 派生）。

    ⚠️ **一次批量查**：列表页一页最多 200 帖，逐帖查 `local_assets` 就是 200 次往返
    （判据：`tests/test_cover_assets.py` 的语句计数那条 —— 页大小翻倍而查询数不变）。
    这里用 `assets.lookup_keys` 一把捞：键在 Python 侧算（`key_of` 是纯函数，
    SQLite 里没有对应表达式 ⇒ "left join" 那条只能落在应用层，语义等价）。

    正文媒体（devlog/319）与封面同一套路，只是**每个帖子有多个键**：先把全页的键收齐、
    一次查完，再按索引回填（`images_local` 与 `body_json.images` 同序同长）。
    """
    outs = [PostOut.model_validate(p, from_attributes=True) for p in posts]
    keys = {o.id: assets.key_of((o.cover_url or "").strip()) for o in outs}
    by_key = assets.lookup_keys(db, assets.KIND_COVER, keys.values())

    # 正文图 / 视频：一页里所有帖的键收齐再一次查（**不许 N+1**）
    img_urls: dict[int, list[str]] = {}
    vid_urls: dict[int, list[str]] = {}
    for o in outs:
        img_urls[o.id] = assets._media_urls(o.body_json, video=False)
        vid_urls[o.id] = assets._media_urls(o.body_json, video=True)
    all_img_keys = [assets.key_of(u) for us in img_urls.values() for u in us]
    all_vid_keys = [assets.key_of(u) for us in vid_urls.values() for u in us]
    img_by_key = assets.lookup_keys(db, assets.KIND_POST_IMAGE, all_img_keys)
    vid_by_key = assets.lookup_keys(db, assets.KIND_POST_VIDEO, all_vid_keys)

    def local_of(by: dict, url: str) -> str:
        row = by.get(assets.key_of(url))
        return (row.path or "").strip() if row is not None else ""

    for o in outs:
        row = by_key.get(keys.get(o.id, ""))
        if row is not None and (row.path or "").strip():
            o.cover_local = row.path
        # ⚠️ **同序同长**：没有副本的位置留空串（前端按索引对齐，不靠 URL 匹配）
        o.images_local = [local_of(img_by_key, u) for u in img_urls.get(o.id, [])]
        vids = vid_urls.get(o.id, [])
        o.video_local = next((p for p in (local_of(vid_by_key, u) for u in vids) if p), None)
    return outs


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


def _require_content_fetch(platform: str = "bilibili") -> None:
    """内容抓取（投稿/动态）需要**该平台的**登录 —— 未登录**在这里就挡掉**（403 + 原因）。

    2026-09-15（devlog/086）实测：B 站对匿名调用空间接口回 `412 request was banned`，
    且是 IP 级、会持续一段时间。让它"试了再失败"有两个坏处：白耗配额、脏 IP，
    而用户看到的只是一句含糊的抓取失败。所以宁可**不发请求**、直接把原因说清楚。
    ⚠️ 只挡内容：账号信息/粉丝数/直播状态匿名可用，不走这里（见 `services/capabilities.py`）。
    ⚠️ 2026-09-27（devlog/228）：以前这里**写死 B 站**，于是带 `platform=weibo` 的端点
    是拿 B 站登录态放行的（越权）。现在把 platform 一路传下去。
    """
    allowed, why = capabilities.content_fetch_allowed(platform)
    if not allowed:
        raise HTTPException(status.HTTP_403_FORBIDDEN, why)


@router.get("/capabilities")
def get_capabilities():
    """本机当前能力矩阵（登录态 × 实测限制）——前端据此标注"未登录 · 受限"。

    `state` 三态：`full` / `degraded`（能用但少东西）/ `requires_login`（平台限制）。
    每项带 `note`（给用户看的原因与补救）与 `evidence`（实测依据与日期）。
    `limited` 是其中非 full 的那些，前端只用它就能渲染提示。
    """
    return capabilities.snapshot()


async def async_fetch_and_update():
    return await _sched().async_fetch_and_update()


async def async_fetch_vtuber(vtuber_id: int):
    return await _sched().async_fetch_vtuber(vtuber_id)


async def async_fetch_accounts(account_ids: list[int], label: str = "指定账号"):
    """按账号 id 精确抓取（收录 / 加账号走这条：只抓新增账号）。"""
    return await _sched().async_fetch_accounts(account_ids, label=label, fast=True)


async def async_fetch_first_screen(account_id: int):
    """收录首屏抓取：投稿 1 页 + 动态 1 页限 N 条（见 scheduler 同名函数）。"""
    return await _sched().async_fetch_first_screen(account_id)


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


def manual_task_running():
    """是否有手动任务在跑（自动档持锁不算）——手动端点用它做 409 判定，
    以便用户手动请求能抢占定时档（见 scheduler「手动任务优先」）。"""
    return _sched().manual_task_running()


async def async_update_unarchived_posts(name: str | None = None):
    return await _sched().async_update_unarchived_posts(name)


def get_fetch_status():
    return _sched().get_fetch_status()


def archive_old_posts(cutoff_days: int = 30, db=None):
    return _sched().archive_old_posts(cutoff_days, db)


# ── VTuber CRUD ────────────────────────────────────────────────────

@router.get("/vtuber/list", response_model=list[VTuberOut])
def list_vtubers(db: Session = Depends(get_db)):
    return _vtuber_outs(db, VTuberRepo(db).all())


# 注意：本路由必须注册在 /vtuber/{vtuber_id} 之前，否则会被 int 路径参数捕获并 422
@router.get("/vtuber/fetch-status")
def fetch_status():
    """抓取任务实时状态（TopBar 轮询用）：
    account=账号信息抓取（running/current/index/total），post=帖子抓取（running/target）。"""
    return get_fetch_status()


# ⚠️ **同理**：`/vtuber/notices` 也必须注册在 `/vtuber/{vtuber_id}` **之前** ——
#    第一版放在文件下面（挨着别的 vtuber 子路径），结果 `GET /vtuber/notices` 被
#    `{vtuber_id}: int` 捕获、直接 422（`tests/test_notices.py::test_route_serves_notices`
#    当场抓住）。FastAPI 按**注册顺序**匹配，路径长得像不代表能兜住。
@router.get("/vtuber/notices", response_model=NoticesOut)
def get_notices(db: Session = Depends(get_db)):
    """**通知汇总**（M5-1，devlog/253）：事实 → 通知，**已按优先级排序** + 服务端 `now`。

    目标架构 §3 的分工在这里落地：`services/notices.py` 只做"事实 → 文案/优先级/ttl"
    （不碰 HTTP、不碰展示），本端点只做暴露（不写业务）。

    ⚠️ **M5-1 只做供数**：前端仍在用自己那份 `useMemo` 汇总 + 推送通道
    （M5-2 才切过来）。所以这个端点**目前没有消费者** —— 它是 M5-2 的契约与判据；
    宁可先把它连同契约用例落地，也不要"切换 + 供数"一批做完（出问题时分不清是哪边）。
    """
    return NoticesOut.model_validate(notices_service.build_notices(db))


@router.post("/vtuber/notices/ack", response_model=NoticeAckOut)
def ack_notice(data: NoticeAckIn, db: Session = Depends(get_db)):
    """记通知**已读**（M5-1，devlog/253；L1 起支持**一批**）。

    修的是"刷新 / 深休眠重建之后完成报告**原地复活**"——今天前端只 `setDoneReport(null)`
    清内存。已读集合落 `app_meta`（那正是为"进程外要记住的少量状态"建的表，见其模型注释）。
    **幂等**：同一个 id 记两次结果一样（判据在 `tests/test_notices.py`）。

    ⚠️ 空请求（既没 `id` 也没 `ids`）⇒ **422**：前端不许发空，否则会往已读集合里塞垃圾，
    而且"点了没反应"这种 bug 会被静默吞掉（原先靠 `id: min_length=1` 表达，改成批量后
    那道约束落在这一句判断上）。
    """
    if not (data.id or "").strip() and not data.ids:
        raise HTTPException(422, "ack 至少要给一个 id（单条用 `id`，批量用 `ids`）")
    if data.ids:
        return NoticeAckOut(acked=notices_service.ack_notices(db, data.ids))
    return NoticeAckOut(acked=notices_service.ack_notice(db, data.id))


@router.get("/vtuber/{vtuber_id}", response_model=VTuberOut)
def get_vtuber(vtuber_id: int, db: Session = Depends(get_db)):
    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    return _vtuber_out(db, v)


@router.post("/vtuber", response_model=VTuberOut, status_code=status.HTTP_201_CREATED)
def create_vtuber(data: VTuberCreate, db: Session = Depends(get_db)):
    try:
        v = VTuberRepo(db).create(data.model_dump())
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "创建失败：数据违反唯一约束")
    return _vtuber_out(db, v)


@router.put("/vtuber/{vtuber_id}", response_model=VTuberOut)
def update_vtuber(vtuber_id: int, data: VTuberUpdate, db: Session = Depends(get_db)):
    v = VTuberRepo(db).update(vtuber_id, data.model_dump(exclude_unset=True))
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    _pin_selected_asset(db, v)
    out = _vtuber_out(db, v)
    # V 本体改了 ⇒ **推给所有订阅者**（M3b，devlog/248）。
    #
    # 这条正是 **R33 那条事故路径**的触发源（"右栏改了签名要通知左栏"）：今天靠前端
    # 存完之后自己 `emit(vtuberUpdated)`，只有"同一个窗口"知道 ⇒ 小窗 / 将来的第二窗口
    # 看不到。改由后端广播，**消费侧一行不动**（侧栏与右栏本来就在听这个事件）。
    # ⚠️ 顺序：`VTuberRepo.update()` 内部已经 commit（并 refresh）⇒ 发布点在 commit 之后，
    #    满足方案 §2.2。`mode="json"` 是必须的：库里是 naive datetime，SSE 帧要过 `json.dumps`。
    message_hub.HUB.publish(message_hub.MSG_VTUBER_UPDATED, out.model_dump(mode="json"))
    return out


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
    """上传卡片页自定义背景（M3b，批次 11b，devlog/214）。

    改前是**先删旧文件再写新文件** ⇒ 写盘失败就把用户原来的背景弄丢了（DB 还指着它）。
    现在：限额流式读取 + 按文件头判类型 + 临时文件原子 rename，**新背景提交成功之后**
    才删旧文件（三条不变量的真源见 `app/services/vtuber_background.py` 头部）。
    """
    from app.services.vtuber_background import (
        BackgroundTooLarge, BackgroundUnsupported, remove_background, save_background,
    )

    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    custom_dir = settings.DATA_DIR / "static" / "custom_bg"
    old_name = Path(v.background_path).name if v.background_path else None
    try:
        rel = await save_background(vtuber_id, file, custom_dir)
    except BackgroundTooLarge:
        raise HTTPException(413, "图片超过 10MB 限制") from None
    except BackgroundUnsupported as e:
        raise HTTPException(415, f"仅支持 jpeg / png / webp / gif 图片（{e}）") from None

    v.background_path = rel
    db.add(v)
    try:
        db.commit()
    except Exception:
        # 提交失败 ⇒ 刚写好的那份是孤儿：删掉它；旧背景（文件 + DB 值）一动没动
        db.rollback()
        remove_background(custom_dir, rel)
        raise
    db.refresh(v)
    if old_name and old_name != Path(rel).name:
        remove_background(custom_dir, old_name)     # 只有新背景真的生效了才删旧的
    return _vtuber_out(db, v)


@router.post("/vtuber/{vtuber_id}/background-video", response_model=VTuberOut)
async def set_vtuber_background_video(
    vtuber_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """上传卡片页背景**视频**（需求 9，f011，`devlog/423`）。

    与图片那条**同一套纪律**（真源见 `app/services/vtuber_background.py` 头部三条不变量）：
    限额流式读取 + 按文件头判类型 + 临时文件原子 rename，**新视频提交成功之后**才删旧视频。

    ⚠️ **不动背景图**：图是视频的 poster 与降级兜底（解码失败/还没加载完就退回图片），
    两者各自独立 —— 传视频不该顺手清掉图，反之亦然。
    """
    from app.services.vtuber_background import (
        BackgroundTooLarge, BackgroundUnsupported, remove_background, save_background_video,
    )

    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    custom_dir = settings.DATA_DIR / "static" / "custom_bg"
    old_name = Path(v.background_video_path).name if v.background_video_path else None
    try:
        rel = await save_background_video(vtuber_id, file, custom_dir)
    except BackgroundTooLarge:
        raise HTTPException(413, "视频超过 50MB 限制") from None
    except BackgroundUnsupported as e:
        raise HTTPException(415, f"仅支持 mp4 / webm 视频（{e}）") from None

    v.background_video_path = rel
    db.add(v)
    try:
        db.commit()
    except Exception:
        # 提交失败 ⇒ 刚写好的那份是孤儿：删掉它；旧视频（文件 + DB 值）一动没动
        db.rollback()
        remove_background(custom_dir, rel)
        raise
    db.refresh(v)
    if old_name and old_name != Path(rel).name:
        remove_background(custom_dir, old_name)     # 只有新视频真的生效了才删旧的
    return _vtuber_out(db, v)


class BackgroundFocusIn(BaseModel):
    """背景取景（需求 7）：**归一化**的图片锚点 + 缩放倍数。

    三个字段都**有边界**（越界 Pydantic 直接 422）：越界值存进去只会让前端算出一张
    跑出视野的图 —— 那是"看起来坏了"，不是"报错了"，所以要在入口挡住。

    ★ `x`/`y` 是**图片锚点**（V1b-3 定案，`devlog/420`）：图上那一点落在取景框的同一比例位置，
    与 CSS `object-position` 同向（`x=0` 看左边缘、`x=1` 看右边缘）。`[0,1]` 这个范围同时保证
    "任何 `scale ≥ 1` 都不露底色"。后端只存不算，几何在前端。
    """
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    scale: float = Field(ge=1, le=3)


@router.put("/vtuber/{vtuber_id}/background-focus", response_model=VTuberOut)
def set_background_focus(vtuber_id: int, data: BackgroundFocusIn,
                         db: Session = Depends(get_db)):
    """保存背景取景（图片锚点 + 缩放；**每个 V 各一份**，需求 7）。

    ⚠️ 存**归一化**值（0..1 的比例 + 倍数）而不是像素：窗口尺寸/DPR 变了取景不该跟着跑
    （锚点语义下这条更强：锚点落在框的第 `x`/`y` 比例处，**与窗口宽度、与缩放都无关**）。
    存的是 **JSON 原文**（同 `profile_cards.config_json` 的口径，这一层不做二次建模）。
    """
    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    v.background_focus = json.dumps({"x": data.x, "y": data.y, "scale": data.scale})
    db.add(v)
    db.commit()
    db.refresh(v)
    return _vtuber_out(db, v)


@router.delete("/vtuber/{vtuber_id}/background-focus", response_model=VTuberOut)
def clear_background_focus(vtuber_id: int, db: Session = Depends(get_db)):
    """清除**图片**的取景 ⇒ 回到"原样铺满"。⚠️ **不动背景图本身**（那要走 `/background`），
    也**不动视频那份取景**（两份各自独立，见 `devlog/426`）。"""
    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    if v.background_focus is not None:
        v.background_focus = None
        db.add(v)
        db.commit()
        db.refresh(v)
    return _vtuber_out(db, v)


@router.put("/vtuber/{vtuber_id}/background-video-focus", response_model=VTuberOut)
def set_background_video_focus(vtuber_id: int, data: BackgroundFocusIn,
                               db: Session = Depends(get_db)):
    """保存**视频**的取景（需求 9 补丁，f012，`devlog/426`）。

    请求体与 `/background-focus` **同一个模型**（形状与语义逐字相同：图片锚点 + 1..3 倍），
    存在**另一列** —— 用户口径是"视频的取景和图片的取景分开"。
    ⚠️ 两份互不相干：这里不读也不写 `background_focus`。
    """
    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    v.background_video_focus = json.dumps({"x": data.x, "y": data.y, "scale": data.scale})
    db.add(v)
    db.commit()
    db.refresh(v)
    return _vtuber_out(db, v)


@router.delete("/vtuber/{vtuber_id}/background-video-focus", response_model=VTuberOut)
def clear_background_video_focus(vtuber_id: int, db: Session = Depends(get_db)):
    """清除**视频**的取景（回到视频原样铺）。⚠️ **不动视频文件、也不动图片那份取景**。"""
    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    if v.background_video_focus is not None:
        v.background_video_focus = None
        db.add(v)
        db.commit()
        db.refresh(v)
    return _vtuber_out(db, v)


@router.delete("/vtuber/{vtuber_id}/background", response_model=VTuberOut)
def clear_vtuber_background(vtuber_id: int, db: Session = Depends(get_db)):
    """清除自定义背景，回退到头像铺底。"""
    from app.services.vtuber_background import remove_background

    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    if v.background_path:
        custom_dir = settings.DATA_DIR / "static" / "custom_bg"
        remove_background(custom_dir, v.background_path)
        v.background_path = None
        db.add(v)
        db.commit()
        db.refresh(v)
    return _vtuber_out(db, v)


@router.delete("/vtuber/{vtuber_id}/background-video", response_model=VTuberOut)
def clear_vtuber_background_video(vtuber_id: int, db: Session = Depends(get_db)):
    """清除背景视频（需求 9）。⚠️ **不动背景图**（与 `clear_vtuber_background` 对称）。"""
    from app.services.vtuber_background import remove_background

    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    if v.background_video_path:
        custom_dir = settings.DATA_DIR / "static" / "custom_bg"
        remove_background(custom_dir, v.background_video_path)
        v.background_video_path = None
        db.add(v)
        db.commit()
        db.refresh(v)
    return _vtuber_out(db, v)


@router.delete("/vtuber/{vtuber_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_vtuber(vtuber_id: int, db: Session = Depends(get_db)):
    """解除订阅：删除 VTuber（accounts 级联）+ 连带清除其全部帖子与账号从属数据。

    2026-09-08 修复：此前只清 posts（posts 无外键），而 accounts 之下还有 4 张
    子表挂着外键且 ORM 未配级联，`PRAGMA foreign_keys=ON` 下 `DELETE FROM accounts`
    直接被挡 → 整次删除回滚、接口 500，用户侧表现为「解除订阅失败、V 删不掉」。
    清理清单见 app/services/purge.py。
    """
    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")

    try:
        counts = purge_vtuber(db, v)
        VTuberRepo(db).delete(vtuber_id)
    except IntegrityError as e:
        db.rollback()
        logger.error(f"解除订阅 VTuber#{vtuber_id} ({v.name}) 被外键挡下: {e}")
        raise HTTPException(409, "该 VTuber 仍有从属数据未清理干净，解除订阅未生效") from e
    logger.info(f"解除订阅 VTuber#{vtuber_id} ({v.name})：清理 {counts}")
    # 破坏性清理之后回收空闲页（R22，devlog/103）：只有这种操作才会一次产生大量 freelist，
    # 而 SQLite 默认不会把空闲页还给系统（文件不缩小）。失败不影响业务结果。
    from app.services.db_maintenance import incremental_vacuum
    incremental_vacuum()


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
def create_account(vtuber_id: int, data: AccountCreate,
                   background: BackgroundTasks, db: Session = Depends(get_db)):
    """给某 V 添加平台账号；成功后立刻后台抓取**该账号**信息与首屏内容。

    2026-09-09 用户反馈：此前只建行不抓取，前端 toast「正在后台抓取账号信息」
    与事实不符，新账号要等下一轮定时档才补上。
    2026-09-09 提速（v0.9.4）：改为与收录同款链路——只抓新增账号（不再重抓该 V
    全部账号）+ 首屏内容并发 + 第三方历史后台补（见 `_adopt_background`）。
    """
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    try:
        acc = AccountRepo(db).create(vtuber_id, data.model_dump())
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"该 (platform, platform_uid) 账号已存在")
    background.add_task(_adopt_background, vtuber_id, acc.id,
                        acc.display_name or data.platform_uid)
    return AccountOut.model_validate(acc, from_attributes=True)


@router.put("/account/{account_id}", response_model=AccountOut)
def update_account(account_id: int, data: AccountUpdate, db: Session = Depends(get_db)):
    """部分更新账号。

    ⚠️ 2026-09-13（devlog/075，用户口径）：**这里不再记曾用值**。
    曾用值的语义是"V 在平台上曾经用过的昵称/签名"，而这条路径写的是**本地手改** ——
    把用户自己打错的字符串标成"曾用签名"正是实测反馈里的那个错误。
    记录只发生在**抓取覆盖前**（`scheduler._fetch_one_account`）。
    """
    patch = data.model_dump(exclude_unset=True)
    try:
        acc = AccountRepo(db).update(account_id, patch)
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "该 (platform, platform_uid) 账号已存在")
    if acc is None:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    return AccountOut.model_validate(acc, from_attributes=True)


@router.get("/vtuber/{vtuber_id}/former-values", response_model=VTuberFormerValuesOut)
def vtuber_former_values(vtuber_id: int, db: Session = Depends(get_db)):
    """该 V 的曾用名 / 曾用签名（各最多 5 条，最近优先）。

    **当前未接入 UI**（2026-09-13 用户口径，devlog/075）：曾用值归「账号信息历史快照」
    这一类，先不展示；记录照常（抓取覆盖前记账），端点留作那条线的读取口。
    这也是它不塞进 `VTuberOut` 的原因 —— `/vtuber/list` 返回全部 V，塞进去就是 N+1。
    """
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    data = former_values(db, vtuber_id)
    return VTuberFormerValuesOut(
        names=[FormerValueOut(**n) for n in data["names"]],
        signs=[FormerValueOut(**s) for s in data["signs"]],
    )


class AccountOrderRequest(BaseModel):
    """平台徽章拖拽重排的提交体（按新顺序给出账号 id）。"""
    account_ids: list[int]


class VtuberOrderRequest(BaseModel):
    """左栏拖拽重排的提交体（按新顺序给出 vtuber id）。

    ⚠️ 可以只给**一部分** —— 带筛选拖动时给的就是"当前可见的那几条"，
    没给的**原地不动**（见 `VTuberRepo.reorder` 的 docstring）。
    """
    vtuber_ids: list[int]


@router.put("/vtuber-order", response_model=list[VTuberOut])
def set_vtuber_order(data: VtuberOrderRequest, db: Session = Depends(get_db)):
    """重排左栏虚拟主播顺序（需求 4/5 拖拽落库）。

    ⚠️ 语义与 `PUT /vtuber/{id}/account-order` **不同**：那边"未列出的排在其后"，
    这边是"**把传进来的填回原位**"（用户 2026-10-07 拍板：筛选下拖动只换可见那几条的相对位置）。
    返回重排后的完整列表（与 `/vtuber/list` 同形，含 `avatar_local` 派生字段）。
    """
    try:
        vtubers = VTuberRepo(db).reorder(data.vtuber_ids)
    except ValueError as e:
        # 口径错误的提交要**当场说清**（重复 id / 不存在的 id），不猜一个语义静默乱序
        raise HTTPException(400, str(e)) from e
    return _vtuber_outs(db, vtubers)


@router.get("/vtuber/{vtuber_id}/avatars", response_model=VTuberAvatarsOut)
def vtuber_avatars(vtuber_id: int, db: Session = Depends(get_db)):
    """该 V 的**历次头像**可选项 + 当前用的是哪张（R47，devlog/249）。

    用户口径（2026-09-28）：「账号更换了头像，新抓取下来的不要直接覆盖以前的，
    把这些都作为可选项保留下来，标记当前用的是哪个」。

    与 `/former-values` 同一个理由不塞进 `VTuberOut`（`/vtuber/list` 会 N+1）；
    返回里**只读**，不在这里落库 —— 记账发生在抓取侧（`services/scheduler.py`）。
    """
    v = VTuberRepo(db).get(vtuber_id)
    if not v:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    return VTuberAvatarsOut.model_validate(avatar_versions(db, v))


@router.put("/vtuber/{vtuber_id}/account-order", response_model=list[AccountOut])
def set_account_order(vtuber_id: int, data: AccountOrderRequest,
                      db: Session = Depends(get_db)):
    """重排该 V 的平台账号展示顺序（P8-B 拖拽落库；未列出的账号排在其后）。"""
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    accounts = AccountRepo(db).reorder(vtuber_id, data.account_ids)
    return [AccountOut.model_validate(a, from_attributes=True) for a in accounts]


@router.delete("/account/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(account_id: int, db: Session = Depends(get_db)):
    """删除账号并同步清理其帖子与从属数据（修复：原来只删 account，帖子成孤儿；
    2026-09-08 再修：直播场次/统计快照等子表未清，外键会让删除整体失败）。"""
    repo = AccountRepo(db)
    acc = repo.get(account_id)
    if not acc:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    try:
        counts = purge_account(db, acc)
        repo.delete(account_id)
    except IntegrityError as e:
        db.rollback()
        logger.error(f"删除 Account#{account_id} 被外键挡下: {e}")
        raise HTTPException(409, "该账号仍有从属数据未清理干净，删除未生效") from e
    logger.info(f"删除 Account#{account_id} ({acc.platform}:{acc.platform_uid})：清理 {counts}")
    # 同上：删账号也是破坏性清理，删完把空闲页还盘（R22）
    from app.services.db_maintenance import incremental_vacuum
    incremental_vacuum()


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


def _infer_session(s: dict, *, vtuber, event_dates, overrides, sessions,
                   live_id) -> tuple[str, str]:
    """场次类型推断（v2 信号栈）：override > series > title > learned > area > date > fallback。

    **一处实现、三处调用**（列表 / 详情 / 写回执）：这三条路的推断输入是同一样东西，
    各写一遍的后果不是"重复"，是**同一条记录在两个端点上分类不同**。
    系列聚类与词库依赖整个账号的场次集合，所以按请求算一次、传进来（别在循环里算）。
    """
    series_categories = plan_series(sessions, overrides)
    learned = build_learned(overrides, sessions)
    return infer_category(
        s["live_title"], s.get("area_name"), s.get("parent_area_name"),
        s["start_at"],
        birthday=vtuber.birthday if vtuber else None,
        debut_date=vtuber.debut_date if vtuber else None,
        event_dates=event_dates,
        live_id=live_id, overrides=overrides,
        series_categories=series_categories, learned=learned,
    )


def _session_payload(s: dict, account_id: int, category: str,
                     category_from: str) -> dict:
    """场次响应的公共载荷（列表 / 详情 / 写回执三个端点共用）。

    `manual` 在这里**算一次**（域层纯函数 `is_manual_source`）：
    让前端自己按 `+` 拆 `source` 的话，「哪些场次能改时间、哪些能删」这条规则
    就有了两份实现，而两份实现漂移时**什么都不红**（服务端照样该拒就拒，
    用户只会看到按钮点了报错）。
    """
    return {"account_id": account_id, **s,
            "category": category, "category_from": category_from,
            "manual": is_manual_source(s.get("source"))}


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
    out = []
    for s in sessions:
        category, category_from = _infer_session(
            s, vtuber=vtuber, event_dates=event_dates, overrides=overrides,
            sessions=sessions, live_id=s.get("live_id"))
        out.append(LiveSessionOut(**_session_payload(s, account_id,
                                                    category, category_from)))
    return out


def _find_live_session(sessions: list[dict], live_id: str) -> dict | None:
    """按对外 `live_id` 找场次；**也认源 id**（`src_live_ids`）。

    为什么需要认源 id：合并会把对外 id 定权成最高优先级源（danmakus uuid > feed 数字 id），
    而**按需现查会在这个弹窗已经打开之后**才把 danmakus 行补进来（devlog/275）——
    前端手里那份详情里还是旧的 feed id，此时点「用弹幕自建」/重取详情都要还能找回同一场次
    （否则 404，而界面会把它显示成"弹幕拉取失败"，把一次成功的补抓说成故障）。
    """
    hit = next((x for x in sessions if x.get("live_id") == live_id), None)
    if hit is not None:
        return hit
    return next((x for x in sessions
                 if live_id in (x.get("src_live_ids") or {}).values()), None)


def _pick_live_session(db: Session, account_id: int, live_id: str,
                       sessions: list[dict] | None = None) -> dict:
    """定位单场次（未收录 → 404）；详情端点与上游取数端点共用。

    `sessions` 可传入调用方已经算好的列表（`merged()` 不便宜，别为一个端点算两遍）。
    内部走 `with_ids=True`：**源 id 也要能定位**（见 `_find_live_session`）。
    """
    if sessions is None:
        sessions = LiveSessionRepo(db).merged(account_id, with_ids=True)
    s = _find_live_session(sessions, live_id)
    if s is None:
        raise HTTPException(404, f"LiveSession live_id={live_id} 不存在")
    return s


def _has_danmakus_source(s: dict) -> bool:
    """该场次是否有 danmakus 来源（实现见 `live_upstream.has_danmakus_source`）。"""
    return has_danmakus_source(s)


@router.get("/account/{account_id}/live-sessions/{live_id}",
            response_model=LiveSessionDetailOut)
def live_session_detail(account_id: int, live_id: str,
                        db: Session = Depends(get_db)):
    """单场次详情（user 2026-09-07：点击日期格 → 独立详情弹窗）。

    与列表端同链路（merged + v2 信号栈），**只回本地库能推导的内容** ——
    上游取数（弹幕词云 / 场次指标 / 中断继续事件）在
    `GET …/live-sessions/{live_id}/upstream`（2026-09-13，devlog/063）。

    为什么要拆：原先上游请求挂在本端点上，上游慢时**整个弹窗**（含只依赖本地库的
    时间/分区/收益/分类）一起转圈，最坏 93s 才出结果。拆开后本端点必然**不发起任何
    第三方请求**，弹窗秒开，慢与失败只影响弹幕/动态那两格。
    """
    account, vtuber, event_dates, overrides = _live_infer_ctx(db, account_id)
    if not account:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    sessions = LiveSessionRepo(db).merged(account_id, with_ids=True)
    s = _pick_live_session(db, account_id, live_id, sessions)
    s.pop("src_live_ids", None)      # 只用于定位，不回给前端
    category, category_from = _infer_session(
        s, vtuber=vtuber, event_dates=event_dates, overrides=overrides,
        sessions=sessions, live_id=live_id)
    return LiveSessionDetailOut(**_session_payload(s, account_id,
                                                  category, category_from))


# ── 手动记录场次（B2，devlog/454） ──────────────────────────────────

def _conflict_message(hit: dict) -> str:
    """409 的中文原因：**说清撞上哪一场 + 下一步怎么做**。

    为什么不是一句"时间冲突"：这个入口的失败九成是用户想给**已有的**那一场补信息，
    而"改哪一条"是他自己才知道的事 —— 把那一场的标题/时间段/来源摆出来他才判得了。
    """
    start = hit["start_at"].strftime("%m-%d %H:%M")
    end = hit.get("end_at")
    span = f"{start}–{end.strftime('%H:%M')}" if end else f"{start} 起"
    who = hit.get("live_title") or "（无标题）"
    return (f"这段时间已有场次：{who} {span}"
            f"（来源 {hit.get('source')}，live_id={hit.get('live_id')}）。"
            "同一时间一个 V 只可能有一场直播 —— 如果就是这一场，请直接编辑它"
            "（可补录播地址）；确实是另一场的话，把时间改成不重叠再存")


def _manual_detail(db: Session, account_id: int, live_id: str) -> LiveSessionDetailOut:
    """写操作的**回执**：按合并后的视图重算一遍（与详情端点同链路）。

    为什么不把刚写的那一行直接回给前端：手动行会被并进相邻场次（`dup`/`restart`/
    self 快照并入），此时它在日历上是**另一个 live_id**（更高优先级的源赢）——
    回执要是拿着一个日历上不存在的 id，前端下一步"编辑我刚存的那条"必然 404。
    """
    account, vtuber, event_dates, overrides = _live_infer_ctx(db, account_id)
    sessions = LiveSessionRepo(db).merged(account_id, with_ids=True)
    s = dict(_pick_live_session(db, account_id, live_id, sessions))
    s.pop("src_live_ids", None)
    category, category_from = _infer_session(
        s, vtuber=vtuber, event_dates=event_dates, overrides=overrides,
        sessions=sessions, live_id=live_id)
    return LiveSessionDetailOut(**_session_payload(s, account_id,
                                                  category, category_from))


def _manual_inputs(data) -> tuple[datetime, datetime | None, str | None, str | None]:
    """写端点的入参统一处理：时间归一 + 标题清洗 + 录播地址规范化（错误 → 422 中文原因）。

    ⚠️ 校验放在**路由层**而不是 Pydantic 校验器里：`HTTPException(422, "…")` 的
    `detail` 是一句能照着改的中文，而 Pydantic 的 422 是一串结构（前端 `api.ts`
    只能把它 `JSON.stringify` 出来给用户看）。
    """
    start = to_utc_naive(data.start_at) if data.start_at is not None else None
    end = to_utc_naive(data.end_at) if data.end_at is not None else None
    title = (data.title or "").strip() or None
    if title and len(title) > 80:
        raise HTTPException(422, f"标题最长 80 字（现在是 {len(title)} 字）")
    try:
        vod = normalize_vod(data.vod_url)
    except VodUrlError as e:
        raise HTTPException(422, str(e))
    return start, end, title, vod


def _check_span(start: datetime, end: datetime | None) -> None:
    """结束时间必须晚于开始时间（相等也不行：0 分钟的场次是填错了，不是"很短"）。"""
    if end is not None and end <= start:
        raise HTTPException(422, "结束时间要晚于开始时间")


@router.post("/account/{account_id}/live-sessions",
             response_model=LiveSessionDetailOut,
             status_code=status.HTTP_201_CREATED)
def create_manual_live_session(account_id: int, data: LiveSessionManualIn,
                               db: Session = Depends(get_db)):
    """手动记录一场直播（B2，devlog/454）：时间 + 可选标题 + 可选录播地址。

    **冲突口径**（`LiveSessionRepo.overlapping`）：只有**表内已有记录**的时段才拦（409）。
    只有 self 快照（本工具轮询观测到的）的时段**放行** —— 手动行随后会被并进那个 self 组
    （`merged()` 把快照并进组），日历上仍然是一条，而这一条从此有了 id/标题/录播地址，
    正是用户想要的结果。拦下它反而会让"给自动观测到的场次补录播地址"变成做不到的事。
    """
    account = AccountRepo(db).get(account_id)
    if not account:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    start, end, title, vod = _manual_inputs(data)
    _check_span(start, end)
    repo = LiveSessionRepo(db)
    hit = repo.overlapping(account_id, start, end)
    if hit:
        raise HTTPException(409, _conflict_message(hit))
    row = repo.create_manual(account_id, platform=account.platform,
                             start_at=start, end_at=end, title=title, vod_url=vod)
    return _manual_detail(db, account_id, row.live_id)


@router.patch("/account/{account_id}/live-sessions/{live_id}",
              response_model=LiveSessionDetailOut)
def update_live_session(account_id: int, live_id: str, data: LiveSessionUpdateIn,
                        db: Session = Depends(get_db)):
    """编辑场次（B2）：**手动记录的**可改时间/标题/录播地址；**自动抓来的只能补录播地址**。

    为什么自动抓来的不许改时间/标题：那两样下一次同步就会被平台数据覆盖回去
    （`LiveSessionRepo._upsert` 每次都用非空值刷新），用户会看到"我改的又变回去了"。
    录播地址反过来 —— 它**没有任何自动源**，只有用户手上有，所以谁都改得。

    `vod_url: ""` = 清空（`exclude_unset` 语义：显式传才算数）。
    """
    if not AccountRepo(db).get(account_id):
        raise HTTPException(404, f"Account id={account_id} 不存在")
    repo = LiveSessionRepo(db)
    row = repo.get_row(account_id, live_id)
    if row is None:
        raise HTTPException(404, f"场次 live_id={live_id} 不在表内（自动推导的场次没有 id，不能编辑）")
    fields = data.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(422, "没有要更新的字段")
    if row.source != "manual" and set(fields) - {"vod_url"}:
        raise HTTPException(
            400, f"这一场是自动抓取的（来源 {row.source}），只能补录播地址 —— "
                 "时间/标题来自平台，改了下次同步会被覆盖回去")
    apply: dict = {}
    if "start_at" in fields or "end_at" in fields or "title" in fields or "vod_url" in fields:
        start, end, title, vod = _manual_inputs(data)
        if "start_at" in fields:
            apply["start_at"] = start
        if "end_at" in fields:
            apply["end_at"] = end          # 显式 null = 清空（改回"进行中"）
        if "title" in fields:
            apply["title"] = title
        if "vod_url" in fields:
            apply["vod_url"] = vod         # "" → None（清空用户填的链接）
    new_start = apply.get("start_at", row.start_at)
    new_end = apply.get("end_at", row.end_at) if "end_at" in fields else row.end_at
    _check_span(new_start, new_end)
    if "start_at" in apply or "end_at" in apply:
        hit = repo.overlapping(account_id, new_start, new_end, exclude_live_id=live_id)
        if hit:
            raise HTTPException(409, _conflict_message(hit))
    repo.update_row(row, apply)
    return _manual_detail(db, account_id, live_id)


@router.delete("/account/{account_id}/live-sessions/{live_id}",
               response_model=LiveSessionDeleteOut)
def delete_live_session(account_id: int, live_id: str, db: Session = Depends(get_db)):
    """删除**手动记录**的场次（B2）。

    两条口径：

    - **自动抓来的不给删**（400）：下一次同步会把它放回来 ——「删了又回来」比
      「不许删」更像故障，用户会以为删除功能坏了；
    - 删掉的只是**手动那一行**：如果这段时间本工具也观测到了直播，它会退回成
      自动场次（日历上还在，只是没有标题/录播地址了）。

    该场的分类校正一并清掉（`LiveSessionRepo.delete_row`）：留着就是一份悬空记录。
    """
    if not AccountRepo(db).get(account_id):
        raise HTTPException(404, f"Account id={account_id} 不存在")
    repo = LiveSessionRepo(db)
    row = repo.get_row(account_id, live_id)
    if row is None:
        raise HTTPException(404, f"场次 live_id={live_id} 不在表内（自动推导的场次没有 id，不能删除）")
    if row.source != "manual":
        raise HTTPException(400, f"只能删除手动记录的场次（这一条来源是 {row.source}）")
    repo.delete_row(row)
    return LiveSessionDeleteOut(deleted=True, live_id=live_id)


@router.get("/account/{account_id}/live-sessions/{live_id}/upstream",
            response_model=LiveUpstreamOut)
async def live_session_upstream(account_id: int, live_id: str,
                                refresh: bool = Query(False),
                                db: Session = Depends(get_db)):
    """场次详情里「必须打第三方」的那两格：弹幕词云 + 直播动态（devlog/063）。

    与详情端点分离，因此：

    - 弹窗不必等它 —— 上游慢/挂了只让这两格转圈，其余内容照常可读；
    - 前端可就地重试（同一次请求同时服务"弹幕"与"直播动态"两段，与 `gather` 对应）。

    降级口径（**不要把"没拉到"说成"没有"**）：

    | 结果 | 返回 |
    |---|---|
    | 拿到上游摘要 | `danmaku.wc_status = upstream` / `upstream_absent` + `metrics` + `events` |
    | 上游这次没拿到（超时/重试耗尽） | `danmaku.wc_status='fetch_failed'`，`metrics=null`、`events=[]` |
    | **本场还在直播**（`end_at` 为空） | `danmaku.wc_status='live'`，**不请求网络** |
    | 非 danmakus 来源（纯 feed/self）但已结束 | **先按需现查一次**（`ensure_session_recorded`，同账号 10 分钟一次）：查到了 → 走正常取数；上游确实没有 → `no_danmaku`；没问成 → `fetch_failed` |

    成功结果在进程内缓存 10 分钟（`live_upstream._CACHE_TTL`），重复开关弹窗不再打上游。

    `refresh=true`：**用户显式点重试**时带上，用来绕过"同账号 10 分钟只现查一次"的
    节流（否则点了按钮却不问上游，"重试"是句空话）。
    """
    account, _vtuber, _event_dates, _overrides = _live_infer_ctx(db, account_id)
    if not account:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    s = _pick_live_session(db, account_id, live_id)
    if not s.get("end_at"):
        # 还在直播：danmakus 只在**开播结束之后**才固定化这一场，此刻问上游是白问。
        # 用户口径（2026-10-02）：这里要显示"正在直播中"，而不是"本场没有可统计的
        # 弹幕记录"—— 后者把"还没到时候"说成了"没有"。
        return LiveUpstreamOut(danmaku=LiveDanmakuInfo(wc_status="live"))
    if not _has_danmakus_source(s):
        # 本地只有 feed/self 行：先现查一次（devlog/275）。这一格原先直接返回
        # no_danmaku，而"本地没有 danmakus 行"的常见成因是**同步那一夜被 WAF 拦了**，
        # 上游其实早有这一场（实测：弥月 09-25 起 11 场全因此缺席）。
        outcome, found = await ensure_session_recorded(db, account_id, s, force=refresh)
        if outcome == LOOKUP_FAILED:
            # 没问成 ≠ 没有：报 fetch_failed 让用户能重试
            return LiveUpstreamOut(danmaku=LiveDanmakuInfo(wc_status="fetch_failed"))
        if outcome != LOOKUP_RECORDED or found is None:
            return LiveUpstreamOut(danmaku=LiveDanmakuInfo(wc_status="no_danmaku"))
        # 现查命中：换成合并后的场次（它的 live_id 已是 danmakus uuid）
        s = found
        live_id = str(s.get("live_id") or live_id)
        changed = True          # 前端据此重取一次详情（弹幕数/收益/数据源也变了）
    else:
        changed = False

    # 观测用（2026-09-14，devlog/081）：用户问过"点一次详情为什么发了四个上游请求"——
    # 有了这一行，日志里数一下就知道**我们这边被调了几次**（一次调用 = summary+events 两个上游请求）。
    logger.info(f"场次上游取数 liveId={live_id}（account={account_id}）")
    summary, evts = await load_live_upstream(live_id)
    if summary is None:
        # ⚠️ 这里报 fetch_failed（"没拉到"），**不能**报成"本场没弹幕"
        return LiveUpstreamOut(danmaku=LiveDanmakuInfo(wc_status="fetch_failed"),
                               session_changed=changed)

    wc = summary.get("word_cloud") or []
    # D4（devlog/061）：把「上游给没给热词」如实报给前端 ——
    # 上游没给时前端要显示「自建」按钮，而不是干巴巴一句「暂无热词数据」。
    #
    # ⚠️ `status` 以**实际拿到的词条**为准，不盲信 summary 里的字段：
    # 曾经写成 `summary.get("status") or "upstream_absent"`，于是当 summary 没带
    # status（旧调用口径/测试桩）时，会出现 `source='upstream'` 与
    # `wc_status='upstream_absent'` **自相矛盾**的组合（被 test_live_session_detail
    # 当场抓出）。派生量就地从同一份数据推导，别让它依赖上游是否恰好填了那个键。
    status = summary.get("status")
    if status not in ("upstream", "upstream_absent"):
        status = "upstream" if wc else "upstream_absent"
    danmaku = LiveDanmakuInfo(
        total=summary.get("total"),
        top_keywords=[w for w, _c in wc][:40],
        top_words=[LiveWordOut(text=w, count=int(c)) for w, c in wc][:40],
        source="upstream" if status == "upstream" else None,
        wc_status=status,
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
    events: list[LiveEventOut] = []
    for ev in evts or []:
        sd = ev.get("send_date_ms")
        events.append(LiveEventOut(
            type=int(ev.get("type") or 0),
            send_date=datetime.fromtimestamp(sd / 1000, tz=timezone.utc)
            .replace(tzinfo=None) if sd else None,
        ))
    return LiveUpstreamOut(danmaku=danmaku, metrics=metrics, events=events,
                           session_changed=changed)


class LiveCategoryUpdate(BaseModel):
    category: str


@router.get("/account/{account_id}/live-sessions/{live_id}/wordcloud",
            response_model=LiveDanmakuInfo)
async def live_session_wordcloud(account_id: int, live_id: str,
                                 db: Session = Depends(get_db)):
    """**按需**用原始弹幕自建词云（2026-09-13，danmakus 上游断供后的方案 a）。

    为什么不直接并进详情端点（用户 2026-09-13 定，见 devlog/061）：
    上游 `/api/v2/live` 的 `extra.wordCloud` 已断供，回退到自建要拉**整场原始弹幕**
    （实测单场 18764 条、约 2MB），**不能悄悄塞进每次开弹窗的请求**里 ——
    那会把"打开详情"从一次轻请求变成一次重请求，而多数场次用户并不看词云。

    所以：详情端点只如实报告 `wc_status=upstream_absent`，由前端显示按钮，
    **用户点击后**才调本端点。结果在进程内缓存（不落库，见 `danmaku_cloud._CACHE`）。

    返回的 `wc_status` 区分三种结果：`self_built` / `no_danmaku` / `fetch_failed`。

    分词自定义词典（2026-09-13 接线，扩展点 2）：把 **V 名 / 企划·公会 / 账号昵称**
    灌进 jieba，避免主播名被切碎（实测"喵喵机长真棒"不加词会被切成 `机长`）。
    """
    account, vtuber, _event_dates, _overrides = _live_infer_ctx(db, account_id)
    if not account:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    # 与详情/上游端点同一条定位口径（认源 id）：按需现查把 uuid 补进来之后，
    # 前端手里那份详情里的 feed id 仍要能找回同一场次（devlog/275）。
    s = _pick_live_session(db, account_id, live_id)
    # 用**场次的对外 id**（定权后的 danmakus uuid）去拉原始弹幕：请求里的 id 可能是
    # 合并前的 feed 数字 id（按需现查之后前端手里那份详情就是这种形态，devlog/275），
    # 而 danmakus v3 只认自己的 uuid（拿数字 id 去问等于空手而归）。
    live_id = str(s.get("live_id") or live_id)
    if "danmakus" not in (s.get("source") or "").split("+"):
        # 非 danmakus 来源（例：纯 feed 场次，live_id 是 B 站数字 id）→ 没有可拉的弹幕
        return LiveDanmakuInfo(wc_status="no_danmaku", source=None)

    extra_words = build_extra_words([
        vtuber.name if vtuber else None,
        vtuber.faction if vtuber else None,
        vtuber.setting if vtuber else None,      # 设定里常带艺名/梗词，一起灌没坏处
        account.display_name,
    ])
    result = await build_word_cloud(live_id, extra_words=extra_words)
    status = result.get("status")
    wc_status = {"ok": "self_built", "no_danmaku": "no_danmaku",
                 "fetch_failed": "fetch_failed"}.get(status, "fetch_failed")
    words = result.get("words") or []
    return LiveDanmakuInfo(
        total=result.get("total"),
        top_keywords=[w for w, _c in words],
        top_words=[LiveWordOut(text=w, count=int(c)) for w, c in words],
        source="self" if wc_status == "self_built" else None,
        wc_status=wc_status,
        text_count=result.get("text_count"),
        engine=result.get("engine"),
    )


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


# ── 档案视图的卡片布局（R37-P2，devlog/142） ────────────────────────

@router.get("/vtuber/{vtuber_id}/profile-cards", response_model=list[ProfileCardOut])
def list_profile_cards(vtuber_id: int, db: Session = Depends(get_db)):
    """该 V 的档案视图卡片布局（按 y, x = 阅读顺序）。**空列表 = 还没排过**，
    由前端用默认布局渲染（服务端不替用户决定默认长什么样 —— 默认排布属于展示口径，
    卡片注册表在前端）。"""
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    return [
        ProfileCardOut.model_validate(c, from_attributes=True)
        for c in ProfileCardRepo(db).by_vtuber(vtuber_id)
    ]


@router.put("/vtuber/{vtuber_id}/profile-cards",
            response_model=list[ProfileCardOut])
def save_profile_cards(vtuber_id: int, data: ProfileLayoutIn,
                       db: Session = Depends(get_db)):
    """整版保存卡片布局（delete + insert 一个事务）。

    校验口径：格位越界 / card_key 重复由 Pydantic 拦下（422 带中文原因），
    **不做静默夹取** —— 夹取会把前端 bug 写进库，用户下次打开只会觉得"卡片自己动了"。
    """
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    rows = ProfileCardRepo(db).replace_all(
        vtuber_id, [c.model_dump() for c in data.cards]
    )
    return [ProfileCardOut.model_validate(c, from_attributes=True) for c in rows]


# ── 重要日期·大型活动（P7，v0.7.0） ────────────────────────────────

@router.get("/vtuber/{vtuber_id}/events", response_model=list[VtuberEventOut])
def list_vtuber_events(vtuber_id: int, kind: str | None = Query(None),
                       db: Session = Depends(get_db)):
    """手动维护的重要日期/活动条目（vtuber_events），按日期升序。

    R42-A：`kind` 可选过滤（`anniversary` = 纪念日卡 / `event` = 大事记时间轴）；
    不传则全给（老前端行为不变）。
    """
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    if kind is not None and kind not in EVENT_KINDS:
        raise HTTPException(422, f"kind 须是 {sorted(EVENT_KINDS)} 之一")
    return [
        VtuberEventOut.model_validate(e, from_attributes=True)
        for e in VtuberEventRepo(db).list_by_vtuber(vtuber_id, kind=kind)
    ]


@router.post("/vtuber/{vtuber_id}/events", response_model=VtuberEventOut,
             status_code=status.HTTP_201_CREATED)
def create_vtuber_event(vtuber_id: int, data: VtuberEventCreate,
                        db: Session = Depends(get_db)):
    """手动添加重要日期/活动条目（卡片内「添加」入口）。"""
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    e = VtuberEventRepo(db).create(vtuber_id, data.title, data.event_date,
                                   kind=data.kind, emoji=data.emoji)
    return VtuberEventOut.model_validate(e, from_attributes=True)


@router.patch("/vtuber/event/{event_id}", response_model=VtuberEventOut)
def update_vtuber_event(event_id: int, data: VtuberEventUpdate,
                        db: Session = Depends(get_db)):
    """局部更新（R42-A）：改名称/日期/emoji/归属卡。

    `exclude_unset=True` 而不是 `exclude_none` —— 显式传 `emoji: null` 表示**清空**，
    不能被当成"没传"（否则用户永远删不掉自己填的 emoji）。
    """
    fields = data.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(422, "没有要更新的字段")
    obj = VtuberEventRepo(db).update(event_id, **fields)
    if not obj:
        raise HTTPException(404, f"Event id={event_id} 不存在")
    return VtuberEventOut.model_validate(obj, from_attributes=True)


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

def _bili_bvid_of(db: Session, post_id: int) -> str:
    """帖子 id → bvid（**两条 B站播放路由共用**：错误分类必须一致，别各写一遍）。

    三类失败**分开**（devlog/289 的口径）：不存在 404 / 不是 B站帖 400 / 不是视频帖 400。
    """
    from app.core.jsonsafe import safe_json_dict

    post = PostRepo(db).get(post_id)
    if post is None:
        raise HTTPException(404, f"Post id={post_id} 不存在")
    if post.platform != "bilibili":
        raise HTTPException(400, f"只有 B站帖子能取流（这条是 {post.platform}）")
    bvid = (safe_json_dict(post.body_json) or {}).get("bvid")
    if not bvid:
        raise HTTPException(400, "这条帖子没有 bvid（不是视频帖）")
    return str(bvid)


@router.get("/bili/play/{post_id}")
async def bili_play(post_id: int, qn: int | None = Query(None),
                    fallback: bool = Query(False),
                    cid: int | None = Query(None),
                    db: Session = Depends(get_db)):
    """B站视频取流（2026-10-03，devlog/289；C1+C2，**默认 DASH**）。

    为什么必须走后端：媒体 CDN 要 `Referer: https://www.bilibili.com/` 才给（实测不带 → 403），
    而浏览器设不了 Referer；登录态也只在后端的 `.env` 里（前端拿不到、也不该拿到）。

    - **按需调用**：用户点播放才取；地址短时效且绑 IP ⇒ 只做 120s 短缓存、**不落库**；
    - `qn` 只是"我想要哪档"，实际给哪档看**账号权益 + 片源**（本账号实测最高 1080P，
      要 1080P+/4K 会被静默回落 —— 前端照返回值里的 `quality` 显示）；
    - `fallback=true` ⇒ 换 `fnval=1` 取 **durl 单 mp4**（720P 封顶）：DASH 那条路在真机上
      播不动时，前端拿它当兜底（⚠️ 这个参数 2026-10-03 曾**漏接**：前端发了、路由没收，
      于是 DASH 失败后重取回来的还是 DASH —— devlog/292）；
    - **分P**（devlog/329）：`cid` 指定哪一 P（不传 = 第 1 P）。响应里带 `pages`
      （`[{cid,page,part,duration_s}]`）与 `page`，前端据此渲染"分P"菜单。
      ⚠️ 上游 `view.duration` 是**各 P 之和**，别拿它当片长（进度条一律以段表/元素时长为准）；
    - 失败**如实分类**：`-404` 不存在 / `-403` 无权限（充电专属等）/ `-352` 风控 / 其它。
    """
    from app.services import bili_play

    bvid = _bili_bvid_of(db, post_id)
    try:
        return await bili_play.play_info(bvid, qn=qn, durl_fallback=fallback, cid=cid)
    except bili_play.PlayError as e:
        status = {"not_found": 404, "forbidden": 403, "risk_control": 429}.get(e.kind, 502)
        raise HTTPException(status, e.message) from e


@router.get("/bili/segments/{post_id}")
async def bili_segments(post_id: int, qn: int | None = Query(None),
                        cid: int | None = Query(None),
                        db: Session = Depends(get_db)):
    """B站 DASH 的**段表**（2026-10-04，devlog/312）：`时间 → 字节`，MSE 内核按它取段。

    ```json
    {"bvid": "...", "quality": 80, "duration_s": 265.3,
     "video": {"mime": "video/mp4; codecs=\\"avc1.640033\\"", "urls": [...],
               "init": {"start": 0, "end": 947}, "segments": [{"i":0,"start":1628,…}]},
     "audio": {…同形…}}
    ```

    为什么单独一个端点（而不是塞进 `/bili/play`）：段表要**额外取两条流的头部**
    （各 64KB）—— 塞进取流会把"渐进式路径"也拖慢；而 MSE 这条路本来就必须先有表才能开播。
    前端拿不到表就**静默退回渐进式**（`kernelChoice` 那条退路），播放不受影响。

    `cid` 与 `/bili/play` 同义（哪一 P，`devlog/329`）—— ⚠️ 两条端点必须拿到**同一条流**，
    否则"分段表与播放地址对不上"（切 P 时尤其明显）。

    失败一律 502 + 如实原因（`no_sidx` = 这条流没有索引 ⇒ 做不了按段取数，不是我们挂了）。
    """
    from app.services import bili_play, bili_segments

    bvid = _bili_bvid_of(db, post_id)
    try:
        play = await bili_play.play_info(bvid, qn=qn, cid=cid)
        tables = await bili_segments.stream_tables(play)
    except bili_play.PlayError as e:
        status = {"not_found": 404, "forbidden": 403, "risk_control": 429}.get(e.kind, 502)
        raise HTTPException(status, e.message) from e
    except bili_segments.SegmentsError as e:
        raise HTTPException(502, f"{e.message}（这段流做不了 MSE，将退回渐进式）") from e
    return {"bvid": bvid, "quality": play.get("quality"),
            "duration_s": tables["duration_s"],
            "video": tables["video"], "audio": tables["audio"]}


@router.get("/posts/{platform}/{platform_uid}", response_model=list[PostOut])
def list_posts(platform: str, platform_uid: str, db: Session = Depends(get_db)):
    return _post_outs(db, list(PostRepo(db).by_uid(platform, platform_uid)))


#: 同一帖两次重取的最小间隔（秒）。图床地址是**限时**的，重取只能拿"当下这一份"，
#: 调太频除了给上游添麻烦没有任何收益 —— 所以这里如实 429，而不是"随便点"。
REFRESH_MEDIA_MIN_GAP = 30.0
_refresh_at: dict[int, float] = {}

#: 用户主动重取时，愿意为**我们自己的节奏**等多久（秒）。
#: 抖音 `aweme_detail` 是 0.12/s（≈8.3s 一发，见 `identity_limit.ENDPOINT_RATE`）——
#: 连着点开两条视频就会撞上自己的令牌桶。以前直接 502「identity_throttled」，
#: 用户看到的是"重取也没成功"（2026-10-06 真机：post#5100 就是这么废掉的）。
REFRESH_MEDIA_WAIT_MAX = 12.0


async def _enrich_allowing_own_pace(fetcher, item: dict) -> bool:
    """`fetcher.enrich(item)`；**只为我们自己的节奏排队**，上游真出错一律不重试。

    - 挡路的若是 `identity_throttled`（令牌桶说"还得等 N 秒"）⇒ 等它、再试一次；
      总预算 `REFRESH_MEDIA_WAIT_MAX`（额度**照算**：等 = 按配置的节奏来，不是绕开限速）；
    - 风控 / 网络 / 业务失败**立刻返回 False** —— 那类等多久都没用，只会更慢地失败。
    """
    import asyncio

    spent = 0.0
    while True:
        if await fetcher.enrich(item):
            return True
        err = getattr(fetcher, "last_error", None) or {}
        if err.get("kind") != "identity_throttled":
            return False
        try:
            wait = float(err.get("retry_after") or 0.0)
        except (TypeError, ValueError):
            wait = 0.0
        if wait <= 0 or spent + wait > REFRESH_MEDIA_WAIT_MAX:
            return False
        await asyncio.sleep(min(wait + 0.2, REFRESH_MEDIA_WAIT_MAX - spent))
        spent += wait


@router.post("/posts/{post_id}/refresh-media")
async def refresh_post_media(post_id: int, db: Session = Depends(get_db)):
    """**重取这一帖的媒体地址**（2026-10-04，devlog/320；计划批次 3）。

    什么时候用：本地没有固化副本、而远端图床地址**签名过期**（小红书实测不到一天就 403），
    详情页四级回落全失败时的**备选路径**。前端只在"确实一张都画不出来"时调一次。

    口径：
    - 走**平台自己的详情补全**（`BasePlatform.enrich`：小红书 `feed`、微博详情），
      所以签名头/风控/节流都在平台层，这里不另造一套；
    - **未登录 ⇒ 如实 403**（内容接口的能力闸门，与抓取同一条）；
    - 平台没有详情补全（如 B 站视频帖）⇒ **409**（别假装重取了）；
    - 同一帖 `REFRESH_MEDIA_MIN_GAP` 秒内再来 ⇒ **429**（并说明为什么）；
    - 撞上**我们自己的令牌桶**（`identity_limit`，抖音详情 0.12/s ≈8.3s 一发）⇒
      **排队等它**（`REFRESH_MEDIA_WAIT_MAX` 秒封顶）而不是立刻 502 —— 用户主动点开一帖，
      等几秒是合理的；额度照算，只是把"拒绝"换成"排队"（2026-10-06 真机现场）；
    - 写回**只动媒体相关的列**（封面/正文/raw/stats）：标题与发布时间是另一件事，
      顺手改会让"列表顺序突然变了"这类现象更难解释；
    - 拿到新地址后**立刻固化一次**（否则几小时后又过期，用户下次打开还是灰的）。
    """
    import time

    from app.services import capabilities
    from app.services import media_pin
    from app.services.platforms import registry
    from app.services.platforms.base import BasePlatform

    post = PostRepo(db).get(post_id)
    if post is None:
        raise HTTPException(404, f"Post id={post_id} 不存在")
    allowed, why = capabilities.content_fetch_allowed(post.platform)
    if not allowed:
        raise HTTPException(403, why or "当前未登录，无法重取媒体")
    fetcher = registry.get_fetcher(post.platform)
    if fetcher is None or type(fetcher).enrich is BasePlatform.enrich:
        raise HTTPException(409, f"{post.platform} 的帖子没有可重取的媒体详情"
                                 f"（B 站视频帖的封面/播放地址在播放时另行取流）")
    now = time.monotonic()
    left = REFRESH_MEDIA_MIN_GAP - (now - _refresh_at.get(post_id, 0.0))
    if left > 0:
        raise HTTPException(429, f"刚重取过，{left:.0f} 秒后再试"
                                 f"（图床地址是限时的，重取太频只会白跑一趟）")
    _refresh_at[post_id] = now

    # 把库里的行**还原成抓取时的 item 形状**再交给平台层（它自己知道 raw_json 里有什么）
    item = {"platform": post.platform, "platform_uid": post.platform_uid,
            "platform_post_id": post.platform_post_id, "type": post.type,
            "title": post.title, "summary": post.summary, "cover_url": post.cover_url,
            "permalink": post.permalink, "body_json": post.body_json,
            "stats_json": post.stats_json, "raw_json": post.raw_json}
    try:
        ok = await _enrich_allowing_own_pace(fetcher, item)
    except Exception as e:                     # noqa: BLE001 —— 上游千奇百怪，如实回一句话
        logger.warning(f"重取媒体失败 post#{post_id}: {type(e).__name__}: {e}")
        raise HTTPException(502, f"重取失败：{type(e).__name__}") from e
    if not ok:
        err = getattr(fetcher, "last_error", None) or {}
        if err.get("kind") == "identity_throttled":
            # 如实说清"这是我们自己的限速，不是平台拒绝" —— 否则用户会去查 cookie/开关
            raise HTTPException(
                502, f"没能取到新的媒体地址：为不打乱抓取节奏，等了 {REFRESH_MEDIA_WAIT_MAX:.0f} 秒"
                     f"也没排上（**我们自己的限速**，不是平台拒绝）—— 过一会儿再试一次就好")
        raise HTTPException(502, "没能取到新的媒体地址"
                                 + (f"：{err.get('message') or err.get('kind')}" if err else ""))
    for col in ("cover_url", "body_json", "raw_json", "stats_json"):
        if item.get(col):
            setattr(post, col, item[col])
    db.commit()
    try:
        pinned = await media_pin.pin_post_media(db, post)
    except Exception as e:                     # noqa: BLE001 —— 固化失败不该让"重取"这件事失败
        logger.warning(f"重取后固化失败 post#{post_id}: {type(e).__name__}: {e}")
        db.rollback()
        pinned = {"reason": "固化失败（见日志）"}
    return {"ok": True, "pinned": pinned, "post": _post_outs(db, [post])[0]}


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
        items=_post_outs(db, list(items)),
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
    if manual_task_running():
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
async def fetch_vtuber(vtuber_id: int, db: Session = Depends(get_db),
                       originator: str = Depends(client_host)):
    """抓取单个 VTuber 的账号信息（devlog/017）。与全局抓取互斥。"""
    if not VTuberRepo(db).get(vtuber_id):
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    if manual_task_running():
        return {"status": "skipped", "message": "已有抓取任务正在进行中，请稍后再试"}
    v = VTuberRepo(db).get(vtuber_id)
    _note_manual_start("account", f"账号信息抓取中 - {v.name}", originator)
    result = await async_fetch_vtuber(vtuber_id)
    text = f"账号信息更新完成 · 成功 {result.success} · 失败 {result.failed}"
    _note_manual_done(text, originator)
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
                              originator: str = Depends(client_host),
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

    ⚠️ 未登录 B 站 → **403**（内容接口匿名会被平台 412 拦截，不发无谓请求；devlog/086）。
    """
    _require_content_fetch(platform)
    if full:
        if manual_task_running():
            raise HTTPException(409, "已有抓取任务正在进行中，请稍后再试")
        vtubers = db.query(VTuber).filter(VTuber.name.contains(name)).all()
        if not vtubers:
            raise HTTPException(404, f"未找到名字包含 '{name}' 的 VTuber")
        background.add_task(async_fetch_vtuber_posts, name, platform)
        _note_manual_start("full", f"全量抓取中 - {name}", originator)
        return {"status": "started", "message": "全量帖子抓取已开始（后台执行，进度见顶栏）"}

    if manual_task_running():
        return {"status": "skipped", "message": "已有抓取任务正在进行中，请稍后再试"}

    vtubers = db.query(VTuber).filter(VTuber.name.contains(name)).all()
    if not vtubers:
        raise HTTPException(404, f"未找到名字包含 '{name}' 的 VTuber")

    # 前置归档：让 archived_ids 尽量完整，边界后的历史页零请求跳过
    archived_first = archive_old_posts(db=db)
    _note_manual_start("quick", f"帖子抓取中 - {name}", originator)

    acc_repo = AccountRepo(db)
    total = {"videos": 0, "dynamics": 0, "stored": 0, "skipped": 0}
    total_rl = False   # 任一账号触发风控提前结束 → 置位，前端提示（B）
    total_vm = 0       # 视频缺失估计（方案 2：参考总数 - 本轮已覆盖）
    results = []

    for v in vtubers:
        for acc in acc_repo.by_vtuber(v.id):
            # ⚠️ 2026-09-27（devlog/228）：这里以前多一个 `acc.platform_uid.isdigit()`
            # —— 那是 **B 站口径**（B 站 uid 是数字）。微博 uid 不是数字 ⇒ 带
            # `platform=weibo` 调这个端点会**静默跳过所有账号**，返回"成功 0 条"，
            # 看起来像"这个 V 没内容"。现在只要求"有 uid"。
            if acc.platform == platform and acc.platform_uid:
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

    text = (f"帖子抓取完成 · 存储 {total['stored']} · 跳过 {total['skipped']}"
            + ("（触发风控，部分内容未抓全）" if total_rl else ""))
    _note_manual_done(text, originator)
    return {"status": "done", "archived_first": archived_first,
            "total": total, "details": results,
            "rate_limited": total_rl, "video_missing": total_vm or None}

@router.post("/vtuber/fetch-all-posts")
async def fetch_all_posts():
    """
    对库中所有 VTuber 的 bilibili 账号逐个全量抓取帖子（视频+动态）。
    示例: POST /vtuber/fetch-all-posts

    ⚠️ 未登录 B 站 → **403**（同 `/vtuber/fetch-posts`）。
    """
    _require_content_fetch()
    if manual_task_running():
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
async def update_unarchived_posts(name: str | None = None,
                                  originator: str = Depends(client_host)):
    """
    更新未归档动态贴文（先归档旧帖，再抓取动态，遍历到归档边界即停）：
    1. 执行归档规则（早于 30 天前的帖子 → is_archived=1）；
    2. 抓取目标账号的动态（视频不抓），整页已归档即停止翻页。
    name 省略 → 全部 bilibili 账号；name 支持模糊匹配。
    示例: POST /vtuber/update-posts?name=明前奶绿   |   POST /vtuber/update-posts

    ⚠️ 未登录 B 站 → **403**（动态也是内容接口；devlog/086）。
    """
    _require_content_fetch()
    if manual_task_running():
        return {"status": "skipped", "message": "已有抓取任务正在进行中，请稍后再试"}
    _note_manual_start("update", f"动态更新中 - {name or '全部账号'}", originator)
    r = await async_update_unarchived_posts(name)
    total = (r or {}).get("total") or {}
    _note_manual_done(
        f"动态更新完成 · 新增 {total.get('stored', 0)} · 跳过 {total.get('skipped', 0)}",
        originator)
    return r


# ── 候选池 + 添加 VTuber（v0.5：csv 降级为离线索引，启动不再导入） ──────

class AdoptRequest(BaseModel):
    platform: str = "bilibili"
    platform_uid: str
    faction: str | None = None
    # 来源（R11，devlog/083）：None/'pool' = 候选池（必须在池内）；
    # 'bilibili' = B 站直搜，池外条目会**服务端实查 acc/info** 复核后才建库
    source: str | None = None


#: 「没有搜索接口」的平台 → 展示名：收录时**只能按 uid**，拿 uid 去问一次主页信息做复核
#: （小红书 devlog/234，抖音 devlog/334）。这张表就是那条分支的唯一真源。
_VERIFY_BY_PROFILE: dict[str, str] = {"xiaohongshu": "小红书", "douyin": "抖音"}
#: 上面两家"缺凭据时该去粘什么"的一句话（503 的补救指引）
_VERIFY_BY_PROFILE_HINT: dict[str, str] = {
    "xiaohongshu": "至少要有 a1 与 web_session",
    "douyin": "整条 Cookie（uifid / s_v_web_id / ttwid）与那个浏览器的 User-Agent",
}


# 后台任务强引用集合（v0.9.4）：
# `asyncio.create_task()` 的返回值若无人引用，任务可能在执行中被 GC 回收
# ——Python 文档明确警告（"Save a reference to the result of this function"）。
# 收录回填是 fire-and-forget，一旦被回收就是「日志里根本没有外部任务」的静默丢失。
_background_tasks: set[asyncio.Task] = set()


def _spawn_background(coro) -> asyncio.Task:
    """起一个脱离关键路径的后台任务（保留强引用，完成后自动移除）。"""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


async def _adopt_background(vtuber_id: int, account_id: int, label: str = "") -> None:
    """收录 / 加账号后的后台链路（v0.9.4 提速，用户 2026-09-09 需求）。

    旧实现：`_fetch_adopted`（该 V 全部账号信息）→ `_backfill_adopted_history`
    **顺序**执行，且账号信息里还夹着 3~5s 空转与内联头像下载 → 用户要等 5~12s。

    新实现：三条支路**同时起跑**
    1. 账号信息（只抓新增账号，账号锁）；
    2. 首屏内容（帖子锁）；
    3. 第三方历史回填（粉丝趋势 / 直播场次 / 礼物日）——脱离关键路径，
       打的是第三方站点、不占两把锁，因此与 1/2 并行不会拖慢首屏；
       慢也不占 HTTP 后台槽位（否则响应后台链会挂几十秒）。

    用户 2026-09-09 反馈「手动任务和外部任务没有连在一起」：回填原来排在
    `gather` 之后才起跑，且首条日志要等第三方响应（本次实测 ~14s），中间还夹着
    综合档续跑的日志 —— 现在回填在 `gather` **之前**起跑并打印「收录回填开始」，
    日志链路一眼可见（devlog/044 §六）。
    """
    # 先起回填：与下面两条关键路径并行（顺序上先 spawn，日志即连在一起）
    _spawn_background(_backfill_adopted_history(account_id, label))
    results = await asyncio.gather(
        async_fetch_accounts([account_id], label=f"VTuber#{vtuber_id}"),
        async_fetch_first_screen(account_id),
        return_exceptions=True,   # 两条路径内部各自兜异常，互不牵连
    )
    # 首屏抓取完成 ⇒ 报一条（M5-2b，devlog/259）。⚠️ 这条原本住在 `TopBar` 的
    # `post.last_result` 分支里（v0.9.4 的「新 V 首屏抓取完成 · 投稿 N · 动态 M · 入库 K」），
    # 而 M5-2b 把汇总交给后端之后那个分支就没了 —— 收录/加账号是**用户发起的动作**，
    # 它的完成反馈必须和别的手动动作一样由后端出（`services/notices` 的环形缓冲 + 推送）。
    #
    # `originator=""`（空串）是有意的：**发起方自己也要看到**（旧行为就是本地弹胶囊），
    # 而"空串不等于任何宿主" ⇒ 所有窗口都播（见 `_host_of` 的注释）。
    first_screen = results[1] if len(results) > 1 else None
    if first_screen is not None and not isinstance(first_screen, BaseException):
        _note_manual_done(
            f"新 V 首屏抓取完成 · 投稿 {getattr(first_screen, 'videos', 0) or 0}"
            f" · 动态 {getattr(first_screen, 'dynamics', 0) or 0}"
            f" · 入库 {getattr(first_screen, 'stored', 0) or 0}",
            "",
        )


async def _backfill_adopted_history(account_id: int, label: str = "") -> None:
    """收录后回填该账号的第三方历史（粉丝历史 / 直播场次 / 礼物日）。

    2026-09-08（用户）：「历史直播场次与粉丝数来自第三方站点，应在首次添加时
    同步获取」——此前只在每日定时任务里跑（全量口径），新收录的 V 当天看不到
    历史数据。这里按 account_id 白名单只回填这一个账号，避免全量扫站。

    2026-09-09（用户）：回填期间要在顶栏状态胶囊里可见，完成后要发事件让档案卡片
    刷新（否则停在档案视图不动的用户，粉丝趋势/直播日历会一直是空的）——
    因此进入/退出时登记 `external_task_started/finished`，前端据 `external.seq`
    变化发 `fetch-idle`（见 TopBar）。

    `label`：给用户看的任务名（由端点从请求会话里取好传入，避免这里再开一次库）。
    """
    sched = _sched()
    token = f"adopt:{account_id}"
    display = label or f"account#{account_id}"
    label = f"{display} 的历史数据"
    sched.external_task_started(token, label)
    logger.info(f"收录回填开始 account#{account_id}（{label}：粉丝历史/直播场次/礼物日）")
    try:
        from app.services.externals.runner import run_external_interval

        results = await run_external_interval("daily", account_ids=[account_id])
        logger.info(f"收录回填 account#{account_id} 完成: "
                    f"{[r['kind'] for r in results]}")
    except Exception as e:  # 回填失败不影响收录本身
        logger.warning(f"收录回填 account#{account_id} 失败: "
                       f"{type(e).__name__}: {e}")
    finally:
        sched.external_task_finished(token)


@router.get("/vtuber/pool/search")
def search_pool(kw: str, db: Session = Depends(get_db)):
    """本地候选检索（**两个来源合并**，R11 devlog/083）：

    1. `vtubers.csv` 离线候选池（`pool.search_pool`，带粉丝数，按粉丝降序）；
    2. `thirdparty_vtubers`（danmakus 周级索引，本地表、零上游请求）—— 覆盖池快照之后
       新出现的 V，`group_name` 还能给出企划/公会线索。

    两条来源按 `(platform, platform_uid)` 去重（池优先，名称更规范），并剔除已入库账号。
    返回项带 `origin`：`pool` / `index`，前端据此标注来源。
    示例: GET /vtuber/pool/search?kw=塔菲
    """
    kw = (kw or "").strip()
    if not kw:
        return []
    existing = {
        (a.platform, str(a.platform_uid))
        for a in db.query(Account.platform, Account.platform_uid).all()
    }

    merged: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for h in pool.search_pool(kw, limit=20):                    # ① csv 池优先
        key = (h["platform"], str(h["platform_uid"]))
        if key in seen:
            continue
        seen.add(key)
        merged.append({**h, "origin": "pool"})
    for it in ThirdpartyVtuberRepo(db).search(kw, limit=20):    # ② 第三方索引兜底
        key = (it.platform, str(it.platform_uid))
        if key in seen:
            continue
        seen.add(key)
        merged.append({"name": it.name, "platform": it.platform,
                       "platform_uid": str(it.platform_uid),
                       "group": it.group_name or "", "origin": "index"})
    return [m for m in merged if (m["platform"], str(m["platform_uid"])) not in existing]


@router.get("/vtuber/bili/search", response_model=BiliSearchOut)
async def bili_search(kw: str = Query(""), page: int = Query(1, ge=1),
                      db: Session = Depends(get_db)):
    """**直接从 B 站检索**（R11，devlog/083）：候选池之外的新 V 也能加进来。

    - 纯数字（≥5 位）→ 按 UID 精确查（`acc/info` + `relation/stat`）——B 站搜索接口
      搜不到 uid（实测），所以数字必须直查；
    - 其余 → 用户搜索（`wbi/search/type?search_type=bili_user`，20 条/页，最多 3 页）。

    两条路径都带**搜索页请求头**（缺了会 `-1200 降级过滤` 或**静默 0 条**，见服务模块 docstring），
    并受 `bili_search` 的 0.8s 串行 + 每分钟 20 次上限 + 5 分钟结果缓存约束。
    `error` 非空表示"没取到"，`hint` 是给用户看的原因与建议（前端如实展示，不回退成"没有这个人"）。

    ⚠️ **需要 B 站登录态**（2026-09-15 实测更正）：搜索接口不校验 cookie，但 WBI 签名密钥只能从
    `nav` 取，而 `nav` 未登录回 -101 ⇒ 未登录时两条路径都失败，此时回 `error='not_logged_in'`
    + 提示（**不是** 500，也**不是** `not_found`）。

    ⚠️ 路径刻意是**两段**（`/vtuber/bili/search`，与 `/vtuber/pool/search` 同形）：
    写成一段（`/vtuber/bili-search`）会被先注册的 `/vtuber/{vtuber_id}` 抢走匹配
    → `int_parsing` 422（本批实测踩到）。新增 `/vtuber/xxx` 一段式路径时注意同一坑。
    """
    res = await bili_search_svc.search(kw, page=page)
    existing = {
        (a.platform, str(a.platform_uid))
        for a in db.query(Account.platform, Account.platform_uid).all()
    }
    return BiliSearchOut(
        items=[BiliSearchItemOut(**{**it,
                                    "in_library": (it["platform"],
                                                   str(it["platform_uid"])) in existing})
               for it in res.items],
        page=res.page, total_pages=res.total_pages, has_more=res.has_more,
        error=res.error, hint=res.hint, exact=res.exact, cached=res.cached,
    )


@router.post("/vtuber/adopt", response_model=VTuberOut, status_code=status.HTTP_201_CREATED)
async def adopt_vtuber(data: AdoptRequest, background: BackgroundTasks,
                       db: Session = Depends(get_db)):
    """收录 VTuber：建库后立即调度该 V 的账号信息 + 首屏内容抓取。

    两个来源（R11，devlog/083）：

    | 来源 | 判定 | 名称取谁 |
    |---|---|---|
    | 候选池 | `(platform, uid)` 命中 `vtubers.csv` | 池内规范名（原行为） |
    | B 站直搜 | `source='bilibili'` 且池内没有 | **服务端实查 `acc/info` 的结果**（不信任请求体） |

    池外条目**必须**服务端复核通过才建库：既防伪造（随便填个 uid 就建 V），
    也防脏名（前端传什么名字都不作数）。

    状态码（R11 复核，2026-09-15）：池内无 + 未声明 source → **404**；池外非 bilibili → **400**；
    复核得到"确实没这个人" → **404**；复核**没问到**（未登录 / 网络 / 风控）→ **503** + 原因
    —— 把"你没登录"报成"B 站没这个 UID"是误导（本批实测：未登录时 WBI 取密钥失败）。

    ⚠️ 本端点是 async（要 await 上游复核）；抓取调度仍走 `BackgroundTasks` —— 响应送达后
    才起跑账号信息 ∥ 首屏内容（`_adopt_background`），避免把收录响应拖到抓取结束。
    """
    hit = pool.find_in_pool(data.platform, data.platform_uid)
    if hit:
        name = hit["name"]
        source = "pool"
    elif data.source in _VERIFY_BY_PROFILE:
        # 小红书（第 4 阶段 ④ 第三刀-3，devlog/234）/ 抖音（第二刀，devlog/334）：
        # 两家都**没有**可用的搜索接口（搜索要登录 + 签名）⇒ 直接拿 uid 去问「主页信息」，
        # 既复核了"这个人真的存在"，又拿到规范名（与 B 站那条的复核纪律一致）。
        if data.platform != data.source:
            raise HTTPException(400, f"source='{data.source}' 时 platform 必须也是 {data.source}")
        pf = registry.get_fetcher(data.source)
        info = await pf.fetch_user_info(str(data.platform_uid)) if pf else None
        if not info or not info.get("name"):
            label = _VERIFY_BY_PROFILE[data.source]
            err = getattr(pf, "last_error", None) or {}
            kind = err.get("kind")
            if kind == "cookie_invalid":
                raise HTTPException(503, f"{label} Cookie 没配或已失效 —— 先在登录里粘贴"
                                         f"（{_VERIFY_BY_PROFILE_HINT[data.source]}）")
            if kind in ("risk_control", "captcha"):
                raise HTTPException(503, f"{label}正在风控冷却，稍后再试")
            if kind == "unsupported_input":
                # 输入形态我们解析不了（例：抖音号要搜索接口）⇒ 400 并把"该粘什么"说清楚
                raise HTTPException(400, err.get("msg") or f"没认出{label} uid")
            raise HTTPException(404, f"该 uid 在{label}查不到，未收录")
        name = info["name"]
        source = data.source
    else:
        if data.source != "bilibili":
            raise HTTPException(404, "候选池中不存在该 platform_uid；"
                                     "请用「搜索 B 站」（source='bilibili'）"
                                     "或「小红书 / 抖音 uid」（source='xiaohongshu' / 'douyin'）收录")
        if data.platform != "bilibili":
            raise HTTPException(400, "池外收录目前只支持 bilibili")
        verified = await bili_search_svc.exact_user(str(data.platform_uid))
        if not verified.items:
            # ⚠️ 只有"上游确实说没有这个人"才是 404。未登录 / 网络 / 风控都是**我们没问到**，
            # 报 404 会把"没登录"说成"B 站没有这个 UID"（2026-09-15 实测踩到：
            # 未登录时 WBI 取密钥失败，原来会直接冒成 500）。
            if verified.error in (None, "not_found", "bad_uid"):
                raise HTTPException(404, verified.hint or "该 UID 在 B 站查不到，未收录")
            raise HTTPException(503, verified.hint or f"B 站暂不可用（{verified.error}）")
        name = verified.items[0]["name"]
        source = "bilibili"

    exists = db.query(Account).filter(
        Account.platform == data.platform,
        Account.platform_uid == data.platform_uid,
    ).first()
    if exists:
        raise HTTPException(409, f"该账号已入库（VTuber#{exists.vtuber_id}）")

    vtuber = VTuber(name=name, faction=data.faction)
    db.add(vtuber)
    db.flush()
    acc = Account(
        vtuber_id=vtuber.id,
        platform=data.platform,
        platform_uid=data.platform_uid,
        display_name=name,
    )
    db.add(acc)
    try:
        db.commit()
    except IntegrityError:
        # 并发收录竞态：exists 检查后另一请求先插入，撞唯一约束 → 409 而非 500
        db.rollback()
        raise HTTPException(409, f"该账号已入库（并发收录冲突）") from None
    db.refresh(vtuber)
    logger.info(f"收录 VTuber#{vtuber.id} 「{name}」({data.platform}:{data.platform_uid}) "
                f"来源={source}")

    # 响应送达后由事件循环执行：账号信息 + 首屏内容并发，第三方历史后台补
    background.add_task(_adopt_background, vtuber.id, acc.id,
                        acc.display_name or acc.platform_uid)
    return _vtuber_out(db, vtuber)


@router.post("/vtuber/fetch-accounts")
async def batch_fetch_accounts(background: BackgroundTasks):
    """批量任务：全量抓取所有 VTuber 的账号信息（后台执行，立即返回）。"""
    if manual_task_running():
        raise HTTPException(409, "已有抓取任务正在进行中，请稍后再试")
    background.add_task(async_fetch_and_update)
    return {"status": "started"}


# ── 第三方数据（粉丝历史 / 直播场次 / 礼物日）：现状 + 手动拉取 ──────────────
# 2026-10-05（用户）：「批量任务里加一个拉取第三方数据的选项，当前如果历史第三方数据
# 丢失了就没法获取了，例如恬豆发芽了 9.28-10.2 的直播记录」。
#
# 为什么需要它：第三方数据的入库**只有两条自动路径**（每日批次 / 收录回填），
# 而它们都会失败（danmakus 的 WAF 拦、上游抖动）或被清掉（归档/重装/手动删库）——
# 那时界面上既看不出缺了什么，也没有任何手动入口，只能等下一次定时任务（`devlog/275`）。
# 上游那两个端点**一次返回全部历史**（channel 全量场次、粉丝历史 2023 至今），
# 所以"补一段缺口"不需要日期参数：拉一次就是全量幂等 upsert
# （`(account_id, live_id)` / `(account_id, source, 日期)` 去重）。
#
# 与手动抓取（账号/帖子）的关系：**不占那两把锁**、可以并行（同收录回填的口径），
# 所以这里的 409 只针对"另一个第三方任务已经在跑"—— 避免同时打第三方站点。

def _external_running() -> bool:
    """第三方数据任务在跑吗。"""
    st = get_fetch_status()
    return bool((st.get("external") or {}).get("running"))


async def _refresh_thirdparty(account_ids: list[int] | None, label: str, token: str) -> None:
    """后台跑一次第三方数据拉取（`account_ids=None` = 全量）。

    与收录回填（`_backfill_adopted_history`）**同一条实现**，只差三处：
    ① `auto=False` —— 这是用户点的按钮，进度必须立刻可见（那条口径见
    `scheduler.external_task_started` 的注释）；
    ② 结束时报一条**完成回执**（走 `_note_manual_done`，进通知面板）；
    ③ 摘要带"新增 N 条"，否则用户点完不知道到底补到了没有。
    """
    sched = _sched()
    sched.external_task_started(token, label, auto=False)
    logger.info(f"第三方数据拉取开始：{label}（账号 {account_ids or '全部'}）")
    stored = skipped = 0
    failed: list[str] = []
    try:
        from app.services.externals.runner import run_external_interval

        results = await run_external_interval("daily", account_ids=account_ids)
        for r in results:
            stored += int(r.get("stored") or 0)
            skipped += int(r.get("skipped") or 0)
            if r.get("error"):
                failed.append(f"{r.get('label') or r.get('kind')}：{r['error']}")
        logger.info(f"第三方数据拉取完成：{label} 新增 {stored}，跳过 {skipped}"
                    + (f"，失败 {failed}" if failed else ""))
        if not results:
            # 一个源都没跑 = 总开关/按源开关关着。**别说成"新增 0 条"**（那是"拉到了但没有新数据"）
            _note_manual_done("第三方数据没有可跑的任务：设置 → 抓取设置里那一项可能关着", "")
        elif failed and stored == 0:
            _note_manual_done(f"第三方数据拉取失败：{'；'.join(failed[:2])}", "")
        else:
            tail = f"（{len(failed)} 项失败：{failed[0]}）" if failed else ""
            _note_manual_done(f"第三方数据拉取完成 · 新增 {stored} 条{tail}", "")
    except Exception as e:      # 拉取失败不影响别的功能，但**必须留痕**
        logger.warning(f"第三方数据拉取失败：{label} {type(e).__name__}: {e}")
        _note_manual_done(f"第三方数据拉取失败：{type(e).__name__}", "")
    finally:
        sched.external_task_finished(token)


@router.get("/vtuber/{vtuber_id}/thirdparty")
def thirdparty_overview(vtuber_id: int, db: Session = Depends(get_db)):
    """这个 V 的第三方数据现状（条数 + 最新日期 + 两个源开没开）。

    界面拿它渲染「第三方数据」小窗：**对着缺口一眼能看出最新日期停在哪**，
    这也是那个「重新拉取」按钮的前提（不知道有什么，就不知道要不要补）。
    """
    if VTuberRepo(db).get(vtuber_id) is None:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    from app.services.externals.overview import overview, sources_state

    return {**overview(db, vtuber_id), "sources": sources_state(),
            "running": _external_running()}


@router.post("/vtuber/{vtuber_id}/thirdparty/refresh")
async def thirdparty_refresh(vtuber_id: int, background: BackgroundTasks,
                             db: Session = Depends(get_db)):
    """**手动补这个 V 的第三方数据**（后台执行，进度见顶栏胶囊）。

    按账号白名单只打这个 V 的 B 站账号（通常 1 个）—— 与收录回填同一口径，
    避免为一条记录全量扫一遍第三方站点。
    """
    v = VTuberRepo(db).get(vtuber_id)
    if v is None:
        raise HTTPException(404, f"VTuber id={vtuber_id} 不存在")
    if _external_running():
        raise HTTPException(409, "已有第三方数据任务在跑，等它跑完再试")
    ids = [a.id for a in db.query(Account).filter(
        Account.vtuber_id == vtuber_id, Account.platform == "bilibili").all()]
    if not ids:
        raise HTTPException(400, "这个 V 没有 bilibili 账号 —— 第三方数据是按 B 站账号拉的")
    # ⚠️ `add_task(可调用对象, 参数…)` —— **不能**写成 `add_task(_refresh_thirdparty(…))`：
    #    那样是"现在就把协程建出来"再交给 starlette，它在后台线程里 call 一个协程对象
    #    ⇒ `TypeError: the first argument must be callable`（本批第一次就踩了，
    #    两条用例当场红；库里别处的 `add_task(_adopt_background, …)` 是正确形状）。
    background.add_task(_refresh_thirdparty, ids, f"{v.name} 的第三方数据", f"manual:{vtuber_id}")
    return {"status": "started", "accounts": ids}


@router.post("/vtuber/batch/fetch-externals")
async def batch_fetch_externals(background: BackgroundTasks):
    """批量任务：**全量**拉一次第三方数据（所有 B 站账号）—— 与每日批次同口径。

    ⚠️ 与上面那个单 V 版共用 `_refresh_thirdparty`：两处的开关、报错、回执口径必须一致
    （这也是"批量任务里那一项"与"某个 V 的补拉"能放在同一份文档里讲的原因）。
    """
    if _external_running():
        raise HTTPException(409, "已有第三方数据任务在跑，等它跑完再试")
    background.add_task(_refresh_thirdparty, None, "第三方数据（全量）", "manual:all")
    return {"status": "started"}


@router.post("/vtuber/batch/fetch-all-posts")
async def batch_fetch_all_posts(background: BackgroundTasks):
    _require_content_fetch()
    if manual_task_running():
        raise HTTPException(409, "已有抓取任务正在进行中，请稍后再试")
    background.add_task(async_fetch_all_posts)
    return {"status": "started"}


@router.post("/vtuber/batch/update-unarchived")
async def batch_update_unarchived(background: BackgroundTasks):
    _require_content_fetch()
    if manual_task_running():
        raise HTTPException(409, "已有抓取任务正在进行中，请稍后再试")
    background.add_task(async_update_unarchived_posts)
    return {"status": "started"}


@router.post("/vtuber/batch/archive")
def batch_archive(days: int = Query(30, ge=1), db: Session = Depends(get_db)):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    n = PostRepo(db).archive_before(cutoff)
    return {"status": "done", "archived": n}
