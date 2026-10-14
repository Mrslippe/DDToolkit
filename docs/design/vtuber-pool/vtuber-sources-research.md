---
doc: design/vtuber-sources-research
class: snapshot
scope: VTuber 名单来源与企划归属的实测调研：vdb.vtbs.moe / danmakus / zeroroku / B 站官方四路各能拿到什么字段、鉴权与限流、以及"扩池 + 企划徽章"该用哪个组合
not-scope: 已落地实现的真源（那些在 `docs/backend/*` 与代码里）；榜单/评分类页面数据的抓取
sot: app/services/externals/danmakus.py, app/services/externals/zeroroku.py, scripts/discover_vtubers.py
verified: 2026-10-08
---

# VTuber 名单来源 + 企划归属 调研报告（2026-10-08）

> 全部结论均为实测（HTTP 实测响应 / 官方文档），链接附后。实测时间点：响应含 `Last-Modified: Thu, 08 Oct 2026`。
> 用途：需求 6（企划徽章）与需求 7（候选池扩池），结论已提炼进
> `docs/plans/requests-2026-10-execution.md` 的 B3 / C2 两节。
>
> ⚠️ **按本仓代码的一处更正（2026-10-08）**：下面 §3 说 zeroroku "没有公开 API" 指的是**名册/企划**接口；
> 它**确实有逐作者接口**且我们已经在用 —— `https://zeroroku.com/api/bilibili/author/{mid}/history`
> （粉丝历史）与 `.../live-paid-aggregations`（礼物日聚合，落 `LiveGiftDay`）。
> 所以准确说法是：**zeroroku 不能当名单/企划源，但它是"逐作者运营数据"的来源之一**。

## 1. vtbs.moe / vdb —— 【有企划归属，主源】

