---
doc: plans/douyin-execution
class: plan
scope: 抖音（Douyin）抓取的执行方案：合规定性 → 身份/签名 spike → 适配器（含四类响应与身份级限速）→ 固化与前端壳层接线
not-scope: 小红书已落地的三刀（`devlog/230`–`240`）；直播/弹幕（调研 §3.8 只作概览）；评论/收藏/合集/关注等非主链接口；任何"热词/搜索量/点击率"类指标（调研 §6.5 第 2 条明确不做）
expires: 2027-01-31
---

# 执行方案：抖音抓取（D0–D4）

> ## §0 定性 —— **先读这一节，它优先于下面全部技术内容**
>
> 来源：`docs/design/xhs-douyin-research.md` §6（2026-09-27 用户亲自纠正过口径的那一节）。
>
> - 抖音《用户服务协议》（更新 2026-02-13）：**§5.1** 禁止用任何**自动化程序**接入/收集；
>   **§5.2(9)** 禁止反向工程；**§5.3(4)** 禁止以**爬虫抓取**获取内容；**§5.3(6)** 禁止用于
>   统计热词/命中率/搜索量/点击率/阅读量。
> - ⇒ **不存在"允许的额度"**：抓 1 条与抓 100 万条**都是违约**（"规模"只影响**后果多重**，
>   不影响**允许与否**）。官方开放平台**也没有**"抓任意第三方 V 的帖子"这个能力
>   （授权范围只有"自己账号/已授权内容"）⇒ 这件事在官方路径下**没有路**。
> - ⇒ 风险**直接落在用户自己的账号上**：调研 §3.6 已技术性印证，风控打的是
>   `uifid` + `s_v_web_id` **同源绑定**的会话（封号/限流是平台单方即可执行的，不需要打官司）。
>
> **三种立场（本方案只在 C 之下执行）**：
>
> | | 内容 | 代价 |
> |---|---|---|
> | A | 不做 | 零新增合规暴露 |
> | B | 只做官方授权范围 | 拿不到"抓任意 V"这个能力 ⇒ 实质等于 A |
> | **C** | **做，但把定性如实告知用户、风险自担，并做降险三条** | 工具承担"帮助违约"的位置 |
>
> ### ✅ 拍板记录（2026-10-04）
>
> 用户在本方案评审时明确选择 **C**：在**已知这是违反平台协议的行为**、且**风险由自己承担**的前提下
> 继续做抖音抓取。降险三条一并采纳（不做热词/搜索量类指标；不把原始媒体再分发；
> 采集身份由用户自己知情提供、且默认总开关是关的）。此后本方案按 D0→D4 执行，
> 任一停止条件触发即停下来报告。
>
> **降险三条（降险 ≠ 合规，不改变定性）**：① 不做"热词/搜索量/点击率"类指标；
> ② 不把原始媒体再分发（本工具本来只存本地）；③ **绝不把用户账号当采集器**——
> 采集用的身份必须是**用户自己知情并愿意承担风险**的那一份，且产品层要如实告知。

## 一、技术选型：**C 混合**（浏览器只"铸身份"，签名在本地做）

调研 §1.1 的结论，落地形状：

```
身份层（浏览器，低频、可缓存）
   └─ 铸 cookie 包：uifid / s_v_web_id / msToken / ttwid …
      ⚠️ 同源硬要求：uifid 与 s_v_web_id 必须来自同一浏览器会话，自造 ⇒ 403 Signature Not Found
签名层（本地，每次请求）
   └─ a_bogus（bdms 算法，参考 DTK v5 的纯 Python 复刻，Apache-2.0）
      + x-secsdk-web-signature（md5(uifid_timestamp_SALT_query)）
      + x-tt-argus 头（当前网关不校验取值）
      ⚠️ 顺序硬要求：先 a_bogus（URL 不含 secsdk 三参数），再由 secsdk 追加那三个
请求层（httpx，复用 `app/core/http.py`）
风控层（现有 `identity_limit.py`：粒度 (身份, 端点)，四类响应）
```

**必须承认的维护负担**：`a_bogus` 是字节码 VM 的复刻，**抖音改版即失效**。
⇒ 按 DTK v5 的**影子比对**思路做可见化（本地签 vs 浏览器签结构化比对；比不出来视为"未比对"，
**绝不禁用本地路径**；任何降级都要**出声**）。这一条与仓库既有的"静默降级 = 坏了也看不出来"
是同一类坑，见 `docs/ARCHITECTURE-IMPROVEMENT-EXECUTION.md`。

