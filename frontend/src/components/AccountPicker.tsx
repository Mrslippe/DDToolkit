import { memo } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Account } from '../api/types'

const PLATFORM_LABEL: Record<string, string> = { bilibili: 'B站', weibo: '微博' }

interface Props {
  accounts: Account[]
  value: Account | null
  onChange: (acc: Account) => void
}

/**
 * 档案卡片内部账号切换器（P5）：单账号时不渲染；
 * 多个账号显示紧凑 Select（平台 + 昵称/uid）。
 * 2026-09-07 二级界面审查 C9：触发器改浮片族样式（与 list 视图 .acc-switch-btn
 * 同款：白卡 + 2px 圆角 + --pill-shadow + 去发丝边），选中/激活态语义一致。
 */
const AccountPicker = memo(function AccountPicker({ accounts, value, onChange }: Props) {
  if (accounts.length <= 1) return null
  return (
    <Select
      value={value ? String(value.id) : ''}
      onValueChange={(id) => {
        const acc = accounts.find((a) => String(a.id) === id)
        if (acc) onChange(acc)
      }}
    >
      <SelectTrigger className="h-[30px] w-[150px] rounded-[2px] border-none bg-[var(--c-bg-card)] px-2.5 text-xs text-[rgba(30,30,30,0.72)] shadow-[var(--pill-shadow)] transition-[background,box-shadow] hover:bg-[var(--pill-bg-hover)] focus-visible:ring-0 [&_svg]:text-muted-foreground">
        <SelectValue placeholder="切换账号" />
      </SelectTrigger>
      <SelectContent>
        {accounts.map((a) => (
          <SelectItem key={a.id} value={String(a.id)}>
            {PLATFORM_LABEL[a.platform] ?? a.platform} · {a.display_name || a.platform_uid}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
})

export default AccountPicker
