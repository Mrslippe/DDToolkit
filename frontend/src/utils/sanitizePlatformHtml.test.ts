// @vitest-environment jsdom
/**
 * 平台 HTML 的白名单净化（S2，devlog/206）。
 *
 * ## 这个判据防的是什么（⚠️ 别把"防 XSS"当唯一卖点）
 *
 * `tauri.conf.json` 的 CSP 已经是 `script-src 'self'`（**没有** `unsafe-inline`/`unsafe-eval`）
 * ⇒ 真机上注入的 `<script>` / `onerror=` / `javascript:` **本来就被 CSP 挡**。
 * 本批真实要挡的是另外两层：
 *
 * 1. **样式注入导致的 UI 伪装 / 点击劫持**（`style-src` 含 `'unsafe-inline'` ⇒ 注入的
 *    `<style>` 与 `style=` **会生效**）：把「删除账号」这类危险操作伪装成显眼的下一步；
 *    ⚠️ 而且**我们的 Tailwind 工具类是全局的** ⇒ 一条 `class="fixed inset-0 z-50"` 就能
 *    盖住界面 ⇒ **`class` 必须一起剥掉**（这一条 CSP 永远管不了）。
 * 2. **开发态浏览器**（`npm run dev` 走 Vite，CSP 是否生效未在真机核实）与
 *    **将来任何一次放宽 CSP** —— 那时净化就从纵深防御变成唯一防线。
 *
 * ## 反向验证（**两条**，缺一条都说明判据没牙）
 *
 * | 改法 | 必须红的是 |
 * |---|---|
 * | 把净化函数放宽（例如放行 `style`/`class`、或不做 URI 白名单） | 下面 `MALICIOUS` 的 payload 用例 |
 * | 把调用点改回 `dangerouslySetInnerHTML={{ __html: body.content }}` | `只有一处注入点且必须过净化` |
 *
 * ⚠️ 不要用"换个 payload"当反向验证 —— 那只说明 payload 挑得好，不说明净化接上了。
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ALLOWED_ATTR, ALLOWED_TAGS, sanitizePlatformHtml } from './sanitizePlatformHtml'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
/** 真实专栏 HTML：`tests/fixtures/bili_article_*.html`（生成脚本与来源写在文件头注释里） */
const FIXTURES = path.join(REPO, 'tests', 'fixtures')

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
}

function all(root: Document, selector: string): Element[] {
  return Array.from(root.querySelectorAll(selector))
}

/** 净化后不该存在的元素（`script`/`style` 是 CSP 那一层，其余是净化这一层） */
const FORBIDDEN_TAGS = ['script', 'style', 'iframe', 'form', 'input', 'object',
  'embed', 'svg', 'link', 'meta', 'base', 'audio', 'video', 'canvas']

// ── 恶意 payload 矩阵 ───────────────────────────────────────────────────────

const MALICIOUS: Array<[string, string]> = [
  ['script 标签', '<p>文</p><script>alert(1)</script>'],
  ['事件属性', '<img src="https://i0.hdslb.com/a.png" onerror="alert(1)">'],
  ['事件属性（大小写 + 空格变体）', '<IMG SRC="https://i0.hdslb.com/a.png" OnErRoR = "alert(1)">'],
  ['javascript: 链接', '<a href="javascript:alert(1)">文</a>'],
  ['JaVaScRiPt:（大小写）', '<a href="JaVaScRiPt:alert(1)">文</a>'],
  ['data:text/html 链接', '<a href="data:text/html,<script>alert(1)</script>">文</a>'],
  ['data: 图片', '<img src="data:image/svg+xml,<svg onload=alert(1)>">'],
  ['SVG + onload', '<svg onload="alert(1)"><circle r="10"/></svg>'],
  ['iframe', '<iframe src="https://evil.example"></iframe>'],
  ['form + input', '<form action="https://evil.example"><input name="a"></form>'],
  ['object / embed', '<object data="https://evil.example"></object><embed src="x">'],
  ['内联 style（UI 伪装）', '<p style="position:fixed;inset:0;z-index:9999">文</p>'],
  ['class 劫持（我们的 Tailwind 类是全局的）', '<div class="fixed inset-0 z-50">文</div>'],
  ['<style> 块', '<style>body{display:none}</style><p>文</p>'],
  ['畸形嵌套', '<p><b>文</p></b><script>alert(1)</script>'],
  ['未闭合标签 + 注释外逃', '<!--<img src=x onerror=alert(1)>--><p>文'],
]

