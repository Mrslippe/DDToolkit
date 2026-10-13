"""表情解析端点（2026-10-13，用户第 5 条；两类大小 **2026-10-14**，`devlog/485`）。

`GET /emoji/resolve?names=<token,token,…>` →
`{"items": {"UPOWER_1_贴贴": {"url": "https://…", "size": 2}}, "count": 1, "origin": …, "why": null}`

## 口径

- **两级解析**（`devlog/483`）：**第一源 = 我们自己的载荷**（`posts.raw_json` 里的
  `rich_text_nodes[*].emoji.icon_url`，离线、实测覆盖 99%）→ **第二源 = 上游整表**
  （全局动态包 + 本机账号面板，实测 28%，且**账号相关**）。
  两级都没有 ⇒ 前端渲染**名字 chip**（"这是表情，只是本机没有它"）。
- **`size` 是 B站 自己的字段**（2026-10-14 用户问"原 json 里有没有说明表情大小的字段"）：
  `1` = 小表情（与文字同大小，425 个，全在 `/bfs/emote/` + 官方表情包 id）、
  `2` = 大表情/贴纸（5,574 个，含 garb 与**装扮/收藏集的 emote**）。
  ⚠️ 判别不能按"官方还是自定义"，只有这个字段分得开（`devlog/485` 有实测表）。
  第二源的脸在 `meta.size` 里给同一件事。
- **第一源在启动期建好索引**（`warm_raw_index`）⇒ 读路径**不写库、不扫表**（`devlog/473`）。
- **第二源按需拉**（`resolve_all_async`）：只有第一源漏项时才出网一次，之后 30 分钟吃缓存，
  拉失败后 60s 内不重试。⚠️ 别把它挪去启动期预取：离线时会挂在 15s 超时上，
  而且"没人调用的预取"曾经让这条兜底在运行期是死的（`devlog/483` 第六节第 3 条）。
- **查不到的条目不出现在 `items` 里**（前端据此走 chip）—— 不返回空串/占位图，
  否则前端分不清"没有这个表情"和"取失败了"。
- **上游失败不报错**：返回已命中的 + `why`（表情不该让正文渲染失败）。
- 名字数量有上限（`MAX_TOKENS`）：超了直接 400 说清楚（而不是悄悄截断 —— 截断会让前端
  以为"剩下那些没表情"）。
- **`/emoji/sample`**（`devlog/487`）：给设置页的"大表情大小"示例挑两枚**真**表情
  （一大一小，从热好的第一源索引里按名字排序取第一枚 ⇒ 确定性）。纯内存、不出网。
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
    # `items` 的值是**对象**（`{url, size}`，2026-10-14 起）：`size` 是 B站 自己的口径
    # （1 = 小表情 / 2 = 大表情，见 `devlog/485`），前端据此画两种尺寸。
    return {
        "items": {tok: {"url": url, "size": size} for tok, (url, size) in items.items()},
        "count": len(items),
        "origin": origin,
        "why": bili_emote.panel_why(),
    }


@router.get("/emoji/sample")
async def emoji_sample():
    """给「设置 → 外观 → 大表情大小」的**示例**取两枚真表情（一大一小，`devlog/487`）。

    为什么要有它：那个滑杆的意义是"看着调"，而示例必须画**真的**表情 —— 尺寸不一样、
    图片本身也不一样（官方小脸 vs 贴纸），拿占位图或假图调出来的手感是假的。
    而前端手里没有任何表情 token（它只在渲染帖子时按需问），所以由后端从**已经热好的
    第一源索引**里挑两枚给你：不出网、不扫库、纯内存。

    ⚠️ 挑选是**确定性**的（名字排序后取第一枚）—— 每次打开设置看到的示例是同一对，
    否则"我上次调到 40 是这个效果"就没法复现。索引没热上（首启还没扫完/全新库）⇒ 给 `null`，
    界面据此**不显示示例**（宁可不显示，也不要画一个空框）。
    """
    index = bili_emote.raw_index()
    out: dict[str, object] = {"names": len(index), "small": None, "large": None}
    for size, key in ((1, "small"), (2, "large")):
        for name in sorted(index):
            url, _pkg, s = index[name]
            if s == size and str(url).startswith("http"):
                out[key] = {"name": name, "url": url, "size": size}
                break
    return out


@router.get("/emoji/packages")
async def emoji_packages():
    """诊断：两级索引各自多少名字、载荷里见过多少个**包 id**（`devlog/483`）。

    为什么留这个端点：包 id 是"将来要整包"时的**种子**（官方
    `/bapis/…/EmoteService/PackageDetail`、或第三方快照都按包 id 查）。重新扫一遍全库要 0.7s，
    所以扫描时顺手存下来了 —— 这个端点让那份数据**取得到**（而不是埋在内存里没人能用）。
    """
    return bili_emote.index_stats()
