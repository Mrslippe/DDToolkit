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

/** 逐场弹幕数的小柱图（不引图表库：一行 SVG 就够） */
function Spark({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values)
  const n = values.length || 1
  return (
    <svg className="wb-spark" viewBox={`0 0 ${n * 2} 40`} preserveAspectRatio="none" role="img">
      {values.map((v, i) => {
        const h = Math.max(1, (v / max) * 38)
        return <rect key={i} x={i * 2} y={40 - h} width={1.6} height={h} fill={color} />
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
                  出席 {data.totals.att_sessions} 场（{pct(data.totals.att_rate)}）
                  {data.spam && <span className="wb-badge-spam">独轮车</span>}
                </div>
              </div>
            </div>

            <dl className="wb-kv">
              <div><dt>总弹幕</dt><dd>{data.totals.msg_total.toLocaleString()}</dd></div>
              <div><dt>去重文本</dt><dd>{data.totals.msg_unique.toLocaleString()}</dd></div>
              <div><dt>付费总额</dt><dd>¥{data.totals.pay_total.toLocaleString()}</dd></div>
              <div><dt>SC 场次</dt><dd>{data.totals.sessions_with_pay}</dd></div>
              <div><dt>礼物 / 舰长 / SC</dt>
                <dd>{data.totals.gift_cnt} / {data.totals.guard_cnt} / {data.totals.sc_cnt}</dd></div>
              <div><dt>首次 / 末次</dt>
                <dd>{pct(data.totals.first_seen)} → {pct(data.totals.last_seen)}</dd></div>
            </dl>

            <div className="wb-drawer-chart">
              <h4>逐场弹幕数</h4>
              <Spark values={data.series.map((s) => s.m)} color="#c9406f" />
            </div>
            <div className="wb-drawer-chart">
              <h4>逐场付费（元）</h4>
              <Spark values={data.series.map((s) => s.p)} color="#fc7079" />
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
