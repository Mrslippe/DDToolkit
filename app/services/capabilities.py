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
from app.services.douyin_auth import douyin_auth_manager
from app.services.weibo_auth import weibo_auth_manager
from app.services.xhs_auth import xhs_auth_manager

# 四态（前端按它渲染角标；新增/改动都要同步前端，见 `frontend/src/api/types.ts`）
FULL = "full"                      # 完整可用（与登录态无差别）
DEGRADED = "degraded"              # 能用，但**完整性或稳定性打折**（note 里说清打在哪）
REQUIRES_LOGIN = "requires_login"  # 必须登录（平台限制，不是我们没实现）
#: **我们自己把它关了**（有总开关的平台，如抖音 `DOUYIN_ENABLED`，devlog/338）。
#: ⚠️ 与 `requires_login` 分开：两者的**补救动作完全不同** —— 一个是去粘 Cookie，
#: 一个是去设置里打开开关。混用会让用户"粘了 Cookie 还看到『需要登录』"，以为没生效。
DISABLED = "disabled"
STATES = (FULL, DEGRADED, REQUIRES_LOGIN, DISABLED)


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
    Feature(
        id="xhs_content", label="小红书内容（笔记列表 / 详情重取）", platform="xiaohongshu",
        anon_state=REQUIRES_LOGIN,
        anon_note="小红书接口必须带签名（`a1` + `web_session`）：没配置 Cookie 时我们"
                  "**不发起**请求 —— 笔记列表抓不到、详情里的图也没法重取。"
                  "补救：设置 → 登录 → 小红书，粘贴浏览器里的整条 Cookie",
        login_note="已配置 Cookie：笔记列表与详情重取可用（重取到的图会顺手固化）",
        evidence="未配 Cookie 时签名器直接抛 Missing 'a1'（`services/platforms/signing.py`）；"
                 "且图床地址是限时签名（库内 181 个 URL 签于 10-03 00:50，10-04 13:54 全部 403），"
                 "2026-10-04",
    ),
    Feature(
        id="douyin_content", label="抖音内容（作品列表 / 详情重取）", platform="douyin",
        anon_state=REQUIRES_LOGIN,
        anon_note="抖音接口要签名，签名绑在 cookie 的 `uifid` 上（`verifyFp` 要用 `s_v_web_id` 原值）："
                  "没配置 Cookie 时我们**不发起**请求。补救：设置 → 登录 → 抖音，"
                  "粘贴浏览器里的整条 Cookie **以及那个浏览器的 `navigator.userAgent`**"
                  "（UA 会被算进签名，填错的样子是静默空数据）。"
                  "另外它还有一个**默认关着的总开关**（设置 → 数据源 → 平台抓取）",
        login_note="已配置 Cookie：作品列表与详情重取可用",
        evidence="D1 真机 14 发（`devlog/333`）：游客身份下 `a_bogus` 缺失或值写错 ⇒ "
                 "**HTTP 200 + 0 字节空体**（不是 403）；登录 jar 则完全不校验签名；"
                 "未配 Cookie / 总开关关着时适配器一个字节都不发（`services/platforms/douyin.py`），"
                 "2026-10-04",
    ),
)


def _login_states(bili: bool, weibo: bool, xhs: bool = False,
                  douyin: bool = False) -> dict[str, bool]:
    """平台 → 该平台的登录态。**唯一真源**：新增平台必须在这里加一条。

    `tests/test_platform_branches.py::test_login_state_mapping_covers_every_feature_platform`
    盯着它：`FEATURES` 里出现而这里没有的平台会判红（逼人表态，而不是悄悄读成别家）。
    """
    return {"bilibili": bili, "weibo": weibo, "xiaohongshu": xhs, "douyin": douyin}


def _logged_in(platform: str | None, bili: bool, weibo: bool, xhs: bool = False,
               douyin: bool = False) -> bool:
    """`FEATURES` 里那一项依赖的登录态是否就绪。

    ⚠️ 2026-09-27（devlog/228）：以前是 `return bili if platform == "bilibili" else weibo`
    —— **任何**非 bilibili 的平台都读**微博**的登录态。今天只有两个平台所以看不出来，
    但新平台（小红书/抖音）一进来就会读错。现在按平台**显式表态**，未知平台**不假装**就绪
    （宁可提示"未登录"，也不谎报"可用"）。
    """
    if platform is None:
        return True
    return _login_states(bili, weibo, xhs, douyin).get(platform, False)


def _disabled_reason(platform: str | None) -> str | None:
    """这个平台是不是**被我们自己的总开关关了**？是就给一句"去哪打开"。

    ⚠️ 2026-10-08（`devlog/451`）：从"只有抖音"泛化成**每平台一颗开关**，
    真源搬到 `services/platform_switches.py`（手动端点/能力矩阵/自动档共用同一份）。
    ⚠️ 状态要给 `DISABLED` 而不是 `requires_login` —— 用户看到「需要登录」会去重新粘 Cookie，
    而真正该做的是打开开关（devlog/338 的真实反馈）。
    """
    from app.services import platform_switches

    return platform_switches.disabled_reason(platform)


