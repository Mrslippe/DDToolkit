/**
 * MSE 播放内核（2026-10-04，devlog/312；计划 `docs/plans/bili-mse-kernel-execution.md` S2）。
 *
 * ## 为什么换掉 progressive（`<video src>` + 独立 `<audio>`）
 *
 * 真机八次复现的形状完全一致（`devlog/310`）：seek 之后**第 1 秒爆发 150+ 帧 → 2–4 秒一帧不出
 * → 恢复 30fps**，而缓冲、时钟、音频全程正常。根因是**裸 fMP4 直喂**：Chromium 的 MP4 demuxer
 * 不读 `sidx`，"跳到第 N 秒"只能按码率猜字节位置、再从关键帧解码丢弃到目标。
 *
 * MSE 把这件事换成：**段表在手，跳到哪里就取哪一段**（5s / ~1.5MB，段首是关键帧，实测
 * `devlog/311`：54 段 × 5.0s、init 948B）。附带三个结构性好处：
 * ① **只剩一个钟**（音视频两条 SourceBuffer 喂同一个元素）⇒ 漂移/快跑/静音归属/暂停归属
 *    那一整类问题消失（`devlog/298`–`305` 全是在给"两个钟"打补丁）；
 * ② **缓冲由我们控制**（要多少给多少，"一帧一帧"变成"干净的缓冲中"）；
 * ③ 有 ABR 手段（段取慢了就降档，S3）。
 *
 * ## 这个模块刻意不碰 DOM 之外的东西
 *
 * 它只做四件事：**取段 → append → 按目标 seek → 淘汰**。控件、清晰度菜单、音量倍速、
 * 诊断窗口都留给 `VideoPlayer`（那里已经有一套；内核换掉不该把它们也换掉）。
 *
 * ## 三个真踩过的坑（都写成了判据）
 *
 * 1. **同一个 SourceBuffer 同时只能有一个操作**：`appendBuffer` 与 `remove` 撞在一起会抛
 *    `This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation`。
 *    spike 第一版两者各自异步发起，泵一停缓冲从 5.5s 抽干到 `None`（`devlog/311`）。
 *    ⇒ 这里所有操作走**单飞**（`busy` + `updateend` 才继续）。
 * 2. **MSE 下 `currentTime` 不能设到没有缓冲的地方**（浏览器会**夹到最近的已缓冲位置**，
 *    静默跳到别处）⇒ `seekTo()` 是"**先把目标段 append 进去，再设 currentTime**"。
 * 3. **配额**：Chromium 有总量上限，长视频不清会 `QuotaExceededError`。⇒ 主动淘汰 +
 *   配额报错时"先淘汰再重试"（不是立刻判死）。
 *
 * ⚠️ MSE **消不掉"段内预滚"**（seek 落在段中间时解码器仍要从段首关键帧解到目标，
 * spike 里那次 142 帧的爆发就是它）；它消掉的是"**先猜字节位置再去取**"那一步。
 */
import { authFetch, videoProxyUrl } from '../api/api'

export interface SegmentRange {
  /** 闭区间字节偏移（`Range: bytes=start-end`） */
  start: number
  end: number
}

export interface SegmentInfo extends SegmentRange {
  i: number
  dur_s: number
  sap: boolean
  /**
   * **精确起点（秒）**：后端按原始 tick 累加得出（`devlog/324`）。
   *
   * ⚠️ 缺了它就只能拿 `dur_s` 累加，而那是**四舍五入过**的值（音频 5.0155 → 5.016，每段多
   * 0.0005s；531 段累计偏晚 **0.26s**，实测 tfdt 2663.24s vs 表 2663.50s）⇒
   * "缓冲末尾之后该取哪一段"永远算回**刚取过**的那一段 ⇒ 泵反复重取、缓冲不长、
   * 播几秒就饿住。老后端不带这个字段，所以它可选、缺了退回累加。
   */
  t?: number
}

export interface StreamTable {
  /** 首选地址（后端排过序：能过代理的普通 CDN 在前） */
  url: string
  /** 同档镜像链：段取不到时**自己换下一条**，不必回后端重取 */
  urls?: string[] | null
  /** MSE 要的精确 codecs 串，如 `video/mp4; codecs="avc1.640033"` */
  mime: string
  kind?: string
  init: SegmentRange
  segments: SegmentInfo[]
  duration_s: number
  total_bytes?: number | null
  /** 这一档的码率（**bits/s**）—— ABR 的"需要多少"（`devlog/328`） */
  bandwidth?: number | null
}

export interface KernelStreams {
  video: StreamTable
  audio?: StreamTable | null
  duration_s?: number
}

/**
 * 前方目标缓冲（秒）：比 hls.js 的 30s 小 —— 这里量的是"够不够稳"，不是"要不要开播"。
 *
 * ⚠️ B2 实验只动了泵的节拍（见 `TICK_MS`），这几个窗口常量**没动** ——
 * "一次灌够、然后长时间不灌"那条路要改 `WANT_AHEAD`，而它被 6 条判据硬编码依赖
 * （`mseKernel.test.ts` 里的 20s/30s/50s 期望值），得连判据一起改，不能盲改。
 */
export const WANT_AHEAD = 20
/** 当前位置**之后**留多久不淘汰（回拖一小段不用重取） */
export const KEEP_BEHIND = 25
/** 触发淘汰的缓冲总量（秒） */
export const MAX_BUFFER = 50
/**
 * **跳转落地前先攒多少秒**（`devlog/313`）。
 *
 * 真机症状：「点击跳转后播放会变得卡顿，播放一会停下，再播一会停下，重复」。
 * 机理：目标段一 append 就落地开播 ⇒ 手里只有**那一段**（5s）；下一个 1.5MB 还在路上
 * （真机实测代理均速 0.5–8MB/s，最差一次 0.31MB/s ≈ 刚好一段 5 秒），于是
 * "放 5 秒 → 饿住 → 再放 5 秒"。成熟播放器都要求"起播缓冲"（hls.js 的 startBuffer），
 * 我们之前是"有一段就走"。
 */
export const SEEK_CUSHION = 10
/** 攒不够也别让人干等：超过这么久就用手里的数据开播（宁可偶尔饿，也别一直转圈） */
const SEEK_CUSHION_MAX_MS = 2500
/**
 * seek **彻底落不了地**时的收手时间（`devlog/313`）。
 *
 * 正常路径下不该走到这里（目标段要么拿到、要么取数失败会熔断退渐进式）。留这一条是因为
 * "永远转圈"是用户视角里最糟的失败形态（既不能看也不能操作）—— 到点就把播放点挪过去，
 * **浏览器自己会夹到最近的已缓冲位置**，同时记一行，别静默。
 */
export const SEEK_GIVEUP_MS = 10_000
/** 泵的空转节拍：`updateend` 之外再踢一脚，免得事件丢了就永远停住。
 *
 * ⚠️ B2 实验 B/C（泵节拍 2000、攒批 3 段）**已回退到基线** —— 两次都无收益（`devlog/393`）。
 * 真机上抓到的形状是"**取数据/灌数据时**每秒稳定丢 ~4 帧、播放已缓冲区域时一帧不丢"
 * （缓冲全程 17~29 秒 ⇒ 不是数据不够，是"灌"这件事本身在打扰呈现）。
 * 这个节拍决定**多久取一段、append 一次** —— 调慢 = 更大块、更少次。
 * 读实验结果的注意点：
 *   · 丢帧率明显下降 ⇒ 方向对，下一步改成**攒批再灌**（一次 append 多段，而不是拉长间隔）；
 *   · 若 `饿住`/`卡帧` 冒出来（段比这个节拍短就会喂不饱）⇒ 说明这一档调过头了，
 *     那时要的是"快取 + 攒着一次灌"，不是"慢取"。
 */
const TICK_MS = 400

const MAX_RETRY = 3
const FETCH_TIMEOUT_MS = 20_000
/** 段取数慢到这个程度就记一行（撑不住实时码率会表现为"低帧率"） */
const SLOW_SEGMENT_MS = 1500
const SLOW_SEGMENT_BYTES_PER_S = 300_000
/**
 * **取数没进展就刹车**（`devlog/314`）。
 *
 * 用户真机报「出错时日志里 info 爆发式增长」—— 那是**取数在打转**（每次代理转发各一行 INFO）。
 * 判据不看"取了几次同一段"（索引会交替，数不出来），只看**缓冲有没有真的涨**：
 * 连续 `STALL_TRIES` 次 append 之后这条轨的已缓冲末尾没动 ⇒ 停 `STALL_BACKOFF_MS` 再试，
 * 并且**只报一次**（把"泵在原地打转"这件事写成一行，而不是让它刷满日志）。
 * 顺带这也保证了任何未知的死循环都不会把 CDN 和日志打爆。
 */
