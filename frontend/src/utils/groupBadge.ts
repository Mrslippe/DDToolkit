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
