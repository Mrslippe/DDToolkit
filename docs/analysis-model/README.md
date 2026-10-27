---
doc:         analysis-model/README
class:       index
scope:       直播观众数据分析模型（fan 模块）的总入口：一页速查（现行口径 / 关键常数 / 实测在哪）、主题索引、复算与采集命令入口
not-scope:   后端通用数据模型 → backend/DATA-MODEL.md；工作台界面落点 → frontend/WORKBENCH-MAP.md；接口契约 → backend/HTTP-CONTRACT.md
sot:         app/services/fan/, app/routers/fan.py, app/services/live_identity.py, app/core/timecn.py
verify:      python scripts/docs_gate.py；python -m pytest -q tests/test_fan_*.py
budget:      160
retire-when: 分析模型换范式（不再用三轴 + 分位 + ACV 池），或 fan 模块被移除
---
# 直播观众数据分析模型（fan 模块）

> 本目录是「直播观众行为结构」模型的**唯一文档入口**。2026-10-27 由三份旧文档合并而成
> （`analysis-model` + `fan-model-plan` + 明前快照），合并明细见 `CHANGELOG.md`。
> 代码是事实真源；本文与代码冲突时以代码为准，并回头改文档。

## 1. 目录：先读哪一份

| 文件 | 管什么 | 什么时候读 |
|---|---|---|
| `README.md` | 入口 + 一页速查 + 去哪看什么 + 命令 | 第一次接触 / 只想查一个常数 |
| `01-data.md` | 数据层：上游事件、两级聚合、文本去重、ACV 池、场次身份、时区、窗口、跨度与回放修复、C1、coverage | 改采集/读盘口径、怀疑数据不对 |
| `02-model.md` | 测量层：三条轴、入选门槛与参照总体、经验分位、参与强度、类型、效标加权、实测分布 | 改分数、类型、排序 |
| `03-tags-spam.md` | 10 条展示标签、独轮车三档、`stats.bp` 行为画像、`msh` simhash | 改标签/刷屏判据/审计脚本 |
| `04-validation.md` | 信度、效度、误差来源、已知实现问题、局限、三层测试策略、相邻模块 | 质疑结论能不能用 / 改完模型怎么验 |
| `05-pipeline-ops.md` | 采集链路、gzip、分页与重试、并发、进度字段、补采、落盘校验、重采运维 | 改 collector / 采集失败排障 |
| `06-compare.md` | 对比分析：多主播重叠、帖子评论名单重叠、Jaccard/lift/超几何/BH、判读纪律 | 改对比页 / 加新的对比对象 |
| `CHANGELOG.md` | 本次整合从哪几份文档来、删了什么、引用改到哪 | 追溯文档历史 |

## 2. 一页速查（现行口径）

**观测单位**：一条弹幕 = 一个观测；一次「出席」= 该用户在该场出现过任意事件。
**场次数**：`live_sessions.session_key IS NOT NULL` 的代表行才算一场（一行 ≠ 一场）。
**窗口**：用户选的时间区间（东八区、闭区间）优先；否则最近 N 场。质量过滤会减少实际场次，
**请求 75 场 ≠ 分析 75 场**。

| 量 | 现行定义 | 落点 |
|---|---|---|
| 池子规模 | `round(ACV × 3.0)`；ACV = 窗口内各场 `stats["acv"]` 的中位数 | `app/services/fan/pool.py::POOL_MULT` |
| 三层人数 | 核心 `0.75×ACV` / 次核心 `1.25×ACV` / 外层 `1.0×ACV` | `pool.py::tier_sizes_for` |
| 谁进池 | 先筛出席率 ≥ 0.10 的大盘，再按核心度 S 取前 `3×ACV` 人；分位在**最终名单内**重算 | `axes.py::build_axis_table` |
| 出席轴 A | `(att_n + π_E) / (N + 1)`；`π_E` = 同出席场次内 `−平均首出场时滞` 的经验分位 | `axes.py::_table_from` |
| 互动轴 I | `(Σ弹幕 + ΣSC条数) / att_n`；**分母是出席场次** | 同上 |
| 付费轴 P | `ln(1 + Σ付费)` | 同上 |
| 参与强度 S | `(π_A + π_I + π_P) / 3`，等权 | `compose.py::participation_strength` |
| 类型 | 最高与次高轴分位差 ≥ 0.15 ⇒ 主导型；否则「综合」 | `compose.py::PURITY_THRESHOLD` |
| 展示标签 | 10 条，只展示、不参与任何计算 | `app/services/fan/tags.py` |
| 独轮车 | 三档 `none / suspected / confirmed`；只有 confirmed 进「独轮车」标签 | `app/services/fan/spam.py::level_for` |
| 完整性 | C1 不过 ⇒ 整场弃用；C2–C4 只降级/标未核验 | `app/services/fan/checks.py` |
| 时间 | 存储与计算全部 **UTC**；分天/分月与界面按 **东八区** | `app/core/timecn.py` |

> 以上都是**定义值**，可以照抄。**测量值**（池多大、R² 多少、偏好哪个类型）不要当常数 ——
> 它们随窗口与重采变化；需要时看 `04-validation.md` 的带日期快照，或直接重跑命令。

## 3. 关键常数（定义值）

