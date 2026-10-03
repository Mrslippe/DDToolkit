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

import VideoPlayer from './VideoPlayer'
import { resetPlayerPrefs } from '../utils/playerPrefs'

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
  it('视频轨静音 + 音轨单独一条，且**两条都走本机代理**（CDN 不带 Referer 会 403）', () => {
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
    // ⚠️ React 把 `muted` 当**属性(property)**设，不一定落到 DOM attribute 上 ⇒ 读 property
    expect(v.muted, '视频轨不静音 ⇒ 会出双份声音').toBe(true)
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
  it('`autoPlay` ⇒ 地址就绪即播（"只出界面不播"是用户否掉的那一版）', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    act(() => root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} autoPlay />))
    expect(play, '挂载后应立刻起播').toHaveBeenCalled()
    // DASH 档：两条流**一起**起（只响画面没声音，比"没反应"更糟）
    const tags = play.mock.contexts.map((el) => (el as HTMLMediaElement).tagName)
    expect(tags).toContain('VIDEO')
    expect(tags).toContain('AUDIO')
    play.mockRestore()
  })

  it('不给 `autoPlay` ⇒ 不自动播（详情页里其它视频块仍等用户点一下）', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    act(() => root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} />))
    expect(play).not.toHaveBeenCalled()
    play.mockRestore()
  })

  it('音轨被自动播放策略拒绝 ⇒ **视频轨也停住**（不留静音画面骗人）', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(function (this: HTMLMediaElement) {
        // 音轨（AUDIO）拒绝、视频轨（VIDEO）正常 —— 正是"没有用户手势时的自动播放"现场
        return this.tagName === 'AUDIO' ? Promise.reject(new Error('NotAllowedError'))
          : Promise.resolve()
      })
    await act(async () => {
      root.render(<VideoPlayer video={{ url: DASH.video }} dash={DASH} autoPlay />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(pause, '音轨进不去就必须把视频轨停住').toHaveBeenCalled()
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
