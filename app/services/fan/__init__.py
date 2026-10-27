"""粉丝结构分析 · 模型层。

对外只暴露**数据读取**与**计算**能力。本包**不写任何文件**。

模块边界（对应 `docs/analysis-model/README.md` 的阶段）：

| 模块 | 阶段 | 职责 |
|---|---|---|
| `loader` | P0 | 只读加载 JSON 事实表 → `Window` |
| `axes` | P1 | 三轴 + 经验分位变换 → `AxisTable` |
| `compose` | P1 | 参与强度 / 类型标注 / 效标加权 / 次序键 |
| `checks` | P2 | C1–C4 完整性判据（未实现） |
| `tags` | P3 | 展示标签（不进合成，未实现） |
| `cross_v` | P4 | 跨 V 对照 + 超几何零模型（未实现） |

⚠️ **本包不提供 `score()` 这类一揽子函数**：规格 §4.1 已论证"单分数会被读成价值判断"，
所以 `compose` 把三个输出拆成三个函数，API 层面也不给被误用的机会。
"""

from __future__ import annotations

from app.services.fan.axes import (
    AXES,
    AXIS_ATTENDANCE,
    AXIS_INTERACTION,
    AXIS_PAYMENT,
    INCLUSION_FLOOR,
    AxisError,
    AxisTable,
    build_axis_table,
    empirical_percentile,
)
from app.services.fan.compose import (
    PURITY_THRESHOLD,
    TYPE_LABELS,
    TYPE_MIXED,
    ComposeError,
    CriterionFit,
    DegenerateOutcome,
    fit_criterion_weights,
    participation_strength,
    rank,
    type_label,
    value_under_criterion,
)
from app.services.fan.criterion import (
    CRITERIA,
    CRITERION_DESC,
    CRITERION_INCOME,
    CRITERION_RETENTION,
    FittedCriterion,
)
from app.services.fan.loader import (
    DEV_SUBDIRS,
    LEGACY_VTUBERS,
    VTUBERS,
    FanDataError,
    FanDataNotFound,
    SessionRef,
    UserFact,
    VtuberRef,
    Window,
    ensure_data_dir,
    get_vtuber,
    list_vtubers,
    load_all,
    load_window,
    resolve_data_dir,
    subdir_for,
    summary,
)
from app.services.fan.tags import (
    TagContext,
    explain as explain_tags,
    prevalence,
    tag_all,
    tags_for,
)

__all__ = [
    # loader (P0)
    "VTUBERS",
    "LEGACY_VTUBERS",
    "DEV_SUBDIRS",
    "list_vtubers",
    "subdir_for",
    "ensure_data_dir",
    "FanDataError",
    "FanDataNotFound",
    "SessionRef",
    "UserFact",
    "VtuberRef",
    "Window",
    "get_vtuber",
    "load_all",
    "load_window",
    "resolve_data_dir",
    "summary",
    # axes (P1)
    "AXES",
    "AXIS_ATTENDANCE",
    "AXIS_INTERACTION",
    "AXIS_PAYMENT",
    "INCLUSION_FLOOR",
    "AxisError",
    "AxisTable",
    "build_axis_table",
    "empirical_percentile",
    # compose (P1)
    "PURITY_THRESHOLD",
    "TYPE_LABELS",
    "TYPE_MIXED",
    "ComposeError",
    "CriterionFit",
    "DegenerateOutcome",
    "fit_criterion_weights",
    "participation_strength",
    "rank",
    "type_label",
    "value_under_criterion",
]
