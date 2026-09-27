/**
 * 帖子列表的**分页机**（M4，批次 12 第三刀，devlog/220）。
 *
 * 五件状态（`posts` / `total` / `page` / `loadingMore` / `loadMoreError`）+ 两个 ref
 * （滚动体 / 哨兵）+ 三条 effect（回顶钮复位 / 用户意图重置即回顶 / 无限滚动哨兵）
 * + 三个入口（`loadMore` / `retryLoadMore` / `onScrollTop`）。原来它们散在 `PostsPage` 里。
 *
 * ## ⚠️ 三条不许动的约束
 *
 * 1. **取数 effect（E11）不在这台机器里** —— 它还在页面里，因为它是这台机器与
 *    "场景切换机 / 筛选机"的交汇点（`seededPostsKeyRef` 播种守卫、AbortController 取消、
 *    `refreshTick` 边沿）。这里只**接收**它的两个外部态 `loading` / `error` 当哨兵的门。
 *    ⇒ 依赖方向：页面 → 分页机（单向），分页机**不**知道谁在取数。
 * 2. **依赖数组逐字保留**（`[typeFilter, searchKw, dateFrom, dateTo, deletedOnly, archived,
 *    accountKey, listActive]` 与哨兵那条的 13 项）—— 它们不是风格，是"什么时候回顶 /
 *    什么时候重建观察者"的实现方式（P6-1 / P8-7：切筛选、切账号都算**用户意图重置**，
 *    必须立刻回顶，不等重取完成）。
 * 3. **`setPage` 仍是唯一翻页口**：页面的 6 个筛选 handler 与场景提交/失败路径都调它
 *    （`setPage(1)`）—— 那方向是"页面调用分页机"，不是两台 hook 互拿 setter。
 *
 * ## ⚠️ 抽出来顺带改了 effect 的**相对顺序**（如实记下）
 *
 * 三条 effect 原来排在取数 effect（E11）**之后**，现在随 hook 调用点排到它**之前**
 * （因为 E11 要读 `page`，而 hook 必须在 E11 的依赖数组求值前调用 —— 否则 TDZ）。
 * 逐条核过：三条都不读 E11 的产物（哨兵那条只把 `loading`/`error` 当门），
 * 回顶那条只碰 DOM 滚动；`setPage` 的消费者在下一轮 render 才反应 ⇒ 顺序无关。
 */
import { useEffect, useRef, useState } from 'react'

import type { Post } from '../api/types'
import type { ArchivedFilter } from '../components/PostFilterPop'

/** 回顶浮钮的浮现阈值：滚动超过这么多像素才浮现（2026-09-05 用户反馈） */
const BACK_TO_TOP_PX = 400
/** 哨兵提前量：进入视口前 600px 就开始预载下一页 */
const SENTINEL_ROOT_MARGIN = '600px 0px'

interface Args {
  /** 当前视图**是不是列表**（`scene.view === 'list'`）—— 哨兵与回顶钮只在列表里工作 */
  listActive: boolean
  /** 账号稳定代理（`platform:uid`）；变了 ⇒ 回顶 + 重建观察者 */
  accountKey: string | null
  /** 首页取数态（**属于页面**的 E11；这两个态下不许自动续载） */
  loading: boolean
  /** 首页取数失败态（同上） */
  error: string | null
  // ── 筛选指纹：任一项变了 ⇒ 回顶 + 重建观察者 ─────────────────────────────
  typeFilter?: string
  archived: ArchivedFilter
  deletedOnly: boolean
  searchKw: string
  dateFrom: string
  dateTo: string
}

export function usePostPagination({
  listActive, accountKey, loading, error,
  typeFilter, archived, deletedOnly, searchKw, dateFrom, dateTo,
}: Args) {
  const [posts, setPosts] = useState<Post[]>([])
  const [total, setTotal] = useState(0)
  // 无限滚动：追加期间的独立 loading 位（区别于整表替换的 loading）；
  // 追加失败不清网格，仅置 loadMoreError 显示尾条重试
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  // 回顶浮钮（2026-09-05 用户反馈）：滚动超过 400px 浮现，一键平滑回顶
  const [showTop, setShowTop] = useState(false)

  const listScrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  /** 无限滚动：由累计长度与总数比较派生（第 1 页后 `posts.length < total`） */
  const hasMore = posts.length < total

  // ① **落到列表视图时**收起回顶钮（逐字保留原语义：判断的是"新视图是不是 list"，
  //    不是"离开了 list" —— 离开时那个钮根本不渲染，留着值也无害）。
  useEffect(() => {
    if (listActive) setShowTop(false)
  }, [listActive])

  // ② P6-1：筛选切换 = 用户意图重置 → 立即滚回列表顶部。
  // （此前「按筛选指纹缓存+恢复滚动位置」实测不达预期已 revert——恢复位置
  //   对不上新内容；标准列表 UX 为回顶，触发即滚，不等重取完成）
  // P8-7（2026-09-10 用户）：修「切平台账号继承滚动深度」——切账号只改
  //   selectedAccount，`key={scene.acc|view}` 不变 → 滚动容器不重挂，旧 scrollTop
  //   原样保留。accountKey / archived 一并进依赖 = 同一条「用户意图重置」语义。
  useEffect(() => {
    if (!listActive) return
    listScrollRef.current?.scrollTo({ top: 0 })
    setShowTop(false)
    // 依赖数组是契约，见文件头约束 2
  }, [typeFilter, searchKw, dateFrom, dateTo, deletedOnly, archived, accountKey, listActive])

  // ③ 无限滚动：哨兵进入视口（提前 600px 预载）且可加载 → 追加下一页。
  // 观察者在加载/筛选变化时重建；追加完成后自动续载（连续滚到底持续填充）
  useEffect(() => {
    if (!listActive || !hasMore || loading || loadingMore || error || loadMoreError) return
    const root = listScrollRef.current
    const el = sentinelRef.current
    if (!root || !el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setPage((p) => p + 1)
        }
      },
      { root, rootMargin: SENTINEL_ROOT_MARGIN },
    )
    io.observe(el)
    return () => io.disconnect()
    // 依赖数组是契约（13 项），见文件头约束 2
  }, [listActive, hasMore, loading, loadingMore, error, loadMoreError, accountKey, typeFilter, archived, deletedOnly, searchKw, dateFrom, dateTo])

  /** 显式「加载更多」（Q2，批次 14）：与哨兵进视口**同一件事**（`setPage(p+1)` 触发
   *  页面里的取数 effect），给键盘/读屏用户一个不依赖滚动的入口。 */
  const loadMore = () => {
    setLoadMoreError(null)
    setPage((p) => p + 1)
  }

  /** 尾条「重试」：只清错误位 —— 清完哨兵那条 effect 会因依赖变化重建，
   *  哨兵若仍在视口就自己续载（不需要另开一条翻页路径）。 */
  const retryLoadMore = () => setLoadMoreError(null)

  /** 回顶钮的显隐（由 `PostListView` 的 `onScroll` 喂滚动位置） */
  const onScrollTop = (top: number) => setShowTop(top > BACK_TO_TOP_PX)

  return {
    posts, setPosts,
    total, setTotal,
    page, setPage,
    loadingMore, setLoadingMore,
    loadMoreError, setLoadMoreError,
    hasMore,
    listScrollRef, sentinelRef,
    showTop, onScrollTop,
    loadMore, retryLoadMore,
  }
}
