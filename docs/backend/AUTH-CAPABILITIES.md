---
doc: backend/auth-capabilities
class: module
scope: 登录与凭据（B 站 / 微博 / 小红书 Cookie）、未登录能力矩阵与内容抓取闸门、风控与节流判定
not-scope: 抓取链路的任务模型与停止原因 → backend/FETCH-PIPELINE.md；壳侧的会话 token → desktop/SHELL.md
sot: app/services/auth.py, app/services/weibo_auth.py, app/services/xhs_auth.py, app/services/capabilities.py, app/services/identity_limit.py, app/services/rate_limit.py
verify: python scripts/capability_matrix.py
budget: 700
retire-when: 认证方式换掉扫码，或风控策略整体重做
---

## 1. 未登录能力矩阵与内容抓取闸门（2026-09-15，devlog/086）

用户要"未登录也能尽可能用所有功能，并明确告知限制"。事实边界由**实测**给出
（`scripts/capability_matrix.py`，两态逐接口、一进程一请求）：

| 能力 | 未登录 | 依据 |
|---|---|---|
| 本地浏览/搜索/筛选/归档、档案视图 | ✅ | 纯本地 |
| 第三方历史（danmakus/zeroroku） | ✅ | 公开接口 |
| 添加 V 的检索（名称模糊搜 / UID 直查） | ✅ | 匿名 `nav` 也下发 `wbi_img`；`search/type` 匿名 `code=0` |
| 账号信息 / 粉丝数 / 直播状态 | ⚠️ 间歇 | `acc/info` 实测一次 `code=0`、一次 `-352`；`stat`/`live` 稳定 |
| **抓投稿与动态内容** | ❌ **要登录** | 匿名 `arc/search` → `-352`；重复后 **412 封禁**；动态流**直接 412** |
| 微博内容 | ❌ **要登录** | 匿名 `mymblog` → `302` 登录页 |
| 小红书内容（笔记列表 / 详情重取） | ❌ **要 Cookie** | 接口必须带签名（`a1` + `web_session`），缺 `a1` 时签名器直接抛 `Missing 'a1'`（2026-10-04） |

⚠️ **新平台一进来就必须在这里表态**（2026-10-04，`devlog/321`）：小红书此前**漏了** ——
`content_fetch_allowed("xiaohongshu")` 落到"未知平台"分支 ⇒ 详情页的"重取媒体"对它**恒 403**，
理由还是一句给开发者看的话。教训有两条：① `FEATURES` / `_login_states` / 闸门**三处要一起加**
（`tests/test_platform_branches.py` 与 `tests/test_capabilities.py` 是那道门禁）；
② **别拿"已接入平台"当"未知平台"的测试样本** —— 那会把洞固化成期望行为。

三条实现纪律：

1. **`wbi` 分层**：`get_wbi_keys(allow_anonymous=…)` —— 检索路径放行匿名签名，
   **抓取路径保持严格默认**（未登录快速明确失败）；密钥来源记录在 `wbi_status()` 里。
2. **闸门在入口**（`services/capabilities.content_fetch_allowed(platform)`）：未登录时
   `async_fetch_posts` / `async_fetch_first_screen` **一次请求都不发**（返回 `login_required`），
   动态名单整条跳过（与微博名单同一套 `_lane_skip_reason`），5 个内容端点直接 **403 + 原因**。
   理由不只是省配额：匿名硬撞会把 IP 弄脏，代价由用户承担。
   ⚠️ 三家**各算各的**（`devlog/228` 起）：B 站看 `auth_manager`、微博看 `weibo_auth_manager`、
   小红书看 `xhs_auth_manager.is_configured`（Cookie 配齐没有）；没表态的平台**保守拒绝**。
3. **能力是策略，不是断言**：`services/capabilities.py::FEATURES` 是**我们承诺什么**，
   `tests/fixtures/capability_matrix.json` 是**平台当时给什么**；`tests/test_capabilities.py`
   双向约束（实测可用 ⇒ 不得标 `requires_login`；被 412 硬拒 ⇒ 必须标）——
   平台一变，用例先红，逼我们重测再改承诺。

## 认证与能力不变量

10. **凭据只落本机** `DATA_DIR/.env`（原子替换），不进仓库、不上传；

23. **未登录 ≠ 不可用，但内容抓取必须登录**（2026-09-15，devlog/086）：
    匿名 `nav` **也下发 `wbi_img`**（WBI 密钥不随登录态变）⇒ 检索/账号信息/粉丝数/直播状态
    未登录都能用；而**空间内容接口**（`arc/search`、动态 `feed/space`）匿名会被平台
    `-352` 之后 **HTTP 412 `request was banned`**（IP 级、会持续，**不连累登录态**）。
    因此：`wbi.sign_params(allow_anonymous=True)` **只给检索路径**；
    内容抓取一律过 `services/capabilities.content_fetch_allowed()` 闸门 ——
    未登录时**一次请求都不发**（`stop_reason="login_required"`，5 个内容端点 403），
    而不是"试了失败"（那会白耗配额并弄脏 IP）。能力边界由
    `scripts/capability_matrix.py` 两态实测，落 `tests/fixtures/capability_matrix.json`。


## 未登录能力边界怎么验

## 二·八、未登录能力边界（`scripts/capability_matrix.py` + `ui_probe --capabilities`）

用户口径：「未登录也尽可能用所有功能，并明确告知限制」。边界**必须实测**（devlog/086）：
```powershell
python scripts/capability_matrix.py                    # 两态 × 轻量接口，打印矩阵
python scripts/capability_matrix.py --include-content   # 额外量投稿/动态（**会触发 IP 级 412**，别勤跑）
python scripts/capability_matrix.py --write             # 刷新 tests/fixtures/capability_matrix.json
python scripts/ui_probe.py --capabilities               # 未登录现场的界面提示（数据副本删 .env）
```
结论（2026-09-15 实测）：匿名可用 = 本地归档 / 第三方历史 / **检索（名称搜、uid 直查）** / 粉丝数 / 直播状态；**内容抓取（投稿 + 动态）与微博必须登录**（匿名被 `412 request was banned`）。

> ⚠️ 两条纪律（都是踩出来的）：① **一个进程只发一条请求** —— 前一条的失败会波及后面，混在一个进程里量出来的矩阵是错的；② **匿名探测本身有代价**（会脏 IP，且**不连累登录态**，已实测），所以默认不量内容接口。冷态清凭据见 §二·六。
`--capabilities` 断言的是**两条相反**的错法：该说的没说（顶栏/说明窗/去登录缺失）与**过度限制**（受限功能被隐藏、或归档/账号信息被一起禁掉）。
