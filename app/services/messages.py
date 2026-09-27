"""应用级**消息中心**（M0，devlog/241；方案 `docs/design/notices/message-hub-execution.md`）。

## 它解决什么

"点击按钮之后，别的窗口/别的组件怎么知道" —— 今天是**各自定期问**（`TopBar` 3s 忙 / 10s 闲
轮询 `/vtuber/fetch-status`），所以"点击 → 各终点看到"最坏要等 3–10s。延迟的 99% 就在这一段，
不在传输。本模块是**推送侧的单一产生方**：后端把事件发进来，所有订阅者（主窗口 / 小窗）
立刻收到。

## 分层消息类型（方案 §5）

- **领域事件**（`domain.*`）：数据变了 —— V 本体、账号快照、帖子、直播边沿；
- **派生通知**（`notice.*`）：给人看的 —— 进度 / 告警 / 报告 / 瞬时消息。

⚠️ **类型字符串是隐式契约**：前端按它分发。所以 `publish()` 对**不认识**的类型直接抛
`ValueError`（拼错一个字母就当场炸，而不是静默发出去没人理）。

## 三条刻意的设计（都有反例垫底）

1. **`publish()` 是同步的，且任何线程可调**。开播边沿产生在 T0 守护线程里
   （`scheduler.py` 的 `_live_poller_loop`），**那里没有事件循环**；而订阅者的队列绑在
   uvicorn 的循环上。⇒ 用一个线程安全的 `queue.Queue` 中转 + `loop.call_soon_threadsafe()`
   叫醒 drain 任务，**投递只在应用循环的线程里发生**。**"模块级 asyncio 原语"一个都不留**
   （`ARCHITECTURE.md` §6 第 15 条：综合档每轮一个 `asyncio.run()`，模块级 `asyncio.Lock`
   第二轮必抛 "bound to a different event loop"）—— `asyncio.Event` 在 `start()` 里
   **现造、每代重建**。
   ⚠️ **不要用 `run_in_executor(None, queue.get)` 那套"阻塞读放工作线程"**（本批第一版就是
   那么写的，被 `test_two_consecutive_lifespans_do_not_double_run` 逮住）：drain 被取消时
   那个工作线程**仍阻塞在 `get()` 上**，而 `asyncio.run()` 结束时要
   `shutdown_default_executor(wait=True)` 去 join 它 ⇒ **整个测试套挂死**
   （线程栈：`_do_shutdown` → `executor.shutdown` → `join` → `queue.get`）。
   顺带：每投递一条就过一次线程池往返，也白加了延迟 —— 而"降延迟"正是这个模块的全部意义。
2. **环形回放缓冲（50 条）+ 只在重连时补发**（方案 §8.5 D）。补发的消息带 `replay=True`，
   前端**不得**据此弹提示 —— 否则每次断线重连都会重播一串历史 toast。
3. **订阅者弱耦合**：每个订阅者一条有界队列（满了丢最旧的并计数），慢客户端**不会**
   拖住别人、也不会把内存吃光（方案 §7 的 R2）。

## 与 `fetch-status` 轮询的关系

**并存**，不是替代：轮询是一致性兜底（推送漏发、重连窗口内的消息）。本模块不做"退役轮询"。
"""
import asyncio
import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

logger = logging.getLogger(__name__)

# ── 消息类型（**隐式契约**：前端 `messageBus.ts` 按它分发；改名要两边同时改）──────
MSG_VTUBER_UPDATED = "domain.vtuber.updated"
MSG_ACCOUNT_SNAPSHOT = "domain.account.snapshot"
MSG_POSTS_CHANGED = "domain.posts.changed"
MSG_LIVE_EDGE = "domain.live.edge"

MSG_NOTICE_PROGRESS = "notice.progress"
MSG_NOTICE_ALERT = "notice.alert"
MSG_NOTICE_REPORT = "notice.report"
MSG_NOTICE_MESSAGE = "notice.message"

