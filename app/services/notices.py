"""通知汇总（M5-1，devlog/253）—— **事实 → `Notice[]`** 的单一真源（目标架构 §2/§3）。

## 本批只做「后端供数」这一半

| 批次 | 内容 | 状态 |
|---|---|---|
| **M5-1（本文件）** | `services/notices.py` + `GET /vtuber/notices` + `POST /vtuber/notices/ack`（已读进 `app_meta`）+ 契约判据 | ✅ |
| **M5-2a** | 供数补全：`manual_running` 进端点 + 报告只对全量轮出 | ✅ devlog/258 |
| **M5-2b** | `TopBar` 删掉自己那份 `useMemo` 汇总（改用 `useNotices`）、小窗改拉同一端点、退役 `widget:notices`、删 `kickPoll`、报告「知道了」接 `ack` | ✅ devlog/259 |

为什么必须分开：M5-2 会**改用户可见的通知行为**（报告何时弹、进度由谁供），
判据/探针/真机验收的量级与 M5-1 相当；混在一批里做，出问题时分不清是"供数错了"还是"切换错了"。

## 五类事实（与前端 `notificationHub` 的旧口径逐条对齐）

① 任务进度（**自动节拍不产生条目** —— 2026-09-10 用户口径：频繁轮询不必占顶栏）
② 风控冷却（此前只在日志里）③ 登录失效 ④ 完成报告 ⑤ 开播边沿 / 瞬时消息（环形缓冲 + TTL）

## 「目睹才报」怎么落地（§8.5 拍板 C：保留，用**订阅者注册表**表达"谁在看"）

旧口径住在主窗口的四个 `useRef` 里：**轮询看见过这次运行**（`sawPostRun`）且它已经结束，
才弹完成报告 —— 目的是"用户没看见过程就别打扰"。后端版本把"谁在看"表达成
**推送通道有没有订阅者**（`HUB.subscriber_count() > 0`），在**任务收尾的那一刻**采样，
随 `(kind, seq)` 记在进程内（`note_run`）。三处差异都写在这：

- 主窗口开着 ⇒ 它有一条 SSE ⇒ 与旧行为**等价**；
- 主窗口收进托盘/隐藏 ⇒ 旧行为**不报**（轮询停了，没人"看见"），新行为**报** ——
  这正是 M1 立的规矩（"收进托盘后该知道的仍要知道"），且报告是**已读持久化**的，
  用户回来点一次「知道了」就不再出现；
- 应用启动**之前**就结束的那一轮 ⇒ 没有订阅者 ⇒ 不报（与旧的"首次轮询只记基线"等价）。

⚠️ **进程重启即遗忘**（`_status` 与这里的 `_witness` 都在内存里）：报告本来就是这样
（`last_result` 不落库）。落库的只有**已读**（`app_meta`），这正是本批要修的那件事。
"""
import json
import logging
import threading
import time
from collections import deque
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.repositories.vtuber_repo import AppMetaRepo

logger = logging.getLogger(__name__)

# ── 口径常量（与前端逐字对齐；M5-2 切换后**以后端这份为准**）──────────────
KIND_PRIORITY = {"alert": 4, "progress": 3, "report": 2, "message": 1}

#: **三形态**（L1，`docs/design/notices/channel-and-layering.md` §2.2，2026-10-05）。
#: 与 `kind` 正交：`kind` 管**长相**（字形/点色），`form` 管**行为**（活多久、怎么消失、能不能被顶掉）。
#: ⚠️ 不要用 `kind` 推 `form`：两者今天恰好一一对应，但那是巧合 ——
#: 报告曾是 `alert`（风控冷却）也曾经要和 `progress` 抢胶囊，混着用会在下一次改口径时静默出错。
FORM_STATE = "state"      # 现在有什么在发生（进度 / 冷却 / 登录失效）：跟事实同寿命，不倒数
FORM_NOTICE = "notice"    # 刚刚发生了什么（开播 / 同步完成 / 新版本）：有 TTL，自动已读
FORM_ACTION = "action"    # 需要用户决定（完成报告）：常驻到用户确认

