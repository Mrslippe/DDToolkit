"""表情解析端点（2026-10-13，用户第 5 条）。

`GET /emoji/resolve?names=<token,token,…>` → `{"items": {"UPOWER_1_贴贴": "https://…"}, "count": 1}`

## 口径

- **两级解析**（`devlog/483`）：**第一源 = 我们自己的载荷**（`posts.raw_json` 里的
  `rich_text_nodes[*].emoji.icon_url`，离线、实测覆盖 99%）→ **第二源 = 上游整表**
  （全局动态包 + 本机账号面板，实测 28%，且**账号相关**）。
  两级都没有 ⇒ 前端渲染**名字 chip**（"这是表情，只是本机没有它"）。
- **第一源在启动期建好索引**（`warm_raw_index`）⇒ 读路径**不写库、不扫表**（`devlog/473`）。
- **第二源按需拉**（`resolve_all_async`）：只有第一源漏项时才出网一次，之后 30 分钟吃缓存，
  拉失败后 60s 内不重试。⚠️ 别把它挪去启动期预取：离线时会挂在 15s 超时上，
  而且"没人调用的预取"曾经让这条兜底在运行期是死的（`devlog/483` 第六节第 3 条）。
- **查不到的条目不出现在 `items` 里**（前端据此走 chip）—— 不返回空串/占位图，
  否则前端分不清"没有这个表情"和"取失败了"。
- **上游失败不报错**：返回已命中的 + `why`（表情不该让正文渲染失败）。
- 名字数量有上限（`MAX_TOKENS`）：超了直接 400 说清楚（而不是悄悄截断 —— 截断会让前端
  以为"剩下那些没表情"）。
"""
from fastapi import APIRouter, HTTPException, Query

from app.services import bili_emote

router = APIRouter()


@router.get("/emoji/resolve")
async def resolve_emojis(names: str = Query(..., description="逗号分隔的表情 token（不含方括号）")):
    tokens = [n.strip() for n in (names or "").split(",") if n.strip()]
    if not tokens:
        return {"items": {}, "count": 0, "origin": {}, "why": None}
    if len(tokens) > bili_emote.MAX_TOKENS:
        raise HTTPException(400, f"一次最多解析 {bili_emote.MAX_TOKENS} 个表情名"
                                 f"（收到 {len(tokens)} 个）—— 请分批")
    items, origin = await bili_emote.resolve_all_async(tokens)
    # `origin` 是诊断（哪个 token 由哪一级给的）：前端不用，但排查"为什么这枚没画出来"时
    # 一眼能看出"是载荷没扫到"还是"两级都没有"。
    # `why`：第二源最近一次拉取失败的原因（**只有真去拉过才会有值** —— 载荷全中时按设计不出网）。
    return {"items": items, "count": len(items), "origin": origin, "why": bili_emote.panel_why()}


@router.get("/emoji/packages")
async def emoji_packages():
    """诊断：两级索引各自多少名字、载荷里见过多少个**包 id**（`devlog/483`）。

    为什么留这个端点：包 id 是"将来要整包"时的**种子**（官方
    `/bapis/…/EmoteService/PackageDetail`、或第三方快照都按包 id 查）。重新扫一遍全库要 0.7s，
    所以扫描时顺手存下来了 —— 这个端点让那份数据**取得到**（而不是埋在内存里没人能用）。
    """
    return bili_emote.index_stats()
