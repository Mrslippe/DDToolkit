import type { ReactNode } from 'react'

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../ui/alert-dialog'
import { noScrollAutoFocus } from './dialogScroll'

interface Props {
  open: boolean
  title: string
  /** 正文（**把范围说清**：会动几条、哪些不动） */
  children?: ReactNode
  confirmText?: string
  cancelText?: string
  /** 危险动作（清空 / 删除）：确认钮走红色 */
  danger?: boolean
  /** 探针钩子：容器上挂 `data-<testId>`；确认钮 `[data-<testId>-confirm]`、取消 `-cancel` */
  testId?: string
  /**
   * 正在执行（2026-10-15 用户：「需要一段时间的执行就显示一个加载态，
   * 防止加载过程中用户一直去进行其他操作」）。
   * `true` ⇒ 确认钮变「执行中…」且两枚按钮都禁用，窗口不许被 Esc/遮罩关掉。
   */
  busy?: boolean
  /** 执行中时确认钮上的字（默认「执行中…」） */
  busyText?: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * 一句「确定吗」的确认窗（2026-10-15，为「清空已匹配」而加）。
 *
 * ## 为什么单开一个组件
 *
 * 仓里此前的二次确认都是**塞在各自的按钮位里**（`.lc-ms-del-confirm` 那种"原地变成两枚按钮"），
 * 这在"删一场"那种局部动作上够用；但「清空已匹配」是**窗口级 / 全局级**动作，
 * 原地变按钮会让"会动多少条"这句话没地方写 —— 而那句话正是这个动作唯一的安全阀。
 *
 * 复用 Radix 的 `AlertDialog`（本仓已有 `components/ui/alert-dialog.tsx`）：
 * **聚焦默认落在取消上**、Esc/遮罩取消 —— 危险动作不该让"回车"就是确认。
 */
export default function ConfirmDialog({
  open, title, children, confirmText = '确定', cancelText = '取消',
  danger = false, testId = 'confirm', busy = false, busyText = '执行中…',
  onConfirm, onCancel,
}: Props) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel() }}>
      {/* 第 7 层：确认窗可能从**场次详情窗**（二级窗）里开出来 ——
          与 `.lc-ms`/`.lvc-fill` 同一套层叠（见 `posts.css` 的「弹窗层叠」段）。 */}
      <AlertDialogContent className="lc-confirm lc-dlg-layer"
                           overlayClassName="lc-dlg-backdrop lc-dlg-layer"
                           {...{ [`data-${testId}`]: '1' }}
                           {...(busy ? { 'data-busy': '1' } : {})}
                           /* 执行中不许被 Esc 关掉（那会让"正在清空"变成看不见的后台动作）。
                              ⚠️ 点遮罩本来就不关（AlertDialog 的语义是"必须选一个"），不用另加。 */
                           onEscapeKeyDown={(e) => { if (busy) e.preventDefault() }}
                           onOpenAutoFocus={noScrollAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle className="lc-confirm-title">{title}</AlertDialogTitle>
          {children && (
            <AlertDialogDescription asChild>
              <div className="lc-confirm-body">{children}</div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="lc-ms-btn"
                              disabled={busy}
                              {...{ [`data-${testId}-cancel`]: '1' }}
                              onClick={onCancel}>
            {cancelText}
          </AlertDialogCancel>
          <AlertDialogAction
            className={`lc-ms-btn${danger ? ' danger' : ' primary'}`}
            disabled={busy}
            {...{ [`data-${testId}-confirm`]: '1' }}
            onClick={onConfirm}
          >
            {busy ? busyText : confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
