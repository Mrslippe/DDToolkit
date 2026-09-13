# 前端架构体检 · 「专属组件库」必要性与工作量评估

> 体检对象：`frontend/src` —— 39 个 `.tsx` + 12 个 `.ts`（8,816 行）＋ 4 个 CSS（4,027 行），合计 **12,843 行**
> 体检口径：静态统计（引用图 / 重复度 / 死代码 / 依赖使用 / 行尾）+ `docs/UI-MAP.md` 契约核对
> 体检时间：本会话（v0.9.1 发布后）

---

## 0. 结论（先看这段）

| 问题 | 结论 |
|---|---|
| 需要构建「专属组件库」吗？ | **不需要**——单消费方、已有 shadcn 等价层、缺验证基建 |
| 需要动代码吗？ | **需要**——四层收敛 + 定点抽取（不是重写、不是换框架） |
| 工作量 | P0 清理 **0.5 天 ✅ 已落地（净减 334 行）** · P1 共享件 **1 天 ✅ 已落地（+73 行，含 4 个新组件）** · P2 巨型文件拆分 **2–3 天** · P3 基建 **2 天（可选）** |
| 拿 80% 收益 | **P0 + P1 ✅ 已完成**（P0 净减 334 行；P1 消除 3 处双实现并新建层2 `components/common/`） |

---

## 1. 体检数据

### 1.1 体量与分布

> 数据口径：§1.1 的体量数字为 2026-09-13 复核值（原为 2026-09-10 审计值）；
> §1.3 / §1.4 的复用度与卫生度仍是 2026-09-10 审计快照，未重算。**不含** `.test.ts(x)` 测试文件。

| 维度 | 数据 |
|---|---|
| 代码文件 | 74 个（49 tsx + 25 ts），10,874 行（含测试则 83 个 / 11,708 行） |
| 样式文件 | 4 个，4,107 行（`posts.css` 3,016 / `layout.css` 943 / `index.css` 83 / `tokens.css` 65） |
| 组件总数 | 45 个 tsx（`components/ui` 12 + 业务 33） |
| 页面 | 2 个（`PostsPage` 812 行、`EmptyState` 13 行）+ `pages/useVtuberActions.ts` 170 行 |
| 最大文件 | `styles/posts.css` 3,016 行、`pages/PostsPage.tsx` 812 行、`components/VtuberSettingsDialog.tsx` 641 行 |

### 1.2 现有分层（已经存在，不用新建）

| 层 | 位置 | 状态 |
|---|---|---|
| 设计令牌 | `styles/tokens.css`（65 行） | ✅ 完整，全部 `var(--token)` 引用 |
| 基础件（primitives） | `components/ui/*`（shadcn + Radix，12 件，`components.json` 已配置） | ✅ 全部在用 |
| 共享工具 | `utils/format.ts`、`utils/chartTheme.ts`、`utils/signSource.ts`（签名解析）、`utils/signOptions.ts`（下拉候选）、`utils/fanTrend.ts`（趋势合并）、`utils/pill.ts`、`hooks/useFetchBusy`、`hooks/useIsMaximized` | ✅ 复用良好；纯函数都带 `.test.ts` |
| 业务组件 | `components/*`（33 件 tsx） | ⚠️ 多数只有 1 个引用者（属"功能"而非"基础件"） |
| 设计契约文档 | `docs/UI-MAP.md`（471 行，§C5 三层组件契约） | ✅ 已把"交互层/信息层/弹窗层/表面层"写死 |

### 1.3 复用度（谁真的被复用）

| 组件 | 引用者数 |
|---|---|
| `OverlayScroll` | 5 |
| `SmartImage` / `StatBadge` | 2 |
| 其余 17 个业务组件 | **1** |

> 说明：单引用不等于坏味道——`PostCard`/`LiveCalendar`/`FanTrendChart` 是领域组件，本来就不该被复用。它只说明"抽成库"没有消费方。

### 1.4 卫生度（做得好的部分）

