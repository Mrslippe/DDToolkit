/**
 * 消息中心的**前端桥**判据（M0b，devlog/242）。
 *
 * 三组：
 * ① 消息 → 应用事件的分发（含**重连补发不弹提示**这条 §8.5 D 的定稿语义）；
 * ② **跨语言契约**：`KNOWN_MESSAGE_TYPES` 必须与后端 `app/services/messages.py::KNOWN_TYPES`
 *    逐字一致（类型字符串是隐式契约 —— 后端拼错会当场抛，前端拼错只会**静默没人理**）；
 * ③ **S-1 / V5 结构判据**：访问令牌只允许出现在"设请求头"那一处。
 *
 * ⚠️ 跑在 node 环境：`window` 不存在 ⇒ 事件宿主注入一个 `EventTarget`（同 `fetchIdle.test.ts`）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { on } from './appEvents'
import { mergeAccountSnapshots } from './accountSnapshots'
import { MESSAGE_STREAM_PATH } from './eventStream'
import { myHost, setHost } from './hostIdentity'
import {
  KNOWN_MESSAGE_TYPES, bridgeMessage, parseLiveEdge, parseSnapshot, startMessageBus,
  stopMessageBus, type BusMessage,
} from './messageBus'

const msg = (type: string, payload: Record<string, unknown> = {}, replay = false): BusMessage => ({
  type, payload, ts: 1, seq: 1, replay,
})

const EDGE = {
  vtuber_id: 15, account_id: 3, platform: 'bilibili', platform_uid: '434334701',
  name: '七海Nana7mi', live_title: '今晚开播', live_url: 'https://live.bilibili.com/1',
}

/** 收集宿主上某个事件名收到的 detail（返回的数组随事件增长）。 */
function collector(host: EventTarget, name: string): unknown[] {
  const seen: unknown[] = []
  on(name as never, ((d: unknown) => seen.push(d)) as never, host)
  return seen
}

const SRC = path.resolve(__dirname, '..')

/** `frontend/src/**` 下的 ts/tsx 源码（跳过测试自身）。 */
function sources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push({ rel: path.relative(SRC, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') })
      }
    }
  }
  walk(SRC)
  return out
}

describe('① 消息 → 应用事件', () => {
  it('每条消息都发 `ddtoolkit:message`（M1–M5 的挂点），payload 是原样的信封', () => {
    const host = new EventTarget()
    const seen = collector(host, 'ddtoolkit:message')
    const m = msg('domain.posts.changed', { uid: '1' })
    bridgeMessage(m, host)
    expect(seen).toEqual([m])
  })

  it('`notice.message`（现场消息）⇒ 顺带点亮顶栏胶囊', () => {
    const host = new EventTarget()
    const pills = collector(host, 'ddtoolkit:pill-message')
    bridgeMessage(msg('notice.message', { text: '抓取完成' }), host)
    expect(pills).toEqual([{ text: '抓取完成' }])
  })

  it('**重连补发（`replay:true`）不弹提示** —— 否则每次断线重连都会重播一串历史 toast', () => {
    const host = new EventTarget()
    const msgs = collector(host, 'ddtoolkit:message')
    const pills = collector(host, 'ddtoolkit:pill-message')
    bridgeMessage(msg('notice.message', { text: '历史' }, true), host)
    expect(msgs, '消息本体照旧要发（订阅方自己决定怎么用）').toHaveLength(1)
    expect(pills, '补发不许弹提示').toEqual([])
  })

  it('没有 text 的 `notice.message` 不弹（空胶囊是纯噪声）', () => {
    const host = new EventTarget()
    const pills = collector(host, 'ddtoolkit:pill-message')
    bridgeMessage(msg('notice.message', {}), host)
    bridgeMessage(msg('notice.message', { text: '' }), host)
    expect(pills).toEqual([])
  })

  it('领域事件与别的 notice 不弹胶囊（各自的消费者在 M1–M5 里接）', () => {
    const host = new EventTarget()
    const pills = collector(host, 'ddtoolkit:pill-message')
    for (const t of ['domain.vtuber.updated', 'domain.account.snapshot', 'domain.posts.changed',
                     'domain.live.edge', 'notice.progress', 'notice.alert', 'notice.report']) {
      bridgeMessage(msg(t, { text: 'x' }), host)
    }
    expect(pills).toEqual([])
  })

  it('开播边沿（M1）解成**结构化**事件 —— 消费方不必自己解析信封', () => {
    const host = new EventTarget()
    const edges = collector(host, 'ddtoolkit:live-edge')
    bridgeMessage(msg('domain.live.edge', EDGE), host)
    expect(edges).toEqual([EDGE])
  })

  it('开播 payload 缺字段 ⇒ **不发半个事件**（后端改名时宁可什么都不发）', () => {
    const host = new EventTarget()
    const edges = collector(host, 'ddtoolkit:live-edge')
    const { live_url: _drop, ...partial } = EDGE
    bridgeMessage(msg('domain.live.edge', partial), host)
    bridgeMessage(msg('domain.live.edge', {}), host)
    expect(edges).toEqual([])
    expect(parseLiveEdge(undefined)).toBeNull()
    expect(parseLiveEdge({})).toBeNull()
  })

  it('**补发的开播边沿不播** —— 重连不该把「几小时前就开播了」再提示一遍', () => {
    const host = new EventTarget()
    const edges = collector(host, 'ddtoolkit:live-edge')
    bridgeMessage(msg('domain.live.edge', EDGE, true), host)
    expect(edges).toEqual([])
  })
})

