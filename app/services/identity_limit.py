"""身份级限速与**四类响应**（第 4 阶段 ⑤，devlog/237；调研 `docs/platforms-xhs-douyin-research.md` §5.3.1）。

## 为什么需要（现有机制差在哪）

现在的风控处理是**按平台**的：`rate_limit.py` 的冷却窗口键是 `platform`，风控标志是
`fetcher.py` 里一个按平台置位的 ContextVar。对 B 站够用（一个号就是一份身份），
但调研 §5.3.1 记的是：**新平台的风控是身份级（会话/账号级）的** —— 风控顺着
cookie / 指纹 / 出口 IP 走，所以"这份身份在这个端点上的节奏"才是被观测的对象。

三件事必须一起做（缺一条会以另一种方式咬人）：

| 机制 | 做法 | 缺了它会怎样 |
|---|---|---|
| **四类响应** | `ok` / `business_error` / `risk_control` / `network_error` | "帖子被删"与"身份被风控"混成一个 ⇒ **遍历 id 的调用方白白冷却身份**（抖音对不存在的帖子返回 200 + `aweme_detail: null`，恰好长得像风控） |
| **身份级令牌桶** | 粒度是 **(身份, 端点)**，不是平台、**也不是目标 uid** | 换个目标就满速重来 ⇒ 同一份身份的实际速率是"目标数 × 单价"，风控照样看得见 |
| **端点级熔断** | 风控率 >0.6 ∧ 样本 ≥20 ∧ **涉及 ≥3 个不同目标** | 少第三个条件时，**一个坏目标就能把整个端点关掉**（别的目标明明好好的） |

## 两个刻意的口径决定

**① 身份 = 我们自己的会话**（平台 + cookie 指纹），不是被查的 uid。
调研里"身份四要素"（cookie jar / 指纹 / 代理 / 历史）说的是**采集方**的身份；
本项目目前一个平台只有一份 cookie（`settings.XHS_COOKIE`）⇒ 现实身份数 = 1。
`identity_key()` 把 cookie 哈希进去，是为了**将来支持"用户提供自己的账号"时不用改结构**，
而不是现在就假装有多个身份。

**② 熔断的第三个条件，在本项目落到"不同目标"上。**
DTK v5 原文是"失败涉及 ≥3 个不同身份"，因为它是多账号采集器。我们只有一份身份，
照抄会让这条**永远不触发**（等于没有）。这里改成"同一个端点上 ≥3 个**不同目标**都被风控"
—— 它照样是"端点坏了"与"某个目标坏了"的分界线（例：签名改版后**每个**目标都吃 403）。
⚠️ 如实标注：这是**适配**，不是照搬。

## 纯逻辑 + 可注入时钟

与 `rate_limit.py` 同风格：状态是不可变 dataclass，改状态返回新对象，时钟从参数进
（`now`）；没有隐藏的全局写。不起调度器、不碰网络就能测。

⚠️ 本模块**故意不加** `from __future__ import annotations`：注解在 3.12 就会被求值，
而 `tests/test_annotations_resolve.py` 只查这类模块（注解里少导入一个名字，本地 3.14 看不见、
CI 的 3.12 腿必炸 —— devlog/236 踩过两次）。
"""
import hashlib
import json
import logging
import math
import time
from dataclasses import dataclass, field, replace
from typing import Callable, Literal

logger = logging.getLogger(__name__)

# ── 四类响应 ──────────────────────────────────────────────────────────
# ⚠️ 只有四类。平台适配器可以有更细的**诊断**分类（如小红的六分类：签名失效/网关缺头…），
#    但那属于"我们这侧坏了"的排查信息，策略上仍要落进这四类之一。
Outcome = Literal["ok", "business_error", "risk_control", "network_error"]


@dataclass(frozen=True)
class Policy:
    """某一类响应**怎么算**（一张表说清，而不是散在各处的 if）。"""

    affects_health: bool          # 是否影响身份健康度
    refund_token: bool            # 是否把令牌还回去（"这次不算我们花掉的额度"）
    counts_as_endpoint_sample: bool   # 是否计入端点熔断的样本


