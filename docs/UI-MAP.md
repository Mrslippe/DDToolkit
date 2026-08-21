# UI 元素命名注册表（UI-MAP）

> 修改前端界面时，按本文档名称精确指定目标区域/元素。
> 结构约定：`组件文件 → CSS 类名 → 关键子元素`。设计令牌统一在 `src/styles/tokens.css`。

---

## A. 应用壳层（App.tsx + styles/layout.css）

| 名称 | 组件 / 类名 | 说明 |
|---|---|---|
| 应用壳 | `App.tsx` `.app-shell` | 顶栏 + `body` 左右布局 |
| 主行 | `.app-body` | 图标栏 + VTuber 栏 + 内容区 |
| 内容区 | `.app-main` | 右栏路由出口（EmptyState / PostsPage） |

### A1. 顶栏 `<TopBar>`（components/TopBar.tsx）
| 名称 | 类名 | 说明 |
|---|---|---|
| 顶栏容器 | `.topbar` | 粉色 `--c-primary`，桌面端为拖拽区 |
| LOGO 占位 | `.topbar-logo` | 字母 "D" 方块，**后续替换为图片** |
| 标题 | `.topbar-title` | 文案 "DDtoolkit" |
| 状态胶囊 | `.topbar-status` | 实时抓取状态（轮询 `/vtuber/fetch-status`） |
| ├ 状态点 | `.topbar-status-dot`（`.busy` = 抓取中橙色脉冲） | 绿=空闲 |
| 弹性空隙 | `.topbar-spacer` | 推开右侧按钮组 |
| 窗口控制组 | `.topbar-window-controls` | Web 下仅装饰 |
| ├ 最小化按钮 | `.topbar-win-btn`(—) | 桌面端接原生窗口 |
| ├ 刷新按钮 | `.topbar-win-btn`(⟳) | 所有端可用 |
| └ 关闭按钮 | `.topbar-win-btn`(✕) | 桌面端可用；抓取中弹确认 |

### A2. 工具图标栏 `<IconRail>`（components/IconRail.tsx）
| 名称 | 类名 | 说明 |
|---|---|---|
| 工具栏容器 | `.icon-rail` | 最左侧竖排，52px |
| 功能入口按钮 | `.icon-rail-btn(.active)` | 数据源：`RAIL_ITEMS` 数组；当前仅「帖子浏览」占位 |

### A3. VTuber 左栏 `<VtuberSidebar>`（components/VtuberSidebar.tsx）
| 名称 | 类名 | 说明 |
|---|---|---|
| 侧栏容器 | `.sidebar` | 常驻，宽 `--sidebar-width` |
| 栏头 | `.sidebar-header` | h3「VTuber 列表」+ 计数 |
| 计数 | `.sidebar-count` | 「共 N 位」 |
| 条目 | `.vtuber-item(.active)` | 点击导航 `/vtubers/:id`，当前路由高亮 |
| ├ 头像 | shadcn Avatar(40, size-10) | 本地缓存优先 |
| ├ 名字行 | `.vtuber-name-row` | 含直播标识 |
| │ ├ 名字 | `.vtuber-name` | 单行截断 |
| │ ├ 直播红点 | `.live-dot` | title="直播中" |
| │ └ 直播标签 | `.live-label` | 文案「直播中」 |
| └ 签名 | `.vtuber-sign` | 单行截断，取 bilibili sign |
| 提示态 | `.sidebar-tip` | 加载失败 / 空列表文案 |

---

## B. 右栏内容

### B0. 空置页 `<EmptyState>`（pages/EmptyState.tsx）
| 名称 | 类名 | 说明 |
|---|---|---|
| 空置容器 | `.empty-state` | 垂直水平居中 |
| 引导卡片 | `.empty-state-card` | 虚线描边圆角卡 |
| ├ 大LOGO | `.empty-state-logo` | 圆形 "D" |
| ├ 标题 | `.empty-state-title` | 「未选择 VTuber」 |
| └ 描述 | `.empty-state-desc` | 操作引导文案 |

### B1. 帖子面板 `<PostsPage>`（pages/PostsPage.tsx，styles/posts.css）
路由 `/vtubers/:id`；数据：`getVtuber / postStats / listPosts(分页)`。

**信息条**
| 名称 | 类名 | 说明 |
|---|---|---|
| 信息条容器 | `.vtuber-header` | 头像56 + 信息 + 按钮组 |
| 名字行 | `.vtuber-header-name-row` | |
| ├ 标题 | h2 `.vtuber-header-name` | VTuber 名 |
| ├ 直播标签 | `.live-tag` | tooltip=直播间标题 |
| ├ 账号切换 | shadcn Select（多账号时显示） | 按 platform_uid 切换 |
| 元信息行 | `.vtuber-header-meta` | 签名 · 粉丝 · 上次抓取时间 |
| 操作按钮组 | 「抓取账号」「抓取帖子」「更新动态」 | 第三个为 primary |