#: **已读方式**（L4，设计案 §3.1）。两条语义不同的东西，不能共用一个字段：
#: - `READ_AUTO`：到点自己消失 —— "已经过去了"，不需要谁确认（告知类、以及**状态类**）；
#: - `READ_CONFIRM`：只能用户确认（落 `app_meta` 的已读集合）—— "你得看一眼"。
#: ⚠️ **状态类的 read 是 auto 但含义与告知类不同**：它消失是**事实变了**（任务结束了），
#: 不是"用户看过了"。所以它**既不进已读集合、也不该被「一键已读」清掉**
#: （清掉之后同一条状态再次成立——例如再次限流——会被集合里的旧 id 误判成已读）。
READ_AUTO = "auto"
READ_CONFIRM = "confirm"

#: 瞬时消息的展示时长：前端 `utils/noticeStream.ts::PILL_MS`（= `notificationHub.EVENT_TTL_MS`）。
#: ⚠️ L1（2026-10-05）从 4000 提到 6000（设计案 §3.1「告知类默认时长」）——
#: **三处必须同值**（这里 / `PILL_MS` / `EVENT_TTL_MS`），改一处不改另两处会让"同一条消息
#: 在两扇窗里活的时间不一样"（`tests/test_notices.py` 有对账用例）。
MSG_TTL_MS = 6000
# 开播告警的展示时长：前端 `utils/notificationHub.ts::LIVE_NOTICE_MS`
LIVE_TTL_MS = 2 * 60_000
# 已读集合的上限（防 `app_meta` 那条 JSON 无限长）
READ_LIMIT = 50
# 环形缓冲容量（瞬时消息 + 开播边沿共用一个）
RING_MAX = 20
#: 出**常驻报告**的轮次类型（其余是瞬时胶囊）：与前端旧口径一致（`TopBar` 只对全量开报告框）
REPORT_KINDS = ("full_all", "full_vtuber")

# 任务名：**与 `services/scheduler.TASK_TEXT` 逐字对齐**（L2）。
# ⚠️ 为什么是**副本**而不是 import 那一份：本模块顶层 import 了 `scheduler.get_fetch_status`
# 吗？没有 —— 那是**函数内局部 import**（为了避开循环）。而 `scheduler` 顶层 import 了本模块，
# 所以这里**不能**顶层 import 它。两份漂了的症状很具体：推送那条进度说「全量抓取中」、
# 轮询那条说「帖子抓取中」（同一条任务两种说法）。
# ⇒ 对账落在 `tests/test_notices.py::test_task_text_tables_match`（反向验证：改一份当场红）。
TASK_TEXT = {
    "account": "账号信息抓取中",
    "dynamic": "动态轮询中",
    "update": "动态更新中",
    "full": "全量抓取中",
    "quick": "帖子抓取中",
    "adopt": "首屏抓取中",
}

_LOCK = threading.RLock()
# (notice_dict, 插入时刻 ms)：插入时刻用于 TTL 判定 —— **不是渲染时刻**
_ring: deque[tuple[dict, float]] = deque(maxlen=RING_MAX)
# 任务收尾时的"有没有人在看"：(kind, seq) → bool
_witness: dict[tuple[str, int], bool] = {}

