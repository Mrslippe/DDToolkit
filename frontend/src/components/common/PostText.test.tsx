// @vitest-environment jsdom
/**
 * 正文表情渲染的判据（2026-10-13，用户第 5 条）。
 *
 * 纯逻辑（切分规则）与渲染各钉一半：
 *
 * | 判据 | 坏了会怎样 |
 * |---|---|
 * | `[话题]` 不当作表情 | 微博正文里 `#xxx[话题]#` 会变成一枚莫名其妙的 chip |
 * | 带下划线 + 解析不出来 ⇒ chip | 正文里留一串 `[明前奶绿收藏集表情包_石化]` 原样方括号 |
 * | 不带下划线 + 解析不出来 ⇒ **原样文字** | `[1P]`、`[▓▓]` 被做成 chip，正文变一串胶囊 |
 * | 解析出来 ⇒ `<img>`（alt/title 带原名） | 表情不显示（或显示成空图） |
 * | 只问一次（缓存 + 去重） | 同一枚表情在正文里出现 20 次就发 20 次请求 |
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolveEmojis = vi.fn()
vi.mock('../../api/api', () => ({
  api: { resolveEmojis: (...a: unknown[]) => resolveEmojis(...a) },
}))

import PostText, { resetEmojiCache, useEmojiImages } from './PostText'
import { emojiChipLabel, emojiTokens, splitEmojiText } from '../../utils/emojiText'

const actEnv = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnv.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  // ⚠️ 表情缓存是**模块级**的：不清就会命中上一条用例留下的结果
  //    （实测症状：`resolveEmojis` 调用 0 次，看着像"没取数"）
  resetEmojiCache()
  resolveEmojis.mockReset().mockResolvedValue({
    // ⚠️ 键必须与**问的那个 token** 一致：后端 `resolve()` 是按输入 token 建结果表的
    //    （`out[tok] = url`）。第一版这里写成裸名 `贴贴`，于是 `r.items[token]` 永远取不到 ——
    //    症状是"表情解析出来了却不显示"，与"上游没有它"长得一模一样。
    items: { UPOWER_1_贴贴: 'https://cdn/tietie.png' },
    count: 1, why: null,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (text: string) => act(() => {
  root.render(<PostText text={text} />)
})
/** 等一拍：取数是"effect → 请求 → setState"三跳，只 await 一次不够（实测过） */
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

describe('切分规则（纯函数）', () => {
  it('把正文切成 文字/表情 两种片段（顺序与原文一致）', () => {
    expect(splitEmojiText('晚安[UPOWER_1_贴贴]好梦')).toEqual([
      { kind: 'text', text: '晚安' },
      { kind: 'emoji', token: 'UPOWER_1_贴贴', name: 'UPOWER_1_贴贴', chippable: true },
      { kind: 'text', text: '好梦' },
    ])
  })

  it('★ `[话题]` 不是表情（微博的 `#xxx[话题]#`）—— 必须原样留着', () => {
    expect(splitEmojiText('#秋日穿搭[话题]#')).toEqual([{ kind: 'text', text: '#秋日穿搭[话题]#' }])
    expect(emojiTokens('#秋日穿搭[话题]#')).toEqual([])
  })

  it('★ 带下划线 ⇒ 解析不出来时给 chip；不带下划线 ⇒ 原样文字', () => {
    const [a] = splitEmojiText('[明前奶绿_石化]').filter((s) => s.kind === 'emoji')
    const [b] = splitEmojiText('[1P]').filter((s) => s.kind === 'emoji')
    expect(a).toMatchObject({ chippable: true })
    expect(b).toMatchObject({ chippable: false })
  })

  it('空正文 / 没有 token ⇒ 原样一段文字（不产生空片段）', () => {
    expect(splitEmojiText('')).toEqual([])
    expect(splitEmojiText('就是一句话')).toEqual([{ kind: 'text', text: '就是一句话' }])
  })

  it('chip 上显示的是**最后一段**（长包名塞不进小胶囊）', () => {
    expect(emojiChipLabel('明前奶绿收藏集表情包_石化')).toBe('石化')
    expect(emojiChipLabel('贴贴')).toBe('贴贴')
    expect(emojiChipLabel('很长很长很长很长很长很长_名')).toBe('名')
  })

  it('token 去重（同一枚出现多次只问一次）', () => {
    expect(emojiTokens('[UPOWER_1_贴贴]x[UPOWER_1_贴贴]').sort()).toEqual(['UPOWER_1_贴贴'])
  })
})

describe('渲染', () => {
  it('★ 解析得出来 ⇒ `<img>`（alt/title 带原名，可 hover 看是哪一枚）', async () => {
    render('[UPOWER_1_贴贴]')
    await settle()
    const img = host.querySelector<HTMLImageElement>('img.post-emoji')!
    expect(img.src).toBe('https://cdn/tietie.png')
    expect(img.getAttribute('alt')).toBe('[UPOWER_1_贴贴]')
    expect(host.querySelector('.post-emoji-chip')).toBeNull()
  })

  it('★ 解析不出来 + 像表情 ⇒ 名字 chip（不是原样方括号）', async () => {
    resolveEmojis.mockResolvedValue({ items: {}, count: 0, why: null })
    render('[明前奶绿收藏集表情包_石化]')
    await settle()
    const chip = host.querySelector('.post-emoji-chip')!
    expect(chip.textContent).toBe('石化')
    expect(chip.getAttribute('title')).toBe('[明前奶绿收藏集表情包_石化]')
    expect(host.textContent).not.toContain('[明前奶绿收藏集表情包_石化]')
  })

  it('★ 解析不出来 + 不像表情（`[1P]`）⇒ **原样文字**（正文不许变成一串胶囊）', async () => {
    resolveEmojis.mockResolvedValue({ items: {}, count: 0, why: null })
    render('第[1P]')
    await settle()
    expect(host.querySelector('.post-emoji-chip')).toBeNull()
    expect(host.textContent).toContain('[1P]')
  })

  it('上游失败（接口抛错）⇒ 不炸，走 chip 兜底', async () => {
    resolveEmojis.mockRejectedValue(new Error('412'))
    render('[UPOWER_1_贴贴]')
    await settle()
    expect(host.querySelector('.post-emoji-chip')?.textContent).toBe('贴贴')
  })

  it('★ 同一枚出现多次只问一次（缓存）', async () => {
    render('[UPOWER_1_贴贴]x[UPOWER_1_贴贴]x[UPOWER_1_贴贴]')
    await settle()
    expect(resolveEmojis).toHaveBeenCalledTimes(1)
    expect(host.querySelectorAll('img.post-emoji').length).toBe(3)
  })

  it('没有表情的正文**一次都不问**（普通帖子别白发请求）', async () => {
    render('就是一句话')
    await settle()
    expect(resolveEmojis).not.toHaveBeenCalled()
  })
})

describe('useEmojiImages（hook 形状）', () => {
  function Probe({ tokens }: { tokens: string[] }) {
    const m = useEmojiImages(tokens)
    return <span data-count={m.size} />
  }

  it('返回"名字 → 地址"，未解析的不在里面', async () => {
    // 用例里直接用**问得到的那个 token**（与渲染那组同一口径）
    act(() => { root.render(<Probe tokens={['UPOWER_1_贴贴', '不存在的']} />) })
    await settle()
    expect(host.querySelector('span')!.getAttribute('data-count')).toBe('1')
  })
})
