import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, ChevronDown, Gauge, Hourglass, KeyRound,
         Loader2, Radio } from 'lucide-react'
import OverlayScroll from './OverlayScroll'
import type { Notice, NoticeActionKind } from '../utils/notificationHub'
import { KIND_GLYPH, expiresAtOf, isLive } from '../utils/notificationHub'
import type { NoticeGroup } from '../utils/noticeBoard'
import {
  GROUP_LABEL,
  GROUP_ORDER,
  ackAllIds,
  compareInGroup,
  countdownFraction,
  discFraction,
  groupOf,
  relTimeFor,
  sectionNotices,
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

/** 自动已读的滑出动画时长（ms）—— 必须与 `status-island.css` 的 `.si-item.is-sliding` 同值
 * （动画挂在 **`.is-sliding`** 上，不是 `.is-out`：见 `EXIT_YIELD_MS` 那段注释） */
const ITEM_EXIT_MS = 220

/**
 * 「一次有好几条同时退场」时，**逐条放行**的间隔（ms）—— 用户 2026-10-05 选定 70ms。
 *
 * 5 条约 0.35s，看起来是"从上往下扫过去"而不是"排着队等"（120ms 那档被否掉了太慢，
 * 严格串行 220ms/条 要 1.1s 更慢）。范围也由用户定：**凡是同时多条退场都按这个节奏**
 * （不只「全部已读」）—— TTL 同一拍到点的几条、服务端一次撤多条，也一条一条走。
 */
const ACK_STAGGER_MS = 70

/**
 * 退场那条**滑到几成才让出流内位置**（用户 2026-10-06 新口径的原话：
 * 「让上一条已读滑出 **60%–80%** 之后，下面的条目再顶上去」）。
 *
 * ⚠️ 这是一次**口径反转**（2026-10-05 的老口径是"退场那条必须当场浮起来、下面的条目
 * **同时**上移"，理由是"不浮就得等它滑完才顶上"）。用户看过实际效果之后要的是**错开**：
 * 先让它滑，滑过大半、快到看不着了，再让下面那条顶上来 —— 两个动作在时间上分开，
 * 眼睛才跟得上"是这一条走了、那一条顶上来了"。
 * 取区间中点偏下（0.65×220 ≈ 143ms）：不透明度在 40%（≈90ms）就归零，所以让位发生时
 * 那条**已经看不见了**，顶上来的是"一块刚空出来的位置"而不是"一条正在消失的条目"。
 */
const EXIT_YIELD_AT = 0.65

/**
 * **让位时刻**（放行后多少 ms 那条才 `position:absolute` 浮起来、把流内位置交出去）。
 * 由 `ITEM_EXIT_MS` 推出来，不许各写一份（改一处即两处）。
 *
 * ⚠️⚠️ **总时长不变**：移除表仍按**放行那一刻**起算 `ITEM_EXIT_MS`
 * ⇒ 让位只是把"腾出位置"这一步往后挪，条目在屏幕上待多久一个字没改。
 *
 * ⚠️ **动画绝不能在这一拍重启**：从 `sliding` 切到 `leaving` 时，元素上新增的只有
 * `.is-out`（= 定位），而**动画一直挂在 `.is-sliding` 上** —— 计算值的 `animation-name`
 * 没变，浏览器就不会重新播放。若把动画一起挪到 `.is-out`（老写法）就会**从头再播一次**：
 * 那条会"往回跳一下"再滑出去。判据见 `StatusIsland.test.tsx`
 * （「两个类同时在场」+ 读真 CSS 的结构判据）。
 */
const EXIT_YIELD_MS = Math.round(ITEM_EXIT_MS * EXIT_YIELD_AT)

/**
 * 面板条目的**图标**：优先按**来源**选，认不出来才退回按 `kind` 选（2026-10-05 用户反馈）。
 *
 * 为什么必须分来源：`kind` 只有四种（alert/progress/report/message），而**开播 / 登录失效 /
 * 能力受限 / 风控冷却**全都是 `alert` ⇒ 面板里四个不同的东西顶着一模一样的 ⚠。
 * 用户的评价很准：「警告图标不适合开播」—— 开播是**好事**，用警示三角是在说错话。
 *
 * 口径：
 * - **`source` 是后端给的字符串**（`services/notices.py` 里的 `"开播"` / `"登录态"` /
 *   `"能力矩阵"` / `"风控冷却"` …），这里只做"标签 → 图标"的映射，**不改契约**；
 * - 认不出来（如将来新增一类）⇒ 退回 `kind` 那套（组件原来的行为），不会出现空白图标；
 * - ⚠️ 这张表**不是**"画得像"的问题：图标是**在同一屏里区分四条 alert 的唯一手段**
 *   （点色相同、都是 alert），所以每一类都得不一样。
 */
const KIND_ICON: Record<string, React.ReactNode> = {
  alert: <AlertTriangle className="size-[13px]" />,
  progress: <Loader2 className="size-[13px] animate-spin" />,
  report: <CheckCircle2 className="size-[13px]" />,
  message: <CheckCircle2 className="size-[13px]" />,
}

/** 来源 → 图标（认不出来就 `undefined`，调用方退回 `KIND_ICON[kind]`） */
const SOURCE_ICON: Record<string, React.ReactNode> = {
  // 开播是**好消息**：用"广播信号"而不是警示三角（用户 2026-10-05 点名这一条）
  开播: <Radio className="size-[13px]" />,
  // 登录失效是可修的凭据问题：用钥匙（顶栏那个登录入口也是"钥匙"语义）
  登录态: <KeyRound className="size-[13px]" />,
  // 能力受限是"范围被限制"：用仪表盘（比"锁"少一点责备感，且它说的是"打了折"）
  能力矩阵: <Gauge className="size-[13px]" />,
  // 风控冷却等的就是时间：用沙漏（配合右侧那个每秒刷新的倒计时 `value`）
  风控冷却: <Hourglass className="size-[13px]" />,
}

function iconFor(n: { kind: string; source?: string }): React.ReactNode {
  return (n.source && SOURCE_ICON[n.source]) || KIND_ICON[n.kind] || KIND_ICON.alert
}

const KIND_LABEL: Record<string, string> = {
  alert: '注意',
  progress: '进行中',
  report: '已完成',
  message: '提示',
}

/**
 * **退场四态**（2026-10-06；三态那版是 `devlog/351`）：
 * `queued`（不再活着、留在原位排队等放行）→ **`sliding`（在流内播滑出动画，**还占着**流内位置）**
 * → `leaving`（浮起来 = 交出流内位置，下面的条目这时才开始上移）→ 从 `rows` 里移除。
 *
 * ⚠️ 两个标记**同时在场**才是 `leaving`（`sliding` 从放行起一直挂到移除）：动画挂
 * `.is-sliding`、定位挂 `.is-out`，切的那一刻动画的计算值不变 ⇒ 不重启（见 `EXIT_YIELD_MS`）。
 *
 * ⚠️ `exitTop` / `exitH` 是**让位那一刻冻结的几何**（2026-10-05 修，`devlog/349`；
 * 2026-10-06 起冻结时刻从"放行"挪到"让位"—— 它在流内多待了 65% 的时间，位置可能被
 * 上面让位的行顶上来，放行时就冻会把它**钉在旧位置**上 ⇒ 浮起来那一下往下跳）：
 * 条目一让位就 `position:absolute` 钉在原位，而那个位置**必须在状态转换的那一拍
 * 量一次就冻住**。先前把它们放在一个**共享的 `floatPos` state** 里、由一条 effect 每帧补算
 * —— 那条链（`setFloatPos` → 重渲染 → 布局变 → 再补算）会互相点火，最终 React 报
 * **`Maximum update depth exceeded`**（用户实测：点「批量全部」直接白屏）；
 * 而且共享表在编排变化时会指向错位 ⇒ 条目上下跳。
 * 现在几何**跟着行走**（行删了，几何自然没意义），循环在结构上不可能发生。
 */
type Row = Notice & {
  /** **排队中**：已经不再"活着"，但还留在原位等人放它走（用户 2026-10-05 的"逐条滑出"） */
  queued?: boolean
  /** **滑出中**：放行了，动画在跑，但**仍在流内占位**（让位前的那 65%，用户 2026-10-06） */
  sliding?: boolean
  /** **已让位**：浮起来了（`position:absolute`），流内位置交给下面的条目 */
  leaving?: boolean
  /** 让位那一刻冻结的容器内 top（`position:absolute` 用它钉在原位） */
  exitTop?: number
  /** 让位那一刻冻结的高度（浮起来的那条仍要占原来那么高，否则文字会重排/换行） */
  exitH?: number
}

/** 一行的**布局几何**（`geomOf` 产出，见那里的注释：必须 transform-free） */
interface Geom {
  /** 它那个 `.si-list` 内的纵坐标（**滚动无关**，也不受面板整体移动影响） */
  relTop: number
  /** 边框盒高度 */
  h: number
}

/**
 * 退场队列的**放行顺序**：**从上到下**（组序 `GROUP_ORDER` + 组内 `compareInGroup`）。
 *
 * ⚠️ 与 `drawnGroups` 必须用**同一把尺子**（同一个 `compareInGroup`）：不一致的话
 * "第二条滑出去的"可能是屏幕上第三条，观感立刻就散了。
 * ⚠️ 是模块级纯函数而不是组件内的闭包：泵那条 effect 声明在渲染体里那些 `const` 之前，
 * 放在组件里会变成"先用后定义"（能跑，但读起来像有坑）。
 */
function queueOrder(rows: Row[]): Row[] {
  return GROUP_ORDER.flatMap((g) => rows
    .filter((r) => r.queued && groupOf(r) === g)
    .sort(compareInGroup))
}

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
  /** 有没有"会自己消失"的条目（决定要不要跑秒表）—— 走 `expiresAtOf`，别自己比 null */
  const hasExpiring = notices.some((n) => expiresAtOf(n) !== null)
  /** 隐藏到托盘（R18）：轮播停表 */
  const hidden = useShellHidden()

  /**
   * **FLIP**（First-Last-Invert-Play）：条目消失后让其余条目**有缓动地**顶上来
   * （用户 2026-10-05：「不要生硬地顶上来」）。
   *
   * 为什么必须用 FLIP（而不是给 `.si-item` 挂个 `transition` 就完事）：
   * 浏览器**不会**为"块级元素因为兄弟被删除而改变位置"做动画（那是一次普通重排）。
   * FLIP 的做法：① 每次提交后记下每条的布局（`snapshotGeom` → `geomRef`）；
   * ② 下一拍 DOM 变完，把每条**瞬时**挪回旧位置（反向 transform）；③ 下一帧撤掉
   * ⇒ CSS 过渡平滑送到新位置。全程只用 `transform`，不碰布局属性。
   *
   * ⚠️ **让位是"晚一拍"的**（用户 2026-10-06 口径反转，见 `EXIT_YIELD_MS`）：
   * 退场那条先**留在流内**把滑出动画播到 65%，**那时**才浮起来 —— 下面那些条目是
   * 在**那一刻**才上移的（FLIP 的起点也就是那一刻）。
   * 老口径（2026-10-05）是"当场浮起来 ⇒ 剩下的条目**同时**开始上移"，已被用户否掉。
   * ⚠️ 浮动坐标**跟着行走**（`Row.exitTop` / `exitH`，在**让位那一拍**量一次就冻住）——
   * 不放进共享 state。上一版就是那样：`setFloatPos` → 重渲染 → 布局变 → 再补算，
   * 互相点火到 React 报 `Maximum update depth exceeded`（用户点「批量全部」直接白屏）。
   */
  /**
   * **退场副本**：`leaving` 的行留在列表里播完动画才真删（否则 CSS 过渡没有机会播）。
   *
   * ⚠️ 这两个 state 需要在 FLIP 的 effect **之前**声明（它要读 `rows`）；
   *    真正的"过期判定"在下面那条体检 effect 里 —— 这里只放声明。
   */
  const [rows, setRows] = useState<Row[]>([])
  const liveIds = notices.map((n) => n.id).join('|')

  /**
   * 四拨人（都只由 `rows` 派生，声明放在最前面：下面几条 effect 都要读它们）：
   * - `queued`：不再活着、还在原位排队等放行；
   * - `sliding`：放行了、正在流内滑出（**位置还占着**，见 `EXIT_YIELD_MS`）；
   * - `leaving`：让位了（浮起来，流内位置已交出）；
   * - `exiting`：**面板里还要画的"已经不活着"的那些** = 上面三拨 + **刚被撤下/刚过期、
   *   这一拍还没被标记的**（那一拍是渲染先跑、effect 后跑留下的缝）。
   *
   * ⚠️ 判据只能是本地标记（`r.queued` / `r.sliding` / `r.leaving`），**不能**再叠一个
   * `!notices.some(...)`：`notices` 那份列表**不过滤过期**（过滤发生在渲染时）⇒ 刚过期的那条
   * **仍在 `notices` 里**，叠了那个条件就永远筛不出东西，退场动画一帧都看不到（第一版就是这么写的）。
   * ⚠️⚠️ 但**渲染**必须用 `exiting` 这个更宽的判据，而且两条来源都要认：
   * ① **被撤下**（点已读 / 服务端撤条目）—— 这种条目可能"还很新"（`isLive` 仍为真）；
   * ② **到点过期** —— 这种条目**还在 `notices` 里**（那份不过滤过期，过滤只在渲染时发生）。
   * 只看其中一条就会漏：漏了① 时，点「全部已读」的那一拍 `drawnGroups` 直接空掉 ⇒
   * **面板当拍卸载**，那串逐条滑出根本来不及播；漏了② 时，条目会有一拍不在 DOM 里，
   * 于是 FLIP 的布局快照缺了它 ⇒ 放行时量不到位置（`FREEZE msg-1 false`，只淡出、不滑出）。
   */
  /** `notices` 里还有哪些 id（"被撤下"与"过期"是两件事，见上面 `exiting`） */
  const noticeIds = new Set(notices.map((n) => n.id))
  const exiting = rows.filter((r) => r.queued || r.sliding || r.leaving
    || !noticeIds.has(r.id)          // 被撤下（已读 / 服务端撤条目）—— 它可能**还很"新"**
    || !isLive(r, now))              // 到点过期 —— 它**还在 `notices` 里**（那份不过滤过期）

  /**
   * 单条的几何：`relTop` = 它那个 `.si-list` 内的**布局**坐标（FLIP 的"顶上来"与退场浮起来都用它）、
   * `h` = 高度（浮起来时要占原来那么高）。
   *
   * ⚠️⚠️ **必须读 `offsetTop` / `offsetHeight`，不能读 `getBoundingClientRect()`**
   * （2026-10-05 实测踩到，用户报的"空白不被自动顶上去"的**真根因**）：
   * `getBoundingClientRect()` 给的是**视觉**位置 —— 它**包含正在跑的那次过渡的中间值**。
   * 而"补位"正是靠过渡做的：撤掉内联位移之后，元素在 `--motion-base` 那段时间里
   * 视觉上还在半路上（内联 `style.transform` 已经是空的，所以从 DOM 上看不出任何异常）。
   * 于是每隔一拍（`now` 秒表 / 轮询回来的重渲染）拍一次快照，量到的都是"它还在下面 70px"，
   * 下一拍就再补 70px ⇒ **过渡反复重启，那一条永远到不了位**（探针 `--notice-lab` 实测：
   * `offsetTop=6` 而 rect 给 76，差值恰好是退场那条的高度；+680ms 仍是 76）。
   * `offsetTop` / `offsetHeight` 是**布局**值，与 transform 无关 ⇒ 量到的永远是"该在哪"，
   * 补位一次到位、不会被自己的动画骗到。
   *
   * 为什么不用视口坐标：面板自己也会动（`place()` 量到真实高度后翻到上方、窗口缩放），
   * 那些位移**不是条目在列表里动了**，用视口坐标去补会把整个面板的内容也拖着"缓动"过去。
   */
  const geomOf = (el: HTMLElement): Geom => ({ relTop: el.offsetTop, h: el.offsetHeight })

  const snapshotGeom = (): Map<string, Geom> => {
    const map = new Map<string, Geom>()
    panelRef.current?.querySelectorAll<HTMLElement>('.si-item[data-notice-id]')
      .forEach((el) => {
        const id = el.getAttribute('data-notice-id')
        if (id) map.set(id, geomOf(el))
      })
    return map
  }

  /** 上一次提交结束时的布局（每拍由 FLIP 那条 effect 刷新）—— 让位几何**只能**从这里取 */
  const geomRef = useRef<Map<string, Geom>>(new Map())
  /** 退场队列泵的计时器句柄（**跨提交保留**：见那条 effect 的注释，重排一次就等于永不推进） */
  const pumpRef = useRef<number | null>(null)
  /** 已经放行的那几条各自的"**让位表**"（放行后 `EXIT_YIELD_MS` 才浮起来；每人一个，别共享） */
  const yieldTimers = useRef<Set<number>>(new Set())
  /** 已经开滑的那几条各自的"移除表"（各算各的 220ms，见泵里的注释） */
  const removalTimers = useRef<Set<number>>(new Set())

  /**
   * 一条通知**正要让位**时，把它"钉住"要用的几何（`position:absolute` 的 top / height）。
   *
   * ⚠️ 冻结时刻是**让位那一拍**（不是放行那一拍，2026-10-06 改）：它在流内多待了
   * `EXIT_YIELD_MS`（65% 的时长），这段时间里**上面的行可能先让位** ⇒ 它自己会被顶上去。
   * 放行时就冻的话，浮起来那一下会**跳回旧位置**（往下跳一整行）。
   *
   * ⚠️ 为什么只能从快照取：让位是 `setTimeout` 里发生的（不在提交里），此刻 DOM 上
   * 量的当然是"现在"，但那条的 `offsetTop` 会**含正在跑的补位过渡吗**？不会 ——
   * `geomOf` 用的是**布局**值（见那里的注释），与 transform 无关。
   * 取 `geomRef`（上一次提交结束时的快照）而不是现量，是为了与 FLIP 的"旧位置"**同一把尺子**：
   * 这份快照就是下面那些条目此刻的布局，量出来与它一致，浮起来那一下才不跳。
   * 量不到（快照里没它，例如面板就没开着）⇒ 交回 `{}`：那条**留在流内**，
   * 位置不完美，但白屏 / 错位 / 无限循环都不会发生。
   */
  const freezeExit = (n: Notice): Partial<Row> => {
    const g = geomRef.current.get(n.id)
    return g ? { exitTop: Math.round(g.relTop), exitH: Math.round(g.h) } : {}
  }

  // ⚠️ **故意不给依赖数组**：FLIP 要的就是"每次布局变化都拍一次照再补位"。
  //    加 `[]` 会让它只跑一次，加具体依赖会漏掉"最后一条被清掉"这类变化。
  //    同时它**每拍都刷新 `geomRef`** —— 那张快照既是下一拍的"旧位置"，
  //    也是让位那一拍唯一还能拿到那条坐标的地方（见 `freezeExit`）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const before = geomRef.current
    const root = panelRef.current
    if (!root) {
      // 面板没挂载（收起了）⇒ 快照清空：不清的话下次打开会拿"上一次那个面板"的坐标去补位，
      // 条目会先被拽到旧位置再飘回来。
      geomRef.current = new Map()
      return
    }
    root.querySelectorAll<HTMLElement>('.si-item[data-notice-id]').forEach((el) => {
      // 已让位那条**已经**脱离文档流并由 `exitTop` 钉住了（见 `renderRow`）：
      // 它不需要补位，补了反而会和冻结坐标打架 ⇒ 直接跳过。
      if (el.classList.contains('is-out')) return
      // ⚠️⚠️ **`.is-sliding`（还没让位、正在流内滑出的那条）恰恰相反：它必须被补位**
      // （2026-10-06 实测踩到）：它上面那条让位时，它在**布局**上会被顶上去一整行，
      // 而这一下若不给它缓动，它就**当场跳一行**（逐条退场时第三条最明显 ——
      // 它刚开滑、还几乎不透明，跳一下看得清清楚楚）。
      // 老写法跳它的理由是"动画占着 `transform`，补位写进去也会被动画覆盖"——
      // 那个前提现在**不成立**了：退场动画走的是**独立变换属性 `translate`**
      // （见 `status-island.css` 的 `si-item-out`），`transform` 空着给 FLIP，
      // 两者在 CSS 里是**合成**关系而不是互相覆盖。改成跳它反而会把这个跳变请回来。
      const old = before.get(el.getAttribute('data-notice-id') || '')
      if (!old) return
      const dy = old.relTop - geomOf(el).relTop
      if (Math.abs(dy) < 0.5) return
      // ── **同步 FLIP**（2026-10-05 第二版）────────────────────────────────
      // ① 关掉过渡、瞬时挪回旧位置；② **强制一次样式计算**（读 `offsetHeight`）——
      //    这一步是全部关键：它让"反向位移"成为**已计算的样式**，也就是过渡的起点；
      // ③ 当场恢复过渡并撤掉位移 ⇒ 浏览器从旧位置**平滑**送到新位置。
      //
      // ⚠️ 为什么不用"下一帧再撤"（`requestAnimationFrame`）那套经典写法：
      //    位移会在 DOM 上**跨帧存在**，于是①点已读那种"几毫秒内连着两次提交"会把 rAF
      //    取消掉，位移**永久卡住**（用户报的"滑出正常，但留下的空白不被自动顶上去"）；
      //    ②任何一次"量位置"都可能撞上这份位移，得靠 `data-flip-y` 记账去减 ——
      //    记账一旦对不上就正负翻转、条目越补越偏（探针实测：同一条在 +80ms 是
      //    `translateY(139.5px)`、+680ms 变成 `-139.5px`）。同步做法**不留任何跨帧状态**，
      //    这两类问题从结构上不存在。
      el.style.transition = 'none'
      el.style.transform = `translateY(${dy}px)`
      void el.offsetHeight
      el.style.transition = ''
      el.style.transform = ''
    })
    // 快照在**补位之后**拍：此时每条的位移都已经撤掉，量到的就是这一拍的最终布局。
    geomRef.current = snapshotGeom()
  })
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
  // 做法：本地留一份副本，动画放完（`ITEM_EXIT_MS`）再真正移除。
  //
  // ⚠️ **过期判定必须自己按时间做**（不能用 `notices` 的变化当触发器）：
  //    `useNotices` 那份列表**不过滤过期**（过滤发生在渲染时），所以"到点了"这件事
  //    不改变 `notices` —— 挂在上面的 effect 一辈子不会为它跑（第一版就是这么写的，
  //    症状是条目**永远留在 rows 里**、滑出动画只在"服务端撤条目"时才播）。
  // ⚠️ 判据（`.si-item` 的条数）仍按**活着的**条目算 —— 探针不看动画中间态。
  //（`rows` / `liveIds` 的**声明**为了 FLIP 读得到，已经上移到那段 effect 之前）
  //
  // ── 四态：活着 → **排队（`queued`）** → **滑出（`sliding`）** → 让位（`leaving`）──────
  // 前两态是用户 2026-10-05 的口径：「全部已读的效果应该是从上到下一条一条逐个滑出，
  // 而不是现在这样一下全部滑出然后瞬间顶上去」。所以"不再活着"与"开始滑出"**拆成两件事**：
  //   ① 不再活着 ⇒ 进**队列**（人还留在原位、照常渲染，只是不再参与"活着"的判据）；
  //   ② 队列按**从上到下**的顺序、每 `ACK_STAGGER_MS` 放一条出去开始滑。
  // 后两态是用户 2026-10-06 的口径反转：「让上一条已读滑出 60%–80% 之后，下面的条目再顶上去」
  // ⇒ 放行只是**开始滑**（人仍在流内、位置还占着），滑到 `EXIT_YIELD_AT` 才让位（见 `EXIT_YIELD_MS`）。
  // 为什么必须留在原位排队、而不能"先标记退场、只是把动画延后"：退场那条**让位之后**是
  // `position:absolute`（流内位置从那一刻空出）⇒ 一次全标就是"整块瞬间塌上去"，
  // 那正是用户不要的观感。留在流里排队，下面那几条才会**跟着每一条的离开逐段上移**。

  useLayoutEffect(() => {
    setRows((prev) => {
      const fresh = new Map(notices.map((n) => [n.id, n]))
      const next: Row[] = []
      for (const r of prev) {
        const hit = fresh.get(r.id)
        // 又活过来了（例如同 id 的服务端条目回到列表）：队列/滑出/让位标记**一起**撤掉
        // （三个都要撤：`sliding` 是"动画在跑"的判据，留着它这条就永远不再参与体检）
        if (hit) { next.push({ ...hit, queued: false, sliding: false, leaving: false }); fresh.delete(r.id) }
        else if (!r.queued && !r.sliding && !r.leaving) next.push({ ...r, queued: true })  // 服务端撤了 ⇒ 排队
        else next.push(r)                                                   // 已在队列/滑出/让位：不动
      }
      for (const n of fresh.values()) next.push({ ...n, queued: false, sliding: false, leaving: false })
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIds])

  /** 定时体检：**过期**（TTL 到点）的条目在这里被判出局、进队列。
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
   *
   *  ⚠️⚠️⚠️ **`return prev` 还不够**（2026-10-06，`devlog/357`）：`now` 是**墙上时钟**派生的
   *  （`Math.max(nowProp, Date.now())`）⇒ 只要两次渲染之间过了 1ms，依赖就变了、这条 effect
   *  就会再跑一次，**再调一次 `setRows`**。而"在 commit 阶段调度更新"这件事本身
   *  会被 React 计进 `nestedUpdateCount` —— 攒够 50 次就 `Maximum update depth exceeded`，
   *  **即使每次 updater 都返回同一个引用**（bail-out 也救不了）。
   *  探针跑在**虚拟时间**下（时钟随每一拍往前跳）时这条环必炸：
   *  `ui_probe --notice-lab` 实测 600+ 次渲染、整棵树被 `ErrorBoundary` 重建。
   *  ⇒ 修法：**先自己判"有没有要改的"，没有就一次 `setState` 都不调**。
   */
  useLayoutEffect(() => {
    // 过期判定先在这里做一遍（下面那个 updater 里还会做，两处必须是同一条 `isLive`）
    // ⚠️ `sliding`（正在滑出、还没让位）也要排除：它**已经不在队列里**了，
    //    不排除就会被再标一次 `queued` ⇒ 同一条被放行两次（滑一半重新开始滑）。
    const stale = rows.some((r) => !r.queued && !r.sliding && !r.leaving && !isLive(r, now))
    if (!stale) return                       // 没东西到点 ⇒ 不碰状态（别拿 bail-out 当刹车）
    setRows((prev) => {
      let changed = false
      const next = prev.map((r): Row => {
        if (r.queued || r.sliding || r.leaving || isLive(r, now)) return r
        changed = true
        return { ...r, queued: true }        // 到点 ⇒ 排队（等队首那条先走）
      })
      return changed ? next : prev
    })
  }, [now, rows])

  /**
   * **退场队列的泵**：每 `ACK_STAGGER_MS` 放**队首（看得见的最上面那条）**出去开始滑。
   *
   * 为什么队首是"最上面那条"而不是"最先到期的"：用户要的观感是
   * 「从上到下一条一条逐个滑出」—— 与眼睛看到的顺序一致才不会觉得是乱的。
   *
   * ⚠️ `queueOrder` 的顺序口径与 `drawnGroups` **同一把尺子**（组序 + `compareInGroup`），
   *    否则"第二条滑的"可能是屏幕上第三条（观感立刻就散了）。
   * ⚠️ 队首**不计延迟**（没人正在滑时当拍就走）：点单条已读必须跟手，
   *    这里多一个 70ms 的等待用户立刻能感觉到。
   *
   * ⚠️⚠️ **计时器要跨提交活着**（2026-10-05 实测踩到）：本 effect 依赖 `rows`，而排队期间
   *    `rows` 每几十毫秒就变一次（`setCountPopped`、空闲轮播取时钟、上一条开始滑……）——
   *    若照常规写法"每次重跑都 `clearTimeout` 再排一个新的"，那么只要提交比 70ms 密，
   *    **队首永远轮不到**（实测日志：`PUMP wait 70 m2` → `PUMP cancel m2` → `wait m3` → …）。
   *    所以：已经排好就直接返回（不重排），只在"队列空/刚放行一条"时才重新起表。
   */
  useLayoutEffect(() => {
    if (pumpRef.current != null) return                    // 已经排好了 —— 别把它取消掉
    const queue = queueOrder(rows)
    if (queue.length === 0) return
    const first = queue[0]
    const start = () => {
      pumpRef.current = null
      // ① 放行 = **只开始滑**（`sliding`）：人还留在流里、位置还占着，
      //    **不冻几何**（见 `freezeExit`：它在流内还要待 `EXIT_YIELD_MS`，
      //    这段时间里可能被上面让位的行顶上去 ⇒ 现在冻下来的坐标会偏）。
      setRows((prev) => prev.map((r) => (r.id === first.id
        ? { ...r, queued: false, sliding: true } : r)))
      // ② **让位表**（每条各自一个，见下一条注释）：滑到 `EXIT_YIELD_AT` 才浮起来
      //    —— 那一刻几何才冻（读 `geomRef` 的**布局**快照），下面那些条目也是**那一刻**
      //    才开始上移（用户 2026-10-06 的口径）。
      //    ⚠️ 条件带 `r.sliding`：万一这条又活过来了（同 id 回到 `notices`，
      //    上面那条 effect 会把三个标记都撤掉），不许再把它浮起来。
      const y = window.setTimeout(() => {
        yieldTimers.current.delete(y)
        const geom = freezeExit(first)
        setRows((prev) => prev.map((r) => (r.id === first.id && r.sliding
          ? { ...r, leaving: true, ...geom } : r)))
      }, EXIT_YIELD_MS)
      yieldTimers.current.add(y)
      // ③ **移除表**（同样每条一个）：**总时长不变** —— 仍从**放行**那一刻起算
      //    `ITEM_EXIT_MS`（让位只是把"腾出位置"往后挪，不延长它待在屏幕上的时间）。
      // ⚠️ **每一条自己的移除表**（而不是一条共享的）：队列逐条放行时，共享表会被
      //    后面的放行一次次重排（`rows` 每 70ms 变一次）⇒ 表越推越晚、先滑完的那几条
      //    一直留在 DOM 里。各算各的才与"它自己那 220ms"对齐。
      //    ⚠️ 过滤条件带上 `sliding`/`leaving`：万一这条又活过来了，不许把它删掉。
      const t = window.setTimeout(() => {
        removalTimers.current.delete(t)
        setRows((prev) => prev.filter((r) => r.id !== first.id || (!r.sliding && !r.leaving)))
      }, ITEM_EXIT_MS)
      removalTimers.current.add(t)
    }
    // ⚠️ 判据必须**带上 `sliding`**（2026-10-06）：放行后那条在 `EXIT_YIELD_MS` 里一直是
    //    `sliding` 而不是 `leaving`，只看 `leaving` 的话这条 effect 会判定"没人正在滑"
    //    ⇒ 队列里剩下的每一条都**当拍**跟着走，70ms 的逐条节奏整个没了。
    if (!rows.some((r) => r.sliding || r.leaving)) { start(); return }   // 没人正在滑 ⇒ 当拍就走
    pumpRef.current = window.setTimeout(start, ACK_STAGGER_MS)
  }, [rows])

  /** 卸载时收掉泵、各条的让位表与移除表（不然它们会在组件没了之后还去 `setRows`） */
  useEffect(() => () => {
    if (pumpRef.current != null) window.clearTimeout(pumpRef.current)
    yieldTimers.current.forEach((t) => window.clearTimeout(t))
    yieldTimers.current.clear()
    removalTimers.current.forEach((t) => window.clearTimeout(t))
    removalTimers.current.clear()
  }, [])

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

  // 条目清空（例如瞬时消息过期后没有别的事）→ 面板自己收起，别留个空面板。
  // ⚠️ **排队中/正在滑的那几条也算"还有东西"**（2026-10-05）：不算的话，点「全部已读」
  //    把最后几条清掉时面板会**当场消失**，用户根本看不到那串逐条滑出（他要的正是这个观感）。
  //    判据用 `exiting`（而不是 queued/leaving 两个标记）：被撤下的那一拍标记还没打上，
  //    只看标记会在那一拍就收起面板。
  useEffect(() => {
    if (open && !primary && exiting.length === 0) {
      setOpen(false)
      setPinned(false)
    }
  }, [open, primary, exiting.length])

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
  //
  // ⚠️ 这一块从"依赖 `notices.length`"到"依赖 `shownCount`"来回改过一次（2026-10-06，
  //    `devlog/357`）：`shownCount` 含 `now` ⇒ 每渲染都可能变 ⇒ 布局 effect 里 setState
  //    自激（26 条用例一起红是 TDZ，探针那次是无限更新）。**触发只能用输入派生的量**。

  /** 胶囊左侧：会自动消失时给一个剩余比例（画环），否则保持原来的实心点 */
  const disc = discFraction(primary, now)

  /** 面板里每一条的渲染（`sliding` 走滑出动画；`leaving` 才是浮起来的那条） */
  const renderRow = (n: Row) => {
    const frac = countdownFraction(n, now)
    const relFor = relTimeFor(n, now)
    const canAck = n.form !== 'state'          // 状态类不给点已读（见 `ackAllIds` 的注释）
    /**
     * **让位**（`leaving` + 几何已冻）：脱离文档流、钉在冻结坐标上。
     *
     * ⚠️ `position` / `left` / `right` 在 CSS 的 **`.si-item.is-out`** 里（"让位"这件事的
     * 唯一落点），这里只给**每条自己的数据** `top` / `height`（冻结值，CSS 里写不了）。
     * 这么分是因为**类名与动画必须错开**：动画挂在 `.is-sliding`（放行起一直在），
     * `.is-out` 只在让位那一刻加上 ⇒ 这一拍动画的**计算值没变**，不会重新播放
     * （见 `EXIT_YIELD_MS` 的注释；两个类同时在场是硬要求）。
     *
     * ⚠️ 量不到坐标时（快照里没有它，例如面板当时没开着）**就留在流内**（连 `is-out` 都不加）：
     * 位置不完美，但白屏 / 错位 / 跳到别处都不会发生。
     */
    const float = n.leaving && n.exitTop !== undefined
      ? { top: n.exitTop, height: n.exitH }
      : undefined
    return (
      <li
        key={n.id}
        className={`si-item${n.sliding ? ' is-sliding' : ''}`
          + `${n.leaving && n.exitTop !== undefined ? ' is-out' : ''}`
          + `${canAck ? ' can-ack' : ''}`}
        data-kind={n.kind}
        data-form={n.form ?? 'state'}
        data-notice-id={n.id}
        data-left={frac === null ? undefined : frac.toFixed(3)}
        style={float}
        /* 单击正文/空白 = 已读（用户 2026-10-05）。
           ⚠️ 动作按钮**不算**已读（它自己 `stopPropagation`）：那是"我要去看一眼"，
           顺手把通知消掉会让人回头找不到（例如受限项要反复对照）。
           ⚠️ `sliding` 起就不再接受点击（与 CSS 的 `pointer-events:none` 同一口径）：
           否则"滑出中再点一下"会在动画里又触发一次已读。 */
        onClick={canAck && !n.sliding && !n.leaving ? () => onAction('dismiss', n) : undefined}
      >
        <span className={`si-item-icon k-${n.kind}`}>{iconFor(n)}</span>
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
            onClick={(ev) => {
              ev.stopPropagation()             // 动作与"已读"分开（见上面 `onClick` 的注释）
              onAction(n.action!.kind, n)
            }}
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

  /**
   * 把某一组渲染成 `<li>` 列表，**排队/滑出/让位中的条目留在它原来的位置**（用户 2026-10-05）。
   *
   * 为什么不再单独挂到 `.si-list-leaving`：那会让退场条目**跳到整列最下面**
   * （它是另一个 `<ul>`），观感是"这条跑到别处去了"。留在原位才是"从这条的位置滑出去"，
   * 也才谈得上"下面的条目顶上来"。
   */
  const renderRows = (rowsToDraw: Row[]) =>
    rowsToDraw.map((n) => renderRow(rowsById.get(n.id) ?? n))

  /**
   * 面板里**要画的组**：**三组标题常驻**（用户 2026-10-05 第二次反馈）。
   *
   * 原来那版是"空组不渲染"（L1 的清爽口径），但用户实测下来两个问题：
   * 「栏目头标题……所有条目都已读了就会直接消失，但是直接消失太突兀了也会让连续已读的节奏卡顿，
   * 我觉得直接就别消失了，常驻标题头」⇒ 改成**恒画三组**，空的那组就是「最近（0）」，
   * 样式不做区分（用户选的口径：不引入第二种样子）。
   * 这也顺手补齐了另一件事：条目一条条退出时，**组头不会跟着跳/消失**（布局稳定）。
   *
   * ⚠️ 不能直接 `sections.map`：一条告知类过期后就不再 `isLive`，于是**它那组可能整组都不在
   * `sections` 里** —— 那一组一次都不会渲染，退场那条**直接消失**（没有滑出动画）。
   * 第一版撞在这里（用例红过一次，DOM 里连 `.si-item.is-out` 都没有）。
   *
   * ⚠️ 补成"**同一组、同一个 `<ul>`**"而不是另挂一个兜底容器（2026-10-05 修）：退场条目浮起来
   * 用的坐标（`exitTop`）**是相对它原来那个 `<ul>` 量的**，换个容器就整体错位
   * （整组只剩它一条时最明显 —— 兜底容器在面板最下面）。
   *
   * ⚠️ 四拨人（活着的 / 排队中 / 滑出中 / 已让位）**必须按同一把尺子重排**（`compareInGroup`）：
   * 后面三拨已经**不是 live**、不再参与 `sectionNotices` 的排序，若不重排就会掉到
   * 组末尾 —— 观感是"点了全部已读，下面几条先跳个位置才开始滑"。这把尺子与
   * `sectionNotices` 用的是同一个导出函数（改一处即两处，不许各写一份）。
   */
  const drawnGroups = GROUP_ORDER.map((group) => {
    const s = sections.find((x) => x.group === group)
    const live: Row[] = s ? s.items : []
    const liveIds = new Set(live.map((n) => n.id))
    const mine = exiting.filter((r) => groupOf(r) === group && !liveIds.has(r.id))
    const rows = [...live, ...mine].sort(compareInGroup)
    return { group, label: s?.label ?? GROUP_LABEL[group], rows }
  })

  const rowsById = new Map(rows.map((r) => [r.id, r]))
  const ackAll = ackAllIds(notices, now)
  /**
   * **计数 = 画出来的条数**（2026-10-06，`devlog/357`）。
   *
   * 用户现场：`通知（2）` 而屏幕上只有 1 条（点完全量拉取第三方数据之后）。
   * 两处计数原先都写 `notices.length` —— 那是**合并后的原始数组**，
   * 里面有"已经过期、等下一轮轮询才消失"的条目，也有（修好 `isLive` 之前）
   * 被误判过期而不画的服务端状态条目 ⇒ 数字与眼睛对不上。
   * 现在统一取 `drawnGroups` 的行数（活着的 + 排队/正在滑出的 ——
   * 后者还在屏幕上，所以必须算，见组标题那条注释）。
   */
  const shownCount = drawnGroups.reduce((sum, g) => sum + g.rows.length, 0)
  /**
   * 徽章"弹一下"的**触发器**：`notices.length`（**只由输入决定，与时间无关**）。
   *
   * ⚠️⚠️ **不许换成 `shownCount` 或"活着的条数"**（2026-10-06 实测踩到两次，`devlog/357`）：
   * 它们都含 `now`（`exiting` 按 `isLive(r, now)` 判、`liveNotices` 同理），而 `now` 是
   * `Math.max(nowProp, Date.now())` —— **每渲染一次就可能往前走一格**。
   * 于是"渲染 → 依赖变了 → 布局 effect 里 setState → 再渲染 → 依赖又变了"，
   * 直接 `Maximum update depth exceeded`（`ui_probe --notice-lab` 抓到：整棵树被
   * `ErrorBoundary` 重建，顶栏连它的 dev 口一起消失，后面读什么都是空）。
   * 探针跑在**虚拟时间**下，这条环尤其致命（时钟随渲染飞速前进）。
   * 计数**显示**用 `shownCount`（那是渲染，不进依赖），这里只负责"变没变过"。
   */
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
  /**
   * 面板**是不是真的没东西可画了**（连正在滑的都没有）。
   *
   * ⚠️ 判据不能再是"`drawnGroups` 空"（三组标题现在恒在）。它就是"面板要不要挂载"的闸门：
   * 清空最后几条时**必须等那串逐条滑完**再收（`devlog/351` 的教训）。
   */
  const showEmpty = !primary && exiting.length === 0

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
        /* 胶囊上那句话**是哪一条**（2026-10-05，`devlog/354`）：探针要靠它区分
           "任务占了顶栏"（要红）与"常驻事实亮着"（按设计，用户得能看见）——
           例如小红书 cookie 失效 ⇒「有 1 项功能当前受限」，那条**就该一直亮着**。 */
        data-headline-id={lit && primary ? primary.id : undefined}
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
        {lit && shownCount > 1 &&
          <span className={`si-count${countPopped ? ' is-out' : ''}`}>{shownCount}</span>}
        {lit && <ChevronDown className="si-chevron size-[12px]" />}
      </span>

      {/* ⚠️ 挂载条件：`primary || !showEmpty`（2026-10-05）—— 点「全部已读」之后一条 live 都不剩，
          而**排队/正在滑的那几条还要播完**（用户要的"逐条滑出"）—— 只看 `primary` 会让面板
          当拍卸载，动画一帧都看不到。`showEmpty` 才是"真的连正在滑的都没有了"。 */}
      {open && pos && !showEmpty &&
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
              <span className="si-panel-title">通知（{shownCount}）</span>
              {/* 右上角原来是"能力矩阵"那句来源提示（`href`）—— 用户 2026-10-05 让位给
                  「全部已读」：那行字只是说"这句话是谁说的"，而面板里**每条都自带来源标注**
                  （`.si-item-meta` 的「注意 · 能力矩阵 · …」），重复且占着最顺手的位置。
                  按钮清的范围见 `ackAllIds`：**会自动过期的 + 需要处理的**，「正在进行」不动。 */}
              {ackAll.length > 0 && (
                <button
                  type="button"
                  className="si-panel-ack"
                  data-ack-all="1"
                  title="把「最近」与「需要处理」里的一次都清掉（正在进行的那些不动）"
                  onClick={() => onAction('ack-all' as NoticeActionKind, notices[0])}
                >
                  全部已读
                </button>
              )}
            </div>
            <OverlayScroll className="si-panel-scroll">
              {/* ⚠️ 这里**没有**"现在没有需要你知道的事"那条空态分支了（2026-10-05）：
                  三组标题常驻 ⇒ "空"的表现就是三个（0），而**真的什么都没有**时面板根本不会挂载
                  （见上面 `!showEmpty` 那道闸门）—— 那条分支成了永远到不了的死代码。
                  段落样式 `.si-empty` 随之删除（CSS 里也删了，别留没人用的类）。 */}
              <div className="si-secs">
                {drawnGroups.map((s) => (
                  <section className="si-sec" data-group={s.group} key={s.group}>
                    <h4 className="si-sec-title">
                      {/* 计数按**画出来的**条数（= 活着的 + 排队中 + 正在滑出的）：队列/退场那几百毫秒里
                          它们还在屏幕上，写 `s.items.length` 会显示"最近（0）"而下面明明有一条。 */}
                      {s.label}（{s.rows.length}）
                    </h4>
                    {/* ⚠️ `position: relative` 是退场条目浮起来用的坐标系（`exitTop` 相对它量） */}
                    <ul className="si-list" style={{ position: 'relative' }}>
                      {renderRows(s.rows)}
                    </ul>
                  </section>
                ))}
              </div>
            </OverlayScroll>
            <div className="si-panel-foot">
              <span className="si-panel-order">
                最近发生的在最上面 · 点一条即可已读（向左滑出）
              </span>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

export type { NoticeGroup }
