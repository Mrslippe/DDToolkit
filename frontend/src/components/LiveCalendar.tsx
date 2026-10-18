import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
         CalendarPlus, Eraser, Link2, Plus, Sparkles } from 'lucide-react'
import type { LiveSession, UpcomingReservation } from '../api/types'
import { api } from '../api/api'
import OverlayScroll from './OverlayScroll'
import FloatPill from './common/FloatPill'
import StateBlock from './common/StateBlock'
import { LIVE_TYPE_ORDER, liveTypeLabel } from '../utils/liveType'
import { countByType, dimmedKeys } from '../utils/liveCalendarFilter'
import { cellBadge, groupReservationsByDay, reservationLine } from '../utils/reservationDays'
// 纯展示格式化已搬到 components/live/（可 vitest 直测）；此处只保留渲染/交互常量
import { calendarSourceLabel, dayKeyIso, fmtDur, fmtMoney, fmtMonth, fmtTime, keyOf } from './live/liveCalendarFmt'
// 取数与状态机已搬到 components/live/useLiveSessions（见其文件顶部的顺序契约说明）
import {
  POP_CLOSE_GRACE_MS, useLiveSessions,
} from './live/useLiveSessions'
import type { PopState } from './live/useLiveSessions'
import { useReservations } from './live/useReservations'
// 场次详情弹窗（含词云与破泡状态）已搬到 components/live/LiveSessionDialog
import LiveSessionDialog from './live/LiveSessionDialog'
// 手动记录/编辑一场（B2，devlog/454）：日历工具栏的「+」与详情弹窗的铅笔共用同一个表单
import ManualSessionDialog from './live/ManualSessionDialog'
import ReservationDialog from './live/ReservationDialog'
import VodDialog from './live/VodDialog'
// 录播批量填充（B4，`docs/plans/vod-autofill.md`）：工具栏 `+` 是它的入口
import VodFillDialog from './live/VodFillDialog'
// 录播号设置（B4）：`+` 下拉的第三项，就地改（用户 2026-10-15 第 2 条）
import VodAccountDialog from './live/VodAccountDialog'
import ConfirmDialog from './live/ConfirmDialog'
import NavMenu from './live/NavMenu'
import VodPlayerDialog from './live/VodPlayerDialog'
/* ⚠️ 纯函数 `vodTarget` 与本组件的 state `vodTarget`（目标场次）**同名** ——
   这里别名导入，免得读代码时把"解析地址"和"选中的那一场"看成一件事 */
import { vodTarget as parseVodTarget } from './live/manualSessionForm'
import { openPlayerWindow } from '../utils/shellBridge'

interface Props {
  /** 账号 id（null=无账号，显示空态）；切换账号自动重拉。
   *  user 2026-09-07：默认只检索「主账号」直播信息（调用方传 heroAcc=
   *  bilibili 优先账号，见 PostsPage）；其他账号作为可选项，入口待以后做。 */
  accountId: number | null
  /** 该账号所属 V 的 id（R13）：未来预约是 **V 级**的（同一 V 多账号共用），
   *  所以按 V 取数而不是按账号；null = 取不到预约（日历照常渲染） */
  vtuberId?: number | null
  /** 刷新信号（fetch-idle 边沿后重拉场次） */
  refreshTick?: number
  /** 这个 V 的**录播号**（C1，f015）：不是场次上的东西，由页面从 V 列表传下来。
   *  存完要重取 V 列表才能回显 ⇒ 页面得给 `onVodAccountSaved` 一个刷新回调。 */
  vodAccountUid?: string | null
  onVodAccountSaved?: (mids: string) => void | Promise<void>
  /** 场景预取抢跑的那一份场次（2026-10-13）—— **只当首帧种子**，见
   *  `useLiveSessions` 的同名参数说明。为 null 时与本参数不存在完全等价。 */
  seedSessions?: LiveSession[] | null
}

/** 英文表头（设计稿 Frame10612 规格） */
const WEEKDAYS_EN = ['Mon.', 'Tue.', 'Wed.', 'Thu.', 'Fri.', 'Sat.', 'Sun.']
/** 月份浮窗：12 月中文名 */
const MONTH_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

type CellState = 'live' | 'tbd'

interface DayCell {
  date: Date
  key: string
  /** 属于当前月（false=上/下月补位）——透明度只由它决定（user 2026-09-06） */
  inMonth: boolean
  sessions: LiveSession[]
  /** 当日未来预约（R13；服务端已过滤已结束/已过期，按时刻升序） */
  reservations: UpcomingReservation[]
  isToday: boolean
  state: CellState
}

// `PopState` / `DetailState` / `POP_CLOSE_GRACE_MS` 随取数状态机一起搬到
// `components/live/useLiveSessions.ts`，此处改为从那里 import（类型定义只有一处）。
/**
 * 直播日历（v0.9.2 重建 → v0.9.x M4 内容管道）：
 * - 卡片 870 定宽上限居中（用户参数）；网格 7 列 × 115.714286px + 4px 列/行距
 *   （v0.9.x 审美对齐：2px→4px 密度），6 行 42 格；
 * - 格子 73.1667px 高（v0.9.x 用户：内容拥挤，行高 +4px，卡高 566→590）/ 6px 圆角；
 * - 今天 = 1px 粉描边 rgba(251,119,161,.8)（v0.9.x 审美对齐：设计稿灰描边 → 项目强调粉）；
 * - 透明度 = 月份指示（user）：非本月补位格整体 opacity 0.3，本月格一律实底——与是否有直播无关；
 * - 导航栏（项目浮片族 token：斜切白卡浮片三连——左双箭头+月份+右双箭头，中间点击弹月份选择浮窗）；
 * - 导航栏右侧 = 当月类型统计胶囊（frame 10_642：彩色胶囊 + 计数，服务端 category 口径，仅非零项）；
 * - M4 内容（数据管道 M1-M3 后端闭环后）：
 *   · 格内按最开始布局单场呈现：时间行（HH:MM 真实分钟）+ 右侧「N 场」当日场次计数 + 单行标题
 *     （颜色跟随格类型色系：游戏蓝/杂谈黄/观影紫/投稿绿…，user 2026-09-07）；
 *   · hover 格子 → 浮层（当日全量：起止/时长/标题/类型/分区/收益/峰值在线/弹幕/数据源），
 *     鼠标滑向浮层有 120ms 宽限不闪关；Esc 关闭；保持纯信息展示（user 2026-09-07：
 *     分类校正移出浮层 → 点击日期格进详情弹窗）；
 *   · 点击日期格 → 独立详情弹窗（user 2026-09-07）：
 *     直播信息（起止/分区/收益/峰值/弹幕/数据源/中断段数）+ 分类校正（点左上角胶囊 →
 *     下拉栏全部彩色分类胶囊，点选取；override 源）+
 *     「弹幕信息」（danmakus /api/v2/live 词云与总量，2026-09-07 已接入）+
 *     「直播内容分析」预留区块（analysis 接口先留，内容之后再做）；
 *   · 月份切换滑动动画（user 2026-09-07：前进/后退方向感，keyed 重放）；
 *   · 无场次的格子：今天以前 = 「休息」；今天及以后 = 「待定」（user 2026-09-07）；
 *   · 礼物数据暂不展示（user 2026-09-07：之后从 danmakus 取场次级详细数据；
 *     浮层「收益」即 danmakus 场次级），格内礼物行/当日礼物合计已退役；
 *   · 类型徽章/统计用后端 category（v2 多信号：校正>系列>标题评分>词库>分区>纪念日），
 *     服务端缺失时前端关键词兜底。
 */
