/**
 * 平台 HTML 的白名单净化（S2，devlog/206）。
 *
 * ## 为什么需要它（威胁模型三层 —— 别只盯 XSS）
 *
 * 真机 CSP 是 `script-src 'self'`（无 `unsafe-inline`）⇒ 注入的 `<script>` / `onerror=` /
 * `javascript:` **本来就执行不了**。本批真正挡的是：
 *
 * 1. **`style-src 'self' 'unsafe-inline'` ⇒ 注入的 `<style>` 与 `style=` 会生效** ——
 *    把危险操作伪装成显眼的下一步（UI 伪装 / 点击劫持），CSP 管不了；
 * 2. **我们的 Tailwind 工具类是全局的** ⇒ 平台 HTML 里一条 `class="fixed inset-0 z-50"`
 *    就能盖住整个界面。所以 `class` 必须剥掉 —— **这一条是最容易漏、后果最直接的一层**；
 * 3. 开发态浏览器（`npm run dev`）与**将来任何一次放宽 CSP**：那时净化就是唯一防线。
 *
 * 只有一处调用点：`components/PostDetailDrawer.tsx`（`body_json.content`，即 B 站专栏全文）。
 * `OriginCard` 走的是 React 文本节点，**不需要**净化；判据里有一条扫源码的用例钉住
 * "全仓只有一处 `dangerouslySetInnerHTML`，且它必须消费本函数"。
 *
 * ⚠️ **边界**：外链**主机白名单**与 WebView2 的跳转行为属批次 4ab（见
 * `ARCHITECTURE-IMPROVEMENT-EXECUTION.md` §2.17），本模块只保证"只放行 http(s)/协议相对"
 * 这一层，别在这里顺手做主机白名单 —— 那会与 4ab 出现两份口径。
 */
import createDOMPurify from 'dompurify'

/** 放行标签：平台正文真的会用到的那些（少一个就会"过度损坏"，见测试里的清单） */
export const ALLOWED_TAGS: readonly string[] = [
  // 段落与文本
  'p', 'br', 'span', 'div', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
  'sub', 'sup', 'mark', 'small', 'hr',
  // 标题
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // 列表
  'ul', 'ol', 'li',
  // 引用 / 代码
  'blockquote', 'code', 'pre',
  // 表格
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // 媒体与链接
  'figure', 'figcaption', 'img', 'a',
]

/**
 * 放行属性：刻意**不含** `class` / `id` / `style` / `data-*` / `contenteditable` / `srcset`。
 *
 * ⚠️ `class` 是**故意**剥掉的：平台类名（B 站新编辑器的 `ql-bg-#ffa0d0` 之类）在我们这儿
 * 本来就没有对应样式，而**我们的 Tailwind 工具类是全局的** —— 留着 `class` 等于给注入者
 * 一把改界面的钥匙。
 */
export const ALLOWED_ATTR: readonly string[] = [
  'href', 'src', 'alt', 'title', 'width', 'height',
  'colspan', 'rowspan', 'start', 'cite', 'datetime',
]

/** 只允许 http(s) 与协议相对（`//i0.hdslb.com/...` 是平台真实形态）；`javascript:` / `data:` / 相对路径一律丢 */
const ALLOWED_URI = /^(?:https?:)?\/\/[^\s]+$/i

const purify = createDOMPurify()

// ⚠️ **`ALLOWED_URI_REGEXP` 管不到 `<img>` 的 `data:`**（2026-09-26 实测）：
//    DOMPurify 对 `audio`/`video`/`img`/`source`/`track` 有一份**独立的 data-URI 白名单**
//    （`DATA_URI_TAGS`），命中它就**跳过** `ALLOWED_URI_REGEXP` ⇒
//    `payload = '<img src="data:image/svg+xml,<svg onload=alert(1)>">'` 会原样活下来。
//    虽然 `<img>` 里的 SVG 脚本不执行（不算 XSS），但它能当**整屏伪装的图**用
//    —— 与 `class` 劫持是同一类威胁。所以这里把"只放行 http(s)/协议相对"**再钉一遍**，
//    不依赖 DOMPurify 的默认策略。
purify.addHook('afterSanitizeAttributes', (node: Element) => {
  for (const attr of ['href', 'src']) {
    const v = node.getAttribute(attr)
    if (v !== null && !ALLOWED_URI.test(v)) node.removeAttribute(attr)
  }
  if (node.tagName === 'A') {
    // 外链统一加 `rel`/`target` —— 与仓里另外三处外链同款（`OriginCard` / `DeltaRenderer` /
    // `HeroCardsView`），也让"点了正文里的链接会不会把 WebView 带走"这件事保持一个口径。
    node.setAttribute('rel', 'noopener noreferrer')
    node.setAttribute('target', '_blank')
  }
})

/**
 * 净化平台 HTML。**任何进 `dangerouslySetInnerHTML` 的平台字符串都必须先过这里。**
 *
 * 幂等：`sanitize(sanitize(x)) === sanitize(x)`（有判据）。
 */
export function sanitizePlatformHtml(html: string): string {
  if (!html) return ''
  return purify.sanitize(html, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    ALLOW_DATA_ATTR: false,
    // 保持默认的 `KEEP_CONTENT: true`：被剥掉的**容器**标签（如 `font`）里的文字要留下，
    // 而 `script`/`style` 的内容在 DOMPurify 的 FORBID_CONTENTS 里，不会漏成正文。
  }) as string
}
