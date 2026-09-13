/**
 * 签名下拉栏的**行数据整形**（2026-09-13，devlog/072）。
 *
 * 抽成纯函数的理由：这里有三条**只能靠断言钉住**的规则 ——
 * ① 只列**有签名**的账号（空签名进列表就是一行空白，看着像坏了）；
 * ② 主账号要标出来（卡片的签名只取主账号，用户得知道哪条是"当前生效"的）；
 * ③ "当前项"判定要能吃两种输入：`vtubers.avatar` 式的显式选择（这里对应
 *    `vtubers` 已保存的签名）与**未显式选过时回落到主账号**（与头像同款口径）。
 *
 * 组件侧只负责渲染与交互，判定逻辑放这里跑 vitest。
 */
import type { Account } from '../api/types'
import { PLATFORM_LABEL } from './postTypes'

export interface SignOption {
  id: number
  platform: string
  /** 平台展示名（`PLATFORM_LABEL` 兜底原值） */
  label: string
  /** 该账号当前签名（非空，调用方已过滤） */
  sign: string
  /** 是否主账号（卡片的签名取自它） */
  isHero: boolean
  /** 是否是"当前生效"的那一条 */
  active: boolean
}

/**
 * @param accounts  该 V 的全部账号
 * @param heroId    主账号 id（没有则传 null）
 * @param current   输入框里当前的值（用于判定 active；空串/null = 未选过）
 */
export function buildSignOptions(
  accounts: Account[],
  heroId: number | null,
  current: string | null | undefined,
): SignOption[] {
  const rows = accounts.filter((a) => (a.sign ?? '').trim() !== '')
  const cur = (current ?? '').trim()
  return rows.map((a) => {
    const sign = (a.sign ?? '').trim()
    return {
      id: a.id,
      platform: a.platform,
      label: PLATFORM_LABEL[a.platform] ?? a.platform,
      sign,
      isHero: heroId != null && a.id === heroId,
      // 未显式选过（输入框为空）→ 回落到主账号；否则与输入框内容比对。
      // 注意：用"输入框内容"而不是"已保存值"判定 —— 用户手打一半时列表也该跟着动。
      active: cur === '' ? heroId != null && a.id === heroId : sign === cur,
    }
  })
}
