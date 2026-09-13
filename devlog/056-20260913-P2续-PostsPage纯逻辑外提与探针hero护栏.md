# 056-20260913-P2 收敛续：PostsPage 纯逻辑外提 + 探针 hero 位级护栏

> 继续 devlog/055 的路线 A。本批完成 `PostsPage` 的**纯逻辑外提**，
> 并补上一件 055 暴露出来的能力缺口：**探针此前对「展示页药丸搬坏了」完全无感**。
> 无迁移、无接口变更、无版本号变动。

## 一、`PostsPage` 纯逻辑外提（`utils/postTypes.ts`）

按 055 已验证有效的模式（**先搬能证明的那一半**），把三段**只在 cards 视图 + 药丸有内容时
才渲染**的纯逻辑从 1285 行的页面组件里提出来：

| 搬到 `utils/postTypes.ts` | 原本位置 | 为什么值得单独测 |
|---|---|---|
| `TYPE_GROUPS_BILIBILI` / `TYPE_GROUPS_WEIBO` / `typeGroupsFor` | `PostsPage` 顶层常量 | **平台化分类**（P9-2 / v0.9.6，devlog/047）在前端的落点：B 站与微博规则**故意不同**；且每个 chip 的 `key` 必须等于后端 `type` 参数支持的逗号分隔写法 —— **key 写错会让筛选发出无效 type、列表直接空掉** |
| `accountHomeUrl` | `accountHome` 内联函数 | B 站 `accounts.url` 实测常为空（devlog/048），兜底拼 `space.bilibili.com/{uid}`；平台白名单写错 = 点到空链接 |
| `orderAccounts` | `orderedAccounts` 的 `useMemo` | 拖拽排序的**两个边界**：order 里有已删账号（跳过）、accounts 里有 order 未覆盖的新账号（**必须追加到尾部，否则新账号在卡片上凭空消失**） |
| `chunkBy` | `pillSets` 的裸 for 循环 | 每 3 枚切集；空数组不能产出「一个空集」 |

**刻意没做的**：
- `PLATFORM_LABEL` 只搬不改 —— 我一度给它加了「未知平台原样回显」的回退，
  随即意识到那是**行为变更**（未收录平台原本渲染为空）而非重构，已撤掉，
  并在注释里写明「不要顺手加回退」，用例也只断言既有行为（`youtube → undefined`）。
- `pill()` / `kickPoll()`（事件总线派发）留在组件里：它们是副作用不是纯逻辑，
  搬出去只会让「谁在派发事件」更难追。

新增 `utils/postTypes.test.ts` **27 条**：平台分组顺序/构成、`key === types.join(',')` 契约、
同平台内类型/label/key 不重复（重复会让计数算两次）、主页 URL 的平台白名单与缺 uid 的 `null`、
拖拽排序的两个边界、切集边界。

`PostsPage.tsx`：**1285 → 1247**。诚实说明：**只减了 38 行** —— 这批的价值不在行数，
而在**把三段此前零覆盖的规则变成了可断言的东西**（顺带删掉了一个裸 for 循环与一个内联闭包）。

## 二、探针补能力：hero 药丸位级护栏（`--hero-expect`）

### 为什么必须加

055 把词云的纯算法用 sha256 基线护住了，但同批的药丸相关逻辑（`orderAccounts` /
`chunkBy` / `accountHomeUrl`）**没有任何护栏**：`ui_probe` 的布局不变量只管
「有没有元素出窗 / 有没有原生滚动条」，对「药丸少了一排 / 顺序变了 / 切集错了」
**完全无感** —— 恰恰是"搬坏了但探针全绿"的形态。

### 做法

`frontend/src/dev/probe.ts` 的 `measure()` 新增常驻量测 `hero`：

```ts
{ pillCount, setCount, setSizes, hasAddButton, signature: ["0:image:13.5万", …] }
```

`signature` 是逐枚的 `索引:色系:展示数值` —— **顺序变化会直接反映在数组顺序里**。
`scripts/ui_probe.py` 侧：

- `--hero-print`：只打印签名与明细（建立基线用）；
- `--hero-expect <sha256>`：比对，**不一致退出 1**；量不到 hero 段也判失败（不静默通过）。

### 实测（双向验证）

