import asyncio
import json as _json
from datetime import datetime, timedelta, timezone
import logging
import random
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.vtuber import Account, VTuber, Post
from app.repositories.vtuber_repo import VTuberRepo, AccountRepo, PostRepo, AccountStatSnapshotRepo
from app.services.fetcher import (
    fetch_bilibili_user_info, fetch_bilibili_user_stat,
    fetch_bilibili_videos, fetch_bilibili_dynamics,
    fetch_article_detail, fetch_video_detail, fetch_dynamic_detail,
    was_rate_limited, clear_rate_limit, rate_limit_info,
)
from app.services.platforms import registry
from app.services.post_text import extract_post_text
from app.services.tombstone import apply_tombstone_scan
from app.services.externals.runner import run_external_interval
# 注意：此处不调用 logging.basicConfig —— 根日志配置统一由 app/main.py 完成。
# 历史上这里先执行了 basicConfig，导致 main.py 中的 FileHandler 配置被静默忽略，
# logs/app.log 恒为空（修复记录见 devlog/013）。
logger = logging.getLogger(__name__)

AVATAR_DIR = settings.DATA_DIR / "static" / "avatars"

# 允许的头像扩展名（修复：原来 ".jpg" in url 的判定会把 gif/webp 等存成 png）
_ALLOWED_AVATAR_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}


def _avatar_ext(url: str) -> str:
    """从 URL 路径推导头像扩展名；未知/无扩展名时回退 .jpg"""
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    return suffix if suffix in _ALLOWED_AVATAR_EXTS else ".jpg"


def _avatar_missing(acc: Account) -> bool:
    """头像本地文件是否缺失（avatar_path 相对 DATA_DIR 存储）。
    修复（devlog/019）：此前仅 URL 变化才下载——初次下载失败或文件被删后
    永远不会补下；全量更新时改为先检查文件再下载缺失头像。"""
    if not acc.avatar_path:
        return True
    p = Path(acc.avatar_path)
    return not (p if p.is_absolute() else settings.DATA_DIR / p).exists()


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
    "account": {"running": False, "current": None, "index": 0, "total": 0,
                "recent": []},   # 最近完成的账号字段快照，供前端就地增量刷新侧栏
    "post": {"running": False, "target": None},
}


def _push_account_snapshot(acc) -> None:
    """账号信息抓取提交后，把最新字段快照推入 recent（上限 100 条）。

    前端 TopBar 轮询发现 recent 增长即派发 account-progress 事件，
    VtuberSidebar 按 platform_uid 就地合并，避免全表重刷。
    """
    recent = _status["account"].setdefault("recent", [])
    recent.append({
        "platform_uid": str(acc.platform_uid),
        "display_name": acc.display_name,
        "sign": acc.sign,
        "followers_count": acc.followers_count,
        "live_status": acc.live_status,
        "live_title": acc.live_title,
        "avatar_path": acc.avatar_path,
    })
    if len(recent) > 100:
        del recent[:-100]


def _record_stat_snapshot(db: Session, acc: Account) -> None:
    """持久化统计快照（P0，v0.5.0）：账号信息抓取成功后追加一行。

    与 _push_account_snapshot 的区别：后者是进程内实时状态（重启即失），
    这里是落库的时间序列（涨粉趋势/直播历史的地基）。
    简单优先：全量记录（每轮成功抓取即写一行），数值无变化不降噪；
    写入随调用方随后的事务 commit 一起落盘。
    """
    AccountStatSnapshotRepo(db).add(
        account_id=acc.id,
        followers_count=acc.followers_count,
        live_status=acc.live_status,
        live_title=acc.live_title,
    )


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


# 任务完成序号：每轮任务开始时自增，前端凭 seq 区分「新的完成汇总」与旧结果
_last_result_seq = 0


def _next_result_seq() -> int:
    global _last_result_seq
    _last_result_seq += 1
    return _last_result_seq


def _set_account_last_result(seq: int, label: str, success: int, failed: int, skipped: int) -> None:
    _status["account"]["last_result"] = {
        "seq": seq, "label": label,
        "success": success, "failed": failed, "skipped": skipped,
    }


def _set_post_last_result(seq: int, kind: str, label: str,
                          videos: int, dynamics: int, stored: int, skipped: int,
                          issues: list[dict], video_missing: int | None) -> None:
    _status["post"]["last_result"] = {
        "seq": seq, "kind": kind, "label": label,
        "videos": videos, "dynamics": dynamics,
        "stored": stored, "skipped": skipped,
        "issues": issues, "video_missing": video_missing,
    }


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


async def _download_avatar(url: str, uid: str, client: httpx.AsyncClient | None = None) -> str | None:
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    ext = _avatar_ext(url)
    filepath = AVATAR_DIR / f"{uid}{ext}"
    try:
        if client is None:
            client = httpx.AsyncClient(timeout=15.0)
            own = True
        else:
            own = False
        resp = await client.get(url)
        if resp.status_code == 200:
            filepath.write_bytes(resp.content)
            return f"static/avatars/{uid}{ext}"
    except Exception as e:
        logger.warning(f"头像下载失败 {uid}: {e}")
    finally:
        if client is not None and own:
            await client.aclose()
    return None


