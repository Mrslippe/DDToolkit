// @vitest-environment jsdom
/**
 * DASH 双元素模式 + 清晰度菜单（devlog/290）。
 *
 * 为什么双元素：实测 B站给的是**裸 fMP4**（`ftyp+moov+sidx+moof+mdat`），没有 MPD ⇒
 * dash.js/MSE 不适用；视频轨静音播、音轨单独播并由我们纠偏，原生 `buffered/seekable` 全保住。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
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
})
