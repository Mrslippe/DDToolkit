// @vitest-environment jsdom
/**
 * `ProxyImage` 的四级回落链（A0，devlog/255）。
 *
 * 这条链是**这次事故的正面教训**：远端 URL 会死（实测某 V 选中的微博头像签名过期 21 小时，
 * 当时只靠 `/img-proxy` 缓存续命），而盘上那份**一直在** ——
 * 所以「直连 → 代理 → **本地** → 占位」里那一级"本地"必须有判据盯着，
 * 否则它会像 R46 那次一样：看代码"写了"，实际没接上。
 *
 * 手法与 `components/avatarVersions.test.tsx` 一致：jsdom + `react-dom/client` + `act`。
 * ⚠️ React 的 `onError` 属于**非委托**事件（直接挂在元素上）⇒ 直接 `img.dispatchEvent(new Event('error'))`
 *    就能触发，不需要冒泡。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/api', () => ({
  imgProxyUrl: (s: string) => `/api/img-proxy?url=${encodeURIComponent(s)}`,
  resolveAsset: (p: string | null | undefined) => (p ? `/api/${p}` : undefined),
}))

import ProxyImage from './ProxyImage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const img = () => host.querySelector('img')
const stage = () => img()?.getAttribute('data-src-stage') ?? null
const fail = () => act(() => { img()?.dispatchEvent(new Event('error')) })

function render(props: Record<string, unknown>) {
  act(() => {
    root.render(<ProxyImage alt="" {...props} />)
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('ProxyImage 的四级回落（A0）', () => {
  it('每一级都挂 `data-self-healing`（否则整页过期图会弹一份报告，devlog/318）', () => {
    // `bootDiag` 只对 `closest('[data-self-healing]')` 的资源失败"只记账不弹面板"。
    // 本组件的回落链**每一步失败都是设计的正常一环**；没有这个标记时，一页 7 张签名过期的图
    // （直连+代理各失败一次）会被算成 14 次"系统性资源故障" ⇒ 用户看到一份 14 条的报错报告。
    render({ src: 'https://i0.hdslb.com/a.jpg', fallback: <span>占位</span> })
    expect(img()?.getAttribute('data-self-healing'), '直连那一级').toBe('1')
    void fail()
    expect(img()?.getAttribute('data-self-healing'), '代理那一级').toBe('1')
    void fail()
    expect(host.querySelector('[data-self-healing]'), '占位那一级').toBeTruthy()
  })

  it('没有 fallbackSrc ⇒ 保持原来的两级：直连 → 代理 → 占位', () => {
    render({ src: 'https://i0.hdslb.com/a.jpg', fallback: <span>占位</span> })
    expect(stage()).toBe('direct')
    expect(img()?.getAttribute('src')).toBe('https://i0.hdslb.com/a.jpg')
    void fail()
    expect(stage()).toBe('proxy')
    expect(img()?.getAttribute('src')).toContain('/api/img-proxy')
    void fail()
    expect(img()).toBeNull()                       // 四级走完 ⇒ 交给 fallback
    expect(host.textContent).toContain('占位')
  })

  it('**给了 fallbackSrc ⇒ 代理失败后落到本地**（远端死了也画得出）', () => {
    render({
      src: 'https://tvax1.sinaimg.cn/a.jpg?Expires=1&ssig=x',
      fallbackSrc: 'http://127.0.0.1:9/static/avatars/a_local.jpg',
      fallback: <span>占位</span>,
    })
    // 微博图床：首帧就走代理（R46 那条主机规则）
    expect(stage()).toBe('proxy')
    void fail()
    expect(stage()).toBe('local')
    expect(img()?.getAttribute('src')).toBe('http://127.0.0.1:9/static/avatars/a_local.jpg')
  })

  it('本地也失败 ⇒ 才轮到占位（顺序不许提前）', () => {
    render({
      src: 'https://x/a.jpg',
      fallbackSrc: 'http://127.0.0.1:9/static/avatars/a_local.jpg',
      fallback: <span>占位</span>,
    })
    void fail()                                    // 直连失败
    expect(stage()).toBe('proxy')
    expect(img()).not.toBeNull()
    void fail()                                    // 代理失败
    expect(stage()).toBe('local')
    expect(img()).not.toBeNull()
    void fail()                                    // 本地也失败
    expect(img()).toBeNull()
    expect(host.textContent).toContain('占位')
  })

  it('首帧的渲染决策仍挂在 `data-render-src` 上（R46 的探针判据靠它比左右同源）', () => {
    render({ src: 'https://wx1.sinaimg.cn/a.jpg', fallbackSrc: '/api/static/a.jpg' })
    expect(img()?.getAttribute('data-render-src')).toContain('/img-proxy')
    expect(img()?.getAttribute('data-render-src')).not.toContain('static/a.jpg')
  })

  it('没有 src 但有 fallbackSrc ⇒ 仍然只渲染占位（本地不能凭空当"要显示的那张"）', () => {
    render({ src: null, fallbackSrc: '/api/static/a.jpg', fallback: <span>占位</span> })
    expect(img()).toBeNull()
    expect(host.textContent).toContain('占位')
  })
})

/**
 * `onAllFailed`（2026-10-04，devlog/320）：**四级真的走完**时才通知调用方一次。
 *
 * 详情页拿它触发"打开时重取"（图床签名过期只能回源重签）。判据是两件事：
 * ① 中间级不算（直连失败转代理是设计好的一环，报了就会把上游打爆）；
 * ② 同一张图只报一次（浏览器对同一个坏 src 会重复报错，而"再重取一次"没有意义）。
 */
