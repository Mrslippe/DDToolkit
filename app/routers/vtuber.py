import asyncio
import json
import logging
from datetime import date, datetime, timedelta, timezone

from pathlib import Path

from fastapi import (APIRouter, BackgroundTasks, Depends, File, Header, HTTPException,
                     Query, UploadFile, status)
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.domain.live_manual import (VodUrlError, is_manual_source, normalize_vod,
                                    to_utc_naive)
from app.core.timecn import CN_TZ
from app.models.vtuber import EVENT_KINDS, VTuber, Post, Account, LiveSession
from app.repositories.vtuber_repo import (
    VTuberRepo, AccountRepo, PostRepo, AccountStatSnapshotRepo,
    LiveGiftDayRepo, ThirdpartyVtuberRepo, VtuberEventRepo, LiveSessionRepo,
    LiveCategoryOverrideRepo, ProfileCardRepo, _SOURCE_PRIORITY,
)
from app.services.live_settle import (
    for_group, group_states, normalize_stored_category, settle_fields,
)
from app.schemas.vtuber import (
    VTuberOut, VTuberCreate, VTuberUpdate,
    AccountOut, AccountCreate, AccountUpdate,
    PostOut, PostCreate, PostUpdate, PostPage, PostStats,
    AccountStatSnapshotOut, LiveGiftDayOut, ThirdpartyVtuberOut,
    FanTrendPoint, LiveSessionOut, LiveCategoryOut, LiveSessionDetailOut,
    LiveTypeStatsOut, LiveTypeStatOut,
    LiveSessionManualIn, LiveSessionUpdateIn, LiveSessionDeleteOut,
    VtuberEventOut, VtuberEventCreate, VtuberEventUpdate, FutureReservationOut,
    ProfileCardOut, ProfileLayoutIn,
    FormerValueOut, VTuberFormerValuesOut,
    VtuberAvatarVersionOut, VTuberAvatarsOut,
    NoticeOut, NoticesOut, NoticeAckIn, NoticeAckOut,
    BiliSearchOut, BiliSearchItemOut, NameSearchOut, NameSearchGroupOut,
)
from app.services import pool
from app.services import name_search as name_search_svc
from app.services import groups
from app.services import bili_search as bili_search_svc
from app.services import capabilities
from app.services.platforms import registry
from app.services.purge import purge_account, purge_vtuber
from app.services.live_type import EDITABLE_CATEGORY_KEYS, LIVE, TYPE_DISPLAY_ORDER
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
                                LiveWordOut, LiveUpstreamOut,
                                VodCandidateOut, VodCandidatesOut,
                                VodAccountProfileOut, VodAccountProfilesOut,
                                VodAccountScanOut, VodAltOut, VodApplyIn, VodApplyItemIn,
                                VodApplyOut, VodApplyResultOut, VodClearIn, VodClearOut,
                                VodMatchOut, VodScanIn,
                                VodScanOut, VodSourceListOut, VodSourceOut,
                                VodUnmatchedOut)
from app.services import vod_finder
from app.services import vod_scan as vod_scan_svc
from app.services import vod_source as vod_source_svc
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
    """场次类型上下文（列表端/详情端共用）：账号 + 用户校正表。

    ⚠️ 2026-10-12（类型落库）之后**不再有 `vtuber`/事件日**：类型改成**写时就定稿**
    （只看这一场自己的标题/分区，见 `app/services/live_settle.py`），读取侧只剩
    一道「用户校正」覆盖。需要 V 的端点自己取（`AccountRepo.get(...).vtuber`），
    别把它们塞回这里 —— 那正是上一版"读取时推断"留下的尾巴。
    """
    account = AccountRepo(db).get(account_id)
    overrides = LiveCategoryOverrideRepo(db).map_by_account(account_id)
    return account, overrides


def _resolve_categories(db: Session, account_id: int, sessions: list[dict],
                        overrides: dict,
                        stored: dict[str, tuple[str, str]] | None = None,
                        ) -> list[tuple[str, str]]:
    """每个合并组的最终类型（与 `sessions` 同序）+ **惰性回填 / 物化**。

    信号栈（v3，2026-10-12 类型落库）：
        override（用户校正）  >  落库值（写时定稿）  >  按同一口径现算  >  中性

    为什么还要"现算"这一层：落库值对**没有表内行**的合并组（虚拟场次）与**尚未补过**
    的老行是空的。现算用的函数与写路径**同一个**（`live_settle.settle`）⇒ 两条路不会跑偏。

    惰性补（用户 2026-10-12 选定）：迁移会自动跑、`scripts/backfill_*.py` 不会，
    所以老库那批的列会一直是 NULL —— 在这里**顺手补一次**（补类型 + 补"这一场是谁"，
    见 `_stored_by_live_id`），补过就不再补，用户不需要跑任何脚本。

    `stored`：调用方**已经**算过 `_stored_by_live_id` 时直接传进来 —— 同一个请求里
    再算一遍等于把物化那趟（全账号装载 + 比对）白跑一次。
    """
    if stored is None:
        stored = _stored_by_live_id(db, account_id, sessions)
    out: list[tuple[str, str]] = []
    for s in sessions:
        hit = _override_hit(s, overrides)
        if hit:
            out.append((hit, "override"))
            continue
        live_id = s.get("live_id")
        out.append(for_group(s, stored.get(live_id) if live_id else None))
    return out


def _override_hit(s: dict, overrides: dict) -> str | None:
    """这一场的用户校正（按对外 id 查，**也认源 id**）。

    为什么认源 id：合并会把对外 id 定权成最高优先级源，而校正可能是在"这一场还只有
    feed 行"的时候设的（那时它还是数字 id）。与 `_find_live_session` 同一条理由。
    """
    if not overrides:
        return None
    live_id = s.get("live_id")
    if live_id and live_id in overrides:
        return overrides[live_id]
    for src_id in (s.get("src_live_ids") or {}).values():
        if src_id in overrides:
            return overrides[src_id]
    return None