async def _fetch_one_account(acc: Account, db: Session, client: httpx.AsyncClient | None = None) -> bool:
    """抓取单个 Account 的数据（按平台分发到平台框架），返回是否成功。

    client 复用连接池，避免每请求新建连接；风控由上层统一冷却退避。
    """
    mid = acc.platform_uid
    if not mid:
        return False

    pf = registry.get_fetcher(acc.platform)
    if pf is None:
        logger.warning(f"不支持的平台 '{acc.platform}'，跳过 account#{acc.id}")
        return False

    is_update = False

    try:
        info = await pf.fetch_user_info(str(mid), client=client)
        if info:
            acc.display_name = info.get("name") or acc.display_name
            acc.sign = info.get("sign") or acc.sign

            new_avatar = info.get("avatar")
            if new_avatar:
                # 修复（devlog/019）：URL 变化 → 下载；URL 未变但本地文件缺失 → 补下
                file_exists = not _avatar_missing(acc)
                if _needs_avatar_download(acc, new_avatar, file_exists):
                    acc.avatar_url = new_avatar
                    # 头像文件按平台前缀命名，避免跨平台 uid 撞名
                    acc.avatar_path = await _download_avatar(
                        new_avatar, f"{acc.platform}_{acc.platform_uid}", client=client)
                    if not file_exists:
                        logger.info(f"补下缺失头像 {acc.platform}:{acc.platform_uid} → {acc.avatar_path}")

            if info.get("followers_count") is not None:
                acc.followers_count = info["followers_count"]
            acc.url = info.get("url") or acc.url

            # 平台附加字段：直播状态（bilibili 提供）
            if "live_status" in info:
                acc.live_status = info.get("live_status", 0)
                acc.live_title = info.get("live_title", acc.live_title)
                acc.live_url = info.get("live_url", acc.live_url)
                if not acc.room_id and info.get("room_id"):
                    acc.room_id = str(info["room_id"])
            is_update = True
    except Exception as e:
        logger.error(f"抓取 account#{acc.id} ({acc.platform}) 异常: {type(e).__name__}: {e}")

    if was_rate_limited():
        return False  # 触发风控，上层处理

    if is_update:
        acc.last_fetched_at = datetime.now(timezone.utc)

    return is_update


async def async_fetch_and_update(check_yield: bool = True) -> FetchResult:
    global _fetch_running

    if not _fetch_lock.acquire(blocking=False):
        logger.warning("上一次抓取尚未完成，跳过本次触发")
        return FetchResult(details=["上一次抓取仍在进行中，已跳过"])

    _fetch_running = True
    _status["account"]["running"] = True
    _status["account"]["recent"] = []   # 每轮自包含：清空上一任务的快照
    result = FetchResult()
    res_seq = _next_result_seq()

    # 风控状态为本任务上下文内的干净初值（ContextVar 隔离，见 fetcher.py）
    clear_rate_limit()

    # 复用连接池：一次抓取任务共用一个 AsyncClient（含重试与风控冷却期间）
    client = httpx.AsyncClient(timeout=15.0)

    db: Session = SessionLocal()
    try:
        logger.info("开始抓取数据...")
        accounts = AccountRepo(db).all_for_fetch()

        if not accounts:
            logger.warning("没有可抓取的账号。")
            result.details.append("没有可抓取的账号")
            return result

        idx = 0
        batch_count = 0

        while idx < len(accounts):
            # 断点让位：定时任务请求让位时交还执行权，回来后重查账号列表从原 idx 续跑
            refreshed = await _maybe_yield_account(db, check_yield=check_yield)
            if refreshed is not None:
                accounts = refreshed
                logger.info(f"定时任务执行完毕，从第 {idx + 1} 个账号续跑...")
                continue
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
                accounts = AccountRepo(db).all_for_fetch()
                logger.info(f"冷却完毕，从第 {idx+1} 个继续...")
                continue

            await asyncio.sleep(
                settings.REQUEST_INTERVAL_MIN
                + random.uniform(0, settings.REQUEST_INTERVAL_MAX - settings.REQUEST_INTERVAL_MIN)
            )

            if ok:
                _record_stat_snapshot(db, acc)
                db.commit()
                _push_account_snapshot(acc)
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
        _set_account_last_result(res_seq, "全部账号", result.success, result.failed, result.skipped)

    return result


def fetch_and_update_vtubers():
    """定时任务（优先协议）：请求在跑任务让位 → 执行本任务 → 清除信号唤醒原任务续跑。"""
    _yield_request.set()
    try:
        while _fetch_running or _post_fetch_running:
            time.sleep(0.2)
        logger.info("定时任务接管：原抓取任务已让位，开始本轮账号抓取")
        asyncio.run(async_fetch_and_update(check_yield=False))
    except Exception as e:
        logger.error(f"调度器执行失败: {e}")
    finally:
        _yield_request.clear()


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
    _status["account"]["recent"] = []   # 每轮自包含：清空上一任务的快照
    result = FetchResult()
    res_seq = _next_result_seq()
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
            # 断点让位：定时任务请求让位时交还执行权，回来后按 vtuber_id 重查续跑
            refreshed = await _maybe_yield_account(db, vtuber_id=vtuber_id, check_yield=True)
            if refreshed is not None:
                accounts = refreshed
                logger.info(f"定时任务执行完毕，单V {vtuber_id} 从第 {idx + 1} 个账号续跑...")
                continue
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
                # 修复：冷却后必须按 vtuber_id 重查 accounts —— 旧会话已关闭，
                # 原列表里的 acc 是 detached 对象，继续赋值不会进入新会话，
                # 后续更新会静默丢失（async_fetch_and_update 有重查，此处遗漏）。
                accounts = db.query(Account).filter(
                    Account.vtuber_id == vtuber_id,
                    Account.platform_uid != None,
                    Account.platform_uid != "",
                ).all()
                continue

            await asyncio.sleep(
                settings.REQUEST_INTERVAL_MIN
                + random.uniform(0, settings.REQUEST_INTERVAL_MAX - settings.REQUEST_INTERVAL_MIN)
            )

            if ok:
                _record_stat_snapshot(db, acc)
                db.commit()
                _push_account_snapshot(acc)
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
        _set_account_last_result(res_seq, f"VTuber#{vtuber_id}", result.success, result.failed, result.skipped)

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
    # 外部第三方数据源（P4）：日/周批次低频采集；抓取任务进行中则跳过本轮
    if settings.EXTERNAL_ENABLED:
        scheduler.add_job(
            run_external_daily_jobs,
            CronTrigger(hour=settings.EXTERNAL_RUN_HOUR, minute=0),
            id="external_daily",
            replace_existing=True,
            max_instances=1,
        )
        scheduler.add_job(
            run_external_weekly_jobs,
            CronTrigger(day_of_week="mon", hour=settings.EXTERNAL_RUN_HOUR, minute=30),
            id="external_weekly",
            replace_existing=True,
            max_instances=1,
        )
    scheduler.start()
    logger.info(f"APScheduler 已启动，每 {settings.FETCH_INTERVAL_MINUTES} 分钟抓取一次。")
    return scheduler


