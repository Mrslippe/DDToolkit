# UI 设计映射文档（UI-MAP）

> 修改前端界面时，按本文档名称精确指定目标区域/元素。
> 结构约定：`组件文件 → CSS 类名 → 关键子元素`。设计令牌统一在 `src/styles/tokens.css`。
>
> 设计语言总纲：**方形极简 + 全平面零阴影**（shadcn `--radius:0rem`、`--shadow-card:none`）。
> 圆角/阴影豁免收敛为三族（其余一律回方形总纲）：
> ① 列表工具行「浮片」：斜切白卡（`--pill-radius:3px` + `--pill-skew:-10deg` + `--pill-shadow`）；
> ② 帖子面板「药丸族」：`type-chip` / `.search-float input` / `post-card-type`/`post-card-duration` 角标 / `stat-badge` / `glow-bar`（均 999px 或渐变软光）；
> ③ 功能性气泡：`live-tag`（8px）、粉丝 `stat-pill`（10px）、筛选/时间 popover 抽屉阴影（16px 浮置深度）。
>
> 对比度约定：顶栏「标题/状态/窗口图标」为**品牌装饰性白字**（保持设计稿原稿，logo 类豁免）；
> 功能性文字与数字一律达标（`--c-text-sub:#5b6c7e` ≥4.5:1、粉丝徽章 `--pill-fill-*` 白字 ≥3:1 大号数字）。

---

## 0. 启动链路与窗口（index.html + src/main.tsx + src-tauri lib.rs）

| 环节 | 实现 | 说明 |
|---|---|---|
| 首绘粉底 | `<head><style>html{background:#ffa2b4}` | HTML 解析即染粉，消除「白底窗口→透明轮廓」两个原生中间态 |
| 静态启动幕 | `#boot-splash`（纯内联样式） | 粉底 + 白底圆角 LOGO「D」+ 呼吸动画，不依赖 bundle |
| 启动诊断陷阱 | `#boot-diag`（`window.__bootLog` / `__bootFold`） | 捕获 `[error]/[resource]/[console.error]/[promise]` 四类，常驻右上角徽章，可展开/一键复制；React 就绪后自动折叠 |
| 全局右键禁用 | `document.addEventListener('contextmenu', preventDefault, true)` | 捕获阶段，覆盖一切渲染时序 |
| 窗口创建 | `visible:false`（tauri.conf） | 隐藏创建，杜绝原生空窗帧 |
| 显示链路 | main.tsx 模块顶层 `invoke('present_window')` | 应用自有命令绕开 capability（`allow-show` 缺失历史问题）；失败写诊断留痕 |
| 兜底显示 | lib.rs 8s 后台线程 `is_visible→show()` | 任何 JS 链路失败时窗口最迟 8s 出现（幂等，不重复） |
| 引导 | `tauriBootstrap()`：`get_backend_port` → `healthz` 轮询 → `setApiBase` | 就绪后进入 `opening` |
| 状态机 | `BootState: pending→opening→done/failed` | `ENVELOPE_MS=750` 信封动画播完卸载启动幕 |
| 窗口本体 | 1440×800 / 无框 / 透明 / L3 自绘圆角 | `--radius-window:4px`（Rust 侧已禁 DWM 阴影与系统圆角，只前端一套弧线） |
| 最大化 | `html.window-maximized` 类 | 壳层圆角归零（App.tsx `useMaximizedClass` 监听 `onResized`） |

---

## A. 应用壳层（App.tsx + styles/layout.css）

| 名称 | 组件 / 类名 | 说明 |
|---|---|---|
| 应用壳 | `.app-shell` | 纵向 + body 横向布局，4px 自绘圆角（透明窗内部裁剪，白圈已注释） |
| 主行 | `.app-body` | `flex:1; min-height:0` |
| 内容区 | `.app-main` | `padding:0; overflow:hidden`，滚动权交付页面内部（posts.css） |

### A1. 顶栏 `<TopBar>`（components/TopBar.tsx）

