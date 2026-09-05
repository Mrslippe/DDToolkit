import { memo, useEffect, useState } from 'react'
import { Cake, CalendarDays, ChevronDown, Landmark, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { api } from '../api/api'
import type { Account, ThirdpartyVtuber, VTuber } from '../api/types'

interface Props {
  vtuber: VTuber
  account: Account | null
  thirdparty: ThirdpartyVtuber[]
}

/**
 * 档案卡（P5，2026-09-05 修订）：企划（可编辑，选项自动建议第三方索引企划名——
 * 语义沿革：阵营=企划=公会）/ 公会（只读占位，先放着）/ 生日 / 出道日 /
 * 房间号 / 设定集（可折叠）。
 */
const ProfileCard = memo(function ProfileCard({ vtuber, account, thirdparty }: Props) {
  const [settingOpen, setSettingOpen] = useState(false)
  const [savingFaction, setSavingFaction] = useState(false)
  const [faction, setFaction] = useState(vtuber.faction ?? '')

  // 账号/V 切换时同步外部状态（vtuber 引用随 refresh 变化）
  useEffect(() => setFaction(vtuber.faction ?? ''), [vtuber.faction])

  const groups = [...new Set(
    thirdparty.map((t) => t.group_name).filter((g): g is string => !!g),
  )]
  const factionOptions = [...new Set([...(faction ? [faction] : []), ...groups])]

  const handleFaction = async (value: string) => {
    const next = value === '__none__' ? '' : value
    if (next === faction) return
    setSavingFaction(true)
    setFaction(next) // 即时乐观更新
    try {
      await api.updateVtuber(vtuber.id, { faction: next || null })
    } catch (e) {
      setFaction(faction) // 失败回退
      toast.error(`企划更新失败: ${(e as Error).message}`)
    } finally {
      setSavingFaction(false)
    }
  }

  const rows: { icon: React.ReactNode; label: string; value: React.ReactNode }[] = [
    {
      icon: <Cake className="size-4" />,
      label: '生日',
      value: vtuber.birthday ?? <span className="muted">未记录</span>,
    },
    {
      icon: <CalendarDays className="size-4" />,
      label: '出道',
      value: vtuber.debut_date ?? <span className="muted">未记录</span>,
    },
    {
      icon: <Sparkles className="size-4" />,
      label: '房间',
      value: account?.room_id ?? <span className="muted">未记录</span>,
    },
  ]

  return (
    <div className="profile-card">
      {/* 企划 | 公会 两列（用户 2026-09-05 定稿：阵营=企划=公会，精简为两列——
          企划=可编辑（原 faction，未来接侧栏阵营图标位）；公会=只读占位（先放着）） */}
      <div className="profile-card-group-row">
        <div className="profile-card-group-col">
          <span className="profile-card-label">企划</span>
          <Select value={faction || '__none__'} onValueChange={handleFaction} disabled={savingFaction}>
            <SelectTrigger className="h-7 w-[180px] text-xs">
              <SelectValue placeholder="未设置" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">未设置</SelectItem>
              {factionOptions.map((f) => (
                <SelectItem key={f} value={f}>{f}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {groups.length > 0 && groups[0] !== faction && (
            <button
              type="button"
              className="float-pill float-pill--sm"
              title="从第三方索引采纳企划名"
              onClick={() => handleFaction(groups[0])}
            >
              采纳「{groups[0]}」
            </button>
          )}
        </div>
        <div className="profile-card-group-col">
          <span className="profile-card-label">公会</span>
          <span className="profile-card-value">
            <Landmark className="size-4" />
            <span className="muted">未收录</span>
          </span>
        </div>
      </div>

      {rows.map((r) => (
        <div key={r.label} className="profile-card-row">
          <span className="profile-card-label">{r.label}</span>
          <span className="profile-card-value">
            {r.icon} {r.value}
          </span>
        </div>
      ))}

      <Collapsible open={settingOpen} onOpenChange={setSettingOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 px-1 text-xs text-muted-foreground">
            设定集
            <ChevronDown className={`size-3.5 transition-transform ${settingOpen ? 'rotate-180' : ''}`} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <p className="profile-setting">
            {vtuber.setting || '未记录角色设定。'}
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
})

export default ProfileCard
