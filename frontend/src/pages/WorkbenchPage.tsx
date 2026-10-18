import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/api'
import type {
  FanActivity, FanCollectProgress, FanRanked, FanSessionPreview, FanVtuber,
} from '../api/types'
import FloatPill from '../components/common/FloatPill'
import Heatmap from '../components/workbench/Heatmap'
import ProfileCard from '../components/workbench/ProfileCard'
import WindowSlider, { type WindowRange } from '../components/workbench/WindowSlider'
import '../styles/workbench.css'

/** 名单默认条数（后端上限 5000） */
const LIMIT = 100
/** 名单里每行最多显示几枚标签（其余折成 +N，否则一行能撑成三行） */
const TAG_SHOWN = 3
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
      + '已采过的数据仍能「查看名单」。'
  }
  return m
}

const STATE_TEXT: Record<string, string> = {
  idle: '待开始',
  running: '采集中',
  done: '采集完成',
  failed: '采集失败',
  cancelled: '已取消',
}

/**
 * 数据分析工作台（2026-10-18，界面重构 V3/V4/V5）。
 *
 * **一条主线**：选主播 → 在 150 场里滑一个 25/50/75 场的窗口 → 采集 → 看名单。
 *
 * 三块布局（`docs/plans/workbench-visual-redesign.md`）：
 * 1. 上排：档案卡（V2）+「直播与采集」卡（热力图 V3 + 场次滑杆 V4）
 * 2. 结果区（V5）：空态 / 预估 / 进度 / 名单 四态**原地切换**，不跳页
 * 3. 页脚口径
 *
 * ⚠️ **窗口按场次取，采集接口按日期收**。换算在 `WindowSlider` 里做（取窗口首末场次的
 * 日期）；实测差额 0~1 场（同一天有多场时才会多出来），所以口径写成：
 * **分析以「日期区间内的全部场次」为准，界面上的「N 场」是近似值**。
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
  /** 重试计数：失败时点「重试」把它 +1，预估的 effect 就会再跑一次 */
  const [retryTick, setRetryTick] = useState(0)

  // 1) 主播表 + 模块开关
  useEffect(() => {
    let alive = true
    api.fanVtubers()
      .then((r) => {
        if (!alive) return
        setEnabled(r.enabled)
        setVtubers(r.items)
        const first = r.items.find((v: FanVtuber) => v.has_data) ?? r.items[0]
        if (first) setPicked((p) => p || first.name)
      })
      .catch((e: Error) => alive && setErr(e.message))
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
    api.fanActivity(picked)
      .then((r) => { if (alive) setActivity(r) })
      .catch((e: Error) => { if (alive) setErr(e.message) })
    return () => { alive = false }
  }, [enabled, picked])

  // 3) 窗口变了 ⇒ 重新预估（后端有缓存，打不疼）
  const onWindow = useCallback((r: WindowRange) => { setWin(r) }, [])
  const since = win?.since ?? ''
  const until = win?.until ?? ''

  useEffect(() => {
    if (enabled !== true || !picked || !since || !until) return
    let alive = true
    api.fanSessions(picked, since, until)
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
            // 采完刷新一次热力图与名单
            api.fanActivity(picked).then(setActivity).catch(() => {})
            void loadRanked()
          }
        })
        .catch(() => { /* 轮询失败不弹窗，下一拍再试 */ })
    }, POLL_MS)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.state, picked])

  const loadRanked = useCallback(async (): Promise<void> => {
    if (!picked || !since || !until) return
    setBusy(true)
    try {
      setRanked(await api.fanRanked(picked, 'strength', { since, until, limit: LIMIT }))
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
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
      await api.fanCollect(picked, since, until)
      setProgress({ vtuber: picked, since, until, state: 'running',
                    total: preview?.to_collect ?? 0, done: 0, failed: 0,
                    skipped: 0, current: '', message: '', elapsed: 0 })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [picked, since, until, preview])

  const cancel = useCallback(async (): Promise<void> => {
    try { await api.fanCollectCancel(picked) } catch (e) { setErr((e as Error).message) }
  }, [picked])

  const running = progress?.state === 'running'
  /* ⚠️ **未知 ≠ 0**：`preview` 还没回来（或取失败）时，`to_collect` 是"不知道"，
     不是"零待采"。当成 0 会让按钮显示「已全部采集」，而滑杆那边明明写着「待采 75」
     —— 2026-10-18 用户截图里就是这个自相矛盾。 */
  const toCollect = preview ? preview.to_collect : null
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
          <p className="wb-sub">选主播 → 滑一个场次窗口 → 采集 → 看名单</p>
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

          <section className="wb-card wb-hm-card" data-testid="workbench-heatmap">
            {activity ? (
              <>
                <Heatmap days={activity.days} years={activity.years}
                         today={activity.today} defaultYear={Number(activity.today.slice(0, 4))} />
                <WindowSlider sessions={activity.recent} onChange={onWindow} />
              </>
            ) : (
              <div className="wb-empty"><p>读取直播记录…</p></div>
            )}
          </section>
        </div>

        {/* ── 结果区（V5）：四态原地切换 ── */}
        <section className="wb-card wb-result" data-testid="workbench-result">
          {!win ? (
            <div className="wb-empty" data-testid="result-empty">
              <p>请先选择时间范围</p>
            </div>
          ) : (
            <>
              <div className="wb-card-head">
                <h2 className="wb-card-title">
                  {progress && progress.state !== 'done' ? '采集' : '粉丝名单'}
                  {ranked && (
                    <span className="wb-card-note" style={{ marginLeft: 8 }}>
                      {ranked.sessions} 场 · 入池 {ranked.total_in_pool.toLocaleString()} 人
                    </span>
                  )}
                </h2>
                <div className="wb-actions">
                  {running && (
                    <FloatPill size="md" shape="text" onClick={() => void cancel()}
                               data-testid="workbench-cancel">取消</FloatPill>
                  )}
                  <FloatPill size="md" shape="text" active
                             disabled={unknown || !toCollect || busy || running}
                             onClick={() => void startCollect()}
                             data-testid="workbench-collect">
                    {running ? '采集中…'
                      : unknown ? '预估中…'
                        : toCollect ? `采集 ${toCollect} 场` : '已全部采集'}
                  </FloatPill>
                  <FloatPill size="md" shape="text" disabled={busy}
                             onClick={() => void loadRanked()}
                             data-testid="workbench-load">
                    {busy ? '计算中…' : '查看名单'}
                  </FloatPill>
                </div>
              </div>

              <div className="wb-stats" data-testid="workbench-preview">
                <div className="wb-stat">
                  <span className="wb-stat-label">窗口场次</span>
                  <span className="wb-stat-value">{win.size}</span>
                </div>
                <div className="wb-stat">
                  <span className="wb-stat-label">已有</span>
                  <span className="wb-stat-value">{preview?.already ?? '—'}</span>
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

              {progress && (
                <div data-testid="workbench-progress" aria-live="polite">
                  <div className="wb-progress">
                    <span>{STATE_TEXT[progress.state] ?? progress.state}</span>
                    <span className="wb-bar" role="progressbar" aria-valuemin={0}
                          aria-valuemax={100} aria-valuenow={pct}>
                      <span className="wb-bar-fill" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="wb-num">{progress.done}/{progress.total || '?'}</span>
                    {progress.failed > 0 && <span>失败 {progress.failed}</span>}
                  </div>
                  {progress.message && <p className="wb-hint" style={{ marginTop: 6 }}>{progress.message}</p>}
                  {running && progress.current && (
                    <p className="wb-hint" style={{ marginTop: 4 }}>当前：{progress.current}</p>
                  )}
                </div>
              )}

              {ranked ? (
                <div className="wb-table-wrap">
                  <table className="wb-table" data-testid="workbench-table">
                    <thead>
                      <tr>
                        <th className="wb-rank">#</th><th>uid</th><th>类型</th>
                        <th>参与强度</th><th>出席</th><th>付费</th><th>标签</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ranked.items.map((r) => (
                        <tr key={r.uid}>
                          <td className="wb-rank">{r.rank}</td>
                          <td className="wb-uid">{r.uid}</td>
                          <td><span className="wb-tag is-type">{r.type}</span></td>
                          <td className="wb-num">{r.strength.toFixed(4)}</td>
                          <td className="wb-num">
                            {r.att_sessions}
                            <span className="wb-stat-note" style={{ marginLeft: 4 }}>
                              {(r.att_rate * 100).toFixed(0)}%
                            </span>
                          </td>
                          <td className="wb-num">¥{r.pay_total.toFixed(1)}</td>
                          <td>
                            <span className="wb-tags">
                              {r.tags.slice(0, TAG_SHOWN).map((t) => (
                                <span key={t} className="wb-tag">{t}</span>
                              ))}
                              {r.tags.length > TAG_SHOWN && (
                                <span className="wb-tag is-more" title={r.tags.join('、')}>
                                  +{r.tags.length - TAG_SHOWN}
                                </span>
                              )}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="wb-empty">
                  <p>还没算名单。点「查看名单」看这个窗口里已有的数据。</p>
                </div>
              )}
            </>
          )}
        </section>

        <p className="wb-foot">
          口径：参与强度 = 三轴分位的等权平均（不含价值判断）；类型 = 主导轴 + 纯度门槛的
          <b> 约定</b>；标签只用于展示、不参与排序；窗口按<b>场次</b>取（25/50/75 场），
          换算成日期区间时实测误差 0~1 场。
          <Link to="/" style={{ marginLeft: 8 }}>回到帖子浏览</Link>
        </p>
      </div>
    </div>
  )
}
