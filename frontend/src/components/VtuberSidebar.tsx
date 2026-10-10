import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, Plus, Search } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import AddVtuberDialog from './AddVtuberDialog'
import BatchFetchDialog from './BatchFetchDialog'
import OverlayScroll from './OverlayScroll'
import FloatPill from './common/FloatPill'
import ProxyImage from './common/ProxyImage'
import { useLocation, useNavigate, matchPath } from 'react-router-dom'
import { api, resolveAsset } from '../api/api'
import type { AccountSnapshot, VTuber } from '../api/types'
import { mergeVtuberSnapshots } from '../utils/accountSnapshots'
import { resolveAvatarSources } from '../utils/avatarSource'
import { resolveSign } from '../utils/signSource'
import { applyVtuberUpdate } from '../utils/vtuberList'
import {
  loadVtuberSortKey, saveVtuberSortKey, sortVtubers, VTUBER_SORT_KEYS, VTUBER_SORT_LABEL,
  type VtuberSortKey,
} from '../utils/vtuberSort'
import {
  applyVisibleOrder, DRAG_CANCEL_PX, DRAG_HOLD_MS, moveItem,
} from '../utils/vtuberReorder'
import { EVENTS, on } from '../utils/appEvents'
import { enterSolo, exitSolo, useSolo } from '../utils/soloMode'
import { nextStreak, type ClickStreak } from '../utils/soloGesture'
import { toggleRailCollapsed, useRailCollapsed } from '../utils/railCollapsed'
import { groupIcon, groupLabel, vtuberGroup, vtuberGroupOptions } from '../utils/groupBadge'
import './../styles/layout.css'

/** 把抓取完成的账号快照就地合并进侧栏数据（按 bilibili platform_uid 匹配） */
function mergeSnapshots(list: VTuber[], updates: AccountSnapshot[]): VTuber[] {
  return list.map((v) => mergeVtuberSnapshots(v, updates))
}

function biliAccount(v: VTuber) {
  return v.accounts.find((a) => a.platform === 'bilibili')
}

function isLive(v: VTuber): boolean {
  return (biliAccount(v)?.live_status ?? 0) === 1
}

/**
 * 常驻左栏：工具行（搜索 / 直播过滤 / 排序）+ VTuber 通栏列表。
 * 视觉参照 MomoTalk：零圆角零描边，发丝分隔线，选中=左缘主色竖条+浅粉底。
 * 过滤与排序均为纯前端计算；`/` 键聚焦搜索框。
 */
/**
 * 导出的是**外壳 + 内层**的组合：外壳管单推的收起与拉手，内层就是原来的左栏。
 *
 * ⚠️⚠️ **`.sidebar-shell` 只允许有这一个主人**（2026-10-08 用户报"左栏最后一条被挡住、
 * 滚轮不动、滚动条也不出现"，`devlog/448`）：内层从前也渲染了一层同名的外壳 ⇒ 外壳套外壳，
 * 而内层作为 flex item 会**继承 `.sidebar-shell` 的 `flex-shrink: 0`**（那条本是给横向宽度用的）
 * ⇒ 高度**不收缩、被内容撑开** ⇒ `.os-scroll` 的 `scrollHeight` 永远等于 `clientHeight`：
 * 滚轮无效、拇指不出现、条目直接溢出到窗口外被裁掉。
 * 所以内层（`VtuberSidebarInner`）只返回**片段** —— 滚动体必须是这一层的**直接子元素**。
 *
 * **单推的入口**（需求 1，2026-10-08 新口径，`devlog/450`）：不在工具栏那枚按钮上，而是
 * 「把某个 V 拖到左栏首位 + 在它上面 3 秒内连点 10 次」——手势在 `VtuberItem` 里，
 * 计数在 `utils/soloGesture.ts`（纯状态机）；判定要把这一栏交给路由上的那个 V。
 * 那枚按钮**只在单推模式下显示**，只用来退出。
 */
