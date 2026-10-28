// @vitest-environment jsdom
/**
 * 工作台「隐藏昵称」的开关本体（2026-10-28 用户口径：昵称一律改用 uid 显示，
 * 设置里给一个开关）。
 *
 * 钉住四件事：
 * ① 默认**关**，且与后端 `PREFS["hide_nicknames"]` 的默认值一致（两边一漂，
 *    症状是"设置里显示开、工作台却还在露昵称"）；
 * ② 只有 `'on'` 算开 —— 乱值/空格/大小写都当关（宁可多露昵称，也不能"以为关了其实没关"）；
 * ③ 状态挂在根元素属性上（`data-hide-nicknames`，探针与样式认它）；
 * ④ 订阅者只在**真的变了**时被通知（`useSyncExternalStore` 每次通知都会重渲染）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HIDE_NICKNAMES_ATTR, HIDE_NICKNAMES_DEFAULT, applyHideNicknames, hideNicknamesOn,
  resetHideNicknames, shownInitial, shownName, subscribeHideNicknames,
} from './hideNicknames'

beforeEach(() => { resetHideNicknames() })

describe('hideNicknames：默认关，只有 on 算开', () => {
  it('默认是关，与后端默认值同值', () => {
    expect(HIDE_NICKNAMES_DEFAULT).toBe('off')
    expect(hideNicknamesOn()).toBe(false)
    expect(document.documentElement.getAttribute(HIDE_NICKNAMES_ATTR)).toBe('off')
  })

  it('乱七八糟的值一律当关', () => {
    for (const bad of [undefined, null, '', 'off', 'ON', 'On', 'yes', 0, 1, {}, []]) {
      expect(applyHideNicknames(bad), `${String(bad)} 该被当成关`).toBe(false)
    }
  })

  it('` on ` 这种带空格的也能认出来', () => {
    expect(applyHideNicknames(' on ')).toBe(true)
    expect(hideNicknamesOn()).toBe(true)
  })
})

describe('hideNicknames：状态落在根元素属性上', () => {
  it('开/关都写到 data-hide-nicknames', () => {
    applyHideNicknames('on')
    expect(document.documentElement.getAttribute(HIDE_NICKNAMES_ATTR)).toBe('on')
    applyHideNicknames('off')
    expect(document.documentElement.getAttribute(HIDE_NICKNAMES_ATTR)).toBe('off')
  })
})

describe('hideNicknames：订阅只在真的变了时通知', () => {
  it('同一个值重复应用不会反复通知', () => {
    const fn = vi.fn()
    const off = subscribeHideNicknames(fn)
    applyHideNicknames('on')
    applyHideNicknames('on')
    expect(fn).toHaveBeenCalledTimes(1)
    applyHideNicknames('off')
    expect(fn).toHaveBeenCalledTimes(2)
    off()
    applyHideNicknames('on')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('shownName / shownInitial', () => {
  it('关着时用昵称，空了退回 uid', () => {
    expect(shownName('19871', '鲸鱼A', false)).toBe('鲸鱼A')
    expect(shownName('19871', '', false)).toBe('19871')
    expect(shownName('19871', null, false)).toBe('19871')
    expect(shownName('19871', '  ', false)).toBe('19871')   // 纯空格也算空
  })

  it('开着时只给 uid（昵称一个字都不漏）', () => {
    expect(shownName('19871', '鲸鱼A', true)).toBe('19871')
    expect(shownName('19871', null, true)).toBe('19871')
  })

  it('头像兜底的首字也跟着换 —— 否则"鲸"字照样漏出来', () => {
    expect(shownInitial('19871', '鲸鱼A', false)).toBe('鲸')
    expect(shownInitial('19871', '鲸鱼A', true)).toBe('1')
  })
})
