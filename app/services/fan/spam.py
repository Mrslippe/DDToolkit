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
SPAM_ALGO_VERSION = 4

#: v1 的参数（只作为默认值；调用方可以覆盖）
MIN_MSG_FOR_JUDGEMENT = 200  # 少于这么多条不判（2026-10-21：与 v2 对齐）
# 重复率（1 - uniq/m）。0.80 等价于「不同文本率 ≤20%」——
# 2026-10-21 逐个审原文后定的线：真独轮车 1%–11%，口头禅型话痨 24%–78%。
DUP_RATE_THRESHOLD = 0.80
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
    if m <= 0 or uniq < 0 or m < MIN_MSG_FOR_JUDGEMENT:
        return None
    # ⚠️ 2026-10-21 修正：原先是 `score >= max(两个阈值)`，等于把 maxrep 阈值
    # 抬到 0.60，`MAXREP_RATIO_THRESHOLD = 0.30` 从未生效。
    # 两个条件是**或**关系：整体重复率高，**或者**单条文本反复刷，都算独轮车。
    dup_rate = 1 - min(uniq, m) / m
    maxrep_ratio = maxrep / m if m else 0.0
    return dup_rate >= dup_rate_threshold or maxrep_ratio >= maxrep_ratio_threshold


# ── v3（2026-10-25）：**跨场次持续性** ────────────────────────────────
#
# 旧判据只看窗口累计的 `uniq/m`。问题：用户 483347460 在明前奶绿窗口里共 538 条、
# 整体不同文本率 13.9% 被判独轮车 —— 但拆开看是**一场歌回的 404 条打call**（0%）
# 把整体拉低了，其余 23 场几乎都正常（71.8% / 100% / 66.7%）。
# 打call 是场景行为，不是刷屏人格。
#
# 因此要求：**同一行为在多数场次里持续出现**才算独轮车。

#: 单场至少这么多条，才拿来做"场次证据"（太少是噪声）
MIN_SESSION_MSGS = 20
#: 单场判为"低多样性"的阈值（不同文本率）
SESSION_VARIETY = 0.20
#: 至少几场低多样性
MIN_LOW_VARIETY_SESSIONS = 2
#: 低多样性场次占"有证据场次"的比例下限
LOW_VARIETY_SHARE = 0.50


def is_spam_across_sessions(sessions: list[tuple[int, int]]) -> bool:
    """`sessions` = 每场的 `(弹幕数, 去重文本数)`；判定是否**跨场持续**刷屏。"""
    evidence = [(m, uniq) for m, uniq in sessions if m >= MIN_SESSION_MSGS]
    if not evidence:
        return False
    low = [1 for m, uniq in evidence if uniq / m <= SESSION_VARIETY]
    return len(low) >= MIN_LOW_VARIETY_SESSIONS and len(low) / len(evidence) >= LOW_VARIETY_SHARE


# ── v4（2026-10-25）：三档分层 ────────────────────────────────────────
#
# 独轮车不是二元的：单场打call 与 跨场复读 之间有明显中间地带。
# 用户要求分三档 —— **不是 / 疑似 / 确定**，判据全部来自可解释的统计量。

LEVEL_NONE = "none"
LEVEL_SUSPECTED = "suspected"
LEVEL_CONFIRMED = "confirmed"

#: 确定档：低多样性场次下限（2026-10-25 用户定：连续两场高强度刷屏即算确定）
CONFIRM_MIN_LOW_SESSIONS = 2
#: 确定档：整体不同文本率上限
CONFIRM_MAX_VARIETY = 0.20
#: 确定档：低多样性场占证据场的比例下限（比「疑似」更严）
CONFIRM_LOW_SHARE = 0.60
#: 确定档：**总发言场次**下限 —— 场次太少的人见得太少，最多只能"疑似"
MIN_SPEAKING_SESSIONS = 5
#: 疑似档：整体不同文本率上限（比确定档松）
SUSPECT_MAX_VARIETY = 0.25


def level_for(*, m: int, uniq: int, sessions: list[tuple[int, int]],
              speaking_sessions: int = 0) -> str:
    """三档判定。`sessions` = 每场 `(弹幕数, 去重文本数)`。

    - **确定**：累计 ≥200 条、**总发言场次 ≥5**、整体不同文本率 ≤20%、
      且 ≥2 场低多样性（占比 ≥60%）；
    - 场次不足 5 的，无论多像，最多判**疑似**（2026-10-25 用户定）；
    - **疑似**：累计 ≥200 条，命中旧判据（整体 ≤25%）但持续性不足；
      或低多样性场 ≥50% 但整体率略高（≤25%）。
    - **不是**：其余。
    """
    if m < 200:
        return LEVEL_NONE
    variety = uniq / m if m else 1.0
    evidence = [(mm, uu) for mm, uu in sessions if mm >= MIN_SESSION_MSGS]
    low = [1 for mm, uu in evidence if uu / mm <= SESSION_VARIETY]
    share = len(low) / len(evidence) if evidence else 0.0

    if (variety <= CONFIRM_MAX_VARIETY
            and speaking_sessions >= MIN_SPEAKING_SESSIONS
            and len(low) >= CONFIRM_MIN_LOW_SESSIONS
            and share >= CONFIRM_LOW_SHARE):
        return LEVEL_CONFIRMED
    if variety <= SUSPECT_MAX_VARIETY or (share >= LOW_VARIETY_SHARE and low):
        return LEVEL_SUSPECTED
    return LEVEL_NONE
