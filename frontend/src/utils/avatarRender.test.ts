/**
 * 头像**渲染路必须只有一条**（R46，devlog/249）。
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

/** 逐行扫 `src/`（跳过测试文件与注释行），返回 `{文件:行号, 行}`。 */
function scanSource(needle: (line: string) => boolean): string[] {
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.tsx?$/.test(e.name) || e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx')) continue
      readFileSync(p, 'utf-8').split('\n').forEach((line, i) => {
        const t = line.trim()
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return
        if (needle(line)) hits.push(`${path.relative(SRC, p).replace(/\\/g, '/')}:${i + 1}`)
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
