import type { ResultTab } from './ResultCharts'

const TABS: { key: ResultTab; label: string }[] = [
  { key: 'overview', label: '总览' },
  { key: 'attendance', label: '出席' },
  { key: 'interaction', label: '互动' },
  { key: 'payment', label: '付费' },
]

interface Props {
  value: ResultTab
  onChange: (t: ResultTab) => void
}

/**
 * 结果区的页签（2026-10-23）。
 *
 * 视觉：选中 = 深粉文字 + 2px 下划线；未选中 = 灰字。**不用彩色大标签** ——
 * 那会和图表的粉阶抢注意力，也不符合现有粉白体系。
 */
export default function ResultTabs({ value, onChange }: Props) {
  return (
    <div className="wb-tabs" role="tablist" aria-label="结果维度" data-testid="result-tabs">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          className={`wb-tab${value === t.key ? ' is-active' : ''}`}
          data-testid={`tab-${t.key}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
