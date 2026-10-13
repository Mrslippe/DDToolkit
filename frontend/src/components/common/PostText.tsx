/**
 * 正文里的表情渲染（2026-10-13，用户第 5 条；2026-10-14 修图床防盗链，`devlog/484`）。
 *
 * ## 三件事
 *
 * 1. **切分**：`splitEmojiText()`（纯函数，规则与实测数据都在 `utils/emojiText.ts` 的文件头）；
 * 2. **按需取**：能解析的画图（地址来自后端 `/emoji/resolve`，两级索引，见 `devlog/483`）；
 *    解析不出来的、且形状像表情的 ⇒ **名字 chip**；不像表情的（`[1P]` 那种）⇒ 原样文字；
 * 3. **缓存**：模块级 `Map`（名字 → 地址或 `null`）+ **已问过的名字集合** ——
 *    同一枚表情在列表里出现几十次，不该问几十次；问过但两级都没有的也不再问（`null`）。
 *
 * ## ⚠️ 图**必须**走 `ProxyImage`，不许裸 `<img>`（这条是本文件唯一踩过的线上坑）
 *
 * 第一版这里写的是裸 `<img src={url}>` ⇒ 用户 2026-10-14 报「表情全是破图，还弹了错误报告」：
 * 图床 `i0.hdslb.com` 对**应用自身来源**（`http://tauri.localhost/`）一律 **403**，
 * 而 `ProxyImage` 会 https 化 + 带 `referrerPolicy="no-referrer"`（实测：不带 Referer → 200，
 * 带我们的 origin → 403）⇒ 全站其它图都好、只有表情是破图。它还会在直连失败时转
 * `/img-proxy`（后端带 bilibili Referer）、再失败才落到我们给的 `fallback`（这里给的是 chip）。
 *
 * ⚠️ 用 React 节点渲染，**不是** `dangerouslySetInnerHTML`：正文是外部数据，
 * 拼 HTML 等于把转义与白名单的活重新做一遍（专栏那条路已经有一份白名单实现，
 * 见 `utils/sanitizePlatformHtml.ts`）——这里没有注入面，一行都不需要。
 */
import { useEffect, useMemo, useState } from 'react'

import { api } from '../../api/api'
import { emojiChipLabel, emojiTokens, splitEmojiText } from '../../utils/emojiText'
import ProxyImage from './ProxyImage'

/** 一枚表情的解析结果：地址 + **B站 给的大小类别**（`1` 小 / `2` 大 / `null` 上游没说） */
export interface EmojiHit {
  url: string
  size: number | null
}

/** 名字 → 解析结果；`null` = **问过了，两级都没有这个表情**（别再问） */
const cache = new Map<string, EmojiHit | null>()
/** 在途/已问过的批次（按名字记，避免同一次渲染里重复发请求） */
const asked = new Set<string>()
/** 正在飞的请求（并发去重：同一次打开详情 + 转发卡片可能同时要同一批） */
const inflight = new Map<string, Promise<void>>()

const BATCH = 100

/**
 * 清空缓存 —— **只给用例用**（与 `utils/videoKernel` 的 `resetVideoKernel()` 同一路数）。
 *
 * ⚠️ 为什么必须导出：缓存是**模块级**的，而一个测试文件里多个用例共用同一个模块实例 ——
 * 不清的话第二条用例会命中第一条留下的缓存（实测症状：`resolveEmojis` 调用次数是 0，
 * 看着像"没取数"，其实是"取过了"）。
 */
export function resetEmojiCache(): void {
  cache.clear()
  asked.clear()
  inflight.clear()
}

