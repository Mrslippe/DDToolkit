# 后端消息中心 · 分批执行方案（交给执行 Agent）

> 状态：**待执行**。本文件是 `docs/design/notices/message-hub-architecture.md`（设计）与
> `docs/design/notices/target-architecture.md`（目标态）的**执行细化**，不是真源。
> 目标读者：**负责实际改代码的执行 Agent**。
> 核实日期：**2026-09-27**（本文所有"现状"结论都是这一天沿真实调用链读出来的，带行号）。
> ⚠️ **行号是当日快照，不要照抄** —— 开工前重新 `read` 目标函数（母计划 §0 第 2 条）。
>
> **纪律继承**：`docs/ARCHITECTURE-IMPROVEMENT-PLAN.md` §0 的九条**全部继续有效**；
> 每批汇报只写母计划 **§7** 那张表要求的字段；停止条件见母计划 **§9** + 本文 §4。
> 本文件**不得成为规则真源**：不变量落 `docs/ARCHITECTURE.md` §6，门禁口径落 `scripts/`。
> 本文件只回答"**先做哪个、改哪里、怎么变红、什么时候算完、什么时候必须停**"。

---

## 0. 给执行 Agent 的指令（母计划 §0 之上补六条）

1. **一次只开一个会话改代码**（`docs/DEV-LOOP.md` §七）。"分批"= 一批一个会话、一批一次收尾，
   **不是并行推进**。每批独立建护栏、修改、验收、写 devlog，**不许把多批混进一个提交**。
2. **⚠️ 本方案有一条硬停止条件（母计划 §9 已写明）**：
   > 「**token 只能放 URL**」⇒ **必须停下报告**。
   本文的方案**不需要**把 token 放进 URL（见 §2 的通道决定）。**若你的实现里出现了
   把访问令牌拼进 query（`?t=${apiToken}` 之类的任何形式），立即停下** ——
   那不是本方案，是母计划明令停止的形态。
   ⚠️ 注意别被**无关同名**误导：本仓已有 `xsec_token=`（**小红书分享链接**的 query，
   见 `frontend/src/utils/platformLogin.ts:51`），它与访问令牌**无关**，不构成违规。
3. **开工前不要相信行号**。本文的行号对 `2026-09-27` 的快照；目标文件都比描述大。
   重新 `read`，别按本文行号直接改。
4. **两条假绿通道，必须主动巡检**（母计划 §0 第 3 条，本仓实测最值钱的两条）：
   - **后端**：全仓大量 `monkeypatch.setattr(sch|scheduler, <名字>, ...)`。函数搬进新模块后
     若仍按本模块名字调用同族函数，patch **静默失效** ⇒ 测试照旧全绿，那条断言什么都没验。
   - **Tauri**：`build.rs` 是裸 `tauri_build::build()`（无 app manifest）⇒ 按 `tauri-2.11.5`
     的 `webview/mod.rs:1819-1852`，**应用自定义命令默认不查 ACL**。⇒ **只改
     `capabilities/*.json` 的安全收益≈0**，必须同时改 Rust 侧 caller label 校验。
   两条的处理方式相同：**改坏它，必须变红**（`docs/DEV-LOOP.md` §6.4）。
5. **本方案不引入新依赖**（`uv.lock` / `Cargo.toml` / `package.json` 都不动）。
   推送通道用 `fetch` + `ReadableStream`（原生）。若你发现必须引依赖 ⇒ **停下报告**（§4 S-4）。
6. **每个"必测"都写清了反向验证怎么做。只跑一遍看它是绿的，不算做过。**

---

## 1. 范围与完成定义

### 1.1 做完长什么样

**后端成为唯一的消息产生方；前端各窗口退化成订阅者；点击到各终点不再等轮询。**

| 能力 | 现状 | 做完 |
|---|---|---|
| 开播通知 | ❌ 检测在后端但**无出口** | ✅ 推到所有订阅者 |
| 手动动作反馈 | ⚠️ 靠前端 `kickPoll` 补丁 | ✅ 后端自动发布 |
| 左右栏/卡片同步 | ⚠️ 靠轮询算出来再发前端事件 | ✅ 后端推送 |
| 主窗口隐藏后小窗 | ❌ 停更 | ✅ 仍更新 |
| 通知汇总位置 | 主窗口 `TopBar` 的 `useMemo` | 后端 `services/messages.py` |

