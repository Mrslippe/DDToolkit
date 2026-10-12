/**
 * 直播日历的取数与派生状态（P2 分层收敛 A-2：从 `LiveCalendar.tsx` 搬出，**只搬不改**）。
 *
 * ## 搬什么、为什么这么切
 *
 * 切分边界是**「与渲染无关的状态机」**：月份游标、场次拉取（含 `loadSeq` 防账号切换回写）、
 * 详情弹窗开关、分类下拉、月份浮窗。日期格推导（`byDay`/`cells`/`monthStats`）留在组件里 ——
 * 它们直接产出渲染用的 `DayCell`，跟着渲染走更清楚。
 *
 * ## ⚠️ 顺序是契约，不是风格
 *
 * React 按**声明顺序**登记 hooks，effect 也按登记顺序在 commit 后执行。本 hook 内部的
 * 声明顺序**逐字对应**搬出前的原顺序：
 *
 * 1. `ym` 月份游标
 * 2. `sessions` / `loading` / `error`
 * 3. `detail` → **effect「收起分类下拉」**（依赖 `detail`）
 * 4. `monthPopOpen` / `popYear` / `navRef` → **effect「月份浮窗点外/Esc 关闭」**
 * 5. `loadSeq` / `load`（`useCallback`）→ **effect「数据拉取」** → **effect「刷新后关浮层」**
 *    → **effect「账号切换关详情」** → **effect「详情打开时锁页面滚动」**
 * 6. `catPopOpen` / `catPopRef` → **effect「分类下拉点外/Esc 关闭」**
 *
 * 在组件里这些曾经**交错**在 `pop` 声明之间（`pop` 本身不参与任何 effect）。
 * 现在 `pop` 留在组件、其余整体前移，因此**该组 effect 的相对顺序与依赖数组完全不变**；
 * 与 `pop` 相关的 effect 一个都没有，所以前移不改变任何触发时序。
 *
 * 这段说明不是形式主义：`tools/` 里没有能验证"拉取时序"的测试，
 * 唯一的证据是 `scripts/ui_probe.py --archive --calendar-expect <sha256>`
 * （日历 42 格实渲染文本的位级比对）。**改这个文件前后都必须跑它。**
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { LiveSession } from '../../api/types'
import { api } from '../../api/api'

export interface DetailState {
  /** 当日 key（YYYY-MM-DD）——用于丢弃过期的异步回写 */
  key: string
  /** 当前查看第 idx 场 */
  sessions: LiveSession[]
  idx: number
  data: import('../../api/types').LiveSessionDetail | null
  loading: boolean
}

/** 场次浮层状态：点击格子的锚点（rect 快照）与当日数据。
 *  `rect` 只用到三个边（浮层定位按 `left/top/bottom` 算），不收整个 DOMRect —— 少一层依赖。 */
export interface PopState {
  key: string
  rect: { left: number; top: number; bottom: number }
  sessions: LiveSession[]
  /** 当日未来预约（R13）：只有预约没有场次的日子也要能 hover 看到内容 */
  reservations?: import('../../api/types').UpcomingReservation[]
}

export interface UseLiveSessions {
  /** 月份游标（0-based 月） */
  ym: { y: number; m: number }
  setYm: React.Dispatch<React.SetStateAction<{ y: number; m: number }>>
  /** **筛选后**的场次（日历网格/日期格用它） */
  sessions: LiveSession[]
  /** 本账号**全量**场次（不受类型筛选影响）。
   *  ⚠️ 它存在的唯一理由是筛选条的计数：用 `sessions` 算会出现"选了 A 之后 B 的计数
   *  凭空消失"（用户没法再切到 B）。日历以外的读者别用它 —— 那会绕过筛选。 */
  allSessions: LiveSession[]
  loading: boolean
  error: string | null
  setError: React.Dispatch<React.SetStateAction<string | null>>
  /** 月份切换动画方向（1=前进/向右滑入，-1=后退/向左滑入）；keyed 重放 */
  navDir: 1 | -1
  setNavDir: React.Dispatch<React.SetStateAction<1 | -1>>
  /** 场次详情弹窗 */
  detail: DetailState | null
  setDetail: React.Dispatch<React.SetStateAction<DetailState | null>>
  /** 详情弹窗·分类下拉栏 */
  catPopOpen: boolean
  setCatPopOpen: React.Dispatch<React.SetStateAction<boolean>>
  catPopRef: React.RefObject<HTMLSpanElement>
  /** 月份选择浮窗（独立年份游标：打开时同步 ym 的年） */
  monthPopOpen: boolean
  setMonthPopOpen: React.Dispatch<React.SetStateAction<boolean>>
  popYear: number
  setPopYear: React.Dispatch<React.SetStateAction<number>>
  navRef: React.RefObject<HTMLDivElement>
  /** 按类型筛选（T4，2026-10-12）：空数组 = 不筛。
   *  ⚠️ 只按类型 key 筛（`category`），不筛别的 —— 与服务端 `types=` 同一套值。 */
  typeFilter: string[]
  setTypeFilter: React.Dispatch<React.SetStateAction<string[]>>
  /** 重新拉取场次列表（分类校正保存后调用） */
  reload: () => void
  /** 重新拉取某场详情（校正后让徽章/分类来源即时更新）。
   *  与 `reload()` 独立，避免"校正一次打两次列表请求"。 */
  reloadDetail: (liveId: string) => Promise<void>
}

