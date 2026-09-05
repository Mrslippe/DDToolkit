import httpx
import json
import logging
import urllib.parse
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Optional, Dict, Any
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_result, retry_if_exception

from app.services import wbi
from app.services.auth import auth_manager


logger = logging.getLogger(__name__)

# 风控检测状态：按任务上下文隔离（ContextVar）。
# 账号抓取与帖子抓取可能并发运行，模块级全局变量会导致跨任务污染——
# 帖子任务触发风控可能被账号抓取任务误读到并错误进入冷却。
_rate_limit_ctx: ContextVar[tuple[bool, str]] = ContextVar(
    "bili_rate_limit", default=(False, "")
)

RATE_LIMIT_CODES = {-509, -412, -799, 412}


def _detect_rate_limit(status_code: int, data: dict | None = None):
    """检测响应是否为风控/限流（写入当前任务上下文）。

    覆盖 B 站（412/-509/-412/-799）与微博 m 站（HTTP 418/429；{"ok":0,"msg":"…频繁…"}）。
    """
    if status_code in (412, 418, 429):
        _rate_limit_ctx.set((True, f"HTTP {status_code}"))
        return
    if data is None:
        return
    code = data.get("code")
    msg = str(data.get("message", ""))
    if code in RATE_LIMIT_CODES:
        _rate_limit_ctx.set((True, f"code={code}, msg={msg}"))
    elif "频繁" in msg or "请求过于" in msg:
        _rate_limit_ctx.set((True, f"msg={msg}"))
    else:
        # 微博 m 站响应无 code/message 字段：{"ok":0,"msg":"..."}
        wmsg = str(data.get("msg", ""))
        if "频繁" in wmsg or "请求过于" in wmsg:
            _rate_limit_ctx.set((True, f"msg={wmsg}"))


def was_rate_limited() -> bool:
    return _rate_limit_ctx.get()[0]


def rate_limit_info() -> str:
    return _rate_limit_ctx.get()[1]


def clear_rate_limit():
    _rate_limit_ctx.set((False, ""))


@asynccontextmanager
async def _client_ctx(client: Optional[httpx.AsyncClient] = None, timeout: float = 10.0):
    """优先复用调用方传入的 AsyncClient（连接池），未传入时自建并关闭。"""
    if client is not None:
        yield client
    else:
        async with httpx.AsyncClient(timeout=timeout) as tmp:
            yield tmp


# 辅助函数：判断结果是否为None
def is_none(result):
    return result is None


@retry(stop=stop_after_attempt(3),
       wait=wait_exponential(multiplier=1, min=2, max=10),
       retry=retry_if_result(is_none))
async def fetch_bilibili_user_info(mid: int, client: Optional[httpx.AsyncClient] = None) -> Optional[Dict[str, Any]]:

    base_params = {'mid':mid}
    signed_params = await wbi.sign_params(base_params)

    url = f"https://api.bilibili.com/x/space/wbi/acc/info?{urllib.parse.urlencode(signed_params)}"
    try:
        async with _client_ctx(client) as http:
            response = await http.get(url, headers=auth_manager.build_headers())

            # 1. HTTP 状态码检查
            if response.status_code != 200:
                _detect_rate_limit(response.status_code)
                logger.warning(f"⚠️ 状态码 {response.status_code}, mid={mid}")
                return None

            # 2. 响应体非空检查
            content = response.content
            if not content or content.strip() == b'':
                logger.warning(f"⚠️ 响应内容为空, mid={mid}")
                return None

            # 3. 尝试解析 JSON
            try:
                data = response.json()
            except (UnicodeDecodeError, ValueError) as e:
                preview = content[:200].decode('utf-8', errors='ignore')
                logger.warning(f"⚠️ JSON解析失败: {e}, 前200字符: {preview}, mid={mid}")
                return None

            # 4. 业务错误码检查
            if data.get("code") != 0:
                _detect_rate_limit(response.status_code, data)
                logger.warning(f"❌ B站错误码 {data.get('code')}, 消息: {data.get('message')}, mid={mid}")
                return None

            # 5. 数据提取
            info = data.get("data")
            if not info:
                logger.warning(f"⚠️ data 字段为空, mid={mid}")
                return None

            live_room = info.get("live_room") or {}

            return {
                "name": info.get("name"),
                "sign": info.get("sign"),
                "gender": info.get("sex"),
                "avatar": info.get("face"),
                "birthday": info.get("birthday"),
                "live_status": live_room.get("liveStatus", 0),
                "live_title": live_room.get("title"),
                "room_id": live_room.get("roomid"),
                "live_url": live_room.get("url"),
            }

    except Exception as e:
        logger.error(f"❌ 获取用户信息异常: {e}, mid={mid}")
        return None