### 1.2 非目标（**本方案明确不做**）

1. **不重写** `Notice` 模型 / `notificationHub` 纯函数 / `StatusIsland` / 动效规格 /
   窗口几何 —— 它们不是问题所在（`docs/design/notices/target-architecture.md` §6）。
2. **不动 Rust**（除 `M4` 需要时）。ACL 已就绪：`get_backend_port` / `get_api_token` 已是 `BOTH`。
3. **不引依赖**（WebSocket / Redis / Celery / 任何消息队列）。
4. **不做双向通道**。本方案只需**服务端 → 客户端**单向推送。
5. **不改 token 机制**（`api_auth.py` 的 header 口径不动）。
6. **不在同一批里既做消息中心又做通知汇总搬家**（`M5` 必须独立）。

### 1.3 验收（可机器判 / 只能真机判，分开写）

| # | 判据 | 手段 |
|---|---|---|
| V1 | 后端发布 → 订阅者收到，端到端 < 200ms | pytest（TestClient + 流式读取） |
| V2 | 开播边沿 → 产生一条 `live.edge` 消息 | pytest（直接调边沿处理函数） |
| V3 | 手动动作 → 不依赖 `kickPoll` 即产生进度消息 | pytest |
| V4 | 订阅者断开 → 后端不留悬挂连接/不涨内存 | pytest（连接数断言） |
| V5 | 访问令牌不出现在 URL / query 里 | **结构判据**（锚定 `apiToken`，见 §2.1 的假红警告） |
| V6 | 探针能断言"推送真的到了" | `ui_probe` 新模式 |
| V7 | 真机：点按钮 → 顶栏/小窗立刻变 | ⚠️ **只能真机**（你看） |

---

## 2. 两条必须先定死的技术决定（否则会返工）

### 2.1 通道：`fetch` + `ReadableStream`（**token 走 header，不进 URL**）

**为什么不用 `EventSource`**：浏览器原生 `EventSource` **不支持自定义请求头**
⇒ 它无法带 `X-DDToolkit-Token`（`app/core/api_auth.py:47`、`app/main.py:430` 的中间件）
⇒ 唯一出路是 `?token=` ⇒ **命中母计划 §9 的停止条件**。**不要选它。**

**采用**：`fetch(url, { headers: { 'X-DDToolkit-Token': token }, signal })` + 读 `resp.body`。
它与现有 `authFetch()`（`frontend/src/api/api.ts:198-208`）**同一套 token 口径**，
不新增泄露面、不与 token 设计初衷相悖。

**必测（V5，结构判据）**：

⚠️ **不要写成"源码里搜 `token=`"** —— 本仓**已有无关命中**，那样写会**一写就假红**：
`frontend/src/dev/probe.ts:1698` 与 `frontend/src/utils/platformLogin.test.ts:31` 里的
`xsec_token=`（**小红书分享链接**的 query，与访问令牌无关），
`frontend/src/utils/platformLogin.ts:51` 的注释也提到它。
⇒ 判据必须**锚定访问令牌这个变量名**，而不是子串 `token`：

```
判据：在 frontend/src/**/*.{ts,tsx} 里，
      形如 `${apiToken}` / `${TOKEN_HEADER}` 的插值**不得出现在 fetch 的 URL 位置**
      （即 URL 字符串或 URLSearchParams 里）
反向验证：故意写一处 `fetch(`${apiBase}/events?t=${apiToken}`)` ⇒ 必须红
```

⇒ **两个要求**：① 判据锚定 `apiToken`（不要用 `token=` 这种宽泛子串）；
② 实现里也**不要**给新端点起带 `token` 的 query 参数名（避免制造新的假阴性来源）。

### 2.2 发布点必须在 **commit 成功之后**

⚠️ **这是最容易写错的一处**，有仓库先例（`app/services/scheduler.py:2955-2957`）：

直播边沿的落库**必须与 live 字段同一个事务** —— 因为两笔独立 commit 时，
第二笔失败会让 `prev_status == acc.live_status` ⇒ **边沿被永久吞掉**（日历少一场）。

⇒ **推论（本方案新增的硬约束）**：**消息不能在事务中间发布**。
消息发出去就收不回，而事务可能回滚 ⇒ 订阅者收到一条"从未发生过"的事件的通知。

**必测**：构造"发布后事务回滚"的场景，断言**没有消息被发出**（或发了 `retract`）。
**反向验证**：把 publish 移到 `db.commit()` 之前 ⇒ 该用例必须红。