KNOWN_TYPES: frozenset[str] = frozenset({
    MSG_VTUBER_UPDATED, MSG_ACCOUNT_SNAPSHOT, MSG_POSTS_CHANGED, MSG_LIVE_EDGE,
    MSG_NOTICE_PROGRESS, MSG_NOTICE_ALERT, MSG_NOTICE_REPORT, MSG_NOTICE_MESSAGE,
})

RING_SIZE = 50              # 回放缓冲长度（方案 §8.5 D 定稿）
SUBSCRIBER_QUEUE_SIZE = 200  # 单个订阅者的积压上限（满了丢最旧的）
HEARTBEAT_SECONDS = 15.0    # SSE 心跳间隔（防中间层把空闲连接掐掉）


def now() -> float:
    """服务端时间（epoch 秒）。单独抽出来便于测试替换。"""
    return time.time()


@dataclass(frozen=True)
class Message:
    """一条消息。`seq` 是**进程内单调序号**，直接当 SSE 的 `id:`（重连补发用）。"""

    type: str
    payload: dict
    ts: float
    seq: int = 0
    # 只在**重连补发**时为 True（方案 §8.5 D：前端据此不弹提示）
    replay: bool = False

    def to_json(self) -> dict[str, Any]:
        return {"type": self.type, "payload": self.payload, "ts": self.ts,
                "seq": self.seq, "replay": self.replay}


@dataclass
class Subscription:
    """一个订阅者：一条有界队列 + 丢弃计数（慢客户端的可见证据）。"""

    queue: "asyncio.Queue[Message]" = field(default_factory=lambda: asyncio.Queue(
        maxsize=SUBSCRIBER_QUEUE_SIZE))
    dropped: int = 0