视觉严格按 `docs/design/react-topbar` 导出（Frame411）。整条 `data-tauri-drag-region` 拖拽区。

| 名称 | 类名 | 说明 |
|---|---|---|
| 顶部栏 | `.topbar` | 底色 `--c-primary`，高 `--topbar-height:40px` |
| LOGO 占位区 | `.topbar-logo-zone` | **96×69** 横跨全高，flex 居中 |
| LOGO 盒 | `.topbar-logo` | **44×44 纯白方形**，内部千图小兔体粉色粗体 D 26px（`--font-logo`） |
| 标题 | `.topbar-title` | 定宽 **219×69**，垂直居中/水平左对齐；字小魂锐艺黑 24px、字距 8px（`--font-title`）；`user-select:none` |
| 状态行 | `.topbar-status` | 绝对居中；**19px 白字**；`user-select:none` |
| ├ 抓取中 | `.topbar-status-spinner`（`Frame_41_8.svg` 旋转） | 替换旧黄点脉冲 |
| ├ 空闲 | i `.topbar-status-dot`（绿 `#52c41a`） | |
| └ 成功覆盖态 | `.topbar-status-dot.ok`（粉）| pill-message 覆盖窗，4s 还原 |
| 弹性空隙 | `.topbar-spacer` | 推到右侧 |
| 窗口控制组 | `.topbar-window-controls` | **三格 90×69 通栏贴合**，无间距无右缘留白 |
| ├ 最小化 | `.topbar-win-btn`（lucide `Minus` 30px） | 原生 `minimize()` |
| ├ 最大化/还原 | `.topbar-win-btn`（`Square`/`Copy` 20px） | `toggleMaximize()`；`onResized→isMaximized` 同步图标；title 切换「最大化/还原」 |
| └ 关闭 | `.topbar-win-btn.close`（`X` 30px） | busy 时 AlertDialog 二次确认；hover **酒红 `#8e2334`** |
| 普通钮 hover | `.topbar-win-btn` | **浅粉 `#ffbccb`** |

### A2. 工具图标栏 `<IconRail>`（components/IconRail.tsx）

视觉严格按 `docs/design/react-IconRail` 导出（Frame4172）。

| 名称 | 类名 | 说明 |
|---|---|---|
| 图标栏 | `.icon-rail` | 宽 `--rail-width:50px`，底色 `--c-rail:#4b5a6f` |
| 顶部组 | `.icon-rail-group`（首）÷ spacer | 功能入口 |
| 底部组 | `.icon-rail-spacer` + `.icon-rail-group`（尾） | 贴栏底 |
| 单元格 | `.icon-rail-btn` | **通栏 79×79** 贴合；未选中整钮 `opacity:.6`，hover `.85` |
| 选中单元格 | `.icon-rail-btn.active` | **实底 `--c-rail-active-bg:#647489` + 全亮** |
| 图标 | 顶部组按序：`FileText`(22×28)/`User`(29×31)/`CalendarDays`(31×31)；底部：`RotateCw`(30×30)/`Settings`(35×35) | 视觉尺寸对应设计稿实测 |

接线语义：**仅「帖子」`FileText` 接线**（`navigate('/')`，路由高亮恒亮）；其余四枚占位（tooltip「· 开发中」、`opacity` 走统一未选中语言）。

### A3. VTuber 左栏 `<VtuberSidebar>`（components/VtuberSidebar.tsx）

视觉按 `docs/design/react-VtuberSidebar`（Frame41109）与口播定案。

| 名称 | 类名 | 说明 |
|---|---|---|
| 外壳 | `.sidebar-shell` | 宽 `--sidebar-width:492px`，`position:relative`（承载悬浮滚动条） |
| 滚动容器 | `.sidebar` | `overflow-y:auto` + **原生滚动条隐藏**（`scrollbar-width:none` + webkit `display:none`），底 `--c-bg-list:#fffbfb` |

