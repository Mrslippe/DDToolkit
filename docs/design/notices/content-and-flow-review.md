# 状态内容汇总 · 信息流动路径 · 消息框架重建评估（2026-09-27）

> **这是什么**：一次**只读**的架构分析。回答三个问题 ——
> ① 顶栏状态岛与独立小窗上到底会显示哪些内容；② 这些内容各自沿哪条路流到屏幕；
> ③ 在这套架构上，**该不该重建消息通知框架**。
>
> **未改任何业务代码**（用户 2026-09-27 口径：「先不要改业务代码」）。
> 所有行号对 `git HEAD` = `0bc291c`（2026-09-27）。
> ⚠️ 本文的**行号与实测数字是当日快照**，不是真源；"现状"的真源是 `UI-MAP.md`。

---

## 0. 一句话结论

**两个宿主（顶栏 / 小窗）现在共用同一个渲染器、同一个数据模型，差别只在"谁供数"。**
而这个"谁供数"正好是唯一的硬伤：**供数的是主窗口**，于是主窗口一收进托盘，
小窗就从"消息聚合中心"退化成一块**不会更新的玻璃**。

⇒ **要重建的不是"消息通知框架"，而是"供数方"** ——
渲染层（`StatusIsland`）与数据模型（`Notice`）**都该保留**，它们是对的。

**至于"供数方"该放前端还是后端**：见 `docs/design/notices/placement-frontend-vs-backend.md`
（那份是"放哪"的**唯一真源**）。一句话版本：**分两步，先做前端侧的小窗自拉**
（零新契约、立刻拿到"隐藏后仍更新"），**再考虑后端接管**（真正单一真源，
但会改变一条用户可见语义）。

---

## 1. 会展示的内容汇总

### 1.1 唯一的数据模型

真源：`frontend/src/utils/notificationHub.ts` —— 一个 `Notice` 结构 + 四档优先级。

| 字段 | 含义 | 今天谁在用 |
|---|---|---|
| `id` | 去重用键 | 面板 `key` |
| `kind` | `alert` / `progress` / `report` / `message` | 图标、颜色、优先级、标签 |
| `text` | 主文案（胶囊上唯一那行） | 胶囊 + 面板 |
| `detail` | 补充说明 | **只在面板** |
| `source` | 来源标注（「风控冷却」「登录态」…） | **只在面板 meta** |
| `sticky` | 常驻（不因 ttl 消失） | 面板 meta 显示「常驻」 |
| `expiresAt` | 过期时刻 | `isLive()` 判定 |
| `action` | `{label, kind}` | **只在面板**的按钮 |

优先级（`KIND_PRIORITY`）：`alert 4 > progress 3 > report 2 > message 1`；
`pickPrimary()` 取最高、**同级取最新**（数组后者）。栏外那一行就是 `primary.text`。

### 1.2 信息源（全在主窗口 `TopBar.tsx` 里汇总）

⚠️ **口径纠正**：`TopBar.tsx:459` 的注释说「六类信息源汇总成条目」，但按代码实际数，
`notices` 那个 `useMemo` 里只有 **5 类**（`①`–`⑤`，见 `TopBar.tsx:462-491`）——
第 `⑥`（`TopBar.tsx:496`）是**托盘同步**，它并**不产生条目**。
下表把 `progress` 的三个实例拆开列，故共 **7 条**。

| # | 来源 | 触发 | kind | 文案模板 | 寿命 | 带动作 |
|---|---|---|---|---|---|---|
| ① | 帖子任务进度 | 轮询 `GET /vtuber/fetch-status` 的 `post` | `progress` | `composeTaskText()` → `任务名 - V名 - i/N` | 跟随 `running` | — |
| ② | 账号任务进度 | 同上 `account` | `progress` | 同上 | 跟随 `running` | — |
| ③ | 第三方同步 | 同上 `external.running` | `progress` | `正在同步{label}` | 跟随 `running` | — |
| ④ | 风控冷却 | 同上 `rate_limit.active` | `alert` | `上游限流：冷却中（还剩 Ns）` | `expiresAt` | — |
| ⑤ | 登录失效 | `api.authStatus('bilibili').needs_login`（60s 轮询） | `alert` | `B 站登录已失效` | `sticky` | `去登录` |
| ⑥ | 完成报告 | `post.last_result.seq` 变化 | `report` | `全量帖子抓取完成 · 存储 N · 跳过 N` | `sticky` | `查看详情` |
| ⑦ | 瞬时消息 | 页面事件 `ddtoolkit:pill-message` | `message` | 调用方给（例：磁盘不足） | 4s ttl | — |

