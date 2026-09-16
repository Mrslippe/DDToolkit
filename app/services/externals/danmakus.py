"""danmakus.com（弹幕库）适配器 — P4。

已实测（ukamnads.icu / v2 spec）：
- GET /api/v2/vup-list 公开免鉴权 ✅：VTuber 索引（透传 laplace vup-slim.json）
  {code, data: {mid: {name, type, room, group_name}}} — 企划/公会数据即此而来
- GET /api/v2/channel?uId=&includeLive=true 公开免鉴权 ✅（v0.9.x M1 实测）：
  单场次全量列表 {channel, lives: [APILiveInfo], fansHistory} —
  title/startDate/stopDate/parentArea/area/totalIncome/maxOnlineCount/
  danmakusCount，2021-10 起（七海 1193 场实测）；liveId(uuid) 为场次唯一键
- GET /api/v2/live?liveId=&includeExtra=true 公开免鉴权 ✅（2026-09-07 实测）：
  单场直播数据（弹幕总数 + extra 词云 wordCloud {词: 次数}）；
  type 过滤可含 7=直播中止 / 8=直播继续（中断判定信号，备用）
- GET /api/v3/lives/{liveId}/danmakus 公开免鉴权 ✅：场次弹幕切片
  （offset/limit 分页，records[].payload 含弹幕原文/礼物/上舰/SC 明细）
- GET /api/v2/account/channel-lives 401/需登录 🔒：账号贡献维度（token 配置位
  DANMAKUS_TOKEN 保留，M1 端点已实测免登录，暂不需要）

落库：
- vup-list → thirdparty_vtubers（source='danmakus_vup'），整表刷新（周级）
- channel lives → live_sessions（source='danmakus'，LiveSessionRepo.upsert_danmakus，
  幂等 by (account_id, live_id)）
"""
import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session
from tenacity import (retry, retry_if_result, stop_after_attempt,
                      wait_exponential)

from app.core.http import new_async_client
from app.core.useragent import UA_CHROME
from app.models.vtuber import Account, ThirdpartyVtuber
from app.repositories.vtuber_repo import LiveSessionRepo
from app.services.externals.base import (ExternalJob, ExternalJobSummary,
                                         ExternalSource, INTERVAL_DAILY,
                                         INTERVAL_WEEKLY)

logger = logging.getLogger(__name__)

DANMAKUS_BASE = "https://ukamnads.icu"
VUP_LIST_PATH = "/api/v2/vup-list"
CHANNEL_PATH = "/api/v2/channel"
LIVE_PATH = "/api/v2/live"

# 单场详情/事件请求超时。**不要调回 12s**：该上游会间歇性变慢，而近期场次的
# 响应体明显更大（实测 223KB vs 老场次 45KB），12s 会让「有弹幕的场次」被误判成
# 「没有弹幕数据」（2026-09-13 实测 5 个最近场次全中，见 devlog/062）。
_LIVE_TIMEOUT = 30.0

# 鉴权端点（当前未启用）：有 token 时在请求头携带（Token: <token>，实测有效）
DANMAKUS_TOKEN_ENV = "DANMAKUS_TOKEN"

# WAF 过滤（实测 2026-09-07）：缺 Origin/Referer 或非浏览器 UA 会被直接 RST
BROWSER_HEADERS = {
    "User-Agent": UA_CHROME,      # R26③：UA 全仓单一来源（core/useragent）
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Origin": "https://ukamnads.icu",
    "Referer": "https://ukamnads.icu/",
}


async def fetch_channel(mid: str, client: httpx.AsyncClient) -> dict | None:
    """公开端点：单主播全量场次（channel + lives + fansHistory）。

    返回原始 data dict（{channel, lives, fansHistory}）或 None；
    调用方经 LiveSessionRepo.upsert_danmakus 落库。
    """
    resp = await client.get(
        f"{DANMAKUS_BASE}{CHANNEL_PATH}",
        params={"uId": mid, "includeLive": "true"},
        headers=BROWSER_HEADERS,
    )
    if resp.status_code != 200:
        logger.warning(f"danmakus channel 失败 HTTP {resp.status_code} mid={mid}")
        return None
    data = resp.json()
    if not isinstance(data, dict) or data.get("code") != 200:
        logger.warning(f"danmakus channel 响应异常 mid={mid}: "
                       f"code={data.get('code') if isinstance(data, dict) else '?'}")
        return None
    payload = data.get("data")
    return payload if isinstance(payload, dict) else None