/**
 * @param accountId 账号 id（null=无账号：不拉取，显示空态）
 * @param refreshTick 外部刷新信号（`fetch-idle` 边沿后自增）
 * @param now 当前时间（由调用方每次渲染现取 `new Date()` —— 保持搬出前"todayKey 随渲染更新"的语义）
 */
export function useLiveSessions(
  accountId: number | null,
  refreshTick: number,
  now: Date,
  /** 数据刷新后浮层锚点失效 → 由调用方关闭浮层。
   *  `pop` 承载 DOM rect、与渲染强耦合，留在组件侧；这里只发「该关了」的信号。 */
  onDataRefresh: () => void,
  /** 场景预取抢跑的那一份场次（2026-10-13）——**只当首帧种子**。
   *
   *  为什么有它：切到数据视图时，那 150ms 的退场窗口（`EXIT_MS`）本来白空着，而卡片要等
   *  挂载之后才开始取数（实测这一发中位 ~176ms）⇒ 用户看到"动画播完才慢慢出内容"。
   *  页面在退场期间就把这一发打出去，抢在窗口里完成的话首帧直接有数据。
   *
   *  ⚠️ 三条纪律：
   *  1. **只认挂载时的那一份**（`useState` 初值）—— 后续 `refreshTick` 触发的重取照旧自己打，
   *     种子不会、也不该被反复喂进来；
   *  2. **它只影响 `allSessions` 的初值**，不参与筛选/统计的任何判断（那些都是派生量）；
   *  3. 种子为 `null`（没抢到 / 失败）⇒ 完全等于改动前的行为（`loading` 起来、自己取）。 */
  seedSessions: LiveSession[] | null = null,
): UseLiveSessions {
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() })
  /** 场次列表：**首帧用场景预取的种子**（有的话），否则空 —— 见参数 `seedSessions` 的说明。
   *  ⚠️ 只取初值：`useState(seed ?? [])` 之后这个种子就不再进画面了（重取走 `reload`）。 */
  const [allSessions, setAllSessions] = useState<LiveSession[]>(() => seedSessions ?? [])
  /** 类型筛选（T4）：**留在这里而不是组件里**，这样 `reload()` 的口径只有一处 ——
   *  否则"刷新之后筛选还在不在"会变成两条路径各答一次。 */
  const [typeFilter, setTypeFilter] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 月份切换动画方向（1=前进/向右滑入，-1=后退/向左滑入）；keyed 重放 */
  const [navDir, setNavDir] = useState<1 | -1>(1)

  /** 详情弹窗·分类下拉栏（点左上角胶囊展开：全部彩色分类胶囊，点选取）。
   *  ⚠️ 必须声明在下面那条依赖 `detail` 的 effect **之前**：那个 effect 体里会
   *  `setCatPopOpen(false)`，而 `const` 有 TDZ —— 顺序反过来在渲染期就抛 ReferenceError。
   *  （原文件里 `catPopOpen` 也在 `detail` 之前，这里保持一致。） */
  const [catPopOpen, setCatPopOpen] = useState(false)
  const catPopRef = useRef<HTMLSpanElement>(null)

  const [detail, setDetail] = useState<DetailState | null>(null)
  // 弹窗打开/切换场次/关闭 → 收起下拉栏
  useEffect(() => {
    setCatPopOpen(false)
  }, [detail])

  // 月份选择浮窗：独立年份游标（打开时同步 ym 的年）
  const [monthPopOpen, setMonthPopOpen] = useState(false)
  const [popYear, setPopYear] = useState(now.getFullYear())
  const navRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!monthPopOpen) return
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setMonthPopOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMonthPopOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [monthPopOpen])

  /** 已经用过种子的那个 `(账号, refreshTick)`（见参数 `seedSessions`）。
   *  `useRef` 的初值只在挂载时求值一次 ⇒ 记的就是"首帧这一发是不是种子"。 */
  const seededKeyRef = useRef<string | null>(
    seedSessions && accountId != null ? `${accountId}:${refreshTick}` : null,
  )

  // 场次拉取（字段 2026-09-07：只检索主账号直播信息；loadSeq 防账号切换回写）
  const loadSeq = useRef(0)
  const reload = useCallback(() => {
    if (accountId == null) return
    const seq = ++loadSeq.current
    setLoading(true)
    setError(null)
    api
      .liveSessions(accountId)
      .then((s) => {
        if (seq === loadSeq.current) setAllSessions(s)
      })
      .catch((e: Error) => {
        if (seq === loadSeq.current) setError(e.message || '场次加载失败')
      })
      .finally(() => {
        if (seq === loadSeq.current) setLoading(false)
      })
  }, [accountId])

  /** 筛选在**服务端**做吗？—— 不。T4 的 `types=` 确实在服务端（`routers/vtuber.py`），
   *  但这一页每次都要**全量**（筛选条的计数要看得见别的类型），所以这里一次取全量、
   *  在本地按同一个 key 筛。⚠️ 判据是"筛的是什么"（类型 key，服务端定的值），
   *  不是"在哪一行代码里筛" —— 前端不重新定义任何类型的含义。 */
  const sessions = useMemo(() => {
    if (!typeFilter.length) return allSessions
    const want = new Set(typeFilter)
    return allSessions.filter((s) => want.has(s.category ?? 'live'))
  }, [allSessions, typeFilter])

  /** 账号切换 → 清掉类型筛选（新账号的分布不同，留着会显示成"这个 V 没有场次"）。 */
  useEffect(() => {
    setTypeFilter([])
  }, [accountId])

  /** 分类校正后刷新详情：原实现是「校正完直接打详情接口再回写」，
   *  这里保持同样的行为（不是主动 refetch —— 避免多打一次列表请求）。 */
  const reloadDetail = useCallback(async (liveId: string) => {
    if (accountId == null) return
    try {
      const d = await api.liveSessionDetail(accountId, liveId)
      setDetail((prev) => (prev ? { ...prev, data: d } : prev))
    } catch {
      // 详情刷新失败不影响校正结果本身（列表已 reload）
    }
  }, [accountId])

  useEffect(() => {
    // 首帧那一发如果是**种子**，跳过它：种子就是几毫秒前上游给的那一份（场景预取刚打完），
    // 再打一遍只会让同一屏发两个一模一样的请求。之后 `refreshTick` 一变照旧自己取
    // （`fetch-idle` 每轮会 bump 它，见 `utils/fetchIdle.ts::affectsLiveCalendar`）。
    const key = accountId != null ? `${accountId}:${refreshTick}` : null
    if (key !== null && seededKeyRef.current === key) {
      seededKeyRef.current = null
      return
    }
    reload()
  }, [reload, refreshTick, accountId])

  // 数据刷新后浮层锚点已失效 → 关闭（月份/账号切换同理）
  useEffect(() => {
    onDataRefresh()
    // 依赖数组与搬出前一致（当时是 [ym, accountId, sessions]）。
    // onDataRefresh 每次渲染都是新函数，把它放进依赖会让这条 effect 每次渲染都跑 ——
    // 那正是原行为的反面（原意是「数据/月份/账号变了才关浮层」）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ym, accountId, sessions])

  // 账号切换 → 关闭详情弹窗（数据归属变化）
  useEffect(() => {
    setDetail(null)
  }, [accountId])

  // 弹窗打开期间锁页面滚动（2026-09-07：滚动条贴窗口右缘/越顶问题）
  useEffect(() => {
    if (!detail) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [detail])

  /** 详情弹窗·分类下拉栏的点外/Esc 关闭（依赖 catPopOpen；状态在文件上部声明） */
  useEffect(() => {
    if (!catPopOpen) return
    const onDown = (e: MouseEvent) => {
      if (catPopRef.current && !catPopRef.current.contains(e.target as Node)) {
        setCatPopOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCatPopOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [catPopOpen])

  return {
    ym, setYm, sessions, allSessions, loading, error, setError, navDir, setNavDir,
    detail, setDetail, catPopOpen, setCatPopOpen, catPopRef,
    monthPopOpen, setMonthPopOpen, popYear, setPopYear, navRef,
    typeFilter, setTypeFilter, reload, reloadDetail,
  }
}

/* ── 场次浮层的交互常量（`pop` 状态本身留在组件侧：它承载 DOM rect，与渲染强耦合） ── */

/** 浮层关闭宽限（ms）：鼠标从格子滑向浮层中途不闪关 */
export const POP_CLOSE_GRACE_MS = 120
