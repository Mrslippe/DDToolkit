import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/api'
import type {
  FanActivity, FanCollectProgress, FanRanked, FanSessionPreview, FanVtuber,
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
import ResultCharts from '../components/workbench/ResultCharts'
import WindowSlider, { type WindowRange } from '../components/workbench/WindowSlider'
import { withNetRetry } from '../utils/netRetry'
import '../styles/workbench.css'

/** 名单默认条数（后端上限 5000）。结果区的两张图只反映这一批人，所以卡片上写明 N。 */
const LIMIT = 300
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
  const [picked, setPicked] = useState<string>('')
  const [activity, setActivity] = useState<FanActivity | null>(null)
  const [win, setWin] = useState<WindowRange | null>(null)
  const [preview, setPreview] = useState<FanSessionPreview | null>(null)
  const [progress, setProgress] = useState<FanCollectProgress | null>(null)
  const [ranked, setRanked] = useState<FanRanked | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** 采集结束后的结果弹窗（done / failed / cancelled）；null = 不显示 */
  const [summary, setSummary] = useState<FanCollectProgress | null>(null)
  /** 重试计数：失败时点「重试」把它 +1，预估的 effect 就会再跑一次 */
  const [retryTick, setRetryTick] = useState(0)

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
  useEffect(() => {
    if (enabled !== true || !picked) return
    let alive = true
    setActivity(null)
    setRanked(null)
    setProgress(null)
    setWin(null)
    withNetRetry(() => api.fanActivity(picked))
      .then((r) => { if (alive) setActivity(r) })
      .catch((e: Error) => { if (alive) setErr(friendly(e)) })
    return () => { alive = false }
  }, [enabled, picked])

  // 3) 窗口变了 ⇒ 重新预估
  const onWindow = useCallback((r: WindowRange) => { setWin(r) }, [])
  const since = win?.since ?? ''
  const until = win?.until ?? ''

  useEffect(() => {
    if (enabled !== true || !picked || !since || !until) return
    let alive = true
    withNetRetry(() => api.fanSessions(picked, since, until))
      .then((r) => { if (alive) setPreview(r) })
      .catch((e: Error) => { if (alive) setErr(friendly(e)) })
    return () => { alive = false }
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

  const loadRanked = useCallback(async (): Promise<void> => {
    if (!picked || !since || !until) return
    setBusy(true)
    try {
      setRanked(await withNetRetry(
        () => api.fanRanked(picked, 'strength', { since, until, limit: LIMIT })))
      setErr(null)
    } catch (e) {
      setErr(friendly(e as Error))
      setRanked(null)
    } finally {
      setBusy(false)
    }
  }, [picked, since, until])

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
      <div className="wb-page">
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
    <div className="wb-page">
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
                <Heatmap days={activity.days} years={activity.years}
                         today={activity.today}
                         defaultYear={Number(activity.today.slice(0, 4))} />
                <WindowSlider sessions={activity.recent} onChange={onWindow} />
                {/* 采集 / 分析：**这张卡的最右下角**（用户 2026-10-19 第 1 条）——
                    它们属于"对这个窗口做什么"，不属于结果区。 */}
                <div className="wb-hm-actions">
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
                             onClick={() => void loadRanked()}
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
              <div className="wb-stat">
                <span className="wb-stat-label">区间</span>
                <span className="wb-stat-note">{since} ~ {until}</span>
              </div>
            </div>
          )}

          {running || busy ? (
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
                  : '正在算名单与分层，通常几秒内完成。'}
              </p>
            </div>
          ) : ranked ? (
            <ResultCharts items={ranked.items} />
          ) : (
            <div className="wb-empty wb-flow" data-testid="result-empty">
              <p className="wb-flow-title">还没有结果</p>
              <ol className="wb-flow-steps">
                <li>
                  <b>采集</b> —— 在「直播与采集」里拖一个场次窗口，点右下角「采集 N 场」，
                  把这段时间的弹幕拉到本机
                </li>
                <li><b>分析</b> —— 采完点「分析」，按三轴分位算出每个人的核心度</li>
                <li><b>结果</b> —— 这里会出现分层饼图与核心度分布</li>
              </ol>
              <p className="wb-flow-note">已经采过的区间可以直接点「分析」，不必重采。</p>
            </div>
          )}
        </section>

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

        <p className="wb-foot">
          口径：参与强度 = 三轴分位的等权平均（不含价值判断）；类型 = 主导轴 + 纯度门槛的
          <b> 约定</b>；标签只用于展示、不参与排序。窗口按<b>场次</b>取（25/50/75 场），
          换算成日期区间时实测误差 0~1 场；结果区的两张图只反映<b>当前名单里的 N 人</b>，不是全池。
          <Link to="/" style={{ marginLeft: 8 }}>回到帖子浏览</Link>
        </p>
      </div>
    </div>
  )
}
