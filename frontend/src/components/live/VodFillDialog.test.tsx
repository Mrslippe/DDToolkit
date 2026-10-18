// @vitest-environment jsdom
/**
 * 「录播填充」审查窗 `<VodFillDialog>`（B4，`docs/plans/vod-autofill.md`）。
 *
 * 用户 2026-10-15 拍板的口径是**先审查再写**（沿用 C1「误配比漏配更糟」）。
 * 所以判据盯的是"这条口径有没有被实现"，以及三类**会静默写错数据 / 静默失败**的：
 *
 * | 判据 | 坏了会怎样 |
 * |---|---|
 * | 打开即扫，结果摆成对照表 | 用户看到空白，不知道发生了什么 |
 * | ★ `auto_ok=false` 的行**默认不勾** | 兜底匹配（只靠"同一天+时长"）被默认写进去 = 误配 |
 * | ★ 只提交**勾中的**、且提交的是 `permalink` | 把没确认的写进去 / 写成 bvid（服务端能收，但两条路形态不一致） |
 * | 「换一条」切换后提交的是**备选** | 同场拆段时选不中想要的那条 |
 * | 扫描失败**不许**说成"没有录播" | 用户以为没戏，其实只是没问到 |
 * | 写入失败**逐条**列出原因 | 静默吞一半，用户不知道哪几条没成 |
 * | 没配上的一列要显示 | "只有对不上的才手动补"这条出口不见了 |
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VodScanResult } from '../../api/types'

vi.mock('../../api/api', () => ({
  api: { vodScan: vi.fn(), vodApply: vi.fn() },
}))

import { api } from '../../api/api'
import VodFillDialog from './VodFillDialog'

const scanMock = vi.mocked(api.vodScan)
const applyMock = vi.mocked(api.vodApply)

const actEnv = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnv.IS_REACT_ACT_ENVIRONMENT = true

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})
vi.stubGlobal('matchMedia', (q: string) => ({
  matches: false, media: q, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent: () => false,
}))

const PERMALINK = 'https://www.bilibili.com/video/BV1high12345'
const ALT_LINK = 'https://www.bilibili.com/video/BV1alt123456'

/** 三行：高置信自动勾 · 兜底默认不勾 · 高置信且有一条备选 */
const SCAN: VodScanResult = {
  account_id: 1,
  mids: ['999888', '123'],
  tolerance_minutes: 90,
  items_total: 927,
  accounts: [{ mid: '999888', ok: true, source_kind: 'series',
              source_name: '直播回放', item_count: 927, matched: 2, error: null }],
  matches: [
    {
      live_id: 'sess-1', start_at: '2026-10-08T12:00:00Z', live_title: '歌回',
      bvid: 'BV1high12345', title: '【直播回放】歌回 2026年10月08日20点场',
      permalink: PERMALINK, cover_url: '', published_at: '2026-10-08T16:00:00Z',
      duration_minutes: 300, mid: '999888', source_name: '直播回放',
      confidence: 0, minutes_delta: 0, auto_ok: true,
      title_hour: 20, date_only: false,
      alternates: [{ bvid: 'BV1alt123456', title: '【直播回放】歌回 后半',
                     permalink: ALT_LINK, duration_minutes: 120,
                     mid: '999888', confidence: 0 }],
    },
    {
      live_id: 'sess-2', start_at: '2026-10-09T12:00:00Z', live_title: '杂谈',
      bvid: 'BV1weak12345', title: '看起来像录播但没有日期',
      permalink: 'https://www.bilibili.com/video/BV1weak12345', cover_url: '',
      published_at: '2026-10-09T12:00:00Z', duration_minutes: 200,
      mid: '999888', source_name: '投稿',
      confidence: 2, minutes_delta: null, auto_ok: false, alternates: [],
      title_hour: null, date_only: false,
    },
  ],
  unmatched: [
    { live_id: 'sess-3', start_at: '2026-09-25T10:00:00Z',
      live_title: '和店长一起度过周末！', source: 'danmakus' },
  ],
}

let host: HTMLDivElement
let root: Root
const onClose = vi.fn()
const onApplied = vi.fn()

function render(uid: string | null = '999888') {
  act(() => {
    root.render(
      <VodFillDialog open accountId={1} vodAccountUid={uid}
                     onClose={onClose} onApplied={onApplied} />,
    )
  })
}

const rowEl = (liveId: string) =>
  document.querySelector<HTMLElement>(`[data-vod-fill-row="${liveId}"]`)
const checkEl = (liveId: string) =>
  document.querySelector<HTMLInputElement>(`[data-vod-fill-check="${liveId}"]`)!
const swapEl = (liveId: string) =>
  document.querySelector<HTMLButtonElement>(`[data-vod-fill-swap="${liveId}"]`)
