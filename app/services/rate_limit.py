"""风控冷却的**状态与策略**（R27，devlog/125）。

背景（2026-09-16 盘点，devlog/124）：冷却窗口原先只是 `scheduler` 里的两个模块级变量
（`_rate_limit_until` / `_rate_limit_reason`），带来三个后果：

1. **不落库** ⇒ 重启（含**应用内更新后的自动重启**）即遗忘、立刻恢复满速 ——
   而"被限流之后重启继续敲"恰恰最容易被加重处罚；
2. **固定 `RATE_LIMIT_COOLDOWN`、不升级** ⇒ 连续撞风控也还是每次 10 分钟；
3. **没有解禁恢复期** ⇒ 冷却一到点就满速接着跑。

本模块只放**纯逻辑与落库读写**（落 `app_meta`，零迁移）；调度侧的接线在 `scheduler.py`。

策略（用户 2026-09-16 定：全按建议默认）：

| 命中 | 本次冷却时长 |
|---|---|
| 第 1 次 | `base`（= `settings.RATE_LIMIT_COOLDOWN`，默认 600s，设置里可改） |
| 第 2 次 | `2 × base` |
| 第 3 次及以后 | `4 × base`，且不超过 `CAP_SECONDS`（60 分钟） |

- **归零**：距上次命中超过 `QUIET_SECONDS`（6 小时）⇒ 命中次数清零（下次又从 `base` 起）；
- **恢复期**：冷却结束后的 `RAMP_SECONDS`（10 分钟）内，动态流的轮间隔按 `1/RAMP_FACTOR`
  （= 2 倍）拉开 —— 这是"半预算"的落地方式，避免一解禁就满速。

⚠️ 为什么**按平台**存：口径一直是"只冷却出问题的平台，其它平台继续推进"
（`docs/ARCHITECTURE.md` §3.5）。一个全局单值会让 B 站被限流连带把微博也停掉。

⚠️ 为什么这些参数**不做成设置项**：与 R22 的判断一致（运维参数不外露，免得设置窗口又多几个
看不懂的旋钮）。`base` 已经可热更（`RATE_LIMIT_COOLDOWN`），要调梯度就改本文件的常量。
"""
from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterable
from dataclasses import dataclass, replace

from sqlalchemy.orm import Session

from app.repositories.vtuber_repo import AppMetaRepo

logger = logging.getLogger(__name__)

CAP_SECONDS = 3600.0        # 单次冷却上限（60 分钟）
QUIET_SECONDS = 6 * 3600.0  # 连续这么久没有再命中 ⇒ 命中次数归零
RAMP_SECONDS = 600.0        # 解禁后的恢复期时长
RAMP_FACTOR = 0.5           # 恢复期系数（0.5 ≈ 轮间隔翻倍）
META_PREFIX = "ratelimit."  # app_meta 键前缀；完整键 = `ratelimit.<平台>`


@dataclass(frozen=True)
class State:
    """一个平台的风控冷却状态。

    **不可变**（改状态一律返回新对象）—— 这样升级/归零/恢复期的判定都是纯函数，
    不必起调度器就能测。
    """

    platform: str
    until: float = 0.0        # 冷却到什么时候（epoch 秒）；0 = 从未冷却
    reason: str = ""
    hits: int = 0             # 连续命中次数（受 QUIET_SECONDS 归零）
    last_hit_at: float = 0.0  # 最近一次命中时刻
    ended_at: float = 0.0     # 最近一次冷却**结束**的时刻（恢复期从它算）

    def active(self, now: float) -> bool:
        return self.until > now

    def seconds_left(self, now: float) -> int:
        return max(0, int(round(self.until - now)))

    def in_ramp(self, now: float, ramp: float = RAMP_SECONDS) -> bool:
        """是否处在解禁恢复期（`ended_at` 之后 ramp 秒内）。"""
        return self.ended_at > 0 and 0 <= (now - self.ended_at) < ramp

    def to_json(self) -> str:
        return json.dumps(
            {"until": self.until, "reason": self.reason, "hits": self.hits,
             "last_hit_at": self.last_hit_at, "ended_at": self.ended_at},
            ensure_ascii=False, sort_keys=True)

    @classmethod
    def from_json(cls, platform: str, raw: str) -> State | None:
        """坏数据返回 None（调用方跳过并记日志）—— 一条烂记录不该让调度起不来。"""
        try:
            d = json.loads(raw or "{}")
            return cls(
                platform=platform,
                until=float(d.get("until", 0.0) or 0.0),
                reason=str(d.get("reason", "") or ""),
                hits=int(d.get("hits", 0) or 0),
                last_hit_at=float(d.get("last_hit_at", 0.0) or 0.0),
                ended_at=float(d.get("ended_at", 0.0) or 0.0),
            )
        except (TypeError, ValueError) as e:
            logger.warning(f"风控状态解析失败（{platform}）：{type(e).__name__}: {e}")
            return None


