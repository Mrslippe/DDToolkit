// @vitest-environment jsdom
/**
 * 场次详情弹窗的**可访问性契约**（Q2，批次 14，devlog/217）。
 *
 * 这是本仓第一批 jsdom 组件用例 —— 起因是一个**验证盲区**：`--archive` / `--reservations`
 * 两个探针模式今天都跑不出日历（实测在**改动之前**就是红的，见 devlog/217 §五），
 * 于是"弹窗长什么样、键盘能不能用"在迁移前后**没有任何机器判据**。
 * 装 Testing Library 那一整套属于计划里"可缓"的相位，这里用最薄的组合：
 * `@vitest-environment jsdom` + `react-dom/client` + `act`，零新依赖。
 *
 * 钉住的六件事（前五件是手搓版**根本没有**的，第六件是迁移的**功能性修复**）：
 * ① `role=dialog` 且 **标题被关联**（`aria-labelledby` 指向真的标题文本）；
 * ② 副行是 `aria-describedby`；③ 初始焦点进弹窗；④ 背景被 `aria-hidden`（inert 语义）；
 * ⑤ 关闭后焦点**回原位**；⑥ **关闭时面板先留在 DOM 里**（播退场动画）而不是当场消失。
 *
 * ⚠️ ⑥ 依赖"CSS 给 `[data-state='closed']` 声明了动画"：Radix 的 `Presence` 靠
 * `animationend` 决定何时卸载，**没有动画就立刻卸载**。vitest 里不加载 `posts.css`，
 * 所以这里注入一条等价声明（并另有一条用例**直接检查真 CSS 里确实写了它**）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LiveSession, LiveSessionDetail } from '../../api/types'
import type { DetailState } from './useLiveSessions'

// 上游取数打网络：这里只关心弹窗骨架与键盘行为，统一给空结果
vi.mock('../../api/api', () => ({
  api: {
    liveSessionDetail: vi.fn(async () => null),
    buildLiveSessionWordCloud: vi.fn(async () => ({ wc_status: 'no_danmaku', top_words: [], top_keywords: [] })),
    liveSessionUpstream: vi.fn(async () => ({ danmaku: null, metrics: null, events: [] })),
  },
}))

import LiveSessionDialog from './LiveSessionDialog'

const SESSION = {
  account_id: 1,
  live_id: 'live-1',
  title: '周五歌回',
  start_at: '2026-09-04T12:00:00+00:00',
  end_at: '2026-09-04T14:00:00+00:00',
  source: 'danmakus',
  category: 'song',
  category_from: 'title',
} as unknown as LiveSession

/** 详情数据（`live_title` 在 `LiveSessionDetail` 上，列表行里叫 `title`） */
const DETAIL = {
  ...SESSION,
  live_title: '周五歌回',
  analysis: null,
} as unknown as LiveSessionDetail

/**
 * jsdom 少三样弹窗链路要用的浏览器 API（实测依次撞上：`ResizeObserver`
 * ← `OverlayScroll` / `matchMedia` ← Radix 的动画与指针判定 / `scrollTo`）。
 * 补最小实现即可：这些用例量的是 **DOM 与 aria**，不是滚动与媒体查询的真实行为。
 */
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

/**
 * React 18 要求显式声明"这是 act 环境" —— 不设的话，Radix 内部每次 setState
 * 都会刷一条 `not configured to support act(...)`（实测：这一条用例刷出几百行警告）。
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

/**
 * ⚠️ **必须替掉 `getComputedStyle` 的 `animationName`**（实测踩到，2026-09-26）：
 * jsdom **不解析注入 `<style>` 里的规则**（探针实测 `animationName === 'none'`），
 * 而 Radix 的 `Presence` 正是靠它判断"要不要等动画播完再卸载" —— 不替的话，
 * ⑤⑥ 两条测的不是"我们的 CSS 对不对"，而是"jsdom 支不支持样式表"，会假红。
 * 替法只动一个字段：`data-state=closed` 的元素报告一个动画名（真浏览器里由 posts.css 提供，
 * 那条声明本身另有 ⑦ 直接检查真 CSS）。
 */
