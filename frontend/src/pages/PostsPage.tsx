import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
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
import { resolveAvatar } from '../utils/avatarSource'
import { affectsFanTrend, onFetchIdle } from '../utils/fetchIdle'
import { typeGroupsFor } from '../utils/postTypes'
import { pill } from '../utils/pill'
import { useVtuberActions } from './useVtuberActions'
import { useSceneTransition } from '../hooks/useSceneTransition'
import { noteCurrentView } from '../utils/shellState'
import { inHotZone } from '../utils/toolbarZone'
import { VTUBER_UPDATED_EVENT } from '../utils/vtuberList'
import PostDetailDrawer from '../components/PostDetailDrawer'
import AddAccountDialog from '../components/AddAccountDialog'
import VtuberSettingsDialog from '../components/VtuberSettingsDialog'
import LiveCalendar from '../components/LiveCalendar'
import DataDeck from '../components/DataDeck'
import FanTrendChart from '../components/FanTrendChart'
// R40：数据视图改用 DataDeck（不再用 OverlayScroll 包那一页 —— 一次只看一张卡，没有页面滚动）
import FloatPill from '../components/common/FloatPill'
import StateBlock from '../components/common/StateBlock'
import HeroCardsView from '../components/posts/HeroCardsView'
import ListHeaderActions from '../components/posts/ListHeaderActions'
import PostListView from '../components/posts/PostListView'
import ProfileBoardView from '../components/profile/ProfileBoardView'
import type { ArchivedFilter } from '../components/PostFilterPop'
import './../styles/posts.css'

const PAGE_SIZE = 20

// ── 页面工具条显隐的参数（R45）─────────────────────────────────────────────
/** 进热区后要停留多久才呼出：**过滤"路过"**（见组件内 onPanelMouseMove 注释）。 */
const BAR_DWELL_MS = 140
/** 离开热区后多久收回：**复用现成拍子**（原 `.bg-tools` 的 900ms，"与侧栏悬浮滚动条同拍"）。 */
const BAR_GRACE_MS = 900
/** 冷启动 / 深休眠唤醒的闪现时长。 */
const BAR_FLASH_MS = 1200
/** 热区外扩：条与右上组各自的 rect 各向外 8px —— 够得到，又不把内容控件圈进来。 */
const BAR_ZONE_PAD = 8

/** 本会话是否已经"闪现"过。**必须是模块级**：`PostsPage` 按路由挂载，
 *  切 V 会重挂，用组件内 state 就会每次切 V 都闪一下 = 噪音。 */
let toolbarFlashedThisSession = false

