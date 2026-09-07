// ── 破泡最终方案验证：删词 → 从空重建（入场路径，已验证可靠）──
// 用户观感：破泡后泡泡从当前形态"滑"到新稳态 = 组件层同构插值
// 引擎层只保证：重建后面积∝词频 + 填满 + 单调（入场路径已知为真）
// 这里验证的其实是「50 词以内的重建路径依然成立」——直接复用初态逻辑

const W = 600, H = 210
const MAX_TC = 1e5, BETA = 0.1, WALL_PAD = 4, SEAM = 2, MASS_Q = 0.2

function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function roundedRectPolygon(w, h, r, seg = 8) {
  const pts = []
  for (const [cx, cy, a0] of [
    [w - r, r, -Math.PI / 2], [w - r, h - r, 0], [r, h - r, Math.PI / 2], [r, r, Math.PI],
  ]) {
    for (let k = 0; k < seg; k++) {
      const a = a0 + ((k + 0.5) / seg) * (Math.PI / 2)
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
  }
  return pts
}
const BOUNDARY = roundedRectPolygon(W, H, 16)

function clipHalf(poly, ax, ay, b) {
  const out = []
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k], q = poly[(k + 1) % poly.length]
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

function diagramCells(words, sites, lam, boundary) {
  const n = words.length
  return words.map((_w, i) => {
    let poly = boundary
    const cx = sites[i].x, cy = sites[i].y
    const ci2 = cx * cx + cy * cy
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const jx = sites[j].x, jy = sites[j].y
      poly = clipHalf(poly, 2 * (jx - cx), 2 * (jy - cy),
        jx * jx + jy * jy - ci2 - (lam[j] - lam[i]))
      if (!poly.length) return null
    }
    return poly
  })
}

function areaOf(pts) {
  if (!pts) return 0
  let a = 0
  for (let k = 0; k < pts.length; k++) {
    const p1 = pts[k], p2 = pts[(k + 1) % pts.length]
    a += p1[0] * p2[1] - p2[0] * p1[1]
  }
  return Math.abs(a / 2)
}

function areaTargets(words, box, minRatio) {
  const minA = box[0] * box[1] * minRatio
  const total = words.reduce((s, x) => s + x.count, 0)
  const raw = words.map((x) => Math.max((x.count / total) * box[0] * box[1], minA))
  const sum = raw.reduce((s, a) => s + a, 0)
  return raw.map((a) => (a / sum) * box[0] * box[1])
}

function findCavity(sites, box) {
  const [W2, H2] = box
  let best = -Infinity, bx = W2 / 2, by = H2 / 2
  for (let gy = 0; gy <= 12; gy++) {
    for (let gx = 0; gx <= 24; gx++) {
      const px = ((gx + 0.5) / 25) * W2
      const py = ((gy + 0.5) / 13) * H2
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

function tickForce(sites, radii, alpha, box, kCenter = 0.0015, q = MASS_Q) {
  const [W2, H2] = box
  const n = sites.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = sites[i], b = sites[j]
      const dx = b.x - a.x, dy = b.y - a.y
      const d2 = dx * dx + dy * dy
      const rr = radii[i] + radii[j] + SEAM
      if (d2 < rr * rr && d2 > 1e-9) {
        const d = Math.sqrt(d2)
        const overlap = rr - d
        const mA = radii[i] * radii[i], mB = radii[j] * radii[j]
        const shareB = 0.5 + (mA / (mA + mB) - 0.5) * q
        const shareA = 0.5 + (mB / (mA + mB) - 0.5) * q
        const ux = dx / d, uy = dy / d
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
    if (p.x > W2 - r - WALL_PAD) p.x -= (p.x - (W2 - r - WALL_PAD)) * 0.5 * alpha
    if (p.y < r + WALL_PAD) p.y += (r + WALL_PAD - p.y) * 0.5 * alpha
    if (p.y > H2 - r - WALL_PAD) p.y -= (p.y - (H2 - r - WALL_PAD)) * 0.5 * alpha
  }
}

function build(words, box, maxIter = 8000) {
  const sites = []
  sites.push({ x: box[0] / 2, y: box[1] / 2, lam: box[0] * box[1] })
  for (let k = 1; k < words.length; k++) {
    const [bx, by] = findCavity(sites, box)
    let nl = (box[0] * box[1]) / (k + 1)
    let nd = Infinity
    for (const p of sites) {
      const d = Math.hypot(bx - p.x, by - p.y)
      if (d < nd) { nd = d; nl = p.lam * 0.5 }
    }
    sites.push({ x: bx, y: by, lam: Math.max(nl, 1) })
  }
  const lam = sites.map((s) => s.lam)
  let alpha = 1
  for (let f = 0; f < maxIter; f++) {
    alpha = Math.max(alpha * 0.994, 0.01)
    const tgt = areaTargets(words, box, 0.0005)
    const radii = tgt.map((a) => Math.sqrt(a / Math.PI))
    tickForce(sites, radii, alpha, box)
    const rounds = alpha < 0.3 ? 20 : 2
    for (let r = 0; r < rounds; r++) {
      const polys = diagramCells(words, sites, lam, BOUNDARY)
      const areas = polys.map(areaOf)
      for (let i = 0; i < words.length; i++) {
        lam[i] = Math.min(Math.max(lam[i] + BETA * (tgt[i] - areas[i]), 1), MAX_TC)
      }
    }
    if (alpha <= 0.05) break
  }
  return { sites, lam }
}

// 数据 & 场景：40 词 → 破 5 词 → 重建 → 指标
const rand = mulberry32(20260907)
const words0 = Array.from({ length: 40 }, (_v, i) => ({
  text: `词${String(i + 1).padStart(2, '0')}`,
  count: Math.max(1, Math.round(1200 / Math.pow(1.45, i) * (0.92 + rand() * 0.16))),
}))
const popped = ['词5', '词12', '词20', '词30', '词38']
const words = words0.filter((w) => !popped.includes(w.text))
console.log(`重建 ${words.length} 词（原 40 − 破 5）`)
const t0 = performance.now()
const { sites, lam } = build(words, [W, H])
const cells = diagramCells(words, sites, lam, BOUNDARY)
const areas = cells.map(areaOf)
const tgt = areaTargets(words, [W, H], 0.0005)
let worst = 0, wi = -1
for (let i = 0; i < words.length; i++) {
  const rel = areas[i] > 0 ? Math.abs(areas[i] - tgt[i]) / tgt[i] : 1
  if (rel > worst) { worst = rel; wi = i }
}
console.log(`重建耗时 ${(performance.now() - t0).toFixed(0)}ms`)
console.log(`偏差 ${(worst * 100).toFixed(2)}% @${words[wi].text} · 填满 ${(areas.reduce((s, a) => s + a, 0) / (W * H) * 100).toFixed(1)}% · null=${cells.filter(c => !c).length}`)
{
  const idx = areas.map((_a, i) => i)
  idx.sort((i, j) => areas[j] - areas[i])
  let mono = 0, total = 0
  for (let a = 0; a < words.length; a++) for (let b = a + 1; b < words.length; b++) {
    total++
    if (words[idx[a]].count >= words[idx[b]].count) mono++
  }
  console.log(`单调性 ${(mono / total * 100).toFixed(1)}%`)
}
