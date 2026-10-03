// @vitest-environment jsdom
/**
 * DASH 双元素模式 + 清晰度菜单（devlog/290）。
 *
 * 为什么双元素：实测 B站给的是**裸 fMP4**（`ftyp+moov+sidx+moof+mdat`），没有 MPD ⇒
 * dash.js/MSE 不适用；视频轨静音播、音轨单独播并由我们纠偏，原生 `buffered/seekable` 全保住。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import VideoPlayer, { driftAction } from './VideoPlayer'
import { resetPlayerPrefs, setPlayerPrefs } from '../utils/playerPrefs'

vi.mock('../utils/shellBridge', () => ({ openExternal: () => Promise.resolve() }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  resetPlayerPrefs()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const DASH = {
  video: 'https://cn-gddg-ct-01-12.bilivideo.com/v.m4s?sign=x',
  audio: 'https://cn-gddg-ct-01-12.bilivideo.com/a.m4s?sign=x',
}

describe('VideoPlayer · DASH 双元素', () => {
  it('视频轨 + 音轨各一条、**两条都走本机代理**；静音同时落在两个元素上', async () => {
    act(() => root.render(
      <VideoPlayer video={{ url: DASH.video }} dash={DASH} poster="http://x/c.webp" />))

    const v = host.querySelector('video')!
    const a = host.querySelector('audio')!
    // ⚠️ 代理 URL **必须带 `apiBase`**（这里默认 `/api`）：写成相对的 `/video-proxy?…` 会落在
    //    页面来源上（dev 的 vite / 桌面的 tauri://localhost）⇒ 每一段视频都 404。
    //    真机就是这么烧掉的（devlog/294），所以这里钉的是**完整前缀**，不是"能拼出来"。
    expect(v.getAttribute('src')).toBe(`/api/video-proxy?url=${encodeURIComponent(DASH.video)}`)
    expect(a.getAttribute('src')).toBe(`/api/video-proxy?url=${encodeURIComponent(DASH.audio)}`)
    expect(v.getAttribute('src')!.startsWith('/video-proxy'),
           '裸相对路径 = 落到前端自己身上').toBe(false)
    // ⚠️ 视频轨的 `muted` **跟着全局偏好走**（不再恒定 true）：小窗（画中画）那个静音按钮
    //    改的就是这个属性，恒定 true 会让它点了没用（devlog/299）。声音仍只在音轨上 ——
    //    B站 DASH 的视频轨本身不含音轨（音频是分开的那条流）。
    expect(v.muted, '默认不静音（跟随全局偏好）').toBe(false)
    setPlayerPrefs({ muted: true })
    await act(async () => { await Promise.resolve() })
    expect(a.muted, '静音要落在**真正出声的那个元素**上').toBe(true)
    expect(v.muted, '视频轨也要跟着静音（小窗图标才与真实状态一致）').toBe(true)
    setPlayerPrefs({ muted: false })
    await act(async () => { await Promise.resolve() })
    expect(a.muted).toBe(false)
    expect(v.hasAttribute('controls'), '仍是自绘控件').toBe(false)
  })

  it('seek 时音轨跟着跳（两条独立流不对齐就会不同步）', async () => {
    act(() => root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} />))
    const v = host.querySelector('video') as HTMLVideoElement
    const a = host.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(v, 'duration', { value: 100, configurable: true })
    await act(async () => { v.dispatchEvent(new Event('loadedmetadata')) })

    const bar = host.querySelector<HTMLDivElement>('.vp-progress')!
    bar.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 16,
      right: 100, bottom: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    await act(async () => {
      bar.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 30 }))
      await Promise.resolve()
    })
    expect(v.currentTime).toBeCloseTo(30, 1)
    expect(a.currentTime, '音轨没跟着跳 ⇒ 声音会停在原处').toBeCloseTo(30, 1)
  })

  it('镜像链：视频轨挂一条就换下一条（**各自换源**），音轨同理', async () => {
    // 真机现场（devlog/294）：`baseUrl` 全是 P2P/mcdn，普通 CDN 在备份里；后端排好序递过来。
    const alt = 'https://upos-sz-estgoss.bilivideo.com/v2.m4s?sign=y'
    const altA = 'https://upos-sz-estgoss.bilivideo.com/a2.m4s?sign=y'
    act(() => root.render(
      <VideoPlayer video={{ url: DASH.video }}
                   dash={{ ...DASH, videoFallbacks: [alt], audioFallbacks: [altA] }} />))

    const v = host.querySelector('video')!
    await act(async () => { v.dispatchEvent(new Event('error')); await Promise.resolve() })
    expect(host.querySelector('video')!.getAttribute('src'))
      .toBe(`/api/video-proxy?url=${encodeURIComponent(alt)}`)
    // 视频轨换源不该动音轨（两条独立流各有各的链）
    expect(host.querySelector('audio')!.getAttribute('src'))
      .toBe(`/api/video-proxy?url=${encodeURIComponent(DASH.audio)}`)

    await act(async () => {
      host.querySelector('audio')!.dispatchEvent(new Event('error'))
      await Promise.resolve()
    })
    expect(host.querySelector('audio')!.getAttribute('src'))
      .toBe(`/api/video-proxy?url=${encodeURIComponent(altA)}`)
  })

  it('链走完就交给调用方换内核（DASH → durl），不自己判死', async () => {
    const onFallback = vi.fn()
    act(() => root.render(
      <VideoPlayer video={{ url: DASH.video }} dash={DASH} onFallback={onFallback} />))
    await act(async () => {
      host.querySelector('video')!.dispatchEvent(new Event('error'))
      await Promise.resolve()
    })
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(host.querySelector('.vp-dead'), '还没换内核就显示"播不了"是抢跑').toBeNull()
  })
})

describe('VideoPlayer · 清晰度菜单', () => {
  const Q = [
    { id: 120, label: '4K', disabled: true, note: '需大会员' },
    { id: 80, label: '高清 1080P' },
    { id: 64, label: '高清 720P' },
  ]

  it('默认显示**实际拿到**的档；大会员档禁用并标注原因（不做成点了没反应）', async () => {
    const onPick = vi.fn()
    act(() => root.render(
      <VideoPlayer video={{ url: DASH.video }} qualities={Q} qualityId={80}
                   onPickQuality={onPick} />))

    expect(host.querySelector('button[aria-label="清晰度"]')?.textContent).toContain('1080P')
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="清晰度"]')!.click()
    })
    const items = [...host.querySelectorAll<HTMLButtonElement>('.vp-menu-item')]
    const fourK = items.find((i) => i.textContent?.includes('4K'))!
    expect(fourK.disabled, '拿不到的档必须禁用').toBe(true)
    expect(fourK.getAttribute('title')).toBe('需大会员')

    const hd = items.find((i) => i.textContent?.includes('1080P'))!
    await act(async () => { hd.click(); await Promise.resolve() })
    expect(onPick).toHaveBeenCalledWith(80)
  })

  it('大会员档用**一颗小图标**标注，档位名不换行（文字标注会把行撑成窄高条）', async () => {
    act(() => root.render(
      <VideoPlayer video={{ url: DASH.video }} qualities={Q} qualityId={80} />))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="清晰度"]')!.click()
    })
    const items = [...host.querySelectorAll<HTMLButtonElement>('.vp-menu-item')]
    const fourK = items.find((i) => i.textContent?.includes('4K'))!
    // 文字里**不再**出现"（需大会员）"；信息改走 title/aria-label，可访问性不丢
    expect(fourK.textContent, '档位名旁边不该再挂着那串文字').toBe('4K')
    expect(fourK.querySelector('.vp-crown'), '要有一颗表示大会员的小图标').toBeTruthy()
    expect(fourK.getAttribute('aria-label')).toContain('需大会员')
    expect(fourK.querySelector('.vp-crown')!.getAttribute('aria-hidden'), '图标别再念一遍')
      .toBe('true')

    // jsdom 不做布局 ⇒ "不换行"只能在真 CSS 里钉
    const css = readFileSync(resolve(__dirname, '../styles/posts.css'), 'utf8')
    const item = css.match(/\.vp-menu-item \{[^}]*\}/)?.[0] ?? ''
    expect(item, '.vp-menu-item 缺 white-space: nowrap ⇒ 档位名会换行').toContain('nowrap')
    const rate = css.match(/\.vp-rate \{[^}]*\}/)?.[0] ?? ''
    expect(rate, '.vp-rate 要一行内联排布（否则"1×"会被挤到下一行）').toContain('inline-flex')
  })
})

describe('VideoPlayer · 自动起播与底栏排布（devlog/295）', () => {
  it('`autoPlay` ⇒ 地址就绪即播（"只出界面不播"是用户否掉的那一版）', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    act(() => root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} autoPlay />))
    const tags = (m: typeof play) => m.mock.contexts.map((el) => (el as HTMLMediaElement).tagName)
    expect(play, '挂载后视频轨应立刻起播').toHaveBeenCalled()
    expect(tags(play)).toContain('VIDEO')
    // ⚠️ 音轨**不跟着立刻起**：它瞬间就能出声、视频轨还要缓冲 ⇒ 先出声就会"开头听两遍"
    //（devlog/298）。要等视频轨的 `playing`（真的出画）。
    expect(tags(play), '出画之前音轨不许出声').not.toContain('AUDIO')

    const v = host.querySelector('video')!
    Object.defineProperty(v, 'readyState', { value: 2, configurable: true })
    await act(async () => { v.dispatchEvent(new Event('playing')); await Promise.resolve() })
    expect(tags(play), '视频轨出画后音轨立刻跟上').toContain('AUDIO')
    play.mockRestore()
  })

  it('音轨起播时**对齐到视频轨当前时刻**（不是从 0 开始）', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    act(() => root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} autoPlay />))
    const v = host.querySelector('video') as HTMLVideoElement
    const a = host.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(v, 'currentTime', { value: 3.5, writable: true, configurable: true })
    Object.defineProperty(v, 'readyState', { value: 2, configurable: true })
    await act(async () => { v.dispatchEvent(new Event('playing')); await Promise.resolve() })
    expect(a.currentTime, '视频轨已经跑到 3.5s ⇒ 音轨必须从 3.5s 起').toBeCloseTo(3.5, 2)
    play.mockRestore()
  })

  it('不给 `autoPlay` ⇒ 不自动播（详情页里其它视频块仍等用户点一下）', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    act(() => root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} />))
    expect(play).not.toHaveBeenCalled()
    play.mockRestore()
  })

  it('音轨被**自动播放策略**拒绝 ⇒ 视频轨也停住（不留静音画面骗人）', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(function (this: HTMLMediaElement) {
        // 音轨（AUDIO）拒绝、视频轨（VIDEO）正常 —— 正是"没有用户手势时的自动播放"现场
        return this.tagName === 'AUDIO'
          ? Promise.reject(new DOMException('denied', 'NotAllowedError'))
          : Promise.resolve()
      })
    await act(async () => {
      root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} autoPlay />)
      await Promise.resolve()
    })
    // 音轨要等视频轨出画才起（devlog/298）⇒ 先让它 `playing`
    const v = host.querySelector('video')!
    Object.defineProperty(v, 'readyState', { value: 2, configurable: true })
    await act(async () => {
      v.dispatchEvent(new Event('playing'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(pause, '音轨进不去就必须把视频轨停住').toHaveBeenCalled()
    play.mockRestore()
    pause.mockRestore()
  })

  it('音轨是**瞬时**失败（`AbortError`：跳转后音轨还在 seek）⇒ **不许**暂停视频轨', async () => {
    // 真机事故（devlog/300）：点进度条跳到未缓存位置 ⇒ 音轨 play() 被 abort ⇒
    // 旧代码一律 `el.pause()` ⇒ 画面在放、界面显示"暂停"、还没声音。
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(function (this: HTMLMediaElement) {
        return this.tagName === 'AUDIO'
          ? Promise.reject(new DOMException('interrupted', 'AbortError'))
          : Promise.resolve()
      })
    await act(async () => {
      root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} autoPlay />)
      await Promise.resolve()
    })
    const v = host.querySelector('video')!
    Object.defineProperty(v, 'readyState', { value: 2, configurable: true })
    await act(async () => {
      v.dispatchEvent(new Event('playing'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(pause, '瞬时失败不能把画面停掉（那是"看起来暂停了"的来源）').not.toHaveBeenCalled()
    play.mockRestore()
    pause.mockRestore()
  })

  it('底栏永远一行：进度条可缩（`min-width: 0`）+ 按钮不换行', () => {
    const css = readFileSync(resolve(__dirname, '../styles/posts.css'), 'utf8')
    const bar = css.match(/\.vp-bar \{[^}]*\}/)?.[0] ?? ''
    expect(bar, '底栏要显式 nowrap').toContain('nowrap')
    const prog = css.match(/\.vp-progress \{[^}]*\}/)?.[0] ?? ''
    expect(prog, 'flex 项默认 min-width:auto ⇒ 档位名带空格时会把底栏撑溢出')
      .toContain('min-width: 0')
    const btn = css.match(/\.vp-btn \{[^}]*\}/)?.[0] ?? ''
    expect(btn).toContain('flex: none')
  })

  it('`loading` ⇒ 中央转圈，且大播放键**让位**（两者都在正中会叠起来）', () => {
    act(() => root.render(
      <VideoPlayer video={{ url: DASH.video }} dash={DASH} loading />))
    expect(host.querySelector('.vp-spin')).toBeTruthy()
    expect(host.querySelector('.vp-bigplay'), '转圈时不该同时显示播放键').toBeNull()

    act(() => root.render(
      <VideoPlayer video={{ url: DASH.video }} dash={DASH} />))
    expect(host.querySelector('.vp-spin'), '不取流时不该有转圈').toBeNull()
    expect(host.querySelector('.vp-bigplay')).toBeTruthy()
  })
})

describe('VideoPlayer · seek 时音轨不许抢跑（devlog/297）', () => {  /** 铺一块 100px 宽、时长 100s 的进度条，并把视频轨钉在"正在 seek"的状态。 */
  async function mountAndSeekAt(ratio: number, opts: { seeking: boolean; playing: boolean }) {
    act(() => root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} />))
    const v = host.querySelector('video') as HTMLVideoElement
    const a = host.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(v, 'duration', { value: 100, configurable: true })
    Object.defineProperty(v, 'seeking', { value: opts.seeking, configurable: true })
    Object.defineProperty(v, 'paused', { value: !opts.playing, configurable: true })
    const pause = vi.spyOn(a, 'pause')
    const play = vi.spyOn(a, 'play')
    await act(async () => { v.dispatchEvent(new Event('loadedmetadata')) })
    const bar = host.querySelector<HTMLDivElement>('.vp-progress')!
    bar.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 16,
      right: 100, bottom: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    await act(async () => {
      bar.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ratio }))
      await Promise.resolve()
    })
    return { v, a, pause, play, bar }
  }

  it('视频轨还在 seek ⇒ 音轨**先停住**，绝不允许"声音先到、画面还在原地"', async () => {
    const { v, a, pause } = await mountAndSeekAt(30, { seeking: true, playing: true })
    expect(pause, 'seek 一开始就要把音轨闭上嘴').toHaveBeenCalled()
    expect(v.currentTime).toBeCloseTo(30, 1)
    // ⚠️ 关键断言：视频轨没到位之前，音轨**不许**被对齐到新位置
    expect(a.currentTime, '音轨抢跑到新位置 ⇒ 这期间听到的和看到的是两段').not.toBeCloseTo(30, 1)
  })

  it('视频轨 `seeked` 之后才对齐 + 复播（原来是"先跳完再纠正"，现在是"到位才出声"）', async () => {
    const { v, a, play } = await mountAndSeekAt(30, { seeking: true, playing: true })
    await act(async () => {
      Object.defineProperty(v, 'seeking', { value: false, configurable: true })
      v.dispatchEvent(new Event('seeked'))
      await Promise.resolve()
    })
    expect(a.currentTime, '到位后才把音轨拉齐').toBeCloseTo(30, 1)
    expect(play, '本来在播的 ⇒ 对齐后要接着播').toHaveBeenCalled()
  })

  it('拖拽中音轨保持静默，抬手后一次性对齐（不是每帧都去重设音轨）', async () => {
    const { v, a, play } = await mountAndSeekAt(10, { seeking: true, playing: true })
    const bar = host.querySelector<HTMLDivElement>('.vp-progress')!
    const pev = (type: string, x: number) => {
      const e = new Event(type, { bubbles: true }) as Event & { clientX: number; pointerId: number }
      e.clientX = x
      e.pointerId = 1
      return e
    }
    a.currentTime = 0
    await act(async () => {
      bar.dispatchEvent(pev('pointerdown', 10))
      await Promise.resolve()          // `dragging` 是 state：要让它落地再拖动
    })
    await act(async () => {
      bar.dispatchEvent(pev('pointermove', 50))
      bar.dispatchEvent(pev('pointermove', 70))
      await Promise.resolve()
    })
    expect(v.currentTime, '视频轨拖拽中实时跟随').toBeCloseTo(70, 1)
    expect(a.currentTime, '拖拽期间音轨一直静默（0）').toBeCloseTo(0, 1)

    await act(async () => {
      bar.dispatchEvent(pev('pointerup', 70))
      Object.defineProperty(v, 'seeking', { value: false, configurable: true })
      v.dispatchEvent(new Event('seeked'))
      await Promise.resolve()
    })
    expect(a.currentTime, '抬手 + 到位 ⇒ 一次对齐').toBeCloseTo(70, 1)
    expect(play).toHaveBeenCalled()
  })

  it('`seeked` 万一不来，兜底定时器也要把音轨放出来（别永远哑着）', async () => {
    vi.useFakeTimers()
    const { a } = await mountAndSeekAt(40, { seeking: true, playing: true })
    await act(async () => { vi.advanceTimersByTime(1600) })
    expect(a.currentTime, '兜底路径也要对齐').toBeCloseTo(40, 1)
    vi.useRealTimers()
  })
})