---

## 3. 逐批方案

> 编号 `M0`–`M5` 与 `docs/design/notices/message-hub-architecture.md` §8 对齐。
> **执行顺序照这个顺序做**；每批独立提交，`M3` 风险最高。

---

### 批次 M0 — 推送通道骨架（**这一步只验证"通道通了"**）

**档位**：A（碰 `app/`）。

**目标**：推送端点能推、能断、能重连；**先只推一类消息**。

**改动面**：
- 新增 `app/services/messages.py`：
  - `MessageHub`：订阅者注册表（`set` / 弱引用）+ 环形回放缓冲（长度常量放这里）。
  - `publish(msg)`：给所有活订阅者投递；无订阅者时只进环形缓冲。
  - **不持有 asyncio 原语在模块级**（`ARCHITECTURE.md` §6 第 15 条：综合档每轮一个
    `asyncio.run()`，模块级 `asyncio.Lock` 第二轮必抛 "bound to a different event loop"）。
- 新增路由：**推送端点（路径名待定，见下方冲突警告）**（`app/routers/` 下，薄）：
  - `StreamingResponse(media_type="text/event-stream")`；**必须走 token 中间件**（不加白名单）。
  - 心跳（`:` 注释行）防中间层超时；收到客户端断开要清理订阅者。

  ⚠️ **路径不能用 `GET /events`** —— 本仓**已被占用**：
  `app/routers/vtuber.py:735` 已有 `GET /vtuber/{vtuber_id}/events`
  （**V 的活动条目**，完全不同的语义）。用 `GET /events` 会在阅读与路由表上
  造成"两个 events 不是一个东西"的混淆。
  **建议**：`GET /vtuber/stream` 或 `GET /messages/stream`
  （`messages` 与新的 `services/messages.py` 同名，语义最直白）。
  ⇒ 定名前**先查一遍路由表**（`python scripts/gen_doc_numbers.py --list` 能给装饰器总数，
  具体路径以 `app/routers/` 为准），别按本文的行号直接下笔。
- 前端新增 `frontend/src/utils/eventStream.ts`：`fetch` + `ReadableStream` 解析 SSE 帧；
  暴露 `start(onMessage)` / `stop()`；用 `AbortController`。

**先补的失败用例**：
1. 订阅后 `publish` ⇒ 收到（端到端，V1）。
2. 订阅者断开 ⇒ hub 里订阅者数归零（V4）。
3. 心跳按间隔到达（避免"看起来连着其实已死"）。
4. **`asyncio` 循环重建后仍能 publish**（防 §6 第 15 条那条坑）。
5. **V5 结构判据**（§2.1）。

**反向验证**：
- 去掉订阅者清理 ⇒ 用例 2 必须红。
- 把 `MessageHub` 的锁改成模块级 `asyncio.Lock` ⇒ 用例 4 必须红。

**门禁**：`python scripts/gate.py --tier a`（A 档含 pytest）。
**文档义务**：A 档 → devlog + `docs/ARCHITECTURE.md` §3.8（状态通道）补一句"新增推送通道"。

**停止条件**：若 `StreamingResponse` 在 Tauri WebView2 里读不出流（真机验证），
**停下报告** —— 那意味着通道选型要重新评估（不要在探针里边"看起来能跑"就宣布通过）。

---

### 批次 M1 — 开播通知（**成本最低、收益最直观**）

**档位**：A。**依赖**：M0。

**目标**：开播边沿 → 一条面向用户的通知。

**核实结论（本次最值钱的发现）**：
开播检测**已经在后端**，而且**已经分出了"开播"方向**：
`app/services/scheduler.py:2951` `edge = acc.live_status != prev_status`、
`:2952` `started = bool(acc.live_status) and not prev_status`。
但它的唯一消费者是 `:2962` 的 `note_dynamics_activity()`（**把动态流恢复满速**）
⇒ **没有任何面向用户的出口**。

⇒ **本批不是"新造检测"，是"给它一个出口"。**

**改动面**：
- 在 `:2960` 那个 `if edge and started:` 块内（**或更准确地说：commit 成功之后**，见 §2.2）
  调 `hub.publish({type:'live.edge', ...})`。
- 消息类型进 `services/messages.py` 的类型常量表（**名字是隐式契约**，
  参考 `frontend/src/utils/appEvents.ts:4-7` 的教训：改名要当场编译错）。
