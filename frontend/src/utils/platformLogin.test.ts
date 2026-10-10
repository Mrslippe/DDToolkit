import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DOUYIN_COOKIE_STEPS,
  DOUYIN_UID_HINT,
  DOUYIN_UID_PLACEHOLDER,
  LOGIN_TABS,
  XHS_COOKIE_STEPS,
  XHS_UID_HINT,
  XHS_UID_PLACEHOLDER,
  authTabSuffix,
  cookieLoginSpec,
  loginMode,
  parseDouyinUid,
  parseXhsUid,
} from './platformLogin'
import { PLATFORM_LABEL } from './postTypes'

/**
 * 平台接入的**前端接线**（小红书 = 第 4 阶段 ④ 第三刀-4，devlog/235；抖音 = 第二刀，devlog/334）。
 *
 * 这一批改的全是界面，最怕的不是"写错了"，而是**写漏了一处**：
 * 加平台时容易只改一个入口，另外两个还写着旧的平台清单 —— 界面上完全看不出来
 * （用户只会觉得"小红书的入口怎么找不到"）。所以这里三层：
 * ① 纯逻辑（uid 解析）逐条判据；② 平台清单与 `PLATFORM_LABEL` 必须同批；
 * ③ 三个入口**源码级**扫一遍"确实接上了"（行为层由 `scripts/ui_probe.py` 在真界面上量）。
 */

const DIR = join(__dirname, '..', 'components')
const read = (f: string) => readFileSync(join(DIR, f), 'utf8')

describe('① parseXhsUid：用户粘什么都能认出 uid', () => {
  it.each([
    // 主页链接（用户最可能粘的东西）—— 带 xsec_token 查询串也要能摘出来
    ['https://www.xiaohongshu.com/user/profile/5b8e1a2b4b4b4b4b4b4b4b4b?xsec_token=ABzzz&xsec_source=pc_search',
      '5b8e1a2b4b4b4b4b4b4b4b4b'],
    ['https://www.xiaohongshu.com/user/profile/5b8e1a2b4b4b4b4b4b4b4b4b', '5b8e1a2b4b4b4b4b4b4b4b4b'],
    ['www.xiaohongshu.com/user/profile/abc123', 'abc123'],
    // 裸 uid（含前后空白 / 带下划线）
    ['  5b8e1a2b4b4b4b4b4b4b4b4b  ', '5b8e1a2b4b4b4b4b4b4b4b4b'],
    ['user_1A2b', 'user_1A2b'],
  ])('%s → %s', (raw, want) => {
    expect(parseXhsUid(raw)).toBe(want)
  })

  it.each([
    ['', '空'],
    ['   ', '只有空白'],
    ['塔菲', '中文昵称（不是 uid）'],
    ['a1=1; web_session=abc', '整条 cookie'],
    ['https://www.xiaohongshu.com/explore/123', '笔记链接（不是主页）'],
    ['https://space.bilibili.com/1265680561', 'B 站链接'],
  ])('摘不出 uid 时返回空串，界面据此提示（%s）', (raw) => {
    expect(parseXhsUid(raw)).toBe('')
  })
})

describe('② 平台清单：登录浮窗与 PLATFORM_LABEL 必须同批', () => {
  it('两边平台**集合相同** —— 加了平台却漏了登录入口/展示名，这条就红', () => {
    expect(LOGIN_TABS.map((t) => t.platform).sort()).toEqual(Object.keys(PLATFORM_LABEL).sort())
  })

  it('顺序即界面顺序：B 站 / 微博 / 小红书 / 抖音', () => {
    expect(LOGIN_TABS.map((t) => t.platform))
      .toEqual(['bilibili', 'weibo', 'xiaohongshu', 'douyin'])
  })

  it('每个 Tab 都有显示名', () => {
    for (const t of LOGIN_TABS) expect(t.label.trim()).not.toBe('')
  })

  it('粘贴型（cookie）平台是小红书与抖音；扫码型不受影响', () => {
    expect(LOGIN_TABS.filter((t) => t.mode === 'cookie').map((t) => t.platform))
      .toEqual(['xiaohongshu', 'douyin'])
    expect(loginMode('bilibili')).toBe('qr')
    expect(loginMode('weibo')).toBe('qr')
    expect(loginMode('xiaohongshu')).toBe('cookie')
    expect(loginMode('douyin')).toBe('cookie')
    // 清单外/未知平台按扫码走（原有两条路的行为不能被改掉）。
    // ⚠️ 样本别用真实平台名 —— 这条以前拿 douyin 当"未知"，它接进来之后就在骗自己了。
    expect(loginMode('definitely-not-a-platform')).toBe('qr')
  })

  it('粘贴说明里点名了两个必需键（缺 a1 时签名器永远签不出名）', () => {
    const text = XHS_COOKIE_STEPS.join(' ')
    expect(text).toContain('a1')
    expect(text).toContain('web_session')
  })

  it('抖音那份说明要点名 uifid / s_v_web_id 与 UA（UA 会被算进签名，devlog/334）', () => {
    const text = DOUYIN_COOKIE_STEPS.join(' ')
    expect(text).toContain('uifid')
    expect(text).toContain('s_v_web_id')
    expect(text).toContain('user-agent')
    const spec = cookieLoginSpec('douyin')
    expect(spec.ua, '抖音那条路要收 UA —— 少收它的后果是静默空数据').toBeTruthy()
    expect(spec.placeholder).toContain('uifid')
    expect(cookieLoginSpec('xiaohongshu').ua, '小红书不需要 UA 框').toBeUndefined()
  })

  it('uid 提示告诉用户 uid 在主页链接里的位置', () => {
    expect(XHS_UID_HINT).toContain('/user/profile/')
    expect(XHS_UID_PLACEHOLDER).toContain('主页链接')
    expect(DOUYIN_UID_HINT).toContain('/user/')
    expect(DOUYIN_UID_PLACEHOLDER).toContain('主页链接')
  })

  it('parseDouyinUid：链接能摘、裸抖音号摘不出来（它要搜索接口）', () => {
    const sec = 'MS4wLjABAAAAYbIZRpNPRPJ28dxKRyqtmQXtxN5EC_uAfePn3mPehcQ'
    expect(parseDouyinUid(`https://www.douyin.com/user/${sec}?tab=post`)).toBe(sec)
    expect(parseDouyinUid(`看看 ${sec} 的主页`)).toBe(sec)
    expect(parseDouyinUid('1234567890'), '抖音号解析不了 ⇒ 摘不出来，别当 uid 发出去').toBe('')
    expect(parseDouyinUid('')).toBe('')
  })
})