def _stored_by_live_id(db: Session, account_id: int,
                       sessions: list[dict]) -> dict[str, tuple[str, str]]:
    """合并组的代表行 → 落库的 (category, category_from)。**只读**（不写库）。

    代表行 = `merged()` 给这个组定的对外 `live_id`（与 `live_settle.group_states` 同一条）。

    ⚠️⚠️ **`sessions` 必须来自 `merged(..., with_ids=True)`**：本函数靠 `src_live_ids`
    定位代表行，用默认的 `merged()` 会**静默**返回空表 —— 症状是"落库值明明写着，
    界面却按现算显示"（判据 `test_stored_lookup_needs_src_live_ids` 就是钉这一条的）。

    返回的是**归一过**的值（认不出来的枚举 ⇒ 中性，见 `normalize_stored_category`）：
    调用方拿到就能直接展示，不必各自再判一次"这个 key 认不认识"。

    ⚠️ **读端点不写库**（2026-10-13 补，`devlog/473`）：场次身份（`session_key`）与类型的
    补齐都搬去了**启动期**（`app/services/live_identity.py`）与**写点之后**。第一版把它们
    放在这里"顺手补"，代价是**第一次打开最慢**（真机 `/live-sessions` 464ms 冷 vs 170ms 热），
    而前端恰恰在还没有任何场次时显示加载块 —— 用户看得见那一下。
    读路径现在只读：`mode=ro` 的库也能读（`scripts/measure_endpoints.py` 因此不用再 `--write`）。
    """
    if not sessions:
        return {}
    rows = [r for r in LiveSessionRepo(db).list_by_account(account_id) if r.live_id]
    by_live = {r.live_id: r for r in rows}
    out: dict[str, tuple[str, str]] = {}
    for s in sessions:
        rep = _representative_id(s)
        if not rep:
            continue                     # 纯虚拟场次（没有表内行可挂）
        # `stored_category` 是"这一场定稿过没有"的**权威读数**（写点/启动期补齐时算的）：
        # 键不存在 ⇒ 这组还没装配过（例如同步刚插进来的新行）⇒ 退回读行。
        if "stored_category" in s:
            stored = s["stored_category"]
        else:
            row = by_live.get(rep)
            stored = (row.category, row.category_from) if row is not None else None
        if stored is not None and stored[0] is not None:
            out[rep] = normalize_stored_category(*stored)
    return out


def _representative_id(s: dict) -> str | None:
    """合并组的代表行 live_id —— **`merged()` 给这个组定的对外 id**（纯虚拟场次 ⇒ None）。

    ⚠️ 不要在这里自己按源优先级再排一遍：那条规则的 tie-break（同源两行时取谁）
    是 `merged()` 的实现细节，自己排就会与对外 id 分叉 —— 而读取侧是按对外 id
    查落库值的，分叉的症状是"这一场的类型**静默**退回现算/兜底"。
    与 `live_settle.group_states` 用的是同一条（那边也读 `s["live_id"]`）。
    """
    live = {k: v for k, v in (s.get("src_live_ids") or {}).items() if v}
    if not live:
        return None
    rep = s.get("live_id")
    if rep and rep in live.values():
        return rep
    return None if live.get("self") else min(v for v in live.values())


def materialize_group_identity(db: Session, account_id: int,
                               sessions: list[dict]) -> tuple[dict, list]:
    """把合并视图的分组结论落库（服务层算、仓库写）——**写点之后**调它。

    给"刚写完这一行"的路径用：手动增删改之后的回执（`_manual_detail`）——
    与"写这一行就定稿这一行"同一个口径（用户 2026-10-12）。⚠️ **读端点不调它**
    （读路径只读，见 `live_identity` 模块头）。

    ⚠️ 它顺带把这一账号的"已装配"记号**打上**（`devlog/475`）：装配过了就不必让
    下次启动再扫一遍；这条路径失败了也不会留下假记号（调用方先 `mark_identity_dirty`）。

    返回 `(仓库计数, 物化目标)`。
    """
    states = group_states(sessions)
    stats = LiveSessionRepo(db).materialize_sessions(account_id, states)
    from app.repositories.vtuber_repo import AppMetaRepo
    from app.services.live_identity import identity_mark_key

    AppMetaRepo(db).set(identity_mark_key(account_id), "1")
    return stats, states


def mark_identity_dirty(db: Session, account_id: int) -> None:
    """这一账号的场次行要变了 ⇒ 把"已装配"记号作废（`devlog/475`）。

    ⚠️ 顺序是**先作废、后装配**：装配失败时记号必须已经是空的，否则下次启动会**跳过**
    这个账号（"跳过 ⇒ 永久陈旧"是本批要防的那个错法）。
    """
    from app.services.live_identity import mark_dirty

    mark_dirty(db, account_id)


def _session_payload(s: dict, account_id: int, category: str,
                     category_from: str) -> dict:
    """场次响应的公共载荷（列表 / 详情 / 写回执三个端点共用）。

    ⚠️ 类型（`category`/`category_from`）的取法**不在这里**，见 `_resolve_categories`
    （写时定稿 + 校正覆盖 + 同一口径现算）；这里只负责组装。
    ⚠️ 三个内部键要滤掉（`src_live_ids` 用于定位代表行，`stored_category`/
    `resolved_category` 是读取过程中的中间量）—— 它们不是契约的一部分。

    `manual` 在这里**算一次**（域层纯函数 `is_manual_source`）：
    让前端自己按 `+` 拆 `source` 的话，「哪些场次能改时间、哪些能删」这条规则
    就有了两份实现，而两份实现漂移时**什么都不红**（服务端照样该拒就拒，
    用户只会看到按钮点了报错）。
    """
    return {"account_id": account_id,
            **{k: v for k, v in s.items()
               if k not in ("src_live_ids", "stored_category",
                            "resolved_category")},
            "category": category, "category_from": category_from,
            "manual": is_manual_source(s.get("source"))}


