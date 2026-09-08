# UI 设计映射文档（UI-MAP）

> 修改前端界面时，按本文档名称精确指定目标区域/元素。
> 结构约定：`组件文件 → CSS 类名 → 关键子元素`。设计令牌统一在 `src/styles/tokens.css`（唯一真源，
> 本文档数值以 tokens.css 与各 css 文件实际声明为准）。
>
> 设计语言总纲：**方形极简 + 全平面零阴影**（shadcn `--radius:0rem`、`--shadow-card:none`）。
> 圆角/阴影豁免收敛为三族（其余一律回方形总纲）：
> ① 列表工具行「浮片」：斜切白卡（`--pill-radius:3px` + `--pill-skew:-10deg` + `--pill-shadow`）；
> ② 帖子面板「药丸族」：`type-chip` / `.search-float input` / `post-card-type`/`post-card-duration` 角标 / `stat-badge` / `glow-bar`（均 999px 或渐变软光）；
> ③ 功能性气泡：`live-tag`（8px）、粉丝 `stat-pill`（2px 图像底）、筛选/时间 popover 抽屉阴影（16px 浮置深度）。
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
| 最大化 | `html.window-maximized` 类 | 壳层圆角归零（App.tsx `useMaximizedClass` 监听 `onResized`） |
| 应用图标 | `scripts/make_icons.py` → `frontend/src-tauri/icons/` | **2026-09-09 重做（任务栏图标模糊）**：矢量源 `docs/design/svg/LOGO.svg`；`icon.ico` **目录首项 = 48px 简化加粗版**（tauri-codegen 取 `entries()[0]` 当 `default_window_icon` → tao 设为 `ICON_SMALL` → Win11 任务栏就是它；旧文件首项是 16×16，被放大到 24/36px 才糊）；≥64px 按设计稿 stroke 7.5，≤48px 简化（仅头部轮廓 + 圆点眼）并按尺寸补偿描边；详见 `scripts/make_icons.py` 头注释 |
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
| 状态行 | `.topbar-status` | 绝对居中；**浮片材质 + 全圆角胶囊**（2026-09-09 用户三次定调：浅粉底玻璃胶囊 → 斜切浮片 → **全圆角胶囊**）：白底 `--pill-bg` + 浮片阴影 `--pill-shadow` + 全圆角 999px（无斜切、无玻璃、无外发光）；高 `--pill-h-sm`(25px) / padding `0 12px` / **12px `--pill-fg`**（白底 ≈8.6:1）+ tabular-nums；`max-width:46%` + `overflow:hidden`，超长文案省略号落在内层 `.pill-text-fade` |
| ├ 抓取中 | `.topbar-status-spinner`（lucide `Loader2` 14px 旋转） | 2026-09-09 换：原设计稿图标 `Frame_41_8.svg` 是白色填充，在浅粉胶囊/白浮片上等于隐形；lucide 走 `currentColor` 继承 `--pill-fg`，资源已删 |
| ├ 空闲 | i `.topbar-status-dot`（绿 `#52c41a` 7px） | |
| └ 成功覆盖态 | `.topbar-status-dot.ok`（深玫 `#a83a5e`）| pill-message 覆盖窗，4s 还原 |
| 弹性空隙 | `.topbar-spacer` | 推到右侧 |
| 窗口控制组 | `.topbar-window-controls` | **三格 46×40 通栏贴合**，无间距无右缘留白 |
| ├ 最小化 | `.topbar-win-btn`（lucide `Minus` 30px） | 原生 `minimize()` |
| ├ 最大化/还原 | `.topbar-win-btn`（`Square`/`Copy` 20px） | `toggleMaximize()`；`onResized→isMaximized` 同步图标；title 切换「最大化/还原」 |
| └ 关闭 | `.topbar-win-btn.close`（`X` 30px） | busy 时 AlertDialog 二次确认；hover **酒红 `#8e2334`** |
| 普通钮 hover | `.topbar-win-btn` | **浅粉 `#ffbccb`** |
| 登录入口 | `.topbar-login-btn`（`LogIn` 16px） | 与窗口钮同规格 46×40；B站会话过期时右上角 8px 红点徽章（`.topbar-login-badge`）；打开 `<LoginDialog>` |

### A2. 工具图标栏 `<IconRail>`（components/IconRail.tsx）

> 视觉按 `docs/design/react-IconRail` 导出（Frame4172），**50px 紧凑栏**（原 79 栏 ×0.63 取整）。

| 名称 | 类名 | 说明 |
|---|---|---|
| 图标栏 | `.icon-rail` | 宽 `--rail-width:50px`，底色 `--c-rail:#4b5a6f` |
| 顶部组 | `.icon-rail-group`（首）÷ spacer | 功能入口 |
| 底部组 | `.icon-rail-spacer` + `.icon-rail-group`（尾） | 贴栏底 |
| 单元格 | `.icon-rail-btn` | **通栏 50×50** 贴合；未选中整钮 `opacity:.6`，hover `.85` |
| 选中单元格 | `.icon-rail-btn.active` | **实底 `--c-rail-active-bg:#647489` + 全亮** |
| 图标 | 顶部组按序：`FileText`(14×18)/`User`(18×20)/`CalendarDays`(20×20)；底部：`RotateCw`(19×19)/`Settings`(22×22) | 视觉尺寸对应设计稿 ×0.63 取整 |

