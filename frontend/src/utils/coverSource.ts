/**
 * 封面的取图口径（L3，devlog/261）。
 *
 * ## 与头像**相反**的优先级（规格 §3.3，别照抄 `avatarSource.ts`）
 *
 * | | 头像 | 封面 |
 * |---|---|---|
 * | 本地那份怎么来的 | 抓取侧顺路下载（**被动**：平台给了 URL 才下） | `is_archived=0` 的帖**主动固化** |
 * | 远端可不可靠 | 微博签名约 3h 过期，但**直连通常能拿到** | 图床**常被防盗链拦**（微博尤其），且老帖的图会被删 |
 * | ⇒ 渲染优先级 | **远端优先**，本地兜底（`src`=远端，`fallbackSrc`=本地） | **本地优先**，远端兜底（`src`=本地，`fallbackSrc`=远端） |
 *
 * 为什么这个方向差这么重要：把封面也做成"远端优先"，等于每次列表首屏都先去撞一次防盗链
 * （拿不到再回落）—— 而我们**明明已经有一份本地副本**。反过来，头像的本地那份可能根本没下过
 * （平台不给文件时），所以它只能当兜底。
 *
 * ⚠️ `ProxyImage` 的回落链是 `src → 代理 → fallbackSrc → 占位`：把本地路径放 `src` 时，
 * 它**不会**先去打代理（`/static/...` 不在代理主机白名单里，`imageHost` 判定直连），
 * 所以"本地优先"确实省掉了到远端的那一次请求。
 */
import { resolveAsset } from '../api/api'

/** 只取需要的两个字段（`Post` 有几十个字段，别把整个对象拖进来） */
export interface CoverLike {
  cover_url?: string | null
  cover_local?: string | null
}

export interface CoverSources {
  /** 首选源（有本地副本时就是本地，否则远端） */
  src?: string
  /** 首选源加载失败时的兜底（本地优先时 = 远端原文） */
  fallback?: string
}

/**
 * 纯函数：帖子 → `{src, fallback}`（可单测）。
 *
 * `remote` 由调用方给（`cover_url` 或正文里的第一张图），因为"没有封面时用正文图"
 * 这条口径属于**卡片自己的展示逻辑**，不属于取图口径。
 */
export function resolveCoverSources(post: CoverLike, remote?: string | null): CoverSources {
  const local = (post.cover_local ?? '').trim()
  const far = (post.cover_url ?? '').trim() || (remote ?? '').trim()
  if (local) {
    return { src: resolveAsset(local), fallback: far || undefined }
  }
  return { src: far || undefined }
}
