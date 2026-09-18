import { describe, expect, it } from 'vitest'
import { ZOOM_MAX, ZOOM_MIN, clampPan, nextZoom, settleTarget, zoomPan } from './ImageViewer'

/**
 * 图片查看器的滚轮缩放（R40c，用户 2026-09-19：「为帖子详情弹窗中可以打开的图片查看器
 * 新增图片缩放功能，用滚轮控制放大和缩小」）。纯函数在 `ImageViewer.tsx` 里导出，
 * 这里钉住三条：方向、夹取范围、不动就返回原值。
 */
describe('图片查看器：滚轮缩放', () => {
  it('向上滚放大、向下滚缩小', () => {
    expect(nextZoom(1, -100)).toBeGreaterThan(1)
    expect(nextZoom(2, 100)).toBeLessThan(2)
  })

  it('不允许小于适应窗口（1）—— 比适应窗口更小没有意义', () => {
    expect(nextZoom(1, 100)).toBe(ZOOM_MIN)
    expect(nextZoom(1.05, 100)).toBeGreaterThanOrEqual(ZOOM_MIN)
  })

  it('放大封顶在 4 倍（连续滚也不会飞出去）', () => {
    let z = 1
    for (let i = 0; i < 40; i += 1) z = nextZoom(z, -100)
    expect(z).toBe(ZOOM_MAX)
  })

  it('deltaY 为 0 时原样返回（不动就不重算 origin）', () => {
    expect(nextZoom(2.5, 0)).toBe(2.5)
  })

  it('往返一趟回到原值附近（步进是乘除同底，不该漂）', () => {
    const z = nextZoom(nextZoom(1.7, -100), 100)
    expect(Math.abs(z - 1.7)).toBeLessThan(0.02)
  })
})

/**
 * 抓手拖动的边界钳制（R40d，用户 2026-09-19：「图片查看器还要加上放大后可以按住拖动的抓手工具」）。
 * 判据核心是**没放大就拖不动**、**放大后不会把图拖出屏幕**。
 */
describe('图片查看器：抓手拖动钳制', () => {
  const size = { w: 800, h: 600 }
  const viewport = { w: 1000, h: 800 }      // 视口比图大：适应窗口时图居中

  it('没放大（scale=1）⇒ 上下左右都拖不动', () => {
    expect(clampPan({ x: 300, y: -200 }, 1, size, viewport)).toEqual({ x: 0, y: 0 })
  })

  it('放大后可拖范围 = 超出视口部分的一半', () => {
    // 2 倍：图 1600×1200，视口 1000×800 ⇒ 可拖 ±300 / ±200
    expect(clampPan({ x: 999, y: -999 }, 2, size, viewport)).toEqual({ x: 300, y: -200 })
  })

  it('范围内的位移原样保留（不产生僵手感）', () => {
    expect(clampPan({ x: 120, y: -80 }, 2, size, viewport)).toEqual({ x: 120, y: -80 })
  })

  it('放大但图仍装得下 ⇒ 依旧拖不动', () => {
    // 图 400×300 放大 2 倍 = 800×600，仍小于视口 ⇒ 可拖 0
    expect(clampPan({ x: 50, y: 50 }, 2, { w: 400, h: 300 }, viewport)).toEqual({ x: 0, y: 0 })
  })

  it('一个方向超出、另一个方向没超出时，各自独立钳制', () => {
    const r = clampPan({ x: 500, y: 500 }, 2, { w: 800, h: 300 }, viewport)
    expect(r.x).toBe(300)                   // 横向超出 ⇒ 可拖
    expect(r.y).toBe(0)                     // 纵向没超出 ⇒ 锁死
  })
})

/**
 * R40e（用户 2026-09-19）：「缩放和抓手逻辑好怪，放大后拖动了再缩小，
 * 缩小时会因为鼠标位置不一样而突然闪到其他位置」+「B站那种原生放大：
 * 抓手即使左右移动也可以跟随，但松手后会自动弹性约束到中间」。
 * 这里钉住缩放补偿与松手落点两条纯逻辑。
 */
describe('图片查看器：缩放补偿（指针下的点钉住）', () => {
  it('在指针处放大：那个点在屏幕上不动', () => {
    // 图片点 u 在屏幕上的位置 = pan + u·scale；放大后要仍在 anchor 处
    const anchor = { x: 200, y: -100 }
    const p1 = zoomPan({ x: 0, y: 0 }, 1, 2, anchor)
    // u = (anchor - pan)/scale = anchor；放大后 pan' = anchor - anchor*2 = -anchor
    expect(p1).toEqual({ x: -200, y: 100 })
    // 验算：u 在放大后的屏幕位置 = pan' + u·2 = -200 + 200*2 = 200 ✓ 仍是 anchor
    expect(p1.x + anchor.x * 2).toBe(anchor.x)
  })

  it('**缩小回 1 倍 ⇒ 位移自然收敛回 0**（不再"闪到别处"）', () => {
    const anchor = { x: 200, y: -100 }
    const zoomedIn = zoomPan({ x: 0, y: 0 }, 1, 2, anchor)
    const back = zoomPan(zoomedIn, 2, 1, { x: 0, y: 0 })   // 缩小时指针可能在别处
    // 收敛回中心（再由 settleTarget 钉死）—— 关键是**不放大也不偏移**
    expect(settleTarget(back, 1, { w: 800, h: 600 }, { w: 1000, h: 800 })).toEqual({ x: 0, y: 0 })
  })

  it('缩放倍率不变 ⇒ 位移原样（不产生无谓抖动）', () => {
    const pan = { x: 33, y: -12 }
    expect(zoomPan(pan, 2, 2, { x: 500, y: 500 })).toBe(pan)
  })

  it('非法 scale 不炸（防御）', () => {
    expect(zoomPan({ x: 1, y: 2 }, 0, 2, { x: 0, y: 0 })).toEqual({ x: 1, y: 2 })
  })
})

describe('图片查看器：松手回位落点', () => {
  it('没放大 ⇒ 一律回中心（抓手在 1 倍时本来就不该有位移）', () => {
    expect(settleTarget({ x: 500, y: -400 }, 1, { w: 800, h: 600 }, { w: 1000, h: 800 }))
      .toEqual({ x: 0, y: 0 })
  })

  it('放大后拖出界 ⇒ 收到边界上（弹性约束的落点）', () => {
    expect(settleTarget({ x: 9999, y: -9999 }, 2, { w: 800, h: 600 }, { w: 1000, h: 800 }))
      .toEqual({ x: 300, y: -200 })
  })
})
