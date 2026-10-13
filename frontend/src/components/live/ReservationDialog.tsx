/**
 * 手动记录**直播预约**（2026-10-13，用户口径：「点未来的待定日期格来记录直播预约」）。
 *
 * ## 为什么不复用「手动记录场次」那个弹窗
 *
 * 两者是**两种东西**（用户 2026-10-13 拍板「按现有模型：预约写事件表、记录写场次表」）：
 *
 * | | 写哪张表 | 有什么字段 |
 * |---|---|---|
 * | 手动记录场次 | `live_sessions`（`source='manual'`） | 起止**时刻** + 标题 + 录播地址 |
 * | 手动预约（这里） | `vtuber_events`（`kind='event'`） | 只有**日期** + 标题 |
 *
 * 预约**只到日**：`event_date` 就是 `YYYY-MM-DD`（见 `models/vtuber.py` 的说明）。
 * 服务端把它当"当天 20:00"喂给日历（`_reservation_start_of_day`），所以界面上不出现
 * 时刻输入框 —— 摆一个填了也会被忽略的输入框比不摆更糟。
 *
 * ⚠️ 走的是**已有**的 `createVtuberEvent`（大事记卡那套）：预约与"大事记"本来就是
 * 同一张表、同一个 `kind` —— 在这里另开一条写路径只会让两处的校验口径分家。
 * 样式沿用 `ManualSessionDialog` 的 `lc-ms-*` 类（同一种弹窗，不该有两套外观）。
 */
import { useEffect, useState } from 'react'

import { api } from '../../api/api'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { freezeBodyScroll, noScrollAutoFocus } from './dialogScroll'

interface Props {
  open: boolean
  /** 预约挂在哪个 V 上（`vtuber_events.vtuber_id`）；null = 取不到 V，不许提交 */
  vtuberId: number | null
  /** 预填的日期（`YYYY-MM-DD`，来自被点的那一格） */
  dayKey: string
  onClose: () => void
  /** 保存成功（父组件据此重取预约，格子上立刻出现那一条） */
  onSaved: () => void
}

export default function ReservationDialog({
  open, vtuberId, dayKey, onClose, onSaved,
}: Props) {
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(dayKey)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 每次打开都从**被点的那一格**重新起算，并清掉上一次的失败原因
  useEffect(() => {
    if (!open) return
    setTitle('')
    setDate(dayKey)
    setError(null)
    setBusy(false)
    // 临时让 body 不可滚：焦点滚进视口那一下就不会把页面顶走（`dialogScroll.ts` 记了两次修错）
    return freezeBodyScroll()
  }, [open, dayKey])

  const canSave = title.trim().length > 0 && !busy && vtuberId != null

  const save = async () => {
    if (!canSave || vtuberId == null) return
    setBusy(true)
    setError(null)
    try {
      await api.createVtuberEvent(vtuberId, {
        title: title.trim(), event_date: date, kind: 'event', emoji: '📅',
      })
    } catch (e) {
      // 失败要**看得见**（本仓硬规矩）：静默失败会让人以为存上了
      setError((e as Error)?.message || '保存失败')
      setBusy(false)
      return
    }
    setBusy(false)
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="lc-ms p-0 gap-0" overlayClassName="lc-dlg-backdrop"
                     showCloseButton={false}
                     /* 接管自动聚焦：默认那个会把页面滚 486px（`dialogScroll.ts` 记了两次修错） */
                     onOpenAutoFocus={noScrollAutoFocus}>
        <div className="lc-ms-head">
          <DialogTitle className="lc-ms-title">记录直播预约</DialogTitle>
          <DialogDescription className="lc-ms-sub">
            预约只记到哪一天（没有时刻）；日历上会以「预约」标出来
          </DialogDescription>
        </div>

        <div className="lc-ms-body">
          <div className="lc-ms-row">
            <label className="lc-ms-label" htmlFor="lc-rv-date">日期</label>
            <input id="lc-rv-date" className="lc-ms-input" type="date" value={date}
                   data-rv-date="1" onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="lc-ms-row">
            <label className="lc-ms-label" htmlFor="lc-rv-title">标题</label>
            <input id="lc-rv-title" className="lc-ms-input" type="text" maxLength={80}
                   placeholder="例：周五歌回" value={title}
                   data-rv-title="1" onChange={(e) => setTitle(e.target.value)} />
          </div>
          {error && <p className="lc-ms-error" role="alert" data-rv-error="1">{error}</p>}
        </div>

        <div className="lc-ms-actions">
          <span className="lc-ms-spacer" />
          <button type="button" className="lc-ms-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="lc-ms-btn primary" onClick={() => void save()}
                  disabled={!canSave} data-rv-save="1">
            {busy ? '保存中…' : '保存预约'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
