/**
 * 启动失败分类与"迁移失败横幅"的判据（批次 16，devlog/207）。
 *
 * 这一组判据守的是**一句话**：只有 schema 迁移失败才允许说"数据可以找回"。
 * 误报的后果是用户去动数据目录（那才是真的丢数据），漏报的后果是他不知道能找回。
 * 所以两个方向都钉住（`backend-unreachable` 那条断言里**不许**出现"找回"字样）。
 */
import { describe, expect, it } from 'vitest'

import { classifyBootFailure, migrationNotice } from './bootFailure'

describe('classifyBootFailure', () => {
  it('迁移失败 ⇒ 明确说"数据没有丢"并给出可找回的两个位置', () => {
    const got = classifyBootFailure({
      ok: true,
      migration: {
        status: 'failed',
        error: 'OperationalError: disk I/O error',
        quarantined: 'C:/data/vtuber.db.failed-20260926-101010',
        backup: { path: 'C:/data/backups/vtuber-f007-20260926-101000.db' },
      },
    })
    expect(got.kind).toBe('migration-failed')
    expect(got.title).toContain('数据没有丢')
    expect(got.detail).toContain('vtuber.db.failed-20260926-101010')
    expect(got.detail).toContain('backups/vtuber-f007')
    // 后端应答过 ⇒ 可以取诊断包
    expect(got.canExportDiagnostics).toBe(true)
  })

  it('没有备份的迁移失败要**说出来**（不能让人以为有退路）', () => {
    const got = classifyBootFailure({
      migration: { status: 'failed', quarantined: '/d/x.db.failed-1', backup: { error: 'No space left' } },
    })
    expect(got.detail).toContain('没有')
    expect(got.detail).toContain('No space left')
  })

  it('后端没应答 ⇒ **不得**把它说成数据问题', () => {
    const got = classifyBootFailure(null, '[bootstrap] TypeError: …')
    expect(got.kind).toBe('backend-unreachable')
    expect(got.detail).toContain('不一定与数据有关')
    expect(got.detail).not.toContain('找回')          // ← 反向断言：不许引导用户去动数据
    expect(got.canExportDiagnostics).toBe(false)      // 后端都不可达，取不到诊断包
  })

  it('`/healthz` 说迁移正常 ⇒ 也按"后端不可达"处理（症状不能反过来当成数据问题）', () => {
    const got = classifyBootFailure({ ok: true, migration: { status: 'fast-path' } })
    expect(got.kind).toBe('backend-unreachable')
  })
})

describe('migrationNotice（应用内的非阻塞横幅）', () => {
  it('迁移失败 ⇒ 给一段带位置的说明', () => {
    const got = migrationNotice({
      status: 'failed', quarantined: '/d/vtuber.db.failed-1', backup: { path: '/d/backups/b.db' },
    })
    expect(got?.title).toContain('数据没有丢')
    expect(got?.detail).toContain('/d/vtuber.db.failed-1')
    expect(got?.detail).toContain('/d/backups/b.db')
  })

  it('一切正常 ⇒ 不显示（`null`）—— 别给常态启动加噪音', () => {
    expect(migrationNotice({ status: 'fast-path' })).toBeNull()
    expect(migrationNotice({ status: 'ok', backup: { path: '/d/b.db' } })).toBeNull()
    expect(migrationNotice(undefined)).toBeNull()
  })
})