const STALL_TRIES = 3
const STALL_BACKOFF_MS = 2000
/**
 * **一次操作卡多久算"卡住"**（2026-10-04，devlog/322；长视频真机事故）。
 *
 * 用户报「40min+ 投稿点进度条跳转 ⇒ 一直加载」。现场：段表覆盖完整（918 段 / 4587s）、
 * 代理侧每一发 Range 都是 206 且首字节 30–90ms，但**音频轨从开播第 0.2 秒之后再没发过一次取数**，
 * 于是目标位置永远只有视频、没有音频 ⇒ 元素的缓冲交集为空 ⇒ 转圈到天荒地老。
 *
 * ⇒ 一条轨**卡在某个操作上**（取数不回执 / append 不 `updateend`）必须有人管：
 * 到点记一行现场并把这个操作收掉；再一个窗口还卡着就认输（调用方退回渐进式，
 * 而渐进式在长视频上只是"跳转后追赶一下"，比"永远转圈"好得多）。
 */
export const STUCK_OP_MS = 6000
/** 跳转"一条轨都没取到数据"时**允许重试几次**（每次重新开一个等待窗口，见 `pump` 的收手分支） */
export const SEEK_GIVEUP_RETRIES = 1
/**
 * 段表时刻与媒体自己 `tfdt` 的允许偏差（秒）—— **续播判据用它避开"取回刚取过的那一段"**
 * （2026-10-04，`devlog/327`）。
 *
 * 实测（`BV1esa36qEPX`，sidx 累计 vs 段内 `tfdt`）：第 249 段 +7ms、536 段 +13ms、803 段 +21ms ——
 * **段表一律比媒体自己的时间戳偏晚**，且随索引缓慢增长。后果：缓冲末尾（真实时刻）算"下一段"时，
 * "结尾越过它的第一段"**永远是刚 append 过的那一段** ⇒ 泵反复重取同一段、缓冲不长 ⇒
 * 真机"跳转后播一小段就卡住"（`追加段 803 后**缓冲没变**` 那行就是它）。
 *
 * 取值 0.5s：远大于观测到的偏差（≤ 数十毫秒），又远小于一个段长（5s）⇒ 不会真的跳过一段。
 */
export const SEG_END_TOL = 0.5
/**
 * **链路跟不跟得上**（ABR，2026-10-04，`devlog/328`）。
 *
 * 量什么：每次取段都记"这一段多少字节 / 花了多久"，做成加权均值（`bw`）。
 * 比什么：与**段表里的码率**（`table.bandwidth`，bits/s）比 —— 低于它 `SLOW_LINK_RATIO` 倍
 * 就说明这一档喂不饱，连续 `SLOW_LINK_STREAK` 段都这样才通知播放器（一次抖动不算）。
 *
 * ⚠️ **内核只报事实，不决定降档**：选哪一档、用户手动选过没有、还能降几次，都是播放器的事
 * （见 `utils/qualityAbr.ts`）；这里只给出"实测 X B/s / 需要 Y B/s"。
 */
export const SLOW_LINK_RATIO = 1.15
export const SLOW_LINK_STREAK = 3
/** 同一条轨多久最多报一次"链路跟不上"（别刷屏） */
const LINK_NOTICE_MS = 15_000

/** 链路实测（给播放器做降档决策用） */
export interface LinkSample {
  kind: string
  /** 实测吞吐（bytes/s，加权均值） */
  bytesPerSec: number
  /** 这一档需要多少（bytes/s；`0` = 段表没给码率 ⇒ 别做判断） */
  neededBytesPerSec: number
}

/** 宿主有没有 MSE（**先问它再决定要不要去后端取段表** —— 没 MSE 时那张表纯属白跑一趟）。 */
export function mseAvailable(): boolean {
  return Boolean((globalThis as { MediaSource?: unknown }).MediaSource)
}

/** `MediaSource.isTypeSupported` 的**安全包装**（没有 MSE 的宿主 ⇒ false，不抛）。 */
export function mimeSupported(mime: string): boolean {
  const MS = (globalThis as { MediaSource?: typeof MediaSource }).MediaSource
  if (!MS || typeof MS.isTypeSupported !== 'function') return false
  try {
    return Boolean(mime) && MS.isTypeSupported(mime)
  } catch {
    return false
  }
}

/**
 * 这条路能不能走 MSE（**纯判定**，不产生副作用）。
 *
 * 三个条件缺一不可：宿主有 `MediaSource`；**两条轨**的 codecs 串都被支持；
 * 两张表都有段。判据要能说出"为什么不行"—— 真机上这行字是唯一能解释
 * "为什么又退回旧内核了"的东西。
 */
export function kernelSupported(s: KernelStreams | null | undefined): { ok: boolean; why: string } {
  const MS = (globalThis as { MediaSource?: typeof MediaSource }).MediaSource
  if (!MS) return { ok: false, why: '这个环境没有 MediaSource' }
  if (!s?.video?.segments?.length) return { ok: false, why: '没有视频段表' }
  if (!s.audio?.segments?.length) {
    // ⚠️ 只有视频能走 MSE **不算成立**：音轨留在独立 `<audio>` 上就又是两个钟（旧病）
    return { ok: false, why: '没有音轨段表（只有视频走 MSE 会退回两个钟）' }
  }
  if (!mimeSupported(s.video.mime)) return { ok: false, why: `视频 codecs 不支持：${s.video.mime}` }
  if (!mimeSupported(s.audio.mime)) return { ok: false, why: `音轨 codecs 不支持：${s.audio.mime}` }
  return { ok: true, why: '' }
}

/**
 * 每段的起始时刻（秒）。
 *
 * ⚠️ **优先用后端给的精确起点 `t`**（`devlog/324`）：拿 `dur_s` 累加是**四舍五入过的**，
 * 音频每段多算 0.0005s ⇒ 531 段累计偏晚 0.26s ⇒ "该取下一段"会一直算回刚取过的那一段
 * （真机：同一段连取 3 次、缓冲不长、播 3 秒就转圈）。没有 `t`（老后端/旧夹具）时才退回累加。
 */
export function segmentStarts(table: StreamTable): number[] {
  const out: number[] = []
  let t = 0
  for (const s of table.segments) {
    out.push(typeof s.t === 'number' ? s.t : t)
    t += s.dur_s
  }
  return out
}

/** 第 `time` 秒落在哪一段（夹到有效范围；空表 ⇒ -1）。 */
export function segmentIndexAt(table: StreamTable, time: number): number {
  const n = table.segments.length
  if (!n) return -1
  const starts = segmentStarts(table)
  let lo = 0
  let hi = n - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= time) { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  return ans
}

/**
 * `time` 之后**还没进缓冲**的第一段（= 顺序续播该取的那一段）；都取完了 ⇒ 段数。
 *
 * ⚠️ **判据是"这一段的结尾是否已经越过 time"，不是"这一段的开头是否大于 time"**
 * （`devlog/313`，真机症状「点击跳转后播放一会停下、再播一会停下」的**根因**）：
 * 段是**首尾相接**的，append 完第 N 段后缓冲正好结束在第 N+1 段的**开头**上
 * ⇒ 用"开头 > time"判会**跳过第 N+1 段**，泵隔一段取一段、缓冲里每隔 5 秒一个洞
 * ⇒ 播放到洞口就饿住、补上、再撞下一个洞（实测就是这么"走走停停"的）。
 * 顺带：`remove()` 把某段切掉一半时（淘汰），这条判据也会正确地要求把它补回来。
 *
 * ⚠️ **"这一段的结尾"要取下一段的起点**（`devlog/324`）：段表里 `starts[i] + dur_s` 是**两个
 * 四舍五入值相加**，与真实边界能差出零点几秒；有精确起点时用 `starts[i+1]` 才是真边界。
 */
export function nextSegmentAfter(table: StreamTable, time: number): number {
  const starts = segmentStarts(table)
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : starts[i] + table.segments[i].dur_s
    if (end > time + 1e-3) return i
  }
  return table.segments.length
}

/** 第 `i` 段的**表内结尾**（秒；越界 ⇒ 段数以外返回 `null`）。`devlog/327` 的续播判据要用它。 */
export function segmentEndAt(table: StreamTable, i: number): number | null {
  const starts = segmentStarts(table)
  if (i < 0 || i >= starts.length) return null
  return i + 1 < starts.length ? starts[i + 1] : starts[i] + table.segments[i].dur_s
}

