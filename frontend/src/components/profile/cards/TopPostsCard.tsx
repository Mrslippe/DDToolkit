/**
 * 「随机投稿」卡片（R37-P1 原名「优质投稿」；R42 按用户口径改成随机展示）。
 *
 * 用户口径（2026-09-19）：「优质投稿改为**随机投稿**，并且在卡片中随机展示投稿，
 * 但不要用现在这种形式，简单参考图一的设计，**让封面更大更明显**」——
 * 图一是两张大封面并排：封面占满、标题压在封面下缘的暗角上、角上一枚类型标、
 * 底部一行小数字（播放量 / 日期）。
 *
 * 与旧版的差别：① 取样从 `rankTopPosts`（最优质前 3）改成 `pickRandomPosts`（随机 2 条）；
 * ② 版式从"缩略图 + 文字行"改成"**大封面 + 压字**"；③ 多一个「换一批」（随机是随机的，
 * 得给用户一个"再来一次"的出口，否则第一次随到不喜欢的就没辙了）。
 *
 * ⚠️ 随机只在**本地库那 50 条**里随（`FETCH_SIZE`），不新增后端接口 ——
 * "随机"这件事不需要服务端参与，也不该为它多打一次网络。
 */
import { useEffect, useMemo, useState } from 'react'
import { CirclePlay, Heart, Shuffle } from 'lucide-react'

import { api } from '../../../api/api'
import type { Post } from '../../../api/types'
import { formatCount, formatDateTime, postDisplayTitle } from '../../../utils/format'
import ProxyImage from '../../common/ProxyImage'
import type { CardContext } from '../cardRegistry'
import { pickRandomPosts, randomPostsHint } from '../topPosts'

/** 取多少条候选再随机：一页够用（50 条里抽 2 条），多了只是白花时间 */
const FETCH_SIZE = 50
/** 展示几张（图一就是两张大封面并排） */
const SHOW = 2

const TYPE_LABEL: Record<string, string> = {
  video: '投稿', text: '动态', image: '图集', article: '专栏', live: '直播',
}

export default function TopPostsCard({ account, onOpenPost, refreshTick }: CardContext) {
  const [posts, setPosts] = useState<Post[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  /** 换一批：只换种子，不重取数据（数据没变，变的是"抽哪几条"） */
  const [seed, setSeed] = useState(0)

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

  const picked = useMemo(() => {
    // 用种子驱动一个可复现的伪随机（`seed` 变了就换一批；同一次渲染结果稳定）
    let s = seed * 9301 + 49297
    const rand = () => {
      s = (s * 9301 + 49297) % 233280
      return s / 233280
    }
    return pickRandomPosts(posts, SHOW, seed === 0 ? Math.random : rand)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts, seed])
  const hint = useMemo(() => randomPostsHint(posts, picked), [posts, picked])

  if (!account) {
    return <p className="pcard-empty">这个 V 还没有账号</p>
  }
  if (state === 'loading' && !posts.length) {
    // 骨架：与"有内容"时同尺寸（R36 的口径 —— 数据到达不该让卡片变高）
    return (
      <div className="rp-grid" data-card-body="top-posts" data-pending="1">
        {[0, 1].map((i) => (
          <span className="rp-card" key={`skel-${i}`}>
            <span className="lc-skel rp-skel" />
          </span>
        ))}
      </div>
    )
  }
  if (state === 'error') {
    return <p className="pcard-empty">投稿没取到（本地库读失败）—— 切走再切回来会重试</p>
  }
  if (!picked.length) {
    return <p className="pcard-empty">{hint}</p>
  }

  return (
    <div className="rp" data-card-body="top-posts">
      <div className="rp-grid" data-rp-count={picked.length}>
        {picked.map((post) => (
          <button type="button" className="rp-card" key={post.id}
                  data-rp-post={post.id}
                  title={postDisplayTitle(post)}
                  onClick={() => onOpenPost(post)}>
            {/* 封面：整张卡就是封面（图一的"封面更大更明显"） */}
            {post.cover_url
              ? <ProxyImage src={post.cover_url} className="rp-cover" />
              : <span className="rp-cover-ph">{(post.title || '投').charAt(0)}</span>}
            <span className="rp-scrim" aria-hidden="true" />
            <span className="rp-type">{TYPE_LABEL[post.type] ?? post.type}</span>
            <span className="rp-title">{postDisplayTitle(post)}</span>
            <span className="rp-meta">
              <span className="rp-plays">
                {(post.stats_json && /"view"\s*:\s*\d+/.test(post.stats_json))
                  ? <CirclePlay size={11} aria-hidden="true" />
                  : <Heart size={11} aria-hidden="true" />}
                {formatCount(statsOf(post))}
              </span>
              <span className="rp-date">{formatDateTime(post.published_at).slice(0, 10)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="rp-foot">
        <span className="rp-hint">{hint}</span>
        <button type="button" className="rp-again" data-rp-again
                onClick={() => setSeed((n) => n + 1)}>
          <Shuffle size={12} /> 换一批
        </button>
      </div>
    </div>
  )
}

/** 播放量优先、点赞兜底（与 `topPosts.ts` 同一口径；这里只要一个数） */
function statsOf(post: Post): number {
  try {
    const s = JSON.parse(post.stats_json || '{}') as { view?: number; like?: number }
    return s.view && s.view > 0 ? s.view : (s.like ?? 0)
  } catch {
    return 0
  }
}