**工具行**
| 名称 | 类名 | 说明 |
|---|---|---|
| 工具行 | `.list-toolbar` | 高 51px，padding `10px 32px`，`justify-content:center`，「+」在最左，四件同容器居中 |
| 添加钮 | `.list-float .list-add-btn`（`Plus` 16px，25×25 浮片） | 打开 AddVtuberDialog |
| 搜索框 | `.list-search-wrap` 内 `.list-search` | **240×25 浮片**，放大镜 10×10 居左、placeholder 12px；`/` 键聚焦；focus 粉内描边 |

| 直播过滤 | shadcn `SelectTrigger.input list-filter-btn [&>svg]:size-2.5` | **89×25 浮片**；选项 全部/直播中/未直播（在线实时过滤） |
| 拉取键 | `.list-float .list-pull-btn`（`Download` 16px，44×25 浮片） | 打开 BatchFetchDialog |

**列表体**
| 名称 | 类名 | 说明 |
|---|---|---|
| 条目 | `.vtuber-item(.active)` | **76px 通栏**（`flex-shrink:0`），gap 12，左 padding 26px；hover 浅粉 `--sel-bg-hover` |
| 选中条 | `.vtuber-item.active::before` | **左缘 3px 粉竖条 `--sel-bar` + 浅粉底 `--sel-bg`** |
| 头像 | shadcn Avatar `size-[58px]` | 圆形，`resolveAsset(avatar_path) ?? avatar_url` |
| 名字 | `.vtuber-name` | **18px 纯黑 500**，`user-select:none` |
| 直播点/标签 | `.live-dot` / `.live-label` | 红 `--c-live`，仅直播中 |
| 签名 | `.vtuber-sign` | **13px 灰（13px 行高盒）**，`user-select:none` |
| 阵营槽 | `.vtuber-emblem` | 右侧 **54px 全高**，紧贴右缘；暂空置（预留图片资源） |
| 提示态 | `.sidebar-tip` | 加载失败 / 空池 / 无匹配文案 |

**自绘悬浮滚动条**
| 名称 | 类名 | 说明 |
|---|---|---|
| 轨道 | `.sidebar-sb` | 位于外壳（不随内容滚动）；`top:55px/bottom:4px/right:2px`，宽 5px |
| 拇指 | `.sidebar-sb-thumb(.on)` | 蓝灰半透明；滚动/拖拽浮现、**静止 900ms 渐隐**；可 pointer 拖拽；`flex-shrink` 无关——高度由 `useOverlayScrollbar` 计算（含内容比例、贴顶贴底校准） |

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
路由 `/vtubers/:id`。**三视图状态机**：`view: 'cards'|'list'|'archive'`（默认 `cards`），光条切换，数据共享不重取。视觉按 `docs/design/react-PostsPage`（Frame41301）。

| 名称 | 类名 | 说明 |
|---|---|---|
| 面板 | `.posts-panel` | `height:100%`，flex column，`overflow:hidden`（裁剪模糊边界） |
| 背景层 | `.hero-backdrop(.custom)` | 常驻：**自定义背景优先**（`background_path` → `/static/custom_bg/...`，`.custom` 全图清晰 opacity 1），否则头像铺底（0.18+纱罩）；纱罩 ::after 保可读；`key=src` 换装淡入 |
| 工具条 | `.view-toolbar` | 贴面板顶（`padding:0 16px`，**上方零缝隙**），仅视图光条；卡片页右上角挂 `.bg-tools`（ImagePlus 上传/更换浮片，**默认隐藏**，悬停工具行浮现、移出 900ms 渐隐；无清除钮） |

**光条视图切换**
| 名称 | 类名 | 说明 |
|---|---|---|
| 光条 | `.glow-bar` | 443px 白色渐变(`rgba(255,255,255,.68)` 中心)胶囊 |
| 视图钮 | `.view-btn.on/.off` | 四枚：**档案(`BarChart3`)→`setView('archive')`** / **卡片(`LayoutGrid`)→`setView('cards')`** / **列表(`AlignJustify`)→`setView('list')`** / 邮件(`Mail`)·占位；on=.8 off=.4，激活跟随 `view` |

