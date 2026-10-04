import { describe, expect, it } from 'vitest'

import {
  PLATFORM_LABEL,
  TYPE_GROUPS_BILIBILI,
  TYPE_GROUPS_WEIBO,
  accountHomeUrl,
  chunkBy,
  orderAccounts,
  typeGroupsFor,
} from './postTypes'

/**
 * 帖子类型分组（P2 分层收敛 A 批次从 `PostsPage.tsx` 搬出）。
 * 锁的是**平台化分类契约**（P9-2 / v0.9.6，devlog/047）：
 * B 站与微博的分类规则**故意不同**，且 chip 的 `key` 必须等于后端 `type` 参数
 * 支持的逗号分隔写法 —— key 写错会导致筛选发出无效 type、列表空掉。
 */

describe('typeGroupsFor — 按平台取分组', () => {
  it('微博走微博一套', () => {
    expect(typeGroupsFor('weibo')).toBe(TYPE_GROUPS_WEIBO)
  })

  it('B 站与未知/未选平台都走 B 站一套（B 站是主平台）', () => {
    expect(typeGroupsFor('bilibili')).toBe(TYPE_GROUPS_BILIBILI)
    expect(typeGroupsFor(undefined)).toBe(TYPE_GROUPS_BILIBILI)
    expect(typeGroupsFor('youtube')).toBe(TYPE_GROUPS_BILIBILI)
  })
})

describe('B 站分组 — 含专栏/音乐，不含系统', () => {
  const labels = TYPE_GROUPS_BILIBILI.map((g) => g.label)
  const allTypes = TYPE_GROUPS_BILIBILI.flatMap((g) => g.types)

  it('分组与顺序固定（顺序即 chips 展示顺序）', () => {
    expect(labels).toEqual(['投稿', '图文', '转发', '专栏', '音乐', '直播'])
  })

  it('投稿组是 video + video_dynamic 两型合并（P9-3 合并后的既有形态）', () => {
    const g = TYPE_GROUPS_BILIBILI.find((x) => x.label === '投稿')
    expect(g?.types).toEqual(['video', 'video_dynamic'])
    expect(g?.key).toBe('video,video_dynamic')
  })

  it('不含微博独占的 system（B 站没有平台自动发帖）', () => {
    expect(allTypes).not.toContain('system')
  })
})

describe('微博分组 — 含系统，不含专栏/音乐', () => {
  const labels = TYPE_GROUPS_WEIBO.map((g) => g.label)
  const allTypes = TYPE_GROUPS_WEIBO.flatMap((g) => g.types)

  it('分组与顺序固定', () => {
    expect(labels).toEqual(['图文', '视频', '转发', '系统'])
  })

  it('system 单列一组（平台自动发帖：会员升级/签到/推广）', () => {
    const g = TYPE_GROUPS_WEIBO.find((x) => x.label === '系统')
    expect(g?.types).toEqual(['system'])
    expect(g?.key).toBe('system')
  })

  it('不含 B 站独占的 article / music', () => {
    expect(allTypes).not.toContain('article')
    expect(allTypes).not.toContain('music')
  })

  it('微博的 video 是单型组（不像 B 站与投稿动态合并）', () => {
    const g = TYPE_GROUPS_WEIBO.find((x) => x.label === '视频')
    expect(g?.types).toEqual(['video'])
  })
})

describe('分组 key 契约 — 必须等于后端 type 参数的逗号分隔写法', () => {
  it('每个 key 都是其 types 的逗号拼接', () => {
    for (const g of [...TYPE_GROUPS_BILIBILI, ...TYPE_GROUPS_WEIBO]) {
      expect(g.key, `分组「${g.label}」的 key 与 types 不一致`).toBe(g.types.join(','))
    }
  })

  it('同平台内类型不重复（重复会让计数被算两次）', () => {
    for (const groups of [TYPE_GROUPS_BILIBILI, TYPE_GROUPS_WEIBO]) {
      const all = groups.flatMap((g) => g.types)
      expect(new Set(all).size).toBe(all.length)
    }
  })

  it('同平台内 label 与 key 都不重复（chips 以 label 展示、以 key 去重）', () => {
    for (const groups of [TYPE_GROUPS_BILIBILI, TYPE_GROUPS_WEIBO]) {
      expect(new Set(groups.map((g) => g.label)).size).toBe(groups.length)
      expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length)
    }
  })
})

