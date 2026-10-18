import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HmSession } from '../../api/types'

interface DayStat {
  /** 当天场次数 —— **热力图深浅只编码它** */
  n: number
  /** 其中弹幕**已落盘**的场次数 */
  c: number
}

interface Props {
  days: Record<string, DayStat>
  /** 逐场明细（`/activity` 的 `detail`）：日期 → 该天的场次，浮窗用 */
  detail?: Record<string, HmSession[]>
  years: number[]
  /** 服务器当天（`YYYY-MM-DD`）—— 灰格判定必须与后端同一天 */
  today: string
  defaultYear: number
}

/** 格子边长与间距都是常量 ⇒ **一格必然是正方形**（不用 `1fr` 自适应） */
/* 53 周 × 13px = 689px，比卡片内容区（~683px）**宽 6px** —— 网格溢出会把头部行撑宽，
   右侧的年份翻页因此被卡片裁掉（2026-10-19 截图：右箭头跑到卡外）。缩到 10px 正好收进来。 */
const CELL = 10
const GAP = 2

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

function iso(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * 直播与采集热力图（V3，2026-10-18）。
 *
 * **两条信息各走各的通道，绝不共用**（`plans/workbench-visual-redesign.md` §2.C）：
 *
 * | 通道 | 编码 | 实现 |
 * |---|---|---|
 * | 格子深浅（4 档） | **只**编码当天的直播场次数 | `n1`~`n3` 三档 + 空 |
 * | 右上角深色角标 | 当天弹幕**已采集** | `.wb-hm-cell.coll::after` |
 * | 实心灰 | 还没到的日子 | `.future`；**不留空白** |
 *
 * 为什么角标而不是外框/括号：实测 75 场是**跳着采的**（40 余段、每段 1–3 天），
 * 段级标记会碎成一把屑；逐格角标不需要 run 合并，连续的日子天然连成一串。
 *
 * 几何：`left = 列序号 × (CELL + GAP)`，**精确像素**，与格子严格同轴；
 * 年份写在 1 月那一列上方 —— 那正是 12 月与 1 月的交界处。
 */
export default function Heatmap({ days, detail, years, today, defaultYear }: Props) {
  const [year, setYear] = useState(defaultYear)
  /** 年份选择浮层（点中间那块展开） */
  const [pick, setPick] = useState(false)
  const navRef = useRef<HTMLDivElement>(null)
  const minYear = years[0] ?? defaultYear
  const maxYear = years[years.length - 1] ?? defaultYear

  /** 格子的 hover 浮窗（2026-10-19 用户第 5 条）：**不用原生 title**，
      原生小黄条既不受样式控制，也在暗色/缩放下发虚。位置用 fixed 跟随光标。 */
  const [hover, setHover] = useState<{ x: number; y: number; day: string } | null>(null)

  const grid = useMemo(() => {
    const jan1 = new Date(year, 0, 1)
    const dec31 = new Date(year, 11, 31)
    // 首列从 1 月 1 日所在周的周一起（可能含几天去年 12 月）
    const start = new Date(jan1)
    const shift = (jan1.getDay() + 6) % 7          // 周一 = 0
    start.setDate(jan1.getDate() - shift)

    const weeks = Math.floor((dec31.getTime() - start.getTime()) / 86400000 / 7) + 1
    const cells: { d: string; w: number; dow: number; in: boolean }[] = []
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      cells.push({
        d: iso(d),
        w: Math.floor(i / 7),
        dow: (d.getDay() + 6) % 7,
        in: d.getFullYear() === year,
      })
    }
    const labels = MONTHS.map((m, i) => {
      const first = new Date(year, i, 1)
      return { m, w: Math.floor((first.getTime() - start.getTime()) / 86400000 / 7) }
    })
    const janCol = Math.floor((jan1.getTime() - start.getTime()) / 86400000 / 7)
    return { weeks, cells, labels, janCol }
  }, [year])


  return (
    <>
      <div className="wb-hm-head">
        <h2 className="wb-card-title">直播与采集</h2>
        {/* 与直播日历的导航栏**同构**（2026-10-19 用户："直接参考直播日历卡片上的按钮实现"）：
            `FloatPill` 用**默认尺寸**（不传 size —— 传 sm 会把图标挤掉），图标用
            `ChevronsLeft/Right` + 日历那套 `lc-nav-icon` / `lc-nav-text` 类。 */}
        <div className="wb-hm-years" ref={navRef}>
          {/* 不依赖浮片族：这两个钮在窄行里会被压成 0 宽（2026-10-19 截图复现），
              改用自带尺寸的普通按钮 —— 视觉上与浮片一致（白底 + 发丝边 + 卡片内圆角）。 */}
          <button type="button" className="wb-hm-nav-btn" title="上一年"
                  onClick={() => setYear((y) => Math.max(minYear, y - 1))} data-testid="hm-prev">‹</button>
          <button type="button" className="wb-hm-year-btn-mid" title="选择年份"
                  onClick={() => setPick((p) => !p)} data-testid="hm-year">
            {year}
          </button>
          <button type="button" className="wb-hm-nav-btn" title="下一年"
                  onClick={() => setYear((y) => Math.min(maxYear, y + 1))} data-testid="hm-next">›</button>
          {pick && (
            <div className="wb-hm-year-menu" data-testid="hm-year-menu">
              {years.map((y) => (
                <button key={y} type="button" onClick={() => { setYear(y); setPick(false) }}
                        className={y === year ? 'is-on' : ''} data-testid={`hm-year-${y}`}>
                  {y}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="wb-hm-months" style={{ paddingTop: 13, height: 27 }}>
        {grid.labels.map((L) => (
          <span key={L.m} style={{ left: L.w * (CELL + GAP) }}>{L.m}</span>
        ))}
        <span className="yr" style={{ left: grid.janCol * (CELL + GAP), top: 0 }}>{year}</span>
      </div>

      <div className="wb-hm" style={{
        gridAutoColumns: `${CELL}px`,
        gridTemplateRows: `repeat(7, ${CELL}px)`,
        gap: GAP,
      }}>
        {grid.cells.map((c) => {
          const stat = days[c.d]
          const future = c.d > today
          const n = stat?.n ?? 0
          const coll = stat?.c ?? 0
          const cls = ['wb-hm-cell']
          if (!c.in) cls.push('out')
          else if (future) cls.push('future')
          else if (n > 0) cls.push(`n${Math.min(3, n)}`)
          if (c.in && !future && coll > 0) cls.push('coll')
          return (
            <div key={c.d} className={cls.join(' ')}
                 data-testid="hm-cell" data-day={c.d}
                 onMouseEnter={c.in && !future ? (e) => setHover({ x: e.clientX, y: e.clientY, day: c.d }) : undefined}
                 onMouseMove={c.in && !future ? (e) => setHover({ x: e.clientX, y: e.clientY, day: c.d }) : undefined}
                 onMouseLeave={c.in && !future ? () => setHover(null) : undefined} />
          )
        })}
      </div>

      <div className="wb-hm-foot">
        <span className="wb-lg">
          <i style={{ background: '#f4eef0' }} /><i style={{ background: '#fbd3dd' }} />
          <i style={{ background: '#f7b2c3' }} /><i style={{ background: '#ef8ba5' }} />
          越深 = 当天场次越多
        </span>
        <span className="wb-lg"><i className="mark" /> 角标 = 弹幕已采</span>
        <span className="wb-lg"><i style={{ background: '#e7eaee' }} /> 灰 = 还没到</span>
      </div>

      {/* 自定义浮窗：**用 Portal 挂到 body**（2026-10-19 修偏移）。
          ⚠️ 之前直接放在卡片里：只要某个祖先带 `transform`（页面入场动画 `rise-in-page`
          就会留在计算样式里），`position: fixed` 的包含块就变成那个祖先 ——
          于是 `clientX/clientY` 被当成了相对它的坐标，浮窗整体偏移。挂到 body 就没有这层。 */}
      {hover && createPortal(
        <div className="wb-hm-tip" data-testid="hm-tip"
             style={{ left: hover.x + 14, top: hover.y + 16 }}>
          <b>{hover.day}</b>
          {(() => {
            const list = detail?.[hover.day] ?? []
            const stat = days[hover.day]
            if (!list.length) {
              return <span className="wb-tip-line">{stat?.n ? `${stat.n} 场` : '无直播'}</span>
            }
            return list.map((s, i) => (
              <div className="wb-tip-sess" key={`${hover.day}-${i}`}>
                <span className="wb-tip-title">{s.title || '（无标题）'}</span>
                <span className="wb-tip-meta">
                  {s.at.slice(11, 16)}
                  {s.end ? ` – ${s.end}` : ''}
                  {s.dur != null ? ` · ${Math.floor(s.dur / 60)}小时${s.dur % 60}分` : ''}
                </span>
                {s.area ? <span className="wb-tip-meta">{s.area}</span> : null}
                <span className="wb-tip-meta">
                  {s.income != null ? `收益 ¥${s.income.toLocaleString()}` : '收益 —'}
                  {s.peak != null ? ` · 峰值 ${s.peak.toLocaleString()}` : ''}
                  {` · 弹幕 ${s.m.toLocaleString()}`}
                </span>
              </div>
            ))
          })()}
        </div>,
        document.body,
      )}
    </>
  )
}
