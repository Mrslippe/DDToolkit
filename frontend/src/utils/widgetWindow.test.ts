/**
 * 桌面控件位置持久化的用例（`utils/widgetWindow.ts`，R38 批 5b）。
 *
 * 重点在**夹取**：控件是置顶 + 无边框 + 不进任务栏的，整个跑出屏幕就再也点不到它。
 */
import { describe, expect, it } from 'vitest'

import {
  WIDGET_CAP_H,
  WIDGET_CAP_MAX_W,
  WIDGET_CAP_MIN_W,
  WIDGET_COLLAPSED,
  WIDGET_EDGE,
  WIDGET_MIN_VISIBLE,
  WIDGET_PANEL_GAP,
  WIDGET_PANEL_W,
  WIDGET_RADIUS,
  WIDGET_SHADOW_LAYERS,
  WIDGET_SHADOW_OPEN_LAYERS,
  WIDGET_SHADOW_PAD,
  WIDGET_SIZE,
  applyWidgetCssVars,
  clampCapsuleW,
  clampWidgetPos,
  defaultWidgetPos,
  parseWidgetPos,
  shadowCss,
  shadowReachBottom,
  widgetCapsuleGeom,
  widgetCollapseGeom,
  widgetExpandGeom,
  widgetPanelMaxHeight,
} from './widgetWindow'

const SCREEN = { width: 1920, height: 1080 }

describe('parseWidgetPos：坏数据一律当"没存过"', () => {
  it('正常值原样读回（并取整）', () => {
    expect(parseWidgetPos('{"x":100,"y":200}')).toEqual({ x: 100, y: 200 })
    expect(parseWidgetPos('{"x":100.6,"y":200.2}')).toEqual({ x: 101, y: 200 })
  })

  it.each([
    ['null', null],
    ['空串', ''],
    ['非 JSON', 'not json'],
    ['JSON 但不是对象', '123'],
    ['字面 null', 'null'],
    ['缺字段', '{"x":1}'],
    ['非数字', '{"x":"a","y":2}'],
    ['NaN 进了 JSON 也不认', '{"x":null,"y":2}'],
  ])('%s ⇒ null', (_name, raw) => {
    expect(parseWidgetPos(raw as string | null)).toBeNull()
  })
})

describe('clampWidgetPos：四个方向都留得住', () => {
  it('屏幕内的坐标不动', () => {
    expect(clampWidgetPos({ x: 500, y: 300 }, SCREEN)).toEqual({ x: 500, y: 300 })
  })

  it('右/下越界 ⇒ 拉回"整个窗口都在屏幕内"', () => {
    expect(clampWidgetPos({ x: 5000, y: 5000 }, SCREEN)).toEqual({
      x: SCREEN.width - WIDGET_SIZE.w - WIDGET_MIN_VISIBLE,
      y: SCREEN.height - WIDGET_SIZE.h - WIDGET_MIN_VISIBLE,
    })
  })

  it('左/上可以贴出去，但**至少留 24px 可见**', () => {
    expect(clampWidgetPos({ x: -5000, y: -5000 }, SCREEN)).toEqual({
      x: WIDGET_MIN_VISIBLE - WIDGET_SIZE.w,
      y: 0,
    })
  })

  it('**换到更小的显示器** ⇒ 原来的坐标被夹回来（这条是它存在的理由）', () => {
    // 在 1920 上存在 (1700, 1000)，插到 1366×768 的笔记本屏上
    const small = { width: 1366, height: 768 }
    const r = clampWidgetPos({ x: 1700, y: 1000 }, small)
    expect(r.x).toBe(small.width - WIDGET_SIZE.w - WIDGET_MIN_VISIBLE)
    expect(r.y).toBe(small.height - WIDGET_SIZE.h - WIDGET_MIN_VISIBLE)
    expect(r.x + WIDGET_SIZE.w).toBeLessThanOrEqual(small.width)
  })

  it('屏幕比窗口还小时两个约束打架 ⇒ 取"右边距优先"', () => {
    // 屏 100 < 窗 200：`maxX = 100 − 200 − 24 = −124`（不是 `m − size.w = −176`）。
    // 于是窗口右缘落在 76，屏右侧仍留 24px —— 比"只保证左缘 24px 可见"更好用。
    const tiny = { width: 100, height: 20 }
    const r = clampWidgetPos({ x: 0, y: 0 }, tiny)
    expect(r.x).toBe(-124)
    expect(r.x + WIDGET_SIZE.w).toBe(tiny.width - WIDGET_MIN_VISIBLE)
    expect(r.y).toBe(0)
  })
})