@router.get("/account/{account_id}/live-sessions", response_model=list[LiveSessionOut])
def live_sessions(account_id: int, types: str | None = None,
                  db: Session = Depends(get_db)):
    """直播场次（v0.9.x 内容管道 M1 主源 + 类型落库 v3，2026-10-12）。

    - 表内场次（danmakus 历史全量，M1 回填；feed M3 增量）
    - self 快照推导场次（5min 粒度，自观测兜底，±90min 窗口合并）
    - 每场附带类型：**落库值**（写这一行的时候按它自己的标题/分区定稿过）
      ← 用户校正覆盖；没有落库值的组（虚拟场次 / 未回填的老行）按**同一口径现算**。
      ⚠️ v2 那两个全局档（series 骨架聚类 / learned 反哺词库）已下线 ——
      它们要看"同账号、全历史"，与"只看这一场"的落库口径冲突（见 live_settle 模块头）。

    `types`（T4，2026-10-12）：逗号分隔的类型 key，**只返回这几类的场次**（不传 = 全部）。
    ⚠️ **在合并结果上筛**（不是 SQL `WHERE`）：一个合并组可能由 danmakus + feed 两行组成，
    类型取的是组里优先级最高的非空值（C2）—— 直接按列筛会把"两行一起才构成的那一场"
    筛掉一半。收益照旧：载荷小了，且"什么算这一类"只有服务端一份实现。
    """
    account, overrides = _live_infer_ctx(db, account_id)
    if not account:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    sessions = LiveSessionRepo(db).merged(account_id, with_ids=True)
    cats = _resolve_categories(db, account_id, sessions, overrides)
    wanted = _parse_types(types)
    out = []
    for s, (cat, src) in zip(sessions, cats):
        if wanted is not None and cat not in wanted:
            continue
        out.append(LiveSessionOut(**_session_payload(
            {k: v for k, v in s.items() if k != "src_live_ids"},
            account_id, cat, src)))
    return out


def _parse_types(types: str | None) -> set[str] | None:
    """`types=a,b` → `{a, b}`；空/全是空白 ⇒ None（= 不筛）。

    ⚠️ 认不出的值**不报错**（只是筛不出东西）：体系调整期间前端可能带着一个刚下线的
    类型值来，422 会让整个日历红掉，而"这一类现在没有场次"才是事实。
    """
    if not types:
        return None
    got = {t.strip() for t in types.split(",") if t.strip()}
    return got or None


@router.get("/account/{account_id}/live-type-stats", response_model=LiveTypeStatsOut)
def live_type_stats(account_id: int, db: Session = Depends(get_db)):
    """按类型统计场次数（T4，2026-10-12；f017 改直查索引）：数据视图「场次类型」卡片用。

    ⚠️ **口径与日历一字不差，但成本从"每请求一次 merged()"降到一条索引聚合**（f017）：
    f016 刚落地时这里只能走合并视图 —— 因为按列聚合会同时错两头
    （兜底写 NULL ⇒ 那 55% 看不见；同一场多行 ⇒ 按行数多算）。
    f017 把那两件事补上之后（`session_key` 只写在代表行上 + 兜底也落 `'live'`），
    `(account_id, category)` 上的聚合与合并视图**逐类等数**
    （真机 14 账号对照：`scripts/check_type_index_parity.py`）。

    三段拼起来才是日历那个数：
      ① 代表行的 `category`（每场一行，索引聚合）
      ② 用户校正（override）压上去 —— 校正**不并进列**（清空校正要能回到推导值）
      ③ 虚拟场次（self 快照推导，没有行）现算加上

    `classified`（"定稿过"的场次数）**仍然按落库值算**（`category_from` 不是 `fallback`）：
    它是"规则认出多少"的读数，与 `total` 的差就是卡片上那句"另有 N 场暂按中性显示"。
    """
    account, overrides = _live_infer_ctx(db, account_id)
    if not account:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    sessions = LiveSessionRepo(db).merged(account_id, with_ids=True)
    counter, classified = _category_counts(db, account_id, sessions, overrides)
    # 顺序 = 前端的展示顺序（固定，免得卡片每次开都换排列）；兜底 `live` 永远排最后
    order = [*TYPE_DISPLAY_ORDER, LIVE]
    items = [LiveTypeStatOut(category=c, count=counter[c])
             for c in order if counter.get(c)]
    total = sum(counter.values())
    if total != len(sessions):
        # f017 的不变量：按列聚合 = 合并视图。不一致时**以合并视图为准**并如实记日志 ——
        # 500 会把一屏数据变成一句报错，而用户真正需要的是那一屏（他也没有别的入口核对）。
        # 判据在测试里（`test_live_type_stats_matches_the_calendar` 逐类比对 + 反向验证）。
        logger.warning(
            f"按类型统计与合并视图不等价：account={account_id} "
            f"按列={total} 合并={len(sessions)}（f017 的物化可能没跑完）")
    return LiveTypeStatsOut(total=len(sessions), items=items, classified=classified)


def _category_counts(db: Session, account_id: int, sessions: list[dict],
                     overrides: dict) -> tuple[dict[str, int], int]:
    """按类型的场次计数 —— **直查 `(account_id, category)` 索引**（f017）。

    返回 `(counter, classified)`。`sessions` = `merged(..., with_ids=True)`，两处用：
    ① 触发惰性物化（`_stored_by_live_id`，与日历同一个入口 ⇒ 数字天然同源）；
    ② 补上**虚拟场次**（self 快照推导、表里没有行 ⇒ 没有 `session_key`）。

    ⚠️ 只数 `session_key IS NOT NULL` 的行（代表行）：同一场可能有多行，
    而"哪些行是同一场"由合并规则定（物化时写进 `session_key`，见 `live_settle`）。
    """
    _stored_by_live_id(db, account_id, sessions)      # 顺带物化（补过就不再补）
    rows = (
        db.query(LiveSession.category, func.count(func.distinct(LiveSession.session_key)))
        .filter(LiveSession.account_id == account_id,
                LiveSession.session_key.isnot(None),
                LiveSession.category.isnot(None))
        .group_by(LiveSession.category)
        .all()
    )
    counter: dict[str, int] = {}
    for category, n in rows:
        cat, _src = normalize_stored_category(category)
        counter[cat] = counter.get(cat, 0) + int(n or 0)
    classified = int(
        db.query(func.count(LiveSession.id))
        .filter(LiveSession.account_id == account_id,
                LiveSession.session_key.isnot(None),
                LiveSession.category_from.isnot(None),
                LiveSession.category_from != "fallback")
        .scalar() or 0
    )
    # ② 虚拟场次：没有行 ⇒ 现算加上。它们一律算"定稿"（不是推导就是兜底）。
    for s in sessions:
        if any(v for k, v in (s.get("src_live_ids") or {}).items()
               if v and k != "self"):
            continue
        cat, _src = settle(s.get("live_title"), s.get("area_name"),
                           s.get("parent_area_name"), s.get("start_at"))
        counter[cat] = counter.get(cat, 0) + 1
        classified += 1
    # ③ 用户校正：压在落库值上面（**不并进列** —— 清空校正要能回到推导值）
    for live_id, want in (overrides or {}).items():
        row = (db.query(LiveSession.category)
               .filter(LiveSession.account_id == account_id,
                       LiveSession.live_id == live_id,
                       LiveSession.session_key.isnot(None))
               .first())
        if row is None:
            # 校正指向的行不存在、或它不是这一场的代表行 —— 两条都不该发生；
            # 如实留一条日志，别把数字悄悄算错。
            logger.debug(f"校正未落到代表行：account={account_id} live_id={live_id}")
            continue
        old, _f = normalize_stored_category(row[0])
        counter[old] = max(counter.get(old, 0) - 1, 0)
        counter[want] = counter.get(want, 0) + 1
    return counter, classified


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
    account, overrides = _live_infer_ctx(db, account_id)
    if not account:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    sessions = LiveSessionRepo(db).merged(account_id, with_ids=True)
    s = _pick_live_session(db, account_id, live_id, sessions)
    idx = next(i for i, x in enumerate(sessions) if x is s)
    s = dict(s)
    s.pop("src_live_ids", None)      # 只用于定位，不回给前端
    category, category_from = _resolve_categories(db, account_id, sessions,
                                                  overrides)[idx]
    return LiveSessionDetailOut(**_session_payload(s, account_id,
                                                  category, category_from))