def _auth_headers(token: str | None) -> dict:
    return {"Token": token} if token else {}


def _parse_live_summary(payload: dict) -> dict | None:
    """/api/v2/live 响应 → 摘要（A 组：弹幕总量/词云 top40 + 观看/点赞/打赏/互动等
    场次级指标 + 在线时间线峰值 + 录制版本/频道累计）。形状判空后解析。

    `status` 字段（2026-09-13 新增，见 devlog/061）报告**上游是否还提供词云**：
    - `upstream`：拿到了 `extra.wordCloud` 且非空 → 前端直接展示；
    - `upstream_absent`：`extra` 整个缺失，或 `extra` 在内但 `wordCloud` 为空
      → 前端显示「上游未提供热词」并给出「用弹幕自建」按钮（**不自动回退**）。
    """
    if not isinstance(payload, dict):
        return None
    total = payload.get("total")
    try:
        total = int(total) if total is not None else None
    except (TypeError, ValueError):
        total = None
    inner = payload.get("data")
    live = None
    channel = None
    if isinstance(inner, dict):
        live = inner.get("live")
        channel = inner.get("channel")
    elif isinstance(inner, list):
        live = inner[0] if inner else None
    if not isinstance(live, dict):
        return {
            "total": total, "danmakus_count": None, "word_cloud": [],
            "has_extra": False, "status": "upstream_absent",
            "watch_count": None, "like_count": None, "pay_count": None,
            "interaction_count": None, "online_rank": None, "comment_count": None,
            "is_full": None, "is_merged": None, "peaks": [], "versions": [],
            "channel": {},
        }
    # ⚠️ `extra` 缺失时**不能**当成"有 extra 但没词云"：2026-09-13 实测该字段是
    # 整个消失（而非置空）——区分开才能让前端文案说清是"上游没给"还是"本场没弹幕"。
    raw_extra = live.get("extra")
    has_extra = isinstance(raw_extra, dict)
    extra = raw_extra if has_extra else {}
    wc = extra.get("wordCloud") or {}
    top = []
    if isinstance(wc, dict):
        for k, v in wc.items():
            try:
                v = int(v)
            except (TypeError, ValueError):
                continue
            if v > 0:
                top.append((str(k), v))
        top.sort(key=lambda kv: -kv[1])
    status = "upstream" if top else "upstream_absent"
    # 在线人数时间线（{ms: count}）→ 峰值 top5（高光时刻）
    timeline = extra.get("onlineRank") or {}
    peaks: list[dict] = []
    if isinstance(timeline, dict):
        pts = []
        for k, v in timeline.items():
            try:
                pts.append((int(k), int(v)))
            except (TypeError, ValueError):
                continue
        pts.sort(key=lambda kv: -kv[1])
        peaks = [{"ts": ts, "count": n} for ts, n in pts[:5]]
    versions = []
    for v in live.get("versions") or []:
        if isinstance(v, dict):
            versions.append({
                "user_name": v.get("userName"),
                "is_official": bool(v.get("isOfficial")),
            })
    ch = channel if isinstance(channel, dict) else {}
    return {
        "total": total,
        "danmakus_count": live.get("danmakusCount"),
        "word_cloud": top[:40],
        "status": status,
        "has_extra": has_extra,
        "watch_count": live.get("watchCount"),
        "like_count": live.get("likeCount"),
        "pay_count": live.get("payCount"),
        "interaction_count": live.get("interactionCount"),
        "online_rank": live.get("onlineRank"),
        "comment_count": live.get("commentCount"),
        "is_full": live.get("isFull"),
        "is_merged": live.get("isMerged"),
        "peaks": peaks,
        "versions": versions,
        "channel": {
            "fans_count": ch.get("fansCount"),
            "total_danmakus_count": ch.get("totalDanmakusCount"),
            "total_income": ch.get("totalIncome"),
            "total_live_count": ch.get("totalLiveCount"),
        },
    }