describe('①″ 手动动作（M2）：受理推进度、完成看 originator', () => {
  it('`notice.progress` 解成结构化事件，**不管是不是自己点的都发**', () => {
    const host = new EventTarget()
    const progresses = collector(host, 'ddtoolkit:progress')
    bridgeMessage(msg('notice.progress', { task: 'account', text: '账号信息抓取中 - V',
                                           originator: 'main' }), host)
    expect(progresses).toEqual([
      { task: 'account', text: '账号信息抓取中 - V', originator: 'main' },
    ])
  })

  it('缺 `text` 的进度不发（不发半个事件）', () => {
    const host = new EventTarget()
    const progresses = collector(host, 'ddtoolkit:progress')
    bridgeMessage(msg('notice.progress', { task: 'account' }), host)
    bridgeMessage(msg('notice.progress', {}), host)
    expect(progresses).toEqual([])
  })

  it('**自己点的那次完成不重复弹**（本地已经弹过胶囊了）', () => {
    const host = new EventTarget()
    const pills = collector(host, 'ddtoolkit:pill-message')
    bridgeMessage(msg('notice.message', { text: '账号信息更新完成 · 成功 1', originator: 'main' }), host)
    expect(pills, '自己点的 ⇒ 不弹').toEqual([])
  })

  it('别人点的完成**要**弹（小窗点的动作，主窗口得知道）', () => {
    const host = new EventTarget()
    const pills = collector(host, 'ddtoolkit:pill-message')
    bridgeMessage(msg('notice.message', { text: '账号信息更新完成 · 成功 1', originator: 'widget' }), host)
    expect(pills).toEqual([{ text: '账号信息更新完成 · 成功 1' }])
  })

  it('**没带宿主**的完成照常弹（"不知道谁点的" ⇒ 宁可重复也不要静默丢掉一条通知）', () => {
    const host = new EventTarget()
    const pills = collector(host, 'ddtoolkit:pill-message')
    bridgeMessage(msg('notice.message', { text: '搞定了' }), host)
    expect(pills).toEqual([{ text: '搞定了' }])
  })

  it('宿主标识默认 `main`，可显式切到 `widget`（小窗入口用）', () => {
    expect(myHost()).toBe('main')
    setHost('widget')
    try {
      const host = new EventTarget()
      const pills = collector(host, 'ddtoolkit:pill-message')
      bridgeMessage(msg('notice.message', { text: 'x', originator: 'widget' }), host)
      expect(pills, '小窗自己点的 ⇒ 也不弹').toEqual([])
    } finally {
      setHost('main')
    }
  })
})

describe('①‴ 账号快照（M3）：复用现有 `account-progress` 事件', () => {
  const SNAP = {
    platform_uid: '11073', display_name: '快照V', sign: '新签名', followers_count: 999,
    live_status: 1, live_title: '今晚八点', avatar_path: null,
  }

  it('`domain.account.snapshot` ⇒ `account-progress`（**数组**，与轮询那份同形状）', () => {
    const host = new EventTarget()
    const updates = collector(host, 'ddtoolkit:account-progress')
    bridgeMessage(msg('domain.account.snapshot', SNAP), host)
    expect(updates).toEqual([[SNAP]])
  })

  it('缺字段的快照不发（半个 snapshot 合并进侧栏会留下空字段）', () => {
    const host = new EventTarget()
    const updates = collector(host, 'ddtoolkit:account-progress')
    const { sign: _drop, ...partial } = SNAP
    bridgeMessage(msg('domain.account.snapshot', partial), host)
    bridgeMessage(msg('domain.account.snapshot', {}), host)
    expect(updates).toEqual([])
    expect(parseSnapshot(undefined)).toBeNull()
  })

  it('**同一条快照应用两次是空操作**（推送与轮询并存时不打架）', () => {
    // 这是"并存"能成立的根据：合并按**字段内容**做（`mergeAccountSnapshots`），
    // 与"谁来触发"无关 —— 推送先到、轮询后到，结果一样。
    const acc = {
      id: 1, vtuber_id: 1, platform: 'bilibili', platform_uid: '11073',
      display_name: '旧名字', sign: null, followers_count: 1, live_status: 0,
      live_title: null, avatar_path: null, sort_order: 0,
    } as unknown as Parameters<typeof mergeAccountSnapshots>[0]
    const once = mergeAccountSnapshots(acc, [SNAP as never])!
    const twice = mergeAccountSnapshots(once, [SNAP as never])!
    expect(twice).toEqual(once)
    expect(twice.followers_count).toBe(999)
    expect(twice.display_name).toBe('快照V')
  })
})

