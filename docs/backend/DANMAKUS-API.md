---
doc:         backend/danmakus-api
class:       module
scope:       danmakus 第三方 API 全量索引（86 路径 / 90 操作，v2 与 v3 文档已合并）——按「要什么数据」查端点、要什么参数、免不免鉴权、返回什么形状
not-scope:   本仓**已接**的部分与落库映射 → backend/LIVE-AND-DANMAKU.md；抓取节流与调度 → backend/FETCH-PIPELINE.md；第三方源的合规与站点行为 → backend/AUTH-CAPABILITIES.md
sot:         docs/reference/danmakus-api-v2-swagger.json, app/services/externals/danmakus.py
verify:      python -m pytest -q tests/test_danmakus_source.py
budget:      560
retire-when: danmakus 站点下线，或改用官方文档/自建抓取取代本索引
---

# danmakus API 数据索引

> **一句话**：这份文档回答「**我要的那份数据在哪个端点、怎么调、能不能不登录拿到**」。
> 上游 swagger 的两份（`/swagger/v2/` 与 `/swagger/v3/`）**是同一份文档**，合并后就是下面这一套
> —— 合并的实测依据见 §8。原始 spec 存档在 `docs/reference/`（重抓与修复：`scripts/fetch_danmakus_spec.py`）。
> ⚠️ 本文的「实测」一律指 **2026-10-14 的一次真机探测**（脚本未入库），标了日期的数字是**当时的快照**。

- **Base**：`https://ukamnads.icu`
- **必需请求头**（缺了会被 WAF 直接 RST，见 `app/services/externals/danmakus.py::BROWSER_HEADERS`）：
  `User-Agent`（浏览器）/ `Origin: https://ukamnads.icu` / `Referer: https://ukamnads.icu/`
- **全站限流**：响应头 `ratelimit-policy: 120; w=60` ⇒ **120 请求/分钟**
- **鉴权**：`Token: <token>` 请求头或登录态；`securitySchemes` 在 spec 里**是空的**，所以"要不要登录"**只能实测**（§3 就是实测结果）

---

## 1. 按数据找端点（主索引）

| 我要什么数据 | 端点 | 鉴权（实测） |
|---|---|---|
| 主播资料 / 累计指标 / 全量场次 / 粉丝历史点 | `GET /api/v2/channel` | 公开 |
| 按关键词 / 分区搜主播、按指标排行 | `GET\|POST /api/v2/channel/filter` | 公开 |
| 当前开播中的直播间（全站） | `GET /api/v2/living` | 公开（**实测 34.7s**，见 §5） |
| 热门主播 / 活跃用户 | `GET /api/v2/popularChannels` · `/popularUsers` | 公开 |
| 单场场次数据（含词云 / 高能榜 / 录制版本） | `GET /api/v2/live` | 公开 |
| 场次原始弹幕（**带 actor 身份索引**） | `GET /api/v3/lives/{liveId}/danmakus` | 公开 |
| 同上 + **跨改名身份解析** | `GET /api/v3/lives/{liveId}/danmakus-with-identities` | 公开 |
| 场次全量快照（一次拿全，含 extra） | `GET /api/v3/lives/{liveId}/full` | 公开 |
| **直播间粉丝榜/金主榜（30 天内）** | `GET /api/v2/channel/audience-leaderboard` | 公开 |
| **某用户的跨主播足迹 + 昵称史** | `GET /api/v3/users/{userId}/bootstrap` | 公开 |
| 某用户的历史发言（按直播间） | `GET /api/v3/users/{userId}/history` | 公开 |
| 某用户在指定直播间的发言 | `GET /api/v2/user` | 公开 |
| 某用户看过哪些直播间 | `GET /api/v2/user/watchedChannels`（慢，见 §5）· **`/watchedChannelsSimple`** | 公开 |
| uid → 用户名（批量） | `GET /api/v2/user/name` | 公开 |
| 全站弹幕全文检索 | `GET /api/v2/danmaku/search`（+ `/async` 任务版） | 公开（**有额度限制**，§5） |
| 全站收益 / 观看 / 弹幕 / 直播次数排行 | `GET /api/v2/rank/day` · `/month` · `/range` | 公开 |
| 全站观众榜（按天） | `GET /api/v2/rank/audience/day` | 公开 |
| 全站贡献榜 / 分区贡献 / 贡献者公开页 | `GET /api/v2/contribution/*` | 公开（`/me` 除外） |
| 企划 / 公会字典 | `GET /api/v2/guilds` | 公开 |
| 分区字典 | `GET /api/v2/area` | 公开 |
| 站点状态（在线数 / 弹幕速度 / 容量） | `GET /api/v2/site` | 公开 |
| VTuber 索引（名册 + 企划） | `GET /api/v2/vup-list` | 公开 |
| 场次评论 / 主播评论 / 用户评论 | `GET /api/v2/{live,}/comment/get` · `/user/comment/get` | 公开 |
| 表情包清单（弹幕里的表情 id → 图） | `GET /api/v2/emoicons` · `/api/v3/meta/emoicons` | 公开 |
| 全站聊天流（公开弹幕池） | `GET /api/v2/chat/get` | 公开 |
| **某个粉丝的完整画像**（词云 / 节奏 / 跨主播亲和 / 别名时间线） | `POST /api/v3/user-analysis-jobs` 后轮询 | 公开 |
| 我自己的账号数据（逐日弹幕/礼物/时长、录制状态） | `GET /api/v2/account/statistics` 等 | **需 Token** |

