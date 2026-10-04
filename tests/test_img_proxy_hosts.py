"""图片代理白名单**逐条**用例（第 4 阶段 ⑧，devlog/240）。

## 为什么需要

封面/头像破图的机制链是**三处一起改**：前端 CSP `img-src`、`IMG_PROXY_ALLOWED_HOSTS`
（后端代理只允许这些主机）、以及 `_referer_for`（微博图床不带合法 Referer 会 403）。
漏改中间那处的症状是**静默的**：不报错，列表里一片破图 —— 2026-09-27 接小红书时
就是手工补的两个域名（devlog/231），下次没人提醒。

所以这里做两件事：
1. **逐条**：每个平台**真实会出现的封面/头像 URL**都要被接受（含子域），
   表外主机（含长得很像的）一律 403；
2. **同批**：白名单必须覆盖**所有已注册平台**的图床 ⇒ 新平台忘了加域名时这条会红；
   反向也查一次：白名单里不许留"没有任何平台在用"的死条目。
"""
import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.routers import img_proxy
from app.services.platforms import registry

# 平台 → 该平台**真实出现过**的图床 URL（子域各不相同，正好把后缀匹配也验了）
PLATFORM_IMAGE_URLS: dict[str, tuple[str, ...]] = {
    "bilibili": (
        "https://i0.hdslb.com/bfs/face/abc123.jpg",
        "https://i1.hdslb.com/bfs/archive/cover.jpg@672w_378h_1c.webp",
    ),
    "weibo": (
        "https://tvax1.sinaimg.cn/crop.0.0.180.180.180/abc.jpg",
        "https://wx2.sinaimg.cn/large/006ABCdefgy1.jpg",
        "https://wx1.wbcdn.cn/large/abc.jpg",
    ),
    "xiaohongshu": (
        "https://sns-img-qc.xhscdn.com/abc123?imageView2/2/w/1080/format/webp",
        "https://ci.xiaohongshu.com/abc123.jpg",
    ),
    "douyin": (
        # 真机回包（devlog/333 的 D1 spike）：图文帖的图与封面走 douyinpic，
        # 视频封面/静态资源走 douyinstatic
        "https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/abc~tplv-dy-aweme-images:q75.webp",
        "https://sf11-cdn-tos.douyinstatic.com/obj/tos-cn-ve-2774/cover.jpeg",
    ),
}

# 平台 → 期望的 Referer（微博图床有防盗链；没有它 ⇒ 403 ⇒ 破图）
PLATFORM_REFERER: dict[str, str | None] = {
    "bilibili": "https://www.bilibili.com/",
    "weibo": "https://weibo.com/",
    "xiaohongshu": None,
    # 抖音：图床地址是**限时签名** URL（`p*-pc-sign.douyinpic.com`），不需要防盗链 Referer。
    # ⚠️ 这条**没有真机验过**（没单独试过带/不带 Referer 拉图）：先按不带头处理，
    #    真破图了在这里加 `https://www.douyin.com/` 即可（`_referer_for` 一处）
    "douyin": None,
}


def _accepts(url: str) -> bool:
    try:
        img_proxy._validate_url(url)
        return True
    except HTTPException:
        return False


def test_every_registered_platform_is_covered_by_this_table():
    """这张"平台 → 图床"表必须与**注册表**同批：加了平台而忘记在这里列 URL，

    这条会红 —— 提醒你去 `IMG_PROXY_ALLOWED_HOSTS` 补域名（否则封面静默破图）。
    """
    assert set(PLATFORM_IMAGE_URLS) == set(registry.supported_platforms())
    assert set(PLATFORM_REFERER) == set(registry.supported_platforms())


@pytest.mark.parametrize("platform,url", [
    (pf, url) for pf, urls in PLATFORM_IMAGE_URLS.items() for url in urls
])
def test_real_image_urls_are_accepted(platform, url):
    """逐条：真实 URL 必须被接受（`_validate_url` 不抛 = 放行）。"""
    assert _accepts(url), f"{platform} 的图床域名不在白名单里：{url}"


@pytest.mark.parametrize("platform,url", [
    (pf, url) for pf, urls in PLATFORM_IMAGE_URLS.items() for url in urls
])
def test_referer_matches_the_platform(platform, url):
    """防盗链 Referer 要按平台给（微博不给 ⇒ 上游 403 ⇒ 破图）。"""
    host = img_proxy._host_of(url)
    assert img_proxy._referer_for(host) == PLATFORM_REFERER[platform]


@pytest.mark.parametrize("url", [
    # 后缀匹配必须在**标签边界**上：`hdslb.com.evil.com` 不是 hdslb 的子域
    "https://i0.hdslb.com.evil.com/x.jpg",
    "https://evil-hdslb.com/x.jpg",
    "https://hdslb.com.evil.com/x.jpg",
    # URL 里的 userinfo 花招：netloc 是 `hdslb.com@evil.com`，真主机是 evil.com
    "https://hdslb.com@evil.com/x.jpg",
    # SSRF 目标（内网 / 本机 / 元数据地址）
    "http://127.0.0.1/x.jpg",
    "http://localhost/x.jpg",
    "http://169.254.169.254/latest/meta-data/",
    "https://[::1]/x.jpg",
    # 表外主机（含"看着像"的）
    "https://img.example.com/x.jpg",
    "https://sinaimg.cn.evil.com/x.jpg",
])
def test_lookalikes_and_internal_targets_are_rejected(url):
    """⛔ 这些都必须 403：白名单是**安全边界**（代理能打我们的内网）。"""
    with pytest.raises(HTTPException) as ei:
        img_proxy._validate_url(url)
    assert ei.value.status_code == 403


@pytest.mark.parametrize("url,code", [
    ("", 400),
    ("ftp://i0.hdslb.com/x.jpg", 400),
    ("/relative/path.jpg", 400),
    ("https://" + "a" * 3000 + ".com/x.jpg", 400),
])
def test_bad_urls_are_rejected_with_400(url, code):
    with pytest.raises(HTTPException) as ei:
        img_proxy._validate_url(url)
    assert ei.value.status_code == code


def test_host_matching_details_are_locked():
    """锁定三个既有细节：大小写不敏感、端口被剥掉、裸域名也接受。"""
    assert _accepts("https://I0.HDSLB.COM/bfs/face/x.jpg")
    assert _accepts("https://i0.hdslb.com:8443/bfs/face/x.jpg")
    assert _accepts("https://hdslb.com/x.jpg")
    assert img_proxy._host_of("https://I0.HDSLB.COM:8443/a.jpg") == "i0.hdslb.com"


def test_allowlist_has_no_dead_entries():
    """反向的一半：白名单里每个条目都得**有平台在用**（否则是死配置，没人会想起来删）。"""
    used = {img_proxy._host_of(u) for urls in PLATFORM_IMAGE_URLS.values() for u in urls}
    dead = [
        entry for entry in img_proxy._ALLOWED_HOSTS
        if not any(h == entry or h.endswith("." + entry) for h in used)
    ]
    assert dead == [], f"白名单里这些条目没有任何平台在用：{dead}（要么补用例，要么删掉）"


def test_config_default_covers_the_table():
    """配置默认值本身也要覆盖（用户没设环境变量时走的就是它）。"""
    configured = {s.strip().lower() for s in settings.IMG_PROXY_ALLOWED_HOSTS.split(",")
                  if s.strip()}
    assert configured == set(img_proxy._ALLOWED_HOSTS), \
        "`_ALLOWED_HOSTS` 应当就是配置解析出来的那一份（别在两处各维护一套）"
