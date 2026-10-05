/**
 * 通知样式调测页（`?notice-lab`，dev 构建；生产构建里 `import.meta.env.DEV` 为 false ⇒ 摇掉）。
 *
 * ## 为什么需要它（用户 2026-10-05 要的："方便我检查所有种类的消息通知样式"）
 *
 * 通知的验收标准里有一半是**观感**（倒计时细条读不读得懂、滑出动画顺不顺、
 * 三种点色在深色底上分不分得清），而探针只能证明"属性对了"。这个面板做两件事：
 *   ① **每类消息一个按钮** —— 点一下就走**真实路径**产生一条通知（不是另画一套假 DOM），
 *      所以"这里看到的样子"就是"真出事时的样子"；
 *   ② **一键批量** —— 按分组一次性把所有类别打出来，用来看**并存时的观感**
 *      （胶囊上那句合并文案、面板三组的排布、多条倒计时同时走）。
 *
 * ## 路径的诚实说明（哪些是真实触发、哪些只能注入）
 *
 * | 类别 | 这里怎么产生 | 真实性 |
 * |---|---|---|
 * | 命令回执（toast） | `pillMessage` 事件 | 真实（与 `utils/pill.ts` 同一条） |
 * | 客户端事实（通知面板） | `noticeAlert` 事件 | 真实（与磁盘/更新钩子同一条） |
 * | 手动任务受理进度 | `notice.progress`（**经后端 SSE**） | 真实（与点按钮同一条） |
 * | 开播边沿 | `domain.live.edge`（经 SSE） | 真实（与 T0 检测同一条） |
 * | 完成报告 | `__ddtoolkitSeedReport`（注入） | **注入**：真报告要等一轮全量抓取跑完 |
 * | 后端消息 / 开播环形条目 | `POST /messages/debug/publish` | 半真实：发布是真的，内容是我们造的 |
 *
 * ⚠️ 后两类**只能注入**（真实触发要等真机事件或整个抓取轮），面板上标了「注入」。
 * 这不是偷懒：报告那条的渲染分支与真实路径**同一个**（走 `extraLocal` 那一层，
 * 与 `__ddtoolkitSeedReport` 早就这么做，见 `TopBar` 的注释）。
 */
import { useEffect, useState } from 'react'
import { authFetch } from '../api/api'
import { EVENTS, emit } from '../utils/appEvents'
import type { Notice } from '../utils/notificationHub'
import { EVENT_TTL_MS, LIVE_NOTICE_MS } from '../utils/notificationHub'
import '../styles/notice-lab.css'

/**
 * 后端 dev-only 的合成发布口（`app/routers/messages_debug.py`）。
 *
 * ⚠️ **路径是 `/messages/_debug/publish`**（下划线！第一版写成 `/messages/debug/publish`
 * 换回一片 404 —— 而这正是 `probe.ts` 里那个 `publish()` helper 用的路径，照抄它就不会错）。
 * ⚠️ **必须走 `authFetch`**：它负责 ① dev 下是 `/api` 前缀或 Vite 注入的绝对地址
 * （不是裸相对路径）；② 后端每个业务端点都要 `X-DDToolkit-Token`（`app/core/api_auth.py`）。
 */
async function publish(type: string, payload: Record<string, unknown>): Promise<string> {
  try {
    const r = await authFetch('/messages/_debug/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, payload }),
    })
    return r.ok ? `已发布 ${type}` : `发布 ${type} 失败：HTTP ${r.status}`
  } catch (e) {
    return `发布 ${type} 失败：${(e as Error)?.message || String(e)}`
  }
}

interface Row {
  /** 稳定 key（DOM 上写 `data-lab-row`）：探针/排查脚本按它点某一条、也便于人读日志 */
  key: string
  /** 按钮文案 */
  label: string
  /** 产生方式（面板上标出来，免得把"注入"当成"真实触发"） */
  how: '真实' | '注入' | '半真实'
  /** 预期落在哪一组（用户点完自己对照） */
  expect: string
  run: () => void | Promise<string>
}

