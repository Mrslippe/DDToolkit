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
import type { NameSearchGroup } from '../api/types'
import {
  allGroupsEmpty,
  extraPlatforms,
  followerLabel,
  groupNote,
  groupsToCandidates,
  inputLooksLikeUid,
  mergeCandidates,
  originLabel,
  poolToCandidates,
  type AddCandidate,
} from '../utils/addVtuberSearch'
import OverlayScroll from './OverlayScroll'
import ProxyImage from './common/ProxyImage'
import { useCapabilities } from '../hooks/useCapabilities'
import { FETCH_POSTS, isLoginRequired, limitText } from '../utils/capabilities'
import { DOUYIN_UID_HINT, XHS_UID_HINT, parseDouyinUid, parseXhsUid } from '../utils/platformLogin'
import './../styles/posts.css'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 收录成功回调（父级刷新列表） */
  onAdded: () => void
}

/** 客户端侧整批失败（请求没通）→ "每个平台都失败"的形状：**逐个平台说清**，不静默 */
function failGroups(hint: string): NameSearchGroup[] {
  return (['bilibili', 'weibo', 'xiaohongshu', 'douyin'] as const).map((p) => ({
    platform: p,
    label: originLabel(p),
    items: [],
    error: 'network_error',
    hint,
    skipped: false,
    best_match_only: false,
  }))
}

/**
 * 「加载更多」：把新一页**按平台**接在后面。
 *
 * ⚠️ 不能整批替换（那会把第 1 页的结果丢掉），也不能用平台的"当前条数"当偏移
 * ——偏移由 `page` 决定（后端 `offset = (page-1)*10`），所以这里只做同平台拼接。
 * 上一页是 `error`/`skipped` 的平台保持原样（新一页若成功则用新的）。
 */
function appendGroups(prev: NameSearchGroup[] | null, next: NameSearchGroup[]): NameSearchGroup[] {
  if (!prev) return next
  const byPlatform = new Map(prev.map((g) => [g.platform, g]))
  return next.map((g) => {
    const old = byPlatform.get(g.platform)
    if (!old || !old.items?.length || g.error || g.skipped) return g
    return { ...g, items: [...old.items, ...g.items] }
  })
}

/**
 * 添加 VTuber 浮窗（R11，devlog/083；多平台检索 B1，需求 8，`devlog/463`）。
 *
 * **两个来源，触发方式刻意不同**：
 * - **本地候选**（`csv` 候选池 + `danmakus` 索引）：输入即防抖检索，**不打上游**；
 * - **在线检索**（B 站 + 微博 + 小红书 + 抖音）：只在**显式触发**（回车 / 点「搜索」）时才请求。
 *   后端每平台 1s 间隔 + 5 分钟缓存，但把"每次敲键都打上游"省掉，
 *   风控预算才花在用户真要看的词上；**抓取开关关着的平台一个请求都不发**。
 *
 * 三条与"看得见却点不动 / 点了失败"有关的约定：
 * 1. **纯数字（≥5 位）= UID 直查**（B 站搜索接口搜不到 uid，实测 `keyword=<uid>` → 0 条），
 *    按钮文案随之变成「按 UID 添加」；判定与后端 `bili_search.looks_like_uid` 同口径；
 * 2. 在线结果 `in_library=true` 的条目**置灰不可点**（点了必然 409）；
 * 3. 上游失败（风控/降级/网络/没登录）**如实展示各平台的 `hint`**，绝不退化成"没有这个人"——
 *    实测缺搜索页请求头时 B 站会 `code=0` 但静默 0 条，这种坑必须让用户看得见。
 */
