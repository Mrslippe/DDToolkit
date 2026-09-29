// @vitest-environment jsdom
/**
 * 封面的取图口径（L3，devlog/261）：**本地优先**，远端兜底 —— 与头像**相反**。
 *
 * 为什么这条判据重要（规格 §3.3）：方向写反了不会报错，只会让列表首屏每次都先去撞一次
 * 图床防盗链（拿不到再回落），而我们**明明有一份本地副本**。探针那边量不到这个差别
 * （两条路最终都能画出图），所以必须在这里用纯函数钉住。
 */
import { describe, expect, it } from 'vitest'

import { resolveCoverSources } from './coverSource'

describe('resolveCoverSources — 本地优先（与头像相反的优先级）', () => {
  it('有本地副本 ⇒ src 用本地，远端退成兜底', () => {
    const out = resolveCoverSources({
      cover_url: 'https://i0.hdslb.com/bfs/archive/x.jpg',
      cover_local: 'static/assets/cover/12_ab12cd34.jpg',
    })
    expect(out.src, '本地优先写反了：把远端放进了 src').toContain(
      'static/assets/cover/12_ab12cd34.jpg')
    expect(out.src).not.toContain('hdslb.com')
    expect(out.fallback).toBe('https://i0.hdslb.com/bfs/archive/x.jpg')
  })

  it('没有本地副本 ⇒ 只有远端（没有兜底可言）', () => {
    const out = resolveCoverSources({ cover_url: 'https://i0.hdslb.com/bfs/archive/x.jpg' })
    expect(out.src).toBe('https://i0.hdslb.com/bfs/archive/x.jpg')
    expect(out.fallback).toBeUndefined()
  })

  it('封面为空但有正文图 ⇒ 用正文图（卡片自己的展示口径不变）', () => {
    const out = resolveCoverSources({}, 'https://i0.hdslb.com/bfs/archive/body.jpg')
    expect(out.src).toBe('https://i0.hdslb.com/bfs/archive/body.jpg')
  })

  it('本地优先时，正文图也要能当兜底（cover_url 为空的情况）', () => {
    const out = resolveCoverSources(
      { cover_local: 'static/assets/cover/9_ff.jpg' },
      'https://i0.hdslb.com/bfs/archive/body.jpg')
    expect(out.src).toContain('static/assets/cover/9_ff.jpg')
    expect(out.fallback).toBe('https://i0.hdslb.com/bfs/archive/body.jpg')
  })

  it('空白串不算"有本地副本"（`"  "` 会让 src 变成一个坏地址）', () => {
    const out = resolveCoverSources({ cover_url: 'https://x/a.jpg', cover_local: '   ' })
    expect(out.src).toBe('https://x/a.jpg')
    expect(out.fallback).toBeUndefined()
  })

  it('两样都没有 ⇒ src 为空（卡片走"纸张"占位分支）', () => {
    const out = resolveCoverSources({})
    expect(out.src).toBeUndefined()
    expect(out.fallback).toBeUndefined()
  })
})

describe('结构判据：PostCard 必须把兜底传下去', () => {
  it('PostCard 用 resolveCoverSources 且给 ProxyImage 传了 fallbackSrc', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const code = readFileSync(path.join(src, 'components', 'PostCard.tsx'), 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n')
    expect(code, 'PostCard 必须用 resolveCoverSources（口径只有一处）')
      .toContain('resolveCoverSources(')
    expect(code, 'ProxyImage 少了 fallbackSrc ⇒ 本地那份坏了就再也画不出封面')
      .toContain('fallbackSrc={cover.fallback}')
  })
})
