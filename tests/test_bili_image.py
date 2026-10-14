# -*- coding: utf-8 -*-
"""B 站图床取数规格（`app/services/bili_image.py`，2026-10-14）。

规格与"为什么不是 `1c`"的实测依据在模块头；这里只钉**函数契约**：

| # | 判据 | 错了会怎样 |
|---|---|---|
| ① | B 站两家图床（`hdslb.com` / `album.biliimg.com`）⇒ **加规格** | 省不下体积（原图动辄几 MB） |
| ② | 非白名单图床 ⇒ **原样返回** | 给微博/小红书图床上加没意义的后缀（还可能 404） |
| ③ | 已带 `@…` 后缀 ⇒ **不叠加第二个** | 拼出 `x.jpg@672w_378h.webp@672w_378h.webp` 这种地址 |
| ④ | 带查询串 ⇒ 规格落在 `?` **之前**（规格属于路径） | 参数被当成查询的一部分，图床不认 |
| ⑤ | 空 / None / 相对路径 / 畸形串 ⇒ 原样返回，**不抛** | 一条脏数据让整轮固化崩掉 |
| ⑥ | **幂等**：同一输入永远同一输出 | 稳定键漂移 ⇒ 已固化的封面全部失配、重下一遍 |
"""
from __future__ import annotations

import pytest

from app.services import bili_image as bi

SPEC = "@672w_378h.webp"


@pytest.mark.parametrize("url", [
    "http://i1.hdslb.com/bfs/archive/ee82c99d.jpg",
    "https://i0.hdslb.com/bfs/new_dyn/398be2a5.png",
    "https://album.biliimg.com/bfs/new_dyn/9571f8c8.png",     # 第二个 B 站图床（实测也认）
    "https://hdslb.com/bfs/archive/x.jpg",                    # 裸域
])
def test_bili_hosts_get_the_spec(url):
    """① 白名单图床加规格。"""
    assert bi.cover_fetch_url(url) == url + SPEC


@pytest.mark.parametrize("url", [
    "https://wx1.sinaimg.cn/large/0089C3d5gy1i1f7tnlcyej30j20vkgon.jpg",
    "https://sns-webpic-qc.xhscdn.com/202610041518/abc/notes_pre_post/1040g3k0",
    "https://p3-pc-sign.douyinpic.com/tos-cn-p-0015/xx~tplv-dy-360p.jpeg?lk3s=138a59ce",
    "https://vip.storage.weibo.com/65b7efba12bc7_7471118487.png",
])
def test_other_hosts_are_left_alone(url):
    """② 非白名单图床原样返回（加了没用）。"""
    assert bi.cover_fetch_url(url) == url
    assert bi.supports_spec(url) is False


def test_existing_suffix_is_not_doubled():
    """③ 已带 `@` 后缀 ⇒ 不叠加（幂等的前提）。"""
    once = bi.cover_fetch_url("https://i0.hdslb.com/bfs/archive/a.jpg")
    assert bi.cover_fetch_url(once) == once, "第二次调用又叠了一个规格"
    # 平台自己给的规格（尺寸与我们不同）也不动它 —— 那是它明确要的版本
    given = "https://i0.hdslb.com/bfs/archive/a.jpg@32w_32h.webp"
    assert bi.cover_fetch_url(given) == given


def test_spec_goes_before_the_query_string():
    """④ 规格属于路径 ⇒ 落在 `?` 之前。"""
    url = "https://i0.hdslb.com/bfs/archive/a.jpg?t=1"
    assert bi.cover_fetch_url(url) == f"https://i0.hdslb.com/bfs/archive/a.jpg{SPEC}?t=1"


@pytest.mark.parametrize("bad", ["", "   ", None, "not-a-url", "/bfs/archive/a.jpg",
                                 "ftp://i0.hdslb.com/a.jpg", "hdslb.com/a.jpg"])
def test_junk_never_raises(bad):
    """⑤ 脏数据原样返回、不抛（一条坏数据不许把整轮固化带崩）。"""
    assert bi.cover_fetch_url(bad) == (bad.strip() if isinstance(bad, str) else "")


def test_idempotent():
    """⑥ 幂等：两次调用结果一致（否则稳定键会漂，已固化的封面全部失配）。"""
    src = "https://i2.hdslb.com/bfs/archive/b.jpg"
    assert bi.cover_fetch_url(bi.cover_fetch_url(src)) == bi.cover_fetch_url(src)


def test_spec_has_no_crop_flag():
    """⑦ 规格里**不许**出现 `1c` —— 它是居中裁剪。

    真库实测：动态封面（占多数）常是非 16:9（1080×1920、1500×2167…），
    而详情页封面点开是灯箱看**完整图** ⇒ 裁掉就是真丢内容，且字节反而更多
    （30 KB vs 34 KB）。这条断言是一句话的护栏：谁改回 `1c` 都会红。
    """
    assert bi.COVER_SPEC == SPEC
    assert "1c" not in bi.COVER_SPEC
