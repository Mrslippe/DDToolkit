---
doc: nav
class: nav
scope: 文档导航——做什么读哪几份；本目录的布局约定与文档纪律
budget: 60
---
# docs 目录导航

本目录的**唯一入口**。定位一句话：**本地优先的个人 VTuber 证据归档库**
（Tauri 壳 + FastAPI sidecar + SQLite + React 前端）。

## 1. 目录布局

**顶层只放「任何需求都可能要读」的少数几份**，其余按归属进子目录。

| 位置 | 放什么 |
|---|---|
| 根 `*.md` | `OVERVIEW` / `GLOSSARY` / `DEV-LOOP` / `TODO` / 本文件 |
| `frontend/` | 前端框架文档 + `UI-MAP`（组件与元素索引 + 整体美学） |
| `backend/` | 后端框架文档 + **各功能模块各自的框架文档** |
| `desktop/` | Tauri 壳（Rust 侧） |
| `ops/` | 发布与运维 |
| `plans/` | 批次执行方案 —— **落地后必须删除或并入模块文档** |
| `design/` | 设计资产 + 带日期的专题调研（过期不误导，故不放顶层） |
| `releases/` `reference/` `tools/` `diagrams/` | 归档、外部存档与生成物 |

> ⚠️ **子目录正在迁移中**（2026-09-30 起按批次搬）。迁移完成前，尚未搬走的文档
> 仍留在顶层 —— 以实际存在的文件为准，别按上表硬猜路径。

> `releases/` 归档：`v0.9.1.md` / `v0.9.2.md` / `v0.9.3.md` / `v0.9.9.md` / `v1.0.0.md` / `v1.0.1.md` / `v1.0.2.md` / `v1.1.0.md` / `v1.1.1.md`
> —— 发布时被 `scripts/upload_release_assets.py` 读取；**新增一份要补这一行**（`scripts/doc_check.py` 查这条）。

## 2. 找文档

| 要做什么 | 读哪份 |
|---|---|
| 查名词在代码里叫什么、在哪、牵动谁 | `GLOSSARY.md` |
| 建立整体认知 / 改动跨多层 | `OVERVIEW.md`，再进对应那一侧的框架文档 |
| 改后端某个模块 | `backend/<模块>.md` + 后端框架文档的不变量一节 |
| 改界面 / 找组件类名 / 查设计令牌 | `frontend/UI-MAP.md` |
| 本地怎么跑、怎么验、门禁几档 | `DEV-LOOP.md` |
| 现在要干什么、卡在哪 | `TODO.md` |
| 打包发版 | `ops/RELEASE.md` |

> 「按需求分级 → **只读这几份**」的路由表由 `DEV-LOOP.md` 维护，本文件不复述
> （复述一份就多一个漂移点，理由见 `DEV-LOOP.md` §0.4）。

## 3. 文档纪律

1. **每份文档开头必须有头块**：`class` / `scope` / `not-scope` / `sot` / `verify` /
   `budget` / `retire-when`。**字段定义、各 `class` 的必填项与行数上限的真源是
   `scripts/docs_gate.py`** —— 本文件不复述那张表。
2. **数字三分法**：测量值**不写死**（指向 `scripts/gen_doc_numbers.py --list`）；
   定义值照写（它就是规格）；带日期的快照必须标日期。
3. **能引用就别复述**，并用 `not-scope` 写清本篇**不**写什么、该去哪份找。

以上三条由 `python scripts/docs_gate.py` 机器判（秒级，已进 C 档门禁）；
索引与版本号的漂移由 `python scripts/doc_check.py` 判。两者分工：**后者管"数字漂没漂"，
前者管"文档的声明成不成立"。** 新增/搬动文档后跑一次即可。