**cards 视图（展示页 / 默认）**
| 名称 | 类名 | 说明 |
|---|---|---|
| 滚动层 | `.hero-scroll` | `overflow-y:auto`，padding `16px 70px 134px`，居中 |
| Hero | `.hero` | column 居中，max-width 869px |
| 头像 | shadcn Avatar `.hero-avatar` | **178×178**，`filter: drop-shadow(0 1px 8px rgba(0,0,0,.98))`；取 `vtuber.avatar`（VTuber 本体，**稳定，不随账号切换变化**），回退所选账号头像 |
| 直播徽标 | `.live-tag`（内 `i.live-dot` 6px） | 红边红底胶囊 + `live_title`（14px/字距3px） |
| 名字 | `.hero-name` | **57px 黑 + 投影(0 2 4 黑25%)** |
| 签名 | `.hero-sign` | **25px** `rgba(94,94,94,.76)` 600 字距3px |
| 平台药丸行 | `.stat-pills` | 数据驱动：每账号一枚 |
| ├ 药丸 | `.stat-pill.pink/.coral`（奇偶交替 `#fb77a1/#fc7079`） | **191×37**，r10，白边94% |
| ├ 平台LOGO占位 | `.pill-logo` | 28×28 半透明白块 + 平台首字母（后续换图） |
| └ 数值 | `.pill-value` | **26px 白 600**，`formatCount(followers_count)` |
| 饰条 | `.hero-divider` | 394px 渐变细线 |
| 阵营行 | `.faction-badge`（内 `.pill-logo`） | `vtuber.faction` 非空才渲染；外链徽标待数据模型 |

**list 视图（帖子列表页）**
| 名称 | 类名 | 说明 |
|---|---|---|
| 筛选条 | `.chips-bar`(+`.chips-bar-inner`) | **固定顶不随帖子流滚动**（提取自滚动区，天然分隔操作钮行与滚动区），`max-width:900px` 与列表同轴居中，padding `10px 16px 8px`；`.type-chips` 出血补丁保留 |
| 滚动层 | `.list-scroll` | `flex:1;min-height:0;overflow-y:auto`（view-body 改 flex column 后精确占剩余空间），padding `8px 16px 24px`（顶部 8px 防卡片网格阴影被 overflow-y 在 padding 缘切断） |
| 内容箍 | `.list-inner` | `max-width:900px` 居中，column gap14 |
| 操作按钮组 | `.header-actions` | **仅列表视图**渲染（卡片页纯展示无此行）：行首账号切换器（`margin-right:auto`）+ 右侧可收起浮片组——收起态 `[`.actions-toggle`][更新动态`.on`]`；展开态向左滑出 抓取账号/抓取帖子/添加账号/解除订阅（红），`actions-toggle` 被挤至最左、图标旋转 180° 变收起钮；`.actions-extra` 用 max-width 0→480px + opacity + translateX 动画（320ms cubic-bezier），`margin-left:-8px` 抵消父 gap |
| 筛选行 | `.type-chips-row` | chips 左 + 搜索/时间浮片右；`nowrap`（工具区永不掉行） |
| 类型chips | `.type-chip(.active)` | **分组**：投稿=video+video_dynamic、图文=image+text（key 逗号串直传后端 `in_` 过滤），转发/专栏/音乐/直播单型；计数 `stats.by_type` 求和、零组不显示；超宽时 `.type-chips` 行内横滚兜底 |
| 搜索/时间 | `.chips-tools`(`flex-shrink:0`) | 搜索浮片 300ms 防抖 + 时间范围下拉（date_from/to，止=次日零点排他） |
| 帖子流 | `.post-grid(.is-refetching)` | 重取时旧内容降透明禁点击，无整屏闪动 |
| 卡片 | `<PostCard>` `article.post-card` | **浮片化特例**：白底、2px 圆角 + `var(--pill-shadow)`、去发丝边；hover 上浮 2px + 阴影加深 + **标题变色 `--c-accent`** |
| ├ 封面 | `.post-card-cover` 220×16:10；SmartImage 三态兜底 | 有封面=图；**无封面（纯文字）= `.post-card-cover-paper` 米白纸纹斜条底 + 居中大标题（`.paper-title` 4 行截断）**；类型角标/时长角标浮于其上 |
| ├ 标题/摘要 | `.post-card-title/.summary` | 两行截断 |
| └ 底行 | `.post-card-footer`：徽章 `.stat-badge`×n + 日期 | 播/赞/评/转 |
| 无限滚动 | `.load-sentinel` + IntersectionObserver | **不分页懒加载**：哨兵 1px（root=`list-scroll`，rootMargin 600px 预载）命中且 `hasMore=posts.length<total` 时 `page+1` 追加；`page===1` 走替换（整表 + is-refetching 变暗 + grid key 按替换型指纹重挂动画），`page>1` 走追加（按 id 去重拼接、不动 key 不重挂旧卡片）；追加失败 `loadMoreError` 尾条手动重试；到底显示 `.load-end`「已经到底啦」|
| 占位/错误 | `.posts-placeholder` / Alert(destructive) | 加载 Spin / 空列表 / 失败 |

