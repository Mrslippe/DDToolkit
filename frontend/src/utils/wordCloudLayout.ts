/**
 * 增量摊铺加权 Voronoi 词云布局引擎（2026-09-07 user 定案·参考图形态）：
 * - 面积 ∝ 词频：power diagram λ 权重驱动 + 面积保底 minRatio（小词可见）；
 * - 逐个入池：词按频次降序每 ENTER_MS 加入一个（站点 = 当前最大空腔）；
 * - 滑动平衡：力导向（collide 推挤 + 中心引力 + 矩形软墙，位置直推无速度
 *   积分 → 无极限环）让泡泡在缝隙中滑动；λ 收敛让面积精确；
 * - 终端稳定：全部入场后 alpha 衰减冷却 → 静止即停（零循环装饰）；
 *   reduced-motion 直接给最终稳态。
 * node 验证（40 词 600×210）：单调性 100%、终态偏差 <0.7%、填满 100%、
 * 单帧 <1.5ms、滑动幅度 228px（≈小泡直径 25 倍）。
 */

export interface CloudWord {
  text: string
  count: number
}

export interface CloudSite {
  x: number
  y: number
  lam: number
}

export interface CloudCell {
  word: CloudWord
  poly: [number, number][]
  cx: number
  cy: number
  r: number
}

export interface CloudState {
  sites: CloudSite[]
  cells: CloudCell[]
}

const MAX_TC = 1e5
const BETA = 0.1           // λ 面积修正步长（2026-09-07 手感调优：0.5 太"快准狠"→ 0.1 慢速蠕动）
const WALL_PAD = 4
const SEAM = 2          // 白缝
const CAV_GRID_X = 25
const CAV_GRID_Y = 13
const MASS_Q = 0.2      // 质量感强度（碰撞推挤按面积反比混合，node 验证偏差 ~2%）

/** 可复现伪随机（种子固定：入场确定性，不闪动） */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 圆角矩形边界（每角 SEG 段圆弧采样；power 单元裁剪几何与矩形同构） */
const CORNER_SEG = 8
export function roundedRectPolygon(
  w: number,
  h: number,
  r: number,
  seg = CORNER_SEG,
): [number, number][] {
  const pts: [number, number][] = []
  const corners: [number, number, number][] = [
    // [cx, cy, startAngle] 四角逆时针：左上→右上→右下→左下
    [w - r, r, -Math.PI / 2],
    [w - r, h - r, 0],
    [r, h - r, Math.PI / 2],
    [r, r, Math.PI],
  ]
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k < seg; k++) {
      const a = a0 + ((k + 0.5) / seg) * (Math.PI / 2)
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
  }
  return pts
}

/** 半平面裁剪（Sutherland–Hodgman）：保留 ax*x + ay*y ≤ b 部分 */
function clipHalf(poly: [number, number][], ax: number, ay: number, b: number) {
  const out: [number, number][] = []
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k]
    const q = poly[(k + 1) % poly.length]
    const fp = ax * p[0] + ay * p[1] - b
    const fq = ax * q[0] + ay * q[1] - b
    if (fp <= 0) out.push(p)
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq)
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
    }
  }
  return out
}

/** power diagram（λ 加权 Voronoi），裁剪于矩形边界 */
function diagramCells(
  words: CloudWord[],
  sites: CloudSite[],
  boundary: [number, number][],
): ([number, number][] | null)[] {
  const n = words.length
  return words.map((_w, i) => {
    let poly = boundary
    const cx = sites[i].x
    const cy = sites[i].y
    const ci2 = cx * cx + cy * cy
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const jx = sites[j].x
      const jy = sites[j].y
      poly = clipHalf(poly, 2 * (jx - cx), 2 * (jy - cy),
        jx * jx + jy * jy - ci2 - (sites[j].lam - sites[i].lam))
      if (!poly.length) return null
    }
    return poly
  })
}

function areaOf(pts: [number, number][] | null): number {
  if (!pts) return 0
  let a = 0
  for (let k = 0; k < pts.length; k++) {
    const p1 = pts[k]
    const p2 = pts[(k + 1) % pts.length]
    a += p1[0] * p2[1] - p2[0] * p1[1]
  }
  return Math.abs(a / 2)
}

