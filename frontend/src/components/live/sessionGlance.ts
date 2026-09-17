/**
 * 场次速览胶囊（R36，devlog/140）—— 弹窗左列封面**下方**那张卡的内容口径。
 *
 * 用户口径（2026-09-17）：「红圈圈出来的区域在上游数据还没抓取下来的时候用一张卡片填充，
 * 不要空着，内容是几个展示不同信息的胶囊」+ 追问后定下：**只放四枚本地就有的值，分双行**
 * （2×2；上游迟到的那组「观看/点赞/打赏/互动」不进这张卡 —— 它们已经在右列「直播信息」
 * 里按行展示，卡片的职责只是把封面下方的空区域在**第一帧**就填满）。
 *
 * ## 为什么口径要单独抽出来
 *
 * 本仓 vitest 跑在 **node 环境**（无 jsdom / 无 testing-library）⇒ 组件渲染测不了，
 * 「卡里放哪四枚、缺值怎么写」这类**判断**必须落在纯函数上才有单测；渲染接线由探针
 * `ui_probe.py --archive` 的连采两格守（`?probe=archive` 会在弹窗打开后 120ms 采一格）。
 *
 * ⚠️ 依赖方向：`fmtDur` / `fmtMoney` 与它同目录（`components/live/`），不是从 `utils/` 反向引用组件。
 */
import type { LiveSession } from '../../api/types'
import { fmtDur, fmtMoney } from './liveCalendarFmt'

export interface GlanceCapsule {
  /** 稳定键（React key + 探针按 label 断言） */
  key: string
  label: string
  value: string
}

/** 四枚胶囊**恒定返回**（顺序 = 展示顺序，2×2 从左到右、从上到下）。
 *
 * 值缺失一律写 `—`（与右列「直播信息」其余行同款）：胶囊格数恒定是"高度不跳"的前提
 * —— 少一枚就少半行，弹窗会在数据到达时变矮。
 */
export function glanceCapsules(s: LiveSession): GlanceCapsule[] {
  const n = (v: number | null | undefined) =>
    v == null || v === 0 ? '—' : v.toLocaleString('zh-CN')
  return [
    { key: 'duration', label: '时长', value: fmtDur(s.duration_minutes) || '—' },
    { key: 'peak', label: '峰值在线', value: n(s.max_online_count) },
    { key: 'danmaku', label: '弹幕数', value: n(s.danmakus_count) },
    { key: 'income', label: '收益', value: fmtMoney(s.total_income) || '—' },
  ]
}
