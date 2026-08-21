import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Card,
  Descriptions,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  ArrowLeftOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { api, resolveAsset } from '../api/api'
import type { Account, Post, PostStats } from '../api/types'
import { formatCount, formatDateTime, parseStats, postDisplayTitle, postTypeLabel } from '../utils/format'
import PostDetailDrawer from '../components/PostDetailDrawer'
import TypeTag from '../components/TypeTag'

const { Text, Title } = Typography

const PAGE_SIZE = 20

const TYPE_ORDER = ['video', 'video_dynamic', 'image', 'text', 'repost', 'article', 'music', 'live']

/** 帖子列表页：账号信息 + 统计概览 + 类型过滤 + 服务端分页表格 + 详情抽屉 + 抓取按钮 */
export default function PostsPage() {
  const { id } = useParams()
  const vtuberId = Number(id)
  const navigate = useNavigate()
  const { message } = AntApp.useApp()

  const [vtuber, setVtuber] = useState<Awaited<ReturnType<typeof api.getVtuber>> | null>(null)
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null)
  const [stats, setStats] = useState<PostStats | null>(null)

  const [posts, setPosts] = useState<Post[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [typeFilter, setTypeFilter] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)

  const [drawerPost, setDrawerPost] = useState<Post | null>(null)

  // 加载 VTuber 与默认账号
  useEffect(() => {
    let cancelled = false
    api
      .getVtuber(vtuberId)
      .then((v) => {
        if (cancelled) return
        setVtuber(v)
        const accounts = v.accounts.filter((a) => a.platform_uid)
        if (accounts.length > 0) {
          setSelectedAccount(accounts[0])
        } else {
          setError('该 VTuber 没有可用账号')
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [vtuberId])

  // 统计概览
  useEffect(() => {
    if (!selectedAccount) return
    let cancelled = false
    api
      .postStats(selectedAccount.platform, selectedAccount.platform_uid)
      .then((s) => !cancelled && setStats(s))
      .catch(() => !cancelled && setStats(null))
    return () => {
      cancelled = true
    }
  }, [selectedAccount])

  // 帖子列表（服务端分页 + 过滤）
  useEffect(() => {
    if (!selectedAccount) return
    setLoading(true)
    setError(null)
    let cancelled = false
    api
      .listPosts(selectedAccount.platform, selectedAccount.platform_uid, {
        page,
        page_size: PAGE_SIZE,
        type: typeFilter,
      })
      .then((p) => {
        if (cancelled) return
        setPosts(p.items)
        setTotal(p.total)
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [selectedAccount, page, typeFilter])

  const changeAccount = (uid: string) => {
    const acc = vtuber?.accounts.find((a) => a.platform_uid === uid) ?? null
    setSelectedAccount(acc)
    setPage(1)
    setTypeFilter(undefined)
  }

  const handleFetch = useCallback(async () => {
    if (!vtuber || fetching) return
    setFetching(true)
    try {
      const r = await api.fetchVtuber(vtuberId)
      if (r.status === 'skipped') {
        message.warning(r.message ?? '抓取任务正在进行中')
      } else {
        const s = r.result
        message.success(`账号信息抓取完成: 成功 ${s?.success ?? 0} · 失败 ${s?.failed ?? 0}`)
      }
    } catch (e) {
      message.error(`抓取失败: ${(e as Error).message}`)
    } finally {
      setFetching(false)
    }
  }, [vtuber, vtuberId, fetching])

  const handleFetchPosts = useCallback(async () => {
    if (!vtuber || fetching) return
    setFetching(true)
    try {
      const r = await api.fetchPostsByName(vtuber.name)
      if (r.status === 'skipped') {
        message.warning(r.message ?? '帖子抓取正在进行中')
      } else {
        message.success(`帖子抓取完成: 存储 ${r.total?.stored ?? 0} · 跳过 ${r.total?.skipped ?? 0} · 视频 ${r.total?.videos ?? 0}`)
      }
    } catch (e) {
      message.error(`帖子抓取失败: ${(e as Error).message}`)
    } finally {
      setFetching(false)
    }
  }, [vtuber, fetching])

  const handleUpdatePosts = useCallback(async () => {
    if (!vtuber || fetching) return
    setFetching(true)
    try {
      const r = await api.updateUnarchivedPosts(vtuber.name)
      if (r.status === 'skipped') {
        message.warning(r.message ?? '更新任务正在进行中')
      } else {
        message.success(
          `未归档动态更新完成: 归档 ${r.archived ?? 0} · 新增 ${r.total?.stored ?? 0} · 跳过 ${r.total?.skipped ?? 0}`,
        )
      }
    } catch (e) {
      message.error(`更新失败: ${(e as Error).message}`)
    } finally {
      setFetching(false)
    }
  }, [vtuber, fetching])

  const columns = useMemo<ColumnsType<Post>>(
    () => [
      {
        title: '类型',
        dataIndex: 'type',
        width: 80,
        render: (t: string) => <TypeTag type={t} />,
      },
      {
        title: '标题',
        dataIndex: 'title',
        ellipsis: { showTitle: true },
        render: (_t: string | null, r) => <span>{postDisplayTitle(r)}</span>,
      },
      {
        title: '摘要',
        dataIndex: 'summary',
        ellipsis: { showTitle: true },
        width: 300,
        render: (s: string | null) => (s ? <Text type="secondary">{s}</Text> : '-'),
      },
      {
        title: '统计',
        key: 'stats',
        width: 130,
        render: (_, r) => {
          const st = parseStats(r.stats_json)
          const parts = [
            st.view !== undefined ? `播 ${formatCount(st.view)}` : null,
            st.like !== undefined ? `赞 ${formatCount(st.like)}` : null,
          ].filter(Boolean)
          return <Text type="secondary">{parts.length ? parts.join(' · ') : '-'}</Text>
        },
      },
      {
        title: '发布时间',
        dataIndex: 'published_at',
        width: 150,
        render: (t: string | null) => (
          <span style={{ whiteSpace: 'nowrap' }}>{formatDateTime(t)}</span>
        ),
      },
      {
        title: '操作',
        key: 'action',
        width: 80,
        render: (_, r) => (
          <Button type="link" size="small" onClick={() => setDrawerPost(r)}>
            详情
          </Button>
        ),
      },
    ],
    [],
  )

  const tabItems = useMemo(() => {
    const counts = stats?.by_type ?? {}
    const types = Object.keys(counts).sort(
      (a, b) => (TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b)) || (counts[b] - counts[a]),
    )
    return [
      { key: 'all', label: `全部 ${stats?.total ?? ''}` },
      ...types.map((t) => ({ key: t, label: `${postTypeLabel(t)} ${counts[t]}` })),
    ]
  }, [stats])

  // 注意：所有 Hook 必须在此提前返回之前执行完（Rules of Hooks）
  if (!vtuber) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  const avatarSrc = resolveAsset(selectedAccount?.avatar_path) ?? selectedAccount?.avatar_url ?? undefined

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space size={8}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>
          返回
        </Button>
        <Title level={4} style={{ margin: 0 }}>
          {vtuber.name}
        </Title>
      </Space>

      {/* 账号信息条 */}
      <Card size="small">
        <Space size={20} align="start" wrap>
          <Avatar size={64} src={avatarSrc} />
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2, md: 4 }}
            items={[
              {
                key: 'account',
                label: '账号',
                children:
                  (vtuber.accounts.length > 1 && selectedAccount ? (
                    <Select
                      size="small"
                      value={selectedAccount.platform_uid}
                      onChange={changeAccount}
                      options={vtuber.accounts.map((a) => ({
                        value: a.platform_uid,
                        label: `${a.platform} / ${a.platform_uid}`,
                      }))}
                    />
                  ) : (
                    <Text>
                      {selectedAccount?.platform} / {selectedAccount?.platform_uid}
                    </Text>
                  )),
              },
              {
                key: 'followers',
                label: '粉丝',
                children: (
                  <Text strong>{formatCount(selectedAccount?.followers_count)}</Text>
                ),
              },
              {
                key: 'live',
                label: '直播',
                children: (selectedAccount?.live_status ?? 0) === 1 ? (
                  <Tooltip title={selectedAccount?.live_title}>
                    <Tag color="red">直播中 · {selectedAccount?.room_id}</Tag>
                  </Tooltip>
                ) : (
                  <Text type="secondary">离线</Text>
                ),
              },
              {
                key: 'lastfetch',
                label: '上次抓取',
                children: (
                  <Text type="secondary">{formatDateTime(selectedAccount?.last_fetched_at)}</Text>
                ),
              },
            ]}
          />
          <Space style={{ marginLeft: 'auto' }}>
            <Button
              icon={<ThunderboltOutlined />}
              loading={fetching}
              onClick={handleFetch}
            >
              抓取账号信息
            </Button>
            <Button
              icon={<ReloadOutlined />}
              loading={fetching}
              onClick={handleFetchPosts}
            >
              抓取帖子（{vtuber.name}）
            </Button>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={fetching}
              onClick={handleUpdatePosts}
            >
              更新未归档动态
            </Button>
          </Space>
        </Space>
      </Card>

      {/* 统计概览 */}
      {stats && (
        <Card size="small">
          <Space size={40} wrap>
            <Statistic title="帖子总数" value={stats.total} />
            {TYPE_ORDER.filter((t) => stats.by_type[t]).map((t) => (
              <Statistic key={t} title={postTypeLabel(t)} value={stats.by_type[t]} />
            ))}
            <Statistic title="已归档" value={stats.archived} />
            <Statistic
              title="时间跨度"
              valueRender={() => (
                <Text type="secondary" style={{ fontSize: 13 }}>
                  <ClockCircleOutlined /> {formatDateTime(stats.earliest)} ~ {formatDateTime(stats.latest)}
                </Text>
              )}
            />
          </Space>
        </Card>
      )}

      {/* 帖子表格 */}
      <Card size="small">
        {error ? (
          <Alert type="error" showIcon message="加载失败" description={error} />
        ) : (
          <Tabs
            activeKey={typeFilter ?? 'all'}
            onChange={(k) => {
              setTypeFilter(k === 'all' ? undefined : k)
              setPage(1)
            }}
            items={tabItems}
          />
        )}
        <Table<Post>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={posts}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p) => setPage(p),
          }}
          onRow={(r) => ({
            style: { cursor: 'pointer' },
            onClick: () => setDrawerPost(r),
          })}
        />
      </Card>

      <PostDetailDrawer
        post={drawerPost}
        open={drawerPost !== null}
        onClose={() => setDrawerPost(null)}
      />
    </Space>
  )
}
