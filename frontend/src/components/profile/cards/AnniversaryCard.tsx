/**
 * 「纪念日」卡片（R37-P1，devlog/141；R37-P4a 重排为 hero + 事实行；R42 开放自定义）。
 *
 * 数据两个来源：
 *  ① `vtubers.birthday / debut_date`（内置两行，**派生只读** —— 在「档案设置」里改）；
 *  ② `vtuber_events` 里 `kind='anniversary'` 的条目（**用户自己加的**，R42）——
 *     名称/日期/emoji 三样都能填，口径在 `customEntries.ts`。
 * 两者**并成一套**再算 hero：倒计时是"最近的一个"，用户加的纪念日当然也该参与倒数
 * （否则加了生日却不算，看着像没生效）。
 *
 * ⚠️ 增删只在**编辑布局**态出现：阅读态是"看"的地方，误触删掉一条没法撤销。
 */
import { Cake, Plus, Sparkles, X } from 'lucide-react'
import { useState } from 'react'

import type { CardContext } from '../cardRegistry'
import { anniversaryHero, anniversaryItems } from '../anniversary'
import { EMPTY_DRAFT, customAnniversaryItems, draftError, useCustomEntries } from '../customEntries'
import type { EntryDraft } from '../customEntries'

export default function AnniversaryCard({ vtuber, refreshTick, editing }: CardContext) {
  const { items: custom, busy, error, add, edit, remove } =
    useCustomEntries(vtuber.id, 'anniversary', refreshTick)
  const [draft, setDraft] = useState<EntryDraft>(EMPTY_DRAFT)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [formOpen, setFormOpen] = useState(false)

  const items = [...anniversaryItems(vtuber), ...customAnniversaryItems(custom)]
  const hero = anniversaryHero(items)
  const customIds = new Set(custom.map((c) => c.id))
  const bad = draftError(draft)

  const submit = () => {
    if (bad) return
    if (editingId != null) void edit(editingId, draft)
    else void add(draft)
    setDraft(EMPTY_DRAFT)
    setEditingId(null)
    setFormOpen(false)
  }

  return (
    <div className="anniv" data-card-body="anniversary">
      {hero && (
        <div className="anniv-hero" data-anniv-hero>
          <span className="anniv-hero-main">
            <span className="anniv-hero-value">{hero.value}</span>
            {hero.unit && <span className="anniv-hero-unit">{hero.unit}</span>}
          </span>
          <span className="anniv-hero-caption">{hero.caption}</span>
        </div>
      )}

      <ul className="anniv-list" data-anniv-count={items.length}>
        {items.map((it) => {
          const id = customIds.has(Number(it.key.replace('custom-', '')))
            ? Number(it.key.replace('custom-', '')) : null
          return (
            <li key={it.key}
                className={`anniv-row${it.days === 0 ? ' today' : ''}${id != null ? ' custom' : ''}`}
                data-anniv-row={it.key}
                title={it.raw ?? '未记录'}>
              <span className="anniv-icon" aria-hidden="true">
                {it.emoji
                  ? <span className="anniv-emoji">{it.emoji}</span>
                  : it.key === 'birthday' ? <Cake size={13} /> : <Sparkles size={13} />}
              </span>
              <span className="anniv-label">{it.label}</span>
              <span className="anniv-value" data-anniv={it.key}>{it.fact}</span>
              {editing && id != null && (
                <span className="anniv-row-ops">
                  <button type="button" className="anniv-op" title="改这一条"
                          onClick={() => {
                            setEditingId(id)
                            setFormOpen(true)
                            setDraft({
                              title: it.label,
                              event_date: it.raw ?? '',
                              emoji: it.emoji ?? '',
                            })
                          }}>改</button>
                  <button type="button" className="anniv-op del" title="删掉这一条"
                          disabled={busy} onClick={() => void remove(id)}>
                    <X size={11} />
                  </button>
                </span>
              )}
            </li>
          )
        })}
      </ul>

      {editing && (
        <div className="anniv-add">
          {formOpen ? (
            <div className="anniv-form" data-anniv-form>
              <input className="anniv-in emoji" value={draft.emoji} maxLength={4}
                     placeholder="🎂" aria-label="图标"
                     onChange={(e) => setDraft({ ...draft, emoji: e.target.value })} />
              <input className="anniv-in name" value={draft.title} placeholder="名称（生日歌回）"
                     aria-label="名称"
                     onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              <input className="anniv-in date" type="date" value={draft.event_date}
                     aria-label="日期"
                     onChange={(e) => setDraft({ ...draft, event_date: e.target.value })} />
              <button type="button" className="anniv-op ok" disabled={!!bad || busy}
                      title={bad ?? '保存'} onClick={submit}>
                {editingId != null ? '保存' : '添加'}
              </button>
              <button type="button" className="anniv-op"
                      onClick={() => { setFormOpen(false); setEditingId(null); setDraft(EMPTY_DRAFT) }}>
                取消
              </button>
            </div>
          ) : (
            <button type="button" className="anniv-add-btn" data-anniv-add
                    onClick={() => setFormOpen(true)}>
              <Plus size={12} /> 添加纪念日
            </button>
          )}
        </div>
      )}

      <p className="anniv-hint" data-anniv-hint>
        {error
          ? `保存失败：${error}`          // 失败要看得见（静默失败会让人以为存上了）
          : hero
            ? '倒计时按本地日期算；自己加的纪念日一起参与倒数'
            : '还没填生日 / 出道日 —— 可在「档案设置」里补，或在这里自己加一条'}
      </p>
    </div>
  )
}
