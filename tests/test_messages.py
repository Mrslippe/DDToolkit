"""消息中心 M0：推送通道骨架（devlog/241；方案 `docs/design/notices/message-hub-execution.md`）。

| 判据 | 方案编号 |
|---|---|
| 订阅 → 发布 ⇒ 收到（含序号可当 `Last-Event-ID`） | V1 |
| 订阅者断开 ⇒ 注册表归零（不留悬挂） | V4 |
| 回放：环形 50 条 + 只补 `Last-Event-ID` 之后的 + 带 `replay` 标记 | §8.5 D |
| **从 `threading.Thread` 发布** ⇒ 订阅者收到 | **§8.2**（方案漏掉的那处） |
| 未知消息类型当场报错（类型是隐式契约） | §M0 用例 4 |
| dev-only 合成发布钩子：dev 态在、**生产态不在** | **§8.3**（方案漏掉的那处） |
| 推送端点**不在**公开白名单（token 走 header，不进 URL） | §2.1 / V5 |

⚠️ **HTTP 层不通过 `TestClient` 读流**：那要先赌"Starlette 的测试客户端会不会把
`StreamingResponse` 缓冲住"，赌错的表现是**整个测试套挂死**（不是红）。
所以这里分两层测：**生成器直接迭代**（行为，确定性）+ **路由表断言**（接线）。
真界面的端到端留给 M0b 的探针（`§8.3` 的合成钩子就是为它准备的）。
"""
import asyncio
import pathlib
import threading
import time

import pytest
from fastapi import FastAPI

from app.services import messages as M


@pytest.fixture(autouse=True)
def _fresh_hub(monkeypatch):
    """每个用例一个干净 hub（模块级单例是**生产**用的，测试不能互相污染）。"""
    hub = M.MessageHub()
    monkeypatch.setattr(M, "HUB", hub)
    return hub


# ── ① hub 本体 ────────────────────────────────────────────────────────

def test_publish_reaches_subscribers():
    """V1：订阅者收到发布的消息（类型 / payload / 序号）。

    ⚠️ 要 `start()`：投递由 drain 任务做（`publish()` 只把消息放进线程安全的中转队列）。
    没 `start()` 时 publish 只进环形缓冲 —— 那是**刻意的**（调度线程可能先于 lifespan 发布）。
    """
    hub = M.HUB

    async def run():
        sub = hub.subscribe()
        hub.start()
        try:
            seq = hub.publish(M.MSG_NOTICE_PROGRESS, {"task": "full", "done": 1})
            msg = await asyncio.wait_for(sub.queue.get(), timeout=2)
            return seq, msg
        finally:
            hub.unsubscribe(sub)
            await hub.stop()

    seq, msg = asyncio.run(run())
    assert msg.type == M.MSG_NOTICE_PROGRESS
    assert msg.payload == {"task": "full", "done": 1}
    assert msg.seq == seq, "序号要能当 Last-Event-ID 用"


def test_publish_without_start_only_buffers():
    """没 `start()`（drain 未起）时 publish 不炸、只进环 —— 调度线程早于 lifespan 的形态。"""
    hub = M.HUB
    seq = hub.publish(M.MSG_NOTICE_MESSAGE, {"text": "早"})
    assert [m.seq for m in hub.replay_since(0)] == [seq]
    assert hub.subscriber_count == 0


def test_unknown_message_type_is_rejected():
    """类型是**隐式契约**（前端按 type 分发）⇒ 拼错的类型必须当场炸，不能静默发出去。"""
    with pytest.raises(ValueError):
        M.HUB.publish("notice.progres", {})       # 少一个 s
    with pytest.raises(ValueError):
        M.HUB.publish("domain.whatever", {})


def test_subscriber_count_returns_to_zero_on_unsubscribe():
    """V4：断开要**真的摘掉**（否则每重连一次泄漏一个队列 —— 长连接最典型的一类泄漏）。"""
    hub = M.HUB

    async def run():
        a = hub.subscribe()
        b = hub.subscribe()
        assert hub.subscriber_count == 2
        hub.unsubscribe(a)
        assert hub.subscriber_count == 1
        hub.unsubscribe(b)
        return hub.subscriber_count

    assert asyncio.run(run()) == 0
    assert hub.subscriber_count == 0


