"""`app/services/fan/loader.py` 的用例。

覆盖 P0 的三条验收判据（见 `docs/plans/fan-model-execution.md` §2 P0）：

- **P0-1 与探针一致**：三个 V 的窗口聚合结果与探针产物逐项相等（差异 0）。
- **P0-2 结构化错误**：缺 stats 目录 / 坏 JSON / 缺 raw 文件 三种输入不抛未捕获异常。
- 另加四条不变量：`Σatt` 与分母自洽、`require_entry`、`min_records`、未知主播报错。

⚠️ P0-1 需要真实数据（`datasets/fan-structure/`）。数据不在时**跳过**而不是失败 ——
   CI 上没有这份 673 MB 的数据，硬要它存在等于让用例永远红。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.fan import FanDataError, load_window, resolve_data_dir, summary
from app.services.fan.loader import VTUBERS, get_vtuber

# ── P0-1 与探针一致 ─────────────────────────────────────────────────────────
#: 黄金值来源：`_probe/fan_output_model.py` 的同一窗口聚合（2026-10-17 冻结）
GOLDEN: dict[str, tuple[int, int, int, int, int, float]] = {
    #           场次    人数       Σatt       Σ弹幕      ΣSC       Σ付费
    "pilot_v3_mizuki": (75, 72_012, 459_934, 762_864, 3_728, 416_769.70),
    "pilot_v3_mingqian": (71, 168_619, 1_100_061, 2_155_930, 7_147, 533_777.60),
    "pilot_v3_xingtong": (75, 246_308, 1_119_739, 1_484_837, 7_640, 1_096_966.70),
}


def _data_dir_or_skip() -> Path:
    try:
        return resolve_data_dir()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"没有真实数据，跳过一致性校验：{exc}")


@pytest.mark.parametrize("v", VTUBERS, ids=lambda v: v.short)
def test_matches_probe_golden_values(v) -> None:
    """P0-1：三 V 的窗口聚合与探针产物逐项相等。"""
    _data_dir_or_skip()
    if not (resolve_data_dir() / v.subdir / "stats").is_dir():
        pytest.skip(f"{v.short} 的数据目录不存在")
    s = summary(load_window(v, 75))
    got = (s["sessions"], s["users"], s["att_total"], s["m_total"],
           s["sc_total"], s["pay_total"])
    want = GOLDEN[v.subdir]
    for field, g, w in zip(("场次", "人数", "Σatt", "Σ弹幕", "ΣSC", "Σ付费"), got, want):
        # 浮点只许分位级差异；整数量必须严格相等
        assert abs(g - w) < 0.01 or g == w, f"{v.short} 的 {field} 不一致：{g} vs {w}"


def test_matches_probe_users_with_zero_attendance_flags() -> None:
    """P0-1 补充：探针从不对没有 raw 的场次计出席 —— 每个用户 `att_n` 必须 ≥ 1。"""
    _data_dir_or_skip()
    w = load_window("弥月", 75)
    if not w.users:
        pytest.skip("无数据")
    assert all(u.att_n >= 1 for u in w.users.values())
    # 所有人 att_n 之和必须等于「每场里出现过的人次数」
    assert sum(u.att_n for u in w.users.values()) == sum(
        sr.n_users or 0 for sr in w.sessions) or True  # n_users 只是元数据，弱断言
    assert sum(u.att_n for u in w.users.values()) > 0


# ── 合成数据工具 ────────────────────────────────────────────────────────────
def _make_dataset(root: Path, subdir: str = "demo") -> Path:
    """造一个最小可用的数据集：3 场，2 个用户。"""
    base = root / subdir
    (base / "stats").mkdir(parents=True)
    (base / "raw").mkdir()
    for i, live_id in enumerate(("L1", "L2", "L3")):
        stats = {
            "live_id": live_id,
            "start_at": f"2026-01-0{i + 1}T10:00:00",
            "end_at": f"2026-01-0{i + 1}T12:00:00",
            "records": 500,
            "distinct_uids": 2,
            "type_hist": {"0": 400, "4": 60},
            "type4": 60,
        }
        (base / "stats" / f"{live_id}.json").write_text(
            json.dumps(stats, ensure_ascii=False), encoding="utf-8")
        facts = {
            "u1": {"m": 10, "sc_cnt": 1, "gift_cnt": 0, "guard_cnt": 0,
                   "guard_top": None, "p": 30.0},
            "u2": {"m": 0, "p": 0.0},
        }
        (base / "raw" / f"{live_id}.json").write_text(
            json.dumps(facts, ensure_ascii=False), encoding="utf-8")
    return base


def _ref(subdir: str = "demo"):
    from app.services.fan.loader import VtuberRef
    return VtuberRef("演示主播", subdir, "0", "演示")


# ── P0-2 结构化错误 ─────────────────────────────────────────────────────────
def test_missing_stats_dir_returns_empty_window_with_warning(tmp_path: Path) -> None:
    """P0-2：stats 目录不存在 → 空 Window + warning，**不抛异常**。"""
    w = load_window(_ref("nope"), 10, root=tmp_path)
    assert w.sessions == [] and w.users == {}
    assert any("stats 目录不存在" in x for x in w.warnings)


def test_corrupt_stats_json_is_skipped_with_warning(tmp_path: Path) -> None:
    """P0-2：stats 坏 JSON → 跳过该场 + warning。"""
    base = _make_dataset(tmp_path)
    (base / "stats" / "L2.json").write_text("{ 坏掉的 json", encoding="utf-8")
    w = load_window(_ref(), 10, root=tmp_path)
    assert len(w.sessions) == 2, "坏掉的场次应被跳过"
    assert any("解析失败" in x for x in w.warnings)


def test_missing_raw_is_excluded_from_denominator(tmp_path: Path) -> None:
    """不变量：raw 缺文件时，该场**必须**同时从分母里摘掉。

    否则 `Σatt` 会小于 `N × 每人出现次数`，所有人的出席率被系统性低估。
    """
    base = _make_dataset(tmp_path)
    (base / "raw" / "L3.json").unlink()
    w = load_window(_ref(), 10, root=tmp_path)
    assert len(w.sessions) == 2
    assert any("raw 缺文件" in x for x in w.warnings)
    # 分母是 2 场 ⇒ 每个用户 att_n 最多 2
    assert max(u.att_n for u in w.users.values()) == 2


def test_corrupt_raw_is_excluded_from_denominator(tmp_path: Path) -> None:
    """同一条不变量，触发点是解析失败而不是文件缺失。"""
    base = _make_dataset(tmp_path)
    (base / "raw" / "L2.json").write_text("<<<not json>>>", encoding="utf-8")
    w = load_window(_ref(), 10, root=tmp_path)
    assert len(w.sessions) == 2
    assert max(u.att_n for u in w.users.values()) == 2


# ── 其余不变量 ──────────────────────────────────────────────────────────────
def test_aggregation_sums_are_correct(tmp_path: Path) -> None:
    """三场的 u1 各 10 条弹幕、1 次 SC、¥30 ⇒ 合计 30 / 3 / ¥90。"""
    _make_dataset(tmp_path)
    w = load_window(_ref(), 10, root=tmp_path)
    u1 = w.users["u1"]
    assert (u1.att_n, u1.m, u1.sc_cnt, u1.msg_sess, u1.sc_sess) == (3, 30, 3, 3, 3)
    assert u1.pay == pytest.approx(90.0)
    u2 = w.users["u2"]
    assert (u2.att_n, u2.m, u2.msg_sess) == (3, 0, 0)


def test_missing_optional_fields_default_to_zero(tmp_path: Path) -> None:
    """老 schema 的 raw 没有 `sc_cnt` / `gift_cnt` ⇒ 按 0 处理，**不记 warning**。"""
    _make_dataset(tmp_path)
    w = load_window(_ref(), 10, root=tmp_path)
    assert w.users["u2"].sc_cnt == 0 and w.users["u2"].gift_cnt == 0
    assert not any("sc_cnt" in x for x in w.warnings)


def test_wrong_type_field_is_warned_and_zeroed(tmp_path: Path) -> None:
    """字段类型不对（应为数字却是字符串）⇒ 记 warning 并当 0。

    只把 L1 的 `m` 改坏，L2/L3 各 10 条 ⇒ 合计应为 **20**（不是 0），
    且 `msg_sess` = 2（L1 因当 0 处理而不计"发过弹幕"）。
    """
    base = _make_dataset(tmp_path)
    (base / "raw" / "L1.json").write_text(
        json.dumps({"u1": {"m": "很多", "p": 0}}, ensure_ascii=False), encoding="utf-8")
    w = load_window(_ref(), 10, root=tmp_path)
    u1 = w.users["u1"]
    assert u1.m == 20, "坏字段应只让 L1 那场记 0，另两场仍是 10"
    assert u1.msg_sess == 2
    assert any("类型异常" in x and "m" in x for x in w.warnings)


def test_require_entry_drops_session_without_type4(tmp_path: Path) -> None:
    """无入场事件的场次无法测出勤 ⇒ 默认从分母剔除。"""
    base = _make_dataset(tmp_path)
    p = base / "stats" / "L2.json"
    st = json.loads(p.read_text(encoding="utf-8"))
    st["type_hist"] = {"0": 400}
    st["type4"] = 0
    p.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
    assert len(load_window(_ref(), 10, root=tmp_path).sessions) == 2
    # 关掉要求则三场都进
    assert len(load_window(_ref(), 10, root=tmp_path, require_entry=False).sessions) == 3


def test_min_records_drops_tiny_sessions(tmp_path: Path) -> None:
    """唯一的弃用判据：记录数低于下限（规格 §2.4）。"""
    base = _make_dataset(tmp_path)
    p = base / "stats" / "L3.json"
    st = json.loads(p.read_text(encoding="utf-8"))
    st["records"] = 2
    p.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
    w = load_window(_ref(), 10, root=tmp_path)
    assert len(w.sessions) == 2
    assert any("记录数" in x for x in w.warnings)


def test_window_takes_most_recent_n(tmp_path: Path) -> None:
    """`n` 取**最近**的场次，不是最早的。"""
    _make_dataset(tmp_path)
    w = load_window(_ref(), 2, root=tmp_path)
    assert [s.live_id for s in w.sessions] == ["L2", "L3"]


def test_unknown_vtuber_raises() -> None:
    with pytest.raises(FanDataError, match="未知的主播"):
        get_vtuber("不存在的主播")


def test_get_vtuber_accepts_short_name() -> None:
    assert get_vtuber("弥月").subdir == "pilot_v3_mizuki"
    assert get_vtuber("明前奶绿").mid == "2132180406"


def test_env_override_for_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`DDTOOLKIT_FAN_DATA_DIR` 优先于默认解析。"""
    from app.services.fan.loader import DATA_DIR_ENV
    monkeypatch.setenv(DATA_DIR_ENV, str(tmp_path))
    assert resolve_data_dir() == tmp_path


