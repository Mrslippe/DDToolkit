"""直播场次类型**落库**（写时定稿）与惰性回填。

用户决策（2026-10-12）：
> 「直播场次信息在入库的时候根据其中携带的各类数据直接推断出类型，
>  不需要再在新增场次的时候去考虑改变已经入库的历史场次类型」

落到工程上是三条，本模块是它们的唯一实现处：

1. **逐场次、本地推断** —— 只看这一场自己带的数据（标题 / 分区 / 起播时刻）；
2. **写哪一行就定稿哪一行**，**不回头改别的行**；
3. **规则改了不回填老数据** —— 老场次停在写入时的规则上，用户要改就自己校正。

⚠️ 与读路径那套「v2 七档信号栈」（`app/services/live_type.py::infer_category`）的关系：
落库口径**只取逐场次能算的那几档**，两档全局信号**不参与落库**：

| 档 | 落库 | 为什么 |
|---|---|---|
| `override` | ❌ | 它是**用户写的事实**，读取时压在落库值上面（`live_category_overrides` 独立存在） |
| `series` | ❌ | 骨架聚类要「同账号、全历史」；逐场次下同一骨架每次结论都相同 ⇒ 这一档在落库口径里没有意义 |
| `title` | ✅ | 多词评分 |
| `learned` | ❌ | 校正反哺词库同样是全账号聚合；实测贡献 0 场。代价：校正只影响被点的那一场 |
| `area` | ✅ | B 站房间分区（实测占 47.9%，是主力） |
| `date` | ✅ | 生日/首播日/事件当日比对。⚠️ 真机 14 个 V **有生日 0 个、有首播日 0 个** ⇒ 今天永远不命中 |
| `fallback` | ✅（不落库） | 中性「直播」；**算出来是兜底时两列写 NULL**，理由见 `settle_fields` |

## 分层（别把这段代码往下挪）

⚠️ **本模块是服务层，`LiveSessionRepo` 不能 import 它**（判据：
`tests/test_dependency_direction.py::test_repositories_do_not_import_services`）。
所以形状是「**服务层装好上下文交给仓库写**」：`settle_fields()` 算出两列 →
写点把结果塞进 `fields` → 仓库只负责 `setattr`。

这与仓库那条既有纪律同源（`upsert_danmakus` 的 `platform` 必须由调用方传入：
**仓库层不替上层做决定**）。`create_manual`/`update_row` 这两条"没有 fields 字典可塞"
的路径由路由层在调用后补写一次（`apply_to_row`）—— 它们各自只有一次 UPDATE，没有批处理。

**惰性回填**为什么存在：迁移会自动跑（`app/main.py::lifespan` → `_run_migrations`），
但 `scripts/backfill_*.py` **不会**（那五个脚本只有人手执行才跑）——所以老库那批场次的
`category` 列会一直是 NULL。做法是**读路径顺手补齐**：补过就不再补（列不为 NULL 即跳过），
每个账号只补一次，用的推断函数与写路径**同一个**（不存在"回填规则和入库规则跑偏"）。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from app.models.vtuber import LiveSession
from app.services.live_type import CATEGORY_KEYS, LIVE, infer_category

# ── 读取口径：落库值 / 兜底 ──────────────────────────────────────

def normalize_stored_category(category: str | None,
                              category_from: str | None = None) -> tuple[str, str]:
    """落库值 → 可展示的 (category, category_from)；未知值**退回中性**（约束 C4）。

    为什么需要：分类体系会变（T3 就要把「健身」换成「助眠」），库里会**短暂存在旧值**
    ——前端 `liveTypeLabel` 对未知 key 本来就有兜底（显示「直播」），但"库里是旧值、
    接口把它当合法值透出去"会让**筛选/统计**那一侧出现一个没有标签的空壳。
    这里统一在服务端收口：认不出来的 key ⇒ 当作中性 `live`（并如实写上 `unknown`）。

    ⚠️ 只改**读数**，不回写：库里那条原值留着（体系改回来时数据还在原地）。
    """
    if category in CATEGORY_KEYS:
        return category, (category_from or "stored")
    return LIVE, "unknown"


def settle(title: str | None, area_name: str | None = None,
           parent_area_name: str | None = None,
           start_at: datetime | None = None,
           birthday: str | None = None, debut_date: str | None = None,
           event_dates=()) -> tuple[str, str]:
    """这一场**该落库的类型**：逐场次判据，返回 (category, category_from)。

    纯函数（不查库、不提交、不看别的场次）——写点直接调它，不需要任何上下文装配。
    `birthday`/`debut_date`/`event_dates` 由调用方按需传入（今天真机全为空，见模块头）。
    """
    return infer_category(
        title, area_name, parent_area_name, start_at,
        birthday=birthday, debut_date=debut_date, event_dates=event_dates,
    )


def settle_fields(title: str | None, area_name: str | None = None,
                  parent_area_name: str | None = None,
                  start_at: datetime | None = None) -> dict[str, str | None]:
    """给**写点的 `fields` 字典**用的定稿结果：`{"category": …, "category_from": …}`。

    ⚠️ 兜底（`fallback`）**一律写 NULL**（不是写 "live"）："算过但没定出来"和
    "还没跑过定稿"在库里必须是同一种状态，否则 `_resolve_categories` 没法只靠
    "列是不是空"决定该不该现算，同一行还会随"是写点写的还是回填写的"而不同。

    ⚠️ **`None` 是"定稿过了，结论是没定出来"**，与"不含这两个键 = 别动它"不同 ——
    仓库层按这条区分（见 `LiveSessionRepo._upsert`）。
    """
    category, source = settle(title, area_name, parent_area_name, start_at)
    if source == "fallback":
        return {"category": None, "category_from": None}
    return {"category": category, "category_from": source}


def settle_danmakus_item(item: dict[str, Any],
                         start_at: datetime | None = None) -> dict[str, str | None]:
    """danmakus 原始条目（**平台字段名** title/area/parentArea）→ 定稿结果。

    `start_at` 由调用方算好传进来（`danmakus.py::_ms_to_utc`）—— 那一层已经有一份
    "毫秒时间戳 → 库内 naive UTC"的转换，本模块**不复制**第二份（两份迟早会漂）。
    ⚠️ 用它而不是"本工具第一次看见"的时刻：逐场次判据里只有 `date` 那一档用到时间，
    它比的是**直播当天**是不是纪念日，用观测时刻会在跨零点时比错日子。
    """
    return settle_fields(item.get("title"), item.get("area"), item.get("parentArea"),
                         start_at)


def apply_to_row(row: LiveSession) -> tuple[str, str]:
    """按**表内行自己的字段**定稿并写进两列（不提交，随调用方的事务走）。

    给"没有 fields 字典可塞"的两条路径用：`create_manual` / `update_row` 之后由路由层调。
    """
    fields = settle_fields(row.title, row.area_name, row.parent_area_name, row.start_at)
    row.category = fields["category"]
    row.category_from = fields["category_from"]
    return settle(row.title, row.area_name, row.parent_area_name, row.start_at)


# ── 读取口径：落库列 / 现算 的选择 ───────────────────────────────

def for_group(group: dict, stored: tuple[str, str] | None) -> tuple[str, str]:
    """合并组该显示什么类型 —— 一条规则管两处，避免两处口径漂移。

    1. **有落库值就信落库值**（单行场次、以及惰性回填过的老行都走这条）；
    2. 没有落库值 ⇒ 用**同一个** `settle()` 现算（不落库）：
       - 虚拟场次（合并组里没有表内行）本来就没有列可读；
       - 老库尚未回填的行、以及回填判定为 `fallback` 而未落库的行，也走这条。

    ⚠️ 不在这里做 `override`：那是读取侧最后一道覆盖（见 `app/routers/vtuber.py`），
    并且要按 `live_id` 查校正表，不属于"这一场自己的数据"。
    """
    if stored is not None:
        return stored
    return settle(group.get("live_title"), group.get("area_name"),
                  group.get("parent_area_name"), group.get("start_at"))


# ── 惰性回填 ─────────────────────────────────────────────────────

class BackfillStats:
    """回填结果（判据用：第二次读不许再写）。"""

    def __init__(self) -> None:
        self.scanned = 0        # 扫过的行
        self.written = 0        # 落库的行
        self.skipped = 0        # 有值 / 算出来是兜底 ⇒ 没写

    def __repr__(self) -> str:  # pragma: no cover - 只为日志可读
        return (f"BackfillStats(scanned={self.scanned}, written={self.written}, "
                f"skipped={self.skipped})")


def backfill_rows(rows: list[LiveSession]) -> BackfillStats:
    """惰性回填：给 `category` 还是 NULL 的行补上定稿值（**不提交**，随请求的事务走）。

    ⚠️ 只给**合并组的代表行**调用（调用方筛好再传）：同一场的非代表行保持 NULL，
    读的时候由代表行供值。

    为什么只写"真正的推导"（`title`/`area`/`date`），**不写 `fallback`**：
    兜底是"规则没定出来"的标记，不是结论。写进去会让两件事永久化 ——
    ① 以后规则变好也认不出这些行该重算（列不空了）；② 统计口径里 `fallback`
    变成"库里有值"，与"从未判定"混在一起。NULL 反而是诚实的：**读取时照样显示中性**，
    因为 `for_group` 会对没有落库值的组现算一次。
    """
    stats = BackfillStats()
    for row in rows:
        stats.scanned += 1
        if row.category is not None:
            stats.skipped += 1
            continue
        fields = settle_fields(row.title, row.area_name, row.parent_area_name,
                               row.start_at)
        if fields["category"] is None:
            stats.skipped += 1
            continue
        row.category = fields["category"]
        row.category_from = fields["category_from"]
        stats.written += 1
    return stats


__all__ = [
    "BackfillStats", "apply_to_row", "backfill_rows", "for_group",
    "normalize_stored_category", "settle", "settle_danmakus_item", "settle_fields",
]
