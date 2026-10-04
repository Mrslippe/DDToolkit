---
doc: backend/assets
class: module
scope: 图片代理与本地资产：远端资源固化的设计（稳定键 / 两条摘要 / local_assets 索引 / pin 与清理）、与 img-cache 的边界、契约与派生字段、风险与待拍板，以及文件写入的原子性不变量
not-scope: 前端怎么渲染图片 → frontend/UI-MAP.md；头像/背景的业务规则 → backend/DATA-MODEL.md
sot: app/services/assets.py, app/routers/img_proxy.py, app/services/vtuber_avatars.py, app/services/vtuber_background.py
verify: python -m pytest -q tests/test_assets.py tests/test_cover_assets.py
budget: 700
retire-when: 资产改成对象存储，或不再本地化远端资源
---

## 0. 它要解决的四类问题（都带 2026-09-29 实测证据）

| # | 问题 | 实测证据（2026-09-29，真机数据目录 `%APPDATA%\com.ddtoolkit.app-dev`） |
|---|---|---|
| ① | **远端 URL 会死** | V#16 明前奶绿的 `vtubers.avatar` 是微博签名 URL，`Expires=2026-09-28 04:09`，**已过期 21 小时**；今天还能显示**纯粹靠 `/img-proxy` 磁盘缓存**（命中刷新 mtime，实测 0.1h 前刚命中过）。缓存一清（超 300MB / 7 天没人看 / 手动清 / 键变了）⇒ 破图。微博签名 URL **只有约 3 小时有效期**（账号现值那条 `Expires=04:11`，抓取发生在 01:11）⇒ 选中的微博头像**天生带定时炸弹** |
| ② | **同一张图有多个 URL** | `weibo_7471118487.jpg` 与 `weibo_7471118487_3d2b0b8a.jpg` **sha256 完全相同**；`weibo_7198559139.jpg` 与 `weibo_7198559139_331ed204.jpg` 同样（微博每次抓取换签名 ⇒ 新 URL）。⇒ 重复存储、抓取重复下载，R47 的账本还会把它当**两个版本** |
| ③ | **"用户选过的"没有锚点** | R47 的账本只记**抓取看到的**平台头像。用户 2026-09-29 01:09 在设置里点了一下，`vtubers.avatar` 被覆盖 ⇒ 上一次的选择（`d437fd…`，珍珠项链那张）从库里消失，只剩迁移前备份 `backups/vtuber-f008-20260929-010823.db` 里还留着它的 URL |
| ④ | **看一次就要回源一次** | 帖子封面 `cover_url` 是远端 URL，列表渲染走 `ProxyImage`（直连 → `/img-proxy` → 占位）。缓存被淘汰、离线、或源站防盗链 ⇒ 回源或占位；**离线时整列封面都画不出来** |

---

## 1. 非目标（明确不做，避免范围蔓延）

1. **不做整站离线镜像**：只固化"轻"资源（单文件小、数量可控），不固化视频/正文大包；
2. **不合并 `static/img-cache/`**（两者职责不同，见 §3.5）；
3. **不改抓取频率纪律**（R6/R10 的名单口径与间隔不动）：固化走**独立限速**，不许打乱一轮的节奏；
4. **不动 `vtubers.avatar` 的语义**（它仍是「账号 `avatar_url` 原文」）：本地兜底走**派生字段**，
   不给同一个字段塞两种形状（那是 R46 那类事故的温床）；
5. **不引入新依赖**（`hashlib` / `sqlite3` / 现有 httpx 客户端足够）。

---

## 2. 核心设计：一个稳定键 + 两条摘要 + 一份索引

### 2.1 稳定键（`key`）= 去掉签名参数的 URL

微博头像形如
`https://tvax4.sinaimg.cn/crop.../007Raq4zly8ie7sqgq4gzj30u00u0myr.jpg?KID=imgbed,tva&Expires=1790626282&ssig=VUya3ZaCVG`
—— **同一张图每次抓取都是新 URL**（只有 `Expires`/`ssig` 变）。

⇒ `key` = **丢掉 `Expires` / `ssig` / `KID` / `sign` 这类签名参数后的 URL**（保留 path 与业务参数），
**索引、去重、查盘全按 `key`**；原始 URL 另存一列 `url`（回源与展示用）。

**查找顺序**：`(kind, key)` 命中 ⇒ **直接用本地文件，不发请求**；
未命中 ⇒ 下载 → 入库（记 `key` / `url` / `path` / `bytes` / `sha256`）。