describe('VideoPlayer · 小窗（画中画）与缓冲（devlog/299）', () => {
  async function mountDash() {
    act(() => root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} />))
    const v = host.querySelector('video') as HTMLVideoElement
    const a = host.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(v, 'duration', { value: 100, configurable: true })
    await act(async () => { v.dispatchEvent(new Event('loadedmetadata')); await Promise.resolve() })
    return { v, a }
  }

  it('**任何来源的暂停都要带走音轨**（小窗按钮/系统媒体键都不经过我们的 toggle）', async () => {
    const { v, a } = await mountDash()
    const pause = vi.spyOn(a, 'pause')
    await act(async () => { v.dispatchEvent(new Event('pause')); await Promise.resolve() })
    expect(pause, '视频轨停了、音轨还在放 ⇒ 用户会听到"画面停着声音还在"').toHaveBeenCalled()
    expect(host.querySelector('.vp-bigplay'), '暂停后要露出播放键').toBeTruthy()
  })

  it('视频轨暂停时**漂移纠正必须停手**（否则音轨被每秒拽回冻结时间 = 一小段反复重放）', async () => {
    vi.useFakeTimers()
    const { v, a } = await mountDash()
    // 现场：小窗里暂停了 ⇒ 视频轨停在 10s，音轨还在 10.8s 往前跑
    Object.defineProperty(v, 'currentTime', { value: 10, writable: true, configurable: true })
    Object.defineProperty(a, 'currentTime', { value: 10.8, writable: true, configurable: true })
    Object.defineProperty(v, 'paused', { value: true, configurable: true })    // ← 暂停的是视频轨
    Object.defineProperty(a, 'paused', { value: false, configurable: true })
    a.playbackRate = 1
    await act(async () => { vi.advanceTimersByTime(3100) })
    expect(a.currentTime, '不许把音轨拽回冻结的画面时间（那正是"重复"的来源）').toBeCloseTo(10.8, 2)
    expect(a.playbackRate, '也不许再改速率').toBe(1)
    vi.useRealTimers()
  })

  it('小窗静音按钮（改的是视频元素）会回写全局偏好 ⇒ 真的静音', async () => {
    const { v, a } = await mountDash()
    expect(a.muted, '初始不静音').toBe(false)
    // 小窗那个按钮 = 切换 video.muted（浏览器行为），会触发 volumechange
    await act(async () => {
      v.muted = true
      v.dispatchEvent(new Event('volumechange'))
      await Promise.resolve()
    })
    expect(a.muted, '声音在音轨上 ⇒ 必须跟着静').toBe(true)
    await act(async () => {
      v.muted = false
      v.dispatchEvent(new Event('volumechange'))
      await Promise.resolve()
    })
    expect(a.muted, '取消静音也要跟着回来').toBe(false)
  })

  it('缓冲中显示转圈（点进度条跳转后是"在加载"，不是"暂停了"）', async () => {
    const { v } = await mountDash()
    expect(host.querySelector('.vp-spin'), '没缓冲时不该有转圈').toBeNull()
    await act(async () => { v.dispatchEvent(new Event('waiting')); await Promise.resolve() })
    const spin = host.querySelector('.vp-spin')!
    expect(spin, '缓冲要转圈').toBeTruthy()
    expect(spin.getAttribute('aria-label')).toBe('正在缓冲')
    expect(host.querySelector('.vp-bigplay'), '缓冲中别同时显示播放键（看着就像暂停了）').toBeNull()
    await act(async () => { v.dispatchEvent(new Event('canplay')); await Promise.resolve() })
    expect(host.querySelector('.vp-spin'), '能播了就该收起来').toBeNull()
  })
})

