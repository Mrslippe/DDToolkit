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
import { api } from '../api/api'

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

/** 上游取数还没落地时，弹窗里会出现的文案（见 `LiveSessionDialog` 的 waitHint） */
const UPSTREAM_PENDING_RE = /正在取上游弹幕|上游响应较慢/

/** 等详情弹窗"填满"（供 `?probe=archive` 的 DOM dump 用）：
 *
 *  ① 等上游取数那两格落地（拆出 `/upstream` 后是第二个异步跳）；
 *  ② 等词云**拼贴入池稳定** —— `MosaicCloud` 是频次降序逐个入池（约 150ms/词，
 *     40 词 ≈ 6s），抢在它之前取样只会量到 `cloudCells: 0`（看起来像"词云没渲染"）。
 *
 *  上限内没稳定也返回 —— 探针只负责"尽量量到稳定态"，判失败交给断言。 */
async function waitDetailSettled(maxMs = 25000) {
  const t0 = Date.now()
  let lastCells = -1
  let stable = 0
  while (Date.now() - t0 < maxMs) {
    const dlg = document.querySelector('.lc-dlg')
    if (dlg) {
      const pending = [...dlg.querySelectorAll('.lc-dlg-ph')].some((n) =>
        UPSTREAM_PENDING_RE.test(n.textContent || ''),
      )
      if (!pending) {
        if (!dlg.querySelector('.lc-dlg-cloud')) return   // 这一段没有词云可等
        const cells = dlg.querySelectorAll('.lc-dlg-cloud-cell').length
        stable = cells > 0 && cells === lastCells ? stable + 1 : 0
        lastCells = cells
        if (stable >= 2) return                          // 0.8s 没有新词入池
      }
    }
    await sleep(400)
  }
}

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
  /** 列表列宽契约（与列表里有没有帖子无关）。
   *
   *  必须独立于 `cards`：`cards` 在**空列表时为 null**，而 2026-09-08 那次列宽回归
   *  的守卫断言写在「cards 非空」分支里 —— 于是列表一空、断言就静默失效
   *  （审计 2026-09-11 点出的假通过路径之一）。这里改成常驻量测。 */
  const listContract = (() => {
    const inner = document.querySelector('.list-scroll .list-inner')
    const sc = document.querySelector('.list-scroll .os-scroll')
    if (!inner && !sc) return null
    return {
      innerW: inner ? Math.round(inner.getBoundingClientRect().width) : null,
      /** 选择器踩空时计算值退化成 `none`（= 列宽改由内容驱动，正是那次的症状） */
      innerMaxW: inner ? getComputedStyle(inner).maxWidth : null,
      /** 容器是否还能被选到（OverlayScroll 插层回归会让它静默失效） */
      hasScroller: !!sc,
    }
  })()
  return {
    tag,
    contract: listContract,
    win: [window.innerWidth, window.innerHeight],
    /** 文档层滚动条占用（>0 = 窗口出现滚动条，必须为 0） */
    scrollbarPx: [window.innerWidth - d.clientWidth, window.innerHeight - d.clientHeight],
    docScroll: [d.scrollWidth, d.scrollHeight],
    shell: shell
      ? { client: [shell.clientWidth, shell.clientHeight], scroll: [shell.scrollWidth, shell.scrollHeight] }
      : null,
    /** 列表卡片几何（帖子列表视图专用）：
        列宽契约 = .list-inner 恒为 min(900, 可用宽) 且卡片铺满该列、封面 220 不被裁。
        2026-09-08 回归事故：OverlayScroll 插层让 `.list-scroll > .list-inner` 失效，
        列宽退化成内容宽度（短标题 → 566px 缩窄居中；长「！！！」串 → 1350px 溢出裁封面）。 */
    cards: (() => {
      const cards = [...document.querySelectorAll('.post-card')]
      if (!cards.length) return null
      const inner = document.querySelector('.list-scroll .list-inner')
      const sc = document.querySelector('.list-scroll .os-scroll')
      const widths = cards.map((c) => Math.round(c.getBoundingClientRect().width))
      const cover = cards[0].querySelector('.post-card-cover')
      const contentLeft = sc
        ? sc.getBoundingClientRect().left + (parseFloat(getComputedStyle(sc).paddingLeft) || 0)
        : 0
      return {
        n: cards.length,
        widthMin: Math.min(...widths),
        widthMax: Math.max(...widths),
        innerW: inner ? Math.round(inner.getBoundingClientRect().width) : null,
        /** 列宽契约是否在生效：选择器踩空时计算值退化成 none（内容宽度驱动） */
        innerMaxW: inner ? getComputedStyle(inner).maxWidth : null,
        coverW: cover ? Math.round(cover.getBoundingClientRect().width) : null,
        coverClipped: cards.filter((c) => {
          const cov = c.querySelector('.post-card-cover')
          return !!cov && cov.getBoundingClientRect().left < contentLeft - 1
        }).length,
      }
    })(),
    /** 展示页（cards）hero 区量测 —— **与列表无关的常驻量测**。
     *
     *  为什么加它（2026-09-13，P2 分层收敛 A 批次）：这一批把 hero 的两段纯逻辑搬出了
     *  `PostsPage`（`orderAccounts` 拖拽排序 → `chunkBy` 每 3 枚切集 → `accountHomeUrl` 主页兜底），
     *  而它们**只在 cards 视图 + 药丸有内容时才渲染**。只断言「在不在框里」完全看不出
     *  「药丸少了一排 / 顺序变了 / 切集错了」——正是"搬坏了但探针全绿"的形态。
     *  这里把药丸的**数量、索引序、每枚的展示数值**抽成可比对的签名，
     *  由 `scripts/ui_probe.py --hero-expect <hash>` 做位级回归。 */
    hero: (() => {
      const pills = [...document.querySelectorAll('.stat-pill[data-pill-index]')]
      const sets = [...document.querySelectorAll('.stat-sets .stat-set')]
      if (!pills.length && !sets.length) return null
      const sig = pills.map((p) => {
        const idx = p.getAttribute('data-pill-index')
        const cls = String((p as HTMLElement).className)
        const platform = /(^|\s)image(\s|$)/.test(cls) ? 'image' : /(^|\s)pink(\s|$)/.test(cls) ? 'pink' : 'coral'
        const value = (p.querySelector('.pill-value')?.textContent || '').trim()
        return `${idx}:${platform}:${value}`
      })
      return {
        pillCount: pills.length,
        setCount: sets.length,
        /** 每集内药丸数（切集口径：恒 ≤3；总数 0 时为 []） */
        setSizes: sets.map((s) => s.querySelectorAll('.stat-pill').length),
        hasAddButton: !!document.querySelector('.pill-add'),
        /** 逐枚签名：`索引:色系:展示数值` —— 顺序变化会直接反映在这里 */
        signature: sig,
      }
    })(),
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

/** 筛选弹窗几何（P10-A）：`.posts-panel` 是 `overflow:hidden`，弹窗越出右栏即被裁掉——
 *  这是双月历（宽 520）最容易踩的坑，固化成机器可判定的不变量。 */
function filterPopBox() {
  const pop = document.querySelector('.post-filter-pop')
  const panel = document.querySelector('.posts-panel')
  if (!pop || !panel) return { ok: false, reason: 'pop 未渲染' }
  const r = pop.getBoundingClientRect()
  const w = panel.getBoundingClientRect()
  const panels = [...document.querySelectorAll('.drp-panel')].filter((n) => getComputedStyle(n).display !== 'none')
  const grid = document.querySelector('.drp-grid')
  return {
    ok: true,
    pop: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
    panel: [Math.round(w.left), Math.round(w.top), Math.round(w.right), Math.round(w.bottom)],
    /** 必须完整落在右栏可视区内（越界会被 .posts-panel 裁掉） */
    insidePanel: r.left >= w.left - 1 && r.right <= w.right + 1 && r.top >= w.top - 1 && r.bottom <= w.bottom + 1,
    /** 窄窗口（≤1080）媒体查询会收成单月历，故按「可见面板」计数 */
    visibleMonthPanels: panels.length,
    perPanelDays: panels.map((p) => p.querySelectorAll('.drp-day').length),
    days: document.querySelectorAll('.drp-day').length,
    gridW: grid ? Math.round(grid.getBoundingClientRect().width) : null,
    presets: document.querySelectorAll('.drp-preset').length,
    confirmDisabled: (document.querySelector('.drp-confirm') as HTMLButtonElement | null)?.disabled ?? null,
  }
}

/** 筛选弹窗全链路（开 → 点预设 → 确认 → 重置 → Esc）：草稿制是否守住、确认是否生效、
 *  开关是否双通道，全在这里一次性量完（三档宽度各跑一遍）。 */
async function probeFilterPop(out: unknown[]): Promise<void> {
  const q = <T extends Element>(s: string) => document.querySelector<T>(s)
  const pillText = () => (q<HTMLButtonElement>('.pfilter-btn')?.textContent || '').trim()
  const preset = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.drp-preset')].find(
      (b) => (b.textContent || '').trim() === label,
    )

  q<HTMLButtonElement>('.pfilter-btn')?.click()
  await sleep(450)
  out.push({ ...measure('list-filter-pop'), filterPop: filterPopBox(), pill: pillText() })

  // 草稿制：点预设只动草稿 —— 触发器文案必须还是「筛选」（确认才生效）
  preset('近一周')?.click()
  await sleep(350)
  const draftPill = pillText()
  const draftMarked = !!q('.drp-preset.on')

  q<HTMLButtonElement>('.drp-confirm')?.click()
  await sleep(800)
  out.push({
    ...measure('list-filter-applied'),
    pill: pillText(),
    popOpen: !!q('.post-filter-pop'),
    draftPill,
    draftMarked,
  })

  // 复位（重置三项 + Esc 关窗）：不污染后续视图的量测
  q<HTMLButtonElement>('.pfilter-btn')?.click()
  await sleep(350)
  q<HTMLButtonElement>('.post-filter-pop .pop-actions button')?.click()
  await sleep(350)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await sleep(350)
  out.push({ ...measure('list-filter-reset'), pill: pillText(), popOpen: !!q('.post-filter-pop') })
}

