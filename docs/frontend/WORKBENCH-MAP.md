---
doc: frontend/workbench-map
class: index
scope: 「数据分析工作台」这一屏的**功能 → 落点**查询表：界面元素 ↦ 数据来源 ↦ 具体文件:函数；含后端端点表、三条不变量、常见改动的落点清单与定位手法
not-scope: 组件与 CSS 类名索引与页面视觉规范 → frontend/UI-MAP.md B6；模型的数学推导与验证结论 → plans/fan-model-plan.md
sot: frontend/src/pages/WorkbenchPage.tsx, frontend/src/components/workbench/, app/routers/fan.py, app/services/fan/
verify: grep 本表任意一行给出路径，落点必须存在；`python scripts/doc_check.py`
retire-when: 工作台拆成多页，或本表能被脚本按 import 图自动生成
budget: 400
---

# 数据分析工作台 · 功能落点表

> 改这一屏的任何数字或交互，**先查本表**，别从 grep 开始。
> 表里给的是「文件:符号」，`read` 那一处再动手。

## 1. 界面元素 → 数据来源 → 逻辑落点

| 界面元素 | 数据来源 | 逻辑落点 |
|---|---|---|
| 主播切换下拉 | `GET /fan/vtubers` | `api.fanVtubers` → `fan.py: fan_vtubers` → `loader.list_vtubers` |
| 档案卡（昵称/粉丝/覆盖） | `GET /fan/{v}/profile` | `ProfileCard.tsx`（`resolveAvatarSources` 取头像）→ `fan.py: fan_profile` |
| 热力图色深（当天几场） | `GET /fan/{v}/activity` 的 `days` | `Heatmap.tsx`（`n = days[c.d].n`）→ `fan.py: fan_activity` 的 `days` SQL |
| 热力图角标（已采） | 同上，`days[*].c` | 同上 SQL 里的 `collected` 字典 |
| 格子 hover 浮窗 | 本地状态 | `Heatmap.tsx`（`hover` / `.wb-hm-tip`） |
| 年份翻页 | `activity.years` | `Heatmap.tsx`（`year` 状态） |
| 场次滑杆（25/50/75） | `activity.recent` | `WindowSlider.tsx`（`bandStyle` / `clampToView`） |
| **窗口场次 / 已有 / 待采** | `activity.recent` **切片** | `WorkbenchPage.tsx`：`slice`、`alreadyInWin`、`toCollect` |
| 区间（since~until） | 滑杆回调 | `WindowSlider` 的 `onChange` → `WorkbenchPage: win` |
| 采集按钮文案 | 同上 | `WorkbenchPage`：`toCollect` / `unknown` |
| 采集进度（%） | `GET /fan/collect/status` | `WorkbenchPage` 轮询 effect → `collector.CollectProgress` |
| 采集结果弹窗 | 同上 `done/skipped/failed/failures` | `WorkbenchPage`：`summary` + `collect-dialog` |
| 分析按钮 / 结果图 | `GET /fan/{v}/ranked` | `WorkbenchPage: loadRanked` → `ResultCharts.tsx`（`model`） |
| 删除已采集 | `POST /fan/{v}/purge` | `PurgeButton.tsx` → `fan.py: fan_purge` |

## 2. 后端端点 → 处理函数 → 关键口径

| 端点 | 处理函数 | 口径备注 |
|---|---|---|
| `GET /fan/vtubers` | `fan.py: fan_vtubers` | **一个 V 只出一条**，留粉丝数最多的账号（`loader._db_vtubers`） |
| `GET /fan/{v}/sessions` | `fan.py: fan_sessions` | 缺数据根 ⇒ **409**（不是 500） |
| `POST /fan/{v}/collect` | `fan.py: start_collect` → `collector.collect` | 给了 `sessions` 就**按清单采**，否则退回日期枚举 |
| `GET /fan/collect/status` | `fan.py: collect_status` | 直接返回 `CollectProgress.as_dict()` |
| `GET /fan/{v}/ranked` | `fan.py: fan_ranked` | `by` **必填**，后端没有默认 |
| `GET /fan/{v}/activity` | `fan.py: fan_activity` | 只数**代表行**；`recent` 上限 `ACTIVITY_LIMIT = 150` |
| `GET /fan/{v}/profile` | `fan.py: fan_profile` | 同上，`total_sessions` 只数代表行 |
| `POST /fan/{v}/purge` | `fan.py: fan_purge` | `dry_run` **默认 true**；只 unlink 文件，不 rmtree |

## 3. 三条不变量（改错了会立刻自相矛盾）

1. **场次 = 代表行**：`live_sessions.session_key IS NOT NULL`。同一场被 feed 与 danmakus
   各记一行时只有代表行算一场（实测 1,168 行 ↔ 942 场）。
2. **已有 + 待采 ≡ 窗口场次**：两个数都从 `activity.recent` 的**切片**上数，
   不能拿日期区间回库里再数一遍（边界日整天计入会外溢）。
3. **结果两张图只反映当前名单的 N 人**（后端 `limit`），不是全池 —— 卡片标题必须写明 N。

## 4. 常见改动 → 只动这几处

| 想改 | 落点 |
|---|---|
| 热力图配色 / 图例 | `Heatmap.tsx` 的 `cls` 与 `.wb-hm-*`（`workbench.css`） |
| 滑杆档位（25/50/75） | `WindowSlider.tsx` 的档位常量 |
| 采集并发 / 下限 | `collector.py`：`COLLECT_CONCURRENCY`、`MIN_RECORDS` |
| 窗口大小上限 | `WorkbenchPage` 的窗口参数 + `WindowSlider` 的 150 上限 |
| 名单条数 | `WorkbenchPage` 的 `LIMIT`（当前 300） |
| 分层阈值 | `ResultCharts` 的 0.2 / 0.5（与 `cross_v.assign_tiers` 同阈值） |

## 5. 定位手法与踩过的坑

**四条线索**：① 界面中文文案直接 grep；② `data-testid`（测试文件即行为说明书）；
③ 从接口反查 SQL；④ 本表。

**坑（都已踩过并返工）**：

- `str.replace` 锚点不匹配时**静默返回原串** ⇒ 必须 `assert`，或改用会报错的编辑工具；
- 写锚点**别凭记忆猜缩进** —— `api.ts` 是 2 空格、`App.tsx` 里是 10/12 空格混用；
- 改 **JSX 结构**（增删嵌套）要整段重写组件，不要补丁叠补丁；
- 改完不看脚本输出，看 `tsc` + 测试 + `grep` 行号。
