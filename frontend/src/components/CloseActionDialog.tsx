import { useEffect, useState } from 'react'
import { LogOut, Minimize2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export type CloseChoice = 'tray' | 'quit'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 用户选了一个动作；`remember` = 勾了「记住我的选择」 */
  onChoose: (choice: CloseChoice, remember: boolean) => void
  /** 有手动任务在跑（退出会中断本轮）——用于在选项上写明后果 */
  busy?: boolean
}

/**
 * 首次点 ✕ 的询问框（R18，devlog/095）。
 *
 * 用户口径（2026-09-15）：「首次问一次，之后按选择记住」。所以这个框只在
 * `prefs.close_action === 'ask'` 时出现，选完把选择写进偏好（勾了「记住」才写）。
 *
 * 两条设计取舍：
 * 1. **两个选项都写清后果**，"最小化到托盘"要说明后台仍在抓、界面不再刷新 ——
 *    否则用户会以为"关了就不抓了"或者"关了还在偷偷跑"。
 * 2. **退出选项在有任务运行时标红**（"正在抓取，退出会中断本轮"）——退出是破坏性动作，
 *    托盘那条随时可逆，两条不该长得一样。
 */
export default function CloseActionDialog({ open, onOpenChange, onChoose, busy }: Props) {
  const [remember, setRemember] = useState(true)

  // 每次打开都回到默认勾选（记住选择），避免上次取消勾选后一直问
  useEffect(() => {
    if (open) setRemember(true)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="close-ask" data-testid="close-ask-dialog">
        <DialogHeader>
          <DialogTitle>关闭窗口时</DialogTitle>
          <DialogDescription>
            窗口可以隐藏到系统托盘：界面不再刷新，但后台抓取照常进行，点托盘图标即可唤回。
          </DialogDescription>
        </DialogHeader>

        <div className="close-ask-opts">
          <button
            type="button"
            className="close-ask-opt"
            data-choice="tray"
            onClick={() => onChoose('tray', remember)}
          >
            <Minimize2 className="size-[15px]" />
            <span className="close-ask-main">
              <span className="close-ask-title">最小化到托盘</span>
              <span className="close-ask-note">
                后台继续抓取 · 界面停止刷新与轮询 · 隐藏 10 分钟后释放界面内存
              </span>
            </span>
          </button>
          <button
            type="button"
            className={`close-ask-opt${busy ? ' danger' : ''}`}
            data-choice="quit"
            onClick={() => onChoose('quit', remember)}
          >
            <LogOut className="size-[15px]" />
            <span className="close-ask-main">
              <span className="close-ask-title">退出程序</span>
              <span className="close-ask-note">
                {busy ? '正在抓取 —— 退出会中断本轮任务' : '结束进程，不再抓取'}
              </span>
            </span>
          </button>
        </div>

        <label className="close-ask-remember">
          <input
            type="checkbox"
            checked={remember}
            data-testid="close-ask-remember"
            onChange={(e) => setRemember(e.target.checked)}
          />
          记住我的选择（之后可在「设置 → 外观」里改）
        </label>

        <div className="close-ask-foot">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