const applyBtn = () =>
  document.querySelector<HTMLButtonElement>('[data-vod-fill-apply]')!
const gaps = () => document.querySelector('[data-vod-fill-gaps]')?.textContent ?? ''
const noMid = () => document.querySelector('[data-vod-fill-no-mid]')
const errText = () => document.querySelector('[data-vod-fill-error]')?.textContent ?? ''

async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

/** 打开并等扫描落地（act 里跑完 microtask 队列）。
 *  `mocks.once=false` 用于同一用例里重挂两次（`mockResolvedValueOnce` 只有一份）。 */
async function openAndSettle(res: VodScanResult | Error = SCAN,
                             mocks: { once?: boolean; uid?: string | null } = {}) {
  const { once = true, uid = '999888' } = mocks
  if (res instanceof Error) scanMock.mockRejectedValueOnce(res)
  else if (once) scanMock.mockResolvedValueOnce(res)
  else scanMock.mockResolvedValue(res)
  render(uid)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  scanMock.mockReset()
  applyMock.mockReset()
  onClose.mockReset()
  onApplied.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('① 打开即扫、结果可读', () => {
  it('扫完把每场对到哪条录播摆出来（带依据）', async () => {
    await openAndSettle()
    expect(scanMock).toHaveBeenCalledWith(1, {})
    const row = rowEl('sess-1')!
    expect(row.textContent).toContain('歌回')
    expect(row.textContent).toContain('【直播回放】歌回')
    expect(row.textContent).toContain('标题时间对上')
    expect(row.textContent).toContain('BV1high12345')
    expect(row.textContent).toContain('来自「直播回放」')
  })

  it('★ 没配上的一列要显示出来（"只有对不上的才手动补"这条出口）', async () => {
    await openAndSettle()
    expect(gaps()).toContain('和店长一起度过周末！')
  })
})

describe('② 默认勾选：兜底那条不勾', () => {
  it('★ `auto_ok=true` 默认勾，`auto_ok=false`（同日兜底）默认**不勾**', async () => {
    await openAndSettle()
    expect(checkEl('sess-1').checked).toBe(true)
    expect(checkEl('sess-2').checked).toBe(false)
    expect(rowEl('sess-2')!.getAttribute('data-vod-fill-confidence')).toBe('2')
    // 按钮上的计数只数勾中的
    expect(applyBtn().textContent).toContain('1 条')
  })

  it('手动勾上兜底那条 ⇒ 计数 +1', async () => {
    await openAndSettle()
    await click(checkEl('sess-2'))
    expect(applyBtn().textContent).toContain('2 条')
  })
})

describe('③ 写入：只提交勾中的', () => {
  it('提交的是 `permalink`（与手动填同一条规范化），且只含勾中的', async () => {
    applyMock.mockResolvedValueOnce({ applied: 1, failed: 0, results: [] })
    await openAndSettle()
    await click(applyBtn())
    expect(applyMock).toHaveBeenCalledWith(1, [{ live_id: 'sess-1', vod_url: PERMALINK }])
    expect(onApplied).toHaveBeenCalled()
  })

  it('★ 「换一条」之后提交的是**备选**那条', async () => {
    applyMock.mockResolvedValueOnce({ applied: 1, failed: 0, results: [] })
    await openAndSettle()
    const swap = swapEl('sess-1')!
    expect(swap).not.toBeNull()
    await click(swap)
    expect(swap.textContent).toContain('备选 1/1')
    await click(applyBtn())
    expect(applyMock).toHaveBeenCalledWith(1, [{ live_id: 'sess-1', vod_url: ALT_LINK }])
  })

  it('一条都没勾 ⇒ 按钮禁用（不空跑一次写请求）', async () => {
    await openAndSettle()
    await click(checkEl('sess-1'))          // 取消唯一勾中的那条
    expect(applyBtn().disabled).toBe(true)
    expect(applyBtn().textContent).toContain('0 条')
  })

  it('★ 点对话框**内部**不会被当成"点外部"（用户 2026-10-15 报"点任意处就关"）', async () => {
    await openAndSettle()
    // 点概要条（面板里、非按钮）、点某一行、点表头 —— 都不该触发 onClose
    await click(document.querySelector('[data-vod-fill-summary]') as HTMLElement)
    await click(rowEl('sess-1')!)
    await click(document.querySelector('.lc-ms-head') as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
    // 遮罩要在 DOM 里，且挂的是**嵌套层**那个类（第 7 层）——
    // ⚠️ 只判"存在"是不够的：真正决定"点哪都关窗"的是**层号**（面板必须严格高于遮罩），
    //    而那一条在 jsdom 里量不到（没有布局与命中测试）⇒ 由真机探针
    //    `python scripts/ui_probe.py --vod-fill` 的"面板中心点命中自己"守着。
    const overlay = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement | null
    expect(overlay, '遮罩要在 DOM 里（Radix portal）').not.toBeNull()
    expect(overlay!.className).toContain('lc-dlg-layer')
    // Esc 仍然要能关（"点内部不关"不能变成"关不掉"）
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('写入失败**逐条**列出原因，不静默吞', async () => {
    applyMock.mockResolvedValueOnce({
      applied: 1, failed: 1,
      results: [
        { live_id: 'sess-1', ok: true, vod_url: PERMALINK, error: null },
        { live_id: 'sess-2', ok: false, vod_url: null, error: '这一场不在表内' },
      ],
    })
    await openAndSettle()
    await click(checkEl('sess-2'))
    await click(applyBtn())
    // 回执在**概要条**（常驻可见），失败原因在下面那一块
    const top = document.querySelector('[data-vod-fill-applied]')!.textContent ?? ''
    expect(top).toContain('已写入 1 条')
    expect(top).toContain('失败 1 条')
    const detail = document.querySelector('[data-vod-fill-applied-detail]')!.textContent ?? ''
    expect(detail).toContain('这一场不在表内')
    // 失败的那条**留在表里**（还能重试），成功的那条已经移走
    expect(rowEl('sess-2')).not.toBeNull()
    expect(rowEl('sess-1')).toBeNull()
  })

  it('★ 写成功后：成功的行**当场移出列表**、回执落在概要条、按钮变「已写入 N 条」且不可再点', async () => {
    // 用户 2026-10-15 实测：「点击写入之后没有明显的反馈……再次扫描结果还是一样」
    applyMock.mockResolvedValueOnce({
      applied: 1, failed: 0,
      results: [{ live_id: 'sess-1', ok: true, vod_url: PERMALINK, error: null }],
    })
    await openAndSettle()
    const matchedStat = () => document.querySelector('[data-vod-fill-matched]')!.textContent ?? ''
    expect(matchedStat()).toContain('2 场')                  // sess-1 + sess-2（后者默认不勾）
    await click(applyBtn())

    expect(rowEl('sess-1')).toBeNull()                       // 移出列表 = 最直接的"写进去了"
    expect(matchedStat()).toContain('1 场')                  // 计数跟着掉（只少写成功的那条）
    const top = document.querySelector('[data-vod-fill-applied]')!.textContent ?? ''
    expect(top).toContain('已写入 1 条')
    expect(applyBtn().disabled).toBe(true)                   // 不能再点第二遍
    expect(applyBtn().textContent).toContain('已写入 1 条')
    expect(document.querySelector('.lc-ms-actions')!.textContent).toContain('完成')
    // 还没勾的行（sess-2 默认不勾）不受影响
    expect(rowEl('sess-2')).not.toBeNull()
  })
})

describe('④ 失败与空态：不许把"没问到"说成"没有"', () => {  it('扫描失败 ⇒ 显示失败原文（不是空列表）', async () => {
    await openAndSettle(new Error('扫描超时'))
    expect(errText()).toContain('扫描超时')
    // 失败时**不许**冒出"没找着 0 场"那种看着像结论的话
    expect(document.querySelector('[data-vod-fill-summary]')!.textContent)
      .not.toContain('没找着')
  })

  it('★ 某个号没扫到要**说出来**（否则用户只看到"怎么才配上这么点"）', async () => {
    await openAndSettle({
      ...SCAN,
      accounts: [
        { mid: '94009831', ok: false, source_kind: '', source_name: '', item_count: 0,
          matched: 0, error: '没找到可扫的来源（合集/系列为空，投稿也没取到）' },
        ...SCAN.accounts,
      ],
    })
    const el = document.querySelector('[data-vod-fill-account-error="94009831"]')
    expect(el?.textContent).toContain('没找到可扫的来源')
  })

  it('一个号都没有 ⇒ 给出路（去填录播号），而不是空白', async () => {
    await openAndSettle({ ...SCAN, mids: [], matches: [], unmatched: [], accounts: [] })
    expect(noMid()).not.toBeNull()
    expect(noMid()!.textContent).toContain('录播号')
  })

  it('没填录播号但扫了 V 自己的号 ⇒ 显式提示"只扫了自己的号"', async () => {
    await openAndSettle()
    expect(document.querySelector('[data-vod-fill-no-mid-hint]')).toBeNull()  // 填了号，不提示

    // 换一个根重挂（同一个 mock 要能应答第二次）
    act(() => root.unmount())
    host.remove()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await openAndSettle(SCAN, { once: false, uid: null })
    expect(document.querySelector('[data-vod-fill-no-mid-hint]')!.textContent)
      .toContain('只扫了 V 自己的号')
  })
})
