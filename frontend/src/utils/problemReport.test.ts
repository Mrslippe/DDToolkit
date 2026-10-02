// @vitest-environment jsdom
/**
 * 问题报告（devlog/279）：**判定 → 去重 → 脱敏 → 生成报告**这套纯逻辑的判据。
 *
 * 为什么这些必须机器判：报告会被用户**粘到公开 issue 上**（脱敏错了就是把 cookie 送出去），
 * 而"同一错误反复发生"必须收敛成一条（否则面板会被刷屏，用户第一反应是关掉它）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildReportMarkdown, clearReports, issueUrl, redact, reportEntries, reportEnv,
  reportFromBootLine, reportTitle, reportUserError, setReportEnv, subscribeReport,
} from './problemReport'

beforeEach(() => {
  clearReports()
  setReportEnv({ version: '9.9.9', route: '/vtubers/14', view: 'cards' })
})

describe('脱敏', () => {
  it('cookie / token / 签名头一律打码', () => {
    const raw = 'cookie: web_session=abc123; a1=1900abcdef; SESSDATA=deadbeef; '
      + 'Authorization: Bearer eyJhbGciOi.JIUzI1NiJ9.xxx\nx-s: XYS_2UQhPsHCH0c1PUhMHjIj2erj'
    const out = redact(raw)
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('1900abcdef')
    expect(out).not.toContain('deadbeef')
    expect(out).not.toContain('XYS_2UQhPsHCH0c1PUhMHjIj2erj')
    expect(out).toContain('***')
  })

  it('长 base64url 形状（xsec_token 这类）也打掉', () => {
    const out = redact('xsec_token=ABjbrMETExJ2utmuHaLjQpOIP7Fr5biOkH-1AEDmn1DWk%3D '
      + 'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop')
    expect(out).not.toContain('ABjbrMETExJ2utmuHaLjQpOIP7Fr5biOkH')
    expect(out).not.toContain('eyJzdWIiOiIxIn0')
  })

  it('Windows 路径**不打码**（那是排查要用的东西）', () => {
    const p = 'C:/Users/zx/AppData/Roaming/com.ddtoolkit.app/ddtoolkit-diagnostics-20261002-213155.txt'
    expect(redact(p)).toContain(p)
  })
})

describe('去重与分级', () => {
  it('同一错误只占一条，计数递增', () => {
    reportUserError('打开链接', '这个主机不在允许打开的名单里：evil.com')
    reportUserError('打开链接', '这个主机不在允许打开的名单里：evil.com')
    const rows = reportEntries()
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(2)
  })

  it('资源类抖动只记账、不惊动用户（reportable=false）', () => {
    reportFromBootLine('[resource] https://i0.hdslb.com/x.jpg')
    const rows = reportEntries()
    expect(rows).toHaveLength(1)
    expect(rows[0].reportable).toBe(false)
  })

  it('Promise 拒绝会惊动用户（"查看原文"那次就是这条）', () => {
    reportFromBootLine('[promise] Promise shell:allow-open not allowed. Permissions associated…')
    const rows = reportEntries()
    expect(rows[0].reportable).toBe(true)
    expect(rows[0].kind).toBe('promise')
    expect(rows[0].where).toBe('未处理的异步错误')
  })

  it('订阅者收到通知（面板据此重渲染）', () => {
    let hits = 0
    const off = subscribeReport(() => { hits += 1 })
    reportUserError('打开链接', 'boom')
    off()
    expect(hits).toBe(1)
    expect(reportEntries()[0].detail).toBe('boom')   // 快照引用稳定且带内容
  })
})

describe('报告与 issue 链接', () => {
  it('报告带版本/界面/环境/用户描述，且**不含**明文凭据', () => {
    reportUserError('打开链接失败', '这个主机不在允许打开的名单里：evil.com\n'
      + 'https://evil.com/?web_session=SECRETVALUE')
    const md = buildReportMarkdown({
      entries: reportEntries(),
      env: reportEnv(),
      note: '点帖子详情的查看原文',
      trail: ['12:00:01 [perf] React 挂载完成 +39ms'],
    })
    expect(md).toContain('9.9.9')                    // 版本
    expect(md).toContain('/vtubers/14')              // 当前界面
    expect(md).toContain('点帖子详情的查看原文')        // 用户描述
    expect(md).toContain('React 挂载完成')            // 启动时间线
    expect(md).not.toContain('SECRETVALUE')
  })

  it('issue 链接预填标题与正文（正文过长会截断并标注）', () => {
    const long = 'x'.repeat(9000)
    const url = issueUrl(long, '标题')
    expect(url.startsWith('https://github.com/Mrslippe/DDToolkit/issues/new?')).toBe(true)
    expect(url).toContain('title=')
    expect(url).toContain('%E6%88%AA%E6%96%AD')       // "截断"
    expect(url.length).toBeLessThan(12000)
  })

  it('标题取第一条错误的"位置 + 首行"', () => {
    reportUserError('打开链接失败', '这个主机不在允许打开的名单里\n第二行')
    expect(reportTitle({ entries: reportEntries(), env: reportEnv() }))
      .toBe('[报错] 打开链接失败：这个主机不在允许打开的名单里')
  })
})
