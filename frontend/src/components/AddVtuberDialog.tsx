import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Search, UserPlus, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api } from '../api/api'
import type { BiliSearchResult } from '../api/types'
import {
  biliToCandidates,
  followerLabel,
  inputLooksLikeUid,
  mergeCandidates,
  originLabel,
  poolToCandidates,
  type AddCandidate,
} from '../utils/addVtuberSearch'
import OverlayScroll from './OverlayScroll'
import ProxyImage from './common/ProxyImage'
import './../styles/posts.css'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 收录成功回调（父级刷新列表） */
  onAdded: () => void
}

/** B 站检索失败时的兜底形状（客户端侧失败：请求没通/被中断） */
function failResult(page: number, hint: string): BiliSearchResult {
  return {
    items: [],
    page,
    total_pages: 0,
    has_more: false,
    error: 'network_error',
    hint,
    exact: false,
    cached: false,
  }
}

/**
 * 添加 VTuber 浮窗（R11，devlog/083）。
 *
 * **两个来源，触发方式刻意不同**：
 * - **本地候选**（`csv` 候选池 + `danmakus` 索引）：输入即防抖检索，**不打上游**；
 * - **B 站在线检索**：只在**显式触发**（回车 / 点「搜索 B 站」/ 点「加载更多」）时才请求。
 *   后端有 0.8s 串行 + 每分钟 20 次上限 + 5 分钟缓存，但把"每次敲键都打上游"省掉，
 *   风控预算才花在用户真要看的词上。
 *
 * 三条与"看得见却点不动 / 点了失败"有关的约定：
 * 1. **纯数字（≥5 位）= UID 直查**（B 站搜索接口搜不到 uid，实测 `keyword=<uid>` → 0 条），
 *    按钮文案随之变成「按 UID 添加」；判定与后端 `bili_search.looks_like_uid` 同口径；
 * 2. 在线结果 `in_library=true` 的条目**置灰不可点**（点了必然 409）；
 * 3. 上游失败（风控/降级/网络）**如实展示 `hint`**，绝不退化成"没有这个人"——
 *    实测缺搜索页请求头时 B 站会 `code=0` 但静默 0 条，这种坑必须让用户看得见。
 */
