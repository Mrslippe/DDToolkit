import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  AlignJustify,
  Calendar,
  ImagePlus,
  LayoutGrid,
  Mail,
  RefreshCw,
  Search,
  Trash2,
  UserPlus,
  Zap,
  ChevronsLeft,
  Ghost,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CircleAlert } from 'lucide-react'
import heroDivider from '../assets/icons/hero-divider.svg'
import pillBilibili from '../assets/pills/bilibili.png'
import pillWeibo from '../assets/pills/weibo.png'
import { api, resolveAsset } from '../api/api'
import { useFetchBusy } from '../fetchBusy'
import type { Account, Post, PostStats, VTuber } from '../api/types'
import { formatCount } from '../utils/format'
import PostCard from '../components/PostCard'
import PostDetailDrawer from '../components/PostDetailDrawer'
import './../styles/posts.css'

const PAGE_SIZE = 20

/** 平台药丸图像底：按平台映射 docs/design/pills 资产；未知平台回退粉/珊瑚色底 */
const PILL_BG: Record<string, string> = {
  bilibili: pillBilibili,
  weibo: pillWeibo,
}

/** 场景退场时长（ms）：与 layout.css `.scene-exit` 的 0.2s 保持同步 */
const EXIT_MS = 200

/** 筛选行分组 chip：key 为逗号合并类型（后端 type 参数支持逗号分隔多型 in 过滤）。
 *  高频型两两归组（投稿/图文）压缩 chips 宽度，保证不把右侧搜索栏挤到下一行；
 *  低频型保持单型 chip。计数求和、零计数组不显示。 */
const TYPE_GROUPS: { key: string; label: string; types: string[] }[] = [
  { key: 'video,video_dynamic', label: '投稿', types: ['video', 'video_dynamic'] },
  { key: 'image,text', label: '图文', types: ['image', 'text'] },
  { key: 'repost', label: '转发', types: ['repost'] },
  { key: 'article', label: '专栏', types: ['article'] },
  { key: 'music', label: '音乐', types: ['music'] },
  { key: 'live', label: '直播', types: ['live'] },
]

/** 归档过滤：all=全部（含已归档） unarchived=仅未归档 archived=仅已归档 */
type ArchivedFilter = 'all' | 'unarchived' | 'archived'

/** 平台显示名（账号切换器/添加账号用） */
const PLATFORM_LABEL: Record<string, string> = { bilibili: 'B站', weibo: '微博' }

/** 成功类提示走顶栏状态胶囊（渐隐渐显），错误仍用 toast */
function pill(text: string) {
  window.dispatchEvent(new CustomEvent('ddtoolkit:pill-message', { detail: { text } }))
}

/** 通知 TopBar 立即轮询一次抓取状态（点击按钮/任务结束时即时反馈） */
function kickPoll() {
  window.dispatchEvent(new Event('ddtoolkit:kick-poll'))
}