/** 顶栏展示策略采样（2026-09-10）：把「后端事实」与「顶栏实际渲染」一起记下来，
 *  由 `scripts/ui_probe.py` 断言蕴含关系（自动节拍不得占顶栏）。 */
async function sampleTopbar() {
  const pill = document.querySelector('.topbar-status')
  const text = (pill?.textContent || '').trim()
  let st: {
    account?: { running?: boolean; auto?: boolean }
    post?: { running?: boolean; auto?: boolean }
    external?: { running?: boolean; label?: string | null }
    manual_running?: boolean
  } | null = null
  try {
    // 与 api.ts 同口径：dev 探针下后端是绝对地址（VITE_API_BASE），不是 /api 代理
    const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'
    const r = await fetch(`${base}/vtuber/fetch-status`)
    st = r.ok ? await r.json() : null
  } catch {
    st = null
  }
  return {
    pillText: text,
    /** 容器是否亮起（玫瑰徽章 = 「有事发生」） */
    pillOn: pill ? pill.classList.contains('on') : null,
    accountRunning: !!st?.account?.running,
    accountAuto: st?.account?.auto === true,
    postRunning: !!st?.post?.running,
    postAuto: st?.post?.auto === true,
    /** 外部第三方数据任务（收录回填 / 每日批次）——**探针起后端后它往往正在跑**，
     *  而顶栏**按设计**要显示它（`TopBar.tsx`：`busy = … || external.running`）。
     *  采样必须带上这一位，否则"自动节拍不得占顶栏"那条断言会把外部同步
     *  误判成自动节拍占了顶栏（2026-09-15 实测到的假失败）。 */
    externalRunning: !!st?.external?.running,
    externalLabel: st?.external?.label ?? null,
    manualRunning: st?.manual_running,
    ok: !!st,
  }
}

