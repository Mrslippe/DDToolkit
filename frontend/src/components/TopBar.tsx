import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Copy, LogIn, Minus, Square, X } from 'lucide-react'
import Logo from './common/Logo'
import LoginDialog from './LoginDialog'
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
import { useCapabilities, refreshCapabilities } from '../hooks/useCapabilities'
import { hideToTray, quitApp } from '../utils/shellBridge'
import { isShellHidden } from '../utils/shellLifecycle'
import { closeIntent, parseCloseAction, type CloseAction } from '../utils/shellState'
import type { Notice, NoticeActionKind } from '../utils/notificationHub'
import {
  composeTaskText, loginNotice, messageNotice, progressNotice, rateLimitNotice, reportNotice,
} from '../utils/notificationHub'
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
const PILL_MS = 4000 // 操作结果覆盖态的展示时长

const isTauri = '__TAURI_INTERNALS__' in window

/**
 * dev/探针专用：`?density=widget` 让**顶栏里**也渲染桌面控件宿主的材质与尺寸（R38 批 5）。
 *
 * 为什么需要：`widget` 宿主本来只该出现在独立小窗里，而探针要能在**同一个页面**上量它 ——
 * 否则"深底的不透明度够不够 4.5:1（亮/暗壁纸都要过）"就只能靠肉眼估。
 * 与 `__ddtoolkitCloseClick` 同一种"为可测性存在"的取舍，同样只在 `DEV` 下生效。
 */