@retry(stop=stop_after_attempt(3),
       wait=wait_exponential(multiplier=1, min=2, max=10),
       retry=retry_if_result(is_none))
async def fetch_bilibili_live_batch(mids: list[int],
                                    client: Optional[httpx.AsyncClient] = None) -> Optional[Dict[str, Any]]:
    """批量直播状态（启动链阶段 1 专用）：get_status_info_by_uids 一次最多约 100 个 uid。

    返回 {uid(str): {"live_status": int, "live_title": str|None,
                     "room_id": str|None, "live_url": str|None}}；
    风控/接口异常返回 None（调用方按自愈策略处理）。
    相比逐账号 fetch_user_info（每账号 2 请求），全量 20+ 账号仅需 1 个请求。
    """
    if not mids:
        return {}
    url = "https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids"
    params = [("uids[]", str(m)) for m in mids]
    try:
        async with _client_ctx(client) as http:
            response = await http.get(url, params=params, headers=auth_manager.build_headers())
            if response.status_code != 200:
                _detect_rate_limit(response.status_code)
                logger.warning(f"⚠️ 直播批量状态码 {response.status_code}, mids={mids[:5]}...")
                return None
            try:
                data = response.json()
            except (UnicodeDecodeError, ValueError) as e:
                logger.warning(f"⚠️ 直播批量 JSON 解析失败: {e}")
                return None
            if data.get("code") != 0:
                _detect_rate_limit(response.status_code, data)
                logger.warning(f"❌ 直播批量错误码 {data.get('code')}, msg={data.get('message')}")
                return None
            payload = data.get("data") or {}
            out: Dict[str, Any] = {}
            for uid, d in payload.items():
                if not isinstance(d, dict):
                    continue
                out[str(uid)] = {
                    "live_status": d.get("live_status", 0),
                    "live_title": d.get("title"),
                    "room_id": str(d["room_id"]) if d.get("room_id") else None,
                    "live_url": d.get("url"),
                }
            return out
    except Exception as e:
        logger.error(f"❌ 获取直播批量状态异常: {e}, mids={mids[:5]}...")
        return None


@retry(stop=stop_after_attempt(3),
       wait=wait_exponential(multiplier=1, min=2, max=10),
       retry=retry_if_result(is_none))
async def fetch_bilibili_user_stat(mid: int, client: Optional[httpx.AsyncClient] = None) -> Optional[Dict[str, int]]:
    # base_params = {'vmid':mid}
    # signed_params = await wbi.sign_params(base_params)

    url = f"https://api.bilibili.com/x/relation/stat?vmid={mid}"
    try:
        async with _client_ctx(client) as http:
            response = await http.get(url, headers=auth_manager.build_headers())

            # 1. HTTP 状态码检查
            if response.status_code != 200:
                _detect_rate_limit(response.status_code)
                logger.warning(f"⚠️ 状态码 {response.status_code}, mid={mid}")
                return None

            # 2. 响应体非空检查
            content = response.content
            if not content or content.strip() == b'':
                logger.warning(f"⚠️ 响应内容为空, mid={mid}")
                return None

            # 3. 尝试解析 JSON（处理可能的非UTF-8编码）
            try:
                data = response.json()
            except UnicodeDecodeError:
                # UTF-8 解码失败，尝试 GBK
                try:
                    raw_text = content.decode('gbk')
                    data = json.loads(raw_text)
                except Exception as e:
                    logger.warning(f"⚠️ GBK 解码也失败: {e}, mid={mid}")
                    return None
            except ValueError as e:
                # JSON 格式错误
                preview = content[:200].decode('utf-8', errors='ignore')
                logger.warning(f"⚠️ JSON解析失败: {e}, 前200字符: {preview}, mid={mid}")
                return None

            # 4. 业务错误码检查
            if data.get("code") != 0:
                _detect_rate_limit(response.status_code, data)
                logger.warning(f"❌ B站错误码 {data.get('code')}, 消息: {data.get('message')}, mid={mid}")
                return None

            # 5. 数据提取
            stat = data.get("data")
            if not stat:
                logger.warning(f"⚠️ data 字段为空, mid={mid}")
                return None

            return {
                "follower": stat.get("follower", 0),
                "following": stat.get("following", 0),
            }

    except Exception as e:
        logger.error(f"❌ 获取统计数据异常: {e}, mid={mid}")
        return None


