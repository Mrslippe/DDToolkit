import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'

import type { VodApplyOut, VodMatch, VodScanResult } from '../../api/types'
import { api } from '../../api/api'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { formatDateTime } from '../../utils/format'
import { noScrollAutoFocus } from './dialogScroll'
import OverlayScroll from '../OverlayScroll'

interface Props {
  open: boolean
  accountId: number | null
  /** 这个 V 记住的录播号（回显 + 空态时告诉用户去哪填） */
  vodAccountUid?: string | null
  onClose: () => void
  /** 写入成功：父组件据此重拉日历与详情 */
  onApplied: (out: VodApplyOut) => void
  /** 去补录播号（空态那条出路） */
  onEditVodAccount?: () => void
}

/** 一行在界面上的状态：勾没勾 + 当前选的是哪条（可在 alternates 间换） */
interface Row {
  match: VodMatch
  checked: boolean
  /** `null` = 用主选；数字 = alternates 的下标 */
  altIdx: number | null
}

const CONF_LABEL: Record<number, string> = {
  0: '标题时间对上',
  1: '标题有日期',
  2: '同日兜底',
}

/** 当前这一行实际要写进去的录播（主选或被切过去的备选）。 */
function picked(row: Row): { bvid: string; permalink: string; title: string } {
  if (row.altIdx == null) {
    return { bvid: row.match.bvid, permalink: row.match.permalink, title: row.match.title }
  }
  const a = row.match.alternates[row.altIdx]
  return a
    ? { bvid: a.bvid, permalink: a.permalink, title: a.title }
    : { bvid: row.match.bvid, permalink: row.match.permalink, title: row.match.title }
}

/** 「+3 小时 20 分」这种给人看的偏移（负=录播标的时刻早于场次记录）。 */
function fmtDelta(min: number | null): string {
  if (min == null) return '—'
  const sign = min >= 0 ? '+' : '−'
  const abs = Math.abs(Math.round(min))
  const h = Math.floor(abs / 60)
  return h ? `${sign}${h} 小时 ${abs % 60} 分` : `${sign}${abs} 分`
}

/** 依据文字：早场/仅日期要**说清为什么差得远**，否则审查的人以为是配错了。 */
function basisText(m: VodMatch): string {
  const base = CONF_LABEL[m.confidence] ?? '—'
  if (m.date_only) return `${base}（标题只标了日期）`
  if (m.title_hour != null && m.title_hour <= 5) {
    return `${base}（早场：录播号按惯例标前一天）`
  }
  return base
}

/**
 * 「录播填充」审查窗（B4，`docs/plans/vod-autofill.md`）。
 *
 * ## 口径（用户 2026-10-15 拍板：**先审查再写**）
 *
 * 打开即扫描（`vod-scan` **只读**），把结果摆成一张「场次 ↔ 录播」对照表：
 * 勾选 → 底部一次 `vod-apply` 写盘。**没配上的场次单独列一栏**，
 * 它们就是"实在找不到、才需要点开日期格手动补"的那些。
 *
 * ## 三条不许违反的
 *
 * 1. `auto_ok=false` 的行**默认不勾**（兜底匹配只是"同一天 + 时长不短"，
 *    要人看一眼 —— 误配比漏配更糟）；
 * 2. 写入**逐条独立**：失败的那些逐条列出原因，不静默吞（后端就是这么回的）；
 * 3. 扫描失败 / 没配上 **都不许说成"这个号没有录播"** —— 分别给不同的话与出路。
 *
 * ## 写入回执（2026-10-15 用户实测后重做）
 *
 * 用户原话：「点击『写入勾选的 178 条』之后**没有明显的反馈**，甚至按钮灰了一段时间之后
 * 还是原本的按钮，用户无法得知是否确实写入了，并且再次进行扫描的时候结果还是一样」。
 *
 * 三个原因叠在一起：
 *
 * 1. 回执块原来挂在**滚动区最底下** —— 178 行之后，等于没有；
 * 2. 概要条的「配上 N 场」读的是 `scan.matches`，写完之后**数字不变**；
 * 3. 写成功的行**留在表里**、勾还打着，按钮又变回「写入勾选的 178 条」。
 *
 * ⇒ 现在：回执进概要条（`.lvc-stat-ok`，常驻可见）、写成功的行**当场从表里移走**
 * （计数跟着掉）、按钮变成「已写入 N 条」且不可再点、「取消」变「完成」。
 * 失败的那些**留在表里**并逐条给原因（还能重试）。
 *
 * ## 「清空已匹配」（2026-10-15 用户要求）
 *
 * **不在这个窗里** —— 见下面的墓碑注释，它在日历工具栏的 `+` 下拉栏。
 */
