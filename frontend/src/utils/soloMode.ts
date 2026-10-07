/**
 * 单推模式（原始批次需求 6，`devlog/429`）：**整个应用收敛到一个 V**。
 *
 * ## 口径（用户 2026-10-07）
 *
 * - 入口在**最左侧工具栏底部、齿轮上方**那枚按钮；再点一次退出；
 * - 进单推时**左栏（V 列表）整栏收起**，但**列表内容不变** —— 左缘给一个**常态隐藏的拉手**
 *   随时展开/收起（那是"看一眼"的临时动作，不是退出单推）；
 * - 退出**回到进入前的路由**（`prevRoute`）——这就是"退出回到进入前的状态"。
 *
 * ## 为什么内容侧几乎不用改
 *
 * 需求原文是"进入后帖子/场次/日历/词云都只剩这一个 V"。实测下来这几处**本来就按路由的单 V 口径**
 * 取数（`PostsPage` 的 `LiveCalendar vtuberId={vtuber.id}`、`FanTrendChart accountId=该 V 主账号`、
 * `DataDeck persistKey`，词云按场次）⇒ **收敛是既有性质**，这一批要加的是"**模式**"本身
 * （入口 / 收起 / 持久化 / 退出还原），不是给四个视图各加一层过滤。
 * ⚠️ 别因为"看起来什么都没做"就再去加过滤 —— 那会变成第二份真源。
 *
 * ## 与 `shellState` 的分工
 *
 * 那个管"关窗/深休眠的现场"（12 小时 TTL，超时就别恢复了）；这里是**模式**，
 * 与主题同类 —— 跨启动一直有效，所以**不设 TTL**。`prevRoute` 仍复用它的 `sanitizeRoute`
 * （那个字符串会被丢给 `navigate()`，必须校验）。
 */
import { useSyncExternalStore } from 'react'

import { sanitizeRoute } from './shellState'

export interface SoloState {
  /** 单推的那个 V（正整数） */
  id: number
  /** 进入前的路由（退出时回这儿）；校验不过就是 `null` ⇒ 回 `/` */
  prevRoute: string | null
}

export const SOLO_KEY = 'ddtoolkit.solo'

/** 读库里的原文。**任何异常一律 `null`**（= 没在单推），绝不抛。 */
export function parseSolo(raw: string | null | undefined): SoloState | null {
  if (!raw) return null
  try {
    const d = JSON.parse(raw) as Partial<SoloState>
    const id = typeof d?.id === 'number' ? d.id : Number(d?.id)
    if (!Number.isInteger(id) || id <= 0) return null
    return { id, prevRoute: sanitizeRoute(typeof d?.prevRoute === 'string' ? d.prevRoute : null) }
  } catch {
    return null
  }
}

export function serializeSolo(s: SoloState): string {
  return JSON.stringify({ id: s.id, prevRoute: sanitizeRoute(s.prevRoute) })
}

function readStore(): SoloState | null {
  try {
    return parseSolo(globalThis.localStorage?.getItem(SOLO_KEY))
  } catch {
    return null    // 隐私模式/配额满：降级成"这次没在单推"，不影响别的
  }
}

/** ⚠️ 快照必须是**同一个引用**直到真的变了，否则 `useSyncExternalStore` 会无限重渲染。 */
let state: SoloState | null = readStore()
const subs = new Set<() => void>()

function write(next: SoloState | null): void {
  state = next
  try {
    if (next) globalThis.localStorage?.setItem(SOLO_KEY, serializeSolo(next))
    else globalThis.localStorage?.removeItem(SOLO_KEY)
  } catch {
    /* 同上：只影响"跨启动还记得" */
  }
  for (const f of subs) f()
}

/** 唤出区（顶栏 / 左侧工具栏）。`none` = 都不在。 */
export type SoloPeek = 'top' | 'left' | 'none'

/**
 * 指针在哪个唤出区里（`devlog/432`）。
 *
 * 为什么要这个纯函数：唤出**不能只靠 CSS 的 `~` 兄弟选择器** ——
 * 那样"从窄带移到唤出来的工具栏上"会立刻掉出 hover（工具栏在窄带的**上面**），
 * 而且 jsdom 里根本测不到 hover（用户实测：左侧工具栏唤不出来）。
 * 现在改成"事件委托 + 一个状态"：窄带与**被唤出的元素自身**都算同一个区。
 */
export function peekZone(el: Element | null | undefined): SoloPeek {
  if (!el || typeof el.closest !== 'function') return 'none'
  if (el.closest('.topbar') || el.closest('.solo-hover-top')) return 'top'
  if (el.closest('.icon-rail') || el.closest('.solo-hover-left')) return 'left'
  return 'none'
}

export function soloState(): SoloState | null {
  return state
}

export function enterSolo(id: number, prevRoute: string | null): void {
  if (!Number.isInteger(id) || id <= 0) return
  write({ id, prevRoute: sanitizeRoute(prevRoute) })
}

/** 退出；**返回进入前那份**（调用方据此导航回去）。本来没在单推 ⇒ `null`。 */
export function exitSolo(): SoloState | null {
  const prev = state
  write(null)
  return prev
}

export function subscribeSolo(cb: () => void): () => void {
  subs.add(cb)
  return () => { subs.delete(cb) }
}

/** 组件里读它（`useSyncExternalStore`：与 `videoKernel` 同一套订阅形状）。 */
export function useSolo(): SoloState | null {
  return useSyncExternalStore(subscribeSolo, soloState, soloState)
}
