import asyncio
import json as _json
from datetime import datetime, timedelta, timezone
import logging
import random
import threading
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.vtuber import Account, VTuber, Post
from app.repositories.vtuber_repo import VTuberRepo, AccountRepo, PostRepo
from app.services.fetcher import (
    fetch_bilibili_user_info, fetch_bilibili_user_stat,
    fetch_bilibili_videos, fetch_bilibili_dynamics,
    fetch_article_detail, fetch_video_detail, fetch_dynamic_detail,
    was_rate_limited, clear_rate_limit, rate_limit_info,
)

# 注意：此处不调用 logging.basicConfig —— 根日志配置统一由 app/main.py 完成。
# 历史上这里先执行了 basicConfig，导致 main.py 中的 FileHandler 配置被静默忽略，
# logs/app.log 恒为空（修复记录见 devlog/013）。
logger = logging.getLogger(__name__)

AVATAR_DIR = Path(__file__).parent.parent.parent / "static" / "avatars"

# 允许的头像扩展名（修复：原来 ".jpg" in url 的判定会把 gif/webp 等存成 png）
_ALLOWED_AVATAR_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}


def _avatar_ext(url: str) -> str:
    """从 URL 路径推导头像扩展名；未知/无扩展名时回退 .jpg"""
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    return suffix if suffix in _ALLOWED_AVATAR_EXTS else ".jpg"


def _avatar_missing(acc: Account) -> bool:
    """头像本地文件是否缺失（avatar_path 相对项目根）。
    修复（devlog/019）：此前仅 URL 变化才下载——初次下载失败或文件被删后
    永远不会补下；全量更新时改为先检查文件再下载缺失头像。"""
    if not acc.avatar_path:
        return True
    return not (Path(__file__).parent.parent.parent / acc.avatar_path).exists()


def _needs_avatar_download(acc: Account, new_avatar: str | None, file_exists: bool) -> bool:
    """头像下载判定：URL 变化 → 下载；URL 未变但本地文件缺失 → 补下。"""
    if not new_avatar:
        return False
    if new_avatar != acc.avatar_url:
        return True
    return not file_exists


_fetch_lock = threading.Lock()
_fetch_running = False

# ── 实时状态（供 /vtuber/fetch-status 轮询；仅简单赋值，GIL 下线程安全）──
_status: dict = {
    "account": {"running": False, "current": None, "index": 0, "total": 0},
    "post": {"running": False, "target": None},
}


def _set_account_progress(current: str | None, index: int, total: int) -> None:
    _status["account"]["current"] = current
    _status["account"]["index"] = index
    _status["account"]["total"] = total


def _reset_account_status() -> None:
    _set_account_progress(None, 0, 0)
    _status["account"]["running"] = False


def _set_post_target(target: str | None) -> None:
    _status["post"]["target"] = target


def _reset_post_status() -> None:
    _set_post_target(None)
    _status["post"]["running"] = False


def get_fetch_status() -> dict:
    """返回账号信息 / 帖子两类抓取任务的实时状态快照。"""
    return {
        "account": dict(_status["account"]),
        "post": dict(_status["post"]),
    }


@dataclass
class FetchResult:
    success: int = 0
    skipped: int = 0
    failed: int = 0
    details: list[str] = field(default_factory=list)


async def _download_avatar(url: str, uid: str) -> str | None:
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    ext = _avatar_ext(url)
    filepath = AVATAR_DIR / f"{uid}{ext}"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                filepath.write_bytes(resp.content)
                return f"static/avatars/{uid}{ext}"
    except Exception as e:
        logger.warning(f"头像下载失败 {uid}: {e}")
    return None


