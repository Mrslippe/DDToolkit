import './bootDiag' // 首个 import：诊断陷阱先于一切业务代码注册（CSP 放行同源脚本）
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { FolderOpen, RotateCcw } from 'lucide-react'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import './index.css'
import './styles/tokens.css'
import App from './App'

import Logo from './components/common/Logo'
import { DEV_API_TOKEN, holdApiUntilReady, markNoTokenRequired, markTokenReady, setApiBase, setApiToken } from './api/api'
import { markFirstRun } from './bootState'
import type { BootFailureCopy, HealthzPayload } from './utils/bootFailure'
import { classifyBootFailure } from './utils/bootFailure'
import MigrationFailureBanner from './components/MigrationFailureBanner'
import { openDataDir } from './utils/shellBridge'
import { startMessageBus, stopMessageBus } from './utils/messageBus'
import { installShellLifecycle } from './utils/shellLifecycle'
import { applyCornersMode } from './utils/windowCorners'
import { installExternalLinkGuard } from './utils/externalLinkGuard'
import { setReportEnv } from './utils/problemReport'
import ProblemPanel from './components/ProblemPanel'

const isTauri = '__TAURI_INTERNALS__' in window

// 外链统一走 `open_external`（带主机白名单）：裸 `<a target="_blank">` 在 WebView 里会被壳
// 接管并调 `shell:allow-open` —— 那个权限**已从 capability 删除** ⇒ 链接打不开、还冒一条
// 内部报错（2026-10-02 用户截图，devlog/278）。守卫在 React 之前装，平台 HTML 里的链接也覆盖。
installExternalLinkGuard()
setReportEnv({ route: window.location.pathname, version: null })

// ⚠️ **闸门必须在最早期关上**（S1，devlog/202）：`Root` 在 `state !== 'pending'` 时就挂载
// `<Main/>`，而注入基地址与 token 都在**异步**的 `tauriBootstrap` 里。原先能工作靠的是
// "启动幕那 750ms 里没有业务请求自动发出"这个**时序巧合**；加 token 之后多一次 `invoke`，
// 只会更晚 ⇒ 任何"挂载即发请求"的组件（更新检查 / 状态岛轮询 / 列表取数）都会打在注入之前。
// 关闸之后它们在注入完成前**挂住**，而不是打出一个必然 401 的请求。
holdApiUntilReady()

// 冷启动计时（方案 0 埋点）：与后端 sidecar.log / Rust stdout 的 [perf] 行对照
const _t0 = performance.now()
const perfLog = (step: string) =>
  window.__bootLog?.(`[perf] ${step} +${Math.round(performance.now() - _t0)}ms`)

// 窗口以 visible:false 创建（见 tauri.conf.json）：此刻 index.html 静态粉幕已随
// DOM 解析绘制完成（module script 天然 defer），invoke 显示窗口后首帧即粉色，
// 彻底规避 WebView2 首绘前的白屏（白色闪屏修复，见 devlog/021）。
if (isTauri) {
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('present_window'))
    .catch((err) => window.__bootLog?.('[present_window] ' + String(err)))
}
perfLog('模块求值完成')

/** 桌面端引导：取 sidecar 端口与**会话 token** → 轮询 /healthz 就绪 → 注入 API 地址 */
async function tauriBootstrap(): Promise<{ ok: boolean; health: HealthzPayload | null }> {
  const { invoke } = await import('@tauri-apps/api/core')
  const port = await invoke<number>('get_backend_port')
  // S1（devlog/202）：token 与端口一起取。它由壳**每次启动生成**、只存内存。
  // 取不到就让下面轮询超时 → 走启动幕的 failed 态（那里会说明看哪个日志）——
  // 比“带着空 token 继续跑、每个请求 401”更容易定位。
  const token = await invoke<string>('get_api_token')
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`${base}/healthz`, { cache: 'no-store' })
      if (r.ok) {
        setApiBase(base)
        setApiToken(token)
        // 首启标记与**本次启动的迁移结局**（批次 16，devlog/207）都在这个端点上：
        // 启动幕轮询它的时候前端还没有 token，所以“迁移失败”只能从这里带出来。
        let health: HealthzPayload | null = null
        try {
          health = (await r.json()) as HealthzPayload
          if (health?.first_run) markFirstRun()
        } catch {
          /* 响应非 JSON：忽略，不影响启动 */
        }
        return { ok: true, health }
      }
    } catch {
      /* 后端尚未就绪，继续等待 */
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return { ok: false, health: null }
}
type BootState = 'pending' | 'opening' | 'done' | 'failed'

