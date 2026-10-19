"""独轮车（刷屏）判定 —— **版本化入口，默认不启用**。

## 为什么单独一个模块

聚合阶段（`collector.aggregate`）只负责产出**原料**：`m`（原始条数）、`uniq`（去重后条数）、
`maxrep`（单条文本最大重复次数）。**判定**放在这里，理由有两条：

1. 判定口径将来一定会改（阈值、是否结合入场模式、是否用文本相似度），改动不该碰到采集器；
2. 判定会影响指标（互动轴），必须能被**单独审计**：报告里要能说清用的是哪一版判定。

因此本模块只暴露两个东西：一个版本常量、一个纯函数。**当前没有任何调用方** ——
轴定义仍用原始条数，接入是下一步的事。

## 已有的数据结构支持

- `uniq` / `maxrep` 自 2026-10-20 起由采集器写入（只存数字，不存原文）；
- **老数据没有这两个字段** ⇒ 读取时缺省为 0，且 `text_tracked=False`。
  判定函数对"未跟踪"的输入**必须返回 None（未知）**，不能当作"不刷屏"。
"""

from __future__ import annotations

#: 判定算法版本。改判定逻辑必须 +1，并在报告里写清楚用的是哪一版。
SPAM_ALGO_VERSION = 1

#: v1 的参数（只作为默认值；调用方可以覆盖）
MIN_MSG_FOR_JUDGEMENT = 20   # 少于这么多条，谈不上"刷屏"
DUP_RATE_THRESHOLD = 0.60    # 重复率（1 - uniq/m）超过它才算刷屏
MAXREP_RATIO_THRESHOLD = 0.30  # 单条文本最大重复次数占全部条数的比例


def spam_score(*, uniq: int, maxrep: int, m: int) -> float | None:
    """返回 [0,1] 的刷屏分数；**输入不足以判定时返回 None**。

    分数先保持简单：`重复率` 与 `最大重复占比` 的较大者。之所以不用加权和，
    是因为两者在"纯复读"与"循环几句"两种刷屏形态上各自灵敏，取最大值更保守。
    """
    if m <= 0 or uniq < 0:
        return None
    if m < MIN_MSG_FOR_JUDGEMENT:
        return None
    dup_rate = 1 - min(uniq, m) / m
    maxrep_ratio = maxrep / m if m else 0.0
    return max(dup_rate, maxrep_ratio)


def is_spam(
    *,
    uniq: int,
    maxrep: int,
    m: int,
    dup_rate_threshold: float = DUP_RATE_THRESHOLD,
    maxrep_ratio_threshold: float = MAXREP_RATIO_THRESHOLD,
) -> bool | None:
    """布尔判定；**输入不足以判定时返回 None**（未知 ≠ 清白）。

    ⚠️ 当前**没有调用方**。接入时要同时决定"剔除出池"还是"降权"，并把剔除人数写进报告。
    """
    score = spam_score(uniq=uniq, maxrep=maxrep, m=m)
    if score is None:
        return None
    return score >= max(dup_rate_threshold, maxrep_ratio_threshold)