| 常数 | 值 | 含义 |
|---|---|---|
| `POOL_MULT` | 3.0 | 池子 = 3×ACV |
| `CORE_MULT` / `MID_MULT` / `OUTER_MULT` | 0.75 / 1.25 / 1.00 | 三层人数相对 ACV |
| `INCLUSION_FLOOR` | 0.10 | 先进入大盘的最低出席率；无 ACV 时它就是最终门槛 |
| `PURITY_THRESHOLD` | 0.15 | 类型纯度门槛 |
| `MIN_RECORDS` | 100 | 一场的最少记录数（不足整场跳过） |
| `SUMMARY_TOLERANCE` (C2) | 0.15 | 平台弹幕计数与现算的容差 |
| `COVERAGE_FLOOR` (C3) | 0.90 | 外部源时间覆盖比门槛 |
| `MINUTE_RHO_FLOOR` (C4) | 0.80 | 逐分钟相关下限 |
| `MIN_MSG_FOR_JUDGEMENT` | 200 | 少于 200 条不判独轮车（未知 ≠ 清白） |
| `DUP_RATE_THRESHOLD` | 0.80 | 重复率阈值（等价不同文本率 ≤ 20%） |
| `MIN_SESSION_MSGS` | 20 | 单场进入「场次证据」的最少条数 |
| `MAX_WINDOW` | 5000 | 后端允许的最大场次窗口 |
| `ACTIVITY_LIMIT` | 2000 | 热力图/滑轨可回溯的场次上限 |
| `DEFAULT_WINDOW` | 75 | 默认窗口场次 |
| `MAX_LIMIT` | 5000 | 单页名单上限 |
| 小数位 | 3 位 | 三轴对外与复算都保留三位 |

## 4. 去哪看什么

| 想做什么 | 去哪 |
|---|---|
| 查「场次为什么少了几场」「为什么全部 unverified」 | `01-data.md` §8、§10 |
| 改三轴公式 / 池子 / 类型阈值 | `02-model.md`；同步 `app/services/fan/axes.py`、`compose.py`、`pool.py` |
| 改标签或独轮车判据 | `03-tags-spam.md`；独轮车判据变了要升 `SPAM_ALGO_VERSION` |
| 判断结论能不能用 / 怎么验 | `04-validation.md` |
| 采集失败 / 缺页 / 进度卡住 | `05-pipeline-ops.md` |
| 要对比两个 V / 对比某帖评论者 | `06-compare.md` |
| 接口返回哪些字段 | `backend/HTTP-CONTRACT.md` §3.7 + `app/routers/fan.py` |
| 界面元素落在哪个组件 | `frontend/WORKBENCH-MAP.md` |
| 通用表结构 / 迁移 | `backend/DATA-MODEL.md`（本文不重复） |

## 5. 实现落点（概念 → 文件）

| 概念 | 落点 |
|---|---|
| 事件类型 0–4、两级聚合、文本指纹、`bp` | `app/services/fan/collector.py::aggregate` |
| 窗口加载、三项过滤、时滞、独轮车并集、切片 | `app/services/fan/loader.py::load_window` |
| ACV 池 / 三层人数 | `app/services/fan/pool.py` |
| 三轴、档内时机分位、经验分位 | `app/services/fan/axes.py::build_axis_table` |
| 强度、类型、次序键、效标拟合 | `app/services/fan/compose.py`、`criterion.py` |
| C1–C4 | `app/services/fan/checks.py` |
| 质量闸 L1/L2/L3 | `app/services/fan/quality_gate.py` |
| 回放 / 率降 / 系统消息 | `quality.py`、`duration.py`、`sysmsg.py` |
| 标签 | `app/services/fan/tags.py` |
| 独轮车与行为画像 | `app/services/fan/spam.py`、`spam2.py`、`collector.py::_behaviour_profile` |
| 跨 V / 时间动态 | `app/services/fan/cross_v.py`、`timeline.py` |
| 场次身份 | `app/services/live_identity.py` |
| 时区 | `app/core/timecn.py` |
| HTTP 端点 | `app/routers/fan.py` |

## 6. 复算与采集命令入口

```powershell
# 测试（L1 合成夹具 + L2 真实快照 + L3 不变量）
.\.venv\Scripts\python.exe -m pytest -q tests/test_fan_*.py

# 当前基线的模型验证：信度 / 样本外 / 效标 / 跨 V（需要仓库根在 PYTHONPATH）
$env:PYTHONPATH='.'; .\.venv\Scripts\python.exe scripts\validate_fan_model.py

# 池子系数敏感性（1.0/1.5/2.0/3.0/4.0 × ACV）
$env:PYTHONPATH='.'; .\.venv\Scripts\python.exe scripts\acv_sensitivity.py

# 文档结构门禁（本目录新增/改名的必跑）
.\.venv\Scripts\python.exe scripts\docs_gate.py

# 注意：部分旧脚本（acv_sensitivity / pool_select_compare）的注释仍写 2×ACV，
# 以代码 `POOL_MULT = 3.0` 为准；跑之前先看一眼它读的是哪个常量。
```

采集入口在界面：工作台 → 选主播 + 区间 → 开始采集；后端链路与失败处置见 `05-pipeline-ops.md`。
接口入口：`GET /fan/{vtuber}/ranked?by=strength|attendance|interaction|payment|retention|income`
（`by` 必填，没有默认口径）。

## 7. 阅读约定

- **约定 vs 发现**：分位化、等权、纯度门槛 0.15 都是**人为约定**；三轴不共线、出席轴可预测
  后段出席等是**数据发现**。全文分开写，混读是这类模型最常见的错误。
- **带日期的数字是快照**：文中「2026-10-xx 实测」都只对那次数据/那个窗口成立。
- **跨窗口/跨 V 不比较绝对分位**：分位参照总体一变，分数就不可比；只能比层级与重叠。
- **旧文档里的 2×ACV 已作废**：2026-10-23 定案后池子为 3×ACV（0.75 + 1.25 + 1.0）。