export default function AddVtuberDialog({ open, onOpenChange, onAdded }: Props) {
  const [kw, setKw] = useState('')
  const [local, setLocal] = useState<AddCandidate[]>([])
  const [searchingLocal, setSearchingLocal] = useState(false)
  /** B 站检索结果：null = 还没搜过（与"搜了但 0 条"是两回事，文案不同） */
  const [bili, setBili] = useState<BiliSearchResult | null>(null)
  const [biliLoading, setBiliLoading] = useState(false)
  const [adoptingKey, setAdoptingKey] = useState<string | null>(null)
  const timerRef = useRef<number>()
  const biliCtrl = useRef<AbortController | null>(null)

  // 关闭时清态（含打断在途的 B 站检索：关窗后回来的结果没人要）
  useEffect(() => {
    if (!open) {
      setKw('')
      setLocal([])
      setBili(null)
      setAdoptingKey(null)
      biliCtrl.current?.abort()
    }
  }, [open])

  // ── 本地候选：输入防抖 250ms（AbortController 取消在途请求防竞态，沿用旧行为）──
  useEffect(() => {
    if (!open) return
    window.clearTimeout(timerRef.current)
    const q = kw.trim()
    if (!q) {
      setLocal([])
      setSearchingLocal(false)
      return
    }
    setSearchingLocal(true)
    const controller = new AbortController()
    timerRef.current = window.setTimeout(async () => {
      try {
        const r = await api.searchPool(q, controller.signal)
        if (controller.signal.aborted) return
        setLocal(poolToCandidates(r))
      } catch (e) {
        if ((e as Error).name === 'AbortError') return // 已被更新的关键词取代
        setLocal([])
      } finally {
        if (!controller.signal.aborted) setSearchingLocal(false)
      }
    }, 250)
    return () => {
      window.clearTimeout(timerRef.current)
      controller.abort()
    }
  }, [kw, open])

  /** B 站检索（显式触发；page > 1 = 加载更多，与已有结果拼接） */
  const runBiliSearch = useCallback(
    async (page = 1) => {
      const q = kw.trim()
      if (!q) return
      biliCtrl.current?.abort()
      const ac = new AbortController()
      biliCtrl.current = ac
      setBiliLoading(true)
      try {
        const r = await api.biliSearch(q, page, ac.signal)
        if (ac.signal.aborted) return
        setBili((prev) =>
          page > 1 && prev && !prev.error && !r.error
            ? { ...r, items: [...prev.items, ...r.items] }
            : r,
        )
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        setBili(failResult(page, `B 站检索没通：${(e as Error).message}`))
      } finally {
        if (!ac.signal.aborted) setBiliLoading(false)
      }
    },
    [kw],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void runBiliSearch(1)
    }
  }

  const adopt = async (row: AddCandidate) => {
    if (row.inLibrary) return
    setAdoptingKey(row.key)
    try {
      await api.adoptVtuber(row.platform, row.platform_uid, undefined, row.adoptSource)
      // 踢一脚 TopBar 立即轮询：捕获本次单V抓取进入 running 态，
      // 保证其完成时 running→idle 边沿必然派发 fetch-idle（防竞态漏刷新）
      window.dispatchEvent(new Event('ddtoolkit:kick-poll'))
      toast.success(`已收录「${row.name}」，正在抓取账号信息与最新动态…`)
      onAdded()
      onOpenChange(false)
    } catch (e) {
      toast.error(`收录失败：${(e as Error).message}`)
    } finally {
      setAdoptingKey(null)
    }
  }

  const rows = mergeCandidates(local, bili ? biliToCandidates(bili.items) : [])
  const isUid = inputLooksLikeUid(kw)
  const busy = adoptingKey !== null
  const q = kw.trim()

  const rowButton = (row: AddCandidate) => {
    const busyThis = adoptingKey === row.key
    const fans = followerLabel(row.followers)
    return (
      <button
        key={row.key}
        type="button"
        data-uid={row.platform_uid}
        disabled={busy || row.inLibrary}
        title={row.inLibrary ? '该账号已在库里' : `收录 ${row.name}（uid ${row.platform_uid}）`}
        onClick={() => void adopt(row)}
        className={`av-row${row.inLibrary ? ' off' : ''}`}
      >
        {row.avatar ? (
          <ProxyImage src={row.avatar} alt="" className="av-ava" width={30} height={30} />
        ) : (
          <span className="av-ava av-ava-ph">{row.name.slice(0, 1)}</span>
        )}
        <span className="av-main">
          <span className="av-name">
            <b className="av-name-text">{row.name}</b>
            {row.exact && <em className="av-tag">按 UID 精确</em>}
          </span>
          <span className="av-sub">
            <span className={`av-origin o-${row.origin}`}>{originLabel(row.origin)}</span>
            {row.verified && <span className="av-verified">{row.verified}</span>}
            {fans && <span className="av-num">{fans}</span>}
            {row.group && <span className="av-group">{row.group}</span>}
            {row.isLive && <span className="av-live">直播中</span>}
            <span className="av-num">UID {row.platform_uid}</span>
          </span>
        </span>
        {row.inLibrary ? (
          <span className="av-state">已订阅</span>
        ) : busyThis ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
        ) : (
          <UserPlus className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="av-dialog">
        <DialogHeader>
          <DialogTitle>添加 VTuber</DialogTitle>
          <DialogDescription className="av-desc">
            输入名字或 UID：本地候选（候选池 + 弹幕索引）即时匹配；
            <b>回车</b>或点「搜索 B 站」可直接从 B 站检索收录 —— 候选池里没有的新 V 也能加。
          </DialogDescription>
        </DialogHeader>

        <div className="av-search-row">
          <div className="av-input-wrap">
            <Search className="av-input-icon" />
            <input
              autoFocus
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="名字或 UID，如：塔菲 / 1265680561"
              className="av-input"
            />
            {kw && (
              <button
                type="button"
                className="av-clear"
                title="清空"
                onClick={() => {
                  setKw('')
                  setBili(null)
                }}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <button
            type="button"
            className="av-bili-btn"
            disabled={!q || biliLoading}
            onClick={() => void runBiliSearch(1)}
            title={isUid ? '按 UID 从 B 站精确添加' : '从 B 站搜索这个关键词'}
          >
            {biliLoading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Search className="size-3.5" />
            )}
            {isUid ? '按 UID 添加' : '搜索 B 站'}
          </button>
        </div>

        {/* 结果区一律用 OverlayScroll（全站约定：不出现**原生滚动条**，
            否则出现/消失会挤动布局；`.os-root` 的 max-height 容器模式正是弹窗用法） */}
        <OverlayScroll className="av-list">
          {searchingLocal && rows.length === 0 && (
            <div className="av-hint-row">
              <Loader2 className="size-4 animate-spin" /> 检索本地候选…
            </div>
          )}

          {!q && (
            <div className="av-hint-row">
              输入关键词：本地候选即时匹配（候选池 + 弹幕索引）；
              要加名单外的新 V 就搜 B 站。
            </div>
          )}

          {q && !searchingLocal && rows.length === 0 && !bili && (
            <div className="av-hint-row">
              本地候选没有匹配。
              <button type="button" className="av-link" onClick={() => void runBiliSearch(1)}>
                从 B 站搜索「{q}」
              </button>
            </div>
          )}

          {rows.map(rowButton)}

          {/* B 站区块的状态：结论一律由后端 `hint` 说了算（风控/降级/网络各不同） */}
          {bili?.error && (
            <div className="av-hint-row err">
              {bili.hint || 'B 站检索没取到结果'}
              {bili.error === 'rate_limited' && '（等几秒再试）'}
            </div>
          )}
          {bili && !bili.error && bili.items.length === 0 && (
            <div className="av-hint-row">{bili.hint || 'B 站没有匹配的 UP 主'}</div>
          )}
          {bili && !bili.error && bili.items.length > 0 && (
            <div className="av-hint-row">
              B 站命中 {bili.items.length} 条{bili.cached && '（缓存）'}
              {bili.has_more && (
                <button
                  type="button"
                  className="av-link"
                  disabled={biliLoading}
                  onClick={() => void runBiliSearch(bili.page + 1)}
                >
                  加载更多（第 {bili.page + 1} 页）
                </button>
              )}
            </div>
          )}
        </OverlayScroll>
      </DialogContent>
    </Dialog>
  )
}
