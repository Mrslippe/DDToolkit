"""每平台一颗「抓取总开关」（需求 9，2026-10-08，`devlog/451`）。

用户口径：「在设置中把平台抓取功能的开关做出来，放在**数据源**那一项里」＋
「开关只影响是否启动抓取」＋「全都拦住，不过用户启动手动抓取后给提示」。

这一组钉四件事：
① **默认值按平台不同**（抖音默认关 —— 协议禁止自动化；其余三家默认开 —— 那是既有行为）；
② 关掉后**两条路都拦**：手动（`capabilities.content_fetch_allowed` ⇒ 端点回 403 带原因）
   与自动（`scheduler.platform_accounts_of` ⇒ 挑不出账号、一个请求都不发）；
③ 提示要说清**去哪打开**（「设置 → 数据源 → 平台抓取」）—— 用户口径里"给提示"指的就是它；
④ 这四颗开关**在设置里的位置**（group=数据源 / section=平台抓取）是**机器判据**：
   分组改名时这条会红，逼着把文案真源一起改（`platform_switches.SETTINGS_PATH`）。
"""
import pytest

from app.core import runtime_settings
from app.services import capabilities, platform_switches


def _switches(**values):
    """把 `runtime_settings.get` 换成"只认给定值、其余回默认"的桩（真源仍是 SPECS 的默认）。"""
    real = runtime_settings.get

    def fake(key):
        if key in values:
            return values[key]
        return real(key)

    return fake


# ── ① 默认值 ──────────────────────────────────────────────────────────

def test_defaults_are_per_platform():
    """四颗开关的默认值：抖音**关**、其余三家**开**（少一条都可能把用户功能关掉）。"""
    from app.services.platform_switches import DEFAULTS

    assert DEFAULTS == {"bilibili": True, "weibo": True, "xiaohongshu": True, "douyin": False}
    # 而且**真的**和设置声明一致（不是这份表自己说了算）
    for platform, key in platform_switches.SWITCH_KEYS.items():
        assert runtime_settings.spec(key).default is DEFAULTS[platform], \
            f"{key} 的声明默认值与 platform_switches 不一致"


def test_enabled_reads_the_setting(monkeypatch):
    monkeypatch.setattr(runtime_settings, "get", _switches(WEIBO_ENABLED=False))
    assert platform_switches.enabled("weibo") is False
    assert platform_switches.enabled("bilibili") is True


def test_read_failure_falls_back_to_that_platform_default(monkeypatch):
    """★ 读设置炸了 ⇒ 退回**该平台的默认值**，不是一律 False。

    少了这一条，一次读设置异常会把四个平台**全停掉**（用户看到的是"突然什么都不抓了"）。
    """
    def boom(key):
        raise RuntimeError("设置读不动了")

    monkeypatch.setattr(runtime_settings, "get", boom)
    assert platform_switches.enabled("bilibili") is True, "默认开的平台不该被停掉"
    assert platform_switches.enabled("weibo") is True
    assert platform_switches.enabled("xiaohongshu") is True
    assert platform_switches.enabled("douyin") is False, "抖音默认关 ⇒ 仍然关（正对照）"


def test_unknown_platform_is_not_switched_off():
    """没登记的平台按**开** —— 不因为"我们没给它做开关"把功能停掉。"""
    assert platform_switches.enabled("mastodon") is True
    assert platform_switches.disabled_reason("mastodon") is None
    assert platform_switches.disabled_reason(None) is None


# ── ② 两条路都拦 + ③ 提示指向设置 ──────────────────────────────────────

def test_disabled_reason_points_to_the_settings(monkeypatch):
    monkeypatch.setattr(runtime_settings, "get", _switches(BILIBILI_ENABLED=False))
    why = platform_switches.disabled_reason("bilibili")
    assert why and "B 站" in why
    assert platform_switches.settings_path() in why, "提示必须说清去哪打开"
    assert "一个请求都不发" in why, "要如实说「关着时什么都不发」"
    # 开着的平台没有原因（正对照）
    assert platform_switches.disabled_reason("weibo") is None