def run_external_daily_jobs():
    """外部数据日任务（P4）：粉丝历史增量 + 直播礼物日聚合。"""
    if any_fetch_running():
        logger.info("外部数据日任务跳过：抓取任务正在进行")
        return
    results = asyncio.run(run_external_interval("daily"))
    logger.info(f"外部数据日任务完成: {len(results)} 个任务")


def run_external_weekly_jobs():
    """外部数据周任务（P4）：VTuber 索引整表刷新（企划/公会）。"""
    if any_fetch_running():
        logger.info("外部数据周任务跳过：抓取任务正在进行")
        return
    results = asyncio.run(run_external_interval("weekly"))
    logger.info(f"外部数据周任务完成: {len(results)} 个任务")


def shutdown_scheduler(scheduler: BackgroundScheduler):
    if scheduler:
        scheduler.shutdown(wait=False)
        logger.info("APScheduler 已安全关闭。")


# ── 帖子抓取 / 定时任务优先让位协议（全局单飞） ────────────────────────────

_post_fetch_lock = threading.Lock()
_post_fetch_running = False

# 定时任务触发时置位 _yield_request；运行中的手动任务在断点（账号间/页间）
# 检测到后交还执行权并等待清除，定时任务完成后清除信号、原任务从断点续跑。
_yield_request = threading.Event()


def yield_requested() -> bool:
    return _yield_request.is_set()


def any_fetch_running() -> bool:
    """全局单飞判定：账号/帖子任一在跑，或定时任务正请求让位（让位窗口也视为忙，
    避免手动请求在真空期钻空并发执行）。"""
    return _fetch_running or _post_fetch_running or _yield_request.is_set()


async def _maybe_yield_account(db: Session, vtuber_id: int | None = None,
                               check_yield: bool = True) -> list[Account] | None:
    """账号抓取断点让位（循环顶部调用）：
    定时任务请求让位时交还执行权并等待其完成，然后重查账号列表续跑。
    返回重查后的账号列表；未发生让位返回 None（调用方沿用原列表）。"""
    global _fetch_running
    if not check_yield or not _yield_request.is_set():
        return None
    db.commit()
    _fetch_running = False
    _status["account"]["running"] = False
    _fetch_lock.release()
    try:
        while _yield_request.is_set():
            await asyncio.sleep(0.2)
    finally:
        _fetch_lock.acquire()
        _fetch_running = True
        _status["account"]["running"] = True
    if vtuber_id is not None:
        return db.query(Account).filter(
            Account.vtuber_id == vtuber_id,
            Account.platform_uid != None,
            Account.platform_uid != "",
        ).all()
    return AccountRepo(db).all_for_fetch()


async def _maybe_yield_post(db: Session) -> bool:
    """帖子抓取断点让位（视频页/动态页/账号间调用）：
    交还 _post_fetch_lock，等待定时任务完成后续跑。返回是否发生过让位。"""
    global _post_fetch_running
    if not _yield_request.is_set():
        return False
    db.commit()
    _post_fetch_running = False
    _status["post"]["running"] = False
    _post_fetch_lock.release()
    try:
        while _yield_request.is_set():
            await asyncio.sleep(0.2)
    finally:
        _post_fetch_lock.acquire()
        _post_fetch_running = True
        _status["post"]["running"] = True
    return True


# ── 帖子抓取 (按指令触发，非常驻周期任务) ──────────────────────────────

@dataclass
class PostFetchResult:
    videos: int = 0
    dynamics: int = 0
    stored: int = 0
    skipped: int = 0
    rate_limited: bool = False
    archived_stop: bool = False      # 是否因归档边界提前停止（devlog/016）
    stopped_early: bool = False      # 增量模式：遇到已入库帖子即停（v0.4.7）
    # 方案 1：中断原因归类（done/page_limit/rate_limited/network_error/
    # archived_boundary/stopped_early/error），前端据此区分「预期停止」与「丢数据」
    stop_reason: str = "done"
    error: str | None = None        # 异常信息（stop_reason=error 时）
    # 方案 2：B站视频参考总数（arc/search page.count），用于完整性比对
    video_total: int | None = None
    # 墓碑机制（v0.5.1）：本轮观察到的帖子 ID（新入库 + 已存在）、
    # 增量停止帖 ID、是否自然走到流尾 —— 供删除检测判定窗口使用
    seen_pids: list[str] = field(default_factory=list)
    stop_existing_pid: str | None = None
    natural_end: bool = False


def _safe_json_parse(s: str | None, fallback: dict | None = None) -> dict:
    """安全解析 JSON 字符串；空值/解析失败返回 fallback（默认空字典）。

    第二参数供调用方在「合并进现有 dict」场景下显式传 {}，语义更清晰。
    """
    if fallback is None:
        fallback = {}
    if not s:
        return fallback
    try:
        parsed = _json.loads(s)
        return parsed if isinstance(parsed, dict) else fallback
    except (_json.JSONDecodeError, TypeError):
        return fallback


def _safe_store_post(post_repo: PostRepo, data: dict, commit: bool = True) -> bool:
    """存储单条帖子；唯一约束冲突时回滚并跳过，返回是否成功"""
    try:
        post_repo.create(data, commit=commit)
        return True
    except IntegrityError:
        post_repo.db.rollback()
        logger.warning(f"帖子已存在，跳过: pid={data.get('platform_post_id')}, type={data.get('type')}")
        return False


# 批量入库：每攒满 N 条才 commit 一次，避免每条帖子一次 fsync
# （SQLite 每次 commit 都会触发磁盘同步，全量 1 万帖时性能差异巨大）
_POST_BATCH_SIZE = 50

# 风控续抓：列表页（视频/动态）触发风控后冷却重试本页的次数上限（A）
_PAGE_RETRIES = 2


