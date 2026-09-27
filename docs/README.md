# docs 目录导航

> 本目录的**唯一入口**。找东西先看这里：查名词/代码路径 → `GLOSSARY.md`；
> 看整体设计 → `ARCHITECTURE.md`；改具体模块 → 对应深度文档。
> 适用版本：`main`（2026-09-23，`MIGRATION_HEAD = f007`）。

## 布局约定

- **顶层 `.md`** = 活文档（随时更新、互相引用），直接点开就能读；
- **`releases/`** = 历史发布说明归档（每次发版新增一份 `v<版本>.md`）；
- **`reference/`** = 外部接口/数据存档（只读，勿手改）；
- **`tools/`** = 文档生成脚本（改完重跑即可刷新 `diagrams/`）；
- **`design/`** = 设计资产（用户 Pixso 导出 + LOGO 源 + `screenshots/`），体积大、按需查；
- **`diagrams/`** = `tools/gen_diagrams.py` 生成的 SVG 架构图；
- 历史变更记录不在这里，在仓库根 `devlog/`（每版本一篇，编号递增）。

## 1. 先看这两份（入口）

| 文档 | 什么时候看 | 内容 |
|---|---|---|
| **`GLOSSARY.md`** | **改 bug / 做需求第一步**：某个名词在代码里叫什么、在哪、牵动谁 | 9 组术语表（领域/数据/抓取/认证/前端/工程/配置/坑/需求→入口） |
| **`ARCHITECTURE.md`** | 想建立整体认知、或改动跨越多个层 | 运行时形态、12 表 ER、综合档调度、锁与优先级、数据来源地图、不变量（§6） |

## 2. 深度文档（按模块）

| 文档 | 覆盖 |
|---|---|
| `backend-repositories-and-routers.md` | 12 张表列级定义 · 13 个 Repository 方法表（含"提交"列）· HTTP 操作（路由计数口径见其 §3）· 迁移链（20 版本，head `f007`） |
| `backend-fetch-pipeline.md` | 抓取链路细节：触发入口、锁与让位、API 清单、风控判定、节流测算、停止原因 |
| `FRONTEND-ARCH.md` | 前端分层（api/hooks/components/pages/styles）、数据流、状态管理 |
| `ARCHITECTURE-IMPROVEMENT-PLAN.md` | **待执行的架构整改路线**：安全边界、调度生命周期、事务归属、核心模块拆分、API 契约、可访问性、CI；含批次依赖、测试牙口、停止条件与 Agent 汇报模板 |
| `ARCHITECTURE-IMPROVEMENT-EXECUTION.md` | 上面那份的**执行细化**（核实日期 2026-09-25）：16 个批次的实际排序与硬约束、逐批改动面/先补的失败用例/反向验证做法/门禁/停止条件，以及与母计划不一致的 17 处核实结论。**行号与数字是当日快照，不是真源** |
| `UI-MAP.md` | 界面与路由映射：四视图、组件类名、设计令牌、动效与圆角规范 |
| `design-status-island.md` | **状态胶囊动效规格**（R38 与后续「桌面独立控件」共用）：动效令牌、收起/展开时间轴、同心圆角、两种宿主材质、可断言的动效不变量 |
| `design-archive-cards.md` | **档案视图卡片视觉与动效规格**（R37-P4 / P3b 共用）：卡片材质令牌、五槽位卡片语法、三张内置卡的重排、长按拿起/退避/落位时间轴、可断言的动效不变量 |

### 2.1 设计 / 调研专题（`docs/design/`）

另一批是**专题调研与执行方案**（都带核实日期、都写明"未改代码"或"交给执行 Agent"），
按主题分两个目录；它们不是规格真源，看现状仍以 `UI-MAP.md` / 代码为准。

| 文档 | 覆盖 |
|---|---|
| `design/status-island/review.md` | **状态岛形态与主题：调研结论与建议**（2026-09-25）：四个开源项目的形态事实（直读源码）、抖动的成因归属、四条候选路线、W1 主题方案为何应被推翻 |
| `design/status-island/projects-source-review.md` | **三个开源「灵动岛 / 状态浮窗」项目源码调研**：FocuSD（唯一从架构上根除 resize 抖动）/ RustyIsland（反面教材）/ TokenNote，逐项带 `文件:行` 证据与【码】【推】【缺】标注 |
| `design/status-island/d1-form-options.md` | **D1 形态路线的执行方案**（2026-09-25）：会动的每一个数逐个核对、A/B/C/D 四条路线的代码级差异、建议 A（折叠宽 280）、受影响的测试面 |
| `design/status-island/d1-a-execution.md` | **D1 = A + 280 执行细化**（2026-09-25）：验收定义、真机证据（面板被右缘裁 8px）、批次划分（D1-a0 / D1-a / …），以及"为什么这条一直没被发现" |
| `design/status-island/evidence/` | 上面那条缺陷的**真机截图证据**（裁切前 / 裁切现场）——`d1-a-execution.md` §2.2 引用 |
| `design/notices/content-and-flow-review.md` | **状态内容汇总 + 信息流动路径 + 消息框架重建评估**（2026-09-27 只读分析）：两个宿主会显示什么、六个来源怎么流、生命周期失效矩阵，以及「**问题不是框架、是供数方**」的论证 |
| `design/notices/placement-frontend-vs-backend.md` | **「通知放前端还是后端」的收益/风险对照**（2026-09-27）：F1/F2/F3 三种"前端"的区分、六源可搬迁性盘点、会改变用户可见行为的语义风险，以及**分两步（先前端后后端）**的建议路径 |
| `design/notices/target-architecture.md` | **消息通知的改造后目标架构**（2026-09-27）：结构图、`GET /vtuber/notices` 契约、各层职责、`now` 真源、S1/S2 分步落地，以及一份「什么**不**变」清单（避免重构幻觉） |
| `design/notices/message-hub-architecture.md` | **后端消息中心 · 分层消息类型 · 跨进程分发**（2026-09-27）：延迟的真实构成（99% 在"等下次轮询"）、推送通道选型（`EventSource` 带不了 token ⇒ 用 `fetch` + `ReadableStream`）、两层消息分类、手动动作也走中心、风险清单与 M0–M5 分步 |
| `design/notices/message-hub-execution.md` | **消息中心的分批执行方案（交给执行 Agent）**（2026-09-27）：母计划 §0 九条 + 补六条、M0–M5 逐批的改动面/失败用例/反向验证/门禁/文档义务、**五条停止条件**、收尾清单与提交序列。⚠️ 含两条会踩空的坑：`token=` 判据会撞 `xsec_token=` 假红、`GET /events` 与既有 `GET /vtuber/{id}/events` 撞名。**§8 = 开工前复核（2026-09-27 第二批会话，基线 `5fb6ca0`）**：逐条复核前提成立、修正一处撞名判断，并补两处缺口（**T0 是守护线程 ⇒ publish 必须跨线程**、**V6 探针需要 dev-only 合成发布钩子**）+ 三条顺序纪律与 D/E 两条拍板建议 |
| `design/widget-preview/` | **小窗（状态 widget）形态预览与探针**（2026-09-27）：`direction.html`（**自包含**的形态方向对比页，展开上限 400），`content-*.png` / `fix*.png`（各形态与修复后截图），`probe.mjs`（该页的几何回归探针：`node docs/design/widget-preview/probe.mjs`，断言"看得见的边"位置、滚动条 = 0 等） |