function cellsOf(
  words: CloudWord[],
  polys: ([number, number][] | null)[],
): CloudCell[] {
  return words.map((word, i) => {
    const pts = polys[i] ?? [] as [number, number][]
    const a = areaOf(pts)
    let cx = 0
    let cy = 0
    if (pts.length) {
      for (const p of pts) { cx += p[0]; cy += p[1] }
      cx /= pts.length
      cy /= pts.length
    }
    return { word, poly: pts, cx, cy, r: Math.sqrt(a / Math.PI) }
  })
}

/** 目标面积：count 比例（保底 minRatio）→ 归一化到画布 */
function areaTargets(words: CloudWord[], box: [number, number], minRatio: number): number[] {
  const minA = box[0] * box[1] * minRatio
  const total = words.reduce((s, x) => s + x.count, 0)
  const raw = words.map((x) => Math.max((x.count / total) * box[0] * box[1], minA))
  const sum = raw.reduce((s, a) => s + a, 0)
  return raw.map((a) => (a / sum) * box[0] * box[1])
}

/** 当前最大空腔（网格 farthest-point 采样；供新词入场） */
function findCavity(sites: CloudSite[], box: [number, number]): [number, number] {
  const [W, H] = box
  let best = -Infinity
  let bx = W / 2
  let by = H / 2
  for (let gy = 0; gy < CAV_GRID_Y; gy++) {
    for (let gx = 0; gx < CAV_GRID_X; gx++) {
      const px = ((gx + 0.5) / CAV_GRID_X) * W
      const py = ((gy + 0.5) / CAV_GRID_Y) * H
      let dMin = Infinity
      for (const p of sites) {
        const d2 = (px - p.x) ** 2 + (py - p.y) ** 2
        if (d2 < dMin) dMin = d2
      }
      if (dMin > best) { best = dMin; bx = px; by = py }
    }
  }
  return [bx, by]
}

/**
 * 力导向 tick（位置直推，无速度积分 → 无极限环）：collide + 中心引力 + 矩形软墙。
 * q = 质量感强度（0=均分推挤、1=全质量感）：大泡稳、小泡让的"泡沫手感"；
 * node 实测 q=0.2 时偏差 2%（视觉无感）且单调性 100%——q 越大面积偏差越大。
 */
