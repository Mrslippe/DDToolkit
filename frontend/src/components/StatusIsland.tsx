import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2 } from 'lucide-react'
import OverlayScroll from './OverlayScroll'
import type { Notice, NoticeActionKind } from '../utils/notificationHub'
import { KIND_PRIORITY, pickPrimary } from '../utils/notificationHub'
import { IDLE_CAROUSEL_ENABLED, IDLE_TICK_MS, pickIdle } from '../utils/idleQuotes'
import { isShellHidden } from '../utils/shellLifecycle'
import { useShellHidden } from '../hooks/useShellHidden'
import { initialTextState, phaseClass, reduceText } from '../utils/statusIslandText'

interface Props {
  notices: Notice[]
  /** 点面板里的动作（由 TopBar 映射到具体行为） */
  onAction: (kind: NoticeActionKind, n: Notice) => void
  /** 当前时间（每次渲染现取，保证过期判定跟着走） */
  now: number
  /**
   * 宿主（R38 批 5，规格 §7/§8）：`bar` = 顶栏内联（现状）· `widget` = 桌面独立控件。
   *
   * **宿主无关是硬要求**（§8）：状态机与动画都不得依赖顶栏。这一点本组件早就满足 ——
   * `place()` 读的是 `anchorRef` 自己的 rect（**面板锚定一律相对胶囊自身**），
   * 没有任何"相对顶栏定位"的假设。所以换宿主只是换一层材质与尺寸。
   */
  density?: 'bar' | 'widget'
}

const KIND_ICON: Record<string, React.ReactNode> = {
  alert: <AlertTriangle className="size-[13px]" />,
  progress: <Loader2 className="size-[13px] animate-spin" />,
  report: <CheckCircle2 className="size-[13px]" />,
  message: <CheckCircle2 className="size-[13px]" />,
}

const KIND_LABEL: Record<string, string> = {
  alert: '注意',
  progress: '进行中',
  report: '已完成',
  message: '提示',
}

/**
 * 顶栏「状态岛」（R12a，devlog/089）：把原来三套并存的顶栏信息收成**一个控件**。
 *
 * 四态：`idle`（只有绿点 + 空闲轮播文案）· `pill`（一条主文案 + 图标）·
 * `expand`（面板：全部条目 + 动作）· 空闲时**没有容器**（用户 2026-09-10：
 * 频繁轮询不必占顶栏 —— 那条规则的判定在 `utils/notificationHub.ts` 里，有反向用例）。
 *
 * 空闲轮播（R12b，用户期望③）：没事发生时文案按 `IDLE_TICK_MS` 在
 * 「状态文案 + 语录」之间轮转。**自己的定时器**，只在空闲（无条目）时开：
 * 挂到抓取轮询上会让轮播的可见性随轮询间隔漂移（甚至停住）。
 *
 * ⚠️ DOM 契约（探针 `ui_probe --status-island` 直接查）：
 *   `.si-island`（`.on` = 有事发生）· `.si-dot` · `.si-text` · `.si-count`
 *   `.si-panel` / `.si-item[data-kind]` / `.si-item-action` / `.si-empty`
 *   空闲态的 `data-idle-index` / `data-idle-size` / `data-idle-pool`：轮播当前第几格 /
 *   池子多大 / 池子内容（`|` 分隔）。探针只能看 DOM，靠这三个属性断言"取到的词出自池子、
 *   索引在池内、并且真的在往前走"；语录里不含 `|` 由单测钉住（否则分隔编码会被打乱）。
 * 面板用 **portal + fixed 定位**（顶栏容器 overflow:hidden 会裁掉内联面板）；
 * 位置在打开时按 island 的矩形算一次，滚动/缩放时重算。
 */
