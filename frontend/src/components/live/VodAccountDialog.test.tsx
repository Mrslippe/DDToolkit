// @vitest-environment jsdom
/**
 * 「录播号」设置小窗 `<VodAccountDialog>`（2026-10-15 **第二版**：条目化 + 拖动排序）。
 *
 * 用户口径（带方案稿拍板）：
 * 「输入录播号后保存为固定条目，展示为 `| 昵称 mid 投稿数 |`」·
 * 「拖动条目的上下位置进行排序，越上面的优先级越高」·
 * 新号进**末尾** · 昵称查不到**允许保存** · 显示**最近投稿** · **上限 5 条**。
 *
 * | 判据 | 坏了会怎样 |
 * |---|---|
 * | 条目按 `value` 的顺序渲染，序号 = 优先级 | 顺序错了 = 扫描时兜底关系反了，**没有报错** |
 * | ★ 拖动（键盘等价路径）改的是**保存出去的那个串** | 拖了个寂寞：界面动了、存下去没动 |
 * | ★ 新号进末尾 | 新号悄悄成了主号，抢走高优先号该配的场次 |
 * | ★ 昵称查不到**仍然能保存** | 号明明有效，却因为上游没回名字就存不了 |
 * | ★ 上限 5：满了不许再加（但**不许**偷偷丢已有的） | 静默丢号 = 用户以为还配着 |
 * | 没改就不可保存 / 留空发 `null` | 白跑一次 PUT；或把"清空"发成空串 |
 * | 失败原文照显且不关窗 | 静默失败 = 用户以为存上了 |
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VodAccountProfile } from '../../api/types'

vi.mock('../../api/api', () => ({
  api: { updateVtuber: vi.fn(), vodAccounts: vi.fn() },
}))

import { api } from '../../api/api'
import VodAccountDialog, { VOD_ACCOUNT_MAX, midFromInput, parseMids } from './VodAccountDialog'

const putMock = vi.mocked(api.updateVtuber)
const profMock = vi.mocked(api.vodAccounts)

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

const BASE = { avatar: '', last_published_at: null, name_error: null, uploads_error: null }

function prof(mid: string, name = '', uploads: number | null = 100,
             last: string | null = '2026-10-11T10:05:00'): VodAccountProfile {
  // ⚠️ `BASE` 要放**前面**：它带着 `last_published_at: null`，放后面会把传进来的日子盖掉
  return { ...BASE, mid, name, uploads, last_published_at: last }
}

let host: HTMLDivElement
let root: Root
const onClose = vi.fn()
const onSaved = vi.fn()

function render(value: string | null = '94009831,2132180406', vtuberId: number | null = 7,
                profiles?: VodAccountProfile[]) {
  profMock.mockResolvedValue({
    items: profiles ?? value!.split(',').filter(Boolean).map((m) => prof(m, `号${m}`, 42)),
  } as never)
  act(() => {
    root.render(
      <VodAccountDialog open vtuberId={vtuberId} value={value}
                        onClose={onClose} onSaved={onSaved} />,
    )
  })
}

/** 等打开时那一发批量资料请求落地。 */
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-vod-acct-row]')]
const rowMids = () => rows().map((r) => r.getAttribute('data-vod-acct-row'))
const nameEl = (mid: string) =>
  document.querySelector(`[data-vod-acct-name="${mid}"]`)?.textContent ?? ''
const statEl = (mid: string) =>
  document.querySelector(`[data-vod-acct-stat="${mid}"]`)?.textContent ?? ''
const gripEl = (mid: string) =>
  document.querySelector<HTMLButtonElement>(`[data-vod-acct-grip="${mid}"]`)!
const delEl = (mid: string) =>
  document.querySelector<HTMLButtonElement>(`[data-vod-acct-del="${mid}"]`)!
const input = () => document.querySelector<HTMLInputElement>('[data-vod-acct-input]')!
const queryBtn = () => document.querySelector<HTMLButtonElement>('[data-vod-acct-query]')!
const addBtn = (mid: string) =>
  document.querySelector<HTMLButtonElement>(`[data-vod-acct-add="${mid}"]`)
const saveBtn = () => document.querySelector<HTMLButtonElement>('[data-vod-acct-save]')!
const errText = () => document.querySelector('[data-vod-acct-error]')?.textContent ?? ''
const warnText = () => document.querySelector('[data-vod-acct-add-error]')?.textContent ?? ''

