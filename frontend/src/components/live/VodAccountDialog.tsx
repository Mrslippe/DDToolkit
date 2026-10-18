/**
 * 「录播号」小窗（2026-10-15 **第二版**：条目化 + 拖动排序 + 一行三格）。
 *
 * ## 用户口径（2026-10-15 晚，带截图与方案稿）
 *
 * 1. 「不同主播的第三方录播号是独立的」（顺带修掉串号，见 `PostsPage` 的
 *    `vodUidOverride` —— 那个覆盖值原来整页共用一份，保存过一次就盖住**所有** V 的值）；
 * 2. 「输入录播号后保存为固定条目，展示为 `| 昵称 mid 投稿数 |`」；
 * 3. 「拖动条目的上下位置进行排序，越上面的优先级越高」；
 * 4. 拍板的四条：新号进**末尾** · 昵称查不到**允许保存** · 显示**最近投稿** · **上限 5 条**。
 *
 * ## 与旧版的差别（为什么不再是一个逗号文本框）
 *
 * 旧版只有一个文本框：优先级靠"记得谁写在左边"，昵称/投稿数全看不到，改顺序要手工剪切。
 * 现在每一行是一张卡，**顺序就是优先级**，存的时候仍然拼回那个逗号串
 * （`vtubers.vod_account_uid`，左 = 高优先）—— **服务端与扫描逻辑一个字都不用改**。
 *
 * ## 数据从哪来
 *
 * `GET /vtuber/vod-accounts?mids=…`（`vod_source.resolve_account_profiles`）：
 * 昵称/头像走匿名的 `x/web-interface/card`、投稿数走登录态的 `arc/search`，
 * **两半各自独立失败**（`name_error` / `uploads_error`）——
 * 所以"查不到昵称"只标黄、不拦人。
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import type { VodAccountProfile } from '../../api/types'
import { api } from '../../api/api'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import ProxyImage from '../common/ProxyImage'
import { noScrollAutoFocus } from './dialogScroll'

interface Props {
  open: boolean
  /** 该 V 的 id；null = 存不了（不渲染保存） */
  vtuberId: number | null
  /** 当前值（逗号串，**左 = 高优先**） */
  value?: string | null
  onClose: () => void
  /** 存成功：父组件据此刷新回显 */
  onSaved: (mids: string) => void | Promise<void>
}

/** 别人玩不出花的那个数（用户 2026-10-15 拍板）：一屏摆得下、也不会有人真配 6 个录播号。 */
export const VOD_ACCOUNT_MAX = 5

/** 逗号串 → 有序去重的 mid 列表（中文逗号也认，用户手输过）。 */
export function parseMids(value: string | null | undefined): string[] {
  const raw = String(value ?? '').replace(/，/g, ',').split(',')
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean))]
}

/** 输入框里可能是裸 mid，也可能是主页链接 —— 都抠出那串数字。 */
export function midFromInput(text: string): string {
  const hit = text.trim().match(/(\d{4,})/)
  return hit ? hit[1] : text.trim()
}

/** 「1093 条投稿 · 最近 2026.10.11」；取不到的字段**不编 0**。 */
function statText(p: VodAccountProfile | undefined): string {
  if (!p) return '…'
  const parts: string[] = []
  if (typeof p.uploads === 'number') parts.push(`${p.uploads} 条投稿`)
  if (p.last_published_at) parts.push(`最近 ${p.last_published_at.slice(0, 10).replace(/-/g, '.')}`)
  return parts.length ? parts.join(' · ') : '投稿数未取到'
}

/** 头像占位：拿不到图时画首字（与 `.lvc-acct-ava` 的底同一个圆）。 */
function AvatarFallback({ text }: { text: string }) {
  return <span className="lvc-acct-ava-fb">{text.slice(0, 1)}</span>
}

