import { describe, expect, it } from 'vitest'

import {
  POST_TYPE_LABEL,
  formatCount,
  formatDateTime,
  normalizeImageUrl,
  parseBody,
  parseJson,
  parseStats,
  postDisplayTitle,
  postTypeLabel,
} from './format'

// 这些断言锁的是**已定案的展示契约**（容量档位、进位边界、图床改写），
// 不是实现细节：改动它们意味着界面上数字/标题的呈现真的变了。
// 时间相关用例一律用 `Date` 的本地取值反推期望值，避免 CI 时区差异造成假失败。

describe('formatCount — 万/亿缩写，数字部分最多 4 位', () => {
  it('万以下原样输出', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(1)).toBe('1')
    expect(formatCount(9999)).toBe('9999')
  })

  it('万位：<1000 万保留 1 位小数', () => {
    expect(formatCount(10_000)).toBe('1万')
    expect(formatCount(12_345)).toBe('1.2万')
    expect(formatCount(111_111)).toBe('11.1万')
  })

  it('万位：≥1000 万进位成整数万（不出现 2345.7万）', () => {
    // 这是「数字部分最多 4 位」规格的关键分支：2345.7万 有 5 位数字
    expect(formatCount(23_457_000)).toBe('2346万')
    expect(formatCount(99_999_999)).toBe('10000万')
  })

  it('进位边界：99999 → 10万，不出现 "10.0万" 这种跳变', () => {
    expect(formatCount(99_999)).toBe('10万')
  })

  it('亿位：<100 亿保留 2 位小数，≥100 亿取整', () => {
    expect(formatCount(100_000_000)).toBe('1.00亿')
    expect(formatCount(845_300_000)).toBe('8.45亿')
    expect(formatCount(11_100_000_000)).toBe('111亿')
  })

  it('空值输出占位符而不是 NaN/undefined', () => {
    expect(formatCount(null)).toBe('-')
    expect(formatCount(undefined)).toBe('-')
  })
})

describe('postDisplayTitle — title → 摘要前 20 字 → 平台 ID', () => {
  const base = { title: null, summary: null, platform_post_id: '12345' }

  it('优先标题，并去掉首尾空白', () => {
    expect(postDisplayTitle({ ...base, title: '  标题  ' })).toBe('标题')
  })

  it('无标题时退到摘要前 20 字', () => {
    const summary = '一'.repeat(50)
    expect(postDisplayTitle({ ...base, summary })).toBe('一'.repeat(20))
  })

  it('标题与摘要都为空时退到平台帖子 ID（保证永不空标题）', () => {
    expect(postDisplayTitle({ ...base, title: '   ', summary: '' })).toBe('12345')
  })
})

describe('normalizeImageUrl — 图床 http → https', () => {
  it('改写 hdslb / sinaimg / wbcdn 的 http 前缀', () => {
    expect(normalizeImageUrl('http://i0.hdslb.com/a.jpg')).toBe('https://i0.hdslb.com/a.jpg')
    expect(normalizeImageUrl('http://wx1.sinaimg.cn/a.jpg')).toBe('https://wx1.sinaimg.cn/a.jpg')
    expect(normalizeImageUrl('http://foo.wbcdn.cn/a.jpg')).toBe('https://foo.wbcdn.cn/a.jpg')
  })

  it('其它域名与已是 https 的地址原样返回（不得误改）', () => {
    const other = 'http://example.com/a.jpg'
    expect(normalizeImageUrl(other)).toBe(other)
    const https = 'https://i0.hdslb.com/a.jpg'
    expect(normalizeImageUrl(https)).toBe(https)
  })
})

describe('parseJson / parseBody / parseStats — 容错解析', () => {
  it('空值与坏 JSON 一律回退，不抛错', () => {
    expect(parseJson(null, { a: 1 })).toEqual({ a: 1 })
    expect(parseJson('', { a: 1 })).toEqual({ a: 1 })
    expect(parseJson('{不是 json', { a: 1 })).toEqual({ a: 1 })
  })

  it('合法 JSON 正常解析', () => {
    expect(parseJson('{"a":2}', { a: 1 })).toEqual({ a: 2 })
    expect(parseBody('{"text":"hi"}')).toEqual({ text: 'hi' })
    expect(parseStats('{"view":10}')).toEqual({ view: 10 })
  })

  it('parseBody/parseStats 对坏输入返回空对象（渲染不炸）', () => {
    expect(parseBody('oops')).toEqual({})
    expect(parseStats(undefined)).toEqual({})
  })
})

describe('postTypeLabel — 平台化类型中文名', () => {
  it('已知类型映射到中文', () => {
    expect(postTypeLabel('video')).toBe('视频')
    expect(postTypeLabel('video_dynamic')).toBe('投稿')
    expect(postTypeLabel('article')).toBe('专栏')
  })

  it('回归（v0.9.6 平台化类型）：system 必须有中文名', () => {
    // 后端 devlog/047 为微博平台自动发帖单列 `type='system'`，前端
    // `typeGroupsFor('weibo')` 的筛选组里有「系统」；若本表漏了这条，
    // 卡片与类型标签会显示原始英文 `system`。
    expect(POST_TYPE_LABEL.system).toBe('系统')
    expect(postTypeLabel('system')).toBe('系统')
  })

  it('未知类型原样返回（不吞掉信息，便于发现新类型）', () => {
    expect(postTypeLabel('brand_new')).toBe('brand_new')
  })
})

describe('formatDateTime — UTC ISO → 本地 yyyy-MM-dd HH:mm', () => {
  it('空值与非法值有兜底', () => {
    expect(formatDateTime(null)).toBe('-')
    expect(formatDateTime(undefined)).toBe('-')
    expect(formatDateTime('not-a-date')).toBe('not-a-date')
  })

  it('按**本地时区**渲染（与库内 naive UTC + 输出补 +00:00 的约定配套）', () => {
    const iso = '2026-09-13T06:30:00+00:00'
    const d = new Date(iso)
    const p = (n: number) => String(n).padStart(2, '0')
    const expectLocal =
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}`
    expect(formatDateTime(iso)).toBe(expectLocal)
  })
})
