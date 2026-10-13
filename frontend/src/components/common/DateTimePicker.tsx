/**
 * 日期 + 时刻选择器（用户 2026-10-13 定的 **B 方案**：单月日历 ＋ 时/分滚轮列）。
 *
 * ## 为什么自己画
 *
 * 原先是原生 `<input type="datetime-local">`，它的弹层是**浏览器自己画的**（蓝灰配色、
 * 直角、与全站零关系）—— 用户截图点名「参照 list 视图日期筛选的日历样式改一下，
 * 以保证符合项目的整体美术风格」。而那颗日历（`common/DateRangePicker.tsx` + `.drp-*`）
 * 是选**区间**的：双月面板、六枚预设、草稿制 + 确认。这里要的是**单日 + 时刻**，
 * 所以日历那部分**一个像素都不新写**（`.drp-panel/.drp-head/.drp-wd/.drp-grid/.drp-day`
 * 直接用同一套类），新写的只有「字段」与「时/分滚轮列」。
 *
 * ## 值只有一种格式
 *
 * `YYYY-MM-DDTHH:mm` —— 就是 `<input type="datetime-local">` 的 value，也是**原样发给
 * 服务端**的那个字符串（`manualSessionForm.ts` 记着时区纪律：绝不 `toISOString()` 折一次）。
 * 拆装全走 `utils/dateRange.ts` 的 `splitLocal`/`joinLocal`（由 `check_date_range.mjs` 钉住），
 * 组件里**不自己拼字符串** —— 错一位就是"我选的 20:00 存成了 08:00"。
 *
 * ## 三条交互口径（都是"用户会踩"的地方）
 *
 * | 口径 | 为什么 |
 * |---|---|
 * | 点日期**只换日期**，时刻原样保留 | 用户改的是"哪一天"，不是"把 20:00 抹成 00:00" |
 * | 改时刻**只在已有日期上改**；字段为空时用 `seedDate`（默认今天）起算 | 空字段滚一下滚轮就凭空长出一个日期是很吓人的事，所以起算点是**明确给的** |
 * | 滚轮**必须**同时支持滚轮/触摸/键盘 | 只做滚动的滚轮列在触控板与键盘用户那里是坏的（下面 `Column` 三条都实现了） |
 *
 * ⚠️ **Esc 的归属**：Radix 的弹窗把 `keydown` 注册在 `document` 的**捕获段**，
 * 所以面板里的 `onKeyDown` 拦不住它。父组件要把 `open` 提升成受控状态，
 * 并在 `DialogContent` 的 `onEscapeKeyDown` 里 `preventDefault()`（见两个调用方）——
 * 否则"按 Esc 想关这个弹层"会变成"整个弹窗没了"。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'

import {
  HOURS, MINUTES, fmtDate, fmtLocalHuman, joinLocal, monthGrid, parseDate, shiftMonths,
  splitLocal, today,
} from '../../utils/dateRange'

/** 星期表头：周一为首（与 `DateRangePicker`、`LiveCalendar` 同口径） */
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

/** 一格的像素高（CSS 里 `.dtp-item { height: 22px }`）—— 只作 jsdom 里的兜底 */
const ITEM_H = 22

interface Props {
  /** 给 `<label htmlFor>` 用（沿用 `lc-ms-start` / `lc-ms-end` / `lc-rv-date` 这几个既有 id） */
  id: string
  /** `YYYY-MM-DDTHH:mm`（`dateOnly` 时是 `YYYY-MM-DD`）；空串 = 未填 */
  value: string
  onChange: (v: string) => void
  /** 弹出层的开关：**受控**（父组件才能在 Esc 时先关它，见文件头） */
  open: boolean
  onOpenChange: (open: boolean) => void
  disabled?: boolean
  /** 只选日期（预约窗：预约只到日，摆一个"填了也会被忽略"的时刻列比不摆更糟） */
  dateOnly?: boolean
  /** 值为空时起算的时刻（`HH:mm`）—— 与新建默认时段同一个数（`manualSessionForm` 的常量） */
  defaultTime?: string
  /** 值为空时起算的日期（`YYYY-MM-DD`）—— 不传就是今天 */
  seedDate?: string
  /** 给"结束时间"用：可以清空（= 改回进行中） */
  clearable?: boolean
  /** 空值时字段里显示的文案 */
  placeholder?: string
}

