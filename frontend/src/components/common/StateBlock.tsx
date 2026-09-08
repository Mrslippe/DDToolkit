import { CircleAlert, Loader2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'

type Kind = 'loading' | 'empty' | 'error'
type Variant = 'overlay' | 'inline' | 'alert'

interface Props {
  kind: Kind
  /** 文案；overlay 的 loading 态可省略（只显示转圈图标） */
  text?: string
  /**
   * 视觉配方（各自沿用既有类，像素级不变）：
   * - overlay：卡片/面板内居中态 `.lc-state`（+ `.lc-error`），转圈 16px
   * - inline：面板占位 `.posts-placeholder`，转圈 16px 主色
   * - alert：shadcn 危险卡（标题 + 描述）
   */
  variant?: Variant
  /** alert 变体的标题（默认「加载失败」） */
  title?: string
  className?: string
}

/**
 * 加载 / 空 / 错误三态（2026-09 P1 收敛：原先 `.lc-state`、`.posts-placeholder`、
 * `<Alert>` 三套写法散落在日历、趋势卡、帖子页共 7 处）。
 * 只统一「结构 + 转圈图标 + 文案」，视觉配方仍由各上下文类承担，调用点零视觉变化。
 */
export default function StateBlock({
  kind,
  text,
  variant = 'overlay',
  title = '加载失败',
  className,
}: Props) {
  if (variant === 'alert') {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{text}</AlertDescription>
      </Alert>
    )
  }

  const base = variant === 'inline' ? 'posts-placeholder' : 'lc-state'
  const cls =
    base + (variant === 'overlay' && kind === 'error' ? ' lc-error' : '') + (className ? ` ${className}` : '')

  return (
    <div className={cls}>
      {kind === 'loading' &&
        (variant === 'inline' ? (
          <Loader2 className="mr-2 inline size-4 animate-spin align-[-2px] text-primary" />
        ) : (
          <Loader2 className="lc-state-icon" />
        ))}
      {text}
    </div>
  )
}
