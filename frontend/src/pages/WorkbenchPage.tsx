import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/api'
import type { FanCollectProgress, FanRanked, FanSessionPreview, FanVtuber } from '../api/types'
import FloatPill from '../components/common/FloatPill'
import ProfileCard from '../components/workbench/ProfileCard'
import { fmtDate, today } from '../utils/dateRange'
import '../styles/workbench.css'

/** 名单默认条数（后端上限 5000） */
const LIMIT = 100
/** 名单里每行最多显示几枚标签（其余折成 +N，否则一行能撑成三行） */
const TAG_SHOWN = 3
/** 进度轮询间隔。采集一场 2~18 秒，1 秒一刷够用且不打满后端 */
const POLL_MS = 1000

/** 默认区间：最近 30 天 */
function defaultRange(): { since: string; until: string } {
  const to = today()
  const from = new Date(to)
  from.setDate(from.getDate() - 30)
  return { since: fmtDate(from), until: fmtDate(to) }
}

const STATE_TEXT: Record<string, string> = {
  idle: '待开始',
  running: '采集中',
  done: '采集完成',
  failed: '采集失败',
  cancelled: '已取消',
}

/**
 * 数据分析工作台（2026-10-18）。
 *
 * 用户口径两条：「1 屏」+「对齐项目的总体设计语言，以圆角卡片为主要展示形式」。
 *
 * 一条主线：**选主播 → 选时间区间 → 确认采集 → 看名单**。
 *
 * 视觉**只复用不新造**：卡片走 `tokens.css` 的档案卡族（`--pcard-*`：12px 圆角 +
 * 双层柔和阴影 + 顶部高光），按钮一律 `FloatPill`（全站唯一交互层元件）。
 * 样式在 `styles/workbench.css`（`wb-` 前缀）。
 *
 * 三条口径（都来自后端，别在前端自己编）：
 * - 模块没启用时后端一律 404 ⇒ 这里先读 `/fan/vtubers` 的 `enabled`，关着就显示去设置的提示；
 * - 采集是**显式触发**的（不点不采），且同一主播同时只能有一个任务（409）；
 * - 排序口径 `by` **必填**，界面默认 `strength` 但会写在页脚里（不藏着）。
 */
