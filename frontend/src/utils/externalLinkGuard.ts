/**
 * 外链点击守卫（2026-10-02，devlog/278）：**页面上任何 http(s) 外链都走 `openExternal`**。
 *
 * ## 为什么需要一层全局守卫，而不是在每个组件里改
 *
 * ① 平台富文本（`sanitizePlatformHtml` 出来的 HTML，经 `dangerouslySetInnerHTML` 渲染）
 *    里带 `<a href>` —— 挂不上 React 处理器；
 * ② 裸 `<a target="_blank">` 在 WebView 里由壳接管并调用 **`shell:allow-open`**，
 *    而那个权限**已从 capability 删除**（改用带主机白名单的自定义命令 `open_external`，
 *    见 `lib.rs::EXTERNAL_HOSTS`）⇒ Promise 被拒、**链接打不开**，界面上还会冒出一条
 *    内部诊断（用户 2026-10-02 的截图正是「查看原文」触发的：
 *    `Promise shell:allow-open not allowed`）。
 *
 * ## 口径
 *
 * - 只拦**绝对 http(s) 且不同源**的链接；相对路径/同源交给 SPA 路由（不抢）；
 * - `mailto:` / `tel:` / `javascript:` 等非 http 一律不碰（不替用户做决定）；
 * - 桌面端拦截后走 `openExternal`；浏览器/探针里它退化为新标签页（`shellBridge` 里那条）；
 * - **失败不静默**：Rust 侧的白名单拒绝会把中文原因抛回来，这里 `toast.error` 显示，
 *   并派发 `ddtoolkit:user-error`（问题报告面板据此收一条，见 `problemReport.ts`）。
 */
import { toast } from 'sonner'
import { openExternal } from './shellBridge'
import { reportUserError } from './problemReport'

/** 该 href 要不要由我们接管？返回规范化后的绝对 URL；`null` = 不接管。 */
export function externalHref(raw: string | null | undefined,
                             base: string = window.location.href): string | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw, base)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.origin === new URL(base).origin) return null
  return u.toString()
}

/** 按 `href` 打开（失败把原因交给 toast + 问题报告）——「查看原文」这类按钮直接用这个 */
export async function openExternalFromHref(raw: string): Promise<void> {
  const url = externalHref(raw)
  if (!url) {
    // 同源/相对：不该走到这里（调用方只在"外链"上用），如实说出来而不是假装成功
    reportUserError('打开链接', `不是外部链接，已忽略：${raw}`)
    return
  }
  try {
    await openExternal(url)
  } catch (e) {
    const msg = typeof e === 'string' ? e : (e as Error)?.message || String(e)
    reportUserError('打开链接失败', `${msg}\n${url}`)
    toast.error(`打不开这个链接：${msg}`)
  }
}

/**
 * 装一次全局守卫（幂等；`main.tsx` 在 React 之前调用）。
 *
 * 用**捕获阶段**：不然组件里的 `onClick`（例如"点封面开大图"）先跑了，
 * 我们再 `preventDefault` 就变成了"拦下一个已经处理过的点击"。
 */
export function installExternalLinkGuard(): void {
  const w = window as unknown as { __externalLinkGuard?: boolean }
  if (w.__externalLinkGuard) return
  w.__externalLinkGuard = true
  document.addEventListener(
    'click',
    (e) => {
      if (e.defaultPrevented || e.button !== 0) return
      const el = e.target as Element | null
      const a = el?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a) return
      const url = externalHref(a.getAttribute('href'))
      if (!url) return
      // 修饰键也接管：WebView 里开不了"后台标签页"，放过去只会静默失败
      e.preventDefault()
      void openExternalFromHref(url)
    },
    true,
  )
}
