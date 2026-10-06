// @vitest-environment jsdom
/**
 * 自绘播放器（devlog/283）的判据。要点：
 * - **不许退回原生控件**（`controls` 属性一出现，皮肤就白做了）；
 * - **音量全局共用**（用户口径：别一个响一个轻）；
 * - 播放/暂停、进度点选、倍速、fallback 链（含真失败才报错）；
 * - 全失败后的**重取**与"换地址归零"（devlog/363，见文件末尾那组）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import VideoPlayer from './VideoPlayer'
import { playerPrefs, resetPlayerPrefs } from '../utils/playerPrefs'
import { clearReports, reportEntries } from '../utils/problemReport'

vi.mock('../utils/shellBridge', () => ({ openExternal: () => Promise.resolve(),
  // B2（devlog/381）：进/出全屏时会调它切窗口表面；jsdom 里没有壳，给个空实现
  setSurfaceOpaque: () => Promise.resolve(true),
  surfaceState: () => 'unknown', surfaceEverOpaque: () => false }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  resetPlayerPrefs()
  clearReports()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // jsdom 不实现媒体播放：补最小桩（只验"我们有没有调对"）
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
  HTMLMediaElement.prototype.pause = vi.fn()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const VIDEO = { url: 'http://v/a.mp4', fallbacks: ['http://v/b.mp4'] }

function render(props: Record<string, unknown> = {}) {
  act(() => root.render(<VideoPlayer video={VIDEO} {...props} />))
}

const el = () => host.querySelector('video') as HTMLVideoElement

describe('VideoPlayer', () => {
  it('自绘控件：**没有 `controls` 属性**，且播放链带自愈标记', () => {
    render({ poster: 'http://x/c.webp' })
    expect(el().hasAttribute('controls'), '有 controls ⇒ 原生控件会盖掉我们的皮肤').toBe(false)
    expect(el().getAttribute('poster')).toBe('http://x/c.webp')
    expect(host.querySelector('[data-self-healing="1"]')).toBeTruthy()
  })

  it('点大播放键 ⇒ 进播放态（大键收起、底栏变"暂停"）；再点 ⇒ 回暂停态', async () => {
    // ⚠️ jsdom 不实现媒体播放（`play()`/`paused` 都是桩），**断言可观察的 UI 契约**而不是
    //    "有没有调 play" —— 后者在 jsdom 里要靠改原型/实例打桩，测的是桩不是组件
    //    （2026-10-03 实测：两种打桩法都得不到稳定结论）。
    render()
    const v = el()
    const big = host.querySelector<HTMLButtonElement>('.vp-bigplay')!
    await act(async () => {
      big.click()
      v.dispatchEvent(new Event('play'))
      await Promise.resolve()
    })
    expect(host.querySelector('.vp-bigplay'), '播放中不该还挂着大播放键').toBeFalsy()
    expect(host.querySelector('button[aria-label="暂停"]')).toBeTruthy()

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="暂停"]')!.click()
      v.dispatchEvent(new Event('pause'))
      await Promise.resolve()
    })
    expect(host.querySelector('button[aria-label="播放"]')).toBeTruthy()
  })

  it('**音量全局共用**：一个播放器改音量，另一个跟着变（并写进 localStorage）', async () => {
    const second = document.createElement('div')
    document.body.append(second)
    const root2 = createRoot(second)
    act(() => {
      root.render(<VideoPlayer video={VIDEO} />)
      root2.render(<VideoPlayer video={{ url: 'http://v/other.mp4' }} />)
    })
    const a = host.querySelector('video') as HTMLVideoElement
    const b = second.querySelector('video') as HTMLVideoElement
    const slider = host.querySelector<HTMLInputElement>('input[aria-label="音量"]')!

    await act(async () => {
      // React 认的是原生 setter 触发的 input 事件（直接改 .value 它看不见）
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value')!.set!
      setter.call(slider, '0.35')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })

    expect(playerPrefs().volume).toBeCloseTo(0.35, 5)
    expect(a.volume).toBeCloseTo(0.35, 5)
    expect(b.volume, '第二个播放器没跟着变 ⇒ 就是"一个响一个轻"').toBeCloseTo(0.35, 5)
    expect(JSON.parse(localStorage.getItem('ddtoolkit.player.prefs') || '{}').volume)
      .toBeCloseTo(0.35, 5)
    act(() => root2.unmount())
    second.remove()
  })

  it('倍速菜单：选 2× ⇒ playbackRate 立即生效（也是全局偏好）', async () => {
    render()
    await act(async () => { host.querySelector<HTMLButtonElement>('.vp-btn--text')!.click() })
    const items = [...host.querySelectorAll<HTMLButtonElement>('.vp-menu-item')]
    expect(items.map((i) => i.textContent)).toEqual(['0.5×', '1×', '1.5×', '2×'])
    await act(async () => { items[3].click(); await Promise.resolve() })
    expect(el().playbackRate).toBe(2)
    expect(playerPrefs().rate).toBe(2)
  })

  it('点进度条 ⇒ 按比例 seek（并显示 mm:ss/mm:ss）', async () => {
    render()
    const v = el()
    Object.defineProperty(v, 'duration', { value: 30, configurable: true })
    await act(async () => { v.dispatchEvent(new Event('loadedmetadata')) })
    const bar = host.querySelector<HTMLDivElement>('.vp-progress')!
    bar.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 16,
      right: 100, bottom: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    await act(async () => {
      bar.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50 }))
      await Promise.resolve()
    })
    expect(v.currentTime).toBeCloseTo(15, 1)
    expect(host.querySelector('.vp-time')?.textContent).toContain('/00:30')
  })

  it('跳转期间**先暂停**，到位后再接着放（用户口径，devlog/317）', async () => {
    // 「点击进度条跳转的时候先暂停视频，直到跳转完成后再开始播放，现在的情况是点击跳转后
    //   依旧会接着播放原先的内容直到跳转完成后再开始播放跳转之后的内容」
    render()
    const v = el()
    Object.defineProperty(v, 'duration', { value: 30, configurable: true })
    // 让"还在 seek"这件事可观察：jsdom 不实现 `seeking`，就按这条用例的需要固定成 true
    Object.defineProperty(v, 'seeking', { value: true, configurable: true })
    // ⚠️ 实例级桩 play/pause + 可变的 `paused`：这个文件在 beforeEach 里把原型上的两个方法
    //    换成了裸 `vi.fn()`（**不**维护 `paused`），只派发事件的话 `el.paused` 还是 true，
    //    组件就会短路掉"跳转先暂停"（那样测的是夹具不是组件）。
    let paused = true
    const calls: string[] = []
    Object.defineProperty(v, 'paused', { get: () => paused, configurable: true })
    v.pause = () => { paused = true; calls.push('pause') }
    v.play = () => { paused = false; calls.push('play'); return Promise.resolve() }
    await act(async () => {
      v.dispatchEvent(new Event('loadedmetadata'))
      void v.play()                               // 用户在播（意图 = 播）
      v.dispatchEvent(new Event('play'))
      await Promise.resolve()
    })
    calls.length = 0

    const bar = host.querySelector<HTMLDivElement>('.vp-progress')!
    bar.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 16,
      right: 100, bottom: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    await act(async () => {
      bar.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50 }))
      await Promise.resolve()
    })
    expect(calls, '点了跳转还在放旧内容 ⇒ 用户看到的那条').toContain('pause')
    expect(paused, '暂停要真的落在元素上').toBe(true)

    await act(async () => {
      v.dispatchEvent(new Event('seeked'))        // 到位 ⇒ 接着放
      await Promise.resolve()
    })
    expect(calls, '到位后不接着放 = 跳完停在那儿').toContain('play')
    expect(paused).toBe(false)
  })

  it('播完**不再转圈**：尾帧上只留"重新播放"（用户口径，devlog/318）', async () => {
    // 「视频播放完毕之后依旧会一直显示缓冲中转圈的图标，并且还在下面叠加了一个更大的播放按钮；
    //   我想要的效果是直接冻结在尾帧，并且用重新播放的按钮替代转圈缓冲按钮」
    render()
    const v = el()
    Object.defineProperty(v, 'duration', { value: 30, configurable: true })
    await act(async () => {
      v.dispatchEvent(new Event('loadedmetadata'))
      v.dispatchEvent(new Event('play'))
      v.dispatchEvent(new Event('waiting'))       // 尾帧前缓冲吃完 ⇒ 转圈亮起（真机就是这样）
      await Promise.resolve()
    })
    expect(host.querySelector('.vp-spin'), '饿住时该转').toBeTruthy()

    await act(async () => {
      v.dispatchEvent(new Event('ended'))
      await Promise.resolve()
    })
    expect(host.querySelector('.vp-replay'), '尾帧上给"重新播放"').toBeTruthy()
    expect(host.querySelector('.vp-spin'), '转圈要在播完那一刻**立刻**消失（不走 450ms 迟滞）')
      .toBeNull()
  })

  it('播完 ⇒ 冻结在尾帧 + 中央"重新播放"，点击从头播（devlog/317）', async () => {
    render()
    const v = el()
    Object.defineProperty(v, 'duration', { value: 30, configurable: true })
    await act(async () => {
      v.dispatchEvent(new Event('loadedmetadata'))
      v.dispatchEvent(new Event('ended'))
      await Promise.resolve()
    })
    const replay = host.querySelector<HTMLButtonElement>('.vp-replay')!
    expect(replay, '播完要有"重新播放"').toBeTruthy()
    expect(replay.getAttribute('aria-label')).toBe('重新播放')
    // ⚠️ 别用 `button[aria-label="播放"]` 判"大播放键还在不在"：底栏那颗播放键的
    //    无障碍名也是"播放"（这一批踩到）。要判的是**中央那一颗**。
    expect(host.querySelectorAll('.vp-bigplay:not(.vp-replay)').length,
           '两颗大键都在正中 ⇒ 会叠在一起').toBe(0)

    v.currentTime = 30
    const plays = vi.mocked(HTMLMediaElement.prototype.play)
    plays.mockClear()
    await act(async () => { replay.click(); await Promise.resolve() })
    expect(v.currentTime, '从头播').toBe(0)
    expect(plays).toHaveBeenCalled()
    expect(host.querySelector('.vp-replay'), '点了之后要收起').toBeNull()
  })

  it('进度条 hover ⇒ 出时间气泡（图二），默认是细线、hover 才变粗', async () => {
    render()
    const v = el()
    Object.defineProperty(v, 'duration', { value: 30, configurable: true })
    await act(async () => { v.dispatchEvent(new Event('loadedmetadata')) })

    const bar = host.querySelector<HTMLDivElement>('.vp-progress')!
    bar.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 16,
      right: 100, bottom: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    // ⚠️ 不在这里断言"未 hover 时没有气泡"：jsdom 里 `getBoundingClientRect` 的替换与
    //    React 的状态复用让那条前置断言不稳（跑一遍红一遍绿）；**只看两条正向契约**。
    await act(async () => {
      // ⚠️ hover 预览挂在 **pointermove** 上（拖拽 seek 与它共用一条路径，devlog/286）
      const e = new MouseEvent('pointermove', { bubbles: true, clientX: 40 })
      Object.defineProperty(e, 'pointerId', { value: 1 })
      bar.dispatchEvent(e)
      await Promise.resolve()
    })
    // 40% × 30s = 12s
    expect(host.querySelector('.vp-progress-tip')?.textContent).toBe('00:12')

    // ⚠️ React 的 `onMouseLeave` 是用 **mouseout + relatedTarget** 模拟的：派发裸 `mouseleave`
    //    它收不到（2026-10-03 踩到）
    await act(async () => {
      bar.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
      await Promise.resolve()
    })
    expect(host.querySelector('.vp-progress-tip')).toBeFalsy()
  })

  it('音量条在 hover 浮窗里（图三），喇叭图标按档位变', async () => {
    render()
    const pop = host.querySelector('.vp-volpop')
    expect(pop, '音量条要有浮窗容器（默认不占底栏）').toBeTruthy()
    expect(pop!.querySelector('input[aria-label="音量"]')).toBeTruthy()

    const volBtn = host.querySelector<HTMLButtonElement>('[data-vol-level]')!
    expect(volBtn.dataset.volLevel).toBe('high')          // 默认 100%

    const slider = host.querySelector<HTMLInputElement>('input[aria-label="音量"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(slider, '0.2')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(host.querySelector<HTMLButtonElement>('[data-vol-level]')!.dataset.volLevel).toBe('low')

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-vol-level]')!.click()
      await Promise.resolve()
    })
    expect(host.querySelector<HTMLButtonElement>('[data-vol-level]')!.dataset.volLevel).toBe('mute')
  })

  it('三处 CSS 契约（真机报过的问题）：浮窗"桥"、全屏原比例放大、进度条对称变粗', () => {
    // jsdom 不解析样式表，所以这里**直接读真 CSS**（与 LiveSessionDialog.test.tsx 同款做法）——
    // 这三条各自对应一个真机现象，改回去就红。
    const css = readFileSync(resolve(__dirname, '../styles/posts.css'), 'utf8')
    expect(css, '音量浮窗与按钮之间的缝没有桥 ⇒ 鼠标往上移时浮窗消失、够不着滑杆')
      .toMatch(/\.vp-volpop::after\s*\{[^}]*bottom:\s*-14px/)
    expect(css, '全屏没解除 max-height:60vh ⇒ 画面缩在中间、四周黑边')
      .toMatch(/\.vp:fullscreen \.vp-video\s*\{[^}]*max-height:\s*none/)
    expect(css, '全屏没写 object-fit:contain ⇒ 比例会被拉伸')
      .toMatch(/\.vp:fullscreen \.vp-video\s*\{[^}]*object-fit:\s*contain/)
    expect(css, '进度条三层锚点不一致 ⇒ 变粗时像"先上长 1px 再下长 1px"')
      .toMatch(/\.vp-progress::before[^{]*\{[^}]*top:\s*50%[^}]*translateY\(-50%\)/)
  })

  it('拖拽 seek：按下即定位、拖动中实时跟随、松手结束（devlog/286）', async () => {
    render()
    const v = el()
    Object.defineProperty(v, 'duration', { value: 100, configurable: true })
    await act(async () => { v.dispatchEvent(new Event('loadedmetadata')) })

    const bar = host.querySelector<HTMLDivElement>('.vp-progress')!
    bar.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 16,
      right: 100, bottom: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    const pev = (type: string, x: number) => {
      const e = new MouseEvent(type, { bubbles: true, clientX: x })
      Object.defineProperty(e, 'pointerId', { value: 1 })
      return e
    }
    await act(async () => {
      bar.dispatchEvent(pev('pointerdown', 20))
      await Promise.resolve()
    })
    expect(v.currentTime).toBeCloseTo(20, 1)
    expect(bar.classList.contains('is-dragging')).toBe(true)

    await act(async () => {
      bar.dispatchEvent(pev('pointermove', 70))       // 拖到 70%
      await Promise.resolve()
    })
    expect(v.currentTime, '拖动中要实时跟随').toBeCloseTo(70, 1)

    await act(async () => {
      bar.dispatchEvent(pev('pointerup', 70))
      await Promise.resolve()
    })
    expect(bar.classList.contains('is-dragging')).toBe(false)
  })

  it('直连全失败 ⇒ 换到本机代理；代理也失败 ⇒ 兜底并报一条', async () => {
    render()
    const seen: string[] = []
    for (let i = 0; i < 8; i += 1) {
      const v = el()
      if (!v) break
      seen.push(v.getAttribute('src') ?? '')
      await act(async () => { v.dispatchEvent(new Event('error')); await Promise.resolve() })
    }
    expect(seen[0]).toBe('http://v/a.mp4')
    expect(seen[1]).toBe('http://v/b.mp4')
    // 代理那两级必须带 `apiBase`（`/api`），不能是裸相对的 `/video-proxy`（devlog/294）
    expect(seen[2]).toBe('/api/video-proxy?url=http%3A%2F%2Fv%2Fa.mp4')
    expect(seen[3]).toBe('/api/video-proxy?url=http%3A%2F%2Fv%2Fb.mp4')
    expect(host.querySelector('.vp-dead')?.textContent).toContain('播不了')
    expect(reportEntries().some((r) => r.where === '视频播放')).toBe(true)
    // ⚠️ 这条报告**只能有一条**：以前写在渲染分支里，一次失败会随重渲染刷出好几条
    //    （真机报告里同一条 ×6，把原因淹了）。反向验证：把 effect 里的判断挪回渲染 ⇒ 红。
    expect(reportEntries().filter((r) => r.where === '视频播放').length,
           '同一条失败报告刷屏了').toBe(1)
  })
})

/**
 * **全失败之后的重取**（devlog/363，2026-10-06 用户实机报障）。
 *
 * 用户口径：「星瞳official 抖音这一帖，点开详情视频全部播放源都失败（含本机代理）」。
 * 真因是抖音的播放地址是**限时签名**的（`l=20261005191106…` = 签发时刻）——库里那条是
 * 入库当天签的，实测 8 小时后 CDN 一律 403；视频**不会被固化**（盘上没文件），
 * 所以第二天打开必然播不了。图床那条路早就接了"全失败 ⇒ 重取一次"（devlog/320），
 * 视频这条一直没接 ⇒ 用户只能看到一个死掉的播放器和"在浏览器打开"，无从知道重取就好。
 *
 * 这里判两件事：① 真的全试过才叫 `onAllFailed`（只叫一次，且不抢 `onFallback`）；
 * ② **换了地址就把序号与判死状态归零** —— 调用方重取回来是**原地换 prop**，不换 key。
 */
