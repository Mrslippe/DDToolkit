"""小红书适配的判据（第 4 阶段 ④，devlog/230）。

**不碰网络**：注入假签名器 + 假 httpx client。判据钉的是"这一刀真正做出来的东西"：
请求头有没有签名、query 有没有被编码坏、`platform_post_id` 是不是字符串、
cursor 有没有被正确串起来、失败有没有被**分门别类**、以及**端到端**能不能经调度器落库。
"""
import asyncio
import json
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, Post, VTuber
from app.services import identity_limit
from app.services import scheduler as sch
from app.services.platforms import registry, xiaohongshu
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
    """测试一律**显式注入替身签名器**（生产的默认值是真签名器，见 devlog/277）。"""
    kw.setdefault("signer", FakeSigner())
    return XiaohongshuPlatform(cookies="web_session=xyz", **kw)


def test_signed_headers_are_sent_and_commas_are_not_encoded():
    """① 签名头都在；② query 里的逗号**没有**被编码成 `%2C`（编码了签名就校验不过）。"""
    signer = FakeSigner()
    client = FakeClient([FakeResp(payload={"success": True, "data": {"notes": [NOTE],
                                                                    "cursor": "c1", "has_more": True}})])
    out = asyncio.run(_pf(signer=signer).fetch_post_page("u1", None, client=client))
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
    out = asyncio.run(_pf(signer=FakeSigner()).fetch_post_page("u1", None, client=client))
    item = out["items"][0]
    assert isinstance(item["platform_post_id"], str)
    assert item["type"] == "video"
    # `xsec_token` 只进 raw_json（它不是凭证、不能当去重键）
    assert "xsec_token" in item["raw_json"]
    # 三个 json 列在库里是 Text ⇒ 必须是字符串（塞 dict 落库会报错）
    for k in ("body_json", "stats_json", "raw_json"):
        assert isinstance(item[k], str), f"{k} 必须是 JSON 串"


def test_adapter_is_stateless_about_cursor():
    """④ cursor **不透明且无状态**（第 4 阶段 ⑥，devlog/238）。

    适配器只做两件事：把收到的 cursor 原样放进 query、把服务端给的串原样当 `next_cursor`
    交回去。**它自己不记"上一页给到哪"** —— 那正是旧过渡实现（`self._cursor[uid]`）的病根：
    分页状态住进适配器后，换账号/重抓/并发重入都会串台。

    ⚠️ 每翻一页都要**把时钟往前推**（devlog/237 起 `user_posted` 的身份级额度是每 8.3s 一次），
    否则第 2 页会被令牌桶挡下（一个字节都不发）—— 那是另一条判据的事，别混在这里。
    """
    clock = {"t": 1000.0}
    pf = _pf(signer=FakeSigner(), ledger=identity_limit.Ledger(now=lambda: clock["t"]))
    client = FakeClient([
        FakeResp(payload={"success": True, "data": {"notes": [NOTE], "cursor": "CUR1", "has_more": True}}),
        FakeResp(payload={"success": True, "data": {"notes": [NOTE], "cursor": "CUR2", "has_more": False}}),
        FakeResp(payload={"success": True, "data": {"notes": [NOTE], "cursor": "CUR3", "has_more": True}}),
    ])
    first = asyncio.run(pf.fetch_post_page("u1", None, client=client))
    clock["t"] += 10          # 等够一个令牌（8.3s）
    second = asyncio.run(pf.fetch_post_page("u1", first["next_cursor"], client=client))
    clock["t"] += 10
    third = asyncio.run(pf.fetch_post_page("u1", None, client=client))

    assert "cursor=&user_id" in client.calls[0][0], "从头开始 = 空 cursor"
    assert first["next_cursor"] == "CUR1", "服务端给的游标要原样交回"
    assert "cursor=CUR1" in client.calls[1][0], "带回来的游标要原样进 query"
    assert second["next_cursor"] is None, "has_more=False 时不该再给游标"
    assert "cursor=&user_id" in client.calls[2][0], "再问一次仍是从头开始（适配器不留状态）"
    assert third["next_cursor"] == "CUR3"


