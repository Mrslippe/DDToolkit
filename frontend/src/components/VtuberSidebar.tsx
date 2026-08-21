import { useCallback, useEffect, useState } from 'react'
import { Avatar, Spin } from 'antd'
import { useLocation, useNavigate, matchPath } from 'react-router-dom'
import { api, resolveAsset } from '../api/api'
import type { VTuber } from '../api/types'
import './../styles/layout.css'

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

  if (loading) {
    return (
      <aside className="sidebar">
        <div className="sidebar-tip">
          <Spin />
        </div>
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
        return (
          <VtuberItem
            key={v.id}
            vtuber={v}
            avatarSrc={avatarSrc}
            sign={bili?.sign ?? null}
            isLive={isLive}
            active={matchPath('/vtubers/:id', location.pathname) !== null &&
              Number(matchPath('/vtubers/:id', location.pathname)?.params.id) === v.id}
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
      <Avatar size={40} src={avatarSrc}>
        {vtuber.name.slice(0, 1)}
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