async def _fetch_one_account(acc: Account, db: Session, client: httpx.AsyncClient | None = None) -> bool:
    """抓取单个 Account 的数据，返回是否成功。client 复用连接池，避免每请求新建连接。"""
    mid = acc.platform_uid
    if not mid:
        return False

    is_update = False

    # 用户信息
    try:
        info = await fetch_bilibili_user_info(int(mid), client=client)
        if info:
            acc.display_name = info.get("name", acc.display_name)
            acc.sign = info.get("sign", acc.sign)

            new_avatar = info.get("avatar")
            if new_avatar:
                # 修复（devlog/019）：URL 变化 → 下载；URL 未变但本地文件缺失 → 补下
                file_exists = not _avatar_missing(acc)
                if _needs_avatar_download(acc, new_avatar, file_exists):
                    acc.avatar_url = new_avatar
                    acc.avatar_path = await _download_avatar(new_avatar, acc.platform_uid)
                    if not file_exists:
                        logger.info(f"补下缺失头像 uid={acc.platform_uid} → {acc.avatar_path}")

            acc.live_status = info.get("live_status", 0)
            acc.live_title = info.get("live_title", acc.live_title)
            acc.live_url = info.get("live_url", acc.live_url)
            if not acc.room_id and info.get("room_id"):
                acc.room_id = str(info["room_id"])
            is_update = True
    except Exception as e:
        logger.error(f"抓取 account#{acc.id} 用户信息异常: {type(e).__name__}: {e}")

    if was_rate_limited():
        return False  # 触发风控，上层处理

    # 统计数据
    try:
        stat = await fetch_bilibili_user_stat(int(mid), client=client)
        if stat:
            acc.followers_count = stat.get("follower", acc.followers_count)
            is_update = True
    except Exception as e:
        logger.error(f"抓取 account#{acc.id} 统计数据异常: {type(e).__name__}: {e}")

    if was_rate_limited():
        return False

    if is_update:
        acc.last_fetched_at = datetime.now(timezone.utc)

    return is_update


async def async_fetch_and_update() -> FetchResult:
    global _fetch_running

    if not _fetch_lock.acquire(blocking=False):
        logger.warning("上一次抓取尚未完成，跳过本次触发")
        return FetchResult(details=["上一次抓取仍在进行中，已跳过"])

    _fetch_running = True
    _status["account"]["running"] = True
    result = FetchResult()

    # 风控状态为本任务上下文内的干净初值（ContextVar 隔离，见 fetcher.py）
    clear_rate_limit()

    # 复用连接池：一次抓取任务共用一个 AsyncClient（含重试与风控冷却期间）
    client = httpx.AsyncClient(timeout=15.0)

    db: Session = SessionLocal()
    try:
        logger.info("开始抓取数据...")
        accounts = db.query(Account).filter(
            Account.platform_uid != None, Account.platform_uid != ""
        ).all()

        if not accounts:
            logger.warning("没有可抓取的账号。")
            result.details.append("没有可抓取的账号")
            return result

        idx = 0
        batch_count = 0

        while idx < len(accounts):
            acc = accounts[idx]
            _set_account_progress(acc.display_name or str(acc.platform_uid), idx + 1, len(accounts))

            ok = await _fetch_one_account(acc, db, client=client)

            # 风控 → 冷却后从当前位置继续
            if was_rate_limited():
                db.commit()
                db.close()
                logger.warning(
                    f"触发风控 ({rate_limit_info()})，位置 {idx+1}/{len(accounts)}，"
                    f"冷却 {settings.RATE_LIMIT_COOLDOWN}s..."
                )
                clear_rate_limit()
                await asyncio.sleep(settings.RATE_LIMIT_COOLDOWN)
                db = SessionLocal()
                accounts = db.query(Account).filter(
                    Account.platform_uid != None, Account.platform_uid != ""
                ).all()
                logger.info(f"冷却完毕，从第 {idx+1} 个继续...")
                continue

            await asyncio.sleep(
                settings.REQUEST_INTERVAL_MIN
                + random.uniform(0, settings.REQUEST_INTERVAL_MAX - settings.REQUEST_INTERVAL_MIN)
            )

            if ok:
                db.commit()
                result.success += 1
            else:
                result.failed += 1
                result.details.append(f"{acc.display_name or acc.platform_uid} 更新失败")

            idx += 1
            batch_count += 1
            if batch_count >= settings.FETCH_BATCH_SIZE:
                logger.info(f"已处理 {batch_count} 个账号，休息 {settings.FETCH_BATCH_COOLDOWN} 秒...")
                await asyncio.sleep(settings.FETCH_BATCH_COOLDOWN)
                batch_count = 0

        logger.info(f"抓取完毕: {result.success} 成功, {result.failed} 失败, {result.skipped} 跳过")

    except Exception as e:
        logger.error(f"抓取任务出错: {e}", exc_info=True)
        db.rollback()
        result.details.append(f"异常: {e}")
    finally:
        db.close()
        await client.aclose()
        _fetch_running = False
        _reset_account_status()
        _fetch_lock.release()

    return result


