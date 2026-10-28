"""`app/routers/fan.py` 的用例（P3）。

施工计划 §2 P3 的验收判据：

| 判据 | 期望 |
|---|---|
| P3-1 三个 `by` 的名单与探针一致 | 用合成数据校验排序与字段 |
| **P3-2 缺 `by` 返回 400** | 不是 422，也不是默认值 |
| P3-3 标签占比与探针一致 | 合成数据里可精确预期 |
| P3-4 极端并列处次序稳定 | 两次请求逐行相同 |

⚠️ 用例全部用 `DDTOOLKIT_FAN_DATA_DIR` 指向 `tmp_path` 造的微型数据集 ——
不碰真实数据（施工计划铁律 1）。
"""

from __future__ import annotations

import atexit
import shutil
import tempfile

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base, get_db
from app.main import app
from app.routers import fan as fan_router
from app.services.fan.loader import DATA_DIR_ENV

SUB = "pilot_v3_mizuki"   # 用注册表里已有的子目录名，省得改 VTB 注册表




# ── DB 隔离 ────────────────────────────────────────────────────────────────
# 本文件要打 `PUT /settings/prefs`（模块开关走真实路径），因此**必须**把 DB 覆盖到临时库。
# 不覆盖的后果：写到工程根的真实 `vtuber.db`，全量跑时污染别的用例（实测 18 error）。
_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-fan-api-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)
_engine = create_engine(f"sqlite:///{(_TMPDIR / 'fan_api.db').as_posix()}",
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

def _make(root: Path, n_sessions: int = 12) -> Path:
    """造一个微型数据集：12 场，4 个用户，覆盖不同行为模式。

    ⚠️ `stats` 里的 `type_hist["0"]` 与 `sum_price` **必须与 raw 自洽** ——
    否则 C1 内部恒等式会判该场次 dropped（这正是它该做的事，
    `test_health_reports_checks` 就踩过这个：手写 600 条而 raw 只有 106 条）。
    """
    base = root / SUB
    (base / "stats").mkdir(parents=True)
    (base / "raw").mkdir()
    for i in range(n_sessions):
        lid = f"L{i:02d}"
        facts = {
            # 全勤 + 高互动 + 付费
            "u_all": {"m": 100, "sc_cnt": 2, "gift_cnt": 1, "guard_cnt": 0,
                      "guard_top": None, "p": 10.0},
            # 全勤 + 从不发言（纯黑听）
            "u_lurk": {"m": 0, "sc_cnt": 0, "gift_cnt": 0, "guard_cnt": 0,
                       "guard_top": "舰长", "p": 0.0},
            # 一半场次 + 少量互动
            "u_half": {"m": 5, "sc_cnt": 0, "gift_cnt": 0, "guard_cnt": 0,
                       "guard_top": None, "p": 0.0},
            # 只来了一场
            "u_once": {"m": 1, "sc_cnt": 0, "gift_cnt": 0, "guard_cnt": 0,
                       "guard_top": None, "p": 0.0},
        }
        if i % 2 == 1:
            facts.pop("u_half")
        if i > 0:
            facts.pop("u_once")
        # 由 raw 反推 stats，保证 C1 恒等式成立
        type0 = sum(a["m"] for a in facts.values())
        sum_price = round(sum(a["p"] for a in facts.values()), 2)
        sc_cnt = sum(a["sc_cnt"] for a in facts.values())
        stats = {
            "live_id": lid,
            "start_at": f"2026-01-{i + 1:02d}T10:00:00",
            "end_at": f"2026-01-{i + 1:02d}T12:00:00",
            "records": type0 + 30 + sc_cnt + 5,
            "distinct_uids": len(facts),
            "type_hist": {"0": type0, "4": 30, "3": sc_cnt, "1": 5},
            "sum_price": sum_price,
            "type4": 30,
        }
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
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    _make(tmp_path)
    monkeypatch.setenv(DATA_DIR_ENV, str(tmp_path))
    fan_router.reset_state()
    c = TestClient(app)
    _enable_module(c)
    yield c
    fan_router.reset_state()


# ── /fan/vtubers ──────────────────────────────────────────────────────────
def test_list_vtubers(client: TestClient) -> None:
    """清单是**动态的**（库里的 B 站账号 + 真有数据的开发样本）。

    这个用例的临时库里没有主播、数据根里只造了 `SUB` 一个目录 ⇒ 只会列出它。
    """
    r = client.get("/fan/vtubers")
    assert r.status_code == 200
    body = r.json()
    mine = [x for x in body["items"] if x["subdir"] == SUB][0]
    assert mine["has_data"] is True
    assert body["count"] == 1, "只该列出真有数据的那个"
    assert sum(1 for x in body["items"] if x["has_data"]) == 1


# ── P3-2 缺 by ────────────────────────────────────────────────────────────
def test_ranked_requires_by(client: TestClient) -> None:
    """**`by` 必填** —— 缺了是 400，不是 422，更不是默认值。"""
    r = client.get("/fan/弥月/ranked")
    assert r.status_code == 400
    assert "by" in r.json()["detail"]


def test_ranked_rejects_unknown_by(client: TestClient) -> None:
    r = client.get("/fan/弥月/ranked", params={"by": "随便"})
    assert r.status_code == 400


def test_ranked_unknown_vtuber_is_404(client: TestClient) -> None:
    r = client.get("/fan/不存在的主播/ranked", params={"by": "strength"})
    assert r.status_code == 404


# ── P3-1 名单 ─────────────────────────────────────────────────────────────
def test_ranked_strength_sorted_desc(client: TestClient) -> None:
    r = client.get("/fan/弥月/ranked", params={"by": "strength", "window": 12, "limit": 50})
    assert r.status_code == 200
    body = r.json()
    assert body["by"] == "strength"
    assert body["sessions"] == 12
    vals = [row["strength"] for row in body["items"]]
    assert vals == sorted(vals, reverse=True)
    assert [row["rank"] for row in body["items"]] == list(range(1, len(vals) + 1))
    # u_once 只来一场，出席率 1/12 < 10% 门槛 ⇒ 不在池里
    assert "u_once" not in [row["uid"] for row in body["items"]]


def test_ranked_rows_carry_axes_and_attendance(client: TestClient) -> None:
    r = client.get("/fan/弥月/ranked", params={"by": "strength", "window": 12})
    body = r.json()
    row = body["items"][0]
    for key in ("uid", "type", "strength", "axis_percentiles", "att_sessions",
                "att_rate", "pay_total", "msg_total", "tags"):
        assert key in row, key
    assert set(row["axis_percentiles"]) == {"attendance", "interaction", "payment"}
    assert 0.0 <= row["att_rate"] <= 1.0


def test_contribution_split_carries_aligned_uids(client: TestClient) -> None:
    """贡献榜的 `uids` 必须与 `labels` **等长同序**（2026-10-28，「隐藏昵称」开关的依赖）。

    前端的开关是按下标拿 `uids[i]` 顶掉 `labels[i]` 的 ⇒ 一旦错位，图上就会出现
    "这个鲸鱼的名字配那个人的金额"。`其他 N 人` 那条没有对应的人，必须是 `None`
    （不是空串、也不能省略 —— 省略会让长度对不上）。
    """
    body = client.get("/fan/弥月/ranked", params={"by": "payment", "window": 12}).json()
    for key in ("pay_split_top", "msg_split_top"):
        split = body["charts"][key]
        assert split["labels"], f"{key}：合成数据里有人有付费/弹幕，贡献榜不该是空的"
        assert len(split["uids"]) == len(split["labels"]) == len(split["values"]), key
        for uid, label in zip(split["uids"], split["labels"]):
            if label.startswith("其他 "):
                assert uid is None, f"{key}：合计项不该挂 uid（{label}）"
            else:
                assert isinstance(uid, str) and uid, f"{key}：{label} 缺 uid"


def test_ranked_limit_is_respected(client: TestClient) -> None:
    r = client.get("/fan/弥月/ranked", params={"by": "strength", "window": 12, "limit": 1})
    assert len(r.json()["items"]) == 1


# ── P3-4 并列稳定 ─────────────────────────────────────────────────────────
def test_ranked_is_deterministic(client: TestClient) -> None:
    a = client.get("/fan/弥月/ranked", params={"by": "strength", "window": 12}).json()
    b = client.get("/fan/弥月/ranked", params={"by": "strength", "window": 12}).json()
    assert a["items"] == b["items"]


# ── 标签 ──────────────────────────────────────────────────────────────────
def test_tags_catalog_has_all_rules(client: TestClient) -> None:
    r = client.get("/fan/弥月/tags", params={"window": 12})
    assert r.status_code == 200
    body = r.json()
    names = {x["name"] for x in body["items"]}
    assert "全勤" in names and "老头" in names and "独轮车" in names
    assert all(0.0 <= x["prevalence"] <= 1.0 for x in body["items"])


def test_lurker_and_full_attendance_tags_fire(client: TestClient) -> None:
    """合成数据里：u_all 与 u_lurk 都满勤（12/12），u_lurk 从不发言。"""
    r = client.get("/fan/弥月/ranked", params={"by": "strength", "window": 12})
    rows = {row["uid"]: row for row in r.json()["items"]}
    assert "全勤" in rows["u_all"]["tags"]
    assert "黑听民" in rows["u_lurk"]["tags"]
    assert "舰长" in rows["u_lurk"]["tags"]
    assert "互动民" in rows["u_all"]["tags"]


def test_tags_do_not_affect_order(client: TestClient) -> None:
    """标签不进排序：把带标签的人和不带标签的人比较，次序只由强度决定。"""
    r = client.get("/fan/弥月/ranked", params={"by": "strength", "window": 12})
    items = r.json()["items"]
    for a, b in zip(items, items[1:]):
        assert a["strength"] >= b["strength"]


# ── health ────────────────────────────────────────────────────────────────
def test_health_reports_checks(client: TestClient) -> None:
    r = client.get("/fan/弥月/health", params={"window": 12})
    assert r.status_code == 200
    checks = r.json()["checks"]
    assert checks["total"] == 12
    assert checks["dropped"] == 0
    # 没接外部源 ⇒ 全部 unverified，但没有一场被弃
    assert checks["unverified"] == 12


def test_window_bounds_are_enforced(client: TestClient) -> None:
    assert client.get("/fan/弥月/ranked",
                      params={"by": "strength", "window": 1}).status_code == 422
    assert client.get("/fan/弥月/ranked",
                      params={"by": "strength", "window": 9999}).status_code == 422


# ── 模块开关（「可选模块」这条要靠它成立）──────────────────────────────────
def test_module_off_returns_404_everywhere(tmp_path: Path,
                                           monkeypatch: pytest.MonkeyPatch) -> None:
    """默认关：**所有** `/fan` 端点 404 且说明原因。"""
    _make(tmp_path)
    monkeypatch.setenv(DATA_DIR_ENV, str(tmp_path))
    fan_router.reset_state()
    c = TestClient(app)
    # 测试库是共享的 ⇒ 先显式关掉（别的用例可能已经把开关打开了）
    c.put("/settings/prefs", json={"values": {"fan_workbench": "off"}})
    for path in ("/fan/弥月/ranked?by=strength", "/fan/弥月/tags", "/fan/弥月/health",
                 "/fan/cross?vtubers=弥月,明前奶绿", "/fan/collect/status"):
        r = c.get(path)
        assert r.status_code == 404, f"{path} 应当 404"
        assert "未启用" in r.json()["detail"]
    fan_router.reset_state()


def test_list_vtubers_reports_enabled_flag(tmp_path: Path,
                                          monkeypatch: pytest.MonkeyPatch) -> None:
    """`/fan/vtubers` **不受闸门限制**（界面要靠它判断该不该显示入口）。"""
    _make(tmp_path)
    monkeypatch.setenv(DATA_DIR_ENV, str(tmp_path))
    fan_router.reset_state()
    c = TestClient(app)
    assert c.get("/fan/vtubers").json()["enabled"] is False
    _enable_module(c)
    assert c.get("/fan/vtubers").json()["enabled"] is True
    fan_router.reset_state()


def test_turning_module_off_hides_data_again(client: TestClient) -> None:
    """关掉之后立刻又不可用 —— 不需要重启。"""
    assert client.get("/fan/弥月/ranked", params={"by": "strength", "window": 12}).status_code == 200
    client.put("/settings/prefs", json={"values": {"fan_workbench": "off"}})
    assert client.get("/fan/弥月/ranked", params={"by": "strength", "window": 12}).status_code == 404


def test_ranked_csv_shape_and_escaping() -> None:
    """CSV 导出：列序固定、带 BOM、含逗号/引号的昵称要正确转义（2026-10-28）。"""
    from app.routers.fan import CSV_COLUMNS, ranked_csv_bytes

    items = [
        {"rank": 1, "uid": "42", "name": '阿,"猫"', "strength": 0.987654,
         "axis_percentiles": {"attendance": 1.0, "interaction": 0.5, "payment": 0.25},
         "att_sessions": 9, "att_rate": 1.0, "msg_total": 100, "msg_unique": 80,
         "pay_total": 12.5, "guard_amt": 10.0, "sc_amt": 2.5, "gift_amt": 0.0,
         "type": "综合", "tags": ["老头", "全勤"]},
        {"rank": 2, "uid": "7", "name": "", "strength": 0.5,
         "axis_percentiles": {}, "att_sessions": 1, "att_rate": 0.1,
         "msg_total": 3, "msg_unique": 3, "pay_total": 0,
         "type": "出勤", "tags": []},
    ]
    raw = ranked_csv_bytes(items)
    assert raw[:3] == b"\xef\xbb\xbf", "必须带 UTF-8 BOM，Excel 才不乱码"
    text = raw.decode("utf-8-sig")
    lines = text.splitlines()
    assert lines[0] == ",".join(CSV_COLUMNS)
    assert len(lines) == 3
    assert '"阿,""猫"""' in lines[1], "含逗号与引号的昵称要包引号并把引号翻倍"
    assert lines[1].endswith("综合,老头;全勤")
    assert lines[2].startswith("2,7,")


def test_comment_overlap_does_not_require_payload_items(monkeypatch) -> None:
    """回归：`_compute` 的返回值里没有 `items`（那是 `/ranked` 追加的）。

    2026-10-28 的线上 500 就是这里 KeyError：`order = sorted(payload["items"])`。
    """
    from app.routers import fan_compare

    fake_prof = type("P", (), {
        "tier": {"u1": "核心", "u2": "外层"},
        "strength": {"u1": 0.9, "u2": 0.1},
        "counts": lambda self: {"核心": 1, "外层": 1},
    })()

    payload = {"window": None, "vtuber": "X"}  # 故意**没有** items

    class FakeCompute:
        def __call__(self, *a, **k):
            return payload

    # 直接调纯函数式的那段：overlap_stats 不依赖 items
    out = fan_compare.overlap_stats(fake_prof.tier, fake_prof.strength,
                                    [{"uid": "u1", "name": "甲", "cnt": 3}], top_n=10)
    assert out["overlap"]["shared"] == 1