# ── 帖子抓取 ───────────────────────────────────────────────────────

VIDEO_LIST_URL = "https://api.bilibili.com/x/space/wbi/arc/search"
DYNAMIC_LIST_URL = "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space"


async def fetch_bilibili_videos(mid: int, page: int = 1, page_size: int = 30,
                                client: Optional[httpx.AsyncClient] = None) -> Optional[dict]:
    """获取某用户的视频投稿列表，返回 {"items": [{bvid, title, ...}, ...], "total": N}。
    total 为 arc/search page.count（B站侧视频总数，方案 2 完整性比对用）；
    失败返回 None（含风控，风控标志由调用方经 was_rate_limited() 判定）。"""
    base_params = {"mid": mid, "ps": page_size, "pn": page, "order": "pubdate"}
    signed_params = await wbi.sign_params(base_params)
    url = f"{VIDEO_LIST_URL}?{urllib.parse.urlencode(signed_params)}"

    try:
        async with _client_ctx(client) as http:
            resp = await http.get(url, headers=auth_manager.build_headers())
            if resp.status_code != 200:
                _detect_rate_limit(resp.status_code)
                return None
            data = resp.json()
            if data.get("code") != 0:
                _detect_rate_limit(resp.status_code, data)
                return None

            vlist = data.get("data", {}).get("list", {}).get("vlist") or []
            result = []
            for v in vlist:
                bvid = v.get("bvid", "")
                description = v.get("description", "")
                result.append({
                    "platform": "bilibili",
                    "platform_uid": str(mid),
                    "platform_post_id": bvid,
                    "type": "video",
                    "title": v.get("title", ""),
                    "summary": description[:200] if description else "",
                    "cover_url": v.get("pic", ""),
                    "permalink": f"https://www.bilibili.com/video/{bvid}" if bvid else "",
                    "body_json": _dump_json({
                        "bvid": bvid,
                        "description": description,
                        "duration": v.get("length", ""),
                        "badge": v.get("badge", ""),
                    }),
                    "stats_json": _dump_json({"view": v.get("play", 0), "comment": v.get("comment", 0)}),
                    "published_at": _ts_to_datetime(v.get("created")),
                    "raw_json": _dump_json(v),
                })
            return {
                "items": result,
                "total": (data.get("data", {}).get("page") or {}).get("count") or 0,
            }
    except Exception as e:
        logger.error(f"获取视频列表异常: {e}, mid={mid}")
        return None


async def fetch_bilibili_dynamics(mid: int, offset: str = "",
                                  client: Optional[httpx.AsyncClient] = None) -> Optional[dict]:
    """获取某用户动态，返回 {items: [...], has_more, next_offset}"""
    params = {"host_mid": mid}
    if offset:
        params["offset"] = offset
    url = f"{DYNAMIC_LIST_URL}?{urllib.parse.urlencode(params)}"

    try:
        async with _client_ctx(client) as http:
            resp = await http.get(url, headers=auth_manager.build_headers())
            if resp.status_code != 200:
                _detect_rate_limit(resp.status_code)
                return None
            data = resp.json()
            if data.get("code") != 0:
                _detect_rate_limit(resp.status_code, data)
                return None

            items = data.get("data", {}).get("items") or []
            mapped = []
            for item in items:
                # 忽略直播开播动态（DYNAMIC_TYPE_LIVE_RCMD）——瞬态噪音，非真实内容
                if _is_live_rcmd(item):
                    continue
                id_str = item.get("id_str", "")
                modules = item.get("modules") or {}
                author = modules.get("module_author") or {}
                md = modules.get("module_dynamic") or {}
                major = md.get("major") or {}
                major_type = major.get("type", "")
                major_data = _get_major_data(major)

                desc_obj = md.get("desc") or {}
                desc_text = desc_obj.get("text", "") if isinstance(desc_obj, dict) else ""
                stat = modules.get("module_stat") or {}

                # 转发动态（FORWARD）：顶层 major 为空，原文在 item["orig"] 里
                origin = _extract_origin(item) if not major else None
                if origin:
                    full_text = origin["text"] or ""
                    if desc_text:
                        full_text = (desc_text + "\n" + full_text) if full_text else desc_text
                    title = f"转发：{origin['title']}" if origin.get("title") else ""
                    cover_url = origin.get("cover_url")
                    body_json = _dump_json({"text": desc_text, "origin": origin})
                else:
                    full_text = _extract_dynamic_text(major, desc_text=desc_text)
                    title = _extract_dynamic_title(major)
                    if "ARCHIVE" in major_type:
                        # 投稿动态（video_dynamic）：文字内容 = 动态附言（desc.text），
                        # 视频信息仍在 extras（bvid/description/duration/badge）
                        full_text = desc_text or ""
                        title = _archive_dynamic_title(full_text, major)
                    cover_url = _extract_dynamic_cover(major)
                    body_json = _dump_json({
                        "text": full_text,
                        **_extract_body_extras(major),
                    })

                # 直播预约卡片（module_dynamic.additional.reserve）
                reserve = _extract_reservation(md)
                if reserve:
                    parsed = _safe_json_parse(body_json) if isinstance(body_json, str) else body_json
                    parsed["reservation"] = reserve
                    body_json = _dump_json(parsed)

                mapped.append({
                    "platform": "bilibili",
                    "platform_uid": str(mid),
                    "platform_post_id": id_str,
                    "type": _map_dynamic_type(item.get("type", ""), major_type),
                    "title": title,
                    "summary": full_text[:200] if full_text else "",
                    "cover_url": cover_url,
                    "permalink": _dynamic_url(id_str, major_type, major_data),
                    "body_json": body_json,
                    "stats_json": _dump_json(
                        _archive_stats(major, stat) if "ARCHIVE" in major_type
                        else {
                            "forward": stat.get("forward", {}).get("count", 0),
                            "like": stat.get("like", {}).get("count", 0),
                            "comment": stat.get("comment", {}).get("count", 0),
                        }
                    ),
                    "published_at": _parse_dynamic_pub_time(author),
                    "raw_json": _dump_json(item),
                })

            return {
                "items": mapped,
                "has_more": data.get("data", {}).get("has_more", False),
                "next_offset": data.get("data", {}).get("offset", ""),
            }
    except Exception as e:
        logger.error(f"获取动态列表异常: {e}, mid={mid}")
        return None


