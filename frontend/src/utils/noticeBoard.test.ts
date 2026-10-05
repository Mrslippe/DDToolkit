import { describe, expect, it } from 'vitest'
import type { Notice } from './notificationHub'
import { EVENT_TTL_MS, LIVE_NOTICE_MS, liveNotice, messageNotice } from './notificationHub'
import { PILL_MS } from './noticeStream'
import {
  ackAllIds,
  capsuleText,
  countdownFraction,
  discFraction,
  groupOf,
  headlineOf,
  pickHeadline,
  pruneAcked,
  relTime,
  relTimeFor,
  sectionNotices,
  tierOf,
  todoIds,
} from './noticeBoard'

/**
 * L1 的三形态 / 分组 / 相对时间 / 同级合并（`devlog/341`）。
 * 每条判错的代价都是"界面说错话"，所以每条规则都单独钉：
 * 分组错了 ⇒ 用户找不到"要我做什么"；相对时间错了 ⇒ 一条三天前的通知写"刚刚"；
 * 合并错了 ⇒ 用户以为只有一个任务在跑。
 */
const NOW = 1_700_000_000_000

const n = (over: Partial<Notice> & { id: string }): Notice => ({
  kind: 'progress', text: '帖子抓取中', form: 'state', createdAt: NOW - 1000, ...over,
})

describe('形态 → 分组', () => {
  it('state/notice/action 各归各的组', () => {
    expect(groupOf(n({ id: 'a', form: 'state' }))).toBe('doing')
    expect(groupOf(n({ id: 'b', form: 'notice' }))).toBe('recent')
    expect(groupOf(n({ id: 'c', form: 'action' }))).toBe('todo')
  })

  it('form 缺失（老后端）按 state 处理 —— 保守：不会被自动已读掉', () => {
    expect(groupOf({ id: 'x', kind: 'alert', text: '旧条目' })).toBe('doing')
  })

  it('**不许拿 kind 推 form**：report 是 action，不是 notice', () => {
    // 这条是"报告被自动已读"那个 bug 的护栏：报告 kind='report'、form='action'
    const rep = n({ id: 'report-1', kind: 'report', form: 'action', sticky: true, text: '全量完成' })
    expect(groupOf(rep)).toBe('todo')
    expect(countdownFraction(rep, NOW)).toBeNull()   // 处置类没有倒计时
  })
})

describe('分组与排序', () => {
  it('只出有内容的组，顺序固定 recent → todo → doing（最近在最上，用户 2026-10-05 定）', () => {
    const list = [
      n({ id: 'r', form: 'notice', kind: 'message', text: '同步完成' }),
      n({ id: 'd', form: 'state', text: '帖子抓取中' }),
      n({ id: 't', form: 'action', kind: 'report', text: '全量完成' }),
    ]
    expect(sectionNotices(list, NOW).map((s) => s.group)).toEqual(['recent', 'todo', 'doing'])
  })

  it('过期的条目**不进任何组**（面板里不会留一条已经没了的通知）', () => {
    const gone = n({ id: 'g', form: 'notice', kind: 'message', text: '过期了',
                     createdAt: NOW - 9000, expiresAt: NOW - 1 })
    const alive = n({ id: 'a', form: 'notice', kind: 'message', text: '还在',
                      createdAt: NOW - 1000, expiresAt: NOW + 5000 })
    const secs = sectionNotices([gone, alive], NOW)
    expect(secs).toHaveLength(1)
    expect(secs[0].items.map((x) => x.id)).toEqual(['a'])
  })

  it('组内按"过期会不会丢信息 / 要不要动手"排，不看 kind', () => {
    // doing 组：风控冷却(1) 排在进度(2) 前面
    expect(tierOf(n({ id: 'rate-limit', kind: 'alert', form: 'state' })))
      .toBeLessThan(tierOf(n({ id: 'progress-post', form: 'state' })))
    // recent 组：开播(有时窗, 0) 排在"同步完成"(4) 前面
    expect(tierOf(n({ id: 'live-1', kind: 'alert', form: 'notice' })))
      .toBeLessThan(tierOf(n({ id: 'msg-1', kind: 'message', form: 'notice' })))
  })

  it('同档按新的在前（刚发生的最相关）', () => {
    const old = n({ id: 'o', form: 'notice', kind: 'message', createdAt: NOW - 5000 })
    const recent = n({ id: 'n', form: 'notice', kind: 'message', createdAt: NOW - 100 })
    const items = sectionNotices([old, recent], NOW)[0].items
    expect(items.map((x) => x.id)).toEqual(['n', 'o'])
  })
})