## 二、分批

### D0 拍板与凭据（人工，0.5 小时）
1. 用户**明确**选择 C（否则本方案不执行）；
2. 用户提供一份浏览器 cookie 包（`uifid`/`s_v_web_id`/`msToken`/`ttwid`，**同源**）；
3. 定节流口径（默认：**单身份 ≤0.12 req/s、串行、静默时段生效**，见调研 §5.3.1）。

### D1 签名 spike（半天，**能停就停**）
1. 在 `%TEMP%` 里对 `/aweme/v1/web/aweme/post/` 发**一发**（`sec_user_id` 用测试账号）；
2. **判据（正面）**：HTTP 200 + `status_code=0` + `aweme_list` 里有条目；
3. **判据（反面，证明这套判据有牙口）**：分别去掉 `a_bogus` / secsdk 三件套 / `x-tt-argus` /
   把 `verifyFp` 换成自造值，各得一个**具体 403**，且与调研 §3.6 的根因表逐条对上；
4. 产出：一份 spike 记录（真机响应片段 + 结论），**不改仓库代码**。

> ### ✅ D1 结果（2026-10-04 真机，`devlog/333`）—— **判据的症状写错了，按实测改**
>
> 14 个请求（登录 jar 6 + 游客 jar 8，间隔 12s，无验证码/无 403/无限流）：
>
> - **正面达成**：本地纯 Python 签名拿到完整载荷（20 条、`status_code=0`、`has_more=1`）；
>   浏览器真造的 `a_bogus` 也通过我们的结构解码器 ⇒ 签名层可用、格式正确；
> - **反面达成，但症状不是 403**：**游客**身份下 `a_bogus` **缺失或值写错** ⇒ **200 + 0 字节空体**；
>   相位 3 的"值改一位"把"要参数"与"要值"分开了 ⇒ 判据有牙口；
> - **登录 jar 走免签通道**：删 `a_bogus`、删 secsdk、删 `x-tt-argus`、`verifyFp` 换自造值，四例全 200
>   且载荷逐条相同 ⇒ **宽松是平台当下的选择，不是契约**；代码里**不许**依赖它，也不许"签名失败就跳过"；
> - **secsdk / `x-tt-argus` / `msToken` 都不是必需**（游客下只留 `a_bogus` 即可）；`detail` 连游客都不校验；
> - **登录与游客拿到的不是同一页**（首条 id 与 `max_cursor` 都不同）⇒ D2 的翻页判据要用**去重后的全集**，
>   不能用"条数相同"。
>
> ⇒ **D2 第 1 条的四类响应按此收紧**：`ok` = `status_code=0` **且** `aweme_list` 非空；
> **`200 + 空体`归 `signature_invalid`/`risk_control`**，绝不许当成"这个 V 没作品"（调研 §四-5 的形态，已有实证）。

### D2 适配器 + 四类响应 + 身份级限速（1.5 天）1. `app/services/platforms/douyin.py`<!-- 未建 -->（照 `PLATFORMS.md §3` 的骨架）：
   - **身份两段式**：`unique_id`(可变抖音号) / `sec_user_id` → `sec_user_id`
     （经 `profile/other`，它同时返回 `uid` 与 `sec_uid`；`unique_id` 走搜索，**要登录**）；
   - `fetch_post_page`：**cursor 语义**（`max_cursor`），`has_more` 是整数 `1/0` 不是布尔；
   - `enrich`：`aweme/detail`（要 `aweme_id` + `uifid` + `verifyFp`）；
   - **`aweme_id` 全程字符串**（19 位 > 2^53 ⇒ 中途转 Number 会静默丢精度）；
   - **四类响应**（`ok` / `business_error` / `risk_control` / `network_error`）接到
     `identity_limit`：⚠️ 抖音对**不存在的帖子**返回 `200 + aweme_detail: null`，**恰好长得像风控**
     —— 业务失败**不许**冷却身份、**不许**计入熔断；
     ⚠️ **反过来也要防**（D1 实测，见上）：**签名无效的样子是 `200 + 空体`**（不是 403）
     ⇒ 空 `aweme_list` / 0 字节响应必须归 `risk_control`，**不许**归 `business_error`，
     更不许当成"这个 V 没作品"；
   - 403 根因表（§3.6）落成 `last_error.kind`：`cookie_invalid` / `signature_invalid` /
     `argus_missing` / `risk_control`（四者可区分，否则线上没法排查）。
