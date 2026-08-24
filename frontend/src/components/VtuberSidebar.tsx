import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, Plus, Search } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import AddVtuberDialog from './AddVtuberDialog'
import BatchFetchDialog from './BatchFetchDialog'
import { useLocation, useNavigate, matchPath } from 'react-router-dom'
import { api, resolveAsset } from '../api/api'
import type { AccountSnapshot, VTuber } from '../api/types'
import './../styles/layout.css'

/** 把抓取完成的账号快照就地合并进侧栏数据（按 bilibili platform_uid 匹配） */
function mergeSnapshots(list: VTuber[], updates: AccountSnapshot[]): VTuber[] {
  const byUid = new Map(updates.map((u) => [u.platform_uid, u]))
  return list.map((v) => {
    const bili = v.accounts.find((a) => a.platform === 'bilibili')
    const hit = bili ? byUid.get(bili.platform_uid) : undefined
    if (!bili || !hit) return v
    return {
      ...v,
      accounts: v.accounts.map((a) =>
        a.platform === 'bilibili' && a.platform_uid === hit.platform_uid
          ? {
              ...a,
              display_name: hit.display_name ?? a.display_name,
              sign: hit.sign ?? a.sign,
              followers_count: hit.followers_count ?? a.followers_count,
              live_status: hit.live_status ?? a.live_status,
              live_title: hit.live_title ?? a.live_title,
              avatar_path: hit.avatar_path ?? a.avatar_path,
            }
          : a,
      ),
    }
  })
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

/** 悬浮滚动条轨道的上下留白（避开吸顶工具行 / 贴底） */
const SB_TOP_PAD = 55
const SB_BOTTOM_PAD = 4

/**
 * 自绘悬浮滚动条状态：内容溢出时在滚动/拖拽期间浮现，静止 900ms 后渐隐。
 * 原生滚动行为不变，仅替换视觉。
 */
function useOverlayScrollbar(
  ref: React.RefObject<HTMLElement | null>,
  contentKey: unknown,
) {
  const [bar, setBar] = useState({ active: false, h: 0, y: 0 })
  const timer = useRef<number>()
  const drag = useRef<{ startY: number; startTop: number } | null>(null)

  const refresh = useCallback(() => {
    const el = ref.current
    if (!el) return
    const over = el.scrollHeight - el.clientHeight
    if (over <= 1) {
      setBar((s) => (s.active ? { ...s, active: false } : s))
      return
    }
    const track = el.clientHeight - SB_TOP_PAD - SB_BOTTOM_PAD
    const th = Math.max(40, (el.clientHeight / el.scrollHeight) * track)
    // 轨道容器自身已有 top:55 偏移，thumb 的 translateY 相对轨道计算，
    // 不再叠加 SB_TOP_PAD——ratio=0 时精确贴顶、ratio=1 时精确贴底
    const y = (el.scrollTop / over) * (track - th)
    setBar({ active: true, h: th, y })
    window.clearTimeout(timer.current)
    // 拖拽期间不渐隐
    if (!drag.current) {
      timer.current = window.setTimeout(
        () => setBar((s) => ({ ...s, active: false })),
        900,
      )
    }
  }, [ref])

  useEffect(() => {
    refresh()
  }, [refresh, contentKey])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener('scroll', refresh, { passive: true })
    const ro = new ResizeObserver(refresh)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', refresh)
      ro.disconnect()
      window.clearTimeout(timer.current)
    }
  }, [ref, refresh])

  const thumbProps = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      const el = ref.current
      if (!el) return
      drag.current = { startY: e.clientY, startTop: el.scrollTop }
      e.currentTarget.setPointerCapture(e.pointerId)
      e.preventDefault()
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const el = ref.current
      const d = drag.current
      if (!el || !d) return
      const track = el.clientHeight - SB_TOP_PAD - SB_BOTTOM_PAD
      const th = Math.max(40, (el.clientHeight / el.scrollHeight) * track)
      el.scrollTop =
        d.startTop +
        ((e.clientY - d.startY) * (el.scrollHeight - el.clientHeight)) /
          Math.max(track - th, 1)
    },
    onPointerUp: () => {
      drag.current = null
    },
    onPointerCancel: () => {
      drag.current = null
    },
  }

  return { bar, thumbProps }
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
  const [liveFilter, setLiveFilter] = useState<'all' | 'live' | 'offline'>('all')
  // 排序逻辑保留（后续接入筛选浮窗）；当前恒为默认顺序
  const [sortKey] = useState<SortKey>('default')
  const [addOpen, setAddOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)

  const navigate = useNavigate()
  const location = useLocation()
  const searchRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)

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
    if (liveFilter !== 'all') {
      list = list.filter((v) => (liveFilter === 'live' ? isLive(v) : !isLive(v)))
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
  }, [vtubers, query, liveFilter, sortKey])

  const matched = matchPath('/vtubers/:id', location.pathname)
  const { bar, thumbProps } = useOverlayScrollbar(sidebarRef, `${loading}|${filtered.length}`)

  // 稳定回调：memo 化的 VtuberItem 依赖它做浅比较，避免搜索/轮询每帧新建闭包
  const handleSelect = useCallback((id: number) => navigate(`/vtubers/${id}`), [navigate])

  if (loading) {
    return (
      <div className="sidebar-shell">
        <aside className="sidebar" ref={sidebarRef}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 p-2.5">
              <Skeleton className="size-10 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
          ))}
        </aside>
      </div>
    )
  }

  if (error) {
    return (
      <div className="sidebar-shell">
        <aside className="sidebar">
          <div className="sidebar-tip">加载失败：{error}</div>
        </aside>
      </div>
    )
  }

  return (
    <div className="sidebar-shell">
      <aside className="sidebar" ref={sidebarRef}>
        <div className="list-toolbar">
        <button
          type="button"
          className="list-float list-add-btn"
          title="添加 VTuber"
          onClick={() => setAddOpen(true)}
        >
          <Plus className="size-4" />
        </button>

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

        <Select value={liveFilter} onValueChange={(v) => setLiveFilter(v as typeof liveFilter)}>
          <SelectTrigger className="list-filter-btn [&>svg]:size-2.5 [&>svg]:opacity-70">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="live">直播中</SelectItem>
            <SelectItem value="offline">未直播</SelectItem>
          </SelectContent>
        </Select>

        <button
          type="button"
          className="list-float list-pull-btn"
          title="批量任务（抓取 / 更新 / 归档）"
          onClick={() => setBatchOpen(true)}
        >
          <Download className="size-4" />
        </button>
      </div>

      {vtubers.length === 0 && (
        <div className="sidebar-tip">暂无 VTuber，请先在后端导入名单（vtubers.csv flag=1）</div>
      )}

      {vtubers.length > 0 && filtered.length === 0 && (
        <div className="sidebar-tip">没有匹配「{query}」的 VTuber</div>
      )}

      {filtered.map((v) => (
        <VtuberItem
          key={v.id}
          vtuber={v}
          active={matched !== null && Number(matched.params.id) === v.id}
          onSelect={handleSelect}
        />
      ))}

      </aside>

      {/* 自绘悬浮滚动条：位于外壳层（不随内容滚动），半透明覆盖在条目上方 */}
      <div className="sidebar-sb" aria-hidden>
        <div
          className={`sidebar-sb-thumb${bar.active ? ' on' : ''}`}
          style={{ height: bar.h, transform: `translateY(${bar.y}px)` }}
          {...thumbProps}
        />
      </div>

      <AddVtuberDialog open={addOpen} onOpenChange={setAddOpen} onAdded={load} />
      <BatchFetchDialog open={batchOpen} onOpenChange={setBatchOpen} />
    </div>
  )
}

