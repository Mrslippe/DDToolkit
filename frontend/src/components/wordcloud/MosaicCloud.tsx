/**
 * 增量摊铺拼贴词云（P2 分层收敛 A-1：从 `LiveCalendar.tsx` 整块搬出，**只搬不改**）。
 *
 * ① 面积 ∝ 词频：power diagram λ 驱动（力导向站点滑动 + λ 面积收敛，见 `utils/wordCloudLayout.ts`）；
 * ② 逐个入池：词按频次降序每 150ms 入场（放当前最大空腔），泡泡在缝隙中滑动、逐渐平衡；
 * ③ 终端稳定：全部入场后 alpha 冷却 → 静止即停（无循环装饰）；reduced-motion 直接终态；
 * ④ 破泡：点击词 → 删词 → 幸存词面积按词频重归一化 → 力+λ 重新平衡闭合；
 *    段头「已破泡 N · 恢复」胶囊由父级渲染（`onPoppedChange` / `restoreTick` 联动）。
 *
 * 容器宽度运行时测量（ResizeObserver），高度由 `boxH` 决定（详情弹窗传 210）。
 *
 * ⚠️ 红线（`FRONTEND-ARCH.md §7`）：本组件承载词云算法族，参数与节拍
 * （150ms 入场、α=0.994 入场冷却、破泡 α=0.15 起步 + 0.997 冷却 + λ 8 轮 + `kCenter=0`、
 * 静止阈值 0.05）**不得在搬动中改动**。算法侧由 `scripts/check_wordcloud_layout.mjs`
 * 的 sha256 基线 + `utils/wordCloudLayout.test.ts` 看住；组件侧的 rAF/ResizeObserver
 * 属交互层，只能靠 `scripts/ui_probe.py --archive`（实渲染 dump）与肉眼确认。
 *
 * CSS 约定：样式仍在 `styles/posts.css`（`.lc-dlg-cloud*` 家族）——
 * 按 A 路线决策「CSS 归属保持不动」，避免动到探针的选择器世界。
 */
import { useEffect, useRef, useState } from 'react'

import type { CloudCell, CloudWord } from '../../utils/wordCloudLayout'
import { MosaicPacker } from '../../utils/wordCloudLayout'
import { cloudWordColor, cloudWordText } from './cloudPalette'

