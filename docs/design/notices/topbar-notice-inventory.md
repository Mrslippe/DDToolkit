---
doc: design/notices/topbar-notice-inventory
class: snapshot
scope: 顶栏状态胶囊（状态岛）**当前**一共有哪些通知、各自怎么呈现、持续多久、优先级与压制关系 —— 改造前的现状清点
not-scope: 改造方案与目标形态 → design/notices/target-architecture.md；后端消息中心分层 → design/notices/message-hub-architecture.md；能力矩阵受限项（那是**工具**不是通知）→ frontend/UI-MAP.md
verified: 2026-10-05
---

# 顶栏通知现状清点（2026-10-05）

> 数据来源全部是**代码**（不是回忆）：`app/services/notices.py`（后端汇总 ·
> 8 类条目 + 5 类事实）、`frontend/src/utils/notificationHub.ts`（条目模型与判定）、
> `frontend/src/utils/noticeStream.ts`（取数/合并/TTL）、`frontend/src/components/StatusIsland.tsx`
> （渲染），以及全仓 `toast.` 的真实调用（**56 处，13 个文件**；另有 2 处只是注释里提到这个名字）。

## 1. 四个呈现面（同一份信息，四种"出现在哪"）

| # | 面 | 位置 | 说什么 | 怎么消失 |
|---|---|---|---|---|
| ① | **胶囊**（`.si-island`） | 顶栏中部（左：LOGO/标题；右：能力入口 + 登录 + 窗控） | 只显示 `pickPrimary` 选出的**那一条**：点色 + 类型字形 + 文案 + 活数据槽 + 计数徽章 + 箭头 | 那条条目过期/被更高的顶掉 ⇒ 回空闲态 |
| ② | **通知面板**（`.si-panel`，portal + fixed） | 胶囊正下方（贴下沿时**向上翻**），340px 宽 | **全部**在live条目：图标 + 文案 + 活数据 + 补充说明 + 「类型 · 来源 · 常驻」+ 动作按钮；页脚写优先级次序 | 条目清空 / Esc / 点外面（点击是**钉住**，hover 只临时展开） |
| ③ | **toast**（sonner） | 屏幕**顶部居中** | 操作结果/失败原因（**不进通知面板**，与①②不是同一套） | 4s（sonner 默认 `TOAST_LIFETIME`），同屏最多 3 条 |
| ④ | **完成报告对话框**（AlertDialog） | 居中模态 | 面板里点「查看详情」才开：存储/跳过/视频缺失 + 中断账号清单 | 只有「知道了」（不响应 ESC/点外面） |

> ⚠️ **优先级：同屏"几条"其实等于一条**。面板外永远只有一条文案（`pickPrimary`），
> 其余靠 `.si-count` 徽章告诉用户"还有 N 条"。`KIND_PRIORITY` 后端/前端各一份且**逐字相同**：
> `alert(4) > progress(3) > report(2) > message(1)`；同级取**数组里靠后的**（即最新）。

## 2. 时长规则（全部是常量，没有用户可调项）