describe('VideoPlayer · 状态和解与控件自动隐藏（devlog/300）', () => {
  async function mountPlayingDash() {
    act(() => root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} />))
    const v = host.querySelector('video') as HTMLVideoElement
    const a = host.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(v, 'duration', { value: 200, configurable: true })
    Object.defineProperty(v, 'currentTime', { value: 5, writable: true, configurable: true })
    await act(async () => { v.dispatchEvent(new Event('loadedmetadata')); await Promise.resolve() })
    return { v, a }
  }

  it('`timeupdate` 是**和解心跳**：画面在放而状态说暂停时，会自动纠正回来', async () => {
    const { v } = await mountPlayingDash()
    // 现场：某次 `pause` 之后没有配对的 `play`（跳转/被 abort/换源都可能）⇒ 状态停在暂停
    await act(async () => { v.dispatchEvent(new Event('pause')); await Promise.resolve() })
    expect(host.querySelector('.vp-bigplay'), '先确认它确实显示成暂停了').toBeTruthy()

    Object.defineProperty(v, 'paused', { value: false, configurable: true })   // 元素其实在放
    await act(async () => { v.dispatchEvent(new Event('timeupdate')); await Promise.resolve() })
    expect(host.querySelector('.vp-bigplay'), '和解之后不该再显示播放键').toBeNull()
    expect(host.querySelector('.vp')!.getAttribute('data-vp-state')).toBe('playing')
  })

  it('`timeupdate` 也会**把音轨叫回来**（跳转后音轨 play 被 abort 造成的静音）', async () => {
    const { v, a } = await mountPlayingDash()
    Object.defineProperty(v, 'paused', { value: false, configurable: true })
    Object.defineProperty(a, 'paused', { value: true, configurable: true })
    const play = vi.spyOn(a, 'play')
    await act(async () => { v.dispatchEvent(new Event('timeupdate')); await Promise.resolve() })
    expect(play, '视频在放、音轨停着 ⇒ 和解时要把它拉起来').toHaveBeenCalled()
    play.mockRestore()
  })

  it('控件自动隐藏：停手 3 秒才收，指针压在底栏上时**永不收**', async () => {
    vi.useFakeTimers()
    const { v } = await mountPlayingDash()
    Object.defineProperty(v, 'paused', { value: false, configurable: true })
    await act(async () => { v.dispatchEvent(new Event('play')); await Promise.resolve() })
    const wrap = host.querySelector('.vp')!
    const bar = host.querySelector('.vp-bar')!

    expect(wrap.classList.contains('is-idle'), '刚进来是显示的').toBe(false)
    await act(async () => { wrap.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) })
    await act(async () => { vi.advanceTimersByTime(3100) })
    expect(wrap.classList.contains('is-idle'), '停手 3 秒 ⇒ 收起').toBe(true)

    // ⚠️ React 的 `onMouseEnter/Leave` 是**合成**的（监听 mouseover/mouseout + 比 relatedTarget）
    //    ⇒ 测试里必须发 mouseover/mouseout 并带上"从哪来/到哪去"，直接发 mouseenter 不会命中。
    const enter = (t: Element, from: Element) =>
      t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }))
    const leave = (t: Element, to: Element) =>
      t.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }))

    // 指针压到底栏上：立刻显示，并且**再久也不收**（用户口径的那一半）
    await act(async () => {
      enter(bar, document.body)
      await Promise.resolve()
    })
    expect(wrap.classList.contains('is-idle'), 'hover 底栏要显示').toBe(false)
    await act(async () => { vi.advanceTimersByTime(9000) })
    expect(wrap.classList.contains('is-idle'), 'hover 期间不许收').toBe(false)

    // 离开底栏 ⇒ 重新开始计时
    await act(async () => {
      leave(bar, document.body)
      await Promise.resolve()
    })
    await act(async () => { vi.advanceTimersByTime(3100) })
    expect(wrap.classList.contains('is-idle'), '离开底栏 3 秒后收起').toBe(true)
    vi.useRealTimers()
  })

  it('暂停时永远不收控件（要能看见播放键）', async () => {
    vi.useFakeTimers()
    const { v } = await mountPlayingDash()
    Object.defineProperty(v, 'paused', { value: true, configurable: true })
    const wrap = host.querySelector('.vp')!
    await act(async () => { wrap.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) })
    await act(async () => { vi.advanceTimersByTime(9000) })
    expect(wrap.classList.contains('is-idle')).toBe(false)
    vi.useRealTimers()
  })
})