- 接口：[`https://vdb.vtbs.moe/json/list.json`](https://vdb.vtbs.moe/json/list.json)（约 2.29 MB）。文档见 [dd-center/vdb README](https://github.com/dd-center/vdb/blob/master/README.md)。
- 结构：`meta`（`UUID_NAMESPACE`、`linkSyntax` 各平台 URL 模板、`timestamp`）+ `vtbs[]`。
- 单条字段：`uuid`、`type`（实测计数 `vtuber` 9896 / `group` 221 / `fan` 13）、`bot`、`accounts[]`（`platform`+`type`(official/relay)+`id`）、`name`（`default`/`cn`/`jp`/`en`/`extra[]`）。
- **企划归属字段：`group`（UUID 字符串）+ `group_name`（企划显示名）**。实测 `group` 出现 1941 次、`group_name` 1776 次；`type:"group"` 条目自身即企划条目。实测命中 `"group_name":"Hololive"` / `"VirtuaReal"` / `"NIJISANJI"` / `"NIJISANJI EN"` / `"A-SOUL"` / `"超电VUP"` / `"虚研社"`。注意：**不是每条都有**，`group_name` 常为空串 `""`。
- 平台账号：`linkSyntax` 覆盖 bilibili / youtube / youtubeAt / twitter / twitch / weibo / pixiv / niconico / acfun 等 30+ 平台，`accounts[]` 给出 id，拼模板即得主页；bilibili 有 `type:"relay"`（转播号）区分。
- 更新：README 明示由 GitHub Actions 自动生成；响应 `Server: GitHub.com`、`Cache-Control: max-age=600`、`ETag`、`Age` —— 即 CDN 缓存 10 分钟。
- 限制：**返回 `Access-Control-Allow-Origin: *`，无需鉴权**。但仓库内**没有找到使用条款，也没有找到任何明确的限流数字**（未找到 ≠ 不存在，建议自限速 + 缓存）。`README` 的字段清单**并未记录 `group`/`group_name`**，字段定义只在 [`syntax/list.json`](https://github.com/dd-center/vdb/blob/master/syntax/list.json) 里有 `"group": "<uuid>"` 示例。示例里的 `2d`/`3d`/`2dArtist`/`3dArtist` 在线上 `list.json` 中**实测 0 次出现**，不要依赖。

## 2. danmakus —— 【有 group_name，但只有 B 站房间维度】

- 站点 <https://danmakus.com/>（Vue SPA，接口前缀实测为同源 `/api/v2/`、`/api/v3/`，另有弹幕取回域 `https://fetch.danmakus.com/`）。
- **VTuber 名单接口实测可用：[`/api/v2/vup-list`](https://danmakus.com/api/v2/vup-list)（约 754 KB，无鉴权）**。响应 `message` 自述 `取自 https://vup-json.laplace.live/vup-slim.json`；上游 [vup.json 首页](https://vup-json.laplace.live/) 自述 `Data source: vtbs.moe and vdb. Update hourly`。
- `vup-list` 结构：外层 `{B站uid: {...}}`，每条**实测只有 4 个字段**：`name`、`type`（`vtuber`/`group`）、`room`（B 站房间号）、`group_name`（企划名，可为 `""`）。**有企划归属**（如 `"group_name":"NIJISANJI"`、`"超电VUP"`、`"ALIVE MUSIX"`），与 vdb 同源同字段名。**但没有 uuid、没有 bilibili/youtube/twitter 账号表**（只有数字 uid + room）。
- 主播/直播间接口实测：`GET /api/v2/channel?uid=<bili uid>`（无鉴权）→ `data.channel`：`uId`、`uName`、`roomId`、`faceUrl`、`isLiving`、`isDeleted`、`title`、`tags[]`、`lastLiveDate`、`lastLiveDanmakuCount`、`totalDanmakuCount`、`totalIncome`、`totalLiveCount`、`totalLiveSecond`、`addDate`、`fansCount`、`followCount`、`lastLiveIncome`；另有 `lives[]`、`fansHistory[]`。**此接口不含所属/企划字段。**
- 其它实测端点：`/api/v2/rank/day`（缺参数时返回 `{"code":400,"message":"无效的年份"}`）、`/api/v2/rank/month|range`、`/api/v2/danmaku/search/async`、`/api/v2/popularChannels`、`/api/v3/meta/emoicons`、`/api/v3/lives/<id>`、`/api/v3/users/<id>`、`/api/v2/account/search-points`（**401**，需鉴权）。
- 鉴权/限流：名单与 channel 类接口**免鉴权**；账号类需登录态（401）。**未找到公开的 API 文档、使用条款或限流说明**；站点在 Cloudflare 后面（有 challenge 脚本 + analytics），实测直连正常。

## 3. zeroroku —— 【无公开**名册/企划**接口，不能当名单源】

- 站点 <https://zeroroku.com/>，标题 `首页 | ZeroRoku · 06数据观测站`（Nuxt 3 SSR，作者链到 [afdian.com/a/jannchie](https://afdian.com/a/jannchie)、[space.bilibili.com/1850091](https://space.bilibili.com/1850091)）。路由实测：`/rank`、`/bilibili`、`/me`、`/settings`、`/login`、`/register`、`/sponsors`、`/changelog`、`/open-letter`。
- 从线上 Nuxt bundle 中枚举出的**全部** `/api/*`：`/api/comments`、`/api/online`、`/api/sponsors`、`/api/user/daily-login`、`/api/auth`、`/api/logs/stream`。**其中没有任何 VTuber 名册 / 企划接口**；页面数据走 Nuxt SSR 内部调用，未暴露为公开 JSON。
- ⚠️ **但它有"逐作者"接口，我们已经在用**（见文件头那处更正）：`/api/bilibili/author/{mid}/history`、`/api/bilibili/author/{mid}/live-paid-aggregations`。
- 字段/企划：`/bilibili` 页是「涨粉榜/掉粉榜」观测榜单视角，**实测未发现任何所属企划字段**。
- 限制：`robots.txt` 只禁 `/login`、`/register`、`/settings`、`/me` 等账号页（[robots.txt](https://zeroroku.com/robots.txt) 允许抓取，并声明 sitemap）。**未找到公开 API 文档、开放接口或使用条款**。⚠️ 不确定：`/api/online` 实测为长连接（请求 120s 超时），性质未确认。

## 4. B 站官方接口 —— 【没有"所属企划/公会"专用字段】

- `api.bilibili.com/x/space/wbi/acc/info`（[文档](https://sessionhu.github.io/bilibili-API-collect/docs/user/info.html)）：字段有 `mid`、`name`、`sex`、`face`、`sign`、`level`、`silence`、`fans_badge`(bool 是否**有**粉丝勋章)、`official{role,title,desc,type}`、`vip`、`pendant`、`nameplate{nid,name,image,level,condition}`、`live_room`。**没有集团/企划/公会字段**。⚠️ 常被误记的 `fans_medal` **不存在于 acc/info**，正确的字段名是 **`nameplate`（勋章）**，且它是 B 站等级勋章（如"见习偶像"），**与企划无关**。`official.role` 只区分个人/机构认证，不细分企划。
- 直播间接口：`room/v1/Room/get_info`（[文档](https://sessionhu.github.io/bilibili-API-collect/docs/live/info.html)）实测字段全集包含 `uid`、`room_id`、`short_id`、`area_id`、`parent_area_name`、`area_name`、`old_area_id`、`tags`、`title`、`verify`、`new_pendants.badge{name(v_person/v_company),desc}`、**`studio_info{status, master_list}`**（实测对 A-SOUL 成员房间 `master_list` 为 `[]`）。**无公会/所属字段**。`room/v1/Room/getRoomBaseInfo` 有 `tags`(逗号分隔)、`area_name`、`parent_area_name`、`uname`；`room/v1/Room/get_status_info_by_uids` 有 `tag_name`、`tags`、`area_v2_name`。
- **`xlive/web-room/v1/index/getInfoByRoom` 实测返回 `{"code":-352}`（风控/需签名或指纹），未能验证其字段**；且它在 bilibili-API-collect 文档中**未收录 / 未找到**。⚠️ 未找到，不臆测字段名。
- 间接反映企划的官方字段（仅间接、需文本解析）：`official_verify.desc` 会明文写出企划，实测 `live_user/v1/Master/info` 对 A-SOUL 成员 672328094 返回 `official_verify.desc = "bilibili个人认证:2025直播年度最强舰队奖UP主、2022百大UP主、虚拟偶像团体A-SOUL所属艺人"`，同接口的 `medal_name`（粉丝勋章名，实测 `"嘉心糖"`）也**间接**指向企划。`Master/info` 另有一个 `link_group_num`（实测 0），旧文档标注 **"作用尚不明确"**，不可当企划字段用。`area_name`/`parent_area_name` 只是分区（如 `虚拟主播`/`虚拟日常`），**不是企划**。

## 对照结论：来源 × 关键字段

| 来源 | 名册(uid→名字) | 企划归属 | 多平台账号 | 直播/统计 | 鉴权 | 限流 |
|---|---|---|---|---|---|---|
| vdb.vtbs.moe list.json | ✅ uuid+多语言名 | ✅ **`group` + `group_name`** | ✅ 30+ 平台 | ❌(无房间/粉丝数) | 免 | 未见声明 |
| danmakus vup-list | ✅ B站uid→名 | ✅ `group_name`(同源) | ❌ 仅 B 站 uid/room | ❌ | 免 | 未见声明 |
| danmakus channel | ✅ 单查 | ❌ | ❌ | ✅ 粉丝/弹幕/营收 | 免 | 未见声明 |
| zeroroku | ❌ 无公开**名册**接口 | ❌ | ❌ | 逐作者：粉丝历史/礼物日聚合（**在用**） | 免 | 未见声明 |
| B 站官方 acc/info | ✅ | ❌（仅 `official` 认证） | ❌ | `live_room` | 需 Cookie/WBI | 严格风控 |
| B 站官方 room/* | ✅ uid/uname | ❌ | ❌ | ✅ 分区/在线 | 免 | 风控(-352) |

## 建议组合

1. **vdb.vtbs.moe `list.json` 作为唯一「名单 + 企划归属」主源**：它是本次调研中**唯一同时**提供跨平台账号表、UUID 稳定主键和显式 `group`/`group_name` 的接口。每日拉 1~2 次即可（CDN 10 分钟缓存）。
2. **用 danmakus `channel?uid=` 做 B 站侧富化**：按 vdb 里 `accounts[].platform=="bilibili"` 的 id 逐个补 `roomId`、粉丝数、弹幕量、营收、`isLiving` —— 这是"扩充名单"之外的运营数据来源。
3. **danmakus `vup-list` 只作交叉校验**，不要当主源：它有 `group_name` 但没有 UUID 和多平台账号，且数据本身就是 vtbs.moe 的派生（上游自述 hourly 同步）。
4. **B 站官方接口用作"确认/兜底"而非发现**：`xlive/web-room/v1/index/getRoomBaseInfo`（批量、免鉴权，拿 `tags`/分区/`uname`）+ `live_user/v1/Master/info`（`official_verify.desc`、`medal_name` 做企划的**间接佐证**，只可人工/规则兜底，不可当权威企划字段）。`acc/info` 与 `getInfoByRoom` 需 WBI 签名/风控放行，不建议作为归档主链路。
5. **zeroroku 不纳入"名单/企划"数据源**：它没有公开名册或企划接口（但逐作者运营数据仍在用）。

## 明确「未找到 / 不确定」

- vdb：未找到使用条款与限流数字；`group`/`group_name` 未写入 README 字段清单（仅在代码与实测数据中存在）；`2d/3d/2dArtist/3dArtist` 线上为 0 次。实测未找到精确 `"group_name":"VSPO"`，**VSPO 具体写法未确认**（可能是 `ぶいすぽっ！` 等别名，未逐一穷举）。
- danmakus：未找到公开 API 文档 / 条款 / 限流说明；`vup-list` 与 `vup-slim.json` 的字段是否随版本变化未确认；`/api/online` 行为未确认。
- zeroroku：未找到公开 API 文档、开放接口、条款；除 bundle 中枚举出的 6 个 `/api/*` 外，不排除存在未在 bundle 中出现的服务端路由（**逐作者那两个接口就是这样：它们在 `/api/bilibili/...` 下**）。
- B 站：`xlive/web-room/v1/index/getInfoByRoom` 未验证成功（`-352`），字段未确认；**未找到任何 B 站官方「企划/公会/社团」结构化字段**，只有文本型间接线索。`link_group_num` / `studio_info` 语义官方未说明，不可依赖。
