import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Pagination,
  Segmented,
  Select,
  Space,
  Tooltip,
} from 'antd'
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { api, resolveAsset } from '../api/api'
import type { Account, Post, PostStats, VTuber } from '../api/types'
import { formatCount, formatDateTime, postTypeLabel } from '../utils/format'
import PostCard from '../components/PostCard'
import PostDetailDrawer from '../components/PostDetailDrawer'
import './../styles/posts.css'

const PAGE_SIZE = 20

const TYPE_ORDER = ['video', 'video_dynamic', 'image', 'text', 'repost', 'article', 'music', 'live']

/** 归档过滤：all=全部（含已归档） unarchived=仅未归档 archived=仅已归档 */
type ArchivedFilter = 'all' | 'unarchived' | 'archived'

/**
 * 帖子面板（右栏 /vtubers/:id）：
 * VTuber 信息条 + 类型筛选 chips + 帖子卡片流（服务端分页）+ 详情抽屉 + 抓取操作。
 * 视觉参照设计稿 Frame1672。
 */
export default function PostsPage() {
  const { id } = useParams()
  const vtuberId = Number(id)
  const { message } = AntApp.useApp()

  const [vtuber, setVtuber] = useState<VTuber | null>(null)
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null)
  const [stats, setStats] = useState<PostStats | null>(null)

  const [posts, setPosts] = useState<Post[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [typeFilter, setTypeFilter] = useState<string>()
  const [archived, setArchived] = useState<ArchivedFilter>('all')
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
        is_archived: archived === 'all' ? undefined : archived === 'archived',
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
  }, [selectedAccount, page, typeFilter, archived])

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

  // 类型筛选 chips：全部 N / 视频 N / 图文 N ...（计数来自统计概览）
  const chipItems = useMemo(() => {
    const counts = stats?.by_type ?? {}
    const types = Object.keys(counts).sort(
      (a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b) || counts[b] - counts[a],
    )
    return [
      { key: 'all', label: '全部', count: stats?.total ?? total },
      ...types.map((t) => ({ key: t, label: postTypeLabel(t), count: counts[t] })),
    ]
  }, [stats, total])

  // 注意：所有 Hook 必须在此提前返回之前执行完（Rules of Hooks）
  if (!vtuber && !error) {
    return (
      <div className="posts-panel">
        <div className="post-grid">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="post-card sk" aria-hidden>
              <div className="post-card-cover sk-block" />
              <div className="post-card-body">
                <div className="sk-block sk-line w60" />
                <div className="sk-block sk-line w90" />
                <div className="sk-block sk-line w40" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!vtuber) {
    return (
      <div className="posts-panel">
        <Alert type="warning" showIcon message="无法加载" description={error} />
      </div>
    )
  }

  const bili = selectedAccount
  const avatarSrc = resolveAsset(bili?.avatar_path) ?? bili?.avatar_url ?? undefined
  const isLive = (bili?.live_status ?? 0) === 1
  const accounts = vtuber.accounts.filter((a) => a.platform_uid)

  return (
    <div className="posts-panel">
      {/* VTuber 信息条 */}
      <div className="vtuber-header">
        <Avatar size={56} src={avatarSrc}>
          {vtuber.name.slice(0, 1)}
        </Avatar>
        <div className="vtuber-header-info">
          <div className="vtuber-header-name-row">
            <h2 className="vtuber-header-name">{vtuber.name}</h2>
            {isLive && (
              <Tooltip title={bili?.live_title}>
                <span className="live-tag">
                  <i className="live-dot" />
                  直播中
                </span>
              </Tooltip>
            )}
            {accounts.length > 1 && bili && (
              <Select
                size="small"
                value={bili.platform_uid}
                onChange={changeAccount}
                options={accounts.map((a) => ({
                  value: a.platform_uid,
                  label: `${a.platform} / ${a.display_name ?? a.platform_uid}`,
                }))}
              />
            )}
          </div>
          <div className="vtuber-header-meta">
            {bili?.sign ? `${bili.sign} · ` : ''}
            粉丝 {formatCount(bili?.followers_count)} · 上次抓取 {formatDateTime(bili?.last_fetched_at)}
          </div>
        </div>
        <Space size={8} wrap style={{ justifyContent: 'flex-end' }}>
          <Button icon={<ThunderboltOutlined />} loading={fetching} onClick={handleFetch}>
            抓取账号
          </Button>
          <Button icon={<ReloadOutlined />} loading={fetching} onClick={handleFetchPosts}>
            抓取帖子
          </Button>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={fetching}
            onClick={handleUpdatePosts}
          >
            更新动态
          </Button>
        </Space>
      </div>

      {/* 类型筛选 chips + 归档过滤 */}
      <div className="type-chips-row">
        <div className="type-chips">
          {chipItems.map((c) => (
            <button
              key={c.key}
              className={`type-chip${(typeFilter ?? 'all') === c.key ? ' active' : ''}`}
              onClick={() => {
                setTypeFilter(c.key === 'all' ? undefined : c.key)
                setPage(1)
              }}
            >
              {c.label} {c.count}
            </button>
          ))}
        </div>
        <Segmented
          size="small"
          value={archived}
          onChange={(v) => {
            setArchived(v as ArchivedFilter)
            setPage(1)
          }}
          options={[
            { label: '全部', value: 'all' },
            { label: '未归档', value: 'unarchived' },
            { label: '已归档', value: 'archived' },
          ]}
        />
      </div>

      {/* 帖子卡片流 */}
      {error ? (
        <Alert type="error" showIcon message="加载失败" description={error} />
      ) : loading ? (
        <div className="post-grid">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="post-card sk" aria-hidden>
              <div className="post-card-cover sk-block" />
              <div className="post-card-body">
                <div className="sk-block sk-line w60" />
                <div className="sk-block sk-line w90" />
                <div className="sk-block sk-line w40" />
              </div>
            </div>
          ))}
        </div>
      ) : posts.length === 0 ? (
        <div className="posts-placeholder">暂无帖子，点击上方「抓取帖子」或「更新动态」获取</div>
      ) : (
        <div className="post-grid">
          {posts.map((p) => (
            <PostCard key={p.id} post={p} onClick={() => setDrawerPost(p)} />
          ))}
        </div>
      )}

      {/* 分页 */}
      {total > PAGE_SIZE && !error && (
        <div className="posts-footer">
          <Pagination
            current={page}
            pageSize={PAGE_SIZE}
            total={total}
            showSizeChanger={false}
            showTotal={(t) => `共 ${t} 条`}
            onChange={(p) => setPage(p)}
          />
        </div>
      )}

      <PostDetailDrawer
        post={drawerPost}
        open={drawerPost !== null}
        onClose={() => setDrawerPost(null)}
      />
    </div>
  )
}
