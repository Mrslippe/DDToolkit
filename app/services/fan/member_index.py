"""成员详情用的小索引：`uid → [(live_id, m, p, e, uniq), …]`。

## 为什么需要

`/fan/{v}/member/{uid}` 原先每次都把窗口内**全部 raw 文件**重新读一遍再解析 ——
实测 **5.8–6.2 秒/次**，而其中 99.9% 的数据与这次请求无关。

这里改成：**每个窗口只扫一遍**，把所有用户的逐场切片收进一个紧凑索引，
之后任意用户的详情都是 O(1) 查表。索引按 `(subdir, live_ids)` 缓存，
采集完成后由路由的 `clear_cache()` 一并清掉。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

#: (subdir, 场次清单) → {uid: [(live_id, m, p, e, uniq), …]}
_INDEX: dict[tuple[str, tuple[str, ...]], dict[str, list[tuple]]] = {}
#: 上限：窗口切换很少，留 4 个够了（每个索引几十 MB）
_MAX_WINDOWS = 4


def clear() -> None:
    _INDEX.clear()


def build(data_dir: Path, subdir: str, sessions: list[tuple[str, str]]) -> dict[str, list[tuple]]:
    """扫一遍窗口内的 raw，产出 `uid → 逐场切片`。`sessions` = [(live_id, start_at), …]。"""
    key = (subdir, tuple(lid for lid, _ in sessions))
    hit = _INDEX.get(key)
    if hit is not None:
        return hit

    raw_dir = data_dir / subdir / "raw"
    idx: dict[str, list[tuple]] = {}
    for live_id, start_at in sessions:
        try:
            raw = json.loads((raw_dir / f"{live_id}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(raw, dict):
            continue
        for uid, a in raw.items():
            if not isinstance(a, dict):
                continue
            m = int(a.get("m") or 0)
            p = float(a.get("p") or 0.0)
            e = int(a.get("e") or 0)
            if not (m or p or e):
                continue                       # 该场没出现，不占索引
            idx.setdefault(uid, []).append(
                (live_id, start_at, m, round(p, 2), e, int(a.get("uniq") or 0)))

    if len(_INDEX) >= _MAX_WINDOWS:
        _INDEX.pop(next(iter(_INDEX)))
    _INDEX[key] = idx
    logger.info("member 索引已建：%s · %s 场 · %s 人", subdir, len(sessions), len(idx))
    return idx
