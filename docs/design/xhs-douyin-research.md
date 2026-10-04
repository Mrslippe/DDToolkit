---
doc: design/xhs-douyin-research
class: snapshot
scope: 小红书 / 抖音抓取的可行性调研：接口清单、签名与反爬机制、开源项目盘点、采集引擎选型、存疑清单与复核方法；**§6 是合规定性** —— 两家协议明文禁止爬虫，本文只是可行性调研、不是许可
not-scope: 已接入平台的实现（真源是 backend/PLATFORMS 与代码）
sot: app/services/platforms/xiaohongshu.py, app/services/platforms/signing.py
verified: 2026-09-27
---

# 小红书 / 抖音抓取逻辑调研（接入前置）

> **调研日期：2026-09-27**。本文是**带日期的快照**，不是长期规格 —— 这两家的签名算法与接口路径换代极快
> （抖音 `X-Bogus` → `a_bogus` → `a_bogus + secsdk 三件套`；小红书 `mns0101` → `mns0301`、搜索 `/v1/` → `/v2/`），
> **任何三个月前的字段清单都应视为待验证**。复核方法见 §8，存疑项见 §7。
>
> 用途：给「第 4 阶段 · 接一个平台」定**采集引擎选型**与 `BasePlatform` 的设计输入。
> 决策背景（为什么现在才做、为什么选型一直押后）见 `docs/ARCHITECTURE-IMPROVEMENT-EXECUTION.md` §1.4。
>
> **证据分级**（全篇通用，每条结论都带其中之一）：
> `[源码]` = 我直接读到可执行源码/官方文件原文；`[共识]` = 多个独立来源一致；
> `[存疑]` = 单一来源或来源自相矛盾；`[待验证]` = 未找到一手证据。

---

> ## ⛔️ 先读这条：本文是**可行性**调研，不是**许可**
>
> **小红书与抖音的用户协议都明文禁止爬虫与自动化采集**（含"反向工程签名"与"统计内容数据"两项，
> 逐条原文见 **§6.1**）。⇒ **不存在"允许的抓取额度"**：这**不是**"抓多少以内算合规"的问题，
> 而是**定性上不被允许**。
>
> 因此：**§2–§5 的全部技术内容（接口、签名、开源实现、选型建议）只回答"技术上能不能做到"，
> 不回答"该不该做 / 做了是否合规"。** 任何"用量小、只存统计、够低调"的说法都**不改变定性**
> —— 初版本文档在这里写错了一次，修订记录见 §6 开头。
>
> **继续与否是产品级决策，不是技术选型**（三条立场见 §6.4）。

---

## 1. 结论摘要

### 1.1 选型：技术上的答案是 **C 混合** —— 浏览器只**铸身份**，签名在本地做