def test_publish_without_subscribers_only_buffers():
    """没有订阅者时只进环形缓冲：不报错、不丢（后端比前端活得久）。"""
    hub = M.HUB
    seq = hub.publish(M.MSG_NOTICE_ALERT, {"text": "上游限流"})
    got = hub.replay_since(0)
    assert [m.seq for m in got] == [seq]


def test_ring_buffer_is_bounded_and_keeps_the_newest():
    """回放缓冲有上限（§8.5 D：50 条）：溢出丢最旧的，**不能无限涨**。"""
    hub = M.HUB
    for i in range(M.RING_SIZE + 7):
        hub.publish(M.MSG_NOTICE_MESSAGE, {"text": f"m{i}"})
    got = hub.replay_since(0)
    assert len(got) == M.RING_SIZE
    assert got[-1].payload["text"] == f"m{M.RING_SIZE + 6}"
    assert got[0].payload["text"] == "m7", "留下的应当是最新的那 N 条"


def test_replay_since_only_returns_newer_messages():
    """`Last-Event-ID` 语义：只补**比它新**的（重连时不重播已看过的）。"""
    hub = M.HUB
    first = hub.publish(M.MSG_NOTICE_MESSAGE, {"text": "a"})
    hub.publish(M.MSG_NOTICE_MESSAGE, {"text": "b"})
    assert [m.payload["text"] for m in hub.replay_since(first)] == ["b"]
    assert hub.replay_since(10 ** 9) == []


# ── ② §8.2：publish 必须能**跨线程** ──────────────────────────────────

def test_publish_from_a_plain_thread_reaches_subscribers():
    """⚠️ M0 最重要的一条：T0 是守护线程，`publish()` 会被**没有事件循环的线程**调用。

    ⚠️ 线程要**等一小下**再发：这样主协程**真的停在 `await queue.get()` 上** ——
    那才是 uvicorn 空闲时的形状（"边沿来了"正是发生在没人跑循环的时候）。
    若在 `t.join()` 里发（循环根本没在跑），一个"要求调用线程有运行中的事件循环"的实现
    也能蒙过去（判据空转，见 DEV-LOOP §0.7）。

    反向验证：把 `publish()` 改成直接在当前线程投递（`asyncio.get_running_loop()`）⇒ 本用例红。
    """
    hub = M.HUB
    got: list[M.Message] = []

    async def run():
        sub = hub.subscribe()
        hub.start()                       # 起 drain（lifespan 里做的事）
        try:
            def publish_from_a_loopless_thread():
                time.sleep(0.2)           # 让主协程先停到 queue.get() 上
                hub.publish(M.MSG_LIVE_EDGE, {"vtuberId": 7})

            t = threading.Thread(target=publish_from_a_loopless_thread, name="fake-t0")
            t.start()
            got.append(await asyncio.wait_for(sub.queue.get(), timeout=3))
            t.join(timeout=5)
        finally:
            hub.unsubscribe(sub)
            await hub.stop()

    asyncio.run(run())
    assert [m.type for m in got] == [M.MSG_LIVE_EDGE]
    assert got[0].payload == {"vtuberId": 7}


def test_publish_survives_a_rebuilt_event_loop():
    """方案 §M0 用例 ④：**事件循环重建后仍能 publish**（`ARCHITECTURE.md` §6 第 15 条）。

    综合档每轮一个 `asyncio.run()`：任何"绑在造它的那个循环上"的原语跨轮必炸。
    顺带钉住两条：① 同代里 `start()` 两次不会有两套 drain；② `stop()` 之后**不留**
    asyncio 原语（`_wake` / `_loop` 都清空 —— 留着就是下一次"跨代复用"的种子）。
    """
    hub = M.HUB

    async def round_one():
        sub = hub.subscribe()
        hub.start()
        hub.start()                       # 幂等
        try:
            hub.publish(M.MSG_NOTICE_MESSAGE, {"text": "第一轮"})
            return await asyncio.wait_for(sub.queue.get(), timeout=2)
        finally:
            hub.unsubscribe(sub)
            await hub.stop()

    first = asyncio.run(round_one())      # 第一代循环到此销毁
    assert first.payload["text"] == "第一轮"
    assert hub._wake is None and hub._loop is None, "stop() 之后不许留 asyncio 原语"

    # 循环已经没了：publish 仍必须能用（只进环，不炸）
    hub.publish(M.MSG_NOTICE_MESSAGE, {"text": "断档期"})

    async def round_two():
        sub = hub.subscribe()
        hub.start()                       # 第二代循环：原语必须重建，不许复用上一代的
        try:
            hub.publish(M.MSG_NOTICE_MESSAGE, {"text": "第二轮"})
            got: list[M.Message] = []
            while len(got) < 2:
                got.append(await asyncio.wait_for(sub.queue.get(), timeout=2))
            return got
        finally:
            hub.unsubscribe(sub)
            await hub.stop()

    got = asyncio.run(round_two())
    # 断档期那条留在中转队列里 ⇒ 下一代 start() 先清积压再等（生产里 stop 只发生在关停）
    assert [m.payload["text"] for m in got] == ["断档期", "第二轮"]
    assert hub.subscriber_count == 0


