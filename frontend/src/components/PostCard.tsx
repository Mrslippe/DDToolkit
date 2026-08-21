import {
  CommentOutlined,
  HeartOutlined,
  PlayCircleOutlined,
  RetweetOutlined,
} from '@ant-design/icons'
import type { Post } from '../api/types'
import { formatDateTime, parseBody, parseStats, postDisplayTitle, postTypeLabel } from '../utils/format'
import SmartImage from './SmartImage'
import StatBadge from './StatBadge'
import './../styles/posts.css'

interface Props {
  post: Post
  onClick?: () => void
}

function formatDuration(sec?: number): string | null {
  if (!sec || sec <= 0) return null
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 帖子卡片（设计稿 16_335 详情卡样式）：封面 + 类型角标 + 标题/摘要 + 统计徽章行 */
export default function PostCard({ post, onClick }: Props) {
  const body = parseBody(post.body_json)
  const stats = parseStats(post.stats_json)
  const images = body.images ?? []
  const duration = formatDuration(body.duration_sec)

  const coverSrc = post.cover_url ?? images[0]?.url

  return (
    <article className="post-card" onClick={onClick}>
      <div className="post-card-cover">
        {coverSrc ? (
          <SmartImage src={coverSrc} preview={false} className="post-card-cover-img" />
        ) : (
          <div className="post-card-cover-fallback">{post.summary ?? postDisplayTitle(post)}</div>
        )}
        <span className="post-card-type">{postTypeLabel(post.type)}</span>
        {duration && <span className="post-card-duration">{duration}</span>}
      </div>

      <div className="post-card-body">
        <h4 className="post-card-title" title={postDisplayTitle(post)}>
          {postDisplayTitle(post)}
        </h4>
        {post.summary && <p className="post-card-summary">{post.summary}</p>}
        <div className="post-card-footer">
          <div className="post-card-badges">
            {stats.view !== undefined && <StatBadge icon={<PlayCircleOutlined />} value={stats.view} label="播放" />}
            {stats.like !== undefined && <StatBadge icon={<HeartOutlined />} value={stats.like} label="点赞" />}
            {stats.comment !== undefined && <StatBadge icon={<CommentOutlined />} value={stats.comment} label="评论" />}
            {stats.forward !== undefined && <StatBadge icon={<RetweetOutlined />} value={stats.forward} label="转发" />}
            {!stats.view && !stats.like && !stats.comment && !stats.forward && stats.danmaku !== undefined && (
              <StatBadge value={stats.danmaku} label="弹幕" />
            )}
          </div>
          <span className="post-card-date">{formatDateTime(post.published_at).slice(0, 10)}</span>
        </div>
      </div>
    </article>
  )
}
