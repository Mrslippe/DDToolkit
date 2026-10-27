---
doc:         analysis-model/CHANGELOG
class:       snapshot
scope:       2026-10-27 文档整合记录：三份旧文档合并为 analysis-model/ 五篇 + 索引；列出每篇承接的旧内容、删除清单、引用修正与门禁结果
not-scope:   现行模型口径 → analysis-model/README.md；验证结论 → analysis-model/04-validation.md
sot:         本次整合涉及的 docs/analysis-model/ 与三份旧文档
verified:    2026-10-27
---
# CHANGELOG：analysis-model 文档整合（2026-10-27）

## 1. 从哪几份合并

| 旧文档 | 体量 | 新家 | 承接的实质内容 |
|---|---|---|---|
| `docs/analysis/analysis-model.md` | 39 KB / 707 行 | `01-data.md`、`02-model.md`、`04-validation.md` | 事件模型、两级聚合、文本去重、ACV 池、场次身份、时区、窗口与质量过滤、跨度/回放、C1–C4、三轴与时机论证、分位、强度、类型、效标、跨 V、时间动态、信度/效度、误差与局限、复算命令 |
| `docs/plans/fan-model-plan.md` | 6.6 KB / 119 行 | `README.md`、`01-data.md`、`02-model.md`、`04-validation.md`、`05-pipeline-ops.md` | 口径定案（真源/弃用规则/时间/场次/单位/窗口）、数据链路、质量闸三层、参数表、验证结论、待办与不做的事 |
| `docs/analysis/mingqian-fan-structure.md` | 14 KB / 241 行 | `02-model.md` §7、`03-tags-spam.md` §1.4、`04-validation.md` §1/§3/§4 | 单主播实跑快照：数据层数字、三轴分布、类型、效标、信度、标签、跨 V、L6 时间动态、六条限制 |

数据快照 `（已删除：旧快照 CSV，2026-10-27 清理）` **未删**（它是数据产物，不是文档）；因此
`docs/analysis/` 目录保留。旧快照里的具体排名/人数已被 2026-10-27 重采数据取代，
本目录只保留带日期的结构性数字，并指向新的 L2 黄金值。

## 2. 按主题重排，而不是拼接

- 公式、阈值、判据、边界条件按「数据 → 测量 → 标签 → 验证 → 采集」重排；
- 旧文档里互相矛盾的口径**以当前代码为准**：池 = 3×ACV（`POOL_MULT`）、三层 0.75/1.25/1.0、
  `MIN_RECORDS=100`、标签 10 条、独轮车 v4、`MAX_WINDOW=5000`、`ACTIVITY_LIMIT=2000`；
- 过期的测量值保留但**标日期、标口径**（10% 大盘 vs 3×ACV 池），不再当作现状；
- 旧文档的「直播类型推断」「弹幕词云」不属于三轴模型，收进 `04-validation.md` §9 并标明相邻模块；
- 旧快照的第 11 节（前 50 名明细）未搬：它已被重采数据取代，且 CSV 仍在原处。

## 3. 删除

- `docs/analysis/analysis-model.md`
- `docs/plans/fan-model-plan.md`
- `docs/analysis/mingqian-fan-structure.md`

## 4. 引用修正

| 文件 | 原指向 | 新指向 |
|---|---|---|
| `docs/backend/HTTP-CONTRACT.md` | 两处 `plans/fan-model-plan.md` | `analysis-model/README.md` / `analysis-model/01-data.md` |
| `docs/frontend/WORKBENCH-MAP.md` | not-scope 的 `plans/fan-model-plan.md` | `analysis-model/README.md`；顺带把 `ACTIVITY_LIMIT=150` → 2000、窗口上限 150 → `MAX_WINDOW=5000` |
| `docs/plans/workbench-visual-redesign.md` | not-scope 的两处旧路径 | `analysis-model/04-validation.md`、`analysis-model/05-pipeline-ops.md` |
| `docs/GLOSSARY.md` | 规格 `plans/fan-model-plan.md` | `analysis-model/README.md` |
| `docs/TODO.md` | 方案指针 `plans/fan-model-plan.md` | `analysis-model/README.md` |
| `docs/README.md` | 目录表没有分析模型 | 增加 `analysis-model/` 一行与索引项 |
| `datasets/fan-structure/README.md` | 两处 `plans/fan-structure-analysis.md` | `analysis-model/01-data.md`、`analysis-model/05-pipeline-ops.md` |

`docs/ops/PERF.md` 实测**没有**指向这三份旧文档的路径，故无改动。

## 5. 未动的遗留（供后续确认）

- `（已删除：旧快照 CSV，2026-10-27 清理）`：数据快照，不是文档；保留在 `docs/analysis/`，
  因此该目录未删。
- `（已删除：无引用的流程图，2026-10-27 清理）`：模型流程图，不是文档；没有被任何文档引用，保留在 `plans/`。
- 代码/测试 docstring 里仍有旧路径（`app/routers/fan.py`、`app/services/fan/*.py`、
  `tests/test_fan_*.py` 等共约 11 处）。按本次「只改文档」的约定**未改代码**；
  下次改对应模块时顺手改，或另做一批纯注释修改。

## 6. 门禁

- `python scripts/docs_gate.py`：`[ok] 无 FAIL`（2026-10-27，整合后）。
- 新增文档均带头块（`class` / `scope` / `not-scope` / `sot` / `verify` / `budget` /
  `retire-when`）；`README.md` 用 `class: index`，本篇用 `class: snapshot`。
- `scripts/doc_check.py` 另有 **3 组 devlog 文件名重号**（570/571/572），是整合前就存在的，
  与本次改动无关，未处理。

