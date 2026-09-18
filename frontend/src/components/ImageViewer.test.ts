import { describe, expect, it } from 'vitest'
import { ZOOM_MAX, ZOOM_MIN, nextZoom } from './ImageViewer'

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
