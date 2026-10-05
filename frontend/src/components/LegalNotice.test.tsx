// @vitest-environment jsdom
/**
 * 用户协议闸门（2026-10-06，`devlog/369`）—— 用户口径：
 * 「第一次启动应用或者更新至这个版本时，都要阅读一个用户协议或者公告……
 *   **阅读完同意才可以关闭窗口**」。
 *
 * 判据钉三条（都在这一层能验的范围内）：
 * ① 正文四段都在、版本号是后端给的（不是写死的）；
 * ② **关不掉**：没有关闭钮、Esc 与点遮罩都不改变它 —— 唯一出路是同意；
 * ③ 同意 ⇒ 调 `acceptAgreement(版本)`，成功才回调放行；**失败留在原地并如实说**
 *    （不许"先放行再说"）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const acceptAgreement = vi.fn()
vi.mock('../api/api', () => ({
  api: { acceptAgreement: (...a: unknown[]) => acceptAgreement(...a) },
}))

import LegalNotice from './LegalNotice'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let accepted = 0

beforeEach(() => {
  acceptAgreement.mockReset()
  accepted = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = async (version = '1.1.0') => {
  await act(async () => {
    root.render(<LegalNotice version={version} onAccepted={() => { accepted += 1 }} />)
    await Promise.resolve()
  })
}
const modal = () => document.body.querySelector('[data-legal="1"]')
const agreeBtn = () => document.body.querySelector<HTMLElement>('[data-testid="legal-agree"]')!

describe('LegalNotice · 首启/换版本的协议闸门', () => {
  it('正文四段都在，版本号来自 props（后端那份，不是写死在组件里）', async () => {
    await render('1.2.3')
    const text = modal()?.textContent || ''
    for (const t of ['一、这是什么', '二、你的数据在本机', '三、风险（请务必读完）', '四、责任自负']) {
      expect(text, `缺了「${t}」`).toContain(t)
    }
    expect(text).toContain('v1.2.3')
    // 用户点名要有的三层意思：功能简介 / 风险 / 后果自负
    expect(text).toContain('账号')
    expect(text).toContain('由你自行承担')
  })

  it('**关不掉**：没有关闭钮，Esc 与点遮罩都不放行', async () => {
    await render()
    expect(modal(), '闸门没渲染').toBeTruthy()
    // 没有 ×（也没有第二个按钮）
    expect(document.body.querySelectorAll('button')).toHaveLength(1)
    await act(async () => {
      modal()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      modal()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(modal(), 'Esc/点遮罩把闸门关掉了 —— 用户口径是"同意才可以关"').toBeTruthy()
    expect(accepted).toBe(0)
  })

  it('同意 ⇒ 记的是**后端给的那个版本**，成功才放行', async () => {
    acceptAgreement.mockResolvedValue({ required: '1.1.0', accepted: '1.1.0', needed: false })
    await render('1.1.0')
    await act(async () => { agreeBtn().click(); await Promise.resolve() })
    expect(acceptAgreement).toHaveBeenCalledWith('1.1.0')
    expect(accepted).toBe(1)
  })

  it('同意失败 ⇒ 留在原地 + 如实说（不许"先放行再说"）', async () => {
    acceptAgreement.mockRejectedValue(new Error('后端没起来'))
    await render()
    await act(async () => { agreeBtn().click(); await Promise.resolve() })
    expect(accepted, '没记成就放行了 —— 那等于假装读过协议').toBe(0)
    expect(modal()).toBeTruthy()
    expect(document.body.querySelector('[data-legal-error]')?.textContent).toContain('后端没起来')
  })
})
