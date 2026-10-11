# -*- coding: utf-8 -*-
""""这场直播的回放在哪"的**匹配口径**（C1，需求 2.1，`devlog/464`）。

## 为什么要有这个模块

C1 的目标是"在场次附近找到它的录播"。但**没有任何一个信号单独可信** ——
2026-10-11 真机实测（`devlog/464`）：

- **时间窗**：3/12 个 V 在开播后 7 天内有投稿，可其中一条发布在开播**前 3 小时**
  （不是回放）、另一条是**音声**不是直播录像；
- **标题关键词**：`arc/search` 的 `keyword` 是个**子串过滤器**，不是相关度检索 ——
  拿「3D」去搜，18 条全是翻唱；而真回放的标题经常是「最肯忘却古人诗…」这种**跟场次标题毫无关系**的；
- **时长**：本该是最硬的信号（回放 ≈ 直播时长），可那 12 个 V 的投稿**普遍只有 3~5 分钟**
  —— 因为他们**根本不发回放**（回放在"专门录播号"上，那正是计划里说的第二种现实）。

⇒ 所以这里的口径是：**算一个可解释的分数、按分数排、由用户点一下确认**
（计划原话："命中给候选列表让用户点一下确认，**不要自动写死，误配比漏配更糟**"）。
分数与理由都要能显示给用户看 —— "为什么这条排第一"必须说得出来。

## 三个信号各自的分量（都做过实测校准）

| 信号 | 分量 | 依据 |
|---|---|---|
| **时长接近** | 最强（0–60） | 一场 3 小时的直播，回放不可能只有 4 分钟；而"短投稿"正好是剪辑/翻唱的特征 |
| **发布时间在开播之后** | 中（0–25） | 回放**必然**在开播之后（发布在开播前的**扣分**，那多半是上一场的或普通投稿） |
| **标题关键词重合** | 弱（0–15） | 有则加分，**没有不扣**（真回放标题常常无关键词） |
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

#: 回放**不可能**早于开播这么多（允许的时钟/时区误差；早于它就是别的投稿）
BEFORE_START_TOLERANCE = timedelta(hours=2)
#: 发布时间窗：开播前 2 小时 ～ 之后 7 天（再晚就不像这一场的回放了）
AFTER_START_WINDOW = timedelta(days=7)
#: 时长的相对容差（回放可能被裁掉头尾，或含中场休息）：±35% 或 ±20 分钟取大者
DURATION_TOLERANCE_RATIO = 0.35
DURATION_TOLERANCE_MINUTES = 20

#: 标题里这些"壳"要去掉再比（它们是排版，不是内容）
_BRACKET_RE = re.compile(r"[【】\[\]（）()《》<>「」『』]")
_SPLIT_RE = re.compile(r"[\s,，。!！?？~～|/\\+·\-—_]+")


def parse_duration(raw: str | None) -> int | None:
    """B 站投稿的时长串（`"1:45:32"` / `"45:32"` / `""`）→ 分钟数。

    ⚠️ 认不出返回 `None`（**不是 0**）：0 分钟会把"时长未知"算成"严重不匹配"，
    于是一条真回放因为上游没给 length 就被排到最后。
    """
    if not raw or not isinstance(raw, str):
        return None
    parts = raw.strip().split(":")
    if len(parts) not in (2, 3):
        return None
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    if any(n < 0 for n in nums):
        return None
    if len(nums) == 3:
        total = nums[0] * 60 + nums[1] + (1 if nums[2] >= 30 else 0)
    else:
        total = nums[0] + (1 if nums[1] >= 30 else 0)
    return total if total > 0 else None


def title_parts(title: str | None) -> list[str]:
    """标题 → 参与比对的片段（去排版符号、按分隔符切、丢掉 1 字与纯符号）。"""
    t = _BRACKET_RE.sub(" ", title or "")
    out = []
    for p in _SPLIT_RE.split(t):
        p = p.strip()
        # 单字噪声太大（"的"/"了"）；但**中文 2 字**要留（"杂谈"/"歌回"）
        if len(p) >= 2 and not p.isdigit():
            out.append(p)
    return out


def title_overlap(session_title: str | None, video_title: str | None) -> list[str]:
    """两边共有的片段（互为子串也算：`杂谈` ≈ `深夜杂谈`）。

    ⚠️ 这条**只加分不扣分**：真回放的标题常常跟场次标题毫无关系（实测
    「好不容易休息了⭐」的回放叫「最肯忘却古人诗…」）—— 拿它当门槛会漏掉真回放。
    """
    hits: list[str] = []
    for a in title_parts(session_title):
        for b in title_parts(video_title):
            if a and b and (a in b or b in a) and f"{a}≈{b}" not in hits:
                hits.append(f"{a}≈{b}")
    return hits


def as_utc(dt: datetime | None) -> datetime | None:
    """库里的时间是**朴素 UTC**（`schemas._ser_captured_at` 那一套约定），
    而 B 站给的是带偏移的 —— 比较前必须归一，否则 naive/aware 混比直接 TypeError。"""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def score_candidate(*, start_at: datetime, duration_minutes: int | None,
                    published_at: datetime | None, video_minutes: int | None,
                    session_title: str | None, video_title: str | None
                    ) -> tuple[int, list[str], list[str]]:
    """一条候选 → `(分数, 加分理由, 减分理由)`（都是给人看的短句）。

    分数只用于**排序**，不当作"这就是回放"的结论 —— 界面上永远要用户点一下。
    """
    plus: list[str] = []
    minus: list[str] = []
    score = 0
    start = as_utc(start_at)
    pub = as_utc(published_at)

    # ① 时长（最强）：只有两边都知道时长时才评
    if duration_minutes and video_minutes:
        delta = video_minutes - duration_minutes
        tol = max(int(duration_minutes * DURATION_TOLERANCE_RATIO),
                  DURATION_TOLERANCE_MINUTES)
        if abs(delta) <= tol:
            score += 60
            plus.append(f"时长接近（{video_minutes} 分 vs 本场 {duration_minutes} 分）")
        elif video_minutes * 3 < duration_minutes:
            # 远短于直播 ⇒ 剪辑/翻唱那一类：**这基本就排除了它是回放**
            minus.append(f"时长远短（{video_minutes} 分 vs 本场 {duration_minutes} 分）")
        else:
            score += max(0, 30 - abs(delta) // 10)
            plus.append(f"时长差 {delta:+d} 分（{video_minutes} vs {duration_minutes}）")

    # ② 发布时间
    if pub and start:
        if start - BEFORE_START_TOLERANCE <= pub <= start + AFTER_START_WINDOW:
            if pub >= start:
                score += 25
                plus.append(f"开播后发布（+{(pub - start).total_seconds() / 3600:.1f} 小时）")
            else:
                score += 8
                minus.append("发布在开播**之前**（可能是上一场的或普通投稿）")
        else:
            minus.append("不在开播前后的时间窗内")

    # ③ 标题关键词（只加分）
    hits = title_overlap(session_title, video_title)
    if hits:
        score += min(15, 5 * len(hits))
        plus.append("标题重合：" + "、".join(hits[:3]))

    return score, plus, minus
