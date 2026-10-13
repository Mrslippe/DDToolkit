/**
 * 正文里的表情渲染（2026-10-13，用户第 5 条）。
 *
 * ## 三件事
 *
 * 1. **切分**：`splitEmojiText()`（纯函数，规则与实测数据都在 `utils/emojiText.ts` 的文件头）；
 * 2. **按需取**：能解析的画 `<img>`（地址来自后端 `/emoji/resolve`，整表索引 + 30 分钟缓存）；
 *    解析不出来的、且形状像表情的 ⇒ **名字 chip**；不像表情的（`[1P]` 那种）⇒ 原样文字；
 * 3. **缓存**：模块级 `Map`（名字 → 地址或 `null`）+ **已问过的名字集合** ——
 *    同一枚表情在列表里出现几十次，不该问几十次；问过但上游没有的也不再问（`null`）。
 *
 * ⚠️ 用 React 节点渲染，**不是** `dangerouslySetInnerHTML`：正文是外部数据，
 * 拼 HTML 等于把转义与白名单的活重新做一遍（专栏那条路已经有一份白名单实现，
 * 见 `utils/sanitizePlatformHtml.ts`）——这里没有注入面，一行都不需要。
 */
import { useEffect, useMemo, useState } from 'react'

import { api } from '../../api/api'
import { emojiChipLabel, emojiTokens, splitEmojiText } from '../../utils/emojiText'

/** 名字 → 图片地址；`null` = **问过了，上游没有这个表情**（别再问） */
const cache = new Map<string, string | null>()
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
          for (const n of slice) cache.set(n, r.items[n] ?? null)
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
 * 给一段正文里的表情名批量取地址。返回"名字 → 地址"（还没回来的不在里面）。
 *
 * ⚠️ 依赖用 `tokens.join()` 而不是数组本身：数组每次渲染都是新引用（父组件重渲染一次
 * 就重新取数，本仓在别的 hook 上踩过同一类坑）。
 */
export function useEmojiImages(tokens: string[]): Map<string, string> {
  const key = tokens.join(',')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!key) return
    let alive = true
    void fetchNames(key.split(',')).then(() => { if (alive) setTick((t) => t + 1) })
    return () => { alive = false }
  }, [key])

  return useMemo(() => {
    const out = new Map<string, string>()
    for (const n of tokens) {
      const url = cache.get(n)
      if (url) out.set(n, url)
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
        const url = images.get(seg.token)
        if (url) {
          return (
            <img
              key={i} className="post-emoji" src={url} alt={`[${seg.token}]`}
              title={`[${seg.token}]`} loading="lazy" draggable={false}
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
