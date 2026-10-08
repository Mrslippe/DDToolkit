import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Capabilities, CapabilityFeature } from '../api/types'
import {
  DOUYIN_CONTENT,
  FETCH_POSTS,
  WEIBO_CONTENT,
  XHS_CONTENT,
  availableSummary,
  featureOf,
  isDegraded,
  isDisabled,
  isLoginRequired,
  limitBadge,
  limitOf,
  limitText,
  limitsSummary,
  loginActionLabel,
} from './capabilities'

/**
 * 能力矩阵的界面判定（devlog/086）。
 * 每条判错的代价都是"界面说错话"：限制没标出来（用户点了才发现不行）、
 * 或者把 `degraded` 说成不可用（白白劝退）。
 */
const feature = (over: Partial<CapabilityFeature>): CapabilityFeature => ({
  id: 'x', label: 'X', platform: null, anon_state: 'full', anon_note: '未登录说明',
  login_note: '', evidence: '实测 2026-09-15', state: 'full', note: '当前说明', ...over,
})

const anonCaps = (): Capabilities => ({
  bilibili_logged_in: false,
  weibo_logged_in: false,
  xiaohongshu_logged_in: false,
  douyin_logged_in: false,
  // 抖音总开关默认关（devlog/335）—— 与"没登录"分开报
  douyin_enabled: false,
  wbi: { cached: true, anonymous: true },
  features: [
    feature({ id: 'browse_local', label: '浏览与搜索已归档内容', state: 'full' }),
    feature({ id: 'account_info', label: '账号信息', state: 'degraded', note: '会被间歇性风控' }),
    feature({ id: FETCH_POSTS, label: '抓取投稿与动态内容', platform: 'bilibili',
              anon_state: 'requires_login', state: 'requires_login', note: '需要登录 B 站' }),
    feature({ id: WEIBO_CONTENT, label: '微博内容', platform: 'weibo',
              anon_state: 'requires_login', state: 'requires_login', note: '需要微博登录' }),
    feature({ id: XHS_CONTENT, label: '小红书内容', platform: 'xiaohongshu',
              anon_state: 'requires_login', state: 'requires_login',
              note: '没配置 Cookie ⇒ 详情里的图也没法重取' }),
    // 抖音：已登录但总开关关着 —— state 是 disabled，不是 requires_login（devlog/338）
    feature({ id: DOUYIN_CONTENT, label: '抖音内容', platform: 'douyin',
              anon_state: 'requires_login', state: 'disabled',
              note: '抖音抓取总开关关着（设置 → 数据源 → 平台抓取）' }),
  ],
  limited: [
    { id: 'account_info', label: '账号信息', state: 'degraded', note: '会被间歇性风控' },
    { id: FETCH_POSTS, label: '抓取投稿与动态内容', state: 'requires_login', note: '需要登录 B 站' },
    { id: WEIBO_CONTENT, label: '微博内容', state: 'requires_login', note: '需要微博登录' },
    { id: XHS_CONTENT, label: '小红书内容', state: 'requires_login',
      note: '没配置 Cookie ⇒ 详情里的图也没法重取' },
    { id: DOUYIN_CONTENT, label: '抖音内容', state: 'disabled',
      note: '抖音抓取总开关关着（设置 → 数据源 → 平台抓取）' },
  ],
  measured_at: '2026-09-15',
})

describe('限制查询', () => {
  it('按 id 取限制与能力；没有限制时返回 null', () => {
    const caps = anonCaps()
    expect(limitOf(caps, FETCH_POSTS)?.state).toBe('requires_login')
    expect(limitOf(caps, 'browse_local')).toBeNull()
    expect(featureOf(caps, 'browse_local')?.label).toBe('浏览与搜索已归档内容')
    expect(featureOf(null, 'x')).toBeNull()
    expect(limitOf(null, 'x')).toBeNull()
  })

  it('requires_login 与 degraded 分开判定（后者不该被说成不可用）', () => {
    const caps = anonCaps()
    expect(isLoginRequired(caps, FETCH_POSTS)).toBe(true)
    expect(isDegraded(caps, FETCH_POSTS)).toBe(false)
    expect(isLoginRequired(caps, 'account_info')).toBe(false)
    expect(isDegraded(caps, 'account_info')).toBe(true)
    expect(isLoginRequired(caps, 'browse_local')).toBe(false)
  })
})

