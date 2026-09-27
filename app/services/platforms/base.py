"""平台抓取器框架（爬虫框架）。

新平台接入（如抖音/小红书）：
1. 继承 BasePlatform，实现 fetch_user_info / fetch_post_page（enrich 可选）；
2. 在 registry.py 注册 platform 名 → 实例；
3. scheduler 自动获得：账号信息抓取、全量/增量帖子抓取、风控退避、完成报告。

## 翻页：**cursor 语义**（第 4 阶段 ⑥，devlog/238）

原接口是 `fetch_post_page(uid, page: int)`（页码语义）。小米书这类平台的接口是
**cursor**（服务端给下一串），于是小红书适配器当初只能把 cursor **藏进 page** 的字典里
（"过渡形状"，见该文件头的说明）—— 那意味着**分页状态住进了适配器**：
换账号、重抓、并发重入都会串台，而且核心循环完全看不见真实的翻页位置。

现在接口统一成不透明 cursor：

```python
page = await pf.fetch_post_page(uid, cursor)      # cursor=None 表示"从头开始"
# → {"items": [...], "has_more": bool, "next_cursor": str | None, ...}
```

- **页码平台**（微博）把页码当 cursor 用（`None → "1"`、返回 `"2"`），适配器里一行转换；
- **cursor 平台**（小红书）原样透传服务端给的串；
- ⚠️ **核心循环不许解析 cursor**：它只做"原样带回去 / 判空"。想拿它做算术或拼 URL
  就说明语义又漏回核心了（`tests/test_posts_core_platform.py` 有判据盯着）。

`page` 这种"翻到第几页"的信息对核心仍有意义（`pages` 上限、日志、`stop_reason`），
所以核心自己**数次数**，不再要求平台按页码回答。
"""
from __future__ import annotations

import httpx


class BasePlatform:
    platform: str = ""
    # 支持"批量直播状态"吗（T0 每分钟一次的那条路）。
    # ⚠️ 默认 **False**：调度侧据此**结构化跳过**并记一条日志 —— 以前这条路写死 B 站，
    #    新平台要么被静默忽略、要么得回来改核心（第 4 阶段 ⑧，devlog/240）。
    supports_live_batch: bool = False

    async def fetch_user_info(self, uid: str, client: httpx.AsyncClient | None = None) -> dict | None:
        """用户信息 → {name, sign, avatar, followers_count, url, ...平台附加字段}；失败 None。

        风控由 was_rate_limited() 判定（调用方统一冷却退避）。
        """
        raise NotImplementedError

    async def fetch_post_page(self, uid: str, cursor: str | None = None,
                              client: httpx.AsyncClient | None = None) -> dict | None:
        """一页帖子流（时间倒序）→ `{"items": [...], "has_more": bool, "next_cursor": str | None}`；失败 None。

        - `cursor=None` = 从头开始；之后每次都把上一页返回的 `next_cursor` 原样带回来；
        - `has_more=True` 时**必须**给 `next_cursor`（给不出就说明这一页到底了）；
        - `next_cursor` 对核心**不透明**：核心不解析它、不改写它（见模块头）。

        item 统一结构：
        {platform, platform_uid, platform_post_id, type(text/image/video/repost/article),
         title, summary, cover_url, permalink, body_json, stats_json,
         published_at(naive UTC), raw_json}
        """
        raise NotImplementedError

    async def enrich(self, item: dict, client: httpx.AsyncClient | None = None) -> bool:
        """详情补全（就地修改 item，如长文全文/视频详情）。
        返回是否发起过网络请求（调用方据此节流）。默认无操作。"""
        return False

    async def fetch_live_batch(self, uids: list[str],
                               client: httpx.AsyncClient | None = None) -> dict[str, dict] | None:
        """**批量**直播状态（T0 专用）→ `{uid(str): {"live_status", "live_title", "room_id", "live_url"}}`。

        - 只在 `supports_live_batch=True` 时被调用；
        - `None` = 这次**失败了**（风控/网络），调用方按自愈策略处理；
        - **问了但没回来的 uid**（例：不是这个平台的 uid 形态）由适配器自己记日志说明原因，
          调用方一律把它们计进 `failed` —— 「不支持」不许静默丢弃（§1.4 边界②）。
        - 默认实现：**不支持**（返回 None 且 `supports_live_batch=False`，调度侧不会走到这里）。
        """
        return None
