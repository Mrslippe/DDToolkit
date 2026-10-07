/**
 * 左栏（V 列表）**收起/展开**的偏好（2026-10-07 用户口径，`devlog/431`）。
 *
 * 「左栏的收起展开是**常驻功能**」—— 不再只在单推模式下才谈得上收起：
 * 任何视图、任何时候，把鼠标移到左栏右缘（收起后是内容区左缘）那条窄边上，
 * **拉手**才会现身，点一下就能收起/展开。偏好走 `localStorage`（与 `vtuberSort` 同套路：
 * 这是界面偏好，与主题同类，跨启动有效）。
 *
 * ⚠️ **单推与它是两个量**：单推**不改**这份偏好（`devlog/429` 的"退出回到进入前的状态"靠这个），
 * 收起与否由调用方合成：`单推时强制收起（可临时展开一眼）` ∨ `用户自己收起过`。
 */
import { useSyncExternalStore } from 'react'

export const RAIL_COLLAPSED_KEY = 'ddtoolkit.rail.collapsed'

/** 读原文：只认 `'1'` / `'0'`，其余（含手工改坏的值）一律当"展开"。 */
export function parseRailCollapsed(raw: string | null | undefined): boolean {
  return raw === '1'
}

export function serializeRailCollapsed(v: boolean): string {
  return v ? '1' : '0'
}

function readStore(): boolean {
  try {
    return parseRailCollapsed(globalThis.localStorage?.getItem(RAIL_COLLAPSED_KEY))
  } catch {
    return false    // 隐私模式：降级成"展开"，不影响别的
  }
}

/** ⚠️ 快照是布尔（原始值）⇒ `useSyncExternalStore` 的引用比较天然稳定。 */
let collapsed = readStore()
const subs = new Set<() => void>()

export function railCollapsed(): boolean {
  return collapsed
}

export function setRailCollapsed(v: boolean): void {
  if (v === collapsed) return
  collapsed = v
  try {
    globalThis.localStorage?.setItem(RAIL_COLLAPSED_KEY, serializeRailCollapsed(v))
  } catch {
    /* 同上：只影响"跨启动还记得" */
  }
  for (const f of subs) f()
}

export function toggleRailCollapsed(): void {
  setRailCollapsed(!collapsed)
}

export function subscribeRailCollapsed(cb: () => void): () => void {
  subs.add(cb)
  return () => { subs.delete(cb) }
}

export function useRailCollapsed(): boolean {
  return useSyncExternalStore(subscribeRailCollapsed, railCollapsed, railCollapsed)
}
