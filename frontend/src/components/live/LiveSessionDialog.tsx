/**
 * 场次详情弹窗（P2 分层收敛 A-3：从 `LiveCalendar.tsx` 的 `renderDetail()` 整块搬出，**只搬不改**）。
 *
 * 内容：直播信息（起止/分区/收益/峰值/弹幕数/指标/段数/数据源）+ 分类校正（左上角徽章下拉）
 * + 弹幕信息（总量 + 增量摊铺词云）+ 直播动态（中止/继续事件 + 最热时刻）+ 内容分析预留区块。
 *
 * ## 为什么它是独立组件而不是一个大 `render*()` 函数
 *
 * 词云有三块**只服务于这个弹窗**的状态：`cloudBubbles`（top40 派生）、`cloudPopped`（破泡计数）、
 * `cloudRestoreTick`（恢复信号）。原来它们住在 `LiveCalendar` 顶层，于是"弹窗的局部状态"
 * 与"日历的状态"混在同一个作用域里。搬进本组件后：
 * - 三块状态随弹窗挂载/卸载，**语义更准确**（`detail` 为 null 时组件返回 null，但父级仍持有状态）；
 * - 父组件少 3 个 hook 与一个 267 行的函数。
 *
 * ## 行为保持（"只搬不改"的要点）
 *
 * - **portal target 仍是 `document.body`**，`z-index`/层级语义不变；
 * - **状态重置时机不变**：原来 `cloudPopped` 只由 `restoreTick` 与破泡动作驱动、
 *   不随 `detail` 变化重置；现在它随本组件挂载而初始化 —— 而本组件仅在 `detail` 非空时渲染，
 *   即"每次打开弹窗"就是"一次挂载" ⇒ 打开时归零。**这正是原行为的等效表达**
 *   （原实现里关闭再打开也会因为 `MosaicCloud` 重建而让计数失去意义）。
 * - **DOM 结构逐字保留**（`.lc-dlg*` 家族类名一个没动）—— 探针直接查这些选择器。
 *
 * ⚠️ CSS 归属：仍由 `styles/posts.css` 拥有（A 路线决策 (a)：拆分不搬 CSS）。
 *
 * ## 上游取数（2026-09-13，devlog/063）
 *
 * 弹幕词云 / 场次指标 / 直播动态三样来自第三方 danmakus，**不再由详情请求带回**：
 * 它们由 `useLiveUpstream` 单独取（后端 `/live-sessions/{id}/upstream`，带 10 分钟缓存），
 * 因此上游慢/挂了只让这两格转圈并显示"没拉到 + 重试"，其余内容（起止/分区/收益/分类）
 * 打开即可读。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, X } from 'lucide-react'

import type { LiveDanmakuInfo, LiveEvent, LiveMetrics, LiveSession, LiveSessionDetail } from '../../api/types'
import { api } from '../../api/api'
import { LIVE_TYPE_ORDER, liveTypeLabel } from '../../utils/liveType'
import type { CloudWord } from '../../utils/wordCloudLayout'
import MosaicCloud from '../wordcloud/MosaicCloud'
import OverlayScroll from '../OverlayScroll'
import ProxyImage from '../common/ProxyImage'
import type { DetailState } from './useLiveSessions'
import { useLiveUpstream } from './useLiveUpstream'
import {
  fmtDur, fmtMoney, fmtTime, isFreshSession, keyOf,
} from './liveCalendarFmt'
import { glanceCapsules } from './sessionGlance'

/** 上游指标行（顺序即展示顺序）。**恒定四行**是 R36 的前提：未到位时按同尺寸骨架占位，
 *  到位后原位换成真值 —— 行数一样，弹窗高度才不变（`在线排名` 另有保留位，见 CSS）。 */
const METRIC_ROWS: { key: keyof LiveMetrics; label: string; suffix?: string }[] = [
  { key: 'watch_count', label: '观看' },
  { key: 'like_count', label: '点赞' },
  { key: 'pay_count', label: '打赏', suffix: ' 人' },
  { key: 'interaction_count', label: '互动' },
]

