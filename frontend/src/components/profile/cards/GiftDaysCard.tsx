/**
 * 「直播收益」卡片（需求 5，2026-10-08，`devlog/452`）。
 *
 * 用户口径：「数据面板根据本地已有的数据多加几个卡片，例如**每日总直播收益曲线**、
 * **每日舰长数变化曲线**等」＋「收益从 danmakus 这种第三方网站取，那里有单场直播总礼物数额」。
 *
 * 数据：`GET /account/{id}/gift-days`（`LiveGiftDay`，zeroroku 的**日粒度**聚合：
 * 礼物 / 舰长 / SC / 合计）—— **不用新抓**，库里已经有；此前只在「第三方数据」小窗里当表格列。
 *
 * ⚠️ 三条口径（都在 `utils/giftTrend.ts` 里，纯函数、有单测）：
 * 1. 金额是**字符串且可能是脏的** ⇒ 一律经 `amountToNumber`，解析不出来是 `null` 而**不是 0**
 *    （`Number("") === 0` 会把"这天没有数据"画成"这天 0 元"）；
 * 2. **整份数据都没有值 ⇒ 说"没有记录"，不画一条 0 线**（画的是一条假曲线）；
 * 3. 柱子是**堆叠**的（礼物 / 舰长 / SC 三段），一眼能看出收益构成。
 *
 * 为什么用 SVG 柱而不是 ECharts：卡片是 12 列网格里的 DOM 卡（`FanTrendChart` 那种
 * canvas 图表是**面板**级），而且 SVG 在 jsdom 里可断言 —— 判据能钉住"几天、多高、什么颜色"。
 */
import { useEffect, useState } from 'react'

import { api } from '../../../api/api'
import type { LiveGiftDay } from '../../../api/types'
import type { CardContext } from '../cardRegistry'
import { buildGiftPoints, formatAmount, giftSummary, hasGiftData } from '../../../utils/giftTrend'

/** 一次最多画多少天（多了柱子比头发还细；与卡片默认宽 7 列相称） */
const MAX_DAYS = 30
/** 画布高度（viewBox 单位；宽度自适应：`preserveAspectRatio="none"`） */
const H = 48

export default function GiftDaysCard({ account, refreshTick }: CardContext) {
  const [days, setDays] = useState<LiveGiftDay[] | null>(null)
  const [failed, setFailed] = useState(false)
  /* ⚠️ 依赖要写**取出来的 id**，不能写 `account?.id` 而 effect 体里用 `account`
     （`react-hooks/exhaustive-deps` 会红：那条依赖数组证明不了两者同源）。 */
  const accountId = account?.id ?? null

  useEffect(() => {
    if (accountId === null) return
    let cancelled = false
    setDays(null)
    setFailed(false)
    api.listLiveGiftDays(accountId)
      .then((d) => { if (!cancelled) setDays(d) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [accountId, refreshTick])

  if (!account) return <p className="pcard-empty">这个 V 还没有账号</p>
  if (failed) return <p className="pcard-empty">收益数据没取到（本地库读失败）—— 切走再切回来会重试</p>
  if (days === null) {
    return (
      <div className="gt" data-card-body="gift-days" data-pending="1">
        <span className="lc-skel gt-skel" />
      </div>
    )
  }
  if (!hasGiftData(days)) {
    // ⚠️ 这里是"**一条 0 线都不许画**"的落点：没有记录就说没有记录
    return (
      <p className="pcard-empty">
        还没有直播收益记录 —— 第三方源（zeroroku）收录之后才会出现
      </p>
    )
  }

  const all = buildGiftPoints(days)
  const points = all.slice(-MAX_DAYS)
  const sum = giftSummary(points)
  const peak = Math.max(...points.map((p) => p.total), 1)
  const w = Math.max(points.length, 1)
  const bw = 1 / w * 0.72                     /* 柱宽（viewBox 单位）= 槽宽的 72% */
  const slot = 1 / w

  return (
    <div className="gt" data-card-body="gift-days" data-gt-days={points.length}>
      <svg className="gt-svg" viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
           role="img" aria-label={`近 ${points.length} 天直播收益`}>
        {points.map((p, i) => {
          const x = i * slot + (slot - bw) / 2
          // 自下而上堆：礼物 → 舰长 → SC（比例按当天合计，最高那天顶到满高）
          let y = H
          const segs: Array<[string, number]> = [
            ['gift', p.gift], ['guard', p.guard], ['sc', p.sc],
          ]
          return (
            <g key={p.date} data-gt-bar={p.date}>
              <title>{`${p.date} · 合计 ${formatAmount(p.total)}（礼物 ${formatAmount(p.gift)} / 舰长 ${formatAmount(p.guard)} / SC ${formatAmount(p.sc)}）`}</title>
              {segs.map(([kind, v]) => {
                const h = (v / peak) * H
                y -= h
                return h <= 0 ? null : (
                  <rect key={kind} className={`gt-seg gt-${kind}`} data-gt-kind={kind}
                        x={x} y={y} width={bw} height={h} />
                )
              })}
            </g>
          )
        })}
      </svg>
      <p className="gt-sum" data-gt-total={sum?.total ?? 0}>
        {sum && (
          <>
            近 {sum.days} 天合计 <b>{formatAmount(sum.total)}</b>
            {sum.best && ` · 最高 ${sum.best.date.slice(5).replace('-', '/')} ${formatAmount(sum.best.total)}`}
          </>
        )}
      </p>
    </div>
  )
}
