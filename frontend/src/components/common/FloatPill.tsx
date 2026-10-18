import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Size = 'sm' | 'md'
type Shape = 'plain' | 'icon' | 'text'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 尺寸：不传=基础 25px（侧栏/日历导航）· sm=26px/13px（档案卡采纳钮）· md=30px（帖子页工具行） */
  size?: Size
  /** 形态：plain 不特化内距 · icon 25×25 方钮 · text 文字钮 */
  shape?: Shape
  /** 危险动作（解除订阅等）：红字红图标 */
  danger?: boolean
  /** 激活态：`.on` 主色深填白字 */
  active?: boolean
  children: ReactNode
}

/**
 * 浮片按钮 —— 全站唯一「交互层」元件（契约见 docs/UI-MAP.md §C5）。
 *
 * ⚠️ DOM 契约：必须渲染**原生 `<button class="float-pill …">`**，斜切白卡 / 阴影 /
 * focus-visible 环全部挂在 `::before` 上（styles/layout.css），不得外包一层 div 或换成
 * 其它元素——换元素会丢斜切与焦点环。
 *
 * ⚠️ **必须 `forwardRef`**（2026-10-15 加）：`<Tooltip><TooltipTrigger asChild>` 这类
 * Radix 组合要把 ref 挂到子元素上才算得出锚点位置。此前本组件是普通函数组件 ⇒
 * Radix 报 "Function components cannot be given refs"，工具提示**拿不到锚点**。
 * 其余属性（title / disabled / aria-* / onClick …）照旧原样透传。
 */
const FloatPill = forwardRef<HTMLButtonElement, Props>(function FloatPill({
  size,
  shape = 'plain',
  danger,
  active,
  className,
  children,
  ...rest
}, ref) {
  const cls = [
    'float-pill',
    size && `float-pill--${size}`,
    shape === 'icon' && 'float-pill--icon',
    shape === 'text' && 'float-pill--text',
    danger && 'float-pill--danger',
    active && 'on',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button ref={ref} type="button" className={cls} {...rest}>
      {children}
    </button>
  )
})

export default FloatPill
