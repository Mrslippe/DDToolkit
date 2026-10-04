"""抖音适配的判据（第 4 阶段 ④ 第二刀，devlog/334；口径来自 D1 spike `devlog/333`）。

**不碰网络**：签名用的是**真签名器**（纯 Python，vendored；比替身更有信息量），
HTTP 走记录式假 client。钉的是这一刀真正的风险点：

① `a_bogus` 格式自洽（含"自检有牙口"：自检不过时**一个请求都不发**）；
② **失败分类**：200 + 空体是"签名被拒"而不是"这个号没作品"；帖子不存在是**业务失败**、
   **不许**扣身份健康度；验证码是 `captcha` 且立即停；
③ `platform_post_id` 全程字符串、cursor 不透明、`has_more` 1/0；
④ 没配 cookie ⇒ 零请求；额度不够 ⇒ 零请求。
"""
import asyncio
import hashlib
import json
import re
from pathlib import Path

import pytest

from app.services import identity_limit
from app.services.platforms import douyin
from app.services.platforms.douyin import (DouyinPlatform, classify_http, classify_payload,
                                           parse_aweme, parse_user_info, sec_uid_from_input)
from app.services.platforms.signing import DouyinSigner, SignerUnavailable

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0")
COOKIE = ("UIFID=" + "a" * 384 + "; UIFID_TEMP=" + "b" * 224
          + "; s_v_web_id=verify_test_0123456789abcdef; ttwid=1%7Ctest")

SEC_UID = "MS4wLjABAAAAYbIZRpNPRPJ28dxKRyqtmQXtxN5EC_uAfePn3mPehcQ"
AWEME_ID = "7692759522204795110"          # 19 位：超 JS 安全整数

IMAGE_AWEME = {
    "aweme_id": AWEME_ID,
    "desc": "开嘟😭\n#维斯塔潘 #红牛车队",
    "create_time": 1791110151,
    "images": [{"url_list": ["https://p3-pc-sign.douyinpic.com/a.jpg"], "width": 1080,
                "height": 1440}],
    "video": {"duration": 0, "ratio": "default"},        # 图文帖也带 video（D1 实测）
    "statistics": {"digg_count": 385, "comment_count": 87, "share_count": 41,
                   "collect_count": 10, "play_count": 0},  # 播放量是常量 0
    "author": {"nickname": "Sulli", "sec_uid": SEC_UID},
    "text_extra": [{"hashtag_name": "维斯塔潘"}],
}

VIDEO_AWEME = {
    "aweme_id": 7689696714844174446,                     # 故意给整数
    "desc": "视频帖",
    "create_time": 1790397036,
    "video": {"duration": 15000, "play_addr": {"url_list": ["https://v11-weba.douyinvod.com/v.mp4"]},
              "cover": {"url_list": ["https://p9-pc-sign.douyinpic.com/c.jpg"]}},
    "statistics": {"digg_count": 12},
    "author": {"nickname": "Sulli", "sec_uid": SEC_UID},
}


# ── 测试替身 ──────────────────────────────────────────────────────────

class FakeResp:
    def __init__(self, status=200, payload=None, body: bytes | None = None, headers=None):
        self.status_code = status
        self._payload = payload
        self.content = body if body is not None else json.dumps(
            payload if payload is not None else {}).encode()
        self.headers = dict(headers or {})

    def json(self):
        return self._payload


