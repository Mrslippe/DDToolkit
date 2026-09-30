import { useEffect, useRef, useState } from 'react'

import StatusIsland from './StatusIsland'
import type { Notice, NoticeActionKind } from '../utils/notificationHub'
import { useNotices } from '../utils/noticeStream'
import { api } from '../api/api'
import { EVENTS, on } from '../utils/appEvents'
import {
  WIDGET_CAP_MIN_W,
  WIDGET_POS_KEY,
  WIDGET_RESIZE_DEADBAND,
  WIDGET_SHADOW_PAD,
  clampCapsuleW,
  relayWidgetAction,
  saveWidgetPos,
  widgetCapsuleGeom,
  widgetCollapseGeom,
  widgetExpandGeom,
  widgetPanelMaxHeight,
} from '../utils/widgetWindow'
import type { WidgetAlign, WidgetDir } from '../utils/widgetWindow'

/**
 * 桌面状态控件小窗（R38 批 5b，规格 §7/§8）。由 `?widget=1` 挂载。
 *
 * ## 它现在**自己取数**（M5-2b，devlog/259）
 *
 * 改造前小窗是**纯显示**的：六个信息源全在主窗口的 `TopBar` 里，主窗口用 Tauri 事件
 * 把汇总结果推过来 —— 代价是**主窗口不在（没开 / 关掉了）小窗就永远是空的**。
 * M4 拆了一半（自己订阅推送），M5-2b 拆干净：
 *
 * | 来源 | 覆盖的事实 | 主窗口不在时 |
 * |---|---|---|
 * | **后端通知汇总**（`GET /vtuber/notices`，3s 一条轻链） | 登录失效 / 风控冷却 / 完成报告 / 抓取进度 i/N | ✅ 仍然到 |
 * | **自己订阅推送**（`useNotices` 内部 `startMessageBus`） | 开播边沿 / 任务已受理 / 操作完成 | ✅ 仍然到 |
 *
 * ⇒ **两扇窗各自向后端要同一份数据**（同一条端点、同一个 hook、同一套合并规则），
 * 不再有"谁替谁取数"的依赖。那条广播（`widget:notices`）与它的 emit 点都已删除。
 *
 * 面板里的动作（"去登录"/"查看详情"）**仍然只有主窗口做得了**（登录浮窗 / 报告对话框
 * 都在主窗口）—— 小窗把点击**转回去**（`widget:action`，`relayWidgetAction`）。
 *
 * > 规格 §8 那个 `useStatusIsland()` 仍然不抽：两扇窗的**宿主差异**（尺寸/材质/拖动/
 * > 动作回传）比共性大，抽出来只会变成一个到处是分支的组件。共用的是**取数与合并**
 * > （`utils/noticeStream.ts::useNotices`），那才是真正重复的那部分。
 *
 * ## 拖动：不能用 `data-tauri-drag-region`
 *
 * 那个属性在 **mousedown** 就调 `startDragging()`，于是"点一下打开面板"永远收不到点击
 * （整个控件 200×40 全是可交互面，没有"空白把手"可用 —— 主窗口那边是拿
 * `.topbar-spacer` 那块空地做的）。改成**指针位移过阈值才拖**：
 * 没动就是点击，动了才是拖窗口。
 */

/** 超过这个位移才算"在拖窗口"，否则算点击（`4px` 是常见的"手抖"容差） */
const DRAG_THRESHOLD_PX = 4

/**
 * 读当前窗口矩形（**逻辑像素**口径，与 Rust 侧的 `LogicalSize`/`LogicalPosition` 一致）。
 *
 * 提到模块级而不是写在某个 effect 里：D1 起**两条**通路都要它
 * （展开/收起那条；以及"内容变宽 ⇒ 折叠态窗口要跟上"那条 `ResizeObserver`）。
 */
async function readWidgetRect(): Promise<{ x: number; y: number; w: number; h: number }> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const w = getCurrentWindow()
  const size = await w.innerSize()
  const pos = await w.outerPosition()
  const sc = await w.scaleFactor()
  return {
    x: Math.round(pos.x / sc), y: Math.round(pos.y / sc),
    w: Math.round(size.width / sc), h: Math.round(size.height / sc),
  }
}

/** 当前所在显示器的尺寸（px）—— `currentMonitor()` 而不是主显示器：小窗可以被拖到副屏 */
async function readScreenBox(): Promise<{ width: number; height: number }> {
  const { currentMonitor } = await import('@tauri-apps/api/window')
  const mon = await currentMonitor()
  const sc = mon?.scaleFactor ?? 1
  return {
    width: Math.round((mon?.size.width ?? 1920) / sc),
    height: Math.round((mon?.size.height ?? 1080) / sc),
  }
}

