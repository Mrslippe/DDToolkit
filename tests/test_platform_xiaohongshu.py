"""小红书适配的判据（第 4 阶段 ④，devlog/230）。

**不碰网络**：注入假签名器 + 假 httpx client。判据钉的是"这一刀真正做出来的东西"：
请求头有没有签名、query 有没有被编码坏、`platform_post_id` 是不是字符串、
cursor 有没有被正确串起来、失败有没有被**分门别类**、以及**端到端**能不能经调度器落库。
"""
import asyncio
import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, Post, VTuber
from app.services import scheduler as sch
from app.services.platforms import registry
from app.services.platforms.signing import NullSigner, SignerUnavailable
from app.services.platforms.xiaohongshu import XiaohongshuPlatform, classify_http


class FakeSigner:
    platform = "xiaohongshu"

    def __init__(self):
        self.seen: list[dict] = []

    def headers(self, *, method, uri, params=None, payload=None, cookies=""):
        self.seen.append({"method": method, "uri": uri, "params": params, "cookies": cookies})
        return {"x-s": "FAKE-S", "x-t": "1700000000", "x-s-common": "FAKE-C"}


class FakeResp:
    def __init__(self, status=200, payload=None):
        self.status_code = status
        self._payload = payload if payload is not None else {"success": True, "data": {}}

    def json(self):
        return self._payload


