import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { api, resolveAsset } from '../../api/api'

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer])
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

/**
 * 逐场柱状图（2026-10-24 改 ECharts）。
 *
 * - **场次多时横向滚动**：容器宽度 = 场次 × 每根柱子的最小宽度，外层 `overflow-x: auto`；
 *   不加 `dataZoom` —— 弹窗空间小，缩放容易误触；
 * - tooltip 一次给出「时间 / 弹幕 / 付费 / 入场」四项，比原生 `title` 单行更有用；
 * - 卸载时 `dispose()`，避免反复开关累积实例。
 */
function SessionChart({ series, color, unit }: {
  series: { start_at: string; m: number; p: number; e: number }[]
  color: string
  unit: string
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const chart = useRef<ReturnType<typeof echarts.init> | null>(null)
  const n = Math.max(1, series.length)

  useEffect(() => {
    if (!box.current) return
    let ok = true
    try {
      if (!document.createElement('canvas').getContext('2d')) return   // jsdom 没有 canvas
      chart.current = echarts.init(box.current)
    } catch { return }

    const opt: EChartsCoreOption = {
      animation: false,
      grid: { left: 6, right: 6, top: 8, bottom: 18 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        // ⚠️ 图表在横向滚动容器里（overflow-x:auto 会**裁掉**溢出的 tooltip）。
        // 挂到 body 上就绕开了裁剪 —— 这是 ECharts 5.5+ 的 `appendTo`。
        appendTo: () => document.body,
        confine: false,
        extraCssText: 'z-index: 80;',
        formatter: (ps: unknown) => {
          const arr = ps as { dataIndex: number }[]
          const i = arr?.[0]?.dataIndex ?? 0
          const d = series[i]
          if (!d) return ''
          return `${d.start_at}<br/>弹幕 ${d.m.toLocaleString()} 条`
            + `<br/>付费 ¥${d.p.toLocaleString()}<br/>入场 ${d.e} 次`
        },
      },
      xAxis: {
        type: 'category',
        // 横轴只要日期（MM-DD）；具体时分仍留在 tooltip 里
        data: series.map((d) => d.start_at.slice(5, 10)),
        // 只标首 / 中 / 尾三个，避免 75 场时标签糊成一片
        axisLabel: {
          fontSize: 9,
          color: '#5b6c7e',
          hideOverlap: true,
          interval: (i: number) => i === 0 || i === Math.floor((n - 1) / 2) || i === n - 1,
        },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: 'rgba(210,216,222,0.9)' } },
      },
      yAxis: {
        type: 'value',
        splitNumber: 2,
        axisLabel: {
          fontSize: 9,
          color: '#5b6c7e',
          formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)),
        },
        splitLine: { lineStyle: { color: 'rgba(210,216,222,0.45)' } },
      },
      series: [{
        type: 'bar',
        barWidth: '62%',
        itemStyle: { color, borderRadius: [2, 2, 0, 0] },
        data: series.map((d) => (unit === '元' ? d.p : d.m)),
      }],
    }
    chart.current.setOption(opt, true)
    if (!ok) return
    return () => {
      chart.current?.dispose()
      chart.current = null
    }
  }, [series, color, unit, n])

  return (
    <div className="wb-chart-scroll">
      <div ref={box} className="wb-chart-inner"
           style={{ width: `${Math.max(360, n * 14)}px`, height: '64px' }} />
    </div>
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
              <SessionChart series={data.series} color="#c9406f" unit="条" />
            </div>
            <div className="wb-drawer-chart">
              <h5>付费（元）</h5>
              <SessionChart series={data.series} color="#fc7079" unit="元" />
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
