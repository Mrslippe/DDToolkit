/**
 * 日期区间纯逻辑回归（`frontend/src/utils/dateRange.ts`，P10-A）。
 *
 * 为什么单独有这一支：前端没有测试运行器，而日期算术（预设量纲 / 月位移夹取 /
 * 本地零点解析 / 6×7 网格）恰恰是最容易错、最该被机器验证的部分。Node 24 自带
 * 类型擦除，可直接 import 那个 `.ts`（**必须带 `.ts` 后缀**）。
 *
 * 用法：`node scripts/check_date_range.mjs`（任意工作目录；路径按脚本自身解析）
 * 约定：退出码 0 = 全过，1 = 有断言失败（可直接接进任何 gate）
 */
const {
  fmtDate,
  parseDate,
  shiftMonths,
  presetRange,
  matchPreset,
  rangeText,
  monthGrid,
  EMPTY_RANGE,
  RANGE_PRESETS,
  HOURS,
  MINUTES,
  splitLocal,
  joinLocal,
  fmtLocalHuman,
} = await import(new URL('../frontend/src/utils/dateRange.ts', import.meta.url))

let failed = 0
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} → ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}

// ── 基准「今天」= 2026-09-10（与参考图同一天，便于对照）──
const T = (s) => new Date(...s.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))))
const base = T('2026-09-10')

eq('近一周', presetRange(RANGE_PRESETS[0], base), { from: '2026-09-04', to: '2026-09-10' })
eq('近一月', presetRange(RANGE_PRESETS[1], base), { from: '2026-08-10', to: '2026-09-10' })
eq('近三月', presetRange(RANGE_PRESETS[2], base), { from: '2026-06-10', to: '2026-09-10' })
eq('近一年', presetRange(RANGE_PRESETS[3], base), { from: '2025-09-10', to: '2026-09-10' })
eq('近两年', presetRange(RANGE_PRESETS[4], base), { from: '2024-09-10', to: '2026-09-10' })
eq('所有=清空', presetRange(RANGE_PRESETS[5], base), EMPTY_RANGE)

// ── 月末夹取（最容易错的边界）──
eq('03-31 退一月', fmtDate(shiftMonths(T('2026-03-31'), -1)), '2026-02-28')
eq('03-31 退一月（闰年）', fmtDate(shiftMonths(T('2024-03-31'), -1)), '2024-02-29')
eq('01-31 退一月', fmtDate(shiftMonths(T('2026-01-31'), -1)), '2025-12-31')
eq('05-31 退三月', fmtDate(shiftMonths(T('2026-05-31'), -3)), '2026-02-28')
eq('12-15 进一月跨年', fmtDate(shiftMonths(T('2026-12-15'), 1)), '2027-01-15')
eq('闰日退一年', fmtDate(shiftMonths(T('2024-02-29'), -12)), '2023-02-28')

// ── 年份跳（R39-A：日期面板的双箭头 = `shiftMonths(±12)`）──
// 复用的就是上面那条月位移口径：月末夹取、闰日同样要稳，不许另写一套日期算术。
eq('02-28 进一年', fmtDate(shiftMonths(T('2026-02-28'), 12)), '2027-02-28')
eq('闰日进一年', fmtDate(shiftMonths(T('2024-02-29'), 12)), '2025-02-28')
eq('12-31 进一年', fmtDate(shiftMonths(T('2026-12-31'), 12)), '2027-12-31')
eq('01-31 退一年', fmtDate(shiftMonths(T('2026-01-31'), -12)), '2025-01-31')

// ── 本地解析（不能走 UTC）：东八区下 09-01 必须还是 09-01 ──
const p = parseDate('2026-09-01')
eq('parseDate 日号', p.getDate(), 1)
eq('parseDate 月号', p.getMonth(), 8)
eq('parseDate 往返', fmtDate(p), '2026-09-01')
eq('parseDate 空串', parseDate(''), null)
eq('parseDate 非法', parseDate('2026-9-1'), null)

