// @vitest-environment jsdom
/**
 * 全屏诊断开关（2026-10-07，`devlog/399`）。判据只钉一件事：**这个开关不许"自己生效"**。
 *
 * 理由：它一旦被一个手滑的值卡住（或反过来该生效时没生效），表现是"播放器行为莫名其妙变了"，
 * 而排查的人**根本不会想到去看环境变量** —— 于是会拿一轮无效的数去下结论。
 */
import { describe, expect, it } from 'vitest'

import { readVpFsMode, VP_FS_MODE_KEY } from './vpFsMode'

describe('vpFsMode', () => {
  it('默认 `off`：环境变量与 localStorage 都没有 ⇒ 生产行为一字不变', () => {
    expect(readVpFsMode(undefined, null)).toBe('off')
  })

  it('两个模式都认，且**环境变量优先**于 localStorage', () => {
    expect(readVpFsMode('size', null)).toBe('size')
    expect(readVpFsMode('pseudo', null)).toBe('pseudo')
    expect(readVpFsMode('size', 'pseudo'), '同时设了要以环境变量为准').toBe('size')
    expect(readVpFsMode(undefined, 'pseudo'), '只写 localStorage 也要能开').toBe('pseudo')
  })

  it('⚠️ 垃圾值一律当 `off`（透传或抛出去都会变成"行为莫名变了"）', () => {
    for (const bad of ['', 'off', 'ON', 'SIZE', 'full', '1', ' size', 'size ', 'fullscreen']) {
      expect(readVpFsMode(bad, null), `环境变量=${JSON.stringify(bad)}`).toBe('off')
      expect(readVpFsMode(undefined, bad), `localStorage=${JSON.stringify(bad)}`).toBe('off')
    }
    // 类型不对（数字/对象/null）也不许把它带崩
    for (const bad of [42, null, undefined, {}, []]) {
      expect(readVpFsMode(bad, null)).toBe('off')
      expect(readVpFsMode(undefined, bad as unknown as string)).toBe('off')
    }
  })

  it('键名写死在这一条上（devtools 里手写它才能开）', () => {
    expect(VP_FS_MODE_KEY).toBe('ddtoolkit.vpFsMode')
  })

  it('**不带参数**（真实调用形态）时走真链：默认 `off`，写了 localStorage 就开', () => {
    // 环境变量那一支在 Vite 里是启动时定死的常量对象（测试改不动它），所以这里钉的是
    // `fromLocalStorage()` 这条真链 —— 它也是"开着 devtools 手写一条"时的入口。
    localStorage.removeItem(VP_FS_MODE_KEY)
    expect(readVpFsMode()).toBe('off')
    localStorage.setItem(VP_FS_MODE_KEY, 'size')
    try {
      expect(readVpFsMode()).toBe('size')
    } finally {
      localStorage.removeItem(VP_FS_MODE_KEY)
    }
  })
})