const ENVELOPE_MS = 750 // 信封展开动画时长（与 layout.css keyframes 对应）

/**
 * 启动幕：主色铺满全窗，中央 LOGO；就绪后「信封上下展开」揭出应用。
 * - pending: 两片闭合，LOGO 呼吸
 * - opening: 上片上滑、下片下滑，LOGO 淡出，露出下方已挂载的 App
 * - failed : 保持闭合，中央换错误卡片 + 重试
 */
function Splash({
  state,
  waited,
  failure,
  onRetry,
}: {
  state: Exclude<BootState, 'done'>
  waited: number
  failure: BootFailureCopy
  onRetry: () => void
}) {
  const opening = state === 'opening'
  return (
    <div className={`splash${opening ? ' splash-open' : ''}`}>
      <div className="splash-panel splash-panel-top" />
      <div className="splash-panel splash-panel-bottom" />
      <div className="splash-center">
        {state === 'failed' ? (
          <>
            <Logo className="splash-logo splash-logo-static" />
            {/* 文案来自 `utils/bootFailure.ts`（**有 vitest**）：只有 schema 迁移失败
                才允许说"数据可以找回"；端口占用/超时**不得**被误报成数据问题。 */}
            <div className="mt-5 text-lg font-semibold text-white">{failure.title}</div>
            <p className="mt-2 max-w-md text-center text-sm whitespace-pre-wrap text-white/80">
              {failure.detail}
            </p>
            <div className="mt-4 flex gap-2">
              <Button variant="secondary" onClick={onRetry}>
                <RotateCcw /> 重试
              </Button>
              <Button variant="secondary"
                onClick={() => { void openDataDir().catch(() => undefined) }}>
                <FolderOpen /> 打开数据目录
              </Button>
            </div>
          </>        ) : (
          <>
            <Logo className={`splash-logo ${state === 'pending' ? 'splash-logo-pulse' : ''}`} />
            {/* 冷启动可能十几秒（首次建库迁移 / 杀软首扫）：给出秒数，
                让「等待」和「卡死」可区分（2026-09-08 首启卡幕反馈） */}
            {state === 'pending' && waited >= 3 && (
              <p className="mt-5 text-sm text-white/70">正在启动内置服务… {waited}s</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Main() {
  return (
    <TooltipProvider delayDuration={200}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </BrowserRouter>
      <Toaster position="top-center" richColors />
      {/* 问题报告（右下角、不遮挡）：出真错误时自己冒出来（devlog/279） */}
      <ProblemPanel />
    </TooltipProvider>
  )
}

function Root() {
  const [state, setState] = useState<BootState>(isTauri ? 'pending' : 'done')
  /** `/healthz` 的载荷：首启标记与**本次启动的迁移结局**都在这里（批次 16） */
  const [bootHealth, setBootHealth] = useState<HealthzPayload | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const failure = classifyBootFailure(bootHealth, bootError)

  // 启动计时：React 挂载
  useEffect(() => {
    perfLog('React 挂载完成')
  }, [])

  // React Splash 已在首帧接管视觉（与 index.html 静态启动幕像素级一致），
  // 移除静态节点；诊断面板折叠为徽章待查（不再整版弹出）
  useEffect(() => {
    document.getElementById('boot-splash')?.remove()
    window.__bootFold?.()
  }, [])

  // 外壳可见性（R18，devlog/095）：接上 Tauri 的 `shell:hidden` / `shell:shown`
  // （浏览器/探针退化为 visibilitychange + dev 钩子）。必须在最外层装一次 ——
  // 顶栏轮询与状态岛轮播都靠它停表。
  useEffect(() => installShellLifecycle(), [])

  // 后端推送通道（M0b，devlog/242）：起一条 SSE（`utils/messageBus.ts`）。
  //
  // ⚠️ 它**不受 R18「隐藏即停表」约束**：那条规则针对的是**轮询**
  // （"没人看就别问"），而推送的设计前提恰恰是"后台也在收"
  // （收进托盘后小窗/顶栏仍要立刻变）。一条常连不产生新请求，也不会让
  // `--tray-suspend` 的"隐藏后 0 次轮询"判据变红。
  useEffect(() => {
    startMessageBus()
    return () => stopMessageBus()
  }, [])

  useEffect(() => {
    if (!isTauri) {
      // 浏览器/探针：没有 Tauri ⇒ 拿不到"每次启动生成"的 token，靠后端的
      // `DDTOOLKIT_DEV_API_TOKEN` 通路（探针给后端与前端注入同一个值，
      // 见 `scripts/ui_probe.py` 与 `vite.config.ts` 的 `VITE_DEV_API_TOKEN`）。
      //
      // ⚠️ **只在"确实没有 token"时才 `markNoTokenRequired()`**（2026-09-25 踩到）：
      //    那个函数会把 `apiToken` 清成空串（它的语义是"这个环境不需要 token"）。
      //    无条件调用 ⇒ **把开发态那份好好的 token 抹掉** ⇒ 后端逐条 401，
      //    而页面表现是"数据全空 ⇒ 布局断言集体报红"。
      //    `DEV_API_TOKEN` 在 `api.ts` 里已经就位，这里只需要**开闸**。
      if (!DEV_API_TOKEN) markNoTokenRequired()
      else markTokenReady()
      return
    }
    perfLog('tauriBootstrap 开始')
    tauriBootstrap()
      .then(({ ok, health }) => {
        perfLog(ok ? 'healthz OK → opening' : 'healthz 超时 → failed')
        // 迁移结局（批次 16，devlog/207）：应用**能用**也要让用户知道发生过什么
        setBootHealth(health)
        // 问题报告要带版本（后端 `/healthz` 是版本的运行时真源）
        setReportEnv({ version: health?.version ?? null })
        setState(ok ? 'opening' : 'failed')
      })
      .catch((err) => {
        // invoke（取 sidecar 端口/令牌）失败也必须落地到 failed——否则幕布永远停在
        // 呼吸态、既无错误也无重试入口（2026-09-08 直装版首启卡幕反馈的兜底）。
        // ⚠️ S1 起 `get_api_token` 也在这条链上：**取不到令牌时绝不能开闸**，
        //    否则每个请求都会打出 401，而用户只看到"数据加载失败"。
        window.__bootLog?.('[bootstrap] ' + String(err))
        setBootError(String(err))
        setState('failed')
      })
  }, [])

  // 首启等待计时：让「正在启动」和「卡死」可区分
  const [waited, setWaited] = useState(0)
  useEffect(() => {
    if (!isTauri || state !== 'pending') return
    const timer = window.setInterval(() => setWaited((s) => s + 1), 1000)
    return () => window.clearInterval(timer)
  }, [state])

  // 揭幕开始：html 首绘底色切回透明，恢复 L3 圆角透出桌面
  // 揭幕完成（done）：再给 `<html>` 挂 `shell-settled` —— 壳层那层近白兜底可以撤了。
  // 为什么必须等这一刻（devlog/135 补）：撤早了会闪桌面 —— 实测揭幕期间
  // 各区域还在跑 `rise-in-page` 渐显（最晚 0.45s 延迟 + 0.32s 时长），那时窗口中心是**透的**；
  // 而撤晚了四角就一直是"区域色压在近白底上"的白边。`done` = 幕收完、壳已完全画出。
  useEffect(() => {
    if (state === 'opening' || state === 'done') {
      document.documentElement.style.background = 'transparent'
    }
    if (state === 'done') {
      document.documentElement.classList.add('shell-settled')
    }
  }, [state])

  // 圆角归谁画（R34，devlog/136）：问壳"这扇窗口的圆角是系统（DWM）画的吗" ——
  // Win11 ⇒ true：CSS 半径归零（`html.dwm-corners`），圆角/吸附方角全交给系统；
  // Win10 探测失败 ⇒ false：保留 CSS 半径兜底（8px），不会变成裸方角。
  // 浏览器/探针里没有 Tauri ⇒ 保持 false（= 走 CSS 那条路，正好也能被探针断言到）。
  // dev 钩子 `__ddtoolkitCorners` 让探针能模拟壳的答复（与 `__ddtoolkitShellHidden` 同路数）。
  useEffect(() => {
    const devHook = window as unknown as { __ddtoolkitCorners?: (v: boolean) => void }
    devHook.__ddtoolkitCorners = applyCornersMode
    if (!isTauri) return
    let disposed = false
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<boolean>('window_corners_mode'))
      .then((ok) => {
        if (!disposed) applyCornersMode(ok)
      })
      .catch(() => { /* 问不到就按 CSS 圆角走，不打扰任何人 */ })
    return () => { disposed = true }
  }, [])

  // 信封展开动画播完后卸载启动幕，同时折叠诊断面板
  useEffect(() => {
    if (state !== 'opening') return
    window.__bootFold?.()
    const timer = window.setTimeout(() => {
      perfLog('揭幕完成（应用壳可见）')
      setState('done')
    }, ENVELOPE_MS)
    return () => clearTimeout(timer)
  }, [state])

  return (
    <>
      {/* opening 阶段即挂载 App 在幕布之下，动画结束时无缝接管 */}
      {state !== 'pending' && state !== 'failed' && <Main />}
      {/* 迁移失败过但**应用能用**（批次 16）：非阻塞横幅，别挡屏 —— 用户要做的是
          "知道数据在哪 + 把诊断发出去"，而不是面对一页错误。 */}
      {state === 'done' && bootHealth?.migration && (
        <MigrationFailureBanner migration={bootHealth.migration} />
      )}
      {state !== 'done' && (
        <Splash state={state} waited={waited} failure={failure}
          onRetry={() => window.location.reload()} />
      )}
    </>
  )
}

/**
 * 这是**唯一**的前端入口（桌面悬浮小窗那条线 2026-10-03 已整体放弃，见 `devlog/274`）。
 *
 * 历史（值得留着）：小窗曾经走 `index.html?widget=1`、在这里用 `if (isWidgetWindow)` 分流 ——
 * 但**静态 import 拦不住**：文件顶部那些 `import App from './App'` / react-router / shadcn /
 * ECharts 会被**无条件**打进小窗那个 renderer（实测 132MB，而 Chromium 基础开销只占小部分）。
 * 后来给它开过独立入口 `widget.html` → `src/widgetMain.tsx`（即 `vite.config.ts` 的多入口），
 * 那个入口前后删过两次：2026-10-01 整窗退役、2026-10-03 连重做的那版一起放弃。
 *
 * ⚠️ **拆入口会把"蹭全局 reset"的地方全部暴露出来** —— 那条教训在今天仍然成立：
 * 只要哪天再拆一个入口，先自查它是否在蹭别处的 `box-sizing` / `.os-*` / dev token。
 */

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)

// 开发态 UI 探针（?probe=1）：布局回归的机器可验证入口，见 src/dev/probe.ts
// 与 scripts/ui_probe.py。生产构建里 import.meta.env.DEV 为 false → 整段被摇掉。
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('probe')) {
  void import('./dev/probe').then((m) => m.runUiProbe())
}

// 开发态强制首启标记（?firstRun=1）：用来在浏览器里验证「首启自动弹登录浮窗」，
// 免得为了看一次弹窗去清数据目录。
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('firstRun')) {
  markFirstRun()
}

// 通知样式调测页（?notice-lab，2026-10-05）：每类消息一个按钮，点一下走**真实路径**产生一条
// 通知（见 `dev/NoticeLab.tsx` 的"路径诚实说明"）。用户口径：「方便我检查所有种类的消息通知样式」。
//
// 三个触发口径，覆盖三种"我怎么打开它"：
//   ① `?notice-lab`（浏览器标签页：有地址栏，直接拼）
//   ② `?probe=notice-lab`（探针模式：调测页与探针**同时在场**，探针负责点与量）
//   ③ `VITE_NOTICE_LAB=1`（**没有地址栏的那个窗口** —— `npm run tauri dev` 起的应用窗口
//      加载的是固定的 `devUrl`，加不了查询串）。用法：仓库根或 `frontend/.env.local` 写一行
//      `VITE_NOTICE_LAB=1`，然后刷新窗口（Vite 改 env 文件会自己重启，刷新即可）。
//      验证完把那行删掉/改 0 —— 它是本地文件，不进仓库（`.gitignore` 已覆盖 `.env*` 之外？
//      见 `frontend/.env.local` 的说明：`*.local` 一律被 git 忽略）。
// 生产构建里 `import.meta.env.DEV` 为 false ⇒ 整段被摇掉。
if (import.meta.env.DEV) {
  const q = new URLSearchParams(window.location.search)
  const wantLab = q.has('notice-lab') || q.get('probe') === 'notice-lab'
    || import.meta.env.VITE_NOTICE_LAB === '1'
  // 探针模式下**必须**挂（它要点里面的按钮）；`?notice-lab` 与 env 开关同理
  if (wantLab) {
    const host = document.createElement('div')
    host.id = 'notice-lab-host'
    document.body.appendChild(host)
    void import('./dev/NoticeLab').then((m) =>
      ReactDOM.createRoot(host).render(<m.default />))
  }
}