---
doc: frontend/architecture
class: framework
scope: 前端的分层与依赖方向、唯一宿主（顶栏）与入口、场景机与数据流、与 Tauri 壳的边界、样式与令牌策略、构建入口与 dev 工具面
not-scope: 组件与元素的逐项索引、设计令牌取值、形状语言与圆角阴影族 → frontend/UI-MAP.md；后端契约与状态码 → backend/HTTP-CONTRACT.md
sot: frontend/src/, frontend/vite.config.ts, frontend/index.html
verify: cd frontend && npx tsc --noEmit && npm run test
budget: 300
retire-when: 前端换框架，或"顶栏是唯一宿主"这条划分被取消
---
# 前端架构

## 1. 唯一宿主：顶栏（本层最重要的结构）

前端**只有一个入口、一个产物** —— 不是"一个应用加个开关"，也不是"两个应用"：

| 入口 | HTML | 挂载 | 是什么 |
|---|---|---|---|
| 主窗 | `index.html` | `src/main.tsx` → `App.tsx` | 整个应用：顶栏 + 图标栏 + V 列表栏 + 路由驱动的右栏 |

> ⚠️ **历史（2026-10-01 前）**：曾经有**第二个入口**（`widget.html` → `src/widgetMain.tsx`），挂载
> **桌面状态控件** —— 另一个置顶透明 Tauri 窗口（label `widget`）。2026-10-01 用户拍板**小窗整窗退役**
> （`devlog/270`）；2026-10-01..03 又重做过一版原型与"原生 Rust 重建"方案，**2026-10-03 用户决定
> 整条线彻底放弃**（成本远超收益，`devlog/274`）—— 入口、组件、壳侧支持、方案与规格一并删除，
> 早期实现在分支 `f2-widget-archive`。
> **下面这条拆入口的理由对"将来再开第二个窗口"仍然成立**，所以留着而不是删掉。

**为什么当年必须拆成独立入口**（R38 批 5b，devlog/173 起）：小窗最早走 `index.html?widget=1`，
靠 `main.tsx` 里的**运行时**判断分流 —— 但**静态 import 拦不住**，`App` / `react-router` / shadcn /
ECharts / `layout.css` 会被无条件打进小窗那个 renderer（当时实测大头是我们自己的代码与依赖，
不是 Chromium 的基础开销；数字见 `devlog/173`）。

⇒ **运行时判断替不了打包边界**：拆成独立入口之后，那个入口的加载量 = 入口文件顶部那几行，
**物理上不可能**再被主窗代码影响。代价是入口要**显式 import 它需要的那几份 CSS**
（当年小窗只 import 两份）—— ⚠️ **别顺手 import `layout.css` / `index.css`**，那正是拆入口要避免的东西。

**宿主身份**：`utils/hostIdentity.ts::setHost('main' | 'widget')` 是**连接级**的标签（放请求头
`X-DDToolkit-Host`），由入口自己调（主窗不调，默认就是 `main`）。后端据此让"发起方自己点的动作"
不回环提示它自己。⚠️ **`'widget'` 这个取值仍被后端承认**（`originator` 标签与三个 `widget_*`
偏好键都在数据层留着，见 `docs/backend/MESSAGES.md`）—— 但前端已无任何入口会设它，
而且**目前没有调用方**：它是留给将来第二个窗口的**接线点**，不是死代码。

## 2. 分层与依赖方向

```
pages/  ──►  components/  ──►  hooks/  ──►  api/
   │              │
   └──────────────┴──►  styles/（令牌与样式，无逻辑）
                  └──►  utils/（无 React 依赖的纯工具）
```

| 目录 | 文件 | 非空行 | 职责 |
|---|---|---|---|
| `components/` | 89 | ~14.2k | 界面组件（含 `common/` `live/` `posts/` `profile/` `ui/` `wordcloud/` 六个子目录） |
| `utils/` | 78 | ~7.0k | 无 React 依赖的工具：`shellBridge` `hostIdentity` `messageBus` `eventStream` … |
| `styles/` | 5 | ~7.1k | 见 §5 |
| `dev/` | 2 | ~4.6k | **dev-only**：`probe.ts`（探针的页面侧钩子）+ `MotionLab.tsx` |
| `api/` | 6 | ~1.7k | `api.ts` 请求封装 · `types.ts` 出参类型 · `errors.ts` · `validate.ts` |
| `hooks/` | 17 | ~1.5k | 17 个 hook（含 5 个 `.test.tsx`） |
| `pages/` | 3 | ~0.9k | 只有 `PostsPage` / `EmptyState` / `useVtuberActions` |

