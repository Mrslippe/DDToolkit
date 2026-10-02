/**
 * 宿主标识（M2，devlog/244；方案 §8.5 E）——`'main'` | `'widget'`。
 *
 * ## 它解决什么
 *
 * 手动动作的推送会广播给**所有**订阅者，包括"刚点了这个按钮的那个窗口"：
 * 主窗口点一下抓取 → 后端推一条"抓取完成" → 主窗口又弹一次（它本地已经弹过胶囊了）
 * ⇒ **自家消息回环**。所以每条推送带 `originator`，订阅者与自己的标识一致时**不重复提示**。
 *
 * ## 三条口径
 *
 * 1. **连接级**，不必每条消息重复（方案 §8.5 E 的定稿）：前端把它放在请求头
 *    `X-DDToolkit-Host` 里（`api.ts` 的 `authFetch`/`request` 统一加，SSE 连接也走同一条路）。
 * 2. **默认 `'main'`**：主窗口（`main.tsx`）不用显式设置。
 *    `'widget'` 这个取值**仍然有效**（后端拿它当 originator 标签，见
 *    `tests/test_manual_action_push.py`）：当年小窗入口显式 `setHost('widget')`，
 *    那条入口 2026-10-01 已退役 —— 留着这一档是**数据层的契约**，不是死代码。
 * 3. ⚠️ **只有"完成类"提示才跳过自己**：`notice.progress`（任务开始）恰恰是"让点按钮的人
 *    立刻看到"的东西 —— 跳过自己就等于把 M2 的全部收益丢掉。判定在 `messageBus.bridgeMessage`。
 */
export type HostKind = 'main' | 'widget'

/** 后端认的请求头名（真源是 `app/services/messages.py::HOST_HEADER`，有结构判据对账）。 */
export const HOST_HEADER = 'X-DDToolkit-Host'

let host: HostKind = 'main'

/** 显式声明宿主（小窗入口退役后**目前没有调用方** —— 留着是给将来第二个窗口用的接线点）。 */
export function setHost(h: HostKind): void {
  host = h
}

/** 当前宿主。 */
export function myHost(): HostKind {
  return host
}