---

## 2. 三个关键口径（用错会静默出错数）

### 2.1 `frame.actors[actorId]` 才是身份（弹幕身份的唯一正确读法）

```
DanmakuFrameV3 { actors: [{uid, name}], roomEmojis: [], records: [{ts, type, actorId, payloadKind, payload}] }
```

`record.actorId` **不是 uid，是 `actors[]` 的下标**。实测（2026-10-14，塔菲 10-14 场、`limit=2000`）：
`actors` **812** 条、`actorId` 取值 **0–811**（严格小于数组长度）、带 `actorId` 的记录 **99.9%**、
`actors[232] = {uid: 525541156, name: "某科学的变态空间移动"}`。

⇒ **`actors[record.actorId].uid` 就是真实 B 站 uid**，且**不需要额外请求**。
⚠️ 本仓当前读弹幕的路径（`app/services/danmaku_words.py::iter_texts_from_records`）**只取 `payload`、丢掉了 `actors`**。

### 2.2 `danmakus-with-identities` 额外给"跨改名身份"

`actors[]` 变成 `{archivedUserId, archivedUserName, candidates: [{uid, userNames: [...]}]}` ——
`userNames` 是这个人**用过的所有昵称**。实测（同场 3000 条 / 571 actors / **571 个都有 candidates**）：

```json
{"archivedUserId": 442935758, "archivedUserName": "Aceleaf",
 "candidates": [{"uid": 442935758, "userNames": ["Aceleaf","LeafSmashOvO","一一聚集君一一","叶子叶子心态好好"]}]}
```

### 2.3 三个都叫"弹幕数"的数字

| 字段 | 实测（某场） | 是什么 |
|---|---|---|
| 分页信封的 `total` | 39,317 | **所有上传源的原始条数**（重复录制重复计数）→ 本仓叫 `raw_record_count` |
| `live.danmakusCount` | 17,931 | 合并去重后的场次弹幕数 |
| `versions[i].live.danmakusCount` | 17,931 / 17,922 / 17,927 / 12,084 | **每个录制版本各自的数** |

本仓口径（`canonical_danmaku_count`）= **取各版本最大**，理由与踩坑见 `docs/backend/LIVE-AND-DANMAKU.md`。

---

## 3. 鉴权实测矩阵（2026-10-14，无凭据逐端点请求）

**全量 90 个操作 → 44 个公开 200 / 22 个 401 / 其余是参数不全的 400 或任务 id 不存在的 404。**

**需 Token 的 22 个（穷举，别再去试）**：

