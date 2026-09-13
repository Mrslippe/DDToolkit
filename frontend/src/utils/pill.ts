/**
 * 成功类提示：走**顶栏状态胶囊**（渐隐渐显），错误仍用 `toast.error`。
 *
 * 2026-09-13（devlog/065）从 `pages/PostsPage.tsx` 的本地 `pill()` 搬出 ——
 * 平台药丸拖动重排的"顺序已保存"提示随 `HeroCardsView` 一起搬走，两处都要用同一套
 * 派发口径（`ddtoolkit:pill-message` 由 TopBar 消费），所以下沉成共享工具。
 */
export function pill(text: string): void {
  window.dispatchEvent(new CustomEvent('ddtoolkit:pill-message', { detail: { text } }))
}
