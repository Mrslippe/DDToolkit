# -*- coding: utf-8 -*-
"""录播**来源取数**：把一个 B 站号下的系列 / 合集 / 投稿统一成 `SourceItem`（`docs/plans/vod-autofill.md` B2）。

## 三条路，以及为什么要有三条

| 来源 | 端点 | 鉴权（2026-10-14 实测） |
|---|---|---|
| **系列**（`series`） | `GET /x/series/archives?mid=&series_id=&pn=&ps=200&sort=desc` | **完全匿名**，`ps=200` 可用，单页 **0.05–0.13s** |
| **合集**（`season`） | `GET /x/polymer/web-space/seasons_archives_list?mid=&season_id=&page_num=&page_size=` | 匿名可用（实现同系列） |
| **投稿流** | `app/services/fetcher.fetch_bilibili_videos`（`arc/search`） | **要登录**：匿名 `-352 风控校验失败`（旧路径 `-403/-799`） |

清单端点：`GET /x/polymer/web-space/seasons_series_list?mid=&page_num=&page_size=`（匿名），
回 `{items_lists: {seasons_list: [...], series_list: [...]}}`，各带 `season_id`/`series_id`/`name`/`total`/`mtime`。

⚠️ **实测**：明前奶绿（`2132180406`）的系列「直播回放」`series_id=2484684`、**total=942**、
`mtime` = 最近更新 —— 但**名字里没有 "回放" 的系列照样可能全是回放**，所以挑来源的规则是
「名字优先、条数次之」，且**一定要让人能改**（见 `pick_source`）。

## 分层

本模块**只取数**（网络 + 归一化成 `SourceItem`）；前处理与配对在 `app/domain/vod_source.py`
与 `app/domain/vod_autofill.py`（纯函数、有单测）。这样"上游改字段"只改这一个文件。
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

import httpx

from app.core.http import new_async_client
from app.domain.vod_match import parse_duration
from app.domain.vod_source import classify
from app.services.fetcher import fetch_bilibili_videos

logger = logging.getLogger(__name__)

BILI_API = "https://api.bilibili.com"
SEASONS_SERIES_PATH = "/x/polymer/web-space/seasons_series_list"
SERIES_ARCHIVES_PATH = "/x/series/archives"
SEASON_ARCHIVES_PATH = "/x/polymer/web-space/seasons_archives_list"

#: 单页条数。实测 `ps=200` 可用（942 条的系列 5 页取完）；再大没有依据，不试。
PAGE_SIZE = 200
#: 翻页上限（兜底）：一个号理论上不该有 20000 条录播
MAX_PAGES = 100
#: **投稿流**的翻页上限（2026-10-15）：走登录态接口，比匿名的系列接口慢，所以单列一个。
#: 24 页 × 50 = 1200 条 —— 实测专用录播号 `94009831` 有 1093 条，正好装得下。
#: ⚠️ 它现在只是**兜底上限**：正常停页由 `stop_before`（见下）按数据决定。
UPLOAD_MAX_PAGES = 24
#: **停页判据**（2026-10-15 用户口径）：「按当页最后一条投稿的发布时间与直播场次记录的
#: 最早场次时间之间的差值来算，如果最后一条投稿早于最早的一场直播，那就不翻了」。
#: 留一天边距再停：场次记录与真实开播之间本来就有偏差（早场按惯例标前一天、
#: 录制源的场次记录可能晚于真实开场），卡在正好那一刻会把**刚刚跨过边界**的那一页切掉。
PAGE_STOP_MARGIN = timedelta(days=1)
#: **投稿流收哪些 tier**（2026-10-15 用户口径：「如果视频标题和时间明显不是录播，也丢弃」）。
#: `replay` = 标题有回放词 / `dated` = 标题里有可读的场次时间 —— 两者至少占一样才算"像录播"。
#: `weak`（标题既没有回放词、也没有日期）在**投稿流**里就是别的投稿混进来了 ⇒ 丢。
#: ⚠️ 只对投稿流生效：系列/合集是上传者自己归档的，不该替他去判断。
UPLOAD_KEEP_TIERS: tuple[str, ...] = ("replay", "dated")
#: 取数超时：实测单页 0.05–0.13s，给 20s 足够（风控/网络抖动时也让得出结论）
TIMEOUT = 20.0

#: 请求头：与业务端点同源（缺 Referer/Origin 时上游行为不稳定）
def _headers(mid: str) -> dict:
    from app.core.useragent import UA_CHROME

    return {
        "User-Agent": UA_CHROME,
        "Accept": "application/json, text/plain, */*",
        "Referer": f"https://space.bilibili.com/{mid}/",
        "Origin": "https://space.bilibili.com",
    }


#: 录播来源的名字关键词（按优先级）。**只用于排序**，不用于过滤 ——
#: 名字不匹配时照样列出来让人选（实证：不能靠名字一刀切）。
NAME_HINTS: tuple[str, ...] = ("直播回放", "回放", "录播", "直播录像", "录播组", "存档")

#: 用户资料卡（**匿名可用**，实测 2026-10-15）：回 `data.card` 的姓名/头像/粉丝/签名。
#: ⚠️ 不要用 `x/space/wbi/acc/info`：那个匿名是 `-352 风控校验失败`（同一天实测）。
CARD_PATH = "/x/web-interface/card"
#: 一次最多解析几个 mid（小窗一屏 5 条 + 余量）。**防的是"参数里塞 500 个 mid"**：
#: 每个 mid 要打两次上游，不限量就是一个可被滥用的放大器。
MAX_PROFILE_MIDS = 12


async def resolve_account_profile(mid: str, *, client: httpx.AsyncClient | None = None) -> dict:
    """一个 mid → `{mid, name, avatar, uploads, last_published_at, name_error, uploads_error}`。

    小窗里那一行 `| 昵称 mid 投稿数 |` 就靠它。两半**各自独立失败**：

    - **昵称 / 头像**：`x/web-interface/card`（匿名）—— 拿不到就把 `name_error` 填上，
      界面上标黄但仍允许保存（号本身有效，只是名字没取到）；
    - **投稿数 / 最近投稿**：复用已在用的 `arc/search`（**登录态**，`ps=2` 只为省流量，
      我们要的是 `page.count` 与最新一条的时间）—— 同样失败不抛。
    """
    out: dict = {"mid": str(mid), "name": "", "avatar": "", "uploads": None,
                 "last_published_at": None, "name_error": None, "uploads_error": None}
    own = client is None
    cli = client or new_async_client(TIMEOUT)
    try:
        try:
            resp = await cli.get(f"{BILI_API}{CARD_PATH}", params={"mid": str(mid)},
                                 headers=_headers(mid))
            body = resp.json() if resp.status_code == 200 else {}
            card = ((body or {}).get("data") or {}).get("card") or {}
            out["name"] = str(card.get("name") or "")
            out["avatar"] = str(card.get("face") or "")
            if not out["name"]:
                out["name_error"] = f"没查到昵称（code={body.get('code')}）"
        except Exception as e:                                   # noqa: BLE001
            out["name_error"] = f"{type(e).__name__}: {e}"
    finally:
        if own:
            await cli.aclose()

    try:
        res = await fetch_bilibili_videos(str(mid), page=1, page_size=2)
        if res is None:
            out["uploads_error"] = "没取到投稿数（未登录 / 风控 / 网络）"
        else:
            out["uploads"] = int(res.get("total") or 0)
            items = res.get("items") or []
            if items:
                pub = items[0].get("published_at")
                if isinstance(pub, datetime):
                    out["last_published_at"] = (
                        pub.astimezone(timezone.utc).replace(tzinfo=None)
                        if pub.tzinfo else pub)
    except Exception as e:                                       # noqa: BLE001
        out["uploads_error"] = f"{type(e).__name__}: {e}"
    return out


async def resolve_account_profiles(mids: list[str]) -> list[dict]:
    """批量（**并发**）：小窗一开要把 5 条都填上，串行就是 5 倍等待。

    并发上限 `MAX_PROFILE_MIDS`：多的直接截断（调用方自己也会限 5 条，这里是防线）。
    """
    want = [str(m).strip() for m in mids if str(m).strip()][:MAX_PROFILE_MIDS]
    if not want:
        return []
    return list(await asyncio.gather(*(resolve_account_profile(m) for m in want)))


def pick_source(sources: list[dict]) -> dict | None:
    """自动挑一个来源：**名字命中关键词**优先，同类里**条数最多**者胜。

    为什么不是"条数最多者胜"：一个 V 的「翻唱」合集可能有 200 条而「直播回放」只有 80 条，
    只看条数会挑错。为什么不是"名字必须命中"：实测存在名字叫「xxx的直播」而内容全是回放的系列。
    ⇒ 名字优先、条数次之，且调用方**必须**把结果摆给用户看并允许改。
    """
    if not sources:
        return None

    def key(s: dict):
        name = str(s.get("name") or "")
        hit = next((i for i, h in enumerate(NAME_HINTS) if h in name), len(NAME_HINTS))
        return (hit, -(int(s.get("total") or 0)))

    return sorted(sources, key=key)[0]


async def list_sources(mid: str, *, client: httpx.AsyncClient | None = None) -> list[dict]:
    """一个 mid 下**有内容**的合集与系列 → `[{kind, id, name, total, cover, mtime}]`。

    外加一条恒存在的 `{"kind": "uploads", "id": "", "name": "投稿", ...}` ——
    投稿流是三条路里唯一"什么都能装"的那条（也最脏，靠前处理筛）。

    失败返回 `[]`（**不抛**）：调用方要能区分"这个号没有合集"与"这次没取到"，
    由调用方读 `sources_error`（本函数只保证不炸）。
    """
    out: list[dict] = []
    own = client is None
    cli = client or new_async_client(TIMEOUT)
    try:
        resp = await cli.get(f"{BILI_API}{SEASONS_SERIES_PATH}",
                             params={"mid": mid, "page_num": 1, "page_size": 20},
                             headers=_headers(mid))
        if resp.status_code == 200:
            data = (resp.json() or {}).get("data") or {}
            lists = data.get("items_lists") or {}
            for kind, key in (("season", "seasons_list"), ("series", "series_list")):
                for it in lists.get(key) or []:
                    meta = it.get("meta") or {}
                    sid = meta.get("season_id") if kind == "season" else meta.get("series_id")
                    if sid is None:
                        continue
                    out.append({
                        "kind": kind,
                        "id": str(sid),
                        "name": str(meta.get("name") or ""),
                        "total": int(meta.get("total") or 0),
                        "cover": str(meta.get("cover") or ""),
                        "mtime": meta.get("mtime"),
                    })
        else:
            logger.info("录播来源清单未取到 mid=%s HTTP %s", mid, resp.status_code)
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("录播来源清单失败 mid=%s: %s: %s", mid, type(e).__name__, e)
    finally:
        if own:
            await cli.aclose()

    out.append({"kind": "uploads", "id": "", "name": "投稿", "total": None,
                "cover": "", "mtime": None})
    return out


def _to_item(raw: dict, *, mid: str, source_name: str) -> dict | None:
    """上游一条 → `SourceItem` 的构造参数（含前处理分级）。

    ⚠️ 三条路给的字段名不同：系列/合集是 `bvid/title/duration(秒)/pubdate(秒)/pic`，
    投稿流是 `platform_post_id/title/body_json.duration("5:00:09")/published_at`。
    这里统一成一种，**分级缺失就等于漏配**（`classify` 拿不到时长会少一层保护）。
    """
    if not isinstance(raw, dict):
        return None
    bvid = str(raw.get("bvid") or raw.get("platform_post_id") or "")
    title = str(raw.get("title") or "")
    if not bvid:
        return None

    dur = raw.get("duration")
    if not isinstance(dur, int):
        dur = None
    if dur is None:
        # ⚠️ **投稿流的时长在 `body_json.duration` 里**（`"5:00:09"`），不是顶层字段
        #    （2026-10-15 修）：不解析它 ⇒ 每一条投稿都是"时长未知"，
        #    于是 `<10 分钟直接丢掉` 那条前处理形同虚设，兜底路径的"≥30 分钟"也永远不生效。
        body = raw.get("body_json")
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except ValueError:
                body = None
        if isinstance(body, dict):
            mins = parse_duration(body.get("duration"))
            dur = mins * 60 if mins else None
    pub = raw.get("published_at")            # 投稿流已经是 datetime
    if isinstance(pub, datetime):
        # ⚠️ **投稿流给的是带时区的 datetime**（`fetcher._ts_to_datetime` 用 `tz=utc`），
        #    而本仓的约定是**朴素 UTC**（`start_at` 等一律朴素）。不归一的话，
        #    任何"发布时刻 vs 场次时刻"的比较都会抛
        #    `TypeError: can't compare offset-naive and offset-aware datetimes`
        #    —— 2026-10-15 真机实测就是这么把整个投稿号扫崩的（翻页下界那一比）。
        pub = pub.astimezone(timezone.utc).replace(tzinfo=None) if pub.tzinfo else pub
    else:
        ts = raw.get("pubdate")
        pub = (datetime.fromtimestamp(int(ts), tz=timezone.utc).replace(tzinfo=None)
               if isinstance(ts, (int, float)) and ts else None)

    tier, hint = classify(title, dur, pub)
    if tier == "excluded":
        return None
    return {
        "bvid": bvid, "title": title, "duration_seconds": dur, "published_at": pub,
        "permalink": str(raw.get("permalink")
                         or (f"https://www.bilibili.com/video/{bvid}" if bvid else "")),
        "cover_url": str(raw.get("cover_url") or raw.get("pic") or ""),
        "mid": str(mid), "source_name": source_name, "tier": tier, "hint": hint,
    }


async def fetch_series_archives(mid: str, series_id: str, *,
                               client: httpx.AsyncClient | None = None,
                               source_name: str = "系列") -> list[dict]:
    """系列（series）全部条目 → `SourceItem` 构造参数列表（已过前处理，`excluded` 已丢）。"""
    return await _fetch_paged(
        f"{BILI_API}{SERIES_ARCHIVES_PATH}",
        {"mid": mid, "series_id": series_id, "sort": "desc"},
        mid=mid, source_name=source_name, client=client,
        page_param="pn", size_param="ps",
        pick=lambda d: (d.get("archives") or [], int((d.get("page") or {}).get("total") or 0)))


async def fetch_season_archives(mid: str, season_id: str, *,
                                client: httpx.AsyncClient | None = None,
                                source_name: str = "合集") -> list[dict]:
    """合集（season）全部条目。字段与系列同形（B 站两个端点的 archives 一致）。"""
    return await _fetch_paged(
        f"{BILI_API}{SEASON_ARCHIVES_PATH}",
        {"mid": mid, "season_id": season_id, "sort_reverse": "false"},
        mid=mid, source_name=source_name, client=client,
        page_param="page_num", size_param="page_size",
        pick=lambda d: (d.get("archives") or [], int(d.get("total") or 0)))


async def _fetch_paged(url: str, base_params: dict, *, mid: str, source_name: str,
                       client: httpx.AsyncClient | None, page_param: str, size_param: str,
                       pick) -> list[dict]:
    """通用翻页：`hasMore` 不可靠 ⇒ **按"返回条数 < 页大小"停**，另有 `MAX_PAGES` 兜底。"""
    out: list[dict] = []
    own = client is None
    cli = client or new_async_client(TIMEOUT)
    try:
        for page in range(1, MAX_PAGES + 1):
            params = {**base_params, page_param: page, size_param: PAGE_SIZE}
            try:
                resp = await cli.get(url, params=params, headers=_headers(mid))
            except httpx.HTTPError as e:
                logger.warning("录播来源取数失败 %s mid=%s p%s: %s: %s",
                               source_name, mid, page, type(e).__name__, e)
                break
            if resp.status_code != 200:
                logger.info("录播来源取数 HTTP %s %s mid=%s p%s", resp.status_code,
                            source_name, mid, page)
                break
            try:
                data = (resp.json() or {}).get("data") or {}
            except ValueError:
                break
            page_items, _total = pick(data)
            for raw in page_items:
                got = _to_item(raw, mid=mid, source_name=source_name)
                if got:
                    out.append(got)
            if len(page_items) < PAGE_SIZE:
                break                       # 最后一页（`hasMore` 各端点形态不一，不依赖它）
    finally:
        if own:
            await cli.aclose()
    return out


async def fetch_uploads(mid: str, *, max_pages: int = UPLOAD_MAX_PAGES,
                        stop_before: datetime | None = None) -> list[dict]:
    """投稿流（**要登录**）→ `SourceItem` 构造参数列表。

    ⚠️ 匿名调 `arc/search` 是 `-352 风控校验失败`（实测），所以这条路在未登录时
    **必然返回空** —— 调用方要如实告诉用户"投稿这条没取到"，别把空当成"这个号没录播"。

    ## 翻多少页：**按数据决定**（2026-10-15 用户口径）

    投稿按 `order=pubdate` 倒序 ⇒ 越翻越旧。`stop_before` 给的是"**比最早的一场直播
    还早**"那条线（调用方按 `最早场次 − PAGE_STOP_MARGIN` 算）：一页翻完，只要这一页
    **最旧的那条**已经早于它，后面的只会更旧、**配不上任何场次** ⇒ 停。
    `max_pages` 退化成纯粹的兜底上限（原来是硬编码 24 页）。

    ## 收哪些：**标题和时间都不像录播的丢掉**（同一条用户口径）

    `tier` 不在 `UPLOAD_KEEP_TIERS` 里（= 标题既没有回放词、也没有可读场次时间的 `weak`）
    ⇒ 那是别的投稿混进来了，丢；比 `stop_before` 还旧的也丢（配不上任何场次）。
    丢了多少条进日志 —— 这是"用户以为扫了 1093 条、其实只用了 900 条"唯一看得见的地方。
    """
    out: list[dict] = []
    total = 0
    dropped_not_replay = 0
    dropped_too_old = 0
    for page in range(1, max(1, max_pages) + 1):
        try:
            res = await fetch_bilibili_videos(mid, page=page, page_size=50)
        except Exception as e:                                  # noqa: BLE001
            logger.warning("投稿流取数失败 mid=%s p%s: %s: %s", mid, page, type(e).__name__, e)
            break
        if res is None:                                         # 风控/未登录/网络
            logger.info("投稿流未取到 mid=%s p%s（风控/未登录/网络）", mid, page)
            break
        total = int(res.get("total") or 0) or total
        items = res.get("items") or []
        oldest: datetime | None = None
        for raw in items:
            got = _to_item(raw, mid=mid, source_name="投稿")
            if got is None:                                     # 时长过短/命中排除词的，`_to_item` 已经丢了
                continue
            pub = got.get("published_at")
            if pub is not None:
                oldest = pub if oldest is None else min(oldest, pub)
            if got["tier"] not in UPLOAD_KEEP_TIERS:
                dropped_not_replay += 1
                continue
            if stop_before is not None and pub is not None and pub < stop_before:
                dropped_too_old += 1
                continue
            out.append(got)
        # ★ 停页：这一页最旧的那条已经早于"最早的一场直播" ⇒ 再翻只会更旧
        if stop_before is not None and oldest is not None and oldest < stop_before:
            logger.info("投稿流翻到第 %s 页即停 mid=%s（本页最旧 %s 早于下界 %s）",
                        page, mid, oldest, stop_before)
            break
        if len(items) < 50:
            break
    if dropped_not_replay or dropped_too_old:
        logger.info("投稿流丢弃 mid=%s：不像录播 %s 条 / 早于最早场次 %s 条",
                    mid, dropped_not_replay, dropped_too_old)
    if total and total > max(1, max_pages) * 50:
        logger.warning("投稿流翻到了上限 mid=%s（该号共 %s 条）—— 剩下的这一轮没有参与匹配",
                       mid, total)
    return out
