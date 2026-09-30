---
doc: backend/messages
class: module
scope: 状态通道与通知：消息的类型分层、取数与合并口径、已读、跨进程分发到桌面小窗
not-scope: 前端怎么渲染消息 → frontend/UI-MAP.md；抓取进度本身怎么产生 → backend/FETCH-PIPELINE.md
sot: app/services/messages.py, app/services/notices.py, app/routers/messages.py
verify: python -m pytest -q tests/test_messages.py
budget: 700
retire-when: 消息中心重新设计，或推送通道换掉
---

## 1. 状态通道

`_status`（模块级 dict）+ `_push_account_snapshot()` 队列 → `GET /vtuber/fetch-status`
→ 前端 TopBar 轮询（~2s）→ 左栏徽标 / 右栏卡片实时合并（`recent` 增量快照）。
T0 的进度反馈就是这条通道（无进度条、无胶囊）。

**2026-09-27 起多了一条推送通道（M0，devlog/241）**：`app/services/messages.py::MessageHub`
+ `GET /messages/stream`（SSE over fetch，token 走 header）。领域事件（`domain.*`）与
派生通知（`notice.*`）由后端**主动**推给所有订阅者（主窗口 / 小窗），不再等下一次轮询
—— "点击 → 各终点看到"最坏 3–10s 的延迟，99% 就耗在"等下次轮询"上。
`publish()` **同步、任何线程可调**（开播边沿在 T0 守护线程里产生），经 `queue.Queue`
中转到应用循环投递。**两条通道并存**：轮询是一致性兜底（推送漏发 / 重连窗口），
M0 **不退役**轮询。细节与不变量见 `docs/backend/HTTP-CONTRACT.md` §1.5。

**当前的真实发布方**（谁在 `publish` —— 有一张清单比散着找可靠）：

| 发布方 | 消息 | devlog |
|---|---|---|
| T0 开播边沿（`scheduler.py`，`commit` **之后**） | `domain.live.edge` | 243 |
| 三个手动端点（受理 / 完成各一条） | `notice.progress` / `notice.message`（带 `originator`） | 244 |
| `_push_account_snapshot`（账号抓取提交后） | `domain.account.snapshot` | 246 |
| `_set_post_last_result`（一轮帖子抓取收尾，唯一收口） | `domain.posts.changed`（带轮次 `seq`，与轮询**按 seq 去重**） | 247 |

| `PUT /vtuber/{id}`（V 本体提交后） | `domain.vtuber.updated`（载荷 = 接口返回同一份，**R33 那条同步链**的触发源） | 248 |

**领域事件到此全部改由后端广播**（M3 三刀），消费侧一行未改。

**M5-1（2026-09-28，devlog/253）：通知汇总也有了后端真源** ——
`app/services/notices.py`（事实 → 文案/优先级/ttl）+ `GET /vtuber/notices`
（`{now, notices[], manual_running}`，已排序，`now` = 服务端毫秒 ⇒ ttl 判定单一口径）
+ `POST /vtuber/notices/ack`（已读落 `app_meta` 的 `notices.acked`，**幂等**）。
- 五类来源：任务进度（**自动节拍不产生条目**）/ 风控冷却（倒计时进 `value` 活数据槽）/
  登录失效（sticky + 「去登录」）/ 完成报告 / 开播边沿与瞬时消息（进程内环形缓冲 + TTL）。
- **「目睹才报」保留**（§8.5 拍板 C）：把"谁在看"表达成**推送通道有没有订阅者**，
  在任务收尾那一刻采样（`note_run`）⇒ 没人看着跑完的轮次**不出**报告。
  ⚠️ 与旧口径的差异：主窗口**收进托盘**时旧行为不报、新行为报（SSE 还连着），
  且报告已读**落库**（刷新/深休眠重建后不再复活）。
- **M5-2a（2026-09-29，devlog/258）补了两处、修了一处**：`manual_running` 与通知同一趟给出
  （删 `kickPoll` 之后按钮禁用仍即时，口径与 `fetch-status` **同源**：自动档不算忙）；
  报告**只对全量轮出**（`REPORT_KINDS`）—— 少了这道过滤，`quick`（手动抓帖）与 `adopt`
  （收录首屏）都会留下一条写着"全量帖子抓取完成"的假报告（M5-1 期间没有消费者 ⇒ 看不出来）。
- **M5-2b（2026-09-29，devlog/259）前端切过来了**：`TopBar` 的六类本地汇总整段删除，两扇窗
  共用 `utils/noticeStream.ts::useNotices`（**服务端列表 + 本地覆盖**合并：推送来的进度/瞬时消息、
  客户端自己的事实、dev 注入）；`widget:notices` 广播与 `kickPoll` 一并退役；
  报告的「知道了」调 `POST /vtuber/notices/ack`（**已读落库** ⇒ 刷新/深休眠后不再复活）。
  ⚠️ **`fetch-status` 那条轮询不退役**：报告的明细（stored/skipped/video_missing/issues）、
  托盘倒计时、`account-progress` 快照 diff 都还吃它（侦察 R5/R8）。
  ⚠️ **`MSG_TTL_MS`(4s) < 空闲轮询(10s)** ⇒ 瞬时消息**必须**继续靠推送做本地覆盖，
  纯轮询必然漏（R3）—— 这就是"服务端列表 + 本地覆盖"这条口径的由来。

## 2. 通知的取数与合并口径（M5-2b 定稿）

| 层 | 是什么 | 谁写 |
|---|---|---|
| **服务端列表** | `GET /vtuber/notices`：进度 / 风控 / 登录 / 完成报告 / 环形消息（已排序 + 服务端 `now`） | `services/notices.py`（唯一真源） |
| **本地覆盖** | 推送来的"任务已受理"与瞬时消息、dev 注入的自检条目、（客户端事实：磁盘/更新提示走 `pillMessage`） | `utils/noticeStream.ts::useNotices` |
| **合并规则** | 服务端报到同类 ⇒ 本地那份让位；按 id 去重（本地优先）；TTL 从**到达时刻**起算 | 同上（`mergeNotices`，有单测） |

⚠️ 判据面：`tests/test_notices.py`（契约/语义）+ `utils/noticeStream.test.ts`（合并 + 结构判据：
两个宿主都必须用 `useNotices`、都必须拉端点、不许再出现 `widget:notices` / `kickPoll` 的活代码）
+ 探针 `--messages` / `--status-widget`（端到端；小窗那页没有主窗口也能显示）。

---