export default function VodFillDialog({
  open, accountId, vodAccountUid = null, onClose, onApplied, onEditVodAccount,
}: Props) {
  const [scan, setScan] = useState<VodScanResult | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<VodApplyOut | null>(null)

  /** 打开就扫一遍（关掉再开重新扫：用户改过录播号/来源之后要看到新结果）。 */
  useEffect(() => {
    if (!open || accountId == null) return
    let alive = true
    setBusy(true)
    setError(null)
    setApplied(null)
    setScan(null)
    setRows([])
    api
      .vodScan(accountId, {})
      .then((res) => {
        if (!alive) return
        setScan(res)
        setRows(res.matches.map((m) => ({ match: m, checked: m.auto_ok, altIdx: null })))
      })
      .catch((e: Error) => {
        if (alive) setError(e.message || '扫描失败')
      })
      .finally(() => {
        if (alive) setBusy(false)
      })
    return () => {
      alive = false
    }
  }, [open, accountId])

  const chosen = useMemo(
    () => rows.filter((r) => r.checked).map((r) => ({ live_id: r.match.live_id, ...picked(r) })),
    [rows],
  )

  const toggle = (liveId: string) =>
    setRows((prev) =>
      prev.map((r) => (r.match.live_id === liveId ? { ...r, checked: !r.checked } : r)),
    )

  const swap = (liveId: string) =>
    setRows((prev) =>
      prev.map((r) => {
        if (r.match.live_id !== liveId) return r
        const n = r.match.alternates.length
        if (n === 0) return r
        // 主选 → 备选 0 → 备选 1 … → 回到主选
        const next = r.altIdx == null ? 0 : r.altIdx + 1 >= n ? null : r.altIdx + 1
        return { ...r, altIdx: next }
      }),
    )

  const apply = async () => {
    if (accountId == null || chosen.length === 0 || applying) return
    setApplying(true)
    setError(null)
    const sent = chosen.map((c) => c.live_id)
    try {
      const out = await api.vodApply(
        accountId, chosen.map((c) => ({ live_id: c.live_id, vod_url: c.permalink })))
      setApplied(out)
      if (out.applied > 0) {
        // ★ 写进去的那些**当场从表里拿掉**（用户 2026-10-15：「看不出是否确实写入了」）。
        // 两个作用：① 列表当场变短、按钮变成「已写入 N 条」—— 这是最直接的证据；
        // ② 与"再扫一遍时它们不该再出现"这条口径**在界面上先对上**
        //   （服务端按 `vod_url` 排除，见 `vod_scan.scan`）。
        const okIds = new Set(
          out.results.length ? out.results.filter((r) => r.ok).map((r) => r.live_id) : sent)
        setRows((prev) => prev.filter((r) => !okIds.has(r.match.live_id)))
        onApplied(out)
      }
    } catch (e) {
      setError((e as Error).message || '写入失败')
    } finally {
      setApplying(false)
    }
  }

  const failed = applied?.results.filter((r) => !r.ok) ?? []
  const noMid = scan != null && scan.mids.length === 0
  /** 已经写成功过（用来把按钮换成"已写入 N 条"、把"取消"换成"完成"）。 */
  const done = (applied?.applied ?? 0) > 0

  /**
   * 扫描**已经跑了多少秒**（2026-10-15 用户：「一直卡在加载」）。
   *
   * 扫描要打上游取整个系列（实测 1–3 秒，网络慢时更久），光一个转圈分不清
   * "在动"与"卡死了" —— 把秒数摆出来，用户自己就能判断该等还是该取消。
   */
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!busy) return
    const t0 = Date.now()
    setElapsed(0)
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500)
    return () => clearInterval(id)
  }, [busy])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="lvc-fill lc-dlg-layer p-0 gap-0"
                     overlayClassName="lc-dlg-backdrop lc-dlg-layer"
                     showCloseButton={false} onOpenAutoFocus={noScrollAutoFocus}>
        <div className="lc-ms-head">
          <DialogTitle className="lc-ms-title">录播填充</DialogTitle>
          <DialogDescription className="lc-ms-sub">
            扫这个 V 的录播号，按录播标题里的场次时间对上号 —— 确认后一次写入
          </DialogDescription>
        </div>

        <div className="lvc-summary" data-vod-fill-summary="1">
          {busy && (
            <span className="lvc-stat" data-vod-fill-busy="1">
              <Loader2 className="size-3 animate-spin" /> 正在扫描…
              {elapsed > 0 && `（已 ${elapsed}s）`}
              <span className="lvc-stat-dim"> · 要打上游取整个系列，几秒钟；可以点「取消」关掉</span>
            </span>
          )}
          {scan && !busy && (
            <>
              {/* ⚠️ 计数用 `rows.length` 而**不是** `scan.matches.length`：写完之后列表会当场
                  变短，用扫描结果会把"已经写进去了"这件事显示成没发生（用户报的就是这个）。 */}
              <span className="lvc-stat" data-vod-fill-matched={rows.length}>
                配上 <b>{rows.length}</b> 场
              </span>
              <span className="lvc-stat" data-vod-fill-unmatched={scan.unmatched.length}>
                没找着 <b>{scan.unmatched.length}</b> 场
              </span>
              <span className="lvc-stat lvc-stat-dim" data-vod-fill-scanned={scan.mids.join(',')}>
                扫了 {scan.accounts.length} 个号（{scan.mids.join('、')}）·{' '}
                {scan.items_total} 条候选
              </span>
            </>
          )}
          {/* ★ 写入回执放在**概要条**（用户 2026-10-15：「点击之后没有明显的反馈」）。
              旧位置在滚动区**最底下**，178 行之后 —— 用户看不到，等于没有回执。 */}
          {done && (
            <span className="lvc-stat lvc-stat-ok" data-vod-fill-applied={applied!.applied}>
              <CheckCircle2 className="size-3" /> 已写入 <b>{applied!.applied}</b> 条
              {applied!.failed > 0 && ` · 失败 ${applied!.failed} 条`}
            </span>
          )}
          {/* 没填录播号时把这条**显式**说出来：那时扫的只有 V 自己的号，
              "命中少"是预期内的，不是功能坏了（用户填了号就能多扫一大片录播）。 */}
          {scan && !busy && !vodAccountUid && !noMid && (
            <span className="lvc-stat lvc-stat-warn" data-vod-fill-no-mid-hint="1">
              还没填录播号 —— 现在只扫了 V 自己的号
            </span>
          )}
          {/* 某个号**没扫到**时要如实说（2026-10-15 真机：优先级最高的那个号
              `94009831` 根本没有可扫的来源，只在 `accounts[].error` 里 ——
              不摆出来的话，用户只会看到"怎么才配上这么点"，看不出是那个号白扫了）。 */}
          {scan && !busy && scan.accounts.filter((a) => a.error).map((a) => (
            <span key={a.mid} className="lvc-stat lvc-stat-warn"
                  data-vod-fill-account-error={a.mid}>
              <AlertTriangle className="size-3" /> 号 {a.mid} 没扫到：{a.error}
            </span>
          ))}
          {error && (
            <span className="lvc-stat lvc-stat-warn" data-vod-fill-error="1">
              <AlertTriangle className="size-3" /> {error}
            </span>
          )}
        </div>

        <OverlayScroll className="lvc-body">
          {/* 空态：没有任何可扫的号 —— 给出路，不停在"扫描中"或空白 */}
          {noMid && (
            <p className="lvc-empty" data-vod-fill-no-mid="1">
              这个 V 还没有可扫的录播号。
              {onEditVodAccount && (
                <>
                  {' '}
                  <button type="button" className="lvc-link" data-vod-fill-edit-mid="1"
                          onClick={onEditVodAccount}>
                    去填一个
                  </button>
                </>
              )}
              {!onEditVodAccount && ' 先在档案设置里把录播号填上。'}
            </p>
          )}

          {/* 扫了但一个号都没取到：**如实说**，别显示成"没有录播" */}
          {scan && !busy && scan.matches.length === 0 && scan.unmatched.length === 0 && (
            <p className="lvc-empty">这个账号还没有场次可配。</p>
          )}

          {rows.length > 0 && (
            <div className="lvc-list" data-vod-fill-matches="1">
              {rows.map((r) => {
                const p = picked(r)
                const low = r.match.confidence !== 0
                return (
                  <label key={r.match.live_id} className="lvc-row"
                         data-vod-fill-row={r.match.live_id}
                         data-vod-fill-checked={r.checked ? '1' : '0'}
                         data-vod-fill-confidence={r.match.confidence}>
                    <input type="checkbox" className="lvc-check"
                           data-vod-fill-check={r.match.live_id}
                           checked={r.checked} onChange={() => toggle(r.match.live_id)} />
                    <span className="lvc-col lvc-col-session">
                      <span className="lvc-time">{formatDateTime(r.match.start_at)}</span>
                      <span className="lvc-session-title">
                        {r.match.live_title || '（无标题）'}
                      </span>
                    </span>
                    <span className="lvc-col lvc-col-vod">
                      <span className="lvc-vod-title" title={p.title}>{p.title}</span>
                      <span className="lvc-vod-meta">
                        <span className={`lvc-badge${low ? ' low' : ''}`}>
                          {basisText(r.match)}
                        </span>
                        {r.match.minutes_delta != null && ` · 差 ${fmtDelta(r.match.minutes_delta)}`}
                        {r.match.duration_minutes != null && ` · ${r.match.duration_minutes} 分钟`}
                        {` · ${r.match.bvid}`}
                        {r.match.source_name && ` · 来自「${r.match.source_name}」`}
                      </span>
                    </span>
                    {r.match.alternates.length > 0 && (
                      <button type="button" className="lvc-swap"
                              data-vod-fill-swap={r.match.live_id}
                              title={`这一场还有 ${r.match.alternates.length} 条（同场拆段）—— 点一下换一条`}
                              onClick={(e) => {
                                e.preventDefault()
                                swap(r.match.live_id)
                              }}>
                        {r.altIdx == null ? `换一条（+${r.match.alternates.length}）`
                                          : `备选 ${r.altIdx + 1}/${r.match.alternates.length}`}
                      </button>
                    )}
                  </label>
                )
              })}
            </div>
          )}

          {/* 没配上的那一列：**这就是"手动补"的入口** */}
          {scan && scan.unmatched.length > 0 && (
            <div className="lvc-gaps" data-vod-fill-gaps="1">
              <div className="lvc-gaps-head">
                这些场次没找着录播（{scan.unmatched.length}）——
                点日期格打开详情，在封面上手动加
              </div>
              {scan.unmatched.slice(0, 40).map((u) => (
                <div key={u.live_id} className="lvc-gap" data-vod-gap={u.live_id}>
                  <span className="lvc-time">{formatDateTime(u.start_at)}</span>
                  <span className="lvc-session-title">{u.live_title || '（无标题）'}</span>
                </div>
              ))}
              {scan.unmatched.length > 40 && (
                <div className="lvc-gap lvc-gap-more">
                  …… 还有 {scan.unmatched.length - 40} 场
                </div>
              )}
            </div>
          )}

          {/* 逐条失败原因（成功那部分已经在概要条上给过回执了，这里只列失败） */}
          {failed.length > 0 && (
            <div className="lvc-applied" data-vod-fill-applied-detail={failed.length}>
              <div className="lvc-applied-head">
                这 {failed.length} 条没写进去：
              </div>
              {failed.map((f) => (
                <div key={f.live_id} className="lvc-applied-row">
                  {f.live_id}：{f.error}
                </div>
              ))}
            </div>
          )}
        </OverlayScroll>

        <div className="lc-ms-actions">
          {/* ⚠️ 「清空已匹配」**2026-10-15 搬去日历工具栏的 `+` 下拉栏**了（用户口径：
              「把清空匹配的功能放在点开加号的下拉栏里面」）—— 它是**窗口级/全局级**动作，
              而且第一版放在这儿时还带着"每次先真扫一遍"的毛病（19 次上游请求 + 逐条 commit
              ⇒ 用户报成"阻塞读写、清完地址还在"）。现在服务端按 `vod_source` 记账、
              纯数据库一次提交，确认窗在 `LiveCalendar` 里。**别再把入口加回来。** */}
          <span className="lc-ms-spacer" />
          <button type="button" className="lc-ms-btn" onClick={onClose} disabled={applying}>
            {done ? '完成' : '取消'}
          </button>
          <button type="button" className="lc-ms-btn primary" data-vod-fill-apply="1"
                  disabled={applying || chosen.length === 0}
                  title={done ? `已写入 ${applied!.applied} 条`
                              : chosen.length === 0 ? '先勾几条' : `写入 ${chosen.length} 条`}
                  onClick={() => void apply()}>
            {applying ? '写入中…'
                      : done ? `已写入 ${applied!.applied} 条`
                             : `写入勾选的 ${chosen.length} 条`}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