# ── 详情 API ───────────────────────────────────────────────────────


async def fetch_article_detail(cv_id: int, client: Optional[httpx.AsyncClient] = None) -> Optional[dict]:
    """获取专栏全文"""
    url = f"https://api.bilibili.com/x/article/view?id={cv_id}"
    try:
        async with _client_ctx(client) as http:
            resp = await http.get(url, headers=auth_manager.build_headers())
            if resp.status_code != 200:
                return None
            data = resp.json()
            if data.get("code") != 0:
                return None
            d = data["data"]
            content = d.get("content", "")
            # 修复：部分专栏的 content 是 Quill Delta JSON（{"ops":[...]}）而非 HTML。
            # 前端据此渲染富文本；同时产出纯文本供列表摘要使用。
            delta = content if _is_delta_content(content) else None
            return {
                "content": content,
                "delta": delta,
                "delta_text": _delta_to_plain_text(delta) if delta else "",
                "summary": d.get("summary", ""),
                "stats": d.get("stats", {}),
                "image_urls": d.get("image_urls", []),
                "author_name": d.get("author_name", ""),
                "publish_time": _ts_to_datetime(d.get("publish_time")),
            }
    except Exception as e:
        logger.error(f"获取专栏详情异常: {e}, cv={cv_id}")
        return None


async def fetch_video_detail(bvid: str, client: Optional[httpx.AsyncClient] = None) -> Optional[dict]:
    """获取视频完整信息（完整简介、标签、分P）"""
    base_params = {"bvid": bvid}
    signed_params = await wbi.sign_params(base_params)
    url = f"https://api.bilibili.com/x/web-interface/view?{urllib.parse.urlencode(signed_params)}"
    try:
        async with _client_ctx(client) as http:
            resp = await http.get(url, headers=auth_manager.build_headers())
            if resp.status_code != 200:
                return None
            data = resp.json()
            if data.get("code") != 0:
                return None
            d = data["data"]
            owner = d.get("owner") or {}
            return {
                "desc": d.get("desc", ""),               # 完整简介
                "duration": d.get("duration", 0),        # 秒数
                "owner_name": owner.get("name", ""),
                "tname": d.get("tname", ""),             # 分区名
                "pages": d.get("pages", []),             # 分P列表
                "pubdate": _ts_to_datetime(d.get("pubdate")),
                "ctime": _ts_to_datetime(d.get("ctime")),
                "stat": {
                    "view": d.get("stat", {}).get("view", 0),
                    "like": d.get("stat", {}).get("like", 0),
                    "coin": d.get("stat", {}).get("coin", 0),
                    "favorite": d.get("stat", {}).get("favorite", 0),
                    "comment": d.get("stat", {}).get("reply", 0),  # 归一化键名（devlog/018）
                    "share": d.get("stat", {}).get("share", 0),
                    "danmaku": d.get("stat", {}).get("danmaku", 0),
                },
            }
    except Exception as e:
        logger.error(f"获取视频详情异常: {e}, bvid={bvid}")
        return None


