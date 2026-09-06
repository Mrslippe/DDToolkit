/**
 * 直播类型徽章（P7 → v0.9.x 内容管道 M4）。
 *
 * v0.9.x M1 起**推断移到服务端**（标题关键词 + danmakus 分区 + 纪念日锚点，
 * 见 app/services/live_type.py），前端只做 key → label/色彩映射；
 * 本文件的 inferLiveType 保留为兜底（服务端 category 缺失时用标题关键词回退）。
 * 9 类体系（用户定案维持）：杂谈/游戏/观影/投稿/歌回/健身/电台/联动/特殊 + 直播兜底。
 */

export type LiveTypeKey =
  | 'game' | 'chat' | 'watch' | 'upload' | 'song'
  | 'fitness' | 'radio' | 'collab' | 'special' | 'live'

export interface LiveTypeInfo {
  key: LiveTypeKey
  label: string
  /** posts.css 中 .live-type--{key} 色彩类（预留） */
  className: string
}

/** 排序即优先级：先命中先得（特殊/歌回/观影这类特征词优先于游戏等大类） */
const RULES: { re: RegExp; key: LiveTypeKey; label: string }[] = [
  { re: /生日|周年|纪念|出道|庆典|庆生|新春|圣诞|跨年|新年/i, key: 'special', label: '特殊' },
  { re: /歌回|唱歌|歌会|翻唱|音乐|演唱会|开嗓|练歌/i, key: 'song', label: '歌回' },
  { re: /观影|看番|追番|补番|电影|番剧|剧场|影视|一起看一部|看片/i, key: 'watch', label: '观影' },
  { re: /联动|合作|嘉宾|连麦|合唱|客串/i, key: 'collab', label: '联动' },
  { re: /健身|锻炼|减肥|瘦身|瑜伽|运动|帕梅拉|拉伸/i, key: 'fitness', label: '健身' },
  { re: /电台|asmr|晚安|伴睡|陪聊|谈心|哄睡/i, key: 'radio', label: '电台' },
  { re: /杂谈|闲聊|聊天|随聊|杂谈回|漫谈/i, key: 'chat', label: '杂谈' },
  { re: /游戏|开黑|游玩|打游戏|steam|原神|崩坏|绝区|星穹|瓦罗兰特|lol|英雄联盟|minecraft|我的世界|玩|直播玩/i, key: 'game', label: '游戏' },
  { re: /投稿|剪辑|新作|作品|pv|预告|曝光|公开/i, key: 'upload', label: '投稿' },
]

/** key → 中文标签（服务端 category 直接用；含兜底 live） */
export const LIVE_TYPE_LABELS: Record<LiveTypeKey, string> = {
  chat: '杂谈',
  game: '游戏',
  watch: '观影',
  upload: '投稿',
  song: '歌回',
  fitness: '健身',
  radio: '电台',
  collab: '联动',
  special: '特殊',
  live: '直播',
}

/** 场内类型统计顺序（统计行数据定义，UI 仅渲染非零项） */
export const LIVE_TYPE_ORDER: { key: LiveTypeKey; label: string }[] = [
  { key: 'chat', label: '杂谈' },
  { key: 'game', label: '游戏' },
  { key: 'watch', label: '观影' },
  { key: 'upload', label: '投稿' },
  { key: 'song', label: '歌回' },
  { key: 'fitness', label: '健身' },
  { key: 'radio', label: '电台' },
  { key: 'collab', label: '联动' },
  { key: 'special', label: '特殊' },
]

/** 类型 key（含数据库存量未知值兜底）→ 中文标签 */
export function liveTypeLabel(key: string | null | undefined): string {
  return LIVE_TYPE_LABELS[key as LiveTypeKey] ?? '直播'
}

export function inferLiveType(title: string | null | undefined): LiveTypeInfo {
  const t = (title ?? '').trim()
  if (!t) return { key: 'live', label: '直播', className: 'live-type--live' }
  for (const r of RULES) {
    if (r.re.test(t)) return { key: r.key, label: r.label, className: `live-type--${r.key}` }
  }
  return { key: 'live', label: '直播', className: 'live-type--live' }
}
