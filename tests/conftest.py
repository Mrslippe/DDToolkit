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
    """每个用例前后都把风控冷却状态与动态流空闲计数清空/还原。

    R27 起冷却状态会被调度逻辑读到（恢复期拉开轮间隔）；R28 起动态流还有"连续无新帖就
    退避"的计数 —— 两者都是模块级状态，不隔离就会跨用例串台（实测：`test_dynamics_next_due_adaptive`
    的 30s 期望曾被恢复期变成 59.99s）。
    """
    saved_states = dict(sch._rl_states)
    saved_loaded = sch._rl_loaded
    saved_streak = sch._dynamics_idle_streak
    sch._rl_states.clear()
    sch._dynamics_idle_streak = 0
    yield
    sch._rl_states.clear()
    sch._rl_states.update(saved_states)
    sch._rl_loaded = saved_loaded
    sch._dynamics_idle_streak = saved_streak


@pytest.fixture(autouse=True)
def _isolate_identity_ledger():
    """每个用例前后清空**身份级额度台账**（devlog/237）。

    令牌桶的粒度是 (身份, 端点)，默认 `user_posted` 每身份 8.3s 一次 ⇒ 不隔离的话
    "上一个用例花掉了额度"会让下一个用例**静默少发一次请求**（表现是 `fetch_post_page`
    返回 None、用例断言在别处炸，排查起来极绕）。这也是生产语义：这是**进程内**状态。
    """
    from app.services import identity_limit

    identity_limit.LEDGER.reset()
    yield
    identity_limit.LEDGER.reset()


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
    # ⚠️ 小红书 / 抖音也要一起清（2026-10-05，`devlog/353`）：上面那句注释说的"开发机上恰好
    #    登录着会悄悄改变测试行为"对这两家同样成立，而它们的 cookie 就在**仓库根那份 `.env`**
    #    里。实测代价：一条考"没有 cookie 就不发请求"的用例，因为本机 `.env` 里配着小红书
    #    cookie 而拿到了真 cookie ⇒ 判据失效（那次还顺带把仓库 `.env` 写坏了，见下一条夹具）。
    from app.services.douyin_auth import douyin_auth_manager
    from app.services.xhs_auth import xhs_auth_manager

    monkeypatch.setattr(xhs_auth_manager, "cookie", "")
    monkeypatch.setattr(douyin_auth_manager, "cookie", "")


@pytest.fixture(autouse=True)
def _env_writes_go_to_a_temp_file(monkeypatch, tmp_path):
    """**测试进程写 `.env` 一律写到临时文件**，绝不碰用户那份（2026-10-05 加，`devlog/353`）。

    来由是一次真事故：一条新用例直接调了生产的 `xhs_auth.apply_cookie()`（没像同文件的
    邻居那样打桩 `save_env_keys`），而 `env_store.ENV_PATH` 在测试进程里**就是仓库根
    `.env`** ⇒ 测试字符串被真的写进去、把用户那条真 cookie 冲掉，还让"没有 cookie"的
    几条用例一起变红。

    做法是**改路径**而不是替换函数：`save_env_keys` 的行为（原子写、去重、reload）照旧是真的，
    只是落点换成了临时文件。这样"要断言 .env 真被写对了"的用例（`test_services` 里那几条）
    仍然考的是真实现 —— 第一版写成"替换成记账替身"，当场就把其中一条考红的
    （它断言 `BILI_SESSDATA=new-sess` 在文件里）。
    要自己指定落点的用例照旧 `monkeypatch.setattr(env_store, "ENV_PATH", …)`（函数级覆盖得住）。
    """
    from app.services import env_store

    monkeypatch.setattr(env_store, "ENV_PATH", tmp_path / ".env")


