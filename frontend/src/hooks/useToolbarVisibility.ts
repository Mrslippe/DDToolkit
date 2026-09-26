/**
 * 页面工具条的显隐状态机（R45 / R45-G；2026-09-26 从 `PostsPage` 整块搬出，devlog/218）。
 *
 * 工具条从"66px 常驻带子"改成"**覆盖**在内容上、**按需出现**"。三个数各有来源（**不新造**）：
 *   · `BAR_DWELL_MS=140` —— 过滤"路过"。热区在面板顶部，从顶栏往下进内容每次都要穿过它
 *     ⇒ 不设门槛就是"路过即闪"（macOS 自动隐藏 Dock 用的同一招）。
 *   · `BAR_GRACE_MS=900` —— 复用现成的拍子（原 `.bg-tools` 就是 900ms，"与侧栏悬浮滚动条同拍"）。
 *   · `BAR_FLASH_MS=1200` —— 冷启动 / 深休眠唤醒各闪现一次。
 *
 * ## ⚠️ 搬动时**逐字保留**的三条硬约束（都踩过、都有实测记录）
 *
 * 1. **`flashedThisSession` 必须是模块级**（不能变成 ref/state）：
 *    `PostsPage` 按路由挂载，切 V 会重挂；用组件内状态就会每次切 V 都闪一下 = 噪音。
 * 2. **"要不要闪"必须在渲染期决定一次**，不能挪进 effect 判断：
 *    StrictMode 下 effect 走 setup→cleanup→setup，cleanup 会把闪现定时器清掉；
 *    若判断也在 effect 里，第二次 setup 会因为「本会话已闪过」而早退，定时器再没人装
 *    ⇒ `barShown` **永久停在 true**（`ui_probe.py --toolbar` 实测抓到 `rest: shown=1 opacity=1`）。
 * 3. **`MutationObserver` 必须 `subtree: true`**，不能预先 `querySelectorAll` 抓节点快照：
 *    视图是之后才挂载的（切 V / 切视图整体重挂），快照抓空 ⇒ 一个都没 observe 上 ⇒
 *    **功能静默失效**（探针实测：`data-scroll-dir` 已是 `down`，工具条纹丝不动）。
 *
 * 另外：整个模块**不新增 effect**、不改依赖数组字面量 —— 抽 hook 的纪律是"搬位置，不改行为"。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { inHotZone } from '../utils/toolbarZone'

/** 进热区后要停留多久才呼出：**过滤"路过"**。 */
const BAR_DWELL_MS = 140
/** 离开热区后多久收回：**复用现成拍子**（原 `.bg-tools` 的 900ms）。 */
const BAR_GRACE_MS = 900
/** 冷启动 / 深休眠唤醒的闪现时长。 */
const BAR_FLASH_MS = 1200
/** 热区外扩：条与右上组各自的 rect 各向外 8px —— 够得到，又不把内容控件圈进来。 */
const BAR_ZONE_PAD = 8

/** 本会话是否已经"闪现"过（**模块级**，见文件头约束 1）。 */
let flashedThisSession = false

interface Args {
  /** 面板根（`MutationObserver` 挂它、`subtree: true` 覆盖后续挂进来的滚动体） */
  panelRef: RefObject<HTMLElement | null>
  /** 视图切换器 / 右上工具组：两个热区矩形 */
  switchRef: RefObject<HTMLElement | null>
  toolsRef: RefObject<HTMLElement | null>
  /** 深休眠唤醒（R18 带回了上次视图）⇒ 再闪一次；由页面在恢复路径里置位 */
  restoredRef: RefObject<boolean>
}

