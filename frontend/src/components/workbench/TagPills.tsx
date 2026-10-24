import { useState } from 'react'

interface Props {
  tags: string[]
  /** 单行最多显示几个（默认 5），超出收进下拉 */
  max?: number
}

/** 标签色板：按字符串哈希取色，同一个标签永远同一色 */
const TONES = [
  { bg: 'rgba(201,64,111,0.10)', fg: '#b23a63' },   // 深粉
  { bg: 'rgba(124,147,181,0.14)', fg: '#3d5573' },  // 藏青
  { bg: 'rgba(252,112,121,0.12)', fg: '#b2353c' },  // 珊瑚
  { bg: 'rgba(148,163,184,0.16)', fg: '#4b5a6b' },  // 灰
  { bg: 'rgba(251,119,161,0.12)', fg: '#a83262' },  // 粉
]

function tone(tag: string) {
  let h = 0
  for (let i = 0; i < tag.length; i += 1) h = (h * 31 + tag.charCodeAt(i)) >>> 0
  return TONES[h % TONES.length]
}

/**
 * 标签胶囊（2026-10-24）：不同标签不同色；**不换行**，超出的收进一个「+N」。
 *
 * 用 CSS hover 展开（`:hover` + `:focus-within`），不引入 Popover 依赖 ——
 * 名单每行都挂一个弹层组件代价太大。
 */
export default function TagPills({ tags, max = 5 }: Props) {
  const [open, setOpen] = useState(false)      // 仅供键盘/触屏兜底
  if (!tags.length) return <span className="wb-tag-empty">—</span>
  const shown = tags.slice(0, max)
  const rest = tags.slice(max)

  return (
    <span className={`wb-tags${open ? ' is-open' : ''}`} onMouseLeave={() => setOpen(false)}>
      {shown.map((t) => {
        const c = tone(t)
        return (
          <span key={t} className="wb-tag" style={{ background: c.bg, color: c.fg }}>{t}</span>
        )
      })}
      {rest.length > 0 && (
        <span className="wb-tag-more-wrap">
          <button
            type="button"
            className="wb-tag wb-tag-more"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            +{rest.length}
          </button>
          <span className="wb-tag-pop" role="tooltip">
            {rest.map((t) => {
              const c = tone(t)
              return (
                <span key={t} className="wb-tag" style={{ background: c.bg, color: c.fg }}>{t}</span>
              )
            })}
          </span>
        </span>
      )}
    </span>
  )
}