- 前端：`messageHub` 收到 `live.edge` → 转成 `Notice(kind:'alert')` → 进 `StatusIsland`。

**先补的失败用例**：
1. 伪造 `live_status` 0→1 ⇒ 产生一条消息；1→0 ⇒ 不产生"开播"（只产生下播，若做）。
2. **非边沿**（连续两次都 `live_status=1`）⇒ 不产生消息（防重复播报）。
3. `note_dynamics_activity` 的既有行为**不变**（回归）。
4. **事务回滚时没有消息**（§2.2 的必测）。

**反向验证**：把 `if edge and started` 改成恒真 ⇒ 用例 2 必须红。

**门禁**：A 档。
**文档义务**：A 档 → devlog + `ARCHITECTURE.md` §3.7（直播场次管道）补出口说明。

---

### 批次 M2 — 手动动作走中心（**用户核心诉求：点击到终点零等待**）

**档位**：A + B。**依赖**：M0。

**目标**：消掉 `kickPoll` 这条补丁。

**核实结论**：`frontend/src/pages/useVtuberActions.ts:42-44` 的 `kickPoll()` 注释是
「通知 TopBar 立即轮询一次抓取状态（点击按钮/任务结束时即时反馈）」，
`:7-8` 写明每个动作都是「守卫 → `setFetching` → `kickPoll()` → `api` → 提示 →
`finally { kickPoll() }`」的同一套骨架（本文件里 6 个回调 + `PostsPage` 同款）。
⇒ 它是"把 3–10s 的轮询等待人工缩短成一次往返"的补丁。

**改动面**：
- 后端：任务启动/结束时 `hub.publish`（**在 commit 之后**，§2.2）。
- 前端：`kickPoll` 的调用点逐步退役；**先并存再删**（先加推送、确认覆盖后再删轮询补丁）。
- ⚠️ **`originator`**：小窗点的动作，广播后**小窗自己也收到** ⇒ payload 带
  `originator`（宿主标识），订阅者忽略自己发起的；否则自家消息回环（重复提示）。

**先补的失败用例**：
1. `POST /vtuber/fetch/{id}` ⇒ 立即产生 `notice.progress`（不等轮询）。
2. `originator` 命中自己 ⇒ **不重复提示**。
3. `kickPoll` 退役后，原有用例（`appEvents.test.ts` 相关）仍绿。

**反向验证**：把 `originator` 过滤去掉 ⇒ 用例 2 必须红。

**门禁**：A 档（后端改）+ B 档（前端改）。
**文档义务**：A/B 档 → devlog + `UI-MAP.md`（胶囊状态来源变更）。

---

### 批次 M3 — 领域事件改推送（⚠️ **风险最高**）

**档位**：A + B。**依赖**：M0–M2。

**目标**：`vtuber.updated` / `account.snapshot` / `posts.changed` 改由后端推。

**⚠️ 为什么风险最高**：它碰的是 **R33 那条事故路径** ——
`frontend/src/utils/appEvents.ts:4-7` 明确记录：「右栏改了签名要通知左栏
（**R33 那条"改了左栏没同步"的事故**）」。本批把这条同步链的**触发源**换掉。

**改动面**：
- 后端：三类事件各自的发布点（**逐个来，不要一次全换**）。
- 前端：`on(EVENTS.x, …)` 的**消费侧不动**（这是本方案的关键好处：
  换的只是触发源，组件已经在监听）。

**先补的失败用例**：
1. 改签名 ⇒ 左栏收到（端到端）。
2. 账号快照增量 ⇒ 左栏 + 右栏都收到（`TopBar.tsx:230` 的 `accountProgress` 等价物）。
3. **推送与轮询并存时不重复**（过渡期必须成立）。
4. **R33 回归**：右栏改 → 左栏更新的既有用例必须继续绿。

**反向验证**：断开推送、只留轮询 ⇒ 用例 1/2 必须红（证明推送真的在起作用，
而不是轮询顺手覆盖了它 —— 这是本批最容易出现的**假绿**）。

**门禁**：A 档 + B 档 + **full**（本批建议收尾用 `--tier full`）。
**文档义务**：A/B 档 → devlog + `UI-MAP.md` + `FRONTEND-ARCH.md`（数据流一节）。

**停止条件**：若 R33 那条既有不变量无法同时保住 ⇒ **停下报告**，不要删那条判据。

