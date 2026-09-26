import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, ApiShapeError, api, markNoTokenRequired, resetApiReady, setApiBase } from './api'

/**
 * API 契约（Q1，批次 13，devlog/216）。
 *
 * 三件事各自对应改前的一个真实毛病：
 * ① **失败不可判别**：`throw new Error(detail)` ⇒ status/path 全丢，界面只能统一说"加载失败"；
 * ② **非 JSON 响应抛裸 `SyntaxError`** ⇒ 调用方按 `e.name === 'AbortError'` 分流，
 *    于是"后端 ok 但响应不是 JSON"被当成业务错误弹 toast；
 * ③ **`JSON.parse(...) as T` 只是断言** ⇒ 后端改字段名时界面拿到 `undefined` 继续渲染（静默）。
 *
 * ⚠️ 兼容约束（改前逐条审过调用方，见 `errors.ts` 头部）：两个错误类都 extends Error、
 * `message` 文案与改前逐字一致、取消仍是 `AbortError`。下面的用例把这三点都钉住。
 */

const json = (body: unknown, status = 200, statusText = 'OK') => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
  json: async () => body,
})

const stubFetch = (resp: unknown) => {
  const mock = vi.fn(async () => resp)
  vi.stubGlobal('fetch', mock)
  return mock
}

/**
 * 取"这一发应该失败"的那个错误，类型干净。
 *
 * ⚠️ 别写 `.catch((e) => e as ApiError)`：TS 会把结果推成 `VTuber | ApiError` 联合
 * （成功分支也在里面），于是 `e.message` / `e.status` 全都报"属性不存在"（本批 tsc 实测踩到）。
 */
async function failure<T extends Error>(p: Promise<unknown>): Promise<T> {
  try {
    await p
  } catch (e) {
    return e as T
  }
  throw new Error('本该失败，却成功了')
}

afterEach(() => {
  vi.unstubAllGlobals()
  setApiBase('/api')
  resetApiReady()
  markNoTokenRequired()
})

describe('① 失败可判别：ApiError 带 status / detail / path', () => {
  it.each([
    [401, 'Unauthorized', '缺少或无效的访问令牌'],
    [403, 'Forbidden', '未登录，无法抓取内容'],
    [409, 'Conflict', '该账号已入库（VTuber#7）'],
    [422, 'Unprocessable Entity', '卡片超出 12 列网格'],
  ])('HTTP %i 分类稳定，detail 原样带出', async (status, statusText, detail) => {
    stubFetch(json({ detail }, status, statusText))

    const e = await failure<ApiError>(api.getVtuber(3))

    expect(e).toBeInstanceOf(ApiError)
    expect(e).toBeInstanceOf(Error)            // 兼容：调用方大量 `(e as Error).message`
    expect(e.name).toBe('ApiError')
    expect(e.status).toBe(status)
    expect(e.detail).toBe(detail)
    expect(e.path).toBe('/vtuber/3')           // 排查时"哪一发失败了"的唯一线索
    expect(e.message).toContain(detail)        // 文案与改前一致（旧调用方直接展示它）
  })

  it('401 额外带"重开窗口"那句（本应用里 401 只可能是认证）', async () => {
    stubFetch(json({ detail: '缺少或无效的访问令牌' }, 401, 'Unauthorized'))

    const e = await failure<ApiError>(api.getVtuber(1))

    expect(e.isAuth).toBe(true)
    expect(e.message).toMatch(/令牌/)
    expect(e.message).toMatch(/重开窗口/)
  })

  it('409/422 标成"业务拒绝"，其他码不是（界面据此决定能不能直接展示）', async () => {
    stubFetch(json({ detail: '冲突' }, 409, 'Conflict'))
    const conflict = await failure<ApiError>(api.getVtuber(1))
    stubFetch(json({ detail: '没找到' }, 404, 'Not Found'))
    const missing = await failure<ApiError>(api.getVtuber(1))

    expect(conflict.isClientRejection).toBe(true)
    expect(missing.isClientRejection).toBe(false)
  })

  it('错误响应体不是 JSON 时退回"<status> <statusText>"（不抛 SyntaxError）', async () => {
    stubFetch({
      ok: false, status: 409, statusText: 'Conflict',
      text: async () => '<html>nginx</html>',
      json: async () => { throw new SyntaxError('Unexpected token <') },
    })

    const e = await failure<ApiError>(api.getVtuber(1))

    expect(e).toBeInstanceOf(ApiError)
    expect(e.status).toBe(409)
    expect(e.detail).toBe('409 Conflict')
  })

  it('取消仍然是 AbortError（**不是** ApiError —— 分类不能混）', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_res, rej) => {
        const sig = init?.signal
        if (!sig) return
        // ⚠️ 两个分支都要有：`request()` 先 `await gate`，abort 可能发生在 fetch **之前**，
        //    那时 `sig.aborted` 已经是 true —— 只挂 listener 会让用例挂死（本批实测踩到）。
        if (sig.aborted) return rej(new DOMException('Aborted', 'AbortError'))
        sig.addEventListener('abort', () =>
          rej(new DOMException('Aborted', 'AbortError')))
      })))
    const ctrl = new AbortController()
    const p = api.listPosts('bilibili', '1', { page: 1, page_size: 10 }, ctrl.signal)
    ctrl.abort()

    const e = await failure<Error>(p)
    expect(e.name).toBe('AbortError')
    expect(e).not.toBeInstanceOf(ApiError)
  })
})

