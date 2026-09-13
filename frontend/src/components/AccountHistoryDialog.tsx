import { useEffect, useState } from 'react'
import { History, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api } from '../api/api'
import type { Account, AccountStatSnapshot, VTuberFormerValues } from '../api/types'
import { PLATFORM_LABEL } from '../utils/postTypes'
import {
  formerForAccount,
  snapshotSourceLabel,
  snapshotVisibleFields,
} from '../utils/accountHistory'
import OverlayScroll from './OverlayScroll'
import './../styles/posts.css'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  vtuberId: number | null
  account: Account | null
}

/** 快照一次拉多少条：只做"看一眼历史"，不做全量浏览（要全量可调 `?limit=` 上限 1000） */
const SNAPSHOT_LIMIT = 60

/**
 * 「账号信息历史」弹窗（R9，devlog/080）。
 *
 * 用户口径：曾用名/曾用签名**属于「账号信息历史快照」这一类**，而且要是"V 在平台上
 * 曾经用过的值"（抓取覆盖前记账），不是本地手改入库的字符串 —— 所以两段数据各有出处：
 *
 * | 区块 | 来源 | 什么时候有 |
 * |---|---|---|
 * | 曾用名 / 曾用签名 | `vtuber_field_history`（**仅抓取覆盖前记账**） | 平台侧昵称/签名真的变过 |
 * | 账号信息快照 | `account_stat_snapshots` | 每次账号抓取成功追加一行 |
 *
 * ⚠️ 刻意**不做**的事：
 * - 不复用档案设置弹窗的内联展示（2026-09-13 用户否掉的正是那种"混在编辑区里"的形态）；
 * - 不把快照塞进 `VTuberOut`（`/vtuber/list` 返回全部 V，塞进去就是 N+1）；
 * - 不显示"当前值"（当前昵称/签名在弹窗标题与账号行上已经有了，这里只回答"以前是什么"）。
 */
export default function AccountHistoryDialog({ open, onOpenChange, vtuberId, account }: Props) {
  const [former, setFormer] = useState<VTuberFormerValues | null>(null)
  const [snaps, setSnaps] = useState<AccountStatSnapshot[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !account) return
    let cancelled = false
    setLoading(true)
    setFormer(null)
    setSnaps(null)
    Promise.all([
      vtuberId == null ? Promise.resolve(null) : api.getFormerValues(vtuberId),
      api.statSnapshots(account.id, SNAPSHOT_LIMIT),
    ])
      .then(([f, s]) => {
        if (cancelled) return
        setFormer(f)
        setSnaps(s)
      })
      .catch((e: Error) => {
        if (!cancelled) toast.error(`历史加载失败：${e.message}`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, account, vtuberId])

  const byAccount = formerForAccount(former, account?.id ?? null)
  const platform = account ? (PLATFORM_LABEL[account.platform] ?? account.platform) : ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ah-dialog">
        <DialogHeader>
          <DialogTitle className="ah-title">
            <History className="size-4" />
            账号信息历史
          </DialogTitle>
          <DialogDescription className="ah-desc">
            {account
              ? `${platform} · ${account.display_name ?? account.platform_uid}`
              : '未选择账号'}
            ：这里只回答「以前是什么」—— 曾用值是**平台侧**被覆盖掉的旧值，
            快照是每次抓取到的粉丝数与直播状态。
          </DialogDescription>
        </DialogHeader>

        <OverlayScroll className="ah-scroll">
          <section className="ah-sec">
            <h4 className="ah-sec-title">
              曾用名 / 曾用签名
              <span className="ah-hint">只记平台侧改动</span>
            </h4>
            {loading && <div className="ah-empty"><Loader2 className="size-3 animate-spin" />读取中…</div>}
            {!loading && byAccount.names.length === 0 && byAccount.signs.length === 0 && (
              <div className="ah-empty">
                还没有记录 —— 只有**抓取到**昵称/签名与上次不同时才会留下旧值
                （手改不入账）。
              </div>
            )}
            {!loading && (byAccount.names.length > 0 || byAccount.signs.length > 0) && (
              <ul className="ah-former">
                {byAccount.names.length > 0 && (
                  <li>
                    <span className="ah-former-key">曾用名</span>
                    <span className="ah-former-vals">
                      {byAccount.names.map((f, i) => (
                        <span key={`n-${i}`} className="ah-former-val">
                          {f.value}
                          {f.changed_at && <em>{f.changed_at.slice(0, 10)}</em>}
                        </span>
                      ))}
                    </span>
                  </li>
                )}
                {byAccount.signs.length > 0 && (
                  <li>
                    <span className="ah-former-key">曾用签名</span>
                    <span className="ah-former-vals">
                      {byAccount.signs.map((f, i) => (
                        <span key={`s-${i}`} className="ah-former-val">
                          {f.value}
                          {f.changed_at && <em>{f.changed_at.slice(0, 10)}</em>}
                        </span>
                      ))}
                    </span>
                  </li>
                )}
              </ul>
            )}
            {!loading && byAccount.otherCount > 0 && (
              <div className="ah-note">
                该 V 另有 {byAccount.otherCount} 条旧值属于**其它平台账号**（含已移除账号），
                换到那个账号上看。
              </div>
            )}
          </section>

          <section className="ah-sec">
            <h4 className="ah-sec-title">
              账号信息快照
              <span className="ah-hint">
                {snaps ? `最近 ${snaps.length} 条 · 时间倒序` : '时间倒序'}
              </span>
            </h4>
            {loading && <div className="ah-empty"><Loader2 className="size-3 animate-spin" />读取中…</div>}
            {!loading && snaps && snaps.length === 0 && (
              <div className="ah-empty">暂无快照（账号抓取成功后每次追加一行）。</div>
            )}
            {!loading && snaps && snaps.length > 0 && (
              <ul className="ah-snaps">
                {snaps.map((s) => {
                  const v = snapshotVisibleFields(s)
                  return (
                    <li key={s.id} className="ah-snap">
                      <span className="ah-snap-time">{s.captured_at.slice(0, 16).replace('T', ' ')}</span>
                      <span className="ah-snap-main">
                        {v.followers && <b>{v.followers}</b>}
                        {v.live && <i className={s.live_status === 1 ? 'on' : ''}>{v.live}</i>}
                        {v.title && <span className="ah-snap-title">{v.title}</span>}
                      </span>
                      <span className="ah-snap-src">{snapshotSourceLabel(s.source)}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </OverlayScroll>

        <div className="ah-foot">
          <button type="button" className="ah-close" onClick={() => onOpenChange(false)}>
            关闭
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