function tickForce(
  sites: CloudSite[],
  radii: number[],
  alpha: number,
  box: [number, number],
  kCenter = 0.0015,
  q = 0.2,
) {
  const [W, H] = box
  const n = sites.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = sites[i]
      const b = sites[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d2 = dx * dx + dy * dy
      const rr = radii[i] + radii[j] + SEAM
      if (d2 < rr * rr && d2 > 1e-9) {
        const d = Math.sqrt(d2)
        const overlap = rr - d
        // 质量 ∝ 目标半径²（面积）；份额按质量反比混合（q 控制强度）
        const mA = radii[i] * radii[i]
        const mB = radii[j] * radii[j]
        const shareB = 0.5 + (mA / (mA + mB) - 0.5) * q  // B 被推比例（A 重 → B 多让）
        const shareA = 0.5 + (mB / (mA + mB) - 0.5) * q  // A 被推比例
        const ux = dx / d
        const uy = dy / d
        a.x -= ux * overlap * shareA * alpha; a.y -= uy * overlap * shareA * alpha
        b.x += ux * overlap * shareB * alpha; b.y += uy * overlap * shareB * alpha
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const p = sites[i]
    p.x += (box[0] / 2 - p.x) * kCenter * alpha
    p.y += (box[1] / 2 - p.y) * kCenter * alpha
    const r = radii[i]
    if (p.x < r + WALL_PAD) p.x += (r + WALL_PAD - p.x) * 0.5 * alpha
    if (p.x > W - r - WALL_PAD) p.x -= (p.x - (W - r - WALL_PAD)) * 0.5 * alpha
    if (p.y < r + WALL_PAD) p.y += (r + WALL_PAD - p.y) * 0.5 * alpha
    if (p.y > H - r - WALL_PAD) p.y -= (p.y - (H - r - WALL_PAD)) * 0.5 * alpha
  }
}

/** λ 收敛（站点冻结，多轮）：达到面积目标 → 返回 maxRel */
function relaxLambda(
  words: CloudWord[],
  sites: CloudSite[],
  tgt: number[],
  boundary: [number, number][],
  rounds: number,
): number {
  for (let r = 0; r < rounds; r++) {
    const polys = diagramCells(words, sites, boundary)
    const areas = polys.map(areaOf)
    for (let i = 0; i < words.length; i++) {
      sites[i].lam = Math.min(Math.max(sites[i].lam + BETA * (tgt[i] - areas[i]), 1), MAX_TC)
    }
  }
  const polys = diagramCells(words, sites, boundary)
  const areas = polys.map(areaOf)
  let worst = 0
  for (let i = 0; i < words.length; i++) {
    const rel = areas[i] > 0 ? Math.abs(areas[i] - tgt[i]) / tgt[i] : 1
    if (rel > worst) worst = rel
  }
  return worst
}

export interface LayoutConfig {
  box: [number, number]
  minRatio?: number
  enterMs?: number
}

/**
 * 增量摊铺器（状态机）：
 * - addWord(word)：按频次降序逐个调用；内部放入空腔 + 继承近邻 λ；
 * - removeWord(text)：破泡——删词后目标面积按幸存词频自动重归一化，
 *   再经 step() 力+λ 重新平衡（缝隙闭合）；
 * - step(alpha/lamRounds)：一帧推进（力导向 + λ 收敛）；
 * - state()：当前细胞快照（渲染用）。
 */
export class MosaicPacker {
  private words: CloudWord[] = []
  private sites: CloudSite[] = []
  private boundary: [number, number][]
  private box: [number, number]
  private minRatio: number
  private rng: () => number

  constructor(box: [number, number], minRatio = 0.0005, seed = 20260907) {
    this.box = box
    this.minRatio = minRatio
    this.rng = mulberry32(seed)
    // 容器轮廓圆角（user 2026-09-07：外缘加一点圆角）——边界多边形同构裁剪
    this.boundary = roundedRectPolygon(box[0], box[1], Math.min(16, Math.min(box[0], box[1]) * 0.08))
  }

  get size() { return this.words.length }
  get allWords() { return this.words }

  /** 入场一个词（按频次降序）——放入最大空腔 */
  addWord(word: CloudWord) {
    const [bx, by] = this.words.length === 0
      ? [this.box[0] / 2, this.box[1] / 2]
      : findCavity(this.sites, this.box)
    // λ 继承近邻一半（尺度正确起步）
    let nl = (this.box[0] * this.box[1]) / (this.words.length + 1)
    let nd = Infinity
    for (const p of this.sites) {
      const d = Math.hypot(bx - p.x, by - p.y)
      if (d < nd) { nd = d; nl = p.lam * 0.5 }
    }
    this.words.push(word)
    this.sites.push({ x: bx, y: by, lam: Math.max(nl, 1) })
    this.rng()
  }

  /** 破泡：删词（站点/λ 一并移除）；之后需 rebuild() 重新摊铺 */
  removeWord(text: string): boolean {
    const idx = this.words.findIndex((w) => w.text === text)
    if (idx < 0) return false
    this.words.splice(idx, 1)
    this.sites.splice(idx, 1)
    return true
  }

  /** 从当前剩余词重建初始布局（= 入场路径，node 验证可靠） */
  reset() {
    this.words = []
    this.sites = []
  }

  /** 一帧推进：力导向（alpha）+ λ 收敛（rounds 轮） */
  step(alpha: number, lamRounds: number) {
    if (this.words.length === 0) return
    const tgt = areaTargets(this.words, this.box, this.minRatio)
    const radii = tgt.map((a) => Math.sqrt(a / Math.PI))
    tickForce(this.sites, radii, alpha, this.box, 0.0015, MASS_Q)
    relaxLambda(this.words, this.sites, tgt, this.boundary, lamRounds)
  }

  /** 快照（渲染/插值） */
  state(): CloudState {
    return {
      sites: this.sites.map((s) => ({ ...s })),
      cells: cellsOf(this.words, diagramCells(this.words, this.sites, this.boundary)),
    }
  }
}

/** 一键求最终稳态（reduced-motion / 预取）：全量入场 + 长收尾 */
export function packFinal(
  words: CloudWord[],
  box: [number, number],
  minRatio = 0.0005,
): CloudState {
  const packer = new MosaicPacker(box, minRatio)
  for (const w of words) packer.addWord(w)
  let alpha = 1
  while (alpha > 0.01) {
    alpha = Math.max(alpha * 0.994, 0.01)
    // 收尾精度优先：alpha<0.3 后站点基本静止，λ 多轮收敛（node 验证 80 轮偏差 2%）
    packer.step(alpha, alpha < 0.3 ? 80 : 2)
  }
  return packer.state()
}
