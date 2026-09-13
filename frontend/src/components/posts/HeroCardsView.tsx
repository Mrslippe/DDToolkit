/**
 * 展示页（cards 视图）：Hero 卡 + 平台药丸（P2 分层收敛剩余项，2026-09-13，devlog/065）。
 *
 * 从 `pages/PostsPage.tsx` 整块搬出，**只搬不改**：
 * - 同一份 JSX（`.hero` / `.hero-avatar` / `.live-tag` / `.stat-sets` / `.pill-add` /
 *   `.hero-divider`）逐字保留 —— `ui_probe.py --hero-print` 的位级签名直接查这些节点；
 * - 药丸的**点击开主页 / 长按 350ms 拖动重排**逻辑（原先散在 PostsPage 里：
 *   4 个 state + 4 个 handler + `orderedAccounts`/`pillSets` 两个派生值）**一并搬进来**，
 *   因为只有本视图用它们 —— 搬完 PostsPage 少 4 个 state、少 4 个函数。
 *
 * 为什么这一块值得独立：它是"与页面状态几乎无关"的整块子树（只要 vtuber/accounts +
 * 一个「加账号」回调），拆出去让 PostsPage 只剩场景机与列表流。
 *
 * ⚠️ CSS 归属：仍由 `styles/posts.css` 拥有（A 路线决策 (a)：拆分不搬 CSS）。
 */
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import heroDivider from '../../assets/icons/hero-divider.svg'
import type { Account, VTuber } from '../../api/types'
import { api } from '../../api/api'
import { accountHomeUrl, chunkBy, orderAccounts } from '../../utils/postTypes'
import { pill } from '../../utils/pill'
import OverlayScroll from '../OverlayScroll'
import StatPill from '../common/StatPill'

interface Props {
  vtuber: VTuber
  /** 有 platform_uid 的账号（顺序 = 服务端 sort_order，拖拽后本地临时覆盖） */
  accounts: Account[]
  /** 头像（VTuber 本体优先，回退账号稳定源） */
  avatarSrc?: string
  /** 直播状态（只读 B 站账号；`liveAcc` 也用于拿直播标题） */
  liveAcc: Account | null
  isLive: boolean
  /** 签名来源（VTuber 整体事实：B 站优先） */
  heroAcc: Account | null
  /** 打开「添加账号」弹窗 */
  onAddAccount: () => void
}

