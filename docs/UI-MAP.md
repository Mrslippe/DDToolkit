# UI 设计映射文档（UI-MAP）

> 修改前端界面时，按本文档名称精确指定目标区域/元素。
> 结构约定：`组件文件 → CSS 类名 → 关键子元素`。设计令牌统一在 `src/styles/tokens.css`。
>
> 设计语言总纲：**方形极简 + 全平面零阴影**（shadcn `--radius:0rem`、`--shadow-card:none`）；
> 例外仅两类视觉胶囊：列表工具行的「浮片」与帖子面板内的「药丸/光条」（保留圆角以贴合参考稿）。

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
| 窗口本体 | 1440×800 / 无框 / 透明 / L3 自绘圆角 | `--radius-window:12px`；Rust 侧已关 DWM 阴影与系统圆角（仅前端一套弧线） |
| 最大化 | `html.window-maximized` 类 | 壳层圆角归零（App.tsx `useMaximizedClass` 监听 `onResized`） |

---

## A. 应用壳层（App.tsx + styles/layout.css）

| 名称 | 组件 / 类名 | 说明 |
|---|---|---|
| 应用壳 | `.app-shell` | 顶栏 + body 左右布局；12px 自绘圆角（透明窗口裁剪）；光圈已注释 |
| 主行 | `.app-body` | `flex:1; min-height:0` |
| 内容区 | `.app-main` | `padding:0; overflow:hidden`，滚动权交付页面内部（posts.css） |

### A1. 顶栏 `<TopBar>`（components/TopBar.tsx）

视觉严格按 `docs/react-topbar` 导出（Frame411）。整条 `data-tauri-drag-region` 拖拽区。

| 名称 | 类名 | 说明 |
|---|---|---|
| 顶栏容器 | `.topbar` | 粉色 `--c-primary`，高 `--topbar-height:69px` |
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

视觉严格按 `docs/react-IconRail` 导出（Frame4172）。

| 名称 | 类名 | 说明 |
|---|---|---|
| 栏容器 | `.icon-rail` | 宽 `--rail-width:79px`，深蓝灰 `--c-rail:#4b5a6f` |
| 顶部组 | `.icon-rail-group`（首）÷ spacer | 功能入口 |
| 底部组 | `.icon-rail-spacer` + `.icon-rail-group`（尾） | 贴栏底 |
| 单元格 | `.icon-rail-btn` | **通栏 79×79** 贴合；未选中整钮 `opacity:.6`，hover `.85` |
| 选中单元格 | `.icon-rail-btn.active` | **实底 `--c-rail-active-bg:#647489` + 全亮** |
| 图标 | 顶部组按序：`FileText`(22×28)/`User`(29×31)/`CalendarDays`(31×31)；底部：`RotateCw`(30×30)/`Settings`(35×35) | 视觉尺寸对应设计稿实测 |

接线语义：**仅「帖子」`FileText` 接线**（`navigate('/')`，路由高亮恒亮）；其余四枚占位（tooltip「· 开发中」、`opacity` 走统一未选中语言）。

### A3. VTuber 左栏 `<VtuberSidebar>`（components/VtuberSidebar.tsx）

视觉按 `docs/react-VtuberSidebar`（Frame41109）与口播定案。

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
| 条目 | `.vtuber-item(.active)` | **84px 通栏**（`flex-shrink:0`），gap 14，左 padding 26px；hover 浅粉 `--sel-bg-hover` |
| 选中条 | `.vtuber-item.active::before` | **左缘 3px 粉竖条 `--sel-bar` + 浅粉底 `--sel-bg`** |
| 头像 | shadcn Avatar `size-[65px]` | 圆形，`resolveAsset(avatar_path) ?? avatar_url` |
| 名字 | `.vtuber-name` | **20px 纯黑 500**，`user-select:none` |
| 直播点/标签 | `.live-dot` / `.live-label` | 红 `--c-live`，仅直播中 |
| 签名 | `.vtuber-sign` | **13px 灰**，`user-select:none` |
| 阵营槽 | `.vtuber-emblem` | 右侧 **60px 全高**，紧贴右缘；暂空置（预留图片资源） |
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
路由 `/vtubers/:id`。**双视图状态机**：`view: 'cards'|'list'`（默认 `cards`），光条切换，数据共享不重取。视觉按 `docs/react-PostsPage`（Frame41301）。

| 名称 | 类名 | 说明 |
|---|---|---|
| 面板 | `.posts-panel` | `height:100%`，flex column，`overflow:hidden`（裁剪模糊边界） |
| 背景层 | `.hero-backdrop` | **无条件常驻**：当前 V 头像 blur(13px) op.7 + ::after 45% 白纱；两视图恒定铺满右栏 |
| 工具条 | `.view-toolbar` | 贴面板顶（`padding:0 16px`，**上方零缝隙**），仅视图光条 |

