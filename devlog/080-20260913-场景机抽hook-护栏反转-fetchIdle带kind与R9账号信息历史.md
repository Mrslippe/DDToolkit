# 080-20260913-场景机抽 hook（含护栏反转）+ fetch-idle 带 kind + R9 账号信息历史

> 用户点名执行三件（其余项不动）：
> 1. **R9**「曾用名/曾用签名归入账号信息历史快照」；
> 2. **`PostsPage` 场景切换机抽 hook**（§1.1-d，行为级重构，**要求先有护栏**）；
> 3. **R2 可选第二步**：`fetch-idle` 带 kind，日历/趋势不再被每轮动态流无意义唤醒。
>
> 本批**没有后端改动**（迁移 head 仍 `f004`），全部在前端 + 探针。

---

## 一、场景机护栏：先把 devlog/071 的悬案反转了

### 1.1 事件经过

devlog/071 记过三次护栏尝试失败：点侧栏切 V 后"路由与侧栏都切了、场景机也进了
`scene-exit`，但 200ms 的提交定时器始终没落地"，当时**分不清探针环境还是真 bug**，
于是把护栏整体撤了，并留下"下次先给探针加真实时间模式"的建议。

### 1.2 这次先查清，再决定怎么做

先试了"真实时间模式"这条建议的可行性 —— 结论是**无头 Edge 给不了**：

| flag 组合 | 结果 |
|---|---|
| `--dump-dom` | 页面一 load 就 dump（JS 还在跑就截断了） |
| `--dump-dom --timeout=6000` | `--timeout` 只是**上限**，不会等真实时间 → 仍然 load 即 dump |
| `--dump-dom --virtual-time-budget=6000` | 虚拟时间把定时器快进 → 拿到 `t3` ✓（现有探针就是这么工作的） |

所以要"真实时间"就得走 CDP/websocket（或自建阻塞式握手），成本明显不成比例。
**于是换一条更直接的路：把 fetch 与场景机的状态变化都记下来**，一次跑完就能定性。

### 1.3 诊断结果：机器没问题，是探针在看旧节点

`?probe=scene` 第一版输出（**关键几行**）：

```
提交耗时=-1ms  末态 hero='泽音Melody'  末态仍在退场=True
body 变化序列=['view-body', 'view-body scene-exit']
在途请求=0
  · done 10ms /vtuber/14          ← 预取请求 10ms 就回来了
```

预取回来了、hero 也换成新 V 了，但 `scene-exit` 还在？再加一层**页面内埋点**
（`window.__sceneLog`，跑完即撤）后真相出现：

```
run(accChanged=True, tick=0) → not-ready
run(tick=1) → run(exiting=True) → **commit-timer(hasEntry=True, entryAcc=14)** → run(exiting=False, sceneAcc=14)
```

**提交在 t=3118（点击后 250ms）就完成了**，`scene.exiting` 也回到了 false。
"停在 `scene-exit`"是**探针自己的错**：它在点击**之前**抓了一个 `.view-body` 的 DOM 引用，
之后一直读那个**已被 React 换掉**的旧节点 —— 旧节点上自然永远留着退场类。

所以 devlog/071 的结论要**反转**：那不是真 bug，是探针采样错；`--virtual-time-budget`
对本护栏**够用**（不需要真实时间模式）。

### 1.4 修好的护栏（永久断言，`ui_probe.py --scene`）

- **每次重新查 DOM**（`document.querySelector('.view-body')`），并让 MutationObserver
  挂在 `document.body` 的 subtree 上记录 class 变化序列；
- 侧栏选中项取 **`.vtuber-item.active .vtuber-name`**（原来拿整条 item 的文本，含"直播中"
  徽章与签名，与 hero 名比较必然不等 → 假失败）；
- 记录点击后**所有 fetch**（state/耗时/路径）→ 以后再有人说"卡住"，第一时间能看是不是
  预取没回来；
- 四条断言：提交必须发生、末态不得停在退场态、侧栏与右侧内容必须一致（按 V 名比）、
  侧栏至少两个 V（数据前提）。

> 教训与 devlog/075/076 同型：**测试量错了轴，全绿或全红都没意义**。
> 这次是"全红"，而红的原因是采样对象过期。

## 二、场景机抽 hook：`hooks/useSceneTransition.ts`

护栏绿了才动手（§1.1-d 的前置条件）。

- **只搬不改**：状态（`scene`/就绪计数）、预取门控（同目标复用、`alive()` 丢弃晚到结果、
  失败也进 `done`）、两个 `setTimeout(EXIT_MS)` 提交、以及 effect 依赖数组**逐行照抄**；
- **职责边界**：hook 不 import `api` —— 取什么数据（`prefetch`）、提交写哪些 state
  （`onCommit`）、失败怎么收尾（`onFail`）由页面注入。于是"机器"与"页面的数据形态"解耦，
  hook 泛型为 `<T, V extends string>`；
- `PostsPage` 里那台机器（原先 166–325 行 ≈160 行）缩成 `prefetchScene` + `onCommit` +
  `onFail` 三个小块；`EXIT_MS` 常量随 hook 走（值仍 200ms，与 `layout.css` 的
  `.scene-exit` 0.2s 对齐）；
- **保留的既有行为**（写进注释，免得下次当 bug 改）：快速连点时**不 abort** 旧预取，
  只靠 `alive()` 丢弃 —— 想省配额得在 `prefetch` 里自己 abort。

**验证**：`--scene` 绿（提交 250ms、末态一致）+ `--hero-expect` 位级签名一致 +
`--archive --calendar-expect` 位级签名一致（三个视图的渲染结果没被动过）。

