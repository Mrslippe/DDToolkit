/**
 * 内置卡片的注册点（R37-P1，devlog/141；R37-P4a 起带**贴纸角标**契约）。
 *
 * 视图只 `import './cards'`（副作用注册）再读注册表 ⇒ **加卡片不用改视图**。
 * P3 的"自定义卡片"也在这里注册（届时 kind 由用户数据驱动）。
 *
 * R37-P4a（`docs/design-archive-cards.md` §3）：每种卡片必须给出贴纸角标的**图标 + 色调**，
 * 缺一个 `registerCardKind` 当场抛错 —— 所以"加了卡片但没有角标"这种半成品进不来。
 */
import { Cake, Flag, Shuffle } from 'lucide-react'

import { registerCardKind } from '../cardRegistry'
import AnniversaryCard from './AnniversaryCard'
import EventsCard from './EventsCard'
import TopPostsCard from './TopPostsCard'

registerCardKind({
  kind: 'anniversary',
  title: '纪念日',
  defaultSize: { w: 5, h: 3 },
  icon: Cake,
  tone: 'pink',
  render: (ctx) => <AnniversaryCard {...ctx} />,
})

registerCardKind({
  kind: 'top-posts',
  title: '随机投稿',
  defaultSize: { w: 7, h: 3 },
  icon: Shuffle,
  tone: 'coral',
  render: (ctx) => <TopPostsCard {...ctx} />,
})

// R37-P3：`vtuber_events` 表（P7 建好、端点一直在、UI 一直没接）—— 也是扩展点的真示例：
// 加这张卡只写了 events.ts + EventsCard.tsx + 这一行，**视图一行没改**。
registerCardKind({
  kind: 'events',
  title: '大事记',
  defaultSize: { w: 6, h: 3 },
  icon: Flag,
  tone: 'navy',
  render: (ctx) => <EventsCard {...ctx} />,
})