# ── 手动记录场次（B2，devlog/454） ──────────────────────────────────

def _conflict_message(hit: dict) -> str:
    """409 的中文原因：**说清撞上哪一场 + 下一步怎么做**。

    为什么不是一句"时间冲突"：这个入口的失败九成是用户想给**已有的**那一场补信息，
    而"改哪一条"是他自己才知道的事 —— 把那一场的标题/时间段/来源摆出来他才判得了。
    """
    # 库里是 naive UTC ⇒ 先标明时区再转业务时区，否则东八区用户看到的时间早 8 小时
    def _cn(x):
        return x.replace(tzinfo=timezone.utc).astimezone(CN_TZ) if x.tzinfo is None else x.astimezone(CN_TZ)

    start = _cn(hit["start_at"]).strftime("%m-%d %H:%M")
    end = hit.get("end_at")
    span = f"{start}–{_cn(end).strftime('%H:%M')}" if end else f"{start} 起"
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
    account, overrides = _live_infer_ctx(db, account_id)
    sessions = LiveSessionRepo(db).merged(account_id, with_ids=True)
    picked = _pick_live_session(db, account_id, live_id, sessions)
    idx = next(i for i, x in enumerate(sessions) if x is picked)
    s = dict(picked)
    s.pop("src_live_ids", None)
    category, category_from = _resolve_categories(db, account_id, sessions,
                                                  overrides)[idx]
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
                             start_at=start, end_at=end, title=title, vod_url=vod,
                             settled=settle_fields(title, None, None, start))
    # 行变了 ⇒ 场次身份要重算：**先作废记号、再装配**（顺序不能反 —— 装配失败时记号
    # 必须已经是空的，否则下次启动会跳过这个账号，见 `devlog/475`）。
    mark_identity_dirty(db, account_id)
    materialize_group_identity(
        db, account_id, LiveSessionRepo(db).merged(account_id, with_ids=True))
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
    # 类型重算的输入取**变更后**的值（`apply` 优先，回落行上的现值）——
    # 只补录播地址时 `touched` 为假 ⇒ 不重算、不动类型两列（没有新输入）。
    touched = False
    if "start_at" in fields or "end_at" in fields or "title" in fields or "vod_url" in fields:
        start, end, title, vod = _manual_inputs(data)
        if "start_at" in fields:
            apply["start_at"] = start
            touched = True
        if "end_at" in fields:
            apply["end_at"] = end          # 显式 null = 清空（改回"进行中"）
        if "title" in fields:
            apply["title"] = title
            touched = True
        if "vod_url" in fields:
            apply["vod_url"] = vod         # "" → None（清空用户填的链接）
            # ⚠️ 记账（f018）：**用户写的**标 `manual`，清空时因此被保护；
            #    清空动作本身把这一格也清回 NULL（否则会留下"这是手填的"的谎）。
            apply["vod_source"] = "manual" if vod else None
    new_start = apply.get("start_at", row.start_at)
    new_end = apply.get("end_at", row.end_at) if "end_at" in fields else row.end_at
    _check_span(new_start, new_end)
    if "start_at" in apply or "end_at" in apply:
        hit = repo.overlapping(account_id, new_start, new_end, exclude_live_id=live_id)
        if hit:
            raise HTTPException(409, _conflict_message(hit))
    repo.update_row(row, apply, settled=(
        settle_fields(apply.get("title", row.title), row.area_name,
                      row.parent_area_name, new_start) if touched else None))
    mark_identity_dirty(db, account_id)      # 行变了 ⇒ 身份要重算（见 create 那头）
    materialize_group_identity(
        db, account_id, LiveSessionRepo(db).merged(account_id, with_ids=True))
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
    mark_identity_dirty(db, account_id)      # 行没了 ⇒ 身份要重算（见 create 那头）
    materialize_group_identity(
        db, account_id, LiveSessionRepo(db).merged(account_id, with_ids=True))
    return LiveSessionDeleteOut(deleted=True, live_id=live_id)


@router.get("/account/{account_id}/live-sessions/{live_id}/vod-candidates",
            response_model=VodCandidatesOut)