/**
 * 帖子面板（右栏 /vtubers/:id）：
 * VTuber 信息条 + 类型筛选 chips + 帖子卡片流（无限懒加载滚动）
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
  // 无限滚动：追加期间的独立 loading 位（区别于整表替换的 loading）；
  // 追加失败不清网格，仅置 loadMoreError 显示尾条重试
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<string>()
  const [archived] = useState<ArchivedFilter>('all')
  // 墓碑筛选（v0.5.1）：仅显示已删除帖子（独立 toggle，与归档/类型正交）
  const [deletedOnly, setDeletedOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)

  const [drawerPost, setDrawerPost] = useState<Post | null>(null)
  // 开关分离：关闭只翻 flag 不清 post——Sheet 保持挂载走 radix 退场动画，
  // 抽屉末帧仍渲染最后一次的帖子（PostDetailDrawer 内部 lastPostRef）
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [fetchChoice, setFetchChoice] = useState(false)
  // 添加账号（多平台订阅：bilibili / weibo）
  const [addAccountOpen, setAddAccountOpen] = useState(false)
  const [newAccPlatform, setNewAccPlatform] = useState('bilibili')
  const [newAccUid, setNewAccUid] = useState('')
  const [newAccName, setNewAccName] = useState('')
  const [addingAccount, setAddingAccount] = useState(false)
  const fetchBusy = useFetchBusy()
  const busyTip = '已有抓取任务进行中，请稍后再试'
  // 双视图：cards=展示页（默认）/ list=帖子列表页
  const [view, setView] = useState<'cards' | 'list'>('cards')
  // 列表页右侧操作钮组：收起态只露 [展开钮][更新动态]，展开向左滑出全部四钮
  const [actionsOpen, setActionsOpen] = useState(false)
  const navigate = useNavigate()

  // 列表页筛选：搜索关键词（防抖后生效）+ 发布时间范围
  const [searchInput, setSearchInput] = useState('')
  const [searchKw, setSearchKw] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [timePopOpen, setTimePopOpen] = useState(false)
  const timeWrapRef = useRef<HTMLDivElement>(null)
  /** 最近一次非空头像：切 V 间隙背景纱罩沿用，不闪空 */
  const lastAvatarRef = useRef<string | undefined>(undefined)
  const searchTimer = useRef<number>()
  /** 自定义背景上传：隐藏 file input + 上传中抑制 */
  const bgFileRef = useRef<HTMLInputElement>(null)
  const [bgUploading, setBgUploading] = useState(false)
  /** 背景工具浮片：悬停工具行显示，移出 900ms 后渐隐（与侧栏悬浮滚动条同拍） */
  const [bgToolsVisible, setBgToolsVisible] = useState(false)
  const bgHideTimer = useRef<number>()
  const showBgTools = () => {
    window.clearTimeout(bgHideTimer.current)
    setBgToolsVisible(true)
  }
  const scheduleBgHide = () => {
    window.clearTimeout(bgHideTimer.current)
    bgHideTimer.current = window.setTimeout(() => setBgToolsVisible(false), 900)
  }
  useEffect(() => () => window.clearTimeout(bgHideTimer.current), [])
  const revealBgTools = () => {
    showBgTools()
    scheduleBgHide()
  }

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
  const openPost = useCallback((p: Post) => {
    setDrawerPost(p)
    setDrawerOpen(true)
  }, [])

  // 抓取/更新任务完成（fetch-idle 边沿）→ 重置回第一页（无限滚动选型 A）：
  // setPage(1) 保证重拉走「替换」而非「追加」，新内容从顶部呈现
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    const handler = () => {
      setPage(1)
      setRefreshTick((t) => t + 1)
    }
    window.addEventListener('ddtoolkit:fetch-idle', handler)
    return () => window.removeEventListener('ddtoolkit:fetch-idle', handler)
  }, [])

  // ── 场景切换：预取门控 + 原子提交（退出 → 进入，无缓冲占位相）──
  // 账号目标变化：并行预取新 V 三件套（信息/第1页帖子/统计），旧内容冻结可见；
  // 数据就绪才启动 fall-out，EXIT_MS 后一次性应用预取数据完成切换——
  // 全程无「正在加载」闪帧。仅视图变化无数据依赖，立即退场。
  // 快速连点：中止旧预取、回退退场（旧内容回到可见），新目标就绪后重来。
  const [scene, setScene] = useState<{
    acc: number
    view: 'cards' | 'list'
    exiting: boolean
  }>({ acc: vtuberId, view, exiting: false })
  const [prefetchTick, bumpPrefetchReady] = useState(0)
  const prefetchRef = useRef<{
    acc: number
    controller: AbortController
    done: boolean
    failed?: string
    vtuber?: VTuber
    account?: Account | null
    posts?: Post[]
    total?: number
    stats?: PostStats | null
  } | null>(null)
  const seededPostsKeyRef = useRef<string | null>(null)
  const vtuberLoadedRef = useRef('')
  // 提交时取最新筛选值（定时器闭包可能过期）
  const filterRef = useRef({ refreshTick, typeFilter, archived, deletedOnly, searchKw, dateFrom, dateTo })
  filterRef.current = { refreshTick, typeFilter, archived, deletedOnly, searchKw, dateFrom, dateTo }

  const startPrefetch = (acc: number, targetView: 'cards' | 'list') => {
    const pf = prefetchRef.current
    if (pf && pf.acc === acc) return // 同目标：在途或已就绪，复用
    const controller = new AbortController()
    const entry: NonNullable<typeof prefetchRef.current> = { acc, controller, done: false }
    prefetchRef.current = entry
    const alive = () => prefetchRef.current === entry
    const finish = () => {
      if (!alive()) return
      entry.done = true
      bumpPrefetchReady((x) => x + 1)
    }
    api
      .getVtuber(acc)
      .then((v) => {
        if (!alive()) return
        entry.vtuber = v
        const accounts = v.accounts.filter((a) => a.platform_uid)
        entry.account = accounts[0] ?? null
        const acc0 = entry.account
        if (!acc0) {
          finish()
          return
        }
        const f = filterRef.current
        const jobs: Promise<unknown>[] = []
        if (targetView === 'list') {
          jobs.push(
            api
              .listPosts(
                acc0.platform,
                acc0.platform_uid,
                {
                  page: 1,
                  page_size: PAGE_SIZE,
                  type: f.typeFilter,
                  is_archived: f.archived === 'all' ? undefined : f.archived === 'archived',
                  is_deleted: f.deletedOnly || undefined,
                  q: f.searchKw || undefined,
                  date_from: f.dateFrom || undefined,
                  date_to: f.dateTo || undefined,
                },
                controller.signal,
              )
              .then((p) => {
                if (alive()) {
                  entry.posts = p.items
                  entry.total = p.total
                }
              }),
            api
              .postStats(acc0.platform, acc0.platform_uid)
              .then((s) => {
                if (alive()) entry.stats = s
              })
              .catch(() => {}),
          )
        }
        Promise.all(jobs).then(finish, finish)
      })
      .catch((e: Error) => {
        if (!alive()) return
        entry.failed = e.message || '加载失败'
        finish()
      })
  }

  useEffect(() => {
    const accChanged = scene.acc !== vtuberId
    const viewChanged = scene.view !== view
    if (!accChanged && !viewChanged && !scene.exiting) return

    // 仅视图变化：无数据依赖，立即退场 → 提交
    if (!accChanged) {
      setScene((s) => (s.exiting ? s : { ...s, exiting: true }))
      const t = setTimeout(() => {
        prefetchRef.current = null
        setScene({ acc: vtuberId, view, exiting: false })
      }, EXIT_MS)
      return () => clearTimeout(t)
    }

    // 账号变化：预取门控
    startPrefetch(vtuberId, view)
    const pf = prefetchRef.current
    const ready = !!pf && pf.acc === vtuberId && pf.done
    if (!ready) {
      // 未就绪：旧内容保持可见冻结（若在退场中先回退），等预取完成信号重入门控
      setScene((s) => (s.exiting ? { ...s, exiting: false } : s))
      return
    }
    setScene((s) => (s.exiting ? s : { ...s, exiting: true }))
    const t = setTimeout(() => {
      const entry = prefetchRef.current
      const f = filterRef.current
      if (entry && entry.acc === vtuberId && entry.vtuber && !entry.failed) {
        // 原子提交：一次性应用预取数据，退出与进入之间无任何占位帧
        setVtuber(entry.vtuber)
        setSelectedAccount(entry.account ?? null)
        setStats(entry.stats ?? null)
        setError(null)
        setPage(1)
        if (view === 'list' && entry.account && entry.posts) {
          setPosts(entry.posts)
          setTotal(entry.total ?? 0)
          seededPostsKeyRef.current = `${entry.account.platform}:${entry.account.platform_uid}:${f.refreshTick}:1:${f.typeFilter ?? ''}:${f.archived}:${f.deletedOnly ? 1 : 0}:${f.searchKw}:${f.dateFrom}:${f.dateTo}`
          setLoading(false)
        } else {
          // cards 目标不预取帖子；或 list 但帖子未就绪 → 交回 posts effect 正常加载
          setPosts([])
          setTotal(0)
          setLoading(view === 'list')
        }
        vtuberLoadedRef.current = `${vtuberId}:${f.refreshTick}`
      } else {
        // 预取失败：清空走错误占位（body 内联显示）
        setPage(1)
        setPosts([])
        setTotal(0)
        setStats(null)
        setVtuber(null)
        setSelectedAccount(null)
        setError(entry?.failed ?? '加载失败')
        setLoading(false)
      }
      prefetchRef.current = null
      setScene({ acc: vtuberId, view, exiting: false })
    }, EXIT_MS)
    return () => clearTimeout(t)
  }, [vtuberId, view, scene.acc, scene.view, scene.exiting, prefetchTick])

  // 加载 VTuber 与默认账号。
  // refreshTick（fetch-idle 边沿）时重拉本体，让抓取期间点开的 V 在完成
  // 后自动补齐头像/签名/粉丝数（此前仅统计和帖子刷新，头部永远停留空快照）。
  // selectedAccount 按 uid 取【新】account 对象（而非保留旧引用）——
  // 头部 bili=selectedAccount 直接读它，旧引用会背着抓取前的空快照。
  // uid 未变时仅引用变化，posts effect 因 refreshTick 同步变化只会跑一次。
  // 场景提交已播种（vtuberLoadedRef）时跳过，避免预取后的重复请求。
  // ★ 守卫记账在【成功落地】时才写入：StrictMode 双挂载会取消第一次请求，
  //   若启动即记账，重挂后会被守卫跳过 → 首开永远卡「正在加载」（已踩坑）。
  useEffect(() => {
    const loadKey = `${scene.acc}:${refreshTick}`
    if (vtuberLoadedRef.current === loadKey) return
    let cancelled = false
    api
      .getVtuber(scene.acc)
      .then((v) => {
        if (cancelled) return
        vtuberLoadedRef.current = loadKey
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
      .catch((e: Error) => !cancelled && setError(e.message)) // 失败不记账：deps 再变可重试
    return () => {
      cancelled = true
    }
  }, [scene.acc, refreshTick])

  // 统计概览（仅列表视图需要；依赖账号 key 而非对象引用——
  // fetch-idle 时 setSelectedAccount 换新对象但 key 不变，避免重复请求）
  const accountKey = selectedAccount
    ? `${selectedAccount.platform}:${selectedAccount.platform_uid}`
    : null

  useEffect(() => {
    if (!selectedAccount || scene.view !== 'list') return
    let cancelled = false
    api
      .postStats(selectedAccount.platform, selectedAccount.platform_uid)
      .then((s) => !cancelled && setStats(s))
      .catch(() => !cancelled && setStats(null))
    return () => {
      cancelled = true
    }
  }, [accountKey, refreshTick, scene.view])

  // 帖子列表（无限懒加载 + 过滤）；AbortController：切换 VTuber/刷新筛选时
  // 取消在途请求，防止慢响应把旧数据写回新视图。
  // 依赖用场景值 scene.view/账号：提交前不发新请求，退场期间旧内容冻结。
  // 模式分流：page===1 → 替换（整表替换 + is-refetching 变暗）；page>1 → 追加
  // （按 id 去重尾部拼接，不清旧列表、不触发重挂动画）。
  // 播种守卫：场景提交已用预取数据填充时消费一次跳过重拉（防 is-refetching 变暗闪动）
  useEffect(() => {
    if (!selectedAccount || scene.view !== 'list') return
    const requestKey = `${accountKey}:${refreshTick}:${page}:${typeFilter ?? ''}:${archived}:${deletedOnly ? 1 : 0}:${searchKw}:${dateFrom}:${dateTo}`
    if (seededPostsKeyRef.current === requestKey) {
      seededPostsKeyRef.current = null
      setLoading(false)
      return
    }
    if (page === 1) setLoading(true)
    else setLoadingMore(true)
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
          is_deleted: deletedOnly || undefined,
          q: searchKw || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        },
        controller.signal,
      )
      .then((p) => {
        setTotal(p.total)
        setLoadMoreError(null)
        if (page === 1) {
          setPosts(p.items)
        } else {
          // 追加去重：并发/重复触发时防止同帖重复渲染
          setPosts((prev) => {
            const seen = new Set(prev.map((x) => x.id))
            return [...prev, ...p.items.filter((n) => !seen.has(n.id))]
          })
        }
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') {
          aborted = true // 已被新一次加载取代，不动任何状态
          return
        }
        // 追加失败保留已载网格，仅尾条提示 + 手动重试（IO 已因该态停止自动续载）
        if (page === 1) setError(e.message)
        else setLoadMoreError(e.message)
      })
      .finally(() => {
        if (!aborted) {
          setLoading(false)
          setLoadingMore(false)
        }
      })
    return () => controller.abort()
  }, [accountKey, page, typeFilter, archived, deletedOnly, refreshTick, scene.view, searchKw, dateFrom, dateTo])

  // 无限滚动：哨兵进入视口（提前 600px 预载）且可加载 → 追加下一页。
  // 观察者在加载/筛选变化时重建；追加完成后自动续载（连续滚到底持续填充）
  const listScrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const hasMore = posts.length < total
  useEffect(() => {
    if (scene.view !== 'list' || !hasMore || loading || loadingMore || error || loadMoreError) return
    const root = listScrollRef.current
    const el = sentinelRef.current
    if (!root || !el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setPage((p) => p + 1)
        }
      },
      { root, rootMargin: '600px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [scene.view, hasMore, loading, loadingMore, error, loadMoreError, accountKey, typeFilter, archived, deletedOnly, searchKw, dateFrom, dateTo])

  const handleFetch = useCallback(async () => {
    if (!vtuber || fetching) return
    setFetching(true)
    kickPoll() // 立即刷新胶囊 → 显示「抓取中」
    try {
      const r = await api.fetchVtuber(scene.acc)
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
  }, [vtuber, scene.acc, fetching])

  const handleFetchPosts = useCallback(async () => {
    if (!vtuber || fetching) return
    setFetching(true)
    kickPoll()
    try {
      const r = await api.fetchPostsByName(vtuber.name, 2, 3, false, bili?.platform ?? 'bilibili')
      if (r.status === 'skipped') {
        toast.warning(r.message ?? '帖子抓取正在进行中')
      } else if (r.rate_limited) {
        let tip = '部分内容未抓全'
        if (r.video_missing) tip += `（视频可能缺 ${r.video_missing}）`
        toast.warning(
          `帖子抓取完成（触发风控，${tip}）· 存储 ${r.total?.stored ?? 0} · 跳过 ${r.total?.skipped ?? 0}`,
        )
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

  const handleFetchAllPosts = useCallback(async () => {
    if (!vtuber || fetching) return
    setFetchChoice(false)
    setFetching(true)
    kickPoll()
    try {
      const r = await api.fetchPostsByName(vtuber.name, -1, -1, true, bili?.platform ?? 'bilibili')
      if (r.status === 'skipped') {
        toast.warning(r.message ?? '帖子抓取正在进行中')
      } else {
        toast.success('全量抓取已开始（后台执行，进度见顶栏）')
      }
    } catch (e) {
      toast.error(`全量抓取失败: ${(e as Error).message}`)
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
      } else if (r.rate_limited) {
        toast.warning(
          `动态更新完成（触发风控，部分内容未抓全）· 新增 ${r.total?.stored ?? 0} · 跳过 ${r.total?.skipped ?? 0}`,
        )
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
      await api.deleteVtuber(scene.acc)
      toast.success(`已解除订阅「${vtuber.name}」`)
      window.dispatchEvent(new Event('ddtoolkit:data-changed'))
      navigate('/')
    } catch (e) {
      toast.error(`解除订阅失败: ${(e as Error).message}`)
      setConfirmDel(false)
    }
  }, [vtuber, scene.acc, navigate])

  // 添加平台账号（多平台订阅：同一 V 可挂 bilibili / weibo 等多个账号）
  const handleAddAccount = useCallback(async () => {
    const uid = newAccUid.trim()
    if (!vtuber || !uid || addingAccount) return
    setAddingAccount(true)
    try {
      await api.addAccount(vtuber.id, {
        platform: newAccPlatform,
        platform_uid: uid,
        ...(newAccName.trim() ? { display_name: newAccName.trim() } : {}),
      })
      toast.success('账号已添加，正在后台抓取账号信息')
      kickPoll()
      // 立即刷新 V 本体 → 新账号药丸出现；选中新账号切换帖子目标
      const fresh = await api.getVtuber(vtuber.id)
      setVtuber(fresh)
      const acc = fresh.accounts.find(
        (a) => a.platform === newAccPlatform && a.platform_uid === uid,
      )
      if (acc) setSelectedAccount(acc)
      // 后台补抓该 V 账号信息（新平台走平台框架分发）；忙时跳过
      api.fetchVtuber(vtuber.id).catch(() => {})
      setAddAccountOpen(false)
      setNewAccUid('')
      setNewAccName('')
    } catch (e) {
      toast.error(`添加账号失败：${(e as Error).message}`)
    } finally {
      setAddingAccount(false)
    }
  }, [vtuber, newAccPlatform, newAccUid, newAccName, addingAccount])

  // 类型筛选 chips：全部 N / 投稿 N / 图文 N / 转发 N ...（计数来自统计概览，
  // 分组求和、零计数组不显示；key 为逗号合并类型直传后端）
  const chipItems = useMemo(() => {
    const counts = stats?.by_type ?? {}
    return [
      { key: 'all', label: '全部', count: stats?.total ?? total },
      ...TYPE_GROUPS.map((g) => ({
        key: g.key,
        label: g.label,
        count: g.types.reduce((sum, t) => sum + (counts[t] ?? 0), 0),
      })).filter((g) => g.count > 0),
    ]
  }, [stats, total])

  // 无限滚动：hasMore 由累计长度与总数比较派生（第 1 页后 posts.length < total）

  // 壳层常驻：加载/错误态内联到 view-body（见渲染段），工具条与 glow-bar
  // 不随切 V 卸载重挂——消除切换闪动
  const bili = selectedAccount
  // 头像 / 右栏背景以 VTuber 本体为准（稳定，不随账号切换变化）；
  // 帖子流 / 直播 / 签名仍跟随所选账户
  // VTuber.avatar 未入库，从 accounts 派生稳定源（优先 bilibili，回退首个）
  const stableAvatar =
    resolveAsset(vtuber?.accounts.find((a) => a.platform === 'bilibili')?.avatar_path) ??
    resolveAsset(vtuber?.accounts[0]?.avatar_path) ??
    vtuber?.accounts.find((a) => a.platform === 'bilibili')?.avatar_url ??
    vtuber?.accounts[0]?.avatar_url
  const avatarSrc = vtuber?.avatar ?? stableAvatar ?? undefined
  if (avatarSrc) lastAvatarRef.current = avatarSrc
  // 自定义背景优先（全图清晰显示），否则头像铺底回退链
  const customBg = vtuber?.background_path
    ? resolveAsset(vtuber.background_path)
    : undefined
  const backdropSrc = customBg ?? avatarSrc ?? lastAvatarRef.current

  // 背景上传/清除（走卡片页工具行浮片钮；成功后直接 setVtuber 即时生效）
  const handleBgFile = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0]
    ev.target.value = ''
    if (!file || !vtuber || bgUploading) return
    setBgUploading(true)
    try {
      const updated = await api.uploadBackground(scene.acc, file)
      setVtuber(updated)
      pill('背景已更新')
      revealBgTools() // 让 .on 态变化被看到，再延时隐藏
    } catch (e) {
      toast.error(`背景上传失败: ${(e as Error).message}`)
    } finally {
      setBgUploading(false)
    }
  }
  // 直播徽标只读 B 站账号：直播状态仅存在于 bilibili，且属 VTuber 整体事实——
  // 不跟随列表页所选账号。否则在列表里切到微博再回卡片页，徽标会从
  // 「直播中」误变「未开播」（视图间状态联动，2026-09-03 反馈）。
  const liveAcc =
    vtuber?.accounts.find((a) => a.platform === 'bilibili' && a.platform_uid) ?? selectedAccount
  const isLive = (liveAcc?.live_status ?? 0) === 1
  const accounts = vtuber ? vtuber.accounts.filter((a) => a.platform_uid) : []

  // 平台粉丝展示：徽章集按每集 3 枚切分（集内横排、集间纵向间隔 10）。
  // 纯计算，vtuber 为 null 的加载/错误态不渲染对应分支
  const pillSets: Account[][] = []
  for (let i = 0; i < accounts.length; i += 3) pillSets.push(accounts.slice(i, i + 3))

return (
    <div className="posts-panel">
      {/* 右栏永久背景：自定义背景(custom 全图清晰) 优先，否则头像铺底 + 渐变纱罩；
          key=背景 src → 换装淡入不瞬跳 */}
      {backdropSrc && (
        <div
          key={backdropSrc}
          className={`hero-backdrop${customBg ? ' custom' : ''}`}
          style={{ backgroundImage: `url(${backdropSrc})` }}
        />
      )}

      {/* 顶部工具条：贴面板顶常驻，仅视图切换光条；卡片页右上角挂背景工具组 */}
      <div className="view-toolbar" onMouseEnter={showBgTools} onMouseLeave={scheduleBgHide}>
        {scene.view === 'cards' && vtuber && (
          <div className={`bg-tools${bgToolsVisible ? ' on' : ''}`}>
            <input
              ref={bgFileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleBgFile}
            />
            <button
              type="button"
              className={`float-pill float-pill--md float-pill--icon bg-set${customBg ? ' on' : ''}`}
              title={customBg ? '更换背景图' : '设置自定义背景'}
              disabled={bgUploading}
              onClick={() => bgFileRef.current?.click()}
            >
              <ImagePlus className="size-5" />
            </button>
          </div>
        )}
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

      {/* 场景容器：key=账号|视图 → 提交即整体重挂播放入场（scene-in），
          退场期挂 scene-exit 整块 fall-out；工具条在块外常驻，高亮即时响应。
          加载/错误态内联于此（壳层常驻，glow-bar 不随切 V 卸载） */}
      <div
        key={`${scene.acc}|${scene.view}`}
        className={`view-body${scene.exiting ? ' scene-exit' : ''}`}
      >

        {!vtuber && !error && (
          <div className="posts-placeholder">
            <Loader2 className="mr-2 inline size-4 animate-spin align-[-2px] text-primary" />
            正在加载 VTuber 信息…
          </div>
        )}
        {!vtuber && error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>无法加载</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* 操作按钮行（仅列表视图；卡片页纯展示无此行）：行首账号切换器 + 右侧可收起
            操作组——收起态 [展开钮][更新动态]，展开向左滑出 [抓取账号][抓取帖子][添加账号]
            [解除订阅]，展开钮被挤至最左并旋转为收起钮。 */}
        {vtuber && scene.view === 'list' && (
          <div className="header-actions">
            <div className="account-switch">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`acc-switch-btn${selectedAccount?.id === a.id ? ' on' : ''}`}
                  title={`${a.platform} ${a.platform_uid}`}
                  onClick={() => {
                    setSelectedAccount(a)
                    setPage(1)
                  }}
                >
                  <span className="acc-switch-platform">{PLATFORM_LABEL[a.platform] ?? a.platform}</span>
                  <span className="acc-switch-name">{a.display_name || a.platform_uid}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`float-pill float-pill--md float-pill--icon actions-toggle${actionsOpen ? ' open' : ''}`}
              title={actionsOpen ? '收起操作' : '展开操作'}
              aria-expanded={actionsOpen}
              onClick={() => setActionsOpen((v) => !v)}
            >
              <ChevronsLeft className="size-4" />
            </button>
            <div className={`actions-extra${actionsOpen ? ' open' : ''}`}>
              <button
                type="button"
                className="float-pill float-pill--md float-pill--text"
                disabled={fetching || fetchBusy}
                title={busyTip}
                onClick={handleFetch}
              >
                <Zap className="size-4" /> 抓取账号
              </button>
              <button
                type="button"
                className="float-pill float-pill--md float-pill--text"
                disabled={fetching || fetchBusy}
                title={busyTip}
                onClick={() => setFetchChoice(true)}
              >
                <RefreshCw className="size-4" /> 抓取帖子
              </button>
              <button
                type="button"
                className="float-pill float-pill--md float-pill--text"
                onClick={() => setAddAccountOpen(true)}
              >
                <UserPlus className="size-4" /> 添加账号
              </button>
              <button
                type="button"
                className="float-pill float-pill--md float-pill--text float-pill--danger"
                onClick={() => setConfirmDel(true)}
              >
                <Trash2 className="size-4" /> 解除订阅
              </button>
            </div>
            <button
              type="button"
              className="float-pill float-pill--md float-pill--text on"
              disabled={fetching || fetchBusy}
              title={busyTip}
              onClick={handleUpdatePosts}
            >
              <RefreshCw className="size-4" /> 更新动态
            </button>
          </div>
        )}

        {vtuber && scene.view === 'cards' && (
          <div className="hero-scroll">
            {/* Hero：头像 / 直播徽标 / 名字 / 签名 / 平台药丸 / 分隔饰条 / 阵营徽标 */}
            <div className="hero">
              <Avatar className="hero-avatar">
                <AvatarImage src={avatarSrc} referrerPolicy="no-referrer" />
                <AvatarFallback>{vtuber.name.slice(0, 1)}</AvatarFallback>
              </Avatar>

              {/* 直播状态：始终显示（未开播=灰点+「未开播」） */}
              <span className={`live-tag${isLive ? ' live' : ' off'}`} title={isLive ? (liveAcc?.live_title ?? '直播中') : '未开播'}>
                <i className="live-dot" />
                <span className="truncate">{isLive ? (liveAcc?.live_title ?? '直播中') : '未开播'}</span>
              </span>

              <div className="hero-name-block">
                <h2 className="hero-name">{vtuber.name}</h2>
                {bili?.sign && <p className="hero-sign">{bili.sign}</p>}
              </div>

              {/* 平台药丸：切 V 时依次滑入（key=accountKey 触发重播） */}
              <div className="stat-sets" key={accountKey}>
                {pillSets.map((set, si) => (
                  <div className="stat-set anim-rise" style={{ '--rise-i': si } as React.CSSProperties} key={si}>
                    {set.map((a, i) => {
                      const gi = si * 3 + i
                      return (
                        <div
                          key={a.id}
                          className={`stat-pill${PILL_BG[a.platform] ? ' image' : gi % 2 === 0 ? ' pink' : ' coral'}`}
                          style={PILL_BG[a.platform] ? { backgroundImage: `url(${PILL_BG[a.platform]})` } : undefined}
                          title={`${a.platform} 粉丝数`}
                        >
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

        {scene.view === 'list' && (
          <>
            {/* 筛选条固定顶（提取出滚动区）：分类胶囊 + 搜索 / 时间筛选永不下滚。
                不随 .list-scroll 滚动，天然充当操作钮行与帖子流之间的常驻分隔 */}
            <div className="chips-bar">
              <div className="chips-bar-inner">
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
                    <button
                      type="button"
                      className={`float-pill float-pill--md del-btn${deletedOnly ? ' on' : ''}`}
                      title="仅显示已删除的帖子（墓碑，v0.5.1）"
                      onClick={() => {
                        setDeletedOnly((d) => !d)
                        setPage(1)
                      }}
                    >
                      <Ghost className="size-4" />
                      <span className="del-btn-label">已删 {stats?.deleted ?? 0}</span>
                    </button>
                    <div className="search-float">
                      <Search className="search-float-icon" />
                      <input
                        value={searchInput}
                        onChange={(e) => {
                          setSearchInput(e.target.value)
                          setPage(1)
                        }}
                        placeholder="搜索标题 / 摘要 / 正文"
                        title="标题、摘要（前 200 字）与正文全文（P2）"
                      />
                    </div>
                    <div className="time-wrap" ref={timeWrapRef}>
                      <button
                        type="button"
                        className={`float-pill float-pill--md time-btn${dateFrom || dateTo ? ' on' : ''}`}
                        onClick={() => setTimePopOpen((o) => !o)}
                      >
                        <Calendar className="size-4" />
                        <span className="time-btn-label">
                          {dateFrom || dateTo ? `${dateFrom || '…'} ~ ${dateTo || '…'}` : '时间'}
                        </span>
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
              </div>
            </div>

            {/* 帖子无限滚动区：grid 不再按筛选指纹重挂（2026-09-04）——
                筛选切换走 is-refetching 原位替换，入场动画只在新卡片挂载时播放 */}
            <div className="list-scroll" ref={listScrollRef}>
              <div className="list-inner">
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
                    {posts.map((p, i) => (
                      <PostCard key={p.id} post={p} index={i} onOpen={openPost} />
                    ))}
                  </div>
                )}

                {/* 无限滚动尾巴：哨兵驱动 IO 预载下一页；加载中/到底标记 */}
                {!error && posts.length > 0 && (
                  <>
                    <div ref={sentinelRef} className="load-sentinel" />
                    {loadingMore && (
                      <div className="load-more-tip">
                        <Loader2 className="mr-2 inline size-4 animate-spin align-[-2px] text-primary" />{' '}
                        加载中…
                      </div>
                    )}
                    {loadMoreError && (
                      <div className="load-more-tip load-more-error">
                        <span>加载失败，</span>
                        <button type="button" onClick={() => setLoadMoreError(null)}>
                          重试
                        </button>
                      </div>
                    )}
                    {!loadingMore && !loadMoreError && !hasMore && (
                      <div className="load-end">已经到底啦</div>
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <Dialog open={addAccountOpen} onOpenChange={setAddAccountOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>添加平台账号</DialogTitle>
            <DialogDescription>
              给「{vtuber?.name}」添加 bilibili / 微博账号；添加后自动抓取账号信息。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Select value={newAccPlatform} onValueChange={setNewAccPlatform}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择平台" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bilibili">bilibili（B站）</SelectItem>
                <SelectItem value="weibo">weibo（微博）</SelectItem>
              </SelectContent>
            </Select>
            <input
              value={newAccUid}
              onChange={(e) => setNewAccUid(e.target.value)}
              placeholder={newAccPlatform === 'weibo' ? '微博 UID（数字，如 3669102477）' : 'B 站 UID（数字）'}
              className="h-9 w-full border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            <input
              value={newAccName}
              onChange={(e) => setNewAccName(e.target.value)}
              placeholder="昵称（可选，留空由抓取回填）"
              className="h-9 w-full border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setAddAccountOpen(false)}>
                取消
              </Button>
              <Button size="sm" disabled={addingAccount || !newAccUid.trim()} onClick={handleAddAccount}>
                {addingAccount ? '添加中…' : '添加'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={fetchChoice} onOpenChange={setFetchChoice}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>抓取帖子方式</AlertDialogTitle>
            <AlertDialogDescription>
              「{vtuber?.name ?? '…'}」的量级不同，请选择抓取范围。全量较慢，后台执行（进度见顶栏）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setFetchChoice(false)}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={fetchBusy} title={busyTip} onClick={() => { setFetchChoice(false); void handleFetchPosts() }}>
              快速抓取（视频2页+动态3页）
            </AlertDialogAction>
            <AlertDialogAction disabled={fetchBusy} title={busyTip} className="bg-green-600 text-white hover:bg-green-600/90" onClick={handleFetchAllPosts}>
              全量抓取（后台）
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>解除订阅？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{vtuber?.name ?? '…'}」的全部账号信息及其帖子记录（不可恢复）。
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
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  )
}
