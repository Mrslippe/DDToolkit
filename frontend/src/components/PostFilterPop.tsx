import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Ghost } from 'lucide-react'
import FloatPill from './common/FloatPill'
import DateRangePicker from './common/DateRangePicker'
import OverlayScroll from './OverlayScroll'
import { rangeText } from '../utils/dateRange'
import type { DateRange } from './common/DateRangePicker'
import './../styles/posts.css'

/** 弹窗与触发器之间的间隙、以及与面板底的呼吸位 —— **真源在 CSS**（`.post-filter-pop`
 *  的 `--pop-gap` / `--pop-breath`），这里只是读出来用。组件与样式表各写一份数字
 *  迟早会漂（本仓反复踩过），所以 TS 侧**不写死**。 */
const CSS_VAR_GAP = '--pop-gap'
const CSS_VAR_BREATH = '--pop-breath'
/** 可用高度的下限：再挤也要留住一点日历可见区（此时宁可横向被裁，也好过整个不可用） */
const POP_MIN_H = 180

/** 归档过滤：all=全部（含已归档） unarchived=仅未归档 archived=仅已归档 */
export type ArchivedFilter = 'all' | 'unarchived' | 'archived'

/** 归档三态（P10-A：把后端早已支持的 is_archived=false 一并接线出来） */
const ARCHIVED_OPTS: { key: ArchivedFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'unarchived', label: '仅未归档' },
  { key: 'archived', label: '仅已归档' },
]

interface Props {
  deletedOnly: boolean
  onDeletedToggle: () => void
  archived: ArchivedFilter
  onArchivedChange: (v: ArchivedFilter) => void
  /** 已应用的时间区间 */
  range: DateRange
  /** 点「确认」提交区间（含清空） */
  onRangeConfirm: (r: DateRange) => void
  /** 三项一并复位（由页面统一执行 → 只触发一次回顶） */
  onReset: () => void
  deletedCount: number
  archivedCount: number
}

/**
 * list 视图「筛选」下拉弹窗（P10-A）。
 *
 * 此前筛选行右侧是「时间钮 + 已删钮 + 已归档钮」三件并排（越挤越长，类型 chips 被迫换行），
 * 现收敛为**单钮 + 单弹窗**，三分区：
 *
 * - **状态**：已删（墓碑）—— 即时生效（沿用 §C3 侧栏筛选弹窗口径，不引入应用按钮）；
 * - **归档**：全部 / 仅未归档 / 仅已归档 —— 即时生效；
 * - **时间范围**：双月历区间选择器（`common/DateRangePicker`，草稿制 + 确认）；
 * - 底部 `重置`：三项一并复位。
 *
 * 弹窗规格走 UI-MAP §C6：12px 圆角 + 发丝边 + `--shadow-dialog` + `lc-dlg-pop` 0.16s +
 * **点外关闭 / Esc 双通道**；z-index 沿用锚定浮窗档 30。
 * 分组语言（`.pop-group` / `.pop-label` / `.pop-chips` / `.pop-actions`）与侧栏筛选弹窗同源。
 */