POLICY: dict[str, Policy] = {
    # 成功：算成功、算样本
    "ok": Policy(affects_health=True, refund_token=False, counts_as_endpoint_sample=True),
    # 业务失败（帖子被删 / 号不存在 / 参数不对）：**完全不影响身份健康**，
    # 令牌退还、也不算端点样本 —— 它既不是"身份可疑"也不是"端点坏了"
    "business_error": Policy(affects_health=False, refund_token=True,
                             counts_as_endpoint_sample=False),
    # 风控：唯一的"扣分"来源，且**不退令牌**（额度已经花掉了），计样本
    "risk_control": Policy(affects_health=True, refund_token=False,
                           counts_as_endpoint_sample=True),
    # 网络错（超时/连不上/上游 5xx）：与身份无关，退令牌、不计样本
    "network_error": Policy(affects_health=False, refund_token=True,
                            counts_as_endpoint_sample=False),
}

# 状态码 → 类。只在**没有**平台码表时兜底（平台自己认得出的走 `outcome_for_kind`）
_STATUS_RISK = frozenset({403, 412, 418, 429, 461, 471})
_STATUS_NETWORK = frozenset({500, 502, 503, 504, 520, 521, 522, 524})
_RISK_WORDS = ("risk", "风控", "频繁", "限流", "too many", "rate limit", "captcha", "验证码")

# 平台**诊断**分类 → 四类。小红的六分类（devlog/230）走这张表。
_KIND_TO_OUTCOME: dict[str, Outcome] = {
    "ok": "ok",
    "business_error": "business_error",
    "risk_control": "risk_control",
    # 下面三个都是"我们这侧坏了"：cookie 没了 / 签名不对 / 网关头缺失。
    # ⚠️ 归 network_error 而不是 business_error 的理由：它对**身份**没有任何信息量，
    #    不该让身份健康度掉分；也不该像风控那样扣住令牌不放。可见性由适配器的
    #    `last_error`（一等状态）承担 —— 不是靠这里分类。
    "cookie_invalid": "network_error",
    "signature_invalid": "network_error",
    "gateway_missing": "network_error",
    # 上游/网关 5xx：与身份无关，退令牌、不计样本（devlog/237 新加的诊断类）
    "server_error": "network_error",
}


def outcome_for_kind(kind: str) -> Outcome:
    """平台适配器的诊断分类 → 四类响应（认不出来的一律按最保守的 `risk_control`）。

    ⚠️ 兜底选 `risk_control` 而不是 `business_error`：未知失败宁可多冷却一次身份，
    也不能当成"业务失败"而**不计入风控统计**（那会让真风控从统计里消失）。
    """
    return _KIND_TO_OUTCOME.get(kind, "risk_control")


def classify(status_code: int, *, error: BaseException | None = None,
             business_codes: frozenset | set | None = None,
             code: object = None, msg: str = "") -> Outcome:
    """把一次响应/异常分成四类之一。

    ⚠️ **本函数不猜 body 语义**：`200` 一律先算 `ok`。抖音那类"HTTP 200 但
    `aweme_detail: null`"要靠调用方看结构后给出 `kind="business_error"`
    （走 `outcome_for_kind`），否则会把"帖子被删"记成风控。
    """
    if error is not None:
        return "network_error"          # 超时 / 连不上 / DNS / 代理：与身份无关
    text = f"{code if code is not None else ''} {msg}".lower()
    if any(w in text for w in _RISK_WORDS):
        return "risk_control"
    if business_codes and code is not None and code in business_codes:
        return "business_error"
    if status_code in _STATUS_NETWORK:
        return "network_error"
    if status_code in _STATUS_RISK:
        return "risk_control"
    if status_code == 200:
        return "ok"
    return "business_error"


# ── 身份 ──────────────────────────────────────────────────────────────

def identity_key(platform: str, cookie: str = "") -> str:
    """`平台 + cookie 指纹`。**不落明文 cookie**（日志/诊断里出现的就是这个串）。

    没配 cookie ⇒ `platform:anonymous`（"我们还没身份"也是一种身份：它的额度照样算，
    免得没配 cookie 时无限重试）。
    """
    raw = (cookie or "").strip()
    if not raw:
        return f"{platform}:anonymous"
    return f"{platform}:{hashlib.sha1(raw.encode('utf-8')).hexdigest()[:8]}"


