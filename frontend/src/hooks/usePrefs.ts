import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/api'
import type { Prefs, PrefsSpec } from '../api/types'
import {
  applyTheme, resolveTheme, systemPrefersDark, themeCaveat, watchSystemTheme,
  type ThemePref,
} from '../utils/theme'
import { parseCloseAction, type CloseAction } from '../utils/shellState'
import { parseWidgetEnabled, type WidgetEnabled } from '../utils/widgetWindow'

/**
 * 界面偏好（R14b 起：主题；R18 起：关闭窗口语义）—— 一个 hook 管全部偏好。
 *
 * 三件事一起做，缺一件就是"假偏好"：
 * ① 从后端读（偏好是**跨启动**的，不能只放 localStorage —— 打包版换端口/清缓存都会丢，
 *    而用户改的是"这个应用长什么样 / 关窗怎么办"）；
 * ② 主题要**真的落地**：解析后写到 `html[data-theme]`；
 * ③ **跟随系统要真的跟随**：订阅 `prefers-color-scheme`，系统切换时立刻重解析。
 *
 * 解析与文案全在 `utils/theme.ts`（纯函数、有单测），这里只负责取数与副作用。
 */
export function usePrefs() {
  const [values, setValues] = useState<Record<string, string>>({
    theme: 'light', close_action: 'ask', widget_enabled: 'off',
  })
  const [specs, setSpecs] = useState<PrefsSpec[]>([])
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark())
  const [loaded, setLoaded] = useState(false)

  const pref = (values.theme === 'system' ? 'system' : 'light') as ThemePref
  const closeAction: CloseAction = parseCloseAction(values.close_action)
  const widgetEnabled: WidgetEnabled = parseWidgetEnabled(values.widget_enabled)
  const resolved = resolveTheme(pref, systemDark)
  const caveat = themeCaveat(pref, systemDark)

  // 应用到根元素（每次解析结果变化都写一次 —— 幂等）
  useEffect(() => {
    applyTheme(globalThis.document?.documentElement, resolved)
  }, [resolved])

  // 跟随系统：系统主题一变就重解析
  useEffect(() => watchSystemTheme(setSystemDark), [])

  const load = useCallback(async () => {
    try {
      const r: Prefs = await api.getPrefs()
      setValues({ theme: 'light', close_action: 'ask', ...r.values })
      setSpecs(r.specs ?? [])
    } catch {
      /* 后端不可达：按默认值显示，设置窗口里会给出读取失败提示 */
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 改偏好：先乐观应用（界面立刻变），落库失败再退回并抛出（调用方提示） */
  const setPref = useCallback(async (key: string, next: string) => {
    const prev = values[key]
    setValues((v) => ({ ...v, [key]: next }))
    try {
      await api.savePrefs({ [key]: next })
    } catch (e) {
      setValues((v) => ({ ...v, [key]: prev ?? '' }))
      throw e
    }
  }, [values])

  /** 主题专用的小包装（调用点更可读） */
  const setTheme = useCallback((next: ThemePref) => setPref('theme', next), [setPref])

  const specOf = useCallback(
    (key: string) => specs.find((s) => s.key === key) ?? null,
    [specs],
  )

  return {
    values, specs, specOf, pref, closeAction, widgetEnabled, resolved, caveat, loaded,
    setPref, setTheme, reload: load,
  }
}
