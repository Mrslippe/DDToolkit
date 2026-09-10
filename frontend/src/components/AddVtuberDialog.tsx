import { useEffect, useRef, useState } from 'react'
import { Loader2, Search, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api } from '../api/api'
import type { PoolItem } from '../api/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 收录成功回调（父级刷新列表） */
  onAdded: () => void
}

/**
 * 添加 VTuber 浮窗：输入名称/uid 防抖检索本地候选池（csv 索引），
 * 点选条目即收录入库；后端建库后自动调度该 V 的账号信息抓取。
 */
export default function AddVtuberDialog({ open, onOpenChange, onAdded }: Props) {
  const [kw, setKw] = useState('')
  const [results, setResults] = useState<PoolItem[]>([])
  const [searching, setSearching] = useState(false)
  const [adoptingUid, setAdoptingUid] = useState<string | null>(null)
  const timerRef = useRef<number>()

  // 关闭时清态
  useEffect(() => {
    if (!open) {
      setKw('')
      setResults([])
      setAdoptingUid(null)
    }
  }, [open])

  // 输入防抖检索：AbortController 取消在途请求 + 序号校验，
  // 修复：此前快速连续输入时旧请求晚到会覆盖新关键词的结果（竞态）
  useEffect(() => {
    if (!open) return
    window.clearTimeout(timerRef.current)
    const q = kw.trim()
    if (!q) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const controller = new AbortController()
    timerRef.current = window.setTimeout(async () => {
      try {
        const r = await api.searchPool(q, controller.signal)
        if (controller.signal.aborted) return
        setResults(r)
      } catch (e) {
        if ((e as Error).name === 'AbortError') return // 已被更新的关键词取代
        toast.error(`候选池检索失败：${(e as Error).message}`)
        setResults([])
      } finally {
        if (!controller.signal.aborted) setSearching(false)
      }
    }, 250)
    return () => {
      window.clearTimeout(timerRef.current)
      controller.abort()
    }
  }, [kw, open])

  const adopt = async (item: PoolItem) => {
    setAdoptingUid(item.platform_uid)
    try {
      await api.adoptVtuber(item.platform, item.platform_uid)
      // 踢一脚 TopBar 立即轮询：捕获本次单V抓取进入 running 态，
      // 保证其完成时 running→idle 边沿必然派发 fetch-idle（防竞态漏刷新）
      window.dispatchEvent(new Event('ddtoolkit:kick-poll'))
      toast.success(`已收录「${item.name}」，正在抓取账号信息与最新动态…`)
      onAdded()
      onOpenChange(false)
    } catch (e) {
      toast.error(`收录失败：${(e as Error).message}`)
    } finally {
      setAdoptingUid(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加 VTuber</DialogTitle>
          <DialogDescription>
            输入名字或 UID 从候选池检索；收录后立即执行账号信息抓取。
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="名字或 UID，如：塔菲 / 1265680561"
            className="h-9 w-full rounded-lg border border-input bg-background pl-8 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>

        <div className="max-h-72 min-h-24 overflow-y-auto rounded-lg border border-border">
          {searching && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 检索中…
            </div>
          )}

          {!searching && !kw.trim() && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              输入关键词开始检索（本地候选池）
            </div>
          )}

          {!searching && kw.trim() && results.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">没有匹配的候选</div>
          )}

          {!searching &&
            results.map((it) => {
              const busy = adoptingUid === it.platform_uid
              return (
                <button
                  key={`${it.platform}-${it.platform_uid}`}
                  type="button"
                  disabled={adoptingUid !== null}
                  onClick={() => adopt(it)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--sel-bg-hover)] disabled:opacity-60"
                >
                  <span className="shrink-0 rounded-md bg-[var(--c-rail)] px-1.5 py-0.5 text-[10px] leading-none text-white">
                    {it.platform}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{it.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      UID {it.platform_uid}
                    </span>
                  </span>
                  {busy ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                  ) : (
                    <UserPlus className="size-4 shrink-0 text-muted-foreground" />
                  )}
                </button>
              )
            })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