def platform_of(identity: str) -> str:
    """从身份串取回平台名（`identity_key` 的逆的一半；窗口按平台分所以要用）。"""
    return identity.split(":", 1)[0]


# ── 身份健康度 ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Health:
    """一个身份的累计表现。**不可变**（`observe` 返回新对象）。"""

    ok: int = 0
    business: int = 0
    risk: int = 0
    network: int = 0
    consecutive_fails: int = 0     # 连续"身份级"失败（风控）——成功即清零

    @property
    def samples(self) -> int:
        """进健康度统计的样本数（业务失败/网络错**不算**）。"""
        return self.ok + self.risk

    @property
    def success_rate(self) -> float:
        return (self.ok / self.samples) if self.samples else 1.0

    @property
    def risk_rate(self) -> float:
        return (self.risk / self.samples) if self.samples else 0.0

    @property
    def score(self) -> float:
        """`success_rate × (1 − risk_rate) × 0.5^consecutive_fails`。

        三项**不可通约**（"成不成" / "有多危险" / "最近连不连得上"），所以按调研 §5.3.1
        用**相乘**而不是加权求和：任何一项塌了，整体就塌。
        """
        return (self.success_rate * (1.0 - self.risk_rate)
                * math.pow(0.5, self.consecutive_fails))

    def observe(self, outcome: Outcome) -> "Health":
        ok, biz = self.ok, self.business
        risk, net = self.risk, self.network
        if outcome == "ok":
            ok += 1
        elif outcome == "business_error":
            biz += 1
        elif outcome == "risk_control":
            risk += 1
        else:
            net += 1
        if not POLICY[outcome].affects_health:
            # 业务失败/网络错**不动** consecutive_fails：它们不是"身份在变坏"的证据
            return replace(self, ok=ok, business=biz, risk=risk, network=net)
        fails = 0 if outcome == "ok" else self.consecutive_fails + 1
        return replace(self, ok=ok, business=biz, risk=risk, network=net,
                       consecutive_fails=fails)


# ── (身份, 端点) 令牌桶 ───────────────────────────────────────────────

@dataclass(frozen=True)
class Bucket:
    """令牌桶（每秒补 `rate` 个，最多攒 `capacity` 个）。

    `rate=0.12` ⇒ 平均 **8.3s** 一次（调研 §5.3.1 举的 `author_posts` 值）。
    """

    rate: float
    capacity: float = 1.0
    tokens: float = 1.0
    updated_at: float = 0.0

    def _refill(self, now: float) -> "Bucket":
        if self.updated_at <= 0 or now <= self.updated_at:
            return replace(self, updated_at=max(now, self.updated_at))
        gained = (now - self.updated_at) * self.rate
        return replace(self, tokens=min(self.capacity, self.tokens + gained),
                       updated_at=now)

    def peek(self, now: float) -> tuple[bool, float]:
        """能不能取一个令牌；不能则给出**还差多少秒**。不改变状态。"""
        b = self._refill(now)
        if b.tokens >= 1.0:
            return True, 0.0
        return False, self._wait(b)

    @staticmethod
    def _wait(b: "Bucket") -> float:
        if b.rate <= 0:
            return float("inf")
        return (1.0 - b.tokens) / b.rate

    def take(self, now: float) -> tuple["Bucket", bool, float]:
        """取令牌：返回 `(新桶, 是否成功, 还差多少秒)`。"""
        b = self._refill(now)
        if b.tokens >= 1.0:
            return replace(b, tokens=b.tokens - 1.0), True, 0.0
        return b, False, self._wait(b)

    def refund(self, now: float) -> "Bucket":
        """退还一个令牌（业务失败/网络错用；退还也**不超过容量**）。"""
        b = self._refill(now)
        return replace(b, tokens=min(b.capacity, b.tokens + 1.0))


# 端点 → 每秒允许次数（**显式**配置；表里没有的端点 = **不限速**，只受熔断约束）。
# ⚠️ 这些值是"多快会被发现"的参数，不是"合法额度"（调研 §5.3 开头的声明）。
#
# ⚠️ 为什么"没配 = 不限速"（devlog/239，用户拍板）：原先未知端点按 `DEFAULT_RATE` 兜底，
#    等于给**任何**新接线的端点偷偷加一层全局限速 —— B 站接熔断时会被它顺手拖慢，
#    而 B 站的节奏已经由 R27/R28/R30 调好了。要限速就**显式**写进这张表：
#    这样"谁被限速"永远是一行可查的配置，而不是一个兜底默认值。
ENDPOINT_RATE: dict[str, float] = {
    "user_posted": 0.12,    # 小红书笔记流：≈8.3s 一次（调研 §5.3.1 的 author_posts 同档）
    "otherinfo": 0.2,       # 小红书账号信息：5s 一次
}


