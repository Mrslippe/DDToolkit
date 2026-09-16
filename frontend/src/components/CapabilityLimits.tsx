import { useState } from 'react'
import { Info } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Capabilities } from '../api/types'
import { availableSummary, loginActionLabel, limitsSummary } from '../utils/capabilities'

interface Props {
  caps: Capabilities | null
  /** 打开登录浮窗（顶栏已有，复用它） */
  onLogin: () => void
}

/**
 * 顶栏「未登录 · N 项受限」入口（devlog/086）。
 *
 * 三条口径：
 * 1. **没有限制就不渲染**（全可用时不该多一个按钮）；
 * 2. 说明窗**先列"现在还能做什么"**，再列受限项 —— 用户最需要知道的是这个；
 * 3. 每条限制都带后端给的 `note`（含"为什么"与"登录后多什么"），
 *    不在前端另编一套说法（单一事实来源在 `services/capabilities.py`）。
 *
 * ⚠️ DOM 契约（UI 探针 `--capabilities` 直接查）：按钮 `.topbar-limits`、
 * 计数 `.topbar-limits-count`、说明窗 `.cap-limits-dialog`、「去登录」`.cap-login-cta`。
 */
export default function CapabilityLimits({ caps, onLogin }: Props) {
  const [open, setOpen] = useState(false)
  const summary = limitsSummary(caps)
  if (!summary) return null

  const canDo = availableSummary(caps)

  return (
    <>
      <button
        type="button"
        className="topbar-limits"
        data-capability-limits={caps?.limited.length ?? 0}
        title={`${summary} —— 点开看哪些能用、哪些要登录`}
        onClick={() => setOpen(true)}
      >
        <Info className="size-[14px]" />
        <span className="topbar-limits-count">{summary}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="cap-limits-dialog max-w-lg">
          <DialogHeader>
            <DialogTitle>未登录时的能力范围</DialogTitle>
            <DialogDescription>
              未登录也能用大部分功能；只有需要写平台内容的那几项要登录。
              下面每条都写了原因和登录后的变化（实测于 {caps?.measured_at ?? '—'}）。
            </DialogDescription>
          </DialogHeader>

          {canDo.length > 0 && (
            <section className="cap-limits-sec">
              <h4 className="cap-limits-title">现在可以正常使用</h4>
              <ul className="cap-limits-list">
                {canDo.map((label) => (
                  <li key={label} className="cap-limits-ok">{label}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="cap-limits-sec">
            <h4 className="cap-limits-title">受限（{caps?.limited.length ?? 0}）</h4>
            <ul className="cap-limits-list">
              {caps?.limited.map((l) => (
                <li key={l.id} className="cap-limits-item" data-limit-id={l.id}>
                  <span className="cap-limits-label">
                    {l.label}
                    <em className={l.state === 'requires_login' ? 'req' : 'deg'}>
                      {l.state === 'requires_login' ? '需要登录' : '部分受限'}
                    </em>
                  </span>
                  <span className="cap-limits-note">{l.note}</span>
                </li>
              ))}
            </ul>
          </section>

          <div className="cap-limits-foot">
            {/* R21 批 3：页脚统一浮片（原来那个 `.cap-login-cta` 自绘副本已删） */}
            <button
              type="button"
              className="float-pill float-pill--md float-pill--text on"
              onClick={() => {
                setOpen(false)
                onLogin()
              }}
            >
              {loginActionLabel(caps)}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
