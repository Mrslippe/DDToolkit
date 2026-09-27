"""平台分支的三条真 bug（批次 4 的 ③，devlog/228）。

来源：`docs/ARCHITECTURE-IMPROVEMENT-EXECUTION.md` §1.4「调研结论回来后，第 4 阶段的顺序」
第 ③ 条 —— 三处把平台集合/口径钉死的分支。它们在只有 B 站一个平台时**看不出来**，
而"即将接入小红书与抖音"之后每一条都会变成**静默错误**（不是崩溃）：

| # | 位置 | 症状 |
|---|---|---|
| A | `capabilities._logged_in` 的 `else weibo` | 任何非 bilibili 平台都读**微博**的登录态 |
| B | `routers/vtuber.py::_require_content_fetch` 写死 B 站 | 带 `platform=weibo` 的端点被 **B 站**登录态放行/误挡（越权） |
| C | `scheduler.platform_accounts_of` / `live_sweep_core` 的 `.isdigit()` | B 站口径混进通用选号 ⇒ 微博账号被静默跳过；T0 里连 `failed` 都不计 |

⚠️ 这三条的**共同形状**：不报错、不抛异常，只是"结果少了一块"。所以判据必须钉**具体行为**
（谁能过闸门、谁被选进来、谁被计成 failed），而不是"函数不抛异常"。
"""
import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, VTuber
from app.services import capabilities as C
from app.services import scheduler as sch
from app.services.platforms import registry


# ── A：登录态映射不许"兜底成微博" ──────────────────────────────────────

def test_login_state_mapping_covers_every_feature_platform():
    """门禁：`FEATURES` 里出现的每个平台都必须在 `_login_states` 里**显式表态**。

    新增平台时这条会红 —— 这正是我们要的：逼人做决定，而不是悄悄读成别家的登录态。
    """
    known = C._login_states(True, True)
    for f in C.FEATURES:
        if f.platform is None:
            continue
        assert f.platform in known, (
            f"{f.id} 的平台 {f.platform!r} 没在 capabilities 里表态 —— "
            f"新增平台必须同时改 `_login_states`（否则会被读成别的平台的登录态）"
        )


def test_unknown_platform_does_not_inherit_weibo_state():
    """A 的判据：**两个平台都登录着**时，未知平台也不许被算作"就绪"。

    旧写法 `return bili if platform == "bilibili" else weibo` 会返回 True
    （微博登录着 ⇒ 任何别家平台都"就绪"）。
    """
    assert C._logged_in("xiaohongshu", True, True) is False, \
        "未知平台继承了微博的登录态 —— 新平台一进来就会谎报可用"
    assert C._logged_in("douyin", False, True) is False
    # 两个已知平台的口径不变
    assert C._logged_in("bilibili", True, False) is True
    assert C._logged_in("weibo", False, True) is True
    assert C._logged_in(None, False, False) is True, "None = 不依赖登录态"


# ── B：内容闸门按平台分派（越权）────────────────────────────────────────

class _Auth:
    def __init__(self, logged_in: bool, needs_login: bool = False):
        self.is_logged_in = logged_in
        self.needs_login = needs_login


def test_content_fetch_gate_is_per_platform():
    """B 的判据：**只有微博登录**时，微博内容抓取必须放行、B 站必须拦住。"""
    allowed, why = C._content_fetch_allowed_with(
        "weibo", bili=_Auth(False), weibo=_Auth(True))
    assert allowed is True, f"微博登录着却不让抓微博内容：{why}"
    allowed, why = C._content_fetch_allowed_with(
        "bilibili", bili=_Auth(False), weibo=_Auth(True))
    assert allowed is False and "B 站" in why
    # 未知平台：保守拒绝，且原因要说清"没表态"
    allowed, why = C._content_fetch_allowed_with(
        "xiaohongshu", bili=_Auth(True), weibo=_Auth(True))
    assert allowed is False and "没有" in why


