import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import FloatPill from '../common/FloatPill'

/** 一条菜单项。`danger` 走红字（删除这类不可逆动作）。 */
export interface NavMenuItem {
  /** 稳定 key（同时也是 `data-nav-item` 的值，探针据此点它） */
  key: string
  label: string
  /** 左侧图标（lucide 元件，14px） */
  icon?: ReactNode
  /** 一句话说明（第二行小字，可省） */
  hint?: string
  danger?: boolean
  disabled?: boolean
  /** 禁用原因（`title` + 小字）—— **不给一个点了没反应的项** */
  disabledReason?: string
  onSelect: () => void
}

interface Props {
  /** 触发钮的无障碍名（探针与读屏都靠它） */
  label: string
  /** 悬停提示 */
  title?: string
  /** 菜单开启时的文字反馈（按钮上不换图标，只换 title） */
  icon: ReactNode
  items: NavMenuItem[]
  /** 弹出方向：`start` 左对齐（默认）· `end` 右对齐（靠右的按钮用） */
  align?: 'start' | 'end'
  /** 触发钮样式：`pill`（默认，浮片，用于日历工具栏）· `icon`（**纯图标钮**，用于弹窗头部） */
  bare?: boolean
  /** 探针钩子：容器上挂 `data-<probe>=<state>` */
  probe?: string
}

/**
 * 导航下拉栏（B4，`docs/plans/vod-autofill.md`）。
 *
 * ## 为什么要有它（用户 2026-10-15 的两条口径）
 *
 * 1. 「图一铅笔**我希望打开的是下拉栏而不是独立窗口**，因为详情页本身已经是独立窗口，
 *    如果再打开一个小窗会显得层级关系混乱，**背景遮罩颜色也不对劲**」
 *    —— 下拉栏是**面上的一层**，不带遮罩，因此不会与详情弹窗那层遮罩叠出第二种颜色；
 * 2. 「图二这个按钮**就是用来添加录播的**」—— 工具栏那枚 `+` 从"手动记录"变成一栏入口
 *    （加录播 / 手动记录 / 编辑录播号）。
 *
 * ## 契约（探针与用例都按它查）
 *
 * - 容器 `data-<probe>` = `open` / `closed`；触发钮 `data-nav-trigger`；
 * - 菜单项 `[data-nav-item="<key>"]`，禁用项带 `disabled`；
 * - **Esc 与点外部关闭**；选中一项后自动关闭（点完还得手动关的菜单最烦人）。
 */
export default function NavMenu({ label, title, icon, items, align = 'start',
                                  bare = false, probe = 'nav-menu' }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      // 点外部关闭：容器内含触发钮与菜单，落在里面就不关（否则点按钮会先关再开）
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <div className="nav-menu" ref={rootRef} data-nav-menu={open ? 'open' : 'closed'}
         {...{ [`data-${probe}`]: open ? 'open' : 'closed' }}>
      {/* ⚠️ 两种触发钮，别混用（用户 2026-10-15 口径）：
          · `bare`（弹窗头部）：**纯图标钮**，26×26 / r8 / 无底色，与关闭钮同一套配方 ——
            用户原话「标题右侧的编辑按钮**不用浮片样式，就原本纯图标样式就行**」；
          · 默认（日历工具栏）：浮片（`FloatPill`，斜切白卡），与它左边那几枚月份钮同族。
          这里必须是**原生 `<button>`**（不是 FloatPill）：`FloatPill` 的 ::before 会画出
          斜切白卡与阴影，正是用户要去掉的那个东西。 */}
      {bare ? (
        <button type="button" className="nav-menu-trigger" title={title || label}
                aria-label={label} aria-haspopup="menu" aria-expanded={open}
                data-nav-trigger="1" onClick={() => setOpen((v) => !v)}>
          {icon}
        </button>
      ) : (
        <FloatPill shape="icon" title={title || label} aria-label={label}
                   aria-haspopup="menu" aria-expanded={open}
                   data-nav-trigger="1" onClick={() => setOpen((v) => !v)}>
          {icon}
        </FloatPill>
      )}
      {open && (
        <div className={`nav-menu-pop${align === 'end' ? ' end' : ''}`} role="menu"
             aria-label={label}>
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={`nav-menu-item${it.danger ? ' danger' : ''}`}
              data-nav-item={it.key}
              disabled={it.disabled}
              title={it.disabled ? it.disabledReason : undefined}
              onClick={() => {
                setOpen(false)
                it.onSelect()
              }}
            >
              {it.icon && <span className="nav-menu-icon">{it.icon}</span>}
              <span className="nav-menu-text">
                <span className="nav-menu-label">{it.label}</span>
                {(it.hint || (it.disabled && it.disabledReason)) && (
                  <span className="nav-menu-hint">
                    {it.disabled ? it.disabledReason : it.hint}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