async def _fetch_posts_core(mid: int, video_pages: int, dynamics_pages: int, db: Session,
                            client: httpx.AsyncClient | None = None,
                            include_videos: bool = True,
                            stop_on_existing: bool = False) -> PostFetchResult:
    """单个账号的帖子抓取核心逻辑（不含锁与 session 管理）。
    video_pages=-1   → 全量拉取视频直到无更多结果。
    dynamics_pages=-1 → 全量拉取动态直到 has_more=false。
    include_videos=False → 只抓动态（更新未归档动态用）。
    client 复用连接池；未传入时自建并在结束/异常时关闭。
    stop_on_existing=True → 增量模式：动态流按时间倒序翻页，遇到第一条
    库中已有的帖子即停止（更早的必然已入库），通常第 1 页即返回；
    首页首条豁免判定——B站常把置顶旧帖排在流首，避免误停漏抓新帖。

    归档边界（devlog/016）：动态/视频按时间倒序翻页，一旦某一整页的帖子
    全部已归档（is_archived=1，即早于归档截止日），更早的页必然也已归档，
    立即停止遍历 —— 归档后的贴文不再参与抓取。
    """
    result = PostFetchResult()
    video_natural = False   # 视频流是否自然走到尾（墓碑判定窗口用，见 tombstone.py）
    dyn_natural = False     # 动态流是否自然走到尾

    # 风控状态为本任务上下文内的干净初值（ContextVar 隔离，见 fetcher.py）
    clear_rate_limit()

    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(timeout=15.0)

    try:
        platform_uid = str(mid)
        post_repo = PostRepo(db)
        # 已入库帖子 ID 集合：内存去重，避免触发唯一约束回滚
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

        # 批量入库：pending 攒满 _POST_BATCH_SIZE 才 commit；
        # 冲突（并发抓取竞态）时回滚整批并逐条重插定位重复项
        pending: list[dict] = []

        def _flush_pending() -> None:
            nonlocal pending
            if not pending:
                return
            try:
                for d in pending:
                    # P2 全文搜索：落库前派生正文纯文本（body_json 已定稿：
                    # enrichment 完成于 pending.append 之前）
                    d["body_text"] = extract_post_text(d.get("body_json"))
                    db.add(Post(**d))
                db.commit()
                result.stored += len(pending)
            except IntegrityError:
                db.rollback()
                saved = 0
                for d in pending:
                    if _safe_store_post(post_repo, d):
                        saved += 1
                    else:
                        result.skipped += 1
                result.stored += saved
            pending = []

        # ── 视频投稿 ──
        if include_videos:
            page = 1
            rl_retries = 0   # 风控重试计数（每个账号列表页，见 _PAGE_RETRIES）
            while True:
                # 断点让位：定时任务请求让位时先落盘，交还锁等待其完成后续跑
                if _yield_request.is_set():
                    _flush_pending()
                    await _maybe_yield_post(db)
                if video_pages == 0 or (video_pages > 0 and page > video_pages):
                    if video_pages != 0:
                        result.stop_reason = "page_limit"
                    break
                vdata = await fetch_bilibili_videos(mid, page=page, client=client)
                if was_rate_limited():
                    # 风控断点续抓（A）：落盘 → 冷却 → 从同一页重试，耗尽次数才放弃
                    _flush_pending()
                    if rl_retries < _PAGE_RETRIES:
                        rl_retries += 1
                        logger.info(f"mid={mid} 视频第{page}页触发风控，冷却 "
                                    f"{settings.RATE_LIMIT_COOLDOWN}s 后重试 ({rl_retries}/{_PAGE_RETRIES})...")
                        clear_rate_limit()
                        await asyncio.sleep(settings.RATE_LIMIT_COOLDOWN)
                        continue
                    clear_rate_limit()
                    result.rate_limited = True
                    result.stop_reason = "rate_limited"
                    break
                if vdata is None:
                    # 非风控失败（网络/接口异常）→ 方案 1：显式标记为中断
                    result.stop_reason = "network_error"
                    break
                if result.video_total is None:
                    result.video_total = vdata.get("total")
                videos = vdata.get("items") or []
                if not videos:
                    video_natural = True    # 列表到底（无更多）
                    break
                if all(v["platform_post_id"] in archived_ids for v in videos):
                    result.archived_stop = True
                    result.stop_reason = "archived_boundary"
                    video_natural = True
                    result.seen_pids.extend(v["platform_post_id"] for v in videos)
                    break
                for v in videos:
                    result.seen_pids.append(v["platform_post_id"])
                    result.videos += 1
                    if v["platform_post_id"] in existing_ids:
                        result.skipped += 1
                        continue
                    pending.append(v)
                    existing_ids.add(v["platform_post_id"])
                    if len(pending) >= _POST_BATCH_SIZE:
                        _flush_pending()
                page += 1
                await asyncio.sleep(1)

        # ── 动态 ──
        offset = ""
        dyn_page = 0
        dyn_rl_retries = 0   # 风控重试计数（每账号动态列表页，见 _PAGE_RETRIES）
        stop_now = False
        while True:
            # 断点让位：定时任务请求让位时先落盘，交还锁等待其完成后续跑
            if _yield_request.is_set():
                _flush_pending()
                await _maybe_yield_post(db)
            if dynamics_pages == 0 or (dynamics_pages > 0 and dyn_page >= dynamics_pages):
                if dynamics_pages != 0:
                    result.stop_reason = "page_limit"
                break
            data = await fetch_bilibili_dynamics(mid, offset=offset, client=client)
            if was_rate_limited():
                # 风控断点续抓（A）：落盘 → 冷却 → 从同一 offset 重试，耗尽次数才放弃
                _flush_pending()
                if dyn_rl_retries < _PAGE_RETRIES:
                    dyn_rl_retries += 1
                    logger.info(f"mid={mid} 动态第{dyn_page + 1}页触发风控，冷却 "
                                f"{settings.RATE_LIMIT_COOLDOWN}s 后重试 ({dyn_rl_retries}/{_PAGE_RETRIES})...")
                    clear_rate_limit()
                    await asyncio.sleep(settings.RATE_LIMIT_COOLDOWN)
                    continue
                clear_rate_limit()
                result.rate_limited = True
                result.stop_reason = "rate_limited"
                break
            if data is None:
                # 非风控失败（网络/接口异常）→ 方案 1：显式标记为中断
                result.stop_reason = "network_error"
                break
            items = data.get("items") or []
            if not items:
                dyn_natural = True   # 空页 → 视为到底（修复空页误判归档边界）
                break   # 空页 → 视为到底（修复空页误判归档边界）
            # 归档边界：整页已归档 → 更早的页必然已归档，停止遍历
            if all(d["platform_post_id"] in archived_ids for d in items):
                result.archived_stop = True
                result.stop_reason = "archived_boundary"
                dyn_natural = True
                result.seen_pids.extend(d["platform_post_id"] for d in items)
                break
            for idx, d in enumerate(items):
                result.seen_pids.append(d["platform_post_id"])
                # 双保险：直播开播动态（fetcher 已过滤，此处兜底，见 devlog/018）
                if d["type"] == "live":
                    continue
                result.dynamics += 1
                if d["platform_post_id"] in existing_ids:
                    result.skipped += 1
                    # 增量模式：遇到已入库即认为更早的都已入库（首页首条豁免，
                    # 防置顶旧帖排在流首导致误停漏抓新帖，见 docstring）
                    if stop_on_existing and not (dyn_page == 0 and idx == 0):
                        result.stopped_early = True
                        result.stop_reason = "stopped_early"
                        result.stop_existing_pid = d["platform_post_id"]
                        stop_now = True
                        break
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

                # 详情风控标志仅用于列表页判定（C）：每条详情处理完立即清除，
                # 避免 fetch_dynamic_detail 置位的标志污染下一页列表请求的判定
                clear_rate_limit()

                pending.append(d)
                existing_ids.add(d["platform_post_id"])
                if len(pending) >= _POST_BATCH_SIZE:
                    _flush_pending()
            dyn_page += 1
            if stop_now:
                # 增量边界已确认：更早的动态必然已在库中，立即收工
                _flush_pending()
                return result
            if not data.get("has_more"):
                dyn_natural = True
                break
            offset = data.get("next_offset", "")
            await asyncio.sleep(20)

        _flush_pending()
        # 墓碑窗口：所有被扫描流都自然走到尾才算可信（任一流中途停止则
        # 未覆盖区域存在，交由 stop_existing_pid 路径判定，见 tombstone.py）
        video_scanned = include_videos and video_pages != 0
        result.natural_end = dyn_natural and (video_natural if video_scanned else True)
        return result
    finally:
        if own_client:
            await client.aclose()