## 3. 操作指南

| 文档 | 用途 |
|---|---|
| `DEV-LOOP.md` | 本地开发循环：后端直跑、前端 dev、`dev_check.py`（`--docs` / `--upstream` / `--frozen` / `--portable`）、`ui_probe.py`、`smoke_upstream.py`、打包版复现 |
| `RELEASE.md` | 发布流程：版本号同步（锚点清单 = `scripts/release.py` 的 `VERSION_FILES`）、打包三步、资源契约、GitHub 上传、代理/证书参数 |
| `platforms-extension-guide.md` | 接入新平台（继承 `BasePlatform` + 注册 + 前端常量） |
| `platforms-xhs-douyin-research.md` | **小红书 / 抖音抓取调研（2026-09-27 带日期快照）**：⚠️ **§6 是合规定性（两家协议明文禁止爬虫，本文件只是可行性调研、不是许可）**；另有接口清单、签名与反爬机制、开源项目盘点、采集引擎选型、存疑清单与复核方法 |
| `TODO.md` | 路线图：**待提需求收集区（§0）** + 未完成项（§1）+ 能力现状（§2）+ backlog/远期/不做 + 门禁基线（§6.2） |
| `ROADMAP-DONE.md` | 已完成条目详录：**已落地需求清单 + 版本→devlog 索引** + 历史条目的原始需求 / 验收 / 实现注意（2026-09-13 从 TODO.md 拆出） |

## 4. 资产与归档

| 路径 | 内容 |
|---|---|
| `design/` | 用户设计资产 + **设计专题**：`png/`（LOGO 栅格）、`svg/LOGO.svg`（矢量源）、`react-*/`（Pixso 导出设计稿）、`pills/`、`background/`、`screenshots/`（界面参考截图）；专题子目录见 §2.1（`status-island/`、`notices/`、`widget-preview/`） |
| `diagrams/` | 8 张 SVG 架构图（`01_system_architecture` … `08_evolution_timeline`）；由 `tools/gen_diagrams.py` 生成 |
| `tools/gen_diagrams.py` | 架构图生成脚本（`python docs/tools/gen_diagrams.py`） |
| `releases/` | `v0.9.1.md` / `v0.9.2.md` / `v0.9.3.md` / `v0.9.9.md` / `v1.0.0.md` / `v1.0.1.md` / **`v1.0.2.md`** 发布说明（发布时被 `scripts/upload_release_assets.py` 读取；**新增一份要回来补这一行**，`scripts/doc_check.py` 会检查） |
| `reference/danmakus-api-v2-swagger.json` | danmakus 第三方接口存档（只读参考） |

## 5. 维护约定

1. **新增术语**随手补 `GLOSSARY.md` 对应分组一行（术语 · 含义 · 代码位置 · 关联）；
2. **改数据模型/接口/抓取行为**后同步对应深度文档（表列 / 端点表 / 链路小节）；
3. **改动跨层或影响全局不变量**时更新 `ARCHITECTURE.md`，并在根 `devlog/` 追加一篇；
4. **顶层只放"现状真源"**（改了代码就要跟着改的那类：`ARCHITECTURE` / `UI-MAP` / 链路/接口文档 / `TODO` / `ROADMAP-DONE` / `DEV-LOOP` / `RELEASE`）；
   两类**进子目录**：① 归档类（发布说明 / 外部接口存档 / 生成脚本）；② **带日期的专题调研与执行方案** → `design/<主题>/`（例：`design/status-island/`、`design/notices/`、`design/widget-preview/`）。
   ⚠️ 判据不是"重要不重要"，而是**"过期了会不会误导"**：带日期的东西写清核实日、放子目录，读的人才知道它不是规格（`doc_check` 对 `docs/design-*.md` 强制要求核实日期或指向 `UI-MAP`）；
5. 文档里引用代码一律写**仓库相对路径**（如 `app/services/scheduler.py`），
   引用其他文档写 `docs/<文件>`，方便 `Ctrl+F` 全局定位。