DYNAMIC_DETAIL_URL = "https://api.bilibili.com/x/polymer/web-dynamic/v1/detail"
DYNAMIC_DETAIL_FEATURES = (
    "itemOpusStyle,opusBigCover,onlyfansVote,endFooterHidden,"
    "decorationCard,onlyfansAssetsV2,ugcDelete,onlyfansQaCard,commentsNewVersion"
)


async def fetch_dynamic_detail(dynamic_id: str, client: Optional[httpx.AsyncClient] = None) -> Optional[dict]:
    """获取单条动态的完整详情（OPUS 格式，比 feed 更完整）"""
    url = f"{DYNAMIC_DETAIL_URL}?id={dynamic_id}&features={DYNAMIC_DETAIL_FEATURES}"
    try:
        async with _client_ctx(client) as http:
            resp = await http.get(url, headers=auth_manager.build_headers())
            if resp.status_code != 200:
                _detect_rate_limit(resp.status_code)
                return None
            data = resp.json()
            if data.get("code") != 0:
                _detect_rate_limit(resp.status_code, data)
                logger.warning(f"动态详情API错误 code={data.get('code')}, msg={data.get('message')}, id={dynamic_id}")
                return None

            item = data.get("data", {}).get("item") or {}
            if not item:
                logger.warning(f"动态详情API返回空 item, id={dynamic_id}")
                return None

            modules = item.get("modules") or {}
            author = modules.get("module_author") or {}
            md = modules.get("module_dynamic") or {}
            major = md.get("major") or {}
            major_type = major.get("type", "")
            major_data = _get_major_data(major)
            desc_obj = md.get("desc") or {}
            desc_text = desc_obj.get("text", "") if isinstance(desc_obj, dict) else ""
            full_text = _extract_dynamic_text(major, desc_text=desc_text)
            stat = modules.get("module_stat") or {}

            logger.debug(f"动态详情 id={dynamic_id} major.type={major_type}, full_text前80={full_text[:80] if full_text else '(空)'}, "
                         f"type={_map_dynamic_type(item.get('type', ''), major_type)}")

            # 转发动态（FORWARD）：顶层 major 为空，原文在 item["orig"] 里
            origin = _extract_origin(item) if not major else None
            if origin:
                full_text = origin["text"] or ""
                if desc_text:
                    full_text = (desc_text + "\n" + full_text) if full_text else desc_text
                title = f"转发：{origin['title']}" if origin.get("title") else ""
                cover_url = origin.get("cover_url")
                body_json = _dump_json({"text": desc_text, "origin": origin})
            else:
                full_text = _extract_dynamic_text(major, desc_text=desc_text)
                title = _extract_dynamic_title(major)
                if "ARCHIVE" in major_type:
                    # 投稿动态（video_dynamic）：文字内容 = 动态附言（desc.text）
                    full_text = desc_text or ""
                    title = _archive_dynamic_title(full_text, major)
                cover_url = _extract_dynamic_cover(major)
                body_json = _dump_json({
                    "text": full_text,
                    **_extract_body_extras(major),
                })

            # 直播预约卡片（module_dynamic.additional.reserve）
            reserve = _extract_reservation(md)
            if reserve:
                parsed = _safe_json_parse(body_json, {})
                parsed["reservation"] = reserve
                body_json = _dump_json(parsed)

            return {
                "platform": "bilibili",
                "platform_uid": str(author.get("mid", "")),
                "platform_post_id": item.get("id_str", dynamic_id),
                "type": _map_dynamic_type(item.get("type", ""), major_type),
                "title": title,
                "summary": full_text[:200] if full_text else "",
                "cover_url": cover_url,
                "permalink": _dynamic_url(item.get("id_str", ""), major_type, major_data),
                "body_json": body_json,
                "stats_json": _dump_json({
                    "forward": stat.get("forward", {}).get("count", 0),
                    "like": stat.get("like", {}).get("count", 0),
                    "comment": stat.get("comment", {}).get("count", 0),
                }),
                "published_at": _parse_dynamic_pub_time(author),
                "raw_json": _dump_json(item),
            }
    except Exception as e:
        logger.error(f"获取动态详情异常: {e}, id={dynamic_id}")
        return None


