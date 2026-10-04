"""**影子比对**：把"签名悄悄失效"变成"可见且自愈"（第 4 阶段 ⑤，devlog/237；调研 §3.4.1）。

## 抄的是哪几条规矩（DTK v5 的 `SignerRegistry`）

| 规矩 | 本模块怎么落 |
|---|---|
| **默认走主实现** | `primary()` 是唯一影响**返回给调用方**结果的那条路 |
| **抽样比对，不是每次都比** | 每个 key `ttl`（默认 600s）最多比一次（`due()`） |
| **不比字节，比噪声碰不到的常量** | 调用方给 `stable()`：它从两侧结果里摘出**可比的常量**；空字典 = 比不了 |
| **误判防护** | 不一致时**重跑一次再下结论**（`retries`）；重跑一致 ⇒ 记一条"假阳性"日志而不是报警 |
| **比不出来 ⇒ 视为未比对** | `inconclusive` **绝不禁用**主路径（"absence of evidence must never disable the native path"） |
| **降级要出声** | 每次判定不一致都 `logger.warning`（线上"签名坏了但流量悄悄走另一条路"最难查） |

## ⚠️ 小红书今天只能比"同实现两次"

调研里那套是**本地签名 vs 浏览器签名**；小红书目前只有一份实现（`xhshow`），没有第二个
签名器可比。所以这里比的是**结构常量**（该有的头在不在、`x-s-common` 解出来的平台常量
变没变）——它能抓住"依赖升级后头少了/形状变了"这类**回归**，
**抓不到**"签名被服务端拒绝"（那要靠抓取侧的响应分类 + 风控统计，见 `identity_limit.py`）。
抖音真接进来时，第二个实现（浏览器兜底）一挂上，同一套机制就能比"本地 vs 浏览器"。

## 纯逻辑 + 可注入时钟

`ShadowProbe` 不碰网络、不 import 平台库：两次调用都由调用方（签名器）提供。
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Callable, Literal, Optional

logger = logging.getLogger(__name__)

Verdict = Literal["match", "mismatch", "inconclusive", "skipped"]

DEFAULT_TTL = 600.0     # 调研 §3.4.1：每端点每 600s 抽一次
SHADOW_KEY = "xhs.sign"  # 小红书签名器那条抽样 key（签名头与端点无关，一个 key 够）
SHADOW_KEY_DOUYIN = "douyin.sign"   # 抖音（devlog/334）：同一套机制，键分开


@dataclass(frozen=True)
class Comparison:
    """一次比对的结果。`samples` = 实际跑了几轮（重跑算两轮）。"""

    verdict: Verdict
    detail: str = ""
    samples: int = 0

    @property
    def should_alert(self) -> bool:
        """只有 `mismatch` 才值得报警；`inconclusive` 不是故障（是"没比成"）。"""
        return self.verdict == "mismatch"


# 稳定的取值函数：拿两侧的原始结果，返回**可比常量**的字典（空 = 比不了）
Stable = Callable[[dict], dict]


class ShadowProbe:
    """按 key 抽样比对主实现与影子实现。**线程安全靠调用方**（签名在抓取线程里跑）。"""

    def __init__(self, ttl: float = DEFAULT_TTL, retries: int = 1,
                 now: Optional[Callable[[], float]] = None) -> None:
        self._ttl = ttl
        self._retries = max(0, retries)
        self._now = now or time.time
        self._last: dict[str, float] = {}

    def due(self, key: str) -> bool:
        """这个 key 现在该不该比一次（首见即比；之后每 `ttl` 一次）。"""
        last = self._last.get(key)
        return last is None or (self._now() - last) >= self._ttl

    def compare(self, key: str, primary: Callable[[], dict],
                shadow: Callable[[], dict], stable: Stable) -> Comparison:
        """跑一次比对。⚠️ **返回值不影响主路径**：调用方永远用 `primary()` 的结果。"""
        if not self.due(key):
            return Comparison("skipped", "未到抽样窗口")

        rounds = 0
        last_detail = ""
        for attempt in range(1 + self._retries):
            rounds += 1
            try:
                left, right = primary(), shadow()
            except Exception as e:  # noqa: BLE001 —— 任一侧炸了都只是"比不出来"
                last_detail = f"{type(e).__name__}: {e}"
                self._last[key] = self._now()
                logger.debug(f"影子比对无法进行（{key}）：{last_detail}")
                return Comparison("inconclusive", last_detail, rounds)
            try:
                a, b = stable(left), stable(right)
            except Exception as e:  # noqa: BLE001
                last_detail = f"stable() 抛出 {type(e).__name__}: {e}"
                self._last[key] = self._now()
                return Comparison("inconclusive", last_detail, rounds)
            if not a or not b:
                # 没有任何可比的常量（例：NullSigner 本来就不产头）⇒ 未比对，**不是失败**
                self._last[key] = self._now()
                return Comparison("inconclusive", "没有可比常量", rounds)
            if a == b:
                if attempt > 0:
                    # 第一轮不一致、重跑一致 ⇒ 假阳性（调研记录的 1/690 那类）
                    logger.info(f"影子比对首轮不一致、重跑一致（{key}）：按假阳性处理")
                self._last[key] = self._now()
                return Comparison("match", "", rounds)
            last_detail = f"常量不一致：{sorted(set(a.items()) ^ set(b.items()))[:6]}"

        # 重跑过仍不一致 ⇒ 才下结论
        self._last[key] = self._now()
        logger.warning(f"影子比对**不一致**（{key}）：{last_detail} —— "
                       f"主实现可能已失效（抖音那套会在这里切到浏览器兜底；"
                       f"小红书目前只有一份实现，会一路走到抓取侧的响应分类）")
        return Comparison("mismatch", last_detail, rounds)

    def reset(self) -> None:
        self._last.clear()


# ── 小红书：可比常量怎么摘 ─────────────────────────────────────────────

# 噪声/时钟碰得到的一律排除：x-t 是毫秒时钟、x-s 里混了行为计数器与噪声
_UNSTABLE_HEADERS = frozenset({"x-t", "x-s", "x-s-common"})
# 结构常量：这些头在不在、形状对不对（签名器回归时最先变的就是它们）
_REQUIRED_HEADERS = ("x-s", "x-t", "x-s-common")
_HEXISH = ("0123456789abcdef")


def xhs_stable_constants(headers: dict) -> dict:
    """从小红书签名头里摘**可比常量**（`{}` = 比不了 ⇒ 未比对）。

    比的是：① 三个签名头在不在；② `x-s` 的**前缀形状**（`XYS_` 之后是十六进制串，
    新版若换了算法这里会先变）；③ `x-s-common` 的**长度档位**（它 base64 了平台常量，
    长度突变 = 结构变了）。**不比任何字节内容** —— 那里面有时钟与噪声。
    """
    if not headers:
        return {}
    out: dict = {}
    for name in _REQUIRED_HEADERS:
        out[f"has:{name}"] = name in headers
    if not all(out.get(f"has:{n}") for n in _REQUIRED_HEADERS):
        # 头都不全就没什么可比的了（NullSigner / 半个签名器）
        return {}
    xs = str(headers.get("x-s") or "")
    prefix, _, tail = xs.partition("_")
    out["x-s.prefix"] = prefix
    out["x-s.tail.hexish"] = bool(tail) and all(c in _HEXISH for c in tail.lower())
    common = str(headers.get("x-s-common") or "")
    out["x-s-common.len.bucket"] = len(common) // 20      # 档位而不是精确长度
    return out


# ── 抖音：可比常量怎么摘（D2，devlog/334）──────────────────────────────

#: 一次抖音签名的 query 里**必须**有的六个参数（顺序也是平台的）
_DOUYIN_PARAMS = ("a_bogus", "verifyFp", "fp", "uifid", "timestamp", "x-secsdk-web-signature")
#: 三个头（`x-tt-argus` 不在签名器里，它是常量 `"1"`，比了也没信息）
_DOUYIN_HEADERS = ("uifid", "x-secsdk-web-signature", "x-secsdk-web-expire")


def douyin_stable_constants(shape: dict) -> dict:
    """从一次抖音签名里摘**可比常量**（`{}` = 比不了 ⇒ 未比对）。

    ⚠️ **不比字节**：两次签名的 `a_bogus` 一定不同（里面是随机噪声与时钟），
    比字节会把每次都报成不一致。比的是**两次是否同样自洽**：

    | 常量 | 抓住什么 |
    |---|---|
    | 六个参数 / 三个头在不在 | 结构回归（改版后少了一个）|
    | `a_bogus` 过不过 `structure_error()` | **格式自带的校验和**：噪声展开有 bug 时它时好时坏 ⇒ 两次比对现形 |
    | `a_bogus` 长度档位 | 几何/版本块结构变了 |
    | secsdk 是不是 32 位十六进制 | 那一层从 md5 换成别的算法 |

    ⚠️ **抓不到"整体失效"**（两次坏得一样 ⇒ 比出来是"一致"）：那一条由签名器在**发请求前**
    的 `structure_error()` 自检负责（不过就 `SignerUnavailable`，一个字节都不发）。
    """
    if not shape:
        return {}
    out: dict = {}
    for name in _DOUYIN_PARAMS:
        out[f"has:{name}"] = bool(shape.get(name))
    for name in _DOUYIN_HEADERS:
        out[f"has:h:{name}"] = bool(shape.get(f"h:{name}"))
    if not all(out[f"has:{n}"] for n in ("a_bogus", "uifid", "x-secsdk-web-signature")):
        # 三个核心都不全 ⇒ 没什么可比的（`NullSigner` 一类的半个签名器）
        return {}
    # 延迟 import：本模块的定位是**纯逻辑**，不该把 vendored 的算法拽进 import 图
    from app.services.platforms.vendor.dtksign import structure_error

    bogus = str(shape.get("a_bogus") or "")
    out["a_bogus.problem"] = structure_error(bogus) or "none"
    out["a_bogus.len.bucket"] = len(bogus) // 20
    signature = str(shape.get("x-secsdk-web-signature") or "")
    out["secsdk.hexish32"] = len(signature) == 32 and all(c in _HEXISH for c in signature.lower())
    return out