describe('文案', () => {
  it('顶栏一句话：未登录时带前缀，全可用时为空串（不渲染入口）', () => {
    expect(limitsSummary(anonCaps())).toBe('未登录 · 5 项受限')
    const allGood = { ...anonCaps(), limited: [], bilibili_logged_in: true, weibo_logged_in: true }
    expect(limitsSummary(allGood)).toBe('')
    expect(limitsSummary(null)).toBe('')
  })

  it('小红书的限制也要出现在清单里（2026-10-04：矩阵里以前根本没这条）', () => {
    const caps = anonCaps()
    expect(isLoginRequired(caps, XHS_CONTENT)).toBe(true)
    expect(limitText(caps, XHS_CONTENT)).toContain('Cookie')
    // 只差小红书时，顶栏还得说一句"有受限项"（别因为 B 站登录了就当没事）
    const biliOnly = { ...caps, bilibili_logged_in: true, weibo_logged_in: true }
    expect(limitsSummary(biliOnly)).toBe('5 项受限')
  })

  it('登录按钮文案随平台登录态变化', () => {
    expect(loginActionLabel(anonCaps())).toBe('登录 B 站 / 微博')
    expect(loginActionLabel({ ...anonCaps(), bilibili_logged_in: true })).toBe('登录微博')
    expect(loginActionLabel({ ...anonCaps(), weibo_logged_in: true })).toBe('登录 B 站')
    expect(loginActionLabel(null)).toBe('登录')
  })

  it('限制行文案来自后端 note（不在前端另编一套）', () => {
    expect(limitText(anonCaps(), FETCH_POSTS)).toBe('需要登录 B 站')
    expect(limitText(anonCaps(), 'browse_local')).toBe('')
  })

  it('"现在还能做什么"只列 full 的功能 —— 不许只列不能做的', () => {
    expect(availableSummary(anonCaps())).toEqual(['浏览与搜索已归档内容'])
    expect(availableSummary(null)).toEqual([])
  })
})

/**
 * `disabled`（我们自己的总开关关着）必须与 `requires_login` 分开说
 * —— 2026-10-05 用户真机反馈：粘完 Cookie 还看见「需要登录」，于是反复重粘，
 * 而真正该做的是去设置里打开抖音开关（devlog/338）。
 */
describe('受限角标', () => {
  it('三种状态的角标文案与样式类各不相同', () => {
    expect(limitBadge('requires_login')).toEqual({ text: '需要登录', cls: 'req' })
    expect(limitBadge('disabled')).toEqual({ text: '未启用', cls: 'dis' })
    expect(limitBadge('degraded')).toEqual({ text: '部分受限', cls: 'deg' })
    expect(limitBadge('full')).toEqual({ text: '部分受限', cls: 'deg' })
  })

  it('disabled 与 requires_login 的判定互斥（补救动作不同）', () => {
    const caps = anonCaps()
    expect(isDisabled(caps, DOUYIN_CONTENT)).toBe(true)
    expect(isLoginRequired(caps, DOUYIN_CONTENT)).toBe(false)
    expect(isDegraded(caps, DOUYIN_CONTENT)).toBe(false)
    // 开关关着时，后端给的 note 指向设置页而不是登录
    expect(limitText(caps, DOUYIN_CONTENT)).toContain('总开关')
    // 不能把 disabled 说成"需要登录"（这条以前就错过）
    expect(limitText(caps, DOUYIN_CONTENT)).not.toContain('需要登录')
  })

  it('总开关与登录态是两个字段，各自独立（登录了也不代表已启用）', () => {
    const caps = { ...anonCaps(), douyin_logged_in: true }
    expect(caps.douyin_enabled).toBe(false)
    expect(isDisabled(caps, DOUYIN_CONTENT)).toBe(true)
  })
})