describe('恶意 payload：净化后不该留下任何可执行/可伪装的东西', () => {
  for (const [name, payload] of MALICIOUS) {
    it(name, () => {
      const out = sanitizePlatformHtml(payload)
      const doc = parse(out)

      for (const tag of FORBIDDEN_TAGS) {
        expect(all(doc, tag), `${name}：<${tag}> 应当被剥掉（输出：${out}）`).toHaveLength(0)
      }
      // 任何 on* 属性
      const withEvents = Array.from(doc.querySelectorAll('*'))
        .filter((el) => Array.from(el.attributes).some((a) => a.name.toLowerCase().startsWith('on')))
        .map((el) => el.outerHTML)
      expect(withEvents, `${name}：残留了事件属性`).toHaveLength(0)
      // 内联 style 与 class（UI 伪装的两条路）
      expect(all(doc, '[style]').map((e) => e.outerHTML), `${name}：残留内联 style`).toHaveLength(0)
      expect(all(doc, '[class]').map((e) => e.outerHTML), `${name}：残留 class`).toHaveLength(0)
      // 只允许 http(s) 与协议相对（`//host/...`）
      for (const el of Array.from(doc.querySelectorAll('[href],[src]'))) {
        for (const attr of ['href', 'src'] as const) {
          const v = el.getAttribute(attr)
          if (v === null) continue
          expect(v, `${name}：${attr} 不是 http(s)/协议相对（${v}）`)
            .toMatch(/^(?:https?:)?\/\//i)
        }
      }
    })
  }

  it('script 的内容不残留在文本里（不是只剥标签）', () => {
    const out = sanitizePlatformHtml('<p>文</p><script>alert("boom")</script>')
    expect(out).not.toContain('boom')
    expect(out).not.toContain('alert')
  })

  it('合法文本不被误伤', () => {
    const out = sanitizePlatformHtml('<p>这是一段正常的正文</p>')
    expect(out).toContain('这是一段正常的正文')
  })
})

// ── 策略本身（防止"顺手放宽"） ──────────────────────────────────────────────

describe('白名单策略', () => {
  it('禁用标签与危险属性不在白名单里', () => {
    for (const t of FORBIDDEN_TAGS) expect(ALLOWED_TAGS).not.toContain(t)
    for (const a of ['style', 'class', 'id', 'srcset', 'contenteditable', 'formaction']) {
      expect(ALLOWED_ATTR).not.toContain(a)
    }
    expect(ALLOWED_ATTR.some((a) => a.toLowerCase().startsWith('on'))).toBe(false)
    expect(ALLOWED_ATTR.some((a) => a.startsWith('data-'))).toBe(false)
  })

  it('放行的是"平台正文真的会用到的"那些标签', () => {
    for (const t of ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote',
      'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'h1', 'h2', 'h3',
      'figure', 'figcaption', 'img', 'a', 'span', 'div']) {
      expect(ALLOWED_TAGS, `少了 ${t} 会过度损坏真实排版`).toContain(t)
    }
  })

  it('链接强制 rel/target（与仓里另外三处外链同款）', () => {
    const out = sanitizePlatformHtml('<a href="https://www.bilibili.com/read/cv1">文</a>')
    const a = parse(out).querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://www.bilibili.com/read/cv1')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(a.getAttribute('target')).toBe('_blank')
  })
})

// ── 真实数据：排版不许被"净化"掉（ARCHITECTURE §6 第 22 条） ─────────────────

const REAL_FIXTURES = readdirSync(FIXTURES).filter((f) => f.startsWith('bili_article_'))

describe('真实专栏 HTML（不是手写样本）', () => {
  it('fixture 至少有一份 —— 否则这组判据等于没跑', () => {
    expect(REAL_FIXTURES.length, `${FIXTURES} 下没有 bili_article_*.html`).toBeGreaterThan(0)
  })

  for (const file of REAL_FIXTURES) {
    it(`${file}：结构逐项活下来`, () => {
      const raw = readFileSync(path.join(FIXTURES, file), 'utf-8')
      const before = parse(raw)
      const after = parse(sanitizePlatformHtml(raw))

      // 平台正文最要紧的几种结构，一个都不能少（数一遍而不是"看起来还在"）
      for (const tag of ['p', 'img', 'figure', 'br', 'strong']) {
        const b = all(before, tag).length
        if (b === 0) continue
        expect(all(after, tag).length, `${file}：<${tag}> 从 ${b} 个变成 ${
          all(after, tag).length} 个`).toBe(b)
      }
      // 图片必须还带得上 src（协议相对 `//i0.hdslb.com/...` 是平台真实形态）
      for (const img of all(after, 'img')) {
        expect(img.getAttribute('src'), `${file}：图片丢了 src`).toMatch(/^(?:https?:)?\/\//i)
      }
      // 文本不许被吃掉（正文换行/空白实体会让 textContent 略有差异，只比"量级"）
      const lenBefore = before.body.textContent?.length ?? 0
      const lenAfter = after.body.textContent?.length ?? 0
      expect(lenAfter, `${file}：文本被吃掉太多`).toBeGreaterThan(lenBefore * 0.95)
    })

    it(`${file}：净化是幂等的（再跑一次不变）`, () => {
      const raw = readFileSync(path.join(FIXTURES, file), 'utf-8')
      const once = sanitizePlatformHtml(raw)
      expect(sanitizePlatformHtml(once)).toBe(once)
    })
  }
})

// ── 接线：全仓只有一处注入点，且必须过净化 ───────────────────────────────────

describe('注入点只有一个，且必须消费净化结果', () => {
  it('`dangerouslySetInnerHTML` 只出现在 PostDetailDrawer，且实参是 sanitizePlatformHtml(...)', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!/\.tsx?$/.test(e.name)) continue
        const text = readFileSync(p, 'utf-8')
        text.split('\n').forEach((line, i) => {
          const trimmed = line.trim()
          // ⚠️ **跳过注释行**：本仓已三次踩到"判据的举例文字命中判据自己"
          //    （这一版第一跑就把三处文档注释当成了违规点）。
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
          if (!line.includes('dangerouslySetInnerHTML')) return
          const near = text.split('\n').slice(i, i + 3).join('\n')
          if (!near.includes('sanitizePlatformHtml(')) {
            offenders.push(`${path.relative(REPO, p)}:${i + 1}: ${line.trim()}`)
          }
        })
      }
    }
    walk(path.join(REPO, 'frontend', 'src'))
    expect(offenders, '平台 HTML 进 DOM 必须过 sanitizePlatformHtml').toEqual([])
  })
})