| 指标 | 结果 |
|---|---|
| `!important` | **0 处** |
| 硬编码颜色 | 极少，统一走 `var(--c-*)` / `var(--pill-*)` |
| CSS 组织 | 约 665 个选择器按 feature 前缀分区（`lc-*` / `post-card-*` / `profile-*` / `fan-*` / `vd-*` / `image-viewer-*`），带中文分区注释 |
| 依赖使用 | 全部在用（`cva` 仅 shadcn 件使用，`react-qr-code` 仅登录二维码），无冗余依赖 |

---

## 2. 判据：为什么**不**需要「专属组件库」

| # | 判据 | 证据 |
|---|---|---|
| 1 | **单消费方** | 仓库只有一个前端应用（`frontend/`），没有第二个 app / 包引用它。抽成 npm 包后没有任何"第二个用户"，收益为 0，成本是持续的双仓同步 |
| 2 | **已有等价物** | shadcn/ui 本身就是"源码内自有的组件库"（`components.json` + `@/components/ui` + cva + Radix）。再叠一层"专属库"只是把同一批文件换个目录 |
| 3 | **业务组件不可复用** | 20 个业务组件里 17 个仅 1 个引用者；真正的通用面只有 3 个（`OverlayScroll`/`SmartImage`/`StatBadge`），抽库等于给 3 个文件配一套发布流水线 |
| 4 | **缺验证基建** | 无 eslint / 无 vitest / 无 storybook / 无 CI。组件库没有测试与预览就是纯负担——而工作量的大头恰恰在这（见 §8） |
| 5 | **UI 仍在高频定案期** | `docs/UI-MAP.md` 每次会话都在改（本次会话就动了词云、浮片、字体、弹窗规格）。此时抽象 = 把还在变的规格锁死，后续每次定案都要改库 + 改应用两处 |

**触发建库的条件**（满足任一才做）：① 出现第二个前端消费端（Web 版 / 移动版 / 管理台）；② 组件要对外分发；③ 多产品线共享同一设计体系。

---

## 3. 确实存在的 4 个问题（有据可查）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| **1** | **巨型文件** | `PostsPage.tsx` 1,299 行（25 个 `useState`、13 个 `useEffect`、7 组 `try/catch`、16 处 `toast`；JSX 单块 784→1299）；`LiveCalendar.tsx` 1,186 行（其中 `MosaicCloud` 词云组件 267 行内联） | 改动半径大、review 困难；词云算法与日历业务耦合，改日历有碰坏词云的风险 |
| **2** | **浮片按钮双实现** | `layout.css` `.float-pill` 家族（578–684，含 `::before` 斜切 + 尺寸/危险/激活/焦点变体）↔ `posts.css` `.lc-nav-btn` / `.lc-nav-pill`（1592–1651）把同一配方照抄一遍（`::before` + `skewX(var(--pill-skew))` + `var(--pill-radius)` + `var(--pill-shadow)`），并硬编码 25px；而 `UI-MAP §C2` 已把「日历月份导航三件套」列为 float-pill 成员 | 文档与实现不一致；改一次浮片配方要改两处，且第二处没有尺寸/激活/焦点变体 |
| **3** | **图片加载逻辑双实现** | `SmartImage`（direct → proxy → failed ＋ 微博图床从起点走代理 ＋ 占位块）↔ `LiveCalendar.CoverImage`（99–115，同状态机但**缺微博直连分支**） | 微博封面在日历里多一次 403 往返；两处修 bug |
| **4** | **死代码** | `components/ui/sheet.tsx`(146) + `toggle.tsx`(45) + `toggle-group.tsx`(81) = **272 行，零引用**；CSS 死块：`.post-card.sk` / `.sk-block` / `.sk-line` / `.w40/60/90`（骨架族已被 shadcn `Skeleton` 取代）、`.profile-card-head/title/sub`、`.archive-error` ≈ **60 行** | 无主代码误导后来者；`sheet.tsx` 残留更与 `PostDetailDrawer` 的注释（"Sheet 保持挂载"）互相误导——实现早已换成 `Dialog` |

