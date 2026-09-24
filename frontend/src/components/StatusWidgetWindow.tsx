import { useEffect, useRef, useState } from 'react'

import StatusIsland from './StatusIsland'
import type { Notice, NoticeActionKind } from '../utils/notificationHub'
import {
  WIDGET_NOTICES_EVENT,
  WIDGET_POS_KEY,
  relayWidgetAction,
  saveWidgetPos,
  widgetCollapseGeom,
  widgetExpandGeom,
} from '../utils/widgetWindow'

/**
 * 桌面状态控件小窗（R38 批 5b，规格 §7/§8）。由 `?widget=1` 挂载。
 *
 * ## 它**不轮询**
 *
 * 六个信息源（任务进度 / 风控冷却 / 登录失效 / 完成报告 / 瞬时消息 / 磁盘）全在主窗口的
 * `TopBar` 里，小窗再来一份就是**双倍请求**。所以小窗是**纯显示**的：主窗口推什么它画什么
 * （`widget:notices`）。反过来，面板里的动作（"去登录"/"查看详情"）只有主窗口做得了 ——
 * 小窗把点击**转回去**（`widget:action`）。
 *
 * > 这也是**没有**按规格 §8 抽 `useStatusIsland()` 的原因：抽了只是把轮询搬个家，
 * > 两扇窗仍然各轮各的；**推事件才是真的只轮一次**。
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
 * **dev-only**：探针往小窗注入条目的页面事件名。
 *
 * 为什么需要它：小窗**只听主窗口推的** `widget:notices`（Tauri 事件），
 * 而探针跑在无头浏览器里 —— 没有 Tauri 事件 ⇒ 小窗**永远是空闲态**
 * （`lit=false` ⇒ hover 不展开 ⇒ 面板永远量不到）。
 * 于是"面板在小窗里能不能用"这条判据会**空转**（永远没有面板可量）。
 *
 * 与 `--status-island` 用 `ddtoolkit:pill-message` 是同一套思路：
 * 走**页面自己的事件源**，而不是直接改 React state。
 * 生产构建里 `import.meta.env.DEV` 为 false ⇒ 整段被摇掉。
 */
export const WIDGET_SEED_NOTICES_EVENT = 'ddtoolkit:widget-seed'

