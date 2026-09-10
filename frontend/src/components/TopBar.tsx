import { useEffect, useRef, useState } from 'react'
import { Copy, Loader2, LogIn, Minus, Square, X } from 'lucide-react'
import Logo from './common/Logo'
import LoginDialog from './LoginDialog'
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
import { setFetchBusy } from '../fetchBusy'
import { isFirstRun } from '../bootState'
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
  const [pillMsg, setPillMsg] = useState<string | null>(null)
  // 登录：浮窗开关 + 两平台登录态（约 60s 轮询一次，供入口徽章提示）
  const [loginOpen, setLoginOpen] = useState(false)
  const [auths, setAuths] = useState<{ bili: AuthStatus | null; weibo: AuthStatus | null }>({
    bili: null,
    weibo: null,
  })
  // 全量抓取完成的常驻报告：需用户手动关闭（AlertDialog 默认不支持点外部/ESC 关闭）
  const [doneReport, setDoneReport] = useState<NonNullable<PostFetchStatus['last_result']> | null>(null)
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
      if (!cancelled) timer = window.setTimeout(poll, ms)
    }

    const poll = async () => {
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
        active = s.account.running || s.post.running || (ext?.running ?? false)
        setFetchBusy(s.account.running, s.post.running)

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
            window.dispatchEvent(new Event('ddtoolkit:fetch-idle'))
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
              // 全量抓取完成 → 常驻对话框，需用户手动关闭（内容含全部中断账号）
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
          const wasRunning = prev
            ? prev.account.running || prev.post.running
            : prevRunning.current
          const accountPostRunning = s.account.running || s.post.running
          if (wasRunning && !accountPostRunning) {
            window.dispatchEvent(new Event('ddtoolkit:fetch-idle'))
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

  // 登录态轮询：约 60s 一次，驱动入口徽章（B 站会话过期 → 红点提示扫码）
  useEffect(() => {
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
  }, [])

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

  const busy = status
    ? status.account.running || status.post.running || (status.external?.running ?? false)
    : false

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
  /** 拼「任务名 - V名 - i/N」；V 名缺失时退回过程性文案（平台名 / 账号名） */
  const statusParts = (
    task: string | null | undefined,
    fallbackTask: string,
    vtuberName: string | null | undefined,
    processText: string | null | undefined,
    index?: number,
    total?: number,
  ): string => {
    const parts = [TASK_TEXT[task ?? ''] ?? fallbackTask]
    const who = vtuberName || processText
    if (who) parts.push(String(who))
    if (total && total > 0) parts.push(`${index ?? 0}/${total}`)
    return parts.join(' - ')
  }

  let statusText = '数据服务运行中'
  let dotClass = 'topbar-status-dot'
  if (status?.post.running) {
    const p = status.post
    statusText = statusParts(p.task, '帖子抓取中', p.vtuber_name, p.target, p.index, p.total)
    dotClass = 'topbar-status-dot busy'
  } else if (status?.account.running) {
    const a = status.account
    statusText = statusParts(a.task, '账号信息抓取中', a.vtuber_name, a.current, a.index, a.total)
    dotClass = 'topbar-status-dot busy'
  } else if (status?.external?.running) {
    // 外部第三方数据（收录回填 / 每日批次）：与抓取任务并行，优先级最低
    statusText = `正在同步${status.external.label ?? '第三方数据'}`
    dotClass = 'topbar-status-dot busy'
  }

  // 显示优先级：覆盖消息（且无任务运行）> 实时状态
  const showOverride = pillMsg !== null && !busy
  const displayText = showOverride ? pillMsg! : statusText
  const displayDot = showOverride ? 'topbar-status-dot ok' : dotClass

  const handleMinimize = () => void tauriWindow().then((w) => w.minimize())

  const closeApp = () => void tauriWindow().then((w) => w.close())
  const handleClose = () => (busy ? setConfirmClose(true) : closeApp())

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

      {/* 状态行：容器只在「有事发生」时出现（busy 或操作结果覆盖态）——
          空闲态是顶栏 chrome 的一部分（白字 + 绿点，无容器），
          事件态亮出深玫瑰徽章把注意力吸过来（见 layout.css .topbar-status.on） */}
      <span
        className={'topbar-status' + (busy || showOverride ? ' on' : '')}
        {...(isTauri ? { 'data-tauri-drag-region': true } : {})}
      >
        {displayDot.includes('busy') ? (
          <Loader2 className="topbar-status-spinner" />
        ) : (
          <i className={displayDot} />
        )}
        <span key={displayText} className="pill-text-fade">
          {displayText}
        </span>
      </span>

      <div className="topbar-spacer" {...(isTauri ? { 'data-tauri-drag-region': true } : {})} />

      {/* 登录入口：B 站会话过期时红点徽章提示扫码 */}
      <div className="topbar-login">
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

      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} />

      {/* 全量抓取完成报告：常驻对话框，仅「知道了」可关闭（AlertDialog 不响应外部点击/ESC） */}
      <AlertDialog
        open={doneReport !== null}
        onOpenChange={(o) => {
          if (!o) setDoneReport(null)
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
            <AlertDialogAction onClick={() => setDoneReport(null)}>知道了</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>抓取任务正在进行中</AlertDialogTitle>
            <AlertDialogDescription>
              关闭窗口会中断后台抓取进程，确定退出吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={closeApp}
            >
              退出
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  )
}
