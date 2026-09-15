import { useEffect, useState } from 'react'
import { isShellHidden, onShellVisibilityChange } from '../utils/shellLifecycle'

/**
 * 订阅"外壳是否被隐藏到托盘"（R18，devlog/095）。
 *
 * 组件用它来停表/复表：隐藏期间顶栏不该再轮询、状态岛不该再转轮播、
 * 图表不该再跟 resize —— 用户要的是"后台抓取照常，但**不用渲染前端**"。
 */
export function useShellHidden(): boolean {
  const [hidden, setHidden] = useState(() => isShellHidden())
  useEffect(() => onShellVisibilityChange(setHidden), [])
  return hidden
}