def fetch_and_update_vtubers():
    try:
        asyncio.run(async_fetch_and_update())
    except Exception as e:
        logger.error(f"调度器执行失败: {e}")


def is_fetch_running() -> bool:
    return _fetch_running


async def async_fetch_vtuber(vtuber_id: int) -> FetchResult:
    """抓取单个 VTuber 的账号信息（devlog/017）。
    与全局抓取共用 _fetch_lock 防重叠；风控冷却后从当前账号继续。"""
    global _fetch_running

    if not _fetch_lock.acquire(blocking=False):
        logger.warning("上一次抓取尚未完成，跳过本次触发")
        return FetchResult(details=["上一次抓取仍在进行中，已跳过"])

    _fetch_running = True
    _status["account"]["running"] = True
    result = FetchResult()
    clear_rate_limit()
    client = httpx.AsyncClient(timeout=15.0)

    db: Session = SessionLocal()
    try:
        accounts = db.query(Account).filter(
            Account.vtuber_id == vtuber_id,
            Account.platform_uid != None,
            Account.platform_uid != "",
        ).all()

        if not accounts:
            logger.warning(f"VTuber#{vtuber_id} 没有可抓取的账号")
            result.details.append("该 VTuber 没有可抓取的账号")
            return result

        idx = 0
        while idx < len(accounts):
            acc = accounts[idx]
            _set_account_progress(acc.display_name or str(acc.platform_uid), idx + 1, len(accounts))
            ok = await _fetch_one_account(acc, db, client=client)

            if was_rate_limited():
                db.commit()
                db.close()
                logger.warning(f"触发风控 ({rate_limit_info()})，冷却 {settings.RATE_LIMIT_COOLDOWN}s...")
                clear_rate_limit()
                await asyncio.sleep(settings.RATE_LIMIT_COOLDOWN)
                db = SessionLocal()
                continue

            await asyncio.sleep(
                settings.REQUEST_INTERVAL_MIN
                + random.uniform(0, settings.REQUEST_INTERVAL_MAX - settings.REQUEST_INTERVAL_MIN)
            )

            if ok:
                db.commit()
                result.success += 1
            else:
                result.failed += 1
                result.details.append(f"{acc.display_name or acc.platform_uid} 更新失败")
            idx += 1

        logger.info(f"VTuber#{vtuber_id} 抓取完毕: {result.success} 成功, {result.failed} 失败")

    except Exception as e:
        logger.error(f"抓取 VTuber#{vtuber_id} 出错: {e}", exc_info=True)
        db.rollback()
        result.details.append(f"异常: {e}")
    finally:
        db.close()
        await client.aclose()
        _fetch_running = False
        _reset_account_status()
        _fetch_lock.release()

    return result


def start_scheduler():
    scheduler = BackgroundScheduler()
    scheduler.add_job(
        fetch_and_update_vtubers,
        IntervalTrigger(minutes=settings.FETCH_INTERVAL_MINUTES, jitter=settings.FETCH_JITTER_SECONDS),
        id="fetch_vtubers",
        replace_existing=True,
        max_instances=1,
    )
    scheduler.start()
    logger.info(f"APScheduler 已启动，每 {settings.FETCH_INTERVAL_MINUTES} 分钟抓取一次。")
    return scheduler


