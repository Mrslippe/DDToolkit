import { describe, expect, it } from 'vitest'
import { platformLabel, trayStatusText } from './trayStatus'

/**
 * 托盘状态行文案（R29，devlog/129）。
 *
 * 为什么值得单测：这句话是**收进托盘后用户唯一能看到的风控信号** ——
 * 拼错了（少平台、说"0 分钟"、冷却结束还留着）都会让人以为"限流还没好"或"根本没限流"。
 */
describe('托盘状态行', () => {
  it('不在冷却 → null（壳据此复位成「后台运行中」）', () => {
    expect(trayStatusText(null)).toBeNull()
    expect(trayStatusText(undefined)).toBeNull()
    expect(trayStatusText({ active: false, seconds_left: 0 })).toBeNull()
  })

  it('冷却中：平台 + 剩余分钟', () => {
    expect(trayStatusText({ active: true, seconds_left: 8 * 60, platform: 'bilibili' }))
      .toBe('风控冷却中 · B 站 · 剩余 8 分钟')
    expect(trayStatusText({ active: true, seconds_left: 600, platform: 'weibo' }))
      .toBe('风控冷却中 · 微博 · 剩余 10 分钟')
  })

  it('不足 1 分钟也显示 1 分钟（绝不显示「剩余 0 分钟」）', () => {
    expect(trayStatusText({ active: true, seconds_left: 20 })).toBe('风控冷却中 · 剩余 1 分钟')
    expect(trayStatusText({ active: true, seconds_left: 0 })).toBe('风控冷却中 · 剩余 1 分钟')
  })

  it('连续命中第 2 次起追加次数（R27 的梯度让"第几次"有意义：10→20→40 分钟）', () => {
    expect(trayStatusText({ active: true, seconds_left: 1200, platform: 'bilibili', hits: 2 }))
      .toBe('风控冷却中 · B 站 · 剩余 20 分钟 · 连续第 2 次')
    expect(trayStatusText({ active: true, seconds_left: 600, hits: 1 }))
      .toBe('风控冷却中 · 剩余 10 分钟')          // 第 1 次不啰嗦
  })

  it('平台代号：收录的翻成人话，没收录的原样显示，缺省就不写', () => {
    expect(platformLabel('bilibili')).toBe('B 站')
    expect(platformLabel('weibo')).toBe('微博')
    expect(platformLabel('xiaohongshu')).toBe('xiaohongshu')
    expect(platformLabel(undefined)).toBe('')
    expect(trayStatusText({ active: true, seconds_left: 60 })).toBe('风控冷却中 · 剩余 1 分钟')
  })
})
