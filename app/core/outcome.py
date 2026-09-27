"""上一次抓取失败的**结构化原因**（任务级 ContextVar；第 4 阶段 ⑦，devlog/239）。

## 为什么需要它

B 站的抓取函数失败时只会 `return None` —— 调用方**分不清**是"风控"、"这个号/稿件没了"
还是"网络断了"。于是调度侧只能一律记 `network_error`：报告里出现"根本没发生的中断"，
账号页出现"更新失败"（分不出是被限流还是号注销了）。研究文档 §5.3.1 把这条列为
「与本项目的直接冲突」。

`fetcher.py` 已经在用同款手法记**风控**（`_rate_limit_ctx`，一个任务级布尔位），
这里补上"是哪一类"的语义位：

- **谁写**：平台抓取函数（B 站的在 `fetcher.py`；小红书在自己的适配器里另有 `last_error`）；
- **谁读**：核心循环（`scheduler._fetch_posts_core` / `_fetch_platform_posts`）在
  "拿到 `None`"之后读一次，据此落 `stop_reason`；端点熔断的记账也读它；
- **任务级而不是全局**：与 `_rate_limit_ctx` 同样的理由 —— 账号抓取与帖子抓取可能并发，
  全局变量会串台（`fetcher.py:18` 那条注释）。

⚠️ 这里**只放语义**，不放策略：`kind` 是**诊断分类**（与小红书的六分类同一套词汇），
四类策略由 `identity_limit.outcome_for_kind()` 决定。分类错了会直接反映到报告与熔断上，
所以写进来的每个分支都要有判据盯着。

## 为什么住在 `app/core/`（而不是 `app/services/platforms/`）

`fetcher.py` 要用它，而 `app.services.platforms.__init__` 会 import registry → 各适配器 →
**又回到 `fetcher`** ⇒ 从 `fetcher` 里 import 那个包会撞上半初始化的模块。
这与 `app/core/jsonsafe.py`（devlog/236 为破同一个环而建）是同一类安排：
**零依赖的小工具放 `core/`，谁都能用，谁都不会成环。**
"""
from __future__ import annotations

from contextvars import ContextVar

# (kind, detail)，kind 空串 = 没有失败
_ctx: ContextVar[tuple[str, str]] = ContextVar("platform_last_failure", default=("", ""))


def set_failure(kind: str, detail: str = "") -> None:
    """记下"这次为什么失败"（`kind` 用诊断分类词汇，见模块头）。"""
    _ctx.set((str(kind or ""), str(detail or "")))


def clear() -> None:
    """清空（每个请求开始前调一次，避免读到上一次的残留）。"""
    _ctx.set(("", ""))


def last_failure() -> tuple[str, str]:
    """`(kind, detail)`；没失败过 ⇒ `("", "")`。"""
    return _ctx.get()


def has_failure() -> bool:
    return bool(_ctx.get()[0])
