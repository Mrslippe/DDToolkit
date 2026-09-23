# 文档全景表（哪份管什么 · 什么时候必须更新）

> 权威来源：`docs/README.md`（docs 目录唯一入口）与各文档自身的章节标题。
> **顶层 `.md` = 活文档**（12 份，随时更新、互相引用）；归档类进子目录。

## 一、12 份活文档

| 文档 | 覆盖什么（真实章节） | 什么时候**必须**更新它 |
|---|---|---|
| `docs/README.md` | docs 目录导航：布局约定 + 四组文档「什么时候看」+ §5 维护约定 | 新增/移动任一活文档、新增 `docs/releases/v*.md`（§4 列表那一行）、布局约定变更 |
| `docs/GLOSSARY.md` | §1 领域名词 · §2 数据模型与字段 · §3 抓取与调度 · §4 认证与凭据 · §5 前端与界面 · §6 工程与流程 · §7 配置项速查 · §8 不变量与常见坑 · §9 需求/缺陷→代码入口（共 9 组） | 出现新名词/新坑、`app/core/config.py` 加配置项、改名或搬迁代码路径 |
| `docs/ARCHITECTURE.md` | §0 一句话定位 · §1 运行时形态（进程/线程/协程）· §2 数据模型（12 张表 · 迁移链 a001 → f007）· §3 抓取技术架构 · §4 数据来源地图 · §5 分层与依赖方向 · §6 不变量与纪律（**改代码前必读**）· §7 扩展点 | 改动跨层、动到不变量、加表/加迁移、加数据源 |
| `docs/backend-repositories-and-routers.md` | §1 数据库结构（列级）§1.3 迁移链（alembic，20 版本，head = `f007`）· §2 Repositories（12 个类的方法表）· §3 Routers · §4 分层注意点 | 改表/列/索引/迁移、加 Repository 方法、加/改 HTTP 端点（§3 的口径数字要重新数） |
| `docs/backend-fetch-pipeline.md` | 抓取链路细节：触发入口、锁与让位、API 清单、风控判定、节流测算、停止原因 | 改抓取链路、调度、并发/锁、节流与风控判定 |
| `docs/FRONTEND-ARCH.md` | 前端分层（api/hooks/components/pages/styles）、数据流、状态管理 | 前端分层变化、hook 搬迁/新增、状态管理口径变化 |
| `docs/UI-MAP.md` | 界面与路由映射：§0 启动链路 · A 壳层（A1 顶栏/A2 图标栏/A3 左栏）· B 右栏（B1 帖子/B2 详情/B3 场次/B4 趋势）· C 设计令牌与浮片 · D 字体 · E 交互浮窗 · F 滚动条标准 | 改界面结构、类名、设计令牌、动效、圆角、滚动容器 |
| `docs/DEV-LOOP.md` | 本地开发循环：后端直跑、前端 dev、`dev_check.py` 参数、`ui_probe.py`、`smoke_upstream.py`、打包版复现 | 新增/改名验证脚本、改一把梭参数、新增探针模式 |
| `docs/RELEASE.md` | 发布流程：版本号同步、打包三步、资源契约、GitHub 上传、代理/证书参数 | 发布步骤变化、版本号锚点变化、网络/GitHub 处置口径变化 |
| `docs/platforms-extension-guide.md` | 平台爬虫框架（`app/services/platforms`）、新平台接入步骤、微博接口速查、扫码登录 | 接入新平台、改 `BasePlatform` 契约、改注册方式或前端常量 |
| `docs/TODO.md` | §0 待提需求收集区 · §0.1 怎么提需求 · §1 未完成项（1.1 可立刻动手 / 1.2 需先定口径 / 1.3 用户侧动作 / 1.4 已搁置）· §2 能力现状 · §3 Backlog · §4 明确不做 · §5 远期构想 · §6.2 当前门禁基线 | 收到新需求、状态流转、门禁数字变化、发版状态变化 |
| `docs/ROADMAP-DONE.md` | 已完成条目详录（各「需求清单：R…」章节的原始需求 + 验收 + 实现注意）· **「批次 → devlog 索引」**（原 TODO §6.1） | 需求落地搬迁、写完 devlog 回填索引（一格只放裸编号） |

## 二、归档与资产子目录（只加不改）