2. `registry` 注册 + `capabilities`（`FEATURES` 一条 + `_login_states` + `content_fetch_allowed`
   分支，闸门口径与小红书一致：**没配 cookie 就不发请求**）+ `_login_states` 的
   `frontend/src/utils/platformLogin.ts` 登录 Tab。
3. **判据**：适配器单测（httpx mock：字段映射 / cursor 传递 / `has_more` 1-0 / 字符串 id 不变形）
   + **对照用例**："不存在的帖子 ⇒ business_error，身份健康度不变"（这条是 §5.3.1 点名的坑）。

> ### ✅ D2 结果（2026-10-04，`devlog/334`）
>
> `platforms/douyin.py` + `signing.py::DouyinSigner` + **vendored 签名**（`platforms/vendor/dtksign/`，
> Apache-2.0，blob SHA 比对 + 只改一行 import + sha256 判据）+ `douyin_auth.py` +
> 路由 `POST /auth/douyin/cookie` + capabilities 四家化 + 前端（登录 Tab 收 UA、
> 平台名/分组/主页链接、添加账号与收录按钮）**都已落地**；`pytest` 1147 全绿、`vitest` 941 全绿。
>
> **与计划的偏差（三处，都是被真机/框架逼出来的）**：
>
> 1. **四类响应的判据照 D1 收紧**：`ok` = `status_code=0` **且**结构在；**200 + 空体 ⇒
>    `signature_invalid`**（不是 ok、不是 business_error）；`aweme_detail: null` ⇒ `not_found`
>    ⇒ 业务失败**不冷却身份**（与 DTK 不同：它把空 `aweme_detail` 判风控 —— 见 `douyin.py` 注释）。
> 2. **端点名必须带平台特征**：`ENDPOINT_RATE` 的键是**全局**的 ⇒ 抖音从
>    `detail` 改成 `aweme_detail`（`detail` 是 B 站详情抓取在用的名字，撞上就把 B 站限速了；
>    已立为不变量 38 + 一条两两不相交的判据）。
> 3. **`unique_id`（抖音号）本刀没接**：它要搜索接口（要登录 + 签名），
>    D1 没验证过任何搜索端点 ⇒ 认不出输入形态时**响亮失败**（`unsupported_input` +
>    一句"粘主页链接"），不猜、不静默播别人的号。要接它得先补一次 spike（endpoint + 参数 + 403 形态）。
> 4. **发请求前的结构自检要分级，不能当硬闸门**：`structure_error` 对**自己刚签出来的**签名
>    有约 **1/300** 的误报（解码器的已知歧义）⇒ "这根本不是签名"才硬停，其余重签几次后照发 +
>    warning（平台才是权威）。当硬闸门就是每 300 次静默少发一发（本批自己踩的坑，`devlog/334` §三之二）。
>
> 另外**把 D3 的两件事提前做了**（它们的判据是红的，不做就没法提交）：
> `IMG_PROXY_ALLOWED_HOSTS` + CSP `img-src` 补抖音图床（`douyinpic.com` / `douyinstatic.com`）
> 与逐条用例。**剩下真属 D3/D4 的**：媒体固化实测、`/video-proxy` 的 `douyinvod.com` 白名单、
> `EXTERNAL_HOSTS`、`DOUYIN_ENABLED` 默认关、真机端到端。

### D3 固化 / 媒体 / 前端 / 壳层（1 天）

1. **媒体固化自动生效**（`assets`/`media_pin` 是平台无关的：按 `body_json` 里的图/视频 URL 走）——
   ✅ 图床域名与 CSP 已随 D2 落地；**待做**：真机上验一次固化链路；
2. 视频走 `/video-proxy` 的 host 白名单（`douyinvod.com` 等），**不做**抖音播放内核（不在本方案）；
3. 前端：`PLATFORM_LABEL` / `typeGroupsFor` / `accountHomeUrl`、添加账号弹窗、登录卡（粘贴 cookie，
   与小红书同款）✅ **已随 D2 落地**；**待做**：`frontend/src-tauri/src/lib.rs` 的 `EXTERNAL_HOSTS`
   加 `douyin.com` 等；
4. **默认总开关关着**（设置里 `DOUYIN_ENABLED=False`）：与"风险自担"一致的保守默认，
   用户显式打开才抓。**待做**（当前只要配了 cookie 就会抓 —— 这一步是 D3 的收口）。

