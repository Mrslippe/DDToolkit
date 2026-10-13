/**
 * 帖子正文里的 `[表情名]` 切分（2026-10-13，用户第 5 条）。
 *
 * ## 用户口径
 *
 * 「我希望帖子内容中的 `[xx表情包_aaa]` 可以被渲染出来」——B站动态正文（`body_json.text`）
 * 里的表情 token 现在是一串字面文字，要换成真表情图。
 *
 * ## 真机数据（2026-10-13 现数：5,056 帖 / 6,180 次 token / 501 个不同名字）
 *
 * | 形状 | 次数 | 处理 |
 * |---|---|---|
 * | `UPOWER_<uid>_<名>` | 3,207 | 表情 ⇒ 解析得出来画图、解析不出来给 chip |
 * | `<包名>_<名>` | 2,285 | 同上（`明前奶绿收藏集表情包_石化`） |
 * | `UP_<uid>_<名>` | 174 | 同上 |
 * | 无下划线（`1P` / `▓▓` / `傲娇`） | 514 | **只有解析得出来才画图** —— 否则原样留着 |
 * | `[话题]` | 214 | **必须排除**：它是微博话题标记（`#xxx[话题]#`），不是表情 |
 *
 * ## 两条规则（都是"猜错会很难看"的地方）
 *
 * 1. **带下划线的**方括号词几乎一定是表情（B站的表情名就是这个约定）⇒ 解析不出来时给
 *    **名字 chip**（"这是一枚表情，只是本机没有它"）。
 * 2. **不带下划线的**方括号词多数不是表情（`[1P]`、`[▓▓]`、`[已注销]`…）⇒ **只有真解析出来**
 *    才画图，否则**原样保留文字**。这一条是"别把正文变成一串 chip"的护栏 ——
 *    实测那 514 次无下划线 token 里绝大多数是不该动的。
 *
 * ⚠️ 为什么 chip 是"名字的后半段"而不是整个 token：`明前奶绿收藏集表情包_石化` 一枚一厘米宽的
 * 小标签里塞不下，`石化` 才是用户认得出的部分。
 */

/** 一个 token：`[` + 1–60 个非括号非空白字符 + `]`（不吃嵌套、不吃跨行的） */
const TOKEN_RE = /\[([^[\]\s]{1,60})\]/g

/** 微博话题标记：`#xxx[话题]#` —— 它不是表情（实测 214 次），必须原样留着 */
const NOT_EMOJI = new Set(['话题'])

export type EmojiSegment =
  | { kind: 'text'; text: string }
  | { kind: 'emoji'; token: string; name: string; chippable: boolean }

/**
 * 把一段正文切成"文字 / 表情 token"两种片段（纯函数，用例在 `emojiText.test.ts`）。
 *
 * `chippable` = 解析不出来时该不该给名字 chip（见文件头两条规则）。
 */
export function splitEmojiText(text: string): EmojiSegment[] {
  const out: EmojiSegment[] = []
  if (!text) return out
  let last = 0
  TOKEN_RE.lastIndex = 0
  for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
    const token = m[1]
    if (NOT_EMOJI.has(token)) continue
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    out.push({
      kind: 'emoji', token, name: token,
      // 带下划线（`包_名` / `UPOWER_uid_名`）= B站表情的命名约定 ⇒ 认不出也给 chip
      chippable: token.includes('_'),
    })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/** 这段正文里有几个"看起来是表情"的 token（>0 才值得去问后端） */
export function emojiTokens(text: string): string[] {
  const seen = new Set<string>()
  for (const seg of splitEmojiText(text)) {
    if (seg.kind === 'emoji') seen.add(seg.token)
  }
  return [...seen]
}

/** chip 上显示的字：取最后一个下划线之后那段（`明前奶绿收藏集表情包_石化` → `石化`） */
export function emojiChipLabel(token: string, max = 8): string {
  const tail = token.includes('_') ? token.slice(token.lastIndexOf('_') + 1) : token
  const s = tail || token
  return s.length <= max ? s : `${s.slice(0, max)}…`
}