describe('①′ 读到流的见证（M1）：第一块字节到手 ⇒ 报一次', () => {
  afterEach(() => { stopMessageBus() })

  it('`onFirstChunk` ⇒ `POST /messages/ack` **恰好一次**（真机验收靠这行日志）', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    let push!: (chunk: string) => void
    const body = new ReadableStream<Uint8Array>({
      start(c) { push = (s) => c.enqueue(new TextEncoder().encode(s)) },
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('/messages/ack')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response
      }
      return { ok: true, status: 200, body } as Response
    }))

    startMessageBus()
    await new Promise((r) => setTimeout(r, 10))
    push(': connected\n\n')                       // 第一块字节
    await new Promise((r) => setTimeout(r, 30))
    const acks = calls.filter((c) => c.url.endsWith('/messages/ack'))
    expect(acks, `实际调用：${calls.map((c) => c.url).join(', ')}`).toHaveLength(1)
    expect(new Headers(acks[0].init.headers).get('Content-Type')).toBe('application/json')
  })

  it('ack 失败**静默**（它只是见证，不该影响任何业务流程）', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(': connected\n\n')) },
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/messages/ack')) throw new Error('网络断了')
      return { ok: true, status: 200, body } as Response
    }))
    startMessageBus()
    await new Promise((r) => setTimeout(r, 40))
    expect(true, '抛出来就会被 vitest 记为 unhandled rejection').toBe(true)
  })
})

describe('② 跨语言契约：类型字符串两边必须逐字一致', () => {
  it('与后端 `app/services/messages.py::KNOWN_TYPES` 同集合', () => {
    // 后端拼错类型会当场 `ValueError`；前端拼错只会"静默没人理" ⇒ 这条是前端的兜底。
    const py = path.resolve(__dirname, '../../../app/services/messages.py')
    expect(fs.existsSync(py), `找不到后端真源 ${py}（前端用例必须在仓库里跑）`).toBe(true)
    const text = fs.readFileSync(py, 'utf8')
    // 常量在上面一行一条（`MSG_X = "domain.x.y"`），集合在 KNOWN_TYPES 里只列名字 ⇒ 两段都要读
    const values = new Map(
      [...text.matchAll(/^(MSG_[A-Z_]+)\s*=\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]),
    )
    const head = text.indexOf('KNOWN_TYPES')
    const block = text.slice(head, text.indexOf('})', head))
    const names = [...block.matchAll(/\bMSG_[A-Z_]+\b/g)]
      .map((m) => values.get(m[0]))
      .filter((v): v is string => Boolean(v))
    expect(names.length, '没从后端源码里解析出类型（正则漂了？）').toBeGreaterThanOrEqual(8)
    expect([...KNOWN_MESSAGE_TYPES].sort()).toEqual([...names].sort())
  })
})

describe('③ S-1 / V5 结构判据：访问令牌不许被拼进任何字符串', () => {
  /** 去掉注释行（注释里提到变量名是正常的，比如"别把它拼进 URL"这类说明）。 */
  const stripped = (text: string) =>
    text.split('\n').map((l) => {
      const t = l.trim()
      return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') ? '' : l
    })

  it('`${apiToken}` / `${TOKEN_HEADER}` 这类**插值**一处都不许有（方案 §2.1 的判据）', () => {
    const offenders: string[] = []
    for (const { rel, text } of sources()) {
      stripped(text).forEach((line, i) => {
        if (/\$\{[^}]*\b(apiToken|TOKEN_HEADER)\b[^}]*\}/.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders, '令牌只能进请求头，不许进 URL / query').toEqual([])
  })

  it('只有 `api/api.ts` 能读到 `apiToken`（别的文件要用 token 必须走 `authFetch`）', () => {
    const offenders: string[] = []
    for (const { rel, text } of sources()) {
      if (rel === 'api/api.ts') continue
      stripped(text).forEach((line, i) => {
        if (/\bapiToken\b/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders, '其它模块要用带 token 的请求 ⇒ 走 `authFetch()`').toEqual([])
  })

  it('推送端点路径不带 query，也不带 `token` 这个参数名', () => {
    expect(MESSAGE_STREAM_PATH).toBe('/messages/stream')
    expect(MESSAGE_STREAM_PATH).not.toContain('?')
    expect(MESSAGE_STREAM_PATH).not.toContain('token')
  })
})
