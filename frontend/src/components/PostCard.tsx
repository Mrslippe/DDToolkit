import { memo, useMemo } from 'react'
import {
  MessageCircle,
  Heart,
  CirclePlay,
  Pin,
  Repeat2,
} from 'lucide-react'
import type { Post } from '../api/types'
import { formatDateTime, parseBody, parseStats, postDisplaySummary, postDisplayTitle, postTypeLabel } from '../utils/format'
import ProxyImage from './common/ProxyImage'
import StatBadge from './StatBadge'
import './../styles/posts.css'

interface Props {
  post: Post
  /** 列表内序号：驱动依次入场动画（--rise-i） */
  index: number
  /** 打开详情抽屉（稳定引用；组件已 memo，避免父级每次渲染新建闭包击穿缓存） */
  onOpen: (post: Post) => void
}

function formatDuration(sec?: number): string | null {
  if (!sec || sec <= 0) return null
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 帖子卡片（设计稿 16_335 详情卡样式）：封面 + 类型角标 + 标题/摘要 + 统计徽章行 */
const PostCard = memo(function PostCard({ post, index, onOpen }: Props) {
  // 解析结果按原始 JSON 缓存：body_json 可能很大（B站完整 body），
  // 抽屉开合/loading 翻转等无关渲染不再重复 JSON.parse
  const body = useMemo(() => parseBody(post.body_json), [post.body_json])
  const stats = useMemo(() => parseStats(post.stats_json), [post.stats_json])
  const title = useMemo(() => postDisplayTitle(post), [post])
  /** 摘要同样过滤占位串（`[9P]` 这类"不是内容"的值不该占卡片一行） */
  const summary = useMemo(() => postDisplaySummary(post), [post])
  const images = body.images ?? []
  const duration = formatDuration(body.duration_sec)

  const coverSrc = post.cover_url ?? images[0]?.url

  // 键盘可达：光标 Tab 到卡片，Enter / Space 打开详情（Space 需 preventDefault 防滚动）
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(post)
    }
  }

  return (
    <article
      className={`post-card anim-rise${post.deleted_detected_at ? ' is-deleted' : ''}${post.is_pinned ? ' is-pinned' : ''}`}
      style={{ '--rise-i': index } as React.CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={`查看帖子：${title}`}
      onClick={() => onOpen(post)}
      onKeyDown={handleKeyDown}
    >
      <div className="post-card-cover">
        {coverSrc ? (
          <ProxyImage src={coverSrc} className="post-card-cover-img" />
        ) : (
          <div className="post-card-cover-paper">
            <span className="paper-title">{title}</span>
          </div>
        )}
        <span className="post-card-type">{postTypeLabel(post.type)}</span>
        {duration && <span className="post-card-duration">{duration}</span>}
        {post.deleted_detected_at && (
          <span className="post-card-deleted-badge" title={`删除发现于 ${post.deleted_detected_at}`}>
            已删
          </span>
        )}
      </div>

      {/* R35：平台置顶（B 站「置顶」/ 微博 isTop）。后端把置顶帖排在本账号列表最前，
          这里给出「为什么它不在时间线上」的解释（devlog/139）。
          ⚠️ 2026-09-17 用户口径：徽章钉在**卡片右上角**（不是封面右上、更不是正文里占一行）
          —— 原来放在正文顶部会顶掉标题那一行（用户截图为证）；现在由 CSS 绝对定位到卡片
          右上，并让标题在右端留出它的宽度（`.post-card.is-pinned .post-card-title`）。 */}
      {post.is_pinned && (
        <span className="post-card-pin" title="平台置顶：作者置顶的动态，已同步到列表最前">
          <Pin size={11} aria-hidden="true" />
          置顶
        </span>
      )}

      <div className="post-card-body">
        <h4 className="post-card-title" title={title}>
          {title}
        </h4>
        {summary && <p className="post-card-summary">{summary}</p>}
        {/* P9-3（v0.9.6）：投稿动态的附言并入同 bvid 的投稿帖后在这里标注出来
            （一条视频只出现一次，附言不丢） */}
        {post.note && (
          <p className="post-card-note" title={post.note}>
            <span className="post-card-note-tag">UP 主附言</span>
            {post.note}
          </p>
        )}
        <div className="post-card-footer">
          <div className="post-card-badges">
            {stats.view !== undefined && <StatBadge icon={<CirclePlay />} value={stats.view} label="播放" />}
            {stats.like !== undefined && <StatBadge icon={<Heart />} value={stats.like} label="点赞" />}
            {stats.comment !== undefined && <StatBadge icon={<MessageCircle />} value={stats.comment} label="评论" />}
            {stats.forward !== undefined && <StatBadge icon={<Repeat2 />} value={stats.forward} label="转发" />}
            {!stats.view && !stats.like && !stats.comment && !stats.forward && stats.danmaku !== undefined && (
              <StatBadge value={stats.danmaku} label="弹幕" />
            )}
          </div>
          <span className="post-card-date">{formatDateTime(post.published_at).slice(0, 10)}</span>
        </div>
      </div>
    </article>
  )
})

export default PostCard