async def live_session_vod_candidates(account_id: int, live_id: str,
                                      mid: str = Query(""),
                                      db: Session = Depends(get_db)):
    """**给这一场找录播**（C1，需求 2.1，`devlog/464`）——只返回候选，**不写任何东西**。

    扫哪些账号：该 V 的 B 站号 + 用户指定的录播号（`vtubers.vod_account_uid`）；
    `mid=` 可以再临时加一个（用户从 B 站搜来的录播号，先用一次看看）。

    ⚠️ 真机实测（2026-10-11）说明为什么这里**只给候选**：12 个 V 里 3 个在时间窗内有投稿，
    而其中一条发布在开播**前 3 小时**、另一条是**音声** —— 单个信号都不可信，
    必须由用户看着"发布时间/时长/为什么像"点一下确认（计划原话：误配比漏配更糟）。
    """
    account, _ov = _live_infer_ctx(db, account_id)
    if not account:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    s = _pick_live_session(db, account_id, live_id)
    mids = vod_finder.default_mids(db, account, account.vtuber)
    extra = (mid or "").strip()
    if extra and extra not in mids:
        mids.append(extra)
    if not mids:
        return VodCandidatesOut(mids=[], window="", items=[],
                                hint="这个 V 还没有 B 站账号，也没有指定录播号 "
                                     "—— 先把录播号填上（在档案设置里）")
    items = await vod_finder.find_candidates(s, mids)
    return VodCandidatesOut(
        mids=mids,
        window=vod_finder.window_text(s.get("start_at")),
        items=[VodCandidateOut(**{**it,
                                  "published_at": it.get("published_at")}) for it in items],
        hint=None if items else ("这些账号在开播前后都没有投稿 —— "
                                 "可能回放在别的录播号上，把它的 mid 填进来再试"),
    )


# ── 录播批量填充（`docs/plans/vod-autofill.md` B3）──────────────────────
#
# 与上面 C1「找录播」的分工：C1 是**单场**、扫投稿、给候选让人点一下；
# 这里是一组**整号批量**的端点：列来源 → 扫描（只读）→ 显式写入。
#
# ⚠️ 三条端点的读写纪律（与 `vod-candidates` 同源）：
#   `vod-sources` / `vod-scan` **绝不写库**；`vod-apply` 只写**显式列出来的** items。


@router.get("/account/{account_id}/vod-sources", response_model=VodSourceListOut)
async def list_vod_sources(account_id: int, mid: str = Query(""),
                           db: Session = Depends(get_db)):
    """列一个 B 站号下**可扫的来源**（系列 / 合集 / 投稿），并给出自动挑中的那一个。

    `mid` 省略 ⇒ 用该 V 记住的录播号里的**第一个**（`vtubers.vod_account_uid` 左 = 高优先）。

    为什么要有这个端点：扫哪个来源**不能猜死**。实测平台侧的自动挑（名字优先、条数次之）
    在这一个号上是对的（挑中「直播回放」942 条），但**名字里没有关键词的系列照样可能全是回放**
    ⇒ 界面上必须能把自动挑的结果改掉。
    """
    account, _ov = _live_infer_ctx(db, account_id)
    if not account:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    target = (mid or "").strip()
    if not target:
        mids = vod_scan_svc.ordered_mids(
            account.platform_uid if account.platform == "bilibili" else None,
            getattr(account.vtuber, "vod_account_uid", None))
        target = mids[0] if mids else ""
    if not target:
        return VodSourceListOut(mid="", sources=[],
                                error="这个 V 还没有可扫的号 —— 先把录播号填上")
    try:
        sources = await vod_source_svc.list_sources(target)
    except Exception as e:                                   # noqa: BLE001
        # 取不到要**如实说**：空列表与"这个号没有合集"是两件事
        return VodSourceListOut(mid=target, sources=[],
                                error=f"没取到来源清单：{type(e).__name__}: {e}")
    picked = vod_source_svc.pick_source(
        [s for s in sources if s["kind"] != "uploads" and (s.get("total") or 0) > 0])
    # ⚠️ **没有合集/系列时挑中的是投稿流**（2026-10-15 修）：与 `vod_scan.resolve_source`
    #    同一条口径 —— 一个号可能"全是投稿"（实测 `94009831`：清单 HTTP 200 但两个列表都空，
    #    1093 条投稿全是录播）。两边口径不一致的话，界面显示的"自动挑中的来源"会和
    #    扫描真正用的那个不是同一个。
    if picked is None:
        picked = next((s for s in sources if s["kind"] == "uploads"), None)
    # 投稿流的 `id` 是空串 ⇒ `picked` 标记不能只靠 id 比，按 `kind` 兜一下
    picked_id = (picked or {}).get("id") if picked else ""
    return VodSourceListOut(
        mid=target,
        sources=[VodSourceOut(**{**s, "picked": bool(
            picked and s["kind"] == picked["kind"] and str(s["id"]) == str(picked["id"]))})
            for s in sources],
        picked_id=picked_id or None,
    )


@router.get("/vtuber/vod-accounts/resolve", response_model=VodAccountProfilesOut)
async def resolve_vod_accounts(mids: str = Query("")):
    """**录播号资料卡**：`mid` → `| 昵称 · mid · 投稿数 |`（2026-10-15 小窗改版）。

    「录播号」小窗里每一行要显示昵称/头像/投稿数，而这两样来自**两个不同的上游接口**
    （昵称走匿名的 `x/web-interface/card`、投稿数走登录态的 `arc/search`）——
    都收在服务层 `vod_source.resolve_account_profiles`，这里只做参数与并发编排。

    - `mids` 逗号分隔（中文逗号也认），**顺序即返回顺序**；
    - **两半各自独立失败**：`name_error` / `uploads_error` 分开给。号有效但昵称没取到时
      界面标黄、**仍然允许保存**（用户 2026-10-15 拍板："允许"）；
    - 超过 `MAX_PROFILE_MIDS` 的**截断**（每个 mid 要打两次上游，不限量就是放大器）。

    ⚠️ 路径得挑**没有 `{vtuber_id}` 路由会撞上**的形状（2026-10-15 实测踩了两次）：
    `/vtuber/vod-accounts`（一段式）被**先注册**的 `/vtuber/{vtuber_id}` 抢走；
    改成两段的 `/vtuber/vod/accounts` 又被 `/vtuber/{vtuber_id}/accounts` 抢走 ——
    两次的症状都是 **422 `int_parsing`（`vtuber_id` 解析不了 `vod`）**，
    而路由根本没进来，看起来像"参数写错了"。现在这一段以 `resolve` 结尾，
    没有任何 `{vtuber_id}` 路由的第二段叫这个名字（`devlog/083` 同款坑）。
    """
    want = [m.strip() for m in (mids or "").replace("，", ",").split(",") if m.strip()]
    items = await vod_source_svc.resolve_account_profiles(want)
    return VodAccountProfilesOut(items=[VodAccountProfileOut(**it) for it in items])