export default function NoticeLab() {
  const [open, setOpen] = useState(true)
  const [log, setLog] = useState<string[]>([])
  const say = (s: string) => setLog((prev) => [s, ...prev].slice(0, 40))

  /**
   * 调测页的条目**停留久一点**（用户 2026-10-05 反馈"④⑤⑥⑪ 点了没内容"之后加的）。
   *
   * 为什么必须改：那四条的真实寿命是 **8s**（推送来的进度兜底）/ **6s**（toast）/ 2 分钟（开播）。
   * 点一下、再把鼠标移到胶囊上、面板弹出来 —— 8 秒已经过去了：**条目刚好在你看到之前过期**，
   * 于是"点了没反应"。而产品的 TTL 是**对的**（进度本来就该 8 秒兜底、回执就该 6 秒），
   * **不该为了调测去改它** ⇒ 改的是这里：调测页产生的条目一律按 `LAB_TTL_MS` 注入，
   * 好让你有时间看。真机计时想看的话，第 ④⑤条旁边写了它真实活多久。
   *
   * ⚠️ 这层 TTL 只作用于**调测页产生的条目**（产品路径一个字没动）。
   */
  const LAB_TTL_MS = 120_000

  /** 注入一组条目（`TopBar` 的 dev 口，与 `__ddtoolkitSeedReport` 同一层）
   *
   *  `ttlMs` 给了就把 `expiresAt` 换成它（上面那条注释的理由）；不给 = 保留原样。 */
  const seed = (list: Notice[] | null, ttlMs?: number) => {
    const w = window as unknown as {
      __ddtoolkitSeedNotices?: (n: Notice[] | null) => void
    }
    if (!w.__ddtoolkitSeedNotices) { say('注入口不在（生产构建？）'); return }
    const now0 = Date.now()
    w.__ddtoolkitSeedNotices(list?.map((n) => (
      ttlMs ? { ...n, createdAt: n.createdAt ?? now0, expiresAt: now0 + ttlMs } : n
    )) ?? null)
    // 记一行：调测页自己说"我注了哪条" —— 它和面板里实际出现的条目对不上时，
    // 一眼就能看出是"没注进去"还是"注进去又被清了"（本次就是靠它定位到 hook 被重建）
    say(`已注入 ${list ? list.map((n) => n.id).join(',') : '(clear)'}`)
  }

  /**
   * 面板**自动钉住**（同上）：不这么做的话，点一下之后还得先 hover 胶囊、等 120ms 才弹面板 ——
   * 而 ①①③ 那些条目 6 秒就没了。调测页的存在意义就是"点完立刻看到"。
   */
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      const cap = document.querySelector<HTMLElement>('.si-island')
      if (!cap) return
      cap.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      window.setTimeout(() => cap.click(), 160)
    }, 400)
    return () => window.clearTimeout(t)
  }, [open])

  const now = () => Date.now()

  const rows: Row[] = [
    {
      key: 'pill',
      label: '① 命令回执（toast）',
      how: '真实', expect: '顶部居中 toast，4s',
      run: () => { emit(EVENTS.pillMessage, { text: '设置已保存 · 3 项' }); say('pillMessage') },
    },
    {
      key: 'alert',
      label: '② 客户端事实（面板「最近」）',
      how: '真实', expect: 'recent 组 · 6s 倒计时细条 + 胶囊环',
      run: () => {
        emit(EVENTS.noticeAlert, {
          id: 'local-lab', source: '调测',
          text: '发现新版本 v9.9.9 —— 设置 → 关于 可查看并更新',
        })
        say('noticeAlert')
      },
    },
    {
      key: 'disk',
      label: '③ 磁盘快满（面板「最近」）',
      how: '真实', expect: 'recent 组 · 源「磁盘」',
      run: () => {
        emit(EVENTS.noticeAlert, {
          id: 'local-lab-disk', source: '磁盘',
          text: '磁盘可用空间不足 5GB（数据目录已占 1234MB）—— 设置 → 关于 可查看占用并清理',
        })
        say('noticeAlert(磁盘)')
      },
    },
    {
      key: 'progress-post',
      label: '④ 手动任务受理进度（胶囊+doing 组）',
      how: '真实', expect: 'doing 组 · 无倒计时 · 真实寿命 8s（这里按 LAB_TTL 留 2 分钟）',
      run: async () => {
        const s = await publish('notice.progress', {
          task: 'post', text: '全量抓取中 - 调测V - 3/11', originator: '',
        })
        // 真实那条 8s 后会自己过期（进度本来就不该赖着）—— 调测页再注入一份**同文案**的长命版，
        // 好让你有时间看样式。分两条：上面那条验的是"路径通不通"，这条验的是"长什么样"。
        seed([{
          id: 'progress-post-demo', kind: 'progress', form: 'state', source: '任务进度',
          text: '全量抓取中 - 调测V - 3/11', createdAt: now(),
        }], LAB_TTL_MS)
        say(s); return s
      },
    },
    {
      key: 'progress-account',
      label: '⑤ 账号流进度（胶囊+doing 组）',
      how: '真实', expect: 'doing 组 · 与④**合并**成一句 · 真实寿命 8s',
      run: async () => {
        const s = await publish('notice.progress', {
          task: 'account', text: '账号信息抓取中 - 调测V - 1/2', originator: '',
        })
        seed([{
          id: 'progress-account-demo', kind: 'progress', form: 'state', source: '任务进度',
          text: '账号信息抓取中 - 调测V - 1/2', createdAt: now(),
        }], LAB_TTL_MS)
        say(s); return s
      },
    },
    {
      key: 'live',
      label: '⑥ 开播告警（有时窗的告知）',
      how: '真实', expect: 'recent 组 · 2 分钟倒计时 · 胶囊上合并成「N 场开播」',
      run: async () => {
        const s = await publish('domain.live.edge', {
          vtuber_id: 1, account_id: 9001, platform: 'bilibili', platform_uid: '9001',
          name: '调测用V', live_title: '【调测】歌回', live_url: '',
        })
        // ⚠️ 这条**不能**再注入一份：它的 id 是 `live-<account_id>`，与服务端环形缓冲那条同 id
        //    ⇒ 注入会把真正那条顶掉（`mergeNotices` 按 id 去重、本地优先），于是你看到的是
        //    "我造的那条"而不是"路径真的通了"。它本来就有 2 分钟 TTL，够看。
        say(s); return s
      },
    },
    {
      key: 'rate-limit',
      label: '⑦ 风控冷却（状态类 + 活数据槽）',
      how: '注入', expect: 'doing 组 · 文案右侧 `value` 槽每秒刷新 · 剩余时间递减',
      run: () => {
        // 真触发要等平台真的限流 ⇒ 注入。形态与 `notices._rate_limit_notice` 逐字一致。
        seed([{
          id: 'rate-limit', kind: 'alert', form: 'state', source: '风控冷却',
          text: '上游限流：冷却中', value: '47s', detail: 'HTTP 412（bilibili）',
          createdAt: now() - 30_000, expiresAt: now() + 47_000,
        }])
        say('注入 rate-limit')
      },
    },
    {
      key: 'login',
      label: '⑧ 登录失效（常驻 + 动作按钮）',
      how: '注入', expect: 'doing 组 · 常驻 · 「去登录」按钮',
      run: () => {
        seed([{
          id: 'login-expired', kind: 'alert', form: 'state', source: '登录态',
          text: 'B 站登录已失效',
          detail: '抓取会跳过需要登录的部分；重新扫码后自动恢复',
          sticky: true, createdAt: now(), action: { label: '去登录', kind: 'login' },
        }])
        say('注入 login-expired')
      },
    },
    {
      key: 'caps',
      label: '⑨ 能力受限（状态 + 「查看受限项」）',
      how: '注入', expect: 'doing 组 · 常驻 · 点按钮打开受限项列表',
      run: () => {
        seed([{
          id: 'cap-limits', kind: 'alert', form: 'state', source: '能力矩阵',
          text: '有 3 项功能受限', sticky: true, createdAt: now(),
          action: { label: '查看受限项', kind: 'open-limits' },
        }])
        say('注入 cap-limits')
      },
    },
    {
      key: 'report',
      label: '⑩ 完成报告（处置类 + 一键已读）',
      how: '注入', expect: 'todo 组 · 常驻 · 组标题右侧出现「全部已读」',
      run: () => {
        const w = window as unknown as {
          __ddtoolkitSeedReport?: (r: Record<string, unknown> | null) => void
        }
        w.__ddtoolkitSeedReport?.({
          seq: 999, kind: 'full_all', stored: 42, skipped: 3, video_missing: 2,
          issues: [{ label: '调测账号', stop_reason: 'rate_limited' }],
        })
        say('注入报告')
      },
    },
    {
      key: 'message',
      label: '⑪ 推送来的完成回执（toast + 面板「最近」）',
      how: '半真实',
      expect: '顶部 toast（6s）+ 面板 recent 留痕（这里按 LAB_TTL 留 2 分钟）',
      run: async () => {
        const text = '帖子抓取完成 · 存储 7 · 跳过 1'
        const s = await publish('notice.message', { text })
        // 同 ④⑤：真实那条是 **toast**（6s 就没），而它同时在面板「最近」里留痕 ——
        // 注入一份长命的，好让你看清"面板里它长什么样"（toast 那一份由真实路径产生）
        seed([{
          id: 'pushed-message-demo', kind: 'message', form: 'notice', source: '操作结果',
          text, createdAt: now(),
        }], LAB_TTL_MS)
        say(s); return s
      },
    },
    {
      key: 'server-state',
      label: '⑫ 服务端形态的状态条目（没有 TTL）',
      how: '注入',
      expect: 'doing 组 · **一直留着**（不是闪一下就走）· 与别的条目并存时计数对得上',
      run: () => {
        /**
         * ⚠️ **这一条必须按服务端的原样注入，不许套 `LAB_TTL_MS`**（2026-10-06，`devlog/357`）。
         *
         * 用户报的现场：点了「全量拉取第三方数据」，面板里**没有**那条「正在同步…」，
         * 计数却是 `通知（2）`。根因是 `GET /vtuber/notices` 回来的进度条目带着
         * **`"expiresAt": null`**（后端契约 `NoticeOut.expiresAt: int | None`），
         * 而 `isLive` 原来只认 `undefined` ⇒ 它被判成"已过期"：面板不画它、计数却还数着它；
         * 它只以"正在退场"的身份闪 ~220ms（所以肉眼与探针都容易漏）。
         *
         * ④⑤ 之所以没抓到：它们走 `seed([...], LAB_TTL_MS)` —— **给了数字 TTL**，
         * 于是永远"活着"。这里刻意不套 TTL、并显式写 `expiresAt: null`，
         * 形状与真实响应逐字一致（探针 `--notice-lab` 专门点这一条并等退场队列跑完再看）。
         */
        seed([{
          id: 'progress-external-lab', kind: 'progress', form: 'state', source: '第三方同步',
          text: '正在同步第三方数据（全量）', sticky: false, expiresAt: null,
          createdAt: now(),
        }])
        say('注入服务端形态的进度（expiresAt: null —— 与真实响应一致）')
      },
    },
  ]

  /** 触发一行（**逐行兜异常**）。 */
  const fire = async (r: Row) => {
    try {
      await r.run()
    } catch (e) {
      // ⚠️ 调测页最怕"点了没反应"：一个按钮抛了，用户只会以为那种通知坏了。
      // 所以**每一行自己兜住**并把原因写进日志（第一版没兜：批量到第 ④ 行抛了，
      // 后面七类一条都没发出去，而界面上什么提示都没有 —— 探针报"没有「去登录」"）。
      say(`✗ ${r.label} 失败：${(e as Error)?.message || String(e)}`)
    }
  }

  const fireAll = async () => {
    say('—— 批量：全部类别 ——')
    for (const r of rows) {
      await fire(r)
      // 隔开一点：倒计时/合并文案的观感要看"多条并存"，而一口气同步发会挤在同一毫秒
      await new Promise((res) => setTimeout(res, 250))
    }
    say('—— 批量完成（打开胶囊看合并句与三组）——')
  }

  const clearAll = () => {
    seed(null)
    const w = window as unknown as { __ddtoolkitSeedReport?: (r: null) => void }
    w.__ddtoolkitSeedReport?.(null)
    say('已清掉注入的条目（真实路径产生的那些按各自 TTL 自己走）')
  }
  if (!open) {
    return (
      <button type="button" className="nl-fab" onClick={() => setOpen(true)}>
        通知调测
      </button>
    )
  }

  return (
    <div className="nl-panel" data-notice-lab="1">
      <div className="nl-head">
        <b>通知调测</b>
        <span className="nl-hint">点一下就走真实路径产生一条通知</span>
        <button type="button" className="nl-btn" onClick={() => void fireAll()}>批量全部</button>
        <button type="button" className="nl-btn" onClick={clearAll}>清注入</button>
        <button type="button" className="nl-btn" onClick={() => setOpen(false)}>收起</button>
      </div>
      <ul className="nl-list">
        {rows.map((r) => (
          <li key={r.label} className="nl-row" data-lab-row={r.key}>
            <button type="button" className="nl-btn nl-fire" onClick={() => void fire(r)}>
              {r.label}
            </button>
            <span className={`nl-how nl-how-${r.how}`}>{r.how}</span>
            <span className="nl-expect">{r.expect}</span>
          </li>
        ))}
      </ul>
      <div className="nl-log" data-lab-log="1">
        {log.length === 0 ? <span className="nl-hint">（还没有动作）</span>
          : log.map((l, i) => <div key={`${i}-${l}`}>{l}</div>)}
      </div>
      <p className="nl-note">
        提示：①②③⑥ 有倒计时（细条 + 胶囊环）；④⑤⑦ 没有（它们不会自己走）；
        ⑩ 在「需要处理」组、组标题右侧有「全部已读」。
        <br />
        文案常量：告知类 {Math.round(EVENT_TTL_MS / 1000)}s · 开播 {Math.round(LIVE_NOTICE_MS / 60000)} 分钟
        （改这两个数只用改 `notificationHub.ts`）。
      </p>
    </div>
  )
}
