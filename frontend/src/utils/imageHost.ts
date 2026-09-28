/**
 * 图片来源的**主机规则**（R46，devlog/249）—— 「哪些主机必须直接走 `/img-proxy`」
 * 这条规则的**唯一落点**。
 *
 * ## 为什么要有这个文件
 *
 * 2026-09-13（devlog/135）把「**取哪张**头像」抽成了 `resolveAvatar`，左右栏同源了；
 * 但「**怎么渲染那张**」当时只修了一半 —— 右栏 hero 换成了 `ProxyImage`（三态链：
 * 直连 → `/img-proxy` → 占位），**左栏还留着裸 `<img>`**（radix `AvatarImage`）。
 * 于是同一个微博头像 URL：hero 经代理拿到图 ✓，左栏直连微博 CDN **被防盗链 403 拒**
 * ⇒ `onError` 回落成灰底首字。用户 2026-09-28 报的正是这个现象。
 *
 * 修法与上一次同一条路数：**规则抽成纯函数、两处共用**，且**渲染器也共用**
 * （左栏改用 `ProxyImage`，"二次实现"这个入口直接消失）。
 *
 * ⚠️ 这条规则**只在这里写一遍**：`ProxyImage` 与静态结构判据
 * （`utils/avatarRender.test.ts`）都指向本文件；谁再写第二份"哪些主机要代理"，
 * 那条判据就红。
 */
import { imgProxyUrl } from '../api/api'
import { normalizeImageUrl } from './format'

/**
 * 防盗链主机：微博图床（`sinaimg.cn` / `wbcdn.cn`）对**应用自身来源**一律 403，
 * 直连注定失败 ⇒ 首帧就走代理（`/img-proxy` 按主机带 `weibo.com` Referer，可正常拉取）。
 * 只影响**首次决策**：其余主机仍先直连，失败了再由 `ProxyImage` 的 `onError` 兜底。
 */
export const PROXY_FIRST_HOSTS = ['sinaimg.cn', 'wbcdn.cn'] as const

/** 该 URL 是否属于"直连必失败、首帧就走代理"的主机。空值 = false（交给占位分支）。 */
export function needsProxyFromStart(url: string | null | undefined): boolean {
  const u = (url ?? '').trim()
  if (!u) return false
  return PROXY_FIRST_HOSTS.some((host) => u.includes(host))
}

/**
 * 首帧该用哪个 src：防盗链主机 → 代理 URL；其余 → https 归一化后的直连。
 * 返回 `undefined` = 没有图（调用方渲染占位 / 首字兜底）。
 *
 * ⚠️ `ProxyImage` 的初始 stage 必须由它决定（不要在组件里另写一遍判断）。
 */
export function initialImageSrc(src: string | null | undefined): string | undefined {
  const direct = src ? normalizeImageUrl(src) : undefined
  if (!direct) return undefined
  return needsProxyFromStart(direct) ? proxiedImageSrc(direct) : direct
}

/**
 * 代理 URL（`ProxyImage` 的 onError 兜底也用这一条）。
 *
 * 单独一个函数是为了让**代理 URL 的形状只在这里出现**：组件里直接调
 * `imgProxyUrl()` 会让"代理地址怎么拼"多一个落点，而结构判据正是靠
 * "`imgProxyUrl(` 只在本文件出现"来钉住这一点的。
 */
export function proxiedImageSrc(src: string | null | undefined): string | undefined {
  const direct = src ? normalizeImageUrl(src) : undefined
  return direct ? imgProxyUrl(direct) : undefined
}
