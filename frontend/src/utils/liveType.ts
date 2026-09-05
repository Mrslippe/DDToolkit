/**
 * 直播类型徽章推断（P7，v0.7.0）。
 *
 * 数据源没有结构化直播类型（快照只存 live_title / live_status），
 * 用户定案：按标题关键词推断类型徽章。语义纯展示，不落库。
 */

export type LiveTypeKey = 'game' | 'chat' | 'song' | 'radio' | 'anniv' | 'live'

export interface LiveTypeInfo {
  key: LiveTypeKey
  label: string
  /** post.css 中 .live-type--{key} 色彩类 */
  className: string
}

/** 排序即优先级：先命中先得 */
const RULES: { re: RegExp; key: LiveTypeKey; label: string }[] = [
  { re: /生日|周年|纪念|出道|庆典|庆生/i, key: 'anniv', label: '庆典' },
  { re: /歌回|唱歌|歌会|翻唱|音乐|演唱会/i, key: 'song', label: '歌回' },
  { re: /电台|asmr|晚安|谈心|伴睡/i, key: 'radio', label: '电台' },
  { re: /杂谈|闲聊|聊天|随聊|杂谈回/i, key: 'chat', label: '杂谈' },
  { re: /游戏|开黑|游玩|打游戏|steam|原神|崩坏|绝区|星穹|瓦罗兰特|lol|英雄联盟|minecraft|我的世界|联动|直播玩/i, key: 'game', label: '游戏' },
]

export function inferLiveType(title: string | null | undefined): LiveTypeInfo {
  const t = (title ?? '').trim()
  if (!t) return { key: 'live', label: '直播', className: 'live-type--live' }
  for (const r of RULES) {
    if (r.re.test(t)) return { key: r.key, label: r.label, className: `live-type--${r.key}` }
  }
  return { key: 'live', label: '直播', className: 'live-type--live' }
}