⚠️ **取舍（写清楚，别当它没代价）**：`key` 命中就**不重新下载** —— 万一平台"换了图但没换文件名"，
我们会一直用旧图。理由与依据：**实测**微博/B站换图都**会换文件名**（两次同 sha256 的样本正好反证
"URL 变了但图没变"才是常态）；且这条规则换来的是"每轮抓取零图片请求"。留一个口子：
`prune_assets --verify`（或设置页的"重新校验"）可按 7 天一次的节流强制回源核对。

### 2.2 文件名 = **URL 摘要**（可预测），内容摘要另存

- 文件名：`static/assets/{kind}/{key_short}_{sha1(key)[:8]}{ext}`（头像沿用 R47 已上线的
  `{platform}_{uid}_{sha1(url)[:8]}{ext}` 形态，只是换到新目录/新前缀规则）；
  **可预测**是关键 —— 下载**之前**就能算出该看哪个文件，这才叫"少发请求"；
- `sha256(字节)` 另存一列：用于**去重**（②）与**校验**（索引说有、盘上被改过）。

> 为什么不直接用内容摘要当文件名：内容摘要要**下完才知道** ⇒ 每次都得先发请求，
> 恰好废掉本模块的主要收益。两者都要：URL 摘要负责"预检"，内容摘要负责"去重与校验"。

### 2.3 索引表 `local_assets`（迁移 `f009`，只建表）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER | PK |
| `kind` | TEXT | `avatar` / `cover` / …（模块化扩展点） |
| `key` | TEXT | **稳定键**（§2.1），索引与去重都按它 |
| `url` | TEXT | 最近一次见到的**完整** URL（含签名，回源用） |
| `path` | TEXT | `static/` 相对路径（与 `avatar_path` / `background_path` 同款口径） |
| `ext` / `bytes` | TEXT / INTEGER | 文件元信息（统计与清理用） |
| `sha256` | TEXT | 内容摘要（去重、校验） |
| `pinned` | INTEGER | 1 = **永不清理**（用户选过的头像 / 手动 pin） |
| `created_at` / `last_used_at` | DATETIME | `created_at` 决定"最旧"，`last_used_at` 决定 LRU |

约束与索引：**UNIQUE(kind, key)**、`INDEX(kind, sha256)`、`INDEX(kind, pinned)`。
⚠️ **不挂 `vtubers` / `accounts` 外键** ⇒ 不进 `purge.py` 的清单；但**引用关系必须显式可查**（§5.3）。

### 2.4 服务层 `app/services/assets.py`（唯一入口）

```python
get(kind, url) -> Asset | None          # 命中（key 或完整 url）且文件在盘 ⇒ 返回；否则 None
put(kind, url, data, ext) -> Asset      # 落盘 + 入库（原子写：临时文件 → rename）
remember(kind, url, path) -> Asset      # 只登记不下载（历史遗留文件、随包资源）
pin(kind, url, on=True) -> Asset        # 长留标记
stats(kind=None) -> dict                # 文件数 / 字节 / 命中率（给设置页与诊断）
prune(kind, max_bytes, dry_run=True)    # 按 LRU 淘汰**未 pin 且未被引用**的
```
判据：`get()` 命中时**不许**发生任何网络请求（用例用计数器钉住）。

### 2.5 与 `img-cache` 的边界（写死，防止以后混用）

| | `static/img-cache/`（现有） | `static/assets/`（本模块） |
|---|---|---|
| 是什么 | **任意远端图的临时缓存**（看一眼就够） | **认定的长期资源**（不能丢） |
| 键 | `md5(完整 URL)`（含签名 ⇒ 签名一换就是新键） | `kind + 稳定键`（跨签名同一份） |
| 失效 | 7 天 TTL + 300MB，命中刷新 mtime（近似 LRU），可随时清 | 只按 pin / LRU / 上限淘汰；被引用的不许清 |
| 判据 | **清空它，应用外观不变** | 清它**会**破图（所以它有索引与保护） |

---

## 3. 契约（只加一个派生字段 + 一个端点组）

### 3.1 `VTuberOut` 加**只读派生**字段 `avatar_local`