**archive 视图（档案 / v0.6.0 P5）**
| 名称 | 类名 | 说明 |
|---|---|---|
| 视图容器 | `.archive-view` | 三区块（趋势/日历/档案卡）纵排，`overflow-y:auto`，padding `16px 20px 24px`；**卡片自治**：各卡内置账号切换器与数据拉取（不共用列表操作钮行） |
| 账号切换器 | `<AccountPicker>` | 卡片内部紧凑 Select（平台·昵称），单账号不渲染；默认=B站账号或页面层当前账号，切 V 保留同 id 选中 |
| 趋势曲线 | `<FanTrendChart>`（shadcn Chart/recharts 3.8，`components/ui/chart.tsx` 为 registry new-york-v4 版） | **双序列**：self 直采实线（`--chart-1` 主粉）/ zeroroku 回填虚线（`--chart-2` 灰蓝）；X=日期（月刻度 48px 间隔）、Y=`formatCount` 万缩写；Tooltip=日期+粉丝数+图例；数据 `GET /account/{id}/fan-trend`（服务端按天分桶） |
| 直播日历 | `<LiveCalendar>` `.live-calendar*` | 月网格（周一开头，可翻月）；绿点=当日自采场次证据、满格=当日第三方礼物日聚合；悬浮显示 礼物/大航海/SC 原始字符串 |
| 档案卡 | `<ProfileCard>` `.profile-card*` | 阵营（Select 编辑，选项自动建议第三方索引 `group_name`，一键「采纳」写 `faction`）、企划·公会（只读+来源注记）、生日/出道日/房间号（跟随卡内所选账号）、设定集（Collapsible 折叠）；数据 `GET /externals/vtubers/by-uid` |

**联动刷新（跨组件事件）**
| 事件 | 触发方 | 消费方 |
|---|---|---|
| `ddtoolkit:fetch-idle` | TopBar 轮询 running→idle 边沿 | VtuberSidebar 刷列表；PostsPage `refreshTick`（重拉 vtuber 本体+统计+帖子；`selectedAccount` 按 uid 取新引用）； |
| `ddtoolkit:account-progress` | TopBar 快照增量 | VtuberSidebar `mergeSnapshots` 就地合并 |
| `ddtoolkit:data-changed` | 添加/解除订阅成功 | VtuberSidebar 刷列表 |
| `ddtoolkit:kick-poll` | 各操作按钮 | TopBar 立即轮询一次（防单V抓取快速完成漏边沿） |
| `ddtoolkit:pill-message` | 抓取/更新完成 | TopBar 状态胶囊覆盖显示 4s |

