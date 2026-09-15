/**
 * 设置窗口的**导航结构**（R17，devlog/094）—— 纯逻辑，有单测。
 *
 * 用户口径（2026-09-15）：设置窗口参照参考图做成「左侧分类 + 右侧内容」，
 * 但**不照搬参考图里的分类**（模型/插件/Agent 预设…那些我们应用里没有）。
 *
 * 所以导航是**数据驱动**的：中间那几项直接由后端 `GET /settings` 的
 * `specs[].group` 生成（顺序也照后端声明序），**外观固定第一、关于固定最后**。
 * 这条不是洁癖，是为了消掉一类漂移：后端 `runtime_settings.py` 加了新参数组
 * （例如以后加「弹幕采集」），界面必须自己多出一项 —— 而不是等人想起来去改前端清单。
 * 探针 `--app-settings` 拿导航标签与 API 的分组名逐项对账，就是钉这件事。
 */

import type { DraftVal } from './settingsDraft'

/** 特殊项 id：外观（prefs，立即生效）与关于（只读）。中间几项直接用后端的 group 名当 id。 */
export const APPEARANCE_ID = 'appearance'
export const ABOUT_ID = 'about'

/** 图标键（这里不引 React：组件侧再做 key → lucide 组件的映射） */
export type NavIcon = 'palette' | 'timer' | 'activity' | 'sparkles' | 'cloud' | 'info'

/** group 名 → 图标键。**未知分组给一个默认图标**（后端加组时界面不至于没图标） */
const GROUP_ICONS: Record<string, NavIcon> = {
  抓取节奏: 'timer',
  动态流与轮询: 'activity',
  收录首屏: 'sparkles',
  第三方数据: 'cloud',
}

export interface NavItem {
  id: string
  label: string
  icon: NavIcon
  /** 该项下的字段条数（关于 = 只读理由条数） */
  count: number
  /** 是否提供「恢复本类默认」（外观是立即生效的偏好、关于是只读 → 都没有） */
  resettable: boolean
}

/** 后端 specs 里我们只需要这两个字段（结构上兼容 `SettingSpec`） */
export interface GroupedSpec {
  key: string
  group: string
}

/**
 * 生成导航：外观 → 后端的各分组（按声明序）→ 关于。
 *
 * `appearanceCount` / `aboutCount` 由调用方给（外观 = 主题项数，关于 = 只读理由条数）——
 * 这两个数不来自 `specs`（一个是 prefs、一个是只读表），所以显式传进来，
 * 免得在函数里偷偷写死一个 1 或 10。
 */
export function buildNav(
  specs: GroupedSpec[],
  appearanceCount: number,
  aboutCount: number,
): NavItem[] {
  const items: NavItem[] = [
    { id: APPEARANCE_ID, label: '外观', icon: 'palette', count: appearanceCount,
      resettable: false },
  ]
  const seen: string[] = []
  for (const s of specs) {
    if (!seen.includes(s.group)) seen.push(s.group)
  }
  for (const g of seen) {
    items.push({
      id: g,
      label: g,
      icon: GROUP_ICONS[g] ?? 'timer',
      count: specs.filter((s) => s.group === g).length,
      resettable: true,
    })
  }
  items.push({ id: ABOUT_ID, label: '关于', icon: 'info', count: aboutCount,
               resettable: false })
  return items
}

/** 某个分组下的键（顺序照 specs 声明序） */
export function keysOfGroup(specs: GroupedSpec[], group: string): string[] {
  return specs.filter((s) => s.group === group).map((s) => s.key)
}

/**
 * 该分组是否有**未保存**改动（左栏圆点用它）。
 *
 * 判据与 `settingsDraft.dirtyKeys` 同一个口径：草稿里出现过、且与当前生效值不同。
 * `''`（输入框被清空）也算改动 —— 它会被校验拦住，但"这页动过"要如实显示出来。
 */
export function groupDirty(
  specs: (GroupedSpec & { value: number | boolean })[],
  draft: Record<string, DraftVal>,
  group: string,
): boolean {
  return specs.some((s) => s.group === group &&
    draft[s.key] !== undefined && draft[s.key] !== s.value)
}

/** 「恢复本类默认」的草稿值：把该分类的字段填成后端给的默认值（**不落库**，仍需点保存） */
export function resetDraftOfGroup(
  specs: (GroupedSpec & { default: number | boolean })[],
  group: string,
): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {}
  for (const s of specs) {
    if (s.group === group) out[s.key] = s.default
  }
  return out
}

/**
 * 后端 400 落到界面时，该把用户带到哪一页。
 *
 * 只有"能定位"的错误才切页（例如跨字段约束涉及的两个键都在同一个分组）；
 * 定位不到就返回 null —— **不要瞎猜一个页面切过去**，那只会让人更迷惑。
 */
export function categoryOfKey(specs: (GroupedSpec & { value: number | boolean })[], key: string): string | null {
  return specs.find((s) => s.key === key)?.group ?? null
}