describe('③ 三个入口都接上了（源码级扫一遍，行为层由 ui_probe 量）', () => {
  it('登录浮窗的 Tab 从清单派生，不再硬编码两平台', () => {
    const src = read('LoginDialog.tsx')
    expect(src).toContain('LOGIN_TABS.map')
    expect(src).not.toMatch(/\['bilibili',\s*'weibo'\]/)
    // 粘贴型平台不能落到二维码那一路（它没有 QR 接口）
    expect(src).toContain('loginMode(platform)')
    expect(src).toContain('saveXhsCookie')
    // 抖音（devlog/334）：保存走它自己的接口，且**带 UA**（签名会算进去）
    expect(src).toContain('saveDouyinCookie')
    expect(src).toContain('cookieLoginSpec')
    expect(src).toContain('data-douyin-ua')
  })

  it('顶栏登录入口的悬停文案也带上小红书（同样是硬编码漏改过的位置）', () => {
    const src = read('TopBar.tsx')
    expect(src).toContain('LOGIN_TABS.map')
    expect(src).not.toMatch(/账号登录（B 站 \/ 微博）/)
  })

  it('添加 V 浮窗有「小红书 uid」收录入口，且带 data-xhs-adopt（探针找得到）', () => {
    const src = read('AddVtuberDialog.tsx')
    // ⚠️ 精确匹配到属性值：`toContain('data-xhs-adopt')` 会被 `data-xhs-adopt2` 骗过
    //    （反向验证实测：改名后那条断言仍然绿 ⇒ 等于空过）
    expect(src).toMatch(/data-xhs-adopt="1"/)
    expect(src).toMatch(/adoptVtuber\('xiaohongshu'/)
    expect(src).toContain('parseXhsUid')
  })

  it('添加账号对话框的平台下拉含小红书，并在提交前摘一次 uid', () => {
    const src = read('AddAccountDialog.tsx')
    expect(src).toContain("'bilibili', 'weibo', 'xiaohongshu'")
    expect(src).toContain('parseXhsUid')
    // 下拉项文案从 PLATFORM_LABEL 取（新增平台不用再抄一遍中文名）
    expect(src).toContain('PLATFORM_LABEL[p]')
  })
})


describe('Tab 上的登录态后缀（authTabSuffix，2026-10-08 devlog/456）', () => {
  const tab = (platform: 'bilibili' | 'weibo' | 'xiaohongshu' | 'douyin') =>
    LOGIN_TABS.find((t) => t.platform === platform)!

  it('★凭据在但会话已失效 ⇒ 「已失效」，不是「已登录」（用户截图里那处自相矛盾）', () => {
    // B 站是唯一一个"凭据在、但维护循环已判它失效"会同时成立的平台：
    // 旧写法只看 logged_in ⇒ 界面上「B 站 · 已登录」与正文「B 站登录已失效」两句打架
    expect(authTabSuffix(tab('bilibili'),
      { logged_in: false, configured: true, needs_login: true })).toBe(' · 已失效')
  })

  it('正对照：同一份凭据 + 会话有效 ⇒ 「已登录」', () => {
    expect(authTabSuffix(tab('bilibili'),
      { logged_in: true, configured: true, needs_login: false })).toBe(' · 已登录')
  })

  it('从没配过（没有凭据）⇒ 不带后缀，别说「已失效」吓人', () => {
    expect(authTabSuffix(tab('bilibili'),
      { logged_in: false, configured: false, needs_login: true })).toBe('')
  })

  it('粘贴型平台：配好了说「已配置」（有效与否只有抓取时才知道）', () => {
    expect(authTabSuffix(tab('xiaohongshu'),
      { logged_in: true, configured: true, needs_login: false })).toBe(' · 已配置')
    // 被判失效（小红书 invalidated ⇒ logged_in false）时说「已失效」
    expect(authTabSuffix(tab('xiaohongshu'),
      { logged_in: false, configured: true, needs_login: true })).toBe(' · 已失效')
  })

  it('登录态还没取到时什么都不说（`null` 不是「未登录」）', () => {
    expect(authTabSuffix(tab('weibo'), null)).toBe('')
    expect(authTabSuffix(tab('weibo'), undefined)).toBe('')
  })

  it('老后端不带 `configured` 时退回 `logged_in`（B 站那位是 2026-10-08 才有的）', () => {
    expect(authTabSuffix(tab('bilibili'),
      { logged_in: false, needs_login: true })).toBe('')
    expect(authTabSuffix(tab('bilibili'),
      { logged_in: true, needs_login: false })).toBe(' · 已登录')
  })
})