class MessageHub:
    """消息中心：类型校验 → 环形缓冲 → 投递给所有订阅者。

    ⚠️ 生命周期：`start()` / `stop()` 由 **lifespan** 调用（`app/main.py`）。
    没 `start()` 时 `publish()` 照样能用（只进环形缓冲）—— 这样单元测试与
    "调度线程先于 lifespan 发布"都不会炸。
    """

    def __init__(self, *, ring_size: int = RING_SIZE, clock=now) -> None:
        self._clock = clock
        self._seq = 0
        self._lock = threading.Lock()          # 保护 _seq / _ring / _subs（跨线程）
        self._ring: list[Message] = []
        self._ring_size = ring_size
        self._subs: list[Subscription] = []
        # 跨线程投递的中转：publish()（任意线程）→ queue → drain（应用循环）
        self._inbox: "queue.Queue[Message]" = queue.Queue()
        self._drain_task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._wake: asyncio.Event | None = None    # 在 start() 里现造（不许跨代复用）

    # ── 发布（**同步、任何线程可调**）────────────────────────────────
    def publish(self, type: str, payload: dict | None = None) -> int:
        """发布一条消息，返回它的 `seq`。

        ⚠️ **不要在事务中间调它**（方案 §2.2）：消息发出去收不回，而事务可能回滚 ⇒
        订阅者会收到一条"从未发生过"的事件。发布点一律放在 `db.commit()` **之后**。

        ⚠️ 未知 `type` 抛 `ValueError`（类型是隐式契约，拼错要当场炸）。
        """
        if type not in KNOWN_TYPES:
            raise ValueError(f"未知消息类型 {type!r}（允许：{sorted(KNOWN_TYPES)}）")
        with self._lock:
            self._seq += 1
            msg = Message(type=type, payload=dict(payload or {}),
                          ts=self._clock(), seq=self._seq)
            self._ring.append(msg)
            if len(self._ring) > self._ring_size:
                del self._ring[: len(self._ring) - self._ring_size]
        # 没 start() 过也照收（只进环）；start() 之后由 drain 投递
        self._inbox.put_nowait(msg)
        self._wake_drain()
        return msg.seq

    def _wake_drain(self) -> None:
        """把 drain 从 `await` 里叫醒。**从任何线程调都安全**（`call_soon_threadsafe`）。

        ⚠️ 这里**只叫醒、不投递**：投递必须发生在应用循环的线程里（订阅者的队列绑在那个
        循环上），而 `publish()` 会被 T0 守护线程调用 —— 那里没有循环。
        """
        loop, wake = self._loop, self._wake
        if loop is None or wake is None:
            return                      # 没 start()/已 stop()：消息留在环里，下次 start 清积压
        try:
            loop.call_soon_threadsafe(wake.set)
        except RuntimeError:
            pass                        # 循环正在关：留给环形缓冲，别把发布方炸掉

    # ── 订阅 ────────────────────────────────────────────────────────
    def subscribe(self) -> Subscription:
        sub = Subscription()
        with self._lock:
            self._subs.append(sub)
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        with self._lock:
            if sub in self._subs:
                self._subs.remove(sub)

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subs)

    # ── 回放（重连用）────────────────────────────────────────────────
    def replay_since(self, last_event_id: int) -> list[Message]:
        """`seq > last_event_id` 的消息（带 `replay=True`）。**只在重连时调用。**"""
        with self._lock:
            newer = [m for m in self._ring if m.seq > int(last_event_id or 0)]
        return [Message(type=m.type, payload=m.payload, ts=m.ts, seq=m.seq,
                        replay=True) for m in newer]

    # ── 生命周期（lifespan）──────────────────────────────────────────
    def start(self) -> None:
        """记下当前事件循环、现造唤醒原语、起 drain 任务。**幂等**（同代起两次不会有两套）。

        每一代（每次 `start()`）都**重建** `asyncio.Event`：它绑在造它的那个循环上，
        跨循环复用必抛 "bound to a different event loop"（`ARCHITECTURE.md` §6 第 15 条）。
        """
        loop = asyncio.get_running_loop()
        if (self._drain_task is not None and not self._drain_task.done()
                and self._loop is loop):
            return                                  # 同一代里重复 start：不重建
        self._loop = loop
        self._wake = asyncio.Event()                # 现造，绑当前循环
        self._drain_task = loop.create_task(self._drain())

    async def stop(self) -> None:
        """停 drain（幂等、可重复调）。停完之后仍可 `publish()`（只进环）。"""
        task, self._drain_task = self._drain_task, None
        self._loop = None                           # 先断唤醒路径，再取消任务
        if task is None:
            self._wake = None
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        finally:
            self._wake = None

    async def _drain(self) -> None:
        """把中转队列里的消息投给订阅者。

        ⚠️ **不要**改成 `await loop.run_in_executor(None, self._inbox.get)`（"阻塞读丢给工作
        线程"那套）：drain 被取消时工作线程仍阻塞在 `get()` 上，而 `asyncio.run()` 收尾要
        `shutdown_default_executor(wait=True)` join 它 ⇒ 进程挂死（本批实测，见模块 docstring）。
        这里用 **`call_soon_threadsafe` 唤醒 + `get_nowait` 清空**：不占线程、也不用哨兵。
        """
        while True:
            self._drain_pending()                   # 先清积压（含 start() 之前发的）
            wake = self._wake
            if wake is None:
                return                              # stop() 了：剩下的留给环形缓冲
            await wake.wait()
            wake.clear()                            # 清在 wait 之后 ⇒ 不会丢唤醒

    def _drain_pending(self) -> None:
        while True:
            try:
                msg = self._inbox.get_nowait()
            except queue.Empty:
                return
            self._deliver(msg)

    def _deliver(self, msg: Message) -> None:
        with self._lock:
            subs = list(self._subs)
        for sub in subs:
            try:
                sub.queue.put_nowait(msg)
            except asyncio.QueueFull:
                # 慢客户端：丢最旧的，保证"最新的还在"（方案 §7 R2 的缓解）
                sub.dropped += 1
                try:
                    sub.queue.get_nowait()
                    sub.queue.put_nowait(msg)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass
                if sub.dropped % 50 == 1:
                    logger.warning(f"推送订阅者积压，已丢弃 {sub.dropped} 条（客户端太慢）")


# 进程内单例（生产用；测试自己 new 一个，见 `tests/test_messages.py` 的 fixture）
HUB = MessageHub()
