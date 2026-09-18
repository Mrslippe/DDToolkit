import { describe, expect, it } from 'vitest'
import { ZOOM_MAX, ZOOM_MIN, clampPan, nextZoom } from './ImageViewer'

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
