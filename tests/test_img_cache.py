"""图片磁盘缓存的容量上限（R22，devlog/103）。

原来只管时间不管体积：TTL 7 天、文件留到 14 天才删，**上限是没有的**。
实测开发档就长到 101.7MB / 271 个文件，而它是数据目录里涨得最快的一块 ——
用户可以有一万张封面/头像要缓存，C 盘却只有几个 G。

判错的代价（都在界面上看不出来）：
- 上限失效 → 缓存无限长，用户以为"这软件怎么越来越占地方"；
- 淘汰判据写成"抓取时间"而不是 mtime → **热图（左栏头像、常看的封面）按"抓得早"被删**，
  每次打开都要回源，用户只觉得"这软件图片加载好慢"。
"""
from __future__ import annotations

import time
from pathlib import Path

import pytest

from app.routers import img_proxy


@pytest.fixture()
def cache(tmp_path, monkeypatch):
    """把缓存目录与上限都指到临时值（模块级常量，测试直接改）。"""
    d = tmp_path / "img-cache"
    d.mkdir()
    monkeypatch.setattr(img_proxy, "CACHE_DIR", d)
    monkeypatch.setattr(img_proxy, "_CACHE_MAX_BYTES", 1000)
    monkeypatch.setattr(img_proxy, "_last_cleanup", 0.0)
    return d


def _put(cache_dir: Path, name: str, size: int, age_seconds: float = 0.0) -> Path:
    p = cache_dir / f"{name}.bin"
    p.write_bytes(b"x" * size)
    p.with_suffix(".json").write_text('{"type": "image/png", "fetched_at": %f}'
                                      % (time.time() - age_seconds), encoding="utf-8")
    if age_seconds:
        old = time.time() - age_seconds
        import os
        os.utime(p, (old, old))
    return p


def test_over_cap_evicts_least_recently_used_first(cache):
    """超上限 → 按 mtime 最旧优先删到上限以下（近似 LRU）。"""
    _put(cache, "old", 400, age_seconds=3600)
    _put(cache, "mid", 400, age_seconds=1800)
    _put(cache, "hot", 400, age_seconds=10)      # 刚用过

    stats = img_proxy.prune_cache()
    assert stats["evicted"] >= 1
    left = {p.stem for p in cache.glob("*.bin")}
    assert "old" not in left                      # 最久未用先走
    assert "hot" in left                          # 热的必须留下
    total = sum(p.stat().st_size for p in cache.glob("*.bin"))
    assert total <= 1000


def test_prune_deletes_the_meta_file_too(cache):
    """`bin` 与 `json` 要成对删 —— 只删一个会留下"有元数据没图"的坑，命中逻辑会回源又写不进去。"""
    _put(cache, "a", 900)
    _put(cache, "b", 900)
    img_proxy.prune_cache()
    bins = {p.stem for p in cache.glob("*.bin")}
    jsons = {p.stem for p in cache.glob("*.json")}
    assert bins == jsons


def test_expired_entries_go_regardless_of_cap(cache):
    """过期判据是 TTL 的 2 倍（命中判定只看 7 天，删除再留 7 天窗口）。"""
    _put(cache, "ancient", 10, age_seconds=img_proxy._CACHE_TTL * 2 + 60)
    _put(cache, "fresh", 10)
    stats = img_proxy.prune_cache()
    assert stats["expired"] == 1
    assert {p.stem for p in cache.glob("*.bin")} == {"fresh"}


def test_zero_cap_disables_eviction(cache, monkeypatch):
    """上限设 0 = 只按时间清（给"我不想让它自动删"留一条退路）。"""
    monkeypatch.setattr(img_proxy, "_CACHE_MAX_BYTES", 0)
    _put(cache, "a", 5000)
    stats = img_proxy.prune_cache()
    assert stats["evicted"] == 0
    assert (cache / "a.bin").exists()


def test_cache_stats_reports_usage_and_cap(cache):
    _put(cache, "a", 300)
    _put(cache, "b", 200)
    st = img_proxy.cache_stats()
    assert st == {"files": 2, "bytes": 500, "max_bytes": 1000}


def test_clear_cache_removes_everything(cache):
    """用户主动点的「清理图片缓存」= **全清**（口径 2026-09-16）。"""
    _put(cache, "a", 300)
    _put(cache, "b", 200)
    got = img_proxy.clear_cache()
    assert got == {"files": 2, "bytes": 500}
    assert list(cache.glob("*")) == []


def test_clear_cache_also_sweeps_orphan_meta(cache):
    """只有元数据、没有图（写入被打断留下的）也要清 —— 否则它会一直算进占用里。"""
    (cache / "orphan.json").write_text('{"type": "image/png"}', encoding="utf-8")
    _put(cache, "keep", 100)
    got = img_proxy.clear_cache()
    assert got["files"] == 2
    assert list(cache.glob("*")) == []


def test_clear_cache_on_empty_dir_is_safe(cache):
    assert img_proxy.clear_cache() == {"files": 0, "bytes": 0}
