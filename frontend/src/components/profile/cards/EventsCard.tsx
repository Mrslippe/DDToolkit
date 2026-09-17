/**
 * 「大事记」卡片（R37-P3，devlog/145）—— 内置卡片之三，也是**扩展点的真示例**。
 *
 * 数据：`GET /vtuber/{id}/events`（`vtuber_events` 表，P7 建好、端点一直在，**UI 一直没接**）。
 * 卡片自己取数（视图不认识卡片需要什么）⇒ 加这张卡没改视图一行，只做了三件事：
 * 写 `events.ts`（纯口径）+ 写本组件 + 在 `cards/index.tsx` 里 `registerCardKind`。
 *
 * 增删留到 P3b（与「自定义卡片」一起做）：本批先只读，把 `vtuber_events` 这条链路先接亮。
 */
import { useEffect, useMemo, useState } from 'react'
import { CalendarClock } from 'lucide-react'

import { api } from '../../../api/api'
import type { VtuberEvent } from '../../../api/types'
import type { CardContext } from '../cardRegistry'
import { eventHint, eventItems } from '../events'

export default function EventsCard({ vtuber, refreshTick }: CardContext) {
  const [events, setEvents] = useState<VtuberEvent[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    api.listVtuberEvents(vtuber.id)
      .then((rows) => {
        if (cancelled) return
        setEvents(rows)
        setState('ready')
      })
      .catch(() => {
        if (cancelled) return
        setEvents([])
        setState('error')
      })
    return () => { cancelled = true }
  }, [vtuber.id, refreshTick])

  const items = useMemo(() => eventItems(events), [events])
  const hint = useMemo(() => eventHint(items), [items])

  if (state === 'loading' && !events.length) {
    // 骨架：与"有榜单"时同尺寸（R36 的口径 —— 数据到达不该让卡片变高）
    return (
      <ul className="evt-list" data-card-body="events" data-pending="1">
        {[0, 1, 2].map((i) => (
          <li className="evt-row" key={`skel-${i}`}>
            <span className="lc-skel evt-skel-date" />
            <span className="lc-skel lc-skel--text" />
          </li>
        ))}
      </ul>
    )
  }
  if (state === 'error') {
    return <p className="pcard-empty">大事记没取到（本地库读失败）—— 切走再切回来会重试</p>
  }

  return (
    <div className="evt" data-card-body="events">
      {items.length ? (
        <ul className="evt-list">
          {items.map((it) => (
            <li key={it.id} className={`evt-row${it.days === 0 ? ' today' : ''}`}
                title={`${it.date} · ${it.when}`}>
              <span className="evt-icon" aria-hidden="true"><CalendarClock size={12} /></span>
              <span className="evt-date">{it.date.slice(5)}</span>
              <span className="evt-title">{it.title}</span>
              <span className="evt-when">{it.when}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pcard-empty">{hint}</p>
      )}
      {items.length > 0 && <p className="evt-hint">{hint}</p>}
    </div>
  )
}