**光条视图切换**
| 名称 | 类名 | 说明 |
|---|---|---|
| 光条 | `.glow-bar` | 443px 白色渐变(`rgba(255,255,255,.68)` 中心)胶囊 |
| 视图钮 | `.view-btn.on/.off` | 四枚：日历(`Calendar`)·占位 / **卡片(`LayoutGrid`)→`setView('cards')`** / **列表(`AlignJustify`)→`setView('list')`** / 邮件(`Mail`)·占位；on=.8 off=.4，激活跟随 `view` |

**cards 视图（展示页 / 默认）**
| 名称 | 类名 | 说明 |
|---|---|---|
| 滚动层 | `.hero-scroll` | `overflow-y:auto`，padding `16px 70px 134px`，居中 |
| Hero | `.hero` | column 居中，max-width 869px |
| 头像 | shadcn Avatar `.hero-avatar` | **178×178**，`filter: drop-shadow(0 1px 8px rgba(0,0,0,.98))` |
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
| 滚动层 | `.list-scroll` | `overflow-y:auto`，padding `12px 16px 24px` |
| 内容箍 | `.list-inner` | `max-width:900px` 居中，column gap14 |
| 操作按钮组 | `.header-actions` | **置顶**：抓取账号(`Zap`)/抓取帖子/更新动态（主色）+ 解除订阅（红，开 AlertDialog，删除连带清帖） |
| 筛选行 | `.type-chips-row` | chips 左、归档 ToggleGroup 右 |
| 类型chips | `.type-chip(.active)` | 计数来自 `stats.by_type` |
| 归档过滤 | ToggleGroup(single)：全部/未归档/已归档 | 映射 `is_archived` |
| 帖子流 | `.post-grid(.is-refetching)` | 重取时旧内容降透明禁点击，无整屏闪动 |
| 卡片 | `<PostCard>` `article.post-card` | 白底、方形（`--radius-card:0`）；hover 上浮2px |
| ├ 封面 | `.post-card-cover` 220×16:10；SmartImage 三态兜底 | 类型角标/时长角标浮于其上 |
| ├ 标题/摘要 | `.post-card-title/.summary` | 两行截断 |
| └ 底行 | `.post-card-footer`：徽章 `.stat-badge`×n + 日期 | 播/赞/评/转 |
| 分页 | `.posts-footer` > PaginationLite | 服务端 20/页 |
| 占位/错误 | `.posts-placeholder` / Alert(destructive) | 加载 Spin / 空列表 / 失败 |

**联动刷新（跨组件事件）**
| 事件 | 触发方 | 消费方 |
|---|---|---|
| `ddtoolkit:fetch-idle` | TopBar 轮询 running→idle 边沿 | VtuberSidebar 刷列表；PostsPage `refreshTick`（重拉 vtuber 本体+统计+帖子；`selectedAccount` 按 uid 取新引用）； |
| `ddtoolkit:account-progress` | TopBar 快照增量 | VtuberSidebar `mergeSnapshots` 就地合并 |
| `ddtoolkit:data-changed` | 添加/解除订阅成功 | VtuberSidebar 刷列表 |
| `ddtoolkit:kick-poll` | 各操作按钮 | TopBar 立即轮询一次（防单V抓取快速完成漏边沿） |
| `ddtoolkit:pill-message` | 抓取/更新完成 | TopBar 状态胶囊覆盖显示 4s |

### B2. 详情抽屉 `<PostDetailDrawer>`（components/PostDetailDrawer.tsx）
Sheet 右侧抽屉 `sm:max-w-[720px]`，标题 = 帖子类型名。结构未变动：元信息行(类型/时间/平台ID/原文链接) → 统计徽章行 → 预约卡 → 封面大图 → 正文三态(Delta/HTML/纯文本) → 转发原文卡 → 图片组 → 附加字段(bvid/cvid/description) → 原始JSON 折叠。

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
| `--radius-window` | 12px | L3 窗口圆角 |
| `--topbar-height` / `--rail-width` / `--sidebar-width` | 69px / 79px / 492px | 三段宽度 |
| shadcn `--radius` | 0rem | 全家桶方形化（Button/Select/Dialog/Sheet…） |

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

---

## 设计迭代速查（本会话沉淀）

- 设计稿代码为**参考规格**，落地以 tokens/layout 为准；「微调」直接口播，无需回设计工具
- 浮动小元件（浮片/光条/药丸）豁免全局方形规则；交互态统一「无描边、背景填充」语言
- 图标一律 lucide（视觉尺寸按设计稿实测覆盖 className），自定义图形进 `assets/icons/`
- 窗口美学：DWM 系统圆角/阴影已关闭，只有前端 12px 一套弧线