def test_failures_are_classified():
    """⑤ 失败要**分门别类**（会话被风控是一等状态；不能都算"业务失败"）。"""
    assert classify_http(200) == "ok"
    assert classify_http(403, msg="login required") == "cookie_invalid"
    assert classify_http(403, msg="x-s verify failed") == "signature_invalid"
    assert classify_http(403, msg="missing gateway header") == "gateway_missing"
    assert classify_http(461, msg="") == "risk_control"
    assert classify_http(403, msg="") == "risk_control"      # 403 兜底按最坏算
    # ⚠️ devlog/237 改口径：5xx 是**上游故障**，不是"这个帖子有问题"
    assert classify_http(500, msg="boom") == "server_error"
    assert classify_http(502, msg="") == "server_error"

    pf = _pf(signer=FakeSigner())
    client = FakeClient([FakeResp(status=403, payload={"success": False, "code": -101,
                                                       "msg": "登录已过期"})])
    assert asyncio.run(pf.fetch_post_page("u1", None, client=client)) is None
    assert pf.last_error["kind"] == "cookie_invalid"


def test_no_cookie_means_no_request_at_all():
    """⑥ 没有身份就不发请求（省得被风控记一笔），且给出结构化原因。"""
    pf = XiaohongshuPlatform(cookies="", signer=FakeSigner())
    client = FakeClient([])
    assert asyncio.run(pf.fetch_user_info("u1", client=client)) is None
    assert client.calls == [], "没有 cookie 时不该发请求"
    assert pf.last_error["kind"] == "cookie_invalid"


def test_signer_unavailable_is_loud_not_silent(monkeypatch, caplog):
    """⑦ 签名器不在时**响亮地失败**（`SignerUnavailable` 被吞成 None + last_error），
    绝不静默发一个没签名的请求。

    ⚠️ 2026-10-02（devlog/276）补上"响亮"这一半：原先这条路径**连日志都没有**，
    真机上表现为"配了 cookie 却什么都抓不到"，而日志里只有一串上游 **406**
    ——（当时 dev 后端跑在系统解释器上，`xhshow` 只装在项目 `.venv` 里）。
    """
    class Boom:
        platform = "xiaohongshu"

        def headers(self, **kw):
            raise SignerUnavailable("没装 xhshow")

    pf = XiaohongshuPlatform(cookies="web_session=xyz", signer=Boom())
    client = FakeClient([])
    with caplog.at_level("WARNING"):
        assert asyncio.run(pf.fetch_user_info("u1", client=client)) is None
    assert client.calls == [], "签名不可用时也不该发请求（宁可什么都不抓）"
    # 结构化原因 + 一条 warning：没有这两样，"抓不到"就没法归因
    assert pf.last_error["kind"] == "signer_unavailable"
    assert "xhshow" in pf.last_error["msg"]
    assert any("签名器不可用" in r.message for r in caplog.records), caplog.text


def test_no_cookie_keeps_its_own_diagnosis():
    """⑦′ "没 cookie"与"没签名器"都是 `SignerUnavailable`，但**诊断不能串**：
    前者要说 `cookie_invalid`（用户能照做：去填 cookie），不能被改写成缺依赖。"""
    pf = XiaohongshuPlatform(cookies="", signer=FakeSigner())
    client = FakeClient([])
    assert asyncio.run(pf.fetch_post_page("u1", client=client)) is None
    assert client.calls == []
    assert pf.last_error["kind"] == "cookie_invalid"


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
    # 适配器换成注入了替身的实例再跑（注册表里那个**带真签名器**，见 ⑩）
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