# ── 端点级熔断 ────────────────────────────────────────────────────────

BREAKER_RISK_RATE = 0.6     # 风控率阈值
BREAKER_MIN_SAMPLES = 20    # 样本下限
BREAKER_MIN_TARGETS = 3     # **第三个条件**：被风控的**不同目标**数（见文件头口径 ②）


@dataclass(frozen=True)
class EndpointWindow:
    """某端点的滑动窗口计数（按目标分别记，才判得出"端点坏了"还是"某个目标坏了"）。"""

    samples: int = 0
    risk: int = 0
    per_target: dict[str, int] = field(default_factory=dict)   # 目标 → 风控次数

    @property
    def risk_rate(self) -> float:
        return (self.risk / self.samples) if self.samples else 0.0

    @property
    def risk_targets(self) -> int:
        return len(self.per_target)

    @property
    def tripped(self) -> bool:
        """三条件**同时**成立才算端点级故障。

        ⚠️ 第三个条件（≥3 个不同目标）是"端点坏了"与"某个目标坏了"的**分界线**：
        少了它，一个被风控的目标就能把整个端点关掉，别的目标跟着一起停。
        """
        return (self.risk_rate > BREAKER_RISK_RATE
                and self.samples >= BREAKER_MIN_SAMPLES
                and self.risk_targets >= BREAKER_MIN_TARGETS)

    def observe(self, target: str, outcome: Outcome) -> "EndpointWindow":
        if not POLICY[outcome].counts_as_endpoint_sample:
            return self
        per = dict(self.per_target)
        is_risk = outcome == "risk_control"
        if is_risk:
            key = str(target or "?")
            per[key] = per.get(key, 0) + 1
        return replace(self, samples=self.samples + 1,
                       risk=self.risk + (1 if is_risk else 0), per_target=per)

    # ── 落库用（纯序列化；DB 读写见文件尾的 load_windows / save_windows）──
    def to_dict(self) -> dict:
        return {"samples": self.samples, "risk": self.risk,
                "per_target": dict(self.per_target)}

    @classmethod
    def from_dict(cls, raw: object) -> "EndpointWindow | None":
        """坏数据返回 None（调用方跳过并记日志）—— 一条烂记录不该让调度起不来。"""
        if not isinstance(raw, dict):
            return None
        try:
            per = raw.get("per_target") or {}
            return cls(samples=int(raw.get("samples", 0) or 0),
                       risk=int(raw.get("risk", 0) or 0),
                       per_target={str(k): int(v) for k, v in dict(per).items()})
        except (TypeError, ValueError):
            return None


# ── 台账（进程内状态容器）────────────────────────────────────────────

@dataclass(frozen=True)
class Decision:
    """`acquire` 的结论：能不能发这一发请求。"""

    allowed: bool
    retry_after: float = 0.0
    reason: str = ""            # 不允许时：`bucket`（身份额度用完）/ `breaker`（端点熔断）