describe('defaultWidgetPos：首次开启**顶部居中**、留 80px', () => {
  it('顶部居中（用户 2026-09-27：约两个小窗高 = 2 × 40）', () => {
    const r = defaultWidgetPos(SCREEN)
    // ⚠️ 返回值是**窗口**坐标（= 卡片 + 两侧留白）；"居中 / 留 80px"讲的是**卡片**。
    expect(r.x + WIDGET_SHADOW_PAD + WIDGET_SIZE.w / 2).toBe(SCREEN.width / 2)
    expect(r.y + WIDGET_SHADOW_PAD).toBe(80)
  })

  it('小屏上也仍然合法（夹取过的）', () => {
    const r = defaultWidgetPos({ width: 800, height: 600 })
    expect(r.x).toBeGreaterThanOrEqual(WIDGET_MIN_VISIBLE - WIDGET_SIZE.w - WIDGET_SHADOW_PAD)
    expect(r.x + WIDGET_SIZE.w + WIDGET_SHADOW_PAD * 2).toBeLessThanOrEqual(800)
  })

  /**
   * ⚠️ **这条是"落点为什么必须改"的判据**（D1 之前落右下角）。
   *
   * 右下角那个位置向下展开**永远放不下**（1080p 上 `y=968`，需要 968+40+6+面板高），
   * 于是小窗一起手就只能向上翻 —— 一个"默认就在角落"的落点会让四方向逻辑的
   * 第一印象永远是特例。顶部居中则默认向下。
   */
  it('默认落点下**向下展开装得下**（旧落点做不到，所以落点改了）', () => {
    const r = defaultWidgetPos(SCREEN)
    const cur = { ...r, w: WIDGET_SIZE.w, h: WIDGET_SIZE.h }
    const g = widgetExpandGeom(cur, 300, SCREEN)
    expect(g.dir).toBe('down')
    expect(g.y).toBe(cur.y)                       // 顶边不动 = 真的向下长
    expect(g.y + 40 + WIDGET_PANEL_GAP + 300).toBeLessThanOrEqual(SCREEN.height)
  })
})

describe('clampCapsuleW：宽度夹在 200–400', () => {
  it.each([
    [150, 200],     // 比下限还窄 ⇒ 抬到 200
    [200, 200],
    [247.6, 248],   // 量出来的小数 ⇒ 取整
    [400, 400],
    [401, 400],     // 越过上限 ⇒ 夹回来（超过才省略号）
  ])('%i → %i', (raw, want) => {
    expect(clampCapsuleW(raw as number)).toBe(want)
  })

  it.each([['量不到（0）', 0], ['负数', -5], ['NaN', Number.NaN]])(
    '%s ⇒ 退回下限（不能把窗口算成 0 宽，那会让它不可点）', (_n, raw) => {
      expect(clampCapsuleW(raw as number)).toBe(WIDGET_SIZE.w)
    })
})

/**
 * 形态梯度（R38 批 5d；**D1 四方向**，2026-09-27）。
 *
 * 这组用例守的是**一个真 bug**：面板 `top = 胶囊底 + 6`，而窗口写死 200×40
 * ⇒ 面板整个落在窗口外，用户从来没看见过它。所以这里最要紧的两条是
 * ① 展开后窗口**真的够装下面板**；② 展开时**胶囊不动**（否则用户摆的位置会被改）。
 */
/**
 * 形态梯度（R38 批 5d → D1 四方向 → **F1 卡片模型**，2026-09-30）。
 *
 * 这组用例守的是**一个真 bug**：面板 `top = 胶囊底 + 6`，而窗口写死 200×40
 * ⇒ 面板整个落在窗口外，用户从来没看见过它。所以最要紧的两条是
 * ① 展开后**卡片真的装得下面板**；② 卡片贴住胶囊的那条边**不动**（否则用户摆的位置会被改）。
 *
 * ⚠️ **坐标系**：下面三个函数的入参与返回值都是**窗口**矩形，而窗口 = 卡片 + 两侧留白
 * （`WIDGET_SHADOW_PAD` —— "卡片"才是用户看得见的那块，那圈留白是给**外阴影**的）。
 * 用例一律用两个小助手换算，这样断言读起来是"卡片在哪"，而不是一堆 ±32。
 */
