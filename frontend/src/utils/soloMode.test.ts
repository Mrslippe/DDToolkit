// @vitest-environment jsdom
/**
 * 单推模式的状态与持久化（需求 6，`devlog/429`）。
 *
 * 三条值钱的判据：
 * ① **坏值一律当"没在单推"**（这一格是 localStorage，用户能手工改坏）；
 * ② ★**退出要把"进入前那条路由"还回来** —— 这正是"退出回到进入前的状态"；
 * ③ **跨启动还在**（它是模式，与主题同类，不像 `shellState` 那样设 TTL）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  enterSolo, exitSolo, parseSolo, peekZone, serializeSolo, SOLO_KEY, soloState, subscribeSolo,
} from './soloMode'

beforeEach(() => {
  localStorage.clear()
  exitSolo()          // 把模块级那份也清掉（用例之间不串）
})

describe('单推模式', () => {
  it('★ 坏值一律当"没在单推"（`id` 必须是正整数；路由要过 `sanitizeRoute`）', () => {
    for (const bad of [null, undefined, '', '{', 'null', '[]', '"x"', '{"id":0}', '{"id":-3}',
                       '{"id":1.5}', '{"id":"x"}', '{"id":null}']) {
      expect(parseSolo(bad), `坏值：${bad}`).toBeNull()
    }
    expect(parseSolo('{"id":7}')).toEqual({ id: 7, prevRoute: null })
    // 路由非法（会被丢给 `navigate()`）⇒ 折成 null，而不是原样带出去
    expect(parseSolo('{"id":7,"prevRoute":"/etc/passwd"}')).toEqual({ id: 7, prevRoute: null })
    expect(parseSolo('{"id":7,"prevRoute":"/vtubers/9"}')).toEqual({ id: 7, prevRoute: '/vtubers/9' })
    expect(serializeSolo({ id: 7, prevRoute: 'javascript:alert(1)' }))
      .toBe('{"id":7,"prevRoute":null}')
  })

  it('★ 进入/退出：退出**把进入前那条路由还回来**（调用方据此导航回去）', () => {
    expect(soloState()).toBeNull()
    enterSolo(7, '/vtubers/3')
    expect(soloState()).toEqual({ id: 7, prevRoute: '/vtubers/3' })
    const prev = exitSolo()
    expect(prev, '退出要返回进入前那份').toEqual({ id: 7, prevRoute: '/vtubers/3' })
    expect(soloState()).toBeNull()
    expect(exitSolo(), '本来没在单推 ⇒ null').toBeNull()
  })

  it('★ 跨启动还在（模式 ≠ 现场：不设 TTL），且退出会把键删掉', () => {
    enterSolo(11, '/')
    expect(parseSolo(localStorage.getItem(SOLO_KEY)), '读回来的就是刚存那份')
      .toEqual({ id: 11, prevRoute: '/' })
    exitSolo()
    expect(localStorage.getItem(SOLO_KEY)).toBeNull()
  })

  it('不合法 id 不进状态（免得留下一个指向空气的单推）', () => {
    enterSolo(0, '/')
    enterSolo(-1, '/')
    enterSolo(1.5, '/')
    expect(soloState()).toBeNull()
  })

  it('订阅：进入/退出都通知；退订之后不再收到', () => {
    const seen = vi.fn()
    const off = subscribeSolo(seen)
    enterSolo(7, '/')
    expect(seen).toHaveBeenCalledTimes(1)
    exitSolo()
    expect(seen).toHaveBeenCalledTimes(2)
    off()
    enterSolo(8, '/')
    expect(seen, '退订之后不该再被叫').toHaveBeenCalledTimes(2)
  })
})

describe('唤出区判定（devlog/432）', () => {
  const mk = (cls: string, inner?: string) => {
    const outer = document.createElement('div')
    outer.className = cls
    if (inner) {
      const child = document.createElement('span')
      child.className = inner
      outer.append(child)
    }
    return outer
  }

  it('★ 窄带与"被唤出的元素自身"算**同一个区**（鼠标从窄带移到唤出来的工具栏上不许掉出去）', () => {
    expect(peekZone(mk('solo-hover-top'))).toBe('top')
    expect(peekZone(mk('solo-hover-left'))).toBe('left')
    // 被唤出的元素自身（以及它里面的任意子节点）
    expect(peekZone(mk('topbar'))).toBe('top')
    expect(peekZone(mk('topbar', 'topbar-caps'))).toBe('top')
    expect(peekZone(mk('icon-rail'))).toBe('left')
    expect(peekZone(mk('icon-rail', 'icon-rail-btn'))).toBe('left')
  })

  it('其它地方（内容区、空、非元素）⇒ `none`（不该因为划过内容就把顶栏叫出来）', () => {
    expect(peekZone(mk('posts-panel'))).toBe('none')
    expect(peekZone(mk('sidebar-shell'))).toBe('none')
    expect(peekZone(null)).toBe('none')
    expect(peekZone(undefined)).toBe('none')
    expect(peekZone({} as unknown as Element)).toBe('none')
  })
})