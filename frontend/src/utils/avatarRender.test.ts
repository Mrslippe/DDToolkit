/**
 * 头像**渲染路必须只有一条**（R46，devlog/249）；2026-10-14 扩到**全站远程图**。
 *
 * ## 为什么要这条结构判据
 *
 * 2026-09-13（devlog/135，R33）修的是「**取哪张**头像」：左栏自己拼了一条
 * `bili.avatar_path ?? bili.avatar_url`，于是档案设置里换过头像后卡片变了、左栏没变。
 * 当时把取值链抽成了 `resolveAvatar` —— **但"怎么渲染"没抽**：
 * 右栏 hero 换成了 `ProxyImage`（直连 → `/img-proxy` → 占位），左栏还是 radix `Avatar` 的裸 `<img>`。
 * 两者对**同一个微博头像 URL**的命运不同（代理拿得到 / 直连被防盗链 403），
 * 于是 2026-09-28 用户看到「右栏变了、左栏变灰底首字」（R46）。
 *
 * 教训是**同一类错可以复发第二次**：上次漂的是"取值"，这次漂的是"渲染"。
 * 所以除了抽纯函数（`utils/imageHost.ts`，单测钉住口径），还要有一条**结构判据**
 * 钉住"不许有第二个渲染器 / 第二条代理规则"—— 纯函数单测管不到"有人又写了一遍"。
 *
 * ## 2026-10-14：同一类错**真的复发了一次**（`devlog/484`）
 *
 * `devlog/482` 给正文表情图写了个**裸 `<img>`** —— 当时那条判据只盯头像（`<AvatarImage`），
 * 拦不住"另一种裸 `<img>`"。症状：用户报「表情全是破图，还弹了错误报告」
 * （图床 `i0.hdslb.com` 对应用自身来源一律 403；`ProxyImage` 的 `no-referrer` 才拿得到）。
 * ⇒ 判据从"头像"扩到**全站远程图**：`<img>` 只许出现在下面那张**白名单**（都是"根本不是远程图"的地方）。
 *
 * 判据只扫源码文本（同 `openExternal.test.ts` 的先例）。给规则写说明的**注释行要跳过**：
 * 本仓已多次踩到"判据的说明文字命中判据自己"。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SIDEBAR = 'components/VtuberSidebar.tsx'
const HERO = 'components/posts/HeroCardsView.tsx'
const PROXY_IMAGE = 'components/common/ProxyImage.tsx'
const IMAGE_HOST = 'utils/imageHost.ts'
const POST_TEXT = 'components/common/PostText.tsx'

/**
 * 允许出现裸 `<img>` 的文件 —— **每一个的理由都要是"这里根本没有远程 URL"**。
 *
 * 新加一条之前先问：这张图的 URL 会不会是别人的 CDN？会 ⇒ 用 `ProxyImage`
 * （不然就是 `devlog/484` 那个 403 破图），别往这张表里塞。
 */
const BARE_IMG_ALLOWED: Record<string, string> = {
  [PROXY_IMAGE]: '唯一的图片元件**本身**（裸 `<img>` 就该只在这里出现一次）',
  'components/LoginDialog.tsx': '`qr.image` 是后端转好的 **data URL**（`weibo_auth._to_data_url`），不出网',
  [HERO]: '`heroDivider` 是构建期打包进来的 svg（`assets/icons/hero-divider.svg`）',
  [SIDEBAR]: '企划图标来自 `import.meta.glob` 扫的**本地素材**（`assets/groups/*.svg`）',
  'components/workbench/RankedTable.tsx':
    '名单头像走**本地代理** `/fan/avatar/<uid>`（resolveAsset 拼绝对地址、后端落盘缓存），不是远程图；'
    + '这里还需要自定义「失败 → 首字」的兜底，ProxyImage 的 onError 语义不适用',
}

/**
 * 逐行扫 `src/`（跳过测试文件与**注释**），返回 `{文件:行号}`。
 *
 * ⚠️ 注释要**真的剥掉**，不只是"行首像注释就跳过"：本仓的说明大量写在 JSX 注释
 * （`{/* … *\/}`，行首是 `{` 而不是 `/*`）与多行块注释里，而这些说明**正是**在讲
 * "不许写裸 `<img>`" —— 不剥干净就会把解释规则的文字判成违规（2026-10-14 实测：
 * 5 个命中里 4 个是散文）。所以这里做的是"去掉块注释片段后看剩下的代码"。
 */
function scanSource(needle: (line: string) => boolean): string[] {
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.tsx?$/.test(e.name) || e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx')) continue
      let inBlock = false
      readFileSync(p, 'utf-8').split('\n').forEach((line, i) => {
        let code = line
        if (inBlock) {                                   // 块注释里：只看本行有没有收尾
          const end = code.indexOf('*/')
          if (end === -1) return
          inBlock = false
          code = code.slice(end + 2)
        }
        code = code.replace(/\/\*[\s\S]*?\*\//g, '')      // 本行内成对的块注释（含 `{/* … */}`）
        const open = code.indexOf('/*')
        if (open !== -1) { inBlock = true; code = code.slice(0, open) }
        const t = code.trim()
        if (!t || t.startsWith('*') || t.startsWith('//')) return
        if (needle(code)) hits.push(`${path.relative(SRC, p).replace(/\\/g, '/')}:${i + 1}`)
      })
    }
  }
  walk(SRC)
  return hits
}

