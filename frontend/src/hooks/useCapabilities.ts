import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/api'
import type { Capabilities } from '../api/types'

/**
 * 能力矩阵的共享读取（devlog/086）。
 *
 * 设计取舍：
 * - **模块级缓存 + TTL 60s**：能力只随登录态变化，而登录态由 B 站心跳/扫码驱动 ——
 *   60 秒粒度足够，且多个组件（顶栏 / 添加 V / 批量浮窗）共用一个请求，不做 N 次；
 * - **显式刷新**：登录成功后（LoginDialog 关闭、扫码 confirmed）派发
 *   `ddtoolkit:capabilities-refresh` 立即重取 —— 否则用户刚登录完还看到"未登录受限"，
 *   会以为登录没生效（这类"界面撒谎"比不提示更糟）；
 * - 失败**不抛出**：能力读不到就当 `null`（界面退化成不显示提示），不能因为一个提示接口
 *   把主界面搞挂。
 */
const TTL_MS = 60_000
const REFRESH_EVENT = 'ddtoolkit:capabilities-refresh'

let cache: { at: number; data: Capabilities | null } = { at: 0, data: null }
let inflight: Promise<Capabilities | null> | null = null

/** 立即失效缓存并通知所有使用者重取（登录成功/退出后调用） */
export function refreshCapabilities(): void {
  cache = { at: 0, data: null }
  window.dispatchEvent(new Event(REFRESH_EVENT))
}

export async function loadCapabilities(force = false): Promise<Capabilities | null> {
  const fresh = cache.data && Date.now() - cache.at < TTL_MS
  if (fresh && !force) return cache.data
  if (inflight) return inflight
  inflight = api
    .capabilities()
    .then((data) => {
      cache = { at: Date.now(), data }
      return data
    })
    .catch(() => cache.data)     // 读不到就沿用旧值（可能为 null），绝不抛
    .finally(() => {
      inflight = null
    })
  return inflight
}

export interface UseCapabilities {
  caps: Capabilities | null
  refresh: () => void
}

export function useCapabilities(): UseCapabilities {
  const [caps, setCaps] = useState<Capabilities | null>(cache.data)

  const load = useCallback((force: boolean) => {
    let alive = true
    void loadCapabilities(force).then((c) => {
      if (alive) setCaps(c)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => load(false), [load])

  useEffect(() => {
    const onChange = () => {
      setCaps(null)
      load(true)
    }
    const onFocus = () => load(false)
    window.addEventListener(REFRESH_EVENT, onChange)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener(REFRESH_EVENT, onChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  return { caps, refresh: () => refreshCapabilities() }
}