接线语义：**仅「帖子」`FileText` 接线**（`navigate('/')` + 路由高亮：`/` 或 `/vtubers/:id` 均点亮）。**2026-09-08 用户：其余四枚未接线占位（用户 / 日历 / 刷新 / 设置）已删除**——避免点了没反应的假入口，功能落地时再加回。

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

| 名称 | 类名 | 说明 |
|---|---|---|
| 面板 | `.posts-panel` | `height:100%`，flex column，`overflow:hidden`（裁剪模糊边界） |
| 背景层 | `.hero-backdrop(.custom)` | 常驻：**自定义背景优先**（`background_path` → `/static/custom_bg/...`，`.custom` 全图清晰 opacity 1），否则头像铺底（0.18+纱罩）；纱罩 ::after 保可读；`key=src` 换装淡入 |
| 工具条 | `.view-toolbar` | **高 66px、`padding:0`、贴面板顶居中**，仅视图光条；卡片页右上角挂 `.bg-tools`（ImagePlus 上传/更换浮片，**默认隐藏**，悬停工具行浮现、移出 900ms 渐隐；无清除钮） |

**光条视图切换**
| 名称 | 类名 | 说明 |
|---|---|---|
| 光条 | `.glow-bar` | 443px 白色渐变(`rgba(255,255,255,.68)` 中心)矩形胶囊 |
| 视图钮 | `.view-btn.on/.off` | 四枚、**同级视图**（2026-09-08 用户定序 + 删除未接线的邮件占位钮）：**卡片(`LayoutGrid`)→`setView('cards')`** / **列表(`AlignJustify`)→`setView('list')`** / **档案(`BarChart3`)→`setView('archive')`** / **档案卡(`Fingerprint`)→`setView('profile')`**（P7 追加）；on=.8 off=.4，激活跟随 `view` |

**cards 视图（展示页 / 默认）**
| 名称 | 类名 | 说明 |
|---|---|---|
| 滚动层 | `.hero-scroll` | **OverlayScroll**（2026-09-08 起，原 `overflow-y:auto` 原生条会导致窗口右缘出现滚动条 + 内容宽度跳 12px）：`flex:1;min-height:0`，内层 `.os-scroll` column 居中，gap 20，padding `0 0 134px`（底部留白 134px；设计稿 70px 侧距被无收缩子元素溢出抵消，故无左右 padding） |
| Hero | `.hero` | column 居中，`width:100%`，padding `23px 15px 0`，gap 10 |
| 头像 | shadcn Avatar `.hero-avatar` | **179×179**，`filter: drop-shadow(0 0 2px rgba(0,0,0,.98))`；取 `vtuber.avatar`（VTuber 本体，**稳定，不随账号切换变化**），回退所选账号头像 |
| 直播徽标 | `.live-tag`（内 `i.live-dot` 6px） | **23px 高、8px 圆角**、红边红底胶囊（`live`）/灰边灰字（`off`）+ `live_title`（14px/字距3px）；数据源=本页 `vtuber` 的 bilibili 账号（`account-progress` 增量合并，与左栏同源） |
| 名字 | `.hero-name` | **57px/500 黑 + 投影(0 2px 4px 黑25%)**；hero-name-block 高 110 |
| 签名 | `.hero-sign` | **25px/600** `rgba(94,94,94,.76)` 字距3px（30px 行高盒）；走 **VTuber 整体事实**（B站优先账号，无 B站取首个），不跟随 list 所选账号（2026-09-05 视图隔离） |
| 平台药丸行 | `.stat-sets`（key=vtuber.id 触发重播） | 集内 gap10、集间 gap10，每组至多 3 枚（`pillSets` 每 3 枚切分） |
| ├ 药丸 | `.stat-pill.image/.pink/.coral` | **191×37**，**2px 圆角** + `1px 2px 4px rgba(15,23,42,.12)` 阴影；**图像底**（`docs/design/pills` → `src/assets/pills/`，bilibili/weibo 全不透明同规格，`100% 100%` 铺满），未知平台奇偶交替 `--pill-fill-pink #e35d8b` / `--pill-fill-coral #e05261`（白字 26px 对比 ≥3.4:1） |
| ├ 平台LOGO占位 | `.pill-logo` | 28×28、**6px 圆角**、半透明白块 + 平台首字母（后续换图） |
| └ 数值 | `.pill-value` | **26px/600 白**，**右对齐**（`.stat-pill justify-content:flex-end`，右 padding 12px），数字 ≤4 位（`formatCount` 收紧）+ **`text-shadow 0 1px 2px rgba(0,0,0,.35)`** 保图像底可读 |
| 饰条 | `.hero-divider` | 394×24 设计稿 SVG |
| 企划行 | `.faction-badge`（内 `.pill-logo`「企」） | 37px 高、2px 圆角、同款阴影、**#fc7079 实底** + 20px/600 白字；`vtuber.faction` 非空才渲染；外链徽标待数据模型 |

