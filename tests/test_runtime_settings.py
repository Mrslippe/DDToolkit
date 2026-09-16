"""R14a 运行时设置覆盖层（devlog/091）。

判错的两个代价：
① 界面显示"已保存"而调度器还在用旧值（覆盖层没接到读取点 / 调用点把值快照住了）——
   用户改完抓取频率看不出任何变化，只能怀疑"这个开关是不是假的"；
② 越界/类型错的值被静默吞掉 —— 界面绿着，实际行为跑飞（例如间隔上限 < 下限
   会让 `sleep` 比下限还短，风控风险直接上升）。

所以这一批的断言分三层：**契约**（config ↔ SPECS 双向）、**生效**（真实调用点读到新值）、
**拒绝**（越界/未知键/跨字段一律报错，不许静默）。
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core import runtime_settings as rs
from app.core.config import Settings, settings
from app.core.database import Base, get_db
from app.main import app
from app.repositories.vtuber_repo import AppMetaRepo


@pytest.fixture(autouse=True)
def _clean_overlay():
    """每个用例前后都清空内存覆盖 —— 它是**进程级全局**，漏一条就会影响别的用例。"""
    rs.clear()
    yield
    rs.clear()


@pytest.fixture
def db():
    # ⚠️ 必须 StaticPool：内存 SQLite 的库是**每连接一份**，而 TestClient 把同步端点
    # 丢到工作线程里跑 —— 默认池会给那个线程另一条连接，于是"表不存在"（本批实测踩到）。
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture
def client(db):
    """HTTP 层：把 `get_db` 指到内存库（**不要**碰开发库），用完恢复原覆盖。"""
    prev = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    if prev is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev


# ── ① 契约：config 的类属性 ↔ SPECS（双向）──────────────────────────

def test_hot_keys_bound_both_ways():
    """`config._HOT`（会被 `__getattribute__` 拦截的键）与 `SPECS` 必须一一对应，
    且每个键在 `Settings` 上都有一个**默认值类属性**。

    少一边的坏法：只有 SPECS 没有类属性 → 没有默认值可退回；
    只有类属性不在 SPECS → 界面看不见这个键（神秘的隐藏开关）；
    两者默认值不一致 → 两份口径（一个说 3s 一个说 5s，谁生效看读法）。
    """
    import app.core.config as config
    assert set(config._HOT) == set(rs.SPECS)
    for key, spec in rs.SPECS.items():
        assert key in vars(Settings), f"{key} 在 SPECS 里但 Settings 上没有类属性（默认值没地方放）"
        assert getattr(Settings, key) == spec.default, f"{key} 类属性与 SPECS 默认值不一致"
        assert rs.get(key) == spec.default, f"{key} 没有覆盖时读到的不是默认值"


def test_instance_attribute_still_wins_over_the_overlay(db):
    """**刻意保留的后门**：测试/脚本用 `settings.X = 0` 临时提速时，实例属性优先于覆盖层。

    判错代价：这条通路被堵（例如改成 property）会让"把间隔调成 0 秒跑快一轮"这种
    最常用的调试手段失效 —— 而那种值（0）本来就该被设置界面的范围挡在外面。
    """
    rs.apply({"REQUEST_INTERVAL_MIN": 2.0})
    assert settings.REQUEST_INTERVAL_MIN == 2.0

    settings.REQUEST_INTERVAL_MIN = 0.0
    try:
        assert settings.REQUEST_INTERVAL_MIN == 0.0         # 界面范围外的值照样能用
    finally:
        del settings.__dict__["REQUEST_INTERVAL_MIN"]
    assert settings.REQUEST_INTERVAL_MIN == 2.0             # 删掉实例属性 → 覆盖层重新生效

    rs.clear()
    assert settings.REQUEST_INTERVAL_MIN == 3.0             # 再删覆盖 → 默认值


def test_defaults_are_the_values_from_before_the_overlay():
    """把类属性改成覆盖层 property 时**只搬不改**：默认值逐个对账（23 个）。

    这条是"搬迁"批次的反向保险：谁顺手调了某个默认值，测试会指出是哪一个。
    """
    expect = {
        "REQUEST_INTERVAL_MIN": 3.0, "REQUEST_INTERVAL_MAX": 5.0,
        "FETCH_BATCH_SIZE": 10, "FETCH_BATCH_COOLDOWN": 60, "RATE_LIMIT_COOLDOWN": 600,
        "MANUAL_FAST_INTERVAL_MIN": 0.5, "MANUAL_FAST_INTERVAL_MAX": 1.0,
        "DYNAMICS_BUDGET_RPM": 12, "DYNAMICS_MIN_GAP_SECONDS": 30.0,
        "DYNAMICS_MIN_CYCLE_SECONDS": 60.0, "LIVE_POLL_SECONDS": 60.0,
        # R30 静默时段：默认**关闭**（不改变既有行为，由用户显式开启）
        "QUIET_HOURS_ENABLED": False, "QUIET_HOURS_START": 3, "QUIET_HOURS_END": 9,
        "QUIET_HOURS_DYNAMICS_MIN_SECONDS": 900,
        "ACCOUNT_SWEEP_STALE_HOURS": 24.0, "ACCOUNT_SWEEP_MIN_GAP_SECONDS": 600,
        "FIRST_SCREEN_VIDEO_PAGES": 1, "FIRST_SCREEN_DYNAMICS_PAGES": 1,
        "FIRST_SCREEN_DYNAMICS_LIMIT": 3,
        "EXTERNAL_ENABLED": True, "EXTERNAL_ZEROROKU_ENABLED": True,
        "EXTERNAL_DANMAKUS_ENABLED": True,
    }
    assert {k: s.default for k, s in rs.SPECS.items()} == expect
    # 没覆盖时，property 读到的就是默认值（证明接线正确，而不是"恰好相等"）
    for key, val in expect.items():
        assert getattr(settings, key) == val, key


def test_readonly_table_does_not_list_hot_keys():
    """只读清单与可热更清单**不许重叠**：同一个键既在界面可改、又被写成"要重启"就是自相矛盾。"""
    readonly = set()
    for row in rs.readonly_info():
        readonly |= {p.strip() for p in row["key"].split("/")}
    assert not (readonly & set(rs.SPECS)), sorted(readonly & set(rs.SPECS))
    assert all(row.get("why") for row in rs.readonly_info()), "每个只读项都要说明原因"


# ── ② 生效：真实调用点读到新值（不是"内存里改了"就算数）───────────────

def test_next_round_reads_the_new_value_at_the_real_call_site():
    """**这一批的核心承诺**：改完下一轮生效、不用重启。

    走的是真实调用点 `scheduler._manual_interval`（账号间隔的唯一出口）——
    如果哪天有人把 `settings.X` 读进模块级常量（快照），这条会红。
    """
    from app.services import scheduler as sch

    rs.apply({"REQUEST_INTERVAL_MIN": 1.5, "REQUEST_INTERVAL_MAX": 1.5})
    assert [sch._manual_interval(fast=False) for _ in range(5)] == [1.5] * 5

    rs.apply({"MANUAL_FAST_INTERVAL_MIN": 0.25, "MANUAL_FAST_INTERVAL_MAX": 0.25})
    assert sch._manual_interval(fast=True) == 0.25


def test_third_party_switches_take_effect_at_their_real_call_site():
    """第三方源开关同理：`externals/runner._source_enabled` 每次运行都查一遍。"""
    from app.services.externals.danmakus import DanmakusSource
    from app.services.externals.runner import _source_enabled
    from app.services.externals.zeroroku import ZerorokuSource

    assert _source_enabled(ZerorokuSource) and _source_enabled(DanmakusSource)
    rs.apply({"EXTERNAL_ENABLED": False})
    assert not _source_enabled(ZerorokuSource) and not _source_enabled(DanmakusSource)
    rs.apply({"EXTERNAL_ENABLED": None, "EXTERNAL_DANMAKUS_ENABLED": False})
    assert _source_enabled(ZerorokuSource) and not _source_enabled(DanmakusSource)


def test_apply_replaces_memory_only_after_db_write_succeeds(db):
    """落库失败必须整体放弃：否则"界面显示改了、重启又变回去"（静默不一致）。"""
    class Boom:
        def set(self, *a, **k):
            raise RuntimeError("磁盘满了")

        def delete(self, *a, **k):
            raise RuntimeError("磁盘满了")

    import app.repositories.vtuber_repo as repo_mod
    prev = repo_mod.AppMetaRepo
    repo_mod.AppMetaRepo = lambda _db: Boom()
    try:
        with pytest.raises(RuntimeError):
            rs.apply({"FETCH_BATCH_SIZE": 7}, db)
    finally:
        repo_mod.AppMetaRepo = prev
    assert settings.FETCH_BATCH_SIZE == 10, "落库失败后内存里不该留下新值"


# ── ③ 落库与载入 ─────────────────────────────────────────────────────

def test_override_persists_to_app_meta_and_load_restores_it(db):
    rs.apply({"FETCH_BATCH_SIZE": 4, "REQUEST_INTERVAL_MIN": 1.25}, db)
    assert AppMetaRepo(db).get("settings.FETCH_BATCH_SIZE") == "4"
    assert AppMetaRepo(db).get("settings.REQUEST_INTERVAL_MIN") == "1.25"

    # 模拟"进程重启"：内存清空 → 属性和默认值一致
    rs.clear()
    assert settings.FETCH_BATCH_SIZE == 10
    assert settings.REQUEST_INTERVAL_MIN == 3.0

    rs.load(db)
    assert settings.FETCH_BATCH_SIZE == 4
    assert settings.REQUEST_INTERVAL_MIN == 1.25


def test_reset_to_default_deletes_the_row(db):
    rs.apply({"FETCH_BATCH_SIZE": 4}, db)
    rs.apply({"FETCH_BATCH_SIZE": None}, db)
    assert AppMetaRepo(db).all_with_prefix(rs.PREFIX) == {}
    assert settings.FETCH_BATCH_SIZE == 10


def test_load_skips_broken_rows_without_taking_the_process_down(db):
    """**静默失败不许装成"没数据"**：坏值/未知键要跳过并留 warning，好值照常生效。

    判错代价：一条脏数据（老版本写的键、手改过的值）让整个设置系统罢工，
    用户看到的是"我设的值全没了"，而日志里什么都没有。
    """
    repo = AppMetaRepo(db)
    repo.set(rs.PREFIX + "FETCH_BATCH_SIZE", "4")            # 好的
    repo.set(rs.PREFIX + "REQUEST_INTERVAL_MIN", "不是数字")   # 坏值
    repo.set(rs.PREFIX + "FETCH_BATCH_SIZE_FROM_FUTURE", "9")  # 未知键
    repo.set(rs.PREFIX + "LIVE_POLL_SECONDS", "99999")        # 越界

    rs.load(db)
    assert settings.FETCH_BATCH_SIZE == 4            # 好的留下了
    assert settings.REQUEST_INTERVAL_MIN == 3.0      # 坏值 → 默认
    assert settings.LIVE_POLL_SECONDS == 60.0        # 越界 → 默认
    assert "FETCH_BATCH_SIZE_FROM_FUTURE" not in rs.overrides()


# ── ④ 拒绝：越界 / 类型 / 未知键 / 跨字段 ─────────────────────────────

@pytest.mark.parametrize("key,raw", [
    ("FETCH_BATCH_SIZE", 0),            # 小于下限
    ("FETCH_BATCH_SIZE", 101),          # 大于上限
    ("FETCH_BATCH_SIZE", "abc"),        # 类型错
    ("FETCH_BATCH_SIZE", 2.5),          # int 键给小数
    ("FETCH_BATCH_SIZE", None if False else True),   # 布尔冒充数字
    ("REQUEST_INTERVAL_MIN", 0.1),
    ("RATE_LIMIT_COOLDOWN", 3601),
    ("LIVE_POLL_SECONDS", -1),
])
def test_out_of_range_or_wrong_type_is_rejected(key, raw):
    with pytest.raises(ValueError):
        rs.apply({key: raw})
    assert getattr(settings, key) == rs.SPECS[key].default, "被拒绝的值不许留下任何痕迹"


def test_unknown_key_is_rejected():
    with pytest.raises(KeyError):
        rs.apply({"NOT_A_SETTING": 1})


def test_pair_constraint_rejects_max_below_min():
    """跨字段：上限 < 下限不会被单字段范围拦住（两个值各自都合法）。

    真后果不是崩溃而是**静默走样**：`scheduler` 里
    `MIN + uniform(0, MAX - MIN)` 在 MAX<MIN 时是"减"，实际间隔比下限还短。
    """
    with pytest.raises(ValueError) as e:
        rs.apply({"REQUEST_INTERVAL_MIN": 5.0, "REQUEST_INTERVAL_MAX": 2.0})
    assert "下限" in str(e.value)
    with pytest.raises(ValueError):
        rs.apply({"MANUAL_FAST_INTERVAL_MIN": 3.0, "MANUAL_FAST_INTERVAL_MAX": 1.0})
    # 只改一个也要跟**当前生效值**对账（不能只看本次提交的两个键）
    rs.apply({"REQUEST_INTERVAL_MIN": 5.0})
    with pytest.raises(ValueError):
        rs.apply({"REQUEST_INTERVAL_MAX": 2.0})


def test_bool_accepts_the_shapes_a_ui_actually_sends():
    for raw in (True, "true", "1", "on", 1):
        rs.apply({"EXTERNAL_ENABLED": raw})
        assert settings.EXTERNAL_ENABLED is True, raw
    for raw in (False, "false", "0", "off", 0):
        rs.apply({"EXTERNAL_ENABLED": raw})
        assert settings.EXTERNAL_ENABLED is False, raw


# ── ⑤ HTTP 层 ────────────────────────────────────────────────────────

def test_get_settings_exposes_specs_and_readonly_info(client):
    body = client.get("/settings").json()
    assert len(body["specs"]) == len(rs.SPECS)
    first = body["specs"][0]
    assert {"key", "kind", "default", "min", "max", "label", "unit",
            "group", "section", "advanced", "effect", "value", "changed"} <= set(first)
    # 只读分区：版本/数据目录/端口/迁移 head 都要如实给出来
    info = body["info"]
    assert info["version"] == settings.VERSION
    assert info["migration_head"] == "f004"
    assert info["data_dir"] and info["database"]
    assert body["readonly"] and all(r.get("why") for r in body["readonly"])


# ── ⑥ 设置的"信息架构"（R21，devlog/100）─────────────────────────────
# 用户口径（2026-09-16）：「可选项太多、设置很杂，没有专业背景的用户可能不知道每一项
# 意味着什么」⇒ 导航精简到 4 项、字段按用途分小组、调优类收进「高级（默认收起）」。
# 这一组用例钉的是**判断本身**（哪些算关键项），不是排版 —— 排版由探针 `--app-settings` 量。

def test_nav_is_appearance_plus_two_categories_plus_about():
    """左栏 = 外观 + 后端大类（顺序即声明序）+ 关于。

    判错的代价：分组一多，用户又回到"六项不知道该点哪个"的老问题。
    所以这里钉死**只有两个大类**，且「抓取设置」在前（它是主战场）。
    """
    groups: list[str] = []
    for s in rs.SPECS.values():
        if s.group not in groups:
            groups.append(s.group)
    assert groups == [rs.NAV_FETCH, rs.NAV_SOURCES]
    assert len(groups) + 2 == 4          # + 外观（prefs）+ 关于（只读）


def test_vital_settings_are_visible_and_tuning_knobs_are_advanced():
    """**白名单**：普通用户该看到的 11 项 vs 收进「高级」的 9 项。

    为什么用白名单而不是数量：数量对了不代表对的项在里面 ——
    有人把「被风控后冷却」挪进高级、又放出一个「请求预算」，数量一样、体验两样。
    改这张表**必须是有意识的决定**（改完记得同步探针与 UI-MAP）。
    """
    visible = {k for k, s in rs.SPECS.items() if not s.advanced}
    advanced = {k for k, s in rs.SPECS.items() if s.advanced}
    assert visible == {
        # 抓取设置（11 项：风控与节流 3 + 开播 1 + 动态 1 + 静默时段 3 + 每日 1 + 收录首屏 2）
        "REQUEST_INTERVAL_MIN", "REQUEST_INTERVAL_MAX", "RATE_LIMIT_COOLDOWN",
        "LIVE_POLL_SECONDS", "DYNAMICS_MIN_CYCLE_SECONDS",
        # R30：静默时段是"用户自己决定睡觉时不打扰"，属于用户该看到的决策（默认关闭）
        "QUIET_HOURS_ENABLED", "QUIET_HOURS_START", "QUIET_HOURS_END",
        "ACCOUNT_SWEEP_STALE_HOURS", "FIRST_SCREEN_VIDEO_PAGES",
        "FIRST_SCREEN_DYNAMICS_LIMIT",
        # 数据源（3 个开关：总闸 + 两个上游）——它们是"要不要用这个源"的决策，不该藏
        "EXTERNAL_ENABLED", "EXTERNAL_ZEROROKU_ENABLED", "EXTERNAL_DANMAKUS_ENABLED",
    }
    assert advanced == {
        "FETCH_BATCH_SIZE", "FETCH_BATCH_COOLDOWN",
        "DYNAMICS_BUDGET_RPM", "DYNAMICS_MIN_GAP_SECONDS",
        "QUIET_HOURS_DYNAMICS_MIN_SECONDS",       # R30：静默期"降到多慢"属于调优
        "ACCOUNT_SWEEP_MIN_GAP_SECONDS", "FIRST_SCREEN_DYNAMICS_PAGES",
        "MANUAL_FAST_INTERVAL_MIN", "MANUAL_FAST_INTERVAL_MAX",
    }
    assert visible | advanced == set(rs.SPECS)      # 没有第三个去处


def test_every_spec_has_a_section_and_pairs_are_never_split():
    """① 每个键都得有小组标题（否则它会掉进"无标题区"，用户不知道它属于什么）；
    ② **成对的上下限必须同组、同折叠态** —— 拆开就会出这种事：
       「上限」被收进高级、用户改了「下限」却看不到上限，而后端的"上限 < 下限"校验
       只会在点保存时以 400 出现，界面事前那个红字提示（同源预校验）就没了。
    """
    for s in rs.SPECS.values():
        assert s.section, f"{s.key} 没有 section —— 它会掉进无标题区"

    by_key = rs.SPECS
    for constrained, depends_on, why in rs.PAIRS:
        a, b = by_key[constrained], by_key[depends_on]
        assert (a.section, a.advanced) == (b.section, b.advanced), (
            f"{why}：{constrained} 与 {depends_on} 必须同组同折叠态"
            f"（现在 {a.section}/{a.advanced} vs {b.section}/{b.advanced}）")


def test_put_settings_saves_then_reset_clears(client, db):
    r = client.put("/settings", json={"values": {"FETCH_BATCH_SIZE": 3}})
    assert r.status_code == 200, r.text
    assert r.json()["values"] == {"FETCH_BATCH_SIZE": 3}
    assert settings.FETCH_BATCH_SIZE == 3
    assert client.get("/settings").json()["overrides"] == {"FETCH_BATCH_SIZE": 3}

    r = client.post("/settings/reset")
    assert r.status_code == 200
    assert settings.FETCH_BATCH_SIZE == 10
    assert AppMetaRepo(db).all_with_prefix(rs.PREFIX) == {}


def test_put_settings_400_with_reason(client):
    """越界/未知键必须 400 + 中文原因 —— 前端把 detail 直接显示给用户。"""
    r = client.put("/settings", json={"values": {"FETCH_BATCH_SIZE": 999}})
    assert r.status_code == 400
    assert "不能大于" in r.json()["detail"]

    r = client.put("/settings", json={"values": {"NOPE": 1}})
    assert r.status_code == 400
    assert "不认识" in r.json()["detail"]

    r = client.put("/settings", json={"values": {"REQUEST_INTERVAL_MIN": 5.0,
                                                 "REQUEST_INTERVAL_MAX": 1.0}})
    assert r.status_code == 400
    assert "下限" in r.json()["detail"]

    r = client.put("/settings", json={"values": {}})
    assert r.status_code == 400
    assert settings.FETCH_BATCH_SIZE == 10, "被拒绝的请求不许改动任何设置"


# ── ⑥ 界面偏好：主题（R14b，devlog/092）──────────────────────────────

def test_prefs_theme_roundtrip_and_persist(client, db):
    assert client.get("/settings/prefs").json()["values"]["theme"] == "light"
    r = client.put("/settings/prefs", json={"values": {"theme": "system"}})
    assert r.status_code == 200, r.text
    assert r.json()["values"]["theme"] == "system"
    assert AppMetaRepo(db).get("prefs.theme") == "system"      # **真的落库了**
    assert client.get("/settings/prefs").json()["values"]["theme"] == "system"
    # 回默认（null = 删行）
    assert client.put("/settings/prefs", json={"values": {"theme": None}}).status_code == 200
    assert AppMetaRepo(db).all_with_prefix("prefs.") == {}
    assert client.get("/settings/prefs").json()["values"]["theme"] == "light"


def test_prefs_rejects_values_outside_the_whitelist(client, db):
    """枚举白名单在后端：`dark` 还没实现，直接写进来必须是 400 而不是"存下但不生效"。"""
    for body in ({"values": {"theme": "dark"}},
                 {"values": {"theme": "DARK"}},
                 {"values": {"nope": "light"}},
                 {"values": {}}):
        r = client.put("/settings/prefs", json=body)
        assert r.status_code == 400, body
    assert AppMetaRepo(db).all_with_prefix("prefs.") == {}


def test_prefs_empty_string_is_reset_not_a_value(client, db):
    """空串与 `null` 同义（回默认）—— 两个入口的语义必须一致，否则界面清空会存进空值。"""
    client.put("/settings/prefs", json={"values": {"theme": "system"}})
    r = client.put("/settings/prefs", json={"values": {"theme": ""}})
    assert r.status_code == 200
    assert r.json()["values"]["theme"] == "light"
    assert AppMetaRepo(db).all_with_prefix("prefs.") == {}


def test_prefs_corrupt_stored_value_falls_back_without_crashing(client, db):
    """库里存了白名单外的值（旧版本写的/手改的）→ 用默认值，**不报错也不覆盖用户数据**。

    判错代价：设置窗口因为一行脏偏好打不开，用户看到的是"设置没了"。
    """
    AppMetaRepo(db).set("prefs.theme", "neon")
    r = client.get("/settings/prefs")
    assert r.status_code == 200
    assert r.json()["values"]["theme"] == "light"
    assert AppMetaRepo(db).get("prefs.theme") == "neon"        # 原样留着，不静默改写


def test_prefs_close_action_whitelist(client, db):
    """关闭语义（R18）：默认 `ask`（首次点 ✕ 问一次），只认三个取值。

    判错代价：写进一个后端不认的值 → 前端读到默认值，用户"记住的选择"每次都白问；
    或者更糟：值被存下来但没人解释，行为变成随机的。
    """
    body = client.get("/settings/prefs").json()
    assert body["values"]["close_action"] == "ask"
    spec = [s for s in body["specs"] if s["key"] == "close_action"]
    assert spec and [o["value"] for o in spec[0]["options"]] == ["ask", "tray", "quit"]
    for ok in ("tray", "quit", "ask"):
        r = client.put("/settings/prefs", json={"values": {"close_action": ok}})
        assert r.status_code == 200, r.text
        assert r.json()["values"]["close_action"] == ok
        assert AppMetaRepo(db).get("prefs.close_action") == ok
    r = client.put("/settings/prefs", json={"values": {"close_action": "minimize"}})
    assert r.status_code == 400
    assert AppMetaRepo(db).get("prefs.close_action") == "ask"   # 没被改脏


def test_user_facing_copy_has_no_markdown_markers():
    """后端下发的文案（label / unit / effect / note / why / option）是**纯文本**，
    前端原样渲染。

    判错的代价（2026-09-15 用户截图反馈）：`DYNAMICS_MIN_CYCLE_SECONDS` 的说明里写了
    `按轮**开始**计时`、`close_action` 的说明里写了 `**后台抓取照常进行**`，
    设置窗口就把星号一起显示出来了。这类错误在源码里很难肉眼发现（注释里到处是 `**`），
    所以这里扫的是**数据字段**：SPECS / 只读表 / prefs 规格表。
    """
    from app.core import runtime_settings as rs
    from app.routers.settings import prefs_specs
    ticks = chr(96)                      # 反引号：同样会原样显示
    offenders: list[str] = []

    def check(where: str, value: object) -> None:
        if isinstance(value, str) and (("**" in value) or (ticks in value)):
            offenders.append(f"{where} = {value!r}")

    for spec in rs.SPECS.values():
        for field in ("label", "unit", "effect", "note", "section"):
            check(f"SPECS[{spec.key}].{field}", getattr(spec, field))
    for row in rs.readonly_info():
        for field in ("label", "why"):
            check(f"READONLY[{row.get('key')}].{field}", row.get(field, ""))
    for body in prefs_specs():
        for field in ("label", "note"):
            check(f"PREFS[{body.get('key')}].{field}", body.get(field, ""))
        for opt in body.get("options", []):
            check(f"PREFS[{body.get('key')}].option", opt.get("label", ""))
    assert not offenders, ("用户可见文案里混进了 Markdown 标记（界面会原样显示）：\n  "
                           + "\n  ".join(offenders))


def test_dark_theme_hook_flag_matches_what_the_ui_tells_users():
    """**跨语言契约**：前端 `utils/theme.ts::DARK_IMPLEMENTED` 与后端下发的说明必须一致。

    两边的坏法都很难看：钩子还是 false 却不说"尚未实现" → 用户以为「跟随系统」坏了；
    深色已经能做却仍写着"尚未实现" → 用户根本不会去试。
    所以这条把 TS 里的那个布尔与 `/settings/prefs` 的 note 绑在一起：改一边不改另一边就红。
    """
    import re
    from pathlib import Path
    from app.routers.settings import _theme_note
    ts = Path(__file__).resolve().parent.parent / "frontend" / "src" / "utils" / "theme.ts"
    m = re.search(r"DARK_IMPLEMENTED\s*=\s*(true|false)", ts.read_text(encoding="utf-8"))
    assert m, "theme.ts 里找不到 DARK_IMPLEMENTED（钩子被删了？深色边界要重新声明）"
    implemented = m.group(1) == "true"
    note = _theme_note()
    assert ("尚未实现" in note) != implemented, (
        f"DARK_IMPLEMENTED={implemented} 与用户看到的说明 {note!r} 不一致")


# ── ⑦ 存储占用与维护（R22-B，devlog/104）──────────────────────────────

def test_storage_endpoint_reports_each_group_and_disk(client):
    """「关于」页要能回答"谁在占地方"：四组占用 + 缓存上限 + 磁盘余量 + 遗留备份。"""
    body = client.get("/settings/storage").json()
    assert set(body["groups"]) == {"database", "img_cache", "logs", "other"}
    for name, g in body["groups"].items():
        assert g["bytes"] >= 0 and g["files"] >= 0, name
    assert body["total_bytes"] >= 0
    assert body["disk"]["total"] > 0               # 真问了一次磁盘
    assert body["img_cache"]["max_bytes"] > 0      # 上限要显示出来，否则"占用大不大"没有参照
    assert isinstance(body["stale_backups"], list)
    assert isinstance(body["low_space"], bool)
    assert body["low_space_threshold_bytes"] == 5 * 1024 ** 3
    assert body["data_dir"] and body["database"]


def test_storage_prune_cache_clears_and_reports(client, tmp_path, monkeypatch):
    """清缓存按钮：口径是**全清**，且要如实告诉用户释放了多少。"""
    from app.routers import img_proxy

    cache = tmp_path / "img-cache"
    cache.mkdir()
    (cache / "a.bin").write_bytes(b"x" * 400)
    (cache / "a.json").write_text('{"fetched_at": 1}', encoding="utf-8")
    monkeypatch.setattr(img_proxy, "CACHE_DIR", cache)

    body = client.post("/settings/storage/prune-cache").json()
    assert body["files"] == 1 and body["bytes"] == 400
    assert list(cache.glob("*")) == []
    # 顺手把最新占用带回来 —— 免得界面为了刷新数字再打一次接口
    assert "storage" in body


def test_storage_maintenance_reclaims(client):
    """整理库：回收 WAL + 还盘，返回值要能让界面说清"省了多少"。"""
    body = client.post("/settings/storage/maintenance").json()
    assert body["wal_after"] <= body["wal_before"]
    assert body["freed_pages"] >= 0
    assert "storage" in body
    assert body["storage"]["img_cache"]["files"] >= 0