export default function WorkbenchPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [vtubers, setVtubers] = useState<FanVtuber[]>([])
  const [picked, setPicked] = useState<string>('')
  const [since, setSince] = useState(defaultRange().since)
  const [until, setUntil] = useState(defaultRange().until)
  const [preview, setPreview] = useState<FanSessionPreview | null>(null)
  const [progress, setProgress] = useState<FanCollectProgress | null>(null)
  const [ranked, setRanked] = useState<FanRanked | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  // 1) 读主播表与模块开关
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

  // 2) 区间变了就重新预估（后端有 5 分钟缓存，打不疼）
  const refreshPreview = useCallback(() => {
    // 模块没启用时一个 /fan 端点都不许打 —— 后端一律 404，
    // 打了只会把界面写成一条错误（用户看到的是"坏了"而不是"没开"）。
    if (enabled !== true) return
    if (!picked || !since || !until || since > until) return
    api.fanSessions(picked, since, until)
      .then(setPreview)
      .catch((e: Error) => setErr(e.message))
  }, [enabled, picked, since, until])

  useEffect(() => { refreshPreview() }, [refreshPreview])

  const loadRanked = useCallback(async (): Promise<void> => {
    if (!picked) return
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
    if (!picked) return
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
    if (!picked) return
    try { await api.fanCollectCancel(picked) } catch (e) { setErr((e as Error).message) }
  }, [picked])

  // 3) 采集进度轮询：只在 running 时开
  useEffect(() => {
    const running = progress?.state === 'running'
    if (!running) {
      if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null }
      return
    }
    timer.current = window.setInterval(() => {
      api.fanCollectStatus(picked)
        .then((r) => {
          const p = r.items[0] ?? null
          setProgress(p)
          if (p && p.state !== 'running') {
            refreshPreview()
            void loadRanked()
          }
        })
        .catch(() => { /* 轮询失败不弹窗，下一拍再试 */ })
    }, POLL_MS)
    return () => {
      if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.state, picked])

  const rangeInvalid = useMemo(() => Boolean(since && until && since > until), [since, until])
  const canCollect = Boolean(picked && since && until && !rangeInvalid && preview?.to_collect)
  const running = progress?.state === 'running'
  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : 0

  // ── 模块关着：不是"错误"，是一个带下一步动作的空态 ──────────────────────
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
          <p className="wb-sub">选主播 → 选区间 → 采集 → 看名单</p>
        </header>

        {/* 档案卡（V2）：V 的身份 + 分析可用性。选中 V 之后才渲染 —— 空值时别去打接口 */}
        {picked && <ProfileCard name={picked} />}

        {err && (
          <section className="wb-card" data-testid="workbench-error">
            <p className="wb-hint is-error">⚠ {err}</p>
          </section>
        )}

        {/* ── 卡 1：采集设置 ── */}
        <section className="wb-card" data-testid="workbench-setup">
          <div className="wb-card-head">
            <h2 className="wb-card-title">采集设置</h2>
            <span className="wb-card-note">数据只存本机，不上传</span>
          </div>

          <div className="wb-form">
            <label className="wb-field">
              <span className="wb-field-label">主播</span>
              <select className="wb-input wb-select" value={picked}
                      onChange={(e) => setPicked(e.target.value)}
                      data-testid="workbench-vtuber">
                {vtubers.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.short}{v.has_data ? `（已有 ${v.sessions} 场）` : '（无数据）'}
                  </option>
                ))}
              </select>
            </label>
            <label className="wb-field">
              <span className="wb-field-label">开始日期</span>
              <input type="date" className="wb-input" value={since}
                     max={until || undefined}
                     onChange={(e) => setSince(e.target.value)}
                     data-testid="workbench-since" />
            </label>
            <label className="wb-field">
              <span className="wb-field-label">结束日期</span>
              <input type="date" className="wb-input" value={until}
                     min={since || undefined}
                     onChange={(e) => setUntil(e.target.value)}
                     data-testid="workbench-until" />
            </label>
            <div className="wb-actions">
              {running && (
                <FloatPill size="md" shape="text" onClick={() => void cancel()}
                           data-testid="workbench-cancel">取消</FloatPill>
              )}
              <FloatPill size="md" shape="text" active
                         disabled={!canCollect || busy || running}
                         onClick={() => void startCollect()}
                         data-testid="workbench-collect">
                {running ? '采集中…' : '开始采集'}
              </FloatPill>
            </div>
          </div>

          {rangeInvalid ? (
            <p className="wb-hint is-error">⚠ 起止日期反了</p>
          ) : preview && (
            <div className="wb-stats" data-testid="workbench-preview">
              <div className="wb-stat">
                <span className="wb-stat-label">区间场次</span>
                <span className="wb-stat-value">{preview.total}</span>
              </div>
              <div className="wb-stat">
                <span className="wb-stat-label">已有</span>
                <span className="wb-stat-value">{preview.already}</span>
              </div>
              <div className="wb-stat">
                <span className="wb-stat-label">待采</span>
                <span className={`wb-stat-value${preview.to_collect ? ' is-accent' : ''}`}>
                  {preview.to_collect}
                </span>
              </div>
              {preview.first && preview.last && (
                <div className="wb-stat">
                  <span className="wb-stat-label">覆盖</span>
                  <span className="wb-stat-note">
                    {preview.first.slice(0, 10)} ~ {preview.last.slice(0, 10)}
                  </span>
                </div>
              )}
            </div>
          )}

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
        </section>

        {/* ── 卡 2：名单 ── */}
        <section className="wb-card" data-testid="workbench-result">
          <div className="wb-card-head">
            <h2 className="wb-card-title">
              粉丝名单
              {ranked && (
                <span className="wb-card-note" style={{ marginLeft: 8 }}>
                  {ranked.sessions} 场 · 入池 {ranked.total_in_pool.toLocaleString()} 人
                </span>
              )}
            </h2>
            <FloatPill size="md" shape="text" disabled={busy || !picked}
                       onClick={() => void loadRanked()}
                       data-testid="workbench-load">
              {busy ? '计算中…' : '查看名单'}
            </FloatPill>
          </div>

          {!ranked ? (
            <div className="wb-empty">
              <p>
                {preview?.to_collect
                  ? '还没算。先点「开始采集」补齐数据，或直接点「查看名单」看已采过的部分。'
                  : '这个区间还没有数据。换一个区间，或点「开始采集」。'}
              </p>
            </div>
          ) : (
            <div className="wb-table-wrap">
              <table className="wb-table" data-testid="workbench-table">
                <thead>
                  <tr>
                    <th className="wb-rank">#</th>
                    <th>uid</th>
                    <th>类型</th>
                    <th>参与强度</th>
                    <th>出席</th>
                    <th>付费</th>
                    <th>标签</th>
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
          )}
        </section>

        <p className="wb-foot">
          口径：参与强度 = 三轴分位的等权平均（不含价值判断）；类型 = 主导轴 + 纯度门槛的
          <b> 约定</b>；标签只用于展示、不参与排序；排序键按「参与强度」。
          <Link to="/" style={{ marginLeft: 8 }}>回到帖子浏览</Link>
        </p>
      </div>
    </div>
  )
}
