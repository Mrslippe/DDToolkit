import { useCallback, useEffect, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import FloatPill from '../common/FloatPill'
import { api } from '../../api/api'
import type { FanPurgeResult } from '../../api/types'
import { withNetRetry } from '../../utils/netRetry'

interface Props {
  /** 当前主播显示名 */
  name: string
  /** 删除成功后通知外层：刷新热力图与名单 */
  onPurged: () => void
  disabled?: boolean
}

function mb(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`
}

/**
 * 「删除已采集数据」（2026-10-19）。
 *
 * 口径照 `settings` 的 prune 端点：**先预览、再确认**（`dry_run` 默认 true，
 * 预览与实际是同一份计算）。删除**不可恢复**，所以确认按钮标 `danger`。
 *
 * ⚠️ 只删该主播数据子目录里 `raw/` `stats/` `names/` 的**文件**，目录与其它主播不受影响
 * （后端逐个 unlink，不做 rmtree）。
 */
export default function PurgeButton({ name, onPurged, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<FanPurgeResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 每次打开都重新取一次预览（数据可能刚变过）
  useEffect(() => {
    if (!open || !name) return
    let alive = true
    setPreview(null)
    setErr(null)
    withNetRetry(() => api.fanPurge(name, { dryRun: true, scope: 'all' }))
      .then((r) => { if (alive) setPreview(r) })
      .catch((e: Error) => { if (alive) setErr(e.message) })
    return () => { alive = false }
  }, [open, name])

  const confirm = useCallback(async () => {
    setBusy(true)
    setErr(null)
    try {
      await withNetRetry(() => api.fanPurge(name, { dryRun: false, scope: 'all' }))
      setOpen(false)
      onPurged()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [name, onPurged])

  const empty = preview !== null && preview.files === 0

  return (
    <>
      <FloatPill size="md" shape="text" danger disabled={disabled}
                 onClick={() => setOpen(true)} data-testid="workbench-purge">
        删除已采集
      </FloatPill>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent data-testid="purge-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{name}」的已采集数据？</AlertDialogTitle>
            <AlertDialogDescription>
              {preview === null && !err && '正在统计将要删除的文件…'}
              {err && `统计失败：${err}`}
              {preview && !empty && (
                <>
                  将删除 <b>{preview.sessions}</b> 场的数据，共 <b>{preview.files}</b> 个文件
                  （约 <b>{mb(preview.bytes)}</b>）。
                  <br />
                  其中 raw {mb(preview.by_dir.raw?.bytes ?? 0)}
                  · stats {mb(preview.by_dir.stats?.bytes ?? 0)}
                  · names {mb(preview.by_dir.names?.bytes ?? 0)}
                  <br />
                  <b>不可恢复</b> —— 删掉之后要重新采集。目录结构与其它主播的数据不受影响。
                </>
              )}
              {empty && '这位主播没有已采集的数据，无需删除。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => {
              e.preventDefault()
              void confirm()
            }} disabled={busy || empty || preview === null}
              data-testid="purge-confirm">
              {busy ? '删除中…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