| 口径 | 值 | 定义处 |
|---|---|---|
| 瞬时消息 TTL | **4s**（前后端各一份同值） | 前端 `noticeStream.PILL_MS` · 后端 `notices.MSG_TTL_MS` |
| 推送来的「任务已受理」进度兜底 TTL | **8s** | `noticeStream.PUSHED_PROGRESS_MS` |
| 开播告警 TTL | **2 分钟**（`LIVE_NOTICE_MS` / 后端 `LIVE_TTL_MS`） | `notificationHub` · `notices` |
| 风控冷却 | **= 冷却剩余秒数**（`expires_at = now + seconds_left×1000`），倒计时走 `value` 槽每秒刷新 | `notices._rate_limit_notice` |
| 登录失效 | **常驻**（`sticky`），直到重新登录 | `notices._login_notice` |
| 完成报告 | **常驻**，直到点「知道了」（已读落 `app_meta`，刷新/重启不再复活） | `notices._report_notices` + `ack_notice` |
| 进度（任务在跑） | 没有 TTL —— **跟着任务结束消失** | `notices._progress_notices` |
| toast | **4s**（sonner 默认），同屏 3 条 | `frontend/node_modules/sonner`（`TOAST_LIFETIME=4000`、`VISIBLE_TOASTS_AMOUNT=3`） |
| 空闲轮播 | 6s 一格（**当前下线**：`IDLE_CAROUSEL_ENABLED=false`，只显示状态文案） | `utils/idleQuotes.ts` |
| 胶囊文案换字 | 出 90ms → 停 60ms → 进 140ms（transition 可重定向，不是 keyframes 重放） | `status-island.css` + `tokens.css` 的 `--motion-*` |
| 计数徽章变化 | 瞬时复位（0ms）→ 140ms 弹出（`useLayoutEffect`，防"新数字先画全尺寸"） | `StatusIsland.tsx` + `status-island.css` |
| 面板入场 | 220ms（`--motion-base`；reduced-motion 下换 140ms 淡入） | `status-island.css` |
| hover 展开/收起 | 进 **120ms**（掠过不弹）· 出 **200ms**（容得下移进面板）；**点击则钉住** | `StatusIsland.tsx` |
| 取数节奏 | fetch-status/notices 轮询：忙 **3s**、闲 **10s**、在途冲突重排 **500ms**；隐藏到托盘**停轮询** | `TopBar.tsx` |

## 3. 后端汇总出的 8 类条目（`GET /vtuber/notices`，前端轮询取）

| id | kind | 文案 | 触发条件 | 呈现 | 时长 | 动作 | 优先级 |
|---|---|---|---|---|---|---|---|
| `progress-post` | progress | `帖子抓取中 - V名 - i/N`（任务名：帖子/全量/首屏） | 帖子流在跑 **且非自动档** | 胶囊（转圈点 + ◔） | 任务结束 | — | 3 |
| `progress-account` | progress | `账号信息抓取中 - V名 - i/N` | 账号流在跑 **且非自动档** | 同上 | 任务结束 | — | 3 |
| `progress-external` | progress | `正在同步<label>`（收录回填/每日批次） | 第三方数据任务在跑 | 同上（**会被它一直占着**） | 任务结束 | — | 3 |
| `rate-limit` | alert | `上游限流：冷却中` + `value="47s"` | `fetch_status.rate_limit.active` | 胶囊（⚠ + 警示点）+ 面板；detail = 冷却原因 | 冷却剩余 | — | 4 |
| `login-expired` | alert | `B 站登录已失效` | `auth_manager.needs_login()` | 胶囊 + 面板（**常驻**） | 常驻 | 「去登录」→ 开登录浮窗 | 4 |
| `report-<seq>` | report | `全量帖子抓取完成 · 存储 N · 跳过 M` | 一轮 `full_all`/`full_vtuber` 跑完 **且当时有订阅者**（"目睹才报"）**且未已读** | 面板（常驻，✓） | 常驻 | 「查看详情」→ 报告对话框 | 2 |
| `live-<account_id>` | alert | `<V名> 开播了`（detail = 直播标题） | T0 轮询发现 `live_status` 0→1 ⇒ 进**环形缓冲** | 胶囊 + 面板 | 2 分钟 | — | 4 |
| `msg-<ms>` | message | 手动动作的完成文案（见 §5） | 手动端点 `_note_manual_done` ⇒ 进**环形缓冲** | 胶囊（✦） | 4s | — | 1 |

> ⚠️ **同一个 id 可能同时来自两条路**（不是两类条目）：开播那条既进环形缓冲（这里），
> 也走 SSE 推一份（§4）；两侧同 id ⇒ `mergeNotices` 按 id 去重（本地优先）。
> 环形缓冲 `_ring` 上限 **20 条**（开播与瞬时消息共用），TTL 从**记录时刻**起算
> （不是渲染时刻 —— 否则每秒重算会把过期时间一直往后推）。
> ⚠️ `notice.alert` / `notice.report` 两个消息类型**已定义但生产代码从不发布**
> （只在 `tests/test_messages.py` 里被 publish）：alert/report 走的是**轮询那份**，不是推送。

