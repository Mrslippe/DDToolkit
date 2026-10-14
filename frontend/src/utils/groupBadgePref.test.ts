// @vitest-environment jsdom
/**
 * 左栏「企划徽章」显示开关的**纯函数那一半**（2026-10-14，用户口径：「把企划图标显示开关
 * 做到设置里」+ **默认关**）。组件那一半（开关真的写后端 + 真的改根属性 + 失败退回）在
 * `components/AppSettingsDialog.groupBadge.test.tsx`。
 *
 * 判据钉四件事：
 * ① 默认**关**（与后端 `PREFS["group_badge"]` 一致 —— 那条跨语言契约另有一条 pytest 钉住）；
 * ② 只有 `'on'` 算开，其余（乱值 / 空 / null / undefined）一律当关；
 * ③ 状态写到**根元素属性** `data-group-badge` 上（CSS 与探针都认它，是单一事实来源）；
 * ④ **真 CSS 里确实写了隐藏规则** —— jsdom 不加载样式表，"关掉时徽章还在那儿"这种错
 *    只有读真文件才测得出来（与 `LiveSessionDialog.test.tsx` 的 ⑥⑦ 同一套办法）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  GROUP_BADGE_ATTR, GROUP_BADGE_DEFAULT, applyGroupBadge, groupBadgeVisible, resetGroupBadge,
} from './groupBadgePref'

beforeEach(() => {
  // ⚠️ 模块级状态：不重置就会带着上一条用例的值进来
  resetGroupBadge()
  document.documentElement.removeAttribute(GROUP_BADGE_ATTR)
})

describe('groupBadgePref：默认关 + 只有 on 算开', () => {
  it('默认是**关**（用户口径：这个开关默认关）', () => {
    expect(GROUP_BADGE_DEFAULT).toBe('off')
    expect(groupBadgeVisible()).toBe(false)
  })

  it('`on` ⇒ 开；其余一律当关（乱值不许把徽章意外打开）', () => {
    expect(applyGroupBadge('on')).toBe(true)
    expect(groupBadgeVisible()).toBe(true)
    for (const bad of ['off', '', '  ', null, undefined, 'ON ', 'true', '1', 1, {}]) {
      expect(applyGroupBadge(bad), `${String(bad)} 该被当成关`).toBe(false)
    }
    // 前后空格要容忍（后端存的是字符串，手改过的值可能带空格）
    expect(applyGroupBadge(' on ')).toBe(true)
  })
})

describe('groupBadgePref：状态落在根元素属性上（CSS 的单一事实来源）', () => {
  it('★ 写根元素属性（关/开都写 —— 探针与 CSS 都读它）', () => {
    applyGroupBadge('on')
    expect(document.documentElement.getAttribute(GROUP_BADGE_ATTR)).toBe('on')
    applyGroupBadge('off')
    expect(document.documentElement.getAttribute(GROUP_BADGE_ATTR)).toBe('off')
  })

  it('`resetGroupBadge()` 回默认（只给用例用的清道夫）', () => {
    applyGroupBadge('on')
    resetGroupBadge()
    expect(groupBadgeVisible()).toBe(false)
    expect(document.documentElement.getAttribute(GROUP_BADGE_ATTR)).toBe('off')
  })
})

describe('真 CSS 里确实写了隐藏规则（jsdom 测不到样式表）', () => {
  const css = readFileSync(resolve(__dirname, '../styles/layout.css'), 'utf8')

  it('★ `html[data-group-badge=\'off\']` 下 `.vtuber-emblem` 整块 `display:none`', () => {
    expect(css).toMatch(/html\[data-group-badge='off'\]\s+\.vtuber-emblem\s*\{[^}]*display:\s*none/)
  })

  it('⚠️ 规则**只对 off 生效**（fail-open）：属性没挂上时徽章照常显示 = 改动前的老样子', () => {
    // 写成"只在 on 时显示"的话，首帧/后端读不到就会突然少一列 —— 那是另一种 bug
    expect(css).not.toMatch(/html\[data-group-badge='on'\]\s+\.vtuber-emblem\s*\{[^}]*display/)
  })
})

describe('真 CSS 里隐藏的是**整块**（那 54px 要真的让出来）', () => {
  const css = readFileSync(resolve(__dirname, '../styles/layout.css'), 'utf8')

  it('被隐藏的是 `.vtuber-emblem`（槽位本身），不是里面的图标/胶囊', () => {
    const m = css.match(/html\[data-group-badge='off'\]\s+(\.vtuber-emblem[\w-]*)\s*\{[^}]*display:\s*none/)
    expect(m?.[1], '隐藏的应当是那个 54px 的槽位 `.vtuber-emblem`').toBe('.vtuber-emblem')
  })

  it('正对照：槽位确实是 54px 宽（不然这条规则省不下什么）', () => {
    expect(css).toMatch(/\.vtuber-emblem\s*\{[^}]*width:\s*54px/)
  })
})
