import { describe, expect, it } from 'vitest'
import {
  initialImageSrc, needsProxyFromStart, proxiedImageSrc, PROXY_FIRST_HOSTS,
} from './imageHost'

describe('needsProxyFromStart — 防盗链主机首帧就走代理', () => {
  it('微博图床两个域都算（sinaimg / wbcdn）', () => {
    expect(needsProxyFromStart('https://wx1.sinaimg.cn/orj360/a.jpg')).toBe(true)
    expect(needsProxyFromStart('https://tvax3.sinaimg.cn/large/a.jpg')).toBe(true)
    expect(needsProxyFromStart('https://foo.wbcdn.cn/a.jpg')).toBe(true)
  })

  it('http 也要认（归一化发生在后面，判断不能依赖它）', () => {
    expect(needsProxyFromStart('http://wx1.sinaimg.cn/a.jpg')).toBe(true)
  })

  it('其它图床不代理（B 站可直连，代理是 onError 的兜底而非常态）', () => {
    expect(needsProxyFromStart('https://i0.hdslb.com/bfs/face/a.jpg')).toBe(false)
    expect(needsProxyFromStart('https://example.com/a.jpg')).toBe(false)
  })

  it('空值一律 false（交给占位分支，别拼出代理空 URL）', () => {
    expect(needsProxyFromStart('')).toBe(false)
    expect(needsProxyFromStart('   ')).toBe(false)
    expect(needsProxyFromStart(null)).toBe(false)
    expect(needsProxyFromStart(undefined)).toBe(false)
  })

  it('规则表就是常量本身（加主机要改这一处，别在组件里另写 if）', () => {
    expect([...PROXY_FIRST_HOSTS]).toEqual(['sinaimg.cn', 'wbcdn.cn'])
  })
})

describe('initialImageSrc — 首帧 src 的唯一口径', () => {
  it('微博图床 ⇒ 代理 URL（带 /img-proxy 与编码后的原地址）', () => {
    const out = initialImageSrc('https://wx1.sinaimg.cn/orj360/a.jpg')
    expect(out).toContain('/img-proxy?url=')
    expect(decodeURIComponent(out!.split('url=')[1]))
      .toBe('https://wx1.sinaimg.cn/orj360/a.jpg')
  })

  it('其它主机 ⇒ https 归一化后的直连（不代理）', () => {
    expect(initialImageSrc('http://i0.hdslb.com/a.jpg')).toBe('https://i0.hdslb.com/a.jpg')
  })

  it('没图 ⇒ undefined（调用方渲染占位 / 首字兜底）', () => {
    expect(initialImageSrc('')).toBeUndefined()
    expect(initialImageSrc(null)).toBeUndefined()
    expect(initialImageSrc(undefined)).toBeUndefined()
  })

  it('先归一化再判主机：http 的微博地址也必须落到代理上', () => {
    expect(initialImageSrc('http://wx1.sinaimg.cn/a.jpg')).toContain('/img-proxy?url=')
  })
})

describe('proxiedImageSrc — 代理 URL 只在这里拼', () => {
  it('任何主机的地址都能拼成代理（onError 兜底对非微博图床也要用）', () => {
    expect(proxiedImageSrc('https://i0.hdslb.com/a.jpg')).toContain('/img-proxy?url=')
    expect(proxiedImageSrc('https://example.com/a.jpg')).toContain('/img-proxy?url=')
  })

  it('没图 ⇒ undefined', () => {
    expect(proxiedImageSrc('')).toBeUndefined()
    expect(proxiedImageSrc(null)).toBeUndefined()
  })
})