function SidebarFrame({ collapsed, showHandle, onTogglePeek, children }: {
  collapsed: boolean
  /** 拉手要不要渲染 —— ⚠️ **单推模式下不渲染**（用户 2026-10-08 口径：需求 1.1） */
  showHandle: boolean
  onTogglePeek: () => void
  children: React.ReactNode
}) {
  return (
    <div className="sidebar-shell" data-collapsed={collapsed ? '1' : undefined}>
      {children}
      {/* 拉手：**常驻功能**（用户口径「收起展开是常驻功能」——不再只在单推里存在），
          但**单推模式下不渲染**（需求 1.1：单推里整栏本来就收走了，提手是多余的）。
          ⚠️ 它是**常态隐藏**的：`opacity: 0`，鼠标悬到那条窄边（或键盘 Tab 到它）才现身。
          收起时它贴着内容左缘（`left: 100%`，此时这一栏已被负外边距推出视口），
          展开时贴栏的右缘 ⇒ 同一套定位，两种状态都在"内容区的左边缘"上。 */}
      {showHandle && (
        <button
          type="button"
          className="solo-rail-handle"
          data-testid="solo-rail-handle"
          aria-label={collapsed ? '展开 V 列表' : '收起 V 列表'}
          aria-expanded={!collapsed}
          onClick={onTogglePeek}
        >
          {collapsed
            ? <ChevronRight className="h-3.5 w-3.5" />
            : <ChevronLeft className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  )
}

function VtuberSidebarInner({ onSoloGesture }: {
  /** 连点手势命中 ⇒ 交给外壳进单推（`devlog/450`） */
  onSoloGesture?: (id: number) => void
} = {}) {
  const [vtubers, setVtubers] = useState<VTuber[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  // 组合筛选：组内多选 OR、组间 AND，空数组=该组不生效（替代原单选直播过滤）
  type FilterState = { live: string[]; platform: string[]; faction: string[] }
  const EMPTY_FILTERS: FilterState = { live: [], platform: [], faction: [] }
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [filterOpen, setFilterOpen] = useState(false)
  const filterWrapRef = useRef<HTMLDivElement>(null)
  // 排序（需求 5，`devlog/414`）：六档，落在筛选浮窗里；偏好与 `playerPrefs` 同套路走 localStorage
  const [sortKey, setSortKey] = useState<VtuberSortKey>(() => loadVtuberSortKey())
  const pickSort = useCallback((k: VtuberSortKey) => {
    setSortKey(k)
    saveVtuberSortKey(k)
  }, [])


  // ── 按住拖动重排（需求 4，2026-10-07，`devlog/415`）────────────────────
  /** 正在拖的那条（`null` = 没在拖）—— 也是"拖拽态"的唯一真源（CSS 与点击都看它） */
  const [dragId, setDragId] = useState<number | null>(null)
  /** "按住"判定：350ms 内指针挪超 `DRAG_CANCEL_PX` 就当滚动/框选，取消 */
  const holdRef = useRef<{ x: number; y: number; timer: number } | null>(null)
  /** 拖拽期间要读**当前**可见顺序（闭包里的 `filtered` 是旧值） */
  const visibleRef = useRef<VTuber[]>([])

  const beginHold = useCallback((id: number, e: React.PointerEvent) => {
    if (e.button !== 0) return
    const x = e.clientX
    const y = e.clientY
    const stop = () => {
      const h = holdRef.current
      if (h) window.clearTimeout(h.timer)
      holdRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
    }
    const onMove = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - x, ev.clientY - y) > DRAG_CANCEL_PX) stop()
    }
    holdRef.current = {
      x, y,
      timer: window.setTimeout(() => {
        stop()
        /* ⚠️ **任何档位下拖一下就生效**（用户 2026-10-07 拍板）：进拖拽态的同一拍切到"自定义"。
           否则用户在"粉丝数"档下拖半天没反应，只会以为坏了。 */
        pickSort('custom')
        setDragId(id)
      }, DRAG_HOLD_MS),
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
  }, [pickSort])
  const [addOpen, setAddOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)

  const navigate = useNavigate()
  const location = useLocation()

  /* 单推模式（需求 6，`devlog/429`）：两条兜底 ——
     ① 单推的那个 V **被解绑了** ⇒ 自动退出（否则模式指向一个不存在的 V，内容区卡在空态）；
        ⚠️ 必须等列表**非空**再判，否则"还没加载完"会被当成"这个 V 没了"；
     ② 冷启动时路由是 `/`（单推那份状态是持久的）⇒ 把内容带到那个 V 上。 */
  const solo = useSolo()
  useEffect(() => {
    if (solo && vtubers.length > 0 && !vtubers.some((v) => v.id === solo.id)) exitSolo()
  }, [solo, vtubers])
  useEffect(() => {
    if (solo && !matchPath('/vtubers/:id', location.pathname)) navigate(`/vtubers/${solo.id}`)
  }, [solo, location.pathname, navigate])
  const searchRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    api
      .listVtubers()
      .then((data) => setVtubers(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /** 拖拽结束：把**当前可见顺序**整条交给后端（没显示的那些由后端原地不动） */
  const commitDrag = useCallback(() => {
    const order = visibleRef.current.map((v) => v.id)
    setDragId(null)
    if (order.length === 0) return
    void api.reorderVtubers(order).catch(() => {
      /* 落库失败 ⇒ 拉回服务端顺序（乐观渲染到此为止）。⚠️ **不许静默**：
         这里吞的是"拖了但没保存"，下一轮用户会说"拖完刷新就变回去了" —— 所以重拉即还原。 */
      load()
    })
  }, [load])

  useEffect(() => {
    if (dragId == null) return
    const onMove = (ev: PointerEvent) => {
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)
        ?.closest('[data-vtuber-id]') as HTMLElement | null
      const to = Number(hit?.dataset.index ?? NaN)
      if (!Number.isFinite(to)) return
      const cur = visibleRef.current
      const from = cur.findIndex((v) => v.id === dragId)
      if (from < 0 || from === to) return
      const next = moveItem(cur, from, to)
      /* 乐观渲染：把"可见那几条的新顺序"**填回**完整列表 —— 与后端 `VTuberRepo.reorder`
         同一套语义（两边算得不一样的话，落库后再拉一次列表顺序会当场跳一下）。 */
      setVtubers((alls) => applyVisibleOrder(alls, next.map((v) => v.id)))
    }
    const onUp = () => commitDrag()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragId, commitDrag])

  // 抓取任务结束（TopBar 轮询发现 running→空闲边沿）后自动刷新列表数据
  useEffect(() => {
    const off = on(EVENTS.fetchIdle, () => load())
    return off
  }, [load])

  /**
   * R33 补（2026-09-19，用户：「修改过的签名左栏没有及时同步」）：
   * 「档案设置」保存后广播一条 `ddtoolkit:vtuber-updated`，这里**就地更新**那一行。
   * 为什么不是重新 `load()`：整表重拉会让左栏闪一下（loading 态 + 重排），
   * 而这次改的只有一个 V 的几个字段 ⇒ 就地合并最稳（合并逻辑是纯函数，有单测）。
   */
  useEffect(() => {
    const off = on(EVENTS.vtuberUpdated, (v) => {
      setVtubers((prev) => applyVtuberUpdate(prev, v))
    })
    return off
  }, [])

  // 数据变更（解订阅 / 添加 VTuber）后刷新列表
  useEffect(() => {
    const off = on(EVENTS.dataChanged, () => load())
    return off
  }, [load])

  // 抓取过程中每完成一条账号信息 → 用增量快照就地更新对应条目（零请求）
  useEffect(() => {
    const off = on(EVENTS.accountProgress, (updates) => {
      if (!Array.isArray(updates) || updates.length === 0) return
      setVtubers((prev) => mergeSnapshots(prev, updates))
    })
    return off
  }, [])

  // `/` 快捷键聚焦搜索框（输入框内不劫持）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/') return
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase()
    let list = vtubers
    if (filters.live.length > 0) {
      list = list.filter((v) => filters.live.includes(isLive(v) ? 'live' : 'offline'))
    }
    if (filters.platform.length > 0) {
      list = list.filter((v) => v.accounts.some((a) => filters.platform.includes(a.platform)))
    }
    if (filters.faction.length > 0) {
      // 企划筛选激活时，无企划条目被排除（已知边界）。
      // ⚠️ 判据是 **`vtuberGroup(v)`**（手填 faction 优先、否则自动检测的 group_name）——
      //    与徽章同一个函数。只读 `v.faction` 时，只有 `group_name` 的那几位
      //    **徽章上写着企划、筛选里却找不到**（2026-10-10 用户报的"四禧丸子只出一个人"）。
      list = list.filter((v) => {
        const g = vtuberGroup(v)
        return !!g && filters.faction.includes(g)
      })
    }
    if (kw) {
      list = list.filter(
        (v) =>
          v.name.toLowerCase().includes(kw) ||
          (biliAccount(v)?.sign ?? '').toLowerCase().includes(kw),
      )
    }
    // ⚠️ 排序在**筛选之后**做（顺序不能反：`custom` 是"后端给的顺序原样"，
    //    先排会把它按别的键打乱；而 `default`/`name` 等本来就与筛选无关）
    return sortVtubers(list, sortKey)
  }, [vtubers, query, filters, sortKey])

  /* 拖拽期间要读"当前"可见顺序 ⇒ 每帧同步进 ref（`filtered` 在闭包里永远是旧值） */
  useEffect(() => { visibleRef.current = filtered }, [filtered])

  // 筛选弹窗选项：平台 / 企划从已载数据动态提取（企划剔除空值）
  const platformOptions = useMemo(
    () => [...new Set(vtubers.flatMap((v) => v.accounts.map((a) => a.platform)))],
    [vtubers],
  )
  const factionOptions = useMemo(
    // ⚠️ 选项与匹配必须同一口径（`vtuberGroup`）：只从 `faction` 提取时，只有
    // `group_name` 的那几个企划**根本不会出现在选项里**（更别说筛出来）—— 见该函数的说明。
    () => vtuberGroupOptions(vtubers),
    [vtubers],
  )
  const filterCount =
    filters.live.length + filters.platform.length + filters.faction.length
  const filterActive = filterCount > 0

  // 组内多选切换（即时生效，无应用钮）
  const toggleFilter = useCallback((group: keyof FilterState, value: string) => {
    setFilters((prev) => {
      const cur = prev[group]
      const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]
      return { ...prev, [group]: next }
    })
  }, [])

  // 筛选弹窗：点击面板外自动关闭（与帖子页 time-pop 同模式）+ Esc 双通道
  useEffect(() => {
    if (!filterOpen) return
    const onDown = (e: MouseEvent) => {
      if (filterWrapRef.current && !filterWrapRef.current.contains(e.target as Node)) {
        setFilterOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFilterOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [filterOpen])

  const matched = matchPath('/vtubers/:id', location.pathname)

  // 稳定回调：memo 化的 VtuberItem 依赖它做浅比较，避免搜索/轮询每帧新建闭包
  const handleSelect = useCallback((id: number) => navigate(`/vtubers/${id}`), [navigate])

  if (loading) {
    return (
      <OverlayScroll className="sidebar-list">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 p-2.5">
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
        ))}
      </OverlayScroll>
    )
  }

  if (error) {
    return (
      <OverlayScroll className="sidebar-list">
        <div className="sidebar-tip">加载失败：{error}</div>
      </OverlayScroll>
    )
  }

  return (
    <>
      <div className="list-toolbar">
        <FloatPill shape="icon" className="list-add-btn" title="添加 VTuber" onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
        </FloatPill>

        <div className="list-search-wrap">
          <Search className="list-search-icon size-2.5" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索 名字 / 签名"
            className="list-search"
          />
        </div>

        <div className="filter-wrap" ref={filterWrapRef}>
          <FloatPill
            shape="text"
            active={filterActive}
            className="list-filter-btn"
            title="筛选（状态 / 平台 / 企划）与排序"
            onClick={() => setFilterOpen((o) => !o)}
          >
            {filterCount > 0 ? `筛选 · ${filterCount}` : VTUBER_SORT_LABEL[sortKey]}
            <svg
              className="pill-caret"
              viewBox="0 0 6.63232 6.63232"
              width="6.632324"
              height="6.632324"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden
            >
              <path
                d="M5.96034 0.5L0.960327 0.500005L4.46033 5.5L5.96034 0.5Z"
                fill="currentColor"
                fillRule="evenodd"
              />
              <path
                d="M5.96034 0.5L4.46033 5.5L0.960327 0.500005L5.96034 0.5Z"
                fillRule="evenodd"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          </FloatPill>
          {filterOpen && (
            <div className="filter-pop">
              <div className="pop-group">
                <span className="pop-label">状态</span>
                <div className="pop-chips">
                  <button
                    type="button"
                    className={`filter-chip${filters.live.includes('live') ? ' on' : ''}`}
                    onClick={() => toggleFilter('live', 'live')}
                  >
                    直播中
                  </button>
                  <button
                    type="button"
                    className={`filter-chip${filters.live.includes('offline') ? ' on' : ''}`}
                    onClick={() => toggleFilter('live', 'offline')}
                  >
                    未直播
                  </button>
                </div>
              </div>
              {platformOptions.length > 0 && (
                <div className="pop-group">
                  <span className="pop-label">平台</span>
                  <div className="pop-chips">
                    {platformOptions.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={`filter-chip${filters.platform.includes(p) ? ' on' : ''}`}
                        onClick={() => toggleFilter('platform', p)}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {factionOptions.length > 0 && (
                <div className="pop-group">
                  <span className="pop-label">企划</span>
                  <div className="pop-chips">
                    {factionOptions.map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={`filter-chip${filters.faction.includes(f) ? ' on' : ''}`}
                        onClick={() => toggleFilter('faction', f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="pop-group">
                <span className="pop-label">排序</span>
                <div className="pop-chips">
                  {VTUBER_SORT_KEYS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={`filter-chip${sortKey === k ? ' on' : ''}`}
                      onClick={() => pickSort(k)}
                    >
                      {VTUBER_SORT_LABEL[k]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="pop-actions">
                <button type="button" onClick={() => setFilters(EMPTY_FILTERS)}>
                  重置
                </button>
              </div>
            </div>
          )}
        </div>

        <FloatPill
          shape="icon"
          className="list-pull-btn"
          title="批量任务（抓取 / 更新 / 归档）"
          onClick={() => setBatchOpen(true)}
        >
          <Download className="size-4" />
        </FloatPill>
      </div>

      {/* 列表滚动区：覆盖式滚动条（不占宽 + 自动隐藏，UI-MAP F 节标准） */}
      <OverlayScroll className={`sidebar-list${dragId != null ? ' is-dragging' : ''}`}>
      {vtubers.length === 0 && (
        <div className="sidebar-tip">暂无 VTuber，请先在后端导入名单（vtubers.csv flag=1）</div>
      )}

      {vtubers.length > 0 && filtered.length === 0 && (
        <div className="sidebar-tip">没有匹配「{query}」的 VTuber</div>
      )}

      {filtered.length > 0 && (
        <div
          className="vtuber-list"
          key={`${query}|${filters.live.join(',')}|${filters.platform.join(',')}|${filters.faction.join(',')}|${vtubers.length}`}
        >
          {filtered.map((v, i) => (
            <VtuberItem
              key={v.id}
              vtuber={v}
              index={i}
              active={matched !== null && Number(matched.params.id) === v.id}
              onSelect={handleSelect}
              onSoloGesture={onSoloGesture}
              dragging={dragId === v.id}
              onHoldStart={beginHold}
            />
          ))}
        </div>
      )}

      </OverlayScroll>

      <AddVtuberDialog open={addOpen} onOpenChange={setAddOpen} onAdded={load} />
      <BatchFetchDialog open={batchOpen} onOpenChange={setBatchOpen} />
    </>
  )
}

interface VtuberItemProps {
  vtuber: VTuber
  /** 列表内序号：驱动依次入场动画（--rise-i）；**也是拖拽落点的判据**（`data-index`） */
  index: number
  active: boolean
  onSelect: (id: number) => void
  /** 正在被拖（`devlog/415`） */
  dragging?: boolean
  /** 指针按下 ⇒ 交给父级判"按住"（350ms 不动才算拖） */
  onHoldStart?: (id: number, e: React.PointerEvent) => void
  /** 连点手势命中（**只在首位生效**）⇒ 进单推（需求 1，`devlog/450`） */
  onSoloGesture?: (id: number) => void
}

const VtuberItem = memo(function VtuberItem({ vtuber, index, active, onSelect,
                                               dragging = false, onHoldStart,
                                               onSoloGesture }: VtuberItemProps) {
  const bili = biliAccount(vtuber)
  // 头像/签名与卡片**同一条链**（devlog/135）：用户在档案设置里换过的头像与签名，
  // 左栏必须跟着变 —— 此前左栏各写了一份"只看平台字段"的取值，于是设置看着像没生效。
  const { src: avatarSrc, local: avatarLocalPath } = resolveAvatarSources(vtuber, vtuber.accounts)
  // A0（devlog/255）：**本地副本**当第三级回落（直连 → 代理 → 本地 → 占位）。
  // 远端 URL 会死（实测某 V 的微博头像签名过期 21 小时后只靠代理缓存续命），而盘上那份一直在
  // —— 左栏是"一眼看见"的地方，最不该在这里破图。
  const avatarLocal = resolveAsset(avatarLocalPath)
  const sign = resolveSign(vtuber, vtuber.accounts).text || null
  const isLiveNow = (bili?.live_status ?? 0) === 1
  // 企划徽章（B3）：`vtuberGroup` = **手填的 faction 优先，否则自动检测的 group_name**
  // ——与筛选弹窗同一个口径（此前徽章只看 group_name、筛选只看 faction，两者会互相打架）
  const group = vtuberGroup(vtuber)
  const icon = group ? groupIcon(group) : null

  /* ── 连点进单推（需求 1，2026-10-08 用户口径，`devlog/450`）─────────────────
     口径：先把 V **拖到左栏首位**，然后在**那一条**上 3 秒内连点 10 次 ⇒ 进单推。
     ⚠️ 只在**首位**（`index === 0`）计数 —— 别的条目照旧"点一下就进详情"，不多一次判断；
     ⚠️ 计数是**每个条目实例**各一份（`useRef`），换 V 的关键字变化不会把它带到别人身上；
     ⚠️ 命中那一次**不再走 `onSelect`**：进单推本来就会把位置带到这个 V（外壳里做），
        再走一次导航只是多余的（也会让 `prevRoute` 变得不确定）。 */
  const streakRef = useRef<ClickStreak | null>(null)
  const handleClick = () => {
    if (index === 0 && onSoloGesture) {
      const { streak, hit } = nextStreak(streakRef.current, Date.now())
      streakRef.current = hit ? null : streak
      if (hit) {
        onSoloGesture(vtuber.id)
        return
      }
    }
    onSelect(vtuber.id)
  }

  return (
    <div
      className={`vtuber-item anim-rise${active ? ' active' : ''}${dragging ? ' dragging' : ''}`}
      style={{ '--rise-i': index } as React.CSSProperties}
      onClick={handleClick}
      onPointerDown={(e) => onHoldStart?.(vtuber.id, e)}
      /* 拖拽落点靠这两个属性（`elementFromPoint` → `closest('[data-vtuber-id]')` → `data-index`）：
         与平台徽章那套同一个办法（`devlog/048`），不手算几何 */
      data-index={index}
      data-vtuber-id={vtuber.id}
      /* `data-src` 是**为可测性存在**的（devlog/135，同 `.stat-sets[data-hover]` 的先例）：
          探针跑在虚拟时间下，图片加载不会完成 ⇒ "左栏头像跟没跟档案设置"就量不到。
          这里把**解析出来的 src（口径）**挂在行上；**渲染出来的 src（接线）**由
          `ProxyImage` 的 `data-render-src` 给出（R46 起两者分开：口径对而渲染路分叉，
          正是 R46 那个 bug 的形态）。 */
      data-src={avatarSrc ?? ''}
    >
      {/* 头像走 `ProxyImage`（R46，devlog/249）—— 与右栏 hero **同一个渲染器**。
          此前这里是 radix `Avatar` + `AvatarImage`：裸 `<img>` 直连，微博图床防盗链
          一律 403 ⇒ 在档案设置里选了微博头像后**右栏变了、左栏变灰底首字**。
          取值链（`resolveAvatar`）当时已经同源（devlog/135），漂的是**渲染**这一层。 */}
      <ProxyImage
        className="vtuber-avatar"
        alt={vtuber.name}
        src={avatarSrc}
        fallbackSrc={avatarLocal}
        fallbackClassName="vtuber-avatar vtuber-avatar-fallback"
        fallback={<span>{vtuber.name.slice(0, 1)}</span>}
      />
      <div className="vtuber-info">
        <div className="vtuber-name-row">
          <span className="vtuber-name">{vtuber.name}</span>
          {isLiveNow && (
            <span className="live-badge" title="直播中">
              <i className="live-dot" />
              <span className="live-label">直播中</span>
            </span>
          )}
        </div>
        {sign && <div className="vtuber-sign">{sign}</div>}
      </div>
      {/* 企划徽章（需求 6，B3，`devlog/457`）：这个槽位本来就是给它留的（"原阵营位"）。
          规则是**数据驱动**的：`assets/groups/<slug>.*` 有素材就画图标，没有就显示企划名的
          文字胶囊（超长省略、`title` 给全名）—— 加一个企划只需丢一个文件，不改代码。
          没有企划的 V **什么都不渲染**（不摆空壳）；窄栏（收起态）由 CSS 整块隐藏，
          免得挤掉名字。 */}
      {group && (
        <span className="vtuber-emblem" data-group={group} title={`企划：${group}`}>
          {icon ? (
            <img className="vtuber-emblem-icon" src={icon} alt="" />
          ) : (
            <span className="vtuber-emblem-text">{groupLabel(group)}</span>
          )}
        </span>
      )}
    </div>
  )
})


/**
 * 导出的是**外壳 + 内层**的组合：外壳管单推的收起与拉手，内层就是原来的左栏（一行没动）。
 * `peek` 是"临时展开一眼"——它不是退出单推（退出只能点工具栏那枚按钮）。
 */
export default function VtuberSidebar() {
  const solo = useSolo()
  const manual = useRailCollapsed()
  const location = useLocation()
  const navigate = useNavigate()
  const [peek, setPeek] = useState(false)
  // 换 V / 退出单推 ⇒ 把"临时展开"收回去（下次进来仍然是从收起态开始）
  useEffect(() => { setPeek(false) }, [solo?.id])
  /* 收起 = **单推强制** ∨ **用户自己收起过**；`peek` 是"临时看一眼"（单推里点拉手）。
     ⚠️ 单推**不改** `manual` —— 退出后回到用户自己的偏好（`devlog/429` 的"退出回到进入前"）。 */
  const collapsed = !peek && (Boolean(solo) || manual)
  /** 连点手势命中 ⇒ 进单推：对象是**那一条**，`prevRoute` 记当前位置（退出时回得来）。 */
  const enterSoloByGesture = useCallback((id: number) => {
    enterSolo(id, location.pathname)
    navigate(`/vtubers/${id}`)
  }, [location.pathname, navigate])
  return (
    <SidebarFrame collapsed={collapsed}
                  showHandle={!solo}
                  onTogglePeek={() => (solo ? setPeek((p) => !p) : toggleRailCollapsed())}>
      <VtuberSidebarInner onSoloGesture={enterSoloByGesture} />
    </SidebarFrame>
  )
}