class Ledger:
    """身份 × 端点的额度与健康度台账（**进程内**：重启即清零）。

    ⚠️ 与 `rate_limit.py` 的分工：那套**落库**，因为它管"被限流后的冷却"（重启继续敲最危险）；
    这里管**正常节奏**（令牌桶），重启后从满桶开始是合理的。
    真被风控时两条一起生效：平台级冷却 + 这里的身份降分。
    """

    def __init__(self, now: Callable[[], float] = time.time) -> None:
        self._now = now
        self._buckets: dict[tuple[str, str], Bucket] = {}
        self._health: dict[str, Health] = {}
        self._windows: dict[tuple[str, str], EndpointWindow] = {}
        self._dirty = False

    # ── 取令牌 ──
    def _bucket(self, identity: str, endpoint: str) -> Bucket | None:
        """这个 (身份, 端点) 的桶；**没配速率就没有桶**（不限速，只受熔断约束）。"""
        rate = ENDPOINT_RATE.get(endpoint)
        if rate is None:
            return None
        key = (identity, endpoint)
        b = self._buckets.get(key)
        if b is None:
            b = Bucket(rate=rate, capacity=1.0, tokens=1.0, updated_at=0.0)
            self._buckets[key] = b
        return b

    def acquire(self, identity: str, endpoint: str) -> Decision:
        """发请求前问一次：**这份身份**在这个端点上现在能不能发。

        两步：① 端点熔断（所有身份一起停）；② 令牌桶（**只有配了速率的端点才有**）。
        """
        win = self._windows.get((platform_of(identity), endpoint))
        if win is not None and win.tripped:
            logger.warning(f"{identity}/{endpoint} 端点已熔断"
                           f"（风控率 {win.risk_rate:.2f}，样本 {win.samples}，"
                           f"涉及 {win.risk_targets} 个目标）")
            return Decision(allowed=False, reason="breaker")
        bucket = self._bucket(identity, endpoint)
        if bucket is None:
            return Decision(allowed=True)          # 不限速端点：放行
        now = self._now()
        b, ok, need = bucket.take(now)
        self._buckets[(identity, endpoint)] = b
        if not ok:
            return Decision(allowed=False, retry_after=need, reason="bucket")
        return Decision(allowed=True)

    # ── 记结果 ──
    def record(self, identity: str, endpoint: str, outcome: Outcome, *,
               target: str = "") -> None:
        pol = POLICY[outcome]
        # ⚠️ 健康度是**诊断账本**：四类都记进去（否则 business/network 两个计数器永远是 0，
        #    排查时看不出"这个身份最近到底遇到了什么"）。**分数**才由策略决定 ——
        #    `Health.observe` 里按 `affects_health` 决定动不动 success/risk/consecutive_fails。
        self._health[identity] = self._health.get(identity, Health()).observe(outcome)
        if pol.refund_token:
            key = (identity, endpoint)
            b = self._buckets.get(key)
            if b is not None:
                self._buckets[key] = b.refund(self._now())
        win_key = (platform_of(identity), endpoint)
        before = self._windows.get(win_key, EndpointWindow())
        after = before.observe(target, outcome)
        self._windows[win_key] = after
        if after.tripped != before.tripped:
            # **熔断态翻转**才值得落库（按请求写库是写放大，见模块头的持久化说明）
            self._dirty = True

    # ── 读 ──
    def health(self, identity: str) -> Health:
        return self._health.get(identity, Health())

    def window(self, identity: str, endpoint: str) -> EndpointWindow:
        return self._windows.get((platform_of(identity), endpoint), EndpointWindow())

    def tripped_endpoints(self, platform: str) -> list[str]:
        """当前已熔断的端点（诊断/日志用）。"""
        return sorted(ep for (pf, ep), w in self._windows.items()
                      if pf == platform and w.tripped)

    def all_windows(self) -> dict[tuple[str, str], EndpointWindow]:
        """全部窗口的快照（只读用途：状态上报 / 诊断）。"""
        return dict(self._windows)

    def forget(self, platform: str) -> int:
        """丢掉该平台的**全部端点窗口**（手动解除熔断用），返回丢了几个。

        ⚠️ 只动内存；落库那份由调用方删除（`clear_windows(db, platform)`）——
        否则重启会把刚解除的熔断"想起来"。
        """
        keys = [k for k in self._windows if k[0] == platform]
        for k in keys:
            del self._windows[k]
        return len(keys)

    def reset(self) -> None:
        """清空（测试隔离用；也是"用户手动解除"的粗粒度口子：一键清所有平台）。"""
        self._buckets.clear()
        self._health.clear()
        self._windows.clear()
        self._dirty = False

    # ── 落库（只落**端点窗口**；健康度留进程内，见模块头）────────────────
    def dirty(self) -> bool:
        """熔断态自上次落库以来翻转过了吗（调用方据此决定写不写）。"""
        return self._dirty

    def mark_clean(self) -> None:
        self._dirty = False

    def export_windows(self, platform: str) -> dict:
        """该平台所有端点窗口 → 可 JSON 化的 dict（落库用）。"""
        return {ep: w.to_dict() for (pf, ep), w in self._windows.items() if pf == platform}

    def import_windows(self, platform: str, payload: dict) -> None:
        """从落库内容恢复（**替换**该平台的窗口；坏数据跳过并记日志）。"""
        if not isinstance(payload, dict):
            return
        for ep, raw in payload.items():
            w = EndpointWindow.from_dict(raw)
            if w is None:
                logger.warning(f"端点窗口解析失败（{platform}/{ep}），已跳过")
                continue
            self._windows[(platform, ep)] = w


