# -*- coding: utf-8 -*-
"""请求头卫生：UA 单一来源 + 不发脚本痕迹头（R26②③，devlog/128）。

起因（devlog/124 盘点）：头全是硬编码，其中有两处真问题 ——

1. **`Connection: keep-alive`**：浏览器在 HTTP/1.1 下不显式发它（h2 更不会有），
   一边声称 Edge 一边发它比"少一个头"更扎眼；
2. **UA 散落且版本各不相同**（盘点时实测 4 个大版本：131 / 150 / 126 / 150）——
   而"永远停在旧版本、24 小时不停调 API"本身就是签名（真实浏览器会自动升级）。

本文件把两条都钉住：**只有一个文件能写 UA 字面量**，且所有消费方都用同一份常量。
⚠️ 用户 2026-09-16 定的口径：**不补 client hints**（GREASE 串靠猜，猜错的组合比不补更像脚本）、
**不开 HTTP/2**（要加 `h2` 依赖 + 重打后端产物）—— 这两条写在 `app/core/useragent.py` 的模块说明里。
"""
import re
from pathlib import Path

from app.core import useragent as ua
from app.core.config import settings

APP_DIR = Path(__file__).resolve().parent.parent / "app"
UA_LITERAL = re.compile(r"Chrome/\d|Edg/\d|AppleWebKit")


def test_only_one_place_writes_ua_literals():
    """结构化护栏：`app/` 下只有 `core/useragent.py` 能出现 UA 字面量。

    没有这条，下次很容易又在某个新服务里抄一份 `Chrome/1xx` —— 这正是本批要收的债。
    """
    offenders: list[str] = []
    for path in sorted(APP_DIR.rglob("*.py")):
        if path.name == "useragent.py":
            continue
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if UA_LITERAL.search(line):
                offenders.append(f"{path.relative_to(APP_DIR)}:{i}: {line.strip()[:70]}")
    assert offenders == [], "UA 字面量只能写在 app/core/useragent.py：\n  " + "\n  ".join(offenders)


def test_ua_versions_are_self_consistent():
    """同一个 UA 里声称的 Chrome 与 Edge 版本必须一致（改一处漏一处会立刻红）。"""
    chrome = re.search(r"Chrome/(\d+)", ua.UA_CHROME)
    edge = re.search(r"Edg/(\d+)", ua.UA_EDGE)
    assert chrome and edge
    assert chrome.group(1) == edge.group(1) == ua.UA_MAJOR
    assert ua.UA_EDGE.startswith(ua.UA_CHROME)          # Edge = Chrome + Edg 后缀


def test_bilibili_headers_use_shared_ua_and_drop_script_artifact():
    """B 站请求头：用共享 UA，且**不带** `Connection: keep-alive`。"""
    from app.services.auth import BASE_HEADERS

    assert BASE_HEADERS["User-Agent"] == ua.UA_EDGE
    assert "Connection" not in BASE_HEADERS
    # 该带的浏览器头一个都不能少（缺了会撞 -1200 / RST，见各模块注释）
    for key in ("Referer", "Origin", "Accept", "Accept-Language"):
        assert BASE_HEADERS.get(key), f"缺请求头 {key}"


def test_every_consumer_uses_the_shared_constants():
    """所有消费方都指向同一份常量（谁再抄一份，这条会红）。"""
    from app.routers import img_proxy
    from app.services import bili_search, weibo_auth
    from app.services.externals import danmakus
    from app.services.platforms import weibo

    assert bili_search.UA == ua.UA_EDGE
    assert img_proxy._UA == ua.UA_EDGE
    assert weibo._PC_UA == ua.UA_CHROME
    assert weibo._MOBILE_UA == ua.UA_IPHONE
    assert weibo_auth._BASE_HEADERS["User-Agent"] == ua.UA_IPHONE
    assert danmakus.BROWSER_HEADERS["User-Agent"] == ua.UA_CHROME


def test_third_party_bot_ua_reports_the_real_version():
    """`runner.py` 的自报家门 UA 必须跟上真实版本号（原来写死 0.5.2）。"""
    from app.services.externals import runner

    assert runner._USER_AGENT.startswith("DDtoolkit-archive/")
    assert settings.VERSION in runner._USER_AGENT
