// @vitest-environment jsdom
/**
 * 播放诊断窗口（devlog/306–309）：把"跳转后画面低帧率"这种**只在真机上出现**的现象
 * 变成一行可交付的数字。
 *
 * 这里钉的是**数字怎么算的**（纯函数），以及"收尾时真的上报了一行"——
 * 报的内容对不对，靠 `summarize` 的用例保证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clientLog = vi.fn((..._a: unknown[]) => Promise.resolve({ ok: true, dropped: false }))
vi.mock('../api/api', () => ({
  api: { clientLog: (line: unknown) => clientLog(line) },
}))

import {
  aheadOf, curveLine, decoderStallSeconds, frameStats, hiddenSeconds, idleSeconds, judderStats,
  openWindow, stalledSeconds, submitStallSeconds, summarize, verdict, watchPlayback,
} from './playbackProbe'

class FakeMedia {
  currentTime = 0
  buffered = ranges(0, 0)
  private q = { totalVideoFrames: 0, droppedVideoFrames: 0 }
  getVideoPlaybackQuality() { return this.q }
  setFrames(total: number, dropped: number) { this.q = { totalVideoFrames: total, droppedVideoFrames: dropped } }
}

/** 造一个 `TimeRanges` 替身（jsdom 里没法真造）。 */
function ranges(start: number, end: number): TimeRanges {
  return { length: 1, start: () => start, end: () => end } as unknown as TimeRanges
}

function makeEl(): FakeMedia & HTMLVideoElement {
  return new FakeMedia() as FakeMedia & HTMLVideoElement
}

/** 造一条采样（只写关心的字段，其余按"一切正常"填）。 */
function smp(t: number, o: {
  fps?: number; decoded?: number | null; presented?: number | null; pageFps?: number | null
  ahead?: number | null; advanced?: boolean; hidden?: boolean; focused?: boolean
  readyState?: number; seeking?: boolean
  dropped?: number; intervals?: number[]; longTasks?: number; anims?: number | null; fs?: boolean
} = {}) {
  return { t, fps: 30, decoded: 30 as number | null, presented: 30 as number | null,
           pageFps: 60 as number | null, ahead: 8 as number | null,
           advanced: true, hidden: false, focused: true,
           readyState: 4, seeking: false, ...o }
}

