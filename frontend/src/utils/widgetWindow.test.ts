/**
 * 桌面控件位置持久化的用例（`utils/widgetWindow.ts`，R38 批 5b）。
 *
 * 重点在**夹取**：控件是置顶 + 无边框 + 不进任务栏的，整个跑出屏幕就再也点不到它。
 */
import { describe, expect, it } from 'vitest'

import {
  WIDGET_MIN_VISIBLE,
  WIDGET_PANEL_GAP,
  WIDGET_PANEL_W,
  WIDGET_SIZE,
  clampWidgetPos,
  defaultWidgetPos,
  parseWidgetPos,
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

describe('defaultWidgetPos：首次开启落右下角且不贴边', () => {
  it('右下角，留 24px 边、避开任务栏', () => {
    const r = defaultWidgetPos(SCREEN)
    expect(r.x + WIDGET_SIZE.w).toBe(SCREEN.width - WIDGET_MIN_VISIBLE)
    expect(r.y + WIDGET_SIZE.h).toBe(SCREEN.height - 72)
  })

  it('小屏上也仍然合法（夹取过的）', () => {
    const r = defaultWidgetPos({ width: 800, height: 600 })
    expect(r.x).toBeGreaterThanOrEqual(WIDGET_MIN_VISIBLE - WIDGET_SIZE.w)
    expect(r.x + WIDGET_SIZE.w).toBeLessThanOrEqual(800)
  })
})

/**
 * 形态梯度（R38 批 5d）。
 *
 * 这组用例守的是**一个真 bug**：面板 `top = 胶囊底 + 6`，而窗口写死 200×40
 * ⇒ 面板整个落在窗口外，用户从来没看见过它。所以这里最要紧的两条是
 * ① 展开后窗口**真的够装下面板**；② 展开时**顶边中心不动**（否则胶囊会横向跳）。
 */
describe('widgetExpandGeom：展开要把窗口长够，且放不下时向上翻', () => {
  // 屏幕中部：下面装得下 ⇒ 应当向下展开（不是"在下半屏就翻上去"）
  const MID = { x: 1000, y: 300, w: 200, h: 40 }

  it('高度 = 胶囊高 + 间隙 + 面板高（这条就是那个 bug 的判据）', () => {
    const g = widgetExpandGeom(MID, 300, SCREEN)
    expect(g.h).toBe(40 + WIDGET_PANEL_GAP + 300)
    expect(g.w).toBe(WIDGET_PANEL_W)
  })

  it('下面装得下 ⇒ 向下展开，**顶边中心不动**（200→280 胶囊不跳）', () => {
    const g = widgetExpandGeom(MID, 300, SCREEN)
    expect(g.flipUp).toBe(false)
    expect(g.x + g.w / 2).toBe(MID.x + MID.w / 2)
    expect(g.y).toBe(MID.y)          // 顶边不动：向下长
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
   * ⚠️ **这条是默认落点的真实情况**：小窗默认在**右下角**
   * （`y = 屏高 − 40 − 72`，1080p 上是 968），向下展开要 1214+ ⇒ **永远放不下**。
   * 所以真机上几乎总是走翻转分支 —— 不测它等于没测。
   */
  it('**右下角默认落点 ⇒ 必须向上翻**（否则夹取会把胶囊挪走）', () => {
    const corner = defaultWidgetPos(SCREEN)
    const cur = { ...corner, w: WIDGET_SIZE.w, h: WIDGET_SIZE.h }
    const g = widgetExpandGeom(cur, 300, SCREEN)
    expect(g.flipUp).toBe(true)
    // 翻转后**底边对齐胶囊底边**，整窗在屏幕内
    expect(g.y + g.h).toBe(cur.y + WIDGET_SIZE.h)
    expect(g.y).toBeGreaterThanOrEqual(0)
  })

  /**
   * ⚠️ `capsuleOffset` 是 2026-09-25 批 5g 加的，守的是一个**真机截图里的错位**：
   * 原来 CSS 认定"翻上去 ⇒ 胶囊贴窗口**底**边"（`flex-end`），
   * 而贴屏幕上沿时窗口会被**夹**（顶边不能为负）⇒ 那个假设不成立 ⇒ 胶囊跳到窗口中间。
   */
  describe('capsuleOffset：胶囊在窗口内的偏移（几何给，CSS 不许猜）', () => {
    it('向下展开且没被夹 ⇒ 偏移 0（胶囊仍在窗口顶边）', () => {
      const g = widgetExpandGeom({ x: 1000, y: 300, w: 200, h: 40 }, 300, SCREEN)
      expect(g.flipUp).toBe(false)
      expect(g.capsuleOffset).toBe(0)
    })

    it('向上翻且**没被夹** ⇒ 偏移 = 窗口高 − 胶囊高（等价于旧的 flex-end）', () => {
      const corner = defaultWidgetPos(SCREEN)
      const g = widgetExpandGeom({ ...corner, w: 200, h: 40 }, 300, SCREEN)
      expect(g.flipUp).toBe(true)
      expect(g.y).toBeGreaterThan(0)                     // 确实没被夹
      expect(g.capsuleOffset).toBe(g.h - WIDGET_SIZE.h)
    })

    it('**向上翻且被屏幕上沿夹住** ⇒ 偏移跟着变小（不是窗口高 − 胶囊高）', () => {
      // 胶囊贴屏幕上沿（y=10）。面板要**够高**才能逼出"向上翻"：
      // 向下需要 10 + 40 + 6 + 面板高 ≤ 1080 − 24 ⇒ 面板高 > 1000 才会翻。
      const TALL = 1200
      const g = widgetExpandGeom({ x: 800, y: 10, w: 200, h: 40 }, TALL, SCREEN)
      expect(g.flipUp).toBe(true)
      expect(g.y).toBe(0)                                 // 被夹到屏幕上沿
      // 真实的胶囊偏移 = 胶囊原 y(10) − 窗口 y(0) = 10
      expect(g.capsuleOffset).toBe(10)
      // 而旧的"贴底边"写法会给 1206（= 1246 − 40）—— 差 1196px，就是截图里的错位
      expect(g.capsuleOffset).not.toBe(g.h - WIDGET_SIZE.h)
    })

    it('**胶囊的屏幕位置在展开前后不变**（这才是"不动"的定义）', () => {
      const cases = [
        { x: 800, y: 10, w: 200, h: 40 },     // 贴上沿（会被夹）
        { ...defaultWidgetPos(SCREEN), w: 200, h: 40 },  // 右下角
        { x: 1000, y: 300, w: 200, h: 40 },   // 屏幕中部
      ]
      for (const cur of cases) {
        const g = widgetExpandGeom(cur, 300, SCREEN)
        // 胶囊**在屏幕上的**顶边 = 窗口 y + 窗口内偏移
        expect(g.y + g.capsuleOffset).toBe(cur.y)
      }
    })

    it('折叠态偏移恒为 0', () => {
      const g = widgetCollapseGeom({ x: 900, y: 900, w: 280, h: 346 }, SCREEN, true,
                                   { x: 900, y: 900 })
      expect(g.capsuleOffset).toBe(0)
    })
  })

  it('翻转时横向居中**尽量**保持（贴边夹取赢过居中，这是物理约束）', () => {
    const corner = defaultWidgetPos(SCREEN)
    const cur = { ...corner, w: WIDGET_SIZE.w, h: WIDGET_SIZE.h }
    const g = widgetExpandGeom(cur, 300, SCREEN)
    // 右缘贴边 ⇒ 280 宽的窗口必须被夹回来，整窗在屏内
    expect(g.x + g.w).toBeLessThanOrEqual(SCREEN.width)
    expect(g.x).toBeGreaterThanOrEqual(WIDGET_MIN_VISIBLE - g.w)
  })

  it('翻转也装不下（面板高过屏幕）时被夹回屏幕内，不出现负坐标', () => {
    const corner = defaultWidgetPos(SCREEN)
    const g = widgetExpandGeom({ ...corner, w: 200, h: 40 }, 5000, SCREEN)
    expect(g.y).toBeGreaterThanOrEqual(0)
    expect(g.x).toBeGreaterThanOrEqual(WIDGET_MIN_VISIBLE - g.w)
  })

  it('贴着屏幕左上角 ⇒ 横向被夹回，不越出左缘', () => {
    const g = widgetExpandGeom({ x: 0, y: 0, w: 200, h: 40 }, 300, SCREEN)
    expect(g.x).toBeGreaterThanOrEqual(WIDGET_MIN_VISIBLE - WIDGET_PANEL_W)
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
  it('回到折叠尺寸', () => {
    const ex = widgetExpandGeom({ x: 1000, y: 300, w: 200, h: 40 }, 300, SCREEN)
    const g = widgetCollapseGeom({ ...ex }, SCREEN, ex.flipUp)
    expect(g.w).toBe(WIDGET_SIZE.w)
    expect(g.h).toBe(WIDGET_SIZE.h)
  })

  it('**向下展开再收起** ⇒ 回到用户原来摆的位置（闭环）', () => {
    const before = { x: 1000, y: 300, w: WIDGET_SIZE.w, h: WIDGET_SIZE.h }
    const ex = widgetExpandGeom(before, 300, SCREEN)
    const back = widgetCollapseGeom({ ...ex }, SCREEN, ex.flipUp)
    expect(back.x).toBe(before.x)
    expect(back.y).toBe(before.y)
  })

  /**
   * ⚠️ 翻转分支的闭环**靠 `restore`**：贴边展开时窗口必须被夹（否则面板出屏），
   * 于是"从展开矩形反推"会少掉那几十像素 —— 每悬停一次漂一点，久了小窗就爬走了。
   * 所以收起要**直接回到展开前记录的矩形**。
   */
  it('**向上翻再收起** ⇒ 精确回到展开前的位置（靠 restore，不靠反推）', () => {
    const corner = defaultWidgetPos(SCREEN)
    const before = { ...corner, w: WIDGET_SIZE.w, h: WIDGET_SIZE.h }
    const ex = widgetExpandGeom(before, 300, SCREEN)
    expect(ex.flipUp).toBe(true)
    const back = widgetCollapseGeom({ ...ex }, SCREEN, true, { x: before.x, y: before.y })
    expect(back.x).toBe(before.x)
    expect(back.y).toBe(before.y)
  })

  it('**反复展开/收起不漂移**（10 轮之后仍在原处）—— 反推法会在这里累积误差', () => {
    const before = { ...defaultWidgetPos(SCREEN), w: WIDGET_SIZE.w, h: WIDGET_SIZE.h }
    // 显式标注成可变宽高的矩形：`WIDGET_SIZE` 是 `as const`（`w: 200`），
    // 直接把 `back`（宽高是 number）赋回去会被 TS 判成不兼容。
    let cur: { x: number; y: number; w: number; h: number } = { ...before }
    for (let i = 0; i < 10; i++) {
      const ex = widgetExpandGeom(cur, 300, SCREEN)
      const back = widgetCollapseGeom({ ...ex }, SCREEN, ex.flipUp, { x: cur.x, y: cur.y })
      cur = { ...back }
    }
    expect(cur.x).toBe(before.x)
    expect(cur.y).toBe(before.y)
  })

  it('没有 restore 时退回反推（退化路径仍要能用）', () => {
    const before = { x: 1000, y: 300, w: WIDGET_SIZE.w, h: WIDGET_SIZE.h }
    const ex = widgetExpandGeom(before, 300, SCREEN)
    const back = widgetCollapseGeom({ ...ex }, SCREEN, ex.flipUp)
    expect(back.w).toBe(WIDGET_SIZE.w)
    expect(back.h).toBe(WIDGET_SIZE.h)
  })
})