**list 视图（帖子列表页）**
| 名称 | 类名 | 说明 |
|---|---|---|
| 筛选条 | `.chips-bar`(+`.chips-bar-inner`) | **固定顶不随帖子流滚动**（提取自滚动区，天然分隔操作钮行与滚动区），`max-width:900px` 与列表同轴居中，padding `10px 16px 8px`；`.type-chips` 出血补丁保留 |
| 滚动层 | `<OverlayScroll className="list-scroll">` | **根** = `flex:1;min-height:0`（滚动体 `.list-scroll .os-scroll` 接管布局：列布局/居中/gap 14/padding `8px 16px 24px`——顶部 8px 防卡片网格阴影被裁切） |
| 内容箍 | `.list-inner` | **列宽契约（列表页唯一权威）**：`width:100%; max-width:900px; align-items:stretch` 居中，column gap14。⚠️ 选择器必须是**后代** `.list-scroll .list-inner`——OverlayScroll 在中间插了一层 `.os-scroll`，写成直系子（`.list-scroll > .list-inner`）整条规则会静默失效，列宽退化成「内容宽度」：短标题页整列缩到 566px 居中、含长不可断行串的页整列被撑到 1350px 并左右溢出（封面被左缘裁切、日期推出窗口）。`scripts/ui_probe.py` 已固化该契约断言 |
| 操作按钮组 | `.header-actions` | **仅列表视图**渲染（卡片页纯展示无此行）：行首账号切换器（`margin-right:auto`）+ 右侧可收起浮片组——收起态 `[`.actions-toggle`][更新动态`.on`]`；展开态向左滑出 抓取账号/抓取帖子/添加账号/解除订阅（红），`actions-toggle` 被挤至最左、图标旋转 180° 变收起钮；`.actions-extra` 用 max-width 0→480px + opacity + translateX 动画（320ms cubic-bezier），`margin-left:-8px` 抵消父 gap |
| 筛选行 | `.type-chips-row` | chips 左 + 搜索/时间浮片右；`nowrap`（工具区永不掉行） |
| 类型chips | `.type-chip(.active)` | **分组**：投稿=video+video_dynamic、图文=image+text（key 逗号串直传后端 `in_` 过滤），转发/专栏/音乐/直播单型；计数 `stats.by_type` 求和、零组不显示；超宽时 `.type-chips` 行内横滚兜底（⚠️ 横向滚动条为全局 webkit 样式，见 F 节） |
| 搜索/时间 | `.chips-tools`(`flex-shrink:0`) | 搜索浮片 **190×30**（300ms 防抖）+ 时间范围下拉（date_from/to，止=次日零点排他） |
| 已删筛选 | `.del-btn`（Ghost + 计数） | 独立 toggle（与归档/类型正交），激活走 `.float-pill.on` 强调色 |
| 帖子流 | `.post-grid(.is-refetching)` | 重取时旧内容降透明禁点击，无整屏闪动 |
| 卡片 | `<PostCard>` `article.post-card` | **浮片化特例**：白底、2px 圆角 + `var(--pill-shadow)`、去发丝边；hover 上浮 2px + 阴影加深 + **标题变色 `--c-accent`** |
| ├ 封面 | `.post-card-cover` 220×16:10；SmartImage 三态兜底 | 有封面=图；**无封面（纯文字）= `.post-card-cover-paper` 米白纸纹斜条底 + 居中大标题（`.paper-title` 4 行截断）**；类型角标/时长角标浮于其上 |
| ├ 标题/摘要 | `.post-card-title/.summary` | 两行截断；`overflow-wrap:anywhere`——连续「！！！」或长链接这类不可断行串允许任意处折行后再截断，不横向裁掉半个字 |
| └ 底行 | `.post-card-footer`：徽章 `.stat-badge`×n + 日期 | 播/赞/评/转；正文 `.post-card-body` 带 `min-width:0`（解除 flex 自动最小尺寸，长串不再把日期挤出卡片） |
| 无限滚动 | `.load-sentinel` + IntersectionObserver | **不分页懒加载**：哨兵 1px（root=`list-scroll`，rootMargin 600px 预载）命中且 `hasMore=posts.length<total` 时 `page+1` 追加；`page===1` 走替换（整表 + is-refetching 变暗 + grid key 按替换型指纹重挂动画），`page>1` 走追加（按 id 去重拼接、不动 key 不重挂旧卡片）；追加失败 `loadMoreError` 尾条手动重试；到底显示 `.load-end`「已经到底啦」 |
| 回顶浮钮 | `.back-to-top` | **44×44 圆形白卡**（right 18 / bottom 18，`--pill-shadow`），滚动 >400px 浮现（`.on`），点击平滑回顶；hover 图标变粉 |
| 占位/错误 | `.posts-placeholder` / Alert(destructive) | 加载 Spin / 空列表 / 失败 |

