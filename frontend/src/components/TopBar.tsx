import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Copy, LogIn, Minus, Square, X } from 'lucide-react'
import Logo from './common/Logo'
import LoginDialog from './LoginDialog'
import { LOGIN_TABS } from '../utils/platformLogin'
import CapabilityLimits from './CapabilityLimits'
import StatusIsland from './StatusIsland'
import CloseActionDialog from './CloseActionDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useIsMaximized } from '../hooks/useIsMaximized'
import { useShellHidden } from '../hooks/useShellHidden'
import { useTrayStatus } from '../hooks/useTrayStatus'
import { useLowSpaceNotice } from '../hooks/useLowSpaceNotice'
import { useUpdateCheck } from '../hooks/useUpdateCheck'
import { setFetchBusy } from '../fetchBusy'
import { isFirstRun } from '../bootState'
import { dispatchFetchIdle, type FetchIdleKind } from '../utils/fetchIdle'
import { withoutAlreadyPushedPosts } from '../utils/messageBus'
import { EVENTS, emit } from '../utils/appEvents'
import { useCapabilities, refreshCapabilities } from '../hooks/useCapabilities'
import { hideToTray, quitApp } from '../utils/shellBridge'
import { isShellHidden } from '../utils/shellLifecycle'
import { closeIntent, parseCloseAction, type CloseAction } from '../utils/shellState'
import type { Notice, NoticeActionKind } from '../utils/notificationHub'
import { todoIds } from '../utils/noticeBoard'
import { useNotices } from '../utils/noticeStream'
import { api } from '../api/api'
import type { AccountSnapshot, AuthStatus, FetchStatus, PostFetchStatus } from '../api/types'
import './../styles/layout.css'

/** 中断原因 → 可读文案（已完成对话框用） */
const REASON_TEXT: Record<string, string> = {
  rate_limited: '风控截断',
  network_error: '网络失败',
  error: '异常',
  archived_boundary: '归档边界（预期）',
  page_limit: '页数上限（预期）',
  stopped_early: '增量命中（预期）',
}

const POLL_ACTIVE_MS = 3000 // 有任务运行时的高频轮询
const POLL_IDLE_MS = 10000 // 空闲时的低频轮询
const POLL_RETRY_MS = 500 // 在途冲突时的重排间隔（轮询链自愈，见 poll 内注释）
// `PILL_MS` / `PUSHED_PROGRESS_MS` 两条 TTL 已搬到 `utils/noticeStream.ts`（M4，devlog/252）。
// 下面从那里 import。

const isTauri = '__TAURI_INTERNALS__' in window

/**
 * 「静默任务」判定：定时档发起的**自动节拍**不占顶栏。
 *
 * 判据用后端给的事实（`auto`：本次是否由综合档发起），而不是任务名——同一个
 * `update`/`full` 文案既能被手动触发也能被定时档调用，只有后端知道这次是谁发起的。
 * 旧后端不返回 `auto` → 视为手动（照旧展示），不会因为字段缺失静默掉真任务。
 */
function isQuietTask(ch: { running: boolean; auto?: boolean } | undefined | null): boolean {
  return !!ch?.running && ch.auto === true
}

async function tauriWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

/**
 * 顶栏（视觉源自 Pixso 导出 Frame411；导出稿已删，内容见 `docs/frontend/UI-MAP.md` A1）：
 * 猫脸 LOGO + 标题（阿里妈妈方圆体，2026-09-09 起与正文同源）+ 居中状态胶囊 + 通栏窗口控制钮。
 * - 状态来自 GET /vtuber/fetch-status 轮询；抓取中显示加载图标（lucide Loader2）；
 *   任务结束沿触发 'ddtoolkit:fetch-idle' 事件，供 VtuberSidebar 等组件刷新数据。
 * - 账号快照增量派发 'ddtoolkit:account-progress'，侧栏就地合并零请求刷新。
 * - 桌面端：头部为拖拽区，最小化/关闭接原生窗口；有任务运行时关闭需二次确认。
 */