function type(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

async function key(el: HTMLElement, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
    await Promise.resolve()
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  putMock.mockReset()
  profMock.mockReset()
  onClose.mockReset()
  onSaved.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('① 条目：| 昵称 mid 投稿数 |', () => {
  it('按 value 的顺序渲染条目，序号即优先级', async () => {
    render('94009831,2132180406')
    await settle()
    expect(profMock).toHaveBeenCalledWith(['94009831', '2132180406'])
    expect(rowMids()).toEqual(['94009831', '2132180406'])
    expect(rows()[0].textContent).toContain('1')
  })

  it('昵称 / mid / 投稿数 / 最近投稿都摆出来', async () => {
    render('94009831')
    await settle()
    expect(nameEl('94009831')).toBe('号94009831')
    expect(rows()[0].textContent).toContain('94009831')
    expect(statEl('94009831')).toContain('42 条投稿')
    expect(statEl('94009831')).toContain('最近 2026.10.11')
  })

  it('★ 昵称查不到 ⇒ 标黄但仍**允许保存**（用户拍板："允许"）', async () => {
    render('94009831', 7, [{ ...prof('94009831', '', null, null), name_error: '没查到昵称' }])
    await settle()
    expect(nameEl('94009831')).toBe('昵称未取到')
    expect(rows()[0].className).toContain('unknown')
    expect(statEl('94009831')).toContain('投稿数未取到')
    // 删掉它再保存一次就说明"能操作"；这里直接改顺序证明保存路径是通的
    await key(gripEl('94009831'), 'ArrowDown')     // 只有一条 ⇒ 不动
    expect(rowMids()).toEqual(['94009831'])
  })

  it('资料接口失败 ⇒ 行照旧显示 mid（不是打不开窗）', async () => {
    profMock.mockRejectedValueOnce(new Error('查询炸了') as never)
    render('94009831')
    await settle()
    expect(rowMids()).toEqual(['94009831'])
    expect(rows()[0].textContent).toContain('94009831')
  })
})

describe('② 排序：越靠上优先级越高', () => {
  it('★ 拖动（键盘等价路径）改的是**保存出去的那个串**', async () => {
    putMock.mockResolvedValueOnce({} as never)
    render('94009831,2132180406')
    await settle()
    await key(gripEl('2132180406'), 'ArrowUp')          // 第二条上移 ⇒ 它成了主号
    expect(rowMids()).toEqual(['2132180406', '94009831'])
    await click(saveBtn())
    expect(putMock).toHaveBeenCalledWith(7, { vod_account_uid: '2132180406,94009831' })
    expect(onSaved).toHaveBeenCalledWith('2132180406,94009831')
  })

  it('每行都是可拖的（`draggable`），且手柄带说明', async () => {
    render('94009831')
    await settle()
    expect(rows()[0].getAttribute('draggable')).toBe('true')
    expect(gripEl('94009831').getAttribute('aria-label')).toContain('拖动')
  })
})

describe('③ 新增：查一次、确认、进末尾', () => {
  it('★ 新号进**末尾**', async () => {
    putMock.mockResolvedValueOnce({} as never)
    render('94009831')
    await settle()
    profMock.mockResolvedValueOnce({ items: [prof('555', '新号', 7, null)] } as never)

    type(input(), 'https://space.bilibili.com/555')
    await click(queryBtn())
    expect(addBtn('555'), '查完要先给预览').not.toBeNull()
    await click(addBtn('555')!)
    expect(rowMids()).toEqual(['94009831', '555'])
    await click(saveBtn())
    expect(putMock).toHaveBeenCalledWith(7, { vod_account_uid: '94009831,555' })
  })

  it('查不到昵称时预览里说清，且**仍然能加**', async () => {
    render('94009831')
    await settle()
    profMock.mockResolvedValueOnce({
      items: [{ ...prof('777', '', null, null), name_error: '没查到昵称（code=-400）' }],
    } as never)
    type(input(), '777')
    await click(queryBtn())
    expect(warnText()).toContain('没查到昵称')
    await click(addBtn('777')!)
    expect(rowMids()).toEqual(['94009831', '777'])
  })

  it('已经在列表里的号 ⇒ 不重复加', async () => {
    render('94009831')
    await settle()
    type(input(), '94009831')
    await click(queryBtn())
    expect(warnText()).toContain('已经在列表里')
    expect(rowMids()).toEqual(['94009831'])
  })

  it('★★ 上限 5：满了不许再加，但**已有的一个都不许丢**', async () => {
    const five = ['1', '2', '3', '4', '5']
    render(five.join(','))
    await settle()
    expect(rowMids()).toEqual(five)
    expect(input().disabled).toBe(true)                 // 输入框直接不可用
    expect(queryBtn().disabled).toBe(true)              // 查询钮也不可点（这条路才是真闸门）
    expect(document.querySelector('[data-vod-acct-hint]')!.textContent)
      .toContain(`最多 ${VOD_ACCOUNT_MAX} 个号（已满）`)
    // 越权路径（脚本直接塞值再点）也要被拦住：`query()` 里还有一道
    type(input(), '9')
    await click(queryBtn())
    expect(addBtn('9')).toBeNull()
    expect(rowMids()).toEqual(five)
  })

  it('★ 已有的号**超过**上限时：不静默丢，照旧能保存', async () => {
    putMock.mockResolvedValueOnce({} as never)
    const six = ['1', '2', '3', '4', '5', '6']           // 旧版文本框可能已经存成这样
    render(six.join(','))
    await settle()
    expect(rowMids()).toEqual(six)                        // 一条都没被吃掉
    await key(gripEl('6'), 'ArrowUp')
    // eslint-disable-next-line no-console
    console.log('DEBUG mids=', rowMids(), 'saveDisabled=', saveBtn().disabled)
    await click(saveBtn())
    expect(putMock).toHaveBeenCalledWith(7, { vod_account_uid: '1,2,3,4,6,5' })
  })
})

describe('④ 删除与保存口径', () => {
  it('删一行 ⇒ 保存串里就没它了', async () => {
    putMock.mockResolvedValueOnce({} as never)
    render('94009831,2132180406')
    await settle()
    await click(delEl('94009831'))
    expect(rowMids()).toEqual(['2132180406'])
    await click(saveBtn())
    expect(putMock).toHaveBeenCalledWith(7, { vod_account_uid: '2132180406' })
  })

  it('删光 ⇒ 发 `null`（服务端把 null 当"清空这个字段"）', async () => {
    putMock.mockResolvedValueOnce({} as never)
    render('94009831')
    await settle()
    await click(delEl('94009831'))
    await click(saveBtn())
    expect(putMock).toHaveBeenCalledWith(7, { vod_account_uid: null })
  })

  it('没改动时保存不可点', async () => {
    render()
    await settle()
    expect(saveBtn().disabled).toBe(true)
  })

  it('保存失败 ⇒ 原文照显，且**不**关窗（用户要能重试）', async () => {
    putMock.mockRejectedValueOnce(new Error('只支持 B 站 mid') as never)
    render('94009831')
    await settle()
    await key(gripEl('94009831'), 'ArrowDown')            // 只有一条，但先加一条才 dirty
    profMock.mockResolvedValueOnce({ items: [prof('555', '新', 7)] } as never)
    type(input(), '555')
    await click(queryBtn())
    await click(addBtn('555')!)
    await click(saveBtn())
    expect(errText()).toContain('只支持 B 站 mid')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('没有 V 的 id 时保存不可点（不在这个视图里假装能存）', async () => {
    render('94009831', null)
    await settle()
    expect(saveBtn().disabled).toBe(true)
  })
})

describe('⑤ 解析与文案', () => {
  it('`parseMids` 认中文逗号、去重、去空', () => {
    expect(parseMids(' 1，2 , 2 ,, 3 ')).toEqual(['1', '2', '3'])
    expect(parseMids(null)).toEqual([])
  })

  it('`midFromInput` 从主页链接里抠 mid', () => {
    expect(midFromInput('https://space.bilibili.com/94009831?spm_id_from=333.337.0.0'))
      .toBe('94009831')
    expect(midFromInput(' 94009831 ')).toBe('94009831')
  })

  it('说明文案写清"优先级 / 上限"，且不出现 Markdown 的 `**`', async () => {
    render('94009831')
    await settle()
    const hint = document.querySelector('[data-vod-acct-hint]')!.textContent ?? ''
    expect(hint).toContain(`${VOD_ACCOUNT_MAX} 个号`)
    expect(hint).not.toContain('**')
    const prio = document.querySelector('[data-vod-acct-prio]')!.textContent ?? ''
    expect(prio).toContain('越靠上优先级越高')
    expect(prio).not.toContain('**')
  })

  it('★ 输入框的示例里**不许**出现具体 mid（用户 2026-10-15：别拿我测试的那个当例子）', async () => {
    render('94009831')
    await settle()
    const ph = input().getAttribute('placeholder') ?? ''
    expect(ph).toContain('mid')
    expect(ph).not.toMatch(/\d{5,}/)
  })

  it('★ 说明文字要**满宽**（`.lvc-acct-hint` 抹掉 `.lc-ms-hint` 那 54px 缩进）', async () => {
    render('94009831')
    await settle()
    const hint = document.querySelector('[data-vod-acct-hint]')!
    // ⚠️ jsdom 量不到布局 ⇒ 钉**类名契约**：`.lc-ms-hint` 的 `padding-left: 54px` 是给
    //    四行表单对齐输入框用的，本窗没有标签，照搬就是一块莫名其妙的空档
    //    （用户 2026-10-15：「下面红框中的内容为什么左侧空了一块」）。
    expect(hint.className).toContain('lvc-acct-hint')
  })
})
