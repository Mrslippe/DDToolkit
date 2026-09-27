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
import FloatPill from './common/FloatPill'
import { api } from '../api/api'
import type { Account } from '../api/types'
import { PLATFORM_LABEL } from '../utils/postTypes'
import { XHS_UID_HINT, XHS_UID_PLACEHOLDER, parseXhsUid } from '../utils/platformLogin'

/** 可添加的平台（顺序即下拉顺序）。加平台时改这里一处 —— 界面从它派生。 */
const ACCOUNT_PLATFORMS = ['bilibili', 'weibo', 'xiaohongshu'] as const

const UID_PLACEHOLDER: Record<string, string> = {
  bilibili: 'B 站 UID（数字）',
  weibo: '微博 UID（数字，如 3669102477）',
  xiaohongshu: XHS_UID_PLACEHOLDER,
}

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
 *
 * 小红书（第 4 阶段 ④ 第三刀-4，devlog/235）：它**没有可用的搜索接口**，只能由用户给出 uid；
 * 而用户手上多半是主页链接 ⇒ 提交前用 `parseXhsUid` 摘一次，摘不到就当场提示，
 * 不把整条链接发给后端（那样只会换来一个看不懂的 404）。
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

  const isXhs = platform === 'xiaohongshu'
  /** 真正要提交的 uid：小红书允许粘链接，其余平台原样（改前行为） */
  const finalUid = isXhs ? parseXhsUid(uid) : uid.trim()
  const uidUnparsed = isXhs && !!uid.trim() && !finalUid

  useEffect(() => {
    if (!open) {
      setUid('')
      setName('')
      setAdding(false)
      setPlatform('bilibili')
    }
  }, [open])

  const submit = async () => {
    const u = finalUid
    if (!vtuberId || !u || adding) return
    setAdding(true)
    try {
      const acc = await api.addAccount(vtuberId, {
        platform,
        platform_uid: u,
        ...(name.trim() ? { display_name: name.trim() } : {}),
      })
      toast.success(
        isXhs
          ? '账号已添加，正在抓取账号信息与最新动态…（小红书要配好 Cookie 才抓得到）'
          : '账号已添加，正在抓取账号信息与最新动态…',
      )
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
            给「{vtuberName ?? '…'}」添加 bilibili / 微博 / 小红书账号；添加后自动抓取账号信息。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Select value={platform} onValueChange={setPlatform}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择平台" />
            </SelectTrigger>
            <SelectContent>
              {ACCOUNT_PLATFORMS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}（{PLATFORM_LABEL[p]}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            placeholder={UID_PLACEHOLDER[platform] ?? 'UID'}
            className="h-9 w-full border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          {isXhs && (
            <p
              className={`text-xs leading-relaxed ${uidUnparsed ? 'text-red-500' : 'text-muted-foreground'}`}
            >
              {uidUnparsed ? `没从这段文本里认出 uid —— ${XHS_UID_HINT}` : XHS_UID_HINT}
            </p>
          )}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="昵称（可选，留空由抓取回填）"
            className="h-9 w-full border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <div className="flex justify-end gap-2">
            {/* R21 批 3：页脚按钮统一浮片（见 UI-MAP §C2） */}
            <FloatPill size="md" shape="text" onClick={() => onOpenChange(false)}>
              取消
            </FloatPill>
            <FloatPill size="md" shape="text" active
                       disabled={adding || !finalUid} onClick={submit}>
              {adding ? <Loader2 className="size-4 animate-spin" /> : '添加'}
            </FloatPill>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