# ── 辅助 ───────────────────────────────────────────────────────────

def _ts_to_datetime(ts: int | None):
    if not ts:
        return None
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ts, tz=timezone.utc)


def _parse_pub_time(s: str | int | None):
    """解析 '2024-01-01 12:00:00' 或时间戳(字符串/整数)，返回 datetime 对象"""
    if not s:
        return None
    # 整数时间戳（秒级 / 毫秒级）
    if isinstance(s, int):
        ts = s / 1000 if s > 1e12 else s
        return _ts_to_datetime(int(ts))
    # 字符串
    if s.isdigit():
        ts = int(s)
        ts = ts / 1000 if ts > 1e12 else ts
        return _ts_to_datetime(int(ts))
    try:
        from datetime import datetime, timezone
        # 修复：动态的 pub_time 常为 '2025年04月21日' / '08月09日' 等中文格式
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S",
                    "%Y年%m月%d日 %H:%M", "%Y年%m月%d日"):
            try:
                return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
            except ValueError:
                continue
    except Exception:
        pass
    return None


def _parse_dynamic_pub_time(author: dict):
    """动态发布时间：优先 module_author.pub_ts（unix 时间戳，最可靠），
    其次 pub_time 字符串（'2025年04月21日' / '08月09日' 等，年缺失时可能失败）。
    修复：此前只解析 pub_time 导致大量帖子无发布时间。"""
    pub_ts = author.get("pub_ts")
    if pub_ts not in (None, ""):
        try:
            parsed = _parse_pub_time(pub_ts)
            if parsed:
                return parsed
        except Exception:
            pass
    return _parse_pub_time(author.get("pub_time", ""))


def _is_live_rcmd(item: dict) -> bool:
    """直播开播动态判断：raw type 为 DYNAMIC_TYPE_LIVE_RCMD 或 major 含 LIVE_RCMD。
    这类动态是 B 站自动生成的开播提醒（major.live_rcmd），瞬态无内容价值，直接忽略。"""
    raw_type = str(item.get("type", ""))
    if "LIVE" in raw_type:
        return True
    md = (item.get("modules") or {}).get("module_dynamic") or {}
    major_type = str((md.get("major") or {}).get("type", ""))
    return "LIVE" in major_type


def _extract_origin(item: dict) -> dict | None:
    """转发动态（FORWARD）的原文提取：顶层 major 为空，原文在 item['orig'] 里。
    返回 {type, title, text, images, cover_url, permalink} 或 None"""
    orig = item.get("orig")
    if not isinstance(orig, dict):
        return None
    o_md = (orig.get("modules") or {}).get("module_dynamic") or {}
    o_major = o_md.get("major") or {}
    if not o_major:
        return None
    o_major_type = o_major.get("type", "")
    return {
        "type": _map_dynamic_type(orig.get("type", ""), o_major_type),
        "title": _extract_dynamic_title(o_major),
        "text": _extract_dynamic_text(o_major) or "",
        "images": _extract_body_extras(o_major).get("images", []),
        "cover_url": _extract_dynamic_cover(o_major),
        "permalink": _dynamic_url(orig.get("id_str", ""), o_major_type, _get_major_data(o_major)),
    }


def _extract_reservation(md: dict) -> dict | None:
    """直播预约卡片：module_dynamic.additional.reserve → 精简结构。
    status: 0=未预约(可预约) 1=已结束 2=已预约"""
    additional = md.get("additional") or {}
    reserve = additional.get("reserve")
    if not isinstance(reserve, dict):
        return None
    status = reserve.get("status")
    button = reserve.get("button") or {}
    check = button.get("check") or {}
    uncheck = button.get("uncheck") or {}
    text = check.get("text") if status == 2 else uncheck.get("text")
    desc1 = reserve.get("desc1") or {}
    desc2 = reserve.get("desc2") or {}
    return {
        "status": status,
        "button_text": text or "",
        "button_status": button.get("status"),
        "button_type": button.get("type"),
        "desc1": desc1.get("text", "") if isinstance(desc1, dict) else desc1,
        "desc2": desc2.get("text", "") if isinstance(desc2, dict) else desc2,
        "reserve_total": reserve.get("reserve_total", 0),
    }


def _is_delta_content(content: str) -> bool:
    """B 站富文本（Quill Delta）格式判断：以 {"ops" 开头的 JSON 字符串"""
    return isinstance(content, str) and content.lstrip().startswith('{"ops"')


