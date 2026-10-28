"""结果包（2026-10-28）：每个 V 一个分析结果包，写盘、可跨重启。

钉四件事：

1. **往返一致**：`save` → `load` 能拿回同样的 payload 与元数据；
2. **摘要不含 payload**：`list_all` 只给元数据（前端切 V 时用，别把几百 KB 拉下来）；
3. **`matches` 是六格比对**：窗口 / 区间 / 场次清单任何一格不同都不算命中
   （`devlog/730` 的教训：差一格就重算十秒）；
4. **包优先于现算**：`_compute` 命中包时**根本不该再读盘** —— 用 monkeypatch 把
   `load_window` 换成"一调就炸"来证明这一点。
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

from app.services.fan import packages


def _payload(pool_size: int = 100) -> dict:
    return {
        "vtuber": "弥月Mizuki",
        "sessions": 25,
        "total_in_pool": pool_size,
        "pool": {"size": pool_size, "tiers": {"核心": 10, "次核心": 20, "外层": 70}},
        "items": [
            {"uid": "1", "type": "核心", "strength": 0.99},
            {"uid": "2", "type": "外层", "strength": 0.2},
        ],
        "charts": {"pay_split_top": {"labels": ["a"], "values": [1]}},
    }


def _save(tmp_path: Path, **over) -> dict:
    kw = dict(
        vtuber="弥月Mizuki", subdir="pilot_v3_mizuki", window=25,
        since="2026-09-01", until="2026-10-26",
        live_ids=["L1", "L2"], sessions=25, payload=_payload(),
    )
    kw.update(over)
    meta = packages.save(tmp_path, **kw)          # type: ignore[arg-type]
    assert meta is not None
    return meta


def test_save_load_roundtrip(tmp_path: Path) -> None:
    meta = _save(tmp_path)
    assert meta["window"] == 25 and meta["sessions"] == 25
    assert meta["overview"]["pool"] == 100
    assert meta["overview"]["uid_tier"] == {"1": "核心", "2": "外层"}

    body = packages.load(tmp_path, "pilot_v3_mizuki")
    assert body is not None
    assert body["payload"]["total_in_pool"] == 100
    assert body["live_ids"] == ["L1", "L2"]


def test_list_all_returns_metadata_only(tmp_path: Path) -> None:
    _save(tmp_path)
    items = packages.list_all(tmp_path)
    assert len(items) == 1
    assert "payload" not in items[0], "摘要不该带 payload（前端切 V 时只要元数据）"
    assert items[0]["overview"]["pool"] == 100


def test_matches_needs_every_field(tmp_path: Path) -> None:
    body = packages.load(tmp_path, "pilot_v3_mizuki") if _save(tmp_path) else None
    assert body is not None
    ok = dict(window=25, since="2026-09-01", until="2026-10-26", live_ids=["L1", "L2"])
    assert packages.matches(body, **ok) is True
    # 顺序无关（键里排过序）
    assert packages.matches(body, window=25, since="2026-09-01", until="2026-10-26",
                            live_ids=["L2", "L1"]) is True
    # 逐格改一格，都必须不命中
    assert packages.matches(body, window=75, since="2026-09-01", until="2026-10-26",
                            live_ids=["L1", "L2"]) is False
    assert packages.matches(body, window=25, since="2026-09-02", until="2026-10-26",
                            live_ids=["L1", "L2"]) is False
    assert packages.matches(body, window=25, since="2026-09-01", until="2026-10-27",
                            live_ids=["L1", "L2"]) is False
    assert packages.matches(body, window=25, since="2026-09-01", until="2026-10-26",
                            live_ids=["L1"]) is False


def test_corrupt_package_is_ignored(tmp_path: Path) -> None:
    _save(tmp_path)
    path = packages.package_path(tmp_path, "pilot_v3_mizuki")
    path.write_bytes(b"not a gzip")
    assert packages.load(tmp_path, "pilot_v3_mizuki") is None
    assert packages.list_all(tmp_path) == []


def test_compute_prefers_package_over_loading(tmp_path: Path,
                                              monkeypatch: pytest.MonkeyPatch) -> None:
    """命中包时 **不该再读盘** —— 把 `load_window` 换成"一调就炸"来证明。"""
    _save(tmp_path)
    monkeypatch.setenv("DDTOOLKIT_FAN_DATA_DIR", str(tmp_path))

    from app.routers import fan as fan_router

    def boom(*a, **k):
        raise AssertionError("命中结果包时不该再调用 load_window")

    monkeypatch.setattr(fan_router, "load_window", boom)
    fan_router.reset_state()
    try:
        payload = fan_router._compute("弥月", 25, "2026-09-01", "2026-10-26",
                                      ["L1", "L2"])
        assert payload["total_in_pool"] == 100
    finally:
        fan_router.reset_state()


def test_delete_removes_package(tmp_path: Path) -> None:
    _save(tmp_path)
    assert packages.package_path(tmp_path, "pilot_v3_mizuki").is_file()
    packages.delete(tmp_path, "pilot_v3_mizuki")
    assert packages.load(tmp_path, "pilot_v3_mizuki") is None


def test_package_file_is_gzip_and_atomic(tmp_path: Path) -> None:
    _save(tmp_path)
    path = packages.package_path(tmp_path, "pilot_v3_mizuki")
    with gzip.open(path, "rt", encoding="utf-8") as f:
        body = json.load(f)
    assert body["version"] == packages.FORMAT_VERSION
    assert not path.with_suffix(".gz.tmp").exists(), "临时文件必须被原子替换掉"
