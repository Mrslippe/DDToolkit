import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/api'
import {
  applyTheme, resolveTheme, systemPrefersDark, themeCaveat, watchSystemTheme,
  type ThemePref,
} from '../utils/theme'

interface PrefsSpecOption {
  value: string
  label: string
}

export interface PrefsSpec {
  key: string
  label: string
  group: string
  options: PrefsSpecOption[]
  note: string
}

/**
 * 界面偏好（R14b，devlog/092）：主题。
 *
 * 三件事一起做，缺一件就是"假主题"：
 * ① 从后端读偏好（偏好是**跨启动**的，不能只放 localStorage —— 打包版换端口/清缓存
 *    都会丢，而用户改的是"这个应用长什么样"）；
 * ② 解析并写到 `html[data-theme]`；
 * ③ **跟随系统要真的跟随**：订阅 `prefers-color-scheme`，系统切换时立刻重解析。
 *
 * 解析与文案全在 `utils/theme.ts`（纯函数、有单测），这里只负责取数与副作用。
 */
export function useThemePref() {
  const [pref, setPref] = useState<ThemePref>('light')
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark())
  const [spec, setSpec] = useState<PrefsSpec | null>(null)
  const [loaded, setLoaded] = useState(false)

  const resolved = resolveTheme(pref, systemDark)
  const caveat = themeCaveat(pref, systemDark)

  // 应用到根元素（每次解析结果变化都写一次 —— 幂等）
  useEffect(() => {
    applyTheme(globalThis.document?.documentElement, resolved)
  }, [resolved])

  // 跟随系统：系统主题一变就重解析
  useEffect(() => watchSystemTheme(setSystemDark), [])

  // 读偏好（失败保持默认浅色，不阻塞界面）
  const load = useCallback(async () => {
    try {
      const r = await api.getPrefs()
      const t = r.values.theme
      if (t === 'light' || t === 'system') setPref(t)
      setSpec((r.specs ?? []).find((s) => s.key === 'theme') ?? null)
    } catch {
      /* 后端不可达：按浅色显示，设置窗口里会给出读取失败提示 */
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => { if (!cancelled) await load() })()
    return () => {
      cancelled = true
    }
  }, [load])

  /** 改主题：先乐观应用（界面立刻变），落库失败再退回并抛出（调用方提示） */
  const setTheme = useCallback(async (next: ThemePref) => {
    const prev = pref
    setPref(next)
    try {
      await api.savePrefs({ theme: next })
    } catch (e) {
      setPref(prev)
      throw e
    }
  }, [pref])

  return { pref, setTheme, resolved, caveat, spec, loaded, reload: load }
}
