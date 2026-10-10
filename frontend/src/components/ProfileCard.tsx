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
import { vtuberGroup } from '../utils/groupBadge'
import FloatPill from './common/FloatPill'

interface Props {
  vtuber: VTuber
  account: Account | null
  thirdparty: ThirdpartyVtuber[]
}

/**
 * 档案卡（P5，2026-09-05 修订）：企划（可编辑，选项自动建议第三方索引企划名——
 * 语义沿革：阵营=企划=公会）/ 公会（只读占位，先放着）/ 生日 / 出道日 /
 * 房间号 / 设定集（可折叠）。
 *
 * ⚠️ **2026-10-10 修**（自审 F1，`devlog/461`）：企划格原先是**同一屏里的第四处**独立读点 ——
 * 它只读手填的 `faction`，而左栏徽章与筛选早就统一到 `vtuberGroup()`（手填优先 → 否则自动
 * `group_name`）。真机 14 个 V 里有 **7 个**只有自动企划 ⇒ 左栏明明写着「四禧丸子」，
 * 档案卡却写「未设置」（`458` 修了侧栏三处、漏了这处 —— 同一个 bug 的另一半）。
 *
 * 现在的取舍（用户 2026-10-10 拍板）：**显示生效值**（自动时标「（自动）」），
 * 写路径仍然只写 `faction` —— 于是"手填"始终是那唯一一份可编辑的东西，
 * 而"清空手填"**不会**让值消失（自动那份还在），这句话由下面那行小字说明。
 */
const ProfileCard = memo(function ProfileCard({ vtuber, account, thirdparty }: Props) {
  const [settingOpen, setSettingOpen] = useState(false)
  const [savingFaction, setSavingFaction] = useState(false)
  const [faction, setFaction] = useState(vtuber.faction ?? '')

  // 账号/V 切换时同步外部状态（vtuber 引用随 refresh 变化）
  useEffect(() => setFaction(vtuber.faction ?? ''), [vtuber.faction])

  // 显示值：手填优先（含刚写完的乐观值），否则落回**唯一真源** `vtuberGroup()`。
  // ⚠️ 不能只写 `vtuberGroup(vtuber)` —— 那是 props 上的旧值，乐观更新后 Select 不会动。
  const manual = faction.trim()
  const effective = manual || vtuberGroup(vtuber) || ''
  const isAuto = !manual && !!effective

  // 第三方索引里的企划名：**建议**用，与显示值相同时不值得再点一下
  const suggestions = [...new Set(
    thirdparty.map((t) => t.group_name).filter((g): g is string => !!g),
  )]
  const suggestion = suggestions[0]
  const options = [...new Set([manual, vtuberGroup(vtuber) || '', ...suggestions]
    .filter((g): g is string => !!g))]
  // 「采纳」= 把建议**固化成手填值**（此后它不再随候选人池刷新而变）
  const showAdopt = !!suggestion && suggestion !== effective

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
          <Select value={effective || '__none__'} onValueChange={handleFaction} disabled={savingFaction}>
            <SelectTrigger className="h-7 w-[180px] text-xs">
              <SelectValue placeholder="未设置" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">未设置</SelectItem>
              {options.map((f) => (
                <SelectItem key={f} value={f}>
                  {f === effective && isAuto ? `${f}（自动）` : f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {showAdopt && (
            <FloatPill size="sm" title="把第三方索引里的企划名写进手填值（此后不再随池子刷新而变）"
                       onClick={() => handleFaction(suggestion)}>
              采纳「{suggestion}」
            </FloatPill>
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

      {isAuto && (
        <p className="profile-card-group-hint">
          「（自动）」来自候选人池的检测结果；清空手填不会让它消失，选中该值即可固化为手填
        </p>
      )}

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