```jsonc
{ "avatar": "https://i2.hdslb.com/.../675fb12...jpg",   // 不动：仍是远端原文
  "avatar_local": "static/assets/avatar/bilibili_434334701_9e386b46.jpg" }  // 新：本地兜底（查 assets）
```
- **不加库列**：`avatar_local` 由 `services/assets.get(kind='avatar', url=vtubers.avatar)` 现查现给；
- 前端 `resolveAvatar()` 的返回从 `string` 变成 `{ src, local }`，`ProxyImage` 增加可选
  **`fallbackSrc`**，回落链变成：直连 → `/img-proxy` → **本地文件** → 占位。
  ⇒ URL 死了但盘上有 ⇒ **永远画得出来**（①彻底闭环）。

### 3.2 `GET /assets/stats` + `POST /assets/prune` + `POST /assets/pin`

给设置页与诊断用（`prune` 必须支持 `dry_run`，先看要删什么再真删）。

### 3.3 `PostOut` 加 `cover_local`（列表一次查完）

后端分页查询里 **left join `local_assets`** 带出 `cover_local`，**不让前端逐行查**（N+1）。
渲染优先级与头像**相反**：**本地优先**，远端着 `fallbackSrc` —— 因为封面是我们主动固化的，
而远端反而常被防盗链拦。

### 3.4 正文媒体：`images_local` / `video_local`（2026-10-04，devlog/319）

同一套路，但**一个帖子有多份**：`images_local` 与 `body_json.images` **同序同长**
（没有副本的位置是空串，前端按**索引**对齐，不靠 URL 匹配）；`video_local` 是那条视频的副本。
键在 Python 侧算、一次 `lookup_keys` 查完全页（判据 `tests/test_media_pin.py` 的语句计数那条）。

正文媒体用两个新 kind：`post_image` / `post_video`（`KINDS` 里加了它们，
`/settings/assets` 的读数与设置页的"清理未使用"自动覆盖到）。两条与封面**不同**的口径：

- **保护名单 = 未归档帖引用的媒体**（`_referenced_keys`）⇒ 帖子一归档就失去保护；
- 于是"**归档后自动移除**"不需要新写清理器：`prune(kind, max_bytes=0)` 的语义就是
  "清空未 pin 且未被引用的"（`services/media_pin.clean_archived` 只是加上开关与报告）；
- 默认容量上限是 `None`（不限）—— 回收靠"归档就清"，不是靠容量 LRU。

**本地没有副本时怎么办：打开时重取（2026-10-04，`devlog/320`，`docs/backend/HTTP-CONTRACT.md` §帖子）**

图床 URL 是平台**限时签发**的（`docs/GLOSSARY.md` 那条实测），盘上没副本就只能回源重签：
`POST /posts/{post_id}/refresh-media` 走平台自己的详情补全（`BasePlatform.enrich`），
**只写回媒体相关的列**（`cover_url`/`body_json`/`raw_json`/`stats_json`）并顺手固化一次；
未登录 403 / 没详情 409 / 同帖 30s 内 429 / 上游失败 502，全部如实分类。
前端在 `ProxyImage` **四级全失败**时回调一次（一帖只调一次 `refreshedRef`），用回来的整帖就地替换；
重取失败**要在界面上说一句**（后端 403 的原文就是"去哪儿配 Cookie"，只写日志等于让用户对着灰块猜）。

⚠️ **三条容易踩的**：① 重取与固化**都不许**碰 `title`/`published_at`（列表顺序不因重取而变，
用例钉住）；② `ProxyImage` 的四级状态在组件内 ⇒ 调用方必须把图源写进 `key`（`url + local`、
封面 `cover_url`），否则新地址/新副本进不到那个已停在 `failed` 的实例（同样有反向验证过的用例）；
③ `pin_post_media` 对**已归档**帖直接返回不下载（保护名单只认未归档帖 ⇒ 下完就被归档清理删掉）。

---

## 4. 头像这条链怎么接（C 的落地形态）

| 环节 | 改动 |
|---|---|
| 写入 | `scheduler._download_avatar` → `assets.put(kind='avatar', …)`（R47 的 V 版本化命名退役给 assets 的命名规则） |
| 记账 | `services/vtuber_avatars.record_avatar_version` 改成**按稳定键归并**：稳定键已存在 ⇒ 只 touch `last_seen_at`，不再插新行 ⇒ ②里的"一张图两个版本"消失 |
| 选择 | `PUT /vtuber/{id}` 收到 `avatar=<url>` ⇒ 顺手 `assets.get('avatar', url)`；命中就把该资产 **`pin=True`**（用户选过 = 永不清理），并让响应带上 `avatar_local` |
| 渲染 | §3.1 的 `fallbackSrc` |
| 回填 | L1 里把**本次丢失的那条**（`d437fd…` / `static/avatars/434334701.jpg`）补进账本并 pin —— 这次事故的收尾 |