def shutdown_scheduler(scheduler: BackgroundScheduler):
    if scheduler:
        scheduler.shutdown(wait=False)
        logger.info("APScheduler 已安全关闭。")


# ── 帖子抓取 (按指令触发，非常驻周期任务) ──────────────────────────────

_post_fetch_lock = threading.Lock()
_post_fetch_running = False


@dataclass
class PostFetchResult:
    videos: int = 0
    dynamics: int = 0
    stored: int = 0
    skipped: int = 0
    rate_limited: bool = False
    archived_stop: bool = False      # 是否因归档边界提前停止（devlog/016）


def _safe_json_parse(s: str | None):
    if not s:
        return {}
    try:
        return _json.loads(s)
    except (_json.JSONDecodeError, TypeError):
        return {}


def _safe_store_post(post_repo: PostRepo, data: dict) -> bool:
    """存储单条帖子；唯一约束冲突时回滚并跳过，返回是否成功"""
    try:
        post_repo.create(data)
        return True
    except IntegrityError:
        post_repo.db.rollback()
        logger.warning(f"帖子已存在，跳过: pid={data.get('platform_post_id')}, type={data.get('type')}")
        return False


async def _fetch_posts_core(mid: int, video_pages: int, dynamics_pages: int, db: Session,
                            client: httpx.AsyncClient | None = None,
                            include_videos: bool = True) -> PostFetchResult:
    """单个账号的帖子抓取核心逻辑（不含锁与 session 管理）。
    video_pages=-1   → 全量拉取视频直到无更多结果。
    dynamics_pages=-1 → 全量拉取动态直到 has_more=false。
    include_videos=False → 只抓动态（更新未归档动态用）。
    client 复用连接池；未传入时自建并在结束/异常时关闭。

    归档边界（devlog/016）：动态/视频按时间倒序翻页，一旦某一整页的帖子
    全部已归档（is_archived=1，即早于归档截止日），更早的页必然也已归档，
    立即停止遍历 —— 归档后的贴文不再参与抓取。
    """
    result = PostFetchResult()

    # 风控状态为本任务上下文内的干净初值（ContextVar 隔离，见 fetcher.py）
    clear_rate_limit()

    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(timeout=15.0)

    try:
        platform_uid = str(mid)
        post_repo = PostRepo(db)
        existing_ids = {
            r[0] for r in db.query(Post.platform_post_id).filter(
                Post.platform == "bilibili", Post.platform_uid == platform_uid
            ).all()
        }
        # 已归档帖子 ID 集合：整页命中即触发归档边界停止
        archived_ids = {
            r[0] for r in db.query(Post.platform_post_id).filter(
                Post.platform == "bilibili", Post.platform_uid == platform_uid,
                Post.is_archived == True,  # noqa: E712
            ).all()
        }

        # ── 视频投稿 ──
        if include_videos:
            page = 1
            while True:
                if video_pages > 0 and page > video_pages:
                    break
                videos = await fetch_bilibili_videos(mid, page=page, client=client)
                if was_rate_limited():
                    clear_rate_limit()
                    result.rate_limited = True
                    break
                if not videos:
                    break
                if all(v["platform_post_id"] in archived_ids for v in videos):
                    result.archived_stop = True
                    break
                for v in videos:
                    result.videos += 1
                    if v["platform_post_id"] in existing_ids:
                        result.skipped += 1
                        continue
                    if _safe_store_post(post_repo, v):
                        result.stored += 1
                    else:
                        result.skipped += 1
                    existing_ids.add(v["platform_post_id"])
                page += 1
                await asyncio.sleep(1)

        # ── 动态 ──
        offset = ""
        dyn_page = 0
        while True:
            if dynamics_pages > 0 and dyn_page >= dynamics_pages:
                break
            data = await fetch_bilibili_dynamics(mid, offset=offset, client=client)
            if was_rate_limited():
                clear_rate_limit()
                result.rate_limited = True
                break
            if not data:
                break
            # 归档边界：整页已归档 → 更早的页必然已归档，停止遍历
            if all(d["platform_post_id"] in archived_ids for d in data.get("items", [])):
                result.archived_stop = True
                break
            for d in data.get("items", []):
                # 双保险：直播开播动态（fetcher 已过滤，此处兜底，见 devlog/018）
                if d["type"] == "live":
                    continue
                result.dynamics += 1
                if d["platform_post_id"] in existing_ids:
                    result.skipped += 1
                    continue

                # 图文 / 纯文字 → detail API 拿 OPUS 格式完整数据
                if d["type"] in ("text", "image"):
                    # 防丢图：detail（opusBigCover 特性）可能只回 1 张封面图，
                    # 若 feed 的图片数更多，保留 feed 的 images
                    feed_body = _safe_json_parse(d.get("body_json", "{}"))
                    feed_images = feed_body.get("images") if isinstance(feed_body, dict) else None

                    detail = await fetch_dynamic_detail(d["platform_post_id"], client=client)
                    if detail:
                        for key in ("title", "summary", "cover_url", "body_json", "stats_json",
                                     "permalink", "raw_json", "published_at"):
                            if key in detail and detail[key] is not None:
                                d[key] = detail[key]
                        if feed_images:
                            detail_body = _safe_json_parse(d.get("body_json", "{}"))
                            if len(detail_body.get("images") or []) < len(feed_images):
                                detail_body["images"] = feed_images
                                d["body_json"] = _json.dumps(detail_body, ensure_ascii=False, default=str)
                        await asyncio.sleep(random.uniform(0.5, 2.0))
                    else:
                        logger.warning(f"动态详情获取失败 id={d['platform_post_id']}, 使用 feed 数据")

                # 专栏 → 拉取全文
                if d["type"] == "article":
                    body = _safe_json_parse(d.get("body_json", "{}"))
                    cv_id = body.get("cv_id") if isinstance(body, dict) else None
                    if cv_id:
                        detail = await fetch_article_detail(cv_id, client=client)
                        if detail:
                            d["body_json"] = _json.dumps({**body, "content": detail["content"]}, ensure_ascii=False, default=str)
                            # 修复：Delta 富文本专栏 → 补 delta 字段 + 纯文本（列表摘要用）
                            if detail.get("delta"):
                                d["body_json"] = _json.dumps({
                                    **_safe_json_parse(d["body_json"], {}),
                                    "delta": detail["delta"],
                                    "text": detail["delta_text"] or body.get("text", ""),
                                }, ensure_ascii=False, default=str)
                            d["summary"] = detail["summary"] or detail.get("delta_text") or d["summary"]
                            d["stats_json"] = _json.dumps({
                                "view": detail.get("stats", {}).get("view", 0),
                                "like": detail.get("stats", {}).get("like", 0),
                                "comment": detail.get("stats", {}).get("reply", 0),
                                "favorite": detail.get("stats", {}).get("favorite", 0),
                            }, ensure_ascii=False, default=str)
                            await asyncio.sleep(random.uniform(0.5, 2.0))
                elif d["type"] in ("video", "video_dynamic"):
                    body = _safe_json_parse(d.get("body_json", "{}"))
                    bvid = body.get("bvid") if isinstance(body, dict) else None
                    if bvid:
                        detail = await fetch_video_detail(bvid, client=client)
                        if detail:
                            d["body_json"] = _json.dumps({
                                **body,
                                "description": detail["desc"],
                                "duration_sec": detail["duration"],
                                "owner": detail["owner_name"],
                                "tags": detail["tname"],
                            }, ensure_ascii=False, default=str)
                            d["cover_url"] = d["cover_url"] or detail.get("pages", [{}])[0].get("first_frame", "")
                            # 合并：详情统计（view/coin/...）+ 动态互动（forward/dyn_like/...）
                            feed_stats = _safe_json_parse(d.get("stats_json"), {})
                            d["stats_json"] = _json.dumps(
                                {**feed_stats, **detail["stat"]}, ensure_ascii=False, default=str
                            )
                            await asyncio.sleep(random.uniform(0.5, 2.0))

                if _safe_store_post(post_repo, d):
                    result.stored += 1
                else:
                    result.skipped += 1
                existing_ids.add(d["platform_post_id"])
            dyn_page += 1
            if not data.get("has_more"):
                break
            offset = data.get("next_offset", "")
            await asyncio.sleep(20)

        db.commit()
        return result
    finally:
        if own_client:
            await client.aclose()


