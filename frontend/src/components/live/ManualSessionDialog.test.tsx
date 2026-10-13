// @vitest-environment jsdom
/**
 * 手动记录/编辑弹窗的行为判据（B2，devlog/454）。
 *
 * 钉住六件事（都是"用户会踩、而服务端拦不住"的）：
 * ① 新建默认今天 20:00–22:00，且**空字段不发**（`undefined` ≠ `null`：服务端把 null 当"清空"）；
 * ② 时间**原样**提交（不是 `toISOString()` —— 那会按浏览器时区折一次，服务端再折一次）；
 * ③ 编辑只提交**改过**的字段（改标题不会顺手清掉结束时间）；没改动时保存不可点；
 * ④ 自动抓来的场次：时间/标题不可改且有说明，录播可改，**没有删除按钮**；
 * ⑤ 409/422 的中文原因**显示在表单里**（不许吞成"保存失败"）；
 * ⑥ 删除要两步确认（没有 `window.confirm`：它在 WebView 里被壳挡住时是静默失败）。
 *
 * ⚠️ 2026-10-13 起时间字段是**自己画的**日期+时刻选择器（`common/DateTimePicker`，
 * 用户口径：原生那颗弹层长得不像本项目）—— 所以下面设值一律走**用户那条路**
 * （点字段 → 翻月 → 点日 → 点时刻列），而不是直接改状态：值格式也一并被验。
 * 控件本身的行为判据在 `components/common/DateTimePicker.test.tsx`（19 条）。
 *
 * 组件用例的写法沿用 `LiveSessionDialog.test.tsx`（jsdom + `react-dom/client` + `act`，零新依赖）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LiveSession, LiveSessionDetail } from '../../api/types'

vi.mock('../../api/api', () => ({
  api: {
    createManualLiveSession: vi.fn(),
    updateLiveSession: vi.fn(),
    deleteLiveSession: vi.fn(),
  },
}))

import { api } from '../../api/api'
import ManualSessionDialog from './ManualSessionDialog'

const createMock = vi.mocked(api.createManualLiveSession)
const updateMock = vi.mocked(api.updateLiveSession)
const deleteMock = vi.mocked(api.deleteLiveSession)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver)
vi.stubGlobal('matchMedia', (q: string) => ({
  matches: false, media: q, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent: () => false,
}))
Element.prototype.scrollTo = () => {}
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const iso = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi).toISOString()

const MANUAL = {
  account_id: 1, live_id: 'manual-abc', live_title: '歌回',
  start_at: iso(2026, 10, 8, 20, 0), end_at: iso(2026, 10, 8, 22, 0),
  duration_minutes: 120, source: 'manual', manual: true,
  vod_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
} as unknown as LiveSession

const AUTO = {
  ...MANUAL, live_id: 'uuid-a', source: 'danmakus', manual: false,
  vod_url: null, live_title: '深夜杂谈',
} as unknown as LiveSession

const SAVED = { ...MANUAL, analysis: null } as unknown as LiveSessionDetail

let host: HTMLDivElement
let root: Root
const onClose = vi.fn()
const onSaved = vi.fn()
const onDeleted = vi.fn()

function render(session: LiveSession | null) {
  act(() => {
    root.render(
      <ManualSessionDialog open accountId={1} session={session}
                           onClose={onClose} onSaved={onSaved} onDeleted={onDeleted} />,
    )
  })
}

const input = (id: string) => document.getElementById(id) as HTMLInputElement
/** 时间字段现在是**自己画的**日期+时刻选择器（`common/DateTimePicker`）：
 *  它不是 `<input>`，值挂在 `data-dtp-value` 上（探针读的是同一个钩子）。 */
const timeField = (id: string) => document.getElementById(id) as HTMLButtonElement
const timeValue = (id: string) => timeField(id).getAttribute('data-dtp-value')
const saveBtn = () => document.querySelector<HTMLButtonElement>('.lc-ms-btn.primary')!
const delBtn = () => document.querySelector<HTMLButtonElement>('.lc-ms-btn.danger')
const errorText = () => document.querySelector('.lc-ms-error')?.textContent ?? ''

/** 受控输入：必须走原生 setter + input 事件，React 才认这次改动 */
function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const pop = () => document.querySelector<HTMLElement>('.dtp-pop')

/** 把弹出层的日历翻到指定年月（点年月箭头 —— 与用户的操作路径一致，不直接塞状态） */
async function gotoMonth(y: number, mo: number) {
  for (let i = 0; i < 40; i++) {
    const m = /^(\d{4})年(\d{1,2})月$/.exec(document.querySelector('.dtp-pop .drp-title')!.textContent!)
    if (!m) throw new Error('日历标题读不出来')
    const cur = Number(m[1]) * 12 + Number(m[2])
    const want = y * 12 + mo
    if (cur === want) return
    await click(document.querySelector<HTMLButtonElement>(
      `.dtp-pop [title="${cur > want ? '上个月' : '下个月'}"]`)!)
  }
  throw new Error(`翻不到 ${y}-${mo}`)
}