# ── 纯策略 ────────────────────────────────────────────────────────────

def escalated_seconds(base: float, hits: int, cap: float = CAP_SECONDS) -> float:
    """第 `hits` 次命中该冷却多久：1→`base`，2→`2×base`，≥3→`4×base`，封顶 `cap`。"""
    if hits <= 1:
        dur = base
    elif hits == 2:
        dur = base * 2
    else:
        dur = base * 4
    dur = max(0.0, dur)
    return min(dur, cap) if cap and cap > 0 else dur


def decayed_hits(hits: int, last_hit_at: float, now: float,
                 quiet: float = QUIET_SECONDS) -> int:
    """距上次命中已超过 `quiet` ⇒ 归零（"消停够久就重新开始"）。"""
    if hits <= 0 or last_hit_at <= 0:
        return 0
    return 0 if (now - last_hit_at) >= quiet else hits


def register_hit(state: State, reason: str, now: float, base: float,
                 cap: float = CAP_SECONDS, quiet: float = QUIET_SECONDS) -> State:
    """记一次命中：先做归零判定，再 +1 并算出本次冷却时长。"""
    hits = decayed_hits(state.hits, state.last_hit_at, now, quiet) + 1
    return replace(
        state,
        until=now + escalated_seconds(base, hits, cap),
        reason=reason or state.reason or "上游限流",
        hits=hits,
        last_hit_at=now,
    )


def mark_ended(state: State, now: float) -> State:
    """冷却睡够之后调：清 `until`、记 `ended_at`（命中数保留 —— 恢复期与后续升级都要用）。"""
    return replace(state, until=0.0, ended_at=now)


def ramp_factor(state: State, now: float, ramp: float = RAMP_SECONDS,
                factor: float = RAMP_FACTOR) -> float:
    """恢复期系数：恢复期内给 `factor`，否则 1.0。"""
    return factor if state.in_ramp(now, ramp) else 1.0


def ramp_scale(states: Iterable[State], now: float,
               platforms: Iterable[str] | None = None,
               ramp: float = RAMP_SECONDS, factor: float = RAMP_FACTOR) -> float:
    """多个平台一起看时的恢复期系数：取**最小**（最保守的那个说了算）。"""
    want = set(platforms) if platforms is not None else None
    best = 1.0
    for st in states:
        if want is not None and st.platform not in want:
            continue
        best = min(best, ramp_factor(st, now, ramp, factor))
    return best


# ── 落库（app_meta；失败只记日志，绝不让抓取任务崩）─────────────────────

def load_all(db: Session) -> dict[str, State]:
    """读回全部平台状态。`AppMetaRepo.set` 自带 commit，这里只读。"""
    try:
        raw = AppMetaRepo(db).all_with_prefix(META_PREFIX)
    except Exception as e:                      # 读不到就按"没有冷却"跑，但要留痕
        logger.warning(f"读风控冷却状态失败（按无冷却处理）: {type(e).__name__}: {e}")
        return {}
    out: dict[str, State] = {}
    for platform, val in raw.items():
        st = State.from_json(platform, val)
        if st is not None:
            out[platform] = st
    return out


def save(db: Session, state: State) -> None:
    """落库（`AppMetaRepo.set` 内部 commit）。写失败只记日志：冷却状态丢了是"少一层保护"，
    不该把正在跑的抓取任务带崩。"""
    try:
        AppMetaRepo(db).set(f"{META_PREFIX}{state.platform}", state.to_json())
    except Exception as e:
        logger.warning(f"写风控冷却状态失败（{state.platform}）: {type(e).__name__}: {e}")


def clear(db: Session, platform: str) -> None:
    """删掉某平台的状态（给"用户手动解除"留的口子，当前未接线）。"""
    try:
        AppMetaRepo(db).delete(f"{META_PREFIX}{platform}")
    except Exception as e:
        logger.warning(f"删风控冷却状态失败（{platform}）: {type(e).__name__}: {e}")


def now() -> float:
    """当前 epoch 秒（单独抽出来便于将来替换时钟）。"""
    return time.time()