| 组 | 端点 |
|---|---|
| 个人账号（`/api/v2/account/*` 除 `info` 外全部） | `add-record` · `del-record` · `channel-lives` · `contributed-lives` · `core-config`(GET+POST) · `recording` · `search-points` · `search-points/history` · `statistics` · `statistics/report` · `update-name` · `update-public-profile` |
| 我的贡献 | `GET /api/v2/contribution/me` |
| 客户端运行时 | `GET /api/v2/core-runtime/clients` · `/heartbeat` · `POST /api/v2/core-runtime/upload-danmakus`（及 `-v2`…`-v5`） · `/upload-extracted` |

⇒ **只有"我自己的账号侧数据"需要 `DANMAKUS_TOKEN`**（个人逐日统计 / 录制状态 / 我的搜索点数 / 上传弹幕）。
**所有"看别人"的数据都不需要登录** —— 包括观众榜、用户足迹、用户画像任务这几个"看着像要登录"的。

⚠️ 两点口径：

1. **`GET /api/v2/account/info` 是公开的**（实测 200，无参时回 `用户不存在`）—— 它不在上面那张表里。
2. **200 不等于业务成功**：上游有一批**业务错误也用 HTTP 200 + `code:400` + `message`** 回
   （例：`/api/v2/add` → `验证失败, 可能是操作过于频繁`；`/api/v2/account/info` → `用户不存在`）。
   **判成败要读 body 的 `code`**，不能只看 HTTP 状态。

---

## 4. 对"分析页"最有价值的三组端点（含字段）

### 4.1 观众榜 `GET /api/v2/channel/audience-leaderboard`

参数：`uId`(int64) · `board`（默认 `message`，另有 `paid`）· `range`（默认 `last7`）· `page` · `pageSize`（默认 50）。

实测（塔菲 `1265680561`）：

| range | 结果 |
|---|---|
| `last7` | coverage 10-09~10-14 · 6 场 · `total=1000` |
| `last30` | coverage 09-16~10-14 · 26 场 |
| `month` | coverage 10-02~10-14 · 14 场 |
| `last90` / `last180` / `last365` / `all` / `2024` / `year` | **全部 400** |

行字段（`AudienceLeaderboardItem`）：`rank · userId · userName · messageCount · liveCount ·
paidLiveCount · activeDays · giftPaidMilli · scPaidMilli · guardPaidMilli · paidMilli`。
响应还带 `coverageStartDate/EndDate`（**数据实际覆盖范围**）与 `pendingLiveCount`（还没结算的场次）
—— 画图时**必须显示 coverage**，否则"最近没数据"会被读成"没人来"。

### 4.2 用户足迹 `GET /api/v3/users/{userId}/bootstrap`（或 `/history`）

实测：`uid=442935758` → `history.total = 3009`、`watchedChannels` 给了
永雏塔菲 392 / 飞天狙 228 / asaran浅岚 190 …；另一个用户（`153154276`）**看过 284 个直播间**。

字段：`watchedChannels[] {uName, uId, faceUrl, count}` · `historyUserNames[]`（昵称史）·
`blocks[]`（被封记录）· `todayQueryCount`（**今日已用查询次数**——额度信号）·
`history.items[] {channel, live, danmakus}`。

⇒ **跨主播粉丝重合可以双向做**：从 A 的榜单取 uid → 查他看过谁；或取 A/B 两份榜单求交。
**建议后者**：请求数 = 主播数而不是粉丝数（限流 120/分钟）。

### 4.3 用户画像 `POST /api/v3/user-analysis-jobs`

流程：POST `{userId, startTime, endTime, forceRefresh}` → `{jobId}` → 轮询 `GET /{jobId}`
（`status: 0–4`、`latestEvent.progress/loadedLives/totalLives`）→ `GET /{jobId}/result`。

⚠️ **`startTime` 不能是 0**（实测报 `无效的日期范围`）；用「近 30 天」正常。
⚠️ **结果是 msgpack**，见 §6。

实测结果（`uid=442935758`，近 30 天，约 10s 完成，**约 1MB**）：

