/**
 * 问题报告面板（2026-10-02，devlog/279）：**面向用户**的报错出口。
 *
 * 取代原来的「启动诊断」红色面板（`bootDiag` 里那块 DOM）：那块东西压右上角挡界面、
 * 标题与内容都是开发者语言（`[promise] Promise shell:allow-open not allowed…`），
 * 也没有版本/环境/提交入口 —— 用户只能截图。
 *
 * 现在的形态（用户 2026-10-02 定）：
 * - **右下角**、默认只有一条细条，不遮挡界面；点「查看」才展开；
 * - 展开后：人话标题 + 每条错误（去哪、发生几次、细节）+「我当时在做什么」输入框；
 * - 动作：**复制报告**（markdown，可直接粘进 issue）/ **提 issue**（预填标题正文）/
 *   按需附上诊断包（`GET /settings/diagnostics`，既有入口，不另造一份）；
 * - 全部忽略 = 清空（不看就不再打扰），退出应用自然清空（不落库）。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, Copy, ExternalLink, X } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../api/api'
import { openExternal } from '../utils/shellBridge'
import {
  buildReportMarkdown, clearReports, dismissReport, fmtWhen, issueUrl,
  reportEntries, reportEnv, reportTitle, subscribeReport, type ReportEntry,
} from '../utils/problemReport'

function Row({ r, onDismiss }: { r: ReportEntry; onDismiss: () => void }) {
  return (
    <li className="pr-row">
      <div className="pr-row-head">
        <span className="pr-where">{r.where}</span>
        {r.count > 1 && <span className="pr-count">×{r.count}</span>}
        <span className="pr-when">{fmtWhen(r.at)}</span>
        <button type="button" className="pr-x" title="忽略这一条" onClick={onDismiss}>
          <X className="size-3" />
        </button>
      </div>
      <pre className="pr-detail">{r.detail}</pre>
    </li>
  )
}

export default function ProblemPanel() {
  const rows = useSyncExternalStore(subscribeReport, reportEntries)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [withBundle, setWithBundle] = useState(false)

  // `__bootFold`（React 就绪后由 main.tsx 调）⇒ 收起面板：出错时露出来，之后不占地方
  useEffect(() => {
    const fold = () => setOpen(false)
    window.addEventListener('ddtoolkit:fold-problem-panel', fold)
    return () => window.removeEventListener('ddtoolkit:fold-problem-panel', fold)
  }, [])

  const reportable = rows.filter((r) => r.reportable)
  if (reportable.length === 0) return null

  const top = reportable[reportable.length - 1]

  /** 组装报告（可选附诊断包；诊断包拿不到就如实说明，不假装成功） */
  const makeMarkdown = async (): Promise<string> => {
    let bundle: { filename: string; text: string } | null = null
    if (withBundle) {
      try {
        const d = await api.getDiagnostics()
        bundle = { filename: d.filename, text: d.text }
      } catch (e) {
        bundle = {
          filename: '（取不到）',
          text: `诊断包获取失败：${(e as Error)?.message || String(e)}`,
        }
      }
    }
    return buildReportMarkdown({
      entries: rows,
      // 路由现取（用户可能已经切过视图；env 里的那份是启动时的）
      env: { ...reportEnv(), route: window.location.pathname },
      note,
      trail: window.__bootTrail?.(),
      bundle,
    })
  }

  const copy = async () => {
    try {
      const md = await makeMarkdown()
      await navigator.clipboard.writeText(md)
      toast.success('报告已复制，粘到 issue 或聊天里即可')
    } catch (e) {
      toast.error(`复制失败：${(e as Error)?.message || String(e)}`)
    }
  }

  const openIssue = async () => {
    try {
      const md = await makeMarkdown()
      await openExternal(issueUrl(md, reportTitle({
        entries: rows, env: { ...reportEnv(), route: window.location.pathname },
      })))
    } catch (e) {
      toast.error(`打不开 issue 页：${(e as Error)?.message || String(e)}`)
    }
  }

  return (
    <div className={`problem-report${open ? ' is-open' : ''}`} id="problem-report">
      <div className="pr-bar">
        <AlertTriangle className="size-4 shrink-0" />
        <span className="pr-title">
          出了点问题{reportable.length > 1 ? `（${reportable.length} 类）` : ''}
        </span>
        <span className="pr-hint" title={top.detail}>
          {top.where}
        </span>
        <button type="button" className="pr-btn" onClick={() => setOpen((v) => !v)}>
          {open ? <>收起 <ChevronDown className="size-3" /></> : <>查看 <ChevronUp className="size-3" /></>}
        </button>
        <button type="button" className="pr-btn" title="全部忽略（不再提示）"
                onClick={() => { clearReports(); setOpen(false) }}>
          忽略
        </button>
      </div>

      {open && (
        <div className="pr-body">
          <p className="pr-lead">
            这些是应用内部的错误提示，不影响你已有的数据。把它们发给我能直接定位问题 ——
            点「复制报告」粘到聊天里，或点「提 issue」。
          </p>
          <ul className="pr-list">
            {rows.map((r) => (
              <Row key={r.id} r={r} onDismiss={() => dismissReport(r.id)} />
            ))}
          </ul>
          <label className="pr-field">
            <span>我当时在做什么（可选，但很有用）</span>
            <textarea value={note} rows={2} placeholder="例：点帖子详情里的「查看原文」"
                      onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className="pr-check">
            <input type="checkbox" checked={withBundle}
                   onChange={(e) => setWithBundle(e.target.checked)} />
            <span>附上诊断包（版本/系统/日志尾部，较大但更有用）</span>
          </label>
          <div className="pr-actions">
            <button type="button" className="pr-btn pr-btn--primary" onClick={() => void copy()}>
              <Copy className="size-3.5" /> 复制报告
            </button>
            <button type="button" className="pr-btn" onClick={() => void openIssue()}>
              <ExternalLink className="size-3.5" /> 提 issue
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
