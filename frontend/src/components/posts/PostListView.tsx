/**
 * 列表视图主体（P2 分层收敛剩余项，2026-09-13，devlog/065）。
 *
 * 从 `pages/PostsPage.tsx` 整块搬出，**只搬不改** —— 同一份 JSX 与类名
 * （`.chips-bar` / `.type-chips` / `.search-float` / `.list-scroll` / `.list-inner`
 * / `.post-grid` / `.load-sentinel` / `.back-to-top`），`ui_probe.py` 的三档宽度断言
 * 与 `.list-inner` 列宽契约直接查这些节点。
 *
 * 边界：**只做渲染**。取数（预取/分页/取消）、无限滚动观察者、筛选状态都留在
 * `PostsPage` —— 那些 effect 的**顺序与依赖数组是契约**（见 `useLiveSessions.ts` 的同款约定），
 * 搬动它们才会真正改变行为；而把 JSX 交出去不影响任何时序。
 *
 * 三个 ref（滚动容器 / 哨兵 / 回顶）由父级持有并传进来：观察者住在父级，
 * ref 是稳定对象，传进来不改变时序。
 */
import type { RefObject } from 'react'
import { ChevronUp, Loader2, Search } from 'lucide-react'

import type { Post, PostStats } from '../../api/types'
import OverlayScroll from '../OverlayScroll'
import StateBlock from '../common/StateBlock'
import PostCard from '../PostCard'
import PostFilterPop from '../PostFilterPop'
import type { ArchivedFilter } from '../PostFilterPop'

/** 类型筛选 chip（`key` 为逗号合并类型，直传后端；`all` = 不筛） */
export interface ChipItem {
  key: string
  label: string
  count: number
}

interface Props {
  // ── 筛选态（值 + 变更回调：变更时父级同时回第 1 页） ──
  chipItems: ChipItem[]
  typeFilter?: string
  onPickType: (key: string | undefined) => void
  searchInput: string
  onSearchInput: (v: string) => void
  deletedOnly: boolean
  onDeletedToggle: () => void
  archived: ArchivedFilter
  onArchivedChange: (v: ArchivedFilter) => void
  range: { from: string; to: string }
  onRangeConfirm: (r: { from: string; to: string }) => void
  onFilterReset: () => void
  /** 统计概览（已删/已归档计数给筛选弹窗） */
  stats: PostStats | null

  // ── 帖子流 ──
  posts: Post[]
  error: string | null
  loading: boolean
  loadingMore: boolean
  loadMoreError: string | null
  onRetryLoadMore: () => void
  /** Q2（批次 14）：**显式加载更多** —— 无限滚动是 IntersectionObserver 驱动的，
   *  键盘/读屏用户拿不到那个"滚到底自动加载"的入口，这里给一个能 Tab 到、能回车的备选 */
  onLoadMore: () => void
  hasMore: boolean
  onOpenPost: (p: Post) => void

  // ── 滚动（ref 由父级持有：无限滚动观察者与"回顶"在父级） ──
  listScrollRef: RefObject<HTMLDivElement>
  sentinelRef: RefObject<HTMLDivElement>
  showTop: boolean
  onScroll: (top: number) => void
}

export default function PostListView({
  chipItems,
  typeFilter,
  onPickType,
  searchInput,
  onSearchInput,
  deletedOnly,
  onDeletedToggle,
  archived,
  onArchivedChange,
  range,
  onRangeConfirm,
  onFilterReset,
  stats,
  posts,
  error,
  loading,
  loadingMore,
  loadMoreError,
  onRetryLoadMore,
  onLoadMore,
  hasMore,
  onOpenPost,
  listScrollRef,
  sentinelRef,
  showTop,
  onScroll,
}: Props) {
  return (
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
                  onClick={() => onPickType(c.key === 'all' ? undefined : c.key)}
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
                  onChange={(e) => onSearchInput(e.target.value)}
                  placeholder="搜索标题 / 摘要 / 正文"
                  title="标题、摘要（前 200 字）与正文全文（P2）"
                />
              </div>
              {/* P10-A：已删 / 归档 / 时间范围三件筛选收敛进单个下拉弹窗
                  （此前三钮并排越挤越长，类型 chips 被迫换行） */}
              <PostFilterPop
                deletedOnly={deletedOnly}
                onDeletedToggle={onDeletedToggle}
                archived={archived}
                onArchivedChange={onArchivedChange}
                range={range}
                onRangeConfirm={onRangeConfirm}
                onReset={onFilterReset}
                deletedCount={stats?.deleted ?? 0}
                archivedCount={stats?.archived ?? 0}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 帖子无限滚动区：grid 不再按筛选指纹重挂（2026-09-04）——
          筛选切换走 is-refetching 原位替换，入场动画只在新卡片挂载时播放；
          覆盖式滚动条（OverlayScroll，2026-09-07：不占宽 + 自动隐藏） */}
      <OverlayScroll
        className="list-scroll"
        scrollRef={listScrollRef}
        onScroll={(e) => onScroll(e.currentTarget.scrollTop)}
      >
        <div className="list-inner">
          {error ? (
            <StateBlock kind="error" variant="alert" text={error} />
          ) : posts.length === 0 ? (
            <StateBlock
              kind={loading ? 'loading' : 'empty'}
              variant="inline"
              text={loading ? '正在加载帖子…' : '暂无帖子，点击上方「抓取帖子」或「更新动态」获取'}
            />
          ) : (
            <div className={`post-grid${loading ? ' is-refetching' : ''}`}>
              {posts.map((p, i) => (
                <PostCard key={p.id} post={p} index={i} onOpen={onOpenPost} />
              ))}
            </div>
          )}

          {/* 无限滚动尾巴：哨兵驱动 IO 预载下一页；加载中/到底标记。
              Q2（批次 14，devlog/217）：尾巴进 **live region** —— 三种状态都是**异步出现**的，
              读屏用户原来一条都听不到（`aria-live` 全仓 0 命中）。可见文案保持原样（探针与
              几何都不受影响），另加一条 `sr-only` 的播报与一个**显式的「加载更多」按钮**。 */}
          {!error && posts.length > 0 && (
            <>
              <div ref={sentinelRef} className="load-sentinel" />
              <span className="sr-only" role="status" aria-live="polite">
                {loadingMore ? '正在加载更多帖子…'
                  : loadMoreError ? '加载更多失败，可以重试'
                    : !hasMore ? '已经到底了' : ''}
              </span>
              {loadingMore && (
                <div className="load-more-tip">
                  <Loader2 className="mr-2 inline size-4 animate-spin align-[-2px] text-primary" />{' '}
                  加载中…
                </div>
              )}
              {loadMoreError && (
                <div className="load-more-tip load-more-error">
                  <span>加载失败，</span>
                  <button type="button" onClick={onRetryLoadMore}>
                    重试
                  </button>
                </div>
              )}
              {!loadingMore && !loadMoreError && !hasMore && (
                <div className="load-end">已经到底啦</div>
              )}
              {!loadingMore && !loadMoreError && hasMore && (
                <div className="load-more-tip">
                  <button type="button" onClick={onLoadMore}>加载更多</button>
                </div>
              )}
            </>
          )}
        </div>
      </OverlayScroll>

      {/* 回顶浮钮：滚动深处浮现，一键回顶（view-body 为定位锚点） */}
      <button
        type="button"
        aria-label="回到顶部"
        className={`back-to-top${showTop ? ' on' : ''}`}
        onClick={() => listScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
      >
        <ChevronUp className="size-5" />
      </button>
    </>
  )
}