/**
 * 量胶囊的宽（**折叠态窗口就该是这么宽**）。
 *
 * ⚠️ 用 `offsetWidth`（**布局**宽）而不是 `getBoundingClientRect()`：胶囊有可能正处在
 * 宽度过渡里（`calc-size(max-content, size)` 是可过渡的），rect 会量到中间帧的宽
 * ⇒ 窗口跟着抖。`offsetWidth` 取的是布局结果，稳定。
 *
 * ⚠️ 胶囊的宽**与窗口宽无关**（`max-content` + min/max-width）⇒ 这里读它**不构成
 * 自指循环**：`widgetPanelMaxHeight` 那条注释记过三次"按窗口算"的循环，这是第四次
 * 躲开它的办法 —— **让被量的东西不受结果影响**。
 */
function readCapsuleW(): number {
  const el = document.querySelector<HTMLElement>('.si-island')
  // ⚠️ F1 之后**展开时胶囊是隐藏的**（`display:none` ⇒ `offsetWidth = 0`）——
  //    所以展开/收起路径一律读下面那个"最近一次量到的宽"（`lastCapW`），
  //    这个函数只负责"现在能读到就读"。
  return clampCapsuleW(el?.offsetWidth ?? 0)
}

/**
 * **dev-only**：小窗里那条白色自检条的开关（`localStorage` 键）。
 *
 * ⚠️ 它默认**关**（2026-09-30 用户：「先把白色的 log 文字条去掉」）：
 * 那条 9px 白底自检条画在窗口左上角、压着胶囊 —— 用户看到的是一块白字条。
 * 但它是**真机上唯一的诊断通道**（小窗不能开 devtools、看不到 console，
 * devlog/178/180 那九轮真机修复全靠它），所以**留代码、改开关**：
 * 在主窗口的控制台执行 `localStorage.setItem('ddtoolkit.widget-diag','1')` 后重开小窗即可。
 */
export const WIDGET_DIAG_KEY = 'ddtoolkit.widget-diag'

/**
 * **dev-only**：探针往小窗注入条目的页面事件名。
 *
 * 为什么需要它：探针跑在无头浏览器里 —— 既不连推送通道、后端也没有它要的条目
 * ⇒ 小窗**永远是空闲态**（`lit=false` ⇒ hover 不展开 ⇒ 面板永远量不到）。
 * 于是"面板在小窗里能不能用"这条判据会**空转**（永远没有面板可量）。
 *
 * 与 `--status-island` 用 `ddtoolkit:pill-message` 是同一套思路：
 * 走**页面自己的事件源**，而不是直接改 React state。
 * 生产构建里 `import.meta.env.DEV` 为 false ⇒ 整段被摇掉。
 */
export const WIDGET_SEED_NOTICES_EVENT = EVENTS.widgetSeed