describe('VideoPlayer · 全失败后的重取（devlog/363）', () => {
  /** 把这一档的候选一条条打死（打到组件换成兜底卡为止） */
  async function killAll() {
    for (let i = 0; i < 8; i += 1) {
      const v = el()
      if (!v) break
      await act(async () => { v.dispatchEvent(new Event('error')); await Promise.resolve() })
    }
  }

  it('全部源都失败 ⇒ 叫一次 `onAllFailed`（调用方据此重取地址）', async () => {
    const onAllFailed = vi.fn()
    render({ onAllFailed })
    await killAll()
    expect(host.querySelector('.vp-dead'), '前置：这一轮确实全失败了').toBeTruthy()
    expect(onAllFailed, '没叫 ⇒ 播放地址过期后永远没人去重取').toHaveBeenCalledTimes(1)
  })

  it('给了 `onFallback`（B站 DASH→durl）⇒ **不叫** `onAllFailed`（换内核优先）', async () => {
    const onAllFailed = vi.fn()
    const onFallback = vi.fn()
    render({ onAllFailed, onFallback })
    await killAll()
    expect(onFallback, '前置：该交给调用方换内核').toHaveBeenCalled()
    expect(onAllFailed, 'DASH 挂了不等于"平台地址过期"，重取会白跑一趟').not.toHaveBeenCalled()
  })

  it('**换了地址就归零**：重取回来的新地址能直接播，不继承上一轮的判死与镜像序号', async () => {
    render()
    await killAll()
    expect(host.querySelector('.vp-dead')).toBeTruthy()
    const before = reportEntries().filter((r) => r.where === '视频播放').length

    // 调用方重取回来：**原地换 prop**（`PostDetailDrawer` 收到新帖就 `setPatched`，
    // 既不换 key 也不重新挂载），而且新候选往往**更少**（抖音详情常常只剩 `play_addr`）
    await act(async () => { render({ video: { url: 'http://v2/new.mp4' } }) })

    expect(host.querySelector('.vp-dead'), '换了新地址却还停在"播不了"兜底卡').toBeNull()
    expect(el()?.getAttribute('src'), '新地址要从第一面镜像重新试').toBe('http://v2/new.mp4')
    // 归零要是写在 effect 里，新地址会先按旧序号渲染一帧（那一帧就是兜底卡 + 一条假报告）
    expect(reportEntries().filter((r) => r.where === '视频播放').length,
           '换地址那一帧误报了一条"全部播放源都失败"').toBe(before)
  })
})
