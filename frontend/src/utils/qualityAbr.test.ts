import { describe, expect, it } from 'vitest'

import { MAX_AUTO_DOWNGRADES, linkSlowNote, mbps, pickDowngrade } from './qualityAbr'

/**
 * 自动降档策略（ABR，`devlog/328`）。
 *
 * 判错一次的代价是**用户的画质无谓地掉**（或者该降的时候没降、继续卡），所以三条纪律
 * 各要一条判据：只降一级 / 不挑要大会员的档 / 有上限。
 */
const Q = [
  { id: 120, label: '超清 4K', disabled: true, note: '需大会员' },
  { id: 80, label: '高清 1080P' },
  { id: 64, label: '高清 720P' },
  { id: 32, label: '清晰 480P' },
  { id: 16, label: '流畅 360P', disabled: true, note: '需大会员' },
]

describe('自动降档：选哪一档', () => {
  it('只降**一级**（1080P ⇒ 720P，不是一步到 480P）', () => {
    expect(pickDowngrade(Q, 80)?.id).toBe(64)
    expect(pickDowngrade(Q, 64)?.id).toBe(32)
  })

  it('**不挑**要大会员/不可用的档（4K 与 360P 都是 disabled）', () => {
    // 当前在 720P ⇒ 更低的只有 480P（360P 不可选），不许挑 4K（它也不低于当前档）
    expect(pickDowngrade(Q, 64)?.id).toBe(32)
    // 当前在 480P ⇒ 更低的只剩不可选的 360P ⇒ 不降
    expect(pickDowngrade(Q, 32)).toBeNull()
  })

  it('已经在最低 / 没有档位信息 ⇒ 不降（不猜）', () => {
    expect(pickDowngrade(Q, 16)).toBeNull()
    expect(pickDowngrade(Q, null)).toBeNull()
    expect(pickDowngrade(null, 80)).toBeNull()
    expect(pickDowngrade([], 80)).toBeNull()
  })

  it('上限是 2（一次播放最多自动降两档）', () => {
    expect(MAX_AUTO_DOWNGRADES).toBe(2)
  })
})

describe('自动降档：给用户看的那句话', () => {
  it('说清"实测多少 / 这一档要多少 / 已降到哪档"', () => {
    const note = linkSlowNote(150_000, 400_000, '高清 1080P', '高清 720P')
    expect(note).toContain('1.2Mbps')
    expect(note).toContain('3.2Mbps')
    expect(note).toContain('高清 1080P')
    expect(note).toContain('已自动降到 高清 720P')
  })

  it('换算只有一份（`mbps`）', () => {
    expect(mbps(125_000)).toBe('1.0Mbps')
    expect(mbps(1_000_000)).toBe('8.0Mbps')
  })
})