interface VtuberItemProps {
  vtuber: VTuber
  active: boolean
  onSelect: (id: number) => void
}

const VtuberItem = memo(function VtuberItem({ vtuber, active, onSelect }: VtuberItemProps) {
  const bili = biliAccount(vtuber)
  const avatarSrc = resolveAsset(bili?.avatar_path) ?? bili?.avatar_url ?? undefined
  const sign = bili?.sign ?? null
  const isLiveNow = (bili?.live_status ?? 0) === 1

  return (
    <div className={`vtuber-item${active ? ' active' : ''}`} onClick={() => onSelect(vtuber.id)}>
      <Avatar className="size-[65px] shrink-0">
        <AvatarImage src={avatarSrc} referrerPolicy="no-referrer" />
        <AvatarFallback>{vtuber.name.slice(0, 1)}</AvatarFallback>
      </Avatar>
      <div className="vtuber-info">
        <div className="vtuber-name-row">
          <span className="vtuber-name">{vtuber.name}</span>
          {isLiveNow && <i className="live-dot" title="直播中" />}
          {isLiveNow && <span className="live-label">直播中</span>}
        </div>
        {sign && <div className="vtuber-sign">{sign}</div>}
      </div>
      {/* 阵营标识槽位：预留挂载图片资源 */}
      <div className="vtuber-emblem" aria-hidden />
    </div>
  )
})
