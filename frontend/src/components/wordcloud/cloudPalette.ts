/**
 * 词云配色（P2 分层收敛 A-1 从 `LiveCalendar.tsx` 原样搬出，**只搬不改**）。
 *
 * 规则（user 2026-09-07）：填充浅色、文字同色系深色；按词哈希取色 → 同一个词
 * 在任何场次/任何重排下颜色恒定，不随词序闪动。
 *
 * ⚠️ 本文件与 `utils/wordCloudLayout.ts` 同属「词云算法族」，受 `FRONTEND-ARCH.md §7`
 * 红线约束：**只搬不改**。搬动前后由 `scripts/check_wordcloud_layout.mjs`
 * 的 sha256 基线（覆盖 `MosaicPacker`/`packFinal`）与 `format`/`wordCloudLayout`
 * 的 vitest 断言看住；配色函数本身是纯函数，改动会直接反映在断言里。
 */

/** 词云配色（浅色填充——user 2026-09-07：填充浅色、文字同色系深色；按词哈希取色稳定） */
export const CLOUD_COLORS = ['#ffc9c4', '#a5e6ff', '#dccff7', '#bee9ec', '#ffd5b8',
  '#fff2a0', '#fda5ff', '#b2f3c0', '#ffdfe8', '#d8e8ff']

export function hashOf(text: string): number {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 997
  return h
}

/** 填充色（浅） */
export function cloudWordColor(w: { text: string }): string {
  return CLOUD_COLORS[hashOf(w.text) % CLOUD_COLORS.length]
}

/** 同色系深色（文字用）：HSL 压暗同色相 */
export function cloudWordText(w: { text: string }): string {
  const hex = cloudWordColor(w)
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  const [h, s] = rgbToHsl(r, g, b)
  return hslToHex(h, Math.min(s, 0.9), 0.28)
}

/** rgb(0-255) → [h(0-360), s(0-1)] */
export function rgbToHsl(r: number, g: number, b: number): [number, number] {
  const rr = r / 255, gg = g / 255, bb = b / 255
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  if (max === min) return [0, 0]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0))
  else if (max === gg) h = ((bb - rr) / d + 2)
  else h = ((rr - gg) / d + 4)
  return [h * 60, s]
}

/** h(0-360), s(0-1), l(0-1) → hex */
export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let rr = 0, gg = 0, bb = 0
  if (h < 60) { rr = c; gg = x }
  else if (h < 120) { rr = x; gg = c }
  else if (h < 180) { gg = c; bb = x }
  else if (h < 240) { gg = x; bb = c }
  else if (h < 300) { rr = x; bb = c }
  else { rr = c; bb = x }
  const to2 = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${to2(rr)}${to2(gg)}${to2(bb)}`
}
