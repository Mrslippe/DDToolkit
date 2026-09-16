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
