/**
 * 登录 / 平台 uid 的纯逻辑（第 4 阶段 ④ 第三刀-4，devlog/235）。
 *
 * **为什么单独一处**：加平台时最容易漏的就是"某个界面还写着旧的平台数组"——
 * `LoginDialog` 的两个 Tab 曾经硬编码成 `['bilibili', 'weibo']`，能力矩阵里加了新平台、
 * 这个浮窗却还是两张卡，用户在小红书上根本没有入口。所以清单只有这一处，
 * 界面一律从这里派生（`platformLogin.test.ts` 还盯着它与 `PLATFORM_LABEL` 同批）。
 */
import type { AuthPlatform } from '../api/types'

/** 登录方式：`qr` = 扫码（B 站 / 微博）；`cookie` = 粘贴 cookie（小红书 / 抖音） */
export type LoginMode = 'qr' | 'cookie'

export interface LoginTab {
  platform: AuthPlatform
  /** 显示名。B 站这里刻意写作「B 站」（与正文一致），与 `PLATFORM_LABEL` 的「B站」同指一物 */
  label: string
  mode: LoginMode
}

/** 登录浮窗的 Tab 清单（顺序即界面顺序） */
export const LOGIN_TABS: LoginTab[] = [
  { platform: 'bilibili', label: 'B 站', mode: 'qr' },
  { platform: 'weibo', label: '微博', mode: 'qr' },
  { platform: 'xiaohongshu', label: '小红书', mode: 'cookie' },
  { platform: 'douyin', label: '抖音', mode: 'cookie' },
]

/** 某平台的登录方式（清单里没有的平台按扫码处理：它们走的是原有两条路） */
export function loginMode(platform: string): LoginMode {
  return LOGIN_TABS.find((t) => t.platform === platform)?.mode ?? 'qr'
}

/** 「粘贴 cookie」那一路每个平台自己的文案与输入框（devlog/235、334） */
export interface CookieLoginSpec {
  steps: string[]
  placeholder: string
  /** 已配置时那句"它在本机、有效与否要等抓取时才知道" */
  savedNote: string
  /** 有第二个输入框的平台（抖音：UA 会被算进签名）*/
  ua?: { label: string; placeholder: string; hint: string }
}

/** 小红书 cookie 从哪来（登录浮窗直接列出来，省得用户猜） */
export const XHS_COOKIE_STEPS: string[] = [
  '浏览器登录小红书网页版，按 F12 打开开发者工具',
  '切到 Network（网络）面板，刷新页面，点任意 edith.xiaohongshu.com 的请求',
  '在 Request Headers 里找到 Cookie，整条复制过来',
  '别只挑一件：至少要含 a1 与 web_session（缺 a1 时签名器永远签不出名）',
]

/** 抖音 cookie 从哪来（口径与小红书同款，多一步 UA） */
export const DOUYIN_COOKIE_STEPS: string[] = [
  '浏览器登录抖音网页版（www.douyin.com），按 F12 打开开发者工具',
  '切到 Network（网络）面板，刷新页面，点任意 www.douyin.com 的请求',
  'Request Headers 里把 Cookie 整条复制过来（至少含 uifid、s_v_web_id、ttwid）',
  '同一个面板里再复制 user-agent 那一行 —— 签名会把 UA 算进去，填错的后果是"看起来成功但没有数据"',
]

export const COOKIE_LOGIN: Record<string, CookieLoginSpec> = {
  xiaohongshu: {
    steps: XHS_COOKIE_STEPS,
    placeholder: 'a1=…; web_session=…（整条 Cookie）',
    savedNote: '小红书 Cookie 在本机 —— 它没有免签名的探活接口，'
      + '是否还有效要等抓取时才知道；那时重新粘一次即可。',
  },
  douyin: {
    steps: DOUYIN_COOKIE_STEPS,
    placeholder: 'uifid=…; s_v_web_id=…; ttwid=…（整条 Cookie）',
    savedNote: '抖音 Cookie 在本机 —— 它同样没有免签名的探活接口，'
      + '是否还有效要等抓取时才知道。⚠️ 失效时抖音常常**不报错**（HTTP 200 + 0 字节空体），'
      + '所以抓不到数据时先来这儿重新粘一次。',
    ua: {
      label: 'User-Agent（同一个浏览器）',
      placeholder: 'Mozilla/5.0 … Chrome/… Safari/537.36 Edg/…',
      hint: 'F12 → Console 里输入 navigator.userAgent 回车，整串复制过来。'
        + '它与 Cookie 必须来自同一个浏览器会话。',
    },
  },
}

/** 某平台「粘贴 cookie」那一路的文案（清单里没有 ⇒ 给小红书那份兜底，行为与改前一致） */
export function cookieLoginSpec(platform: string): CookieLoginSpec {
  return COOKIE_LOGIN[platform] ?? COOKIE_LOGIN.xiaohongshu
}

/** 小红书 uid 从哪来（添加账号 / 收录两处共用的同一句话） */
export const XHS_UID_HINT =
  '小红书 uid = 主页链接 www.xiaohongshu.com/user/profile/<这一串>；不是昵称，也不是小红书号'

/** 小红书 uid 输入框的占位文案（两种粘法都收，见 `parseXhsUid`） */
export const XHS_UID_PLACEHOLDER = '小红书 uid 或直接粘主页链接'

/** 抖音 uid 从哪来（它比小红书更需要这句话：抖音号解析不了，见 `parseDouyinUid`） */
export const DOUYIN_UID_HINT =
  '抖音 uid = 主页链接 www.douyin.com/user/MS4wLjABAAAA…；抖音号（纯数字/自定义号）需要搜索接口，本版解析不了'

/** 抖音 uid 输入框的占位文案 */
export const DOUYIN_UID_PLACEHOLDER = '抖音 sec_user_id 或直接粘主页链接'

/**
 * 从"用户粘进来的东西"里取出小红书 uid。
 *
 * 实测用户更可能直接粘**主页链接**（`https://www.xiaohongshu.com/user/profile/<uid>?xsec_token=…`），
 * 而后端 `fetch_user_info(uid)` 只认裸 uid ⇒ 在这里统一摘一次。
 *
 * 摘不到返回**空串**：调用方据此提示"没找到 uid"，而不是把整条链接发给后端
 * （那样只会拿到一个 404，用户完全不知道自己错在哪）。
 */
export function parseXhsUid(raw: string): string {
  const s = (raw || '').trim()
  if (!s) return ''
  const m = s.match(/\/user\/profile\/([0-9A-Za-z_-]+)/)
  if (m) return m[1]
  // 纯 uid：单个 token（不含空白 / 斜杠 / 问号）
  if (/^[0-9A-Za-z_-]+$/.test(s)) return s
  return ''
}

/**
 * 从"用户粘进来的东西"里取出抖音 `sec_user_id`（与后端 `douyin.sec_uid_from_input` 同规则）。
 *
 * ⚠️ 与小红书**不一样**的一点：纯数字的抖音号**摘不出来**（返回空串）—— 它需要搜索接口才能
 * 解析成 `sec_user_id`，本版没接。认不出就让调用方提示"粘主页链接"，别把它当 uid 发给后端
 * （那会静默抓成别人的号，或者干脆 404）。
 */
export function parseDouyinUid(raw: string): string {
  const s = (raw || '').trim()
  if (!s) return ''
  const at = s.indexOf('MS4wLjABAAAA')
  if (at < 0) return ''
  const tail = s.slice(at).match(/^[0-9A-Za-z_-]+/)
  return tail && tail[0].length > 20 ? tail[0] : ''
}
