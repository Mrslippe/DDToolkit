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

export interface CardKindMeta {
  /** 稳定标识（P2 起落库；布局行按它认卡片） */
  kind: string
  /** 卡片标题（卡片头部那一行） */
  title: string
  /** 默认尺寸（12 列网格里的宽 × 行数） */
  defaultSize: CardSize
  render: (ctx: CardContext) => ReactNode
}

const registry = new Map<string, CardKindMeta>()

/** 注册一种卡片；重复 kind 直接抛错（静默覆盖会让"注册了却没显示"极难排查）。 */
export function registerCardKind(meta: CardKindMeta): void {
  if (registry.has(meta.kind)) {
    throw new Error(`卡片 kind 重复注册：${meta.kind}`)
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