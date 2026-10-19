import { useEffect, useRef, useState } from 'react'
import { BarChart3, FileText } from 'lucide-react'
import { setViewTransitionDriver } from './utils/viewTransition'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import TopBar from './components/TopBar'
import IconRail from './components/IconRail'
import { useSolo } from './utils/soloMode'
import { useSoloIdle, useSoloPeek } from './utils/soloPeek'
import VtuberSidebar from './components/VtuberSidebar'
import EmptyState from './pages/EmptyState'
import PostsPage from './pages/PostsPage'
import WorkbenchPage from './pages/WorkbenchPage'
import ErrorBoundary from './components/ErrorBoundary'
import LegalNotice from './components/LegalNotice'
import { api } from './api/api'
import type { AgreementState } from './api/types'
import { useIsMaximized } from './hooks/useIsMaximized'
import { clearShellState, loadShellState, shouldRestoreFromTray } from './utils/shellState'
import { useEmojiBigSize } from './utils/emojiSize'
import { useGroupBadge } from './utils/groupBadgePref'
import './styles/layout.css'
import './styles/status-island.css'

/** 揭幕幕布的时长（ms）。与 CSS 的 `.view-curtain` 动画时长必须一致。 */
type Phase = 'idle' | 'closing' | 'icon' | 'loading' | 'opening'

/**
 * 应用壳布局（参照设计稿 Frame1672）：
 * 顶栏常驻；左起依次为工具图标栏、VTuber 列表栏（均常驻）；
 * 右栏由路由驱动 —— `/` 空置界面，`/vtubers/:id` 帖子面板。
 * ErrorBoundary 包住整个壳层：TopBar/Sidebar 抛错也不会白屏。
 */