### B2. 详情窗口 `<PostDetailDrawer>`（components/PostDetailDrawer.tsx）
P6-2 起为**居中 Dialog**（原 Sheet 右侧抽屉）`sm:max-w-[720px]`，标题 = 帖子类型名。动效见「抽屉动效」段（dialog-content/overlay，scale 0.97 替代右移）。结构未变动：元信息行(类型/时间/平台ID/原文链接/墓碑flag) → 墓碑时间线(已删时) → 统计徽章行 → 预约卡 → 封面大图 → 正文三态(Delta/HTML/纯文本) → 转发原文卡 → 图片组 → 附加字段(bvid/cvid/description) → 原始JSON 折叠。

---

## C. 设计令牌（styles/tokens.css 与 index.css 同步）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--c-primary` / `--c-primary-deep` | #ffa2b4 / #fb77a1 | 顶栏粉 / 强调粉（shadcn --primary） |
| `--c-accent` / `--c-live` | #fc7079 / #e14444 | hover强调 / 直播红 |
| `--c-bg-page` / `--c-bg-card` / `--c-bg-list` | #fffbfb / #ffffff / #fffbfb | 页面/卡片/列表底 |
| `--c-rail` / `--c-rail-active-bg` | #4b5a6f / #647489 | 图标栏底 / 选中格实底 |
| `--c-border` | rgba(210,216,222,.55) | 发丝描边 |
| `--c-text-main` / `--c-text-sub` / `--c-text-on-primary` | #4b5a6b / #647489 / #ffffff | 正文/次级/主色上文字 |
| `--sel-bar` / `--sel-bg` / `--sel-bg-hover` | #fb77a1 / #fff0f3 / #fff7f9 | 列表选中竖条/底/hover |
| `--radius-card` / `--radius-sm` | 0 / 0 | 方形化 |
| `--shadow-card` | none | 全平面 |
| `--radius-window` | 4px | L3 窗口圆角 |
| `--topbar-height` / `--rail-width` / `--sidebar-width` | 40px / 50px / 492px | 三段尺寸 |
| shadcn `--radius` | 0rem | 全家桶方形化（Button/Select/Dialog/Sheet…） |

## C2. 浮片系统（layout.css `.float-pill`，令牌见 tokens.css）

自定义风格：**斜切圆角矩形白卡**（豁免方形规则的浮动元件家族）。

| 令牌 | 值 | 用途 |
|---|---|---|
| `--pill-bg` | #ffffff | 白卡底 |
| `--pill-radius` / `--pill-skew` | 8px / -10deg | 圆角 / 平行四边形斜切（::before 承载，内容直立） |
| `--pill-h-sm` / `--pill-h-md` | 25px / 30px | 侧栏行 / 帖子页行 |
| `--pill-shadow` / `--pill-shadow-hover` | 0 2px 6px rgba(15,23,42,.12) / 0 3px 8px .18 | 常态 / hover |
| `--pill-fg-icon` | #3d4a5c | 图标与实心三角深蓝灰 |
| `--pill-ring` | inset 0 0 0 1.5px 主粉 | focus-visible 环（作用于 ::before） |

- 类 API：`.float-pill` 基型 + `--icon`（方形图标钮）/ `--text`（文字钮）+ `--md`（30px）+ `.on`（激活：primary-deep 底白字）
- 交互态：hover 上浮1px+阴影加深、按压回落、focus-visible 环、disabled 半透明
- 实心下拉三角 `.pill-caret`（border 法，-15° 微倾）替代描边 ChevronDown
- 现役浮片：侧栏 ＋ / 拉取(Download) / 过滤触发器(89px「默认」+caret)、帖子页时间钮(md)
- **禁用例**：搜索胶囊（侧栏 240×25、帖子页 190×30）为胶囊形遗留例外，不入体系；Hero `.stat-pill` 彩色统计胶囊属另一家族

## C3. 独立筛选弹窗（layout.css `.filter-pop`）

- 入口：侧栏过滤触发器（`.filter-wrap` 锚定，点外关闭，同 time-pop 模式）
- 三组多选 chip（`.filter-chip`，方形、选中粉底）：状态（直播中/未直播）、平台（accounts 动态提取）、阵营（非空 faction 动态提取）
- 组合逻辑：组内 OR、组间 AND，空组不生效，即时生效无应用钮，底部「重置」
- 触发器反馈：任一筛选生效加 `.on`；展示文案暂占位「默认」待定

