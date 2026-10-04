/**
 * 能力矩阵的**纯逻辑**（devlog/086）：把 `GET /capabilities` 的结果翻译成界面要说的话。
 *
 * 为什么单独抽出来：这几条判错了**界面不会报错**，只是"少说了一句"或"说错了一句" ——
 * 比如把 `degraded` 当成可用（用户点了才发现不行）、把限制说成"功能不可用"（其实能用）。
 * 组件只负责渲染，判定都在这儿，可以脱离 DOM 测。
 */
import type { Capabilities, CapabilityFeature, CapabilityLimit, CapabilityState } from '../api/types'

/** 内容抓取的 feature id（投稿 + 动态）—— 全项目只认这一个字符串 */
export const FETCH_POSTS = 'fetch_posts'
/** 微博内容的 feature id */
export const WEIBO_CONTENT = 'weibo_content'
/** 小红书内容的 feature id（2026-10-04 补：以前矩阵里根本没有这一条，devlog/320） */
export const XHS_CONTENT = 'xhs_content'
/** 抖音内容的 feature id（devlog/334/335）—— 它多一道**默认关着的总开关** */
export const DOUYIN_CONTENT = 'douyin_content'

/** 取某条限制（没有 = 该功能当前完整可用） */
export function limitOf(caps: Capabilities | null, id: string): CapabilityLimit | null {
  if (!caps) return null
  return caps.limited.find((x) => x.id === id) ?? null
}

/** 取某条能力的完整信息（含未登录时的固有状态与实测依据） */
export function featureOf(caps: Capabilities | null, id: string): CapabilityFeature | null {
  if (!caps) return null
  return caps.features.find((x) => x.id === id) ?? null
}

/** 该功能当前是否**完全不能做**（需要登录） */
export function isLoginRequired(caps: Capabilities | null, id: string): boolean {
  return limitOf(caps, id)?.state === 'requires_login'
}

/** 该功能当前是"能用但打折" */
export function isDegraded(caps: Capabilities | null, id: string): boolean {
  return limitOf(caps, id)?.state === 'degraded'
}

/** 该功能是**被我们自己的总开关关了**（`disabled`，devlog/338）——
 *  ⚠️ 与 `isLoginRequired` 分开：这条的补救动作是"去设置里打开"，不是"去登录"。 */
export function isDisabled(caps: Capabilities | null, id: string): boolean {
  return limitOf(caps, id)?.state === 'disabled'
}

/**
 * 受限项的**角标**：状态 → 文案 + 样式类（纯逻辑，有单测）。
 *
 * ⚠️ 为什么状态要分家（2026-10-05 用户真机反馈，devlog/338）：抖音总开关关着时，
 * 角标写着「需要登录」，用户的结论是"我粘的 Cookie 没生效"，于是反复重粘 ——
 * 而真正该做的是去设置里打开开关。**补救动作不同，说法就必须不同。**
 * 认不出的状态按 `degraded` 兜底（宁少说，不误导）。
 */
export function limitBadge(state: CapabilityState): { text: string; cls: string } {
  if (state === 'requires_login') return { text: '需要登录', cls: 'req' }
  if (state === 'disabled') return { text: '未启用', cls: 'dis' }
  return { text: '部分受限', cls: 'deg' }
}

/** 顶栏一行话：没有限制时返回空串（调用方据此决定要不要渲染入口） */
export function limitsSummary(caps: Capabilities | null): string {
  if (!caps || caps.limited.length === 0) return ''
  const who = caps.bilibili_logged_in ? '' : '未登录'
  const count = `${caps.limited.length} 项受限`
  return who ? `${who} · ${count}` : count
}

/**
 * 给"去登录"按钮的文案。
 * 微博与 B 站都得登录时不必分平台 —— 登录窗口本身就是两个平台页签。
 * ⚠️ 小红书（Cookie 口径）**不改这里**：登录窗口有它自己的页签，顶上这句是给
 * "要不要点进去"用的，只说 B 站/微博（多一个名字反而更长、更容易看错）。
 */
export function loginActionLabel(caps: Capabilities | null): string {
  if (!caps) return '登录'
  if (!caps.bilibili_logged_in && !caps.weibo_logged_in) return '登录 B 站 / 微博'
  if (!caps.bilibili_logged_in) return '登录 B 站'
  if (!caps.weibo_logged_in) return '登录微博'
  return '登录'
}

/** 某条限制的一句话（用于按钮提示/浮窗行；找不到就给通用说明） */
export function limitText(caps: Capabilities | null, id: string): string {
  return limitOf(caps, id)?.note ?? ''
}

/**
 * 未登录时"能做什么"的清单 —— 顶栏说明窗的正文（**不许**只列不能做的：
 * 用户最需要知道的是"我现在还能干什么"）。
 */
export function availableSummary(caps: Capabilities | null): string[] {
  if (!caps) return []
  return caps.features
    .filter((f) => f.state === 'full')
    .map((f) => f.label)
}
