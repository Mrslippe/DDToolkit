import { useState } from 'react'
import {
  Calendar,
  ChevronDown,
  Link2,
  MessageCircle,
  Eye,
  Heart,
  Repeat2,
  Star,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Separator } from '@/components/ui/separator'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import type { Post } from '../api/types'
import {
  formatCount,
  formatDateTime,
  parseBody,
  parseStats,
  postDisplayTitle,
} from '../utils/format'
import DeltaRenderer from './DeltaRenderer'
import SmartImage from './SmartImage'
import StatBadge from './StatBadge'
import TypeTag from './TypeTag'

interface Props {
  post: Post | null
  open: boolean
  onClose: () => void
}

/** 直播预约卡片（body_json.reservation） */
function ReservationCard({ status, buttonText, desc1, desc2, reserveTotal }: {
  status?: number
  buttonText?: string
  desc1?: string
  desc2?: string
  reserveTotal?: number
}) {
  const color =
    status === 2
      ? 'border-green-200 bg-green-50 text-green-700'
      : status === 1
        ? 'border-border bg-muted text-muted-foreground'
        : 'border-blue-200 bg-blue-50 text-blue-700'
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-lg border p-3 ${color}`}>
      <Calendar className="size-[18px] shrink-0" />
      <div className="min-w-0 flex-1">
        <div>
          <span className="font-medium">{desc1 || '直播预约'}</span>
          {desc2 && <span className="text-sm opacity-80"> · {desc2}</span>}
        </div>
        {typeof reserveTotal === 'number' && reserveTotal > 0 && (
          <div className="flex items-center gap-1 text-xs opacity-80">
            <Users className="size-3" /> {formatCount(reserveTotal)} 人已预约
          </div>
        )}
      </div>
      <span className="rounded-full border border-current px-2.5 py-0.5 text-xs">
        {buttonText || '预约'}
      </span>
    </div>
  )
}

/** 转发原文卡片（body_json.origin） */
function OriginCard({ origin }: { origin: NonNullable<ReturnType<typeof parseBody>['origin']> }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium">转发原文</span>
        {origin.type && <TypeTag type={origin.type} />}
      </div>
      <div className="space-y-2">
        {origin.title && <div className="text-sm font-medium">{origin.title}</div>}
        {origin.text && <p className="whitespace-pre-wrap text-sm">{origin.text}</p>}
        {origin.images && origin.images.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {origin.images.slice(0, 9).map((img, i) => (
              <SmartImage key={`${img.url}-${i}`} src={img.url} width={96} height={96}
                style={{ objectFit: 'cover', borderRadius: 6 }} />
            ))}
          </div>
        )}
        {origin.permalink && (
          <a href={origin.permalink} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline">
            <Link2 className="size-3.5" /> 查看原文
          </a>
        )}
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Separator />
      <div className="text-xs font-medium tracking-wide text-muted-foreground">{children}</div>
    </>
  )
}

/** 帖子详情抽屉：标题/封面/正文（Delta/HTML/纯文本）/图片/统计/预约/转发原文/链接/JSON */
export default function PostDetailDrawer({ post, open, onClose }: Props) {
  const [rawOpen, setRawOpen] = useState(false)
  if (!post) return null

  const body = parseBody(post.body_json)
  const stats = parseStats(post.stats_json)
  const images = body.images ?? []
  const isHtml = typeof body.content === 'string' && /<[a-z][\s\S]*>/i.test(body.content)

  const statItems = [
    { key: 'view', label: '播放', value: stats.view, icon: <Eye /> },
    { key: 'like', label: '点赞', value: stats.like, icon: <Heart /> },
    { key: 'comment', label: '评论', value: stats.comment, icon: <MessageCircle /> },
    { key: 'forward', label: '转发', value: stats.forward, icon: <Repeat2 /> },
    { key: 'favorite', label: '收藏', value: stats.favorite, icon: <Star /> },
    { key: 'coin', label: '投币', value: stats.coin },
    { key: 'share', label: '分享', value: stats.share },
    { key: 'danmaku', label: '弹幕', value: stats.danmaku },
  ].filter((s) => s.value !== undefined && s.value !== null)

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto p-5 sm:max-w-[720px]"
      >
        <SheetHeader className="p-0">
          <SheetTitle className="pr-8 text-base leading-snug">
            {postDisplayTitle(post)}
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* 元信息 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
            <TypeTag type={post.type} />
            <span>发布于 {formatDateTime(post.published_at)}</span>
            <span>ID: {post.platform_post_id}</span>
            {post.permalink && (
              <a href={post.permalink} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline">
                <Link2 className="size-3.5" /> 查看原文
              </a>
            )}
          </div>

          {/* 统计徽章行 */}
          {statItems.length > 0 && (
            <div className="drawer-stats">
              {statItems.map((s) => (
                <StatBadge key={s.key} icon={s.icon} value={s.value as number} label={s.label} />
              ))}
            </div>
          )}

          {/* 直播预约 */}
          {body.reservation && (
            <ReservationCard
              status={body.reservation.status}
              buttonText={body.reservation.button_text}
              desc1={body.reservation.desc1}
              desc2={body.reservation.desc2}
              reserveTotal={body.reservation.reserve_total}
            />
          )}

          {/* 封面 */}
          {post.cover_url && (
            <SmartImage
              src={post.cover_url}
              alt="封面"
              className="w-full rounded-lg object-contain"
              style={{ maxHeight: 320 }}
            />
          )}

          {/* 正文：Delta 富文本 → HTML 全文 → 纯文本（保留换行） */}
          {body.delta ? (
            <div className="rich-text">
              <DeltaRenderer delta={body.delta} />
            </div>
          ) : body.content ? (
            <div>
              <SectionTitle>正文</SectionTitle>
              {isHtml ? (
                // 专栏全文为平台 HTML；本地工具场景直接渲染，如部署公网建议净化处理
                <div
                  className="rich-text mt-2 text-sm leading-[1.9]"
                  dangerouslySetInnerHTML={{ __html: body.content }}
                />
              ) : (
                <p className="mt-2 whitespace-pre-wrap text-sm">{String(body.content)}</p>
              )}
            </div>
          ) : (
            body.text && <p className="whitespace-pre-wrap text-sm">{body.text}</p>
          )}
          {!body.delta && !body.content && !body.text && post.summary && (
            <p className="text-sm text-muted-foreground">{post.summary}</p>
          )}

          {/* 转发原文 */}
          {body.origin && <OriginCard origin={body.origin} />}

          {/* 图片组 */}
          {images.length > 0 && (
            <div>
              <SectionTitle>图片（{images.length}）</SectionTitle>
              <div className="mt-2 flex flex-wrap gap-2">
                {images.map((img, i) => (
                  <SmartImage key={`${img.url}-${i}`} src={img.url} width={120} height={120}
                    style={{ objectFit: 'cover', borderRadius: 6 }} />
                ))}
              </div>
            </div>
          )}

          {/* 附加字段 */}
          {(body.bvid || body.cv_id || body.description) && (
            <div className="space-y-2 text-sm">
              {body.bvid && <code className="rounded bg-muted px-1.5 py-0.5">BV: {body.bvid}</code>}
              {body.description && (
                <p className="whitespace-pre-wrap text-muted-foreground">
                  简介：{body.description}
                </p>
              )}
              {body.cv_id && <code className="rounded bg-muted px-1.5 py-0.5">cv{body.cv_id}</code>}
            </div>
          )}

          {/* 原始 JSON */}
          {post.raw_json && (
            <Collapsible open={rawOpen} onOpenChange={setRawOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="text-muted-foreground">
                  原始响应 raw_json
                  <ChevronDown className={`transition-transform ${rawOpen ? 'rotate-180' : ''}`} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
                  {post.raw_json}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
