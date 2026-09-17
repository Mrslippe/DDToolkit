/**
 * 动效调测页（R37-P4b，规格 `docs/design-archive-cards.md` §5；用户 2026-09-18 拍板"加一个"）。
 *
 * 为什么需要它：动效的验收标准是"顺不顺"，而**"看着有点怪"没法举证** ——
 * 断言只证明"相位对了、缩放对了"，证明不了手感。这个面板做三件事：
 *   ① **单步触发**：按下 / 跟手 / 跨格 / 落位 各一个按钮，点一下走一步、停住；
 *   ② **慢放**：1× / 0.5× / 0.25×（改 `--motion-scale`，全站动效令牌都按它缩放）；
 *   ③ **跟手读数**：把"指针走了多少 / 卡片实际走了多少 / 差多少"直接写出来，不用靠眼睛估。
 *
 * 打开方式：`?motion=cards`（dev 构建；生产构建里这段被 `import.meta.env.DEV` 摇掉）。
 * ⚠️ 它派发的是**真实路径上的合成 PointerEvent**（与 `ui_probe.py --motion-cards` 同一套手势），
 * 所以"在这里能拖，实际就能拖"—— 不是另画一套假动画。
 *
 * 读数的口径：跟手正确时 **卡片视觉位移 ≡ 指针位移**（跨格也一样 —— 跟手算式把格子自身的
 * 位移减掉了，所以格子跳、卡片不跳）。误差列就是这条恒等式的偏差。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  /** 卡片画布的容器（与视图共用同一个 ref，量列宽用） */
  gridRef: React.RefObject<HTMLDivElement>
}

interface Snap {
  phase: string | null
  scale: number
  pointer: { x: number; y: number } | null
  visual: { x: number; y: number } | null
  error: { x: number; y: number } | null
}

const SPEEDS = [1, 0.5, 0.25]