READ_KEY = "notices.acked"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _ms(dt: datetime | None) -> int | None:
    """naive UTC datetime → 毫秒时间戳（库内时间一律 naive UTC）。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


# ── 写入侧：谁在什么时候记了什么 ────────────────────────────────────────

def record_message(text: str, *, source: str = "操作结果") -> None:
    """记一条瞬时消息（手动动作完成时由 `routers/vtuber.py` 调用）。

    它是**事实**不是渲染：TTL 从**记下来的时刻**起算（`build_notices` 只做过滤），
    所以同一条消息无论被拉多少次，过期时刻都不会往后漂。
    """
    t = (text or "").strip()
    if not t:
        return
    with _LOCK:
        _ring.append(({
            "id": f"msg-{_now_ms()}", "kind": "message", "text": t, "source": source,
        }, _now_ms()))


def record_live_edge(payload: dict) -> None:
    """记一条开播边沿（T0 检测到"开播了"时调用）→ alert（优先级高于 progress）。"""
    name = str(payload.get("name") or "").strip()
    account_id = payload.get("account_id")
    if not name or account_id is None:
        return
    with _LOCK:
        _ring.append(({
            "id": f"live-{account_id}", "kind": "alert",
            "text": f"{name} 开播了",
            "detail": (str(payload.get("live_title") or "").strip() or None),
            "source": "开播",
        }, _now_ms()))


def note_run(kind: str, seq: int, *, witnessed: bool) -> None:
    """记下"这一轮任务收尾时有没有人在看"（见文件头「目睹才报」）。"""
    with _LOCK:
        _witness[(kind, int(seq))] = bool(witnessed)
        if len(_witness) > 200:                    # 进程内小账本，别无限长
            for k in sorted(_witness, key=lambda x: x[1])[:100]:
                _witness.pop(k, None)


def witnessed(kind: str, seq: int) -> bool:
    with _LOCK:
        return _witness.get((kind, int(seq)), False)


def reset_state() -> None:
    """清空进程内小账本（**单测用**：跨用例串味会让"目睹才报"那条判据时绿时红）。"""
    with _LOCK:
        _ring.clear()
        _witness.clear()


def drop_ring(notice_ids: list[str] | tuple[str, ...] | set[str]) -> list[str]:
    """把用户**点掉的那几条**从环形缓冲里摘掉，返回真的摘掉了哪些 id。

    为什么环里这一份必须**真的删**、而不是像完成报告那样靠"已读集合"过滤（2026-10-05 修）：

    ① **id 的寿命不一样**：`msg-<ms>` 是一次性事件的 id，而 `live-<account_id>` 是
       **按账号稳定**的。若靠已读集合过滤，用户点掉一次开播 ⇒ 那个账号**下次开播**
       会被同一条历史已读一起吞掉（"再次开播却什么都不显示"）——
       与 `is_state_id` 那里防的是同一类 bug，只是它藏在"已读"这个词里不容易看见；
    ② 环里的条目**没有别的消费者**：用户点"已读"的语义就是"这条别给我看了"，
       删掉它就是这句话最准确的表达（到点过期走的也是同一条移除路径）。

    于是 `msg-*` / `live-*` 这类 id **不写进已读集合**（那会白占 `READ_LIMIT` 的格子、
    把真正需要持久化的处置类挤出去），"已读"就落在"删掉"这个动作上。
    """
    want = {str(x).strip() for x in notice_ids if str(x).strip()}
    if not want:
        return []
    with _LOCK:
        kept = [(item, at) for item, at in _ring if str(item.get("id") or "") not in want]
        dropped = [str(item.get("id")) for item, _ in _ring
                   if str(item.get("id") or "") in want]
        if dropped:
            _ring.clear()
            _ring.extend(kept)
    return dropped


def _acked_reply(persisted: list[str], dropped: list[str]) -> list[str]:
    """接口回给前端的"这些现在都不该再显示了"：**落库的 + 从环里删掉的**（去重、保序）。

    前端拿它立刻 `filter` 掉本地那一份（点完就滑出，不必等下一条轮询）——
    少算了"删掉的"那一半，观感就是用户报的"点了没反应"。
    """
    return list(dict.fromkeys([*dropped, *persisted]))


# ── 已读（唯一落库的那部分）────────────────────────────────────────────

def read_ids(db: Session) -> list[str]:
    raw = AppMetaRepo(db).get(READ_KEY)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning(f"{READ_KEY} 不是合法 JSON，按空处理：{raw[:80]!r}")
        return []
    return [str(x) for x in data] if isinstance(data, list) else []


def ack_notice(db: Session, notice_id: str) -> list[str]:
    """记一条通知已读（**幂等**：同一个 id 记两次结果一样）。返回**已受理**的 id 列表。

    为什么必须落库：今天「知道了」只 `setDoneReport(null)` 清内存 ⇒ 刷新 / 深休眠重建
    之后**报告原地复活**（目标架构 §2.3 要修的就是这条）。

    ⚠️ **状态类不许 ack**（L4）：`rate-limit` / `login-expired` / `progress-*` 的 id 是
    **稳定**的，一旦进了已读集合，同一条状态**再次成立**时会被 `_report_notices` 那类
    过滤误判成"用户看过了"（症状：再次被限流却什么都不显示）。所以这里直接拒收 ——
    前端也不该给状态类发 ack（它消失是事实变了，不是用户点了什么）。

    ⚠️ **环里的条目（瞬时消息 / 开播边沿）走"删掉"而不是"落库"**（2026-10-05 修，
    用户报的"点了已读没反应"就是它）：理由见 `drop_ring`（`live-<account>` 是按账号
    **稳定**的 id，落库会吞掉这个账号**下一次**开播）。
    """
    nid = (notice_id or "").strip()
    if is_ring_id(nid):
        # 环里的：删掉就是已读。**不管这一拍它在不在环里都回给前端** —— 这个 id 已经
        # 不可能再出现（要么刚被删掉、要么本来就过期了），前端照它过滤掉本地那份。
        return _acked_reply(read_ids(db), [*drop_ring([nid]), nid])
    if is_state_id(nid):
        logger.info(f"忽略对状态类条目的已读请求（id={nid}）：它消失是事实变了，不是用户看过了")
        return read_ids(db)
    ids = read_ids(db)
    if not nid or nid in ids:
        return ids
    ids = [nid, *ids][:READ_LIMIT]
    AppMetaRepo(db).set(READ_KEY, json.dumps(ids, ensure_ascii=False))
    return ids


#: 状态类条目的 id（**稳定 id** ⇒ 不能进已读集合，见 `ack_notice`）。
#: `progress-*` 与 `report-*` 都是稳定 id，但语义相反：前者是状态（不许 ack）、
#: 后者是处置（**必须** ack）。这张表只列"不许 ack"的那些。
_STATE_IDS = ("rate-limit", "login-expired")
_STATE_PREFIXES = ("progress-", "pushed-progress")


def is_state_id(notice_id: str) -> bool:
    """这个 id 是不是**状态类**（不许被 ack 掉）？"""
    nid = (notice_id or "").strip()
    return nid in _STATE_IDS or nid.startswith(_STATE_PREFIXES)


#: 环形缓冲里那两类条目的 id 前缀（`record_message` / `record_live_edge` 各一个）。
#: ⚠️ 这两类**不进已读集合**：它们是**进程内**事件的 id（`live-<account_id>` 还是按账号
#: 稳定的）⇒ 记成已读会让"这个账号下次开播"被当成看过。用户的"已读"落在**删掉**这个动作上
#: （`drop_ring`）。与 `_STATE_PREFIXES` 同一写法：把"哪些 id 属于哪一类"收成一处可见的表。
_RING_PREFIXES = ("msg-", "live-")


def is_ring_id(notice_id: str) -> bool:
    """这个 id 是不是**环里**那两类（瞬时消息 / 开播边沿）？"""
    return (notice_id or "").strip().startswith(_RING_PREFIXES)


def ack_notices(db: Session, notice_ids: list[str]) -> list[str]:
    """一次记多条已读（面板的「一键已读」，L1）。返回**已受理**的 id 列表。

    为什么要有批量口：前端循环发 N 次单条 ack 会出现"清到一半失败、面板半干净"的中间态，
    而用户看到的是一次点击。整批一次写盘，幂等与上限口径与单条那条**逐字相同**。

    ⚠️ 状态类 id 在这一层就被滤掉（L4，同 `ack_notice`）—— 「一键已读」清的是
    「最近」+「需要处理」两组（`ackAllIds`），状态类只在「正在进行」里；这条过滤是
    **第二道防线**（前端传错了、或将来有人把状态类塞进那一组时，别静默写进已读集合）。

    ⚠️ 环里的条目（`msg-*` / `live-*`）**从环里删掉、不落库**（与单条那条同一口径，
    理由见 `drop_ring`）：用户点「全部已读」时「最近」那一组常常正是这些，
    少了这一半就又是"点了没反应"（这一条正是 2026-10-05 用户报的那句话）。
    """
    clean = [str(x).strip() for x in (notice_ids or []) if str(x).strip()]
    ring = [x for x in clean if is_ring_id(x)]
    drop_ring(ring)                       # 删掉就是已读（回给前端的那份见下面 `_acked_reply`）
    fresh = [x for x in clean if not is_state_id(x) and not is_ring_id(x)]
    skipped = len(clean) - len(fresh) - len(ring)
    if skipped:
        logger.info(f"批量已读跳过了 {skipped} 条状态类条目（它们不是'用户看过了'）")
    ids = read_ids(db)
    add = [x for x in fresh if x not in ids]
    if add:
        # 新来的排在前面（与单条那条同序），**去重后再截断**（同一批里重复给同一个 id 不该占两格）
        ids = list(dict.fromkeys([*add, *ids]))[:READ_LIMIT]
        AppMetaRepo(db).set(READ_KEY, json.dumps(ids, ensure_ascii=False))
    return _acked_reply(ids, ring)


# ── 汇总（读路径；纯函数式：只看传进来的事实 + 进程内小账本 + 已读集合）──────

def compose_task_text(task_label: str, who: str | None = None,
                      index: int | None = None, total: int | None = None) -> str:
    """`任务名 - V名 - i/N`（空段跳过；total<=0 不显示进度）—— 与前端同格式。"""
    parts = [task_label]
    if who:
        parts.append(str(who))
    if total and total > 0:
        parts.append(f"{index or 0}/{total}")
    return " - ".join(parts)


def _progress_notices(status: dict, now_ms: int) -> list[dict]:
    out: list[dict] = []
    for key, label_key in (("post", "task"), ("account", "task")):
        st = status.get(key) or {}
        if not st.get("running") or st.get("auto"):
            continue                      # 自动节拍不占顶栏（2026-09-10 用户口径）
        task = st.get(label_key) or ("quick" if key == "post" else "account")
        who = st.get("vtuber_name") or st.get("target") or st.get("current")
        out.append({
            "id": f"progress-{key}", "kind": "progress", "form": FORM_STATE,
            "text": compose_task_text(TASK_TEXT.get(task, "抓取中"), who,
                                      st.get("index"), st.get("total")),
            "source": "任务进度",
            # 状态类的 `createdAt` = **状态开始成立**的时刻（面板显示"进行中 3 分钟"）。
            # 缺 `started_at`（老调度器/单测造的 status）⇒ 退回 now，不猜。
            "createdAt": int(st.get("started_at") or now_ms),
        })
    ext = status.get("external") or {}
    # ⚠️ L1 修（2026-10-05）：这里原先**不看 auto** —— 而"自动节拍不占顶栏"是全局口径。
    #    收录回填 / 每日批次由定时档发起（auto=True）却照样产生常驻进度条目，
    #    一条没有终局的进度会把胶囊一直占着（正是 devlog/089 那条口径要消掉的形态）。
    #    漏的原因很具体：`external` 状态里当时根本没有 `auto` 字段，判据无从写起 —— 现在调度器补上了。
    if ext.get("running") and not ext.get("auto"):
        out.append({
            "id": "progress-external", "kind": "progress", "form": FORM_STATE,
            "source": "第三方同步",
            "text": f"正在同步{ext.get('label') or '第三方数据'}",
            "createdAt": int(ext.get("started_at") or now_ms),
        })
    return out


def _rate_limit_notice(status: dict, now_ms: int) -> dict | None:
    rl = status.get("rate_limit") or {}
    if not rl.get("active"):
        return None
    secs = max(0, round(float(rl.get("seconds_left") or 0)))
    return {
        "id": "rate-limit", "kind": "alert", "form": FORM_STATE,
        "text": "上游限流：冷却中",
        # `value` = 活数据（目标架构 §2.2 新增槽位）：倒计时自己刷新，**不重排文案**
        "value": f"{secs}s",
        "detail": (rl.get("reason") or None),
        "source": "风控冷却",
        "expiresAt": now_ms + secs * 1000,
        # 冷却**开始**的时刻 = 现在 + 还要等多久 − 整段窗口（`window_seconds` 有就给）
        "createdAt": now_ms - max(0, int(float(rl.get("window_seconds") or 0)) - secs) * 1000,
    }


def _login_notice(now_ms: int) -> dict | None:
    from app.services.auth import (SESSDATA_NOMINAL_DAYS, SESSDATA_WARN_DAYS,
                                   auth_manager)      # 局部导入：避免启动期循环

    if auth_manager.needs_login():
        return {
            "id": "login-expired", "kind": "alert", "form": FORM_STATE,
            "text": "B 站登录已失效",
            "detail": "抓取会跳过需要登录的部分；重新扫码后自动恢复",
            "source": "登录态", "sticky": True,
            "action": {"label": "去登录", "kind": "login"},
            # 登录失效没有"开始时刻"可查（会话什么时候过期平台不说）⇒ 用 now，
            # 面板上它显示"刚刚"，语义是"我们刚发现"
            "createdAt": now_ms,
        }
    # 临期提醒（2026-10-08，`devlog/455`）：B 站 web 会话标称寿命约一个月，而**过期是突然的**
    # —— 与其等它失效后抓取静默少一半，不如在到点前说一句"抽空重登一次"。
    # 判据只认 `set_at`（用户侧新登录/新导入时盖的章），**不拿".env 最后写入时间"顶替**：
    # 内部续期刷新也会写 .env，那样算出来的"用了多久"永远从零开始。
    age = auth_manager.age_days()
    if age is not None and age >= SESSDATA_WARN_DAYS:
        return {
            "id": "login-aging", "kind": "warn", "form": FORM_ACTION,
            "text": f"B 站登录已 {age:.0f} 天，可能随时过期",
            "detail": (f"平台给的标称寿命约 {SESSDATA_NOMINAL_DAYS} 天；过期后需要登录才能抓的"
                       f"部分会静默停下，抽空重登一次最省事"),
            "source": "登录态", "sticky": False,
            "action": {"label": "去登录", "kind": "login"},
            "createdAt": now_ms,
        }
    return None


def _report_notices(status: dict, acked: set[str], now_ms: int) -> list[dict]:
    """完成报告：**只在"有人看着它跑完"时出**（见文件头「目睹才报」）+ 已读的不再出。

    ⚠️ **还要只对"全量"轮出**（`REPORT_KINDS`）—— 与前端旧口径逐字一致（`TopBar` 只对
    `full_all` / `full_vtuber` 开报告框，其余走**瞬时胶囊**）。
    少了这道过滤的后果很具体：`quick`（手动"抓取帖子"）与 `adopt`（收录首屏）**都**会
    走 `_set_post_last_result`，而 `witnessed` 在主窗口开着时恒为真 ⇒ 每次手动抓帖都会留下
    一条写着"**全量**帖子抓取完成"的常驻条目 + 一个「查看详情」。
    （M5-1 期间没有消费者 ⇒ 看不出来；M5-2 一接上前端就会看到。判据
    `test_quick_run_produces_no_report` 钉这一点。）
    """
    res = (status.get("post") or {}).get("last_result") or {}
    seq = res.get("seq")
    if seq is None or not witnessed("post", seq):
        return []
    if (res.get("kind") or "") not in REPORT_KINDS:
        return []
    nid = f"report-{seq}"
    if nid in acked:
        return []
    issues = res.get("issues") or []
    detail = None
    if res.get("video_missing"):
        detail = f"视频可能缺 {res['video_missing']} 条"
    elif issues:
        detail = f"{len(issues)} 处中断（{issues[0].get('stop_reason')}）"
    return [{
        "id": nid, "kind": "report", "form": FORM_ACTION,
        "text": f"全量帖子抓取完成 · 存储 {res.get('stored') or 0} · 跳过 {res.get('skipped') or 0}",
        "detail": detail, "source": "完成报告", "sticky": True,
        "action": {"label": "查看详情", "kind": "open-report"},
        # 报告是**处置类**：`createdAt` = 报告生成时刻（那轮的收尾时间，查不到就用 now）
        "createdAt": int(res.get("finished_at") or now_ms),
    }]


def _ring_notices(now_ms: int) -> list[dict]:
    out: list[dict] = []
    with _LOCK:
        for item, at in _ring:
            ttl = LIVE_TTL_MS if item["kind"] == "alert" else MSG_TTL_MS
            if at + ttl <= now_ms:
                continue                        # 到点自己消失（**起算点是记录时刻**）
            out.append({**item, "form": FORM_NOTICE,
                        "expiresAt": at + ttl, "createdAt": int(at)})
    return out


def _read_mode(form: str) -> str:
    """形态 → 已读方式（L4）。**显式写下来**，不从 `form` 隐式推导：

    - `notice`（告知）→ `auto`：到点自己消失（"已经过去了"）；
    - `action`（处置）→ `confirm`：只能用户确认（落 `app_meta`）；
    - `state`（状态）→ `auto`，**但含义与告知不同**：它消失是"事实变了"，不是"用户看过了"
      ⇒ 它不进已读集合、也不该被「一键已读」清掉（清了之后同一条状态再次成立会被误判成已读）。

    为什么不做成 `form == "action"` 那种一行推导：两者今天一一对应是**巧合** ——
    "要不要用户确认"与"这是什么形态"是两个问题（将来完全可能出现"需要确认的状态"或
    "自动过期的处置"）。把它写成一张表，接下一个平台的人就有一处可改、也看得见语义。
    """
    return READ_CONFIRM if form == FORM_ACTION else READ_AUTO


def _normalize(n: dict) -> dict:
    """把一条通知补齐成**完整键集合**（缺的填 None/False）。

    为什么必须补齐：契约用例断的是"键集合"，而 `NoticeOut` 只在**走 HTTP 时**才补默认值
    —— 直接调 `build_notices` 的那条路径会出现"少一个键"的假象，两种路径的契约就分叉了。
    补齐之后，**任何**消费方拿到的形状都一样（前端 `Notice` 的字段全集）。

    `form` 兜底成 `state`：拿不到形态时**宁可说"它是个状态"**（状态不自动消失、
    不参与自动已读），也不要猜成 `notice` 把一条处置类信息悄悄读掉。
    """
    out = {"id": n["id"], "kind": n["kind"], "text": n["text"], "value": None,
           "detail": None, "source": None, "sticky": False, "expiresAt": None,
           "createdAt": None, "form": FORM_STATE, "read": READ_AUTO, "action": None}
    out.update(n)
    out["read"] = _read_mode(out["form"])
    return out


def build_notices(db: Session, *, status: dict | None = None,
                  now_ms: int | None = None) -> dict:
    """汇总成 `{"now": ms, "notices": [...], "manual_running": bool}`（**已按优先级排序**）。

    `manual_running` 与 `notices` 同一趟给出（M5-2 的前置）：顶栏的按钮禁用判定读它
    （`fetch-status` 里也有同一字段，但两扇窗各自多打一个端点不如顺手带出来）；
    `devlog/245` 记的"删 `kickPoll` 之前要先把 `manual_running` 送进推送/端点"就是这一条。
    """
    from app.services.scheduler import get_fetch_status    # 局部导入：循环依赖

    now = _now_ms() if now_ms is None else int(now_ms)
    st = get_fetch_status() if status is None else status
    acked = set(read_ids(db))

    notices: list[dict] = []
    notices += _progress_notices(st, now)
    rl = _rate_limit_notice(st, now)
    if rl:
        notices.append(rl)
    lg = _login_notice(now)
    if lg:
        notices.append(lg)
    notices += _report_notices(st, acked, now)
    notices += _ring_notices(now)

    notices = [_normalize(n) for n in notices]
    notices.sort(key=lambda n: -KIND_PRIORITY.get(n["kind"], 0))
    manual_running = bool(st.get("manual_running"))
    return {"now": now, "notices": notices, "manual_running": manual_running}
