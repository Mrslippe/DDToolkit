import { useEffect, useRef, useState } from 'react'
import { resolveAsset } from '../../api/api'
import type { FanRankedRow } from '../../api/types'
import type { ResultTab } from './ResultCharts'
import MemberSearch from './MemberSearch'
import TagFilter from './TagFilter'
import TagPills from './TagPills'
import AttendanceBits from './AttendanceBits'

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
  /** 标签筛选（与后端 `tags` 参数同义） */
  tagOptions: { name: string; prevalence: number }[]
  tagLoading?: boolean
  tagError?: string | null
  tagFilter: string[]
  onTagFilter: (next: string[]) => void
  /** 窗口内各场次的时间/标题（出席明细浮层用），顺序与行的 att_bits 一致 */
  sessionMeta: { at: string; title?: string }[]
  /** 每场的时滞参照（p90） */
  lagRef?: number[]
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

/** 独轮车三档（2026-10-25 用户口径：名单里只要档位） */
function spamLabel(level?: string): string {
  return level === 'confirmed' ? '确定' : level === 'suspected' ? '疑似' : '—'
}

/**
 * 付费构成（2026-10-26 改版）：**三色占比轴 + 文字**。
 *
 * 比原来的「49% / 51% / 0%」更直观 —— 一眼能看出谁几乎全是舰长、谁全靠 SC。
 * 颜色与付费页饼图一致：舰长类=主粉、SC=珊瑚、礼物=藏青。
 */
