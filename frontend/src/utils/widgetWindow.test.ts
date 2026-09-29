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
  WIDGET_SIZE,
  applyWidgetCssVars,
  clampCapsuleW,
  clampWidgetPos,
  defaultWidgetPos,
  parseWidgetPos,
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
    expect(r.x + WIDGET_SIZE.w / 2).toBe(SCREEN.width / 2)
    expect(r.y).toBe(80)
  })

  it('小屏上也仍然合法（夹取过的）', () => {
    const r = defaultWidgetPos({ width: 800, height: 600 })
    expect(r.x).toBeGreaterThanOrEqual(WIDGET_MIN_VISIBLE - WIDGET_SIZE.w)
    expect(r.x + WIDGET_SIZE.w).toBeLessThanOrEqual(800)
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
describe('widgetExpandGeom：展开要把窗口长够，四方向朝屏幕里侧长', () => {
  // 屏幕中部：下面装得下 ⇒ 应当向下展开（不是"在下半屏就翻上去"）
  const MID = { x: 1000, y: 300, w: 200, h: 40 }

  it('高度 = 胶囊高 + 间隙 + 面板高（这条就是那个 bug 的判据）', () => {
    const g = widgetExpandGeom(MID, 300, SCREEN)
    expect(g.h).toBe(40 + WIDGET_PANEL_GAP + 300)
    expect(g.w).toBe(WIDGET_PANEL_W)
  })

  it('下面装得下 ⇒ **向下**展开，顶边不动（胶囊不跳）', () => {
    const g = widgetExpandGeom(MID, 300, SCREEN)
    expect(g.dir).toBe('down')
    expect(g.y).toBe(MID.y)          // 顶边不动：向下长
    expect(g.capOffsetX).toBe(100)   // (400 − 200) / 2：胶囊在窗口里居中
    expect(g.align).toBe('center')
  })

  it('展开后的高度**必然大于折叠态**（回归：曾等于 40 ⇒ 面板仍在窗外）', () => {
    const g = widgetExpandGeom(MID, 200, SCREEN)
    expect(g.h).toBeGreaterThan(WIDGET_SIZE.h)
  })

  it('面板高为 0 时不会把窗口缩没', () => {
    const g = widgetExpandGeom(MID, 0, SCREEN)
    expect(g.h).toBeGreaterThanOrEqual(WIDGET_SIZE.h)
  })

  /**
   * ⚠️ **贴屏幕下沿**（旧默认落点就是那儿）：向下根本没有位置 ⇒ 必须**向上**，
   * 而且"贴着胶囊的那条边"（底边）**恒等** —— 否则卡片会整体离开屏边一个胶囊高
   * （09-27 样例页 CDP 实测 `jumpY = +46`，用户报的"和边缘拉开"就是它）。
   */
  it('贴屏幕下沿 ⇒ 向上展开，且**底边恒等**', () => {
    const cur = { x: 1000, y: SCREEN.height - 8 - 40, w: 200, h: 40 }
    const g = widgetExpandGeom(cur, 300, SCREEN)
    expect(g.dir).toBe('up')
    expect(g.y + g.h).toBe(cur.y + 40)              // 底边 = 胶囊底边（不变）
    expect(g.capOffsetY).toBe(g.h - 40)             // 胶囊贴窗口底边
    expect(g.y).toBeGreaterThanOrEqual(8)
  })

  it('**近边恒等**：向下 ⟺ 顶边不动，向上 ⟺ 底边不动（四组位置都成立）', () => {
    for (const cur of [
      { x: 400, y: 100, w: 200, h: 40 },                       // 上沿附近
      { x: 400, y: 500, w: 200, h: 40 },                       // 中部
      { x: 400, y: SCREEN.height - 48, w: 200, h: 40 },        // 贴下沿
      { x: 1500, y: SCREEN.height - 48, w: 200, h: 40 },       // 右下角
    ]) {
      const g = widgetExpandGeom(cur, 300, SCREEN)
      if (g.dir === 'down') expect(g.y + g.capOffsetY).toBe(cur.y)
      else expect(g.y + g.capOffsetY + 40).toBe(cur.y + 40)
    }
  })

  describe('横向：默认居中，居中出屏才贴边（"只在边缘才反向"）', () => {
    it('屏幕中部 ⇒ 居中，胶囊在窗口正中', () => {
      const g = widgetExpandGeom({ x: 860, y: 300, w: 200, h: 40 }, 300, SCREEN)
      expect(g.align).toBe('center')
      expect(g.capOffsetX).toBe((g.w - 200) / 2)
      expect(g.x).toBe(860 + 100 - g.w / 2)
    })

    it('贴右缘 ⇒ 面板**向左**长，胶囊贴窗口右缘、屏幕位置不变', () => {
      const cur = { x: SCREEN.width - 220, y: 300, w: 200, h: 40 }
      const g = widgetExpandGeom(cur, 300, SCREEN)
      expect(g.align).toBe('left')
      expect(g.capOffsetX).toBe(g.w - 200)
      expect(g.x + g.capOffsetX).toBe(cur.x)        // 胶囊**不动**
      expect(g.x + g.w).toBeLessThanOrEqual(SCREEN.width)
    })

    it('贴左缘 ⇒ 面板**向右**长，胶囊贴窗口左缘、屏幕位置不变', () => {
      const cur = { x: 8, y: 300, w: 200, h: 40 }
      const g = widgetExpandGeom(cur, 300, SCREEN)
      expect(g.align).toBe('right')
      expect(g.capOffsetX).toBe(0)
      expect(g.x).toBe(8)
      expect(g.x + g.capOffsetX).toBe(cur.x)
    })

    it('**正中央不会被判成"向上 + 向左"**（按中线劈半的老错法）', () => {
      // 用户 2026-09-27 截图：胶囊在屏幕正中，面板却往左上长。
      // 根因：`down: cy < 0.5`、`right: cx < 0.5` ⇒ 正中 `0.5 < 0.5` 为 false。
      const g = widgetExpandGeom(
        { x: SCREEN.width / 2 - 100, y: SCREEN.height / 2 - 20, w: 200, h: 40 }, 300, SCREEN)
      expect(g.dir).toBe('down')
      expect(g.align).toBe('center')
    })

    it('窄屏（500）：窗口夹回屏内，胶囊**仍然不动**', () => {
      const tiny = { width: 500, height: 600 }
      const cur = { x: 100, y: 100, w: 200, h: 40 }
      const g = widgetExpandGeom(cur, 200, tiny)
      expect(g.x).toBeGreaterThanOrEqual(8)
      expect(g.x + g.w).toBeLessThanOrEqual(tiny.width)
      expect(g.x + g.capOffsetX).toBe(cur.x)        // 靠偏移吸收夹取，胶囊不挪
    })
  })

  /**
   * ⚠️ `capOffsetY` 是 2026-09-25 批 5g 加的，守的是一个**真机截图里的错位**：
   * 原来 CSS 认定"翻上去 ⇒ 胶囊贴窗口**底**边"（`flex-end`），
   * 而贴屏幕上沿时窗口会被**夹**（顶边不能为负）⇒ 那个假设不成立 ⇒ 胶囊跳到窗口中间。
   */
  describe('capOffset：胶囊在窗口内的偏移（几何给，CSS 不许猜）', () => {
    it('向下展开且没被夹 ⇒ 纵向偏移 0（胶囊仍在窗口顶边）', () => {
      const g = widgetExpandGeom({ x: 1000, y: 300, w: 200, h: 40 }, 300, SCREEN)
      expect(g.dir).toBe('down')
      expect(g.capOffsetY).toBe(0)
    })

    it('**向上翻且装不下** ⇒ 窗口顶边被夹住、偏移**跟着变小**（不是窗口高 − 胶囊高）', () => {
      // 贴屏幕下沿（y=1000，底边 1040）+ 高过屏幕的面板（1146）：
      // 下方只剩 72px、上方有 1032px ⇒ 向上（两边都不够时挑余量大的那边）。
      const TOTAL_TALL = 1100
      const g = widgetExpandGeom({ x: 800, y: 1000, w: 200, h: 40 }, TOTAL_TALL, SCREEN)
      expect(g.dir).toBe('up')
      expect(g.y).toBe(8)                                 // 被夹到屏幕留白处
      // 真实偏移 = 胶囊原 y(1000) − 窗口 y(8)，**远小于** `窗口高 − 胶囊高`(1106)
      expect(g.capOffsetY).toBe(992)
      expect(g.capOffsetY).not.toBe(g.h - 40)
      expect(g.y + g.capOffsetY).toBe(1000)               // 即便装不下，胶囊也不许被挪
    })

    it('**两边都装不下时挑余量大的那边**（不是无脑向上翻）', () => {
      // 胶囊贴着**上沿**(y=10)、面板高过屏幕：下方 1062px、上方 42px ⇒ 向下（下面更多）。
      // 旧规则是"向下装不下就向上"，那会把面板甩到只有 42px 的上方去。
      const g = widgetExpandGeom({ x: 800, y: 10, w: 200, h: 40 }, 1200, SCREEN)
      expect(g.dir).toBe('down')
      expect(g.y).toBe(8)
      expect(g.y + g.capOffsetY).toBe(10)                 // 夹取被偏移吸收，胶囊不动
    })

    it('**胶囊的屏幕位置在展开前后不变**（两条轴都是"不动"的定义）', () => {
      const cases = [
        { x: 800, y: 10, w: 200, h: 40 },                      // 贴上沿（会被夹）
        { x: 860, y: 80, w: 200, h: 40 },                      // 默认落点
        { x: 1000, y: 300, w: 200, h: 40 },                    // 屏幕中部
        { x: SCREEN.width - 220, y: 300, w: 200, h: 40 },      // 贴右缘
        { x: 8, y: 300, w: 200, h: 40 },                        // 贴左缘
      ]
      for (const cur of cases) {
        const g = widgetExpandGeom(cur, 300, SCREEN)
        // 胶囊**在屏幕上的**矩形 = 窗口矩形 + 窗口内偏移
        expect(g.x + g.capOffsetX).toBe(cur.x)
        expect(g.y + g.capOffsetY).toBe(cur.y)
      }
    })

    it('胶囊比面板还宽时（内容 400）偏移只能是 0 —— 不会算出负数', () => {
      const g = widgetExpandGeom(
        { x: 800, y: 300, w: WIDGET_CAP_MAX_W, h: 40 }, 300, SCREEN)
      expect(g.w).toBe(WIDGET_PANEL_W)
      expect(g.capOffsetX).toBe(0)
    })

    it('折叠态两个偏移恒为 0', () => {
      const g = widgetCollapseGeom({ x: 900, y: 900, w: 400, h: 346 }, SCREEN, 200,
                                   { x: 900, y: 900, w: 200 })
      expect(g.capOffsetX).toBe(0)
      expect(g.capOffsetY).toBe(0)
      expect(g.dir).toBe('down')
    })
  })

  it('面板高过屏幕（谁都装不下）时被夹回屏幕内，不出现负坐标', () => {
    const g = widgetExpandGeom({ x: 860, y: 80, w: 200, h: 40 }, 5000, SCREEN)
    expect(g.y).toBeGreaterThanOrEqual(8)
    expect(g.x).toBeGreaterThanOrEqual(8)
    // 即便装不下，胶囊也**不许被挪**（偏移吸收夹取）—— 这是"用户摆哪就是哪"的底线
    expect(g.y + g.capOffsetY).toBe(80)
  })
})

/**
 * ⚠️ 这组用例守的是**自指循环**（2026-09-25 批 5f 实测）：
 * 面板高 → 决定窗口高（窗口 = 40 + 6 + 面板高）→ 若上限又按**窗口**高算，循环闭合，
 * 面板被永久压在某个值上（实测卡在 120 的下限，用户看到的就是"被挤压"）。
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

describe('widgetCollapseGeom：展开→收起是闭环', () => {
  it('回到折叠尺寸（宽 = **量出来的胶囊宽**，不再是写死的 200）', () => {
    const ex = widgetExpandGeom({ x: 1000, y: 300, w: 200, h: 40 }, 300, SCREEN)
    const g = widgetCollapseGeom({ ...ex }, SCREEN, 260)
    expect(g.w).toBe(260)
    expect(g.h).toBe(WIDGET_CAP_H)
  })

  it('**向下展开再收起** ⇒ 回到用户原来摆的位置（闭环）', () => {
    const before = { x: 1000, y: 300, w: WIDGET_SIZE.w, h: WIDGET_SIZE.h }
    const ex = widgetExpandGeom(before, 300, SCREEN)
    const back = widgetCollapseGeom({ ...ex }, SCREEN, before.w)
    expect(back.x).toBe(before.x)
    expect(back.y).toBe(before.y)
  })

  /**
   * ⚠️ 翻转分支的闭环**靠 `restore`**：贴边展开时窗口必须被夹（否则面板出屏），
   * 于是"从展开矩形反推"会少掉那几十像素 —— 每悬停一次漂一点，久了小窗就爬走了。
   * 所以收起要**直接回到展开前记录的矩形**。
   */
  it('**向上翻再收起** ⇒ 精确回到展开前的位置（靠 restore，不靠反推）', () => {
    const before = { x: 1000, y: SCREEN.height - 48, w: WIDGET_SIZE.w, h: WIDGET_CAP_H }
    const ex = widgetExpandGeom(before, 300, SCREEN)
    expect(ex.dir).toBe('up')
    const back = widgetCollapseGeom({ ...ex }, SCREEN, before.w, before)
    expect(back.x).toBe(before.x)
    expect(back.y).toBe(before.y)
  })

  /**
   * ⚠️ **内容在展开期间变了**（方案 A：宽度跟内容走）—— 收起时回到的是
   * 胶囊的**中心**，不是窗口左上角。按左上角回位会让胶囊中心漂掉半个宽度差，
   * 而用户看到的是"我没动它，它自己偏了"。
   */
  it('展开期间内容变宽 ⇒ 收起时**中心**不变、宽度跟上', () => {
    const before = { x: 1000, y: 300, w: 200, h: WIDGET_CAP_H }
    const ex = widgetExpandGeom(before, 300, SCREEN)
    const back = widgetCollapseGeom({ ...ex }, SCREEN, 320, before)
    expect(back.w).toBe(320)
    expect(back.x + back.w / 2).toBe(before.x + before.w / 2)
    expect(back.y).toBe(before.y)
  })

  it('**反复展开/收起不漂移**（10 轮之后仍在原处）—— 反推法会在这里累积误差', () => {
    const before = { ...defaultWidgetPos(SCREEN), w: WIDGET_SIZE.w, h: WIDGET_CAP_H }
    let cur: { x: number; y: number; w: number; h: number } = { ...before }
    for (let i = 0; i < 10; i++) {
      const ex = widgetExpandGeom(cur, 300, SCREEN)
      const back = widgetCollapseGeom({ ...ex }, SCREEN, cur.w, { ...cur })
      cur = { ...back }
    }
    expect(cur.x).toBe(before.x)
    expect(cur.y).toBe(before.y)
    expect(cur.w).toBe(before.w)
  })

  it('没有 restore 时退回反推（退化路径仍要能用）', () => {
    const before = { x: 1000, y: 300, w: WIDGET_SIZE.w, h: WIDGET_CAP_H }
    const ex = widgetExpandGeom(before, 300, SCREEN)
    const back = widgetCollapseGeom({ ...ex }, SCREEN, before.w)
    expect(back.w).toBe(before.w)
    expect(back.h).toBe(WIDGET_CAP_H)
    expect(back.y).toBe(before.y)
  })
})