export default function StatusWidgetWindow() {
  const [notices, setNotices] = useState<Notice[]>([])
  const [now, setNow] = useState(() => Date.now())
  const down = useRef<{ x: number; y: number; dragging: boolean } | null>(null)
  const [diag, setDiag] = useState('…')
  /**
   * 窗口当前是展开态吗（R38 批 5d）。用来**去重** resize 调用 ——
   * 面板每次重渲染都调一次 resize 会让窗口持续抖动（Windows 的 resize 是可见的）。
   */
  const expanded = useRef(false)
  /**
   * 展开**之前**胶囊所在的位置（收起时精确回到这里）。
   *
   * ⚠️ 为什么要存而不是反推：贴屏幕边的窗口展开时会**被夹**（200→280 宽必须收回来，
   * 否则面板出屏），于是"展开矩形的中心"已经不是原来那个中心了 —— 反推回去会越来越偏，
   * 每次悬停漂几十像素，久了小窗就爬走了。有单测守这条（`反复展开/收起不漂移`）。
   */
  const preExpandPos = useRef<{ x: number; y: number } | null>(null)
  /**
   * 面板开在胶囊上方（贴屏幕下沿时向上翻）—— 决定 `.widget-shell` 的对齐。
   *
   * ⚠️ **同一份事实必须同时存在于 ref 与 state**（2026-09-24 eslint 逼出来的）：
   * `sync()` 跑在一个 `[]` 依赖的 effect 里 ⇒ 它**闭包捕获的是首次渲染的 `flipUp`**
   * （恒为 `false`）。收起时若直接读 state，无论展开时翻没翻，都会按"没翻"去算位置 ⇒
   * 贴屏幕下沿的小窗收起来会**往上跳一截**。所以逻辑一律读 ref，state 只负责渲染。
   */
  const flipUpRef = useRef(false)
  const [flipUp, setFlipUp] = useState(false)

  // ① 条目：**只听主窗口推的**
  useEffect(() => {
    let un: (() => void) | null = null
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        un = await listen<Notice[]>(WIDGET_NOTICES_EVENT, (e) => setNotices(e.payload ?? []))
      } catch {
        /* 非桌面端（探针/浏览器）：没有主窗口可听，保持空列表 */
      }
    })()
    // ⚠️ **dev-only 的注入通路**（R38 批 5d）：探针（无头浏览器）里没有 Tauri 事件，
    //    于是小窗**永远是空闲态**（没有条目 ⇒ `lit=false` ⇒ hover 不展开、面板永远量不到）。
    //    而"面板在小窗里到底能不能用"正是那个真 bug 的判据 —— 不注入就永远空转。
    //    走的是**页面自己的事件**（不是直接改 React state），与 `--status-island` 同款做法。
    //    生产构建里 `import.meta.env.DEV` 为 false ⇒ 整段被摇掉。
    if (import.meta.env.DEV) {
      const onSeed = (e: Event) => {
        const detail = (e as CustomEvent).detail
        if (Array.isArray(detail)) setNotices(detail)
      }
      window.addEventListener(WIDGET_SEED_NOTICES_EVENT, onSeed)
      return () => { un?.(); window.removeEventListener(WIDGET_SEED_NOTICES_EVENT, onSeed) }
    }
    return () => un?.()
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

  // ⑦ 面板的**高度上限**：按屏幕高算好写进 CSS 变量（R38 批 5d；批 5e 挪成独立 effect）。
  //
  //    ⚠️ **为什么不能用 `60vh`**：小窗的高度是**跟着面板长的**
  //    （窗口 = 40 + 6 + 面板高，见 `utils/widgetWindow.ts`）——
  //    于是 `vh` 与面板高度**互为因果**：折叠态窗口 40px ⇒ `60vh = 24px`
  //    ⇒ 面板被压到 24px ⇒ 窗口只长到 70px ⇒ `60vh` 仍然很小
  //    ⇒ 面板永远长不开（死锁在一块 24px 的板子上）。
  //    更糟的是 `calc(60vh - 74px)`（滚动体那条）会变成**负数**，滚动体高度归零
  //    ⇒ 条目一条都看不见、直接压到页脚上（**用户 2026-09-24 截图就是这个**）。
  //
  //    ⚠️⚠️ **必须独立于 Tauri 那段**（批 5e 修的自己的错）：原来它写在"展开就 resize"
  //    那个 effect 里，而那条在**非桌面端第一行就 return**（`'__TAURI_INTERNALS__' in window`
  //    为假）⇒ 探针里这个变量**永远设不上** ⇒ 那条判据只能靠真机发现。
  //    **"只在真机上生效的修复"等于没法验证的修复** —— 所以它现在单独一条 effect，
  //    任何环境都设（`window.innerHeight` 在真窗口里就是窗口高，探针里是视口高，
  //    两者都远大于面板高，语义一致）。
  useEffect(() => {
    const set = () => {
      // 留 120px 余量给胶囊、间隙与任务栏；下限 120px 防"屏幕特别小"时算出 0/负数
      const h = Math.max(120, window.innerHeight - 120)
      document.documentElement.style.setProperty('--widget-panel-max-h', `${h}px`)
    }
    set()
    window.addEventListener('resize', set)
    return () => window.removeEventListener('resize', set)
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

    /** 读当前窗口矩形（逻辑像素口径与 Rust 侧一致） */
    const curRect = async () => {
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
    const screenBox = async () => {
      const { currentMonitor } = await import('@tauri-apps/api/window')
      const mon = await currentMonitor()
      const sc = mon?.scaleFactor ?? 1
      return {
        width: Math.round((mon?.size.width ?? 1920) / sc),
        height: Math.round((mon?.size.height ?? 1080) / sc),
      }
    }

    const sync = async () => {
      try {
        const panel = document.querySelector<HTMLElement>('.si-panel')
        const want = !!panel
        if (want === expanded.current) return        // 状态没变：一次 IPC 都不发
        const cur = await curRect()
        const screen = await screenBox()
        if (!alive) return
        const { resizeWidgetWindow } = await import('../utils/shellBridge')
        if (want) {
          // ⚠️ 量**面板自己的高**（不是 `getBoundingClientRect`：入场动画的
          //    `scale(.985)` 会让 rect 偏小 —— 规格 §12.3 记过同一个坑，实测到 276 而非 280）。
          //    高度上限 `--widget-panel-max-h` 已由**上面那条独立 effect** 设好
          //    （不放在这里：这里在非桌面端直接 return，变量就永远设不上 —— 见那条注释）。
          const h = panel ? panel.offsetHeight : 0
          // 记下展开前的位置：收起时要精确回到这里（反推会漂，见 `preExpandPos` 注释）
          preExpandPos.current = { x: cur.x, y: cur.y }
          const geom = widgetExpandGeom(cur, h, screen)
          expanded.current = true
          flipUpRef.current = geom.flipUp
          setFlipUp(geom.flipUp)
          const ok = await resizeWidgetWindow(geom)
          console.info('[widget] 展开 →', geom, 'ok=', ok)
        } else {
          expanded.current = false
          const geom = widgetCollapseGeom(cur, screen, flipUpRef.current, preExpandPos.current)
          flipUpRef.current = false
          setFlipUp(false)
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

  // ⑧ dev 自检条的填充（生产构建里 `import.meta.env.DEV` 为 false ⇒ 整段被摇掉）
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
    setDiag(line)
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
  }, [notices.length])

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

  const onAction = (kind: NoticeActionKind, n: Notice) => {
    void relayWidgetAction({ kind, id: n.id })
  }

  return (
    <div
      className="widget-shell"
      /* 展开方向（R38 批 5d）：向上翻时胶囊要落到窗口**底边**（面板在它上方）。
         少了这个属性，窗口向上长、胶囊却还在窗口顶部 ⇒ 面板与胶囊错位。 */
      data-flip={flipUp ? 'up' : 'down'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <StatusIsland notices={notices} onAction={onAction} now={now} density="widget" />
      {import.meta.env.DEV && (
        /* ⚠️ **dev 专用自检条**（2026-09-24 第三轮真机反馈加）。
           小窗只有 200×40、又置顶无边框，出问题时**既没法开 devtools、也没法看 console** ——
           前三轮我就是这么在黑暗里猜的（连猜两次都错）。这条把决定性的事实用 9px 字画在窗口里：

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
