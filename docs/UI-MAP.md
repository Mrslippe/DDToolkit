# UI 设计映射文档（UI-MAP）

> 修改前端界面时，按本文档名称精确指定目标区域/元素。
> 结构约定：`组件文件 → CSS 类名 → 关键子元素`。设计令牌统一在 `src/styles/tokens.css`（唯一真源，
> 本文档数值以 tokens.css 与各 css 文件实际声明为准）。
>
> 设计语言总纲：**方形极简 + 全平面零阴影**（shadcn `--radius:0rem`、`--shadow-card:none`）。
> 圆角/阴影豁免收敛为四族（其余一律回方形总纲）：
> ① 列表工具行「浮片」：斜切白卡（`--pill-radius:3px` + `--pill-skew:-10deg` + `--pill-shadow`）；
> ② 帖子面板「药丸族」：`type-chip` / `.search-float input` / `post-card-type`/`post-card-duration` 角标 / `stat-badge`（均 999px 或渐变软光）；
> ③ 功能性气泡：`live-tag`（8px）、粉丝 `stat-pill`（2px 图像底）、筛选/时间 popover 抽屉阴影（16px 浮置深度）；
> ④ **档案卡族**（R37-P4a）：`.pcard` 的 `--pcard-radius:12px` + `--pcard-shadow*` 四档 +
> 顶部 1px 高光内边 `--pcard-ring` —— "圆角阴影稍微浮起"的小组件式卡片（规格 `docs/design-archive-cards.md`）。
> **⑤ 视图切换条**（R39-D3/D4 → **R45 改定**，2026-09-24）：`.view-switch` **加入 ① 浮片族的配方**
> （`--pill-bg` 不透明实底 + `--pill-shadow`，圆角取 ④ 的 `--pcard-radius`）—— 它**不参与**
> ④ 的阴影四档（那四档是档案卡专用的升降序），只借"圆角 + 实底 + 阴影"这套**形状语言**。
> ⚠️ R39-D3 那版是"毛玻璃工具栏"（白 .10 + `backdrop-filter` + 只有 inset 边），
> **R45 已推翻** —— 它在默认近白背景上贡献为 0，理由见 §B1 与设计指南第 3/5 条。
> 条内的**选中块** `.view-switch-thumb` 用**选中语言**（`--sel-bg` 浅粉底 + `--c-primary-deep` 主色粉边，
> 与侧栏选中行的 `--sel-bg`/`--sel-bar` 同一套），**它不加外阴影**（面上的面）—— 见 §B1。
> 整条**不占布局、按需出现**（`position:absolute` + `data-shown`）—— 见 §B1「工具条显隐状态机」。
> ⚠️ 族内的 **tone 色**（`--tone-*`）**只许用在 ≤22px 的贴纸角标与 ≤11px 的文字 chip 上**，
> 卡面主体永远是白卡 + 中性文字。
>
> 对比度约定：顶栏「标题/状态/窗口图标」为**品牌装饰性白字**（保持设计稿原稿，logo 类豁免）；
> 功能性文字与数字一律达标（`--c-text-sub:#5b6c7e` ≥4.5:1、粉丝徽章 `--pill-fill-*` 白字 ≥3:1 大号数字）。
>
> **滚动条标准见 F 节**（2026-09-07 定案，全文所有滚动容器一律参照，新滚动容器必须查询该节）。

---

## 0. 启动链路与窗口（index.html + src/main.tsx + src-tauri lib.rs）

| 环节 | 实现 | 说明 |
|---|---|---|
| 首绘粉底 | `<head><style>html{background:#ffa2b4}` | HTML 解析即染粉，消除「白底窗口→透明轮廓」两个原生中间态 |
| 静态启动幕 | `#boot-splash`（纯内联样式） | 粉底 + 用户设计 LOGO（白色猫脸矢量，内联 SVG）+ 呼吸动画，不依赖 bundle |
| 启动诊断陷阱 | `#boot-diag`（`window.__bootLog` / `__bootFold`） | 捕获 `[error]/[resource]/[console.error]/[promise]` 四类，常驻右上角徽章，可展开/一键复制；React 就绪后自动折叠 |
| 全局右键禁用 | `document.addEventListener('contextmenu', preventDefault, true)` | 捕获阶段，覆盖一切渲染时序 |
| 窗口创建 | `visible:false`（tauri.conf） | 隐藏创建，杜绝原生空窗帧 |
| 显示链路 | main.tsx 模块顶层 `invoke('present_window')` | 应用自有命令绕开 capability（`allow-show` 缺失历史问题）；失败写诊断留痕 |
| 兜底显示 | lib.rs 8s 后台线程 `is_visible→show()` | 任何 JS 链路失败时窗口最迟 8s 出现（幂等，不重复） |
| 引导 | `tauriBootstrap()`：`get_backend_port` → `healthz` 轮询 → `setApiBase` | 就绪后进入 `opening` |
| 状态机 | `BootState: pending→opening→done/failed` | `ENVELOPE_MS=750` 信封动画播完卸载启动幕 |
| 窗口本体 | 1440×800 / 无框 / 透明 / L3 自绘圆角 | `--radius-window:4px`（Rust 侧已禁 DWM 阴影与系统圆角，只前端一套弧线） |
| **托盘与隐藏**（R18/R20，devlog/095/097） | Rust `tray-icon` + `shell:hidden` / `shell:shown` / `shell:quit-requested` 事件 | **点 ✕ 不再退出**：`CloseRequested` 被拦 → `hide()` + `set_skip_taskbar(true)`（后台抓取继续、前端停表）；托盘左键唤回、菜单可退出；隐藏 10 分钟**深休眠**（销毁 WebView 省内存，唤回时重建 + `?restored=1` 恢复位置）。前端停表逻辑在 `utils/shellLifecycle` + `hooks/useShellHidden`；关闭语义偏好 `prefs.close_action`（`ask` 默认 / `tray` / `quit`），首次点 ✕ 由 `CloseActionDialog` 询问（DOM 契约：`data-testid="close-ask-dialog"` + `[data-choice="tray|quit"]` + `data-testid="close-ask-remember"`；**判开合读 `data-state`，不读"节点在不在"** —— Radix `Presence` 在无头虚拟时钟下不退场，踩过两次）。**R20 起托盘「退出」不依赖前端**：Rust 先问 `manual_running`，无任务即 `exit(0)`，有任务才唤回窗口走上面的确认链 |
| 最大化 | `html.window-maximized` 类 | 壳层圆角归零（App.tsx `useMaximizedClass` 监听 `onResized`） |
| 应用图标 | `scripts/make_icons.py` → `frontend/src-tauri/icons/` | **2026-09-09 重做（任务栏图标模糊）**：矢量源 `docs/design/svg/LOGO.svg`；`icon.ico` **目录首项 = 48px 任务栏专用层**（tauri-codegen 取 `entries()[0]` 当 `default_window_icon` → tao 设为 `ICON_SMALL` → Win11 任务栏就是它；旧文件首项是 16×16，被放大到 24/36px 才糊）；**≤48px 用小尺寸专用稿 `docs/design/svg/LOGO-small.svg`**（用户 2026-09-09 定稿：头部轮廓 + 大圆点眼 + 每侧 3 根短胡须，轮廓 stroke 16 / 眼径 26，24px 下胡须 3.0px 仍可见），≥64px 用主稿 stroke 7.5 全细节；详见 `scripts/make_icons.py` 头注释 |
| 图标改动的构建依赖 | `src-tauri/build.rs` | **必读**：图标由 tauri-build 的构建脚本读取（生成 context 的 `default_window_icon` + winres 的 exe 资源），而 tauri-build 只对 config/resources/capabilities/frontendDist 声明 `rerun-if-changed`——**图标不在其中**，只改图标时 cargo 不重跑构建脚本、窗口图标与 exe 资源都保持旧值。故 `build.rs` 显式声明 `icons/icon.ico|icon.png|32x32.png|128x128.png` 四个依赖；改图标后仍建议 `cargo clean -p ddtoolkit` 一次以清掉旧缓存（Windows 图标缓存也需刷新） |

---

## A. 应用壳层（App.tsx + styles/layout.css）

| 名称 | 组件 / 类名 | 说明 |
|---|---|---|
| 应用壳 | `.app-shell` | 纵向 + body 横向布局，4px 自绘圆角（透明窗内部裁剪，白圈已注释） |
| 主行 | `.app-body` | `flex:1; min-height:0` |
| 内容区 | `.app-main` | `padding:0; overflow:hidden`，滚动权交付页面内部（posts.css） |

### A1. 顶栏 `<TopBar>`（components/TopBar.tsx）

> 2026-09 紧凑壳层（TopBar 40px / Rail 50px）定稿后按 CSS 实际值登记；
> 原始设计稿（Frame411）尺寸已放大 1.725 倍后等比缩回，**以本表为准**。
> 整条 `data-tauri-drag-region` 拖拽区。

| 名称 | 类名 | 说明 |
|---|---|---|
| 顶部栏 | `.topbar` | 底色 `--c-primary`，高 `--topbar-height:40px` |
| LOGO 占位区 | `.topbar-logo-zone` | **72×40** 横跨全高，flex 居中 |
| LOGO | `.topbar-logo` | **用户设计猫脸**（`docs/design/svg/LOGO.svg`，内联矢量 `common/Logo.tsx`，`currentColor` 白描边）**31×24**（viewBox 167.087×131.01 → 1.2754:1） |
| 标题 | `.topbar-title` | 定宽 **150×40**，垂直居中/水平左对齐；**15px、字距 5px**（`--font-title` = `--font-family`，2026-09-09 用户要求换成阿里妈妈方圆体，原思源黑体子集已删）；`user-select:none` |
| 状态行 | `.topbar-status` | 绝对居中；**容器只在「有事发生」时出现**（2026-09-09 五轮定调后定稿）：基态 `background:transparent` + 白字 `#fff` + **13px**/500 + r999 + padding `0 12px`（常驻，徽章亮灭时文案不跳位），与顶栏 logo/标题/图标同级；**事件态**（抓取中 / 操作结果覆盖）挂 `.on` → `background:#c9406f` 深玫瑰徽章 + 白字，`transition: background-color .18s` 淡入淡出。配色依据：复用项目「深粉底 + 白字」徽章配方（粉丝徽章 `--pill-fill-pink #e35d8b`、`.float-pill.on`）同色相压深一档——**白字对底 4.72:1（达 AA）**、徽章对顶栏粉 2.49:1（形状清楚）；`#e35d8b` 只有 3.38:1 故未用。`max-width:46%` + `overflow:hidden`，超长文案省略号落内层 `.pill-text-fade`。**文案格式（2026-09-10 P8-C）：`任务名 - V名 - i/N`**，例「动态更新中 - 明前奶绿 - 1/11」「账号信息抓取中 - 七海Nana7mi - 3/10」「正在同步{label}」（外部任务）；任务名映射见 `TopBar.tsx::TASK_TEXT`（account/dynamic/update/full/quick/adopt），V 名缺失时退回过程性文案（平台名/账号名），`total>0` 才显示 `i/N`。**哪些任务上顶栏见 §A1.1（自动节拍静默）** |
| ├ 抓取中 | `.topbar-status-spinner`（lucide `Loader2` 14px 旋转，`currentColor`=白） | 2026-09-09 换：原设计稿图标 `Frame_41_8.svg` 是白色填充，在浅底上等于隐形；lucide 走 currentColor，资源已删 |
| ├ 空闲 | i `.topbar-status-dot`（绿 `#52c41a` 7px） | 无容器，直接落在顶栏粉上 |
| └ 成功覆盖态 | `.topbar-status-dot.ok`（**白点**，此时徽章已亮起）| pill-message 覆盖窗，4s 后文案消失 → `.on` 自动移除、徽章收回 |
| 弹性空隙 | `.topbar-spacer` | 推到右侧 |
| 窗口控制组 | `.topbar-window-controls` | **三格 46×40 通栏贴合**，无间距无右缘留白 |
| ├ 最小化 | `.topbar-win-btn`（lucide `Minus` 30px） | 原生 `minimize()` |
| ├ 最大化/还原 | `.topbar-win-btn`（`Square`/`Copy` 20px） | `toggleMaximize()`；`onResized→isMaximized` 同步图标；title 切换「最大化/还原」 |
| └ 关闭 | `.topbar-win-btn.close`（`X` 30px） | busy 时 AlertDialog 二次确认；hover **酒红 `#8e2334`** |
| 普通钮 hover | `.topbar-win-btn` | **浅粉 `#ffbccb`** |
| 登录入口 | `.topbar-login-btn`（`LogIn` 16px） | 与窗口钮同规格 46×40；B站会话过期时右上角 8px 红点徽章（`.topbar-login-badge`）；打开 `<LoginDialog>` |

#### A1.1 状态行「展示什么」的策略（2026-09-10 用户：频繁的动态轮询不必占顶栏）

**原则**：状态行是**用户动作的进度显示器**——只展示「有起点、有终点、用户能预期」的任务。
**自动节拍**（定时档发起、跑完立刻排下一轮、没有终局）一律静默：它长期占着顶栏会让人
分不清「卡住了」还是「常态在跑」，还会把操作结果覆盖态（`pill-message`）一直挤掉。

| 任务 | 触发方 | 后端标识 | 顶栏 |
|---|---|---|---|
| 抓取账号 / 更新动态 / 抓取帖子（全量·单 V） | 用户点按钮 | `manual_running=true`，`auto=false` | ✅ 展示（`任务名 - V名 - i/N`） |
| 收录新 V / 添加账号（账号信息 + 首屏 + 外部回填） | 用户动作连带 | 同上 + `external` | ✅ 展示（首屏完成另有瞬时胶囊） |
| 第三方数据批次（每日 / 启动补抓 / 收录回填） | 定时或启动，低频但耗时（~3min） | `external.running` | ✅ 展示「正在同步{label}」+ 完成胶囊 |
| 兜底排队抓取（抢锁失败转排队） | 定时档兜底 | 手动语义（用户动作引发） | ✅ 展示 |
| **动态流常态轮询** | 综合档，一轮接一轮（实测 ~80s 一轮） | `post.auto=true` | ❌ **静默**（不文案/不亮容器/不拦关窗） |
| **自动账号流扫描** | 综合档，按账号到期（24h 数据驱动） | `account.auto=true` | ❌ **静默**（同一原则：自动、无终局） |

实现（`TopBar.tsx::isQuietTask`）：`running && auto === true` → 静默。判据用后端事实而
**不是任务名**——同一个 `update`/`full` 文案手动与定时都会用，只有后端知道这次是谁发起的
（`GET /vtuber/fetch-status` 每类带 `auto`，另有顶层 `manual_running`）。旧后端缺 `auto`
时视为手动（照旧展示），不会因字段缺失静默掉真任务。

**静默不等于不刷新**：`fetch-idle` 的 running→idle 边沿判定仍用**原始** `running`
（含静默任务）——动态流每轮结束照样派发事件，卡片/侧栏/hero 才不用等用户手动刷新。

**按钮禁用同源**：`fetchBusy`（`fetchBusy.ts`，按钮/批量弹窗据此禁用）改用后端
`manual_running`（与手动端点 409 判据同一函数）。此前用 `account.running || post.running`
→ 动态流每轮把按钮禁用掉，而**后端其实会受理**（手动优先会抢占自动档，`manual_task_running()`
在自动档持锁时为 false）。

### A1-a. 顶栏状态岛 `<StatusIsland>`（components/StatusIsland.tsx，2026-09-15 R12a devlog/089）

顶栏中部（`.topbar-status` 胶囊外观不变）。**改造前是"三套并存"**：轮询算出的任务胶囊 +
`ddtoolkit:pill-message` 瞬时覆写 + 全量抓取完成的 AlertDialog；风控冷却**只在日志里**。
现在统一成「一个控件 + 一份判定」：

| 层 | 位置 | 职责 |
|---|---|---|
| 判定（纯逻辑，12 条单测） | `utils/notificationHub.ts` | 条目模型、**优先级 `alert>progress>report>message`**、过期（`expiresAt` / `sticky`）、命名规则 |
| 空闲内容（纯逻辑，15 条单测） | `utils/idleQuotes.ts` | 空闲轮播池（第 0 格 = 状态文案，后接语录）、取模选格、`registerIdleProvider` 扩展点 |
| 渲染 | `components/StatusIsland.tsx` | 四态 `idle`（绿点 + 空闲轮播文案，**无容器**）· `pill`（一条主文案 + 图标 + 计数）· `expand`（portal + fixed 面板）· 空闲轮播（R12b） |

**六类信息源**：任务进度（`fetch-status`，**自动节拍不产生条目**）· 第三方同步 · 完成报告
（改为**常驻条目** + 「查看详情」开原对话框，不再自动弹窗）· 登录失效（常驻 + 「去登录」）·
**风控冷却**（`fetch-status.rate_limit` 新增字段：`{active, reason, seconds_left}`，到点自动消失）·
瞬时消息（ttl 4s）。

DOM 契约（探针 `ui_probe --status-island` 直接查）：`.si-island`（`.on` = 有事发生）· `.si-dot`
（`.warn` = 红）· `.si-text` · `.si-count` · `.si-chevron` · `.si-panel`（`data-pinned` = 点击钉住）·
`.si-item[data-kind]` · `.si-item-meta`（含来源标注）· `.si-item-action`。

**呼出与收起（R39-C，用户 2026-09-19：「改为鼠标 hover 就呼出，离开就收起，并且下拉栏居中」）**：

| 通道 | 口径 |
|---|---|
| 悬停进入 | **120ms 后展开** —— 鼠标从顶栏扫过时弹出面板是最烦人的错法，这个延迟就是拦它的（探针：60ms 内进出**不许**弹） |
| 悬停离开 | **200ms 后收起** —— 容得下"从胶囊移进面板"这一移（指针必然跨过间隙） |
| 点击 / Enter | **钉住**（`data-pinned="1"`）：指针移开也**不收**（hover 是快捷方式、点击是"点开细看"，两者不互相顶掉） |
| 收起通道 | Esc / **点面板与胶囊之外** / 条目清空 / ttl 到期（钉住不能退化成"只能按 Esc"） |
| 锚点 | 面板**水平中心对齐胶囊中心**（越界夹进视口）—— 原来是左缘对齐 ⇒ 胶囊越靠右面板越偏 |
| 胶囊自身 | 仍然**不许位移/缩放**（`design-status-island.md` §9 反模式不变） |

**空闲轮播（R12a 期望③，2026-09-15 R12b 上线；⚠️ R19 起暂时下线，devlog/096）**：
**当前空闲文案恒为「数据服务运行中」，不轮播** —— 用户口径「顶栏状态栏空置的时候轮播的语录集
暂时下线，等之后库中真有了条目再上线」（那些内置语录是占位文案，与库中内容无关）。
下线**不是删掉**：池子照建、`registerIdleProvider` 扩展点留着，将来接弹幕热词/名场面时
把 `IDLE_CAROUSEL_ENABLED` 翻成 `true` 即可（**同时要改探针那组"必须轮播"的断言**）。

| 名称 | 属性 / 类名 | 说明 |
|---|---|---|
| 轮播位置 | `.si-island[data-idle-index]` | 当前第几格（空闲态才有；下线时恒为 0）；`data-idle-size` = 池长 |
| 轮播内容 | `.si-island[data-idle-pool]` | 池子全文，`\|` 分隔 —— 探针据此断言"池子还在、第 0 格是状态文案、池内无进度词" |
| 轮播开关 | `.si-island[data-idle-carousel]`（`on` / `off`） | **开关状态的单一事实来源**：探针断言它与 `IDLE_CAROUSEL_ENABLED` 一致，改一处不改另一处会红 |
| 扩展点 | `idleQuotes.registerIdleProvider(fn)` | 返回注销函数；接真实条目时不用改顶栏组件 |

> 为什么时钟是**组件自己的定时器**（只在空闲且轮播开着时开）：挂在 `TopBar` 的抓取轮询上，
> 轮播的可见性会随之漂移 —— 谁把 `POLL_IDLE_MS` 从 10s 调大，轮播就静默变慢甚至停住。
> 下线后连这个定时器都不开（文案恒定，每 6s 重渲染纯属白干）。

**动效（R12a 期望②「优雅流畅」，2026-09-15 R12b；2026-09-24 **R38 批 1 令牌化**）**：
面板入场 `si-panel-in`（**`--motion-base` 220ms + `--ease-standard`**，`translateY(-6px) scale(.985)` → 原位，
`transform-origin: top`）· chevron 翻转 `transition **var(--motion-base)**` ·
计数徽章 `si-pop-in`（**`--motion-fast` 140ms**；React 侧 `key={notices.length}`，计数变化时重放）· 文案沿用
`.pill-text-fade` 淡入（**`--motion-fast`**）。`prefers-reduced-motion: reduce` 下**保留淡入、去掉位移/缩放/过渡**
（`si-panel-in-fade`，**`--motion-fast`**）——完全不淡反而像闪帧；**但 chevron 的翻转保留（瞬时、无过渡）**：
状态指示不该被"减少动效"减掉。探针按 `matchMedia` 判分支，两条支路都断言
（`--force-prefers-reduced-motion` 可验 reduce 支）。

> **R38 批 1 的判据**（`--status-island`）：元素上量到的时长必须**等于令牌的解析值**，而不是某个
> 硬编码数 —— 写回硬编码会红（**反向验证过**：把面板写死 `0.3s` ⇒ 报"应等于 `--motion-base`（220ms）"）。
> 本批的值变化：徽章 180 → **140ms** · 文案淡入 300 → **140ms** · chevron 200 → **220ms** ·
> 面板曲线 `cubic-bezier(.22,.61,.36,1)` → **`--ease-standard`**（前者是全站唯一的异类曲线，
> 规格 §2 曾误以为"已在用标准曲线"）。**这不是"零行为变化"** —— 见 devlog/167。

**宽度形变 + 文案滞后（R38 批 2，2026-09-24）**：胶囊（`.topbar-status`）的宽度用
**`calc-size(auto, size)`** 表达 —— 它把"内容宽"变成**可过渡的长度**，于是文案变化 / 计数徽章
出现时宽度**平滑过渡**（`--motion-base` + `--ease-standard`）而不是硬跳。文案淡入滞后
**`--motion-lag`（60ms）**（§3 规则 1「形变先行、内容后到」，`backwards` 填充防闪）。

> ⚠️ **两条口径**：
> ① **高度不参与过渡** —— 规格 §5 写着"折叠高 24 → 展开高 30"，但 §4 明说形变时"**高度固定**"、
>    §10 要求"中间态**高度恒定**"。两处冲突，**用户 2026-09-24 拍板取 §4/§10**：本批只做宽度，
>    高度恒为 `--pill-h-sm`（25px）。
> ② `calc-size()` **不支持时该行被忽略**，退回 `width: auto`（= 批 2 之前的行为）⇒ 无需 `@supports`。

> **R38 批 2 的三条不变量**（规格 §10 里原标「⛔ 待 R38 批 2」，现全部 ✅）：
> ① **顶栏高度三态恒定** —— 并**判成因**：胶囊必须 `position: absolute`（`.topbar` 是固定高度，
>    只有脱离文档流才不会撑高它）；
> ② **胶囊不裁切** —— `.si-text` 的 `scrollWidth ≤ clientWidth + 1`；
> ③ **中间态合法** —— 圆角 **≥ 高度/2**（`999px` 会被 clamp 到半高 ⇒ 任意帧都是胶囊）。
>    ⚠️ **不是采样中间帧**：虚拟时间下过渡不推进（`DEV-LOOP.md` 记过），采不到中间帧；
>    这条**结构级**判据等价且更可靠。
> **反向验证过**（同时破三条 ⇒ 三条全红）：`position: static` / `max-width: 60px` / `border-radius: 4px`。

