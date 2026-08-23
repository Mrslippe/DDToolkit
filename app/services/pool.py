"""VTuber 候选池：vtubers.csv 全量作为离线待选索引（不再启动入库）。

首调加载缓存；支持名称多关键词 AND 子串匹配、纯数字按 uid 前缀匹配。
"""
import csv
import threading
from dataclasses import dataclass
from pathlib import Path

from app.core.config import settings

_lock = threading.Lock()
_cache: list[dict] | None = None


@dataclass(frozen=True)
class PoolItem:
    name: str
    platform: str
    platform_uid: str


def _load() -> list[dict]:
    """读取 csv 全部行为候选（忽略 flag 列）。文件缺失返回空池。"""
    path = Path(settings.VTUBER_LIST_FILE)
    if not path.exists():
        return []
    items: list[dict] = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        name_key = "vtuber_name" if "vtuber_name" in (reader.fieldnames or []) else "name"
        for row in reader:
            name = (row.get(name_key) or "").strip()
            platform = (row.get("platform") or "").strip()
            uid = (row.get("platform_uid") or row.get("uid") or "").strip()
            if name and platform and uid:
                items.append(
                    {"name": name, "platform": platform, "platform_uid": uid,
                     "followers": _to_int(row.get("follower"))}
                )
    return items


def _to_int(v) -> int:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return 0


def _pool() -> list[dict]:
    global _cache
    if _cache is None:
        with _lock:
            if _cache is None:
                _cache = _load()
    return _cache


def search_pool(kw: str, limit: int = 20) -> list[dict]:
    """候选检索：空格分隔关键词 AND 命中名称（不区分大小写）；
    纯数字关键词同时按 uid 前缀匹配。按粉丝数降序返回前 limit 条。"""
    kw = (kw or "").strip().lower()
    pool = _pool()
    if not kw:
        return []

    tokens = kw.split()
    uid_tokens = [t for t in tokens if t.isdigit()]
    name_tokens = [t for t in tokens if not t.isdigit()]

    hits: list[dict] = []
    for it in pool:
        name_l = it["name"].lower()
        if name_tokens and not all(t in name_l for t in name_tokens):
            continue
        if uid_tokens and not any(it["platform_uid"].startswith(t) for t in uid_tokens):
            # 名称全命中时豁免 uid 条件，避免「名字+uid」混输漏配
            if not (name_tokens and all(t in name_l for t in name_tokens)):
                continue
        hits.append(it)

    hits.sort(key=lambda x: x["followers"], reverse=True)
    return [
        {"name": h["name"], "platform": h["platform"], "platform_uid": h["platform_uid"]}
        for h in hits[:limit]
    ]


def find_in_pool(platform: str, platform_uid: str) -> dict | None:
    """精确取池内条目（adopt 时回填规范名称用）。"""
    platform_uid = str(platform_uid)
    for it in _pool():
        if it["platform"] == platform and it["platform_uid"] == platform_uid:
            return {"name": it["name"], "platform": it["platform"],
                    "platform_uid": it["platform_uid"]}
    return None


def reload_pool() -> int:
    """强制重读 csv（外部维护名单后调用），返回池大小。"""
    global _cache
    with _lock:
        _cache = _load()
        return len(_cache)