def test_user_info_maps_the_real_response_shape():
    """⑪ 账号信息按**真实回包**解析（昵称/头像/粉丝数/简介）。

    回归背景（2026-10-02，devlog/277）：原实现读顶层 `nickname`/`fans`/`image`，
    而真回包把它们放在 `basic_info` 与 `interactions[type=fans].count`（字符串）里 ⇒
    账号名字、头像、粉丝数**全是空/0** —— 用户看到的正是"账号信息也没有抓取到"。
    这段形状是**真机抓下来的**（`/user/otherinfo`，普通小栗），不是照着文档猜的。
    """
    pf = _pf()
    client = FakeClient([FakeResp(payload={"success": True, "data": {
        "basic_info": {"red_id": "4970845138", "gender": 1, "ip_location": "上海",
                       "desc": "还没有简介",
                       "imageb": "https://sns-avatar-qc.xhscdn.com/avatar/x?imageView2/2/w/540",
                       "images": "https://sns-avatar-qc.xhscdn.com/avatar/x?imageView2/2/w/360",
                       "nickname": "普通小栗"},
        "interactions": [
            {"type": "follows", "name": "关注", "count": "85", "i18n_count": "85"},
            {"type": "fans", "name": "粉丝", "count": "32445", "i18n_count": "32.4K"},
            {"type": "interaction", "name": "获赞与收藏", "count": "90512"},
        ],
        "posted": 35, "liked": 82609,
    }})])
    info = asyncio.run(pf.fetch_user_info("611bbf00000000000100a109", client=client))

    assert info["name"] == "普通小栗"
    assert info["followers_count"] == 32445, "粉丝数在 interactions[type=fans].count（字符串）里"
    assert info["avatar"].endswith("/w/540"), "头像取 imageb（大图），不是缩略图"
    assert info["sign"] is None, "`还没有简介`是平台占位文案，不该当成签名存下来"
    assert info["url"].endswith("/611bbf00000000000100a109"), "主页 URL 用请求的 uid，不是 red_id"
    assert info["raw_json"]["posted"] == 35


def test_note_item_maps_cover_time_and_likes():
    """⑫ 笔记字段按**真机回包**映射：封面（`cover.info_list`）、发布时间（`time`）、点赞（`interact_info`）。

    回归背景（2026-10-02，devlog/278）用户报「帖子详情无法获取图片和日期信息」：
    原实现取 `cover.url`（真回包是**空串**）、`published_at` 恒为 None（旧注释误以为
    "列表接口不给时间戳"）、点赞读顶层 `liked_count`（真字段在 `interact_info` 里）。
    形状照真机抓下来的写。
    """
    note = {
        "type": "normal",
        "note_id": "6abf6ba8000000001303ef77",
        "time": 1790929832000,                       # 2026-10-02 08:30:32 UTC
        "xsec_token": "ABjbrMETExJ2utmuHaLjQpOIP7Fr5biOkH-1AEDmn1DWk=",
        "display_title": "走，秋天和我一起逛街咯",
        "cover": {"url": "", "trace_id": "", "info_list": [
            {"image_scene": "WB_PRV", "url": "http://sns-webpic-qc.xhscdn.com/prv.webp"},
            {"image_scene": "WB_DFT", "url": "http://sns-webpic-qc.xhscdn.com/dft.webp"},
        ]},
        "interact_info": {"liked": False, "liked_count": "1036", "sticky": False},
    }
    item = XiaohongshuPlatform._to_item("611bbf00000000000100a109", note)

    assert item["cover_url"] == "http://sns-webpic-qc.xhscdn.com/dft.webp", \
        "封面取 info_list 里的 WB_DFT（大图）；cover.url 是空串"
    assert item["published_at"] == datetime(2026, 10, 2, 8, 30, 32), "发布时间就在 time（毫秒）"
    assert json.loads(item["stats_json"])["liked"] == "1036", "点赞在 interact_info 里"
    assert json.loads(item["body_json"])["images"], "body_json 要带图，详情窗据此渲染"
    assert "xsec_token" in json.loads(item["raw_json"]), "xsec_token 只进 raw_json"


def test_note_item_survives_a_crippled_note():
    """⑫′ 缺字段的笔记不许炸（老数据/别的端点形态）：拿不到就给 None，不抛。"""
    item = XiaohongshuPlatform._to_item("u1", {"note_id": "n1"})
    assert item["cover_url"] is None and item["published_at"] is None
    assert item["type"] == "image" and item["platform_post_id"] == "n1"


