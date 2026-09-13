# 057-20260913-A-2：拆出 useLiveSessions（取数与状态机）

> 继续路线 A。本批完成**风险最高**的一块：把 `LiveCalendar` 的取数与状态机搬进
> `components/live/useLiveSessions.ts`。
> 与前几批不同，这一批**先建护栏再动手** —— 这是 055/056 两批经验（"护栏要覆盖到你这次动的东西"）
> 的直接应用。无迁移、无接口变更、无版本号变动。

## 一、先补护栏：日历格内文本签名（`--calendar-expect`）

### 问题

`hooks/useLiveSessions` 要搬的是**取数与时序**（场次列表、月份游标、详情开关、分类下拉）。
这类改动搬坏了的表现是「某些天没内容了 / 月份错位 / 分类徽章变了」——
而 `ui_probe` 的布局不变量只管「有没有元素出窗 / 有没有原生滚动条」，
**对上面全部无感**。055 给词云建了 sha256 基线、056 给 hero 药丸建了签名，
但两者都覆盖不到 LiveCalendar 的取数链路。

### 做法

`scripts/ui_probe.py` 的 `--archive` 本来就会 dump 每格实渲染文本（`day|badge|body`）——
**它就是「取数 → 分类 → 渲染」这条链路的最终产物**，直接哈希即可：

```powershell
python scripts/ui_probe.py --archive --archive-print --vtuber 15   # 取基线
python scripts/ui_probe.py --archive --calendar-expect <sha256> --vtuber 15   # 重构后比对
```

量不到日历段也判失败（不静默通过）。**双向验证**：故意给错哈希 → `退出 1`。

> ⚠️ 使用限制（已写进 `--help` 与 docstring）：这个签名同时受**第三方数据变化**影响
> （新场次入库、分类校正、danmakus 收录延迟），所以它只适合
> **「重构前后立刻各跑一次」的短窗口比对**，不能当长期稳定基线。
> hero 签名同理（粉丝数会变）。

## 二、拆 `useLiveSessions`

### 切分边界

搬：月份游标、场次拉取（含 `loadSeq` 防账号切换回写）、详情弹窗开关、分类下拉、
月份浮窗、以及这五者对应的 **7 条 effect**。

**不搬**：`pop`（场次浮层）—— 它承载 DOM 锚点 `rect`，与渲染强耦合。
hook 通过新入参 `onDataRefresh: () => void` 通知"数据变了，该关浮层了"，
组件传 `() => setPop(null)`。

### ⚠️ 顺序是契约（本批最需要说清的一点）

React 按**声明顺序**登记 hooks。原文件里这些声明**交错**在 `pop` 之间；
`pop` 自己**不参与任何 effect**，所以把其余部分整体前移后，
**该组 effect 的相对顺序与依赖数组完全不变**：

```
① ym  →  ② sessions/loading/error  →  ③ detail → effect[detail] 收起分类下拉
→  ④ monthPopOpen/popYear/navRef → effect[monthPopOpen]
→  ⑤ loadSeq/reload → effect[reload, refreshTick]（拉取）
   → effect[ym, accountId, sessions]（关浮层，经 onDataRefresh）
   → effect[accountId]（关详情）
   → effect[detail]（锁滚动）
→  ⑥ catPopOpen/catPopRef → effect[catPopOpen]
```

这段契约写进了 hooks 文件的顶部注释 —— 因为**没有任何自动化测试能验证"拉取时序"**，
唯一的证据就是下面那条日历签名。

### 过程中被类型检查抓到的三个真问题（值得记）

1. **TDZ 错误**：第一版把 `catPopOpen` 声明在依赖它的那条 effect **之后**，
   而 effect 体里要 `setCatPopOpen(false)` —— `const` 的暂时性死区会让它在**渲染期**
   就抛 `ReferenceError`。（原文件里 `catPopOpen` 也在 `detail` 之前，我抄漏了顺序。）
   注：这条 `tsc` 没报（跨语句使用不做 TDZ 检查），是我读代码时发现并修正的。