class FakeClient:
    """记录每一次请求（URL 原文 + 头），按调用顺序返回预设响应。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[tuple[str, dict]] = []

    async def get(self, url, headers=None):
        self.calls.append((url, dict(headers or {})))
        return self.responses.pop(0) if self.responses else FakeResp()

    async def aclose(self):
        pass


NOTE = {
    "note_id": "65f0c0ffee1234567890abcd",     # 长的十六进制 id（不是数字，但同样按字符串走）
    "type": "normal",
    "display_title": "标题",
    "desc": "正文",
    "cover": {"url": "https://ci.xiaohongshu.com/a.jpg"},
    "liked_count": "12",
    "xsec_token": "ABtokenCD",
}


def _pf(**kw) -> XiaohongshuPlatform:
    return XiaohongshuPlatform(cookies="web_session=xyz", **kw)


def test_signed_headers_are_sent_and_commas_are_not_encoded():
    """① 签名头都在；② query 里的逗号**没有**被编码成 `%2C`（编码了签名就校验不过）。"""
    signer = FakeSigner()
    client = FakeClient([FakeResp(payload={"success": True, "data": {"notes": [NOTE],
                                                                    "cursor": "c1", "has_more": True}})])
    out = asyncio.run(_pf(signer=signer).fetch_post_page("u1", 1, client=client))
    url, headers = client.calls[0]
    assert headers["x-s"] == "FAKE-S" and headers["x-t"] and headers["x-s-common"]
    assert headers["cookie"] == "web_session=xyz"
    assert "image_formats=jpg,webp,avif" in url, url
    assert "%2C" not in url, "逗号被编码了 —— 签名会校验失败（调研 §2.2）"
    assert signer.seen[0]["uri"] == "/api/sns/web/v1/user_posted"
    assert signer.seen[0]["params"]["num"] == 30 and "cursor" in signer.seen[0]["params"]
    assert out["has_more"] is True


def test_post_id_stays_a_string():
    """③ `platform_post_id` 必须是字符串（19 位 id 转 Number 会静默丢精度）。"""
    big = {"note_id": 6500000000000000000, "type": "video", "display_title": "x",
           "xsec_token": "TK"}          # 故意给整数 id
    client = FakeClient([FakeResp(payload={"success": True, "data": {"notes": [big], "has_more": False}})])
    out = asyncio.run(_pf(signer=FakeSigner()).fetch_post_page("u1", 1, client=client))
    item = out["items"][0]
    assert isinstance(item["platform_post_id"], str)
    assert item["type"] == "video"
    # `xsec_token` 只进 raw_json（它不是凭证、不能当去重键）
    assert "xsec_token" in item["raw_json"]
    # 三个 json 列在库里是 Text ⇒ 必须是字符串（塞 dict 落库会报错）
    for k in ("body_json", "stats_json", "raw_json"):
        assert isinstance(item[k], str), f"{k} 必须是 JSON 串"


def test_cursor_is_chained_across_pages_and_reset_on_page_1():
    """④ cursor 串页：第 1 页用空 cursor，第 2 页用上一页返回的 cursor；回到第 1 页要重来。"""
    pf = _pf(signer=FakeSigner())
    client = FakeClient([
        FakeResp(payload={"success": True, "data": {"notes": [NOTE], "cursor": "CUR1", "has_more": True}}),
        FakeResp(payload={"success": True, "data": {"notes": [NOTE], "cursor": "CUR2", "has_more": False}}),
        FakeResp(payload={"success": True, "data": {"notes": [NOTE], "cursor": "CUR3", "has_more": True}}),
    ])
    asyncio.run(pf.fetch_post_page("u1", 1, client=client))
    asyncio.run(pf.fetch_post_page("u1", 2, client=client))
    asyncio.run(pf.fetch_post_page("u1", 1, client=client))
    assert "cursor=&user_id" in client.calls[0][0]
    assert "cursor=CUR1" in client.calls[1][0]
    assert "cursor=&user_id" in client.calls[2][0], "回到第 1 页必须从头开始"


def test_failures_are_classified():
    """⑤ 失败要**分门别类**（会话被风控是一等状态；不能都算"业务失败"）。"""
    assert classify_http(200) == "ok"
    assert classify_http(403, msg="login required") == "cookie_invalid"
    assert classify_http(403, msg="x-s verify failed") == "signature_invalid"
    assert classify_http(403, msg="missing gateway header") == "gateway_missing"
    assert classify_http(461, msg="") == "risk_control"
    assert classify_http(403, msg="") == "risk_control"      # 403 兜底按最坏算
    assert classify_http(500, msg="boom") == "business_error"

    pf = _pf(signer=FakeSigner())
    client = FakeClient([FakeResp(status=403, payload={"success": False, "code": -101,
                                                       "msg": "登录已过期"})])
    assert asyncio.run(pf.fetch_post_page("u1", 1, client=client)) is None
    assert pf.last_error["kind"] == "cookie_invalid"


def test_no_cookie_means_no_request_at_all():
    """⑥ 没有身份就不发请求（省得被风控记一笔），且给出结构化原因。"""
    pf = XiaohongshuPlatform(cookies="", signer=FakeSigner())
    client = FakeClient([])
    assert asyncio.run(pf.fetch_user_info("u1", client=client)) is None
    assert client.calls == [], "没有 cookie 时不该发请求"
    assert pf.last_error["kind"] == "cookie_invalid"


def test_signer_unavailable_is_loud_not_silent(monkeypatch):
    """⑦ 签名器不在时**响亮地失败**（`SignerUnavailable` 被吞成 None + last_error），
    绝不静默发一个没签名的请求。"""
    class Boom:
        platform = "xiaohongshu"

        def headers(self, **kw):
            raise SignerUnavailable("没装 xhshow")

    pf = XiaohongshuPlatform(cookies="web_session=xyz", signer=Boom())
    client = FakeClient([])
    assert asyncio.run(pf.fetch_user_info("u1", client=client)) is None
    assert client.calls == [], "签名不可用时也不该发请求"


def test_end_to_end_through_the_scheduler_lands_posts():
    """⑧ **端到端**：库里有小红书账号 ⇒ 通用单流循环把它抓下来落库（platform=xiaohongshu）。

    这条是"接一个平台打通"的机器判据：注册表 → `_fetch_posts_for_account` →
    `_fetch_platform_posts` → 适配器（假签名器 + 假传输）→ posts 表。
    """
    assert registry.get_fetcher("xiaohongshu") is not None, "注册表里没有小红书"

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    v = VTuber(name="小红薯")
    db.add(v)
    db.commit()
    db.add(Account(vtuber_id=v.id, platform="xiaohongshu", platform_uid="u1"))
    db.commit()

    pf = _pf(signer=FakeSigner())
    client = FakeClient([
        FakeResp(payload={"success": True, "data": {"notes": [NOTE], "cursor": "C1", "has_more": False}}),
    ])
    # 适配器是注册表里的单例（没有 cookie/签名器）⇒ 换成注入了替身的实例再跑
    monkey = registry._REGISTRY["xiaohongshu"]
    registry._REGISTRY["xiaohongshu"] = pf
    try:
        result = asyncio.run(sch._fetch_posts_for_account(
            db.query(Account).first(), 1, 1, db, client=client))
    finally:
        registry._REGISTRY["xiaohongshu"] = monkey

    rows = db.query(Post).all()
    assert rows, f"没有落库（result={result}）"
    assert {r.platform for r in rows} == {"xiaohongshu"}
    assert all(isinstance(r.platform_post_id, str) for r in rows)
    db.close()


def test_real_signer_produces_headers_offline():
    """⑨ **真签名器**（`xhshow`，已在 `uv.lock` 里）离线就能产出 `x-s`/`x-t`：

    签名是**纯函数**（不需要网络），所以这条在 CI 里也跑得动。
    它盯的是"依赖装没装上 + 调用形状对不对"（devlog/232：本刀把签名调用改成了
    `xhshow` 的真实形状 —— `uri` = path + `params` 字典）。

    ⚠️ 实测（2026-09-27）：`xhshow` **要 `a1`**（缺了直接报 `Missing 'a1' in cookies`）
    ⇒ 小红书的身份 cookie 包至少是 `a1` + `web_session` 两件，不是文档里那句"只要 web_session"。
    """
    from app.services.platforms.signing import SignerUnavailable, XhsSigner

    try:
        heads = XhsSigner().headers(
            method="GET", uri="/api/sns/web/v1/user_posted",
            params={"num": 30, "cursor": "", "user_id": "u1",
                    "image_formats": "jpg,webp,avif", "xsec_source": "pc_user"},
            cookies="a1=1900abcdef; web_session=xyz")
    except SignerUnavailable as e:      # pragma: no cover - 依赖没装才会走到
        pytest.fail(f"签名器不可用（依赖没进环境？）：{e}")
    assert {"x-s", "x-t"} <= set(heads), heads
    assert heads["x-s"], "x-s 不能是空串"