def test_hub_start_is_idempotent_and_stop_is_safe():
    """`runtime.start()` 那套纪律（R1）：起两次不该有两套 drain；stop 之后 publish 不炸。"""
    hub = M.HUB

    async def run():
        hub.start()
        hub.start()
        await hub.stop()
        await hub.stop()
        return hub.publish(M.MSG_NOTICE_MESSAGE, {"text": "after-stop"})

    assert isinstance(asyncio.run(run()), int)


def test_slow_subscriber_keeps_the_newest():
    """慢订阅者**不会**拖住别人、也吃不光内存：队列满了**丢最旧的**，最新的还在。

    这是方案 §7 R2（慢客户端）的缓解措施 —— 也是"订阅者弱耦合"那条设计的**唯一**判据。
    反向验证：把 `_deliver` 的溢出分支改成"满了就丢新的 ⇒ 留着最旧的 200 条" ⇒ 本用例红。
    """
    hub = M.HUB
    total = M.SUBSCRIBER_QUEUE_SIZE + 10

    async def run():
        sub = hub.subscribe()
        hub.start()
        try:
            for i in range(total):
                hub.publish(M.MSG_NOTICE_MESSAGE, {"text": f"m{i}"})

            async def _until_dropped():
                while sub.dropped == 0:
                    await asyncio.sleep(0.005)

            await asyncio.wait_for(_until_dropped(), timeout=10)
            drained: list[M.Message] = []
            while not sub.queue.empty():
                drained.append(sub.queue.get_nowait())
            return sub.dropped, drained
        finally:
            hub.unsubscribe(sub)
            await hub.stop()

    dropped, drained = asyncio.run(run())
    assert dropped == total - M.SUBSCRIBER_QUEUE_SIZE, "每溢出一条丢一条"
    assert len(drained) == M.SUBSCRIBER_QUEUE_SIZE, "队列必须有界"
    kept = [m.payload["text"] for m in drained]
    assert kept[-1] == f"m{total - 1}", "保留的应当是最新的那些"
    assert kept[0] == f"m{total - M.SUBSCRIBER_QUEUE_SIZE}"


# ── ③ SSE 生成器（行为，确定性；不走 TestClient 读流） ────────────────

def _first_frames(gen, want: int = 1, timeout: float = 3.0) -> list[str]:
    """从 SSE 生成器里取出前 `want` 条 `data:` 帧（带上它们前面的 `id:` 行）。"""
    async def run():
        out: list[str] = []
        data_seen = 0
        try:
            while data_seen < want:
                chunk = await asyncio.wait_for(gen.__anext__(), timeout=timeout)
                out.append(chunk)
                if chunk.startswith("data:"):
                    data_seen += 1
        except (StopAsyncIteration, asyncio.TimeoutError):
            pass
        finally:
            await gen.aclose()
        return out

    return asyncio.run(run())


def test_sse_frames_carry_id_and_replay_flag():
    """SSE 帧：`id:` 给重连用；重连补发的消息带 `replay: true`（前端据此**不弹提示**）。"""
    from app.routers.messages import stream_events

    hub = M.HUB
    first = hub.publish(M.MSG_NOTICE_MESSAGE, {"text": "旧"})
    second = hub.publish(M.MSG_NOTICE_ALERT, {"text": "新"})

    frames = _first_frames(stream_events(last_event_id=str(first)), want=1)
    text = "".join(frames)
    assert f"id: {second}" in text, text
    assert "新" in text
    assert "旧" not in text, "只补 Last-Event-ID 之后的消息"
    assert '"replay":true' in text.replace('"replay": true', '"replay":true'), text


