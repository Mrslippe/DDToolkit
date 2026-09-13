import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlignJustify,
  BarChart3,
  Fingerprint,
  LayoutGrid,
  Settings2,
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
import { api, resolveAsset } from '../api/api'
import { useFetchBusy } from '../fetchBusy'
import type { Account, AccountSnapshot, Post, PostStats, VTuber } from '../api/types'
import { mergeAccountSnapshots, mergeVtuberSnapshots } from '../utils/accountSnapshots'
import { typeGroupsFor } from '../utils/postTypes'
import { pill } from '../utils/pill'
import { useVtuberActions } from './useVtuberActions'
import PostDetailDrawer from '../components/PostDetailDrawer'
import AddAccountDialog from '../components/AddAccountDialog'
import VtuberSettingsDialog from '../components/VtuberSettingsDialog'
import LiveCalendar from '../components/LiveCalendar'
import FanTrendChart from '../components/FanTrendChart'
import OverlayScroll from '../components/OverlayScroll'
import FloatPill from '../components/common/FloatPill'
import StateBlock from '../components/common/StateBlock'
import HeroCardsView from '../components/posts/HeroCardsView'
import ListHeaderActions from '../components/posts/ListHeaderActions'
import PostListView from '../components/posts/PostListView'
import type { ArchivedFilter } from '../components/PostFilterPop'
import './../styles/posts.css'

const PAGE_SIZE = 20

/** 场景退场时长（ms）：与 layout.css `.scene-exit` 的 0.2s 保持同步 */
const EXIT_MS = 200

/** 视图枚举（P7 追加 profile：档案卡详情视图） */
type AppView = 'cards' | 'list' | 'archive' | 'profile'

/** 归档过滤类型（all / unarchived / archived）随 P10-A 的筛选弹窗一起搬到
 *  `components/PostFilterPop.tsx`（弹窗是它的唯一编辑入口，类型与 UI 同处）。 */

/** 成功提示的 `pill()` 已下沉到 `utils/pill.ts`（2026-09-13，devlog/065：
 *  `HeroCardsView` 的"平台顺序已保存"也要用同一套顶栏胶囊口径）。 */

