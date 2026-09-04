import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '../api/api'
import type { Account, FanTrendPoint, GiftDay, LiveSession, ThirdpartyVtuber, VTuber } from '../api/types'
import FanTrendChart from './FanTrendChart'
import LiveCalendar from './LiveCalendar'
import ProfileCard from './ProfileCard'

interface Props {
  vtuber: VTuber
  account: Account | null
  /** fetch-idle 边沿：账号抓取完成后曲线/日历自动刷新 */
  refreshTick: number
}

/**
 * 档案视图（P5，与 cards/list 同级）：
 * 粉丝趋势曲线（双源）+ 直播日历（场次/礼物日）+ 档案卡（阵营/企划/设定集）。
 * 数据均按账号维度独立拉取（不参与列表预取门控，量小、打开即拉）。
 */
export default function ArchiveView({ vtuber, account, refreshTick }: Props) {
  const accountKey = account ? `${account.platform}:${account.platform_uid}` : null

  const [trend, setTrend] = useState<FanTrendPoint[]>([])
  const [sessions, setSessions] = useState<LiveSession[]>([])
  const [giftDays, setGiftDays] = useState<GiftDay[]>([])
  const [thirdparty, setThirdparty] = useState<ThirdpartyVtuber[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!account) {
      setTrend([])
      setSessions([])
      setGiftDays([])
      setThirdparty([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const uid = account.platform_uid
    Promise.all([
      api.fanTrend(account.id),
      api.liveSessions(account.id),
      api.giftDays(account.id),
      api.externalsVtuberByUid(uid),
    ])
      .then(([t, s, g, tp]) => {
        if (cancelled) return
        setTrend(t)
        setSessions(s)
        setGiftDays(g)
        setThirdparty(tp)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountKey, refreshTick, account?.id])

  const empty = !loading && trend.length === 0 && sessions.length === 0 && giftDays.length === 0

  return (
    <div className="archive-view">
      {loading && (
        <div className="posts-placeholder">
          <Loader2 className="mr-2 inline size-4 animate-spin align-[-2px] text-primary" />
          正在加载档案…
        </div>
      )}
      {error && !loading && <div className="archive-error">档案加载失败：{error}</div>}

      {!loading && !error && (
        <>
          <section className="archive-section">
            <div className="archive-section-head">
              <span className="archive-section-title">粉丝趋势</span>
              {trend.length > 0 && (
                <span className="archive-section-note">
                  {trend[trend.length - 1].date} 最新 {trend[trend.length - 1].fans.toLocaleString()} 粉
                </span>
              )}
            </div>
            {empty ? (
              <div className="archive-empty">暂无数据：等待账号抓取与第三方回填后出现</div>
            ) : (
              <FanTrendChart points={trend} />
            )}
          </section>

          <section className="archive-section">
            <div className="archive-section-head">
              <span className="archive-section-title">直播日历</span>
              <span className="archive-section-note">
                绿点=当日直播 · 满格=当日有礼物记录
              </span>
            </div>
            <LiveCalendar sessions={sessions} giftDays={giftDays} />
          </section>

          <section className="archive-section">
            <ProfileCard vtuber={vtuber} account={account} thirdparty={thirdparty} />
          </section>
        </>
      )}
    </div>
  )
}