def test_sse_frame_without_last_event_id_is_not_replay():
    """首次订阅（没有 `Last-Event-ID`）**不补发历史**（§8.5 D：只在重连时补）。

    否则每开一次窗都会重播整段历史 —— 正是"重连后一串历史 toast"的成因。
    """
    from app.routers.messages import stream_events

    hub = M.HUB
    hub.publish(M.MSG_NOTICE_MESSAGE, {"text": "历史"})

    async def run():
        gen = stream_events(last_event_id=None)
        sub_seen: list[str] = []
        # 没有历史可补 ⇒ 生成器应当先给一条**心跳**而不是 data
        first_chunk = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        sub_seen.append(first_chunk)
        await gen.aclose()
        return sub_seen

    first = asyncio.run(run())[0]
    assert first.startswith(":"), f"首帧应当是心跳而不是历史：{first!r}"


def test_heartbeat_arrives_while_idle(monkeypatch):
    """方案 §M0 用例 ③：空闲时按间隔发心跳（注释行）—— 防"看起来连着其实已死"。

    把间隔压到 0.15s 量（常量在每个循环迭代里现读，所以 monkeypatch 生效）。
    反向验证：去掉 `except TimeoutError: yield ": ping"` ⇒ 本用例红（生成器直接把超时抛出来）。
    """
    from app.routers.messages import stream_events

    monkeypatch.setattr(M, "HEARTBEAT_SECONDS", 0.15)

    async def run():
        gen = stream_events(last_event_id=None)
        try:
            first = await asyncio.wait_for(gen.__anext__(), timeout=2)
            second = await asyncio.wait_for(gen.__anext__(), timeout=2)
            return first, second
        finally:
            await gen.aclose()

    first, second = asyncio.run(run())
    assert first.startswith(":"), f"首帧应当是注释行（流建起来了）：{first!r}"
    assert second.startswith(":") and "ping" in second, f"空闲第二帧应当是心跳：{second!r}"


def test_sse_unsubscribes_when_the_client_goes_away():
    """客户端断开（生成器被 `aclose`）⇒ 订阅者要摘掉（V4 的真实路径）。"""
    from app.routers.messages import stream_events

    hub = M.HUB

    async def run():
        gen = stream_events(last_event_id=None)
        # 先让它真正进入订阅（拉一帧心跳就说明已经订阅了）
        await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert hub.subscriber_count == 1
        await gen.aclose()
        return hub.subscriber_count

    assert asyncio.run(run()) == 0


# ── ④ 接线与守卫 ──────────────────────────────────────────────────────

def _app_paths(app) -> set[str]:
    """把 `app` 上**已注册的路径**捞出来。

    ⚠️ 不能用 `{r.path for r in app.routes}`：本仓的 FastAPI（0.141）把被 include 的 router
    包成一个 `_IncludedRouter` 标记对象，它**没有** `.path`、也**没有** `.routes`
    （本轮实测踩到，AttributeError）。OpenAPI schema 是稳定的那面镜子。
    """
    return set(app.openapi().get("paths", {}))


def test_stream_route_is_registered_and_not_public():
    """端点接线：路径必须在；且**不在**公开白名单（token 走 header，不进 URL —— §2.1）。"""
    from app.core import api_auth
    from app.main import app
    from app.routers import messages as R

    assert "/messages/stream" in _app_paths(app)
    assert "/messages/stream" in {r.path for r in R.router.routes}
    assert not api_auth.is_public("GET", "/messages/stream")
    assert not api_auth.is_public("POST", "/messages/_debug/publish")


def test_ack_endpoint_witnesses_a_readable_stream(monkeypatch, caplog):
    """`POST /messages/ack`：客户端"**真的读到了流**"的见证（M1，devlog/243）。

    为什么需要它：连接建起来（`fetch` resolve）≠ 客户端读得到字节 —— 某些 webview / 代理
    会把响应体缓冲住，那时服务端一切正常、客户端一条也收不到，而 M0 的停止条件正是
    "真机 WebView2 里读得出流吗"。这条端点把那件事变成**日志里一句话**。
    """
    import logging

    from fastapi.testclient import TestClient

    from app.core import config
    from app.core.api_auth import require_token
    from app.routers import messages as R

    monkeypatch.setattr(config.settings, "API_TOKEN", "", raising=False)
    monkeypatch.setattr(config.settings, "DEV_API_TOKEN", "dev-token", raising=False)

    app = FastAPI()
    app.middleware("http")(require_token)
    app.include_router(R.router)
    client = TestClient(app)

    # 没有 token ⇒ 401（它与推送通道同在门内，不是公开路径）
    assert client.post("/messages/ack", json={"seq": 1}).status_code == 401

    hub = M.HUB
    sub = hub.subscribe()
    try:
        with caplog.at_level(logging.INFO, logger="app.routers.messages"):
            resp = client.post("/messages/ack", json={"seq": 7},
                               headers={"X-DDToolkit-Token": "dev-token"})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"ok": True, "subscribers": 1, "seq": 7}
        assert "客户端已确认读到流" in caplog.text, "见证必须是**日志**（真机验收靠它）"
    finally:
        hub.unsubscribe(sub)

    # 坏 payload 不许 500（见证端点不该成为新的失败点）
    assert client.post("/messages/ack", json={"seq": "abc"},
                       headers={"X-DDToolkit-Token": "dev-token"}).status_code == 200


