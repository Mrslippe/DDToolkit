"""**能力矩阵**：本机在"未登录 / 已登录"两态下各能用哪些功能（2026-09-15，devlog/086）。

## 为什么需要它

用户的目标是"没登录也尽可能用所有功能，并明确告知限制"。这句话要落地，必须先回答
"到底哪些能用"——**实测，不是推演**。2026-09-15 用冷进程（空数据目录 + 清空凭据）+
匿名 WBI 签名，逐个接口量了一遍，结论是**能力分三档**：

| 功能 | 未登录 | 已登录 | 实测依据 |
|---|---|---|---|
| 浏览/搜索/筛选本地归档、档案视图、日历、趋势 | ✅ 可用 | ✅ | 纯本地，零上游 |
| 第三方历史（danmakus 场次/弹幕/词云、zeroroku 粉丝历史） | ✅ 可用 | ✅ | 公开接口，与登录无关 |
| 添加 V 的**检索**（名称模糊搜 / UID 直查） | ✅ 可用 | ✅ | 匿名 `nav` 也下发 `wbi_img`；`search/type` 与 `acc/info` 匿名返回 `code=0` |
| 账号信息 / 粉丝数 / 直播状态 | ✅ 可用 | ✅ | `acc/info`、`relation/stat`、直播批量接口匿名返回 `code=0` |
| 收录 V（建库 + 抓账号信息） | ⚠️ **部分** | ✅ | 账号信息能抓；**首屏内容抓不了**（见下一行） |
| **抓投稿与动态内容** | ❌ **需要登录** | ✅ | 匿名 `arc/search` → `-352 风控校验失败`，重复几次后 **`HTTP 412 -412 request was banned`**；动态流 `polymer/.../feed/space` **直接 412** |
| 微博相关（动态抓取 / 微博账号） | ❌ **需要登录** | ✅（微博登录） | 匿名 `ajax/statuses/mymblog` → `302 passport.weibo.com/visitor` |

两条关键实测细节（都写进验收断言）：

1. `-412` 是 **IP 级**的、而且会持续一段时间（换新进程、隔 40 秒再打仍然 412）
   ⇒ **未登录时根本不该去撞内容接口**：`content_fetch_allowed()` 就是这道闸门。
2. 它**不连累登录态**：同一台机器同一时刻，登录态 `arc/search` 返回 `200 / code=0 / 5 条`。

## 这张表的口径

`FEATURES` 是**策略**（我们对外承诺什么），`tests/fixtures/capability_matrix.json` 是
**测量快照**（平台当时实际给什么）。两者由 `tests/test_capabilities.py` 双向约束：

- 实测说"匿名可用" → 策略**不得**标 `requires_login`（否则白白限制用户）；
- 实测说"匿名不可用" → 策略**必须**标 `requires_login`/`degraded`（否则会静默失败）。

平台策略会变，所以每条都带 `evidence`（含实测日期），别把它当永久事实。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

from app.services.auth import auth_manager
from app.services import wbi
from app.services.weibo_auth import weibo_auth_manager

# 三态（前端按它渲染角标；不要新增第四种而不更新前端）
FULL = "full"                      # 完整可用（与登录态无差别）
DEGRADED = "degraded"              # 能用，但**完整性或稳定性打折**（note 里说清打在哪）
REQUIRES_LOGIN = "requires_login"  # 必须登录（平台限制，不是我们没实现）
STATES = (FULL, DEGRADED, REQUIRES_LOGIN)


@dataclass(frozen=True)
class Feature:
    """一条能力：`id` 给前端做键，`label` 给人看，`note` 给用户看限制与补救。"""
    id: str
    label: str
    platform: str | None          # 依赖哪个平台的登录态；None = 不需要登录
    anon_state: str               # 未登录时的状态
    anon_note: str                # 未登录时的说明（含"登录后多什么"）
    login_note: str = ""          # 已登录时的说明（可选）
    evidence: str = ""            # 实测依据（含日期）—— 别写没量过的结论


FEATURES: tuple[Feature, ...] = (
    Feature(
        id="browse_local", label="浏览与搜索已归档内容", platform=None, anon_state=FULL,
        anon_note="列表 / 详情 / 全文搜索 / 筛选 / 归档全部可用（纯本地，不发请求）",
        evidence="纯本地读 SQLite，2026-09-15",
    ),
    Feature(
        id="archive_views", label="档案视图（直播日历 / 粉丝趋势 / 历史快照）",
        platform=None, anon_state=FULL,
        anon_note="读本地库与第三方历史，未登录同样完整",
        evidence="本地 + 第三方公开数据，2026-09-15",
    ),
    Feature(
        id="thirdparty_history", label="第三方历史（场次 / 弹幕 / 词云 / 粉丝历史）",
        platform=None, anon_state=FULL,
        anon_note="danmakus / zeroroku 是公开接口，与登录无关",
        evidence="smoke_upstream live_upstream 实测 200，2026-09-15",
    ),
    Feature(
        id="add_vtuber_search", label="添加 V 的检索（名称模糊搜 / UID 直查）",
        platform=None, anon_state=FULL,
        anon_note="未登录也能搜（平台匿名同样下发 WBI 密钥）；UID 直查走 `acc/info`，"
                  "平台偶尔对匿名请求风控，失败时会如实提示，重试或登录后稳定",
        evidence="匿名 nav 带 wbi_img；search/type 多轮实测 code=0，2026-09-15",
    ),
    Feature(
        id="account_info", label="账号信息 / 粉丝数 / 直播状态",
        platform=None, anon_state=DEGRADED,
        anon_note="未登录通常可用（粉丝数、直播状态实测稳定），但账号信息接口"
                  "`acc/info` 会被平台**间歇性风控**（实测 -352 / 412）；"
                  "失败时如实报错，不会伪装成『没有数据』",
        evidence="acc/info 匿名：一次 code=0，另一次 -352；stat/live 多轮均 code=0，2026-09-15",
    ),
    Feature(
        id="adopt_vtuber", label="收录 V（建库 + 抓该 V 的账号信息）",
        platform=None, anon_state=DEGRADED,
        anon_note="能收录并抓到账号信息与粉丝数，但**看不到它的投稿与动态**（那两项需要登录）",
        evidence="收录链路里只有内容抓取依赖登录，2026-09-15",
    ),
    Feature(
        id="fetch_posts", label="抓取投稿与动态内容", platform="bilibili",
        anon_state=REQUIRES_LOGIN,
        anon_note="B 站对匿名调用空间接口直接 412 封禁（还会波及后续请求），"
                  "所以未登录时**不发起**这类抓取；登录后可全量抓取",
        login_note="已登录：可抓投稿与动态（含首屏加速）",
        evidence="匿名 arc/search → -352 后转 412 request was banned；feed/space 直接 412，2026-09-15",
    ),
    Feature(
        id="weibo_content", label="微博内容（动态 / 账号信息）", platform="weibo",
        anon_state=REQUIRES_LOGIN,
        anon_note="微博匿名请求被跳转到登录页（302 visitor），无法读取——需要微博登录",
        login_note="已登录：微博名单正常参与动态轮次",
        evidence="匿名 mymblog → 302 passport.weibo.com/visitor，2026-09-15",
    ),
)


def _logged_in(platform: str | None, bili: bool, weibo: bool) -> bool:
    if platform is None:
        return True
    return bili if platform == "bilibili" else weibo


def snapshot(bili_logged_in: bool | None = None, weibo_logged_in: bool | None = None) -> dict:
    """当前能力快照（给 `GET /capabilities`）。两个登录态参数只为可测性，默认读真实状态。"""
    bili = auth_manager.is_logged_in if bili_logged_in is None else bili_logged_in
    weibo = ((weibo_auth_manager.is_logged_in and not weibo_auth_manager.needs_login)
             if weibo_logged_in is None else weibo_logged_in)

    items: list[dict] = []
    limited: list[dict] = []
    for f in FEATURES:
        ready = _logged_in(f.platform, bili, weibo)
        state = FULL if ready else f.anon_state
        note = (f.login_note or f.anon_note) if ready else f.anon_note
        row = {**asdict(f), "state": state, "note": note}
        items.append(row)
        if state != FULL:
            limited.append({"id": f.id, "label": f.label, "state": state, "note": note})
    return {
        "bilibili_logged_in": bili,
        "weibo_logged_in": weibo,
        "wbi": wbi.wbi_status(),
        "features": items,
        "limited": limited,
        "measured_at": MEASURED_AT,
    }


# 能力 → 实测探测点的映射（`scripts/capability_matrix.py` 的 probe 名）。
# `tests/test_capabilities.py` 用它把"策略"与"测量快照"双向对齐：
#   R1 任一探测匿名可用 ⇒ 策略不得 requires_login（不许白白限制用户）
#   R2 全部探测被**硬拒**（HTTP 412 = 封禁，非 -352 软风控）⇒ 策略必须 requires_login
PROBE_MAP: dict[str, tuple[str, ...]] = {
    "add_vtuber_search": ("search",),
    "account_info": ("info", "stat", "live"),
    "adopt_vtuber": ("info",),
    "fetch_posts": ("topic", "dynamics"),
    "thirdparty_history": (),        # 第三方站点不在 B 站矩阵里（smoke_upstream 另有检查）
    "browse_local": (),
    "archive_views": (),
    "weibo_content": (),             # 微博匿名实测在 capabilities 的 evidence 里，不在本矩阵
}


# 矩阵的实测日期（`tests/fixtures/capability_matrix.json` 同源；改结论必须重测并改这里）
MEASURED_AT = "2026-09-15"


# ── 闸门（给调度器与端点用）───────────────────────────────────────────

CONTENT_FETCH_REASON = (
    "抓投稿/动态需要登录 B 站：匿名调用空间接口会被平台风控拦截"
    "（HTTP 412 request was banned），未登录时我们**不发起**这类请求"
)


def content_fetch_allowed() -> tuple[bool, str]:
    """能不能抓**内容**（投稿 + 动态）。返回 `(允许, 原因)`。

    ⚠️ 只挡内容抓取：账号信息 / 粉丝数 / 直播状态匿名可用（见 `FEATURES`），不挡。
    """
    if auth_manager.is_logged_in:
        return True, ""
    return False, CONTENT_FETCH_REASON


def weibo_available() -> bool:
    """微博链路是否可用（未登录/失效时整条名单跳过，沿用 devlog/079 的口径）。"""
    return bool(weibo_auth_manager.is_logged_in and not weibo_auth_manager.needs_login)