describe('同级合并（胶囊上那句）', () => {
  it('单个任务：原样显示', () => {
    expect(headlineOf([n({ id: 'p', text: '帖子抓取中 - 明前奶绿 - 3/11' })]))
      .toBe('帖子抓取中 - 明前奶绿 - 3/11')
  })

  it('两个任务同时跑 ⇒ 合并成一条，而不是只显示一个', () => {
    const t = headlineOf([
      n({ id: 'progress-post', text: '帖子抓取中 - 明前奶绿 - 3/11' }),
      n({ id: 'progress-account', text: '账号信息抓取中 - 星瞳 - 1/2' }),
    ])
    expect(t).toContain('帖子')
    expect(t).toContain('账号信息')
    expect(t).toContain('抓取中')
    // 进度取**第一条有的那个**（i/N 只显示一份，避免"3/11 · 1/2"这种读不懂的拼接）
    expect(t).toContain('3/11')
  })

  it('多场开播 ⇒ "N 场开播 · A、B"', () => {
    expect(headlineOf([
      n({ id: 'live-1', kind: 'alert', form: 'notice', text: '弥月Mizuki 开播了' }),
      n({ id: 'live-2', kind: 'alert', form: 'notice', text: '星瞳 开播了' }),
    ])).toBe('2 场开播 · 弥月Mizuki、星瞳')
  })

  it('混合状态（进度 + 冷却）⇒ "N 项状态 · 第一条"（不硬拼）', () => {
    expect(headlineOf([
      n({ id: 'rate-limit', kind: 'alert', form: 'state', text: '上游限流：冷却中' }),
      n({ id: 'progress-post', text: '帖子抓取中' }),
    ])).toBe('2 项状态 · 上游限流：冷却中')
  })

  it('胶囊取**最靠前那组**（现在是「最近」）的合并句，不是所有条目的第一条', () => {
    // ⚠️ 这条**是被有意改掉的旧行为**（用户 2026-10-05 把"最近"提到最顶）：
    //    原来做正面的进度会占胶囊，现在**刚发生的事**（开播/回执）优先 —— 那正是"最实时"的含义。
    const list = [
      n({ id: 'msg-1', kind: 'message', form: 'notice', text: '设置已保存', createdAt: NOW }),
      n({ id: 'progress-post', form: 'state', text: '帖子抓取中 - 明前奶绿 - 3/11' }),
    ]
    expect(pickHeadline(list, NOW)?.id).toBe('msg-1')
    expect(capsuleText(list, NOW)).toContain('设置已保存')
    // 反过来：只有状态时，胶囊照旧显示状态（"现在有什么在跑"是它的看家职责）
    const onlyState = [n({ id: 'progress-post', form: 'state', text: '帖子抓取中' })]
    expect(pickHeadline(onlyState, NOW)?.id).toBe('progress-post')
  })

  it('一键已读（`ackAllIds`）：清「会自动过期的 + 需要处理的」，「正在进行」不动', () => {
    const list = [
      n({ id: 'report-1', kind: 'report', form: 'action', read: 'confirm', text: '全量完成' }),
      n({ id: 'progress-post', form: 'state', text: '帖子抓取中' }),
      n({ id: 'rate-limit', kind: 'alert', form: 'state', text: '上游限流：冷却中' }),
      n({ id: 'live-1', kind: 'alert', form: 'notice', text: 'A 开播了' }),
      n({ id: 'msg-1', kind: 'message', form: 'notice', text: '设置已保存' }),
    ]
    expect(ackAllIds(list, NOW).sort()).toEqual(['live-1', 'msg-1', 'report-1'])
    // 只有状态时不返回任何 id（面板那个按钮会因此不渲染 —— 点了也没用就别给）
    expect(ackAllIds([n({ id: 'p', form: 'state' })], NOW)).toEqual([])
  })

  it('「需要处理」组自己的一键已读（`todoIds`）仍是 `read=confirm` 那些（L4）', () => {
    const list = [
      n({ id: 'report-1', kind: 'report', form: 'action', read: 'confirm', text: '全量完成' }),
      n({ id: 'progress-post', form: 'state', text: '帖子抓取中' }),
      n({ id: 'live-1', kind: 'alert', form: 'notice', text: 'A 开播了' }),
    ]
    expect(todoIds(list, NOW)).toEqual(['report-1'])
    expect(todoIds([n({ id: 'p', form: 'state' })], NOW)).toEqual([])
  })

  it('⚠️ 状态类**即使被误放进 todo 组也不许一键已读**（L4 的第二道防线）', () => {
    // 后端把稳定 id 的状态放进已读集合的后果很阴：同一条状态**再次成立**时会被误判成已读
    //（症状：再次被限流却什么都不显示）。所以前端按 `read` 而不是 `form` 筛。
    const sneaky = n({ id: 'rate-limit', kind: 'alert', form: 'action', read: 'auto',
                       text: '上游限流：冷却中' })
    expect(todoIds([sneaky], NOW)).toEqual([])
  })

  it('缺 `read` 字段（老后端）时按 `form === action` 兜底', () => {
    const legacy = n({ id: 'report-9', kind: 'report', form: 'action', text: '全量完成' })
    expect(todoIds([legacy], NOW)).toEqual(['report-9'])
  })
})

