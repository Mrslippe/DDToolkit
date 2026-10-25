import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronUp } from 'lucide-react'
import { api } from '../api/api'
import type {
  FanActivity, FanCollectProgress, FanRanked, FanRankedRow, FanSessionPreview, FanVtuber,
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
import ResultCharts, { type ResultTab } from '../components/workbench/ResultCharts'
import ResultTabs from '../components/workbench/ResultTabs'
import MemberDrawer from '../components/workbench/MemberDrawer'
import WindowSlider, { type WindowRange } from '../components/workbench/WindowSlider'
import { withNetRetry } from '../utils/netRetry'
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
/** 进度轮询间隔。采集一场 2~18 秒，1 秒一刷够用且不打满后端 */
const POLL_MS = 1000

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
  const [progress, setProgress] = useState<FanCollectProgress | null>(null)
  const [ranked, setRanked] = useState<FanRanked | null>(null)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked])

  useEffect(() => {
    if (enabled !== true || !picked) return
    let alive = true
    /* ⚠️ 不要在这里 setActivity(null)（2026-10-19 用户问到"确认后界面重绘一次正常吗"）：
       清空会让整块先闪成「读取直播记录…」再出内容。保留旧数据、拿到新的再替换，
       观感是"原地更新"而不是"重绘"。 */
    /* ⚠️ A1（2026-10-19）：**不要 setWin(null)**。
       一清空统计条就整行消失、等新数据回来又出现 —— 用户说的"刷新"就是这个。
       保留旧窗口值；新 `recent` 到达后滑杆会重新 emit 一次，自然替换。 */
    setProgress(null)
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

  // 4) 采集进度轮询：只在 running 时开
  useEffect(() => {
    if (progress?.state !== 'running') return
    const t = window.setInterval(() => {
      api.fanCollectStatus(picked)
        .then((r) => {
          const p = r.items[0] ?? null
          setProgress(p)
          if (p && p.state !== 'running') {
            withNetRetry(() => api.fanActivity(picked)).then(setActivity).catch(() => {})
            /* ⚠️ **采集与分析解耦**（2026-10-19 用户第 2 条）：以前这里会自动 `loadRanked()`，
               用户没点「分析」就自己开始算。现在只弹采集结果，要不要分析由用户决定。 */
            setSummary(p)
          }
        })
        .catch(() => { /* 轮询失败不弹窗，下一拍再试 */ })
    }, POLL_MS)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.state, picked])

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

  const loadRanked = useCallback(async (
    by: 'strength' | 'attendance' | 'interaction' | 'payment' = 'strength',
    off = 0,
    append = false,
    tags?: string[],
  ): Promise<void> => {
    if (!picked || !since || !until) return
    setBusy(true)
    try {
      setRankedStale(false)
      const data = await withNetRetry(
        () => api.fanRanked(picked, by, {
          since, until, limit: PAGE, offset: off, tags: tags ?? tagFilterRef.current,
          // 传窗口清单：分析样本 = 滑杆窗口 = 采集对象
          ids: slice.map((s) => String((s as { live_id?: string }).live_id ?? '')).filter(Boolean),
        }))
      setRanked(data)
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
      setBusy(false)
    }
  }, [picked, since, until, slice])

  useEffect(() => {
    tagFilterRef.current = tagFilter
    setHasMore(false)
    void loadRanked(TAB_BY[tab], 0, false, tagFilter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagFilter.join('|')])

  /** 切页签：清空已加载行，按新口径从头拉 */
  const onTab = useCallback((t: ResultTab): void => {
    setTab(t)
    setHasMore(false)
    void loadRanked(TAB_BY[t], 0, false, tagFilterRef.current)
  }, [loadRanked])

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
    void loadRanked(TAB_BY[tab], rows.length, true)
  }, [busy, hasMore, loadRanked, tab, rows.length])

  const startCollect = useCallback(async (): Promise<void> => {
    if (!picked || !since || !until) return
    setBusy(true)
    setErr(null)
    try {
      /* 发**窗口切片**的场次清单：日期区间可能含边界日的额外场次，
         只有按清单采才能保证"采的就是窗口里那几场"。 */
      await api.fanCollect(picked, since, until,
        slice.filter((s) => !s.c && (s as { live_id?: string }).live_id)
          .map((s) => ({ live_id: String((s as { live_id?: string }).live_id), start_at: s.at })))
      setProgress({ vtuber: picked, since, until, state: 'running',
                    total: preview?.to_collect ?? 0, done: 0, failed: 0,
                    skipped: 0, current: '', message: '', elapsed: 0 })
    } catch (e) {
      setErr(friendly(e as Error))
    } finally {
      setBusy(false)
    }
  }, [picked, since, until, preview, slice])

  const cancel = useCallback(async (): Promise<void> => {
    try { await api.fanCollectCancel(picked) } catch (e) { setErr(friendly(e as Error)) }
  }, [picked])

  const running = progress?.state === 'running'
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
                              stateKey={picked} dataOwner={activityOwner} coverTick={coverTick} />
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
                      disabled={running || busy} />
                  </div>
                  <PurgeButton name={picked} disabled={running || busy}
                               onPurged={() => {
                                 setRanked(null)
                                 withNetRetry(() => api.fanActivity(picked))
                                   .then(setActivity).catch(() => {})
                               }} />
                  {running && (
                    <FloatPill size="md" shape="text" onClick={() => void cancel()}
                               data-testid="workbench-cancel">取消</FloatPill>
                  )}
                  <FloatPill size="md" shape="text" active
                             disabled={!win || unknown || !toCollect || busy || running}
                             onClick={() => void startCollect()}
                             data-testid="workbench-collect">
                    {running ? '采集中…'
                      : unknown ? '预估中…'
                        : toCollect ? `采集 ${toCollect} 场` : '已全部采集'}
                  </FloatPill>
                  <FloatPill size="md" shape="text" disabled={!win || busy || running}
                             onClick={() => {
            if (slice.length > BIG_WINDOW) { setBigWinAsk(slice.length); return }
            setTab('overview'); setRows([]); setHasMore(false)
            void loadRanked('strength', 0, false, tagFilterRef.current)
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
          {running || (busy && !ranked) ? (
            /* 进行中：有大百分比就给，没有就只表示"在动"（**不编造数字**） */
            <div className="wb-busy" data-testid="workbench-progress" aria-live="polite">
              <div className="wb-busy-head">
                <b>{running ? '正在采集弹幕' : '正在分析'}</b>
                {running && progress && progress.total > 0 && (
                  <span className="wb-busy-pct">{pct}%</span>
                )}
              </div>
              <div className={`wb-bar wb-bar-lg${running ? '' : ' is-indeterminate'}`}
                   role="progressbar" aria-valuemin={0} aria-valuemax={100}
                   aria-valuenow={running ? pct : undefined}>
                <span className="wb-bar-fill" style={{ width: running ? `${pct}%` : '100%' }} />
              </div>
              <p className="wb-hint">
                {running && progress
                  ? `已处理 ${progress.done}/${progress.total || '?'} 场`
                    + (progress.failed > 0 ? ` · 失败 ${progress.failed}` : '')
                    + (progress.current ? ` · 当前 ${progress.current}` : '')
                  : `正在分析 ${slice.length} 场（约 ${estimateSecs(slice.length)} 秒）`
                    + `，已用 ${busySecs} 秒${slice.length > BIG_WINDOW ? ' —— 大窗口请耐心等待' : ''}。`}
              </p>
            </div>
          ) : ranked ? (
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
                  <span className="wb-card-note" style={{ marginLeft: 8 }}>
                    {ranked.requested_sessions && ranked.requested_sessions !== ranked.sessions
                      ? `窗口 ${ranked.requested_sessions} 场 · 实际计入 ${ranked.sessions} 场`
                      : `${ranked.sessions} 场`}
                    · 入池 {ranked.total_in_pool.toLocaleString()} 人
                  </span>
                </h2>
                {win && (
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
                )}
              </div>
              {/* 被跳过的场次：让"静默丢样本"可见（记录过少 / 无入场事件 / 缺 raw） */}
              {(ranked.warnings?.length ?? 0) > 0 && (
                <div className="wb-skipped" data-testid="ranked-warnings">
                  <b>有 {ranked.warnings!.length} 场没进样本：</b>
                  {ranked.warnings!.slice(0, 3).map((w, i) => (
                    <span className="wb-skipped-item" key={i}>{w}</span>
                  ))}
                  {ranked.warnings!.length > 3 && (
                    <span className="wb-skipped-item">…另有 {ranked.warnings!.length - 3} 条</span>
                  )}
                </div>
              )}
              <ResultTabs value={tab} onChange={onTab} />
              <div
                className={`wb-tabpanel${busy ? ' is-loading' : ''}`}
                data-testid="result-panel"
              >
                <ResultCharts items={ranked.items} pool={ranked.pool} tab={tab} />
                <RankedTable
                  vtuber={picked}
                  since={since}
                  until={until}
                  ids={slice.map((s) => String((s as { live_id?: string }).live_id ?? '')).filter(Boolean)}
                  onOpenMember={setMemberUid}
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
                />
              </div>
            </>
          ) : (
            <div className="wb-empty" data-testid="result-empty">
              <p>请先选择时间范围进行分析</p>
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
        <AlertDialog open={summary !== null} onOpenChange={(o) => { if (!o) setSummary(null) }}>
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
                  setTab('overview'); setRows([]); setHasMore(false)
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