export default function HeroCardsView({
  vtuber,
  accounts,
  avatarSrc,
  liveAcc,
  isLive,
  heroAcc,
  onAddAccount,
}: Props) {
  // ── P8-B：平台药丸的点击开主页 + 长按拖动重排 ────────────────────────
  // 顺序是服务端事实（accounts.sort_order，拖拽后 PUT 落库）；拖拽期间先用本地
  // 临时顺序渲染，松手才提交。长按 350ms 才进入拖拽，避免误触发。
  const [pillOrder, setPillOrder] = useState<number[] | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const pressTimer = useRef<number>()
  const dragMoved = useRef(false)

  const orderedAccounts = useMemo(
    () => orderAccounts(accounts, pillOrder),
    // accounts 每次渲染都是新数组，用 vtuber 做依赖避免无限重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vtuber, pillOrder],
  )

  /** 账号主页：优先用后端抓到的 url，其余平台兜底拼（见 utils/postTypes.accountHomeUrl） */
  const accountHome = accountHomeUrl

  const openHome = (a: Account) => {
    const url = accountHome(a)
    if (!url) return
    // 桌面端（Tauri）走 shell 插件的 open 命令（capability `shell:allow-open` 已就绪，
    // 无需新增 npm 依赖 —— 直接 invoke 插件命令）；失败/Web 下退化为新标签页
    if ('__TAURI_INTERNALS__' in window) {
      void import('@tauri-apps/api/core')
        .then((m) => m.invoke('plugin:shell|open', { path: url }))
        .catch(() => window.open(url, '_blank', 'noopener'))
    } else {
      window.open(url, '_blank', 'noopener')
    }
  }

  const onPillPointerDown = (idx: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    dragMoved.current = false
    window.clearTimeout(pressTimer.current)
    pressTimer.current = window.setTimeout(() => {
      setDragIdx(idx)
      setPillOrder(orderedAccounts.map((a) => a.id))
    }, 350)
  }

  const onPillPointerMove = (e: React.PointerEvent) => {
    if (dragIdx === null) return
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const raw = el?.closest('[data-pill-index]')?.getAttribute('data-pill-index')
    const target = raw === null || raw === undefined ? NaN : Number(raw)
    if (Number.isNaN(target) || target === dragIdx) return
    dragMoved.current = true
    setPillOrder((prev) => {
      const base = prev ?? orderedAccounts.map((a) => a.id)
      const next = [...base]
      const [moved] = next.splice(dragIdx, 1)
      next.splice(target, 0, moved)
      return next
    })
    setDragIdx(target)
  }

  const onPillPointerUp = () => {
    window.clearTimeout(pressTimer.current)
    if (dragIdx === null) return
    const wasDrag = dragMoved.current
    setDragIdx(null)
    if (!wasDrag) return
    const ids = pillOrder ?? orderedAccounts.map((a) => a.id)
    void api
      .reorderAccounts(vtuber.id, ids)
      .then(() => {
        pill('平台顺序已保存')
      })
      .catch((e: Error) => {
        toast.error(`保存顺序失败：${e.message}`)
        setPillOrder(null)          // 失败回退服务端顺序
      })
  }

  // 平台粉丝展示：徽章集按每集 3 枚切分（集内横排、集间纵向间隔 10）。
  const pillSets = chunkBy(orderedAccounts, 3)

  return (
    <OverlayScroll className="hero-scroll">
      {/* Hero：头像 / 直播徽标 / 名字 / 签名 / 平台药丸 / 分隔饰条 / 企划徽标 */}
      <div className="hero">
        <Avatar className="hero-avatar">
          <AvatarImage src={avatarSrc} referrerPolicy="no-referrer" />
          <AvatarFallback>{vtuber.name.slice(0, 1)}</AvatarFallback>
        </Avatar>

        {/* 直播状态：始终显示（未开播=灰点+「未开播」） */}
        <span className={`live-tag${isLive ? ' live' : ' off'}`} title={isLive ? (liveAcc?.live_title ?? '直播中') : '未开播'}>
          <i className="live-dot" />
          <span className="truncate">{isLive ? (liveAcc?.live_title ?? '直播中') : '未开播'}</span>
        </span>

        <div className="hero-name-block">
          <h2 className="hero-name">{vtuber.name}</h2>
          {heroAcc?.sign && <p className="hero-sign">{heroAcc.sign}</p>}
        </div>

        {/* 平台药丸：切 V 时依次滑入（key=vtuber.id 触发重播；
            不再跟随 list 账号切换——2026-09-05 反馈去联动） */}
        {/* P8-B：点击开主页 / 长按拖动重排 / 尾部「+」加账号 */}
        <div
          className="stat-sets"
          key={vtuber.id}
          onPointerMove={onPillPointerMove}
          onPointerUp={onPillPointerUp}
          onPointerLeave={onPillPointerUp}
        >
          {pillSets.map((set, si) => (
            <div className="stat-set anim-rise" style={{ '--rise-i': si } as React.CSSProperties} key={si}>
              {set.map((a, i) => {
                const idx = si * 3 + i
                return (
                  <StatPill
                    key={a.id}
                    platform={a.platform}
                    value={a.followers_count}
                    index={idx}
                    dataIndex={idx}
                    dragging={dragIdx === idx}
                    title={`${a.display_name ?? a.platform_uid} · 点击打开主页，长按拖动可重排`}
                    onPointerDown={onPillPointerDown(idx)}
                    onClick={() => {
                      if (dragMoved.current) {
                        dragMoved.current = false
                        return
                      }
                      openHome(a)
                    }}
                  />
                )
              })}
            </div>
          ))}
          <button
            type="button"
            className="pill-add"
            title="添加平台账号"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onAddAccount}
          >
            <Plus className="size-4" />
          </button>
        </div>

        <img src={heroDivider} alt="" className="hero-divider" />
      </div>
    </OverlayScroll>
  )
}