describe('相对时间', () => {
  it('粒度：刚刚 / 秒 / 分 / 时 / 天 / 日期', () => {
    expect(relTime(NOW - 3000, NOW)).toBe('刚刚')
    expect(relTime(NOW - 30_000, NOW)).toBe('30 秒前')
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(relTime(NOW - 3 * 3600_000, NOW)).toBe('3 小时前')
    expect(relTime(NOW - 2 * 86400_000, NOW)).toBe('2 天前')
    expect(relTime(NOW - 30 * 86400_000, NOW)).toMatch(/月 \d+ 日$/)
  })

  it('**没有 createdAt 就不显示**（老后端）—— 不许糊一个"刚刚"', () => {
    expect(relTime(undefined, NOW)).toBe('')
    expect(relTime(null, NOW)).toBe('')
    expect(relTime(NaN, NOW)).toBe('')
    expect(relTimeFor(n({ id: 'x', createdAt: undefined }), NOW)).toBe('')
  })

  it('状态类读作"进行中 N 分钟"（状态一直在发生，不是"发生过"）', () => {
    expect(relTimeFor(n({ id: 'p', form: 'state', createdAt: NOW - 3 * 60_000 }), NOW))
      .toBe('进行中 3 分钟')
    expect(relTimeFor(n({ id: 'p2', form: 'state', createdAt: NOW - 1000 }), NOW))
      .toBe('进行中')
  })

  it('告知/处置类读作"N 分钟前"', () => {
    expect(relTimeFor(n({ id: 'm', form: 'notice', kind: 'message',
                          createdAt: NOW - 5 * 60_000 }), NOW)).toBe('5 分钟前')
    expect(relTimeFor(n({ id: 'r', form: 'action', kind: 'report',
                          createdAt: NOW - 2 * 3600_000 }), NOW)).toBe('2 小时前')
  })

  it('未来/时钟偏差不出现负数', () => {
    expect(relTime(NOW + 5000, NOW)).toBe('刚刚')
  })
})

