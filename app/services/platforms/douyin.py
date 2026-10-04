"""抖音平台适配（第 4 阶段 ④ 第二刀，devlog/334；依据 D1 spike，`devlog/333`）。

依据：`docs/design/xhs-douyin-research.md` §3 + `docs/plans/douyin-execution.md`。

## ⚠️ 先读这一节：抖音的失败**不是** 403（D1 真机实测，devlog/333）

| 真机形态 | 含义 |
|---|---|
| **HTTP 200 + 0 字节空体** | **签名无效或被拒**（游客身份下 `a_bogus` 缺失或值写错都是这个）|
| HTTP 200 + `status_code: 0` + `aweme_list: []` | 这个号**确实没有作品**（合法）|
| HTTP 200 + `aweme_detail: null` | 帖子没了/不存在 ⇒ `not_found` ⇒ **业务失败**（**不许**冷却身份）|
| HTTP 200 + 风控码 / `verify_center_decision_conf` / 验证页 | 风控 ⇒ 扣身份健康度 |
| 461 / 471 / `Verifytype` 头 | **验证码挑战** ⇒ `captcha`：立即停（本方案不绕验证码）|

⇒ 三条铁律写进本文件：
① `ok` 必须是"`status_code=0` **且**该有的结构在"；② 空体**不许**当成"这个 V 没作品"；
③ 业务失败**不许**冷却身份（`identity_limit` 的四分类把这两条分开管）。

## 另一条真机口径：登录态**不校验签名**，但代码不许依赖它

相位 1（登录 jar，61 个 cookie）删 `a_bogus`/删 secsdk/删 `x-tt-argus`/换 `verifyFp` 四例全 200 且
载荷逐条相同；相位 2/3（游客 jar）才开始拦。**宽松是平台当下的选择、不是契约** ⇒ 我们**每次都签**，
且**绝不**做"签名失败就跳过"的静默降级（签名不过 ⇒ `SignerUnavailable`，一个字节都不发）。

## 身份两段式（`unique_id` vs `sec_user_id`）

- `sec_user_id`（`MS4wLjABAAAA…`，跟号走、不轮换）= 我们的 uid：`/user/profile/other/` 一条就够；
- **抖音号（`unique_id`）需要搜索接口**（调研 §3：要登录、要签名）—— **本刀未接入**：
  认不出输入形态时**响亮失败**（`unsupported_input` + 一句能照做的提示），不猜、不静默播别人的号。

## 翻页与限速

cursor 是抖音的 `max_cursor`（**毫秒时间戳**，对核心**不透明**：原样带回去）；`has_more` 是整数
`1/0`（不是布尔）。身份级限速复用 `identity_limit`（粒度 **(身份, 端点)**）；
⚠️ 端点名是**全局**键（见 `identity_limit.ENDPOINT_RATE` 的警告）⇒ 这里用带平台特征的
`aweme_posts` / `user_profile` / `aweme_detail`，别再撞上 B 站的 `detail`。

## 媒体地址会过期（D3 固化时要注意）

图/视频 URL 都带签名参数（`p*-pc-sign.douyinpic.com`、`v*-web.douyinvod.com`），
**不保证长期可用** ⇒ 入库后要尽快固化（`media_pin`），与小红书同一类问题。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.core.config import settings
from app.services import identity_limit
from app.services.platforms.base import BasePlatform
from app.services.platforms.signing import DouyinSigner, SignerUnavailable

logger = logging.getLogger(__name__)

BASE = "https://www.douyin.com"
PATH_POSTS = "/aweme/v1/web/aweme/post/"
PATH_DETAIL = "/aweme/v1/web/aweme/detail/"
PATH_PROFILE = "/aweme/v1/web/user/profile/other/"

#: 端点名（**全局**键，见 `identity_limit.ENDPOINT_RATE` 的警告：不能与别家重名）
ENDPOINT_POSTS = "aweme_posts"
ENDPOINT_PROFILE = "user_profile"
ENDPOINT_DETAIL = "aweme_detail"

AID = "6383"
CHANNEL = "channel_pc_web"
#: 线上**网页版自己发的**版本号（D1 抓包实测 2026-10-04；DTK 的常量 290100/29.1.0 反而超前）
VERSION_CODE = "170400"
VERSION_NAME = "17.4.0"
UPDATE_VERSION_CODE = "170400"
PAGE_SIZE = 20                      # 抖音对更大的 count 会静默截断

#: 身份维度的指纹参数（D1 抓包实测值）。它们只需要**自洽**（与 UA、与 a_bogus 里的几何一致），
#: 平台无法从 cookie 反查屏幕/核数 ⇒ 常量即可；但别乱填，那会让"这份身份"自相矛盾。
SCREEN_WIDTH = "1920"
SCREEN_HEIGHT = "1080"
CPU_CORE_NUM = "12"
DEVICE_MEMORY = "16"
BROWSER_LANGUAGE = "zh-CN"

#: 风控状态码（DTK 的起点清单，**未逐条真机确认** —— 认不出的按 `identity_limit.classify` 兜底）
RISK_STATUS_CODES = frozenset({8, 2154, 2156, 10000, 10001})
#: 未登录/登录态失效
NOT_LOGIN_STATUS = 2483

SEC_UID_PREFIX = "MS4wLjABAAAA"

#: UA → 查询里那几个"浏览器自报"字段。**必须从 UA 推**：查询说 Chrome 146 而头里写着 Edge 154
#: 是白送的破绽（`signing.py` 的抖音真机口径表）。顺序也照抖音自己的检测器：Edge UA 同时带
#: `Chrome/` 与 `Edg/`，先认 `Edg`。
_BROWSERS = (("Edg", "Edge"), ("Chrome", "Chrome"), ("Firefox", "Firefox"), ("Safari", "Safari"))
_ENGINES = {"Edge": "Blink", "Chrome": "Blink", "Firefox": "Gecko", "Safari": "WebKit"}
_OS_TABLE = (("Windows NT 10.0|Windows 10.0", "Windows", "10"),
             ("Windows NT 6.3", "Windows", "8.1"),
             ("Windows NT 6.1", "Windows", "7"),
             ("Android", "Android", ""),
             ("iPhone|iPad|iPod", "iOS", ""),
             ("Mac OS X", "Mac OS X", ""),
             ("Linux|X11", "Linux", ""))
_OS_PLATFORM = {"Windows": "Win32", "Mac OS X": "MacIntel", "Linux": "Linux x86_64"}


def browser_facts(user_agent: str) -> dict[str, str]:
    """从 UA 摘出 `browser_name` / `browser_version` / `engine_*` / `os_*` / `browser_platform`。

    摘不出来就返回空串（调用方按本机默认兜底）—— 但"默认"与 UA 一定不一致，
    所以那只是**不崩**的兜底，不是正确值。
    """
    name = version = ""
    for token, label in _BROWSERS:
        found = re.search(rf"{token}/([\d.]+)", user_agent or "")
        if found:
            name, version = label, found.group(1)
            break
    os_name = os_version = ""
    for pattern, label, fixed in _OS_TABLE:
        if re.search(pattern, user_agent or ""):
            os_name, os_version = label, fixed
            if not fixed:
                found = re.search(r"(?:Mac OS X|Android|OS) (\d+(?:[._]\d+)*)", user_agent or "")
                os_version = found.group(1).replace("_", ".") if found else ""
            break
    return {
        "browser_name": name,
        "browser_version": version,
        "engine_name": _ENGINES.get(name, ""),
        "engine_version": version,
        "os_name": os_name,
        "os_version": os_version,
        "browser_platform": _OS_PLATFORM.get(os_name, "Win32"),
    }


# ── 输入解析 ──────────────────────────────────────────────────────────

def sec_uid_from_input(raw: str) -> str:
    """从"用户粘进来的东西"里取出 `sec_user_id`（主页链接 / 分享文本 / 裸 sec_uid）。

    认不出返回**空串**（调用方据此响亮失败）—— 抖音号（`unique_id`）要搜索接口才能解析，
    本刀没接（见模块头），所以这里**不猜**。
    """
    s = (raw or "").strip()
    if not s:
        return ""
    for token in (s.replace("\n", " ").split() + [s]):
        marker = token.find(SEC_UID_PREFIX)
        if marker < 0:
            continue
        out = []
        for ch in token[marker:]:
            if ch.isalnum() or ch in "-_":
                out.append(ch)
            else:
                break
        if len(out) > len(SEC_UID_PREFIX) + 8:
            return "".join(out)
    return ""


# ── 响应分类（诊断口径；策略口径是 identity_limit 的四类）──────────────

def _captcha_evidence(status: int, headers: Optional[dict], payload: Any) -> bool:
    if status in (461, 471):
        return True
    if any(k.lower() == "verifytype" for k in (headers or {})):
        return True
    if isinstance(payload, dict):
        # ⚠️ 三种字段的口径**不一样**，别图省事写成一句 `or`：
        # - `verify_center_decision_conf`：**键在**就算（它的值是个对象，正常响应里根本不该出现；
        #   用真值判断会漏掉空对象 —— DTK 那边就是这么写的，这里刻意不跟）；
        # - `captcha` / `verify_page`：按**真值**判（正常响应可能带 `false`，按键在判会把每一发
        #   都当成验证码 —— 那比漏判更糟：抓取会**整轮停摆**）。
        if payload.get("verify_center_decision_conf") is not None:
            return True
        if payload.get("captcha") or payload.get("verify_page"):
            return True
    return False


def classify_payload(payload: Any, *, body_len: int, expect: str) -> str:
    """一次 **HTTP 200** 响应的诊断分类。`expect` ∈ `list` / `detail` / `user`。

    ⚠️ 顺序有讲究：**先验证码、再空体、再风控码、最后才看业务结构** ——
    把"空体"排在最前面（而不是当成"没有数据"）正是 D1 换来的那条口径。
    """
    if _captcha_evidence(200, None, payload):
        # 验证码可能以**响应体字段**出现（`verify_center_decision_conf` 之类），
        # 状态码仍是 200 ⇒ 这一条必须在这里判，不能只在 `classify_http` 里判
        return "captcha"
    if body_len == 0:
        # D1 实测：签名无效/被拒就是这个形态（`logid` 照发）—— 不是 403
        return "signature_invalid"
    if not isinstance(payload, dict):
        # 200 但不是 JSON：网关插页/HTML 挑战页。归"我们这侧坏了"，不当业务失败
        return "signature_invalid"
    code = payload.get("status_code")
    if isinstance(code, str) and code.strip().isdigit():
        code = int(code)
    if code in RISK_STATUS_CODES:
        return "risk_control"
    if code == NOT_LOGIN_STATUS:
        return "cookie_invalid"
    if code not in (0, None):
        return "business_error"
    if expect == "list":
        # 空 `aweme_list` 是合法的（这个号确实没作品）；**键都不在**才是怪事
        return "ok" if "aweme_list" in payload else "signature_invalid"
    if expect == "detail":
        # ⚠️ 与 DTK 分道扬镳的一处（见模块头）：`status_code=0` + 空 `aweme_detail`
        #    我们判 `not_found`（业务失败，**不**冷却身份），DTK 判风控。
        #    理由：用户看到的是"这帖没了"，而身份冷却的代价是"整轮抓取停摆"。
        return "ok" if payload.get("aweme_detail") else "not_found"
    if expect == "user":
        return "ok" if payload.get("user") else "not_found"
    return "ok"


def classify_http(status: int, *, headers: Optional[dict] = None, payload: Any = None,
                  body_len: int = 0, body_head: str = "", expect: str = "list") -> str:
    """一次响应的诊断分类（`ok` / `business_error` / `not_found` / `risk_control` /
    `captcha` / `cookie_invalid` / `signature_invalid` / `argus_missing` / `server_error`）。"""
    if _captcha_evidence(status, headers, payload):
        return "captcha"
    if status == 200:
        return classify_payload(payload, body_len=body_len, expect=expect)
    text = f"{body_head} {payload if isinstance(payload, dict) else ''}".lower()
    if status == 403:
        # 调研 §3.6 的 403 根因（本网关 2026-10-04 没复现，但码表留着：出现了才认得出来）
        if "uifid" in text or "argus" in text:
            return "argus_missing"
        if "sign invalid" in text or "signature not found" in text or "sign" in text:
            return "signature_invalid"
    return identity_limit.classify(status, code=(payload or {}).get("status_code")
                                   if isinstance(payload, dict) else None, msg=body_head[:200])


# ── 字段映射（照真机回包与 DTK 的归一化契约写）──────────────────────────

def _epoch_to_utc(seconds: Any) -> Optional[datetime]:
    """`create_time` 是**秒**级时间戳（D1 实测 `1791110151`）→ naive UTC（落库口径）。"""
    try:
        return datetime.fromtimestamp(int(seconds), tz=timezone.utc).replace(tzinfo=None)
    except (TypeError, ValueError, OSError):
        return None


def _int_or_none(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _first_url(*nodes: Any) -> Optional[str]:
    """从 `{"url_list": [...]}` 形状里取第一条 URL（抖音所有图/视频地址都是这个形状）。"""
    for node in nodes:
        if isinstance(node, dict):
            for url in node.get("url_list") or []:
                if isinstance(url, str) and url:
                    return url
    return None


def _images(aweme: dict) -> list[dict]:
    """图文帖的图片（`images[]`，每项一个 `url_list`）；视频帖为空列表。"""
    out: list[dict] = []
    for image in aweme.get("images") or []:
        if not isinstance(image, dict):
            continue
        url = _first_url(image) or _first_url(image.get("display_image"))
        if url:
            out.append({"url": url, "width": image.get("width"), "height": image.get("height")})
    return out


def _cover_url(aweme: dict) -> Optional[str]:
    video = aweme.get("video") if isinstance(aweme.get("video"), dict) else {}
    return _first_url(video.get("origin_cover"), video.get("cover"), video.get("dynamic_cover"))


def _video_url(aweme: dict) -> Optional[str]:
    video = aweme.get("video") if isinstance(aweme.get("video"), dict) else {}
    return _first_url(video.get("play_addr"))


def _video_block(aweme: dict) -> Optional[dict]:
    """`body_json.video` —— **形状与小红书一致**：`{url, fallbacks, width, height, duration_s}`。

    ⚠️ 这是**跨模块契约**，两处会读它，写错都是**静默**的（devlog/335）：

    | 读者 | 读什么 | 写错的症状 |
    |---|---|---|
    | `assets._media_urls(body_json, video=True)` | `video.url` + `fallbacks` | 抖音视频**永远不被固化**（盘上没文件，没人报错）|
    | `frontend` 的 `PostBodyJson.video` / `PostCard` | `video.fallbacks` / `duration_sec` | 播放器没有备用源、卡片上没有时长角标 |

    所以这里把 `play_addr.url_list` 整条当 fallback 链交出去（抖音给多条镜像，正好是它要的），
    并把毫秒**换算成秒**（`duration_s` 的合同单位就是秒）。
    """
    video = aweme.get("video") if isinstance(aweme.get("video"), dict) else {}
    play = video.get("play_addr") if isinstance(video.get("play_addr"), dict) else {}
    urls = [u for u in (play.get("url_list") or []) if isinstance(u, str) and u.strip()]
    duration_s = _duration_seconds(video.get("duration") or aweme.get("duration"))
    if not urls and duration_s is None:
        return None
    return {
        "url": urls[0] if urls else "",
        "fallbacks": urls[1:],
        "width": video.get("width"),
        "height": video.get("height"),
        "duration_s": duration_s,
    }


def _duration_seconds(value: Any) -> Optional[float]:
    """抖音给的是**毫秒**，合同要的是**秒**（`PostBodyJson.video.duration_s`）。"""
    ms = _int_or_none(value)
    if not ms or ms <= 0:
        return None
    return round(ms / 1000.0, 1)


def is_image_post(aweme: dict) -> bool:
    """图文帖判据：**看 `images` 在不在**，不看 `video` —— D1 实测图文帖也带 `video`
    （`duration=0`、`ratio=default`），照 `video` 判会把图文记成视频。"""
    return bool(aweme.get("images"))


def parse_user_info(payload: dict, uid: str) -> dict:
    """`/user/profile/other/` 的 `user` → 我们的账号信息结构。"""
    user = (payload or {}).get("user") or {}
    sec_uid = str(user.get("sec_uid") or uid or "")
    return {
        "name": user.get("nickname") or "",
        "sign": user.get("signature") or "",
        "avatar": _first_url(user.get("avatar_larger"), user.get("avatar_medium"),
                             user.get("avatar_300x300"), user.get("avatar_thumb")),
        "followers_count": _int_or_none(user.get("follower_count")),
        "following_count": _int_or_none(user.get("following_count")),
        "post_count": _int_or_none(user.get("aweme_count")),
        "uid": sec_uid,
        "sec_user_id": sec_uid,
        "url": f"{BASE}/user/{sec_uid}",
    }


def parse_aweme(aweme: dict, uid: str) -> dict:
    """一条 aweme → 统一 item 结构（列表与详情**同一个形状**，所以两处共用一个函数）。

    ⚠️ `platform_post_id` 全程**字符串**（19 位，超 JS 安全整数；单测盯着）。三个 json 列是
    **Text**（其它平台同样存 JSON 串）⇒ 这里必须 `json.dumps`，直接塞 dict 落库会报类型错。
    """
    aweme_id = str(aweme.get("aweme_id") or aweme.get("aweme_id_str") or "")
    stats = aweme.get("statistics") if isinstance(aweme.get("statistics"), dict) else {}
    desc = str(aweme.get("desc") or "")
    images = _images(aweme)
    video = _video_block(aweme)
    kind = "image" if is_image_post(aweme) else "video"
    # 抖音只有 `desc`：标题取**第一行**（列表里 `desc` 常常是一整段带话题的文案），摘要取全文
    title = desc.splitlines()[0].strip()[:120] if desc.strip() else None
    dumped = json.dumps(aweme, ensure_ascii=False)
    return {
        "platform": "douyin",
        "platform_uid": str(uid),
        "platform_post_id": aweme_id,           # 字符串，永不转 int
        "type": kind,
        "title": title,
        "summary": desc,
        "cover_url": _cover_url(aweme) or (images[0]["url"] if images else None),
        "permalink": f"{BASE}/{'note' if kind == 'image' else 'video'}/{aweme_id}",
        "body_json": json.dumps({"desc": desc, "images": images,
                                 # 形状见 `_video_block`（媒体固化与前端都读它）
                                 "video": video,
                                 # 卡片时长角标（`PostCard` 读顶层 `duration_sec`，**秒**）
                                 "duration_sec": (video or {}).get("duration_s"),
                                 "tags": [str(t.get("hashtag_name")) for t in
                                          (aweme.get("text_extra") or [])
                                          if isinstance(t, dict) and t.get("hashtag_name")]},
                                ensure_ascii=False),
        # ⚠️ **不写播放量**：抖音下发的是常量 0（D1 实测 `play_count: 0`），
        #    记 0 等于写下一个平台从没说过的事实（DTK 的 `_stats` 同口径）
        "stats_json": json.dumps({"digg": _int_or_none(stats.get("digg_count")),
                                  "comment": _int_or_none(stats.get("comment_count")),
                                  "share": _int_or_none(stats.get("share_count")),
                                  "collect": _int_or_none(stats.get("collect_count"))},
                                 ensure_ascii=False),
        "published_at": _epoch_to_utc(aweme.get("create_time")),
        "raw_json": dumped,
    }


def _cookies_of(cookie_header: str) -> dict[str, str]:
    """Cookie 头 → 字典（签名器要从中取 `uifid` 与 `s_v_web_id`）。"""
    out: dict[str, str] = {}
    for part in (cookie_header or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name:
            out[name] = value
    return out


def _default_ua() -> str:
    """签名/请求的默认 UA（`settings.DOUYIN_UA` 为空时）。**字面量只在 `core/useragent.py`**。"""
    from app.core.useragent import UA_EDGE

    return UA_EDGE


class DouyinPlatform(BasePlatform):
    """抖音抓取器。身份（cookie + UA）与签名器都是注入项；测试注入替身、不碰网络。"""

    platform = "douyin"

    def __init__(self, cookie: str = "", user_agent: str = "",
                 signer: Optional[DouyinSigner] = None,
                 ledger: "identity_limit.Ledger | None" = None) -> None:
        self._cookie = cookie
        #: UA 必须是**这份 cookie 的浏览器**的（a_bogus 把它算进签名）——
        #: 默认取 `settings.DOUYIN_UA`（登录时一起存下来的那份）
        self._user_agent = user_agent
        # 默认就装真签名器（小红书那次的教训：注册表单例没装签名器 ⇒ 生产里从来没签过名，
        # 见 `xiaohongshu.py::__init__` 的注释）。`DouyinSigner` 是纯 Python，不拖启动。
        self._signer = signer or DouyinSigner("")
        self._ledger = ledger if ledger is not None else identity_limit.LEDGER
        #: 最近一次失败的结构化原因（调用方/排查用；不改 `BasePlatform` 的返回形状）
        self.last_error: Optional[dict] = None
        #: 见过验证码挑战没有（调研 §5.3 的停止条件之一：**立即停**，本方案不绕验证码）
        self.captcha_seen = False

    # ── 内部工具 ───────────────────────────────────────────────────────
    def _cookie_header(self) -> str:
        return self._cookie or getattr(settings, "DOUYIN_COOKIE", "")

    def _ua(self) -> str:
        return (self._user_agent or getattr(settings, "DOUYIN_UA", "")
                or _default_ua()).strip()

    def _base_params(self) -> dict[str, str]:
        """每个抖音 web 请求都带的参数（顺序与真机抓包一致，`devlog/333` 的 `capture.txt`）。

        "浏览器自报"那几项从**当前 UA** 推（`browser_facts`）：查询与头互相矛盾是白送的破绽。
        """
        facts = browser_facts(self._ua())
        return {
            "device_platform": "webapp",
            "aid": AID,
            "channel": CHANNEL,
            "update_version_code": UPDATE_VERSION_CODE,
            "pc_client_type": "1",
            "pc_libra_divert": facts["os_name"] or "Windows",
            "support_h265": "1",
            "support_dash": "1",
            "cpu_core_num": CPU_CORE_NUM,
            "version_code": VERSION_CODE,
            "version_name": VERSION_NAME,
            "cookie_enabled": "true",
            "screen_width": SCREEN_WIDTH,
            "screen_height": SCREEN_HEIGHT,
            "browser_language": BROWSER_LANGUAGE,
            "browser_platform": facts["browser_platform"],
            "browser_name": facts["browser_name"] or "Edge",
            "browser_version": facts["browser_version"] or "154.0.0.0",
            "browser_online": "true",
            "engine_name": facts["engine_name"] or "Blink",
            "engine_version": facts["engine_version"] or "154.0.0.0",
            "os_name": facts["os_name"] or "Windows",
            "os_version": facts["os_version"] or "10",
            "device_memory": DEVICE_MEMORY,
            "platform": "PC",
            "downlink": "10",
            "effective_type": "4g",
            "round_trip_time": "0",
        }

    def _signed(self, params: dict[str, str]) -> tuple[str, dict[str, str]]:
        """身份齐了才签；签不出来 ⇒ **响亮失败**（未签名的请求一个都不许发）。"""
        cookie = self._cookie_header()
        if not cookie:
            self.last_error = {"kind": "cookie_invalid",
                               "msg": "未配置抖音 cookie（设置 → 登录 → 抖音）"}
            logger.warning("抖音未配置 cookie，本次不发请求（设置 → 登录 → 抖音，粘贴浏览器整条 Cookie）")
            raise SignerUnavailable(self.last_error["msg"])
        signer = self._signer
        if signer.user_agent != self._ua():
            # UA 变了（用户换了浏览器/改了设置）⇒ 用新 UA 重建签名器：a_bogus 把 UA 算进签名，
            # 沿用旧 UA 的后果是"200 + 空体"，而不是报错
            signer = DouyinSigner(self._ua(), browser_info=self._browser_info(),
                                  probe=signer.probe, rng=signer.rng)
            self._signer = signer
        signed = signer.sign_query(params, cookies=_cookies_of(cookie))
        return signed.query, signed.headers

    def _browser_info(self) -> str:
        """a_bogus 里的九字段几何：由屏幕尺寸推导（自洽即可 —— 平台没有第二条渠道核对窗口大小）。

        ⚠️ 若将来能拿到真机那串（抓包里的 `browser_info`），优先用它：真机是窗口化浏览器，
        推导出来的那串（1920×1080 全屏）与真实窗口不同 —— 不影响通过，但更像"另一台机器"。
        """
        from app.services.platforms.vendor.dtksign import browser_info_from_screen

        return browser_info_from_screen(int(SCREEN_WIDTH), int(SCREEN_HEIGHT),
                                        browser_facts(self._ua())["browser_platform"])

    def _identity(self) -> str:
        return identity_limit.identity_key(self.platform, self._cookie_header())

    def _admit(self, uid: str, endpoint: str) -> bool:
        if not self._enabled():
            # **总开关关着 ⇒ 一个字节都不发**（devlog/335）。放在 `_admit` 这个唯一入口上：
            # 账号信息 / 作品 / 详情三条路都要过它，将来加端点也漏不掉。
            self.last_error = {"kind": "douyin_disabled",
                               "msg": "抖音抓取默认关闭（设置 → 抓取设置 → 平台抓取里显式打开）"}
            logger.info("抖音总开关关着，本次不发请求（设置 → 抓取设置 → 平台抓取）")
            return False
        d = self._ledger.acquire(self._identity(), endpoint)
        if d.allowed:
            return True
        self.last_error = {"kind": "identity_throttled", "endpoint": endpoint,
                           "reason": d.reason, "retry_after": round(d.retry_after, 2)}
        logger.info("抖音 %s 本轮不发（%s，还需 %.1fs）", endpoint, d.reason, d.retry_after)
        return False

    def _enabled(self) -> bool:
        """总开关（`DOUYIN_ENABLED`，默认 **False**）。

        ⚠️ 读的是**设置**（可热更）而不是构造参数：用户在设置里打开之后**不必重启**，
        下一轮就生效 —— 这也是"默认关"能被用户接受的前提（否则每次都要重启一次工具）。
        """
        try:
            from app.core import runtime_settings

            return bool(runtime_settings.get("DOUYIN_ENABLED"))
        except Exception:  # noqa: BLE001 —— 设置层坏了不该变成"默认开"
            logger.warning("读 DOUYIN_ENABLED 失败，按**关**处理")
            return False

    def _observe(self, uid: str, endpoint: str, outcome: identity_limit.Outcome) -> None:
        self._ledger.record(self._identity(), endpoint, outcome, target=str(uid))

    def _outcome_of(self, kind: str) -> identity_limit.Outcome:
        return identity_limit.outcome_for_kind(kind)

    def _fail(self, status: int, *, headers: Optional[dict], payload: Any, body: bytes,
              expect: str) -> None:
        kind = classify_http(status, headers=headers, payload=payload, body_len=len(body),
                             body_head=body[:300].decode("utf-8", "replace"), expect=expect)
        self.last_error = {"kind": kind, "status": status,
                           "status_code": (payload or {}).get("status_code")
                           if isinstance(payload, dict) else None,
                           "msg": body[:300].decode("utf-8", "replace") if body else "（空体）"}
        if kind == "captcha":
            self.captcha_seen = True
            # 停止条件（计划 §四-2）：出现验证码挑战**立即停**，不绕
            logger.error("抖音出现验证码挑战（HTTP %s，endpoint=%s）—— 按计划立即停止，"
                         "本方案不绕验证码。请人工在浏览器里确认账号状态后再说",
                         status, expect)
        elif kind in ("signature_invalid", "argus_missing"):
            # 我们这侧坏了：签名格式自检已经在签名器里挡了一道，走到这里说明**平台不认**
            logger.warning("抖音签名被拒（HTTP %s，%s）—— a_bogus/secsdk 可能已与平台对不上，"
                           "见 vendor/dtksign/NOTICE.md 的升级路线", status, kind)
        elif kind == "cookie_invalid":
            from app.services.douyin_auth import douyin_auth_manager

            douyin_auth_manager.note_invalid(f"HTTP {status}")

    @staticmethod
    def _parse(body: bytes) -> Any:
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return None

    async def _get(self, client: httpx.AsyncClient, path: str, params: dict[str, str],
                   *, uid: str, endpoint: str, expect: str) -> Optional[Any]:
        """签 → 发 → 分类 → 记账。返回载荷或 `None`（失败时 `last_error` 已结构化）。"""
        try:
            query, extra_headers = self._signed(params)
        except SignerUnavailable as e:
            if (self.last_error or {}).get("kind") != "cookie_invalid":
                self.last_error = {"kind": "signer_unavailable", "msg": str(e)}
                logger.warning("抖音签名器不可用，本次不发请求：%s", e)
            return None
        headers = {
            "User-Agent": self._ua(),
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Referer": f"{BASE}/",
            "Cookie": self._cookie_header(),
            # 调研 §3.6 第 3 行：网关要 `x-tt-argus`（当前不校验取值）。D1 实测**不带也能过**，
            # 但带上更接近浏览器、成本为零 ⇒ 一直带
            "x-tt-argus": "1",
        }
        headers.update(extra_headers)
        resp = await client.get(f"{BASE}{path}?{query}", headers=headers)
        body = resp.content
        payload = self._parse(body)
        ok = resp.status_code == 200 and classify_payload(
            payload, body_len=len(body), expect=expect) == "ok"
        if not ok:
            self._fail(resp.status_code, headers=dict(resp.headers), payload=payload,
                       body=body, expect=expect)
            self._observe(uid, endpoint, self._outcome_of((self.last_error or {}).get("kind", "")))
            return None
        self._observe(uid, endpoint, "ok")
        return payload

    async def _request(self, path: str, params: dict[str, str], *, uid: str, endpoint: str,
                       expect: str, client: httpx.AsyncClient | None) -> Optional[Any]:
        own = client is None
        if own:
            client = httpx.AsyncClient(timeout=20.0)
        try:
            return await self._get(client, path, params, uid=uid, endpoint=endpoint, expect=expect)
        except httpx.HTTPError as e:            # 网络错：与身份无关（退令牌、不计样本）
            self.last_error = {"kind": "network_error", "msg": f"{type(e).__name__}: {e}"}
            self._observe(uid, endpoint, "network_error")
            logger.warning("抖音请求失败（%s）：%s: %s", endpoint, type(e).__name__, e)
            return None
        finally:
            if own:
                await client.aclose()

    # ── BasePlatform ──────────────────────────────────────────────────
    async def fetch_user_info(self, uid: str, client: httpx.AsyncClient | None = None) -> dict | None:
        sec_uid = sec_uid_from_input(uid)
        if not sec_uid:
            # 不猜：抖音号要搜索接口（本刀未接入），猜错就是静默播别人的号
            self.last_error = {
                "kind": "unsupported_input",
                "msg": ("没认出抖音 sec_user_id —— 抖音号（unique_id）需要搜索接口才能解析，"
                        "本版未接入。请在浏览器打开该账号主页，把链接"
                        "（www.douyin.com/user/MS4wLjABAAAA…）整条粘进来"),
            }
            logger.warning("抖音 uid 认不出来（%r）：%s", str(uid)[:80], self.last_error["msg"])
            return None
        if not self._admit(sec_uid, ENDPOINT_PROFILE):
            return None
        params = {**self._base_params(), "sec_user_id": sec_uid,
                  "publish_video_strategy_type": "2", "personal_center_strategy": "1"}
        payload = await self._request(PATH_PROFILE, params, uid=sec_uid,
                                      endpoint=ENDPOINT_PROFILE, expect="user", client=client)
        if payload is None:
            return None
        return parse_user_info(payload, sec_uid)

    async def fetch_post_page(self, uid: str, cursor: str | None = None,
                              client: httpx.AsyncClient | None = None) -> dict | None:
        """一页作品（cursor 语义）：`cursor=None` = 第一页；服务端给的 `max_cursor` 原样带回。

        ⚠️ **登录 jar 与游客 jar 拿到的不是同一页**（D1 实测首条 id 与 `max_cursor` 都不同）
        ⇒ 调用方的"抓全"判据要用**去重后的全集**，不能拿"条数相同"验。
        """
        sec_uid = sec_uid_from_input(uid)
        if not sec_uid:
            self.last_error = {
                "kind": "unsupported_input",
                "msg": ("没认出抖音 sec_user_id —— 抖音号（unique_id）需要搜索接口才能解析，"
                        "本版未接入。请粘主页链接（www.douyin.com/user/MS4wLjABAAAA…）"),
            }
            logger.warning("抖音 uid 认不出来（%r）：%s", str(uid)[:80], self.last_error["msg"])
            return None
        if not self._admit(sec_uid, ENDPOINT_POSTS):
            return None
        params = {**self._base_params(), "sec_user_id": sec_uid,
                  "max_cursor": str(cursor or "0"), "count": str(PAGE_SIZE),
                  "publish_video_strategy_type": "2"}
        payload = await self._request(PATH_POSTS, params, uid=sec_uid,
                                      endpoint=ENDPOINT_POSTS, expect="list", client=client)
        if payload is None:
            return None
        items = [parse_aweme(a, sec_uid) for a in (payload.get("aweme_list") or [])
                 if isinstance(a, dict)]
        has_more = bool(_int_or_none(payload.get("has_more"))) and bool(items)
        cursor_out = payload.get("max_cursor")
        return {
            "items": items,
            "has_more": has_more,
            "next_cursor": str(cursor_out) if (has_more and cursor_out not in (None, "")) else None,
        }

    async def fetch_post_detail(self, aweme_id: str,
                                client: httpx.AsyncClient | None = None) -> dict | None:
        """单条作品详情（`enrich` 用它）：**媒体地址会过期**，重取是它的主要用途。"""
        aweme_id = str(aweme_id or "")
        if not aweme_id:
            return None
        if not self._admit(aweme_id, ENDPOINT_DETAIL):
            return None
        params = {**self._base_params(), "aweme_id": aweme_id}
        payload = await self._request(PATH_DETAIL, params, uid=aweme_id,
                                      endpoint=ENDPOINT_DETAIL, expect="detail", client=client)
        if payload is None:
            return None
        aweme = payload.get("aweme_detail") or {}
        author = aweme.get("author") if isinstance(aweme.get("author"), dict) else {}
        return parse_aweme(aweme, str(author.get("sec_uid") or ""))

    async def enrich(self, item: dict, client: httpx.AsyncClient | None = None) -> bool:
        """入库前补全：把详情里更全的字段并回 item。

        列表回包**本身已经很全**（D1 实测一条 aweme 162 个字段，含图/视频地址），
        所以这里失败的代价很小 ⇒ 绝不因为"详情没拉到"把整条帖子丢掉。
        """
        aweme_id = str(item.get("platform_post_id") or "")
        if not aweme_id:
            return False
        try:
            detail = await self.fetch_post_detail(aweme_id, client=client)
        except Exception as e:  # noqa: BLE001
            logger.warning("抖音详情补全失败 %s: %s: %s", aweme_id, type(e).__name__, e)
            return False
        if not detail:
            return False
        for key, value in detail.items():
            if value not in (None, "", [], {}):
                item[key] = value
        return True


fetcher = DouyinPlatform()
