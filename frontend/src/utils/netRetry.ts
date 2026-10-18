/**
 * 网络级失败的重试（2026-10-18）。
 *
 * ## 为什么需要它
 * `tauri:dev` 是**先开窗口、后起 sidecar**。前端 `request()` 里的闸门（`awaitApiReady`）
 * 只等 **base 与 token 注入**，**不等后端真的开始监听**。于是窗口一挂载就发的那批请求
 * 会打到"还没 listen 的 8765"上 ⇒ fetch 抛 `TypeError: Failed to fetch`。
 *
 * 症状是**间歇**的：晚一点才发的请求就正常 —— 这也是为什么它看着像"有时能用有时不能"。
 *
 * ## 只重试网络层
 * 判据用消息而不是状态码：`Failed to fetch` / `NetworkError` / `Load failed` 是 fetch 层
 * 抛的，**HTTP 错误（4xx/5xx）不在此列** —— 那些已经拿到响应，重试没有意义，
 * 而且会把"后端明确说了原因"变成"重试三次再报同一个原因"。
 */

const NET_ERROR = /Failed to fetch|NetworkError|Load failed|fetch failed/i

/** 每次重试前的等待（毫秒）。三次合计约 1.2s，足以覆盖 sidecar 起监听的时间。 */
const DELAYS = [300, 400, 500]

export function isNetworkError(e: unknown): boolean {
  const m = (e as Error)?.message ?? ''
  return NET_ERROR.test(m)
}

/** 网络层失败时重试；其余错误原样抛出。 */
export async function withNetRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let i = 0; i <= DELAYS.length; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (!isNetworkError(e) || i === DELAYS.length) break
      await new Promise((r) => setTimeout(r, DELAYS[i]))
    }
  }
  throw last
}