export default function TopBar() {
  const [status, setStatus] = useState<FetchStatus | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  /** 首次点 ✕ 的询问框（R18：`prefs.close_action === 'ask'` 时才可能打开） */
  const [askClose, setAskClose] = useState(false)
  /** 隐藏到托盘（R18）：隐藏期间停掉两条轮询链，恢复时立刻补一轮 */
  const hidden = useShellHidden()
  // 磁盘快满时提醒一次（R22-B）：等第一轮 fetch-status 回来再查 ——
  // 既保证后端就绪，也保证下面那个 `pill-message` 监听已经挂上（不然消息会丢）。
  useLowSpaceNotice(status !== null)
  // 启动后静默查一次更新（R23b）：同样等后端就绪，发现新版本时发一条状态岛消息
  useUpdateCheck(status !== null)
  const location = useLocation()
  // 登录：浮窗开关 + 两平台登录态（约 60s 轮询一次，供入口徽章提示）
  const [loginOpen, setLoginOpen] = useState(false)
  /** 能力矩阵（未登录时哪些受限）——顶栏入口 + 各浮窗提示共用（devlog/086） */
  const { caps } = useCapabilities()
  const [auths, setAuths] = useState<{ bili: AuthStatus | null; weibo: AuthStatus | null }>({
    bili: null,
    weibo: null,
  })
  // 全量抓取完成的常驻报告：需用户手动关闭（AlertDialog 默认不支持点外部/ESC 关闭）
  const [doneReport, setDoneReport] = useState<NonNullable<PostFetchStatus['last_result']> | null>(null)
  /** 完成报告对话框的开关（R12a：默认**关**，由状态岛条目的「查看详情」打开） */
  const [reportOpen, setReportOpen] = useState(false)
  /** 每次渲染现取的"当前时间"：通知条目的过期判定（瞬时消息/风控冷却）靠它 */
  const now = Date.now()
  const prevRunning = useRef(false)
  // 账号快照已派发基线：platform_uid → 快照摘要（内容 diff 用）。
  // 2026-09-07 修复：原「recent.length 增量」判定在两种场景丢失事件——
  // ① T0 直播轮询每 60s 推进 6+ 条、recent 环形上限 100，约 15 分钟后长度不再
  //    增长，直播 1→0 的推送永远不再派发；
  // ② T1 任务启动清空 recent 后在两次轮询间完成 → 长度回落触发基线重置，
  //    整批快照被静默丢弃（右栏靠场景预取直读 DB 而新鲜，左栏停留旧值）。
  // 改为内容 diff：只要某账号的快照内容变化（含 live_status 1→0）即派发，
  // 对长度变化/环形上限/清空全部免疫，一个轮询周期内必然收敛。
  const seenByUid = useRef<Record<string, string>>({})
  // 轮询并发保护：在途冲突时的重排标记（见 poll 内的并发保护）
  const inFlight = useRef(false)
  const pendingKick = useRef(false)
  // 外部第三方数据任务（收录回填 / 每日批次）：seq 变化即「刚完成一轮」，
  // 用来发 fetch-idle —— 只看 running 边沿会漏掉「两次轮询之间就跑完」的短任务，
  // 停在档案视图的用户就永远看不到粉丝趋势/直播日历（2026-09-09 用户反馈）
  const seenExtSeq = useRef(-1)
  // **通知的唯一真源是后端**（M5-2b，devlog/259）：这里只存最新一份服务端列表。
  // 原先那套"本地汇总"（六类构造器 + 四个 witnessed ref）整段删掉了 —— 报告何时该弹
  // 已由后端的订阅者注册表决定（`services/notices.py` 的「目睹才报」）。
  const [serverNotices, setServerNotices] = useState<Notice[] | null>(null)
  /** 服务端那份 `manual_running`（与 fetch-status 同源）—— 只在 fetch-status 没给时兜底。
   *  ⚠️ 用 ref 而不是 state：轮询链是 `[]` 依赖的 effect，读 state 会**被闭包钉死在首帧**
   *  （同 `isShellHidden` 那条教训，devlog/095）。 */
  const noticesBusy = useRef(false)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    // 单链调度：任何时刻只保留一个在途定时器（先清旧的再排新的）。
    // 否则「重试定时器」与「收尾定时器」并存时会各自续链，出现两条交替排程。
    const schedule = (ms: number) => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      // R18：隐藏到托盘期间**不续链** —— 用户要的是"后台抓取照常，但界面不渲染"，
      // 而这条链正是界面里最吵的东西（空闲 10s / 忙 3s 一次）。
      //
      // ⚠️ 判据必须读**同步源** `isShellHidden()`，不能读 React 状态/它同步过来的 ref：
      // 状态要等下一次渲染才落地，而这条链的定时器可能恰好在那之前触发 ——
      // 于是"隐藏后还会多跑一轮"（探针 `--tray-suspend` 实测抓到 1 次，devlog/095）。
      if (!cancelled && !isShellHidden()) timer = window.setTimeout(poll, ms)
    }

    const poll = async () => {
      // R18：**触发时也要看一次**。只在 `schedule` 里判是不够的 ——
      // 定时器可能是在"还可见"的时候排下的（比如隐藏前 2 秒刚排好 10s 后那一轮），
      // 隐藏之后它照样到点触发。探针 `--tray-suspend` 的记录最能说明问题：
      // 轮询时刻 [1499, 2033, 2043, 12053, **22063**]，而隐藏发生在 14349 ——
      // 22063 那一发就是"排程时合法、触发时已经隐藏"的漏网之鱼。
      if (isShellHidden()) return
      if (inFlight.current) {
        // 并发保护：不并行开第二条链，但必须把定时器续上。
        // ★ 2026-09-08 修复（左栏直播徽标永不刷新）：StrictMode 双挂载下，
        //   先挂载那份闭包的 cancelled 已被置真，它的 finally 不会排下一轮；
        //   此处若直接 return，整条轮询链就彻底断掉——实测 dev 下
        //   /vtuber/fetch-status 全程只请求 1 次，于是 account-progress /
        //   fetch-idle 再也不派发：右栏点开 V 直读 DB 显示「直播中」，
        //   左栏停留在旧值（顶栏也永远显示「数据服务运行中」）。
        //   排一个短重试即可自愈：重试触发时在途请求已结束，正常续链。
        pendingKick.current = true
        schedule(POLL_RETRY_MS)
        return
      }
      inFlight.current = true
      let active = false
      try {
        // 通知汇总（M5-2b）：与状态**同一条轮询链**（一个节奏、一处并发保护）。
        // 它带回服务端算好的条目 + `manual_running`；失败不影响下面那条链（各自 catch）。
        void api.getNotices().then((nb) => {
          if (cancelled) return
          setServerNotices(nb.notices)
          noticesBusy.current = nb.manual_running
        }).catch(() => { /* 后端不可达：保持上一份 */ })
        const s = await api.getFetchStatus()
        if (cancelled) return
        const ext = s.external
        // 「静默任务」判定（2026-09-10 用户：频繁的动态轮询不必占顶栏）：
        // 定时档发起的自动节拍（动态流一轮接一轮、账号流按到期扫）没有终局、会一直重复，
        // 一律不占顶栏文案/容器，也不参与「有任务在跑」的关窗确认与忙按钮；
        // 但下方的 running→idle 边沿**照旧**派发 fetch-idle，卡片/侧栏仍会跟着刷新。
        const postVisible = s.post.running && !isQuietTask(s.post)
        const accVisible = s.account.running && !isQuietTask(s.account)
        active = accVisible || postVisible || (ext?.running ?? false)
        // 按钮禁用与手动端点的 409 同源（自动档**不算忙**）。两个来源同源：
        // fetch-status 优先，旧后端没这个字段时用 notices 端点那份（M5-2b）。
        setFetchBusy(s.manual_running ?? noticesBusy.current)

        // 账号快照变化 → 派发事件，侧栏/右栏就地刷新（内容 diff：见 seenUid 注释）
        const recent = s.account.recent ?? []
        const freshByUid = new Map<string, AccountSnapshot>()
        for (const snap of recent) {
          const uid = String(snap.platform_uid)
          const digest = JSON.stringify(snap)
          if (seenByUid.current[uid] !== digest) {
            seenByUid.current[uid] = digest
            freshByUid.set(uid, snap) // 同账号多条时保留最新一条（后端顺序即时间序）
          }
        }
        if (freshByUid.size > 0) {
          emit(EVENTS.accountProgress, [...freshByUid.values()])
        }

        // 外部数据任务完成（seq 自增）→ 提示 + 让档案卡片重拉数据。
        // 与下面的 running→idle 边沿分开：边沿可能整个错过（任务在两次轮询之间结束），
        // seq 是后端记账，不会漏。
        if (ext) {
          if (seenExtSeq.current < 0) {
            seenExtSeq.current = ext.seq          // 首次轮询仅记基线
          } else if (ext.seq !== seenExtSeq.current) {
            seenExtSeq.current = ext.seq
            emit(EVENTS.pillMessage, { text: `${ext.last_label ?? '第三方数据'}同步完成` })
            dispatchFetchIdle(['external'])
          }
        }
        // 完成报告与"目睹才报"**不在这里判了**（M5-2b）：报告条目由后端出
        // （`services/notices.py::_report_notices`，只对 full_all / full_vtuber），
        // 「查看详情」要的明细仍从下面这份 status 里按 seq 取（见 onIslandAction）。
        //
        // ⚠️ 原先这段还负责两类**瞬时胶囊**（账号轮完成 / 帖子轮完成），它们现在都有
        // 后端对应物，删掉不会丢反馈：
        //   · 手动动作（抓取账号 / 抓取帖子 / 更新动态）由端点自己 `_note_manual_done`
        //     → 环形缓冲 + 推送；
        //   · 收录首屏（adopt）由 `_adopt_background` 报（M5-2b 补的，见 devlog/259）；
        //   · 自动节拍的完成**本来就不该占顶栏**（2026-09-10 用户口径：频繁轮询不必占位）
        //     —— 旧代码里账号轮每跑完一次都弹一条，正是那条口径要消掉的噪声。

        setStatus((prev) => {
          // 抓取任务的「运行→空闲」边沿：**不含**外部数据任务——它跑在后台且
          // 不占两把锁，若把它算进来，账号/帖子抓取结束时的刷新会被拖到回填结束
          // （新 V 的首屏内容要等 20s 才出现在右栏）。外部完成另有 seq 通道。
          //
          // R2 第二步（devlog/080）：边沿要**带上是谁跑完了** —— 动态流每 60~80s 一轮，
          // 之前它也会让"粉丝趋势"整块重取 + 重建 ECharts（纯属白干：动态流不写快照）。
          const kinds: FetchIdleKind[] = []
          if (prev?.account.running && !s.account.running) kinds.push('account')
          if (prev?.post.running && !s.post.running) kinds.push('posts')
          if (prev) {
            // M3（devlog/247）：这一轮如果**推送已经通知过**（同一个 seq），别再刷一次 ——
            // "推送与轮询并存不重复"就是这么保证的（按轮次 seq 判，不看时间窗）。
            const todo = withoutAlreadyPushedPosts(kinds, s.post.last_result?.seq)
            if (todo.length) dispatchFetchIdle(todo)
          } else if (prevRunning.current && !(s.account.running || s.post.running)) {
            // 首轮轮询没有 prev（拿不到分路信息）：按"全都算"发，宁可多刷一次也不漏
            dispatchFetchIdle(['account', 'posts'])
          }
          prevRunning.current = active
          return s
        })
      } catch {
        /* 后端不可达时保持上次状态，按空闲节奏重试 */
      } finally {
        inFlight.current = false
        if (!cancelled) {
          if (pendingKick.current) {
            pendingKick.current = false
            schedule(0)
          } else {
            schedule(active ? POLL_ACTIVE_MS : POLL_IDLE_MS)
          }
        }
      }
    }

    pollRef.current = poll
    poll()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  // ⚠️ `kickPoll`（"点一下按钮就踢一脚轮询"）**已退役**（M5-2b，devlog/259）。它当年的
  // 存在理由是"点完按钮要等 3–10s 轮询才看到抓取中"，而那件事今天由四条各管一段：
  // 显示进度 = 推送（`notice.progress`，M2）；按钮禁用 = `manual_running`（fetch-status
  // 与 notices 两个来源）；完成后收尾 = 通知汇总（服务端列表）；"进 running 被目睹 ⇒
  // 完成时发 fetch-idle" = M3 的 `domain.posts.changed`。
  const pollRef = useRef<() => void>(() => {})

  // R18：恢复可见 → **立刻补一轮**（只恢复定时器的话，用户点开托盘看到的可能是
  // 10s 前的旧状态）。隐藏方向的停表不靠这里 —— 那必须同步生效，见 `schedule`。
  useEffect(() => {
    if (!hidden) pollRef.current?.()
  }, [hidden])

  // R18/R20：托盘菜单「退出」的**确认分支** —— Rust 只在"真有手动任务在跑"时才发这个事件
  // （没在跑它就直接退了，不依赖前端）。收到就弹既有的忙碌确认框：
  // 退出 = 真退出，最小化到托盘 = 让这一轮抓取跑完。
  useEffect(() => {
    let off: (() => void) | undefined
    let disposed = false
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const un = await listen('shell:quit-requested', () => setConfirmClose(true))
        if (disposed) un()
        else off = un
      } catch {
        /* 浏览器/探针环境没有 Tauri 事件：忽略 */
      }
    })()
    return () => {
      disposed = true
      try { off?.() } catch { /* 忽略 */ }
    }
  }, [])

  // 登录态轮询：约 60s 一次，驱动入口徽章（B 站会话过期 → 红点提示扫码）。
  // R18：隐藏到托盘时整条停掉（隐藏 8 小时 = 960 次白请求）
  useEffect(() => {
    if (hidden) return
    let cancelled = false
    const load = async () => {
      try {
        const [b, w] = await Promise.all([
          api.authStatus('bilibili'),
          api.authStatus('weibo'),
        ])
        if (!cancelled) setAuths({ bili: b, weibo: w })
      } catch {
        /* 后端不可达时保持上次状态 */
      }
    }
    void load()
    const timer = window.setInterval(load, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [hidden])

  // 首次启动（后端 /healthz 的 first_run）自动弹出登录浮窗：
  // 等 B 站登录态探测回来再决定——已登录（老数据目录/已配置 .env）就不打扰。
  const firstRunHandled = useRef(false)
  useEffect(() => {
    if (firstRunHandled.current || !isFirstRun() || !auths.bili) return
    firstRunHandled.current = true
    if (auths.bili.needs_login) setLoginOpen(true)
  }, [auths])

  // 三类**本地覆盖**（瞬时消息 / 开播告警 / 推送来的"任务已受理"）已搬到
  // `utils/noticeStream.ts::useNotices`（M5-2b，devlog/259）：订阅与 TTL 只此一份，
  // 「服务端一报到就让位」的规则也收在 `mergeNotices` 里（同一条判据，不再两处各写一遍）。

  // 「有事发生」= 可见任务（手动/收录/外部批次）或操作结果覆盖态。
  // 自动节拍（动态轮询、自动账号流）按 2026-09-10 用户口径静默：不亮容器、不顶部文案，
  // 也不拦关窗——它们没有终局，一直在跑；数据照旧通过事件流向各视图。
  const postVisible = !!status?.post.running && !isQuietTask(status?.post)
  const accVisible = !!status?.account.running && !isQuietTask(status?.account)
  const busy = accVisible || postVisible || (status?.external?.running ?? false)

  // ⚠️ 顶栏那句「任务名 - V名 - i/N」**不再由前端拼**（M5-2b）：它现在是服务端
  // `progress` 条目（`services/notices.py::compose_task_text`，与状态岛同一个函数口径），
  // 前端 `composeTaskText` 只留给状态岛/其它组件用。`postVisible` / `accVisible` 仍要算 ——
  // 关窗确认与忙按钮读它们。

  // ── 通知中心（R12a devlog/089 → **M5-2b 起由后端供数**，devlog/259）──────
  // 条目模型/优先级/过期仍在 `utils/notificationHub`（纯函数，有单测）；**汇总搬到后端**
  // （`GET /vtuber/notices`），这里只做"服务端列表 + 本地覆盖"的合并（`useNotices`）。
  // 本地覆盖只剩服务端不知道的三类：推送来的进度/瞬时消息、dev 注入的自检条目、
  // 客户端自己的事实（磁盘快满 / 发现新版本 —— 它们走 `pillMessage`）。
  /** dev-only：探针注入的条目（生产构建里恒为空 —— 见下面 `__ddtoolkitSeedReport`） */
  const [devNotices, setDevNotices] = useState<Notice[]>([])
  const notices = useNotices(now, { server: serverNotices, extraLocal: devNotices })

  /**
   * dev-only（L1）：把**当前这一份合并后的通知列表**暴露给探针。
   *
   * 为什么需要：探针只能看 DOM，于是"面板里没有这条"分不清是"推送没到这个 hook"
   * 还是"到了但没画出来" —— 而这两者的修法完全不同（查总线 vs 查渲染）。
   * 生产构建里 `import.meta.env.DEV` 为 false ⇒ 摇掉。
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as unknown as { __ddtoolkitNotices?: () => string[] }
    w.__ddtoolkitNotices = () => notices.map(
      (x) => `${x.form ?? '?'}/${x.kind}:${x.text.slice(0, 20)}`)
    return () => { delete w.__ddtoolkitNotices }
  }, [notices])

  // ⑥ R29：把风控冷却同步到**托盘**（收进托盘后没人看界面，状态岛也就看不见了）。
  // 可见时吃上面这条 2s 轮询；隐藏时 hook 内自带 60s 心跳（详见 useTrayStatus 注释）。
  useTrayStatus(status?.rate_limit)

  // ⑦ R38 批 5b 的「把条目推给小窗」**已退役**（M5-2b，devlog/259）：各处都自己拉
  // `/vtuber/notices`（同一个 `useNotices`、同一份口径），不再需要主窗口替谁取数 ——
  // 那条广播的代价正是"主窗口不在（没开 / 关掉了）时另一边永远是空的"。
  //
  // ⑧ 小窗的启动自动开窗与小窗关闭时回写偏好（R38 批 5b）**随小窗一起退役**（2026-10-01）：
  // 它读的 `WIDGET_POS_KEY`、`show_widget_window`、`widget:closed` 在整窗退役后都不存在了。
  // 但偏好键 `widget_enabled` 仍留在后端（数据层留着以后接线）。

  /**
   * 面板动作 → 具体行为（渲染层不碰业务）。
   *
   * ⚠️ M5-2b（devlog/259）：报告的**明细**不再随报告条目一起来（条目由后端出，它只有文案），
   * 而是点「查看详情」时从**当前** `status.post.last_result` 取（`fetch-status` 那条链照旧在跑，
   * 字段最全：stored/skipped/video_missing/issues）。点「知道了 / 关闭」则把**服务端那条
   * 通知 id** 记成已读（`POST /vtuber/notices/ack`，落库）—— 那正是"刷新 / 深休眠重建之后
   * 报告原地复活"这个老毛病的修法。
   */
  const onIslandAction = (kind: NoticeActionKind, notice?: Notice) => {
    if (kind === 'open-report') {
      const res = status?.post.last_result ?? null
      if (res) setDoneReport(res)
      setReportOpen(true)
      return
    }
    if (kind === 'login') { setLoginOpen(true); return }
    if (kind === 'dismiss') {
      ackNotice(notice)
      return
    }
    if (kind === 'ack-all') {
      // 「一键已读」（L1）：一次清掉「需要处理」整组。
      // ⚠️ **一次请求**而不是循环单条：循环会出现"清到一半失败、面板半干净"的中间态，
      //    而用户看到的是一次点击（`api.ackNotices` 就为这个加的）。
      const ids = todoIds(notices, now)
      if (!ids.length) return
      void api.ackNotices(ids).then((r) => {
        setServerNotices((prev) => (prev ? prev.filter((x) => !r.acked.includes(x.id)) : prev))
      }).catch(() => { /* 后端不可达：下一条轮询会把它带回来，不打断用户 */ })
      return
    }
    // 'open-limits' 暂未接线：能力受限仍由顶栏那个**独立入口**承担
    // （工具 vs 通知的分工，见 devlog/089）；类型里保留它是给后续批次用
  }

  /** 把一条通知记成已读（落库）。失败只记日志 —— 界面已经把它收起来了，别弹错误打断用户。 */
  const ackNotice = (notice?: Notice) => {
    if (!notice?.id) return
    void api.ackNotice(notice.id).then((r) => {
      // 已读集合回来了 ⇒ 本地立刻按它过滤，不必等下一条轮询（点完就消失才跟手）
      setServerNotices((prev) => (prev ? prev.filter((x) => !r.acked.includes(x.id)) : prev))
    }).catch(() => { /* 后端不可达：下一条轮询会把它带回来，不打断用户 */ })
  }

  const handleMinimize = () => void tauriWindow().then((w) => w.minimize())

  /**
   * 点 ✕（R18，devlog/095）：三种语义，由 `prefs.close_action` 决定 ——
   * `tray` 隐藏到托盘 / `quit` 直接退出 / `ask` 首次问一次。
   *
   * ⚠️ 偏好**每次现读**（一个很小的 GET），不在组件里缓存：设置窗口里刚改成
   * "直接退出"，回到顶栏点 ✕ 就该按新的来 —— 缓存会让用户觉得"设置没生效"。
   */
  const handleClose = () => {
    void (async () => {
      let action: CloseAction = 'ask'
      try {
        action = parseCloseAction((await api.getPrefs()).values.close_action)
      } catch {
        /* 后端不可达：退化成"问一次"（不会擅自退出，也不会擅自隐藏） */
      }
      const intent = closeIntent(action)
      if (intent === 'hide') await hideToTray(location.pathname)
      else if (intent === 'ask') setAskClose(true)
      else if (busy) setConfirmClose(true)
      else await quitApp()
    })()
  }

  // dev/探针专用：把"点 ✕"这条路径暴露出来（**同一个 handler**，不是复制一份逻辑）。
  // 为什么需要：窗口控制钮在非 Tauri 环境是 `disabled`（浏览器里没有窗口可关），
  // 而 `ui_probe --close-ask` 要断言"首次询问 → 记住选择 → 隐藏"整条链路 ——
  // 与 `.stat-sets[data-hover]` 同一种"为可测性存在"的取舍。
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as unknown as { __ddtoolkitCloseClick?: () => void }
    w.__ddtoolkitCloseClick = handleClose
    return () => {
      delete w.__ddtoolkitCloseClick
    }
  })

  /**
   * dev/探针专用（2026-09-25，R38 批 5 收尾）：注入/清除一条**带动作按钮**的完成报告。
   *
   * 为什么需要：面板里真正**最小的可点目标**是 `.si-item-action`（「去登录」/「查看详情」，
   * `padding: 3px 9px` + `11.5px` 字 ⇒ 比胶囊矮得多），而它是**条件渲染**的 ——
   * 只有未登录或刚跑完全量抓取才出现。探针两种都造不出来 ⇒ "点击目标"判据会**漏掉
   * 唯一可能不达标的那个对象**，只剩下一个必然通过的胶囊（＝判据空转的另一种形式）。
   * 同一个理由，`.si-count`（计数徽章）也要 `notices.length > 1` 才出现。
   *
   * 走现成的 `doneReport` state（与真实路径**同一个渲染分支**），不是另写一份 DOM ——
   * 与 `__ddtoolkitCloseClick` 同一种取舍。生产构建里 `import.meta.env.DEV` 为 false ⇒ 摇掉。
   *
   * @param r 传报告对象 = 注入；传 `null` = 清除（报告是 `sticky` 的，
   *          探针采完必须清掉，否则"过期自清"那条判据会假红）
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as unknown as {
      __ddtoolkitSeedReport?: (r: PostFetchStatus['last_result'] | null) => void
    }
    // ⚠️ M5-2b：报告条目现在由**后端**出（`GET /vtuber/notices`），所以只塞 `doneReport`
    //    已经画不出那条条目了 —— 注入必须走**本地覆盖**那一层（`extraLocal`），
    //    否则 `.si-count` / `.si-item-action` 那几条判据会**静默空转**（探针照旧绿，
    //    而面板里根本没有对象可量）。id 与后端同格式（`report-<seq>`），
    //    这样「查看详情」/「知道了」走的是同一条接线。
    w.__ddtoolkitSeedReport = (r) => {
      setDoneReport(r as NonNullable<PostFetchStatus['last_result']> | null)
      if (!r) { setDevNotices([]); return }
      const issues = r.issues ?? []
      setDevNotices([{
        id: `report-${r.seq}`, kind: 'report', sticky: true, source: '完成报告',
        text: `全量帖子抓取完成 · 存储 ${r.stored ?? 0} · 跳过 ${r.skipped ?? 0}`,
        detail: r.video_missing ? `视频可能缺 ${r.video_missing} 条`
          : issues.length ? `${issues.length} 处中断（${issues[0].stop_reason}）` : undefined,
        action: { label: '查看详情', kind: 'open-report' },
      }])
    }
    return () => {
      delete w.__ddtoolkitSeedReport
    }
  }, [])

  // 最大化状态跟踪：onResized 触发时重查 isMaximized，切换 还原/最大化 图标
  const isMax = useIsMaximized()

  const handleToggleMaximize = () =>
    void tauriWindow().then((w) => w.toggleMaximize())

  return (
    <header className="topbar" {...(isTauri ? { 'data-tauri-drag-region': true } : {})}>
      {/* Tauri 的拖拽区按**命中元素**判定：只标在 <header> 上时，按到胶囊/标题/
          空白子元素都不会拖窗（2026-09-08 用户反馈）。故所有非交互子元素各自标注，
          按钮（登录/窗口控制）保持不标、继续可点。 */}
      <div className="topbar-logo-zone" {...(isTauri ? { 'data-tauri-drag-region': true } : {})}>
        {/* 用户设计 LOGO（猫脸）——白色描边落在主色底上（docs/design/svg/LOGO.svg） */}
        <Logo className="topbar-logo" />
      </div>
      <h1 className="topbar-title" {...(isTauri ? { 'data-tauri-drag-region': true } : {})}>
        DDtoolkit
      </h1>

      {/* 状态岛（R12a，devlog/089）：原来这里是三套并存的渲染（轮询胶囊 + 瞬时覆写 +
          完成报告 AlertDialog），现在统一交给 `StatusIsland` + `utils/notificationHub`。
          空闲态仍是顶栏 chrome 的一部分（白字 + 绿点、无容器）；「自动节拍不占顶栏」
          这条口径已从"副作用"变成 notificationHub 里的具名规则（带反向用例）。 */}
      <StatusIsland notices={notices} onAction={onIslandAction} now={now} />

      <div className="topbar-spacer" {...(isTauri ? { 'data-tauri-drag-region': true } : {})} />

      {/* 登录入口：B 站会话过期时红点徽章提示扫码 */}
      <div className="topbar-login">
        {/* 未登录/受限时的能力入口（devlog/086；全可用时不渲染） */}
        <CapabilityLimits caps={caps} onLogin={() => setLoginOpen(true)} />
        <button
          className="topbar-login-btn"
          title={
            auths.bili?.needs_login
              ? 'B 站登录已过期，点击扫码登录'
              : `账号登录（${LOGIN_TABS.map((t) => t.label).join(' / ')}）`
          }
          onClick={() => setLoginOpen(true)}
        >
          <LogIn className="size-[16px]" />
          {auths.bili?.needs_login && <i className="topbar-login-badge" />}
        </button>
      </div>

      {/* Web 下仅装饰（禁用）；桌面端接原生窗口控制 */}
      <div className="topbar-window-controls">
        <button
          className="topbar-win-btn"
          disabled={!isTauri}
          title={isTauri ? '最小化' : '最小化（桌面端可用）'}
          onClick={handleMinimize}
        >
          <Minus className="size-[16px]" />
        </button>
        <button
          className="topbar-win-btn"
          disabled={!isTauri}
          title={isMax ? '还原' : '最大化'}
          onClick={handleToggleMaximize}
        >
            {isMax ? <Copy className="size-[13px]" /> : <Square className="size-[13px]" />}
        </button>
        <button
          className="topbar-win-btn close"
          disabled={!isTauri}
          title={isTauri ? '关闭' : '关闭（桌面端可用）'}
          onClick={handleClose}
        >
          <X className="size-[16px]" />
        </button>
      </div>

      {/* 关窗即刷新能力矩阵：刚扫码成功的用户不该还看到"未登录 · 受限"
          （提示必须跟着登录态走，否则用户会以为登录没生效；devlog/086） */}
      <LoginDialog
        open={loginOpen}
        onOpenChange={(o) => {
          setLoginOpen(o)
          if (!o) refreshCapabilities()
        }}
      />

      {/* 全量抓取完成报告（R12a 起：**不再自动弹**，改为状态岛里一条常驻条目 +
          「查看详情」打开这个对话框 —— 用户口径是"把顶栏信息收成一个控件"）。
          对话框本身保持原样：仅「知道了」可关闭（AlertDialog 不响应外部点击/ESC）。 */}
      <AlertDialog
        open={reportOpen && doneReport !== null}
        onOpenChange={(o) => {
          if (!o) {
            setReportOpen(false)
            setDoneReport(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>全量帖子抓取完成</AlertDialogTitle>
            <AlertDialogDescription>
              存储 {doneReport?.stored ?? 0} · 跳过 {doneReport?.skipped ?? 0}
              {doneReport?.video_missing ? ` · 视频可能缺 ${doneReport.video_missing}` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {doneReport && doneReport.issues.length > 0 && (
            <div className="max-h-60 overflow-y-auto rounded-none border border-border p-3 text-left text-xs text-muted-foreground">
              <div className="mb-1.5 font-medium text-foreground">
                中断账号（{doneReport.issues.length}）
              </div>
              {doneReport.issues.map((it, i) => (
                <p key={i} className="py-0.5">
                  {it.label} · {REASON_TEXT[it.stop_reason] ?? it.stop_reason}
                  {it.error ? `：${it.error}` : ''}
                </p>
              ))}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={() => {
                setReportOpen(false)
                setDoneReport(null)
              }}
            >
              知道了
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>抓取任务正在进行中</AlertDialogTitle>
            <AlertDialogDescription>
              退出会中断后台抓取进程。想让它继续跑，就选「最小化到托盘」——
              界面停下，抓取照常。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setConfirmClose(false)
                void hideToTray(location.pathname)
              }}
            >
              最小化到托盘
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => { setConfirmClose(false); void quitApp() }}
            >
              退出
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 首次点 ✕ 的询问（R18，devlog/095）：用户口径「首次问一次、之后按选择记住」 */}
      <CloseActionDialog
        open={askClose}
        onOpenChange={setAskClose}
        busy={busy}
        onChoose={(choice, remember) => {
          setAskClose(false)
          void (async () => {
            if (remember) {
              try {
                await api.savePrefs({ close_action: choice })
              } catch {
                // 存偏好失败不影响这一次的动作，只是下次还会问
              }
            }
            if (choice === 'tray') await hideToTray(location.pathname)
            else if (busy) setConfirmClose(true)   // 退出且正在抓取 → 走上面那个二次确认
            else await quitApp()
          })()
        }}
      />
    </header>
  )
}
