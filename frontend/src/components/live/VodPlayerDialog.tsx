/**
 * 录播播放器（2026-10-13，用户 3.2：封面上的 ▶ 打开它）。
 *
 * ## 就是一个播放面，别的都不做
 *
 * 取流/清晰度/分P/MSE/镜像链全在 `BiliVideo` + `VideoPlayer` 里（那条链路是帖子播放
 * 用了几个月的那一套）—— 这里只负责：**把 bvid 喂进去**、给一个够大的面板、
 * 以及一条"在浏览器打开"的退路（播放器在真机上偶有播不动的情况，别让用户没有出路）。
 *
 * ## 为什么不用 `postId` 那条路
 *
 * 录播不是帖子：`live_sessions.vod_url` 指向的多半是录播组发的视频，库里没有那条 post。
 * 所以这一批加了 `/bili/play-by-bvid`（`devlog/479`），`BiliVideo` 也多了一个 `bvid` 入口。
 *
 * ## 分 P
 *
 * `vod_url` 里可能带 `?p=3`（`normalize_vod` 原样留着）⇒ 传 `initialPage`，
 * 否则多 P 录播只会播第一段（本仓在帖子播放上修过一次同类 bug，`devlog/329`）。
 */
import { useEffect } from 'react'
import { ExternalLink, X } from 'lucide-react'

import type { LiveSession } from '../../api/types'
import BiliVideo from '../BiliVideo'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { openExternal } from '../../utils/shellBridge'
import { vodLabel, vodTarget } from './manualSessionForm'

interface Props {
  open: boolean
  /** 要播的那一场（`vod_url` 必须有 BV 号） */
  session: LiveSession | null
  onClose: () => void
}

export default function VodPlayerDialog({ open, session, onClose }: Props) {
  const target = vodTarget(session?.vod_url)
  const url = session?.vod_url ?? ''

  // 没有可播的地址就别开着（父组件按"有没有 vod_url"决定开不开，这里只是兜底）
  useEffect(() => {
    if (open && !target) onClose()
  }, [open, target, onClose])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="vodp p-0 gap-0" overlayClassName="lc-dlg-backdrop"
                     showCloseButton={false}>
        <div className="vodp-head">
          <DialogTitle className="vodp-title">
            {session?.live_title || '录播'}
          </DialogTitle>
          <span className="vodp-sub">{vodLabel(url)}</span>
          <span className="vodp-spacer" />
          {/* 退路：真机上偶有播不动（风控/权益/内核），别让用户没有出路 */}
          <button type="button" className="vodp-lnk" data-vod-open-external="1"
                  title={url}
                  onClick={() => void openExternal(url)}>
            <ExternalLink className="size-3.5" aria-hidden />
            在浏览器打开
          </button>
          <button type="button" className="vodp-close" aria-label="关闭" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        <div className="vodp-body">
          {target && (
            <BiliVideo
              key={target.bvid}
              bvid={target.bvid}
              initialPage={target.page}
              poster={session?.cover_url ?? null}
              permalink={url}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
