/**
 * VTuber 操作（抓取 / 更新 / 解除订阅 / 加账号后刷新）—— P2 分层收敛 A-4：
 * 从 `PostsPage.tsx` 搬出，**只搬不改**。
 *
 * ## 为什么值得抽
 *
 * 这 6 个回调是页面的"动作层"：每个都是「守卫 → `setFetching(true)` → `kickPoll()`
 * → api → 分三种结果提示 → `finally { setFetching(false); kickPoll() }`」的同一套骨架。
 * 它们与渲染无关，却占着 128 行；抽出来之后：
 * - `PostsPage` 少 6 个 `useCallback` 与它们的依赖数组；
 * - `fetching` 从"页面状态"变为"这个 hook 的状态"（它只被这些动作写、只被按钮读）；
 * - 骨架重复变得显眼，后续若要收敛成统一包装函数，只需要改这一个文件。
 *
 * ## 为什么用"注入 props"而不是读 context
 *
 * `vtuber` / `selectedAccount` / `scene.acc` 都是页面自己持有的状态，
 * 项目也没有全局 store（见 `FRONTEND-ARCH.md` §A3：局部 state + 事件总线）。
 * 所以按显式入参注入，保持"依赖一眼可见"，不引入新机制。
 *
 * ## 行为保持要点
 *
 * - 每个回调的**守卫、提示文案、依赖数组**逐字保留（含 `bili?.platform ?? 'bilibili'`
 *   这个既有兜底：`bili` 在原文件里就是 `selectedAccount` 的别名）；
 * - `handleAccountAdded` **不**调 `fetchVtuber`：后端 `create_account` 已拉起该账号的
 *   账号信息 + 首屏抓取（v0.9.4），前端重复调只会与后台任务抢同一把锁（devlog/044）；
 * - 提示通道分工不变：成功走顶栏胶囊（`pill`）、警示/失败走 `toast`。
 */
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import type { Account, VTuber } from '../api/types'
import { api } from '../api/api'

/** 成功类提示走顶栏状态胶囊（渐隐渐显），错误仍用 toast */
function pill(text: string) {
  window.dispatchEvent(new CustomEvent('ddtoolkit:pill-message', { detail: { text } }))
}

/** 通知 TopBar 立即轮询一次抓取状态（点击按钮/任务结束时即时反馈） */
function kickPoll() {
  window.dispatchEvent(new Event('ddtoolkit:kick-poll'))
}

interface Args {
  vtuber: VTuber | null
  /** 当前选中账号（提供 `platform` 兜底；原文件里的 `bili` 就是它） */
  selectedAccount: Account | null
  /** 场景账号 id（= 路由里的 V id，抓取接口按它调） */
  accountId: number
  navigate: (to: string) => void
  /** 加账号成功后回填最新本体（药丸出现 + 选中新账号） */
  setVtuber: (v: VTuber) => void
  setSelectedAccount: (a: Account) => void
  /** 解除订阅失败时收起确认框（原文件里是 `setConfirmDel(false)`） */
  onDeleteError: () => void
}

