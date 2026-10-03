# -*- coding: utf-8 -*-
"""B站取流（devlog/289）的判据：**默认 DASH、错误如实分类、凭据不外泄**。

这些都是真机踩出来的口径（2026-10-03 实测）：fnval=16 才有 1080P；媒体 CDN 不带 Referer 403；
playurl 的失败码要分成"不存在/无权限/风控"三类，别一律说"没拉到"。
"""
import asyncio
import json

import httpx
import pytest

from app.services import bili_play


@pytest.fixture(autouse=True)
def _clean():
    bili_play.clear_cache()
    yield
    bili_play.clear_cache()


class _FakeResp:
    def __init__(self, payload, status=200):
        self._payload, self.status_code = payload, status

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class _FakeClient:
    """按 URL 分发：记下最后一次请求的 params/headers（断言用）。"""

    def __init__(self, routes):
        self.routes = routes
        self.calls: list[tuple[str, dict, dict]] = []

    async def get(self, url, params=None, headers=None):
        self.calls.append((url, dict(params or {}), dict(headers or {})))
        for frag, resp in self.routes.items():
            if frag in url:
                return resp if not callable(resp) else resp(params)
        return _FakeResp({"code": -404, "message": "啥都木有"})

    async def aclose(self):
        return None


def _view(cid=40562460106):
    return _FakeResp({"code": 0, "data": {"cid": cid, "title": "t", "duration": 39}})


def _playurl(**data):
    base = {"quality": 80, "accept_quality": [116, 80, 64], "accept_description":
            ["高清 1080P60", "高清 1080P", "高清 720P"],
            "dash": {"video": [{"id": 80, "baseUrl": "https://cdn/v.m4s", "width": 1920,
                                "height": 1080, "codecs": "avc1", "bandwidth": 1,
                                "backupUrl": ["https://bak/v.m4s"]}],
                     "audio": [{"id": 30280, "baseUrl": "https://cdn/a.m4s"}]},
            "durl": [{"url": "https://cdn/v.mp4", "size": 3792632, "length": 38016}]}
    base.update(data)
    return _FakeResp({"code": 0, "data": base})


def _client(**kw):
    return _FakeClient({"playurl": _playurl(**kw), "view": _view()})


def test_defaults_to_dash_with_top_quality_and_durl_is_a_separate_call():
    """① 默认 `fnval=16` + **显式要最高档**（不传 qn 只给 720P，实测）；
    ② durl 与 DASH **互斥**：回落是**另一次** `fnval=1` 调用，不是同一次带着。"""
    c = _client()
    out = asyncio.run(bili_play.play_info("BV1", client=c))

    _, params, _ = [x for x in c.calls if "playurl" in x[0]][0]
    assert params["fnval"] == bili_play.FNVAL_DASH == 16
    assert params["qn"] == bili_play.DEFAULT_QN == 120, "要最高档，让 B站按权益回落"
    assert params["fourk"] == 1
    assert out["kernel"] == "dash"
    assert out["dash"]["video"][0]["height"] == 1080
    # `quality` 是**实际拿到**的档（这里 80=1080P），前端照它显示
    assert out["quality"] == 80
    assert out["accept"][0] == {"id": 116, "label": "高清 1080P60"}

    # 回落：另发一次，换成 fnval=1
    out2 = asyncio.run(bili_play.play_info("BV1", durl_fallback=True, client=c))
    _, params2, _ = [x for x in c.calls if "playurl" in x[0]][1]
    assert params2["fnval"] == bili_play.FNVAL_DURL == 1
    assert out2["kernel"] == "durl" and out2["durl"][0]["url"].endswith(".mp4")


def test_media_request_carries_referer_but_never_logs_credentials(monkeypatch):
    """② 取流请求要带 `Referer`（媒体 CDN 不带就 403），**凭据只进请求头**。"""
    monkeypatch.setattr(bili_play.auth_manager, "sessdata", "SENTINEL-SESSDATA")
    c = _client()
    out = asyncio.run(bili_play.play_info("BV1", client=c))

    sent = [h for u, _p, h in c.calls if "playurl" in u][0]
    assert sent.get("Referer") == "https://www.bilibili.com/"
    assert "SENTINEL-SESSDATA" in sent.get("Cookie", ""), "凭据没带上 ⇒ 只能拿到游客档"
    # ③ 返回值里**绝不能**出现凭据（会被前端状态/日志带出去）
    assert "SENTINEL-SESSDATA" not in json.dumps(out, ensure_ascii=False)