> ⚠️ 上表两列都是**测量值**，是 **2026-10-01 的快照**（`components/` 与 `utils/` 因小窗整窗退役各少 1 / 3 个文件，见 `devlog/270`）。
> 它**只给规模感，不必每次改结构都同步**；要重算：`Get-ChildItem <目录> -Recurse -File` 数文件、按"非空行"数行。

**已知的反向边**（改这两处要当心）：`utils/reservationDays.ts` → `components/live/liveCalendarFmt`、
`hooks/usePostPagination.ts` 与 `usePostQueryState.ts` → `components/PostFilterPop`（仅类型）。

## 3. 布局壳与路由

`App.tsx` 是唯一的路由层（`react-router-dom`）：**顶栏常驻**；左起依次是工具图标栏、
V 列表栏（均常驻）；右栏由路由驱动 —— `/` 空置界面、`/vtubers/:id` 帖子面板。
`ErrorBoundary` 包住整个壳层，TopBar/Sidebar 抛错也不会白屏。

最大化时给 `html` 挂 `window-maximized` 类，壳层圆角随之取消。

## 4. 数据流：场景机 + 原子提交

**切 V 全程没有"中间加载"帧**是这一层的硬要求，靠两个机制：

1. **`hooks/useSceneTransition.ts`** —— 预取闸门 + 原子提交：
   目标变化 → 先预取新 V 的数据（旧数据仍可见）→ 数据就绪 → `exiting=true` 播退场 →
   `EXIT_MS` 后**一次提交**（写入预取结果 + `exiting=false`）→ 播入场。
   它的契约刻意收窄：**只管状态与定时**，取什么数据（`prefetch`）、提交时写哪些 state
   （`onCommit`）、失败怎么办（`onFail`）全由调用方注入 —— **所以本 hook 不 import `api`**，
   也就保住了"不闪帧"的可断言性。
2. **`pages/PostsPage.tsx` 的场景机** —— 上述 `onCommit` 在这里**一次原子提交 7~8 个 state**。

⚠️ **为什么 `useVtuberRealtimeSync` 暂不抽独立 hook**（2026-09-27 用户拍板）：E6/E8 是**双写者**
（同时写 `vtuber` 与 `selectedAccount` 两台机器的 state），而这两个 state 的所有权就在上面那条
最敏感的 `onCommit` 上 ⇒ 抽独立 hook 会动到它。**等真有第二个消费者再动**。

## 5. 与 Tauri 壳的边界

- **`utils/shellBridge.ts`** 是调 Tauri `invoke` 的**唯一出口**：需要新命令时在
  `shellBridge` 加转发与原因，**别在组件里直接 `invoke`**（跨语言两份真源必漂）。
- **深休眠恢复不是深链接**：隐藏 10 分钟后 Rust 销毁 WebView，唤回时**重建窗口**并加载
  `index.html?restored=1`（SPA 的深链接在资源协议下会 404）；`App.tsx` 读到标记后把存下的
  路由/视图**校验过**再恢复，并立刻清掉现场（免得下次正常启动被"上一次的位置"劫持）。

## 6. 样式与令牌

`styles/tokens.css` 是**设计令牌的唯一真源**，其余样式只消费它。

| 文件 | 非空行 | 管什么 |
|---|---|---|
| `posts.css` | ~5.3k | 帖子列表 / 卡片 / 筛选（**单文件占了样式总量的一半以上**） |
| `layout.css` | ~1.0k | 应用壳：顶栏 / 图标栏 / V 列表栏 / 主区 |
| `status-island.css` | ~0.4k | 状态胶囊 + 面板（顶栏状态岛；2026-10-01 前与小窗宿主共用这一份） |
| `profile-board.css` | ~0.7k | 档案视图卡片画布 |
| `tokens.css` | ~0.2k | 令牌（色 / 圆角 / 动效 / 字体） |

⚠️ **`tokens.css` 行数最少但改得最勤**（全仓 churn/KLOC 最高之一）—— 它一改就是全局视觉。

## 7. 构建与开发工具面

- **单入口**：`vite.config.ts` 不配多入口 —— 默认入口就是 `index.html` → `src/main.tsx`
  （2026-10-01 前这里显式列出 `main` / `widget` 两个入口，随小窗退役一并删除，见 `devlog/270`）。