export function useVtuberActions({
  vtuber, selectedAccount, accountId, navigate, setVtuber, setSelectedAccount, onDeleteError,
}: Args) {
  const [fetching, setFetching] = useState(false)

  const handleFetch = useCallback(async () => {
    if (!vtuber || fetching) return
    setFetching(true)
    kickPoll() // 立即刷新胶囊 → 显示「抓取中」
    try {
      const r = await api.fetchVtuber(accountId)
      if (r.status === 'skipped') {
        toast.warning(r.message ?? '抓取任务正在进行中')
      } else {
        const s = r.result
        pill(`账号信息更新完成 · 成功 ${s?.success ?? 0} · 失败 ${s?.failed ?? 0}`)
      }
    } catch (e) {
      toast.error(`抓取失败: ${(e as Error).message}`)
    } finally {
      setFetching(false)
      kickPoll()
    }
  }, [vtuber, accountId, fetching])

  const handleFetchPosts = useCallback(async () => {
    if (!vtuber || fetching) return
    setFetching(true)
    kickPoll()
    try {
      const r = await api.fetchPostsByName(vtuber.name, 2, 3, false, selectedAccount?.platform ?? 'bilibili')
      if (r.status === 'skipped') {
        toast.warning(r.message ?? '帖子抓取正在进行中')
      } else if (r.rate_limited) {
        let tip = '部分内容未抓全'
        if (r.video_missing) tip += `（视频可能缺 ${r.video_missing}）`
        toast.warning(
          `帖子抓取完成（触发风控，${tip}）· 存储 ${r.total?.stored ?? 0} · 跳过 ${r.total?.skipped ?? 0}`,
        )
      } else {
        pill(
          `帖子抓取完成 · 存储 ${r.total?.stored ?? 0} · 跳过 ${r.total?.skipped ?? 0}` +
            ` · 预归档 ${r.archived_first ?? 0}`,
        )
      }
    } catch (e) {
      toast.error(`帖子抓取失败: ${(e as Error).message}`)
    } finally {
      setFetching(false)
      kickPoll()
    }
  }, [vtuber, fetching, selectedAccount?.platform])

  const handleFetchAllPosts = useCallback(async () => {
    if (!vtuber || fetching) return
    setFetching(true)
    kickPoll()
    try {
      const r = await api.fetchPostsByName(vtuber.name, -1, -1, true, selectedAccount?.platform ?? 'bilibili')
      if (r.status === 'skipped') {
        toast.warning(r.message ?? '帖子抓取正在进行中')
      } else {
        toast.success('全量抓取已开始（后台执行，进度见顶栏）')
      }
    } catch (e) {
      toast.error(`全量抓取失败: ${(e as Error).message}`)
    } finally {
      setFetching(false)
      kickPoll()
    }
  }, [vtuber, fetching, selectedAccount?.platform])

  const handleUpdatePosts = useCallback(async () => {
    if (!vtuber || fetching) return
    setFetching(true)
    kickPoll()
    try {
      const r = await api.updateUnarchivedPosts(vtuber.name)
      if (r.status === 'skipped') {
        toast.warning(r.message ?? '更新任务正在进行中')
      } else if (r.rate_limited) {
        toast.warning(
          `动态更新完成（触发风控，部分内容未抓全）· 新增 ${r.total?.stored ?? 0} · 跳过 ${r.total?.skipped ?? 0}`,
        )
      } else {
        const incremental = r.details?.some((d) => d.stopped_early) ? ' · 增量模式' : ''
        pill(
          `动态更新完成 · 新增 ${r.total?.stored ?? 0}` +
            ` · 跳过 ${r.total?.skipped ?? 0}${incremental}`,
        )
      }
    } catch (e) {
      toast.error(`更新失败: ${(e as Error).message}`)
    } finally {
      setFetching(false)
      kickPoll()
    }
  }, [vtuber, fetching])

  const handleDeleteVtuber = useCallback(async () => {
    if (!vtuber) return
    try {
      await api.deleteVtuber(accountId)
      toast.success(`已解除订阅「${vtuber.name}」`)
      window.dispatchEvent(new Event('ddtoolkit:data-changed'))
      navigate('/')
    } catch (e) {
      toast.error(`解除订阅失败: ${(e as Error).message}`)
      // 原行为：失败时收起确认框（由页面注入 setConfirmDel(false)）
      onDeleteError()
    }
  }, [vtuber, accountId, navigate, onDeleteError])

  // 添加账号成功（由 <AddAccountDialog> 回调）：刷新本体 → 药丸出现 + 选中新账号。
  // 后端 create_account 已拉起该账号的账号信息 + 首屏抓取（v0.9.4），前端不再重复
  // 调 fetchVtuber（那会与后台任务抢同一把锁 → 排队/浪费）。
  const handleAccountAdded = useCallback(
    async (_acc: Account, platform: string, uid: string) => {
      if (!vtuber) return
      kickPoll()
      const fresh = await api.getVtuber(vtuber.id)
      setVtuber(fresh)
      const hit = fresh.accounts.find(
        (a) => a.platform === platform && a.platform_uid === uid,
      )
      if (hit) setSelectedAccount(hit)
    },
    [vtuber, setVtuber, setSelectedAccount],
  )

  return {
    fetching,
    handleFetch,
    handleFetchPosts,
    handleFetchAllPosts,
    handleUpdatePosts,
    handleDeleteVtuber,
    handleAccountAdded,
  }
}