> ⚠️ **"推荐"一词只在技术层成立**：本节回答"如果要做，怎么做代价最低"，
> **不代表建议做**。合规定性见文首方框与 §6。
>
> ⚠️ **这一节的结论在调研过程中被推翻过一次，留在这里是因为记下"为什么曾判错"比记结论更有用。**
> 初判是「抖音必须**逐请求**用真实浏览器产签名」。**这个判断是错的** —— 它来自只读了
> MediaCrawler（其抖音侧确实要浏览器上下文取 `msToken`/localStorage）。
> 直到读到 [DTK v5](https://github.com/Evil0ctal/Douyin_TikTok_Download_API)（Apache-2.0）的
> `signing/native/` 才发现：**`a_bogus` 与 `x-secsdk-web-signature` 都已被纯 Python 完整复刻**，
> 且**浏览器退化成"只铸会话身份"**（§3.4）。**代价差一个数量级** —— 所以下面按修正后的结论写。

| 方案 | 判定 | 依据 |
|---|---|---|
| **A 纯 HTTP（含自己逆向签名）** | ⚠️ **可行但不该自己做** | 抖音签名**已被开源纯 Python 复刻**（§3.4），但那是**三份逆向工作量**（`bdms.js` 字节码 VM + secsdk 字符串表 + 指纹同源），且**改版即全废**。小红书侧同理（`xhshow` 可依赖）。**自己没有理由重做一遍** |
| **B 真实浏览器驱动** | ❌ 不必作为主力 | 逐请求过浏览器 = 秒级延迟 + 重依赖。**只在"会话身份过期/被风控"时兜底** |
| **C 混合** ✅ | **推荐** | **浏览器只负责铸身份**（游客 cookie：`uifid` / `s_v_web_id` / `msToken`），**业务请求与签名全在本地**（微秒级）。DTK v5 已验证：**抖音 4/4 端点在纯本地签名下返回完整数据，请求路径上无浏览器** `[源码]` |

**抖音的关键分化（DTK v5 的端点级实测）** `[源码]`：抖音**只对 14 条白名单路径**要求平台级签名，
其余路径**平台自己也不签**：

| 端点 | 是否受保护 | 纯本地签名实测（2026-09-08，单身份 8 次） |
|---|---|---|
| `/aweme/v1/web/user/profile/other/` | 不受保护 | **8/8 成功** |
| `/aweme/v1/web/comment/list/` | 不受保护 | **8/8 成功** |
| `/aweme/v1/web/aweme/detail/` | **受保护** | 3/8，其余 403 `Uifid Not Found` |
| `/aweme/v1/web/aweme/post/` | **受保护** | 3/8，其余 403 |

⇒ 受保护 ≠ 必须浏览器：`x-secsdk-web-signature` 本身也只是
`md5(f"{uifid}_{timestamp}_{SALT}_{query}")`，**是纯函数、无会话状态** `[源码]`。
**唯一真正需要外部的输入是 `uifid` 这个会话值** —— 而这可以**一次性铸好、长期复用**。

**小红书的处境不同（本次调研最重要的不对称）**：小红书 `x-s` 也已有**纯 Python 算法库**
[`xhshow`](https://github.com/Cloxl/xhshow)（MIT，PyPI 0.2.0 = 2026-06-11，仍在更新）`[源码]`，
**MediaCrawler 已从"Playwright 注入 JS"改成直接调它**。但它真正的瓶颈**不在签名**：

- `mnsv2` 签名里**打包了行为计数器**（点击/mouseenter/停留时长），纯协议爬虫计数器恒定即被识别（§2.3）；
- 详情与评论接口**必须**带 `xsec_token`，**不能自行构造、会过期**，只能从列表/搜索响应里拿（§2.4）。

⇒ **两家可以共用一套"身份提供者 + 本地签名器"抽象，但不该共用同一个签名策略**：
小红书是"能签但可能要装得像人"，抖音是"能签但要按端点分层 + 身份要同源"。

### 1.1.1 落地形状（建议）

```
身份层（浏览器，低频、可缓存、可提前铸）
   └─ 铸游客/登录 cookie 包：uifid / s_v_web_id / msToken（抖音）、a1 / web_session（小红书）
      ⚠️ 抖音同源要求：uifid 与 s_v_web_id 必须来自同一浏览器会话，自造 → 403 Signature Not Found
签名层（本地，每次请求）
   ├─ 抖音：a_bogus（bdms 算法）+ x-secsdk-web-signature（一个 md5）+ x-tt-argus 头
   └─ 小红书：xhshow 库（MIT，直接依赖）
请求层（httpx，复用现有 app/core/http.py 的客户端与 TLS 上下文）
风控层（现有 rate_limit.py，但冷却粒度要从"平台"细到"身份/会话"）
```

**⚠️ 这条路线有一个必须承认的维护负担**：`a_bogus` 是 `bdms.js` 字节码 VM 的复刻，
**抖音改版即失效**。DTK v5 为此内置了「**影子比对**」——按低频率把同一请求**本地签一次、
浏览器签一次**，用 `structure_error()` 做**结构化比对**（比对噪声碰不到的常量：s4 字母表、
header magic、SDK 版本块、两个长度字段、XOR 校验和），**不一致就自动降级到浏览器 + 报警** `[源码]`。
**这个设计值得抄**：它把"签名悄悄失效、数据静默变空"变成了"可见且自愈"。

### 1.1.2 与首版判断的差异（为什么值得记一笔）

| 首版判断 | 修正后 | 差在哪 |
|---|---|---|
| 抖音必须逐请求浏览器产签名 | **不必** —— 本地纯 Python 签名 + 浏览器只铸身份 | 代价差一个数量级（秒级 vs 微秒级） |
| "纯 Python 不可行" | **已可行**，且是 Apache-2.0 可参考实现 | 首版只看到 `mafqla` 的**查表法**（非真逆向）就下了结论 |
| 小红书与抖音"最优路线已分叉" | 仍成立，但分叉点在**风控模型**与**身份约束**，不在"能不能纯算" | 两家都能纯算 |
| 抖音 `X-Bogus` 已被 `a_bogus` 取代 | **两者并存**（同页共存，`webmssdk` 仍产 X-Bogus） | 首版把"旧路径注释"当成了全局结论 |

**教训（两条，都已落到本文档的写法里）**：
1. **只看一个生态代表（哪怕它是 star 最多的那个）会得出错误结论** ——
   同类项目可能停在**不同代际**：MediaCrawler 抖音侧还依赖浏览器上下文，DTK v5 已经不需要了。
2. **不要采信 README** —— 本次实测到 README 与代码不一致、License 徽章与元数据冲突、
   常量已过期未声明三种形态（§4.3）。**判据是源码常量与仓库元数据。**

### 1.2 现有 `BasePlatform` 的三个前提被实证推翻

`docs/ARCHITECTURE-IMPROVEMENT-EXECUTION.md` §1.4 的预判**全部被证实**：

| 前提 | 判定 | 实证 |
|---|---|---|
| HTTP-only | ❌ | 抖音要 JSVMP 签名 + secsdk 会话密钥；小红书行为计数器需状态化会话 |
| 有稳定字符串 uid | ❌ | 抖音用户手上只有**可变**的抖音号（`unique_id`）；入参要 `sec_user_id`，**无本地换算算法**，需经接口/搜索解析（搜索还要登录） |
| cookie 鉴权 | ⚠️ 不充分 | 抖音 cookie **之外**还必须有签名参数与同源指纹；小红书 `web_session` 之外还需 `a1`（签名强制输入） |

⇒ 印证了「**先落平台、后提炼**」的顺序：现在凭空设计 `BasePlatform` 的能力成员**一定会设计错**。

### 1.3 可以现在就定的五条（不需等平台落地）

1. **`aweme_id` 必须按字符串存/传**：19 位数字超出 JS `Number.MAX_SAFE_INTEGER`（2^53≈9.0e15），
   经 JSON 到前端会**静默丢精度**。`Post.platform_post_id` 本来就是 `String`（`app/models/vtuber.py`），
   要守住的是**前端与 JSON 序列化路径不要中途转 Number** `[源码]`。
2. **节流必须做成"会话/身份级"而非"平台级"**：抖音风控绑定**会话/账号指纹**（`uifid` 与
   `s_v_web_id` 同源绑定），不是 IP 级 —— 与 B 站 412「换 IP 即自愈」是两种模型。
   ⚠️ 但**签名本身可以本地做**（§1.1）：**要按身份限速，不必按身份跑浏览器**。
3. **"会话被风控"要成为一等状态**，且能区分「cookie 失效 / 签名失效 / 网关头缺失」三种 403，
   否则线上无法排查（§3.6 的 403 根因表）。
4. **`BasePlatform` 需要一个"不支持则结构化返回"的统一出口**：现有 unsupported 路径是静默丢弃
   （`scheduler._fetch_one_account` 见 `pf is None` 只 `logger.warning` 后 `return False`；
   T0 的 `isdigit()` 过滤连 `result.failed` 都不计）—— 新平台一上来就会踩这条 `[源码]`。
5. **接平台时要同步 `EXTERNAL_HOSTS`**（Rust 侧，`frontend/src-tauri/src/lib.rs`）：否则「打开主页」会失败。
   这条在 `docs/desktop/SHELL.md 不变量 29已记为纪律，本次调研确认域名清单见 §5.4。

---

## 2. 小红书（Xiaohongshu / RED）

### 2.1 域与分工

| 主机 | 用途 |
|---|---|
| `www.xiaohongshu.com` | 页面 HTML（含 `window.__INITIAL_STATE__`） |
| `edith.xiaohongshu.com` | **主力业务 API 网关**（feed / 用户 / 评论 / 搜索 v1） |
| `so.xiaohongshu.com` | **搜索专用域**（v2，2026-07 浏览器实抓）`[存疑]` |
| `webapi.rednote.com` | 海外版 RedNote 网关（cookie 域 `.rednote.com`） |
| `ci.xiaohongshu.com` / `sns-webpic-qc.xhscdn.com` | 图片 CDN |

### 2.2 接口清单

以下路径相对 `https://edith.xiaohongshu.com`（除注明外）。

| 用途 | 方法 | 路径 | 关键参数 | 响应路径 |
|---|---|---|---|---|
| 他人主页信息 | GET | `/api/sns/web/v1/user/otherinfo` | `target_user_id`（**不是** `user_id`） | `data` |
| 自己主页 / 登录态探测 | GET | `/api/sns/web/v1/user/selfinfo` | — | `data.result.success` |
| **用户笔记列表** | GET | `/api/sns/web/v1/user_posted` | `num=30`、`cursor=""`、`user_id`、`image_formats=jpg,webp,avif`、`xsec_token`、`xsec_source` | `data.notes[]`、`data.cursor`、`data.has_more` |
| **笔记详情** | POST | `/api/sns/web/v1/feed` | body：`source_note_id`、`image_formats[]`、`extra.need_body_topic`、`xsec_source`、`xsec_token` | `data.items[0].note_card` |
| 搜索 v1（旧） | POST | `/api/sns/web/v1/search/notes` | `keyword`、`page`、`page_size`、`search_id`、`sort`、`note_type` | `data.items[]`、`data.has_more` |
| 搜索 v2（新） | POST | `so.xiaohongshu.com/api/sns/web/v2/search/notes` | 同上 + `session_id`(UUIDv4)、`ext_flags`、`geo` | 同上 |
| 一级评论 | GET | `/api/sns/web/v2/comment/page` | `note_id`、`cursor`、`xsec_token`（**必填**） | `data.comments[]` |
| 二级评论 | GET | `/api/sns/web/v2/comment/sub/page` | `note_id`、`root_comment_id`、`num`、`cursor` | 同上 |
| 笔记详情（HTML 兜底） | GET | `www.xiaohongshu.com/explore/{id}?xsec_token=&xsec_source=` | — | `window.__INITIAL_STATE__` → `note.noteDetailMap[id].note` |

`[源码]`（MediaCrawler `xhs/client.py`、`ReaJason/xhs` `core.py`、`Spider_XHS` `params.py`）

**分页终止**（`user_posted` 的官方写法，两条都要）：
```python
if 'cursor' in data: cursor = str(data['cursor'])   # 服务端返回数值型，不转字符串会签名不一致
else: break
if not notes or not data['has_more']: break
```

**两个隐蔽坑** `[源码]`：

- **query 编码必须与签名串一致**：逗号**不能编码**（`image_formats=jpg,webp,avif` 若被编成 `%2C` 则签名校验失败）。
  MediaCrawler 因此手拼 query 而不用 httpx 的 `params`。
- **JSON body 必须紧凑且保序**：`json.dumps(data, separators=(",",":"), ensure_ascii=False)`。
  字段插入顺序是签名 body 的一部分。

### 2.3 签名机制：`x-s` / `x-t` / `x-s-common`

| 头 | 作用 | 是否强校验 |
|---|---|---|
| `x-s` | **主签名**，`"XYS_" + 自定义Base64(JSON)` | ✅ |
| `x-t` | 毫秒时间戳 | ✅ 参与计算 |
| `x-s-common` | 设备/环境指纹（由 **`b1`** 派生，会话内基本固定） | ✅ 绑 `b1` |
| `x-b3-traceid` | 随机 16 位 hex | ❌ 不参与校验 |
| `x-xray-traceid` | 追踪头 | ❌ |
| `x-rap-param` | 风控头，**仅部分接口需要**（路径白名单，如 `user_posted`、`feed`） | ✅ |
| `xy-direction` | 分片路由，**仅 `homefeed` / `feed` 带** | — |

`x-s` 结构 `[源码]`（`xhshow` + 逆向文章一致）：
```
x0=SDK版本  x1="xhs-pc-web"  x2=平台(Windows)  x3=mns签名("mns0301_...")  x4=参数类型
核心 = window.mnsv2(url + body, MD5(url+body), MD5(url))
```

**MNS 档位** `[源码]`：`resolve_mns_tier()` —— 指纹就绪 → `0301`（内容接口）；未就绪的安全域 → `0201`；否则 `0101`。

**⚠️ 行为计数器（本平台真正的硬门槛）** `[共识]`：多条独立来源指出 `mnsv2` 签名里打包了
**点击计数、mouseenter 计数、页面加载时间戳、停留时长**，服务端解密后据此判定。观察到：
- `document.querySelector("#search-input")` 上监听 `mouseenter` 记时，`click` 时算间隔，
  **≥77ms 才计入有效点击**；
- 计数器**恒为 0 / 固定值 / 无规律跳变**都会被判为脚本；

`xhshow` 为此提供了 `SessionManager`（固定页面加载时间戳 + **单调递增**计数器），
官方注释自述"基于理论分析，**实际效果待验证**" `[源码]`。

### 2.4 `xsec_token`：最硬的门槛

- `/api/sns/web/v1/feed` 与**全部评论接口必须**携带 `xsec_token` + `xsec_source`。
- **来源唯一**：搜索响应 `data.items[].xsec_token`、用户笔记列表 `data.notes[].xsec_token`、页面 URL、分享短链。
  **不能自己构造、不能跨笔记搬运** `[共识]`。
- **会过期**。实践口径：把完整链接当**短效输入**而非永久标识；过期后重新从可见卡片/新分享链接取 `[共识]`。
- `xsec_source` 取值：`pc_search` / `pc_user` / `pc_feed` / `pc_creatormng`。
- **工程含义**：`note_id` 才是去重主键；`xsec_token` 必须**随抓随用**，落库只能当"曾经用过的 token"缓存，
  不能当凭证。这与现有 `BasePlatform.fetch_post_page` → `enrich(item)` 的形态**天然冲突**
  （enrich 时拿不到列表响应的 token），需要把 token 放进 `item`/`body_json` 透传。

### 2.5 Cookie 语义

| Cookie | 类别 | 作用 |
|---|---|---|
| **`a1`** | **设备指纹，签名强制输入** | 缺 `a1` 直接 `raise ValueError`；长度 52 字符 |
| **`web_session`** | **登录凭证** | 决定能取到多少内容 |
| `webId` | 设备指纹 | 由 `a1` 派生（32 位 hex），签名内部会读 |
| `gid` / `xsecappid` / `websectiga` / `sec_poison_id` / `acw_tc` / `webBuild` / `loadts` / `id_token` | 指纹/环境/风控 | 建议整体导出复用 |

**无登录能到哪一步** `[共识]`：
- ✅ 只要 `a1` 就能生成合法 `x-s`/`x-t`/`x-s-common`（`web_session` **不是**签名必需项）；
- ⚠️ 但 `feed` 详情可能 `success=true` 而 `data` 为空 —— **能过签名关，拿不到实质内容**；
- ❌ 评论接口 token 必填且需登录。

⇒ **`web_session` 才是取数凭证**。判定技巧：先只带正确签名看 `success`，再补 `web_session` 看有没有数据。

### 2.6 风控表现

| 信号 | 含义 |
|---|---|
| HTTP **461 / 471** | **验证码挑战**（读响应头 `Verifytype` / `Verifyuuid`） |
| `401 / 403 / 429` | 被拦截 |
| `code: 300012` | **IP 被封** |
| `code: 300011` | **账号安全限制** |
| `-510000` / `-510001` | 笔记不存在 / 状态异常 |
| `success=true` 但 `data` 空 | token 失效 或 `web_session` 失效 |

`[源码]`（MediaCrawler `xhs/client.py` 直接实现了这套映射）

**账号级风险** `[共识]`：2026 年有大量**封号/长期限流**反馈（含"被提示检测到 AI 操作"、
"仅抓一次即被限制"）。MediaCrawler 维护者已把默认值改为 **`MAX_CONCURRENCY_NUM=1`**，
并**推荐 CDP 连接用户真实浏览器**（"不走自动化那一套，容易检测"）`[源码]`。

**代理口径（一个有价值的反直觉结论）** `[共识]`：**机房/数据中心 IP 是负资产**；
社区建议"本地家庭宽带 + 高权重账号"。区分"住宅 vs 机房"比"用不用代理"更关键。

### 2.7 数据形态

- 类型：`note_card.type` = `"normal"`(图文) / `"video"`(视频)。搜索入参 `note_type`：`0`不限/`1`视频/`2`图文。
- 去噪：搜索 `items[]` 里 `model_type` 为 `rec_query` / `hot_query` 的**不是笔记**，必须过滤。
- 字段：`note_id`(24位hex) / `title` / `desc` / `type` / `user.user_id` / `interact_info.{liked,collected,comment,share}_count` /
  `image_list[].url_default` / `video` / `tag_list[]`（`type=='topic'` 才是话题）/ `time` / `last_update_time`。
- **时间单位 `[存疑]`**：`x-t` 与逆向量到的 `Date.now()` 都是毫秒；但 `note_card.time` 是否秒级
  **两处来源冲突**（MediaCrawler 原样落库不除 1000；第三方文档称秒级）。
  ⇒ 工程上**做量级判断自适应**（>1e12 视为毫秒），别硬编码。
- **置顶帖 `[待验证]`**：未在任何公开源码里找到明确的置顶字段名（见 §7）。
- 图片去水印：`sns-webpic-qc.xhscdn.com/<time>/<hash>/notes_pre_post/<id>!...` →
  `https://ci.xiaohongshu.com/notes_pre_post/<id>?imageView2/format/jpeg`；
  视频取 `www.xiaohongshu.com/explore/{id}` 的 `<meta name="og:video">`。
  **媒体下载必须带防盗链头** `Referer: https://www.xiaohongshu.com/` + UA。

### 2.8 登录

| 方式 | 要点 |
|---|---|
| **扫码** | `POST /api/sns/web/v1/login/qrcode/create` → `GET /api/sns/web/v1/login/qrcode/status`；状态 `1`=已扫待确认、`2`=已确认；QR 有效期约 240s |
| **手机验证码** | 需先点同意隐私协议；验证码从 Redis 轮询，最长等 2 分钟 |
| **Cookie 复用** ✅ | 最省事。**MediaCrawler 只注入 `web_session` 一个 cookie**，其余不管 |

- 登录态载体：`web_session`（httpOnly, domain `.xiaohongshu.com`）；辅助 `web_session_sec`、`id_token`。
- **有效期约 7–30 天** `[共识]`。
- ⚠️ **同一账号不允许多个网页端同时登录** —— 在别处登录会把当前会话"踢出"（手机 App 不受影响）`[共识]`。
  这条对**桌面常驻采集工具**是硬约束：用户自己在浏览器登录会把采集会话踢掉。

---

## 3. 抖音（Douyin）

### 3.1 域与鉴权分层（强度差一个数量级）

| 域名 | 用途 | 签名要求 |
|---|---|---|
| `www.douyin.com` | 主站 `/aweme/v1/web/*` 全部业务接口 | **最严**：`a_bogus` + cookie + secsdk 三件套 + 网关头 |
| `aweme.snssdk.com` | **App 端旧域**，`/aweme/v1/play/` 播放直链 | **无签名**（`video_id` + referer 即可）`[共识]` |
| `*.douyinvod.com` | 视频 CDN | 只要 `Referer: https://www.douyin.com/` |
| `www.iesdouyin.com` | SSR share 页 | share 页无签名；`iteminfo` 已加密拦截 |
| `live.douyin.com` | 直播 Web 端 | 房间页无签名；弹幕 WSS 需 `signature` |

**架构洞察** `[共识]`：`aweme.snssdk.com/aweme/v1/play/` 是给老 App 客户端做向后兼容的直链播放接口，
设计上不承担反爬职责 —— 这是"无登录拿视频"能成立的根因**（窗口期，已在劣化，见 §3.7）**。

### 3.2 接口清单

以下相对 `https://www.douyin.com`，除注明外均为 `GET`。

| 用途 | 路径 | 关键参数 | 分页字段 |
|---|---|---|---|
| 用户主页信息 | `/aweme/v1/web/user/profile/other/` | `sec_user_id`、`publish_video_strategy_type=2`、`personal_center_strategy=1` | — |
| **用户作品列表** | `/aweme/v1/web/aweme/post/` | `sec_user_id`、`count=18`、`max_cursor`、`locate_query="false"`、`publish_video_strategy_type=2` | **`max_cursor`** |
| 单个视频详情 | `/aweme/v1/web/aweme/detail/` | `aweme_id` + `uifid` + `verifyFp`/`fp`(=`s_v_web_id`) | — |
| 综合搜索 | `/aweme/v1/web/general/search/single/` | `search_channel=aweme_general`、`keyword`、`offset`、`search_id`、`count=15` | **`offset` + `search_id`** |
| 一级评论 | `/aweme/v1/web/comment/list/` | `aweme_id`、`cursor`、`count=20`、`item_type=0` | **`cursor`** |
| 二级评论 | `/aweme/v1/web/comment/list/reply/` | `item_id`、`comment_id`、`cursor` | `cursor` |
| 用户喜欢列表 | `/aweme/v1/web/aweme/favorite/` | `sec_user_id`、`cursor` | `max_cursor` |
| 收藏 / 合集 / 历史 / 关注 / 粉丝 | `/aweme/v1/web/{aweme/listcollection,mix/list,history/read,user/following/list,user/follower/list}/` | — | 各自不同 |
| 热搜榜（**无登录可用**） | `/aweme/v1/web/hot/search/list/` | — | — |

`[源码]`（MediaCrawler `douyin/client.py`、`mafqla/douyin-api` docs）

**⚠️ 三个分页机制互不相同，混用是最常见实现错误**：
作品列表 `max_cursor` / 搜索 `offset`+`search_id`（`search_id` 取自上次响应 `extra.logid`）/ 评论 `cursor`。
且 **`has_more` 是整数 `1`/`0` 不是布尔**。

**固定公共参数**（每个 `/aweme/v1/web/*` 都要带）`[源码]`：
`device_platform=webapp`、`aid=6383`、`channel=channel_pc_web`、`pc_client_type=1`、
`version_code/version_name/update_version_code`（**需与真实浏览器一致**）、
`browser_*`/`os_*`/`engine_*`/`cpu_core_num`/`device_memory`/`screen_width`/`screen_height`（**设备指纹面，参与签名校验**）、
`webid`、`msToken`。

⚠️ **指纹必须同源**：`screen_width/height` 与 cookie `dy_swidth`/`dy_sheight` 冲突会被识别。

### 3.3 签名机制：2026 版是"四层"，不是单一 `a_bogus`

**这是本次调研最重要的技术发现** `[源码 + 删参数对照实验]`：

| 层 | 组件 | 缺失后果 |
|---|---|---|
| 1 | **`a_bogus`**（bdms JSVMP） | 403 |
| 2 | **secsdk 三件套**：`timestamp` + `x-secsdk-web-signature` + `uifid` | 删任一 → **403 Sign Invalid** |
| 3 | **边缘网关 `x-tt-argus`** 头 | 403 `Blocked by ArgusSecurityPlugin Uifid Not Found` |
| 4 | 十余个**必须同源**的指纹 cookie（`s_v_web_id` 必须同时充当 `verifyFp`/`fp`；自造的 → 403 `Signature Not Found`） | 403 |

**签名顺序有硬要求** `[源码]`：**先算 `a_bogus`（URL 不含 secsdk 三参数），再由 secsdk 在 query 末尾追加
`uifid` + `timestamp` + `x-secsdk-web-signature`**。顺序颠倒会失败。

**`a_bogus` 算法结构** `[源码]`：`s4_encode( random_head(4) + (bb XOR 固定keystream) )`
- `bb` 变长（134–140 字节），约 25 字节固定、113–115 字节随**时间戳**变化；
- 哈希用 **SM3**（国密）；
- RC4 **固定 keystream**（可从多个样本 XOR 提取）；
- 编码是**自定义 base64 变体（s4）**。
- ⚠️ **长度有版本冲突**（180 vs 192）、**s4 字符表有两份不同版本** —— **不要硬编码长度或字符表**（§7）。

**`x-secsdk-web-signature`** `[源码]`：128-bit / 32 位 hex，**确定性**（同 url+timestamp 同签名）；
由 `window.securitySDK.cryptoSDK`（**纯 JS 非 WASM**）计算；依赖 localStorage 里的
**ECDSA P-256 私钥**（`security-sdk/s_sdk_crypt_sdk`）等会话密钥。
**关键约束：请求 cookie 必须与签名密钥来自同一浏览器会话**（`uifid` 由 `web_runtime_security_uid` 派生）。

**`msToken`**：三条路径 `[源码]` —— 真 token（POST `mssdk.bytedance.com` 换取）、
假 token（随机 156 字符）、仓库内置固定长 token。**是签名输入之一，不是独立凭证**。
真算法未见逆向 `[待验证]`。

**`X-Bogus`（旧）与 `a_bogus` 是「并存」而非「替换」** `[共识]`：
`webmssdk 1.0.0.20` 仍导出 `frontierSign` 产 **X-Bogus（16 字符）**，
与 `bdms` 产的 **a_bogus（180 字符）同页共存** —— 所以**不能假设"老签名已经没用了"**。
X-Bogus 本身是**唯一被完整逆向**的签名之一（恒 28 字符、`CANVAS_CONSTANT=536919696`、RC4 + MD5 链）`[源码]`。

**⚠️ 复现纪律（如果真要自己签）** `[共识]`：
- **`a_bogus` 是非确定性的**（熵来自 `Math.random` + `crypto.getRandomValues`），
  服务端**解密校验而非重算比对** ⇒ **不要写"输出必须逐字节等于某个样本"的测试**；
- **必须一进程一次签名**（同进程内连续两次结果不同）；
- **cookie 不影响 `a_bogus`**（实测 0 位差异）—— 它只吃 URL/UA/时间戳。

**时效证据**：`hanzheng1954` 在 **2026-09-22 重抓**证明 `bdms` blob **逐字节未变** ——
这是目前"算法尚未换代"最硬的证据。**复核时应先做这同一件事**（抓一份 blob 比哈希）。

### 3.4 三条复现路线与各自代价

| 方案 | 代表 | 代价 |
|---|---|---|
| **A 补环境跑 JS** | MediaCrawler（`execjs` + `libs/douyin.js`，按路径切 `sign_datail`/`sign_reply`） | 需 Node；~50ms/次；patch 维护。**能自动跟随算法升级** |
| **B 纯 Python 复刻** ✅ | **DTK v5（Apache-2.0，2026-09-09）** —— 见下 | 微秒级、无 Node；**改版即失效**，需影子比对兜底 |
| **B′ 时间戳查表**（伪纯算） | `mafqla`（9454 样本/107 天/12MB 表） | 覆盖有限，**超出即失效**，不是通用解 |
| **C 浏览器/CDP** | MediaCrawler 的 `ENABLE_CDP_MODE=True`（**其默认**，`CDP_CONNECT_EXISTING=True`） | 重、慢，但**最稳** |

**DTK v5 的纯 Python 复刻（本次最重要的可复用成果）** `[源码]`：

- **`a_bogus`**：从 `bdms.js` v1.0.1.19-fix.01 逆向。关键事实 ——
  `bdms.js` 是**普通 minified webpack bundle 而非混淆包**，所以 VM 的**解释器是可读 JS**、
  程序可离线解码（base64 → 按字节 4..7 作 key 的 XOR → raw DEFLATE）成 1001 个字符串 / 796 个函数，
  生成器是 `fn150`；
- 算法要素：`SM3(SM3(text + "dhzx"))` 双哈希 + **"像 RC4 但不是 RC4"** 的流密码
  （S-box **降序**初始化、密钥调度用**乘法**而非加法，单字节 key `0xD3`）+ 自定义 base64 表 `s3`/`s4`；
- **`structure_error()` 能判定任意字符串是否是合法 `a_bogus`**（校验 header magic `(3,82)`、
  SDK 版本 `[1,0,1,0]`、`aid=6383`、`page_id=6241`、50 个标量字段的固定置换、内部 XOR 校验和）。
  ⚠️ **刻意不校验长度** —— 长度随窗口 geometry 变化，两个都正确的实现长度可以不同；
- **`x-secsdk-web-signature`**：
  `md5(f"{uifid}_{timestamp}_{SALT}_{query}")`，`SALT = "A96D855A08C0A9707F8BEF0D9A527E4E"`
  （来自 SDK 字符串表第 39 条，`project-id="34"`）。**纯函数、无 nonce、无会话状态**；
- **同源要求**：`uifid` 与 `s_v_web_id` 必须来自**同一浏览器会话**（自造 → 403 `Signature Not Found`）。

**⚠️ 两个必须记住的实现陷阱** `[源码]`：

1. **Node 21+ 的 `navigator`/`crypto`/`performance` 是 getter-only 全局** ——
   `global.navigator = {...}` 会被**静默忽略**，必须用
   `Object.defineProperty(globalThis, name, {value, writable:true, configurable:true})`。
   （走纯 Python 路线可以绕开这个坑，这也是 A 路线相对 A′ 的一个附带好处。）
2. **`a_bogus` 里的"随机"不全是随机** —— 其中 3 个字节是**环境报告**
   （浏览器家族、SDK 自检 tripwire 状态）。**写均匀随机是一个 tell**：均匀随机落在
   不可能区间/错误家族的概率分别是 6% 与 78%。DTK 的做法是按实测band 分布生成。

### 3.4.1 影子比对：把"签名悄悄失效"变成"可见且自愈" `[源码]`

DTK v5 的 `SignerRegistry` 设计对本项目**直接可借鉴**（它解决的问题正是
`docs/ARCHITECTURE-IMPROVEMENT-EXECUTION.md` 反复强调的"别静默失败"）：

| 机制 | 做法 |
|---|---|
| **默认本地签名** | 微秒级、无依赖 |
| **影子比对** | 每端点每 600s 抽一次：同一请求**本地签一次 + 浏览器签一次**，做结构化比对 |
| **比对口径** | `a_bogus` **不比字节**（含两个毫秒时钟 + ~38 个噪声绘制）⇒ 比**噪声碰不到的常量**；比对**不复用生成器的常量**则无法判定 |
| **误判防护** | 已知 1/690 的尾部假阳性（3→4 噪声展开的尾部丢弃分支 + 校验和为 0）⇒ **重签重取再下结论**，把假阳性压到约百万分之一 |
| **失败方向** | 比对不一致 → **自动切到浏览器 + 报警**；**比不出来 → 视为"未比对"，绝不禁用本地路径**（"absence of evidence must never disable the native path"） |
| **降级要出声** | 每次跨越首选签名器都**记一条日志 + 发告警** —— 否则"签名坏了但流量悄悄走另一条路"会让成功率看起来完全正常 |

> **"静默降级 = 坏了也看不出来"这条，是本项目已经踩过的同一类坑**
> （见 `docs/ARCHITECTURE-IMPROVEMENT-EXECUTION.md` 关于 unsupported 静默丢弃的判断）。
> DTK 把这条经验做成了机制，值得照着做。

### 3.5 标识：`sec_user_id` vs `uid` vs `unique_id`

| 标识 | 形态 | 稳定性 | 用途 |
|---|---|---|---|
| `uid` | 纯数字 | 稳定，不暴露于 URL | 内部主键 |
| `sec_user_id` | `MS4wLjABAAAA...` | 稳定，**对外公开** | **Web API 唯一入参** |
| `unique_id` | 用户自设字符串 | **可变**（用户可改） | 「抖音号」，人可读 |
| `aweme_id` | **19 位数字** | 永久 | 作品主键 |

- `sec_user_id` ↔ `uid`：✅ **可经接口拿** —— `profile/other` 响应**同时返回 `user.uid` 与 `user.sec_uid`**
  （这是最可靠的双向映射）。
- `unique_id` → `sec_user_id`：✅ 经**搜索**（`search_channel=aweme_user_web`），⚠️ **需登录**。
- `uid` → `sec_user_id` **无本地算法** `[共识]`。

⇒ 印证 §1.2：**用户手上没有可直接输入的稳定 uid**。`BasePlatform.fetch_user_info(uid)` 的
`uid` 语义需要重新定义（很可能是"先解析再抓"的两段式）。

### 3.6 风控：403 的根因表（排查必备）

> **✅ 真机实测更正（2026-10-04，`devlog/333`）—— 下表在**本网关**一条都没复现，先看更正：**
>
> 同一身份（Edge 154 同源 cookie 包 + 真机 UA + `curl_cffi impersonate=chrome`）14 个请求实测：
>
> | 实测形态 | 症状 |
> |---|---|
> | **游客**身份（只有 `UIFID`/`s_v_web_id`/`ttwid`）+ `a_bogus` **缺失或值写错** | **HTTP 200 + 0 字节空体**（`logid` 正常下发）——**不是 403** |
> | **登录**身份（61 个 cookie，含 `sessionid`/`__ac_signature`/`bd_ticket_guard_*`/`web_sign_token`） | **完全不校验签名**：去掉 `a_bogus`、去掉 secsdk、去掉 `x-tt-argus`、`verifyFp` 换自造值，四例全 200 且载荷逐条相同 |
> | 游客 + 只留 `a_bogus`（去 secsdk 三件套与 `verifyFp`/`fp`） | 200，完整载荷 ⇒ **secsdk 不是必需** |
> | 去 `msToken` | 200，完整载荷 ⇒ 不是必需 |
> | `/aweme/v1/web/aweme/detail/`（登录与游客都试） | **不校验 `a_bogus`**（签/不签/签错三例载荷等价）|
>
> ⇒ 三条口径要改：**①"签名无效"的样子是 200 + 空体**（排查时别去找 403，也别当成"这个 V 没作品"）；
> **②登录态是目前唯一的"免签"通道**（宽松是平台当下的选择，不是契约，代码里不许依赖它）；
> **③"缺参数"与"参数写错"必须分开测** —— 只测缺失时，无法区分"平台要这个参数"与"平台根本没校验"。

| 症状 | 根因 | 处置 |
|---|---|---|
| 403 `... Uifid Not Found` | 缺 `x-tt-argus` 头 / 缺 `uifid` | 加 `x-tt-argus`（**当前网关不校验取值**，传 `"1"` 即可）+ `uifid` |
| 403 `... Signature Not Found` | `uifid` 与 `verifyFp` **不同源** | `verifyFp`/`fp` 必须用 cookie 的 `s_v_web_id` 原值 |
| 403 Sign Invalid | 缺 `timestamp` 或 `x-secsdk-web-signature` | 上 secsdk 三件套 |
| 403（无 Argus 字样） | `a_bogus` 无效 / 拼接顺序错 | 重算；确认**先 a_bogus 后 secsdk** |
| 响应体为空串或字面量 `"blocked"` | 账号被风控 | — |
| `status_code=2483` | 未登录 | 补登录 cookie |
| `status_code=11110` `encrypt_data_miss` | 旧 `iteminfo` 接口已加密拦截 | 换接口 |
| 页面标题含「验证码中间页」/ `#captcha-verify-image` | **滑块验证** | 见下 |

**⚠️ 风控打到账号上（与本项目直接相关）** `[共识 + 技术印证]`：
`secsdk` 密钥与会话同源绑定，且 `sdk_source_info` / `account_sdk_source_info` 是
**逐请求携带的反自动化探针** —— 一旦某会话被标记，**该账号下所有后续请求**都带污染指纹。
**这与 B 站「412 是 IP 级且不连累登录态」有本质区别**，换 IP 无用。

**滑块** `[源码]`：MediaCrawler 官方注释直白建议 —— *"验证精度不太好……如果没有特殊需求，
**不建议使用抖音登录，或用 cookie 登录**"*。技术上：`max_slider_try_times=20`、
失败提示「操作过慢」→ 点 `.secsdk_captcha_refresh` 刷新重试。

**登录协议全流程** `[源码]`（`cv-cat/DouYin_Spider` 有逐请求实录）：
`get_sec_ts → ttwid/check → login_guiding_strategy → **challenge** → get_qrcode → check_qrconnect`。
其中 **`POST /passport/web/challenge/`** 是社区普遍跳过但必需的一步
（`AES-256-CBC`，`key=SHA256(UA)`；响应 `data.template` 是 77KB JS，必须执行才算交作业）。
⚠️ **Cookie 写入顺序本身是指纹**（该文档逐字节记录了各 endpoint 的 cookie 顺序）。
⇒ 又一条支持"真实浏览器"路线的证据。

### 3.7 数据形态

- **视频 vs 图文** `[源码]`：**最可靠的判别是 `images` 非空**（比 `aweme_type==68` 更稳）。
- **⚠️ 图文帖两个陷阱** `[共识]`：
  1. `v1/play` 直链对图文帖**只返回首图** —— 图文必须走 `images[].url_list`；
  2. 图文帖通常**没有 `video` 对象**，直接 `aweme["video"]["play_addr"]` 会 **KeyError**。
- 字段：`aweme_id`(19位数字) / `desc` / `create_time`(**秒级**) / `aweme_type` / **`is_top`**(1=置顶) /
  `statistics.{digg,comment,share,collect,play}_count`（`play_count` **常缺失或恒 0**）/
  `video.cover.url_list` / `video.play_addr.url_list` / `video.play_addr_h264` / `video.bit_rate[]` /
  `video.duration`(**毫秒**，注意与 `create_time` 单位不同) / `images[].url_list` / `author.{uid,sec_uid,nickname}`。
- 封面优先级 `[源码]`：`raw_cover → origin_cover → cover → dynamic_cover`（各取 `url_list[-1]`）。
- **去水印**：`play_addr_h264` / `play_addr_256` 优先，取 `url_list` 末位；建议**保存全部候选 URL**，不赌单一规则。
- 去重：**`aweme_id`（字符串）**。不要用 `desc`/`create_time` 单独去重（同秒多投、文案重复常见）。
- **无登录下载路径已在劣化** `[共识]`：2026-08-30 起 SSR share 页不再对无 cookie 请求渲染
  `play_addr.uri`（返回壳页 + 风控标记）。当前主力通道是「浏览器游客 cookie + yt-dlp」。
  直链有效期约 1–2 小时。另有来源报告**非中国大陆 IP 被封锁** `detail` 与 CDN `[共识]`。

### 3.8 直播 / 弹幕（概览，本阶段不做）

- 房间页 `live.douyin.com/<web_rid>`；从 HTML 提取 **`room_id`**（**与 `web_rid` 不同值**）。
- 弹幕 WSS：`wss://webcast*-ws-web-*.douyin.com/webcast/im/push/v2/?...&signature=`；
  `signature` 的 **md5 明文拼接规则公开**（`live_id=1,aid=6383,...`），但 md5 之后的加密封装仍是黑盒。
- 链路：`PushFrame → payload(gzip) → gunzip → Response → messages[] → 具体消息体`。
- **心跳**：固定二进制 `3a026862`（两个独立来源一致）。
- 消息类型：`WebcastChatMessage` / `GiftMessage` / `LikeMessage` / `MemberMessage` / `SocialMessage` /
  `RoomUserSeqMessage` / `ControlMessage`(status=3 即结束) 等。
- ⚠️ protobuf 的 `Long`(int64) 在 JS 丢精度 —— **又一次印证 19 位 ID 必须按字符串处理**。

---

## 4. 已有开源项目盘点

> star 数是 **2026-09-27 前后的近似快照**，只用于判断量级与活跃度，不是精确值。
> ⚠️ **本表的 License 与路线一律以源码 / 仓库元数据为准，不采信 README 自述** ——
> 本次实测到**至少三种 README 与事实不符**的形态，见 §4.3。

### 4.1 可直接借鉴的项目

| 项目 | 语言/License | 路线 | 对本项目的价值 |
|---|---|---|---|
| [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | Python / **非商用许可 (NON-COMMERCIAL)** | **小红书 = 纯 Python `xhshow`；抖音 = Node `execjs` 跑 JS** | ⭐ **最有价值**：接口清单、分页范式、`xsec_token` 处理、403 根因注释。⚠️ README 仍写"无需 JS 逆向/基于 Playwright"，**与代码已不一致** |
| [Cloxl/xhshow](https://github.com/Cloxl/xhshow) | Python / **MIT**，PyPI 0.2.0 (2026-06-11) | 小红书 `x-s`/`x-s-common`/`x-rap-param` **纯算法** | ⭐ **可直接依赖**。**双重生产验证**：被 MediaCrawler（65k★）与 `xiaohongshu-cli`（2.6k★）同时采用。⚠️ 有过 POST 签名回归（§4.3） |
| [jackwener/xiaohongshu-cli](https://github.com/jackwener/xiaohongshu-cli) | Python / **Apache-2.0** | 依赖 `xhshow>=0.1.9` + **创作中心 AES-128-CBC 独立签名** | ⭐ **工程实践范本**：反检测细节（高斯抖动、**会话级指纹持久化**、验证码退避 5→10→20→30s 后**永久翻倍延迟**）、`xsec_token` 缓存与 URL 短路复用、结构化输出 envelope |
| [Evil0ctal/Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API)（**v5**） | Python / **Apache-2.0** | ⭐ **抖音 `a_bogus` + `x-secsdk-web-signature` 纯 Python 复刻**；浏览器**只铸身份** | ⭐⭐ **本次最有价值**：纯 Python 签名、端点级保护清单、影子比对、`structure_error`。**Apache-2.0 ⇒ 可参考甚至可依赖**。⚠️ 它是重服务（Postgres+Redis+React），**不适合整体引入**，但 `signing/native/` 是本项目最该读的实现 |
| [JoeanAmier/XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader) | Python / GPL-3.0 | **`curl_cffi` 模拟 TLS 指纹**（`impersonate=chrome146`）+ 解析 `window.__INITIAL_STATE__` | 第三条路线：**完全不碰签名**（解析仅 13 行）。⚠️ GPL-3.0 **不可复制代码** |
| [JoeanAmier/TikTokDownloader](https://github.com/JoeanAmier/TikTokDownloader) | Python / GPL-3.0 | `curl_cffi` + 外部加密参数 | ⚠️ README 顶部明确声明「**加密参数算法不再维护**……请自行准备加密参数生成代码」→ **强维护风险信号** |
| [Johnserf-Seed/f2](https://github.com/Johnserf-Seed/f2) | Python / Apache-2.0 | 纯 Python `abogus.py` / `xbogus.py` | License 友好、可读性佳（保留原始 JS 变量名）。⚠️ **源码常量是旧版**（`pageId=0`、盐 `"cus"`，当前应为 `6241` / `"dhzx"`）⇒ **可能已过期** |
| [cv-cat/Spider_XHS](https://github.com/cv-cat/Spider_XHS) · [DouYin_Spider](https://github.com/cv-cat/DouYin_Spider) | Python / **无 License** | Node 执行签名 JS + **严格 header 顺序** | ⭐ 最完整的小红书签名**算法文档**（三档 mns、XYS 信封、ARX 哈希）+ 一手记录（header 顺序、cookie 域作用域、`sdk_source_info` 探针键、`challenge` 全流程）。⚠️ **无 License = 保留所有权利，不可用于商业产品** |
| [ReaJason/xhs](https://github.com/ReaJason/xhs) | Python / MIT | 纯 Python `sign()` | ⚠️ 签名版本已过期（`x1="3.2.0"`、`x4="2.3.1"`）；**最后提交 2025-07，停滞约 14 个月** → 仅作算法演进对照 |
| [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | Go / Apache-2.0 | 浏览器自动化 | ⭐ 运营侧数据点：标题 ≤20 字、正文 ≤1000 字、**日发帖上限约 50**、**同账号不允许多网页端登录**；作者自述稳定运行一年多**未封号**，只遇到 cookie 过期 |
| [mafqla/douyin-api](https://github.com/mafqla/douyin-api) | Python / 无 License | **时间戳查表法**（非算法还原） | ⭐ 价值在**两份逆向文档**（`REVERSE_GUIDE.md` / `sign_reverse_findings.md`），**不在代码** —— 作者自评完全逆向仅 **30% 完成度**、需 80–320 小时，且**生产推荐 Node 补环境而非纯 Python** |
| [hanzheng1954/douyin-abogus-analysis](https://github.com/hanzheng1954/douyin-abogus-analysis) | JS / **无 License** | opcode 级逆向 | SM3 `dhzx` 盐、VM 796 程序表、Node 21+ getter-only 坑、**2026-09-22 重抓证明 bdms blob 逐字节未变**（最硬的时效证据） |
| [ylcangel/douyin_sign](https://github.com/ylcangel/douyin_sign) | JS+Python / **Apache-2.0** | a_bogus **去混淆 VM** + x_bogus(含 Python) + msToken | ⭐ 有配套逆向课程；**a_bogus 只有 JS 版**。⚠️ 网传的 `brock7/douyin_sign` 是它的 **fork（star=0）**，引用要指向真身 |
| [ihmily/streamget](https://github.com/ihmily/streamget) | Python / MIT | 小红书 HLS+FLV 取流 | ⭐ **无需 Cookie、无需 Node** 即可取流（MIT 可直接依赖） |
| [skmcj/dycast](https://github.com/skmcj/dycast) | TS / **无 License** | 抖音直播弹幕 | 弹幕链路（PushFrame→gzip→Response）+ `Long`→字符串的改法。⚠️ 无 License |
| [saermart/DouyinLiveWebFetcher](https://github.com/saermart/DouyinLiveWebFetcher) | Python / **AGPL-3.0** | 抖音弹幕（WSS+protobuf） | 抖音弹幕 Python 侧事实标准。⚠️ **AGPL-3.0 有传染性**；同步阻塞、无重连 |
| [jwwsjlm/douyinLive](https://github.com/jwwsjlm/douyinLive) | Go / MIT | 抖音弹幕 | ⭐ **纯 Go a_bogus（SM3+RC4），无 JS 运行时** ⇒ 独立印证"可纯本地化" |
| [n1tr00-10/tiktok-signature](https://github.com/n1tr00-10/tiktok-signature) · [carcabot/tiktok-xgnarly-decoded](https://github.com/carcabot/tiktok-xgnarly-decoded) | Python / NOASSERTION · **MIT** | TikTok X-Gnarly / X-Dynosaur | 若要覆盖 TikTok：后者是 **X-Gnarly 唯一逐字节文档化实现 + MIT（许可干净）** |

### 4.2 从开源生态读到的四条工程结论

1. **两家都能纯 Python 签名**，但抖音的复刻**必须按端点分层**（14 条白名单路径需 secsdk 签名，
   其余连平台自己都不签）—— §3.4 的实测表就是这层的依据。
2. **浏览器没有消失，只是位置变了**：它不再在请求路径上，而是**退到身份铸造**（低频、可缓存）。
   MediaCrawler 代表"旧答案"（逐请求靠浏览器上下文），DTK v5 代表"新答案"（浏览器只铸身份）。
3. **GitHub 上没有可直接 pip 装的抖音签名包** —— 抖音纯算必须**内联源码**
   （PyPI 不存在名为 `abogus` 的包；流传的"abogus API"是 Cloudflare Worker 或
   **转卖远程 API 的代理，不是实现**）。相对地，小红书有 `xhshow` 这个干净的 PyPI 包。
4. **"加密参数不再维护"是行业常态**：`TikTokDownloader` 已公开声明放弃维护签名算法。
   ⇒ 平台适配必须**假设签名会周期性失效**，并设计成"可替换、失败可见"（§3.4.1）。

### 4.3 ⚠️ License 与 README 可信度（本次实测踩到的坑）

**License 是本项目最需要注意的雷区**：`Spider_XHS`、`dycast`、`douyin-abogus-analysis`、
`jobsonlook/xhs-mcp` 等**API 返回 `license: null`** ⇒ **按"保留所有权利"处理，不可复制进本项目**。
GPL-3.0 / AGPL-3.0 的（XHS-Downloader、TikTokDownloader、DouyinLiveWebFetcher）**同样不可复制**。
真正可安全参考的是 **MIT**（`xhshow`、`streamget`、`douyinLive`、`tiktok-xgnarly-decoded`）与
**Apache-2.0**（DTK v5、`xiaohongshu-cli`、`ylcangel/douyin_sign`、`f2`）。

> DTK v5 作者的原话值得记下来：「上一版是 GPL-3.0 代码的移植，**无法在 Apache-2.0 下发布，
> 这就是重做的原因**」—— **License 污染是真实发生过的事，不是理论风险**。

**实测到 README 与事实不符的三种形态**（每一种都会直接误导选型）：

| 形态 | 实例 | 后果 |
|---|---|---|
| **README 与自己的代码不一致** | MediaCrawler 仍宣称"无需 JS 逆向/基于 Playwright"，实际已改用 `xhshow` | 照 README 选型会**误判整条路线** |
| **License 徽章与仓库元数据冲突** | 某抖音签名项目标 MIT，但 API `license: null`，且 README 自称的 nightly CI 工作流**返回 404** | 照 README 判断可商用**有法律风险** |
| **常量已过期但未声明** | `f2` 的 `pageId=0` / 盐 `"cus"`（当前应为 `6241` / `"dhzx"`）；`ReaJason/xhs` 的 `x1="3.2.0"` | 直接复制**必然签名失败** |

⇒ **纪律**：引用开源实现前，**读源码常量与仓库元数据，不读 README 自述**；
License 以 LICENSE 文件 / API 元数据为准，**徽章不算**。

---

## 5. 对 DDToolkit 的落地含义

### 5.1 数据模型：**不需要改表**

`Account.platform_uid` 是 `String`、`Post.platform_post_id` 是 `String`，唯一键分别是
`(platform, platform_uid)` 与 `(platform, platform_uid, platform_post_id)` —— **能直接容纳这两个平台** `[源码]`。
卡点**只在采集层**。

要守住的只有两条：
1. **19 位 `aweme_id` 全程按字符串**（§1.3 第 1 条）；
2. **`xsec_token` 不是凭证、不能当去重键**（§2.4）—— 落库只能进 `body_json`/`raw_json` 作缓存。

### 5.2 `BasePlatform` 的已知不足（先落平台再提炼）

| 现有接口假设 | 不成立之处 | 可能的形状（**待落地后验证**） |
|---|---|---|
| `fetch_user_info(uid)` | 用户手上没有稳定 uid | 需 `resolve_identity(用户输入) -> platform_uid` 两段式 |
| `fetch_post_page(uid, page)` | 两家都是 **cursor** 而非页码 | 需要 `cursor`（或把 cursor 编码进 `page`） |
| `enrich(item)` | 小红书详情需要**列表阶段拿到的 `xsec_token`** | 必须让 `item` 携带上下文（现在 `raw_json` 可透传） |
| 风控按平台 | 抖音风控是**会话/账号级** | 节流与冷却的粒度要能到"会话" |
| 不支持 → 静默丢弃 | 新平台一上来就踩 | 需结构化返回失败原因 |

**⚠️ 按 `docs/ARCHITECTURE-IMPROVEMENT-EXECUTION.md` §1.4 的既定顺序：现在不要动 `BasePlatform`** ——
先用它尽量写一个平台，落完之后才知道该提炼什么。

### 5.3 调度与节流

> ⚠️ 本节的"节流值"是**降低被封/被检测概率**的参数，**不是"合法额度"** ——
> 协议层面没有额度可言（§6.1）。下面的数字只影响"多快会被发现"，不影响定性。

- 现有并发模型（平台间并行、平台内串行、`_run_platform_rounds` 按平台分组）**结构上够用**，
  但**默认节流值不能沿用 B 站口径**：B 站能承受 `3~5s` 间隔 + 分钟级轮询；
  这两个平台在"很多人同时用"的前提下需要**更保守**（抖音社区经验：单账号 ≤1 req/s、并发 1）。
  这属于 `docs/ARCHITECTURE-IMPROVEMENT-EXECUTION.md` §1.4 点名的**独立口径决策**，与选型一起定。
- **静默时段 / 闲下来就慢（R28/R30）这两套机制对新平台同样是保护**，应默认生效。

### 5.3.1 身份池与限速：从 DTK v5 抄什么（本批最可复用的工程结论）

抖音风控是**身份级**的，所以现有"按平台分组 + 按平台冷却"的粒度**不够**。
DTK v5 的这套设计（`documents/zh/04-concepts.md`）与本项目 `rate_limit.py` 要解决的问题同构，`[源码]`：

| 机制 | 做法 | 为什么 |
|---|---|---|
| **身份四要素绑定** | cookie jar + 指纹 + 代理绑定 + 历史，**永不复用组合** | 原话：*"在一个共享出口和 UA 上轮换 cookie，比单纯的请求频率更像异常"* —— 真实浏览器不会这么做 |
| **健康度评分** | `success_rate × (1 − risk_rate) × 0.5^consecutive_fails` | 三者不可通约，所以**相乘**而非加权求和 |
| **按 (身份, 端点) 令牌桶** | 例：`author_posts` 每身份每秒 **0.12** ⇒ 该端点每 **8.3s** 一次 | **粒度是"身份×端点"**，不是"平台" |
| **端点级熔断** | 三条件同时成立：风控率 >0.6 ∧ 样本 ≥20 ∧ **失败涉及 ≥3 个不同身份** | 第三个条件才是"端点坏了"与"某个身份坏了"的分界线 |
| **四类响应分类** | `ok` / `business_error`（**完全不影响身份健康**）/ `risk_control` / `network_error`（**退还令牌**） | ⚠️ 抖音对**不存在的帖子返回 200 + `aweme_detail: null`**，**恰好长得像风控** —— 误判会让遍历 id 的调用方白白冷却身份并触发熔断 |
| **签名器健康监控** | 见 §3.4.1 影子比对 | 原话：*"兜底开着的时候，一个已经坏掉的签名器看起来一切正常，因为它的流量悄悄挪到了另一个上"* |

**⚠️ 与本项目的直接冲突**：现有代码把"业务失败"和"风控"都算进 `issues`/`failed`，
且 `_detect_rate_limit` 是**按平台**置位的 ContextVar（`app/services/fetcher.py`）。
新平台需要**第 5 条那个四分类**，否则"帖子被删"会被当成"身份被风控"。
**这不属于本轮工作**，但接平台时必须一起设计。

### 5.4 前端与壳层触点（接平台时要一起改）

| 位置 | 要做什么 |
|---|---|
| `frontend/src-tauri/src/lib.rs` `EXTERNAL_HOSTS` | 追加 `xiaohongshu.com` / `www.xiaohongshu.com` / `douyin.com` / `www.douyin.com` 等；否则「打开主页」失败（不会静默，会 toast 原因） |
| `frontend/src-tauri/tauri.conf.json` CSP `img-src` | 追加图床域名（`xhscdn.com` / `ci.xiaohongshu.com` / `douyinpic.com` / `douyinvod.com`） |
| `app/core/config.py` `IMG_PROXY_ALLOWED_HOSTS` | 同上 |
| `frontend/src/utils/postTypes.ts` | `PLATFORM_LABEL`、`typeGroupsFor`、`accountHomeUrl` 三处按平台白名单 |
| `frontend/src/components/AddAccountDialog.tsx` / `LoginDialog.tsx` | 平台下拉 + 登录 Tab |
| `app/services/capabilities.py` | `_logged_in()` 的 `else weibo` 分支（`.py:122`）要一并修 |

`[源码]`（逐处已核）

---

## 6. 合规：**两家都是协议明文禁止**（本节的定性优先于全篇技术内容）

> ⚠️ **2026-09-27 修订（用户指出）**：本节初版把这件事写成"**规模是分水岭**"，
> 并给了"少量/低频/只存聚合统计 ⇒ 风险较低"的**务实口径** —— **那个框架是错的**。
> 错在把两个不同问题混成了一个（下 §6.2）。**正确的前提是：没有"合规的爬虫"，也没有"允许的额度"。**
> 全篇技术内容（§2/§3/§4/§5）是**可行性**调研，**不构成可行性许可**。

### 6.1 定性：不存在"允许的抓取额度"

**抖音**《用户服务协议》（更新 2026-02-13）`[源码]`：

- §5.2(9)：禁止**反向工程、反向汇编、编译**或以其他方式尝试发现源代码；
- §5.3(4)：禁止以**爬虫抓取**等不正当方式获取内容；
- §5.3(6)：禁止将内容用于**统计热词、命中率、分类、搜索量、点击率、阅读量**等；
- §5.1：禁止使用任何**自动化程序**接入、收集或处理其中信息。

**小红书**《用户服务协议》（更新 2025-12-08）`[源码]`：

- **§4.1 平台使用规范**：不得「对小红书平台或服务进行**反向工程、反向汇编、反向编译**，或者以其他方式尝试发现源代码」；
- 同条：不得「以任何方式（包括但不限于盗链、冗余盗取、**非法抓取**、模拟下载、深度链接、假冒注册等）直接或间接
  **盗取**小红书平台的视频、图文、**用户信息**等信息内容」；
- 同条：不得「通过**非小红书公司开发、授权、许可的第三方软件、插件、外挂、系统**，登录或使用小红书平台」；
- **§3.4**：未经书面许可，「不得**复制、读取、采用、统计**小红书平台的信息内容及相关数据」——
  ⚠️ **"统计"是明文列举的**，与"发行版/聚合统计"这类用途正面对撞。

⇒ **两家的定性一致，且都不是灰色地带**：爬虫（含签名逆向、含"只读不下载"）被协议禁止；
且**小红书 §3.4 把"统计"单独列出**，这意味着"我不存原文、只算聚合指标"**并不能绕开**。

### 6.2 ⚠️ "规模是分水岭"说的是什么（初版把两件事混为一谈）

这是本次修订要纠正的核心。**必须分成两个不同的问题**：

| # | 问题 | 性质 | 与"量"的关系 |
|---|---|---|---|
| ① | **这件事允许不允许？** | **定性**：协议明文禁止 ⇒ **不允许** | **与量无关**。抓 1 条和抓 100 万条，**都是违约** |
| ② | **被追究时后果有多重？** | **定量**：民事赔偿 / 不正当竞争认定 | **强相关**。司法案例是这一层的证据 |

⇒ **初版的错误**：拿 ② 的判例（判赔金额随规模上升）去论证 ① 的"轻端风险较低"，
读起来像是在给一个**被禁止的行为**划安全区。**判例只能说明"后果多重"，不能说明"多少量以内合法"。**
而且 ① 层面的真实风险**不止赔偿**：协议下的**封号 / 限流 / 收回账号**是平台单方即可执行的（两家协议都写了），
**不需要打官司**。

**另有一层初版没写清的风险**：协议禁止的是**用户行为**，而本项目是**工具**。
工具在"帮助他人违反平台协议"这件事上的位置，与用户自己动手不同 ——
若发行给"很多人用"，这属于需要独立评估的问题（§6.4）。

### 6.3 合规路径只有一条：官方开放平台（本项目拿不到）

| 平台 | 官方路径 | 门槛 |
|---|---|---|
| 抖音 | [开放平台](https://developer.open-douyin.com/docs/resource/zh-CN/developer/introduction/type-and-permission)（用户类型与权限分级） | 需**主体资质**（企业/服务商），权限按类型授予 |
| 小红书 | [开放平台](https://open.xiaohongshu.com/) | 需**资质申请 + OAuth 2.0 授权**，面向**商家与第三方开发者** |

`[共识]`（官方文档 + 社区接入文章口径一致）

**两个关键限制**，即使拿到资质也绕不开：

1. **个人 / 本地归档工具拿不到这类权限** —— 资质、主体、审核都是为了商业接入方设计的；
2. **授权范围是"自己账号 / 已授权的内容"，不是"任意 VTuber 的公开帖子"** ——
   本项目要抓的恰恰是**第三方**（别人）的内容，**官方 API 根本不提供这个能力**。

⇒ 结论：**本项目想做的这件事，在官方路径下没有对应能力**。这不是"门槛高一点"的问题，是"没有这条路"。

### 6.4 对本项目的直接影响（产品级，必须用户拍板）

**初版给的是"务实口径"，正确说法是"这里没有安全区，只有三种立场"。**

| 选项 | 内容 | 代价 |
|---|---|---|
| **A. 不做这两个平台** | 维持只有 B 站 / 微博（这两家已接入，且其协议口径与此不同——⚠️ 但本批**未复核 B 站/微博协议**，见 §7 存疑） | 放弃这块数据；零新增合规暴露 |
| **B. 只做官方授权范围** | 接开放平台，只抓**用户自己已授权**的内容 | **拿不到"抓任意 V 的帖子"这个能力** ⇒ 实际等于 A |
| **C. 做，但把定性如实告知用户** | 工具照做，但在产品层**明说这是违反平台协议的行为、风险由用户自担**；并做 §6.5 的三条降险 | 新增一个**产品级判断**：是否愿意让工具承担"帮助违约"的位置 |

⚠️ **本批不替你选**——这是文档纪律里的"独立产品级决策"（`docs/ARCHITECTURE-IMPROVEMENT-EXECUTION.md` §1.4）。
但**初版把 C 写得像"低风险默认项"，那是误导**；C 的真实性质是"**明知违约而选择继续，并把风险显性化**"。

### 6.5 若仍要做，能降低（但不消除）风险的三条

以下三条是**降险措施，不是合规措施**——它们降低"被检测/被追究的概率与后果"，**不改变违约定性**：

1. **不存储 / 不再分发原始媒体文件**（避免触及著作权与"搬运"类判决的核心行为）；
2. **不做"热词 / 搜索量 / 点击率"类指标**（抖音 §5.3(6) 逐条点名、小红书 §3.4 点名"统计"）；
3. ⚠️ **绝不让用户提供自己的账号做采集** —— 这不只是合规问题：§3.6 已技术性印证，
   风控**会打到用户自己的账号上**（封号/限流）。若产品要"很多人用"，这等于**把封号风险转嫁给用户**。

### 6.6 司法案例（**只作 ② 定量层的证据**）

> ⚠️ 按 §6.2：下表**不能**被用来推断"多少量以内合法"。它们是"被抓到之后赔多少"的参考。

| 案例 | 结果 | 要旨 |
|---|---|---|
| **刷宝 APP 案**（（2021）京 73 民终 1011 号，最高法 2023 年典型案例之八） | 判赔 **500 万元**，二审维持 | 数据"**非独创性**"仍受反法保护；保护落点是「**规模集聚效应**」 |
| **小红书抓取售卖案**（上海知产法院，2025） | 判赔 **110 万元**，二审维持 | 认定"**双重违法性**"；**明确把"违反 robots 协议"列为不正当竞争要素** |
| **福建「固乔」案**（福建高院，2026-04） | 区分评价 | 批量下载带水印图片**未被认定**侵权（平台未证明采取了必要限度的技术措施）；但**提供改 MD5 的搬运工具**构成不正当竞争 |

⚠️ 「固乔」案常被引作"下载没事"的依据，但它的**关键区分是"下载"与"提供规避工具"** ——
**本案正落在"提供工具"那一侧**，引用时不要只取前半段。

---

## 7. 存疑清单（**不要当结论用**）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 抖音 `/aweme/v1/web/search/item/` | `[待验证]` 任务点名的路径未找到一手证据；社区通用是 `general/search/single/` |
| 2 | `a_bogus` 长度 180 vs 192 | `[存疑]` 版本冲突 ⇒ **不要硬编码** |
| 3 | `a_bogus` 的 s4 字符表 | `[存疑]` 两份不同版本；`xBogus.py` 注释称与 A-Bogus 表相同 |
| 4 | `msToken` 真算法 | `[待验证]` 只有"POST 换取"与"随机 156 字符"两条一手路径 |
| 5 | `sessionid` 有效期数值 | `[待验证]` 只有账号级"六个月未登录"协议条款，非 session TTL |
| 6 | 小红书 `note_card.time` 单位 | `[存疑]` 秒 vs 毫秒两处冲突 ⇒ **做量级自适应** |
| 7 | 小红书置顶帖字段名 | `[待验证]` 未找到（`is_top`/`sticky`/`top_flag` 都未见证实） |
| 8 | 小红书 `user_posted` 响应是 `data.notes` 还是 `data.data.notes` | `[存疑]` 两处文档分歧 |
| 9 | 小红书 `extra.need_body_topic` 类型 | `[存疑]` `"1"`(str) vs `1`(int) 两项目不一致 |
| 10 | 搜索 v1(`edith`) vs v2(`so.`) 谁是当前 | `[存疑]` 两社区并存 ⇒ 实现时**两个都试** |
| 11 | `has_more=0 但仍有数据` | `[存疑]` 社区经验，未复现 |
| 12 | 具体频率阈值（多少次/秒 会封） | `[待验证]` 所有来源只给经验值，**无精确阈值** |
| 13 | `tt_scid` 作用 | `[待验证]` |
| 14 | 抖音 `v1/play` 直链是否仍开放 | `[存疑]` 接口未复测，但**上游 SSR 已失效**（2026-08-30） |
| 15 | "单机 QPS 12,500" 类文章 | ❌ **明确否定** —— 与所有一手风控证据矛盾，不可作为节流依据 |
| 16 | **B 站 / 微博的协议是否也禁止爬虫**（本项目**已接入**这两家） | ⚠️ **本批未复核** —— 用户本次指出的是小红书/抖音；**同一问题必须对已接入平台也问一遍**，否则仓库里存在"只对新平台讲合规、对老平台不讲"的不一致 |
| 17 | 工具方（而非用户方）的责任边界 | ⚠️ **未评估** —— 协议约束的是用户行为；"提供工具"在帮助违约上的位置需要独立判断（§6.4 选项 C） |

---

## 8. 复核方法（本文怎么重新验证）

本文的价值会随时间衰减。**动手前先按这些步骤重新验证**，不要直接照抄字段：

1. **先复核合规（第 0 步）**：协议条款与判例会变（抖音协议 2026-02 更新过）。
   **若协议仍明文禁止，下面 2–6 步只解决"能不能做"，不改变"该不该做"**（§6）。
2. **签名是否仍有效**：优先看上游库的最近提交 ——
   小红书看 [`xhshow`](https://github.com/Cloxl/xhshow) 的 release / issues；抖音看 MediaCrawler 的 `libs/douyin.js` 更新时间。
   **如果上游已停更，本文所有签名结论都视为失效。**
3. **接口路径**：以浏览器 DevTools 实抓为准（小红书注意 v1/v2 搜索域之分；抖音注意分页字段三种口径）。
4. **`xsec_token` 是否仍必需**：用一个不带 token 的 `feed` 请求试 —— 若 `success=true` 且 `data` 非空，说明约束放松了。
5. **`aweme_id` 精度**：拿一个真实 19 位 id 走一遍 Python → JSON → 前端，确认没有变 `...000`。
6. **风控表现**：先跑**极小量**（个位数请求），观察是否 461/471（小红书）或 403（抖音），再决定是否放量。

---

## 9. 来源

**一手源码 / 官方文件**
- [MediaCrawler xhs/client.py](https://raw.githubusercontent.com/NanmiCoder/MediaCrawler/main/media_platform/xhs/client.py) · [xhs/playwright_sign.py](https://raw.githubusercontent.com/NanmiCoder/MediaCrawler/main/media_platform/xhs/playwright_sign.py) · [douyin/client.py](https://raw.githubusercontent.com/NanmiCoder/MediaCrawler/main/media_platform/douyin/client.py) · [douyin/help.py](https://raw.githubusercontent.com/NanmiCoder/MediaCrawler/main/media_platform/douyin/help.py) · [douyin/field.py](https://raw.githubusercontent.com/NanmiCoder/MediaCrawler/main/media_platform/douyin/field.py) · [douyin/login.py](https://raw.githubusercontent.com/NanmiCoder/MediaCrawler/main/media_platform/douyin/login.py) · [config/base_config.py](https://raw.githubusercontent.com/NanmiCoder/MediaCrawler/main/config/base_config.py)
- **DTK v5**（抖音纯 Python 签名）：[`signing/native/abogus.py`](https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/signing/native/abogus.py) · [`signing/native/websign.py`](https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/signing/native/websign.py) · [`signing/protection.py`](https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/signing/protection.py) · [`signing/registry.py`](https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/signing/registry.py) · [README](https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/README.md)
- [Cloxl/xhshow (PyPI 元数据)](https://pypi.org/pypi/xhshow/json) · [ReaJason/xhs core.py](https://raw.githubusercontent.com/ReaJason/xhs/master/xhs/core.py) · [xhs/help.py](https://raw.githubusercontent.com/ReaJason/xhs/master/xhs/help.py)
- [Spider_XHS params.py](https://raw.githubusercontent.com/cv-cat/Spider_XHS/master/xhs_utils/xhs_pc/params.py) · [DouYin_Spider login_api.py](https://raw.githubusercontent.com/cv-cat/DouYin_Spider/master/dy_apis/login_api.py)
- [mafqla/douyin-api user-api.md](https://raw.githubusercontent.com/mafqla/douyin-api/main/docs/user-api.md) · [sign_reverse_findings.md](https://raw.githubusercontent.com/mafqla/douyin-api/main/docs/sign_reverse_findings.md) · [REVERSE_GUIDE.md](https://raw.githubusercontent.com/mafqla/douyin-api/main/docs/REVERSE_GUIDE.md)
- [TikTokDownloader README](https://raw.githubusercontent.com/JoeanAmier/TikTokDownloader/master/README.md) · [XHS-Downloader README](https://raw.githubusercontent.com/JoeanAmier/XHS-Downloader/master/README.md) · [xiaohongshu-mcp README](https://raw.githubusercontent.com/xpzouying/xiaohongshu-mcp/main/README.md)
- [抖音 robots.txt](https://www.douyin.com/robots.txt) · [小红书 robots.txt](https://www.xiaohongshu.com/robots.txt)
- 本项目源码：`app/services/platforms/{base,weibo,registry}.py`、`app/services/scheduler.py`、`app/models/vtuber.py`、`frontend/src-tauri/src/lib.rs`、`frontend/src/utils/postTypes.ts`

**合规 / 协议原文 / 官方平台**
- [《小红书用户服务协议》全文（2025-12-08 更新）](https://www.elawcn.com/agreement/2026/0301/1751.html)
  —— §3.4（不得"复制、读取、采用、**统计**"）· §4.1 平台使用规范（禁反向工程 / 非法抓取 / 非授权第三方软件）
- [抖音开放平台 · 用户类型及权限说明](https://developer.open-douyin.com/docs/resource/zh-CN/developer/introduction/type-and-permission) · [小红书开放平台](https://open.xiaohongshu.com/)（§6.3 "官方路径"取证）

**逆向分析 / 风控实证**
- [hanzheng1954/douyin-abogus-analysis](https://github.com/hanzheng1954/douyin-abogus-analysis)（SM3 盐、180 字符、Node 21+ 坑）
- [看雪《某书 X-s 签名逆向分析》](https://bbs.kanxue.com/thread-289656-1.htm)（行为计数器、77ms 阈值）
- [小红书 xsec_token 过期与恢复](https://dev.to/mian_po_0ae30e900c601c8f5/why-xiaohongshu-xsectoken-links-expire-and-how-to-recover-21ko)
- MediaCrawler Issues：[#668](https://github.com/NanmiCoder/MediaCrawler/issues/668) · [#915](https://github.com/NanmiCoder/MediaCrawler/issues/915)（封号反馈）
- [bivex/douyin_feed](https://raw.githubusercontent.com/bivex/douyin_feed/main/README.md)（无登录可用面、地理封锁）

**司法**
- [刷宝 APP 案（（2021）京 73 民终 1011 号）](https://www.zhongliaolvshi.com/jingpinanli/788.html)
- [小红书抓取售卖案（判赔 110 万）](https://finance.sina.cn/tech/2025-10-25/detail-infvaiqr5229335.d.html)
- [福建「固乔」案（改 MD5 构成不正当竞争）](https://www.thepaper.cn/newsDetail_forward_33043279)