| 字段 | 实测值 / 含义 |
|---|---|
| `nameHistory` | `["Aceleaf","LeafSmashOvO","叶子叶子心态好好","一一聚集君一一"]` |
| `summary` | `totalMessages 6307 · totalPayment 0 · blockCount 0 · activeDays 29` |
| `insights` | `repeaterIndex 3.14`（复读指数）· `maxRepeatedText "草"` × **581** · `emojiRatio 0.16` · `nightOwlRatio 0.2236` · `avgMessageLength 12.5` · `uniqueMessageRatio 0.3185` |
| `channels` | **49** 个（`{channel, lives[]}`，逐场带完整 `APILiveInfo`） |
| `channelAffinities` | **49** 条，带 `loyaltyScore`（塔菲 68.5 / 黑之951 32.0）、`firstActiveAt`/`lastActiveAt` |
| `aliasTimeline` | 每个昵称的 `firstSeen` / `lastSeen` |
| `rhythmMatrix` | **7×24** 节奏矩阵（实测 row0 = 周一 24 个小时格） |
| `wordCloud` | `{词: 次数}`，实测 `生日快乐 430 / 我服 206 / 白白 141 …` |

⇒ **凡是"单个粉丝的画像"这一类聚合，上游已经算好了**，不必自建。

---

## 5. 限制与坑（实测）

| 限制 | 实测表现 | 影响 |
|---|---|---|
| 全站限流 | `ratelimit-policy: 120; w=60` | 批量抓取必须节流（本仓 `CHANNEL_ACCOUNT_GAP_SECONDS` 那套） |
| 弹幕检索有额度 | `/api/v2/danmaku/search` 带 `channelUid` 且跨度 >7 天 → `指定直播间超过 7 天需要积分优先模式`；响应含 `pointsSpent`/`pointsBalance` | **替代不了本地明细库** |
| 观众榜窗口 | `range` 超 30 天一律 400 | 长期粉丝趋势只能**自己按天落榜快照**攒 |
| 单场弹幕分页上限 | 分页信封 `limit` 最大 100000；实测某场 `total=28638` | 超大场次要翻页，否则份额类统计失真 |
| 上游覆盖有洞 | 见 `docs/TODO.md`（某三天跨 6 账号 16 场现查 0/16） | 界面必须能说"上游没收录"，不能显示成 0 |
| `living` 很慢 | 实测 **34.7s** | 别放进交互路径 |
| 有几条端点会超时 | 同一轮探测里 `channel` / `channels` / `watchedChannels` / `danmakus-with-identities` 在 **5s 超时**下全部 `ReadTimeout`，而其中前三条用长超时**单独调是成功的**；`watchedChannelsSimple` 当场 200 | 别用短超时判"端点坏了"；**慢端点要有自己的超时与重试**（同 `_LIVE_TIMEOUT` 那条教训） |
| `channel` 也会慢 | 上游会间歇变慢（本仓 `_LIVE_TIMEOUT` 常量注释有实测） | 超时别调小（会误判成"没数据"） |

---

## 6. 传输格式：v3 有一批是 **msgpack**，不是 JSON

**实测确认返回 `application/x-msgpack` 的三条**（均在同一个探测里，体首字节 `0x8b` = msgpack 11 键 map）：

| 端点 | 备注 |
|---|---|
| `GET /api/v3/lives/{liveId}/full` | 实测 **15.4s** |
| `GET /api/v3/meta/index-background` | |
| `GET /api/v3/user-analysis-jobs/{jobId}/result` | 实测约 **1MB**（gzip 后） |

httpx **不会**自动解 msgpack，`r.json()` 直接抛 `UnicodeDecodeError`。
spec 里 schema 名带 **`Mp`** 后缀的（`LiveDeltaEnvelopeV3Mp` / `LiveFullEnvelopeV3Mp` /
`IndexBackgroundDanmakuEnvelopeV3Mp`）都是这一类 —— 接之前先看 `Content-Type`，
**别按 JSON 写解析器**；本仓当前也没装 msgpack 库（`.venv` 里 `msgpack`/`msgspec`/`orjson` 都没有）。

