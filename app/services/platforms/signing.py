"""平台请求**签名器**的接口（第 4 阶段 ④，devlog/230、232；抖音 D2，devlog/334）。

调研结论（`docs/design/xhs-douyin-research.md` §1.1、§2.3）：两家的签名都**已被开源纯 Python
复刻**，所以本地签、浏览器只在"身份过期/被风控"时兜底 —— 但**两家的签名策略不该共用**：

- **小红书**：mnsv2（`x-s` / `x-t` / `x-s-common`），依赖 MIT 的 [`xhshow`](https://github.com/Cloxl/xhshow)
  （**已进 `pyproject.toml` + `uv.lock`**，devlog/232）。签名里打包了**行为计数器**
  （点击/停留时长），纯协议爬虫计数器恒定即被识别 —— 这是这套方案**固有的**风险，不是实现 bug。
- **抖音**：`a_bogus`（bdms 字节码 VM 复刻，**已 vendor**：`vendor/dtksign/`，Apache-2.0）
  + `x-secsdk-web-signature`（一个 md5）+ `x-tt-argus`。⚠️ **形状与小红书不同**：抖音签的是
  **查询串**（`a_bogus` / `verifyFp` / `fp` / `uifid` / `timestamp` / `x-secsdk-web-signature`
  六个都在 query 里，头只有三个）⇒ 所以它有独立的 `sign_query()`，见 `DouyinSigner`。

## 抖音真机口径（D1 spike，`devlog/333`）

| 事实 | 影响 |
|---|---|
| 游客身份下 `a_bogus` **缺失或值写错** ⇒ **HTTP 200 + 0 字节空体** | 签名是硬要求，且失效**不是** 403 ⇒ 抓取侧必须把"200 + 空体"当失败（`douyin.py` 的 `classify_http`）|
| 登录身份（含 `sessionid`）**完全不校验签名** | 宽松是平台当下的选择、不是契约 ⇒ 代码里**不许**依赖它 |
| secsdk 三件套 / `x-tt-argus` / `msToken` 都**不是必需** | 仍然全发：少发一个就少一层"像浏览器"，而省下来的成本是零 |

⚠️ **签名器不在（或平台改版）时必须"响亮地失败"**：静默发一个没签名的请求会被风控记一笔，
而且线上查不出来（这正是调研 §1.1 说的"签名悄悄失效、数据静默变空"）。所以这里定义了
`SignerUnavailable`，由调用方转成**结构化失败**（调研 §1.3 第 4 条）。

## 接口形状：`uri` + 结构化参数（不是拼好的 query 串）

`xhshow` 的 `sign_headers_get(uri, cookies, params=…)` 收的是 **path + 参数字典**
（2026-09-27 实测签名，v0.2.0），所以本协议照它的形状定义 —— 拼 query 是**调用方**的事
（且必须与签名时同一组键值，见 `xiaohongshu.py` 里"逗号不编码"那条）。
抖音那条反过来：**签名产出的就是 query**（`sign_query()`），调用方把业务参数交进来、拿整串走。
"""
from __future__ import annotations

import logging
import random
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Protocol
from urllib.parse import quote, unquote, urlencode

logger = logging.getLogger(__name__)

from app.services.platforms.shadow import (SHADOW_KEY, SHADOW_KEY_DOUYIN, Comparison,
                                           ShadowProbe, douyin_stable_constants,
                                           xhs_stable_constants)

#: 抖音 `msToken`（**请求参数**，不是 cookie）的形状：`A-Za-z0-9+-` 取 126 个再补 `==`。
MS_TOKEN_PARAM = "msToken"
MS_TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-"
MS_TOKEN_LENGTH = 126
#: a_bogus 结构自检的**重签**次数（见 `DouyinSigner._selfchecked_bogus`：解码器有约 1/300 的
#: 已知歧义 ⇒ 重签能换掉噪声；这不是"硬闸门"，硬停只留给"这根本不是 a_bogus"那一类）
SELFCHECK_TRIES = 3


def gen_false_ms_token(length: int = MS_TOKEN_LENGTH, *,
                       rng: Optional[random.Random] = None, suffix: str = "==") -> str:
    """本地造一个 `msToken`（DTK 同款形状）。⚠️ D1 实测**它可省**（去掉照样 20 条），
    但浏览器的每个请求都带它 ⇒ 带上更接近浏览器，成本为零。"""
    source = rng or random.Random()
    return "".join(source.choice(MS_TOKEN_ALPHABET) for _ in range(length)) + suffix


class SignerUnavailable(RuntimeError):
    """签名器不可用（库没装 / 版本不兼容 / 平台改版）—— **不许静默降级**。"""


