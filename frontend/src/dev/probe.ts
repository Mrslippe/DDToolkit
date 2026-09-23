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
import { api, getApiBase } from '../api/api'
import { setShellHidden } from '../utils/shellLifecycle'

interface ProbeView {
  key: string
  /** 视图切换按钮的 title 前缀（PostsPage 光条） */
  title: string
}

const VIEWS: ProbeView[] = [
  { key: 'archive', title: '数据视图' },
  { key: 'cards', title: '展示页' },
  { key: 'list', title: '帖子列表' },
  { key: 'profile', title: '档案视图' },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 上游取数还没落地时，弹窗里会出现的文案（见 `LiveSessionDialog` 的 waitHint） */
const UPSTREAM_PENDING_RE = /正在取上游弹幕|上游响应较慢/

/**
 * 把所有在飞的过渡**直接推到终点**（`Animation.finish()`）—— 量几何之前必须调。
 *
 * ⚠️ 为什么需要：无头浏览器在 `--virtual-time-budget` 下**过渡不推进**
 * （`getAnimations().currentTime` 恒 0），于是卡片永远停在动画起点那一帧 ——
 * 这时候量 `getBoundingClientRect()` 得到的是**动画起点**而不是布局位置
 * （R37-P4c 的"零重叠"断言就这么被误判过一次：被挤开的卡片还停在原位，
 * 看上去像和拖动卡重叠了）。把它推完，尺子量的才是布局。没有过渡时是空操作。
 */
function settleTransforms(): void {
  for (const node of document.querySelectorAll<HTMLElement>('.pcard')) {
    for (const a of node.getAnimations()) {
      try { a.finish() } catch { /* 有的动画不可 finish（无限循环之类）：忽略 */ }
    }
  }
}

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
        // R36 起"未到位"不再靠文案表达（改成同尺寸骨架）⇒ 骨架标记同样算"没落地"
        || !!dlg.querySelector('[data-pending="1"]')
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
    /** 档案视图（profile）的卡片画布（R37-P1，devlog/141）—— 与列表/hero 同款的常驻量测。
     *
     *  为什么必须量：网格是**自研**的（没用 react-grid-layout），每张卡的位置与高度都由
     *  `layoutModel` 算出来 ⇒ 算错了（重叠 / 越界 / 高度与行数不符）在界面上"看着也能忍"，
     *  但它正是"用户以后能自己排布卡片"的地基。这里把每张卡的 kind / 格位 / 实渲染几何抽出来，
     *  由 `scripts/ui_probe.py::_assert_board` 对账（含**窄窗单列**这条跨宽度不变量）。
     *
     *  R37-P4a 追加（规格 `docs/design-archive-cards.md`）：**材质**（圆角/阴影/去发丝边）、
     *  **贴纸角标**（每卡一枚、在右上象限、有白环）、**内容不裁切**（正文溢出会静默消失，
     *  正是最该拦下的那类失败）。 */
    board: (() => {
      const grid = document.querySelector<HTMLElement>('[data-board]')
      if (!grid) return null
      const gr = grid.getBoundingClientRect()
      const cards = [...grid.querySelectorAll<HTMLElement>('.pcard')].map((c) => {
        const r = c.getBoundingClientRect()
        const cs = getComputedStyle(c)
        const body = c.querySelector<HTMLElement>('.pcard-body')
        const badge = c.querySelector<HTMLElement>('[data-card-badge]')
        const br = badge?.getBoundingClientRect()
        const bcs = badge ? getComputedStyle(badge) : null
        const hero = c.querySelector<HTMLElement>('[data-anniv-hero]')
        return {
          kind: c.getAttribute('data-card-kind'),
          h: Number(c.getAttribute('data-card-h') ?? 0),
          hpx: Number(c.getAttribute('data-card-hpx') ?? 0),
          /** 该卡默认行数（注册表下发）：只有"不小于默认高度"时才要求内容不裁切 */
          minH: Number(c.getAttribute('data-card-min-h') ?? 0),
          /** 相对网格左上角的位置（越界判定用） */
          x: Math.round(r.left - gr.left),
          y: Math.round(r.top - gr.top),
          w: Math.round(r.width),
          hh: Math.round(r.height),
          col: cs.gridColumnStart,
          row: cs.gridRowStart,
          /** 卡片**内容**的粗采样（R37-P1）：防"卡片挂上了但里面什么都没渲染"这种
           *  静默失败 —— 空态文案也是内容，但必须是**明说**的那一种（`.pcard-empty`）。 */
          rows: c.querySelectorAll('.anniv-row, .rp-card, .tl-node').length,
          rowLabels: [...c.querySelectorAll('.anniv-label')].map((n) => (n.textContent || '').trim()),
          rowValues: [...c.querySelectorAll('.anniv-value')].map((n) => (n.textContent || '').trim()),
          hint: (c.querySelector('.anniv-hint, .rp-hint, .tl-hint')?.textContent || '').trim(),
          emptyText: (c.querySelector('.pcard-empty')?.textContent || '').trim(),
          pending: !!c.querySelector('[data-pending="1"]'),
          /** ── R37-P4a：材质 / 贴纸角标 / 内容不裁切 ───────────────────── */
          radius: Math.round((parseFloat(cs.borderTopLeftRadius) || 0) * 10) / 10,
          borderW: parseFloat(cs.borderTopWidth) || 0,
          shadow: cs.boxShadow,
          /** 正文溢出量（>1px 即"内容被裁掉了却不说"，只在 ≥ 默认高度时判失败） */
          overH: body ? body.scrollHeight - body.clientHeight : null,
          overW: body ? body.scrollWidth - body.clientWidth : null,
          badge: badge && br && bcs ? {
            tone: badge.getAttribute('data-tone'),
            w: Math.round(br.width),
            h: Math.round(br.height),
            /** 角标中心相对卡片的位置（判"在右上象限"） */
            cx: Math.round(br.left - r.left + br.width / 2),
            cy: Math.round(br.top - r.top + br.height / 2),
            icon: !!badge.querySelector('svg'),
            bg: bcs.backgroundColor,
            ring: bcs.boxShadow,
          } : null,
          /** 纪念日 hero（规格 §4.1）：没有可信数字时**必须没有这个节点** */
          hero: hero ? {
            value: (hero.querySelector('.anniv-hero-value')?.textContent || '').trim(),
            caption: (hero.querySelector('.anniv-hero-caption')?.textContent || '').trim(),
          } : null,
          /** 大事记**时间轴**（R42 改成横线 + 刻度；规格 §4.3 的竖脊线那版已废）：
           *  量横线的**实渲染高度**，而不是"节点在不在"（后者连 `display:none` 都拦不住） */
          spine: (() => {
            const line = c.querySelector<HTMLElement>('.tl-line')
            return line ? Math.round(parseFloat(getComputedStyle(line).height) || 0) : 0
          })(),
          dots: c.querySelectorAll('.tl-dot').length,
          /** 行尾锚点：随机投稿是封面上的播放数（`.rp-plays`），时间轴是刻度下的日期（`.tl-date`） */
          chips: [...c.querySelectorAll('.rp-plays, .tl-date')]
            .map((n) => n.getAttribute('data-tone') ?? n.getAttribute('data-metric') ?? 'plain'),
          /** 随机投稿：封面占卡片高度的百分比（用户口径「让封面更大更明显」） */
          coverRatio: [...c.querySelectorAll<HTMLElement>('.rp-card')].map((card) => {
            const box = card.getBoundingClientRect()
            const img = card.querySelector('img')?.getBoundingClientRect()
            return box.height ? Math.round(((img?.height ?? 0) / box.height) * 100) : 0
          }),
        }
      })
      return {
        cols: Number(grid.getAttribute('data-board-cols') ?? 0),
        /** 模型自己的窄窗阈值（跨语言契约：TS 下发、Python 按它判，别各写一份数字） */
        narrowPx: Number(grid.getAttribute('data-board-narrow') ?? 0),
        /** 卡片圆角：直接读 **CSS 令牌**（单源在 tokens.css）——
         *  探针不另写一个 12，TS 也不下发一份，两处数字没有漂的机会 */
        radius: parseFloat(getComputedStyle(document.documentElement)
          .getPropertyValue('--pcard-radius')) || 0,
        gridW: Math.round(gr.width),
        narrow: grid.classList.contains('narrow'),
        cards,
      }
    })(),
    /** 视图切换光条 + 亮点指示器 + 顶部渐隐（R39-D，用户 2026-09-19）——
     *  「光条边缘羽化不要有明显分界线」「一个亮点追随当前切换的按钮」「被裁切的卡片要有个解释」。
     *  三件事都只在"看着对不对"的层面，所以全部量化：光条背景是 2D 径向（不是带硬边的线性格）、
     *  亮点中心与激活钮中心对齐、亮点不吃点击、滚动体顶部在滚下去之后才有渐隐 mask。 */
    glow: (() => {
      const bar = document.querySelector<HTMLElement>('.glow-bar')
      if (!bar) return null
      const spot = bar.querySelector<HTMLElement>('.glow-spot')
      const active = bar.querySelector<HTMLElement>('.view-btn.on')
      const br = bar.getBoundingClientRect()
      // ⚠️ 量亮点之前**先杀掉过渡**（本仓老招，见 `--settings`/chevron 两处先例）：
      // 虚拟时间下过渡不推进，`getBoundingClientRect()` 会一直报**过渡起点** ——
      // 那样"亮点跟过去了没有"就变成了尺子问题（实测踩到过：只有一步量到旧位置）。
      const kill = document.createElement('style')
      kill.textContent = '.glow-spot{transition:none !important}'
      document.head.appendChild(kill)
      void spot?.getBoundingClientRect()          // 强制重排，让计算样式落到终值
      const sr = spot?.getBoundingClientRect()
      const ar = active?.getBoundingClientRect()
      const bcs = getComputedStyle(bar)
      const scs = spot ? getComputedStyle(spot) : null
      kill.remove()
      const scroller = document.querySelector<HTMLElement>('.scene-body .os-scroll, .archive-view .os-scroll, .board-view .os-scroll, .list-scroll .os-scroll, .hero-scroll .os-scroll')
      const root = scroller?.closest<HTMLElement>('.os-root')
      // R39-D4：选中块**不许盖住激活图标**。`.glow-spot` 是绝对定位元素，按绘制顺序画在
      // in-flow 的按钮之上 —— 白柔光那版表现为"把激活图标洗淡"，不透明粉底那版表现为
      // "块里什么都没有"（实测截图上整块空白）。常规命中测试**看不出**这个错：
      // 块平时 `pointer-events:none`，elementFromPoint 会绕过它。所以这里临时把它打开
      // 再问一次 —— 打开后仍命中的是按钮，才说明按钮真的画在上面。
      let coversIcon: boolean | null = null
      if (spot && active && ar) {
        // ⚠️ **R45：必须临时把整条打开，不能只打开选中块。**
        // 这条判据问的是**绘制顺序**（块有没有盖住图标），而绘制顺序只有在
        // **两者都可命中**时才观测得到。R45 之前工具条常驻 ⇒ 天然可命中，只打开块就够；
        // R45 之后 rest 态整条是 `pointer-events:none`（按需出现）⇒ 只打开块的话，
        // `elementFromPoint` 命中的必然是块本身 ⇒ **假阳性**"块盖住了图标"
        // （实测：默认三档里 archive 视图报红，而它其实没问题 —— 那一点上恰好没有
        //  别的可命中元素来"接住"这次命中）。
        const prevBarPe = bar.style.pointerEvents
        const prevPe = spot.style.pointerEvents
        bar.style.pointerEvents = 'auto'
        spot.style.pointerEvents = 'auto'
        const hit = document.elementFromPoint(ar.left + ar.width / 2, ar.top + ar.height / 2)
        coversIcon = !!hit && (hit === spot || spot.contains(hit))
        bar.style.pointerEvents = prevBarPe
        spot.style.pointerEvents = prevPe
      }
      // ── R45：页面工具条（overlay + 按需出现）─────────────────────────────
      const toolbar = document.querySelector<HTMLElement>('.view-toolbar')
      const tcs = toolbar ? getComputedStyle(toolbar) : null
      const panel = document.querySelector<HTMLElement>('.posts-panel')
      const vbody = document.querySelector<HTMLElement>('.view-body')
      const tools = document.querySelector<HTMLElement>('.bg-tools')
      const toolsR = tools?.getBoundingClientRect()
      const btn0 = bar.querySelector<HTMLElement>('.view-btn')
      const btn0R = btn0?.getBoundingClientRect()
      /** 内容控件的实矩形 —— **"工具条不许压住它们"是机器判据**（用户口径：
       *  账号切换 / 分类切换 / 搜索筛选必须**最直接可触及**）。
       *  只在列表视图存在；其它视图为空数组（判据自动跳过）。 */
      const contentRects = ['.acc-switch-btn', '.type-chip', '.search-float']
        .flatMap((sel) => [...document.querySelectorAll<HTMLElement>(sel)])
        .map((el) => {
          const r = el.getBoundingClientRect()
          return {
            sel: (el.className || '').split(' ')[0] || el.tagName.toLowerCase(),
            x: Math.round(r.left),
            y: Math.round(r.top),
            w: Math.round(r.width),
            h: Math.round(r.height),
          }
        })
      const offBtn = bar.querySelector<HTMLElement>('.view-btn.off')
      return {
        barBg: bcs.backgroundImage,
        /** 毛玻璃（R39-D3）：`backdrop-filter` + 极轻白 + 圆角 + 内描边 = "明确的形状" */
        barBackdrop: bcs.backdropFilter || (bcs as unknown as { webkitBackdropFilter?: string })
          .webkitBackdropFilter || 'none',
        barBgColor: bcs.backgroundColor,
        /** 光条实矩形（CSS px）：像素分析脚本按它去截图上取边缘剖面 —— 
         *  "边缘还有没有一条线"最终只有量像素才算数 */
        barRect: { x: Math.round(br.left), y: Math.round(br.top),
                   w: Math.round(br.width), h: Math.round(br.height) },
        barRadius: bcs.borderTopLeftRadius,
        barShadow: bcs.boxShadow,
        barBorder: bcs.borderTopWidth,
        spot: spot ? {
          /** 中心相对光条中心的偏移（应与激活钮一致） */
          cx: sr ? Math.round(sr.left + sr.width / 2 - br.left) : null,
          activeCx: ar ? Math.round(ar.left + ar.width / 2 - br.left) : null,
          w: sr ? Math.round(sr.width) : null,
          /** **提交值**（内联 transform）：与 rect 一起看，能分辨"状态没跟上"和"尺子读不到" */
          inline: spot.style.transform || '',
          activeOffsetLeft: active?.offsetLeft ?? null,
          pointerEvents: scs?.pointerEvents ?? null,
          transitionProp: scs?.transitionProperty ?? null,
          transitionMs: Math.round((parseFloat(scs?.transitionDuration || '0') || 0) * 1000),
          /** R39-D4：选中块的外观口径 —— 必须是**不透明填充**、且**不是渐变**。
           *  白光/半透明在默认背景（近白）上看不见，是这次返工要根治的病，故写成判据。 */
          bgImage: scs?.backgroundImage ?? null,
          bgColor: scs?.backgroundColor ?? null,
          radius: scs?.borderTopLeftRadius ?? null,
          /** R39-D4：选中块是否**盖住了激活图标**（绘制顺序）。判据见上面 coversIcon 的注释。 */
          coversIcon,
          /** 激活钮的绘制层级（必须参与定位层：static/auto 会被绝对定位的块盖住） */
          btnPosition: active ? getComputedStyle(active).position : null,
          btnZIndex: active ? getComputedStyle(active).zIndex : null,
        } : null,
        /** 顶部渐隐：只有"确实有内容被遮住"（滚下去了）才挂 mask */
        scrolled: root?.getAttribute('data-scrolled') ?? null,
        /** 本视图**有没有滚动体**：R40 起数据视图是牌堆、页面不滚动 ⇒ 没有 scroller 是合法的，
         *  但"有 scroller 就必须有 data-scrolled 开关"这条不变 */
        hasScroller: !!scroller,
        /** 数据视图必须是牌堆（R40） */
        deckPresent: !!document.querySelector('[data-deck]'),
        mask: scroller ? getComputedStyle(scroller).maskImage : null,
        // ── R45：页面工具条（overlay + 按需出现）──────────────────────────
        /** 工具条本体高度：**必须是 0** —— 它是 overlay，不许占布局。
         *  非 0 就说明"隐藏"只是"看不见"，66px 还在占位（本次改造的全部意义所在）。 */
        toolbarH: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : null,
        toolbarShown: toolbar?.getAttribute('data-shown') ?? null,
        toolbarPE: tcs?.pointerEvents ?? null,
        /** 面板高 / 内容区高：overlay 成立 ⇒ 两者应相等（内容吃满整高） */
        panelH: panel ? Math.round(panel.getBoundingClientRect().height) : null,
        bodyH: vbody ? Math.round(vbody.getBoundingClientRect().height) : null,
        /** rest 态：必须不可见 **且不吃指针**（吃了就会挡住内容点击/滚轮） */
        barOpacity: Math.round((parseFloat(bcs.opacity) || 0) * 100) / 100,
        barPE: bcs.pointerEvents,
        /** 视图钮尺寸（与选中块的**相对关系**由 ui_probe 判，不写死绝对数） */
        btnW: btn0R ? Math.round(btn0R.width) : null,
        btnH: btn0R ? Math.round(btn0R.height) : null,
        /** 右上组（`.bg-tools`）矩形 */
        toolsRect: toolsR
          ? {
              x: Math.round(toolsR.left),
              y: Math.round(toolsR.top),
              w: Math.round(toolsR.width),
              h: Math.round(toolsR.height),
            }
          : null,
        /** 内容控件矩形（"不相交"判据的对手方） */
        contentRects,
        /** `.view-btn.off` 的**实际**不透明度与图标色：非文本对比 ≥3:1 的输入。
         *  不写死 0.7 —— 算的是渲染值，改 CSS 也拦得住。 */
        offOpacity: offBtn
          ? Math.round((parseFloat(getComputedStyle(offBtn).opacity) || 0) * 100) / 100
          : null,
        /** 图标色走 `currentColor` 继承（`body { color: var(--c-text-main) }`） */
        offColor: offBtn ? getComputedStyle(offBtn).color : null,
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

/**
 * 数据视图「一次一张卡」牌堆（R40，用户 2026-09-19）。
 *
 * 这条探针守的是**四件最容易做坏的事**：
 *   ① 方向语义（向下滚 = 前进到下一张；向上滚 = 退回上一张）；
 *   ② **快拨要跟手**（鼠标离散格每格一张 —— 用户当场质疑过"120ms 静默分界会不会卡手"，
 *      所以这里必须有"4 格连拨至少前进 3 张"这条判据）；
 *   ③ **触控板惯性尾巴不许连跳**（连续小流一次手势只切一张）；
 *   ④ 静止终态与无障碍（前卡居中且可命中、非前卡 inert + aria-hidden）。
 *
 * ⚠️ 虚拟时间下 CSS 过渡不推进（本仓老规矩）⇒ 断言分三层：
 *   提交值（`data-deck-index` / `data-deck-phase`）+ 过渡注册（computed transition-duration）
 *   + `settleTransforms()` 之后的**静止终态**几何。
 */
async function probeDeck(out: unknown[]): Promise<void> {
  const deck = () => document.querySelector<HTMLElement>('[data-deck]')
  const cards = () => [...document.querySelectorAll<HTMLElement>('[data-deck-card]')]
  const front = () => cards().find((c) => c.getAttribute('data-deck-pos') === 'front')
  const idx = () => Number(deck()?.getAttribute('data-deck-index') ?? -1)
  const dots = () => [...document.querySelectorAll<HTMLElement>('[data-deck-dot]')]
  const result: Record<string, unknown> = {}

  // ① 初始态：框内只有一张在前，且**卡片必须完整落在框里**（框留了内边距给阴影，
  //    本仓栽过一次"卡片阴影被容器裁掉"）
  const frame = deck()
  const fr = frame?.getBoundingClientRect()
  const f0 = front()?.getBoundingClientRect()
  result.index0 = idx()
  result.count = cards().length
  result.dots = dots().length
  result.dotActive = dots().findIndex((d) => d.getAttribute('data-deck-dot') === 'on')
  result.frontKey = front()?.getAttribute('data-deck-card') ?? null
  result.frameH = fr ? Math.round(fr.height) : null
  result.cardH = f0 ? Math.round(f0.height) : null
  result.insideFrame = !!(fr && f0 && f0.top >= fr.top - 1 && f0.bottom <= fr.bottom + 1 &&
    f0.left >= fr.left - 1 && f0.right <= fr.right + 1)
  // 非前卡：不可命中 + 对读屏隐藏 + 不可 Tab 进入
  const others = cards().filter((c) => c.getAttribute('data-deck-pos') !== 'front')
  result.othersInert = others.every((c) => c.hasAttribute('inert'))
  result.othersAriaHidden = others.every((c) => c.getAttribute('aria-hidden') === 'true')
  result.frontInert = !!front()?.hasAttribute('inert')

  // ② 滚轮两条通道
  // ⚠️ 顺序必须**边界感知**：牌堆现在只有 2 张卡，往下滚一次就到末张 ——
  // 按"能连翻 4 张"写判据会全部撞在边界上（第一版就是这么假红的）。
  // 于是把"快拨跟手"换成 2 张卡下**真有信号**的那条：**锁内反向输入不吞**（欠账）。
  const spin = async (dy: number, times: number, gap: number) => {
    for (let i = 0; i < times; i += 1) {
      deck()?.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dy, bubbles: true, cancelable: true,
      }))
      // gap=0 ⇒ **完全同步连发**：虚拟时间下连 `sleep(0)` 都会跳掉整段时钟，
      // 而"手势分界"是 150ms 静默 ⇒ 会退化成"每个事件都是新手势"
      if (gap > 0) await sleep(gap)
    }
    await sleep(700)          // 等动画与欠账消化完
    await settleTransforms()
    return idx()
  }
  result.noiseIdx = await spin(2, 6, 16)            // 噪声（<4px）不该切
  result.noiseMoved = result.noiseIdx !== 0
  result.oneNotchIdx = await spin(100, 1, 16)       // 向下滚一格 = 前进一张
  result.oneNotchBackIdx = await spin(-100, 1, 16)  // 向上滚一格 = 退回一张
  // **锁内反向输入不吞**：切下去之后立刻反向一格（此时还在 150ms 软锁里）⇒
  // 解锁时欠账要被消化 ⇒ 回到原位。用"一次手势一张且不记欠账"实现的话会停在 1。
  deck()?.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
  await sleep(40)
  deck()?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
  result.creditDuringIdx = idx()                    // 锁内：索引已到末张
  await sleep(900)
  await settleTransforms()
  result.creditIdx = idx()                          // 欠账消化后应当回到 0

  // ③ 方向语义 = **CSS 契约**（不能靠"抓动画中的那一帧"：虚拟时间下定时器会立刻触发，
  //    相位活不过一个 timer —— 第一版就是这么假红的）。
  //    做法：杀掉过渡，手动摆出「出场卡 + 入场卡」，再读两者的落点。
  //      · 向下滚：出场卡必须**向下位移**（滑出框）
  //      · 向上滚：出场卡必须**缩小**（向后隐去）
  const cssMatrix = async (phase: 'down' | 'up') => {
    const el = deck()
    const [a, b] = cards()
    if (!el || !a || !b) return null
    const kill = document.createElement('style')
    kill.textContent = '.deck-card{transition:none !important}'
    document.head.appendChild(kill)
    el.setAttribute('data-deck-phase', phase)
    a.setAttribute('data-deck-pos', 'out')
    b.setAttribute('data-deck-pos', 'front')
    void a.getBoundingClientRect()
    const tf = (n: HTMLElement) => getComputedStyle(n).transform
    const out = { out: tf(a), front: tf(b) }
    kill.remove()
    el.setAttribute('data-deck-phase', 'idle')
    return out
  }
  const mtx = (s: string | null | undefined) => {
    const m = /matrix\(([^)]+)\)/.exec(s || '')
    if (!m) return null
    const [sx, , , sy, tx, ty] = m[1].split(',').map((v) => Number(v.trim()))
    return { sx, sy, tx, ty }
  }
  const downM = mtx((await cssMatrix('down'))?.out)
  const upM = mtx((await cssMatrix('up'))?.out)
  result.downOutTy = downM ? Math.round(downM.ty) : null
  result.upOutSx = upM ? Math.round(upM.sx * 1000) / 1000 : null
  // 过渡注册（虚拟时间下读不到中间帧，只能判"有没有登记过渡"）
  const cs = front() ? getComputedStyle(front()!) : null
  result.transitionProp = cs?.transitionProperty ?? null
  result.transitionMs = Math.round((parseFloat(cs?.transitionDuration || '0') || 0) * 1000)

  // ④ 快拨 4 格：必须**很快到末张**（不能一格一格等动画放完）
  const t0 = performance.now()
  const fastStart = idx()
  result.fastSpinIdx = await spin(100, 4, 40)
  result.fastSpinMs = Math.round(performance.now() - t0)
  result.fastSpinMoved = result.fastSpinIdx !== fastStart
  result.runawayIdx = await spin(100, 10, 10)       // 10 格挤在 100ms：不许失控
  // ⚠️ 连续流（触控板）通道不在这里断言 —— 见 `deckWheel.test.ts` 的说明
  result.trackpadInfo = await spin(-30, 10, 0)      // 仅供参考，不断言

  // ⑤ 圆点：50% 透明度 + 静止自动隐藏（R40b）
  const dotsEl = () => document.querySelector<HTMLElement>('.deck-dots')
  const dotsOnNow = () => deck()?.getAttribute('data-deck-dots')
  const dotsStyle = () => {
    const el = dotsEl()
    if (!el) return null
    const cs = getComputedStyle(el)
    return { opacity: Math.round((parseFloat(cs.opacity) || 0) * 100) / 100, pe: cs.pointerEvents }
  }
  // 滚动之后**立刻**亮起（微任务读，别用 sleep：虚拟时间下定时器可能已经把闪显收掉）
  deck()?.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
  await Promise.resolve(); await Promise.resolve()
  result.dotsAfterWheelAttr = dotsOnNow()
  await sleep(1800)                                 // 等闪显到期
  await settleTransforms()
  result.dotsIdleAttr = dotsOnNow()
  // CSS 契约（**手动置位 + 杀掉过渡**再读计算样式 —— 不依赖定时器，也不受虚拟时间下
  // "过渡冻在起点"的影响：本仓第四次踩这个坑了）
  const killDots = document.createElement('style')
  killDots.textContent = '.deck-dots{transition:none !important}'
  document.head.appendChild(killDots)
  const forced = (v: 'on' | 'off') => {
    dotsEl()?.setAttribute('data-deck-dots', v)
    void dotsEl()?.getBoundingClientRect()
    return dotsStyle()
  }
  result.dotsOnStyle = forced('on')
  result.dotsOffStyle = forced('off')
  forced('off')
  killDots.remove()
  const key = async (k: string) => {
    deck()?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    await sleep(600)
    await settleTransforms()
    return idx()
  }
  result.keyHome = await key('Home')
  result.keyPageDown = await key('PageDown')        // 从首张前进一张
  result.keyUp = await key('ArrowUp')               // 再退回首张
  result.keyDown = await key('ArrowDown')
  result.keyEnd = await key('End')                  // 末张
  result.keyDownAtEnd = await key('ArrowDown')      // 末张再向下：**循环回首张**（R40b）
  result.keyHome2 = await key('Home')               // 回到首张
  result.keyUpAtHome = await key('ArrowUp')         // 首张再向上：**循环回末张**（R40b）
  result.keyPageUp = await key('PageUp')            // 末张再向上：又回首张（循环的另一半）

  // ⑦ 圆点可点（指示器不只是装饰）
  dots()[1]?.click()
  await sleep(600)
  await settleTransforms()
  result.dotClickIdx = idx()

  result.motionReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  result.ok = true
  out.push({ ...measure('deck'), deck: result })
}


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
    /** 年份/月份导航钮（R39-A）：每块面板应当有 **2 个月份箭头 + 2 个年份双箭头** */
    yearNav: panels.map((p) => ({
      title: (p.querySelector('.drp-title')?.textContent || '').trim(),
      monthBtns: [...p.querySelectorAll<HTMLElement>('.drp-nav')]
        .filter((b) => b.dataset.nav !== 'year').length,
      yearBtns: [...p.querySelectorAll<HTMLElement>('[data-nav="year"]')].length,
    })),
  }
}

