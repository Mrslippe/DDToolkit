import { describe, expect, it, vi } from 'vitest'
import {
  DARK_IMPLEMENTED,
  applyTheme,
  resolveTheme,
  systemPrefersDark,
  themeCaveat,
  themeCards,
  watchSystemTheme,
} from './theme'

/**
 * 主题（R14b，devlog/092）。
 * 判错的代价：① 「跟随系统」变成"只在启动那一刻跟随"（假跟随）；
 * ② 深色还没实现却把 root 挂成 dark → 用户看到"切了没反应"；
 * ③ 系统是深色时不说实话 → 用户以为跟随坏了。
 */
describe('解析（偏好 + 系统 → 实际主题）', () => {
  it('浅色偏好永远是浅色', () => {
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
  })

  it('跟随系统：深色未实现时**如实**仍是浅色（不是假装跟随）', () => {
    if (DARK_IMPLEMENTED) {
      expect(resolveTheme('system', true)).toBe('dark')
    } else {
      expect(resolveTheme('system', true)).toBe('light')
    }
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('跟随系统在系统为浅色时两种实现下都是浅色（这条不随钩子状态变）', () => {
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('说明文案（该说的必须说）', () => {
  it('选了跟随系统 + 系统深色 + 未实现 → 必须给出说明', () => {
    const note = themeCaveat('system', true)
    if (DARK_IMPLEMENTED) expect(note).toBeNull()
    else expect(note).toContain('尚未实现')
  })

  it('浅色偏好或系统本来浅色 → 不需要额外说明', () => {
    expect(themeCaveat('light', true)).toBeNull()
    expect(themeCaveat('system', false)).toBeNull()
  })
})

describe('落地到根元素 / 监听系统', () => {
  it('applyTheme 写 html[data-theme]（深色样式将来认这一个属性）', () => {
    const el = { attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v } }
    applyTheme(el as unknown as HTMLElement, 'light')
    expect(el.attrs['data-theme']).toBe('light')
    applyTheme(el as unknown as HTMLElement, 'dark')
    expect(el.attrs['data-theme']).toBe('dark')
  })

  it('根元素缺失时不炸（探针/SSR 环境）', () => {
    expect(() => applyTheme(undefined, 'light')).not.toThrow()
  })

  it('systemPrefersDark：matchMedia 缺失按浅色，不抛', () => {
    expect(systemPrefersDark(undefined)).toBe(false)
    expect(systemPrefersDark({} as Window)).toBe(false)
    expect(systemPrefersDark({ matchMedia: () => ({ matches: true }) } as unknown as Window))
      .toBe(true)
  })

  it('watchSystemTheme 订阅到变化并能在注销后静默', () => {
    const listeners: ((e: { matches: boolean }) => void)[] = []
    const removed: unknown[] = []
    const win = {
      matchMedia: () => ({
        matches: false,
        addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.push(fn),
        removeEventListener: (_: string, fn: unknown) => removed.push(fn),
      }),
    } as unknown as Window
    const seen: boolean[] = []
    const off = watchSystemTheme((d) => seen.push(d), win)
    expect(listeners).toHaveLength(1)
    listeners[0]({ matches: true })
    expect(seen).toEqual([true])
    off()
    expect(removed).toHaveLength(1)       // 注销真的解绑了（否则切窗口/重挂会叠加）
  })

  it('matchMedia 抛错时退化成不监听，而不是把界面搞挂', () => {
    const win = { matchMedia: () => { throw new Error('nope') } } as unknown as Window
    const fn = vi.fn()
    expect(() => watchSystemTheme(fn, win)()).not.toThrow()
    expect(fn).not.toHaveBeenCalled()
  })
})

/**
 * 外观页的三张卡片（R17）。口径：受限/未实现的选项**只标不藏** ——
 * 深色必须照样显示、但禁用 + 写明"尚未实现"（藏起来会让用户以为我们没有深色计划，
 * 而 R14b 的钩子已经铺好了）。深色落地时这里自动解除禁用。
 */
describe('外观卡片（浅色 / 深色 / 跟随系统）', () => {
  it('三张卡片，顺序固定', () => {
    expect(themeCards().map((c) => c.value)).toEqual(['light', 'dark', 'system'])
  })

  it('深色：未实现时**禁用且写明**，实现后自动解除', () => {
    const dark = themeCards().find((c) => c.value === 'dark')!
    expect(dark.disabled).toBe(!DARK_IMPLEMENTED)
    expect(Boolean(dark.note)).toBe(!DARK_IMPLEMENTED)
    if (!DARK_IMPLEMENTED) expect(dark.note).toContain('尚未实现')
  })

  it('浅色与跟随系统始终可用（跟随系统的"系统是深色"另有 caveat 说明，不是禁用理由）', () => {
    const cards = themeCards()
    expect(cards.find((c) => c.value === 'light')!.disabled).toBe(false)
    expect(cards.find((c) => c.value === 'system')!.disabled).toBe(false)
  })
})