---

## 7. 完整端点清单（自动抽取，按路径）

字段：`方法 路径 → 出参 schema`。`{liveId}` = 场次 uuid、`{userId}` = 用户 uid、`{jobId}`/`{taskId}` = 任务 id。

<!-- 这一节的真源是两份 swagger.json，改动上游后重跑抽取脚本刷新 -->

**Account（个人账号，几乎全部需 Token）**
`GET /api/v2/account/add-record` → `ResponseRecordingInfo` ·
`GET /api/v2/account/channel-lives` → `APILiveInfo[]` ·
`GET /api/v2/account/contributed-lives` → `ResponseContributedLiveInfoListPaginationRespone` ·
`GET|POST /api/v2/account/core-config` → `CoreControlConfig` ·
`GET /api/v2/account/del-record` · `GET /api/v2/account/info` → `ResponseUserInfo` ·
`GET /api/v2/account/recording` → `ResponseRecordingInfo[]` ·
`GET /api/v2/account/search-points` · `GET /api/v2/account/search-points/history` →
`SearchPointLedgerPage` · `GET /api/v2/account/statistics` → `UserDailyStatisticList` ·
`POST /api/v2/account/statistics/report` · `POST /api/v2/account/update-name` ·
`POST /api/v2/account/update-public-profile` · `POST /api/v2/account/update-recording-setting`

**Channel / 主播**
`GET /api/v2/channel` → `{channel, lives[], extra{fansHistory[], guardHistory[]}, fansHistory[]}` ·
`GET /api/v2/channels`（可 `simple=true` 只回名字/uid/头像） ·
`GET|POST /api/v2/channel/filter` → `APIChannelInfo[]`（`keyword` / `area` / `type` / `range`(分钟) / 分页最大 500） ·
`GET /api/v2/simpleChannel` → `ChannelResponeData` · `GET /api/v2/living` → `APIChannelInfo[]` ·
`GET /api/v2/popularChannels` · `GET /api/v2/popularUsers` → `SimpleChannelInfo[]` ·
`GET /api/v2/guilds` → `{string: int64[]}` · `GET /api/v2/area` → `{string: string[]}` ·
`GET /api/v2/site` → `SiteInfo` · `GET /api/v2/vup-list` → `{int64: VTBInfo}` ·
`GET /api/v2/add`（收录主播，**要人机验证 token**）

**Live / 场次**
`GET /api/v2/live` → 分页信封（`total`=原始条数）+ `data.live` + `data.channel`；
可选 `uId`（只返回该用户的弹幕）、`type`（0 普通/1 礼物/2 上舰/3 SC/4 进入/5 标题/6 分区/7 中止/8 继续/9 封禁）、
`includeExtra`（词云 + 高能榜）、`useEmoji` ·
`GET /api/v2/live/comment/get` · `POST /api/v2/live/comment/add`

**Danmaku / 弹幕**
`GET /api/v3/lives/{liveId}` → `LiveResponseV3` ·
`GET /api/v3/lives/{liveId}/danmakus` → `DanmakuFrameV3{actors[], roomEmojis[], records[]}` ·
**`GET /api/v3/lives/{liveId}/danmakus/after`** → 游标增量（公开；`delta` 那条对已结束场次 404） ·
`GET /api/v3/lives/{liveId}/danmakus-with-identities` → 见 §2.2 ·
`GET /api/v3/lives/{liveId}/full` / `delta?afterSeq=` → **msgpack**（§6） ·
`GET /api/v2/danmaku/search` → `DanmakuContentSearchPage{hits[], nextCursor, pointsSpent, priority, extendedScope}` ·
`POST /api/v2/danmaku/search/async` + `GET .../async/{taskId}` + `GET .../queue-stats` ·
`GET /api/v3/meta/index-background`（首页背景弹幕）
`DanmakuType` 枚举 0–12 · `DanmakuPayloadKindV3` 枚举 0–10

