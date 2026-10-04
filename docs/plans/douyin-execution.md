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

### D2 适配器 + 四类响应 + 身份级限速（1.5 天）
1. `app/services/platforms/douyin.py`<!-- 未建 -->（照 `PLATFORMS.md §3` 的骨架）：
   - **身份两段式**：`unique_id`(可变抖音号) / `sec_user_id` → `sec_user_id`
     （经 `profile/other`，它同时返回 `uid` 与 `sec_uid`；`unique_id` 走搜索，**要登录**）；
   - `fetch_post_page`：**cursor 语义**（`max_cursor`），`has_more` 是整数 `1/0` 不是布尔；
   - `enrich`：`aweme/detail`（要 `aweme_id` + `uifid` + `verifyFp`）；
   - **`aweme_id` 全程字符串**（19 位 > 2^53 ⇒ 中途转 Number 会静默丢精度）；
   - **四类响应**（`ok` / `business_error` / `risk_control` / `network_error`）接到
     `identity_limit`：⚠️ 抖音对**不存在的帖子**返回 `200 + aweme_detail: null`，**恰好长得像风控**
     —— 业务失败**不许**冷却身份、**不许**计入熔断；
   - 403 根因表（§3.6）落成 `last_error.kind`：`cookie_invalid` / `signature_invalid` /
     `argus_missing` / `risk_control`（四者可区分，否则线上没法排查）。
2. `registry` 注册 + `capabilities`（`FEATURES` 一条 + `_login_states` + `content_fetch_allowed`
   分支，闸门口径与小红书一致：**没配 cookie 就不发请求**）+ `_login_states` 的
   `frontend/src/utils/platformLogin.ts` 登录 Tab。
3. **判据**：适配器单测（httpx mock：字段映射 / cursor 传递 / `has_more` 1-0 / 字符串 id 不变形）
   + **对照用例**："不存在的帖子 ⇒ business_error，身份健康度不变"（这条是 §5.3.1 点名的坑）。

### D3 固化 / 媒体 / 前端 / 壳层（1 天）
1. **媒体固化自动生效**（`assets`/`media_pin` 是平台无关的：按 `body_json` 里的图/视频 URL 走）——
   只需把抖音图床域名加进 `IMG_PROXY_ALLOWED_HOSTS` 与 CSP `img-src`；
2. 视频走 `/video-proxy` 的 host 白名单（`douyinvod.com` 等），**不做**抖音播放内核（不在本方案）；
3. 前端：`PLATFORM_LABEL` / `typeGroupsFor` / `accountHomeUrl`、添加账号弹窗、登录卡（粘贴 cookie，
   与小红书同款）、`frontend/src-tauri/src/lib.rs` 的 `EXTERNAL_HOSTS` 加 `douyin.com` 等；
4. **默认总开关关着**（设置里 `DOUYIN_ENABLED=False`）：与"风险自担"一致的保守默认，
   用户显式打开才抓。

### D4 收尾（0.5 天）
真机端到端一次（一个存量 V 的抖音账号：抓一页 → 落库 → 图片固化 → 详情页能看），
文档（`PLATFORMS` §3 改成"已落地"、`ASSETS`、`HTTP-CONTRACT`、`PERF` 基线）+ devlog。

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