**「静默任务」是刻意排除的**：`isQuietTask()` 把**定时档**发起的自动节拍（动态流 ~80s 一轮、
自动账号流）排除在顶栏之外 —— 用户 2026-09-10 口径「频繁轮询不必占顶栏」。
（⚠️ 这条与你 2026-09-24 说的"小窗是消息聚合中心，可能是定时抓取任务"**直接冲突**，
见 §5 待决问题 A。）

### 1.3 不走通知中心的状态呈现（六个旁路）

| 呈现 | 位置 | 为什么没进通知中心 | 小窗能看到吗 |
|---|---|---|---|
| 迁移失败横幅 | `MigrationFailureBanner`（顶部横幅 + 诊断弹窗） | 它要"打开数据目录 / 导出诊断"两个按钮，是**一屏交互**不是一条消息 | ❌ |
| 磁盘不足 | `useLowSpaceNotice` → 复用 `pill-message` | **进了**（当作 `message`），只是 3 天只提一次 | ✅（若广播时小窗在） |
| 托盘提示 | `useTrayStatus` → Rust `set_tray_status` | 托盘是**另一块屏**，且主窗口隐藏后才需要 | ❌（托盘专属） |
| 登录浮窗 | `TopBar` 首启自动弹 | 首次启动的一次性引导 | ❌ |
| 侧栏/右栏徽标 | `topbar-login-badge`、直播徽标 | 它们是**视图内的字段状态**，不是"通知" | ❌ |
| 各类 toast | 各页面自己的 | 就近反馈，不该跨窗口 | ❌ |

> ⚠️ **顶栏与面板是两套同时存在的表达**：`TopBar` 仍在渲染自己的登录徽标、
> 忙按钮禁用态、完成报告 `AlertDialog`。这些与状态岛**并列**，不是它的子集。

### 1.4 空闲态

`utils/idleQuotes.ts`：`IDLE_QUOTES` 7 条 + `registerIdleProvider()` 扩展点；
但 `IDLE_CAROUSEL_ENABLED = false`（**R19 已下线**）。所以现在空闲文案**恒为**
`数据服务运行中`（`TopBar` 的 `statusText` 默认值），池子与索引靠
`data-idle-*` 属性供探针断言。

---

## 2. 信息流动路径

### 2.1 顶栏宿主（`density="bar"`）

```
后端 SQLite / 上游平台
      ↓  (HTTP, 3s 忙 / 10s 闲)
TopBar 的 fetch-status 轮询链            TopBar.tsx:162-199
      ↓  汇总成 Notice[]                 TopBar.tsx:460-494
      ↓  React state
<StatusIsland density="bar">             TopBar.tsx:675
      ↓  pickPrimary() 选一条            notificationHub.ts:60
胶囊一行 [点][字][文案][值][计数][chevron]
      ↓  hover 120ms / 点击钉住
面板（全部条目 + detail + 来源 + 动作）
```

### 2.2 小窗宿主（`density="widget"`）—— **跨进程**

```
TopBar 的同一份 Notice[]                  TopBar.tsx:494
      ↓  useEffect([notices]) → broadcastNotices()   TopBar.tsx:505
      ↓  Tauri emit('widget:notices')                widgetWindow.ts:369-372
══════════ 进程内事件总线（同进程，两扇 WebView） ══════════
      ↓  listen('widget:notices')            StatusWidgetWindow.tsx:89
      ↓  setNotices(payload)                 React state
<StatusIsland density="widget">              StatusWidgetWindow.tsx:417
      ↓  面板里的动作
emit('widget:action')  →  主窗口执行         widgetWindow.ts:379
```