describe('VideoPlayer · 缓冲治理与下边缘豁免（devlog/301）', () => {
  /** 造一个"能报缓冲"的元素：`buffered` = `[0, currentTime + ahead]`。 */
  function stubBuffered(v: HTMLVideoElement, ahead: () => number) {
    Object.defineProperty(v, 'buffered', {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => v.currentTime + ahead() },
    })
  }

  async function mountDash(opts: { ahead: () => number; playing: boolean }) {
    act(() => root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} />))
    const v = host.querySelector('video') as HTMLVideoElement
    const a = host.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(v, 'duration', { value: 300, configurable: true })
    Object.defineProperty(v, 'currentTime', { value: 100, writable: true, configurable: true })
    Object.defineProperty(v, 'paused', { value: !opts.playing, configurable: true })
    stubBuffered(v, opts.ahead)
    await act(async () => { v.dispatchEvent(new Event('loadedmetadata')); await Promise.resolve() })
    return { v, a }
  }

  it('饿住时**按住**（不许一帧一帧横跳），缓冲够了自动放开', async () => {
    vi.useFakeTimers()
    let ahead = 0.2                       // 饿着
    const { v } = await mountDash({ ahead: () => ahead, playing: true })
    const pause = vi.spyOn(v, 'pause')
    const play = vi.spyOn(v, 'play')
    await act(async () => { v.dispatchEvent(new Event('waiting')); await Promise.resolve() })
    expect(pause, '前方不足半秒 ⇒ 先按住，别让它一帧一帧地跑').toHaveBeenCalled()
    expect(host.querySelector('.vp-spin'), '按住期间要有转圈').toBeTruthy()

    // 缓冲长到 2 秒以上 ⇒ 放开
    ahead = 3.0
    Object.defineProperty(v, 'paused', { value: true, configurable: true })
    await act(async () => { vi.advanceTimersByTime(400) })
    expect(play, '缓冲够了要自己放起来（不需要用户再点一次）').toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('**死锁兜底**：按住期间缓冲完全不涨 ⇒ 放开（实测暂停时浏览器不会继续拉缓冲）', async () => {
    vi.useFakeTimers()
    const { v } = await mountDash({ ahead: () => 0.1, playing: true })   // 永远不涨
    const play = vi.spyOn(v, 'play')
    await act(async () => { v.dispatchEvent(new Event('waiting')); await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(play, '一直等下去就是"永远加载中" —— 必须有兜底放开').toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('用户在按住期间自己按暂停 ⇒ 取消按住（别过一会儿又自己放起来）', async () => {
    vi.useFakeTimers()
    let ahead = 0.1
    const { v } = await mountDash({ ahead: () => ahead, playing: true })
    const play = vi.spyOn(v, 'play')
    await act(async () => { v.dispatchEvent(new Event('waiting')); await Promise.resolve() })
    await act(async () => {
      // ⚠️ 真浏览器里 `pause()` 会**异步派发一次 `pause` 事件**（规范：queue a media task）；
      //    测试替身不派发，所以要手动补上那一次 —— 组件靠它区分"我们自己按的"与"用户按的"。
      v.dispatchEvent(new Event('pause'))
      await Promise.resolve()
    })
    await act(async () => {
      Object.defineProperty(v, 'paused', { value: true, configurable: true })
      v.dispatchEvent(new Event('pause'))              // ← 这一次是用户按的
      await Promise.resolve()
    })
    play.mockClear()
    ahead = 5.0                                         // 缓冲后来够了
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(play, '用户按了暂停就不该被自动放起来').not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('全屏下贴**下边缘**不算离开：控件不被收起（那是要呼出它）', async () => {
    vi.useFakeTimers()
    const { v } = await mountDash({ ahead: () => 9, playing: true })
    await act(async () => { v.dispatchEvent(new Event('play')); await Promise.resolve() })
    const wrap = host.querySelector('.vp')!
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 600,
      width: 1000, height: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    // 鼠标甩到最下面（y=598，落在"下边缘热区"里），然后**离开播放器**
    await act(async () => {
      wrap.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 598 }))
      await Promise.resolve()
    })
    await act(async () => {
      wrap.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body,
                                                      clientY: 598 }))
      await Promise.resolve()
    })
    expect(wrap.classList.contains('is-idle'), '贴下边缘离开 ⇒ 豁免，不收起').toBe(false)
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(wrap.classList.contains('is-idle'), '指针还在下边缘热区 ⇒ 一直不收').toBe(false)

    // 从画面中间离开 ⇒ 照旧立刻收起
    await act(async () => {
      wrap.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 300 }))
      wrap.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body,
                                                      clientY: 300 }))
      await Promise.resolve()
    })
    expect(wrap.classList.contains('is-idle'), '从中间离开 ⇒ 立刻收起').toBe(true)
    vi.useRealTimers()
  })
})