async def _fetch_platform_posts(pf, uid: str, pages: int, db: Session,
                                client: httpx.AsyncClient | None = None,
                                stop_on_existing: bool = False) -> PostFetchResult:
    """通用单流帖子抓取循环（爬虫框架：微博及后续单流平台复用）。

    pages=-1 拉到底；pages=0 不抓；与 _fetch_posts_core 共用同一套基础设施：
    批量落库/内存去重/归档边界/定时任务让位/风控断点续抓/stop_reason 归类。
    计数口径：单流帖子记入 dynamics 桶（与 B 站动态流同一统计位）。
    """
    result = PostFetchResult()
    clear_rate_limit()

    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(timeout=15.0)

    try:
        platform = pf.platform
        post_repo = PostRepo(db)
        existing_ids = {
            r[0] for r in db.query(Post.platform_post_id).filter(
                Post.platform == platform, Post.platform_uid == str(uid)
            ).all()
        }
        archived_ids = {
            r[0] for r in db.query(Post.platform_post_id).filter(
                Post.platform == platform, Post.platform_uid == str(uid),
                Post.is_archived == True,  # noqa: E712
            ).all()
        }

        pending: list[dict] = []

        def _flush_pending() -> None:
            nonlocal pending
            if not pending:
                return
            try:
                for d in pending:
                    # P2 全文搜索：落库前派生正文纯文本（enrich 于 append 前完成）
                    d["body_text"] = extract_post_text(d.get("body_json"))
                    db.add(Post(**d))
                db.commit()
                result.stored += len(pending)
            except IntegrityError:
                db.rollback()
                saved = 0
                for d in pending:
                    if _safe_store_post(post_repo, d):
                        saved += 1
                    else:
                        result.skipped += 1
                result.stored += saved
            pending = []

        page = 1
        rl_retries = 0
        while True:
            # 断点让位：定时任务请求让位时先落盘，交还锁等待其完成后续跑
            if _yield_request.is_set():
                _flush_pending()
                await _maybe_yield_post(db)
            if pages == 0 or (pages > 0 and page > pages):
                if pages != 0:
                    result.stop_reason = "page_limit"
                break
            data = await pf.fetch_post_page(str(uid), page, client=client)
            if was_rate_limited():
                # 风控断点续抓（A）：落盘 → 冷却 → 从同一页重试，耗尽次数才放弃
                _flush_pending()
                if rl_retries < _PAGE_RETRIES:
                    rl_retries += 1
                    logger.info(f"{platform}:{uid} 第{page}页触发风控，冷却 "
                                f"{settings.RATE_LIMIT_COOLDOWN}s 后重试 ({rl_retries}/{_PAGE_RETRIES})...")
                    clear_rate_limit()
                    await asyncio.sleep(settings.RATE_LIMIT_COOLDOWN)
                    continue
                clear_rate_limit()
                result.rate_limited = True
                result.stop_reason = "rate_limited"
                break
            if data is None:
                result.stop_reason = "network_error"
                break
            items = data.get("items") or []
            if not items:
                result.natural_end = True   # 空页 → 视为到底
                break   # 空页 → 视为到底
            # 归档边界：整页已归档 → 更早的页必然已归档，停止遍历
            if all(d["platform_post_id"] in archived_ids for d in items):
                result.archived_stop = True
                result.stop_reason = "archived_boundary"
                result.natural_end = True
                result.seen_pids.extend(d["platform_post_id"] for d in items)
                break
            for idx, d in enumerate(items):
                result.seen_pids.append(d["platform_post_id"])
                result.dynamics += 1
                if d["platform_post_id"] in existing_ids:
                    result.skipped += 1
                    # 增量模式：遇已入库即认为更早的都已入库（首页首条豁免防置顶误停）
                    if stop_on_existing and not (page == 1 and idx == 0):
                        result.stopped_early = True
                        result.stop_reason = "stopped_early"
                        result.stop_existing_pid = d["platform_post_id"]
                        _flush_pending()
                        return result
                    continue

                # 详情补全（长文全文等）；风控标志仅用于列表页判定（C）
                if await pf.enrich(d, client=client):
                    await asyncio.sleep(random.uniform(0.5, 1.5))
                clear_rate_limit()

                pending.append(d)
                existing_ids.add(d["platform_post_id"])
                if len(pending) >= _POST_BATCH_SIZE:
                    _flush_pending()
            if not data.get("has_more"):
                result.natural_end = True
                break
            page += 1
            await asyncio.sleep(20)

        _flush_pending()
        return result
    finally:
        if own_client:
            await client.aclose()