const islandDensity: 'bar' | 'widget' =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get('density') === 'widget'
    ? 'widget'
    : 'bar'

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
 * 顶栏（视觉严格按 docs/design/react-topbar Pixso 设计稿 Frame411）：
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
  const [pillMsg, setPillMsg] = useState<string | null>(null)
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
  // 轮询并发保护：kick-poll 在请求 in-flight 期间再次触发时只打标记，
  // 请求结束后立即补一轮——否则会并行跑两条轮询链，频率翻倍且不收敛
  const inFlight = useRef(false)
  const pendingKick = useRef(false)
  // 任务完成汇总（方案 1+2）：首次轮询只记基线；仅「轮询曾目睹运行」的任务完成才弹报告
  const seenAccSeq = useRef(-1)
  const seenPostSeq = useRef(-1)
  const prevAccRunning = useRef(false)
  const prevPostRunning = useRef(false)
  const sawAccRun = useRef(false)
  const sawPostRun = useRef(false)
  // 外部第三方数据任务（收录回填 / 每日批次）：seq 变化即「刚完成一轮」，
  // 用来发 fetch-idle —— 只看 running 边沿会漏掉「两次轮询之间就跑完」的短任务，
  // 停在档案视图的用户就永远看不到粉丝趋势/直播日历（2026-09-09 用户反馈）
  const seenExtSeq = useRef(-1)

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
        // 按钮禁用与手动端点的 409 同源；旧后端无该字段 → 退回旧判据
        setFetchBusy(s.manual_running ?? (s.account.running || s.post.running))

        // 账号快照变化 → 派发事件，侧栏/右栏就地刷新（内容 diff：见 seenByUid 注释）
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
          window.dispatchEvent(
            new CustomEvent('ddtoolkit:account-progress', {
              detail: [...freshByUid.values()],
            }),
          )
        }

        // 外部数据任务完成（seq 自增）→ 提示 + 让档案卡片重拉数据。
        // 与下面的 running→idle 边沿分开：边沿可能整个错过（任务在两次轮询之间结束），
        // seq 是后端记账，不会漏。
        if (ext) {
          if (seenExtSeq.current < 0) {
            seenExtSeq.current = ext.seq          // 首次轮询仅记基线
          } else if (ext.seq !== seenExtSeq.current) {
            seenExtSeq.current = ext.seq
            window.dispatchEvent(
              new CustomEvent('ddtoolkit:pill-message', {
                detail: { text: `${ext.last_label ?? '第三方数据'}同步完成` },
              }),
            )
            dispatchFetchIdle(['external'])
          }
        }
        // 新任务启动时立即让位给实时状态显示
        if (active) setPillMsg(null)

        // 观察到「空闲→运行」：记为曾目睹运行。只有轮询目睹过的任务完成时才弹
        // 完成报告——手动快速任务（同步按钮已在页面内反馈）大概率在目睹前结束，
        // 不会被重复播报；长任务/后台任务则必然被目睹并获得完成汇总（方案 1+2）。
        if (s.account.running && !prevAccRunning.current) sawAccRun.current = true
        if (s.post.running && !prevPostRunning.current) sawPostRun.current = true
        prevAccRunning.current = s.account.running
        prevPostRunning.current = s.post.running

        const accRes = s.account.last_result
        if (accRes && accRes.seq !== seenAccSeq.current) {
          if (seenAccSeq.current < 0) {
            seenAccSeq.current = accRes.seq // 首次轮询仅记基线，不弹报告
          } else if (sawAccRun.current && !s.account.running) {
            seenAccSeq.current = accRes.seq
            sawAccRun.current = false
            window.dispatchEvent(
              new CustomEvent('ddtoolkit:pill-message', {
                detail: {
                  text: `账号信息抓取完成 · 成功 ${accRes.success ?? 0} · 失败 ${accRes.failed ?? 0}`,
                },
              }),
            )
          }
        }
        const postRes = s.post.last_result
        if (postRes && postRes.seq !== seenPostSeq.current) {
          if (seenPostSeq.current < 0) {
            seenPostSeq.current = postRes.seq
          } else if (sawPostRun.current && !s.post.running) {
            seenPostSeq.current = postRes.seq
            sawPostRun.current = false
            if (postRes.kind === 'full_all' || postRes.kind === 'full_vtuber') {
              // 全量抓取完成（R12a）：进通知中心当**常驻条目**（不再自动弹窗），
              // 用户点条目上的「查看详情」才开原来的对话框。
              setDoneReport(postRes)
            } else if (postRes.kind === 'adopt') {
              // 收录首屏抓取（v0.9.4）：新 V 的投稿/动态第一屏，给一条简短反馈
              let text = `新 V 首屏抓取完成 · 投稿 ${postRes.videos ?? 0} · 动态 ${postRes.dynamics ?? 0} · 入库 ${postRes.stored ?? 0}`
              if (postRes.issues?.length) {
                text += ` · ${postRes.issues[0].stop_reason}`
              }
              window.dispatchEvent(
                new CustomEvent('ddtoolkit:pill-message', { detail: { text } }),
              )
            } else {
              // 其余后台任务（如批量更新动态）仍走瞬时胶囊
              let text = `帖子抓取完成 · 存储 ${postRes.stored ?? 0} · 跳过 ${postRes.skipped ?? 0}`
              if (postRes.video_missing) {
                text += ` · 视频可能缺 ${postRes.video_missing}`
              } else if (postRes.issues?.length) {
                text += ` · ${postRes.issues.length} 处中断(${postRes.issues[0].stop_reason})`
              }
              window.dispatchEvent(
                new CustomEvent('ddtoolkit:pill-message', { detail: { text } }),
              )
            }
          }
        }

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
            if (kinds.length) dispatchFetchIdle(kinds)
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

  // 操作按钮点击/完成时「踢一脚」：状态即时反映任务启动与结束，
  // 不必等下一轮轮询
  const pollRef = useRef<() => void>(() => {})
  useEffect(() => {
    const kick = () => pollRef.current?.()
    window.addEventListener('ddtoolkit:kick-poll', kick)
    return () => window.removeEventListener('ddtoolkit:kick-poll', kick)
  }, [])

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

  // 成功类操作提示覆盖态：优先于常规状态文案，PILL_MS 后自动还原；
  // 新任务启动时由轮询立即清除让位
  const pillTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    const onPill = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text
      if (!text) return
      setPillMsg(text)
      if (pillTimer.current !== undefined) clearTimeout(pillTimer.current)
      pillTimer.current = window.setTimeout(() => setPillMsg(null), PILL_MS)
    }
    window.addEventListener('ddtoolkit:pill-message', onPill)
    return () => window.removeEventListener('ddtoolkit:pill-message', onPill)
  }, [])

  // 「有事发生」= 可见任务（手动/收录/外部批次）或操作结果覆盖态。
  // 自动节拍（动态轮询、自动账号流）按 2026-09-10 用户口径静默：不亮容器、不顶部文案，
  // 也不拦关窗——它们没有终局，一直在跑；数据照旧通过事件流向各视图。
  const postVisible = !!status?.post.running && !isQuietTask(status?.post)
  const accVisible = !!status?.account.running && !isQuietTask(status?.account)
  const busy = accVisible || postVisible || (status?.external?.running ?? false)

  // P8-C（2026-09-10 用户）：状态胶囊格式 = 任务名 - V名 - i/N
  // （例：动态更新中 - 明前奶绿 - 1/11）
  const TASK_TEXT: Record<string, string> = {
    account: '账号信息抓取中',
    dynamic: '动态轮询中',
    update: '动态更新中',
    full: '全量抓取中',
    quick: '帖子抓取中',
    adopt: '首屏抓取中',
  }
  /** 拼「任务名 - V名 - i/N」的纯函数已搬到 `utils/notificationHub.composeTaskText`（有单测） */

  let statusText = '数据服务运行中'
  if (postVisible) {
    const p = status!.post
    statusText = composeTaskText(TASK_TEXT[p.task ?? ''] ?? '帖子抓取中', p.vtuber_name || p.target,
                                 p.index, p.total)
  } else if (accVisible) {
    const a = status!.account
    statusText = composeTaskText(TASK_TEXT[a.task ?? ''] ?? '账号信息抓取中',
                                 a.vtuber_name || a.current, a.index, a.total)
  } else if (status?.external?.running) {
    // 外部第三方数据（收录回填 / 每日批次）：与抓取任务并行，优先级最低
    statusText = `正在同步${status.external.label ?? '第三方数据'}`
  }
  // 注：自动节拍（动态轮询 / 自动账号流）走到这里就是空态——顶栏保持「数据服务运行中」
  // 白字 + 绿点、无容器（用户 2026-09-10：频繁轮询不必占顶栏）

  // ── 通知中心（R12a，devlog/089）────────────────────────────────────
  // 六类信息源汇总成条目；优先级/过期/去重全在 `utils/notificationHub` 里（有单测）。
  const notices = useMemo(() => {
    const list: Notice[] = []
    // ① 任务进度（**自动节拍不产生条目** —— progressNotice 内部判定）
    const p = progressNotice({ id: 'progress-post', running: !!status?.post.running,
                               auto: isQuietTask(status?.post), text: statusText })
    if (p && postVisible) list.push(p)
    const a = progressNotice({ id: 'progress-account', running: !!status?.account.running,
                               auto: isQuietTask(status?.account), text: statusText })
    if (a && accVisible) list.push(a)
    if (status?.external?.running) {
      list.push({ id: 'progress-external', kind: 'progress', source: '第三方同步',
                  text: `正在同步${status.external.label ?? '第三方数据'}` })
    }
    // ② 风控冷却（此前只在日志里）
    const rl = rateLimitNotice(status?.rate_limit, now)
    if (rl) list.push(rl)
    // ③ 登录失效
    const lg = loginNotice(!!auths.bili?.needs_login)
    if (lg) list.push(lg)
    // ④ 完成报告（全部中断账号进 detail；点「查看详情」开原来的弹窗）
    if (doneReport) {
      const issues = doneReport.issues ?? []
      list.push(reportNotice({
        id: `report-${doneReport.seq}`,
        text: `全量帖子抓取完成 · 存储 ${doneReport.stored ?? 0} · 跳过 ${doneReport.skipped ?? 0}`,
        detail: doneReport.video_missing
          ? `视频可能缺 ${doneReport.video_missing} 条`
          : issues.length ? `${issues.length} 处中断（${issues[0].stop_reason}）` : undefined,
      }))
    }
    // ⑤ 瞬时消息（操作结果，ttl 到期自动消失）
    if (pillMsg) list.push(messageNotice(pillMsg, now, PILL_MS))
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, auths, doneReport, pillMsg, now, statusText])

  // ⑥ R29：把风控冷却同步到**托盘**（收进托盘后没人看界面，状态岛也就看不见了）。
  // 可见时吃上面这条 2s 轮询；隐藏时 hook 内自带 60s 心跳（详见 useTrayStatus 注释）。
  useTrayStatus(status?.rate_limit)

  /** 面板动作 → 具体行为（渲染层不碰业务） */
  const onIslandAction = (kind: NoticeActionKind) => {
    if (kind === 'open-report') setReportOpen(true)
    else if (kind === 'login') setLoginOpen(true)
    // 'open-limits' 暂未接线：能力受限仍由顶栏那个**独立入口**承担
    // （工具 vs 通知的分工，见 devlog/089）；类型里保留它是给后续批次用
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
      <StatusIsland notices={notices} onAction={onIslandAction} now={now} density={islandDensity} />

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
              : '账号登录（B 站 / 微博）'
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
