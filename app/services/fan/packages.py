"""分析**结果包**的读写（2026-10-28，用户口径）。

## 为什么要有"包"

在此之前，分析结果只是三处临时状态：后端 `_CACHE`（进程内、键是窗口元组）、前端页面
`ranked` state（切 V 就丢）、对比页每次重算。用户要求把结果升级成**一等公民**：

> 分析结果应该作为一个包存在于缓存中，每个 V 存各自的结果，当切换到这个 V 的时候
> 默认展示这个结果，时间区间也默认跳到这个结果对应的区间。

所以：**每个 V 一个包**（`_packages/{subdir}.json.gz`），重新分析 = **整包覆盖**。

## 包里有什么

```
vtuber / subdir / window / since / until / live_ids / sessions / computed_at
overview: { pool, tiers{核心,次核心,外层}, uid_tier{uid: tier} }   ← 对比页的基本单位
payload:  完整结果（名单全量行 + 图表 + 标签目录）                  ← 结果分页直接切
```

⚠️ `payload` 存**名单全量行**（不是一页 20 行）：用户第 3 条要求"结果分页直接读取结果包"，
只有存全量才能本地切页。实测单包 gzip 后百 KB 量级，四个主播也就 1 MB 上下。

## 为什么要 `uid_tier`

对比页的配对详情里有「层级迁移」：需要知道同一 uid 在**各自包里**属于哪一层。
只存 tier 计数不够，必须存 uid → tier 的映射（池只有几千人，代价可接受）。

## 覆盖语义

一个 V 只有一个包位，`save()` 直接覆盖 —— 所以**前端要二次确认**（用户 2026-10-28 确认要）。
"""

from __future__ import annotations

import gzip
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: 包目录（相对数据根）。与 `stats/`、`raw/` 同级，但**不参与采集**。
PACKAGES_SUBDIR = "_packages"

#: 包格式版本：将来改结构时用它判断"老包不可用、重算一次"
FORMAT_VERSION = 1


def _pkg_dir(root: Path) -> Path:
    return root / PACKAGES_SUBDIR


def package_path(root: Path, subdir: str) -> Path:
    return _pkg_dir(root) / f"{subdir}.json.gz"


def save(
    root: Path,
    *,
    vtuber: str,
    subdir: str,
    window: int,
    since: str | None,
    until: str | None,
    live_ids: list[str] | None,
    sessions: int,
    payload: dict[str, Any],
) -> dict[str, Any] | None:
    """写包（**整包覆盖**）。失败只记日志、不抛 —— 缓存写不进去不该毁掉一次分析。"""
    try:
        body = {
            "version": FORMAT_VERSION,
            "vtuber": vtuber,
            "subdir": subdir,
            "window": int(window),
            "since": since,
            "until": until,
            "live_ids": list(live_ids or []),
            "sessions": int(sessions),
            "computed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "overview": _overview(payload),
            "payload": payload,
        }
        path = package_path(root, subdir)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".gz.tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False)
        tmp.replace(path)         # 原子替换：半途挂掉不会留下半个包
        return {k: v for k, v in body.items() if k != "payload"}
    except Exception as exc:  # noqa: BLE001
        logger.warning("fan: 结果包写入失败（%s）：%s", subdir, exc)
        return None


def _overview(payload: dict[str, Any]) -> dict[str, Any]:
    """从 payload 抽出对比页需要的**最小集**（池、分层计数、uid→层级）。"""
    pool = payload.get("pool") or {}
    tiers = pool.get("tiers") or {}
    uid_tier: dict[str, str] = {}
    for row in payload.get("items") or []:
        uid = row.get("uid")
        t = row.get("type")
        if uid and t:
            uid_tier[str(uid)] = str(t)
    return {
        "pool": int(pool.get("size") or len(uid_tier) or 0),
        "tiers": {k: int(v) for k, v in tiers.items()},
        "uid_tier": uid_tier,
        "uids": sorted(uid_tier),
    }


def load(root: Path, subdir: str) -> dict[str, Any] | None:
    """读整包（含 payload）。不存在/坏了/版本不符一律返回 None（调用方回退到现算）。"""
    path = package_path(root, subdir)
    if not path.is_file():
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            body = json.load(f)
        if int(body.get("version") or 0) != FORMAT_VERSION:
            logger.info("fan: 结果包版本不符（%s），忽略并重算", subdir)
            return None
        return body
    except Exception as exc:  # noqa: BLE001
        logger.warning("fan: 结果包读取失败（%s）：%s", subdir, exc)
        return None


def list_all(root: Path) -> list[dict[str, Any]]:
    """列出所有包的**元数据**（不含 payload）—— 前端切 V 时用它找"这个 V 有没有结果"。"""
    out: list[dict[str, Any]] = []
    d = _pkg_dir(root)
    if not d.is_dir():
        return out
    for path in sorted(d.glob("*.json.gz")):
        try:
            with gzip.open(path, "rt", encoding="utf-8") as f:
                body = json.load(f)
            if int(body.get("version") or 0) != FORMAT_VERSION:
                continue
            out.append({k: v for k, v in body.items() if k != "payload"})
        except Exception:  # noqa: BLE001 —— 坏包跳过，别让一个坏文件毁掉整个列表
            continue
    out.sort(key=lambda m: str(m.get("computed_at") or ""), reverse=True)
    return out


def delete(root: Path, subdir: str) -> None:
    """删包（清数据时连带清；不存在就当成功）。"""
    try:
        package_path(root, subdir).unlink(missing_ok=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning("fan: 结果包删除失败（%s）：%s", subdir, exc)


def matches(body: dict[str, Any], *, window: int, since: str | None,
            until: str | None, live_ids: list[str] | None) -> bool:
    """这个包是不是**这一次**要算的那一组参数（键 = 窗口 + 区间 + 场次清单）。

    ⚠️ 少比一格就等于拿错数据（`devlog/730` 的教训：`window` 差一格就重算十秒）。
    """
    return (
        int(body.get("window") or 0) == int(window)
        and (body.get("since") or None) == (since or None)
        and (body.get("until") or None) == (until or None)
        and sorted(body.get("live_ids") or []) == sorted(live_ids or [])
    )