const realGetComputedStyle = window.getComputedStyle.bind(window)
vi.stubGlobal('getComputedStyle', (el: Element, pseudo?: string | null) => {
  const cs = realGetComputedStyle(el, pseudo)
  if (el instanceof HTMLElement && el.dataset.state === 'closed') {
    Object.defineProperty(cs, 'animationName', { value: 'lc-dlg-pop-out', configurable: true })
  }
  return cs
})

const detailOf = (): DetailState => ({
  key: '2026-09-04', sessions: [SESSION], idx: 0, data: DETAIL, loading: false,
})

let host: HTMLDivElement
let outside: HTMLButtonElement
let root: Root
const onClose = vi.fn()

function render(detail: DetailState | null,
                extra: { onSessionChanged?: () => void } = {}) {
  act(() => {
    root.render(
      <LiveSessionDialog
        detail={detail}
        catPopOpen={false}
        setCatPopOpen={() => {}}
        catPopRef={{ current: null }}
        onClose={onClose}
        onSwitchIdx={() => {}}
        onPickCategory={() => {}}
        accountId={1}
        {...extra}
      />,
    )
  })
}

/** 面板（Radix 的内容元素）。⚠️ 用 `.lc-dlg` 而不是 `[role=dialog]`：探针也查这个类名。 */
const panel = () => document.querySelector<HTMLElement>('.lc-dlg')

let style: HTMLStyleElement

beforeEach(() => {
  // 等价于 posts.css 里给退场态写的那两条（Radix 靠它决定"还在播动画，先别卸载"）
  style = document.createElement('style')
  style.textContent = `
    @keyframes lc-dlg-pop-out { from { opacity: 1 } to { opacity: 0 } }
    .lc-dlg[data-state='closed'] { animation: lc-dlg-pop-out 0.16s both }
  `
  document.head.append(style)

  host = document.createElement('div')
  document.body.append(host)
  // 弹窗之外的一个可聚焦元素：用来验"关闭后焦点回原位"与"背景被隐藏"
  outside = document.createElement('button')
  outside.textContent = '外面的按钮'
  document.body.prepend(outside)
  root = createRoot(host)
  onClose.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  outside.remove()
  style.remove()
})