describe('ProxyImage · 全失败回调 onAllFailed', () => {
  it('中间级**不**回调；四级走完才回调一次', () => {
    const onAllFailed = vi.fn()
    render({ src: 'https://i0.hdslb.com/a.jpg', onAllFailed, fallback: <span>占位</span> })
    void fail()                                    // 直连 → 代理
    expect(onAllFailed, '代理那一跳还没试呢').not.toHaveBeenCalled()
    void fail()                                    // 代理 → 占位
    expect(onAllFailed).toHaveBeenCalledTimes(1)
  })

  it('有本地副本时也不回调（本地兜住了就不算"全失败"）', () => {
    const onAllFailed = vi.fn()
    render({
      src: 'https://i0.hdslb.com/a.jpg',
      fallbackSrc: 'http://127.0.0.1:9/static/a_local.jpg',
      onAllFailed, fallback: <span>占位</span>,
    })
    void fail()                                    // 直连 → 代理
    void fail()                                    // 代理 → 本地
    expect(onAllFailed).not.toHaveBeenCalled()
    expect(stage()).toBe('local')
  })

  it('本地也没兜住 ⇒ 回调一次；再失败（浏览器会重复报同一个 src）也只算一次', () => {
    const onAllFailed = vi.fn()
    render({
      src: 'https://i0.hdslb.com/a.jpg',
      fallbackSrc: 'http://127.0.0.1:9/static/a_local.jpg',
      onAllFailed, fallback: <span>占位</span>,
    })
    void fail()                                    // 直连 → 代理
    void fail()                                    // 代理 → 本地
    void fail()                                    // 本地 → 占位
    expect(onAllFailed).toHaveBeenCalledTimes(1)
    // 已经落到占位了：就算再来一次 error（不可能，但状态机不许因此重复上报）
    void fail()
    expect(onAllFailed).toHaveBeenCalledTimes(1)
  })

  it('没给 onAllFailed 也不炸（可选回调，别的调用方不需要它）', () => {
    render({ src: 'https://i0.hdslb.com/a.jpg', fallback: <span>占位</span> })
    void fail()
    expect(() => fail()).not.toThrow()
    expect(host.textContent).toContain('占位')
  })
})