export async function runUiProbe(): Promise<void> {
  const out: unknown[] = []
  /**
   * 退化原因（2026-09-11 审计加固）：探针「跑成功」不等于「量到了」。
   * 以往若 `_first_vtuber` 拿不到 id（路由落到 `/`）或视图钮点不中，
   * 这里会静默少 emit 若干段，而 `scripts/ui_probe.py` 只看它拿到的段 ⇒
   * **断言全部空转却仍打印 [ok]**。现在把「没能按契约量到的东西」显式记下来，
   * 由脚本判失败（`_assert_probe_integrity`）。
   */
  const degraded: string[] = []
  await sleep(1600) // 首屏 + 预取稳定

  const clickView = (prefix: string) => {
    const btn = [...document.querySelectorAll<HTMLButtonElement>('.view-btn')].find((b) =>
      (b.title || '').startsWith(prefix),
    )
    btn?.click()
    return !!btn
  }

  /** 类型筛选胶囊（「全部 98」「投稿 72」…，按标签前缀点） */
  const clickChip = (label: string) => {
    const btn = [...document.querySelectorAll<HTMLButtonElement>('.type-chip')].find((b) =>
      (b.textContent || '').trim().startsWith(label),
    )
    btn?.click()
    return !!btn
  }

  // 短模式 `?probe=filter-pop[&preset=近一月]`：只切到列表视图 + 打开筛选弹窗
  // （可选点一个预设看区间色带）后停住，供 `scripts/ui_probe.py --shot` 截图存档视觉
  // （不产出断言 JSON）；`?probe=archive` 停在档案视图并把**直播日历每格实渲染文本**
  // 落进探针 JSON（排查「最近几场没信息」这类渲染缺口用，比看截图精确）。
  const mode = new URLSearchParams(window.location.search).get('probe')

  // 首启模式（`?probe=1&firstRun=1` + 路由 `/`）：空数据目录下没有选中任何 VTuber，
  // 页面上**本来就没有视图光条**。若照常走四视图量测，只会量到一段 empty + degraded，
  // 于是被 `_assert_probe_integrity` 判成三条失败 —— 而首启浮窗其实是好的
  // （2026-09-11 加固引入的**必然假失败**：`ui_probe.py --first-run` 从此恒退出 1）。
  //
  // 首启要验的不是布局不变量，而是「登录浮窗自动弹出 + 带凭据说明」，由脚本在
  // 落盘的 DOM 上断言（`_assert_first_run`）。所以这里显式声明 mode，不产 views。
  if (mode === 'first-run') {
    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'first-run', views: [], degraded })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  if (mode === 'archive') {
    const clicked = clickView('档案')
    await sleep(2200)
    if (!clicked) degraded.push('view:档案')
    const cells = [...document.querySelectorAll('.lc-cell')].map((c) => ({
      day: (c.querySelector('.lc-day')?.textContent || '').trim(),
      badge: (c.querySelector('.lc-badge')?.textContent || '').trim(),
      cls: c.className.replace('lc-cell', '').trim(),
      body: (c.querySelector('.lc-cell-body')?.textContent || '').trim(),
    }))
    // 端到端：点**最近一个**有场次的格子 → 等详情弹窗拉完数据 → 落弹窗实渲染文本。
    // 这一格正是「最近几场直播的信息展示不出来」的现场（详情弹窗弹幕/统计是否为空）。
    //
    // `?probe=archive&day=<N>`：改点**指定日号**的格子。用途很具体 —— 最近一场常常
    // 刚下播、danmakus 还没收录（`danmaku: null` ⇒ `cloudCells: 0`），于是探针
    // **看起来通过但词云/弹幕那几段等于没验**。要验词云就得回到几天前有收录的场次
    // （2026-09-13 抽 `LiveSessionDialog` 时踩到：最近一场 0 热词，整块弹幕区没被渲染）。
    const wantDay = new URLSearchParams(window.location.search).get('day')
    const allCells = [...document.querySelectorAll<HTMLElement>('.lc-cell')]
    const withBody = wantDay
      ? allCells.filter(
          (c) =>
            (c.querySelector('.lc-day')?.textContent || '').trim() === wantDay &&
            c.querySelector('.lc-cell-body'),
        )
      : allCells.filter((c) => c.querySelector('.lc-cell-body'))
    let detail: Record<string, unknown> | null = null
    if (withBody.length) {
      withBody[withBody.length - 1].click()
      await sleep(3000)
      // 当日多场时切到**最后一场**（= 最近那场；danmakus + feed 双源的合并场次正是
      // 「信息展示不出来」的高发区），再等它拉完详情
      const tabs = [...document.querySelectorAll<HTMLButtonElement>('.lc-dlg-tabs button')]
      if (tabs.length > 1) {
        tabs[tabs.length - 1].click()
      }
      // 弹幕/直播动态两格是**第二个异步跳**（2026-09-13 devlog/063：上游取数从详情端点
      // 拆成 `/live-sessions/{id}/upstream`），词云还要逐个入池。定长等待会在上游慢时
      // 量到"正在取上游弹幕…"、或在词云铺完前量到 `cloudCells: 0` —— 这正是 058/061
      // 记过的"看起来通过但弹幕那几段等于没验"。所以改成**等它落地并稳定**。
      await waitDetailSettled()
      const dlg = document.querySelector('.lc-dlg')
      if (dlg) {
        detail = {
          name: (dlg.querySelector('.lc-dlg-name')?.textContent || '').trim(),
          sub: (dlg.querySelector('.lc-dlg-sub')?.textContent || '').trim(),
          placeholders: [...dlg.querySelectorAll('.lc-dlg-ph')].map((n) =>
            (n.textContent || '').trim(),
          ),
          danmakuRows: [...dlg.querySelectorAll('.lc-dlg-danmaku .lc-dlg-row')].map((n) =>
            (n.textContent || '').replace(/\s+/g, ' ').trim(),
          ),
          cloudCells: dlg.querySelectorAll('.lc-dlg-cloud-cell').length,
          eventRows: dlg.querySelectorAll('.lc-dlg-evts .lc-dlg-evt').length,
        }
      }
    }
    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({
      mode: 'archive',
      views: [],
      degraded,
      calendar: {
        title: (document.querySelector('.lc-title')?.textContent || '').trim(),
        note: (document.querySelector('.lc-note')?.textContent || '').trim(),
        cells,
        detail,
      },
    })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }
  if (mode === 'scene') {
    // 场景切换机（`PostsPage` 的预取门控 + 原子提交）的**诊断 + 护栏**（devlog/080）。
    //
    // 背景：devlog/071 记过三次护栏尝试都失败 —— 点侧栏切 V 后路由与侧栏都切了、
    // 场景机也进了 `scene-exit`，但那个 200ms 的提交定时器在虚拟时间里**始终没落地**。
    // 当时分不清"探针环境"还是"真 bug"，于是把护栏整体撤了。
    // 这里不再猜：**把 fetch 全程记下来**（预取到底有没有回来）+ 记录 `.view-body`
    // 的 class 变化序列，一次跑完就能判定是哪一边的问题。
    const result: Record<string, unknown> = {}
    type Rec = { url: string; state: string; ok?: boolean; ms: number }
    const fetches: Rec[] = []
    const origFetch = window.fetch.bind(window)
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input
        : input instanceof URL ? input.href : (input as Request).url
      const rec: Rec = { url, state: 'pending', ms: -1 }
      fetches.push(rec)
      const t0 = performance.now()
      return origFetch(input as RequestInfo, init)
        .then((r) => {
          rec.state = 'done'; rec.ok = r.ok
          rec.ms = Math.round(performance.now() - t0)
          return r
        })
        .catch((e) => {
          rec.state = 'error'; rec.ms = Math.round(performance.now() - t0)
          throw e
        })
    }) as typeof window.fetch

    const waitFor = async (fn: () => unknown, ms = 8000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = fn()
        if (v) return v
        await sleep(50)
      }
      return null
    }
    const items = (await waitFor(() => {
      const list = document.querySelectorAll<HTMLElement>('.vtuber-item')
      return list.length >= 2 ? list : null
    })) as NodeListOf<HTMLElement> | null
    result.candidates = items ? items.length : 0
    const heroName = () => (document.querySelector('.hero-name')?.textContent || '').trim()
    /** 侧栏当前选中项的**V 名**（`.vtuber-name`，不是整条 item 的文本 ——
     *  后者含"直播中"徽章与签名，与 hero 名直接比较会假失败，devlog/080 踩过） */
    const activeName = () =>
      (document.querySelector('.vtuber-item.active .vtuber-name')?.textContent || '').trim()
    /** ⚠️ 每次都要**重新查询** `.view-body`：拿旧引用会被 React 换掉的节点骗到
     *  （旧节点上留着 `scene-exit`，看着像"永久卡在退场态"，实际早提交完了）。 */
    const bodyClass = () => document.querySelector('.view-body')?.className ?? ''
    result.heroBefore = heroName()
    result.heroLenBefore = heroName().length
    if (!items || items.length < 2) {
      result.reason = 'sidebar-too-small'
    } else {
      const cur = [...items].find((i) => i.classList.contains('active'))
      const target = [...items].find((i) => i !== cur) as HTMLElement
      const targetName = (target.querySelector('.vtuber-name')?.textContent || '').trim()
      result.targetName = targetName
      // class 变化序列：正常应是 ['view-body', 'view-body scene-exit', 'view-body']
      const seq: string[] = []
      const push = () => {
        const c = bodyClass()
        if (seq[seq.length - 1] !== c) seq.push(c)
      }
      push()
      new MutationObserver(push).observe(document.body, {
        attributes: true, attributeFilter: ['class'], subtree: true,
      })
      const t0 = performance.now()
      fetches.length = 0                          // 只记点击之后的请求
      target.click()
      let committedIn = -1
      for (let i = 0; i < 240; i++) {             // 上限 12s（虚拟时间下很快走完）
        await sleep(50)
        if (!bodyClass().includes('scene-exit') && heroName() &&
            heroName() !== result.heroBefore) {
          committedIn = Math.round(performance.now() - t0)
          break
        }
      }
      result.commitMs = committedIn
      await sleep(0)                              // 让 MutationObserver 把最后一跳记完
      result.bodySeq = seq
      result.bodyClassAtEnd = bodyClass()
      result.exitingAtEnd = bodyClass().includes('scene-exit')
      result.heroAtEnd = heroName()
      result.sidebarActiveAtEnd = activeName()
      result.routeAtEnd = location.pathname
      result.fetches = fetches.map((f) => {
        const path = f.url.replace(/^https?:\/\/[^/]+/, '')
        return `${f.state}${f.ok === false ? '(非2xx)' : ''} ${f.ms}ms ${path.slice(0, 70)}`
      })
      result.pendingFetches = fetches.filter((f) => f.state === 'pending').length
      // TEMP：场景机埋点（devlog/080 排查用，定位后随埋点一起删）
      result.sceneLog = (window as unknown as { __sceneLog?: unknown[] }).__sceneLog ?? []
    }
    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'scene', views: [], degraded, scene: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  if (mode === 'filter-pop') {
    const want = new URLSearchParams(window.location.search).get('preset')
    clickView('帖子列表')
    await sleep(1200)
    document.querySelector<HTMLButtonElement>('.pfilter-btn')?.click()
    await sleep(600)
    if (want) {
      const p = [...document.querySelectorAll<HTMLButtonElement>('.drp-preset')].find(
        (b) => (b.textContent || '').trim() === want,
      )
      p?.click()
      await sleep(600)
    }
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 添加 V 浮窗（`?probe=addv`，2026-09-14，devlog/083）：
  // 这个浮窗此前**没有探针覆盖**，而 R11 把它从"只有本地候选"扩成"本地 + B 站在线"——
  // 新增的恰好是**会产生上游请求**的东西，所以这里要盯的不是"好不好看"，而是三条：
  //   ① **敲键不打上游**（决策①：B 站检索只在显式触发时发生）——用 resource 计时条目
  //      数 `/vtuber/bili/search` 的请求数，必须为 0；本地检索必须 >0（证明真的检索了）；
  //   ② **看得见就要点得着**：结果行的 `elementFromPoint` 命中测试（命中被祖先吃掉
  //      在这类浮窗里出过不止一次）；
  //   ③ **UID 输入要换档**：纯数字 → 按钮文案变「按 UID 添加」（B 站搜索接口搜不到 uid，
  //      走的是 `acc/info` 精确通道，用户得能从按钮上看出来）。
  //
  // ⚠️ 探针**绝不点结果行**：点一下就是真收录 + 真抓取（会打上游、会写库）。
  //   也**绝不点「搜索 B 站」**：那是真实上游调用（风控预算）。
  if (mode === 'addv') {
    const result: Record<string, unknown> = {}
    const waitFor = async (fn: () => unknown, ms = 4000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = fn()
        if (v) return v
        await sleep(100)
      }
      return null
    }
    const hits = (el: HTMLElement | null, x: number, y: number) => {
      if (!el) return false
      const hit = document.elementFromPoint(x, y)
      return !!hit && (hit === el || el.contains(hit))
    }
    /** 上游请求计数（resource timing）：按路径数，不看响应内容 */
    const reqs = (frag: string) =>
      performance.getEntriesByType('resource')
        .filter((e) => e.name.includes(frag)).length
    /** 受控 input：必须走**原型上的 value setter**再派发 input，
     *  直接 `input.value = x` React 收不到（合成事件比对的是跟踪值） */
    const setVal = (el: HTMLInputElement, v: string) => {
      const desc = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(el) as object, 'value')
      desc?.set?.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }

    // 停掉动画/过渡：探针跑在虚拟时间下，入场 `zoom-in-95` 可能被冻在缩放中间态，
    // 矩形类断言会量到过渡值（档案设置那次实测冻在 scale .97，2026-09-13）
    const killAnim = document.createElement('style')
    killAnim.textContent =
      '*, *::before, *::after { animation: none !important; transition: none !important; }'
    document.head.appendChild(killAnim)

    await waitFor(() => document.querySelector('.list-add-btn'))
    const trigger = document.querySelector<HTMLElement>('.list-add-btn')
    result.hasTrigger = !!trigger
    trigger?.click()
    const dialog = (await waitFor(() => document.querySelector('.av-dialog'))) as HTMLElement | null
    result.opened = !!dialog
    if (!dialog) {
      result.reason = trigger ? 'dialog-not-opened' : 'no-add-trigger'
    } else {
      const input = dialog.querySelector<HTMLInputElement>('.av-input')
      const biliBtn = dialog.querySelector<HTMLElement>('.av-bili-btn')
      // 图标压字：左内距必须给 14px 的内嵌搜索图标留位（同 devlog/075 的 26px 判据）
      const padL = input ? parseFloat(getComputedStyle(input).paddingLeft) : 0
      result.inputLeftPad = input ? getComputedStyle(input).paddingLeft : null
      result.inputIconRoom = padL >= 20
      // 结果区必须是**覆盖式滚动条**（全站约定：原生滚动条不占布局宽度，出现/消失会挤动）
      result.listIsOverlayScroll = !!dialog.querySelector('.av-list.os-root > .os-scroll')
      // 空输入态：B 站钮必须禁用（没有关键词就没什么可搜的）+ 文案是"搜索 B 站"
      result.biliBtnDisabledWhenEmpty = !!biliBtn?.hasAttribute('disabled')
      result.biliBtnText = (biliBtn?.textContent || '').trim()

      // 找一个**本地确实有命中**的关键词（探针不猜数据：先问接口，问不到就跳过行断言）。
      // ⚠️ 必须走 `api.searchPool`（= 弹窗自己那条传输）：API base 在 dev 探针下是
      //    `VITE_API_BASE`（绝对地址），裸 `fetch('/vtuber/…')` 会打到 Vite 自己身上
      //    —— 第一次跑就踩了：4 个候选关键词全部"没命中"，其实是拿到了 index.html。
      let kw = ''
      for (const cand of ['a', 'i', 'o', '小']) {
        const r = await api.searchPool(cand).catch(() => [])
        if (Array.isArray(r) && r.length > 0) { kw = cand; break }
      }
      result.keyword = kw || null
      result.poolRequestsBeforeTyping = reqs('/vtuber/pool/search')
      if (!kw) {
        result.rowsSkipped = 'no-pool-hit'
      } else if (input) {
        setVal(input, kw)
        await waitFor(() => dialog.querySelectorAll('.av-row').length, 5000)
        const rows = [...dialog.querySelectorAll<HTMLElement>('.av-row')]
        result.rows = rows.length
        result.poolRequestsAfterTyping = reqs('/vtuber/pool/search')
        // ① 本地检索真的发生了（防抖 250ms 后前端确实发了请求）
        result.localSearchHappened =
          (result.poolRequestsAfterTyping as number) > (result.poolRequestsBeforeTyping as number)
        // ② 敲键**没有**打上游（决策①的机器判据）
        result.biliRequests = reqs('/vtuber/bili/search')
        result.noUpstreamOnTyping = result.biliRequests === 0
        // 行：本地候选不该有"已订阅"（后端已剔除），因此必须都可点
        result.rowsDisabled = rows.filter((r) => r.hasAttribute('disabled')).length
        const r0 = rows[0]?.getBoundingClientRect()
        result.rowHit = !!(r0 && hits(rows[0], r0.left + r0.width / 2, r0.top + r0.height / 2))
        result.rowHasUid = !!rows[0]?.getAttribute('data-uid')
      }
      // ③ UID 换档与清空：**不依赖关键词命中**（只跟输入框/按钮有关），所以放在
      //    "有没有候选"的判断之外 —— 否则本地池没命中时这两条也一起空转了。
      if (input) {
        setVal(input, '1265680561')
        await waitFor(() => (biliBtn?.textContent || '').includes('按 UID'), 3000)
        result.uidBtnText = (biliBtn?.textContent || '').trim()
        result.uidBtnEnabled = !!biliBtn && !biliBtn.hasAttribute('disabled')
        result.uidSwitchOk = result.uidBtnText === '按 UID 添加'
        // 清空钮：点一下要回到"还没搜过"的空态（B 站区块也跟着清，否则残留上次结果）
        dialog.querySelector<HTMLElement>('.av-clear')?.click()
        await sleep(300)
        result.clearOk = (input.value || '') === ''
        result.afterClearRows = dialog.querySelectorAll('.av-row').length
        result.afterClearHint = !!dialog.querySelector('.av-hint-row')
      }
      // 关窗：X 钮（`data-slot="dialog-close"`）
      dialog.querySelector<HTMLElement>('[data-slot="dialog-close"]')?.click()
      await waitFor(() => !document.querySelector('.av-dialog'), 3000)
      result.closed = !document.querySelector('.av-dialog')
      // 收尾再确认一次：整个探针全程一次上游都没打（点行/点按钮都被刻意避开了）
      result.biliRequestsTotal = reqs('/vtuber/bili/search')
    }
    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'addv', views: [], degraded, addv: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 档案设置弹窗（`?probe=settings`，2026-09-13，devlog/072；交互判据 devlog/075）：
  // 这个弹窗一直在探针覆盖面**之外**（devlog/067 记过"只能靠肉眼"），而它恰恰
  // 出过三类问题：① 覆盖式滚动条压住输入框右缘；② 面板/浮层越界被滚动体**静默裁掉**
  // （OverlayScroll 根是 overflow:hidden）；③ **面板看得见却点不着** —— portal 到 body
  // 后继承了 radix 给 body 的 `pointer-events:none`，hover 与点击全部失灵且不报错。
  //
  // 所以这里除了几何，还要量**能不能真的点到**（`elementFromPoint` 命中测试 + 真派发一次
  // 点击走完 handler），后者是 ③ 的唯一机器判据：几何断言在 ③ 面前全绿。
  //   `chevronInside`  —— 内嵌 chevron 是否完整落在输入框矩形内（位置类错误）
  //   `panelSameWidth` —— 面板宽度是否等于输入条宽度（参考图的结构关系）
  //   `panelClipped`   —— 面板矩形是否越出视口（越界＝会被裁）
  //   `panelPlacement` —— 面板左缘/上缘是否就在输入条下方（相对包含块算错会立刻错位）
  //   `panelHit` / `rowHit` —— 面板与候选行的命中测试（pointer-events 是否被吃掉）
  //   `pickKeepsDialog` / `pickValueMatches` —— 点一行是否真的选中且**没有把弹窗关掉**
  //   `rows` / `ovfRows` —— 候选行数 / 其中判定为"文字溢出"的行数
  //   `panelWidthWhenClosed` —— 收起态不该存在面板（-1 表示确实没有）
  if (mode === 'settings') {
    const result: Record<string, unknown> = {}
    /** 轮询等到条件成立（布局/挂载类等待不要在虚拟时间下"睡固定时长"） */
    const waitFor = async (fn: () => unknown, ms = 4000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = fn()
        if (v) return v
        await sleep(100)
      }
      return null
    }
    /** 命中测试：某点上的元素是否落在 el 之内（吃 pointer-events 时必然为 false） */
    const hits = (el: HTMLElement | null, x: number, y: number) => {
      if (!el) return false
      const hit = document.elementFromPoint(x, y)
      return !!hit && (hit === el || el.contains(hit))
    }
    await waitFor(() => document.querySelector('.bg-set'))
    // 关掉动画与过渡再量：弹窗入场是 `zoom-in-95`（transform 缩放），而探针跑在
    // **虚拟时间**下 —— 预算用完时动画会被冻在中途（实测冻在 scale .97），于是
    // "面板同宽/贴输入条下方"这类断言会间歇性失败（量到的是过渡中间态，不是稳态）。
    // 这里量的是**布局关系**，不是动画本身，所以直接停掉最稳。
    const killAnim = document.createElement('style')
    killAnim.textContent =
      '*, *::before, *::after { animation: none !important; transition: none !important; }'
    document.head.appendChild(killAnim)
    const trigger = document.querySelector<HTMLElement>('.bg-set')
    result.hasTrigger = !!trigger
    trigger?.click()
    const dialog = (await waitFor(() => document.querySelector('.vd-settings'))) as HTMLElement | null
    result.hasDialog = !!dialog
    if (!dialog) {
      result.reason = trigger ? 'dialog-not-opened' : 'no-settings-trigger'
    } else {
      const input = dialog.querySelector<HTMLInputElement>('.vd-sign-field input')
      const toggle = dialog.querySelector<HTMLElement>('.vd-sign-toggle')
      const closedPanel = dialog.querySelector<HTMLElement>('.vd-sign-panel')
      result.panelWidthWhenClosed = closedPanel ? closedPanel.getBoundingClientRect().width : -1
      toggle?.click()                       // 展开候选面板
      await waitFor(() => document.querySelector('.vd-sign-panel'), 2000)
      // 面板有 `transition: all`（全局）+ 弹窗有入场动画 ⇒ 出现≠就位。
      // 等两帧矩形一致再量，否则量到的是过渡中间态（实测：同宽断言偶发 False）。
      let settled: DOMRect | null = null
      for (let i = 0; i < 20; i++) {
        const r = document.querySelector('.vd-sign-panel')?.getBoundingClientRect() ?? null
        if (r && settled && Math.abs(r.width - settled.width) < 0.3 &&
            Math.abs(r.top - settled.top) < 0.3 && Math.abs(r.left - settled.left) < 0.3) break
        settled = r
        await sleep(60)
      }
      const panel = document.querySelector<HTMLElement>('.vd-sign-panel')
      const rect = (el: HTMLElement | null) => el?.getBoundingClientRect() ?? null
      const ri = rect(input); const rt = rect(toggle)
      const rp = rect(panel); const rd = rect(dialog)
      result.hasToggle = !!toggle
      result.rows = panel ? panel.querySelectorAll('.vd-sign-opt').length : -1
      result.ovfRows = panel ? panel.querySelectorAll('.vd-sign-text.ovf').length : -1
      const firstText = panel?.querySelector<HTMLElement>('.vd-sign-text')
      result.firstTextScrollable = firstText
        ? firstText.scrollWidth - firstText.clientWidth : -1
      result.chevronInside = !!(ri && rt &&
        rt.left >= ri.left - 0.5 && rt.right <= ri.right + 0.5 &&
        rt.top >= ri.top - 0.5 && rt.bottom <= ri.bottom + 0.5)
      // 同宽看**布局宽**（offsetWidth）而不是视觉矩形：布局关系与 transform 无关，
      // 缩放态下矩形会同比缩小，拿矩形比会把动画中间态误判成"不同宽"。
      result.panelSameWidth = !!(input && panel &&
        Math.abs(input.offsetWidth - panel.offsetWidth) <= 1)
      result.inputWidth = input ? input.offsetWidth : null
      result.panelWidth = panel ? panel.offsetWidth : null
      // 三个矩形原样落进 JSON：定位类问题（算错包含块/越界/被顶飞）看这几对数最快
      const round4 = (r: DOMRect | null) => (r ? {
        left: Math.round(r.left * 10) / 10, top: Math.round(r.top * 10) / 10,
        right: Math.round(r.right * 10) / 10, bottom: Math.round(r.bottom * 10) / 10,
      } : null)
      result.inputRect = round4(ri)
      result.panelRect = round4(rp)
      result.dialogRect = round4(rd)
      result.panelOffsetParentIsDialog = !!panel && panel.offsetParent === dialog
      result.viewport = {
        w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio,
      }
      result.panelStyleInline = panel?.getAttribute('style') ?? null
      // 布局尺寸 vs 视觉尺寸：两者不等 = 祖先（或自身）在缩放/动画中
      result.panelLayoutWidth = panel?.offsetWidth ?? null
      result.inputLayoutWidth = input?.offsetWidth ?? null
      result.panelComputed = panel ? {
        width: getComputedStyle(panel).width,
        transform: getComputedStyle(panel).transform,
        transition: getComputedStyle(panel).transitionProperty,
        boxSizing: getComputedStyle(panel).boxSizing,
      } : null
      // 面板是 **弹窗内容体的绝对定位子元素**（在滚动体之外，2026-09-13 第三次改版）：
      // 越界判据是"是否出**视口**"；"浮层而不参与布局"用**结构 + 相对位置**断言。
      result.panelClipped = !!(rp && (
        rp.left < -0.5 || rp.top < -0.5 ||
        rp.right > window.innerWidth + 0.5 || rp.bottom > window.innerHeight + 0.5))
      result.panelOverContent = !!(rp && rd && rp.top < rd.bottom - 0.5)
      result.panelPosition = panel ? getComputedStyle(panel).position : null
      result.panelParentIsDialog = !!panel && panel.parentElement === dialog
      const scroller = dialog.querySelector<HTMLElement>('.vd-settings-scroll')
      result.panelOutsideScroller = !!panel && !!scroller && !scroller.contains(panel)
      // 相对包含块的位置：左缘/宽度跟输入条一致，上缘贴其下 6px（翻转时在上方）
      result.panelPlacedByRect = !!(ri && rp &&
        Math.abs(rp.left - ri.left) <= 1.5 &&
        (Math.abs(rp.top - (ri.bottom + 6)) <= 1.5 || rp.bottom <= ri.top - 5 + 1.5))
      // 命中测试：面板空白处与首行中心都必须真的能命中所属元素
      result.panelHit = !!(rp && hits(panel, rp.left + 4, rp.top + 4))
      const rows = panel ? Array.from(panel.querySelectorAll<HTMLElement>('.vd-sign-opt')) : []
      const rr = rows[0] ? rows[0].getBoundingClientRect() : null
      result.rowHit = !!(rr && hits(rows[0], rr.left + rr.width / 2, rr.top + rr.height / 2))
      result.inputRightPad = input ? getComputedStyle(input).paddingRight : null
      // 再点一次同一个按钮必须**收起**（2026-09-13 用户反馈：
      // 之前 mousedown 把它判成"外部"先关、click 又打开 ⇒ 看着闪一下没关）。
      toggle?.click()
      await sleep(120)
      result.toggleClosedOk = !document.querySelector('.vd-sign-panel')
      toggle?.click()
      await sleep(120)
      result.toggleReopenOk = !!document.querySelector('.vd-sign-panel')
      result.openPanelCount = document.querySelectorAll('.vd-sign-panel').length

      // 真点一行：模拟 pointerdown→mousedown→mouseup→click（radix 的"点了外面"判定
      // 走的就是 pointerdown + 延后到 click，所以只派发 click 测不出 ②/③ 类回归）。
      const opened = document.querySelector<HTMLElement>('.vd-sign-panel')
      const liveRows = opened
        ? Array.from(opened.querySelectorAll<HTMLElement>('.vd-sign-opt')) : []
      const activeRow = liveRows.find((r) => r.classList.contains('on')) ?? null
      // 签名里可能有换行/连续空白（平台签名常见两行）。比较前**去掉所有空白**：
      // `<input>` 的取值算法会**吃掉换行**（不是换成空格），所以"折叠成空格"会比不上
      // （实测：行文本 `Nana7mi 商务合作` vs 输入框 `Nana7mi商务合作`）。
      const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '')
      const text = (r: HTMLElement | null) =>
        norm(r?.querySelector('.vd-sign-text')?.textContent)
      const before = input?.value ?? ''
      const target = liveRows.find((r) => r !== activeRow) ?? activeRow
      result.pickTargetIsOther = !!target && target !== activeRow
      // 只有一个带签名的账号（如 V14）时没有"另一行"可点：此时**跳过**切换断言，
      // 而不是判失败 —— 那是合法的数据形态。命中测试与收起行为仍然照常断言。
      result.pickSkipped = liveRows.length < 2 ? 'single-row' : null
      result.pickTargetText = text(target)
      if (target) {
        target.dispatchEvent(new PointerEvent('pointerdown',
          { bubbles: true, cancelable: true, button: 0, pointerId: 1 }))
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
        target.click()
        await waitFor(() => !document.querySelector('.vd-sign-panel'), 4000)
      }
      result.pickClosedPanel = !document.querySelector('.vd-sign-panel')
      result.pickKeepsDialog = !!document.querySelector('.vd-settings')
      result.pickedValue = input?.value ?? null
      result.pickValueMatches = !!target && norm(input?.value) === text(target)
      result.pickChanged = (input?.value ?? '') !== before
      // 还原成"打开面板时生效的那一行"（探针不该在数据目录里留下"来源被换过"的副作用）。
      // 注意：没有任何行是 `.on` 时，生效值来自主账号的默认回退 → 用它那行还原。
      const heroRow = liveRows.find((r) => r.querySelector('.vd-sign-plat em')) ?? null
      const restoreRow = activeRow ?? heroRow
      result.restoreVia = activeRow ? 'active-row' : (heroRow ? 'hero-row' : 'none')
      if (restoreRow && result.pickChanged) {
        toggle?.click()
        await waitFor(() => document.querySelector('.vd-sign-panel'), 2000)
        const back = Array.from(document.querySelectorAll<HTMLElement>('.vd-sign-opt'))
          .find((r) => text(r) === text(restoreRow))
        if (back) {
          back.dispatchEvent(new PointerEvent('pointerdown',
            { bubbles: true, cancelable: true, button: 0, pointerId: 2 }))
          back.click()
          await waitFor(() => !document.querySelector('.vd-sign-panel'), 4000)
        }
        result.restoredSource = norm(input?.value) === text(restoreRow)
      }

      // 账号信息历史弹窗（R9，devlog/080）：点账号行的历史钮 → 弹窗要真的打开**且拿到数据**。
      // 这一条挡的是"接了线但没数据/没渲染"这类问题（端点两个、异步两段，光看代码看不出）。
      const histBtn = dialog.querySelector<HTMLElement>('.vd-acc-hist')
      result.hasHistoryBtn = !!histBtn
      if (histBtn) {
        histBtn.click()
        await waitFor(() => document.querySelector('.ah-dialog'), 3000)
        const ah = document.querySelector<HTMLElement>('.ah-dialog')
        result.historyOpened = !!ah
        await waitFor(() => ah?.querySelector('.ah-snap, .ah-empty, .ah-note'), 4000)
        result.historyFormerRows = ah?.querySelectorAll('.ah-former > li').length ?? -1
        result.historySnapRows = ah?.querySelectorAll('.ah-snap').length ?? -1
        result.historyEmpty = !!ah?.querySelector('.ah-empty')
        result.settingsStillOpen = !!document.querySelector('.vd-settings')
        ah?.querySelector<HTMLElement>('.ah-close')?.click()
        await sleep(250)
        result.historyClosed = !document.querySelector('.ah-dialog')
      }
    }
    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'settings', views: [], degraded, settings: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  if (!document.querySelector('.view-btn')) {
    // 走到这里 = 页面上没有视图光条。两种可能，都不能当「量过了」：
    //  ① 路由落在 `/`（没有选中 VTuber，通常是 `_first_vtuber` 失败）；
    //  ② 选中了 VTuber 但视图钮没渲染出来（真 bug）。
    // 显式标成 empty + degraded，由脚本判失败。
    degraded.push('no-view-btn')
    out.push(measure('empty'))
  } else {
    for (const v of VIEWS) {
      if (!clickView(v.title)) degraded.push(`view:${v.key}`)
      await sleep(900) // 场景入场 0.22s + 数据到位
      out.push(measure(v.key))
      if (v.key === 'list') {
        await probeFilterPop(out) // P10-A 筛选弹窗全链路
        if (clickChip('投稿')) {
          // 投稿页单独量一遍：这一页最容易被「标题/摘要里的长串」把列宽带偏
          await sleep(900)
          out.push(measure('list-video'))
        } else {
          degraded.push('chip:投稿')
        }
      }
    }
  }

  const pre = document.createElement('pre')
  pre.id = 'ui-probe'
  const topbar = await sampleTopbar()
  pre.textContent = JSON.stringify({ mode: 'main', views: out, topbar, degraded })
  document.body.appendChild(pre)
  document.title = 'UI_PROBE_DONE'
}