export interface KernelDeps {
  /** 取一段字节（默认走 `/video-proxy` 的 Range 直通）；测试可注入 */
  fetchRange?: (url: string, range: SegmentRange, signal: AbortSignal) => Promise<ArrayBuffer>
  /** 缓冲/进度变化（`bufferedEnd` 秒）—— 进度条的"已缓冲"那截靠它 */
  onProgress?: (bufferedEnd: number, currentTime: number) => void
  /** 一次 seek **真的落地**了（目标段已 append、`currentTime` 已设）⇒ 界面收起转圈 */
  onSeekApplied?: (time: number) => void
  /** 致命（这条路不成立）⇒ 调用方退回渐进式。**只报一次** */
  onFatal?: (why: string) => void
  /** 诊断一行（慢段 / 换镜像 / 淘汰） */
  log?: (line: string) => void
  createMediaSource?: () => MediaSource
  createObjectURL?: (ms: MediaSource) => string
  revokeObjectURL?: (url: string) => void
  /** seek **彻底落不了地**时的收手时间（默认 `SEEK_GIVEUP_MS`；用例用它把等待压成 0） */
  seekGiveUpMs?: number
  /** "一条轨都没取到"时重试几次（默认 `SEEK_GIVEUP_RETRIES`；用例把它压成 0/1） */
  seekGiveUpRetries?: number
  /** 一次操作卡多久算卡住（默认 `STUCK_OP_MS`；用例把它压小，别真等 6 秒） */
  stuckOpMs?: number
  /**
   * **链路跟不上这一档**（ABR，`devlog/328`）：内核量到实测吞吐持续低于段表码率时叫一次
   * （同一条轨 15s 内最多一次）。调用方据此决定降不降、降到哪一档 —— 内核不替它决定。
   */
  onLinkSlow?: (info: LinkSample) => void
}

/**
 * 默认取段：`/video-proxy` 的 Range 直通（凭据/Referer 由后端补，前端一个头都不带）。
 *
 * ⚠️ **必须验证"拿回来的确实是那一段"**（`devlog/314`）：上游若忽略 `Range`（回 200 + 整份文件，
 * P2P/mcdn 镜像上真会这样），旧实现只看 `r.ok` 就当成功 —— 于是**第 1 段的字节被当成第 N 段
 * append 进去**：数据落在错误的时刻上，`covers(目标)` 永远为假 ⇒ **一直转圈**，而泵还在
 * 一次次重取整份文件（真机上就是"日志 INFO 暴增 + 卡顿低帧率"）。
 * 判据两条：**状态必须是 206**；**长度必须正好是请求的那一段**（两处不符都换镜像/重试）。
 */
async function defaultFetchRange(url: string, range: SegmentRange,
                                signal: AbortSignal): Promise<ArrayBuffer> {
  const r = await authFetch(videoProxyUrl(url), {
    headers: { Range: `bytes=${range.start}-${range.end}` },
    signal,
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  if (r.status !== 206) {
    throw new RangeError(`上游没按 Range 给：status=${r.status}（要的是 `
      + `${range.start}-${range.end}）`)
  }
  const buf = await r.arrayBuffer()
  const want = range.end - range.start + 1
  if (buf.byteLength !== want) {
    throw new RangeError(`这一段长度不对：要 ${want}B 实得 ${buf.byteLength}B`
      + `（${range.start}-${range.end}）`)
  }
  return buf
}

function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string })?.name
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
}

/** 一条轨的运行时状态（视频/音轨各一份，结构完全相同）。 */
interface Track {
  table: StreamTable
  kind: 'video' | 'audio'
  sb: SourceBuffer | null
  /** 有一次操作在飞（`appendBuffer`/`remove`），期间的 `updateend` 才算它的回执 */
  busy: boolean
  initDone: boolean
  /** 正在取的那一段（-1 = 取 init）；`null` = 没在取 */
  pending: number | null
  inflight: AbortController | null
  /** **操作代数**：每次发起 `+1`。取数回来时代数变了 ⇒ 这次结果作废（别 append 到已经被顶掉的位置） */
  seq: number
  /** 上一条取的段序号 + **同一段连续取了几次**（防"同一段反复取"把泵转死，见 `pump`） */
  lastIdx: number
  repeat: number
  /** 这条轨**已缓冲末尾**的上一次读数（判"取数有没有真的推进"，见 `STALL_TRIES`） */
  spanEnd: number
  /** 发起这次取数时的"跑道末端"（`-1` = 这次 `updateend` 不是 append 的，别记账） */
  fetchBaseline: number
  /** 连续几次 append 之后缓冲没涨 */
  noProgress: number
  /** 没进展时的冷却截止时刻（到点前不再取数） */
  coolUntil: number
  /** "泵在原地打转"这件事**只报一次**（直到重新有进展） */
  warnedStall: boolean
  retry: number
  /** 镜像链游标：换一条就 +1（取不到时轮换，不回后端） */
  mirror: number
  quotaHits: number
  /** 当前这个操作（取数/append）是什么时候开始的（`0` = 手上没有操作）—— 卡住看门狗用它 */
  opSince: number
  /** 这条轨"卡住"报过几次（第一次只收手 + 记一行，第二次认输） */
  stuckHits: number
  /** "同一段连取两次仍没落地"这件事报过没有（`devlog/323`：这条**不许静默**） */
  warnedRepeat: boolean
  /** 取数失败/结果作废的日志节流（同一轨每秒最多一条，`devlog/325`） */
  lastFailLogAt: number
  lastDiscardLogAt: number
  /** "追加了但缓冲没变"的日志节流（`devlog/326`） */
  lastNoGrowLogAt: number
  /** 泵"什么都没做"的日志节流（`devlog/330` 的静默路径审计） */
  lastStallNoteAt: number
  /** 实测吞吐（bytes/s）的加权均值；`0` = 还没量到（`devlog/328` 的 ABR 用它） */
  bw: number
  /** 连续几段"喂不饱这一档"；喂够了就清零 */
  slowStreak: number
  /** 这条轨上一次报"链路跟不上"是什么时候（节流） */
  lastLinkNoticeAt: number
}

/**
 * MSE 内核。用法：
 * ```ts
 * const k = new MseKernel(el, { onFatal: (why) => fallback() })
 * k.load(streams)          // 建 MediaSource、挂 init、开泵
 * k.seekTo(123.4)          // **先取目标段，再设 currentTime**
 * k.destroy()
 * ```
 */
export class MseKernel {
  private readonly el: HTMLVideoElement
  private readonly deps: KernelDeps
  private readonly fetchRange: NonNullable<KernelDeps['fetchRange']>
  private streams: KernelStreams | null = null
  private ms: MediaSource | null = null
  private objectUrl = ''
  private tracks: Track[] = []
  private tick = 0
  /** 等数据到位再设 `currentTime` 的目标（第 2 条坑） */
  private pendingSeek: number | null = null
  /** 这次 seek 是什么时候提的（攒缓冲别超过 `SEEK_CUSHION_MAX_MS`） */
  private seekStartedAt = 0
  /** 这次 seek "一条轨都没数据"重试过几次（见 `pump` 的收手分支） */
  private seekRetries = 0
  private fatal = false
  private ended = false
  private dead = false
  private startedAt = 0
  private appends = 0
  private bytes = 0
  /** 淘汰日志的聚合（2s 一行、带次数，见 `evict`） */
  private evictCount = 0
  private evictLoggedAt = 0
  /** 泵"什么都没做"的日志节流（`devlog/330` 的静默路径审计） */
  private lastStallNoteAt = 0
  private onSourceOpen = () => this.open()

  constructor(el: HTMLVideoElement, deps: KernelDeps = {}) {
    this.el = el
    this.deps = deps
    this.fetchRange = deps.fetchRange ?? defaultFetchRange
  }

