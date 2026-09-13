/**
 * 词云布局**特征化基线**（characterization fixture）—— 供「只搬不改」的抽取做位级回归。
 *
 * 为什么需要它：`ui_probe.py` 只断言「在不在框里」，不比对多边形坐标；
 * 而词云抽取（P2 分层收敛 A-1）最大的风险是**搬动参数/顺序导致布局漂移**。
 * 这个脚本直接跑 `MosaicPacker` 并把 `state()` 的完整输出哈希掉 —— 抽取前后
 * 哈希必须**完全一致**，否则说明搬运改变了行为（哪怕看起来仍然"像一个词云"）。
 *
 * 用法：
 *   node scripts/check_wordcloud_layout.mjs --print   # 打印哈希与摘要
 *   node scripts/check_wordcloud_layout.mjs           # 与 --expect 比对
 *   node scripts/check_wordcloud_layout.mjs --expect <hash>
 *
 * 注意：只覆盖 `MosaicPacker`/`packFinal`（纯算法）。`MosaicCloud` 组件本身
 * （rAF / ResizeObserver / 入场节拍）不在覆盖范围，仍需 ui_probe + 肉眼。
 */
import { createHash } from 'node:crypto'
import { MosaicPacker, packFinal, roundedRectPolygon } from '../frontend/src/utils/wordCloudLayout.ts'

/** 固定词表：覆盖「高频/中频/低频/单字/长词/同频」等形态，不依赖任何真实数据 */
const WORDS = [
  { text: '哈哈', count: 420 },
  { text: '可爱', count: 310 },
  { text: '好耶', count: 288 },
  { text: '主播', count: 205 },
  { text: '233', count: 190 },
  { text: '生日快乐', count: 166 },
  { text: '唱得好', count: 150 },
  { text: '啊啊啊', count: 141 },
  { text: '第一次', count: 120 },
  { text: '来了', count: 118 },
  { text: '合影', count: 96 },
  { text: '泪目', count: 88 },
  { text: '好听', count: 88 },
  { text: '耳朵', count: 74 },
  { text: '冲', count: 61 },
  { text: '谢谢', count: 55 },
  { text: '晚安', count: 43 },
  { text: '打卡', count: 39 },
  { text: '太强了', count: 31 },
  { text: '？？？', count: 27 },
  { text: '猫', count: 22 },
  { text: '新衣', count: 15 },
  { text: '开播了', count: 9 },
  { text: '错过', count: 4 },
]

const BOX = [560, 210]

/** 定点小数，避免 -0 / 浮点末位差异造成假失败 */
const fx = (v) => (Math.abs(v) < 1e-9 ? 0 : Number(v.toFixed(6)))

/** 全量稳态（还原 MosaicCloud 的收尾参数：alpha 0.994 衰减、末段 λ 80 轮） */
function finalState() {
  const packer = new MosaicPacker(BOX, 0.0005, 20260907)
  for (const w of WORDS) packer.addWord(w)
  let alpha = 1
  while (alpha > 0.01) {
    alpha = Math.max(alpha * 0.994, 0.01)
    packer.step(alpha, alpha < 0.3 ? 80 : 2)
  }
  return packer.state()
}

/** 增量入场中途快照（覆盖 addWord 的"最大空腔"路径与 λ 继承） */
function partialSnapshots() {
  const packer = new MosaicPacker(BOX, 0.0005, 20260907)
  const snaps = []
  WORDS.forEach((w, i) => {
    packer.addWord(w)
    packer.step(0.5, 4)
    if (i === 0 || i === 5 || i === 12 || i === WORDS.length - 1) {
      snaps.push({ at: i, sites: packer.state().sites })
    }
  })
  return snaps
}

/** 破泡后重建（覆盖 removeWord + rebuild 的局部松弛入口） */
function poppedState() {
  const packer = new MosaicPacker(BOX, 0.0005, 20260907)
  for (const w of WORDS) packer.addWord(w)
  packer.step(1, 2)
  packer.removeWord('哈哈')
  packer.removeWord('冲')
  for (let i = 0; i < 40; i++) packer.step(0.15, 8, 0)
  return packer.state()
}

const payload = {
  box: BOX,
  final: finalState(),
  popped: poppedState(),
  partial: partialSnapshots(),
  boundary: roundedRectPolygon(BOX[0], BOX[1], 16).map(([x, y]) => [fx(x), fx(y)]),
}

const canonical = JSON.stringify(payload, (k, v) => (typeof v === 'number' ? fx(v) : v))
const hash = createHash('sha256').update(canonical).digest('hex')

const args = process.argv.slice(2)
const expectIdx = args.indexOf('--expect')
const expect = expectIdx >= 0 ? args[expectIdx + 1] : null

const cells = payload.final.cells
const area = cells.reduce((s, c) => {
  let a = 0
  for (let i = 0; i < c.poly.length; i++) {
    const [x1, y1] = c.poly[i]
    const [x2, y2] = c.poly[(i + 1) % c.poly.length]
    a += x1 * y2 - x2 * y1
  }
  return s + Math.abs(a) / 2
}, 0)

console.log(`词云布局基线`)
console.log(`  box        = ${BOX[0]}×${BOX[1]}`)
console.log(`  词数        = ${WORDS.length}`)
console.log(`  终态 cells  = ${cells.length}`)
console.log(`  覆盖率      = ${(area / (BOX[0] * BOX[1]) * 100).toFixed(2)}%`)
console.log(`  破泡后 cells= ${payload.popped.cells.length}`)
console.log(`  sha256     = ${hash}`)

if (args.includes('--print') || (!expect && expectIdx < 0)) {
  if (!expect && expectIdx < 0) console.log('（未提供 --expect，仅打印）')
  process.exit(0)
}
if (hash === expect) {
  console.log('[ok] 与期望哈希一致 —— 抽取未改变算法行为')
  process.exit(0)
}
console.error(`[FAIL] 哈希不一致：期望 ${expect} 实得 ${hash}`)
process.exit(1)
