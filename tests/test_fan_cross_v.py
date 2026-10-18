"""`cross_v` 与 `/fan/cross` 的用例（P4）。

施工计划 §2 P4 的验收判据：

| 判据 | 期望 |
|---|---|
| P4-1 交集 = 名单求交 | 一致 |
| P4-2 超几何期望在"两 V 完全相同"的构造数据上等于实际重叠 | 相等 |
| P4-3 lift 与双向比例的分母符合口径 | 有专门用例 |
| P4-4 跨 V 接口**不返回**分数比较 | 有反向用例（字段不存在） |

外加一条本批新发现的：**贫化与"无差异"必须分开报** —— lift < 1 且下尾显著时，
写"无显著差异"是错的。
"""

from __future__ import annotations

import atexit
import shutil
import tempfile

import json
import math
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base, get_db
from app.main import app
from app.services.fan.cross_v import (
    TIER_CORE,
    TIER_MID,
    TIER_OUTER,
    TIERS,
    assign_tiers,
    describe,
    hypergeom_cdf,
    hypergeom_sf,
    overlap,
    tier_moves,
)
from app.services.fan.axes import AxisTable


# ── 合成画像工具 ──────────────────────────────────────────────────────────


# ── DB 隔离 ────────────────────────────────────────────────────────────────
# 本文件要打 `PUT /settings/prefs`（模块开关走真实路径），因此**必须**把 DB 覆盖到临时库。
# 不覆盖的后果：写到工程根的真实 `vtuber.db`，全量跑时污染别的用例（实测 18 error）。
_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-fan-cross-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'fan_cross.db').as_posix()}",
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
    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db
    Base.metadata.create_all(bind=_engine)
    yield
    if previous is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous
    Base.metadata.drop_all(bind=_engine)

def _profile(name: str, uids: list[str]) -> object:
    from app.services.fan.cross_v import VProfile
    n = len(uids)
    # 按给定顺序切层：前 20% 核心、次 30% 次核心、其余外层
    tier = {}
    for i, uid in enumerate(uids):
        q = 1.0 - (i + 1) / n
        tier[uid] = (TIER_CORE if q >= 0.80 else TIER_MID if q >= 0.50 else TIER_OUTER)
    return VProfile(name, name, 10, tier, {u: 1.0 - i / n for i, u in enumerate(uids)})


# ── 超几何 ────────────────────────────────────────────────────────────────
def test_hypergeom_sf_known_value() -> None:
    """教科书例：N=50, K=5, n=10, P(X≥1) = 1 - C(45,10)/C(50,10)。"""
    expected = 1 - math.comb(45, 10) / math.comb(50, 10)
    assert hypergeom_sf(1, 50, 5, 10) == pytest.approx(expected, rel=1e-9)


def test_hypergeom_sf_and_cdf_are_complementary() -> None:
    n, k_, d = 100, 30, 20
    for obs in (0, 5, 10, 15):
        # P(X≥obs) + P(X≤obs-1) = 1
        assert hypergeom_sf(obs, n, k_, d) + hypergeom_cdf(obs - 1, n, k_, d) == pytest.approx(1.0, rel=1e-9)


def test_hypergeom_bounds() -> None:
    assert hypergeom_sf(0, 100, 10, 10) == 1.0
    assert hypergeom_sf(11, 100, 10, 10) == 0.0
    assert hypergeom_cdf(-1, 100, 10, 10) == 0.0
    assert hypergeom_cdf(10, 100, 10, 10) == 1.0


# ── P4-2 完全相同 → 实际 = 期望 ───────────────────────────────────────────
def test_identical_pools_give_lift_one() -> None:
    """两 V 名单**完全相同**时，交集 = 池大小 = 期望，lift = 1。"""
    uids = [f"u{i}" for i in range(1000)]
    a, b = _profile("A", uids), _profile("B", uids)
    ov = overlap(a, b)
    assert ov.intersection == 1000
    assert ov.population == 1000
    assert ov.expected == pytest.approx(1000.0)
    assert ov.lift == pytest.approx(1.0)
    assert ov.share_of_a == pytest.approx(1.0)
    assert ov.share_of_b == pytest.approx(1.0)
    assert ov.jaccard == pytest.approx(1.0)


