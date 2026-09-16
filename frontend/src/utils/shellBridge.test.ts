import { describe, expect, it } from 'vitest'
import { classifyUpdateError, setTrayStatus, UpdateCheckError } from '../utils/shellBridge'

/**
 * 托盘状态行桥接（R29，devlog/129）：浏览器/探针环境下必须**静默返回**。
 *
 * 判错的代价：探针（真实浏览器里跑）会因为这条调用抛错而红，或者更糟 ——
 * 让"托盘提示"变成一个会打断界面逻辑的东西。托盘文案是提示，失败就该无声。
 */
describe('托盘状态桥接', () => {
  it('非 Tauri 环境：静默返回，不抛错', async () => {
    await expect(setTrayStatus('风控冷却中 · 剩余 3 分钟')).resolves.toBeUndefined()
    await expect(setTrayStatus(null)).resolves.toBeUndefined()
  })
})

/**
 * 检查更新的**错误分类**（R23d，devlog/116）。
 *
 * 真机实测踩到的坑：远端还没发布任何 Release 时，更新器报的是
 * `Could not fetch a valid release JSON from the remote` —— 看着像"网络不通"，
 * 于是代理兜底白试了一次，界面上还出现"改用代理后仍失败"这种误导文案。
 * 分类错了的代价就是这个：**用户被引去修一个根本没坏的东西**。
 */
describe('更新错误分类', () => {
  it('远端没有 latest.json → remote（换代理也没用）', () => {
    const a = classifyUpdateError('Could not fetch a valid release JSON from the remote')
    expect(a.kind).toBe('remote')
    expect(a.text).toContain('还没发布过版本')
    expect(classifyUpdateError('HTTP 404 Not Found').kind).toBe('remote')
  })

  it('连不上/DNS/TLS → network（值得试代理）', () => {
    for (const raw of [
      'error sending request for url (https://github.com/...)',
      'dns error: failed to lookup address information',
      'operation timed out',
      'tls handshake failed',
    ]) {
      expect(classifyUpdateError(raw).kind).toBe('network')
    }
  })

  it('其它错误归 other（既不试代理、也不编造原因）', () => {
    const a = classifyUpdateError('signature verification failed')
    expect(a.kind).toBe('other')
    expect(a.text).toBe('signature verification failed')
  })

  it('UpdateCheckError 带得住类别（界面据此换提示语）', () => {
    const e = new UpdateCheckError('remote', '远端没有可用的更新信息')
    expect(e.kind).toBe('remote')
    expect(e.message).toBe('远端没有可用的更新信息')
    expect(e).toBeInstanceOf(Error)
  })
})
