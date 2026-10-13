/**
 * 大表情尺寸（`devlog/486`）—— 一个**用户偏好**，落在后端（`prefs.post_emoji_big`），
 * 最终只体现为一个 CSS 变量：`--post-emoji-big`（`posts.css` 里 `.post-emoji--big` 读它）。
 *
 * ## 为什么要有这个文件（而不是在组件里直接写 style）
 *
 * 大表情出现在**任何**渲染正文的地方（详情页、列表卡片标题、纯文字封面、以后别处），
 * 而"用户调了多大"这件事必须**全局一致**：挂在某个组件上就会"详情页是 40px、列表是 32px"。
 * 所以 → 一个模块级函数写根元素上的 CSS 变量，谁都不用知道这个偏好在哪。
 *
 * ## 与 `playerPrefs` / `vtuberSort` 的区别（别混）
 *
 * 那两个走 **localStorage**（纯本机播放习惯）；这一个走**后端偏好** —— 与主题、关窗语义
 * 同一族：用户改的是"这个应用长什么样"，换端口/清缓存都该还在。
 * ⚠️ 但**应用方式**是同一个套路：模块级 store + 订阅，界面改动即时生效（见 `useEmojiBigSize`）。
 */
import { useEffect } from 'react'

import { api } from '../api/api'

/** 默认值（后端 `PREFS["post_emoji_big"]` 的默认必须与它一致 —— 前端兜底读不到后端时用它） */
export const EMOJI_BIG_DEFAULT = 40
/** 与后端白名单同区间（`range(24, 65, 2)`）：越界/非法一律夹回来，绝不写出去 */
export const EMOJI_BIG_MIN = 24
export const EMOJI_BIG_MAX = 64
export const EMOJI_BIG_STEP = 2

/** 当前生效的尺寸（px）。真实来源是 CSS 变量，这里只留一份"最近一次写入的值"给读数用。 */
let current = EMOJI_BIG_DEFAULT

/** 夹到合法档位；**空值/非数字一律回默认**（`null` 与 `''` 是"没设过"，不是 0） */
export function clampEmojiBig(v: unknown): number {
  // ⚠️ `Number(null) === 0`、`Number('') === 0` —— 直接 Number 会把"没设过"变成 0 再夹成 24，
  //    症状是"用户没调过，大表情却是最小档"（用例抓到的）。所以先挡掉空值。
  if (v === null || v === undefined || String(v).trim() === '') return EMOJI_BIG_DEFAULT
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return EMOJI_BIG_DEFAULT
  const stepped = Math.round((n - EMOJI_BIG_MIN) / EMOJI_BIG_STEP) * EMOJI_BIG_STEP + EMOJI_BIG_MIN
  return Math.min(EMOJI_BIG_MAX, Math.max(EMOJI_BIG_MIN, stepped))
}

/** 写到根元素的 CSS 变量上（**幂等**；`document` 不在时静默 —— 单测环境/SSR 安全） */
export function applyEmojiBigSize(v: unknown): number {
  const px = clampEmojiBig(v)
  current = px
  const root = globalThis.document?.documentElement
  root?.style.setProperty('--post-emoji-big', `${px}px`)
  return px
}

/** 最近一次写入的尺寸（给设置页的读数；真值仍在 CSS 变量上） */
export function emojiBigSize(): number {
  return current
}

/**
 * 清回默认 —— **只给用例用**（与 `PostText.resetEmojiCache()` 同一路数）。
 *
 * ⚠️ 必须导出：`current` 是**模块级**的，一个测试文件里多条用例共用同一个模块实例 ——
 * 不重置就会"上一条用例调成 48，下一条的'落库失败要退回'退到 48"（用例抓过这类）。
 */
export function resetEmojiBigSize(): void {
  applyEmojiBigSize(EMOJI_BIG_DEFAULT)
}

/**
 * 启动时把偏好读进来并应用一次（挂在 `App` 上）。
 *
 * ⚠️ 读失败**不重试也不报错**：CSS 里已经写了默认值（40px），退化成默认是安全的；
 *    重试留给下次启动（这条链上没有"用户正等着"的动作）。
 * ⚠️ 设置页改完会**直接**调 `applyEmojiBigSize`（乐观生效），不依赖这条再跑一遍。
 */
export function useEmojiBigSize(): void {
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await api.getPrefs()
        if (alive) applyEmojiBigSize(r.values.post_emoji_big)
      } catch {
        /* 后端不可达：保持 CSS 里的默认值 */
      }
    })()
    return () => { alive = false }
  }, [])
}