### D4 收尾（0.5 天）
真机端到端一次（一个存量 V 的抖音账号：抓一页 → 落库 → 图片固化 → 详情页能看），
文档（`PLATFORMS` §3 改成"已落地"、`ASSETS`、`HTTP-CONTRACT`、`PERF` 基线）+ devlog。

> ### ✅ D3 结果（2026-10-04，`devlog/335`）
>
> 1. **媒体链路三处一起改**：`IMG_PROXY_ALLOWED_HOSTS` + CSP `img-src`（D2 已做）+
>    `/video-proxy` 的 `ALLOWED_HOSTS`/`HOST_POLICY` 加 `douyinvod.com`；Rust 侧
>    `EXTERNAL_HOSTS` 加 `douyin.com`。⚠️ 抖音视频那条 `HOST_POLICY`（带不带站内 Referer）
>    **是猜的、没实测** —— 写在代码注释与用例里，真机若播不了先换成 `{}` 再试。
> 2. **总开关落地**：`DOUYIN_ENABLED`（默认 **False**，可热更）+ 适配器 `_admit` 硬闸
>    （关着一个字节都不发）+ `capabilities` 闸门与两态说明（"没配 Cookie" vs "开关没开"）。
> 3. **顺手修了一处存量漂移**：设置导航自 `devlog/319`（媒体固化独立成组）起实际是 **5 项**，
>    而 `ui_probe --app-settings` 与 README/UI-MAP/GLOSSARY 还写着 4 项 ⇒ 那个探针模式
>    **自那时起一直是红的**（`gate --tier a` 只跑默认模式的 ui_probe，没覆盖到）。三处文档 + 探针已同批改正。
> 4. **两个静默契约坑**（见 `devlog/335` §二）：`body_json` 的视频形状与顶层 `duration_sec`
>    —— 写错既不报错也不破图，只是"视频永远不固化、卡片没有时长"。已补一条**直接调
>    `assets._media_urls`** 的判据。
>
> **仍属 D4 的**：真机端到端一次（含**图片固化**与**详情页渲染**）、抖音视频能否播放
> （上面那条 Referer 策略）、`PERF` 基线、以及用户侧动作（配 cookie + UA、打开总开关）。

