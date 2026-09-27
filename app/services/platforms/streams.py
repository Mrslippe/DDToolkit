"""帖子流的**平台适配接口**（第 4 阶段的 ①，devlog/229）。

## 为什么有它

`_fetch_posts_core` 是 B 站的**双流**核心（视频投稿 + 动态，各带归档边界、风控断点续抓、
置顶豁免、bvid 合并……）。它以前**直接**调 B 站函数、并且把 `"bilibili"` 这个字符串
写进了去重/归档查询里 ⇒ **核心循环假装自己只服务一个平台**：

```python
Post.platform == "bilibili"            # 换个平台，归档边界就静默失效
fetch_bilibili_videos(mid, page=…)     # 平台协议细节写死在编排里
```

这一刀把"**平台协议细节**"抽到一个可注入的适配对象上，于是核心循环只认
「有两条流、每条流能翻页、能识别非帖子项、能富化详情」这套**通用形状**。

## 边界（如实交代：这是第一刀）

- **本刀不新增平台能力**，也不改任何 B 站行为 —— 目标是"让 scheduler 不再假设自己是 B站"
  （用户口径见 `EXECUTION.md` §1.4）。
- `uid` 已是 **str**（第二刀，devlog/236）：核心不再假设 uid 是数字，也不再认识
  "mid" 这个词（那是 B 站的说法，住在 `platforms/bilibili_posts.py`）；
  B 站分支自己负责"uid 必须是数字"这条校验。
- 双流本身（"先视频后动态"）暂时仍是核心的形状 —— 它是**编排**，不是平台协议；
  真正平台专属的是下面这几个回调。

## 可空 = 该平台不需要那一步

`bvid_index` / `absorb_video_dynamic` / `route_non_post` / `enrich_item` / `refresh_pinned`
都是**可选**回调：B 站需要它们（投稿动态合并、直播卡路由、opus/专栏详情补全、置顶刷新），
单流平台大多不需要。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

# 回调签名（都用 `Any` 描述载荷：本模块**不许** import scheduler 或 fetcher，
# 否则就成环了 —— 类型宽松是这一步的代价，换来的是核心循环与平台解耦）
VideoPage = Callable[[str, int, Optional[Any]], Awaitable[Optional[dict]]]
DynamicsPage = Callable[[str, str, Optional[Any]], Awaitable[Optional[dict]]]
BvidIndex = Callable[[Any, str], dict]
AbsorbVideoDynamic = Callable[[Any, str, dict, dict], Optional[Any]]
RouteNonPost = Callable[[Any, str, dict], bool]
EnrichItem = Callable[[dict, Optional[Any]], Awaitable[None]]
RefreshPinned = Callable[..., Awaitable[bool]]


@dataclass(frozen=True)
class PostStreams:
    """一个平台的**帖子流适配**：平台名 + 两条流的翻页回调 + 可选的平台专属步骤。"""

    platform: str
    fetch_video_page: VideoPage
    fetch_dynamics_page: DynamicsPage
    # ── 以下都是可选的（B 站需要，单流平台多半不需要）────────────────────
    bvid_index: Optional[BvidIndex] = None
    absorb_video_dynamic: Optional[AbsorbVideoDynamic] = None
    route_non_post: Optional[RouteNonPost] = None
    enrich_item: Optional[EnrichItem] = None
    refresh_pinned: Optional[RefreshPinned] = None