export default function StatusWidgetWindow() {
  const [now, setNow] = useState(() => Date.now())
  /**
   * 服务端那份通知列表（M5-2b，devlog/259）：**主窗口在不在都一样**。
   *
   * ⚠️ `widget:notices` 广播**已退役** —— 它当年的职责（"轮询类的事实由主窗口替小窗取"）
   * 现在由后端承担，而它的代价（主窗口不在 ⇒ 小窗永远是空的）也随之消失。
   * 本地覆盖（推送来的进度/瞬时消息、dev 注入）在 `useNotices` 里合并。
   */
  const [serverNotices, setServerNotices] = useState<Notice[] | null>(null)
  /** dev-only 注入的条目（探针用；生产构建里恒为空数组） */
  const [seeded, setSeeded] = useState<Notice[] | null>(null)
  const notices = useNotices(now, { server: serverNotices, extraLocal: seeded ?? undefined })

  // 自己拉服务端列表：3s 一条轻链（小窗只有一个胶囊，没必要跟主窗口那条 3/10s 自适应）。
  // ⚠️ 隐藏/最小化**不**停链：小窗本来就是"主窗口收进托盘时唯一能看的东西"（R18 立的规矩）。
  useEffect(() => {
    let stop = false
    const tick = async () => {
      try {
        const nb = await api.getNotices()
        if (!stop) setServerNotices(nb.notices)
      } catch {
        /* 后端不可达时保持上一份 */
      }
    }
    void tick()
    const t = window.setInterval(tick, 3000)
    return () => { stop = true; window.clearInterval(t) }
  }, [])
  const down = useRef<{ x: number; y: number; dragging: boolean } | null>(null)
  const [diag, setDiag] = useState('…')
  /** 是否画那条 dev 自检条（见下面那条 effect 的注释；默认关） */
  const [showDiag] = useState(
    () => import.meta.env.DEV &&
      globalThis.localStorage?.getItem(WIDGET_DIAG_KEY) === '1',
  )
  /**
   * 窗口当前是展开态吗（R38 批 5d）。用来**去重** resize 调用 ——
   * 面板每次重渲染都调一次 resize 会让窗口持续抖动（Windows 的 resize 是可见的）。
   */
  const expanded = useRef(false)
  /**
   * **最近一次量到的胶囊宽**。
   *
   * ⚠️ F1（2026-09-30）之后它成了必需：展开时胶囊是 `display:none` ⇒ `offsetWidth` 读回 0，
   * 而收起路径需要知道"卡片该多宽"。由上面那条 `ResizeObserver` 维护（折叠态每帧都量得到）。
   */
  const lastCapW = useRef<number>(WIDGET_CAP_MIN_W)
  /**
   * 展开**之前**胶囊所在的矩形（收起时精确回到这里）。
   *
   * ⚠️ 为什么要存而不是反推：贴屏幕边的窗口展开时会**被夹**（200→400 宽必须收回来，
   * 否则面板出屏），于是"展开矩形的中心"已经不是原来那个中心了 —— 反推回去会越来越偏，
   * 每次悬停漂几十像素，久了小窗就爬走了。有单测守这条（`反复展开/收起不漂移`）。
   * ⚠️ D1 起连**宽**一起存：内容在展开期间可能变（方案 A），只回位置会让胶囊中心漂掉。
   */
  const preExpandPos = useRef<{ x: number; y: number; w: number } | null>(null)
  /**
   * 面板往哪一边长（D1 四方向）—— 决定 `.widget-shell` 的 `data-dir` 与胶囊的纵向偏移。
   *
   * ⚠️ **同一份事实必须同时存在于 ref 与 state**（2026-09-24 eslint 逼出来的）：
   * `sync()` 跑在一个 `[]` 依赖的 effect 里 ⇒ 它**闭包捕获的是首次渲染的 `dir`**
   * （恒为 `'down'`）。收起时若直接读 state，无论展开时朝哪边，都会按"向下"去算位置。
   * 所以逻辑一律读 ref，state 只负责渲染。
   */
  const dirRef = useRef<WidgetDir>('down')
  const [dir, setDir] = useState<WidgetDir>('down')
  /** 横向：面板往左/居中/往右长（几何给的，探针与文档读它；渲染只用到胶囊偏移） */
  const [align, setAlign] = useState<WidgetAlign>('center')

  // ① **dev-only 的注入通路**（R38 批 5d，M5-2b 起注入的是"本地覆盖"那一层）：
  //    探针（无头浏览器）里没有推送也没有后端条目，于是小窗**永远是空闲态**
  //    （没有条目 ⇒ `lit=false` ⇒ hover 不展开、面板永远量不到），
  //    而"面板在小窗里到底能不能用"正是那个真 bug 的判据 —— 不注入就永远空转。
  //    走的是**页面自己的事件**（不是直接改 React state），与 `--status-island` 同款做法。
  //    生产构建里 `import.meta.env.DEV` 为 false ⇒ 整段被摇掉。
  //
  //    ⚠️ 它现在与"服务端列表"合并在 `useNotices` 里（`extraLocal`）—— 注入的条目**不进
  //    服务端列表**，所以判据量到的仍是"面板能画出来"，与后端供数互不干扰。
  useEffect(() => {
    if (!import.meta.env.DEV) return
    return on(EVENTS.widgetSeed, (detail) => {
      if (Array.isArray(detail)) setSeeded(detail as Notice[])
    })
  }, [])

  // ② 过期判定要跟着走 —— ttl 到点的条目得自己消失。1s 一跳够用
  //    （主窗口那边靠抓取轮询顺带推进 `now`，小窗没有轮询，只能自己跳）
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  // ③ 位置：窗口被移动就存（下次开启回到原处）
  useEffect(() => {
    let un: (() => void) | null = null
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        un = await getCurrentWindow().onMoved(({ payload }) => {
          saveWidgetPos(
            { x: payload.x, y: payload.y },
            globalThis.localStorage?.getItem(WIDGET_POS_KEY) ?? null,
          )
        })
      } catch {
        /* 非桌面端 */
      }
    })()
    return () => un?.()
  }, [])

  // ④ 退出兜底（2026-09-24 真机反馈加）：**用户直接关小窗**（Alt+F4 / 系统菜单）时，
  //    保证它真的消失。
  //
  //    为什么走自定义命令而不是 `getCurrentWindow().close()`：后者要 ACL 权限
  //    （`core:window:allow-close`），而权限有问题的机器上正是它失败 ⇒ 窗口关不掉。
  //    `destroy_widget_window` 是**自定义命令，不走 ACL**，因此一定可达 —— 这就是兜底的价值。
  useEffect(() => {
    let un: (() => void) | null = null
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        un = await getCurrentWindow().onCloseRequested(async (e) => {
          e.preventDefault()
          const { destroyWidgetWindow } = await import('../utils/shellBridge')
          await destroyWidgetWindow()
        })
      } catch {
        /* 非桌面端 / 权限不足：探针环境本来就没有窗口可关 */
      }
    })()
    return () => un?.()
  }, [])

  // ⑤ 小窗两项增强（R38 批 5d，2026-09-24）：**开启时把偏好补上**。
  //
  //    为什么小窗自己要读一遍偏好：这两个属性是**窗口级**的，而窗口是新开的 ——
  //    主窗口设置里的那次调用发生在"小窗还不存在"的时候，那时命令是幂等的空操作
  //    （见 Rust 侧 `set_widget_click_through` 的注释）。所以**每次小窗起来都要重新应用一次**，
  //    否则用户设了穿透、重启应用之后穿透就"忘了"。
  useEffect(() => {
    if (!import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) return
    let alive = true
    void (async () => {
      try {
        const { api } = await import('../api/api')
        const { values } = await api.getPrefs()
        if (!alive) return
        if (values.widget_click_through === 'on') {
          const { setWidgetClickThrough } = await import('../utils/shellBridge')
          const ok = await setWidgetClickThrough(true)
          console.info('[widget] 启动时应用鼠标穿透 →', ok)
        }
      } catch {
        /* 后端不可达：按默认（不穿透）—— 宁可不穿透，也别让用户点不动 */
      }
    })()
    return () => { alive = false }
  }, [])

  // ⑥ 全屏时隐藏（R38 批 5d，来自 LuckyIsland）。
  //
  //    为什么由**小窗自己**轮询：判据（Windows 通知状态）在 Rust，而"该不该显示"这件事
  //    只有小窗关心。主窗口那边插一脚只会让状态有两份。**2 秒一跳**：全屏切换是秒级事件，
  //    2 秒的延迟用户察觉不到，而 `SHQueryUserNotificationState` 是极轻的本地调用
  //    （不进网络、不碰数据库），不值得为它做事件订阅。
  //
  //    ⚠️ **只 `show`/`hide`，不销毁**（`set_widget_visible`）：全屏结束要能立刻回来。
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return          // 探针/浏览器：Rust 不在，跳过
    let alive = true
    let hiddenByUs = false
    const tick = async () => {
      try {
        const { api } = await import('../api/api')
        const { values } = await api.getPrefs()
        if (!alive) return
        const want = values.widget_hide_fullscreen !== 'off'
        const { isFullscreenAppRunning, setWidgetVisible } = await import('../utils/shellBridge')
        const full = want ? await isFullscreenAppRunning() : false
        if (!alive) return
        if (full && !hiddenByUs) {
          hiddenByUs = true
          console.info('[widget] 检测到全屏程序 ⇒ 暂时隐藏小窗')
          await setWidgetVisible(false)
        } else if (!full && hiddenByUs) {
          hiddenByUs = false
          console.info('[widget] 全屏结束 ⇒ 恢复显示小窗')
          await setWidgetVisible(true)
        }
      } catch {
        /* 读不到偏好 / 问不到系统：这一跳什么都不做（下一跳再试） */
      }
    }
    void tick()
    const t = window.setInterval(() => void tick(), 2000)
    return () => { alive = false; window.clearInterval(t) }
  }, [])

  // ⑦ 面板的**高度上限**：按**屏幕**高算好写进 CSS 变量（R38 批 5d；批 5e 挪成独立 effect）。
  //
  //    ⚠️ **为什么不能用 `60vh`**：小窗的高度是**跟着面板长的**
  //    （窗口 = 40 + 6 + 面板高，见 `utils/widgetWindow.ts`）——
  //    于是 `vh` 与面板高度**互为因果**：折叠态窗口 40px ⇒ `60vh = 24px`
  //    ⇒ 面板被压到 24px ⇒ 窗口只长到 70px ⇒ `60vh` 仍然很小
  //    ⇒ 面板永远长不开。更糟的是 `calc(60vh - 74px)`（滚动体那条）会变成**负数**，
  //    滚动体归零、条目压到页脚上（用户 2026-09-24 第二次截图）。
  //
  //    ⚠️⚠️ **必须用 `screen.availHeight`，不能用 `window.innerHeight`**（批 5f 修自己的错）。
  //
  //    我第一版写的是 `innerHeight - 120` —— 那是**同一个循环的另一件外衣**：
  //    `innerHeight` 就是**小窗自己的高度**，而小窗高度**由面板高度决定** ⇒
  //    还是"面板高 → 窗口高 → 面板高"的自指。
  //    实测这个循环**收敛在 120px 的下限**上（窗口 40 ⇒ cap=120 ⇒ 面板 120 ⇒ 窗口 166
  //    ⇒ `innerHeight=166` ⇒ cap 仍 = max(120, 46) = **120**），于是面板被永久压在 120 高
  //    —— **用户看到的"被挤压"就是这个**。
  //
  //    正确参照系是**屏幕**（与窗口自己多高无关）：`screen.availHeight` 还顺带扣掉了任务栏。
  //    这个值在展开前后**不变** ⇒ 不构成循环。
  //
  //    （`window.screen` 在探针/浏览器里也有，取值是宿主屏幕，语义一致。）
  useEffect(() => {
    const set = () => {
      const avail = globalThis.screen?.availHeight ?? 0
      document.documentElement.style.setProperty(
        '--widget-panel-max-h', `${widgetPanelMaxHeight(avail)}px`)
    }
    set()
    // 换显示器 / 改分辨率时 `screen.availHeight` 会变，但**不会**触发 window resize ——
    // 用 `matchMedia` 盯分辨率变化（比轮询便宜，且只在真正变化时醒）。
    let mq: MediaQueryList | null = null
    try {
      mq = window.matchMedia(`(height: ${globalThis.screen.height}px)`)
      mq.addEventListener('change', set)
    } catch { /* 个别环境没有 matchMedia：那就只在挂载时设一次 */ }
    return () => mq?.removeEventListener('change', set)
  }, [])

  // ⑧ 形态梯度：**展开面板时把窗口长大，收起时缩回去**（R38 批 5d）。
  //
  //    ⚠️ **这一条修的是一个真 bug，不是加动效**：面板 `top = 胶囊底(40) + 6 = 46`，
  //    而窗口写死 200×40 ⇒ 面板**整个落在窗口外**，宽度 280 也超出 200。
  //    实测（`ui_probe --status-island --width 200 --height 90`）：可命中=False / 在视口内=False。
  //    也就是说小窗从上线起**只有一个胶囊是真的**，面板用户从没看见过。
  //
  //    为什么用 `MutationObserver` 而不是给 `StatusIsland` 加回调：面板是
  //    `createPortal(..., document.body)` 出去的，**宿主组件不该知道"我在窗口里还是顶栏里"**
  //    （§8 宿主无关是硬要求）。在窗口这一侧观察"面板出现了没"，是**唯一不污染组件契约**的接法。
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return   // 探针/浏览器：没有真窗口可 resize
    let alive = true

    /** 展开方向写进 `<html data-widget-dir>`（**面板入场动画的方向**靠它选 keyframes） */
    const applyDir = (dir: WidgetDir) => {
      document.documentElement.dataset.widgetDir = dir
    }

    const sync = async () => {
      try {
        const panel = document.querySelector<HTMLElement>('.si-panel')
        const want = !!panel
        if (want === expanded.current) return        // 状态没变：一次 IPC 都不发
        const cur = await readWidgetRect()
        const screen = await readScreenBox()
        if (!alive) return
        // 胶囊宽 = 卡片该有的宽。用**量出来的**而不是常量：D1 起胶囊宽跟着内容走（200–400）。
        // ⚠️ F1 之后展开时胶囊是 `display:none`（量到 0）⇒ 用最近一次量到的（`lastCapW`，
        //    由上面那条 `ResizeObserver` 维护）；量不到就退回下限。
        const capW = readCapsuleW() || lastCapW.current
        const { resizeWidgetWindow } = await import('../utils/shellBridge')
        if (want) {
          // ⚠️ 量**面板自己的高**（不是 `getBoundingClientRect`：入场动画的位移/缩放会让
          //    rect 偏小 —— 规格 §12.3 记过同一个坑）。
          //    F1 之后**卡片就是面板** ⇒ 这个高就是卡片高（不再 `+ 胶囊 + 间隙`）。
          //    高度上限 `--widget-panel-max-h` 已由**上面那条独立 effect** 设好
          //    （不放在这里：这里在非桌面端直接 return，变量就永远设不上 —— 见那条注释）。
          const h = panel ? panel.offsetHeight : 0
          // 记下展开前**卡片**（= 胶囊）的矩形：收起时要精确回到这里（反推会漂）
          preExpandPos.current = {
            x: cur.x + WIDGET_SHADOW_PAD,
            y: cur.y + WIDGET_SHADOW_PAD,
            w: capW,
          }
          const geom = widgetExpandGeom(cur, h, screen)
          expanded.current = true
          dirRef.current = geom.dir
          setDir(geom.dir)
          setAlign(geom.align)
          applyDir(geom.dir)
          const ok = await resizeWidgetWindow(geom)
          console.info('[widget] 展开 →', geom, 'ok=', ok)
        } else {
          expanded.current = false
          const geom = widgetCollapseGeom(cur, screen, capW, preExpandPos.current)
          dirRef.current = 'down'
          setDir('down')
          setAlign('center')
          const ok = await resizeWidgetWindow(geom)
          console.info('[widget] 收起 →', geom, 'ok=', ok)
        }
      } catch (e) {
        console.warn('[widget] 形态切换失败', e)
      }
    }

    const mo = new MutationObserver(() => void sync())
    mo.observe(document.body, { childList: true, subtree: false })
    return () => { alive = false; mo.disconnect() }
  }, [])

  // ⑨ 折叠态：**内容变宽/变窄 ⇒ 窗口要跟上去**（D1「方案 A：宽度跟内容走」）。
  //
  //    ⚠️ 没有这条会怎样：胶囊是 `max-content`，文案变长时它自己就长到 300 了，
  //    而窗口还是 200 ⇒ 右半边被 `.widget-shell` 的 `overflow:hidden` **裁掉**，
  //    用户看到的是"话说到一半没了"（而且探针在小窗坐标系里量得到、单测量不到）。
  //
  //    ⚠️ 为什么用 `ResizeObserver` 而不是在渲染时算：胶囊的宽由**字体度量 + 内容**决定，
  //    只有浏览器知道；`ResizeObserver` 正好在布局完成后回调一次（不产生额外帧）。
  //    也不能用 `MutationObserver` 盯文本 —— 文案换字未必改宽度，计数/字形出现却会改。
  //
  //    ⚠️ **不会自指**：窗口宽变了**不会**改胶囊宽（`max-content` 与容器宽无关），
  //    所以"观察 → 改窗口 → 又触发观察"这条回路不存在（`WIDGET_RESIZE_DEADBAND`
  //    是第二道保险，挡的是活数据每秒 ±1px 的抖动）。
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    const cap = document.querySelector<HTMLElement>('.si-island')
    if (!cap) return
    let alive = true
    let last = cap.offsetWidth
    lastCapW.current = clampCapsuleW(cap.offsetWidth)
    const fit = async () => {
      if (!alive || expanded.current) return   // 展开态：窗口宽 = 面板宽 ≥ 胶囊上限 ⇒ 不用动
      const capW = readCapsuleW()
      if (!capW) return                        // 量不到（隐藏/未布局）：保持上一次的值
      lastCapW.current = capW                  // ← 展开态读不到它，收起路径要用
      if (Math.abs(capW - last) < WIDGET_RESIZE_DEADBAND) return
      last = capW
      try {
        const cur = await readWidgetRect()
        const screen = await readScreenBox()
        if (!alive) return
        const g = widgetCapsuleGeom(cur, screen, capW)
        if (Math.abs(g.x - cur.x) < 1 && Math.abs(g.w - cur.w) < 1) return
        const { resizeWidgetWindow } = await import('../utils/shellBridge')
        const ok = await resizeWidgetWindow(g)
        console.info('[widget] 内容宽变化 →', capW, g, 'ok=', ok)
      } catch (e) {
        console.warn('[widget] 跟随内容宽失败', e)
      }
    }
    const ro = new ResizeObserver(() => void fit())
    ro.observe(cap)
    return () => { alive = false; ro.disconnect() }
  }, [])

  // ⑧ dev 自检条（生产构建里 `import.meta.env.DEV` 为 false ⇒ 整段被摇掉）
  //
  //    ⚠️ **默认不画**（2026-09-30 用户：「先把白色的 log 文字条去掉」）：那条 9px 白底字条
  //    画在窗口左上角、压着胶囊 —— 用户看到的是一块白字条。
  //    但它是**真机上唯一的诊断通道**（小窗开不了 devtools、看不到 console，devlog/178/180
  //    那九轮真机修复全靠它）⇒ **留代码、改成开关**：在主窗口控制台执行
  //    `localStorage.setItem('ddtoolkit.widget-diag','1')` 再重开小窗即可。
  //    ⚠️ **回传 `widget_diag` 的那一半照旧**（它只写进 `shell.log`，屏幕上什么都不画）——
  //    所以"页面到底有没有跑"这条硬证据没有丢。
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const shell = document.querySelector<HTMLElement>('.widget-shell')
    const pill = document.querySelector<HTMLElement>('.si-island')
    const cs = pill ? getComputedStyle(pill) : null
    const line = [
      `css:${shell ? getComputedStyle(shell).display : 'no-shell'}`,
      `bg:${cs ? cs.backgroundColor : '-'}`,
      `bf:${cs && cs.backdropFilter && cs.backdropFilter !== 'none' ? 'Y' : 'N'}`,
      `w/h:${pill ? Math.round(pill.getBoundingClientRect().width) : 0}x${pill ? Math.round(pill.getBoundingClientRect().height) : 0}`,
      `q:${location.search || '-'}`,
      `n:${notices.length}`,
    ].join(' ')
    if (showDiag) setDiag(line)
    // ⚠️ **把自检行回传给 Rust 控制台**（2026-09-24 第四轮）。
    //    这是"页面到底有没有执行"的硬证据 —— 用户看不到窗口里的字、也开不了 devtools，
    //    但 `cargo tauri dev` 的控制台他看得到。**这条日志不出现 = 页面根本没跑。**
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('widget_diag', { info: line })
      } catch (err) {
        console.warn('[widget] 自检回传失败（非桌面端？）', err)
      }
    })()
  }, [notices.length, showDiag])

  const onPointerDown = (e: React.PointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY, dragging: false }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = down.current
    if (!d || d.dragging) return
    if (Math.abs(e.clientX - d.x) < DRAG_THRESHOLD_PX &&
        Math.abs(e.clientY - d.y) < DRAG_THRESHOLD_PX) return
    d.dragging = true
    // ⚠️ **必须 catch**：Tauri v2 的 ACL 会在这里抛权限错误，而"没 catch 的 async IIFE"
    //    会变成未处理 rejection ⇒ **WebView 的 IPC 通道被打坏**，之后主窗口那条 IPC 桥
    //    全部失灵（关不掉、最小化不了、托盘退出也杀不掉）—— 2026-09-24 真机反馈的根因。
    //    权限已修（`capabilities/default.json` 作用域放到所有窗口），但这里也补上兜底：
    //    拖不动最多是"拖不动"，绝不该把整条 IPC 带走。
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        await getCurrentWindow().startDragging()
      } catch (err) {
        console.warn('[widget] 拖动失败（权限？）—— 已吞掉，不影响其它功能', err)
      }
    })()
  }
  const onPointerUp = () => {
    down.current = null
  }

  // ⑩ **面板就是展开态的把手**（F1，2026-09-30）。
  //
  //    为什么必须补这条：F1 让"展开时胶囊整行隐藏"（用户两次要求），而原来的拖动**只挂在
  //    `.widget-shell` 上** —— 面板是 `createPortal(document.body)` 出去的，指针事件根本
  //    不经过窗口壳 ⇒ 展开后除了那圈 32px 留白**没有东西可拖**。
  //    ⇒ 用**文档级**监听补上（面板由 `StatusIsland` 渲染，窗口这边只能这样接 ——
  //    与用 `MutationObserver` 观察面板出现是同一条取舍：不污染组件契约，§8）。
  //
  //    ⚠️ 只接管**落在面板上**的按下（`closest('.si-panel')`）：胶囊那半边仍走窗口壳上
  //    那套 React 指针处理，两边不会各拖一次。
  //    ⚠️ 与窗口壳一样**位移过阈值才算拖** —— 否则面板里的动作钮永远点不响。
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let st: { x: number; y: number; dragging: boolean } | null = null
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (!t || typeof t.closest !== 'function' || !t.closest('.si-panel')) return
      st = { x: e.clientX, y: e.clientY, dragging: false }
    }
    const onMove = (e: PointerEvent) => {
      if (!st || st.dragging) return
      if (Math.abs(e.clientX - st.x) < DRAG_THRESHOLD_PX &&
          Math.abs(e.clientY - st.y) < DRAG_THRESHOLD_PX) return
      st.dragging = true
      // 与窗口壳那条同款：**必须 catch**（未处理的 rejection 会打坏 WebView 的 IPC 通道）
      void (async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window')
          await getCurrentWindow().startDragging()
        } catch (err) {
          console.warn('[widget] 从面板拖动失败（权限？）—— 已吞掉', err)
        }
      })()
    }
    const onUp = () => { st = null }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', onUp, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', onUp, true)
    }
  }, [])

  const onAction = (kind: NoticeActionKind, n: Notice) => {
    void relayWidgetAction({ kind, id: n.id })
  }

  return (
    <div
      className="widget-shell"
      /* 展开方向（R38 批 5d；D1 起从 `data-flip` 换成 `data-dir` 并加 `data-align`）：
         面板开在胶囊的哪一边**由几何算完写在这里**（`widgetExpandGeom`），
         `StatusIsland.place()` 只跟随它 —— 面板定位的**唯一方向真源**。
         少了这个属性，窗口朝一边长、面板却按另一边画 ⇒ 面板落在窗口外（那个 bug 的翻版）。
         ⚠️ 四方向之后**必须只有这一个来源**：`place()` 自己再判一次就会与几何打架
         （09-27 样例页的「牵动哪些地方」第一条点名的就是这个）。 */
      /* F1（2026-09-30）：**展开时胶囊整行隐藏**（卡片就是面板）。那个属性由
         `StatusIsland` 写（它知道 `open`）—— 这样探针也量得到这条判据。
         方向（`data-dir`）现在只剩"入场动画从哪一侧滑出"一个用途（CSS 读
         `html[data-widget-dir]`），面板的落点与它无关。 */
      data-dir={dir}
      data-align={align}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <StatusIsland notices={notices} onAction={onAction} now={now} density="widget" />
      {showDiag && (
        /* ⚠️ **dev 专用自检条**（2026-09-24 第三轮真机反馈加；**2026-09-30 起默认关**，
           用 `localStorage['ddtoolkit.widget-diag'] = '1'` 打开 —— 见上面那条 effect）。
           小窗又置顶无边框，出问题时**既没法开 devtools、也没法看 console** ——
           前三轮就是这么在黑暗里猜的（连猜两次都错）。这条把决定性的事实用 9px 字画在窗口里：

             `css` = `.widget-shell` 的 `display`（`flex` ⇒ 样式真的加载了）
             `bg`  = 胶囊的计算背景色（深色 ⇒ 样式生效；`rgba(0,0,0,0)` ⇒ 没生效）
             `bf`  = 有没有 `backdrop-filter`；`w/h` = 内尺寸；`q` = 查询串；`n` = 条目数

           右边两个小方块是**画得出的对照**：🟥 不透明红 / 🟦 半透明蓝
           （红都不显示 ⇒ 整扇窗绘制坏了；红显示蓝不显示 ⇒ alpha 合成坏了）

           ⚠️⚠️ **必须是 `absolute` + 脱离文档流**（2026-09-24 修）：
           原来是 `fixed`，而 `fixed` 元素**仍会作为 flex item 参与布局** ——
           它把 200px 的胶囊**撑到了 224px**（9px 文本 + 两个色块装不下）。
           **诊断工具改变了被测对象** ⇒ 探针量到的宽度是假的（实测 224 而非 200）。
           原生 `fetch(2/2)` 的 `absolute` 才是真正脱离。 */
        <div
          style={{
            position: 'absolute', left: 0, top: 0, zIndex: 999999,
            font: '9px/1.25 ui-monospace, monospace', color: '#000',
            background: 'rgba(255,255,255,.88)', padding: '1px 3px',
            pointerEvents: 'none', whiteSpace: 'pre',
            maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {diag}
          <span style={{ display: 'inline-block', width: 8, height: 8, background: '#f00', marginLeft: 3, verticalAlign: -1 }} />
          <span style={{ display: 'inline-block', width: 8, height: 8, background: 'rgba(0,0,255,.5)', marginLeft: 2, verticalAlign: -1 }} />
        </div>
      )}
    </div>
  )
}
