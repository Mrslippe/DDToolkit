import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import {
  cancelCollect, closeTaskWindow, dismissTask, requestAnalyze, useFanTask,
} from '../../hooks/useFanTask'

/**
 * 任务浮窗（2026-10-28，C 批）。
 *
 * ## 用户口径（两次修订后的最终版）
 *
 * - 形态：**应用内浮窗**（同「添加 Vtuber」那种 Dialog），不是 Tauri 第二扇窗；
 * - **不自动弹出**：点采集/分析后只出顶栏通知，**点通知**才打开这个窗；
 * - 右下角三个按钮：取消 / 完成 / 分析；**抓取中途「完成」「分析」都是灰的**；
 * - 关掉它**不影响任务**（store 在模块级，轮询照跑），顶栏通知还在；
 * - 「完成」= 关窗 + 回工作台（用户 2026-10-28 决策：**不自动分析**）。
 *
 * ## 为什么它是"纯渲染"
 *
 * 所有状态与动作都在 `hooks/useFanTask.ts`；这里只负责画。于是同一份 UI 将来
 * 塞进别的容器（比如右下角浮条）也不用重写逻辑。
 */

const PHASE_TEXT: Record<string, string> = {
  enumerate: '列场次', fetch: '拉取', aggregate: '解析', write: '落盘', verify: '校验',
  // 分析侧只有两个阶段（2026-10-28）：读盘逐场、之后是纯计算（没细粒度进度，不编数字）
  load: '读窗口', compute: '算分位 / 类型 / 标签',
}

export default function FanTaskDialog() {
  const s = useFanTask()
  const navigate = useNavigate()
  const [busyCancel, setBusyCancel] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const running = s.state === 'running'
  const p = s.progress ?? s.result
  const total = p?.total ?? 0
  const done = p?.done ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  const detail = p?.sessions_detail ?? []
  const failures = p?.failures ?? []

  const title = s.kind === 'analyze' ? '分析' : '采集'
  const onCancel = async () => {
    setErr(null); setBusyCancel(true)
    try { await cancelCollect() } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusyCancel(false) }
  }

  return (
    <Dialog open={s.openWindow} onOpenChange={(o) => { if (!o) closeTaskWindow() }}>
      <DialogContent className="wb-task-dialog" data-testid="fan-task-dialog">
        <DialogHeader>
          <DialogTitle>
            {/* ⚠️ 标题里**不放转圈图标**（2026-10-28 用户反馈：和标题挤/叠在一起）。
                弹窗里已经有「已处理 12/25 场」+ 顶部进度条，转圈是第三条重复信息。 */}
            {title}
            {s.vtuber ? ` · ${s.vtuber}` : ''}
          </DialogTitle>
        </DialogHeader>

        <div className="wb-task-body">
          <p className="wb-hint" data-testid="task-range">
            {s.since && s.until ? `${s.since} ~ ${s.until}` : '区间未知'}
            {total > 0 && ` · ${total} 场`}
          </p>

          <div className={`wb-bar wb-bar-lg${running && total === 0 ? ' is-indeterminate' : ''}`}
               role="progressbar" aria-valuemin={0} aria-valuemax={100}
               aria-valuenow={total > 0 ? pct : undefined} data-testid="task-bar">
            <span className="wb-bar-fill" style={{ width: total > 0 ? `${pct}%` : '100%' }} />
          </div>

          <p className="wb-hint" data-testid="task-summary">
            {running
              ? `已处理 ${done}/${total || '?'} 场`
                + (p && p.failed > 0 ? ` · 失败 ${p.failed}` : '')
                + (p && p.skipped > 0 ? ` · 跳过 ${p.skipped}` : '')
                + (p?.current ? ` · 当前 ${p.current}` : '')
              : s.state === 'failed' ? `失败：${s.error ?? '原因未知'}`
                : s.state === 'cancelled' ? '已取消'
                  : s.state === 'done' ? `完成 ${done} 场`
                    : '没有正在运行的任务'}
          </p>

          {/* 细粒度进度：阶段 / 翻页 / 吞吐 / ETA（后端 `CollectProgress` 已经在报这些） */}
          {running && p && (
            <p className="wb-hint wb-hint-detail" data-testid="task-phase">
              {p.phase ? `阶段：${PHASE_TEXT[p.phase] ?? p.phase}` : '准备中'}
              {p.phase === 'fetch' && (p.pages ?? 0) > 0 ? ` · 第 ${p.page || 1}/${p.pages} 页` : ''}
              {p.records ? ` · 已拉 ${p.records.toLocaleString()} 条` : ''}
              {p.throughput?.records_per_s
                ? ` · ${p.throughput.records_per_s.toLocaleString()} 条/秒` : ''}
              {p.eta_s != null ? ` · 预计剩余 ${Math.round(p.eta_s)} 秒` : ''}
            </p>
          )}

          {detail.length > 0 && (
            <ul className="wb-sess" data-testid="task-sessions">
              {detail.slice(-8).map((x) => (
                <li key={x.live_id} className={`wb-sess-item is-${x.state}`}>
                  <span className="wb-sess-dot" />
                  <span className="wb-sess-when">
                    {x.title || x.start_at || x.live_id.slice(0, 8)}
                  </span>
                  <span className="wb-sess-state">
                    {x.state === 'ok' ? '完成' : x.state === 'failed' ? '失败' : '进行中'}
                  </span>
                  <span className="wb-sess-rec">
                    {x.records ? `${x.records.toLocaleString()} 条` : ''}
                  </span>
                  {x.reason && <span className="wb-sess-reason">{x.reason}</span>}
                </li>
              ))}
            </ul>
          )}

          {!running && failures.length > 0 && (
            <ul className="wb-fails-list" data-testid="task-failures">
              {failures.slice(0, 8).map((f) => (
                <li key={f.live_id}>
                  <b>{String(f.start_at).slice(0, 16).replace('T', ' ')}</b> —— {f.reason}
                </li>
              ))}
            </ul>
          )}

          {err && <p className="wb-hint" role="alert" data-testid="task-error">{err}</p>}
        </div>

        <div className="wb-task-foot">
          <button type="button" className="wb-btn wb-btn-ghost" data-testid="task-cancel"
                  disabled={!running || busyCancel || s.kind === 'analyze'}
                  title={s.kind === 'analyze'
                    ? '分析是纯计算，没有中断点：点取消也要等当前阶段算完（后端暂不提供取消）'
                    : undefined}
                  onClick={() => void onCancel()}>
            取消
          </button>
          <button type="button" className="wb-btn wb-btn-ghost" data-testid="task-done"
                  disabled={running}
                  onClick={() => { closeTaskWindow(); dismissTask() }}>
            完成
          </button>
          {/* 「分析」只在**采集**浮窗里出现（2026-10-28 用户反馈：分析浮窗右下角不该再有分析）。
              分析任务自己跑完就是跑完了，重算请回工作台再点一次。 */}
          {s.kind !== 'analyze' && (
            <button type="button" className="wb-btn" data-testid="task-analyze"
                    disabled={running || s.state !== 'done'}
                    onClick={() => { requestAnalyze(); navigate('/workbench') }}>
              分析
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