const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf-8')

describe('头像渲染路唯一（R46）', () => {
  it('左右栏都走同一个图片元件 ProxyImage', () => {
    for (const [rel, what] of [[SIDEBAR, '左栏'], [HERO, '右栏 hero']] as const) {
      const text = read(rel)
      expect(text, `${what} 必须 import ProxyImage`).toMatch(
        /import\s+ProxyImage\s+from\s+'[^']*common\/ProxyImage'/)
      expect(text, `${what} 必须真的渲染 <ProxyImage`).toContain('<ProxyImage')
    }
  })

  it('左右栏都走同一条取值链 resolveAvatar（devlog/135 那半条不许回退）', () => {
    // 左栏自己调 `resolveAvatar`；hero 的值由页面解析后**当 prop 传下去**
    // （`HeroCardsView.avatarSrc`）⇒ 取值侧的落点在这两个文件里。
    for (const rel of [SIDEBAR, 'pages/PostsPage.tsx']) {
      expect(read(rel), `${rel} 必须用 utils/avatarSource 的 resolveAvatar`).toContain('resolveAvatar')
    }
    expect(read(HERO), 'hero 必须消费传进来的头像值（不许自己再拼一条链）')
      .toMatch(/avatarSrc\??:\s*string/)
  })

  it('radix 头像渲染器已退役：全站不许再出现 <AvatarImage（不许有第二个渲染器）', () => {
    expect(scanSource((l) => l.includes('<AvatarImage')),
           '头像必须走 ProxyImage —— 裸 <img> 直连微博图床会被防盗链 403（R46 的根因）')
      .toEqual([])
  })

  it('代理规则只有一个落点：imgProxyUrl 只许在 imageHost 与它的定义处出现', () => {
    const hits = scanSource((l) => l.includes('imgProxyUrl(') && !l.includes('export function imgProxyUrl'))
    expect(hits.map((h) => h.split(':')[0]), '第二条"哪些主机要代理"的规则会立刻与左右栏漂开')
      .toEqual([IMAGE_HOST])
  })

  it('ProxyImage 的首帧决策来自 imageHost（组件里不许再写一遍判断）', () => {
    const text = read(PROXY_IMAGE)
    expect(text).toContain("from '../../utils/imageHost'")
    expect(text).toContain('initialImageSrc')
    // 组件里直接写主机名单 = 规则第二份（判据③④都会漏掉这种写法）
    expect(text, 'ProxyImage 自己不许再列主机名').not.toContain('sinaimg.cn')
  })
})

describe('远程图渲染路唯一（全站；R46 的"渲染"半条，2026-10-14 扩表）', () => {
  it('★ 裸 `<img>` 只许出现在白名单里（表情破图就是漏了这一条）', () => {
    // ⚠️ 正则要能盖住**跨行**的开标签（`<img` 后面直接换行、属性在下一行）——
    //    第一版写成 `/<img[\s/>]/`，于是 `ProxyImage` 自己那一处（"唯一的图片元件本身"）
    //    反而扫不到，判据看着绿、其实漏了最重要的一条。
    const hits = scanSource((l) => /<img\b/.test(l))
    const files = [...new Set(hits.map((h) => h.split(':')[0]))].sort()
    expect(files, '新写了一张远程图？请用 ProxyImage（裸 <img> 会被图床防盗链 403，'
      + `devlog/484）—— 若确实不是远程图，再往白名单里加并写清理由。命中的行：\n${hits.join('\n')}`)
      .toEqual(Object.keys(BARE_IMG_ALLOWED).sort())
  })

  it('★ 正文表情图走 ProxyImage（devlog/482 的裸 `<img>` 是 2026-10-14 那次破图的根因）', () => {
    const text = read(POST_TEXT)
    expect(text, 'PostText 必须 import ProxyImage').toMatch(
      /import\s+ProxyImage\s+from\s+'\.\/ProxyImage'/)
    expect(text, '表情图必须渲染 <ProxyImage').toContain('<ProxyImage')
    // ⚠️ 用**跳注释的扫描器**而不是 `text`：本文件的说明与 PostText 的注释里都写着 `<img`，
    //    直接对全文 `not.toMatch` 会把"解释这条规则的文字"判成违规（本仓踩过多次）。
    expect(scanSource((l) => /<img\b/.test(l)).filter((h) => h.startsWith(POST_TEXT)),
           '⚠️ 表情图不许再写回裸 <img>（图床对应用自身来源一律 403）').toEqual([])
    // 落不到图时要给 fallback：不给的话 ProxyImage 渲染 120×120 灰块，正文会被撑变形
    expect(text, '表情图必须给 fallback（chip / 原样文字）').toContain('fallback=')
    expect(text, '落不到图时 chip 的类名要对（否则 chip 长成 18×18 的方块）')
      .toContain('fallbackClassName=')
  })
})