async def _fetch_posts_for_account(acc: Account, video_pages: int, dynamics_pages: int,
                                   db: Session, client: httpx.AsyncClient | None = None,
                                   include_videos: bool = True,
                                   stop_on_existing: bool = False) -> PostFetchResult:
    """按平台分发单个账号的帖子抓取：
    - bilibili → 双流核心 _fetch_posts_core（视频+动态、归档边界、视频总数比对）
    - weibo 等单流平台 → 通用循环 _fetch_platform_posts

    抓取结束后统一执行墓碑判定（删除检测，v0.5.1）——本函数是各调用方
    （增量更新/全量抓取/按名抓取）的共同必经点，判定结果写入 detail，
    失败只记日志，不影响抓取结果。
    """
    pf = registry.get_fetcher(acc.platform)
    if pf is None:
        return PostFetchResult(stop_reason="error", error=f"不支持的平台 '{acc.platform}'")
    if acc.platform == "bilibili":
        try:
            mid = int(acc.platform_uid)
        except (TypeError, ValueError):
            return PostFetchResult(stop_reason="error", error="非数字 UID")
        result = await _fetch_posts_core(mid, video_pages, dynamics_pages, db,
                                         client=client, include_videos=include_videos,
                                         stop_on_existing=stop_on_existing)
    else:
        result = await _fetch_platform_posts(pf, str(acc.platform_uid), dynamics_pages, db,
                                             client=client, stop_on_existing=stop_on_existing)
    _run_tombstone_scan(db, acc, result, include_videos=include_videos)
    return result


def _run_tombstone_scan(db: Session, acc: Account, result: PostFetchResult,
                        include_videos: bool) -> list[Post]:
    """对单个账号的扫描结果执行墓碑判定（v0.5.1）。

    本轮时间取扫描后的当前时刻（naive UTC，与库内约定一致）；
    判定只在「窗口可信」时生效（见 tombstone.py），否则仅推进 last_seen
    刷新与扫描标记，不影响任何抓取数据。
    """
    round_ts = datetime.now(timezone.utc).replace(tzinfo=None)
    try:
        tombstoned = apply_tombstone_scan(
            db, acc,
            seen_pids=result.seen_pids,
            natural_end=result.natural_end,
            stop_existing_pid=result.stop_existing_pid,
            round_ts=round_ts,
            exclude_types={"video"} if not include_videos else None,
        )
        if tombstoned:
            logger.info(
                f"墓碑机制: {acc.platform}:{acc.platform_uid} 判定 "
                f"{len(tombstoned)} 条帖子已删除: "
                + ", ".join(p.platform_post_id for p in tombstoned[:5])
                + ("..." if len(tombstoned) > 5 else "")
            )
        return tombstoned
    except Exception:
        logger.error(f"墓碑判定异常 {acc.platform}:{acc.platform_uid}:", exc_info=True)
        db.rollback()
        return []


async def async_fetch_posts(platform: str, uid: str, video_pages: int, dynamics_pages: int) -> PostFetchResult:
    """单个账号的帖子抓取（带锁，供 fetch-posts 端点调用）；按平台分发。"""
    global _post_fetch_running

    if not _post_fetch_lock.acquire(blocking=False):
        logger.warning("帖子抓取正在进行中，跳过本次触发")
        return PostFetchResult()

    _post_fetch_running = True
    _status["post"]["running"] = True
    _set_post_target(str(uid))
    res_seq = _next_result_seq()
    db: Session = SessionLocal()
    client = httpx.AsyncClient(timeout=15.0)
    out: PostFetchResult | None = None
    try:
        acc = db.query(Account).filter(
            Account.platform == platform, Account.platform_uid == str(uid)
        ).first()
        if acc is None:
            out = PostFetchResult(stop_reason="error", error=f"账号 {platform}:{uid} 不存在")
            return out
        # 统一走按账号分发入口（含墓碑判定；参数默认全量）
        out = await _fetch_posts_for_account(acc, video_pages, dynamics_pages, db, client=client)
        return out
    except Exception as e:
        logger.error(f"帖子抓取异常 {platform}:{uid}: {e}", exc_info=True)
        db.rollback()
        out = PostFetchResult(stop_reason="error", error=str(e))
        return out
    finally:
        db.close()
        await client.aclose()
        _post_fetch_running = False
        _reset_post_status()
        _post_fetch_lock.release()
        if out is not None:
            lossy = out.stop_reason in ("rate_limited", "network_error", "error")
            video_missing = None
            if out.video_total is not None and out.stop_reason in ("rate_limited", "network_error"):
                video_missing = max(0, out.video_total - out.videos)
            _set_post_last_result(
                res_seq, "quick",
                _status["post"]["target"] or str(uid),
                out.videos, out.dynamics, out.stored, out.skipped,
                ([{"label": f"{platform}:{uid}", "stop_reason": out.stop_reason,
                   "error": out.error}] if lossy else []),
                video_missing,
            )