def snapshot(bili_logged_in: bool | None = None, weibo_logged_in: bool | None = None,
             xhs_logged_in: bool | None = None,
             douyin_logged_in: bool | None = None) -> dict:
    """当前能力快照（给 `GET /capabilities`）。登录态参数只为可测性，默认读真实状态。"""
    # ⚠️ B 站的"就绪"= **凭据在 且 没被判失效**（2026-10-08，`devlog/456`）：原先只读
    #    `is_logged_in`（= 凭据存在性），于是会话被平台吊销后矩阵照写"可用"，
    #    用户看不到任何提示；而真正的代价在闸门那边（见 `content_fetch_allowed` 的注释）。
    #    口径与微博（`and not needs_login`）、小红书（`and not invalidated`）对齐。
    bili = ((auth_manager.is_logged_in and not auth_manager.needs_login())
            if bili_logged_in is None else bili_logged_in)
    weibo = ((weibo_auth_manager.is_logged_in and not weibo_auth_manager.needs_login)
             if weibo_logged_in is None else weibo_logged_in)
    # ⚠️ 小红书的"就绪"= **配置齐了 且 没被实测判失效**（2026-10-05，`devlog/353`）：
    #    只读 `is_configured` 时，一条已经过期的 cookie 会让矩阵继续写"已配置 Cookie"，
    #    用户只能自己发现"抓不到东西"（那次实测：详情/列表/用户信息三个端点全回
    #    `HTTP 200 + code=-100 登录已过期`，而界面一个字都没说）。
    xhs = ((xhs_auth_manager.is_configured and not xhs_auth_manager.invalidated)
           if xhs_logged_in is None else xhs_logged_in)
    douyin = (douyin_auth_manager.is_configured if douyin_logged_in is None
              else douyin_logged_in)
    douyin_enabled = _douyin_enabled()

    items: list[dict] = []
    limited: list[dict] = []
    for f in FEATURES:
        ready = _logged_in(f.platform, bili, weibo, xhs, douyin)
        switched_off = _disabled_reason(f.platform)
        if switched_off:
            # **总开关关着 ⇒ `disabled`，不是 `requires_login`**（devlog/338）：
            # 如实说"是我们关的"，补救动作是去设置里打开 —— 而不是让人去重新粘 Cookie。
            ready = False
            state = DISABLED
            note = switched_off
        else:
            state = FULL if ready else f.anon_state
            note = (f.login_note or f.anon_note) if ready else f.anon_note
        row = {**asdict(f), "state": state, "note": note}
        items.append(row)
        if state != FULL:
            limited.append({"id": f.id, "label": f.label, "state": state, "note": note})
    return {
        "bilibili_logged_in": bili,
        "weibo_logged_in": weibo,
        "xiaohongshu_logged_in": xhs,
        "douyin_logged_in": douyin,
        #: 抖音总开关（默认 False）。前端据此把"未启用"与"未登录"分开说
        "douyin_enabled": douyin_enabled,
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
    "xhs_content": (),               # 小红书不在 B 站矩阵里（Cookie 口径见 xhs_auth.status）
    "douyin_content": (),            # 抖音同理（Cookie + UA 口径见 douyin_auth.status）
}


# 矩阵的实测日期（`tests/fixtures/capability_matrix.json` 同源；改结论必须重测并改这里）
MEASURED_AT = "2026-09-15"


# ── 闸门（给调度器与端点用）───────────────────────────────────────────

CONTENT_FETCH_REASON = (
    "抓投稿/动态需要登录 B 站：匿名调用空间接口会被平台风控拦截"
    "（HTTP 412 request was banned），未登录时我们**不发起**这类请求"
)

WEIBO_CONTENT_REASON = (
    "抓微博内容需要微博登录（登录态失效或被风控时整条名单跳过）"
)

#: 小红书（2026-10-04，devlog/320 的真实事故）：这条以前**没有** ——
#: `content_fetch_allowed("xiaohongshu")` 落到"未知平台"分支 ⇒ 详情的"重取媒体"对小红书
#: **永远 403**，而且理由是一句给开发者看的话（用户点了两帖，日志里两条这个）。
XHS_CONTENT_REASON = (
    "小红书内容需要 Cookie（至少 a1 与 web_session）：没配置时我们**不发起**请求 —— "
    "签名器会直接报 Missing 'a1'。补救：设置 → 登录 → 小红书，粘贴浏览器里的整条 Cookie"
)

#: 抖音（devlog/334）：与小红书同一口径的闸门 —— 签名绑在 cookie 的 `uifid` 上，
#: 没配就没得签；而"没签名硬发"的代价是**静默空数据**（200 + 0 字节，D1 实测）。
DOUYIN_CONTENT_REASON = (
    "抖音内容需要 Cookie（uifid / s_v_web_id / ttwid）与那个浏览器的 User-Agent："
    "没配置时我们**不发起**请求。补救：设置 → 登录 → 抖音，粘贴浏览器里的整条 Cookie "
    "连同 `navigator.userAgent`"
)