**面板几何（R38 批 3，2026-09-24）**：`.si-panel` 圆角 **10 → 14px**（对齐规格 §5）。
**同心圆角**（§5：内层元素圆角 = 面板圆角 − 内边距）本批**无对象** —— 面板子元素全是通栏行
（`.si-panel-head` / `.si-panel-scroll` / `.si-item`），唯一带圆角的是 `.si-item-action`（999px 药丸，
不是同心圆候选）。**但规则有判据了**：探针会遍历面板内所有圆角 ∈ (0, 100)px 的元素，
断言 `圆角 == 面板圆角 − 到内缘距离` ⇒ 将来谁加了个圆角卡片、圆角不对就会红
（**反向验证过**：面板 10px + head 4px ⇒ 两条同时报）。

> ⚠️ **批 3 的另两项没有对象**（devlog/170 §一）：
> ① **面板锚定** —— **R39-C 已做**（2026-09-19；规格写于 09-17 ⇒ 规格的批 3 已过时）；
> ② **两段式跨级** —— **无触发条件**：`hoverIn` 有 `if (!lit) return`（空闲态打不开面板），
>    而 §6 的跨级指 ①→④ ⇒ 不可达。**②→④ / ③→④ 都是相邻级**，一次形变即可。

**文案切换：可打断 / 可重定向（R38 批 4，2026-09-24）**：`.si-text` **不再挂 `key={text}`** ——
原来文案一变就**重挂载** ⇒ CSS `@keyframes` **从头重放**（连续换字时每次都会闪）。
现在元素**保持挂载**、用 **transition** 驱动 ⇒ 从**当前值**继续（**transition 可重定向，
keyframes 只会重启**）。

时序（两相就够，**不需要单独的 `in` 相** —— CSS 过渡取**变化后**那一边的 `transition-duration`）：

| 阶段 | 类 | 视觉 | 时长 |
|---|---|---|---|
| `idle` | 无 | 可见 | 进这一相（= 淡入）用 `--motion-fast` + `--motion-lag`（§3 规则 1「形变先行、内容后到」）|
| `out` | `.is-out` | `opacity:0` + `translateX(-7px) scale(.96)`（§4「位移 6–8px 朝锚点 + 缩放 0.96 + 淡出」；锚点是左侧 `si-dot`） | 进这一相（= 撤）用 `--motion-instant`（§3 规则 2「离场比入场快 80–100ms」）|

**决策在纯函数里**：`utils/statusIslandText.ts`（`reduceText` + 9 条 vitest）—— 抽它的理由与
`sceneStep.ts` 同（vitest 跑 node 环境、hook 测不了），而"**连续换字不重放、不排队**"必须有单测。
核心性质：**`out` 途中再来新文案 ⇒ 继续撤（不重排、不重启定时器）**，撤完换上的是**当时最新**那一版。

> ⚠️ **hook 侧有个反直觉点**：那条 effect **故意不返回 cleanup** —— 定时器属于"撤"这个**阶段**，
> 不属于某一次 `text` 变化。返回 cleanup 会让"打断"把定时器清掉 ⇒ **文案永远换不过去**。
> 卸载时由**另一条** effect 清。

**批 4 的判据**（`--status-island`）：① `animation-name` 必须是 `none`（还挂 keyframes 就红）；
② `transition-duration` == `--motion-fast`；③ `transition-property` 含 `opacity`。
**反向验证过**（写回 `pill-fade-in 0.5s` ⇒ 两条同时报）。

### A1-a-w. 桌面控件宿主 `density="widget"`（R38 批 5，2026-09-24）

`<StatusIsland density="bar" | "widget">`（规格 §7/§8）。**宿主无关是硬要求** ——
状态机与动画都不得依赖顶栏；`place()` 读的一直是 `anchorRef` 自己的 rect，
**面板锚定相对胶囊自身**，所以换宿主只是换一层材质与尺寸。

| | `bar`（顶栏内联） | `widget`（桌面控件） |
|---|---|---|
| 定位 | `absolute` + `translateX(-50%)` 居中 | **`relative`**（它自己就是窗口，§8） |
| 折叠 | 高 `--pill-h-sm`(25) / 内容自适应 | **200 × 40** |
| 面板宽 | 340 | **280** |
| 底 | 透明 → `.on` 变粉 | **`rgba(18,18,22,.72)` + `backdrop-filter: blur(20px) saturate(1.4)`** + 1px 高光内边 |
| 事件态 | **整块变粉** | 深底**不变** + 一圈粉环（整块变粉会毁掉深色材质）|

> **深底的不透明度是算出来的**：要浮在**任意壁纸**上，而 `backdrop-filter` 后面的东西不可知 ⇒
> 只能按 α 复算**最亮（纯白）与最暗（纯黑）**两个极端壁纸的有效底色。α = 0.72 时白字实测
> **7.51:1** 与 **19.41:1**，两端都过（中间壁纸必然落在区间内 —— 混色是线性的）。
> **改这个值要重算，不能凭手感调。**

**判据**（`ui_probe --status-widget`，`?density=widget` 让顶栏里也渲染这套材质以便同页测量）：
density / 折叠尺寸 `[200,40]` / 面板宽 280 / `backdrop-filter` 含 `blur(20px) saturate(1.4)` /
`box-shadow` 含 `inset` / **不是 `absolute`** / **两极端壁纸对比度 ≥ 4.5:1**（脚本侧按 α 复算）。
**反向验证过**（α 调到 0.3 + 去掉尺寸与模糊 ⇒ 四条同时报）。

> ⚠️ 量面板宽要用**布局宽**（`getComputedStyle().width`）**不是 rect** ——
> 入场动画的 `scale(.985)` 在虚拟时间下被冻在起始帧，rect 会量到 280 × 0.985 ≈ **276** 的假值
> （首次实现就踩了，见 devlog/172 §三）。

### A1-a-w2. 桌面控件**小窗**（R38 批 5b，2026-09-24；**批 5c 起独立入口**）

**独立 HTML 入口**：`widget.html` → `src/widgetMain.tsx`（Vite 多入口，
`frontend/vite.config.ts` 的 `build.rollupOptions.input`）。
窗口由 Rust `show_widget_window` 建：**200×40 · 无边框 · 透明 · 置顶 · 不进任务栏 · 不可缩放**。

> ⚠️ **批 5b 曾走 `index.html?widget=1` + `main.tsx` 运行时分流**（功能正确，devlog/180 之前都是这样）。
> 批 5c 换成独立入口，原因是**成本**：小窗是常驻的，而运行时分流让它加载**整站**的
> JS/CSS —— 实测渲染进程 124MB / JS 1214KB / CSS 153KB，只为画一个 200×40 的胶囊。
> 拆完：**85MB / 188KB / 6KB**（85MB 是 WebView2 的地板价）。
> **判据不是"能跑"，是"这钱按一整天挂着算"**（devlog/181）。

**两个入口的样式边界**（拆入口时最容易错的地方）：

| 入口 | import 的样式 |
|---|---|
| `index.html` → `main.tsx` → `App.tsx` | `index.css`（含 **Tailwind preflight**）· `tokens.css` · `styles/status-island.css` |
| `widget.html` → `widgetMain.tsx` | **只** `tokens.css` · `styles/status-island.css` |

> ⚠️ **小窗不加载 `index.css` ⇒ 拿不到 Tailwind preflight 的 `box-sizing: border-box`。**
> 曾因此量到胶囊 **224px** 而非 200px。所以 `styles/status-island.css` **必须自包含**：
> 文件顶部显式写了 `.si-island` / `.si-panel` / `.widget-shell` 及其后代的 border-box reset。
> **改这个文件时别把那几行当成冗余删掉。**

**它不轮询** —— 六个信息源全在主窗口的 `TopBar` 里，小窗再来一份就是**双倍请求**。
所以小窗是**纯显示**的：

| 方向 | 事件 | 干什么 |
|---|---|---|
| 主窗口 → 小窗 | `widget:notices` | 每次条目汇总结果变了就推一次（没开小窗时是空广播，代价可忽略） |
| 小窗 → 主窗口 | `widget:action` | 面板里的动作（"去登录"/"查看详情"）只有主窗口做得了，**转回去** |

> **这就是没有按规格 §8 抽 `useStatusIsland()` 的原因**：抽了只是把轮询搬个家，
> 两扇窗仍然各轮各的；**推事件才是真的只轮一次**。

> ⚠️ **dev 自检仪器不继承**：`main.tsx` 那套 `window.onerror` / `unhandledrejection` /
> React 错误边界 / `invoke('widget_diag')`（devlog/178 为查小窗渲染异常装的）
> **在独立入口里全部要重挂一遍**，探针挂载（`import.meta.env.DEV && has('probe')`）同理。
> 独立入口不会继承另一份的任何东西 —— 拆完后"仪器没了"是静默的。

**拖动不能用 `data-tauri-drag-region`** —— 它在 **mousedown** 就调 `startDragging()`，
于是"点一下打开面板"永远收不到点击（整个控件 200×40 全是可交互面，没有"空白把手"可用；
主窗口那边是拿 `.topbar-spacer` 那块空地做的）。改成**指针位移过 4px 才拖**：没动是点击，动了才是拖窗口。

**位置持久化**：`utils/widgetWindow.ts`（localStorage，规格 §7「`shellState` 同款做法」）。
**夹取是必需的，不是锦上添花** —— 控件置顶 + 无边框 + 不进任务栏，整个跑出屏幕就**再也点不到**
（连"从任务栏找回来"都没有）。**16 条单测**覆盖：坏数据 / 四方向越界 / **换到更小显示器**。

> ⚠️ **Rust 侧有个必须的配套改动**：`on_window_event` 里拦 `CloseRequested` 的那段原来**不分窗口**
> —— 加了第二扇窗之后，小窗的 `close()` 会被拦下并变成"顺手把**主窗口**藏进托盘"。
> 已加 `window.label() == "main"` 判断。**这条在只有一个窗口时是多余的，加了第二个就是必需的。**

> ⚠️ **`show_widget_window` 等命令必须是 `async fn`**（devlog/180）：Tauri v2 里
> **同步命令跑在主线程**，而 `WebviewWindowBuilder::build()` 建第二个 WebView2 要跟主线程
> 消息泵交互 ⇒ **主线程卡死**（表现为主窗口关不掉、托盘退不掉、小窗只有个空框）。
> 另外 `React.StrictMode` 会**双调 effect** ⇒ 建出两个窗口，已用模块级标志 + Rust 侧
> `CREATING_WIDGET` 重入闸兜住。

**判据**（`ui_probe --status-widget` 第二段，`?probe=status-widget-window`）：
`.widget-shell` 在 / 胶囊 `data-density="widget"` / 200×40 / **胶囊顶边贴窗口顶边**
（横向仍居中）/ **顶栏与侧栏都不在**（独立入口生效）/ **面板在小窗里画得出来、在视口内、点得着**。

> 批 5c 起这一段走的是 `widget.html` 本身（独立入口），不再带 `?widget=1`。

> ⚠️ **批 5d 修了一个真 bug：小窗里的面板从来没显示出来过**（devlog/183）。
> 面板 `top = 胶囊底(40) + 6 = 46`，而窗口写死 200×40 ⇒ **整体落在窗口外**，宽 280 也超出 200。
> 它活了很久没被发现，是因为旧探针一直在**主窗口的大视口**里量这套样式 ——
> **判据的坐标系错了**（见 `DEV-LOOP.md` §6.5）。

#### 小窗的**形态梯度**（R38 批 5d）

窗口会**跟着面板长大**，所以有三件事必须一起对（少一件就是"面板又不见了"）：

| 件 | 在哪 | 干什么 |
|---|---|---|
| 几何 | `utils/widgetWindow.ts` 的 `widgetExpandGeom` / `widgetCollapseGeom` | 纯函数（**29 条单测**）。算展开后的窗口矩形：`w=280`、`h=40+6+面板高` |
| 通路 | Rust `resize_widget_window` → `shellBridge.resizeWidgetWindow` | `set_size` + `set_position` **一起**下发（只改尺寸会以左上角为锚向外长 ⇒ 胶囊横向跳） |
| 方向 | `.widget-shell[data-flip='up']` + `StatusIsland.place()` | 面板放下方还是上方，**两处必须一致** |

> ⚠️ **必须向上翻**：小窗默认落**右下角**（1080p 上 `y=968`），向下展开需要
> `968 + 40 + 6 + 面板高 ≥ 1214` ⇒ **任何面板高度都放不下**。所以贴屏幕下沿时
> 面板长在胶囊**上方**（`flipUp`），窗口**向上长**、底边对齐。
>
> ⚠️ **收起必须回到"展开前记下的位置"**，不能从展开矩形反推：贴边展开时窗口**必须被夹**
> （200→280 要收回来），"展开矩形的中心"已经不是原来那个中心了 ⇒ 反推会漂，
> **每次悬停漂几十像素**，久了小窗就爬走了（有 10 轮循环的单测守这条）。

> ⚠️ **面板高度上限不能用 `60vh`**：小窗高度**跟着面板长** ⇒ `vh` 与面板高度**互为因果**
> （40px 窗口 ⇒ `60vh=24px` ⇒ 面板被压成一条 ⇒ 窗口只长到 70px ⇒ 仍然很小 ⇒ 死锁）。
> 改由 JS 按**屏幕高度**算好写进 `--widget-panel-max-h`。
> **这条探针验不出来**（探针视口 621px，`60vh` 夹不住 137px 的面板）⇒ 只能真机确认。

#### 小窗宿主的两项窗口级开关（R38 批 5d，规格见 `settings.py` 的 `PREFS`）

| 偏好键 | 做什么 | 实现 |
|---|---|---|
| `widget_click_through` | 鼠标事件**穿过**小窗（小窗变纯显示牌） | Rust `set_widget_click_through` → `set_ignore_cursor_events` |
| `widget_hide_fullscreen` | 检测到**别人的**全屏时自动隐藏，退出后恢复 | Rust `is_fullscreen_app_running`（`SHQueryUserNotificationState`）+ `set_widget_visible` |

> ⚠️ **穿透走自定义命令而不是前端 `setIgnoreCursorEvents()`**：
> `core:window:allow-set-ignore-cursor-events` **不在 `core:window:default` 里**，
> 而 **Tauri v2 的自定义命令不走 ACL** ⇒ 少一个会漂的配置点。
>
> ⚠️ **全屏判据不能问"我自己是不是全屏"**：小窗永远 200×40，`is_fullscreen()` **恒 false**。
> 要躲的是**别人的**全屏 ⇒ 用系统通知状态（`QUNS_RUNNING_D3D_FULL_SCREEN` /
> `PRESENTATION_MODE` / `BUSY`）。取不到状态时**返回"没有全屏"**（宁可偶尔多露，
> 也不要因为探测失败让小窗**永不出现**）。
>
> ⚠️ **全屏隐藏只 `show`/`hide`，不销毁**：销毁了要重建（几十毫秒 + 位置得重推），
> 而"全屏结束立刻回来"是它的全部意义。与 `hide_widget_window`（**关掉**小窗，用户主动的）
> 是两条不同的路。

> ⚠️ 三条**别改坏**的口径：
> ① **「自动节拍不占顶栏」现在是 `notificationHub.progressNotice` 的具名规则 + 反向用例**
>    （此前是 `TopBar` 里散落的 `isQuietTask` 判断；探针 `_assert_topbar` 照旧在真实后端上兜底）；
> ② 面板必须 **portal + `position: fixed`**（顶栏容器 `overflow:hidden` 会裁掉内联面板），
>    探针断言"展开**不挤动右栏**"（`.topbar-spacer` 宽度不变）；
> ③ 能力受限**仍由顶栏那个独立入口**（`.topbar-limits`）承担 —— **工具 vs 通知**的分工：
>    前者是"随时可点的入口"，后者是"有事发生才出现的信息"；`NoticeActionKind` 里保留
>    `open-limits` 是给后续批次合并用的。

### A1-b. 未登录能力入口 `<CapabilityLimits>`（components/CapabilityLimits.tsx，2026-09-15 devlog/086）

顶栏登录钮**左侧**；**只在有限制时渲染**（全可用时不多一个按钮）。DOM 契约（探针直接查）：

| 名称 | 类名 / 属性 | 说明 |
|---|---|---|
| 入口 | `.topbar-limits`（`data-capability-limits="N"`） | 文案 `未登录 · N 项受限`（`utils/capabilities.ts::limitsSummary`）；没有限制时组件返回 `null` |
| 说明窗 | `.cap-limits-dialog` | 复用 radix Dialog（不引入新原语，将来"通知/灵动岛"控件可直接吸收） |
| 能用项 / 受限项 | `.cap-limits-ok` / `.cap-limits-item[data-limit-id]` | **先列"现在能做什么"再列受限项**——只列不能做的等于劝退 |
| 去登录 | `.cap-login-cta` | 复用顶栏已有 LoginDialog；关窗即 `refreshCapabilities()`（刚登录完不该还显示受限） |
| 行内标注 | `.cap-need-login`（胶囊）/ `.cap-inline-hint`（块）/ `.av-limit-row` | 批量浮窗与添加 V 浮窗的"需要登录"标注 |

**口径（不许违反）**：受限功能**照常可见**，只标注不隐藏；内容类动作（投稿/动态）在未登录时
**禁用 + 说明原因**；账号信息与归档**保持可用**（实测匿名可用，禁掉就是过度限制）。
探针：`python scripts/ui_probe.py --capabilities`（现场 = 数据目录副本删 `.env`）。

### A2. 工具图标栏 `<IconRail>`（components/IconRail.tsx）> 视觉按 `docs/design/react-IconRail` 导出（Frame4172），**50px 紧凑栏**（原 79 栏 ×0.63 取整）。

| 名称 | 类名 | 说明 |
|---|---|---|
| 图标栏 | `.icon-rail` | 宽 `--rail-width:50px`，底色 `--c-rail:#4b5a6f` |
| 顶部组 | `.icon-rail-group`（首）÷ spacer | 功能入口 |
| 底部组 | `.icon-rail-bottom`（`margin-top:auto`） | 贴栏底；**2026-09-15（R14a）起放齿轮** |
| 单元格 | `.icon-rail-btn` | **通栏 50×50** 贴合；未选中整钮 `opacity:.6`，hover `.85` |
| 选中单元格 | `.icon-rail-btn.active` | **实底 `--c-rail-active-bg:#647489` + 全亮** |
| 图标 | 顶部组：`FileText`(14×18)；底部：`Settings`(18×18) | 视觉尺寸对应设计稿 ×0.63 取整 |

接线语义：**两枚都已接线** —— 「帖子」`FileText` → `navigate('/')`（路由高亮：`/` 或 `/vtubers/:id`）；
底部「设置」`Settings` → 打开 `AppSettingsDialog`（`data-testid="app-settings-gear"`）。
**2026-09-08 用户：未接线的占位图标（用户 / 日历 / 刷新）已删除**——避免点了没反应的假入口，
功能落地时再加回；**2026-09-15（R14a，devlog/091）齿轮按这条口径加回**（设置界面真的能用 HTTP PUT 落库了）。

### A2-a. 应用设置弹窗 `<AppSettingsDialog>`（components/AppSettingsDialog.tsx，2026-09-15 R14a/R14b；**R17 改左右两栏** devlog/094；**R21 精简信息架构** devlog/100；**R21 批 2 排版与控件** devlog/101）

齿轮打开的独立弹窗（Radix Dialog）。**与「档案设置」是两回事**：那个是单个 V 的资料
（`.vd-*`），这个是应用级参数（`.aps-*`）。

```
┌ 设置 ─────────────────────────────────────────────── ✕ ┐   ← 头部驻留（标题 + 说明）
│ ┌ nav 168 ─┐┌ pane（flex:1）─────────────────────────┐ │
│ │▍外观   2 ││ 抓取设置  下一轮生效      [恢复本类默认] │ │   ← 分类头（驻留）
│ │ 抓取设置11││ ── 风控与节流 ────────────────            │ │   ← 页内小组（只来自后端）
│ │ 数据源 3 ││ 每个账号的间隔（最小）        [  3 ] 秒   │ │
│ │ 关于  10 ││ ── 开播信息抓取 ──────────────            │ │
│ └──────────┘│ …                                    │ │
│             │ ▾ 高级设置（9 项）微调节奏用，一般不用改   │ │   ← 默认收起
│ 全部为默认值                    [恢复全部默认] [保存]     │   ← 底部操作条（整窗）
└──────────────────────────────────────────────────────────┘
```

| 名称 | 类名 / 属性 | 说明 |
|---|---|---|
| 弹窗 | `.aps-settings`（`data-testid="app-settings-dialog"`） | **760 × min(600, 100vh−72)**；`max-width: calc(100vw−48px)`；`padding: 0`（两栏自己撑满），头/脚驻留 —— 与 `.lc-dlg` 同构 |
| 左栏 | `.aps-nav`（`data-testid="aps-nav"`，`role="tablist"` `aria-orientation="vertical"`） | 宽 **168**，底色 `--c-bg-list` + 右缘发丝线；↑↓/Home/End 移动（自动激活），roving `tabIndex` |
| 导航项 | `.aps-nav-item`（`data-nav="<外观\|分组名\|关于>"`、`data-nav-active`、`data-nav-dirty`） | 高 34、图标 15px、右侧计数；**选中态 = 左缘 3px 主色竖条 + 浅粉底**（`.vtuber-item.active` 那套语言）；`data-nav-dirty="1"` 时挂 `.aps-nav-dot`（该分类有未保存改动） |
| 右栏 | `.aps-pane`（`data-testid="aps-pane"`、`data-pane`，`role="tabpanel"`） | **只渲染当前分类**（分页，不是隐藏）；分类头 `.aps-pane-head` 带生效时机 + 「恢复本类默认」（`.aps-reset-one`，只填草稿不落库） |
| 外观页 | `.aps-theme-cards` / `.aps-theme-card[data-theme-option][data-theme-disabled]` | 三张卡片：**浅色 / 深色 / 跟随系统**。深色卡片 `disabled` + `.aps-theme-note`（"尚未实现"）—— **只标不藏**；系统是深色时下方 `.aps-range[data-theme-caveat]` 说明 |
| 字段行 | `.aps-row[data-setting="KEY"]` + `.aps-input` / `.aps-switch` / `.aps-badge` / `.aps-field-error` | **R14a 的控件一个都没改**，R17 只换外壳；跨字段冲突（上限<下限）报在"上限"那一行（`[data-pair="1"]`）；**R20**："说明一行 + 控件整行"的字段（关闭语义的胶囊单选等）改用 `.aps-row-stack`（`grid-template-columns:1fr`，控件另起一行），否则控件会被控件列压成竖排单字；`.aps-radio` 加 `white-space:nowrap` 防选项文字折行。**R21 批 2 的排版层级**（"文字排版更醒目一点"落成数字）：字段名 **14px / 600**、说明 **12px / 行高 1.5**、行内距 **9px**（原 5px）、控件列 132 → **150px**、范围与错误提示 11px；`--range` 行跨整行（`grid-column: 1/-1`） |
| 数字步进条 | `.aps-step` + `.aps-step-btn[data-step="-1\|1"]` + 内层 `.aps-input` | **R21 批 2（参考图二）**：数字框不再是裸输入框，而是**整行条**——左「减」/ 中数值 / 右「加」，高 **30**、圆角 8、外壳带 `:focus-within` 主色边。**中间仍是真 `<input>`**（键盘可直接敲；原生数字箭头已 `-webkit-appearance:none` 藏掉，避免两套箭头打架），内层输入框 `border:0` 且数值居中加粗 13.5px。步进粒度与边界判据全在 `utils/settingsDraft.ts`（`stepOf` / `atBound` / `bump`，5 条单测）：整数步 1、小数按跨度 0.5 或 1，到界箭头 `disabled`，点击是夹在 `[min,max]` 内的值 |
| 开关 | `.aps-switch`（`data-value` / `role="switch"`）> `i`（滑块）+ 状态文字 | **R21 批 2 用户口径**："稍大一点的药丸内嵌滑块，但是**不要外框背景**，同时添加一点浮片视觉" ⇒ 去掉原来那层"描边 + 灰底的胶囊壳"（`padding` / `border` 全 0），滑块本体 22×12 → **32×18**（圆点 14，行程 14px），底色 `--c-bg-card` + `inset` 发丝线 + **`--pill-shadow`**（与 `.float-pill` 同族的浮片质感），`.on` 时底色换主色；状态文字「开 / 关」留在滑块右侧 |
| 页内小组 | `.aps-section[data-aps-section="<小组名>"]` + `.aps-section-head` | **R21**：字段按**用途**分小组（风控与节流 / 开播信息抓取 / 定期动态轮询 / 每日定时任务 / 收录首屏），顺序 = 后端声明序。**只有一组时不渲染标题**（页标题已经说明白了）。分组与折叠的内容**全部来自后端** `specs[].section` / `.advanced`，界面不写死 —— 见 §A2-a 口径 ⑤ |
| 高级折叠 | `.aps-fold[data-aps-advanced="closed\|open"]` + `.aps-fold-head`（`data-testid="aps-advanced-toggle"`）+ `.aps-fold-body` | **R21**：调优类字段收进页尾「高级设置（N 项）」，**默认收起 = 不渲染**（不是渲染后隐藏 —— 收起时 DOM 里一行都没有，探针据此判）；展开后与正文用**同一套** `renderRow`；**换页自动收回**（每页各自的默认态） |
| 关于页 | `.aps-info` + `.aps-readonly-item` + **`.aps-storage`（R22-B）** + **`.aps-update`（R23b）** | 只读信息（版本/数据目录/库/端口/迁移 head/日志/PID）+ 10 条只读项**逐条带理由**（`.aps-readonly-why`）；**存储占用面板**：数据库 / 图片缓存（带上限）/ 日志 / 合计 / 磁盘剩余（`data-storage="…"`、偏低时挂 `.aps-storage-warn`「空间偏紧」）+ 手工备份提示 + 两个浮片动作「清理图片缓存」「整理数据库」（`.aps-storage-actions`）+ 迁移入口（`data-testid="aps-migrate"`，仅桌面端且非便携）+ 数据目录来源（`data-dir-source`）；**应用更新面板**（`data-testid="aps-update"`）：当前版本 · 检查更新（`aps-update-check`）/ 下载并重启安装（`aps-update-install`）/ 打开发布页 · 状态标记 `data-update="available\|latest\|error"` · 说明限高 160px（`.aps-update-notes`）· **浏览器环境只显示"更新只在桌面端可用"、不出按钮** |