def test_require_content_fetch_uses_the_requested_platform(monkeypatch):
    """B 的**端点级**判据：`_require_content_fetch("weibo")` 不许被 B 站登录态影响。"""
    from app.routers import vtuber as R

    monkeypatch.setattr(C, "auth_manager", _Auth(False))
    monkeypatch.setattr(C, "weibo_auth_manager", _Auth(True))

    with pytest.raises(HTTPException) as e:
        R._require_content_fetch("bilibili")
    assert e.value.status_code == 403

    R._require_content_fetch("weibo")     # 不抛 = 放行（修之前这里会被 B 站状态拦下）
    with pytest.raises(HTTPException):
        # 默认仍是 B 站口径：此刻 B 站没登录 ⇒ 必须 403（别把默认值改成"谁登录都放行"）
        R._require_content_fetch()


# ── C：平台选号不许拿 B 站口径当门槛 ────────────────────────────────────

def _acc(platform: str, uid: str) -> Account:
    return Account(vtuber_id=1, platform=platform, platform_uid=uid)


def test_platform_accounts_of_keeps_non_numeric_uids():
    """C1 的判据：微博 uid 不是数字 ⇒ **必须**被选中（旧写法静默跳过全部）。"""
    accounts = [_acc("weibo", "7abc"), _acc("weibo", "9xyz"), _acc("bilibili", "11073")]
    picked = sch.platform_accounts_of(accounts, "weibo")
    assert [a.platform_uid for a in picked] == ["7abc", "9xyz"], \
        "非数字 uid 被 isdigit() 挡掉了 —— 微博会永远抓不到东西"
    assert [a.platform_uid for a in sch.platform_accounts_of(accounts, "bilibili")] == ["11073"]
    # 空 uid 仍然不算可抓（那不是"平台的 uid 长得不一样"，是数据不完整）
    assert sch.platform_accounts_of([_acc("weibo", "")], "weibo") == []


def test_live_batch_adapter_filters_non_numeric_and_says_so(monkeypatch):
    """C2 的前半搬到了**适配器**里（devlog/240）：B 站批量接口要 int uid。

    非数字 uid **不发给上游**，但要**记一条日志说明原因**；核心侧再把"问了没回来"的
    一律计 failed（下一条用例端到端验）。⚠️ 两件事分开：适配器负责"为什么"，
    核心负责"不许静默"。
    """
    from app.services.platforms import bilibili as B

    seen: dict = {}

    async def fake_batch(mids, client=None):
        seen["mids"] = mids
        return {"11073": {"live_status": 0}}

    monkeypatch.setattr(B, "fetch_bilibili_live_batch", fake_batch)
    out = asyncio.run(B.fetcher.fetch_live_batch(["11073", "abc"], client=None))
    assert seen["mids"] == [11073], "非数字 uid 不该进批量接口"
    assert out == {"11073": {"live_status": 0}}


def test_live_sweep_counts_non_numeric_bilibili_uid_as_failed(monkeypatch):
    """C2 的判据（跑真函数）：T0 直播核遇到非数字 uid 的 B 站账号，**必须计进 failed**。

    旧写法是 `continue` 掉 ⇒ `result.failed` 是 0，界面显示"全部成功"，
    而那个账号永远不会出现在任何计数里（§1.4 边界②：不支持不许静默丢弃）。
    """
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Testing = sessionmaker(bind=engine)
    db = Testing()
    v = VTuber(name="直播V")
    db.add(v)
    db.commit()
    db.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid="11073"))
    db.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid="不是数字"))
    db.commit()

    monkeypatch.setattr(sch.settings, "STARTUP_LIVE_INTERVAL_MIN", 0.0)
    monkeypatch.setattr(sch.settings, "STARTUP_LIVE_INTERVAL_MAX", 0.0)

    async def fake_batch(mids, client=None):
        assert mids == [11073], "只有数字 uid 才该进批量接口"
        return {"11073": {"live_status": 0, "live_title": None,
                          "room_id": None, "live_url": None}}

    from app.services.platforms import bilibili as B
    monkeypatch.setattr(B, "fetch_bilibili_live_batch", fake_batch)
    # T0 现在从 registry 取适配器（devlog/240）：把替身装到注册表里
    monkeypatch.setitem(registry._REGISTRY, "bilibili", B.fetcher)

    result = asyncio.run(sch.live_sweep_core(db))
    assert result.success == 1
    assert result.failed == 1, "非数字 uid 的账号被静默丢弃了（failed 不计 = 界面谎报成功）"
    assert any("不是数字" in d for d in result.details), result.details
    db.close()