**身份 / 观众 / 用户**
`GET /api/v2/channel/audience-leaderboard`（§4.1） · `GET /api/v2/rank/audience/day` →
`SiteDailyAudienceRank`（比频道榜多一列 `channelCount`，可用于找"跨多个直播间的人"） ·
`GET /api/v3/users/{userId}/bootstrap` · `/history`（§4.2） ·
`GET /api/v2/user`（逐条发言，`target`=直播间 uid） · `GET /api/v2/user/watchedChannels` ·
`GET /api/v2/user/name`（批量 uid→名） · `GET /api/v2/user/comment/get` ·
`POST /api/v2/user/comment/add` ·
`POST /api/v3/user-analysis-jobs` + `GET|DELETE /{jobId}` + `/{jobId}/result|events`（§4.3）

**排行与贡献**
`GET /api/v2/rank/day` · `/month`（`year`/`month`/`day`/`type`/`area`/`count`）·
`/range`（`range` 0 一天 / 1 一周 / 2 一月）→ `RankInfo{channel, liveIds[], watchCount, likeCount,
danmakusCount, income, liveCount}`；`RankType` 0 收益 / 1 观看 / 2 点赞 / 3 弹幕 / 4 直播次数 ·
`GET /api/v2/contribution/hub|overview|areas|contributor|minute-today|rank/day|rank/range` ·
`GET /api/v2/contribution/me`（**需登录**）；
`ContributionMetric` 0 弹幕 / 1 礼物 / 2 SC / 3 大航海 / 4 综合；`ContributionRange` 0 今日 / 1 近 7 天 / 2 近 30 天

**评论 / 表情 / 聊天**
`GET /api/v2/comment/get`（按主播） · `POST /api/v2/comment/add` ·
`GET /api/v2/emoicons` · `GET /api/v3/meta/emoicons` ·
`GET /api/v2/chat/get`（公开聊天流，`date` + `count`） · `POST /api/v2/chat/add` ·
`GET /api/v2/chat/tag`（弹幕服务器 token + `onlineCount`）

**核心运行时（客户端/上传侧，本仓未用）**
`GET /api/v2/core-runtime/extraction-rules` · `/clients`(401) · `/heartbeat`(401) · `/ws` ·
`POST /api/v2/core-runtime/request-room|sync|heartbeat` ·
`POST /api/v2/core-runtime/upload-danmakus[-v2..-v5]|upload-extracted`（**均需 Token**） ·
`DELETE /api/v2/core-runtime/state`

**流状态**
`POST /api/v2/streamer-status`（body 要 **`RoomIds`**，不是 uIds —— 实测报 `The RoomIds field is required`）

---

## 8. 合并结论：上游只有**一份**文档

2026-10-14 实测：

| 文档 | 字节 | sha256(前16) | 路径 | schemas | `info.version` |
|---|---|---|---|---|---|
| `/swagger/v2/swagger.json` | 261,239 | `791adfb4c76d8d6a` | 86 | 209 | `v2` |
| `/swagger/v3/swagger.json` | 261,239 | `b43dadc3ac1009d6` | 86 | 209 | `v3` |
| `/swagger/combined/swagger.json` | **12** | `52c33688e376ddc4` | — | — | 体是 `{}`，**不可用** |

两份**路径集合相等、schema 集合相等**，差异只在 `info.version` 那一行字符串。
⇒ **不需要"合并"**：v3 的路径本来就写在 v2 文档里（`/api/v3/...` 与 `/api/v2/...` 混排）。
"引哪一份"按路径前缀选即可，内容没有分别。

⚠️ **上游那两份都是坏 JSON**：各有 **11 处** `"kindValue": ,`（值为 null 的枚举被序列化成空），
`json.loads` 直接抛 `Expecting value`。要当契约用必须先修：
`re.sub(r'(:\s*),', r'\1null,', text)` —— 抓取 / 修复 / 存档一条命令：
`python scripts/fetch_danmakus_spec.py`（`--check` 与存档比对，上游变了退出 1）。
**`docs/reference/` 里那两份存档是修好的**（修复过程写在 `danmakus-api-fetch.log`）。