@pytest.fixture(autouse=True)
def _isolate_xhs_invalid_flag(monkeypatch):
    """小红书「实测已失效」标记（`xhs_auth_manager.invalidated`）不许跨用例串台。

    它是**进程内**状态，由抓取失败时的 `note_invalid()` 置上（`devlog/353`）。
    而 `tests/test_platform_xiaohongshu.py` 里那条"cookie 失效"的用例会**真的**把它点上，
    于是后面考"配置齐了就可用"的用例（`test_capabilities`）就红了 —— 这正是
    "跨用例串味"的老形态（同类先例：`_isolate_identity_ledger`、`_isolate_rate_limit_state`）。
    用 `monkeypatch` ⇒ 每个用例结束后自动还原。
    """
    from app.services.xhs_auth import xhs_auth_manager

    monkeypatch.setattr(xhs_auth_manager, "invalidated", False)
    monkeypatch.setattr(xhs_auth_manager, "_reported_invalid", False)


# 凭据类 settings 属性（`save_env_keys` 会 setattr 回写它们，见下一条夹具）
_CREDENTIAL_SETTINGS = (
    "BILI_SESSDATA", "BILI_BIJI_JCT", "BILI_DEDE_USER_ID", "BILI_BUVID_3",
    "BILI_BUVID_4", "BILI_REFRESH_TOKEN",
    # 2026-10-08（devlog/455）：web 四件套的第四件 + 这套凭据的起点 —— 都是会被
    # `_save_to_env()` 写回 `settings` 的键，漏登记就会污染后面的用例
    "BILI_DEDE_USER_ID_CKMD5", "BILI_COOKIE_SET_AT",
    "WEIBO_COOKIE", "WEIBO_UID", "WEIBO_NAME",
    "XHS_COOKIE", "XHS_COOKIE_SET_AT",
    "DOUYIN_COOKIE", "DOUYIN_COOKIE_SET_AT", "DOUYIN_UA",
)


@pytest.fixture(autouse=True)
def _credential_settings_survive_env_writes():
    """**跑过"真的落盘"的用例之后，把凭据类 `settings` 属性还回去**（2026-10-06，E1）。

    来由：扩展导入那批用例走的是**真实**的落盘路径（`xhs_auth.apply_cookie` /
    `douyin_auth.apply_cookie` / 新写的 `apply_cookie_checked`），而
    `env_store.save_env_keys()` 除了写文件，还会 `load_dotenv(override=True)` +
    `setattr(settings, key, value)`。`settings` 是**类属性** ⇒ 值会留在类上，
    **下一个测试文件**就带着"某个用例编的假凭据"跑：实测 `tests/test_auth_import.py`
    跑在 `tests/test_platform_douyin.py` 前面时，后者两条用例红在"应该是零请求却发了请求 /
    失败分类不是预期那一种"（与 `_api_token_for_test_client` 尾部那句还原同一个道理）。

    ⚠️ 断言的**行为**（`.env` 文件写没写对）不受影响 —— 那是文件，用例自己看的是临时路径。
    这里只把"用例污染了进程级配置"这件事收干净。
    """
    from app.core.config import settings

    before = {k: getattr(settings, k, None) for k in _CREDENTIAL_SETTINGS}
    yield
    for key, value in before.items():
        setattr(settings, key, value)


# ── S1：给测试里的 TestClient 统一带上会话 token（devlog/202）────────────────
#
# 为什么放在 conftest：S1 起**没配 token 就是 401**（收口后不再有"没配就放行"那一态），
# 于是所有直接 `TestClient(app)` 打真应用的用例会**集体 401** ——
# 实测第一次收口就红了 **86 条**（`KeyError: 'id'`：拿不到响应体里的 id）。
#
# 两件事必须同时成立，缺一条都会红：
#   · 进程里要有一个已知 token —— 后端才有东西可比（`TEST_API_TOKEN` ←→ `settings.API_TOKEN`）；
#   · 每个 `TestClient` 要**自动带那个头** —— 否则每个调用点都得自己写一遍，
#     而"新写的测试忘了带"就等于新测试直接红 86 条里的那一条。
#
# 做法：包一层 `TestClient.__init__`，把默认头塞进去。**只在测试进程内生效**
# （monkeypatch 会在用例结束后还原），生产代码完全不知道这件事。
TEST_API_TOKEN = "pytest-session-token"


