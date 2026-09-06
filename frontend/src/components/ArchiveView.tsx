import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '../api/api'
import type { Account, FanTrendPoint, GiftDay, LiveSession, VTuber } from '../api/types'
import AccountPicker from './AccountPicker'
import FanTrendChart from './FanTrendChart'
import LiveCalendar from './LiveCalendar'
import UpcomingEventsCard from './UpcomingEventsCard'

interface Props {
  vtuber: VTuber
  /** fetch-idle 边沿：账号抓取完成后曲线/日历自动刷新 */
  refreshTick: number
}

/** 卡片内部独立账号选择（默认 B站账号优先），各卡片互不影响；
    2026-09-05 起**不再接收页面级账号**——list 视图切账号不联动档案视图 */
function useArchiveAccount(vtuber: VTuber) {
  const accounts = useMemo(
    () => vtuber.accounts.filter((a) => a.platform_uid),
    [vtuber],
  )
  const defaultOf = (list: Account[]) =>
    list.find((a) => a.platform === 'bilibili' && a.platform_uid) ?? list[0] ?? null

  const [selected, setSelected] = useState<Account | null>(() => defaultOf(accounts))

  // VTuber 切换时重定默认（保留用户在同账号上已选的 id）
  useEffect(() => {
    setSelected((prev) => {
      if (prev && accounts.some((a) => a.id === prev.id)) return prev
      return defaultOf(accounts)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vtuber.id])

  return { accounts, selected: selected ?? defaultOf(accounts), setSelected }
}

/** 粉丝趋势卡：内部账号切换 + 独立拉取 */
function TrendCard({ vtuber, refreshTick }: { vtuber: VTuber; refreshTick: number }) {
  const { accounts, selected, setSelected } = useArchiveAccount(vtuber)
  const [trend, setTrend] = useState<FanTrendPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api.fanTrend(selected.id)
      .then((t) => !cancelled && setTrend(t))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [selected?.id, refreshTick])

  return (
    <section className="archive-section">
      <div className="archive-section-head">
        <span className="archive-section-title">粉丝趋势</span>
        <div className="archive-section-right">
          {trend.length > 0 && (
            <span className="archive-section-note">{trend[trend.length - 1].fans.toLocaleString()} 粉</span>
          )}
          <AccountPicker accounts={accounts} value={selected} onChange={setSelected} />
        </div>
      </div>
      {loading ? (
        <div className="archive-empty"><Loader2 className="mr-2 inline size-4 animate-spin align-[-2px] text-primary" />加载中…</div>
      ) : error ? (
        <div className="archive-error">{error}</div>
      ) : trend.length === 0 ? (
        <div className="archive-empty">暂无数据：等待账号抓取与第三方回填后出现</div>
      ) : (
        <FanTrendChart points={trend} />
      )}
    </section>
  )
}

/** 直播日历卡：内部账号切换 + 独立拉取（场次 + 礼物日） */
function CalendarCard({ vtuber, refreshTick }: { vtuber: VTuber; refreshTick: number }) {  const { accounts, selected, setSelected } = useArchiveAccount(vtuber)
  const [sessions, setSessions] = useState<LiveSession[]>([])
  const [giftDays, setGiftDays] = useState<GiftDay[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([api.liveSessions(selected.id), api.giftDays(selected.id)])
      .then(([s, g]) => {
        if (cancelled) return
        setSessions(s)
        setGiftDays(g)
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [selected?.id, refreshTick])

  return (
    <section className="archive-section archive-section--calendar">
      <div className="archive-section-head">
        <span className="archive-section-title">直播日历</span>
        <div className="archive-section-right">
          <span className="archive-section-note">绿点=当日直播 · 满格=礼物记录</span>
          <AccountPicker accounts={accounts} value={selected} onChange={setSelected} />
        </div>
      </div>
      {loading ? (
        <div className="archive-empty"><Loader2 className="mr-2 inline size-4 animate-spin align-[-2px] text-primary" />加载中…</div>
      ) : error ? (
        <div className="archive-error">{error}</div>
      ) : sessions.length === 0 && giftDays.length === 0 ? (
        <div className="archive-empty">暂无数据：等待账号抓取与第三方回填后出现</div>
      ) : (
        <LiveCalendar sessions={sessions} giftDays={giftDays} />
      )}
    </section>
  )
}

/** 档案卡包装：内部账号切换（企划查询 + 房间号跟随所选账号） */
/**
 * 档案视图（P5→P7，2026-09-06 布局改版）：
 * 上行双列 = 重要日期（窄 · vtuber 级，无账号切换器）+ 直播日历（宽）；
 * 下行全宽 = 粉丝趋势。
 * P7 布局参考用户图（重要日期 + 直播日历并排，趋势全宽在下）。
 * P7 追加：档案卡（企划/公会/设定）已移出到独立「档案」视图（ProfileView），
 * 此处仅保留 重要日期 / 直播日历 / 趋势。
 */
export default function ArchiveView({ vtuber, refreshTick }: Props) {
  return (
    <div className="archive-view">
      <div className="archive-grid-top">
        <UpcomingEventsCard vtuber={vtuber} refreshTick={refreshTick} />
        <CalendarCard vtuber={vtuber} refreshTick={refreshTick} />
      </div>
      <TrendCard vtuber={vtuber} refreshTick={refreshTick} />
    </div>
  )
}