**archive 视图（档案 / v0.9.x 重建后形态：仅两张 870 定宽卡片纵向排列）**
> 🔴 **2026-09-06 重建已删**：`.archive-grid-top` 双列布局、**重要日期卡**（UpcomingEventsCard / `.event-*`）与 profile 视图里的旧档案卡布局全部退役——当前 archive = 直播日历卡 + 粉丝趋势卡（均 870px 定宽、恒高、卡片自治，不共用列表操作钮行）。
> 后端 `GET /vtuber/{id}/events`、`future-reservations` 端点仍在，前端 `api.listVtuberEvents/createVtuberEvent/deleteVtuberEvent/futureReservations` 为**未接线封装**（死代码，重做时可用）。

| 名称 | 类名 | 说明 |
|---|---|---|
| 视图容器 | `<OverlayScroll className="archive-view">` | **根** = `flex:1;min-height:0`；滚动体 `.archive-view .os-scroll` = column 居中 gap 14 padding `16px 20px 24px` |
| 直播日历 | `<LiveCalendar>` `.live-calendar` | **卡 870×631 · 4px 圆角 · `--pill-shadow`**（定宽上限 870：拉宽不变；恒高 631、不参与 column 压缩）。结构：标题行（`直播日历` 16.5/600 + 空月 note）→ 导航行（月 nav 浮片三连 + 当月类型统计胶囊）→ 星期表头 → 6 行 ×7 列月历。详见 B3 |
| 粉丝趋势 | `<FanTrendChart>` `.fan-chart` | **卡 870×460 · 4px 圆角 · `--pill-shadow`**；标题 16.5/600 同 `lc-title` 规格。**ECharts 6.1 架构**（canvas 全程自绘，React 只负责卡片壳与头部控制）。详见 B4 |

**profile 视图（P7 追加：档案卡详情视图）**
| 名称 | 类名 | 说明 |
|---|---|---|
| 视图容器 | `<ProfileView>` `<OverlayScroll className="archive-view">` | 同一 `.archive-view` 覆盖式滚动容器（滚动体布局同上） |
| 档案卡段 | `.archive-section`（含 `.archive-section-head`：标题 `档案` + note（第三方索引 N 项）+ `<AccountPicker>`） | 定宽契约：`max-width:960px;min-width:480px;height:460px;flex-shrink:0`，4px 圆角 + `--pill-shadow`；卡内滚动 = `<OverlayScroll className="archive-section-scroll">`（滚动体 padding `0 14px 6px`） |
| 账号抽屉段 | 同上骨架（标题 `账号` + note N 个账号） | `.profile-account-list` 全部平台账号：平台标（B站/微博）/昵称/粉丝/房间号/直播中徽章（红描边胶囊） |
| 内部档案卡 | `<ProfileCard>` `.profile-card*` | **企划｜公会 两列**（企划=Select 编辑，选项自动建议第三方索引 `group_name`，一键「采纳」写 `faction`；公会=只读占位「未收录」）+ 生日/出道日/房间号（跟随卡内所选账号，lucide 图标行）+ 设定集（Collapsible 折叠，`.profile-setting` 200px 内滚动） |

**联动刷新（跨组件事件）**
| 事件 | 触发方 | 消费方 |
|---|---|---|
| `ddtoolkit:fetch-idle` | TopBar 轮询 running→idle 边沿 | VtuberSidebar 刷列表；PostsPage `refreshTick`（重拉 vtuber 本体+统计+帖子；`selectedAccount` 按 uid 取新引用） |
| `ddtoolkit:account-progress` | TopBar 快照增量（**内容 diff 而非长度增量**，2026-09-07 修复环形上限/清空丢事件） | VtuberSidebar `mergeSnapshots` 就地合并（`utils/accountSnapshots.ts` 共享实现） |
| `ddtoolkit:data-changed` | 添加/解除订阅成功 | VtuberSidebar 刷列表 |
| `ddtoolkit:kick-poll` | 各操作按钮 | TopBar 立即轮询一次（防单V抓取快速完成漏边沿） |
| `ddtoolkit:pill-message` | 抓取/更新完成 | TopBar 状态胶囊覆盖显示 4s |

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

点击**日期格**打开（hover 浮层保持纯信息展示不动）——portal 到 body 的独立居中弹窗。

