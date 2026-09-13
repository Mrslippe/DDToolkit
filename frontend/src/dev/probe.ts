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
