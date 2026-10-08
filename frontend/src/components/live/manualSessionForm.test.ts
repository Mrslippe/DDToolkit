/**
 * 手动记录/编辑场次表单的纯逻辑判据（B2，devlog/454）。
 *
 * ⚠️ 时间相关的用例一律**用本地分量构造 Date**（`new Date(2026, 9, 8, 20, 30)`）再喂进去，
 * 不写死 `+08:00` —— 否则在别的时区的机器上会红（而这条逻辑本身是对的）。
 * "服务端把不带时区的时间当本地时间"这条规矩在 `tests/test_live_manual.py`
 * （注入 +08:00，与时区无关）里守。
 */
import { describe, expect, it } from 'vitest'

import type { LiveSession } from '../../api/types'
import {
  buildManualPatch, canSubmitNew, defaultManualRange, formFromSession,
  fromLocalInput, hasChanges, toLocalInput, vodLabel,
} from './manualSessionForm'

/** 本地墙上时间 → ISO（用本地分量构造，所以断言与时区无关） */
const iso = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi).toISOString()

describe('toLocalInput / fromLocalInput', () => {
  it('ISO → 本地墙上时间（datetime-local 的 value）', () => {
    expect(toLocalInput(iso(2026, 10, 8, 20, 30))).toBe('2026-10-08T20:30')
    // 分钟补零（否则 20:05 会变成 20:5 —— 输入框直接拒收这个值）
    expect(toLocalInput(iso(2026, 10, 8, 20, 5))).toBe('2026-10-08T20:05')
  })

  it('空值与非法值 → 空串（输入框留空，不抛错、也不显示 Invalid Date）', () => {
    expect(toLocalInput(null)).toBe('')
    expect(toLocalInput(undefined)).toBe('')
    expect(toLocalInput('')).toBe('')
    expect(toLocalInput('不是时间')).toBe('')
  })

  it('往返稳定：本地分量 → ISO → 回本地字符串，逐个字段相等', () => {
    const back = toLocalInput(iso(2026, 1, 2, 3, 4))
    expect(back).toBe('2026-01-02T03:04')
  })

  it('fromLocalInput：空串 = 没有这个时间（null），其余原样', () => {
    expect(fromLocalInput('')).toBeNull()
    expect(fromLocalInput('   ')).toBeNull()
    expect(fromLocalInput('2026-10-08T20:30')).toBe('2026-10-08T20:30')
  })
})

describe('defaultManualRange', () => {
  it('默认今天 20:00–22:00（本地），与"现在几点"无关', () => {
    expect(defaultManualRange(new Date(2026, 9, 8, 9, 15)))
      .toEqual({ start: '2026-10-08T20:00', end: '2026-10-08T22:00' })
    // 深夜（23:40）也还是**当天** 20:00 起 —— 不滚动到次日（补的是已播过的那一场）
    expect(defaultManualRange(new Date(2026, 9, 8, 23, 40)).start).toBe('2026-10-08T20:00')
  })
})

describe('formFromSession', () => {
  const s = {
    account_id: 1, start_at: iso(2026, 10, 8, 20, 0), end_at: iso(2026, 10, 8, 22, 0),
    duration_minutes: 120, live_title: '歌回',
    vod_url: 'https://www.bilibili.com/video/BV1xx411c7mD', manual: true,
  } as LiveSession

  it('编辑初值 = 本地墙上时间 + 原标题/录播地址', () => {
    expect(formFromSession(s)).toEqual({
      title: '歌回', start: '2026-10-08T20:00', end: '2026-10-08T22:00',
      vod: 'https://www.bilibili.com/video/BV1xx411c7mD',
    })
  })

  it('进行中（end_at=null）→ 结束时间留空；无标题/无录播 → 空串', () => {
    const live = {
      ...s, end_at: null, live_title: null, vod_url: null,
    } as LiveSession
    expect(formFromSession(live)).toEqual({ title: '', start: '2026-10-08T20:00', end: '', vod: '' })
  })
})

describe('buildManualPatch', () => {
  const orig = { title: '歌回', start: '2026-10-08T20:00', end: '2026-10-08T22:00', vod: '' }

  it('没有改动 → 空请求体（服务端空 patch 是 422，别白跑）', () => {
    expect(buildManualPatch(orig, { ...orig })).toEqual({})
    expect(hasChanges(orig, { ...orig })).toBe(false)
  })

  it('只放**改过**的字段（改标题不会顺手把结束时间也提交上去）', () => {
    const patch = buildManualPatch(orig, { ...orig, title: ' 深夜歌回 ' })
    expect(patch).toEqual({ title: '深夜歌回' })          // 顺带清掉首尾空白
    expect('end_at' in patch).toBe(false)
    expect(hasChanges(orig, { ...orig, title: '深夜歌回' })).toBe(true)
  })

  it('清空结束时间 → end_at: null（服务端认它 = 改回"进行中"）', () => {
    expect(buildManualPatch(orig, { ...orig, end: '' })).toEqual({ end_at: null })
  })

  it('清空录播地址 → vod_url: ""（与"没传"区分开：服务端认空串 = 清空）', () => {
    const withVod = { ...orig, vod: 'BV1xx411c7mD' }
    expect(buildManualPatch(withVod, { ...withVod, vod: '  ' })).toEqual({ vod_url: '' })
    // 只加不改：填上地址就提交地址
    expect(buildManualPatch(orig, { ...orig, vod: ' BV1xx411c7mD ' }))
      .toEqual({ vod_url: 'BV1xx411c7mD' })
  })

  it('四项一起改 → 四项都在（且结束时间的空串变成 null）', () => {
    expect(buildManualPatch(orig, {
      title: '新的', start: '2026-10-09T19:00', end: '', vod: 'BV1xx411c7mD',
    })).toEqual({
      title: '新的', start_at: '2026-10-09T19:00', end_at: null, vod_url: 'BV1xx411c7mD',
    })
  })
})

describe('canSubmitNew / vodLabel', () => {
  it('新建：有开始时间就能存（结束时间可空 = 进行中）', () => {
    expect(canSubmitNew({ title: '', start: '2026-10-08T20:00', end: '', vod: '' })).toBe(true)
    expect(canSubmitNew({ title: '歌回', start: '', end: '', vod: '' })).toBe(false)
    expect(canSubmitNew({ title: '', start: '   ', end: '', vod: '' })).toBe(false)
  })

  it('录播链接显示 BV 号；认不出来退通用文案（绝不因此变成点不动）', () => {
    expect(vodLabel('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('BV1xx411c7mD')
    expect(vodLabel('https://www.bilibili.com/video/BV1xx411c7mD?p=3')).toBe('BV1xx411c7mD')
    expect(vodLabel(null)).toBe('打开录播')
    expect(vodLabel('https://www.bilibili.com/video/av123')).toBe('打开录播')
  })
})
