---
doc: plans/media-pinning-execution
class: plan
scope: 把"轻资产固化"从**封面**扩到**帖子媒体**（正文图，可选视频）：不论平台，**未归档**帖的媒体自动固化到本地；帖子**归档后**自动清理；开关在设置里可调；本地没有副本时**打开时重取**作为备选
not-scope: 头像/封面那两条链（已在 L1/L3 落地，行为不动）；视频的分片（B站 DASH）固化；跨设备同步
expires: 2026-12-31
---

# 执行方案：帖子媒体固化（未归档优先）+ 归档自动清理 + 打开时重取

> **用户口径（2026-10-04）**：「把抓取时固化作为轻资产固化的一部分，不论什么平台，未归档的帖子都可以
> 作为轻资产固定下来，已归档的部分就自动移除，然后再设置中给出可以调整固定选项，例如是否固定资产、
> 未归档时长、是否自动清理归档资产、视频资源是否固定（默认否）等，然后把打开时重取作为一个备选项，
> 如果本地没有缓存就回退到重取」。
>
> **为什么现在做**：小红书图床 URL 是**签名地址**（`docs/GLOSSARY.md` 那条实测：库里 181 个 URL 签于
> 10-03 00:50，到 10-04 13:54 全部 403），本地推不出新签名 ⇒ 存下来的远端地址**必然过期**。
> 封面已经用 `PIN_POST_COVERS` 固化过一轮，正文图没有 —— 用户点开详情就是一片灰。
>
> ✅ **三个批次全部落地**（`devlog/319`–`320`）。此后"媒体固化"的维护入口是
> `docs/backend/ASSETS.md` §3.4 与设置里的「媒体固化」分组；本文件只留批次划分与停止条件。

## 一、复用而不是新造

| 已有的 | 这次怎么用 |
|---|---|
| `services/assets.py`（稳定键 / 原子写 / 索引 / `prune` / `pin`） | **直接用**：新增两个 kind，其余一行不改语义 |
| `local_assets.pinned` + `_referenced_keys()`（prune 的保护名单） | 保护名单的规则扩到新 kind：**只保护未归档帖**引用的媒体 ⇒ 归档即失去保护 |
| `prune(kind, max_bytes=0)`（"清空未受保护的"） | **就是"归档后自动移除"**：无需新写清理器 |
| 封面固化 worker（`scheduler._pin_account_covers`）的纪律（每张落盘即提交、锁内不下载、每轮限额） | 新媒体 worker 照抄这三条 |
| 运行设置 `Spec(...)` + 设置窗口数据驱动导航 | 新分组「媒体固化」⇒ **界面自动出现**，不用改前端 |
| `PostOut.cover_local` 的派生套路（`_post_outs` 批量查一次） | `images_local` 照抄 |

## 二、分批

- **批次 1（后端，✅ 已落地 `devlog/319`）**
  1. `assets.py`：`KIND_POST_IMAGE="post_image"` / `KIND_POST_VIDEO="post_video"`；
     `_referenced_keys` 加这两 kind 的规则 = **未归档帖**的 `body_json.images[].url`
     （视频另加 `video.url` + `video.fallbacks`）；
  2. `services/media_pin.py`（新）：`pin_account_media(db, acc, client)`（按帖子发布时间窗口、
     每轮张数/字节上限、每张 commit）+ `clean_archived(db, dry_run)` = 对新媒体 kind 跑
     `assets.prune(max_bytes=0)`；
  3. 运行设置新分组「媒体固化」：`MEDIA_PIN_ENABLED`(True) / `MEDIA_PIN_MAX_AGE_DAYS`(30, 0=不限) /
     `MEDIA_PIN_CLEAN_ARCHIVED`(True) / `MEDIA_PIN_VIDEO`(**False**) / 高级两项（每轮张数、每轮 MB）；
  4. 挂点：账号抓取轮里在封面固化之后跑 `pin_account_media`；抓取轮收尾（或归档边界变化处）跑
     `clean_archived`（受开关管）。
     ⚠️ 实测修正：视频**按镜像链只存第一条成功的**（镜像装的是同一份视频，各存一份纯属浪费盘）。
