/**
 * 开发态 UI 探针（`?probe=1`，仅 dev 构建生效）。
 *
 * 为什么存在：布局类问题（原生滚动条、内容出窗、出现滚动条导致内容宽度跳动）
 * 过去只能靠肉眼在打包版里发现，每次都要 `npm run release`（4–6 分钟）。
 * 这里把「机器可判定的不变量」固化下来，由 `scripts/ui_probe.py` 驱动浏览器断言：
 *   ① 文档层永不出现滚动条（窗口级滚动条 = 内容宽度跳 12px 的根源）；
 *   ② 没有任何元素**可见地**越过窗口左右缘（被 overflow:hidden 裁掉的折叠组不算）；
 *   ③ 任何 auto/scroll 容器不得横向溢出（例外：白名单里的「设计上就要横滚」容器）；
 *   ④ 不得使用原生滚动条（统一 OverlayScroll，否则出现/消失会挤动布局）。
 *
 * 输出：`<pre id="ui-probe">` 内 JSON（每个视图一段），供脚本解析。
 */

interface ProbeView {
  key: string
  /** 视图切换按钮的 title 前缀（PostsPage 光条） */
  title: string
}

const VIEWS: ProbeView[] = [
  { key: 'archive', title: '档案' },
  { key: 'cards', title: '展示页' },
  { key: 'list', title: '帖子列表' },
  { key: 'profile', title: '档案卡' },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function box(n: Element) {
  const r = n.getBoundingClientRect()
  return `[${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}]`
}

function name(n: Element) {
  return `${n.tagName}.${String((n as HTMLElement).className || '').slice(0, 40)}`
}

/** 是否被某个祖先的 overflow 裁掉（折叠组 max-width:0 + overflow:hidden 属此列） */
function clippedByAncestor(n: Element): boolean {
  const r = n.getBoundingClientRect()
  let p = n.parentElement
  while (p && p !== document.body) {
    const cs = getComputedStyle(p)
    if (/(hidden|clip|auto|scroll)/.test(cs.overflowX + cs.overflowY)) {
      const pr = p.getBoundingClientRect()
      if (r.right > pr.right + 1 || r.left < pr.left - 1) return true
    }
    p = p.parentElement
  }
  return false
}

function measure(tag: string) {
  const d = document.documentElement
  const shell = document.querySelector('.app-shell')
  return {
    tag,
    win: [window.innerWidth, window.innerHeight],
    /** 文档层滚动条占用（>0 = 窗口出现滚动条，必须为 0） */
    scrollbarPx: [window.innerWidth - d.clientWidth, window.innerHeight - d.clientHeight],
    docScroll: [d.scrollWidth, d.scrollHeight],
    shell: shell
      ? { client: [shell.clientWidth, shell.clientHeight], scroll: [shell.scrollWidth, shell.scrollHeight] }
      : null,
    /** 可见地越过窗口左右缘的元素 */
    overflowing: [...document.querySelectorAll('body *')]
      .filter((n) => {
        const r = n.getBoundingClientRect()
        const cross = r.right > d.clientWidth + 1 || r.left < -1
        return cross && !clippedByAncestor(n)
      })
      .slice(0, 12)
      .map((n) => `${name(n)} ${box(n)}`),
    /** 滚动容器清单：nativeBarW/H > 0 = 原生滚动条；hOverflow = 横向内容溢出 */
    scrollers: [...document.querySelectorAll('body *')]
      .filter((n): n is HTMLElement => n instanceof HTMLElement)
      .filter((n) => {
        const cs = getComputedStyle(n)
        return /(auto|scroll|hidden)/.test(cs.overflowX + cs.overflowY)
      })
      .slice(0, 30)
      .map((e) => {
        const cs = getComputedStyle(e)
        // offsetWidth 含边框、clientWidth 不含：先减掉边框才是「滚动条占用」
        const bx = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0)
        const by = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
        return {
          el: name(e),
          overflowX: cs.overflowX,
          overflowY: cs.overflowY,
          client: [e.clientWidth, e.clientHeight],
          scroll: [e.scrollWidth, e.scrollHeight],
          nativeBarW: Math.round((e.offsetWidth || 0) - e.clientWidth - bx),
          nativeBarH: Math.round((e.offsetHeight || 0) - e.clientHeight - by),
          hOverflow: e.scrollWidth > e.clientWidth + 1,
        }
      }),
  }
}

export async function runUiProbe(): Promise<void> {
  const out: unknown[] = []
  await sleep(1600) // 首屏 + 预取稳定

  const clickView = (prefix: string) => {
    const btn = [...document.querySelectorAll<HTMLButtonElement>('.view-btn')].find((b) =>
      (b.title || '').startsWith(prefix),
    )
    btn?.click()
    return !!btn
  }

  if (!document.querySelector('.view-btn')) {
    out.push(measure('empty')) // 无选中 VTuber：只有空置界面
  } else {
    for (const v of VIEWS) {
      clickView(v.title)
      await sleep(900) // 场景入场 0.22s + 数据到位
      out.push(measure(v.key))
    }
  }

  const pre = document.createElement('pre')
  pre.id = 'ui-probe'
  pre.textContent = JSON.stringify(out)
  document.body.appendChild(pre)
  document.title = 'UI_PROBE_DONE'
}