  /** 建 MediaSource 并开始取数。返回 false = 这条路不成立（调用方退回渐进式）。 */
  load(streams: KernelStreams): boolean {
    const ok = kernelSupported(streams)
    if (!ok.ok) { this.fail(ok.why); return false }
    const create = this.deps.createMediaSource
      ?? (() => new (globalThis as unknown as { MediaSource: new () => MediaSource }).MediaSource())
    try {
      this.ms = create()
    } catch (e) {
      this.fail(`MediaSource 建不起来：${String(e)}`)
      return false
    }
    this.streams = streams
    this.tracks = ([['video', streams.video], ['audio', streams.audio]] as const)
      .filter(([, t]) => Boolean(t))
      .map(([kind, table]) => ({
        table: table as StreamTable, kind, sb: null, busy: false, initDone: false,
        pending: null, inflight: null, seq: 0, lastIdx: -2, repeat: 0,
        spanEnd: 0, fetchBaseline: -1, noProgress: 0, coolUntil: 0, warnedStall: false,
        retry: 0, mirror: 0, quotaHits: 0, opSince: 0, stuckHits: 0, warnedRepeat: false,
        lastFailLogAt: 0, lastDiscardLogAt: 0, lastNoGrowLogAt: 0, lastStallNoteAt: 0,
        bw: 0, slowStreak: 0, lastLinkNoticeAt: 0,
      }))
    this.startedAt = Date.now()
    this.ms.addEventListener('sourceopen', this.onSourceOpen)
    const mkUrl = this.deps.createObjectURL ?? ((m: MediaSource) => URL.createObjectURL(m))
    this.objectUrl = mkUrl(this.ms)
    this.el.src = this.objectUrl
    this.tick = window.setInterval(() => this.pump(), TICK_MS)
    // 有的宿主 `sourceopen` 在 addEventListener 之前就发过了 ⇒ 直接试一次
    if (this.ms.readyState === 'open') this.open()
    return true
  }

  /** 目标时刻（秒）：**数据到位之后**才真的设 `currentTime`（第 2 条坑）。 */
  seekTo(time: number): void {
    if (this.dead || !this.streams) return
    const dur = this.duration()
    const t = Math.min(Math.max(0, time), dur > 0 ? dur - 0.05 : time)
    this.pendingSeek = t
    this.seekStartedAt = Date.now()
    this.seekRetries = 0
    for (const tr of this.tracks) {
      // 换了目标 ⇒ 上一处的"无进展"记账作废、刹车也解除（新位置值得重新试一次）
      tr.noProgress = 0
      tr.coolUntil = 0
      tr.fetchBaseline = -1
      /**
       * ⚠️ **"同一段连取两次"的记账也必须作废**（`devlog/323`）：它是"这一次判据是不是退化了"
       * 的记账，换了目标就不再成立。漏掉这一条 = 一条轨可能被**永久**冻死：
       * 真机上音频轨 `重复=2` 之后再没取过一个段，而跳转一直等到收手（无日志、无恢复）。
       */
      tr.repeat = 0
      tr.lastIdx = -2
      tr.warnedRepeat = false
      // 目标变了 ⇒ 正在取的那一段没意义了（abort 掉，别白等一个 1.5MB）
      if (tr.inflight && tr.pending !== segmentIndexAt(tr.table, t)) this.abortInflight(tr)
    }
    this.pump()
  }

  /** 时长（秒）：段表优先（`loadedmetadata` 之前界面就要显示总长）。 */
  duration(): number {
    if (this.streams?.duration_s) return this.streams.duration_s
    const d = this.el.duration
    return Number.isFinite(d) && d > 0 ? d : 0
  }

  /** 当前位置前方已缓冲多少秒（不在任何区间 ⇒ -1）。 */
  bufferedAhead(): number {
    const s = this.bufferedSpan()
    if (!s) return -1
    return s.end - this.el.currentTime
  }

  stats(): { appends: number; bytes: number; ms: number; fatal: boolean } {
    return { appends: this.appends, bytes: this.bytes,
             ms: this.startedAt ? Date.now() - this.startedAt : 0, fatal: this.fatal }
  }