async def async_fetch_all_posts() -> dict:
    """对库中所有账号（bilibili+微博等）逐个全量抓取帖子（按平台分发）。"""
    global _post_fetch_running

    if not _post_fetch_lock.acquire(blocking=False):
        logger.warning("帖子抓取正在进行中，跳过本次触发")
        return {"status": "skipped", "message": "帖子抓取任务正在进行中"}

    _post_fetch_running = True
    _status["post"]["running"] = True
    res_seq = _next_result_seq()
    total = {"videos": 0, "dynamics": 0, "stored": 0, "skipped": 0}
    details = []
    issues: list[dict] = []
    video_missing = 0
    out: dict = {}
    db: Session = SessionLocal()
    client = httpx.AsyncClient(timeout=15.0)

    try:
        accounts = AccountRepo(db).all_for_fetch()

        if not accounts:
            logger.warning("没有可抓取的账号")
            out = {"status": "done", "total": total, "details": details}
            return out

        for idx, acc in enumerate(accounts):
            # 断点让位：定时任务请求让位时交还锁，等待其完成后续跑（同一账号列表序号）
            if _yield_request.is_set():
                await _maybe_yield_post(db)
            _set_post_target(acc.display_name or str(acc.platform_uid))
            logger.info(f"[{idx+1}/{len(accounts)}] 全量抓取 {acc.platform}:{acc.platform_uid} "
                        f"({acc.display_name or ''}) 的帖子...")
            try:
                r = await _fetch_posts_for_account(acc, -1, -1, db, client=client)
            except Exception as e:
                logger.error(f"帖子抓取异常 {acc.platform}:{acc.platform_uid}: {e}", exc_info=True)
                db.rollback()
                r = PostFetchResult(stop_reason="error", error=str(e))

            vm = None
            if r.video_total is not None and r.stop_reason in ("rate_limited", "network_error"):
                vm = max(0, r.video_total - r.videos)
                video_missing += vm
            details.append({
                "platform": acc.platform,
                "platform_uid": acc.platform_uid,
                "videos": r.videos, "dynamics": r.dynamics,
                "stored": r.stored, "skipped": r.skipped,
                "rate_limited": r.rate_limited,
                "stop_reason": r.stop_reason, "error": r.error,
                "video_missing": vm,
            })
            for k in ("videos", "dynamics", "stored", "skipped"):
                total[k] += getattr(r, k)
            if r.stop_reason in ("rate_limited", "network_error", "error"):
                issues.append({"label": f"{acc.platform}:{acc.platform_uid}",
                               "stop_reason": r.stop_reason, "error": r.error})

            if r.rate_limited:
                logger.warning(f"{acc.platform}:{acc.platform_uid} 触发风控，冷却 {settings.RATE_LIMIT_COOLDOWN}s...")
                await asyncio.sleep(settings.RATE_LIMIT_COOLDOWN)
            elif idx < len(accounts) - 1:
                await asyncio.sleep(20)

        out = {"status": "done", "total": total, "details": details}
        return out

    except Exception as e:
        logger.error(f"全量帖子抓取任务出错: {e}", exc_info=True)
        db.rollback()
        out = {"status": "done", "total": total, "details": details, "error": str(e)}
        return out
    finally:
        db.close()
        await client.aclose()
        _post_fetch_running = False
        _reset_post_status()
        _post_fetch_lock.release()
        _set_post_last_result(res_seq, "full_all", "全部账号",
                              total["videos"], total["dynamics"],
                              total["stored"], total["skipped"],
                              issues, video_missing or None)


def _last_result_for_scope(res_seq: int, kind: str, label: str, total: dict,
                           issues: list[dict], video_missing: int | None) -> None:
    """外层帖子任务的 last_result 记录（供 async_fetch_vtuber_posts 等复用）。"""
    _set_post_last_result(res_seq, kind, label,
                          total.get("videos", 0), total.get("dynamics", 0),
                          total.get("stored", 0), total.get("skipped", 0),
                          issues, video_missing)