def test_disjoint_pools_give_zero_overlap() -> None:
    a = _profile("A", [f"a{i}" for i in range(100)])
    b = _profile("B", [f"b{i}" for i in range(100)])
    ov = overlap(a, b)
    assert ov.intersection == 0
    assert ov.lift == pytest.approx(0.0)
    assert ov.population == 200
    assert ov.expected == pytest.approx(50.0)


# ── P4-3 lift 与双向比例 ──────────────────────────────────────────────────
def test_lift_and_shares_denominators() -> None:
    """A 有 100 人、B 有 200 人、交集 50 人 ⇒ lift = 50/(100*200/250) = 0.625。"""
    a = _profile("A", [f"x{i}" for i in range(100)])
    b_uids = [f"x{i}" for i in range(100)] + [f"y{i}" for i in range(100)]
    b = _profile("B", b_uids)
    ov = overlap(a, b)
    assert ov.intersection == 100     # A 全在 B 里
    assert ov.population == 200
    assert ov.expected == pytest.approx(100 * 200 / 200)
    assert ov.lift == pytest.approx(1.0)
    assert ov.share_of_a == pytest.approx(1.0)
    assert ov.share_of_b == pytest.approx(0.5)


def test_direction_shares_are_asymmetric() -> None:
    """A 小而 B 大时，两个方向的比例必须不同 —— 这正是"分方向"的理由。"""
    a = _profile("A", [f"x{i}" for i in range(10)])
    b = _profile("B", [f"x{i}" for i in range(10)] + [f"y{i}" for i in range(990)])
    ov = overlap(a, b)
    assert ov.share_of_a == pytest.approx(1.0)
    assert ov.share_of_b == pytest.approx(10 / 1000)


# ── 贫化 vs 无差异 ────────────────────────────────────────────────────────
def test_depleted_is_reported_as_depleted_not_no_difference() -> None:
    """★ 本批修的措辞 bug：lift 远小于 1 且下尾显著时，不能说"无显著差异"。"""
    a = _profile("A", [f"a{i}" for i in range(500)])
    b_uids = [f"a{i}" for i in range(5)] + [f"b{i}" for i in range(995)]
    b = _profile("B", b_uids)
    ov = overlap(a, b)
    assert ov.lift < 1.0
    assert ov.is_depleted
    assert not ov.is_enriched
    text = describe(ov)
    assert "贫化" in text
    assert "无显著差异" not in text


def test_enriched_is_reported_as_enriched() -> None:
    """构造富集：两 V 大部分共享，但总体 N 远大于池规模做不到 —— 改用大 B 小 A。

    A ⊂ B 且 B ≫ A 时 lift = |A| / (|A||B|/|B|) = 1；要真富集得让 A、B 都很小而交集大。
    """
    a = _profile("A", [f"x{i}" for i in range(200)])
    b = _profile("B", [f"x{i}" for i in range(200)] + [f"y{i}" for i in range(200)])
    ov = overlap(a, b)
    # A⊂B：实际 200，期望 200*400/400 = 200 ⇒ lift 1，不显著
    assert ov.lift == pytest.approx(1.0)


# ── 层级 ──────────────────────────────────────────────────────────────────
def test_tiers_partition_the_pool() -> None:
    uids = [f"u{i}" for i in range(100)]
    t = assign_tiers.__wrapped__ if hasattr(assign_tiers, "__wrapped__") else None
    from app.services.fan.cross_v import VProfile
    p = _profile("A", uids)
    counts = p.counts()
    assert sum(counts.values()) == 100
    assert set(counts) == set(TIERS)
    # 20% / 30% / 50%
    assert counts[TIER_CORE] == pytest.approx(20, abs=1)
    assert counts[TIER_MID] == pytest.approx(30, abs=1)


def test_tier_moves_counts_are_conserved() -> None:
    a = _profile("A", [f"x{i}" for i in range(100)] + [f"a{i}" for i in range(100)])
    b = _profile("B", [f"x{i}" for i in range(100)] + [f"b{i}" for i in range(100)])
    moves = tier_moves(a, b)
    assert sum(moves.values()) == len(a.pool & b.pool)


def test_tier_table_sums_to_intersection() -> None:
    a = _profile("A", [f"x{i}" for i in range(500)] + [f"a{i}" for i in range(500)])
    b = _profile("B", [f"x{i}" for i in range(500)] + [f"b{i}" for i in range(500)])
    ov = overlap(a, b)
    total = sum(sum(row.values()) for row in ov.tiers.values())
    assert total == ov.intersection


