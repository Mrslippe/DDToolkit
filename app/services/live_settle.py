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
| `fallback` | ✅ | 中性「直播」；**`category='live'` + `category_from='fallback'`**（见下） |

⚠️ **兜底那条 2026-10-13 改了**（f017，`devlog/471`）：原来是"两列都写 NULL"，理由是
"NULL 表示还没定出来"。但那样按类型聚合**永远看不见这批**（真机实测约 55% 的场次：
合并视图 7,639 场 vs `GROUP BY category` 3,948 行），于是"类型已落库"这句话在
**按类型查询/统计**这两个用户可见入口上一直是空头支票。现在改成**兜底也落库**：
真实值写 category，而"定稿过没有"改由 **`category_from` 是不是 NULL** 单独回答 ——
这个信号原来就是它（`category_from` 一直在记"哪一档定的"）。

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

    ⚠️ **兜底也写**（`category='live'` + `category_from='fallback'`，f017 改）：两列都写 NULL
    会让按类型聚合看不见这批（真机约 55%），"按类型查询/统计"就成了空头支票。
    "定稿过没有"由 `category_from` 单独回答（NULL = 还没定稿，读取时现算一次）。

    ⚠️ **`None` 是"定稿过了，结论是没定出来"**，与"不含这两个键 = 别动它"不同 ——
    仓库层按这条区分（见 `LiveSessionRepo._upsert`）。
    """
    return _settle_pair(settle(title, area_name, parent_area_name, start_at))


def _settle_pair(settled: tuple[str, str]) -> dict[str, str | None]:
    """`settle()` 的返回值 → 写库的两列（**唯一一处**做"兜底怎么记"这个决定）。"""
    category, source = settled
    return {"category": category, "category_from": source}


def apply_to_row(row: LiveSession) -> tuple[str, str]:
    """按**表内行自己的字段**定稿并写进两列（不提交，随调用方的事务走）。

    给"没有 fields 字典可塞"的两条路径用：`create_manual` / `update_row` 之后由路由层调。
    """
    fields = settle_fields(row.title, row.area_name, row.parent_area_name, row.start_at)
    row.category = fields["category"]
    row.category_from = fields["category_from"]
    return settle(row.title, row.area_name, row.parent_area_name, row.start_at)


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


# ── 读取口径：落库列 / 现算 的选择 ───────────────────────────────

def for_group(group: dict, stored: tuple[str, str] | None) -> tuple[str, str]:
    """合并组该显示什么类型 —— 一条规则管两处，避免两处口径漂移。

    1. **有落库值就信落库值**（单行场次、以及惰性回填过的老行都走这条）；
    2. 没有落库值 ⇒ 用**同一个** `settle()` 现算（不落库）：
       - 虚拟场次（合并组里没有表内行）本来就没有列可读；
       - 老库尚未回填的行也走这条（f017 起"兜底"会落库，所以这条只剩"还没补"）。

    ⚠️ 不在这里做 `override`：那是读取侧最后一道覆盖（见 `app/routers/vtuber.py`），
    并且要按 `live_id` 查校正表，不属于"这一场自己的数据"。
    """
    if stored is not None:
        return stored
    return settle(group.get("live_title"), group.get("area_name"),
                  group.get("parent_area_name"), group.get("start_at"))


# ── 场次身份（f017）：把"这一场是谁"写进代表行 ─────────────────────
#
# 为什么需要：合并视图数的是**场次**，SQL `GROUP BY` 数的是**行**，
# 而"哪些行是同一场"只有读路径的四条合并判据（room/dup/interrupt/restart）说了算
# （`LiveSessionRepo.merged()`）。本段把那些组的物化目标算出来，
# 仓库层照着写进 `session_key` / `category`（见 `LiveSessionRepo.materialize_sessions`）。
#
# ⚠️ 它不改类型：类型仍然是写点定稿的那个值；本段只决定"哪一行代表这一场"。

class GroupState:
    """一个合并组的物化目标（仓库层照着写）。

    - `session_key`：这一场的身份（`代表行live_id#组里id最小的成员id`）；
    - `representative_id`：代表行 = 组里**优先级最高**的源那一行（同优先级取 id 最小的）；
    - `category` / `category_from`：这一场该显示的类型（写点定稿值；没有就现算）。
    """

    __slots__ = ("session_key", "representative_id", "category", "category_from",
                 "member_ids")

    def __init__(self, session_key: str, representative_id: str,
                 category: str, category_from: str, member_ids: tuple[str, ...]) -> None:
        self.session_key = session_key
        self.representative_id = representative_id
        self.category = category
        self.category_from = category_from
        self.member_ids = member_ids


def group_states(sessions: list[dict]) -> list[GroupState]:
    """合并视图 → 每个组的物化目标（**纯函数**，不查库）。

    `sessions` 必须是 `merged(..., with_ids=True)` 的结果（需要 `src_live_ids`）；
    每组的 `stored_category`（代表行的落库原始元组，没有就是 None）由调用方填好。
    """
    out: list[GroupState] = []
    for s in sessions:
        live = {k: v for k, v in (s.get("src_live_ids") or {}).items()
                if v and k != "self"}
        if not live:
            continue                      # 纯虚拟场次：没有行可挂（不物化）
        # 代表行 = **`merged()` 给这个组定的对外 `live_id` 那一行**（它按源优先级选，
        # 同优先级时按成员的加入顺序取第一个）。
        #
        # ⚠️ 为什么不在这里自己排一遍：那条 tie-break 是 `merged()` 的实现细节
        #    （同源两行时它取决于合并顺序），自己排就会与对外 id 分叉 ——
        #    而读取侧是按对外 id 查落库值的。分叉的症状是"这一场的类型**静默**退回
        #    现算/兜底"（真机上同源两行的组上踩到过：物化写了 A 行，查的是 B 行）。
        representative = s.get("live_id")
        if not representative or representative not in live.values():
            representative = min(live.values())
        anchor = min(live.values())
        stored = s.get("stored_category")
        # ⚠️ 认不出来的落库值**归一成中性**（约束 C4），而不是拿今天的规则重算一遍：
        #    "这一格是旧体系留下的、今天没有含义"本身就是一条信息，重算会把它抹掉
        #    （重算出来多半也是兜底，结果一样但读出来的 `category_from` 不同）。
        #    归一之后写进列，按列聚合才不会统计到一个没有标签的空壳。
        # ⚠️ `(None, None)` 也要走现算：那是"这一行还没定稿"（调用方已把这种情形折成 None，
        #    这里再挡一次 —— 少了它 `normalize_stored_category(None)` 会把它读成 `unknown`，
        #    而 `unknown` 的语义是"库里是个认不出来的枚举"，不是"还没定稿"）。
        if stored is not None and stored[0] is not None:
            category, source = normalize_stored_category(*stored)
        else:
            category, source = settle(s.get("live_title"), s.get("area_name"),
                                      s.get("parent_area_name"), s.get("start_at"))
        out.append(GroupState(
            session_key=f"{representative}#{anchor}",
            representative_id=representative,
            category=category,
            category_from=source,
            member_ids=tuple(live.values()),
        ))
    return out


# ── 惰性物化的记账 ───────────────────────────────────────────────
#
# ⚠️ 分层：**写库那一段在仓库层**（`LiveSessionRepo.materialize_sessions`）——
# 它要用 `_SOURCE_PRIORITY` 选代表行、还要按批 UPDATE，而仓库不能 import 本模块，
# 所以形状与 `settle_fields` 一样：**服务层算好，仓库照着写**。

class MaterializeStats:
    """物化结果（判据用：第二次读不许再写）。"""

    def __init__(self) -> None:
        self.scanned = 0          # 扫过的行
        self.written = 0          # 真写了的行（值变了才算）
        self.representatives = 0  # 其中被标成代表行的
        self.cleared = 0          # 其中被清成"非代表行"的

    def __repr__(self) -> str:  # pragma: no cover - 只为日志可读
        return (f"MaterializeStats(scanned={self.scanned}, written={self.written}, "
                f"representatives={self.representatives}, cleared={self.cleared})")


__all__ = [
    "GroupState", "MaterializeStats", "apply_to_row", "for_group", "group_states",
    "normalize_stored_category", "settle", "settle_danmakus_item", "settle_fields",
]