def test_debug_publish_route_is_dev_only(monkeypatch):
    """§8.3：合成发布钩子**只在 dev 态挂上**（生产不是"关着"，是**不存在**）。

    反向验证：把 `include_debug_routes` 里的守卫去掉 ⇒ 本用例红。
    """
    from app.core import config
    from app.routers import messages as R

    monkeypatch.setattr(config.settings, "API_TOKEN", "prod-token", raising=False)
    monkeypatch.setattr(config.settings, "DEV_API_TOKEN", "", raising=False)
    prod = FastAPI()
    assert R.include_debug_routes(prod) is False
    assert "/messages/_debug/publish" not in _app_paths(prod)

    monkeypatch.setattr(config.settings, "DEV_API_TOKEN", "dev-token", raising=False)
    dev = FastAPI()
    assert R.include_debug_routes(dev) is True
    assert "/messages/_debug/publish" in _app_paths(dev)


def test_debug_hook_publishes_end_to_end(monkeypatch):
    """端到端（探针要用的那条路）：**带 dev token 的 HTTP 请求 ⇒ 消息真的进了 hub**。

    这是"通道通了"的机器判据，也是 M0b 探针断言的前半段（后半段是"胶囊渲染出来"）。
    """
    from fastapi.testclient import TestClient

    from app.core import config
    from app.core.api_auth import require_token
    from app.routers import messages as R

    monkeypatch.setattr(config.settings, "API_TOKEN", "", raising=False)
    monkeypatch.setattr(config.settings, "DEV_API_TOKEN", "dev-token", raising=False)

    app = FastAPI()
    app.middleware("http")(require_token)
    app.include_router(R.router)
    assert R.include_debug_routes(app) is True

    hub = M.HUB
    client = TestClient(app)
    # ① 没有 token ⇒ 401（推送通道与钩子都在门内）
    assert client.post("/messages/_debug/publish",
                       json={"type": M.MSG_NOTICE_MESSAGE, "payload": {"text": "x"}}
                       ).status_code == 401
    # ② 带 token ⇒ 200，且消息进了 hub（环形缓冲里能查到 —— 这条不需要 drain）
    resp = client.post("/messages/_debug/publish",
                       headers={"X-DDToolkit-Token": "dev-token"},
                       json={"type": M.MSG_NOTICE_MESSAGE, "payload": {"text": "探针"}})
    assert resp.status_code == 200, resp.text
    seq = resp.json()["seq"]
    assert [m.payload["text"] for m in hub.replay_since(0)] == ["探针"]
    # ③ 未知类型 ⇒ 400（类型是隐式契约）
    bad = client.post("/messages/_debug/publish",
                      headers={"X-DDToolkit-Token": "dev-token"},
                      json={"type": "notice.nope", "payload": {}})
    assert bad.status_code == 400 and "未知消息类型" in bad.json()["detail"]
    assert hub.replay_since(0)[-1].seq == seq
    # ⚠️ 这里**不测投递**：投递要 drain 任务，而 `TestClient` 是同步的（会在事件循环里阻塞，
    #    把 drain 饿死 ⇒ 测试挂死）。投递由上面两条 hub 级用例（含跨线程那条）负责。


def test_main_registers_debug_routes_through_the_guarded_helper():
    """结构判据：`main.py` 必须走**带守卫的助手**，不能无条件挂 debug 路由。"""
    src = pathlib.Path("app/main.py").read_text(encoding="utf-8")
    assert "include_debug_routes" in src
    assert "include_router(messages.debug_router)" not in src