/** 单列滚轮：滚轮/触摸走原生滚动 + `scroll-snap`，键盘走 `listbox` 语义 */
function Column({
  label, idBase, items, value, onPick,
}: {
  label: string
  idBase: string
  items: string[]
  value: string
  onPick: (v: string) => void
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const idx = Math.max(0, items.indexOf(value))

  /** 外部改值（点日期 / 键盘 / 打开弹层）→ 把选中项滚到中线。
   *
   *  ⚠️ 用 `scrollTop` 而**不是** `scrollIntoView`：后者会连带滚动**所有**祖先
   *  （弹窗、卡片、页面）—— 本仓为"聚焦/滚动把页面顶走"已经栽过两次（`devlog/476`）。 */
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const h = itemRefs.current[0]?.offsetHeight || ITEM_H
    const want = idx * h
    if (Math.abs(box.scrollTop - want) > 1) box.scrollTop = want
  }, [idx, value])

  /** 用户滚动 → 吸附停稳后取值。
   *
   *  为什么用防抖而不是 `scrollend`：`scrollend` 在旧 WebView 上还没有，
   *  而这里只要"停下来了取一次"，120ms 足够（滚轮惯性期间会连续重置）。 */
  const timer = useRef<number | null>(null)
  const onScroll = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const box = boxRef.current
      if (!box) return
      const h = itemRefs.current[0]?.offsetHeight || ITEM_H
      const i = Math.min(items.length - 1, Math.max(0, Math.round(box.scrollTop / h)))
      if (items[i] !== value) onPick(items[i])
    }, 120)
  }, [items, onPick, value])
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current) }, [])

  const step = (delta: number) => {
    const i = Math.min(items.length - 1, Math.max(0, idx + delta))
    if (items[i] !== value) onPick(items[i])
  }

  return (
    <div
      className="dtp-col" ref={boxRef} role="listbox" tabIndex={0}
      aria-label={label} aria-activedescendant={`${idBase}-${value}`}
      data-dtp-col={label} onScroll={onScroll}
      onKeyDown={(e) => {
        const map: Record<string, number | 'first' | 'last'> = {
          ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5, Home: 'first', End: 'last',
        }
        const k = map[e.key]
        if (k === undefined) return
        e.preventDefault()                       // 不然 PageUp/Home/End 会滚外面那层
        if (k === 'first') step(-items.length)
        else if (k === 'last') step(items.length)
        else step(k)
      }}
    >
      {items.map((it, i) => (
        <button
          key={it} type="button" role="option" id={`${idBase}-${it}`}
          aria-selected={it === value}
          ref={(el) => { itemRefs.current[i] = el }}
          className={`dtp-item${it === value ? ' on' : ''}`}
          onClick={() => onPick(it)}
        >
          {it}
        </button>
      ))}
    </div>
  )
}