class FakeClient:
    """记录每一次请求（URL 原文 + 头），按顺序返回预设响应。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[tuple[str, dict]] = []

    async def get(self, url, headers=None):
        self.calls.append((url, dict(headers or {})))
        return self.responses.pop(0) if self.responses else FakeResp()

    async def aclose(self):
        pass


def _pf(**kw) -> DouyinPlatform:
    kw.setdefault("cookie", COOKIE)
    kw.setdefault("user_agent", UA)
    kw.setdefault("ledger", identity_limit.Ledger(now=lambda: 1000.0))
    return DouyinPlatform(**kw)


@pytest.fixture(autouse=True)
def _douyin_on(monkeypatch):
    """本文件默认把**总开关打开**（生产默认是关的，见 `test_disabled_switch_*`）。

    ⚠️ 打的是 `runtime_settings.get`（**真读路径**），不是把 `DouyinPlatform._enabled` 换成常量 ——
    否则"开关到底怎么读"这段代码在本文件里一次都不会被执行。
    """
    from app.core import runtime_settings

    real = runtime_settings.get
    monkeypatch.setattr(runtime_settings, "get",
                        lambda key: True if key == "DOUYIN_ENABLED" else real(key))


def _switch(monkeypatch, value: bool) -> None:
    """把总开关钉成 `value`（同一处真读路径）。"""
    from app.core import runtime_settings

    real = runtime_settings.get
    monkeypatch.setattr(runtime_settings, "get",
                        lambda key: value if key == "DOUYIN_ENABLED" else real(key))


def _cookies() -> dict[str, str]:
    return douyin._cookies_of(COOKIE)


# ── ① 签名器与 vendored 代码 ───────────────────────────────────────────

def test_vendored_files_match_the_notice_table():
    """vendored 的三个文件必须与 `NOTICE.md` 登记的一致（改了就得回来更新表）。"""
    vendor = Path(douyin.__file__).parent / "vendor" / "dtksign"
    expected = {
        "abogus.py": "549b00701fcf8f417c0bdafc277762fcb7d4490d6c87c04450960e7606c5f5b6",
        "sm3.py": "6ad3947e11670a2bdb1fd33980f1d3da007b76421b79c95a1586455c02069669",
        "websign.py": "b31e1809de52e43f8098cbc903746d342b2128d56907542ca118af56d9c6010b",
    }
    for name, digest in expected.items():
        actual = hashlib.sha256((vendor / name).read_bytes()).hexdigest()
        assert actual == digest, f"{name} 被改过了 —— 更新 NOTICE.md 的表，或还原"
    notice = (vendor / "NOTICE.md").read_text(encoding="utf-8")
    assert "Apache" in notice and "4f0bed84" in notice, "来源/许可必须留在 NOTICE.md 里"


def test_a_bogus_is_selfconsistent_and_order_is_the_platforms():
    """六个参数与三个头都在；顺序是**平台的**：业务参数 → a_bogus → verifyFp/fp → secsdk。"""
    signed = DouyinSigner(UA).sign_query({"device_platform": "webapp", "aid": "6383"},
                                        cookies=_cookies())
    q = signed.query
    from urllib.parse import unquote

    from app.services.platforms.vendor.dtksign import structure_error

    # ⚠️ 线上形态是**百分号编码**的（s4 字母表里有 `/`，padding 是 `=` ⇒ 必须编码），
    #    所以要 unquote 回来才是那条签名本身
    bogus = unquote(re.search(r"a_bogus=([^&]+)", q).group(1))
    assert structure_error(bogus) is None, "自己签出来的 a_bogus 结构不自洽"
    assert "%2F" in q or "%3D" in q, "签名里的 / 与 = 必须编码（否则 query 会被截断）"
    assert q.index("a_bogus=") < q.index("verifyFp=") < q.index("&fp=") < q.index("timestamp=")
    assert set(signed.headers) >= {"uifid", "x-secsdk-web-signature", "x-secsdk-web-expire"}
    assert len(signed.headers["x-secsdk-web-signature"]) == 32
    assert "msToken=" in q, "msToken 是请求参数（D1 抓包实测）—— 该带上"
    # secsdk 签的是"到目前为止的整条 query"：它必须排在最后
    assert q.rstrip().endswith("x-secsdk-web-signature=" + signed.headers["x-secsdk-web-signature"])


def test_verify_fp_comes_from_the_cookie_not_invented():
    """`verifyFp`/`fp` 必须是 cookie 里 `s_v_web_id` 的原值（自造 ⇒ 真机 200+空体）。"""
    signed = DouyinSigner(UA).sign_query({"aid": "6383"}, cookies=_cookies())
    assert "verifyFp=verify_test_0123456789abcdef" in signed.query
    assert "&fp=verify_test_0123456789abcdef" in signed.query


def test_missing_uifid_is_a_loud_failure():
    with pytest.raises(SignerUnavailable) as e:
        DouyinSigner(UA).sign_query({"aid": "6383"}, cookies={"s_v_web_id": "x"})
    assert "uifid" in str(e.value)


def test_a_bogus_that_is_not_a_signature_blocks_the_request(monkeypatch):
    """自检报"**这根本不是 a_bogus**"（`is_decode_problem`）⇒ 硬停，**一个请求都不发**。

    反面对照（正对照）在下面那条：只是"内容不符预期"时**照发**。
    """
    from app.services.platforms.vendor import dtksign

    client = FakeClient([FakeResp(payload={"status_code": 0, "aweme_list": [IMAGE_AWEME]})])
    ok = asyncio.run(_pf().fetch_post_page(SEC_UID, None, client=client))
    assert ok and len(client.calls) == 1, "正对照：正常情况下确实会发一发"

    monkeypatch.setattr(dtksign, "structure_error", lambda value: "alphabet")
    client2 = FakeClient([FakeResp(payload={"status_code": 0, "aweme_list": [IMAGE_AWEME]})])
    pf = _pf()
    out = asyncio.run(pf.fetch_post_page(SEC_UID, None, client=client2))
    assert out is None and client2.calls == [], "不是 a_bogus 时不许把请求发出去"
    assert pf.last_error["kind"] == "signer_unavailable"
    assert identity_limit.outcome_for_kind(pf.last_error["kind"]) == "network_error"


def test_decoder_ambiguity_does_not_block_the_request(monkeypatch):
    """⚠️ 自检报"内容不符预期"（如 `declared lengths overrun the frame`）⇒ **照发**。

    实测（2026-10-04，300 条签名）：`structure_error` 会以约 **1/300** 的概率对我们**自己刚签出来的**
    签名报这一条 —— 那是解码器的已知歧义（噪声展开补的一组字节与真实数据不可区分），不是签名坏了。
    把它当硬闸门 ⇒ 每 300 次静默少发一发，报的还是"签名器与平台对不上"。
    判据：重签用完后仍然照发（平台才是权威），且**不留** `signer_unavailable`。
    """
    from app.services.platforms import signing as S
    from app.services.platforms.vendor import dtksign

    monkeypatch.setattr(dtksign, "structure_error",
                        lambda value: "declared lengths overrun the frame")
    calls: list[int] = []
    original = S.DouyinSigner._bogus

    def counting(self, query, *, body="", content_type=""):
        calls.append(1)
        return original(self, query, body=body, content_type=content_type)

    monkeypatch.setattr(S.DouyinSigner, "_bogus", counting)
    client = FakeClient([FakeResp(payload={"status_code": 0, "aweme_list": [IMAGE_AWEME]})])
    pf = _pf()
    out = asyncio.run(pf.fetch_post_page(SEC_UID, None, client=client))

    assert out is not None and len(client.calls) == 1, "歧义不该拦住请求"
    # ⚠️ 不写成 `== SELFCHECK_TRIES`：影子比对（首见即比）会**再签一次** ⇒ 计数翻倍
    assert len(calls) >= S.SELFCHECK_TRIES, "应该先重签几次再放弃自检"
    assert len(calls) % S.SELFCHECK_TRIES == 0, "每次签名都该把重签额度用满"
    assert (pf.last_error or {}).get("kind") != "signer_unavailable"


def test_shadow_comparison_matches_and_flags_structural_drift():
    """影子比对：两次自洽签名 ⇒ match；被改坏的 a_bogus ⇒ 摘出来的常量能看出问题。

    ⚠️ 反面样本必须是**确定性**的破坏。写这条时先用了"翻中间一位"，结果它**时红时不红**
    （30 次里 3 次通过）—— 那一位偶尔落在噪声/尾部，**校验和覆盖不到它**。
    这不是 bug 而是这条自检的**已知强度**：本地结构自检**弱于**平台侧
    （D1 相位 3 的 `guest_wrong_abogus` 证明：改一位的值平台会回 200+空体，
    而我们的 `structure_error` 可能判它"自洽"）。所以两道都要有：
    本地自检挡"格式崩了"（算法/字节表改坏），平台侧的 200+空体挡"值不对"。
    """
    from app.services.platforms.shadow import (ShadowProbe, douyin_stable_constants)
    from app.services.platforms.signing import _query_shape

    signer = DouyinSigner(UA, probe=ShadowProbe(ttl=0.0, now=lambda: 1000.0))
    first = signer.sign_query({"aid": "6383"}, cookies=_cookies())
    assert signer.last_comparison is not None
    assert signer.last_comparison.verdict == "match", signer.last_comparison.detail
    shape = _query_shape(first)
    good = douyin_stable_constants(shape)
    assert good["a_bogus.problem"] == "none" and good["secsdk.hexish32"] is True

    # 确定性破坏①：截断（长度不再是 4 的倍数）
    truncated = dict(shape, a_bogus=str(shape["a_bogus"])[:-4])
    assert douyin_stable_constants(truncated)["a_bogus.problem"] != "none", "自检没牙齿（截断）"
    # 确定性破坏②：整串乱填（头/版本块对不上）
    garbage = dict(shape, a_bogus="A" * len(str(shape["a_bogus"])))
    assert douyin_stable_constants(garbage)["a_bogus.problem"] != "none", "自检没牙齿（乱填）"
    assert douyin_stable_constants({"a_bogus": "x"}) == {}, "半个签名器 ⇒ 未比对（不是失败）"


# ── ② 失败分类（这一刀的核心）──────────────────────────────────────────

def test_empty_body_is_signature_rejected_not_success():
    """D1 实测：签名无效/被拒 = **HTTP 200 + 0 字节**（不是 403，也不是"没有作品"）。"""
    assert classify_payload(None, body_len=0, expect="list") == "signature_invalid"
    assert classify_http(200, payload=None, body_len=0, expect="list") == "signature_invalid"
    assert identity_limit.outcome_for_kind("signature_invalid") == "network_error"


def test_empty_aweme_list_is_a_legit_empty_account():
    """空列表是合法的（这个号确实没作品）—— 与空体**必须**分开。"""
    assert classify_payload({"status_code": 0, "aweme_list": []},
                            body_len=20, expect="list") == "ok"
    assert classify_payload({"status_code": 0}, body_len=20, expect="list") == "signature_invalid"


def test_nonexistent_post_is_business_error_and_does_not_damage_the_identity():
    """计划点名的那个坑：`200 + aweme_detail: null` **不许**当成风控（会白白冷却身份）。"""
    assert classify_payload({"status_code": 0, "aweme_detail": None},
                            body_len=30, expect="detail") == "not_found"
    assert identity_limit.outcome_for_kind("not_found") == "business_error"

    ledger = identity_limit.Ledger(now=lambda: 1000.0)
    pf = _pf(ledger=ledger)
    client = FakeClient([FakeResp(payload={"status_code": 0, "aweme_detail": None})])
    assert asyncio.run(pf.fetch_post_detail(AWEME_ID, client=client)) is None
    assert pf.last_error["kind"] == "not_found"
    identity = identity_limit.identity_key("douyin", COOKIE)
    assert ledger.health(identity).consecutive_fails == 0
    assert ledger.health(identity).risk == 0
    assert ledger.health(identity).business == 1, "业务失败要记进诊断账本，但不动健康度"


def test_risk_codes_captcha_and_not_login_are_distinguishable():
    assert classify_payload({"status_code": 8}, body_len=20, expect="list") == "risk_control"
    assert identity_limit.outcome_for_kind("risk_control") == "risk_control"
    assert classify_payload({"status_code": 2483}, body_len=20, expect="list") == "cookie_invalid"
    # 验证码：三种证据（状态码 / 响应头 / 响应体字段）都要认
    assert classify_http(461, body_len=0) == "captcha"
    assert classify_http(471, body_len=0) == "captcha"
    assert classify_http(200, headers={"Verifytype": "1"}, payload={"status_code": 0},
                         body_len=9) == "captcha"
    assert classify_payload({"status_code": 0, "verify_center_decision_conf": {}},
                            body_len=40, expect="list") == "captcha", \
        "`verify_center_decision_conf` 按键在判（空对象也算）"
    assert classify_payload({"status_code": 0, "captcha": False, "aweme_list": []},
                            body_len=40, expect="list") == "ok", \
        "`captcha: false` 是正常响应 —— 按真值判，否则每一发都会被当成验证码"
    assert identity_limit.outcome_for_kind("captcha") == "risk_control"


def test_403_root_causes_stay_distinguishable():
    """调研 §3.6 的 403 根因（本网关 2026-10-04 没复现，但出现了要认得出）。"""
    assert classify_http(403, body_head="Blocked by ArgusSecurityPlugin Uifid Not Found",
                         body_len=50) == "argus_missing"
    assert classify_http(403, body_head="Sign Invalid", body_len=12) == "signature_invalid"
    assert classify_http(403, body_head="Signature Not Found", body_len=19) == "signature_invalid"
    for kind in ("argus_missing", "signature_invalid"):
        assert identity_limit.outcome_for_kind(kind) == "network_error"


# ── ③ 字段映射 ────────────────────────────────────────────────────────

def test_items_map_fields_and_ids_stay_strings():
    item = parse_aweme(IMAGE_AWEME, SEC_UID)
    assert item["platform"] == "douyin" and item["platform_post_id"] == AWEME_ID
    assert isinstance(item["platform_post_id"], str)
    assert item["type"] == "image", "图文帖靠 `images` 判（带 video 也不算视频）"
    assert item["title"] == "开嘟😭" and "维斯塔潘" in item["summary"]
    assert item["permalink"].endswith(f"/note/{AWEME_ID}")
    assert item["published_at"].isoformat() == "2026-10-04T10:35:51", \
        "`create_time` 是**秒**级时间戳（D1 实测 1791110151），落库是 naive UTC"
    stats = json.loads(item["stats_json"])
    assert stats["digg"] == 385 and "play" not in json.dumps(stats), \
        "播放量是常量 0 —— 记下来就是写一个平台没说过的事实"

    video = parse_aweme(VIDEO_AWEME, SEC_UID)
    assert video["type"] == "video" and video["platform_post_id"] == "7689696714844174446"
    assert json.loads(video["body_json"])["video"]["duration_s"] == 15.0


def test_aweme_id_survives_a_json_round_trip():
    """计划判据：19 位 id 中间过一次 JSON 往返仍逐字相等（转 Number 会静默丢精度）。"""
    item = parse_aweme(IMAGE_AWEME, SEC_UID)
    again = json.loads(json.dumps({"platform_post_id": item["platform_post_id"]}))
    assert again["platform_post_id"] == AWEME_ID == "7692759522204795110"
    assert isinstance(again["platform_post_id"], str)
    assert str(json.loads(item["raw_json"])["aweme_id"]) == AWEME_ID


def test_body_json_speaks_the_shared_contract():
    """`body_json` 是**跨模块契约**：媒体固化按它取对象、卡片按它显时长。

    这条直接调 `assets._media_urls`（而不是自己再解析一遍 JSON）—— 那才是真读者。
    写错的样子是**静默**的：抖音视频永远不被固化、卡片上没有时长角标（devlog/335）。
    """
    from app.services import assets

    image = json.loads(parse_aweme(IMAGE_AWEME, SEC_UID)["body_json"])
    assert assets._media_urls(json.dumps(image), video=False) == \
        ["https://p3-pc-sign.douyinpic.com/a.jpg"], "图文帖的图必须能被固化器看见"
    assert image["video"] is None or not image["video"].get("url"), "图文帖没有可固化的视频"

    video_item = parse_aweme(VIDEO_AWEME, SEC_UID)
    body = json.loads(video_item["body_json"])
    assert assets._media_urls(video_item["body_json"], video=True) == \
        ["https://v11-weba.douyinvod.com/v.mp4"], "视频必须能被固化器看见"
    assert body["video"]["url"] == "https://v11-weba.douyinvod.com/v.mp4"
    assert isinstance(body["video"]["fallbacks"], list), "fallback 链要是列表（前端沿链换源）"
    # 抖音给的是**毫秒**，合同要的是**秒**（`PostBodyJson.video.duration_s` / `PostCard`）
    assert body["video"]["duration_s"] == 15.0 and body["duration_sec"] == 15.0


def test_user_info_mapping():
    payload = {"status_code": 0, "user": {"sec_uid": SEC_UID, "uid": "123", "nickname": "Sulli",
                                          "signature": "签名", "follower_count": 12345,
                                          "following_count": 6, "aweme_count": 78,
                                          "avatar_larger": {"url_list": ["https://a/b.jpg"]}}}
    info = parse_user_info(payload, SEC_UID)
    assert info["name"] == "Sulli" and info["followers_count"] == 12345
    assert info["post_count"] == 78 and info["uid"] == SEC_UID
    assert info["url"] == f"https://www.douyin.com/user/{SEC_UID}"


def test_sec_uid_parsing_accepts_links_and_refuses_handles():
    assert sec_uid_from_input(f"https://www.douyin.com/user/{SEC_UID}?tab=post") == SEC_UID
    assert sec_uid_from_input(f"看看这个 {SEC_UID} 的主页") == SEC_UID
    assert sec_uid_from_input("1234567890") == "", "抖音号要搜索接口：不许猜"


# ── ④ 请求链路 ────────────────────────────────────────────────────────

def test_posts_page_signs_and_maps_cursor():
    client = FakeClient([FakeResp(payload={"status_code": 0, "has_more": 1,
                                           "max_cursor": 1789041422000,
                                           "aweme_list": [IMAGE_AWEME, VIDEO_AWEME]})])
    out = asyncio.run(_pf().fetch_post_page(SEC_UID, None, client=client))
    url, headers = client.calls[0]
    assert "a_bogus=" in url and "x-secsdk-web-signature" in url
    assert headers["x-tt-argus"] == "1" and headers["Cookie"] == COOKIE
    assert f"sec_user_id={SEC_UID}" in url and "max_cursor=0" in url and "count=20" in url
    assert headers["User-Agent"] == UA
    assert out["has_more"] is True and out["next_cursor"] == "1789041422000"
    assert len(out["items"]) == 2


def test_cursor_is_opaque_and_comes_back_verbatim():
    """核心不解析 cursor：这一发把上一页给的 `max_cursor` 原样带回去。"""
    client = FakeClient([
        FakeResp(payload={"status_code": 0, "has_more": 1, "max_cursor": 1789041422000,
                          "aweme_list": [IMAGE_AWEME]}),
        FakeResp(payload={"status_code": 0, "has_more": 0, "max_cursor": 1787395602000,
                          "aweme_list": [VIDEO_AWEME]}),
    ])
    clock = {"t": 1000.0}
    pf = _pf(ledger=identity_limit.Ledger(now=lambda: clock["t"]))
    first = asyncio.run(pf.fetch_post_page(SEC_UID, None, client=client))
    clock["t"] += 10.0            # 令牌桶按 0.12/s 补：等足 10s 才有第二发
    second = asyncio.run(pf.fetch_post_page(SEC_UID, first["next_cursor"], client=client))
    assert "max_cursor=1789041422000" in client.calls[1][0]
    assert second["has_more"] is False and second["next_cursor"] is None, \
        "到底了就不给 cursor（has_more=False）"


def test_has_more_zero_is_not_truthy_confusion():
    client = FakeClient([FakeResp(payload={"status_code": 0, "has_more": 0,
                                           "max_cursor": 123, "aweme_list": [IMAGE_AWEME]})])
    out = asyncio.run(_pf().fetch_post_page(SEC_UID, None, client=client))
    assert out["has_more"] is False and out["next_cursor"] is None


def test_no_cookie_means_zero_requests():
    """闸门：没配 cookie 时**一个字节都不发**（正对照见上面那几条会发的用例）。"""
    client = FakeClient([FakeResp(payload={"status_code": 0, "aweme_list": []})])
    pf = DouyinPlatform(cookie="", user_agent=UA, ledger=identity_limit.Ledger())
    assert asyncio.run(pf.fetch_post_page(SEC_UID, None, client=client)) is None
    assert client.calls == []
    assert pf.last_error["kind"] == "cookie_invalid"


def test_captcha_is_recorded_and_stops():
    client = FakeClient([FakeResp(status=461, body=b"", headers={"Verifytype": "1"}),
                         FakeResp(payload={"status_code": 0, "aweme_list": [IMAGE_AWEME]})])
    pf = _pf()
    assert asyncio.run(pf.fetch_post_page(SEC_UID, None, client=client)) is None
    assert pf.captcha_seen is True and pf.last_error["kind"] == "captcha"
    assert len(client.calls) == 1, "验证码之后不许再发"


def test_empty_body_response_is_signature_invalid_and_refunds_the_token():
    client = FakeClient([FakeResp(body=b"")])
    ledger = identity_limit.Ledger(now=lambda: 1000.0)
    pf = _pf(ledger=ledger)
    assert asyncio.run(pf.fetch_post_page(SEC_UID, None, client=client)) is None
    assert pf.last_error["kind"] == "signature_invalid"
    assert "空体" in pf.last_error["msg"]
    identity = identity_limit.identity_key("douyin", COOKIE)
    assert ledger.health(identity).risk == 0 and ledger.health(identity).consecutive_fails == 0


def test_throttle_blocks_the_second_request():
    """身份级限速：`author_posts` 是 0.12 req/s ⇒ 同一身份连着第二次**不发**。"""
    ledger = identity_limit.Ledger(now=lambda: 1000.0)      # 时钟不动 = 没有新令牌
    pf = _pf(ledger=ledger)
    client = FakeClient([FakeResp(payload={"status_code": 0, "aweme_list": [IMAGE_AWEME]})])
    assert asyncio.run(pf.fetch_post_page(SEC_UID, None, client=client)) is not None
    assert asyncio.run(pf.fetch_post_page(SEC_UID, None, client=client)) is None
    assert len(client.calls) == 1, "额度不够时一个字节都不发"
    assert pf.last_error["kind"] == "identity_throttled"


def test_bare_douyin_handle_is_unsupported_and_sends_nothing():
    client = FakeClient([])
    pf = _pf()
    assert asyncio.run(pf.fetch_user_info("1234567890", client=client)) is None
    assert client.calls == [] and pf.last_error["kind"] == "unsupported_input"
    assert identity_limit.outcome_for_kind("unsupported_input") == "business_error"


# ── 总开关（DOUYIN_ENABLED，默认关；devlog/335）────────────────────────

def test_disabled_switch_sends_nothing_on_every_path(monkeypatch):
    """总开关关着 ⇒ **三条路都一个字节都不发**（不是"抓了不用"）。

    它必须在 `_admit` 这个唯一入口上：账号信息 / 作品 / 详情都要过它，
    将来加端点也漏不掉。反面对照：上面的用例（开关打开）都真的发了请求。
    """
    _switch(monkeypatch, False)
    client = FakeClient([FakeResp(payload={"status_code": 0, "aweme_list": [IMAGE_AWEME]})])
    pf = _pf()
    assert asyncio.run(pf.fetch_post_page(SEC_UID, None, client=client)) is None
    assert asyncio.run(pf.fetch_user_info(SEC_UID, client=client)) is None
    assert asyncio.run(pf.fetch_post_detail(AWEME_ID, client=client)) is None
    assert asyncio.run(pf.enrich(parse_aweme(IMAGE_AWEME, SEC_UID), client=client)) is False
    assert client.calls == [], "开关关着时不许有任何请求"
    assert pf.last_error["kind"] == "douyin_disabled"
    assert "设置" in pf.last_error["msg"], "要说清去哪打开"
    assert identity_limit.outcome_for_kind("douyin_disabled") == "network_error"


def test_switch_is_read_per_call_not_cached(monkeypatch):
    """开关是**可热更**的：打开之后下一轮就生效，不需要重启工具（这是"默认关"能被接受的前提）。"""
    _switch(monkeypatch, False)
    client = FakeClient([FakeResp(payload={"status_code": 0, "aweme_list": [IMAGE_AWEME]})])
    pf = _pf()
    assert asyncio.run(pf.fetch_post_page(SEC_UID, None, client=client)) is None
    _switch(monkeypatch, True)
    assert asyncio.run(pf.fetch_post_page(SEC_UID, None, client=client)) is not None
    assert len(client.calls) == 1


def test_switch_default_is_off():
    """默认值必须是**关**（合规口径：配了凭据 ≠ 要在后台一直抓）。"""
    from app.core import runtime_settings

    assert runtime_settings.default_of("DOUYIN_ENABLED") is False
    assert runtime_settings.spec("DOUYIN_ENABLED").kind == "bool"


def test_user_profile_request_is_signed():
    client = FakeClient([FakeResp(payload={"status_code": 0, "user": {"sec_uid": SEC_UID,
                                                                     "nickname": "Sulli"}})])
    info = asyncio.run(_pf().fetch_user_info(SEC_UID, client=client))
    url = client.calls[0][0]
    assert info["name"] == "Sulli"
    assert "/aweme/v1/web/user/profile/other/" in url and "a_bogus=" in url


def test_enrich_merges_detail_and_keeps_the_item():
    client = FakeClient([FakeResp(payload={"status_code": 0, "aweme_detail": {
        "aweme_id": AWEME_ID, "desc": "详情里的更长文案",
        "images": [{"url_list": ["https://p3-pc-sign.douyinpic.com/new.jpg"]}]}})])
    item = parse_aweme(IMAGE_AWEME, SEC_UID)
    before_id = item["platform_post_id"]
    assert asyncio.run(_pf().enrich(item, client=client)) is True
    assert item["platform_post_id"] == before_id == AWEME_ID
    assert item["summary"] == "详情里的更长文案"
    assert "new.jpg" in item["body_json"]


def test_enrich_failure_never_drops_the_item():
    client = FakeClient([FakeResp(status=500, body=b"boom")])
    item = parse_aweme(IMAGE_AWEME, SEC_UID)
    snapshot = dict(item)
    assert asyncio.run(_pf().enrich(item, client=client)) is False
    assert item == snapshot, "详情没拉到绝不能让列表给的数据变形/丢失"
