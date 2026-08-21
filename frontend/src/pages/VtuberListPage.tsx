import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Avatar, Badge, Card, Col, Row, Spin, Tag, Tooltip, Typography } from 'antd'
import { FileTextOutlined, VideoCameraOutlined } from '@ant-design/icons'
import { api, resolveAsset } from '../api/api'
import type { VTuber } from '../api/types'
import { formatCount } from '../utils/format'

const { Text } = Typography

/** VTuber 列表页：卡片展示主播本体（头像/粉丝/直播状态），点击进入帖子页 */
export default function VtuberListPage() {
  const [vtubers, setVtubers] = useState<VTuber[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    api
      .listVtubers()
      .then((data) => !cancelled && setVtubers(data))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  if (error) {
    return <Alert type="error" showIcon message="加载失败" description={error} />
  }

  if (vtubers.length === 0) {
    return <Alert type="info" showIcon message="暂无 VTuber，请先在后端导入名单（vtubers.csv flag=1）" />
  }

  return (
    <Row gutter={[16, 16]}>
      {vtubers.map((v) => {
        const bili = v.accounts.find((a) => a.platform === 'bilibili')
        const avatarSrc = resolveAsset(bili?.avatar_path) ?? bili?.avatar_url ?? undefined
        const isLive = (bili?.live_status ?? 0) === 1
        return (
          <Col key={v.id} xs={24} sm={12} md={8} lg={6}>
            <Card
              hoverable
              onClick={() => navigate(`/vtubers/${v.id}`)}
              cover={
                <div style={{ padding: 24, textAlign: 'center' }}>
                  <Badge dot={isLive} color="red" offset={[-6, 42]}>
                    <Avatar size={88} src={avatarSrc} icon={<Text>{v.name.slice(0, 1)}</Text>}>
                      {v.name.slice(0, 1)}
                    </Avatar>
                  </Badge>
                </div>
              }
            >
              <Card.Meta
                title={
                  <SpaceBetween>
                    <span>{v.name}</span>
                    {isLive && <Tag color="red">直播中</Tag>}
                  </SpaceBetween>
                }
                description={
                  <div style={{ fontSize: 12 }}>
                    {bili ? (
                      <>
                        <div>
                          <Text type="secondary">粉丝 </Text>
                          <Text strong>{formatCount(bili.followers_count)}</Text>
                          <Text type="secondary"> · UID {bili.platform_uid}</Text>
                        </div>
                        {isLive && bili.live_title && (
                          <Tooltip title={bili.live_title}>
                            <Text type="secondary" ellipsis style={{ display: 'block' }}>
                              直播：{bili.live_title}
                            </Text>
                          </Tooltip>
                        )}
                        {bili.sign && (
                          <Text type="secondary" ellipsis style={{ display: 'block' }}>
                            {bili.sign}
                          </Text>
                        )}
                      </>
                    ) : (
                      <Text type="secondary">暂无账号信息</Text>
                    )}
                    <div style={{ marginTop: 8 }}>
                      <Tag icon={<VideoCameraOutlined />} style={{ marginInlineEnd: 4 }}>
                        {v.accounts.length} 个账号
                      </Tag>
                      <Tag icon={<FileTextOutlined />}>点击查看帖子</Tag>
                    </div>
                  </div>
                }
              />
            </Card>
          </Col>
        )
      })}
    </Row>
  )
}

function SpaceBetween({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      {children}
    </div>
  )
}