**次要项**：`FanTrendChart.tsx` / `LiveCalendar.tsx` 是 CRLF，其余 53 个源文件是 LF；仓库无 `.gitattributes`。

---

## 4. 目标结构（四层，不新建包）

```
层0 设计令牌     styles/tokens.css                     ← 已存在
层1 基础件       components/ui/*（shadcn 12 件，全部在用）  ← 已存在
层2 共享复合件   components/common/*                    ← 本次抽取目标（新建）
层3 业务组件     components/{posts,live,chart}/*        ← 现有 33 件，按域归目录
层4 页面         pages/*                                ← 现有 2 个
```

配套：`hooks/*`（业务逻辑从巨型文件外移）、`utils/*`（纯函数）。

---

## 5. 抽取清单与工时

### P0 · 清理（0.5 天，零风险，纯删除/合并）—— ✅ 已落地

> 落地提交：`a3a757c`（代码）· `dd908ea`（.gitattributes + 本文档）· `474c86a`（UI-MAP/TODO 同步）
> 实测：净减 **334 行**（7 文件，+40/−374）；`tsc --noEmit` 与 `vite build` 均通过；全仓 0 残留引用。

| 任务 | 规模 | 工时 | 风险 | 状态 |
|---|---|---|---|---|
| 删除 `ui/sheet.tsx`、`ui/toggle.tsx`、`ui/toggle-group.tsx` | −272 行 | 0.2h | 无（零引用，`tsc` 验证） | ✅ |
| 删除 CSS 死块（`sk-*` / `profile-card-head/title/sub` / `archive-error` / `w40-90`） | −60 行 | 0.3h | 无 | ✅ |
| `CoverImage` → 合并进 `SmartImage`（新增 `fallback`/`fallbackClassName` 槽位，顺带补微博直连代理分支） | ±40 行 | 1h | 低（视觉需比对日历封面） | ✅ |
| 补 `.gitattributes`（`* text=auto eol=lf`） | +29 行 | 0.1h | 无 | ✅ |

### P1 · 共享复合件（1 天）—— ✅ 已落地

| 任务 | 来源 | 规模 | 工时 | 风险 | 状态 |
|---|---|---|---|---|---|
| `components/common/ProxyImage.tsx` | `SmartImage` 升级 → 改名 + 迁入 `common/`（补 `draggable`；顺带把 ImageViewer 内部第三份状态机 `ViewerImg` 也并入） | ~110 行 | 1h | 低 | ✅ |
| `components/common/FloatPill.tsx`（`size`/`shape`/`danger`/`active` + 透传原生属性，渲染原生 `<button class="float-pill …">` 保持 `::before` 契约） | `.float-pill` 13 处裸用（PostsPage 7 / VtuberSidebar 3 / ProfileCard 1 / LiveCalendar 3） | ~60 行 | 2h | **中**（斜切/阴影/焦点环/禁用态） | ✅ |
| `components/common/StateBlock.tsx`（loading / empty / error 三态，variant = overlay / inline / alert） | `posts-placeholder` / `.lc-state` / `<Alert>` 三套写法共 7 处 | ~70 行 | 1.5h | 低 | ✅ |
| `components/common/StatPill.tsx`（平台药丸 + `PILL_BG` 映射随之下沉） | `PostsPage` 内联药丸 + 常量 | ~45 行 | 1h | 低 | ✅ |
| 用 `FloatPill` 统一 `.lc-nav-btn` / `.lc-nav-pill` | `posts.css` 自绘配方 | **−49 行 CSS** | 1.5h | **中**（日历导航视觉） | ✅ |

> P1 实测：16 文件 **+298 / −225（净 +73 行）**——新增 4 个共享件约 160 行（含注释与类型），
> 同时删掉 `posts.css` 自绘配方 49 行、`PostsPage` 精简 22 行；CSS 103.04 → **102.32 kB**；
> `tsc --noEmit` 与 `vite build` 通过；类名逐点比对等价（`.lc-nav .float-pill` 仅覆盖配色与内距，其余配方沿用 `layout.css`）。
> 命名说明：按本表落地为 `ProxyImage`（组件实质 = 直连→代理→失败三态），原 `SmartImage` 名退役。