/**
 * 年份双箭头要**真的跳一年**（R39-A）：点「上一年」⇒ 标题年份 −1；点「下一年」⇒ 复原。
 * 只看"按钮在不在"是不够的 —— 跳错粒度（比如还是跳一个月）照样能绿。
 */
async function probeYearJump() {
  const visible = () => [...document.querySelectorAll<HTMLElement>('.drp-panel')]
    .find((n) => getComputedStyle(n).display !== 'none')
  const yearOf = (p: HTMLElement | undefined) =>
    Number((/(\d{4})/.exec((p?.querySelector('.drp-title')?.textContent || '')) || [])[1]) || null
  const monthOf = (p: HTMLElement | undefined) =>
    Number((/(\d{1,2})月/.exec((p?.querySelector('.drp-title')?.textContent || '')) || [])[1]) || null
  const p0 = visible()
  const y0 = yearOf(p0)
  const m0 = monthOf(p0)
  const prev = p0?.querySelector<HTMLButtonElement>('[data-nav="year"][data-dir="-1"]')
  const next = p0?.querySelector<HTMLButtonElement>('[data-nav="year"][data-dir="1"]')
  const out = { hasPrev: !!prev, hasNext: !!next, y0, m0, y1: null as number | null, m1: null as number | null, y2: null as number | null }
  if (!prev || !next) return out
  prev.click()
  await sleep(220)
  const p1 = visible()
  out.y1 = yearOf(p1)
  out.m1 = monthOf(p1)
  // 再点一次「下一年」应当回到起点（同一块面板上，方向可逆）
  visible()?.querySelector<HTMLButtonElement>('[data-nav="year"][data-dir="1"]')?.click()
  await sleep(220)
  out.y2 = yearOf(visible())
  return out
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

  // 年份双箭头（R39-A）：点一下必须正好跳一年（且可逆）—— 在动草稿之前先量完
  const yearJump = await probeYearJump()
  out.push({ ...measure('list-filter-year'), filterPop: { ...filterPopBox(), yearJump }, pill: pillText() })

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

  if (mode === 'deck') {
    const clicked = clickView('数据视图')
    await sleep(2200)
    if (!clicked) degraded.push('view:数据视图')
    await probeDeck(out)
  }

  if (mode === 'archive') {
    const clicked = clickView('数据视图')
    await sleep(2200)
    if (!clicked) degraded.push('view:数据视图')
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
    let pendingSample: Record<string, unknown> | null = null

    /** R36 连采两格用的尺子：弹窗的几处高度 + 占位标记。
     *
     * 为什么要量这么多层：用户报的是「上游数据一抓到**窗口长度变化**」，而窗口高度由
     * **内容总高**驱动（`.lc-dlg` 是 `max-height` 而不是固定高）⇒ 只要"未到位态"比
     * "到位态"矮，弹窗就会长高。所以两格都量 `.lc-dlg`（窗）+ `.lc-dlg-main`（两列区）
     * + 右列卡片 + 左列速览卡，逐一比对**零变化**。
     * `pending` 数的是骨架标记：第一格没有骨架 = 没采到"未到位态"，断言必须显式失败
     * （否则「两格一样高」可能只是"两次都采到了到位态"，是空转的假绿）。 */
    const sampleDialog = () => {
      const dlg = document.querySelector<HTMLElement>('.lc-dlg')
      if (!dlg) return null
      const glance = dlg.querySelector<HTMLElement>('.lc-dlg-glance')
      const right = dlg.querySelector<HTMLElement>('.lc-dlg-sec')
      const main = dlg.querySelector<HTMLElement>('.lc-dlg-main')
      const left = dlg.querySelector<HTMLElement>('.lc-dlg-left')
      /** 相对视口的整数盒（"卡在封面正下方、同宽、2×2 不越界"这几条靠它判） */
      const rect = (n: Element | null) => {
        if (!n) return null
        const r = n.getBoundingClientRect()
        return { x: Math.round(r.left), y: Math.round(r.top),
                 w: Math.round(r.width), h: Math.round(r.height) }
      }
      return {
        h: dlg.offsetHeight,
        mainH: main?.offsetHeight ?? null,
        leftH: left?.offsetHeight ?? null,
        rightH: right?.offsetHeight ?? null,
        glanceH: glance?.offsetHeight ?? null,
        coverBox: rect(dlg.querySelector('.lc-dlg-cover')),
        glanceBox: rect(glance),
        capBoxes: [...dlg.querySelectorAll('.lc-dlg-glance .lc-glance-cap')].map(rect),
        // 词云块与内容区：用来判断"弹窗到底有没有顶到 max-height"（顶到之后
        // 再高的内容只会进滚动区，窗高就不再变化）
        cloudH: dlg.querySelector<HTMLElement>('.lc-dlg-cloud')?.offsetHeight ?? null,
        bodyH: dlg.querySelector<HTMLElement>('.lc-dlg-body')?.offsetHeight ?? null,
        bodyScrollH: dlg.querySelector<HTMLElement>('.lc-dlg-body')?.scrollHeight ?? null,
        // ⚠️ 真正有牙口的是这一条：**滚动体的内容高**（OverlayScroll 的 `.os-scroll`）。
        // 窗高只在"内容没顶到 max-height"时才随内容变 —— 探针窗口矮，弹窗两格都顶在
        // 上限上，于是"窗高相等"会变成空转的假绿（反向验证实测：把预留高度改成 0
        // 窗高仍然相等）。内容高不受上限影响，预留守恒在这里露馅。
        contentH: dlg.querySelector<HTMLElement>('.lc-dlg-body .os-scroll')?.scrollHeight ?? null,
        glanceCaps: [...dlg.querySelectorAll('.lc-dlg-glance .lc-glance-cap')].map((n) => ({
          label: (n.querySelector('.lc-glance-label')?.textContent || '').trim(),
          value: (n.querySelector('.lc-glance-value')?.textContent || '').trim(),
        })),
        // 右列「直播信息」的行式字段（第一个 `.lc-dlg-sec` 就是它）：用于与速览胶囊
        // **交叉对账**同一份数据 —— 这条判据不依赖"这场有没有值"（两边都是 `—` 也算一致），
        // 但真读到值时必须一模一样（防"胶囊读了别的字段"这种接线错）。
        rightRows: [...dlg.querySelectorAll('.lc-dlg-sec .lc-dlg-rows .lc-dlg-row')].map((n) => ({
          label: (n.querySelector('dt')?.textContent || '').trim(),
          value: (n.querySelector('dd')?.textContent || '').replace(/\s+/g, ' ').trim(),
        })),
        pending: dlg.querySelectorAll('[data-pending="1"]').length,
        skels: dlg.querySelectorAll('.lc-skel').length,
        /** R40c 排版契约：速览标题必须去掉、四枚胶囊必须**四种底色**、两列底边必须齐平 */
        glanceTitle: (dlg.querySelector('.lc-dlg-glance .lc-dlg-sec-title')?.textContent || '').trim(),
        capBgs: [...dlg.querySelectorAll('.lc-dlg-glance .lc-glance-cap')]
          .map((n) => getComputedStyle(n).backgroundColor),
        leftBottom: Math.round(
          (dlg.querySelector('.lc-dlg-left')?.getBoundingClientRect().bottom ?? 0)),
        rightBottom: Math.round(
          (dlg.querySelector('.lc-dlg-main > .lc-dlg-sec')?.getBoundingClientRect().bottom ?? 0)),
        /** 逐段高度 + 每个骨架的高度（R40c：把 R36 那条"差 9px"定位到**具体哪一段**） */
        sections: [...dlg.querySelectorAll('.lc-dlg-sec')].map((n) => ({
          cls: (n.className || '').split(' ').slice(0, 2).join('.'),
          h: Math.round(n.getBoundingClientRect().height),
        })),
        skelBoxes: [...dlg.querySelectorAll('.lc-skel')].map((n) => ({
          cls: (n.className || '').split(' ').slice(0, 2).join('.'),
          h: Math.round(n.getBoundingClientRect().height),
        })),
        placeholders: [...dlg.querySelectorAll('.lc-dlg-ph')].map((n) =>
          (n.textContent || '').trim(),
        ),
      }
    }
    if (withBody.length) {
      // R36 的「未到位态」必须**确定性地**存在。后端对上游有 10 分钟缓存 ⇒ 同一场次第二次
      // 打开时数据可能几十毫秒就回来（实测第一版：两格都采到了到位态，判据空转）。
      // 所以探针自己把 `/upstream` 压后 2.5s —— 它造现场，就像别的模式往副本库里种数据。
      // 虚拟时间下两个定时器按到期顺序触发（120 < 2500）⇒ 第一格必然落在未到位态。
      const realFetch = window.fetch
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : String((input as Request).url ?? input)
        if (!url.includes('/upstream')) return realFetch(input as RequestInfo, init)
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            realFetch(input as RequestInfo, init).then(resolve, reject)
          }, 2500)
        })
      }) as typeof window.fetch

      withBody[withBody.length - 1].click()
      // 第一格：**上游落地之前**（等最小的一帧让弹窗挂载：本地数据先渲染，上游那几块还在占位）
      await sleep(60)
      pendingSample = sampleDialog()
      window.fetch = realFetch        // 采完就还原：后面等的是真实到达时间
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
          /** 逐段高度（R40c：R36 那条"骨架比真实内容高 9px"要靠它定位到**哪一段**）。
           *  按 `.lc-dlg-sec` 取（`.os-scroll > *` 取不到 —— 滚动体里还有一层包裹）。 */
          sections: [...dlg.querySelectorAll('.lc-dlg-sec')].map((n) => ({
            cls: (n.className || '').split(' ').slice(0, 2).join('.'),
            h: Math.round(n.getBoundingClientRect().height),
          })),
          skelBoxes: [...dlg.querySelectorAll('.lc-skel')].map((n) => ({
            cls: (n.className || '').split(' ').slice(0, 2).join('.'),
            h: Math.round(n.getBoundingClientRect().height),
          })),
        }
      }
    }
    // 第二格：到位态（与第一格同一把尺子；两格高度必须零变化 —— R36 的判据）
    const settledSample = sampleDialog()
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
        pendingSample,
        settledSample,
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
    // 场景机也进了 `scene-exit`，但那个退场提交定时器在虚拟时间里**始终没落地**。
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
        // ④ **来源 → 收录路径**的分流（2026-09-15 用户实测踩到的 bug）：
        //    索引来源（danmakus 周级索引）**不在 csv 池里** —— 带 source='pool' 时后端
        //    find_in_pool miss ⇒ 点一下就是红字「候选池中不存在该 platform_uid」。
        //    这类错法界面完全正常（行看着能点、能点也确实发了请求），只有这条断言拦得住。
        const paths = rows.map((r) => ({
          origin: r.getAttribute('data-origin'),
          source: r.getAttribute('data-adopt-source'),
          disabled: r.hasAttribute('disabled'),
        }))
        result.pathCounts = paths.reduce<Record<string, number>>((acc, p) => {
          acc[`${p.origin}→${p.source}`] = (acc[`${p.origin}→${p.source}`] || 0) + 1
          return acc
        }, {})
        result.indexRowsToPool = paths.filter(
          (p) => p.origin === 'index' && p.source === 'pool' && !p.disabled).length
        result.enabledWithoutSource = paths.filter((p) => !p.disabled && !p.source).length
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

  // 前端打磨三处（`?probe=polish`，devlog/087；配合 `ui_probe.py --polish`）：
  // R15 的三条都是"视觉/占位"问题，肉眼看不出差 2px，所以全部**量**出来：
  //   ① 顶栏标题粗体：字重 + 文本实际宽度（粗体更宽，别撑破 150px 容器）
  //   ② 筛选钮文字居中：文字节点相对按钮的左右间隙（斜切 pill 的视觉中心 ≠ 几何中心）
  //   ③ 药丸尾部「+」：未 hover 时**不占位**（高度 0、不可命中）且徽标紧贴分割线；
  //      hover 后展开、可见、可命中 —— 两个状态都要量（探针派发 pointerover/pointerout，
  //      因为 CSS `:hover` 在 `--dump-dom` 里无法模拟）
  if (mode === 'polish') {
    const result: Record<string, unknown> = {}
    const waitFor = async (fn: () => unknown, ms = 5000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = fn()
        if (v) return v
        await sleep(100)
      }
      return null
    }
    const killAnim = document.createElement('style')
    killAnim.textContent =
      '*, *::before, *::after { animation: none !important; transition: none !important; }'
    document.head.appendChild(killAnim)
    const rect = (el: Element | null) => (el ? el.getBoundingClientRect() : null)
    const r4 = (r: DOMRect | null) => (r ? {
      left: Math.round(r.left * 10) / 10, top: Math.round(r.top * 10) / 10,
      right: Math.round(r.right * 10) / 10, bottom: Math.round(r.bottom * 10) / 10,
      w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
    } : null)

    // ① 顶栏标题
    const title = document.querySelector<HTMLElement>('.topbar-title')
    if (title) {
      const cs = getComputedStyle(title)
      // 文本实际宽度：把内容塞进一个 inline span 量（容器是定宽 flex，量 rect 得到的是 150）
      const probe = document.createElement('span')
      probe.textContent = title.textContent || ''
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;` +
        `font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};` +
        `letter-spacing:${cs.letterSpacing}`
      document.body.appendChild(probe)
      result.titleFontWeight = cs.fontWeight
      result.titleLetterSpacing = cs.letterSpacing
      result.titleTextWidth = Math.round(probe.getBoundingClientRect().width * 10) / 10
      result.titleBoxWidth = title.offsetWidth
      probe.remove()
    }

    // ② 药丸尾部「+」：空闲不占位 / hover 展开
    // ⚠️ **必须先量这条**：它在展示页（默认视图）；先切列表视图会让它整个不在 DOM 里
    //    （第一版顺序反了，量到一片 None）
    const sets = document.querySelector<HTMLElement>('.stat-sets')
    const add = document.querySelector<HTMLElement>('.pill-add')
    const divider = document.querySelector<HTMLElement>('.hero-divider')
    const lastPill = document.querySelector<HTMLElement>('.stat-set [data-pill-index]')
      ? [...document.querySelectorAll<HTMLElement>('.stat-set')].pop() ?? null
      : null
    const gapToDivider = () => {
      const s = rect(lastPill)
      const d = rect(divider)
      return s && d ? Math.round((d.top - s.bottom) * 10) / 10 : null
    }
    result.pillAddPresent = !!add
    result.pillAddIdleHeight = add ? add.offsetHeight : -1
    result.pillAddIdleOpacity = add ? getComputedStyle(add).opacity : null
    result.pillAddIdlePointerEvents = add ? getComputedStyle(add).pointerEvents : null
    result.pillAddIdleHit = (() => {
      const el = add
      const r = rect(el)
      if (!el || !r) return null
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!hit && (hit === el || el.contains(hit))
    })()
    result.badgeToDividerIdle = gapToDivider()
    result.hoverAttrIdle = sets?.getAttribute('data-hover') ?? null

    if (sets && add) {
      sets.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      sets.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))
      await waitFor(() => sets.getAttribute('data-hover') === '1', 2000)
      await sleep(60)
      result.hoverAttrAfterEnter = sets.getAttribute('data-hover')
      result.pillAddHoverHeight = add.offsetHeight
      result.pillAddHoverOpacity = getComputedStyle(add).opacity
      result.badgeToDividerHover = gapToDivider()
      const r = rect(add)
      result.pillAddHoverHit = r
        ? (() => {
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            return !!hit && (hit === add || add.contains(hit))
          })()
        : null
      sets.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
      sets.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }))
      await waitFor(() => sets.getAttribute('data-hover') === '0', 2000)
      result.hoverAttrAfterLeave = sets.getAttribute('data-hover')
      await sleep(60)
      result.pillAddAfterLeaveHeight = add.offsetHeight
    }

    // ③ 筛选钮：文字相对按钮的左右间隙。
    // ⚠️ 量**纯文本节点**（不是 `selectNodeContents`）—— 后者把绝对定位的 caret 也算进
    //    range 里，于是"右间隙"量到的是 caret 到右缘的 3px，看起来像文字偏了 18px（第一版踩了）。
    // ⚠️ 它只在**列表视图**的工具行里，所以这条放最后（切走展示页就量不到 ②）。
    clickView('帖子列表')
    await sleep(900)
    const pf = document.querySelector<HTMLElement>('.pfilter-btn')
    if (pf) {
      const pr = pf.getBoundingClientRect()
      const caret = pf.querySelector('.pill-caret')
      // 文案节点：可能裸着（侧栏那枚），也可能套在 `.pf-label` 里（R16 起 list 那枚，
      // 为的是给 caret 让出**对称**留白）—— 两种都要能量，否则换一次 DOM 结构探针就瞎了
      const labelEl = pf.querySelector<HTMLElement>('.pf-label')
      const textNode = [...(labelEl ?? pf).childNodes].find(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim()) ?? null
      const tr = textNode ? (() => {
        const range = document.createRange()
        range.selectNodeContents(textNode)
        return range.getBoundingClientRect()
      })() : null
      const contentRect = (() => {
        const range = document.createRange()
        range.selectNodeContents(pf)
        return range.getBoundingClientRect()
      })()
      result.filterRect = r4(pr)
      result.filterTextRect = r4(tr)
      result.filterContentRect = r4(contentRect)
      if (tr) {
        result.filterPadLeft = Math.round((tr.left - pr.left) * 10) / 10
        result.filterPadRight = Math.round((pr.right - tr.right) * 10) / 10
        result.filterGapDiff = Math.round(((tr.left - pr.left) - (pr.right - tr.right)) * 10) / 10
        result.filterTextCenterOffset =
          Math.round(((tr.left + tr.right) / 2 - (pr.left + pr.right) / 2) * 10) / 10
      }
      // 「文字 + caret」作为一组是否居中（R15② 的判据：用户看的是这一组）
      result.filterGroupPadLeft = Math.round((contentRect.left - pr.left) * 10) / 10
      result.filterGroupPadRight = Math.round((pr.right - contentRect.right) * 10) / 10
      result.filterGroupGapDiff =
        Math.round(((contentRect.left - pr.left) - (pr.right - contentRect.right)) * 10) / 10
      result.filterCaretRect = r4(rect(caret))
      result.filterTransform = getComputedStyle(pf).transform
      result.filterPadding = getComputedStyle(pf).padding
      result.filterCaretPosition = caret ? getComputedStyle(caret as Element).position : null
    } else {
      result.filterMissing = true
    }

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'polish', views: [], degraded, polish: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 顶栏状态岛（`?probe=status-island`，devlog/089；配合 `ui_probe.py --status-island`）：
  // 这一批把顶栏**三套并存**的信息渲染（轮询胶囊 / 瞬时覆写 / 完成报告弹窗）收成一个控件，
  // 所以要钉住的是"收编之后还对不对"：
  //   ⓪ **空闲轮播**（R12b）：空闲时文案按间隔在「状态文案 + 语录」之间轮转，
  //      且语录不许长成进度文案（否则与"自动节拍不占顶栏"那条口径混淆）；
  //   ① **空闲态**：只有绿点 + 轮播文案，**没有容器**（用户 2026-09-10 口径）；
  //   ② **瞬时消息**（`ddtoolkit:pill-message`，真实事件源）：岛亮起、文案换成消息、出现计数；
  //   ③ **点开面板**：条目可命中（`elementFromPoint`）、有来源标注、Esc 能收起、
  //      **入场动画真的挂上了**（220ms；reduce 分支则只淡入）；
  //   ④ **过期**：消息 ttl（4s）过后条目自己消失、岛回空闲 —— 虚拟时间下等得起。
  if (mode === 'status-island') {
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
    const island = () => document.querySelector<HTMLElement>('.si-island')
    const spacerW = () => Math.round(
      (document.querySelector('.topbar-spacer')?.getBoundingClientRect().width ?? 0) * 10) / 10
    // R38 批 2 不变量①：顶栏高度在**三态**（空闲 / 亮起 / 面板展开）下必须完全相同。
    // 形变只许发生在胶囊自己身上 —— 胶囊长高或顶栏被撑高都算破约。
    const topbarH = () =>
      Math.round(document.querySelector('.topbar')?.getBoundingClientRect().height ?? 0)

    await waitFor(() => island(), 6000)
    await waitFor(() => !island()!.classList.contains('on'), 4000)

    // ⓪ 空闲轮播：连采三次（间隔 > 轮播档 IDLE_TICK_MS=6s）。
    //    池子从 `data-idle-pool` 读（页面侧把 `pickIdle` 的结果原样挂上去），
    //    这样断言能落到"取到的词确实出自池子、且就是 index 那一格"，
    //    而不是"看起来像句话"这种空转判据。
    const idleSample = () => {
      const el = island()
      return {
        text: (el?.querySelector('.si-text')?.textContent || '').trim(),
        index: Number(el?.getAttribute('data-idle-index')),
        size: Number(el?.getAttribute('data-idle-size')),
        pool: (el?.getAttribute('data-idle-pool') || '').split('|'),
        carousel: el?.getAttribute('data-idle-carousel') ?? null,
      }
    }
    const samples = [idleSample()]
    for (let i = 0; i < 2; i++) {
      await sleep(7000)
      samples.push(idleSample())
    }
    result.idleSamples = samples
    result.idleTexts = samples.map((s) => s.text)
    result.idleIndexes = samples.map((s) => s.index)
    result.idleSize = samples[0].size
    result.idlePool = samples[0].pool
    result.idleCarousel = samples[0].carousel

    // ① 空闲态
    result.idleText = samples[0].text
    result.idleLit = !!island()?.classList.contains('on')
    result.idleCount = !!island()?.querySelector('.si-count')
    result.spacerIdle = spacerW()
    result.topbarHIdle = topbarH()

    // ② 瞬时消息（走真实事件源，不直接改 React state）
    window.dispatchEvent(new CustomEvent('ddtoolkit:pill-message', {
      detail: { text: '探针消息：账号信息抓取完成 · 成功 3 · 失败 0' },
    }))
    await waitFor(() => island()?.classList.contains('on'), 3000)
    const litText = (island()?.querySelector('.si-text')?.textContent || '').trim()
    result.litText = litText
    result.litOn = !!island()?.classList.contains('on')
    result.litHasChevron = !!island()?.querySelector('.si-chevron')
    result.topbarHLit = topbarH()
    // R38 批 2 不变量②：**胶囊不裁切** —— 文案没被 ellipsis 吃掉（宽度形变时最容易踩）。
    const siTextEl = island()?.querySelector<HTMLElement>('.si-text')
    if (siTextEl) {
      result.siTextScroll = siTextEl.scrollWidth
      result.siTextClient = siTextEl.clientWidth
    }
    // R38 批 2 不变量③：**中间态合法** —— 圆角必须 ≥ 高度/2。
    // 虚拟时间下过渡不推进（DEV-LOOP 记过），量不到"中间帧"；但 `999px` 会被 clamp 到
    // 高度/2 ⇒ **只要圆角 ≥ 高度/2，任意帧都必然是胶囊**，不会出现方角中间态。
    // 这是**结构级**判据，比采样中间帧更可靠。
    const pillEl = island()
    if (pillEl) {
      const pcs = getComputedStyle(pillEl)
      result.pillHeight = Math.round(parseFloat(pcs.height))
      result.pillRadius = Math.round(parseFloat(pcs.borderTopLeftRadius))
      // 不变量①的**原因**：胶囊绝对定位 ⇒ 不可能把顶栏撑高（`.topbar` 是固定高度）。
      // 只判"三态高度一致"是判结果；这条判原因，破了才说得清为什么破。
      result.pillPosition = pcs.position
      // ── R38 批 5：桌面控件宿主（`?density=widget`）的材质与尺寸 ──────────────
      // 判据全在脚本侧算（尤其对比度：要按 α 复算**纯白/纯黑**两个极端壁纸），
      // 这里只负责把计算样式原样带出去。
      result.density = pillEl.getAttribute('data-density')
      if (result.density === 'widget') {
        const wr = pillEl.getBoundingClientRect()
        result.widgetSize = [Math.round(wr.width), Math.round(wr.height)]
        result.widgetBg = pcs.backgroundColor
        result.widgetBackdrop = pcs.backdropFilter
        result.widgetShadow = pcs.boxShadow
        result.widgetPosition = pcs.position
        result.widgetColor = pcs.color
      }
    }

    // ③ 悬停呼出（R39-C，用户 2026-09-19：「改为鼠标 hover 就呼出，离开就收起，并且下拉栏居中」）
    //
    // 四条判据，各自对应一种"做错了也看着能用"的错法：
    //   a. **掠过不许弹** —— 鼠标从顶栏扫过时弹出面板是最烦人的错法（进入 120ms 才弹拦的就是它）；
    //   b. 正常悬停 260ms 内必须弹出来；
    //   c. 指针从胶囊移进面板时**不许收**（200ms 宽限，否则鼠标还没碰到面板它就没了）；
    //   d. 指针离开面板后必须收（hover 的本质）。
    const hoverAt = (el: Element, type: string) => {
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 31, pointerType: 'mouse',
        isPrimary: true, relatedTarget: document.body,
        clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
      }))
    }
    const cap = island()
    if (cap) {
      hoverAt(cap, 'pointerover')
      await sleep(60)
      hoverAt(cap, 'pointerout')          // 60ms 内进出 ⇒ 延迟应当拦住
      await sleep(420)
      result.panelAfterFlick = !!document.querySelector('.si-panel')

      hoverAt(cap, 'pointerover')
      await sleep(280)
      result.panelByHover = !!document.querySelector('.si-panel')

      const pnl = document.querySelector<HTMLElement>('.si-panel')
      hoverAt(cap, 'pointerout')
      if (pnl) hoverAt(pnl, 'pointerover')   // 移进面板 ⇒ 宽限内不该收
      await sleep(420)
      result.panelKeptByEnter = !!document.querySelector('.si-panel')
      const pnl2 = document.querySelector<HTMLElement>('.si-panel')
      if (pnl2) hoverAt(pnl2, 'pointerout')
      await sleep(420)
      result.panelClosedByLeave = !document.querySelector('.si-panel')
    }

    // ③b 点开面板（原有行为不许被 hover 顶掉）
    island()?.click()
    const panel = (await waitFor(() => document.querySelector('.si-panel'), 3000)) as HTMLElement | null
    result.panelOpened = !!panel
    // **居中**：面板中心对齐胶囊中心（越界被夹住时不算 —— 那由 panelInViewport 管）
    result.panelCentered = (() => {
      const c = island()?.getBoundingClientRect()
      const pr = panel?.getBoundingClientRect()
      if (!c || !pr) return null
      const clamped = pr.left <= 8.5 || pr.right >= window.innerWidth - 8.5
      return {
        dx: Math.round(Math.abs((pr.left + pr.width / 2) - (c.left + c.width / 2)) * 10) / 10,
        clamped,
      }
    })()
    // 点击 = **钉住**：指针离开也不许收（否则"点开细看"这件事做不到）
    if (panel) {
      hoverAt(island()!, 'pointerout')
      await sleep(420)
      result.panelPinnedByClick = !!document.querySelector('.si-panel')
    }
    result.panelItems = panel?.querySelectorAll('.si-item').length ?? -1
    result.panelKinds = [...(panel?.querySelectorAll('.si-item') || [])]
      .map((n) => n.getAttribute('data-kind'))
    result.panelItemText = (panel?.querySelector('.si-item-text')?.textContent || '').trim()
    result.panelMetaText = (panel?.querySelector('.si-item-meta')?.textContent || '').trim()
    const pr = panel?.getBoundingClientRect()
    result.panelHit = !!(pr && hits(panel, pr.left + 10, pr.top + 10))
    const firstItem = panel?.querySelector<HTMLElement>('.si-item') ?? null
    const ir = firstItem?.getBoundingClientRect()
    result.panelItemHit = !!(ir && hits(firstItem, ir.left + ir.width / 2, ir.top + ir.height / 2))
    result.panelInViewport = !!(pr && pr.left >= -0.5 && pr.right <= window.innerWidth + 0.5 &&
      pr.top >= -0.5 && pr.bottom <= window.innerHeight + 0.5)
    // 入场动画（R12b 用户期望②）：量**计算后的样式**而不是查 CSS 文件 ——
    // 只有真挂到元素上才算数。reduce 分支下应当只剩淡入（脚本侧按 motionReduced 判）。
    if (panel) {
      const cs = getComputedStyle(panel)
      result.panelAnimName = cs.animationName
      result.panelAnimMs = Math.round(parseFloat(cs.animationDuration) * 1000)
      result.panelAnimCount = panel.getAnimations().length
      // R38 批 3「同心圆角」：**面板内层元素的圆角 = 面板圆角 − 它到面板内缘的距离**
      // （规格 §5；"看起来像一块材料挖出来的"和"两块积木叠着"的分界）。
      // 当前**无对象** —— 子元素全是通栏行（head / scroll / item）—— 但规则要**有判据**：
      // 将来谁在面板里加了个圆角卡片，圆角不对就会红。
      // 药丸（≥100px，如 `.si-item-action`）不算：它们不是同心圆的候选。
      result.panelRadius = Math.round(parseFloat(cs.borderTopLeftRadius))
      // ⚠️ 用**布局宽**（`cs.width`）不用 rect：面板入场动画的 `scale(.985)` 在虚拟时间下
      // 被冻在起始帧（DEV-LOOP 记过），rect 会量到 280 × 0.985 ≈ 276 的假值。
      result.panelWidth = Math.round(parseFloat(cs.width))
      result.panelDensity = panel.getAttribute('data-density')
      const pr = panel.getBoundingClientRect()
      const inner: Array<{ sel: string; radius: number; inset: number }> = []
      panel.querySelectorAll<HTMLElement>('*').forEach((el) => {
        const radius = Math.round(parseFloat(getComputedStyle(el).borderTopLeftRadius))
        if (!radius || radius >= 100) return
        const b = el.getBoundingClientRect()
        // 减去面板那 1px 边框：`inset` 是"到面板**内缘**的距离"
        inner.push({
          sel: typeof el.className === 'string' && el.className ? el.className : el.tagName,
          radius,
          inset: Math.round(b.left - pr.left) - 1,
        })
      })
      result.panelInnerRadii = inner
    }
    result.motionReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // chevron：展开后必须**指着"可收起"**（翻转 180° ⇒ 计算值是矩阵，不是 `none`），
    // 而过渡时长按 reduce 分派。reduce 下丢掉翻转 = 状态指示消失（不是"减少动效"的本意）。
    //
    // ⚠️ 量法（2026-09-15 实测两次，一次 identity 一次翻转）：`transition: transform .2s`
    //    在**虚拟时间**下会被冻在中途，直接读计算样式读到的是"过渡进度"而不是"规则有没有生效"。
    //    所以先读过渡时长，再**注入 `transition:none`** 后读终值 —— 与 `--settings`
    //    那条"量之前先注入 animation:none; transition:none"是同一招。
    const chev = island()?.querySelector<HTMLElement>('.si-chevron')
    if (chev) {
      result.chevronTransitionMs =
        Math.round(parseFloat(getComputedStyle(chev).transitionDuration) * 1000)
      const killTransition = document.createElement('style')
      killTransition.textContent = '.si-chevron{transition:none !important}'
      document.head.appendChild(killTransition)
      void chev.getBoundingClientRect()      // 强制重排，让计算样式落到终值
      result.chevronTransform = getComputedStyle(chev).transform
      killTransition.remove()
    }

    // R38 批 1「motion token 化」的判据：元素上量到的时长必须**等于令牌解析出的毫秒**，
    // 而不是等于某个硬编码数 —— 这样"令牌真的被用上"可断言：改令牌探针跟着走，
    // 有人写回硬编码就红。
    // ⚠️ 不能直接 `getPropertyValue('--motion-base')`：自定义属性拿回来的是
    //    `calc(220ms * var(--motion-scale))` 的**原文**，不是时间。所以用一个临时元素
    //    把令牌解析成计算后的 `animationDuration`（浏览器会算成 `0.22s`）。
    const tokenMs = (name: string): number => {
      const el = document.createElement('div')
      el.style.cssText =
        `position:absolute;left:-9999px;visibility:hidden;animation-duration:var(${name})`
      document.body.appendChild(el)
      const ms = Math.round(parseFloat(getComputedStyle(el).animationDuration) * 1000)
      el.remove()
      return ms
    }
    result.motionFastMs = tokenMs('--motion-fast')
    result.motionBaseMs = tokenMs('--motion-base')
    const textEl = island()?.querySelector<HTMLElement>('.pill-text-fade')
    if (textEl) {
      const tcs = getComputedStyle(textEl)
      // R38 批 4：文案从「keyframes 重放」改成「transition 重定向」⇒ 判据也跟着换。
      // `animationName` 必须是 `none`（重放会闪），时长改读 `transitionDuration`。
      result.textAnimName = tcs.animationName
      result.textTransitionMs = Math.round(parseFloat(tcs.transitionDuration) * 1000)
      result.textTransitionProps = tcs.transitionProperty
    }
    // `.si-count` 是条件渲染（`lit && notices.length > 1`）—— 本模式只派一条消息，
    // 所以它可能不存在。存在才量；不存在时脚本侧不判（它和文案共用 `--motion-fast`）。
    const countEl = island()?.querySelector<HTMLElement>('.si-count')
    if (countEl) {
      result.countAnimMs = Math.round(parseFloat(getComputedStyle(countEl).animationDuration) * 1000)
    }

    // 展开**不该挤动右栏**（面板是 portal + fixed）
    result.spacerOpen = spacerW()
    result.topbarHOpen = topbarH()

    // Esc 收起
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await waitFor(() => !document.querySelector('.si-panel'), 3000)
    result.panelClosedByEsc = !document.querySelector('.si-panel')

    // ④ 过期：消息 ttl（TopBar 的 PILL_MS=4s）过后岛回空闲。
    // ⚠️ 诚实标注：这一条量的是**端到端结果**（消息消失 + 岛回空闲），
    //    背后有两个机制（TopBar 的清态定时器 + notificationHub 的 expiresAt 过滤）。
    //    单靠探针分不清是哪一个在起作用 —— hub 的过期规则由单测钉住
    //    （`notificationHub.test.ts` 的 isLive / rateLimitNotice 两条），两者互补。
    await sleep(4600)
    result.afterTtlText = (island()?.querySelector('.si-text')?.textContent || '').trim()
    result.afterTtlLit = !!island()?.classList.contains('on')

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'status-island', views: [], degraded,
                                       statusIsland: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 页面工具条（`?probe=toolbar`，R45；配合 `ui_probe.py --toolbar`）：
  // R45 把工具条从"66px 常驻带子 + 极轻毛玻璃"改成"**overlay + 按需出现 + 不透明浮片**"，
  // 所以要钉住的是**状态机本身**（静态几何与对比度由默认三档的 `glow` 段覆盖）：
  //   ① **rest**：不可见、不吃指针；
  //   ② **进热区 + dwell** ⇒ 可见、吃指针；
  //   ③ **离开 + grace** ⇒ 回 rest；
  //   ④ **键盘聚焦** ⇒ `:focus-within` 显形 —— 这是"自动隐藏 + 键盘可达"唯一能
  //      同时成立的做法（隐藏态仍是可聚焦控件，没有这条 Tab 会落到看不见的按钮上）；
  //   ⑤ **overlay 成立**：呼出前后 `.view-body` 高度**不变**（不占布局 ⇒ 不挤动内容）。
  if (mode === 'toolbar') {
    const result: Record<string, unknown> = {}
    // ⚠️ **先杀掉过渡**（本仓老招，见 `--settings`/chevron 两处先例）：虚拟时间下
    // 过渡不推进 ⇒ `getComputedStyle().opacity` 会一直报**过渡起点**（0），
    // 那样"呼出来了没有"就变成了尺子问题。`data-shown` 不受影响，两条一起看才分得清
    // "机制没生效"和"尺子读不到"。
    const kill = document.createElement('style')
    kill.textContent = '.glow-bar,.bg-tools{transition:none !important}'
    document.head.appendChild(kill)
    const barEl = () => document.querySelector<HTMLElement>('.glow-bar')
    const panelEl = () => document.querySelector<HTMLElement>('.posts-panel')
    const bodyEl = () => document.querySelector<HTMLElement>('.view-body')
    const snap = () => {
      const b = barEl()
      const t = document.querySelector<HTMLElement>('.view-toolbar')
      const body = bodyEl()
      return {
        shown: t?.getAttribute('data-shown') ?? null,
        opacity: b ? Math.round((parseFloat(getComputedStyle(b).opacity) || 0) * 100) / 100 : null,
        pe: b ? getComputedStyle(b).pointerEvents : null,
        bodyH: body ? Math.round(body.getBoundingClientRect().height) : null,
      }
    }
    /** ⚠️ 判定**完全靠 mousemove**（工具条 `pointer-events:none`，收不到 mouseenter）——
     *  所以"移出"也必须真发一次 mousemove，不能靠别的。 */
    const move = (x: number, y: number) => {
      panelEl()?.dispatchEvent(
        new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }),
      )
    }
    const t0 = performance.now()
    while (!barEl() && performance.now() - t0 < 8000) await sleep(100)
    if (!barEl()) {
      result.missing = true
    } else {
      // 冷启动闪现（1.2s）先放掉，否则 ① 量到的是闪现而不是 rest
      await sleep(1600)
      result.rest = snap()
      // ② 指针进热区（条中心）→ dwell(140ms) 后呼出
      const r = barEl()!.getBoundingClientRect()
      move(r.left + r.width / 2, r.top + r.height / 2)
      await sleep(400)
      result.shown = snap()
      // ③ 移出（面板底部）
      const pr = panelEl()!.getBoundingClientRect()
      move(pr.left + pr.width / 2, pr.bottom - 8)
      await sleep(1400)
      result.afterLeave = snap()
      // ④ 键盘聚焦 ⇒ `:focus-within`（注意此时 `data-shown` 仍是 '0' ——
      //    聚焦这条**故意**不走 state，纯 CSS 就够，也避免了"聚焦还要 setState"的回路）
      const btn = document.querySelector<HTMLElement>('.view-btn')
      btn?.focus()
      await sleep(300)
      result.focus = snap()
      result.focusIsActive = document.activeElement === btn
      btn?.blur()
      await sleep(300)
      result.afterBlur = snap()
      // ⑤ overlay：呼出前后内容区高度必须一致（否则说明它还占着布局）
      result.bodyHStable =
        (result.rest as { bodyH?: number } | undefined)?.bodyH ===
        (result.shown as { bodyH?: number } | undefined)?.bodyH
    }
    kill.remove()

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'toolbar', views: [], degraded, toolbar: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 桌面状态控件**小窗视图**（`?probe=status-widget-window&widget=1`，R38 批 5b）：
  // 配合 `ui_probe.py --status-widget` 的第二段。
  //
  // 它验的是**分流本身**：`main.tsx` 在 `Root` 之前按 `?widget=1` 分叉，小窗里**不该**
  // 跑主窗口那套（后端探活 / 揭幕幕布 / 路由 / 顶栏）。所以最要紧的两条是
  // "胶囊在" 和 "顶栏不在" —— 后者错了就说明分流没生效，小窗里跑起了整个应用。
  //
  // ⚠️ 条目列表在这里**必然是空的**：小窗只听主窗口推的 `widget:notices`，
  // 而浏览器里没有 Tauri 事件。所以它渲染的是空闲态 —— 这正是我们要量的东西。
  if (mode === 'status-widget-window') {
    const result: Record<string, unknown> = {}
    const shell = document.querySelector<HTMLElement>('.widget-shell')
    const island = document.querySelector<HTMLElement>('.si-island')
    result.hasShell = !!shell
    result.hasIsland = !!island
    result.density = island?.getAttribute('data-density') ?? null
    // 分流没生效的证据：主窗口那套东西还在
    result.hasTopbar = !!document.querySelector('.topbar')
    result.hasSidebar = !!document.querySelector('.sidebar-shell')
    if (island) {
      const r = island.getBoundingClientRect()
      result.size = [Math.round(r.width), Math.round(r.height)]
      // ⚠️ 判**居中误差**而不是绝对偏移：探针里视口是 1100 宽（不是 Tauri 那个 200×40），
      // 所以胶囊在整屏居中 ⇒ 偏移是几百像素。绝对偏移只在真窗口里才是 0。
      const sr = shell?.getBoundingClientRect()
      result.centerErr = sr
        ? [Math.round(r.left + r.width / 2 - (sr.left + sr.width / 2)),
           Math.round(r.top + r.height / 2 - (sr.top + sr.height / 2))]
        : null
    }
    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'status-widget-window', views: [], degraded,
      statusWidgetWindow: result })
    document.body.appendChild(pre)
    return
  }

  // 直播预约进日历（`?probe=reservations`，devlog/088；配合 `ui_probe.py --reservations`）：
  // 现场由脚本侧**种一条明天的预约**进数据目录副本（开发库未必有未来预约，靠数据碰运气
  // 会让断言空转）。这里断言整条链路真的落到界面：
  //   ① 有预约的格子带 `data-resv-count`，徽章是「预约」（**不是**待定/休息）、
  //      格内出现预约时刻与标题；
  //   ② hover 该格 → 浮层（`.lc-pop`）里列出预约条目（只有预约、没有场次的日子也要能看）。
  if (mode === 'reservations') {
    const result: Record<string, unknown> = {}
    const waitFor = async (fn: () => unknown, ms = 6000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = fn()
        if (v) return v
        await sleep(100)
      }
      return null
    }
    const killAnim = document.createElement('style')
    killAnim.textContent =
      '*, *::before, *::after { animation: none !important; transition: none !important; }'
    document.head.appendChild(killAnim)

    // 档案视图（日历所在）
    // ⚠️ R37-P1 把这一页改名为「**数据视图**」之后，这里原来写的 `clickView('档案')` 只会匹配到
    // **档案视图（卡片画布）**（前缀匹配！）⇒ 点开的是没有日历的那一页，然后一直等 `.lc-cell` ✗
    // —— 这就是 `--reservations` 长期红着的根因（改名留下的陈旧选择器）。
    const openedCalendar = clickView('数据视图')
    await sleep(1500)
    await waitFor(() => document.querySelector('.lc-cell'), 8000)
    result.openedCalendarView = openedCalendar
    result.cellCount = document.querySelectorAll('.lc-cell').length

    const cells = [...document.querySelectorAll<HTMLElement>('.lc-cell')]
    const resvCell = cells.find((c) => c.hasAttribute('data-resv-count')) ?? null
    const todayCell = cells.find((c) => c.classList.contains('today')) ?? null
    result.cellCount = cells.length
    result.hasResvCell = !!resvCell
    result.resvBadge = (resvCell?.querySelector('.lc-badge')?.textContent || '').trim()
    result.resvCellText = (resvCell?.textContent || '').replace(/\s+/g, ' ').trim()
    result.resvCount = resvCell?.getAttribute('data-resv-count') ?? null
    result.resvTime = (resvCell?.querySelector('.lc-resv-time')?.textContent || '').trim()
    result.resvCountText = (resvCell?.querySelector('.lc-count')?.textContent || '').trim()
    result.resvHasMini = !!resvCell?.querySelector('.lc-resv-mini')
    result.plainCellCount = cells.filter((c) => !c.hasAttribute('data-resv-count')).length
    result.todayBadge = (todayCell?.querySelector('.lc-badge')?.textContent || '').trim()

    // hover 预约格 → 浮层（React onMouseEnter：派发 bubbling mouseover 即可触发）
    if (resvCell) {
      resvCell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      resvCell.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      const pop = (await waitFor(() => document.querySelector('.lc-pop'), 4000)) as HTMLElement | null
      result.popOpened = !!pop
      result.popHasResvBadge = !!pop?.querySelector('.lc-resv-badge')
      result.popResvText = (pop?.querySelector('.lc-resv-item')?.textContent || '')
        .replace(/\s+/g, ' ').trim()
      result.popHeadText = (pop?.querySelector('.lc-pop-head')?.textContent || '')
        .replace(/\s+/g, ' ').trim()
    }

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'reservations', views: [], degraded,
                                       reservations: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 未登录能力提示（`?probe=capabilities`，devlog/086；配合 `ui_probe.py --capabilities`）：
  // 现场 = 开发数据目录副本 **删掉 .env**（有数据、没登录）—— 这样才有侧栏/列表可点。
  //
  // 要盯的是**两条相反**的错法：
  //   ① 该说的没说：顶栏没有"未登录 · N 项受限"入口、说明窗列不出受限项与"去登录"；
  //   ② **过度限制**：受限功能被藏起来或整个界面不可用 —— 未登录明明还能浏览/搜索/收录，
  //      把它们禁掉就是把"未登录可用范围"缩水了（用户要的恰恰相反）。
  if (mode === 'capabilities') {
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
    const setVal = (el: HTMLInputElement, v: string) => {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, 'value')
      desc?.set?.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const killAnim = document.createElement('style')
    killAnim.textContent =
      '*, *::before, *::after { animation: none !important; transition: none !important; }'
    document.head.appendChild(killAnim)

    // ① 顶栏入口
    const limitsBtn = (await waitFor(
      () => document.querySelector('.topbar-limits'))) as HTMLElement | null
    result.hasLimitsBtn = !!limitsBtn
    result.limitsText = (limitsBtn?.textContent || '').trim()
    result.limitsCount = limitsBtn?.getAttribute('data-capability-limits') ?? null

    // ② 说明窗：先列"现在能做什么"，再列受限项，底部有"去登录"
    if (limitsBtn) {
      limitsBtn.click()
      const dlg = (await waitFor(
        () => document.querySelector('.cap-limits-dialog'))) as HTMLElement | null
      result.hasLimitsDialog = !!dlg
      result.canDoCount = dlg?.querySelectorAll('.cap-limits-ok').length ?? -1
      result.limitCount = dlg?.querySelectorAll('.cap-limits-item').length ?? -1
      result.limitIds = [...(dlg?.querySelectorAll('[data-limit-id]') || [])]
        .map((n) => n.getAttribute('data-limit-id'))
      result.hasLoginCta = !!dlg?.querySelector('.cap-limits-foot .float-pill')
      result.loginCtaText = (dlg?.querySelector('.cap-limits-foot .float-pill')?.textContent || '').trim()
      // R21 批 3：页脚按钮必须是浮片（斜切白卡那套），且主操作带 `.on`。
      // 命中就地量（本模式的 `hits/rectOf` 不在这个作用域里）
      const capCta = dlg?.querySelector<HTMLElement>('.cap-limits-foot button')
      result.footPill = capCta ? capCta.className : null
      result.footPillActive = !!capCta?.classList.contains('on')
      if (capCta) {
        const r = capCta.getBoundingClientRect()
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        result.footPillHit = !!at && (at === capCta || capCta.contains(at))
      }
      result.limitNoteSample = (dlg?.querySelector('.cap-limits-note')?.textContent || '').slice(0, 60)
      dlg?.querySelector<HTMLElement>('[data-slot="dialog-close"]')?.click()
      await waitFor(() => !document.querySelector('.cap-limits-dialog'), 3000)
    }

    // ③ 添加 V：**功能没被隐藏** —— 浮窗能开、有受限说明、而且**仍然能搜**
    document.querySelector<HTMLElement>('.list-add-btn')?.click()
    const av = (await waitFor(() => document.querySelector('.av-dialog'))) as HTMLElement | null
    result.addVDialogOpened = !!av
    result.addVHasLimitHint = !!av?.querySelector('[data-cap-limit-hint]')
    result.addVHintText = (av?.querySelector('[data-cap-limit-hint]')?.textContent || '').slice(0, 50)
    const input = av?.querySelector<HTMLInputElement>('.av-input')
    if (input) {
      setVal(input, 'a')
      await waitFor(() => document.querySelectorAll('.av-row').length, 5000)
      result.addVRows = document.querySelectorAll('.av-row').length
      result.addVEnabledRows = [...document.querySelectorAll('.av-row')]
        .filter((r) => !r.hasAttribute('disabled')).length
    }
    av?.querySelector<HTMLElement>('[data-slot="dialog-close"]')?.click()
    await waitFor(() => !document.querySelector('.av-dialog'), 3000)

    // ④ 批量任务：内容类**标注需要登录并禁用**，账号信息/归档**仍然可用**（不许一刀切）
    document.querySelector<HTMLElement>('.list-pull-btn')?.click()
    await waitFor(() => document.querySelector('[data-batch-action]'), 4000)
    const act = (k: string) => document.querySelector<HTMLElement>(`[data-batch-action="${k}"]`)
    result.batchDialogOpened = !!act('all-posts')
    result.batchAllPostsDisabled = !!act('all-posts')?.hasAttribute('disabled')
    result.batchAllPostsNeedsLogin = act('all-posts')?.getAttribute('data-needs-login')
    result.batchUpdateDisabled = !!act('update-unarchived')?.hasAttribute('disabled')
    result.batchArchiveEnabled = !!act('archive') && !act('archive')!.hasAttribute('disabled')
    result.batchAccountsEnabled = !!act('accounts') && !act('accounts')!.hasAttribute('disabled')
    result.batchHintText = (document.querySelector('.cap-inline-hint')?.textContent || '').slice(0, 60)
    document.querySelector<HTMLElement>('.cap-limits-dialog [data-slot="dialog-close"]')
    const batchClose = document.querySelector<HTMLElement>('[role="dialog"] [data-slot="dialog-close"]')
    batchClose?.click()
    await sleep(250)
    result.batchClosed = !document.querySelector('[data-batch-action]')

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'capabilities', views: [], degraded,
                                       capabilities: result })
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
      await sleep(60)
      result.toggleClosedOk = !document.querySelector('.vd-sign-panel')
      toggle?.click()
      await sleep(60)
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
        const ahFoot = ah?.querySelector<HTMLElement>('.ah-foot .float-pill')
        result.ahFootPill = ahFoot ? ahFoot.className : null
        ahFoot?.click()
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

  // 应用设置（`?probe=app-settings`，R14a devlog/091；配合 `ui_probe.py --app-settings`）：
  // 这一批新增「齿轮 → 独立弹窗 → 改值 → 下一轮生效」这条链路，要钉住的是：
  //   ① 齿轮真的能点开弹窗（不是个装饰图标）；弹窗在视口内、可命中、不挤动布局；
  //   ② 可写项与只读项**都渲染出来**，只读项逐条带理由（不能只显示"不能改"）；
  //   ③ **改值 → 保存 → 服务端真的变了**（页面直接再打一次 `GET /settings` 对账，
  //      不看界面自己的回显 —— 回显可以来自本地草稿，那样"存了没生效"照样绿）；
  //   ④ 越界值：保存钮必须禁用 + 出现红字（前端先拦一道，后端那道由后端用例钉住）；
  //   ⑤ 恢复默认：服务端回到默认值、弹窗里的"已改过"标记消失。
  if (mode === 'app-settings') {
    const result: Record<string, unknown> = {}
    const waitFor = async (fn: () => unknown, ms = 4000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        if (fn()) return true
        await sleep(100)
      }
      return false
    }
    const text = (el: Element | null | undefined) => (el?.textContent || '').trim()
    const rectOf = (el: Element | null) => el?.getBoundingClientRect() ?? null
    // ⚠️ 判"开着没有"必须看 `data-state`，不能看节点在不在：radix 的 Presence 会把
    //    关闭后的内容留着播**退场动画**，而虚拟时间下动画不会跑完 → 节点一直在。
    //    （2026-09-15 踩到：Esc 明明关了，探针却一直判"没关掉"。）
    const dlgOpen = () =>
      !!document.querySelector('[data-testid="app-settings-dialog"][data-state="open"]')
    const hits = (el: HTMLElement | null, x: number, y: number) => {
      if (!el) return false
      const hit = document.elementFromPoint(x, y)
      return !!hit && (hit === el || el.contains(hit))
    }
    /** 直接问后端要一次（**不看界面回显**） */
    const serverValue = async (key: string): Promise<number | boolean | null> => {
      const r = await fetch(`${getApiBase()}/settings`)
      const body = await r.json()
      const spec = (body.specs as { key: string; value: number | boolean }[])
        .find((s) => s.key === key)
      return spec ? spec.value : null
    }
    /** React 受控输入：必须走原生 setter + input 事件，直接改 .value 不会触发 onChange */
    const typeInto = (input: HTMLInputElement, v: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, v)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const FIELD = 'FETCH_BATCH_SIZE'

    const gear = document.querySelector<HTMLElement>('[data-testid="app-settings-gear"]')
    result.gearExists = !!gear
    const gr = rectOf(gear)
    result.gearHit = !!(gear && gr &&
      (document.elementFromPoint(gr.left + gr.width / 2, gr.top + gr.height / 2) === gear ||
       gear.contains(document.elementFromPoint(gr.left + gr.width / 2, gr.top + gr.height / 2))))
    result.gearAtBottom = !!gr && gr.bottom >= window.innerHeight - 4
    gear?.click()
    result.dialogOpened = await waitFor(dlgOpen, 4000)

    const dlg = document.querySelector<HTMLElement>('[data-testid="app-settings-dialog"]')
    if (dlg) {
      // 等规格表落地（有行才算渲染完）。R17 起字段分页了：先确认导航在，再切到
      // 目标字段所在的那一页 —— 探针不许假设"所有字段同屏"。
      await waitFor(() => dlg.querySelector('.aps-nav-item'), 4000)
      await waitFor(() => serverValue(FIELD) !== null, 4000)

      // ① 导航项必须与后端 `specs[].group` **逐项对账**（数据驱动的机器判据）
      const navLabels = [...dlg.querySelectorAll<HTMLElement>('.aps-nav-item')]
        .map((n) => (n.querySelector('.aps-nav-label')?.textContent || '').trim())
      const settingsBody = await fetch(`${getApiBase()}/settings`).then((r) => r.json())
        .then((b: { specs: { key: string; group: string; section: string; advanced: boolean }[] }) => b)
      const groupsFromApi = (() => {
        const out: string[] = []
        for (const s of settingsBody.specs) if (!out.includes(s.group)) out.push(s.group)
        return out
      })()
      /** 后端下发的**抓取参数**键（外观页出现任何一个 = 分页没生效） */
      const specKeys = new Set(settingsBody.specs.map((s) => s.key))
      const foreignRowsOnAppearance = () =>
        [...dlg.querySelectorAll<HTMLElement>('.aps-row')]
          .filter((r) => specKeys.has(r.getAttribute('data-setting') || '')).length
      result.navLabels = navLabels
      result.apiGroups = groupsFromApi
      result.navMatchesApi = JSON.stringify(navLabels)
        === JSON.stringify(['外观', ...groupsFromApi, '关于'])
      result.navCount = navLabels.length

      // ② 切到目标字段所在页（抓取设置）：点导航 → 面板必须真的换
      const navOf = (label: string) => [...dlg.querySelectorAll<HTMLElement>('.aps-nav-item')]
        .find((n) => (n.querySelector('.aps-nav-label')?.textContent || '').trim() === label)
      const paneOf = () => dlg.querySelector<HTMLElement>('[data-testid="aps-pane"]')
      const clickNav = async (label: string) => {
        navOf(label)?.click()
        await sleep(150)
      }
      /** 「高级（默认收起）」在每页默认是收起的 —— 要用里面的字段（探针改的就是高级项）
          就得先展开；换页后 React 会把它收回，所以每次切完页都要重新调一次。 */
      const openAdvanced = async () => {
        if (dlg.querySelector('.aps-fold[data-aps-advanced="closed"]')) {
          dlg.querySelector<HTMLButtonElement>('[data-testid="aps-advanced-toggle"]')?.click()
          await sleep(180)
        }
      }
      await clickNav('外观')
      result.appearancePane = paneOf()?.getAttribute('data-pane')
      result.appearanceCards = [...dlg.querySelectorAll('[data-theme-option]')]
        .map((n) => n.getAttribute('data-theme-option'))

      // ③ 只有当前分类的字段在 DOM（分页而不是"全塞一起再隐藏"）。
      //    判据是"**抓取参数**一个都不在外观页"，不是"外观页里没有任何 .aps-row" ——
      //    外观页自己也有行（主题、关闭窗口时，R18 起），那种计数写法会误报。
      result.fetchRowsOnAppearance = foreignRowsOnAppearance()
      await clickNav('抓取设置')
      result.paneAfterSwitch = paneOf()?.getAttribute('data-pane')
      result.rowsOnFetch = dlg.querySelectorAll('.aps-row').length
      result.otherPaneRowsHidden = dlg.querySelectorAll('[data-setting="EXTERNAL_ENABLED"]').length

      // ③b 页内小组 + 「高级」折叠（R21，devlog/100）：
      //     小组标题**只来自后端** `specs[].section`，折叠项的判据只有 `advanced`。
      //     探针量三件事：① 小组顺序 ② 默认收起的**可见字段全集**（必须等于后端非高级集）
      //     ③ 展开后出现的键（必须等于后端高级集）—— 界面不许自己多塞或少塞。
      result.sectionsOnFetch = [...dlg.querySelectorAll<HTMLElement>('.aps-section')]
        .map((n) => n.getAttribute('data-aps-section'))
      result.visibleKeys = [...dlg.querySelectorAll<HTMLElement>('[data-testid="aps-pane"] [data-setting]')]
        .map((n) => n.getAttribute('data-setting'))
      const foldState = () =>
        dlg.querySelector<HTMLElement>('.aps-fold')?.getAttribute('data-aps-advanced') ?? null
      result.advancedStateClosed = foldState()
      result.advancedRowsWhenClosed =
        dlg.querySelectorAll('[data-aps-advanced-body] [data-setting]').length
      // ⚠️ 比的是**这一页**的集合：非高级键在别的页（数据源）也有，拿全局集合比会假红
      const paneGroup = '抓取设置'
      result.visibleFromApi = settingsBody.specs
        .filter((s) => !s.advanced && s.group === paneGroup).map((s) => s.key)
      result.advancedFromApi = settingsBody.specs
        .filter((s) => s.advanced && s.group === paneGroup).map((s) => s.key)
      await openAdvanced()
      result.advancedStateOpen = foldState()
      result.advancedKeys = [...dlg.querySelectorAll<HTMLElement>(
        '[data-aps-advanced-body] [data-setting]')].map((n) => n.getAttribute('data-setting'))

      // ③c 排版层级（R21 批 2）：量出来才算数 —— "更醒目"这件事必须落成字号/字重/行距的数字，
      //     否则下次谁调一下 CSS 都没人知道层级已经平了。
      const paneFirstRow = dlg.querySelector<HTMLElement>('.aps-section .aps-row')
      const paneLabel = paneFirstRow?.querySelector<HTMLElement>('.aps-label')
      const paneNote = paneFirstRow?.querySelector<HTMLElement>('.aps-note')
      const paneHead = dlg.querySelector<HTMLElement>('.aps-section-head')
      const px = (v: string) => Math.round(parseFloat(v) * 10) / 10
      if (paneLabel && paneNote) {
        const ls = getComputedStyle(paneLabel)
        const ns = getComputedStyle(paneNote)
        const rowCs = getComputedStyle(paneFirstRow!)
        result.typeLabel = { size: px(ls.fontSize), weight: ls.fontWeight }
        result.typeNote = { size: px(ns.fontSize), lineHeight: px(ns.lineHeight) }
        result.typeRowPadding = px(rowCs.paddingTop)
      }
      if (paneHead) {
        const hs = getComputedStyle(paneHead)
        result.typeSectionHead = { size: px(hs.fontSize), weight: hs.fontWeight }
      }

      // ③d 数字框 = 整行步进条（R21 批 2）：几何 + 两个箭头可命中 + 藏掉了原生箭头
      //     ⚠️ 先把它滚进视野再量：FIELD 是「高级」里的行，展开后在长面板的底部，
      //     `getBoundingClientRect` 照样给坐标、但那个位置已经被 `.aps-pane-scroll` 裁掉了 ——
      //     `elementFromPoint` 命中不到，会假报"箭头点不着"。
      dlg.querySelector<HTMLElement>(`[data-setting="${FIELD}"]`)
        ?.scrollIntoView({ block: 'center' })
      await sleep(220)
      const stepRow = dlg.querySelector<HTMLElement>(`[data-setting="${FIELD}"]`)
      const stepBar = stepRow?.querySelector<HTMLElement>('.aps-step')
      const stepUp = stepRow?.querySelector<HTMLButtonElement>('.aps-step-btn[data-step="1"]')
      const stepDown = stepRow?.querySelector<HTMLButtonElement>('.aps-step-btn[data-step="-1"]')
      if (stepBar && stepUp && stepDown) {
        const sr = rectOf(stepBar)
        const ur = rectOf(stepUp)
        result.stepGeometry = sr ? { h: Math.round(sr.height) } : null
        result.stepArrows = { up: !!ur, down: !!rectOf(stepDown) }
        result.stepArrowHit = !!(ur && hits(stepUp, ur.left + ur.width / 2, ur.top + ur.height / 2))
        // 输入框在步进条里不该再有自己的边框（外壳由 .aps-step 提供）
        const inner = stepBar.querySelector<HTMLInputElement>('.aps-input')
        result.stepInnerBorder = inner ? getComputedStyle(inner).borderTopWidth : null
      }

      // ⚠️ **每次交互前重新查节点**：R17 起字段是分页渲染的，切页 = 卸载重挂，
      //    早先抓到的 `input` 会变成游离节点（写它不会触发 React onChange）——
      //    与 devlog/071→080 那次"探针读了旧 DOM 节点"是同一类坑，这次由分页引入。
      const rowNow = () => dlg.querySelector<HTMLElement>(`[data-setting="${FIELD}"]`)
      const inputNow = () => rowNow()?.querySelector<HTMLInputElement>('.aps-input') ?? null
      const saveBtn = dlg.querySelector<HTMLButtonElement>('[data-testid="app-settings-save"]')
      result.beforeValue = await serverValue(FIELD)
      result.inputValueBefore = inputNow()?.value ?? null

      // ④ 几何与可命中：两栏都要在视口内、都点得着（分页布局最容易出的问题是
      //    右栏被挤出去 / 导航点不着）；同时量一下两栏宽度（左边固定、右边吃满）
      const dr = rectOf(dlg)
      result.dialogInViewport = !!dr && dr.left >= -0.5 && dr.top >= -0.5 &&
        dr.right <= window.innerWidth + 0.5 && dr.bottom <= window.innerHeight + 0.5
      result.dialogHit = !!(dr && hits(dlg, dr.left + 8, dr.top + 8))
      const navEl = dlg.querySelector<HTMLElement>('.aps-nav')
      const paneEl = paneOf()
      const nr = rectOf(navEl)
      const pr2 = rectOf(paneEl)
      result.navWidth = nr ? Math.round(nr.width * 10) / 10 : null
      result.paneWidth = pr2 ? Math.round(pr2.width * 10) / 10 : null
      result.navInsideDialog = !!(nr && dr && nr.left >= dr.left - 0.5 &&
        nr.right <= dr.right + 0.5)
      const firstNav = dlg.querySelector<HTMLElement>('.aps-nav-item')
      const fnr = rectOf(firstNav)
      result.navItemHit = !!(firstNav && fnr &&
        hits(firstNav, fnr.left + fnr.width / 2, fnr.top + fnr.height / 2))
      result.paneHit = !!pr2 && hits(paneEl, pr2.left + 20, pr2.top + 20)
      // 导航项宽度必须**吃满左栏**（选中态的 3px 竖条要贴左缘才成立）
      result.navItemFillsNav = !!(fnr && nr && Math.abs(fnr.width - nr.width) <= 1)

      // ⑤ 越界：保存钮禁用 + 红字（前端那道）
      if (inputNow()) {
        typeInto(inputNow()!, '999')
        await sleep(60)
        result.overSaveDisabled = !!saveBtn?.disabled
        result.overError = text(rowNow()?.querySelector('.aps-field-error')) || null
      }

      // ⑥ **切页不丢草稿** + 圆点只亮在改过的那一页（R17 两栏布局的核心口径）
      //    ⚠️ R21 起 FIELD 属于「高级」：换页会把折叠收回（每页默认收起），
      //    所以切回来之后必须重新展开 —— 否则 `inputNow()` 拿到 null，这条断言会假红。
      if (inputNow()) {
        typeInto(inputNow()!, '7')
        await sleep(150)
        const dirtyNav = [...dlg.querySelectorAll<HTMLElement>('.aps-nav-item')]
          .filter((n) => n.getAttribute('data-nav-dirty') === '1')
          .map((n) => (n.querySelector('.aps-nav-label')?.textContent || '').trim())
        result.dirtyNavLabels = dirtyNav
        await clickNav('数据源')
        // ⑥-b 开关（R21 批 2 用户口径）：滑块放大到 32×18、**外层那圈描边+底色去掉**、
        //      并带上浮片投影（与 .float-pill 同族）。在「数据源」页量 —— 那页才有开关。
        const sw = dlg.querySelector<HTMLElement>('[data-setting="EXTERNAL_ENABLED"] .aps-switch')
        const swTrack = sw?.querySelector<HTMLElement>('i')
        if (sw && swTrack) {
          const swr = rectOf(swTrack)
          const swCs = getComputedStyle(sw)
          const knobCs = getComputedStyle(swTrack, '::after')
          result.switchTrack = swr ? { w: Math.round(swr.width), h: Math.round(swr.height) } : null
          result.switchKnob = { w: px(knobCs.width), h: px(knobCs.height) }
          result.switchShell = {
            border: swCs.borderTopWidth, padding: swCs.paddingTop, bg: swCs.backgroundColor,
          }
          result.switchShadow = getComputedStyle(swTrack).boxShadow
          result.switchLabel = (sw.textContent || '').trim()
          result.switchHit = !!(swr && hits(sw, swr.left + swr.width / 2, swr.top + swr.height / 2))
        }
        await clickNav('抓取设置')
        // 回到本页时**还没展开**：读一次状态，证明"换页把折叠收回去了"（每页各自的默认态）。
        // ⚠️ 不能在「数据源」页读 —— 那页没有高级项，`.aps-fold` 根本不存在（会读到 null）。
        result.advancedCollapsedAfterSwitch = foldState()
        await openAdvanced()
        result.draftKeptAcrossPanes = inputNow()?.value ?? null
      }

      // ⑦ 「恢复本类默认」只填本类草稿（不落库，仍需保存）
      const resetOne = dlg.querySelector<HTMLButtonElement>('[data-testid="aps-reset-category"]')
      result.hasResetOne = !!resetOne
      resetOne?.click()
      await sleep(200)
      result.afterResetOne = inputNow()?.value ?? null
      result.resetOneTouchedOtherGroup = dlg.querySelectorAll(
        '[data-setting="EXTERNAL_ENABLED"]').length      // 别类字段不该出现在本页
      if (inputNow()) {                                    // 还原成待保存状态，继续后面的保存断言
        typeInto(inputNow()!, '7')
        await sleep(150)
      }

      // ⑦-b 步进条的行为（R21 批 2）：右箭头 +1、左箭头 −1、到上界置灰、键盘仍能直接敲。
      //      ⚠️ 箭头节点**每次重新查**：切页会把整个面板卸载重挂，早先抓到的按钮已经是游离节点
      //     （点它不会触发 React 事件）—— 与 R17 分页那次是同一个坑。
      const upNow = () => dlg.querySelector<HTMLButtonElement>(
        `[data-setting="${FIELD}"] .aps-step-btn[data-step="1"]`)
      const downNow = () => dlg.querySelector<HTMLButtonElement>(
        `[data-setting="${FIELD}"] .aps-step-btn[data-step="-1"]`)
      if (inputNow() && upNow() && downNow()) {
        upNow()!.click()
        await sleep(150)
        result.stepUpValue = inputNow()?.value ?? null
        downNow()!.click()
        await sleep(150)
        result.stepDownValue = inputNow()?.value ?? null
        typeInto(inputNow()!, '100')                       // 顶到上界
        await sleep(150)
        result.stepUpDisabledAtMax = upNow()?.disabled ?? null
        result.stepDownEnabledAtMax = downNow()?.disabled === false
        typeInto(inputNow()!, '7')                         // 回到待保存的合法值
        await sleep(150)
      }

      // ⑦-c 弹窗页脚统一浮片（R21 批 3）：两个按钮都必须是 `.float-pill`，
      //      且「保存」这个主操作带 `.on`（主色深填白字）—— 顺手量一下可命中。
      const footPills = [...dlg.querySelectorAll<HTMLElement>('.aps-foot-actions button')]
      result.footPills = footPills.map((b) => b.className)
      result.footPillActiveIdx = footPills.findIndex((b) => b.classList.contains('on'))
      result.footPillHit = footPills.every((b) => {
        const r = rectOf(b)
        return !!r && hits(b, r.left + r.width / 2, r.top + r.height / 2)
      })

      // ⑧ 合法值 → 保存 → **服务端**对账
      if (inputNow()) {
        result.saveEnabled = !!saveBtn && !saveBtn.disabled
        saveBtn?.click()
        await waitFor(() => dlg.querySelector(`[data-setting="${FIELD}"] .aps-badge`), 5000)
        await sleep(400)
        result.afterValue = await serverValue(FIELD)
        result.badgeShown = !!dlg.querySelector(`[data-setting="${FIELD}"] .aps-badge`)
        result.inputValueAfter = inputNow()?.value ?? null
        result.footState = text(dlg.querySelector('.aps-foot-state'))
      }

      // ⑩ 恢复默认（全局：抓取参数 + 主题）
      // 匹配用 `/恢复.*默认/`：按钮文案是「恢复全部默认」，写死「恢复默认」会匹配不到
      // （2026-09-15 实测：改名后探针报"底部没有这个按钮"，其实是判据太死）
      const resetBtn = [...dlg.querySelectorAll<HTMLButtonElement>('.aps-foot-actions button')]
        .find((b) => /恢复.*默认/.test(text(b)))
      result.hasResetBtn = !!resetBtn
      result.resetBtnLabel = text(resetBtn) || null
      // 等它真的可点：保存刚结束那一瞬 `busy` 还没回落，两个底部按钮都是 disabled，
      // 此时 `.click()` 是**静默无效**的（2026-09-15 实测：服务端的值没回去）
      for (let i = 0; i < 30 && resetBtn?.disabled; i++) await sleep(100)
      result.resetBtnEnabled = !!resetBtn && !resetBtn.disabled
      resetBtn?.click()
      await waitFor(() => !dlg.querySelector(`[data-setting="${FIELD}"] .aps-badge`), 5000)
      await sleep(400)
      result.resetValue = await serverValue(FIELD)
      result.badgeAfterReset = !!dlg.querySelector(`[data-setting="${FIELD}"] .aps-badge`)

      // ⑪ 「关于」页：只读信息 + **逐条理由**（不给改的必须说明为什么）
      await clickNav('关于')
      result.aboutPane = paneOf()?.getAttribute('data-pane')
      result.readonlyRows = dlg.querySelectorAll('.aps-readonly-item').length
      result.readonlyReasons = [...dlg.querySelectorAll('.aps-readonly-why')]
        .filter((n) => text(n).length > 6).length
      result.aboutInfoRows = dlg.querySelectorAll('.aps-info dt').length
      result.aboutHasWriteInputs = dlg.querySelectorAll('.aps-input, .aps-switch').length
      /** ── 「关于」页排版（R39-B，用户 2026-09-19：按钮/信息/小字混在一起）──────────
       *  这几条都是"看着乱、但很难举证"的：版本重复两遍、按钮夹在信息行里、
       *  注释小字插在数字与按钮之间、数值列不对齐。全部变成可量的。 */
      const aboutPane = paneOf()
      const aboutText = text(aboutPane)
      /** 版本号出现次数：按"版本形状"的数（`1.0.2`）数，不依赖任何属性 ——
       *  这样即使实现还没加钩子，判据也有牙（量到 2 次就是"重复了"）。 */
      result.aboutVersionCount = (aboutText.match(/\b\d+\.\d+\.\d+\b/g) || []).length
      result.aboutVersions = aboutText.match(/\b\d+\.\d+\.\d+\b/g) || []
      result.aboutInfoButtons = dlg.querySelectorAll('.aps-info button, .aps-note button').length
      result.aboutSectionHeads = [...dlg.querySelectorAll('.aps-section-head')]
        .map((n) => text(n))
      const storageSec = dlg.querySelector<HTMLElement>('[data-testid="aps-storage"]')
      result.aboutStorageOrder = storageSec
        ? [...storageSec.children].map((n) => (n.className || '').split(' ')[0])
        : []
      const numDd = dlg.querySelector<HTMLElement>('[data-storage="img_cache"]')
      if (numDd) {
        const cs = getComputedStyle(numDd)
        result.aboutNumAlign = {
          display: cs.display,
          justify: cs.justifyContent,
          tabular: cs.fontVariantNumeric,
        }
      }
      const sep = dlg.querySelector<HTMLElement>('.aps-info--group')
      result.aboutGroupBorder = sep
        ? parseFloat(getComputedStyle(sep).borderTopWidth) || 0
        : null
      /** 「应用更新」应当**并入「运行信息」段末尾**（R39-B2，用户 2026-09-19） */
      const infoSec = dlg.querySelector<HTMLElement>('[data-testid="aps-about-info"]')
      result.aboutUpdateInsideInfo = !!infoSec?.querySelector('[data-testid="aps-update"]')
      result.aboutUpdateSectionHead = [...dlg.querySelectorAll('.aps-section-head')]
        .some((n) => text(n).includes('应用更新'))
      // 应用更新面板（R23b/R24）：**浏览器里没有更新这回事** ⇒ 面板要在（说明当前版本），
      // 但**不许出现「检查更新」按钮**（会点出一个必然失败的请求）。这条判据挡的是
      // "忘记做环境判断、把桌面端按钮渲染到浏览器里"。
      const upPanel = dlg.querySelector<HTMLElement>('[data-testid="aps-update"]')
      result.updatePanel = !!upPanel
      result.updatePanelText = text(upPanel)
      result.updateCheckBtn = !!dlg.querySelector('[data-testid="aps-update-check"]')

      // ⑫ 主题（R14b/R17）：三张卡片（浅色 / 深色 / 跟随系统），深色**只标不藏**
      const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      const prefBefore = await fetch(`${getApiBase()}/settings/prefs`).then((r) => r.json())
      result.themeServerBefore = prefBefore.values.theme
      await clickNav('外观')
      result.themeOptions = [...dlg.querySelectorAll('[data-theme-option]')]
        .map((n) => n.getAttribute('data-theme-option'))
      const darkCard = dlg.querySelector<HTMLButtonElement>('[data-theme-option="dark"]')
      result.themeDarkDisabled = !!darkCard?.disabled
      result.themeDarkNote = text(darkCard?.querySelector('.aps-theme-note')) || null
      const optSystem = dlg.querySelector<HTMLElement>('[data-theme-option="system"]')
      const orr = rectOf(optSystem)
      result.themeSystemHit = !!(optSystem && orr &&
        hits(optSystem, orr.left + orr.width / 2, orr.top + orr.height / 2))
      optSystem?.click()
      await waitFor(
        () => dlg.querySelector('[data-theme-option="system"]')?.getAttribute('aria-checked') === 'true',
        4000)
      await sleep(400)
      const prefAfter = await fetch(`${getApiBase()}/settings/prefs`).then((r) => r.json())
      result.themeServerAfter = prefAfter.values.theme
      result.themeSelected = dlg.querySelector('[data-theme-option="system"]')
        ?.getAttribute('aria-checked')
      result.themeRootAttr = document.documentElement.getAttribute('data-theme')
      result.themeSystemDark = sysDark
      // 系统是深色 + 深色未实现 → 必须给出那句说明（否则用户以为跟随坏了）
      result.themeCaveat = text(dlg.querySelector('[data-theme-caveat]')) || null
      // 还原成浅色（探针不留痕）
      dlg.querySelector<HTMLElement>('[data-theme-option="light"]')?.click()
      await waitFor(
        () => dlg.querySelector('[data-theme-option="light"]')?.getAttribute('aria-checked') === 'true',
        4000)
      await sleep(300)
      result.themeServerRestored = (await fetch(`${getApiBase()}/settings/prefs`)
        .then((r) => r.json())).values.theme

      // ⑬ 关闭（Esc 是 radix 的取消手势）。
      //    `&keepOpen=1` 时**跳过关闭**：视觉存档要用一张"弹窗开着"的图
      //    （`ui_probe --app-settings --shot`）。断言仍然照跑，只是不收尾。
      const keepOpen = new URLSearchParams(window.location.search).get('keepOpen') === '1'
      if (!keepOpen) {
        // ⚠️ 实测坑：齿轮的 tooltip 也是一个 dismissable layer，且它**在弹窗之后**注册
        //    （点击让按钮获得焦点 → tooltip 打开），于是它是"最高层"、Esc 先被它吃掉。
        //    所以先点一下弹窗标题区把焦点/tooltip 挪开，再派发 Esc —— 与真实用户
        //    "看一眼弹窗内容再按 Esc"的时序一致。
        // 关闭：Esc 走 radix Dialog 自带的取消手势（**组件不再自己挂一条**：
        // 2026-09-15 一度以为它不生效、自己挂了一条，后来发现是探针判据错了 ——
        // 见上面 `dlgOpen()` 的注释：关掉之后 Presence 会留着节点播退场动画）。
        const escTarget = (document.activeElement as HTMLElement | null) ?? dlg
        escTarget.dispatchEvent(new KeyboardEvent('keydown',
          { key: 'Escape', bubbles: true, cancelable: true }))
        result.closedByEsc = await waitFor(() => !dlgOpen(), 3000)
        result.dialogStateAfterEsc = document
          .querySelector('[data-testid="app-settings-dialog"]')?.getAttribute('data-state') ?? null
      }
    }

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'app-settings', views: [], degraded,
                                       appSettings: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 两枚「筛选」浮片对比（`?probe=filter-pill`，配合 `ui_probe.py --filter-pill`）：
  // 用户 2026-09-15：「list 视图中的筛选按钮的样式跟随左栏工具栏中的筛选按钮」。
  // 这是一条**纯视觉**的要求（两张截图），所以先把两枚浮片的可量化样式逐项量出来 ——
  // 否则"跟随"就只是"我觉得像了"：改完没人能证明它俩真的一样。
  // 量的是：尺寸 / 字号 / 内距 / 圆角 / 颜色 / 斜切 / caret 的定位方式与相对位置 /
  // **纯文字**的中心偏移（caret 若在流内会把文字挤偏 —— 这正是两枚看起来不同的根源之一）。
  if (mode === 'filter-pill') {
    // 量的是**静态几何与样式**，所以先把动画/过渡掐掉（虚拟时间会把它们冻在中途 ——
    // 2026-09-15 在 chevron 上踩过：读到的是过渡进度而不是终值）
    const killAnim = document.createElement('style')
    killAnim.textContent =
      '*, *::before, *::after { animation: none !important; transition: none !important; }'
    document.head.appendChild(killAnim)
    const waitFor = async (fn: () => unknown, ms = 6000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        if (fn()) return true
        await sleep(100)
      }
      return false
    }
    // list 视图那枚只在「帖子列表」视图里存在 —— 先切过去（默认落在档案视图）
    if (!document.querySelector('.pfilter-btn')) {
      const btn = [...document.querySelectorAll<HTMLButtonElement>('.view-btn')]
        .find((b) => (b.title || '').startsWith('帖子列表'))
      btn?.click()
      await waitFor(() => document.querySelector('.pfilter-btn'))
      await sleep(400)     // 场景入场 + 数据到位
    }
    const describe = (el: HTMLElement | null) => {
      if (!el) return null
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const before = getComputedStyle(el, '::before')
      const caret = el.querySelector<HTMLElement>('.pill-caret')
      const cr = caret?.getBoundingClientRect() ?? null
      const ccs = caret ? getComputedStyle(caret) : null
      // 纯文字矩形：用 Range 框住**文案节点**（把 caret 排除掉）——
      // 只量元素矩形会把 caret 的宽度算进去，"文字到底居没居中"就量不出来了。
      // 文案可能裸着（侧栏那枚）也可能套在 `.pf-label` 里（list 那枚，为了对称留白）——
      // 两种都要能量，否则换一次 DOM 结构探针就瞎了。
      const labelEl = el.querySelector<HTMLElement>('.pf-label')
      const tn = [...(labelEl ?? el).childNodes].find(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim())
      let text: { left: number; right: number; center: number; width: number } | null = null
      if (tn) {
        const rg = document.createRange()
        rg.selectNodeContents(tn)
        const tr = rg.getBoundingClientRect()
        text = { left: tr.left, right: tr.right, center: (tr.left + tr.right) / 2, width: tr.width }
      }
      const r1 = (x: number | null | undefined) =>
        x === null || x === undefined ? null : Math.round(x * 10) / 10
      return {
        text: (el.textContent || '').trim(),
        w: r1(r.width), h: r1(r.height),
        fontSize: cs.fontSize, lineHeight: cs.lineHeight,
        padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
        gap: cs.gap, radius: cs.borderRadius, color: cs.color,
        bg: before.backgroundColor, skew: before.transform,
        minWidth: cs.minWidth, width: cs.width,
        caretPosition: ccs?.position ?? null,
        caretInset: ccs ? `${ccs.top}/${ccs.right}` : null,
        caretSize: cr ? `${r1(cr.width)}×${r1(cr.height)}` : null,
        // caret 与文字右缘的间距：侧栏那种"钉在角上"的应当是两位数
        caretGapToText: cr && text ? r1(cr.left - text.right) : null,
        caretFromRight: cr ? r1(r.right - cr.right) : null,
        // caret 的垂直中心相对浮片中心：>0 偏下。<0 偏上（侧栏是 top:3px 钉右上）
        caretCenterOffset: cr ? r1((cr.top + cr.height / 2) - (r.top + r.height / 2)) : null,
        // **文字**（不含 caret）的中心偏移：0 = 文字真的居中
        textCenterOffset: text ? r1(text.center - (r.left + r.width / 2)) : null,
        textInset: text ? [r1(text.left - r.left), r1(r.right - text.right)] : null,
      }
    }
    const result: Record<string, unknown> = {
      sidebar: describe(document.querySelector<HTMLElement>('.list-filter-btn')),
      list: describe(document.querySelector<HTMLElement>('.pfilter-btn')),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    }

    // 边界：文案变长时（「筛选 · 3」）浮片要能长、且 caret 不许压到字上。
    // 只量 2 字的静态态会把"宽度够不够"这件事漏掉 —— 而宽度正是 caret 出流之后
    // 唯一还靠留白兜着的东西。
    const pf = document.querySelector<HTMLElement>('.pfilter-btn')
    if (pf) {
      pf.click()                                   // 打开筛选弹窗
      await waitFor(() => document.querySelector('.post-filter-pop'))
      const chips = [...document.querySelectorAll<HTMLButtonElement>(
        '.post-filter-pop .filter-chip')]
      // 点两枚"会生效"的 chip（已删 / 仅未归档）→ 文案变「筛选 · 2」；再点时间不做，
      // 日历草稿要确认才生效，这里不值得引入那一段交互
      const on = chips.filter((c) => !c.classList.contains('on')).slice(0, 2)
      for (const c of on) {
        c.click()
        await sleep(250)
      }
      const wide = describe(document.querySelector<HTMLElement>('.pfilter-btn'))
      result.listWide = wide
      // 合成一个**足够长**的文案再量一次：留白必须让浮片长出去，
      // 而不是把文字挤到 caret 底下（真实文案最长是「筛选 · 3」，够不到这个边界）。
      // 直接改文案节点量一帧即可 —— React 会在下次渲染时写回。
      const pfLabel = pf.querySelector<HTMLElement>('.pf-label')
      const tn = [...(pfLabel ?? pf).childNodes].find(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim())
      if (tn) {
        const old = tn.textContent
        tn.textContent = '筛选 · 12 项'
        void pf.getBoundingClientRect()
        result.listLongLabel = describe(pf)
        tn.textContent = old
        void pf.getBoundingClientRect()
      }
      // 复位（探针不留痕）：弹窗底部的「重置」
      const reset = [...document.querySelectorAll<HTMLButtonElement>(
        '.post-filter-pop .pop-actions button')]
        .find((b) => /重置/.test(b.textContent || ''))
      reset?.click()
      await sleep(300)
      // 关掉弹窗（Esc）
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(200)
      result.listAfterReset = describe(document.querySelector<HTMLElement>('.pfilter-btn'))
    }

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'filter-pill', views: [], degraded,
                                       filterPill: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 托盘隐藏后的"停表"验证（`?probe=tray-suspend`，R18 devlog/095）：
  // 用户要的是「关闭 → 隐藏到托盘，后台抓取照常，但**不用渲染前端**」。
  // 托盘本身是无头浏览器测不到的（OS 级），但"隐藏之后该发生什么"完全可断言 ——
  // 页面里有 dev 钩子 `window.__ddtoolkitSetShellHidden()`（`utils/shellLifecycle` 装的）。
  //
  // 三段对照（缺了第一段这探针就是空转：一个彻底卡死的应用也能"通过"隐藏断言）：
  //   ① 可见时：抓取轮询**必须在跑**（计数增长）—— 基线；
  //   ② 隐藏后：计数**必须停住**，状态岛空闲轮播也必须停（文案不再变）；
  //   ③ 唤回后：**立刻补一轮**（而不是等下一个 10s 周期）—— 用户回来看到的是新状态。
  if (mode === 'tray-suspend') {
    const result: Record<string, unknown> = {}
    const waitFor = async (fn: () => unknown, ms = 6000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        if (fn()) return true
        await sleep(100)
      }
      return false
    }
    /** 抓取状态轮询的请求数（探针只看这一条：它是界面里最频繁的请求） */
    const pollCount = () => performance.getEntriesByType('resource')
      .filter((e) => e.name.includes('/vtuber/fetch-status')).length
    /** 每次轮询的发生时刻（相对导航开始），排查"隐藏后那一发"是从哪来的 */
    const pollTimes = () => performance.getEntriesByType('resource')
      .filter((e) => e.name.includes('/vtuber/fetch-status'))
      .map((e) => Math.round(e.startTime))
    const islandText = () =>
      (document.querySelector('.si-text')?.textContent || '').trim()
    const setHidden = (v: boolean) => {
      const fn = (window as unknown as {
        __ddtoolkitSetShellHidden?: (x: boolean) => void
      }).__ddtoolkitSetShellHidden
      fn?.(v)
      return typeof fn === 'function'
    }

    result.hookInstalled = await waitFor(
      () => typeof (window as unknown as { __ddtoolkitSetShellHidden?: unknown })
        .__ddtoolkitSetShellHidden === 'function', 6000)
    await waitFor(() => pollCount() > 0, 8000)   // 等第一次轮询落地

    // ① 可见基线：等一个空闲周期（POLL_IDLE_MS = 10s），计数必须增长
    const c0 = pollCount()
    await sleep(11_000)
    const c1 = pollCount()
    result.visiblePolls = c1 - c0
    result.visiblePolling = c1 > c0

    // ② 隐藏：先让在途请求落地，再看一个完整周期里有没有新请求
    await sleep(200)                              // 让 island 有机会进入空闲态
    const idleBefore = islandText()
    const hideAt = Math.round(performance.now())
    setHidden(true)
    await sleep(2_000)
    const c2 = pollCount()
    const hiddenText0 = islandText()
    await sleep(12_000)                           // > 一个空闲轮询周期 + 两轮轮播周期
    const c3 = pollCount()
    const hiddenText1 = islandText()
    result.hideAt = hideAt
    result.pollTimes = pollTimes()
    result.hiddenPolls = c3 - c2
    result.hiddenPollingStopped = c3 === c2
    result.hiddenCarouselStopped = hiddenText0 === hiddenText1
    result.hiddenFlag = (window as unknown as { __ddtoolkitShellHidden?: () => boolean })
      .__ddtoolkitShellHidden?.() ?? null
    result.idleTextSeen = idleBefore

    // ③ 唤回：必须立刻补一轮（3s 内，远小于 10s 周期）
    setHidden(false)
    await sleep(2_500)
    const c4 = pollCount()
    result.shownPolls = c4 - c3
    result.refreshedOnShow = c4 > c3
    result.shownFlag = (window as unknown as { __ddtoolkitShellHidden?: () => boolean })
      .__ddtoolkitShellHidden?.() ?? null

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'tray-suspend', views: [], degraded,
                                       traySuspend: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 切换性能**测量**（`?probe=switch-perf`，2026-09-16）：
  // 用户报"不同视图 / 不同 V 之间快速切换有明显卡顿"。已知**下限是设计定的** ——
  // `useSceneTransition` 的 `EXIT_MS = 150` 刻意退场（为了全程不出现"正在加载"闪帧），
  // 所以这里量的不是"有没有 150ms"，而是四件事：
  //   ① 视图切换 / V 切换各自的"点击 → 目标可见"耗时分布；
  //   ② **连点**（60ms 间隔点两次）的总耗时 —— 明显超过单次就说明旧预取在积压（不能中断）；
  //   ③ 主线程**长任务**（>50ms 阻塞）的条数与最长时间 —— 用来区分"在等动画"与"渲染卡住"；
  //   ④ **连点有没有重播退场**（R31 起是硬判据）：退场只该播一次，连点应当比单次更快。
  //
  // ⚠️ 跑在 Vite dev + React 开发模式（StrictMode 双挂载、未压缩）⇒ 绝对值只当**开发态基线**，
  //    打包版会更快；它的价值是相对信号（哪种切换更贵、贵在动画还是挂载）。
  if (mode === 'switch-perf') {
    const result: Record<string, unknown> = {}
    const longTasks: number[] = []
    let longTaskSupported = false
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(Math.round(e.duration))
      })
      po.observe({ entryTypes: ['longtask'] })
      longTaskSupported = true
    } catch {
      longTaskSupported = false        // 不支持就如实说，别假装"没有长任务"
    }

    const isExiting = () => !!document.querySelector('.view-body.scene-exit')
    /** 光条按钮**按索引取**（2026-09-08 用户定序：卡片 → 列表 → 档案 → 档案卡）。
     *  ⚠️ 不按 title 文本匹配：实测 title 是「档案（直播日历 / 粉丝趋势）」这种长文案，
     *  精确匹配查不到 ⇒ 第一版直接 break，后面的测量全废。 */
    const viewBtns = () => Array.from(document.querySelectorAll<HTMLElement>('.view-btn'))
    const viewBtn = (idx: number) => viewBtns()[idx] || null
    const settle = async (fn: () => boolean, ms = 4000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        if (fn()) return true
        await sleep(15)
      }
      return false
    }

    // ① 视图切换：默认停在「展示页」，所以从「帖子列表」开始循环一圈（最后回到展示页）
    const VIEW_TARGETS: Array<{ idx: number; name: string; sel: string }> = [
      { idx: 1, name: '帖子列表', sel: '.post-grid, .posts-placeholder' },
      { idx: 2, name: '档案', sel: '.live-calendar' },
      { idx: 3, name: '档案卡', sel: '.empty-state' },
      { idx: 0, name: '展示页', sel: '.hero' },
    ]
    const views: Array<{ target: string; ms: number }> = []
    const notLandedViews: string[] = []
    for (const t of VIEW_TARGETS) {
      const btn = viewBtn(t.idx)
      if (!btn) { result.noViewButton = t.name; continue }
      await sleep(250)                        // 让上一次切换彻底落地，测量才干净
      const t0 = performance.now()
      btn.click()
      const landed = await settle(() => !!document.querySelector(t.sel) && !isExiting())
      views.push({ target: t.name, ms: Math.round(performance.now() - t0) })
      if (!landed) notLandedViews.push(t.name)
    }
    result.views = views
    if (notLandedViews.length) result.viewNotLanded = notLandedViews.join(',')

    // ② V 切换：交替点两个 V（此刻在「展示页」，`.hero-name` 可读）
    const vItems = () => Array.from(document.querySelectorAll<HTMLElement>('.vtuber-item'))
    /** 侧栏当前选中项的 V 名 —— 与场景探针同一判据（只比 `.vtuber-name`：整条 item 的文本
     *  含"直播中"徽章与签名，直接比较会假失败，devlog/080 踩过）。 */
    const activeName = () =>
      (document.querySelector('.vtuber-item.active .vtuber-name')?.textContent || '').trim()
    const vs: Array<{ target: string; ms: number }> = []
    const notLandedVs: string[] = []
    result.candidates = vItems().length
    // 先确保停在「展示页」：让每次 V 切换的起点一致（也避免"上一步没落地"污染这组测量）
    const cardsBtn = viewBtn(0)
    if (cardsBtn && (!document.querySelector('.hero') || isExiting())) {
      cardsBtn.click()
      await settle(() => !!document.querySelector('.hero') && !isExiting())
    }
    if (vItems().length < 2) {
      result.reason = 'sidebar-too-small'
    } else {
      for (let i = 0; i < 4; i++) {
        const el = vItems()[i % 2 === 0 ? 1 : 0]
        if (!el) break
        const target = (el.querySelector('.vtuber-name')?.textContent || '').trim()
        if (!target || activeName() === target) continue
        await sleep(250)
        const t0 = performance.now()
        el.click()
        const landed = await settle(() => activeName() === target && !isExiting())
        vs.push({ target, ms: Math.round(performance.now() - t0) })
        if (!landed) notLandedVs.push(target)
      }
    }
    result.vs = vs
    if (notLandedVs.length) result.vNotLanded = notLandedVs.join(',')

    // ③ 连点：60ms 间隔切两次视图，量"第一次点击 → 最终目标可见"的总耗时
    const burst: number[] = []
    for (let round = 0; round < 2; round++) {
      const a = viewBtn(1)      // 帖子列表
      const b = viewBtn(0)      // 展示页
      if (!a || !b) break
      const t0 = performance.now()
      a.click()
      await sleep(60)
      b.click()
      await settle(() => !!document.querySelector('.hero') && !isExiting())
      burst.push(Math.round(performance.now() - t0))
      await sleep(300)
    }
    result.burst = burst

    // ④ **连点是否重播了退场**（R31 护栏，devlog/133）：退场只该播一次 ——
    //    第二次点击落在退场窗口内时应当**立刻提交**（`planSceneStep` 的 `commit`），
    //    所以「连点总耗时」必须**明显短于**「单次切换」（单次含同一段退场）。
    //    判据用 `>=` 而不是"接近"：单次中位本身有噪声，宁可放过也不要假红 ——
    //    真重播的代价是整整一轮退场（>100ms），离中位足够远。
    if (burst.length && views.length) {
      const sorted = views.map((v) => v.ms).slice().sort((a, b) => a - b)
      const med = sorted[Math.floor(sorted.length / 2)]
      const burstMin = Math.min(...burst)
      result.singleMedian = med
      result.burstMin = burstMin
      result.exitReplayed = burstMin >= med
    }

    result.longTaskSupported = longTaskSupported
    result.longTasks = longTasks
    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'switch-perf', views: [], degraded,
                                       switchPerf: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 左栏是否跟着「档案设置」走（R33，devlog/135）：
  // 用户报"在卡片页右上角的设置窗里改过签名和头像之后，左栏应该也对应这个签名和头像"。
  // 这里**只读实际渲染结果**（侧栏那一行的文本与 img src），不重算口径 ——
  // 口径已经由 `utils/avatarSource` / `utils/signSource` 的单测钉住，探针要钉的是"接线接上了没有"。
  // 种数据在 CLI 侧（`_seed_profile` 往副本 DB 写 sign_override / avatar），断言也在 CLI 侧
  // （对照组必须**没变**，防"永远显示自定义值"的假绿）。
  if (mode === 'profile-sync') {
    const result: Record<string, unknown> = {}
    const text = (el: Element | null | undefined) => (el?.textContent || '').trim()
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.vtuber-item'))
    const activeRow = () => document.querySelector<HTMLElement>('.vtuber-item.active')
    const waitFor = async (fn: () => unknown, ms = 8000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = fn()
        if (v) return v
        await sleep(100)
      }
      return null
    }
    const nameOf = (r: HTMLElement | null | undefined) => text(r?.querySelector('.vtuber-name'))
    await waitFor(() => rows().length > 0 && nameOf(activeRow()).length > 0)
    // 卡片签名要等 hero 真正落在展示页（切 V 有 150ms 退场 + 预取）
    await waitFor(() => document.querySelector('.hero-sign'))
    result.activeName = nameOf(activeRow())
    result.sidebarSign = text(activeRow()?.querySelector('.vtuber-sign'))
    // 左栏头像：Radix `AvatarImage` 只在图片**加载完成**后才挂 `<img>`，而探针跑在虚拟时间下，
    // 加载永远不会完成 ⇒ 只能读我们为可测性挂上的 `data-src`（devlog/135）。
    // 卡片那侧走 `ProxyImage`（不 gate 加载），所以直接读 `img.hero-avatar[src]`。
    result.sidebarAvatar = activeRow()?.querySelector('[data-src]')?.getAttribute('data-src') ?? null
    result.sidebarImg = activeRow()?.querySelector('img')?.getAttribute('src') ?? null
    result.heroName = text(document.querySelector('.hero-name'))
    result.heroSign = text(document.querySelector('.hero-sign'))
    // 卡片头像读 `.hero[data-avatar-src]`：`ProxyImage` 在虚拟时间下可能已回落成占位，
    // 直接读 `<img>` 会量成 None（见 HeroCardsView 里的注释）
    result.heroAvatar = document.querySelector('.hero')?.getAttribute('data-avatar-src') ?? null
    result.rows = rows().map((r) => ({
      name: nameOf(r),
      sign: text(r.querySelector('.vtuber-sign')),
      avatar: r.querySelector('[data-src]')?.getAttribute('data-src') ?? null,
    }))
    // ── R33 补（2026-09-19）：**当场改**之后左栏要跟着 ──────────────────────
    // 上面那些是"启动前种进库"的现场（左右两边都是新加载的，覆盖不到"应用内编辑"）。
    // 用户报的正是编辑后的同步 ⇒ 这里模拟"保存后广播"：从接口取一条真实 V、改掉签名、
    // 派发 `ddtoolkit:vtuber-updated`，再读左栏那一行。
    try {
      const base = getApiBase()
      const list = await (await fetch(`${base}/vtuber/list`)).json() as
        { id: number; name: string; sign_override: string | null }[]
      const active = list.find((v) => v.name === result.activeName) ?? list[0]
      if (active) {
        const liveSign = `探针当场改·${Date.now() % 100000}`
        window.dispatchEvent(new CustomEvent('ddtoolkit:vtuber-updated', {
          detail: { ...active, sign_override: liveSign },
        }))
        await sleep(300)
        result.liveSignWant = liveSign
        result.liveSignGot = text(activeRow()?.querySelector('.vtuber-sign'))
        result.liveSignSynced = result.liveSignGot === liveSign
      }
    } catch (e) {
      result.liveSignError = String(e)
    }
    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'profile-sync', views: [], degraded,
                                       profileSync: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 置顶动态（R35，devlog/139）：用户口径「将抓取到的置顶动态同样置顶」。
  // 这条量的是**渲染结果**：帖子里列表第 1 张是不是那张置顶帖、有没有角标与
  // `is-pinned` 类；排序口径由后端 `paginated` 负责（pytest 已钉），这里钉接线。
  // 种数据在 CLI 侧（`_seed_pinned` 往副本 DB 写一条 2020 年的置顶帖 + 一条新对照帖），
  // 断言也在 CLI 侧（对照帖必须**没有**角标，防"所有卡片都挂角标"的假绿）。
  if (mode === 'pinned') {
    const result: Record<string, unknown> = {}
    const text = (el: Element | null | undefined) => (el?.textContent || '').trim()
    const waitFor = async (fn: () => unknown, ms = 10000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = fn()
        if (v) return v
        await sleep(100)
      }
      return null
    }
    // 切到「帖子列表」视图。⚠️ 视图钮的可读名字在 `title` 上（`textContent` 是短标签），
    // 与上面的 `clickView` 同一套约定 —— 只按文本找会一个都找不到（第一次跑就是这么假红的）
    const btn = [...document.querySelectorAll<HTMLElement>('.view-btn')]
      .find((b) => ((b as HTMLElement).title || '').startsWith('帖子列表')
        || text(b).includes('帖子列表'))
    result.viewFound = !!btn
    if (!btn) degraded.push('view-btn:帖子列表')
    btn?.click()
    await waitFor(() => {
      const n = document.querySelectorAll<HTMLElement>('.post-card')
      return n.length ? n : null
    })
    const all = [...document.querySelectorAll<HTMLElement>('.post-card')]
    result.cardCount = all.length
    /** 相对视口的整数盒（"徽章在右上角、且不压标题"这两条靠它判） */
    const rect = (n: Element | null) => {
      if (!n) return null
      const r = n.getBoundingClientRect()
      return { x: Math.round(r.left), y: Math.round(r.top),
               w: Math.round(r.width), h: Math.round(r.height),
               right: Math.round(r.right), bottom: Math.round(r.bottom) }
    }
    /** 元素内**实际文字**的范围（Range 量字形，不是元素盒）。
     *
     *  为什么不能用元素盒：置顶卡的标题有 `padding-right` 给徽章让位，元素盒仍然横跨到
     *  徽章底下 —— 拿盒去判"徽章压住标题"必然假红（第一版就这么错了）。 */
    const textBox = (n: Element | null) => {
      if (!n || !n.firstChild) return null
      const r = document.createRange()
      r.selectNodeContents(n)
      const b = r.getBoundingClientRect()
      return { x: Math.round(b.left), y: Math.round(b.top),
               right: Math.round(b.right), bottom: Math.round(b.bottom) }
    }
    result.cards = all.slice(0, 60).map((c) => ({
      title: text(c.querySelector('.post-card-title')),
      pinned: !!c.querySelector('.post-card-pin'),
      isPinnedClass: c.classList.contains('is-pinned'),
      cardBox: rect(c),
      pinBox: rect(c.querySelector('.post-card-pin')),
      titleBox: textBox(c.querySelector('.post-card-title')),
    }))
    result.degraded = degraded
    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'pinned', views: [], degraded,
                                       pinned: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 档案视图的**可编辑画布**（R37-P2b，devlog/144）：用户口径「以卡片为基本单位，用户可以编辑
  // 卡片的大小、位置、排布」。这里做的是**端到端**的：切到档案视图 → 进编辑态 → 用合成
  // PointerEvent 把第一张卡往右 2 列/往下 1 行拖 → 落 DOM 快照（列/行/盒）交给脚本对账，
  // 脚本再去问后端 `GET /vtuber/{id}/profile-cards`，确认**排布真的落库了**。
  // 宽窗才可编辑（窄窗单列是模型算出来的，编辑会跟它打架 ⇒ 按钮禁用），所以脚本用 1440 跑本模式。
  // 档案视图的**存图模式**（R37-P4a）：只把界面停在档案视图就交差，一个断言都不做 ——
  // 它服务的是**视觉评审**（`ui_probe.py --shot-board` 会各截一张阅读态/编辑态）。
  // `reset=1` 先点「重置默认」（写的是数据目录**副本**，见脚本里 `_prepare_data` 的说明）；
  // `editing=1` 再进编辑态，好让"编辑态的卡片长什么样"也能被看见。
  if (mode === 'board-view') {
    const q = new URLSearchParams(location.search)
    const waitFor = async (fn: () => unknown, ms = 8000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = fn()
        if (v) return v
        await sleep(100)
      }
      return null
    }
    const btn = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('.board-btn')]
        .find((b) => (b.textContent || '').includes(label))
    const result: Record<string, unknown> = {}
    // `view=cards` ⇒ 停在**展示页**（R39-D3：光条压在有背景图的那一页上最容易看出边界，
    // 视觉评审要看的就是那一页）；`view=archive` ⇒ 停在**数据视图**（R40 牌堆）；
    // 默认仍是档案视图。
    const wantView = q.get('view')
    const wantCards = wantView === 'cards'
    const wantDeck = wantView === 'archive'
    ;[...document.querySelectorAll<HTMLButtonElement>('.view-btn')]
      .find((b) => (b.title || '').startsWith(
        wantCards ? '展示页' : wantDeck ? '数据视图' : '档案视图'))?.click()
    await waitFor(() => document.querySelector(
      wantCards ? '.hero' : wantDeck ? '[data-deck]' : '[data-board]'))
    if (!wantCards && !wantDeck && q.get('reset')) {
      btn('编辑布局')?.click()
      await sleep(200)
      btn('重置默认')?.click()
      await sleep(1500)                 // 等整版 PUT 落地 + 回填服务端返回的行
      btn('完成')?.click()
      await sleep(200)
    }
    if (!wantCards && q.get('editing')) {
      btn('编辑布局')?.click()
      await sleep(400)
    }
    if (wantDeck) {
      // 牌堆截图：圆点静止时是隐藏的（R40b 用户要求）⇒ 先滚一下让它们亮起来，
      // 否则截图上根本看不到指示器（"看不见的东西没法评审"）。
      document.querySelector('[data-deck]')?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
      await sleep(300)
    }
    result.editing = document.querySelector('[data-board]')?.getAttribute('data-board-editing')
    result.cards = document.querySelectorAll('.pcard').length
    /** 光条的实矩形（像素分析的锚点：分析脚本按它去图上取边缘剖面） */
    const gb = document.querySelector<HTMLElement>('.glow-bar')?.getBoundingClientRect()
    result.glowRect = gb
      ? { x: Math.round(gb.left), y: Math.round(gb.top),
          w: Math.round(gb.width), h: Math.round(gb.height) }
      : null
    // 动效调测页（R37-P4b）：`?motion=cards` 时必须挂上（它是**动态载入**的，
    // 载入失败只会"什么都没有"，与"本来就不显示"看起来一模一样 ⇒ 必须机器判）。
    // `lab=1` 还会点一下面板里的「按下」按钮，验证它派发的合成事件**真的**驱动了手势。
    const lab = document.querySelector<HTMLElement>('[data-motion-lab]')
    result.lab = !!lab
    if (lab && q.get('lab')) {
      const press = [...lab.querySelectorAll<HTMLButtonElement>('.board-btn')]
        .find((b) => (b.textContent || '').trim() === '按下')
      result.labPress = !!press
      press?.click()
      await sleep(60)
      result.labPhaseOnDown = document.querySelector('.pcard')?.getAttribute('data-card-phase')
      await sleep(420)                              // 长按 350ms 应当自动拾起
      result.labPhaseAfterHold = document.querySelector('.pcard')?.getAttribute('data-card-phase')
      result.labSpeed = getComputedStyle(document.documentElement)
        .getPropertyValue('--motion-scale').trim()
    }
    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'board-view', views: [], degraded, board: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 档案视图的**手势动效**（R37-P4b，规格 `docs/design-archive-cards.md` §5）：
  // 端到端走一遍「按下 → 长按 350ms 拾起 → 跟手 1:1 → 抬手落位 → 收尾」，
  // 每一步都把**相位、内联 transform、实渲染位移**抽出来交给脚本判。
  //
  // 这一组断言的意义在于：手感错了**肉眼很难举证**（跟手差 40px 也像在拖、
  // 缩放没回到 1 也看不出来、迟到的长按定时器会让卡片在抬手后又自己跳起来）。
  if (mode === 'motion-cards') {
    const result: Record<string, unknown> = {}
    const waitFor = async (fn: () => unknown, ms = 8000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = fn()
        if (v) return v
        await sleep(60)
      }
      return null
    }
    /** 等一帧（几何读数前用）：虚拟时间下 rAF 与 setTimeout 的先后不保证，
     *  "睡 120ms 再量"未必等到渲染完成的那一帧（实测过一次竞态：默认档量到跟手正确、
     *  reduced 档量到"还没跟上"）。
     *
     *  ⚠️ 必须带超时兜底：`--force-prefers-reduced-motion` 下 Chromium **不产帧**，
     *  `requestAnimationFrame` 永远不回调 —— 裸 `await frame()` 会让整个探针挂住、
     *  连 `#ui-probe` 都不输出（第一次就是这么红的，看起来像"页面没跑完"）。 */
    const frame = (ms = 200) => Promise.race([
      new Promise<void>((r) => requestAnimationFrame(() => r())),
      sleep(ms),
    ])
    const boardEl = () => document.querySelector<HTMLElement>('[data-board]')
    const cardEls = () => [...document.querySelectorAll<HTMLElement>('.pcard')]
    /** 滚动体（R37-P4d 起：缩放那一步要用"内容坐标位移"判，需要读 scrollTop） */
    const scroller = () => document.querySelector<HTMLElement>('.board-view .os-scroll')
    const phaseOf = (el: Element | null) => el?.getAttribute('data-card-phase') ?? null
    /** 卡片**视觉**中心（含 transform）：跟手判定必须看它，不能看格位 */
    const centerOf = (el: Element | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    const scaleOf = (el: Element | null) => {
      if (!el) return null
      const t = getComputedStyle(el).transform
      if (!t || t === 'none') return 1
      const m = t.match(/matrix\(([^)]+)\)/)
      return m ? Math.round(parseFloat(m[1].split(',')[0]) * 1000) / 1000 : null
    }
    /** **内联** transform（`style.transform`）。
     *
     *  ⚠️ 为什么按下/落位这两处必须读内联值而不是 computed：无头浏览器跑在
     *  `--virtual-time-budget` 下时 **CSS 过渡不推进** —— 实测 `getAnimations()` 里
     *  过渡是 `running` 但 `currentTime` 恒为 0，于是 computed transform 永远停在
     *  **过渡起点**（按下时读到 1、落位后还读到拾起时的矩阵）。那是尺子的问题，不是实现的问题：
     *  "我们提交了什么"看内联，"过渡有没有登记"看 `transition-duration`。 */
    const inlineTransformOf = (el: Element | null) =>
      (el as HTMLElement | null)?.style?.transform || ''

    result.prefersReducedMotion =
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ;[...document.querySelectorAll<HTMLButtonElement>('.view-btn')]
      .find((b) => (b.title || '').startsWith('档案视图'))?.click()
    await waitFor(() => boardEl())
    await sleep(300)

    const grid = boardEl()
    const card = cardEls()[0]
    const head = card?.querySelector<HTMLElement>('.pcard-head')
    result.cardKey = card?.getAttribute('data-card-key') ?? null
    result.gridW = grid ? Math.round(grid.clientWidth) : 0

    if (grid && card && head) {
      const gap = 12
      const colW = ((grid.clientWidth - 11 * gap) / 12)
      const r = head.getBoundingClientRect()
      const at = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
        bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse',
        isPrimary: true, button: 0, buttons: 1, clientX: Math.round(x), clientY: Math.round(y),
        ...extra,
      })
      const key = result.cardKey as string | null
      /** 按 key 取卡片（拖完之后 DOM 顺序可能变，`cardEls()[0]` 未必还是它） */
      const same = () => (key ? document.querySelector<HTMLElement>(`[data-card-key="${key}"]`)
                              : cardEls()[0])
      /** 当前指针位置：所有移动都**相对上一次**推进（不要写绝对坐标 —— 中间插一段
       *  小步移动之后，绝对坐标会变成"往回走"，测的就不是原来那件事了）。 */
      let px = r.left + 24
      let py = r.top + 10
      const moveTo = async (nx: number, ny: number, wait = 120) => {
        px = nx
        py = ny
        grid.dispatchEvent(new PointerEvent('pointermove', at(px, py)))
        await sleep(wait)
        await frame()
      }
      const from = { x: Math.round(px), y: Math.round(py) }
      const before = centerOf(card)
      const editBefore = boardEl()?.getAttribute('data-board-editing')
      const gridTopBefore = grid ? Math.round(grid.getBoundingClientRect().top) : null

      // ① **短按**（阅读态，<350ms 就抬手）：不许拾起、不许留内联位移，
      //    迟到的长按定时器也不许把卡片"隔空拿起来"。先做这一步是因为它必须在**阅读态**验
      //    （编辑态是"按下即拖"，压根没有长按等待）。
      head.dispatchEvent(new PointerEvent('pointerdown', at(from.x, from.y)))
      await sleep(90)
      result.shortPressPhaseDown = phaseOf(card)
      result.shortPressPressInline = inlineTransformOf(card)
      grid.dispatchEvent(new PointerEvent('pointerup', { ...at(from.x, from.y), buttons: 0 }))
      await sleep(200)
      result.shortPressPhase = phaseOf(card)
      result.shortPressScale = scaleOf(card)
      result.shortPressInline = inlineTransformOf(card)
      await sleep(400)                     // 长按定时器本该在 350ms 到点
      result.phaseAfterShortPressTimer = phaseOf(card)
      result.editingAfterShortPress = boardEl()?.getAttribute('data-board-editing')

      // ② 阅读态长按 350ms：应当拾起（并顺手进编辑态）
      head.dispatchEvent(new PointerEvent('pointerdown', at(from.x, from.y)))
      await sleep(60)
      result.phaseOnDown = phaseOf(card)
      result.pressScale = scaleOf(card)
      result.pressInline = inlineTransformOf(card)
      await sleep(420)
      result.phaseHold = phaseOf(card)
      result.liftScale = scaleOf(card)
      result.liftShadow = card ? getComputedStyle(card).boxShadow : null
      result.editingAfterHold = boardEl()?.getAttribute('data-board-editing')
      result.editingBeforeHold = editBefore

      // ③ 跟手：位移**小于一格**（30px < 一列 ~58px、30px < 一行 96px）⇒ 格子不动，
      //    卡片中心应当**恰好**跟着走 30/30（差一点都说明跟手算式错了）
      const c1 = centerOf(card)
      await moveTo(px + 30, py + 30)
      const c2 = centerOf(card)
      result.follow = {
        dx: c2 && c1 ? Math.round(c2.x - c1.x) : null,
        dy: c2 && c1 ? Math.round(c2.y - c1.y) : null,
      }
      result.followInline = inlineTransformOf(card)
      result.followCol = card ? getComputedStyle(card).gridColumnStart : null
      result.phaseFollow = phaseOf(card)

      // ③b **连续小步跟手**（真鼠标就是这样动的）：每一步都量误差。
      //     只抽两点量是不够的 —— 实测踩过：跨格那一帧补偿正确、**下一帧**补偿丢了，
      //     于是卡片在"正确位置"与"差一整格"之间来回跳（用户原话：「每一点移动都像在
      //     吸附不同的网格」）。这里把误差变成逐步数字，任何一步超 2px 都算不跟手。
      //
      //     ⚠️ 这一段**放在退避检查之后**（见下）：它会顺路挤开邻居、把 FLIP 状态搅乱，
      //     放在前面会让"让位/归位"那两条断言变成看运气（实测踩到过）。
      const continuousFollow = async () => {
        const steps: Record<string, unknown>[] = []
        let maxErr = 0
        // 期望值以**这一段的起点**为基准（而不是拖动开始前）：进编辑态时画布上方可能
        // 出现/消失一行提示 —— 那会把整块网格推下去。跟手是"相对指针"的，基准必须是本段起点；
        // "进编辑态不许推动画布"另有一条独立断言（见下）。
        const segStart = centerOf(card)
        for (let i = 1; i <= 12; i += 1) {
          await moveTo(px + 8, py + 3, 30)
          const now = centerOf(card)
          const want = segStart
            ? { x: segStart.x + i * 8, y: segStart.y + i * 3 }
            : null
          const errX = now && want ? Math.round((now.x - want.x) * 10) / 10 : null
          const errY = now && want ? Math.round((now.y - want.y) * 10) / 10 : null
          const e = Math.max(Math.abs(errX ?? 0), Math.abs(errY ?? 0))
          maxErr = Math.max(maxErr, e)
          if (i === 1 || i === 12 || e > 2) {
            steps.push({
              i, errX, errY,
              col: card ? getComputedStyle(card).gridColumnStart : null,
              inline: inlineTransformOf(card),
            })
          }
        }
        return { maxErr: Math.round(maxErr * 10) / 10, samples: steps }
      }
      // **进编辑态不许推动画布**：长按拾起会把界面带进编辑态，若这时上方多出一行提示，
      // 整块网格会当场下移（用户看到的就是"卡片跳了一下"）。这里量画布上缘。
      result.gridTop = {
        before: gridTopBefore,
        after: grid ? Math.round(grid.getBoundingClientRect().top) : null,
      }

      // ④ 跨格跟手：指针**再往前**走一格，格子会跟着换位 ⇒ 卡片**相对屏幕**只该走
      //    "指针位移 − 格子位移"（≡ 指针位移），同时**其余卡片**要被挤开 —— 那一段必须走
      //    FLIP（R37-P4c），所以在这里顺带量下来。
      //    （这一段之前卡片一直在原格附近，所以这次跨格**必然**产生一次新的挤压。）
      const c3 = centerOf(card)
      const stepX = Math.round(colW + gap)
      await moveTo(px + stepX, py, 150)
      const c4 = centerOf(card)
      result.crossCell = {
        pointerDx: stepX,
        visualDx: c4 && c3 ? Math.round(c4.x - c3.x) : null,
        phase: phaseOf(card),
        col: card ? getComputedStyle(card).gridColumnStart : null,
      }
      /** 退避（R37-P4c）：非拖动卡在这时候应当**带着 FLIP 补偿位移**（`data-flip` 有值），
       *  而被拖的那张**不许有** —— 它由跟手位移驱动，两条动画打架会看出"被拽回去"。 */
      result.flipDuring = cardEls()
        .filter((c) => c !== card)
        .map((c) => ({
          key: c.getAttribute('data-card-key'),
          flip: c.getAttribute('data-flip'),
          inline: inlineTransformOf(c),
          dur: getComputedStyle(c).transitionDuration,
        }))
      result.dragFlip = card.getAttribute('data-flip')

      // ④b **归位**（用户 2026-09-18 决策：「让位」与「归位」都要动画）：
      //     把拖动卡挪回原处 ⇒ 被挤开的邻居应当带着**反向**（正 dy）补偿滑回去。
      //     只验"让位"的话，"升回去时瞬移"这种半拉子实现照样能绿。
      //     ⚠️ 先把上一段过渡推到终点：虚拟时间下它停在起点（卡片看着没动），
      //     那样"挪回去"算出来的补偿量是 0 —— 测的就不是归位了。
      settleTransforms()
      await frame()
      await moveTo(px - stepX, py, 160)
      result.flipBack = cardEls()
        .filter((c) => c !== card)
        .map((c) => ({
          key: c.getAttribute('data-card-key'),
          flip: c.getAttribute('data-flip'),
          dur: getComputedStyle(c).transitionDuration,
        }))

      // ④c 连续小步跟手（放在让位/归位之后：它会把邻居的 FLIP 状态搅乱）
      result.followSteps = await continuousFollow()

      // ⑤ 抬手落位 → 收尾（探针等到收敛之后再量，避免量到过渡中间态）
      const up = at(px, py)
      grid.dispatchEvent(new PointerEvent('pointerup', { ...up, buttons: 0 }))
      await sleep(90)                              // 等 React 重渲染（state 更新是异步的）
      result.phaseOnUp = phaseOf(card)
      result.settleTransition = card ? getComputedStyle(card).transitionDuration : null
      await sleep(450)
      result.phaseAfterSettle = phaseOf(card)
      result.transformAfterSettle = card ? getComputedStyle(card).transform : null
      result.inlineAfterSettle = inlineTransformOf(card)
      result.styleAfterSettle = card ? (card.getAttribute('style') || '') : null
      result.willChangeAfterSettle = card ? getComputedStyle(card).willChange : null
      /** 落定后**所有**卡的 FLIP 补偿都必须撤掉（留着就是"回不去了"） */
      result.flipAfterSettle = cardEls().map((c) => ({
        key: c.getAttribute('data-card-key'),
        flip: c.getAttribute('data-flip'),
        inline: inlineTransformOf(c),
      }))
      /** ⚠️ 诊断用：虚拟时间下 CSS 过渡**可能根本不推进**（`currentTime` 停在起点），
       *  那样"落位后 computed transform 还是起点值"就不是我们的 bug，而是尺子的问题。
       *  所以这里同时记下"动画实例数 + 它的当前时间"，让脚本能分辨这两种情况。 */
      result.animations = card
        ? card.getAnimations().map((a) => ({
            prop: (a as CSSTransition).transitionProperty ?? a.constructor.name,
            time: Math.round(Number(a.currentTime) || 0),
            state: a.playState,
          }))
        : []
      result.before = before ? { x: Math.round(before.x), y: Math.round(before.y) } : null

      // ⑥ 编辑态「按下即拖」（2026-09-18 细化：点过「编辑布局」之后不该再要求长按）
      await sleep(300)
      const head3 = same()?.querySelector<HTMLElement>('.pcard-head')
      if (head3) {
        const r3 = head3.getBoundingClientRect()
        const p3 = { x: Math.round(r3.left + 24), y: Math.round(r3.top + 10) }
        head3.dispatchEvent(new PointerEvent('pointerdown', at(p3.x, p3.y)))
        await sleep(80)
        result.editModePhaseOnDown = phaseOf(same())
        grid.dispatchEvent(new PointerEvent('pointerup', { ...at(p3.x, p3.y), buttons: 0 }))
        await sleep(60)
        result.editModePhaseOnUp = phaseOf(same())
      }

      // ⑦ **缩放手柄**（R37-P4c，规格 §5.4）：连续 px 跟手 + 跨格才吸附。
      //    量三件事：① 拖半格 ⇒ 实渲染尺寸跟着变、而**模型格数不变**（这就是"连续跟手"）；
      //    ② 再拖过半格 ⇒ 模型格数才 +1（这就是"跨格吸附"）；③ 松手后内联尺寸清干净。
      await sleep(320)
      const target = same()
      const handle = target?.querySelector<HTMLElement>('.pcard-resize')
      result.resizeHandle = !!handle
      if (handle && target) {
        const modelW = () => Number(target.getAttribute('data-card-w') ?? 0)
        const modelH = () => Number(target.getAttribute('data-card-h') ?? 0)
        const pxSize = () => ({ w: target.offsetWidth, h: target.offsetHeight })
        const hr = handle.getBoundingClientRect()
        const h0 = { x: Math.round(hr.left + 9), y: Math.round(hr.top + 9) }
        result.resizeBefore = { modelW: modelW(), modelH: modelH(), ...pxSize() }
        handle.dispatchEvent(new PointerEvent('pointerdown', at(h0.x, h0.y)))
        await sleep(60)
        // 半格：不足一次吸附 ⇒ 只该看到像素尺寸变化
        // ⚠️ 判据要用**内容坐标位移**（指针位移 + 滚动量）：手柄若正好落在底部触发区里，
        // 自动滚动会让内容多走一截、模型因此吸附 —— 那是 P4d 的正常行为，不是"提前吸附"。
        const halfX = Math.round((colW + gap) * 0.45)
        const halfY = Math.round(96 * 0.45)
        const sBefore = Math.round(scroller()?.scrollTop ?? 0)
        grid.dispatchEvent(new PointerEvent('pointermove', at(h0.x + halfX, h0.y + halfY)))
        await sleep(60)
        await frame()
        const sAfter = Math.round(scroller()?.scrollTop ?? 0)
        result.resizeHalf = {
          modelW: modelW(), modelH: modelH(), ...pxSize(), dx: halfX, dy: halfY,
          scrollFrom: sBefore, scrollTo: sAfter,
          contentDx: halfX, contentDy: halfY + (sAfter - sBefore),
        }
        // 再过一格：模型才该 +1 列 / +1 行
        grid.dispatchEvent(new PointerEvent(
          'pointermove', at(h0.x + Math.round(colW + gap) + 6, h0.y + 100)))
        await sleep(150)
        await frame()
        result.resizeFull = { modelW: modelW(), modelH: modelH(), ...pxSize() }
        grid.dispatchEvent(new PointerEvent(
          'pointerup', { ...at(h0.x + Math.round(colW + gap) + 6, h0.y + 100), buttons: 0 }))
        await sleep(60)
        result.resizeInlineDuringSettle = target.getAttribute('style') || ''
        await sleep(420)
        result.resizeAfter = { modelW: modelW(), modelH: modelH(), ...pxSize() }
        result.resizeInlineAfter = target.getAttribute('style') || ''
      }
      const doneBtn = [...document.querySelectorAll<HTMLButtonElement>('.board-btn')]
        .find((b) => (b.textContent || '').includes('完成'))
      doneBtn?.click()
      await sleep(200)
      result.editingAtEnd = boardEl()?.getAttribute('data-board-editing')
    }

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'motion-cards', views: [], degraded, motion: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 档案视图的**增删卡片**（R37-P3b，规格 §10 的 P3b）：端到端走一遍
  // 「编辑态删掉一张 → 「+ 添加卡片」菜单里只剩它 → 加回来（默认尺寸、不重叠）→
  //   全部在板上时按钮禁用」。脚本再去后端 `GET /vtuber/{id}/profile-cards` 对账 ——
  // 只看 DOM 的话「界面上删了但库里还在」照样绿。
  // 拖动**轨迹**诊断（`?probe=motion-trace`，配 `ui_probe.py --motion-trace`）：
  // 模拟真鼠标那样**小步连续移动**（每次 8px），逐步量「卡片中心的实际位置 vs 期望位置」。
  // 跟手正确时误差应当恒 ≤2px；若误差在 0 与 ±一格之间来回跳，就是"逐格吸附"那种闪动。
  // 同时记下模型格位、DOM 顺序、卡片上的动画实例数 —— 这三样能把嫌疑分开：
  //   · 误差 ≈ ±格距        ⇒ 跟手位移没跟上/被 FLIP 又补了一次
  //   · DOM 顺序在变        ⇒ React 重排节点，正在跑的过渡会被浏览器取消（看着就是闪）
  //   · 动画实例数在涨不落   ⇒ 过渡被反复重启
  // 拖到边缘**自动滚动**（R37-P4d，规格 §5.7）：端到端走一遍
  // 「把卡片拖到底部触发区停住 → 画布自己滚 / 卡片仍在手指下 / 模型行号与网格高度跟着涨 →
  //   回到顶部区 → 反向滚 → 抬手停表 → 缩放手柄同样适用」。
  //
  // 判据里最要紧的是**同步性**：全程 `|卡片中心 − (起点 + 指针位移)| ≤ 2px`。
  // 自动滚动最容易出的错就是"漏掉滚动量"⇒ 卡片滞后/超前恰好一个滚动量（看着就是错位）。
  if (mode === 'motion-scroll') {
    const result: Record<string, unknown> = {}
    const waitFor = async (fn: () => unknown, ms = 8000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = fn()
        if (v) return v
        await sleep(60)
      }
      return null
    }
    const frame = (ms = 200) => Promise.race([
      new Promise<void>((r) => requestAnimationFrame(() => r())),
      sleep(ms),
    ])
    const boardEl = () => document.querySelector<HTMLElement>('[data-board]')
    const scroller = () => document.querySelector<HTMLElement>('.board-view .os-scroll')
    const cardEl = (key: string | null) =>
      (key ? document.querySelector<HTMLElement>(`[data-card-key="${key}"]`)
           : document.querySelector<HTMLElement>('.pcard'))
    const centerOf = (el: Element | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    const modelY = (el: Element | null) => Number(el?.getAttribute('data-card-y') ?? -1)
    const gridH = () => Math.round(boardEl()?.getBoundingClientRect().height ?? 0)
    const scrollTop = () => Math.round(scroller()?.scrollTop ?? -1)

    ;[...document.querySelectorAll<HTMLButtonElement>('.view-btn')]
      .find((b) => (b.title || '').startsWith('档案视图'))?.click()
    await waitFor(() => boardEl())
    await sleep(300)
    ;[...document.querySelectorAll<HTMLButtonElement>('.board-btn')]
      .find((b) => (b.textContent || '').includes('编辑布局'))?.click()
    await sleep(250)
    result.editing = boardEl()?.getAttribute('data-board-editing')

    const sc = scroller()
    const box = sc?.getBoundingClientRect()
    result.zone = box
      ? { top: Math.round(box.top), bottom: Math.round(box.bottom), h: Math.round(box.height) }
      : null
    result.scrollRange = sc ? Math.round(sc.scrollHeight - sc.clientHeight) : -1
    /** 诊断：虚拟时间下 rAF 到底被服务几次（自动滚动的驱动方式选择就靠它） */
    result.rafTicks = await new Promise<number>((resolve) => {
      let n = 0
      const t0 = performance.now()
      const step = () => {
        n += 1
        if (performance.now() - t0 < 400) requestAnimationFrame(step)
        else resolve(n)
      }
      requestAnimationFrame(step)
      window.setTimeout(() => resolve(n), 900)      // 兜底：rAF 不产帧时别把探针挂住
    })

    /** 一次「按住 → （可选）先移到中途 → 停住 → 采样」。
     *
     *  返回同步误差、滚动量、模型与网格的变化。
     *  ⚠️ `downTarget` 必须是**卡头**（`.pcard-head`）：拖动手势的 pointerdown 挂在卡头上，
     *  派发到卡片本身不会向下冒泡（第一版就这么假红的）。
     *  ⚠️ `via` 是给"顶部那一趟"用的：先把手柄挪到容器中部（让卡片有往上的余量），
     *  再从那里开始量 —— 否则卡片一路被顶到第 0 行（clamp）就测不出同步性了。 */
    const dwell = async (
      el: HTMLElement, downTarget: HTMLElement,
      from: { x: number; y: number }, to: { x: number; y: number },
      samples = 8, gap = 110, via?: { x: number; y: number },
    ) => {
      const at = (x: number, y: number, buttons = 1) => ({
        bubbles: true, cancelable: true, pointerId: 21, pointerType: 'mouse',
        isPrimary: true, button: 0, buttons, clientX: Math.round(x), clientY: Math.round(y),
      })
      const target = boardEl() ?? scroller() ?? document.body
      downTarget.dispatchEvent(new PointerEvent('pointerdown', at(from.x, from.y)))
      await sleep(60)
      if (via) {
        target.dispatchEvent(new PointerEvent('pointermove', at(via.x, via.y)))
        await sleep(160)
        await frame()
      }
      // 基准在（可选的）中途点之后才取 —— 期望值 = 基准 + 这一段自己的指针位移
      const start = centerOf(el)
      const s0 = scrollTop()
      const y0 = modelY(el)
      const h0 = gridH()
      const base = via ?? from
      // ⚠️ pointermove/up 必须派发在**网格**上（组件把监听挂在 `.board-grid`）——
      // 派发到它的祖先（滚动体）不会向下冒泡，事件根本到不了 handler（第一版就这么假红的）
      target.dispatchEvent(new PointerEvent('pointermove', at(to.x, to.y)))
      await sleep(80)
      await frame()
      let driftMax = 0
      let driftMaxFree = 0        // 只在"卡片没被顶到第 0 行"的样本里取
      let maxScrollDrop = 0       // 单次采样里 scrollTop **向下掉**的最大幅度（向上拖时最容易出）
      let maxDropRate = 0         // 同上的**速率**（px/ms）—— 虚拟时间下采样间隔会跳，只有速率可比
      let minGridH = Number.POSITIVE_INFINITY
      const trace: Record<string, unknown>[] = []
      let prevScroll = scrollTop()
      let prevT = performance.now()
      for (let i = 0; i < samples; i += 1) {
        // 开场密集采样：向上的塌陷发生在最初 ~200ms 内，110ms 的粗采样会整个漏掉它
        await sleep(i < 8 ? 30 : gap)
        await frame()
        const now = centerOf(el)
        // 期望：卡片中心 = 基准 + 指针位移（跟手恒等式，与滚了多少无关）
        const want = start
          ? { x: start.x + (to.x - base.x), y: start.y + (to.y - base.y) }
          : null
        const drift = now && want
          ? Math.max(Math.abs(now.x - want.x), Math.abs(now.y - want.y)) : 0
        driftMax = Math.max(driftMax, drift)
        const y = modelY(el)
        if (y > 0) driftMaxFree = Math.max(driftMaxFree, drift)
        const st = scrollTop()
        const h = gridH()
        const nowT = performance.now()
        const drop = prevScroll - st                      // 正 = 这一跳往回落了多少
        const dtMs = Math.max(1, nowT - prevT)
        maxScrollDrop = Math.max(maxScrollDrop, drop)
        if (drop > 0) maxDropRate = Math.max(maxDropRate, drop / dtMs)
        minGridH = Math.min(minGridH, h)
        prevScroll = st
        prevT = nowT
        trace.push({ i, scrollTop: st, y, h, phase: el.getAttribute('data-card-phase'),
                     dt: Math.round(dtMs), drop,
                     drift: Math.round(drift * 10) / 10 })
      }
      const out = {
        scrollFrom: s0, scrollTo: scrollTop(), scrolled: scrollTop() - s0,
        modelYFrom: y0, modelYTo: modelY(el),
        gridHFrom: h0, gridHTo: gridH(),
        gridHMin: Number.isFinite(minGridH) ? minGridH : null,
        maxScrollDrop,
        maxDropRate: Math.round(maxDropRate * 1000) / 1000,
        driftMax: Math.round(driftMax * 10) / 10,
        driftMaxFree: Math.round(driftMaxFree * 10) / 10,
        trace,
      }
      target.dispatchEvent(new PointerEvent('pointerup', at(to.x, to.y, 0)))
      // ⚠️ 等**保存落地**再返回：`busy` 期间 `beginDrag` 会直接返回（不接新手势），
      // 于是下一段"按住"根本按不下去 —— 相位会是 idle，看着像"跟手失效"
      await sleep(800)
      return out
    }

    const key = cardEl(null)?.getAttribute('data-card-key') ?? null
    result.cardKey = key
    const card = cardEl(key)
    const head = card?.querySelector<HTMLElement>('.pcard-head')
    if (sc && box && card && head) {
      const r = head.getBoundingClientRect()
      const from = { x: Math.round(r.left + 24), y: Math.round(r.top + 10) }
      // 底部触发区：容器下缘往上 20px（区深 64px）
      result.bottomDwell = await dwell(card, head, from,
                                       { x: from.x, y: Math.round(box.bottom - 20) })
      // 顶部触发区：容器上缘往下 20px。先经停容器中部（让卡片有往上的余量，
      // 否则一路顶到第 0 行会被 clamp，同步性就测不出来了）
      const card2 = cardEl(key)
      const head2 = card2?.querySelector<HTMLElement>('.pcard-head')
      if (card2 && head2) {
        const r2 = head2.getBoundingClientRect()
        const f2 = { x: Math.round(r2.left + 24), y: Math.round(r2.top + 10) }
        const mid = { x: f2.x, y: Math.round(box.top + box.height / 2) }
        result.topDwell = await dwell(card2, head2, f2,
                                      { x: f2.x, y: Math.round(box.top + 20) }, 6, 110, mid)
      }
      // 抬手后**必须停表**
      const s1 = scrollTop()
      await sleep(500)
      result.afterRelease = { from: s1, to: scrollTop(), stopped: scrollTop() === s1 }
      // 缩放手柄同样适用：按住手柄停在下区 ⇒ 一样滚、且卡片变高
      const card3 = cardEl(key)
      const handle = card3?.querySelector<HTMLElement>('.pcard-resize')
      result.resizeHandle = !!handle
      if (card3 && handle) {
        const hr = handle.getBoundingClientRect()
        const hf = { x: Math.round(hr.left + 9), y: Math.round(hr.top + 9) }
        const s2 = scrollTop()
        const hh0 = Number(card3.getAttribute('data-card-h') ?? 0)
        handle.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, pointerId: 22, pointerType: 'mouse',
          isPrimary: true, button: 0, buttons: 1, clientX: hf.x, clientY: hf.y,
        }))
        await sleep(60)
        ;(boardEl() ?? scroller() ?? document.body).dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, pointerId: 22, pointerType: 'mouse',
          isPrimary: true, button: 0, buttons: 1,
          clientX: hf.x, clientY: Math.round(box.bottom - 20),
        }))
        await sleep(700)
        await frame()
        result.resize = {
          scrolled: scrollTop() - s2,
          hFrom: hh0, hTo: Number(cardEl(key)?.getAttribute('data-card-h') ?? 0),
        }
        ;(boardEl() ?? scroller() ?? document.body).dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, cancelable: true, pointerId: 22, pointerType: 'mouse',
          isPrimary: true, button: 0, buttons: 0,
          clientX: hf.x, clientY: Math.round(box.bottom - 20),
        }))
        await sleep(400)
      }
    }
    result.scrollTopEnd = scrollTop()

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'motion-scroll', views: [], degraded, motion: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  if (mode === 'motion-trace') {
    const result: Record<string, unknown> = {}
    const rows: Record<string, unknown>[] = []
    const waitFor = async (fn: () => unknown, ms = 8000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = fn()
        if (v) return v
        await sleep(60)
      }
      return null
    }
    const frame = (ms = 200) => Promise.race([
      new Promise<void>((r) => requestAnimationFrame(() => r())),
      sleep(ms),
    ])
    const boardEl = () => document.querySelector<HTMLElement>('[data-board]')
    const cardsInOrder = () => [...document.querySelectorAll<HTMLElement>('.pcard')]
    const centerOf = (el: Element | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    ;[...document.querySelectorAll<HTMLButtonElement>('.view-btn')]
      .find((b) => (b.title || '').startsWith('档案视图'))?.click()
    await waitFor(() => boardEl())
    await sleep(300)
    // 进编辑态（按下即拖），把"长按等待"这一段排除在诊断之外
    ;[...document.querySelectorAll<HTMLButtonElement>('.board-btn')]
      .find((b) => (b.textContent || '').includes('编辑布局'))?.click()
    await sleep(250)

    const grid = boardEl()
    const card = cardsInOrder()[0]
    const head = card?.querySelector<HTMLElement>('.pcard-head')
    result.cardKey = card?.getAttribute('data-card-key') ?? null
    result.orderBefore = cardsInOrder().map((c) => c.getAttribute('data-card-key'))

    if (grid && card && head) {
      const r = head.getBoundingClientRect()
      const from = { x: Math.round(r.left + 24), y: Math.round(r.top + 10) }
      const at = (x: number, y: number, buttons = 1) => ({
        bubbles: true, cancelable: true, pointerId: 11, pointerType: 'mouse',
        isPrimary: true, button: 0, buttons, clientX: Math.round(x), clientY: Math.round(y),
      })
      const start = centerOf(card)
      head.dispatchEvent(new PointerEvent('pointerdown', at(from.x, from.y)))
      await sleep(60)
      const STEP = 8
      const N = 26
      for (let i = 1; i <= N; i += 1) {
        const px = from.x + i * STEP
        const py = from.y + i * 3
        grid.dispatchEvent(new PointerEvent('pointermove', at(px, py)))
        await sleep(30)
        await frame()
        const now = centerOf(card)
        const want = start ? { x: start.x + i * STEP, y: start.y + i * 3 } : null
        const cs = card ? getComputedStyle(card) : null
        rows.push({
          i,
          errX: now && want ? Math.round((now.x - want.x) * 10) / 10 : null,
          errY: now && want ? Math.round((now.y - want.y) * 10) / 10 : null,
          col: cs?.gridColumnStart ?? null,
          row: cs?.gridRowStart ?? null,
          phase: card?.getAttribute('data-card-phase') ?? null,
          inline: (card as HTMLElement | null)?.style.transform || '',
          flip: card?.getAttribute('data-flip') ?? null,
          anims: card ? card.getAnimations().length : 0,
          order: cardsInOrder().map((c) => c.getAttribute('data-card-key')).join(','),
        })
      }
      grid.dispatchEvent(new PointerEvent('pointerup', at(from.x + N * STEP, from.y + N * 3, 0)))
      await sleep(500)
      result.orderAfter = cardsInOrder().map((c) => c.getAttribute('data-card-key'))
      const errs = rows.map((x) => Math.max(Math.abs(Number(x.errX) || 0), Math.abs(Number(x.errY) || 0)))
      result.maxErr = Math.max(...errs)
      result.rowsWithBigErr = rows.filter((x) => Math.max(Math.abs(Number(x.errX) || 0),
                                                            Math.abs(Number(x.errY) || 0)) > 2).length
      // ⚠️ 比数组要比**内容**：第一版写成 `orderBefore !== orderAfter`（比引用）⇒ 永远报"变了"
      result.orderChanged = (result.orderBefore as string[]).join(',')
        !== (result.orderAfter as string[]).join(',')
      result.rows = rows
    }

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'motion-trace', views: [], degraded, motion: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  if (mode === 'board-cards') {
    const result: Record<string, unknown> = {}
    const waitFor = async (fn: () => unknown, ms = 8000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = fn()
        if (v) return v
        await sleep(80)
      }
      return null
    }
    const boardEl = () => document.querySelector<HTMLElement>('[data-board]')
    const cardEls = () => [...document.querySelectorAll<HTMLElement>('.pcard')]
    const snap = () => cardEls().map((c) => {
      const r = c.getBoundingClientRect()
      return {
        key: c.getAttribute('data-card-key'),
        kind: c.getAttribute('data-card-kind'),
        w: Number(c.getAttribute('data-card-w') ?? 0),
        h: Number(c.getAttribute('data-card-h') ?? 0),
        box: { x: Math.round(r.left), y: Math.round(r.top),
               w: Math.round(r.width), h: Math.round(r.height) },
      }
    })
    const pairwiseOverlap = (cards: ReturnType<typeof snap>) => {
      for (let i = 0; i < cards.length; i += 1) {
        for (let j = i + 1; j < cards.length; j += 1) {
          const a = cards[i].box
          const b = cards[j].box
          if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
            return `${cards[i].key} × ${cards[j].key}`
          }
        }
      }
      return null
    }

    ;[...document.querySelectorAll<HTMLButtonElement>('.view-btn')]
      .find((b) => (b.title || '').startsWith('档案视图'))?.click()
    await waitFor(() => boardEl())
    await sleep(300)
    const editBtn = () => [...document.querySelectorAll<HTMLButtonElement>('.board-btn')]
      .find((b) => (b.textContent || '').includes('编辑布局'))
    editBtn()?.click()
    await sleep(250)
    result.editing = boardEl()?.getAttribute('data-board-editing')
    result.before = snap()

    // ① 删掉一张（选第一张；脚本侧按 kind 对账）
    const victim = cardEls()[0]
    result.deletedKey = victim?.getAttribute('data-card-key') ?? null
    result.deletedKind = victim?.getAttribute('data-card-kind') ?? null
    const del = victim?.querySelector<HTMLElement>('.pcard-remove')
    result.removeBtn = !!del
    del?.click()
    await sleep(900)                    // 等整版 PUT 落地
    result.afterDelete = snap()
    result.deleteOverlap = pairwiseOverlap(result.afterDelete as ReturnType<typeof snap>)

    // ② 「+ 添加卡片」：菜单里应当**只剩**刚删掉的那种
    const addBtn = () => [...document.querySelectorAll<HTMLButtonElement>('.board-btn')]
      .find((b) => (b.textContent || '').includes('添加卡片'))
    result.addBtnFound = !!addBtn()
    result.addBtnDisabledAfterDelete = !!addBtn()?.disabled
    result.addBtnTitleAfterDelete = addBtn()?.title ?? null
    addBtn()?.click()
    await sleep(200)
    const items = [...document.querySelectorAll<HTMLElement>('.board-add-item')]
    result.menuKinds = items.map((b) => b.getAttribute('data-kind'))
    result.menuLabels = items.map((b) => (b.textContent || '').trim())
    items[0]?.click()
    await sleep(1200)                   // 等整版 PUT 落地 + 回填服务端返回的行
    result.afterAdd = snap()
    result.addOverlap = pairwiseOverlap(result.afterAdd as ReturnType<typeof snap>)
    result.addBtnDisabledAfterAdd = !!addBtn()?.disabled
    result.addBtnTitleAfterAdd = addBtn()?.title ?? null
    result.cardsCount = result.afterAdd ? (result.afterAdd as unknown[]).length : 0

    const doneBtn = [...document.querySelectorAll<HTMLButtonElement>('.board-btn')]
      .find((b) => (b.textContent || '').includes('完成'))
    doneBtn?.click()
    await sleep(200)
    result.editingAtEnd = boardEl()?.getAttribute('data-board-editing')

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'board-cards', views: [], degraded, board: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  if (mode === 'board') {
    const result: Record<string, unknown> = {}
    const waitFor = async (fn: () => unknown, ms = 8000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = fn()
        if (v) return v
        await sleep(100)
      }
      return null
    }
    const boardEl = () => document.querySelector<HTMLElement>('[data-board]')
    const cardEls = () => [...document.querySelectorAll<HTMLElement>('.pcard')]
    const rectOf = (n: Element | null) => {
      if (!n) return null
      const r = n.getBoundingClientRect()
      return { x: Math.round(r.left), y: Math.round(r.top),
               w: Math.round(r.width), h: Math.round(r.height) }
    }
    const snapshot = () => cardEls().map((c) => {
      const cs = getComputedStyle(c)
      return {
        key: c.getAttribute('data-card-key'),
        kind: c.getAttribute('data-card-kind'),
        col: Number(cs.gridColumnStart),
        row: Number(cs.gridRowStart),
        hpx: Number(c.getAttribute('data-card-hpx') ?? 0),
        box: rectOf(c),
      }
    })

    const viewBtn = [...document.querySelectorAll<HTMLButtonElement>('.view-btn')]
      .find((b) => (b.title || '').startsWith('档案视图'))
    viewBtn?.click()
    result.viewFound = !!viewBtn
    await waitFor(() => boardEl())
    result.before = snapshot()
    result.cols = boardEl()?.getAttribute('data-board-cols') ?? null

    const editBtn = () => [...document.querySelectorAll<HTMLButtonElement>('.board-btn')]
      .find((b) => (b.textContent || '').includes('编辑布局'))
    result.editBtnFound = !!editBtn()
    result.editBtnDisabled = !!editBtn()?.disabled
    result.editBtnTitle = editBtn()?.title ?? null
    editBtn()?.click()
    await sleep(250)
    result.editing = boardEl()?.getAttribute('data-board-editing') ?? null

    // 合成拖拽：往右 2 列、往下 1 行（列宽从网格实宽反推，与 layoutModel 同式）
    const grid = boardEl()
    const grip = cardEls()[0]?.querySelector<HTMLElement>('.pcard-head')
    result.dragTarget = cardEls()[0]?.getAttribute('data-card-key') ?? null
    if (grid && grip && result.editing === '1') {
      const gap = Number(getComputedStyle(grid).rowGap.replace('px', '')) || 12
      const colW = (grid.clientWidth - 11 * gap) / 12
      const rowH = Number(getComputedStyle(grid).gridAutoRows.replace('px', '')) || 84
      const dx = Math.round(colW * 2)
      const dy = Math.round(rowH + gap)
      const r = grip.getBoundingClientRect()
      const at = (x: number, y: number) => ({
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
        isPrimary: true, clientX: x, clientY: y,
      })
      const from = { x: Math.round(r.left + 24), y: Math.round(r.top + 10) }
      grip.dispatchEvent(new PointerEvent('pointerdown', at(from.x, from.y)))
      // 分两步移动：手势层是"跨格才重算"，一步到位也能过，两步更接近真人拖动
      grid.dispatchEvent(new PointerEvent('pointermove',
        at(from.x + Math.round(dx / 2), from.y + dy)))
      await sleep(80)
      grid.dispatchEvent(new PointerEvent('pointermove', at(from.x + dx, from.y + dy)))
      await sleep(60)
      result.during = snapshot()
      grid.dispatchEvent(new PointerEvent('pointerup', at(from.x + dx, from.y + dy)))
      result.dragDx = dx
      result.dragDy = dy
      await sleep(900)                    // 等整版 PUT 落地 + 回填服务端返回的行
    }
    // ⚠️ 量几何之前先把在飞的过渡推到终点：虚拟时间下它们停在起点，rect 会量成旧位置
    //（下一行的"零重叠"断言就是这么被误判过一次的）。没有过渡时这行是空操作。
    settleTransforms()
    await sleep(60)
    result.after = snapshot()
    result.editingAfter = boardEl()?.getAttribute('data-board-editing') ?? null

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'board', views: [], degraded, board: result })
    document.body.appendChild(pre)
    document.title = 'UI_PROBE_DONE'
    return
  }

  // 首次点 ✕ 的询问流程（`?probe=close-ask`，R20 devlog/097）：
  // 用户 2026-09-15 报的 bug 就在这条链路上（选了"最小化到托盘"之后，托盘「退出」退不出去）。
  // 托盘菜单本身是 OS 级、无头浏览器点不到，但**前端这一半**全能断言：
  //   ① 偏好是 `ask` 时点 ✕ → 弹出询问框（两个选项 + 记住我的选择）；
  //   ② 选「最小化到托盘」→ 偏好写成 `tray`（再问一次后端）+ 前端进入挂起态；
  //   ③ 之后点 ✕ **不再询问**（按记住的选择直接隐藏）。
  if (mode === 'close-ask') {
    const result: Record<string, unknown> = {}
    const waitFor = async (fn: () => unknown, ms = 5000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        if (fn()) return true
        await sleep(100)
      }
      return false
    }
    const text = (el: Element | null | undefined) => (el?.textContent || '').trim()
    const shellHidden = () =>
      (window as unknown as { __ddtoolkitShellHidden?: () => boolean })
        .__ddtoolkitShellHidden?.() ?? null
    const closeBtn = () => document.querySelector<HTMLElement>('.topbar-win-btn.close')
    // ⚠️ 判"弹窗开着没有"看 `data-state`，**不看节点在不在**：radix 的 Presence 会把关闭后的
    //    内容留着播退场动画，而虚拟时间下动画不跑完 ⇒ 节点一直在（R14a 踩过一次，
    //    这里第二次踩到：探针报"询问框没关"，其实它早就关了）。
    const askOpen = () =>
      !!document.querySelector('[data-testid="close-ask-dialog"][data-state="open"]')
    const askDialog = () =>
      document.querySelector<HTMLElement>('[data-testid="close-ask-dialog"]')
    /** 点 ✕：窗口控制钮在非 Tauri 环境是 disabled（浏览器里没有窗口可关），
     *  所以走 TopBar 暴露的 dev 钩子 —— 它挂的是**同一个 handler**。 */
    const clickClose = () => {
      const hook = (window as unknown as { __ddtoolkitCloseClick?: () => void })
        .__ddtoolkitCloseClick
      if (typeof hook === 'function') {
        hook()
        return 'hook'
      }
      closeBtn()?.click()
      return 'button'
    }
    const prefValue = async () =>
      (await fetch(`${getApiBase()}/settings/prefs`).then((r) => r.json())).values.close_action
    const setPref = async (v: string) => {
      await fetch(`${getApiBase()}/settings/prefs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { close_action: v } }),
      })
    }

    await setPref('ask')                       // 从干净状态开始
    result.prefBefore = await prefValue()
    result.closeHit = clickClose()
    result.dialogOpened = await waitFor(askOpen)
    const dlg = askDialog()
    result.choices = [...(dlg?.querySelectorAll('[data-choice]') || [])]
      .map((n) => n.getAttribute('data-choice'))
    result.hasRemember = !!dlg?.querySelector('[data-testid="close-ask-remember"]')
    result.optionNotes = [...(dlg?.querySelectorAll('.close-ask-note') || [])].map((n) => text(n))
    // R21 批 3：询问框页脚的「取消」也统一成浮片（两个选项本身是竖排大按钮，不属于页脚）。
    // 命中就地量（本模式的 `hits/rectOf` 不在这个作用域里）
    const askFoot = dlg?.querySelector<HTMLElement>('.close-ask-foot button')
    result.footPill = askFoot ? askFoot.className : null
    if (askFoot) {
      const r = askFoot.getBoundingClientRect()
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      result.footPillHit = !!at && (at === askFoot || askFoot.contains(at))
    }

    // 选「最小化到托盘」（默认勾着"记住我的选择"）
    dlg?.querySelector<HTMLElement>('[data-choice="tray"]')?.click()
    result.dialogClosed = await waitFor(() => !askOpen(), 4000)
    await sleep(600)
    result.prefAfterTray = await prefValue()
    result.shellHiddenAfterTray = shellHidden()

    // 复位到可见，再点一次 ✕：应当**不再询问**，直接按记住的选择隐藏
    setShellHidden(false)
    await sleep(300)
    clickClose()
    await sleep(700)
    result.askedAgain = askOpen()
    result.shellHiddenSecond = shellHidden()
    result.prefAfterSecond = await prefValue()

    await setPref('ask')                       // 探针不留痕：恢复默认（每次询问）
    result.restored = await prefValue()

    const pre = document.createElement('pre')
    pre.id = 'ui-probe'
    pre.textContent = JSON.stringify({ mode: 'close-ask', views: [], degraded,
                                       closeAsk: result })
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
        // 顶部渐隐（R39-D）的**正向**分支：滚下去之后必须挂上 mask。
        // 不滚就永远只测到 `data-scrolled=0` 那一半 —— 那是"看着有、其实没接上"的温床。
        // ⚠️ R40 起**不能再拿数据视图测**：它已改成一次一张卡的牌堆，页面根本不滚动。
        const sc = document.querySelector<HTMLElement>('.list-scroll .os-scroll')
        if (sc) {
          sc.scrollTop = 220
          await sleep(400)
          out.push(measure('list-scrolled'))
          sc.scrollTop = 0
          await sleep(300)
        } else {
          degraded.push('list-scroll')
        }
      }
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
  // 壳层底（R33 补，devlog/135）：UI 就位后 `.app-shell` 必须是**透明**的 ——
  // 它有底色时，子层被圆角裁切的那 1~2px 会混出"白边"（顶栏粉 / rail 灰的角上最明显）。
  // 这条量的是计算样式（不依赖截图），探针跑三档宽度 ⇒ 三档都钉住。
  const shellEl = document.querySelector('.app-shell')
  const shell = {
    settled: document.documentElement.classList.contains('shell-settled'),
    bg: shellEl ? getComputedStyle(shellEl).backgroundColor : null,
    // 圆角归谁画（R34，devlog/136）：探针跑在浏览器里（无 Tauri）⇒ 走 CSS 兜底那条路，
    // 半径应当是 8px 而不是 0；再用 dev 钩子模拟"壳说 DWM 可用"，核对是否真的归零。
    radius: shellEl ? getComputedStyle(shellEl).borderTopLeftRadius : null,
    radiusWhenDwm: (() => {
      const hook = (window as unknown as { __ddtoolkitCorners?: (v: boolean) => void })
        .__ddtoolkitCorners
      if (typeof hook !== 'function' || !shellEl) return null
      hook(true)
      const r = getComputedStyle(shellEl).borderTopLeftRadius
      hook(false)                        // 还原，别影响后面的测量
      return r
    })(),
  }
  pre.textContent = JSON.stringify({ mode: 'main', views: out, topbar, shell, degraded })
  document.body.appendChild(pre)
  document.title = 'UI_PROBE_DONE'
}