def test_content_fetch_allowed_is_blocked_by_the_switch(monkeypatch):
    """★ 手动档：开关关着 ⇒ `content_fetch_allowed` 直接拒，且理由是"开关关着"。

    这就是 `_require_content_fetch` 抛给用户的那句（端点 403 的 detail），
    前端 toast 显示的就是它 —— 即用户口径里的"手动触发要**给提示**"。
    """
    monkeypatch.setattr(runtime_settings, "get", _switches(WEIBO_ENABLED=False))
    allowed, why = capabilities.content_fetch_allowed("weibo")
    assert allowed is False
    assert platform_switches.settings_path() in why
    # 正对照：同一个平台开着、且登录态齐 ⇒ 放行（否则上面那条可能只是"微博永远被拒"）
    monkeypatch.setattr(runtime_settings, "get", _switches(WEIBO_ENABLED=True))

    class _Logged:
        is_logged_in = True
        needs_login = False

    allowed2, why2 = capabilities._content_fetch_allowed_with("weibo", weibo=_Logged())
    assert (allowed2, why2) == (True, "")


def test_disabled_platform_shows_as_disabled_not_requires_login(monkeypatch):
    """能力矩阵里要报**「已关闭」**而不是「需要登录」（`devlog/338` 的教训）。"""
    monkeypatch.setattr(runtime_settings, "get", _switches(BILIBILI_ENABLED=False))
    snap = capabilities.snapshot(bili_logged_in=True, weibo_logged_in=True,
                                 xhs_logged_in=True, douyin_logged_in=True)
    bili_items = [i for i in snap["features"] if i["platform"] == "bilibili"]
    assert bili_items and all(i["state"] == capabilities.DISABLED for i in bili_items)
    assert all(platform_switches.settings_path() in i["note"] for i in bili_items)


def test_scheduler_skips_accounts_of_a_disabled_platform(monkeypatch):
    """★ 自动档：开关关着 ⇒ `platform_accounts_of` 挑不出账号（一个请求都不发）。"""
    from app.services import scheduler

    class _Acc:
        def __init__(self, platform, uid):
            self.platform, self.platform_uid = platform, uid

    accounts = [_Acc("weibo", "u1"), _Acc("bilibili", "123"), _Acc("weibo", "u2")]
    monkeypatch.setattr(runtime_settings, "get", _switches(WEIBO_ENABLED=True))
    assert len(scheduler.platform_accounts_of(accounts, "weibo")) == 2, "正对照：开着时照旧"
    monkeypatch.setattr(runtime_settings, "get", _switches(WEIBO_ENABLED=False))
    assert scheduler.platform_accounts_of(accounts, "weibo") == []
    assert len(scheduler.platform_accounts_of(accounts, "bilibili")) == 1, "别的平台不受影响"


# ── ④ 开关在设置里的位置（结构判据）────────────────────────────────────

def test_switches_live_in_the_data_source_group():
    """★ 四颗开关都在「数据源 → 平台抓取」（用户口径：放在**数据源**那一项里）。

    分组改名/搬家时这条会红 —— 那时要**同时**改 `platform_switches.SETTINGS_PATH`，
    否则提示里的指路就指向一个不存在的地方。
    """
    for key in platform_switches.SWITCH_KEYS.values():
        s = runtime_settings.spec(key)
        assert s.kind == "bool", f"{key} 必须是布尔开关"
        assert s.group == "数据源", f"{key} 应当挂在「数据源」那一组（现在 {s.group}）"
        assert s.section == "平台抓取", f"{key} 的页内小组应当是「平台抓取」（现在 {s.section}）"
    # 路径是**从上面那两条推出来的**（不是第二份字面量）⇒ 分组改名时提示自动跟上
    assert platform_switches.settings_path() == "设置 → 数据源 → 平台抓取"


def test_states_reports_every_platform(monkeypatch):
    monkeypatch.setattr(runtime_settings, "get", _switches(DOUYIN_ENABLED=True))
    st = platform_switches.states()
    assert set(st) == set(platform_switches.PLATFORMS)
    assert st["douyin"]["enabled"] is True and st["douyin"]["default"] is False
    assert st["bilibili"]["key"] == "BILIBILI_ENABLED"
