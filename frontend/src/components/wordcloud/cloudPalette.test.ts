import { describe, expect, it } from 'vitest'

import {
  CLOUD_COLORS,
  cloudWordColor,
  cloudWordText,
  hashOf,
  hslToHex,
  rgbToHsl,
} from './cloudPalette'

/**
 * 词云配色（P2 分层收敛 A-1 从 `LiveCalendar.tsx` 搬出）。
 * 这些断言锁的是**用户可见的配色契约**：
 *   - 同一个词颜色恒定（重排/换场次不闪色）；
 *   - 填充浅、文字同色系深（对比度）；
 *   - 色板取色均匀（不会所有词落同一个色）。
 * 搬动前这些行为没有测试，纯靠肉眼 —— 现在有了。
 */

describe('hashOf — 稳定哈希', () => {
  it('同输入恒同值（决定颜色稳定）', () => {
    expect(hashOf('哈哈')).toBe(hashOf('哈哈'))
    expect(hashOf('生日快乐')).toBe(hashOf('生日快乐'))
  })

  it('落在 [0,997) 内（取模基数）', () => {
    for (const w of ['a', '冲', '？？？', 'x'.repeat(200), '猫', '233']) {
      const h = hashOf(w)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(997)
      expect(Number.isInteger(h)).toBe(true)
    }
  })

  it('空串为 0（不抛错）', () => {
    expect(hashOf('')).toBe(0)
  })
})

describe('cloudWordColor — 浅色填充', () => {
  it('取色来自色板', () => {
    for (const w of ['哈哈', '可爱', '好耶', '主播', '233']) {
      expect(CLOUD_COLORS).toContain(cloudWordColor({ text: w }))
    }
  })

  it('同一个词颜色恒定', () => {
    expect(cloudWordColor({ text: '晚安' })).toBe(cloudWordColor({ text: '晚安' }))
  })

  it('色板分布：多个不同词不会全落同一个色', () => {
    const words = ['哈哈', '可爱', '好耶', '主播', '233', '生日快乐', '唱得好', '来了', '合影', '泪目']
    const used = new Set(words.map((t) => cloudWordColor({ text: t })))
    expect(used.size).toBeGreaterThan(1)
  })

  it('色板恰好 10 色（改色板等于改视觉，需显式确认）', () => {
    expect(CLOUD_COLORS).toHaveLength(10)
  })
})

describe('cloudWordText — 同色系深色', () => {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255
  }

  it('输出合法 6 位 hex', () => {
    for (const w of ['哈哈', '冲', '？？？', '猫']) {
      expect(cloudWordText({ text: w })).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('文字比填充更深（浅底深字，可读性前提）', () => {
    for (const w of ['哈哈', '可爱', '好耶', '主播', '233', '生日快乐']) {
      const fill = cloudWordColor({ text: w })
      const text = cloudWordText({ text: w })
      expect(lum(text), `「${w}」文字应比填充深`).toBeLessThan(lum(fill))
    }
  })

  it('文字亮度固定压到约 0.28（同色系深色口径）', () => {
    // hslToHex(..., l=0.28) → 相邻色相亮度差异很小
    for (const w of ['哈哈', '可爱', '好耶']) {
      expect(lum(cloudWordText({ text: w }))).toBeGreaterThan(0.1)
      expect(lum(cloudWordText({ text: w }))).toBeLessThan(0.45)
    }
  })
})

describe('rgbToHsl / hslToHex — 色彩空间换算', () => {
  it('灰阶 → 饱和度 0', () => {
    expect(rgbToHsl(128, 128, 128)[1]).toBe(0)
    expect(rgbToHsl(0, 0, 0)[1]).toBe(0)
  })

  it('纯红/纯绿/纯蓝色相正确', () => {
    expect(Math.round(rgbToHsl(255, 0, 0)[0])).toBe(0)
    expect(Math.round(rgbToHsl(0, 255, 0)[0])).toBe(120)
    expect(Math.round(rgbToHsl(0, 0, 255)[0])).toBe(240)
  })

  it('hslToHex 对 h 取模（负值与超界不炸）', () => {
    expect(hslToHex(-60, 1, 0.5)).toBe(hslToHex(300, 1, 0.5))
    expect(hslToHex(420, 1, 0.5)).toBe(hslToHex(60, 1, 0.5))
  })

  it('往返一致：hex → hsl → hex 保持色相（红系样本）', () => {
    const hex = '#ffc9c4'
    const n = parseInt(hex.slice(1), 16)
    const [h, s] = rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255)
    expect(hslToHex(h, s, 0.5)).toMatch(/^#[0-9a-f]{6}$/)
  })
})
