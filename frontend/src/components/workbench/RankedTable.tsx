import { useState } from 'react'
import type { FanRankedRow } from '../../api/types'
import type { ResultTab } from './ResultCharts'

interface Props {
  rows: FanRankedRow[]
  /** 全池人数（分页分母） */
  total: number
  offset: number
  pageSize: number
  onPage: (offset: number) => void
  loading?: boolean
  /** 当前页签：决定「细节」列展示哪个轴的分量 */
  tab?: ResultTab
}

/** 头像失败时退回昵称/uid 首字（B 站可能没有头像，或取不到） */
function Avatar({ row }: { row: FanRankedRow }) {
  // 0 = danmakus CDN，1 = 本地代理，2 = 首字兜底
  const [stage, setStage] = useState(0)
  const label = (row.name || row.uid).slice(0, 1).toUpperCase()
  const src = stage === 0 ? row.avatar : stage === 1 ? row.avatar_proxy : undefined
  if (!src || stage > 1) {
    return <span className="wb-avatar wb-avatar-fallback">{label}</span>
  }
  return (
    <img
      className="wb-avatar"
      src={src}
      alt=""
      loading="lazy"
      onError={() => setStage((s) => s + 1)}
    />
  )
}

const pct = (v: number) => v.toFixed(3)

/**
 * 结果名单（2026-10-24 改版）。
 *
 * 列固定为：序号 / 头像 / 昵称 / 强度 / 出席分位 / 弹幕分位 / 付费分位 / [细节] / 标签。
 *
 * - **总览页**：不显示「细节」列 —— 直接看三个分位与强度；
 * - **出席 / 互动 / 付费页**：插一列该轴的**原始细节**（出席场次、弹幕条数、付费金额），
 *   也就是"分位背后的实数"。
 */
export default function RankedTable({
  rows, total, offset, pageSize, onPage, loading, tab = 'overview',
}: Props) {
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(total, offset + rows.length)
  const canPrev = offset > 0
  const canNext = to < total

  const detailHead = tab === 'attendance' ? '出席细节'
    : tab === 'interaction' ? '弹幕细节'
      : tab === 'payment' ? '付费细节'
        : ''

  const detail = (r: FanRankedRow) => {
    if (tab === 'attendance') return `${r.att_sessions} 场（${(r.att_rate * 100).toFixed(0)}%）`
    if (tab === 'interaction') {
      return (
        <>
          {r.msg_total.toLocaleString()} 条
          {r.spam && (
            <span className="wb-badge-spam" title="不同文本率 ≤20%，判为独轮车">独轮车</span>
          )}
        </>
      )
    }
    if (tab === 'payment') return r.pay_total > 0 ? `¥${r.pay_total.toLocaleString()}` : '—'
    return null
  }

  return (
    <section className="wb-card wb-table-card" data-testid="ranked-table-card">
      <h3 className="wb-card-title">
        名单
        <span className="wb-card-note" style={{ marginLeft: 8 }}>
          {loading ? '加载中…' : `第 ${from}–${to} 人 / 全池 ${total.toLocaleString()} 人`}
        </span>
      </h3>

      {rows.length === 0 ? (
        <p className="wb-hint">这一页没有数据。</p>
      ) : (
        <div className="wb-table-wrap">
          <table className="wb-table wb-table-ranked" data-testid="ranked-table">
            <thead>
              <tr>
                <th>#</th><th>用户</th><th>昵称</th>
                <th>强度</th><th>出席分位</th><th>弹幕分位</th><th>付费分位</th>
                {detailHead && <th>{detailHead}</th>}
                <th>标签</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.uid}>
                  <td className="wb-table-rank">{r.rank}</td>
                  <td><Avatar row={r} /></td>
                  <td className="wb-table-name" title={r.uid}>
                    {(r.name || r.uid).slice(0, 18)}
                    <span className="wb-table-uid-sub">{r.uid}</span>
                  </td>
                  <td className="wb-table-strength">{r.strength.toFixed(3)}</td>
                  <td>{pct(r.axis_percentiles.attendance ?? 0)}</td>
                  <td>{pct(r.axis_percentiles.interaction ?? 0)}</td>
                  <td>{pct(r.axis_percentiles.payment ?? 0)}</td>
                  {detailHead && <td>{detail(r)}</td>}
                  <td className="wb-table-tags">{r.tags.join(' · ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="wb-pager">
        <button
          type="button"
          className="wb-pager-btn"
          data-testid="ranked-prev"
          disabled={!canPrev || loading}
          onClick={() => onPage(Math.max(0, offset - pageSize))}
        >
          上一页
        </button>
        <span className="wb-pager-info">
          第 {Math.floor(offset / pageSize) + 1} / {Math.max(1, Math.ceil(total / pageSize))} 页
        </span>
        <button
          type="button"
          className="wb-pager-btn"
          data-testid="ranked-next"
          disabled={!canNext || loading}
          onClick={() => onPage(offset + pageSize)}
        >
          下一页
        </button>
      </div>
    </section>
  )
}
