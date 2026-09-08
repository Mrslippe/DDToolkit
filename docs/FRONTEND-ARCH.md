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
| 工作量 | P0 清理 **0.5 天 ✅ 已落地（净减 334 行）** · P1 共享件 **1 天** · P2 巨型文件拆分 **2–3 天** · P3 基建 **2 天（可选）** |
| 拿 80% 收益 | **P0 + P1 ≈ 1.5 天**（净减约 400 行、消除 2 处双实现） |

---

## 1. 体检数据

### 1.1 体量与分布

| 维度 | 数据 |
|---|---|
| 代码文件 | 51 个（39 tsx + 12 ts），8,816 行 |
| 样式文件 | 4 个，4,027 行（`posts.css` 2,761 / `layout.css` 1,082 / `tokens.css` 95 / `index.css` 89） |
| 组件总数 | 35 个（`components/ui` 15 + `components/` 业务 20） |
| 页面 | 2 个（`PostsPage` 1,299 行、`EmptyState` 13 行） |
| 最大文件 | `pages/PostsPage.tsx` 1,299 行、`components/LiveCalendar.tsx` 1,186 行、`styles/posts.css` 2,761 行 |

### 1.2 现有分层（已经存在，不用新建）

| 层 | 位置 | 状态 |
|---|---|---|
| 设计令牌 | `styles/tokens.css`（95 行） | ✅ 完整，全部 `var(--token)` 引用 |
| 基础件（primitives） | `components/ui/*`（shadcn + Radix，15 件，`components.json` 已配置） | ✅ 在用 12 件，3 件死代码 |
| 共享工具 | `utils/format.ts`（10 个引用者）、`utils/chartTheme.ts`、`hooks/useFetchBusy`、`hooks/useIsMaximized` | ✅ 复用良好 |
| 业务组件 | `components/*`（20 件） | ⚠️ 17/20 只有 1 个引用者（属"功能"而非"基础件"） |
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
| CSS 组织 | 351 个选择器按 feature 前缀分区（`lc-*` / `post-card-*` / `profile-*` / `fan-*` / `image-viewer-*`），带中文分区注释 |
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
层1 基础件       components/ui/*（shadcn 15 → 在用 12）  ← 已存在，删死件
层2 共享复合件   components/common/*                    ← 本次抽取目标（新建）
层3 业务组件     components/{posts,live,chart}/*        ← 现有 20 件，按域归目录
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

### P1 · 共享复合件（1 天）

| 任务 | 来源 | 规模 | 工时 | 风险 |
|---|---|---|---|---|
| `components/common/ProxyImage.tsx` | `SmartImage` 升级 | ~90 行 | 1h | 低 |
| `components/common/FloatPill.tsx`（`size`/`icon`/`text`/`danger`/`on`，渲染原生 `<button class="float-pill …">` 保持 `::before` 契约） | `.float-pill` 34 处裸用（PostsPage 9 / VtuberSidebar 3 / ProfileCard 1 行 + 变体拼串） | ~70 行 | 2h | **中**（斜切/阴影/焦点环/禁用态） |
| `components/common/StateBlock.tsx`（loading / empty / error 三态） | `posts-placeholder` / `.lc-state` / `<Alert>` 三套写法 | ~50 行 | 1.5h | 低 |
| `components/common/StatPill.tsx`（平台药丸） | `PostsPage` 987–993 内联 | ~40 行 | 1h | 低 |
| 用 `FloatPill` 统一 `.lc-nav-btn` / `.lc-nav-pill` | `posts.css` 1592–1651 | −60 行 CSS | 1.5h | **中**（日历导航视觉） |

### P2 · 巨型文件拆分（2–3 天）

| 任务 | 来源（行号） | 目标 | 工时 | 风险 |
|---|---|---|---|---|
| `components/wordcloud/MosaicCloud.tsx` + `utils/cloudPalette.ts` | `LiveCalendar.tsx` 181–447 | 词云组件独立 | 2h | **中**（rAF / ResizeObserver / 闭包引用多） |
| `components/live/LiveSessionDialog.tsx` | `LiveCalendar.tsx` 场次详情（`lc-dlg` 家族） | 弹窗独立 | 3h | 中 |
| `hooks/useLiveSessions.ts` | `LiveCalendar.tsx` 数据加载 / 月份 / 分类状态 | 逻辑外移 | 2h | 中 |
| `components/posts/HeroCardsView.tsx` | `PostsPage.tsx` 957–1013 | 展示页视图 | 1.5h | 中 |
| `components/posts/PostListView.tsx` | `PostsPage.tsx` 1034–1130 | 列表页视图 | 2h | 中 |
| `hooks/useVtuberActions.ts` | `PostsPage.tsx` 572–713（6 个 `handle*`） | 25 → ~15 个 state | 2h | 中 |

**预期结果**：`PostsPage.tsx` 1,299 → ~700 行；`LiveCalendar.tsx` 1,186 → ~450 行。

### P3 · 基建（2 天，可选）

| 任务 | 工时 | 说明 |
|---|---|---|
| eslint + prettier + `npm run lint` | 0.5 天 | 巨型文件里未使用变量/依赖数组漏项靠人眼 |
| vitest 冒烟：`format` / `wordCloudLayout` 纯函数 + 2 个渲染快照 | 1 天 | 词云几何算法（单调性/面积偏差）最值得测 |
| storybook | — | **不建议**：单应用、无跨端复用，维护成本 > 收益 |

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