class Signer(Protocol):
    """把「方法 + 路径 + 参数 + 身份」变成一组要附上的请求头。"""

    platform: str

    def headers(
        self,
        *,
        method: str,
        uri: str,
        params: Optional[dict[str, Any]] = None,
        payload: Optional[dict[str, Any]] = None,
        cookies: str = "",
    ) -> dict[str, str]:
        ...


class NullSigner:
    """不签名（抖音的**非白名单**路径用；测试里当替身）。"""

    platform = "*"

    def headers(self, *, method: str, uri: str, params: Optional[dict[str, Any]] = None,
                payload: Optional[dict[str, Any]] = None,
                cookies: str = "") -> dict[str, str]:
        return {}


class XhsSigner:
    """小红书签名器：`xhshow`（**已进锁文件**）。

    ⚠️ 这是全仓**唯一一个"平台改版即失效"的依赖**。失效时的表现是
    `SignerUnavailable`（响亮失败）—— 升级依赖，或按调研 §1.1 的兜底路线
    （浏览器只铸/签一次）处理；**不要**改成"没签名也发"。

    ## 影子比对（调研 §3.4.1，devlog/237）

    每次签名后按 600s 抽样：**同一个请求连签两次**，比"噪声碰不到的常量"
    （三个签名头在不在、`x-s` 前缀形状、`x-s-common` 长度档位）。
    ⚠️ 这只抓得住**结构回归**（依赖升级后头少了 / 形状变了），抓不住"签名被服务端拒绝"
    —— 后者要靠抓取侧的响应分类（`identity_limit.py`）。比不出来时**绝不禁用**本地签名。
    """

    platform = "xiaohongshu"

    def __init__(self, probe: "ShadowProbe | None" = None) -> None:
        self._sign = None  # 懒加载后缓存（构造时不 import，避免拖慢启动）
        # 影子比对：**不 import 平台库**的纯逻辑（见 shadow.py）
        self._probe = probe if probe is not None else ShadowProbe()
        self.last_comparison: "Comparison | None" = None

    def _load(self):
        if self._sign is not None:
            return self._sign
        try:
            from xhshow import Xhshow  # type: ignore[import-not-found]
        except Exception as e:  # noqa: BLE001 —— 任何导入失败都算"不可用"
            raise SignerUnavailable(
                "小红书签名器不可用：`xhshow` 没装上（它已在 uv.lock 里，跑 `uv sync` 即可）。"
                "⚠️ 不要退回未签名的请求 —— 那会被风控记一笔且线上查不出来。"
            ) from e
        self._sign = Xhshow()
        return self._sign

    def _sign_once(self, *, method: str, uri: str, params: Optional[dict[str, Any]],
                   payload: Optional[dict[str, Any]], cookies: str) -> dict[str, str]:
        """签一次（主路径与影子路径**共用**这个函数：只有真签名器才谈得上比对）。"""
        signer = self._load()
        try:
            if method.upper() == "GET":
                out: Any = signer.sign_headers_get(uri, cookies, params=dict(params or {}))
            else:
                out = signer.sign_headers_post(uri, cookies, payload=dict(payload or {}))
        except Exception as e:  # noqa: BLE001 —— 库内部炸了同样算不可用
            raise SignerUnavailable(f"小红书签名失败（xhshow 内部错误）：{e}") from e
        return {k: str(v) for k, v in dict(out or {}).items()}

    def headers(self, *, method: str, uri: str, params: Optional[dict[str, Any]] = None,
                payload: Optional[dict[str, Any]] = None,
                cookies: str = "") -> dict[str, str]:
        out = self._sign_once(method=method, uri=uri, params=params,
                              payload=payload, cookies=cookies)
        self._maybe_shadow(out, method=method, uri=uri, params=params, payload=payload,
                           cookies=cookies)
        return out

    def _maybe_shadow(self, primary_headers: dict[str, str], *, method: str, uri: str,
                      params: Optional[dict[str, Any]], payload: Optional[dict[str, Any]],
                      cookies: str) -> None:
        """到点才比（`probe.due`）。**主侧复用刚签出来的那一份** —— 抽样只多花一次签名，
        且判定的就是"这次真的发出去的那组头"。结果只用于告警，不影响本次返回值。"""
        if not self._probe.due(SHADOW_KEY):
            return
        kwargs = dict(method=method, uri=uri, params=params, payload=payload,
                      cookies=cookies)
        self.last_comparison = self._probe.compare(
            SHADOW_KEY,
            primary=lambda: primary_headers,
            shadow=lambda: self._sign_once(**kwargs),
            stable=xhs_stable_constants,
        )


# ── 抖音（第 4 阶段 ④ 第二刀，devlog/334）────────────────────────────────

@dataclass(frozen=True)
class SignedQuery:
    """抖音一次签名的结果：**查询串 + 三个头**（头里只有 uifid 与 secsdk 那两个）。"""

    query: str
    headers: dict[str, str] = field(default_factory=dict)


