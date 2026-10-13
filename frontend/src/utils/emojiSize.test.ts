// @vitest-environment jsdom
/**
 * 大表情尺寸这个偏好（`devlog/486`）：默认 40px、可调、**真的落到 CSS 变量上**。
 *
 * 判据的重心在最后一条：这个偏好唯一的意义就是"改界面" —— 只把值存进后端、
 * 或者只改 React state 而没写 `--post-emoji-big`，用户看到的就是"滑杆动了、表情没动"。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const getPrefs = vi.fn()
vi.mock('../../api/api', () => ({
  api: { getPrefs: () => getPrefs() },
}))

import {
  EMOJI_BIG_DEFAULT, EMOJI_BIG_MAX, EMOJI_BIG_MIN, applyEmojiBigSize, clampEmojiBig,
  emojiBigSize, resetEmojiBigSize,
} from './emojiSize'

afterEach(() => {
  getPrefs.mockReset()
  resetEmojiBigSize()
})

describe('大表情尺寸（纯逻辑）', () => {
  it('默认 40，区间 24–64 步长 2（与后端 PREFS 白名单同区间）', () => {
    expect([EMOJI_BIG_DEFAULT, EMOJI_BIG_MIN, EMOJI_BIG_MAX]).toEqual([40, 24, 64])
  })

  it('★ 越界夹回来、非数字回默认、不在档位上的取最近档（**绝不把脏值写出去**）', () => {
    expect(clampEmojiBig(40)).toBe(40)
    expect(clampEmojiBig('56')).toBe(56)
    expect(clampEmojiBig(1)).toBe(EMOJI_BIG_MIN)
    expect(clampEmojiBig(999)).toBe(EMOJI_BIG_MAX)
    expect(clampEmojiBig(41)).toBe(42)          // 档位只有偶数档；41 取最近（半档向上）
    expect(clampEmojiBig(43)).toBe(44)
    expect(clampEmojiBig(40.4)).toBe(40)
    expect(clampEmojiBig('big')).toBe(EMOJI_BIG_DEFAULT)
    expect(clampEmojiBig(null)).toBe(EMOJI_BIG_DEFAULT)
    expect(clampEmojiBig(undefined)).toBe(EMOJI_BIG_DEFAULT)
  })

  it('★ 应用到根元素的 CSS 变量上（那是"改了界面"的唯一凭据）', () => {
    applyEmojiBigSize(48)
    expect(document.documentElement.style.getPropertyValue('--post-emoji-big')).toBe('48px')
    expect(emojiBigSize()).toBe(48)
    applyEmojiBigSize('64')                     // 后端存的是字符串
    expect(document.documentElement.style.getPropertyValue('--post-emoji-big')).toBe('64px')
  })

  it('脏值不会写进变量（写的是夹回来的值）', () => {
    applyEmojiBigSize(1000)
    expect(document.documentElement.style.getPropertyValue('--post-emoji-big')).toBe('64px')
  })
})
