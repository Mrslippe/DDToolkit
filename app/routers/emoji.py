"""表情解析端点（2026-10-13，用户第 5 条）。

`GET /emoji/resolve?names=<token,token,…>` → `{"items": {"UPOWER_1_贴贴": "https://…"}, "count": 1}`

## 口径

- **按批查**（不是按名一个个查）：上游给的是整表，没有"按名查"的端点 ⇒ 服务层拉一次建索引、
  进程内缓存 30 分钟，这个端点只是"在这张表里查一批名字"。
- **查不到的条目不出现在 `items` 里**（前端据此渲染**名字 chip**）—— 不返回空串/占位图，
  否则前端分不清"没有这个表情"和"取失败了"。
- **上游失败不报错**：返回空 `items` + `why`（表情不该让正文渲染失败；前端全走兜底）。
- 名字数量有上限（`MAX_TOKENS`）：这条路上游是整表，一次几百个名字没有意义，
  超了直接 400 说清楚（而不是悄悄截断 —— 截断会让前端以为"剩下那些没表情"）。
"""
from fastapi import APIRouter, HTTPException, Query

from app.services import bili_emote

router = APIRouter()


@router.get("/emoji/resolve")
async def resolve_emojis(names: str = Query(..., description="逗号分隔的表情 token（不含方括号）")):
    tokens = [n.strip() for n in (names or "").split(",") if n.strip()]
    if not tokens:
        return {"items": {}, "count": 0, "why": None}
    if len(tokens) > bili_emote.MAX_TOKENS:
        raise HTTPException(400, f"一次最多解析 {bili_emote.MAX_TOKENS} 个表情名"
                                 f"（收到 {len(tokens)} 个）—— 请分批")
    index, why = await bili_emote.emote_index()
    items = bili_emote.resolve(tokens, index)
    return {"items": items, "count": len(items), "why": why}
