/**
 * 「添加录播」小窗（2026-10-13，用户 3.2 条：封面上的 ＋ 打开它）。
 *
 * ## 为什么是一个独立小窗，而不是场次详情里那一行
 *
 * 用户 3.1：「**录播文字行可以不需要**，尽量保证左右两栏高度一致，如果以后要加功能的话
 * 也不要直接加进左边或者右边」—— 那一行（地址 / 未填写 / 找录播 / 手动填）连同它下面
 * 那一大块候选列表都挤在右列里，既把右列撑得高低不定，也让"给这一场补录播"这件事
 * 分散在三个入口（铅笔、找录播、手动填）。
 *
 * 现在**所有录播相关的操作只在这一个窗里**，入口只有封面上的那枚悬浮钮
 * （无录播 = ＋，见 `LiveSessionDialog` 的 `.lc-dlg-vodbtn`）。
 *
 * ## 三件事都在这里
 *
 * | 干什么 | 走哪条路 |
 * |---|---|
 * | 填地址 | `api.updateLiveSession(accountId, live_id, { vod_url })`（**复用 B2 那条 PATCH**） |
 * | 找录播 | `api.vodCandidates(accountId, live_id)` —— **只读**，给候选、由用户点「用它」确认 |
 * | 记住录播号 | `onSaveVodAccount(mids)` —— 存到 **V 上**（`vod_account_uid`），下一场照样带上 |
 *
 * ⚠️ 候选列表**连同 `live_id` 一起记账**：切场次后旧候选必须失效，否则「用它」会把
 * 上一场的录播写进这一场（C1 那批踩过的静默错数据）。
 */
import { useEffect, useState } from 'react'

import type { LiveSession, VodCandidate, VodCandidatesResult } from '../../api/types'
import { api } from '../../api/api'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { formatDateTime } from '../../utils/format'
import { noScrollAutoFocus } from './dialogScroll'
import { Loader2 } from 'lucide-react'

interface Props {
  open: boolean
  accountId: number | null
  /** 目标场次（要有 `live_id`）；null = 没目标，不许提交 */
  session: LiveSession | null
  /** 这个 V 已经记住的录播号（回显 + 判"改没改"） */
  vodAccountUid?: string | null
  onClose: () => void
  /** 保存成功：回执是**合并后**的那一条（父组件据此刷新详情与日历） */
  onSaved: (saved: { live_id?: string | null; vod_url?: string | null }) => void
  /** 记住录播号（存到 V 上） */
  onSaveVodAccount?: (mids: string) => Promise<void> | void
}

