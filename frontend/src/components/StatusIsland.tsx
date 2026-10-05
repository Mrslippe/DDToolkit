import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2 } from 'lucide-react'
import OverlayScroll from './OverlayScroll'
import type { Notice, NoticeActionKind } from '../utils/notificationHub'
import { KIND_GLYPH, isLive } from '../utils/notificationHub'
import type { NoticeGroup } from '../utils/noticeBoard'
import {
  countdownFraction,
  discFraction,
  relTimeFor,
  sectionNotices,
  todoIds,
} from '../utils/noticeBoard'
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
}

/**
 * 面板与胶囊之间的间隙（px）。
 *
 * ⚠️ 2026-10-01 之前它是 `utils/widgetWindow.ts` 的 `WIDGET_PANEL_GAP`（那时小窗宿主
 * 也读它）。小窗退役后只剩顶栏这一个宿主，常量就地下沉到这里 —— 它**只有这一个用处**。
 */
const PANEL_GAP = 6

/** 面板宽（顶栏宿主。小窗宿主的 400 已随小窗一起退役） */
const PANEL_W = 340

/** 自动已读的滑出动画时长（ms）—— 必须与 `status-island.css` 的 `.si-item.is-out` 同值 */
const ITEM_EXIT_MS = 220

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

/** 已在播放退场动画的条目（`leaving` = 是否正在滑出） */
type Row = Notice & { leaving?: boolean }

/**
 * 顶栏「状态岛」（R12a，devlog/089）：把原来三套并存的顶栏信息收成**一个控件**。
 *
 * 四态：`idle`（只有绿点 + 空闲轮播文案）· `pill`（一条主文案 + 图标）·
 * `expand`（面板：全部条目 + 动作）· 空闲时**没有容器**（用户 2026-09-10：
 * 频繁轮询不必占顶栏 —— 那条规则的判定在 `utils/notificationHub.ts` 里，有反向用例）。
 *
 * ## L1（2026-10-05，`docs/design/notices/channel-and-layering.md`）改了四件事
 *
 * 1. **面板分三组**（正在进行 / 需要处理 / 最近）：把"状态"与"事件"从**一条队列**改成
 *    **两个列表** —— 于是"报告顶掉进度""两场开播只显示一场"这类抢位问题从根上不存在；
 * 2. **胶囊文案 = 最高优先那组的合并句**（`noticeBoard.sectionNotices` 的 `headline`）：
 *    多个任务同时跑显示「帖子·账号 抓取中 - 3/11」，而不是只显示其中一个；
 * 3. **倒计时可视化**：会自动消失的条目在面板里有一条**从右往左消退的细条**，
 *    胶囊左侧的圆点多一圈**从 12 点顺时针消退的环**（都只在 `notice` 形态上有，见 §10）；
 * 4. **一键已读**（只清「需要处理」组）与**自动已读的滑出动画**。
 *
 * 空闲轮播（R12b，用户期望③）：没事发生时文案按 `IDLE_TICK_MS` 在
 * 「状态文案 + 语录」之间轮转。**自己的定时器**，只在空闲（无条目）时开：
 * 挂到抓取轮询上会让轮播的可见性随轮询间隔漂移（甚至停住）。
 *
 * ⚠️ DOM 契约（探针 `ui_probe --status-island` 直接查）：
 *   `.si-island`（`.on` = 有事发生）· `.si-dot` · `.si-text` · `.si-count`
 *   `.si-panel` / `.si-sec[data-group]` / `.si-item[data-kind]` / `.si-item-action` / `.si-empty`
 *   `.si-item-bar`（倒计时细条，`data-left` = 剩余比例）· `.si-ring`（胶囊圆环，`data-left`）
 *   空闲态的 `data-idle-index` / `data-idle-size` / `data-idle-pool`：轮播当前第几格 /
 *   池子多大 / 池子内容（`|` 分隔）。探针只能看 DOM，靠这三个属性断言"取到的词出自池子、
 *   索引在池内、并且真的在往前走"；语录里不含 `|` 由单测钉住（否则分隔编码会被打乱）。
 *   面板用 **portal + fixed 定位**（顶栏容器 overflow:hidden 会裁掉内联面板）；
 *   位置在打开时按 island 的矩形算一次，滚动/缩放时重算。
 */
