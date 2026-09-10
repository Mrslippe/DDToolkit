import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { api } from '../api/api'
import type { Account } from '../api/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  vtuberId: number | null
  vtuberName?: string
  /** 添加成功（后端已拉起该账号的抓取链路）；父级据此刷新本体与选中账号 */
  onAdded: (acc: Account, platform: string, uid: string) => void
}

/**
 * 添加平台账号（P8-B：从 PostsPage 抽成组件 —— card 视图的 hover「+」与
 * 「档案设置」窗口都要用它，避免两份几乎相同的表单）。
 */
export default function AddAccountDialog({
  open,
  onOpenChange,
  vtuberId,
  vtuberName,
  onAdded,
}: Props) {
  const [platform, setPlatform] = useState('bilibili')
  const [uid, setUid] = useState('')
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!open) {
      setUid('')
      setName('')
      setAdding(false)
      setPlatform('bilibili')
    }
  }, [open])

  const submit = async () => {
    const u = uid.trim()
    if (!vtuberId || !u || adding) return
    setAdding(true)
    try {
      const acc = await api.addAccount(vtuberId, {
        platform,
        platform_uid: u,
        ...(name.trim() ? { display_name: name.trim() } : {}),
      })
      toast.success('账号已添加，正在抓取账号信息与最新动态…')
      onAdded(acc, platform, u)
      onOpenChange(false)
    } catch (e) {
      toast.error(`添加账号失败：${(e as Error).message}`)
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>添加平台账号</DialogTitle>
          <DialogDescription>
            给「{vtuberName ?? '…'}」添加 bilibili / 微博账号；添加后自动抓取账号信息。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Select value={platform} onValueChange={setPlatform}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择平台" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bilibili">bilibili（B站）</SelectItem>
              <SelectItem value="weibo">weibo（微博）</SelectItem>
            </SelectContent>
          </Select>
          <input
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            placeholder={platform === 'weibo' ? '微博 UID（数字，如 3669102477）' : 'B 站 UID（数字）'}
            className="h-9 w-full border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="昵称（可选，留空由抓取回填）"
            className="h-9 w-full border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button size="sm" disabled={adding || !uid.trim()} onClick={submit}>
              {adding ? <Loader2 className="size-4 animate-spin" /> : '添加'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
