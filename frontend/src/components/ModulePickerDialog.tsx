import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import FloatPill from './common/FloatPill'
import { APP_MODULES, isModuleOn } from '../utils/modules'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前偏好值（`on`/`off`） */
  values: Record<string, string>
  /** 确认时把勾选结果一次写回 */
  onConfirm: (next: Record<string, string>) => Promise<void>
  /** 写失败时的原因（外层负责弹 toast，这里只禁止关窗） */
  error?: string | null
}

/**
 * 「添加模块」弹窗（2026-10-18，用户口径）。
 *
 * 形态：一串模块 + 勾选；底部「取消 / 确认」。**草稿制** —— 勾选只改本地草稿，
 * 点「确认」才写偏好；取消则丢弃草稿（与 `DateRangePicker` 同一套做法）。
 *
 * ⚠️ 写失败时**不关窗**（`error` 由外层传入）：关掉会让用户以为成功了。
 */
export default function ModulePickerDialog({ open, onOpenChange, values,
                                            onConfirm, error }: Props) {
  const [draft, setDraft] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  // 每次打开都从当前偏好重来（不泄漏上次取消掉的草稿）
  useEffect(() => {
    if (!open) return
    const next: Record<string, boolean> = {}
    for (const m of APP_MODULES) next[m.key] = isModuleOn(values, m.key)
    setDraft(next)
    setBusy(false)
  }, [open, values])

  const toggle = (key: string) => setDraft((d) => ({ ...d, [key]: !d[key] }))

  const confirm = async () => {
    const next: Record<string, string> = {}
    for (const m of APP_MODULES) next[m.key] = draft[m.key] ? 'on' : 'off'
    setBusy(true)
    try {
      await onConfirm(next)
      onOpenChange(false)
    } catch {
      // 外层会通过 `error` 显示原因；这里保持开着
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="module-picker">
        <DialogHeader>
          <DialogTitle>添加模块</DialogTitle>
          <DialogDescription>
            勾选要显示的模块，确认后会出现在左侧工具栏。随时可以在这里取消。
          </DialogDescription>
        </DialogHeader>

        <ul className="my-2 space-y-2">
          {APP_MODULES.map((m) => {
            const on = Boolean(draft[m.key])
            return (
              <li key={m.key}>
                <button
                  type="button"
                  onClick={() => toggle(m.key)}
                  aria-pressed={on}
                  data-testid={`module-option-${m.key}`}
                  className={`flex w-full items-start gap-3 rounded border px-3 py-2 text-left transition ${
                    on ? 'border-neutral-900 bg-neutral-50' : 'border-neutral-200 hover:bg-neutral-50'
                  }`}
                >
                  <span
                    aria-hidden
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
                      on ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300'
                    }`}
                  >
                    {on && (
                      <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none"
                           stroke="currentColor" strokeWidth="2">
                        <path d="M2 6.5 4.5 9 10 3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{m.label}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-neutral-500">
                      {m.desc}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        {error && (
          <p className="text-xs text-red-600" data-testid="module-picker-error">{error}</p>
        )}

        <DialogFooter className="gap-2">
          {/* 页脚按钮必须是 `FloatPill`（全站唯一交互层元件，契约见 UI-MAP §C5）；
              主操作带 `active` —— 两个按钮不能一样重（`dialogFoot.test.ts` 判这条）。 */}
          <FloatPill size="md" shape="text" onClick={() => onOpenChange(false)}
                     data-testid="module-picker-cancel">取消</FloatPill>
          <FloatPill size="md" shape="text" active disabled={busy}
                     onClick={() => void confirm()}
                     data-testid="module-picker-confirm">
            {busy ? '保存中…' : '确认'}
          </FloatPill>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
