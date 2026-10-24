import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { api, resolveAsset } from '../../api/api'
import type { FanMemberDetail } from '../../api/types'

interface Props {
  vtuber: string
  uid: string
  since: string
  until: string
  ids: string[]
  onClose: () => void
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`

/** 付费构成条：礼物 / 舰长类 / SC 的金额与占比（B 站只按大类给金额，不分舰长等级） */
function PayBreakdown({ totals }: { totals: FanMemberDetail['totals'] }) {
  const rows = [
    { name: '舰长类', v: totals.guard_amt, color: '#c9406f' },
    { name: '醒目留言', v: totals.sc_amt, color: '#fc7079' },
    { name: '礼物', v: totals.gift_amt, color: '#7c93b5' },
  ]
  const sum = rows.reduce((s, r) => s + r.v, 0) || 1
  return (
    <div className="wb-pay">
      {rows.map((r) => (
        <div className="wb-pay-row" key={r.name}>
          <span className="wb-pay-name">{r.name}</span>
          <span className="wb-pay-bar">
            <i style={{ width: `${(r.v / sum) * 100}%`, background: r.color }} />
          </span>
          <span className="wb-pay-val">¥{r.v.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          <span className="wb-pay-pct">{((r.v / sum) * 100).toFixed(1)}%</span>
        </div>
      ))}
    </div>
  )
}

/** 逐场弹幕数的小柱图（不引图表库：一行 SVG 就够） */
function Spark({ values, labels, color, unit }: {
  values: number[]; labels: string[]; color: string; unit: string
}) {
  const max = Math.max(1, ...values)
  const n = values.length || 1
  return (
    <svg className="wb-spark" viewBox={`0 0 ${n * 2} 40`} preserveAspectRatio="none" role="img">
      {values.map((v, i) => {
        const h = Math.max(1, (v / max) * 38)
        return (
          <rect key={i} x={i * 2} y={40 - h} width={1.6} height={40} fill={color} opacity={0.9}>
            {/* hover 显示该场时间与数值（原生 title，无 JS） */}
            <title>{`${labels[i] ?? ''} · ${v.toLocaleString()} ${unit}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}

/**
 * 成员详情（2026-10-24）：右侧抽屉，展示全部分量与逐场序列。
 */
export default function MemberDrawer({ vtuber, uid, since, until, ids, onClose }: Props) {
  const [data, setData] = useState<FanMemberDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setData(null); setErr(null)
    api.fanMember(vtuber, uid, { since, until, ids })
      .then((d) => { if (alive) setData(d) })
      .catch((e: Error) => { if (alive) setErr(e.message) })
    return () => { alive = false }
  }, [vtuber, uid, since, until, ids])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="wb-member-dialog" data-testid="member-drawer">
        <DialogHeader>
          <DialogTitle>
            {data?.name || uid}
            <span className="wb-table-uid-sub">{uid}</span>
          </DialogTitle>
        </DialogHeader>

        {err && <p className="wb-hint">{err}</p>}
        {!data && !err && <p className="wb-hint">读取中…</p>}

        {data && (
          <div className="wb-drawer-body">
            <div className="wb-drawer-identity">
              <img className="wb-avatar wb-avatar-lg" src={resolveAsset(data.avatar) ?? ''} alt="" />
              <div>
                <div className="wb-drawer-type">{data.type} · 强度 {data.strength.toFixed(3)}</div>
                <div className="wb-drawer-sub">
                  出席 {data.totals.att_sessions}/{data.totals.window_sessions} 场（{pct(data.totals.att_rate)}）
                </div>
              </div>
            </div>

            <h4 className="wb-drawer-sec">行为</h4>
            <dl className="wb-kv">
              <div><dt>出席场次</dt><dd>{data.totals.att_sessions} / {data.totals.window_sessions}</dd></div>
              <div><dt>场均弹幕</dt><dd>{data.totals.msg_per_session.toFixed(1)}</dd></div>
              <div><dt>场均入场时滞</dt>
                <dd>{data.totals.mean_lag_minutes == null ? '—' : `${data.totals.mean_lag_minutes.toFixed(1)} 分`}</dd></div>
              <div><dt>总弹幕 / 去重</dt>
                <dd>{data.totals.msg_total.toLocaleString()} / {data.totals.msg_unique.toLocaleString()}</dd></div>
            </dl>

            <h4 className="wb-drawer-sec">付费</h4>
            <dl className="wb-kv">
              <div><dt>总付费</dt><dd>¥{data.totals.pay_total.toLocaleString()}</dd></div>
              <div><dt>每笔均值</dt>
                <dd>{data.totals.pay_events ? `¥${data.totals.pay_per_event.toFixed(2)}` : '—'}</dd></div>
            </dl>
            <PayBreakdown totals={data.totals} />

            <h4 className="wb-drawer-sec">独轮车判定</h4>
            <div className="wb-spam-box">
              {data.totals.spam_rule
                ? <span className="wb-badge-spam">判为独轮车（{data.totals.spam_rule}）</span>
                : <span className="wb-ok">未命中</span>}
              <span className="wb-spam-ev">
                不同文本率 {data.totals.variety == null ? '未追踪'
                  : pct(data.totals.variety)} · 单条最大重复 {data.totals.maxrep}
                （判据：不同文本率 ≤20%）
              </span>
            </div>

            <h4 className="wb-drawer-sec">逐场趋势</h4>
            <div className="wb-drawer-chart">
              <h5>弹幕数</h5>
              <Spark values={data.series.map((s) => s.m)}
                     labels={data.series.map((s) => s.start_at)}
                     color="#c9406f" unit="条" />
            </div>
            <div className="wb-drawer-chart">
              <h5>付费（元）</h5>
              <Spark values={data.series.map((s) => s.p)}
                     labels={data.series.map((s) => s.start_at)}
                     color="#fc7079" unit="元" />
            </div>

            <h4 className="wb-drawer-sec">三轴分位</h4>
            <dl className="wb-kv">
              <div><dt>出席</dt><dd>{pct(data.axis_percentiles.attendance ?? 0)}</dd></div>
              <div><dt>互动</dt><dd>{pct(data.axis_percentiles.interaction ?? 0)}</dd></div>
              <div><dt>付费</dt><dd>{pct(data.axis_percentiles.payment ?? 0)}</dd></div>
            </dl>

            <h4 className="wb-drawer-sec">标签</h4>
            <div className="wb-drawer-tags">
              {data.tags.length ? data.tags.map((t) => <span key={t} className="wb-tag">{t}</span>) : '—'}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
