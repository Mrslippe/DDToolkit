/**
 * 图表主题常量（FanTrendChart 与未来 ECharts 图表共用）。
 *
 * canvas 渲染读不到 CSS 变量，故在此集中定义与 tokens.css 同源的色值——
 * 改动配色时须同步 docs/UI-MAP.md C 节与 styles/tokens.css：
 * - CHART_PINK   = --c-primary-deep #fb77a1（粉丝数曲线/涨粉柱/滑块高亮）
 * - CHART_GRID   = --c-border 的图表网格版（35% 透明度）
 * - CHART_MUTED  = --c-text-sub（轴标签/次级文字）
 * - CHART_TEXT   = --c-text-main（tooltip 正文）
 * - 派生透明度统一经 pinkA()/borderA() 生成（同一色相，勿再手写 rgba）
 */
export const CHART_PINK = '#fb77a1'
export const CHART_LOSS_GRAY = '#a0aec0' // 掉粉灰（浅灰蓝，浅底可见；非令牌色）
export const CHART_GRID = 'rgba(210, 216, 222, 0.35)'
export const CHART_BORDER = 'rgba(210, 216, 222, 0.55)' // --c-border
export const CHART_MUTED = '#5b6c7e' // --c-text-sub
export const CHART_TEXT = '#4b5a6b' // --c-text-main
/** --shadow-dialog 同步（tooltip 浮层阴影） */
export const CHART_SHADOW = '0 4px 16px rgba(15, 23, 42, 0.1)'

/** 粉系透明度派生（注意不带 #：rgba(r, g, b, a) 前缀） */
export const PINK_RGB = '251, 119, 161'
export const pinkA = (a: number) => `rgba(${PINK_RGB}, ${a})`
