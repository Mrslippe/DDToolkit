import { useCallback, useEffect, useState } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
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

/**
 * 常驻左栏：VTuber 纵向列表（头像 + 名字 + 签名），直播中显示红点。
 * 点击跳转 /vtubers/:id，右栏加载对应帖子；当前路由高亮。
 */
export default function VtuberSidebar() {
  const [vtubers, setVtubers] = useState<VTuber[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const location = useLocation()

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

  if (loading) {
    return (
      <aside className="sidebar">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg p-2.5">
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
        ))}
      </aside>
    )
  }

  if (error) {
    return (
      <aside className="sidebar">
        <div className="sidebar-tip">加载失败：{error}</div>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h3>VTuber 列表</h3>
        <span className="sidebar-count">共 {vtubers.length} 位</span>
      </div>

      {vtubers.length === 0 && (
        <div className="sidebar-tip">暂无 VTuber，请先在后端导入名单（vtubers.csv flag=1）</div>
      )}

      {vtubers.map((v) => {
        const bili = v.accounts.find((a) => a.platform === 'bilibili')
        const avatarSrc =
          resolveAsset(bili?.avatar_path) ?? bili?.avatar_url ?? undefined
        const isLive = (bili?.live_status ?? 0) === 1
        const matched = matchPath('/vtubers/:id', location.pathname)
        return (
          <VtuberItem
            key={v.id}
            vtuber={v}
            avatarSrc={avatarSrc}
            sign={bili?.sign ?? null}
            isLive={isLive}
            active={matched !== null && Number(matched.params.id) === v.id}
            onClick={() => navigate(`/vtubers/${v.id}`)}
          />
        )
      })}
    </aside>
  )
}

interface VtuberItemProps {
  vtuber: VTuber
  avatarSrc?: string
  sign: string | null
  isLive: boolean
  active: boolean
  onClick: () => void
}

function VtuberItem({ vtuber, avatarSrc, sign, isLive, active, onClick }: VtuberItemProps) {
  return (
    <div className={`vtuber-item${active ? ' active' : ''}`} onClick={onClick}>
      <Avatar className="size-10 shrink-0">
        <AvatarImage src={avatarSrc} referrerPolicy="no-referrer" />
        <AvatarFallback>{vtuber.name.slice(0, 1)}</AvatarFallback>
      </Avatar>
      <div className="vtuber-info">
        <div className="vtuber-name-row">
          <span className="vtuber-name">{vtuber.name}</span>
          {isLive && <i className="live-dot" title="直播中" />}
          {isLive && <span className="live-label">直播中</span>}
        </div>
        {sign && <div className="vtuber-sign">{sign}</div>}
      </div>
    </div>
  )
}
