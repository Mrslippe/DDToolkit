import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  RefreshCw,
  Zap,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { CircleAlert } from 'lucide-react'
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

/** 成功类提示走顶栏状态胶囊（渐隐渐显），错误仍用 toast */
function pill(text: string) {
  window.dispatchEvent(new CustomEvent('ddtoolkit:pill-message', { detail: { text } }))
}

/** 通知 TopBar 立即轮询一次抓取状态（点击按钮/任务结束时即时反馈） */
function kickPoll() {
  window.dispatchEvent(new Event('ddtoolkit:kick-poll'))
}

/** 轻量分页器（服务端分页）：上一页 / 第 x / y 页 / 下一页 */
function PaginationLite({
  page,
  totalPages,
  onChange,
}: {
  page: number
  totalPages: number
  onChange: (p: number) => void
}) {
  return (
    <div className="posts-footer">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft /> 上一页
        </Button>
        <span className="min-w-20 text-center text-sm text-[var(--c-text-sub)]">
          第 {page} / {Math.max(totalPages, 1)} 页
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          下一页 <ChevronRight />
        </Button>
      </div>
    </div>
  )
}

/**
 * 帖子面板（右栏 /vtubers/:id）：
 * VTuber 信息条 + 类型筛选 chips + 归档过滤 + 帖子卡片流（服务端分页）
 * + 详情抽屉 + 抓取操作。视觉参照设计稿 Frame1672。
 */
