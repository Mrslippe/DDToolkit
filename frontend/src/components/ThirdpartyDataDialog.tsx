import { useCallback, useEffect, useState } from 'react'
import { CloudDownload, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api } from '../api/api'
import type { ThirdpartyAccount, ThirdpartyBlock, ThirdpartyOverview } from '../api/types'
import { formatDate } from '../utils/format'
import FloatPill from './common/FloatPill'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  vtuberId: number
  /** V 名（标题里带上，用户才知道补的是谁） */
  name?: string | null
}

/** 一块数据的显示：`1,234 条 · 最新 2026-10-03`（没有数据时如实说"空"） */
function blockText(b: ThirdpartyBlock | undefined): string {
  if (!b || b.rows === 0) return '空'
  // ⚠️ 走 `formatDate` 而不是 `slice(0, 10)`：这里的字段**两种形态都有**
  //（快照/场次是带时刻的 ISO 时间戳 ⇒ 要转本地；礼物日是纯日期串 ⇒ 原样返回），
  // 而 `formatDate` 正是按这两条写的（2026-10-10 自审 F4，`devlog/461`）。
  const day = (s: string | null) => (s ? formatDate(s) : '—')
  return `${b.rows} 条 · ${day(b.first_at)} → ${day(b.last_at)}`
}

/**
 * 「第三方数据」小窗（2026-10-05，`devlog/354`）。
 *
 * ## 为什么要有它
 *
 * 用户：「当前如果历史第三方数据丢失了就没法获取了，例如恬豆发芽了 9.28-10.2 的直播记录」。
 * 第三方数据（zeroroku 的粉丝历史/礼物日、danmakus 的直播场次）只靠**每日批次**入库，
 * 而那条路会失败（WAF 拦、上游抖动）或被清掉 —— 那时界面上既看不出缺了什么，
 * 也没有任何手动入口。所以这个窗做两件事：
 *
 * 1. **现状**：三块各有多少条、最新到哪天（对着缺口一眼能看出停在哪一天）；
 * 2. **补拉**：一枚按钮，按账号白名单只打这个 V（收录回填同款口径）。
 *
 * ## 口径（别在界面上说错话）
 *
 * - **上游一次返回全部历史** ⇒ 不需要选日期范围："补 9.28–10.2" 就是拉一次全量
 *   （幂等 upsert，重复拉不会重复入库）；
 * - 第三方（zeroroku / danmakus）与**本工具直采**（self / feed）**分开列** ——
 *   合成一个数会让人以为"第三方有 1500 条"，而其中一大半是我们自己抓的；
 * - 源被设置关掉时按钮禁用并说明原因（关着时点它一条都不会发，静默失败最气人）。
 */
export default function ThirdpartyDataDialog({ open, onOpenChange, vtuberId, name }: Props) {
  const [data, setData] = useState<ThirdpartyOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api.thirdpartyOverview(vtuberId)
      setData(d)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [vtuberId])

  useEffect(() => {
    if (!open) return
    setData(null)
    setError(null)
    void load()
  }, [open, load])

  const sourcesOff = !!data && data.sources.length > 0 && data.sources.every((s) => !s.enabled)
  const running = !!data?.running
  const blocked = busy || running || sourcesOff
  const blockedWhy = sourcesOff
    ? '「第三方数据同步」在设置里关着 —— 打开它（设置 → 抓取设置）之后才能拉'
    : running
      ? '已有第三方数据任务在跑，等它跑完再试'
      : undefined

  const doRefresh = async () => {
    setBusy(true)
    try {
      const r = await api.refreshThirdparty(vtuberId)
      toast.success(`已开始补拉 ${r.accounts.length} 个账号的第三方数据，进度见顶栏`)
      onOpenChange(false)
    } catch (e) {
      toast.error(`补拉失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="tp-dialog" data-thirdparty-dialog="1">
        <DialogHeader>
          <DialogTitle>第三方数据{name ? ` · ${name}` : ''}</DialogTitle>
          <DialogDescription>
            粉丝历史与礼物日来自 zeroroku，直播场次来自 danmakus。
            <b>上游一次返回全部历史</b>，所以补拉不需要选日期 —— 缺哪一段都会一起补回来。
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="tp-error" data-thirdparty-error="1">
            读取现状失败：{error}
            <FloatPill shape="text" size="sm" onClick={() => void load()}>重试</FloatPill>
          </p>
        )}

        {!data && !error && (
          <p className="tp-loading"><Loader2 className="size-4 animate-spin" />读取中…</p>
        )}

        {data && (
          <div className="tp-body">
            {data.thirdparty_accounts.length === 0 && (
              <p className="tp-empty">这个 V 没有 bilibili 账号 —— 第三方数据是按 B 站账号拉的</p>
            )}
            {data.thirdparty_accounts.map((a) => (
              <AccountBlock key={a.account_id} acc={a} />
            ))}

            <p className="tp-sources" data-thirdparty-sources={
              data.sources.map((s) => `${s.name}:${s.enabled ? 'on' : 'off'}`).join(',')}>
              数据源：{data.sources.length === 0
                ? '没有可用的源'
                : data.sources.map((s) => `${s.name}${s.enabled ? '' : '（已关闭）'}`).join(' · ')}
            </p>
          </div>
        )}

        <div className="tp-foot">
          <span className="tp-foot-note">
            补拉是全量：已经在库里的行按「账号 + 场次/日期」去重，重复拉不会重复入库。
          </span>
          {/* ⚠️ 页脚按钮用**浮片**（`float-pill`）：二级弹窗的页脚是全站一套
              （`utils/dialogFoot.test.ts` 冻结了弹窗清单 —— 新增弹窗必须在这里被判一次，
              漏掉在界面上看不出来，只会觉得"这个窗的按钮好像不太一样"）。 */}
          <FloatPill
            shape="text"
            active
            data-thirdparty-refresh="1"
            disabled={blocked}
            title={blockedWhy}
            onClick={() => void doRefresh()}
          >
            {busy || running
              ? <Loader2 className="size-4 animate-spin" />
              : <CloudDownload className="size-4" />}
            补拉这个 V 的第三方数据
          </FloatPill>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 一个账号的三块现状（第三方 / 直采分开列） */
function AccountBlock({ acc }: { acc: ThirdpartyAccount }) {
  return (
    <div className="tp-acc" data-thirdparty-account={acc.account_id}>
      <div className="tp-acc-head">
        {acc.display_name || acc.platform_uid || `账号 #${acc.account_id}`}
        <span className="tp-acc-uid">{acc.platform_uid}</span>
      </div>
      <ul className="tp-rows">
        <li>
          <span className="tp-k">直播场次（danmakus）</span>
          <span className="tp-v" data-thirdparty-live={acc.live_sessions.rows}>
            {blockText(acc.live_sessions)}
          </span>
        </li>
        <li>
          <span className="tp-k">粉丝历史（zeroroku）</span>
          <span className="tp-v">{blockText(acc.fan_history)}</span>
        </li>
        <li>
          <span className="tp-k">礼物日聚合（zeroroku）</span>
          <span className="tp-v">{blockText(acc.gift_days)}</span>
        </li>
        <li className="tp-row-local">
          <span className="tp-k">本工具自己抓的</span>
          <span className="tp-v">
            快照 {acc.fan_history_local.rows} 条 · 实时场次 {acc.live_sessions_feed.rows} 条
          </span>
        </li>
      </ul>
    </div>
  )
}
