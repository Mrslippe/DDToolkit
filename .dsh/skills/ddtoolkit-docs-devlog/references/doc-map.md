# 活文档逆索引（改了 X → 哪份必须更新）

> **规则文本见 `docs/README.md` §5；本表只做逆索引**（每份活文档管什么、什么时候**必须**更新它）。
> 权威来源：`docs/README.md`（docs 目录唯一入口）与各文档自身的章节标题。
> **顶层 `.md` = 活文档**（随时更新、互相引用）；归档类进子目录。
> ⚠️ 活文档的**份数以 `docs/README.md` 的清单为准**，本表只列"更新时机"这一维度，不写份数。

## 一、活文档 → 什么时候必须更新它

| 文档 | 覆盖什么（真实章节） | 什么时候**必须**更新它 |
|---|---|---|
| `docs/README.md` | docs 目录导航：布局约定 + 四组文档「什么时候看」+ §5 维护约定 | 新增/移动任一活文档、新增 `docs/releases/v*.md`（§4 列表那一行）、布局约定变更 |
| `docs/GLOSSARY.md` | §1 领域名词 · §2 数据模型与字段 · §3 抓取与调度 · §4 认证与凭据 · §5 前端与界面 · §6 工程与流程 · §7 配置项速查 · §8 不变量与常见坑（**已并入 `ARCHITECTURE.md` §6**，只剩旧编号换算）· §9 需求/缺陷→代码入口（共 9 组） | 出现新名词/新坑、`app/core/config.py` 加配置项、改名或搬迁代码路径 |
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

## 三、已知文档漂移

**只剩第 6/7 条未决**：R19/R20 在 `docs/ROADMAP-DONE.md` 缺需求章节（用户明确暂缓）。
其余各条已修 —— **别照着旧文再改回去**；口径一律以源码 / 脚本 / `docs/README.md` 为准。
