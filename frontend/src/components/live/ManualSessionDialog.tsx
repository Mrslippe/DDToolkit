/**
 * 手动记录 / 编辑一场直播（B2，devlog/454：需求 2 + 2.1）。
 *
 * ## 一个弹窗兼两件事，而不是两个
 *
 * 「补录播地址」与「手动记一场」在用户那里是同一件事的两半（都是"这一场的信息我来填"），
 * 而服务端的写端点也只分 POST/PATCH 两种语义。做成两个弹窗会出现"编辑时看不见自己填过什么"
 * 的割裂 —— 所以一个表单、两种模式：
 *
 * | 模式 | 可改 | 说明 |
 * |---|---|---|
 * | 新建（`session == null`） | 时间/标题/录播地址 | POST，默认今天 20:00–22:00 |
 * | 编辑手动场次 | 同上 | PATCH，只提交**改动过**的字段 |
 * | 编辑自动场次 | **只有录播地址** | 时间/标题来自平台，改了下次同步会被覆盖（服务端 400） |
 *
 * ## 口径都在这两处，组件不自己判断
 *
 * - 时间与"哪些字段变了"：`manualSessionForm.ts`（纯函数 + 用例）；
 * - "能不能改时间/能不能删"：服务端的 `manual` 标记（前端不拆 `source` 字符串）。
 *
 * 失败**不吞**：409（时段撞上已有场次）的中文原因直接显示在表单里 ——
 * 那句话点名了撞上哪一场，换成"保存失败"用户就没法处理了。
 */
import { useEffect, useRef, useState } from 'react'

import type { LiveSession, LiveSessionDetail } from '../../api/types'
import { api } from '../../api/api'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import {
  type ManualFormValues, buildManualPatch, canSubmitNew, defaultManualRange,
  formFromSession, hasChanges,
} from './manualSessionForm'

interface Props {
  open: boolean
  accountId: number | null
  /** 要编辑的场次；`null`/`undefined` = 新建 */
  session?: LiveSession | null
  onClose: () => void
  /** 保存成功（回执是**合并后**的那一条，父组件据此刷新列表/切换月份） */
  onSaved: (saved: LiveSessionDetail) => void
  /** 删除成功（只有手动场次删得掉） */
  onDeleted?: (liveId: string) => void
}

/** 新建模式的初值：今天 20:00–22:00（见 `defaultManualRange` 的理由） */
function blankValues(): ManualFormValues {
  return { title: '', ...defaultManualRange(new Date()), vod: '' }
}