- **路径别名 `@` → `frontend/src`**；生产可用 `VITE_API_BASE` 直连后端。
- **开发代理**：`/api` → `http://127.0.0.1:8000`（剥前缀）。S1 起后端要会话 token，
  `define` 把**开发态固定 token** 编译期注入；它的默认值**必须与 `scripts/ui_probe.py` 的
  `PROBE_DEV_TOKEN` 一致** —— 不一致的症状是"探针页面所有数据为空 ⇒ 布局断言集体报红"，
  看起来像布局坏了（2026-09-25 真实踩过一次，devlog/201 §四）。
- **`dev/probe.ts`（~5.6k 行）是 dev-only 的页面侧钩子**，只在探针形态下注册。它和
  `scripts/ui_probe.py` 是一对：**改探针判据往往要同时改这两边**。

## 8. 去哪深入

| 要什么 | 去哪 |
|---|---|
| 某个组件 / 元素的类名、尺寸、令牌取值 | `docs/frontend/UI-MAP.md`（查询索引 + 美学总纲） |
| 状态胶囊 / 档案卡片的动效规格与不变量 | `docs/frontend/specs/` |
| 后端给前端的契约与状态码 | `docs/backend/HTTP-CONTRACT.md` |
| 壳侧（窗口 / 托盘 / 会话 token / 更新器） | `docs/desktop/SHELL.md` |
| 怎么验、门禁几档 | `docs/DEV-LOOP.md` |

## 9. 拆前端入口的坑（本层的专属清单）

## 六、拆前端入口 / 抽共用样式时的坑（2026-09-24 加，devlog/181）

⚠️ **这是一份历史清单，但对将来仍然适用**：全部来自 2026-09-24 把桌面状态控件拆成独立 HTML
入口（`widget.html` → `src/widgetMain.tsx`）那一次 —— 那个入口 2026-10-01 已随小窗整窗退役删除
（`devlog/270`）。**"要过哪些关"与那个入口叫什么无关**：将来再拆入口，照这份清单逐条过。
**共同点：漏掉的东西都不在任何 import 图里，所以编译、类型检查、单测全是绿的。**

### 6.1 「顺带生效的东西」是拆入口最容易漏的一类依赖（样式 + 启动副作用）
漏掉的**从来不是组件自己**，而是"原来顺带生效的全局东西"。这条纪律到目前**犯了五次**：

| 次 | 漏掉的 | 表现 | 为什么难发现 |
|---|---|---|---|
| 1（devlog/181） | Tailwind preflight 的 `box-sizing`（只在 `index.css` 里） | 胶囊宽 **224px** 而非规格的 200px（退回浏览器默认 `content-box` ⇒ 宽高各多出 padding + border） | 尺寸差看得见 |
| 2（devlog/185） | `layout.css` 里的 `.os-*` 样式（`OverlayScroll` 用得到） | 面板里条目与页脚**叠在一起**（没有 `display:flex`）—— **比 preflight 那次更容易漏，因为它是"我们自己另一个文件里的样式"** | 排版坏了看得见 |
| **3（devlog/188）** | **`main.tsx` 的启动副作用**（`setApiBase` 注入后端端口） | **每 2 秒一个 `ECONNREFUSED`**（`/api` 在桌面端没人代理，真后端在动态端口上） | ⚠️ **界面完全正常** |
| **5（devlog/264）** | **`layout.css` 里的胶囊"解剖"**（`display:flex`/`gap`/`border-radius`/字号/点的 7×7） | 真窗口里胶囊是**方角 + 非 flex 行**、字号 16、**点 0×0（紧迫度整个通道看不见）** | ⚠️ **探针一直在"主窗口"里量**（`?density=widget`），那份文件它加载得到 |
| **6（devlog/264）** | **`layout.css` 的 `body { font-family: var(--font-family) }`** | 真窗口里胶囊与面板用的是 **WebView2 默认字体**（实测 `"Noto Sans SC"`，顶栏是 Alimama）—— 而且 `tokens.css` 的 `@font-face` **下载了却没人用** | ⚠️ 同上：字号/宽高都对，只有**字体族**不对（肉眼能看出"字体不一样"，但没人量过） |
| **7（devlog/265）** | **`layout.css` 的 `@keyframes si-panel-in-fade`** | 引用它的 **reduce 分支在共用文件里** ⇒ 小窗在 `prefers-reduced-motion` 下引用一条**不存在的动画名**（等于没有入场） | ⚠️ 只在**开了 reduce 的机器**上、且**只看小窗**才现形（definitely"没人量过"） |

