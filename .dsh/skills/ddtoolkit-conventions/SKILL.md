---
name: ddtoolkit-conventions
description: Use when 修改 DDToolkit 的后端抓取/数据层/迁移/路由，或排查线上事故类 bug；给出改前必查项、分层纪律、不变量去哪查与验收命令。
---

# DDToolkit 工程约定（后端 · 数据层 · 验证）

> 项目：本地优先的个人 VTuber 证据归档工具 —— Tauri v2 桌面壳 + Python 3.14 / FastAPI / SQLAlchemy 2.0 / SQLite(WAL) / Alembic 后端 + Vite / React 18 / TS / Tailwind v4 前端。
> 本技能只做**路由 + 清单 + 指向源头**；细节一律回 `docs/` 原文（项目文档是中文，代码/路径/命令保持原文）。

## 1. 触发场景

改动落在**后端抓取链路、数据层（models / repositories / purge）、迁移、路由契约**，或要排查"事故类" bug（删除后回滚、旧库启动失败、增量漏帖、抓取卡死、第二轮必抛异常）→ **先加载本技能**。
只改前端布局/视觉时，本技能只提供验收命令（`python scripts/ui_probe.py` 那条线）。

## 2. 开工前读什么（真源，不在本技能里找）

`docs/ARCHITECTURE.md` **§6 不变量与纪律**（改代码前必读）+ **§5 分层与依赖方向** + `docs/GLOSSARY.md`（术语 → 代码路径 → 依赖）。
补充入口：`docs/backend-repositories-and-routers.md` · `docs/backend-fetch-pipeline.md` · `docs/DEV-LOOP.md`。

## 3. 分层纪律

分层表与依赖方向：`docs/ARCHITECTURE.md` **§5 分层与依赖方向**（真源）；改动 → 文件对照见 `references/change-recipes.md`（含新增 HTTP 操作的 C5 分步配方）。

## 4. 不变量与高危动作

改后端前读 **`docs/ARCHITECTURE.md` §6 不变量与纪律（改代码前必读）——唯一真源** —— 速查表与「高危清单」已从这里删掉
（它们只是 §6 的展开，改一次要同步多处；复述为什么是负债见 `docs/DEV-LOOP.md` §0.4）。
「这条不变量落在哪个文件、被哪个测试守着」的索引见 `references/invariants.md`。

## 5. 改动类型 → 验收命令

命令全表 `docs/DEV-LOOP.md` §二 · 门禁分档 `python scripts/gate.py`（§0.6）· 逐字命令与探针各模式
`python scripts/dev_check.py --help` / `python scripts/ui_probe.py --help`；**门禁基线数值只在 `docs/TODO.md` §6.2 维护**
（本技能与 `references/verification.md` 都不复述 —— 散文里的数字门禁查不到，写死必漂）。

## 6. references

- `references/invariants.md` —— 不变量的**落点 / 触发面 / 护栏测试名**派生索引（条文真源 = `docs/ARCHITECTURE.md` §6）+ 原 `GLOSSARY.md` §8 编号的换算对照
- `references/verification.md` —— 验收/门禁**去哪查**（真源是脚本 `--help`）+ 三条探针陷阱 + 口径提醒
- `references/change-recipes.md` —— 改动 → 文件对照（扩展点总表 + 分步配方 + 文档同步约定）
- 记 devlog / 同步活文档 / 发版 → 用 `ddtoolkit-docs-devlog` 技能；本技能只管代码侧不变量与验收命令