/** 问一批名字（已缓存的跳过；回来的写进缓存）。失败**静默**：走 chip 兜底就是了。 */
async function fetchNames(names: string[]): Promise<void> {
  const todo = names.filter((n) => !cache.has(n) && !asked.has(n))
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH)
    const key = slice.join(',')
    let p = inflight.get(key)
    if (!p) {
      p = (async () => {
        slice.forEach((n) => asked.add(n))
        try {
          const r = await api.resolveEmojis(slice)
          for (const n of slice) {
            // ⚠️ 值必须是**有地址的对象**（2026-10-14 起 `{url, size}`）：形状不对就当"没有"，
            //    走 chip 兜底 —— 直接塞进去的话会渲染成一张**空白图**（比 chip 更难看出问题）。
            const hit = r.items[n]
            cache.set(n, hit && hit.url ? hit : null)
          }
        } catch {
          for (const n of slice) cache.set(n, null)   // 取不到就按"没有"处理（chip 兜底）
        } finally {
          inflight.delete(key)
        }
      })()
      inflight.set(key, p)
    }
    await p
  }
}

/**
 * 给一段正文里的表情名批量取地址与大小。返回"名字 → 命中"（还没回来的不在里面）。
 *
 * ⚠️ 依赖用 `tokens.join()` 而不是数组本身：数组每次渲染都是新引用（父组件重渲染一次
 * 就重新取数，本仓在别的 hook 上踩过同一类坑）。
 */
export function useEmojiImages(tokens: string[]): Map<string, EmojiHit> {
  const key = tokens.join(',')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!key) return
    let alive = true
    void fetchNames(key.split(',')).then(() => { if (alive) setTick((t) => t + 1) })
    return () => { alive = false }
  }, [key])

  return useMemo(() => {
    const out = new Map<string, EmojiHit>()
    for (const n of tokens) {
      const hit = cache.get(n)
      if (hit) out.set(n, hit)
    }
    return out
    // `tick` 只是"缓存变了，请重算"的信号；真正的输入是 tokens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])
}

interface Props {
  text: string
  /** 附加类（正文与转发原文的行高/颜色不同） */
  className?: string
}

/** 一段帖子正文：文字原样、表情画图/给 chip（见文件头三条规则）。 */
export default function PostText({ text, className }: Props) {
  const segs = useMemo(() => splitEmojiText(text), [text])
  const tokens = useMemo(() => emojiTokens(text), [text])
  const images = useEmojiImages(tokens)

  return (
    <p className={`post-text whitespace-pre-wrap text-sm${className ? ` ${className}` : ''}`}>
      {segs.map((seg, i) => {
        if (seg.kind === 'text') return <span key={i}>{seg.text}</span>
        const hit = images.get(seg.token)
        if (hit) {
          // ⚠️ 走 ProxyImage（https 化 + no-referrer + /img-proxy 兜底），不许裸 `<img>`：
          //    裸 `<img>` 带的是应用自身来源，图床 `i0.hdslb.com` 一律 403（用户 2026-10-14 报的破图）。
          //    四级都失败时**落到 chip / 原样文字**（与"两级都没解析出来"同一个样子）——
          //    不给 `fallback` 的话 ProxyImage 会渲染 120×120 的灰块，正文会被撑变形。
          //
          // ⚠️ **两类大小按 B站 自己的 `size` 字段**（2026-10-14，`devlog/485`）：
          //    `2` = 大表情/贴纸（`.post-emoji--big`，明显大于文字；实测占本机 93% 的出现次数）；
          //    `1`/`null` = 小表情（与文字同大小）。判别**不能**按"官方还是自定义"——
          //    `[明前奶绿_灰头土脸]` 走官方 `/bfs/emote/` 路径但 `size=2`。
          return (
            <ProxyImage
              key={i}
              src={hit.url}
              className={hit.size === 2 ? 'post-emoji post-emoji--big' : 'post-emoji'}
              alt={`[${seg.token}]`}
              title={`[${seg.token}]`}
              draggable={false}
              fallback={seg.chippable ? emojiChipLabel(seg.token) : `[${seg.token}]`}
              fallbackClassName={seg.chippable ? 'post-emoji-chip' : ''}
            />
          )
        }
        // 解析不出来：形状像表情 ⇒ 名字 chip；不像（`[1P]` 之类）⇒ 原样留着
        return seg.chippable
          ? (
            <span key={i} className="post-emoji-chip" title={`[${seg.token}]`}>
              {emojiChipLabel(seg.token)}
            </span>
          )
          : <span key={i}>{`[${seg.token}]`}</span>
      })}
    </p>
  )
}
