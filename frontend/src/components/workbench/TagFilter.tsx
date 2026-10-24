import { useEffect, useRef, useState } from 'react'
import { Filter } from 'lucide-react'

interface Props {
  /** 可选的标签清单（来自 /fan/{v}/tags） */
  tags: { name: string; prevalence: number }[]
  value: string[]
  loading?: boolean
  error?: string | null
  onChange: (next: string[]) => void
}

/**
 * 标签筛选（2026-10-24）：搜索框右侧的按钮 + 勾选弹层。
 *
 * 语义是**与**：选「舰长 + 老头」= 既是舰长又是老头（后端 `tags` 参数按 AND 过滤）。
 * 弹层点外部关闭；「清除」一键复位。
 */
export default function TagFilter({ tags, loading, error, value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const toggle = (name: string) => {
    onChange(value.includes(name) ? value.filter((t) => t !== name) : [...value, name])
  }

  return (
    <div className="wb-tagfilter" ref={box}>
      <button
        type="button"
        className={`wb-tagfilter-btn${value.length ? ' is-on' : ''}`}
        data-testid="tag-filter"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Filter className="size-3.5" />
        标签{value.length ? ` · ${value.length}` : ''}
      </button>

      {open && (
        <div className="wb-tagfilter-pop" data-testid="tag-filter-pop">
          {loading && <p className="wb-search-empty">加载中…</p>}
          {!loading && error && <p className="wb-search-empty">取不到标签：{error}</p>}
          {!loading && !error && tags.length === 0 && (
            <p className="wb-search-empty">还没有标签数据</p>
          )}
          {tags.map((t) => (
            <label key={t.name} className="wb-tagfilter-row">
              <input
                type="checkbox"
                checked={value.includes(t.name)}
                onChange={() => toggle(t.name)}
              />
              <span>{t.name}</span>
              <span className="wb-tagfilter-pct">{(t.prevalence * 100).toFixed(1)}%</span>
            </label>
          ))}
          {value.length > 0 && (
            <button type="button" className="wb-tagfilter-clear" onClick={() => onChange([])}>
              清除筛选
            </button>
          )}
        </div>
      )}
    </div>
  )
}