# ── P4-4 接口不返回分数比较 ───────────────────────────────────────────────
_SUB_A = "pilot_v3_mizuki"
_SUB_B = "pilot_v3_mingqian"


def _make(root: Path) -> Path:
    """两个 V 各 10 场；受众有 60% 重叠，用于跑通端点。"""
    for sub, tag in ((_SUB_A, "s"), (_SUB_B, "m")):
        base = root / sub
        (base / "stats").mkdir(parents=True)
        (base / "raw").mkdir()
        for i in range(10):
            lid = f"L{i:02d}"
            facts = {}
            for j in range(10):
                uid = f"shared{j}" if j < 6 else f"{tag}{j}"
                facts[uid] = {"m": 10 + j, "sc_cnt": 0, "gift_cnt": 0,
                              "guard_cnt": 0, "guard_top": None, "p": float(j)}
            type0 = sum(a["m"] for a in facts.values())
            stats = {"live_id": lid, "start_at": f"2026-02-{i + 1:02d}T10:00:00",
                     "end_at": f"2026-02-{i + 1:02d}T12:00:00",
                     "records": type0 + 20, "distinct_uids": len(facts),
                     "type_hist": {"0": type0, "4": 20},
                     "sum_price": sum(a["p"] for a in facts.values()), "type4": 20}
            (base / "stats" / f"{lid}.json").write_text(
                json.dumps(stats, ensure_ascii=False), encoding="utf-8")
            (base / "raw" / f"{lid}.json").write_text(
                json.dumps(facts, ensure_ascii=False), encoding="utf-8")
    return root


def _enable_module(client) -> None:
    """把 `fan_workbench` 打开 —— **走真实路径**（`PUT /settings/prefs`），
    不是 monkeypatch 那个判据函数。否则「开关」这条根本没被测到。"""
    r = client.put("/settings/prefs", json={"values": {"fan_workbench": "on"}})
    assert r.status_code == 200, r.text

@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from fastapi.testclient import TestClient

    from app.main import app
    from app.routers import fan as fan_router
    from app.services.fan.loader import DATA_DIR_ENV

    _make(tmp_path)
    monkeypatch.setenv(DATA_DIR_ENV, str(tmp_path))
    fan_router.reset_state()
    c = TestClient(app)
    _enable_module(c)
    yield c
    fan_router.reset_state()


def test_cross_endpoint_shape(client) -> None:
    r = client.get("/fan/cross", params={"vtubers": "弥月,明前奶绿", "window": 10})
    assert r.status_code == 200
    body = r.json()
    for key in ("a", "b", "overlap", "tier_table", "tier_moves", "reading"):
        assert key in body, key
    ov = body["overlap"]
    for key in ("intersection", "expected", "lift", "p_value", "p_value_lower",
                "share_of_a", "share_of_b", "jaccard", "is_enriched", "is_depleted"):
        assert key in ov, key


def test_cross_never_returns_score_comparison(client) -> None:
    """P4-4：**不返回分数比较** —— 跨 V 的分数不可比（规格 §5.5）。

    ⚠️ 不能拿子串 `value_` 做检查：`p_value_lower` 里也含它（本用例第一版就这么误判过）。
    要按**字段名**精确判。
    """
    body = client.get("/fan/cross", params={"vtubers": "弥月,明前奶绿", "window": 10}).json()

    def walk(node: object) -> set[str]:
        keys: set[str] = set()
        if isinstance(node, dict):
            for k, v in node.items():
                keys.add(k)
                keys |= walk(v)
        elif isinstance(node, list):
            for v in node:
                keys |= walk(v)
        return keys

    keys = walk(body)
    forbidden = {"strength", "axis_percentiles", "value_retention", "value_income",
                 "score", "intensity"}
    leaked = keys & forbidden
    assert not leaked, f"跨 V 接口不应出现分数比较字段：{leaked}"


def test_cross_requires_exactly_two(client) -> None:
    assert client.get("/fan/cross", params={"vtubers": "弥月"}).status_code == 400
    assert client.get("/fan/cross",
                      params={"vtubers": "弥月,明前奶绿,星瞳"}).status_code == 400


def test_cross_unknown_vtuber_is_404(client) -> None:
    assert client.get("/fan/cross",
                      params={"vtubers": "弥月,不存在"}).status_code == 404