---

### 批次 M4 — 小窗接同一通道

**档位**：B。**依赖**：M0。

**目标**：小窗不依赖主窗口也能更新；退役 `widget:notices`。

**改动面**：
- `frontend/src/components/StatusWidgetWindow.tsx`：`listen(WIDGET_NOTICES_EVENT)` →
  改用 `eventStream`（token 已就绪，`frontend/src/widgetMain.tsx:126-129` 已在注入）。
- `widget:notices` 广播**先并存、后退役**（`broadcastNotices` 在 `TopBar.tsx:505`）。
- **保留** `widget:action`（反向动作通路不变）。

**先补的失败用例**：
1. 小窗独立启动（主窗口不在）⇒ 仍能收到消息。
2. 主窗口隐藏 ⇒ 小窗继续更新（V7 的真机项，探针只能验前一半）。
3. `widget:closed` / `widget:action` 行为不变。

**反向验证**：关掉推送 ⇒ 用例 1 必须红。

**门禁**：B 档 + `ui_probe --status-widget`。
**文档义务**：B 档 → devlog + `UI-MAP.md` §A1-a-w2。

---

### 批次 M5 — 后端接管通知汇总（**最后做，独立一批**）

**档位**：A。**依赖**：M0–M4。

**目标**：真正单一真源；报告已读持久化。

**改动面**：见 `docs/design/notices/target-architecture.md` §2（`GET /vtuber/notices` +
`POST /vtuber/notices/ack`）；`TopBar` 删掉自己的 `useMemo`（`TopBar.tsx:460-494`）。

**⚠️ 本批有一个必须先拍板的语义问题**（`docs/design/notices/placement-frontend-vs-backend.md` §3.2）：
「**只有轮询目睹过运行的任务完成才弹报告**」这条逻辑今天住在主窗口的
`useRef`（`seenAccSeq` / `seenPostSeq` / `sawAccRun` / `sawPostRun`，`TopBar.tsx:151-156`），
它依赖"**谁在看、看了多久**"。搬到后端后"观察者"恒在线 ⇒
**这条行为会消失**（用户开始收到本来刻意不报的快速任务报告）。

⇒ **未获用户明确口径前不要动这一批。** 三个选项：
① 接受行为变化；② 把"谁在看"也搬到后端（窗口注册订阅来表达）；
③ 保留在 `TopBar`（则 M5 只做"通知汇总"、不做"边沿检测"）。

**先补的失败用例**：`GET /vtuber/notices` 的字段契约（**键集合**，防前端断字段）；
`ack` 幂等；ttl 用服务端 `now` 判定。
**反向验证**：删一个 `Notice` 字段 ⇒ 契约用例必须红。

**门禁**：A 档 + full。
**文档义务**：A 档 → devlog + `ARCHITECTURE.md` §3.8 + `UI-MAP.md`。

**停止条件**：§4 的 S-3（"目睹才报"未拍板）未解决 ⇒ **不做本批**。

---

## 4. 停止条件（**必须停下报告**）

母计划 §9 全部继续有效。本方案**另加五条**：

| # | 条件 | 为什么停 |
|---|---|---|
| **S-1** | 实现里把访问令牌拼进 URL / query | **母计划 §9 已明令停止**；换通道而不是绕过 |
| **S-2** | 必须引新依赖（`uv.lock` / `Cargo.toml` / `package.json`）才能做 | 本方案的前提是零依赖 |
| **S-3** | M5 的"目睹才报"语义未获用户拍板 | 会静默改变用户可见行为 |
| **S-4** | `ReadableStream` 在 Tauri WebView2 真机读不出流 | 通道选型要重新评估，不能在探针里"看起来能跑"就通过 |
| **S-5** | R33 那条"右栏改→左栏同步"的既有判据无法保住 | 那是有事故背景的不变量 |

**另**：`full gate` 出现真实回归 ⇒ 停下报告（母计划 §9）。

---

## 5. 每批的收尾检查清单（照抄，别自由发挥）