## 4. 前端本地独有的 5 类（服务端不知道，走 SSE 或本地事实）

| 来源 | id | kind | 文案 | 触发 | 呈现 | 时长 |
|---|---|---|---|---|---|---|
| SSE `domain.live.edge` | `live-<account_id>`（与 §3 同 id） | alert | `<V名> 开播了` | T0 检测到开播（推送那一份） | 胶囊 + 面板 | 2 分钟（`liveNotice`） |
| SSE `notice.progress` | `pushed-progress` | progress | 手动端点推的"任务已受理" | 点按钮那一刻（**抢在轮询前面**） | 胶囊 | 8s 兜底，服务端 progress 一到就让位 |
| SSE `notice.message` | `msg-<到达时刻>` | message | 手动动作完成（**originator ≠ 本窗口**时才播） | 别的宿主发起的动作 | 胶囊 | 4s（从**到达时刻**起算） |
| 本地（`useLowSpaceNotice`） | `msg-<...>` | message | `磁盘可用空间不足 5GB（数据目录已占 …MB）—— 设置 → 关于 可查看占用并清理` | 启动后 storage 检查命中 `low_space` | 胶囊 | 4s；同一台机器 **3 天内只提一次** |
| 本地（`useUpdateCheck`） | `msg-<...>` | message | `发现新版本 vX —— 设置 → 关于 可查看并更新` | 启动后 15s 静默查一次 | 胶囊 | 4s |

另外还有**三条**只有数据、不产生通知的推送（列在这里是为了划清边界）：
`domain.vtuber.updated`（V 本体 → 左右栏同步）、`domain.posts.changed`（帖子抓完 → 列表刷新）、
`domain.account.snapshot`（账号字段就地合并）。

## 5. 后端会产出的瞬时消息文案（§3 的 `msg-*` 与 §4 的推送都是这几句）

| 端点 | 完成文案 |
|---|---|
| `POST /vtuber/{id}/fetch` | `账号信息更新完成 · 成功 N · 失败 M` |
| `POST /vtuber/fetch-posts` | `帖子抓取完成 · 存储 N · 跳过 M`（+ `（触发风控，部分内容未抓全）`） |
| `POST /vtuber/update-posts` | `动态更新完成 · 新增 N · 跳过 M` |
| `POST /vtuber/adopt`（收录/加账号） | `新 V 首屏抓取完成 · 投稿 N · 动态 M · 入库 K`（`originator=""` ⇒ **发起方自己也播**） |

## 6. 只有 toast、**不进**通知面板的（56 处调用点 / 13 个文件，按用途归类）

| 场景 | 位置（示例） | 语气 |
|---|---|---|
| 抓取/更新被拒（已有任务在跑） | `useVtuberActions`（4 处 `toast.warning`） | 警示 |
| 抓取触发风控 | `useVtuberActions`（帖子/动态各 1 处 `toast.warning`） | 警示 |
| 全量抓取已开始 | `useVtuberActions:112` `toast.success` | 成功 |
| 收录/添加账号成功 | `AddVtuberDialog`（3 个平台各 1）、`AddAccountDialog` | 成功 |
| 登录 / Cookie 保存成功 | `LoginDialog`（扫码成功、cookie 已保存） | 成功 |
| 设置保存 / 恢复默认 | `AppSettingsDialog:400,419`（**同时**再 `onPill` 发一条胶囊 ⇒ 一次操作两种提示） | 成功 |
| 存储运维（迁移 / 删旧目录 / 清图片缓存 / 整理 DB / 清理轻资产） | `AppSettingsDialog` ×7 | 成功/信息 |
| 归档完成 / 批量任务已开始 / 任务状态 | `BatchFetchDialog` ×4 | 成功/信息 |
| 历史加载、企划更新、头像与签名保存、切换签名来源、背景上传/清除、删除账号 | `AccountHistoryDialog`、`ProfileCard`、`VtuberSettingsDialog` ×6 | 错误 |
| 问题报告复制 / 打开 issue 页 | `ProblemPanel` ×2 | 成功/错误 |
| 卡片顺序保存、打开链接 | `HeroCardsView` ×2、`externalLinkGuard`（全局捕获，含平台富文本里的链接） | 错误 |

