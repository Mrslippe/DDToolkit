/**
 * 左栏企划徽章（需求 6，B3，`devlog/457`）：把 `vtuber.group_name` 变成长在名字右边的标识。
 *
 * ## 口径（用户 2026-10-08 拍板）
 *
 * 「**全图标**；素材还没制作 ⇒ 先用**默认图标或文字占位**」＋ 验收「**加一个企划只需加一条
 * 数据而不是改代码**」。所以这里的规则是**数据驱动**的：
 *
 * 1. 有图标（`assets/groups/<slug>.<ext>` 存在）⇒ 画图标；
 * 2. 没有图标 ⇒ **文字胶囊**（企划名本身，超长省略、`title` 给全名）。
 *
 * 素材来了只要往 `src/assets/groups/` 里丢一个 `<slug>.svg`（或 `.png`）就行 ——
 * 不需要改这里的任何一行，也不需要改组件：`groupIcon()` 走 Vite 的
 * `import.meta.glob` 在**构建期**把目录扫成一张表。
 *
 * ## slug 规则
 *
 * 小写 + 把"非字母数字汉字"折成一个连字符 ⇒ `VirtuaReal` → `virtuareal`、
 * `NIJISANJI EN` → `nijisanji-en`、`虚研社` → `虚研社`（汉字保留：文件名本来就支持，
 * 强行转拼音只会让"素材该叫什么名"变成一道猜谜题）。
 */

/** 企划名 → 图标文件名（不含扩展名） */
export function groupSlug(name: string | null | undefined): string {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 企划名 → 胶囊里显示的短标签（超长截断；调用方仍需给 `title` 兜全名） */
export function groupLabel(name: string | null | undefined, max = 6): string {
  const n = (name || '').trim()
  if (!n) return ''
  return n.length <= max ? n : `${n.slice(0, max)}…`
}

/**
 * 图标表：`slug → url`。构建期由 Vite 扫 `src/assets/groups/`（目录为空也合法）。
 *
 * ⚠️ 用 `query: '?url'` + `import: 'default'`：这样无论素材是 svg 还是 png，
 * 拿到的都是**可直接塞进 `<img src>` 的 URL**（Vite 会按大小决定内联还是出文件）。
 */
const ICONS: Record<string, string> = (() => {
  const mods = import.meta.glob('../assets/groups/*.{svg,png,webp}', {
    eager: true, query: '?url', import: 'default',
  }) as Record<string, string>
  const out: Record<string, string> = {}
  for (const [path, url] of Object.entries(mods)) {
    const base = path.split('/').pop() || ''
    const slug = base.replace(/\.(svg|png|webp)$/i, '')
    if (slug) out[slug] = url
  }
  return out
})()

/** 这个企划有没有图标？没有就退回文字胶囊（**不要**画一个空壳）。 */
export function groupIcon(name: string | null | undefined): string | null {
  const slug = groupSlug(name)
  return slug ? ICONS[slug] ?? null : null
}

/** 测试/排查用：当前构建里认到了哪些企划图标（空对象 = 素材还没进来，一切走文字胶囊） */
export function knownGroupIcons(): Record<string, string> {
  return { ...ICONS }
}

/**
 * **没有企划时统一算作「个人势」**（用户 2026-10-13 口径：「没有企划的统一用『个人势』代替，
 * 也作为一个企划类型」）。
 *
 * 为什么是一个真实取值而不是"空"：
 * - 徽章侧：以前 `null` ⇒ **不渲染徽章**（"没企划不摆空壳"，`devlog/457`）。用户现在要的是
 *   **它是一个类型** —— 所以名单里绝大多数 V 会显示「个人势」胶囊，与「四禧丸子」那种是
 *   同一档信息（"她不属于任何企划"本身就是一条信息）。
 * - 筛选侧：它于是自然成为一枚**可筛选项**（不需要另写一条"空企划"的特殊匹配）。
 * - 素材侧：它也要一枚图标（`assets/groups/WORKLIST.md` 的最后一行，slug = `个人势`）。
 *
 * ⚠️ 口径仍然只有 `vtuberGroup()` 这一处（`devlog/458` 那条）：徽章、筛选选项、筛选匹配
 * 三处都调它 —— 别在某个调用点自己写 `|| '个人势'`。
 */
export const PERSONAL_GROUP = '个人势'

/**
 * **一个 V 的企划**（界面上唯一的口径）：手填的 `faction` 优先，否则用自动检测的 `group_name`，
 * 都没有则算 **「个人势」**（2026-10-13 起；以前返回 `null` 表示"不显示徽章"）。
 *
 * ## 为什么必须有这一个函数（2026-10-10 用户报的那个 bug）
 *
 * 左栏同一屏上有两处"企划"，各自读了不同的字段：
 * - **徽章**读 `group_name`（B3 起自动填，vdb 来的）；
 * - **筛选弹窗的选项与匹配**读 `faction`（老的手填"阵营"——语义沿革里它**就是**企划）。
 *
 * 于是真机库出现了这一幕：`faction` 只有恬豆发芽了一人有值，另外三位
 * （又一充电中 / 梨安不迷路 / 沐霂是MUMU呀）只有 `group_name='四禧丸子'`
 * ⇒ **筛「四禧丸子」只出一个人，而三人的徽章上明明写着四禧丸子**。
 *
 * 口径：**手填优先**（用户自己写的那句最权威）→ 否则用自动检测的 → 都没有则 **`个人势`**。
 * 徽章、筛选选项、筛选匹配三处**都调这一个函数**，不许再各读一个字段。
 */
export function vtuberGroup(v: {
  faction?: string | null
  group_name?: string | null
} | null | undefined): string {
  const manual = (v?.faction || '').trim()
  if (manual) return manual
  const auto = (v?.group_name || '').trim()
  return auto || PERSONAL_GROUP
}

/**
 * **字段口径**（编辑用）：手填 `faction` 优先 → 否则自动检测的 `group_name` → **都没有则空串**。
 *
 * ⚠️ 与 `vtuberGroup()` 是**两个不同的问题**，别合并：
 * - `vtuberGroup()` = "界面上她属于哪个企划" —— 恒有答案（没有就是「个人势」）；
 * - 这一个 = "这个字段现在存的是什么" —— 空串 = **未设置**。
 *
 * 为什么编辑界面必须用后者（2026-10-13 改口径时测试当场抓住）：档案设置里那个企划 Select
 * 的显示值直接取自 `vtuberGroup()` 的话，**从没设过企划的 V 会显示成「个人势（自动）」** ——
 * 于是用户分不清"我没设过"和"我设成了个人势"，而这两件事在库里是不同的值
 * （`faction=''` vs `faction='个人势'`）。
 */
export function vtuberGroupField(v: {
  faction?: string | null
  group_name?: string | null
} | null | undefined): string {
  const manual = (v?.faction || '').trim()
  if (manual) return manual
  return (v?.group_name || '').trim()
}

/** 一批 V 的全部企划（筛选弹窗的选项；去重 + 去掉空值，顺序按出现顺序） */
export function vtuberGroupOptions(
  list: { faction?: string | null; group_name?: string | null }[],
): string[] {
  const out: string[] = []
  for (const v of list) {
    const g = vtuberGroup(v)
    if (g && !out.includes(g)) out.push(g)
  }
  return out
}
