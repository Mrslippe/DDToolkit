/**
 * 列表页的**筛选状态**（M4，批次 12 第二刀，devlog/219）。
 *
 * 七个字段（类型 / 归档 / 已删 / 搜索输入 / 生效关键词 / 起止日期）+ 一条**换账号即重置**的
 * effect。原来它们散在 `PostsPage` 里，现在收进这里 —— `PostsPage` 只剩"谁在什么时机调它"。
 *
 * ## ⚠️ 搬动时逐字保留的一条时序契约（E9）
 *
 * `resetFiltersOnSwitch` 的依赖是 **`[sceneAcc, accountKey]`**，而它**必须先于场景提交跑完**：
 * 提交时 `filterRef` 要已是重置态，否则预取（恒按默认筛选拉）与提交后的筛选指纹错配 ⇒
 * **种子被误消费**（列表先错一帧再被重取纠正）。
 *
 * ⇒ **不许把它改成"提交时重置"**、也不许改依赖数组。它现在的位置（同批 render 后的 effect）
 *    正是"先于 `EXIT_MS` 提交"这条时序的实现方式。
 *
 * ## 为什么 6 个 handler 没一起搬（与计划的偏差，记在 devlog/219）
 *
 * 计划把"7 个 state + 6 个 handler"算作同一台机器。实测那 6 个 handler 每个都是
 * `setX(…) + setPage(1)`，而 **`setPage` 属于分页机**（`usePostPagination`）——
 * 两台机器互拿对方的 setter 就成了**循环依赖**。折中：**状态与重置进 hook**，
 * 那一行 `setPage(1)` 留在调用点（页面），两台 hook 的依赖方向保持单向。
 */
import { useEffect, useRef, useState } from 'react'

import type { ArchivedFilter } from '../components/PostFilterPop'

interface Args {
  /** 场景里的 V id（切 V ⇒ 重置） */
  sceneAcc: number
  /** 账号稳定代理（`platform:uid`；换账号 ⇒ 重置）。`null` = 还没有选中账号 */
  accountKey: string | null
}

export function usePostQueryState({ sceneAcc, accountKey }: Args) {
  const [typeFilter, setTypeFilter] = useState<string>()
  const [archived, setArchived] = useState<ArchivedFilter>('all')
  const [deletedOnly, setDeletedOnly] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [searchKw, setSearchKw] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  /** 搜索防抖：输入 300ms 后才把 `searchInput` 落到生效关键词 `searchKw`。
   *  这条也属于"筛选状态"（它是 `searchKw` 的唯一写者），与上面那条重置 effect 一起搬进来。 */
  const searchTimer = useRef<number>()
  useEffect(() => {
    window.clearTimeout(searchTimer.current)
    searchTimer.current = window.setTimeout(() => setSearchKw(searchInput.trim()), 300)
    return () => window.clearTimeout(searchTimer.current)
  }, [searchInput])

  // 用户反馈（2026-09-05）：不同 VTuber/账号之间筛选状态不共享——切换后重置。
  // 时序：本 effect 与 scene 提交同批 render 后运行，先于 EXIT_MS 提交完成，
  // 提交时 filterRef 已是重置态 → 与预取默认参数一致（防种子错配）。
  useEffect(() => {
    setTypeFilter(undefined)
    setSearchInput('')
    setSearchKw('')
    setDateFrom('')
    setDateTo('')
    setDeletedOnly(false)
    // `archived` 此前漏在这条重置之外（P8-A 加归档 chip 时未同步）：留在「仅已归档」切账号，
    // 预取恒按默认参数拉、提交却带 archived 筛选 → 种子指纹错配（列表先错一帧再被重取纠正）。
    setArchived('all')
  }, [sceneAcc, accountKey])

  /** 「筛选弹窗里的重置」：清掉三个弹窗内字段（**不动**类型与关键词——它们不在弹窗里）。
   *  调用方补 `setPage(1)`，理由见文件头。 */
  const resetFilters = () => {
    setDeletedOnly(false)
    setArchived('all')
    setDateFrom('')
    setDateTo('')
  }

  return {
    typeFilter, setTypeFilter,
    archived, setArchived,
    deletedOnly, setDeletedOnly,
    searchInput, setSearchInput,
    searchKw, setSearchKw,
    dateFrom, setDateFrom,
    dateTo, setDateTo,
    resetFilters,
  }
}