/**
 * 帖子面板（右栏 /vtubers/:id）：
 * VTuber 信息条 + 类型筛选 chips + 帖子卡片流（无限懒加载滚动）
 * + 详情抽屉 + 抓取操作。视觉参照设计稿 Frame1672。
 *
 * 2026-09-13（devlog/065，P2 分层收敛收尾）：四块视图已拆成组件 ——
 * `components/posts/HeroCardsView`（cards + 平台药丸拖动）、
 * `components/posts/ListHeaderActions`（列表工具条）、
 * `components/posts/PostListView`（列表主体）。本文件只留**场景切换机 + 取数 + 壳层**。
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
  const [archived, setArchived] = useState<ArchivedFilter>('all')
  // 墓碑筛选（v0.5.1）：仅显示已删除帖子（独立 toggle，与归档/类型正交）
  const [deletedOnly, setDeletedOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // `fetching` 随 6 个动作回调一起搬到 useVtuberActions（它只被那些动作写、被按钮读）

  const [drawerPost, setDrawerPost] = useState<Post | null>(null)
  // 开关分离：关闭只翻 flag 不清 post——Dialog 保持挂载走 radix 退场动画，
  // 抽屉末帧仍渲染最后一次的帖子（PostDetailDrawer 内部 lastPostRef）
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [fetchChoice, setFetchChoice] = useState(false)
  // 添加账号（多平台订阅：bilibili / weibo）—— P8-B 起表单抽成 <AddAccountDialog>，
  // card 视图药丸尾部的 hover「+」与「档案设置」窗口共用同一个组件
  const [addAccountOpen, setAddAccountOpen] = useState(false)
  // 档案设置窗口（P8-B：背景/名称/企划/设定/头像/签名/账号管理）
  const [settingsOpen, setSettingsOpen] = useState(false)
  const fetchBusy = useFetchBusy()
  const busyTip = '已有抓取任务进行中，请稍后再试'
  // 视图：cards=展示页（默认）/ list=帖子列表页 / archive=档案 / profile=档案卡（P7 移出）
  const [view, setView] = useState<AppView>('cards')
  // 列表页右侧操作钮组：收起态只露 [展开钮][更新动态]，展开向左滑出全部四钮
  const [actionsOpen, setActionsOpen] = useState(false)
  const navigate = useNavigate()

  // 列表页筛选：搜索关键词（防抖后生效）+ 发布时间范围
  // （已删 / 归档 / 时间三件筛选自 P10-A 起统一收进右侧「筛选」弹窗，
  //   但状态仍由本页持有——请求参数、预取种子、回顶依赖都不受影响）
  const [searchInput, setSearchInput] = useState('')
  const [searchKw, setSearchKw] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  /** 最近一次非空头像：切 V 间隙背景纱罩沿用，不闪空 */
  const lastAvatarRef = useRef<string | undefined>(undefined)
  const searchTimer = useRef<number>()
  /** 自定义背景上传：隐藏 file input + 上传中抑制 */
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

  // 时间下拉的点外关闭 / Esc 双通道自 P10-A 起下沉到 `PostFilterPop`（同款实现，
  // 一次管住整个筛选弹窗的开关）

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
    view: AppView
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

  const startPrefetch = (acc: number, targetView: AppView) => {
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
        const jobs: Promise<unknown>[] = []
        if (targetView === 'list') {
          // 预取帖子恒以「重置态（默认筛选）」拉取：用户反馈 2026-09-05——
          // 筛选状态按 VTuber/账号隔离（切换即重置），预取若沿用旧账号残留
          // 筛选会与提交后重置态错配（种子误消费）。筛选字段不读 filterRef。
          jobs.push(
            api
              .listPosts(
                acc0.platform,
                acc0.platform_uid,
                {
                  page: 1,
                  page_size: PAGE_SIZE,
                  type: undefined,
                  is_archived: undefined,
                  is_deleted: undefined,
                  q: undefined,
                  date_from: undefined,
                  date_to: undefined,
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

  // 直播/资料实时同步：与侧栏同源吃 account-progress 增量快照就地合并——
  // 短任务（轮询未目睹运行 → 无 fetch-idle 边沿）后右栏徽标会停留在旧值，
  // 与左栏「直播中/未开播」不一致（2026-09-05 反馈）；只更新命中账号，
  // 未命中时引用不变，不影响依赖 accountKey 的请求去重
  useEffect(() => {
    const onProgress = (e: Event) => {
      const updates = (e as CustomEvent<AccountSnapshot[]>).detail
      if (!Array.isArray(updates) || updates.length === 0) return
      setVtuber((prev) => (prev ? mergeVtuberSnapshots(prev, updates) : prev))
      setSelectedAccount((prev) =>
        prev ? (mergeAccountSnapshots(prev, updates) ?? prev) : prev,
      )
    }
    window.addEventListener('ddtoolkit:account-progress', onProgress)
    return () => window.removeEventListener('ddtoolkit:account-progress', onProgress)
  }, [])

  // 统计概览（仅列表视图需要；依赖账号 key 而非对象引用——
  // fetch-idle 时 setSelectedAccount 换新对象但 key 不变，避免重复请求）
  const accountKey = selectedAccount
    ? `${selectedAccount.platform}:${selectedAccount.platform_uid}`
    : null

  // 用户反馈（2026-09-05）：不同 VTuber/账号之间筛选状态不共享——切换后重置。
  // 时序：本 effect 与 scene 提交同批 render 后运行，先于 EXIT_MS 提交完成，
  // 提交时 filterRef 已是重置态 → 与预取默认参数一致（防种子错配）。
  useEffect(() => {
    setTypeFilter(undefined)
    setSearchInput('')
    setSearchKw('')
    setDateFrom('')
    setDateTo('')
    setDeletedOnly(false)
    // `archived` 此前漏在这条重置之外（P8-A 加归档 chip 时未同步）：留在「仅已归档」切账号，
    // 预取恒按默认参数拉、提交却带 archived 筛选 → 种子指纹错配（列表先错一帧再被重取纠正）。
    setArchived('all')
  }, [scene.acc, accountKey])

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
    // `accountKey` 是 `selectedAccount` 的**稳定代理**（`id|platform|uid` 串）：
    // 帖子流用对象引用做依赖会在每次 `getVtuber` 回填后重跑，而数据其实没变。
    // 这是刻意保留的"窄依赖"（2026-09-13 eslint 基线确认）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // 同上一处：`accountKey` 是 `selectedAccount` 的稳定代理（见上方说明）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey, page, typeFilter, archived, deletedOnly, refreshTick, scene.view, searchKw, dateFrom, dateTo])

  // 无限滚动：哨兵进入视口（提前 600px 预载）且可加载 → 追加下一页。
  // 观察者在加载/筛选变化时重建；追加完成后自动续载（连续滚到底持续填充）
  const listScrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const hasMore = posts.length < total
  // 回顶浮钮（2026-09-05 用户反馈）：滚动超过 400px 浮现，一键平滑回顶
  const [showTop, setShowTop] = useState(false)
  useEffect(() => {
    if (scene.view === 'list') setShowTop(false)
  }, [scene.view])
  // P6-1：筛选切换 = 用户意图重置 → 立即滚回列表顶部。
  // （此前「按筛选指纹缓存+恢复滚动位置」实测不达预期已 revert——恢复位置
  //   对不上新内容；标准列表 UX 为回顶，触发即滚，不等重取完成）
  // P8-7（2026-09-10 用户）：修「切平台账号继承滚动深度」——切账号只改
  //   selectedAccount，`key={scene.acc|view}` 不变 → 滚动容器不重挂，旧 scrollTop
  //   原样保留。accountKey / archived 一并进依赖 = 同一条「用户意图重置」语义。
  useEffect(() => {
    if (scene.view !== 'list') return
    listScrollRef.current?.scrollTo({ top: 0 })
    setShowTop(false)
  }, [typeFilter, searchKw, dateFrom, dateTo, deletedOnly, archived, accountKey, scene.view])
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

  // 抓取/更新/解除订阅/加账号后刷新 —— 6 个动作回调已搬到 pages/useVtuberActions.ts
  // （同一套骨架：守卫 → setFetching → kickPoll → api → 三种结果提示 → finally 复位）。
  const {
    fetching, handleFetch, handleFetchPosts, handleFetchAllPosts,
    handleUpdatePosts, handleDeleteVtuber, handleAccountAdded,
  } = useVtuberActions({
    vtuber, selectedAccount, accountId: scene.acc, navigate,
    setVtuber, setSelectedAccount,
    onDeleteError: () => setConfirmDel(false),
  })

  // 类型筛选 chips：全部 N / 投稿 N / 图文 N / 转发 N ...（计数来自统计概览，
  // 分组求和、零计数组不显示；key 为逗号合并类型直传后端）
  // P9-2：分组随当前账号平台切换（微博没有专栏/音乐，多一个「系统」）
  const chipGroups = useMemo(
    () => typeGroupsFor(selectedAccount?.platform),
    [selectedAccount?.platform],
  )
  const chipItems = useMemo(() => {
    const counts = stats?.by_type ?? {}
    return [
      { key: 'all', label: '全部', count: stats?.total ?? total },
      ...chipGroups.map((g) => ({
        key: g.key,
        label: g.label,
        count: g.types.reduce((sum, t) => sum + (counts[t] ?? 0), 0),
      })).filter((g) => g.count > 0),
    ]
  }, [stats, total, chipGroups])

  // 无限滚动：hasMore 由累计长度与总数比较派生（第 1 页后 posts.length < total）

  // 壳层常驻：加载/错误态内联到 view-body（见渲染段），工具条与 glow-bar
  // 不随切 V 卸载重挂——消除切换闪动
  // 头像 / 右栏背景以 VTuber 本体为准（稳定，不随账号切换变化）；
  // 帖子流跟随所选账户；卡片页签名/直播走 VTuber 整体事实（B站优先）——
  // list 切账号不联动 cards/archive（2026-09-05 反馈）
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

  // 背景的上传/清除已迁入「档案设置」窗口（P8-B）；此处只保留背景层渲染所需的取值
  // 直播徽标只读 B 站账号：直播状态仅存在于 bilibili，且属 VTuber 整体事实——
  // 不跟随列表页所选账号。否则在列表里切到微博再回卡片页，徽标会从
  // 「直播中」误变「未开播」（视图间状态联动，2026-09-03 反馈）。
  const liveAcc =
    vtuber?.accounts.find((a) => a.platform === 'bilibili' && a.platform_uid) ?? selectedAccount
  const isLive = (liveAcc?.live_status ?? 0) === 1
  // 卡片页签名同样走「VTuber 整体事实」（B站优先，无 B站时首个账号）——
  // 不跟随 list 视图所选账号（2026-09-05 反馈：list 切账号联动到 cards/archive）
  const heroAcc =
    vtuber?.accounts.find((a) => a.platform === 'bilibili' && a.platform_uid) ??
    vtuber?.accounts.find((a) => a.platform_uid) ??
    null
  const accounts = vtuber ? vtuber.accounts.filter((a) => a.platform_uid) : []

  // ── P8-B：平台药丸的点击开主页 + 长按拖动重排已随视图搬到
  //    `components/posts/HeroCardsView.tsx`（2026-09-13，devlog/065）——
  //    那 4 个 state / 4 个 handler / 2 个派生值只有卡片视图用，留在页面里只是噪声。
  //    结果：本文件少 4 个 state（pillOrder/dragIdx/pressTimer/dragMoved）。

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
            {/* P8-B：从「换背景图」扩展为「档案设置」窗口
                （背景/名称/企划/设定/头像/签名/账号管理，承接原 profile 视图的内容） */}
            <FloatPill
              size="md"
              shape="icon"
              active={!!customBg}
              className="bg-set"
              title="档案设置（背景 / 名称 / 企划 / 头像 / 账号）"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 className="size-5" />
            </FloatPill>
          </div>
        )}
        {/* 视图切换光条（2026-09-08 用户定序：卡片 → 列表 → 档案 → 档案卡，
            四个视图同级、共享同一状态机与数据，切换不重取） */}
        <div className="glow-bar">
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
          <button
            type="button"
            className={`view-btn ${view === 'archive' ? 'on' : 'off'}`}
            title="档案（直播日历 / 粉丝趋势）"
            onClick={() => setView('archive')}
          >
            <BarChart3 className="size-6" />
          </button>
          <button
            type="button"
            className={`view-btn ${view === 'profile' ? 'on' : 'off'}`}
            title="档案卡（企划 / 设定 / 账号）"
            onClick={() => setView('profile')}
          >
            <Fingerprint className="size-6" />
          </button>
          {/* 2026-09-08（用户）：移除未接线的「动态视图」占位图标——避免点了没反应的假入口 */}
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
          <StateBlock kind="loading" variant="inline" text="正在加载 VTuber 信息…" />
        )}
        {!vtuber && error && (
          <StateBlock kind="error" variant="alert" title="无法加载" text={error} />
        )}

        {/* 操作按钮行（仅列表视图；卡片/档案视图各自有内部账号切换与操作）：
            行首账号切换器 + 右侧可收起操作组——收起态 [展开钮][更新动态]，
            展开向左滑出 [抓取账号][抓取帖子][添加账号][解除订阅]，
            展开钮被挤至最左并旋转为收起钮。 */}
        {vtuber && scene.view === 'list' && (
          <ListHeaderActions
            accounts={accounts}
            selectedAccountId={selectedAccount?.id ?? null}
            onSelectAccount={(a) => {
              setSelectedAccount(a)
              setPage(1)
            }}
            actionsOpen={actionsOpen}
            onToggleActions={() => setActionsOpen((v) => !v)}
            fetching={fetching}
            fetchBusy={fetchBusy}
            busyTip={busyTip}
            onFetchAccount={handleFetch}
            onOpenFetchChoice={() => setFetchChoice(true)}
            onAddAccount={() => setAddAccountOpen(true)}
            onDelete={() => setConfirmDel(true)}
            onUpdatePosts={handleUpdatePosts}
          />
        )}

        {vtuber && scene.view === 'cards' && (
          <HeroCardsView
            vtuber={vtuber}
            accounts={accounts}
            avatarSrc={avatarSrc}
            liveAcc={liveAcc ?? null}
            isLive={isLive}
            onAddAccount={() => setAddAccountOpen(true)}
          />
        )}

        {vtuber && scene.view === 'archive' && (
          <OverlayScroll className="archive-view">
            {/* 2026-09-06：archive 逐步重建（用户主导），第一步 = 直播日历卡（Frame10612 规格） */}
            <LiveCalendar
              accountId={heroAcc?.id ?? null}
              refreshTick={refreshTick}
            />
            {/* 第二步 = 粉丝趋势卡（参考图 + 项目粉系；Brush 缩放 + 默认 30 天窗口） */}
            <FanTrendChart
              accountId={heroAcc?.id ?? null}
              refreshTick={refreshTick}
            />
          </OverlayScroll>
        )}

        {vtuber && scene.view === 'profile' && (
          // P8-5（2026-09-10 用户）：档案卡改版中 → 先占位。
          // 原 ProfileView（企划/设定/账号一览）在 P8-4 的「档案设置」窗口里重建，
          // 组件文件暂时保留（别删），改版完成后再决定去留。
          <div className="empty-state">
            <div className="empty-state-card">
              <div className="empty-state-logo">档</div>
              <p className="empty-state-title">档案卡改版中</p>
              <p className="empty-state-desc">
                企划 / 设定 / 账号管理正在重做，将并入展示页的「档案设置」窗口
              </p>
            </div>
          </div>
        )}

        {scene.view === 'list' && (
          <PostListView
            chipItems={chipItems}
            typeFilter={typeFilter}
            onPickType={(key) => {
              setTypeFilter(key)
              setPage(1)
            }}
            searchInput={searchInput}
            onSearchInput={(v) => {
              setSearchInput(v)
              setPage(1)
            }}
            deletedOnly={deletedOnly}
            onDeletedToggle={() => {
              setDeletedOnly((d) => !d)
              setPage(1)
            }}
            archived={archived}
            onArchivedChange={(v) => {
              setArchived(v)
              setPage(1)
            }}
            range={{ from: dateFrom, to: dateTo }}
            onRangeConfirm={(r) => {
              setDateFrom(r.from)
              setDateTo(r.to)
              setPage(1)
            }}
            onFilterReset={() => {
              setDeletedOnly(false)
              setArchived('all')
              setDateFrom('')
              setDateTo('')
              setPage(1)
            }}
            stats={stats}
            posts={posts}
            error={error}
            loading={loading}
            loadingMore={loadingMore}
            loadMoreError={loadMoreError}
            onRetryLoadMore={() => setLoadMoreError(null)}
            hasMore={hasMore}
            onOpenPost={openPost}
            listScrollRef={listScrollRef}
            sentinelRef={sentinelRef}
            showTop={showTop}
            onScroll={(top) => setShowTop(top > 400)}
          />
        )}
      </div>

      <AddAccountDialog
        open={addAccountOpen}
        onOpenChange={setAddAccountOpen}
        vtuberId={vtuber?.id ?? null}
        vtuberName={vtuber?.name}
        onAdded={handleAccountAdded}
      />

      <VtuberSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        vtuber={vtuber}
        onSaved={(v) => {
          setVtuber(v)
          setSelectedAccount((prev) =>
            prev ? (v.accounts.find((a) => a.id === prev.id) ?? v.accounts[0]) : prev,
          )
        }}
        onPill={pill}
      />

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