### P2 · 巨型文件拆分（2–3 天）

> ⚠️ 下表的**源行号区间是 2026-09-08 的**，之后两个巨件与 CSS 都长大了，动工前必须按当前文件
> 重新定位。2026-09-13 实测（本批收口后）：`PostsPage` **1247**、`LiveCalendar` **465**、
> `posts.css` **3237**、`layout.css` **1106**（文档原记 1299 / 1186 / 2761 / 1082，均已过时）。
> `LiveCalendar` 已达成 P2 的预期目标区间（≤~450 量级）。

| 任务 | 来源（行号） | 目标 | 工时 | 风险 | 状态 |
|---|---|---|---|---|---|
| `components/wordcloud/MosaicCloud.tsx` + `cloudPalette.ts` | `LiveCalendar.tsx:103–405`（实际） | 词云组件独立 | 2h | 中（rAF / ResizeObserver / 闭包引用多） | ✅ **已落地**：`LiveCalendar` **1182 → 837**（含下一行的纯格式化外提）；另建 `scripts/check_wordcloud_layout.mjs`（sha256 位级基线）+ `cloudPalette.test.ts`（14 条） |
| `components/live/liveCalendarFmt.ts`（本批新增的"能证明的那一半"） | `LiveCalendar.tsx` 的 7 个纯函数 | 纯展示格式化外移 | 1h | 低 | ✅ **已落地（2026-09-13）**：`isFreshSession`/`dayKeyIso`/`fmtMonth`/`fmtTime`/`fmtDur`/`fmtMoney`/`keyOf` + 19 条断言 |
| `components/live/LiveSessionDialog.tsx` | `LiveCalendar.tsx` 场次详情（`lc-dlg` 家族） | 弹窗独立 | 3h | 中 | ✅ **已落地（2026-09-13）**：340 行；`LiveCalendar` **734 → 465**（含把 `cloudBubbles`/破泡状态一并搬入）。证据 = 日历签名 `fb75217e…` 一致 + 详情弹窗实渲染（`--archive-day`）非加载态、非空态。**同日追加**：上游取数拆到 `components/live/useLiveUpstream.ts` 后本件 **457 行**（总行数，devlog/063） |
| `hooks/useLiveSessions.ts` | `LiveCalendar.tsx` 数据加载 / 月份 / 分类状态 | 逻辑外移 | 2h | **高** | ✅ **已落地（2026-09-13）**：`components/live/useLiveSessions.ts`（230 行）；`LiveCalendar` **837 → 734**。证据 = 日历格 sha256 签名 `fb75217e…` 重构前后**完全一致**（`ui_probe.py --archive --calendar-expect`）+ hero 签名 + 探针三档全绿。**顺序是契约**（7 条 effect 的相对顺序与依赖数组不得改），已写进 hook 文件顶部注释 |
| `components/posts/HeroCardsView.tsx` | `PostsPage.tsx` 展示页视图 | 展示页视图 | 1.5h | 中 | ✅ **已落地（2026-09-13，devlog/065）**：192 行 —— cards 分支 + **平台药丸拖动重排逻辑一并搬入**（页面少 4 个 state）；hero 位级签名 `c1154858…` 前后一致 |
| `components/posts/PostListView.tsx` | `PostsPage.tsx` 列表页视图 | 列表页视图 | 2h | 中 | ✅ **已落地（2026-09-13，devlog/065）**：193 行（筛选条 + 无限滚动区 + 回顶）；另拆出 `ListHeaderActions.tsx`（116 行，列表工具条）。取数/分页/观察者**留在页面**（时序是契约） |
| `hooks/useVtuberActions.ts` | `PostsPage.tsx` 的 6 个 `handle*` | 25 → ~15 个 state | 2h | 中 | ✅ **已落地（2026-09-13）**：`pages/useVtuberActions.ts`（197 行）；`PostsPage` **1247 → 1128**；`fetching` 随动作一起搬走。证据 = hero 签名 `c1154858…` 与日历签名 `fb75217e…` 均一致 |

