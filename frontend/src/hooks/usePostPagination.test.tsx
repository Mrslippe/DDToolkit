// @vitest-environment jsdom
/**
 * 分页机的**行为**判据（M4，批次 12 第三刀，devlog/220）。
 *
 * 这台机器的判据分三组，各有各的"空转风险"，所以每一组都**先证明前提成立**：
 * ① 派生量 `hasMore` —— 直接用 posts/total 摆两态；
 * ② 无限滚动哨兵 —— 用假 `IntersectionObserver` **抓住真的被创建/被断开**，
 *    再驱动它的回调翻页；门控那一组是**反向**判据（该闭嘴时必须一个观察者都不建）；
 * ③ 回顶 —— 断言 `scrollTo({top:0})` **真被调用**（jsdom 没实现元素滚动 ⇒ 打桩），
 *    并且"同参数重渲染**不许**再回顶"（否则每渲染一次就把用户甩回顶部）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Post } from '../api/types'
import { usePostPagination } from './usePostPagination'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

// ── 假 IntersectionObserver：留下每一条观察记录，供断言"建了没有/断了没有" ──
interface FakeRecord {
  cb: (entries: Array<{ isIntersecting: boolean }>) => void
  opts: IntersectionObserverInit
  el: Element | null
  disconnected: boolean
}
let observers: FakeRecord[] = []
class FakeIO {
  private rec: FakeRecord
  constructor(cb: FakeRecord['cb'], opts: IntersectionObserverInit) {
    this.rec = { cb, opts, el: null, disconnected: false }
    observers.push(this.rec)
  }
  observe(el: Element) { this.rec.el = el }
  unobserve() { /* 本组件不用 */ }
  disconnect() { this.rec.disconnected = true }
  takeRecords() { return [] }
}

/** 驱动最后一条观察者"哨兵进视口" */
const sentinelInView = () => {
  const last = observers[observers.length - 1]
  if (!last) throw new Error('没有观察者 —— 这条用例的前提不成立（见空转风险）')
  act(() => { last.cb([{ isIntersecting: true }]) })
}

const post = (id: number) => ({ id } as Post)

let host: HTMLDivElement
let root: Root
let api!: ReturnType<typeof usePostPagination>
let scrollTo: ReturnType<typeof vi.fn>
const originalScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo')

interface Props {
  listActive?: boolean
  accountKey?: string | null
  loading?: boolean
  error?: string | null
  typeFilter?: string
  archived?: 'all' | 'archived' | 'unarchived'
  deletedOnly?: boolean
  searchKw?: string
  dateFrom?: string
  dateTo?: string
}

function Harness(props: Props) {
  api = usePostPagination({
    listActive: props.listActive ?? true,
    accountKey: props.accountKey ?? 'bilibili:100',
    loading: props.loading ?? false,
    error: props.error ?? null,
    typeFilter: props.typeFilter,
    archived: props.archived ?? 'all',
    deletedOnly: props.deletedOnly ?? false,
    searchKw: props.searchKw ?? '',
    dateFrom: props.dateFrom ?? '',
    dateTo: props.dateTo ?? '',
  })
  return (
    <div>
      <div id="scroll" ref={api.listScrollRef} />
      <div id="sentinel" ref={api.sentinelRef} />
      <div
        id="probe"
        data-page={api.page}
        data-hasmore={api.hasMore ? '1' : '0'}
        data-more={api.loadingMore ? '1' : '0'}
        data-err={api.loadMoreError ?? ''}
        data-top={api.showTop ? '1' : '0'}
        data-posts={api.posts.length}
        data-total={api.total}
      />
    </div>
  )
}

const render = (props: Props = {}) =>
  act(() => { root.render(<Harness {...props} />) })
const attr = (name: string) => document.getElementById('probe')!.getAttribute(`data-${name}`)
/** 只有"挂载/更新那一批之后还剩活着的观察者"才算真的在观察 */
const liveObservers = () => observers.filter((o) => !o.disconnected)

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  observers = []
  scrollTo = vi.fn()
  // jsdom **没有**实现元素滚动 —— 不打桩的话这条判据只能测到"没抛异常"
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true, writable: true, value: scrollTo,
  })
  vi.stubGlobal('IntersectionObserver', FakeIO)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  if (originalScrollTo) Object.defineProperty(Element.prototype, 'scrollTo', originalScrollTo)
  else delete (Element.prototype as unknown as Record<string, unknown>).scrollTo
  vi.restoreAllMocks()
})

describe('① hasMore 由"已载条数 < 总数"派生', () => {
  it('不足一页时还有更多；载满即到底', () => {
    render()
    act(() => { api.setTotal(5); api.setPosts([post(1), post(2)]) })
    expect(attr('hasmore')).toBe('1')
    act(() => { api.setPosts([post(1), post(2), post(3), post(4), post(5)]) })
    expect(attr('hasmore'), '载满总数就该到底 —— 否则哨兵会一直空转请求').toBe('0')
    act(() => { api.setTotal(6) })
    expect(attr('hasmore')).toBe('1')
  })
})

