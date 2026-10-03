# -*- coding: utf-8 -*-
"""微博视频映射（devlog/291）的判据：**数字 11 也是视频**、地址优先序、CDN 策略。

现场（2026-10-03 真机实测）：
- 视频帖 `page_info.type` 是**数字 11**（不是字符串 `"video"`）⇒ 旧判定漏判，
  `body.video` 只剩 `{mp4: null}`（用户报"微博视频打不开"）；
- 地址在 `page_info.media_info`，720P 那条是 `mp4_720p_mp4`；
- 微博 CDN：**带 UA+Range 无 Referer → 403**，带 `Referer: https://weibo.com/` → 206。
"""
from app.routers import video_proxy
from app.services.platforms import weibo


def _mblog(**page_info):
    return {"id": "1", "text": "看这个", "page_info": page_info}


def test_numeric_type_11_is_recognised_as_video():
    """**数字 11 也是视频**（这条就是"微博视频打不开"的根因）。"""
    m = _mblog(type=11, page_pic="https://wx1.sinaimg.cn/x.jpg",
               media_info={"mp4_720p_mp4": "http://f.video.weibocdn.com/a.mp4"})
    item = weibo._map_mblog(m, "1234567890")
    assert item["type"] == "video", "认不出视频 ⇒ 前端没有播放器可渲染"
    import json
    body = json.loads(item["body_json"])          # 落库时是 JSON 串（列是 Text）
    assert body["video"]["url"].endswith("a.mp4")


def test_video_url_prefers_720p_and_keeps_fallbacks():
    """优先 720P；H.265 排最后（WebView2 不一定能解 HEVC），其余进 fallback 链。"""
    body = weibo._video_of({}, {
        "page_pic": "https://wx1.sinaimg.cn/cover.jpg",
        "media_info": {
            "mp4_720p_mp4": "http://f.video.weibocdn.com/720.mp4",
            "stream_url_hd": "http://f.video.weibocdn.com/hd.mp4",
            "mp4_sd_url": "http://f.video.weibocdn.com/sd.mp4",
            "h265_mp4_hd": "http://f.video.weibocdn.com/hevc.mp4",
            "duration": 256,
        },
    }, {
        "mp4_720p_mp4": "http://f.video.weibocdn.com/720.mp4",
        "stream_url_hd": "http://f.video.weibocdn.com/hd.mp4",
        "mp4_sd_url": "http://f.video.weibocdn.com/sd.mp4",
        "h265_mp4_hd": "http://f.video.weibocdn.com/hevc.mp4",
        "duration": 256,
    })
    assert body["url"].endswith("720.mp4")
    assert body["fallbacks"][-1].endswith("hevc.mp4"), "H.265 只配当最后一条兜底"
    assert body["duration_s"] == 256


def test_no_media_means_no_video_key():
    """没有媒体字段就不该写 `video` 键（否则前端会渲染一个播不了的播放器）。"""
    assert weibo._video_of({}, {"page_pic": "x.jpg"}, {}) is None


def test_weibo_cdn_policy_matches_measurements():
    """策略表要覆盖微博两个域，且都是"带 weibo Referer"（不带就 403）。"""
    for host in ("f.video.weibocdn.com", "g.us.sinaimg.cn", "wx1.sinaimg.cn"):
        pol = video_proxy.policy_for(host)
        assert pol.get("Referer") == "https://weibo.com/", f"{host} 策略缺失"
    assert video_proxy.host_allowed("http://f.video.weibocdn.com/a.mp4")