const PAD = WIDGET_SHADOW_PAD
/** 折叠态的**窗口**矩形：胶囊（= 卡片）在屏幕 `(x, y)`、宽 `capW` */
const win = (x: number, y: number, capW: number = WIDGET_SIZE.w) =>
  ({ x: x - PAD, y: y - PAD, w: capW + PAD * 2, h: WIDGET_CAP_H + PAD * 2 })
/** 窗口矩形 → **卡片**矩形（断言时用） */
const card = (g: { x: number; y: number; w: number; h: number }) =>
  ({ x: g.x + PAD, y: g.y + PAD, w: g.w - PAD * 2, h: g.h - PAD * 2 })

describe('widgetExpandGeom：卡片朝屏幕里侧长（四方向）', () => {
  it('**卡片 = 面板本身**（F1）：高就是面板高，不再 `胶囊 + 间隙 + 面板`', () => {
    const g = widgetExpandGeom(win(1000, 300), 300, SCREEN)
    expect(card(g)).toEqual({ x: 900, y: 300, w: WIDGET_PANEL_W, h: 300 })
    // 窗口比卡片大一圈 —— 那圈是给外阴影的（用户报的"阴影被截断"就是它）
    expect(g.w).toBe(WIDGET_PANEL_W + PAD * 2)
    expect(g.h).toBe(300 + PAD * 2)
  })

  it('展开后的**卡片**必然比折叠态高（回归：曾只有 40 ⇒ 面板仍在窗外）', () => {
    const g = widgetExpandGeom(win(1000, 300), 200, SCREEN)
    expect(card(g).h).toBeGreaterThan(WIDGET_SIZE.h)
  })

  it('面板高为 0 时不会把卡片缩没', () => {
    const g = widgetExpandGeom(win(1000, 300), 0, SCREEN)
    expect(card(g).h).toBeGreaterThanOrEqual(1)
  })

  it('下面装得下 ⇒ **向下**长，卡片**顶边**不动，横向居中', () => {
    const g = widgetExpandGeom(win(1000, 300), 300, SCREEN)
    expect(g.dir).toBe('down')
    expect(card(g).y).toBe(300)          // 顶边不动：真的向下长
    expect(g.align).toBe('center')
    expect(card(g).x).toBe(1100 - WIDGET_PANEL_W / 2)   // 卡片以胶囊中心为中心
  })

  /**
   * ⚠️ **贴屏幕下沿**：向下根本没有位置 ⇒ 必须**向上**，
   * 而且"贴着胶囊的那条边"（底边）**恒等** —— 否则卡片会整体离开屏边一个胶囊高
   * （09-27 样例页 CDP 实测 `jumpY = +46`，用户报的"和边缘拉开"就是它）。
   */
  it('贴屏幕下沿 ⇒ 向上展开，且**底边恒等**', () => {
    const capY = SCREEN.height - 8 - WIDGET_CAP_H
    const g = widgetExpandGeom(win(1000, capY), 300, SCREEN)
    expect(g.dir).toBe('up')
    expect(card(g).y + card(g).h).toBe(capY + WIDGET_CAP_H)   // 底边 = 胶囊底边
    expect(card(g).y).toBeGreaterThanOrEqual(8)
  })

  it('**近边恒等**：向下 ⟺ 顶边不动，向上 ⟺ 底边不动（四组位置都成立）', () => {
    for (const [x, y] of [
      [400, 100],                                   // 上沿附近
      [400, 500],                                   // 中部
      [400, SCREEN.height - 8 - WIDGET_CAP_H],      // 贴下沿
      [1500, SCREEN.height - 8 - WIDGET_CAP_H],     // 右下角
    ] as const) {
      const g = widgetExpandGeom(win(x, y), 300, SCREEN)
      if (g.dir === 'down') expect(card(g).y).toBe(y)
      else expect(card(g).y + card(g).h).toBe(y + WIDGET_CAP_H)
    }
  })

  /**
   * ⚠️ **F1 修掉的那块空白**：旧模型"窗口 = 胶囊 + 间隙 + 面板"把胶囊那一格留成了
   * 窗口内的透明空白（用户在样例页报的「展开后最顶上空出一大块」），
   * 而且卡片在胶囊**外侧** ⇒ 点开的一瞬间整体离开屏边 46px。
   * 现在卡片顶边 == 胶囊顶边、卡片高 == 面板高 ⇒ 两件事都不存在。
   */
  it('**没有那 46px 空白**（F1）：卡片顶 == 胶囊顶，卡片高 == 面板高', () => {
    const capY = 300
    const panelH = 240
    const g = widgetExpandGeom(win(1000, capY), panelH, SCREEN)
    expect(card(g).y).toBe(capY)
    expect(card(g).h).toBe(panelH)
    expect(card(g).y + card(g).h).toBe(capY + panelH)   // 不是 capY + 46 + panelH
  })

  describe('横向：默认居中，居中出屏才贴边（"只在边缘才反向"）', () => {
    it('屏幕中部 ⇒ 居中', () => {
      const g = widgetExpandGeom(win(860, 300), 300, SCREEN)
      expect(g.align).toBe('center')
      expect(card(g).x).toBe(860 + 100 - WIDGET_PANEL_W / 2)
    })

    it('贴右缘 ⇒ 卡片**向左**长（右缘仍在屏内）', () => {
      const capX = SCREEN.width - 220
      const g = widgetExpandGeom(win(capX, 300), 300, SCREEN)
      expect(g.align).toBe('left')
      expect(card(g).x + card(g).w).toBeLessThanOrEqual(SCREEN.width)
      expect(card(g).x + card(g).w).toBe(capX + WIDGET_SIZE.w)   // 右缘 = 胶囊右缘
    })

    it('贴左缘 ⇒ 卡片**向右**长（左缘 = 胶囊左缘）', () => {
      const g = widgetExpandGeom(win(8, 300), 300, SCREEN)
      expect(g.align).toBe('right')
      expect(card(g).x).toBe(8)
    })

    it('**正中央不会被判成"向上 + 向左"**（按中线劈半的老错法）', () => {
      // 用户 2026-09-27 截图：胶囊在屏幕正中，面板却往左上长。
      // 根因：`down: cy < 0.5`、`right: cx < 0.5` ⇒ 正中 `0.5 < 0.5` 为 false。
      const g = widgetExpandGeom(
        win(SCREEN.width / 2 - 100, SCREEN.height / 2 - 20), 300, SCREEN)
      expect(g.dir).toBe('down')
      expect(g.align).toBe('center')
    })

    it('窄屏（500）：卡片夹回屏内，不越出左右缘', () => {
      const tiny = { width: 500, height: 600 }
      const g = widgetExpandGeom(win(100, 100), 200, tiny)
      expect(card(g).x).toBeGreaterThanOrEqual(8)
      expect(card(g).x + card(g).w).toBeLessThanOrEqual(tiny.width)
    })
  })

  it('**两边都装不下时挑余量大的那边**（不是无脑向上翻）', () => {
    // 胶囊贴着**上沿**(y=10)、面板高过屏幕：下方 1062px、上方 42px ⇒ 向下（下面更多）。
    // 旧规则是"向下装不下就向上"，那会把面板甩到只有 42px 的上方去。
    const g = widgetExpandGeom(win(800, 10), 1200, SCREEN)
    expect(g.dir).toBe('down')
  })

  it('面板高过屏幕（谁都装不下）时卡片夹回屏内，不出现负坐标', () => {
    const g = widgetExpandGeom(win(860, 80), 5000, SCREEN)
    // ⚠️ 判**卡片**：窗口（卡片 + 留白）可以探到屏幕外 —— 那圈留白本来就是给阴影的，
    //    它出屏只意味着那一侧阴影被桌面的边缘裁掉，与"卡片看不见"是两回事。
    expect(card(g).x).toBeGreaterThanOrEqual(WIDGET_EDGE)
    expect(card(g).y).toBeGreaterThanOrEqual(WIDGET_EDGE)
  })

  it('胶囊顶到宽度上限（400）时卡片仍然装得下它', () => {
    const capX = 800
    const g = widgetExpandGeom(win(capX, 300, WIDGET_CAP_MAX_W), 300, SCREEN)
    expect(card(g).w).toBe(WIDGET_PANEL_W)
    expect(card(g).x).toBeLessThanOrEqual(capX)
    expect(card(g).x + card(g).w).toBeGreaterThanOrEqual(capX + WIDGET_CAP_MAX_W)
  })
})

