/**
 * 播放内核选择（2026-10-04，devlog/312）：**默认 MSE**，渐进式只作为退路。
 *
 * ## 为什么默认就切（用户 2026-10-04 口径）
 *
 * 「默认 MSE、开关只作为退路。因为当前卡顿太频繁了，几乎 90% 会出现」——
 * 旧内核（progressive `<video src>` + 独立 `<audio>`）不是"偶发慢"，是**seek 后必卡**
 * （`devlog/310` 八次复现形状一致）。所以这里默认 `mse`，渐进式留给两种情况：
 *
 * 1. **自动**：MSE 建不起来 / codecs 不支持 / 段表拿不到 / append 报错 ⇒ 当场退回渐进式
 *    （`noteMseFailure` 还会把**本次会话**整个熔断，免得每个视频都先撞一次墙）；
 * 2. **手动**：设置里那一项（`AppSettingsDialog` 的「视频播放」）—— 真机上万一 MSE 更差，
 *    用户自己切回来，不用等我发新版。
 *
 * ## 为什么放 localStorage 而不是后端偏好
 *
 * 它是**播放器偏好**（与音量/倍速同一族，`utils/playerPrefs`），播放器要**同步**读到它 ——
 * 走后端就得在起播前多一次网络往返，还要处理"没读到之前用哪个内核"这种中间态。
 * 桌面壳的来源是稳定的，localStorage 跨启动有效。
 */
const KEY = 'ddtoolkit.player.kernel'

export type KernelChoice = 'mse' | 'progressive'

/** 设置界面用的选项（文案与说明在这里，界面不自己编） */
export const KERNEL_OPTIONS: { value: KernelChoice; label: string; note: string }[] = [
  {
    value: 'mse',
    label: 'MSE（默认）',
    note: '按段取数的新内核：跳转到哪一秒就取哪一段，只有一个播放时钟，'
        + '画面不会在跳转后先卡住再追赶。段表拿不到时自动退回旧内核。',
  },
  {
    value: 'progressive',
    label: '渐进式（退路）',
    note: '旧内核（浏览器自己按 Range 取数 + 独立音轨）。新内核在你的机器上表现更差时才切回来，'
        + '切完立刻生效、不用重启。',
  },
]

function load(): KernelChoice {
  try {
    return localStorage.getItem(KEY) === 'progressive' ? 'progressive' : 'mse'
  } catch {
    return 'mse'      // 存储被禁：默认值就是"用新内核"
  }
}

let pref: KernelChoice = load()
/** 本次会话内 MSE **熔断**（自动回退过一次就整场不再试，见文件头"自动"那条） */
let sessionOff = false
/**
 * 熔断状态的**快照对象**。
 *
 * ⚠️ **必须引用稳定**（`devlog/312` 的真事故）：`useSyncExternalStore(subscribe, snapshot)`
 * 用 `Object.is` 比快照，而"每次调用现造一个 `{off, why}`"永远不相等 ⇒ React 判定
 * "外部状态又变了" ⇒ **无限重渲染**，整个应用壳崩成"页面渲染出错：Maximum update depth exceeded"
 * （无头探针第一条就抓到了：`views=['empty']` + DOM 里那段 React 报错）。
 * 规矩：传给 `useSyncExternalStore` 的快照要么是原始值，要么是**只在变化时替换**的对象。
 */
let sessionState: Readonly<{ off: boolean; why: string }> = { off: false, why: '' }
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

/** 用户存的那一份（设置界面显示用；不含会话熔断） */
export function kernelChoice(): KernelChoice {
  return pref
}

/** **实际会用**的内核（含会话熔断）—— 播放器只该看这个 */
export function effectiveKernel(): KernelChoice {
  return sessionOff ? 'progressive' : pref
}

export function setKernelChoice(next: KernelChoice): void {
  const v: KernelChoice = next === 'progressive' ? 'progressive' : 'mse'
  if (v === pref && !(v === 'mse' && sessionOff)) return
  pref = v
  if (v === 'mse') clearBreaker()               // 用户重新选 MSE = 再给它一次机会
  try {
    localStorage.setItem(KEY, v)
  } catch {
    /* 私隐模式/配额：内存里仍然生效 */
  }
  emit()
}

/**
 * MSE 在这个会话里**栽了**（`VideoPlayer` 的 `onFatal` 调它）。
 *
 * 为什么不只退这一个视频：真机上"每个视频都先试 MSE、失败再退"= 每次都先卡一下，
 * 而用户要的恰恰是"别再卡"。熔断只影响本次运行，**不改用户存的那份偏好**
 * （否则一次偶发的 CDN 抽风会永久改掉他的选择）。
 */
export function noteMseFailure(why: string): void {
  if (sessionOff) return
  sessionOff = true
  sessionState = { off: true, why }      // **换引用**（不是改字段）：订阅方靠它判"变了"
  emit()
}

export function mseSessionOff(): Readonly<{ off: boolean; why: string }> {
  return sessionState
}

/** 解除熔断（换引用，理由同上一条） */
function clearBreaker(): void {
  if (!sessionOff) return
  sessionOff = false
  sessionState = { off: false, why: '' }
}

export function subscribeKernel(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 测试用：回到默认（MSE、不熔断）并清掉持久化。**生产代码不调它**。 */
export function resetVideoKernel(): void {
  pref = 'mse'
  clearBreaker()
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
  emit()
}
