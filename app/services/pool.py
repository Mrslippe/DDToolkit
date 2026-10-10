"""VTuber 候选池：`vtubers.csv` 全量作为离线待选索引（不再启动入库）。

## 池子是什么（2026-10-08 C2 批，`devlog/457`）

随包的快照，由 `scripts/discover_vtubers.py` 从 **vdb.vtbs.moe** 生成。列：
`flag, vtuber_name, platform, platform_uid, follower, uuid, group_name, group_uuid,
extra_accounts`。**应用运行时不访问 vdb**（自限速 + 快照随包，见该脚本的文件头）。

- `uuid`：vdb 的稳定身份（跨平台同一人同一个）—— 用来对齐/去重，不作检索键；
- `group_name` / `group_uuid`：**企划归属**（vdb 的 `group_name` / `group`）。B3 的徽章就吃这两列；
- `extra_accounts`：`platform:id` 用 `|` 连起来，**只用于展示**（"他还在 twitter / youtube"）——
  那些平台我们抓不了，所以它们**不进检索池**（进了只会造出点不动的结果）。

## 检索

首调加载 + 缓存；名称多关键词 AND 子串匹配、纯数字按 uid 前缀匹配；按粉丝降序。
⚠️ 索引在加载时**一次性预处理**（小写名 + uid 字典）：此前每次检索都在循环里
`.lower()` 9482 次（实测 2.79ms/查询），预处理后是纯子串扫描。
"""
import csv
import json
import logging
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path

from app.core.config import PROJECT_ROOT, settings

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_cache: list[dict] | None = None
#: uid → 条目（`find_in_pool` 用；此前是"每次都线性扫一遍 1 万行"）
_by_uid: dict[tuple[str, str], dict] = {}


@dataclass(frozen=True)
class PoolItem:
    name: str
    platform: str
    platform_uid: str


def _to_int(v) -> int:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return 0


def _row_dict(row: dict, name_key: str) -> dict | None:
    """CSV 一行 → 池条目；缺关键列返回 None。**新列全部可选**（旧 CSV 也能读）。"""
    name = (row.get(name_key) or "").strip()
    platform = (row.get("platform") or "").strip()
    uid = (row.get("platform_uid") or row.get("uid") or "").strip()
    if not name or not platform or not uid:
        return None
    return {
        "name": name,
        "platform": platform,
        "platform_uid": uid,
        "followers": _to_int(row.get("follower")),
        "name_l": name.lower(),
        "uuid": (row.get("uuid") or "").strip(),
        "group_name": (row.get("group_name") or "").strip(),
        "group_uuid": (row.get("group_uuid") or "").strip(),
        "extra_accounts": (row.get("extra_accounts") or "").strip(),
    }


def load_pool(path: Path) -> list[dict]:
    """读一份池 CSV（**纯函数式**：给定路径就给列表，便于用例直接喂临时文件）。"""
    if not path.exists():
        return []
    items: list[dict] = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        name_key = "vtuber_name" if "vtuber_name" in (reader.fieldnames or []) else "name"
        for row in reader:
            it = _row_dict(row, name_key)
            if it is not None:
                items.append(it)
    return items


def bundled_path() -> Path:
    """随包那份池 CSV（开发时是仓库根、打包后是 `_MEIPASS`）。"""
    return Path(PROJECT_ROOT) / "vtubers.csv"


def seed_from_bundle(force: bool = False) -> dict:
    """数据目录里没有池 CSV 时，从**随包那份**引导一份（返回做了什么）。

    ⚠️ 为什么必须有这一步（2026-10-08 查出来的真问题）：运行时读的是
    `DATA_DIR/vtubers.csv`，而**没有任何代码把随包的 CSV 复制过去** ⇒
    **全新安装的候选池是空的**（`load_pool` 见文件不存在就返回空列表），
    症状是"添加 V 里本地候选池一条都搜不到"，而日志里一个字都没有。
    判据：`tests/test_pool_csv.py::test_seed_copies_bundled_pool_once`。
    """
    dst = Path(settings.VTUBER_LIST_FILE)
    src = bundled_path()
    if dst.exists() and not force:
        return {"seeded": False, "reason": "already-exists", "path": str(dst)}
    if not src.exists():
        return {"seeded": False, "reason": "bundle-missing", "path": str(dst)}
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    logger.info("候选池已从随包快照引导到数据目录：%s（%d 字节）", dst, dst.stat().st_size)
    return {"seeded": True, "reason": "ok", "path": str(dst)}