def _parse_live_events(payload: dict) -> list[dict]:
    """/api/v2/live?type=7&8 → 直播间事件（{type, send_date_ms}）。

    type 7=直播中止 8=直播继续（B 组；真实中断时间线，供弹窗展示）。
    """
    if not isinstance(payload, dict):
        return []
    inner = payload.get("data")
    if not isinstance(inner, dict):
        return []
    out = []
    for it in inner.get("danmakus") or []:
        if not isinstance(it, dict):
            continue
        t = it.get("type")
        if t not in (7, 8):
            continue
        out.append({"type": int(t), "send_date_ms": it.get("sendDate")})
    return out


async def _fetch_live_summary_once(live_id: str) -> dict | None:
    """单次请求（失败返回 None，不重试）；重试策略见 `fetch_live_summary`。"""
    try:
        async with new_async_client(_LIVE_TIMEOUT) as client:
            resp = await client.get(
                f"{DANMAKUS_BASE}{LIVE_PATH}",
                params={"liveId": live_id, "pageNum": 0, "pageSize": 1,
                        "includeDanmakus": "true", "includeExtra": "true"},
                headers=BROWSER_HEADERS,
            )
    except httpx.HTTPError as e:
        logger.warning(f"danmakus live 详情请求失败 liveId={live_id}: "
                       f"{type(e).__name__}: {e}")
        return None
    if resp.status_code != 200:
        logger.warning(f"danmakus live 详情 HTTP {resp.status_code} liveId={live_id}")
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("code") != 200:
        logger.warning(f"danmakus live 详情响应异常 liveId={live_id}: "
                       f"code={data.get('code') if isinstance(data, dict) else '?'}")
        return None
    return _parse_live_summary(data.get("data"))


# 重试 3 次（指数退避、每次最多 `_LIVE_TIMEOUT`）。**耗尽后必须返回 None**，
# 不能抛错：调用方（路由层）按「拿不到就降级」处理，抛错会把「上游慢」变成 500。
# tenacity 8.x 耗尽重试后**默认抛 RetryError**，所以必须显式给 `retry_error_callback`
# 让它返回降级值（`retry=` 参数只管"什么结果值得重试"，不负责收尾）。
_retry_give_up_none = lambda _state: None      # noqa: E731
_retry_give_up_empty = lambda _state: []       # noqa: E731


@retry(stop=stop_after_attempt(3),
       wait=wait_exponential(multiplier=1, min=1, max=6),
       retry=retry_if_result(lambda r: r is None),
       retry_error_callback=_retry_give_up_none)
async def fetch_live_summary(live_id: str) -> dict | None:
    """公开端点（免鉴权）：单场直播弹幕摘要（弹幕总量 + 词云 + 场次级指标）。

    ## 为什么要重试（2026-09-13 实测，devlog/062）

    这个上游**会间歇性变慢**：同一个 `liveId` 同一份代码，实测有一次 15.6s 才返回、
    另一次 3.7s 就返回（老场次 1.7s）。而近期场次的响应体本身也大得多
    （223KB vs 老场次 45KB）。于是原来的**单次 12s 超时**会在上游稍慢时直接放弃，
    表现成「**这场直播明明有 13857 条弹幕，详情弹窗却说没有弹幕数据**」——
    5 个最近场次全部落在这个坑里，而更早的场次都正常。

    修法：把超时放宽到 `_LIVE_TIMEOUT`，并按本仓既有习惯
    （`fetcher.py` 的 B 站请求同款：3 次 + 指数退避 + 结果为 None 即重试）重试。
    失败仍返回 None（调用方降级），但重试大幅降低「偶发慢 → 误报无数据」的概率。
    """
    return await _fetch_live_summary_once(live_id)