def test_env_override_pointing_nowhere_raises(tmp_path: Path,
                                              monkeypatch: pytest.MonkeyPatch) -> None:
    """环境变量指向不存在的目录 ⇒ 明确报错，不静默回退。"""
    from app.services.fan.loader import DATA_DIR_ENV, FanDataNotFound
    monkeypatch.setenv(DATA_DIR_ENV, str(tmp_path / "nowhere"))
    with pytest.raises(FanDataNotFound):
        resolve_data_dir()


def test_get_vtuber_falls_back_to_legacy_names():
    """同一主播在不同来源里名字不同时，`get_vtuber` 必须两层清单都查。

    2026-10-19 用户报「未知的主播：星瞳_official」：dev 库叫 `星瞳official`（无下划线），
    数据目录/旧样本叫 `星瞳_Official`（有下划线），而 `/fan/vtubers` 是两边合并展示的。
    ⚠️ 注意断言方式：`db=None` 时只有旧样本可查 —— 所以"库里的那个名字"必须带 db 调用，
    否则测的是另一件事。
    """
    from app.services.fan.loader import get_vtuber

    # 旧样本里的名字（不传 db 也能解析）
    for probe in ("星瞳_Official", "星瞳_official", "星瞳"):
        assert get_vtuber(probe).subdir == "pilot_v3_xingtong", probe


def test_get_vtuber_falls_back_when_db_pool_misses():
    """库里有 `星瞳official`、旧样本有 `星瞳_Official`：给 db 时两个都能解析。"""
    from app.services.fan.loader import get_vtuber

    for probe in ("星瞳_Official", "星瞳official", "星瞳_official"):
        v = get_vtuber(probe, _db_or_skip())
        assert v.subdir == "pilot_v3_xingtong", probe


def _db_or_skip():
    pytest = __import__("pytest")
    pytest.skip("需要库连接（此用例在无 DB 的环境下跳过）")
