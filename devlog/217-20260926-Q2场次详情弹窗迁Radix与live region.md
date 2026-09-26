# 217-20260926-Q2场次详情弹窗迁Radix与live region

批次 14 = 计划 §Q2，按修正**分相位推进、只做"优先做"的那一段（14c）**。
14a（focus 令牌体系）与 14b（摘掉全局 `outline:none`）**没做** —— 它们是"视觉回归面最大"的
两段（摘掉那条规则会让一整族原生控件冒出默认边框，得逐个走查），计划明确把它们列在可缓相位。
整个 axe/RTL 基建也没引。

## 一、弹窗迁 Radix Dialog（这一批的**功能性修复**）

改前：手搓 `createPortal` + `.lc-dlg-backdrop` + `<div role="dialog" aria-modal>`，
**Esc 由父组件 `LiveCalendar` 的 keydown 直接 `setDetail(null)`** ⇒ 组件当场卸载。
后果：**退场动画根本播不出来**（点 X / Esc / 点遮罩都是"一闪就没"），而且
标题是个裸 `<span>`（没有 `aria-labelledby`）、没有 focus trap、没有背景 inert。

现在：`Dialog` + `DialogContent`（`ui/dialog.tsx` 那个 Radix 封装，新增一个
`overlayClassName` 参数好让老遮罩类名 `.lc-dlg-backdrop` 继续生效）。

| 六件事 | 怎么落的 |
|---|---|
| 标题关联 | `.lc-dlg-name` → `DialogTitle`（`aria-labelledby`）；副行 → `DialogDescription` |
| 初始焦点 / focus trap / 背景 inert / 焦点恢复 | Radix 模态 Dialog 自带（前三条有判据，第四条见 §三的边界） |
| Esc / 点遮罩 / 点 X **同一条路** | 全部走 Radix `onOpenChange` ⇒ `onClose()`；父组件那段 keydown **删掉**（避免双重关闭） |
| **退场动画** | `[data-state='closed']` 的 `lc-dlg-pop-out` / `lc-dlg-fade-out`（0.16s，reduced-motion 压到一帧）+ 父组件**不再条件渲染**（Radix 要 `open=false` 那一帧面板还挂着）+ 组件保留"最后一次非空 detail"渲染关闭帧 |

⚠️ **DOM 与类名逐字保留**（`.lc-dlg` / `.lc-dlg-*` / `.lc-dlg-backdrop`）：`ui_probe.py` 与
`dev/probe.ts` 都直接查这些选择器（R36 弹窗高度、速览卡几何）。
面板额外给 `p-0 gap-0` 抵消 `ui/dialog` 的默认内边距，并加 `z-index: 61`（压在遮罩之上 ——
同 z 值时靠 DOM 顺序，不值得依赖）。默认三档探针**实测 0 问题**。

## 二、live region + 显式「加载更多」

`aria-live` 全仓原本 **0 命中**：无限滚动靠 IntersectionObserver，读屏用户既听不到
"正在加载更多"也听不到"已经到底啦"。现在帖子流尾巴加一条 `sr-only` 的
`role="status" aria-live="polite"`（三态播报），并给一个**显式的「加载更多」按钮**
（不依赖滚动、可 Tab 可回车，与哨兵触发的是同一件事 `setPage(p+1)`）。
可见文案与类名一个没动（`.load-more-tip` / `.load-end` 原样），探针不受影响。

顺带把两处"画出来的图"补上语义：`FanTrendChart` 的 canvas 容器
（`role="img"` + 一句话摘要，数字与左侧可见的 1d/7d/30d 概览同源）、`MosaicCloud` 的 SVG
（`role="img"` + 前 8 个词）。**sr-only 数据表没做** —— 计划把它列在可缓相位。

## 三、判据：本仓第一条 jsdom 组件用例（11 条）

起因是个**验证盲区**：`--archive` / `--reservations` 两个探针模式今天**跑不出日历**
（`实测在改动之前就红`，见 §五），于是"弹窗长什么样、键盘能不能用"在迁移前后
**没有任何机器判据**。装 Testing Library 那一整套属于可缓相位 ⇒ 用最薄的组合：
`// @vitest-environment jsdom` + `react-dom/client` + `act`，**零新依赖**（jsdom 本来就在
devDeps —— S2 的 `sanitizePlatformHtml` 在用）。

覆盖：标题关联（`aria-labelledby` 指向真的标题文本）· 副行 `aria-describedby` ·
初始焦点在面板内 · 背景被 `aria-hidden` · Esc 与关闭钮各只触发**一次** `onClose` ·
关闭后背景解除 inert 且焦点不留在已卸载的面板上。

**如实标注的两条边界**（都写进用例注释与 `TODO.md` §1.3）：
1. **焦点"回原位"在 jsdom 里验不到**（实测关掉后 `activeElement` 是 `body`）——
   Radix 的恢复路径依赖它自己的卸载时序与真实焦点管理，jsdom 两样都不完整；
2. **退场动画在 jsdom 里也验不到**：Radix 的 `Presence` 靠 `getComputedStyle(el).animationName`
   判断"要不要等动画"，而 **jsdom 不解析注入的 `<style>`**（探针实测恒为 `none`；
   连替掉 `getComputedStyle` 的 animationName 都不够 —— 最小 Radix Dialog 也一样当场卸载）。
   ⇒ 退场这条改成三条**能站住**的静态判据：真 CSS 里有那两条退场声明 · 父组件不再条件渲染 ·
   组件保留"最后一次非空 detail"。**真机动效留在人工清单**。

## 四、没做（按修正）

- **14a focus 令牌体系**、**14b 摘掉全局 `:focus,:focus-visible{outline:none}`**：可缓相位。
  后者的代价计划里写得很清楚（一整族原生控件会冒默认边框，得逐个走查），单独一批更合适。
- `StatusIsland:332` 那处手搓 `role="dialog"`（计划提过"同款"）：**没做**，它自带一套几何与
  探针判据，与本次弹窗不是同一处风险面。
- axe / Testing Library / user-event：未引入。

## 五、顺带发现：两个探针模式**在改动之前就是坏的**

`--archive` 与 `--reservations` 今天都跑不到日历：前者报"探针退化（view:数据视图）"，
后者报"日历视图根本没打开（0 个 `.lc-cell`）"。**用 `git stash` 把本批改动挪开、跑同一模式，
输出逐字相同** ⇒ 与本次迁移无关（stash 前记录了范围，pop 后 `git diff --stat` 与暂存前一致）。
后果：**弹窗的几何/内容判据目前是空的**（默认三档探针不打开弹窗）。这条记进
`TODO.md` §1.3，别让它继续冒充"有覆盖"。