/**
 * 折叠态**只改宽**（D1：内容变长 ⇒ 窗口要跟上去，否则胶囊右半边被窗口裁掉）。
 */
describe('widgetCapsuleGeom：跟随内容宽，且保持胶囊中心', () => {
  it('变宽 ⇒ 往两边长（中心不动），高度恒定', () => {
    const cur = { x: 1000, y: 300, w: 200 }
    const g = widgetCapsuleGeom(cur, SCREEN, 300)
    expect(g.w).toBe(300)
    expect(g.h).toBe(WIDGET_CAP_H)
    expect(g.x + g.w / 2).toBe(cur.x + cur.w / 2)
    expect(g.y).toBe(cur.y)
  })

  it('变窄 ⇒ 同样保持中心', () => {
    const cur = { x: 1000, y: 300, w: 400 }
    const g = widgetCapsuleGeom(cur, SCREEN, 200)
    expect(g.x + g.w / 2).toBe(cur.x + cur.w / 2)
  })

  it('贴右缘时长到 400 ⇒ 夹回屏内（整窗可见），不会把胶囊推出去', () => {
    const cur = { x: SCREEN.width - 220, y: 300, w: 200 }
    const g = widgetCapsuleGeom(cur, SCREEN, WIDGET_CAP_MAX_W)
    expect(g.x + g.w).toBeLessThanOrEqual(SCREEN.width - WIDGET_MIN_VISIBLE)
    expect(g.x).toBeGreaterThanOrEqual(WIDGET_MIN_VISIBLE - g.w)
  })

  it('量不到宽（0）⇒ 退回下限，不会算出 0 宽窗口', () => {
    const g = widgetCapsuleGeom({ x: 1000, y: 300, w: 200 }, SCREEN, 0)
    expect(g.w).toBe(WIDGET_SIZE.w)
  })
})

/**
 * 形态常量的**关系**（不是值本身）—— 它们之间有几条不变量，
 * 破了就会出现"胶囊被窗口裁掉"这类只有真机上看得见的问题。
 */
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

  it('写满 5 个变量、值带 px 单位', () => {
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
    })
  })

  it('没有 document（node 环境）时不抛 —— 它不该依赖运行环境', () => {
    withFakeDoc(undefined, () => expect(() => applyWidgetCssVars()).not.toThrow())
  })
})
