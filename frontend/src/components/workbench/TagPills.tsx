import { useState } from 'react'
import ProxyImage from '../common/ProxyImage'

interface Props {
  tags: string[]
  /** 单行最多显示几个（默认 5），超出收进下拉 */
  max?: number
}

/** B 站大航海图标（官方图床，经后端 `/img-proxy` 代理并缓存） */
const GUARD_ICON: Record<string, string> = {
  总督: 'https://i1.hdslb.com/bfs/live/bf4f5ea4b54ca7bb358dec4e6c4afcc300c12eb9.png',
  提督: 'https://i1.hdslb.com/bfs/live/62ac06fd72b05fe22be26426b9e1a8e1fc2c6b89.png',
  舰长: 'https://i1.hdslb.com/bfs/live/48360c8f3b7de8031e86ff1ef4a2dfc0ec2a61c2.png',
}

/** 每个标签一套固定配色（2026-10-24 用户指定 + 自选） */
const STYLE: Record<string, { bg: string; fg: string }> = {
  舰长: { bg: 'rgba(59,130,246,0.12)', fg: '#1d63c9' },
  提督: { bg: 'rgba(124,58,237,0.12)', fg: '#6d28d9' },
  总督: { bg: 'rgba(220,38,38,0.12)', fg: '#b91c1c' },
  黑听民: { bg: 'rgba(148,163,184,0.18)', fg: '#4b5563' },                    // 灰
  互动民: { bg: '#ffffff', fg: '#5b6c7e' },  // 白/浅
  老头: { bg: 'rgba(234,179,8,0.16)', fg: '#a16207' },                        // 金
  sc民: { bg: 'rgba(14,165,233,0.14)', fg: '#0369a1' },                       // 蓝
  全勤: { bg: 'rgba(201,64,111,0.12)', fg: '#b23a63' },                       // 品牌深粉
  新人: { bg: 'rgba(16,185,129,0.14)', fg: '#047857' },                       // 绿
  独轮车: { bg: 'rgba(252,112,121,0.14)', fg: '#b2353c' },                    // 珊瑚
}

const FALLBACK = { bg: 'rgba(148,163,184,0.14)', fg: '#4b5a6b' }

function pillStyle(tag: string): React.CSSProperties {
  const c = STYLE[tag] ?? FALLBACK
  // 无描边、浅阴影的「浮片」语义（2026-10-24 用户定）：靠阴影分层，不靠边框
  return { background: c.bg, color: c.fg }
}

/** 单个标签胶囊；大航海三档带官方图标 */
function Pill({ tag }: { tag: string }) {
  const icon = GUARD_ICON[tag]
  return (
    <span className="wb-tag" style={pillStyle(tag)}>
      {icon && (
        <ProxyImage
          src={icon}
          className="wb-tag-icon"
          width={13}
          height={13}
          alt=""
        />
      )}
      {tag}
    </span>
  )
}

/**
 * 标签胶囊（2026-10-24 改版）：**每个标签固定配色**，大航海三档带官方图标。
 *
 * 不换行；超过 `max`（默认 5）收进「+N」，hover / 聚焦 / 点击都能展开。
 * 配色表在 `STYLE` 里 —— 以后改颜色只改那一处。
 */
export default function TagPills({ tags, max = 5 }: Props) {
  const [open, setOpen] = useState(false)
  if (!tags.length) return <span className="wb-tag-empty">—</span>
  const shown = tags.slice(0, max)
  const rest = tags.slice(max)

  return (
    <span className={`wb-tags${open ? ' is-open' : ''}`} onMouseLeave={() => setOpen(false)}>
      {shown.map((t) => <Pill key={t} tag={t} />)}
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
            {rest.map((t) => <Pill key={t} tag={t} />)}
          </span>
        </span>
      )}
    </span>
  )
}