class DouyinSigner:
    """抖音签名器：vendored 的 `a_bogus`（Apache-2.0）+ secsdk 的 `md5`（`devlog/333`）。

    ⚠️ **形状与 `Signer` 协议不同**：抖音签的是**查询串** —— `a_bogus`、`verifyFp`、`fp`、
    `uifid`、`timestamp`、`x-secsdk-web-signature` 六个都在 query 里。所以这里不实现
    `Signer.headers()`，而是 `sign_query()`：**业务参数进、整条 query 出**。
    顺序是平台的（真机抓包逐字节对过）：业务参数 → `a_bogus` → `verifyFp`/`fp` → secsdk。

    `user_agent` 必须是**那份 cookie 的浏览器**的 UA（a_bogus 把它算进签名）：
    不一致的后果就是 200 + 空体，而不是报错。

    ## 影子比对：比"两次签名是否同样自洽"

    抖音这边没有第二个实现可比（DTK 的浏览器兜底没接），所以比的是**结构常量**：
    六个参数/三个头在不在、`a_bogus` 过不过 `structure_error()`（格式自带的校验和）、
    长度档位、secsdk 是不是 32 位十六进制。它能抓住**不稳定**（噪声展开有 bug 时，
    签名会时好时坏 —— 两次比对立刻现形）与**结构回归**（参数/头少了）。
    ⚠️ 它**抓不到**"算法整体失效"：两次都坏得一样 ⇒ 比出来是"一致"。
    那一条靠**发请求之前的结构自检**（`sign_query` 里 `structure_error` 不为 None 就
    `SignerUnavailable`）+ 抓取侧的响应分类（200 + 空体 ⇒ `signature_invalid`）。
    """

    platform = "douyin"

    def __init__(self, user_agent: str, browser_info: str = "",
                 probe: "ShadowProbe | None" = None, rng: Optional[random.Random] = None) -> None:
        self._ua = user_agent
        self._browser_info = browser_info
        self._rng = rng
        self._probe = probe if probe is not None else ShadowProbe()
        self.last_comparison: Optional[Comparison] = None

    # ── 只读属性：适配器换 UA 时要能拿到"当前用的那份"并据此重建（别去掏私有字段）──
    @property
    def user_agent(self) -> str:
        return self._ua

    @property
    def probe(self) -> "ShadowProbe":
        return self._probe

    @property
    def rng(self) -> Optional[random.Random]:
        return self._rng

    # ── 内部 ──
    def _bogus(self, query: str, *, body: str = "", content_type: str = "") -> str:
        from app.services.platforms.vendor import dtksign

        ua = (self._ua or "").strip()
        if not ua:
            # 没 UA 就没法签：a_bogus 把 UA 算进第三个摘要（`abogus.py` 的 `user_agent_digest`）
            raise SignerUnavailable("抖音签名器需要 User-Agent（a_bogus 会把它算进签名）")
        kwargs = {"browser_info": self._browser_info} if self._browser_info else {}
        if self._rng is not None:
            kwargs["rng"] = self._rng
        return dtksign.ABogus(ua, **kwargs).get_value(query, body=body, content_type=content_type)

    def _sign_once(self, params: Mapping[str, str], cookies: Mapping[str, str],
                   body: str, fill_ms_token: bool = True) -> SignedQuery:
        """签一次（主路径与影子路径**共用**）。"""
        from app.services.platforms.vendor import dtksign

        uifid = dtksign.pick_uifid(cookies)          # uifid / UIFID_TEMP / 各种大小写
        if not uifid:
            raise SignerUnavailable(
                "抖音签名器需要 cookie 里的 uifid（或 UIFID_TEMP）：secsdk 的签名绑在它上面")
        ordered = dict(params)
        if fill_ms_token and not ordered.get(MS_TOKEN_PARAM):
            # 抖音的 `msToken` 是**请求参数**（不在 cookie jar 里，D1 抓包实测 184 字节）。
            # 优先用调用方/身份给的，否则本地造一个 —— DTK 实测造的真的一样能用（devlog/333）。
            ordered[MS_TOKEN_PARAM] = (cookies.get(MS_TOKEN_PARAM)
                                       or gen_false_ms_token(rng=self._rng))
        # ① 业务参数 → ② a_bogus（把它算进 query 之后再签 secsdk）
        query = urlencode(list(ordered.items()))
        bogus = self._selfchecked_bogus(query, body=body)
        query = f"{query}&a_bogus={quote(bogus, safe='')}"
        # ③ verifyFp/fp 是 cookie 里 s_v_web_id 的原值（自造 ⇒ 真机实测 200+空体）
        pairs = [_split_pair(part) for part in query.split("&") if part]
        verify_fp = str(cookies.get(dtksign.VERIFY_FP_COOKIE) or "")
        if verify_fp:
            for name in ("verifyFp", "fp"):
                pairs.append((name, verify_fp))
        # ④ secsdk：签的是"到目前为止的整条 query"（含 a_bogus 与 verifyFp/fp）
        signed, signature, headers = dtksign.sign(pairs, uifid)
        headers[dtksign.SIGNATURE_PARAM] = signature
        return SignedQuery(query=signed, headers=headers)

    def _selfchecked_bogus(self, query: str, *, body: str) -> str:
        """算 a_bogus，并用 vendored 的结构校验器**分级**处理自检结果（devlog/334）。

        ⚠️ **不能把自检当硬闸门**。实测（2026-10-04，300 条签名）：`structure_error` 会以
        **约 1/300** 的概率对我们**自己刚签出来的**签名报
        `declared lengths overrun the frame` —— 那是**解码器的已知歧义**
        （噪声展开会在末尾补一组，解码时那两字节与真实数据不可区分；DTK 自己的注释就写了
        "give or take the two bytes"），**不是签名坏了**。把它当硬闸门 ⇒ 每 300 次静默少发一发，
        而且报的还是"签名器与平台对不上"这种吓人的话。

        所以按 DTK 自己的口径分级（`is_decode_problem`）：

        | 自检结论 | 处置 |
        |---|---|
        | 通过 | 直接用 |
        | `alphabet` / 长度不是 4 的倍数 / payload 太短 ⇒ **这根本不是 a_bogus** | **硬停**（`SignerUnavailable`，一个字节都不发）|
        | 其它（内容不符预期，如上） | **重签**再试（换一批噪声）；`SELFCHECK_TRIES` 次都不行就**照发**并 warning —— 平台才是权威，真不认会回 200+空体（抓取侧归 `signature_invalid`）|
        """
        from app.services.platforms.vendor import dtksign

        problem: str | None = None
        bogus = ""
        for attempt in range(1, SELFCHECK_TRIES + 1):
            bogus = self._bogus(query, body=body)
            problem = dtksign.structure_error(bogus)
            if problem is None:
                return bogus
            if dtksign.is_decode_problem(problem):
                # 我们产出的**不是一条 a_bogus**：字节表/算法已经坏了，发出去只会白挨一次风控
                raise SignerUnavailable(
                    f"抖音 a_bogus 不是一条合法签名（{problem}）—— 签名器与平台已对不上，"
                    f"本次不发请求（见 vendor/dtksign/NOTICE.md 的升级路线）")
            logger.warning("抖音 a_bogus 结构自检第 %d/%d 次报「%s」，重签再试",
                           attempt, SELFCHECK_TRIES, problem)
        logger.warning("抖音 a_bogus 连续 %d 次自检都报「%s」—— 按**解码器已知歧义**处理，"
                       "照发；平台若真不认会回 200+空体（抓取侧归 signature_invalid）",
                       SELFCHECK_TRIES, problem)
        return bogus

    # ── 对外 ──
    def sign_query(self, params: Mapping[str, str], *, cookies: Mapping[str, str],
                   body: str = "", content_type: str = "") -> SignedQuery:
        """签名 → `SignedQuery`（调用方把 `query` 拼进 URL、把 `headers` 附上）。"""
        effective_body = "" if "multipart/form-data" in content_type.lower() else body
        out = self._sign_once(params, cookies, effective_body)
        self._maybe_shadow(out, params=params, cookies=cookies, body=effective_body)
        return out

    def _maybe_shadow(self, primary: SignedQuery, *, params: Mapping[str, str],
                      cookies: Mapping[str, str], body: str) -> None:
        """到点才比。主侧复用刚签出来那一份 ⇒ 抽样只多花一次签名（≈5ms）。"""
        if not self._probe.due(SHADOW_KEY_DOUYIN):
            return
        self.last_comparison = self._probe.compare(
            SHADOW_KEY_DOUYIN,
            primary=lambda: _query_shape(primary),
            shadow=lambda: _query_shape(self._sign_once(params, cookies, body)),
            stable=douyin_stable_constants,
        )


def _query_shape(signed: SignedQuery) -> dict:
    """把一次签名摊成"参数名 → 取值"的字典（影子比对要看的就是这些键在不在）。"""
    out = {name: value for name, value in (_split_pair(p) for p in signed.query.split("&") if p)}
    out.update({f"h:{k}": v for k, v in signed.headers.items()})
    return out


def _split_pair(part: str) -> tuple[str, str]:
    """`k=v` → `(k, v)`，**两边都 unquote**：secsdk 签的是重新序列化后的整串，
    所以这里必须解码一次再由它统一编码（否则"哈希的字节"与"发出去的字节"会不同）。
    """
    name, _, value = part.partition("=")
    return unquote(name), unquote(value)
