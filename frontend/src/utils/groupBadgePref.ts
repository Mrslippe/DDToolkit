/**
 * 左栏「企划徽章」那一列的显示开关（2026-10-14，用户口径：「把企划图标显示开关做到设置里」，
 * 并明确**默认关**）。
 *
 * ⚠️ 为什么默认关：企划图标素材**保持空缺**（用户 2026-10-14 定，`docs/TODO.md` §5 ——
 * 现成库没有、运行时抓官方头像未获许可、自绘被否）⇒ 那一列现在恒为**文字胶囊**，
 * 而池内多数还是「个人势」，默认占着每行 54px 的宽度并不划算。
 *
 * ## 应用方式：与 `emojiSize.ts` 同一个套路（根元素 + CSS），不往 React 里传
 *
 * `applyGroupBadge()` 把状态写到 `<html data-group-badge="on|off">`，由 CSS 决定
 * `.vtuber-emblem` 显不显示（`styles/layout.css`）。为什么不做成 prop 一路传下去：
 * 它是**纯显示开关**，组件里没有任何随它变化的状态；而做成 prop 就要穿过左右栏好几层，
 * 还得给每条用例补一个 provider —— 收益为零。
 *
 * ⚠️ 兜底值必须与后端 `PREFS["group_badge"]` 的默认一致（跨语言契约，`tests/test_runtime_settings.py`
 * 有一条专门钉这个）：读不到后端时前端按这里的值走，两边一漂，症状是"设置里显示开、界面却关"。
 */
import { useEffect } from 'react'

import { api } from '../api/api'

/** 默认值：**关**（与后端 `PREFS["group_badge"]` 的第一项一致） */
export const GROUP_BADGE_DEFAULT = 'off'

/** 根元素属性名（CSS 与探针都认它 —— 单一事实来源） */
export const GROUP_BADGE_ATTR = 'data-group-badge'

/** 模块级现值（`emojiSize.ts` 同款：一个开关而已，不需要 React 状态） */
let current: 'on' | 'off' = GROUP_BADGE_DEFAULT

/** 归一化：只有 `'on'` 算开，其余（含 `undefined`/乱值/空串）一律当关 */
function norm(v: unknown): 'on' | 'off' {
  return String(v ?? '').trim() === 'on' ? 'on' : 'off'
}

/** 现在显示不显示（读模块级现值；供组件与用例查询） */
export function groupBadgeVisible(): boolean {
  return current === 'on'
}

/** 应用一次：写根元素属性（界面改动即时生效） */
export function applyGroupBadge(v: unknown): boolean {
  current = norm(v)
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute(GROUP_BADGE_ATTR, current)
  }
  return groupBadgeVisible()
}

/**
 * 清回默认 —— **只给用例用**（与 `resetEmojiBigSize()` 同一路数）。
 *
 * ⚠️ 必须导出：`current` 是**模块级**的，一个测试文件里多条用例共用同一个模块实例 ——
 * 不重置就会"上一条把开关打开，下一条测默认态时看到的是开"。
 */
export function resetGroupBadge(): void {
  applyGroupBadge(GROUP_BADGE_DEFAULT)
}

/**
 * 启动时把偏好读进来并应用一次（挂在 `App` 上，与 `useEmojiBigSize` 并排）。
 *
 * ⚠️ 读失败**不重试也不报错**：CSS 的兜底是"关"（属性没挂上时 `.vtuber-emblem` 照常显示 ——
 * 见 `layout.css` 那条规则只对 `off` 生效），重试留给下次启动。
 * ⚠️ 设置页改完会**直接**调 `applyGroupBadge`（乐观生效），不依赖这条再跑一遍。
 */
export function useGroupBadge(): void {
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await api.getPrefs()
        if (alive) applyGroupBadge(r.values.group_badge)
      } catch {
        /* 后端不可达：保持模块里的默认值（关） */
      }
    })()
    return () => { alive = false }
  }, [])
}