**五条口径**：① 范围/单位/生效时机**全部来自后端** `GET /settings`；② 可热更与只读分开摆、
只读区逐条写理由；③ 写路径唯一 —— `PUT /settings`，前端只做提前提示；
④ **导航是数据驱动的**：中间几项由 `specs[].group` 生成（外观固定首、关于固定尾），
后端加一组参数界面自动多一项（`utils/settingsNav.ts` 有单测，探针拿导航标签与 API 分组对账）；
⑤ **分组与折叠也是数据驱动的**（R21）：页内小组取 `specs[].section`、折叠取 `specs[].advanced`，
前端只排版。**导航只有 4 项**（外观 / 抓取设置 / 数据源 / 关于）—— 用户 2026-09-16 口径
「可选项太多、设置很杂，没有专业背景的用户可能不知道每一项意味着什么」；「哪些算关键项」
由后端白名单钉住（`tests/test_runtime_settings.py::test_vital_settings_are_visible_and_tuning_knobs_are_advanced`），
**成对的上下限必须同组同折叠态**（拆开会让界面的"上限<下限"预校验消失）。

**状态语义**：草稿**跨分类保留**（切页不丢，左栏圆点提示）；外观**立即生效**、
抓取参数**下一轮生效**；底部「恢复全部默认」= 抓取参数 + 主题（前端打两个已有端点）。

**R30 新增的四项**（静默时段，devlog/130）落在既有小组**「定期动态轮询」**里，**没有新增小组**
（页内小组数仍为 5，探针对账不用改）：`QUIET_HOURS_ENABLED`（开关，默认**关**）·
`QUIET_HOURS_START` / `QUIET_HOURS_END`（本地整点，`END <= START` 按跨午夜算，两者相同 = 不生效）·
`QUIET_HOURS_DYNAMICS_MIN_SECONDS`（静默期动态间隔下限，收在「高级」）。
它们的说明文案里写清了两件事：**只降动态流**（开播刷新与直播日历不受影响）、
以及"默认关闭、由你自己开启"。

⚠️ 与 `.vd-settings` 同一个坑：**不要**给这两个类加 `position: relative`（会盖掉弹窗内容体的
`.fixed`，整块飘出视口）。探针：`python scripts/ui_probe.py --app-settings`（`--shot` 可出视觉存档）。

### A2-b. 主题与深色钩子（utils/theme.ts + hooks/useThemePref.ts，2026-09-15 R14b devlog/092）

| 层 | 位置 | 职责 |
|---|---|---|
| 解析（纯逻辑，10 单测） | `utils/theme.ts` | `resolveTheme(pref, systemDark)` · `applyTheme(root, resolved)` 写 `html[data-theme]` · `watchSystemTheme` 订阅 `prefers-color-scheme` · `themeCaveat` 生成"该说的那句实话" |
| 取数与副作用 | `hooks/useThemePref.ts` | 读/存 `prefs.theme`（乐观应用，落库失败退回）· 系统主题变化时重解析 |
| 令牌 | `styles/tokens.css` 末尾 `:root[data-theme='dark']` | **空块 = 显式标记"深色还没做"**；接上样式时只需填这个块 + `DARK_IMPLEMENTED = true` |

**当前的诚实边界（不许含糊）**：深色主题**尚未实现** —— `DARK_IMPLEMENTED = false`，
所以 `system` 在系统为深色时仍解析为浅色；界面在这时必须显示那句说明
（`themeCaveat`），否则用户会以为「跟随系统」坏了。这条由
`tests/test_runtime_settings.py` 的**跨语言契约**钉住：TS 里的布尔与 `/settings/prefs`
下发的 note 必须一致（改一边不改另一边就红）。

**为什么深色不在这批做**：三个 CSS 里硬编码色值 243 处（146 种）+ ECharts 主题 +
内联样式 —— 只把 `:root` 变深会做出"半黑不黑"的界面，比不做更糟。下一批的路径写在
`tokens.css` 那个空块上方（收敛令牌 → 填深色令牌 → 图表双主题 → 逐屏走查）。

### A3. VTuber 左栏 `<VtuberSidebar>`（components/VtuberSidebar.tsx）

视觉按 `docs/design/react-VtuberSidebar`（Frame41109）与口播定案。
**2026-09-07 滚动条迁移完成**：外壳改为 flex column（工具行吸顶 + OverlayScroll 列表滚动区），
旧自绘 `.sidebar-sb` 滚动条退役（见 F3）。

| 名称 | 类名 | 说明 |
|---|---|---|
| 外壳 | `.sidebar-shell` | 宽 `--sidebar-width:492px`，**flex column**；承载 `--c-bg-list` 底 + 右缘发丝边 |
| 工具行 | `.list-toolbar` | 吸顶行（高 51px，padding `10px 32px`，居中，`z-index:5`），**不随列表滚动** |
| 列表滚动区 | `<OverlayScroll className="sidebar-list">` | **覆盖式滚动条**（F 节标准）；滚动体 `.sidebar-list .os-scroll` flex column |
| 原生条隐藏 | — | `.sidebar`/`.sidebar-sb*` 规则已随迁移删除 |

**工具行**
| 名称 | 类名 | 说明 |
|---|---|---|
| 工具行 | `.list-toolbar` | 高 51px，padding `10px 32px`，`justify-content:center`，四件同容器居中 |
| 添加钮 | `.list-add-btn`（`Plus` 16px，**50×25** 浮片） | 打开 AddVtuberDialog |
| 筛选钮 | `.pfilter-btn`（`.float-pill--md` = 高 30，`min-width:68px`，内距 `0 8px`，字 13，`line-height:1`）+ 文案 `.pf-label` | **R16（2026-09-15，用户两次口径）：样式跟随侧栏 `.list-filter-btn`，但尺寸按本行** —— caret **绝对定位右上角**（`top/right:3px`，不占流）、字 13、内距 8、`line-height:1`；文案外套 `.pf-label`（左右各 11px **对称**留白）：文字因此是浮片几何中心（实测偏移 **0**），留白同时给 caret 让位（长文案下浮片自己长，caret 与文字恒留 ~9.4px）。<br>**高 30 / 宽 68 保持不变**（用户 2026-09-15 复述「宽高还是原本的宽高，保持同一行中元素的和谐」）：与本行搜索框（30px）齐平 —— 侧栏那枚是 89×25（它那行是 25 高），**配方一致、尺寸各行其是**。<br>历史：R15② 曾把 caret 改成"随内容居中"（`position:static` + 组居中）—— 那版文字仍偏 **−5.3px**，因为 caret 在流内必然挤占文字位置；R16 换成侧栏那套（caret 出流），**R15② 的诉求（文字居中）由它更好地满足**。探针：`--filter-pill`（STYLE 字段逐项对账 + SIZE 字段只列出不判失败 + 三态文字居中/caret 间距）+ `--polish`（文字中心偏移 ≤1px、caret 必须 `absolute`） |
| 搜索框 | `.list-search-wrap` 内 `.list-search` | **240×25 浮片**，放大镜 10×10 居左、placeholder 12px；`/` 键聚焦；focus 粉内描边 |

| 直播过滤 | shadcn `SelectTrigger.input list-filter-btn [&>svg]:size-2.5` | **89×25 浮片**；选项 全部/直播中/未直播（在线实时过滤） |
| 拉取键 | `.list-pull-btn`（`Download` 16px，**44×25** 浮片） | 打开 BatchFetchDialog |

**列表体**
| 名称 | 类名 | 说明 |
|---|---|---|
| 条目 | `.vtuber-item(.active)` | **76px 通栏**（`flex-shrink:0`），gap 12，左 padding 26px；hover 浅粉 `--sel-bg-hover` |
| 选中条 | `.vtuber-item.active::before` | **左缘 3px 粉竖条 `--sel-bar` + 浅粉底 `--sel-bg`** |
| 头像 | shadcn Avatar `size-[58px]` | 圆形，`resolveAsset(avatar_path) ?? avatar_url` |
| 名字 | `.vtuber-name` | **18px 纯黑 500**，`user-select:none` |
| 直播点/标签 | `.live-badge` / `.live-dot` / `.live-label` | 紧凑直播徽标（16px 高、6px 点 + 10px 字、红 `--c-live`），仅直播中 |
| 签名 | `.vtuber-sign` | **13px 灰（13px 行高盒）**，`user-select:none` |
| 企划槽 | `.vtuber-emblem` | 右侧 **54px 全高**，紧贴右缘；暂空置（后续接线档案卡「企划」值） |
| 提示态 | `.sidebar-tip` | 加载失败 / 空池 / 无匹配文案（在滚动区内渲染） |

---

## B. 右栏内容（routes 出口）

### B0. 空置页 `<EmptyState>`（pages/EmptyState.tsx）
| 名称 | 类名 | 说明 |
|---|---|---|
| 容器 | `.empty-state` | 全高居中（`.app-main` 已零padding） |
| 引导块 | `.empty-state-card` | 居中一行灰字（虚线卡已移除） |
| 大LOGO | `.empty-state-logo` | 圆形灰字占位 |
| 标题/描述 | `.empty-state-title/.desc` | 「未选择 VTuber」灰字提示 |

### B1. 帖子面板 `<PostsPage>`（pages/PostsPage.tsx，styles/posts.css）
路由 `/vtubers/:id`。**四视图状态机**：`view: 'cards'|'list'|'archive'|'profile'`（默认 `cards`），光条切换，数据共享不重取。视觉按 `docs/design/react-PostsPage`（Frame41301）。

**分层**：① 共用外壳（面板/背景层/工具条+光条）→ ② 四视图**并列**（下表总览）→ ③ 各视图子项（B1.1–B1.4）→ ④ 跨视图联动（B1.5）。

#### B1.0 四视图并列总览

| 视图 | `view` 键 | 光条钮（title） | 主滚动容器 | 子项（详见） |
|---|---|---|---|---|
| **展示页** cards（默认） | `cards` | `LayoutGrid`「展示页」 | `.hero-scroll`（OverlayScroll） | 背景层（自定义/头像铺底）· Hero（头像 · 直播徽标 · 名字 · 签名）· **平台药丸行**（数值/主页跳转/长按重排/尾部「+」）· 饰条 · **档案设置窗口**入口 `.bg-tools` → **B1.1** |
| **帖子列表** list | `list` | `AlignJustify`「帖子列表」 | `.chips-bar`（固定顶）+ `.list-scroll`（OverlayScroll） | 操作按钮组 `.header-actions`（账号切换器 + 可收起抓取钮组）· 筛选行（类型 chips · 搜索浮片 · **筛选弹窗**）· 帖子流 `.post-grid`/`PostCard` · 回顶浮钮 · 无限滚动 → **B1.2** |
| **数据视图** archive | `archive` | `BarChart3`「数据视图（直播日历 / 粉丝趋势）」 | `.archive-view`（OverlayScroll） | 直播日历卡 `<LiveCalendar>`（月历 + 场次浮层 + 场次详情弹窗）· 粉丝趋势卡 `<FanTrendChart>`（ECharts 双轴 + Brush）→ **B1.3** |
| **档案视图** profile | `profile` | `Fingerprint`「档案视图（卡片画布）」 | `.board-view`（OverlayScroll） | **R37-P1 起 = 卡片画布**（12 列网格 + 卡片注册表 + 纪念日/优质投稿两张内置卡）→ **B1.4** |

> **命名（R37-P1，devlog/141）**：用户口径「把那个有直播日历和粉丝趋势的视图叫做**数据视图**」、
> 「（卡片画布）我们把它称作**档案视图**」⇒ 光条 title、注释、本文档与探针的视图枚举全部改定
> （探针按 title 前缀点钮，所以 `clickView('档案')` 同步改成 `clickView('数据视图')`）。

> 四视图**平级、互不嵌套**：切换只换 `view`，面板/背景层/滚动条标准（§F）与联动刷新（B1.5）为共用层。

#### B1.0.1 共用外壳

| 名称 | 类名 | 说明 |
|---|---|---|
| 面板 | `.posts-panel` | `height:100%`，flex column，`overflow:hidden`（裁剪模糊边界） |
| 背景层 | `.hero-backdrop(.custom)` | 常驻：**自定义背景优先**（`background_path` → `/static/custom_bg/...`，`.custom` 全图清晰 opacity 1 + **P8-1 起纱罩 alpha 减半**，见 `.hero-backdrop.custom::after`），否则头像铺底（0.18+原纱罩）；`key=src` 换装淡入 |
| 工具条 | `.view-toolbar` | **R45 起是 overlay**：`position:absolute; inset:0 0 auto 0; height:0; pointer-events:none` —— **不占布局**（这样"隐藏"才真的把空间还给内容），且整条**不吃指针**（若吃，顶 66px 内滚轮不滚列表、卡片顶部点不着）。显隐由 `data-shown` 驱动、键盘聚焦走 `:focus-within`（见下方「工具条显隐状态机」）。卡片页右上角挂 `.bg-tools`（档案设置浮片，`right:12px; top:14px` 与条同轴；**与工具条同一套显隐**；无清除钮） |

**视图切换条**（`.view-switch` / `.view-btn` / `.view-switch-thumb`）
| 名称 | 类名 | 说明 |
|---|---|---|
| 视图切换条 | `.view-switch` | **R45 = 不透明浮片**（用户 2026-09-24 拍板）：`border-radius: var(--pcard-radius)` · `background: var(--pill-bg)`（**不透明**）· `box-shadow: var(--pill-shadow)`（**形状承担者**）· **无 `backdrop-filter`**。定位 `top:6px; left:50%; translate:-50% 0`；宽**由内容决定**（`padding:3px 8px`，不再写死）；高 46。占 y=6..52，而 `.chips-bar` 的胶囊实体从 y=52 起 ⇒ **零视觉重叠**（1100 档亦然，由探针的不相交判据钉住）。<br>**演进史**：`linear-gradient(90deg,…)` → `radial-gradient(120% / 72% 100% …)` → **毛玻璃**（R39-D3）→ **不透明浮片**（R45）。<br>**为什么推翻毛玻璃**（三条）：① 白 .10 + blur 叠在**默认近白纱罩**上贡献**精确为 0** —— 这条 R39-D4 §一 第 3 条已经量到过（「白 0.10 的玻璃…叠上去等于没有」），但当时只修了柔光那一半、**这半没进遗留，掉了**；② 纯白填充在近白页（`#fffbfb`）上同样看不见 ⇒ 形状必须由**阴影**承担，而这正是浮片族的配方（`.float-pill::before`）；③ 旧判据「外阴影一律不要」写在"一团柔光"的语境里，形状明确成矩形后不再成立（见设计指南第 5 条）。 |
| 视图钮 | `.view-btn.on/.off` | 四枚、**同级视图**（2026-09-08 用户定序 + 删除未接线的邮件占位钮）：**卡片(`LayoutGrid`)→`cards`** / **列表(`AlignJustify`)→`list`** / **数据视图(`BarChart3`)→`archive`** / **档案视图(`Fingerprint`)→`profile`**（P7 追加；R37-P1 改定名）。**R45：50×50 → 34×34、图标 `size-6` → 18px** —— 同排其它控件全是 25–30px（账号切换器 30、分类胶囊 25–30、配置浮片 30），只有它 50 ⇒ 它撑出了 59px 的条与 66px 的带子，是"突兀"的尺寸来源；缩后 overlay 在 1100 档（面板仅 558）才不与账号切换器相交。**`on=1 / off=.7`**（R45：`.4` 叠在**纯白**上也只有 **1.89:1** —— 任何背景都到不了非文本对比 3:1 的下限；`.7` 对纯白条面 = **3.44:1**。`.4` 当初的理由"不抢注意力"现由**自动隐藏**承担）。**R45-A：`.on` 换 `color:#fff`**（深粉实底的配对，见上「选中块」）。⚠️ **`opacity` 与 `color` 都要过渡**（`.7↔1`、深↔白），否则滑动时硬切。⚠️ **必须 `position:relative + z-index:1`** —— 否则绝对定位的选中块会按绘制顺序盖住图标（R39-D4 实测） |
| 选中块 | `.view-switch-thumb` | **R39-D4**（用户 2026-09-23「换成粉底圆角块」）+ **R45 缩到 40×40** + **R45-A 换选中语言**（用户 2026-09-24 拍板方案 E：**深粉实底 + 白图标、去掉描边**）：`border-radius:12px` · `background: var(--sel-strong)`（`#ec407a`）· **`box-shadow: none`**（原来的 `inset 0 0 0 1px var(--c-primary-deep)` 已删）。位置/宽度由 `PostsPage` 在 `useLayoutEffect([view])` 里按**激活钮自己的 `offsetLeft/offsetWidth`** 写内联样式（不按 34+8 硬算 —— 以后改尺寸/间距自动跟上；边长从 CSS 变量 `--view-thumb-size` 读，单一真源）；过渡 `transform/width 220ms var(--ease-standard)`，reduced-motion 下 0.01ms；**`pointer-events:none` 是硬要求**（否则盖住按钮、吃掉点击）。<br>**R45-A 的四步全是被迫的，不是口味**（详见 `tokens.css` 的 `--sel-strong`）：① 去描边 ⇒ 形状只能由填充扛；② 浅粉扛不住 —— `--sel-bg` 对**自己这个白条面**只有 **1.10:1**（比它当年在近白页上的 1.07 还差）；③ 压深到能立形状的粉，**深图标就读不出了**（`#4b5a6b` on `#c9406f` = 1.50:1）⇒ 图标只能转白；④ 白图标 ≥3:1 ⇒ 填充亮度 ≤0.30 ⇒ 落在 `#ec407a`（**3.76:1**，余量 25%）。<br>⚠️ **用户原本想要的是顶栏粉 `#ffa2b4`**，那档白图标只有 **1.90:1**：实测（真动画台）块要滑满 **42px** 才能完全盖住新图标，而滑到它左缘只要 **5px** ⇒ 行程中段被瞄准的图标有 **42% 露在白条上**；在 `#ffa2b4` 上那 42% 是白压白 ⇒ 会"断成两截"。换成亮粉里能过线的最亮一档后，同样的暴露**仍然读得出**。<br>**这条边界是可算的，所以两种"粉 + 图标"组合互斥**：白图标 ≥3:1 ⇔ 填充相对亮度 **≤0.30**；顶栏粉是 **0.504**（高 68%）。要按顶栏粉的色相压到刚好过线得 `#c77e8c`（V=0.78）—— 那时"顶栏粉"已经灰掉了。**所以「亮粉 + 白图标」与「亮粉 + 深图标」不存在同时成立的一档**；想要那个粉就只能用深图标，想要白图标就得接受粉被压深。<br>探针判据：中心与激活钮 ≤1.5px · 宽 ≥ 按钮+6（**相对关系**）· `pointer-events:none` · 过渡含 transform · 底色 alpha=1 且非渐变 · **激活图标对填充 ≥3:1**（按渲染值算）· **不得有 `inset` 描边 / `border`**（R45-A 新加）· 不得盖住激活图标 |

**决定"内容从哪开始"的令牌**（R45 / R45-B / R45-D / R45-E / **R45-E2**，真源在 `tokens.css`）：

| 令牌 | 值 | 含义 |
|---|---|---|
| `--toolbar-top` | 6px | 工具条在面板内的上边距 |
| `--toolbar-h` | 46px | 工具条自身高度（= 选中块 40 + 上下各 3） |
| `--toolbar-band` | `calc(top + h)` = **52px** | 它**覆盖的那条带子** |
| `--toolbar-gap-cards` | **50px** | cards 的**主体内容离它多远** |
| `--toolbar-gap-list` | **50px** | list 的（同上） |
| `--toolbar-gap-archive` | **50px** | archive 的（同上） |
| `--toolbar-gap-profile` | **50px** | profile 的（同上） |

**⚠️ 让开量收归一处** —— `.view-body::before` 一条占位带，
`height: calc(var(--toolbar-band) + var(--toolbar-gap))`。**引用处只有这一个。**

**⚠️ R45-E2：间距是"四个量"**（用户 2026-09-24：「**四个视图不要共用一个间距
`--toolbar-gap`，分别设计四个量**」）：
四个量定义在 `:root`，由 `posts.css` 的 `.view-body[data-view=…]` **解析**成
`.view-body` 上的 `--toolbar-gap` ⇒ 消费方（`::before`、`.post-filter-pop` 的兜底）
**只认那一个名字，不需要知道有四个量**。
| 要改什么 | 改哪一行 |
|---|---|
| 某一档的间距 | `tokens.css` 里 `--toolbar-gap-<视图>` 那一行（**一个数**） |
| 加第五个视图 | `posts.css` 的映射里补一条 `[data-view=…]`（漏补 ⇒ 探针红） |
| 内容顶（面板内） | = `--toolbar-band`(52) + 该视图的间距 ⇒ **红框高度就是那个间距本身** |

