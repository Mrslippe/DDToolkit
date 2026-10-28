import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronUp } from 'lucide-react'
import { api } from '../api/api'
import type {
  FanActivity, FanCollectProgress, FanPackage, FanPackageMeta, FanRanked, FanRankedRow,
  FanSessionPreview, FanSortBy, FanVtuber,
} from '../api/types'
import FloatPill from '../components/common/FloatPill'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog'
import Heatmap from '../components/workbench/Heatmap'
import ProfileCard from '../components/workbench/ProfileCard'
import PurgeButton from '../components/workbench/PurgeButton'
import RangeButton from '../components/workbench/RangeButton'
import RankedTable from '../components/workbench/RankedTable'
import ResultCharts, { EMPTY_TEXT, type RankedTab, type ResultTab } from '../components/workbench/ResultCharts'
import ResultTabs from '../components/workbench/ResultTabs'
import ComparePanel from '../components/workbench/ComparePanel'
import MemberDrawer from '../components/workbench/MemberDrawer'
import WindowSlider, { type WindowRange } from '../components/workbench/WindowSlider'
import { withNetRetry } from '../utils/netRetry'
import {
  cancelCollect, dismissTask, startAnalyze as startAnalyzeTask,
  startCollect as startCollectTask, useFanTask,
} from '../hooks/useFanTask'
import { findPackage, refreshFanPackages, useFanPackagesIndex } from '../hooks/useFanPackages'
import '../styles/workbench.css'

/**
 * 每个主播的页面状态缓存（2026-10-25，内存态）。
 *
 * 为什么要它：切到别的 V 再切回来，窗口位置/档位、页签、已加载名单都会被重置，
 * 用户得重新摆一遍。这里按 V 记下来，切回来原地恢复。
 * 只存内存：重启应用即清空 —— 数据更新后不会残留过期结果。
 */
interface VPageState {
  tab: ResultTab
  ranked: FanRanked | null
  rows: FanRankedRow[]
  hasMore: boolean
  tagFilter: string[]
}
const V_STATE = new Map<string, VPageState>()

/**
 * 清空"按 V 记住的页面状态" —— **只给用例用**（2026-10-28）。
 *
 * `V_STATE` 是模块级的（切 V 要保住上一份结果），不重置就会串到下一个用例：
 * 表现是"这条用例里切到弥月，却看到了上一条留在 V_STATE 里的结果"。
 */
export function resetWorkbenchState(): void {
  V_STATE.clear()
}
/** 上次查看的主播：切到别的页面再回来，应回到同一个 V（2026-10-25） */
let LAST_PICKED = ''

/** 超过这么多场就先弹确认（2026-10-25）：实测约 0.2 秒/场，60 场 ≈ 12 秒起 */
const BIG_WINDOW = 60

/** 场次 → 预估秒数（实测 72 场约 15 秒，取 0.21 s/场，向上取整到 5 秒） */
function estimateSecs(n: number): number {
  return Math.max(5, Math.ceil((n * 0.21) / 5) * 5)
}

/** 名单每页条数（图看全池，名单分页 —— 2026-10-23） */
const PAGE = 20
/** 页签 → 后端排序口径 */
const TAB_BY = {
  overview: 'strength',
  attendance: 'attendance',
  interaction: 'interaction',
  payment: 'payment',
} as const

/** 对比页不请求名单；其余页签按 `TAB_BY` 取口径。 */
const byOf = (t: ResultTab) => TAB_BY[(t === 'compare' ? 'overview' : t) as RankedTab]

/**
 * 把底层错误翻成能指导下一步的话。
 *
 * `Failed to fetch` 是 fetch 层的 TypeError（连接被拒 / 请求超时 / CORS 失败），
 * 对用户零信息量 —— 而它最常见的原因恰恰是「区间枚举落到了上游兜底，上游 502 挂住」。
 */
function friendly(e: Error): string {
  const m = e.message || ''
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
    return '取不到区间预估：后端没有响应（通常是上游枚举超时）。可以稍后重试；'
      + '已采过的数据仍能「分析」。'
  }
  return m
}

/**
 * 数据分析工作台（2026-10-19 结果区改造）。
 *
 * 布局：
 * 1. 上排：档案卡（切换主播 / 签名 / 采集覆盖）+「直播与采集」卡（热力图 + 场次滑杆
 *    + **右下角的采集/分析按钮**）；
 * 2. 结果区：**结果的主展示区**。三态 —— 未出结果讲流程 / 进行中给百分比与进度条 /
 *    出结果给两张小卡片（分层饼图 + 核心度分布）；
 * 3. 页脚口径。
 *
 * 三条口径：
 * - 窗口按**场次**取（25/50/75），换算成日期区间调采集接口；实测误差 0~1 场。
 * - **未知 ≠ 0**：`preview` 没回来时"待采"显示 `—`，不能当成零（否则按钮会谎称"已全部采集"）。
 * - 结果区的两张图只反映**当前名单里的人**（后端 `limit` 条），不是全池子。
 */