/** 视图枚举（P7 追加 profile；R37-P1 起 profile = **档案视图**（卡片画布），
 *  archive = **数据视图**（直播日历 / 粉丝趋势）） */
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
  // 视图：cards=展示页（默认）/ list=帖子列表页 / archive=数据视图 / profile=档案视图（卡片画布）
  // R18：深休眠唤醒后，`App` 把"上次离开时的视图"放在 sessionStorage 里传进来
  // （深链接走不通，只能用这种方式把视图带回来；读过即删，正常启动不受影响）
  /** R45：本次挂载是不是"深休眠唤醒"（带回了上次视图）—— 工具条据此**额外**闪现一次。 */
  const restoredRef = useRef(false)
  const [view, setView] = useState<AppView>(() => {
    try {
      const want = window.sessionStorage.getItem('ddtoolkit.restore-view')
      if (want) {
        window.sessionStorage.removeItem('ddtoolkit.restore-view')
        restoredRef.current = true
      }
      if (want === 'cards' || want === 'list' || want === 'archive' || want === 'profile') {
        return want
      }
    } catch {
      /* sessionStorage 不可用：按默认视图 */
    }
    return 'cards'
  })
  // R18：把当前视图发布给 `utils/shellState`（隐藏到托盘时存现场，深休眠唤醒后恢复）
  useEffect(() => {
    noteCurrentView(view)
  }, [view])
  // ── 亮点指示器（R39-D）：位置跟着激活的视图钮走 ────────────────────────
  // 量的是**激活钮自己的 offsetLeft/offsetWidth**（而不是按 50+10 的间距算）：
  // 以后改按钮尺寸/间距时，亮点自动跟得上，不用同步改两处数字。
  // 光点直径从 CSS 变量 `--glow-spot` 读（单一真源：CSS 画、TS 只用来算居中）。
  const glowRef = useRef<HTMLDivElement | null>(null)
  const [spot, setSpot] = useState<{ x: number; w: number } | null>(null)
  useLayoutEffect(() => {
    const bar = glowRef.current
    const btn = bar?.querySelector<HTMLElement>('.view-btn.on')
    if (!bar || !btn) return
    const size = parseFloat(getComputedStyle(bar).getPropertyValue('--glow-spot')) || 0
    setSpot({ x: btn.offsetLeft + (btn.offsetWidth - size) / 2, w: size })
  }, [view])
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
  // ── 页面工具条的显隐（R45，2026-09-24，用户拍板）─────────────────────────
  // 工具条从"66px 常驻带子"改成"**覆盖**在内容上、**按需出现**"。三个数各有来源，
  // **不新造**：
  //   DWELL 140ms —— 过滤"路过"。热区在面板顶部，而从顶栏往下进内容每次都要穿过它
  //                  ⇒ 不设门槛就是"路过即闪"。刻意去够 140ms 察觉不到、
  //                  快速穿过去不触发（macOS 自动隐藏 Dock 用的同一招）。
  //   GRACE 900ms —— 复用现成的拍子（原 `.bg-tools` 就是 900ms，注释写着
  //                  "与侧栏悬浮滚动条同拍"）。**不引入第二个数**。
  //   FLASH 1200ms — 闪现时长（冷启动 / 深休眠唤醒各一次）。
  const [barShown, setBarShown] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const toolsRef = useRef<HTMLDivElement | null>(null)
  const dwellTimer = useRef<number>()
  const graceTimer = useRef<number>()
  const flashTimer = useRef<number>()
  /** 上一次"在不在热区"。**只在边沿动作** —— mousemove 每秒几十次，
   *  每次都重设定时器就永远触发不了。 */
  const inZoneRef = useRef(false)

  const showBar = useCallback(() => {
    window.clearTimeout(graceTimer.current)
    window.clearTimeout(flashTimer.current)
    setBarShown(true)
  }, [])

  const hideBarSoon = useCallback(() => {
    window.clearTimeout(dwellTimer.current)
    window.clearTimeout(graceTimer.current)
    graceTimer.current = window.setTimeout(() => setBarShown(false), BAR_GRACE_MS)
  }, [])

  /** 指针在不在热区。
   *  ⚠️ **必须按指针位置算，不能用 CSS `:hover`**：`.view-toolbar` 是
   *  `pointer-events:none`（硬要求 —— 整条压在内容上，若吃指针则顶 66px 内
   *  滚轮不滚列表、卡片顶部点不着，理由见 posts.css），收不到 mouseenter。
   *  ⚠️ 也**必须要求"移动进入"而不是"停留"**：数据视图的牌堆是**滚轮翻转**的，
   *  用户可能把指针停在顶部中间一直滚 —— 静止指针不产生 mousemove ⇒ 不误弹。
   *  这一条 dwell 单独做不到。
   *  判定逻辑本身抽在 `utils/toolbarZone.ts`（纯函数，**10 条单测**）——
   *  探针只走得到"命中 / 不命中"两个点，**边界与多矩形并集**靠那一层。 */
  const onPanelMouseMove = (e: ReactMouseEvent) => {
    const inside = inHotZone(
      e.clientX,
      e.clientY,
      [glowRef.current, toolsRef.current].map((el) => el?.getBoundingClientRect() ?? null),
      BAR_ZONE_PAD,
    )
    if (inside === inZoneRef.current) return // 只在边沿动作
    inZoneRef.current = inside
    if (inside) {
      window.clearTimeout(dwellTimer.current)
      dwellTimer.current = window.setTimeout(showBar, BAR_DWELL_MS)
    } else {
      hideBarSoon()
    }
  }

  // 冷启动首挂 / 深休眠唤醒 → 闪现一次。
  // 「完全隐藏」的唯一代价是新用户不知道切换器在哪 —— 用一次性闪现付掉；
  // 唤醒那次额外闪，是因为 R18 把上次视图带回来了，那一刻最需要知道"我在哪个视图"。
  //
  // ⚠️ **"要不要闪"必须在渲染期决定一次，不能放进 effect 里判断**：
  //    StrictMode 下 effect 走 setup→cleanup→setup，cleanup 会把闪现定时器清掉；
  //    若判断也在 effect 里，第二次 setup 会因为「本会话已闪过」而**早退**，
  //    定时器就再没人装 ⇒ `barShown` **永久停在 true**（`ui_probe.py --toolbar` 实测抓到：
  //    `rest: shown=1 opacity=1`，而 `afterLeave` 却正常 —— 因为那条路径是 mousemove
  //    自己装的定时器。这就是"探针钉的是机制不是现象"的价值）。
  //    ⇒ `toolbarFlashedThisSession` 只用来**决定**；effect 只负责**装定时器**，可重复执行。
  const wantFlashRef = useRef<boolean | null>(null)
  if (wantFlashRef.current === null) {
    wantFlashRef.current = !toolbarFlashedThisSession || restoredRef.current
    toolbarFlashedThisSession = true
  }
  useEffect(() => {
    if (!wantFlashRef.current) return
    showBar()
    const id = window.setTimeout(() => setBarShown(false), BAR_FLASH_MS)
    flashTimer.current = id
    return () => window.clearTimeout(id)
  }, [showBar])

  useEffect(
    () => () => {
      window.clearTimeout(dwellTimer.current)
      window.clearTimeout(graceTimer.current)
      window.clearTimeout(flashTimer.current)
    },
    [],
  )

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
  // setPage(1) 保证重拉走「替换」而非「追加」，新内容从顶部呈现。
  //
  // R2 第二步（devlog/080）：事件现在带 `kinds`（谁跑完了）。列表/卡片/日历对三类都敏感
  // （动态流会落新帖、也可能落**直播卡片 → 场次**），所以照旧全刷；
  // 只有**粉丝趋势**不吃 `posts` 类 —— 动态流每 60~80s 一轮，之前它每轮都被重取 + 重建
  // ECharts（纯属白干）。这里给出独立的 `trendTick`，见下方渲染处的分工注释。
  const [refreshTick, setRefreshTick] = useState(0)
  const [trendTick, setTrendTick] = useState(0)
  useEffect(
    () =>
      onFetchIdle((kinds) => {
        setPage(1)
        setRefreshTick((t) => t + 1)
        if (affectsFanTrend(kinds)) setTrendTick((t) => t + 1)
      }),
    [],
  )

  // ── 场景切换：预取门控 + 原子提交（退出 → 进入，无缓冲占位相）──
  // 机器本体已抽到 `hooks/useSceneTransition`（devlog/080）；这里只保留两件"页面自己的事"：
  //   ① `prefetchScene`：预取什么（新 V 本体 + list 目标时的第 1 页帖子与统计，恒以重置态拉取）；
  //   ② `commitScene` / `failScene`：提交时一次性写哪些 state、失败怎么清空。
  const seededPostsKeyRef = useRef<string | null>(null)
  const vtuberLoadedRef = useRef('')
  // 提交时取最新筛选值（定时器闭包可能过期）
  const filterRef = useRef({ refreshTick, typeFilter, archived, deletedOnly, searchKw, dateFrom, dateTo })
  filterRef.current = { refreshTick, typeFilter, archived, deletedOnly, searchKw, dateFrom, dateTo }

  /** 预取结果（场景提交时一次性应用） */
  type SceneData = {
    vtuber: VTuber
    account: Account | null
    posts?: Post[]
    total?: number
    stats?: PostStats | null
  }

  const prefetchScene = async (
    acc: number,
    targetView: AppView,
    signal: AbortSignal,
  ): Promise<SceneData> => {
    const v = await api.getVtuber(acc)
    const accounts = v.accounts.filter((a) => a.platform_uid)
    const account = accounts[0] ?? null
    const data: SceneData = { vtuber: v, account, stats: null }
    if (!account || targetView !== 'list') return data
    // 预取帖子恒以「重置态（默认筛选）」拉取：用户反馈 2026-09-05——
    // 筛选状态按 VTuber/账号隔离（切换即重置），预取若沿用旧账号残留
    // 筛选会与提交后重置态错配（种子误消费）。筛选字段不读 filterRef。
    const [page, stats] = await Promise.all([
      api.listPosts(
        account.platform,
        account.platform_uid,
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
        signal,
      ),
      api.postStats(account.platform, account.platform_uid).catch(() => null),
    ])
    data.posts = page.items
    data.total = page.total
    data.stats = stats
    return data
  }

  const sceneTransition = useSceneTransition<SceneData, AppView>({
    vtuberId,
    view,
    prefetch: prefetchScene,
    onCommit: (d, ctx) => {
      const f = filterRef.current
      // 原子提交：一次性应用预取数据，退出与进入之间无任何占位帧
      setVtuber(d.vtuber)
      setSelectedAccount(d.account)
      setStats(d.stats ?? null)
      setError(null)
      setPage(1)
      if (ctx.view === 'list' && d.account && d.posts) {
        setPosts(d.posts)
        setTotal(d.total ?? 0)
        seededPostsKeyRef.current = `${d.account.platform}:${d.account.platform_uid}:${f.refreshTick}:1:${f.typeFilter ?? ''}:${f.archived}:${f.deletedOnly ? 1 : 0}:${f.searchKw}:${f.dateFrom}:${f.dateTo}`
        setLoading(false)
      } else {
        // cards 目标不预取帖子；或 list 但帖子未就绪 → 交回 posts effect 正常加载
        setPosts([])
        setTotal(0)
        setLoading(ctx.view === 'list')
      }
      vtuberLoadedRef.current = `${ctx.vtuberId}:${f.refreshTick}`
    },
    onFail: (message) => {
      // 预取失败：清空走错误占位（body 内联显示）
      setPage(1)
      setPosts([])
      setTotal(0)
      setStats(null)
      setVtuber(null)
      setSelectedAccount(null)
      setError(message ?? '加载失败')
      setLoading(false)
    },
  })
  const scene = {
    acc: sceneTransition.sceneAcc,
    view: sceneTransition.sceneView as AppView,
    exiting: sceneTransition.exiting,
  }

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
  // 头像解析口径已抽到 `utils/avatarSource`（devlog/135）：左栏与卡片必须同源，
  // 否则"在档案设置里换过头像，卡片变了、左栏没变"。
  const avatarSrc = resolveAvatar(vtuber, vtuber?.accounts ?? [])
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

  // ── 页面标题（R45-B 建立，R45-E 改为"占位"，**R45-E2 改为写死的每视图标签**）──
  // 它**不是信息层**，是**占位物** —— 用户口径：「让工具条隐藏后顶上那一栏空出来的
  // 地方不至于太空了没东西可以看，所以放一个标题占位」。
  // 位置见 `posts.css` 的 `.page-title`（绝对定位、与工具条同轴、不占流）。
  //
  // ⚠️ **R45-E2 起文案是写死的标签**（用户 2026-09-24 自定）：
  //   · list    = 「帖子列表」
  //   · archive = 「数据卡片」
  //   · cards / profile = 无（`''` ⇒ 那个 `<h2>` 干脆不渲染）
  // 此前 list 显示"选中账号昵称"、archive 显示"当前卡片标题"，
  // 后者要靠 `DataDeck` 的 `onIndexChange` 回抛索引 —— 现在不需要了，
  // 所以那个 state 一并删掉（`DataDeck.onIndexChange` 这个能力**保留**在组件上，
  // 以后想让标题跟着卡片走，接回去即可）。
  // ⚠️ 它**不再镜像卡片内部的标题**：archive 那张卡自己渲染「直播日历」，
  // 而导航标签是「数据卡片」—— 两者是**两件事**，探针原先那条
  // "两份真源必须相等"的对账判据已随之删掉（见 devlog/186 §八）。
  const DECK_LABELS = ['直播日历', '粉丝趋势']
  const pageTitle =
    scene.view === 'list'
      ? '帖子列表'
      : scene.view === 'archive'
        ? '数据卡片'
        : ''

  // ── P8-B：平台药丸的点击开主页 + 长按拖动重排已随视图搬到
  //    `components/posts/HeroCardsView.tsx`（2026-09-13，devlog/065）——
  //    那 4 个 state / 4 个 handler / 2 个派生值只有卡片视图用，留在页面里只是噪声。
  //    结果：本文件少 4 个 state（pillOrder/dragIdx/pressTimer/dragMoved）。