export default function DateTimePicker({
  id, value, onChange, open, onOpenChange, disabled, dateOnly = false,
  defaultTime = '20:00', seedDate, clearable = false, placeholder = '选择日期',
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  const sp = splitLocal(value)
  const [month, setMonth] = useState<Date>(() => parseDate(sp?.date ?? '') ?? today())
  /** 弹出层朝上还是朝下（弹窗贴着视口底部时朝上，否则面板会被切掉） */
  const [up, setUp] = useState(false)

  const dateKey = sp?.date ?? seedDate ?? fmtDate(today())
  const time = sp?.time ?? defaultTime
  const [hh, mm] = time.split(':')
  const tKey = fmtDate(today())

  // 每次打开都从**当前值**那个月起算（上一次翻过的月份不残留 —— 与 DateRangePicker 同口径）。
  // ⚠️ 依赖只有 `open`：把 `value` 也放进依赖，点一格"上/下月补位格"就会把面板跳走
  //    （用户只是点了眼前那一格，视图不该跟着换月）。所以打开那一刻的值走 ref 读一次。
  const atOpen = useRef({ date: '', seed: '' })
  atOpen.current = { date: sp?.date ?? '', seed: seedDate ?? '' }
  useEffect(() => {
    if (!open) return
    const { date, seed } = atOpen.current
    setMonth(parseDate(date) ?? parseDate(seed) ?? today())
  }, [open])

  // 点外面 / Esc 关闭（Esc 只关这一层：整个弹窗的关闭由父组件的 onEscapeKeyDown 管，见文件头）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onOpenChange(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, onOpenChange])

  // 朝上/朝下：量一次真实几何再定（不猜高度）
  useLayoutEffect(() => {
    if (!open) { setUp(false); return }
    const w = wrapRef.current?.getBoundingClientRect()
    const p = popRef.current?.getBoundingClientRect()
    if (!w || !p) return
    setUp(w.bottom + 6 + p.height > window.innerHeight - 8 && w.top - 6 - p.height > 8)
  }, [open, month])

  const emit = (date: string, hm: string) => {
    onChange(dateOnly ? date : joinLocal(date, hm))
  }

  return (
    <div className="dtp" ref={wrapRef}>
      <button
        type="button" id={id} className="lc-ms-input dtp-field" disabled={disabled}
        aria-haspopup="dialog" aria-expanded={open}
        data-dtp-value={value}
        onClick={() => onOpenChange(!open)}
      >
        <span className={value ? undefined : 'dtp-ph'}>
          {fmtLocalHuman(value) || placeholder}
        </span>
        <CalendarDays className="size-3.5" aria-hidden />
      </button>

      {open && (
        <div
          className="dtp-pop" ref={popRef} role="dialog" aria-label="选择日期与时间"
          data-dtp-pop={dateOnly ? 'date' : 'datetime'}
          style={up ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }}
        >
          <div className="dtp-main">
            {/* 日历：**复用 `.drp-*`**（与 list 视图的筛选日历同一套样式，一个新像素都没写） */}
            <div className="drp">
              <div className="drp-panels">
                <div className="drp-panel">
                  <div className="drp-head">
                    <span className="drp-nav-group">
                      <button type="button" className="drp-nav" data-nav="year" data-dir="-1"
                              title="上一年" onClick={() => setMonth(shiftMonths(month, -12))}>
                        <ChevronsLeft className="size-3.5" />
                      </button>
                      <button type="button" className="drp-nav" title="上个月"
                              onClick={() => setMonth(shiftMonths(month, -1))}>
                        <ChevronLeft className="size-3.5" />
                      </button>
                    </span>
                    <span className="drp-title">{month.getFullYear()}年{month.getMonth() + 1}月</span>
                    <span className="drp-nav-group">
                      <button type="button" className="drp-nav" title="下个月"
                              onClick={() => setMonth(shiftMonths(month, 1))}>
                        <ChevronRight className="size-3.5" />
                      </button>
                      <button type="button" className="drp-nav" data-nav="year" data-dir="1"
                              title="下一年" onClick={() => setMonth(shiftMonths(month, 12))}>
                        <ChevronsRight className="size-3.5" />
                      </button>
                    </span>
                  </div>
                  <div className="drp-wd">
                    {WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
                  </div>
                  <div className="drp-grid">
                    {monthGrid(month).map((d) => {
                      const k = fmtDate(d)
                      const cls = [
                        'drp-day',
                        d.getMonth() !== month.getMonth() && 'pad',
                        k === tKey && 'today',
                        k === dateKey && sp && 'sel',
                      ].filter(Boolean).join(' ')
                      return (
                        <button type="button" key={k} className={cls} data-dtp-day={k}
                                onClick={() => emit(k, time)}>
                          <span className="drp-day-num">{d.getDate()}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>

            {!dateOnly && (
              <div className="dtp-cols">
                <span className="dtp-mark" aria-hidden />
                <Column label="时" idBase={`${id}-h`} items={HOURS} value={hh}
                        onPick={(h) => emit(dateKey, `${h}:${mm}`)} />
                <Column label="分" idBase={`${id}-m`} items={MINUTES} value={mm}
                        onPick={(m) => emit(dateKey, `${hh}:${m}`)} />
              </div>
            )}
          </div>

          <div className="dtp-foot">
            <button type="button" className="dtp-lnk" data-dtp-today="1"
                    onClick={() => { setMonth(today()); emit(tKey, time) }}>
              今天
            </button>
            {clearable && (
              <button type="button" className="dtp-lnk" data-dtp-clear="1"
                      onClick={() => { onChange(''); onOpenChange(false) }}>
                清除
              </button>
            )}
            <span className="dtp-spacer" />
            <button type="button" className="dtp-lnk" data-dtp-done="1"
                    onClick={() => onOpenChange(false)}>
              完成
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