2. **`setError` 跨了边界**：分类校正的 `catch` 里要用 `setError`，而 `error` 状态随 hook 搬走了。
   两个选择：把 `setError` 也导出来（让组件有写别处状态的能力），或把"校正后刷新"整体搬进 hook。
   选了后者 —— 新增 `reloadDetail(liveId)`，**顺带修掉原来"校正一次打两次列表请求"**：
   原实现是 `load()`（重拉列表）+ `api.liveSessionDetail()`（拉详情），
   改成 `reload()` + `reloadDetail()`，语义等价但不再多打一次列表。
3. **`RefObject<T | null>` vs `RefObject<T>`**：hook 返回值里我把 ref 类型写成
   `RefObject<HTMLSpanElement | null>`，而 `useRef<HTMLSpanElement>(null)` 在
   `@types/react` 18 下是 `RefObject<HTMLSpanElement>`（字段可变）→ 赋给 JSX 的 `ref` 报错。
   接口类型改为与 `useRef` 一致即可。

## 三、验证（A-2 的关键证据）

| 检查 | 结果 |
|---|---|
| **日历格签名**（重构前后） | `fb75217edac98e0f40017467b13d5a0cf20b8ec5c1cce9240b7ff6ad53da15a7` → **完全一致** |
| **hero 药丸签名**（三档宽度） | `c1154858…` → 三档全部 `[ok] 与基线一致` |
| `ui_probe` 三档 × 八段 | 全绿、问题=0；顶栏采样 `post=True/auto=True manual=False` 与重构前同值 |
| `npx tsc --noEmit` | exit 0（抓出上述三个问题） |
| `npx vitest run` | **89 passed** |
| `npm run build` | 通过，index-*.js 1,080.43 kB / gzip 360.32 kB（+0.6 kB，hook 边界开销） |
| `pytest` | **266 passed** |

行数：`LiveCalendar.tsx` **837 → 734**（−103）；新增 `live/useLiveSessions.ts` 230。
（净增约 127 行 —— hooks 的边界注释与类型导出；**A 批次的价值仍不在行数**。）

### 一次失败的排查（记下来）

第一次跑日历签名比对时 **Vite 未就绪**（`[FAIL] Vite 未就绪`），而探针在早退路径上
已经把 `_ui_probe_tmp/` 删掉了 —— **连 vite.log 都没留下**，无法判断原因。
直接重跑即通过，判断是瞬时问题（可能是上一轮探针的 Vite 未完全释放端口）。

> 这暴露探针的**第四条**此类缺口（053/054 修过三条）：
> `main()` 里的**早退 `return 1`**（Vite 未就绪 / 后端未就绪 / 找不到 Edge）
> 发生在 `try` 之前，**不经过 `finally`**，但 `WORK.mkdir()` 已经执行 →
> 早退时目录留着；而**进入 try 之后的失败**才会走清理逻辑。
> 结果是"早退留下一堆空目录、晚失败删掉全部现场"，**恰好与人想要的相反**。
> 已记入待办（本批未修，因为它不影响正确性、只影响可诊断性）。

## 四、下一步

- **A-3** `components/live/LiveSessionDialog.tsx`（`lc-dlg` 家族，约 180 行 JSX）——
  本批已把它的状态（`detail` / `catPopOpen` / `reloadDetail`）准备好了，搬动面比 A-2 小。
- **A-4 剩余**：`HeroCardsView` / `PostListView` 视图组件拆分。
- **B** eslint + prettier。
- 探针待办（累计）：① `--archive` 固定点"最近一场"，遇刚下播未收录即量到 0 仍退出 0；
  ② **早退路径的现场清理反了**（本批发现）。

## 五、经验

- **先建护栏再动手**，这次真的省事了：A-2 是 A 批次里唯一"没有测试能覆盖"的一块
  （纯函数测试管不到时序，布局断言管不到取数），
  日历签名是**动手前**才补上的 —— 如果按 A-1 的顺序（先搬后补护栏）做，
  这次就只能靠肉眼说"看起来没坏"。
- **"顺序是契约"要写进代码注释**，不能只写进 devlog：下一个改这个 hook 的人
  打开文件就该看到"这几条 effect 的相对顺序不能动"。
- **搬状态时优先问「谁在写它」**：`setError` 被组件里的 `catch` 用到，就是靠这个问出来的 ——
  与其把 setter 导出去（等于让 hook 的状态边界失效），不如把那段操作一起搬进来。