describe('widgetCollapseGeom：展开→收起是闭环', () => {
  it('回到**卡片 = 胶囊**的尺寸（宽 = 量出来的胶囊宽，不再是写死的 200）', () => {
    const ex = widgetExpandGeom(win(1000, 300), 300, SCREEN)
    const g = widgetCollapseGeom(ex, SCREEN, 260)
    expect(card(g)).toEqual({ x: 1000 + 100 - 130, y: 300, w: 260, h: WIDGET_CAP_H })
    expect(g.w).toBe(260 + PAD * 2)     // 窗口比卡片大一圈
  })

  it('**向下展开再收起** ⇒ 回到用户原来摆的位置（闭环）', () => {
    const before = win(1000, 300)
    const ex = widgetExpandGeom(before, 300, SCREEN)
    const back = widgetCollapseGeom(ex, SCREEN, WIDGET_SIZE.w, { x: 1000, y: 300, w: WIDGET_SIZE.w })
    expect(card(back)).toEqual({ x: 1000, y: 300, w: WIDGET_SIZE.w, h: WIDGET_CAP_H })
  })

  /**
   * ⚠️ 翻转分支的闭环**靠 `restore`**：贴边展开时卡片必须被夹（否则面板出屏），
   * 于是"从展开矩形反推"会少掉那几十像素 —— 每悬停一次漂一点，久了小窗就爬走了。
   * 所以收起要**直接回到展开前记下的卡片矩形**。
   */
  it('**向上展开再收起** ⇒ 精确回到展开前的位置（靠 restore，不靠反推）', () => {
    const capY = SCREEN.height - 8 - WIDGET_CAP_H
    const before = win(1000, capY)
    const ex = widgetExpandGeom(before, 300, SCREEN)
    expect(ex.dir).toBe('up')
    const back = widgetCollapseGeom(
      ex, SCREEN, WIDGET_SIZE.w, { x: 1000, y: capY, w: WIDGET_SIZE.w })
    expect(card(back).x).toBe(1000)
    expect(card(back).y).toBe(capY)     // 贴着屏幕下沿**不被推上去**（两条路径夹取口径一致）
  })

  /**
   * ⚠️ **内容在展开期间变了**（方案 A：宽度跟内容走）—— 收起时回到的是
   * 胶囊的**中心**，不是左上角。按左上角回位会让胶囊中心漂掉半个宽度差，
   * 而用户看到的是"我没动它，它自己偏了"。
   */
  it('展开期间内容变宽 ⇒ 收起时**中心**不变、宽度跟上', () => {
    const ex = widgetExpandGeom(win(1000, 300), 300, SCREEN)
    const back = widgetCollapseGeom(ex, SCREEN, 320, { x: 1000, y: 300, w: WIDGET_SIZE.w })
    expect(card(back).w).toBe(320)
    expect(card(back).x + card(back).w / 2).toBe(1000 + WIDGET_SIZE.w / 2)
    expect(card(back).y).toBe(300)
  })

  it('**反复展开/收起不漂移**（10 轮之后仍在原处）—— 反推法会在这里累积误差', () => {
    const p0 = defaultWidgetPos(SCREEN)
    const capX0 = p0.x + PAD
    const capY0 = p0.y + PAD
    let cur = win(capX0, capY0)
    for (let i = 0; i < 10; i++) {
      const ex = widgetExpandGeom(cur, 300, SCREEN)
      const back = widgetCollapseGeom(ex, SCREEN, WIDGET_SIZE.w,
        { x: capX0, y: capY0, w: WIDGET_SIZE.w })
      cur = { ...back }
    }
    // 只比四个矩形字段（几何对象现在还有 `dir`/`align`，那是给动画与探针看的）
    expect({ x: cur.x, y: cur.y, w: cur.w, h: cur.h }).toEqual(win(capX0, capY0))
  })

  it('没有 restore 时退回反推（退化路径仍要能用）', () => {
    const ex = widgetExpandGeom(win(1000, 300), 300, SCREEN)
    const back = widgetCollapseGeom(ex, SCREEN, WIDGET_SIZE.w)
    expect(card(back).w).toBe(WIDGET_SIZE.w)
    expect(card(back).h).toBe(WIDGET_CAP_H)
    expect(card(back).y).toBe(300)
  })
})