def test_note_detail_parses_multiple_images_and_body():
    """⑬ 详情 `note_card` → 多图 + 正文 + 标签 + 可用链接（**真机形状**）。

    回归背景（2026-10-02，devlog/280）用户报「笔记只有一张照片、文字内容也没展示」：
    列表接口只给封面预览图与标题，**正文与多图只在详情回包里**（该帖实测 6 张图、
    237 字正文）—— 所以要靠 `enrich()` 在入库时补。

    链接那条同样有背景：裸 `…/explore/{id}` 在小红书侧打不开（用户看到"当前笔记暂时无法浏览"），
    必须带 `xsec_token`（用户给过可用样例）。
    """
    card = {
        "note_id": "6abf6ba8000000001303ef77",
        "type": "normal",
        "title": "走，秋天和我一起逛街咯",
        "desc": "🍂秋日探店\n第二行正文",
        "time": 1790929832000,
        "ip_location": "上海",
        "tag_list": [{"name": "秋日穿搭"}, {"name": "探店"}],
        "interact_info": {"liked_count": "1036", "collected_count": "88"},
        "image_list": [
            {"url_default": "http://x/1.webp", "url_pre": "http://x/1p.webp"},
            {"url_default": "http://x/2.webp"},
            {"url_default": "http://x/3.webp"},
        ],
    }
    out = xiaohongshu.parse_note_detail(card, "u1", fallback_token="TOK+/=")

    body = json.loads(out["body_json"])
    assert [i["url"] for i in body["images"]] == [
        "http://x/1.webp", "http://x/2.webp", "http://x/3.webp"]
    assert body["desc"].startswith("🍂秋日探店") and body["tags"] == ["秋日穿搭", "探店"]
    assert body["ip_location"] == "上海"
    assert out["cover_url"] == "http://x/1.webp"
    assert out["published_at"] == datetime(2026, 10, 2, 8, 30, 32)
    assert json.loads(out["stats_json"])["liked"] == "1036"
    # token 里的 `+` `/` `=` 必须百分号编码（否则链接参数表就错了）
    assert out["permalink"] == ("https://www.xiaohongshu.com/explore/6abf6ba8000000001303ef77"
                                "?xsec_token=TOK%2B%2F%3D&xsec_source=pc_user")


def test_note_permalink_carries_the_token():
    """⑬′ 列表项的链接也要带 token（否则点开是"当前笔记暂时无法浏览"）。"""
    item = XiaohongshuPlatform._to_item("u1", {
        "note_id": "n1", "type": "normal", "xsec_token": "ABjbrMET/xyz=",
    })
    assert item["permalink"] == ("https://www.xiaohongshu.com/explore/n1"
                                 "?xsec_token=ABjbrMET%2Fxyz%3D&xsec_source=pc_user")
    bare = XiaohongshuPlatform._to_item("u1", {"note_id": "n2"})
    assert bare["permalink"] == "https://www.xiaohongshu.com/explore/n2"


def test_enrich_keeps_the_item_when_detail_fails():
    """⑬″ `enrich()`：详情拿不到时**不动** item（列表能给的照旧入库）。"""
    class _NoDetail(XiaohongshuPlatform):
        async def fetch_post_detail(self, note_id, xsec_token, client=None):
            return None

    pf = _NoDetail(cookies="a1=x; web_session=y", signer=FakeSigner())
    item = {"platform_post_id": "n1",
            "raw_json": json.dumps({"note_id": "n1", "xsec_token": "tok"}),
            "title": "只有标题"}
    assert asyncio.run(pf.enrich(item)) is False
    assert item["title"] == "只有标题" and "body_json" not in item


def test_registered_fetcher_carries_a_real_signer():
    """⑩ **注册表里那一个**必须带真签名器，且离线就能签出 `x-s`。

    回归背景（2026-10-02，devlog/277）：测试全都显式注入替身，而生产的模块级单例
    `fetcher = XiaohongshuPlatform()` 攥着 `NullSigner` ⇒ 请求**未签名**发出、
    上游一律 **HTTP 406**（"配了 cookie 却什么都抓不到"）。这条判据必须打在
    **注册表实例**上 —— 打在"我新建一个平台对象"上没有意义，缺口正是在注册表那一头。
    """
    from app.services.platforms.signing import NullSigner, XhsSigner

    pf = registry.get_fetcher("xiaohongshu")
    assert pf is not None and pf is xiaohongshu.fetcher, "注册表里不是那个模块级单例"
    assert not isinstance(pf._signer, NullSigner), \
        "注册表实例的签名器是 NullSigner ⇒ 线上会发未签名请求（全 406）"
    assert isinstance(pf._signer, XhsSigner)

    # 真签名（纯函数、不联网）：`a1` 是 xhshow 必需项，缺了会 SignerUnavailable
    signed = pf._signer.headers(
        method="GET", uri="/api/sns/web/v1/user_posted",
        params={"num": 30, "cursor": "", "user_id": "u1",
                "image_formats": "jpg,webp,avif", "xsec_source": "pc_user"},
        cookies="a1=1900abcdef; web_session=xyz")
    assert signed.get("x-s"), signed