export default function PostsPage() {
  const { id } = useParams()
  const vtuberId = Number(id)

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

  // 抓取/更新任务完成（fetch-idle 边沿）→ 静默重拉统计与当前页帖子
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    const handler = () => setRefreshTick((t) => t + 1)
    window.addEventListener('ddtoolkit:fetch-idle', handler)
    return () => window.removeEventListener('ddtoolkit:fetch-idle', handler)
  }, [])

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
  }, [selectedAccount, refreshTick])

  // 帖子列表（服务端分页 + 过滤）；AbortController：切换 VTuber/翻页时
  // 取消在途请求，防止慢响应把旧数据写回新视图
  useEffect(() => {
    if (!selectedAccount) return
    setLoading(true)
    setError(null)
    const controller = new AbortController()
    let aborted = false
    api
      .listPosts(
        selectedAccount.platform,
        selectedAccount.platform_uid,
        {
          page,
          page_size: PAGE_SIZE,
          type: typeFilter,
          is_archived: archived === 'all' ? undefined : archived === 'archived',
        },
        controller.signal,
      )
      .then((p) => {
        setPosts(p.items)
        setTotal(p.total)
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') {
          aborted = true // 已被新一次加载取代，不动任何状态
          return
        }
        setError(e.message)
      })
      .finally(() => {
        if (!aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [selectedAccount, page, typeFilter, archived, refreshTick])

  const changeAccount = (uid: string) => {
    const acc = vtuber?.accounts.find((a) => a.platform_uid === uid) ?? null
    setSelectedAccount(acc)
    setPage(1)
    setTypeFilter(undefined)
  }

  const handleFetch = useCallback(async () => {
    if (!vtuber || fetching) return
    setFetching(true)
    kickPoll() // 立即刷新胶囊 → 显示「抓取中」
    try {
      const r = await api.fetchVtuber(vtuberId)
      if (r.status === 'skipped') {
        toast.warning(r.message ?? '抓取任务正在进行中')
      } else {
        const s = r.result
        pill(`账号信息更新完成 · 成功 ${s?.success ?? 0} · 失败 ${s?.failed ?? 0}`)
      }
    } catch (e) {
      toast.error(`抓取失败: ${(e as Error).message}`)
    } finally {
      setFetching(false)
      kickPoll()
    }
  }, [vtuber, vtuberId, fetching])

  const handleFetchPosts = useCallback(async () => {
    if (!vtuber || fetching) return
    setFetching(true)
    kickPoll()
    try {
      const r = await api.fetchPostsByName(vtuber.name)
      if (r.status === 'skipped') {
        toast.warning(r.message ?? '帖子抓取正在进行中')
      } else {
        pill(
          `帖子抓取完成 · 存储 ${r.total?.stored ?? 0} · 跳过 ${r.total?.skipped ?? 0}` +
            ` · 预归档 ${r.archived_first ?? 0}`,
        )
      }
    } catch (e) {
      toast.error(`帖子抓取失败: ${(e as Error).message}`)
    } finally {
      setFetching(false)
      kickPoll()
    }
  }, [vtuber, fetching])

  const handleUpdatePosts = useCallback(async () => {
    if (!vtuber || fetching) return
    setFetching(true)
    kickPoll()
    try {
      const r = await api.updateUnarchivedPosts(vtuber.name)
      if (r.status === 'skipped') {
        toast.warning(r.message ?? '更新任务正在进行中')
      } else {
        const incremental = r.details?.some((d) => d.stopped_early) ? ' · 增量模式' : ''
        pill(
          `动态更新完成 · 新增 ${r.total?.stored ?? 0}` +
            ` · 跳过 ${r.total?.skipped ?? 0}${incremental}`,
        )
      }
    } catch (e) {
      toast.error(`更新失败: ${(e as Error).message}`)
    } finally {
      setFetching(false)
      kickPoll()
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

  const totalPages = Math.ceil(total / PAGE_SIZE)

  // 注意：所有 Hook 必须在此提前返回之前执行完（Rules of Hooks）
  if (!vtuber && !error) {
    return (
      <div className="posts-panel">
        <div className="posts-placeholder">
          <Loader2 className="mr-2 inline size-4 animate-spin align-[-2px] text-primary" />
          正在加载 VTuber 信息…
        </div>
      </div>
    )
  }

  if (!vtuber) {
    return (
      <div className="posts-panel">
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>无法加载</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
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
        <Avatar className="size-14">
          <AvatarImage src={avatarSrc} referrerPolicy="no-referrer" />
          <AvatarFallback>{vtuber.name.slice(0, 1)}</AvatarFallback>
        </Avatar>
        <div className="vtuber-header-info">
          <div className="vtuber-header-name-row">
            <h2 className="vtuber-header-name">{vtuber.name}</h2>
            {isLive && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="live-tag">
                    <i className="live-dot" />
                    直播中
                  </span>
                </TooltipTrigger>
                <TooltipContent>{bili?.live_title}</TooltipContent>
              </Tooltip>
            )}
            {accounts.length > 1 && bili && (
              <Select value={bili.platform_uid} onValueChange={changeAccount}>
                <SelectTrigger size="sm" className="w-auto">
                  <SelectValue placeholder="选择账号" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.platform_uid}>
                      {a.platform} / {a.display_name ?? a.platform_uid}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="vtuber-header-meta">
            {bili?.sign ? `${bili.sign} · ` : ''}
            粉丝 {formatCount(bili?.followers_count)} · 上次抓取{' '}
            {formatDateTime(bili?.last_fetched_at)}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" disabled={fetching} onClick={handleFetch}>
            <Zap /> 抓取账号
          </Button>
          <Button variant="outline" size="sm" disabled={fetching} onClick={handleFetchPosts}>
            <RefreshCw /> 抓取帖子
          </Button>
          <Button size="sm" disabled={fetching} onClick={handleUpdatePosts}>
            <RefreshCw /> 更新动态
          </Button>
        </div>
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
        <ToggleGroup
          type="single"
          size="sm"
          value={archived}
          onValueChange={(v) => {
            if (!v) return
            setArchived(v as ArchivedFilter)
            setPage(1)
          }}
        >
          <ToggleGroupItem value="all">全部</ToggleGroupItem>
          <ToggleGroupItem value="unarchived">未归档</ToggleGroupItem>
          <ToggleGroupItem value="archived">已归档</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* 帖子卡片流：统一无闪动——重取保留旧内容降透明；空列表内嵌小 spinner，
          任何状态切换都不发生整屏布局替换 */}
      {error ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : posts.length === 0 ? (
        <div className="posts-placeholder">
          {loading && (
            <Loader2 className="mr-2 inline size-4 animate-spin align-[-2px] text-primary" />
          )}
          {loading ? '正在加载帖子…' : '暂无帖子，点击上方「抓取帖子」或「更新动态」获取'}
        </div>
      ) : (
        <div className={`post-grid${loading ? ' is-refetching' : ''}`}>
          {posts.map((p) => (
            <PostCard key={p.id} post={p} onClick={() => setDrawerPost(p)} />
          ))}
        </div>
      )}

      {/* 分页 */}
      {total > PAGE_SIZE && !error && (
        <PaginationLite page={page} totalPages={totalPages} onChange={setPage} />
      )}

      <PostDetailDrawer
        post={drawerPost}
        open={drawerPost !== null}
        onClose={() => setDrawerPost(null)}
      />
    </div>
  )
}