> **决策记录（2026-09-13 上午 → 当日下午改判）：视图 JSX 先判"不再拆"，最终拆了。**
>
> 上午的结论是"收益不成立"（三条理由：体量被高估、要 30+ props 透传、没有组件测试运行器）；
> 下午复核时**实测推翻了第①条**（list 分支实际 **129 行**、旁边还挂着 72 行的工具条，
> 不是当初估的 30 行），第②条改用"整块子树只收自己用的东西"化解（顺带**减少**了页面 state），
> 第③条成立但护栏够用（hero/日历位级签名 + 8 段契约 + 三档宽度，纯搬动必须逐字节一致）。
>
> 落地结果：`PostsPage` 1134 → **859**（总行数），新增三个视图件 + `utils/pill.ts`；
> 全部签名前后一致。原则仍是**只搬 JSX、不搬 effect**（时序是功能本身）。
>
> 仍未做的：把"场景切换机"（预取门控 + 原子提交 + `EXIT_MS` 退场）抽成 hook ——
> 那是行为级重构，需要先为它建护栏。

>
> P2 对此文件的**实际结论**：`PostsPage` 1247 → 1128 → 1134 → **859（当前，总行数）**
> —— 前两批把纯逻辑与视图拆走后行数才真正降下来，而**可测试面**（27 条断言 + 位级护栏）
> 与**位级一致性**（签名前后逐字节相同）才是这次重构真正的产出。

> ⚠️ **行数口径**（2026-09-13 整理 TODO 时发现并统一）：本表数字都是**总行数**
> （含空行/注释，等价 `wc -l`）。2026-09-13 有几处新记录误用了"非空行数"（会少约 5%），
> 已更正为总行数；看到 ±10 行的出入优先怀疑口径而不是"代码变了"。

> 已完成项的实际收益（避免"只减行数"的误判）：`PostsPage.tsx` **1285 → 1247**（−38）——
> 行数减得少，但**三段此前零覆盖的规则变成了可断言的**（平台分组 key 必须等于后端
> `type` 逗号写法、拖拽排序的两个边界、切集边界）。P2 的价值在可控性，不在行数。

**预期结果**：`PostsPage.tsx` → ~700 行；`LiveCalendar.tsx` → ~450 行（当前 877，词云已出）。

> **CSS 归属决策（2026-09-13 用户定，方案 a）**：拆分**不搬 CSS** —— `.lc-*` / `.drp` / `.vd-*`
> 继续留在 `styles/posts.css`。理由是 CSS 是**探针断言的选择器世界**（`ui_probe.py` 直接查
> `.lc-dlg-cloud-cell`、`.post-filter-pop`、`.list-inner` 等），与拆分同批搬动会让
> 「组件搬坏了」和「选择器改了」两类失败混在一起、无法归因。代价是「组件在 `components/live/`、
> 样式在 `posts.css`」的错位 —— 用 UI-MAP 记一句即可，不值得用一份回归风险去换整齐。

### P3 · 基建（2 天，可选）

| 任务 | 工时 | 说明 | 状态 |
|---|---|---|---|
| eslint + prettier + `npm run lint` | 0.5 天 | 巨型文件里未使用变量/依赖数组漏项靠人眼 | 🔶 **eslint 已落地（2026-09-13）**：`eslint@8` flat config，**只开行为类 6 条规则**（核心是 `react-hooks/exhaustive-deps`）；首跑 59 文件仅 **1 error + 5 warning**，已清到 **0 warning** 并设 `--max-warnings 0`；5 处故意窄依赖逐条加 disable + 理由。**prettier 未引入**（会一次性重排几乎每个文件、冲掉历史 blame，建议单独一批） |
| vitest 冒烟：`format` / `wordCloudLayout` 纯函数 | 1 天 | 词云几何算法（单调性/面积偏差）最值得测 | ✅ **已落地（2026-09-13）**：`vitest@2.1.9`（受 Vite 5 peer 约束，非 5.x）+ `src/utils/{format,wordCloudLayout}.test.ts` 共 **29 条**断言；`npm run test`；已并入 `scripts/dev_check.py` 的 `frontend logic` 一项 |
| 渲染快照（2 个） | — | 需要 jsdom/浏览器环境 | ⬜ 未做（当前只测纯逻辑，不引环境依赖） |
| storybook | — | **不建议**：单应用、无跨端复用，维护成本 > 收益 | — |