/** 上游"较慢"的提示阈值（秒）：超过它就把文案从"正在取"换成"还在等 + 已等 Ns" */
const SLOW_HINT_SECONDS = 8

interface Props {
  detail: DetailState
  /** 分类校正下拉是否展开（状态归属父组件：受"详情变化即收起"那条 effect 驱动） */
  catPopOpen: boolean
  setCatPopOpen: React.Dispatch<React.SetStateAction<boolean>>
  /** 分类徽章下拉的锚点（点外关闭判定用） */
  catPopRef: React.RefObject<HTMLSpanElement>
  /** 关闭弹窗（遮罩点击 / 关闭钮 / Esc 由父组件的 keydown effect 处理） */
  onClose: () => void
  /** 切换当日第 idx 场 */
  onSwitchIdx: (idx: number) => void
  /** 用户校正分类（'auto' = 清除校正） */
  onPickCategory: (s: LiveSession, value: string) => void
  /** 账号 id（词云自建端点需要） */
  accountId: number | null
}

export default function LiveSessionDialog({
  detail,
  catPopOpen,
  setCatPopOpen,
  catPopRef,
  onClose,
  onSwitchIdx,
  onPickCategory,
  accountId,
}: Props) {
  /**
   * 自建词云（本地覆盖）：非空、且**属于当前场次**时优先于 `detail.data.danmaku` 展示。
   *
   * 为什么不把结果写回父组件的 `detail`：① 自建只影响这一次打开的词云展示，
   * 无需进全局详情状态；② 关掉弹窗时本组件会卸载 ⇒ 本地状态自然归零。
   *
   * ⚠️ **必须连同 `live_id` 一起记账**：弹窗里有一排场次页签（`onSwitchIdx`），
   * 切换场次时本组件**不会卸载**（父级条件渲染的位置没变、也没给 `key`），
   * 只存 `LiveDanmakuInfo` 的话 —— A 场自建的词云会**留在 B 场的界面上**，
   * 是一份看不出错的静默错数据。记下它属于哪一场，切走即自动失效（切回来还在）。
   */
  const [selfWc, setSelfWc] = useState<{ liveId: string; data: LiveDanmakuInfo } | null>(null)
  /** 正在拉取自建词云的**场次 id**（同 `selfWc` 的理由：别让 A 场的 loading 冻住 B 场的按钮） */
  const [busyWc, setBusyWc] = useState<string | null>(null)
  /** 自建词云的已等秒数（这条路径最长实测 120s，需要一个"还在跑"的证据） */
  const [buildElapsed, setBuildElapsed] = useState(0)
  /** 自建词云的在途请求取消器（关窗 / 切场次即 abort） */
  const buildCtrl = useRef<AbortController | null>(null)

  const s: LiveSessionDetail =
    detail.data ?? { ...detail.sessions[detail.idx], analysis: null }

  /**
   * 上游取数（弹幕词云 / 指标 / 直播动态）：独立请求 + 独立 loading（devlog/063）。
   * 切场次页签时 `s.live_id` 变 → hook 自动重取（后端有 10 分钟缓存，重取很便宜）。
   */
  const up = useLiveUpstream(accountId, s.live_id)
  const metrics: LiveMetrics | null = up.data?.metrics ?? null
  const events: LiveEvent[] = up.data?.events ?? []
  const selfDm = selfWc && selfWc.liveId === s.live_id ? selfWc.data : null
  /** 本场次的生效弹幕信息：自建结果优先，其次上游 */
  const dm: LiveDanmakuInfo | null = selfDm ?? up.data?.danmaku ?? null
  /** 词云状态（缺省 = 上游没给） */
  const wcStatus = dm?.wc_status ?? (dm ? 'upstream' : 'upstream_absent')
  const hasWords = (dm?.top_words?.length ?? 0) > 0
  const building = busyWc != null && busyWc === s.live_id
  /** 上游这次到底拿没拿到（用于区分"没拉到"与"本场没有"） */
  const upFailed = wcStatus === 'fetch_failed'
  /** 已经等了一会儿 → 文案从"正在取"换成"还在等 + 已等 Ns"（上游会间歇性变慢） */
  const slow = up.elapsed >= SLOW_HINT_SECONDS
  /** 上游指标**未到位**（要按骨架占位）：加载中且还没有指标；失败时 `up.loading` 已落，
   *  此时由块内的「未取到 + 重试」那行接管（同一块、同一高度）。 */
  const metricsPending = up.loading && !metrics
  const waitHint = slow ? `上游响应较慢，仍在重试…（已等 ${up.elapsed}s）` : ''
  /** 弹幕段的「重试」：自建失败重取自建，上游失败重取上游 */
  const retryDanmaku = () => {
    if (selfDm) void buildCloud()
    else up.reload()
  }

  /** 词云词条：top40（按次数降序）。只服务本弹窗，随挂载重建。 */
  const cloudBubbles = useMemo<CloudWord[]>(() => {
    return [...(dm?.top_words ?? [])].sort((a, b) => b.count - a.count).slice(0, 40)
  }, [dm])

  /** 词云破泡计数 / 恢复信号（段头右侧「已破泡 N · 恢复」，带破泡时出现） */
  const [cloudPopped, setCloudPopped] = useState(0)
  const [cloudRestoreTick, setCloudRestoreTick] = useState(0)

  // 自建词云已等秒数：只在 building 期间走表（文案里给用户一个"还在跑"的证据）
  useEffect(() => {
    if (!building) return
    const t0 = Date.now()
    const id = window.setInterval(
      () => setBuildElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [building])

  // 关弹窗即取消在途的自建词云请求（长路径：实测最长 120s）
  useEffect(() => () => buildCtrl.current?.abort(), [])

  /**
   * 「用弹幕自建」：**用户点击才拉**整场原始弹幕（实测单场可达 5 万条/数 MB）。
   * 按用户 2026-09-13 的决策：上游没有热词时**不自动回退**，要给按钮让用户决定。
   *
   * 2026-09-13 补充两项（devlog/069，TODO §1.1）：
   * - **可取消**：关弹窗 / 切场次时 abort（这条路径最长实测 120s，用户早就不看它了）；
   * - **进度反馈**：按钮文案带上已等秒数（`buildElapsed`），120s 的等待不再是"卡住了"。
   */
  const buildCloud = async () => {
    const liveId = s.live_id
    if (!liveId || !accountId || busyWc) return
    buildCtrl.current?.abort()
    const ac = new AbortController()
    buildCtrl.current = ac
    setBusyWc(liveId)
    setBuildElapsed(0)
    try {
      setSelfWc({
        liveId,
        data: await api.buildLiveSessionWordCloud(accountId, liveId, ac.signal),
      })
    } catch (e) {
      // 主动取消不算失败（关窗/切场次时不该在新场次上闪一下"拉取失败"）
      if (ac.signal.aborted || (e as Error)?.name === 'AbortError') return
      // 失败也要落到明确状态（否则按钮点了没反应，用户不知道发生了什么）
      setSelfWc({ liveId, data: { wc_status: 'fetch_failed', top_words: [], top_keywords: [] } })
    } finally {
      setBusyWc(null)
    }
  }
  const d0 = new Date(s.start_at)
  const d1 = s.end_at ? new Date(s.end_at) : null
  const t = keyOf(s)
  const srcs = (s.source ?? 'self').split('+').filter(Boolean)
  const area = [s.parent_area_name, s.area_name].filter(Boolean).join(' / ')

  return createPortal(
    <div
      className="lc-dlg-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="lc-dlg" role="dialog" aria-modal>
        {/* 头部驻留区：不随内容滚动（2026-09-07 user 定案——「标题……X」恒驻留、
            滚动条只在内容区悬浮不覆盖头部）；下缘发丝分隔 */}
        <div className="lc-dlg-head-zone">
          <div className="lc-dlg-head">
            <div className="lc-dlg-title">
              {s.live_id ? (
                <span className="lc-dlg-badge-wrap" ref={catPopRef}>
                  <button
                    type="button"
                    className="lc-dlg-badge-btn"
                    title="选择分类"
                    onClick={() => setCatPopOpen((o) => !o)}
                  >
                    <span className={`lc-pop-badge lc-stat-pill--${t}`}>{liveTypeLabel(t)}</span>
                    <ChevronDown className="lc-dlg-badge-caret" />
                  </button>
                  {catPopOpen && (
                    <span className="lc-dlg-cat-pop">
                      <span className="lc-dlg-cat-list">
                        <button
                          type="button"
                          className={`lc-dlg-cat-opt lc-dlg-cat-auto${s.category_from === 'override' ? '' : ' on'}`}
                          onClick={() => { setCatPopOpen(false); onPickCategory(s, 'auto') }}
                        >
                          自动（跟随推断）
                        </button>
                        {LIVE_TYPE_ORDER.map((t2) => (
                          <button
                            key={t2.key}
                            type="button"
                            className={`lc-dlg-cat-opt lc-stat-pill--${t2.key}${t === t2.key ? ' on' : ''}`}
                            onClick={() => { setCatPopOpen(false); onPickCategory(s, t2.key) }}
                          >
                            {t2.label}
                          </button>
                        ))}
                      </span>
                    </span>
                  )}
                </span>
              ) : (
                <span className={`lc-pop-badge lc-stat-pill--${t}`}>{liveTypeLabel(t)}</span>
              )}
              <span className="lc-dlg-name">{s.live_title || '场次详情'}</span>
              <span className="lc-dlg-sub">{detail.key} {fmtTime(d0)}</span>
              {s.category_from === 'override' && (
                <span className="lc-pop-corr">已校正</span>
              )}
            </div>
            <button type="button" className="lc-dlg-close" aria-label="关闭" onClick={onClose}>
              <X className="size-4" />
            </button>
          </div>

          {/* 当日多场切换（点格默认第一场）——随头部驻留 */}
          {detail.sessions.length > 1 && (
            <div className="lc-dlg-tabs">
              {detail.sessions.map((x, i) => (
                <button
                  key={x.live_id ?? `${x.start_at}-${i}`}
                  type="button"
                  className={`lc-dlg-tab${i === detail.idx ? ' on' : ''}`}
                  onClick={() => onSwitchIdx(i)}
                >
                  {fmtTime(new Date(x.start_at))}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 内容区：独立滚动（覆盖式滚动条，只在此层悬浮） */}
        <OverlayScroll className="lc-dlg-body">
          <div className="lc-dlg-main">
          {/* 左列：封面 + 「本场速览」胶囊卡（R36，devlog/140）
              —— 封面是 4:3 定宽，右列却随上游指标变高 ⇒ 封面下方原本是一块**空区域**
              （用户截图红圈处）。速览卡用**本地就有**的四枚值把它在第一帧就填满。 */}
          <div className="lc-dlg-left">
          <div className="lc-dlg-cover">
            <ProxyImage
              key={s.cover_url ?? 'none'}
              src={s.cover_url}
              className="lc-dlg-cover-img"
              fallbackClassName="lc-dlg-cover-ph"
              fallback={(s.live_title || liveTypeLabel(t)).trim().charAt(0) || '播'}
            />
            <span className={`lc-dlg-status${d1 ? '' : ' live'}`}>
              {d1 ? '已结束' : '直播中'}
            </span>
          </div>
          <div className="lc-dlg-glance">
            <h4 className="lc-dlg-sec-title">本场速览</h4>
            <div className="lc-glance-grid">
              {glanceCapsules(s).map((c) => (
                <div key={c.key} className="lc-glance-cap">
                  <span className="lc-glance-label">{c.label}</span>
                  <span className="lc-glance-value" title={c.value}>{c.value}</span>
                </div>
              ))}
            </div>
          </div>
          </div>

          {/* 右列：直播信息（行式 label 左 · value 右） */}
          <section className="lc-dlg-sec">
            {/* 「上游慢」的提示挂在**标题行**（R36）：它原来占一行，数据一到就要撤掉 ——
                也是高度变化。标题行在两种状态下都存在，挂这里等于零成本。 */}
            <h4 className="lc-dlg-sec-title">
              直播信息
              {metricsPending && slow && (
                <span className="lc-dlg-sec-note">{waitHint}</span>
              )}
            </h4>
            <dl className="lc-dlg-rows">
              <div className="lc-dlg-row">
                <dt>时间</dt>
                <dd>{fmtTime(d0)} – {d1 ? fmtTime(d1) : '进行中'}
                  {fmtDur(s.duration_minutes) ? `（${fmtDur(s.duration_minutes)}）` : ''}</dd>
              </div>
              <div className="lc-dlg-row"><dt>分区</dt><dd>{area || '—'}</dd></div>
              <div className="lc-dlg-row"><dt>收益</dt><dd>{fmtMoney(s.total_income) || '—'}</dd></div>
              <div className="lc-dlg-row">
                <dt>峰值在线</dt>
                <dd>{s.max_online_count ? s.max_online_count.toLocaleString('zh-CN') : '—'}</dd>
              </div>
              <div className="lc-dlg-row">
                <dt>弹幕数</dt>
                <dd>{s.danmakus_count ? s.danmakus_count.toLocaleString('zh-CN') : '—'}</dd>
              </div>
              {/* 上游指标（观看/点赞/打赏/互动/[在线排名]）——R36：**未到位时按同尺寸骨架占位**。
                  这一块是整个弹窗高度变化的元凶：到位后凭空多出 4~5 行（实测右列卡片
                  207 → 276px），而 `.lc-dlg` 是内容驱动的高度 ⇒ 用户看到「数据一抓到窗口
                  长度变化」。现在四行**恒定渲染**（骨架 → 真值），第五行（在线排名）由
                  CSS 的 `min-height` 预留，所以两种状态同高。
                 文案只在**超时/失败**时出现：骨架本身不说"加载中"（与项目"全程没有
                  『正在加载』闪帧"同源），但"没拿到"必须说出来（devlog/063 的教训）。 */}
              <div className="lc-dlg-metrics"
                   data-pending={metricsPending ? '1' : undefined}>
                {METRIC_ROWS.map((row) => (
                  <div className="lc-dlg-row" key={String(row.key)}>
                    <dt>{row.label}</dt>
                    <dd>
                      {metricsPending ? (
                        <span className="lc-skel lc-skel--val" />
                      ) : (
                        <>
                          {metrics?.[row.key] != null
                            ? `${Number(metrics[row.key]).toLocaleString('zh-CN')}${row.suffix ?? ''}`
                            : '—'}
                        </>
                      )}
                    </dd>
                  </div>
                ))}
                {!metricsPending && metrics?.online_rank != null && (
                  <div className="lc-dlg-row">
                    <dt>在线排名</dt>
                    <dd>#{metrics.online_rank.toLocaleString('zh-CN')}</dd>
                  </div>
                )}
                {!metricsPending && !metrics && (
                  <div className="lc-dlg-row">
                    <dt>上游指标</dt>
                    <dd className="lc-dlg-note">
                      {upFailed ? (
                        <>
                          未取到（上游超时或不可用）
                          <button type="button" className="lc-dlg-cloud-build"
                                  onClick={() => up.reload()}>
                            重试
                          </button>
                        </>
                      ) : (
                        '上游未提供'
                      )}
                    </dd>
                  </div>
                )}
              </div>
              {(s.segment_count ?? 1) > 1 && (
                <div className="lc-dlg-row">
                  <dt>段数</dt>
                  <dd>{s.segment_count} 段合并（中断续播）</dd>
                </div>
              )}
              <div className="lc-dlg-row"><dt>数据源</dt><dd>{srcs.join(' + ')}</dd></div>
            </dl>
          </section>
        </div>

        <section className="lc-dlg-sec lc-dlg-sec--full">
          {/* 段头行：标题 + 破泡计数/恢复胶囊（破泡时出现） */}
          <div className="lc-dlg-sec-head">
            <h4 className="lc-dlg-sec-title">弹幕信息</h4>
            {cloudPopped > 0 && cloudBubbles.length > 0 && (
              <button
                type="button"
                className="lc-dlg-cloud-restore"
                onClick={() => setCloudRestoreTick((t) => t + 1)}
              >
                已破泡 {cloudPopped} · 恢复
              </button>
            )}
          </div>
          {/* 段落内容统一套一层「槽」（R36）：`min-height` 定在槽上 ⇒ **未到位 / 到位 /
              没有数据 / 拉取失败**四种形态占同一块地方，弹窗高度不随数据到达变化。
              槽本身不解释"在等什么"——那是骨架与标题行那句话的事。 */}
          <div className="lc-dlg-slot lc-dlg-slot--danmaku">
          {detail.loading || (!dm && up.loading) ? (
            /* 未到位：两行骨架（对应"弹幕总量 + 文本弹幕"）+ 词云区骨架（与 boxH 210 同高）。
               行数/高度都按到位后的样子给，所以换成真值时**一像素都不动**。 */
            <div className="lc-dlg-danmaku" data-pending="1">
              <dl className="lc-dlg-rows">
                <div className="lc-dlg-row">
                  <dt>弹幕总量</dt>
                  <dd><span className="lc-skel lc-skel--val" /></dd>
                </div>
                <div className="lc-dlg-row">
                  <dt>文本弹幕</dt>
                  <dd><span className="lc-skel lc-skel--val" /></dd>
                </div>
              </dl>
              <div className="lc-skel lc-skel--cloud" />
            </div>
          ) : dm ? (
            <div className="lc-dlg-danmaku">
              <dl className="lc-dlg-rows">
                {dm.total != null && (
                  <div className="lc-dlg-row">
                    <dt>弹幕总量</dt>
                    <dd className="lc-dlg-num">{dm.total.toLocaleString('zh-CN')}</dd>
                  </div>
                )}
                {dm.source === 'self' && dm.text_count != null && (
                  <div className="lc-dlg-row">
                    <dt>文本弹幕</dt>
                    <dd className="lc-dlg-num">{dm.text_count.toLocaleString('zh-CN')}</dd>
                  </div>
                )}
                {dm.source === 'self' && (
                  <div className="lc-dlg-row">
                    <dt>词云来源</dt>
                    <dd>
                      本地统计（分词引擎 {dm.engine ?? 'jieba'}）
                      <span className="lc-dlg-note"> · 上游未提供热词</span>
                    </dd>
                  </div>
                )}
                {metrics?.is_full === false && (
                  <div className="lc-dlg-row">
                    <dt>完整性</dt>
                    <dd>弹幕数据未全量（部分录制源）</dd>
                  </div>
                )}
              </dl>
              {hasWords ? (
                <MosaicCloud
                  data={cloudBubbles}
                  boxH={210}
                  restoreTick={cloudRestoreTick}
                  onPoppedChange={setCloudPopped}
                />
              ) : (
                /* D4：把"上游没给"与"本场没弹幕"与"拉取失败"分开说 ——
                   此前三种情况共用一句「暂无热词数据」，用户无法分辨是谁的问题。 */
                <div className="lc-dlg-ph">
                  {wcStatus === 'fetch_failed' ? (
                    <>
                      弹幕拉取失败（网络或上游不可用）。
                      <button type="button" className="lc-dlg-cloud-build"
                              onClick={retryDanmaku} disabled={building}>
                        {building ? '重试中…' : '重试'}
                      </button>
                    </>
                  ) : wcStatus === 'no_danmaku' ? (
                    '本场没有可用于统计的文本弹幕记录'
                  ) : (
                    <>
                      上游未提供热词
                      <span className="lc-dlg-note">
                        （danmakus 未返回词云字段；可改用弹幕原文就地统计）
                      </span>
                      <button type="button" className="lc-dlg-cloud-build"
                              onClick={() => void buildCloud()} disabled={building}>
                        {building
                          ? `正在统计整场弹幕…${buildElapsed >= SLOW_HINT_SECONDS ? `（已等 ${buildElapsed}s）` : ''}`
                          : '用弹幕自建'}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="lc-dlg-ph">
              {isFreshSession(s.start_at, s.end_at) ? (
                '该场次刚结束，弹幕 / 热词仍在第三方收录中（danmakus 通常延迟数小时），稍后重新打开即可看到'
              ) : (
                <>
                  {/* ⚠️ 这里**不能**断言「本场无弹幕记录」：`danmaku` 为 null 也可能是
                      上游慢/超时导致的拉取失败，而这一场其实有上万条弹幕
                      （2026-09-13 实测：5 个最近场次全因此被误报成「没有弹幕数据」，
                      见 devlog/062）。文案必须把「没拉到」与「确实没有」分开说。
                      注：拆出 `/upstream` 端点后，上游自己的失败已由
                      `wc_status='fetch_failed'` 表达，走到这里说明**这一次请求没通**
                      （HTTP/网络），所以给的是"重试取数"而不是"用弹幕自建"。 */}
                  弹幕数据未取到
                  <span className="lc-dlg-note">
                    （上游取数请求没通；可重试）
                  </span>
                  <button type="button" className="lc-dlg-cloud-build"
                          onClick={retryDanmaku} disabled={building}>
                    重试
                  </button>
                </>
              )}
            </div>
          )}
          </div>
        </section>

        <section className="lc-dlg-sec lc-dlg-sec--full">
          {/* 「上游慢」同样挂在标题行（R36）——理由见「直播信息」那条注释 */}
          <h4 className="lc-dlg-sec-title">
            直播动态
            {up.loading && slow && (
              <span className="lc-dlg-sec-note">{waitHint}</span>
            )}
          </h4>
          <div className="lc-dlg-slot lc-dlg-slot--evts">
          {up.loading ? (
            /* 未到位：三行骨架（中止/继续这类事件通常就这么几条）——到位后行数若更多，
               多出来的部分进弹窗自己的滚动区，窗高不变（槽已把常见量预留下来）。 */
            <div className="lc-dlg-evts" data-pending="1">
              {[0, 1, 2].map((i) => (
                <div className="lc-dlg-evt" key={`skel-${i}`}>
                  <span className="lc-dlg-evt-dot" />
                  <span className="lc-skel lc-skel--time" />
                  <span className="lc-skel lc-skel--text" />
                </div>
              ))}
            </div>
          ) : (events.length || metrics?.peaks?.length) ? (
            <div className="lc-dlg-evts">
              {events.map((ev, i) => (
                <div key={`ev-${i}`} className="lc-dlg-evt">
                  <span className={`lc-dlg-evt-dot${ev.type === 7 ? ' stop' : ''}`} />
                  <span className="lc-dlg-evt-time">
                    {ev.send_date ? fmtTime(new Date(ev.send_date)) : '--:--'}
                  </span>
                  <span className="lc-dlg-evt-text">
                    {ev.type === 7 ? '直播中止' : '直播继续'}
                  </span>
                </div>
              ))}
              {(metrics?.peaks?.length ?? 0) > 0 && (
                <div className="lc-dlg-evt-block">
                  <div className="lc-dlg-evt-label">最热时刻（在线峰值）</div>
                  {(metrics!.peaks as { ts: number; count: number }[])
                    .slice(0, 3)
                    .map((p) => (
                      <div key={`peak-${p.ts}`} className="lc-dlg-evt">
                        <span className="lc-dlg-evt-dot peak" />
                        <span className="lc-dlg-evt-time">{fmtTime(new Date(p.ts))}</span>
                        <span className="lc-dlg-evt-text">
                          {Number(p.count ?? 0).toLocaleString('zh-CN')} 人在线
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          ) : upFailed ? (
            /* 上游这次没拿到：**别**写成"本场没有动态"（同弹幕段的教训，devlog/062/063） */
            <div className="lc-dlg-ph">
              未取到（上游超时或不可用）
              <button type="button" className="lc-dlg-cloud-build"
                      onClick={() => up.reload()}>
                重试
              </button>
            </div>
          ) : (
            <div className="lc-dlg-ph">暂无动态数据</div>
          )}
          </div>
        </section>

        <section className="lc-dlg-sec lc-dlg-sec--full">
          <h4 className="lc-dlg-sec-title">直播内容分析</h4>
          {s.analysis ? (
            <div className="lc-dlg-ph">{s.analysis.summary || '内容分析摘要待接入'}</div>
          ) : (
            <div className="lc-dlg-ph">接口已预留（内容分析服务接入后展示）</div>
          )}
        </section>
        </OverlayScroll>
      </div>
    </div>,
    document.body,
  )
}
