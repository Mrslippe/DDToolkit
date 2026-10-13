// @vitest-environment jsdom
/**
 * 日期 + 时刻选择器的行为判据（2026-10-13，用户定的 B 方案）。
 *
 * 为什么单开一份：这颗控件是**自己画的**，而它踩错的地方全是"静默改成另一个时间"——
 * 屏幕上看着正常，存进去的却是别的时刻。所以这里钉的是**值**，不是像素：
 *
 * | 判据 | 用户会踩成什么样 |
 * |---|---|
 * | 点日期**只换日期**、时刻原样保留 | 改一天，20:00 被抹成 00:00 |
 * | 改时刻只用**已有日期**；空字段用 `seedDate` 起算 | 滚一下滚轮就凭空长出一个日期 |
 * | 值恒为 `YYYY-MM-DDTHH:mm`（零填充） | 后端按原样字符串解释 ⇒ `9:5` 会被当成非法值 |
 * | 键盘 ↑↓/PgUp/PgDn/Home/End 都能改 | 触控板用户能用、键盘用户用不了 |
 * | 弹层里就是 `.drp-*` 那套日历 | "参照 list 视图的日历样式"这条需求本身 |
 *
 * 纯日期算术（拆装/往返）在 `scripts/check_date_range.mjs` 里，那边不重复。
 */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import DateTimePicker from './DateTimePicker'

const actEnv = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnv.IS_REACT_ACT_ENVIRONMENT = true

/** 受控外壳：与两个调用方（手动记录窗 / 预约窗）的用法一致 —— 值与开关都在父组件手里
 *  （这也是真实用法的形状：Esc 的归属要父组件知道，见组件文件头）。 */
function Harness(props: {
  initial: string
  dateOnly?: boolean
  disabled?: boolean
  clearable?: boolean
  defaultTime?: string
  seedDate?: string
  onEmit?: (v: string) => void
}) {
  const [value, setValue] = useState(props.initial)
  const [open, setOpen] = useState(false)
  return (
    <DateTimePicker
      id="dtp-under-test" value={value} open={open}
      dateOnly={props.dateOnly} disabled={props.disabled} clearable={props.clearable}
      defaultTime={props.defaultTime} seedDate={props.seedDate}
      placeholder="选择日期"
      onOpenChange={setOpen}
      onChange={(v) => { props.onEmit?.(v); setValue(v) }}
    />
  )
}

let host: HTMLDivElement
let root: Root

const q = <T extends Element>(sel: string) => document.querySelector<T>(sel)
const field = () => q<HTMLButtonElement>('#dtp-under-test')!
const pop = () => q<HTMLElement>('.dtp-pop')
const dayBtn = (key: string) => q<HTMLButtonElement>(`[data-dtp-day="${key}"]`)
const col = (label: string) => q<HTMLElement>(`.dtp-col[data-dtp-col="${label}"]`)!
const item = (label: string, v: string) =>
  col(label).querySelector<HTMLButtonElement>(`#dtp-under-test-${label === '时' ? 'h' : 'm'}-${v}`)!
/** 组件当前"值"的读数：字段上的规范化值（与探针读的是同一个钩子） */
const value = () => field().getAttribute('data-dtp-value')

async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