export default function VodAccountDialog({ open, vtuberId, value = null, onClose, onSaved }: Props) {
  const [mids, setMids] = useState<string[]>([])
  const [profiles, setProfiles] = useState<Record<string, VodAccountProfile>>({})
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState<VodAccountProfile | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [querying, setQuerying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 拖动中的那一行（用它画 hover 指示） */
  const [dragMid, setDragMid] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const original = useMemo(() => parseMids(value), [value])
  const dirty = useMemo(() => mids.join(',') !== original.join(','), [mids, original])

  /** 打开就按服务端那份值起算，并**批量**解析资料（并发，见服务层 gather）。 */
  useEffect(() => {
    if (!open) return
    const want = parseMids(value)
    setMids(want)
    setProfiles({})
    setDraft('')
    setPreview(null)
    setAddError(null)
    setError(null)
    setBusy(false)
    if (want.length === 0) return
    let alive = true
    setLoading(true)
    api
      .vodAccounts(want)
      .then((res) => {
        if (!alive) return
        const map: Record<string, VodAccountProfile> = {}
        for (const it of res.items) map[it.mid] = it
        setProfiles(map)
      })
      // ⚠️ 资料取不到**不是**打不开窗：行照旧显示 mid，只是少了昵称/投稿数
      .catch(() => { /* 行里本来就有 mid，静默降级 */ })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, value])

  const move = (from: number, to: number) => {
    if (to < 0 || to >= mids.length || from === to) return
    setMids((prev) => {
      const next = [...prev]
      const [it] = next.splice(from, 1)
      next.splice(to, 0, it)
      return next
    })
  }

  /** 拖动排序：把 `from` 插到 `to` 之前（`to === length` = 插到末尾）。 */
  const dropAt = (fromMid: string, toMid: string | null, after: boolean) => {
    const from = mids.indexOf(fromMid)
    if (from < 0) return
    const next = [...mids]
    next.splice(from, 1)
    const at = toMid == null ? next.length : next.indexOf(toMid) + (after ? 1 : 0)
    next.splice(at, 0, fromMid)
    setMids(next)
  }

  const query = async () => {
    const mid = midFromInput(draft)
    setAddError(null)
    setPreview(null)
    if (!mid) return
    if (mids.includes(mid)) {
      setAddError('这个号已经在列表里了')
      return
    }
    if (mids.length >= VOD_ACCOUNT_MAX) {
      setAddError(`最多 ${VOD_ACCOUNT_MAX} 个号 —— 先删掉一个再加`)
      return
    }
    setQuerying(true)
    try {
      const res = await api.vodAccounts([mid])
      const got = res.items[0] ?? { mid, name: '', avatar: '', uploads: null,
                                    last_published_at: null, name_error: '没查到', uploads_error: null }
      setProfiles((prev) => ({ ...prev, [mid]: got }))
      setPreview(got)
      if (got.name_error) setAddError(got.name_error)
    } catch (e) {
      // 查询失败**也要能加**：号本身可能就是好的，只是这次没问到
      setAddError((e as Error)?.message || '没查到，可以直接添加')
      setPreview({ mid, name: '', avatar: '', uploads: null, last_published_at: null,
                   name_error: (e as Error)?.message || '没查到', uploads_error: null })
    } finally {
      setQuerying(false)
    }
  }

  const commitAdd = () => {
    if (!preview || mids.length >= VOD_ACCOUNT_MAX) return
    setMids((prev) => [...prev, preview.mid])          // ★ 新号进**末尾**（用户拍板）
    setDraft('')
    setPreview(null)
    setAddError(null)
  }

  const save = async () => {
    if (vtuberId == null || busy || !dirty) return
    setBusy(true)
    setError(null)
    try {
      const text = mids.join(',')
      await api.updateVtuber(vtuberId, { vod_account_uid: text || null })
      await onSaved(text)
      setBusy(false)
      onClose()
    } catch (e) {
      // 失败要**看得见**（本仓硬规矩：静默失败会让人以为存上了）
      setError((e as Error)?.message || '保存失败')
      setBusy(false)
    }
  }

  const full = mids.length >= VOD_ACCOUNT_MAX

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      {/* 第 7 层：它可能从详情窗里打开，遮罩要盖住底下那一层（同 `.lc-ms`） */}
      <DialogContent className="lc-ms lvc-acct lc-dlg-layer p-0 gap-0"
                       overlayClassName="lc-dlg-backdrop lc-dlg-layer"
                       showCloseButton={false} onOpenAutoFocus={noScrollAutoFocus}>
        <div className="lc-ms-head">
          <DialogTitle className="lc-ms-title">录播号</DialogTitle>
          <DialogDescription className="lc-ms-sub">
            这个 V 的回放发在哪些 B 站号上 —— 每个 V 各存一份，互不影响
          </DialogDescription>
        </div>

        <div className="lc-ms-body">
          <p className="lvc-acct-prio" data-vod-acct-prio="1">
            <b>越靠上优先级越高</b>：扫描时先扫最上面的号，它配不上的场次才轮到下一个。
          </p>

          {mids.length === 0 && !loading && (
            <p className="lvc-acct-empty" data-vod-acct-empty="1">
              还没有录播号。填一个 mid，扫描时就会去它那里找这个 V 的录播。
            </p>
          )}

          <ul className="lvc-acct-rows" ref={listRef} data-vod-acct-rows={mids.length}>
            {mids.map((mid, i) => {
              const p = profiles[mid]
              const unknown = !loading && p != null && !p.name
              return (
                <li key={mid}
                    className={`lvc-acct-row${dragMid === mid ? ' dragging' : ''}${unknown ? ' unknown' : ''}`}
                    data-vod-acct-row={mid}
                    draggable
                    onDragStart={(e) => {
                      setDragMid(mid)
                      e.dataTransfer?.setData('text/plain', mid)
                      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={(e) => {
                      if (!dragMid || dragMid === mid) return
                      e.preventDefault()
                      const r = e.currentTarget.getBoundingClientRect()
                      dropAt(dragMid, mid, e.clientY > r.top + r.height / 2)
                    }}
                    onDragEnd={() => setDragMid(null)}
                    onDrop={(e) => { e.preventDefault(); setDragMid(null) }}>
                  {/* 手柄是可聚焦的按钮：鼠标拖，键盘用上下键（jsdom 里也测得到） */}
                  <button type="button" className="lvc-acct-grip"
                          data-vod-acct-grip={mid}
                          aria-label="拖动排序（也可用上下方向键）"
                          title="拖动排序（也可用上下方向键）"
                          onKeyDown={(e) => {
                            if (e.key === 'ArrowUp') { e.preventDefault(); move(i, i - 1) }
                            if (e.key === 'ArrowDown') { e.preventDefault(); move(i, i + 1) }
                          }}>
                    ⠿
                  </button>
                  {/* 序号 = 优先级（**素数字**，方案稿 6 版里选的 B+：`_probe/mockups/vod-account-priority.html`）。
                      对读屏**隐藏** —— 顺序由 DOM 顺序与上面那句说明表达，念一串数字只会更吵。
                      第一行靠 CSS 加深 + 一条主色竖条读成"主号"（不在这里写条件类名）。 */}
                  <span className="lvc-acct-no" aria-hidden="true">{i + 1}</span>
                  <ProxyImage className="lvc-acct-ava" src={p?.avatar || undefined}
                              alt="" fallback={<AvatarFallback text={p?.name || mid} />} />
                  <span className="lvc-acct-who">
                    <span className="lvc-acct-name" data-vod-acct-name={mid}>
                      {p ? (p.name || '昵称未取到') : (loading ? '查询中…' : mid)}
                    </span>
                    <span className="lvc-acct-mid">{mid}</span>
                  </span>
                  <span className="lvc-acct-stat" data-vod-acct-stat={mid}>
                    {unknown && <span className="lvc-acct-dot" aria-hidden="true" />}
                    {statText(p)}
                  </span>
                  <button type="button" className="lvc-acct-del" data-vod-acct-del={mid}
                          aria-label={`移除 ${mid}`} title="移除"
                          onClick={() => setMids((prev) => prev.filter((m) => m !== mid))}>
                    ✕
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="lc-ms-row lvc-acct-add">
            <input className="lc-ms-input" type="text" data-vod-acct-input="1"
                   placeholder="B 站 mid 或主页链接"
                   value={draft}
                   disabled={full}
                   onChange={(e) => { setDraft(e.target.value); setPreview(null); setAddError(null) }}
                   onKeyDown={(e) => { if (e.key === 'Enter') void query() }} />
            <button type="button" className="lc-ms-btn" data-vod-acct-query="1"
                    disabled={full || querying || !draft.trim()}
                    onClick={() => void query()}>
              {querying ? '查询中…' : '查询'}
            </button>
          </div>

          {preview && (
            <div className="lvc-acct-pv" data-vod-acct-preview={preview.mid}>
              <ProxyImage className="lvc-acct-ava" src={preview.avatar || undefined}
                          alt="" fallback={<AvatarFallback text={preview.name || preview.mid} />} />
              <span className="lvc-acct-who">
                <span className="lvc-acct-name">{preview.name || '昵称未取到'}</span>
                <span className="lvc-acct-mid">{preview.mid} · {statText(preview)}</span>
              </span>
              <button type="button" className="lvc-acct-go" data-vod-acct-add={preview.mid}
                      onClick={commitAdd}>
                添加到末尾
              </button>
            </div>
          )}

          {addError && (
            <p className="lvc-acct-warn" role="alert" data-vod-acct-add-error="1">{addError}</p>
          )}

          <p className="lc-ms-hint lvc-acct-hint" data-vod-acct-hint="1">
            {full ? `最多 ${VOD_ACCOUNT_MAX} 个号（已满）—— 先删掉一个再加。`
                  : `最多 ${VOD_ACCOUNT_MAX} 个号。`}
            同一场直播被多个号发过时<b>只取最上面那个号</b>的那一条；
            留空 = 只扫这个 V 自己的 B 站号。
          </p>
          {error && <p className="lc-ms-error" role="alert" data-vod-acct-error="1">{error}</p>}
        </div>

        <div className="lc-ms-actions">
          <span className="lc-ms-spacer" />
          <button type="button" className="lc-ms-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="lc-ms-btn primary" data-vod-acct-save="1"
                  disabled={busy || vtuberId == null || !dirty}
                  onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