| 区域 | 类名 | 说明 |
|---|---|---|
| 遮罩 | `.lc-dlg-backdrop` | fixed inset 0、z-60、`rgba(15,23,42,.32)`、淡入 0.18s；点击空白（target===currentTarget）关闭；打开期间锁 body 滚动 |
| 面板根 | `<div className="lc-dlg" role="dialog" aria-modal>`（**面板=头部驻留区 + 内容滚动体**，2026-09-07 user 定案） | **720px**（`max-width calc(100vw-48px)`）、`max-height min(680px, calc(100vh-64px))`、**12px 圆角**、白底 + 发丝边 `--c-border` + `--shadow-dialog`；入场 pop 0.2s（translateY 8 + scale .98）；**头部驻留区** `.lc-dlg-head-zone`（flex:none · padding `16px 18px 12px` · 下缘发丝分隔）承担头部行+多场 tabs——不随内容滚动、滚动条不覆盖；**内容区** `<OverlayScroll className="lc-dlg-body">`（flex:1 min-height:0；滚动体 `.lc-dlg-body .os-scroll` column gap 12 / padding `12px 18px 18px` / overscroll-behavior contain） |
| 头部 | `.lc-dlg-head` | 左=**分类胶囊按钮**（点击弹全部分类下拉）+ 标题（15px/600 单行截断）+ 副行 `日期 HH:MM`（11.5px 次级）+「已校正」红字标（`category_from==='override'`）；右=关闭钮 26×26 r8 |
| 分类下拉 | `.lc-dlg-cat-pop` | 208px 宽、max-h 340、r12、`--shadow-dialog`；列表 = **自动（跟随推断）** 灰胶囊 + 9 类彩色胶囊（26px 高 r46，`.on` 内描边 2px 深灰）；选后 PUT/DELETE override 并重拉场次+详情；点外部关闭 |
| 多场切换 | `.lc-dlg-tabs` | 当日多场时显示：HH:MM 胶囊（r106），激活 = `--c-accent` 底白字 |
| 两栏主体 | `.lc-dlg-main` | grid `264px minmax(0,1fr)` gap 12 |
| 左封面 | `.lc-dlg-cover` | **264px · aspect-ratio 4/3**（danmakus 封面 720×540=4:3 与 704×396=16:9 混存，4:3 容器 + `object-fit:contain` 双全）；r10 截角；`ProxyImage`（`fallback` 槽位）三态：直连 CDN（normalizeImageUrl + `referrerPolicy=no-referrer`——裸 img 漏此曾 403；微博图床 sinaimg/wbcdn 起点即走代理）→ `/img-proxy` 后端代理 → `fallback` 渲染渐变底 + 首字大号占位（64px 粉 55% 透明）；左下状态徽章（已结束=黑玻璃 / 直播中=粉 `rgba(251,119,161,.92)`，r106） |
| 右直播信息 | `.lc-dlg-sec` + `.lc-dlg-rows` | r10 `#faf7f8` 区卡；行式 label(58px 次级) 左 · value 右；字段：时间（HH:MM–HH:MM + 时长）/ 分区 / 收益 ¥ / 峰值在线 / 弹幕数 / **A 组指标**（观看/点赞/打赏人数/互动/在线排名，来自 danmakus v2 live）/ 段数（>1 显示「N 段合并（中断续播）」）/ 数据源（danmakus+self+feed 组合） |
| 弹幕信息 | `.lc-dlg-sec--full` | 满宽区卡：弹幕总量（大数 600）+ 完整性提示（`metrics.is_full===false` 时「弹幕数据未全量（部分录制源）」）+ **增量摊铺拼贴词云**（`MosaicCloud`，参考图形态）；无数据=「暂无弹幕数据（danmakus 未收录该场次或拉取失败）」 |
| └ 词云 | `.lc-dlg-cloud` + svg | 高 **210px·宽度自适应**（ResizeObserver 实测内容区宽，user 2026-09-07：池子宽度不对→实测）；**增量摊铺加权 Voronoi 拼贴**（2026-09-07 user 定案）：power diagram λ 权重（面积∝词频）+ **力导向站点摊铺**（质量感 collide q=0.2、中心引力、矩形软墙，位置直推无速度积分）+ **逐个入池**（频次降序每 150ms 一个，站点=当前最大空腔）；**容器轮廓圆角**（roundedRectPolygon 16px 圆角边界）；全部入场后 alpha 冷却 → 静止即停 |
| └ 破泡 | `removeWord` + 局部松弛 | 点击词 → cell **立即消失**（纯同步删，无卡顿）→ **局部闭合**（node 验证：缺口处 2 词挤入、远处位移 avg 6.5px/max 16px、偏差 15%、单调 100%）：α=0.15 起步 + kCenter=0（力场几乎不动、停中心引力）——**λ 修正把缺口面积重新分配给相邻 cell**（power 边界"鼓胀"塞住缺口，站点只微挪）；远处纹丝不动；段头「已破泡 N · 恢复」胶囊一键还原 |
| └ 面积比例 | `utils/wordCloudLayout.ts` | 目标面积 = count 比例 **保底 0.05%**（画布 0.05%，小词仍可见分级）→ 归一化；**松弛手感**（user 定案 2026-09-07）：β=0.1（λ 面积修正慢速蠕动）+ α=0.994 慢冷却 + 碰撞质量感 q=0.2（大泡稳、小泡让）——node 验证：单调性 100%、终态偏差 2.01%、填满 100%、有效帧 <20ms |
| └ 词云配色 | `CLOUD_COLORS` | **浅色填充**（10 色浅粉系：#ffc9c4/#a5e6ff/#dccff7/#bee9ec/#ffd5b8/#fff2a0/#fda5ff/#b2f3c0/#ffdfe8/#d8e8ff）+ **同色系深字**（HSL 压暗同色相 L=0.28，`cloudWordText`）——user 2026-09-07：填充浅色、文字深色；白缝 `stroke=--c-bg-card` 2px；hover：当前格 1/其余 0.4；hover 提示 = 黑玻璃胶囊「词 · N 次」（`.lc-dlg-cloud-tip`） |
| └ 数据 | `detail.data.danmaku.top_words` | 后端 `LiveDanmakuInfo.top_words`（top40 带次数）；前 40 按 count 降序；无词=「暂无热词数据」 |
| 直播动态 | `.lc-dlg-evts` | 满宽区卡：**B 组事件**（type 7=直播中止·灰点 / 8=直播继续·粉点，`send_date` HH:MM）+ **A 组在线峰值高光**（`metrics.peaks` 前 3，「N 人在线」，金点）；空=「暂无动态数据」 |
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
| `--radius-card` / `--radius-sm` | 0 / 0 | 方形化 |
| `--shadow-card` | none | 全平面 |
| `--radius-dialog` / `--shadow-dialog` | 12px / 0 4px 16px rgba(15,23,42,.1) | **弹窗层**（二级界面：浮层/弹窗/查看器遮罩，v0.6.1 用户参考风格） |
| `--pill-fill-pink` / `--pill-fill-coral` | #e35d8b / #e05261 | 粉丝徽章色底（加深版：白字 26px 对比 2.5:1 → 3.4:1，**替代早期 #fb77a1/#fc7079 直接填充**） |
| `--radius-window` | 4px | L3 窗口圆角 |
| `--topbar-height` / `--rail-width` / `--sidebar-width` | 40px / 50px / 492px | 三段尺寸 |
| shadcn `--radius` | 0rem | 全家桶方形化（Button/Select/Dialog…；`sheet`/`toggle`/`toggle-group` 已于 2026-09 P0 清理删除）；**例外：`--radius-xl` = +12px**（2026-09-07 二级界面审查 A1）——`rounded-xl` 仅用于 Dialog/AlertDialog/SelectContent 面板，统一 12px 弹窗层 |