return (
    <div className="posts-panel" ref={panelRef} onMouseMove={onPanelMouseMove}>
      {/* 右栏永久背景：自定义背景(custom 全图清晰) 优先，否则头像铺底 + 渐变纱罩；
          key=背景 src → 换装淡入不瞬跳 */}
      {backdropSrc && (
        <div
          key={backdropSrc}
          className={`hero-backdrop${customBg ? ' custom' : ''}`}
          style={{ backgroundImage: `url(${backdropSrc})` }}
        />
      )}

      {/* 页面工具条（R45）：**覆盖**在内容之上、**按需出现**、不占布局。
          · `data-shown` 驱动显隐；键盘聚焦由 CSS `:focus-within` 兜（见 posts.css）
          · ⚠️ **没有 onMouseEnter/onMouseLeave** —— 它是 `pointer-events:none`
            （硬要求，见 posts.css），收不到那些事件；呼出靠 `.posts-panel` 上的
            `onMouseMove` 按**指针位置**判定（`inHotZone`）。
          · ⚠️ 整条**不进 Tab 序之外**：隐藏态仍是可聚焦控件，Tab 进来会由
            `:focus-within` 显形 —— 这是"自动隐藏 + 键盘可达"唯一能同时成立的做法。 */}
      <div className="view-toolbar" data-shown={barShown ? '1' : '0'}>
        {scene.view === 'cards' && vtuber && (
          <div className="bg-tools" ref={toolsRef}>
            {/* P8-B：从「换背景图」扩展为「档案设置」窗口
                （背景/名称/企划/设定/头像/签名/账号管理，承接原 profile 视图的内容）
                R45：显隐并入工具条（原来自带一套 `bgToolsVisible` + 900ms 定时器，
                与工具条并存会错拍："工具条出现了、设置钮还没出现"）。 */}
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
        {/* 视图切换条（2026-09-08 用户定序：卡片 → 列表 → 数据视图 → 档案视图，
            四个视图同级、共享同一状态机与数据，切换不重取）
            R37-P1（2026-09-17）：命名按用户口径改定 —— 「档案（直播日历 / 粉丝趋势）」→
            **数据视图**，「档案卡」→ **档案视图**（卡片画布）。
            R45：按钮 50 → 34、图标 `size-6` → 18px（尺寸理由见 posts.css 的 `.view-btn`）。 */}
        <div className="glow-bar" ref={glowRef}>
          {/* 选中块（R39-D，用户：「有一个亮点追随当前切换的按钮，带有切换时的动画效果」）：
              位置按激活钮的 `offsetLeft/offsetWidth` 写内联样式（`useLayoutEffect`），
              于是"按钮换高亮"与"块滑过去"在同一次布局里落定，不会闪。 */}
          {spot && (
            <span className="glow-spot" aria-hidden="true"
                  style={{ transform: `translateX(${spot.x}px)`, width: spot.w }} />
          )}
          <button
            type="button"
            className={`view-btn ${view === 'cards' ? 'on' : 'off'}`}
            title="展示页"
            onClick={() => setView('cards')}
          >
            <LayoutGrid className="size-[18px]" />
          </button>
          <button
            type="button"
            className={`view-btn ${view === 'list' ? 'on' : 'off'}`}
            title="帖子列表"
            onClick={() => setView('list')}
          >
            <AlignJustify className="size-[18px]" />
          </button>
          <button
            type="button"
            className={`view-btn ${view === 'archive' ? 'on' : 'off'}`}
            title="数据视图（直播日历 / 粉丝趋势）"
            onClick={() => setView('archive')}
          >
            <BarChart3 className="size-[18px]" />
          </button>
          <button
            type="button"
            className={`view-btn ${view === 'profile' ? 'on' : 'off'}`}
            title="档案视图（卡片画布）"
            onClick={() => setView('profile')}
          >
            <Fingerprint className="size-[18px]" />
          </button>
          {/* 2026-09-08（用户）：移除未接线的「动态视图」占位图标——避免点了没反应的假入口 */}
        </div>
      </div>

      {/* 场景容器：key=账号|视图 → 提交即整体重挂播放入场（scene-in），
          退场期挂 scene-exit 整块 fall-out；工具条在块外常驻，高亮即时响应。
          加载/错误态内联于此（壳层常驻，glow-bar 不随切 V 卸载）。
          ⚠️ `data-view` 是**版式的选择器**（R45-E2）：`posts.css` 用它把
          「四个视图各自的让开量」解析成本元素上的 `--toolbar-gap`
          （`.view-body[data-view=…]`）。少挂它 ⇒ 兜底用 list 那一档
          ⇒ 不该同距的视图会同距，而探针会逐视图对账报出来。 */}
      <div
        key={`${scene.acc}|${scene.view}`}
        className={`view-body${scene.exiting ? ' scene-exit' : ''}`}
        data-view={scene.view}
      >

        {!vtuber && !error && (
          <StateBlock kind="loading" variant="inline" text="正在加载 VTuber 信息…" />
        )}
        {!vtuber && error && (
          <StateBlock kind="error" variant="alert" title="无法加载" text={error} />
        )}

        {/* 页面标题（R45-B 建立，**R45-E 降级为"占位"**，用户 2026-09-24）：
            用户口径：「我的目的是让**工具条隐藏后顶上那一栏空出来的地方不至于太空**了
            没东西可以看，所以放一个**标题占位**」。
            ⇒ 它现在**与工具条同一栏**（`.page-title` 是 `position:absolute`，不占流），
            **不再自己占一行**（R45-B/D 那版是 `flex:none` + `padding-top: band+gap`，
            白吃掉 121px、把内容整体推下去）。
            让开工具条那件事改由 `.view-body::before` 一处承担（见 posts.css）——
            所以**内容的位置与这个标题无关**：标题在不在、文案多长，内容都不动。
            ⚠️ 它**不随工具条显隐**（内容不是 chrome）；也正是"占位"的用意所在。 */}
        {vtuber && pageTitle && (
          <h2 className="page-title" data-page-title="">{pageTitle}</h2>
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
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}

        {vtuber && scene.view === 'archive' && (
          /* R40（2026-09-19，用户）：数据视图从"固定卡片 + 上下滚动"改成**一次一张卡的牌堆** ——
             滚轮上下切换、方向语义见 `DataDeck` 文件头；两张卡始终挂载（切换时零重建，
             ECharts 不会被 ResizeObserver 拖着重画）。 */
          <DataDeck
            keys={['live-calendar', 'fan-chart']}
            labels={DECK_LABELS}
            persistKey={String(vtuber.id)}
          >
            {/* 2026-09-06：archive 逐步重建（用户主导），第一步 = 直播日历卡（Frame10612 规格）
                R13：`vtuberId` 给日历取"该 V 的未来预约"（预约是 V 级数据，跨账号共用） */}
            <LiveCalendar
              accountId={heroAcc?.id ?? null}
              vtuberId={vtuber.id}
              refreshTick={refreshTick}
            />
            {/* 第二步 = 粉丝趋势卡（参考图 + 项目粉系；Brush 缩放 + 默认 30 天窗口）。
                ⚠️ 用 `trendTick` 而不是 `refreshTick`（R2 第二步，devlog/080）：
                趋势只由**账号快照**与**第三方粉丝历史**驱动，帖子/动态流写不到它 ——
                而动态流每 60~80s 一轮，用 refreshTick 就是每轮白重取 + 白重建 ECharts。 */}
            <FanTrendChart
              accountId={heroAcc?.id ?? null}
              refreshTick={trendTick}
            />
          </DataDeck>
        )}

        {vtuber && scene.view === 'profile' && (
          // R37-P1（2026-09-17，devlog/141）：占位换成真正的**档案视图**（卡片画布）。
          // 原 ProfileView（企划/设定/账号一览）在 P8-4 的「档案设置」窗口里重建过，
          // 组件文件仍保留（别删）—— 本视图不依赖它。
          <ProfileBoardView
            vtuber={vtuber}
            refreshTick={refreshTick}
            onOpenPost={openPost}
          />
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
          // R33 补（2026-09-19，用户：「修改过的签名左栏没有及时同步」）：
          // 左栏那份列表是**它自己**拉的（不是本页的子节点）⇒ 必须广播一条更新，
          // 否则右栏立刻变、左栏一直显示旧签名（R33 修的是渲染口径，缺的是这条通道）。
          window.dispatchEvent(new CustomEvent(VTUBER_UPDATED_EVENT, { detail: v }))
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