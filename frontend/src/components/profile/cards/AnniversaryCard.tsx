/**
 * 「纪念日」卡片（R37-P1，devlog/141）—— 内置卡片之一，只读。
 *
 * 数据全在 `vtubers.birthday / debut_date`（本地库，秒出）；口径在 `anniversary.ts`
 * （宽容解析 + 倒计时），这里只负责画。
 */
import { Cake, Sparkles } from 'lucide-react'

import type { CardContext } from '../cardRegistry'
import { anniversaryItems, nearestAnniversary } from '../anniversary'

export default function AnniversaryCard({ vtuber }: CardContext) {
  const items = anniversaryItems(vtuber)
  const nearest = nearestAnniversary(items)

  return (
    <div className="anniv" data-card-body="anniversary">
      <ul className="anniv-list">
        {items.map((it) => (
          <li key={it.key} className={`anniv-row${it.days === 0 ? ' today' : ''}`}
              title={it.raw ?? '未记录'}>
            <span className="anniv-icon" aria-hidden="true">
              {it.key === 'birthday' ? <Cake size={13} /> : <Sparkles size={13} />}
            </span>
            <span className="anniv-label">{it.label}</span>
            <span className="anniv-value" data-anniv={it.key}>{it.text}</span>
          </li>
        ))}
      </ul>
      <p className="anniv-hint">
        {nearest
          ? (nearest.days === 0 ? '就是今天 🎉' : `最近的一个：${nearest.label} · 还有 ${nearest.days} 天`)
          : '还没填生日 / 出道日 —— 在展示页的「档案设置」里补上'}
      </p>
    </div>
  )
}