"""粉丝结构分析 · 数据层（**只读**）。

把 `_probe/` 探针产出的 JSON 事实表读成内存结构，供上层模块计算三轴与三个输出。

## 为什么是只读

事实表是**上游快照**：同一场次的记录集合会变（实测 `total` 从 21,826 变 12,306），
一旦覆盖就再也拿不回来。本模块**不写任何文件**，也不提供写接口。

## 数据根（三级解析）

1. 环境变量 `DDTOOLKIT_FAN_DATA_DIR`
2. `<settings.DATA_DIR>/fan-structure`（生产）
3. `<settings.DATA_DIR>/datasets/fan-structure`（开发：数据在仓库里）

取第一个存在的。都不存在 → `FanDataNotFound`（这是**配置错误**，不是数据缺失，故抛异常）。

## 目录约定

```
<root>/<subdir>/stats/<live_id>.json   场次级元数据 + 完整性判据的输入
<root>/<subdir>/raw/<live_id>.json     逐人事实表 {uid: {...}}
<root>/<subdir>/names/<live_id>.json   {uid: 昵称}（本模块不读，界面用）
<root>/curves/<live_id>.json           逐分钟曲线
<root>/ranked/<subdir>.json            三个输出的产物
```

## 容错策略

`raw/*.json` 是**非 schema 化**的自由格式（探针演进过 3 版，v1→v3 字段有增删）。
⇒ 本模块**逐字段容错**：缺失按 0 / 空处理并记一条 `warning`，**不抛异常**。
理由：一次缺字段不该让整个窗口失败，而且我们需要看见它们（warning 会汇总上报）。

真正致命的是 `stats/*.json` 解析失败 —— 它决定场次是否入选，无法猜测，故跳过该场次并记 warning。
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence, Callable, Iterable

from app.services.fan.spam import is_spam, is_spam_across_sessions, level_for
from app.services.fan.spam2 import Trace, feed, verdict
from app.core.timecn import cn_day
from app.core import config as _core_config
from app.core.config import settings

logger = logging.getLogger(__name__)

# ── 具名常量（施工计划 A2：参数不散在函数里）────────────────────────────────
DATA_DIR_ENV = "DDTOOLKIT_FAN_DATA_DIR"
PROD_SUBDIR = "fan-structure"          # <DATA_DIR>/fan-structure
DEV_SUBDIR = ("datasets", "fan-structure")   # <DATA_DIR>/datasets/fan-structure
#: 记录数低于此值的场次视为坏样本（规格 §2.4：唯一弃用判据）
MIN_RECORDS = 100
#: 入场事件的 type 值
ENTRY_TYPE = "4"


class FanDataError(Exception):
    """数据层异常基类。"""


class FanDataNotFound(FanDataError):
    """数据根不存在 —— 配置错误，不是数据缺失。"""


@dataclass(frozen=True)
class VtuberRef:
    """一个主播在数据层里的标识。"""

    name: str      # 显示名，如「弥月Mizuki」
    subdir: str    # 数据子目录，如 pilot_v3_mizuki
    mid: str       # B 站 mid（外部源对齐用）
    short: str     # 简称，如「弥月」


#: **开发样本 V** 的 mid → 数据子目录。它们的数据是当初用 `_probe` 采的，
#: 沿用旧目录名才能继续读；其余主播一律按 `bili-<mid>` 建目录。
DEV_SUBDIRS: dict[str, str] = {
    "1789460279": "pilot_v3_mizuki",
    "2132180406": "pilot_v3_mingqian",
    "401315430": "pilot_v3_xingtong",
}

#: 开发样本（**不是**生产的主播清单）。生产的主播清单来自库，见 `list_vtubers`。
LEGACY_VTUBERS: tuple[VtuberRef, ...] = (
    VtuberRef("弥月Mizuki", "pilot_v3_mizuki", "1789460279", "弥月"),
    VtuberRef("明前奶绿", "pilot_v3_mingqian", "2132180406", "明前奶绿"),
    VtuberRef("星瞳_Official", "pilot_v3_xingtong", "401315430", "星瞳"),
)

#: 向后兼容的别名：老代码/探针按 `VTUBERS` 取那三个样本。
VTUBERS = LEGACY_VTUBERS


def subdir_for(mid: str) -> str:
    """mid → 数据子目录名。开发样本沿用 `pilot_v3_*`，其余按 `bili-<mid>`。"""
    return DEV_SUBDIRS.get(str(mid)) or f"bili-{mid}"


def _db_vtubers(db: object) -> list[VtuberRef]:
    """从库里取**有 B 站账号**的主播。没有库 / 查询失败一律返回空（不抛）。"""
    try:
        from sqlalchemy import select

        from app.models.vtuber import Account, VTuber

        # ⚠️ **按 V 去重，只留主账号**（2026-10-18 用户：恬豆发芽了有两个 B 站账号，
        # 下拉里就出现两项）。"主账号"取粉丝数最多的那个；同粉丝数按 id 稳定。
        rows = db.execute(  # type: ignore[attr-defined]
            select(VTuber.id, VTuber.name, Account.platform_uid)
            .join(Account, Account.vtuber_id == VTuber.id)
            .where(Account.platform == "bilibili")
            .order_by(VTuber.id, Account.followers_count.desc(), Account.id)
        ).all()
    except Exception:  # noqa: BLE001 —— 没库/表不存在都按"没有"处理
        return []

    out: list[VtuberRef] = []
    seen: set[str] = set()
    seen_v: set[int] = set()      # 一个 V 只出一条（主账号）
    for vid, name, uid in rows:
        mid = str(uid or "")
        if not mid or int(vid) in seen_v or mid in seen:
            continue
        seen_v.add(int(vid))
        seen.add(mid)
        out.append(VtuberRef(str(name), subdir_for(mid), mid, str(name)))
    return out


def list_vtubers(db: object | None = None, *, root: Path | None = None) -> list[VtuberRef]:
    """可分析的主播清单。

    **生产**：库里有 B 站账号的主播（数据目录按 mid 生成）。
    **开发/空库**：补上那三个样本 —— 但**只补数据目录真的存在的那些**，
    免得界面上出现一堆点进去没数据的条目。
    """
    out = _db_vtubers(db) if db is not None else []
    have = {v.mid for v in out}
    try:
        base = root or resolve_data_dir(create=False)
    except FanDataNotFound:
        base = None
    for v in LEGACY_VTUBERS:
        if v.mid in have:
            continue
        if base is not None and (base / v.subdir / "stats").is_dir():
            out.append(v)
    return out


def get_vtuber(name_or_short: str, db: object | None = None) -> VtuberRef:
    """按显示名 / 简称 / mid / 子目录名取 V；不区分大小写。

    `db` 给了就在动态清单里找，否则只看开发样本（探针与老用例走这条）。
    """
    key = name_or_short.strip().lower()
    pool = list_vtubers(db) if db is not None else list(LEGACY_VTUBERS)
    # ⚠️ **两层清单必须都查**（2026-10-19 用户报「未知的主播：星瞳_official」）：
    # 同一个主播在不同来源里名字可能不同 —— dev 库叫 `星瞳official`（无下划线），
    # 数据目录/旧样本叫 `星瞳_Official`（有下划线）。`/fan/vtubers` 是把两边**合并**
    # 展示的，于是前端可能拿到只存在于旧样本里的那个名字；这里若只在库里找就必然扑空。
    for candidate in (pool, list(LEGACY_VTUBERS)):
        for v in candidate:
            if key in (v.name.lower(), v.short.lower(), v.subdir.lower(), v.mid):
                return v
    raise FanDataError(
        f"未知的主播：{name_or_short!r}；可用：{[v.name for v in pool] or '（库里还没有带 B 站账号的主播）'}"
    )


def resolve_data_dir(*, create: bool = False) -> Path:
    """解析数据根。`create=True` 时**按需创建**生产位置（采集用）。

    顺序：`DDTOOLKIT_FAN_DATA_DIR` → `<DATA_DIR>/fan-structure`（生产）
    → `<DATA_DIR>/datasets/fan-structure`（开发检出）。

    ⚠️ `create=True` **不会**在开发检出里创建 `<DATA_DIR>/fan-structure`
    —— 那时 `DATA_DIR == PROJECT_ROOT`，创建会往仓库里扔数据。此时仍走开发路径或报错。
    """
    env = os.getenv(DATA_DIR_ENV)
    if env:
        p = Path(env)
        if create:
            p.mkdir(parents=True, exist_ok=True)
            return p
        if not p.is_dir():
            raise FanDataNotFound(f"{DATA_DIR_ENV} 指向的目录不存在：{p}")
        return p

    base = Path(settings.DATA_DIR)
    prod = base / PROD_SUBDIR
    dev = base.joinpath(*DEV_SUBDIR)
    if dev.is_dir():
        return dev
    if prod.is_dir():
        return prod
    # `PROJECT_ROOT` 是 config 的**模块级常量**（不在 `Settings` 上）；
    # 但用例会拿替身塞一个 `settings.PROJECT_ROOT`，所以两边都认。
    project_root = getattr(settings, "PROJECT_ROOT", None) or _core_config.PROJECT_ROOT
    if create and base.resolve() != Path(project_root).resolve():
        prod.mkdir(parents=True, exist_ok=True)
        return prod
    raise FanDataNotFound(
        f"找不到粉丝结构数据根。已试：{prod}、{dev}；可用 {DATA_DIR_ENV} 显式指定。"
    )


def ensure_data_dir() -> Path:
    """采集前调用：保证数据根存在（生产按需创建）。"""
    return resolve_data_dir(create=True)


# ── 事实结构 ────────────────────────────────────────────────────────────────
@dataclass
class UserFact:
    """一个观众在一个窗口内的聚合事实。字段与 `raw/*.json` 的每用户对象一一对应。"""

    uid: str
    att_n: int = 0          # 出席场次数
    m: int = 0              # 弹幕总条数（type=0）—— **原始条数，永不删除**
    #: 去重后的不同弹幕文本条数（2026-10-20 起采集；老数据无此字段 ⇒ 保持 0）
    uniq: int = 0
    #: 单条文本的最大重复次数（同上）
    maxrep: int = 0
    #: 是否至少有一场带文本指纹。False = **未跟踪**，不代表"没有重复"
    text_tracked: bool = False
    #: 昵称（展示用；老数据为空串）
    name: str = ""
    #: 付费拆解（2026-10-24）：礼物 / 舰长类 / SC 的金额，以及付费笔数
    gift_amt: float = 0.0
    guard_amt: float = 0.0
    sc_amt: float = 0.0
    pay_events: int = 0
    #: 首次出场时滞的累计（分钟，相对本场最早事件）与场次数 —— 均值用于出勤轴的档内排序
    lag_sum: float = 0.0
    lag_cnt: int = 0

    @property
    def mean_lag(self) -> float | None:
        """平均首次出场时滞（分钟）。没有时间戳的场次不计入；从未有过则 None。"""
        return (self.lag_sum / self.lag_cnt) if self.lag_cnt else None
    sc_cnt: int = 0         # SC 总条数（type=3）
    gift_cnt: int = 0       # 礼物笔数（type=1）
    guard_cnt: int = 0      # 上舰次数（type=2）
    guard_top: str | None = None   # 最高舰队等级名
    pay: float = 0.0        # 累计付费金额
    msg_sess: int = 0       # 发过弹幕的场次数
    sc_sess: int = 0        # 打过 SC 的场次数
    first_pos: float = 1.0  # 首次出现的相对位置（0=窗口起点，1=终点）
    last_pos: float = 0.0   # 末次出现的相对位置


@dataclass
class SessionRef:
    """一个场次的元数据（stats 原文 + 从 raw 现算的聚合量 + 入选判定）。

    `sum_*` / `n_pairs` 是**从 raw 现算**的，`stats` 里的是**上游给的** ——
    `checks.check_identity()` 就是拿这两组对撞（C1）。所以两者都要留。
    """

    live_id: str
    start_at: str
    end_at: str
    n_users: int
    stats: dict[str, Any] = field(default_factory=dict)
    #: 从 raw 现算：弹幕条数 / SC 条数 / 付费金额 / (人,场) 对数
    sum_m: int = 0
    sum_sc: int = 0
    sum_pay: float = 0.0
    n_pairs: int = 0

    @property
    def type_hist(self) -> dict[str, int]:
        return dict(self.stats.get("type_hist") or {})

    @property
    def records(self) -> int:
        return int(self.stats.get("records") or 0)

    @property
    def upstream_type0(self) -> int:
        """上游 `type_hist["0"]` —— 与 `sum_m` 对撞（C1）。"""
        return int(self.type_hist.get("0", 0))

    @property
    def upstream_sum_price(self) -> float:
        return float(self.stats.get("sum_price") or 0.0)

    @property
    def has_entry_events(self) -> bool:
        """该场是否采集到入场事件（决定能否计入出勤分母，规格 §3.3）。"""
        return int(self.type_hist.get(ENTRY_TYPE, 0)) > 0


@dataclass
class Window:
    """一个 (主播, 窗口) 的加载结果。"""

    vtuber: VtuberRef
    requested_n: int
    sessions: list[SessionRef]
    users: dict[str, UserFact]
    warnings: list[str] = field(default_factory=list)
    #: uid → 独轮车规则（`sustained` / `window` / `cross_session`）；空 = 不是
    spam: dict[str, str] = field(default_factory=dict)
    #: uid → 独轮车**分档**（none/suspected/confirmed，2026-10-25）
    spam_levels: dict[str, str] = field(default_factory=dict)
    #: uid → 逐场切片 [(live_id, start_at, m, p, e, uniq)]（2026-10-24）
    #: 在读取 raw 的**同一遍**里顺手产出，供成员详情 O(1) 查询，避免二次扫描。
    slices: dict[str, list[tuple]] = field(default_factory=dict)

    @property
    def n(self) -> int:
        """**在册场次数** —— 出勤率的分母（缺失 ≠ 零，只数有入场事件的场次）。"""
        return len(self.sessions)

    @property
    def all_sessions(self) -> list[SessionRef]:
        return list(self.sessions)

    def dropped_or_unusable(self) -> list[str]:
        return [w for w in self.warnings if "跳过" in w]


# ── 读取 ────────────────────────────────────────────────────────────────────
def _read_json(path: Path, warnings: list[str], what: str) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        warnings.append(f"{what} 缺文件：{path.name}")
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        warnings.append(f"{what} 解析失败（{type(exc).__name__}）：{path.name}")
    return None


def _iso_to_ts(iso: str) -> float | None:
    """`YYYY-MM-DD HH:MM:SS[.ffffff]`（**UTC**）→ epoch 秒。解析失败返回 None。"""
    if not iso:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(iso, fmt).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
    return None


def _first_lag_minutes(a: dict, start_ts: float | None) -> float | None:
    """该用户在本场的"首次出场时滞"（分钟）：最早事件 − 本场开播。"""
    if start_ts is None:
        return None
    ts: list[int] = []
    for key in ("et", "mt", "pt"):
        lst = a.get(key)
        if isinstance(lst, list):
            ts.extend(x for x in lst if isinstance(x, (int, float)))
    if not ts:
        return None
    return max(0.0, (min(ts) / 1000 - start_ts) / 60)


def _as_int(raw: dict, key: str, warnings: list[str], where: str) -> int:
    v = raw.get(key)
    if v is None:
        return 0
    if not isinstance(v, (int, float)):
        warnings.append(f"{where} 字段 {key} 类型异常（{type(v).__name__}），按 0 处理")
        return 0
    return int(v)


def _as_float(raw: dict, key: str, warnings: list[str], where: str) -> float:
    v = raw.get(key)
    if v is None:
        return 0.0
    if not isinstance(v, (int, float)):
        warnings.append(f"{where} 字段 {key} 类型异常（{type(v).__name__}），按 0 处理")
        return 0.0
    return float(v)


_GUARD_RANK = {"舰长": 1, "提督": 2, "总督": 3}


def load_window(
    vtuber: VtuberRef | str,
    n: int = 75,
    *,
    require_entry: bool = True,
    min_records: int = MIN_RECORDS,
    root: Path | None = None,
    keep: "Callable[[int, int], bool] | None" = None,
    since: str | None = None,
    until: str | None = None,
    live_ids: "Sequence[str] | None" = None,
) -> Window:
    """加载最近 `n` 场的窗口。

    Args:
        vtuber: `VtuberRef` 或显示名/简称。
        n: 取最近多少场。
        require_entry: 是否要求场次有入场事件才进在册集合。默认 True ——
            没有入场事件的场次**无法测出勤**，留在分母里会把所有人的出席率压低。
        min_records: 记录数下限，低于此值的场次判为坏样本并跳过。
        root: 覆盖数据根（测试用）。
        keep: 可选的场次过滤 `keep(序号, 总数) -> bool`，在入选判定之后、聚合之前生效。
            **效标加权必须用它切前半/后半窗口**（规格 §4.3：预测子只能来自过去）。
            注意它作用在 `n` 截取之后，所以 `keep=lambda i, t: i < t//2` 得到的就是
            这个窗口的前半。

        since / until: 时间区间（`YYYY-MM-DD`，闭区间，比较场次 `start_at` 的日期部分）。
            用户在工作台里选的就是这个，不是"最近 N 场"。

            ⚠️ 区间只是**先筛场次**：入选判定与分位仍按"区间内的场次数"算（规格 §2.2 的
            理由不变）⇒ **换一个区间，分位参照总体就变了**，跨区间比绝对分位同样不合法。

    Returns:
        `Window`。逐场的解析问题记在 `warnings` 里，**不抛异常**。
    """
    v = vtuber if isinstance(vtuber, VtuberRef) else get_vtuber(vtuber)
    base = (root or resolve_data_dir()) / v.subdir
    warnings: list[str] = []

    stats_dir = base / "stats"
    raw_dir = base / "raw"
    if not stats_dir.is_dir():
        warnings.append(f"stats 目录不存在：{stats_dir}")
        return Window(v, n, [], {}, warnings)

    # 1) 收场次，按开播时刻升序
    entries: list[tuple[str, dict[str, Any]]] = []
    for p in stats_dir.glob("*.json"):
        st = _read_json(p, warnings, "stats")
        if st is None:
            continue
        entries.append((str(st.get("live_id") or p.stem), st))
    # 时间区间过滤（用户在工作台里选的）。闭区间，比较 start_at 的日期部分。
    if since or until:
        before = len(entries)
        # ⚠️ 分天按**东八区**（2026-10-20）：直接用 `start_at[:10]` 取的是 UTC 日，
        # 当地 00:00–08:00 开播的场次会落到前一天，于是"选 10-20 却少一场"。
        entries = [
            kv for kv in entries
            if (not since or cn_day(str(kv[1].get("start_at") or "")) >= since)
            and (not until or cn_day(str(kv[1].get("start_at") or "")) <= until)
        ]
        if not entries:
            warnings.append(
                f"{v.name}：区间 {since or '-'} ~ {until or '-'} 内没有场次"
                f"（数据里共有 {before} 场）"
            )

    # ★ **显式场次清单优先**（2026-10-19）：给了 `live_ids` 就只取这几场，且**不做 [-n:] 截断**
    # —— 清单本身就是窗口，再截一次会把用户选的场次截掉。这样"滑杆窗口 / 采集对象 /
    # 分析样本"三者是同一批场次，不再是三套口径。
    if live_ids is not None:
        wanted = {str(x) for x in live_ids}
        before = len(entries)
        entries = [kv for kv in entries if str(kv[0]) in wanted]
        missing = wanted - {str(kv[0]) for kv in entries}
        if missing:
            warnings.append(f"{len(missing)} 场在数据目录里找不到（清单 {len(wanted)} 场）")
        if not entries and before:
            warnings.append("清单里的场次都没有 stats 文件")

    entries.sort(key=lambda kv: str(kv[1].get("start_at") or ""))
    if live_ids is None and len(entries) > n:
        entries = entries[-n:]

    # 2) 入选判定（规格 §2.4：只认内部判据）
    sessions: list[SessionRef] = []
    for live_id, st in entries:
        rec = int(st.get("records") or 0)
        if rec < min_records:
            warnings.append(f"跳过 live_id={live_id}：记录数 {rec} < {min_records}")
            continue
        sr = SessionRef(live_id=live_id, start_at=str(st.get("start_at") or ""),
                        end_at=str(st.get("end_at") or ""),
                        n_users=int(st.get("distinct_uids") or 0), stats=st)
        if require_entry and not sr.has_entry_events:
            warnings.append(f"跳过 live_id={live_id}：无入场事件，出勤不可测")
            continue
        sessions.append(sr)

    # 3) 先验 raw 是否齐全 —— ⚠️ 必须与 `sessions` 保持一致：
    #    若某场进了分母却没有 raw，所有人该场的出席都记不上，出席率会被系统性低估。
    usable: list[SessionRef] = []
    for sr in sessions:
        if not (raw_dir / f"{sr.live_id}.json").is_file():
            warnings.append(f"跳过 live_id={sr.live_id}：raw 缺文件")
            continue
        usable.append(sr)
    sessions = usable

    # 3.5) 可选的场次过滤（切半窗用）。必须在聚合之前，且分母随之改变。
    if keep is not None:
        total_before = len(sessions)
        sessions = [sr for i, sr in enumerate(sessions) if keep(i, total_before)]
        if not sessions:
            warnings.append(f"{v.name}：`keep` 过滤后没有场次（原 {total_before} 场）")

    # 4) 逐场聚合。解析失败也要把该场从分母里摘掉（否则 Σatt ≠ N）。
    #    注：`first_pos` / `last_pos` 的分母用的是**过滤前**的场次数，
    #    因此中途失败会带来很小的位置偏移 —— 这两个字段只喂展示标签（`新面孔`），
    #    不影响任何分量；实测该分支从未触发（0/225）。
    users: dict[str, UserFact] = {}
    slices: dict[str, list[tuple]] = {}
    traces: dict[str, Trace] = {}
    total = max(1, len(sessions) - 1)
    ok: list[SessionRef] = []
    for idx, sr in enumerate(sessions):
        raw = _read_json(raw_dir / f"{sr.live_id}.json", warnings, "raw")
        if raw is None:
            warnings.append(f"跳过 live_id={sr.live_id}：raw 无法解析")
            continue
        if not isinstance(raw, dict):
            warnings.append(f"跳过 live_id={sr.live_id}：raw 结构异常（{type(raw).__name__}）")
            continue
        ok.append(sr)
        start_ts = _iso_to_ts(sr.start_at)
        pos = idx / total
        for uid, a in raw.items():
            if not isinstance(a, dict):
                warnings.append(f"raw 用户对象异常：{sr.live_id}/{uid}")
                continue
            u = users.get(uid)
            if u is None:
                u = users[uid] = UserFact(uid=uid)
            where = f"{sr.live_id}/{uid}"
            m = _as_int(a, "m", warnings, where)
            sc = _as_int(a, "sc_cnt", warnings, where)
            pay = _as_float(a, "p", warnings, where)
            u.att_n += 1
            # 首次出场时滞（2026-10-20）：该用户在本场最早事件 − 本场最早事件。
            # 基准用**事件**而不是平台开播时间 —— 实测两者只差 0.6 分钟（中位）。
            _lag = _first_lag_minutes(a, start_ts)
            if _lag is not None:
                u.lag_sum += _lag
                u.lag_cnt += 1
            # 文本指纹：老数据没有这两个键 ⇒ 只置 tracked=False，**不写 0 冒充**
            if "uniq" in a:
                u.text_tracked = True
                u.uniq += _as_int(a, "uniq", warnings, where)
                u.maxrep = max(u.maxrep, _as_int(a, "maxrep", warnings, where))
            u.m += m
            u.sc_cnt += sc
            sr.sum_m += m
            sr.sum_sc += sc
            sr.sum_pay += pay
            sr.n_pairs += 1
            u.gift_amt += _as_float(a, "g", warnings, where)
            u.guard_amt += _as_float(a, "gd", warnings, where)
            u.sc_amt += _as_float(a, "sc", warnings, where)
            u.pay_events += _as_int(a, "pe", warnings, where)
            u.gift_cnt += _as_int(a, "gift_cnt", warnings, where)
            u.guard_cnt += _as_int(a, "guard_cnt", warnings, where)
            u.pay += pay
            _e = int(a.get("e") or 0)
            if m or pay or _e:
                slices.setdefault(uid, []).append(
                    (sr.live_id, str(sr.start_at), m, round(pay, 2), _e,
                     int(a.get("uniq") or 0) if "uniq" in a else 0))
            if m > 0:
                u.msg_sess += 1
            if sc > 0:
                u.sc_sess += 1
            gt = a.get("guard_top")
            if isinstance(gt, str) and _GUARD_RANK.get(gt, 0) > _GUARD_RANK.get(u.guard_top or "", 0):
                u.guard_top = gt
            if not u.name:
                _nm = a.get("n")
                if isinstance(_nm, str) and _nm.strip():
                    u.name = _nm.strip()[:40]
            u.last_pos = max(u.last_pos, pos)
            u.first_pos = min(u.first_pos, pos)
            # 独轮车 v2 需要**逐条序列**（时间分布），这里顺手喂进去；
            # 只喂本场 ≥20 条的用户，避免给几万条噪声用户白算滑动窗口。
            _mt = a.get("mt")
            _mh = a.get("mh")
            if isinstance(_mt, list) and isinstance(_mh, list) and len(_mt) >= 20:
                _tr = traces.get(uid)
                if _tr is None:
                    _tr = traces[uid] = Trace()
                feed(_tr, session_idx=idx, mt=_mt, mh=_mh)

    sessions = ok

    if not sessions:
        warnings.append(f"{v.name}：没有可用场次（requested n={n}）")
    # 独轮车判定：v1（重复率，用累计 uniq/maxrep）+ v2（时间分布），**并集**
    spam: dict[str, str] = {}          # 只放**确定**档（标签「独轮车」据此判定）
    spam_levels: dict[str, str] = {}   # 三档全量（详情页展示）
    for uid, u in users.items():
        rule = None
        per = [(sl[2], sl[5]) for sl in slices.get(uid, [])]
        if u.text_tracked and u.m >= 20:
            level = level_for(m=u.m, uniq=u.uniq, sessions=per,
                              speaking_sessions=u.msg_sess)
            if level != "none":
                spam_levels[uid] = level
            if level == "confirmed":
                rule = "repeat"
        tr = traces.get(uid)
        if tr is not None:
            flag2, rule2 = verdict(tr)
            if flag2:
                # v2 是**时间分布**判据（与 v1 的重复率不同源），所以不套 v1 的低多样性门槛；
                # 但同样要过"跨场"这道门：至少两场有足够样本，才谈得上"确定"。
                # 场次太少的同样只能"疑似"（与 v4 口径一致）
                evidence_n = sum(1 for mm, _uq in per if mm >= 20)
                lvl2 = ("confirmed" if evidence_n >= 2 and u.msg_sess >= 5
                        else "suspected")
                if lvl2 == "confirmed" or spam_levels.get(uid) != "confirmed":
                    spam_levels[uid] = lvl2
                rule = rule or (rule2 if lvl2 == "confirmed" else None)
        if rule:
            spam[uid] = rule
    return Window(v, n, sessions, users, warnings, spam, spam_levels, slices)


def load_all(before_n: int = 75) -> dict[str, Window]:
    """加载全部已注册 V（诊断与跨 V 用）。"""
    return {v.name: load_window(v, before_n) for v in VTUBERS}


def summary(win: Window) -> dict[str, Any]:
    """给日志与诊断用的摘要。"""
    return {
        "vtuber": win.vtuber.name,
        "requested_n": win.requested_n,
        "sessions": win.n,
        "users": len(win.users),
        "att_total": sum(u.att_n for u in win.users.values()),
        "m_total": sum(u.m for u in win.users.values()),
        "sc_total": sum(u.sc_cnt for u in win.users.values()),
        "pay_total": round(sum(u.pay for u in win.users.values()), 2),
        "warnings": len(win.warnings),
    }


__all__ = [
    "DATA_DIR_ENV",
    "PROD_SUBDIR",
    "DEV_SUBDIR",
    "MIN_RECORDS",
    "ENTRY_TYPE",
    "FanDataError",
    "FanDataNotFound",
    "VtuberRef",
    "VTUBERS",
    "UserFact",
    "SessionRef",
    "Window",
    "get_vtuber",
    "list_vtubers",
    "subdir_for",
    "ensure_data_dir",
    "DEV_SUBDIRS",
    "resolve_data_dir",
    "load_window",
    "load_all",
    "summary",
]
