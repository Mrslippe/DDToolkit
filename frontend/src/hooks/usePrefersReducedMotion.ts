/**
 * 系统是否要求"减少动效"（`prefers-reduced-motion: reduce`）。
 *
 * 为什么要有这个 hook（而不是只在 CSS 里写 `@media`）：
 * **内联 `transform` 的优先级高于媒体查询** —— 拾起时的 `scale(1.055)` 是内联写上去的，
 * 光靠 CSS 关不掉它。所以"要不要缩放"这件事必须在**写内联样式的那一侧**决定
 * （口径在 `components/profile/motion.ts::motionPlan`，本 hook 只负责读系统偏好）。
 *
 * 订阅 `change`：用户在系统设置里改了这一项，界面不用重启就跟随
 * （探针用 `--force-prefers-reduced-motion` 起浏览器时也能立刻读到）。
 */
import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function read(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY).matches
    : false
}

export default function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(read)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(QUERY)
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  return reduced
}