## C6. 二级界面统一规格（2026-09-07 审查定稿）

> 适用范围：一切 Dialog/AlertDialog/SelectContent（radix 注入面板）+ 自绘浮层（filter-pop/time-pop/lc-month-pop/lc-pop/lc-dlg/lc-dlg-cat-pop）+ 灯箱（ImageViewer 遮罩）。新写二级界面必须参照本节。

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
| filter-pop / time-pop | 12 | --c-border | — | ✓(0.16s) | ✓ | — | 粉底白字/描边 |
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
- 现役浮片：侧栏 ＋(50px)/拉取(44px)/过滤触发器(89px)、帖子页时间钮(md)/已删钮/背景工具组 `.bg-set`、header-actions 五钮、**日历月份导航三件套**——**2026-09 P1 起全部由 `<components/common/FloatPill.tsx>` 渲染**（原生 `<button class="float-pill …">`，配方仍在本节 layout.css；原 `.lc-nav-btn`/`.lc-nav-pill` 自绘副本已删）
- **禁用例**：搜索胶囊（侧栏 240×25、帖子页 190×30）为胶囊形遗留例外，不入体系；Hero `.stat-pill` 彩色统计胶囊属另一家族（2px 圆角图像底）

## C3. 独立筛选弹窗（layout.css `.filter-pop`）

- 入口：侧栏过滤触发器（`.filter-wrap` 锚定，点外关闭 + **Esc 双通道**（2026-09-07 二级界面审查），同 time-pop 模式；入场动画 lc-dlg-pop 0.16s）
- 三组多选 chip（`.filter-chip`，描边圆角、选中粉底，2026-09-05 弹窗层风格）：状态（直播中/未直播）、平台（accounts 动态提取）、企划（非空 faction 动态提取；语义沿革：阵营=企划=公会）
- 组合逻辑：组内 OR、组间 AND，空组不生效，即时生效无应用钮，底部「重置」
- 触发器反馈：任一筛选生效加 `.on`；展示文案暂占位「默认」待定

## C4. 条目入场动效（layout.css `.anim-rise`）

- 规格：`rise-in` 关键帧（opacity 0 + translateY 14px → 0），单项 320ms ease-out（cubic-bezier(0.22,1,0.36,1)），步进 45ms/项，CSS `min()` 封顶 400ms（第 10 项后不再追加），`fill-mode: both` 防闪现
- 用法：条目根元素挂 `anim-rise` + 内联 `--rise-i` 序号；列表容器以**内容标识 key** 整体重挂载触发重播
- 接入点：侧栏 VTuber 行（key=query+筛选+数据长度）、list 视图 `.post-grid`（key=账号+首末帖 id+数量——loading 期间 key 不变，保留旧内容降透明的无闪动重取）、Hero 平台药丸组（key=vtuber.id，切 V 重播）
- `prefers-reduced-motion: reduce` 下全量禁用

