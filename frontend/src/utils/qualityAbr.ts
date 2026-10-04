/**
 * 自动降档策略（ABR，2026-10-04，`devlog/328`）。
 *
 * ## 为什么要它
 *
 * 内核（`utils/mseKernel.ts`）量的是"**取回来的字节 / 耗时**"，并把它与段表里的**码率**比。
 * 但"要不要降、降到哪一档"不该由内核决定：它不知道有哪些档、哪些档要大会员、用户手动选过什么。
 * ⇒ 策略抽成**纯函数**放这里，内核只报事实（`onLinkSlow`），播放器调这里拿决定。
 *
 * ## 三条纪律（都为了"别让用户觉得画质无谓地掉"）
 *
 * 1. **只降一级**：一次跳一大档（1080P→480P）比不降更让人恼火；降到能喂饱为止。
 * 2. **只降不升**：自动升档会在"刚好够/刚好不够"之间来回抖（画质闪、还多取一次流）。
 * 3. **有上限**：一次播放最多自动降 `MAX_AUTO_DOWNGRADES` 次 —— 链路真的很差时，
 *    继续降也只是从"卡"变成"糊"，不如把剩下的交给用户自己选。
 */

/** 一档清晰度（与播放器 `qualities` 同形） */
export interface QualityOption {
  id: number
  label: string
  /** 不可选（如大会员专属）—— 自动降档**不许**挑这种 */
  disabled?: boolean
  note?: string
}

/** 一次播放最多自动降几档 */
export const MAX_AUTO_DOWNGRADES = 2

/**
 * 该降到哪一档：比当前低、可选、取其中**最高**的一档（= 只降一级）。
 *
 * 返回 `null` ⇒ 不降（没有档位信息 / 已经在最低 / 更低的都要大会员）。
 */
export function pickDowngrade(
  qualities: QualityOption[] | null | undefined,
  currentId: number | null | undefined,
): QualityOption | null {
  if (!qualities?.length || currentId == null) return null
  const lower = qualities
    .filter((q) => !q.disabled && q.id < currentId)
    .sort((a, b) => b.id - a.id)
  return lower[0] ?? null
}

/** Mbit/s，一位小数（诊断与菜单文案共用，别各写一份换算） */
export function mbps(bytesPerSec: number): string {
  return `${((bytesPerSec * 8) / 1_000_000).toFixed(1)}Mbps`
}

/**
 * 给用户看的那句话（**放进清晰度菜单里**，不弹窗）。
 *
 * 口径：说清"实测多少 / 这一档要多少 / 已经降到哪档"—— 用户能自己判断要不要再往下降
 * 或者干脆切回原档。
 */
export function linkSlowNote(measuredBytesPerSec: number, neededBytesPerSec: number,
                             fromLabel: string, toLabel: string): string {
  return `链路实测 ${mbps(measuredBytesPerSec)}，低于 ${fromLabel} 需要的 `
    + `${mbps(neededBytesPerSec)} ⇒ 已自动降到 ${toLabel}`
}