---

> **批次与判据**（L0–L4 的切分、每批判据、落地状态）→ `docs/plans/light-assets-execution.md`；
> 本节不复述那张表。

## 6. 风险（按严重度）

1. **磁盘增长**：数据目录 2026-09-29 实测 53MB 库 + 35MB 缓存；固化未归档帖封面会**显著**增长
   ⇒ 必须有**每 kind 上限 + 可见读数**，默认保守（头像全留不限；封面默认 1GB、LRU 淘汰未 pin 的）。
   ⚠️ **L3 实测（devlog/261）**：本机 214 条未归档封面固化后 **220 MB（平均 1.1 MB/张，最坏 4.7 MB）**
   ⇒ 1GB 默认上限**只够约 900 张**；每轮的**字节上限（24MB）与条数上限（20）两条都要**。
2. **"降低请求频率"的收益别夸大**：浏览器与 `/img-proxy` **本来就有缓存**，所以 L3 的确定性收益是
   **离线可看 + 源站死了也能看 + 代理缓存淘汰后不回源**；"少发请求"的大头只在"同一批列表反复滚动/重开"
   这一种场景。**L3 落地时先量再写结论**（一轮抓取的请求数 vs 固化后的请求数）。
   ⚠️ 本仓老教训：把"看起来会省"写成"会省"就是重构幻觉。
3. **风控**：图片走 CDN（不同域）风险低，但仍**必须限速**（复用平台起跑闸门），且**微博签名只有 3 小时**
   ⇒ 口径是「**抓到就固化**」，不是"以后再说"。
4. **备份与索引不一致**：`backups/*.db` 含索引，`static/` 不进备份 ⇒ 恢复后可能"索引说有、盘上没有"
   ⇒ **预检必须同时查两者**（`_avatar_missing` 的老教训：只查 URL 变化会永远补不下）。
5. **清理必须有引用保护**：被 `vtubers.avatar`（选中的）/ 账本行 / `posts.cover_local` 引用的不许清；
   实现上"选中即 pin + prune 前查引用"两道，缺一条就会破图。
6. **迁移风险低但仍是 A 档**：`f009` 只建表（可回滚）；但要同步 `MIGRATION_HEAD` + 全套活文档。

---

## 7. 待拍板（我给的默认值，你不否就按这个做）

1. **容量上限**：头像 `pinned` 全留不限；封面默认 **1GB**、超出按 LRU 淘汰未 pin 的；`stats` 在设置页可见。
2. **封面固化的范围与节奏**：只固化 **`is_archived=0`** 的帖子封面；**每轮上限 20 张**、
   走独立限速、设置项可关（默认**开**）。
3. **`--verify` 强制回源校验**：默认关，间隔 ≥7 天（防"换了图没换文件名"的极端情况）。

## 资产与文件写入不变量

34. **上传 / 替换文件：先写临时文件、原子 rename、成功之后才删旧的**（M3b，devlog/214）：
    `routers/vtuber.py` 的背景上传原本是「**先删旧文件、再写新文件**」三行 —— 写盘失败
    （磁盘满 / 权限 / 断电）就把用户原来的背景弄丢了，而 DB 里还指着那个不存在的路径
    ⇒ 卡片页背景空白且**无法恢复**。三条一起才成立（真源 `services/vtuber_background.py`）：
    - **限额在"读"的时候生效**：按块读、超限立刻停；`UploadFile.size` 已知时连读都不读
      （原来是 `await file.read()` 全量进内存**之后**才判 10MB ⇒ 一个大上传先吃满内存）；
    - **类型按文件头判**：`content_type` 是客户端声明的，改个扩展名就能把 HTML 存成 `.jpg`
      再由 `/static` 原样吐出来；声明与内容**矛盾**时 415（吵闹的失败）；
    - **写临时文件 → 同目录 `os.replace`（原子）→ DB 提交成功之后才删旧文件**；
      提交失败要把刚写好的新文件删掉（否则是孤儿），任何失败都不许留临时文件。
      判据 `tests/test_background_upload.py`（14 条，含**真的注入**的写盘失败 / 半写 / rename 失败 /
      提交失败；把这一批判据拿回旧实现上跑 ⇒ **7 条红**）。