beforeEach(() => {
  clientLog.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('playbackProbe', () => {
  it('`frameStats` 优先用 `getVideoPlaybackQuality`（并带上解码计数），没有就退回 webkit*', () => {
    const el = makeEl()
    el.setFrames(120, 3)
    expect(frameStats(el)).toEqual({ frames: 120, dropped: 3, decoded: null })

    const legacy = { webkitDecodedFrameCount: 90, webkitDroppedFrameCount: 1 } as unknown as HTMLVideoElement
    expect(frameStats(legacy)).toEqual({ frames: 90, dropped: 1, decoded: null })

    // 三段口径里"解码"这一段的来源
    const both = {
      getVideoPlaybackQuality: () => ({ totalVideoFrames: 200, droppedVideoFrames: 2 }),
      webkitDecodedFrameCount: 260,
    } as unknown as HTMLVideoElement
    expect(frameStats(both)).toEqual({ frames: 200, dropped: 2, decoded: 260 })
  })

  it('`aheadOf`：当前位置落在缓冲区间里才给数，否则 null；**负毛刺按"量不到"算**', () => {
    const el = makeEl()
    el.currentTime = 10
    el.buffered = ranges(5, 18)
    expect(aheadOf(el)).toBeCloseTo(8, 3)
    el.currentTime = 2                      // 在区间外
    expect(aheadOf(el)).toBeNull()
    el.currentTime = 19                     // 已经越过 end（读数毛刺）
    expect(aheadOf(el)).toBeNull()
  })

  it('`summarize`：窗口内帧率/丢帧算**增量**，并切出"前 3 秒 vs 后段"', () => {
    const el = makeEl()
    el.setFrames(300, 4)
    const w = openWindow(el, 'seek', 198.5)
    // 前 3 秒很惨（每秒 5 帧），之后正常（每秒 30 帧）
    for (let t = 1; t <= 3; t += 1) w.samples.push(smp(t, { fps: 5, presented: 5, ahead: 0.4 }))
    for (let t = 4; t <= 10; t += 1) w.samples.push(smp(t, { fps: 30, presented: 30, ahead: 6 }))
    w.pres.supported = true
    el.setFrames(480, 7)                    // 窗口里又解了 180 帧、丢了 3 帧
    w.waiting = 6
    w.minAhead = 0.2
    w.readyMs = 4200
    el.currentTime = 199
    el.buffered = ranges(190, 205)

    const line = summarize(w, el, w.startedAt + 10_000)   // 10 秒窗口
    expect(line).toContain('[video] seek→198.5s')
    expect(line).toContain('窗口=10.0s')
    expect(line).toContain('起播=4.2s')
    expect(line).toContain('饿住=6次')
    expect(line).toContain('最低缓冲=0.2s')
    expect(line).toContain('解码=30.0fps')   // 采样里 decoded 全是 30
    expect(line).toContain('提交=18.0fps')   // 180 帧 / 10 秒（提交给合成器的那一段）
    expect(line).toContain('呈现=22.5fps')   // (5×3 + 30×7) / 10 = 22.5（增量，不是累计）
    expect(line).toContain('页面=60.0fps')   // rAF：整页自绘节拍（用于对照"只有视频卡"）
    expect(line).toContain('前3秒=5.0')       // ← "开头差"这个事实必须留在行里
    expect(line).toContain('后段=30.0')       // ← 与"之后正常"对比
    expect(line).toContain('丢帧=3/180')     // 增量，不是 7/480
    expect(line).toContain('末缓冲=6.0s')
    expect(line, '缓冲只剩 0.2s 且反复饿 ⇒ 判定要直接写"数据受限"').toContain('判定=数据受限')
  })

  it('**呈现**侧：解码正常但没画出来 ⇒ 判定"呈现受限"（这是之前量不到的那一半）', () => {
    const el = makeEl()
    const w = openWindow(el, 'seek', 100)
    // 解码 30fps、呈现只有 8fps：帧解出来了，但没上屏
    for (let t = 1; t <= 6; t += 1) w.samples.push(smp(t, { presented: 8 }))
    w.pres.supported = true
    w.pres.maxGapMs = 700                        // 有一次 0.7 秒的大洞
    w.pres.gaps.push(700)
    w.minAhead = 6
    const line = summarize(w, el, w.startedAt + 6_000)
    expect(line).toContain('呈现=8.0fps')
    expect(line).toContain('最长停顿=0.70s')
    expect(line).toContain('停顿次数=1')
    expect(line).toContain('判定=呈现受限')
  })

  it('★ 真机三次复现的形状：缓冲够、解码够、**呈现很低** + 那几秒是"页面不可见" ⇒ 判定要指名它', () => {
    // 现场（devlog/309）：最低缓冲 2.6s、解码 30.2fps、呈现 7.3fps、最长停顿 4.15s，而这几秒
    // 页面被判为不可见（切走/被完全遮挡/最小化）——Chromium 对不可见页面**挂起画面、继续放音频**
    const w = openWindow(makeEl(), 'seek', 161.4)
    for (let t = 1; t <= 3; t += 1) w.samples.push(smp(t, { hidden: true, focused: false }))
    for (let t = 4; t <= 7; t += 1) w.samples.push(smp(t, { presented: 30 }))
    w.pres.supported = true
    w.pres.maxGapMs = 4150
    w.minAhead = 2.6
    expect(hiddenSeconds(w)).toBe(3)
    expect(verdict(w, 30.2)).toBe('窗口不可见(浏览器挂起画面，音频照常)')
    const line = summarize(w, makeEl(), w.startedAt + 7_000)
    expect(line).toContain('隐藏=3s')
    expect(line).toContain('判定=窗口不可见')
  })

  it('三段口径：**解码器停**与**解码有帧没提交**要能分开（决定修法不同）', () => {
    // 形状 A：seek 后解码器停 3 秒（真机七次的形状：1s 爆发 → 2~4s 0 → 恢复）
    const a = openWindow(makeEl(), 'seek', 126.3)
    a.samples.push(smp(1, { fps: 153, decoded: 153 }))
    for (let t = 2; t <= 4; t += 1) a.samples.push(smp(t, { fps: 0, decoded: 0, ahead: 5 }))
    a.samples.push(smp(5, { fps: 30, decoded: 30 }))
    a.pres.supported = true
    expect(decoderStallSeconds(a)).toBe(3)
    expect(submitStallSeconds(a)).toBe(0)
    expect(verdict(a, 36)).toContain('解码器停')

    // 形状 B：解码一直在出帧，但一帧都没提交给合成器
    const b = openWindow(makeEl(), 'seek', 50)
    for (let t = 1; t <= 3; t += 1) b.samples.push(smp(t, { fps: 0, decoded: 30, ahead: 6 }))
    b.pres.supported = true
    expect(decoderStallSeconds(b)).toBe(0)
    expect(submitStallSeconds(b)).toBe(3)
    expect(verdict(b, 0)).toContain('没提交')
  })

  it('`verdict` 三态：数据受限 / 呈现受限 / 正常', () => {
    const w = openWindow(makeEl(), 'seek', 10)
    for (let t = 1; t <= 4; t += 1) w.samples.push(smp(t, { ahead: 5 }))
    expect(verdict(w, 30)).toBe('正常(呈现量不到)')     // jsdom 没有 rVFC ⇒ 如实说量不到

    w.pres.supported = true
    expect(verdict(w, 30)).toBe('正常')

    const stalled = openWindow(makeEl(), 'seek', 10)
    stalled.pres.supported = true
    stalled.samples.push(smp(1, { fps: 0, presented: 0, ahead: 0.1, advanced: false }))
    stalled.samples.push(smp(2, { fps: 0, presented: 0, ahead: 0.1, advanced: false }))
    expect(verdict(stalled, 0)).toBe('数据受限')
  })

  it('真的挂上 `requestVideoFrameCallback`：回调间隔就是**卡顿本身**', async () => {
    type FrameCb = (now: number, meta: { presentedFrames?: number }) => void
    const holder: { cb: FrameCb | null } = { cb: null }
    const el = makeEl() as FakeMedia & HTMLVideoElement
    ;(el as unknown as { requestVideoFrameCallback: (f: FrameCb) => number })
      .requestVideoFrameCallback = (f) => { holder.cb = f; return 1 }
    const h = watchPlayback(el, 'seek', 10)
    // 两帧正常（33ms 间隔）→ **卡 1.2 秒** → 再两帧；`now` 是浏览器给的呈现时刻（可注入）
    let presented = 30
    for (const now of [1000, 1033, 1066, 2266, 2299]) {
      holder.cb?.(now, { presentedFrames: presented })
      presented += 30
    }
    await vi.advanceTimersByTimeAsync(1000)
    h.finish()
    const line = clientLog.mock.calls[0][0] as unknown as string
    expect(line).toContain('最长停顿=1.20s')
    expect(line).toContain('停顿次数=1')
  })

  it('**卡帧与空转分开**：`currentTime` 不动 = 数据没到；动了却没帧 = 解码', () => {
    const w = openWindow(makeEl(), 'seek', 10)
    w.samples.push(smp(1, { fps: 0, presented: 0, ahead: 0.1, advanced: false }))  // 卡帧（数据没到）
    w.samples.push(smp(2, { fps: 0, presented: 0, ahead: 0.1, advanced: false }))
    w.samples.push(smp(3, { fps: 0, presented: 0, ahead: 8.0 }))                  // 空转（缓冲够、没出帧）
    w.samples.push(smp(4, { ahead: 8.0 }))
    expect(stalledSeconds(w)).toBe(2)
    expect(idleSeconds(w)).toBe(1)
  })

  it('`curveLine`：只在**确实有低谷**时给每一步曲线，并把"没前进"标出来', () => {
    const w = openWindow(makeEl(), 'seek', 10)
    for (let t = 1; t <= 6; t += 1) {
      w.samples.push(smp(t, { fps: t <= 3 ? 4 : 30, presented: t <= 3 ? 4 : 30,
                              ahead: t <= 3 ? 0.3 : 6, advanced: t !== 2 }))
    }
    const line = curveLine(w)
    expect(line).toContain('曲线(seek)')
    expect(line).toContain('1s:4fps/0.3')
    expect(line).toContain('2s:4fps/0.3*')     // `*` = 那一秒 currentTime 没前进
    expect(line).toContain('4s:30fps/6.0')

    const calm = openWindow(makeEl(), 'start')
    for (let t = 1; t <= 6; t += 1) calm.samples.push(smp(t))
    expect(curveLine(calm), '一切正常就不该多刷一行').toBeNull()
  })

  it('到点上报一行（走 `api.clientLog`），并带上 note* 记下的数字', async () => {
    const el = makeEl()
    el.currentTime = 5                    // 落在缓冲区间外 ⇒ 每秒采样量不到 ahead，不会覆盖 note 的值
    const h = watchPlayback(el, 'seek', 100)
    h.noteWaiting()
    h.noteWaiting()
    h.noteAhead(1.5)
    h.noteAhead(0.3)                      // 取最小
    h.noteAhead(-1)                       // 负毛刺不算
    h.noteReady()
    el.setFrames(60, 0)
    await vi.advanceTimersByTimeAsync(31_000)
    // 第一行是汇总；**可能**跟一行每秒曲线（这个用例里 fake 时钟走了 30 秒而帧数没涨 ⇒ 判定"卡帧"）
    const line = clientLog.mock.calls[0][0] as unknown as string
    expect(line).toContain('seek→100.0s')
    expect(line).toContain('饿住=2次')
    expect(line).toContain('最低缓冲=0.3s')
    for (const call of clientLog.mock.calls.slice(1)) {
      expect(String(call[0])).toContain('[video] 曲线')
    }
  })

  it('全屏标记：只在全屏复现的卡顿靠这一格对账（2026-10-06，devlog/379）', () => {
    // 用户报的"播放一下一下地慢"只在**全屏**复现（非全屏/小窗都顺）—— 日志里没有这一格时，
    // 同一段视频的全屏/非全屏两组数根本对不上账。窗口开局记一次，报告那一拍再看一眼当前状态。
    const el = makeEl()
    const w = openWindow(el, 'seek', 10, 'MSE')
    w.fullscreen = true
    const line = summarize(w, el, performance.now())
    expect(line).toContain('全屏=1')
    // `表面=`：区分"全屏降本那一刀生效了"与"跑在旧壳上（命令不存在、静默失败）"（devlog/382）
    expect(line, '表面那一格必须在（否则无法判断降本那一刀有没有生效）').toMatch(/表面=\S+/)
    // 没记过、当前也不在全屏 ⇒ 0（jsdom 里 `document.fullscreenElement` 恒为 null）
    expect(summarize(openWindow(el, 'seek'), el, performance.now())).toContain('全屏=0')
    // 开局没记、但**报告时**已在全屏（点全屏键发生在窗口开始之后）⇒ 也算 1
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: el })
    try {
      expect(summarize(openWindow(el, 'seek'), el, performance.now())).toContain('全屏=1')
    } finally {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
    }
  })

  it('`finish()` **先报再停**（关抽屉那几次也要留下证据），`cancel()` 才丢弃', async () => {
    const el = makeEl()
    const a = watchPlayback(el, 'seek', 10)
    a.noteWaiting()                      // 有内容才报（挂载即卸载那种空窗口不写垃圾行）
    a.finish()
    expect(clientLog, 'finish 要立刻上报').toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(clientLog, '上报过就不该再来一次').toHaveBeenCalledTimes(1)

    clientLog.mockClear()
    const b = watchPlayback(el, 'seek', 20)
    b.noteWaiting()
    b.cancel()
    await vi.advanceTimersByTimeAsync(31_000)
    expect(clientLog, 'cancel 是"丢弃"（被新窗口顶掉）').not.toHaveBeenCalled()
  })

  it('空窗口（挂载就被卸载）不写垃圾行', async () => {
    const el = makeEl()
    watchPlayback(el, 'start').finish()
    expect(clientLog).not.toHaveBeenCalled()
  })
})