```text
[ ] 开工先 git status --short（用户改动不得覆盖/重置/暂存/顺手整理）
[ ] 先补能失败的用例 → 跑一次确认它红 → 再写实现
[ ] 新增/修改断言都做反向验证：改坏要红、恢复要绿（DEV-LOOP §0.7）
[ ] 不写死测量值（测试数/迁移数/文档数）→ python scripts/gen_doc_numbers.py --list
[ ] 确认没有把 token 拼进 URL（S-1）—— 本方案每批都查一次
[ ] 确认没有引入新依赖（S-2）
[ ] 同步活文档（逆索引见 .dsh/skills/ddtoolkit-docs-devlog/references/doc-map.md）
[ ] 写 devlog（编号查 --list；每需求 1 篇、≤40 行；脱离本批仍成立的经验提炼进
    ARCHITECTURE §6 / DEV-LOOP / design-*）
[ ] python scripts/gate.py --plan 看清档位 → 跑对应档 → 收尾用 --tier full 兜一次
[ ] git diff --check / git status --short
[ ] 报告只写母计划 §7 那张表要求的字段；不发布
```

**开工前查一次真值**（`python scripts/gen_doc_numbers.py --list`）；
**完成报告模板**照抄 `docs/ARCHITECTURE-IMPROVEMENT-PLAN.md` §7。

---

## 6. 推荐提交序列

```
messages: backend message hub with SSE-over-fetch transport     （M0）
feat: live-start notification from existing edge detection      （M1）
perf: manual actions publish through hub, retire kickPoll      （M2）
refactor: domain events pushed by backend instead of polled     （M3）
feat: widget subscribes to hub, retire widget:notices           （M4）
refactor: backend owns notice aggregation and read state        （M5）
```

禁止 squash 成一个大提交；同一需求子批按仓库纪律合并记录。

---

## 7. 本方案**不**做什么（与 §1.2 呼应，这里只列最容易越界的）

1. **不重建** `Notice` / `notificationHub` / `StatusIsland` / 窗口几何 / ACL。
2. **不把 token 放进 URL**（S-1）。
3. **不在事务中间 publish**（§2.2）。
4. **不一次换完所有领域事件**（M3 逐个来）。
5. **不为了"行数变少"搬代码** —— 判据是"能不能对每个模块单独写出一条有牙口的用例"
   （母计划 §5 第 2 条）。
6. **不复制本文件的行号与数字去写文档** —— 它们是 2026-09-27 的带日期快照。

---

## 8. 开工前复核与定稿（2026-09-27 第二批会话 · **只读复核 + 补两处缺口**）

> 复核基线：`git HEAD` = `5fb6ca0`（本文件的行号快照来自 `0bc291c`，**中间隔了第 4 阶段 ⑦⑧ 两批**，
> 所以下面的行号是**重新 read 出来的**，不是照抄）。复核未改任何业务代码。

### 8.1 复核结论：方案的前提**逐条成立**

| 前提（本文件原话） | 复核 | 证据（当前行号） |
|---|---|---|
| 延迟大头 = "等下次轮询"，最多 3–10s | ✅ | `frontend/src/components/TopBar.tsx:53-55`（3s 忙 / 10s 闲 / 500ms 重排） |
| 前端已有一条跨组件总线（8 事件） | ✅ | `frontend/src/utils/appEvents.ts:22-38` |
| 开播检测已在后端、且已分方向，只是没有面向用户的出口 | ✅ | `app/services/scheduler.py:2994`（`edge=`）、`:2995`（`started=`）、唯一消费者 `:3005` `note_dynamics_activity` |
| 业务端点全要 token、公开白名单只三处 ⇒ `EventSource` 带不了头 | ✅ | `app/core/api_auth.py:47`（`TOKEN_HEADER`）、`:50`/`:53`（白名单） |
| 小窗自己就能带 token（**不必动 Rust**） | ✅ | `frontend/src/widgetMain.tsx:127-132`（`invoke('get_api_token')` → `setApiToken`） |
| 「目睹才报」住在主窗口内存（M5 阻塞项） | ✅ | `TopBar.tsx:151-156` + `:248-252` |
| `GET /events` 会"语义撞名" | ⚠️ **修正**：仓里**没有** `GET /events`；撞的是 `GET /vtuber/{vtuber_id}/events`（V 的**活动条目**）。⇒ 新端点叫 `GET /messages/stream` 即可，**不构成阻塞** |

### 8.2 ⚠️ 方案漏掉的第一处：**T0 是守护线程，publish 必须跨线程**

T0 直播轮询跑在 `threading.Thread(target=_live_poller_loop)`（`scheduler.py:1135-1138`），
**不在应用的事件循环里**；而 SSE 订阅者住在 uvicorn 的循环里。
⇒ `MessageHub.publish()` 会**从没有事件循环的线程**被调用（M1 的开播通知正是这条路）。

