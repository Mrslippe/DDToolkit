"""L6 时间动态的用例。

核心判据四条（都是**防止误读**的，不是"跑得通"）：

1. **迁移矩阵守恒**：每行之和 = 该层人数；列之和 = 下一窗该层人数（"未观测"列 = 并集 − 池）
2. **★ 零模型**：层级与时间独立时，对角期望应 ≈ 层规模占比；`lift` 才有意义
3. **★ 未观测 ≠ 降级**：在 t 窗入池、t+1 窗没入池的人必须落进"未观测"列，不能算外层
4. **半衰期**：曲线是人工构造的指数序列时能算准；**不是指数时必须报低 R² 并给平台值**
"""

from __future__ import annotations

import atexit
import shutil
import tempfile

import math
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.services.fan.timeline import (
    TIER_CORE,
    TIER_MID,
    TIER_OUTER,
    TIER_UNSEEN,
    TIERS,
    TIERS_WITH_UNSEEN,
    Decay,
    TimelineError,
    WindowSnapshot,
    _fit_half_life,
    _plateau,
    survival,
    transition,
)




# ── DB 隔离 ────────────────────────────────────────────────────────────────
# 端点用例要打 `PUT /settings/prefs`（模块开关走真实路径）⇒ 必须把 DB 覆盖到临时库。
# 不覆盖的后果：写进工程根的真实 `vtuber.db`，全量跑时污染别的用例（实测 2 条红）。
_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-fan-timeline-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'fan_timeline.db').as_posix()}",
                        connect_args={"check_same_thread": False})
_Session = sessionmaker(bind=_engine, autoflush=False, autocommit=False)


def _override_get_db():
    db = _Session()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _test_db():
    from app.core.database import Base, get_db
    from app.main import app as fastapi_app

    previous = fastapi_app.dependency_overrides.get(get_db)
    fastapi_app.dependency_overrides[get_db] = _override_get_db
    Base.metadata.create_all(bind=_engine)
    yield
    if previous is None:
        fastapi_app.dependency_overrides.pop(get_db, None)
    else:
        fastapi_app.dependency_overrides[get_db] = previous
    Base.metadata.drop_all(bind=_engine)

def snap(index: int, tiers: dict[str, str], *, start: int = 0, size: int = 25) -> WindowSnapshot:
    return WindowSnapshot(
        index=index, start_session=start, end_session=start + size, n_sessions=size,
        first_date=f"2026-01-{index + 1:02d}", last_date=f"2026-02-{index + 1:02d}",
        tier=dict(tiers), strength={u: 1.0 for u in tiers},
    )


# ── 1. 守恒 ────────────────────────────────────────────────────────────────
def test_rows_and_columns_conserve() -> None:
    a = snap(0, {"u1": TIER_CORE, "u2": TIER_CORE, "u3": TIER_MID, "u4": TIER_OUTER})
    b = snap(1, {"u1": TIER_CORE, "u2": TIER_MID, "u3": TIER_MID, "u9": TIER_CORE})
    t = transition(a, b)

    for ra in TIERS:
        expected_row = sum(1 for x in a.tier.values() if x == ra)
        assert sum(t.counts[ra].values()) == expected_row, f"{ra} 行不守恒"

    # 层级列之和 = |a池 ∩ b池|（只统计 a 池里的人在 b 窗的落点）。
    # ⚠️ 不是 |b池| —— 新进的人没有行，那是"流入"，不是列和。
    tier_cols = sum(t.counts[ra][cb] for ra in TIERS for cb in TIERS)
    assert tier_cols == len(a.pool & b.pool), "层级列之和应等于两窗池子的交集"
    total = sum(t.counts[ra][cb] for ra in TIERS for cb in TIERS_WITH_UNSEEN)
    assert total == len(a.pool)
    assert t.union == len(a.pool | b.pool)