export default function WorkbenchPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [vtubers, setVtubers] = useState<FanVtuber[]>([])
  const [picked, setPicked] = useState<string>(LAST_PICKED)
  const [activity, setActivity] = useState<FanActivity | null>(null)
  /** `activity` 属于哪个 V：切换 V 的过渡帧里滑轨不能按新 key 读写缓存 */
  const [activityOwner, setActivityOwner] = useState<string>('')
  const [win, setWin] = useState<WindowRange | null>(null)
  const [preview, setPreview] = useState<FanSessionPreview | null>(null)
  /* 采集任务由**应用级 store** 持有（2026-10-28，B 批）：
     关浮窗、切页签都不打断轮询；工作台只是它的一个消费者。
     ⚠️ 进度可能属于**另一个 V**（跑着跑着切走了）⇒ 显示时用 `task.vtuber`，不要用 `picked`。 */
  const task = useFanTask()
  const progress = task.kind === 'collect' ? task.progress : null
  const [ranked, setRanked] = useState<FanRanked | null>(null)
  /** 当前 `ranked` 数据属于哪个页签：切页签后数据未到时，图表区不渲染（避免挂载两次） */
  /* 结果区图表**不再**按"数据是否跟上页签"门控（2026-10-28 删掉 `rankedTab`）：
     图表数据与排序口径 `by` 无关，切页签直接沿用旧结果即可；
     旧门控的真实代价是"切页签那一刻图表区渲染成空占位" ⇒ 用户看到卡片消失。 */
  const [tab, setTab] = useState<ResultTab>('overview')
  /** 懒加载累积的行（切页签时清空） */
  const [rows, setRows] = useState<FanRankedRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  /** 大窗口确认（2026-10-25）：场次多时先告知预估耗时，避免用户以为卡死 */
  const [bigWinAsk, setBigWinAsk] = useState<number | null>(null)
  /** 分析已用时（秒），仅 running 时在提示里显示 */
  const [busySecs, setBusySecs] = useState(0)
  /** 标签筛选（2026-10-24）：目录与选中项 */
  const [tagOptions, setTagOptions] = useState<{ name: string; prevalence: number }[]>([])
  const [tagLoading, setTagLoading] = useState(false)
  const [tagError, setTagError] = useState<string | null>(null)
  const [tagFilter, setTagFilter] = useState<string[]>([])
  /** 当前筛选的实时副本：`loadRanked` 可能被定时/翻页调用，闭包里的 state 会过期 */
  const tagFilterRef = useRef<string[]>([])
  /** 打开详情的成员 uid（null = 关闭） */
  const [memberUid, setMemberUid] = useState<string | null>(null)
  /** 回顶浮钮：滚动超过一屏才出现（与 PostListView 同一套做法） */
  const pageRef = useRef<HTMLDivElement | null>(null)
  const [showTop, setShowTop] = useState(false)
  /** 换区间后旧结果已不一定对应当前窗口 —— **保留但标灰**，而不是清空（用户 2026-10-19 选 a） */
  const [rankedStale, setRankedStale] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** 采集结束后的结果弹窗（done / failed / cancelled）；null = 不显示 */
  const [summary, setSummary] = useState<FanCollectProgress | null>(null)
  /** 重试计数：失败时点「重试」把它 +1，预估的 effect 就会再跑一次 */
  const [retryTick, setRetryTick] = useState(0)
  /* 滑轨的**时间跨度**（= 采集时间窗口的边界）。两种模式（2026-10-19 用户口径）：
     - **默认**：跟着热力图当前年份走（翻页也跟）—— 用滑杆挑窗口；
     - **手选**：左下角日期按钮选了一段 ⇒ 滑轨与窗口自动收敛到这段范围；
       一旦热力图翻页，自动退回默认模式。 */
  const [year, setYear] = useState<number>(() => new Date().getFullYear())
  const [pickedRange, setPickedRange] = useState<{ from: string; to: string } | null>(null)
  /** 手选后让滑杆「覆盖全部」的触发键（值变化才生效） */
  const [coverTick, setCoverTick] = useState(0)
  const range = pickedRange ?? { from: `${year}-01-01`, to: `${year}-12-31` }

  // 1) 主播表 + 模块开关
  useEffect(() => {
    let alive = true
    withNetRetry(() => api.fanVtubers())
      .then((r) => {
        if (!alive) return
        setEnabled(r.enabled)
        setVtubers(r.items)
        const first = r.items.find((v: FanVtuber) => v.has_data) ?? r.items[0]
        if (first) setPicked((p) => p || first.name)
      })
      .catch((e: Error) => alive && setErr(friendly(e)))
    return () => { alive = false }
  }, [])

  // 2) 换主播 ⇒ 重新取热力图与滑杆数据（模块没开时一个 /fan 端点都不许打）
  /* 结果包（2026-10-28）：每个 V 一份已算好的结果，切回它时直接铺（用户第 1 条） */
  /** 当前结果来自哪个包（null = 现算的，或还没结果）；用来显示「缓存 · 时刻」与覆盖确认 */
  const [pkgMeta, setPkgMeta] = useState<FanPackageMeta | null>(null)
  /** 交给滑杆的"把窗口设成这一组"指令（只认 tick 变化） */
  const [restore, setRestore] = useState<
    { start: number; size: number; since: string; until: string; tick: number } | null
  >(null)
  const restoringRef = useRef('')

  /* 切 V：先把上一个 V 的状态存起来，再恢复目标 V 的（2026-10-25） */
  const prevPicked = useRef<string | null>(null)
  // 用 layoutEffect：状态在**绘制前**就位，避免"先空一帧再填回来"的闪动
  useLayoutEffect(() => {
    if (!picked) return
    const prev = prevPicked.current
    if (prev && prev !== picked) {
      // 存下标：日期区间依赖各 V 自己的场次列表，跨 V 互相套会错位
      V_STATE.set(prev, { tab, ranked, rows, hasMore, tagFilter })
    }
    prevPicked.current = picked
    LAST_PICKED = picked

    const saved = V_STATE.get(picked)
    // 没分析过就**空置**：不能把上一个 V 的结果留在屏幕上（2026-10-25 用户口径）
    setTab(saved?.tab ?? 'overview')
    setRanked(saved?.ranked ?? null)
    setRows(saved?.rows ?? [])
    setHasMore(saved?.hasMore ?? false)
    setTagFilter(saved?.tagFilter ?? [])
    setWin(null)          // 交给滑轨按 saved.start/size 重新 emit 正确日期
    setPkgMeta(null)      // 包由下面那条 effect 在 activity 到位后决定要不要恢复
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked])

  /**
   * **切回某个 V 时恢复它的结果包**（2026-10-28 用户第 1 条）。
   *
   * 为什么等 `activity` 到位再恢复：包里有窗口大小但没有滑杆的 `start` 下标，
   * 只能用包里的 `live_ids` 在 `activity.recent` 里反查 —— 没有 recent 就跳不准区间。
   * 会话内已经分析过的（`V_STATE` 里有 ranked）优先：那是用户刚做的选择，别用旧包盖掉。
   */
  const pkgList = useFanPackagesIndex()
  useEffect(() => {
    if (!picked || !activity || activityOwner !== picked) return
    if (V_STATE.get(picked)?.ranked) return
    const meta = findPackage(picked)
    if (!meta) return
    const stamp = `${picked}|${meta.computed_at}`
    if (restoringRef.current === stamp) return
    restoringRef.current = stamp

    const recent = activity.recent ?? []
    const ids = new Set(meta.live_ids ?? [])
    const idx = recent.findIndex(
      (s) => ids.has(String((s as { live_id?: string }).live_id ?? '')),
    )
    const start = idx >= 0 ? idx : Math.max(0, recent.length - meta.window)
    setWin({ start, size: meta.window, since: meta.since ?? '', until: meta.until ?? '' })
    /* 日期区间也要跟着跳（用户第 1 条原话："时间区间也默认跳到这个结果对应的区间"）。
       `win` 只喂数据请求；界面上那行"2026 整年 / 起止日"读的是 `pickedRange`。 */
    if (meta.since && meta.until) setPickedRange({ from: meta.since, to: meta.until })
    setRestore({ start, size: meta.window, since: meta.since ?? '', until: meta.until ?? '',
                 tick: Date.now() })
    setPkgMeta(meta)
    analyzedRef.current = true
    setRankedStale(false)
    void (async () => {
      try {
        const full = await api.fanPackage(picked, true) as FanPackage
        if (!full?.payload) return
        setRanked(full.payload)
        setRows(full.payload.items ?? [])
        const total = full.payload.list_total ?? full.payload.pool?.size
          ?? full.payload.total_in_pool
        const n = full.payload.items?.length ?? 0
        setHasMore(n > 0 && n < total)
      } catch {
        /* 包读不出来（被删/损坏）：退回现算，用户点「分析」即可 */
        setPkgMeta(null)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, activity, activityOwner, pkgList.length])

  useEffect(() => {
    if (enabled !== true || !picked) return
    let alive = true
    /* ⚠️ 不要在这里 setActivity(null)（2026-10-19 用户问到"确认后界面重绘一次正常吗"）：
       清空会让整块先闪成「读取直播记录…」再出内容。保留旧数据、拿到新的再替换，
       观感是"原地更新"而不是"重绘"。 */
    /* ⚠️ A1（2026-10-19）：**不要 setWin(null)**。
       一清空统计条就整行消失、等新数据回来又出现 —— 用户说的"刷新"就是这个。
       保留旧窗口值；新 `recent` 到达后滑杆会重新 emit 一次，自然替换。 */
    setRankedStale(true)          // 旧结果保留，但标注"基于旧区间"
    withNetRetry(() => api.fanActivity(picked, 400, { since: range.from, until: range.to }))
      .then((r) => { if (alive) { setActivity(r); setActivityOwner(picked) } })
      .catch((e: Error) => { if (alive) setErr(friendly(e)) })
    return () => { alive = false }
  }, [enabled, picked, range.from, range.to])

  // 3) 窗口变了 ⇒ 重新预估
  const onWindow = useCallback((r: WindowRange) => { setWin(r) }, [])
  const since = win?.since ?? ''
  const until = win?.until ?? ''

  /* A4（2026-10-19）：**200ms 防抖** + 请求期间保留旧 preview。
     换区间/拖滑杆会连续改 since/until，不防抖就是一串请求、每次都可能把数字刷成 —。 */
  useEffect(() => {
    if (enabled !== true || !picked || !since || !until) return
    let alive = true
    const timer = window.setTimeout(() => {
      withNetRetry(() => api.fanSessions(picked, since, until))
        .then((r) => { if (alive) setPreview(r) })
        .catch((e: Error) => { if (alive) setErr(friendly(e)) })
    }, 200)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [enabled, picked, since, until, retryTick])

  // 4) 采集**结束的边沿**（轮询本身已搬到 `hooks/useFanTask.ts`，关浮窗/切页都不停）：
  //    结束时刷新活动读数 + 弹一次结果。`finishedAt` 是任务级的，只变一次。
  const finishedAt = task.finishedAt
  useEffect(() => {
    if (!finishedAt) return
    const p = task.result
    /* 分析在后台算完（2026-10-28）：结果已在后端 `_CACHE` 里 ⇒ 这里只是**取回来**。
       ⚠️ 仍然不自动分析采集结果 —— 这是"分析结束了要显示"，不是"采集完了自己分析"。 */
    if (task.kind === 'analyze') {
      /* 刚算完 ⇒ 盘里已经写入了新包：刷新索引（切回这个 V 时才能直接铺），
         并把「缓存于」标记清掉 —— 这是**新算的**，不是上次留下的。 */
      void refreshFanPackages()
      setPkgMeta(null)
      void loadRanked('strength', 0, false, tagFilterRef.current)
      return
    }
    if (!p) return
    withNetRetry(() => api.fanActivity(picked)).then(setActivity).catch(() => {})
    /* ⚠️ **采集与分析解耦**（2026-10-19 用户第 2 条 + 2026-10-28 复核）：
       这里只弹采集结果，要不要分析由用户决定。 */
    setSummary(p)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedAt])

  /* ★ **窗口内的场次以"切片"为准，不以日期区间为准**（2026-10-19 用户发现
     「窗口 75 场 / 已有 77 场」）。窗口是按场次切的 75 条，换成日期区间去库里数会把
     **边界那两天整天**算进去，于是区间内有 78 场。所以"已有/待采"直接从切片上的 `c` 数。 */
  const slice = useMemo(
    () => (activity && win ? activity.recent.slice(win.start, win.start + win.size) : []),
    [activity, win],
  )

  useEffect(() => {
    if (!busy) { setBusySecs(0); return }
    const t = window.setInterval(() => setBusySecs((v) => v + 1), 1000)
    return () => window.clearInterval(t)
  }, [busy])

  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    const onScroll = () => setShowTop(el.scrollTop > 600)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  /**
   * 「用户是否已经发起过一次分析」（2026-10-28）。
   *
   * 为什么需要它：切页签与改标签筛选原本都会调 `loadRanked`，于是**一进工作台就自动
   * 跑一次完整计算**（冷启动 20–40 秒），用户看到的是"我没点分析，它自己在分析"
   * （用户实测截图：正在分析… 已用 25 秒）。
   * 现在只有**用户主动发起过**（点「分析」/ 浮窗「分析」/ 大窗口确认）之后，
   * 切页签与改标签才跟着刷新；否则只切 UI、不碰后端。
   */
  const analyzedRef = useRef(false)

  /**
   * 窗口场次（用户滑杆选的那个）。**分析任务与 `/ranked` 必须用同一个值** ——
   * 后端 `_compute` 的缓存键含 `window`，两边不同就会把同一份数据算两遍
   * （2026-10-28 用户实测：分析完成后还要再等十秒）。
   */
  const winSize = win?.size ?? 75     // 75 = 后端 `DEFAULT_WINDOW`（滑杆还没有读数时的兜底）

  /**
   * 当前结果**基于哪一组参数**（窗口 + 区间 + 场次清单）。
   *
   * 用途：切页签时判断"能不能安全地重新取数" —— 参数没变时 `/ranked` 会命中结果包（毫秒级）；
   * 参数变了（用户刚拖过区间但还没重新分析）再去请求，后端就得**重算几十秒**，
   * 而重算期间图表区会被清空 —— 用户看到的就是"卡片不见了"（2026-10-28 用户报）。
   */
  const rankedBasisRef = useRef('')

  const loadRanked = useCallback(async (
    by: 'strength' | 'attendance' | 'interaction' | 'payment' = 'strength',
    off = 0,
    append = false,
    tags?: string[],
    /** `quiet` = 只换排序口径（切页签）：**不翻 `busy`**
     *  —— 否则采集/分析那两枚按钮会跟着灰一下再亮回来，看起来就是"闪了两次"
     *  （2026-10-29 用户报）。 */
    opts?: { quiet?: boolean },
  ): Promise<void> => {
    if (!picked || !since || !until) return
    analyzedRef.current = true      // 从这一刻起，切页签/改标签才允许跟着刷新
    if (!opts?.quiet) setBusy(true)
    const ids = slice.map((s) => String((s as { live_id?: string }).live_id ?? '')).filter(Boolean)
    try {
      setRankedStale(false)
      const data = await withNetRetry(
        () => api.fanRanked(picked, by, {
          since, until, limit: PAGE, offset: off, tags: tags ?? tagFilterRef.current,
          /* ⚠️ `window` 必须显式传＝滑杆窗口（2026-10-28）：不传会落到后端默认值
             （`DEFAULT_WINDOW`），与后台分析任务用的 `win.size` **不同** ⇒ `_compute`
             的缓存键不同 ⇒ 分析完这里又重算一遍（用户实测：分析完成后还要再等十秒）。 */
          window: winSize,
          // 传窗口清单：分析样本 = 滑杆窗口 = 采集对象
          ids,
        }))
      setRanked(data)
      // 记下"这份结果基于哪一组参数"：切页签/翻页时据此判断能不能安全重取（见 `rankedBasisRef`）
      rankedBasisRef.current = `${winSize}|${since}|${until}|${ids.join(',')}`
      setRows((prev) => (append ? [...prev, ...data.items] : data.items))
      const total = data.list_total ?? data.pool?.size ?? data.total_in_pool
      // 一页空 = 到底（否则 `off + 0 < total` 永远成立，观察者会无限触发、
      // 按钮在「加载中…/加载更多」之间反复闪 —— 2026-10-24 用户反馈）
      setHasMore(data.items.length > 0 && off + data.items.length < total)
      setErr(null)
    } catch (e) {
      setErr(friendly(e as Error))
      if (!append) setRanked(null)
    } finally {
      if (!opts?.quiet) setBusy(false)
    }
  }, [picked, since, until, slice, winSize])

  useEffect(() => {
    tagFilterRef.current = tagFilter
    setHasMore(false)
    /* ⚠️ 只有**用户主动发起过分析**之后，改标签才跟着重拉（2026-10-28）。
       否则这段会在**挂载时**就触发一次完整计算 —— 用户看到的就是"我没点分析，它在分析"。 */
    if (analyzedRef.current) void loadRanked(byOf(tab), 0, false, tagFilter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagFilter.join('|')])

  /** 切页签：**没分析过就只切 UI**（2026-10-28），分析过才按新口径取数（命中缓存，很快） */
  /**
   * 切页签：**只在"参数没变"时才重新取数**（2026-10-28）。
   *
   * 参数没变 ⇒ 后端命中结果包，毫秒级，安全；
   * 参数变了（用户刚拖过区间、还没重新分析）⇒ 请求会触发**几十秒重算**，
   * 而重算期间图表被清空 —— 用户看到的就是"切个页签，卡片没了"。
   * 这时只切 UI：图表数据与 `by` 无关，表格沿用旧结果并由 `rankedStale` 标注。
   */
  const onTab = useCallback((t: ResultTab): void => {
    setTab(t)
    setHasMore(false)
    const ids = slice.map((s) => String((s as { live_id?: string }).live_id ?? '')).filter(Boolean)
    const cur = `${winSize}|${since}|${until}|${ids.join(',')}`
    if (analyzedRef.current && cur === rankedBasisRef.current) {
      // `quiet`：切页签只是换排序口径 ⇒ 不翻 busy（按钮不闪）、不重挂载图表
      void loadRanked(byOf(t), 0, false, tagFilterRef.current, { quiet: true })
    } else if (analyzedRef.current) {
      setRankedStale(true)      // 结果基于旧参数：明确标出来，不偷算
    }
  }, [loadRanked, slice, winSize, since, until])

  // 标签目录随 /ranked 一起返回（2026-10-25）：不再单独发请求 ——
  // 之前那次请求命不中同一份计算缓存，会触发十几秒重算，筛选弹层在数据回来前只能空着。
  useEffect(() => {
    setTagOptions(ranked?.tag_catalog ?? [])
    setTagError(null)
    setTagLoading(false)
  }, [ranked])

  /** 懒加载：接着已加载的条数往后取一页 */
  const onLoadMore = useCallback((): void => {
    if (busy || !hasMore) return
    void loadRanked(byOf(tab), rows.length, true)
  }, [busy, hasMore, loadRanked, tab, rows.length])

  /* 浮窗的「分析」按钮 → 这里才真正开始分析（C 批）。
     走的是与页面「分析」按钮**同一条路**（同一套清屏 + loadRanked），不另开一套。
     ⚠️ 采集运行中不响应：那时点分析等于打断采集（后端也只有一个任务位）。 */
  const analyzeRequest = task.analyzeRequest
  useEffect(() => {
    if (!analyzeRequest || task.state === 'running') return
    if (!picked || !since || !until) return
    setTab('overview'); setRows([]); setHasMore(false); setRanked(null)
    void loadRanked('strength', 0, false, tagFilterRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzeRequest])

  /** 对比页发现"这个 V 还没分析"时，用户确认后直接采它（不传切片 = 采区间内全部待采场次） */
  const startCollectFor = useCallback(async (name: string): Promise<void> => {
    setErr(null)
    try {
      await startCollectTask({ vtuber: name, since, until, liveIds: [], total: 0 })
    } catch (e) {
      setErr(friendly(e as Error))
    }
  }, [since, until])

  const startCollect = useCallback(async (): Promise<void> => {
    if (!picked || !since || !until) return
    setBusy(true)
    setErr(null)
    try {
      /* 发**窗口切片**的场次清单：日期区间可能含边界日的额外场次，
         只有按清单采才能保证"采的就是窗口里那几场"。 */
      await startCollectTask({
        vtuber: picked, since, until,
        liveIds: slice.filter((s) => !s.c && (s as { live_id?: string }).live_id)
          .map((s) => ({ live_id: String((s as { live_id?: string }).live_id), start_at: s.at })),
        total: preview?.to_collect ?? 0,
      })
    } catch (e) {
      setErr(friendly(e as Error))
    } finally {
      setBusy(false)
    }
  }, [picked, since, until, preview, slice])

  const cancel = useCallback(async (): Promise<void> => {
    try { await cancelCollect() } catch (e) { setErr(friendly(e as Error)) }
  }, [])

  /**
   * ⚠️ 这两个**必须分开**（2026-10-28 用户报：分析时进度条左标却写「采集进度」）：
   * `task.state === 'running'` 对采集**和**分析都成立，用它当"正在采集"会让所有采集文案
   * 在分析任务期间抢占显示。所以：`collectRunning` 只认采集任务，`anyTaskRunning` 只管禁用。
   */
  const collectRunning = task.kind === 'collect' && task.state === 'running'
  const anyTaskRunning = task.state === 'running'
  /** 分析任务在跑（与"取数中"是两件事，文案必须分开，2026-10-28） */
  const taskAnalyzing = task.kind === 'analyze' && task.state === 'running'
  const analyzePct = taskAnalyzing && (task.progress?.total ?? 0) > 0
    ? Math.min(100, Math.round(((task.progress!.done) / task.progress!.total) * 100))
    : null
  /* ★ **窗口内的场次以"切片"为准，不以日期区间为准**（2026-10-19 用户发现
     「窗口 75 场 / 已有 77 场」）。
     窗口是**按场次**切的 75 条，但换成日期区间去库里数，会把**边界那两天整天**都算进去 ——
     那两天各有额外场次，于是区间内有 78 场，超过窗口的 75。
     所以"已有/待采"直接从切片上的 `c`（该场是否已采）数出来，三个数字自然自洽。 */
  const alreadyInWin = slice.filter((s) => s.c).length
  const toCollect = win ? win.size - alreadyInWin : null
  const unknown = toCollect === null
  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : 0

  /**
   * 细进度条（2026-10-28 用户口径）：**左边写明这是什么进度、右边给数字**，
   * 与上下卡片留出间距；任务结束后**渐隐并收起高度**，让下方卡片平滑顶上来
   * （不能瞬间消失 —— 那会让卡片"跳"一下）。
   */
  const barActive = collectRunning || busy || taskAnalyzing
  const barPct: number | null = collectRunning && (progress?.total ?? 0) > 0 ? pct
    : taskAnalyzing && analyzePct != null ? analyzePct
      : null
  const barLabel = collectRunning ? '采集进度' : taskAnalyzing ? '分析进度' : '读取进度'
  const [barLeaving, setBarLeaving] = useState(false)
  const barWasActive = useRef(false)
  useEffect(() => {
    if (barActive) {
      barWasActive.current = true
      setBarLeaving(false)
      return
    }
    if (!barWasActive.current) return      // 从没出现过 ⇒ 连退场都不播
    setBarLeaving(true)
    const t = window.setTimeout(() => {
      setBarLeaving(false)
      barWasActive.current = false
    }, 320)                                 // 与 CSS 过渡时长一致
    return () => window.clearTimeout(t)
  }, [barActive])
  /** 空态卡的正文提示：**按当前状态给下一步动作**（2026-10-28） */
  const emptyHint = collectRunning ? '采集完成后点「分析」'
    : taskAnalyzing ? '分析进行中，算完后这里会直接显示结果'
      : busy ? '正在读取结果…'
        : toCollect === null ? '先选一个场次窗口'
          : toCollect > 0 ? `当前窗口还有 ${toCollect} 场没采集 —— 先点「采集」`
            : '点「分析」生成名单与图表'

  /**
   * 结果区的三枚读数胶囊（2026-10-28 第 1 条修订）：**空态也要显示** ——
   * 用户截图里的那一行是整页骨架的一部分，采集/分析前后都该在。
   * 抽成常量而不是复制两份：同一份数字，两种页面状态必须一致。
   */
  const statsPills = win ? (
    <div className="wb-stats" data-testid="workbench-preview">
      <div className="wb-stat">
        <span className="wb-stat-label">窗口场次</span>
        <span className="wb-stat-value">{win.size}</span>
      </div>
      <div className="wb-stat">
        <span className="wb-stat-label">已有</span>
        <span className="wb-stat-value">{alreadyInWin}</span>
      </div>
      <div className="wb-stat">
        <span className="wb-stat-label">待采</span>
        <span className={`wb-stat-value${toCollect ? ' is-accent' : ''}`}>
          {unknown ? '—' : toCollect}
        </span>
      </div>
    </div>
  ) : null

  // ── 模块关着：不是"错误"，是带下一步动作的空态 ──────────────────────────
  if (enabled === false) {
    return (
      <div className="wb-page" ref={pageRef}>
        <div className="wb-inner">
          <section className="wb-card">
            <div className="wb-empty" data-testid="workbench-disabled">
              <p className="wb-empty-title">数据分析工作台未启用</p>
              <p>
                点左侧工具栏最下方的「＋」把它加进来，或在「设置 → 功能」里打开。
                关闭状态下本模块不会读取、也不会采集任何数据。
              </p>
            </div>
          </section>
        </div>
      </div>
    )
  }

  return (
    <div className="wb-page" ref={pageRef}>
      <div className="wb-inner">
        <header className="wb-head">
          <h1 className="wb-title">数据分析工作台</h1>
          <p className="wb-sub">选主播 → 滑一个场次窗口 → 采集 → 分析</p>
        </header>

        {err && (
          <section className="wb-card" data-testid="workbench-error">
            <div className="wb-err-row">
              <p className="wb-hint is-error">⚠ {err}</p>
              <FloatPill size="md" shape="text" data-testid="workbench-retry"
                         onClick={() => { setErr(null); setRetryTick((n) => n + 1) }}>
                重试
              </FloatPill>
            </div>
          </section>
        )}

        <div className="wb-row1">
          {picked
            ? <ProfileCard name={picked} options={vtubers} onPick={setPicked} />
            : <div className="wb-card" />}

          {/* 卡片里**不再放重复标题**（2026-10-19 用户第 4 条）：热力图组件自带一行
              「直播与采集 + 年份翻页」，页面上再写一遍就是两个一模一样的标题。 */}
          <section className="wb-card wb-hm-card" data-testid="workbench-heatmap">
            {activity ? (
              <>
                <Heatmap days={activity.days} detail={activity.detail}
                         years={activity.years}
                         today={activity.today}
                         year={year}
                         onYearChange={(y) => {
                           setYear(y)
                           // 翻页 ⇒ 退回默认模式（区间重新跟随年份）
                           setPickedRange(null)
                         }} />
                <WindowSlider sessions={activity.recent} onChange={onWindow}
                              stateKey={picked} dataOwner={activityOwner}
                              coverTick={coverTick} restore={restore} />
                {/* 采集 / 分析：**这张卡的最右下角**（用户 2026-10-19 第 1 条）——
                    它们属于"对这个窗口做什么"，不属于结果区。 */}
                <div className="wb-hm-actions">
                  {/* 滑轨区间：与采集/分析同一行，**顶在左侧**（2026-10-19 用户第 2 条） */}
                  <div className="wb-hm-actions-left">
                    <RangeButton
                      value={range}
                      display={pickedRange ? `${pickedRange.from} ~ ${pickedRange.to}` : `${year} 整年`}
                      custom={pickedRange !== null}
                      onReset={() => setPickedRange(null)}
                      onConfirm={(r) => {
                        setPickedRange(r)
                        setCoverTick((t) => t + 1)     // 让滑杆把窗口覆盖到整段
                      }}
                      disabled={anyTaskRunning || busy} />
                  </div>
                  <PurgeButton name={picked} disabled={anyTaskRunning || busy}
                               onPurged={() => {
                                 setRanked(null)
                                 withNetRetry(() => api.fanActivity(picked))
                                   .then(setActivity).catch(() => {})
                               }} />
                  {collectRunning && (
                    <FloatPill size="md" shape="text" onClick={() => void cancel()}
                               data-testid="workbench-cancel">取消</FloatPill>
                  )}
                  <FloatPill size="md" shape="text" active
                             disabled={!win || unknown || !toCollect || busy || anyTaskRunning}
                             onClick={() => void startCollect()}
                             data-testid="workbench-collect">
                    {collectRunning ? '采集中…'
                      : unknown ? '预估中…'
                        : toCollect ? `采集 ${toCollect} 场` : '已全部采集'}
                  </FloatPill>
                  <FloatPill size="md" shape="text" disabled={!win || busy || anyTaskRunning}
                             onClick={() => {
            if (slice.length > BIG_WINDOW) { setBigWinAsk(slice.length); return }
            /* 覆盖确认（2026-10-28 用户第 4 条）：一个 V 只有一个包位，
               新分析会**整包覆盖**旧结果 —— 先把"覆盖哪一组"说清楚。 */
            if (pkgMeta && (pkgMeta.window !== winSize
                            || (pkgMeta.since ?? '') !== since
                            || (pkgMeta.until ?? '') !== until)) {
              const ok = window.confirm(
                `将用 ${since} ~ ${until}（${winSize} 场）的新结果覆盖`
                + ` ${pkgMeta.since || '不限'} ~ ${pkgMeta.until || '至今'}`
                + `（${pkgMeta.window} 场 · ${pkgMeta.sessions} 场计入）的旧结果。\n\n继续？`)
              if (!ok) return
            }
            /* 分析也走**应用级任务**（2026-10-28，第四批）：这样它才有逐场进度、
               才能在顶栏显示、才能关掉浮窗继续跑。后端算完结果落进 `_CACHE`，
               所以 `finishedAt` 那一拍再 `loadRanked` 是**取缓存**、不会重算。
               ⚠️ 与采集一致：**不自动弹浮窗**，进度在顶栏，点顶栏才开。 */
            setTab('overview'); setRows([]); setHasMore(false); setRanked(null)
            void startAnalyzeTask({
              vtuber: picked, window: winSize, since, until,
              // 把窗口清单一起发过去：后端 `_compute` 的缓存键含 `live_ids`，
              // 与这里随后 `loadRanked` 发的 `ids` 一致才会命中缓存（否则等于算两遍）
              liveIds: slice.map((s) => String((s as { live_id?: string }).live_id ?? ''))
                .filter(Boolean),
            }).catch((e: Error) => setErr(friendly(e)))
          }}
                             data-testid="workbench-load">
                    分析
                  </FloatPill>
                </div>
              </>
            ) : (
              <div className="wb-empty"><p>读取直播记录…</p></div>
            )}
          </section>
        </div>

        {/* ── 结果区：结果的主展示区（用户 2026-10-19 第 2 条）── */}
        <section className="wb-card wb-result" data-testid="workbench-result">
          {ranked ? (
            <>
              <div className="wb-card-head">
                <h2 className="wb-card-title">
                  分析结果
                  {rankedStale && (
                    /* A2：区间变了但结果还留着 —— 必须明确标注，否则会被当成当前区间的结果 */
                    <span className="wb-stale" data-testid="ranked-stale">
                      区间已改，以下结果基于旧区间
                    </span>
                  )}
                  {/* 结果来自**结果包**时标明"缓存于何时"（2026-10-28）：用户要能区分
                      "这是刚算的" 还是 "这是上次留下的"，否则会拿旧结果当新结果。 */}
                  {pkgMeta && (
                    <span className="wb-stale" data-testid="pkg-badge"
                          title={`结果包 · ${pkgMeta.window} 场 · ${pkgMeta.since || '不限'} ~ ${pkgMeta.until || '至今'}`}>
                      缓存 {pkgMeta.computed_at.slice(5, 16)}
                    </span>
                  )}
                  <span className="wb-card-note" style={{ marginLeft: 8 }}>
                    {ranked.requested_sessions && ranked.requested_sessions !== ranked.sessions
                      ? `窗口 ${ranked.requested_sessions} 场 · 实际计入 ${ranked.sessions} 场`
                      : `${ranked.sessions} 场`}
                    · 入池 {ranked.total_in_pool.toLocaleString()} 人
                  </span>
                </h2>
                {statsPills}
              </div>
              {/* 被跳过的场次：显示**时间 + 标题**（不再暴露 live_id）；超过 2 条收进下拉（2026-10-25） */}
            {(ranked.skipped?.length ?? ranked.warnings?.length ?? 0) > 0 && (
              <div className="wb-skipped" data-testid="ranked-warnings">
                <b>有 {ranked.skipped?.length ?? ranked.warnings!.length} 场没进样本：</b>
                {(ranked.skipped ?? []).slice(0, 2).map((x) => (
                  <span className="wb-skipped-item" key={x.live_id}>
                    {x.start_at || '（时间未知）'}{x.title ? ` · ${x.title}` : ''}
                    {x.reason ? `（${x.reason}）` : ''}
                  </span>
                ))}
                {!ranked.skipped?.length && (
                  <span className="wb-skipped-item">{ranked.warnings![0]}</span>
                )}
                {(ranked.skipped?.length ?? 0) > 2 && (
                  <details className="wb-skipped-more">
                    <summary>另 {ranked.skipped!.length - 2} 条</summary>
                    <ul>
                      {ranked.skipped!.slice(2).map((x) => (
                        <li key={x.live_id}>
                          {x.start_at || '（时间未知）'}{x.title ? ` · ${x.title}` : ''}
                          {x.reason ? `（${x.reason}）` : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
              <ResultTabs value={tab} onChange={onTab} />
              <div
                className={`wb-tabpanel${busy ? ' is-loading' : ''}`}
                data-testid="result-panel"
              >
                {/* 数据还没跟上当前页签时**不渲染图表**：
                    否则会先用旧数据挂载一次、新数据到了再重新挂载 —— 视觉上两次闪动（2026-10-27） */}
                {tab === 'compare' ? (
                  <ComparePanel
                    current={ranked.vtuber ?? picked}
                    options={vtubers
                      .filter((v) => v.name !== ranked?.vtuber)
                      .map((v) => ({ name: v.name, short: v.short || v.name }))}
                    onRequestAnalysis={(name) => {
                      // 用户确认后：切到那个 V，并直接把「采集」提出来（不偷偷采）
                      setPicked(name)
                      const ok = window.confirm(
                        `${name} 还没有分析结果。现在采集并分析？\n\n采集会占用一段时间，期间可以取消。`)
                      if (ok) void startCollectFor(name)
                    }}
                    window={ranked.sessions}
                    since={since}
                    until={until}
                  />
                ) : (
                  /* ⚠️ 不再用 `rankedTab === tab` 门控图表（2026-10-28）。
                     那个门控的目的是"别用旧数据挂图再闪一次"，但它的代价是：
                     切页签那一刻图表区渲染成**空占位**，用户看到的就是"卡片消失了"
                     （尤其在他刚拖过时间区间、切页签又触发了一次请求的时候）。
                     图表数据（`charts`/`pool`）与排序口径 `by` **无关** ⇒ 直接沿用旧结果，
                     表格另有一条 stale 标注说明"结果基于旧区间"。 */
                  <ResultCharts items={ranked.items} pool={ranked.pool} tab={tab}
                                attBins={ranked.att_bins} charts={ranked.charts}
                                /* `dataStamp` 决定卡片**重挂载**，而重挂载是入场动画的唯一触发点。
                                   ⚠️ 只放**数据**指纹（场次 + 入池人数）：
                                   带上 `by` 时切页签会先因 `tab` 换 key、响应回来又因 `by` 换 key
                                   ⇒ 连播两次动画（2026-10-29 用户报"卡片快速闪动两次"）。 */
                                dataStamp={`${ranked.sessions}-${ranked.total_in_pool}`} />
                )}
                {tab !== 'compare' && <RankedTable
                  vtuber={picked}
                  by={ranked.by as FanSortBy}
                  since={since}
                  until={until}
                  ids={slice.map((s) => String((s as { live_id?: string }).live_id ?? '')).filter(Boolean)}
                  onOpenMember={setMemberUid}
                  sessionMeta={slice.map((s) => ({
                    at: String((s as { at?: string }).at ?? ''),
                    title: String((s as { title?: string }).title ?? ''),
                  }))}
                  lagRef={ranked.att_lag_ref}
                  tagOptions={tagOptions}
                  tagLoading={tagLoading}
                  tagError={tagError}
                  tagFilter={tagFilter}
                  onTagFilter={setTagFilter}
                  rows={rows}
                  total={ranked.list_total ?? ranked.pool?.size ?? ranked.total_in_pool}
                  hasMore={hasMore}
                  loading={busy}
                  onLoadMore={onLoadMore}
                  tab={tab}
                />}
              </div>
            </>
          ) : (
            /* ── 空态（2026-10-28 用户口径）：**沿用有结果时的那套卡片样式**，只把卡片
               内容换成空态文本。目的不是"好看"，而是让用户在没数据时也能看出
               「分析完成后这里会出现哪些卡」，而不是看到一句孤零零的提示。
               ⚠️ 对比页要先有名单才能对比 ⇒ 它单独一张卡，不去假装有矩阵。 */
            <div data-testid="result-empty">
              {/* 整页骨架照旧：标题行（含读数胶囊）+ 页签行（2026-10-28 第 1 条修订） */}
              <div className="wb-card-head">
                <h2 className="wb-card-title">
                  分析结果
                  <span className="wb-card-note" style={{ marginLeft: 8 }}>
                    {collectRunning ? '正在采集弹幕…'
                      : taskAnalyzing
                        ? `正在分析… ${task.progress?.done ?? 0}/${task.progress?.total || '?'} 场`
                        : busy ? `正在读取结果… 已用 ${busySecs} 秒`
                          : '尚未分析'}
                  </span>
                </h2>
                {/* 空态也显示三枚采集读数（2026-10-28 用户口径：跟随图二的骨架）。
                    ⚠️ 这一条**覆盖** 2026-10-23「结果区空态不重复采集读数」的旧口径。 */}
                {statsPills}
              </div>
              <ResultTabs value={tab} onChange={onTab} />
              {/* 进行中**不换面板**（用户口径：即使正在采集也不改变布局），
                  只在这一条细线上表示"在动"；细节去弹窗/顶栏看。 */}
              {(barActive || barLeaving) && (
                <div className={`wb-progress-row${barActive ? '' : ' is-leaving'}`}
                     data-testid="result-thin-progress">
                  <span className="wb-progress-label">{barLabel}</span>
                  <div className="wb-bar wb-bar-thin" role="progressbar"
                       aria-label={barLabel}
                       aria-valuemin={0} aria-valuemax={100}
                       aria-valuenow={barPct ?? undefined}>
                    <span className="wb-bar-fill"
                          style={{ width: barPct != null ? `${barPct}%` : '100%' }} />
                  </div>
                  <span className="wb-progress-num">
                    {barPct != null ? `${barPct}%` : '—'}
                  </span>
                </div>
              )}
              {tab === 'compare' ? (
                <section className="wb-card wb-chart-card" data-testid="compare-empty">
                  <h3 className="wb-card-title">对比</h3>
                  <div className="wb-empty wb-empty-card">
                    <p className="wb-empty-title">{EMPTY_TEXT.title}</p>
                    <p>请先进行采集，再分析一位主播，然后与其它主播对比重叠</p>
                  </div>
                </section>
              ) : (
                <>
                  <ResultCharts items={[]} pool={null} tab={tab} empty emptyHint={emptyHint} />
                  <RankedTable
                    rows={[]} total={0} hasMore={false} loading={false}
                    onLoadMore={() => {}}
                    vtuber={picked} since={since} until={until}
                    ids={slice.map((s) => String((s as { live_id?: string }).live_id ?? ''))
                      .filter(Boolean)}
                    onOpenMember={setMemberUid}
                    tagOptions={[]} tagFilter={[]} onTagFilter={() => {}}
                    sessionMeta={[]} tab={tab} empty emptyHint={emptyHint}
                  />
                </>
              )}
            </div>
          )}
        </section>

        {memberUid && (
          <MemberDrawer
            vtuber={picked}
            uid={memberUid}
            since={since}
            until={until}
            ids={slice.map((s) => String((s as { live_id?: string }).live_id ?? '')).filter(Boolean)}
            onClose={() => setMemberUid(null)}
          />
        )}

        {/* 采集结果弹窗（2026-10-19 用户第 2 条）：成功 / 跳过 / 失败 + **逐场失败原因** */}
        <AlertDialog open={summary !== null} onOpenChange={(o) => {
          if (!o) { setSummary(null); dismissTask() }   // 关掉弹窗 = 这一次任务收尾
        }}>
          <AlertDialogContent data-testid="collect-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {summary?.state === 'cancelled' ? '采集已取消'
                  : summary?.state === 'failed' ? '采集失败' : '采集完成'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {summary && (
                  <>
                    成功 <b>{summary.done}</b> 场 · 跳过 <b>{summary.skipped}</b> 场（已采过）
                    · 失败 <b>{summary.failed}</b> 场
                    {summary.message ? `。${summary.message}` : ''}
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {summary && (summary.failures?.length ?? 0) > 0 && (
              <div className="wb-fails" data-testid="collect-failures">
                <p className="wb-fails-title">没采到的场次（{summary.failures!.length}）</p>
                <ul className="wb-fails-list">
                  {summary.failures!.slice(0, 40).map((f) => (
                    <li key={f.live_id}>
                      <b>{String(f.start_at).slice(0, 16).replace('T', ' ')}</b> —— {f.reason}
                    </li>
                  ))}
                </ul>
                {summary.failures!.length > 40 && (
                  <p className="wb-flow-note">只列出前 40 条。</p>
                )}
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogAction onClick={() => setSummary(null)}
                                 data-testid="collect-dialog-ok">知道了</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={bigWinAsk !== null}
                     onOpenChange={(o) => { if (!o) setBigWinAsk(null) }}>
          <AlertDialogContent data-testid="big-window-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>这次窗口有点大</AlertDialogTitle>
            </AlertDialogHeader>
            <p className="wb-hint">
              将分析 <b>{bigWinAsk}</b> 场，预计需要
              <b> {estimateSecs(bigWinAsk ?? 0)} 秒</b>（首轮还要读完全部场次的原始弹幕）。
              分析期间界面会显示已用时间，完成后同一窗口再次分析会走缓存、很快返回。
            </p>
            <AlertDialogFooter>
              <AlertDialogAction onClick={() => setBigWinAsk(null)}>取消</AlertDialogAction>
              <AlertDialogAction
                data-testid="big-window-ok"
                onClick={() => {
                  setBigWinAsk(null)
                  setTab('overview'); setRows([]); setHasMore(false); setRanked(null)
                  void loadRanked('strength', 0, false, tagFilterRef.current)
                }}>
                继续分析
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <p className="wb-foot">
          口径：参与强度 = 三轴分位的等权平均（不含价值判断）；类型 = 主导轴 + 纯度门槛的
          <b> 约定</b>；标签只用于展示、不参与排序。窗口按<b>场次</b>取（25/50/75 场），
          换算成日期区间时实测误差 0~1 场；结果区的两张图只反映<b>当前名单里的 N 人</b>，不是全池。
          <Link to="/" style={{ marginLeft: 8 }}>回到帖子浏览</Link>
        </p>

        <button
          type="button"
          aria-label="回到顶部"
          className={`back-to-top${showTop ? ' on' : ''}`}
          data-testid="back-to-top"
          onClick={() => pageRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <ChevronUp className="size-5" />
        </button>
      </div>
    </div>
  )
}
