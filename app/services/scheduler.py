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
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.http import new_async_client
from app.models.vtuber import Account, VTuber, Post
from app.repositories.vtuber_repo import (
    VTuberRepo, AccountRepo, PostRepo, AccountStatSnapshotRepo, LiveSessionRepo,
    AppMetaRepo,
)
from app.services.fetcher import (
    fetch_bilibili_user_info, fetch_bilibili_user_stat,
    fetch_bilibili_videos, fetch_bilibili_dynamics, fetch_bilibili_live_batch,
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
# 当前账号抓取的范围：'full'=全量（与定时任务内容一致）/ 'single'=单 V /
# None=无任务在跑。定时任务判断「内容一致 → 跳过不接管」的依据。
_fetch_scope: str | None = None
# T4 外部数据批次是否正在跑：综合档据此避开（外部任务等手动任务时不算忙）。
_external_running = False

# ── 实时状态（供 /vtuber/fetch-status 轮询；仅简单赋值，GIL 下线程安全）──
# P8-C（2026-09-10）：两个抓取流都带 `task`（任务名）+ `vtuber_name`（V 名）
# + `index/total`（进度），顶栏据此拼「动态更新中 - 明前奶绿 - 1/11」。
_status: dict = {
    "account": {"running": False, "current": None, "index": 0, "total": 0,
                "task": None, "vtuber_name": None,
                "recent": []},   # 最近完成的账号字段快照，供前端就地增量刷新侧栏
    "post": {"running": False, "target": None, "task": None, "vtuber_name": None,
             "index": 0, "total": 0},
    # 外部第三方数据任务（收录回填 / 每日批次）：running/label 供顶栏胶囊展示，
    # seq 每次完成自增——前端据此发 fetch-idle 让档案卡片刷新（v0.9.4）
    "external": {"running": False, "label": None, "last_label": None, "seq": 0},
}

# 外部任务登记表：token → 展示文案（并发时合并显示；全部结束才置 running=False）
_external_labels: dict[str, str] = {}
_external_done_seq = 0


def external_task_started(token: str, label: str) -> None:
    """外部数据任务进入运行态：顶栏状态胶囊展示进度。

    token 用于并发去重（如 `adopt:22` / `daily` / `weekly`），label 是给用户看的文案。
    """
    _external_labels[token] = label
    _status["external"]["running"] = True
    _status["external"]["label"] = "、".join(dict.fromkeys(_external_labels.values()))


def external_task_finished(token: str) -> None:
    """外部数据任务结束：seq 自增（前端据变化发 fetch-idle 刷新档案卡片）。"""
    global _external_done_seq
    label = _external_labels.pop(token, None)
    _external_done_seq += 1
    _status["external"]["seq"] = _external_done_seq
    if label:
        _status["external"]["last_label"] = label
    _status["external"]["running"] = bool(_external_labels)
    _status["external"]["label"] = (
        "、".join(dict.fromkeys(_external_labels.values())) or None)


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


def _vtuber_name_of(acc: Account) -> str | None:
    """账号所属 VTuber 名（P8-C：顶栏「任务 - V名 - i/N」用）。

    走 ORM 关系（`accounts.vtuber_id → vtubers.name`）；对象 detached / 关系未加载
    时返回 None，绝不因此抛错（进度显示不能影响抓取）。
    """
    try:
        return acc.vtuber.name if acc.vtuber else None
    except Exception:
        return None


def _set_account_progress(current: str | None, index: int, total: int,
                          *, vtuber_name: str | None = None) -> None:
    """账号流进度（顶栏胶囊：任务 - V名 - i/N）。

    `current` 是过程性文案（平台名/账号名），`vtuber_name` 是 P8-C 新增的结构化字段
    ——顶栏优先显示 V 名，缺省才退回 current。
    """
    st = _status["account"]
    st["current"] = current
    st["index"] = index
    st["total"] = total
    if vtuber_name is not None:
        st["vtuber_name"] = vtuber_name


def _set_account_vtuber(name: str | None) -> None:
    """单独更新账号流的 V 名（轮次式账号流：index/total 由轮次汇报，V 名由 worker 写）。"""
    _status["account"]["vtuber_name"] = name


def _reset_account_status() -> None:
    _set_account_progress(None, 0, 0)
    _status["account"]["task"] = None
    _status["account"]["vtuber_name"] = None
    _status["account"]["running"] = False


def _set_post_target(target: str | None) -> None:
    _status["post"]["target"] = target


def _set_post_progress(task: str, vtuber_name: str | None, index: int, total: int) -> None:
    """帖子流进度（P8-C）：任务名 + V 名 + i/N，供顶栏拼「动态更新中 - 明前奶绿 - 1/11」。

    旧字段 `target` 语义混用（单V=uid / 按账号=昵称 / 动态流=平台名拼接），
    这里统一成结构化三元组；`_set_post_target` 保留给无进度信息的路径。
    """
    st = _status["post"]
    st["task"] = task
    st["vtuber_name"] = vtuber_name
    st["index"] = index
    st["total"] = total
    st["target"] = vtuber_name or st.get("target")


def _reset_post_status() -> None:
    _set_post_target(None)
    st = _status["post"]
    st["task"] = None
    st["vtuber_name"] = None
    st["index"] = 0
    st["total"] = 0
    st["running"] = False


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
    """返回账号信息 / 帖子 / 外部数据三类任务的实时状态快照。

    另带两个**给前端做展示与禁用决策**的判据（2026-09-10 用户反馈「频繁的动态轮询
    不必占顶栏」——顶栏只该显示有起点有终点的任务，自动节拍会一直重复）：

    - 每类的 `auto`：本次运行是否由**定时档**（综合档两条流）发起。动态流是常态节拍
      （一轮 ~80s 接着下一轮，没有终局），自动账号流同理 → 前端据此把它们排除出顶栏
      文案/容器与关窗确认；完成刷新事件（`fetch-idle` 边沿）照旧，卡片仍会跟着更新。
    - 顶层 `manual_running`：与手动端点的 409 判据**同源**（`manual_task_running()`：
      自动档持锁不算忙）。前端按钮禁用改用它——此前拿 `account.running or post.running`
      当忙，用户会在自动节拍期间点不动任何手动按钮，而后端其实会受理（手动优先会抢占）。
    """
    return {
        "account": {**_status["account"], "auto": _auto_account_active.is_set()},
        "post": {**_status["post"], "auto": _auto_post_active.is_set()},
        "external": dict(_status["external"]),
        "manual_running": manual_task_running(),
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
            client = new_async_client(15.0)
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


def _field_locked(acc: Account, field: str) -> bool:
    """该字段是否被用户手动锁定（P8-B：`accounts.locked_fields` 逗号分隔）。

    锁定的字段抓取时**不覆盖** —— 用户在「档案设置」里改的昵称/签名/头像不该被
    下一次平台抓取冲掉（`info.get("name") or acc.display_name` 这类赋值天然会覆盖）。
    """
    raw = (acc.locked_fields or "").strip()
    if not raw:
        return False
    return field in {x.strip() for x in raw.split(",") if x.strip()}


async def _fetch_one_account(acc: Account, db: Session, client: httpx.AsyncClient | None = None,
                             *, pending_avatar: list[str] | None = None) -> bool:
    """抓取单个 Account 的数据（按平台分发到平台框架），返回是否成功。

    client 复用连接池，避免每请求新建连接；风控由上层统一冷却退避。

    `pending_avatar`（v0.9.4 收录提速）：传入列表时**头像下载不阻塞本函数**——
    只写入 `avatar_url`，把待下载 URL 追加到该列表，由调用方在 commit + 推送
    快照之后起独立任务下载（见 `_deferred_avatar`）。账号信息（昵称/签名/粉丝/
    直播状态）因此提前 0.5~2s 可见；前端 avatar_url 直链兜底，本地文件到位后
    再推一次快照就地替换。定时账号流不传该参数，行为不变。
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
            # P8-B：被用户锁定的字段不覆盖（「档案设置」里手改的昵称/签名/头像）
            if not _field_locked(acc, "display_name"):
                acc.display_name = info.get("name") or acc.display_name
            if not _field_locked(acc, "sign"):
                acc.sign = info.get("sign") or acc.sign

            new_avatar = info.get("avatar")
            if new_avatar and not _field_locked(acc, "avatar"):
                # 修复（devlog/019）：URL 变化 → 下载；URL 未变但本地文件缺失 → 补下
                file_exists = not _avatar_missing(acc)
                if _needs_avatar_download(acc, new_avatar, file_exists):
                    acc.avatar_url = new_avatar
                    if pending_avatar is not None:
                        # 延后下载（收录/加账号的 fast 路径）：先让账号字段落库可见
                        pending_avatar.append(new_avatar)
                    else:
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


async def _deferred_avatar(account_id: int, url: str) -> None:
    """延后头像下载（v0.9.4 收录提速）：不阻塞账号信息首屏。

    只 UPDATE `avatar_path` 一列（不碰其它字段，避免与并发抓取互相覆盖），
    随后再推一次账号快照——前端 `account-progress` 内容 diff 会就地合并头像，
    无需重新拉取列表。账号已被删除（UPDATE 影响 0 行）或下载失败仅记日志：
    `_avatar_missing` 会在下次抓取时自动补下。
    """
    db: Session = SessionLocal()
    try:
        acc = db.get(Account, account_id)
        if acc is None:
            return
        path = await _download_avatar(url, f"{acc.platform}_{acc.platform_uid}")
        if not path:
            logger.warning(f"头像延后下载未成功 account#{account_id}: {url}")
            return
        changed = db.query(Account).filter(Account.id == account_id).update(
            {Account.avatar_path: path}, synchronize_session=False)
        db.commit()
        if not changed:
            return  # 账号已在本任务期间被删除
        db.expire_all()
        fresh = db.get(Account, account_id)
        if fresh is not None:
            _push_account_snapshot(fresh)
        logger.info(f"头像延后下载完成 account#{account_id} → {path}")
    except Exception as e:
        logger.warning(f"头像延后下载失败 account#{account_id}: {type(e).__name__}: {e}")
    finally:
        db.close()


def _accounts_by_ids(db: Session, account_ids: list[int]) -> list[Account]:
    """按 id 精确取账号（保持入参顺序，缺失的忽略）。

    收录/加账号走这条路径：只抓新增的那一个账号，不再把该 V 的所有账号重抓一遍。
    """
    if not account_ids:
        return []
    rows = db.query(Account).filter(Account.id.in_(list(account_ids))).all()
    by_id = {a.id: a for a in rows}
    return [by_id[i] for i in account_ids if i in by_id]


def _manual_interval(fast: bool) -> float:
    """手动单V/收录路径的账号间隔：fast 只做轻微间隔（账号数少），否则沿用 3~5s。"""
    if fast:
        return random.uniform(settings.MANUAL_FAST_INTERVAL_MIN,
                              settings.MANUAL_FAST_INTERVAL_MAX)
    return random.uniform(settings.REQUEST_INTERVAL_MIN, settings.REQUEST_INTERVAL_MAX)


async def async_fetch_accounts(account_ids: list[int], *, label: str = "指定账号",
                               fast: bool = True) -> FetchResult:
    """按账号 id 精确抓取账号信息（手动优先，v0.9.4）。

    - `fast=True`（收录 / 加账号 / 单 V 抓取）：**每个账号抓完立即 commit + 推送
      快照**，节流只在账号之间生效（0.5~1s），头像下载延后（见 `_fetch_one_account`）
      —— 用户添加新 V 后 1~4s 就能看到昵称/签名/粉丝/直播状态（v0.9.3 之前要
      5~12s：末尾还有一段 3~5s 空转 sleep，且头像阻塞在提交之前）；
    - `fast=False`：沿用 3~5s 间隔（保留给需要更保守节奏的调用方）；
    - 抢不到锁时**不静默丢弃**：入队 `_pending_account_fetch`，由综合档心跳在锁
      空闲时优先消费（见 `_drain_pending_fetches`）。
    """
    global _fetch_running, _fetch_scope

    if not account_ids:
        return FetchResult(details=["没有可抓取的账号"])

    if not await _acquire_manual_account():
        for aid in account_ids:
            _enqueue_pending_account(aid)
        logger.warning(f"{label}: 账号抓取锁被占用，{len(account_ids)} 个账号已排队等待补抓")
        return FetchResult(details=["账号抓取正在进行中，已排队等待"])

    _fetch_running = True
    _fetch_scope = "single"
    _status["account"]["running"] = True
    _status["account"]["task"] = "account"   # P8-C：顶栏文案「账号信息抓取中」
    _status["account"]["recent"] = []   # 每轮自包含：清空上一任务的快照
    result = FetchResult()
    res_seq = _next_result_seq()
    clear_rate_limit()
    client = new_async_client(15.0)

    db: Session = SessionLocal()
    try:
        accounts = _accounts_by_ids(db, account_ids)
        if not accounts:
            logger.warning(f"{label} 没有可抓取的账号")
            result.details.append("没有可抓取的账号")
            return result

        idx = 0
        while idx < len(accounts):
            acc = accounts[idx]
            _set_account_progress(acc.display_name or str(acc.platform_uid), idx + 1, len(accounts),
                                  vtuber_name=_vtuber_name_of(acc))
            pending_avatar: list[str] | None = [] if fast else None
            ok = await _fetch_one_account(acc, db, client=client,
                                          pending_avatar=pending_avatar)

            if was_rate_limited():
                db.commit()
                db.close()
                logger.warning(f"触发风控 ({rate_limit_info()})，冷却 {settings.RATE_LIMIT_COOLDOWN}s...")
                clear_rate_limit()
                await asyncio.sleep(settings.RATE_LIMIT_COOLDOWN)
                db = SessionLocal()
                # 修复：冷却后必须重查账号 —— 旧会话已关闭，原列表里的 acc 是
                # detached 对象，继续赋值不会进入新会话，后续更新会静默丢失
                accounts = _accounts_by_ids(db, account_ids)
                continue

            # 节流只在账号之间：最后一个账号抓完立即落库（去掉末尾空转）
            if idx < len(accounts) - 1:
                await asyncio.sleep(_manual_interval(fast))

            if ok:
                _record_stat_snapshot(db, acc)
                db.commit()
                _push_account_snapshot(acc)
                if pending_avatar:
                    # 首屏已可见，头像随后补齐（不阻塞本任务）
                    asyncio.create_task(_deferred_avatar(acc.id, pending_avatar[0]))
                result.success += 1
            else:
                result.failed += 1
                result.details.append(f"{acc.display_name or acc.platform_uid} 更新失败")
            idx += 1

        logger.info(f"{label} 抓取完毕: {result.success} 成功, {result.failed} 失败")

    except Exception as e:
        logger.error(f"{label} 抓取出错: {e}", exc_info=True)
        db.rollback()
        result.details.append(f"异常: {e}")
    finally:
        db.close()
        await client.aclose()
        _fetch_running = False
        _fetch_scope = None
        _reset_account_status()
        _fetch_lock.release()
        _set_account_last_result(res_seq, label, result.success, result.failed, result.skipped)

    return result


async def async_fetch_and_update(auto: bool = False) -> FetchResult:
    """账号流：全量账号信息抓取（原 T1 主账号 + T3a 全量合并，v0.9.3）。

    - 并发粒度 = 平台：每轮各平台各抓一个账号（平台间并行、平台内串行），
      单平台请求速率与原来一致（用户 2026-09-09 定稿）；
    - auto=False（手动：抓取账号 / 批量抓取）：抢锁时若定时档在跑则请求其让位；
    - auto=True（综合档账号流）：锁被占即跳过；轮与轮之间给手动任务让位。
    """
    global _fetch_running, _fetch_scope

    if auto:
        if not _fetch_lock.acquire(blocking=False):
            logger.info("综合档账号流跳过：账号抓取正在进行（手动优先）")
            return FetchResult(details=["账号抓取进行中，跳过"])
        _auto_account_active.set()
    elif not await _acquire_manual_account():
        logger.warning("上一次抓取尚未完成，跳过本次触发")
        return FetchResult(details=["上一次抓取仍在进行中，已跳过"])

    _fetch_running = True
    _fetch_scope = "full"
    _status["account"]["running"] = True
    _status["account"]["task"] = "account"   # P8-C：顶栏文案「账号信息抓取中」
    _status["account"]["recent"] = []   # 每轮自包含：清空上一任务的快照
    result = FetchResult()
    res_seq = _next_result_seq()

    # 风控状态为本任务上下文内的干净初值（ContextVar 隔离，见 fetcher.py）
    clear_rate_limit()

    # 复用连接池：一次抓取任务共用一个 AsyncClient（含重试与风控冷却期间）
    client = new_async_client(15.0)

    db: Session = SessionLocal()          # 账号列表查询 + 让位提交；各平台另有会话
    sessions: dict[str, Session] = {}
    try:
        logger.info("开始抓取数据...")
        accounts = AccountRepo(db).all_for_fetch()

        if not accounts:
            logger.warning("没有可抓取的账号。")
            result.details.append("没有可抓取的账号")
            return result

        groups: dict[str, list[Account]] = {}
        for acc in accounts:
            groups.setdefault(acc.platform, []).append(acc)
        for pf in groups:
            sessions[pf] = SessionLocal()
        processed: dict[str, int] = {pf: 0 for pf in groups}

        def commit_all() -> None:
            for s in sessions.values():
                s.commit()

        async def worker(pf: str, acc: Account) -> _RoundOutcome:
            s = sessions[pf]
            # 账号对象必须属于本平台会话（否则 commit 落不到它身上）
            local = s.get(Account, acc.id)
            if local is None:
                return _RoundOutcome(ok=False, error=f"账号 {acc.id} 已不存在")
            logger.info(f"[{pf}] 账号 {local.display_name or local.platform_uid} ...")
            # P8-C：顶栏显示「账号信息抓取中 - {V名} - i/N」（index/total 由轮次汇报）
            _set_account_vtuber(_vtuber_name_of(local))
            try:
                ok = await _fetch_one_account(local, s, client=client)
                if ok:
                    _record_stat_snapshot(s, local)
                    s.commit()
                    _push_account_snapshot(local)
                else:
                    s.rollback()
                return _RoundOutcome(ok=ok, rate_limited=was_rate_limited(),
                                     payload=local)
            except Exception as e:
                s.rollback()
                logger.error(f"抓取 account#{acc.id} ({pf}) 异常: {type(e).__name__}: {e}")
                return _RoundOutcome(ok=False, error=str(e),
                                     rate_limited=was_rate_limited(), payload=local)
            finally:
                # 平台内节流 + 批次休息（每个平台各自计数）
                processed[pf] += 1
                if processed[pf] % settings.FETCH_BATCH_SIZE == 0:
                    logger.info(f"平台 {pf} 已处理 {settings.FETCH_BATCH_SIZE} 个账号，"
                                f"休息 {settings.FETCH_BATCH_COOLDOWN} 秒...")
                    await asyncio.sleep(settings.FETCH_BATCH_COOLDOWN)
                else:
                    await asyncio.sleep(
                        settings.REQUEST_INTERVAL_MIN
                        + random.uniform(0, settings.REQUEST_INTERVAL_MAX
                                         - settings.REQUEST_INTERVAL_MIN)
                    )

        def on_progress(done: int, total: int, ready: list[str]) -> None:
            _set_account_progress("、".join(ready), done, total)

        rounds = await _run_platform_rounds(
            groups, worker,
            preempt=_preempt_account if auto else None,
            on_preempt=(lambda: _auto_yield_account_with(commit_all)) if auto else None,
            on_progress=on_progress,
            cooldown_seconds=settings.RATE_LIMIT_COOLDOWN,
        )
        for pf, outcome in rounds:
            if outcome.ok:
                result.success += 1
            else:
                result.failed += 1
                label = outcome.payload
                name = (label.display_name or label.platform_uid) if label else pf
                result.details.append(f"[{pf}] {name}: {outcome.error or '更新失败'}")

        logger.info(f"抓取完毕: {result.success} 成功, {result.failed} 失败, {result.skipped} 跳过")

    except Exception as e:
        logger.error(f"抓取任务出错: {e}", exc_info=True)
        db.rollback()
        result.details.append(f"异常: {e}")
    finally:
        for s in sessions.values():
            s.close()
        db.close()
        await client.aclose()
        _fetch_running = False
        _fetch_scope = None
        _auto_account_active.clear()
        _reset_account_status()
        _fetch_lock.release()
        _set_account_last_result(res_seq, "全部账号", result.success, result.failed, result.skipped)

    return result


def is_fetch_running() -> bool:
    return _fetch_running


async def async_fetch_vtuber(vtuber_id: int) -> FetchResult:
    """抓取单个 VTuber 的**全部**账号信息（devlog/017；v0.9.4 退化为薄壳）。

    前端「抓取账号」按钮语义 = 该 V 名下所有账号都刷一遍，因此这里先查 id 再交给
    `async_fetch_accounts`（手动优先 + fast 节奏 + 头像延后 + 抢锁失败排队）。
    收录 / 加账号不再走这里——它们只抓新增的那一个账号（见 routers/vtuber.py）。
    """
    db: Session = SessionLocal()
    try:
        ids = [
            r[0] for r in db.query(Account.id).filter(
                Account.vtuber_id == vtuber_id,
                Account.platform_uid != None,   # noqa: E711
                Account.platform_uid != "",
            ).all()
        ]
    finally:
        db.close()
    if not ids:
        logger.warning(f"VTuber#{vtuber_id} 没有可抓取的账号")
        return FetchResult(details=["该 VTuber 没有可抓取的账号"])
    return await async_fetch_accounts(ids, label=f"VTuber#{vtuber_id}", fast=True)


def start_scheduler():
    scheduler = BackgroundScheduler()
    # v0.6.1：账号定时任务（5min 全量）已由「时效分层调度」T1（主账号 5min）
    # + T3a（全量 6h）替代（start_tier_scheduler），此处只保留外部数据批次 cron。
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
    logger.info("APScheduler 已启动（外部数据批次 cron）。")
    return scheduler


def _wait_for_manual_tasks(timeout_seconds: float = 1800.0,
                           poll_seconds: float = 15.0) -> bool:
    """外部数据批次被手动抓取挡下时**等待其结束**（v0.9.3）。

    用户 2026-09-09 反馈：原来直接 return 跳过 → 当天这批数据就丢了。
    现在改为排队等待（默认最多 30 分钟），手动任务一结束就继续执行。
    返回 True=可以执行；False=超时放弃本轮（记日志）。
    """
    if not any_fetch_running():
        return True
    logger.info("外部数据任务等待手动抓取结束...")
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        time.sleep(poll_seconds)
        if not any_fetch_running():
            logger.info("手动抓取已结束，外部数据任务继续执行")
            return True
    logger.warning(f"外部数据任务等待手动抓取超时（{timeout_seconds:.0f}s），本轮放弃")
    return False


def run_external_daily_jobs():
    """外部数据日任务（P4）：粉丝历史增量 + 直播礼物日聚合。"""
    global _external_running
    if not _wait_for_manual_tasks():
        return
    _external_running = True
    external_task_started("daily", "第三方数据日批次")
    try:
        results = asyncio.run(run_external_interval("daily"))
        logger.info(f"外部数据日任务完成: {len(results)} 个任务")
    finally:
        _external_running = False
        external_task_finished("daily")


def run_external_weekly_jobs():
    """外部数据周任务（P4）：VTuber 索引整表刷新（企划/公会）。"""
    global _external_running
    if not _wait_for_manual_tasks():
        return
    _external_running = True
    external_task_started("weekly", "第三方数据周批次")
    try:
        results = asyncio.run(run_external_interval("weekly"))
        logger.info(f"外部数据周任务完成: {len(results)} 个任务")
    finally:
        _external_running = False
        external_task_finished("weekly")


def shutdown_scheduler(scheduler: BackgroundScheduler):
    if scheduler:
        scheduler.shutdown(wait=False)
        logger.info("APScheduler 已安全关闭。")


# ── 帖子抓取锁（全局单飞） ─────────────────────────────────────────────

_post_fetch_lock = threading.Lock()
_post_fetch_running = False


def any_fetch_running() -> bool:
    """全局单飞判定：账号/帖子任一在跑，或已有手动任务在等自动档让位
    （让位窗口也视为忙，避免自动批次在真空期钻空并发执行）。"""
    return (_fetch_running or _post_fetch_running
            or _preempt_account.is_set() or _preempt_post.is_set())


def manual_task_running() -> bool:
    """是否有**手动**任务在跑（含已请求让位、正等锁的窗口）。

    与 any_fetch_running 的区别：自动档（综合档两条流）持锁时返回 False——用户手动
    请求不该被定时档挡在门外，而是要抢占它（见本文件「手动任务优先」一节）。
    手动端点用它做 409 判定；外部数据批次等自动任务仍用 any_fetch_running。
    """
    manual_account = _fetch_running and not _auto_account_active.is_set()
    manual_post = _post_fetch_running and not _auto_post_active.is_set()
    return (manual_account or manual_post
            or _preempt_account.is_set() or _preempt_post.is_set())


# ── 手动任务优先（v0.9.3）：自动任务给用户手动任务让路 ─────────────────────
# 语义：用户手动触发的任务（收录新 V 拉起的单V抓取、点「抓取账号 / 抓取帖子 /
# 更新动态」）优先级高于定时档。自动档在**轮次断点**（账号之间）看到抢占信号
# 就交还锁并等待，手动任务跑完后再从断点续跑。
#
# 为什么需要：启动链会连续占满两把锁几十秒到几分钟，这段时间里收录一个新
# VTuber 拉起的抓取只能抢锁失败→"跳过"，账号信息一直空白（用户 2026-09-08 反馈）。
_preempt_account = threading.Event()
_preempt_post = threading.Event()
# 自动任务是否正持锁：手动任务据此判断该不该请求让位（另一个手动任务在跑时不抢）
_auto_account_active = threading.Event()
_auto_post_active = threading.Event()
# 手动任务等待自动任务让位的上限；超时按原语义跳过（不让 UI 无限等）
MANUAL_PREEMPT_WAIT_SECONDS = 120.0


# ── 抢锁失败排队兜底（v0.9.4）：新 V 的抓取绝不静默丢弃 ─────────────────────
# 场景：用户点了「抓取账号」批量任务（手动持锁）后立刻收录一个新 V —— 手动之间
# 不互相抢占，旧实现直接 return "已跳过"，新 V 的账号信息要等 24h 数据到期或重启。
# 现在改为入队，由综合档心跳（TIER_TICK_SECONDS）在锁空闲时优先消费。
_pending_lock = threading.Lock()
_pending_account_ids: list[int] = []      # 待补抓的账号 id（账号信息）
_pending_first_screen_ids: list[int] = []  # 待补抓的账号 id（收录首屏内容）


def _enqueue_pending_account(account_id: int) -> None:
    with _pending_lock:
        if account_id not in _pending_account_ids:
            _pending_account_ids.append(account_id)


def _enqueue_pending_first_screen(account_id: int) -> None:
    with _pending_lock:
        if account_id not in _pending_first_screen_ids:
            _pending_first_screen_ids.append(account_id)


def _take_pending() -> tuple[list[int], list[int]]:
    """取出并清空两个待补抓队列（原子，避免与心跳线程重复消费）。"""
    global _pending_account_ids, _pending_first_screen_ids
    with _pending_lock:
        accounts, first = _pending_account_ids, _pending_first_screen_ids
        _pending_account_ids, _pending_first_screen_ids = [], []
        return accounts, first


def has_pending_fetches() -> bool:
    """是否有排队等待补抓的账号（供测试/诊断）。"""
    with _pending_lock:
        return bool(_pending_account_ids or _pending_first_screen_ids)


def _drain_pending_fetches() -> None:
    """综合档心跳调用：锁空闲时优先补抓排队的新账号（不丢任务）。

    在调度线程里同步执行（内部 `asyncio.run`，与本线程其它档位一致）。
    """
    accounts, first = _take_pending()
    if not accounts and not first:
        return
    if _fetch_running or _post_fetch_running:
        # 又有任务在跑：放回队列，下个心跳再试
        for aid in accounts:
            _enqueue_pending_account(aid)
        for aid in first:
            _enqueue_pending_first_screen(aid)
        return
    logger.info(f"补抓排队账号：账号信息 {len(accounts)} 个，首屏内容 {len(first)} 个")
    if accounts:
        try:
            asyncio.run(async_fetch_accounts(accounts, label="排队账号", fast=True))
        except Exception as e:
            logger.error(f"补抓排队账号失败: {e}", exc_info=True)
    for aid in first:
        try:
            asyncio.run(async_fetch_first_screen(aid))
        except Exception as e:
            logger.error(f"补抓排队账号首屏失败: {e}", exc_info=True)


async def _acquire_manual_account(wait_seconds: float = MANUAL_PREEMPT_WAIT_SECONDS) -> bool:
    """手动账号任务抢 _fetch_lock：空闲直接拿；自动任务持锁则请求让位后再等。

    返回 True 表示已持有锁（调用方 finally 负责 release）。
    占用者是另一个**手动**任务时不抢（保持"手动之间不互相打断"）。
    """
    if _fetch_lock.acquire(blocking=False):
        return True
    if not _auto_account_active.is_set():
        return False
    _preempt_account.set()
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        if _fetch_lock.acquire(blocking=False):
            _preempt_account.clear()   # 拿到锁即撤信号，自动任务随后排队等这把锁
            return True
        await asyncio.sleep(0.2)
    _preempt_account.clear()
    logger.warning(f"手动账号任务等待定时任务让位超时（{wait_seconds:.0f}s），本轮跳过")
    return False


async def _acquire_manual_post(wait_seconds: float = MANUAL_PREEMPT_WAIT_SECONDS) -> bool:
    """手动帖子任务抢 _post_fetch_lock（语义同 _acquire_manual_account）。"""
    if _post_fetch_lock.acquire(blocking=False):
        return True
    if not _auto_post_active.is_set():
        return False
    _preempt_post.set()
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        if _post_fetch_lock.acquire(blocking=False):
            _preempt_post.clear()
            return True
        await asyncio.sleep(0.2)
    _preempt_post.clear()
    logger.warning(f"手动帖子任务等待定时任务让位超时（{wait_seconds:.0f}s），本轮跳过")
    return False


async def _auto_yield_account(db: Session) -> None:
    """自动账号任务让位（单会话版）：交还 _fetch_lock，等手动任务跑完再拿回。"""
    await _auto_yield_account_with(db.commit)


async def _auto_yield_account_with(commit) -> None:
    """自动账号任务让位：先落盘（commit 可以是多会话的提交函数）→ 交还 _fetch_lock
    → 等手动任务跑完 → 重新拿回并恢复 _fetch_scope（断点续跑）。"""
    global _fetch_running, _fetch_scope
    saved_scope = _fetch_scope
    commit()
    _fetch_running = False
    _auto_account_active.clear()
    _status["account"]["running"] = False
    _fetch_lock.release()
    try:
        while _preempt_account.is_set():
            await asyncio.sleep(0.2)
    finally:
        _fetch_lock.acquire()
        _auto_account_active.set()
        _fetch_running = True
        _fetch_scope = saved_scope   # 手动任务会把 scope 改成 single，让位返回时恢复
        _status["account"]["running"] = True
    logger.info("定时账号任务已让位给手动任务，继续执行")


async def _maybe_preempt_account(db: Session) -> bool:
    """自动账号任务断点检查：手动任务请求优先时让位。返回是否让位过。"""
    if not _preempt_account.is_set():
        return False
    await _auto_yield_account(db)
    return True


async def _auto_yield_post(db: Session) -> None:
    """自动帖子任务让位（单会话版）：交还 _post_fetch_lock，等手动任务跑完再拿回。"""
    await _auto_yield_post_with(db.commit)


async def _auto_yield_post_with(commit) -> None:
    """自动帖子任务让位（多会话版，语义同账号侧）。"""
    global _post_fetch_running
    commit()
    _post_fetch_running = False
    _auto_post_active.clear()
    _status["post"]["running"] = False
    _post_fetch_lock.release()
    try:
        while _preempt_post.is_set():
            await asyncio.sleep(0.2)
    finally:
        _post_fetch_lock.acquire()
        _auto_post_active.set()
        _post_fetch_running = True
        _status["post"]["running"] = True
    logger.info("定时帖子任务已让位给手动任务，继续执行")


async def _maybe_preempt_post(db: Session) -> bool:
    """自动帖子任务断点检查：手动任务请求优先时让位。返回是否让位过。"""
    if not _preempt_post.is_set():
        return False
    await _auto_yield_post(db)
    return True


# ── 按平台并发的轮次执行器（v0.9.3）─────────────────────────────────────
# 用户 2026-09-09 定稿：T2 与 T3a 合并为「综合档」，并且不同平台的限速是分开的
# —— 因此并发粒度取「平台」：每轮每个就绪平台各处理一个元素，平台之间并行、
# 平台内部按轮次串行（单平台速率不变）。动态流与账号流共用本执行器。

@dataclass
class _RoundOutcome:
    """单元素执行结果：worker 必须自己吞异常，用 ok/error 表达失败。"""
    ok: bool = True
    error: str | None = None
    rate_limited: bool = False
    payload: object = None


async def _run_platform_rounds(
    groups: dict[str, list],
    worker,
    *,
    preempt: threading.Event | None = None,
    on_preempt=None,
    on_progress=None,
    cooldown_seconds: float | None = None,
) -> list[tuple[str, _RoundOutcome]]:
    """按平台并发的轮次执行器。

    - 每轮：所有「就绪平台」各取一个元素交给 `worker(platform, item)` 并发执行
      （worker 内部自带该平台的节流 sleep）；
    - 某平台风控（outcome.rate_limited）→ 该平台单独冷却 `cooldown_seconds`，
      其它平台继续推进；全部冷却则一起等最早解冻的那个；
    - 轮与轮之间是**手动让位断点**：`preempt` 置位时调用 `on_preempt()`
      （交还对应锁、等手动任务跑完再恢复；调用方须持有该锁）；
    - `on_progress(done, total, ready_platforms)` 每轮汇报一次进度。
    """
    queues = {pf: list(items) for pf, items in groups.items() if items}
    total = sum(len(q) for q in queues.values())
    out: list[tuple[str, _RoundOutcome]] = []
    if not total:
        return out
    cooling: dict[str, float] = {}
    done = 0
    while any(queues.values()):
        if preempt is not None and preempt.is_set() and on_preempt is not None:
            await on_preempt()
        now = time.monotonic()
        ready = [pf for pf, q in queues.items() if q and cooling.get(pf, 0.0) <= now]
        if not ready:
            wait_until = min(cooling[pf] for pf, q in queues.items() if q)
            await asyncio.sleep(max(0.5, wait_until - now))
            continue
        if on_progress:
            on_progress(done, total, ready)
        results = await asyncio.gather(*(worker(pf, queues[pf].pop(0)) for pf in ready))
        for pf, res in zip(ready, results):
            out.append((pf, res))
            done += 1
            if cooldown_seconds and getattr(res, "rate_limited", False):
                cooling[pf] = time.monotonic() + cooldown_seconds
                logger.warning(f"平台 {pf} 触发风控，冷却 {cooldown_seconds:.0f}s"
                               f"（其它平台继续）")
    return out


def account_sweep_due(db: Session, *, now: datetime | None = None,
                      stale_hours: float | None = None) -> bool:
    """账号流是否到期（数据驱动，用户 2026-09-09 定稿）。

    判据：存在可抓取账号满足「`last_fetched_at` 为空（新收录未抓到）」或
    「早于 now - ACCOUNT_SWEEP_STALE_HOURS」。不依赖进程内计时器，重启/休眠后
    行为一致；启动时也用它决定要不要立刻跑账号流。
    """
    from app.models.vtuber import Account as _Account  # 局部导入避免循环
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    stale_hours = settings.ACCOUNT_SWEEP_STALE_HOURS if stale_hours is None else stale_hours
    cutoff = now - timedelta(hours=stale_hours)
    q = db.query(Account).filter(
        Account.platform_uid.isnot(None), Account.platform_uid != "")
    if db.query(q.filter(Account.last_fetched_at.is_(None)).exists()).scalar():
        return True
    oldest = q.with_entities(func.min(Account.last_fetched_at)).scalar()
    return oldest is None or oldest < cutoff


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
    # P9-3（v0.9.6）：并入已有投稿的「投稿动态」条数（附言已写进 video.note，
    # 不再单独入库；计入 skipped，便于前端/日志说明"少的那条去哪了"）
    note_merged: int = 0


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


def _video_bvid_index(db: Session, platform_uid: str) -> dict[str, str]:
    """bvid → 已入库 `video` 帖的 platform_post_id（P9-3 合并用）。

    只为「投稿动态」判断该 bvid 是否已有投稿记录；一账号几百条视频，解析
    body_json 的成本可接受（比每次查库便宜）。
    """
    out: dict[str, str] = {}
    rows = db.query(Post.platform_post_id, Post.body_json).filter(
        Post.platform == "bilibili", Post.platform_uid == platform_uid,
        Post.type == "video",
    ).all()
    for pid, body in rows:
        bvid = (_safe_json_parse(body) or {}).get("bvid") or pid
        if bvid:
            out[str(bvid)] = str(pid)
    return out


def _absorb_video_dynamic(db: Session, platform_uid: str, item: dict,
                          video_by_bvid: dict[str, str]) -> str | None:
    """把「投稿动态」并入同 bvid 的投稿帖：附言写 note，返回被并入的 video pid。

    返回 None 表示这不是「已有投稿的重复动态」（调用方按普通新帖入库）。
    合并口径见 devlog/047：列表里一条视频只出现一次，动态附言以「UP 主附言」展示。
    """
    body = _safe_json_parse(item.get("body_json"))
    bvid = str(body.get("bvid") or "")
    pid = video_by_bvid.get(bvid) if bvid else None
    if not pid:
        return None
    text = (body.get("text") or "").strip()
    if text:
        # 只补空缺的附言，不覆盖已有内容（贴文附言可能被作者改过，先到先得更稳）
        row = db.query(Post.note).filter(
            Post.platform == "bilibili", Post.platform_uid == platform_uid,
            Post.platform_post_id == pid,
        ).first()
        if row is not None and not (row[0] or "").strip():
            db.query(Post).filter(
                Post.platform == "bilibili", Post.platform_uid == platform_uid,
                Post.platform_post_id == pid,
            ).update({Post.note: text}, synchronize_session=False)
    return pid

# 直播场次路由：mid → account_id（live_sessions 需账号外键；账号表稳定，进程内缓存）
_bili_account_id_cache: dict[str, int | None] = {}


def _bili_account_id(db: Session, mid: int) -> int | None:
    key = str(mid)
    if key not in _bili_account_id_cache:
        acc = (
            db.query(Account)
            .filter(Account.platform == "bilibili", Account.platform_uid == key)
            .first()
        )
        _bili_account_id_cache[key] = acc.id if acc else None
    return _bili_account_id_cache[key]


def _route_live_item(db: Session, mid: int, d: dict) -> None:
    """直播开播卡片（type='live'）→ live_sessions 表（v0.9.x M2）。

    数据不进入 posts 档案；live_id（B站场次 key）幂等 upsert；
    秒级开播时间来自 live_play_info.live_start_time；end_at 由
    merged() 用 self 快照/次日 danmakus 同步补全。
    """
    body = _safe_json_parse(d.get("body_json") or "{}")
    live_id = str(body.get("live_id") or "")
    start_ts = body.get("live_start_time")
    if not live_id:
        logger.warning(f"直播场次无 live_id，跳过: dyn={d.get('platform_post_id')}")
        return
    if not start_ts:
        logger.warning(f"直播场次无 live_start_time，跳过: live_id={live_id}")
        return
    try:
        start_at = datetime.fromtimestamp(int(start_ts), tz=timezone.utc).replace(tzinfo=None)
    except (TypeError, ValueError, OverflowError, OSError):
        logger.warning(f"直播场次 start_ts 异常: {start_ts}, live_id={live_id}")
        return
    account_id = _bili_account_id(db, mid)
    if account_id is None:
        logger.warning(f"mid={mid} 无对应账号，直播场次未入库: live_id={live_id}")
        return
    added = LiveSessionRepo(db).upsert_feed(account_id, live_id, {
        "title": (d.get("title") or "").strip() or None,
        "room_id": str(body.get("room_id") or "") or None,
        "parent_area_name": body.get("parent_area_name"),
        "area_name": body.get("area_name"),
        "cover_url": d.get("cover_url"),
        "start_at": start_at,
        "raw_json": d.get("raw_json"),
    })
    if added:
        logger.info(f"mid={mid} 直播场次入库 feed: live_id={live_id} title={d.get('title')!r}")

# 风控续抓：列表页（视频/动态）触发风控后冷却重试本页的次数上限（A）
_PAGE_RETRIES = 2


async def _fetch_posts_core(mid: int, video_pages: int, dynamics_pages: int, db: Session,
                            client: httpx.AsyncClient | None = None,
                            include_videos: bool = True,
                            stop_on_existing: bool = False,
                            limit_latest: int | None = None) -> PostFetchResult:
    """单个账号的帖子抓取核心逻辑（不含锁与 session 管理）。
    video_pages=-1   → 全量拉取视频直到无更多结果。
    dynamics_pages=-1 → 全量拉取动态直到 has_more=false。
    include_videos=False → 只抓动态（更新未归档动态用）。
    client 复用连接池；未传入时自建并在结束/异常时关闭。
    stop_on_existing=True → 增量模式：动态流按时间倒序翻页，**整页扫完**后若页内
    存在「已入库且非置顶」的帖子即停止（更早的必然已入库），通常第 1 页即返回；
    置顶帖（`module_tag.text=置顶`，可多条且排在流首、顺序打乱）不参与停止判定
    ——提前 break 会把同页里更新的新帖整段漏掉（devlog/045）。
    limit_latest=N → 「最新 N 条」模式（启动链阶段 3）：同一页内最多入库
    N 条新帖即停（其余新帖留待下次启动链/增量任务渐进消化），
    保证每 VTuber 的单次时长有上界、不等同于全量补档。

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
        client = new_async_client(15.0)

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
        # P9-3（v0.9.6）：bvid → 已入库的 video 帖 platform_post_id。
        # 「投稿动态」与「投稿」是同一条视频的两个来源，合并后只留 video 一条，
        # 动态附言写进 video.note（见 `_absorb_video_dynamic`）。
        video_by_bvid = _video_bvid_index(db, platform_uid)

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
                    # P9-3：本页新见到的投稿也登记进 bvid 索引——动态流紧随其后，
                    # 同一条视频的「投稿动态」要能被认出并并入（不重复入库）
                    _bv = (_safe_json_parse(v.get("body_json")) or {}).get("bvid")
                    if _bv:
                        video_by_bvid.setdefault(str(_bv), str(v["platform_post_id"]))
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
        latest_new = 0       # 「最新 N 条」模式计数（limit_latest）
        while True:
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
            # 置顶动态（module_tag.text=置顶）时间顺序被打乱，增量停止必须豁免
            pinned_ids = set(data.get("pinned_ids") or [])
            known_hit: str | None = None   # 本页第一条「已入库且非置顶」的帖子（停止边界）
            for idx, d in enumerate(items):
                # 直播开播场次卡（v0.9.x M2）：路由 live_sessions 表（不走 posts），
                # 且计入 seen_pids 缺席判定——它不属于内容档案
                if d["type"] == "live":
                    _route_live_item(db, mid, d)
                    continue
                result.seen_pids.append(d["platform_post_id"])
                result.dynamics += 1
                if d["platform_post_id"] in existing_ids:
                    result.skipped += 1
                    # 增量模式：命中已入库即认为更早的都已入库——但**必须整页扫完
                    # 再停**，且置顶帖不算（见下）。理由：置顶帖排在流首、可多条、
                    # 顺序打乱，提前 break 会把同一页里更新的新帖整段漏掉
                    # （2026-09-09 用户反馈「更新动态后微博抓不到新帖」，devlog/045）
                    if (stop_on_existing and known_hit is None
                            and d["platform_post_id"] not in pinned_ids):
                        known_hit = d["platform_post_id"]
                    continue

                # P9-3：投稿动态并入同 bvid 的投稿帖（附言写 note），不再重复入库
                if d["type"] == "video_dynamic":
                    if _absorb_video_dynamic(db, platform_uid, d, video_by_bvid) is not None:
                        result.skipped += 1
                        result.note_merged += 1
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
                # 「最新 N 条」模式：入库满 N 条新帖即停（其余留待下次渐进消化）
                if limit_latest is not None:
                    latest_new += 1
                    if latest_new >= limit_latest:
                        stop_now = True
                        break
            dyn_page += 1
            if stop_now:
                # 「最新 N 条」模式命中上限：立即收工
                _flush_pending()
                return result
            if known_hit is not None:
                # 增量模式：整页扫完且页内存在「已入库且非置顶」的帖子
                # → 更早的动态必然已在库中，收工（不再翻下一页）
                result.stopped_early = True
                result.stop_reason = "stopped_early"
                result.stop_existing_pid = known_hit
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
                                stop_on_existing: bool = False,
                                limit_latest: int | None = None) -> PostFetchResult:
    """通用单流帖子抓取循环（爬虫框架：微博及后续单流平台复用）。

    pages=-1 拉到底；pages=0 不抓；与 _fetch_posts_core 共用同一套基础设施：
    批量落库/内存去重/归档边界/定时任务让位/风控断点续抓/stop_reason 归类。
    计数口径：单流帖子记入 dynamics 桶（与 B 站动态流同一统计位）。
    limit_latest=N → 入库满 N 条新帖即停（收录首屏抓取用，与 B 站口径一致）。
    stop_on_existing=True → **整页扫完**后若页内有「已入库且非置顶」的帖子即停；
    置顶帖（平台返回的 pinned_ids）不参与停止判定（微博 mymblog 可有多条置顶，
    时间顺序被打乱，见 devlog/045）。
    """
    result = PostFetchResult()
    clear_rate_limit()

    own_client = client is None
    if own_client:
        client = new_async_client(15.0)

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
        latest_new = 0      # 「最新 N 条」模式计数（limit_latest，收录首屏用）
        while True:
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
            # 置顶帖（pinned_ids）：不参与增量停止判定（可多条、时间顺序打乱）
            pinned_ids = set(data.get("pinned_ids") or [])
            known_hit: str | None = None   # 本页第一条「已入库且非置顶」的帖子
            for idx, d in enumerate(items):
                result.seen_pids.append(d["platform_post_id"])
                result.dynamics += 1
                if d["platform_post_id"] in existing_ids:
                    result.skipped += 1
                    # 增量模式：命中已入库**不当场停**，等整页扫完再停
                    # （同页靠后的新帖可能比它更新，见 devlog/045）
                    if (stop_on_existing and known_hit is None
                            and d["platform_post_id"] not in pinned_ids):
                        known_hit = d["platform_post_id"]
                    continue

                # 详情补全（长文全文等）；风控标志仅用于列表页判定（C）
                if await pf.enrich(d, client=client):
                    await asyncio.sleep(random.uniform(0.5, 1.5))
                clear_rate_limit()

                pending.append(d)
                existing_ids.add(d["platform_post_id"])
                if len(pending) >= _POST_BATCH_SIZE:
                    _flush_pending()
                if limit_latest is not None:
                    latest_new += 1
                    if latest_new >= limit_latest:
                        _flush_pending()
                        return result
            if known_hit is not None:
                # 整页扫完且页内有「已入库且非置顶」的帖子 → 更早的必然已入库
                result.stopped_early = True
                result.stop_reason = "stopped_early"
                result.stop_existing_pid = known_hit
                _flush_pending()
                return result
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
                                   stop_on_existing: bool = False,
                                   limit_latest: int | None = None) -> PostFetchResult:
    """按平台分发单个账号的帖子抓取：
    - bilibili → 双流核心 _fetch_posts_core（视频+动态、归档边界、视频总数比对）
    - weibo 等单流平台 → 通用循环 _fetch_platform_posts

    limit_latest 对两条实现均生效（B 站双流核心 = 动态桶计数；单流平台 = 全流计数），
    收录首屏抓取即用该参数给单次时长设上界。

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
                                         stop_on_existing=stop_on_existing,
                                         limit_latest=limit_latest)
    else:
        result = await _fetch_platform_posts(pf, str(acc.platform_uid), dynamics_pages, db,
                                             client=client, stop_on_existing=stop_on_existing,
                                             limit_latest=limit_latest)
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
    """单个账号的帖子抓取（带锁，供 fetch-posts 端点调用）；按平台分发。
    手动任务优先：锁被定时档占用时请求其让位。"""
    global _post_fetch_running

    if not await _acquire_manual_post():
        logger.warning("帖子抓取正在进行中，跳过本次触发")
        return PostFetchResult()

    _post_fetch_running = True
    _status["post"]["running"] = True
    # P8-C：单账号快速抓取（无 i/N 进度）
    _set_post_progress("quick", None, 1, 1)
    res_seq = _next_result_seq()
    db: Session = SessionLocal()
    client = new_async_client(15.0)
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


async def async_fetch_first_screen(account_id: int) -> PostFetchResult:
    """收录首屏抓取（v0.9.4）：新账号立刻抓到第一屏内容。

    用户诉求：「添加一个新 V 的时候信息抓取能够尽可能地快」。旧实现收录后只拉
    账号信息，右栏「暂无帖子」要等 15 分钟的综合档动态流或手动点「抓取帖子」。
    这里对该账号跑一次**有界**抓取：

    - 投稿 1 页（≤30 条，`arc/search` 列表自带标题/封面/时长/统计，无逐条详情请求）；
    - 动态 1 页 + 最多 `FIRST_SCREEN_DYNAMICS_LIMIT` 条新帖（每条 1 次详情）；
    - 微博等单流平台：1 页 + 同样的条数上限（`_fetch_platform_posts`）；
    - 走帖子锁 + 手动优先；抢不到锁时入队等心跳补抓（不静默丢弃）。
    """
    global _post_fetch_running

    if not await _acquire_manual_post():
        _enqueue_pending_first_screen(account_id)
        logger.warning(f"account#{account_id} 首屏抓取锁被占用，已排队等待补抓")
        return PostFetchResult(stop_reason="queued", error="帖子抓取正在进行中，已排队")

    _post_fetch_running = True
    _status["post"]["running"] = True
    res_seq = _next_result_seq()
    db: Session = SessionLocal()
    client = new_async_client(15.0)
    out: PostFetchResult | None = None
    label = f"account#{account_id}"
    try:
        acc = db.get(Account, account_id)
        if acc is None:
            out = PostFetchResult(stop_reason="error", error=f"账号 {account_id} 不存在")
            return out
        label = acc.display_name or str(acc.platform_uid)
        # P8-C：顶栏「首屏抓取中 - {V名}」（单账号，无 i/N）
        _set_post_progress("adopt", _vtuber_name_of(acc), 1, 1)
        logger.info(f"收录首屏抓取 {acc.platform}:{acc.platform_uid} "
                    f"({acc.display_name or ''}) ...")
        out = await _fetch_posts_for_account(
            acc,
            settings.FIRST_SCREEN_VIDEO_PAGES,
            settings.FIRST_SCREEN_DYNAMICS_PAGES,
            db, client=client,
            include_videos=True,
            stop_on_existing=True,
            limit_latest=settings.FIRST_SCREEN_DYNAMICS_LIMIT,
        )
        return out
    except Exception as e:
        logger.error(f"收录首屏抓取异常 account#{account_id}: {e}", exc_info=True)
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
            _set_post_last_result(
                res_seq, "adopt", label,
                out.videos, out.dynamics, out.stored, out.skipped,
                ([{"label": f"account#{account_id}", "stop_reason": out.stop_reason,
                   "error": out.error}] if lossy else []),
                None,
            )


async def async_fetch_all_posts() -> dict:
    """对库中所有账号（bilibili+微博等）逐个全量抓取帖子（按平台分发）。
    手动任务优先：锁被定时档占用时请求其让位。"""
    global _post_fetch_running

    if not await _acquire_manual_post():
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
    client = new_async_client(15.0)

    try:
        accounts = AccountRepo(db).all_for_fetch()

        if not accounts:
            logger.warning("没有可抓取的账号")
            out = {"status": "done", "total": total, "details": details}
            return out

        for idx, acc in enumerate(accounts):
            # 断点让位：定时任务请求让位时交还锁，等待其完成后续跑（同一账号列表序号）
            # P8-C：顶栏「全量抓取中 - {V名} - i/N」
            _set_post_progress("full", _vtuber_name_of(acc), idx + 1, len(accounts))
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
    手动任务优先：锁被定时档占用时请求其让位。
    """
    global _post_fetch_running

    if not await _acquire_manual_post():
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
    client = new_async_client(15.0)

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
            # P8-C：顶栏「全量抓取中 - {V名} - i/N」（按名抓取同一口径）
            _set_post_progress("full", _vtuber_name_of(acc), idx + 1, len(accounts))
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
    手动任务优先：锁被定时档占用时请求其让位。
    """
    global _post_fetch_running

    if not await _acquire_manual_post():
        logger.warning("帖子抓取正在进行中，跳过本次触发")
        return {"status": "skipped", "message": "帖子抓取任务正在进行中"}

    _post_fetch_running = True
    _status["post"]["running"] = True
    res_seq = _next_result_seq()
    db: Session = SessionLocal()
    client = new_async_client(15.0)
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
            # P8-C：顶栏「动态更新中 - 明前奶绿 - 1/11」（用户举例即此路径）
            _set_post_progress("update", _vtuber_name_of(acc), idx + 1, len(accounts))
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


# ── 时效分层调度（v0.6.1）：T0 直播状态独立线程 + T1/T2/T3a 分层轮询 ──────

def _primary_accounts(db: Session) -> list[tuple[VTuber, Account]]:
    """每个 VTuber 的主要活动平台账号（PRIMARY_PLATFORM_ORDER 优先级取首个）。

    目前设计为 bilibili 优先（B 站是各 V 最主要活动平台），后续平台扩展
    只需调配置顺序即可生效。
    """
    out: list[tuple[VTuber, Account]] = []
    for v in db.query(VTuber).order_by(VTuber.id.asc()).all():
        accs = sorted(
            (a for a in v.accounts if a.platform_uid),
            key=lambda a: (
                settings.PRIMARY_PLATFORM_ORDER.index(a.platform)
                if a.platform in settings.PRIMARY_PLATFORM_ORDER
                else len(settings.PRIMARY_PLATFORM_ORDER)
            ),
        )
        if accs:
            out.append((v, accs[0]))
    return out


async def live_sweep_core(db: Session, client: httpx.AsyncClient | None = None) -> FetchResult:
    """T0 直播状态核：经 bilibili 批量接口（每 100 uid 1 请求）仅回写 live 字段。

    - 不触碰签名/头像/粉丝；live 跳变时落统计快照（直播日历 edge 数据）；
    - **不占 _fetch_lock、不进状态通道、不写 last_result**——由 T0 独立守护
      线程调用，与任何抓取任务完全并行（并发写由 SQLite busy_timeout 排队）；
    - 每账号回写后 `_push_account_snapshot` → 前端左右栏徽标天然实时同步。
    """
    result = FetchResult()
    clear_rate_limit()
    own_client = client is None
    if own_client:
        client = new_async_client(15.0)

    def _bili_accounts() -> list[Account]:
        return db.query(Account).filter(
            Account.platform == "bilibili",
            Account.platform_uid != None,  # noqa: E711
            Account.platform_uid != "",
        ).all()

    try:
        accounts = _bili_accounts()
        if not accounts:
            logger.info("T0 直播状态：无 bilibili 账号")
            return result

        idx = 0
        while idx < len(accounts):
            chunk = [a for a in accounts[idx:idx + 100] if str(a.platform_uid).isdigit()]
            if not chunk:
                idx += 1
                continue
            data = await fetch_bilibili_live_batch([int(a.platform_uid) for a in chunk], client=client)
            if data is None:
                if was_rate_limited():
                    logger.warning(f"T0 直播状态触发风控 ({rate_limit_info()})，"
                                   f"冷却 {settings.RATE_LIMIT_COOLDOWN}s 后继续")
                    clear_rate_limit()
                    await asyncio.sleep(settings.RATE_LIMIT_COOLDOWN)
                    continue
                # 非风控失败（网络/接口异常）：跳过本批，轮询宽容处理
                result.failed += len(chunk)
                idx += len(chunk)
                continue
            for acc in chunk:
                hit = data.get(str(acc.platform_uid))
                if not hit:
                    result.failed += 1
                    continue
                prev_status = acc.live_status
                acc.live_status = hit.get("live_status", 0)
                acc.live_title = hit.get("live_title", acc.live_title)
                acc.live_url = hit.get("live_url", acc.live_url)
                if not acc.room_id and hit.get("room_id"):
                    acc.room_id = str(hit["room_id"])
                db.commit()
                if acc.live_status != prev_status:
                    # 直播边沿：落统计快照（直播日历场次推导的数据来源）
                    _record_stat_snapshot(db, acc)
                    db.commit()
                _push_account_snapshot(acc)
                result.success += 1
            idx += len(chunk)
            await asyncio.sleep(random.uniform(settings.STARTUP_LIVE_INTERVAL_MIN,
                                               settings.STARTUP_LIVE_INTERVAL_MAX))
    except Exception as e:
        logger.error(f"T0 直播状态异常: {e}", exc_info=True)
        db.rollback()
        result.details.append(f"异常: {e}")
    finally:
        if own_client:
            await client.aclose()

    return result


async def run_latest_dynamics_sweep() -> dict:
    """动态流（原 T2）：每 V 主账号 1 页 + 最多入库 STARTUP_DYNAMICS_LIMIT 条新帖。

    - 并发粒度 = 平台：每轮各平台各一个主账号（平台间并行、平台内串行）；
    - 手动任务优先：_post_fetch_lock 非阻塞获取失败即跳过；轮间让位；
    - 不写 last_result（周期任务静默，前端不弹完成胶囊）。
    """
    global _post_fetch_running

    if not _post_fetch_lock.acquire(blocking=False):
        logger.info("动态流跳过：帖子抓取正在进行（手动优先）")
        return {"status": "skipped", "message": "帖子抓取任务正在进行中"}

    _auto_post_active.set()
    _post_fetch_running = True
    _status["post"]["running"] = True
    db: Session = SessionLocal()
    client = new_async_client(15.0)
    sessions: dict[str, Session] = {}
    total = {"dynamics": 0, "stored": 0, "skipped": 0}
    issues: list[dict] = []
    out: dict = {}
    try:
        pairs = _primary_accounts(db)
        if not pairs:
            logger.info("动态流：无可抓取账号")
            out = {"status": "done", "total": total, "details": []}
            return out
        groups: dict[str, list[tuple[VTuber, Account]]] = {}
        for v, acc in pairs:
            groups.setdefault(acc.platform, []).append((v, acc))
        for pf in groups:
            sessions[pf] = SessionLocal()

        def commit_all() -> None:
            for s in sessions.values():
                s.commit()

        # P8-C：轮次进度（on_progress 在 worker 之前调用，用它给顶栏提供 i/N）
        progress = {"done": 0, "total": sum(len(q) for q in groups.values())}

        async def worker(pf: str, item: tuple[VTuber, Account]) -> _RoundOutcome:
            v, acc = item
            s = sessions[pf]
            local = s.get(Account, acc.id)
            if local is None:
                return _RoundOutcome(ok=False, error="账号已不存在", payload=(v, acc))
            logger.info(f"[{pf}] 动态 {v.name} ({acc.platform_uid}) ...")
            # P8-C：顶栏「动态轮询中 - {V名} - 已处理/总数」
            _set_post_progress("dynamic", v.name, progress["done"], progress["total"])
            try:
                r = await _fetch_posts_for_account(
                    local, 0, 1, s, client=client,
                    include_videos=False, stop_on_existing=True,
                    limit_latest=settings.STARTUP_DYNAMICS_LIMIT,
                )
            except Exception as e:
                logger.error(f"动态流异常 {pf}:{acc.platform_uid}: {e}", exc_info=True)
                s.rollback()
                return _RoundOutcome(ok=False, error=str(e), payload=(v, acc))
            return _RoundOutcome(ok=True, rate_limited=r.rate_limited, payload=(v, r))
            # 注：平台内节流在 finally 里

        async def worker_with_pacing(pf: str, item) -> _RoundOutcome:
            try:
                return await worker(pf, item)
            finally:
                await asyncio.sleep(random.uniform(settings.STARTUP_DYNAMICS_INTERVAL_MIN,
                                                   settings.STARTUP_DYNAMICS_INTERVAL_MAX))

        def on_progress(done: int, total_n: int, ready: list[str]) -> None:
            # P8-C：轮次开始前汇报「已处理/总数」；V 名由上面 worker 在真正开抓时写入
            progress["done"], progress["total"] = done, total_n
            _set_post_progress("dynamic",
                               _status["post"].get("vtuber_name"),
                               done, total_n)

        rounds = await _run_platform_rounds(
            groups, worker_with_pacing,
            preempt=_preempt_post,
            on_preempt=lambda: _auto_yield_post_with(commit_all),
            on_progress=on_progress,
            cooldown_seconds=settings.RATE_LIMIT_COOLDOWN,
        )
        # P9-5：按平台统计本轮**实际请求数**（1 次 feed 页 + 每入库帖 1 次详情），
        # 供速率预算器记账（stored 即详情请求数的上界估计）
        requests: dict[str, int] = {}
        for pf, outcome in rounds:
            v, r = outcome.payload if outcome.payload else (None, None)
            n = 1 + (getattr(r, "stored", 0) if r is not None else 0)
            requests[pf] = requests.get(pf, 0) + n
        for pf, outcome in rounds:
            v, r = outcome.payload if outcome.payload else (None, None)
            if r is None:
                issues.append({"label": f"{pf}:{getattr(v, 'name', '')}",
                               "stop_reason": "error", "error": outcome.error})
                continue
            for k in ("dynamics", "stored", "skipped"):
                total[k] += getattr(r, k)
            if r.stop_reason in ("rate_limited", "network_error", "error"):
                issues.append({"label": f"{v.name}({pf})",
                               "stop_reason": r.stop_reason, "error": r.error})
        out = {"status": "done", "total": total, "issues": issues, "requests": requests}
        return out
    except Exception as e:
        logger.error(f"动态流异常: {e}", exc_info=True)
        db.rollback()
        out = {"status": "done", "total": total, "issues": issues, "error": str(e)}
        return out
    finally:
        for s in sessions.values():
            s.close()
        db.close()
        await client.aclose()
        _post_fetch_running = False
        _auto_post_active.clear()
        _reset_post_status()
        _post_fetch_lock.release()


# ── 综合档（v0.9.3）：动态流 + 账号流同档并发 ────────────────────────────

# 上次账号流启动时刻（单调钟）：与「数据到期」共同构成双闸门，防止
# 抓取失败（last_fetched_at 没更新）导致每 10s 重试一次的风暴。
_last_account_sweep_mono: float = 0.0


def _account_sweep_due_now(db: Session) -> bool:
    """账号流是否该跑：数据驱动到期（account_sweep_due）+ 进程内最小间隔。"""
    if time.monotonic() - _last_account_sweep_mono < settings.ACCOUNT_SWEEP_MIN_GAP_SECONDS:
        return False
    return account_sweep_due(db)


async def _run_combined_tier(*, dynamics: bool = True,
                             account: bool | None = None) -> dict:
    """综合档：动态流与账号流在同一个事件循环里并发执行（各自锁、各自会话）。

    - `dynamics=True` → 跑动态流（每 V 主账号 1 页 + 限 N 帖）；
    - `account=None` → 按数据到期判定是否跑账号流；True/False 强制；
    - 两条流谁先拿到锁谁先跑，互不阻塞；都拿不到锁则本轮都跳过；
    - 任一异常都被 gather 收拢，不影响另一条流。
    """
    global _last_account_sweep_mono
    jobs: list[tuple[str, object]] = []
    if account is None:
        db = SessionLocal()
        try:
            account = _account_sweep_due_now(db)
        finally:
            db.close()
    if dynamics:
        jobs.append(("dynamics", run_latest_dynamics_sweep()))
    if account:
        _last_account_sweep_mono = time.monotonic()
        jobs.append(("account", async_fetch_and_update(auto=True)))
    if not jobs:
        return {"status": "idle"}
    results = await asyncio.gather(*(c for _, c in jobs), return_exceptions=True)
    out: dict = {}
    for (name, _), res in zip(jobs, results):
        if isinstance(res, BaseException):
            logger.error(f"综合档 {name} 异常: {type(res).__name__}: {res}",
                         exc_info=res)
            out[name] = {"status": "error", "error": str(res)}
        else:
            out[name] = res
    return out


# ── 启动时外部补抓（v0.9.8，P9-4）───────────────────────────────────────
# 用户口径：「应用启动的时候的定时任务管线添加全部在库的 V 的主要账号的外部任务，
# 用来更新直播日历和粉丝趋势的数据……同时记录这次外部任务的时间戳，如果再次启动
# 应用的时间戳与历史时间戳相差不到 24 小时，则跳过该次任务。」
#
# 说明：zeroroku /author/{mid}/history 与 danmakus /channel **一次返回全量**
# （实测 197KB / 8.6~19s；单账号一次 1349 场），接口没有 limit/分页参数——
# 所谓「只比对最新几条」只能靠：①账号级新鲜度跳过（<24h 不跑）；
# ②源自身幂等落库（按唯一键去重，天然只新增变化）。

EXTERNAL_STARTUP_KEY = "external.startup.last_run"


def startup_catchup_due(db: Session, *, now: datetime | None = None,
                        stale_hours: float | None = None) -> bool:
    """启动外部补抓是否到期（距上次运行 ≥ EXTERNAL_STARTUP_STALE_HOURS）。"""
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    stale_hours = (settings.EXTERNAL_STARTUP_STALE_HOURS
                   if stale_hours is None else stale_hours)
    last = AppMetaRepo(db).get_dt(EXTERNAL_STARTUP_KEY)
    if last is None:
        return True
    return last < now - timedelta(hours=stale_hours)


async def run_startup_external_catchup() -> dict:
    """启动补抓：每 V 主账号的第三方数据（粉丝历史 / 直播场次 / 礼物日）。

    - 白名单 = `_primary_accounts()`（每 V 取平台优先级最高的账号），不做全量扫站；
    - 进度进 `external` 状态通道（顶栏胶囊 + 完成发 fetch-idle 刷新档案卡片）；
    - 结束（无论单源是否报错）都写时间戳，避免第三方抖动导致每次启动都重跑。
    """
    global _external_running
    if not settings.EXTERNAL_STARTUP_CATCHUP_ENABLED:
        return {"status": "disabled"}

    db = SessionLocal()
    try:
        if not startup_catchup_due(db):
            last = AppMetaRepo(db).get_dt(EXTERNAL_STARTUP_KEY)
            logger.info(f"启动外部补抓跳过：上次运行于 {last}（< "
                        f"{settings.EXTERNAL_STARTUP_STALE_HOURS}h）")
            return {"status": "skipped", "last_run": last.isoformat() if last else None}
        ids = [acc.id for _v, acc in _primary_accounts(db)]
        if not ids:
            logger.info("启动外部补抓跳过：库内没有可抓取的主账号")
            AppMetaRepo(db).set_dt(EXTERNAL_STARTUP_KEY)
            return {"status": "skipped", "reason": "no accounts"}
    finally:
        db.close()

    label = f"{len(ids)} 个主账号的第三方数据"
    external_task_started("startup", label)
    _external_running = True          # 与每日批次同语义：综合档本轮跳过
    try:
        from app.services.externals.runner import run_external_interval
        results = await run_external_interval("daily", account_ids=ids)
        failed = [r for r in results if r.get("error")]
        logger.info(f"启动外部补抓完成：{len(ids)} 个主账号 / {len(results)} 个任务"
                    f"{'，失败 ' + str(len(failed)) if failed else ''}")
        return {"status": "done", "accounts": len(ids), "tasks": results}
    except Exception as e:
        logger.warning(f"启动外部补抓失败: {type(e).__name__}: {e}")
        return {"status": "error", "error": str(e)}
    finally:
        _external_running = False
        external_task_finished("startup")
        db = SessionLocal()
        try:
            AppMetaRepo(db).set_dt(EXTERNAL_STARTUP_KEY)
        finally:
            db.close()


def start_external_catchup() -> None:
    """启动入口（main.py lifespan 调用）：独立守护线程，不拖住综合档心跳。

    实测 10 个账号 × 3 源串行约 30~60s；跑在独立线程里，`_external_running`
    期间综合档跳过本轮，但用户的其它操作完全不受影响。
    """
    def _run() -> None:
        try:
            asyncio.run(run_startup_external_catchup())
        except Exception as e:
            logger.error(f"启动外部补抓线程异常: {e}", exc_info=True)

    threading.Thread(target=_run, name="startup-external", daemon=True).start()


def _tier_delay(interval_seconds: float, jitter_seconds: float) -> float:
    """带抖动的下轮间隔（抖动整段随机，含提前；interval<=0 视为禁用=无穷远）。"""
    if interval_seconds <= 0:
        return float("inf")
    return max(0.0, interval_seconds + random.uniform(-jitter_seconds, jitter_seconds))


# ── 动态流速率预算（v0.9.8，P9-5）────────────────────────────────────────
# 用户口径：「一轮紧接着一轮来尽量达成高频获取动态，轮次之间穿插随机间隔保证请求
# 频率不超过上限，同时抓取行为拟人」。做法＝**按平台的滑动窗口预算**：
# 每轮结束按实际请求数记账（feed 页 1 次 + 新帖详情 stored 次），下一轮要等预算腾出
# 名额；实际等待 = max(最小间隔, 预算等待) + 随机抖动。

class _PlatformBudget:
    """按平台的滑动窗口速率预算（requests / window）。

    - `wait_seconds(cost)`：还要等多久才允许再花 `cost`（各平台取最大）；
    - `charge(cost)`：记账（每轮结束后按实际请求数调用）；
    - 预算 <=0 表示不启用（调用方退回固定周期）。

    退化输入（`cost > rpm`）不抛错、返回一个窗口 —— 该请求在任何时点都凑不出名额，
    等待是唯一合理语义。现实含义：**单平台主账号数 > `DYNAMICS_BUDGET_RPM`（12）时，
    动态流每轮都要空等一个窗口**，速率自然下降到该平台 ≤12 req/min（限速正确，
    但如果哪天主账号数远超 rpm，应考虑把预算改成按账号数自适应）。
    """

    def __init__(self, rpm: int, window_seconds: float = 60.0):
        self.rpm = rpm
        self.window = window_seconds
        self._hits: dict[str, list[float]] = {}

    def _prune(self, pf: str, now: float) -> list[float]:
        dq = self._hits.setdefault(pf, [])
        cutoff = now - self.window
        while dq and dq[0] <= cutoff:
            dq.pop(0)
        return dq

    def wait_seconds(self, cost: dict[str, int], now: float | None = None) -> float:
        if self.rpm <= 0:
            return 0.0
        now = time.monotonic() if now is None else now
        waits = [0.0]
        for pf, n in cost.items():
            if n <= 0:
                continue
            dq = self._prune(pf, now)
            room = self.rpm - len(dq)
            if n <= room:
                continue
            need = n - room                      # 需要腾出的名额数
            # 窗口为空却仍不够名额 = 该平台「一轮请求数 > rpm」，等待换不来名额
            # （没有可以滑出的记录），只能空等一个窗口。**必须先判空**：此时
            # `len(dq) - 1 == -1`，`min(need - 1, -1)` 得 -1 → `dq[-1]` 抛 IndexError；
            # 而 `need == 1` 时夹取到 0 同样越界（`dq[0]` 不存在）——夹取救不了空表。
            # 触发条件：单平台主账号数 > rpm（例：13 个 B 站主账号、rpm=12），且窗口
            # 恰为空（进程刚起来或静默超过一个窗口）。调用点 `_tier_loop` 首轮
            # `_dynamics_next_due()` 在 try 之外、心跳循环无兜底 → 抛出即整条综合档
            # 线程死亡（动态流 + 账号流永久停摆，安装版无控制台时完全静默）。
            if not dq:
                waits.append(self.window)
                continue
            idx = min(need - 1, len(dq) - 1)
            waits.append(max(0.0, self.window - (now - dq[idx])))
        return max(waits)

    def charge(self, cost: dict[str, int], now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        for pf, n in cost.items():
            if n <= 0:
                continue
            dq = self._prune(pf, now)
            dq.extend([now] * int(n))


# 速率预算实例：进程内单例（动态流独用；账号流有自己 3~5s 的节流）
_dynamics_budget = _PlatformBudget(settings.DYNAMICS_BUDGET_RPM)


def _next_dynamics_cost(db: Session) -> dict[str, int]:
    """下一轮动态流各平台预计请求数（每主账号 1 次 feed 页）。"""
    cost: dict[str, int] = {}
    for _v, acc in _primary_accounts(db):
        cost[acc.platform] = cost.get(acc.platform, 0) + 1
    return cost


def _live_poller_loop() -> None:
    """T0 直播状态独立守护线程：首轮于 STARTUP_CHAIN_DELAY 后立即执行，
    之后按 LIVE_POLL_SECONDS ± jitter 循环；不占锁/状态通道/结果汇总。"""
    try:
        time.sleep(settings.STARTUP_CHAIN_DELAY)
        while settings.LIVE_POLL_SECONDS > 0:
            try:
                db = SessionLocal()
                try:
                    asyncio.run(live_sweep_core(db))
                finally:
                    db.close()
            except Exception as e:
                logger.error(f"T0 直播轮询异常: {e}", exc_info=True)
            time.sleep(_tier_delay(settings.LIVE_POLL_SECONDS, settings.LIVE_POLL_JITTER_SECONDS))
        logger.info("T0 直播轮询已关闭（LIVE_POLL_SECONDS<=0）")
    except Exception as e:
        logger.error(f"T0 直播轮询线程退出: {e}", exc_info=True)


def start_live_poller() -> None:
    """T0 启动入口（main.py lifespan 调用）：独立守护线程，与一切任务并行。"""
    threading.Thread(target=_live_poller_loop, name="t0-live-poller", daemon=True).start()


def _dynamics_next_due(db: Session) -> float:
    """下一轮动态流的到期时刻（monotonic）。

    P9-5 自适应节奏（用户定：预算 12 req·min⁻¹、一轮接一轮、轮间随机间隔）：
    - `DYNAMICS_BUDGET_RPM > 0` → **预算驱动**：等预算腾出下一轮所需名额，
      实际间隔 = max(DYNAMICS_MIN_GAP_SECONDS, 预算等待) ± DYNAMICS_JITTER_SECONDS；
      请求数为 0（库内没有主账号）时退回最小间隔，避免空转。
    - 预算 <=0 → 退回固定周期 `DYNAMICS_LATEST_INTERVAL_MINUTES`（老行为）。
    """
    if settings.DYNAMICS_BUDGET_RPM <= 0:
        return time.monotonic() + _tier_delay(settings.DYNAMICS_LATEST_INTERVAL_MINUTES * 60,
                                              settings.DYNAMICS_LATEST_JITTER_SECONDS)
    cost = _next_dynamics_cost(db)
    wait = _dynamics_budget.wait_seconds(cost)
    interval = max(settings.DYNAMICS_MIN_GAP_SECONDS, wait)
    return time.monotonic() + _tier_delay(interval, settings.DYNAMICS_JITTER_SECONDS)


def _tier_loop() -> None:
    """综合档守护线程（v0.9.3：原 T1/T2/T3a 合并为一个档；v0.9.8 自适应动态流）。

    - 启动链：延迟 `STARTUP_CHAIN_DELAY` 后跑一次综合档——动态流必跑；账号流按
      `accounts.last_fetched_at` 是否过期决定（用户 2026-09-09 定稿：账号字段变化慢，
      改为数据驱动、约一天一次）；
    - 心跳 `TIER_TICK_SECONDS`：手动抓取或外部批次在跑 → 本轮跳过（手动优先）；
      动态流按 `_dynamics_next_due()` 到期触发（预算驱动，见上），账号流按数据到期触发，
      两者在同一事件循环里**并发执行**（各自锁），墙钟 ≈ max(两条流)；
    - 周期带抖动；interval<=0 的档位禁用。
    """
    try:
        time.sleep(settings.STARTUP_CHAIN_DELAY)
        if settings.STARTUP_CHAIN_ENABLED:
            logger.info("启动链 · 综合档（动态流 + 账号流按需）")
            asyncio.run(_run_combined_tier(dynamics=True))
    except Exception as e:
        logger.error(f"启动链异常: {e}", exc_info=True)

    db0 = SessionLocal()
    try:
        due_dynamics = _dynamics_next_due(db0)
    finally:
        db0.close()

    while True:
        time.sleep(max(1, settings.TIER_TICK_SECONDS))
        # 排队兜底（v0.9.4）：收录/加账号时抢锁失败的任务在此优先补抓
        if not (_fetch_running or _post_fetch_running or _external_running):
            _drain_pending_fetches()
        if is_fetch_running() or is_post_fetch_running() or _external_running:
            continue  # 手动任务 / 外部批次在跑：自动档全部跳过本轮
        now = time.monotonic()
        run_dynamics = now >= due_dynamics
        db = SessionLocal()
        try:
            run_account = _account_sweep_due_now(db)
            next_cost = _next_dynamics_cost(db) if run_dynamics else {}
        finally:
            db.close()
        if not (run_dynamics or run_account):
            continue
        result: dict = {}
        try:
            logger.info(f"综合档（周期）：动态流={run_dynamics} 账号流={run_account}")
            # P9-5：**轮前**按估算记账（每主账号 1 次 feed 页）——按轮末记账会把
            # 整轮的请求都算在结束时刻，白等一整个轮次时长；轮后只补差额（新帖详情）。
            if run_dynamics:
                _dynamics_budget.charge(next_cost)
            result = asyncio.run(_run_combined_tier(dynamics=run_dynamics,
                                                    account=run_account))
        except Exception as e:
            logger.error(f"综合档周期异常: {e}", exc_info=True)
        if run_dynamics:
            actual = ((result or {}).get("dynamics") or {}).get("requests") or {}
            extra = {pf: max(0, n - next_cost.get(pf, 0)) for pf, n in actual.items()}
            _dynamics_budget.charge(extra)
            db = SessionLocal()
            try:
                due_dynamics = _dynamics_next_due(db)
            finally:
                db.close()


def start_tier_scheduler() -> None:
    """分层调度入口（main.py lifespan 调用）：守护线程；启动链语义并入首轮。"""
    threading.Thread(target=_tier_loop, name="tier-scheduler", daemon=True).start()