DANMAKUS_V3_BASE = "/api/v3/lives"
# v3 弹幕切片：一次最多 100000 条（spec 声明上限）。单场实测 18764 条 ≈ 2MB 量级，
# 因此这里取 20000 —— 覆盖绝大多数场次；超出部分按 offset 翻页（见 fetch_raw_danmakus）。
_V3_DANMAKU_PAGE = 20000
_V3_DANMAKU_MAX = 100000


async def fetch_raw_danmakus(live_id: str, max_records: int = _V3_DANMAKU_MAX
                             ) -> list[dict] | None:
    """公开端点（免鉴权，2026-09-13 实测）：场次**原始弹幕记录**切片。

    `GET /api/v3/lives/{liveId}/danmakus?offset=&limit=` → `data.frame.records`，
    每条记录形如 `{"ts":…, "type":…, "payloadKind":…, "payload":{…}}`，
    **payload 已被服务端解码成 JSON 对象**（无需 MessagePack 解析）。

    这是词云自建路径的数据源：上游 `/api/v2/live` 的 `extra.wordCloud` 断供后
    （devlog/060），改由本地分词统计（见 `app/services/danmaku_words.py`）。

    返回 `None` 表示**失败**（网络/HTTP/形状异常），`[]` 表示**成功但没有记录**——
    调用方据此区分"拉取失败"与"本场无弹幕"。
    """
    records: list[dict] = []
    offset = 0
    try:
        async with new_async_client(_LIVE_TIMEOUT) as client:
            while offset < max_records:
                resp = await client.get(
                    f"{DANMAKUS_BASE}{DANMAKUS_V3_BASE}/{live_id}/danmakus",
                    params={"offset": offset, "limit": _V3_DANMAKU_PAGE},
                    headers=BROWSER_HEADERS,
                )
                if resp.status_code != 200:
                    logger.warning(f"danmakus v3 弹幕 HTTP {resp.status_code} "
                                   f"liveId={live_id} offset={offset}")
                    return None
                data = resp.json()
                if not isinstance(data, dict) or data.get("code") != 200:
                    logger.warning(f"danmakus v3 弹幕响应异常 liveId={live_id}: "
                                   f"code={data.get('code') if isinstance(data, dict) else '?'}")
                    return None
                inner = data.get("data") or {}
                frame = inner.get("frame") or {}
                page = frame.get("records") or []
                if not isinstance(page, list):
                    return None
                records.extend(r for r in page if isinstance(r, dict))
                if not page or not inner.get("hasMore"):
                    break
                offset += len(page)
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(f"danmakus v3 弹幕失败 liveId={live_id}: {type(e).__name__}: {e}")
        return None
    return records


@retry(stop=stop_after_attempt(3),
       wait=wait_exponential(multiplier=1, min=1, max=6),
       retry=retry_if_result(lambda r: not r),
       retry_error_callback=_retry_give_up_empty)
async def fetch_live_events(live_id: str) -> list[dict]:
    """公开端点：直播间事件（type 7=直播中止 / 8=直播继续，B 组）。

    与详情同源但**必须单独请求**：2026-09-13 实测主请求（无 type 过滤）里
    `danmakus` 只有 1 条 type=11，拿不到 7/8；带 `type=7&8` 才有。
    同样加上 3 次重试（同 `fetch_live_summary`，慢上游不容忍单次失败）；
    失败返回 []。
    """
    try:
        async with new_async_client(_LIVE_TIMEOUT) as client:
            resp = await client.get(
                f"{DANMAKUS_BASE}{LIVE_PATH}",
                params={"liveId": live_id, "type": ["7", "8"],
                        "pageNum": 0, "pageSize": 50,
                        "includeDanmakus": "true"},
                headers=BROWSER_HEADERS,
            )
    except httpx.HTTPError as e:
        logger.warning(f"danmakus live 事件请求失败 liveId={live_id}: "
                       f"{type(e).__name__}: {e}")
        return []
    if resp.status_code != 200:
        logger.warning(f"danmakus live 事件 HTTP {resp.status_code} liveId={live_id}")
        return []
    try:
        data = resp.json()
    except ValueError:
        return []
    if not isinstance(data, dict) or data.get("code") != 200:
        return []
    return _parse_live_events(data.get("data"))