describe('② 2xx 但响应不是 JSON ⇒ ApiShapeError（改前是裸 SyntaxError）', () => {
  it('「后端说 ok、响应体是 HTML」不再被当成业务错误', async () => {
    stubFetch({
      ok: true, status: 200, statusText: 'OK',
      text: async () => '<!doctype html><title>oops</title>',
      json: async () => { throw new SyntaxError('Unexpected token <') },
    })

    const e = await failure<ApiShapeError>(api.listVtubers())

    expect(e).toBeInstanceOf(ApiShapeError)
    expect(e.name).toBe('ApiShapeError')
    expect(e.path).toBe('/vtuber/list')
    expect(e.message).toMatch(/不是合法 JSON/)
    expect(e.received).toContain('oops')      // 诊断要：实际拿到什么（截断过）
  })

  it('空响应体仍然返回 null（204 删除类端点靠它）', async () => {
    stubFetch(json(undefined, 204, 'No Content'))
    await expect(api.deleteVtuber(5)).resolves.toBeNull()
  })
})

describe('③ 关键响应的运行时校验（字段改名 ⇒ 当场报错，不静默）', () => {
  const vtuber = { id: 1, name: '明前奶绿', faction: null }

  it('正常响应照常通过', async () => {
    stubFetch(json([vtuber]))
    await expect(api.listVtubers()).resolves.toEqual([vtuber])
  })

  it('`id` 被改名成 `vtuber_id` ⇒ 报错并**点名那个字段**', async () => {
    stubFetch(json([{ vtuber_id: 1, name: '明前奶绿' }]))

    const e = await failure<ApiShapeError>(api.listVtubers())

    expect(e).toBeInstanceOf(ApiShapeError)
    expect(e.message).toContain('id')                 // 点名
    expect(e.message).toContain('第 0 个 VTuber')      // 定位
  })

  it('数组里混进 null / 非对象 ⇒ 报错（改前会在渲染时才炸）', async () => {
    stubFetch(json([vtuber, null]))
    await expect(api.listVtubers()).rejects.toBeInstanceOf(ApiShapeError)
  })

  it('多余字段一律放过（后端加字段是兼容变更）', async () => {
    stubFetch(json([{ ...vtuber, brand_new_field: 42 }]))
    await expect(api.listVtubers()).resolves.toHaveLength(1)
  })

  it('fetch-status 缺 `manual_running` ⇒ 报错（按钮禁用判据靠它）', async () => {
    stubFetch(json({
      account: {}, post: {}, external: {},
      rate_limit: {}, quiet_hours: {},
    }))

    const e = await failure<ApiShapeError>(api.getFetchStatus())

    expect(e).toBeInstanceOf(ApiShapeError)
    expect(e.message).toContain('manual_running')
  })

  it('帖子分页的 `total` 为 null ⇒ 报错（分页/加载更多靠它，静默会让"还有更多"永远为假）', async () => {
    stubFetch(json({ items: [], total: null, page: 1, page_size: 50 }))

    const e = await failure<ApiShapeError>(
      api.listPosts('bilibili', '1', { page: 1, page_size: 50 }))

    expect(e).toBeInstanceOf(ApiShapeError)
    expect(e.message).toContain('total')
  })
})