# 进程内单例（接线在平台适配器；测试自己 new 一个，见 `tests/conftest.py` 的隔离 fixture）
LEDGER = Ledger()


def throttled(fetcher: object) -> bool:
    """这个适配器的上一次失败是不是**我们自己的节奏**（而不是上游故障）。

    ⚠️ 调度循环靠它区分 `stop_reason`：把"额度用完"报成 `network_error`
    会让用户在报告里看到一处根本没发生的中断（`_fetch_platform_posts` 的 None 分支）。
    """
    err = getattr(fetcher, "last_error", None) or {}
    return err.get("kind") == "identity_throttled"


def health_summary(ledger: Ledger, platform: str) -> dict[str, float]:
    """给排查/诊断用：该平台各身份的健康度评分（从低到高）。"""
    out: dict[str, float] = {}
    for identity, h in ledger._health.items():      # noqa: SLF001 —— 同模块内的读接口
        if platform_of(identity) == platform:
            out[identity] = round(h.score, 4)
    return dict(sorted(out.items(), key=lambda kv: kv[1]))


# ── 端点窗口的落库（`app_meta`；第 4 阶段 ⑦，devlog/239）──────────────────
# 为什么只落窗口：熔断是"这个端点坏了"的判断，重启后**依然成立**（接口改版不会因为
# 我们重启就修好）⇒ 重启后立刻再去撞一遍是纯浪费，还可能把风控范围扩大。
# 健康度**不落库**：它衡量"最近表现"，进程内清零是可接受的，而且按请求写库是写放大。
# 冷却那套（`rate_limit.py`）早就落库了（R27），两者互不替代。
META_PREFIX = "breaker."        # 完整键 = `breaker.<平台>`


def load_windows(db, platform: str, ledger: Ledger) -> int:
    """把落库的端点窗口灌进台账；返回恢复了几个端点（读不到就按"没有"跑，并留痕）。"""
    from app.repositories.vtuber_repo import AppMetaRepo
    try:
        raw = AppMetaRepo(db).all_with_prefix(META_PREFIX)
    except Exception as e:                      # noqa: BLE001 —— 读不到只该"少一层保护"
        logger.warning(f"读端点熔断窗口失败（按无记录处理）: {type(e).__name__}: {e}")
        return 0
    payload = raw.get(platform)
    if not payload:
        return 0
    try:
        data = json.loads(payload)
    except (TypeError, ValueError) as e:
        logger.warning(f"端点熔断窗口解析失败（{platform}）: {type(e).__name__}: {e}")
        return 0
    ledger.import_windows(platform, data if isinstance(data, dict) else {})
    return len(data) if isinstance(data, dict) else 0


def save_windows(db, platform: str, ledger: Ledger) -> None:
    """把该平台的端点窗口落库（失败只记日志：这是"少一层保护"，不该带崩抓取）。"""
    from app.repositories.vtuber_repo import AppMetaRepo
    try:
        AppMetaRepo(db).set(f"{META_PREFIX}{platform}",
                            json.dumps(ledger.export_windows(platform),
                                       ensure_ascii=False, sort_keys=True))
        ledger.mark_clean()
    except Exception as e:                      # noqa: BLE001
        logger.warning(f"写端点熔断窗口失败（{platform}）: {type(e).__name__}: {e}")


def clear_windows(db, platform: str) -> None:
    """删掉某平台的窗口（"用户手动解除"的口子，当前未接线）。"""
    from app.repositories.vtuber_repo import AppMetaRepo
    try:
        AppMetaRepo(db).delete(f"{META_PREFIX}{platform}")
    except Exception as e:                      # noqa: BLE001
        logger.warning(f"删端点熔断窗口失败（{platform}）: {type(e).__name__}: {e}")