describe('VideoPlayer · 音画漂移分级纠正（devlog/298）', () => {
  it('`driftAction`：小漂移改速率慢慢追、大漂移才跳、稳定时恢复倍速', () => {
    // 实测 19s 漂 0.28s：旧逻辑（>0.3 才动）刚好放过它 ⇒ 现在 0.28 会走"改速率"
    expect(driftAction(0.28, 1)).toEqual({ snap: false, rate: 1 * 0.97 })
    expect(driftAction(-0.28, 1)).toEqual({ snap: false, rate: 1 * 1.03 })
    expect(driftAction(0.8, 1)).toEqual({ snap: true, rate: 1 })
    expect(driftAction(-0.8, 1.5)).toEqual({ snap: true, rate: 1.5 })
    expect(driftAction(0.02, 1.25)).toEqual({ snap: false, rate: 1.25 })
    // 音轨超前（drift>0）⇒ 让音轨慢一点；落后 ⇒ 快一点（方向别写反）
    expect(driftAction(0.1, 1).rate).toBeLessThan(1)
    expect(driftAction(-0.1, 1).rate).toBeGreaterThan(1)
  })

  it('每秒跑一次纠正：中档漂移时把音轨速率调偏，稳定后恢复用户倍速', async () => {
    vi.useFakeTimers()
    act(() => root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} />))
    const v = host.querySelector('video') as HTMLVideoElement
    const a = host.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(v, 'currentTime', { value: 10, writable: true, configurable: true })
    Object.defineProperty(a, 'currentTime', { value: 10.2, writable: true, configurable: true })
    Object.defineProperty(a, 'paused', { value: false, configurable: true })   // 正在播才纠正
    Object.defineProperty(v, 'paused', { value: false, configurable: true })   // 视频轨也在播
    await act(async () => { vi.advanceTimersByTime(1100) })
    expect(a.playbackRate, '音轨超前 0.2s ⇒ 让它慢一点追').toBeLessThan(1)

    Object.defineProperty(a, 'currentTime', { value: 10.01, writable: true, configurable: true })
    await act(async () => { vi.advanceTimersByTime(1100) })
    expect(a.playbackRate, '已经齐了 ⇒ 回到用户倍速').toBe(1)
    vi.useRealTimers()
  })
})