async def async_fetch_posts(mid: int, video_pages: int, dynamics_pages: int) -> PostFetchResult:
    """单个账号的帖子抓取（带锁，供 fetch-posts 端点调用）。"""
    global _post_fetch_running

    if not _post_fetch_lock.acquire(blocking=False):
        logger.warning("帖子抓取正在进行中，跳过本次触发")
        return PostFetchResult()

    _post_fetch_running = True
    _status["post"]["running"] = True
    _set_post_target(str(mid))
    db: Session = SessionLocal()
    client = httpx.AsyncClient(timeout=15.0)
    try:
        return await _fetch_posts_core(mid, video_pages, dynamics_pages, db, client=client)
    except Exception as e:
        logger.error(f"帖子抓取异常 mid={mid}: {e}", exc_info=True)
        db.rollback()
        return PostFetchResult()
    finally:
        db.close()
        await client.aclose()
        _post_fetch_running = False
        _reset_post_status()
        _post_fetch_lock.release()


async def async_fetch_all_posts() -> dict:
    """对库中所有 bilibili 账号逐个全量抓取帖子（视频+动态）。"""
    global _post_fetch_running

    if not _post_fetch_lock.acquire(blocking=False):
        logger.warning("帖子抓取正在进行中，跳过本次触发")
        return {"status": "skipped", "message": "帖子抓取任务正在进行中"}

    _post_fetch_running = True
    _status["post"]["running"] = True
    total = {"videos": 0, "dynamics": 0, "stored": 0, "skipped": 0}
    details = []
    db: Session = SessionLocal()
    client = httpx.AsyncClient(timeout=15.0)

    try:
        accounts = db.query(Account).filter(
            Account.platform == "bilibili",
            Account.platform_uid != None,
            Account.platform_uid != "",
        ).all()

        if not accounts:
            logger.warning("没有可抓取的 bilibili 账号")
            return {"status": "done", "total": total, "details": details}

        for idx, acc in enumerate(accounts):
            _set_post_target(acc.display_name or str(acc.platform_uid))
            logger.info(f"[{idx+1}/{len(accounts)}] 全量抓取 {acc.display_name or acc.platform_uid} 的帖子...")
            try:
                r = await _fetch_posts_core(int(acc.platform_uid), -1, -1, db, client=client)
            except Exception as e:
                logger.error(f"帖子抓取异常 uid={acc.platform_uid}: {e}", exc_info=True)
                db.rollback()
                r = PostFetchResult()

            details.append({
                "platform_uid": acc.platform_uid,
                "videos": r.videos, "dynamics": r.dynamics,
                "stored": r.stored, "skipped": r.skipped,
                "rate_limited": r.rate_limited,
            })
            for k in ("videos", "dynamics", "stored", "skipped"):
                total[k] += getattr(r, k)

            if r.rate_limited:
                logger.warning(f"uid={acc.platform_uid} 触发风控，冷却 {settings.RATE_LIMIT_COOLDOWN}s...")
                await asyncio.sleep(settings.RATE_LIMIT_COOLDOWN)
            elif idx < len(accounts) - 1:
                await asyncio.sleep(20)

    except Exception as e:
        logger.error(f"全量帖子抓取任务出错: {e}", exc_info=True)
        db.rollback()
    finally:
        db.close()
        await client.aclose()
        _post_fetch_running = False
        _reset_post_status()
        _post_fetch_lock.release()

    return {"status": "done", "total": total, "details": details}


