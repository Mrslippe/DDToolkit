/**
 * 桌面控件位置持久化的用例（`utils/widgetWindow.ts`，R38 批 5b）。
 *
 * 重点在**夹取**：控件是置顶 + 无边框 + 不进任务栏的，整个跑出屏幕就再也点不到它。
 */
import { describe, expect, it } from 'vitest'

import {
  WIDGET_MIN_VISIBLE,
  WIDGET_SIZE,
  clampWidgetPos,
  defaultWidgetPos,
  parseWidgetPos,
} from './widgetWindow'

const SCREEN = { width: 1920, height: 1080 }

describe('parseWidgetPos：坏数据一律当"没存过"', () => {
  it('正常值原样读回（并取整）', () => {
    expect(parseWidgetPos('{"x":100,"y":200}')).toEqual({ x: 100, y: 200 })
    expect(parseWidgetPos('{"x":100.6,"y":200.2}')).toEqual({ x: 101, y: 200 })
  })

  it.each([
    ['null', null],
    ['空串', ''],
    ['非 JSON', 'not json'],
    ['JSON 但不是对象', '123'],
    ['字面 null', 'null'],
    ['缺字段', '{"x":1}'],
    ['非数字', '{"x":"a","y":2}'],
    ['NaN 进了 JSON 也不认', '{"x":null,"y":2}'],
  ])('%s ⇒ null', (_name, raw) => {
    expect(parseWidgetPos(raw as string | null)).toBeNull()
  })
})

describe('clampWidgetPos：四个方向都留得住', () => {
  it('屏幕内的坐标不动', () => {
    expect(clampWidgetPos({ x: 500, y: 300 }, SCREEN)).toEqual({ x: 500, y: 300 })
  })

  it('右/下越界 ⇒ 拉回"整个窗口都在屏幕内"', () => {
    expect(clampWidgetPos({ x: 5000, y: 5000 }, SCREEN)).toEqual({
      x: SCREEN.width - WIDGET_SIZE.w - WIDGET_MIN_VISIBLE,
      y: SCREEN.height - WIDGET_SIZE.h - WIDGET_MIN_VISIBLE,
    })
  })

  it('左/上可以贴出去，但**至少留 24px 可见**', () => {
    expect(clampWidgetPos({ x: -5000, y: -5000 }, SCREEN)).toEqual({
      x: WIDGET_MIN_VISIBLE - WIDGET_SIZE.w,
      y: 0,
    })
  })

  it('**换到更小的显示器** ⇒ 原来的坐标被夹回来（这条是它存在的理由）', () => {
    // 在 1920 上存在 (1700, 1000)，插到 1366×768 的笔记本屏上
    const small = { width: 1366, height: 768 }
    const r = clampWidgetPos({ x: 1700, y: 1000 }, small)
    expect(r.x).toBe(small.width - WIDGET_SIZE.w - WIDGET_MIN_VISIBLE)
    expect(r.y).toBe(small.height - WIDGET_SIZE.h - WIDGET_MIN_VISIBLE)
    expect(r.x + WIDGET_SIZE.w).toBeLessThanOrEqual(small.width)
  })

  it('屏幕比窗口还小时两个约束打架 ⇒ 取"右边距优先"', () => {
    // 屏 100 < 窗 200：`maxX = 100 − 200 − 24 = −124`（不是 `m − size.w = −176`）。
    // 于是窗口右缘落在 76，屏右侧仍留 24px —— 比"只保证左缘 24px 可见"更好用。
    const tiny = { width: 100, height: 20 }
    const r = clampWidgetPos({ x: 0, y: 0 }, tiny)
    expect(r.x).toBe(-124)
    expect(r.x + WIDGET_SIZE.w).toBe(tiny.width - WIDGET_MIN_VISIBLE)
    expect(r.y).toBe(0)
  })
})

describe('defaultWidgetPos：首次开启落右下角且不贴边', () => {
  it('右下角，留 24px 边、避开任务栏', () => {
    const r = defaultWidgetPos(SCREEN)
    expect(r.x + WIDGET_SIZE.w).toBe(SCREEN.width - WIDGET_MIN_VISIBLE)
    expect(r.y + WIDGET_SIZE.h).toBe(SCREEN.height - 72)
  })

  it('小屏上也仍然合法（夹取过的）', () => {
    const r = defaultWidgetPos({ width: 800, height: 600 })
    expect(r.x).toBeGreaterThanOrEqual(WIDGET_MIN_VISIBLE - WIDGET_SIZE.w)
    expect(r.x + WIDGET_SIZE.w).toBeLessThanOrEqual(800)
  })
})
