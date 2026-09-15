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
import { useCallback, useEffect, useRef, useState } from 'react'

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
  sessions: LiveSession[]
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
): UseLiveSessions {
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() })
  const [sessions, setSessions] = useState<LiveSession[]>([])
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
        if (seq === loadSeq.current) setSessions(s)
      })
      .catch((e: Error) => {
        if (seq === loadSeq.current) setError(e.message || '场次加载失败')
      })
      .finally(() => {
        if (seq === loadSeq.current) setLoading(false)
      })
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
    reload()
  }, [reload, refreshTick])

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
    ym, setYm, sessions, loading, error, setError, navDir, setNavDir,
    detail, setDetail, catPopOpen, setCatPopOpen, catPopRef,
    monthPopOpen, setMonthPopOpen, popYear, setPopYear, navRef, reload, reloadDetail,
  }
}

/* ── 场次浮层的交互常量（`pop` 状态本身留在组件侧：它承载 DOM rect，与渲染强耦合） ── */

/** 浮层关闭宽限（ms）：鼠标从格子滑向浮层中途不闪关 */
export const POP_CLOSE_GRACE_MS = 120
