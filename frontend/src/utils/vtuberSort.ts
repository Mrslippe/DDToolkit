/**
 * 左栏排序（需求 5，2026-10-07，`devlog/414`）：**六档** + 偏好持久化。
 *
 * ## 为什么单独一个模块
 *
 * 侧栏原来把排序写死在 `useMemo` 里（两档、且 `sortKey` 恒为 `'default'` —— 那是
 * "排序按钮从工具栏撤走、等并入筛选浮窗"期间的临时态）。需求 5 要求六档可选，
 * 于是把**比较逻辑提成纯函数**：能单测、能反向验证，也不让侧栏那个组件继续长。
 *
 * ## 六档的口径（用户 2026-10-07 拍板）
 *
 * | 档 | 口径 | 备注 |
 * |---|---|---|
 * | `custom` | **后端给的顺序原样**（`vtubers.sort_order`，见 O1 的 `PUT /vtuber-order`） | 拖拽出来的顺序；筛选后也照它 |
 * | `default` | 导入顺序 = `id` 升序 | ⚠️ **不是** `sort_order` —— 有"自定义"就必须留一条**回得去**的路 |
 * | `name` | 名称 A-Z，**中文按拼音** | `Intl.Collator('zh-Hans-CN')`，不引库 |
 * | `followers` | 粉丝数降序（取**B 站账号**，与侧栏既有口径一致） | 没有 B 站账号的排最后 |
 * | `updated` | `updated_at` 降序（新的在前） | 没有时间的排最后 |
 * | `live` | 开播中优先 | 同为开播中再按粉丝数，再按 id |
 *
 * ⚠️ 所有档最后都以 **`id` 兜底**：排序键打平时不能让列表顺序随 `Array.sort` 的实现摇摆
 * （`devlog/378` 那类"键打平就换位"的坑）。
 * ⚠️ **每一档都返回新数组**，不改调用方那个（`Array.sort` 原地排 —— 直接排 `vtubers` 状态
 * 会把 React state 改掉，表现是"切一次筛选顺序就永久变了"）。
 */
import type { VTuber } from '../api/types'

export const VTUBER_SORT_KEYS = ['custom', 'default', 'name', 'followers', 'updated', 'live'] as const
export type VtuberSortKey = (typeof VTUBER_SORT_KEYS)[number]

export const VTUBER_SORT_LABEL: Record<VtuberSortKey, string> = {
  custom: '自定义',
  default: '默认（导入顺序）',
  name: '名称 A-Z',
  followers: '粉丝数',
  updated: '最近更新',
  live: '开播中优先',
}

/** 名称排序的**唯一**真源（拼音）：`Intl.Collator` 自带 ICU 的中文排序，不需要 pinyin 库。 */
const NAME_COLLATOR = new Intl.Collator('zh-Hans-CN')

/** 侧栏一直用 B 站账号的粉丝数/直播态（多平台时那是"主账号"口径）。 */
function bili(v: VTuber) {
  return v.accounts.find((a) => a.platform === 'bilibili')
}

/** 粉丝数：没有 B 站账号 ⇒ -1（排最后，而不是当成 0 —— 0 会混进"真的 0 粉"里）。 */
function followers(v: VTuber): number {
  return bili(v)?.followers_count ?? -1
}

function liveRank(v: VTuber): number {
  return (bili(v)?.live_status ?? 0) === 1 ? 1 : 0
}

function updatedAt(v: VTuber): number {
  const t = v.updated_at ? Date.parse(v.updated_at) : NaN
  return Number.isFinite(t) ? t : -1
}

/**
 * 每个键一个"谁在前"的判定（返回负数 = a 在前）；打平一律交给 `id` 兜底。
 *
 * ⚠️ **`custom` 不在这里**：它的语义是"**后端给的顺序原样**"，而兜底那一手 `|| a.id - b.id`
 * 会把它按 id 重排 —— 那就不是"自定义"了。这一档在 `sortVtubers` 里**提前返回**。
 */
const COMPARE: Record<Exclude<VtuberSortKey, 'custom'>, (a: VTuber, b: VTuber) => number> = {
  default: (a, b) => a.id - b.id,
  name: (a, b) => NAME_COLLATOR.compare(a.name, b.name),
  followers: (a, b) => followers(b) - followers(a),
  updated: (a, b) => updatedAt(b) - updatedAt(a),
  live: (a, b) => (liveRank(b) - liveRank(a)) || (followers(b) - followers(a)),
}

/**
 * 按 `key` 排一份列表（**返回新数组**）。
 *
 * ⚠️ `custom`（以及未知键）**提前返回副本**，不走比较器 —— 它的定义就是"别动它"。
 * 未知键退回 `custom` 而不抛：偏好里存了个老版本才认识的值时，用户要的是"还能用"，不是白屏。
 */
export function sortVtubers(list: VTuber[], key: VtuberSortKey): VTuber[] {
  const cmp = COMPARE[key as Exclude<VtuberSortKey, 'custom'>]
  if (!cmp) return [...list]
  return [...list].sort((a, b) => cmp(a, b) || a.id - b.id)
}

/** 排序偏好的存档键（与 `playerPrefs` 同套路：**localStorage**，不动后端）。 */
export const VTUBER_SORT_KEY = 'ddtoolkit.vtuber.sort'

/** 读偏好；没存过/坏值/存储被禁 ⇒ `custom`（拖出来的顺序就是用户最近一次的表达）。 */
export function loadVtuberSortKey(): VtuberSortKey {
  try {
    const raw = localStorage.getItem(VTUBER_SORT_KEY)
    return VTUBER_SORT_KEYS.includes(raw as VtuberSortKey) ? (raw as VtuberSortKey) : 'custom'
  } catch {
    return 'custom'
  }
}

export function saveVtuberSortKey(key: VtuberSortKey): void {
  try {
    localStorage.setItem(VTUBER_SORT_KEY, key)
  } catch {
    /* 存储被禁：这一轮照常用，只是下次开应用回到默认 —— 不为此打断用户 */
  }
}
