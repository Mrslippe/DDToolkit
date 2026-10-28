"""测试用的 `Window` 缓存（2026-10-28，`devlog/714`）。

## 为什么要它

`load_window()` 是整套 fan 用例里唯一的重活：读 N 个 `stats/*.json` + `raw/*.json.gz`
再聚合。实测每个 V（75 场）**约 10–25 s，而纯计算只有 1–4 s/窗口** —— 也就是说
99% 的时间花在"把同一批文件再解析一遍"。而好几个用例文件反复要的是**同一批窗口**。

## 缓存键必须含**窗口身份**

`(主播, n, since, until, live_ids, require_entry, min_records)` 一项都不能少：

- 「最近 75 场」与「截至 2026-10-26 的最近 75 场」是**两个不同的窗口**
  （`test_fan_loader.py` 的 `FROZEN_UNTIL` 就是后者）；
- `test_fan_checks.py` 里还有 `n=400, require_entry=False, min_records=0` 的"全量放开"窗口。

而分位是**窗口内相对**的（`devlog/712`：绝对值不冻结就没有意义）⇒ 键里漏一项就会
串味成"拿错窗口算出来的数字"，而且症状极隐蔽（数字看着合理）。**宁可少命中，不能拿错窗口。**

## 容量 4 + LRU

`tracemalloc` 实测四个窗口同时常驻约 **1.17 GiB**（弥月 108 / 明前 413 / 星瞳 738 /
七海 1172 MiB）。容量 4 恰好覆盖"一个文件的完整工作集（4 个 V）"，再大就只是白占内存。
机器内存紧张时用 `DDTOOLKIT_FAN_TEST_NO_CACHE=1` 关掉（慢，但回到逐条重载）。

## 前提：用例只读窗口

共享同一个对象，任何用例改了它就会串味（表现为"换个顺序跑就红"）。
`checks.check_identity` / `build_axis_table` / `type_label` / `participation_strength` /
`rank` 都不改 `Window`（已逐个核对）。**以后加用例若要改窗口，先复制一份再改。**

## 只给"真实数据"的窗口用

**没有 `root=` 参数，故意的**：键里没有任何路径信息，若让人传 `root=tmp_path`
（`test_fan_loader.py` 里几十处合成数据集都是这么造的），临时目录的窗口就会和
真实数据的窗口撞进同一个键。合成数据集**直接调 `load_window(..., root=…)`**，别走这里。
"""

from __future__ import annotations

import os
from collections import OrderedDict
from typing import Sequence

import pytest

from app.services.fan import load_window, resolve_data_dir
from app.services.fan.loader import MIN_RECORDS, Window, get_vtuber

#: 缓存容量（窗口个数）。4 = 一个文件的完整工作集；再大只是白占内存。
CAPACITY = 4

#: 逃生阀：`DDTOOLKIT_FAN_TEST_NO_CACHE=1` 时不缓存（慢但省内存）。
_NO_CACHE = os.getenv("DDTOOLKIT_FAN_TEST_NO_CACHE") == "1"

_CACHE: "OrderedDict[tuple, Window]" = OrderedDict()

#: 命中统计（调试用：`window_stats()`）—— 用例不该依赖它，只是让"缓存到底有没有用"可观测。
_COUNT = {"hit": 0, "miss": 0}


def _key(vtuber, n, since, until, live_ids, require_entry, min_records) -> tuple:
    """窗口身份。

    ⚠️ `vtuber` 允许是 `str`（短名）或 `VtuberRef`，但**键必须归一成 `subdir`**：
    否则 `_window("弥月")` 与 `_window(VTUBERS[0])` 会各存一份**同一个窗口**
    （既不省时间，还把内存翻倍）。
    """
    sub = getattr(vtuber, "subdir", None)
    if not sub:
        try:
            sub = get_vtuber(vtuber).subdir
        except Exception:  # noqa: BLE001  — 解析不到就退回原值，宁可多存一份也别张冠李戴
            sub = str(vtuber)
    ids = tuple(live_ids) if live_ids else None
    if ids is not None:
        ids = tuple(sorted(ids))       # 顺序不该产生两个缓存条目
    return (sub, n, since, until, ids, require_entry, min_records)


def window(
    vtuber,
    n: int = 75,
    *,
    require_entry: bool = True,
    min_records: int = MIN_RECORDS,
    since: str | None = None,
    until: str | None = None,
    live_ids: "Sequence[str] | None" = None,
) -> Window:
    """取窗口（同一「窗口身份」只读一次盘）。没有真实数据时 `pytest.skip`。"""
    key = _key(vtuber, n, since, until, live_ids, require_entry, min_records)
    if not _NO_CACHE:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
            _COUNT["hit"] += 1
            return hit

    try:
        resolve_data_dir()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"没有真实数据：{exc}")
    try:
        w = load_window(vtuber, n, require_entry=require_entry, min_records=min_records,
                        since=since, until=until, live_ids=live_ids)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"{getattr(vtuber, 'short', vtuber)} 数据不可用：{exc}")

    # 空窗口 = 数据不在或不完整（CI 上没有数据集，这是常态）⇒ 跳过，
    # 而不是让调用方的每条断言各报一次错。与改动前各文件里的 `if not w.users: skip` 同义。
    if not w.users:
        pytest.skip(f"{getattr(vtuber, 'short', vtuber)} 窗口里没有用户（数据不完整）")

    if not _NO_CACHE:
        _COUNT["miss"] += 1
        _CACHE[key] = w
        _CACHE.move_to_end(key)
        while len(_CACHE) > CAPACITY:
            _CACHE.popitem(last=False)     # 淘汰最久未用的那个
    return w


def window_stats() -> dict[str, int]:
    """`{"hit": …, "miss": …, "resident": …, "capacity": …}`（调试/自检用）。"""
    return {**_COUNT, "resident": len(_CACHE), "capacity": CAPACITY}


def clear() -> None:
    """清空缓存与计数（用例之间不需要，供手工调试）。"""
    _CACHE.clear()
    _COUNT["hit"] = 0
    _COUNT["miss"] = 0