本文件 §M0 只写了"不持有 asyncio 原语在模块级"（那是 R38「综合档每轮一个 `asyncio.run()`」的坑），
**没有覆盖"从别的线程发布"**。两条路（**推荐 A**）：

| | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A** | hub 内部一个 `queue.Queue`（线程安全）；lifespan 里 `create_task` 一个 drain 循环抽干队列并投递给订阅者 | `publish()` 纯同步、**任何线程可调**；订阅者只在应用循环里被碰 | 多一个后台任务；退出要取消（与 `shutdown_smoke` 那条优雅停止路径一起看） |
| B | lifespan 记下 `asyncio.get_running_loop()`，publish 走 `loop.call_soon_threadsafe` | 不用队列 | 调用方要判断"有没有循环"；循环被重建时会指向死循环 |

**必测**：从 `threading.Thread` 里 `publish()` ⇒ 订阅者收到（**这条用例必须真开线程**，用 `asyncio.run` 测不出来）。
**反向验证**：去掉 drain 任务、改成"publish 里直接投递" ⇒ 该用例必须红（且不是"偶尔绿"）。

### 8.3 ⚠️ 方案漏掉的第二处：**V6 需要一条 dev-only 的"合成发布钩子"**

V6 要求"探针能断言推送真的到了"，但探针**无法**让后端自然产生一条通知（开播要真开播、
风控要真被限流）。⇒ M0 必须同时给出探针可用的合成发布口：

- `POST /messages/_debug/publish`：**仅 DEV 注册**（与探针其它 dev 钩子同一口径）、走 token 中间件、
  body 就是一条消息；**生产构建里不是"注册了但关着"，而是根本不注册**；
- 判据：① 结构判据 —— 生产态路由表里**没有**这个路径；② dev 态探针能发一条 `notice.message`
  并断言顶栏胶囊**渲染出那句文案**（端到端：钩子 → SSE → 订阅 → `StatusIsland`）；
- 反向验证：把 DEV 守卫去掉 ⇒ 结构判据必须红。

⚠️ 不做这一步，M0 验收表里的 V6 只能写"没法验" —— 而"通道通了"**恰恰是 M0 唯一的产出**。

### 8.4 三条顺序纪律（补在 §3 之上）

1. **删 `kickPoll` 的前提是"推送覆盖"有判据**：先并存 → 用"**断开推送 ⇒ 用例红**"证明推送真的在起作用
   （§M3 已有这条反向验证，**M2 就要先做一遍**），再删补丁；
2. **`fetch-status` 轮询不退役**（本方案范围内）：它是**一致性兜底**（推送漏发、重连窗口）；
   退役它是另一批的事；
3. **M0 的真机验收（S-4）必须发生在 M1 之前**：`ReadableStream` 在 Tauri WebView2 里读不出流，
   M1–M5 全部作废；**探针绿不算通过**。

### 8.5 待拍板项 —— ✅ **已拍板（2026-09-27，用户：全部按建议）**

| # | 问题 | 结论 |
|---|---|---|
| A | 定时抓取任务在小窗要不要占位 | ✅ **占位，优先级最低**（用户此前明确要过"小窗也能看到定时任务"） |
| B | 主窗口隐藏时小窗继续拉还是静默 | ✅ **继续拉**（S1 的收益全在这里） |
| C | 「目睹才报」保留吗（M5 阻塞项） | ✅ **保留** —— 把"谁在看"实现成**订阅者注册表**，而不是取消这条语义。⇒ **M5 解锁**，但实现时必须先有"订阅者在线"的表达方式（M0 的订阅者表就是它的雏形） |
| D | 回放深度与 `Last-Event-ID` | ✅ **环形 50 条 + 只在重连时补发**；补发的消息带 `replay: true`，**前端不得据此弹提示**（防"重连后一串历史 toast"） |
| E | `originator` 用什么标识宿主 | ✅ **连接时带 `X-DDToolkit-Host: main\|widget`**（连接级，不必每条消息重复） |

### 8.6 结论

**可以按 M0 → M5 执行**，前提逐条复核成立；开工前先把 §8.2、§8.3 两处补进 M0
（不然 M0 会返工），并按 §8.4 的顺序走。**M0/M1 不依赖任何拍板项**；M5 依赖 C。

