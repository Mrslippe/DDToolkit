import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/api'
import type { FanCollectProgress, FanRanked, FanSessionPreview, FanVtuber } from '../api/types'
import { fmtDate, today } from '../utils/dateRange'

/** 名单默认条数（后端上限 5000） */
const LIMIT = 100
/** 进度轮询间隔。采集一场 2~18 秒，1 秒一刷够用且不打满后端 */
const POLL_MS = 1000
/** 默认区间：最近 30 天 */
function defaultRange(): { since: string; until: string } {
  const to = today()
  const from = new Date(to)
  from.setDate(from.getDate() - 30)
  return { since: fmtDate(from), until: fmtDate(to) }
}

/**
 * 数据分析工作台（2026-10-18，用户：「1 屏」）。
 *
 * 一条主线：**选主播 → 选时间区间 → 确认采集 → 看名单**。
 *
 * 三条口径（都来自后端，别在前端自己编）：
 * - 模块没启用时后端一律 404 ⇒ 这里先读 `/fan/vtubers` 的 `enabled`，关着就显示去设置的提示；
 * - 采集是**显式触发**的（不点不采），且同一主播同时只能有一个任务（409）；
 * - 排序口径 `by` **必填**，界面默认选中 `strength` 但会显示出来（不藏着）。
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

  // 2) 区间变了就重新预估（不打紧：后端有 5 分钟缓存）
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

  const rangeInvalid = useMemo(() => Boolean(since && until && since > until), [since, until])
  const canCollect = Boolean(picked && since && until && !rangeInvalid && preview?.to_collect)
  const running = progress?.state === 'running'

  // ── 模块关着 ────────────────────────────────────────────────────────────
  if (enabled === false) {
    return (
      <div className="empty-state">
        <div className="empty-state-card">
          <p className="empty-state-title">数据分析工作台未启用</p>
          <p className="empty-state-desc">
            在「设置 → 功能」里把「数据分析工作台」打开，左侧工具栏就会出现入口。
            关闭状态下本模块不会读取或采集任何数据。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-1 text-lg font-semibold">数据分析工作台</h1>
      <p className="mb-5 text-xs text-neutral-500">
        选主播 → 选时间区间 → 确认采集 → 看名单。所有分析都基于本地已采集的数据，不上传。
      </p>

      {err && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700"
             data-testid="workbench-error">{err}</div>
      )}

      {/* 第一步：主播 + 区间 */}
      <section className="mb-5 rounded border border-neutral-200 p-4" data-testid="workbench-setup">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-neutral-500">主播</span>
            <select className="min-w-[180px] rounded border px-2 py-1 text-sm"
                    value={picked} onChange={(e) => setPicked(e.target.value)}
                    data-testid="workbench-vtuber">
              {vtubers.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.short}{v.has_data ? `（已有 ${v.sessions} 场）` : '（无数据）'}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-neutral-500">开始日期</span>
            <input type="date" className="rounded border px-2 py-1 text-sm"
                   value={since} max={until || undefined}
                   onChange={(e) => setSince(e.target.value)}
                   data-testid="workbench-since" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-neutral-500">结束日期</span>
            <input type="date" className="rounded border px-2 py-1 text-sm"
                   value={until} min={since || undefined}
                   onChange={(e) => setUntil(e.target.value)}
                   data-testid="workbench-until" />
          </label>
          <button type="button" disabled={!canCollect || busy || running}
                  onClick={startCollect}
                  className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
                  data-testid="workbench-collect">
            {running ? '采集中…' : '开始采集'}
          </button>
          {running && (
            <button type="button" onClick={cancel}
                    className="rounded border px-3 py-1.5 text-sm"
                    data-testid="workbench-cancel">取消</button>
          )}
        </div>

        {/* 预估（用户据此决定要不要点） */}
        <div className="mt-3 text-xs text-neutral-600" data-testid="workbench-preview">
          {rangeInvalid && <span className="text-red-600">起止日期反了</span>}
          {!rangeInvalid && preview && (
            <>
              区间内 <b>{preview.total}</b> 场，已有 <b>{preview.already}</b> 场，
              待采 <b>{preview.to_collect}</b> 场
              {preview.first && preview.last && (
                <span className="ml-2 text-neutral-400">（{preview.first.slice(0, 10)} ~ {preview.last.slice(0, 10)}）</span>
              )}
            </>
          )}
        </div>

        {/* 采集进度 */}
        {progress && (
          <div className="mt-3 text-xs" data-testid="workbench-progress">
            <span className="text-neutral-500">
              {progress.state === 'running'
                ? `采集中 ${progress.done}/${progress.total}`
                : progress.state === 'done' ? '采集完成'
                : progress.state === 'cancelled' ? '已取消' : '采集失败'}
            </span>
            {progress.message && <span className="ml-2 text-neutral-400">{progress.message}</span>}
            {progress.state === 'running' && progress.current && (
              <span className="ml-2 text-neutral-400">当前：{progress.current}</span>
            )}
          </div>
        )}
      </section>

      {/* 第二步：名单 */}
      <section data-testid="workbench-result">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            名单{ranked && `（${ranked.sessions} 场 · 入池 ${ranked.total_in_pool} 人）`}
          </h2>
          <button type="button" onClick={() => void loadRanked()} disabled={busy || !picked}
                  className="rounded border px-3 py-1 text-xs disabled:opacity-40"
                  data-testid="workbench-load">
            {busy ? '计算中…' : '查看名单'}
          </button>
        </div>

        {!ranked && (
          <p className="py-6 text-xs text-neutral-500">
            {preview?.to_collect ? '先采集，或直接点「查看名单」看已采过的数据。' : '还没有数据。选一个区间并点「开始采集」。'}
          </p>
        )}

        {ranked && (
          <table className="w-full text-xs" data-testid="workbench-table">
            <thead className="text-left text-neutral-500">
              <tr>
                <th className="py-1 pr-2">#</th>
                <th className="py-1 pr-2">uid</th>
                <th className="py-1 pr-2">类型</th>
                <th className="py-1 pr-2">参与强度</th>
                <th className="py-1 pr-2">出席</th>
                <th className="py-1 pr-2">付费</th>
                <th className="py-1 pr-2">标签</th>
              </tr>
            </thead>
            <tbody>
              {ranked.items.map((r) => (
                <tr key={r.uid} className="border-t border-neutral-100">
                  <td className="py-1 pr-2 tabular-nums text-neutral-400">{r.rank}</td>
                  <td className="py-1 pr-2 font-mono">{r.uid}</td>
                  <td className="py-1 pr-2">{r.type}</td>
                  <td className="py-1 pr-2 tabular-nums">{r.strength.toFixed(4)}</td>
                  <td className="py-1 pr-2 tabular-nums">
                    {r.att_sessions}（{(r.att_rate * 100).toFixed(0)}%）
                  </td>
                  <td className="py-1 pr-2 tabular-nums">¥{r.pay_total.toFixed(1)}</td>
                  <td className="py-1 pr-2">
                    {r.tags.map((t) => (
                      <span key={t}
                            className="mr-1 inline-block rounded bg-neutral-100 px-1.5 py-0.5 text-[10px]">
                        {t}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="mt-6 text-[11px] text-neutral-400">
        口径说明：参与强度是三轴分位的等权平均（不含价值判断）；类型是主导轴 + 纯度门槛的
        <b>约定</b>；标签只用于展示、不参与排序。
        <Link to="/" className="ml-2 underline">回到帖子浏览</Link>
      </p>
    </div>
  )
}
