import { useEffect, useRef, useState } from 'react'

import StatusIsland from './StatusIsland'
import type { Notice, NoticeActionKind } from '../utils/notificationHub'
import {
  WIDGET_NOTICES_EVENT,
  WIDGET_POS_KEY,
  relayWidgetAction,
  saveWidgetPos,
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

export default function StatusWidgetWindow() {
  const [notices, setNotices] = useState<Notice[]>([])
  const [now, setNow] = useState(() => Date.now())
  const down = useRef<{ x: number; y: number; dragging: boolean } | null>(null)
  const [diag, setDiag] = useState('…')

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

  // ⑤ dev 自检条的填充（生产构建里 `import.meta.env.DEV` 为 false ⇒ 整段被摇掉）
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