**筛选行**
| 名称 | 类名 | 说明 |
|---|---|---|
| 筛选行容器 | `.type-chips-row` | chips 左、归档开关右 |
| 类型筛选组 | `.type-chips` > `button.type-chip(.active)` | 全部N/视频N/图文N…计数来自 stats.by_type |
| 归档过滤 | ToggleGroup(single)：全部/未归档/已归档 | 映射查询参数 is_archived |

**卡片流**
| 名称 | 类名 | 说明 |
|---|---|---|
| 流容器 | `.post-grid` | 单列瀑布流 |
| 卡片 | `<PostCard>` `article.post-card` | 点击开详情抽屉；`.sk` 为骨架屏变体 |
| ├ 封面区 | `.post-card-cover` | 220px 固定宽，16:10 |
| │ ├ 封面图 | SmartImage `.post-card-cover-img` | 兜底链路：直连→代理→占位 |
| │ ├ 文本兜底 | `.post-card-cover-fallback` | 无封面时展示摘要 |
| │ ├ 类型角标 | `.post-card-type` | 左上角，中文类型名 |
| │ └ 时长角标 | `.post-card-duration` | 右下角 mm:ss（视频） |
| ├ 标题 | h4 `.post-card-title` | 两行截断 |
| ├ 摘要 | `.post-card-summary` | 两行截断 |
| ├ 底行 | `.post-card-footer` | 徽章行 + 日期两端对齐 |
| │ ├ 徽章行 | `.post-card-badges` > `<StatBadge>` `.stat-badge` | 播放/点赞/评论/转发 |
| │ └ 日期 | `.post-card-date` | published_at 前 10 位 |
| 分页 | `.posts-footer` > PaginationLite(自建) | 服务端分页 20 条/页 |
| 占位态 | `.posts-placeholder` | 加载 Spin / 空列表 / 错误 Alert 复用区 |

### B2. 详情抽屉 `<PostDetailDrawer>`（components/PostDetailDrawer.tsx）
Sheet 右侧抽屉 sm:max-w-[720px]，标题=postDisplayTitle。
| 名称 | 实现 | 说明 |
|---|---|---|
| 元信息行 | Space：TypeTag + 发布时间 + 平台ID + 原文链接 | |
| 统计徽章行 | `.drawer-stats` > StatBadge ×n | 播/赞/评/转/藏/币/分享/弹幕（有值才显示） |
| 预约卡 | `ReservationCard` | body_json.reservation |
| 封面大图 | SmartImage maxHeight 320 | |
| 正文三态 | DeltaRenderer（专栏 Delta）/ HTML 全文 / 纯文本 pre-wrap | |
| 转发原文卡 | `OriginCard` | body_json.origin：标题/文本/图片九宫格/原文链接 |
| 图片组 | SmartImage 120×120 ×n | |
| 附加字段 | bvid / cv_id / description | code 样式 |
| 原始 JSON | Collapsible「原始响应 raw_json」 | 排查用 |

---

## C. 设计令牌（styles/tokens.css）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--c-primary` | #ffa2b4 | 顶栏底色 |
| `--c-primary-deep` | #fb77a1 | 强调色（shadcn --primary 同步） |
| `--c-accent` | #fc7079 | hover 强调 |
| `--c-live` | #e14444 | 直播中红 |
| `--c-bg-page` | #fffbfb | 页面底色 |
| `--c-bg-card` | #ffffff | 卡片底 |
| `--c-border` | rgba(206,206,206,.56) | 描边 |
| `--c-text-main` / `--c-text-sub` | #4b5a6b / #647489 | 正文/次级文字 |
| `--radius-card` / `--radius-sm` | 10px / 8px | 圆角 |
| `--shadow-card` | 粉系投影 | 卡片悬浮 |
| `--topbar-height` | 56px | 顶栏高 |
| `--sidebar-width` | 300px | 左栏宽 |
| `--font-family` | 阿里妈妈方圆体 VF → 系统回退链 | 全局字体 |

## D. 全局字体
`Alimama FangYuanTi VF`（可变字重 100–900），`@font-face` 于 tokens.css；
源文件 `frontend/src/assets/fonts/AlimamaFangYuanTiVF-VF.ttf`（7MB，待子集化）。