export default function StatusIsland({ notices, onAction, now, density = 'bar' }: Props) {
  const [open, setOpen] = useState(false)
  /**
   * 「钉住」（R39-C，用户 2026-09-19：「改为鼠标 hover 就呼出，离开就收起」）：
   * **hover 是快捷方式、点击是钉住** —— 点开之后指针移开也**不许收**（否则"点开细看"做不到），
   * 要 Esc / 点别处 / 条目清空才收。hover 展开不钉住，离开 200ms 就收。
   */
  const [pinned, setPinned] = useState(false)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const hoverTimer = useRef<number | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const primary = pickPrimary(notices, now)
  const lit = !!primary
  /** 隐藏到托盘（R18）：轮播停表 */
  const hidden = useShellHidden()

  // 空闲轮播的时钟：**只在空闲时走**（有事发生时立刻停表，省掉一个无谓的定时器；
  // 也让"语录正在轮播"不可能和"有通知亮着"同时出现在屏幕上）。
  // R18：隐藏到托盘时同样停表 —— 6s 一次的轮播在后台跑 8 小时是纯浪费（界面根本没人看）。
  // R19：轮播**下线**时连定时器都不开 —— 文案恒为状态文案，每 6s 重渲染一次纯属白干。
  const [idleTick, setIdleTick] = useState(() => Date.now())
  useEffect(() => {
    if (lit || hidden || !IDLE_CAROUSEL_ENABLED) return
    setIdleTick(Date.now())   // 从有事故态/隐藏态回到空闲时立刻取一次，别停在旧格上
    const timer = window.setInterval(() => {
      // ⚠️ 判据读**同步源**：隐藏是同步置位的，而 React 状态要等下一次渲染 ——
      // 定时器可能恰好落在那道缝里（与顶栏轮询同款竞态，见 TopBar 的 schedule 注释）
      if (!isShellHidden()) setIdleTick(Date.now())
    }, IDLE_TICK_MS)
    return () => window.clearInterval(timer)
  }, [lit, hidden])

  /** 面板位置：**水平中心对齐胶囊**（越界时收进视口）；
   * 纵向默认贴在胶囊**下方**，贴屏幕下沿时**向上翻**（面板在胶囊上方）。
   *
   *  R39-C（用户）：「下拉栏居中」—— 原来是把面板**左缘**对齐胶囊左缘，胶囊越靠右面板越偏。
   *
   *  ⚠️ **向上翻（R38 批 5d）**：小窗默认落在**右下角**，1080p 上向下展开需要
   *  `968 + 40 + 6 + 面板高 ≥ 1214` ⇒ **永远放不下**。窗口那一侧会把窗口向上长
   *  （`widgetExpandGeom` 的 `flipUp`），面板在窗口里的位置也随之要在**胶囊上方**。
   *  两处必须一致：窗口向上长、面板却还画在胶囊下方 ⇒ 面板落在窗口外（就是那个 bug 的翻版）。
   *
   *  ⚠️⚠️ **小窗宿主下翻不翻，由窗口那边说了算**（R38 批 5f 修）。
   *
   *  原来这里自己按 `window.innerHeight` 判"下方放不下就翻上去"。在**顶栏宿主**里这是对的
   *  （`innerHeight` 就是应用窗口高，是个稳定的参照系）；但在**小窗宿主**里它是**同一个自指循环**：
   *  小窗的高度**由面板高度决定**（窗口 = 40 + 6 + 面板高）⇒ 展开前后 `innerHeight` 从 40
   *  变到面板高，判据跟着乱跳（实测：折叠态窗口 40px ⇒ `below(166) > 40-4` ⇒ 判"翻上去"
   *  ⇒ `top = 0 - 6 - 120 = -126` ⇒ **面板跑到窗口上方去了**）。
   *
   *  而"翻不翻"真正的决定因素在**屏幕**（贴下沿才翻），那只有窗口那边知道
   *  （`widgetExpandGeom` 用 `currentMonitor()` 算）。所以小窗宿主下**直接跟随**
   *  窗口写下的 `data-flip`（那是几何的唯一事实源），本组件不再自行判断 ——
   *  §8「宿主无关」没有被破坏：它只是读一个**可选**的外部信号，读不到就退回原来的算法。 */
  const place = () => {
    const r = anchorRef.current?.getBoundingClientRect()
    if (!r) return
    const width = density === 'widget' ? 280 : 340   // §7：widget 展开宽 280（bar 沿用 340）
    const centered = r.left + r.width / 2 - width / 2
    const left = Math.min(Math.max(8, centered), Math.max(8, window.innerWidth - width - 8))
    // 面板的**实际高度**：`open` 之后才量得到；量不到时退回 0（下一帧 `place()` 会再来）
    const h = panelRef.current?.offsetHeight ?? 0
    // widget 宿主：**跟随窗口那边的决定**（它是屏幕级的几何真源）
    const shellFlip = density === 'widget'
      ? document.querySelector<HTMLElement>('.widget-shell')?.dataset.flip
      : undefined
    const flip = shellFlip
      ? shellFlip === 'up'
      // 顶栏宿主：原来的判据（这里的 `innerHeight` 是稳定的应用窗口高，不构成循环）
      : h > 0 && r.bottom + 6 + h > window.innerHeight - 4
    setPos(flip
      ? { left, top: Math.max(4, r.top - 6 - h), width }
      : { left, top: r.bottom + 6, width })
  }

  /** 悬停时长的两个口径：进入要**等一等**（掠过不弹），离开要**宽限**（容得下移进面板） */
  const HOVER_OPEN_MS = 120
  const HOVER_CLOSE_MS = 200

  const clearHoverTimer = () => {
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  const hoverIn = () => {
    if (!lit) return
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(() => setOpen(true), HOVER_OPEN_MS)
  }

  /** 离开：**钉住时不收**（点击过的面板要留着） */
  const hoverOut = () => {
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null
      setOpen((o) => (pinned ? o : false))
    }, HOVER_CLOSE_MS)
  }

  useEffect(() => clearHoverTimer, [])

  useEffect(() => {
    if (!open) return
    place()
    // ⚠️ **量到面板真实高度后再定一次位**（R38 批 5d）：`place()` 首次跑时面板还没挂载
    //    （`open` 刚变 true，这次渲染里 `panelRef` 还是 null）⇒ 高度量到 0 ⇒ 判不出该不该
    //    向上翻。下一帧（`requestAnimationFrame`）面板已经在 DOM 里，此时重量才作数。
    //    只做一次：面板高度在展开期间基本不变，反复量会让它持续微调（看起来在抖）。
    let raf = requestAnimationFrame(() => place())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setPinned(false)
      }
    }
    const onResize = () => place()
    // 点面板/胶囊之外 ⇒ 收起并解除钉住（钉住不能变成"只能按 Esc"）
    const onOutside = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
      setPinned(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('resize', onResize)
    // ⚠️ **`data-flip` 变了要重排**（R38 批 5f）：小窗宿主下这个属性由**窗口那边**在
    //    resize 之后写下（`widgetExpandGeom` 算完才知道翻不翻），而那时本组件的
    //    `place()` 已经跑过了 ⇒ 属性变了没人理，面板就停在旧方向上。
    //    用 MutationObserver 盯它，而不是让窗口去调组件（组件不该知道窗口的存在 —— §8）。
    let mo: MutationObserver | null = null
    if (density === 'widget') {
      const shell = document.querySelector<HTMLElement>('.widget-shell')
      if (shell) {
        mo = new MutationObserver(() => place())
        mo.observe(shell, { attributes: true, attributeFilter: ['data-flip'] })
      }
    }
    return () => {
      cancelAnimationFrame(raf)
      mo?.disconnect()
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onOutside, true)
      window.removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 条目清空（例如瞬时消息过期后没有别的事）→ 面板自己收起，别留个空面板
  useEffect(() => {
    if (open && !primary) {
      setOpen(false)
      setPinned(false)
    }
  }, [open, primary])

  /** 空闲轮播取词（有事故态时用主条目文案；`lit` 时不参与渲染） */
  const idle = pickIdle(idleTick)
  const text = primary?.text ?? idle.text

  // ── R38 批 4「打断 / 重定向」：文案切换走状态机 ──────────────────────────
  // 原来 `.si-text` 挂 `key={text}` ⇒ 文案一变就**重挂载** ⇒ CSS `@keyframes` **从头重放**
  // （先 opacity:0 停 `--motion-lag` 再淡入），连续换字时**每次都闪**。
  // 现在元素保持挂载、用 **transition** 驱动 ⇒ 从**当前值**继续（transition 可重定向，
  // keyframes 只会重启）。决策在纯函数 `utils/statusIslandText.ts` 里，有 9 条单测。
  const [textState, setTextState] = useState(() => initialTextState(text))
  const textRef = useRef(textState)
  textRef.current = textState
  const textTimer = useRef<number | null>(null)

  useEffect(() => {
    const step = reduceText(textRef.current, text, false)
    if (step.state !== textRef.current) setTextState(step.state)
    if (step.scheduleMs == null) return
    // ⚠️ **故意不在这里返回 cleanup** —— 定时器属于"撤"这个**阶段**，不属于某一次 `text` 变化。
    // 若返回 cleanup，"打断"（text 又变）会把它清掉 ⇒ 文案永远换不过去，
    // 而"打断不重排"正是本批要保住的性质（见 statusIslandText.ts 模块注释）。
    textTimer.current = window.setTimeout(() => {
      textTimer.current = null
      setTextState((s) => reduceText(s, text, true).state)
    }, step.scheduleMs)
  }, [text])

  /** 只在**卸载**时清定时器（与上面那条 effect 分开写，正是为了不误清） */
  useEffect(() => () => {
    if (textTimer.current != null) window.clearTimeout(textTimer.current)
  }, [])

  // ── R38 批 5 收尾（2026-09-25）：`.si-count` 从「keyframes 重放」改成「transition 重定向」──
  // 批 4 把**文案**改了、把**计数徽章**留下了（devlog/171 §六：「收益远小于文案」）。
  // 但这两个东西**同源** —— 计数一变就走同一条重挂载路径，留着它 means 连续变计数仍会闪，
  // 与批 4 的整个论点自相矛盾。批 4 说难在"先置 0.6 再置 1 的帧边界"，其实**不需要帧边界**：
  //
  // **CSS 过渡取的是"变化后"那一边的 `transition-duration`**（与 `.si-text.is-out`
  // 用 `--motion-instant` 是同一条性质）⇒ 进 `is-out` 给 `0s` 就是**瞬时复位**到 0.6，
  // 撤掉 `is-out` 时按基态的 `--motion-fast` **弹出**。两相就够，没有定时器边界问题。
  //
  // ⚠️ 元素**保持挂载**（去掉原来的 `key={notices.length}`）—— 那正是重放的原因。
  // 可重定向：中途再变计数只是再复位一次，不会排队。
  const [countPopped, setCountPopped] = useState(false)
  const countRef = useRef(notices.length)
  // ⚠️ **必须是 `useLayoutEffect`（绘制前），不能是 `useEffect`**：
  //    新数字先以**全尺寸**画一帧、下一拍才缩到 0.6 再弹出 ⇒ 屏幕上会看到
  //    "新数字闪一下 → 又缩回去 → 再弹出来"。`useLayoutEffect` 在浏览器绘制前跑完，
  //    把这一步藏掉（这也是它与"帧边界"那套说法的实际差别所在）。
  useLayoutEffect(() => {
    if (countRef.current === notices.length) return
    countRef.current = notices.length
    setCountPopped(true)                            // ① 瞬时缩到 0.6（`is-out` 的时长是 0s）
    const t = window.setTimeout(() => setCountPopped(false), 0)   // ② 下一拍撤掉 ⇒ --motion-fast 弹出
    return () => window.clearTimeout(t)
  }, [notices.length])
  const href = primary?.source ?? ''

  return (
    <>
      <span
        ref={anchorRef}
        className={`si-island topbar-status${lit ? ' on' : ''}${open ? ' open' : ''}`}
        data-density={density}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-idle-index={lit ? undefined : idle.index}
        data-idle-size={lit ? undefined : idle.size}
        data-idle-pool={lit ? undefined : idle.pool.join('|')}
        /* R19：轮播开关的**当前状态**（探针据此断言"现在到底是开着还是关着" ——
           开关与断言分处两地，改一处不改另一处就会红，省得悄悄开了/关了没人知道） */
        data-idle-carousel={lit ? undefined : (IDLE_CAROUSEL_ENABLED ? 'on' : 'off')}
        title={lit ? `${text}（点击查看全部通知）` : text}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
        onClick={() => {
          if (!lit) return
          clearHoverTimer()
          setPinned((p) => {
            const nextPinned = !open ? true : !p
            return nextPinned
          })
          setOpen((o) => !o)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (lit) {
              setPinned(!open)
              setOpen((o) => !o)
            }
          }
        }}
      >
        <i className={`si-dot topbar-status-dot${primary?.kind === 'progress' ? ' busy'
          : primary?.kind === 'alert' ? ' warn' : lit ? ' ok' : ''}`} />
        <span className={`si-text pill-text-fade${phaseClass(textState.phase)}`}>{textState.shown}</span>
        {lit && notices.length > 1 &&
          <span className={`si-count${countPopped ? ' is-out' : ''}`}>{notices.length}</span>}
        {lit && <ChevronDown className="si-chevron size-[12px]" />}
      </span>

      {open && pos && primary &&
        createPortal(
          <div
            ref={panelRef}
            className="si-panel"
            data-density={density}
            style={{ left: pos.left, top: pos.top, width: pos.width }}
            role="dialog"
            aria-label="顶栏通知"
            data-pinned={pinned ? '1' : '0'}
            onPointerEnter={clearHoverTimer}
            onPointerLeave={hoverOut}
          >
            <div className="si-panel-head">
              <span className="si-panel-title">通知（{notices.length}）</span>
              <span className="si-panel-hint">{href}</span>
            </div>
            <OverlayScroll className="si-panel-scroll">
              <ul className="si-list">
                {notices.map((n) => (
                  <li key={n.id} className="si-item" data-kind={n.kind}>
                    <span className={`si-item-icon k-${n.kind}`}>{KIND_ICON[n.kind]}</span>
                    <span className="si-item-main">
                      <span className="si-item-text">{n.text}</span>
                      {n.detail && <span className="si-item-detail">{n.detail}</span>}
                      <span className="si-item-meta">
                        {KIND_LABEL[n.kind]}
                        {n.source ? ` · ${n.source}` : ''}
                        {n.sticky ? ' · 常驻' : ''}
                      </span>
                    </span>
                    {n.action && (
                      <button
                        type="button"
                        className="si-item-action"
                        onClick={() => onAction(n.action!.kind, n)}
                      >
                        {n.action.label}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </OverlayScroll>
            <div className="si-panel-foot">
              <span className="si-panel-order">
                优先级：{Object.entries(KIND_PRIORITY).sort((a, b) => b[1] - a[1])
                  .map(([k]) => KIND_LABEL[k]).join(' > ')}
              </span>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
