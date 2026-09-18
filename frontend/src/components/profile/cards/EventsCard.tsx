/**
 * 「大事记」卡片（R37-P3，devlog/145；R42 改成**时间轴**）。
 *
 * 用户口径（2026-09-19）：「大事记用这种**时间轴**的形式来呈现」+ 手绘草图：
 * **一条横线 + 线上若干刻度 + 标题在线上、日期在线下**（时间向右流）。
 *
 * 数据：`GET /vtuber/{id}/events?kind=event`（`vtuber_events` 表）——
 * R42 起这张表同时承载"纪念日"（`kind='anniversary'`），两张卡各取各的、互不串。
 *
 * ⚠️ 刻度位置由 `timelineNodes` 按**日期**算（纯函数、有单测）：疏密一眼看得出；
 * 只有一条或全部同一天时居中，不会贴左边缘。
 */
import { Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { CardContext } from '../cardRegistry'
import { eventItems, timelineNodes } from '../events'
import { EMPTY_DRAFT, draftError, useCustomEntries } from '../customEntries'
import type { EntryDraft } from '../customEntries'

/** 时间轴一次展示几条（多了刻度会挤在一起，反而看不清） */
const SHOW = 5

export default function EventsCard({ vtuber, refreshTick, editing }: CardContext) {
  const { items: events, busy, error, add, remove } =
    useCustomEntries(vtuber.id, 'event', refreshTick)
  const [draft, setDraft] = useState<EntryDraft>(EMPTY_DRAFT)
  const [formOpen, setFormOpen] = useState(false)

  const items = useMemo(() => eventItems(events, new Date(), SHOW), [events])
  const nodes = useMemo(() => timelineNodes(items), [items])
  const bad = draftError(draft)

  const submit = () => {
    if (bad) return
    void add(draft)
    setDraft(EMPTY_DRAFT)
    setFormOpen(false)
  }

  return (
    <div className="tl" data-card-body="events">
      {nodes.length ? (
        <div className="tl-track" data-tl-count={nodes.length}>
          {/* 横线 + 右端箭头（时间向右流，与草图一致） */}
          <span className="tl-line" aria-hidden="true" />
          <span className="tl-arrow" aria-hidden="true" />
          {nodes.map(({ item, t, future }) => (
            <div className="tl-node" key={item.id} style={{ left: `${t * 100}%` }}
                 data-tl-node={item.id}>
              <span className="tl-title" title={item.title}>{item.title}</span>
              <span className={`tl-dot${future ? ' future' : ''}${item.days === 0 ? ' today' : ''}`} />
              <span className="tl-date">{item.date.slice(5).replace('-', '.')}</span>
              {editing && (
                <button type="button" className="tl-del" title="删掉这一条" disabled={busy}
                        onClick={() => void remove(item.id)}>
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="pcard-empty">
          {error ? `读取失败：${error}` : '还没有大事记 —— 编辑布局时可以自己加'}
        </p>
      )}

      {editing && (
        <div className="tl-add">
          {formOpen ? (
            <div className="tl-form" data-tl-form>
              <input className="anniv-in name" value={draft.title} placeholder="大事记（周年庆）"
                     aria-label="标题"
                     onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              <input className="anniv-in date" type="date" value={draft.event_date}
                     aria-label="日期"
                     onChange={(e) => setDraft({ ...draft, event_date: e.target.value })} />
              <button type="button" className="anniv-op ok" disabled={!!bad || busy}
                      title={bad ?? '保存'} onClick={submit}>添加</button>
              <button type="button" className="anniv-op"
                      onClick={() => { setFormOpen(false); setDraft(EMPTY_DRAFT) }}>取消</button>
            </div>
          ) : (
            <button type="button" className="anniv-add-btn" data-tl-add
                    onClick={() => setFormOpen(true)}>
              <Plus size={12} /> 添加大事记
            </button>
          )}
        </div>
      )}

      <p className="tl-hint" data-tl-hint>
        {error ? `保存失败：${error}` : '刻度按日期铺开 · 实心点是将来的事'}
      </p>
    </div>
  )
}
