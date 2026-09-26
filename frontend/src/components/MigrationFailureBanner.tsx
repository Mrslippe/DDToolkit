import { useState } from 'react'
import { FolderOpen, Stethoscope } from 'lucide-react'

import { api } from '../api/api'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { openDataDir } from '../utils/shellBridge'
import type { HealthzMigration } from '../utils/bootFailure'
import { migrationNotice } from '../utils/bootFailure'

/**
 * "上次升级没有完成"横幅（批次 16，devlog/207）。
 *
 * ⚠️ **非阻塞**是刻意的：迁移失败时后端已经用一本新的空库起来了，应用**能用** ——
 * 这时候挡一屏错误页只会让用户以为"坏了"，而真正要做的是让他知道
 * 「数据没有丢 + 在哪儿 + 把这份诊断发给我」。
 *
 * 两个按钮：
 * - **打开数据目录**：Rust 侧用 `ShellExecuteW` 打开它（后端不可达时也能用）；
 * - **导出诊断**：从后端取纯文本诊断包（不含凭据），弹窗里可全选复制 ——
 *   走弹窗而不是只靠 `navigator.clipboard`：WebView 里剪贴板权限不保证，
 *   而"复制不出来"等于这个按钮不存在。
 */
export default function MigrationFailureBanner({ migration }: { migration: HealthzMigration }) {
  const notice = migrationNotice(migration)
  const [diag, setDiag] = useState<{ filename: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  if (!notice || dismissed) return null

  const exportDiagnostics = async () => {
    setBusy(true)
    setError(null)
    try {
      const got = await api.getDiagnostics()
      setDiag({ filename: got.filename, text: got.text })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const wrapper = 'pointer-events-none fixed inset-x-0 top-0 z-[150] flex justify-center p-2'
  const card = 'pointer-events-auto flex max-w-3xl items-start gap-3 rounded-lg border ' +
    'border-amber-400/60 bg-amber-50/95 px-3 py-2 text-amber-950 shadow-lg backdrop-blur ' +
    'dark:bg-amber-950/90 dark:text-amber-50'

  return (
    <>
      <div className={wrapper} role="status">
        <div className={card}>
          <Stethoscope className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-semibold">{notice.title}</div>
            <div className="text-xs leading-relaxed break-words">{notice.detail}</div>
            {error && <div className="text-xs">导出诊断失败：{error}</div>}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="secondary" size="xs"
                onClick={() => { void openDataDir().catch((e) => setError(String(e))) }}>
                <FolderOpen /> 打开数据目录
              </Button>
              <Button size="xs" disabled={busy} onClick={() => void exportDiagnostics()}>
                <Stethoscope /> {busy ? '生成中…' : '导出诊断'}
              </Button>
              <Button variant="ghost" size="xs" onClick={() => setDismissed(true)}>知道了</Button>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={diag !== null} onOpenChange={(o) => { if (!o) setDiag(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{diag?.filename}</DialogTitle>
            <DialogDescription>
              全选（Ctrl+A）后复制，整份发给开发者即可。⚠️ 里面不含登录凭据与访问令牌。
            </DialogDescription>
          </DialogHeader>
          <textarea
            className="h-72 w-full resize-none rounded border bg-background/60 p-2 font-mono text-xs"
            readOnly
            value={diag?.text ?? ''}
            onFocus={(e) => e.currentTarget.select()}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