36. **同一份数据不许有两个渲染器**（R46，devlog/249）：图片一律走
    `components/common/ProxyImage`（"直连 → `/img-proxy` → 占位"三态链），
    "哪些主机必须直接走代理"这条规则**只许在 `utils/imageHost.ts` 写一遍**。
    2026-09-13 修过一次同类问题（左栏自己拼 `bili.avatar_path ?? bili.avatar_url` ⇒
    档案设置换过头像后"卡片变了、左栏没变"），当时抽了 `resolveAvatar`；
    但**只抽了"取哪张"，没抽"怎么渲染"** —— 右栏 hero 换成 `ProxyImage` 时左栏还留着
    radix `Avatar` 的裸 `<img>`，于是同一个微博头像 URL：hero 走代理拿得到、左栏直连被
    防盗链 403 ⇒ 用户看到「右栏变了、左栏变灰底首字」。
    ⇒ 判据分三层：**口径**（`resolveAvatar` 单测）+ **渲染路唯一**（结构判据
    `utils/avatarRender.test.ts`：两处都必须 `<ProxyImage`、全站不许有 `<AvatarImage`、
    `imgProxyUrl(` 只许出现在 `imageHost.ts`）+ **接线**（探针 `--profile-sync` 比
    左右栏的 `data-render-src`）。⚠️ 只比 `data-src`（解析出来的源 URL）**永远量不出这个
    bug** —— 出事时左右栏的 `data-src` 一模一样。

37. **远端资源要"抓一次、长期用"**（L1，devlog/257）：头像/封面这类**小、不变、反复要**的
    资源一律经 `services/assets.py` 固化进 `static/assets/{kind}/`，索引在 `local_assets`。
    四条一起才成立（真源 `services/assets.py` 头部）：
    - **键 = 去掉签名参数的 URL**（`assets.key_of`，白名单 `SIGNATURE_PARAMS`）：
      实测微博头像签名约 3 小时轮换一次，同一张图的两次抓取只差 `Expires`/`ssig`
      （盘上两个文件 sha256 逐字节相同，样本在 `tests/fixtures/light_assets.json`）
      ⇒ 按完整 URL 去重等于没去重；
    - **文件名 = 稳定键的 URL 摘要**（不是内容摘要）：内容摘要要下完才知道 ⇒
      每次都先发请求，恰好废掉本模块的主要收益。内容摘要另存 `sha256` 列（去重/校验）；
    - **先写文件、再写索引**，且 `get()` 命中要求**文件与索引都在**：索引说有盘上没有 ⇒
      当未命中并重下（复用同一行修复）。反过来会在崩溃后留下"索引说有、盘上没有"的死条目；
    - **`remember()` 只登记、绝不搬迁**：`static/avatars/` 的历史文件留在原地
      （用户磁盘上的文件只许增不许减/改 —— 方案 §4 S-1）。
    ⚠️ 已知取舍：稳定键命中就**不回源核对**，万一平台"换图不换文件名"我们会一直用旧图
    （实测微博/B 站换图都会换文件名）⇒ 留 `--verify`（≥7 天一次）这个口子在 L4。
    ⚠️ 清理的**引用保护**（`_referenced_keys`）与被引用项的 pin 是两道防线，缺一条就会把
    用户正看着的头像删掉（L2 的 `prune` 判据）。

---


## 文件类判据的坑

### 6.14 ⚠️ 「文件被程序占着」类判据**必须分平台**（2026-09-26 加，devlog/215）
POSIX **允许**改名 / 删除**打开中**的文件，Windows **不允许**（撞"另一个程序正在使用此文件"）。
批次 15 里 `test_dispose_releases_the_file_so_it_can_be_renamed` 的"不 dispose 就改不动名"
那半条写成无条件 `pytest.raises(OSError)`，**Linux 两条腿一起挂在 `DID NOT RAISE` 上**
（Windows 腿反而是绿的 —— 本地那条腿永远看不见）。

**规矩**：凡判据依赖"文件被占用 / 删不掉 / 改不了名"这类**操作系统语义**，就
① 用 `os.name == "nt"` 分开断言，② **可移植的那一半要在两个平台都断言**
（这里 = "dispose 之后一定改得动"），③ 边界写进 docstring —— 别让它变成一条"只在 CI 上红"
的谜题。同族坑：Rust 侧 `delete_old_dir` 的 junction 用例、`migrate.rs` 的文件占用重试。