def _pool() -> list[dict]:
    global _cache, _by_uid
    if _cache is None:
        with _lock:
            if _cache is None:
                seed_from_bundle()
                _cache = load_pool(Path(settings.VTUBER_LIST_FILE))
                _by_uid = {(it["platform"], it["platform_uid"]): it for it in _cache}
    return _cache


def search_pool(kw: str, limit: int = 20) -> list[dict]:
    """候选检索：空格分隔关键词 AND 命中名称（不区分大小写）；
    纯数字关键词同时按 uid 前缀匹配。按粉丝数降序返回前 limit 条。

    返回项含 `group` / `uuid` / `extra`（B3 的徽章与"他还在…"展示用；旧 CSV 里为空串）。
    """
    kw = (kw or "").strip().lower()
    pool = _pool()
    if not kw:
        return []

    tokens = kw.split()
    uid_tokens = [t for t in tokens if t.isdigit()]
    name_tokens = [t for t in tokens if not t.isdigit()]
    has_name = bool(name_tokens)

    hits: list[dict] = []
    for it in pool:
        name_l = it["name_l"]
        name_ok = has_name and all(t in name_l for t in name_tokens)
        if has_name and not name_ok:
            continue
        if uid_tokens and not any(it["platform_uid"].startswith(t) for t in uid_tokens):
            # 名称全命中时豁免 uid 条件，避免「名字+uid」混输漏配
            if not name_ok:
                continue
        hits.append(it)

    hits.sort(key=lambda x: (-x["followers"], x["name"]))
    return [_public(h) for h in hits[:limit]]


def _public(it: dict) -> dict:
    """对外形状（⚠️ 不含内部字段 `name_l`；新列用界面上的名字）。

    ⚠️ **`uuid` 是"这个人"的 uuid，`group_uuid` 才是"企划"的 uuid** —— 两列在 vdb 里
    是两个不同的字段（`uuid` / `group`），写这块时把前者当后者用过一次（用例当场抓到）。
    """
    return {"name": it["name"], "platform": it["platform"],
            "platform_uid": it["platform_uid"],
            "group": it.get("group_name") or "",
            "group_uuid": it.get("group_uuid") or "",
            "uuid": it.get("uuid") or "",
            "extra": it.get("extra_accounts") or ""}


def find_in_pool(platform: str, platform_uid: str) -> dict | None:
    """精确取池内条目（adopt 时回填规范名称/企划用；字典索引，O(1)）。"""
    _pool()
    it = _by_uid.get((platform, str(platform_uid)))
    return _public(it) if it else None


def reload_pool() -> int:
    """强制重读 csv（外部维护名单后调用），返回池大小。"""
    global _cache
    with _lock:
        _cache = None
    return len(_pool())


def pool_meta() -> dict:
    """池子的"体检"信息（给界面说明与用例）：条数、企划覆盖、随包快照的元数据。"""
    pool = _pool()
    meta: dict = {"rows": len(pool),
                  "with_group": sum(1 for it in pool if it["group_name"]),
                  "groups": len({it["group_name"] for it in pool if it["group_name"]}),
                  "with_extra": sum(1 for it in pool if it["extra_accounts"])}
    side = bundled_path().with_suffix(".meta.json")
    if side.exists():
        try:
            doc = json.loads(side.read_text(encoding="utf-8"))
            meta["snapshot"] = {k: doc.get(k) for k in
                                ("fetched_at", "source", "rows", "with_group", "groups")}
        except (OSError, ValueError):
            pass
    return meta