describe('场次详情弹窗（Radix Dialog）：a11y 契约', () => {
  it('① 标题被关联：aria-labelledby 指向真的标题文本', () => {
    render(detailOf())

    const dlg = document.querySelector('[role="dialog"]')
    expect(dlg).toBeTruthy()
    const labelledBy = dlg!.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent).toBe('周五歌回')  // ← 手搓版是裸 <span>
  })

  it('② 副行进 aria-describedby（日期 + 事件 key）', () => {
    render(detailOf())

    const dlg = document.querySelector('[role="dialog"]')!
    const describedBy = dlg.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toContain('2026-09-04')
  })

  it('③ 初始焦点进弹窗 ④ 背景被 aria-hidden（inert 语义）', () => {
    outside.focus()
    render(detailOf())

    expect(panel()?.contains(document.activeElement)).toBe(true)
    // Radix 的模态弹窗会把**兄弟节点**标记 aria-hidden（= 屏幕阅读器读不到背景）
    expect(outside.getAttribute('aria-hidden')).toBe('true')
  })

  it('⑤ 关闭后：背景解除 inert，焦点不再留在弹窗里', async () => {
    outside.focus()
    render(detailOf())
    expect(panel()?.contains(document.activeElement)).toBe(true)
    expect(outside.getAttribute('aria-hidden')).toBe('true')

    render(null)                              // 关：Radix 卸载面板
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(panel()).toBeFalsy()
    expect(outside.getAttribute('aria-hidden'), '关了之后背景还读不到 ⇒ inert 没解除')
      .not.toBe('true')
    // ⚠️ **焦点回原位（"回到打开它的那个按钮"）在 jsdom 里验不到**：实测关掉之后
    //    `activeElement` 是 `body` —— Radix 的恢复路径依赖它自己的卸载时序与真实焦点管理，
    //    jsdom 两样都不完整。这条属于 `TODO.md` §1.3 的人工键盘走查（打开→Esc→Tab 能继续走）。
    //    这里只钉"不会把焦点留在已经卸载的弹窗上"这一半。
    expect(host.contains(document.activeElement)).toBe(false)
  })

  it('Esc 走 Radix 的 onOpenChange（关闭请求交回父组件，且只交一次）', () => {
    render(detailOf())

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('关闭钮也走同一条路（`DialogClose`）', () => {
    render(detailOf())

    act(() => {
      document.querySelector<HTMLButtonElement>('.lc-dlg-close')!.click()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

/**
 * ⑥ 退场动画 —— **这条在 jsdom 里测不到，判据落在三处**（如实记下来，别再试一次）。
 *
 * 实测（2026-09-26）：Radix 的 `Presence` 靠 `getComputedStyle(el).animationName` 判断
 * "要不要等动画播完再卸载"，而 **jsdom 不解析注入的 `<style>`**（探针实测恒为 `none`）；
 * 连"替掉 `getComputedStyle` 的 animationName"都不够 —— 最小 Radix Dialog 也一样当场卸载。
 * ⇒ 这里改成三条**能站住**的判据：① 真 CSS 里必须有退场声明（Radix 找不到就会立刻卸载）；
 * ② 父组件**不再条件渲染**弹窗（不然连"关闭那一帧"都不存在）；
 * ③ 弹窗组件自己保留"最后一次非空 detail"用于那一帧。
 * **真机动效**仍属 `TODO.md` §1.3 的人工清单（`--archive` 探针模式今天跑不到日历，见 devlog/217 §五）。
 */
describe('⑥ 退场动画的前提（jsdom 测不到 Presence，改成三条静态判据）', () => {
  const css = readFileSync(resolve(__dirname, '../../styles/posts.css'), 'utf8')
  const dialogSrc = readFileSync(resolve(__dirname, './LiveSessionDialog.tsx'), 'utf8')
  const calendarSrc = readFileSync(resolve(__dirname, '../LiveCalendar.tsx'), 'utf8')

  it.each([
    ['.lc-dlg 面板', /\.lc-dlg\[data-state='closed'\]\s*\{[^}]*animation:/],
    ['.lc-dlg-backdrop 遮罩', /\.lc-dlg-backdrop\[data-state='closed'\]\s*\{[^}]*animation:/],
  ])('%s 在 CSS 里有退场动画声明', (_label, re) => {
    expect(re.test(css), '缺这条 ⇒ Radix 找不到动画 ⇒ 关闭瞬间卸载（用户看到"一闪就没了"）')
      .toBe(true)
  })

  it('父组件不再条件渲染弹窗（否则关闭那一帧根本不存在）', () => {
    expect(calendarSrc).toContain('<LiveSessionDialog')
    expect(calendarSrc, '又写回 `{detail && <LiveSessionDialog …》` ⇒ 退场动画没机会播')
      .not.toMatch(/\{detail\s*&&\s*\(?\s*<LiveSessionDialog/)
  })

  it('父组件不再用 Escape 关详情弹窗（否则会与 Radix 双重关闭）', () => {
    // ⚠️ 不能笼统禁 `'Escape'`：同文件里还有一个**浮层**（hover 出来的 `.lc-pop`）的
    //    Escape 处理，那个是它自己的、与该弹窗无关。这里只禁"Escape → setDetail"这条路。
    expect(calendarSrc, '两条关闭路径会打架：Radix 播它的退场，父组件的 keydown 把树拆掉')
      .not.toMatch(/key === 'Escape'[\s\S]{0,120}setDetail/)
  })

  it('弹窗组件保留"最后一次非空 detail"给关闭那一帧用', () => {
    expect(dialogSrc).toMatch(/const \[shown, setShown\] = useState<DetailState \| null>/)
    expect(dialogSrc).toMatch(/if \(detail\) setShown\(detail\)/)
  })
})

/**
 * 弹幕段的状态文案（2026-10-02，devlog/275）。
 *
 * 起因是用户报的一件事：「还在直播中的详情页显示的是『本场没有可用于统计的文本弹幕
 * 记录』」。原实现把三种情况压成一句话，而它们的**成因完全不同**：
 *   ① 还在直播 → danmakus 要等本场结束才固定化这一场（时序）；
 *   ② 上游确实没有这一场（事实）；
 *   ③ 这次没问到（WAF/网络）→ 可重试。
 * 三条文案各自钉一句，避免以后又被合并回去。
 */
describe('弹幕段：直播中 / 未收录 / 没问到 三种文案分得开', () => {
  const upstream = (danmaku: Record<string, unknown>) =>
    ({ danmaku: { top_words: [], top_keywords: [], ...danmaku }, metrics: null, events: [] })

  async function renderWith(danmaku: Record<string, unknown>,
                            session: Record<string, unknown> = {}) {
    const { api } = await import('../../api/api')
    vi.mocked(api.liveSessionUpstream).mockResolvedValue(upstream(danmaku) as never)
    render({
      ...detailOf(),
      data: { ...DETAIL, ...session } as unknown as LiveSessionDetail,
    })
    await act(async () => { await Promise.resolve() })
    return api
  }

  it('直播中：说「正在直播中」，不说"没有记录"', async () => {
    await renderWith({ wc_status: 'live' }, { end_at: null })

    const text = panel()?.textContent ?? ''
    expect(text).toContain('正在直播中')
    expect(text).not.toContain('上游尚未收录本场')
    expect(text).not.toContain('没有可用于统计')
  })

  it('已结束且上游未收录：说「上游尚未收录本场」并给「查一次」', async () => {
    const api = await renderWith({ wc_status: 'no_danmaku' })

    const text = panel()?.textContent ?? ''
    expect(text).toContain('上游尚未收录本场')
    const btn = [...panel()!.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('查一次'))
    expect(btn, '没有重试入口 ⇒ 用户只能关窗重开').toBeTruthy()

    // 点它必须**真的再问一次上游**（`refresh=true` 绕过后端 10 分钟节流）
    vi.mocked(api.liveSessionUpstream).mockClear()
    await act(async () => { btn!.click(); await Promise.resolve() })
    expect(vi.mocked(api.liveSessionUpstream))
      .toHaveBeenCalledWith(1, 'live-1', expect.anything(), true)
  })

  it('没问到：说「弹幕拉取失败」+「重试」', async () => {
    await renderWith({ wc_status: 'fetch_failed' })

    const text = panel()?.textContent ?? ''
    expect(text).toContain('弹幕拉取失败')
    expect(text).not.toContain('上游尚未收录本场')
  })

  it('上游没说"补到了行"（没有 session_changed）→ 不打扰父组件', async () => {
    const { api } = await import('../../api/api')
    vi.mocked(api.liveSessionUpstream).mockResolvedValue(
      upstream({ wc_status: 'upstream', top_words: [{ text: '好耶', count: 3 }] }) as never)
    const onSessionChanged = vi.fn()
    render(detailOf(), { onSessionChanged })

    await act(async () => { await Promise.resolve() })
    expect(onSessionChanged).not.toHaveBeenCalled()
  })

  it('现查补到了这一场（session_changed）→ 请父组件重取详情，且同一场只喊一次', async () => {
    const { api } = await import('../../api/api')
    vi.mocked(api.liveSessionUpstream).mockResolvedValue(
      { ...upstream({ wc_status: 'upstream' }), session_changed: true } as never)
    const onSessionChanged = vi.fn()
    render(detailOf(), { onSessionChanged })

    await act(async () => { await Promise.resolve() })
    expect(onSessionChanged).toHaveBeenCalledTimes(1)
    // 父组件因别的原因重渲染（回调每渲染都是新函数引用）也不该重复喊
    await act(async () => { await Promise.resolve() })
    expect(onSessionChanged).toHaveBeenCalledTimes(1)
  })
})
