import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, Plus, Search } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import AddVtuberDialog from './AddVtuberDialog'
import BatchFetchDialog from './BatchFetchDialog'
import OverlayScroll from './OverlayScroll'
import FloatPill from './common/FloatPill'
import { useLocation, useNavigate, matchPath } from 'react-router-dom'
import { api, resolveAsset } from '../api/api'
import type { AccountSnapshot, VTuber } from '../api/types'
import { mergeVtuberSnapshots } from '../utils/accountSnapshots'
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

/** 排序模式循环：默认（导入顺序）→ 粉丝数↓ → 名称拼音。
 *  本轮排序按钮从工具栏移除，逻辑保留——后续并入筛选下拉展开的浮窗。 */
export const SORT_CYCLE = ['default', 'followers', 'name'] as const
export type SortKey = (typeof SORT_CYCLE)[number]
export const SORT_LABEL: Record<SortKey, string> = {
  default: '默认',
  followers: '粉丝数',
  name: '名称',
}

/**
 * 常驻左栏：工具行（搜索 / 直播过滤 / 排序）+ VTuber 通栏列表。
 * 视觉参照 MomoTalk：零圆角零描边，发丝分隔线，选中=左缘主色竖条+浅粉底。
 * 过滤与排序均为纯前端计算；`/` 键聚焦搜索框。
 */
export default function VtuberSidebar() {
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
  // 排序逻辑保留（后续接入筛选浮窗）；当前恒为默认顺序
  const [sortKey] = useState<SortKey>('default')
  const [addOpen, setAddOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)

  const navigate = useNavigate()
  const location = useLocation()
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

  // 抓取任务结束（TopBar 轮询发现 running→空闲边沿）后自动刷新列表数据
  useEffect(() => {
    const onFetchIdle = () => load()
    window.addEventListener('ddtoolkit:fetch-idle', onFetchIdle)
    return () => window.removeEventListener('ddtoolkit:fetch-idle', onFetchIdle)
  }, [load])

  // 数据变更（解订阅 / 添加 VTuber）后刷新列表
  useEffect(() => {
    const onChanged = () => load()
    window.addEventListener('ddtoolkit:data-changed', onChanged)
    return () => window.removeEventListener('ddtoolkit:data-changed', onChanged)
  }, [load])

  // 抓取过程中每完成一条账号信息 → 用增量快照就地更新对应条目（零请求）
  useEffect(() => {
    const onProgress = (e: Event) => {
      const updates = (e as CustomEvent<AccountSnapshot[]>).detail
      if (!Array.isArray(updates) || updates.length === 0) return
      setVtubers((prev) => mergeSnapshots(prev, updates))
    }
    window.addEventListener('ddtoolkit:account-progress', onProgress)
    return () => window.removeEventListener('ddtoolkit:account-progress', onProgress)
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
      // 企划筛选激活时，无企划条目被排除（已知边界）
      list = list.filter((v) => !!v.faction && filters.faction.includes(v.faction))
    }
    if (kw) {
      list = list.filter(
        (v) =>
          v.name.toLowerCase().includes(kw) ||
          (biliAccount(v)?.sign ?? '').toLowerCase().includes(kw),
      )
    }
    if (sortKey === 'followers') {
      list = [...list].sort(
        (a, b) => (biliAccount(b)?.followers_count ?? -1) - (biliAccount(a)?.followers_count ?? -1),
      )
    } else if (sortKey === 'name') {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    }
    return list
  }, [vtubers, query, filters, sortKey])

  // 筛选弹窗选项：平台 / 企划从已载数据动态提取（企划剔除空值）
  const platformOptions = useMemo(
    () => [...new Set(vtubers.flatMap((v) => v.accounts.map((a) => a.platform)))],
    [vtubers],
  )
  const factionOptions = useMemo(
    () => [...new Set(vtubers.map((v) => v.faction).filter((f): f is string => !!f))],
    [vtubers],
  )
  const filterActive =
    filters.live.length > 0 || filters.platform.length > 0 || filters.faction.length > 0

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
      <div className="sidebar-shell">
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
      </div>
    )
  }

  if (error) {
    return (
      <div className="sidebar-shell">
        <OverlayScroll className="sidebar-list">
          <div className="sidebar-tip">加载失败：{error}</div>
        </OverlayScroll>
      </div>
    )
  }

  return (
    <div className="sidebar-shell">
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
            title="组合筛选（状态 / 平台 / 企划）"
            onClick={() => setFilterOpen((o) => !o)}
          >
            默认
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
      <OverlayScroll className="sidebar-list">
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
            />
          ))}
        </div>
      )}

      </OverlayScroll>

      <AddVtuberDialog open={addOpen} onOpenChange={setAddOpen} onAdded={load} />
      <BatchFetchDialog open={batchOpen} onOpenChange={setBatchOpen} />
    </div>
  )
}

interface VtuberItemProps {
  vtuber: VTuber
  /** 列表内序号：驱动依次入场动画（--rise-i） */
  index: number
  active: boolean
  onSelect: (id: number) => void
}

const VtuberItem = memo(function VtuberItem({ vtuber, index, active, onSelect }: VtuberItemProps) {
  const bili = biliAccount(vtuber)
  const avatarSrc = resolveAsset(bili?.avatar_path) ?? bili?.avatar_url ?? undefined
  const sign = bili?.sign ?? null
  const isLiveNow = (bili?.live_status ?? 0) === 1

  return (
    <div
      className={`vtuber-item anim-rise${active ? ' active' : ''}`}
      style={{ '--rise-i': index } as React.CSSProperties}
      onClick={() => onSelect(vtuber.id)}
    >
      <Avatar className="size-[58px] shrink-0">
        <AvatarImage src={avatarSrc} referrerPolicy="no-referrer" />
        <AvatarFallback>{vtuber.name.slice(0, 1)}</AvatarFallback>
      </Avatar>
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
      {/* 企划标识槽位（原阵营位）：预留挂载图片资源，后续接档案卡企划值 */}
      <div className="vtuber-emblem" aria-hidden />
    </div>
  )
})
