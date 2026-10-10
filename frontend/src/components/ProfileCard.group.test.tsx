// @vitest-environment jsdom
/**
 * 档案卡**企划格**的接线判据（2026-10-10 自审 F1，`devlog/461`）。
 *
 * ## 这条钉的是"同屏两处不能打架"
 *
 * `devlog/458` 把左栏的徽章 / 筛选项 / 筛选匹配统一到 `vtuberGroup()`（手填 `faction` 优先，
 * 否则自动检测的 `group_name`），但漏了**同一屏**的档案卡 —— 它仍然只读 `faction`。
 * 真机 14 个 V 里 **7 个**只有自动企划 ⇒ 左栏徽章写着「四禧丸子」、右栏档案卡写着「未设置」。
 *
 * ⚠️ 只测 `groupBadge` 纯函数的话，"档案卡压根没读那个字段"照样绿 ——
 * 所以这里必须把组件挂起来、读出触发按钮上的**文字**。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import ProfileCard from './ProfileCard'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = {
  id: 23, name: '又一充电中', birthday: null, debut_date: null, setting: null,
  avatar: null, background_path: null, background_focus: null,
  background_video_path: null, background_video_focus: null, notes: null,
  accounts: [], sign_override: null, sign_source_account_id: null,
}
const account = {
  id: 99, vtuber_id: 23, platform: 'bilibili', platform_uid: '1', room_id: '12345',
  display_name: '又一', avatar_url: null, signature: null, live_status: 0,
  live_title: null, live_url: null, last_fetched_at: null, sort_order: 0,
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** 企划那一格现在显示的文字（Radix 把选中项的文字渲染进 trigger） */
const triggerText = () =>
  host.querySelector<HTMLElement>('.profile-card-group-col button')?.textContent?.trim() ?? ''

async function mount(vtuber: Record<string, unknown>, thirdparty: unknown[] = []) {
  await act(async () => {
    root.render(
      <ProfileCard vtuber={vtuber as never} account={account as never}
                   thirdparty={thirdparty as never} />,
    )
  })
}

describe('档案卡的企划格（与左栏徽章同一口径）', () => {
  it('★ 只有自动企划（`faction` 为空、`group_name` 有值）：要显示那个企划并标「（自动）」', async () => {
    await mount({ ...base, faction: null, group_name: '四禧丸子' })
    expect(triggerText(), '档案卡只读 faction ⇒ 这里会显示「未设置」，而左栏徽章写着四禧丸子')
      .toBe('四禧丸子（自动）')
  })

  it('★ 手填优先：两者都有时显示手填值，且**不带**「（自动）」', async () => {
    await mount({ ...base, faction: '我填的', group_name: '自动的' })
    expect(triggerText()).toBe('我填的')
  })

  it('两者都没有：显示「未设置」且不出说明行', async () => {
    await mount({ ...base, faction: null, group_name: null })
    expect(triggerText()).toBe('未设置')
    expect(host.querySelector('.profile-card-group-hint')).toBeNull()
  })

  it('只有自动企划时给一行说明（解释"清空手填为什么清不掉"）', async () => {
    await mount({ ...base, faction: null, group_name: '四禧丸子' })
    const hint = host.querySelector('.profile-card-group-hint')
    expect(hint, '不给说明的话，用户选了「未设置」却看到值弹回来，会以为控件坏了').toBeTruthy()
    expect(hint!.textContent).toContain('自动')
  })

  it('手填有值时不出说明行（不影响有手填值的 V）', async () => {
    await mount({ ...base, faction: '我填的', group_name: '自动的' })
    expect(host.querySelector('.profile-card-group-hint')).toBeNull()
  })

  it('自动企划也是**可选项**之一（选中它即固化为手填）', async () => {
    await mount({ ...base, faction: null, group_name: '四禧丸子' })
    const btn = host.querySelector<HTMLButtonElement>('.profile-card-group-col button')!
    await act(async () => { btn.click() })          // 打开下拉
    const items = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .map((o) => o.textContent?.trim())
    expect(items).toContain('四禧丸子（自动）')
    expect(items).toContain('未设置')
  })

  it('第三方索引的建议与显示值不同 ⇒ 给「采纳」浮标；相同 ⇒ 不给（别让人白点一下）', async () => {
    const tp = [{ id: 1, group_name: 'EOE组合' }]
    await mount({ ...base, faction: null, group_name: '四禧丸子' }, tp)
    expect(host.textContent).toContain('采纳「EOE组合」')

    await mount({ ...base, faction: null, group_name: '四禧丸子' },
                [{ id: 1, group_name: '四禧丸子' }])
    expect(host.textContent, '建议与已显示的值一样时不该再挂一个浮标').not.toContain('采纳')
  })
})