@router.post("/account/{account_id}/vod-scan", response_model=VodScanOut)
async def scan_vod_sessions(account_id: int, data: VodScanIn,
                            db: Session = Depends(get_db)):
    """**只读**扫描：按优先级扫多个录播号，与场次配对 → 给审查表。

    ## 口径（用户 2026-10-14 拍板）

    - **先审查再写**：本端点**一个字节都不写**，结果里每条带 `confidence` / `auto_ok` /
      `minutes_delta`，由用户勾完再走 `vod-apply`；
    - **多号优先级兜底**：`mids` 的顺序就是优先级（左 = 高优先）。
      一个场次被高优先号配上后**不再参与**后面的号 ⇒ 低优先只补缺、不可能覆盖高优先；
    - **已有 `vod_url` 的场次全程不参与**：那是用户手填的（不变量 39），
      也**不算漏配**（不会出现在 `unmatched` 里）。

    ## 为什么不做成后台任务

    实测整个系列 942 条 = 5 个请求（`ps=200`）、单页 0.05–0.13s，端到端不到 2s。
    做成任务反而要轮询、要进度条、要处理"任务丢了"。真机实测见
    `_probe/vod_e2e_probe.py` 的头注释（870/942 配上，时间差中位 50 分）。
    """
    account, _ov = _live_infer_ctx(db, account_id)
    if not account:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    own = account.platform_uid if account.platform == "bilibili" else None
    mids = ([str(m).strip() for m in (data.mids or []) if str(m).strip()]
            or vod_scan_svc.ordered_mids(own, getattr(account.vtuber, "vod_account_uid", None)))
    if not mids:
        raise HTTPException(422, "没有可扫的号：先把这个 V 的录播号填上（或显式传 mids）")
    rows = LiveSessionRepo(db).merged(account_id, with_ids=True)
    src_map = {k: v for k, v in (data.sources or {}).items() if isinstance(v, dict)}

    async def _resolve(mid: str):
        return await vod_scan_svc.resolve_source(mid, want=src_map.get(mid))

    result = await vod_scan_svc.scan(
        rows, mids, resolve=_resolve,
        tolerance_minutes=max(1, min(24 * 60, int(data.tolerance_minutes or 90))))

    return VodScanOut(
        account_id=account_id, mids=mids,
        matches=[_vod_match_out(m) for m in result.matches],
        unmatched=[VodUnmatchedOut(live_id=str(r["live_id"]), start_at=r["start_at"],
                                   live_title=r.get("live_title"),
                                   source=str(r.get("source") or ""))
                   for r in result.unmatched],
        accounts=[VodAccountScanOut(
            mid=a.mid, ok=a.ok,
            source_kind=str((a.source or {}).get("kind") or ""),
            source_name=str((a.source or {}).get("name") or ""),
            item_count=a.item_count, matched=a.matched, error=a.error)
            for a in result.accounts],
        items_total=result.items_total,
        tolerance_minutes=int(data.tolerance_minutes or 90),
    )