**关键事实**：小窗**不碰 HTTP 拿通知**。`UI-MAP.md:287` 写得很直白 ——
「**它不轮询** —— 六个信息源全在主窗口的 `TopBar` 里，小窗再来一份就是**双倍请求**。」

但"纯显示"**只对通知成立**，小窗仍有两处自己的时钟/请求：

| 小窗自己的活动 | 位置 | 频率 |
|---|---|---|
| `now`（ttl 过期判定） | `StatusWidgetWindow.tsx:111` | 1s |
| 读偏好（穿透 / 全屏隐藏） | `StatusWidgetWindow.tsx:218` | 2s |
| 位置变化持久化 | `StatusWidgetWindow.tsx:121` | 事件驱动 |

### 2.3 已具备但**没用上**的能力（重要）

| 能力 | 证据 | 意味着 |
|---|---|---|
| 小窗**能**拿后端端口 | `get_backend_port` 是 `BOTH` | `lib.rs:1640` |
| 小窗**能**拿会话 token | `get_api_token` 是 `BOTH` | `lib.rs:1641` |
| 小窗已经在做这件事 | `widgetMain.tsx:126-129` 注入 base+token | 它**已经会**发业务请求 |

⇒ **ACL 这一层不需要改**。小窗去做轮询在权限上是现成的。

---

## 3. 生命周期失效矩阵

主窗口与小窗是**两扇独立的 WebView**，后端是**第三个进程**。三者生命周期不同步。

| 情形 | 小窗能更新吗 | 原因（行号） |
|---|---|---|
| 两个窗口都在，主窗口可见 | ✅ 正常 | 广播链完整 |
| 主窗口**隐藏到托盘** | ❌ **停更** | `TopBar.tsx:188` `if (isShellHidden()) return` ⇒ 轮询不跑 ⇒ `notices` 不变 ⇒ 不广播 |
| 主窗口**最小化** | ✅ 通常仍更新 | 最小化不等于 `hide()`，`shell:hidden` 不发 |
| 主窗口**关闭**（关窗不退进程） | ❌ **停更** | `CloseRequested` → `hide()` + `emit(shell:hidden)`（`ARCHITECTURE.md` §3.10 第 1 条） |
| 主窗口**深休眠**（隐藏满 10 分钟） | ❌ **停更且没人能救** | `deep_sleep_impl` 只销毁 `main`（`lib.rs:874-877`）⇒ **产生数据的那一侧不存在了**；小窗自身还活着 |
| 只开小窗、主窗口从没开过 | ❌ 从未有数据 | 没有生产者 |
| 小窗关掉再打开 | ⚠️ 要等下一次广播 | 无"当前快照"重放机制（无 seed） |
| 切换「小窗开关」 | ✅ | 主窗口在，广播照发 |

**三个后果**：

1. **「关闭 ≠ 退出」这条不变量直接决定了通知会断** —— 用户最自然的动作（点 ✕ 收进托盘）
   正好触发 `shell:hidden`，也就是停表。
2. **深休眠是最深的那一层**：主窗口 WebView 被 `destroy()`，而通知汇总逻辑**全在那个
   WebView 的 React 里** ⇒ 不是"轮询停了"，是**代码没了**。
3. **小窗对"主窗口隐藏"这件事一无所知**：`app.emit("shell:hidden")` 是**应用级广播**
   （`lib.rs:848`），但 `installShellLifecycle()` **只在 `main.tsx:173` 挂载过** ——
   小窗入口从没调它 ⇒ 小窗连"现在该不该自己顶上"都判断不了。

> 这与 `ARCHITECTURE.md` §3.10 第 3 条是**同一类错误**：
> 「**必须成功的动作不能建立在可被销毁的一侧**」。
> 那条是针对"托盘退出"立的（R20 实测事故），而**消息聚合中心正踩在同一个坑上** ——
> 通知这条链唯一的供数方，正是那个"可以被隐藏、被最小化、10 分钟后被销毁"的窗口。