/** 录播地址的初值：原样回显（服务端入库前已规范化，这里不猜、不改） */
export default function VodDialog({
  open, accountId, session, vodAccountUid = null, onClose, onSaved, onSaveVodAccount,
}: Props) {
  const [url, setUrl] = useState(session?.vod_url ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 候选列表（连同场次记账，见文件头） */
  const [found, setFound] = useState<(VodCandidatesResult & { liveId: string }) | null>(null)
  /** 录播号输入框：打开时用已保存的值初始化 */
  const [acct, setAcct] = useState(vodAccountUid ?? '')

  const liveId = session?.live_id ?? null

  // 每次打开（或换一场）都从**服务端那份数据**重新起算
  useEffect(() => {
    if (!open) return
    setUrl(session?.vod_url ?? '')
    setAcct(vodAccountUid ?? '')
    setFound(null)
    setError(null)
    setBusy(false)
  }, [open, session, vodAccountUid])

  const canSave = liveId != null && accountId != null && !busy
    && url.trim() !== (session?.vod_url ?? '').trim()

  const save = async () => {
    if (!canSave || accountId == null || !liveId) return
    setBusy(true)
    setError(null)
    try {
      const saved = await api.updateLiveSession(accountId, liveId, { vod_url: url.trim() })
      setBusy(false)
      onSaved(saved)
    } catch (e) {
      // 失败要**看得见**（本仓硬规矩）：静默失败会让人以为存上了
      setError((e as Error)?.message || '保存失败')
      setBusy(false)
    }
  }

  /** 「找录播」：只读地问后端要候选（不写任何东西）。 */
  const find = async () => {
    if (!liveId || accountId == null || busy) return
    setBusy(true)
    setError(null)
    try {
      setFound({ ...(await api.vodCandidates(accountId, liveId)), liveId })
    } catch (e) {
      // 失败也落到明确状态（"点了没反应"比一句失败更糟）
      setFound({ mids: [], window: '', items: [],
                 hint: `没问到：${(e as Error).message}`, liveId })
    } finally {
      setBusy(false)
    }
  }

  /** 选中一条候选 → 直接写进这一场（写路径与手动填同一个 PATCH）。 */
  const use = async (c: VodCandidate) => {
    if (!liveId || accountId == null || busy) return
    setBusy(true)
    setError(null)
    try {
      const saved = await api.updateLiveSession(accountId, liveId, { vod_url: c.permalink })
      setFound(null)
      setBusy(false)
      onSaved(saved)
    } catch (e) {
      setError((e as Error)?.message || '保存失败')
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="lc-ms p-0 gap-0" overlayClassName="lc-dlg-backdrop"
                     showCloseButton={false}
                     /* 接管自动聚焦：默认那个会把页面滚出去（`dialogScroll.ts`） */
                     onOpenAutoFocus={noScrollAutoFocus}>
        <div className="lc-ms-head">
          <DialogTitle className="lc-ms-title">添加录播</DialogTitle>
          <DialogDescription className="lc-ms-sub">
            填 BV 号就行，服务端会补成能点开的地址；也可以让工具去 B 站找这一场的回放
          </DialogDescription>
        </div>

        <div className="lc-ms-body">
          <div className="lc-ms-row">
            <label className="lc-ms-label" htmlFor="vod-url">录播</label>
            <input id="vod-url" className="lc-ms-input" type="text" data-vod-url="1"
                   placeholder="BV 号，或 www.bilibili.com/video/BV… 链接"
                   value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="lc-ms-row">
            <span className="lc-ms-label" />
            <button type="button" className="lc-ms-btn" data-find-vod="1" disabled={busy}
                    title="在 B 站按开播时间找这一场的回放（给候选，由你确认）"
                    onClick={() => void find()}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : null}
              {busy ? '查找中…' : '找录播'}
            </button>
          </div>

          {found && found.liveId === liveId && (
            <div className="lc-vod-cand-wrap" data-vod-candidates="1">
              <div className="lc-vod-cand-hint">
                {found.hint || `扫了 ${found.mids.length} 个号：${found.mids.join('、')}`}
                {found.window && <span className="lc-vod-cand-win"> · {found.window}</span>}
              </div>
              {/* 录播号（f015）：真机实测 V 自己多半不发回放 ⇒ 这个输入框是**主路径**。
                  先用「搜索」找一个「XX录播组」，把它的 mid 填进来再找一次。 */}
              {onSaveVodAccount && (
                <div className="lc-vod-cand-acct">
                  <input className="lc-vod-acct-input" data-vod-account-input="1"
                         value={acct} placeholder="录播号 mid（多个用逗号分隔）"
                         onChange={(e) => setAcct(e.target.value)} />
                  <button type="button" className="lc-ms-btn" data-vod-account-save="1"
                          disabled={acct.trim() === (vodAccountUid ?? '').trim()}
                          title="存到这个 V 上，下次「找录播」自动带上它"
                          onClick={() => void onSaveVodAccount(acct.trim())}>
                    记住这个号
                  </button>
                </div>
              )}
              {found.items.map((c) => (
                <div key={c.bvid || c.permalink} className="lc-vod-cand" data-vod-bvid={c.bvid}>
                  <div className="lc-vod-cand-main">
                    <span className="lc-vod-cand-title" title={c.title}>{c.title}</span>
                    <span className="lc-vod-cand-meta">
                      {c.published_at ? formatDateTime(c.published_at) : '时间未知'}
                      {c.duration_minutes ? ` · ${c.duration_minutes} 分钟` : ''}
                      {` · ${c.reasons[0] ?? '时间窗内'}`}
                    </span>
                    {c.cautions.length > 0 && (
                      <span className="lc-vod-cand-warn">{c.cautions.join('；')}</span>
                    )}
                  </div>
                  <button type="button" className="lc-ms-btn" data-vod-use={c.bvid}
                          disabled={busy} onClick={() => void use(c)}>
                    用它
                  </button>
                </div>
              ))}
            </div>
          )}

          {error && <p className="lc-ms-error" role="alert" data-vod-error="1">{error}</p>}
        </div>

        <div className="lc-ms-actions">
          <span className="lc-ms-spacer" />
          <button type="button" className="lc-ms-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="lc-ms-btn primary" data-vod-save="1"
                  disabled={!canSave} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