def _vod_match_out(m) -> VodMatchOut:
    """内部 `Match` → 出参（**逐条**带上"为什么是它"的三个字段）。"""
    c = m.candidate
    return VodMatchOut(
        live_id=m.live_id, start_at=m.start_at, live_title=m.live_title,
        bvid=c.bvid, title=c.title, permalink=c.permalink, cover_url=c.cover_url,
        published_at=c.published_at,
        duration_minutes=int(c.duration_seconds // 60) if c.duration_seconds else None,
        mid=c.mid, source_name=c.source_name,
        confidence=m.confidence, minutes_delta=m.minutes_delta, auto_ok=m.auto_ok,
        title_hour=(None if (c.hint is None or c.hint.date_only) else c.hint.at.hour),
        date_only=bool(c.hint and c.hint.date_only),
        alternates=[VodAltOut(
            bvid=a.bvid, title=a.title, permalink=a.permalink, mid=a.mid,
            duration_minutes=int(a.duration_seconds // 60) if a.duration_seconds else None,
            confidence=m.confidence) for a in m.alternates],
    )


@router.post("/account/{account_id}/vod-apply", response_model=VodApplyOut)
def apply_vod_matches(account_id: int, data: VodApplyIn, db: Session = Depends(get_db)):
    """把审查表里**勾中的那些**写进 `vod_url`（这是整条链路上唯一会写的端点）。

    三条纪律：

    1. **只写传进来的 items**（没有"顺便全填"这种模式）—— 用户勾了什么就写什么；
    2. **逐条独立**：某一条的地址不合格（422）不让别的失败，结果里逐条给原因
       （静默吞掉一半写入是最难查的形态）；
    3. **地址走与手动填同一个 `normalize_vod`** —— 两条路的规范形态必须一致
       （`VOD_CANONICAL`，`devlog/464`），否则库里会出现两种形态的同一个地址。
    """
    if not AccountRepo(db).get(account_id):
        raise HTTPException(404, f"Account id={account_id} 不存在")
    if not data.items:
        raise HTTPException(422, "没有要写入的条目")
    repo = LiveSessionRepo(db)
    out = VodApplyOut()
    dirty = False
    for it in data.items:
        live_id = str(it.live_id or "").strip()
        row = repo.get_row(account_id, live_id) if live_id else None
        if row is None:
            out.failed += 1
            out.results.append(VodApplyResultOut(
                live_id=live_id, ok=False,
                error="这一场不在表内（自动推导的场次没有 id，补不了录播）"))
            continue
        try:
            vod = normalize_vod(it.vod_url)
        except VodUrlError as e:
            out.failed += 1
            out.results.append(VodApplyResultOut(live_id=live_id, ok=False, error=str(e)))
            continue
        if not vod:
            out.failed += 1
            out.results.append(VodApplyResultOut(
                live_id=live_id, ok=False, error="录播地址是空的"))
            continue
        # 与 PATCH 同一条写路径：`touched=False` ⇒ 不重算类型（只补录播地址，没有新输入）
        # `vod_source='match'`（f018）：记账"这是自动匹配写的" ⇒ "清空已匹配"能**不看网络**
        # 就把它们清掉，同时绝不碰手填的（不变量 39）。
        repo.update_row(row, {"vod_url": vod, "vod_source": "match"}, settled=None)
        dirty = True
        out.applied += 1
        out.results.append(VodApplyResultOut(live_id=live_id, ok=True, vod_url=vod))
    if dirty:
        # 行变了 ⇒ 场次身份要重算（与手动增删改同一条口径，`devlog/475`）
        mark_identity_dirty(db, account_id)
        materialize_group_identity(
            db, account_id, LiveSessionRepo(db).merged(account_id, with_ids=True))
    return out


@router.post("/account/{account_id}/vod-clear", response_model=VodClearOut)
def clear_vod_matches(account_id: int, data: VodClearIn, db: Session = Depends(get_db)):
    """**硬清这个账号下所有已匹配的录播地址**（用户 2026-10-15，第二次改口径）。

    ## 口径：全清，不分类

    用户原话：「清空已匹配的录播功能应该**硬性清除所有已匹配项**」。
    上一版只清 `vod_source='match'`（自动匹配写的），把 `'manual'`（手填）与 `NULL`
    （历史写入）留成"清不掉" —— 实测反馈是**看着像功能坏了**：库里 693 条有地址的
    一条都没清掉，回执只能说"这些清不掉"。现在**只要 `vod_url` 非空就清**。

    ⚠️ 代价如实说：**手填的那些地址会一起没**，而它们是不可再生的（不变量 39 说的正是
    "合并里不许抹掉手填的地址"，不是"用户不能自己清"）。所以：

    - 回执给出**分类计数**（`auto` / `manual` / `untracked`），确认窗把三类都摆出来
      ⇒ 用户在按下去之前就知道会清掉几条手填的；
    - 清空**只清地址、不删场次**，且 `vod_source` 一起归 `NULL`
      ⇒ 想再拿回来只需重跑一次「扫描录播并自动填充」。

    ## 为什么**不扫描**（这是第一版最大的毛病，用户实测报回来）

    第一版先按 `vod-scan` 的口径真扫一遍（19 次上游请求、十几秒）再逐条清。后果两条：

    1. **看起来像"数据库卡住了"**：请求挂在事件循环里十几秒，而路由里每清一条都
       `commit` 一次 —— 880 次提交把写锁攥住，别的读请求排队（用户报的"阻塞读写"）；
    2. **判据脆**：只能靠"库里这地址等不等于本次扫描结果"，上游抖一下结果就不同。

    ⇒ 现在**纯数据库操作**：一条 `WHERE vod_url IS NOT NULL` 取行、一次 `commit`，
    **一个上游请求都不发**（判据：把三条取数路径全换成会抛错的桩，清空照样成功）。
    """
    if not AccountRepo(db).get(account_id):
        raise HTTPException(404, f"Account id={account_id} 不存在")
    repo = LiveSessionRepo(db)
    rows = (db.query(LiveSession)
            .filter(LiveSession.account_id == account_id,
                    LiveSession.vod_url.isnot(None))
            .all())
    out = VodClearOut(dry_run=bool(data.dry_run))
    # 分类计数只为**如实报出范围**（确认窗要在动手前把"其中手填 N 条"说清楚）——
    # 它**不参与过滤**：三类一样清。
    for row in rows:
        if row.vod_source == "match":
            out.auto += 1
        elif row.vod_source == "manual":
            out.manual += 1
        else:
            out.untracked += 1
    # ⚠️ dry-run 也要报"**会清几条**" —— 第一版只在真清分支里赋 `cleared`，
    #    于是界面拿到的 dry-run 回执是 cleared=0，看起来像"没有可清的"
    #    （2026-10-15 实测：`matched:1 / cleared:0` 自相矛盾，用例当场抓到）。
    out.cleared = len(rows)
    if data.dry_run:
        return out
    for row in rows:
        row.vod_url = None
        row.vod_source = None
        out.results.append(VodApplyResultOut(live_id=row.live_id or "", ok=True))
    db.commit()
    if rows:
        # 行变了 ⇒ 场次身份要重算（与手动增删改同一条口径，`devlog/475`）
        mark_identity_dirty(db, account_id)
        materialize_group_identity(
            db, account_id, LiveSessionRepo(db).merged(account_id, with_ids=True))
    return out


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
    account, _overrides = _live_infer_ctx(db, account_id)
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
        # ⚠️ 标准弹幕数（各录制版本取最大，`devlog/462`），**不是**分页信封那个 total
        danmakus_count=summary.get("danmakus_count"),
        raw_record_count=summary.get("raw_record_count"),
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
    account, _overrides = _live_infer_ctx(db, account_id)
    if not account:
        raise HTTPException(404, f"Account id={account_id} 不存在")
    vtuber = account.vtuber
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
        # 自建路径给不出"标准弹幕数"（它数的是**参与分词的文本条数**，见下面 text_count）；
        # `result["total"]` 是原始记录条数（含礼物/进场），照实放进 raw_record_count
        raw_record_count=result.get("total"),
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


def _play_error_to_http(e) -> HTTPException:
    """`PlayError.kind` → HTTP 状态（**四条取流路由共用**，别再各写一遍）。

    分类口径（devlog/289）：`not_found` 404 / `forbidden` 403（充电专属等）/ `risk_control` 429 /
    其余 502。⚠️ 抽出来的理由不是"少几行"：2026-10-13 加"按 BV 取流"那两条路由时，映射在四处
    各写一遍 ⇒ 以后补一类 kind 必然漏掉某一条路（而漏掉的表现是"同一种失败、两条路给出不同
    状态码"，前端按状态码分的分支就跟着错）。
    """
    status = {"not_found": 404, "forbidden": 403, "risk_control": 429}.get(e.kind, 502)
    return HTTPException(status, e.message)


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
        raise _play_error_to_http(e) from e


@router.get("/bili/play-by-bvid")
async def bili_play_by_bvid(bvid: str = Query(..., description="BV 号或 B 站视频链接"),
                            qn: int | None = Query(None),
                            fallback: bool = Query(False),
                            cid: int | None = Query(None)):
    """**按 BV 号**取流（2026-10-13，用户 3.2：录播播放）。

    为什么单开一条：`/bili/play/{post_id}` 的前提是"这条视频是一个**帖子**"（`_bili_bvid_of`
    要查库把 post_id 翻成 bvid）。而**录播不是帖子** —— `live_sessions.vod_url` 指向的
    多半是录播组发的视频，我们库里根本没有那一条 post ⇒ 那条路走不通。
    服务层本来就吃 bvid（`play_info(bvid, …)`），所以这里只是补上"入口那一层"。

    - `bvid` 收**BV 号或链接**（`bvid_of` 负责抠号，与服务端入库时同一个纯函数）；
      抠不到 → 400 且给中文原因（**不是 500**）；
    - 其余口径与 `/bili/play/{post_id}` **逐字一致**（同一个 `play_info`、同一套错误分类、
      同样 120s 短缓存、同样不落库）—— 差别只有"bvid 从哪来"。
    """
    from app.domain.live_manual import bvid_of
    from app.services import bili_play

    bv = bvid_of(bvid)
    if not bv:
        raise HTTPException(400, "这不是一个 B 站视频地址（要 BV 号或 /video/BV… 链接）")
    try:
        return await bili_play.play_info(bv, qn=qn, durl_fallback=fallback, cid=cid)
    except bili_play.PlayError as e:
        raise _play_error_to_http(e) from e


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
        raise _play_error_to_http(e) from e
    except bili_segments.SegmentsError as e:
        raise HTTPException(502, f"{e.message}（这段流做不了 MSE，将退回渐进式）") from e
    return {"bvid": bvid, "quality": play.get("quality"),
            "duration_s": tables["duration_s"],
            "video": tables["video"], "audio": tables["audio"]}


@router.get("/bili/segments-by-bvid")
async def bili_segments_by_bvid(bvid: str = Query(..., description="BV 号或 B 站视频链接"),
                                qn: int | None = Query(None),
                                cid: int | None = Query(None)):
    """**按 BV 号**取段表（2026-10-13，用户 3.2：录播播放的 MSE 内核要用它）。

    与 `/bili/segments/{post_id}` 逐字一致，差别只有"bvid 从哪来"（同 `/bili/play-by-bvid`
    的理由：录播不是帖子）。⚠️ 前端必须拿**与 `/bili/play-by-bvid` 同一组 `qn`/`cid`**，
    否则段表与播放地址会对不上（切 P / 换清晰度时尤其明显）。
    """
    from app.domain.live_manual import bvid_of
    from app.services import bili_play, bili_segments

    bv = bvid_of(bvid)
    if not bv:
        raise HTTPException(400, "这不是一个 B 站视频地址（要 BV 号或 /video/BV… 链接）")
    try:
        play = await bili_play.play_info(bv, qn=qn, cid=cid)
        tables = await bili_segments.stream_tables(play)
    except bili_play.PlayError as e:
        raise _play_error_to_http(e) from e
    except bili_segments.SegmentsError as e:
        raise HTTPException(502, f"{e.message}（这段流做不了 MSE，将退回渐进式）") from e
    return {"bvid": bv, "quality": play.get("quality"),
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


#: 「池外收录」时拿 uid 去问一次主页信息做复核的平台 → 展示名。这张表就是那条分支的唯一真源。
#: 小红书 devlog/234、抖音 devlog/334；微博 2026-10-11（B1，`devlog/463`）—— 它有
#: `fetch_user_info`（`/ajax/profile/info?uid=`，PC 域，SUB cookie 就够），补进这张表
#: 之后**四家都能从搜索结果一键收录**。
#:
#: ⚠️ 注释里原先写的是"两家**没有**可用的搜索接口（搜索要登录 + 签名）" —— 那句
#: 2026-10-11 已经**不成立**：四家的搜人接口都找到了（见 `services/name_search.py` 文件头）。
#: 这条 profile 复核分支仍然有用（**建库前必须服务端实查一次**，不信请求体）。
_VERIFY_BY_PROFILE: dict[str, str] = {"xiaohongshu": "小红书", "douyin": "抖音",
                                      "weibo": "微博"}
#: 上面三家"缺凭据时该去粘什么"的一句话（503 的补救指引）
_VERIFY_BY_PROFILE_HINT: dict[str, str] = {
    "xiaohongshu": "至少要有 a1 与 web_session",
    "douyin": "整条 Cookie（uifid / s_v_web_id / ttwid）与那个浏览器的 User-Agent",
    "weibo": "整条 Cookie（SUB 等）—— 扫码或粘贴都行",
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


@router.get("/vtuber/users/search", response_model=NameSearchOut)
async def search_users(kw: str = Query(""), page: int = Query(1, ge=1),
                       platforms: str = Query(""), db: Session = Depends(get_db)):
    """**多平台按名字搜人**（B1，需求 8，`devlog/463`）。

    用户口径（2026-10-08）：输入名字时**同时在"已开启的平台"上做模糊检索**，
    有结果就展示，**全都没有**才显示一行「没找到」。

    - `platforms` 留空 = 四家全试（**关着的平台会被跳过、一个请求都不发**，
      结果里带 `skipped=True` + 「去哪打开」那句）；也可以显式点名几家；
    - 每家的接口与"踩过的坑"写在 `services/name_search.py` 的文件头；
    - **失败不静默**：每个平台各自带 `error`/`hint`（没登录就说去登录），
      单平台失败不影响其余（并发 gather，逐个兜异常）。

    ⚠️ 路径也是**两段**（`/vtuber/users/search`）：一段式会被先注册的
    `/vtuber/{vtuber_id}` 抢走匹配（同 `/vtuber/bili/search` 那个坑，`devlog/083` 实测）。
    """
    kw = (kw or "").strip()
    wanted = [p.strip().lower() for p in (platforms or "").split(",") if p.strip()]
    groups = await name_search_svc.search_all(kw, wanted or None, page=page)
    existing = {
        (a.platform, str(a.platform_uid))
        for a in db.query(Account.platform, Account.platform_uid).all()
    }
    return NameSearchOut(
        kw=kw, page=page,
        groups=[NameSearchGroupOut(
            platform=g.platform, label=g.label, error=g.error, hint=g.hint,
            skipped=g.skipped, best_match_only=g.best_match_only,
            items=[BiliSearchItemOut(**{**it,
                                        "in_library": (it["platform"],
                                                       str(it["platform_uid"])) in existing})
                   for it in g.items],
        ) for g in groups],
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

    # 企划归属（需求 6，B3，2026-10-08，devlog/457）：**收录当场就填**，别等下一次索引刷新
    # —— 池内路径手边就有快照里的 `group_name`，索引路径也有 `it.group_name`。
    # `fill_for_vtuber` 只填空、**不出网**；失败也不该挡住收录（企划只是徽章）。
    try:
        groups.fill_for_vtuber(db, vtuber)
    except Exception as e:
        logger.warning(f"收录后填企划跳过（不影响收录）: {type(e).__name__}: {e}")

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