describe('PLATFORM_LABEL — 平台显示名', () => {
  it('已知平台给中文名', () => {
    expect(PLATFORM_LABEL.bilibili).toBe('B站')
    expect(PLATFORM_LABEL.weibo).toBe('微博')
    expect(PLATFORM_LABEL.xiaohongshu).toBe('小红书')   // 第 4 阶段 ④，devlog/231
    expect(PLATFORM_LABEL.douyin).toBe('抖音')          // 第二刀，devlog/334
  })

  it('平台英文名：小红书是 **rednote**，不是库里的标识键', async () => {
    // 2026-10-03 用户口径：「原本用英文的地方就接着用英文」——
    // 「已订阅账号」那行此前直接打印 `a.platform`，于是界面上露出 `xiaohongshu`（截图报障）。
    const { PLATFORM_EN, platformEn } = await import('./postTypes')
    expect(platformEn('xiaohongshu')).toBe('rednote')
    expect(PLATFORM_EN.xiaohongshu).not.toBe('xiaohongshu')
    expect(platformEn('bilibili'), '本来就显示英文的照旧').toBe('bilibili')
    expect(platformEn('douyin'), '抖音的英文名就是 douyin（devlog/334）').toBe('douyin')
    // ⚠️ 未知平台的样本**别用真实平台名**：这条以前拿 douyin 当"未知"，
    //    抖音一接进来它就悄悄变成了在测已知平台（后端同款坑，见 `test_platform_branches.py`）。
    expect(platformEn('definitely-not-a-platform'), '未知平台原样回显标识键，不装懂')
      .toBe('definitely-not-a-platform')
    expect(platformEn(null)).toBe('平台')
  })

  it('界面层不许直接渲染平台标识键（全仓扫描，防"漏映射就露 xiaohongshu"）', async () => {
    // 2026-10-03：`{a.platform}` 这种写法在界面上露出库里的键（用户截图报了 xiaohongshu）。
    // 这条扫源码而不是靠人记得：要展示平台就过 `PLATFORM_LABEL` / `platformEn`。
    const { readdirSync, readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..')
    const offenders: string[] = []
    // 只认**当作文本子节点直接渲染**的 `>{a.platform}` —— 那正是用户截图里那种露法。
    // ⚠️ 不扫模板串插值：`${a.platform}` 在**拼身份键 / 拼 URL** 时是正常用法
    //   （如 `accountKeyOf` 的 `${a.platform}:${a.platform_uid}`），一律拦会天天假红。
    const raw = /(>\s*\{a\.platform\s*\}|\{account\.platform\s*\})/
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!/\.tsx?$/.test(e.name) || e.name.endsWith('.test.ts')) continue
        readFileSync(p, 'utf-8').split('\n').forEach((line, i) => {
          const t = line.trim()
          if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return
          if (raw.test(line) && !/PLATFORM_|platformEn\(/.test(line)) {
            offenders.push(`${path.relative(root, p)}:${i + 1}`)
          }
        })
      }
    }
    walk(root)
    expect(offenders, '平台标识键必须过映射（PLATFORM_LABEL / platformEn）').toEqual([])
  })

  it('收录的平台与后端注册表一致（真源是 platforms/registry.py，读它而不是抄一份）', async () => {
    // ⚠️ 这条以前写死 `['bilibili','weibo']`；2026-09-27 加小红书时改成手抄的数组，
    //    2026-10-04 加抖音时又红了一次 ⇒ 现在**直接读后端注册表**（那条注释一直说真源在那边，
    //    这次真去读了）。后端加平台而前端漏了展示名 ⇒ 这条红；反之亦然。
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const registryPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname.slice(1)), '../../../app/services/platforms/registry.py')
    const source = readFileSync(registryPath, 'utf-8')
    const block = source.slice(source.indexOf('_REGISTRY'), source.indexOf('}', source.indexOf('_REGISTRY')))
    const backend = [...block.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]).sort()
    expect(backend.length).toBeGreaterThan(2)
    expect(Object.keys(PLATFORM_LABEL).sort()).toEqual(backend)
  })

  it('未知平台没有条目 —— 调用方取到 undefined（既有行为，刻意不加回退）', () => {
    expect(PLATFORM_LABEL.youtube).toBeUndefined()
  })
})

describe('accountHomeUrl — 账号主页', () => {
  it('优先用后端抓到的 url（B 站实测常为空，所以这条分支必须有）', () => {
    expect(accountHomeUrl({ url: 'https://example.com/x', platform: 'bilibili', platform_uid: '1' }))
      .toBe('https://example.com/x')
  })

  it('url 为空时按平台兜底拼', () => {
    expect(accountHomeUrl({ url: null, platform: 'bilibili', platform_uid: '12345' }))
      .toBe('https://space.bilibili.com/12345')
    expect(accountHomeUrl({ url: '', platform: 'weibo', platform_uid: '67890' }))
      .toBe('https://weibo.com/u/67890')
  })

  it('缺 uid 或未知平台 → null（调用方据此不渲染可点态）', () => {
    expect(accountHomeUrl({ url: null, platform: 'bilibili', platform_uid: '' })).toBeNull()
    expect(accountHomeUrl({ url: null, platform: 'bilibili', platform_uid: null })).toBeNull()
    expect(accountHomeUrl({ url: null, platform: 'youtube', platform_uid: 'x' })).toBeNull()
    expect(accountHomeUrl({})).toBeNull()
  })
})

describe('orderAccounts — 拖拽顺序重排（P8-B）', () => {
  const A = [{ id: 1 }, { id: 2 }, { id: 3 }]

  it('未拖拽过（order=null）→ 原样返回，保持后端 sort_order 序', () => {
    expect(orderAccounts(A, null)).toBe(A)
  })

  it('按 order 重排', () => {
    expect(orderAccounts(A, [3, 1, 2]).map((a) => a.id)).toEqual([3, 1, 2])
  })

  it('order 里已不存在的 id（账号被删）被跳过，不产生空洞', () => {
    expect(orderAccounts(A, [9, 2, 1]).map((a) => a.id)).toEqual([2, 1, 3])
  })

  it('order 未覆盖的新账号**追加到尾部**（否则新账号会凭空消失）', () => {
    const withNew = [...A, { id: 4 }]
    expect(orderAccounts(withNew, [2, 1]).map((a) => a.id)).toEqual([2, 1, 3, 4])
  })

  it('不修改入参', () => {
    const src = [{ id: 1 }, { id: 2 }]
    orderAccounts(src, [2, 1])
    expect(src.map((a) => a.id)).toEqual([1, 2])
  })
})

describe('chunkBy — 徽章集切分', () => {
  it('按 size 切分（3 枚一集）', () => {
    expect(chunkBy([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]])
  })

  it('空数组 → 空（不产生一个空集）', () => {
    expect(chunkBy([], 3)).toEqual([])
  })

  it('正好整除时不产生尾部空集', () => {
    expect(chunkBy([1, 2, 3], 3)).toEqual([[1, 2, 3]])
  })

  it('size<=0 时不炸（回退为单集）', () => {
    expect(chunkBy([1, 2], 0)).toEqual([[1, 2]])
  })
})
