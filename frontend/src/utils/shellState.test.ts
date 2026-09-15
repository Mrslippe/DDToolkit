import { afterEach, describe, expect, it } from 'vitest'
import {
  SHELL_STATE_KEY,
  SHELL_STATE_TTL_MS,
  clearShellState,
  closeIntent,
  currentViewForState,
  loadShellState,
  noteCurrentView,
  parseCloseAction,
  sanitizeRoute,
  sanitizeView,
  saveShellState,
  shouldRestoreFromTray,
} from './shellState'

/**
 * 关闭语义与"深休眠后回到原处"的纯逻辑（R18，devlog/095）。
 * 判错的代价：① 记住了 `quit` 却被当成 `ask`（用户每次都要多点一下）；
 * ② 恢复时把**没校验过的字符串**丢给 navigate()（白屏 / 跳到不存在的路由）；
 * ③ 恢复一个几天前的现场（用户早就忘了自己停在哪儿）。
 */
function memStore(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k) },
    setItem: (k: string, v: string) => { m.set(k, v) },
  } as unknown as Storage
}

afterEach(() => {
  noteCurrentView('cards')
})

describe('关闭语义（三态）', () => {
  it('后端值 → 动作；不认识的值按 ask（宁可多问一次，也别擅自退出）', () => {
    expect(parseCloseAction('tray')).toBe('tray')
    expect(parseCloseAction('quit')).toBe('quit')
    expect(parseCloseAction('ask')).toBe('ask')
    expect(parseCloseAction('minimize')).toBe('ask')
    expect(parseCloseAction(null)).toBe('ask')
    expect(parseCloseAction(undefined)).toBe('ask')
  })

  it('ask → 弹询问；tray → 隐藏；quit → 退出', () => {
    expect(closeIntent('ask')).toBe('ask')
    expect(closeIntent('tray')).toBe('hide')
    expect(closeIntent('quit')).toBe('quit')
  })
})

describe('现场校验（恢复时会喂给 navigate，必须挑剔）', () => {
  it('只认根路径与 /vtubers/<数字>', () => {
    expect(sanitizeRoute('/')).toBe('/')
    expect(sanitizeRoute('/vtubers/14')).toBe('/vtubers/14')
    expect(sanitizeRoute('/vtubers/14/../..')).toBeNull()
    expect(sanitizeRoute('https://evil.example')).toBeNull()
    expect(sanitizeRoute('/vtubers/abc')).toBeNull()
    expect(sanitizeRoute('')).toBeNull()
    expect(sanitizeRoute(null)).toBeNull()
  })

  it('视图只认四个已知值', () => {
    expect(sanitizeView('list')).toBe('list')
    expect(sanitizeView('nope')).toBeNull()
    expect(sanitizeView(3)).toBeNull()
  })
})

describe('保存 / 恢复现场', () => {
  it('存下来能读回，且带上当前视图', () => {
    const s = memStore()
    noteCurrentView('list')
    saveShellState('/vtubers/14', null, 1000, s)
    const st = loadShellState(1500, SHELL_STATE_TTL_MS, s)
    expect(st?.route).toBe('/vtubers/14')
    expect(st?.view).toBe('list')      // 没显式给视图 → 用发布的当前视图
  })

  it('非法路径**不保存**（省得以后恢复出一个坏跳转）', () => {
    const s = memStore()
    saveShellState('/posts/1', null, 1000, s)
    expect(s.getItem(SHELL_STATE_KEY)).toBeNull()
  })

  it('过期 / 时钟倒退 / 坏 JSON → 当作没有现场', () => {
    const s = memStore()
    saveShellState('/vtubers/14', 'list', 1000, s)
    expect(loadShellState(1000 + SHELL_STATE_TTL_MS + 1, SHELL_STATE_TTL_MS, s)).toBeNull()
    expect(loadShellState(1000 - 120_000, SHELL_STATE_TTL_MS, s)).toBeNull()
    s.setItem(SHELL_STATE_KEY, '{不是 json')
    expect(loadShellState(1000, SHELL_STATE_TTL_MS, s)).toBeNull()
    s.setItem(SHELL_STATE_KEY, JSON.stringify({ route: '/vtubers/1', at: 'x' }))
    expect(loadShellState(1000, SHELL_STATE_TTL_MS, s)).toBeNull()
  })

  it('localStorage 抛错时不炸（隐私模式/配额满只是少恢复一次位置）', () => {
    const boom = {
      getItem: () => { throw new Error('nope') },
      setItem: () => { throw new Error('nope') },
      removeItem: () => { throw new Error('nope') },
    } as unknown as Storage
    expect(() => saveShellState('/vtubers/1', 'list', 1, boom)).not.toThrow()
    expect(loadShellState(1, SHELL_STATE_TTL_MS, boom)).toBeNull()
    expect(() => clearShellState(boom)).not.toThrow()
  })

  it('清掉现场后读不到（恢复过一次就不该再恢复）', () => {
    const s = memStore()
    saveShellState('/vtubers/14', 'list', 1000, s)
    clearShellState(s)
    expect(loadShellState(1000, SHELL_STATE_TTL_MS, s)).toBeNull()
  })

  it('currentViewForState 暴露当前视图（保存时的兜底来源）', () => {
    noteCurrentView('archive')
    expect(currentViewForState()).toBe('archive')
  })
})

describe('是不是从深休眠里被唤醒的', () => {
  it('只认 ?restored=1（Rust 重建窗口时加的标记）', () => {
    expect(shouldRestoreFromTray('?restored=1')).toBe(true)
    expect(shouldRestoreFromTray('?probe=1&restored=1')).toBe(true)
    expect(shouldRestoreFromTray('?restored=0')).toBe(false)
    expect(shouldRestoreFromTray('')).toBe(false)
    expect(shouldRestoreFromTray('?probe=1')).toBe(false)
  })
})