export default function StatusIsland({ notices, onAction, now: nowProp }: Props) {
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
  const [tick, setTick] = useState(0)
  const now = tick === 0 ? nowProp : Math.max(nowProp, Date.now())
  const sections = sectionNotices(notices, now)
  const primary = sections[0]?.items[0] ?? null
  const headline = sections[0]?.headline ?? ''
  const lit = !!primary
  const hasExpiring = notices.some((n) => n.expiresAt !== undefined && n.expiresAt !== null)
  /** 隐藏到托盘（R18）：轮播停表 */
  const hidden = useShellHidden()

  /**
   * **自己的秒表**（L1，2026-10-05）：过期与相对时间都由它驱动。
   *
   * ⚠️ 为什么不能只靠宿主传进来的 `now`：宿主的 `now` 只在**它自己重渲染**时更新，
   * 而它只在两种情况下重渲染 —— 轮询回来（闲时 **10s** 一次）或别处的状态变化。
   * 于是"6 秒后自动已读"会变成"最多 10 秒后才消失"（探针 `--status-island` 实测抓到：
   * TTL 过后又等了 6.6s 仍然亮着），面板里那句"3 分钟前"也会一跳一跳地停住。
   *
   * 只在**有会自动过期的条目**或**面板开着**时走 —— 空闲态有它自己的轮播时钟
   * （`IDLE_TICK_MS`），两个定时器不会同时开。
   */
  useEffect(() => {
    if (!open && !hasExpiring) return
    const t = window.setInterval(() => setTick((x) => x + 1), 1000)
    return () => window.clearInterval(t)
  }, [open, hasExpiring])

  // ── 自动已读的**退场**动画（L1 §10）────────────────────────────────────
  // 为什么不能直接渲染 `sections`：条目一过期就从列表里消失，React 立刻把它从 DOM 摘掉，
  // 于是 CSS 过渡**永远没有机会播**（"滑出"变成"啪一下没了"）。
  // 做法：本地留一份正在退场的副本，动画放完（`ITEM_EXIT_MS`）再真正移除。
  //
  // ⚠️ **过期判定必须自己按时间做**（不能用 `notices` 的变化当触发器）：
  //    `useNotices` 那份列表**不过滤过期**（过滤发生在渲染时），所以"到点了"这件事
  //    不改变 `notices` —— 挂在上面的 effect 一辈子不会为它跑（第一版就是这么写的，
  //    症状是条目**永远留在 rows 里**、滑出动画只在"服务端撤条目"时才播）。
  // ⚠️ 判据（`.si-item` 的条数）仍按**活着的**条目算 —— 探针不看动画中间态。
  const [rows, setRows] = useState<Row[]>([])
  const liveIds = notices.map((n) => n.id).join('|')

  useEffect(() => {
    setRows((prev) => {
      const incoming = new Map(notices.map((n) => [n.id, n]))
      const next: Row[] = []
      for (const r of prev) {
        const fresh = incoming.get(r.id)
        if (fresh) { next.push({ ...fresh, leaving: false }); incoming.delete(r.id) }
        else if (!r.leaving) next.push({ ...r, leaving: true })      // 服务端撤了 ⇒ 滑出
        else next.push(r)                                           // 已在滑出：留着等定时器
      }
      for (const n of incoming.values()) next.push({ ...n, leaving: false })
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIds])

  /** 定时体检：**过期**（TTL 到点）的条目在这里被判出局并开始滑出。
   *
   *  ⚠️ **不能只在面板打开时跑**（第一版就是这么写的，被探针 `messages` 抓出来）：
   *  面板关着时新来的条目也要进 `rows`（否则它下次打开面板时缺一条），
   *  而过期的条目也要被判出局（否则 `rows` 会一直长）。
   *
   *  ⚠️ 用组件的 `now`（而不是裸 `Date.now()`）并把它放进依赖：判据（`isLive`）与渲染
   *  用同一条时间轴，不会出现"定时器到点了但 `now` 还没更新"的错位。
   *
   *  ⚠️⚠️ **没有真变化时必须返回同一个引用**（`return prev`）：`now` 每个 tick 都变
   *  （它是 `Math.max(nowProp, Date.now())`），无条件 `map` 会产出一个新数组 ⇒ effect 之间
   *  互相触发、无限重渲染，**退场动画一帧都看不到**（第一版就是这样，被
   *  `StatusIsland.test.tsx` 那条"先挂 is-out 再摘掉"抓出来）。
   *  这与"`useEffect` 里 setState 要防抖"是同一类坑，只是它长得像纯粹的数据变换。
   */
  useEffect(() => {
    setRows((prev) => {
      let changed = false
      const next = prev.map((r): Row => {
        if (!r.leaving && !isLive(r, now)) { changed = true; return { ...r, leaving: true } }
        return r
      })
      return changed ? next : prev
    })
  }, [now])
  useEffect(() => {
    if (!rows.some((r) => r.leaving)) return
    const t = window.setTimeout(() => {
      setRows((prev) => prev.filter((r) => !r.leaving))
    }, ITEM_EXIT_MS)
    return () => window.clearTimeout(t)
  }, [rows])

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
   *  ⚠️ 参照系是 `window.innerHeight`（主窗口视口高），这在本组件只有一个宿主（顶栏）时成立。
   *  当年小窗宿主复用同一个 `place()` 时它是**自指循环**：小窗高度由面板高度决定 ⇒
   *  展开前后 `innerHeight` 从 40 变到面板高、判据跟着乱跳（实测面板被放到窗口上方，
   *  `top = -126`）。小窗已整体退役（2026-10-01），那条外部信号（窗口写的 `data-flip`）
   *  也随它一起删掉了 —— **判据的前提消失时，连机制一起删**。 */
  const place = () => {
    const r = anchorRef.current?.getBoundingClientRect()
    if (!r) return
    // 面板的**实际高度**：`open` 之后才量得到；量不到时退回 0（下一帧 `place()` 会再来）
    const h = panelRef.current?.offsetHeight ?? 0
    const centered = r.left + r.width / 2 - PANEL_W / 2
    const left = Math.min(Math.max(8, centered), Math.max(8, window.innerWidth - PANEL_W - 8))
    const flip = h > 0 && r.bottom + PANEL_GAP + h > window.innerHeight - 4
    setPos(flip
      ? { left, top: Math.max(4, r.top - PANEL_GAP - h), width: PANEL_W }
      : { left, top: r.bottom + PANEL_GAP, width: PANEL_W })
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
    return () => {
      cancelAnimationFrame(raf)
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
  const text = lit ? headline : idle.text

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

  /** 胶囊左侧：会自动消失时给一个剩余比例（画环），否则保持原来的实心点 */
  const disc = discFraction(primary, now)

  /** 面板里每一条的渲染（`leaving` 的走滑出动画） */
  const renderRow = (n: Row) => {
    const frac = countdownFraction(n, now)
    const relFor = relTimeFor(n, now)
    return (
      <li
        key={n.id}
        className={`si-item${n.leaving ? ' is-out' : ''}`}
        data-kind={n.kind}
        data-form={n.form ?? 'state'}
        data-left={frac === null ? undefined : frac.toFixed(3)}
      >
        <span className={`si-item-icon k-${n.kind}`}>{KIND_ICON[n.kind]}</span>
        <span className="si-item-main">
          {/* 正文与活数据槽**同一行**（`.si-item-line` 是那一行的 flex 容器）：
              风控倒计时这类"同一句话、只有数字在变"的值放 `value` ——
              文案不动、数字刷新，所以它**不参与排序**，也不会让条目跳位。
              此前只渲染 `text` ⇒ 后端那条 `value="47s"` 会整个丢掉（M5-2b）。 */}
          <span className="si-item-line">
            <span className="si-item-text">{n.text}</span>
            {n.value && <span className="si-item-value">{n.value}</span>}
          </span>
          {n.detail && <span className="si-item-detail">{n.detail}</span>}
          <span className="si-item-meta">
            {KIND_LABEL[n.kind]}
            {n.source ? ` · ${n.source}` : ''}
            {/* L1：相对时间（缺失就不显示 —— 老后端没给 createdAt 时不许糊一个"刚刚"）。
                ⚠️ 分隔符也要一起省：写死 ` · ${''}` 会留一个光秃秃的间隔号。 */}
            {relFor ? ` · ${relFor}` : ''}
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
        {/* 自动已读的倒数细条（L1 §10）：**只在会自己消失的条目上**。
            从右端往左消退 —— `scaleX` 而不是 `width`（不触发布局，也免得整行重排）。 */}
        {frac !== null && (
          <span className="si-item-bar" aria-hidden="true">
            <i style={{ transform: `scaleX(${frac.toFixed(3)})` }} />
          </span>
        )}
      </li>
    )
  }

  const rowsById = new Map(rows.map((r) => [r.id, r]))
  const todo = todoIds(notices, now)
  /** 正在退场（已过期、动画还没放完）的条目 —— 它们**不参与判据**。
   *
   *  ⚠️ 判据只能是 `r.leaving`，**不能**再叠一个 `!notices.some(...)`：
   *  `notices` 那份列表**不过滤过期**（过滤发生在渲染时）⇒ 刚过期的那条**仍在 `notices` 里**，
   *  叠了那个条件就永远筛不出东西，退场动画一帧都看不到（第一版就是这么写的）。 */
  const leaving = rows.filter((r) => r.leaving)
  const showEmpty = sections.length === 0 && leaving.length === 0

  return (
    <>
      <span
        ref={anchorRef}
        className={`si-island topbar-status${lit ? ' on' : ''}${open ? ' open' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-idle-index={lit ? undefined : idle.index}
        data-idle-size={lit ? undefined : idle.size}
        data-idle-pool={lit ? undefined : idle.pool.join('|')}
        /* R19：轮播开关的**当前状态**（探针据此断言"现在到底是开着还是关着" ——
           开关与断言分处两地，改一处不改另一处就会红，省得悄悄开了/关了没人知道） */
        data-idle-carousel={lit ? undefined : (IDLE_CAROUSEL_ENABLED ? 'on' : 'off')}
        /* L1：胶囊上那句话来自哪一组 / 那一组有几条（探针据此断言"合并过了"） */
        data-headline-group={lit ? sections[0]?.group : undefined}
        data-section-counts={lit
          ? sections.map((s) => `${s.group}:${s.items.length}`).join(',')
          : undefined}
        title={lit ? `${headline}（点击查看全部通知）` : text}
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
        {/* 左侧指示器（L1）：**会自动消失**的条目画一圈"还剩多少时间"的环
            （从 12 点顺时针消退），内芯仍是原来那个状态点 —— 老用户不会认不出它。
            没有 TTL 的条目（进度/冷却/报告）保持实心点：它们不会自己走，画环就是骗人。 */}
        <span className="si-disc">
          {disc !== null && (
            <svg className="si-ring" viewBox="0 0 20 20" aria-hidden="true"
                 data-left={disc.toFixed(3)}>
              <circle className="si-ring-track" cx="10" cy="10" r="8" />
              <circle
                className="si-ring-arc" cx="10" cy="10" r="8"
                strokeDasharray={`${(disc * 50.265).toFixed(2)} 50.265`}
                transform="rotate(-90 10 10)"
              />
            </svg>
          )}
          <i className={`si-dot${primary?.kind === 'progress' ? ' busy'
            : primary?.kind === 'alert' ? ' warn' : lit ? ' ok' : ''}`} />
        </span>
        {/* 类型字形（D1 内容契约）：点表达**紧迫度**、字形表达**类型**。
            为什么必须有它：`report` 与 `message` 的点色在产品里判定相同（都是 `ok`），
            而胶囊原先不渲染任何图标 ⇒ "全量抓取完成"与"已复制诊断信息"长得一模一样。
            `aria-hidden`：它是**视觉冗余**，语义由 `title` / `aria-expanded` 承担。 */}
        {lit && <span className="si-glyph" aria-hidden="true">{KIND_GLYPH[primary!.kind]}</span>}
        <span className={`si-text pill-text-fade${phaseClass(textState.phase)}`}>{textState.shown}</span>
        {/* 活数据槽（D1）：倒计时 / 进度单独一格 —— 它每秒刷新，但**不重排文案**
            （拼进 `text` 里会让整句走一次淡入淡出，用户看到的是"每秒闪一下"）。 */}
        {lit && primary!.value && <span className="si-value">{primary!.value}</span>}
        {lit && notices.length > 1 &&
          <span className={`si-count${countPopped ? ' is-out' : ''}`}>{notices.length}</span>}
        {lit && <ChevronDown className="si-chevron size-[12px]" />}
      </span>

      {open && pos && primary &&
        createPortal(
          <div
            ref={panelRef}
            className="si-panel"
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
              {showEmpty
                ? <p className="si-empty">现在没有需要你知道的事</p>
                : (
                  <div className="si-secs">
                    {sections.map((s) => (
                      <section className="si-sec" data-group={s.group} key={s.group}>
                        <h4 className="si-sec-title">
                          {s.label}（{s.items.length}）
                          {/* 一键已读**只清「需要处理」**（L1 §10）：语义最窄、最不易误点；
                              「最近」里的告知类本来就会自己过期，不需要也没必要手动清。 */}
                          {s.group === 'todo' && todo.length > 0 && (
                            <button
                              type="button"
                              className="si-sec-action"
                              data-ack-all="1"
                              /* 动作交给宿主（`TopBar.onIslandAction`）→ 它一次把 `todoIds`
                                 发成一个批量 ack（一次写盘，不会"清到一半"） */
                              onClick={() => onAction('ack-all' as NoticeActionKind, s.items[0])}
                            >
                              全部已读
                            </button>
                          )}
                        </h4>
                        <ul className="si-list">
                          {s.items.map((n) => renderRow(rowsById.get(n.id) ?? n))}
                        </ul>
                      </section>
                    ))}
                    {/* 正在滑出的条目：不参与判据（`.si-item` 计数按活着的算），只为动画留在 DOM 里 */}
                    {leaving.length > 0 && (
                      <ul className="si-list si-list-leaving" aria-hidden="true">
                        {leaving.map((r) => renderRow(r))}
                      </ul>
                    )}
                  </div>
                )}
            </OverlayScroll>
            <div className="si-panel-foot">
              <span className="si-panel-order">今天：正在发生的事优先，其次是等你处理的，最后是刚过去的</span>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

export type { NoticeGroup }