/** 用选择器把某个时间字段设成指定值：开 → 翻月 → 点日 → 点时刻两列 → 完成。
 *  ⚠️ 走的是**用户那条路**（不是为了用例方便直接改状态）—— 值格式也就一并被验了。 */
async function setDateTime(id: string, v: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v)!
  await click(timeField(id))
  await gotoMonth(Number(m[1]), Number(m[2]))
  await click(document.querySelector<HTMLButtonElement>(`[data-dtp-day="${m[1]}-${m[2]}-${m[3]}"]`)!)
  await click(document.querySelector<HTMLButtonElement>(`#${id}-h-${m[4]}`)!)
  await click(document.querySelector<HTMLButtonElement>(`#${id}-m-${m[5]}`)!)
  await click(document.querySelector<HTMLButtonElement>('[data-dtp-done]')!)
}

/** 清空（结束时间 = 进行中）：真实路径是弹层里的「清除」 */
async function clearTime(id: string) {
  await click(timeField(id))
  await click(document.querySelector<HTMLButtonElement>('[data-dtp-clear]')!)
}

async function click(el: HTMLButtonElement) {
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

beforeEach(() => {
  createMock.mockReset().mockResolvedValue(SAVED)
  updateMock.mockReset().mockResolvedValue(SAVED)
  deleteMock.mockReset().mockResolvedValue({ deleted: true, live_id: 'manual-abc' })
  onClose.mockReset(); onSaved.mockReset(); onDeleted.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('新建', () => {
  it('① 默认今天 20:00–22:00；只填开始时间就能存，空标题/空录播**不发**', async () => {
    render(null)
    // ⚠️ **"今天"按本地时区算**（2026-10-10 自审 F4，`devlog/461`）：
    //    这里原先写 `new Date().toISOString().slice(0, 10)`，那是 **UTC 日期** ——
    //    组件给的是本地今天（`manualSessionForm.toLocalInput`），于是这条用例
    //    在东八区的**每天 00:00–08:00 之间必红**（UTC 还停在前一天）。
    //    它不是被我那次改动弄红的，是本来就按错的口径写的（那个窗口里跑才会现形）。
    const today = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const localToday = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
    expect(timeValue('lc-ms-start')).toBe(`${localToday}T20:00`)
    expect(timeValue('lc-ms-end')).toBe(`${localToday}T22:00`)

    await click(saveBtn())
    expect(createMock).toHaveBeenCalledTimes(1)
    const [aid, body] = createMock.mock.calls[0]
    expect(aid).toBe(1)
    expect(body).toEqual({
      start_at: timeValue('lc-ms-start'), end_at: timeValue('lc-ms-end'),
    })
    expect('title' in body).toBe(false)
    expect('vod_url' in body).toBe(false)
    expect(onSaved).toHaveBeenCalledWith(SAVED)
  })

  it('② 时间原样提交（不做 toISOString 折算）；标题/录播去空白后带上', async () => {
    render(null)
    await setDateTime('lc-ms-start', '2026-10-08T19:30')
    await setDateTime('lc-ms-end', '2026-10-08T21:30')
    type(input('lc-ms-title'), ' 深夜歌回 ')
    type(input('lc-ms-vod'), ' BV1xx411c7mD ')

    await click(saveBtn())
    expect(createMock.mock.calls[0][1]).toEqual({
      start_at: '2026-10-08T19:30', end_at: '2026-10-08T21:30',
      title: '深夜歌回', vod_url: 'BV1xx411c7mD',
    })
  })

  it('★ 开始时间**没有「清除」入口**（必填；守卫在 `canSubmitNew`，见纯函数用例）', async () => {
    render(null)
    await click(timeField('lc-ms-start'))
    expect(pop()).not.toBeNull()
    expect(document.querySelector('[data-dtp-clear]')).toBeNull()
  })
})

describe('编辑', () => {
  it('③ 预填服务端那份数据；只提交改过的字段；没改动时不可点', async () => {
    render(MANUAL)
    expect(input('lc-ms-title').value).toBe('歌回')
    expect(input('lc-ms-vod').value).toBe(MANUAL.vod_url)
    expect(saveBtn().disabled).toBe(true)                 // 什么都没改

    type(input('lc-ms-title'), '深夜歌回')
    expect(saveBtn().disabled).toBe(false)
    await click(saveBtn())
    expect(updateMock).toHaveBeenCalledWith(1, 'manual-abc', { title: '深夜歌回' })
  })

  it('清空结束时间（弹层里的「清除」）→ end_at: null（"改回进行中"，与"没传"不是一回事）', async () => {
    render(MANUAL)
    await clearTime('lc-ms-end')
    await click(saveBtn())
    expect(updateMock.mock.calls[0][2]).toEqual({ end_at: null })
  })

  it('★ 结束时间的起算日 = 开始那一刻那天（清空之后又填回来时不用再猜哪一天）', async () => {
    render(MANUAL)                       // 开始 = 2026-10-08 20:00
    await clearTime('lc-ms-end')
    await click(timeField('lc-ms-end'))
    // 清空之后日历仍停在开始那一天所在月 ⇒ 直接点 09 就是 10-09
    await click(document.querySelector<HTMLButtonElement>('[data-dtp-day="2026-10-09"]')!)
    expect(timeValue('lc-ms-end')).toBe('2026-10-09T22:00')
  })

  it('④ 自动抓来的场次：时间/标题不可改 + 说明；录播可改；没有删除按钮', async () => {
    render(AUTO)
    expect(timeField('lc-ms-start').disabled).toBe(true)
    expect(timeField('lc-ms-end').disabled).toBe(true)
    expect(input('lc-ms-title').disabled).toBe(true)
    expect(input('lc-ms-vod').disabled).toBe(false)
    expect(document.querySelector('.lc-ms-note')?.textContent).toContain('只能补录播地址')
    expect(delBtn()).toBeNull()
    // 禁用的字段点不开弹层（不是"开出来但改不动"）
    await click(timeField('lc-ms-start'))
    expect(pop()).toBeNull()

    type(input('lc-ms-vod'), 'BV1xx411c7mD')
    await click(saveBtn())
    expect(updateMock).toHaveBeenCalledWith(1, 'uuid-a', { vod_url: 'BV1xx411c7mD' })
  })

  it('⑤ 冲突（409）的中文原因显示在表单里，不当成"保存失败"吞掉', async () => {
    updateMock.mockRejectedValue(
      new Error('这段时间已有场次：深夜杂谈 10-08 20:00–22:00（来源 danmakus，live_id=uuid-a）'))
    render(MANUAL)
    type(input('lc-ms-title'), '换个名字')
    await click(saveBtn())
    expect(errorText()).toContain('这段时间已有场次：深夜杂谈')
    expect(errorText()).toContain('live_id=uuid-a')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('⑥ 删除要两步确认，确认后回调把这一场从界面上摘掉', async () => {
    render(MANUAL)
    await click(delBtn()!)                                  // 第一步：只是展开确认
    expect(deleteMock).not.toHaveBeenCalled()
    await click(document.querySelector<HTMLButtonElement>('.lc-ms-btn.danger')!)
    expect(deleteMock).toHaveBeenCalledWith(1, 'manual-abc')
    expect(onDeleted).toHaveBeenCalledWith('manual-abc')
  })
})

describe('⑦ 退场动画的前提（与详情弹窗同一条纪律）', () => {
  it('真 CSS 里声明了 `.lc-ms` 的退场动画 —— 没有它 Radix 会当场卸载（"一闪就没了"）', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/posts.css'), 'utf8')
    expect(
      /\.lc-ms\[data-state='closed'\]\s*\{[^}]*animation:/.test(css),
      '缺这条 ⇒ Radix 的 Presence 找不到 animationend ⇒ 关闭瞬间卸载',
    ).toBe(true)
  })
})

describe('⑧ 定位契约：面板的 `fixed` 只能来自 DialogContent（2026-10-13，devlog/476）', () => {
  it('`.lc-ms` 自己**不许**声明 `position`', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/posts.css'), 'utf8')
    const block = /^\.lc-ms\s*\{([^}]*)\}/m.exec(css)
    expect(block, 'posts.css 里找不到 `.lc-ms { … }` 这一块').toBeTruthy()
    // ⚠️ 这条不是洁癖，是**实测出来的那两个毛病**：曾被写成 `position: relative`（为了让
    //    `z-index: 61` 生效），而 posts.css 是**无层级**样式、Tailwind 的 `.fixed` 在
    //    `@layer utilities` 里 —— 层叠里层级先于特异性 ⇒ `relative` 压掉了 `fixed`。
    //    面板于是成了 portal div 里的普通流一块（排在满视口的 `#root` 之后 ⇒ 落在首屏下方，
    //    "有遮罩没小窗"），Chrome 再把 body 滚 486px 去够聚焦的输入框（"弹窗把页面挤上去了"）。
    expect(
      /\bposition\s*:/.test(block![1]),
      '`.lc-ms` 不许写 position —— 写了就会压掉 DialogContent 的 `fixed`（见 posts.css 那段注释）',
    ).toBe(false)
  })

  it('DialogContent 的基础类里确实有 `fixed`（上一条的**前提**，缺了就两头落空）', () => {
    const tsx = readFileSync(resolve(__dirname, '../ui/dialog.tsx'), 'utf8')
    expect(tsx.includes('"fixed top-[50%]')).toBe(true)
  })
})