def is_post_fetch_running() -> bool:
    return _post_fetch_running


# ── 归档规则 + 未归档动态更新（devlog/016） ────────────────────────────

def archive_old_posts(cutoff_days: int = 30, db: Session | None = None) -> int:
    """归档规则：published_at 早于 cutoff（默认 30 天前）的帖子 → is_archived=1。
    幂等；published_at 为空的帖子不参与（无法判定时间）。返回本次归档条数。"""
    own_session = db is None
    if own_session:
        db = SessionLocal()
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(days=cutoff_days)
        return PostRepo(db).archive_before(cutoff)
    finally:
        if own_session:
            db.close()


async def async_update_unarchived_posts(name: str | None = None) -> dict:
    """更新未归档动态贴文（devlog/016）：
    1. 先执行归档规则（发布时间早于 30 天前 → is_archived=1）；
    2. 对目标账号（name 模糊匹配；省略 = 全部 bilibili 账号）抓取动态，
       遍历到归档边界（整页已归档）即停，不再翻更早的历史。
    """
    global _post_fetch_running

    if not _post_fetch_lock.acquire(blocking=False):
        logger.warning("帖子抓取正在进行中，跳过本次触发")
        return {"status": "skipped", "message": "帖子抓取任务正在进行中"}

    _post_fetch_running = True
    _status["post"]["running"] = True
    db: Session = SessionLocal()
    client = httpx.AsyncClient(timeout=15.0)
    total = {"dynamics": 0, "stored": 0, "skipped": 0}
    details = []
    archived = 0

    try:
        # 1. 归档规则
        archived = archive_old_posts(db=db)
        logger.info(f"归档规则执行完成: {archived} 条帖子已归档（早于 30 天前）")

        # 2. 定位目标账号
        q = db.query(Account).filter(
            Account.platform == "bilibili",
            Account.platform_uid != None,
            Account.platform_uid != "",
        )
        if name:
            vids = [v.id for v in db.query(VTuber).filter(VTuber.name.contains(name)).all()]
            if not vids:
                return {"status": "done", "archived": archived,
                        "message": f"未找到名字包含 '{name}' 的 VTuber",
                        "total": total, "details": details}
            q = q.filter(Account.vtuber_id.in_(vids))
        accounts = q.all()

        if not accounts:
            logger.warning("没有可抓取的 bilibili 账号")
            return {"status": "done", "archived": archived,
                    "total": total, "details": details}

        for idx, acc in enumerate(accounts):
            _set_post_target(acc.display_name or str(acc.platform_uid))
            logger.info(f"[{idx+1}/{len(accounts)}] 更新未归档动态 {acc.display_name or acc.platform_uid} ...")
            try:
                r = await _fetch_posts_core(int(acc.platform_uid), -1, -1, db,
                                            client=client, include_videos=False)
            except Exception as e:
                logger.error(f"更新动态异常 uid={acc.platform_uid}: {e}", exc_info=True)
                db.rollback()
                r = PostFetchResult()

            details.append({
                "platform_uid": acc.platform_uid,
                "dynamics": r.dynamics, "stored": r.stored, "skipped": r.skipped,
                "archived_stop": r.archived_stop,
                "rate_limited": r.rate_limited,
            })
            for k in ("dynamics", "stored", "skipped"):
                total[k] += getattr(r, k)

            if r.rate_limited:
                logger.warning(f"uid={acc.platform_uid} 触发风控，冷却 {settings.RATE_LIMIT_COOLDOWN}s...")
                await asyncio.sleep(settings.RATE_LIMIT_COOLDOWN)
            elif idx < len(accounts) - 1:
                await asyncio.sleep(20)

    except Exception as e:
        logger.error(f"更新未归档动态任务出错: {e}", exc_info=True)
        db.rollback()
    finally:
        db.close()
        await client.aclose()
        _post_fetch_running = False
        _reset_post_status()
        _post_fetch_lock.release()

    return {"status": "done", "archived": archived, "total": total, "details": details}
