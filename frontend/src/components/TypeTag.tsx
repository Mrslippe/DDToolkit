import { Tag } from 'antd'
import { postTypeLabel } from '../utils/format'

const TYPE_COLOR: Record<string, string> = {
  video: 'blue',
  video_dynamic: 'geekblue',
  image: 'geekblue',
  text: 'default',
  repost: 'purple',
  article: 'orange',
  live: 'red',
  music: 'cyan',
}

/** 帖子类型标签（未知类型灰色） */
export default function TypeTag({ type }: { type: string }) {
  return (
    <Tag color={TYPE_COLOR[type] ?? 'default'} style={{ marginInlineEnd: 0 }}>
      {postTypeLabel(type)}
    </Tag>
  )
}