async def async_fetch_vtuber_posts(name: str, platform: str = "bilibili") -> dict:
    """按名字全量抓取某个（些）VTuber 的帖子（视频+动态，-1/-1 拉到底）。

    后台任务用（/vtuber/fetch-posts?full=true 触发）：自带 Session 与锁，
    风控冷却后继续下一个账号；进度经 /vtuber/fetch-status 的 post.target 可见。
    """
    global _post_fetch_running

    if not _post_fetch_lock.acquire(blocking=False):
        logger.warning("帖子抓取正在进行中，跳过本次触发")
        return {"status": "skipped", "message": "帖子抓取任务正在进行中"}

    _post_fetch_running = True
    _status["post"]["running"] = True
    res_seq = _next_result_seq()
    total = {"videos": 0, "dynamics": 0, "stored": 0, "skipped": 0}
    details = []
    issues: list[dict] = []
    video_missing = 0
    out: dict = {}
    db: Session = SessionLocal()
    client = httpx.AsyncClient(timeout=15.0)

    try:
        vtubers = db.query(VTuber).filter(VTuber.name.contains(name)).all()
        if not vtubers:
            logger.warning(f"未找到名字包含 '{name}' 的 VTuber")
            out = {"status": "done", "message": f"未找到名字包含 '{name}' 的 VTuber",
                   "total": total, "details": details}
            return out

        accounts: list[Account] = []
        for v in vtubers:
            for a in db.query(Account).filter(Account.vtuber_id == v.id).all():
                if a.platform == platform and a.platform_uid and a.platform_uid.isdigit():
                    accounts.append(a)

        if not accounts:
            logger.warning(f"名字包含 '{name}' 的 VTuber 没有可抓取的账号")
            out = {"status": "done", "total": total, "details": details}
            return out

        for idx, acc in enumerate(accounts):
            # 断点让位：定时任务请求让位时交还锁，等待其完成后续跑（同一账号列表序号）
            if _yield_request.is_set():
                await _maybe_yield_post(db)
            _set_post_target(acc.display_name or str(acc.platform_uid))
            logger.info(f"[{idx+1}/{len(accounts)}] 全量抓取帖子 {acc.platform}:{acc.platform_uid} "
                        f"({acc.display_name or ''}) ...")
            try:
                r = await _fetch_posts_for_account(acc, -1, -1, db, client=client)
            except Exception as e:
                logger.error(f"帖子抓取异常 {acc.platform}:{acc.platform_uid}: {e}", exc_info=True)
                db.rollback()
                r = PostFetchResult(stop_reason="error", error=str(e))

            vm = None
            if r.video_total is not None and r.stop_reason in ("rate_limited", "network_error"):
                vm = max(0, r.video_total - r.videos)
                video_missing += vm
            details.append({
                "platform": acc.platform,
                "platform_uid": acc.platform_uid,
                "videos": r.videos, "dynamics": r.dynamics,
                "stored": r.stored, "skipped": r.skipped,
                "rate_limited": r.rate_limited,
                "stop_reason": r.stop_reason, "error": r.error,
                "video_missing": vm,
            })
            for k in ("videos", "dynamics", "stored", "skipped"):
                total[k] += getattr(r, k)
            if r.stop_reason in ("rate_limited", "network_error", "error"):
                issues.append({"label": f"{acc.platform}:{acc.platform_uid}",
                               "stop_reason": r.stop_reason, "error": r.error})

            if r.rate_limited:
                logger.warning(f"uid={acc.platform_uid} 触发风控，冷却 {settings.RATE_LIMIT_COOLDOWN}s...")
                await asyncio.sleep(settings.RATE_LIMIT_COOLDOWN)
            elif idx < len(accounts) - 1:
                await asyncio.sleep(20)

        out = {"status": "done", "total": total, "details": details}
        return out

    except Exception as e:
        logger.error(f"全量帖子抓取任务出错: {e}", exc_info=True)
        db.rollback()
        out = {"status": "done", "total": total, "details": details, "error": str(e)}
        return out
    finally:
        db.close()
        await client.aclose()
        _post_fetch_running = False
        _reset_post_status()
        _post_fetch_lock.release()
        _last_result_for_scope(res_seq, "full_vtuber", name, total, issues, video_missing or None)


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
    res_seq = _next_result_seq()
    db: Session = SessionLocal()
    client = httpx.AsyncClient(timeout=15.0)
    total = {"dynamics": 0, "stored": 0, "skipped": 0}
    details = []
    issues: list[dict] = []
    archived = 0
    rate_limited_any = False
    out: dict = {}

    try:
        # 1. 归档规则
        archived = archive_old_posts(db=db)
        logger.info(f"归档规则执行完成: {archived} 条帖子已归档（早于 30 天前）")

        # 2. 定位目标账号（全平台：bilibili 动态 + 微博流均支持增量）
        q = AccountRepo(db).all_for_fetch()
        if name:
            vids = [v.id for v in db.query(VTuber).filter(VTuber.name.contains(name)).all()]
            if not vids:
                out = {"status": "done", "archived": archived,
                       "message": f"未找到名字包含 '{name}' 的 VTuber",
                       "total": total, "details": details}
                return out
            q = [a for a in q if a.vtuber_id in vids]
        accounts = q

        if not accounts:
            logger.warning("没有可抓取的 bilibili 账号")
            out = {"status": "done", "archived": archived,
                   "total": total, "details": details}
            return out

        for idx, acc in enumerate(accounts):
            # 断点让位：定时任务请求让位时交还锁，等待其完成后续跑（同一账号列表序号）
            if _yield_request.is_set():
                await _maybe_yield_post(db)
            _set_post_target(acc.display_name or str(acc.platform_uid))
            logger.info(f"[{idx+1}/{len(accounts)}] 更新未归档 {acc.platform}:{acc.platform_uid} "
                        f"({acc.display_name or ''}) ...")
            try:
                r = await _fetch_posts_for_account(acc, -1, -1, db, client=client,
                                                   include_videos=False,
                                                   stop_on_existing=True)
            except Exception as e:
                logger.error(f"更新动态异常 {acc.platform}:{acc.platform_uid}: {e}", exc_info=True)
                db.rollback()
                r = PostFetchResult(stop_reason="error", error=str(e))

            rate_limited_any = rate_limited_any or r.rate_limited
            details.append({
                "platform": acc.platform,
                "platform_uid": acc.platform_uid,
                "dynamics": r.dynamics, "stored": r.stored, "skipped": r.skipped,
                "archived_stop": r.archived_stop,
                "rate_limited": r.rate_limited,
                "stop_reason": r.stop_reason, "error": r.error,
            })
            for k in ("dynamics", "stored", "skipped"):
                total[k] += getattr(r, k)
            if r.stop_reason in ("rate_limited", "network_error", "error"):
                issues.append({"label": f"{acc.platform}:{acc.platform_uid}",
                               "stop_reason": r.stop_reason, "error": r.error})

            if r.rate_limited:
                logger.warning(f"uid={acc.platform_uid} 触发风控，冷却 {settings.RATE_LIMIT_COOLDOWN}s...")
                await asyncio.sleep(settings.RATE_LIMIT_COOLDOWN)
            elif idx < len(accounts) - 1:
                await asyncio.sleep(20)

        out = {"status": "done", "archived": archived, "total": total, "details": details,
               "rate_limited": rate_limited_any}
        return out

    except Exception as e:
        logger.error(f"更新未归档动态任务出错: {e}", exc_info=True)
        db.rollback()
        out = {"status": "done", "archived": archived, "total": total, "details": details,
               "rate_limited": rate_limited_any, "error": str(e)}
        return out
    finally:
        db.close()
        await client.aclose()
        _post_fetch_running = False
        _reset_post_status()
        _post_fetch_lock.release()
        _last_result_for_scope(res_seq, "update_unarchived", name or "全部",
                               total, issues, None)
