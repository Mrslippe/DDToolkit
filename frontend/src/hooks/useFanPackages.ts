import { useEffect, useSyncExternalStore } from 'react'

import { api } from '../api/api'
import type { FanPackageMeta } from '../api/types'

/**
 * **结果包**索引（2026-10-28，用户第 1 条）：每个 V 一份分析结果，切回该 V 时直接铺。
 *
 * ## 为什么是模块级 store
 *
 * 工作台切 V 时要**同步**知道"这个 V 有没有结果包"（决定铺结果还是走现算）。
 * 每次切 V 都打一次 `/fan/packages` 会有可见延迟（而且切得快时会产生竞态），
 * 所以：进页面拉一次 → 之后靠 `startCollect`/分析完成时**主动刷新**。
 *
 * ## 与 `useFanTask` 的分工
 *
 * - `useFanTask`：**正在发生的事**（采集/分析的进度）；
 * - 本模块：**已经算出来的结果**（包）。
 * 两者独立：任务跑完 → 刷新包索引 → 工作台按索引铺结果。
 */

let items: FanPackageMeta[] = []
let loaded = false
const subs = new Set<() => void>()
let inflight: Promise<void> | null = null

function emit(): void {
  for (const fn of [...subs]) fn()
}

export function subscribeFanPackages(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

export function fanPackageList(): FanPackageMeta[] {
  return items
}

export function useFanPackages(): FanPackageMeta[] {
  return useSyncExternalStore(subscribeFanPackages, fanPackageList, fanPackageList)
}

/** 按主播名/简称找包（后端包里的 `vtuber` 是**显示名**，可能与 `short` 不同） */
export function findPackage(name: string, short?: string): FanPackageMeta | null {
  if (!name) return null
  return items.find((p) => p.vtuber === name)
    ?? (short ? items.find((p) => p.vtuber === short) : null)
    ?? null
}

/** 拉一次索引（并发保护：同一时刻只发一个请求） */
export function refreshFanPackages(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const r = await api.fanPackages()
      items = r.items ?? []
      loaded = true
    } catch {
      /* 后端不可达：保持上一份。没包索引时切 V 就退回"现算"，不会崩 */
    } finally {
      inflight = null
      emit()
    }
  })()
  return inflight
}

/** 组件里首次挂载时拉一次（多个组件挂载也只发一个请求） */
export function useFanPackagesIndex(): FanPackageMeta[] {
  const list = useFanPackages()
  useEffect(() => { if (!loaded) void refreshFanPackages() }, [])
  return list
}

/** 清空 —— **只给用例用**（模块级状态不重置会跨用例串味） */
export function resetFanPackages(): void {
  items = []
  loaded = false
  inflight = null
  emit()
}