/**
 * 折叠态**只改宽**（D1：内容变长 ⇒ 窗口要跟上去，否则胶囊右半边被窗口裁掉）。
 */
describe('widgetCapsuleGeom：跟随内容宽，且保持胶囊中心', () => {
  it('变宽 ⇒ 往两边长（中心不动），高度恒定', () => {
    const g = widgetCapsuleGeom(win(1000, 300), SCREEN, 300)
    expect(card(g)).toEqual({ x: 1000 + 100 - 150, y: 300, w: 300, h: WIDGET_CAP_H })
  })

  it('变窄 ⇒ 同样保持中心', () => {
    const g = widgetCapsuleGeom(win(1000, 300, 400), SCREEN, 200)
    expect(card(g).x + card(g).w / 2).toBe(1000 + 200)
  })

  it('贴右缘时长到 400 ⇒ 夹回屏内（整卡可见），不会把胶囊推出去', () => {
    const capX = SCREEN.width - 220
    const g = widgetCapsuleGeom(win(capX, 300), SCREEN, WIDGET_CAP_MAX_W)
    expect(card(g).x + card(g).w).toBeLessThanOrEqual(SCREEN.width - WIDGET_MIN_VISIBLE)
    expect(card(g).x).toBeGreaterThanOrEqual(WIDGET_MIN_VISIBLE - card(g).w)
  })

  it('量不到宽（0）⇒ 退回下限，不会算出 0 宽窗口', () => {
    const g = widgetCapsuleGeom(win(1000, 300), SCREEN, 0)
    expect(card(g).w).toBe(WIDGET_SIZE.w)
  })
})