describe('② 无限滚动哨兵', () => {
  it('可加载时建观察者：root = 滚动体、提前量 600px、观察哨兵本身', () => {
    render()
    act(() => { api.setTotal(40); api.setPosts([post(1)]) })
    const io = liveObservers()
    expect(io, '这一条的前提是观察者真的建起来了（空转不是通过）').toHaveLength(1)
    expect(io[0].opts.rootMargin).toBe('600px 0px')
    expect(io[0].opts.root).toBe(document.getElementById('scroll'))
    expect(io[0].el).toBe(document.getElementById('sentinel'))
  })

  it('哨兵进视口 ⇒ 翻下一页（`setPage(p+1)`）', () => {
    render()
    act(() => { api.setTotal(40); api.setPosts([post(1)]) })
    expect(attr('page')).toBe('1')
    sentinelInView()
    expect(attr('page')).toBe('2')
  })

  it('**不可加载的六种情况一个观察者都不建**（loading / loadingMore / 首屏错误 / 追加错误 / 已到底 / 非列表视图）', () => {
    const cases: Array<[string, Props, (a: typeof api) => void]> = [
      ['首页在加载', { loading: true }, () => {}],
      ['正在追加', {}, (a) => a.setLoadingMore(true)],
      ['首页失败', { error: 'boom' }, () => {}],
      ['追加失败（等用户重试）', {}, (a) => a.setLoadMoreError('boom')],
      ['已经到底', {}, (a) => { a.setTotal(1); a.setPosts([post(1)]) }],
      ['不在列表视图', { listActive: false }, () => {}],
    ]
    for (const [name, props, setup] of cases) {
      observers = []
      render({ ...props })
      act(() => { api.setTotal(40); api.setPosts([post(1)]); setup(api) })
      expect(liveObservers(), `${name}：不该建观察者`).toHaveLength(0)
    }
  })

  it('追加失败 ⇒ 老观察者被断开（不许自己偷偷续载，得等用户重试）', () => {
    render()
    act(() => { api.setTotal(40); api.setPosts([post(1)]) })
    expect(liveObservers()).toHaveLength(1)
    act(() => { api.setLoadMoreError('boom') })
    expect(liveObservers(), '留着的观察者会在视口里反复翻页 ⇒ 必须断开').toHaveLength(0)
    expect(observers[0].disconnected).toBe(true)
  })

  it('重试只清错误位：清完哨兵重建，仍在视口里就自己续载（不另开翻页路径）', () => {
    render()
    act(() => { api.setTotal(40); api.setPosts([post(1)]) })
    act(() => { api.setLoadMoreError('boom') })
    const pageBefore = attr('page')
    act(() => { api.retryLoadMore() })
    expect(attr('err')).toBe('')
    expect(attr('page'), '清错误本身不翻页').toBe(pageBefore)
    expect(liveObservers()).toHaveLength(1)
    sentinelInView()
    expect(attr('page')).toBe('2')
  })

  it('卸载时断开观察者（不泄漏）', () => {
    render()
    act(() => { api.setTotal(40); api.setPosts([post(1)]) })
    const io = observers[0]
    act(() => root.unmount())
    expect(io.disconnected).toBe(true)
    root = createRoot(host)   // afterEach 还要 unmount 一次
  })
})

describe('③ 回顶（用户意图重置）+ 回顶钮', () => {
  it('切账号 ⇒ 立刻回顶', () => {
    render()
    const base = scrollTo.mock.calls.length      // 挂载那一次本来就会回顶（与抽出前一致）
    render({ accountKey: 'bilibili:200' })
    expect(scrollTo.mock.calls.length).toBe(base + 1)
    expect(scrollTo, '切账号继承滚动深度是 P8-7 修过的 bug').toHaveBeenLastCalledWith({ top: 0 })
  })

  it('切筛选（任一字段）⇒ 立刻回顶', () => {
    render()
    const base = scrollTo.mock.calls.length
    render({ archived: 'archived' })
    expect(scrollTo.mock.calls.length).toBe(base + 1)
    render({ archived: 'archived', searchKw: '奶绿' })
    expect(scrollTo.mock.calls.length).toBe(base + 2)
    render({ archived: 'archived', searchKw: '奶绿', deletedOnly: true })
    expect(scrollTo.mock.calls.length).toBe(base + 3)
  })

  it('**同参数重渲染不许回顶**（反向判据：否则每次重渲染都把用户甩回顶部）', () => {
    render({ archived: 'archived' })
    const base = scrollTo.mock.calls.length
    render({ archived: 'archived' })
    render({ archived: 'archived' })
    expect(scrollTo.mock.calls.length).toBe(base)
  })

  it('不在列表视图 ⇒ 不回顶（那会给别的视图的滚动体乱发指令）', () => {
    render({ listActive: false })
    const base = scrollTo.mock.calls.length
    render({ listActive: false, accountKey: 'bilibili:200' })
    expect(scrollTo.mock.calls.length).toBe(base)
  })

  it('回顶钮：超过 400px 才浮现，退回阈值以下就收', () => {
    render()
    act(() => { api.onScrollTop(400) })
    expect(attr('top'), '400 不算"超过 400"').toBe('0')
    act(() => { api.onScrollTop(401) })
    expect(attr('top')).toBe('1')
    act(() => { api.onScrollTop(10) })
    expect(attr('top')).toBe('0')
    act(() => { api.onScrollTop(900) })
    expect(attr('top')).toBe('1')
  })

  it('落回列表视图时收起回顶钮（原语义：判的是"新视图是不是 list"）', () => {
    render()
    act(() => { api.onScrollTop(900) })
    expect(attr('top')).toBe('1')
    render({ listActive: false })
    render({ listActive: true })
    expect(attr('top')).toBe('0')
  })
})

describe('④ 显式「加载更多」（键盘/读屏入口）', () => {
  it('清掉上一次的追加失败提示并翻页', () => {
    render()
    act(() => { api.setTotal(40); api.setPosts([post(1)]) })
    act(() => { api.setLoadMoreError('boom') })
    act(() => { api.loadMore() })
    expect(attr('err')).toBe('')
    expect(attr('page')).toBe('2')
  })
})