export default function App() {
  const isMax = useIsMaximized()
  const navigate = useNavigate()
  /* 哪些路由**不共用**主播左栏（目前只有工作台）。 */
  const { pathname } = useLocation()
  const bareShell = pathname.startsWith('/workbench')
  /* 切界面时**盖一层幕布再揭开**（2026-10-18 用户：从左工具栏换页要像启动那样揭幕）。
     ⚠️ 光给 `.app-main` 加动效不够：左栏从 `display:none` 切回时会重新测量，
     测量期间渲染不出条目 —— 那块空白**在内容区之外**，必须由覆盖整块的幕布盖住。 */
  /* 三段式：**加载 → 揭幕 → 完成**（用户 2026-10-18）。
     ⚠️ 老实说：这是**按时间**分的段，不是"等数据真的回来"。要做成数据驱动，得让每个页面
     上报自己的首屏就绪 —— 那是另一件事，先按用户要的流程把节奏做出来。 */
  const [phase, setPhase] = useState<Phase>('idle')
  /** 当前界面的键：`fan_workbench` / `posts`。用 ref 是因为 driver 只注册一次 */
  const viewKeyRef = useRef<string>('posts')
  viewKeyRef.current = pathname.startsWith('/workbench') ? 'fan_workbench' : 'posts'
  /* 协调器：工具栏请求切界面时，壳层先把幕布**合上**，合好之后再让导航发生 ——
     这样"界面变换"发生在幕布遮住的**加载中**那一段，而不是先换再遮（用户口径）。
     时序：不动 → 闭幕 180 → 图标 140 → 加载 200（此刻导航）→ 揭幕 260 → 完成 */
  useEffect(() => {
    let timers: number[] = []
    setViewTransitionDriver((next, key) => {
      timers.forEach((x) => window.clearTimeout(x))
      /* 目标界面与当前一致 ⇒ 不播幕布（2026-10-19 用户：点当前界面不应触发展开流程）。
         调用点已各自判重，这里是兜底，防止将来别的入口忘了。
         ⚠️ 读 `viewKeyRef` 而不是 `window.location` —— 后者在测试里（MemoryRouter）永远是 `/`。 */
      if (key && key === viewKeyRef.current) { next(); return }
      setPhase('closing')
      timers = [
        window.setTimeout(() => setPhase('icon'), 180),
        window.setTimeout(() => { setPhase('loading'); next() }, 320),
        window.setTimeout(() => setPhase('opening'), 520),
        window.setTimeout(() => setPhase('idle'), 780),
      ]
    })
    return () => {
      timers.forEach((x) => window.clearTimeout(x))
      setViewTransitionDriver(null)
    }
  }, [])

  const mainRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    el.classList.remove('view-enter')
    void el.offsetWidth          // 强制回流，动画才会重播
    el.classList.add('view-enter')
  }, [pathname])
  /* 大表情尺寸（2026-10-14，`devlog/486`）：读一次用户偏好 → 写到根元素的 CSS 变量。
     挂在壳层**而不是**设置窗/详情页：它影响所有渲染正文的地方，必须全局一致。 */
  useEmojiBigSize()
  /* 企划徽章的显示开关（2026-10-14，用户口径：做进设置里、默认关）：同一个位置读一次偏好 →
     写到 `<html data-group-badge>`，左栏那一列由 CSS 决定显不显示。 */
  useGroupBadge()
  // 最大化时给 html 挂 window-maximized 类，壳层圆角随之取消
  useEffect(() => {
    document.documentElement.classList.toggle('window-maximized', isMax)
  }, [isMax])

  /**
   * 深休眠唤醒后回到离开的位置（R18，devlog/095）。
   *
   * 链路：隐藏 10 分钟后 Rust 销毁 WebView 释放内存 → 唤回时**重建窗口**并加载
   * `index.html?restored=1`（不是深链接：SPA 的深链接在资源协议下会 404）→
   * 这里读到标记后，把存下来的路由/视图**校验过**再恢复。
   *
   * 三处刻意的谨慎：① 只在带标记时恢复（正常启动仍从首页开始）；
   * ② 路径与视图都过 `sanitize*`（坏值一律当"没存过"）；③ 恢复后立刻清掉现场，
   * 免得下次正常启动又被"上一次的位置"劫持。
   */
  useEffect(() => {
    if (!shouldRestoreFromTray(window.location.search)) return
    const saved = loadShellState(Date.now())
    clearShellState()
    if (saved && saved.view) window.sessionStorage.setItem('ddtoolkit.restore-view', saved.view)
    if (saved) navigate(saved.route, { replace: true })
  }, [navigate])

  /**
   * **用户协议闸门**（2026-10-06，用户口径）：「第一次启动应用或者更新至这个版本时，都要阅读
   * 一个用户协议或者公告……阅读完同意才可以关闭窗口」。判定在后端（要同意的版本 = 应用版本，
   * 同意状态存 `app_meta`）—— 这里只做两件事：**启动时问一次**、**needed 就挡住整个应用**。
   *
   * ⚠️ 取不到时**不放行也不报错**：启动那几秒后端可能还没起来（壳会先显示揭幕幕），
   *    所以带一个**有上限的轮询**（最多 ~1 分钟）。宁可晚几秒弹，也不假装"读过协议了"。
   */
  const [agreement, setAgreement] = useState<AgreementState | null>(null)
  useEffect(() => {
    let alive = true
    let tries = 0
    let timer: number | undefined
    const ask = async () => {
      try {
        const got = await api.getAgreement()
        if (alive) setAgreement(got)
      } catch {
        tries += 1
        if (alive && tries < 12) timer = window.setTimeout(() => void ask(), 5000)
      }
    }
    void ask()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [])

  const solo = useSolo()
  /**
   * 单推的 hover 唤出（按**坐标**判定，`devlog/433`）。
   *
   * 前两版分别用 CSS `:hover` 与"指针落在哪个元素上"——都栽在同一件事上：
   * 唤出**会改变布局**（工具栏回来把内容推走）⇒ 指针下的元素跟着变 ⇒ 状态来回翻
   * （用户报的"界面元素快速闪动 + 卡顿"），而且左侧工具栏干脆唤不出来。
   * 现在 `mousemove` 只看 `clientX/clientY`：**与遮挡、层级、布局位移全都无关**，
   * 判定逻辑在 `utils/soloPeek.ts`（有单测）。唤出后那个区会"长大"到该栏自身的大小，
   * 免得指针一移进去就掉出薄条、栏又从手底下消失。
   */
  const peek = useSoloPeek(Boolean(solo))
  /* 界面元素的**自动隐藏**（`devlog/435`）：鼠标停一会儿就让位给背景图、一动就回来。
     ⚠️ 上一版把"恢复"键在 `data-peek` 上，而它恒有值（默认 `center`）⇒ 恢复规则一直生效、
     **自动隐藏直接没了**（用户报的第 2 条）。现在 `data-peek` 只在真的唤出两栏时才有值，
     "让位"交给闲置状态决定。 */
  const idle = useSoloIdle(Boolean(solo))

  /* 揭幕中间显示的是**目标界面**的图标：去工作台显示柱状图，回帖子浏览显示文件。 */
  const TargetIcon = bareShell
    ? <BarChart3 size={26} strokeWidth={1.8} />
    : <FileText size={26} strokeWidth={1.8} />

  return (
    /* 单推模式的标记挂在这里：三段收起、空闲让位与 hover 唤出全走 CSS（`devlog/431`/`435`） */
    <div className="app-shell" data-solo={solo ? '1' : undefined}
         data-peek={solo && peek !== 'center' ? peek : undefined}
         data-idle={solo && idle ? '1' : undefined}>
      {/* ⚠️ 两条**贴边窄带**：尺寸 = 被唤出的元素自身（顶栏高 / 工具栏宽），
          悬到它们所在的整片区域就唤出。唤出期间它们 `pointer-events: none` 让位（CSS 里）。 */}
      <ErrorBoundary>
        <TopBar />
        <div className="app-body" data-bare={bareShell ? '1' : undefined}>
          <IconRail />
          {/* 工作台是**独立界面**：不共用帖子浏览的主播左栏（2026-10-18 用户口径）。
              ⚠️ 左栏消失后，"当前选中哪个 V"只由工作台自己的选择器承担 ——
              从工作台回帖子浏览时左栏选中的**仍是原来那个 V**，这是预期行为，不是 bug。 */}
          {/* ⚠️ **保持挂载、只隐藏**（2026-10-18 用户：切回帖子浏览时左栏空 0.8s 才渐显）。
              条件渲染会把它卸载 → 再进来要重新拉列表 = 那片空白。所以改成 CSS 隐藏，
              组件与数据都留着，切回来立即有内容。 */}
          <VtuberSidebar />
          {phase !== 'idle' && (
            <div className={`view-curtain is-${phase}`} aria-hidden>
              {(phase === 'icon' || phase === 'loading') && (
                <span className="curtain-icon">{TargetIcon}</span>
              )}
            </div>
          )}
          <main className="app-main" ref={mainRef}>
            <Routes>
              <Route path="/" element={<EmptyState />} />
              <Route path="/vtubers/:id" element={<PostsPage />} />
              <Route path="/workbench" element={<WorkbenchPage />} />
              <Route path="*" element={<EmptyState />} />
            </Routes>
          </main>
        </div>
      </ErrorBoundary>
      {/* ⚠️ **闸门放在 ErrorBoundary 之外**：壳层炸了也要先能读到协议（它不该被别人的错误吞掉） */}
      {agreement?.needed && (
        <LegalNotice version={agreement.required}
                     appVersion={agreement.app_version}
                     onAccepted={() => setAgreement({ ...agreement, needed: false,
                                                      accepted: agreement.required })} />
      )}
    </div>
  )
}
