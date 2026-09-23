# -*- coding: utf-8 -*-
"""R44：第三方抓取的**超时按接口分开** + **连续失败预算**（devlog/165）。

**为什么有这一支**：2026-09-23 启动的外部补抓里，`zeroroku/gift_days` 花了 **3 分 05 秒** ——
7 个账号**全部 `ReadTimeout`**、每个 **25–29 秒**（`runner.py` 建客户端时写死 25.0）⇒
约 180 秒全在等超时。

两条修法（**分开做，因为作用不同**）：
1. **超时按接口分开**：`gift_days` 的响应很小 ⇒ 8 秒足够；而 `fan_history` **合法就要 5–15 秒**
   （一次返回全量）⇒ 不能跟着一起调小（那会把正常路径也打断）；
2. **连续失败预算**：连着失败到上限就**放弃本轮剩余账号**（端点整体挂了时不该逐个等满超时），
   下一个周期再试。
"""
import asyncio

import pytest

from app.services.externals.base import FailureBudget
from app.services.externals.zeroroku import (GIFT_DAYS_TIMEOUT, fetch_gift_days,
                                             ZerorokuSource)


# ── ① 超时按接口分开 ────────────────────────────────────────────────

class _FakeClient:
    """替身：记录每次请求带的 timeout（**看的就是这个**）。"""

    def __init__(self, payload=None, raise_exc=None):
        self.timeouts = []
        self.payload = payload if payload is not None else {"items": []}
        self.raise_exc = raise_exc

    async def get(self, url, **kwargs):
        self.timeouts.append(kwargs.get("timeout"))
        if self.raise_exc:
            raise self.raise_exc

        class _R:
            status_code = 200

            @staticmethod
            def json():
                return self.payload
        return _R()


def test_gift_days_uses_its_own_short_timeout():
    """`gift_days` 必须带**自己的**短超时（不是客户端那个 25s 默认）。"""
    client = _FakeClient()
    asyncio.run(fetch_gift_days("123", client))
    assert client.timeouts == [GIFT_DAYS_TIMEOUT]
    assert GIFT_DAYS_TIMEOUT <= 10, "这个接口响应很小，8 秒量级就够"


def test_fan_history_keeps_the_client_default():
    """`fan_history` **不许**跟着调小 —— 它合法就要 5~15 秒（一次返回全量）。"""
    from app.services.externals.zeroroku import fetch_fan_history

    client = _FakeClient(payload={"items": []})
    asyncio.run(fetch_fan_history("123", client))
    assert client.timeouts == [None], (
        "fan_history 不该覆盖超时（走客户端默认）—— 调小会把正常路径打断")


# ── ② 连续失败预算（纯函数）─────────────────────────────────────────

def test_budget_allows_until_limit():
    b = FailureBudget(limit=3)
    assert b.ok()
    b.record(False)
    assert b.ok()
    b.record(False)
    assert b.ok()
    b.record(False)          # 第 3 次连续失败 ⇒ 到顶
    assert not b.ok()


def test_budget_resets_on_success():
    b = FailureBudget(limit=3)
    b.record(False)
    b.record(False)
    b.record(True)           # 成功 ⇒ 连续计数归零
    assert b.ok()
    b.record(False)
    b.record(False)
    assert b.ok(), "成功之后应当重新给满预算"


def test_budget_zero_or_negative_disables():
    """`limit<=0` = 不启用（老行为，方便回退）。"""
    b = FailureBudget(limit=0)
    for _ in range(10):
        b.record(False)
    assert b.ok()


# ── ③ 端到端：7 个账号全挂时不该逐个等满超时 ────────────────────────

@pytest.fixture
def db():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    from app.models.vtuber import Account, VTuber

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    for i in range(7):
        v = VTuber(name=f"V{i}")
        s.add(v)
        s.flush()
        s.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid=f"900{i}"))
    s.commit()
    yield s
    s.close()


def test_gift_days_aborts_after_budget(db, monkeypatch):
    """7 个账号全超时 ⇒ 只该尝试 `limit` 次就收工（而不是 7 次）。"""
    calls = {"n": 0}

    async def always_timeout(mid, client, **kw):
        calls["n"] += 1
        raise TimeoutError("ReadTimeout")

    monkeypatch.setattr("app.services.externals.zeroroku.fetch_gift_days", always_timeout)
    asyncio.run(ZerorokuSource()._sync_gift_days(db, client=None))
    assert calls["n"] == FailureBudget().limit, (
        f"7 个账号全挂时应当只试 {FailureBudget().limit} 次，实际 {calls['n']} 次"
        f"（否则 7 × 8s 全在等超时）")
