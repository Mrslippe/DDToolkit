"""对比页改读**结果包**（2026-10-28，用户第 3 条）。

对比的**基本单位 = 各 V 自己的结果包**：不再现算，直接读包里的 `overview.uid_tier`。

钉四件事：

1. 两个包 → 一个配对，交集人数正确；
2. **区间不同 ⇒ `ranges_differ` / `comparable=false`**（交集仍可信，相对量不可比）；
3. 缺包 ⇒ `needs_analysis` 列出该主播，其余仍照常出结果（不拖垮整次请求）；
4. 空包（没有名单）也算"缺"，不能让一个空包把矩阵算出 0/0。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.fan import packages


def _save(root: Path, subdir: str, name: str, tiers: dict[str, str],
          *, since: str = "2026-09-01", until: str = "2026-10-26",
          window: int = 75, sessions: int = 25) -> None:
    payload = {
        "vtuber": name, "sessions": sessions,
        "pool": {"size": len(tiers), "tiers": {"核心": 1, "次核心": 1, "外层": 1}},
        "items": [{"uid": u, "type": t, "strength": 0.5} for u, t in tiers.items()],
    }
    meta = packages.save(root, vtuber=name, subdir=subdir, window=window,
                         since=since, until=until, live_ids=[], sessions=sessions,
                         payload=payload)
    assert meta is not None


@pytest.fixture()
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DDTOOLKIT_FAN_DATA_DIR", str(tmp_path))
    from app.routers import fan as fan_router
    fan_router.reset_state()
    yield fan_router, tmp_path
    fan_router.reset_state()


def test_compare_uses_packages(env) -> None:
    fan_router, root = env
    _save(root, "pilot_v3_mizuki", "弥月Mizuki",
          {"u1": "核心", "u2": "外层", "u3": "次核心"})
    _save(root, "pilot_v3_xingtong", "星瞳",
          {"u2": "核心", "u3": "核心", "u9": "外层"})

    out = fan_router.compare_multi("弥月,星瞳", 75, None, None, None)
    assert out["basis"] == "packages"
    assert len(out["vtubers"]) == 2
    assert out["vtubers"][0]["package"]["window"] == 75
    assert len(out["pairs"]) == 1
    pair = out["pairs"][0]
    assert pair["intersection"] == 2
    assert pair["comparable"] is True
    assert pair["ranges_differ"] is False
    # 层级迁移是**用各自包里的层级**算的
    assert sum(pair["tier_moves"].values()) == 2


def test_compare_flags_incomparable_when_ranges_differ(env) -> None:
    fan_router, root = env
    _save(root, "pilot_v3_mizuki", "弥月Mizuki", {"u1": "核心"}, since="2026-09-01")
    _save(root, "pilot_v3_xingtong", "星瞳", {"u1": "核心"}, since="2026-08-01")

    out = fan_router.compare_multi("弥月,星瞳", 75, None, None, None)
    pair = out["pairs"][0]
    assert pair["intersection"] == 1          # 交集人数仍然可信
    assert pair["ranges_differ"] is True
    assert pair["comparable"] is False        # 相对量不可比
    assert out["ranges_differ"] is True
    assert any("不可比" in n for n in out["notes"])


def test_missing_and_empty_packages_are_reported(env) -> None:
    fan_router, root = env
    _save(root, "pilot_v3_mizuki", "弥月Mizuki", {"u1": "核心"})
    # 星瞳：**有包但名单是空的** ⇒ 也算缺（否则会拿空集合去算 0/0）
    _save(root, "pilot_v3_xingtong", "星瞳", {})

    out = fan_router.compare_multi("弥月,星瞳,七海", 75, None, None, None)
    names = [m["name"] for m in out["missing"]]
    assert any("星瞳" in n for n in names), "空包必须被当成缺，不能静默算 0 人"
    assert any("七海" in n for n in names), "完全没有包的主播要列进 needs_analysis"
    assert out["needs_analysis"]
    # 只剩一个可分析 ⇒ 不出矩阵，但仍给出逐 V 信息（前端好显示"差谁"）
    assert out["pairs"] == []
    assert len(out["vtubers"]) == 1