> **为什么必须分开**：四个视图的"首块内容"不是一类东西 —— cards 是 hero 头像、
> list 是账号切换器行、archive 是牌堆卡片、profile 是画布首行卡片；其中 **cards 与
> profile 没有左侧标题占位**。所以"该不该同距、差多少"是**四个独立的版式决定**。
> R45-E 曾共用一个值，只是因为当时**只量到了 list 那一档**。
> ⚠️ **四个值当前相同（50）** ⇒ 解耦本身**不改变任何视觉**，只是把"一个共用数"
> 换成"四个可独立调的旋钮"。已反向验证：把 `--toolbar-gap-cards` 改成 20 ⇒
> **只有 cards** 的内容顶变 72，其余三档不动（改前是四档一起动）。
>
> **接线由探针逐视图对账**（`_assert_layout` ⑤b 的两条，R45-E2 新增）：
> ① `.view-body` 上**解析后**的 `toolbarGap` 必须等于 `:root` 上该视图的
> `--toolbar-gap-<view>`；② `::before` 的实高必须等于 `覆盖带 + 该视图的量`。
> ⚠️ **少了这两条，"映射写错"是查不出来的**：某个视图用了别人的间距时，
> "留白 ≥ 它自己那个值"这类判据**只会与错的那个值自洽**（已实测：故意把 archive
> 的映射指错 ⇒ 只有这两条红，留白判据是绿的）。

| 视图 | 让开由谁承担 | 页面标题 |
|---|---|---|
| cards | `.view-body::before` + `--toolbar-gap-cards` | 无（hero 本身就是主体） |
| list | 同上 + `--toolbar-gap-list` | **有**：「帖子列表」 |
| archive | 同上 + `--toolbar-gap-archive`，**另加 `.data-deck` 的上留白**（见下） | **有**：「数据卡片」 |
| profile | 同上 + `--toolbar-gap-profile` | 无（用户 2026-09-24：「这轮不做 profile」） |

> **⚠️ archive 的"红框"是两项之和**（R45-E3，用户实测问过：
> 「为啥 `--toolbar-gap-archive = 0` 了红框里还是有空隙」）：
> ```
> 面板内 y=52  工具条覆盖带下缘
>         ↓    --toolbar-gap-archive
>         y=52 .view-body::before 的底 = 数据视图内容起点
>         ↓    .data-deck 的上留白（--deck-shadow-room，8px）★ 红框里剩下的就是它
>         y=60 卡片（.deck-frame）上缘
> ```
> 为什么不能把那 8px 也归零：`.data-deck` 是 `overflow:hidden`、**裁在 padding 盒外缘**
> ⇒ 上留白要留给卡片上缘的 `--pill-shadow`（上溢 `6−2 = 4px`）。
> **命名成 `--deck-shadow-room` 并写清"红框 = 两项之和"** —— 两个职责不同的留白
> 叠在同一个 padding 上，必然制造"我改了 A 为什么 B 没动"的困惑。
> 判据只守**阴影不被切**那一端（`.data-deck` 上留白 ≥ 4px）；
> 红框本身**只实测打印、不设断言**（那是用户随手在调的视觉量）。
> 实测（三档一致）：卡片上缘 60 − 覆盖带 52 = **8px**。

> **⚠️ 页面标题不镜像卡片标题**（R45-E2 定）：标题是**写死的每视图标签**
> （list=「帖子列表」/ archive=「数据卡片」），而 archive 那张卡自己渲染「直播日历」——
> 两者是**两件事**。探针原先那条"两份真源必须相等"的对账判据**已退役**
> （"必须相等"的前提消失了；留着只会常年红着被无视）。
> 标题的定位与横向余量见 `posts.css` 的 `.page-title`（垂直居中用 `1.3em`
> 而不是写死行盒高 —— 改字号时那一行不用跟着改）。

> **四个 50 是怎么来的**（R45-D/E，用户 2026-09-24）：用户先给了两张参考图
> （R45-D，量出 **37px / 占面板高 7.0%** ⇒ 取 40px），随后**自己拼了一张合成图**把想要的
> 顶部版式摆出来给我对齐（R45-E）。后一张更具体、且是**按最终意图**拼的 ⇒ 以后者为准：
> 工具条下缘 y=50 → 账号行上缘 y=102 ⇒ **52px**，取 51；**用户随后手改成 50** ⇒
> 四个量以 50 起步（R45-E2）。
> ⚠️ **不按"条高的倍数"取**：参考图的条只有 30px 高、我们的是 46px（4 枚 34px 按钮），
> 套 1.23× 会得 57px、偏大 —— 留白的视觉作用是**绝对量**，不随条高变。
> ⚠️ 量参考图时**连写两版判据都错**（把工具条认成 8px / 12px，因为条内彩色图标打断了
> "近白段"），最后**放弃猜判据、直接把行摘要印出来人工判读**才看清。
> 教训：判据写不出来时先看原始数据，别继续加判据的复杂度。

**页面标题是「占位」，不是内容**（R45-B 建立 → **R45-E 定形**）：

用户口径（2026-09-24）：**「我的目的是让工具条隐藏后顶上那一栏空出来的地方不至于太空了
没东西可以看，所以放一个标题占位」**。

| 性质 | R45-B/D（旧） | **R45-E/F（现）** |
|---|---|---|
| 定位 | `flex:none`，**占一行** | `position:absolute`，**不占流** |
| 与工具条 | 在它**下面**另起一行 | **同一栏**（垂直同轴：`top: calc(--toolbar-top + (--toolbar-h − 1.3em)/2)`） |
| 横向 | 给工具条让路（`max-width: calc(50% - 116px)`） | **允许钻到工具条底下**（`calc(100% - 32px)`，只保证不出面板）—— R45-F |
| 让开量 | 写在标题的 `padding-top` 上 | 归 `.view-body::before`，**与标题无关** |
| 代价 | 白吃 **121px**（`92 + 21 + 8`） | **0**（内容位置与标题无关） |
| 文案 | 动态（账号昵称 / 卡片标题） | **写死的每视图标签**（list=「帖子列表」/ archive=「数据卡片」/ cards·profile=无） |

**⚠️ R45-F（2026-09-25）：标题**允许**被工具条盖住** —— 用户口径
**「我希望工具条直接覆盖在标题上，遮住也没关系」**。

⇒ 横向不再为工具条预留那 88px 半宽，`max-width: calc(50% - 116px)` → **`calc(100% - 32px)`**
（= `left:16` + 右 16，只保证**自己不出面板**）。

**为什么删掉那个数反而是加强**：`116 = 88`（条半宽）`+ 16 + 12`，它把**工具条半宽写死在标题上** ——
加第 5 个视图钮 / 改条内间距 / 改按钮尺寸都会让它**悄悄失效**，而失效的样子正是"标题被工具条压住"
（现在本来就允许）⇒ **没有任何东西会红**。删掉它，换成两条能红的判据（见下表 ⑤c）。

**"遮住也没关系"成立的三个前提**（前两条已进判据，第三条是既有性质）：

1. 工具条是**不透明白卡**（`--pill-bg: #ffffff`，R45 从毛玻璃改来的）⇒ 压住就是**真遮住**，
   不会从条里透出半截字；
2. 标题 `z-index:2` **小于**工具条的 `3` ⇒ **条压标题**，而不是标题浮在条上
   （反过来才是难看的坏法，而这条口径正是以"条在上"为前提）；
3. 工具条**自动隐藏**（R45-A）⇒ 被压住的那一截在条隐去后自己就露出来了。

| — | 判据（`_assert_layout` ⑤ / ⑤b / ⑤c） |
|---|---|
| 标题存在性 | list 族 + archive **必须有**标题；cards/profile **不许有** |
| 标题**不占流** | `pageTitle.inFlow` 必须为假（拦 R45-B/D 那种"独立占一行"的回流） |
| **留白** | `contentTopInPanel.top − --toolbar-band ≥ --toolbar-gap`，**且不得多过 40px** |
| **⑤c 不出面板**（R45-F） | 标题右缘 ≤ 面板内缘 − 16（`pageTitle.rect` vs `layout.panelRect`）—— 允许被盖，**不许出界** |
| **⑤c 条压标题**（R45-F） | `layout.viewBodyZ < layout.toolbarZoneZ`（判**层叠上下文那一层**；不判"是否重叠"） |

> ⚠️ **长标题会被"切成两段"，这是已知且已接受的**（用户 2026-09-25 拍板「保持现状」）：
> 条只有 176px 宽且居中 ⇒ 标题够长时**从条的两侧都露出来**，读起来是
> `帖子列表 · 临时长标 [工具条] 住标题时的观感`（1100 档实测截图，devlog/189 §五）。
> **不去修它的理由**：① 现在的标签都只有 4 个字（≈80px），要长过 **175px** 才够得着条左缘
> —— 当前**不可达**；② 条**自动隐藏**（R45-A）⇒ 条隐去后整句自己就露出来；
> ③ 真要修得先有一个"跟着条宽走"的量，而条宽**由内容决定**（加视图钮就变），
> 那正是本批刚拆掉的那类写死数。
> **⇒ 别把"切成两段"当 bug 修**；要改先问用户（三个选项：截断到条左缘 / 条上加渐隐遮罩 / 维持）。

> **⑤b 的被测量在 R45-E 换了**：旧判据量「标题**文本顶**」（让开量当时写在标题的
> `padding-top` 上，只能这样间接推）。标题挪进工具条那一栏之后，那条判据**恒红**
> （文本顶 ≈14，永远到不了 52+51）—— 这就是"必须换被测对象"的信号。
> 新判据量「**第一个在流内的内容块**的顶」（`layout.contentTopInPanel`，`probe.ts` 已换算成
> 面板内坐标）：更硬，而且 cards/profile 这两个没有标题的视图**也能用同一条判据**。
> ⚠️ 反面也判（留白 > gap + 40）：拦"让开量写了两处"（`.view-body::before` + 视图自己的
> padding 没删干净 ⇒ 双倍留白）。
> ⚠️ 探针取"第一个**非 absolute** 的子节点" —— 否则会拿到 `.page-title` 自己（它在工具条那一行）。
> ⚠️ **R45-E2 起判据用的是"该视图自己那个量"**（`toolbarGaps[<view>]`，按 tag 取；
> `list` 有 6 个扩展帧，按**视图族**判），并加了两条**接线**判据 —— 见上面的
> 「R45-E2：间距是四个量」。少了接线那两条，"映射写错"会变成自洽的假绿。

> **顶部渐隐（R39-D，方案 A）**：滚动体滚下去之后才挂
> `mask-image: linear-gradient(to bottom, transparent 0, #000 28px)`（`--view-fade`）——
> 内容接近光条时**逐渐淡出**，而不是被容器上界硬切一刀（用户：「卡片直接被容器的上界裁切掉了，
> 但上面是透明区域，这稍微有点不符合直觉」）。**开关的单一事实来源**是 `OverlayScroll` 下发的
> `data-scrolled`（`scrollTop > 0`，随它既有的 scroll/RO/轮询一起更新，零额外监听）；
> 四个视图各一行选择器（`.archive-view` / `.list-scroll` / `.board-view` / `.hero-scroll`）。
> 探针两个方向都判：未滚动**不许**有 mask、滚动后**必须**有（`archive-scrolled` 帧）。

#### 工具条显隐状态机（R45，2026-09-24，用户拍板）

用户口径三条：**① 能指示当前在哪个界面 ② 不突兀、不抢视线 ③ 不需要时自动隐藏**。
②③ 合起来把问题从"表面材质"改成了"**行为**"—— 而且 ③ 顺带解掉了 ②：

> **常驻才是"突兀"的根源。** 玻璃这套语言的含义是「**浮在内容之上、用完就退**的控件」；
> 把一块玻璃**永久钉在 hero 图顶部中央**，是手段与语义的矛盾。变成按需出现之后，
> "不透明浮片"的代价（盖住用户选的图）从"永久"降到"仅交互的那几秒" ⇒ 它从最贵变成最便宜。

**① 与 ③ 的直接冲突**：「指示当前在哪个界面」与「自动隐藏」不能同时字面成立。分权如下：

| 角色 | 承担者 |
|---|---|
| **主指示器** | **内容本身** —— 卡片 / 列表 / 牌堆 / 画布四者形态差异极大，不需要控件告诉你 |
| **按需指示器** | 工具条可见时的选中块（`.view-switch-thumb`）—— 控件只在"你正在找切换入口"那一刻回答"我在哪" |
| **反馈** | 冷启动首挂 + 深休眠唤醒时**闪现 1.2s**（见下） |

| 状态 | 触发 | 表现 |
|---|---|---|
| `rest` | 默认 | 表面 + 四钮全隐；`pointer-events:none` |
| `shown` | 指针**移动进入**热区并停留 **≥140ms** | `--motion-fast` 淡入 + 轻微下移 |
| → `rest` | 指针离开 **+900ms grace** | 收回 |
| `pinned` | **Tab 聚焦**（`:focus-within`，纯 CSS，不经 state） | 显形 |
| `flash` | 冷启动首挂 / 深休眠唤醒 | `shown` 1.2s → `rest` |

**四个设计决定各自的理由**：

1. **热区 = `.view-switch` ∪ 右上组的 rect，各外扩 8px** —— **不是整条 66px 带子**。
   整条会把"去够列表页的分类胶囊"也算进去（那是用户要**最直接可触及**的控件）。
   窄档尤其明显：1100 档面板只有 558px。
2. **必须要求"移动进入"而不是"停留"** —— 数据视图的牌堆是**滚轮翻转**的：用户可能把指针
   停在顶部中间一直滚。**静止指针不产生 `mousemove`** ⇒ 不误弹。这一条 dwell 单独做不到。
3. **140ms dwell 过滤"路过"** —— 热区在面板顶部，从 40px 顶栏往下进内容**每次都要穿过它**；
   不设门槛就是"路过即闪"。刻意去够 140ms 察觉不到、快速穿过去不触发（macOS 自动隐藏 Dock 同招）。
4. **grace 用 900ms，不引入第二个数** —— 原来 `.bg-tools` 就是这个拍子（注释写着"与侧栏
   悬浮滚动条同拍"）；合并显隐时把它继承过来。

**三条不可谈判的实现约束**（都不是偏好，是正确性）：

| # | 约束 | 不这么做会怎样 |
|---|---|---|
| 1 | **`:focus-within` 必须显形** | `opacity:0 + pointer-events:none` **仍在 Tab 序里** ⇒ 键盘用户 Tab 到一个**看不见的控件** |
| 2 | **不许 `visibility:hidden` / `display:none`** | 那会把它移出 Tab 序 ⇒ 键盘**永远够不到**切换器 |
| 3 | **不许 `aria-hidden`** | 这 4 个钮是真实控件；对读屏用户"一直可用"比"跟着鼠标隐现"更好 |

**两个实现陷阱**（都踩过，都写进了注释）：

- **`.view-toolbar` 必须 `pointer-events:none`**：它压在内容上，若吃指针则顶 66px 内
  **滚轮不滚列表**（祖先全是 `overflow:hidden`，没有可滚动祖先，wheel 事件落空）
  且**卡片顶部点不着**。代价是 CSS `:hover` 收不到事件 ⇒ 呼出只能按**指针位置**判定。
  ⚠️ 它还会造出一个**和 R39-D4 反向**的 bug：band 不吃指针、但条画在上层 ⇒
  **"看着被盖住、其实点得着"**（R39-D4 那条是"看着能用、其实点不着"）。
- **"要不要闪现"必须在渲染期决定一次，不能放进 `useEffect` 里判断**：StrictMode 下
  effect 走 setup→cleanup→setup，cleanup 会清掉闪现定时器；判断若也在 effect 里，
  第二次 setup 会因"本会话已闪过"**早退** ⇒ 定时器再没人装、`barShown` **永久停在 true**。
  （`ui_probe.py --toolbar` 抓到的正是这个：`rest: shown=1` 而 `afterLeave` 正常。）

**探针**：`ui_probe.py --toolbar`（状态机：rest 全隐 / 进热区呼出 / 移出收回 / 聚焦显形 /
不挤动内容）+ 默认三档的 `layout` 段（几何、对比度、**与内容控件不相交**）。

#### 设计指南：在背景图/插画上放控件，怎么才不留"边界"

**R39-D → D3 三轮返工的结论**（用户连着两次说"边界还是很明显"，最后量了像素才定案）：

1. **光的边界只能由衰减决定，不能由盒子决定** —— 任何渐变/遮罩在元素边界处**必须已经归零**。
   `radial-gradient(72% 100% …)` 的百分比是相对**整个盒子**的：横向半径 72% × 354px = 255px，
   而半宽只有 177px ⇒ 左右边缘处渐变才走到 69%、白还剩 16% ⇒ 边界当然还在。
   要"在盒子内部就归零"就得让半径 ≤ **50%**（= 半宽）。**判据写进探针**：解析半径，必须 ≤50%。
2. **⚠️ 但"亮度连续"≠"看不见"**：半透明白抹掉的是背景的**局部对比** —— 眼睛读的是
   **纹理边界**（"细节从哪开始消失"），不是亮度边界。实测光条盒子边缘的亮度落差已经是
   **0.0 / 0.0 / 0.8**，用户仍然觉得"很明显" ⇒ 这是**"在照片上叠加白光"这个手段本身的天花板**，
   继续调数值治不了。
3. **两种正解，不要停在中间态**：**让形状明确**，或**让形状消失**；中间态
   （一团说不清边界的白）最容易露馅。
   - **本仓 R45 起选"明确"，但明确的手段是「不透明实底 + 阴影」，不是毛玻璃。**
     ⚠️ R39-D3 曾把"毛玻璃"当作"明确"的手段 —— 它确实比渐变好，但两条都站不住：
     ① **在默认背景上贡献精确为 0**（近白平滑纱罩上，白 .10 与 `blur` 都不产生可检出的差异）；
     ② "让背景**变糊**"本身就是"**细节消失**"最字面的形式 —— 它只是把**冲淡型**的纹理边界
     换成了**失焦型**的纹理边界，而人眼对中高频的对比敏感度峰值恰好落在这条线上。
     R45 改走 ① 浮片族的实底 + 阴影（见 §B1「视图切换条」与下面第 5 条）。
   - **让形状消失**（不给整条做底，只在**当前项**后面留一团柔光）：
     ⚠️ R39-D4（2026-09-23）后**本仓不走这条** —— 那团白光在默认背景（近白）上看不见，
     当前项已改成**粉底圆角块**（见 §B1 选中块行）。留作备选路线的记录。
4. **图标压在不可预测的图上必须自带对比保护** —— 而且**必须真的提供得了对比**。
   ⚠️ 这条曾经"写了但没满足"：毛玻璃（`blur` + 白 .10）**几乎不改变背景的亮度**，
   深色图标压在深色插画上照样读不出来 —— 保护是名义上的。真正满足它的是**不透明实底**。
   探针判据（R45 新增）：非激活图标的**非文本对比 ≥3:1**，按**渲染值**算
   （`opacity` × 图标色 over 条面），**不写死数字**（`.4` 叠在纯白上也只有 1.89:1，
   连纯白都过不了；`.7` = 3.44:1）。
5. **⚠️ R45 推翻了本条的旧写法。** 旧文：「**外阴影一律不要**：它在背景图上会**再投一条线**；
   玻璃的边只用**内描边**。探针判据：`box-shadow` 非 `none` 时**必须**含 `inset`。」
   —— **推翻的理由**：那条写在"**一团柔光**"的语境里。柔光本身就是一圈说不清边界的白，
   再叠外阴影 = 图上**两条线**，当时是对的。但 R39-D3 选了"让形状**明确**"之后，
   手段已经不是光了，而是**矩形** —— 而**矩形的深度承担者就是阴影**。
   ⇒ 纪律从"一律不要"换成**按层判**：

   | 层 | 形状由谁承担 | 阴影 |
   |---|---|---|
   | **面**（`.view-switch`，一块浮起的卡） | `--pill-shadow` | **必须有** —— 白底铺在近白页（`#fffbfb`）上**填充看不见**，浮片族一直是靠阴影立形状的（`.float-pill::before`） |
   | **面上的选中块**（`.view-switch-thumb`） | 填充 + 描边 | **不要** —— 再加就是"面上的面"，两层深度反而糊 |

   判据不再是"有没有阴影"，而是「**这一层是不是靠阴影读形状**」。
   ⚠️ 旧判据在探针里跑过整整一轮（R39-D3 → R45），而**它想保护的性质从没被断言过**：
   「**默认态下这个面必须看得见**」直到 R45 才写成判据（`barOpacity` + 底色 alpha=1 +
   必须有外阴影）。**这是本仓反复出现的模式：判据写死了上一轮的结论，而不是那一轮要保护的性质。**
6. 圆角取 **12px**（与 `--pcard-radius` 同值）—— 全仓"贴纸卡那一族"的圆角口径。
7. **「面」的语言与「选中」的语言是两件事，别让同一手段兼任**（R39-D4 的教训）：
   - **面**回答"控件压在不可预测的图上怎么保住对比度" ⇒ 毛玻璃/实底（与选中无关）；
   - **选中**回答"当前在哪一个" ⇒ 走全仓统一的选中语言（`--sel-bg` 浅粉底 +
     `--c-primary-deep` 主色粉边，与侧栏选中行同族）；
   - 把选中做成"白光"的代价是**它只在深色/图片背景上成立** —— 默认态下整个控件失去状态指示。
     判据写进探针：选中块底色 **alpha 必须 =1 且不得是渐变**。
   - 另一半教训：**绝对定位的指示器会画在 in-flow 按钮之上** ⇒ 指示器所在的那一层必须显式
     抬起来（`position:relative + z-index`），否则"选中"会把"内容"盖掉。
8. **⚠️ 「激活=粉底白字」的底是一条**令牌**，不是十个局部选择器**（R49 批 3，2026-09-25）：
   - 全仓有 **10 个选择器**用同一个 `--c-primary-deep` 当底 + 白字：
     `.filter-chip.on` / `.acc-switch-btn.on` / `.type-chip.active` / `.drp-preset.on` /
     `.lc-dlg-tab.on` / `.board-btn.on` / `.vd-sign-opt.on` / `.lc-month-pop-btn.on` /
     `.fan-preset.on` / `.float-pill.on`（能力窗「去登录」）。
   - 它们的共同性质只有一条：**白字压在粉底上**。旧令牌 `#fb77a1` 上白字 **2.54:1**
     —— 小字要 4.5、图标要 3，**两边都不达标**（TODO 曾把这件事记成"4 处小字"，
     实测是整族的 10 个选择器）。
   - ⇒ **压深令牌 `#c9406f`（4.72:1）一次修好全部**。逐个改 CSS 会让同一个"激活"出现两种粉，
     而且下次加一处激活态又会漏 —— **这是令牌问题，不是若干处遗漏。**
   - 色阶参考（白字）：`#e35d8b` 3.38 · `#d94a7a` 4.03 · **`#c9406f` 4.72** · `#bf3563` 5.38。
     ⚠️ **别再调回浅色**：要更亮的粉就得改成深字，那是推翻全仓"激活=粉底白字"语言的设计变更。
   - 判据：`ui_probe.py` 的 `_assert_layout` ③b —— 扫那 10 个选择器里**有文字的**，
     逐个算白字对比（<18.66px 按 4.5:1、大字号按 3:1；图标类交给上面那条 3:1 判据）。
     **反向验证**：令牌调回 `#fb77a1` ⇒ 三档全红、读数 **2.54:1**、一次点名多个元件。
   - ⚠️ **量这条判据前必须杀过渡**：`.type-chip{transition:all .15s}` /
     `.float-pill::before{transition:background-color}` 在虚拟时间下不推进 ⇒
     `getComputedStyle().backgroundColor` 读到**过渡起点（白）**，两者相除恒为 **1.00:1**。
     本批第一次跑就栽在这里（报"令牌没生效"，其实是**尺子错**）—— 见 `DEV-LOOP` §6.6。

