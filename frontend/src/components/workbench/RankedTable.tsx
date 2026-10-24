import { useEffect, useRef, useState } from 'react'
import { resolveAsset } from '../../api/api'
import type { FanRankedRow } from '../../api/types'
import type { ResultTab } from './ResultCharts'
import MemberSearch from './MemberSearch'
import TagPills from './TagPills'

interface Props {
  rows: FanRankedRow[]
  /** 全池人数（懒加载的分母） */
  total: number
  /** 还有没有下一页 */
  hasMore: boolean
  loading?: boolean
  onLoadMore: () => void
  /** 当前页签：决定「细节」列展示哪个轴的分量 */
  tab?: ResultTab
  /** 搜索与详情需要的上下文 */
  vtuber: string
  since: string
  until: string
  ids: string[]
  onOpenMember: (uid: string) => void
}

/** 头像失败时退回昵称/uid 首字 */
function Avatar({ row }: { row: FanRankedRow }) {
  const [bad, setBad] = useState(false)
  const label = (row.name || row.uid).slice(0, 1).toUpperCase()
  // ⚠️ 必须用 resolveAsset 拼 apiBase：相对路径会落到页面来源（tauri://localhost / 5173）。
  // 也只走本地代理 —— danmakus 的 CDN 在我们这儿 403，先试它只会把错误刷一遍。
  const src = resolveAsset(row.avatar)
  if (bad || !src) {
    return <span className="wb-avatar wb-avatar-fallback">{label}</span>
  }
  return (
    <img
      className="wb-avatar"
      src={src}
      alt=""
      loading="lazy"
      onError={() => setBad(true)}
    />
  )
}

const pct = (v: number) => v.toFixed(3)

/**
 * 结果名单（2026-10-24 改懒加载）。
 *
 * - 首屏 20 条，滚到底自动追加下一页（`IntersectionObserver`），卡片**向下自然展开**；
 * - 同时保留「加载更多」按钮，作为没有 `IntersectionObserver` 时的兜底；
 * - 列固定：序号 / 头像 / 昵称 / 强度 / 三分位 / [细节] / 标签；
 *   细节列只在出席/互动/付费页出现，总览页直接看计算值。
 */
export default function RankedTable({
  rows, total, hasMore, loading, onLoadMore, tab = 'overview',
  vtuber, since, until, ids, onOpenMember,
}: Props) {
  const sentinel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loading) onLoadMore()
      },
      { rootMargin: '160px' },        // 快到底就开始取，滚动不顿
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loading, onLoadMore])

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
      <div className="wb-card-head">
        <h3 className="wb-card-title">
          名单
          <span className="wb-card-note" style={{ marginLeft: 8 }}>
            {loading && rows.length === 0
              ? '加载中…'
              : `已加载 ${rows.length.toLocaleString()} / 全池 ${total.toLocaleString()} 人`}
          </span>
        </h3>
        <MemberSearch vtuber={vtuber} since={since} until={until} ids={ids}
                      onPick={onOpenMember} />
      </div>

      {rows.length === 0 && !loading ? (
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
                <tr key={r.uid} className="wb-row-click"
                    onClick={() => onOpenMember(r.uid)}>
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
                  <td className="wb-table-tags"><TagPills tags={r.tags} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="wb-loadmore" ref={sentinel}>
        {hasMore ? (
          <button
            type="button"
            className="wb-pager-btn"
            data-testid="ranked-more"
            disabled={loading}
            onClick={onLoadMore}
          >
            {loading ? '加载中…' : '加载更多'}
          </button>
        ) : rows.length > 0 ? (
          <span className="wb-loadmore-end">已到末尾</span>
        ) : null}
      </div>
    </section>
  )
}