#: 平台**总开关**的文案真源已搬到 `services/platform_switches.py::disabled_reason`
#: （2026-10-08，`devlog/451`：从那时的"只有抖音一条"泛化成每平台一颗开关）。
#: ⚠️ 别在这里再写一份"去哪打开"的话 —— 那份路径要在设置分组改名时一起改，两份必漂。

UNKNOWN_PLATFORM_REASON = (
    "未知平台：内容抓取**没有**在这里表态（新增平台要在 "
    "`app/services/capabilities.py::content_fetch_allowed` 里显式决定匿名能不能抓）"
)


def _content_fetch_allowed_with(
    platform: str, *, bili=None, weibo=None, xhs=None, douyin=None, douyin_enabled=None,
) -> tuple[bool, str]:
    """`content_fetch_allowed` 的**可注入版本**（用例注入假登录态；生产走下面那个）。"""
    from app.services import platform_switches

    bili = auth_manager if bili is None else bili
    weibo = weibo_auth_manager if weibo is None else weibo
    xhs = xhs_auth_manager if xhs is None else xhs
    douyin = douyin_auth_manager if douyin is None else douyin
    # ⚠️ **总开关排在最前、且对每个平台都问**（2026-10-08，`devlog/451`）：
    #    关着时"我们一个请求都不发"，比"你没登录"更是用户此刻要处理的那件事；
    #    顺序反了会让人以为"配好登录就能抓"（抖音当年就是这个教训，`devlog/335`）。
    #    `douyin_enabled` 这个注入参数保留给既有用例（不传就走真源）。
    switched_off = (platform_switches.disabled_reason(platform) if douyin_enabled is None
                    else (None if douyin_enabled else platform_switches.disabled_reason("douyin")))
    if switched_off:
        return False, switched_off
    if platform == "bilibili":
        # ⚠️ **必须问"能不能用"，不能只问"凭据在不在"**（2026-10-08，`devlog/456`）：
        #    B 站是唯一一个"凭据在、但维护循环已判它失效"会同时成立的平台。原先这里只判
        #    `is_logged_in` ⇒ 会话被吊销后闸门**照样放行内容请求**，而按不变量 23，
        #    未授权的内容请求会先把平台 `-352` 激起来、再升级成 **HTTP 412 `request was banned`
        #    （IP 级、会持续）**。用户 2026-10-08 的日志里那 14 条 `-352 风控校验失败` 就是
        #    这个形状（会话 22:34 被判死，22:35 起内容请求继续发）。微博那条一直是
        #    `and not needs_login`，B 站漏了 —— 现在对齐。
        # ⚠️ B 站这个是**方法**（微博那个是 property）—— 漏括号会让条件恒假，
        #    后果是"B 站内容抓取被全部挡死"（正对照那条用例当场抓到过一次）。
        if bili.is_logged_in and not bili.needs_login():
            return True, ""
        return False, CONTENT_FETCH_REASON
    if platform == "weibo":
        if weibo.is_logged_in and not weibo.needs_login:
            return True, ""
        return False, WEIBO_CONTENT_REASON
    if platform == "xiaohongshu":
        if xhs.is_configured:
            return True, ""
        return False, XHS_CONTENT_REASON
    if platform == "douyin":
        if douyin.is_configured:
            return True, ""
        return False, DOUYIN_CONTENT_REASON
    return False, UNKNOWN_PLATFORM_REASON


def _douyin_enabled() -> bool:
    """抖音总开关（兼容入口：真源在 `services/platform_switches.py`）。

    ⚠️ 名字与语义都保留（既有用例 monkeypatch 的就是它），但它现在只是转发 ——
    新增平台**不要再往这里加分支**，改 `platform_switches.SWITCH_KEYS`。
    """
    from app.services import platform_switches

    return platform_switches.enabled("douyin")


def content_fetch_allowed(platform: str = "bilibili") -> tuple[bool, str]:
    """能不能抓 **`platform` 的**内容（投稿 + 动态）。返回 `(允许, 原因)`。

    ⚠️ 2026-09-27（devlog/228）：以前这个闸门**不带参数**、只看 B 站登录态 ——
    于是 `POST /vtuber/fetch-posts?platform=weibo` 是拿**B 站**的登录态放行/拦截的
    （B 站登录着、微博没登录 ⇒ 越权放行；反过来则误挡）。现在按平台分派。

    ⚠️ 只挡内容抓取：账号信息 / 粉丝数 / 直播状态匿名可用（见 `FEATURES`），不挡。
    """
    return _content_fetch_allowed_with(platform)


def weibo_available() -> bool:
    """微博链路是否可用（未登录/失效时整条名单跳过，沿用 devlog/079 的口径）。"""
    return bool(weibo_auth_manager.is_logged_in and not weibo_auth_manager.needs_login)