- **批次 2（契约 + 前端，✅ 已落地 `devlog/319`）**
  1. `PostOut.images_local: list[str]`（与 `body_json.images` **同序**，空串 = 本地没有）+ `video_local`；
     `_post_outs` 批量查一次（不许 N+1，判据照抄 `test_cover_assets.py` 的语句计数那条）；
  2. 详情页：封面/正文图/大图查看器都把本地副本当 `ProxyImage.fallbackSrc`（远端优先、本地兜底）。
     ⚠️ 本地副本要在 `dedupeImages` **之前**按索引挂上（去重会重排）。
- **批次 3（打开时重取，✅ 已落地 `devlog/320`）**
  `POST /posts/{id}/refresh-media`：按平台重取该帖详情（小红书走
  `XhsFetcher.fetch_post_detail` + `parse_note_detail`），更新 `body_json`/`cover_url`，
  顺手固化一次；前端在"四级全失败"时**只调一次**，拿到新地址就地重渲染。
  纪律：能力闸门（未登录 ⇒ 如实 403）+ 每帖节流 + 失败如实分类。
  ⚠️ 实测修正（三条）：① 复用的是 `BasePlatform.enrich`（不是各平台自己再写一遍详情解析）；
  ② **拿到新地址 ≠ 画得出来** —— `ProxyImage` 的四级状态在组件内，沿用实例时会停在 `failed`，
  所以图片项的 `key` 必须带 `url + local`、封面带 `cover_url`（见 `devlog/320` §二）；
  ③ 写回**只动媒体相关的列**，标题/发布时间不动（列表顺序别因为重取而变）。

## 三、判据（每批都要能反向验证）

| 判据 | 反向验证 |
|---|---|
| 固化：未归档帖的图**一次抓取就落到 `static/assets/post_image/`**，且索引行 `kind=post_image` | 关 `MEDIA_PIN_ENABLED` ⇒ 一个请求都不发、盘上不多文件 |
| 时间窗：超过 `MEDIA_PIN_MAX_AGE_DAYS` 的帖子不固化 | 窗口设 0 天 ⇒ 只有当天帖固化；设 0=不限 ⇒ 全部 |
| 归档清理：帖子 `is_archived=1` 后其媒体副本被删（行 + 文件） | 关 `MEDIA_PIN_CLEAN_ARCHIVED` ⇒ 一条都不删 |
| 保护：**未归档**帖引用的媒体**不许**被清理（哪怕它没被 pin） | 把引用规则误改成"全部帖子" ⇒ 归档清理那条红 |
| 视频默认不固化 | `MEDIA_PIN_VIDEO=False` ⇒ 只有图；打开 ⇒ 单文件直链视频也固化（**B站 DASH 分片明确不做**，设置说明里写清） |
| `images_local` 与 `images` **同序同长**，且派生**只查一次** | 页大小翻倍而查询数不变 |
| 本地兜底：远端 403 时详情页仍画出图（走本地副本） | 删掉本地文件 ⇒ 回落占位（现状） |
| 打开时重取：四级**全**失败才触发，且**一帖只调一次**（N 张坏图/重复报错也只一个请求） | 把 `onAllFailed` 挂到中间级 ⇒ "最多两次失败"那条用例红；去掉 `refreshedRef` ⇒ 多图用例数出 >1 个请求 |
| 重取回来**画得出**（新签发地址 / 新到位的本地副本都要生效） | `key` 去掉 `local`/`cover_url` ⇒ 用例红（`副本到位后没有重画`，实测过） |
| 重取的失败**如实分类**：未登录 403 / 帖不存在 404 / 平台没详情 409 / 同帖 30s 内 429 / 上游失败 502 | 拿掉能力闸门 ⇒ 未登录那条会去真打上游（用例断言 403） |
| 重取**只动媒体相关的列**，标题与发布时间不变（列表顺序不因重取而变） | 用例比对重取前后 `title`/`published_at` |

## 四、停止条件（**必须停下报告**）

1. 固化一轮的实际体积/耗时与"轻资产"定位不符（例如某平台正文视频平均 > 50MB/条）⇒ 停下来问要不要做视频；
2. `_referenced_keys` 扫全库 `body_json` 的耗时在真库上 > 2s（万级帖）⇒ 停下来改设计
   （给 `local_assets` 加 `post_id` 列 + 迁移）；
3. 归档清理误删了**未归档**帖的媒体（保护名单失效）⇒ 立即回滚并报告——这属于"用户磁盘上的东西被删"，不可接受；
4. 打开时重取触发风控（小红书 `-352`/412）⇒ 退成"只提示、不自动重取"。
