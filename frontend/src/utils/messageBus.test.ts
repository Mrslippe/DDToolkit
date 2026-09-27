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
import { describe, expect, it } from 'vitest'

import { on } from './appEvents'
import { MESSAGE_STREAM_PATH } from './eventStream'
import { KNOWN_MESSAGE_TYPES, bridgeMessage, type BusMessage } from './messageBus'

const msg = (type: string, payload: Record<string, unknown> = {}, replay = false): BusMessage => ({
  type, payload, ts: 1, seq: 1, replay,
})

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