export function useToolbarVisibility({
  panelRef, switchRef, toolsRef, restoredRef,
}: Args) {
  const [barShown, setBarShown] = useState(false)
  const dwellTimer = useRef<number>()
  const graceTimer = useRef<number>()
  const flashTimer = useRef<number>()
  /** 上一次"在不在热区"。**只在边沿动作** —— mousemove 每秒几十次，
   *  每次都重设定时器就永远触发不了。 */
  const inZoneRef = useRef(false)
  /** 「刚被向下滚动按下去」的抑制位（R45-G）：指针**先离开热区**才允许再显示。
   *  没有它的话，指针停在热区里时 `mousemove` 会立刻把条弹回来。 */
  const scrolledRef = useRef(false)

  const showBar = useCallback(() => {
    window.clearTimeout(graceTimer.current)
    window.clearTimeout(flashTimer.current)
    setBarShown(true)
  }, [])

  const hideBarSoon = useCallback(() => {
    window.clearTimeout(dwellTimer.current)
    window.clearTimeout(graceTimer.current)
    graceTimer.current = window.setTimeout(() => setBarShown(false), BAR_GRACE_MS)
  }, [])

  /** 向下滚动 → **立即**让位（R45-G，2026-09-25 用户口径：只做这一半）。
   *
   *  为什么值得加：指针移开后本来就会收（900ms），但那 900ms 里用户**已经开始读了**，
   *  条还压在内容上。向下滚动是"我要看内容"最明确的信号 ⇒ 不必等那个拍子。
   *
   *  ⚠️ **为什么需要 `scrolledRef` 这个抑制位**：光调 `setBarShown(false)` 是**没用的** ——
   *     指针若还停在热区里，下一次 `mousemove` 会走 `inside === true` 那条路把它**立刻弹回来**
   *     （更糟：`inZoneRef` 还是 true，连边沿都不算，只有再进出一次才会重新计时）。
   *     所以按下之后，**必须等指针先离开热区**才允许再显示 —— 这正是用户选的
   *     「**向上滚不动，仍靠指针呼出**」：抑制位只在"离开热区"那一步清掉。
   *
   *  ⚠️ 用户口径（2026-09-25 二选一）：「**向上滚不动**」——
   *     所以**不要**在这里给 `up` 加"立即显示"（那会让条在滚轮时自己冒出来，
   *     与现有的"指针 dwell 才呼出"冲突）。 */
  const onScrollDown = useCallback(() => {
    scrolledRef.current = true
    window.clearTimeout(dwellTimer.current)
    window.clearTimeout(graceTimer.current)
    window.clearTimeout(flashTimer.current)
    setBarShown(false)
  }, [])

  /** 指针在不在热区。
   *  ⚠️ **必须按指针位置算，不能用 CSS `:hover`**：`.view-toolbar` 是
   *  `pointer-events:none`（硬要求 —— 整条压在内容上，若吃指针则顶 66px 内
   *  滚轮不滚列表、卡片顶部点不着，理由见 posts.css），收不到 mouseenter。
   *  ⚠️ 也**必须要求"移动进入"而不是"停留"**：数据视图的牌堆是**滚轮翻转**的，
   *  用户可能把指针停在顶部中间一直滚 —— 静止指针不产生 mousemove ⇒ 不误弹。
   *  这一条 dwell 单独做不到。
   *  判定逻辑本身抽在 `utils/toolbarZone.ts`（纯函数，**10 条单测**）——
   *  探针只走得到"命中 / 不命中"两个点，**边界与多矩形并集**靠那一层。 */
  const onPanelMouseMove = (e: { clientX: number; clientY: number }) => {
    const inside = inHotZone(
      e.clientX,
      e.clientY,
      [switchRef.current, toolsRef.current].map((el) => el?.getBoundingClientRect() ?? null),
      BAR_ZONE_PAD,
    )
    if (inside === inZoneRef.current) return // 只在边沿动作
    inZoneRef.current = inside
    if (inside) {
      // 刚被向下滚动按下去过 ⇒ 指针得先离开热区再回来，才准重新弹（R45-G）
      if (scrolledRef.current) return
      window.clearTimeout(dwellTimer.current)
      dwellTimer.current = window.setTimeout(showBar, BAR_DWELL_MS)
    } else {
      scrolledRef.current = false   // 离开热区 = 抑制解除（用户口径：靠指针呼出）
      hideBarSoon()
    }
  }

  // 冷启动首挂 / 深休眠唤醒 → 闪现一次。
  // 「完全隐藏」的唯一代价是新用户不知道切换器在哪 —— 用一次性闪现付掉；
  // 唤醒那次额外闪，是因为 R18 把上次视图带回来了，那一刻最需要知道"我在哪个视图"。
  //
  // ⚠️ **"要不要闪"必须在渲染期决定一次，不能放进 effect 里判断**（见文件头约束 2）。
  //    ⇒ `flashedThisSession` 只用来**决定**；effect 只负责**装定时器**，可重复执行。
  const wantFlashRef = useRef<boolean | null>(null)
  if (wantFlashRef.current === null) {
    wantFlashRef.current = !flashedThisSession || restoredRef.current
    flashedThisSession = true
  }
  useEffect(() => {
    if (!wantFlashRef.current) return
    showBar()
    const id = window.setTimeout(() => setBarShown(false), BAR_FLASH_MS)
    flashTimer.current = id
    return () => window.clearTimeout(id)
  }, [showBar])

  useEffect(
    () => () => {
      window.clearTimeout(dwellTimer.current)
      window.clearTimeout(graceTimer.current)
      window.clearTimeout(flashTimer.current)
    },
    [],
  )

  /** 向下滚动 → 立即让位（R45-G）。信号由 `OverlayScroll` 挂在滚动容器根节点的
   *  `data-scroll-dir` 上（`up` / `down`），这里只消费它。
   *
   *  ⚠️ **为什么读 attribute 而不是加 prop**：`OverlayScroll` 是**共享组件**（四个视图都用），
   *     给它加一个 `onScrollDir` prop 要动四处调用点、还要在每处接进状态机；
   *     而方向信号本来就以 attribute 形式挂在 DOM 上（与 `data-scrolled` 同一套），
   *     这里用 `MutationObserver` 订阅**只影响本页**，零改动其它视图（§6.1 的纪律：
   *     拆/改共享组件时，先问"这个改动会不会波及没打算动的地方"）。
   *
   *  ⚠️ **只在翻成 `down` 的那一刻动作**：`MutationObserver` 每次属性变化都回调，
   *     而滚动是连续的 —— 不加边沿判断就等于每个方向变化都调一次 `setBarShown`。
   *
   *  ⚠️ **观察整棵子树（`subtree: true`）**：见文件头约束 3。 */
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.attributeName !== 'data-scroll-dir') continue
        if ((r.target as HTMLElement).getAttribute('data-scroll-dir') === 'down') {
          onScrollDown()
        }
      }
    })
    mo.observe(panel, {
      attributes: true, attributeFilter: ['data-scroll-dir'], subtree: true,
    })
    return () => mo.disconnect()
  }, [onScrollDown, panelRef])

  return { barShown, onPanelMouseMove, onScrollDown, showBar }
}
