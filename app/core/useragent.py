"""浏览器 UA 常量（**全仓单一来源**，R26②③ devlog/128）。

为什么单独一个模块、而不是塞进 `core/http.py`：那边顶层 `import httpx`（还带 certifi），
而 `routers/img_proxy.py` 刻意**延迟导入 httpx**（冷启动优化）—— 把 UA 放在那里会把
httpx 又拽进冷启动路径。本模块**零依赖**，谁都能安全引用。

口径（用户 2026-09-16 定，起因见 devlog/124 的三处"工具签名"）：

| 决定 | 理由 |
|---|---|
| **UA 集中在这里、发版时刷新 `UA_MAJOR`** | 盘点发现全仓曾有 **4 个不同的 Chrome 大版本**（131 / 150 / 126 / 150）；而"永远停在某个旧版本、24 小时不停调 API"本身就是签名 —— 真实浏览器会自动升级 |
| **不发 client hints**（`sec-ch-ua` 那一套） | 它的 GREASE 串（`"Not_A Brand";v="24"` 之类）只能靠猜，**猜错的组合比不补更像脚本** |
| **不开 HTTP/2** | httpx 要额外装 `h2`；收益不明，代价是加依赖 + 重打后端产物 |
| **不发 `Connection: keep-alive`** | 浏览器在 HTTP/1.1 下不显式发它（h2 更不会有），一边声称 Edge 一边发它反而扎眼 |

⚠️ 结构化护栏：`tests/test_user_agent.py` 会扫 `app/` 下所有 `.py`，
**除本文件外不许再出现 `Chrome/<数字>` 这类 UA 字面量**（防止又长出第 5 个版本号）。
"""

# 2026-09 的 Edge/Chrome 稳定版 = 153（来源：Microsoft/Chrome 发布公告）。
# **发版时刷新这一处即可**，三个 UA 会一起跟着走。
UA_MAJOR = "153"

UA_CHROME = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             f"(KHTML, like Gecko) Chrome/{UA_MAJOR}.0.0.0 Safari/537.36")

# B 站主路径与图片代理用 Edge（与登录流程声称的浏览器一致）
UA_EDGE = UA_CHROME + f" Edg/{UA_MAJOR}.0.0.0"

# 微博 m 站 / 微博登录走 iPhone Safari（那边本来就按移动端调用，配 m 站 Referer 自洽）
UA_IPHONE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) "
             "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1")
