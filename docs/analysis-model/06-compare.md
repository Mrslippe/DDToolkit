---
doc:         analysis-model/06-compare
class:       module
scope:       对比分析：多主播名单重叠、帖子评论名单与核心度名单的重叠、指标口径（Jaccard/lift/超几何双侧/BH 校正/Top-N 覆盖）与判读纪律
not-scope:   单主播的轴与强度 → analysis-model/02-model.md；标签与独轮车 → analysis-model/03-tags-spam.md；采集链路 → analysis-model/05-pipeline-ops.md
sot:         app/routers/fan.py（compare_multi）、app/routers/fan_compare.py、app/services/fan/cross_v.py、app/services/bili_replies.py
verify:      .\.venv\Scripts\python.exe -m pytest -q tests/test_fan_cross_v.py tests/test_bili_replies.py tests/test_fan_api.py
budget:      160
retire-when: 对比口径改成"可比的绝对分数"，或评论抓取换源（不再是 B 站 reply 接口）
---
# 对比分析：重叠度怎么做、怎么读

## 0. 本文管什么

- 「对比」页签的三类对象：**多主播名单**、**帖子评论名单**、以及它们与当前核心度名单的重叠；
- 指标定义（Jaccard / lift / 超几何双侧 / BH 校正 / Top-N 覆盖）；
- **判读纪律**：什么能说、什么不能说。

不管：单主播内部的轴与强度（见 `02-model.md`）、标签与独轮车（`03-tags-spam.md`）、采集（`05-pipeline-ops.md`）。

## 1. 三条硬约定

1. **只比集合与层级，不比分数** —— 跨 V / 跨来源的绝对强度不可移植（`02-model.md` §5）。
   对比页永远不给"A 的 0.9 比 B 的 0.9 强"这种结论。
2. **零模型是必选项**：给出 `lift` 的同时必须给**两个方向**的尾概率
   （上尾 = 富集，下尾 = 贫化）。只看交集大小没有意义 —— 大 V 的名单天然更大。
3. **多配对必须校正**：N 个 V 会产生 N(N-1)/2 个配对（4 个 V = 6 个），
   p 值一律做 **Benjamini–Hochberg**，UI 上标 `p（BH 校正）`。

## 2. 指标

| 指标 | 定义 | 读法 |
|---|---|---|
| `shared` | \|A∩B\| | 绝对量，不能单独下结论 |
| `jaccard` | \|A∩B\| / \|A∪B\| | 0–1，尺度无关，适合横向比"亲密度" |
| `lift` | 观测 / 期望（超几何期望 `K·n/N`） | >1 富集、<1 贫化；**这是主指标** |
| `p_value` | `P(X ≥ 观测)` 上尾 | 显著富集 |
| `p_value_lower` | `P(X ≤ 观测)` 下尾 | **显著贫化**（受众在分化） |
| `p_adjusted` | BH 校正后的上尾 p | 多配对时以此为准 |
| `coverage[n]` | 名单前 n 名里命中评论用户的比例 | 看"重叠集中在头部还是长尾" |

总体 `N` 取**两集合的并集**（与 `/fan/cross` 一致）—— 这是保守口径：不假设"没出现在两边的人"是一个确定的人群。

## 3. 多主播（`/fan/compare/multi`）

- 输入 2–6 个主播，返回 `vtubers[]`（池大小、场次、层级分布）、`matrix`（对称方阵）、`pairs[]`；
- **缺数据处理**：某个 V 还没采/没数据时**逐 V 标注**（`missing[]` / `needs_analysis[]`），
  不拖垮整次请求；前端据此提示「还没有分析结果，是否现在采集并分析？」——
  **必须用户确认后才发起采集**，不静默开跑；
- 矩阵格子显示 `jaccard`，`title` 带 `shared` 与 `lift`；点格子下钻到该配对的层级迁移与读数。

## 4. 帖子评论（`/fan/compare/scan` + `/fan/compare/comment-overlap`）

### 数据链路

```
链接/BV/动态号 → 解析 oid → 分页抓主楼（可含楼中楼） → 按 uid 聚合 → 快照 JSON
```

- **只存 uid 与计数，不存评论正文**（与全项目一致：最小化留存）；
- 快照落在 `<数据根>/_compare/scans/<id>.json`，**不进数据库**：这是一次性外部数据，天然会过期；
- `expected`（上游声称的评论数）与 `fetched` 一起返回，拿不满时 `partial=true`；
  风控导致的截断必须**显示出来**，不能当成"评论就这么多"。

### 与名单的重叠

- 评论名单取前 `top_n`（默认 500）与当前 V 的核心度名单求交；
- 指标同上（Jaccard / lift / 超几何双侧）；
- 额外给 **Top-N 覆盖**（前 10/25/50/100/200/500/1000 的命中率）与**分层命中**（核心/次核心/外层 × 命中/未命中）——
  这两项比单个数字更能说明"重叠长什么样"。

### 判读

| 现象 | 可以说 | 不能说 |
|---|---|---|
| lift 高 + 上尾显著 | 该帖评论者与这份名单**异常重合** | "这些人就是该主播的核心粉" |
| lift 低 + 下尾显著 | 两边受众在**分化** | "他们不看这个主播" |
| 不显著 | 与随机抽样没有明显差别 | "两者无关" |

## 5. 边界与已知局限

1. **评论名单是快照**：同一帖子隔天再抓，数字会变；对比结论要带"抓取时间"；
2. **楼中楼只抓前 50 条主楼**的子回复（`SUB_TOP`）—— 深度讨论帖的 `sub_cnt` 会偏低；
3. **未登录/风控**：视频详情与动态详情依赖 WBI 与登录态，失败会带原因返回，不静默降级；
4. **多重比较**：超过 6 个 V 时配对数增长很快，UI 只允许 2–6 个是有意为之。

## 6. 相关代码

| 位置 | 作用 |
|---|---|
| `app/routers/fan.py::compare_multi` | 多主播矩阵 + 逐 V 缺失标注 |
| `app/routers/fan_compare.py` | 评论抓取三段式端点 + `overlap_stats`（纯函数） |
| `app/services/fan/cross_v.py` | `overlap` / `hypergeom_*` / `bh_adjust` / `tier_moves` |
| `app/services/bili_replies.py` | 解析、分页抓取、聚合、快照 |
| `frontend/src/components/workbench/ComparePanel.tsx` | 页签面板（多主播 / 帖子评论） |
| `frontend/src/components/workbench/CommentComparePane.tsx` | 帖子评论模式的输入/进度/结果 |
