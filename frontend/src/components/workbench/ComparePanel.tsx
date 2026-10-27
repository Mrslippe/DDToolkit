import { useCallback, useEffect, useMemo, useState } from 'react'
import { Users, MessageSquare, Plus, X } from 'lucide-react'
import { api } from '../../api/api'
import type { FanCompareMulti } from '../../api/types'
import CommentComparePane from './CommentComparePane'

/**
 * 对比页（2026-10-28，P2：多主播重叠）。
 *
 * 设计取向：
 * - **同步当前分析**：`current` 是本次分析的主播，窗口/区间也来自主分析 ——
 *   用户先分析出核心名单，再看它和别的名单怎么重叠；
 * - 矩阵是入口、不是终点：点格子下钻到该配对的详情（份额、层级迁移、读数）；
 * - 帖子评论模式留给 P3/P4，这里先占位，避免页签空着像坏了。
 */
interface Props {
  /** 本次分析的主播（显示名） */
  current: string
  /** 可选的其它主播 */
  options: { name: string; short: string }[]
  window: number
  since: string
  until: string
  /** 缺数据的 V → 让页面去「采集并分析」（用户确认后才会真的采） */
  onRequestAnalysis?: (name: string) => void
}

type Mode = 'multi' | 'comment'

/** 两集合 Venn：半径按人数开方缩放，交集数字居中（纯 SVG，无依赖） */
function Venn({ a, b, inter, sizeA, sizeB }: { a: string; b: string; inter: number; sizeA: number; sizeB: number }) {
  const rA = 46 + 26 * Math.sqrt(sizeA / Math.max(sizeA, sizeB, 1))
  const rB = 46 + 26 * Math.sqrt(sizeB / Math.max(sizeA, sizeB, 1))
  const w = 360, h = 200, cy = 100
  const dx = Math.min(78, (rA + rB) / 3.2)
  const cxA = w / 2 - dx, cxB = w / 2 + dx
  return (
    <svg className="wb-venn" viewBox={`0 0 ${w} ${h}`} role="img"
         aria-label={`${a} 与 ${b} 的名单重叠：共享 ${inter} 人`} data-testid="compare-venn">
      <circle cx={cxA} cy={cy} r={rA} className="wb-venn-a" />
      <circle cx={cxB} cy={cy} r={rB} className="wb-venn-b" />
      <text x={cxA - 26} y={cy + 4} className="wb-venn-t">{a}</text>
      <text x={cxB + 26} y={cy + 4} className="wb-venn-t" textAnchor="end">{b}</text>
      <text x={w / 2} y={cy + 5} className="wb-venn-inter" textAnchor="middle">{inter}</text>
    </svg>
  )
}