export default function ManualSessionDialog({
  open, accountId, session, onClose, onSaved, onDeleted,
}: Props) {
  const editing = Boolean(session?.live_id)
  /** 自动抓来的场次：只能补录播地址（与服务端 400 的两个分支同一口径） */
  const autoOnly = Boolean(session) && !session?.manual

  const [values, setValues] = useState<ManualFormValues>(blankValues)
  /** 打开时那一份初值 —— `buildManualPatch` 只提交与它的差（不改的字段一个字都不发） */
  const orig = useRef<ManualFormValues>(blankValues())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)

  // 每次打开（或换一个目标场次）都从**服务端那份数据**重新起算，并清掉上一次的失败原因
  useEffect(() => {
    if (!open) return
    const v = session ? formFromSession(session) : blankValues()
    setValues(v)
    orig.current = v
    setError(null)
    setBusy(false)
    setConfirmDel(false)
  }, [open, session])

  const set = (k: keyof ManualFormValues) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }))

  const changed = editing ? hasChanges(orig.current, values) : canSubmitNew(values)
  const canSave = changed && !busy

  const save = async () => {
    if (!canSave || accountId == null) return
    setBusy(true)
    setError(null)
    try {
      if (editing && session?.live_id) {
        onSaved(await api.updateLiveSession(
          accountId, session.live_id, buildManualPatch(orig.current, values)))
      } else {
        // 新建：空字段**不发**（undefined ≠ null —— 服务端把 null 当"明确清空"）
        onSaved(await api.createManualLiveSession(accountId, {
          start_at: values.start.trim(),
          ...(values.end.trim() ? { end_at: values.end.trim() } : {}),
          ...(values.title.trim() ? { title: values.title.trim() } : {}),
          ...(values.vod.trim() ? { vod_url: values.vod.trim() } : {}),
        }))
      }
    } catch (e) {
      // 409/422 的 detail 就是给用户看的那句话（后端 `_conflict_message` / `_manual_inputs`）
      setError((e as Error)?.message || '保存失败')
      setBusy(false)
      return
    }
    setBusy(false)
  }

  const remove = async () => {
    if (accountId == null || !session?.live_id || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteLiveSession(accountId, session.live_id)
    } catch (e) {
      setError((e as Error)?.message || '删除失败')
      setBusy(false)
      return
    }
    setBusy(false)
    onDeleted?.(session.live_id)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="lc-ms p-0 gap-0" overlayClassName="lc-dlg-backdrop"
                     showCloseButton={false}>
        <div className="lc-ms-head">
          <DialogTitle className="lc-ms-title">
            {editing ? '编辑场次' : '手动记录一场直播'}
          </DialogTitle>
          <DialogDescription className="lc-ms-sub">
            {editing
              ? '只提交改动过的字段（手动记录的时间/标题随便改）'
              : '日历上自动同步不到的那一场，在这里补上'}
          </DialogDescription>
        </div>

        <div className="lc-ms-body">
          <div className="lc-ms-row">
            <label className="lc-ms-label" htmlFor="lc-ms-start">开始</label>
            <input id="lc-ms-start" className="lc-ms-input" type="datetime-local"
                   value={values.start} onChange={set('start')} disabled={autoOnly} />
          </div>
          <div className="lc-ms-row">
            <label className="lc-ms-label" htmlFor="lc-ms-end">结束</label>
            <input id="lc-ms-end" className="lc-ms-input" type="datetime-local"
                   value={values.end} onChange={set('end')} disabled={autoOnly} />
            <span className="lc-ms-hint">留空 = 进行中（没记结束时间）</span>
          </div>
          <div className="lc-ms-row">
            <label className="lc-ms-label" htmlFor="lc-ms-title">标题</label>
            <input id="lc-ms-title" className="lc-ms-input" type="text" maxLength={80}
                   placeholder="例：周五歌回" value={values.title}
                   onChange={set('title')} disabled={autoOnly} />
          </div>
          <div className="lc-ms-row">
            <label className="lc-ms-label" htmlFor="lc-ms-vod">录播</label>
            <input id="lc-ms-vod" className="lc-ms-input" type="text"
                   placeholder="BV 号，或 www.bilibili.com/video/BV… 链接"
                   value={values.vod} onChange={set('vod')} />
            <span className="lc-ms-hint">填 BV 号就行，服务端会补成能点开的地址</span>
          </div>

          {autoOnly && (
            <p className="lc-ms-note">
              这一场是自动抓取的（来源 {session?.source}），<b>只能补录播地址</b> ——
              时间和标题来自平台，手改会在下次同步时被覆盖回去。
            </p>
          )}
          {error && <p className="lc-ms-error" role="alert">{error}</p>}
        </div>

        <div className="lc-ms-actions">
          {editing && session?.manual && (confirmDel ? (
            <span className="lc-ms-del-confirm">
              <span className="lc-ms-note">删掉这一场？</span>
              <button type="button" className="lc-ms-btn danger" onClick={remove}
                      disabled={busy}>
                确认删除
              </button>
              <button type="button" className="lc-ms-btn" onClick={() => setConfirmDel(false)}
                      disabled={busy}>
                算了
              </button>
            </span>
          ) : (
            <button type="button" className="lc-ms-btn danger" onClick={() => setConfirmDel(true)}
                    disabled={busy}>
              删除
            </button>
          ))}
          <span className="lc-ms-spacer" />
          <button type="button" className="lc-ms-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="lc-ms-btn primary" onClick={save} disabled={!canSave}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
