/**
 * 「优质投稿」卡片（R37-P1，devlog/141）—— 内置卡片之一，只读。
 *
 * 数据：`GET /posts/{platform}/{uid}/paginated`（**本地库**，一次一页）→ 口径在
 * `topPosts.ts`（排除墓碑 / 优先投稿 / 播放为主、点赞兜底 / 同分按时间倒序）。
 * 点击一行 → 复用页面里的帖子详情抽屉（`onOpenPost`）。
 *
 * ⚠️ 卡片自己取数（而不是让页面统一取）：档案视图的每张卡数据源不同，
 * 页面上层不该认识"卡片需要什么"。`refreshTick` 是抓取完成边沿，据此重取。
 */
import { useEffect, useMemo, useState } from 'react'
import { CirclePlay, Heart } from 'lucide-react'

import { api } from '../../../api/api'
import type { Post } from '../../../api/types'
import { formatCount, formatDateTime, postDisplayTitle } from '../../../utils/format'
import ProxyImage from '../../common/ProxyImage'
import type { CardContext } from '../cardRegistry'
import { rankTopPosts, topPostsHint } from '../topPosts'

/** 取多少条候选再排序：一页够用（50 条里挑前三），多了只是白花时间 */
const FETCH_SIZE = 50

export default function TopPostsCard({ account, onOpenPost, refreshTick }: CardContext) {
  const [posts, setPosts] = useState<Post[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

  useEffect(() => {
    if (!account) { setPosts([]); setState('ready'); return }
    let cancelled = false
    setState('loading')
    api.listPosts(account.platform, account.platform_uid, { page: 1, page_size: FETCH_SIZE })
      .then((page) => {
        if (cancelled) return
        setPosts(page.items)
        setState('ready')
      })
      .catch(() => {
        if (cancelled) return
        setPosts([])
        setState('error')
      })
    return () => { cancelled = true }
    // 依赖收窄到账号身份 + 抓取边沿：`account` 每次回填都是新对象引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.platform, account?.platform_uid, refreshTick])

  const ranked = useMemo(() => rankTopPosts(posts, 3), [posts])
  const hint = useMemo(() => topPostsHint(posts, ranked), [posts, ranked])

  if (!account) {
    return <p className="pcard-empty">这个 V 还没有账号</p>
  }
  if (state === 'loading' && !posts.length) {
    // 骨架：与"有榜单"时同尺寸（R36 的口径 —— 数据到达不该让卡片变高）
    return (
      <ul className="tp-list" data-card-body="top-posts" data-pending="1">
        {[0, 1, 2].map((i) => (
          <li className="tp-row" key={`skel-${i}`}>
            <span className="lc-skel tp-skel-cover" />
            <span className="tp-main">
              <span className="lc-skel lc-skel--text" />
            </span>
          </li>
        ))}
      </ul>
    )
  }
  if (state === 'error') {
    return <p className="pcard-empty">榜单没取到（本地库读失败）—— 切走再切回来会重试</p>
  }
  if (!ranked.length) {
    return <p className="pcard-empty">{hint}</p>
  }

  return (
    <div className="tp" data-card-body="top-posts">
      <ol className="tp-list">
        {ranked.map(({ post, score, metric }) => (
          <li className="tp-row" key={post.id}>
            <button type="button" className="tp-hit" onClick={() => onOpenPost(post)}>
              <span className="tp-cover">
                {post.cover_url
                  ? <ProxyImage src={post.cover_url} className="tp-cover-img" />
                  : <span className="tp-cover-ph">{(post.title || '投').charAt(0)}</span>}
              </span>
              <span className="tp-main">
                <span className="tp-title" title={postDisplayTitle(post)}>
                  {postDisplayTitle(post)}
                </span>
                <span className="tp-meta">
                  {/* R37-P4a：播放/点赞从裸文字改成 chip（浅底 + 深档字，行尾的视觉锚点）。
                      数字走 formatCount（万/亿缩写，最多 4 位）—— 与平台药丸同一口径，
                      否则"12.4万"这块会长出第二套写法。 */}
                  <span className="tone-chip tp-plays" data-metric={metric}>
                    {metric === 'view'
                      ? <CirclePlay size={11} aria-hidden="true" />
                      : <Heart size={11} aria-hidden="true" />}
                    {formatCount(score)}
                  </span>
                  <span className="tp-date">{formatDateTime(post.published_at).slice(0, 10)}</span>
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <p className="tp-hint">{hint}</p>
    </div>
  )
}