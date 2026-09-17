/**
 * 内置卡片的注册点（R37-P1，devlog/141）。
 *
 * 视图只 `import './cards'`（副作用注册）再读注册表 ⇒ **加卡片不用改视图**。
 * P3 的"自定义卡片"也在这里注册（届时 kind 由用户数据驱动）。
 */
import { registerCardKind } from '../cardRegistry'
import AnniversaryCard from './AnniversaryCard'
import TopPostsCard from './TopPostsCard'

registerCardKind({
  kind: 'anniversary',
  title: '纪念日',
  defaultSize: { w: 5, h: 3 },
  render: (ctx) => <AnniversaryCard {...ctx} />,
})

registerCardKind({
  kind: 'top-posts',
  title: '优质投稿',
  defaultSize: { w: 7, h: 3 },
  render: (ctx) => <TopPostsCard {...ctx} />,
})