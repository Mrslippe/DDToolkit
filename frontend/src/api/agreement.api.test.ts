// @vitest-environment jsdom
/**
 * `POST /settings/agreement` 的**请求形状**（2026-10-06 真机事故的判据）。
 *
 * 事故：用户点「我已知悉并同意」进不去 —— 前端 `fetch` 传字符串 body 却没带
 * `Content-Type: application/json`，而 `fetch` 的默认值是 `text/plain;charset=UTF-8`；
 * FastAPI 只在该头是 `application/json` 时才按 JSON 解析 body ⇒ **422**
 * （`detail` 还是数组 ⇒ 界面显示 `[object Object]`）。
 *
 * 为什么以前的用例没抓到：`LegalNotice.test.tsx` 把 `api` 整个 mock 掉了（它测的是组件行为），
 * 而**没有任何用例**看"这个请求到底怎么发出去的"。这条补上：
 * ① 方法/路径/body 对；② **`Content-Type: application/json` 一定在**；
 * ③ 401 之外的非 2xx 把后端 `detail` 变成可读文案（含 422 那种数组）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, setApiToken } from './api'

let calls: { url: string; init: RequestInit }[] = []

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  calls = []
  setApiToken('t-123')          // 免得闸门把请求挂住
})

afterEach(() => { vi.unstubAllGlobals() })

describe('api.acceptAgreement —— 请求形状', () => {
  it('POST + JSON 头 + `{version}`，且带上会话 token（**少了 Content-Type 就是 422**）', async () => {
    mockFetch(200, { required: '1.1.0', accepted: '1.1.0', accepted_at: 'x', needed: false })
    const got = await api.acceptAgreement('1.1.0')

    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    expect(url).toContain('/settings/agreement')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('Content-Type'), '不带这个头 ⇒ FastAPI 按 text/plain 处理 ⇒ 422')
      .toBe('application/json')
    expect(headers.get('X-DDToolkit-Token')).toBe('t-123')
    expect(JSON.parse(String(init.body))).toEqual({ version: '1.1.0' })
    expect(got.needed).toBe(false)
  })

  it('422（detail 是数组）⇒ 文案里能读到原因，而不是 `[object Object]`', async () => {
    mockFetch(422, { detail: [{ type: 'model_attributes_type', loc: ['body'],
                               msg: 'Input should be a valid dictionary' }] })
    await expect(api.acceptAgreement('1.1.0')).rejects.toThrow(/valid dictionary/)
  })

  it('400（detail 是字符串）⇒ 原文照传（用户要能照着做）', async () => {
    mockFetch(400, { detail: '当前要求同意的是 1.1.0，收到的是 0.0.1' })
    await expect(api.acceptAgreement('0.0.1')).rejects.toThrow(/当前要求同意的是 1\.1\.0/)
  })
})
