/**
 * 直播类型徽章（P7 → v0.9.x 内容管道 M4）。
 *
 * v0.9.x M1 起**推断移到服务端**（标题关键词 + danmakus 分区 + 纪念日锚点，
 * 见 app/services/live_type.py），前端只做 key → label/色彩映射；
 * 本文件的 inferLiveType 保留为兜底（服务端 category 缺失时用标题关键词回退）。
 * 11 类体系：杂谈·游戏·观影·投稿·歌回·**助眠**·电台·联动·特殊·**3D** + 直播兜底。
 * ⚠️ 2026-10-12（T3）：**「健身」换成了「助眠」**（用户口径）；
 * ⚠️ 2026-10-12：**新加 `3d`**（用户口径「3D 形式呈现直播的场次」）——
 * 它答的是"用什么形式演"，与"演什么"正交，优先级见 `RULES` 的注释。
 * 前后端两份表必须同集，判据见 tests/test_vtuber_api.py 的
 * `test_frontend_type_keys_match_backend_taxonomy`（只改一边当场红）。
 */

export type LiveTypeKey =
  | 'game' | 'chat' | 'watch' | 'upload' | 'song'
  | 'sleep' | 'radio' | 'collab' | 'special' | '3d' | 'live'

export interface LiveTypeInfo {
  key: LiveTypeKey
  label: string
  /** posts.css 中 .live-type--{key} 色彩类（预留） */
  className: string
}

/** 排序即优先级：先命中先得（特殊/歌回/观影这类特征词优先于游戏等大类）。
 *  ⚠️ `3d` 的位置与服务端 `TITLE_CATEGORY_PRIORITY` **必须一致**：
 *  **低于特殊**（「3D 生日会」首先是生日）、**高于歌回/杂谈**（「家用3d歌回」按形式归档）。 */
const RULES: { re: RegExp; key: LiveTypeKey; label: string }[] = [
  { re: /生日|周年|纪念|出道|庆典|庆生|新春|圣诞|跨年|新年/i, key: 'special', label: '特殊' },
  // ⚠️ 先排除"不是 3D 直播"的用法（晕3d / 3ds），与服务端 `_THREED_EXCLUDE` 同源
  { re: /^(?!.*(晕3d|3d晕|3ds)).*3d/i, key: '3d', label: '3D' },
  { re: /歌回|唱歌|歌会|翻唱|音乐|演唱会|开嗓|练歌/i, key: 'song', label: '歌回' },
  // ⚠️ 2026-10-12（用户修正边界）：「或者视频、投稿等主要以观看视频为主体的」⇒ 收进来
  { re: /观影|看番|追番|补番|电影|番剧|剧场|影视|一起看一部|看片|看视频|看投稿|投稿回|二创|切片/i, key: 'watch', label: '观影' },
  { re: /联动|合作|嘉宾|连麦|合唱|客串/i, key: 'collab', label: '联动' },
  // ⚠️ 2026-10-12（T3）：原来这一行是健身（`健身|锻炼|减肥|瘦身|瑜伽|运动|帕梅拉|拉伸`）——
  // 已换成助眠，且**只留语义确定的词**（与服务端 SLEEP 词条同源；刻意不收「晚安/早睡/睡」
  // 与「工作音」，理由见 docs/plans/live-type-sleep-terms.md）。
  { re: /助眠|哄睡|白噪音|asmr|音声|伴睡|耳骚|冥想/i, key: 'sleep', label: '助眠' },
  // 电台那条**去掉了 asmr/哄睡/伴睡**（那三个词归助眠，见上一行）——两份表各留一套，
  // 否则同一串标题在前端也会同时命中两类、靠"谁在前"决定胜负（与服务端同一条纪律）。
  { re: /电台|陪聊|谈心|朗读|轻音乐|晚安/i, key: 'radio', label: '电台' },
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
  sleep: '助眠',
  radio: '电台',
  collab: '联动',
  special: '特殊',
  '3d': '3D',
  live: '直播',
}

/** 场内类型统计顺序（统计行数据定义，UI 仅渲染非零项）
 *  ⚠️ **必须与服务端 `live_type.py::TYPE_DISPLAY_ORDER` 同序**（两边各一份：
 *  前端要能独立渲染骨架屏）。顺序漂了 ⇒ 卡片上的柱子次序与筛选条的胶囊次序对不上。
 *  `3d` 排最后：它是"形式"不是"内容"，混在中间会让排序读起来没有线索。 */
export const LIVE_TYPE_ORDER: { key: LiveTypeKey; label: string }[] = [
  { key: 'chat', label: '杂谈' },
  { key: 'game', label: '游戏' },
  { key: 'watch', label: '观影' },
  { key: 'upload', label: '投稿' },
  { key: 'song', label: '歌回' },
  { key: 'sleep', label: '助眠' },
  { key: 'radio', label: '电台' },
  { key: 'collab', label: '联动' },
  { key: 'special', label: '特殊' },
  { key: '3d', label: '3D' },
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
