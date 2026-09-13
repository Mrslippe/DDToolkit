/**
 * 列表视图的工具条行（P2 分层收敛剩余项，2026-09-13，devlog/065）。
 *
 * 从 `pages/PostsPage.tsx` 整块搬出，**只搬不改**（同一份 JSX 与类名：`.header-actions`
 * / `.account-switch` / `.acc-switch-btn` / `.actions-toggle` / `.actions-extra`）。
 *
 * 归它管的三件事都只属于列表视图：切换平台账号、展开/收起操作组、四个抓取/管理动作。
 * 卡片与档案视图各自有内部账号切换，所以这一行在场景容器**之外**（工具条常驻区）。
 */
import { ChevronsLeft, RefreshCw, Trash2, UserPlus, Zap } from 'lucide-react'

import type { Account } from '../../api/types'
import { PLATFORM_LABEL } from '../../utils/postTypes'
import FloatPill from '../common/FloatPill'

interface Props {
  accounts: Account[]
  /** 当前选中账号 id（高亮用）；未选中时 null */
  selectedAccountId: number | null
  /** 切账号（父级负责 setSelectedAccount + 回第 1 页） */
  onSelectAccount: (a: Account) => void
  actionsOpen: boolean
  onToggleActions: () => void
  /** 动作按钮禁用：本地动作在途 ∥ 全局有抓取任务 */
  fetching: boolean
  fetchBusy: boolean
  /** 禁用时的统一提示（`busyTip`） */
  busyTip: string
  onFetchAccount: () => void
  /** 「抓取帖子」→ 打开范围选择弹窗（不是直接抓） */
  onOpenFetchChoice: () => void
  onAddAccount: () => void
  onDelete: () => void
  onUpdatePosts: () => void
}

export default function ListHeaderActions({
  accounts,
  selectedAccountId,
  onSelectAccount,
  actionsOpen,
  onToggleActions,
  fetching,
  fetchBusy,
  busyTip,
  onFetchAccount,
  onOpenFetchChoice,
  onAddAccount,
  onDelete,
  onUpdatePosts,
}: Props) {
  return (
    <div className="header-actions">
      <div className="account-switch">
        {accounts.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`acc-switch-btn${selectedAccountId === a.id ? ' on' : ''}`}
            title={`${a.platform} ${a.platform_uid}`}
            onClick={() => onSelectAccount(a)}
          >
            <span className="acc-switch-platform">{PLATFORM_LABEL[a.platform] ?? a.platform}</span>
            <span className="acc-switch-name">{a.display_name || a.platform_uid}</span>
          </button>
        ))}
      </div>
      <FloatPill
        size="md"
        shape="icon"
        className={`actions-toggle${actionsOpen ? ' open' : ''}`}
        title={actionsOpen ? '收起操作' : '展开操作'}
        aria-expanded={actionsOpen}
        onClick={onToggleActions}
      >
        <ChevronsLeft className="size-4" />
      </FloatPill>
      <div className={`actions-extra${actionsOpen ? ' open' : ''}`}>
        <FloatPill
          size="md"
          shape="text"
          disabled={fetching || fetchBusy}
          title={busyTip}
          onClick={onFetchAccount}
        >
          <Zap className="size-4" /> 抓取账号
        </FloatPill>
        <FloatPill
          size="md"
          shape="text"
          disabled={fetching || fetchBusy}
          title={busyTip}
          onClick={onOpenFetchChoice}
        >
          <RefreshCw className="size-4" /> 抓取帖子
        </FloatPill>
        <FloatPill size="md" shape="text" onClick={onAddAccount}>
          <UserPlus className="size-4" /> 添加账号
        </FloatPill>
        <FloatPill
          size="md"
          shape="text"
          danger
          onClick={onDelete}
        >
          <Trash2 className="size-4" /> 解除订阅
        </FloatPill>
      </div>
      <FloatPill
        size="md"
        shape="text"
        active
        disabled={fetching || fetchBusy}
        title={busyTip}
        onClick={onUpdatePosts}
      >
        <RefreshCw className="size-4" /> 更新动态
      </FloatPill>
    </div>
  )
}