### 退场编排（退出 → 进入，预取门控 + 原子提交）

- `.scene-exit`（fall-out）：整块 `translateY(10px)` 下滑渐隐，**0.18s** ease-in（比 `EXIT_MS=200` 短 20ms，动画必在类移除前结束防竞态帧），`pointer-events:none` 防误点；与 rise-in 镜像闭合
- 机制：PostsPage 场景机 `scene{acc,view,exiting}` + **预取门控**——账号目标变化先并行预取三件套（getVtuber/第1页帖子/postStats），旧内容冻结可见；**数据就绪才退场**，EXIT_MS 后一次性应用预取数据（原子提交，页码归 1、**筛选按 VTuber/账号重置**——2026-09-05 用户反馈：筛选状态不跨 V/账号共享，提交时 filterRef 已是重置态与预取默认参数一致防种子错配），**全程无「正在加载」占位帧**
- 防重拉闪动：提交播种 `seededPostsKeyRef`（posts effect 消费一次跳过重拉）+ `vtuberLoadedRef`（跳过冗余 getVtuber）；refreshTick 变化仍正常重拉
- 应用：切 V、视图切换（视图切换无数据依赖立即退场；cards→list 首次帖子加载仍走正常 loading）；搜索/筛选/翻页仅重播入场不退场；**P6-1：筛选切换（type/搜索/时间/已删）立即滚回列表顶部**（触发即滚，不等重取；此前缓存恢复方案实测不达预期已 revert）
- 快速连点：中止旧预取、回退退场（旧内容回到可见冻结），新目标就绪后重来；加载占位仅存于首次进入/手动刷新/错误态；reduced-motion 动画禁用（200ms 延迟保留）
- 详情窗口动效（posts.css 末段）：居中 Dialog（P6-2 起）对齐全局运动语言——进场 260ms 淡入+scale(0.97) 缩入、退场 200ms 淡出+scale(0.97)（fall-out 同款 ease-in），遮罩与面板时长严格同步；覆盖 `[data-slot=dialog-content/overlay]` 的 animation-name/duration，radix animationend 卸载机制不受影响；reduced-motion 下 0.01ms 瞌时关闭
- **直播日历增补**（2026-09-07）：月份切换 = keyed 网格重放 `.lc-grid-anim`（前进右滑入 20px / 后退左滑入，0.26s cubic-bezier）；场次详情弹窗 = `.lc-dlg-pop`（translateY 8 + scale .98，0.2s）；月份浮窗 = 同款 pop；均带 reduced-motion 守卫

## C5. 三层组件契约（UI 几何统一基准）

| 层 | 语义 | 形态契约 | 成员 |
|---|---|---|---|
| **交互层** float-pill | 一切可点击触发 | 斜切(-10°)白卡 + 3px 圆角 + 阴影（唯一带阴影）；hover 渐灰；`.on` 主色填充；`.float-pill--danger` 红字 | 侧栏工具行、时间钮、bg-tools、**header-actions 五钮**（更新动态 `.on` 主操作、解除订阅 danger）、**日历月份导航三件套** |
| **信息层** flat-chip | 只读展示 | 平面 **3px、无阴影、不斜切**；色底（粉/珊瑚）或发丝边 | stat-pill（191×37 图像底/色底）、faction-badge（企划徽标，2px 圆角同族）、type-chip、stat-badge、post-card-type、live-tag（8px）、lc-stat-pill（类型统计胶囊 50×19 r88） |
| **弹窗层** dialogs | 弹窗/浮层（二级界面） | **圆角卡片 12px + 柔和阴影 `--shadow-dialog` (0 4px 16px 10%) + 发丝边**；分区标题 600 加粗 + 上方发丝分隔；选择控件描边 8px 圆角、激活=粉底(`--c-primary-deep`)白字；底部主操作=粉底圆角、次要=描边圆角 | 注入 Dialog/AlertDialog/Select 包裹层 + time-pop/filter-pop 自定义浮层 + **lc-pop 场次浮层 / lc-month-pop 月份浮窗 / lc-dlg 详情弹窗（14px）/ lc-dlg-cat-pop 分类下拉** |
| **表面层** surfaces | 卡片/面板 | **0px 方形** + 发丝边 | post-card（浮片化特例见下）、posts-panel、archive-section（4px 存档卡）、live-calendar/fan-chart（4px 定宽卡） |

