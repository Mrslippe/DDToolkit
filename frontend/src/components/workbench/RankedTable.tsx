import type { FanRankedRow } from '../../api/types'

interface Props {
  rows: FanRankedRow[]
  /** 全池人数（分页分母） */
  total: number
  offset: number
  pageSize: number
  onPage: (offset: number) => void
  loading?: boolean
}

/**
 * 结果名单（2026-10-23）。
 *
 * 与图的区别：**图看全池，名单只看当前页**。页脚明确写"第 x–y / 全池 N 人"，
 * 避免又被读成"全池只有 20 人"。
 *
 * 独轮车不剔除，只在行尾挂一个 `spam` 标记 —— 口径是"标记、可解释"。
 */
export default function RankedTable({ rows, total, offset, pageSize, onPage, loading }: Props) {
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(total, offset + rows.length)
  const canPrev = offset > 0
  const canNext = to < total

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
          <table className="wb-table" data-testid="ranked-table">
            <thead>
              <tr>
                <th>#</th><th>用户</th><th>类型</th><th>强度</th>
                <th>出席</th><th>弹幕</th><th>付费</th><th>标签</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.uid}>
                  <td>{r.rank}</td>
                  <td className="wb-table-uid">
                    {r.uid}
                    {r.spam && (
                      <span className="wb-badge-spam" title="不同文本率 ≤20%，判为独轮车">
                        独轮车
                      </span>
                    )}
                  </td>
                  <td>{r.type}</td>
                  <td>{r.strength.toFixed(3)}</td>
                  <td>{r.att_sessions} 场（{(r.att_rate * 100).toFixed(0)}%）</td>
                  <td>{r.msg_total.toLocaleString()}</td>
                  <td>{r.pay_total > 0 ? `¥${r.pay_total.toLocaleString()}` : '—'}</td>
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