> 口径（`utils/pill.ts` 文件头）：**成功类走胶囊、错误走 toast**。
> 但这条口径今天**并没有被统一执行**：`useVtuberActions` 里"开始/已完成"混合着用，
> 设置窗口是"toast + 胶囊"双发。**这是清点结论，不是要现在就改**。

## 7. 合并、去重、压制（改造前必须知道的四条）

1. **服务端更权威**：服务端一旦报到 `progress-post`/`progress-account`（任务进度）或任何
   `message`，本地那份立刻撤（`mergeNotices`）——但**只按任务让位**，`progress-external`
   不会顶掉本地点按钮的进度（否则用户又得等 3–10s）。
2. **按 id 去重，本地优先**：开播告警两边同 id（`live-<account_id>`）。
3. **两个 TTL 起算点不同**：服务端条目从**记录时刻**、本地条目从**到达时刻**
   （都不能用渲染时的 `now`，否则条目永远不会消失）。
4. **自动节拍一律不产生通知**（2026-09-10 用户口径）：动态轮询、自动账号流
   （`status.*.auto === true`）既不亮胶囊也不占面板 —— 它们没有终局，会一直重复。

## 8. 清点出来的六个现状问题（改造的输入，不在本文给方案）

1. **三套渠道并存**：胶囊/面板（轮询 `/vtuber/notices`）、toast（sonner）、报告对话框。
   同一件事（如"设置已保存"）可能同时出现在两套里。
2. **"成功走胶囊 / 失败走 toast"这条口径只在文件头的注释里**，调用点并未统一（§6）。
3. **时长没有统一口径**：4s / 8s / 2 分钟 / 冷却剩余 / 常驻，共五种，且 **4s 短于空闲轮询 10s**
   （服务端那份还没被轮询看到就已经过期 —— 靠本地推送与环形缓冲兜着）。
4. **胶囊同时承担"状态"与"通知"**：空闲时它是状态文案（"数据服务运行中"），有事时变成通知；
   同一块位置、两种语义，用户得自己分辨"这是在告诉我发生了什么，还是它本来就在那儿"。
5. **面板里"能看到"与"能操作"不成比例**：只有 `login-expired` / `report-*` 带动作按钮；
   其余条目点不开、也没有"跳过去看看"的路（`open-limits` 这个 action kind 至今未接线）。
6. **`expiresAt` 用绝对毫秒时间戳**（服务端 `now` 口径）：客户端与服务端时钟/久挂之后
   重算口径要不要改，得在改造里明确（现在靠"每条轮询都带 `now`"兜着）。

## 9. 与本文的维护约定

- **本文是清点（snapshot），不是规范**：改造落地后它就该被**改写或退役**
  （`retire-when` 见下），不要在这里追加"应该怎样"。
- 通知相关真源：`app/services/notices.py`（后端汇总）、`frontend/src/utils/notificationHub.ts`
  （条目模型/优先级/过期）、`utils/noticeStream.ts`（取数与合并）、`components/StatusIsland.tsx`（渲染）。
- 探针：`python scripts/ui_probe.py --status-island`（含"瞬时消息过了 ttl 还亮着"这条判据）。

<!-- retire-when: 顶栏通知改造落地（呈现面或时长口径被替换）后，本文改为记录改造前后对照或直接删除 -->
