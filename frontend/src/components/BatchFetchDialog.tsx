import { useState } from 'react'
import { Archive, Newspaper, RefreshCw, Users } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api } from '../api/api'
import { useFetchBusy } from '../fetchBusy'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface BatchAction {
  key: string
  label: string
  desc: string
  icon: React.ReactNode
  run: () => Promise<unknown>
  /** 归档为同步任务，完成后不自动关窗以便看到结果数字 */
  keepOpen?: boolean
}

const ACTIONS: BatchAction[] = [
  {
    key: 'accounts',
    label: '全量抓取账号信息',
    desc: '遍历所有 VTuber 的 bilibili 账号刷新昵称/签名/粉丝数/直播状态',
    icon: <Users className="size-5" />,
    run: () => api.batchFetchAccounts(),
  },
  {
    key: 'all-posts',
    label: '全量抓取帖子',
    desc: '所有账号的视频 + 动态全量拉取（耗时较长）',
    icon: <Newspaper className="size-5" />,
    run: () => api.batchFetchAllPosts(),
  },
  {
    key: 'update-unarchived',
    label: '更新未归档帖',
    desc: '先归档旧帖，再仅抓取未归档账号的新动态（日常增量推荐）',
    icon: <RefreshCw className="size-5" />,
    run: () => api.batchUpdateUnarchived(),
  },
  {
    key: 'archive',
    label: '归档旧帖',
    desc: '发布时间早于 30 天的帖子标记归档（幂等）',
    icon: <Archive className="size-5" />,
    run: () => api.batchArchive(30),
    keepOpen: true,
  },
]

/** 批量任务浮窗：四项后台任务触发器；进度经 TopBar 状态胶囊反馈。 */
export default function BatchFetchDialog({ open, onOpenChange }: Props) {
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const fetchBusy = useFetchBusy()

  const run = async (a: BatchAction) => {
    setBusyKey(a.key)
    try {
      const r = (await a.run()) as { status?: string; archived?: number }
      if (a.key === 'archive') {
        toast.success(`归档完成：${r?.archived ?? 0} 条帖子已归档`)
      } else if (r?.status === 'started') {
        toast.success(`「${a.label}」已开始，进度见顶栏`)
      } else {
        toast.info(`「${a.label}」：${r?.status ?? '已完成'}`)
      }
      if (!a.keepOpen) onOpenChange(false)
    } catch (e) {
      toast.error(`${a.label}失败：${(e as Error).message}`)
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>批量任务</DialogTitle>
          <DialogDescription>
            任务后台执行；运行中再次触发会被拒绝。
            {fetchBusy ? '（当前已有抓取任务进行中）' : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {ACTIONS.map((a) => (
            <button
              key={a.key}
              type="button"
              disabled={busyKey !== null || (fetchBusy && a.key !== 'archive')}
              title={fetchBusy && a.key !== 'archive' ? '已有抓取任务进行中，请稍后再试' : undefined}
              onClick={() => run(a)}
              className="flex items-center gap-3 border border-border p-3 text-left transition-colors hover:bg-[var(--sel-bg-hover)] disabled:opacity-60"
            >
              <span className="flex size-9 shrink-0 items-center justify-center bg-secondary text-secondary-foreground">
                {a.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{a.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{a.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