# ── 2. 零模型 ──────────────────────────────────────────────────────────────
def test_expected_matches_independence_baseline() -> None:
    """层级与时间独立时，对角期望 ≈ 行人数 × 列占比。"""
    a = snap(0, {f"a{i}": TIER_CORE for i in range(20)})
    b = snap(1, {**{f"a{i}": TIER_CORE for i in range(20)},
                 **{f"b{i}": TIER_OUTER for i in range(80)}})
    t = transition(a, b)
    # 并集 100 人；b 窗核心 20 人、外层 80 人
    assert t.union == 100
    assert t.col_sizes[TIER_CORE] == 20
    exp = t.expected[TIER_CORE][TIER_CORE]
    assert exp == pytest.approx(20 * 20 / 100)     # = 4
    # 实际 20 人全留核心 ⇒ lift = 5
    assert t.counts[TIER_CORE][TIER_CORE] == 20
    assert t.diagonal_lift(TIER_CORE) == pytest.approx(5.0)


def test_lift_is_one_when_independent() -> None:
    """构造一个"下一窗层级与上一窗无关"的极端例子：lift 应当接近 1。"""
    # 上一窗 100 人全是核心；下一窗把同样 100 人重新分：20 核心 / 30 次核心 / 50 外层
    a = snap(0, {f"u{i}": TIER_CORE for i in range(100)})
    b_tiers: dict[str, str] = {}
    for i in range(20):
        b_tiers[f"u{i}"] = TIER_CORE
    for i in range(20, 50):
        b_tiers[f"u{i}"] = TIER_MID
    for i in range(50, 100):
        b_tiers[f"u{i}"] = TIER_OUTER
    t = transition(a, snap(1, b_tiers))
    assert t.counts[TIER_CORE][TIER_CORE] == 20
    # 期望 = 100 × 20/100 = 20 ⇒ lift = 1
    assert t.diagonal_lift(TIER_CORE) == pytest.approx(1.0)


# ── 3. 未观测 ≠ 降级 ───────────────────────────────────────────────────────
def test_missing_next_window_goes_to_unseen_not_outer() -> None:
    """在 t 窗入池、t+1 窗**没入池**的人必须进"未观测"列。"""
    a = snap(0, {"keep": TIER_CORE, "gone": TIER_CORE})
    b = snap(1, {"keep": TIER_CORE})          # gone 不再入池
    t = transition(a, b)
    assert t.counts[TIER_CORE][TIER_UNSEEN] == 1, "消失的人应进未观测列"
    assert t.counts[TIER_CORE][TIER_OUTER] == 0, "不能把消失算成降到外层"


def test_unseen_column_size_is_union_minus_pool() -> None:
    a = snap(0, {"u1": TIER_CORE})
    b = snap(1, {"u2": TIER_MID})             # 换了个人
    t = transition(a, b)
    assert t.union == 2
    assert t.col_sizes[TIER_UNSEEN] == 1      # u1 没出现在 b 窗


# ── 4. 半衰期与平台 ────────────────────────────────────────────────────────
def test_fit_recovers_known_half_life() -> None:
    """构造 S(k) = 0.5^(k/4) ⇒ 半衰期应精确是 4。"""
    pts = [(k, 0.5 ** (k / 4)) for k in range(1, 6)]
    fit = _fit_half_life(pts, 6)
    assert fit.half == pytest.approx(4.0, rel=1e-6)
    assert fit.r2 == pytest.approx(1.0, abs=1e-9)
    assert fit.note == ""


def test_fit_flags_bad_exponential_fit() -> None:
    """先掉后平的曲线 ⇒ R² 低、且 note 里必须写明"半衰期不可信"。

    用**星瞳的真实曲线**（R²=0.89）—— 弥月那条 R²=0.915，还没坏到要警告。
    """
    pts = [(1, 0.686), (2, 0.596), (3, 0.592), (4, 0.575), (5, 0.51)]
    fit = _fit_half_life(pts, 6)
    assert fit.r2 is not None and fit.r2 < 0.95
    assert "不可信" in fit.note or "R²" in fit.note


def test_plateau_is_tail_mean() -> None:
    pts = [(1, 0.9), (2, 0.7), (3, 0.6), (4, 0.58)]
    p, lag = _plateau(pts)
    assert p == pytest.approx((0.6 + 0.58) / 2)
    assert lag == 3


