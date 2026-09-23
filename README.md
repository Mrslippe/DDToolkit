# Better DD Toolkit

**给你的推し建一个不会消失的档案库。**

把 B 站 / 微博上你关注的 VTuber 的动态、粉丝数、直播场次定时抓下来，存进**你自己的电脑**：
帖子被删了也有据可查，粉丝曲线不会因为平台改版而断档，直播日历一眼看清哪天播了、播了多久。
Windows 桌面应用，数据全部在本地 SQLite 里，不经过任何服务器。

![Version](https://img.shields.io/badge/version-1.0.2-ffa2b4)
![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-4b5a6f)

## ✨ 主要功能

| 功能 | 说明 |
|---|---|
| **自动归档** | 按不同节奏定时抓取：直播状态约 **60 秒**一轮、动态流自适应、账号信息约 **24 小时**一轮；也可以随时手动抓某个 V 或全部 |
| **删了也留证** | 帖子被删不会被当成「没抓到」，而是留下**墓碑标记**（删除时间 + 原文快照仍在库里）—— 这是本项目的立项理由 |
| **三个视图** | **展示页**（大头像 + 平台数值药丸）/ **帖子列表**（封面卡片流，无限滚动）/ **档案**（直播日历 + 粉丝趋势） |
| **直播日历** | 月历标出每天的场次与时长，连**未来已预约**的直播也能看到；点开某天看场次详情（弹幕词云、场次指标） |
| **粉丝趋势** | 双轴折线图（粉丝数 / 增减量），可框选一段时间放大细看 |
| **搜索与筛选** | 关键词（标题 / 摘要 / 正文）、内容类型、时间范围（双月历 + 近一周/一月/一年…预设）、是否已归档 / 已删 |
| **后台常驻** | 关窗口 = 收进托盘，**后台照抓、不降速**；点托盘图标唤回窗口、右键菜单退出；隐藏满 10 分钟自动释放界面内存（抓取不受影响） |
| **数据全在本地** | SQLite 库 + 图片缓存都存在本机；数据目录能搬到别的盘；图片缓存有容量上限，不会无限膨胀 |
| **应用内更新** | 设置里检查更新 → 下载 → 重启安装（安装包带签名校验，换过包会被拒） |
| **账号信息留痕** | 每个账号的**曾用名 / 曾用签名 / 历史快照**随时可查，「TA 什么时候改过什么」不用再靠记忆 |
| **登录与否都能用** | 不登录也能抓账号信息与归档类数据；扫码登录后解锁投稿 / 动态等内容抓取，受限项会**明确标注**而不是偷偷少抓 |

## 📥 下载与安装

**系统要求**：Windows 10 / 11（64 位）。WebView2 运行时 —— Win11 自带，Win10 缺失时安装包会自动联网装。

| 配置 | 最低 | 舒服 |
|---|---|---|
| 系统 | Win10 1809+ / Win11（64 位） | 同左 |
| CPU | **双核**（抓取靠定时器，不靠算力） | 4 核 |
| 内存 | **4 GB** | 8 GB |
| 磁盘 | 程序约 150 MB + 数据（实测 8 个 V / 11 个账号约 160 MB，图片缓存上限 300 MB） | SSD |

实测占用（便携版 1.0.2、空数据目录、本机 6 核 / 14GB）：**空闲内存约 250 MB**（后端 ~85 + WebView2 ~150 + 主程序 ~9）、**空闲 CPU 几乎为 0**、点图标到界面可用 **约 2.5 秒**（首次启动 4 秒左右，要初始化数据库）。

老机器上真正会慢的是**启动**和**第一次打开词云 / 趋势图**；跑起来之后它就挂在托盘里，不影响你干别的。**内存紧张的机器建议点「✕」收进托盘** —— 界面进程十分钟后会被销毁，占用降到 **90 MB 左右**，唤回时自动重建。

> 这些数字怎么来的、怎么在自己机器上复测：见 `docs/ARCHITECTURE.md` §3.13；命令行一条 `python scripts/perf_report.py` 就能重跑一遍。

| 版本 | 适合谁 | 说明 |
|---|---|---|
| **安装版**<br>`DDtoolkit_1.0.2_x64-setup.exe`（约 58 MB） | 大多数人 | **用户级安装，不需要管理员权限**；带开始菜单与卸载项；支持应用内自动更新 |
| **便携版**<br>`DDtoolkit-portable-win64.zip`（约 72 MB） | 放 U 盘 / 不想安装 | 解压即用，主程序与后端在同一目录 |

到 **[Releases](https://github.com/Mrslippe/DDToolkit/releases/latest)** 页面下载。

> 为什么一个抓取工具要几十 MB？因为 **Python 运行时和后端一起打包进去了** —— 装完不需要你另外装 Python、也不需要装数据库。

安装版双击一路下一步即可。程序没有购买代码签名证书，Windows 首次运行可能弹 SmartScreen 提示：点「更多信息 → 仍要运行」。

## 🚀 第一次打开

1. **启动**：先看到启动幕（约 1 秒）。首次启动要初始化数据库并导入内置候选名单，比之后慢一点是正常的。
2. **登录（可选，但推荐）**：空数据目录首次启动会自动弹出扫码登录窗 —— B 站与微博都支持，凭据只存在本地数据目录里。
3. **添加要关注的 V**：左栏「＋」→ 从内置名单里挑，或按关键字搜索后收录；收录后会自动抓首屏数据。
4. **等第一轮抓完**：顶栏状态区会显示进度（「动态更新中 - 某 V - 3/10」这类），跑完帖子、粉丝数、直播场次就都有了。
5. **日常使用**：点「✕」把窗口收进托盘，抓取继续在后台跑；要看了点托盘图标唤回。

## 🧭 界面上都有什么

| 位置 | 能做什么 |
|---|---|
| **左栏** | 订阅的 V 列表（头像 / 名字 / 签名 / 直播中标记）。顶部工具行：添加、筛选、搜索、只看直播中、批量拉取 |
| **顶栏** | 中间的状态区：抓取进度、完成报告、登录失效、风控冷却都会在这里出现，**没事发生时不占地方**；右侧是能力受限提示、登录入口与窗口按钮 |
| **最左图标栏** | 帖子浏览、设置（左下齿轮） |
| **展示页** | 大头像 + 平台数值（粉丝数等，**可拖动排序、点击开主页**）+ 「档案设置」窗口（背景图 / 头像 / 签名 / 账号管理） |
| **帖子列表** | 卡片流（封面、标题、播放/点赞/评论/转发、日期），滚到底自动加载；所有筛选条件收在一个「筛选」按钮里，按钮上显示生效条数 |
| **数据视图** | 直播日历卡 + 粉丝趋势卡 |
| **档案视图** | **卡片画布**（三张卡：纪念日倒计时 · 优质投稿榜 · 大事记；点投稿开详情）—— **可拖动换位、拖右下角改大小**（「编辑布局」进入编辑态，窄窗自动单列且暂不可编辑） |
| **设置**（左下齿轮） | 四类：**外观** / **抓取设置**（节奏与风控，关键项直出、调优项收在「高级设置」里）/ **数据源** / **关于**（版本、数据目录、存储占用、应用更新） |

> 「档案视图」与「数据视图」的命名是 2026-09-17 定下的（原来分别叫「档案卡」与「档案」）。

## 🗂️ 数据放在哪

| 情况 | 数据目录 |
|---|---|
| 默认（安装版 / 便携版都一样） | `%APPDATA%\com.ddtoolkit.app` |
| 设了环境变量 `DDTOOLKIT_DATA_DIR` | 用它（便携 / 绿色部署推荐） |
| 在应用内迁移过 | 用迁移后的新位置 |

优先级：**环境变量 > 应用内迁移记录 > 默认目录**。

- 库里就是全部数据：`vtuber.db`（SQLite）、`logs/`（日志）、`static/img-cache`（图片缓存）、`.env`（登录凭据、只在本机）。**备份这一个目录就够了。**
- **换盘**：设置 → 关于 → 迁移数据目录。应用会停后端 → 复制 → **逐文件校验** → 用新目录重启并自检；任一步失败自动回滚，原目录一个字节不动。数据目录由环境变量指定时不显示该入口（环境变量优先级最高）。
- **占空间的大头是图片缓存**，上限 **300 MB**（超出按最久未使用淘汰）；设置里能看到各项占用、一键清理图片缓存、整理数据库。实测 8 个 V / 11 个账号长期使用约 **160 MB**（库 54 MB + 缓存 102 MB + 日志 6 MB）。
- 磁盘剩余不足 **5 GB** 时会提示一次「空间偏紧」（最多 3 天提示一次，不打扰）。

## ❓ 常见问题

<details>
<summary>数据会不会把 C 盘塞满？</summary>

两个机制兜着：图片缓存有 300 MB 上限、自动淘汰；空间偏紧时会提示。真嫌占地方，用「设置 → 关于 → 迁移数据目录」整体搬到 D 盘/E 盘，原目录会被清掉（迁移成功后提供删除入口）。

</details>

<details>
<summary>关掉窗口后还在抓吗？</summary>

在。点「✕」默认会问一次「最小化到托盘 / 直接退出」，你的选择会被记住。托盘模式下**抓取节奏和开着窗口时一样快**（隐藏的只是界面渲染与界面自己的轮询），所以托盘期间照样能攒数据。被上游限流时，**托盘提示会显示「风控冷却中 · 剩余 N 分钟」**（鼠标悬停托盘图标即可看到），不用打开界面也知道还要等多久。

</details>

<details>
<summary>「检查更新」失败是什么原因？</summary>

两种情况，提示里会区分：**网络不通**（连不上 GitHub，通常是代理问题 —— 程序会跟随系统代理）或**远端还没有可取用的版本**（Release 还没发布 / 资源未上传完）。发布页也可从更新面板直接打开。

</details>

<details>
<summary>帖子显示「已删除」是什么意思？</summary>

平台上下架了这条内容，而我们在它消失前后抓过。这类帖子会打上墓碑标记（记录检测到删除的时间），但**正文与图片仍留在你的库里**；默认照常出现在列表中（带标记），也可以在「筛选 → 状态」里只看已删的那些。

</details>

<details>
<summary>不登录能用吗？功能差在哪？</summary>

账号信息、粉丝趋势、归档与浏览都不需要登录。**投稿 / 动态等内容抓取需要登录**（B 站 / 微博扫码）。顶栏会显示「未登录 · N 项受限」，点开能看到「现在能做什么、哪些受限、为什么」，受限项**照常可见、只标注不隐藏**。

</details>

<details>
<summary>会占端口 / 被防火墙拦吗？</summary>

后端只监听本机 `127.0.0.1` 上的一个空闲端口，不对外提供服务，也不需要放行防火墙。端口号在设置 → 关于里能看到。

</details>

<details>
<summary>出问题了去哪看日志？</summary>

数据目录下的 `logs/`：后端日志 `app.log`、桌面壳日志 `shell.log`（迁移、更新、托盘相关的问题看这个）。

</details>

## 🔌 数据从哪来

| 来源 | 内容 | 频率 |
|---|---|---|
| **B 站**（直采） | 账号信息、粉丝数、投稿、动态、直播状态、直播预约 | 直播状态约 60 秒 / 动态流自适应 / 账号信息约 24 小时 |
| **微博**（直采） | 账号信息、粉丝数、时间线 | 同上 |
| [zeroroku.com](https://zeroroku.com) | 粉丝历史（补历史空洞）、直播礼物日聚合 | 每日 3:00 |
| [danmakus.com](https://ukamnads.icu) | VTuber 索引（企划 / 公会 / 房间号）、直播场次与场次级指标 | 索引每周一 3:30；场次按查询实时拉取 |

第三方源可在「设置 → 数据源」里单独开关。接口可用性、数据准确性、平台条款变化都不受本项目控制。

> **免责**：本项目是**个人研究归档工具**，不提供商业数据服务。请遵守目标平台的服务条款与当地法律法规使用。

## 🛠️ 从源码运行（开发者）

<details>
<summary>技术栈 · 目录结构 · 本地开发与测试 · 打包发布</summary>

**技术栈**

- 后端：Python 3.14 + FastAPI + SQLAlchemy 2.0 + SQLite（WAL）+ APScheduler + Alembic
- 前端：Vite 5 + React 18 + TypeScript + Tailwind CSS v4 + Radix 风格组件 + ECharts 6（图表 canvas 自绘）
- 桌面壳：Tauri v2（负责拉起后端、注入数据目录、Job Object 进程看门狗、托盘与深休眠）

**目录结构**

```
├─ app/               后端源码（FastAPI 分层）
│  ├─ routers/        HTTP 路由层（vtuber / auth / img_proxy / settings；计数口径见 docs/backend-repositories-and-routers.md §3）
│  ├─ repositories/   SQL 访问层（11 个仓库类，ORM 不泄漏到路由）
│  ├─ models/         SQLAlchemy ORM（12 张表：vtubers / accounts / posts / 快照 / 场次 / app_meta / 曾用值 / 卡片布局 …）
│  ├─ schemas/        Pydantic 输入输出模型
│  ├─ services/       抓取调度（T0–T4 分层）、平台接入、第三方源、认证、WBI、类型引擎、数据库维护
│  └─ core/           配置（数据目录 / 环境变量）、数据库引擎与 PRAGMA
├─ alembic/           数据库迁移链（a001 → f007，20 个版本，启动时自动升级）
├─ tests/             pytest 测试（用例基线见 docs/TODO.md §6.2）
├─ scripts/           维护与构建脚本（dev_check / ui_probe / doc_check / build_backend / collect_release 等）
├─ devlog/            开发日志（按批次一篇，当前 001–118）
├─ docs/              文档：入口见 docs/README.md（术语表 / 架构 / 深度文档 / 指南 / 设计资产）
├─ frontend/          前端（Vite + React）+ 桌面壳（src-tauri）
├─ backend_main.py    桌面端后端入口（Tauri 以子进程拉起，含父进程看门狗）
└─ vtubers.csv        内置默认 VTuber 名单（首次启动引导到数据目录）
```

**本地开发**

```powershell
# 桌面开发（一键：后端 + 前端 + Rust 壳）
cd frontend
npm install
npm run tauri:dev

# 仅后端（数据目录回退到项目根，见下）
pip install -r requirements.txt
python backend_main.py

# 测试与检查
python -m pytest tests -q -p no:cacheprovider          # 后端（用例基线见 docs/TODO.md §6.2）
python scripts/dev_check.py --docs                      # 开发态自检（后端链路）+ 文档漂移门禁
python scripts/ui_probe.py                              # 界面布局不变量（真实浏览器三档宽度）
frontend\node_modules\.bin\tsc.cmd -p frontend\tsconfig.json --noEmit
```

> `-p no:cacheprovider`：历史遗留的 `frontend/pytest-cache-files-*` 与根 `.pytest_cache`
> 目录存在权限锁时，pytest 的缓存读写会报错；这些目录属于可重建残留，可在管理员权限下删除。

未注入 `DDTOOLKIT_DATA_DIR` 时（裸 uvicorn / 脚本直跑），数据目录回退到**项目根**；桌面壳启动时通过环境变量注入。项目根若出现 `vtuber.db` / `logs/` / `static/`，说明是「裸直跑」留下的运行时数据（已 gitignore），不是源码。

**打包发布**（产物统一在 `dist-release/`）

```powershell
# 一键发布（维护者：版本同步 → 门禁 → 打版 → 产物校验 → 提交/tag → 推送 → GitHub Release）
python scripts/release.py 1.0.2          # --dry-run 先预演；--bump patch 自动算版本号
                                         # 失败后续跑：--from <步骤>；详见 docs/RELEASE.md

# 一键打包（后端 → 桌面应用 → 聚合：安装包 + 便携版）
npm run release --prefix frontend

# 分步（改其一后只跑对应步）
npm run build:backend   --prefix frontend   # ① 后端 → PyInstaller onedir
npm run tauri:build     --prefix frontend   # ② 前端构建 + Rust release + NSIS 安装包
npm run collect:release --prefix frontend   # ③ 聚合产物到 dist-release/
```

产物：`DDtoolkit_<版本>_x64-setup.exe`（NSIS 安装包）、`DDtoolkit-portable-win64.zip`（便携版）、
`latest.json`（应用内更新的清单，带签名）。后端被打进安装包 resources，主程序启动时自动拉起并注入空闲端口；
Rust 子进程由 [Job Object 看门狗](frontend/src-tauri/src/lib.rs) 管理，主程序退出即整棵终止。

</details>

## 📚 文档索引

> 完整索引见 **`docs/README.md`**（按「入口 / 深度文档 / 指南 / 资产归档」分组）。

| 文档 | 内容 |
|---|---|
| `docs/GLOSSARY.md` | **术语表**：名词 → 含义 → 代码路径 → 依赖（改 bug / 做需求先查这里） |
| `docs/ARCHITECTURE.md` | **架构总览**：运行时形态 / 数据模型（12 表）/ 抓取分层与优先级 / 数据来源地图 / 不变量 |
| `docs/backend-repositories-and-routers.md` | 表结构 · 12 个 Repository · HTTP 路由计数（三种数法见该文 §3） |
| `docs/backend-fetch-pipeline.md` | 抓取链路详解（频率 / API 清单 / 风控判定 / 节流测算） |
| `docs/FRONTEND-ARCH.md` | 前端分层、数据流与 hooks |
| `docs/UI-MAP.md` | 界面与路由映射（类名 / 设计令牌 / 动效） |
| `docs/DEV-LOOP.md` | 本地开发与机器验证（dev_check / ui_probe / 探针模式） |
| `docs/RELEASE.md` | 打包与发布流程（签名密钥、产物校验） |
| `docs/platforms-extension-guide.md` | 接入新平台的扩展指南 |
| `docs/TODO.md` | 路线图：待提需求收集区 + 未完成项 + 能力现状 + 门禁基线 |
| `docs/ROADMAP-DONE.md` | 已完成：已落地需求清单 + 版本 → devlog 索引 |
| `devlog/` | 每个批次的变更记录（001–118） |

## 📄 许可与第三方声明

**项目自身代码**：[LICENSE](LICENSE)（MIT License）。你可以在遵守条款的前提下自由使用、修改、分发。

**嵌入字体**（随仓库 / 安装包分发，均有明确开源或免费商用许可）：

| 字体 | 许可 | 用途 |
|---|---|---|
| [阿里妈妈方圆体](https://www.yuque.com/alimama_ai-font/vfse9w/fco5g1gifud8lls2?singleDoc)（可变字重） | 阿里妈妈官方许可：免费商用 + **嵌入式使用**（[声明第 3 条](https://www.yuque.com/alimama_ai-font/vfse9w/fco5g1gifud8lls2?singleDoc)；[FAQ2](https://www.yuque.com/alimama_ai-font/vfse9w/co47p8ge57qsanz2?singleDoc)：嵌入 app 不侵权，但不得就字体使用收费；不可二次创作 / 商标注册） | 全站唯一字体（`--font-family`；顶栏标题 `--font-title` 同源） |

> 原顶栏字体（千图小兔体·iFonts 联名 / 字小魂锐艺黑·试用版）因许可限制（禁嵌入式 / 商用需授权）**不随仓库分发**，
> 本地备份于 `frontend/src/assets/fonts/_nondistribute/` 与 `docs/design/react-topbar/src/assets/fonts/_nondistribute/`（已 gitignore）。

**主要第三方库**（详见各包许可文件）：FastAPI / SQLAlchemy / Alembic（MIT）、Tauri v2（MIT / Apache-2.0）、
React（MIT）、ECharts（Apache-2.0）、Radix UI（MIT）、Tailwind CSS（MIT）、Vite / TypeScript（MIT / Apache-2.0）、
Windows 打包依赖 PyInstaller（GPLv2 + PyInstaller 例外）。
