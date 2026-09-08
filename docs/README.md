# docs 目录导航

> 本目录的**唯一入口**。找东西先看这里：查名词/代码路径 → `GLOSSARY.md`；
> 看整体设计 → `ARCHITECTURE.md`；改具体模块 → 对应深度文档。
> 适用版本：`main`（2026-09-09，`MIGRATION_HEAD = e007`）。

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
| **`ARCHITECTURE.md`** | 想建立整体认知、或改动跨越多个层 | 运行时形态、9 表 ER、综合档调度、锁与优先级、数据来源地图、10 条不变量 |

## 2. 深度文档（按模块）

| 文档 | 覆盖 |
|---|---|
| `backend-repositories-and-routers.md` | 9 张表列级定义 · 9 个 Repository 方法表 · 47 个 HTTP 端点 · 迁移链 |
| `backend-fetch-pipeline.md` | 抓取链路细节：触发入口、锁与让位、API 清单、风控判定、节流测算、停止原因 |
| `FRONTEND-ARCH.md` | 前端分层（api/hooks/components/pages/styles）、数据流、状态管理 |
| `UI-MAP.md` | 界面与路由映射：四视图、组件类名、设计令牌、动效与圆角规范 |

## 3. 操作指南

| 文档 | 用途 |
|---|---|
| `DEV-LOOP.md` | 本地开发循环：后端直跑、前端 dev、`dev_check.py`、`ui_probe.py`、打包版复现 |
| `RELEASE.md` | 发布流程：版本号同步 5 处、打包三步、资源契约、GitHub 上传、代理/证书参数 |
| `platforms-extension-guide.md` | 接入新平台（继承 `BasePlatform` + 注册 + 前端常量） |
| `TODO.md` | 路线图与现状盘点（已完成项 + backlog + 明确不做） |

## 4. 资产与归档

| 路径 | 内容 |
|---|---|
| `design/` | 用户设计资产：`png/`（LOGO 栅格）、`svg/LOGO.svg`（矢量源）、`react-*/`（Pixso 导出设计稿）、`pills/`、`background/`、`screenshots/`（界面参考截图） |
| `diagrams/` | 8 张 SVG 架构图（`01_system_architecture` … `08_evolution_timeline`）；由 `tools/gen_diagrams.py` 生成 |
| `tools/gen_diagrams.py` | 架构图生成脚本（`python docs/tools/gen_diagrams.py`） |
| `releases/` | `v0.9.1.md` / `v0.9.2.md` 发布说明（发布时被 `scripts/upload_release_assets.py` 读取） |
| `reference/danmakus-api-v2-swagger.json` | danmakus 第三方接口存档（只读参考） |

## 5. 维护约定

1. **新增术语**随手补 `GLOSSARY.md` 对应分组一行（术语 · 含义 · 代码位置 · 关联）；
2. **改数据模型/接口/抓取行为**后同步对应深度文档（表列 / 端点表 / 链路小节）；
3. **改动跨层或影响全局不变量**时更新 `ARCHITECTURE.md`，并在根 `devlog/` 追加一篇；
4. **新增活文档放顶层**；归档类（发布说明/外部接口存档/生成脚本）进对应子目录；
5. 文档里引用代码一律写**仓库相对路径**（如 `app/services/scheduler.py`），
   引用其他文档写 `docs/<文件>`，方便 `Ctrl+F` 全局定位。
