/**
 * 全局播放偏好（2026-10-03，devlog/283）：**音量 / 静音 / 倍速 单一真源**。
 *
 * 用户口径：「注意音量全局共用，以防一个播放器声音小一个播放器声音大」—— 浏览器默认是
 * **每个 `<video>` 各自一份**音量，换一条视频就回到 100% ⇒ 观感一跳一跳。
 * 所以这里既做**进程内共享**（订阅后所有实例同步），也做**跨会话持久化**（localStorage）。
 *
 * ⚠️ 静音与音量为 0 必须能分开（volume=0 时用户会以为"坏了"，静音要有明确的图标态）。
 */
const KEY = 'ddtoolkit.player.prefs'

export interface PlayerPrefs {
  /** 0–1（不含静音） */
  volume: number
  muted: boolean
  /** 倍速：0.5 / 1 / 1.5 / 2 */
  rate: number
}

export const PLAYBACK_RATES: readonly number[] = [0.5, 1, 1.5, 2]
const DEFAULTS: PlayerPrefs = { volume: 1, muted: false, rate: 1 }

function clampVolume(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return DEFAULTS.volume
  return Math.min(1, Math.max(0, n))
}

function load(): PlayerPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const d = JSON.parse(raw) as Partial<PlayerPrefs>
    return {
      volume: clampVolume(d.volume),
      muted: Boolean(d.muted),
      rate: PLAYBACK_RATES.includes(Number(d.rate)) ? Number(d.rate) : DEFAULTS.rate,
    }
  } catch {
    return { ...DEFAULTS }      // 存储被禁/坏 JSON：退回默认，不抛
  }
}

let prefs: PlayerPrefs = load()
const listeners = new Set<() => void>()

/** 当前偏好（**引用稳定**，可直接喂 `useSyncExternalStore`） */
export function playerPrefs(): PlayerPrefs {
  return prefs
}

export function setPlayerPrefs(patch: Partial<PlayerPrefs>): void {
  const next: PlayerPrefs = {
    volume: patch.volume === undefined ? prefs.volume : clampVolume(patch.volume),
    muted: patch.muted === undefined ? prefs.muted : Boolean(patch.muted),
    rate: patch.rate === undefined || !PLAYBACK_RATES.includes(Number(patch.rate))
      ? prefs.rate : Number(patch.rate),
  }
  if (next.volume === prefs.volume && next.muted === prefs.muted && next.rate === prefs.rate) return
  prefs = next
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* 私隐模式/配额：内存里仍然生效，不抛 */
  }
  for (const fn of listeners) fn()
}

export function subscribePlayerPrefs(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 把全局偏好下发给某个 media 元素（挂载时与每次变更时都要调） */
export function applyPlayerPrefs(el: HTMLMediaElement): void {
  el.volume = prefs.volume
  el.muted = prefs.muted
  el.playbackRate = prefs.rate
}

/** 测试/排查用：恢复到默认并清掉持久化 */
export function resetPlayerPrefs(): void {
  prefs = { ...DEFAULTS }
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
  for (const fn of listeners) fn()
}
