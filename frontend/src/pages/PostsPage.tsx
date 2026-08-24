import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  AlignJustify,
  Calendar,
  LayoutGrid,
  Mail,
  RefreshCw,
  Search,
  Trash2,
  Zap,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { CircleAlert } from 'lucide-react'
import heroDivider from '../assets/icons/hero-divider.svg'
import { api, resolveAsset } from '../api/api'
import type { Account, Post, PostStats, VTuber } from '../api/types'
import { formatCount, postTypeLabel } from '../utils/format'
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
  const [archived] = useState<ArchivedFilter>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)

  const [drawerPost, setDrawerPost] = useState<Post | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  // 双视图：cards=展示页（默认）/ list=帖子列表页
  const [view, setView] = useState<'cards' | 'list'>('cards')
  const navigate = useNavigate()

  // 列表页筛选：搜索关键词（防抖后生效）+ 发布时间范围
  const [searchInput, setSearchInput] = useState('')
  const [searchKw, setSearchKw] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [timePopOpen, setTimePopOpen] = useState(false)
  const timeWrapRef = useRef<HTMLDivElement>(null)
  const searchTimer = useRef<number>()

  // 时间下拉：点击面板外自动关闭
  useEffect(() => {
    if (!timePopOpen) return
    const onDown = (e: MouseEvent) => {
      if (timeWrapRef.current && !timeWrapRef.current.contains(e.target as Node)) {
        setTimePopOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [timePopOpen])
  useEffect(() => {
    window.clearTimeout(searchTimer.current)
    searchTimer.current = window.setTimeout(() => setSearchKw(searchInput.trim()), 300)
    return () => window.clearTimeout(searchTimer.current)
  }, [searchInput])

  // 稳定回调：PostCard 已 memo，依赖它做浅比较
  const openPost = useCallback((p: Post) => setDrawerPost(p), [])

  // 抓取/更新任务完成（fetch-idle 边沿）→ 静默重拉统计与当前页帖子
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    const handler = () => setRefreshTick((t) => t + 1)
    window.addEventListener('ddtoolkit:fetch-idle', handler)
    return () => window.removeEventListener('ddtoolkit:fetch-idle', handler)
  }, [])

  // 加载 VTuber 与默认账号。
  // refreshTick（fetch-idle 边沿）时重拉本体，让抓取期间点开的 V 在完成
  // 后自动补齐头像/签名/粉丝数（此前仅统计和帖子刷新，头部永远停留空快照）。
  // selectedAccount 按 uid 取【新】account 对象（而非保留旧引用）——
  // 头部 bili=selectedAccount 直接读它，旧引用会背着抓取前的空快照。
  // uid 未变时仅引用变化，posts effect 因 refreshTick 同步变化只会跑一次。
  useEffect(() => {
    let cancelled = false
    api
      .getVtuber(vtuberId)
      .then((v) => {
        if (cancelled) return
        setVtuber(v)
        const accounts = v.accounts.filter((a) => a.platform_uid)
        if (accounts.length > 0) {
          setSelectedAccount((prev) =>
            prev
              ? accounts.find((a) => a.platform_uid === prev.platform_uid) ?? accounts[0]
              : accounts[0],
          )
        } else {
          setError('该 VTuber 没有可用账号')
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [vtuberId, refreshTick])

  // 统计概览（仅列表视图需要；依赖账号 key 而非对象引用——
  // fetch-idle 时 setSelectedAccount 换新对象但 key 不变，避免重复请求）
  const accountKey = selectedAccount
    ? `${selectedAccount.platform}:${selectedAccount.platform_uid}`
    : null

  useEffect(() => {
    if (!selectedAccount || view !== 'list') return
    let cancelled = false
    api
      .postStats(selectedAccount.platform, selectedAccount.platform_uid)
      .then((s) => !cancelled && setStats(s))
      .catch(() => !cancelled && setStats(null))
    return () => {
      cancelled = true
    }
  }, [accountKey, refreshTick, view])

  // 帖子列表（服务端分页 + 过滤）；AbortController：切换 VTuber/翻页时
  // 取消在途请求，防止慢响应把旧数据写回新视图
  useEffect(() => {
    if (!selectedAccount || view !== 'list') return
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
          q: searchKw || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
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
  }, [accountKey, page, typeFilter, archived, refreshTick, view, searchKw, dateFrom, dateTo])

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

  const handleDeleteVtuber = useCallback(async () => {
    if (!vtuber) return
    try {
      await api.deleteVtuber(vtuberId)
      toast.success(`已解除订阅「${vtuber.name}」`)
      window.dispatchEvent(new Event('ddtoolkit:data-changed'))
      navigate('/')
    } catch (e) {
      toast.error(`解除订阅失败: ${(e as Error).message}`)
      setConfirmDel(false)
    }
  }, [vtuber, vtuberId, navigate])

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

  // 平台粉丝展示：徽章集按每集 3 枚切分（集内横排、集间纵向间隔 10）。
  // 注意：此处位于 early return 之后，禁止使用 hook（Rules of Hooks），
  // 纯计算即可——数据量极小，无性能顾虑
  const pillSets: Account[][] = []
  for (let i = 0; i < accounts.length; i += 3) pillSets.push(accounts.slice(i, i + 3))

return (
    <div className="posts-panel">
      {/* 右栏永久背景：当前 V 头像铺底 + 渐变纱罩（后续接自定义接口），两视图常驻 */}
      {avatarSrc && (
        <div
          className="hero-backdrop"
          style={{ backgroundImage: `url(${avatarSrc})` }}
        />
      )}

      {/* 顶部工具条：贴面板顶常驻，仅视图切换光条 */}
      <div className="view-toolbar">
        <div className="glow-bar">
          <button type="button" className="view-btn off" title="日历视图 · 开发中">
            <Calendar className="size-6" />
          </button>
          <button
            type="button"
            className={`view-btn ${view === 'cards' ? 'on' : 'off'}`}
            title="展示页"
            onClick={() => setView('cards')}
          >
            <LayoutGrid className="size-6" />
          </button>
          <button
            type="button"
            className={`view-btn ${view === 'list' ? 'on' : 'off'}`}
            title="帖子列表"
            onClick={() => setView('list')}
          >
            <AlignJustify className="size-6" />
          </button>
          <button type="button" className="view-btn off" title="动态视图 · 开发中">
            <Mail className="size-6" />
          </button>
        </div>
      </div>

      <div className="view-body">

        {view === 'cards' && (
          <div className="hero-scroll">
            {/* Hero：头像 / 直播徽标 / 名字 / 签名 / 平台药丸 / 分隔饰条 / 阵营徽标 */}
            <div className="hero">
              <Avatar className="hero-avatar">
                <AvatarImage src={avatarSrc} referrerPolicy="no-referrer" />
                <AvatarFallback>{vtuber.name.slice(0, 1)}</AvatarFallback>
              </Avatar>

              {/* 直播状态：始终显示（未开播=灰点+「未开播」） */}
              <span className={`live-tag${isLive ? ' live' : ' off'}`} title={isLive ? (bili?.live_title ?? '直播中') : '未开播'}>
                <i className="live-dot" />
                <span className="truncate">{isLive ? (bili?.live_title ?? '直播中') : '未开播'}</span>
              </span>

              <div className="hero-name-block">
                <h2 className="hero-name">{vtuber.name}</h2>
                {bili?.sign && <p className="hero-sign">{bili.sign}</p>}
              </div>

              <div className="stat-sets">
                {pillSets.map((set, si) => (
                  <div className="stat-set" key={si}>
                    {set.map((a, i) => {
                      const gi = si * 3 + i
                      return (
                        <div
                          key={a.id}
                          className={`stat-pill${gi % 2 === 0 ? ' pink' : ' coral'}`}
                          title={`${a.platform} 粉丝数`}
                        >
                          <span className="pill-logo">{a.platform.slice(0, 1).toUpperCase()}</span>
                          <span className="pill-value">{formatCount(a.followers_count)}</span>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>

              <img src={heroDivider} alt="" className="hero-divider" />

              {vtuber.faction && (
                <div className="stat-sets">
                  <div className="stat-set">
                    <span className="faction-badge">
                      <span className="pill-logo">阵</span>
                      {vtuber.faction}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {view === 'list' && (
          <div className="list-scroll">
            <div className="list-inner">
        {/* 操作按钮组：置顶于帖子列表页 */}
        <div className="header-actions">
          <Button variant="outline" size="sm" disabled={fetching} onClick={handleFetch}>
            <Zap /> 抓取账号
          </Button>
          <Button variant="outline" size="sm" disabled={fetching} onClick={handleFetchPosts}>
            <RefreshCw /> 抓取帖子
          </Button>
          <Button size="sm" disabled={fetching} onClick={handleUpdatePosts}>
            <RefreshCw /> 更新动态
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-red-500 hover:text-red-500 hover:border-red-400"
            onClick={() => setConfirmDel(true)}
          >
            <Trash2 /> 解除订阅
          </Button>
        </div>

        {/* 类型筛选 chips + 搜索 / 时间范围筛选 */}
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
          <div className="chips-tools">
            <div className="search-float">
              <Search className="search-float-icon" />
              <input
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value)
                  setPage(1)
                }}
                placeholder="搜索标题/摘要"
              />
            </div>
            <div className="time-wrap" ref={timeWrapRef}>
              <button
                type="button"
                className={`time-btn${dateFrom || dateTo ? ' active' : ''}`}
                onClick={() => setTimePopOpen((o) => !o)}
              >
                <Calendar className="size-4" />
                {dateFrom || dateTo ? `${dateFrom || '…'} ~ ${dateTo || '…'}` : '时间'}
              </button>
              {timePopOpen && (
                <div className="time-pop" onMouseDown={(e) => e.stopPropagation()}>
                  <label>
                    起
                    <input
                      type="date"
                      value={dateFrom}
                      max={dateTo || undefined}
                      onChange={(e) => setDateFrom(e.target.value)}
                    />
                  </label>
                  <label>
                    止
                    <input
                      type="date"
                      value={dateTo}
                      min={dateFrom || undefined}
                      onChange={(e) => setDateTo(e.target.value)}
                    />
                  </label>
                  <div className="time-pop-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setDateFrom('')
                        setDateTo('')
                      }}
                    >
                      清除
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        setPage(1)
                        setTimePopOpen(false)
                      }}
                    >
                      应用
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
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
              <PostCard key={p.id} post={p} onOpen={openPost} />
            ))}
          </div>
        )}

        {/* 分页 */}
        {total > PAGE_SIZE && !error && (
          <PaginationLite page={page} totalPages={totalPages} onChange={setPage} />
        )}
            </div>
          </div>
        )}
      </div>

      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>解除订阅？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{vtuber.name}」的全部账号信息及其帖子记录（不可恢复）。
              确认解除订阅吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500 text-white hover:bg-red-500/90"
              onClick={handleDeleteVtuber}
            >
              确认解除订阅
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PostDetailDrawer
        post={drawerPost}
        open={drawerPost !== null}
        onClose={() => setDrawerPost(null)}
      />
    </div>
  )
}