export default function ComparePanel({ current, options, window, since, until, onRequestAnalysis }: Props) {
  const [mode, setMode] = useState<Mode>('multi')
  const [picked, setPicked] = useState<string[]>([current])
  const [data, setData] = useState<FanCompareMulti | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pairIdx, setPairIdx] = useState<number | null>(null)

  // 换 V 时把当前主播保持在选择里
  useEffect(() => {
    setPicked((prev) => (prev.includes(current) ? prev : [current, ...prev]))
  }, [current])

  const load = useCallback(async (names: string[]) => {
    if (names.length < 2) { setData(null); setPairIdx(null); return }
    setLoading(true); setError(null)
    try {
      const d = await api.fanCompareMulti(names, { window, since: since || undefined, until: until || undefined })
      setData(d); setPairIdx(d.pairs.length ? 0 : null)
    } catch (e) {
      setData(null); setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [window, since, until])

  useEffect(() => { void load(picked) }, [load, picked])

  const toggle = (name: string) => {
    setPicked((prev) => prev.includes(name)
      ? (prev.length > 1 ? prev.filter((x) => x !== name) : prev)
      : [...prev, name])
  }

  const pair = data && pairIdx != null ? data.pairs[pairIdx] : null
  const maxJ = useMemo(() => Math.max(0.0001, ...(data?.pairs.map((p) => p.jaccard) ?? [0])), [data])

  return (
    <section className="wb-compare" data-testid="compare-panel">
      <div className="wb-compare-head">
        <div className="wb-seg" role="tablist" aria-label="对比模式">
          <button type="button" role="tab" aria-selected={mode === 'multi'}
                  className={`wb-seg-btn${mode === 'multi' ? ' is-active' : ''}`}
                  data-testid="compare-mode-multi" onClick={() => setMode('multi')}>
            <Users className="size-4" /> 多主播
          </button>
          <button type="button" role="tab" aria-selected={mode === 'comment'}
                  className={`wb-seg-btn${mode === 'comment' ? ' is-active' : ''}`}
                  data-testid="compare-mode-comment" onClick={() => setMode('comment')}>
            <MessageSquare className="size-4" /> 帖子评论
          </button>
        </div>
        <span className="wb-card-note">基于：{current} · {window} 场 · {since || '不限'} ~ {until || '至今'}</span>
      </div>

      {mode === 'comment' ? (
        <CommentComparePane vtuber={current} window={window} since={since} until={until} />
      ) : (
        <>
          <div className="wb-chips" data-testid="compare-chips">
            {picked.map((name) => (
              <span key={name} className="wb-chip">
                {name}
                {name !== current && (
                  <button type="button" aria-label={`移除 ${name}`} onClick={() => toggle(name)}>
                    <X className="size-3" />
                  </button>
                )}
              </span>
            ))}
            {options.filter((o) => !picked.includes(o.name)).slice(0, 6).map((o) => (
              <button key={o.name} type="button" className="wb-chip wb-chip-add" onClick={() => toggle(o.name)}>
                <Plus className="size-3" /> {o.short}
              </button>
            ))}
          </div>

          {(data?.needs_analysis?.length ?? 0) > 0 && (
            <div className="wb-missing" role="alert" data-testid="compare-missing">
              <b>这些主播还没有分析结果：</b>
              {data!.needs_analysis!.map((n) => (
                <span key={n} className="wb-chip wb-chip-warn">
                  {n}
                  {onRequestAnalysis && (
                    <button type="button" onClick={() => onRequestAnalysis(n)}>采集并分析</button>
                  )}
                </span>
              ))}
            </div>
          )}
          {error && <p className="wb-hint" role="alert" data-testid="compare-error">加载失败：{error}</p>}
          {loading && <p className="wb-hint">正在计算两两重叠…</p>}

          {data && (
            <div className="wb-compare-grid">
              {data.matrix.length === data.vtubers.length && data.matrix.length > 0 && (
              <table className="wb-matrix" data-testid="compare-matrix">
                <thead>
                  <tr>
                    <th />
                    {data.vtubers.map((v) => <th key={v.short}>{v.short}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.vtubers.map((row, i) => (
                    <tr key={row.short}>
                      <th>{row.short}</th>
                      {(data.matrix[i] ?? []).map((cell, j) => (
                        <td key={j}>
                          {cell === null ? <span className="wb-matrix-diag">—</span> : (
                            <button type="button"
                                    className={`wb-matrix-cell${pairIdx === cell.pair ? ' is-active' : ''}`}
                                    style={{ background: `rgba(201,64,111,${0.08 + 0.55 * (cell.jaccard / maxJ)})` }}
                                    onClick={() => setPairIdx(cell.pair)}
                                    title={`共享 ${cell.shared} 人 · lift ${cell.lift}`}>
                              {(cell.jaccard * 100).toFixed(1)}%
                            </button>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              )}

              {pair && (
                <Venn a={pair.a} b={pair.b} inter={pair.intersection}
                      sizeA={pair.size_a} sizeB={pair.size_b} />
              )}

              {pair && (
                <div className="wb-pair" data-testid="compare-pair">
                  <h3 className="wb-card-title">
                    {pair.a} × {pair.b}
                    <span className="wb-card-note" style={{ marginLeft: 8 }}>
                      共享 {pair.intersection} 人 · Jaccard {(pair.jaccard * 100).toFixed(2)}% · lift {pair.lift}
                    </span>
                  </h3>
                  <p className="wb-hint">
                    p（BH 校正）= {pair.p_adjusted.toExponential(2)}
                    {pair.is_enriched ? ' · 显著富集' : pair.is_depleted ? ' · 显著贫化' : ' · 不显著'}
                  </p>
                  <p className="wb-hint">{pair.reading}</p>
                  <table className="wb-table">
                    <thead>
                      <tr><th>层级迁移</th><th>人数</th></tr>
                    </thead>
                    <tbody>
                      {Object.entries(pair.tier_moves).filter(([, n]) => Number(n) > 0).map(([k, n]) => (
                        <tr key={k}><td>{k}</td><td>{String(n)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