## C4. 条目入场动效（layout.css `.anim-rise`）

- 规格：`rise-in` 关键帧（opacity 0 + translateY 14px → 0），单项 320ms ease-out（cubic-bezier(0.22,1,0.36,1)），步进 45ms/项，CSS `min()` 封顶 400ms（第 10 项后不再追加），`fill-mode: both` 防闪现
- 用法：条目根元素挂 `anim-rise` + 内联 `--rise-i` 序号；列表容器以**内容标识 key** 整体重挂载触发重播
- 接入点：侧栏 VTuber 行（key=query+筛选+数据长度）、list 视图 `.post-grid`（key=账号+首末帖 id+数量——loading 期间 key 不变，保留旧内容降透明的无闪动重取）、Hero 平台药丸组（key=账号，切 V 重播）
- `prefers-reduced-motion: reduce` 下全量禁用

### 退场编排（退出 → 进入，预取门控 + 原子提交）

- `.scene-exit`（fall-out）：整块 `translateY(10px)` 下滑渐隐，**0.18s** ease-in（比 `EXIT_MS=200` 短 20ms，动画必在类移除前结束防竞态帧），`pointer-events:none` 防误点；与 rise-in 镜像闭合
- 机制：PostsPage 场景机 `scene{acc,view,exiting}` + **预取门控**——账号目标变化先并行预取三件套（getVtuber/第1页帖子/postStats），旧内容冻结可见；**数据就绪才退场**，EXIT_MS 后一次性应用预取数据（原子提交，页码归 1、筛选保留），**全程无「正在加载」占位帧**
- 防重拉闪动：提交播种 `seededPostsKeyRef`（posts effect 消费一次跳过重拉）+ `vtuberLoadedRef`（跳过冗余 getVtuber）；refreshTick 变化仍正常重拉
- 应用：切 V、cards/list 视图切换（视图切换无数据依赖立即退场；cards→list 首次帖子加载仍走正常 loading）；搜索/筛选/翻页仅重播入场不退场；**P6-1：筛选切换（type/搜索/时间/已删）立即滚回列表顶部**（触发即滚，不等重取；此前缓存恢复方案实测不达预期已 revert）
- 快速连点：中止旧预取、回退退场（旧内容回到可见冻结），新目标就绪后重来；加载占位仅存于首次进入/手动刷新/错误态；reduced-motion 动画禁用（200ms 延迟保留）
- 详情窗口动效（posts.css 末段）：居中 Dialog（P6-2 起）对齐全局运动语言——进场 260ms 淡入+scale(0.97) 缩入、退场 200ms 淡出+scale(0.97)（fall-out 同款 ease-in），遮罩与面板时长严格同步；覆盖 `[data-slot=dialog-content/overlay]` 的 animation-name/duration，radix animationend 卸载机制不受影响；reduced-motion 下 0.01ms 瞌时关闭

## C5. 三层组件契约（UI 几何统一基准）

| 层 | 语义 | 形态契约 | 成员 |
|---|---|---|---|
| **交互层** float-pill | 一切可点击触发 | 斜切(-10°)白卡 + 3px 圆角 + 阴影（唯一带阴影）；hover 渐灰；`.on` 主色填充；`.float-pill--danger` 红字 | 侧栏工具行、时间钮、bg-tools、**header-actions 五钮**（更新动态 `.on` 主操作、解除订阅 danger） |
| **信息层** flat-chip | 只读展示 | 平面 **3px、无阴影、不斜切**；色底（粉/珊瑚）或发丝边 | stat-pill（191×37 色底去白边）、faction-badge、type-chip、stat-badge、post-card-type、live-tag |
| **表面层** surfaces | 卡片/面板/弹窗 | **0px 方形** + 发丝边 | post-card、posts-panel、弹窗/下拉卡 |