// ── 预设命中（高亮哪一枚）──
eq('空区间命中「所有」', matchPreset(EMPTY_RANGE, base), 'all')
eq('近一周命中 w1', matchPreset(presetRange(RANGE_PRESETS[0], base), base), 'w1')
eq('自定义不命中', matchPreset({ from: '2022-07-25', to: '2026-09-06' }, base), undefined)

// ── 区间文案 ──
eq('半开文案', rangeText({ from: '2026-09-01', to: '' }), '2026-09-01 ~ …')
eq('空文案', rangeText(EMPTY_RANGE), '')

// ── 6×7 网格：周一为首 + 覆盖整月 + 首格必是周一 ──
const g = monthGrid(T('2026-09-01'))
eq('网格格数', g.length, 42)
eq('首格是周一', g[0].getDay(), 1)
eq('首格 = 2026-08-31', fmtDate(g[0]), '2026-08-31')
eq('末格 = 2026-10-11', fmtDate(g[41]), '2026-10-11')
eq('含当月首日', g.some((d) => fmtDate(d) === '2026-09-01'), true)
eq('含当月末日', g.some((d) => fmtDate(d) === '2026-09-30'), true)
const gFeb = monthGrid(T('2026-02-01'))
eq('2 月也在 6 行内', gFeb.length, 42)
eq('2 月末日在内', gFeb.some((d) => fmtDate(d) === '2026-02-28'), true)

// ── 墙上时间值的拆装（`YYYY-MM-DDTHH:mm`，日期+时刻选择器共用）──────────────
// 这条链路上错一位，用户看到的是"我选的 20:00 存成了 08:00"（后端按原样字符串解释）。
eq('小时档位数', HOURS.length, 24)
eq('分钟档位数（1 分钟一档，20:07 也要能填）', MINUTES.length, 60)
eq('首/末小时', [HOURS[0], HOURS[23]], ['00', '23'])
eq('首/末分钟', [MINUTES[0], MINUTES[59]], ['00', '59'])
eq('拆 日期+时刻', splitLocal('2026-10-07T20:00'), { date: '2026-10-07', time: '20:00' })
eq('拆 只给日期 → 补 00:00', splitLocal('2026-10-07'), { date: '2026-10-07', time: '00:00' })
eq('拆 单位数小时也认', splitLocal('2026-10-07T9:05'), { date: '2026-10-07', time: '09:05' })
eq('拆 空串', splitLocal(''), null)
eq('拆 越界小时', splitLocal('2026-10-07T24:00'), null)
eq('拆 越界分钟', splitLocal('2026-10-07T20:60'), null)
eq('拆 非本格式', splitLocal('2026/10/07 20:00'), null)
eq('拼 两段', joinLocal('2026-10-07', '20:00'), '2026-10-07T20:00')
eq('拼 单位数补零', joinLocal('2026-10-07', '9:5'), '2026-10-07T09:05')
eq('拼 时刻缺 → 00:00', joinLocal('2026-10-07', ''), '2026-10-07T00:00')
eq('拼 时刻越界 → 00:00（不产生非法值）', joinLocal('2026-10-07', '99:99'), '2026-10-07T00:00')
eq('拼 日期认不出 → 空串', joinLocal('', '20:00'), '')
// ★ 往返恒等：选择器的两条写路径（点日历 / 滚轮列）都必须落在同一个值上
for (const v of ['2026-10-07T20:00', '2026-01-01T00:00', '2026-12-31T23:59']) {
  const sp = splitLocal(v)
  eq(`往返 ${v}`, joinLocal(sp.date, sp.time), v)
}
eq('显示文案', fmtLocalHuman('2026-10-07T20:00'), '2026/10/07 20:00')
eq('显示文案（空）', fmtLocalHuman(''), '')
eq('显示文案（认不出）', fmtLocalHuman('乱写的'), '')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
