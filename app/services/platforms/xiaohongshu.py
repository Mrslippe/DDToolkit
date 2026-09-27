"""小红书平台适配（第 4 阶段 ④ 第一刀，devlog/230）。

依据：`docs/platforms-xhs-douyin-research.md` §2（接口清单 / 签名 / cookie / 登录）。

## 这一刀做到哪

- **账号信息**（`fetch_user_info`）与**笔记流**（`fetch_post_page`）两条都通，
  走的是 `BasePlatform` 现有接口 ⇒ 调度器**不用改**就能抓它（`_fetch_platform_posts` 通用单流循环）；
- 身份（cookie）与签名器**都是注入项**：cookie 走 `settings.XHS_COOKIE`（`web_session` 即可，
  调研 §2.8），签名走 `signing.XhsSigner`（懒加载 `xhshow`）；测试注入替身，不碰网络。

## ⚠️ 三个必须写下来的坑（调研 §2.2 / §5.1）

1. **query 里的逗号不能编码**：`image_formats=jpg,webp,avif` 若被编成 `%2C` 则签名校验失败
   ⇒ 这里**手拼 query**，不用 httpx 的 `params`；
2. **`platform_post_id` 全程按字符串**（抖音 19 位 id 会超出 JS 安全整数，小红书同理）——
   落库/JSON 路径都不许转 Number；
3. **`xsec_token` 不是凭证、不能当去重键**（它会过期）⇒ 只进 `raw_json` 当上下文缓存
   （详情接口 `feed` 需要它，见调研 §2.4）。

## 翻页：cursor 语义（第 4 阶段 ⑥，devlog/238）

`BasePlatform.fetch_post_page` 现在收**不透明 cursor**（`None` = 从头开始，返回 `next_cursor`），
所以这里**不再自己记"上一页给到哪"**：

```python
# 旧（过渡形状，已删）：self._cursor[uid] = data["cursor"]
# 新：把服务端给的串原样当 next_cursor 交回核心，下一页原样带回来
```

好处不只是好看：分页状态**回到调用方**手里 —— 换账号、重抓、并发重入都不会串台，
而"这一页是谁的"也不必靠适配器里那张按 uid 的字典去猜（那张字典正是最脏的一处状态）。

## 身份级限速（第 4 阶段 ⑤，devlog/237；调研 §5.3.1）

每个请求前问一次 `identity_limit.LEDGER`（粒度 **(身份, 端点)**），请求后按**四类响应**记账：
额度不够/端点熔断 ⇒ **一个字节都不发**（`last_error.kind = "identity_throttled"`），
业务失败与网络错**退还令牌**、风控才扣身份健康度。
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional
from urllib.parse import urlencode

import httpx

from app.core.config import settings
from app.core.useragent import UA_CHROME
from app.services import identity_limit
from app.services.platforms.base import BasePlatform
from app.services.platforms.signing import NullSigner, Signer, SignerUnavailable

logger = logging.getLogger(__name__)

BASE = "https://edith.xiaohongshu.com"
# ⚠️ UA 字面量**只能**来自 `app/core/useragent.py`（R26②，`tests/test_user_agent.py` 扫全仓盯着）
UA = UA_CHROME

# 笔记类型映射：小红书自己没有"投稿/动态"之分，落到我们的 type 上时统一给 text/image/video
_TYPE_BY_XHS = {"normal": "image", "video": "video"}


def classify_http(status: int, code: Any = None, msg: str = "") -> str:
    """把一次失败的响应分成**可排查的几类**（调研 §1.3 第 3 条：会话被风控要成为一等状态）。

    ⚠️ 这是**初版**：关键词规则来自调研里的描述（cookie 失效 / 签名失效 / 网关头缺失 / 风控），
    真机拿到真实响应后要按平台返回的 `code` 校准 —— 别把它当"已验证的码表"。

    这几类是**诊断**口径（给排查看），策略口径是 `identity_limit` 的四分类
    （映射表在那边；devlog/237 接的线）。
    """
    text = f"{code if code is not None else ''} {msg}".lower()
    if status == 200:
        return "ok"
    if status >= 500:
        # 上游/网关故障：**不是**业务失败（devlog/237 前它被归进 business_error，
        # 于是"上游挂了"会被算成"这个帖子有问题"——两件事的处置完全不同）
        return "server_error"
    if status in (461, 471) or "risk" in text or "风控" in text or "频繁" in text:
        return "risk_control"
    if any(k in text for k in ("sign", "签名", "verify", "x-s")):
        return "signature_invalid"
    if any(k in text for k in ("login", "登录", "session", "未登录", "web_session")):
        return "cookie_invalid"
    if status == 403 and any(k in text for k in ("gateway", "header", "missing")):
        return "gateway_missing"
    if status == 403:
        return "risk_control"      # 403 兜底：按最坏情况算（宁可多冷却，不可误判为业务失败）
    return "business_error"


class XiaohongshuPlatform(BasePlatform):
    platform = "xiaohongshu"

    def __init__(self, cookies: str = "", signer: Optional[Signer] = None,
                 ledger: "identity_limit.Ledger | None" = None) -> None:
        self._cookies = cookies
        self._signer: Signer = signer or NullSigner()
        # 身份级额度台账：默认共用进程内单例；测试注入自己的（可控时钟）
        self._ledger = ledger if ledger is not None else identity_limit.LEDGER
        # ⚠️ 这里**没有**分页状态：cursor 由核心循环拿着（第 4 阶段 ⑥，devlog/238）。
        # 最近一次失败的结构化原因（调用方/排查用；不改 BasePlatform 的返回形状）
        self.last_error: Optional[dict] = None

    # ── 内部工具 ───────────────────────────────────────────────────────
    def _cookie_header(self) -> str:
        return self._cookies or getattr(settings, "XHS_COOKIE", "")

    def _signed_headers(self, method: str, path: str,
                        params: Optional[dict] = None,
                        payload: Optional[dict] = None) -> dict[str, str]:
        if not self._cookie_header():
            # 连身份都没有就别发请求（省得被风控记一笔）
            self.last_error = {"kind": "cookie_invalid", "msg": "未配置小红书 cookie（web_session）"}
            raise SignerUnavailable(self.last_error["msg"])
        headers = {
            "user-agent": UA,
            "cookie": self._cookie_header(),
            "referer": "https://www.xiaohongshu.com/",
        }
        headers.update(self._signer.headers(
            method=method, uri=path, params=params, payload=payload,
            cookies=self._cookie_header()))
        return headers

    @staticmethod
    def _parse(resp: httpx.Response) -> tuple[bool, Optional[dict]]:
        """返回 `(是否成功, 数据)`；失败时把分类结果写进实例属性。"""
        try:
            body = resp.json()
        except Exception:  # noqa: BLE001 —— 非 JSON（网关页/HTML）也算失败
            return False, None
        if resp.status_code == 200 and body.get("success", True):
            return True, body.get("data") or {}
        return False, body

    def _fail(self, resp: httpx.Response, body: Optional[dict]) -> None:
        body = body or {}
        kind = classify_http(resp.status_code, body.get("code"), str(body.get("msg") or ""))
        self.last_error = {"kind": kind, "status": resp.status_code,
                           "code": body.get("code"), "msg": body.get("msg")}
        # cookie 失效是"身份级"事件：调用方（核心循环）见到失败就停这一轮，
        # 不再需要适配器去清什么内部游标 —— 分页状态已经不住在这里了

    # ── 身份级限速（调研 §5.3.1，devlog/237）─────────────────────────────
    # 粒度是 **(身份, 端点)**：身份是**我们这份 cookie**（不是被查的 uid）——
    # 风控盯的是"这份身份在这个端点上的节奏"，换个目标就满速重来等于没节流。
    # 被查的 uid 只参与端点熔断的归因（"≥3 个不同目标都被风控 ⇒ 端点坏了"）。
    def _identity(self) -> str:
        """`xiaohongshu:<cookie 指纹>`（cookie 变了就是另一份身份）。"""
        return identity_limit.identity_key(self.platform, self._cookie_header())

    def _admit(self, uid: str, endpoint: str) -> bool:
        """发请求前问一次额度。不允许 ⇒ 一个字节都不发给上游（连风控都不挨）。"""
        d = self._ledger.acquire(self._identity(), endpoint)
        if d.allowed:
            return True
        self.last_error = {"kind": "identity_throttled", "endpoint": endpoint,
                           "reason": d.reason, "retry_after": round(d.retry_after, 2)}
        logger.info("小红书 %s 本轮不发（%s，还需 %.1fs）", endpoint, d.reason, d.retry_after)
        return False

    def _observe(self, uid: str, endpoint: str, outcome: identity_limit.Outcome) -> None:
        self._ledger.record(self._identity(), endpoint, outcome, target=str(uid))

    def _outcome_of(self, kind: str) -> identity_limit.Outcome:
        """诊断六分类 → 四类（映射表在 `identity_limit.py`，那里写了为什么这么归）。"""
        return identity_limit.outcome_for_kind(kind)

    # ── BasePlatform ──────────────────────────────────────────────────
    async def fetch_user_info(self, uid: str, client: httpx.AsyncClient | None = None) -> dict | None:
        if not self._admit(uid, "otherinfo"):
            return None
        own = client is None
        if own:
            client = httpx.AsyncClient(timeout=15.0)
        try:
            path = "/api/sns/web/v1/user/otherinfo"
            params = {"target_user_id": str(uid)}
            headers = self._signed_headers("GET", path, params)
            resp = await client.get(f"{BASE}{path}?{urlencode(params, safe=chr(44))}",
                                    headers=headers)
            ok, body = self._parse(resp)
            if not ok:
                self._fail(resp, body)
                self._observe(uid, "otherinfo",
                              self._outcome_of((self.last_error or {}).get("kind", "")))
                return None
            self._observe(uid, "otherinfo", "ok")
            d = body or {}
            return {
                "name": d.get("nickname") or d.get("name"),
                "sign": d.get("desc"),
                "avatar": d.get("image") or d.get("avatar"),
                "followers_count": int(d.get("fans") or 0),
                "url": f"https://www.xiaohongshu.com/user/profile/{uid}",
                "raw_json": d,
            }
        except SignerUnavailable:
            return None
        finally:
            if own:
                await client.aclose()

    async def fetch_post_page(self, uid: str, cursor: str | None = None,
                              client: httpx.AsyncClient | None = None) -> dict | None:
        """一页笔记（cursor 语义，devlog/238）：`cursor=None` = 从头开始。

        服务端给的 `cursor` **原样**作为 `next_cursor` 交回核心（我们不改写、不解析它）。
        """
        if not self._admit(uid, "user_posted"):
            return None
        own = client is None
        if own:
            client = httpx.AsyncClient(timeout=15.0)
        try:
            path = "/api/sns/web/v1/user_posted"
            params = {"num": 30, "cursor": cursor or "", "user_id": str(uid),
                      "image_formats": "jpg,webp,avif", "xsec_source": "pc_user"}
            # ⚠️ 签名与请求**必须同一组键值**；`safe=","` 保证逗号不被编码（调研 §2.2）
            headers = self._signed_headers("GET", path, params)
            resp = await client.get(f"{BASE}{path}?{urlencode(params, safe=chr(44))}",
                                    headers=headers)
            ok, body = self._parse(resp)
            if not ok:
                self._fail(resp, body)
                self._observe(uid, "user_posted",
                              self._outcome_of((self.last_error or {}).get("kind", "")))
                return None
            self._observe(uid, "user_posted", "ok")
            data = body or {}
            notes = data.get("notes") or []
            has_more = bool(data.get("has_more")) and bool(notes)
            # 服务端给数值时也要转字符串（cursor 对核心是不透明的字符串）
            nxt = data.get("cursor")
            return {
                "items": [self._to_item(uid, n) for n in notes],
                "has_more": has_more,
                "next_cursor": (str(nxt) if nxt not in (None, "") else None) if has_more else None,
            }
        except SignerUnavailable:
            return None
        finally:
            if own:
                await client.aclose()

    @staticmethod
    def _to_item(uid: str, note: dict) -> dict:
        """一条笔记 → 我们的统一 item 结构。

        ⚠️ `platform_post_id` **按字符串**；`xsec_token` 只进 `raw_json`（不是凭证、不能当去重键）。
        """
        nid = str(note.get("note_id") or note.get("id") or "")
        ntype = _TYPE_BY_XHS.get(str(note.get("type") or "normal"), "image")
        # ⚠️ 三个 json 列在库里是 **Text**（其它平台同样存 JSON 串）⇒ 这里必须序列化成字符串，
        #    直接塞 dict 会在落库时报 `type 'dict' is not supported`。
        def _dump(obj: Any) -> str:
            return json.dumps(obj, ensure_ascii=False)
        permalink = f"https://www.xiaohongshu.com/explore/{nid}"
        return {
            "platform": "xiaohongshu",
            "platform_uid": str(uid),
            "platform_post_id": nid,          # 字符串，永不转 int
            "type": ntype,
            "title": note.get("display_title") or note.get("title"),
            "summary": note.get("desc"),
            "cover_url": note.get("cover", {}).get("url") if isinstance(note.get("cover"), dict) else None,
            "permalink": permalink,
            "body_json": _dump({"desc": note.get("desc"), "type": note.get("type")}),
            "stats_json": _dump({"liked": note.get("liked_count"),
                                 "collected": note.get("collected_count")}),
            "published_at": None,             # 列表接口不给时间戳，要详情/搜索才有
            "raw_json": _dump(note),          # xsec_token 在这里，详情接口要用
        }


fetcher = XiaohongshuPlatform()
