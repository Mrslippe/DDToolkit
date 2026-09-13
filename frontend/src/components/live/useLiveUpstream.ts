import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api/api'
import type { LiveUpstream } from '../../api/types'

/**
 * 场次详情里「必须打第三方」的那两格（弹幕词云 + 直播动态）的取数状态机。
 *
 * 2026-09-13（devlog/063）：这段取数原先挂在详情端点上，上游慢时**整个弹窗**
 * （含只依赖本地库的时间/分区/收益/分类）一起转圈 —— 而 danmakus 会间歇性变慢
 * （实测 1.1s ↔ 15.6s，最坏 3×30s 重试 ≈ 93s）。现在详情端点秒开，这一段自己
 * loading：慢与失败只影响弹幕/动态两格，且可就地重试。
 *
 * - 随 `liveId` 变化自动重取（切场次页签即重取；后端有 10 分钟进程内缓存，重取很便宜）；
 * - 请求**失败也不抛给调用方**：置 `failed`，弹幕段显示"没拉到 + 重试"
 *   （**不能**渲染成"本场没有弹幕"）；
 * - `elapsed`（秒）供 UI 说清"还在等"和"上游慢"的区别。
 */
export interface LiveUpstreamState {
  data: LiveUpstream | null
  loading: boolean
  /** 请求本身失败（HTTP/网络）——与"上游没给热词"是两回事 */
  failed: boolean
  /** 已等待秒数（loading 期间每秒自增） */
  elapsed: number
  reload: () => void
}

export function useLiveUpstream(
  accountId: number | null,
  liveId: string | null | undefined,
): LiveUpstreamState {
  const [data, setData] = useState<LiveUpstream | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  /** 防回写：切场次后旧响应不得覆盖新场次的数据 */
  const seq = useRef(0)
  /** 在途请求的取消器：切场次 / 关弹窗即 abort（上游最坏要等 90 多秒） */
  const ctrl = useRef<AbortController | null>(null)

  const load = useCallback(() => {
    if (accountId == null || !liveId) return
    /** 上一发还在路上就先掐掉：既省上游配额，也免得它回来把新场次的状态搅了 */
    ctrl.current?.abort()
    const ac = new AbortController()
    ctrl.current = ac
    const my = ++seq.current
    setLoading(true)
    setFailed(false)
    setElapsed(0)
    setData(null)
    api
      .liveSessionUpstream(accountId, liveId, ac.signal)
      .then((d) => {
        if (my === seq.current) setData(d)
      })
      .catch((e: unknown) => {
        // **主动取消不算失败**：不置 failed、不写"拉取失败"降级态，
        // 否则切场次会在新场次界面上闪一下"弹幕拉取失败"。
        if (ac.signal.aborted || (e as Error)?.name === 'AbortError') return
        if (my === seq.current) {
          setFailed(true)
          // 失败也要落到明确状态（否则弹幕段会停在"加载中"）
          setData({ danmaku: { wc_status: 'fetch_failed' }, metrics: null, events: [] })
        }
      })
      .finally(() => {
        if (my === seq.current) setLoading(false)
      })
  }, [accountId, liveId])

  useEffect(() => {
    load()
    // 卸载（关弹窗）或依赖变化（切场次/切账号）→ 取消在途请求
    return () => ctrl.current?.abort()
  }, [load])

  // 已等待秒数：只在 loading 期间走表，用于"上游较慢…"的文案
  useEffect(() => {
    if (!loading) return
    const t0 = Date.now()
    const id = window.setInterval(
      () => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [loading])

  return { data, loading, failed, elapsed, reload: load }
}
