import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  LOGIN_TABS,
  XHS_COOKIE_STEPS,
  XHS_UID_HINT,
  XHS_UID_PLACEHOLDER,
  loginMode,
  parseXhsUid,
} from './platformLogin'
import { PLATFORM_LABEL } from './postTypes'

/**
 * 小红书接入的**前端接线**（第 4 阶段 ④ 第三刀-4，devlog/235）。
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

  it('顺序即界面顺序：B 站 / 微博 / 小红书', () => {
    expect(LOGIN_TABS.map((t) => t.platform)).toEqual(['bilibili', 'weibo', 'xiaohongshu'])
  })

  it('每个 Tab 都有显示名', () => {
    for (const t of LOGIN_TABS) expect(t.label.trim()).not.toBe('')
  })

  it('小红书是**唯一**的粘贴型（cookie）平台；扫码型不受影响', () => {
    expect(LOGIN_TABS.filter((t) => t.mode === 'cookie').map((t) => t.platform))
      .toEqual(['xiaohongshu'])
    expect(loginMode('bilibili')).toBe('qr')
    expect(loginMode('weibo')).toBe('qr')
    expect(loginMode('xiaohongshu')).toBe('cookie')
    // 清单外/未知平台按扫码走（原有两条路的行为不能被改掉）
    expect(loginMode('douyin')).toBe('qr')
  })

  it('粘贴说明里点名了两个必需键（缺 a1 时签名器永远签不出名）', () => {
    const text = XHS_COOKIE_STEPS.join(' ')
    expect(text).toContain('a1')
    expect(text).toContain('web_session')
  })

  it('uid 提示告诉用户 uid 在主页链接里的位置', () => {
    expect(XHS_UID_HINT).toContain('/user/profile/')
    expect(XHS_UID_PLACEHOLDER).toContain('主页链接')
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