**用户审美特例（覆盖统一基准，勿在后续回合误改回）**：
- `.live-tag`（卡片页直播徽标）圆角 **8px**
- `.type-chip`（列表帖子分类胶囊）**999px 全圆角 + `--pill-shadow` 浮片阴影**（无发丝边，hover 浮片灰底）
- `.stat-pill`（平台药丸）**图像底**（`docs/design/pills` → `src/assets/pills/`，按平台映射，未知平台回退粉/珊瑚色底）+ **2px 圆角 + `1px 2px 4px rgba(15,23,42,.12)` 阴影**，**全圆 logo 盒已移除**，仅粉丝数**靠右对齐、数字 ≤4 位**（`formatCount` 收紧）+ **`text-shadow 0 1px 2px rgba(0,0,0,.35)` 保图像底可读**；`.faction-badge` 同族 2px+同款阴影
- `.acc-switch-btn`（账号切换器）**浮片化**：白卡 + **2px 圆角 + `var(--pill-shadow)`、去发丝边**（不加斜切保文本可读）；`.on` 主色深填白字
- `post-card`（帖子卡片）**浮片化特例**：**2px 圆角 + `var(--pill-shadow)`、去发丝边**；hover 上浮 2px + 阴影加深 + **标题变色 `--c-accent`**；`.post-card-cover` 无封面时 `.post-card-cover-paper` 米白纸纹斜条 + 居中大标题

**豁免**：搜索胶囊（侧栏 `list-search`、帖子页 `.search-float`，用户指定原样）、滚动条圆头、头像与状态圆点（圆形）。
**二期待办**：✅ P6-3 已清——对话框内残留圆角（AddVtuberDialog 平台标 rounded-xs → 0、TopBar 诊断框 rounded → 0）、dialog/sheet/alert-dialog `shadow-lg` → `shadow-none`（表面层契约：阴影为 float-pill 专属）、time-pop/filter-pop 去阴影（0 圆角+发丝边）；分页钮不存在（无限滚动，N/A）。

## D. 字体（tokens.css @font-face）

| family | 文件 | 用途 |
|---|---|---|
| `Alimama FangYuanTi VF`(100–900) | AlimamaFangYuanTiVF-VF.ttf | 全局默认 `--font-family` |
| `QianTu XiaoTuTi` | QianTuXiaoTuTi.ttf | `--font-logo`（顶栏 LOGO D，26px） |
| `ZiXiao HunRui YiHe` | ZiXiaoHunRuiYiHe.ttf | `--font-title`（顶栏标题，字距8px） |

## E. 交互浮窗清单

| 浮窗 | 入口 | 说明 |
|---|---|---|
| AlertDialog 关闭确认 | TopBar 关闭钮(busy) | 「抓取任务正在进行中」 |
| AddVtuberDialog | 侧栏「+」 | 输入防抖搜本地候选池 → 点选 adopt（建库+自动单V抓取）→ 踢poll + 侧栏刷新 + 右栏跳新V |
| BatchFetchDialog | 侧栏「拉取」 | 四项：全量账号 / 全量帖子 / 更新未归档 / 归档（前三项后台执行+409防重入，归档同步返回条数） |
| PostDetailDrawer | 帖子卡片 | 见 B2 |
| AlertDialog 解订阅 | list 视图红色钮 | 说明连带删帖，确认后跳首页 |
| 筛选弹窗 `.filter-pop` | 侧栏过滤触发器 | 见 C3（状态/平台/阵营组合多选） |

---

## 设计迭代速查（本会话沉淀）

- 设计稿代码为**参考规格**，落地以 tokens/layout 为准；「微调」直接口播，无需回设计工具
- 浮动小元件（浮片/光条/药丸）豁免全局方形规则；交互态统一「无描边、背景填充」语言
- 图标一律 lucide（视觉尺寸按设计稿实测覆盖 className），自定义图形进 `assets/icons/`
- 窗口美学：DWM 系统圆角/阴影已关闭，只有前端 4px 一套弧线
