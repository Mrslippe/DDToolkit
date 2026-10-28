import { useEffect, useSyncExternalStore } from 'react'

import { api } from '../api/api'

/**
 * 工作台「隐藏昵称」（2026-10-28 用户口径）：「隐藏用户昵称、一律改用 uid 显示，
 * 并在设置窗口加一个开关控制」。
 *
 * ## 为什么是模块级 store，而不是把偏好一路当 prop 传下去
 *
 * 这个开关要作用在**五个互不相邻**的地方：名单表（`RankedTable`）、成员抽屉
 * （`MemberDrawer`）、搜索下拉（`MemberSearch`）、贡献榜饼图图例（`ResultCharts`）、
 * 评论交集表（`CommentComparePane`）。它们分布在 `WorkbenchPage` 底下好几层，而
 * `WorkbenchPage` 自己**不持有偏好**（`fan_workbench` 那个开关归 `IconRail`）——
 * 做成 prop 就要给每个组件加参数、给每条已有用例补 provider，收益为零。
 * 与 `utils/groupBadgePref.ts` 同一套路：模块级现值 + 订阅。
 *
 * ⚠️ 与 `groupBadgePref` 的**关键差别**：那个只要给根元素挂个属性、CSS 就能整块隐藏
 * （不需要重渲染）；这里要换掉的是**文字**（连 canvas 里的饼图图例也要换），CSS 做不到
 * ⇒ 必须让组件重渲染，所以多了 `useSyncExternalStore` 这一层订阅。
 * 根元素属性照样挂上（`data-hide-nicknames`），探针与将来的样式复用都认它。
 *
 * ⚠️ 兜底值必须与后端 `PREFS["hide_nicknames"]` 的默认一致（**关**）：读不到后端时
 * 前端按这里的值走。两边一漂，症状是"设置里显示开、工作台却还在露昵称"。
 */

/** 默认值：**关**（与后端 `PREFS["hide_nicknames"]` 的第一项一致） */
export const HIDE_NICKNAMES_DEFAULT = 'off'

/** 根元素属性名（探针/样式认它 —— 单一事实来源） */
export const HIDE_NICKNAMES_ATTR = 'data-hide-nicknames'

/** 模块级现值 */
let current = false

/** 订阅者（`useSyncExternalStore` 那一套） */
const subs = new Set<() => void>()

/** 归一化：只有 `'on'` 算开，其余（含 `undefined`/乱值/空串）一律当关 */
function norm(v: unknown): boolean {
  return String(v ?? '').trim() === 'on'
}

/** 现在开着没有（读模块级现值；供组件与用例查询） */
export function hideNicknamesOn(): boolean {
  return current
}

/** 应用一次：写模块级现值 + 根元素属性，并**通知订阅者重渲染** */
export function applyHideNicknames(v: unknown): boolean {
  const next = norm(v)
  const changed = next !== current
  current = next
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute(HIDE_NICKNAMES_ATTR, next ? 'on' : 'off')
  }
  // 只在真的变了时通知：`useSyncExternalStore` 每次通知都会重渲染，
  // 而 `applyHideNicknames` 会被"启动读一次 + 每次改动再读一次"重复调用。
  if (changed) for (const fn of [...subs]) fn()
  return current
}

/**
 * 清回默认并**忘掉那次加载** —— 只给用例用（与 `resetGroupBadge()` 同一路数）。
 *
 * ⚠️ 必须导出：`current` 与 `loading` 都是**模块级**的，一个测试文件里多条用例共用
 * 同一个模块实例 —— 不重置就会"上一条把开关打开，下一条测默认态时看到的是开"。
 */
export function resetHideNicknames(): void {
  applyHideNicknames(HIDE_NICKNAMES_DEFAULT)
  loading = null
}

/** 订阅（`useSyncExternalStore` 的入参） */
export function subscribeHideNicknames(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

/**
 * 名字口径：开了就只给 uid，关着就用昵称（昵称为空也退回 uid）。
 *
 * uid 是**稳定键**：换成 uid 不改变任何口径，只是把真人昵称藏起来
 * （演示 / 录屏 / 截图时用户不想露出来）。
 */
export function shownName(uid: string, name: string | null | undefined, hide: boolean): string {
  if (hide) return uid
  const n = (name ?? '').trim()
  return n || uid
}

/**
 * 头像兜底的那个首字（`Avatar`）。
 *
 * ⚠️ 隐藏昵称时**必须**用 uid 的首位：头像加载失败时若还拿昵称首字兜底，
 * 屏幕角落就会露出一个"鲸"字 —— 开关等于没用。
 */
export function shownInitial(uid: string, name: string | null | undefined, hide: boolean): string {
  return (shownName(uid, name, hide) || uid).slice(0, 1).toUpperCase()
}

/**
 * 启动时把偏好读进来并应用一次（多个组件都会调，模块级 promise 保证**只发一次**请求）。
 *
 * ⚠️ 读失败**不重试也不报错**：兜底是"关"（按昵称显示），重试留给下次启动。
 * ⚠️ 设置页改完会**直接**调 `applyHideNicknames`（乐观生效），不依赖这条再跑一遍。
 */
let loading: Promise<void> | null = null

function ensureLoaded(): void {
  if (loading) return
  loading = (async () => {
    try {
      const r = await api.getPrefs()
      applyHideNicknames(r.values.hide_nicknames)
    } catch {
      /* 后端不可达：保持模块里的默认值（关） */
    }
  })()
}

/** 组件里读开关：订阅变更 + 首次挂载时触发一次加载 */
export function useHideNicknames(): boolean {
  const on = useSyncExternalStore(subscribeHideNicknames, hideNicknamesOn, hideNicknamesOn)
  useEffect(() => { ensureLoaded() }, [])
  return on
}