def _delta_to_plain_text(delta: str) -> str:
    """Delta JSON → 纯文本（拼接所有 insert，供列表摘要使用）"""
    data = _safe_json_parse(delta, {})
    parts = []
    for op in data.get("ops") or []:
        ins = op.get("insert")
        if isinstance(ins, str):
            parts.append(ins)
    return "".join(parts)


def _dump_json(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


def _safe_json_parse(s: str | None, default=None):
    """安全解析 JSON 字符串，失败返回 default"""
    if not s:
        return default
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return default


def _get_major_data(major: dict) -> dict:
    """根据 major.type 提取对应的数据块"""
    mt = major.get("type", "")
    # MAJOR_TYPE_OPUS — 纯文/图文
    if "OPUS" in mt:
        return major.get("opus") or {}
    # MAJOR_TYPE_DRAW — 多图
    if "DRAW" in mt:
        return major.get("draw") or {}
    # MAJOR_TYPE_ARTICLE — 专栏
    if "ARTICLE" in mt:
        return major.get("article") or {}
    # MAJOR_TYPE_ARCHIVE — 视频分享
    if "ARCHIVE" in mt:
        return major.get("archive") or {}
    # MAJOR_TYPE_LIVE_RCMD — 直播推荐
    if "LIVE" in mt:
        return major.get("live_rcmd") or {}
    # MAJOR_TYPE_COMMON / 转发 — 递归内层
    if "COMMON" in mt and major.get("common"):
        inner = major["common"]
        return _get_major_data(inner)
    return {}


def _map_dynamic_type(raw: str, major_type: str = "") -> str:
    DYNAMIC = {
        "DYNAMIC_TYPE_WORD": "text",
        # 修复：视频投稿（arc/search）与附带视频的投稿动态（feed）区分开：
        # 后者用 video_dynamic（有自己的文字内容，标题规则不同）
        "DYNAMIC_TYPE_AV": "video_dynamic",
        "DYNAMIC_TYPE_DRAW": "image",
        "DYNAMIC_TYPE_ARTICLE": "article",
        "DYNAMIC_TYPE_FORWARD": "repost",
        "DYNAMIC_TYPE_LIVE_RCMD": "live",
        # 修复：此前未覆盖音乐动态，原始枚举名会经 raw.lower() 泄漏进 type 字段
        "DYNAMIC_TYPE_MUSIC": "music",
    }
    # dynamic type 优先，没识别到的用 major type 反推
    mapped = DYNAMIC.get(raw)
    if mapped:
        return mapped
    if "ARCHIVE" in major_type:
        return "video_dynamic"
    if "MUSIC" in major_type:
        return "music"
    if "COMMON" in major_type:
        return "repost"
    return raw.lower() if raw else "unknown"


def _archive_dynamic_title(text: str, major: dict) -> str:
    """投稿动态（video_dynamic）标题规则：
    有文字内容（动态附言）→ 取前 20 字；否则用视频标题。"""
    if text and text.strip():
        return text.strip()[:20]
    return _extract_dynamic_title(major)


def _normalize_stats(stats: dict) -> dict:
    """统计键名归一化（devlog/018）：
    play → view（视频投稿列表）、reply → comment（视频详情）"""
    out = dict(stats)
    if "play" in out and "view" not in out:
        out["view"] = out.pop("play")
    if "reply" in out and "comment" not in out:
        out["comment"] = out.pop("reply")
    return out


def _archive_stats(major: dict, dyn_stat: dict) -> dict:
    """投稿动态（video_dynamic）完整统计：
    视频统计（major.archive.stat）+ 动态自身互动（module_stat，forward/dyn_like/dyn_comment）。
    修复：此前只存 module_stat 的 forward/like/comment，播放/投币/收藏/分享/弹幕缺失。"""
    vstat = (major.get("archive") or {}).get("stat") or {}
    return {
        "view": vstat.get("view", 0),
        "like": vstat.get("like", 0),
        "coin": vstat.get("coin", 0),
        "favorite": vstat.get("favorite", 0),
        "comment": vstat.get("reply", 0),
        "share": vstat.get("share", 0),
        "danmaku": vstat.get("danmaku", 0),
        "forward": (dyn_stat.get("forward") or {}).get("count", 0),
        "dyn_like": (dyn_stat.get("like") or {}).get("count", 0),
        "dyn_comment": (dyn_stat.get("comment") or {}).get("count", 0),
    }


def _extract_dynamic_title(major: dict) -> str:
    """按 major type 提取标题"""
    data = _get_major_data(major)
    mt = major.get("type", "")
    # OPUS — 可能有 title
    t = data.get("title", "")
    if t:
        return str(t)[:500]
    # DRAW
    t = data.get("title", "")
    if t:
        return str(t)[:500]
    # ARTICLE — id 就是专栏 cv 号
    aid = data.get("id")
    if aid:
        return f"cv{aid}"
    # 无标题时返回空
    return ""


def _extract_dynamic_text(major: dict, desc_text: str = "") -> str:
    """按 major type 提取正文。desc_text 为转发者的附言（module_dynamic.desc.text）"""
    mt = major.get("type", "")
    data = _get_major_data(major)

    # OPUS — summary.text
    if "OPUS" in mt:
        summary = data.get("summary") or {}
        text = summary.get("text", "")
        return str(text)[:2000] if text else ""

    # DRAW — title + items 数量
    if "DRAW" in mt:
        title = data.get("title", "")
        items = data.get("items") or []
        return f"{title} [{len(items)}P]" if title else f"[{len(items)}P]"

    # ARTICLE — summary
    if "ARTICLE" in mt:
        summary = data.get("summary") or ""
        return str(summary)[:2000]

    # ARCHIVE — desc
    if "ARCHIVE" in mt:
        return str(data.get("desc", ""))[:2000]

    # LIVE — content
    if "LIVE" in mt or "_RCMD" in mt:
        return str(data.get("content", ""))[:2000]

    # COMMON / 转发 — 转发者的附言在 module_dynamic.desc
    if "COMMON" in mt:
        return str(desc_text)[:2000] if desc_text else ""

    return ""


def _extract_body_extras(major: dict) -> dict:
    """提取 body_json 中 text 之外的类型差异字段"""
    mt = major.get("type", "")
    data = _get_major_data(major)

    if "OPUS" in mt:
        pics = data.get("pics") or []
        if pics:
            return {"images": [{"url": p["url"], "width": p.get("width"), "height": p.get("height")} for p in pics]}
        return {}

    if "DRAW" in mt:
        items = data.get("items") or []
        return {"images": [{"url": i["src"], "width": i.get("width"), "height": i.get("height")} for i in items]}

    if "ARCHIVE" in mt:
        return {
            "bvid": data.get("bvid", ""),
            "description": data.get("desc", ""),
            "duration": data.get("duration_text", ""),
            "badge": (data.get("badge") or {}).get("text", ""),
        }

    if "ARTICLE" in mt:
        return {"cv_id": data.get("id")}

    if "LIVE" in mt:
        return {
            "room_id": str(data.get("id", "")),
            "live_status": data.get("live_state", 0),
        }

    if "_RCMD" in mt:
        return {}

    if "COMMON" in mt and major.get("common"):
        inner = major["common"]
        inner_data = _get_major_data(inner)
        inner_mt = inner.get("type", "")
        return {
            "origin": {
                "type": _map_dynamic_type("", inner_mt),
                "title": _extract_dynamic_title(inner),
                "text": _extract_dynamic_text(inner),
                "body": _extract_body_extras(inner),
                "cover_url": _extract_dynamic_cover(inner),
                "permalink": _dynamic_url("", inner_mt, inner_data),
            },
        }

    return {}


def _extract_dynamic_cover(major: dict) -> str | None:
    """按 major type 提取封面图 URL"""
    mt = major.get("type", "")
    data = _get_major_data(major)

    # OPUS — pics[0].url
    if "OPUS" in mt:
        pics = data.get("pics") or []
        return pics[0].get("url") if pics else None

    # DRAW — items[0].src
    if "DRAW" in mt:
        items = data.get("items") or []
        return items[0].get("src") if items else None

    # ARTICLE — covers[0]
    if "ARTICLE" in mt:
        covers = data.get("covers") or []
        return covers[0] if covers else None

    # ARCHIVE — cover
    if "ARCHIVE" in mt:
        return data.get("cover")

    # COMMON — 递归内层
    if "COMMON" in mt and major.get("common"):
        return _extract_dynamic_cover(major["common"])

    return None


def _dynamic_url(id_str: str, major_type: str, data: dict) -> str:
    """根据内容类型生成正确链接"""
    # 视频分享 → 视频链接
    if "ARCHIVE" in major_type:
        bvid = data.get("bvid", "")
        if bvid:
            return f"https://www.bilibili.com/video/{bvid}"
    # 专栏
    if "ARTICLE" in major_type:
        aid = data.get("id", "")
        if aid:
            return f"https://www.bilibili.com/read/cv{aid}"
    # 其余 → 动态链接
    return f"https://t.bilibili.com/{id_str}" if id_str else ""