---

## 4. 现存架构的评估

### 4.1 对的部分（**不要重建**）

| 资产 | 为什么是对的 |
|---|---|
| `Notice` 模型 | 四档 kind + ttl/sticky/action 够用；加 `value`（活数据）与 `music` 只是**扩展**不是重做 |
| `pickPrimary` / `KIND_PRIORITY` | 纯函数、有单测（`utils/notificationHub.test.ts`） |
| `StatusIsland` 双宿主 | 渲染层**已经宿主无关**，换宿主只是换材质 —— 规格 §8 的硬要求已满足 |
| 独立入口 | `widget.html` → `widgetMain.tsx` 只加载 tokens + status-island CSS，成本低 |
| 窗口层 | `widgetExpandGeom` 等纯函数（`utils/widgetWindow.test.ts`）+ `cargo test` 守着 ACL |
| 事件名与 ACL 通路 | `widget:notices` / `widget:action` / `shell:*` 已成型；小窗 ACL 已含取端口与 token |

### 4.2 缺的部分（重建/迁移的**唯一**目标）

1. **没有常驻的生产者** —— 后端**完全没有"通知"这个概念**
   （全仓 `app/` 搜 `notice|notif` 只命中一句注释）。
2. **汇总逻辑位置错了** —— 它住在"可以被销毁的那一侧"（主窗口 React）。
3. **没有快照/回放** —— 小窗新开时只能等下一次广播。

### 4.3 结论：**不要重建框架，要搬供数方**

- **重建（丢掉现在这套）** 的代价：`Notice` 模型 + `pickPrimary` + 双宿主渲染 +
  窗口几何 + 事件通路 + `utils/notificationHub.test.ts` / `statusIslandText.test.ts` /
  `widgetWindow.test.ts` 三份用例全部重写，而它们**没有一条是问题所在**。
- **要做的不是重建，是换供数方** —— 具体放前端还是后端、分几步走，
  见 `docs/design/notices/placement-frontend-vs-backend.md`（那份是"放哪"的**唯一真源**，
  含收益/风险对照、F1/F2/F3 三种"前端"的区分、以及会改变用户可见行为的那条语义风险）。

> **判据一句话**：`Notice` 与 `StatusIsland` 该不该留，看"去掉它问题还在不在"——
> 问题（隐藏后停更）**依然在** ⇒ 它们不是根因，不该跟着重建。

---

## 5. 顺手核实出的三类"双真源"（未来会咬人）

1. **主题**：`utils/theme.ts` 的 `DARK_IMPLEMENTED = false`，且 `usePrefs` 只在设置弹窗里调
   ⇒ 小窗**完全不知道主题**。我在样例里实测到同型事故：`<body data-theme="dark">`
   与 `<html>` 各写一遍，浅色主题**从未生效过**（自定义属性按最近祖先继承）。
2. **位置**：`widgetWindow.ts` 用 `localStorage`，而**偏好项**（`widget_*`）在后端 `app_meta`
   ⇒ 同一个"小窗设置"分居两处。
3. **展开方向**：Rust 算 `flipUp` 写 `data-flip`，`StatusIsland.place()` 也要算一次，
   「两处必须一致」（`UI-MAP.md:340`）—— 靠注释约束的一致性。

---

## 6. 待你拍板的问题

| # | 问题 | 影响 |
|---|---|---|
| **A** | 「定时抓取任务」在小窗里**要不要占位**？顶栏口径是"静默"，而你 2026-09-24 说小窗要看"定时抓取任务" | 决定要不要给自动节拍产生通知 |
| **B** | 主窗口隐藏时，小窗是**继续自己拉数据**（我推荐）还是**跟着一起静默**？ | 决定 S1 要不要做 |
| **C** | 长期落点选**后端**（我推荐）还是原计划的 **Rust**？ | 决定 S2 写在哪一层 |