/**
 * B2 第四轮（`devlog/384`）：**让下一轮日志自己说话**。
 *
 * 前三轮拿到的都是"窗口汇总"：唯一异常是丢帧 5~10%，而"帧在漏但没停住"（停顿 0 次）
 * 与用户的症状（"一下一下地慢"）对不上 —— 探针量的是**停顿**，用户说的是**节拍**。
 * 这一批补的正是缺的那几个口径：抖动/重复帧、丢帧的**逐秒**分布、主线程长任务、
 * 全屏页面里还有没有东西在动。
 */
describe('playbackProbe · 抖动与逐秒分布（devlog/384）', () => {
  it('`judderStats`：以**中位数**为基准，均匀 33ms 不算抖动', () => {
    const even = Array.from({ length: 30 }, () => 33.3)
    expect(judderStats(even)).toEqual({ count: 0, maxMs: 0 })
    // 抽掉一拍（66ms ≈ 漏了一帧）就算一次
    const one = [...even.slice(0, 10), 66, ...even.slice(11)]
    expect(judderStats(one).count).toBe(1)
    expect(judderStats(one).maxMs).toBe(66)
  })

  it('`judderStats`：**重复呈现**（一堆 8ms 小间隔）不许被整窗判成抖动', () => {
    // 这是"拿最小间隔当基准"那版会踩的坑：合成器重复呈现同一帧会出现 8ms 间隔，
    // 用最小值当基准 ⇒ 33ms 的正常帧全被算成"超基准 4 倍"。中位数基准把它挡在门外。
    const dup = [...Array.from({ length: 20 }, () => 8.3), ...Array.from({ length: 20 }, () => 33.3)]
    expect(judderStats(dup).count, '一半是重复呈现，另一半是正常节拍 ⇒ 没有抖动').toBe(0)
  })

  it('`judderStats`：样本太少（开局那几帧间隔不准）不判', () => {
    expect(judderStats([200, 200, 200])).toEqual({ count: 0, maxMs: 0 })
  })

  it('丢帧**按秒**分布 + 判定给一句"丢帧N%"，曲线也带上每秒的丢帧数', () => {
    const el = makeEl()
    const w = openWindow(el, 'start')
    // 前 5 秒匀速漏一点（每秒丢 1 帧），第 6 秒崩一下（丢 20 帧）
    for (let t = 1; t <= 5; t += 1) w.samples.push(smp(t, { dropped: 1 }))
    w.samples.push(smp(6, { dropped: 20, fps: 12 }))
    w.pres.supported = true
    const line = summarize(w, el, performance.now())
    expect(line, '判定要把它说出来，否则这行读起来像"一切正常"').toContain('判定=呈现受限(丢帧')
    const curve = curveLine(w)
    expect(curve, '帧在漏就要出曲线（第一版只在"低谷/卡顿"时出 ⇒ 丢帧那一轮一行都没有）')
      .toContain('曲线')
    expect(curve, '崩的那一秒要能看见').toContain('丢20')
    expect(curve).toContain('丢1')
  })

  it('长任务/动画：量得到就报，量不到就写"量不到"（不编 0）', () => {
    const el = makeEl()
    const w = openWindow(el, 'start')
    w.samples.push(smp(1, { longTasks: 2, anims: 3 }))
    w.samples.push(smp(2, { longTasks: 1, anims: 0 }))
    const line = summarize(w, el, performance.now())
    expect(line).toContain('长任务=3次')
    expect(line).toContain('动画=1秒')          // 只有第 1 秒有东西在动

    const blank = openWindow(el, 'start')
    blank.samples.push(smp(1, { longTasks: undefined, anims: null }))
    const blankLine = summarize(blank, el, performance.now())
    expect(blankLine, 'jsdom/旧壳里量不到就别编').toContain('长任务=量不到')
    expect(blankLine).toContain('动画=量不到')
  })

  it('全屏按秒记：`全屏=N/M秒` —— "进过没有"与"进了多久"都要能读出来', () => {
    const el = makeEl()
    const w = openWindow(el, 'start')
    w.samples.push(smp(1, { fs: false }))
    w.samples.push(smp(2, { fs: true }))
    w.samples.push(smp(3, { fs: true }))
    expect(summarize(w, el, performance.now())).toContain('全屏=2/3秒')
    // 没有采样时退回 1/0（测试与"开局即结束"那条路）
    expect(summarize(openWindow(el, 'start'), el, performance.now())).toContain('全屏=0')
  })

  it('中途进全屏、报告前又退出 ⇒ 整窗粘性仍记着（`fullscreenchange` 监听）', async () => {
    // ⚠️ 这一条**故意一次采样都不推进**：进/出全屏都发生在采样缝里 ⇒ 按秒的 `Sample.fs`
    //    一帧都没记到，唯一能证明"进过"的就是那个粘性位。第一版写成了"进全屏 → 采样 → 退出"
    //    （反向验证时发现：去掉监听器它照样绿 —— 那种写法钉的其实是按秒采样，不是监听器）。
    const el = makeEl()
    const h = watchPlayback(el, 'start')
    const vp = document.createElement('div')
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: vp })
    document.dispatchEvent(new Event('fullscreenchange'))
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
    document.dispatchEvent(new Event('fullscreenchange'))
    h.noteWaiting()                     // 有内容才写行
    h.finish()
    const line = String(clientLog.mock.calls[0][0])
    expect(line, '开局与报告两拍都不在全屏，只有粘性位记得住').toContain('全屏=1')
  })

  it('进/出全屏都落在同一秒里 ⇒ 按秒数是 0，但要标 `(曾)`', () => {
    const el = makeEl()
    const w = openWindow(el, 'start')
    w.samples.push(smp(1, { fs: false }))
    w.everFullscreen = true                       // 监听器置的位（进/出在同一秒内）
    expect(summarize(w, el, performance.now())).toContain('全屏=0/1秒(曾)')
  })

  it('汇总行**不超过 400 字**（接口硬限制，超了整行被丢）', () => {
    const el = makeEl()
    el.setFrames(500, 40)
    const w = openWindow(el, 'seek', 123.4, 'MSE')
    for (let t = 1; t <= 30; t += 1) {
      w.samples.push(smp(t, { fps: 5, decoded: 0, presented: 0, pageFps: 0, ahead: 0,
                              dropped: 5, longTasks: 3, anims: 2, fs: true }))
    }
    w.pres.supported = true
    w.pres.maxGapMs = 1200
    w.pres.gaps.push(1200)
    w.pres.repeats = 99
    w.longTaskMaxMs = 250
    const line = summarize(w, el, performance.now())
    expect(line.length, `实得 ${line.length} 字：${line}`).toBeLessThanOrEqual(400)
  })
})