export default function AddVtuberDialog({ open, onOpenChange, onAdded }: Props) {
  const [kw, setKw] = useState('')
  const { caps } = useCapabilities()
  const [local, setLocal] = useState<AddCandidate[]>([])
  const [searchingLocal, setSearchingLocal] = useState(false)
  /** 在线检索结果：null = 还没搜过（与"搜了但 0 条"是两回事，文案不同） */
  const [groups, setGroups] = useState<NameSearchGroup[] | null>(null)
  const [searchPage, setSearchPage] = useState(1)
  const [onlineLoading, setOnlineLoading] = useState(false)
  const [adoptingKey, setAdoptingKey] = useState<string | null>(null)
  const timerRef = useRef<number>()
  const onlineCtrl = useRef<AbortController | null>(null)

  // 关闭时清态（含打断在途的在线检索：关窗后回来的结果没人要）
  useEffect(() => {
    if (!open) {
      setKw('')
      setLocal([])
      setGroups(null)
      setSearchPage(1)
      setAdoptingKey(null)
      onlineCtrl.current?.abort()
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

  /** 在线检索（显式触发；page > 1 = 加载更多，按平台分别拼接） */
  const runSearch = useCallback(
    async (page = 1) => {
      const q = kw.trim()
      if (!q) return
      onlineCtrl.current?.abort()
      const ac = new AbortController()
      onlineCtrl.current = ac
      setOnlineLoading(true)
      try {
        const r = await api.searchUsers(q, undefined, page, ac.signal)
        if (ac.signal.aborted) return
        setSearchPage(page)
        setGroups((prev) => (page > 1 ? appendGroups(prev, r.groups) : r.groups))
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        // 客户端侧失败（请求没通）：造一个"每个平台都失败"的形状，**不静默**
        setGroups(prev => page > 1 ? prev : failGroups(`检索没通：${(e as Error).message}`))
      } finally {
        if (!ac.signal.aborted) setOnlineLoading(false)
      }
    },
    [kw],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void runSearch(1)
    }
  }

  const adopt = async (row: AddCandidate) => {
    if (row.inLibrary || !row.adoptable) return
    setAdoptingKey(row.key)
    try {
      await api.adoptVtuber(row.platform, row.platform_uid, undefined, row.adoptSource)
      // ⚠️ 这里原本 `emit(kickPoll)`（"踢一脚好让 TopBar 目睹 running 态"）。M5-2b 删掉
      // 它之后，"收录完成后各视图要刷新"由 M3 的**推送**兜底：后端 `_set_post_last_result`
      // 每轮收尾都 `publish(domain.posts.changed)`，前端桥接里按 seq 去重后派发 `fetch-idle`。
      // 另外后端 M5-2b 起还会为收录首屏报一条完成消息（`_adopt_background`），
      // 用户不必靠"顶栏有没有亮过"来判断这次收录跑没跑。
      toast.success(`已收录「${row.name}」，正在抓取账号信息与最新动态…`)
      onAdded()
      onOpenChange(false)
    } catch (e) {
      toast.error(`收录失败：${(e as Error).message}`)
    } finally {
      setAdoptingKey(null)
    }
  }

  /**
   * 小红书收录（第 4 阶段 ④ 第三刀-4，devlog/235）。
   *
   * 它**没有可用的搜索接口**（搜索要 `xsec_token`），所以这条路上只有"按 uid 收录"：
   * 用户粘主页链接或 uid，前端摘出 uid，后端拿它问一次主页信息**复核**后才建库。
   * 起名不由前端决定（后端取服务端名字），所以这里连名字都不用传。
   */
  const adoptXhs = async () => {
    const uid = parseXhsUid(kw)
    if (!uid) {
      toast.error(`没认出小红书 uid —— ${XHS_UID_HINT}`)
      return
    }
    setAdoptingKey(`xhs:${uid}`)
    try {
      const v = await api.adoptVtuber('xiaohongshu', uid, undefined, 'xiaohongshu')
      toast.success(`已收录「${v.name}」，正在抓取账号信息与最新动态…`)
      onAdded()
      onOpenChange(false)
    } catch (e) {
      // 404 = 上游确实没这个 uid；503 = 我们这边没就绪（没配 cookie / 正被风控）
      toast.error(`收录失败：${(e as Error).message}`)
    } finally {
      setAdoptingKey(null)
    }
  }

  /**
   * 抖音收录（第 4 阶段 ④ 第二刀，devlog/334）。
   *
   * 与小红书同款：**没有搜索接口可用**（抖音号要搜索、搜索要登录+签名），所以只有"按
   * `sec_user_id` 收录"这一条路。⚠️ 抖音的 uid 形态是 `MS4wLjABAAAA…`（不是数字）⇒
   * `parseDouyinUid` 认不出纯抖音号，认不出时这个钮**禁用**（点了只会换来 404/503）。
   */
  const adoptDouyin = async () => {
    const uid = parseDouyinUid(kw)
    if (!uid) {
      toast.error(`没认出抖音 sec_user_id —— ${DOUYIN_UID_HINT}`)
      return
    }
    setAdoptingKey(`douyin:${uid}`)
    try {
      const v = await api.adoptVtuber('douyin', uid, undefined, 'douyin')
      toast.success(`已收录「${v.name}」，正在抓取账号信息与最新动态…`)
      onAdded()
      onOpenChange(false)
    } catch (e) {
      toast.error(`收录失败：${(e as Error).message}`)
    } finally {
      setAdoptingKey(null)
    }
  }

  const rows = mergeCandidates(local, groups ? groupsToCandidates(groups) : [])
  const isUid = inputLooksLikeUid(kw)
  const busy = adoptingKey !== null
  const q = kw.trim()
  /** 输入里能不能认出一个小红书 uid（认不出 ⇒ 那个钮禁用：点了只会 404 白跑一趟） */
  const xhsUid = parseXhsUid(q)
  /** 抖音同理（它连纯抖音号都认不出 —— 那要搜索接口，devlog/334） */
  const douyinUid = parseDouyinUid(q)
  /** 未登录时"收录后抓不到内容"的提示（搜/收录本身照常） */
  const contentBlocked = isLoginRequired(caps, FETCH_POSTS)

  const rowButton = (row: AddCandidate) => {
    const busyThis = adoptingKey === row.key
    const fans = followerLabel(row.followers)
    const off = row.inLibrary || !row.adoptable
    const title = row.inLibrary
      ? '该账号已在库里'
      : row.adoptable
        ? `收录 ${row.name}（uid ${row.platform_uid}）`
        : row.blockedReason
    return (
      <button
        key={row.key}
        type="button"
        data-uid={row.platform_uid}
        /* 探针按这两个属性断言"来源 → 收录路径"的分流（索引行绝不能带 pool） */
        data-origin={row.origin}
        data-adopt-source={row.adoptSource}
        disabled={busy || off}
        title={title}
        onClick={() => void adopt(row)}
        className={`av-row${off ? ' off' : ''}`}
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
            {/* 「他还在 Twitter / YouTube」——同名小号多，这一句比粉丝数还管用。
                ⚠️ 不可点：那些主机不在外链白名单里（见 `extraPlatforms` 的说明）。 */}
            {row.extra && (
              <span className="av-elsewhere" title={row.extra}>
                他还在 {extraPlatforms(row.extra).join(' / ')}
              </span>
            )}
            {row.isLive && <span className="av-live">直播中</span>}
            <span className="av-num">UID {row.platform_uid}</span>
          </span>
        </span>
        {row.inLibrary ? (
          <span className="av-state">已订阅</span>
        ) : !row.adoptable ? (
          <span className="av-state">不在候选池</span>
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
            <b>回车</b>或点「搜索」会<b>同时在已开启的平台</b>（B 站 / 微博 / 小红书 / 抖音）
            上按名字搜人，结果按平台分组、点一下就能收录 —— 名单外的新 V 也能加。
            关掉抓取的平台不会参与检索；认不出 uid 时才用右边那两个「uid」钮。
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
                  setGroups(null)      // 清空要回到"还没搜过"的空态（残留上次结果最迷惑）
                  setSearchPage(1)
                }}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <button
            type="button"
            className="av-bili-btn"
            disabled={!q || onlineLoading}
            onClick={() => void runSearch(1)}
            title={isUid
              ? '按 UID 从 B 站精确添加'
              : '在已开启的平台上按名字搜人（B 站 / 微博 / 小红书 / 抖音）'}
          >
            {onlineLoading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Search className="size-3.5" />
            )}
            {isUid ? '按 UID 添加' : '搜索'}
          </button>
          {/* 按 uid 收录那两条路**保留**：搜索要登录态，而"用户手上就有一条主页链接"
              是常态 —— 认不出 uid 时禁用（点了只会换来 404 白跑一趟）。
              2026-10-11（B1）起四家都有搜索接口了，所以按钮说明不再写"没有搜索接口"。 */}
          <button
            type="button"
            className="av-xhs-btn"
            data-xhs-adopt="1"
            disabled={!q || busy || !xhsUid}
            onClick={() => void adoptXhs()}
            title={
              xhsUid
                ? `收录小红书 uid ${xhsUid}`
                : '按 uid 收录小红书：把主页链接或 uid 粘进输入框（也可以直接用「搜索」找）'
            }
          >
            {adoptingKey?.startsWith('xhs:') ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <UserPlus className="size-3.5" />
            )}
            小红书 uid
          </button>
          {/* 抖音同理：没有可用的搜索接口，只有"按 sec_user_id 收录"这一条路，
              而且它**认不出纯抖音号**（那要搜索接口）⇒ 认不出时禁用 */}
          <button
            type="button"
            className="av-xhs-btn"
            data-douyin-adopt="1"
            disabled={!q || busy || !douyinUid}
            onClick={() => void adoptDouyin()}
            title={
              douyinUid
                ? `收录抖音 sec_user_id ${douyinUid}`
                : '抖音只能按 sec_user_id 收录：把主页链接粘进输入框（抖音号解析不了）'
            }
          >
            {adoptingKey?.startsWith('douyin:') ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <UserPlus className="size-3.5" />
            )}
            抖音 uid
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

          {/* 未登录也能搜、能收录；但新 V 的投稿与动态要登录后才抓得到（devlog/086）。
              说清"能做什么 / 登录后多什么"，而不是一句话把它禁掉 */}
          {contentBlocked && (
            <div className="av-hint-row av-limit-row" data-cap-limit-hint="1">
              {limitText(caps, FETCH_POSTS) || '未登录：新 V 的投稿与动态要登录后才会抓取'}
            </div>
          )}

          {q && !searchingLocal && rows.length === 0 && !groups && (
            <div className="av-hint-row">
              本地候选没有匹配。
              <button type="button" className="av-link" onClick={() => void runSearch(1)}>
                在已开启的平台上搜索「{q}」
              </button>
            </div>
          )}

          {rows.map(rowButton)}

          {/* 在线检索的状态：**逐平台**如实说（关着 / 没登录 / 风控 / 命中几条各不同）。
              结论一律由后端 `hint` 说了算；前端不把"没问到"说成"没有这个人"。 */}
          {groups && allGroupsEmpty(groups) && (
            <div className="av-hint-row" data-search-empty="1">没找到「{q}」</div>
          )}
          {groups?.map((g) => {
            const note = groupNote(g)
            if (!note) return null
            return (
              <div key={g.platform}
                   className={`av-hint-row${note.tone === 'err' ? ' err' : ''}`}
                   data-search-note={g.platform}>
                {note.text}
              </div>
            )
          })}
          {groups && !allGroupsEmpty(groups) && (
            <div className="av-hint-row">
              <button
                type="button"
                className="av-link"
                disabled={onlineLoading}
                onClick={() => void runSearch(searchPage + 1)}
                title="同一批平台上再翻一页（各平台按自己的分页走）"
              >
                加载更多（第 {searchPage + 1} 页）
              </button>
            </div>
          )}
        </OverlayScroll>
      </DialogContent>
    </Dialog>
  )
}
