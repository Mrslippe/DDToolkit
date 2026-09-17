import type { Post, PostBodyJson, PostStatsJson } from '../api/types'

/** UTC ISO 时间 → 本地时间显示（yyyy-MM-dd HH:mm） */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 数字 → 万/亿 缩写，**数字部分最多 4 位**（平台药丸右对齐规格）：
 *  万位带 ≥1000 万进位整数万（2345.7万 → 2346万），亿位 ≥100 亿取整；
 *  99999 → 10万 的进位无 "10.0万" 跳变 */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  if (n >= 100_000_000) {
    const y = n / 100_000_000
    return y >= 100 ? `${Math.round(y)}亿` : `${y.toFixed(2)}亿`
  }
  if (n >= 10_000) {
    const w = n / 10_000
    return w >= 1000 ? `${Math.round(w)}万` : `${Math.round(w * 10) / 10}万`
  }
  return String(n)
}

/**
 * 字节数 → 人话（「关于」页的存储占用用；二进制单位，最多一位小数）。
 *
 * 取值口径：<1KB 显示整数字节；≥100 的值不再带小数（"1180.3 MB" 这种精度没有意义，
 * 反而更难扫读）；非法输入当 0（与 `formatCount` 同样不抛错，界面不该因为一个 null 崩掉）。
 */
export function formatBytes(n: number | null | undefined): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
  if (v < 1024) return `${Math.round(v)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let x = v / 1024
  let i = 0
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i += 1
  }
  return `${x >= 100 ? Math.round(x) : x.toFixed(1)} ${units[i]}`
}

/**
 * B 站动态里那些**不是内容**的占位串：
 *   - `cv<数字>` —— 专栏 / opus 的 id（`fetcher._extract_dynamic_title` 曾把它当标题存下来）；
 *   - `[9P]` / `[12P]` —— 图片张数（DRAW 动态的"正文"其实只是张数）；
 *   - `[OP]` —— opus 正文占位（部分回包里 `desc.text` 就是这个）。
 *
 * 为什么要有一张显式的表：这些值**看着像文本**，直接展示出来就是用户截图里那条
 * 「标题 = cv409088396」的观感 —— 而真文本其实躺在 `body_json.text` 里。
 */
const PLACEHOLDER_RE = /^(?:cv\d+|\[\s*\d*\s*[Pp]\s*\]|\[\s*[Oo][Pp]\s*\])$/

/** 是否是"不是内容"的占位串（空串不算占位：空串该由调用方走缺省分支）。 */
export function isPlaceholderText(s: string | null | undefined): boolean {
  const v = (s ?? '').trim()
  return v !== '' && PLACEHOLDER_RE.test(v)
}

/** 正文的**首个非空行**（截到 max 字）；没有正文 → 空串。 */
function firstTextLine(s: string | null | undefined, max: number): string {
  const line = (s ?? '')
    .split('\n')
    .map((x) => x.trim())
    .find((x) => x !== '' && !isPlaceholderText(x))
  return line ? line.slice(0, max) : ''
}

/**
 * 帖子显示标题：`title` → **正文首行** → 摘要 → 平台帖子 ID。
 *
 * ⚠️ 2026-09-17 用户截图：弥月那条置顶动态标题显示成 `cv409088396`。根因有两层 ——
 * ① 后端把 DRAW/OPUS 动态的 `data.id` 当标题存了（已修：只有专栏才用 `cv<id>` 兜底）；
 * ② 本函数的兜底链是 `title → summary → pid`，既没过滤占位串、也没看正文。
 * 库里**已经存下的**那些 `cv…` / `[9P]` 不会因为后端修好而消失（刷新时"空值不覆盖"），
 * 所以展示侧必须自己认得出占位串 —— 这也是本条用例最该钉的地方。
 */
export function postDisplayTitle(
  post: Pick<Post, 'title' | 'summary' | 'platform_post_id' | 'body_json'>,
): string {
  const title = post.title?.trim()
  if (title && !isPlaceholderText(title)) return title
  const line = firstTextLine(parseBody(post.body_json).text, 40)
  if (line) return line
  const summary = post.summary?.trim()
  if (summary && !isPlaceholderText(summary)) return summary.slice(0, 20)
  return post.platform_post_id
}

/**
 * 帖子摘要（卡片第二行）：`summary` → 正文首行 → `null`（不渲染这一行）。
 * 同样跳过占位串 —— 卡片上出现一个孤零零的 `[9P]` 与"标题是 cv 号"是同一种毛病。
 */
export function postDisplaySummary(
  post: Pick<Post, 'summary' | 'body_json'>,
  max = 120,
): string | null {
  const summary = post.summary?.trim()
  if (summary && !isPlaceholderText(summary)) return summary
  const line = firstTextLine(parseBody(post.body_json).text, max)
  return line || null
}

/** 图床 URL 规范化：http → https（B 站 hdslb / 微博 sinaimg、wbcdn，避免混合内容拦截） */
export function normalizeImageUrl(url: string): string {
  return url.replace(/^http:\/\/([^/]*\.)?(hdslb\.com|sinaimg\.cn|wbcdn\.cn)\//, 'https://$1$2/')
}

/** 安全解析 JSON 字符串，失败返回默认值 */
export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** body_json 解析 */
export function parseBody(s: string | null | undefined): PostBodyJson {
  return parseJson<PostBodyJson>(s, {})
}

/** stats_json 解析 */
export function parseStats(s: string | null | undefined): PostStatsJson {
  return parseJson<PostStatsJson>(s, {})
}

/** 帖子类型 → 中文名 */
export const POST_TYPE_LABEL: Record<string, string> = {
  video: '视频',
  video_dynamic: '投稿',
  image: '图文',
  text: '文字',
  repost: '转发',
  article: '专栏',
  live: '直播',
  music: '音乐',
  // v0.9.6（devlog/047）：微博平台自动发帖（会员升级/签到/推广）单列 system。
  // 漏这一条会让「系统」帖在卡片与类型标签上显示原始英文 `system`
  // （`typeGroupsFor('weibo')` 的筛选组里有「系统」，但展示侧走的是本表）。
  system: '系统',
}

export function postTypeLabel(type: string): string {
  return POST_TYPE_LABEL[type] ?? type
}
