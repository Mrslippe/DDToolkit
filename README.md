# Better DD Toolkit（DDtoolkit）

个人向 **VTuber 帖子 / 账号证据归档工具**：定时抓取 B 站与微博的动态、账号统计并归档到本地 SQLite，桌面端浏览与管理。

- 后端：Python 3.14 + FastAPI + SQLAlchemy 2.0 + SQLite（WAL）+ APScheduler + Alembic
- 前端：Vite + React 18 + TypeScript + Tailwind CSS v4 + Radix/shadcn 风格组件 + ECharts 6（图表 canvas 自绘）
- 桌面壳：Tauri v2（负责拉起后端、注入数据目录、进程看门狗）

## 目录结构

```
├─ app/               后端源码（FastAPI 分层）
│  ├─ routers/        HTTP 路由层（vtuber / auth / img-proxy）
│  ├─ repositories/   SQL 访问层（按仓库类持会话，无 ORM 泄漏到路由）
│  ├─ models/         SQLAlchemy ORM（vtubers / accounts / posts / account_stat_snapshots）
│  ├─ schemas/        Pydantic 输入输出模型
│  ├─ services/       抓取调度、平台接入（bilibili / weibo）、认证、WBI、图片代理
│  └─ core/           配置（数据目录/环境变量）、数据库引擎
├─ alembic/           数据库迁移链（a001 → e007，启动时自动升级）
├─ tests/             pytest 测试（test_auth / test_services / test_vtuber_api / test_weibo）
├─ scripts/           维护与构建脚本（repair_*、build_backend、collect_release 等）
├─ devlog/            版本开发日志（001–034，每版本一篇）
├─ docs/              文档：后端分层、UI 映射、平台扩展指南、架构图、设计原型、TODO 路线图
├─ frontend/          前端（Vite + React）+ Tauri 壳（src-tauri）
├─ backend_main.py    桌面端后端入口（Tauri 以子进程拉起，含父进程看门狗）
├─ alembic.ini        Alembic 配置
├─ requirements.txt   Python 依赖
└─ vtubers.csv        内置默认 VTuber 名单（首次启动引导到数据目录）
```

## 快速开始

```powershell
# 桌面开发（一键：后端 + 前端 + Rust 壳）
cd frontend
npm install
npm run tauri:dev

# 仅后端（pytest 之外的临时直跑；数据目录回退到项目根，见下）
pip install -r requirements.txt
python backend_main.py

# 测试
python -m pytest tests -q -p no:cacheprovider

# 前端类型检查
frontend\node_modules\.bin\tsc.cmd -p frontend\tsconfig.json --noEmit
```

> `-p no:cacheprovider`：历史遗留的 `frontend/pytest-cache-files-*` 与根 `.pytest_cache`
> 目录存在权限锁时，pytest 的缓存读写会报错；这些目录属于可重建残留，可在管理员权限下删除。

## 数据目录约定（重要）

| 运行方式 | 数据目录 |
|---|---|
| 桌面端（dev 构建） | `%APPDATA%\com.ddtoolkit.app-dev` |
| 桌面端（安装版） | `%APPDATA%\com.ddtoolkit.app` |
| 未注入环境变量（裸 uvicorn / 脚本直跑） | 回退到**项目根目录** |

- 启动器通过 `DDTOOLKIT_DATA_DIR` 环境变量注入数据目录（见 `frontend/src-tauri/src/lib.rs`）。
- 数据库 `vtuber.db`、日志 `logs/`、凭据 `.env`、头像/图片缓存 `static/` 全部随数据目录走。
- 项目根若出现这些目录，说明曾有「裸直跑」模式使用，均为运行时数据（已 gitignore），非源码。

## 外部数据源（v0.6.0，P4）

第三方「已固定化数据」采集，与平台实时抓取（`platforms/`）分离，见 `app/services/externals/`：

| 源 | 数据 | 周期 |
|---|---|---|
| [zeroroku.com](https://zeroroku.com)（公开免鉴权） | 粉丝历史（补历史空洞）、直播礼物日聚合 | 每日 3:00 |
| [danmakus.com](https://ukamnads.icu)（v2 spec，公开部分） | VTuber 索引（企划/公会/房间号，透传 laplace vup-slim）+ 直播场次/场次级弹幕与指标（v2 live，公开） | 每周一 3:30（索引）；场次级随查询实时拉取缓存 |
| laplace.live | 无公开 API（留空壳，数据经 danmakus 透传获取） | — |

开关：`EXTERNAL_ENABLED` / `EXTERNAL_ZEROROKU_ENABLED` / `EXTERNAL_DANMAKUS_ENABLED` / `EXTERNAL_RUN_HOUR`（settings）。
读取端点：`GET /account/{id}/stat-snapshots?source=`、`GET /account/{id}/gift-days`、`GET /externals/vtubers?kw=`、`GET /externals/vtubers/by-uid?uid=`。

档案视图（P5→v0.9.x）端点：`GET /account/{id}/fan-trend`（按天分桶粉丝趋势）、`GET /account/{id}/live-sessions`（danmakus 主源 + self 快照合并的场次列表）、`GET /account/{id}/live-sessions/{liveId}`（场次级详情：弹幕词云/指标/直播事件，analysis 预留）。

## 打包发布（一键 / 分步，产物统一在 `dist-release/`）

```powershell
# 一键：后端 → 桌面应用 → 聚合（安装包 + 便携版）
npm run release --prefix frontend

# 分步（改其一后只跑对应步）：
# ① 后端 → PyInstaller onedir（frontend/src-tauri/binaries/backend/）
npm run build:backend --prefix frontend
# ② 桌面应用（前端构建 + Rust release + NSIS 安装包）
npm run tauri:build --prefix frontend
# ③ 聚合全部产物到 dist-release/
npm run collect:release --prefix frontend
```

产物（均输出到 `dist-release/`）：
- `DDtoolkit_<version>_x64-setup.exe` —— NSIS 安装包（用户级安装）
- `DDtoolkit-portable-win64.zip` —— 便携版（解压即用：主程序 + 后端目录）
- （可选 `--with-main` 复制裸主程序 `ddtoolkit.exe`）

- 安装版数据目录 `%APPDATA%\com.ddtoolkit.app`；便携版运行后可改 `DDTOOLKIT_DATA_DIR` 环境变量自定义。
- 后端被打包进安装包 resources（`binaries/backend/`），主程序启动时自动拉起并注入空闲端口。
- Rust 子进程经 [Job Object 看门狗](frontend/src-tauri/src/lib.rs) 管理：主程序退出即整棵终止。

## 常用文档

- `docs/TODO.md` — 路线图与现状盘点
- `docs/backend-repositories-and-routers.md` — 数据库结构 / repositories / routers 分层说明
- `docs/backend-fetch-pipeline.md` — 抓取链路详解（频率 / API 清单 / 风控判定与原因 / 节流测算）
- `docs/UI-MAP.md` — 前端界面与路由映射
- `docs/platforms-extension-guide.md` — 平台接入扩展指南
- `devlog/` — 每版本的变更记录（当前 v0.9.x）
