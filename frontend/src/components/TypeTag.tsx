import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { postTypeLabel } from '../utils/format'

const TYPE_CLASS: Record<string, string> = {
  video: 'border-sky-200 bg-sky-50 text-sky-700',
  video_dynamic: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  image: 'border-violet-200 bg-violet-50 text-violet-700',
  text: '',
  repost: 'border-purple-200 bg-purple-50 text-purple-700',
  article: 'border-orange-200 bg-orange-50 text-orange-700',
  live: 'border-red-200 bg-red-50 text-red-600',
  music: 'border-cyan-200 bg-cyan-50 text-cyan-700',
}

/** 帖子类型标签（未知类型灰色） */
export default function TypeTag({ type }: { type: string }) {
  return (
    <Badge variant="outline" className={cn('font-normal', TYPE_CLASS[type])}>
      {postTypeLabel(type)}
    </Badge>
  )
}
