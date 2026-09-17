/**
 * 卡片注册表（R37-P1，devlog/141）—— 「支持拓展和自定义」的**唯一入口**。
 *
 * 用户口径（2026-09-17）：「以卡片为基本单位……卡片内容由用户自定义，例如有纪念日、
 * 优质投稿、大事记、时间线等等，然后**支持拓展和自定义**」。
 * 同日拍板：扩展点做成**前端注册表**（照本仓已有的 `registerIdleProvider` 先例），
 * 后端只管供数 —— 卡片本质是前端展示，做成后端插件只是多一层转发。
 *
 * ## 一条纪律
 *
 * 注册表**不认识任何具体卡片**：`cards/index.ts` 负责把内置卡片注册进来，
 * 视图只读 `listCardKinds()`。加一种卡片 = 新增一个文件 + 在那里 `registerCardKind`，
 * **不用改视图**（P3 的"自定义卡片"也走这条入口）。
 */
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import type { Account, Post, VTuber } from '../../api/types'
import type { CardSize } from './layoutModel'

/** 卡片渲染时拿到的上下文（视图只传这些；卡片自己去取自己需要的数据） */
export interface CardContext {
  vtuber: VTuber
  /** 卡片跟随的账号（B 站优先，与展示页 hero 同口径；没有账号时为 null） */
  account: Account | null
  /** 打开帖子详情抽屉（复用页面里那一个，别各写一份） */
  onOpenPost: (post: Post) => void
  /** 抓取完成边沿：卡片据此重取自己的数据 */
  refreshTick: number
}

/**
 * 卡片色调（R37-P4a，`docs/design-archive-cards.md` §3）—— **只用在贴纸角标与文字 chip 上**。
 *
 * 卡面主体永远是白卡 + 中性文字：「生动」来自层次，不来自色块面积。
 * 色调写成封闭清单（而不是任意色值）是为了让"每卡一色"这件事可校验 ——
 * 随便传个 `#123456` 会让贴纸角标脱离项目色系，而那种错只有肉眼能发现。
 */
export const CARD_TONES = ['pink', 'coral', 'navy', 'gray'] as const
export type CardTone = (typeof CARD_TONES)[number]

export interface CardKindMeta {
  /** 稳定标识（P2 起落库；布局行按它认卡片） */
  kind: string
  /** 卡片标题（卡片头部那一行） */
  title: string
  /** 默认尺寸（12 列网格里的宽 × 行数） */
  defaultSize: CardSize
  /** 贴纸角标图标（22px 圆片里那枚 13px 图标；**每种卡片必须有一个**，见规格 §3） */
  icon: LucideIcon
  /** 贴纸角标色调（同 §3 的 tone 表；封闭清单，非法值直接抛） */
  tone: CardTone
  render: (ctx: CardContext) => ReactNode
}

const registry = new Map<string, CardKindMeta>()

/**
 * 注册一种卡片。三条**当场抛错**的校验（静默放过会让问题长在别人身上）：
 *   ① 重复 kind —— 静默覆盖会让"注册了却没显示 / 显示成别人的样子"极难排查；
 *   ② 色调不在清单里 —— 会得到一枚脱离项目色系的贴纸角标，肉眼才发现；
 *   ③ 没给图标 —— 角标会是一个空圆片，看起来像"加载失败"。
 */
export function registerCardKind(meta: CardKindMeta): void {
  if (registry.has(meta.kind)) {
    throw new Error(`卡片 kind 重复注册：${meta.kind}`)
  }
  if (!CARD_TONES.includes(meta.tone)) {
    throw new Error(
      `卡片 ${meta.kind} 的色调 ${String(meta.tone)} 不在允许清单里`
      + `（${CARD_TONES.join(' / ')}）—— 见 docs/design-archive-cards.md §3`,
    )
  }
  if (!meta.icon) {
    throw new Error(`卡片 ${meta.kind} 没有贴纸角标图标（每张卡都必须有一枚，见规格 §3）`)
  }
  registry.set(meta.kind, meta)
}

export function getCardKind(kind: string): CardKindMeta | undefined {
  return registry.get(kind)
}

/** 已注册的卡片（顺序 = 注册顺序 = 默认布局里的排列顺序）。 */
export function listCardKinds(): CardKindMeta[] {
  return [...registry.values()]
}

/** 仅供单测：清空注册表（模块级状态，用例之间必须隔离）。 */
export function resetCardKinds(): void {
  registry.clear()
}