describe('倒计时（自动已读的可视化）', () => {
  const msg = n({ id: 'm', form: 'notice', kind: 'message', text: '同步完成',
                  createdAt: NOW, expiresAt: NOW + 6000 })

  it('比例从 1 走到 0', () => {
    expect(countdownFraction(msg, NOW)).toBeCloseTo(1)
    expect(countdownFraction(msg, NOW + 3000)).toBeCloseTo(0.5)
    expect(countdownFraction(msg, NOW + 6000)).toBe(0)
  })

  it('**不会自己消失的条目没有倒计时**（进度/冷却/报告）', () => {
    expect(countdownFraction(n({ id: 'p', form: 'state' }), NOW)).toBeNull()
    expect(countdownFraction(n({ id: 'r', form: 'action', kind: 'report' }), NOW)).toBeNull()
    // rate-limit 是 state 但有过期 —— 也不画（它不是"自动已读"，是事实变了）
    expect(countdownFraction(n({ id: 'rate-limit', kind: 'alert', form: 'state',
                                 expiresAt: NOW + 47_000 }), NOW)).toBeNull()
  })

  it('缺 createdAt（算不出跨度）就不画，而不是画一条瞎走的条', () => {
    expect(countdownFraction({ ...msg, createdAt: undefined }, NOW)).toBeNull()
    expect(countdownFraction({ ...msg, expiresAt: undefined }, NOW)).toBeNull()
  })

  it('胶囊的环与面板的条同源（同一个函数）', () => {
    expect(discFraction(msg, NOW + 3000)).toBeCloseTo(0.5)
    expect(discFraction(null, NOW)).toBeNull()
  })
})

describe('时长口径（一处定义，三处同值）', () => {
  it('告知类默认 6 秒，且前端三处同值', () => {
    expect(EVENT_TTL_MS).toBe(6000)
    expect(PILL_MS).toBe(EVENT_TTL_MS)
    const m = messageNotice('完成', NOW, PILL_MS)
    expect(m.form).toBe('notice')
    expect(m.createdAt).toBe(NOW)
    expect(m.expiresAt).toBe(NOW + 6000)
  })

  it('开播是"有时窗的告知"：2 分钟、带 createdAt（面板要能画倒计时）', () => {
    const live = liveNotice({ id: 'live-1', name: '七海', now: NOW })
    expect(live.form).toBe('notice')
    expect(live.createdAt).toBe(NOW)
    expect(live.expiresAt).toBe(NOW + LIVE_NOTICE_MS)
    expect(LIVE_NOTICE_MS).toBe(120_000)
    expect(countdownFraction(live, NOW + 60_000)).toBeCloseTo(0.5)
  })
})

/**
 * 「本机刚点掉」那张表的寿命（`devlog/349`）。
 *
 * 这一组是**两个反面**：忘早了那条又冒出来；不忘则**稳定 id** 的同类事件被一起吞掉
 * （开播告警 `live-<account_id>` 就是按账号稳定的）—— 后者最阴：用户点过一次之后，
 * 那个账号**下次开播**再也不显示了。
 */
describe('已读表的寿命（点掉的 id 什么时候忘）', () => {
  it('还在活着的列表里 ⇒ 记着（否则点完下一拍又冒出来）', () => {
    expect(pruneAcked(['live-1', 'msg-2'], ['live-1', 'report-9'])).toEqual(['live-1'])
  })

  it('列表里真的没了 ⇒ 忘掉（否则同一账号**下次开播**被历史已读吞掉）', () => {
    // 先是点掉那一刻：它还在列表里 ⇒ 记着
    expect(pruneAcked(['live-9'], ['live-9'])).toEqual(['live-9'])
    // 之后它从两个来源里都消失了（服务端删掉 + 推送那份过期）⇒ 这一拍就忘
    expect(pruneAcked(['live-9'], ['progress-post'])).toEqual([])
    // 再次开播（**同一个 id**）：表里已经没有它了 ⇒ 照常显示
    expect(pruneAcked([], ['live-9'])).toEqual([])
  })

  it('没有变化时返回**同一个数组**（调用方拿它 setState —— 新数组会自激成无限重渲染）', () => {
    const acked = ['a', 'b']
    expect(pruneAcked(acked, ['a', 'b', 'c'])).toBe(acked)
    expect(pruneAcked([], ['a'])).toEqual([])
  })
})
