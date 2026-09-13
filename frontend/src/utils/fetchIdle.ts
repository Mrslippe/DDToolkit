/**
 * 「抓取任务完成」事件（`ddtoolkit:fetch-idle`）的**带类型版本**（R2 可选第二步，devlog/080）。
 *
 * 背景：这个事件原先是一个裸 `Event`，任何任务跑完都发一次 —— 而**动态流每 60~80s 一轮**，
 * 于是"粉丝趋势"这种只跟账号快照/第三方回填有关的卡片，每轮都被无意义地重取 + 重建
 * （ECharts 初始化是这里最贵的一步）。R2① 已经把"闪加载态"修掉了，这一步只省请求与重绘。
 *
 * ## 类型口径（谁是数据来源，谁就该刷新）
 *
 * | kind | 谁会写这些数据 | 关心的消费者 |
 * |---|---|---|
 * | `account` | 账号流：昵称/签名/粉丝数/**统计快照**、`live_*` 跳变 | 趋势图、日历、侧栏、卡片 |
 * | `posts` | 帖子/动态流（含**直播卡片 → 落场次**、投稿、专栏…） | 列表、卡片、日历（新场次） |
 * | `external` | 第三方固定化源：zeroroku 粉丝历史/礼物日、danmakus 场次与弹幕 | 趋势图、日历 |
 *
 * ⚠️ **日历不能只认 `account`/`external`**：动态流的 feed 页里带**直播卡片**，
 * `_route_live_item` 会把它落成 `live_sessions`（实测日志：`直播场次入库 feed` 就出现在动态轮里），
 * 所以 `posts` 类刷新对日历是**有意义的**。真正"无意义"的是趋势图 —— 见 `FanTrendChart`。
 *
 * 兼容：老的 `addEventListener('ddtoolkit:fetch-idle', fn)` 写法照旧可用（detail 被忽略）。
 */
export type FetchIdleKind = 'account' | 'posts' | 'external'

export const FETCH_IDLE_EVENT = 'ddtoolkit:fetch-idle'

/** 事件宿主：默认 `window`；测试可注入一个干净的 `EventTarget`（vitest 跑在 node 环境，
 *  没有 DOM —— 把宿主当参数传进来，这套判定表才测得到）。 */
type Host = EventTarget

function defaultHost(): Host {
  return window
}

/** 派发（合并调用方给的 kinds，去重；空数组不发） */
export function dispatchFetchIdle(kinds: FetchIdleKind[], host: Host = defaultHost()): void {
  const uniq = [...new Set(kinds)]
  if (uniq.length === 0) return
  host.dispatchEvent(new CustomEvent(FETCH_IDLE_EVENT, { detail: { kinds: uniq } }))
}

/** 订阅；`kinds` 缺省（老派发方/无 detail）时按"全都算"处理，宁可多刷一次也不漏 */
export function onFetchIdle(
  cb: (kinds: FetchIdleKind[]) => void,
  host: Host = defaultHost(),
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ kinds?: FetchIdleKind[] }>).detail
    cb(detail?.kinds?.length ? detail.kinds : ['account', 'posts', 'external'])
  }
  host.addEventListener(FETCH_IDLE_EVENT, handler)
  return () => host.removeEventListener(FETCH_IDLE_EVENT, handler)
}

/** 该刷新"粉丝趋势"吗：只有账号快照（自采）与第三方粉丝历史会改它 */
export function affectsFanTrend(kinds: FetchIdleKind[]): boolean {
  return kinds.includes('account') || kinds.includes('external')
}

/** 该刷新"直播日历"吗：账号（live 跳变/快照推导）、帖子（feed 直播卡片落场次）、第三方场次 */
export function affectsLiveCalendar(kinds: FetchIdleKind[]): boolean {
  return kinds.includes('account') || kinds.includes('posts') || kinds.includes('external')
}