export default function MotionLab({ gridRef }: Props) {
  const [open, setOpen] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [snap, setSnap] = useState<Snap>({
    phase: null, scale: 1, pointer: null, visual: null, error: null,
  })
  /** 按下时的指针位置 / 卡片中心（都是**起点**，读数全相对它们） */
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const centerRef = useRef<{ x: number; y: number } | null>(null)
  const curRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    setOpen(new URLSearchParams(window.location.search).get('motion') === 'cards')
  }, [])

  // 慢放：令牌全是 `calc(N * var(--motion-scale))`，改这一个变量即可（不动任何组件）
  useEffect(() => {
    if (!open) return
    document.documentElement.style.setProperty('--motion-scale', String(speed))
    return () => { document.documentElement.style.removeProperty('--motion-scale') }
  }, [open, speed])

  const card = () => document.querySelector<HTMLElement>('.pcard')
  const head = () => card()?.querySelector<HTMLElement>('.pcard-head') ?? null
  const centerOf = (el: HTMLElement | null) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }

  const read = useCallback(() => {
    const c = card()
    if (!c) return
    const t = getComputedStyle(c).transform
    const m = t && t !== 'none' ? t.match(/matrix\(([^)]+)\)/) : null
    const scale = m ? Math.round(parseFloat(m[1].split(',')[0]) * 1000) / 1000 : 1
    const s = startRef.current
    const c0 = centerRef.current
    const cur = curRef.current
    const now = centerOf(c)
    const pointer = s && cur ? { x: Math.round(cur.x - s.x), y: Math.round(cur.y - s.y) } : null
    const visual = c0 && now ? { x: Math.round(now.x - c0.x), y: Math.round(now.y - c0.y) } : null
    setSnap({
      phase: c.getAttribute('data-card-phase'),
      scale,
      pointer,
      visual,
      error: pointer && visual ? { x: visual.x - pointer.x, y: visual.y - pointer.y } : null,
    })
  }, [])

  // 轮询读数（100ms）：比在每个事件里手动刷新更不容易漏（相位变化也可能来自定时器）
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(read, 100)
    return () => window.clearInterval(id)
  }, [open, read])

  const at = (x: number, y: number, buttons = 1) => ({
    bubbles: true, cancelable: true, pointerId: 99, pointerType: 'mouse',
    isPrimary: true, button: 0, buttons, clientX: Math.round(x), clientY: Math.round(y),
  })

  /** 按下：起点 = 此刻的指针位置 + 卡片中心（中心要在缩放生效**之前**量） */
  const down = () => {
    const h = head()
    if (!h) return
    const r = h.getBoundingClientRect()
    const from = { x: r.left + 24, y: r.top + 10 }
    startRef.current = from
    curRef.current = from
    centerRef.current = centerOf(card())
    h.dispatchEvent(new PointerEvent('pointerdown', at(from.x, from.y)))
    window.setTimeout(read, 80)
  }

  /** 跟手：指针横向移动 `dx` 像素（只走横轴，好让"位移 = 指针位移"一眼能读） */
  const move = (dx: number) => {
    const g = gridRef.current
    const s = startRef.current
    if (!g || !s) return
    const next = { x: s.x + dx, y: s.y }
    curRef.current = next
    g.dispatchEvent(new PointerEvent('pointermove', at(next.x, next.y)))
    window.setTimeout(read, 140)
  }

  const up = () => {
    const g = gridRef.current
    const cur = curRef.current
    if (!g || !cur) return
    g.dispatchEvent(new PointerEvent('pointerup', at(cur.x, cur.y, 0)))
    window.setTimeout(read, 80)
  }

  const reset = () => {
    up()
    startRef.current = null
    curRef.current = null
    centerRef.current = null
    window.setTimeout(read, 420)
  }

  /** 连播：按下 → 等长按自动拾起 → 跟手 40 → 跨格 → 落位（慢放档下看得最清楚） */
  const playAll = async () => {
    down()
    await new Promise((r) => window.setTimeout(r, 520))
    move(40)
    await new Promise((r) => window.setTimeout(r, 300))
    move(140)
    await new Promise((r) => window.setTimeout(r, 300))
    up()
  }

  if (!open) return null

  const fmt = (p: { x: number; y: number } | null) => (p ? `(${p.x}, ${p.y})` : '—')

  return (
    <div className="mlab" data-motion-lab>
      <div className="mlab-head">
        <b>动效调测</b>
        <span className="mlab-note">
          ?motion=cards · 合成指针事件走真实手势路径 · 按下后**别动**，350ms 会自动拾起
        </span>
      </div>
      <div className="mlab-row">
        <span className="mlab-kv">相位 <b data-lab-phase>{snap.phase ?? '—'}</b></span>
        <span className="mlab-kv">缩放 <b>{snap.scale.toFixed(3)}</b></span>
        <span className="mlab-kv">指针位移 <b>{fmt(snap.pointer)}</b></span>
        <span className="mlab-kv">卡片位移 <b>{fmt(snap.visual)}</b></span>
        <span className="mlab-kv">
          跟手误差{' '}
          <b className={snap.error && (snap.error.x || snap.error.y) ? 'mlab-bad' : ''}>
            {fmt(snap.error)}
          </b>
        </span>
      </div>
      <div className="mlab-row">
        <button type="button" className="board-btn" onClick={down}>按下</button>
        <button type="button" className="board-btn" onClick={() => move(30)}>跟手 +30</button>
        <button type="button" className="board-btn" onClick={() => move(90)}>跨格 +90</button>
        <button type="button" className="board-btn" onClick={up}>落位</button>
        <button type="button" className="board-btn" onClick={() => void playAll()}>连播一遍</button>
        <button type="button" className="board-btn" onClick={reset}>复位</button>
      </div>
      <div className="mlab-row">
        <span className="mlab-kv">慢放</span>
        {SPEEDS.map((s) => (
          <button key={s} type="button"
                  className={`board-btn${speed === s ? ' on' : ''}`}
                  onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
        <span className="mlab-note">
          {speed === 1 ? '（令牌 = calc(N × 1)）' : `（动效时长 ×${1 / speed}，位移与比例不变）`}
        </span>
      </div>
    </div>
  )
}