def test_unsigned_signer_is_refused_before_the_request(caplog):
    """⑩′ 签名器产不出 `x-s` ⇒ **一个字节都不发**（宁可不抓，也不裸着发）。

    为什么要有这条：`NullSigner` 返回空字典**不报错**，于是"签名器没接上"会伪装成
    "请求正常、上游 406" —— 与平台改版同形，排查时看不出是接线问题（devlog/277）。
    """
    pf = XiaohongshuPlatform(cookies="a1=abc; web_session=xyz", signer=NullSigner())
    client = FakeClient([FakeResp()])
    with caplog.at_level("WARNING"):
        assert asyncio.run(pf.fetch_post_page("u1", None, client=client)) is None
    assert client.calls == [], "未签名的请求不许发出去"
    assert pf.last_error["kind"] == "signer_unavailable"
    assert any("不发未签名的请求" in r.message for r in caplog.records), caplog.text


# ── 身份级限速 / 四类响应接线（第 4 阶段 ⑤，devlog/237）──────────────────

def _ledger(clock: dict) -> identity_limit.Ledger:
    return identity_limit.Ledger(now=lambda: clock["t"])


def test_signer_shadow_probe_samples_once_and_never_blocks():
    """⑬ 影子比对（调研 §3.4.1）：每 TTL 抽一次；**判定不一致也照常返回主实现的头**。

    ⚠️ 这条盯的是"绝不禁用本地路径"：签名器坏了的正确表现是**告警 + 继续用**，
    而不是让整个平台停止工作（那才是"签名悄悄失效、数据静默变空"的另一种死法）。
    """
    from app.services.platforms.shadow import ShadowProbe
    from app.services.platforms.signing import XhsSigner

    clock = {"t": 1000.0}
    signer = XhsSigner(probe=ShadowProbe(ttl=600.0, now=lambda: clock["t"]))
    calls = {"n": 0}
    mode = {"arm": False, "changed": False}

    class FakeXhshow:
        """`arm` 之后**结构就变了**：主侧用旧结构、影子侧用新结构 ⇒ 常量必然不一致。

        这是真实回归的形状（依赖换版/平台改版发生在两次签名之间）；结构稳定的平时两边一致。
        """

        def sign_headers_get(self, uri, cookies, params=None):
            calls["n"] += 1
            # ⚠️ 顺序要紧：`arm` 表示"**下一次**签名起结构变了"（不是这次）——
            #    这样主侧用旧结构、影子侧用新结构，才是"回归发生在两次签名之间"的形状。
            # 变的必须是**结构常量**（前缀 / 头部长度档位）：只变 `x-s` 的内容不算 ——
            # 那里面本来就有噪声与时钟，比对刻意不看它（见 `xhs_stable_constants`）。
            prefix = "XYT" if mode["changed"] else "XYS"
            if mode["arm"]:
                mode["arm"] = False
                mode["changed"] = True
            return {"x-s": f"{prefix}_" + "a" * 16, "x-t": str(calls["n"]),
                    "x-s-common": "c" * 60}

        def sign_headers_post(self, uri, cookies, payload=None):
            return self.sign_headers_get(uri, cookies, params=payload)

    signer._sign = FakeXhshow()          # 等价于"依赖已装"（绕过懒加载）
    kw = dict(method="GET", uri="/api/sns/web/v1/user_posted",
              params={"user_id": "u1"}, cookies="a1=a; web_session=b")

    heads = signer.headers(**kw)
    assert heads["x-s"], "主实现的结果必须原样返回"
    assert signer.last_comparison is not None
    assert signer.last_comparison.verdict == "match"
    assert calls["n"] == 2, "抽样那一轮只多签一次（主侧复用真正发出去的那组头）"

    before = calls["n"]
    signer.headers(**kw)
    assert calls["n"] == before + 1, "TTL 内不该再抽（每次都签两次会白烧 CPU）"

    clock["t"] += 601
    mode["arm"] = True                   # 下次请求的主侧仍用旧结构，影子侧已用新结构
    heads2 = signer.headers(**kw)
    assert signer.last_comparison.verdict == "mismatch"
    assert signer.last_comparison.should_alert
    assert heads2["x-s"], "判定不一致**也不能**挡住签名（只告警，不禁用）"


