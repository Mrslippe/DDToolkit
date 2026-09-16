"""运行时设置覆盖层（R14a，devlog/091）。

用户需求 R14：「最左侧工具栏底端给一个齿轮按钮，点开进入设置的独立弹窗，可以设置各种参数，
例如主题、后端、抓取频率等等」。本模块解决**抓取参数**这一半：它们在
`app/services/scheduler.py` 里全部是"每一轮/每个账号开始时读一次"，所以覆盖层改完
**下一轮就生效、不重启**。

四条边界（都有测试钉住）：

1. **真源在这里**：`SPECS` 同时是"默认值 / 类型 / 范围 / 界面文案 / 生效时机"的唯一来源，
   `config.py` 里对应的键是 property，读的就是本模块。这样不会出现"界面写 1~10、
   代码其实允许 0"的两份口径。
2. **只收「每轮读取」的键**。启动期读取的一律不进 SPECS（数据目录、端口、CORS、
   日志、迁移 head、APScheduler 的 cron 注册项…）—— 它们改了也要重启，
   放进"可保存"的界面就是骗人。只读分区把这类**如实列出来**（`READONLY_NOTES`）。
3. **落库复用 `app_meta`**（键前缀 `settings.`），不新建表：它就是为"进程外需要记住的
   少量状态"建的 KV（v0.9.8，devlog/…-P9-4），而且**不在 purge 清单里** ——
   应用级配置不该随某个 V 被删除而消失。
   （方案里原写"新增 `app_settings` 表"；核实后判断：与 `app_meta` 同构的新表只是多一处
   漂移面 + 多一次迁移 + 多一次 `MIGRATION_HEAD` 变更，收益是零，故改为此方案。）
4. **键名与 `Settings` 属性名一致**，且**双向契约有测试**：SPECS 里每个键都能在
   `Settings` 上读到属性、`Settings` 上每个热点 property 也都在 SPECS 里 ——
   少一边就是"界面存了但代码看不见"或"代码能改但界面没有"。

线程模型：调度器在自己的线程里读，API 在线程池里写。读写都只碰
`_overrides` 这一份**整体替换**的 dict（赋值是原子操作），读者永远看到自洽的快照。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)
# app_meta 键前缀：同一张 KV 表里还有 `external.startup.last_run` 等别的命名空间
PREFIX = "settings."


# 左栏导航的两个大类（R21，devlog/100）：原先 4 个中间分类（抓取节奏 / 动态流与轮询 /
# 收录首屏 / 第三方数据）**按"用户想干什么"合并**成 2 个 —— 用户口径（2026-09-16）：
# 「可选项太多、设置很杂，没有专业背景的用户不知道每一项意味着什么」。
# 界面**不写死**这两个名字：导航仍由 `spec_table()` 里 group 出现的顺序生成。
NAV_FETCH = "抓取设置"
NAV_SOURCES = "数据源"


@dataclass(frozen=True)
class Spec:
    """一个可热更的键。`label/unit/effect` 是给界面用的（后端下发，界面不再抄一份）。

    **两级分组**（R21 起）：
    - `group`：左栏导航分类（只看"大类"：抓取设置 / 数据源）；
    - `section`：页内小组标题（例如「开播信息抓取」）——按**用途**分，而不是按代码里的模块分；
       一个页只有一组时不渲染标题（页标题已经说明白了）。
    - `advanced`：非关键项 → 收进页尾「高级（默认收起）」。判据是"普通用户需不需要动它"，
      不是"实现上重不重要"；**成对的上下限必须同进同出**（不然"上限<下限"的校验会消失）。
    """

    key: str
    kind: str                      # "int" | "float" | "bool"
    default: Any
    lo: float | None = None        # 闭区间下界（None = 不限）
    hi: float | None = None
    label: str = ""
    unit: str = ""
    group: str = ""
    effect: str = "下一轮生效（不用重启）"
    note: str = ""                 # 额外说明（例如 0 = 关闭）
    section: str = ""              # 页内小组标题；"" = 不分组
    advanced: bool = False         # 收进「高级（默认收起）」


def _specs() -> list[Spec]:
    hot = "下一轮生效（不用重启）"
    idle = "下一个空闲轮次生效（不会打断正在跑的任务）"
    g, s = NAV_FETCH, "风控与节流"
    return [
        # ══ 抓取设置 · 风控与节流 ══════════════════════════════════════
        # 这三项是"普通用户唯一真正需要调的"：抓多快、被风控了歇多久。
        Spec("REQUEST_INTERVAL_MIN", "float", 3.0, 0.5, 10.0,
             "每个账号的间隔（最小）", "秒", g, hot,
             "抓完一个账号随机等一会儿再抓下一个，这是下限；调小会更快，但更容易被风控",
             section=s),
        Spec("REQUEST_INTERVAL_MAX", "float", 5.0, 0.5, 30.0,
             "每个账号的间隔（最大）", "秒", g, hot,
             "间隔在这个区间里随机取；与下限相等就是固定间隔",
             section=s),
        Spec("RATE_LIMIT_COOLDOWN", "int", 600, 60, 3600,
             "被风控后冷却", "秒", g, idle,
             "被 B 站限流（-412/-509 等）后暂停抓取的时长；顶栏状态岛会显示剩余时间",
             section=s),
        # ── 高级：批次节流（参数本身有用，但属于"调优"，普通用户不必看）──
        Spec("FETCH_BATCH_SIZE", "int", 10, 1, 100,
             "每批账号数", "个账号", g, hot,
             "每处理 N 个账号算一批，批与批之间休息一次",
             section=s, advanced=True),
        Spec("FETCH_BATCH_COOLDOWN", "int", 60, 0, 600,
             "每批之间的休息", "秒", g, hot,
             "一批抓完后的休息时长；0 = 不休息（只留账号间隔）",
             section=s, advanced=True),

        # ══ 抓取设置 · 开播信息抓取 ════════════════════════════════════
        Spec("LIVE_POLL_SECONDS", "float", 60.0, 0.0, 3600.0,
             "开播状态刷新间隔", "秒", g, hot,
             "多久查一次谁在直播（左栏的直播徽标）；0 = 不自动刷新",
             section="开播信息抓取"),

        # ══ 抓取设置 · 定期动态轮询 ════════════════════════════════════
        Spec("DYNAMICS_MIN_CYCLE_SECONDS", "float", 60.0, 10.0, 900.0,
             "动态更新最快间隔", "秒", g, hot,
             # ⚠️ 界面按**纯文本**渲染这些字段（label/unit/effect/note/section）——
             #    别写 `**粗体**` 或反引号，那会把标记本身显示给用户
             #    （2026-09-15 用户截图反馈）。有一条用例专门扫这件事。
             "即便一轮很快就跑完，也要等满这么久再开始下一轮（这是最密的情况）",
             section="定期动态轮询"),
        Spec("DYNAMICS_BUDGET_RPM", "int", 12, 0, 60,
             "动态请求预算", "次/分钟", g, hot,
             "自动节奏的兜底上限；0 = 关掉自动节奏、退回固定周期",
             section="定期动态轮询", advanced=True),
        Spec("DYNAMICS_MIN_GAP_SECONDS", "float", 30.0, 0.0, 600.0,
             "两轮之间至少间隔", "秒", g, hot,
             "不贴着预算跑满，留一点拟人余量（调小会更密）",
             section="定期动态轮询", advanced=True),

        # ══ 抓取设置 · 每日定时任务 ════════════════════════════════════
        Spec("ACCOUNT_SWEEP_STALE_HOURS", "float", 24.0, 1.0, 720.0,
             "账号信息刷新周期", "小时", g, hot,
             "粉丝数、头像、签名这些信息多久重抓一次（超过这个时长就排队刷新）",
             section="每日定时任务"),
        Spec("ACCOUNT_SWEEP_MIN_GAP_SECONDS", "int", 600, 60, 86400,
             "两次刷新的硬性间隔", "秒", g, hot,
             "同一进程里两次账号信息刷新之间至少隔这么久（防止失败重试风暴）",
             section="每日定时任务", advanced=True),

        # ══ 抓取设置 · 收录首屏 ════════════════════════════════════════
        Spec("FIRST_SCREEN_VIDEO_PAGES", "int", 1, 1, 5,
             "收录时抓取的投稿页数", "页", g, hot,
             "添加一个新 V 时先抓几页投稿（每页约 30 条，含封面/时长/统计）",
             section="收录首屏"),
        Spec("FIRST_SCREEN_DYNAMICS_LIMIT", "int", 3, 1, 20,
             "收录时入库的动态条数", "条", g, hot,
             "首屏最多入库几条新动态（每条会多一次详情请求）",
             section="收录首屏"),
        Spec("FIRST_SCREEN_DYNAMICS_PAGES", "int", 1, 1, 5,
             "收录时抓取的动态页数", "页", g, hot,
             "添加一个新 V 时先抓几页动态",
             section="收录首屏", advanced=True),
        Spec("MANUAL_FAST_INTERVAL_MIN", "float", 0.5, 0.1, 5.0,
             "收录时的账号间隔（最小）", "秒", g, hot,
             "手动收录走更快的链路（为了几秒内出结果），这是它的下限",
             section="收录首屏", advanced=True),
        Spec("MANUAL_FAST_INTERVAL_MAX", "float", 1.0, 0.1, 10.0,
             "收录时的账号间隔（最大）", "秒", g, hot,
             "同上，必须是这个区间的上限；与下限相等就是固定间隔",
             section="收录首屏", advanced=True),

        # ══ 数据源 ════════════════════════════════════════════════════
        # 这三个是**真热更**：`externals/runner.py::_source_enabled` 每次运行都查一遍，
        # 所以关掉之后连"已经注册好的 cron 空跑"都不会有副作用（`EXTERNAL_RUN_HOUR`
        # 那个 cron 时刻则不同 —— 它只在启动时注册，归只读）。
        Spec("EXTERNAL_ENABLED", "bool", True, None, None,
             "第三方数据同步", "", NAV_SOURCES, hot,
             "关闭后第三方采集一律跳过（zeroroku 日历 / danmakus 弹幕索引 / 粉丝历史）",
             section=NAV_SOURCES),
        Spec("EXTERNAL_ZEROROKU_ENABLED", "bool", True, None, None,
             "启用 zeroroku", "", NAV_SOURCES, hot,
             "直播日历与粉丝趋势的上游之一",
             section=NAV_SOURCES),
        Spec("EXTERNAL_DANMAKUS_ENABLED", "bool", True, None, None,
             "启用 danmakus", "", NAV_SOURCES, hot,
             "弹幕索引上游（收录检索与词云自建会用到）",
             section=NAV_SOURCES),
    ]


SPECS: dict[str, Spec] = {s.key: s for s in _specs()}

# 跨字段约束：`(被约束的键, 依赖的键, 说明)` —— 单边校验管不住"上限 < 下限"
PAIRS: list[tuple[str, str, str]] = [
    ("REQUEST_INTERVAL_MAX", "REQUEST_INTERVAL_MIN", "账号间隔上限不能小于下限"),
    ("MANUAL_FAST_INTERVAL_MAX", "MANUAL_FAST_INTERVAL_MIN", "收录间隔上限不能小于下限"),
]

# ── 只读项：**故意不给改**，但要在界面上如实说明为什么 ────────────────
# 这份表是"界面文案"而不是逻辑，但与 SPECS 一样属于边界声明，故与 SPECS 同处一个模块：
# 谁把某个键挪进 SPECS，就该同时从这份表里删掉（有一条测试对账"两边不许重复"）。
READONLY_NOTES: list[dict[str, str]] = [
    {"key": "DATA_DIR", "label": "数据目录",
     "why": "数据库/凭据/缓存都在这里，运行中改它等于半路换库"},
    {"key": "端口", "label": "后端端口",
     "why": "由启动器抢占空闲端口后注入，改了要重启进程"},
    {"key": "DATABASE_URL", "label": "数据库",
     "why": "同上：运行中换库会撕裂正在跑的任务"},
    {"key": "CORS_ORIGINS", "label": "跨域来源",
     "why": "中间件在应用构建期读取，改了要重启"},
    {"key": "LOG_LEVEL / LOG_BACKUP_DAYS", "label": "日志级别与保留天数",
     "why": "日志器在启动时配置（按天轮转）"},
    {"key": "MIGRATION_HEAD", "label": "迁移版本",
     "why": "库结构决定，不能由界面改"},
    {"key": "TIER_TICK_SECONDS", "label": "分层调度心跳",
     "why": "调度线程的呼吸节奏，改动会牵动所有到期判定"},
    {"key": "EXTERNAL_RUN_HOUR", "label": "第三方数据执行时刻",
     "why": "APScheduler 的 cron 在启动时按它注册，改时刻要重启才生效"},
    {"key": "DYNAMICS_LATEST_INTERVAL_MINUTES", "label": "动态流固定周期",
     "why": "仅在关闭「每分钟请求预算」（设为 0）时才有意义，当前走自适应"},
    {"key": "STARTUP_* / PRIMARY_PLATFORM_ORDER", "label": "启动链与平台优先级",
     "why": "只在启动链那一次读取"},
]

# 当前覆盖（只放"被改过的"键；没改过的读 Spec.default）
_overrides: dict[str, Any] = {}


# ── 读取 ─────────────────────────────────────────────────────────────

def spec(key: str) -> Spec:
    return SPECS[key]


def is_hot(key: str) -> bool:
    return key in SPECS


def default_of(key: str) -> Any:
    return SPECS[key].default


def get(key: str) -> Any:
    """当前生效值（覆盖 → 默认）。`config.py` 的热点 property 走这里。"""
    if key in _overrides:
        return _overrides[key]
    return SPECS[key].default


def snapshot() -> dict[str, Any]:
    return {k: get(k) for k in SPECS}


def overrides() -> dict[str, Any]:
    """只返回被覆盖过的键（界面用它显示"已改过"标记）"""
    return dict(_overrides)


# ── 校验 ─────────────────────────────────────────────────────────────

def coerce(key: str, raw: Any) -> Any:
    """把界面/接口来的值转成该键的类型，并做单字段范围校验。不合规抛 ValueError（中文原因）。"""
    s = SPECS[key]
    if s.kind == "bool":
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, (int, float)) and raw in (0, 1):
            return bool(raw)
        if isinstance(raw, str) and raw.strip().lower() in ("1", "true", "yes", "on", "是"):
            return True
        if isinstance(raw, str) and raw.strip().lower() in ("0", "false", "no", "off", "否"):
            return False
        raise ValueError(f"{s.label}：需要 true/false，实得 {raw!r}")
    if isinstance(raw, bool) or raw is None or raw == "":
        raise ValueError(f"{s.label}：需要一个{'整数' if s.kind == 'int' else '数字'}，实得 {raw!r}")
    try:
        v = int(raw) if s.kind == "int" else float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{s.label}：需要一个{'整数' if s.kind == 'int' else '数字'}，实得 {raw!r}")
    if s.kind == "int" and isinstance(raw, float) and not float(raw).is_integer():
        raise ValueError(f"{s.label}：需要整数，实得 {raw!r}")
    if s.lo is not None and v < s.lo:
        raise ValueError(f"{s.label}：不能小于 {_fmt(s.lo)}{s.unit}（实得 {v}）")
    if s.hi is not None and v > s.hi:
        raise ValueError(f"{s.label}：不能大于 {_fmt(s.hi)}{s.unit}（实得 {v}）")
    return v


def _fmt(x: Any) -> str:
    return f"{x:g}" if isinstance(x, float) else str(x)


def validate(candidate: dict[str, Any]) -> None:
    """在"合并后的最终值"上校验跨字段约束（单字段范围已在 coerce 里管过）。"""
    for a, b, why in PAIRS:
        va, vb = candidate.get(a), candidate.get(b)
        if va is None or vb is None:
            continue
        if float(va) < float(vb):
            raise ValueError(f"{why}（{SPECS[a].label} {_fmt(va)} < {SPECS[b].label} {_fmt(vb)}）")


def plan(updates: dict[str, Any]) -> dict[str, Any]:
    """校验一组改动，返回**合并后的最终值**（不落库、不改内存）。

    `None` / 空字符串表示"删掉覆盖、回默认"。
    越界/类型错/跨字段冲突 → ValueError；未知键 → KeyError。
    """
    unknown = [k for k in updates if k not in SPECS]
    if unknown:
        raise KeyError(f"不认识的设置项：{', '.join(sorted(unknown))}")
    merged = snapshot()
    for key, raw in updates.items():
        if raw is None or raw == "":
            merged[key] = SPECS[key].default
        else:
            merged[key] = coerce(key, raw)
    validate(merged)
    return merged


# ── 写入 ─────────────────────────────────────────────────────────────

def apply(updates: dict[str, Any], db=None) -> dict[str, Any]:
    """校验 → 落库（`app_meta`）→ 换内存快照。返回"最终生效值"。

    落库失败必须**整体放弃**：先算好 `merged`、写库成功后才替换内存 ——
    否则会出现"界面显示改了、重启后又变回去"的静默不一致。
    """
    merged = plan(updates)
    if db is not None:
        from app.repositories.vtuber_repo import AppMetaRepo
        repo = AppMetaRepo(db)
        for key, raw in updates.items():
            if raw is None or raw == "":
                repo.delete(PREFIX + key)
            else:
                repo.set(PREFIX + key, _dump(merged[key]))
    global _overrides
    _overrides = {k: merged[k] for k in SPECS if merged[k] != SPECS[k].default}
    logger.info("运行时设置已更新：%s", ", ".join(f"{k}={merged[k]}" for k in updates) or "（无）")
    return merged


def _dump(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    return repr(v) if isinstance(v, float) else str(v)


def load(db=None) -> dict[str, Any]:
    """从 `app_meta` 载入覆盖（启动时调一次；测试里也可显式调）。

    容错口径：**单条读坏不能带走整个进程** —— 未知键（老版本写的）、类型/范围不合规的值
    都跳过并记 warning，其余照常生效。返回 {键: 生效值}。
    """
    from app.repositories.vtuber_repo import AppMetaRepo
    own = db is None
    if own:
        from app.core.database import SessionLocal
        db = SessionLocal()
    try:
        rows = AppMetaRepo(db).all_with_prefix(PREFIX)
    finally:
        if own:
            db.close()
    loaded: dict[str, Any] = {}
    for key, raw in rows.items():
        s = SPECS.get(key)
        if s is None:
            logger.warning("运行时设置：忽略不认识的键 %s（可能来自更新的版本）", key)
            continue
        try:
            loaded[key] = coerce(key, raw)
        except ValueError as e:
            logger.warning("运行时设置：%s 的值 %r 不合规，按默认值处理（%s）", key, raw, e)
    global _overrides
    _overrides = loaded
    if loaded:
        logger.info("运行时设置覆盖已载入：%s",
                    ", ".join(f"{k}={v}" for k, v in sorted(loaded.items())))
    return snapshot()


def clear() -> None:
    """清空内存覆盖（测试用；运行时不该调 —— 清内存不等于清库）。"""
    global _overrides
    _overrides = {}


def spec_table() -> list[dict[str, Any]]:
    """给界面用的规格表（分组顺序稳定：按 `_specs()` 的声明顺序）。

    `section` / `advanced` 一并下发（R21）：界面据此渲染页内小组标题与「高级（默认收起）」。
    界面**不再自己维护一份分组表** —— 后端加一个键、给上 section，界面自动出现在该组下。
    """
    out: list[dict[str, Any]] = []
    for s in _specs():
        out.append({
            "key": s.key, "kind": s.kind, "default": s.default,
            "min": s.lo, "max": s.hi,
            "label": s.label, "unit": s.unit, "group": s.group,
            "section": s.section, "advanced": s.advanced,
            "effect": s.effect, "note": s.note,
            "value": get(s.key),
            "changed": s.key in _overrides,
        })
    return out


def readonly_info() -> list[dict[str, str]]:
    return [dict(x) for x in READONLY_NOTES]


# 供测试/诊断：字段名清单（避免各调用点自己拼）
HOT_KEYS: list[str] = list(SPECS)