/**
 * **外阴影的留白是算出来的**（F1 批）：用户报的"小窗阴影被截断了"，
 * 根因就是"阴影"与"留白"这两个数各写一遍（当时留白是 0）。
 */
describe('阴影留白：窗口必须比卡片大出"阴影伸出去的那一段"', () => {
  it('留白 = 所有层里最大的 `dy + blur/2`（向上取整）', () => {
    const all = [...WIDGET_SHADOW_LAYERS, ...WIDGET_SHADOW_OPEN_LAYERS]
    const need = Math.max(...all.map(shadowReachBottom))
    expect(WIDGET_SHADOW_PAD).toBe(Math.ceil(need))
  })

  it('**每一层都装得下**（留白 ≥ 它的伸出量）—— 破了就是"阴影被截断"', () => {
    for (const l of [...WIDGET_SHADOW_LAYERS, ...WIDGET_SHADOW_OPEN_LAYERS]) {
      expect(shadowReachBottom(l)).toBeLessThanOrEqual(WIDGET_SHADOW_PAD)
    }
  })

  it('留白不许是 0（没有留白 = 阴影一定被裁）', () => {
    expect(WIDGET_SHADOW_PAD).toBeGreaterThan(0)
  })

  it('`shadowCss` 生成的是合法层（每层 `0 dy blur rgba(…)`）', () => {
    const css = shadowCss(WIDGET_SHADOW_LAYERS)
    // ⚠️ 按**括号深度**切逗号：`rgba(0, 0, 0, .38)` 里的逗号不是层分隔符
    //    （探针侧数阴影层数时踩过同一个坑：`split('),')` 恒为 1 层）。
    const layers = css.split(/,(?![^(]*\))/)
    expect(layers).toHaveLength(WIDGET_SHADOW_LAYERS.length)
    expect(css).toContain('rgba(0, 0, 0, 0.38)')
  })
})

/**
 * ⚠️ 这组用例守的是**自指循环**（2026-09-25 批 5f 实测）：
 * 面板高 → 决定窗口高（窗口 = 40 + 6 + 面板高）→ 若上限又按**窗口**高算，循环闭合，
 * 面板被永久压在某个值上（实测卡在 120 的下限，用户看到的就是"被挤压"）。
 *
 * ⚠️ F1 之后"窗口 = 卡片 = 面板"，这条循环**少了一环**，但判据照旧有用：
 * 上限仍然必须只与**屏幕**有关（`screen.availHeight`）——
 * 换成 `window.innerHeight` 一样会闭合。
 */
