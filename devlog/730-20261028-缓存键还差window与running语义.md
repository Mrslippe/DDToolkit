# 730-20261028-两个残留：缓存键还差 window；`running` 语义用错

## 一、"分析完成还要读十秒" —— 缓存键**还差一格**

上一批（`devlog/729`）我给分析任务补了 `live_ids`，但缓存键是：

```python
key = (subdir, window, since, until, live_ids)
```

**`window` 那一格两边仍然不同**：

| 谁 | `window` |
|---|---|
| 后台分析任务 | `win.size`（滑杆选的，实测 25） |
| 页面 `/ranked` | **没传** ⇒ 后端默认 `DEFAULT_WINDOW = 75` |

⇒ 键还是不一样，还是要重算一遍。修法：`loadRanked` 显式传 `window: winSize`，
并把 `winSize` 抽成一个变量，**分析任务与 `/ranked` 共用同一个值**（`win?.size ?? 75`，
75 = 后端默认值，作为滑杆还没读数时的兜底）。

> 教训：缓存键是"元组逐格相等"，**少传一格就等于换了一份数据**。
> 这次补上了防再犯的用例：断言 `fanAnalyzeStart` 与 `fanRanked` 两次调用的
> `window` / `ids` 完全一致。

## 二、分析时进度条左标写着「采集进度」 —— `running` 语义用错

```ts
const running = task.state === 'running'      // ← 采集和分析**都**为 true
```

于是分析任务期间所有"采集专属"分支（左标、标题文案、按钮文字）全都抢先生效。

修法：拆成两个语义明确的变量：

```ts
const collectRunning  = task.kind === 'collect' && task.state === 'running'   // 显示用
const anyTaskRunning  = task.state === 'running'                              // 禁用用
```

- 显示（进度条左标 `采集进度/分析进度/读取进度`、`采集中…`、空态提示）→ `collectRunning`；
- 禁用（采集/分析按钮、清空按钮、滑杆）→ `anyTaskRunning`（任何任务在跑都该锁 UI）。

## 三、补了两条防再犯的用例

1. `★ 分析中：进度条左标必须是「分析进度」` —— 断言文本里含 `分析进度`、不含 `采集进度`、且百分比 `12%`（3/25）；
2. `★ 分析任务与 /ranked 的窗口参数必须一致` —— 断言两次调用的 `window` 与 `ids` 归一后相等。

这两条正好覆盖本次报的两个问题，以后任何一边改了参数或文案都会当场红。

## 验证

| 检查 | 结果 |
|---|---|
| `vitest run pages/WorkbenchPage` | 26 passed |
| 前端全量 | **1632 passed**（+2） |
| `tsc --noEmit` / `eslint src --max-warnings 0` | 均无输出 |