| 路径 | 规矩 |
|---|---|
| `docs/releases/` | 每次发版新增一份 `v<版本>.md`（Release notes 来源，`upload_release_assets.py` 直接读）；**新增后回填 `docs/README.md` §4 列表**。现有 v0.9.1 / v0.9.2 / v0.9.3 / v0.9.9 / v1.0.0 / v1.0.1 / v1.0.2 |
| `docs/reference/` | 外部接口/数据存档，**只读、勿手改**（`danmakus-api-v2-swagger.json`） |
| `docs/tools/` | 文档生成脚本（`gen_diagrams.py`），改完重跑刷新 `diagrams/` |
| `docs/design/` | 用户设计资产（LOGO 栅格/矢量、Pixso 导出稿、`screenshots/`），体积大、按需查 |
| `docs/diagrams/` | `tools/gen_diagrams.py` 生成的 8 张 SVG 架构图 |

## 三、写文档的两条硬约定（`docs/README.md` §5）

1. 引用**代码**一律写仓库相对路径（`app/services/scheduler.py`）；引用**其他文档**写 `docs/<文件>` —— 便于 `Ctrl+F` 全局定位。
2. 新增活文档放 `docs/` **顶层**；归档类（发布说明 / 外部接口存档 / 生成脚本）进对应子目录。

---

## 四、已知文档漂移（2026-09-15 实读，供交叉核对 —— 以代码为准）

> 这些是**已存在的不一致**，不是本技能的规则。遇到时以源码/脚本为权威，顺手修文档。
>
> **2026-09-16 状态（devlog/098 + 099 复核后）**：第 **1–5、9 条已修**（保留作漂移样本，别照着旧文再改回去）；
> **仍未决的只有第 6、7 条**（R19/R20 在 `ROADMAP-DONE.md` 缺需求章节 —— 用户明确暂缓）。

| # | 漂移 | 权威口径 |
|---|---|---|
| 1 | **版本号同步「5 处」vs「6 处」**：`RELEASE.md` §2 标题写「5 处必须一致」，而同节正文写「分散在 5 个文件…另有 README 顶部徽章，共 **6 处**」；`docs/README.md` §3、`GLOSSARY.md` §7、`ROADMAP-DONE.md` 索引 082 行、`devlog/039`、`devlog/082` §二.1 仍写「5 处」 | **6 个锚点 = 5 个文件 + README 徽章**（`release.py` 的 `VERSION_FILES` 6 项、`doc_check.py`「六处」、`devlog/084`） |
| 2 | `GLOSSARY.md` 配置项速查表里 `VERSION` 的值仍写 `1.0.0`，且括号里「与 5 处同步」漏了 README 徽章 | `app/core/config.py` 实际 `VERSION: str = "1.0.2"`；共 6 处 |
| 3 | 路由数：`docs/README.md` §2 与 `ARCHITECTURE.md` 开头都写「**54 个 HTTP 操作**」 | `backend-repositories-and-routers.md` §3 已复核：**64 个装饰器 / `app.routes` 70 / 方法×路径 67**（2026-09-23 实测） |
| 4 | `DEV-LOOP.md` §二写 `--full` = `--frozen --portable` | `scripts/dev_check.py` 实际 `--full` = `--frozen --portable --docs --upstream`（帮助文本与代码一致） |
| 5 | `RELEASE.md` 头部写「最近发布：**v1.0.0**（2026-09-14）」 | `TODO.md` §1.3：v1.0.1 已发布（release id 389029336）、**v1.0.2 tag 已推送、GitHub Release 待建** |
| 6 | `TODO.md` §0 给 R19/R20 写「详见 `docs/ROADMAP-DONE.md`」，但该文件只有 R1–R18 的「需求清单」章节，R19/R20 **仅出现在「批次 → devlog 索引」行**（096/097） | 维护约定要求「原文照抄 + 落地结论 + devlog 指向」→ R19/R20 的章节尚未补 |
| 7 | `docs/README.md` §3 把 `ROADMAP-DONE.md` 描述为「已落地需求清单（**R1–R10**）」 | 该文件已覆盖 R1–R18（章节：R13 / guest mode / R11 / R12–R17 / R18 / R1–R10）；R19/R20 尚未建章节，见第 6 条 |
| 8 | devlog 编号 **缺 068 与 161**（跳号不补）；序号取「最大 +1」即可 | ⚠️ **别写死编号** —— 每写一篇就作废，门禁会红。查真值：`python scripts/gen_doc_numbers.py --list` |
| 9 | `RELEASE.md` §5「输出示例」把 Release id `388158299` 标成 v1.0.1 | `devlog/082` 记录该 id 属于 **v1.0.0**（示例而已，低危） |

> 当前 `python scripts/doc_check.py` 实测：**0 FAIL / 1 WARN**（WARN = 41 篇早期 devlog 未逐篇进索引，
> 索引历史上按批次建立，不阻塞）。