const LiveCalendar = memo(function LiveCalendar(
  { accountId, vtuberId = null, refreshTick = 0,
    vodAccountUid = null, onVodAccountSaved, seedSessions = null }: Props,
) {
  const now = new Date()
  /** 场次浮层：点击格子的锚点（rect 快照）与当日数据。
   *  留在组件侧 —— 它承载 DOM rect，与渲染强耦合；hook 只通过 `onDataRefresh` 通知关闭。 */
  const [pop, setPop] = useState<PopState | null>(null)
  /** 取数与派生状态（月份/场次/详情/分类下拉/月份浮窗）——见 hooks 文件顶部的顺序契约说明。
   *  `now` 每次渲染现取：保持"todayKey 随渲染更新"的既有语义。 */
  const {
    ym, setYm, sessions, allSessions, loading, error, setError, navDir, setNavDir,
    detail, setDetail, catPopOpen, setCatPopOpen, catPopRef,
    monthPopOpen, setMonthPopOpen, popYear, setPopYear, navRef,
    typeFilter, setTypeFilter, reload, reloadDetail,
  } = useLiveSessions(accountId, refreshTick, now, () => setPop(null), seedSessions)

  /** 未来预约（R13）：V 级数据，独立于场次取数（见 useReservations 顶部说明）。
   *  `reload` 给"手动记了一条预约"用（2026-10-13）：刚保存完格子上要立刻出现。 */
  const { list: reservations, reload: reloadReservations } =
    useReservations(vtuberId, refreshTick)

  /**
   * 手动记录/编辑弹窗（B2，devlog/454）。
   *
   * `target === null` = 新建（工具栏的「+」），非空 = 编辑那一场（详情弹窗的铅笔）。
   * 用一个状态装"弹窗开着没 + 目标是哪一场"，而不是两个布尔 —— 两处入口共用同一个表单，
   * 拆成两个状态就会出现"开着但不知道在编辑谁"的中间态。
   */
  const [manualOpen, setManualOpen] = useState(false)
  const [manualTarget, setManualTarget] = useState<LiveSession | null>(null)
  /** 新建时的默认日期（点空日期格进来时是那一格；工具栏「+」为 null = 今天） */
  const [manualDay, setManualDay] = useState<string | null>(null)
  /** 记录预约的弹窗（2026-10-13）：点未来空日期格进来 */
  const [resvOpen, setResvOpen] = useState(false)
  const [resvDay, setResvDay] = useState('')
  /** 「添加录播」小窗（3.2）：详情弹窗封面上的 ＋ 打开它 */
  const [vodOpen, setVodOpen] = useState(false)
  const [vodTarget, setVodTarget] = useState<LiveSession | null>(null)
  /** 「录播填充」审查窗（B4）：工具栏 `+` 的第一项。打开即扫（`vod-scan` 只读） */
  const [fillOpen, setFillOpen] = useState(false)
  /** 「录播号」设置小窗（B4，用户 2026-10-15 第 2 条）：`+` 下拉的第三项就地改 */
  const [acctOpen, setAcctOpen] = useState(false)
  /** 「清空已匹配」的二次确认（用户要求放进 `+` 下拉栏）：先 dry-run 数一遍再确认。
   *  `manual > 0` 时确认窗要多说一句 —— 用户口径是**全清**，手填的也会没。 */
  const [clearAsk, setClearAsk] = useState<{ toClear: number; auto: number; manual: number;
                                             untracked: number } | null>(null)
  /** 正在清空（危险动作不能连点两下） */
  const [clearing, setClearing] = useState(false)
  /** 录播播放器（3.2）：封面上的 ▶ 打开它 */
  const [playerOpen, setPlayerOpen] = useState(false)
  const [playerTarget, setPlayerTarget] = useState<LiveSession | null>(null)

  const resvByDay = useMemo(() => groupReservationsByDay(reservations), [reservations])

  const byDay = useMemo(() => {
    const m = new Map<string, LiveSession[]>()
    /* ⚠️ T4（2026-10-12）：这里必须用 `allSessions`（全量）。日期格上"这一格有几场"
       与筛选条的计数都从 `cells` 派生 —— 用筛过的集合会让**未选中类型的那一天显示成空**，
       而用户会以为那一天真的没有直播（"筛选"看起来像"删数据"）。 */
    for (const sess of allSessions) {
      const d = new Date(sess.start_at)
      if (Number.isNaN(d.getTime())) continue
      const k = dayKeyIso(d)
      const list = m.get(k)
      if (list) list.push(sess)
      else m.set(k, [sess])
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.start_at.localeCompare(b.start_at))
    }
    return m
  }, [allSessions])

  const todayKey = dayKeyIso(now)

  /** 礼物/跨天展示已退役（user 2026-09-07：礼物数据暂不展示，之后取 danmakus 场次级详细数据）。
   *  42 格固定 6 行（设计稿）：首行从当月 1 号所在周一周起，含上/下月补位 */
  const cells = useMemo(() => {
    const first = new Date(ym.y, ym.m, 1)
    const startWeekday = (first.getDay() + 6) % 7 // 周一=0
    const start = new Date(ym.y, ym.m, 1 - startWeekday)
    const out: DayCell[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      const key = dayKeyIso(d)
      const list = byDay.get(key) ?? []
      const inMonth = d.getMonth() === ym.m
      const isToday = key === todayKey
      // 状态：有场次=live；无场次=tbd（休息/待定在渲染层按今天前后区分）
      const state: CellState = list.length > 0 ? 'live' : 'tbd'
      out.push({ date: d, key, inMonth, sessions: list, reservations: resvByDay.get(key) ?? [],
                 isToday, state })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ym, byDay, resvByDay])

  /** 当月类型统计（导航栏右侧统计胶囊，服务端 category 口径，仅非零项）
   *
   *  ⚠️ T4（2026-10-12）：统计集合来自 `cells`（由 `allSessions` 派生，**全量**）而不是
   *  `sessions`（已筛）—— 否则选中「歌回」之后其余类型的计数会凭空消失，用户就没法再
   *  切到别的类型了。胶囊本身现在也是**筛选按钮**（点一下只留这一类，再点取消）。
   *  规则住在 `utils/liveCalendarFilter.ts`（纯函数、有单测）。 */
  const monthStats = useMemo(
    () => countByType(
      cells.filter((c) => c.inMonth).flatMap((c) => c.sessions),
      LIVE_TYPE_ORDER.map((t) => t.key),
    ),
    [cells],
  )

  /** 点一下类型胶囊 = 只留这一类；再点 = 取消（空数组 = 不筛）。
   *  多选累加：先点「游戏」再点「观影」⇒ 两类都留（"看哪些"是他自己配的）。 */
  const toggleType = (key: string) => {
    setTypeFilter((prev) => (
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    ))
  }

  /** 渲染用的日期格：**不再替换场次**（2026-10-13 用户口径）。
   *
   * 原来筛掉的类型整格变成「休息」—— 用户看到的是一张"别的日子都没直播"的假日历；
   * 现在**保留**全部场次，只把"不含选中类型"的格子**降透明度**（`dimmed`），
   * 且不给它 `lc-tone-*` 的强调色（在 `renderCell` 里按同一个判据决定）。
   *
   * 判据（`utils/liveCalendarFilter.ts::cellMatchesTypes`，纯函数、有单测）：
   * **这一格里有任意一场命中选中的类型** ⇒ 算命中。 */
  const dimmedCells = useMemo(
    () => dimmedKeys(cells, typeFilter),
    [cells, typeFilter],
  )

  /** 点了筛选但这一类本月一场都没有：说清"是筛没的"并给一条退路，
   *  否则空网格看起来像"这个月没直播"（用户会以为数据没了）。 */
  const filteredEmpty = typeFilter.length > 0 && !sessions.length && !loading

  const moveMonth = (delta: number) => {
    setMonthPopOpen(false)
    setNavDir(delta > 0 ? 1 : -1)
    setYm(({ y, m }) => {
      const d = new Date(y, m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })
  }

  const openMonthPop = () => {
    setPopYear(ym.y)
    setMonthPopOpen((o) => !o)
  }

  const pickMonth = (m: number) => {
    setNavDir(popYear * 12 + m >= ym.y * 12 + ym.m ? 1 : -1)
    setYm({ y: popYear, m })
    setMonthPopOpen(false)
  }

  /** 打开手动记录弹窗：`target=null` 新建（工具栏「+」/ 点过去的空日期格），
   *  非空 = 编辑那一场（详情弹窗铅笔）。`day` 只在新建时有意义。 */
  const openManual = (target: LiveSession | null, day: string | null = null) => {
    setManualTarget(target)
    setManualDay(target ? null : day)
    setManualOpen(true)
  }

  /** 打开「添加录播」小窗（3.2：封面上的 ＋）。 */
  const openVodDialog = (s: LiveSession) => {
    setVodTarget(s)
    setVodOpen(true)
  }

  /**
   * 播放这一场的录播（3.2：封面上的 ▶）。
   *
   * 走哪条路由**偏好**决定（用户 3.2：「设置里加『默认用应用内无边框播放器窗口播放』选项」）：
   * - `vod_player_window = on` **且** 这确实是桌面端（`openPlayerWindow` 返回 true）⇒ 独立无边框窗；
   * - 否则 ⇒ 主窗内的播放器浮层（浏览器/探针里永远走这条，因为那边没有第二扇窗）。
   *
   * ⚠️ 偏好**在点击那一刻现读**（`api.getPrefs()`，与顶栏点 ✕ 读 `close_action` 同一套）：
   * 读进 state 就得管失效与竞态，而这是一次用户手势里的一次小请求。
   * ⚠️ 地址里认不出 BV 号（或那一场没有录播）⇒ 什么都不开（不开一个黑框在那儿转）。
   */
  const playVod = async (s: LiveSession) => {
    const t = parseVodTarget(s.vod_url)
    if (!t) return
    let wantWindow = false
    try {
      wantWindow = (await api.getPrefs()).values.vod_player_window === 'on'
    } catch {
      /* 偏好读不到 → 按默认（主窗浮层）走，不打扰用户 */
    }
    if (wantWindow && await openPlayerWindow(t.bvid, t.page)) return
    setPlayerTarget(s)
    setPlayerOpen(true)
  }

  /**
   * 保存成功后的收口（B2）。
   *
   * 三件事都必须做，少一件用户就会以为"没保存上"：
   * ① 关弹窗 + 重拉列表（日历上立刻出现/更新那一格）；
   * ② **把日历翻到它所在的月份** —— 补的是上个月/下个月时，留在当前月会看不见任何变化；
   * ③ 详情弹窗开着的话刷新它（否则那份数据还是改之前的：标题/录播地址对不上）。
   */
  const onManualSaved = (saved: LiveSession) => {
    setManualOpen(false)
    reload()
    const d = new Date(saved.start_at)
    if (!Number.isNaN(d.getTime()) && (d.getFullYear() !== ym.y || d.getMonth() !== ym.m)) {
      setNavDir(d.getFullYear() * 12 + d.getMonth() >= ym.y * 12 + ym.m ? 1 : -1)
      setYm({ y: d.getFullYear(), m: d.getMonth() })
    }
    const lid = detail?.sessions[detail.idx]?.live_id
    if (lid && manualTarget) void reloadDetail(lid)
  }

  /** 删除成功：那一场没了 ⇒ 关掉正看着它的详情弹窗（留着会是一份看得见却已不存在的数据） */
  const onManualDeleted = () => {
    setManualOpen(false)
    setDetail(null)
    reload()
  }

  /**
   * 详情弹窗下拉栏里的「删除这一场」（B4）。
   *
   * 与 `manualOpen` 那条路不同：这里**没有**手动记录表单开着，删的是详情里正看着的那一场。
   * 服务端只允许删手动场次（自动场次 400，下次同步会放回来）⇒ 失败就**如实报**，
   * 顺手刷新详情（失败也可能已经改了什么）。
   */
  const deleteSession = async (s: LiveSession) => {
    if (!accountId || !s.live_id) return
    try {
      await api.deleteLiveSession(accountId, s.live_id)
      setDetail(null)
      reload()
    } catch (e) {
      setError((e as Error).message || '删除失败')
      await reloadDetail(s.live_id)
    }
  }

  /** 一行「刚才发生了什么」的瞬时提示（复用 `.card-src-note` 那一格，不引新控件）。 */
  const [notice, setNotice] = useState<string | null>(null)
  const notify = (text: string) => setNotice(text)

  /** 录播填充写完之后：关窗 + 重拉日历（格子上立刻出现 ▶）+ 详情开着的话刷新它 */
  const onVodFilled = () => {
    reload()
    const lid = detail?.sessions[detail.idx]?.live_id
    if (lid) void reloadDetail(lid)
    // 这一批写入可能顺带改了录播号（在填充窗里改的）⇒ 让父组件重取 V 列表，
    // 否则 `vodAccountUid` 的回显要等到下一次场景刷新才更新。
    if (onVodAccountSaved) void onVodAccountSaved(vodAccountUid ?? '')
  }

  /**
   * 「清空已匹配」（用户 2026-10-15：**放进 `+` 下拉栏**）。
   *
   * 点一下 ⇒ 先 `dry_run` 数一遍（**纯数据库、不打上游**，所以是"点了立刻有回执"）⇒
   * 把"会清几条 / 其中手填的几条"摆出来 ⇒ 确认才真清。
   *
   * ⚠️ 2026-10-15 第二次改口径：**全清**（用户：「硬性清除所有已匹配项」）。
   * 上一版只清自动匹配写的，库里 693 条有地址的一条都没清掉，看着像功能坏了。
   * 现在手填的也会一起清 —— 所以确认窗**必须**把手填的条数摆出来。
   *
   * ⚠️ 第一版把这个动作放在填充窗里、且**每次先真扫一遍**（19 次上游请求、逐条 commit）
   * ⇒ 用户实测报成"阻塞数据库读写 + 清完地址还在"。现在服务端一条 SQL 取行、
   * 一次提交，两个症状一起没了。
   */
  const armVodClear = async () => {
    if (accountId == null) return
    try {
      const dry = await api.vodClear(accountId, { dry_run: true })
      setClearAsk({ toClear: dry.cleared, auto: dry.auto, manual: dry.manual,
                    untracked: dry.untracked })
    } catch (e) {
      setError((e as Error).message || '清空失败')
    }
  }

  const doVodClear = async () => {
    if (accountId == null) return
    setClearing(true)                     // 清空是纯数据库（一瞬），但按钮仍要给出"在动"的态
    try {
      const out = await api.vodClear(accountId)
      setClearAsk(null)
      reload()
      const lid = detail?.sessions[detail.idx]?.live_id
      if (lid) void reloadDetail(lid)
      const parts = [out.cleared > 0 ? `已清空 ${out.cleared} 条录播地址`
                                     : '没有可清的录播地址']
      if (out.cleared > 0) parts.push('重跑一次「扫描录播并自动填充」可以再扫回来')
      notify(parts.join(' · '))
      setError(null)
    } catch (e) {
      setError((e as Error).message || '清空失败')
    } finally {
      setClearing(false)
    }
  }

  /** 预约保存成功（2026-10-13）：关弹窗 + **立刻重取预约** —— 格子上马上要出现那一条，
   *  等下一轮 `refreshTick` 用户会以为没存上。若那条预约不在当前月，顺手翻过去。 */
  const onReservationSaved = () => {
    setResvOpen(false)
    reloadReservations()
    const [y, m] = resvDay.split('-').map((x) => Number(x))
    if (Number.isFinite(y) && Number.isFinite(m) && (y !== ym.y || m - 1 !== ym.m)) {
      setNavDir(y * 12 + (m - 1) >= ym.y * 12 + ym.m ? 1 : -1)
      setYm({ y, m: m - 1 })
    }
  }

  const openCellPop = (c: DayCell, e: ReactMouseEvent<HTMLDivElement>) => {
    clearPopTimer()
    // R13：**只有预约没有场次**的日子也要能 hover 看详情（否则"预约"徽章点不出任何东西）
    if (c.state !== 'live' && c.reservations.length === 0) {
      setPop(null)
      return
    }
    setPop({
      key: c.key,
      rect: e.currentTarget.getBoundingClientRect(),
      sessions: c.sessions,
      reservations: c.reservations,
    })
  }

  const closeCellPop = () => {
    clearPopTimer()
    popTimer.current = window.setTimeout(() => setPop(null), POP_CLOSE_GRACE_MS)
  }

  // Esc 关闭浮层
  useEffect(() => {
    if (!pop) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPop(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pop])

  /** hover 浮层计时器（离开格子 → 120ms 宽限关闭，允许滑到浮层） */
  const popTimer = useRef<number | null>(null)
  const clearPopTimer = () => {
    if (popTimer.current != null) {
      window.clearTimeout(popTimer.current)
      popTimer.current = null
    }
  }

  /** 用户校正分类（v2 第⑦信号）：PUT/DELETE 后重拉（override/series/learned 后端全链重算） */
  const onPickCategory = async (s: LiveSession, value: string) => {
    const liveId = s.live_id
    if (!liveId || !accountId) return
    try {
      if (value === 'auto') {
        if (s.category_from === 'override') {
          await api.clearLiveSessionCategory(accountId, liveId)
        }
      } else {
        await api.setLiveSessionCategory(accountId, liveId, value)
      }
      reload()
      // 详情弹窗内校正 → 同步刷新详情（徽章/分类来源即时更新）
      await reloadDetail(liveId)
    } catch (e) {
      setError((e as Error).message || '分类保存失败')
    }
  }

  /** 打开场次详情弹窗（点击日期格；当日多场从第一场起，顶部可切换） */
  const openDetail = (c: DayCell) => {
    clearPopTimer()
    setPop(null)
    if (c.state !== 'live' || c.sessions.length === 0) return
    const first = c.sessions[0]
    setDetail({
      key: c.key, sessions: c.sessions, idx: 0,
      data: null, loading: !!(first.live_id && accountId),
    })
    if (first.live_id && accountId) {
      api.liveSessionDetail(accountId, first.live_id)
        .then((d) => setDetail((p) => (p && p.key === c.key ? { ...p, data: d, loading: false } : p)))
        .catch(() => setDetail((p) => (p && p.key === c.key ? { ...p, loading: false } : p)))
    }
  }

  /**
   * 点**空日期格**（2026-10-13，用户口径：「直接点没有直播的日期格来打开记录窗口，
   * 也可以点未来的待定日期格来记录直播预约」）。
   *
   * 按日子自动分岔（用户 2026-10-13 拍板「两种都开，按日子自动区分」）：
   *
   * | 这一格 | 打开什么 | 写哪张表 |
   * |---|---|---|
   * | 有场次 | 场次详情（原行为，不动） | —— |
   * | 有预约、没场次 | 不打开（那条预约就在格子上写着） | —— |
   * | **今天及以后**、空 | **记录预约**（`ReservationDialog`） | `vtuber_events` |
   * | **过去**、空 | **记录场次**（`ManualSessionDialog`，日期预填那一格） | `live_sessions` |
   *
   * ⚠️ 分岔判据是**这一天**（`c.key < todayKey`），不是"日历翻到哪个月"：
   * 用户翻到上个月补记，那几格仍然是"过去"。
   */
  const onCellClick = (c: DayCell) => {
    if (c.state === 'live' && c.sessions.length) {
      openDetail(c)
      return
    }
    if (c.reservations.length) return          // 有预约没场次：格子上已经写着，别抢
    if (vtuberId == null && accountId == null) return
    if (c.key < todayKey) {
      setManualTarget(null)
      setManualDay(c.key)
      setManualOpen(true)
      return
    }
    setResvDay(c.key)
    setResvOpen(true)
  }

  /** 详情弹窗内切换当日第 idx 场 */
  const switchDetailIdx = (idx: number) => {
    if (!detail || idx === detail.idx) return
    const s = detail.sessions[idx]
    const key = detail.key
    setDetail({ ...detail, idx, data: null, loading: !!(s.live_id && accountId) })
    if (s.live_id && accountId) {
      api.liveSessionDetail(accountId, s.live_id)
        .then((d) => setDetail((p) => (p && p.key === key ? { ...p, data: d, loading: false } : p)))
        .catch(() => setDetail((p) => (p && p.key === key ? { ...p, loading: false } : p)))
    }
  }

  // ⚠️ Esc 关闭**不在这里**（Q2，批次 14，devlog/217）：改前是这里的 keydown 直接
  // `setDetail(null)` ⇒ 弹窗组件当场卸载、退场动画根本播不出来。现在交给 Radix Dialog
  // 的 `onOpenChange`（Esc / 点遮罩 / 点 X / 关闭钮同一条路），面板会先播完退场动画再卸载。

  const renderCell = (c: DayCell) => {
    const first = c.sessions[0]
    const toneKey = first ? keyOf(first) : null
    const resv = reservationLine(c.reservations)
    const hasSession = c.state === 'live' && !!first
    /** 这一格含选中类型的场次吗（筛选口径 = **强调**，不是"替换成休息"）。
     *  未筛时恒真；筛了但这一格一场没命中 ⇒ 降透明度（`dimmedCells`）。 */
    const dimmed = dimmedCells.has(c.key)

    let toneCls = ''
    if (hasSession && toneKey) toneCls = ` lc-tone-${toneKey}`
    else toneCls = ' tbd'
    // 月份指示（透明度）：非本月一律 pad 淡化，与场次状态无关
    if (!c.inMonth) toneCls += ' pad'
    if (c.isToday) toneCls += ' today'
    if (dimmed) toneCls += ' dimmed'
    // R13：有预约的格子加一枚可辨识的标记（不改九类色系，只加虚线左缘）
    if (resv) toneCls += ' has-resv'

    // 徽章优先级：场次类型 > 预约 > 休息/待定（见 utils/reservationDays.cellBadge）
    const badge = cellBadge({
      hasSession,
      typeLabel: toneKey ? liveTypeLabel(toneKey) : '',
      hasReservation: !!resv,
      isPast: c.key < todayKey,
    })

    return (
      <div
        key={c.key}
        className={'lc-cell' + toneCls}
        /* T4：日期格是否属于**当前月**（42 格里含上下月补位）。
           ⚠️ 探针拿它把"本月场次之和"与筛选胶囊的计数对账 ——
           不加这个标记，求和会把补位格的场次算进来，两边永远对不上。 */
        data-lc-in-month={c.inMonth ? '1' : '0'}
        /* 筛选的**强调**口径（2026-10-13）：`1` = 这一格不含选中类型 ⇒ 降透明度。
           给探针一个可断言的钩子 —— "筛选没有把别的日子变成休息"这条在屏幕上看
           只差几格颜色，而它正是用户报的那个问题。 */
        data-lc-dimmed={dimmed ? '1' : undefined}
        data-lc-has-session={hasSession ? '1' : undefined}
        data-resv-count={c.reservations.length || undefined}
        onMouseEnter={(e) => openCellPop(c, e)}
        onMouseLeave={closeCellPop}
        onClick={() => onCellClick(c)}
      >
        <div className="lc-cell-head">
          <span className="lc-day">{c.date.getDate()}</span>
          <span className="lc-badge">{badge}</span>
        </div>
        {hasSession && first ? (
          <div className="lc-cell-body">
            <div className="lc-time-row">
              <span className="lc-time">{fmtTime(new Date(first.start_at))}</span>
              <span className="lc-count">{c.sessions.length} 场</span>
            </div>
            <span className="lc-cell-title">{first.live_title || '场次'}</span>
            {/* 已有场次的日子：预约压缩成一行小字（不与场次争主位） */}
            {resv && (
              <span className="lc-resv-mini">
                预约 {resv.time}
                {resv.more && ` · ${resv.more}`}
              </span>
            )}
          </div>
        ) : resv ? (
          /* 没有场次但有预约：**主位给预约** —— 报「待定」等于把已知信息藏起来（R13 要解决的正是这个） */
          <div className="lc-cell-body lc-resv-body">
            <div className="lc-time-row">
              <span className="lc-time lc-resv-time">{resv.time}</span>
              {resv.totalLabel && <span className="lc-count">{resv.totalLabel}</span>}
            </div>
            <span className="lc-cell-title lc-resv-title">{resv.title}</span>
          </div>
        ) : null}
      </div>
    )
  }

  /** 浮层位置：优先格下方，越界翻上方、水平收进视口 */
  const popStyle = (() => {
    if (!pop) return undefined
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = 300
    const estimate = Math.min(430, 120 + pop.sessions.length * 74)
    const left = Math.min(Math.max(12, pop.rect.left), Math.max(12, vw - width - 12))
    const below = pop.rect.bottom + 8
    const top = below + estimate > vh ? Math.max(12, pop.rect.top - estimate - 8) : below
    return { left, top, width }
  })()

  const renderPop = () => {
    if (!pop || !popStyle) return null
    return createPortal(
      <OverlayScroll className="lc-pop" style={popStyle} role="tooltip">
        <div onMouseEnter={clearPopTimer} onMouseLeave={closeCellPop}>
          <div className="lc-pop-head">
            <span className="lc-pop-date">{pop.key}</span>
            <span className="lc-pop-count">
              {pop.sessions.length} 场
              {(pop.reservations?.length ?? 0) > 0 && ` · ${pop.reservations!.length} 预约`}
            </span>
          </div>
          {/* R13：预约块排在场次之前 —— 预约是"将要发生"，用户 hover 通常就是想知道这个 */}
          {(pop.reservations?.length ?? 0) > 0 && (
            <div className="lc-pop-list lc-pop-resv-list">
              {pop.reservations!.map((r) => (
                <div key={`resv-${r.post_id}`} className="lc-pop-item lc-resv-item">
                  <div className="lc-pop-item-row">
                    <span className="lc-pop-badge lc-resv-badge">预约</span>
                    <span className="lc-pop-title">{r.title || '直播预约'}</span>
                  </div>
                  <div className="lc-pop-meta">
                    {fmtTime(new Date(r.start_at))}
                    {r.reserve_total > 0 && ` · 已有 ${r.reserve_total.toLocaleString('zh-CN')} 人预约`}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="lc-pop-list">
            {pop.sessions.map((s, i) => {
              const d0 = new Date(s.start_at)
              const d1 = s.end_at ? new Date(s.end_at) : null
              const t = keyOf(s)
              const meta: string[] = []
              if (s.area_name || s.parent_area_name) {
                meta.push([s.parent_area_name, s.area_name].filter(Boolean).join(' / '))
              }
              meta.push(`${fmtDur(s.duration_minutes)}${d1 ? '' : ' 进行中'}`.trim())
              if ((s.segment_count ?? 1) > 1) meta.push(`中断续播·${s.segment_count} 段合并`)
              const figures: string[] = []
              if ((s.total_income ?? 0) > 0) figures.push(`收益 ${fmtMoney(s.total_income)}`)
              if ((s.max_online_count ?? 0) > 0) figures.push(`峰值在线 ${s.max_online_count!.toLocaleString('zh-CN')}`)
              if ((s.danmakus_count ?? 0) > 0) figures.push(`弹幕 ${s.danmakus_count!.toLocaleString('zh-CN')}`)
              const srcs = (s.source ?? 'self').split('+').filter(Boolean)
              return (
                <div key={s.live_id ?? `${s.start_at}-${i}`} className="lc-pop-item">
                  <div className="lc-pop-item-row">
                    <span className={`lc-pop-badge lc-stat-pill--${t}`}>{liveTypeLabel(t)}</span>
                    <span className="lc-pop-title">{s.live_title || '场次'}</span>
                  </div>
                  <div className="lc-pop-meta">
                    {fmtTime(d0)} – {d1 ? fmtTime(d1) : '进行中'}
                    {meta.length ? ` · ${meta.join(' · ')}` : ''}
                  </div>
                  {figures.length > 0 && <div className="lc-pop-meta">{figures.join(' · ')}</div>}
                  <div className="lc-pop-src">数据源 {srcs.join(' + ')}</div>
                </div>
              )
            })}
          </div>
        </div>
      </OverlayScroll>,
      document.body,
    )
  }

  /** 详情弹窗已搬到 `components/live/LiveSessionDialog`
   *  （含词云 top40 派生、破泡计数/恢复信号等只服务弹窗的状态）。
   *  这里只留「是否渲染」与三个受父级状态驱动的入参。 */

  return (
    <div className="live-calendar">
      {/* 卡片标题（与归档卡标题同规格 16.5px/600）+ 数据来源说明 / 空月提示。
          2026-09-08（用户）：入口「不明确」其实是因为根本没有手动入口——
          场次在收录该 V 时自动回填、之后每日同步，直播状态随账号抓取更新。
          R3（2026-09-13）：从含糊的「数据自动同步」改成**点名来源**，并按实际数据
          判定是否含本地快照补段（场次 `source` 里的 `+self`）。 */}
      <div className="lc-title">
        {/* ⚠️ R45-B：这串文案与 `PostsPage` 传给 `DataDeck` 的 `labels[0]` 是**两份**。
            探针 `_assert_page_title` 会断言"导航标题 == 当前卡片里渲染出来的标题"，
            所以改了这里不改那边会**红**，不会静默漂移。 */}
        直播日历
        <span
          className="card-src-note"
          title={
            '场次来自 danmakus 第三方索引（收录该 V 时回填历史，之后每日同步）；'
            + '本工具 5 分钟一轮的直播轮询快照用于补中断段与校正起止。'
          }
        >
          {!loading && !error && monthStats.length === 0
            ? '本月暂无直播记录 · 数据自动同步'
            : calendarSourceLabel(sessions)}
        </span>
        {/* 有旧数据时刷新失败：保留网格 + 如实说一句（R2①：不再整块切成"加载中"） */}
        {error && sessions.length > 0 && (
          <span className="card-refresh-failed" title={error}>刷新失败，显示上次数据</span>
        )}
        {/* 「清空已匹配」的结果回执（2026-10-15）：**清了几条、哪些被保护**要留一句，
            否则用户点了确认之后没有任何反馈（那正是"看起来没生效"的成因之一）。 */}
        {notice && (
          <span className="card-src-note" data-lc-notice="1" title={notice}>{notice}</span>
        )}
      </div>

      {/* 导航行：左=月份浮片组（点击弹选月浮窗） · 右=当月类型统计胶囊（frame 10_642） */}
      <div className="lc-nav-row">
        <div className="lc-nav" ref={navRef}>
          <FloatPill shape="icon" title="上个月" onClick={() => moveMonth(-1)}>
            <ChevronsLeft className="lc-nav-icon" />
          </FloatPill>
          <FloatPill shape="text" title="选择月份" onClick={openMonthPop}>
            <span className="lc-nav-text">{fmtMonth(ym.y, ym.m)}</span>
          </FloatPill>
          <FloatPill shape="icon" title="下个月" onClick={() => moveMonth(1)}>
            <ChevronsRight className="lc-nav-icon" />
          </FloatPill>
          {/* 「补录播 / 记一场」入口（B4，用户 2026-10-15）。
              ⚠️ 这一枚的**主语义改成了「添加录播」** —— 用户原话：「图二红框圈出来这个按钮
              就是用来添加录播的」。原来它只开「手动记录一场」，那条路仍在，只是退到第二项。
              第三项是"录播号填在哪"的指路（那个字段在档案设置里，不在日历上）。 */}
          <NavMenu
            label="添加录播"
            title="添加录播"
            icon={<Plus className="lc-nav-icon" />}
            probe="lc-add-menu"
            items={[
              {
                key: 'fill',
                label: '扫描录播并自动填充',
                icon: <Sparkles className="lc-nav-icon" />,
                hint: vodAccountUid
                  ? `扫录播号 ${vodAccountUid}（确认后一次写入）`
                  : '还没填录播号 —— 先扫 V 自己的号',
                disabled: accountId == null,
                disabledReason: '先选一个账号',
                onSelect: () => setFillOpen(true),
              },
              {
                key: 'manual',
                label: '手动记录一场直播',
                icon: <CalendarPlus className="lc-nav-icon" />,
                hint: '平台没留记录、当时没开工具时用这条',
                onSelect: () => openManual(null),
              },
              {
                key: 'mid',
                label: '录播号设置',
                icon: <Link2 className="lc-nav-icon" />,
                hint: vodAccountUid
                  ? `当前：${vodAccountUid}`
                  : '还没填 —— 点这里填（填了才扫得到回放）',
                // ⚠️ 2026-10-15（用户报的第 2 条）：这一项**改成就地可编辑**。
                //    改前它是 disabled + "在档案设置里改"，等于把前置动作指到别的入口去。
                disabled: vtuberId == null,
                disabledReason: '这个视图里没有 V 的 id（改不了）',
                onSelect: () => setAcctOpen(true),
              },
              {
                key: 'clear',
                label: '清空已匹配的录播',
                icon: <Eraser className="lc-nav-icon" />,
                hint: '只清自动匹配写入的；你手填的一条都不动',
                // 危险动作放最后（用户 2026-10-15：「把清空匹配的功能放在点开加号的下拉栏里面」）
                danger: true,
                disabled: accountId == null,
                disabledReason: '先选一个账号',
                onSelect: () => void armVodClear(),
              },
            ]}
          />

          {/* 月份选择浮窗：年切换 + 12 月宫格 */}
          {monthPopOpen && (
            <div className="lc-month-pop">
              <div className="lc-month-pop-head">
                <button type="button" title="上一年" onClick={() => setPopYear((y) => y - 1)}>
                  <ChevronLeft className="size-4" />
                </button>
                <span className="lc-month-pop-year">{popYear}年</span>
                <button type="button" title="下一年" onClick={() => setPopYear((y) => y + 1)}>
                  <ChevronRight className="size-4" />
                </button>
              </div>
              <div className="lc-month-pop-grid">
                {MONTH_CN.map((name, i) => (
                  <button
                    key={name}
                    type="button"
                    className={`lc-month-pop-btn${i === ym.m && popYear === ym.y ? ' on' : ''}`}
                    onClick={() => pickMonth(i)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 当月类型统计胶囊（彩色胶囊 + 计数，设计稿 frame 10_642；服务端 category 口径）。
            T4（2026-10-12）：胶囊现在也是**筛选按钮** —— 点一下只留这一类，再点取消；
            计数始终按**全量**算（见 `monthStats` 的说明），所以选中之后别的类型照样看得见。 */}
        <div className="lc-stats" role="group" aria-label="按类型筛选场次"
             data-lc-type-filter={typeFilter.join(',') || 'all'}>
          {typeFilter.length > 0 && (
            <button type="button" className="lc-stat lc-stat-reset"
                    data-lc-type-reset="" title="显示全部类型"
                    onClick={() => setTypeFilter([])}>
              <span className="lc-stat-pill lc-stat-pill--all">全部</span>
            </button>
          )}
          {monthStats.map((t) => {
            const on = typeFilter.includes(t.key)
            return (
              <button key={t.key} type="button"
                      className={`lc-stat lc-stat-btn${on ? ' on' : ''}`}
                      data-lc-type={t.key} data-lc-type-on={on ? '1' : '0'}
                      aria-pressed={on}
                      title={on ? `不再只看「${liveTypeLabel(t.key)}」`
                                : `只看「${liveTypeLabel(t.key)}」`}
                      onClick={() => toggleType(t.key)}>
                <span className={`lc-stat-pill lc-stat-pill--${t.key}`}>{liveTypeLabel(t.key)}</span>
                <span className="lc-stat-num">{t.n}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 月历区（设计稿 frame 10_659：表头与网格 gap 5px） */}
      <div className="lc-body">
        {/* 星期表头（Mon.~Sun.，14px #727272 → --c-text-sub） */}
        <div className="lc-weekdays">
          {WEEKDAYS_EN.map((w) => (
            <div key={w} className="lc-weekday">{w}</div>
          ))}
        </div>

        {/* 月历网格：7 列 × 6 行，列/行距 4px（keyed 重放月份切换滑动动画）。
            R2①（2026-09-13）：`loading` 只在**首次加载（还没有任何场次）**时接管网格 ——
            此前每次 `fetch-idle`（定时动态流每轮都会发，约 80s 一次）都会让 refreshTick +1 →
            reload → loading=true → 42 格整块消失再重建，看起来就是"日历在闪"。
            现在后台刷新静默替换数据，网格不卸载。 */}
        <div key={`${ym.y}-${ym.m}`} className={`lc-grid-anim${navDir === 1 ? '' : ' back'}`}>
          <div className="lc-grid">
            {loading && sessions.length === 0 && <StateBlock kind="loading" />}
            {error && sessions.length === 0 && <StateBlock kind="error" text={error} />}
            {filteredEmpty && (
              <p className="pcard-empty" data-lc-type-empty="">
                没有这些类型的场次 ——{' '}
                <button type="button" className="lc-stat-reset-inline"
                        onClick={() => setTypeFilter([])}>显示全部</button>
              </p>
            )}
            {cells.map((c) => renderCell(c))}
          </div>
        </div>
      </div>

      {renderPop()}
      {/* ⚠️ **不再条件渲染**（Q2，批次 14）：Radix 要 `open=false` 那一帧还挂着面板，
          才能播退场动画（`data-state=closed`）—— 条件渲染会把整棵树当场拆掉。
          组件内部用"最后一次非空 detail"渲染关闭动画期间的内容。 */}
      <LiveSessionDialog
        detail={detail}
        catPopOpen={catPopOpen}
        setCatPopOpen={setCatPopOpen}
        catPopRef={catPopRef}
        onClose={() => setDetail(null)}
        onSwitchIdx={switchDetailIdx}
        onPickCategory={onPickCategory}
        accountId={accountId}
        /* 上游按需现查补到了这一场的 danmakus 行（devlog/275）→ 重取详情，
           把弹幕数/收益/峰值/数据源一起刷新（否则卡片自相矛盾）。 */
        onSessionChanged={() => {
          const lid = detail?.sessions[detail.idx]?.live_id
          if (lid) void reloadDetail(lid)
        }}
        onEditSession={(s) => openManual(s)}
        /* 封面上的录播钮（用户 3.2，2026-10-13）：`＋` 开「添加录播」小窗、`▶` 打开播放器。
           ⚠️ 小窗/播放器都由**本组件**渲染（不是详情弹窗内部）—— Radix 的 portal 按 DOM
           顺序叠：后渲染的那个才在上面（两个面板同 z，`devlog/217` 那条口径）。 */
        onAddVod={(s) => openVodDialog(s)}
        onPlayVod={(s) => void playVod(s)}
        /* 下拉栏（B4）：编辑 / 换录播 / 删除三合一。删除只对手动场次可用（自动场次会回来）。 */
        onDeleteSession={(s) => void deleteSession(s)}
      />
      {/* 录播批量填充（B4）：工具栏 `+` 的第一项打开它。**只读扫描 → 审查 → 一次写入** */}
      <VodFillDialog
        open={fillOpen}
        accountId={accountId}
        vodAccountUid={vodAccountUid}
        onClose={() => setFillOpen(false)}
        onApplied={onVodFilled}
        onEditVodAccount={() => setAcctOpen(true)}
      />
      {/* 录播号设置（B4，用户 2026-10-15 第 2 条）：工具栏 `+` 下拉的第三项就地改 ——
          "加录播号"是「扫描录播」的前置动作，不该把人指到别的入口去。 */}
      <VodAccountDialog
        open={acctOpen}
        vtuberId={vtuberId ?? null}
        value={vodAccountUid}
        onClose={() => setAcctOpen(false)}
        onSaved={async (mids) => { await onVodAccountSaved?.(mids) }}
      />
      {/* 「清空已匹配」的二次确认（用户要求放进 `+` 下拉栏）。**先说清范围再动手**：
          会清几条 · 其中手填的几条（**它们也会被清掉**，不可再生）。 */}
      <ConfirmDialog
        open={clearAsk != null}
        title="清空已匹配的录播"
        confirmText="确认清空"
        busy={clearing}
        busyText="正在清空…"
        danger
        onCancel={() => setClearAsk(null)}
        onConfirm={() => void doVodClear()}
        testId="vod-clear-ask"
      >
        {clearAsk && (
          <div className="lc-confirm-lines">
            <p>
              会清掉 <b>{clearAsk.toClear}</b> 条录播地址（这个 V 下**所有已匹配的**）。
            </p>
            {(clearAsk.manual > 0 || clearAsk.untracked > 0) && (
              <p className="lc-confirm-dim" data-vod-clear-breakdown={clearAsk.toClear}>
                {clearAsk.auto > 0 && <>其中自动匹配写的 <b>{clearAsk.auto}</b> 条</>}
                {clearAsk.manual > 0 && (
                  <>
                    {clearAsk.auto > 0 ? ' · ' : ''}
                    你自己填的 <b>{clearAsk.manual}</b> 条
                  </>
                )}
                {clearAsk.untracked > 0 && (
                  <>
                    {(clearAsk.auto > 0 || clearAsk.manual > 0) ? ' · ' : ''}
                    旧版本写入的 <b>{clearAsk.untracked}</b> 条
                  </>
                )}
              </p>
            )}
            {clearAsk.manual > 0 && (
              <p className="lc-confirm-warn" data-vod-clear-manual={clearAsk.manual}>
                ⚠️ 手填的那些**也会一起清掉**，而它们不会再被扫回来。
              </p>
            )}
            <p className="lc-confirm-dim">
              只清地址、**不删场次**；想拿回来重跑一次「扫描录播并自动填充」。
            </p>
          </div>
        )}
      </ConfirmDialog>
      {/* 「添加录播」小窗（3.2）：录播的**唯一入口**在封面上，所有录播操作收在这一个窗里 */}
      <VodDialog
        open={vodOpen}
        accountId={accountId}
        session={vodTarget}
        vodAccountUid={vodAccountUid}
        onClose={() => setVodOpen(false)}
        /* 写完重取详情 + 日历（`reload()` 是为了"刚补的录播"在别的场次上也一致）。
           ⚠️ 不走 `onManualSaved`：那个函数的入参是"保存后的整场"，而这里回的就是详情。 */
        onSaved={(saved) => {
          setVodOpen(false)
          reload()
          if (saved?.live_id) void reloadDetail(saved.live_id)
        }}
        /* 录播号（f015）：存到 V 上（**不是**场次上）—— 它是"这个 V 的回放在哪"，
           下一场照样用它。存完让父组件重取 V 列表（`vodAccountUid` 回显要用新值）。 */
        onSaveVodAccount={async (mids) => {
          if (!vtuberId) return
          await api.updateVtuber(vtuberId, { vod_account_uid: mids || null })
          await onVodAccountSaved?.(mids)
        }}
      />
      {/* 手动记录/编辑（B2）：三处入口（工具栏「+」/ 详情弹窗铅笔 / 点过去的空日期格）
          共用这一个实例 */}
      <ManualSessionDialog
        open={manualOpen}
        accountId={accountId}
        session={manualTarget}
        newDay={manualDay}
        onClose={() => setManualOpen(false)}
        onSaved={onManualSaved}
        onDeleted={onManualDeleted}
      />
      {/* 记录预约（2026-10-13）：点**未来**的空日期格进来，写 `vtuber_events`（大事记那张表） */}
      <ReservationDialog
        open={resvOpen}
        vtuberId={vtuberId ?? null}
        dayKey={resvDay}
        onClose={() => setResvOpen(false)}
        onSaved={onReservationSaved}
      />
      {/* 录播播放器（3.2）：封面上的 ▶ 打开它。取流走 `/bili/play-by-bvid`（录播不是帖子） */}
      <VodPlayerDialog
        open={playerOpen}
        session={playerTarget}
        onClose={() => setPlayerOpen(false)}
      />
    </div>
  )
})

export default LiveCalendar
