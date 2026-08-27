"""微博平台适配（weibo.com PC ajax 接口）。

实测（2026-08）：扫码登录产出的 SUB cookie 仅对 PC 域（weibo.com）有效，
m.weibo.cn getIndex 判登录还依赖 wapssowb 链路 cookie（ok:-100 需登录）。
因此抓取全面走 PC 接口：
- 用户信息  GET https://weibo.com/ajax/profile/info?uid={uid}
            → data.user（screen_name/description/avatar_hd/followers_count/...）
- 微博列表  GET https://weibo.com/ajax/statuses/mymblog?uid={uid}&page=N&feature=0
            → data.list[]；data.since_id 判 has_more
- 长文全文  GET https://weibo.com/ajax/statuses/show?id={mid} → data.text 全文

请求头：PC UA + Referer weibo.com/u/{uid} + Cookie（weibo_auth 扫码登录保存）。
图片：PC 用 pic_ids → 大图 URL 拼接 https://wx1.sinaimg.cn/large/{pid}.jpg
      （img-proxy 白名单已含 sinaimg.cn/wbcdn.cn）。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone

import httpx

from app.services.fetcher import _client_ctx, _detect_rate_limit
from app.services.platforms.base import BasePlatform
from app.services.weibo_auth import weibo_auth_manager

logger = logging.getLogger(__name__)

_PC_PROFILE_URL = "https://weibo.com/ajax/profile/info"
_PC_MYMBLOG_URL = "https://weibo.com/ajax/statuses/mymblog"
_PC_SHOW_URL = "https://weibo.com/ajax/statuses/show"

# 长文全文：m 站 extend（PC statuses/show 截断；extend 不判 wap 登录态）
_EXTEND_URL = "https://m.weibo.cn/statuses/extend"
_MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
)

_PC_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)

_TAG_RE = re.compile(r"<[^>]+>")


def _headers(uid: str = "") -> dict:
    """PC ajax 请求头：Cookie 取自扫码登录保存的 WEIBO_COOKIE（PC 域有效）。"""
    h = {
        "User-Agent": _PC_UA,
        "Referer": f"https://weibo.com/u/{uid}" if uid else "https://weibo.com/",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "X-Requested-With": "XMLHttpRequest",
    }
    if weibo_auth_manager.cookie:
        h["Cookie"] = weibo_auth_manager.cookie
    return h


def _strip_html(s: str | None) -> str:
    return _TAG_RE.sub("", s or "").strip()


def _parse_weibo_time(s: str | None):
    """微博 created_at：优先 'Mon Aug 25 12:34:56 +0800 2025'；
    兜底相对时间（x分钟前/x小时前/昨天/MM-DD）。返回 naive UTC（与库内一致）。"""
    if not s:
        return None
    s = s.strip()
    try:
        dt = datetime.strptime(s, "%a %b %d %H:%M:%S %z %Y")
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    except ValueError:
        pass
    now = datetime.now(timezone.utc)
    m = re.match(r"^(\d+)分钟前$", s)
    if m:
        return (now - timedelta(minutes=int(m.group(1)))).replace(tzinfo=None)
    m = re.match(r"^(\d+)小时前$", s)
    if m:
        return (now - timedelta(hours=int(m.group(1)))).replace(tzinfo=None)
    if s.startswith("昨天"):
        try:
            t = datetime.strptime(s[2:].strip(), "%H:%M").time()
            return (now - timedelta(days=1)).replace(
                hour=t.hour, minute=t.minute, second=0, microsecond=0, tzinfo=None)
        except ValueError:
            pass
    m = re.match(r"^(\d{1,2})-(\d{1,2})(?: (\d{2}:\d{2}))?$", s)
    if m:
        try:
            hm = m.group(3)
            if hm:
                hh, mm = map(int, hm.split(":"))
                return datetime(now.year, int(m.group(1)), int(m.group(2)),
                                hh, mm).replace(tzinfo=None)
            return datetime(now.year, int(m.group(1)), int(m.group(2))).replace(tzinfo=None)
        except ValueError:
            pass
    return None


def _images_of(m: dict) -> list[dict]:
    """图片真实 URL：PC 形态 pic_infos{pid:{largest/original/large}} 优先，
    m 站形态 pics[{large|url}] 兼容；pic_ids 无 pic_infos 时拼 sinaimg 大图兜底。"""
    pics = m.get("pics") or []
    imgs = [{"url": p.get("large") or p.get("url")} for p in pics
            if p.get("large") or p.get("url")]
    if imgs:
        return imgs
    infos = m.get("pic_infos") or {}
    for pid in (m.get("pic_ids") or []):
        if not pid:
            continue
        info = infos.get(pid) or {}
        # largest（实际是 large 尺寸直链）> original > large > 拼接兜底
        best = ((info.get("largest") or {}).get("url")
                or (info.get("original") or {}).get("url")
                or (info.get("large") or {}).get("url"))
        imgs.append({"url": best or f"https://wx1.sinaimg.cn/large/{pid}.jpg"})
    return imgs


def _page_type(m: dict) -> str:
    """PC page_info.type 可能是字符串或数字：统一转小写字符串对比。
    注意：type=23 等数字型是推广卡（SVIP 卡/网页卡，object_type=webpage、无 media），
    不是视频——分类时仅接受字符串 "video"/"article"。"""
    pi = m.get("page_info") or {}
    return str(pi.get("type", "") or "").lower()


def _origin_of(retweeted: dict) -> dict | None:
    """转发原文 → 复用现有 repost origin 渲染结构。"""
    if not isinstance(retweeted, dict) or not retweeted.get("id"):
        return None
    user = retweeted.get("user") or {}
    oid = str(retweeted["id"])
    images = _images_of(retweeted)
    rt_type = _page_type(retweeted)
    cover_url = (images[0]["url"] if images
                 else (((retweeted.get("page_info") or {}).get("page_pic")) or None))
    if not cover_url and rt_type == "video":
        cover_url = ((retweeted.get("page_info") or {}).get("page_pic")) or None
    return {
        "text": _strip_html(retweeted.get("text")),
        "images": images or None,
        "cover_url": cover_url,
        "permalink": f"https://m.weibo.cn/detail/{oid}",
        "author": (user.get("screen_name") if isinstance(user, dict) else ""),
    }


def _map_mblog(m: dict, uid: str) -> dict:
    """帖子分类（判定顺序即优先级）：
    repost → video(page_info.type=="video" 且有媒体/封面) → article → image(pic_ids/pics) → text。
    推广卡（type=23 等 webpage 卡）不参与：有图归 image、无图归 text。"""
    mid = str(m.get("id") or m.get("idstr") or m.get("mid") or "")
    text = _strip_html(m.get("text"))
    images = _images_of(m)
    retweeted = m.get("retweeted_status")
    ptype = _page_type(m)
    page_info = m.get("page_info") or {}
    media = page_info.get("media_info") or {}

    has_video_media = ptype == "video" and bool(
        media.get("stream_url") or media.get("mp4_720p_mp4") or media.get("mp4_sd_url")
        or media.get("mp4_hd_url") or page_info.get("page_pic"))

    if retweeted:
        typ = "repost"
    elif has_video_media:
        typ = "video"
    elif ptype == "article":
        typ = "article"
    elif images:
        typ = "image"
    else:
        typ = "text"

    body: dict = {"text": text}
    if images:
        body["images"] = images
    if retweeted:
        origin = _origin_of(retweeted)
        if origin:
            body["origin"] = origin
    if typ == "video":
        t = page_info.get("title")
        if t:
            body["title"] = t
        body["video"] = {
            "mp4": (media.get("stream_url") or media.get("mp4_720p_mp4")
                    or media.get("mp4_sd_url") or media.get("mp4_hd_url")),
            "cover": page_info.get("page_pic"),
        }

    cover = images[0]["url"] if images else (page_info.get("page_pic") or None)
    return {
        "platform": "weibo",
        "platform_uid": str(uid),
        "platform_post_id": mid,
        "type": typ,
        "title": page_info.get("title"),
        "summary": text[:200] if text else "",
        "cover_url": cover,
        "permalink": f"https://m.weibo.cn/detail/{mid}",
        "body_json": json.dumps(body, ensure_ascii=False),
        "stats_json": json.dumps({
            "reposts": m.get("reposts_count", 0),
            "comments": m.get("comments_count", 0),
            "like": m.get("attitudes_count", 0),
        }, ensure_ascii=False),
        "published_at": _parse_weibo_time(m.get("created_at")),
        "raw_json": json.dumps(m, ensure_ascii=False, default=str),
    }


class WeiboPlatform(BasePlatform):
    platform = "weibo"

    async def fetch_user_info(self, uid: str, client: httpx.AsyncClient | None = None) -> dict | None:
        try:
            async with _client_ctx(client) as http:
                resp = await http.get(
                    _PC_PROFILE_URL, params={"uid": uid}, headers=_headers(uid))
                if resp.status_code != 200:
                    _detect_rate_limit(resp.status_code)
                    logger.warning(f"微博用户信息失败: HTTP {resp.status_code}, uid={uid}")
                    return None
                try:
                    data = resp.json()
                except ValueError:
                    logger.warning(f"微博用户信息非 JSON: uid={uid}, body={resp.text[:200]}")
                    return None
                if data.get("ok") != 1:
                    _detect_rate_limit(resp.status_code, data)
                    logger.warning(
                        f"微博用户信息 ok!=1: uid={uid}, msg={data.get('msg')}, "
                        f"body={str(data)[:200]}"
                    )
                    return None
                user = (data.get("data") or {}).get("user") or {}
                if not user:
                    logger.warning(
                        f"微博用户信息 user 为空: uid={uid}, "
                        f"data_keys={list((data.get('data') or {}).keys())[:8]}"
                    )
                    return None
                return {
                    "name": user.get("screen_name"),
                    "sign": user.get("description"),
                    "avatar": (user.get("avatar_hd") or user.get("avatar_large")
                               or user.get("profile_image_url")),
                    "followers_count": user.get("followers_count", 0),
                    "url": f"https://weibo.com/u/{uid}",
                    "statuses_count": user.get("statuses_count", 0),
                }
        except Exception as e:
            logger.warning(f"微博用户信息抓取异常: uid={uid}, {type(e).__name__}: {e}")
            return None

    async def fetch_post_page(self, uid: str, page: int, client: httpx.AsyncClient | None = None) -> dict | None:
        try:
            async with _client_ctx(client) as http:
                resp = await http.get(
                    _PC_MYMBLOG_URL,
                    params={"uid": uid, "page": page, "feature": 0},
                    headers=_headers(uid),
                )
                if resp.status_code != 200:
                    _detect_rate_limit(resp.status_code)
                    return None
                try:
                    data = resp.json()
                except ValueError:
                    return None
                if data.get("ok") != 1:
                    _detect_rate_limit(resp.status_code, data)
                    if data.get("ok") == -100:
                        logger.warning(f"微博列表需登录（ok=-100）: uid={uid}")
                    return None
                d = data.get("data") or {}
                items = [_map_mblog(it, uid) for it in (d.get("list") or []) if it.get("id")]
                has_more = bool(items) and bool(d.get("since_id"))
                return {"items": items, "has_more": has_more}
        except Exception as e:
            logger.warning(f"微博列表抓取异常: uid={uid}, {type(e).__name__}: {e}")
            return None

    async def enrich(self, item: dict, client: httpx.AsyncClient | None = None) -> bool:
        """长文补全：isLongText → m 站 statuses/extend 拿全文。返回是否发起了请求。

        实测（2026-08）：PC statuses/show 对长文同样返回截断 text（无 longText 字段），
        而 m 站 extend 在 PC cookie 下 ok:1 返回 longTextContent —— 全文只此一途。
        extend 不判 wap 登录态（仅 getIndex 判），PC SUB cookie 可用；请求头用
        移动端 UA + m 站 Referer 贴近真实调用。
        """
        try:
            raw = json.loads(item.get("raw_json") or "{}")
        except (json.JSONDecodeError, TypeError):
            return False
        if not raw.get("isLongText") or not raw.get("id"):
            return False
        mobile_headers = {
            "User-Agent": _MOBILE_UA,
            "Referer": "https://m.weibo.cn/",
            "X-Requested-With": "XMLHttpRequest",
        }
        if weibo_auth_manager.cookie:
            mobile_headers["Cookie"] = weibo_auth_manager.cookie
        async with _client_ctx(client) as http:
            resp = await http.get(
                f"{_EXTEND_URL}?id={raw['id']}", headers=mobile_headers)
            if resp.status_code != 200:
                logger.warning(f"微博长文补全失败: HTTP {resp.status_code}, id={raw['id']}")
                return True
            try:
                data = resp.json()
            except ValueError:
                return True
            if data.get("ok") != 1:
                return True
            long_text = (data.get("data") or {}).get("longTextContent")
            if long_text:
                text = _strip_html(long_text)
                try:
                    body = json.loads(item.get("body_json") or "{}")
                except (json.JSONDecodeError, TypeError):
                    body = {}
                body["text"] = text
                item["body_json"] = json.dumps(body, ensure_ascii=False)
                item["summary"] = text[:200]
        return True


fetcher = WeiboPlatform()