| 场景 | 结果 |
|---|---|
| V #14（单 B 站账号） | 签名 `10ebf7e0…`；`pillCount=1 setCount=1 setSizes=[1] hasAddButton=true`；明细 `["0:image:13.5万"]` |
| V #15 七海（B 站 + 微博 2 枚） | 签名 `c1154858…`；`pillCount=2 setCount=1 setSizes=[2]`；明细 `["0:image:111.5万", "1:image:105万"]` |
| 期望值匹配 | `[ok] hero 药丸签名与基线一致`，汇总 `[ok]`，退出 0 |
| **期望值故意写错** | `- @1280 cards: hero 药丸签名与基线不一致（实现漂移）` → `[FAIL] 1 处不变量被破坏`，**退出 1** |

> ⚠️ 诚实说明：这两个基线是**重构之后**取的，所以它们证明的是「护栏能工作」，
> 不是「重构前后一致」。真正的"只搬不改"证明来自 `utils/postTypes.test.ts`（27 条，
> 直接对着搬出来的纯函数断言）。两个护栏是互补的：**纯函数靠 vitest，渲染结果靠 hero 签名。**

### 顺带新增 `--vtuber <id>`

探针此前固定取 `/vtuber/list` 第一条，而**切集/排序逻辑只在药丸 >1 枚时才有意义**
（第一条恰好是单账号的 V #14）—— 没有这个开关，hero 护栏在多平台 V 上根本跑不到。
现可 `python scripts/ui_probe.py --vtuber 15 --hero-print`。

## 三、验证

| 检查 | 结果 |
|---|---|
| `pytest` | **266 passed** |
| `npx vitest run` | **89 passed**（5 文件：postTypes 27 / format 19 / liveCalendarFmt 19 / cloudPalette 14 / wordCloudLayout 10） |
| `npx tsc --noEmit` | exit 0 |
| 词云位级基线 | `19ecc7e6…` 仍一致（本批未碰词云） |
| `ui_probe` 三档 | 全绿：八段契约齐全、问题=0 |
| `ui_probe --hero-expect` | 匹配 → 0；故意不匹配 → **1**（双向验证） |
| `dev_check.py` | 全部通过 |

## 四、下一步（未做）

- **A-2** `hooks/useLiveSessions.ts`：`LiveCalendar` 仍有 **8 个 `useEffect`**，
  取数/月份/分类状态耦合在一起。这是 A 批次**风险最高**的一块 ——
  055/056 的手段（纯函数测试、hero 签名）都覆盖不到"拉取时序"，需要**一个一个 effect 抽、
  每抽一个跑一次探针**，并考虑给日历加一个类似 hero 的"格内文本签名"护栏（`--archive`
  已 dump 每格文本，可直接哈希，本批未做）。
- **A-3** `components/live/LiveSessionDialog.tsx`（`lc-dlg` 家族）。
- **A-4 剩余**：`HeroCardsView` / `PostListView` 两个视图组件拆分（本批只提了它们的纯逻辑）。
- **B** eslint + prettier（等 A 尘埃落定）。
- 探针补强（055 记录）：`--archive` 固定点「最近一场」，遇到刚下播未收录就量到 0
  却仍退出 0 —— 应改成「往前找第一场有 danmaku 的场次」。

## 五、经验

- **"重构不改行为"与"顺手修一下"必须分开**：本批差点把 `PLATFORM_LABEL` 的回退当成
  重构的一部分塞进去。判断标准很简单 —— **能用旧代码跑出"期望的新行为"吗？**
  不能，那就是行为变更，得单独一个批次、单独一条用例、单独写进 devlog。
- **护栏要覆盖到"你这次动的东西"**：055 给词云建了基线，却对同批的药丸逻辑没有护栏；
  056 补上后才算闭环。**每次重构前先问：这次的改动，如果搬坏了，哪个现有检查会红？**
  答不上来就先建护栏（本次答案是 `--hero-expect`）。
- **量测要先确认"量到了有意义的东西"**：hero 护栏第一次跑在单账号 V 上，
  `setSizes=[1]` —— 切集逻辑等于没测。用 `--vtuber` 换到 2 枚账号的 V 才有意义；
  而"3 枚一集"这个边界在当前真实数据里**根本不存在**（没有 V 有 ≥3 个账号），
  只能由 `chunkBy` 的单测覆盖。**探针只能验证真实数据存在的形态，单测才能覆盖边界。**