class DanmakusSource(ExternalSource):
    name = "danmakus"
    enabled = True
    jobs = [
        ExternalJob("danmakus", "vtuber_index", "VTuber 索引整表刷新（企划/公会）",
                    INTERVAL_WEEKLY),
        ExternalJob("danmakus", "live_sessions", "直播场次同步（标题/起止/分区/收益）",
                    INTERVAL_DAILY),
    ]

    async def run_job(self, kind: str, db: Session,
                      client: httpx.AsyncClient,
                      account_ids: list[int] | None = None) -> ExternalJobSummary:
        if kind == "vtuber_index":
            # 索引是整表任务，账号白名单不适用（收录回填只关心场次）
            return await self._sync_vtuber_index(db, client)
        if kind == "live_sessions":
            return await self._sync_live_sessions(db, client, account_ids)
        return ExternalJobSummary(self.name, kind, error=f"未知任务: {kind}")

    def _bili_accounts(self, db: Session,
                       account_ids: list[int] | None = None) -> list[Account]:
        q = db.query(Account).filter(
            Account.platform == "bilibili",
            Account.platform_uid != None,  # noqa: E711
            Account.platform_uid != "",
        )
        if account_ids:
            q = q.filter(Account.id.in_(account_ids))
        return q.all()

    async def _sync_live_sessions(self, db: Session,
                                  client: httpx.AsyncClient,
                                  account_ids: list[int] | None = None) -> ExternalJobSummary:
        """直播场次每日同步（v0.9.x M2）：公开端点全量拉取 → 幂等 upsert。

        场次含标题/起止/分区/收益/峰值在线/弹幕数；直播中场次 stopDate=0，
        end_at 由 merged() 用 self 快照补齐（当日即准确）。
        account_ids：收录新 V 时只回填该账号。
        """
        summary = ExternalJobSummary(self.name, "live_sessions")
        accounts = self._bili_accounts(db, account_ids)
        for acc in accounts:
            try:
                payload = await fetch_channel(str(acc.platform_uid), client)
            except Exception as e:
                # 账号级隔离：网络异常只影响本账号，其余账号继续
                logger.warning(f"danmakus lives 账号异常 {acc.platform_uid}: "
                               f"{type(e).__name__}: {e}")
                summary.skipped += 1
                continue
            if not payload:
                summary.skipped += 1
                continue
            lives = payload.get("lives") or []
            res = LiveSessionRepo(db).upsert_danmakus(acc.id, lives)
            summary.stored += res["added"]
            logger.info(f"danmakus live_sessions: {acc.platform_uid} "
                        f"新增 {res['added']} 刷新 {res['updated']}")
        return summary

    async def _sync_vtuber_index(self, db: Session,
                                 client: httpx.AsyncClient) -> ExternalJobSummary:
        summary = ExternalJobSummary(self.name, "vtuber_index")
        resp = await client.get(f"{DANMAKUS_BASE}{VUP_LIST_PATH}")
        if resp.status_code != 200:
            summary.error = f"HTTP {resp.status_code}"
            logger.warning(f"danmakus vup-list 失败 HTTP {resp.status_code}")
            return summary
        data = resp.json()
        if not isinstance(data, dict) or not isinstance(data.get("data"), dict):
            summary.error = "响应结构异常"
            return summary
        mapping = data["data"]

        # 整表刷新：同一 source 先清后插（周级低频；单事务原子提交）
        db.query(ThirdpartyVtuber).filter(
            ThirdpartyVtuber.source == self.name).delete(synchronize_session=False)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        for mid, info in mapping.items():
            if not isinstance(info, dict):
                continue
            db.add(ThirdpartyVtuber(
                platform="bilibili",
                platform_uid=str(mid),
                name=str(info.get("name") or ""),
                type=info.get("type"),
                room_id=str(info.get("room") or "") or None,
                group_name=info.get("group_name") or None,
                source=self.name,
                updated_at=now,
            ))
        db.commit()
        summary.stored = len(mapping)
        logger.info(f"danmakus vtuber_index: 整表刷新 {len(mapping)} 条")
        return summary