**用户审美特例（覆盖统一基准，勿在后续回合误改回）**：
- `.live-tag`（卡片页直播徽标）圆角 **8px**
- `.type-chip`（列表帖子分类胶囊）**999px 全圆角 + `--pill-shadow` 浮片阴影**（无发丝边，hover 浮片灰底）
- `.stat-pill`（平台药丸）**图像底**（`docs/design/pills` → `src/assets/pills/`，按平台映射，未知平台回退粉/珊瑚色底）+ **2px 圆角 + `1px 2px 4px rgba(15,23,42,.12)` 阴影**，**全圆 logo 盒已移除**，仅粉丝数**靠右对齐、数字 ≤4 位**（`formatCount` 收紧）+ **`text-shadow 0 1px 2px rgba(0,0,0,.35)` 保图像底可读**；`.faction-badge` 同族 2px+同款阴影
- `.acc-switch-btn`（账号切换器）**浮片化**：白卡 + **2px 圆角 + `var(--pill-shadow)`、去发丝边**（不加斜切保文本可读）；`.on` 主色深填白字
- `post-card`（帖子卡片）**浮片化特例**：**2px 圆角 + `var(--pill-shadow)`、去发丝边**；hover 上浮 2px + 阴影加深 + **标题变色 `--c-accent`**；`.post-card-cover` 无封面时 `.post-card-cover-paper` 米白纸纹斜条 + 居中大标题

**豁免**：搜索胶囊（侧栏 `list-search`、帖子页 `.search-float`，用户指定原样）、滚动条圆头、头像与状态圆点（圆形）、**直播日历格 6px 圆角（设计稿规格保留）**、**详情弹窗 14px / 封面 10px（参考图规格）**。

## D. 字体（tokens.css @font-face，均为 woff2 子集化资源）

| family | 文件 | 用途 |
|---|---|---|
| `Alimama FangYuanTi VF`(100–900) | AlimamaFangYuanTiVF-VF.woff2 | 全局默认 `--font-family`（阿里妈妈官方许可：免费商用+嵌入式，见 LICENSE 声明）；**2026-09-09 起 `--font-title` 也指向它**（顶栏标题 15px 字距 5px）——原 `Noto Sans SC Title`（NotoSansSC-Title.woff2，仅含 "DDtoolkit" 的子集）已删除，全站只剩一款字体 |

## E. 交互浮窗清单

| 浮窗 | 入口 | 说明 |
|---|---|---|
| AlertDialog 关闭确认 | TopBar 关闭钮(busy) | 「抓取任务正在进行中」 |
| LoginDialog | TopBar 登录钮（`.topbar-login-btn` + 过期红点徽章） | B站/微博扫码登录（`/auth/weibo/qr/*`） |
| AddVtuberDialog | 侧栏「+」 | 输入防抖搜本地候选池 → 点选 adopt（建库+自动单V抓取）→ 踢poll + 侧栏刷新 + 右栏跳新V |
| BatchFetchDialog | 侧栏「拉取」 | 四项：全量账号 / 全量帖子 / 更新未归档 / 归档（前三项后台执行+409防重入，归档同步返回条数） |
| PostDetailDrawer | 帖子卡片 | 见 B2 |
| ImageViewer | 详情窗内图片 | 见 B2.1 |
| AlertDialog 解订阅 | list 视图红色钮 | 说明连带删帖，确认后跳首页 |
| 筛选弹窗 `.filter-pop` | 侧栏过滤触发器 | 见 C3（状态/平台/企划组合多选） |
| 时间范围浮窗 `.time-pop` | list 视图「时间」浮片 | 起/止 date 输入 + 清除/应用 |
| 场次浮层 `.lc-pop` | 直播日历格子 hover | 当日全量场次（起止/时长/收益/峰值/弹幕/数据源/中断段数），**纯信息展示**；120ms 宽限关闭、Esc 关闭（详见 B3） |
| 月份选择浮窗 `.lc-month-pop` | 月份胶囊点击 | 年切换 + 12 月宫格（当前月高亮），选后按方向滑动切换 |
| 场次详情弹窗 `.lc-dlg` | 直播日历格子**点击** | 见 B3（含分类校正下拉、词云、动态、分析预留） |
| 分类校正下拉 `.lc-dlg-cat-pop` | 详情弹窗左上角胶囊 | 见 B3；点外部关闭 |

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
| **覆盖式滚动条（标准主形态）** | `<OverlayScroll>` 组件（components/OverlayScroll.tsx + layout.css `.os-*`） | 全部主滚动容器（见 F3 清单） |

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

### F3. 现役滚动容器清单

| 容器 | 实现 | 备注 |
|---|---|---|
| list 视图帖子流 `.list-scroll` | ✅ OverlayScroll | 滚动体列布局/居中/padding 8px 16px 24px；`onScroll` 驱动回顶浮钮 |
| archive 视图 `.archive-view` | ✅ OverlayScroll | profile 视图 + PostsPage archive 外包共用同一容器（2026-09-07 视图级修复） |
| 档案卡/账号卡内 `.archive-section-scroll` | ✅ OverlayScroll | 负 margin 由滚动体承担（贴卡片缘） |
| 详情弹窗 `.lc-dlg` | ✅ OverlayScroll | 弹窗滚动 |
| 场次浮层 `.lc-pop` | ✅ OverlayScroll | 浮层滚动（max-height 430） |
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