@pytest.mark.parametrize("code,kind,needle", [
    (-404, "not_found", "不存在"),
    (-403, "forbidden", "权限"),
    (-352, "risk_control", "风控"),
    (-500, "failed", "取流失败"),
])
def test_playurl_errors_are_classified(code, kind, needle):
    """④ 失败要**如实分类**：不存在 / 无权限 / 风控 是三种处置，别混成一句"没拉到"。"""
    c = _FakeClient({"view": _view(),
                     "playurl": _FakeResp({"code": code,
                                           "message": "" if code == -500 else "x"})})
    with pytest.raises(bili_play.PlayError) as ei:
        asyncio.run(bili_play.play_info("BV1", client=c))
    assert ei.value.kind == kind and needle in ei.value.message
    assert ei.value.code == code


def test_missing_cid_is_an_error_not_silence():
    """⑤ 拿不到 cid 要报错（静默返回空会让前端"点了没反应"）。"""
    c = _FakeClient({"view": _FakeResp({"code": 0, "data": {}})})
    with pytest.raises(bili_play.PlayError):
        asyncio.run(bili_play.resolve_video("BV1", client=c))


def test_short_cache_blocks_double_clicks():
    """⑥ 短缓存：连点/重开不重复打上游（地址本身短时效，不做预取）。"""
    c = _client()
    asyncio.run(bili_play.play_info("BV1", client=c))
    asyncio.run(bili_play.play_info("BV1", client=c))
    assert len([1 for u, _p, _h in c.calls if "playurl" in u]) == 1


# ── 镜像排序：真机实测"每一条流的 baseUrl 都是 P2P/mcdn"（devlog/294）────────────
#
# 现场（用户真机 2026-10-03，BV16tHY6UEid）：`baseUrl` 全是 `xy*.mcdn.bilivideo.cn`，
# 而 `/video-proxy` 的白名单只认平台自家域名 ⇒ 前端拿 `baseUrl` 去代理被 **400** 挡回，
# 表现是"全部都播不了"。`backupUrl` 里其实有能过的 `upos-*.bilivideo.com`。
# ⇒ 取流侧负责**排序**：先能过代理的、且优先普通 CDN（mcdn 是 P2P，排在白名单里的后面）。

_MCDN = "https://xy39x174x255x9xy.mcdn.bilivideo.cn:8082/v1/resource/a.m4s?e=x"
_P2P = "https://b-baa0.edge.mountaintoys.cn/upgcxcode/a.m4s?e=x"
_UPOS = "https://upos-sz-estgoss.bilivideo.com/upgcxcode/a.m4s?e=x"
_CN = "https://cn-gddg-ct-01-10.bilivideo.com/upgcxcode/a.m4s?e=x"


def test_dash_prefers_a_mirror_that_can_go_through_our_proxy():
    """`baseUrl`(mcdn) + `backupUrl`(P2P, 普通 CDN) ⇒ 选出**普通 CDN**，并把整条链带出去。"""
    data = {"dash": {"video": [{"id": 80, "baseUrl": _MCDN, "backupUrl": [_P2P, _UPOS],
                               "height": 1080}],
                     "audio": [{"id": 30280, "baseUrl": _MCDN, "backupUrl": [_UPOS]}]}}
    out = bili_play.parse_dash(data)
    v = out["video"][0]
    assert v["base_url"] == _UPOS, "必须挑能过我们代理的那条（P2P/mcdn 是白名单外/末位）"
    assert v["urls"] == [_UPOS, _MCDN, _P2P], "链要排好：普通 CDN → mcdn（自家域名）→ P2P"
    assert out["audio"][0]["base_url"] == _UPOS

    # 只在白名单里的普通 CDN 与 mcdn 之间选时，普通 CDN 仍然优先
    out2 = bili_play.parse_dash({"dash": {"video": [{"id": 80, "baseUrl": _MCDN,
                                                     "backupUrl": [_CN]}]}})
    assert out2["video"][0]["base_url"] == _CN


def test_dash_keeps_the_original_order_when_nothing_can_go_through():
    """一个能过的都没有 ⇒ **保持上游顺序**（别把 P2P 排前面，也别丢地址）。"""
    out = bili_play.parse_dash({"dash": {"video": [{"id": 80, "baseUrl": _P2P,
                                                    "backupUrl": [_P2P]}]}})
    assert out["video"][0]["urls"] == [_P2P]


def test_durl_entry_is_reranked_too():
    """durl 回落同样要排：实测 `url` 是 `edge.mountaintoys.cn`，`backup_url` 才是 upos。"""
    rows = bili_play.parse_durl({"durl": [{"url": _P2P, "backup_url": [_UPOS], "length": 263488}]})
    assert rows[0]["url"] == _UPOS
    assert rows[0]["urls"] == [_UPOS, _P2P]
    assert rows[0]["length"] == 263488
