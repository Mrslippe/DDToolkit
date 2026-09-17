/**
 * 「纪念日」卡片（R37-P1，devlog/141；R37-P4a 重排为 hero + 事实行）。
 *
 * 数据全在 `vtubers.birthday / debut_date`（本地库，秒出）；口径在 `anniversary.ts`
 * （宽容解析 + 倒计时 + hero 与事实行的取数），这里只负责画。
 *
 * R37-P4a 的三处改动（规格 `docs/design-archive-cards.md` §4.1）：
 *   ① 倒计时从卡片最后一行小字**升格为 hero 大数字** —— 这是这张卡唯一在倒数的信息；
 *   ② 两行退化成**静态事实**（`3/14`、`9/17 · 第 3 周年`），不再各自重复一遍天数
 *      （两个不同的天数并排，读到的人得先判断该看哪个）；
 *   ③ hint 改成**口径说明**（只填月日怎么算）—— "最近的一个"已经由 hero 承担。
 */
import { Cake, Sparkles } from 'lucide-react'

import type { CardContext } from '../cardRegistry'
import { anniversaryFacts, anniversaryHero, anniversaryItems } from '../anniversary'

export default function AnniversaryCard({ vtuber }: CardContext) {
  const items = anniversaryItems(vtuber)
  const hero = anniversaryHero(items)
  const facts = anniversaryFacts(items)

  return (
    <div className="anniv" data-card-body="anniversary">
      {/* hero：**只有真有数字时才渲染**。没填就整块不出现 —— 摆一个空数字位会让人
          以为"有数据但没显示出来"（静默失败的另一种长相）。 */}
      {hero && (
        <div className="anniv-hero" data-anniv-hero>
          <span className="anniv-hero-main">
            <span className="anniv-hero-value">{hero.value}</span>
            {hero.unit && <span className="anniv-hero-unit">{hero.unit}</span>}
          </span>
          <span className="anniv-hero-caption">{hero.caption}</span>
        </div>
      )}
      <ul className="anniv-list">
        {items.map((it, i) => (
          <li key={it.key} className={`anniv-row${it.days === 0 ? ' today' : ''}`}
              title={it.raw ?? '未记录'}>
            <span className="anniv-icon" aria-hidden="true">
              {it.key === 'birthday' ? <Cake size={13} /> : <Sparkles size={13} />}
            </span>
            <span className="anniv-label">{it.label}</span>
            <span className="anniv-value" data-anniv={it.key}>{facts[i]}</span>
          </li>
        ))}
      </ul>
      <p className="anniv-hint">
        {hero
          ? '倒计时按本地日期算；只填月日时按每年循环'
          : '还没填生日 / 出道日 —— 在展示页的「档案设置」里补上'}
      </p>
    </div>
  )
}
