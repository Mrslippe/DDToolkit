import { useCallback, useEffect, useRef, useState } from 'react'
import { Link2, Play, Square, Download } from 'lucide-react'
import { api } from '../../api/api'
import type { FanCommentOverlap, FanCommentScan, FanCommentUser } from '../../api/types'

/**
 * 对比页 · 帖子评论模式（2026-10-28，P4）。
 *
 * 一段式流程：输入 → 开始抓取 → 轮询进度（顺带显示解析出来的标题/UP/评论数）
 *            → 完成 → 取名单 + 与当前主播的名单做重叠。
 *
 * 为什么不做"先解析再抓取"两步：后端在解析阶段就会拿到标题，轮询第一帧就能显示，
 * 分两步反而多一次请求与一次状态机。抓错帖子可以「取消」重来。
 */
interface Props {
  /** 当前分析的主播（显示名） */
  vtuber: string
  window: number
  since: string
  until: string
}

const POLL_MS = 1000

export default function CommentComparePane({ vtuber, window, since, until }: Props) {
  const [input, setInput] = useState('')
  const [withSub, setWithSub] = useState(true)
  // 抓取深度：页数越多越慢、越容易触发风控
  const [depth, setDepth] = useState<number>(150)
  const [scan, setScan] = useState<FanCommentScan | null>(null)
  const [users, setUsers] = useState<FanCommentUser[]>([])
  const [result, setResult] = useState<FanCommentOverlap | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (timer.current != null) { clearInterval(timer.current); timer.current = null }
  }, [])

  const finish = useCallback(async (sid: string) => {
    const [u, ov] = await Promise.all([
      api.fanCommentUsers(sid, 500),
      api.fanCommentOverlap(sid, vtuber, { window, since: since || undefined, until: until || undefined }),
    ])
    setUsers(u.items)
    setResult(ov)
  }, [vtuber, window, since, until])

  const poll = useCallback((sid: string) => {
    stopPolling()
    timer.current = setInterval(async () => {
      try {
        const st = await api.fanCommentScan(sid)
        setScan(st)
        if (st.state === 'done') {
          stopPolling(); setBusy(false)
          await finish(sid)
        } else if (st.state === 'failed' || st.state === 'cancelled') {
          stopPolling(); setBusy(false)
          if (st.state === 'failed') setError(st.error || '抓取失败')
        }
      } catch (e) {
        stopPolling(); setBusy(false)
        setError(e instanceof Error ? e.message : String(e))
      }
    }, POLL_MS)
  }, [finish, stopPolling])

  useEffect(() => stopPolling, [stopPolling])

  const start = async () => {
    if (!input.trim() || busy) return
    setBusy(true); setError(null); setResult(null); setUsers([]); setScan(null)
    try {
      const { scan_id } = await api.fanCommentScanStart(input.trim(), withSub, depth)
      setScan({ scan_id, input: input.trim(), state: 'queued', phase: '', page: 0, pages: 0,
                fetched: 0, expected: 0, partial: false, error: '', target_kind: '',
                target_id: '', title: '', up_name: '', cover: '', elapsed: 0, users_count: 0 })
      poll(scan_id)
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const cancel = async () => {
    if (!scan) return
    try { await api.fanCommentScanCancel(scan.scan_id) } catch { /* 取消失败不阻塞重来 */ }
    stopPolling(); setBusy(false)
  }

  const exportShared = () => {
    if (!result) return
    const head = 'uid,昵称,评论条数,楼中楼,名单强度,层级\n'
    const rows = result.shared.map((r) =>
      [r.uid, `"${(r.name || '').replace(/"/g, '""')}"`, r.cnt, r.sub_cnt, r.s, r.tier].join(','))
    const blob = new Blob(['\ufeff' + head + rows.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `评论交集-${vtuber}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const pct = scan && scan.expected > 0
    ? Math.min(100, Math.round((scan.fetched / scan.expected) * 100)) : null

  return (
    <div className="wb-comment" data-testid="comment-compare">
      <div className="wb-comment-input">
        <Link2 className="size-4" />
        <input
          className="wb-input"
          placeholder="粘贴视频/动态链接，或 BV 号（如 BV1xx411c7mD）"
          value={input}
          data-testid="comment-input"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void start() }}
        />
        <label className="wb-check">
          <input type="checkbox" checked={withSub} onChange={(e) => setWithSub(e.target.checked)} />
          含楼中楼
        </label>
        <select className="wb-select" value={depth} data-testid="comment-depth"
                onChange={(e) => setDepth(Number(e.target.value))}
                title="抓取深度：越深越慢，也越容易触发上游风控">
          <option value={3}>快速（60 条）</option>
          <option value={150}>标准（3000 条）</option>
          <option value={500}>深度（1 万条）</option>
        </select>
        {busy ? (
          <button type="button" className="wb-btn wb-btn-ghost" onClick={() => void cancel()} data-testid="comment-cancel">
            <Square className="size-4" /> 取消
          </button>
        ) : (
          <button type="button" className="wb-btn" onClick={() => void start()} data-testid="comment-start">
            <Play className="size-4" /> 开始抓取
          </button>
        )}
      </div>

      {error && <p className="wb-hint" role="alert" data-testid="comment-error">失败：{error}</p>}

      {scan && (
        <div className="wb-comment-progress" data-testid="comment-progress">
          <p className="wb-hint">
            {scan.phase === 'resolve' ? '正在解析链接…'
              : scan.phase === 'sub' ? '正在抓楼中楼…'
                : scan.state === 'done' ? '抓取完成'
                  : `正在抓评论 · 第 ${scan.page || 1}${scan.pages ? `/${scan.pages}` : ''} 页 · 已抓 ${scan.fetched.toLocaleString()} 条`}
            {scan.expected ? ` / 共 ${scan.expected.toLocaleString()} 条` : ''}
            {pct != null ? `（${pct}%）` : ''}
          </p>
          {pct != null && (
            <div className="wb-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <span className="wb-bar-fill" style={{ width: `${pct}%` }} />
            </div>
          )}
          {scan.note && (
            <p className="wb-hint" data-testid="comment-note">{scan.note}</p>
          )}
          {(scan.title || scan.up_name) && (
            <p className="wb-hint" data-testid="comment-target">
              {scan.up_name ? `${scan.up_name} · ` : ''}{scan.title || scan.target_id}
              {scan.partial ? '（部分数据）' : ''}
            </p>
          )}
        </div>
      )}

      {result && (
        <>
          <div className="wb-kpis" data-testid="comment-kpis">
            <div className="wb-kpi"><b>{result.overlap.shared.toLocaleString()}</b><span>共享人数</span></div>
            <div className="wb-kpi"><b>{(result.overlap.jaccard * 100).toFixed(2)}%</b><span>Jaccard</span></div>
            <div className="wb-kpi"><b>{result.overlap.lift}</b><span>lift（富集倍数）</span></div>
            <div className="wb-kpi"><b>{result.overlap.p_value.toExponential(1)}</b><span>p（上尾）</span></div>
          </div>

          <p className="wb-hint">
            {result.overlap.is_enriched ? '显著富集：这个帖子的评论者与名单重合得异常多'
              : result.overlap.is_depleted ? '显著贫化：两边受众在分化'
                : '不显著：与随机抽样没有明显差别'}
          </p>

          <div className="wb-comment-grid">
            <div>
              <h4 className="wb-card-title">Top-N 覆盖</h4>
              <ul className="wb-cov" data-testid="comment-coverage">
                {result.coverage.map((c) => (
                  <li key={c.n}>
                    <span className="wb-cov-n">前 {c.n}</span>
                    <span className="wb-cov-track"><i style={{ width: `${Math.min(100, c.hit * 100)}%` }} /></span>
                    <span className="wb-cov-v">{(c.hit * 100).toFixed(1)}%</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="wb-card-title">分层命中</h4>
              <table className="wb-table" data-testid="comment-tiers">
                <thead><tr><th>层级</th><th>命中</th><th>未命中</th></tr></thead>
                <tbody>
                  {Object.entries(result.tiers).map(([t, v]) => (
                    <tr key={t}><td>{t}</td><td>{v.hit}</td><td>{v.miss}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="wb-comment-shared">
            <div className="wb-card-head">
              <h4 className="wb-card-title">
                交集名单 <span className="wb-card-note">{result.shared.length} 人</span>
              </h4>
              <button type="button" className="wb-btn wb-btn-ghost" onClick={exportShared}
                      data-testid="comment-export">
                <Download className="size-4" /> 导出 CSV
              </button>
            </div>
            <div className="wb-table-wrap">
              <table className="wb-table" data-testid="comment-shared-table">
                <thead>
                  <tr><th>用户</th><th>评论</th><th>楼中楼</th><th>名单强度</th><th>层级</th></tr>
                </thead>
                <tbody>
                  {result.shared.slice(0, 50).map((r) => (
                    <tr key={r.uid}>
                      <td>{r.name || r.uid}</td>
                      <td>{r.cnt}</td>
                      <td>{r.sub_cnt || ''}</td>
                      <td>{r.s.toFixed(4)}</td>
                      <td>{r.tier}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {users.length > result.shared.length && (
            <p className="wb-hint">
              评论名单共 {users.length} 人，其中 {result.shared.length} 人在这份核心度名单里。
            </p>
          )}
        </>
      )}
    </div>
  )
}