## 三、R2 第二步：`fetch-idle` 带 kind

原先这是一个裸 `Event`：**任何**任务跑完都发一次，而动态流每 60~80s 一轮 ⇒
粉丝趋势卡每轮都被重取并重建 ECharts（R2① 已修掉闪加载态，这一步省的是请求与重绘）。

- 新增 `utils/fetchIdle.ts`：`FetchIdleKind = 'account' | 'posts' | 'external'`、
  `dispatchFetchIdle(kinds)`、`onFetchIdle(cb)`（**没有 detail 的老事件按"全都算"**，
  老派发方/老消费者都不会漏刷）、以及判定表 `affectsFanTrend` / `affectsLiveCalendar`；
- `TopBar` 两个派发点带 kind：外部批次 `['external']`；running→idle 边沿按**哪条流**
  跑完给 `account`/`posts`（首轮没有 prev 时按"全都算"发，宁可多刷一次）；
- `PostsPage`：列表/卡片/日历照旧吃全量 `refreshTick`；**趋势图换 `trendTick`**，
  只在 `account`/`external` 时 +1。

### 一处与 TODO 原文的口径修正（要说明白）

TODO 里写的是"日历/趋势只在 `external`/`account` 类任务后刷新"，但实现时发现
**日历不能只认这两类**：动态流的 feed 页里带**直播卡片**，`_route_live_item` 会把它落成
`live_sessions`（实测日志里 `直播场次入库 feed` 就出现在动态轮里 —— 本批 e2e 跑也复现了），
所以 `posts` 类刷新对日历是**有意义**的，砍掉会让"某人刚开播"要等到下一次账号/第三方刷新
才出现在日历上（可能几小时）。真正"无意义"的只有趋势图（动态流不写快照）。
判定表因此是：**趋势 = account|external；日历 = 三者全要**，并把这个理由写在
`utils/fetchIdle.ts` 的表格与注释里。

**测试**（vitest，+5）：去重与空数组不发、带 detail 按 kinds 回调、无 detail 的老事件按
"全都算"、老 `addEventListener` 消费者照旧收到、判定表真值。
（vitest 跑在 node 环境没有 DOM ⇒ 事件宿主做成可注入参数，判定表才测得到。）

## 四、R9：账号信息历史弹窗

用户口径：曾用名/曾用签名**属于「账号信息历史快照」这一类**，且要是"V **在平台上**曾经用过的
值"（抓取覆盖前记账），**不是**本地手改入库的字符串（devlog/075 撤掉内联展示的原因）。

形态：档案设置 →「已订阅账号」每行右侧新增**历史钮**（`.vd-acc-hist`）→ 打开
`AccountHistoryDialog`（新组件 + `.ah-*` 样式），两块内容各有出处：

| 区块 | 数据源 | 语义 |
|---|---|---|
| 曾用名 / 曾用签名 | `GET /vtuber/{id}/former-values`（`vtuber_field_history`） | **只记平台侧改动**（抓取覆盖前记账）；按账号过滤，其余账号条数用一句灰字说明 |
| 账号信息快照 | `GET /account/{id}/stat-snapshots`（`account_stat_snapshots`） | 时间倒序 60 条：粉丝数 / 直播状态 / 开播标题 / 来源标注（自采 · zeroroku） |

刻意**不做**：① 不复用编辑区的内联展示（那正是被否掉的形态）；② 不把快照塞进 `VTuberOut`
（`/vtuber/list` 会变 N+1）；③ 不显示"当前值"（弹窗标题与账号行已经有了，这里只回答"以前是什么"）。

纯逻辑抽到 `utils/accountHistory.ts`（+6 条断言）：按账号过滤与"其它账号条数"、
来源标注、`live_status=null` 是**未记录**而不是"离线"、开播标题只在直播中展示、
粉丝数千分位、缺值不显示 0。

**护栏**：`--settings` 探针新增 4 项 —— 历史入口存在、点击后弹窗打开、**快照行 > 0**
（或明确空态）、关闭后档案设置仍开着（嵌套弹窗层级）。实测：**曾用值 1 行、快照 60 行**，
两条数据都是真实库里的内容。

## 五、验证

| 门禁 | 结果 |
|---|---|
| `pytest` | **312 passed**（本批没动后端；1 条真实网络冒烟按环境 skip） |
| `vitest` | **131 passed**（119 → +5 fetchIdle、+6 accountHistory、+1 其它口径） |
| `tsc` / `eslint` | 0 错（`--max-warnings 0`） |
| `ui_probe --scene` | 绿：提交 250ms、末态 hero/侧栏/路由一致、无残留退场态 |
| `ui_probe --settings` | 绿：29 项（含 R9 四项；曾用值 1 行 / 快照 60 行） |
| `ui_probe --hero-expect` | 位级签名一致（重构没动渲染结果） |
| `ui_probe --archive --calendar-expect` | 日历格签名一致 |

## 六、遗留

- 场景机**快速连点时不 abort 旧预取**（行为照搬）：省配额可以后续在 `prefetch` 内
  `signal` 加 abort —— 但那会改行为，得单独一批做并补护栏；
- `fetch-idle` 的 kind 目前由前端判定"哪条流跑完"；后端 `last_result.kind` 更精确
  （`full_all`/`adopt`/…），但它只在"有终局"的任务上出现，动态流没有 → 前端边沿方案够用；
- 账号信息历史弹窗**不做分页/搜索**（上限 60 条 + 一句"最近 N 条"）；真要看全量可以走端点
  `?limit=1000`；
- 探针仍无"真实时间模式"：本批证明**本仓现有护栏用虚拟时间够**（§1.3），
  真需要交互式实时采样时再上 CDP。
