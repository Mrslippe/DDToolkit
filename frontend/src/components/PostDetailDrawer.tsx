import {
  CalendarOutlined,
  CommentOutlined,
  EyeOutlined,
  HeartOutlined,
  LinkOutlined,
  RetweetOutlined,
  StarOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import { Card, Collapse, Descriptions, Divider, Drawer, Space, Tag, Typography } from 'antd'
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
import TypeTag from './TypeTag'

const { Text, Paragraph } = Typography

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
  const color = status === 2 ? 'green' : status === 1 ? 'default' : 'blue'
  return (
    <Card size="small" style={{ background: '#f9fbff' }}>
      <Space size={12} wrap>
        <CalendarOutlined style={{ fontSize: 18, color: '#1677ff' }} />
        <div>
          <div>
            <Text strong>{desc1 || '直播预约'}</Text>
            {desc2 && <Text type="secondary"> · {desc2}</Text>}
          </div>
          {typeof reserveTotal === 'number' && reserveTotal > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              <TeamOutlined /> {formatCount(reserveTotal)} 人已预约
            </Text>
          )}
        </div>
        <Tag color={color} style={{ marginInlineEnd: 0 }}>{buttonText || '预约'}</Tag>
      </Space>
    </Card>
  )
}

/** 转发原文卡片（body_json.origin） */
function OriginCard({ origin }: { origin: NonNullable<ReturnType<typeof parseBody>['origin']> }) {
  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          <span>转发原文</span>
          {origin.type && <TypeTag type={origin.type} />}
        </Space>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {origin.title && <Text strong>{origin.title}</Text>}
        {origin.text && (
          <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{origin.text}</Paragraph>
        )}
        {origin.images && origin.images.length > 0 && (
          <Space wrap size={6}>
            {origin.images.slice(0, 9).map((img, i) => (
              <SmartImage key={`${img.url}-${i}`} src={img.url} width={96} height={96} />
            ))}
          </Space>
        )}
        {origin.permalink && (
          <a href={origin.permalink} target="_blank" rel="noreferrer">
            <LinkOutlined /> 查看原文
          </a>
        )}
      </Space>
    </Card>
  )
}

/** 帖子详情抽屉：标题/封面/正文（Delta/HTML/纯文本）/图片/统计/预约/转发原文/链接/JSON */
export default function PostDetailDrawer({ post, open, onClose }: Props) {
  if (!post) return null

  const body = parseBody(post.body_json)
  const stats = parseStats(post.stats_json)
  const images = body.images ?? []
  const isHtml = typeof body.content === 'string' && /<[a-z][\s\S]*>/i.test(body.content)

  const statItems = [
    { key: 'view', label: '播放', value: stats.view, icon: <EyeOutlined /> },
    { key: 'like', label: '点赞', value: stats.like, icon: <HeartOutlined /> },
    { key: 'comment', label: '评论', value: stats.comment, icon: <CommentOutlined /> },
    { key: 'forward', label: '转发', value: stats.forward, icon: <RetweetOutlined /> },
    { key: 'favorite', label: '收藏', value: stats.favorite, icon: <StarOutlined /> },
    { key: 'coin', label: '投币', value: stats.coin },
    { key: 'share', label: '分享', value: stats.share },
    { key: 'danmaku', label: '弹幕', value: stats.danmaku },
  ].filter((s) => s.value !== undefined && s.value !== null)

  return (
    <DrawerShell title={postDisplayTitle(post)} open={open} onClose={onClose}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {/* 元信息 */}
        <Space size={16} wrap>
          <TypeTag type={post.type} />
          <Text type="secondary">发布于 {formatDateTime(post.published_at)}</Text>
          <Text type="secondary">ID: {post.platform_post_id}</Text>
          {post.permalink && (
            <a href={post.permalink} target="_blank" rel="noreferrer">
              <LinkOutlined /> 查看原文
            </a>
          )}
        </Space>

        {/* 统计 */}
        {statItems.length > 0 && (
          <Descriptions
            size="small"
            column={4}
            bordered
            items={statItems.map((s) => ({
              key: s.key,
              label: s.label,
              children: (
                <Space size={4}>
                  {s.icon}
                  {formatCount(s.value as number)}
                </Space>
              ),
            }))}
          />
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
            style={{ maxHeight: 320, objectFit: 'contain', borderRadius: 8 }}
          />
        )}

        {/* 正文：Delta 富文本 → HTML 全文 → 纯文本（保留换行） */}
        {body.delta ? (
          <DeltaRenderer delta={body.delta} />
        ) : body.content ? (
          <div>
            <Divider orientation="left" plain style={{ margin: '4px 0' }}>
              正文
            </Divider>
            {isHtml ? (
              // 专栏全文为平台 HTML；本地工具场景直接渲染，如部署公网建议净化处理
              <div
                style={{ fontSize: 14, lineHeight: 1.9 }}
                dangerouslySetInnerHTML={{ __html: body.content }}
              />
            ) : (
              <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{String(body.content)}</Paragraph>
            )}
          </div>
        ) : (
          body.text && <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{body.text}</Paragraph>
        )}
        {!body.delta && !body.content && !body.text && post.summary && (
          <Paragraph type="secondary">{post.summary}</Paragraph>
        )}

        {/* 转发原文 */}
        {body.origin && <OriginCard origin={body.origin} />}

        {/* 图片组 */}
        {images.length > 0 && (
          <div>
            <Divider orientation="left" plain style={{ margin: '4px 0' }}>
              图片（{images.length}）
            </Divider>
            <Space wrap size={8}>
              {images.map((img, i) => (
                <SmartImage
                  key={`${img.url}-${i}`}
                  src={img.url}
                  width={120}
                  height={120}
                  style={{ objectFit: 'cover', borderRadius: 6 }}
                />
              ))}
            </Space>
          </div>
        )}

        {/* 附加字段 */}
        {body.bvid && <Text code>BV: {body.bvid}</Text>}
        {body.description && (
          <Paragraph type="secondary" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
            简介：{body.description}
          </Paragraph>
        )}
        {body.cv_id && <Text code>cv{body.cv_id}</Text>}

        {/* 原始 JSON */}
        {post.raw_json && (
          <Collapse
            size="small"
            items={[
              {
                key: 'raw',
                label: '原始响应 raw_json',
                children: <pre style={{ maxHeight: 320, overflow: 'auto', fontSize: 12 }}>{post.raw_json}</pre>,
              },
            ]}
          />
        )}
      </Space>
    </DrawerShell>
  )
}

/** 简单封装：抽屉标题带类型标签 */
function DrawerShell({ title, open, onClose, children }: {
  title: string
  open: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <Drawer
      title={<Space size={8} wrap><span style={{ fontSize: 16, fontWeight: 600 }}>{title}</span></Space>}
      width={720}
      open={open}
      onClose={onClose}
    >
      {children}
    </Drawer>
  )
}