/**
 * 源码级断言：登录/设置两条保存路径都必须**立刻重取能力矩阵**。
 * 为什么用源码级（而不是渲染测试）：这一条漏掉的代价是"用户看见旧状态以为没生效"，
 * 而组件测试要 Mock 掉整个 api 层才跑得起来 —— 收益不抵成本（devlog/338）。
 */
describe('保存后刷新能力矩阵', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', 'components', rel), 'utf8')

  it('登录窗口保存 Cookie 后刷新', () => {
    const code = src('LoginDialog.tsx')
    expect(code).toContain("import { refreshCapabilities } from '../hooks/useCapabilities'")
    // 保存成功分支里必须调用（在 setPasting(false) 之后的成功路径上）
    const saveBody = code.slice(code.indexOf('const saveCookie'), code.indexOf('const saveCookie') + 1400)
    expect(saveBody).toContain('refreshCapabilities()')
  })

  it('设置窗口保存/恢复默认后刷新', () => {
    const code = src('AppSettingsDialog.tsx')
    expect(code).toContain("import { refreshCapabilities } from '../hooks/useCapabilities'")
    // 保存与恢复默认各一次（总开关就住在这个窗口里）
    expect(code.split('refreshCapabilities()').length - 1).toBeGreaterThanOrEqual(2)
  })
})

/**
 * 说明窗的**三段式**布局（devlog/338）：页头 / 可滚正文 / 页脚。
 * 为什么值得一条判据：`DialogContent` 是 `fixed top-50%` 垂直居中且**没有** max-height，
 * 内容一长页脚（「去登录」/「去设置」）就被推出视口 —— 探针量到的是"点不着"，
 * 用户侧是"看不到补救入口"。想省掉 `.cap-limits-body` 那层的话，先看这条用例。
 */
describe('能力说明窗的布局契约', () => {
  const code = () => readFileSync(join(__dirname, '..', 'components', 'CapabilityLimits.tsx'), 'utf8')
  const css = () =>
    readFileSync(join(__dirname, '..', 'styles', 'posts.css'), 'utf8')

  it('正文包在 `.cap-limits-body` 里（它是那层滚动容器）', () => {
    const s = code()
    expect(s).toContain('className="cap-limits-body"')
    // 受限清单必须在滚动体内（页脚在它外面）
    const body = s.slice(s.indexOf('cap-limits-body'), s.indexOf('cap-limits-foot'))
    expect(body).toContain('cap-limits-item')
    expect(body).not.toContain('cap-limits-foot')
  })

  it('CSS 给整窗限高 + 三行网格，且滚动体 `min-height: 0`', () => {
    const c = css()
    const block = c.slice(c.indexOf('.cap-limits-dialog'), c.indexOf('.cap-limits-title'))
    expect(block).toMatch(/max-height:\s*calc\(100vh - \d+px\)/)
    expect(block).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\) auto/)
    expect(block).toMatch(/\.cap-limits-body\s*\{[^}]*min-height:\s*0/)
    expect(block).toMatch(/\.cap-limits-body\s*\{[^}]*overflow-y:\s*auto/)
  })

  it('全是开关关着时：不给「去登录」，改为"去设置"提示（两条分支都存在）', () => {
    const s = code()
    // 分支判据在 `hasLoginLimit` 上，不是"有没有 disabled 项"
    expect(s).toContain('const hasLoginLimit')
    expect(s).toContain('hasLoginLimit ? (')
    expect(s).toContain('data-cap-only-switch-off="1"')
    // 提示文案必须给出**去哪**（只说"未启用"等于死路）
    expect(s).toMatch(/设置 → 数据源 → 平台抓取/)
  })
})
