// @vitest-environment jsdom
/**
 * 问题报告（devlog/279）：**判定 → 去重 → 脱敏 → 生成报告**这套纯逻辑的判据。
 *
 * 为什么这些必须机器判：报告会被用户**粘到公开 issue 上**（脱敏错了就是把 cookie 送出去），
 * 而"同一错误反复发生"必须收敛成一条（否则面板会被刷屏，用户第一反应是关掉它）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  RESOURCE_REPORT_AT, buildReportMarkdown, clearReports, issueUrl, redact, reportEntries,
  reportEnv, reportFromBootLine, reportResourceFailure, reportTitle, reportUserError,
  resourceHost, setReportEnv, subscribeReport,
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

  it('资源失败按**主机**归并、到阈值才报（一页十几张过期图不该变成十几条报告）', () => {
    // 真事故（devlog/318）：小红书笔记详情里 7 张签名过期的图，每张走"直连失败 → 代理失败"
    // 两级 = 14 次 —— 旧实现用**全局**计数、且每条都拼上完整 URL（永远去重不了）
    // ⇒ 弹出一份 14 条 `[resource]` 的报告，计数还是 51…64 这种看不出所以然的序数。
    const a = 'http://sns-webpic-qc.xhscdn.com/t/1/notes_pre_post/a!nd_dft_wlteh_webp_3'
    const b = 'http://sns-webpic-qc.xhscdn.com/t/1/notes_pre_post/b!nd_dft_wlteh_webp_3'
    const p = 'http://127.0.0.1:49997/img-proxy?url=http%3A%2F%2Fsns-webpic-qc.xhscdn.com%2Fa'

    expect(resourceHost(a)).toBe('sns-webpic-qc.xhscdn.com')
    // 同一主机：前两次只记账
    reportResourceFailure(a, 1)
    reportResourceFailure(b, 2)
    expect(reportEntries(), '没到阈值不该有条目').toHaveLength(0)
    // 第三次：报一条，**detail 只有主机名**（下次同一主机还会命中同一条）
    reportResourceFailure(a, RESOURCE_REPORT_AT)
    let rows = reportEntries()
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toBe('sns-webpic-qc.xhscdn.com')
    expect(rows[0].reportable, '系统性资源故障要惊动用户').toBe(true)
    // 第四个主机各算各的（代理那条是另一个主机）
    reportResourceFailure(p, 1)
    reportResourceFailure(p, 2)
    reportResourceFailure(p, 3)
    rows = reportEntries()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.detail)).toContain('127.0.0.1:49997')
    // 同主机的后续失败不再新增条目（报告里一行就够，逐条 URL 在启动时间线里）
    reportResourceFailure(a, RESOURCE_REPORT_AT + 1)
    expect(reportEntries()).toHaveLength(2)
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