function render(props: Parameters<typeof Harness>[0]) {
  act(() => { root.render(<Harness {...props} />) })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** 本月的第 n 天（`YYYY-MM-DD`）—— 用例不许假设"今天是几号" */
function dayOfThisMonth(n: number) {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(n)}`
}

describe('① 字段与弹层', () => {
  it('字段显示人类可读的值；空值显示占位', () => {
    render({ initial: '2026-10-07T20:00' })
    expect(field().textContent).toContain('2026/10/07 20:00')
    expect(field().getAttribute('data-dtp-value')).toBe('2026-10-07T20:00')
  })

  it('空值时显示占位文案，且 `data-dtp-value` 是空串（父组件据此判"没填"）', () => {
    render({ initial: '' })
    expect(field().textContent).toContain('选择日期')
    expect(value()).toBe('')
  })

  it('点字段开、再点关；点弹层外面也关', async () => {
    render({ initial: '2026-10-07T20:00' })
    expect(pop()).toBeNull()
    await click(field())
    expect(pop()).not.toBeNull()
    await click(field())
    expect(pop()).toBeNull()

    await click(field())
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await Promise.resolve()
    })
    expect(pop()).toBeNull()
  })

  it('disabled：点不开', async () => {
    render({ initial: '2026-10-07T20:00', disabled: true })
    await click(field())
    expect(pop()).toBeNull()
  })
})

describe('② 日历那一半：就是 list 视图那颗日历（复用 `.drp-*`，不是新画一颗）', () => {
  it('弹层里的日历格带 `drp-day`/`drp-day-num`，且是 6×7 = 42 格', async () => {
    render({ initial: '2026-10-07T20:00' })
    await click(field())
    expect(document.querySelectorAll('.dtp-pop .drp-day').length).toBe(42)
    expect(document.querySelectorAll('.dtp-pop .drp-day-num').length).toBe(42)
    expect(document.querySelectorAll('.dtp-pop .drp-wd span').length).toBe(7)
  })

  it('已选那一天有 `sel`（主色实底），今天有 `today`（描边环）', async () => {
    const day = dayOfThisMonth(7)
    render({ initial: `${day}T20:00` })
    await click(field())
    expect(dayBtn(day)!.className).toContain('sel')
    expect(dayBtn(dayOfThisMonth(new Date().getDate()))!.className).toContain('today')
  })
})

describe('③ 值的三条口径（错一位就是"我选的 20:00 存成了别的时间"）', () => {
  it('★ 点日期**只换日期**，时刻原样保留（不是抹成 00:00）', async () => {
    const d7 = dayOfThisMonth(7)
    const d9 = dayOfThisMonth(9)
    render({ initial: `${d7}T20:07` })
    await click(field())
    await click(dayBtn(d9)!)
    expect(value()).toBe(`${d9}T20:07`)
  })

  it('改时刻只改时刻，日期不动；分钟是**1 分钟一档**（20:07 填得出来）', async () => {
    const d7 = dayOfThisMonth(7)
    render({ initial: `${d7}T20:00` })
    await click(field())
    await click(item('时', '19'))
    expect(value()).toBe(`${d7}T19:00`)
    await click(item('分', '07'))
    expect(value()).toBe(`${d7}T19:07`)
  })

  it('值恒为 `YYYY-MM-DDTHH:mm`（零填充，`9:5` 这种非法值不会产生）', async () => {
    const d7 = dayOfThisMonth(7)
    render({ initial: `${d7}T20:00` })
    await click(field())
    await click(item('时', '09'))
    await click(item('分', '05'))
    expect(value()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(value()).toBe(`${d7}T09:05`)
  })

  it('字段为空时点日期 → 用 `defaultTime` 合成（不会凭空变成 00:00）', async () => {
    const d9 = dayOfThisMonth(9)
    render({ initial: '', defaultTime: '22:00' })
    await click(field())
    await click(dayBtn(d9)!)
    expect(value()).toBe(`${d9}T22:00`)
  })

  it('字段为空时改时刻 → 用 `seedDate` 起算（不是猜出来的日期）', async () => {
    render({ initial: '', seedDate: '2026-10-08', defaultTime: '22:00' })
    await click(field())
    await click(item('时', '21'))
    expect(value()).toBe('2026-10-08T21:00')
  })
})

describe('④ 键盘（触控板/鼠标之外的第三条路）', () => {
  const key = async (el: Element, k: string) => {
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
      await Promise.resolve()
    })
  }

  it('↑↓ 走一格、PgUp/PgDn 走五格、Home/End 到头，且两端不越界', async () => {
    const d7 = dayOfThisMonth(7)
    render({ initial: `${d7}T12:00` })
    await click(field())
    await key(col('时'), 'PageDown')
    expect(value()).toBe(`${d7}T17:00`)
    await key(col('时'), 'ArrowDown')
    expect(value()).toBe(`${d7}T18:00`)
    await key(col('时'), 'PageUp')
    expect(value()).toBe(`${d7}T13:00`)
    await key(col('时'), 'End')
    expect(value()).toBe(`${d7}T23:00`)
    await key(col('时'), 'Home')
    expect(value()).toBe(`${d7}T00:00`)
    // 到头不再越界（值不许变成 undefined / 空串）
    await key(col('时'), 'ArrowUp')
    expect(value()).toBe(`${d7}T00:00`)
  })

  it('分钟列的键盘同样按 1 分钟走', async () => {
    const d7 = dayOfThisMonth(7)
    render({ initial: `${d7}T20:00` })
    await click(field())
    await key(col('分'), 'ArrowDown')
    expect(value()).toBe(`${d7}T20:01`)
  })
})

describe('⑤ 底部三枚', () => {
  it('「今天」= 今天 + 保留原时刻', async () => {
    render({ initial: '2020-01-01T20:07' })
    await click(field())
    await click(q('[data-dtp-today]')!)
    expect(value()).toBe(`${dayOfThisMonth(new Date().getDate())}T20:07`)
  })

  it('「完成」只关弹层，不动值', async () => {
    render({ initial: '2020-01-01T20:07' })
    await click(field())
    await click(q('[data-dtp-done]')!)
    expect(pop()).toBeNull()
    expect(value()).toBe('2020-01-01T20:07')
  })

  it('「清除」把值清空并关上弹层（结束时间 = 进行中）', async () => {
    render({ initial: '2020-01-01T21:00', clearable: true })
    await click(field())
    await click(q('[data-dtp-clear]')!)
    expect(value()).toBe('')
    expect(pop()).toBeNull()
  })

  it('不许清空时（开始时间）没有「清除」', async () => {
    render({ initial: '2020-01-01T21:00' })
    await click(field())
    expect(q('[data-dtp-clear]')).toBeNull()
  })
})

describe('⑥ 只选日期（预约窗：预约只到日）', () => {
  it('不渲染时刻列，点日期得到 `YYYY-MM-DD`', async () => {
    const d9 = dayOfThisMonth(9)
    render({ initial: dayOfThisMonth(7), dateOnly: true })
    await click(field())
    expect(q('.dtp-col')).toBeNull()
    await click(dayBtn(d9)!)
    expect(value()).toBe(d9)
  })

  it('字段显示的是一整值而不是 ISO 串', async () => {
    render({ initial: '2026-10-07', dateOnly: true })
    expect(field().textContent).toContain('2026/10/07')
  })
})