  destroy(): void {
    this.dead = true
    window.clearInterval(this.tick)
    for (const tr of this.tracks) this.abortInflight(tr)
    try { this.ms?.removeEventListener('sourceopen', this.onSourceOpen) } catch { /* 已销毁 */ }
    if (this.objectUrl) {
      (this.deps.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u)))(this.objectUrl)
    }
    /**
     * 元素上的 `src` 只在我们**还是那个 blob** 时才摘。
     *
     * ⚠️ 退回渐进式时 React 已经**先**把 `src` 换成了新地址（提交顺序：DOM 变更 → effect 清理），
     * 这里无脑 `removeAttribute('src')` 会把刚设好的地址一起擦掉 ⇒ 元素**永远没源**、
     * 界面停在"点了播放没反应"（而且看不出原因）。所以先比对再摘。
     */
    const blob = this.objectUrl
    this.objectUrl = ''
    if (blob && (this.el.src === blob || this.el.currentSrc === blob)) {
      try {
        this.el.removeAttribute('src')
        this.el.load?.()
      } catch { /* jsdom/已卸载 */ }
    }
    this.ms = null
    this.tracks = []
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private fail(why: string): void {
    if (this.fatal) return
    this.fatal = true
    this.deps.log?.(`[media] MSE 不成立：${why}`)
    this.deps.onFatal?.(why)
  }

  private open(): void {
    if (!this.ms || this.dead) return
    for (const tr of this.tracks) {
      if (tr.sb) continue
      try {
        tr.sb = this.ms.addSourceBuffer(tr.table.mime)
      } catch (e) {
        this.fail(`addSourceBuffer 失败（${tr.kind}：${tr.table.mime}）：${String(e)}`)
        return
      }
      tr.sb.mode = 'segments'
      tr.sb.addEventListener('updateend', () => this.onUpdateEnd(tr))
      tr.sb.addEventListener('error', () => this.fail(`${tr.kind} SourceBuffer 报错`))
    }
    // ⚠️ 时长要**显式设**：MSE 的 `duration` 默认是 Infinity，进度条会拿不到总长
    try { this.ms.duration = this.duration() } catch { /* 某些实现对时长锁定会抛 */ }
    this.pump()
  }

  private onUpdateEnd(tr: Track): void {
    const wasPending = tr.pending
    const wasInit = wasPending === -1
    tr.busy = false
    tr.pending = null
    tr.retry = 0
    if (wasInit) tr.initDone = true
    /**
     * **进展计量**：这次 append 有没有让"**播放点前方**能连续播多久"变长。
     *
     * ⚠️ 两个坑（都是真机日志里踩出来的，`devlog/315`）：
     * ① 用"这条轨最后一段的末尾"当刻度会**误报** —— 回跳后缓冲里还留着远处那段
     *    （`目标=75.9s 该轨末=223.6s`），在播放点前面补数据永远不动它；
     * ② 只有当这次 `updateend` 是 **append** 的回执时才记账（`remove` 会让跑道变短，
     *    那是淘汰的正常后果，不该算"取数没进展"）。
     */
    if (tr.fetchBaseline >= 0) {
      const grew = this.runwayEnd(tr) > tr.fetchBaseline + 1e-3
      tr.fetchBaseline = -1
      if (grew) {
        tr.noProgress = 0
        tr.warnedStall = false
        tr.stuckHits = 0                 // 有进展 ⇒ "卡住"记账作废（devlog/322）
        tr.repeat = 0                    // 有进展 ⇒ "同一段连取两次"的记账也作废（devlog/323）
      } else {
        tr.noProgress += 1
        /**
         * ⚠️ **"追加了但缓冲没变"必须留痕**（`devlog/326`，长视频真机事故的最后一格）。
         *
         * 现场：段 716 的字节**完全正确**（moof 1904 + mdat 463722 = 表里那一段，偏移/长度/tfdt
         * 全对）、代理侧 206、`appendBuffer` 也没抛错 —— 但缓冲一点都不长，于是泵重取三次、
         * 守卫触发、退渐进式。**这一格原先没有任何日志**（`取数失败` 不覆盖它），
         * 而它才是"到底谁把数据吃了"的唯一线索。所以这里把三条判据一起写下来：
         * 这次追加的是哪一段、这条轨**全部**缓冲区间、以及 `MediaSource.duration`
         * （时长被人为调小时，Chromium 会**静默丢掉**超出部分的帧）。
         *
         * ⚠️ **init（`-1`）不算**：init 本来就不产生区间，记它只会把真正那一行挤掉（节流）。
         */
        const now = Date.now()
        if (typeof wasPending === 'number' && wasPending >= 0
            && now - tr.lastNoGrowLogAt > 1000) {
          tr.lastNoGrowLogAt = now
          this.deps.log?.(`[media] ${tr.kind} 追加段 ${wasPending} 后**缓冲没变**：`
                          + `区间=${this.rangesText(tr)} 目标=${this.target().toFixed(1)}s`
                          + ` duration=${this.ms?.duration ?? '?'}`
                          + ` 时长表=${tr.table.duration_s.toFixed(1)}s 无进展=${tr.noProgress}`)
        }
      }
    }
    this.maybeEnd()
    this.evict(tr)
    this.report()
    this.pump()
  }

  private abortInflight(tr: Track): void {
    tr.inflight?.abort()
    tr.inflight = null
    tr.pending = null
  }

  /** 目标时刻两条轨都**已经有数据**了吗（有没有音轨都算"就绪"）。 */
  private seekReady(t: number): boolean {
    return this.tracks.every((tr) => this.covers(tr, t) || this.tailDone(tr, t))
  }

  /**
   * 这条轨**已经取到尾了**（末尾那一段在缓冲里），而目标落在它之后 —— 音视频两条流的时长
   * 能差零点几秒（B站的音轨末尾补齐方式和视频不同）。
   *
   * ⚠️ 没有这条判据就会**死循环**：`covers()` 永远为假 ⇒ 泵一遍遍 append **最后一段**
   * ⇒ 微任务链不断（`flush` 那种"等一轮"的用例会**挂死**，而不是报红）。
   */
  private tailDone(tr: Track, t: number): boolean {
    const span = this.trackSpan(tr)
    if (!span) return false
    // "这条轨到头了" = 末尾那段已缓冲（`t` 落在它之后正是本函数的用途，不能拿 `t` 当条件）
    return span.end >= tr.table.duration_s - 0.2 && t > span.end - 0.02
  }

  private covers(tr: Track, t: number): boolean {
    const b = tr.sb?.buffered
    if (!b) return false
    try {
      for (let i = 0; i < b.length; i += 1) {
        if (b.start(i) - 0.05 <= t && t <= b.end(i) - 0.02) return true
      }
    } catch { /* 配额/实现异常：当作没有 */ }
    return false
  }

  private bufferedSpan(): { start: number; end: number } | null {
    const b = this.el.buffered
    if (!b || !b.length) return null
    try {
      return { start: b.start(0), end: b.end(b.length - 1) }
    } catch {
      return null
    }
  }

  /**
   * **单条轨**自己的已缓冲区间。
   *
   * ⚠️ 不能拿元素的 `buffered` 代替：元素上那个是**两条轨的交集**，而"这条轨续到哪里了"
   * 必须看它自己 —— 否则音轨领先时视频轨会以为"20 秒处已经有数据了"，泵就此停住。
   */
  private trackSpan(tr: Track): { start: number; end: number } | null {
    const b = tr.sb?.buffered
    if (!b || !b.length) return null
    try {
      return { start: b.start(0), end: b.end(b.length - 1) }
    } catch {
      return null
    }
  }

  private report(): void {
    const s = this.bufferedSpan()
    this.deps.onProgress?.(s ? s.end : 0, this.el.currentTime)
  }

  /**
   * ⚠️ **绝不调 `MediaSource.endOfStream()`**（`devlog/314`，真机"多次跳转后再跳转就一直转圈"的根因）。
   *
   * 跳到**末尾附近**会把两条轨的段全取完 ⇒ 旧实现据此调 `endOfStream()` ⇒ `readyState` 变
   * `ended` ⇒ 之后 **`appendBuffer` 抛错、而且我们自己的 `pump()` 也在开头就返回**
   * （`readyState !== 'open'`）⇒ **任何后续 seek 都永远落不了地**，界面就一直转圈
   * （连"10 秒收手"也在 pump 里，所以连兜底都不会触发）。
   *
   * 为什么不调也没事：我们把 `ms.duration` **显式设成段表时长**了 —— 时间轴是有限的，
   * 播到末尾元素自己会 `ended`、进度条也到得了尾。`endOfStream()` 只对"没有确定时长"的流
   * 才有必要（直播）。⇒ 用它换来的那点好处，远不值"seek 永久失效"这个代价。
   */
  private maybeEnd(): void {
    if (this.ended || !this.ms) return
    const done = this.tracks.every((tr) => tr.initDone && this.nextIndex(tr) >= tr.table.segments.length)
    if (!done) return
    this.ended = true                    // 只记一笔（日志用），**不**动 MediaSource 的状态
  }

  /** 该轨**下一个要 append** 的段序号（按"这条轨已缓冲到哪里"推，不看历史游标）。 */
  private nextIndex(tr: Track): number {
    const s = this.trackSpan(tr)
    if (!s) return 0
    return nextSegmentAfter(tr.table, s.end)
  }

  /** 主动淘汰：留 `KEEP_BEHIND` 秒回看，超 `MAX_BUFFER` 就砍掉前面。 */
  private evict(tr: Track, force = false): void {
    const sb = tr.sb
    if (!sb || sb.updating || tr.pending != null) return
    const b = sb.buffered
    if (!b.length) return
    let start = 0
    let end = 0
    try {
      start = b.start(0)
      end = b.end(b.length - 1)
    } catch {
      return
    }
    if (!force && end - start <= MAX_BUFFER) return
    /**
     * ⚠️ `keepFrom` 是**秒**，别拿 `init.end`（那是**字节偏移**）来比 —— 第一版就是这么写错的：
     * `Math.max(947, …)` 永远大于缓冲起点 ⇒ 淘汰一次都发生不了，长播必然撞配额。
     * init 段（`ftyp+moov`）在 MSE 里不对应任何时间区间，`remove()` 不会把它删掉，不需要保护。
     *
     * ⚠️ **锚点必须取"播放点"和"等着的跳转目标"里更靠前的那个**（`devlog/313`，真机症状
     * 「点击跳转后再点击跳转到其他位置 ⇒ 一直转圈」）：seek 期间 `el.currentTime` **还是旧位置**，
     * 拿它当锚点时"回跳"会算出 `keepFrom = 旧位置 - 25`，正好把**刚为目标取来的 [B,B+5) 删掉**
     * ⇒ `covers(B)` 永远为假 ⇒ 泵一遍遍重取、播放点永远落不了地（用例：`回跳…不许把刚取来的段淘汰`）。
     */
    const anchor = this.pendingSeek ?? this.el.currentTime
    const keepFrom = Math.max(0, Math.min(anchor, this.el.currentTime) - KEEP_BEHIND)
    if (keepFrom <= start + 1) {
      if (force) this.fail(`${tr.kind} 配额不足且没有可淘汰的区间`)
      return
    }
    tr.busy = true
    try {
      sb.remove(start, keepFrom)
      this.evictCount += 1
      // ⚠️ **别每次淘汰都写一行日志**（`devlog/314`）：短时间里连着淘汰会把日志刷满，
      //    而真问题（取数打转）反而被淹掉。2 秒最多一行，并带上这期间的次数。
      const now = Date.now()
      if (now - this.evictLoggedAt > 2000) {
        const n = this.evictCount
        this.evictCount = 0
        this.evictLoggedAt = now
        this.deps.log?.(`[media] 淘汰 ${tr.kind} ${start.toFixed(1)}–${keepFrom.toFixed(1)}s`
                        + (n > 1 ? `（近 2s 共 ${n} 次）` : ''))
      }
    } catch (e) {
      tr.busy = false
      if (!isQuotaError(e)) this.fail(`${tr.kind} 淘汰失败：${String(e)}`)
    }
  }

  /**
   * "泵在原地打转"的那一行（**一次失败只报一次**）。
   *
   * 这一行是给下一次真机复现准备的：它把内核此刻的**全部判断依据**写出来 ——
   * 目标、连续可用缓冲、这条轨自己的区间、以及卡在哪一步（`pending`/`busy`）。
   * 有了它，不用再靠猜：是"段取来了却落不到目标位置"，还是"缓冲根本没涨"。
   */
  /**
   * **一条轨卡住了**：把现场写一行，然后把这个操作收掉（`devlog/322`）。
   *
   * 为什么要它：长视频真机上出现过"音频轨从开播之后再没发过取数"，而泵**没有任何一行日志**
   * 说得出为什么 —— 没有现场就只能猜（这批之前正是这么过了好几轮）。现在三个数定格现场：
   * 手上是什么操作、这条轨缓冲到哪、段表多大 + 目标在第几段。
   *
   * 收手两次还卡 ⇒ 认输（`fail`），调用方退回渐进式 —— 长视频上渐进式只是"跳转后追赶一下"，
   * 而"永远转圈"是用户视角里最糟的失败形态。
   *
   * `force=true`：换跳转目标时的主动收手（不算"卡住"，不记账）。
   */
  private unstick(tr: Track, waitedMs: number, force = false): void {
    if (force) {
      if (tr.pending != null) this.abortInflight(tr)
      else { tr.busy = false; try { tr.sb?.abort() } catch { /* 实现不支持 */ } }
      tr.opSince = 0
      // ⚠️ 连"同一段连取两次"的记账一起作废（`devlog/323`）：不清的话，这次重试对那条轨
      //    等于**什么都没发生**（泵还是会以 `repeat >= 2` 为由拒绝取数）—— 真机就是这样白等 10s。
      tr.repeat = 0
      tr.lastIdx = -2
      tr.warnedRepeat = false
      return
    }
    if (!tr.stuckHits) {
      this.deps.log?.(`[media] ${tr.kind} 轨卡住 ${(waitedMs / 1000).toFixed(1)}s：`
                      + `手上=${tr.pending != null ? `取段 ${tr.pending}` : 'append'} `
                      + `区间=${this.spanText(tr)} 表=${tr.table.segments.length}段/`
                      + `${tr.table.duration_s.toFixed(0)}s 目标=${this.target().toFixed(1)}s`)
    }
    tr.stuckHits += 1
    tr.opSince = 0
    if (tr.stuckHits > 1) {
      this.fail(`${tr.kind} 轨连续卡住（取数与 append 都不回执，缓冲停在 ${this.spanText(tr)}）`)
      return
    }
    if (tr.pending != null) this.abortInflight(tr)       // 取数：abort 掉，泵会换镜像/重试
    else {
      // append：`SourceBuffer.abort()` 会补一次 `updateend`（规范如此）⇒ `busy` 能放开
      try { tr.sb?.abort() } catch { /* 某些实现没有 abort：那就等第二个窗口判死 */ }
    }
    this.pump()
  }

  /** 一条轨的缓冲区间（诊断用，别在别处拿它当判据 —— 那是 `aheadFor` 的活） */
  private spanText(tr: Track): string {
    const s = this.trackSpan(tr)
    return s ? `${s.start.toFixed(1)}–${s.end.toFixed(1)}s` : '无'
  }

  /**
   * 这条轨**全部**缓冲区间（最多列 3 段 + 总数）。
   *
   * ⚠️ 只有 `spanText`（首段起点–末段终点）是不够的（`devlog/326`）：真机上它显示
   * `0.0–3585.0s`，看着"覆盖了目标 3584.5s"，实际那是**首段起点与末段终点**——
   * 末段可能只是一小截尾巴（`[3584.9, 3585.0)`），目标在洞里。诊断必须看得见"洞"。
   */
  private rangesText(tr: Track): string {
    const b = tr.sb?.buffered
    if (!b || !b.length) return '无'
    const out: string[] = []
    try {
      for (let i = 0; i < Math.min(b.length, 3); i += 1) {
        out.push(`${b.start(i).toFixed(1)}–${b.end(i).toFixed(1)}`)
      }
      return `[${out.join(', ')}${b.length > 3 ? `, …` : ''}]×${b.length}`
    } catch {
      return '读不到'
    }
  }

  /** 取数失败留痕（同一轨每秒最多一条，免得刷屏）；`devlog/325` */
  private noteFetchFail(tr: Track, idx: number, e: unknown): void {
    const now = Date.now()
    if (now - tr.lastFailLogAt < 1000) return
    tr.lastFailLogAt = now
    const seg = idx >= 0 ? tr.table.segments[idx] : tr.table.init
    const range = seg ? `bytes=${seg.start}-${seg.end}` : '?'
    this.deps.log?.(`[media] ${tr.kind} 段 ${idx} 取数失败（${String(e)}）`
                    + `${range} 重试=${tr.retry} 镜像=${tr.mirror} 表=${tr.table.segments.length}段`)
  }

  /**
   * 记一次"这一段多少字节、花了多久"，并判断这条轨喂不喂得饱（ABR，`devlog/328`）。
   *
   * 加权均值（新样本 40%）而不是单段判定：CDN 抖一下就降档是错的（用户会看到画质无谓地掉）。
   * 只有**连续 `SLOW_LINK_STREAK` 段**实测吞吐都低于这一档码率的 `SLOW_LINK_RATIO` 倍，
   * 才把事实报给播放器（同一条轨 15s 内最多一次）。
   */
  private noteLinkSample(tr: Track, size: number, ms: number): void {
    const sample = size / (Math.max(ms, 1) / 1000)
    tr.bw = tr.bw > 0 ? tr.bw * 0.6 + sample * 0.4 : sample
    const needed = (tr.table.bandwidth ?? 0) / 8      // bits/s → bytes/s
    if (!needed || needed <= 0) return                // 段表没给码率 ⇒ 不猜
    if (tr.bw * SLOW_LINK_RATIO >= needed) { tr.slowStreak = 0; return }
    tr.slowStreak += 1
    if (tr.slowStreak < SLOW_LINK_STREAK) return
    const now = Date.now()
    if (now - tr.lastLinkNoticeAt < LINK_NOTICE_MS) return
    tr.lastLinkNoticeAt = now
    this.deps.onLinkSlow?.({ kind: tr.kind, bytesPerSec: tr.bw, neededBytesPerSec: needed })
  }

  /** 当前各轨的链路实测（诊断/用例用） */
  linkStats(): LinkSample[] {
    return this.tracks.map((tr) => ({
      kind: tr.kind, bytesPerSec: tr.bw,
      neededBytesPerSec: (tr.table.bandwidth ?? 0) / 8,
    }))
  }

  /**
   * 泵"什么都不做"时把原因写一行（同一条原因 5s 内最多一条）。
   *
   * 为什么值得单独一个方法：内核里有若干"安静地 return"的分支，它们**不是错误**，
   * 但一旦长期停在那儿，从日志上完全看不出发生了什么（前三轮真机排查都在这一格上耗过）。
   */
  private noteStalled(why: string): void {
    const now = Date.now()
    if (now - this.lastStallNoteAt < 5000) return
    this.lastStallNoteAt = now
    this.deps.log?.(`[media] 泵停手：${why}`)
  }

  /** 取回来了但"已经没人要"（拖拽换代 / 被中止）也要留痕；`devlog/325` */
  private noteDiscard(tr: Track, why: string): void {
    const now = Date.now()
    if (now - tr.lastDiscardLogAt < 1000) return
    tr.lastDiscardLogAt = now
    this.deps.log?.(`[media] ${tr.kind} ${why}（区间=${this.spanText(tr)}）`)
  }

  private target(): number {
    return this.pendingSeek ?? this.el.currentTime
  }

  /**
   * 跳转收手时的**每轨现场**（一行装下）。
   *
   * 这一行是给下一次真机复现准备的 —— 长视频那次的全部结论（哪条轨没数据、
   * 它是不是卡在操作上、段表覆盖到哪、目标该落第几段）都要能从这一行读出来。
   */
  private seekDetail(seek: number): string {
    return this.tracks.map((tr) => {
      const want = segmentIndexAt(tr.table, seek)
      return `${tr.kind}[可用=${this.aheadFor(tr, seek).toFixed(1)}s 区间=${this.spanText(tr)}`
        + ` 手上=${tr.pending != null ? `取${tr.pending}` : tr.busy ? 'append' : '-'}`
        + ` 该取=${want}/${tr.table.segments.length} 重试=${tr.retry} 重复=${tr.repeat}`
        + ` 无进展=${tr.noProgress}]`
    }).join(' ')
  }

  private stallLine(tr: Track): string {
    const target = this.pendingSeek ?? this.el.currentTime
    return `[media] 泵无进展(${tr.kind}) 目标=${target.toFixed(1)}s 可用=${this.aheadFor(tr, target).toFixed(1)}s`
      + ` 该轨末=${(this.trackSpan(tr)?.end ?? 0).toFixed(1)}s 段=${tr.pending ?? '-'}`
      + ` 共取=${this.appends}次/${(this.bytes / 1048576).toFixed(1)}MB`
  }

  private async append(tr: Track, idx: number): Promise<void> {
    const sb = tr.sb
    if (this.dead || !this.streams) return          // 销毁/未就绪：安静退出是对的
    if (!sb) {
      // 这条轨还没有 SourceBuffer（不该发生，但发生时此前是**完全静默**的）
      this.noteStalled(`${tr.kind} 轨没有 SourceBuffer`)
      return
    }
    /**
     * 同一段连着取第二次 ⇒ 记一笔（`pump` 用它设上限：泵**不许无限转**）。
     *
     * ⚠️ **init（`idx=-1`）不参与这个记账**（`devlog/323`，长视频真机事故的根因）：
     * 跳转期间 init 被 abort 重取是正常事，而 `lastIdx/repeat` 是给**媒体段**防打转用的 ——
     * 混在一起时，一次 init 重试就能把某条轨的媒体取数**永久冻住**
     * （真机：`audio[重复=2]` ⇒ 之后再也不为它取一个段、一行日志都没有，整个跳转等到天荒地老）。
     */
    if (idx >= 0) {
      if (tr.lastIdx === idx) tr.repeat += 1
      else { tr.lastIdx = idx; tr.repeat = 0 }
    }
    const seg = idx < 0 ? tr.table.init : tr.table.segments[idx]
    const urls = (tr.table.urls ?? []).filter(Boolean)
    if (!urls.length) urls.push(tr.table.url)
    const url = urls[Math.min(tr.mirror, urls.length - 1)]
    const ac = new AbortController()
    tr.inflight = ac
    tr.pending = idx
    const my = ++tr.seq
    const timeout = window.setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
    const t0 = Date.now()
    let buf: ArrayBuffer | null = null
    try {
      buf = await this.fetchRange(url, seg, ac.signal)
    } catch (e) {
      window.clearTimeout(timeout)
      /**
       * ⚠️ **代数变了就闭嘴**（`devlog/312` 的连续拖拽）：拖拽时前一个目标的取数会晚回来，
       * 若照着它继续 append，就会把**旧位置的数据**塞进新位置的计划里 ——
       * 轻则白取一次，重则和当前那次操作撞成 `InvalidStateError`（假 SB 会当场抛出来）。
       *
       * ⚠️ 但**"闭嘴"必须留痕**（`devlog/325`）：真机上出现过"三次取数一发都没到代理、
       * 日志里一个字都没有" —— 正是这里和下面那条 AbortError 分支把它吞了的。
       * 现在每次作废都记一行（同一轨每秒最多一条，不刷屏）。
       */
      if (this.dead || tr.seq !== my) {
        this.noteDiscard(tr, `取段 ${idx} 的结果作废（代数变了：${tr.seq}≠${my}）`)
        return
      }
      tr.inflight = null
      if ((e as { name?: string })?.name === 'AbortError' && tr.pending !== idx) {
        tr.pending = null
        this.noteDiscard(tr, `取段 ${idx} 被中止（目标已换）`)
        this.pump()
        return
      }
      tr.pending = null
      tr.retry += 1
      /**
       * ⚠️ **取数失败一律留痕**（`devlog/325`）：原实现只有"镜像 >1 且还有下一条"时才写日志，
       * 单镜像或镜像用尽时**完全静默**（真机那三次就是在这一格里消失的）。
       */
      this.noteFetchFail(tr, idx, e)
      if (urls.length > 1 && tr.mirror + 1 < urls.length) {
        tr.mirror += 1
        this.deps.log?.(`[media] ${tr.kind} 段 ${idx} 取不到（${String(e)}），换镜像 ${tr.mirror}`)
      } else if (tr.retry >= MAX_RETRY) {
        this.fail(`${tr.kind} 段 ${idx} 连续 ${tr.retry} 次取不到：${String(e)}`)
        return
      }
      this.pump()
      return
    }
    window.clearTimeout(timeout)
    if (this.dead || tr.seq !== my) return      // 同上：这一份数据已经没人要了
    tr.inflight = null
    if (this.dead) return
    if (buf === null) { tr.pending = null; return }
    const ms = Date.now() - t0
    const size = buf.byteLength
    this.bytes += size
    // 段长不对/上游没给 Range 这一类的错**自带解释**（见 `defaultFetchRange`）⇒ 换镜像而不是吞掉
    if (size !== seg.end - seg.start + 1) {
      tr.pending = null
      this.deps.log?.(`[media] ${tr.kind} 段 ${idx} 数据不对：要 ${seg.end - seg.start + 1}B `
                      + `实得 ${size}B —— 换下一条镜像`)
      if (tr.mirror + 1 < urls.length) tr.mirror += 1
      else tr.retry += 1
      if (tr.retry >= MAX_RETRY) this.fail(`${tr.kind} 段 ${idx} 反复拿不到正确数据`)
      this.pump()
      return
    }
    if (ms > SLOW_SEGMENT_MS || (ms > 200 && size / (ms / 1000) < SLOW_SEGMENT_BYTES_PER_S)) {
      this.deps.log?.(`[media] ${tr.kind} 段 ${idx} 取数 ${ms}ms ${(size / 1048576).toFixed(2)}MB`
                      + `（${(size / 1048576 / (ms / 1000)).toFixed(2)}MB/s）`)
    }
    this.noteLinkSample(tr, size, ms)
    try {
      sb.appendBuffer(buf)
      this.appends += 1
      // 记账基准：这一次 append 之前"播放点前方有多长"，`updateend` 时比一比（见 `onUpdateEnd`）
      tr.fetchBaseline = this.runwayEnd(tr)
    } catch (e) {
      tr.pending = null
      if (isQuotaError(e)) {
        tr.quotaHits += 1
        // ⚠️ 配额这条路原先也是**静默**的（前三次只在心里记一笔）；`devlog/326`：要说出来
        this.deps.log?.(`[media] ${tr.kind} 配额不足第 ${tr.quotaHits} 次（先淘汰再重试）`
                        + ` 区间=${this.rangesText(tr)} duration=${this.ms?.duration ?? '?'}`)
        if (tr.quotaHits > 3) { this.fail(`${tr.kind} 配额反复不足（淘汰也救不回来）`); return }
        this.evict(tr, true)
      } else {
        this.fail(`${tr.kind} appendBuffer 失败：${String(e)}`)
      }
      return
    }
    // appendBuffer 是同步返回、**异步完成** ⇒ `busy` 由 `updateend` 清
    tr.busy = true
  }

  /**
   * 泵：每次只推进"一条轨的一个操作"（第 1 条坑）。
   *
   * 优先级：① 把 seek 目标那一段先 append（用户等的是它）；② 目标之后按顺序续播到
   * `WANT_AHEAD`；③ 都够了就顺手淘汰。
   */
  private pump(): void {
    if (this.dead || this.fatal) return
    /**
     * ⚠️ **"泵什么都不做"的原因也必须留痕**（`devlog/330` 的静默路径审计）。
     *
     * 前三轮真机排查的共同教训：内核里有好几处"安静地 return"，出问题时日志一片空白、
     * 只能靠猜。`MediaSource` 一旦不是 `open`（比如 blob 源被摘掉/被别处替换），
     * 泵就**永远**不再取数 —— 而此前这里一个字都不写。
     */
    if (!this.ms || this.ms.readyState !== 'open') {
      this.noteStalled(`MediaSource 不可用（readyState=${this.ms?.readyState ?? '没有'}）`)
      return
    }
    const seek = this.pendingSeek
    for (const tr of this.tracks) {
      if (tr.busy || tr.pending != null) {
        // **卡住看门狗**（devlog/322）：手上这个操作迟迟不回执 ⇒ 收手，别让泵静默空转
        const now0 = Date.now()
        if (!tr.opSince) tr.opSince = now0
        if (now0 - tr.opSince > (this.deps.stuckOpMs ?? STUCK_OP_MS)) {
          this.unstick(tr, now0 - tr.opSince)
        }
        continue
      }
      tr.opSince = 0
      if (!tr.initDone) { void this.append(tr, -1); continue }
      // **没进展就刹车**（见 `STALL_TRIES`）：否则"判据退化 ⇒ 一直取同一段"会把 CDN 与日志打爆
      const now = Date.now()
      if (now < tr.coolUntil) continue
      if (tr.noProgress >= STALL_TRIES) {
        tr.coolUntil = now + STALL_BACKOFF_MS
        tr.noProgress = 0
        if (!tr.warnedStall) {
          tr.warnedStall = true
          this.deps.log?.(this.stallLine(tr))
        }
        continue
      }
      const target = seek ?? this.el.currentTime
      /**
       * ⚠️ **"前方有多少"必须从播放点起算连续的那一段**，不能拿"最后一段的末尾"糊弄
       * （`devlog/313`，症状「播放一会停下、再播一会停下」的第二条根因）：
       * 回跳之后缓冲里还留着**远处**那段（[150,170)），按最后一段算就会得出"前方还有 150 秒"
       * ⇒ 泵整段不补数 ⇒ 播完手里那 5 秒就饿住、补一段、再饿住。旧实现就是这么"走走停停"的。
       */
      const ahead = this.aheadFor(tr, target)
      if (ahead <= 0) {
        // 目标位置**没有数据**（或正好是空洞）⇒ 直接补覆盖它的那一段（顺序续播在这时是错的）
        // ⚠️ 两条兜底，都是为了"泵**永远不许**无限转"（挂死的用例比红的用例难查得多）：
        //    ① 这条轨已到尾（音轨比视频短）⇒ 别再 append 最后一段；
        //    ② 同一段连取两次还是盖不上 ⇒ 当它到头了。
        // ⚠️ 但②**不许静默**（`devlog/323`）：真机上它把音频轨冻死过 —— 说一句，然后交给
        //    跳转收手那条路去判"认输"（`seekDetail` 里那个 `重复=` 就是它）。
        const want = segmentIndexAt(tr.table, target)
        if (want >= 0 && !this.tailDone(tr, target)) {
          if (tr.repeat < 2) void this.append(tr, want)
          else if (!tr.warnedRepeat) {
            tr.warnedRepeat = true
            const seg = tr.table.segments[want]
            this.deps.log?.(`[media] ${tr.kind} 段 ${want}（bytes=${seg?.start}-${seg?.end}）`
                            + `连取 ${tr.repeat + 1} 次仍没落地（区间=${this.rangesText(tr)}`
                            + ` 目标=${target.toFixed(1)}s duration=${this.ms?.duration ?? '?'}）`
                            + `—— 这条路给不出这个位置的数据，改用渐进式`)
            /**
             * ⚠️ **不许停在这里装死**（`devlog/325`）：真机上这一停就是"画面冻住、声音还在放"
             * （音频轨自己有数据 ⇒ 元素继续走时钟），而且**再也不会自愈**（这条轨此后不再取数）。
             * MSE 给不出这个位置的数据 = 这条路对它不成立 ⇒ 如实认输，让调用方退渐进式
             * （浏览器自己的解复用器能把这一段放出来）。
             */
            this.fail(`${tr.kind} 段 ${want} 连取 ${tr.repeat + 1} 次都落不了地`
                      + `（bytes=${seg?.start}-${seg?.end}）`)
          }
        }
        continue
      }
      if (ahead >= WANT_AHEAD) continue
      const runway = target + ahead
      let next = nextSegmentAfter(tr.table, runway)
      /**
       * ⚠️ **别把刚取过的那一段再取一遍**（`devlog/327`）。
       *
       * 段表的累计时刻比媒体自己的 `tfdt` **偏晚几十毫秒**（实测 249/536/803 段：+7/+13/+21ms），
       * 于是"缓冲末尾（真实时刻）之后的第一段"永远是**刚 append 过的那一段** ⇒ 泵反复重取、
       * 缓冲一点都不长 ⇒ 真机"跳转后播一小段就卡住、再点别处也一样"。
       *
       * 判据刻意做窄：**只有**"算出来的正是刚取过的那一段、且它的表内结尾只比缓冲末尾晚
       * 一点点（< `SEG_END_TOL`，远小于一个段长）"时才往后推一段 —— 既不会跳过真正缺的那一段，
       * 也把这次重复取数省掉。
       */
      const endOfNext = segmentEndAt(tr.table, next)
      if (next === tr.lastIdx && endOfNext !== null && endOfNext - runway < SEG_END_TOL) {
        next += 1
      }
      if (next >= tr.table.segments.length) continue
      // ⚠️ 同一条兜底也要落在**这条**分支上（`devlog/313`）：判据一旦退化成"永远差一点"，
      //    这里就会无限取同一段（真机上表现为内存与请求一起飞 —— 实测把测试进程 OOM 掉了）。
      if (tr.repeat < 2) void this.append(tr, next)
    }
    if (seek != null) {
      const waited = Date.now() - this.seekStartedAt
      const ready = this.seekReady(seek)
      const giveUp = this.deps.seekGiveUpMs ?? SEEK_GIVEUP_MS
      // 到点还没到位 ⇒ 收手
      if (!ready && waited < giveUp) return
      if (!ready) {
        /**
         * **等着的时候一条轨都没覆盖目标 ⇒ 不许把播放点挪进洞里**（`devlog/322`，长视频真机事故）。
         *
         * ⚠️ 先纠正一个曾经想当然的判据：`!ready` 的定义就是"**每条轨**都没覆盖目标"，
         * 所以这里**不可能**"还有数据可放"（老代码那句"先把播放点挪过去"在下到这个分支时
         * 只是把时间设到没数据的地方 —— 元素停在等数据状态，界面转圈照旧，而内核不再重试
         * ⇒ 用户看到的就是**永远转圈**）。两档：
         *   · 还有重试额度：把两条轨卡住的操作收掉，重开一个等待窗口；
         *   · 重试也没用：**如实认输**（`fail` ⇒ 调用方退回渐进式；长视频上渐进式只是
         *     "跳转后追赶一下"，而"永远转圈"是用户视角里最糟的失败形态）。
         */
        const detail = this.seekDetail(seek)
        if (this.seekRetries < (this.deps.seekGiveUpRetries ?? SEEK_GIVEUP_RETRIES)) {
          this.seekRetries += 1
          this.deps.log?.(`[media] 跳转 ${seek.toFixed(1)}s 等了 ${(waited / 1000).toFixed(0)}s `
                          + `仍**一条轨都没有数据**（${detail}）—— 收手重试 ${this.seekRetries} 次`)
          for (const tr of this.tracks) this.unstick(tr, 0, true)
          this.seekStartedAt = Date.now()
          this.pump()
          return
        }
        this.fail(`跳转 ${seek.toFixed(0)}s 反复取不到数据（${detail}）`)
        return
      }
      if (ready) {
        /**
         * **攒够再落地**（`SEEK_CUSHION`）：只有目标那一段（5s）就走，接下来必然是
         * "放 5 秒停 3 秒"的循环。攒不够也**不能无限等**（真机网络最差时一段要 4.8 秒），
         * 所以有 `SEEK_CUSHION_MAX_MS` 的上限，超时就用手里有的开播。
         */
        const ahead = this.aheadAt(seek)
        // 两条**不用再等**的例外：① 两条轨的段都取完了（后面永远不会有数据，尾部就是这种情况）；
        // ② 超时。
        const exhausted = this.tracks.every(
          (tr) => tr.initDone && this.nextIndex(tr) >= tr.table.segments.length)
        if (ahead < SEEK_CUSHION && !exhausted && waited < SEEK_CUSHION_MAX_MS) return
        if (ahead < SEEK_CUSHION && !exhausted) {
          this.deps.log?.(`[media] 跳转 ${seek.toFixed(1)}s：等了 ${(waited / 1000).toFixed(1)}s `
                          + `只有 ${ahead.toFixed(1)}s 缓冲（取数跟不上实时码率）`)
        }
      }
      this.pendingSeek = null
      this.seekRetries = 0
      this.el.currentTime = seek
      this.deps.onSeekApplied?.(seek)
      this.report()
      // 一次 seek 一行（只有慢到 0.5s 以上才写）：真机上"跳转要多久"要和代理那侧的行对得上
      if (waited > 500) {
        this.deps.log?.(`[media] 跳转 ${seek.toFixed(1)}s 落地：用时=${(waited / 1000).toFixed(1)}s `
                        + `缓冲=${this.aheadAt(seek).toFixed(1)}s 段取=${this.appends}次`)
      }
    }
  }

  /**
   * 这条轨**从播放点（或等着的跳转目标）起算**能连续播到哪一刻（秒）。
   *
   * 这是"进展"的正确刻度：`trackSpan().end` 会被**远处残留的区间**带偏（回跳之后尤其明显）。
   */
  private runwayEnd(tr: Track): number {
    const target = this.pendingSeek ?? this.el.currentTime
    return target + this.aheadFor(tr, target)
  }

  /**
   * **单条轨**从 `t` 起**连续**可用的秒数（`t` 不在任何区间里 ⇒ 0）。
   *
   * ⚠️ 这是"前面还有多少能播"的**唯一正确算法**：`trackSpan().end - t` 会被远处的区间骗
   * （回跳后缓冲里同时有 [20,25) 和 [150,170) ⇒ 那个算法说"前方 150 秒"，实际只有 5 秒）。
   */
  private aheadFor(tr: Track, t: number): number {
    const b = tr.sb?.buffered
    if (!b || !b.length) return 0
    try {
      for (let i = 0; i < b.length; i += 1) {
        if (b.start(i) - 0.05 <= t && t <= b.end(i) + 0.05) {
          return Math.max(0, b.end(i) - t)
        }
      }
    } catch {
      return 0
    }
    return 0
  }

  /**
   * 目标时刻之后**两条轨都可用**的缓冲秒数（取小的那个；某条轨还没盖上 ⇒ 0）。
   *
   * ⚠️ 这里必须看**每条轨自己**的区间：元素级 `buffered` 是交集，而"我刚取来的那段在不在"
   * 是单轨的事实（`devlog/312` 的 `trackSpan` 同理）。
   */
  private aheadAt(t: number): number {
    let min = Number.POSITIVE_INFINITY
    for (const tr of this.tracks) {
      if (this.tailDone(tr, t)) continue          // 这条轨到头了：不拖后腿
      min = Math.min(min, this.aheadFor(tr, t))
    }
    return Number.isFinite(min) ? min : SEEK_CUSHION
  }
}