export default function PostFilterPop({
  deletedOnly,
  onDeletedToggle,
  archived,
  onArchivedChange,
  range,
  onRangeConfirm,
  onReset,
  deletedCount,
  archivedCount,
}: Props) {
  const [open, setOpen] = useState(false)
  /** 重置时强制重挂选择器：草稿/月份是组件内部态，不复位会留下「已重置但日历还亮着」的假象 */
  const [pickEpoch, setPickEpoch] = useState(0)
  /** 草稿区间文案：分组标题跟着**草稿**走（弹窗是草稿域；标题显示已应用值会与
   *  眼前高亮的区间打架——「近一月」亮着却写「全部时间」）。触发器的 `筛选 · N`
   *  才是已应用态的出口。 */
  const [draftText, setDraftText] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  /**
   * 弹窗高度上限 = **实测**「触发器下缘 → 面板下缘」的剩余空间。
   *
   * ⚠️ 为什么不是一条 CSS `max-height: calc(100vh - …)`（2026-09-24，R45-E 实测）：
   * 那条路上方要减掉的东西**是数据相关的，不是一个常数** ——
   *   · `.header-actions`（账号切换器行）**会换行**：8 个账号时它是 **2 行 68px**，
   *     2 个账号时是 1 行 30px；
   *   · `.chips-bar` 里的筛选行同样会换行（窄档 66px vs 宽档 25px）。
   * 探针实测（1100 档 + `--seed-accounts 8`）：弹窗顶落在面板内 **264px**、
   * 而手算的公式只减了 42+10+63 = 115px ⇒ 上限给到 349px，**弹窗底部越出面板 25px
   * 被 `.posts-panel` 的 `overflow:hidden` 裁掉**（`insidePanel=false` ×2 帧）。
   * 换句话说：**这个数没有"正确的常数"可写**，越往上加版式元素它越错。
   * ⇒ 改成量出来。触发器下缘与面板下缘都是现成的 rect，减一下就是真实可用高度；
   *   换行、窄档、窗口缩放全都自动跟上（下面挂了 ResizeObserver + resize）。
   *
   * ⚠️ `max-height` 仍然写在 CSS 里当**兜底**（首帧、JS 未跑时用），组件量到后覆盖为内联值。
   */
  useLayoutEffect(() => {
    if (!open) return
    const wrap = wrapRef.current
    const pop = popRef.current
    const panel = wrap?.closest<HTMLElement>('.posts-panel')
    if (!wrap || !pop || !panel) return
    const cs = getComputedStyle(pop)
    const readPx = (name: string, fallback: number) =>
      parseFloat(cs.getPropertyValue(name)) || fallback

    const fit = () => {
      const gap = readPx(CSS_VAR_GAP, 6)
      const breath = readPx(CSS_VAR_BREATH, 8)
      const avail = panel.getBoundingClientRect().bottom
        - wrap.getBoundingClientRect().bottom
        - gap
        - breath
      pop.style.maxHeight = `${Math.max(POP_MIN_H, Math.round(avail))}px`
    }

    fit()
    // 换行/缩放都会改可用高度：面板尺寸变、窗口尺寸变都要重量
    const ro = new ResizeObserver(fit)
    ro.observe(panel)
    ro.observe(wrap)
    window.addEventListener('resize', fit)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', fit)
      pop.style.maxHeight = ''
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 生效条件清单：既做触发器 active 判定，也做 tooltip 回显
  const applied: string[] = []
  if (deletedOnly) applied.push('仅已删')
  if (archived === 'unarchived') applied.push('仅未归档')
  if (archived === 'archived') applied.push('仅已归档')
  const appliedRange = rangeText(range)
  if (appliedRange) applied.push(appliedRange)
  const on = applied.length > 0

  return (
    <div className="pfilter-wrap" ref={wrapRef}>
      <FloatPill
        size="md"
        shape="text"
        active={on}
        className="pfilter-btn"
        title={on ? `筛选：${applied.join(' · ')}` : '筛选：已删 / 归档 / 时间范围'}
        onClick={() => setOpen((o) => !o)}
      >
        {/* 文案套一层 `.pf-label`：**左右对称留白**（见 posts.css 的说明）——
            文字因此落在浮片几何中心，同时把右上角 caret 的落脚区让出来 */}
        <span className="pf-label">{on ? `筛选 · ${applied.length}` : '筛选'}</span>
        <svg
          className="pill-caret"
          viewBox="0 0 6.63232 6.63232"
          width="6.632324"
          height="6.632324"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden
        >
          <path
            d="M5.96034 0.5L0.960327 0.500005L4.46033 5.5L5.96034 0.5Z"
            fill="currentColor"
            fillRule="evenodd"
          />
          <path
            d="M5.96034 0.5L4.46033 5.5L0.960327 0.500005L5.96034 0.5Z"
            fillRule="evenodd"
            stroke="currentColor"
            strokeWidth="1"
          />
        </svg>
      </FloatPill>

      {open && (
        <div className="post-filter-pop" ref={popRef}>
          {/* 三分区放进覆盖式滚动体：弹窗高度由上面那个 effect **实测**封顶
              （见它的注释）——窗口很矮时内部滚动，而不是被 .posts-panel 裁掉底部操作 */}
          <OverlayScroll className="pfilter-scroll">
            <div className="pop-group">
              <span className="pop-label">状态</span>
              <div className="pop-chips">
                <button
                  type="button"
                  className={`filter-chip${deletedOnly ? ' on' : ''}`}
                  title="仅显示已删除的帖子（墓碑，v0.5.1）"
                  onClick={onDeletedToggle}
                >
                  <Ghost className="size-3.5" />
                  已删 {deletedCount}
                </button>
              </div>
            </div>

            <div className="pop-group">
              <span className="pop-label">归档</span>
              <div className="pop-chips">
                {ARCHIVED_OPTS.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    className={`filter-chip${archived === o.key ? ' on' : ''}`}
                    title={
                      o.key === 'archived'
                        ? '仅显示已归档的帖子（早于归档截止日，不再参与追新）'
                        : o.key === 'unarchived'
                          ? '仅显示未归档的帖子（归档截止日之后的追新范围）'
                          : '全部（含已归档）'
                    }
                    onClick={() => onArchivedChange(o.key)}
                  >
                    {o.label}
                    {o.key === 'archived' ? ` ${archivedCount}` : ''}
                  </button>
                ))}
              </div>
            </div>

            <div className="pop-group">
              <span className="pop-label">
                时间范围
                <em className="pop-label-note">{draftText || '全部时间'}</em>
              </span>
              <DateRangePicker
                key={pickEpoch}
                value={range}
                onDraftChange={(r) => setDraftText(rangeText(r))}
                onConfirm={(r) => {
                  onRangeConfirm(r)
                  setOpen(false)
                }}
              />
            </div>
          </OverlayScroll>

          <div className="pop-actions">
            <button
              type="button"
              title="清空已删 / 归档 / 时间范围三项（含未确认的日历草稿）"
              onClick={() => {
                onReset()
                setDraftText('')
                setPickEpoch((e) => e + 1)
              }}
            >
              重置
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