> ### ✅ D4 结果（2026-10-05 真机，`devlog/336`）
>
> 两个脚本、**同一个临时数据目录**（`%TEMP%\ddt-d4`，你的开发库一个字节没动）、凭据只走子进程环境变量：
>
> | 验到的事 | 实测 |
> |---|---|
> | 开关**关着**时抓取被闸门挡住 | `POST /vtuber/fetch-posts?platform=douyin` → **403**，理由指到「设置 → 数据源 → 平台抓取」|
> | 打开总开关（热更、不重启） | `PUT /settings {"DOUYIN_ENABLED": true}` → capabilities 立刻 `douyin_enabled=True`、抖音内容不再受限 |
> | **收录**该账号（真发一次主页信息） | `POST /vtuber/adopt`(source=douyin) → **201**，名字来自服务端「Sulli」，0.6s |
> | 首屏抓取落库 | 2 条（`FIRST_SCREEN_DYNAMICS_LIMIT` **按设计**只入库最新几条）|
> | 字段与形状 | 首条 `#7692759522204795110` type=image；`body_json` 是共享契约形状；`published_at` naive UTC |
> | **图片固化** | 2/2 条有本地副本，共 4 张；`/settings/assets` 的 `post_image` rows=4 files=4 **1.16MB** |
> | **详情页能看** | `GET /static/assets/post_image/p1_543169b3.webp` → **200 image/webp 616KB**；两个帖子读取端点都 200 |
> | **一页 20 条**（适配器层补一刀） | 20 条、`has_more=True`、游标 `1789041422000`、类型 `{图文 7, 视频 13}`、id 全字符串、20/20 有封面、时间全解析 |
>
> **两条如实说明**：
> ① 端到端那条走的是**收录首屏**路径（`limit_latest`），所以"落了 2 条"是设计，不是抓取失败；
> 增量语义（`stop_on_existing`）又让"再抓一次"天然 0 新增 ⇒ **"一页 20 条"改在适配器层单独验**（1 个请求）。
> ② 日志里那句 `[douyin] 账号 Sulli … 0 成功, 1 失败` 是**自节流**：收录后台紧接着又问了一次账号信息，
> 而 `user_profile` 的令牌桶（0.2/s）刚被上一次花掉 ⇒ 我们没发请求。平台什么都没说。
> 已作为一条小修进 `docs/TODO.md` §1（`identity_limit.throttled` 只接在帖子循环上）。
>
> **抖音视频已补验（2026-10-05 真机，`devlog/336` §六）**：`play_addr` 的两条 douyinvod 镜像里，
> `v26-web` **裸请求与只带 UA 都 403**、带站内 Referer 才 206；`v11-weba` 三种都 206 ⇒ **保留站内 Referer**；
> 第三条镜像是 `www.douyin.com/aweme/v1/play/` 的 **302 跳板**，**故意不进白名单**（真 CDN 已在里面）。
> 经 `/video-proxy` 实测 **206 video/mp4**（Range 直通）。
>
> ### ✅ 用户真机（**你自己的数据目录**）后续（2026-10-05，`devlog/337`–`338`）
>
> 你在自己的库里配好 cookie + UA 后报了两件事：① 粘完 Cookie 仍显示「受限胶囊 / 抖音未登录」；
> ② 账号信息与首次收录首屏都抓不到数据。现场查证：
>
> | 问题 | 真因 | 处置 |
> |---|---|---|
> | ② 抓不到数据 | **总开关从来没开过**：`.env` 里 cookie/UA 都在（说明粘贴成功），而 `app_meta` 里**没有** `settings.DOUYIN_ENABLED` ⇒ 用默认 `False`，日志逐轮写着「总开关关着，本次不发请求」 | 不是 bug（`devlog/335` 定的合规闸门）；**要在「设置 → 数据源 → 平台抓取」显式打开**，之后下一轮就会填上 |
> | ① 角标说"需要登录" | 能力矩阵把"我们自己关了"报成了 `requires_login`（**对的文案配错的状态**）⇒ 刚粘完 Cookie 的用户必然以为没生效 | 新增第四态 `disabled` + 角标「**未启用**」；受限项全是 `disabled` 时页脚不给「去登录」；两条保存路径补 `refreshCapabilities()`（`devlog/338`） |
>
> **仍然只差你侧两个动作**：配 cookie + UA（已完成）、**打开抖音总开关**（未做）。
> ⚠️ 打开开关后 `/capabilities` 立刻变（热更、不重启），顶栏那条受限会自动消失。

## 三、判据（每批都要能反向验证）

| 判据 | 反向验证 |
|---|---|
| 签名能过（D1） | 逐个删签名组件 ⇒ 各得一个**具体 403**，与 §3.6 根因表对上 |
| 身份解析两段式 | 只给 `unique_id` 也能落到 `sec_user_id`；给不存在的抖音号 ⇒ `not_found`（不静默播别人的） |
| `aweme_id` 不变形 | 单测断言 19 位串进出相等（中间过一次 JSON 往返） |
| 四类响应 | "不存在的帖子"（200 + `aweme_detail: null`）⇒ `business_error`，身份健康度**不变** |
| 闸门 | 未配 cookie ⇒ **一个请求都不发**（正对照：配上就发） |
| 节流 | 同一身份第二次请求被 `identity_limit` 挡下（0.12 req/s 口径） |
| 固化 | 一页作品抓完 ⇒ 图落 `static/assets/post_image/`，索引行 `kind=post_image` |

## 四、停止条件（**必须停下报告**）

1. D1 一发都过不去，且原因是**签名**（不是 cookie / 不是网络）⇒ 停，只留 spike 记录；
2. 出现**验证码/滑块挑战**（`Verifytype` 之类）⇒ **立即停**——本方案**不绕验证码**；
3. 用户账号出现限流/封禁迹象（`status_code=2483`、内容变空、登录态异常）⇒ 立即停并如实报告；
4. 抖音协议口径变化（§0 引文需重新复核）⇒ 重评定性，再谈技术；
5. 任何"看起来像成功但数据是空的"的形态 ⇒ 按 §3.6 逐条查，**不许**当成"这个 V 没作品"。

## 五、需要用户提供 / 拍板

1. **明确选 C**（本方案的前提）；
2. 一份**同源**的浏览器 cookie 包（`uifid` + `s_v_web_id` + `msToken` + `ttwid`）；
3. 一个用于端到端验收的抖音账号（存量 V 的 `sec_user_id` 或抖音号）；
4. 节流口径是否按默认（单身份 ≤0.12 req/s、串行、静默时段生效）。