def test_survival_excludes_demoted_and_unseen() -> None:
    """生存率的分母是队列；降级与消失**都算没存活**（这是"换血"的定义）。"""
    snaps = [
        snap(0, {"a": TIER_CORE, "b": TIER_CORE, "c": TIER_CORE}),
        snap(1, {"a": TIER_CORE, "b": TIER_MID}),            # b 降级、c 消失
    ]
    d = survival(snaps, TIER_CORE)
    assert d.cohort == 3
    assert d.points == [(1, pytest.approx(1 / 3))]


def test_survival_empty_cohort_is_not_an_error() -> None:
    d = survival([snap(0, {"a": TIER_OUTER}), snap(1, {"a": TIER_OUTER})], TIER_CORE)
    assert d.cohort == 0
    assert "空" in d.note


# ── 5. 窗口太少要明确报错 ─────────────────────────────────────────────────
def test_build_windows_needs_two_windows() -> None:
    from app.services.fan.timeline import build_windows
    from app.services.fan.loader import FanDataNotFound, resolve_data_dir

    try:
        resolve_data_dir()
    except FanDataNotFound:
        pytest.skip("没有真实数据")
    with pytest.raises(TimelineError):
        build_windows("弥月", 10, size=25, step=10)


# ── 6. 端点 ────────────────────────────────────────────────────────────────
def test_timeline_endpoint_requires_module(tmp_path: Path,
                                          monkeypatch: pytest.MonkeyPatch) -> None:
    """模块关着 ⇒ 404（与其他 /fan 端点一致）。"""
    from fastapi.testclient import TestClient

    from app.core import api_auth
    from app.core.database import get_db
    from app.main import app as fastapi_app
    from app.routers import fan as fan_router
    from app.services.fan.loader import DATA_DIR_ENV

    api_auth.settings.API_TOKEN = "t"
    api_auth.settings.DEV_API_TOKEN = ""
    monkeypatch.setenv(DATA_DIR_ENV, str(tmp_path))
    fan_router.reset_state()
    c = TestClient(fastapi_app, headers={"X-DDToolkit-Token": "t"})
    c.put("/settings/prefs", json={"values": {"fan_workbench": "off"}})
    r = c.get("/fan/弥月/timeline")
    assert r.status_code == 404
    assert "未启用" in r.json()["detail"]
    fan_router.reset_state()


def test_timeline_endpoint_shape_on_real_data() -> None:
    """真数据上跑一次（没有数据就跳过），核对关键字段与守恒。"""
    from fastapi.testclient import TestClient

    from app.core import api_auth
    from app.main import app as fastapi_app
    from app.routers import fan as fan_router
    from app.services.fan.loader import FanDataNotFound, resolve_data_dir

    try:
        resolve_data_dir()
    except FanDataNotFound:
        pytest.skip("没有真实数据")

    api_auth.settings.API_TOKEN = "t"
    api_auth.settings.DEV_API_TOKEN = ""
    fan_router.reset_state()
    c = TestClient(fastapi_app, headers={"X-DDToolkit-Token": "t"})
    c.put("/settings/prefs", json={"values": {"fan_workbench": "on"}})

    r = c.get("/fan/弥月/timeline", params={"n": 75, "size": 25, "step": 10})
    if r.status_code == 400:
        pytest.skip(f"数据不足以切窗：{r.json()['detail']}")
    assert r.status_code == 200, r.text
    j = r.json()

    assert j["spec"]["tiers"] == ["核心", "次核心", "外层", "未观测"]
    assert len(j["windows"]) >= 2
    assert len(j["transitions"]) == len(j["windows"]) - 1
    for tr in j["transitions"]:
        # 每行之和 > 0，且"未观测"列存在
        for ra in ("核心", "次核心", "外层"):
            assert sum(tr["counts"][ra].values()) > 0
            assert "未观测" in tr["counts"][ra]
        # lift 必须是有限正数（期望为 0 时置 0）
        assert tr["core"]["lift"] >= 0
    # 平台值按层级递减（核心 > 次核心 > 外层）—— 一个合理的自检
    tail = j["tails"]
    if all(tail[k]["plateau"] is not None for k in tail):
        assert tail["核心"]["plateau"] >= tail["外层"]["plateau"]
    fan_router.reset_state()
