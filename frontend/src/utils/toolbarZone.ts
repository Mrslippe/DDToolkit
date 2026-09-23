/**
 * 页面工具条热区判定（R45，devlog/174）。
 *
 * **为什么抽成纯函数**：这是"呼出会不会误触发"的**全部逻辑**，而它有三处容易写错 ——
 *   ① 热区是**多个矩形的并集**（`.glow-bar` ∪ 右上组），**不是**整条 66px 带子
 *      （整条会把"去够列表页的分类胶囊"也算进去，而那是用户点名要最直接可触及的控件）；
 *   ② 每个矩形**各向外扩** `pad`；
 *   ③ 隐藏态的条带 `transform: translateY(-6px)` ⇒ 量到的 rect 与显示态差 6px，
 *      必须由调用方传**当前** rect，不能缓存。
 * 探针（`ui_probe.py --toolbar`）只走得到"命中/不命中"两个点；边界与多矩形靠这一层。
 */

/** 与 `DOMRect` 结构兼容的最小面 —— 用结构类型而不是 `DOMRect`，
 *  这样单测能在 **node 环境**（本仓 vitest 无 jsdom）里直接传字面量。 */
export interface HotRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
}

/**
 * 指针是否落在热区（`rects` 各向外扩 `pad` 的并集）。
 *
 * @param rects 元素矩形；`null` 与**零宽**项一律跳过。
 *   零宽 = 元素未布局（`display:none` / 未挂载 / `getBoundingClientRect` 返回空），
 *   把它当成一个点会造出一块**看不见却能触发**的热区 —— 那正是"路过即闪"的来源之一。
 */
export function inHotZone(
  x: number,
  y: number,
  rects: readonly (HotRect | null | undefined)[],
  pad: number,
): boolean {
  for (const r of rects) {
    if (!r || r.width === 0) continue
    if (
      x >= r.left - pad &&
      x <= r.right + pad &&
      y >= r.top - pad &&
      y <= r.bottom + pad
    ) {
      return true
    }
  }
  return false
}