@pytest.fixture(autouse=True)
def _api_token_for_test_client(monkeypatch):
    """进程内配一个已知 token，并让 `TestClient` 默认带上它。"""
    import os
    from app.core import api_auth
    from starlette.testclient import TestClient

    monkeypatch.setattr(api_auth.settings, "API_TOKEN", TEST_API_TOKEN, raising=False)
    monkeypatch.setattr(api_auth.settings, "DEV_API_TOKEN", "", raising=False)
    # 环境里的同名变量也要清掉：真机/探针跑完可能残留（`is_authorized` 两条路都会读），
    # 不清就会盖掉上面那个确定值。
    monkeypatch.delenv("DDTOOLKIT_API_TOKEN", raising=False)
    monkeypatch.delenv("DDTOOLKIT_DEV_API_TOKEN", raising=False)

    original_init = TestClient.__init__

    def patched_init(self, *args, **kwargs):        # noqa: ANN001 - 透传
        headers = dict(kwargs.get("headers") or {})
        headers.setdefault(api_auth.TOKEN_HEADER, TEST_API_TOKEN)
        kwargs["headers"] = headers
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(TestClient, "__init__", patched_init)
    yield
    # ⚠️ 尾部**还原成读环境变量**：`settings` 是类属性，setattr 写进类里，
    #    不还原会让**下一个测试文件**继承"已配 token"的状态而看不到真实行为。
    monkeypatch.setattr(api_auth.settings, "API_TOKEN",
                        os.getenv("DDTOOLKIT_API_TOKEN", ""), raising=False)
    monkeypatch.setattr(api_auth.settings, "DEV_API_TOKEN",
                        os.getenv("DDTOOLKIT_DEV_API_TOKEN", ""), raising=False)


# ── `/healthz` 的落盘副作用不许写进**真实数据目录**（devlog/202 收尾时发现）──────
#
# `app/main.py` 的 `/healthz` 在**首次被访问时**写 `DATA_DIR/.first-run-done`（前端靠它弹
# 首启登录浮窗）。测试里 `DATA_DIR` = 项目根（`config.py` 的默认值）⇒ 任何打 `/healthz`
# 的用例都会：① 在仓库根留下一个未跟踪文件；② **吃掉"开发态首启"那一态** ——
# 之后手动起后端时 `first_run` 恒为 false，登录浮窗不再弹。
#
# 实测（2026-09-26）：本批新写的 `tests/test_api_auth.py` 公开白名单用例就这么干了，
# 而症状只是"仓库里多了个文件" —— 与 devlog/200 那批"后台任务连了开发库"同一类：
# **用例碰了真实数据目录，而它不会红**。放在 conftest 里一次覆盖全部用例文件。
@pytest.fixture(autouse=True)
def _first_run_marker_outside_the_real_data_dir(tmp_path, monkeypatch):
    from app import main as app_main

    monkeypatch.setattr(app_main, "FIRST_RUN_MARKER", tmp_path / ".first-run-done")


# ── 轻资产落盘（`static/assets/`）在测试里一律指向 tmp_path（L1，devlog/257）────────
#
# 与上面那条同类：`assets.data_root()` 默认是 `settings.DATA_DIR`，而测试里它是**仓库根**
# （`config.py` 的默认值）⇒ 任何真的走了一次头像下载的用例都会往 `<repo>/static/assets/` 写文件。
# 这种副作用**不会红**，只会让仓库慢慢长出没人知道来源的图片（devlog/200 那批"后台任务连了
# 开发库"就是这个形态）。`data_root()` 是本模块唯一的目录来源，所以在这里一次钉死就够。
@pytest.fixture(autouse=True)
def _light_assets_outside_the_real_data_dir(tmp_path, monkeypatch):
    from app.services import assets

    monkeypatch.setattr(assets, "data_root", lambda: tmp_path)
