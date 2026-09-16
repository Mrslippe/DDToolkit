# -*- coding: utf-8 -*-
"""全局测试夹具（pytest 自动发现）。

**为什么需要它**：R27（devlog/125）起，风控冷却状态是 `scheduler._rl_states`
（按平台的模块级 dict）**而且会被调度逻辑读到** —— 解禁后的恢复期会把动态流轮间隔拉开
（`_dynamics_next_due` 里的 `ramp_scale`）。于是"某个用例模拟过一次风控冷却"这件事会
留给后面的用例：实测把 `test_dynamics_next_due_adaptive` 的 `29 <= delta <= 31` 期望
变成了 60s（= 间隔被恢复期翻倍）。

R27 之前不需要这层隔离（旧的两个变量只被"读出来显示"，没人拿它做调度决策），
现在需要了 —— 放在 conftest 里一次覆盖全部用例文件，免得以后每个新用例文件都要自己记得清。
"""
import pytest

from app.services import scheduler as sch


@pytest.fixture(autouse=True)
def _isolate_rate_limit_state():
    """每个用例前后都把风控冷却状态清空/还原（含 `_rl_loaded` 标记）。"""
    saved_states = dict(sch._rl_states)
    saved_loaded = sch._rl_loaded
    sch._rl_states.clear()
    yield
    sch._rl_states.clear()
    sch._rl_states.update(saved_states)
    sch._rl_loaded = saved_loaded


@pytest.fixture(autouse=True)
def _no_ambient_login(monkeypatch):
    """把"登录态"钉成**确定的未登录**（= 全新安装的姿态）。

    为什么必须钉死：内容闸门（`capabilities.content_fetch_allowed()`）读的是**进程级**
    `auth_manager`，而它的初值来自 `settings.*` ← 环境变量 / 数据目录 `.env`。
    于是"开发机上恰好登录着"会**悄悄改变测试行为**：2026-09-16 实测，仓库根那份
    裸跑残留的 `.env` 被清空后，**4 条与本批无关的用例立刻变红**
    （`test_dynamics_lanes_group_all_accounts_by_platform` / `test_dynamics_lane_skipped_
    when_weibo_not_logged_in` / `test_update_posts_endpoint` / `test_async_fetch_first_screen_
    bounded_params`）—— 它们其实一直在考"这台机器有没有凭据"。

    需要放行的用例请**显式声明**：`monkeypatch.setattr(capabilities, "content_fetch_allowed",
    lambda: (True, ""))`，或照 `test_content_gate.py` 那样直接给 `auth_manager` 赋凭据。
    函数级 `monkeypatch` 在本夹具之后执行，所以那些写法会正常覆盖这里。
    """
    from app.services.auth import auth_manager
    from app.services.weibo_auth import weibo_auth_manager

    monkeypatch.setattr(auth_manager, "sessdata", "")
    monkeypatch.setattr(auth_manager, "bili_jct", "")
    monkeypatch.setattr(weibo_auth_manager, "cookie", "")
    monkeypatch.setattr(weibo_auth_manager, "_valid", False)