describe('widgetPanelMaxHeight：面板上限必须按**屏幕**算', () => {
  it('1080p（可用 1040）⇒ 920，远大于内容高（不会压住面板）', () => {
    expect(widgetPanelMaxHeight(1040)).toBe(920)
  })

  it('结果**只与屏幕有关** —— 同一输入反复调用恒定（不随窗口/面板变化）', () => {
    expect([widgetPanelMaxHeight(1040), widgetPanelMaxHeight(1040),
            widgetPanelMaxHeight(1040)]).toEqual([920, 920, 920])
  })

  it('**关键回归**：上限必须 >120 那个曾把面板压住的下限', () => {
    // 旧写法（按窗口高算）收敛在 120 ⇒ 这里必须明显更大，否则面板还是长不开
    expect(widgetPanelMaxHeight(1040)).toBeGreaterThan(300)
  })

  it('小屏（可用 600）⇒ 480，仍然装得下', () => {
    expect(widgetPanelMaxHeight(600)).toBe(480)
  })

  it('极小的屏幕也不会算出 0/负数（那会让面板整块消失）', () => {
    expect(widgetPanelMaxHeight(100)).toBe(160)
    expect(widgetPanelMaxHeight(0)).toBe(160)
  })

  it.each([
    ['NaN（量不到屏幕）', Number.NaN],
    ['负数', -500],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('%s ⇒ 退回下限而不是荒谬值', (_name, avail) => {
    const v = widgetPanelMaxHeight(avail as number)
    expect(Number.isFinite(v)).toBe(true)
    expect(v).toBeGreaterThan(0)
  })
})

describe('形态常量之间的关系（单一真源：只在 widgetWindow.ts 写一遍）', () => {
  it('面板宽 ≥ 胶囊上限 —— 展开后胶囊必然装得进窗口', () => {
    expect(WIDGET_PANEL_W).toBeGreaterThanOrEqual(WIDGET_CAP_MAX_W)
  })

  it('折叠态的宽高与下限一致（`WIDGET_SIZE` 是下限，不是定值）', () => {
    expect(WIDGET_SIZE.w).toBe(WIDGET_CAP_MIN_W)
    expect(WIDGET_SIZE.h).toBe(WIDGET_CAP_H)
    expect(WIDGET_COLLAPSED).toBe(WIDGET_SIZE)
  })

  it('圆角 = 折叠高的一半（折叠态是**完美胶囊**，这是 09-27 那条"圆角恒定 20"的一半）', () => {
    expect(WIDGET_RADIUS * 2).toBe(WIDGET_CAP_H)
  })

  it('展开留白 < 折叠最小可见 —— 两者是两个口径，别混用', () => {
    expect(WIDGET_EDGE).toBeLessThan(WIDGET_MIN_VISIBLE)
  })
})

/**
 * `applyWidgetCssVars`：把常量写进 CSS 变量（**跨语言单一真源**的那一半）。
 *
 * ⚠️ 这条判据守的是**变量名**：CSS 里写的是 `var(--widget-cap-max-w, 400px)`，
 * 名字一旦对不上，CSS 就永远读兜底值 —— 而**两边都是 400 时看不出来**
 * （值相同、来源不同）。探针在小窗坐标系里量"解析值 == 变量值"，
 * 这里量"TS 到底写了哪几个变量、写了什么值"。
 */
describe('applyWidgetCssVars：常量 → CSS 变量（名字也是契约）', () => {
  /** node 环境里没有 `document`：临时挂一个假的，跑完**必须**还原（别污染后续用例） */
  const withFakeDoc = (doc: unknown, fn: () => void) => {
    const g = globalThis as { document?: unknown }
    const saved = g.document
    if (doc === undefined) delete g.document
    else g.document = doc
    try {
      fn()
    } finally {
      if (saved === undefined) delete g.document
      else g.document = saved
    }
  }

  it('写满 8 个变量、值带 px 单位（阴影两层与留白也在这里，F1 批加）', () => {
    const written: Record<string, string> = {}
    const fakeDoc = {
      documentElement: {
        style: { setProperty: (k: string, v: string) => { written[k] = v } },
      },
    }
    withFakeDoc(fakeDoc, () => applyWidgetCssVars())
    expect(written).toEqual({
      '--widget-cap-min-w': '200px',
      '--widget-cap-max-w': '400px',
      '--widget-radius': '20px',
      '--widget-panel-w': '400px',
      '--widget-cap-h': '40px',
      '--widget-shadow-pad': `${WIDGET_SHADOW_PAD}px`,
      '--wg-shadow-layers': shadowCss(WIDGET_SHADOW_LAYERS),
      '--wg-shadow-open-layers': shadowCss(WIDGET_SHADOW_OPEN_LAYERS),
    })
  })

  it('没有 document（node 环境）时不抛 —— 它不该依赖运行环境', () => {
    withFakeDoc(undefined, () => expect(() => applyWidgetCssVars()).not.toThrow())
  })
})