> **为什么先做 vitest 而不是 eslint**：纯函数断言能锁住**行为契约**（面积∝词频、
> 进位边界、图床改写），而 lint 只锁风格；且 `utils/dateRange.ts` 已有「纯逻辑抽出来
> 直接跑」的先例（`scripts/check_date_range.mjs`），vitest 是同一思路的正式化。
> 首个用例即抓到一处真 bug：`POST_TYPE_LABEL` 漏了 v0.9.6 新增的 `system` 类型，
> 微博「系统」帖在卡片与类型标签上显示原始英文 `system`。

---

## 6. 排期建议

| 阶段 | 内容 | 工期 | 交付判据 |
|---|---|---|---|
| 一 | P0 清理 | 0.5 天 | `tsc` 通过；净减 ~330 行；日历封面走代理一次成功 |
| 二 | P1 共享件 | 1 天 | 浮片只有一套实现；`grep float-pill` 命中集中在 `FloatPill.tsx` |
| 三 | P2 拆分 | 2–3 天 | 两个巨型文件降到 ~700 / ~450 行；UI 无视觉 diff |
| 四 | P3 基建 | 2 天（可选） | `npm run lint` + `npm run test` 绿 |

---

## 7. 红线与回归清单

**红线（拆分别碰）**
1. **词云算法只搬不改**：`utils/wordCloudLayout.ts` 的 `MosaicPacker` / `tickForce` / `relaxLambda` 与定案参数（`BETA=0.1`、动画 α 衰减 0.994、破泡 0.997 + 8 轮、`MASS_Q=0.2`）一律不动；搬完必须复验「点击破泡 → 局部闭合填充」。
2. **浮片 DOM 契约**：`.float-pill` 的斜切、阴影、`focus-visible` 环都挂在 `::before` 上，组件必须渲染**原生 `<button class="float-pill …">`**，不得外包一层 `div`。
3. **视图重挂 key**：`PostsPage` 的 `key={`${scene.acc}|${scene.view}`}` 与 `scene-in` / `scene-exit` 入场退场编排，拆 JSX 时保持 key 位置与层级。
4. **滚动体系**：`OverlayScroll`（5 处）、无限滚动 `IntersectionObserver`、时间筛选浮层点外关闭 —— 拆分后逐一手测。

**回归清单**：直接沿用 `docs/UI-MAP.md` §E（交互浮窗清单）+ §F（滚动容器清单）+ §C6（二级界面统一规格），外加：词云破泡、换装淡入、账号切换重挂。

---

## 8. 什么时候才真的需要建库

满足任一条件即启动：

1. 出现**第二个前端消费端**（Web 版 / 移动版 / 管理台）；
2. `components/ui` + `components/common` 要**对外分发**；
3. 多产品线共享同一设计体系。

届时动作与工期（**3–5 天，其中约 60% 是基建**）：

| 步骤 | 内容 | 工时 |
|---|---|---|
| 1 | 提 `packages/ui`（`components/ui` + `components/common` + `styles/tokens.css`） | 1 天 |
| 2 | pnpm workspace + vite lib 模式 + 类型导出（`exports`/`d.ts`） | 1 天 |
| 3 | 消费端改造（`@/components/ui` → `@ddtoolkit/ui`） | 0.5 天 |
| 4 | 构建/发布/版本/文档（含 CHANGELOG 与 semver 纪律） | 1–2 天 |
| 5 | 测试与预览基建（vitest + 可选 storybook） | 0.5–1 天 |

> 结论：**在只有这一个前端的前提下，这笔投入买不到任何复用，只买到"目录更整齐"** —— 而 P0+P1 用 1.5 天就能拿到同样整齐、外加消除两处双实现。等真出现第二消费端再动。