def test_throttled_identity_sends_nothing_upstream():
    """⑩ 额度不够时**一个字节都不发**（连风控都不挨），并留下结构化的原因。

    反向验证：把 `_admit` 的返回值忽略掉 ⇒ 本用例红（会打出去一发）。
    """
    clock = {"t": 1000.0}
    pf = _pf(signer=FakeSigner(), ledger=_ledger(clock))
    client = FakeClient([FakeResp(), FakeResp()])

    assert asyncio.run(pf.fetch_post_page("u1", 1, client=client)) is not None
    assert len(client.calls) == 1

    # 同一个身份、同一个端点、时间没走 ⇒ 第二发被令牌桶挡下
    assert asyncio.run(pf.fetch_post_page("u1", "CUR1", client=client)) is None
    assert len(client.calls) == 1, "被节流时不该发请求"
    assert pf.last_error["kind"] == "identity_throttled"
    assert pf.last_error["retry_after"] > 0
    assert identity_limit.throttled(pf) is True

    # 时间走够 ⇒ 恢复正常（节流不是"坏了"）
    clock["t"] += 10
    assert asyncio.run(pf.fetch_post_page("u1", "CUR1", client=client)) is not None
    assert len(client.calls) == 2


def test_throttle_is_not_reported_as_a_network_failure():
    """⑪ 调度循环必须把"额度用完"与"上游故障"分开：前者不该出现在中断列表里。

    这条盯的是 `_fetch_platform_posts` 的 None 分支 —— 报成 `network_error`
    会让用户在报告里看到一处**根本没发生**的中断。
    """
    class ThrottledPf:
        platform = "xiaohongshu"
        last_error = {"kind": "identity_throttled"}

        async def fetch_post_page(self, uid, cursor=None, client=None):
            return None

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    result = asyncio.run(sch._fetch_platform_posts(ThrottledPf(), "u1", 1, db))
    assert result.stop_reason == "throttled"
    assert result.rate_limited is False
    db.close()


def test_response_classes_drive_the_ledger():
    """⑫ 四类响应真的按策略记账：风控扣身份分且不退令牌；网络错退令牌；业务失败两者都不。"""
    clock = {"t": 1000.0}
    ledger = _ledger(clock)
    pf = _pf(signer=FakeSigner(), ledger=ledger)
    ident = pf._identity()

    # 风控（403 兜底）⇒ 身份掉分
    client = FakeClient([FakeResp(status=403, payload={"success": False, "code": -1, "msg": ""})])
    assert asyncio.run(pf.fetch_post_page("u1", None, client=client)) is None
    h = ledger.health(ident)
    assert h.risk == 1 and h.consecutive_fails == 1 and h.score < 1.0

    # 上游 5xx ⇒ 网络错：不入健康度、退还令牌（下一发立刻能走）
    clock["t"] += 10
    client = FakeClient([FakeResp(status=502, payload={"success": False, "code": -2, "msg": "boom"})])
    assert asyncio.run(pf.fetch_post_page("u1", "C1", client=client)) is None
    h2 = ledger.health(ident)
    assert h2.network == 1 and h2.risk == 1 and h2.score == h.score
    assert ledger.acquire(ident, "user_posted").allowed, "网络错必须退还令牌"

    # "业务失败"（纯 404 且无风控字样）⇒ 健康度不动
    clock["t"] += 10
    client = FakeClient([FakeResp(status=404, payload={"success": False, "code": -3, "msg": "not found"})])
    assert asyncio.run(pf.fetch_post_page("u1", "C2", client=client)) is None
    h3 = ledger.health(ident)
    assert h3.samples == h2.samples and h3.score == h2.score, "业务失败不该动身份健康度"