**第三次最危险**：前两次是**样式**（肉眼能看出不对），这次是**副作用** —— 面板照样显示、胶囊照样亮，只是后台一直在打一个死端口。**"界面看起来对"完全不能推出"它在正常工作"。** 而**副作用漏了不会红**：没有测试、没有类型错误、探针也不查（它只看界面）；唯一能兜住的是**看日志** —— 所以"用户说日志里有报错"永远值得当成正经线索查到底。
**第 4 次没有发生**（devlog/202，S1 会话 token）：那个入口是独立入口，**也要**注入 token —— 这次是按下面第 3 条清单逐条过时**提前抓到**的（它到 S1 前只注入端口）。⇒ 清单是能用的，别等它红。
**第 5/6 次（2026-09-30）的教训与前面四次不同**：漏的东西都是**样式**（好发现），但**判据的坐标系错了** ——
当时那条小窗探针有**两段**：第一段跑在 `index.html?density=widget`（主窗口，加载得到 `layout.css`），
第二段才在真入口里。解剖与字体**只被第一段量过** ⇒ 绿。（该探针段已随小窗退役删除，见 `devlog/270`。）
**"漏了东西"和"漏了坐标系"会互相掩护**：只要有一条判据在错的地方量，前者就永远不会红。
⇒ 拆完入口后**每一条新判据都要问一句"我量的是哪个坐标系"**（判据必须跑在**用户实际看到的那个
盒子**里 —— 当年就是"在大视口里量一套塞进小窗口的样式"，一路绿而用户从没看见过那个面板），
并且**共用文件的搬家方向必须单向**：大文件 → 共用文件（D1 就是把 `.topbar-status*` 的共享部分
搬进 `status-island.css`，**搬不是抄** —— 留一份就又变成两个真源）。
⚠️ **第 6 次还教了一件**：新加的那条判据在顶栏宿主里是**正对照**（那条继承链必然成立）——
拆出来的那个入口红了就只能是入口差异，不必再论证"胶囊本来就该用全站字体"。**判据成对写，因果更省事。**
**规矩**：
1. **新建/拆分入口后，逐个核「当前布局与运行靠哪些全局东西兜着」** —— preflight / base 层（⚠️ **`body` 上的 `font-family` / `color` / `line-height` 这一类和 `box-sizing` 一样会漏**）/ reset / 自定义属性（`tokens.css`）/ 被跳过的那个入口模块的**顶层副作用**。判据：*这个属性我在组件里没写过，那是谁给的？* 找不到出处，就当它不存在，**显式补上**。
2. **审计办法（可复用）**：从组件源码抓出所有 `className`，逐个查"是否**只**在另一个入口的 CSS 里定义" —— `used − classes_in(新入口能拿到的 CSS) − classes_in(新入口拿不到的 CSS)` ⇒ **判据不是「它看起来属于哪一块」，而是「用到它的入口有几个」**。共用组件的样式必须放**共用文件**；搬家方向是单向的（大文件 → 共用文件），反过来不行（新入口引 `layout.css` 正是独立入口要避免的那一类代价）。
3. **顶层副作用清单**（逐条过）：`setApiBase` / 任何 `api.*` 的基地址注入 · 全局监听（`window.onerror` / `unhandledrejection` / `resize`）· 定时器与轮询的启动 · 埋点 / 主题应用 / `localStorage` 迁移 · 静态启动幕的摘除与根元素上的标记属性。判据还是那句：**「这个东西是谁设置的？新入口里有人设置它吗？」**
4. **共用文件必须自包含**：抽 `status-island.css` 时开头几行 reset 是两个入口都需要的，一度只留在主入口那份 ⇒ 表现是"主窗口正常、另一个入口错位"。**共用样式文件不假设调用方设好了什么**，要复用的 reset / 变量跟着内容一起搬。
5. ⚠️ **「只在真机上生效的修复」等于没法验证的修复**：`--widget-panel-max-h` 的赋值曾写在"展开就 resize"那个 effect 里（该变量随小窗退役删除），而那条 effect **第一行就** `if (!('__TAURI_INTERNALS__' in window)) return` ⇒ **探针里这个变量永远设不上**，走的还是那条有 bug 的 `60vh` 分支。**"我修了、我验了、但验的不是我修的那条路"比不修更危险**，因为它让人以为已经安全。修复若依赖"只在真机存在的条件"（Tauri 存在 / 有真窗口 / 有托盘），**它的验证也必须在真机上**，或者把**前提挪到环境无关的地方**（这次就是把变量准备单拆一条 effect）；写修复时问一句 **「这条路径在探针/CI 里跑得到吗？」** 跑不到 → 要么挪，要么在 `TODO.md` 里显式记下"只能真机验"。
⇒ 那份入口专属的探针命令**已随小窗退役删除**（`devlog/270`），但**这份清单与上面两条方法论与入口无关** —— 拆新入口时照用。