#### B1.1 cards 视图（展示页 / 默认视图）
| 名称 | 类名 | 说明 |
|---|---|---|
| 滚动层 | `.hero-scroll` | **OverlayScroll**（2026-09-08 起，原 `overflow-y:auto` 原生条会导致窗口右缘出现滚动条 + 内容宽度跳 12px）：`flex:1;min-height:0`，内层 `.os-scroll` column 居中，gap 20，padding `0 0 134px`（底部留白 134px；设计稿 70px 侧距被无收缩子元素溢出抵消，故无左右 padding） |
| Hero | `.hero` | column 居中，`width:100%`，padding `23px 15px 0`，gap 10 |
| 头像 | shadcn Avatar `.hero-avatar` | **179×179**，`filter: drop-shadow(0 0 2px rgba(0,0,0,.98))`；取 `vtuber.avatar`（VTuber 本体，**稳定，不随账号切换变化**），回退所选账号头像 |
| 直播徽标 | `.live-tag`（内 `i.live-dot` 6px） | **23px 高、8px 圆角**、红边红底胶囊（`live`）/灰边灰字（`off`）+ `live_title`（14px/字距3px）；数据源=本页 `vtuber` 的 bilibili 账号（`account-progress` 增量合并，与左栏同源） |
| 名字 | `.hero-name` | **57px/500 黑 + 投影(0 2px 4px 黑25%)**；hero-name-block 高 110 |
| 签名 | `.hero-sign` | **25px/600** `rgba(94,94,94,.76)` 字距3px（30px 行高盒）；走 **VTuber 整体事实**（B站优先账号，无 B站取首个），不跟随 list 所选账号（2026-09-05 视图隔离） |
| 平台药丸行 | `.stat-sets`（key=vtuber.id 触发重播） | 集内 gap10、集间 gap10，每组至多 3 枚（`pillSets` 每 3 枚切分） |
| ├ 药丸 | `.stat-pill.image/.pink/.coral` | **191×37**，**2px 圆角** + `1px 2px 4px rgba(15,23,42,.12)` 阴影；**图像底**（`docs/design/pills` → `src/assets/pills/`，bilibili/weibo 全不透明同规格，`100% 100%` 铺满），未知平台奇偶交替 `--pill-fill-pink #e35d8b` / `--pill-fill-coral #e05261`（白字 26px 对比 ≥3.4:1）。**P8-B 交互**：`.is-link` 可点（点击开账号主页，键盘可达 + focus-visible 主色描边）、`.is-dragging` 长按拖动重排（350ms 阈值，`pointerdown`+`elementFromPoint`+`data-pill-index`，零依赖） |
| ├ 加账号钮 | `.pill-add` | **P8-B** + **R15③（2026-09-15）**：37×37 半透明粉方钮，**未 hover 时高度 0 + 负边距抵消列 gap ⇒ 净占位 0**（`.stat-set` 与 `.hero-divider` 的距离因此是 10px，而不是原来的 57px —— 用户要的"徽章紧贴分割线"），此时 `opacity:0` 且 `pointer-events:none`（看不见就不该能点）；hover（`:hover` 或 `.stat-sets[data-hover='1']`）展开回 37px / `opacity:.75` → 自身 hover 时 1；点击打开 `<AddAccountDialog>`。⚠️ `data-hover` 由 React 维护，**存在的唯一理由是探针**：CSS `:hover` 在 `--dump-dom` 里无法模拟，没有它"hover 后可点"这条就无从断言（`--polish` 派发 `pointerover/pointerout` 量两种状态） |
| └ 数值 | `.pill-value` | **26px/600 白**，**右对齐**（`.stat-pill justify-content:flex-end`，右 padding 12px），数字 ≤4 位（`formatCount` 收紧）+ **`text-shadow 0 1px 2px rgba(0,0,0,.35)`** 保图像底可读 |
| 饰条 | `.hero-divider` | 394×24 设计稿 SVG || ~~企划行~~ | ~~`.faction-badge`（内 `.pill-logo`）~~ | **P8-2 已删除**（card 视图不再展示企划/公会；企划编辑迁往 P8-B 的「档案设置」窗口）。`.pill-logo` 随之删除 |
| 背景工具钮 | `.bg-tools > .bg-set`（`Settings2`） | **P8-B 起语义变更**：不再是「换背景图」直传 file input，而是打开**档案设置窗口** `<VtuberSettingsDialog>`（背景/名称/企划/设定/头像/签名/账号管理）。**R45：显隐并入工具条**（原来自带一套 `bgToolsVisible` + 900ms 定时器，与工具条并存会**错拍** —— "工具条出现了、设置钮还没出现"）；位置 `right:12px; top:14px` 与 `.view-switch` **同轴**（条 top 6 + 高 46 ⇒ 中线 29；浮片 30 高 ⇒ top 14） |
| 档案设置窗口 | `.vd-settings*` | **P8-B 新增**：radix Dialog（`max-w-lg` + `max-height:78vh`）＝ 头部驻留（`.vd-settings-head`）＋ `OverlayScroll`（`.vd-settings-scroll`）＋ 底部操作条（`.vd-settings-foot`）；分区 `.vd-section`（背景/头像/签名/已订阅账号 —— 原「基本资料」2026-09-13 按用户口径整节删除，devlog/067 §四）、字段 `.vd-field`、账号行 `.vd-acc`（行内两个钮：`.vd-acc-hist` 开账号信息历史、`.vd-acc-del` 删账号）。**全实时生效**（无保存钮：blur/点击即写库）；~~锁定胶囊 `.vd-lock.on`~~ **2026-09-13 退役**（devlog/074：`accounts.locked_fields` 已删，改为「允许覆盖 + 记曾用值」）。~~曾用值内联展示（`.vd-former` / `.vd-acc-former`）~~ **同日撤出**（devlog/075），**R9 改为独立弹窗**（2026-09-13，devlog/080 —— 见下方「账号信息历史弹窗」行）。⚠️ **不要给 `.vd-settings` 加 `position:relative`**：本文件在 Tailwind 之后加载，会盖掉内容体上的 `.fixed`，弹窗会从视口居中变成文档流定位（实测飘到视口下方 620px）。规格遵循 UI-MAP §C6。⚠️ **这与 F2 末条是同一类事故**（"后加载的样式表压掉前者的 `position`"），全仓已发生两次（此处飘 620px、`lc-pop` 落在视口外）—— **别再用"靠加载顺序赢"的写法** |
| └ 账号信息历史弹窗 | `.ah-dialog` / `.ah-*` | **R9 新增**（2026-09-13，devlog/080）：点已订阅账号行右侧的**历史钮**（`.vd-acc-hist`，`History` 图标）打开。「曾用名/曾用签名」只列**该账号**的平台侧旧值（`.ah-former`，`.ah-former-val` 胶囊 + 日期 `<em>`；其余账号的条数用一句 `.ah-note` 说明）；「账号信息快照」时间倒序列 `.ah-snap`（时间 / 粉丝数 / 直播状态 / 开播标题 / 来源标注，上限 60 条）。空态文案明确写"只有**抓取到**变化才会留下旧值（手改不入账）"。刻意独立成窗 —— 曾用值混在编辑区里正是用户否掉的形态；数据源 `GET /vtuber/{id}/former-values` + `GET /account/{id}/stat-snapshots` |
| └ 签名 + 平台签名下拉 | `.vd-sign-field` / `.vd-sign-toggle` / `.vd-sign-panel` | 2026-09-13 三次迭代（devlog/072→073→**075**）：输入条右端**内嵌 chevron**（`.vd-sign-toggle`，22px 热区、右内距 30px、展开旋转 180°）→ 点开候选面板。面板是**弹窗内容体的直接子元素**（在 `.vd-settings-scroll` 之外）+ `position:absolute`，坐标由 JS 按输入条矩形算（相对内容体 padding box：同宽、贴下方 6px、放不下则向上翻转、跟随滚动/resize/**锚点矩形变化**重定位）—— 浮在「已订阅账号」之上、**不推挤**、也不会被滚动体的 `overflow:hidden` 裁掉；收起态不存在面板。⚠️ **别改回 portal+`position:fixed`**：radix 模态弹窗会给 `document.body` 打 `pointer-events:none`（只把自己的内容体改回 auto），portal 出去的面板继承 `none` ⇒ **hover 与点击全部失灵且不报错**（2026-09-13 用户实测"点不动"）；改成 `pointer-events:auto` 又会被 radix 当成"点了外面"，**点一行就把整个弹窗关掉**；portal 进内容体则因内容体带 `translate-x/y-[-50%]`（包含块）让 `fixed` 坐标全错。候选行 `.vd-sign-opt`：**单行** = 签名文字 `.vd-sign-text`（弹性、`min-width:0`、横向可滚、滚动条隐藏）+ 右端固定平台名 `.vd-sign-plat`（主账号挂 `<em>主账号</em>`、当前项粉底白字）。文字过长时在平台名之前**渐隐**（**只在真的溢出时**挂 `.ovf` 的 `mask-image`）。交互（用户定）：**只留 hover 自动滚一次**到结尾、移出回起点；再点 chevron 收起（`mousedown` 的"点外部"判定把输入条也算内部）；`↑/↓/Enter/Esc` 键盘口径见组件注释。几何、结构与**可点性**不变量由 `ui_probe.py --settings` 断言（**29 项**，含命中测试 `panelHit`/`rowHit`、"点一行不会关弹窗"`pickKeepsDialog`，以及 R9 的历史弹窗四项）。**语义（A3，devlog/074）**：下拉里点某个平台 = 把卡片签名**来源**改成那个账号（写 `sign_source_account_id` 并**清掉 `sign_override`**），**不改任何 `accounts.sign`**；输入框打字 = 写 `sign_override`（覆盖优先于来源），清空输入框 = 撤销覆盖回到跟随来源；来源账号被删 → 回落主账号。有效值解析与卡片同口径（`utils/signSource.ts::resolveSign`） |

#### B1.2 list 视图（帖子列表页）
| 名称 | 类名 | 说明 |
|---|---|---|
| 筛选条 | `.chips-bar`(+`.chips-bar-inner`) | **固定顶不随帖子流滚动**（提取自滚动区，天然分隔操作钮行与滚动区），`max-width:900px` 与列表同轴居中，padding `10px 16px 8px`；`.type-chips` 出血补丁保留 |
| 滚动层 | `<OverlayScroll className="list-scroll">` | **根** = `flex:1;min-height:0`（滚动体 `.list-scroll .os-scroll` 接管布局：列布局/居中/gap 14/padding `8px 16px 24px`——顶部 8px 防卡片网格阴影被裁切） |
| 内容箍 | `.list-inner` | **列宽契约（列表页唯一权威）**：`width:100%; max-width:900px; align-items:stretch` 居中，column gap14。⚠️ 选择器必须是**后代** `.list-scroll .list-inner`——OverlayScroll 在中间插了一层 `.os-scroll`，写成直系子（`.list-scroll > .list-inner`）整条规则会静默失效，列宽退化成「内容宽度」：短标题页整列缩到 566px 居中、含长不可断行串的页整列被撑到 1350px 并左右溢出（封面被左缘裁切、日期推出窗口）。`scripts/ui_probe.py` 已固化该契约断言 |
| 操作按钮组 | `.header-actions` | **仅列表视图**渲染（卡片页纯展示无此行）：行首账号切换器（`margin-right:auto`）+ 右侧可收起浮片组——收起态 `[`.actions-toggle`][更新动态`.on`]`；展开态向左滑出 抓取账号/抓取帖子/添加账号/解除订阅（红），`actions-toggle` 被挤至最左、图标旋转 180° 变收起钮；`.actions-extra` 用 max-width 0→480px + opacity + translateX 动画（320ms cubic-bezier），`margin-left:-8px` 抵消父 gap |
| 筛选行 | `.type-chips-row` | chips 左 + 「搜索 + 筛选钮」右；`nowrap`（工具区永不掉行），窄窗整体换行兜底 |
| 类型chips | `.type-chip(.active)` | **分组**：投稿=video+video_dynamic、图文=image+text（key 逗号串直传后端 `in_` 过滤），转发/专栏/音乐/直播单型；微博另有一套（图文/视频/转发/系统）；计数 `stats.by_type` 求和、零组不显示；超宽时 `.type-chips` 行内横滚兜底（⚠️ 横向滚动条为全局 webkit 样式，见 F 节） |
| 搜索 | `.search-float`(`input` 190×30) | 300ms 防抖 → `q`（标题/摘要/正文三路） |
| **筛选钮 + 弹窗** | `.pfilter-wrap`(`.pfilter-btn`) → `.post-filter-pop` | **2026-09-10（P10-A）新增**：此前 `.chips-tools` 里并排「时间钮 + 已删钮 + 已归档钮」三件（越挤越长、类型 chips 被迫换行），现收敛为**单钮 + 单弹窗**。触发器文案 `筛选` / `筛选 · N`（N=生效条件数），`title` 回显明细；激活走 `.float-pill.on`。弹窗三分区（`.pop-group`，与侧栏筛选弹窗同源）：**状态**（已删 toggle + 计数，即时生效）/ **归档**（三态 chips 全部·仅未归档·仅已归档+计数，即时生效）/ **时间范围**（双月历 + 预设 + 确认，草稿制）+ 底部 `重置`。规格走 §C6，z-index 30，点外关闭/Esc 双通道。详见 C3-b |
| 时间范围选择器 | `.drp`(`.drp-panel/.drp-head/.drp-nav-group/.drp-day/.drp-preset/.drp-confirm`) | **双月历**（`components/common/DateRangePicker`，逻辑在 `utils/dateRange.ts`）：左右两块月份面板各自独立翻月、星期表头一…日（周一为首）、恒 6×7、区间连续色带（`--sel-bg`，两端 6px 圆角）+ 端点 `--c-primary-deep` 白字 + 今天「描边环 + 数字下圆点」；底部预设 近一周/一月/三月/一年/两年/所有（量纲**含今天**）+ 粉底 `确认`。**头部导航成组**（R39-A）：左组 `[上一年][上个月]`、右组 `[下个月][下一年]`，标题在几何中心；跳年 = `shiftMonths(∓12)`（复用月位移口径，双箭头 `opacity:.75` 弱一档），探针按 `data-nav="year"` + `data-dir="±1"` **真点一下**对账"正好跳一年、月份不变、可逆"。窄窗（≤1080）收成单月历 |
| 帖子流 | `.post-grid(.is-refetching)` | 重取时旧内容降透明禁点击，无整屏闪动 |
| 卡片 | `<PostCard>` `article.post-card` | **浮片化特例**：白底、2px 圆角 + `var(--pill-shadow)`、去发丝边；hover 上浮 2px + 阴影加深 + **标题变色 `--c-accent`** |
| ├ 封面 | `.post-card-cover` 220×16:10；SmartImage 三态兜底 | 有封面=图；**无封面（纯文字）= `.post-card-cover-paper` 米白纸纹斜条底 + 居中大标题（`.paper-title` 4 行截断）**；类型角标/时长角标浮于其上 |
| ├ 标题/摘要 | `.post-card-title/.summary` | 两行截断；`overflow-wrap:anywhere`——连续「！！！」或长链接这类不可断行串允许任意处折行后再截断，不横向裁掉半个字 |
| └ 底行 | `.post-card-footer`：徽章 `.stat-badge`×n + 日期 | 播/赞/评/转；正文 `.post-card-body` 带 `min-width:0`（解除 flex 自动最小尺寸，长串不再把日期挤出卡片） |
| └ 置顶标记 | `.post-card.is-pinned` + `.post-card-pin` | **R35（devlog/139）**：置顶帖在标题上方多一枚 `Pin` 图标 + 「置顶」粉底 pill（`.post-card-pin`，`rgba(251,119,161,.14)` 底 + `.45` 描边，同 `.deleted-flag` 家族），卡片整体加一圈 `0 0 0 1px rgba(251,119,161,.55)` 描边（叠在 `--pill-shadow` 之上**而不是画左边条**：卡片是「封面 + 正文」横排，左边条会被封面图吃掉）。排序由后端 `paginated` 负责（`is_pinned desc, published_at desc`），前端只负责"解释它为什么不在时间线上"。**2026-09-17 用户口径改版**：徽章钉在**卡片右上角**（`.post-card` 加 `position: relative`，徽章是它的直系子元素）、**不占标题那一行** —— 置顶卡的标题用 `.post-card.is-pinned .post-card-title { padding-right: 58px }` 在右端让位。⚠️ 第一版把徽章塞进 `.post-card-cover`（那里是定位祖先）⇒ 落到**封面**右上（探针量出右内距 290px）。探针 `--pinned` 对**每一条置顶卡**断言五条几何：右内距 8px / 上内距 8px / 是胶囊宽（≤80px，不是撑满一行的块）/ 在卡内 / 在右半区，外加"徽章不压标题**文字**（Range 量字形，不是元素盒——盒子含让位内距，拿盒判必假红）" |
> **标题 / 摘要的取值口径（2026-09-17，devlog/143）**：`utils/format.ts::postDisplayTitle`
> = `title` → **正文首行** → `summary` → 平台 ID；`postDisplaySummary` = `summary` → 正文首行 → `null`。
> 两者都**跳过占位串**（`cv<数字>` 专栏/opus id、`[9P]` 图片张数、`[OP]` opus 占位，见
> `isPlaceholderText`）—— 用户截图那条「标题 = `cv409088396`、摘要 = `[9P]`」就是这么来的：
> 后端曾把 DRAW/OPUS 的 `data.id` 当标题、把图片张数当正文（已修，但**库里已存下的**那些
> 不会消失（刷新时"空值不覆盖"），所以展示侧必须自己认得出占位串。

| 无限滚动 | `.load-sentinel` + IntersectionObserver | **不分页懒加载**：哨兵 1px（root=`list-scroll`，rootMargin 600px 预载）命中且 `hasMore=posts.length<total` 时 `page+1` 追加；`page===1` 走替换（整表 + is-refetching 变暗 + grid key 按替换型指纹重挂动画），`page>1` 走追加（按 id 去重拼接、不动 key 不重挂旧卡片）；追加失败 `loadMoreError` 尾条手动重试；到底显示 `.load-end`「已经到底啦」 |
| 回顶浮钮 | `.back-to-top` | **44×44 圆形白卡**（right 18 / bottom 18，`--pill-shadow`），滚动 >400px 浮现（`.on`），点击平滑回顶；hover 图标变粉 |
| 占位/错误 | `.posts-placeholder` / Alert(destructive) | 加载 Spin / 空列表 / 失败 |

#### B1.3 archive 视图（数据视图 / v0.9.x 重建后形态：仅两张 870 定宽卡片纵向排列）
> 🔴 **2026-09-06 重建已删**：`.archive-grid-top` 双列布局、**重要日期卡**（UpcomingEventsCard / `.event-*`）与 profile 视图里的旧档案卡布局全部退役——当前 archive = 直播日历卡 + 粉丝趋势卡（均 870px 定宽、恒高、卡片自治，不共用列表操作钮行）。
> 后端 `GET /vtuber/{id}/events`（R37-P3 起已接线，见 B1.4 的大事记卡）、`future-reservations`（R13 起已接线）都在用；`api.createVtuberEvent` / `deleteVtuberEvent` 目前**只有封装没有 UI 入口**（增删留到 R37-P3b 与自定义卡片一起做）。

| 名称 | 类名 | 说明 |
|---|---|---|
| 视图容器 | `<OverlayScroll className="archive-view">` | **根** = `flex:1;min-height:0`；滚动体 `.archive-view .os-scroll` = column 居中 gap 14 padding `16px 20px 24px` |
| 直播日历 | `<LiveCalendar>` `.live-calendar` | **卡 870×631 · 4px 圆角 · `--pill-shadow`**（定宽上限 870：拉宽不变；恒高 631、不参与 column 压缩）。结构：标题行（`直播日历` 16.5/600 + 空月 note）→ 导航行（月 nav 浮片三连 + 当月类型统计胶囊）→ 星期表头 → 6 行 ×7 列月历。详见 B3 |
| └ **未来预约标记**（R13，2026-09-15，devlog/088） | `.lc-cell.has-resv` / `[data-resv-count]` / `.lc-resv-time` / `.lc-resv-title` / `.lc-resv-mini` / 浮层 `.lc-resv-badge`、`.lc-resv-item` | 来自**动态里的直播预约**（服务端 `future_reservations` 解析 `body_json.reservation`）。口径：① **不改九类色系** —— 只在格子左缘加一道强调粉竖条 + 文案用粉；② **无场次但有预约的日子徽章是「预约」**（不是待定/休息：报待定等于把"确定会开播"这条已知信息藏起来）；③ 格内计数槽放**预约人数**（不重复"预约"二字）；④ 已有场次的日子预约压成一行小字 `.lc-resv-mini`（不与场次争主位）；⑤ hover 浮层顶部单列预约块（`.lc-pop-head` 抬头显示 `N 场 · M 预约`），**只有预约没有场次的日子也能 hover 查看**。护栏：`ui_probe --reservations`（脚本往数据副本里**种一条明天的预约**，断言格子徽章/时刻/人数/标题 + 浮层条目） |
| 粉丝趋势 | `<FanTrendChart>` `.fan-chart` | **卡 870×460 · 4px 圆角 · `--pill-shadow`**；标题 16.5/600 同 `lc-title` 规格。**ECharts 6.1 架构**（canvas 全程自绘，React 只负责卡片壳与头部控制）。详见 B4 |

#### B1.4 profile 视图（档案视图 / R37-P1 起：卡片画布）
> 🔵 **R37-P1（2026-09-17，devlog/141）起本视图 = 卡片画布**，占位页已撤。
> 旧的 `ProfileView` / `ProfileCard` / `AccountPicker` **文件仍保留不删**（P8-B 的「档案设置」
> 窗口复用其企划 Select 与账号一览逻辑），但**当前没有视图引用它们**（死代码，重做自定义卡片时可用）。

| 名称 | 类名 | 说明 |
|---|---|---|
| 视图容器 | `<ProfileBoardView>` / `.board-view`（OverlayScroll） | 与 archive 视图同构：整块视图自己滚；滚动体 padding `12px 18px 18px`、column gap 12 |
| 头部 | `.board-head` | 标题「档案视图」+ 右侧说明（`N 张卡片 · 12 列网格 / 窄窗单列`） |
| 网格 | `.board-grid`（`[data-board]`） | **12 列 × `--board-row`(84px) 行 + gap 12**，`grid-auto-rows` 由模型定死 ⇒ 卡片高 = `h×84 + (h-1)×12`；`data-board-cols` 与 `data-board-narrow`（阈值 560，**下发给探针**，免得 TS/Python 各写一份） |
| 卡片外壳 | `.pcard`（`data-card-kind` / `data-card-h` / `data-card-hpx` / `data-card-min-h`） | **R37-P4a 起是「贴纸卡」**（规格 `docs/design-archive-cards.md` §2）：`--pcard-radius` 12px + `--pcard-shadow` 双层柔和阴影 + `--pcard-ring` 顶部高光内边，**无发丝边**（描边配阴影会显脏）；阅读态 hover 上浮 2px + 阴影加深（编辑态取消 hover 上浮）；头部 `.pcard-head`（标题 12.5/600 + 贴纸角标）+ 体 `.pcard-body`（`overflow:hidden`，**高度仍由网格算死、内容不得撑高**；`data-card-min-h` = 默认行数，探针据此判"默认尺寸装不下内容"） |
| 贴纸角标 | `.pcard-badge[data-tone]`（`data-card-badge`） | **每卡恰一枚**（规格 §3 的签名元素）：22px 全圆 + 白环 `0 0 0 2px #fff` + 微阴影，内含 13px 白色 lucide 图标。**只放图标不放文字**（白图标在深档粉底上 2.4:1，属装饰、旁边必有文字标题；带词就得过 4.5:1 ⇒ 短词一律进 `.tone-chip`）。图标与色调由**注册表下发**（`CardKindMeta.icon/tone`，缺一个 `registerCardKind` 当场抛错） |
| 卡内文字 chip | `.tone-chip[data-tone]` | 浅底（tone 14%）+ 深档字（`--tone-*-deep`，实测 ≥4.5:1）：高 18、圆角 999px、11px。色调只有五个来源：`today/future/past`（大事记时间线）与 `view/like`（优质投稿指标） |
| 布局模型 | `components/profile/layoutModel.ts` | 纯函数（**30 条单测**）：`defaultLayout`（书架式填行）/ `clampCard` / `normalizeLayout`（**向下推开**消重叠）/ `toSingleColumn`（窄窗降级）/ `gridStyle` / `cardHeightPx` / `moveCard` / `resizeCard` / `cellsFromPx` / `columnWidthPx` |
| 卡片注册表 | `components/profile/cardRegistry.ts` | 「支持拓展」的唯一入口（**7 条单测**）：`registerCardKind({kind,title,defaultSize,icon,tone,render})` —— 重复 kind **抛错**、**色调不在封闭清单抛错**、**没给图标抛错**、顺序 = 注册顺序；`cards/index.tsx` 注册内置卡片，**视图不认识任何具体卡片** |
| ├ 纪念日卡 | `cards/AnniversaryCard.tsx`（kind `anniversary`，5×3，tone `pink`） | **R37-P4a 重排**（规格 §4.1）：hero 大数字（30/700 + 单位 + 一句说明，`[data-anniv-hero]`）**只在真有记录时出现**；两行退化成**静态事实**（`3/14`、`9/17 · 第 3 周年`，行间发丝），不再各自重复天数；hint 改成口径说明。口径 `anniversary.ts`（**20 条单测**：宽容解析 `2000-05-20`/`5月20日`/`05-20`、倒计时、2/29 平年按 3/1、就是今天、hero 取最近的、无记录不许有 hero） |
| ├ 大事记卡 | `cards/EventsCard.tsx`（kind `events`，6×3，tone `navy`） | **R37-P4a 改成时间线**（规格 §4.3）：脊线由 `.evt-list::before` 画（2px，**伪元素**——`<ul>` 里塞 `<span>` 是非法结构）、每行一枚 `.evt-dot`（8px：今天实心粉 / 未来空心蓝 / 已过空心灰）、行尾 `.evt-chip`（「今天 / N 天后 / N 天前」）。骨架同样占好落点位置（数据到达不右移）。口径 `events.ts`（**14 条单测**：未来在前 / `YYYY-MM-DD` 按**本地**解析不走 UTC / 脏数据跳过 / 空态说清 / chip 三态）。这张卡也是**扩展点的真示例**：加它只写了 `events.ts` + `EventsCard.tsx` + 注册一行，**视图一行没改** |
| └ 优质投稿卡 | `cards/TopPostsCard.tsx`（kind `top-posts`，7×3，tone `coral`） | **R37-P4a**：封面 56×36 + `--pcard-radius-inner` 8px + 白环（贴纸化的最小改动，骨架尺寸同步 46×30 → 56×36）、播放/点赞变 `.tone-chip`（数字走 `formatCount`，与平台药丸同一口径）。卡片**自己取数**（`listPosts` 一页 50 条）→ `topPosts.ts` 排序（**12 条单测**）+ 一句「按什么排 · 共几条」；点一行开帖子详情抽屉；未到位 = 同尺寸骨架（R36 口径） |
| 编辑态（R37-P2b） | `.board-actions` / `.board-btn(.on)` / `.board-hint` | 头部一枚「编辑布局」；进编辑态变「重置默认 + 完成」。编辑态才有的东西：卡片阴影升到 `--pcard-shadow-edit`、卡头 `cursor: grab` + 抓手图标、右下角 `.pcard-resize` 手柄、**网格辅助线**（`.board-grid.editing` 的 `repeating-linear-gradient`）。窄窗（<560）**按钮禁用**并写明原因（单列是模型算的，编辑会跟它打架） |
| 拖拽 / 缩放 | `.pcard.dragging`（阴影升到 `--pcard-shadow-lift`）+ `layoutModel` 的 `moveCard`/`resizeCard` | 手势用 Pointer Events（卡头发起拖动、手柄发起缩放，`touch-action: none`）；每跨一格重算一次布局（`d.base` 快照 + 累计位移 ⇒ 不漂移）；**松手整版 PUT**，成功顶栏胶囊「布局已保存」、失败**回滚到上一版** + 说明（不留「看着排好了其实没存上」） |
| 动效（R37-P4b 已落地） | `components/profile/motion.ts` + `data-card-phase` | **手势相位机**（纯函数，**18 条单测**）：`idle / pressing / lifted / settling`；口径 **阅读态长按 350ms 拿起并进编辑态 / 编辑态按下即拖**，拿起缩放 ≤1.055（`--ease-pop` 一次性过冲），跟手位移 = `指针位移 − 格子位移`（**视觉位移 ≡ 指针位移**），落位 220ms `--ease-emphasized` 无回弹。令牌 `--motion-*` / `--ease-*` 在 `tokens.css`（与状态胶囊规格同一组值，含慢放变量 `--motion-scale`）。reduced-motion：**缩放归零、落位不滑行，跟手保留 1:1**（跟手是输入反馈不是动画）。**退避 FLIP 留 P4c** |
| 动效调测页 | `.mlab`（`data-motion-lab`，`?motion=cards`） | `components/dev/MotionLab.tsx`（**dev 构建动态载入**）：单步触发（按下/跟手/跨格/落位/连播）+ 慢放 1×·0.5×·0.25×（改 `--motion-scale`）+ 跟手误差读数。它派发**真实的合成 PointerEvent**，不是另画一套假动画。护栏 `ui_probe.py --motion-lab` |
| 增删卡片（R37-P3b） | `.board-add` / `.board-add-pop` / `.board-add-item`（`data-kind`）/ `.pcard-remove` | 编辑态头部一枚「添加卡片」：菜单只列**已注册但不在板上**的 kind（每项带该卡自己的贴纸角标 + 默认尺寸 `w×h`），全在板上时**禁用并写明原因**。每张卡头部一枚 `×`（**仅编辑态**，放在头部行内而不是绝对定位 —— 绝对定位会压住标题）；`×` 上 `pointerdown` 要 `stopPropagation`，否则会顺带触发卡头拖拽。落点 `firstFreeSlot`、尺寸取注册表默认、**不弹删除确认**（内容都在库里） |
| 自动滚动（R37-P4d） | `.board-view.editing .os-scroll`（跑道）+ `components/profile/autoScroll.ts` | 拖到容器上下 **64px** 触发区 ⇒ 自动滚动（最大 900px/s，按深度 ramp；拖出容器按满速）。口径：**内容坐标位移 `D = 指针位移 + 滚动量`**，模型格位与跟手补偿都只喂 `D` ⇒ 卡片视口位置恒等于手指位置（滚动中不漂）。**编辑态**在滚动体底部留 **240px 跑道**（`--board-runway`）保证"永远还能往下滚"；驱动是 **rAF + 定时器双驱动**（虚拟时间下 rAF 几乎不被服务，实测 400ms 0–1 次）。护栏 `ui_probe.py --motion-scroll` |
| 已知边界 | — | 位置 / 大小 / 增删卡片 / 边缘自动滚动都已支持；**自定义内容**（文本 / 外链卡 + `config_json`）尚未做（R37-P3b 按拍板只做内置卡增删） |

#### B1.5 共用层：跨视图联动刷新（事件总线）
| 事件 | 触发方 | 消费方 |
|---|---|---|
| `ddtoolkit:fetch-idle` | TopBar 轮询 running→idle 边沿（**含静默的自动节拍**——动态流每轮结束也派发，卡片才能自己刷新） | VtuberSidebar 刷列表；PostsPage `refreshTick`（重拉 vtuber 本体+统计+帖子；`selectedAccount` 按 uid 取新引用） |
| `ddtoolkit:account-progress` | TopBar 快照增量（**内容 diff 而非长度增量**，2026-09-07 修复环形上限/清空丢事件） | VtuberSidebar `mergeSnapshots` 就地合并（`utils/accountSnapshots.ts` 共享实现）；PostsPage 同源合并 hero/徽标 |
| `ddtoolkit:data-changed` | 添加/解除订阅成功 | VtuberSidebar 刷列表 |
| `ddtoolkit:kick-poll` | 各操作按钮 | TopBar 立即轮询一次（防单V抓取快速完成漏边沿） |
| `ddtoolkit:pill-message` | 抓取/更新完成 | TopBar 状态胶囊覆盖显示 4s |

> ⚠️ **后台刷新不得打断用户草稿**（2026-09-10 修复）：上述事件会让 PostsPage 换掉 `vtuber`
> 对象引用，任何「依赖 props 重新初始化表单」的弹窗都会把用户正在编辑的内容冲掉
> （实测：`VtuberSettingsDialog` 在动态轮询期间改一项丢一项）。弹窗草稿一律用
> **显式播种键**（打开态 + 实体 id），只在该键变化时重播种。

### B2. 详情窗口 `<PostDetailDrawer>`（components/PostDetailDrawer.tsx）
P6-2 起为**居中 Dialog**（原 Sheet 右侧抽屉）`sm:max-w-[720px]`（⚠️ 该类名必须与模板插值分离成纯字符串——Tailwind v4 提取器对「带方括号的类名紧邻 `${`」会丢弃候选
（曾吞掉 `sm:max-w-[720px]` 致详情窗全宽），一律 `'…' + (cond ? ' x' : '')` 写法），
标题 = 帖子类型名。**2026-09-07：① 面板滚动改覆盖式 OverlayScroll**（`.post-detail-scroll`，内容区精确占剩余空间，滚动体 padding 20px）**② 头部驻留区**（`.pd-head`：flex:none · padding `16px 20px 12px` · 下缘发丝分隔；radix 关闭钮 absolute top-4 right-4 落在本区右缘）——`「标题……X」` 钉在面板顶部不随内容滚动，滚动条只在内容区悬浮、不覆盖标题行；动效见「抽屉动效」段（dialog-content/overlay，scale 0.97 替代右移）。**退场为类驱动（P6-4）**：radix Presence 对「换名动画」的判定基于挂载时缓存的 computed style，data-state 换名不会真播退场（面板/遮罩瞬消）——组件侧 `exiting` 态加 `is-exiting` 类播 200ms 再真正闭合，遮罩经 `[data-slot=dialog-overlay]:has(+ [data-slot=dialog-content].is-exiting)` 联动（open 态动画被覆盖为退场、卸载时已不可见）。结构未变动：元信息行(类型/时间/平台ID/原文链接/墓碑flag) → 墓碑时间线(已删时) → 统计徽章行 → 预约卡 → 封面大图 → 正文三态(Delta/HTML/纯文本) → 转发原文卡 → 图片组 → 附加字段(bvid/cvid/description) → 原始JSON 折叠。

### B2.1 图片查看器 `<ImageViewer>`（components/ImageViewer.tsx）
P6-4：从详情窗口打开图片的**独立浮层**——portal 到 body、`z-[200]` 高于详情窗（z-50）。
**交互自持（关键）**：根层显式 `pointer-events-auto`——详情窗（radix modal）会把
`document.body` 置为 `pointer-events:none`，查看器属「窗外节点」会继承成点击穿透
（点击落到其下 overlay 先关详情窗）；配合根层 `onPointerDown` 阻断冒泡屏蔽
radix `pointerdownOutside`。Esc 用 capture 阶段拦截，只关查看器。**遮罩只盖详情窗口**
（按 `[data-slot=dialog-content]` 实测矩形定位 `bg-black/40` 圆角随窗，不含整屏黑纱）。
封面 / 图片组 / 转发原文缩略图均可点开；封面在帖子有多图时**入列首位**
（`[封面, ...图片组]`）。**2026-09-09 去重（用户反馈「单图帖点封面显示两张」）**：
微博抓取把 `images[0]` 同时写进 `cover_url`（`platforms/weibo.py`），旧逻辑
`[封面, ...images]` 会把同一张排两遍——改为 `dedupeImages()` 按 URL 去重后再入列，
单图帖只剩一张，前后切换/点状序号由 `count > 1` 自动隐藏；图片组与转发原文
缩略图同样走该去重（`图片（N）` 计数同步）。交互：上一张/下一张（**黑色玻璃圆钮**：
border-white/25 + bg-black/60 + backdrop-blur，左右键同效，单图隐藏）、
**底部点状序号**（点击跳转，单图隐藏，当前点白色放大、其余 white/40）、
关闭钮为同构黑色玻璃圆钮（10×10，右缘 20px）。图片无外框/无底色，直浮于内容上；
点击遮罩空白区 = 关查看器（不伤详情窗）。**开/关均有动画**（posts.css：出场
`.image-viewer-img` 微缩放+淡入、`.image-viewer-veil` 淡入；关闭组件 `closing` 态 +
`image-viewer-closing` 类驱动 200ms 微缩淡出+遮罩渐隐，到点才卸载；
reduced-motion 禁用）。图片加载同一混合策略（直连→代理→失败占位）。

### B3. 直播场次详情弹窗（`<LiveCalendar>` 内部，2026-09-07 用户定案）

> **R36（2026-09-17，devlog/140）· 一条贯穿全弹窗的规矩**：`未到位` 与 `到位` 两种形态
> **同尺寸**，弹窗高度不随上游数据到达变化。三条落点：① 左列补「本场速览」卡（填满封面
> 下方的空区域）；② 右列 A 组指标、弹幕信息、直播动态三处的"未到位态"从**一行文案**换成
> **同尺寸骨架**（`.lc-skel`）；③ 三处内容各套一层 `.lc-dlg-slot--*`（`min-height` 预留
> 常见量）。⚠️ 代价是**故意留白**：数据比预留少时卡片底部空一点，换来的是"打开后窗长不跳"。
> 判据 = `ui_probe.py --archive` 连采两格（打开后 120ms / 稳定后），比 **滚动内容高** + 窗高
> + 两列区 + 右列卡 + 速览卡（窗高在内容顶到 `max-height` 后恒等，**只有内容高有牙口**）。

点击**日期格**打开（hover 浮层保持纯信息展示不动）——portal 到 body 的独立居中弹窗。

> **两段式取数**（2026-09-13，devlog/063）：详情端点只回本地库数据（弹窗 ≤0.2s 可读），
> 弹幕/指标/直播动态三样由 `…/upstream` 独立取（弹幕段与动态段各自 loading，可就地重试）。
> 上游会间歇性变慢（实测 1.1s ↔ 15.6s），拆开前它能把整个弹窗拖到最坏 93s。
>
> **一次取数 = 2 个上游请求**（summary + 中断/继续事件，并发），**不是 4 个**（2026-09-14，devlog/081）：
> dev 环境 React StrictMode 会让取数 effect 跑两遍（实测同一 liveId 隔 63ms 调了两次
> `/upstream`），而缓存只在成功后写入 ⇒ 两个调用都会 miss。现在同场次**单飞**共享一轮上游，
> 日志里 `场次上游取数` ×2 + `单飞复用` ×1 + `ukamnads.icu` ×2 即为正常；
> 打包版没有 StrictMode，一次点击本来就只调一次。

| 区域 | 类名 | 说明 |
|---|---|---|
| 遮罩 | `.lc-dlg-backdrop` | fixed inset 0、z-60、`rgba(15,23,42,.32)`、淡入 0.18s；点击空白（target===currentTarget）关闭；打开期间锁 body 滚动 |
| 面板根 | `<div className="lc-dlg" role="dialog" aria-modal>`（**面板=头部驻留区 + 内容滚动体**，2026-09-07 user 定案） | **720px**（`max-width calc(100vw-48px)`）、`max-height min(680px, calc(100vh-64px))`、**12px 圆角**、白底 + 发丝边 `--c-border` + `--shadow-dialog`；入场 pop 0.2s（translateY 8 + scale .98）；**头部驻留区** `.lc-dlg-head-zone`（flex:none · padding `16px 18px 12px` · 下缘发丝分隔）承担头部行+多场 tabs——不随内容滚动、滚动条不覆盖；**内容区** `<OverlayScroll className="lc-dlg-body">`（flex:1 min-height:0；滚动体 `.lc-dlg-body .os-scroll` column gap 12 / padding `12px 18px 18px` / overscroll-behavior contain） |
| 头部 | `.lc-dlg-head` | 左=**分类胶囊按钮**（点击弹全部分类下拉）+ 标题（15px/600 单行截断）+ 副行 `日期 HH:MM`（11.5px 次级）+「已校正」红字标（`category_from==='override'`）；右=关闭钮 26×26 r8 |
| 分类下拉 | `.lc-dlg-cat-pop` | 208px 宽、max-h 340、r12、`--shadow-dialog`；列表 = **自动（跟随推断）** 灰胶囊 + 9 类彩色胶囊（26px 高 r46，`.on` 内描边 2px 深灰）；选后 PUT/DELETE override 并重拉场次+详情；点外部关闭 |
| 多场切换 | `.lc-dlg-tabs` | 当日多场时显示：HH:MM 胶囊（r106），激活 = `--c-accent` 底白字 |
| 两栏主体 | `.lc-dlg-main` | grid `264px minmax(0,1fr)` gap 12 |
| 左列 | `.lc-dlg-left` | **R36（devlog/140）**：封面 + 「本场速览」卡纵向排（gap 12、恒 264 宽）。加它的原因：封面是 4:3 定宽、右列却随上游指标变高 ⇒ 封面下方原本是一块**空区域**（用户截图红圈处） |
| ├ 本场速览卡 | `.lc-dlg-glance` + `.lc-glance-grid` / `.lc-glance-cap` | **R36**：与右列同材质（`#faf7f8` · r10 · padding 12/14）；**2×2 四枚胶囊**（用户口径"只放四枚本地就有的值，分双行"）：时长 / 峰值在线 / 弹幕数 / 收益（值缺失写 `—`，与右列同款口径；口径在 `components/live/sessionGlance.ts` + 6 条单测）。⚠️ 上游迟到的那组（观看/点赞/打赏/互动）**不进这张卡** —— 它们已在右列按行展示，本卡只负责第一帧就把空区域填满 |
| 左封面 | `.lc-dlg-cover` | **264px · aspect-ratio 4/3**（danmakus 封面 720×540=4:3 与 704×396=16:9 混存，4:3 容器 + `object-fit:contain` 双全）；r10 截角；`ProxyImage`（`fallback` 槽位）三态：直连 CDN（normalizeImageUrl + `referrerPolicy=no-referrer`——裸 img 漏此曾 403；微博图床 sinaimg/wbcdn 起点即走代理）→ `/img-proxy` 后端代理 → `fallback` 渲染渐变底 + 首字大号占位（64px 粉 55% 透明）；左下状态徽章（已结束=黑玻璃 / 直播中=粉 `rgba(251,119,161,.92)`，r106） |
| 右直播信息 | `.lc-dlg-sec` + `.lc-dlg-rows` | r10 `#faf7f8` 区卡；行式 label(58px 次级) 左 · value 右；字段：时间（HH:MM–HH:MM + 时长）/ 分区 / 收益 ¥ / 峰值在线 / 弹幕数 / **A 组指标**（观看/点赞/打赏人数/互动/在线排名，来自 danmakus v2 live，**独立请求** `…/upstream`）/ 段数（>1 显示「N 段合并（中断续播）」）/ 数据源（danmakus+self+feed 组合）。**R36 起 A 组指标块（`.lc-dlg-metrics`）恒定四行**：未到位时是同尺寸骨架（`[data-pending=1]` + `.lc-skel--val`），到位后原位换真值；`min-height:109px` 给第五行「在线排名」预留位 —— 三种状态同高。「上游响应较慢…」这类提示改挂**标题行**（`.lc-dlg-sec-note`，不占额外行高） |
| 弹幕信息 | `.lc-dlg-sec--full` | 满宽区卡：弹幕总量（大数 600）+ 完整性提示（`metrics.is_full===false` 时「弹幕数据未全量（部分录制源）」）+ **增量摊铺拼贴词云**（`MosaicCloud`，参考图形态）；五态文案见下（**不说"暂无弹幕数据"** —— 那会把"没拉到"说成"没有"，devlog/062/063）。**R36 起内容套一层 `.lc-dlg-slot--danmaku`（`min-height:258px`）**：未到位 = 两行骨架 + 词云区骨架（`.lc-skel--cloud` 恒 210px，与 `MosaicCloud` 的 `boxH` 一致），到位/没有/失败三种形态都占同一块地方 ⇒ 弹窗高度不随数据到达变化 |
| └ 弹幕五态 | `wc_status` | `upstream` 展示词云 / `upstream_absent`「上游未提供热词」+「用弹幕自建」/ `self_built` 展示 + 标注本地统计 / `no_danmaku`「本场没有可用于统计的文本弹幕记录」/ `fetch_failed`「弹幕拉取失败（网络或上游不可用）。」+「重试」；取数请求本身没通（HTTP/网络）=「弹幕数据未取到（上游取数请求没通；可重试）」+「重试」 |
| └ 词云 | `.lc-dlg-cloud` + svg | 高 **210px·宽度自适应**（ResizeObserver 实测内容区宽，user 2026-09-07：池子宽度不对→实测）；**增量摊铺加权 Voronoi 拼贴**（2026-09-07 user 定案）：power diagram λ 权重（面积∝词频）+ **力导向站点摊铺**（质量感 collide q=0.2、中心引力、矩形软墙，位置直推无速度积分）+ **逐个入池**（频次降序每 150ms 一个，站点=当前最大空腔）；**容器轮廓圆角**（roundedRectPolygon 16px 圆角边界）；全部入场后 alpha 冷却 → 静止即停 |
| └ 破泡 | `removeWord` + 局部松弛 | 点击词 → cell **立即消失**（纯同步删，无卡顿）→ **局部闭合**（node 验证：缺口处 2 词挤入、远处位移 avg 6.5px/max 16px、偏差 15%、单调 100%）：α=0.15 起步 + kCenter=0（力场几乎不动、停中心引力）——**λ 修正把缺口面积重新分配给相邻 cell**（power 边界"鼓胀"塞住缺口，站点只微挪）；远处纹丝不动；段头「已破泡 N · 恢复」胶囊一键还原 |
| └ 面积比例 | `utils/wordCloudLayout.ts` | 目标面积 = count 比例 **保底 0.05%**（画布 0.05%，小词仍可见分级）→ 归一化；**松弛手感**（user 定案 2026-09-07）：β=0.1（λ 面积修正慢速蠕动）+ α=0.994 慢冷却 + 碰撞质量感 q=0.2（大泡稳、小泡让）——node 验证：单调性 100%、终态偏差 2.01%、填满 100%、有效帧 <20ms |
| └ 词云配色 | `CLOUD_COLORS` | **浅色填充**（10 色浅粉系：#ffc9c4/#a5e6ff/#dccff7/#bee9ec/#ffd5b8/#fff2a0/#fda5ff/#b2f3c0/#ffdfe8/#d8e8ff）+ **同色系深字**（HSL 压暗同色相 L=0.28，`cloudWordText`）——user 2026-09-07：填充浅色、文字深色；白缝 `stroke=--c-bg-card` 2px；hover：当前格 1/其余 0.4；hover 提示 = 黑玻璃胶囊「词 · N 次」（`.lc-dlg-cloud-tip`） |
| └ 数据 | `detail.data.danmaku.top_words` | 后端 `LiveDanmakuInfo.top_words`（top40 带次数）；前 40 按 count 降序；无词=「暂无热词数据」 |
| 直播动态 | `.lc-dlg-evts` | 满宽区卡：**B 组事件**（type 7=直播中止·灰点 / 8=直播继续·粉点，`send_date` HH:MM）+ **A 组在线峰值高光**（`metrics.peaks` 前 3，「N 人在线」，金点）；空=「暂无动态数据」。**R36 起内容套 `.lc-dlg-slot--evts`（`min-height:150px`）**，未到位 = 三行骨架（点 + 两条 `.lc-skel`） |
| 内容分析 | `.lc-dlg-sec--full` | 预留区块：`analysis.summary` 有值显示，否则「接口已预留（内容分析服务接入后展示）」——**接口字段已就位，服务未接入** |

### B4. 粉丝趋势卡 `<FanTrendChart>`（components/FanTrendChart.tsx）

| 名称 | 类名 | 说明 |
|---|---|---|
| 卡 | `.fan-chart` | 870×460 · 4px 圆角 · `--pill-shadow` · padding `17px 16px 10px` · gap 8；恒高不参与压缩 |
| 标题 | `.fc-title` | 16.5/600（与 lc-title/archive-section-title 同规格） |
| 概览行 | `.fan-chart-head` | 左=**1d/7d/30d 涨粉**（`fmtDelta`：+1,234 / −56，数值粉 `--c-primary-deep`）；右 = 容量档位 + 重置窗口按钮 |
| 档位 | `.fan-presets` / `.fan-preset.on` | **3个月/6个月/1年/全部** 四档（`PRESETS`：90/180/365/∞ 天）；描边 999px 组 + 激活粉底白字；切换重建 option 并回默认窗口（30 天） |
| 重置 | `.fan-chart-reset` | 非默认窗口才显示：`--sel-bg` 底 + 粉字 r999（CalendarRange 图标）；dispatch dataZoom 回尾部 30 天 |
| 图区 | `.fan-chart-body` / `.fan-chart-canvas` | ECharts canvas 铺满；loading/error/empty 态复用 `.lc-state` |

**图（全 ECharts option 内配置，React 不进渲染链路）**
- 双轴：左=**粉丝数**（`smooth` line 主粉 `#fb77a1` 2px + 线性渐变面积 0.28→0.02；`connectNulls`）；右=**日增粉**（bar，正=粉/负=灰蓝 `#a0aec0`，柱宽 55%，2px 顶圆角；按日 diff，首日/断档 null）；
- **dataZoom**：slider（底部 24px 全量迷你时间轴：粉系把手/选中区/数据区）+ inside（图表区滚轮缩放、按住拖动平移——ECharts 原生增量渲染，跟手零 React 渲染）；
- **Y 轴域随窗口**：datazoom 事件 250ms 节流跟随 + 260ms 空闲精确；`fanDomain`（±3% 余量、50 整、interval 整倍）/ `deltaDomain`（对称 ±cap）——修复刻度 200/300 混排；
- 入场动画 320ms / 更新 150ms（`animationThreshold:2000` 防大点卡顿）；tooltip = 白卡 r12 + 粉系文字（`box-shadow` 同 `--shadow-dialog`），xs: 日期 + 粉丝数/日增粉两行；
- 数据：`GET /account/{id}/fan-trend`（服务端按天分桶）→ `daily`（Map 去重每日后值 + 逐日差分）→ 档位切片。
> ⚠️ **recharts/shadcn Chart 已退役**（v0.6.0 用 recharts Brush → 2026-09-07 重写为 ECharts 6.1 按需注册：LineChart/BarChart/Grid/Tooltip/AxisPointer/DataZoom×2/CanvasRenderer）；`components/ui/chart.tsx` 与 `--chart-1..5` 令牌已随退役删除，**图表色值统一集中在 `utils/chartTheme.ts`**（PINK=`--c-primary-deep`、MUTED=`--c-text-sub`、GRID=`--c-border` 派生；改动配色同步 tokens.css / C 节）。

---

## C. 设计令牌（styles/tokens.css 与 index.css 同步）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--c-primary` / `--c-primary-deep` | #ffa2b4 / #fb77a1 | 顶栏粉 / 强调粉（shadcn --primary） |
| `--c-accent` / `--c-live` | #fc7079 / #e14444 | hover强调 / 直播红 |
| `--c-bg-page` / `--c-bg-card` / `--c-bg-list` | #fffbfb / #ffffff / #fffbfb | 页面/卡片/列表底 |
| `--c-rail` / `--c-rail-active-bg` | #4b5a6f / #647489 | 图标栏底 / 选中格实底 |
| `--c-border` | rgba(210,216,222,.55) | 发丝描边 |
| `--c-text-main` / `--c-text-sub` / `--c-text-on-primary` | #4b5a6b / #5b6c7e / #ffffff | 正文/次级/主色上文字 |
| `--sel-bar` / `--sel-bg` / `--sel-bg-hover` | #fb77a1 / #fff0f3 / #fff7f9 | 列表选中竖条/底/hover |
| `--radius-card` / `--radius-sm` | 0 / 0 | 方形化（**全仓无人引用的"总纲标记"**，别和 `--pcard-radius` 混） |
| `--shadow-card` | none | 全平面 |
| `--radius-dialog` / `--shadow-dialog` | 12px / 0 4px 16px rgba(15,23,42,.1) | **弹窗层**（二级界面：浮层/弹窗/查看器遮罩，v0.6.1 用户参考风格） |
| `--pcard-radius` / `--pcard-radius-inner` | 12px / 8px | **档案卡族**（R37-P4a）：卡片 / 卡内封面（内层小一档＝同心圆角） |
| `--pcard-shadow` / `-hover` / `-edit` / `-lift` | 见 tokens.css | **档案卡族**四档阴影：静止 / 阅读态 hover / 编辑态 / 拿起（R37-P4c 用） |
| `--pcard-ring` | inset 0 1px 0 rgba(255,255,255,.9) | 卡顶 1px 高光内边 —— "稍微浮起"的关键（光从上面来） |
| `--tone-pink/-coral/-navy/-gray`（各带 `-deep` / `-tint`） | 见 tokens.css | 卡片色调三件套（角标底 / chip 文字 / chip 底），**只许用在 ≤22px 角标与 ≤11px chip** |
| `--motion-instant/-fast/-base/-slow` | 90 / 140 / 220 / 320ms | **动效令牌**（R37-P4b 建；与 `design-status-island.md` §2 同值）。**R38 批 1 起状态岛与揭幕/条目入场全部改用它们**（`si-panel-in` · `si-pop-in` · `.pill-text-fade` · chevron · `rise-in-page` · `rise-in-item`）—— 有探针对齐判据（时长 ≠ 令牌值即红），**别写回硬编码** |
| `--motion-lag` | 60ms | **编排偏移**（不是时长）：R38 批 2 起给 `.pill-text-fade` 用，实现 §3 规则 1「形变先行、内容后到」—— 容器先动、文案滞后 60ms 才淡入。同样跟 `--motion-scale` 走 |
| `--ease-standard/-exit/-emphasized/-pop` | 见 tokens.css | 进入位移 / 离场 / 落位（前快后慢）/ **唯一允许的过冲**（只给"拿起"那一次 scale） |
| `--motion-scale` | 1 | **慢放倍率**：所有动效时长都是 `calc(N × var(--motion-scale))`，只有动效调测页改它 |
| `--pill-fill-pink` / `--pill-fill-coral` | #e35d8b / #e05261 | 粉丝徽章色底（加深版：白字 26px 对比 2.5:1 → 3.4:1，**替代早期 #fb77a1/#fc7079 直接填充**） |
| `--radius-window` | 4px | L3 窗口圆角 |
| `--topbar-height` / `--rail-width` / `--sidebar-width` | 40px / 50px / 492px | 三段尺寸 |
| shadcn `--radius` | 0rem | 全家桶方形化（Button/Select/Dialog…；`sheet`/`toggle`/`toggle-group` 已于 2026-09 P0 清理删除）；**例外：`--radius-xl` = +12px**（2026-09-07 二级界面审查 A1）——`rounded-xl` 仅用于 Dialog/AlertDialog/SelectContent 面板，统一 12px 弹窗层 |

## C6. 二级界面统一规格（2026-09-07 审查定稿）

> 适用范围：一切 Dialog/AlertDialog/SelectContent（radix 注入面板）+ 自绘浮层（filter-pop/post-filter-pop/lc-month-pop/lc-pop/lc-dlg/lc-dlg-cat-pop）+ 灯箱（ImageViewer 遮罩）。新写二级界面必须参照本节。

| 维度 | 统一值 |
|---|---|
| 面板圆角 | **12px**（radix 家族经 `--radius-xl=+12px` 达成；lc-dlg 14→12；按钮类保持 0px 方形） |
| 发丝边 | **`--c-border`**（rgba(210,216,222,.55)）——lc 家族旧 `rgba(15,23,42,.06)` 已废弃 |
| 阴影 | `--shadow-dialog`（0 4px 16px 10%） |
| 遮罩 | **`rgba(15,23,42,.32)`**（radix 旧 black/50、查看器旧 black/40 已统一；lc-dlg-backdrop 本就此值） |
| 入场动画 | 轻 pop：`lc-dlg-pop`（translateY 8 + scale .98 + 淡入）；浮层 0.16s / hover 浮层 lc-pop 0.12s / 主弹窗 0.2s；reduced-motion 全部禁用 |
| 关闭通道 | **点外关闭 + Esc 双通道**（所有浮层；radix 内建） |
| 关闭钮 | **26×26 · r8 · `--c-text-sub` · hover 灰底 rgba(15,23,42,.05) + 主色文字**（radix 与 lc-dlg-close 同款；ImageViewer 黑玻璃圆钮为灯箱豁免）；**焦点环只在键盘态**——2026-09-09 用户反馈「点关闭会冒出粉色选中框」，radix 关闭钮由 `focus:` 改 `focus-visible:ring-*`（鼠标点击不再命中，Tab 仍有环） |
| **头部驻留** | 详情类二级窗口 = **面板 = 头部驻留区（flex:none · 下缘发丝分隔）＋ 内容 OverlayScroll（flex:1）**——「标题……X」（含场次多场 tabs）钉顶不随内容滚动；滚动条只在内容区悬浮，**不覆盖标题与关闭钮**（2026-09-07 user 定案；已接入：帖子详情 `pd-head`、场次详情 `lc-dlg-head-zone`；短表单弹窗内容不溢出，不强制） |
| Tooltip | **黑玻璃胶囊**：`rgba(15,23,42,.78)` 底白字 r999（radix tooltip 与词云提示 `lc-dlg-cloud-tip` 同源） |
| 选中态 | 两原则：① 分类色体系元件（类型胶囊/选项）用**本体色** + 600/内描边；② 其它选择件激活 = **`--c-primary-deep` 底白字 600**（month 旧浅粉底粉字、tab 旧 accent 底均已改）；hover 统一 `--sel-bg-hover` |
| z-index 档位 | 30 锚定浮窗（filter/time）→ 40 日历月份浮窗 → 50 radix（Dialog/Alert/Select/Tooltip）→ 56 hover 场次浮层 → 60 主弹窗遮罩 → 62 弹窗内下拉 → 70 词云提示 → 200 灯箱 |

### 现状清单（维度 × 面板）

| 面板 | 圆角 | 发丝边 | 遮罩 | 入场动画 | Esc | 关闭钮 | tooltip/选中态 |
|---|---|---|---|---|---|---|---|
| Dialog（添加V/登录/批量/详情/添加账号） | 12 | --c-border | .32 | tw-in/out + 自绘 | ✓ | 26×26 r8 | — |
| AlertDialog（关闭确认/解订阅） | 12 | --c-border | .32 | ✓ | ✓ | 无（按钮式） | — |
| SelectContent（账号/企划/平台下拉） | 12 | --c-border | — | ✓ | ✓ | — | 勾选图标 + sel-bg-hover |
| filter-pop / post-filter-pop | 12 | --c-border | — | ✓(0.16s) | ✓ | — | 粉底白字/描边 |
| lc-month-pop | 12 | --c-border | — | ✓(0.16s) | ✓ | — | deep 底白字 |
| lc-pop（hover 浮层） | 12 | --c-border | — | ✓(0.12s) | ✓ | — | — |
| lc-dlg（场次详情） | 12 | --c-border | .32 | ✓(0.2s) | ✓ | 26×26 r8 | 色体系本体 |
| lc-dlg-cat-pop | 12 | --c-border | — | ✓(0.16s) | ✓ | — | 色体系+内描边 |
| Tooltip（IconRail） | 999 | — | — | ✓ | — | — | 黑玻璃胶囊 |
| 词云提示 lc-dlg-cloud-tip | 999 | — | — | — | — | — | 黑玻璃胶囊 |
| ImageViewer 遮罩 | 随窗 | — | .32 | ✓ | — | 黑玻璃 40px | — |

## C2. 浮片系统（layout.css `.float-pill`，令牌见 tokens.css）

自定义风格：**斜切圆角矩形白卡**（豁免方形规则的浮动元件家族）。

| 令牌 | 值 | 用途 |
|---|---|---|
| `--pill-bg` / `--pill-bg-hover` | #ffffff / #eef1f5 | 白卡底 / hover 灰 |
| `--pill-radius` / `--pill-skew` | 3px / -10deg | 圆角 / 平行四边形斜切（::before 承载，内容直立） |
| `--pill-h-sm` / `--pill-h-md` | 25px / 30px | 侧栏行 / 帖子页行 |
| `--pill-shadow` / `--pill-shadow-hover` | 0 2px 6px rgba(15,23,42,.12) / 0 3px 8px .18 | 常态 / hover（hover 上浮 1px） |
| `--pill-fg` | #3d4a5c | 图标与实心三角深蓝灰（⚠️ 原 tokens 误写 `--pill-fg` 与引用 `--pill-fg-icon` 不一致，2026-09-07 审计已统一为 `--pill-fg`） |
| `--pill-ring` | inset 0 0 0 1.5px 主粉 | focus-visible 环（作用于 ::before） |

- 类 API：`.float-pill` 基型 + `--icon`（方形图标钮）/ `--text`（文字钮）+ `--md`（30px）+ `.on`（激活：primary-deep 底白字）+ `--danger`（红字红图标）
- 交互态：hover 上浮1px+阴影加深、按压回落、focus-visible 环、disabled 半透明
- 实心下拉三角 `.pill-caret`（border 法，-15° 微倾）替代描边 ChevronDown
- 现役浮片：侧栏 ＋(50px)/拉取(44px)/过滤触发器(89px)、帖子页时间钮(md)/已删钮/背景工具组 `.bg-set`、header-actions 五钮、**日历月份导航三件套**、**二级弹窗页脚动作**（R21 批 3：设置的「恢复全部默认 / 保存」、添加账号的「取消 / 添加」、档案设置的「关闭」、能力说明的「去登录」、关闭询问的「取消」、账号历史的「关闭」）——**2026-09 P1 起全部由 `<components/common/FloatPill.tsx>` 渲染**（原生 `<button class="float-pill …">`，配方仍在本节 layout.css；原 `.lc-nav-btn`/`.lc-nav-pill` 自绘副本已删，R21 批 3 又删掉了 `.ah-close` / `.cap-login-cta` 两个副本）
- **禁用例**：搜索胶囊（侧栏 240×25、帖子页 190×30）为胶囊形遗留例外，不入体系；Hero `.stat-pill` 彩色统计胶囊属另一家族（2px 圆角图像底）

## C3. 独立筛选弹窗（layout.css `.filter-pop` / `.post-filter-pop`）

> **2026-09-10（P10-A）**：分组语言（`.pop-group` / `.pop-label` / `.pop-chips` / `.pop-actions`
> / `.filter-chip`）由「侧栏专用 `.filter-pop-*`」提为**共享类**，侧栏筛选弹窗与帖子页
> `筛选` 弹窗同源；`.filter-pop`（264px，侧栏）与 `.post-filter-pop`（min(520, 100vw−574)，
> 列表页）各自保留定位与宽度。

- 入口：侧栏过滤触发器（`.filter-wrap` 锚定，点外关闭 + **Esc 双通道**（2026-09-07 二级界面审查），入场动画 lc-dlg-pop 0.16s）
- 三组多选 chip（`.filter-chip`，描边圆角、选中粉底，2026-09-05 弹窗层风格）：状态（直播中/未直播）、平台（accounts 动态提取）、企划（非空 faction 动态提取；语义沿革：阵营=企划=公会）
- 组合逻辑：组内 OR、组间 AND，空组不生效，即时生效无应用钮，底部「重置」
- 触发器反馈：任一筛选生效加 `.on`；展示文案暂占位「默认」待定

## C3-b. 列表页筛选弹窗（posts.css `.post-filter-pop`，2026-09-10 P10-A）

- 入口：`.pfilter-wrap` 锚定 `.pfilter-btn`（`筛选` / `筛选 · N` + `.pill-caret`），
  点外关闭 + Esc 双通道（`PostFilterPop` 内一次 effect 管住整个弹窗）
- 三分区 + 底部重置：**状态**（`.filter-chip` 已删，含 Ghost 图标与计数）、
  **归档**（三态：全部 / 仅未归档 / 仅已归档+计数）、**时间范围**（`.drp` 双月历，草稿制）
- **即时生效 vs 草稿制**：已删 / 归档为即时生效（沿 C3 口径，不引入「应用」钮）；
  时间范围为草稿制（`确认` 才写 `date_from/date_to`，点外关闭/Esc 不留下半截筛选；
  `重置` 会连未确认的日历草稿一并清掉）
- **双月历**（`.drp`，逻辑在 `utils/dateRange.ts`）：左面板=起点月、右面板=终点月，
  各自独立翻月；选点规则「无起点/两端已齐 → 点为起点；已有起点 → 点为终点；
  点到起点之前 → 重选起点」；起点落定后右面板跳「起点月 + 1」，点预设后左右分跳区间
  首/末月；只落定起点时 `确认` 禁用；悬停预览未落定区间（`.drp-day.preview` 浅底描边）
- 布局不变量：弹窗必须完整落在 `.posts-panel` 可视区内（该容器 `overflow:hidden`，
  越界即裁掉左月历）→ 宽度 `min(512px, 100vw − 574px)` 退让；**高度由组件实测**
  （**R45-E 起**：`PostFilterPop` 量「触发器下缘 → 面板下缘」写内联 `max-height`，
  `ResizeObserver` + `resize` 跟随）+ 内部覆盖式滚动（矮窗兜底，底部「重置」驻留）。
  ⚠️ **别再退回 `calc(100vh − 常数)`**：要减掉的那一摞里有**会换行的行**
  （`.header-actions` 按账号数换行、`.type-chips-row` 窄档换行），**没有正确的常数可写** ——
  实测 1100 档 + 8 账号时手算公式把上限给到 349px、弹窗底部越出面板 25px 被裁。
  两段距离 `--pop-gap` / `--pop-breath` 定义在 `.post-filter-pop` 上，TS 侧读，不各写一份。
  该不变量已固化进 `scripts/ui_probe.py`（`list-filter-pop` 三档宽度断言 +
  开→预设→确认→重置→Esc 全链路）；视觉存档见
  `docs/design/screenshots/p10a-filter-pop.png`（`python scripts/ui_probe.py --shot
  --shot-preset 近一月` 生成）

## C4. 条目入场动效（layout.css `.anim-rise`）

- 规格：**`rise-in-item`** 关键帧（opacity 0 + translateY 14px → 0），单项 `--motion-slow`（320ms）
  `--ease-standard`（cubic-bezier(.22,1,.36,1)），步进 45ms/项，CSS `min()` 封顶 400ms（第 10 项后不再追加），`fill-mode: both` 防闪现
- ⚠️ **2026-09-24 R38 批 1 改名**：原来这里叫 `rise-in`，与**启动幕揭幕**那组（`.topbar`/`.icon-rail`/
  `.sidebar-shell`/`.app-main`）**重名** —— CSS 里同名 `@keyframes` **后者赢**，于是揭幕那组写的是
  `translateY(8px)`、实际跑的是本组的 **14px**（设计意图从未生效）。现拆成
  **`rise-in-item`（本组）** 与 **`rise-in-page`（揭幕组，8px + `--motion-slow`）**，两组都令牌化
- 用法：条目根元素挂 `anim-rise` + 内联 `--rise-i` 序号；列表容器以**内容标识 key** 整体重挂载触发重播
- 接入点：侧栏 VTuber 行（key=query+筛选+数据长度）、list 视图 `.post-grid`（key=账号+首末帖 id+数量——loading 期间 key 不变，保留旧内容降透明的无闪动重取）、Hero 平台药丸组（key=vtuber.id，切 V 重播）
- `prefers-reduced-motion: reduce` 下全量禁用

### 退场编排（退出 → 进入，预取门控 + 原子提交）

- `.scene-exit`（fall-out）：整块 `translateY(10px)` 下滑渐隐，**0.13s** ease-in（比 `EXIT_MS=150` 短 20ms，动画必在类移除前结束防竞态帧；这条同步关系由 `utils/sceneStep.test.ts` 断言），`pointer-events:none` 防误点；与 rise-in-item 镜像闭合
- 机制：PostsPage 场景机 `scene{acc,view,exiting}` + **预取门控**——账号目标变化先并行预取三件套（getVtuber/第1页帖子/postStats），旧内容冻结可见；**数据就绪才退场**，EXIT_MS 后一次性应用预取数据（原子提交，页码归 1、**筛选按 VTuber/账号重置**——2026-09-05 用户反馈：筛选状态不跨 V/账号共享，提交时 filterRef 已是重置态与预取默认参数一致防种子错配），**全程无「正在加载」占位帧**
- 防重拉闪动：提交播种 `seededPostsKeyRef`（posts effect 消费一次跳过重拉）+ `vtuberLoadedRef`（跳过冗余 getVtuber）；refreshTick 变化仍正常重拉
- 应用：切 V、视图切换（视图切换无数据依赖立即退场；cards→list 首次帖子加载仍走正常 loading）；搜索/筛选/翻页仅重播入场不退场；**P6-1：筛选切换（type/搜索/时间/已删）立即滚回列表顶部**（触发即滚，不等重取；此前缓存恢复方案实测不达预期已 revert）
- 快速连点（**R31 改版**）：新目标替换预取、旧内容回退到可见冻结；但**退场只播一次** —— 第二次点击若落在退场窗口内，数据就绪即**立刻提交**（`utils/sceneStep.ts::planSceneStep` 的 `commit`），不再重播一轮淡出（唯一例外：换 V 而数据没预取好，仍要等，不能提交空场景）。规则与护栏（单测 + `--switch-perf` 的「连点该比单次快」判据）见 devlog/133；加载占位仅存于首次进入/手动刷新/错误态；reduced-motion 动画禁用（150ms 延迟保留）
- **窗口圆角归 Windows 画（R34，devlog/136）**：Win11 上 `lib.rs::apply_dwm_corners()` 设 `DWMWA_WINDOW_CORNER_PREFERENCE=ROUND` + `DWMWA_BORDER_COLOR=NONE`，CSS 半径归零（`html.dwm-corners`，见 `utils/windowCorners.ts`）⇒ 圆角、**吸附时的方角（实测四角全方、填满）**、最大化方角**全由系统决定**，我们零判定逻辑。⚠️ 属性必须**在窗口显示之后**设（挂 `present_window`；`setup()` 里设会被显示流程冲掉，实测过）；Win10 没有该属性 ⇒ HRESULT 当能力探测，失败就回退 CSS 半径（`--radius-window` 兜底 8px）。护栏：`cargo test` 的判据单测 + 默认探针三档断言（浏览器里 8px / 模拟 DWM 时 0px，反向验证过）。⚠️ `transparent: true` 保留 —— Win10 回退路径靠它切角，代价是没有系统阴影
- **四角白边（R33，devlog/135）**：`.app-shell` / `.splash` 只有 4px 圆角（`--radius-window`），白边有**两层**来源，缺一不可：① **WebView 自己的背景**是白的（`transparent(true)` 只管窗口层）⇒ 壳侧 `setup()` 调 `set_background_color(Some(Color(0,0,0,0)))`（同时设窗口与 WebView），深休眠重建窗口那条路用 builder 的 `.background_color(...)`；② **壳层自己的底色** `--c-bg-page`（近白 `#fffbfb`）会参与子层被圆角裁切时的抗锯齿 —— 实测角上像素 = 子层色 × 覆盖度 + 壳底色 × (1−覆盖度)（rail `#777F8B`、粉 `#FEB4C2` 正是 78~80% 压近白底）⇒ `.app-shell` 在 UI 就位后必须**透明**：启动期仍用近白兜底（否则揭幕时各区域还在 `rise-in` 渐显，窗口会**闪桌面**），`main.tsx` 揭幕完成给 `<html>` 挂 `shell-settled` 后才撤 ⇒ 角上混的是桌面。护栏：默认探针三档都断言 `html.shell-settled` 存在且 `.app-shell` 的 computed `background-color` 为透明（**反向验证过**）。⚠️ R34 之后这条路只在 **Win10**（CSS 圆角兜底）上还会被走到 —— Win11 的圆角由系统画，没有自绘抗锯齿就没有白边
- **头像 / 签名的取值口径（R33，devlog/135）**：**卡片与左栏必须同源** —— 头像 `utils/avatarSource.ts::resolveAvatar`（`vtubers.avatar` → B 站缓存 → 任一缓存 → B 站 URL → 任一 URL），签名 `utils/signSource.ts::resolveSign`（`sign_override` → 来源账号 → 主账号）。左栏此前各写了一份"只看平台字段"的取值 ⇒ 档案设置改完看着像没生效；护栏 = 单测 + `ui_probe --profile-sync`（断言左栏**实际渲染**值 + 无 override 的对照组）。⚠️ 左栏 `Avatar` 上的 `data-src` 与 `.hero` 上的 `data-avatar-src` 是**为可测性挂的**（虚拟时间下图片加载不完、Radix 不挂 `<img>`），别当冗余删掉
- 详情窗口动效（posts.css 末段）：居中 Dialog（P6-2 起）对齐全局运动语言——进场 260ms 淡入+scale(0.97) 缩入、退场 200ms 淡出+scale(0.97)（fall-out 同款 ease-in），遮罩与面板时长严格同步；覆盖 `[data-slot=dialog-content/overlay]` 的 animation-name/duration，radix animationend 卸载机制不受影响；reduced-motion 下 0.01ms 瞌时关闭
- **直播日历增补**（2026-09-07）：月份切换 = keyed 网格重放 `.lc-grid-anim`（前进右滑入 20px / 后退左滑入，0.26s cubic-bezier）；场次详情弹窗 = `.lc-dlg-pop`（translateY 8 + scale .98，0.2s）；月份浮窗 = 同款 pop；均带 reduced-motion 守卫

## C5. 三层组件契约（UI 几何统一基准）

| 层 | 语义 | 形态契约 | 成员 |
|---|---|---|---|
| **交互层** float-pill | 一切可点击触发 | 斜切(-10°)白卡 + 3px 圆角 + 阴影（唯一带阴影）；hover 渐灰；`.on` 主色填充；`.float-pill--danger` 红字 | 侧栏工具行、时间钮、bg-tools、**header-actions 五钮**（更新动态 `.on` 主操作、解除订阅 danger）、**日历月份导航三件套** |
| **信息层** flat-chip | 只读展示 | 平面 **3px、无阴影、不斜切**；色底（粉/珊瑚）或发丝边 | stat-pill（191×37 图像底/色底）、faction-badge（企划徽标，2px 圆角同族）、type-chip、stat-badge、post-card-type、live-tag（8px）、lc-stat-pill（类型统计胶囊 50×19 r88） |
| **弹窗层** dialogs | 弹窗/浮层（二级界面） | **圆角卡片 12px + 柔和阴影 `--shadow-dialog` (0 4px 16px 10%) + 发丝边**；分区标题 600 加粗 + 上方发丝分隔；选择控件描边 8px 圆角、激活=粉底(`--c-primary-deep`)白字；底部主操作=粉底圆角、次要=描边圆角 | 注入 Dialog/AlertDialog/Select 包裹层 + filter-pop/post-filter-pop 自定义浮层 + **lc-pop 场次浮层 / lc-month-pop 月份浮窗 / lc-dlg 详情弹窗（14px）/ lc-dlg-cat-pop 分类下拉** |
| **表面层** surfaces | 卡片/面板 | **0px 方形** + 发丝边 | post-card（浮片化特例见下）、posts-panel、archive-section（4px 存档卡）、live-calendar/fan-chart（4px 定宽卡） |

**用户审美特例（覆盖统一基准，勿在后续回合误改回）**：
- `.live-tag`（卡片页直播徽标）圆角 **8px**
- `.type-chip`（列表帖子分类胶囊）**999px 全圆角 + `--pill-shadow` 浮片阴影**（无发丝边，hover 浮片灰底）
- `.stat-pill`（平台药丸）**图像底**（`docs/design/pills` → `src/assets/pills/`，按平台映射，未知平台回退粉/珊瑚色底）+ **2px 圆角 + `1px 2px 4px rgba(15,23,42,.12)` 阴影**，**全圆 logo 盒已移除**，仅粉丝数**靠右对齐、数字 ≤4 位**（`formatCount` 收紧）+ **`text-shadow 0 1px 2px rgba(0,0,0,.35)` 保图像底可读**；`.faction-badge` 同族 2px+同款阴影
- `.acc-switch-btn`（账号切换器）**浮片化**：白卡 + **2px 圆角 + `var(--pill-shadow)`、去发丝边**（不加斜切保文本可读）；`.on` 主色深填白字
- `post-card`（帖子卡片）**浮片化特例**：**2px 圆角 + `var(--pill-shadow)`、去发丝边**；hover 上浮 2px + 阴影加深 + **标题变色 `--c-accent`**；`.post-card-cover` 无封面时 `.post-card-cover-paper` 米白纸纹斜条 + 居中大标题
- `.pcard`（档案卡）**卡片族**（R37-P4a）：**12px 圆角 + `--pcard-shadow`、无发丝边 + 顶部高光内边**；hover 上浮 2px；编辑态/hover/拿起三档阴影见 `--pcard-shadow-*`（规格 `docs/design-archive-cards.md`）

**豁免**：搜索胶囊（侧栏 `list-search`、帖子页 `.search-float`，用户指定原样）、滚动条圆头、头像与状态圆点（圆形）、**直播日历格 6px 圆角（设计稿规格保留）**、**详情弹窗 14px / 封面 10px（参考图规格）**、**档案卡族 12px + 阴影（R37-P4a，用户 2026-09-18 口径："圆角阴影稍微浮起"）**。

## D. 字体（tokens.css @font-face，均为 woff2 子集化资源）

| family | 文件 | 用途 |
|---|---|---|
| `Alimama FangYuanTi VF`(100–900) | AlimamaFangYuanTiVF-VF.woff2 | 全局默认 `--font-family`（阿里妈妈官方许可：免费商用+嵌入式，见 LICENSE 声明）；**2026-09-09 起 `--font-title` 也指向它**（顶栏标题 15px 字距 5px）——原 `Noto Sans SC Title`（NotoSansSC-Title.woff2，仅含 "DDtoolkit" 的子集）已删除，全站只剩一款字体 |

## E. 交互浮窗清单

| 浮窗 | 入口 | 说明 |
|---|---|---|
| AlertDialog 关闭确认 | TopBar 关闭钮(busy) | 「抓取任务正在进行中」 |
| LoginDialog | TopBar 登录钮（`.topbar-login-btn` + 过期红点徽章） | B站/微博扫码登录（`/auth/weibo/qr/*`） |
| AddVtuberDialog（`.av-dialog`） | 侧栏「+」（`.list-add-btn`） | **R11（2026-09-15，devlog/083）双来源**：① 本地候选（候选池 csv + `danmakus` 索引）输入防抖 250ms 即搜，**不打上游**；② 「B 站」只在**显式触发**（回车 / 点按钮 / 点「加载更多」）时检索（uid 直查或名称模糊搜）→ 点结果行 adopt（建库+自动单V抓取）→ 踢poll + 侧栏刷新 + 右栏跳新V。见 §E1 |
| BatchFetchDialog | 侧栏「拉取」 | 四项：全量账号 / 全量帖子 / 更新未归档 / 归档（前三项后台执行+409防重入，归档同步返回条数） |
| PostDetailDrawer | 帖子卡片 | 见 B2 |
| ImageViewer | 详情窗内图片 | 见 B2.1 |
| AlertDialog 解订阅 | list 视图红色钮 | 说明连带删帖，确认后跳首页 |
| 筛选弹窗 `.filter-pop` | 侧栏过滤触发器 | 见 C3（状态/平台/企划组合多选） |
| 筛选弹窗 `.post-filter-pop` | list 视图「筛选」浮片 | **2026-09-10（P10-A）**：见 C3-b（已删 / 归档三态 / 双月历时间范围）；`.time-pop` 已删 |
| 场次浮层 `.lc-pop` | 直播日历格子 hover | 当日全量场次（起止/时长/收益/峰值/弹幕/数据源/中断段数），**纯信息展示**；120ms 宽限关闭、Esc 关闭（详见 B3） |
| 月份选择浮窗 `.lc-month-pop` | 月份胶囊点击 | 年切换 + 12 月宫格（当前月高亮），选后按方向滑动切换 |
| 场次详情弹窗 `.lc-dlg` | 直播日历格子**点击** | 见 B3（含分类校正下拉、词云、动态、分析预留） |
| 分类校正下拉 `.lc-dlg-cat-pop` | 详情弹窗左上角胶囊 | 见 B3；点外部关闭 |

### E1. 添加 V 浮窗 `.av-dialog`（R11，2026-09-15，devlog/083）

侧栏「+」浮片打开。**两个来源、触发方式刻意不同**（决策①）：

| 区域 | 类名 | 触发 | 打上游？ |
|---|---|---|---|
| 输入框（左内嵌放大镜 + 右清空钮 + 右侧触发钮） | `.av-search-row` / `.av-input-wrap` / `.av-input` / `.av-clear` / `.av-bili-btn` | 输入防抖 250ms 搜本地；**回车 / 点按钮**搜 B 站 | 本地：否 · B 站：是（预算 0.8s 串行 + 20 次/分 + 5 分钟缓存 + 最多 3 页；**需要 B 站登录态**，未登录回 `not_logged_in` + 提示） |
| 结果区（`OverlayScroll`） | `.av-list`（= `.os-root`）/ `.av-row` | 点行 = 直接收录（决策②，不插预览卡） | 收录后后台抓该 V |

行内元素：`.av-ava`（30px 圆头像，无图 → `.av-ava-ph` 首字）、`.av-name-text`（省略号截断）、
`.av-tag`（「按 UID 精确」）、`.av-origin`（来源徽标：`.o-pool` 候选池 / `.o-index` 索引 /
`.o-bilibili` B 站）、`.av-verified`（认证说明）、`.av-num`（粉丝数 / UID）、`.av-live`（直播中）、
`.av-state`（「已订阅」/「不在候选池」）。提示与错误走 `.av-hint-row`（上游失败加 `.err` 变红 +
原样展示后端 `hint`）。

**来源 → 收录路径**（2026-09-15 修，devlog/083 §十一）—— 行上带 `data-origin` 与
`data-adopt-source` 供探针断言：

| 来源 | `adoptSource` | 能否点 |
|---|---|---|
| 候选池（`vtubers.csv`） | `pool` | ✅ 池内路径，名称以池为准 |
| 索引（`thirdparty_vtubers`）+ bilibili | **`bilibili`** | ✅ 池外通道：后端实查 `acc/info` 复核后建库（索引覆盖"池快照之后的新 V"，这些 uid **不在 csv 里**） |
| 索引 + 其它平台 | `pool` | ❌ 置灰「不在候选池」+ `title` 说明（只有 B 站能按 uid 池外复核） |

> ⚠️ **索引来源绝不能标成 `pool`**：后端 `find_in_pool` 会 miss → 点一下就是红字
> 「候选池中不存在该 platform_uid」。这类错法界面上完全正常，只能靠探针 `--add-v`
> 的 `index + pool + 可点` 计数（必须 0）拦住。

三条**不能改**的界面约定（探针 `--add-v` 逐条断言）：
1. 纯数字 ≥5 位 = **UID 直查**，按钮文案换成「按 UID 添加」（B 站搜索接口搜不到 uid）；
2. `in_library=true` 的行**置灰 + `disabled`**（本地命中一律可点，后端已剔除已入库）；
3. 敲键**只打本地** `/vtuber/pool/search`，`/vtuber/bili/search` 必须 0 次。

> ⚠️ 结果区必须是 `OverlayScroll`（`.av-list.os-root > .os-scroll`）：全站约定不出现原生滚动条，
> 旧版的 `overflow-y-auto` 正是被这一条取代的（探针会报「结果区不是覆盖式滚动条」）。

---

## F. 滚动条标准（2026-09-07 用户定案，2026-09-09 修订——所有滚动容器一律参照）

> 用户原话要点：所有地方统一成一个样式；**滚动条不要占布局宽度**；**不滚动或不 hover 时自动隐藏**；
> 具体数值定案：**thumb 贴容器右缘 4px、宽 4px、常态 `--c-border` 细灰、圆角胶囊**；
> **2026-09-09 修订**：粉只属于「指针」——**滚轮滚动时保持浅灰**，只有**指针压在拇指上（:hover）
> 或拖拽中（`.os-drag`）**才变粉并加粗到 6px（原 `.os-root:hover` 在「指针必然在容器内」的滚动
> 场景下也会变粉，与「滚动时浅灰」相悖）；同时新增**指针靠近右缘 18px 内亮出拇指**——
> 否则滚完 700ms 就淡出，「hover 变粉」几乎够不着。
> 以后新增滚动容器必须查询本节。

### F1. 两层实现

| 层 | 实现 | 适用范围 |
|---|---|---|
| **全局原生兜底** | `::-webkit-scrollbar`（layout.css 顶部）：槽 **12px**、thumb `border:4px transparent` + `background-clip:content-box`（视觉 4px）、常态 `--c-border`、**指针压在滑块上**收窄到 2px（视觉 8px）+ `--c-primary`、轨道/角透明 | 任何**未接入 OverlayScroll 的残留原生滚动**（如有则应视为待迁移项） |
| **覆盖式滚动条（标准主形态）** | `<OverlayScroll>` 组件（components/OverlayScroll.tsx + **`status-island.css` `.os-*`**；R38 批 5e 从 `layout.css` 搬来） | 全部主滚动容器（见 F3 清单）。⚠️ 搬家改变了**加载顺序** ⇒ 见 F2 末条 |

> ⚠️ **禁则**：`scrollbar-width` / `scrollbar-color` 标准属性会在 Chromium 里令 `::-webkit-scrollbar` 全部失效（回退系统默认带箭头滚动条）——全项目已无此属性（`.os-scroll` 与 `.sidebar`/`.lc-stats` 的 `scrollbar-width:none` 是**隐藏**用，配 webkit display:none 双保险，属有意为之）。

### F2. OverlayScroll 组件规格

- 根 `.os-root`：`position:relative;overflow:hidden;display:flex;flex-direction:column`（**经典 modal 滚动模式**：max-height 容器的 auto 高度根也能正确产生内部滚动——`height:100%` 在 auto 父级下失效，曾致详情弹窗滚不动）；
- 滚动体 `.os-scroll`：`flex:1 1 auto;min-height:0;overflow-y:auto` + 原生条隐藏；**padding/gap/列布局一律由调用方写在 `.os-scroll` 上**（根不再承担排版）;
- 拇指 `.os-thumb`：absolute right 4px、宽 4px、min-height 28px、r999、`--c-border`、`opacity 0`（`.os-show` 时 1）、`transition opacity .25s / width .15s / background .15s`；**指针策略**：基态 `pointer-events:none`（未显示对内容零打扰），`.os-show` 后 `pointer-events:auto` + `cursor:grab`（拖动中 `grabbing`）+ `touch-action:none`；
- **变粉条件（2026-09-09 修订）**：`.os-thumb.os-show:hover, .os-thumb.os-show.os-drag` → 变粉 `--c-primary` + 加粗至 6px（right 同步收至 3px 保持中心对齐）——与全局 webkit 兜底的 hover 收缩内收增粗同语义。**滚轮滚动时保持浅灰**（`.os-root:hover` 不再触发）；`.os-drag` 由组件在 `onThumbDown` 加、`endDrag` 去，保证拖拽中即便指针滑出拇指也维持粉色。显隐仍由 `.os-show` 调度（滚动后 700ms / 悬浮 1.2s / **指针进入右缘 18px 槽区** 1.2s）；
- **拇指拖拽（2026-09-07 robust 版）**：按下 = `setPointerCapture` + 记录 `grabY`（指针相对拇指顶偏移），移动 = **绝对反解** `scrollTop`（非增量累加，天然消除 clamp 累积误差）；结束 = **四重兜底**：`pointerup` / `pointercancel` / `lostpointercapture` / **window `blur`**（覆盖拖出窗口、alt-tab、弹层拦截、捕获丢失全部路径），结束**无条件** `reveal(700)` 重排隐藏；拖拽期间 onScroll 仅 sync 不 reveal（停顿也不隐藏，收尾交给 endDrag）——历史上「拖拽中被 pointer capture 丢失楔死 → 永不隐藏」的 bug 即由此根治，因此当前显隐是"无抑制位"的纯调度 + 拖拽只是幂等叠加；
- 显隐调度（无任何可楔死的状态位）：滚动中亮出、停止 **700ms** 淡出；鼠标悬浮容器亮出、**1.2s** 无动作淡出；移出立即淡出；所有隐藏定时器无条件执行；
- 状态同步 `sync()`（只改位置/尺寸/display，不碰显隐）：scroll（rAF）/ ResizeObserver（滚动体 + **首个子元素**——scrollHeight 增长不触发自身 RO）/ **400ms 轮询兜底**（异步内容长高）；
- 布局要求：若用「根百分高度 + 滚动体内部滚动」，父级必须是 flex column 或明确高度，否则滚动失效（`.lc-dlg`/`.archive-view` 均按此约定）；
- 调用面：`className`（根）/ `style` / `role` / `aria-modal` / `scrollRef`（内部滚动体 ref，**须为可写 `{current: HTMLDivElement|null}`**——React19 类型下 `useRef<HTMLDivElement>(null)` 的 RefObject 是只读 readonly）/ `onScroll`。
- ⚠️ **消费者想覆盖基类设过的属性（`position`/`display`/`overflow`/`flex-direction`）必须用两个类**（`.os-root.lc-pop`，见 **F3** 的 `.lc-pop` 行）：基类 `.os-root` 是**单类**选择器，与消费者的单类规则**优先级相同** ⇒ 胜负只由**样式表加载顺序**决定，而 `.os-*` 现住 `status-island.css`（**R38 批 5e 从 `layout.css` 搬来**，`App.tsx` 里在 `posts.css` 之后加载）⇒ 搬完之后**后加载者胜**。历史事故：`.lc-pop { position: fixed }` 被 `.os-root { position: relative }` 压掉，hover 浮窗掉进 `body` 文档流、落在视口外**完全不显示**（devlog/186 §八）。**判据**：`python scripts/ui_probe.py --cell-pop`（既判计算 `position` 是 `fixed`，也判矩形在视口内且命中测试命中自己）。

### F3. 现役滚动容器清单

| 容器 | 实现 | 备注 |
|---|---|---|
| list 视图帖子流 `.list-scroll` | ✅ OverlayScroll | 滚动体列布局/居中/padding 8px 16px 24px；`onScroll` 驱动回顶浮钮 |
| archive 视图 `.archive-view` | ✅ OverlayScroll | 数据视图 + PostsPage archive 外包共用同一容器（2026-09-07 视图级修复） |
| 档案视图 `.board-view` | ✅ OverlayScroll | R37-P1 起与 archive 同构（视图级滚动） |
| 档案卡/账号卡内 `.archive-section-scroll` | ✅ OverlayScroll | 负 margin 由滚动体承担（贴卡片缘） |
| 详情弹窗 `.lc-dlg` | ✅ OverlayScroll | 弹窗滚动 |
| 场次浮层 `.lc-pop` | ✅ OverlayScroll | 浮层滚动（max-height 430）。⚠️ 选择器必须是 **`.os-root.lc-pop`（两个类）**：`position:fixed` 要压过基类的 `position:relative`，而两者同为单类同优先级 ⇒ 单类写法靠加载顺序赢，会被任何一次样式搬家打碎（2026-09-24 实际发生过，devlog/186 §八）。护栏 `ui_probe --cell-pop` |
| 帖子详情窗口 `.post-detail-scroll` | ✅ OverlayScroll | **2026-09-07 补漏（二级界面审查 C11）**：根 max-h 90vh、滚动体 padding 20px |
| 侧栏 `.sidebar-list` | ✅ OverlayScroll | **2026-09-07 迁移完成**（旧 `.sidebar-sb` 5px 蓝灰自绘条已删） |
| `.type-chips`（横向溢出） | 🔶 原生隐藏 | `scrollbar-width:none` + webkit display:none（不占布局高度，纯滚轮横滚） |
| `.lc-stats`（类型统计横向溢出） | 🔶 原生隐藏 | 同上（纯滚轮横滚无指示，知悉即可） |
| `.lc-dlg-cat-pop`（分类下拉） | 🔶 原生隐藏 | 同 `.type-chips` 口径（内容恒 ≤340px，异常溢出仅滚轮） |
| `.profile-setting`（设定集正文） | 🔶 全局 webkit | 200px 高局部滚动，全局样式兜底可接受 |

---

## 设计迭代速查（本会话沉淀）

- 设计稿代码为**参考规格**，落地以 tokens/layout 为准；「微调」直接口播，无需回设计工具
- 浮动小元件（浮片/光条/药丸）豁免全局方形规则；交互态统一「无描边、背景填充」语言
- 图标一律 lucide（视觉尺寸按设计稿实测覆盖 className），自定义图形进 `assets/icons/`
- 窗口美学：DWM 系统圆角/阴影已关闭，只有前端 4px 一套弧线
- **滚动条**：见 F 节——新增滚动容器先问「是否主滚动容器、能否 OverlayScroll」，数值询问用户
- **图表**：图表一律 ECharts 6.1 按需注册（canvas 自绘），Shadcn Chart/recharts 已退役（chart.tsx/`--chart-*` 已清）；**图表色值集中在 `utils/chartTheme.ts`**（tokens 同源注释），新图表从那里引色，禁止在组件里手写色值
- **词云**：增量摊铺加权 Voronoi 拼贴（`utils/wordCloudLayout.ts`：力导向站点滑动 + λ 面积精确）；react-wordcloud 已退役（其 d3 依赖已随移除）