export default function MosaicCloud({
  data,
  boxH,
  restoreTick = 0,
  onPoppedChange,
}: {
  data: CloudWord[]
  boxH: number
  restoreTick?: number
  onPoppedChange?: (n: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 560, h: boxH })
  const [snap, setSnap] = useState<{ cells: CloudCell[] } | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string; count: number } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const packerRef = useRef<MosaicPacker | null>(null)
  /** 当前活跃 rAF id（入场/破泡共用一个槽；重建时取消旧的） */
  const rafRef = useRef(0)
  const dataRef = useRef(data)
  dataRef.current = data
  const poppedRef = useRef(0)

  // 宽度自适应：容器实际宽度（user 2026-09-07：池子宽度不对 → 实测）
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((es) => {
      const w = Math.round(es[0]?.contentRect.width ?? 0)
      if (w > 80) setSize((s) => (s.w === w ? s : { ...s, w }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** 重建并启动入场动画（data/尺寸/恢复信号变化时） */
  const start = (words: CloudWord[], w: number, h: number) => {
    cancelAnimationFrame(rafRef.current)
    if (words.length === 0) {
      packerRef.current = null
      setSnap(null)
      poppedRef.current = 0
      onPoppedChange?.(0)
      return
    }
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const packer = new MosaicPacker([w, h])
    packerRef.current = packer
    let raf = 0
    let alive = true
    let next = 0
    const held = words.slice()
    let entered = 0
    let alpha = 1
    if (reduceMotion) {
      // 直接最终稳态（插入全部词后长收尾，不播动画）
      for (const wd of held) packer.addWord(wd)
      while (alpha > 0.01) {
        alpha = Math.max(alpha * 0.994, 0.01)
        packer.step(alpha, alpha < 0.3 ? 80 : 2)
      }
      setSnap(packer.state())
      poppedRef.current = 0
      onPoppedChange?.(0)
      return
    }
    const loop = (tNow: number) => {
      if (!alive) return
      while (entered < held.length && next <= tNow) {
        packer.addWord(held[entered])
        entered++
        next += 150
      }
      if (entered < held.length) {
        alpha = 1
      } else {
        alpha = Math.max(alpha * 0.994, 0.01)
      }
      let rounds = entered < held.length ? 1 : 2
      if (entered >= held.length && alpha < 0.3) rounds = 20
      packer.step(alpha, rounds)
      setSnap(packer.state())
      if (entered >= held.length && alpha <= 0.05) return   // 静止即停
      raf = requestAnimationFrame(loop)
      rafRef.current = raf
    }
    raf = requestAnimationFrame(loop)
    rafRef.current = raf
    poppedRef.current = 0
    onPoppedChange?.(0)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      if (packerRef.current === packer) packerRef.current = null
    }
  }

  // 数据/尺寸变化 → 重排
  useEffect(() => {
    const words = dataRef.current
    if (words.length === 0) {
      setSnap(null)
      packerRef.current = null
      return
    }
    return start(words, size.w, size.h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, size.w, size.h])

  // 恢复信号（父级「已破泡 N · 恢复」按钮）→ 重建初始布局
  useEffect(() => {
    if (!restoreTick) return
    const words = dataRef.current
    if (words.length > 0) {
      packerRef.current = null
      const cleanup = start(words, size.w, size.h)
      if (typeof cleanup === 'function') return cleanup
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreTick])

  /**
   * 破泡 = 局部闭合（node 验证：缺口填充 2 词、远处位移 avg 6.5px/max 16px、
   * 偏差 15%、单调 100%）：
   * 1. 删词（站点/λ 移除）——对应 cell **立即消失**，缺口出现（无卡顿：纯同步删）；
   * 2. rAF 局部松弛：α=0.15 起步（力场几乎不动）+ kCenter=0（停中心引力）——
   *    λ 修正把缺口面积重新分配给相邻 cell（power 边界自动"鼓胀"塞住缺口），
   *    站点只极轻微挪动（视觉上邻泡"挤入"缺口）——远处纹丝不动；
   * 3. α 渐冷至 0.05 停止（静止即停）。
   * 节奏（user 2026-09-07 反馈"慢一点"）：λ 8 轮/帧（原 20，每帧鼓胀 40% 速度）、
   *    α 0.997 冷却（原 0.994）——填充过程 ~3.5s 渐显，可看清邻泡缓缓鼓起封缺口。
   */
  const popWord = (text: string) => {
    const p = packerRef.current
    if (!p || p.size === 0) return
    if (!p.removeWord(text)) return
    poppedRef.current += 1
    onPoppedChange?.(poppedRef.current)
    if (p.size === 0) {
      setSnap({ cells: [] })
      return
    }
    // 立即反映（词消失、缺口出现）
    setSnap(p.state())
    // 局部松弛循环
    cancelAnimationFrame(rafRef.current)
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (reduceMotion) {
      let alpha = 0.15
      while (alpha > 0.05) {
        alpha = Math.max(alpha * 0.997, 0.05)
        p.step(alpha, alpha < 0.3 ? 8 : 2, 0)
      }
      setSnap(p.state())
      return
    }
    let alpha = 0.15
    let alive = true
    const loop = () => {
      if (!alive) return
      alpha = Math.max(alpha * 0.997, 0.05)
      // 站点几乎不动：α 0.15 起步（力微扰）；kCenter=0（停中心引力拖拽）
      p.step(alpha, alpha < 0.3 ? 8 : 2, 0)
      setSnap(p.state())
      if (alpha <= 0.05) return   // 静止即停
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
  }

  return (
    <div ref={ref} className="lc-dlg-cloud">
      {snap && snap.cells.length > 0 && (
        /* Q2（批次 14，devlog/217）：SVG 里的词是**绘制**出来的，读屏默认只念个"图形"；
           补 `role=img` + 一句话摘要（前 8 个词），让它至少"说得出是什么"。 */
        <svg
          width={size.w}
          height={size.h}
          className="lc-dlg-cloud-svg"
          role="img"
          aria-label={`本场弹幕词云（前 ${Math.min(8, snap.cells.length)} 个词：${
            snap.cells.slice(0, 8).map((c) => c.word.text).join('、')
          }）`}
        >
          {snap.cells.map((c) => {
            const { word, poly, cx, cy, r } = c
            const d = poly.length
              ? `M${poly.map(([x, y]) => `${x - cx},${y - cy}`).join('L')}Z`
              : ''
            const fs = Math.max(8.5, Math.min(26, r * 0.8, (r * 2.2) / Math.max(2, word.text.length)))
            const showText = r > 9 && word.text.length <= 6 && fs >= 8.5
            const hovered = hover === word.text
            const dimmed = hover !== null && !hovered
            return (
              <g
                key={word.text}
                className="lc-dlg-cloud-cell"
                style={{ transform: `translate(${cx}px, ${cy}px)` }}
                onMouseEnter={(e) => {
                  setHover(word.text)
                  setTip({ x: e.clientX, y: e.clientY, text: word.text, count: word.count })
                }}
                onMouseMove={(e) =>
                  setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))}
                onMouseLeave={() => {
                  setHover(null)
                  setTip(null)
                }}
                onClick={() => popWord(word.text)}
              >
                <path
                  d={d}
                  fill={cloudWordColor(word)}
                  fillOpacity={hovered ? 1 : dimmed ? 0.4 : 0.92}
                  stroke="var(--c-bg-card)"
                  strokeWidth={2}
                />
                {showText && (
                  <text
                    x={0}
                    y={0}
                    textAnchor="middle"
                    dy="0.35em"
                    fontSize={fs}
                    fill={cloudWordText(word)}
                    fontWeight={hovered ? 700 : 600}
                    opacity={dimmed ? 0.25 : 1}
                    pointerEvents="none"
                  >
                    {word.text}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}
      {snap && snap.cells.length === 0 && (
        <div className="lc-dlg-ph">已全部破泡（点击「恢复」还原）</div>
      )}
      {tip && (
        <span className="lc-dlg-cloud-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text} · {tip.count.toLocaleString('zh-CN')} 次
        </span>
      )}
    </div>
  )
}
