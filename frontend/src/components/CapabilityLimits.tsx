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
import {
  availableSummary,
  isDisabled,
  limitBadge,
  loginActionLabel,
  limitsSummary,
} from '../utils/capabilities'

interface Props {
  caps: Capabilities | null
  /** 打开登录浮窗（顶栏已有，复用它） */
  onLogin: () => void
  /** 受控打开（L4 补：通知面板里那条「查看受限项」要能把这个窗叫出来）。
   *  不传 = 自持状态（顶栏那个按钮的老用法）。 */
  open?: boolean
  onOpenChange?: (v: boolean) => void
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
 *
 * ⚠️ 受控口（`open` / `onOpenChange`）：通知面板里那条 `open-limits` 动作也要打开**同一个**
 * 窗 —— 所以状态得能被外部驱动。默认仍是自持（不传就是老行为），两条路共用一份渲染，
 * 不新画一个副本（复述即负债）。
 */
export default function CapabilityLimits({ caps, onLogin, open: openProp,
                                          onOpenChange }: Props) {
  const [openSelf, setOpenSelf] = useState(false)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : openSelf
  const setOpen = (v: boolean) => {
    if (!controlled) setOpenSelf(v)
    onOpenChange?.(v)
  }
  const summary = limitsSummary(caps)
  if (!summary) return null

  const canDo = availableSummary(caps)

  // 说明窗的标题/正文按**受限的成因**分岔（devlog/338）：被我们自己的开关关掉的项
  // 与"没登录"不是一回事 —— 已登录的用户打开这个窗，看到的必须是"去打开开关"，
  // 而不是"未登录也能用大部分功能"（那句话会让他回头去重粘 Cookie）。
  const hasSwitchOff = (caps?.limited ?? []).some((l) => l.state === 'disabled')
  // 有没有**登录能解决**的受限项（决定页脚给不给"去登录"）
  const hasLoginLimit = (caps?.limited ?? []).some((l) => !isDisabled(caps, l.id))
  const loginCta = loginActionLabel(caps)

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
        {/* ⚠️ 三段式（页头 / 可滚的正文 / 页脚）**不是审美问题**（devlog/338）：
            `DialogContent` 是 `fixed top-50%` 垂直居中且**没有** max-height ⇒ 内容一长，
            页脚（「去登录」/「去设置」）就被推出视口 —— 探针量到的是"点不着"
            （`elementFromPoint` 落在视口外 ⇒ null），用户侧则是"看不到补救入口"。 */}
        <DialogContent className="cap-limits-dialog max-w-lg">
          <DialogHeader>
            <DialogTitle>{hasSwitchOff ? '能力范围与受限项' : '未登录时的能力范围'}</DialogTitle>
            <DialogDescription>
              {hasSwitchOff
                ? '下面标「未启用」的是我们自己的抓取开关关着（不是登录问题，粘 Cookie 不会改变它）；'
                  + '其余才与登录有关。每条都写了原因和补救办法。'
                : '未登录也能用大部分功能；只有需要写平台内容的那几项要登录。'
                  + '下面每条都写了原因和登录后的变化。'}
              {`（实测于 ${caps?.measured_at ?? '—'}）`}
            </DialogDescription>
          </DialogHeader>

          <div className="cap-limits-body">
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
                      {/* 角标按状态分三种说法（devlog/338 的真实反馈）：把"没登录"与"我们自己关了"
                          混成一句「需要登录」，用户就会去反复重粘 Cookie 而问题不在那儿。
                          `data-limit-state` 供 UI 探针把"状态→说法"钉在 DOM 上（不是看截图猜）。 */}
                      <em className={limitBadge(l.state).cls} data-limit-state={l.state}>
                        {limitBadge(l.state).text}
                      </em>
                    </span>
                    <span className="cap-limits-note">{l.note}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="cap-limits-foot">
            {/* R21 批 3：页脚统一浮片（原来那个 `.cap-login-cta` 自绘副本已删）。
                ⚠️ 「全是开关关着」时**不给登录按钮**（devlog/338）：能点的话用户就会去点，
                   而那条路的补救动作在设置里 —— 指错门比不给门更费时间。 */}
            {hasLoginLimit ? (
              <button
                type="button"
                className="float-pill float-pill--md float-pill--text on"
                onClick={() => {
                  setOpen(false)
                  onLogin()
                }}
              >
                {loginCta}
              </button>
            ) : (
              <span className="cap-limits-hint" data-cap-only-switch-off="1">
                这些项与登录无关：去「设置 → 抓取设置 → 平台抓取」打开对应开关
              </span>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