function payMixBar(r: FanRankedRow) {
  const guard = r.guard_amt ?? 0
  const sc = r.sc_amt ?? 0
  const gift = r.gift_amt ?? 0
  const total = guard + sc + gift
  if (!total) {
    // 分类金额缺失（老数据没有 g/gd/sc 三项）时，退化成"总额单色条"，
    // 至少能看出这人花了多少，不会整列空白（2026-10-26 用户报"三色轴不见了"）
    return r.pay_total > 0
      ? (
        <span className="wb-mix">
          <span className="wb-mix-bar"><i style={{ width: '100%', background: '#c9406f' }}
                                         title="缺分类金额（老数据）" /></span>
          <span className="wb-mix-text">¥{r.pay_total.toLocaleString()}</span>
        </span>
      )
      : '—'
  }
  const seg = (v: number, color: string, label: string) => {
    const w = (v / total) * 100
    if (w <= 0) return null
    return <i key={label} style={{ width: `${w}%`, background: color }} title={`${label} ${w.toFixed(0)}%`} />
  }
  const pct = (v: number) => `${((v / total) * 100).toFixed(0)}%`
  return (
    <span className="wb-mix">
      <span className="wb-mix-bar">
        {seg(guard, '#c9406f', '舰长类')}
        {seg(sc, '#fc7079', '醒目留言')}
        {seg(gift, '#7c93b5', '礼物')}
      </span>
      <span className="wb-mix-text">
        {pct(guard)} / {pct(sc)} / {pct(gift)}
      </span>
    </span>
  )
}

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
  tagOptions, tagLoading, tagError, tagFilter, onTagFilter, sessionMeta, lagRef,
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
        <div className="wb-head-tools">
          <MemberSearch vtuber={vtuber} since={since} until={until} ids={ids}
                        onPick={onOpenMember} />
          <TagFilter tags={tagOptions} loading={tagLoading} error={tagError}
                     value={tagFilter} onChange={onTagFilter} />
        </div>
      </div>

      {rows.length === 0 && !loading ? (
        <p className="wb-hint">这一页没有数据。</p>
      ) : (
        <div className="wb-table-wrap">
          <table className="wb-table wb-table-ranked is-fixed" data-testid="ranked-table">
            <colgroup>
              {/* 前四列**所有页签一致**（序号 / 头像 / 昵称 / 强度）；
                  最后一列吃掉剩余宽度 —— 否则各页总宽不同，会触发横向滚动条挤列宽
                  （2026-10-25 用户反馈） */}
              <col style={{ width: '44px' }} />
              <col style={{ width: '52px' }} />
              <col style={{ width: '190px' }} />
              <col style={{ width: '78px' }} />
              {tab === 'overview' && <>
                <col style={{ width: '88px' }} /><col style={{ width: '88px' }} />
                <col style={{ width: '88px' }} /><col />
              </>}
              {tab === 'attendance' && <>
                <col style={{ width: '92px' }} /><col style={{ width: '80px' }} />
                <col style={{ width: '96px' }} /><col />
              </>}
              {tab === 'interaction' && <>
                <col style={{ width: '92px' }} /><col style={{ width: '120px' }} />
                <col style={{ width: '90px' }} /><col style={{ width: '100px' }} />
                <col />
              </>}
              {tab === 'payment' && <>
                <col style={{ width: '92px' }} /><col style={{ width: '110px' }} />
                <col style={{ width: '84px' }} /><col />
              </>}
            </colgroup>
            <thead>
              <tr>
                <th>#</th><th>用户</th><th>昵称</th><th>强度</th>
                {tab === 'overview' && <>
                  <th>出席分位</th><th>弹幕分位</th><th>付费分位</th><th>标签</th>
                </>}
                {tab === 'attendance' && <>
                  <th className="wb-th-key">出席分位</th><th>出席率</th>
                  <th>平均时滞</th><th>出席明细</th>
                </>}
                {tab === 'interaction' && <>
                  <th className="wb-th-key">互动分位</th><th>去重/总弹幕</th>
                  <th>场均弹幕</th><th>独轮车</th><th />
                </>}
                {tab === 'payment' && <>
                  <th className="wb-th-key">付费分位</th><th>总付费</th>
                  <th>贡献占比</th><th>构成（舰/SC/礼）</th>
                </>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.uid} className="wb-row-click wb-row-enter"
                    style={{ animationDelay: `${Math.min(i, 12) * 18}ms` }}
                    onClick={() => onOpenMember(r.uid)}>
                  <td className="wb-table-rank">{r.rank}</td>
                  <td><Avatar row={r} /></td>
                  <td className="wb-table-name" title={r.uid}>
                    {(r.name || r.uid).slice(0, 18)}
                    <span className="wb-table-uid-sub">{r.uid}</span>
                  </td>
                  <td className="wb-table-strength">{r.strength.toFixed(3)}</td>
                  {tab === 'overview' && <>
                    <td>{pct(r.axis_percentiles.attendance ?? 0)}</td>
                    <td>{pct(r.axis_percentiles.interaction ?? 0)}</td>
                    <td>{pct(r.axis_percentiles.payment ?? 0)}</td>
                    <td className="wb-table-tags"><TagPills tags={r.tags} /></td>
                  </>}
                  {tab === 'attendance' && <>
                    <td className="wb-th-key-val">{pct(r.axis_percentiles.attendance ?? 0)}</td>
                    <td>{pct(r.att_rate)}</td>
                    <td>{r.mean_lag_minutes == null ? '—' : `${r.mean_lag_minutes.toFixed(1)} 分`}</td>
                    <td>
                      <AttendanceBits bits={r.att_bits ?? []} sessions={sessionMeta}
                                      att={r.att_sessions} total={sessionMeta.length}
                                      lagRef={lagRef} />
                    </td>
                  </>}
                  {tab === 'interaction' && <>
                    <td className="wb-th-key-val">{pct(r.axis_percentiles.interaction ?? 0)}</td>
                    <td>{(r.msg_unique ?? 0).toLocaleString()} / {r.msg_total.toLocaleString()}</td>
                    <td>{(r.msg_per_session ?? 0).toFixed(1)}</td>
                    <td>{spamLabel(r.spam_level)}</td>
                    <td />
                  </>}
                  {tab === 'payment' && <>
                    <td className="wb-th-key-val">{pct(r.axis_percentiles.payment ?? 0)}</td>
                    <td>{r.pay_total > 0 ? `¥${r.pay_total.toLocaleString()}` : '—'}</td>
                    <td>{r.pay_share ? `${(r.pay_share * 100).toFixed(2)}%` : '—'}</td>
                    <td className="wb-pay-mix">{payMixBar(r)}</td>
                  </>}
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
