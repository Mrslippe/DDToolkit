# 后端抓取链路详解（v0.5.0）

> 覆盖范围：账号信息抓取 + 帖子抓取两条链路的触发入口、任务模型、API 清单、
> 节流/频率、风控判定与处理策略。代码位置：`app/services/scheduler.py`
> （调度与循环）、`app/services/fetcher.py`（B 站请求）、
> `app/services/platforms/{bilibili,weibo}.py`（平台适配）、
> `app/routers/vtuber.py`（HTTP 入口）。
> 本文档记录 **2026-09-04 当前实现**，与代码同步维护。

---

## 1. 总览：两条链路

```
触发源                         锁                循环框架
─────────────────────────────────────────────────────────────
APScheduler (5min, jitter30s)  _fetch_lock      async_fetch_and_update   → 逐账号抓信息
/vtuber/{id}/fetch (手动单V)     _fetch_lock      async_fetch_vtuber
/vtuber/adopt (后台)             _fetch_lock      _fetch_adopted → async_fetch_vtuber
─────────────────────────────────────────────────────────────
/vtuber/fetch-posts (快速/全量)  _post_fetch_lock  _fetch_posts_core (B站双流)
/vtuber/fetch-all-posts         _post_fetch_lock  async_fetch_all_posts → 逐账号
/vtuber/update-posts            _post_fetch_lock  async_update_unarchived_posts → 增量
/vtuber/batch/*                 _post_fetch_lock  (批量面板，同上框架)
```

- **账号信息抓取**：刷新账号资料（昵称/签名/头像）+ 粉丝数 + **直播状态**（B 站），
  成功后写一行统计快照（`account_stat_snapshots`，P0）。
- **帖子抓取**：按平台拉帖子列表（B 站 = 视频流 + 动态流；微博 = 单流），
  新帖逐个补详情，入库去重，全量/快速/增量三种模式。
- 两条链路**互斥运行**（各自独立锁 + 让位协议，见 §3）。

---

## 2. 触发入口清单

| 端点 | 说明 | 默认参数 |
|---|---|---|
| `POST /vtuber/{id}/fetch` | 手动抓取单个 VTuber 全部账号信息（账号抓取） | — |
| `POST /vtuber/fetch-accounts` | 批量面板：全部账号信息 | — |
| `POST /vtuber/adopt` | 候选池收录 → 后台自动抓一次账号信息 | — |
| `POST /vtuber/fetch-posts?name=&full=` | 按名字抓帖子；`full=true` 后台全量（视频+动态拉到底） | 非 full：video 3 页 / dyn 5 页（前端快速抓取实际传 2/3） |
| `POST /vtuber/fetch-all-posts` | 全部账号全量抓帖子（同步等待） | -1/-1 |
| `POST /vtuber/update-posts?name=` | 更新未归档动态：先跑归档规则（30 天）再增量抓取，归档边界即停 | 不含视频；`stop_on_existing=true` |
| `POST /vtuber/batch/fetch-all-posts` | 批量面板：全部账号全量帖子 | -1/-1 |
| `POST /vtuber/batch/update-unarchived` | 批量面板：全部账号增量动态 | 同 update-posts |
| `POST /posts/archive?days=30` | 归档规则（幂等）：published_at 早于 N 天前 → archived | 30 |

定时任务：`APScheduler IntervalTrigger(minutes=5, jitter=30)`，`max_instances=1`
（`scheduler.py:465-471`）。

---

## 3. 任务模型：锁、让位、状态

### 3.1 全局单飞

- `_fetch_lock`（账号）与 `_post_fetch_lock`（帖子）：`acquire(blocking=False)`，
  拿不到直接返回 `skipped`（不会积压排队）。
- `any_fetch_running()` = 账号在跑 ∨ 帖子在跑 ∨ 定时任务正请求让位
  （让位窗口也视为忙，防真空期钻空并发）——路由层据此返回 409/skipped。

### 3.2 定时任务优先让位协议（devlog/021）

定时任务触发时 `_yield_request.set()`；手下在跑的（手动账号/帖子）任务在
**断点**（账号间、视频页间、动态页间）检测到请求：`db.commit()` → 释放锁 →
等待信号清除 → 重查账号列表 → 从原序号续跑。定时任务完成后清信号。

- `_maybe_yield_account(db, vtuber_id)`：账号链路断点；
- `_maybe_yield_post(db)`：帖子链路断点。
- **v0.6.0 修订（2026-09-05 用户反馈）**：定时任务触发时若已有**全量账号抓取**
  在跑（`_fetch_scope == "full"`，与定时任务内容完全一致）→ 本轮**跳过不接管**
  （避免同一任务被让位-接管重复执行、打断手动任务的进度与快照基线）；
  单 V / 帖子在跑时仍照常让位协议。被让位方在让位点保存并恢复 `_fetch_scope`。

### 3.3 进度状态 & 结果

- `_status["account"]`：`running/current/index/total/recent[≤100]` + `last_result{seq,...}`；
- `_status["post"]`：`running/target` + `last_result{kind, stored, skipped, issues, video_missing}`；
- 前端经 `GET /vtuber/fetch-status` 每 ~2s 轮询；`recent` 增长驱动侧栏就地合并。

### 3.4 风控状态隔离（ContextVar）

风控标志是**任务上下文**级而不是模块级（`fetcher.py:16-21`）：
账号抓取与帖子抓取可能先后运行于同一进程/不同线程，模块级全局变量会导致
**跨任务污染**（帖子任务的风控被账号任务误读、错误进入冷却）。因此
`_rate_limit_ctx: ContextVar` 默认 `(False, "")`，进入任务时 `clear_rate_limit()`。

---

## 4. 账号信息抓取

### 4.1 循环节奏（`async_fetch_and_update`）

```
for 每个账号:
    让位检查 → fetch_user_info(1~N req) → 风控? 冷却 600s 续跑
    → sleep(3~5s 随机)     # REQUEST_INTERVAL_MIN/MAX
    → 成功: 写快照 + commit + push实时快照
    每 10 个账号: sleep 60s   # FETCH_BATCH_SIZE / FETCH_BATCH_COOLDOWN
```

- 账号列表：`AccountRepo.all_for_fetch()`（有 platform_uid 的全部账号）。
- 单账号请求量：B 站 = `acc/info`(WBI) + `relation/stat` 共 **2 req**（+头像下载 1 req，仅 URL 变化或文件缺失时）；
  微博 = `profile/info` **1 req**（+头像下载）。
- 直播状态来自 `acc/info` 的 `live_room.liveStatus/title/roomid`（B 站专属）。

### 4.2 定时频率上限测算（以 16 账号为例）

| 项 | 值 |
|---|---|
| 一轮请求量 | 16 × 2 ≈ 32 req（B 站） |
| 一轮耗时 | 32 req × ~4s 间隔 + 1 次 60s 批次休息 + 网络 ≈ 2.5~4 min |
| 平均速率 | ≈ 32 req / 5 min ≈ **7 req/min** ✅（< 20/min） |
| 突发速率 | 2 req / 3~5 s ≈ 24~40 req/min ⚠️（仅该值瞬时，靠批次休息摊平） |

结论：账号链路的**平均速率安全**，突发略高于 20/min 但空间接口阈值较宽。

### 4.3 应用启动链（v0.6.0，devlog/027）

应用启动（lifespan 后）由守护线程串行执行三阶段，各自容错、锁冲突即跳过：

| 阶段 | 函数 | 内容 | 节奏 |
|---|---|---|---|
| 1 直播状态 | `startup_live_sweep` | B 站**批量**直播接口（`fetch_bilibili_live_batch`，100 uid/请求）仅回写 live 字段；跳变落统计快照；每批 push 实时快照 | 0.3~0.6s/批 |
| 2 主要账号 | `startup_main_account_sweep` | 每 VTuber 仅主账号（`PRIMARY_PLATFORM_ORDER` 优先，默认 bilibili）全字段 | 2~3.5s |
| 3 最新动态 | `startup_latest_dynamics` | 每主账号 1 页动态 + `_fetch_posts_core(limit_latest=2)`：最多入库最新 N 条新帖即停 | 3~5s |

配置：`STARTUP_CHAIN_ENABLED/DELAY`、`STARTUP_LIVE/MAIN/DYNAMICS_INTERVAL_*`、
`STARTUP_DYNAMICS_LIMIT`、`PRIMARY_PLATFORM_ORDER`。
共用账号/帖子锁与状态通道（`_fetch_scope` = 'live'/'main'），定时任务内容一致跳过
判定只认 'full'。

---

## 5. 帖子抓取（B 站双流核心 `_fetch_posts_core`）

### 5.1 流程

```
前置：existing_ids / archived_ids 全量查库（内存去重，防唯一约束回滚）
视频流（含 video_pages 页数限制）:
    arc/search?ps=30&pn=n&order=pubdate       页间 sleep 1s
    → 整页已归档 → archived_stop 终止
    → 全部已入库 → skipped（不停止，继续翻页）
动态流（含 dynamics_pages）:
    feed/space?host_mid=&offset=              页间 sleep 20s
    → 直播开播动态（LIVE_RCMD）丢弃
    → stop_on_existing: 首页第 1 条豁免（防置顶旧帖误停），
      从第 2 条起遇到已入库 → 立即停止（更早的必然已入库）
    → 整页已归档 → archived_boundary 终止
逐帖详情补全（只有【未入库】的帖子才请求）:
    text/image   → web-dynamic/v1/detail (OPUS 全文/大图)      sleep 0.5~2s
    article      → x/article/view (专栏全文, 含 Quill Delta)    sleep 0.5~2s
    video_dynamic→ x/web-interface/view (简介/时长/分区/统计)   sleep 0.5~2s
批量入库：pending 攒 50 条 commit 一次（SQLite fsync 优化）
```

### 5.2 三种调用模式

| 模式 | 参数 | 特征 |
|---|---|---|
| 快速抓取（前端按钮） | `video_pages=2, dynamics_pages=3` | 小规模，同步等待（非 full 分支） |
| 全量（`full=true`） | `-1/-1` 拉到底 | `BackgroundTasks` 后台跑，进度见顶栏 |
| 更新未归档 | `include_videos=False, stop_on_existing=True` | 只抓动态第一页（通常），归档边界即停 |

### 5.3 微博单流（`_fetch_platform_posts`）

```
mymblog?uid=&page=&feature=0         页间 sleep 20s
→ has_more = 有列表且 data.since_id 非空
→ isLongText 的帖 → m.weibo.cn/statuses/extend（PC cookie 可用；手机 UA）
→ 同样支持 stop_on_existing / 归档边界 / 风控页重试
```

---

## 6. API 清单

### 6.1 B 站（全部带 `auth_manager.build_headers()`，UA + 通用 Cookie）

| API | 用途 | 签名 | 风控敏感度 |
|---|---|---|---|
| `GET /x/web-interface/nav` | WBI 密钥（缓存 30min）与登录心跳 | 无 | 低 |
| `GET /x/space/wbi/acc/info` | 账号资料 + live_room（直播状态） | WBI | 中 |
| `GET /x/relation/stat` | 粉丝/关注数 | 无 | 低 |
| `GET /x/space/wbi/arc/search` | 视频投稿列表（30/页，order=pubdate） | WBI | 中（列表） |
| `GET /x/polymer/web-dynamic/v1/feed/space` | 动态流 | 无 | 中（列表） |
| `GET /x/polymer/web-dynamic/v1/detail` | 单条动态详情（OPUS） | 无 | **高（风控最严）** |
| `GET /x/web-interface/view` | 视频详情（bvid） | WBI | 中 |
| `GET /x/article/view` | 专栏全文（cv_id） | 无 | 低 |

### 6.2 微博（PC ajax，Cookie = 扫码登录保存的 WEIBO_COOKIE）

| API | 用途 |
|---|---|
| `GET weibo.com/ajax/profile/info` | 账号资料（screen_name/avatar_hd/followers_count） |
| `GET weibo.com/ajax/statuses/mymblog` | 微博列表（page/feature=0；ok=-100 需登录） |
| `GET m.weibo.cn/statuses/extend` | 长文全文（isLongText 时；PC cookie 可用，wap 登录态不判） |

### 6.3 登录 / 认证（独立于抓取，见 weibo_auth.py / auth.py）

| API | 用途 | 频率 |
|---|---|---|
| `GET passport.bilibili.com/...qrcode/image?entry=xxx` | B 站二维码生成 | 用户点击触发 |
| `GET passport.bilibili.com/...qrcode/check` | B 站扫码轮询 | 前端 2s/次（仅对话框打开且二维码显示中） |
| `GET weibo.com/ajax/profile/info`（check_valid 探测） | 微博登录态真实性校验 | 仅 `/auth/weibo/status` 调用；60s 缓存 |
| `GET passport.weibo.com/sso/v2/qrcode/image` + `GET v2.qr.weibo.cn/inf/gen` | 微博二维码生成 | 用户点击触发 |
| `GET passport.weibo.com/sso/v2/qrcode/check` | 微博扫码轮询 | 前端 2s/次（同上） |
| B 站 `nav`（run_maintenance） | 会话有效性维护 | **30 分钟一次**（仅 B 站；微博无后台轮询） |

---

## 7. 风控体系

### 7.1 判定代码（`fetcher.py:26-46`）

```python
RATE_LIMIT_CODES = {-509, -412, -799, 412}

def _detect_rate_limit(status_code, data=None):
    # 1) HTTP 层：412（B站风控）、418/429（微博 m 站限流）
    if status_code in (412, 418, 429): ...置位
    # 2) 业务 code：-509 请求过于频繁 / -412 请求被拦截 / -799 / 412
    if code in RATE_LIMIT_CODES: ...置位
    # 3) 文案关键字（B 站 message / 微博 msg）
    elif "频繁" in msg or "请求过于" in msg: ...置位
```

**对应原因**：
- `-509`（请求过于频繁）：固定窗口限流，最常见——对应「某几分钟内请求数超阈值」；
- `-412` / HTTP 412（请求被拦截）：风控/机器人判定触发（UA、频率、行为特征可疑）；
- `-799`：访问过于频繁或 IP 环境不良（数据中心 IP 常见）；
- `HTTP 418/429`：微博 m 站限流（`m.weibo.cn` 对 extend 接口的节流）；
- 文案「频繁/请求过于」：微博 `.msg` 无 code 字段，只能按文案兜底
  （`{"ok":0,"msg":"请求频率过高"}` 之类）。

### 7.2 分层处理策略

| 层级 | 行为 |
|---|---|
| **列表页级**（视频页/动态页/微博页） | 风控 → 落盘已抓数据 → 同页冷却 600s 重试，**上限 2 次**（`_PAGE_RETRIES`）；耗尽 → `stop_reason="rate_limited"`，前端提示 + 断点续抓（后续从该断点继续） |
| **详情级**（每条帖子的 detail/view/article/extend） | 触发风控**不重试、不中断**：该帖跳过详情（保留 feed 数据）；**每条处理完立即 `clear_rate_limit()`**——详情风控标志只用于「列表页判定」（防止污染下一页列表请求的判定，方案 C） |
| **账号级**（账号信息循环） | 风控 → 冷却 600s → **从当前账号续跑**（重查账号列表防 detached 对象） |
| **任务级** | 每次任务开始 `clear_rate_limit()`（ContextVar 隔离，防跨任务污染，见 §3.4） |

### 7.3 为什么这样设计（实际踩坑）

- **详情风控必须即时清零**：`fetch_dynamic_detail` 的 -509 若被后续列表页判定读到，
  会把一个「单帖限流」放大成「整页放弃」；
- **列表页重试上限 2 次**：风控冷却 600s × 2 = 20 分钟仍连续失败说明 IP 环境异常，
  继续重试只会加剧风控，改为中断并如实上报 `video_missing`（方案 2 完整性比对）；
- **风控标志 ContextVar 隔离**：账号与帖子任务各自持有干净初值（历史 bug：模块级
  全局标志导致跨任务误读，见 §3.4 注释）。

---

## 8. 频率 / 节流总表

| 位置 | sleep | 折算速率 | 与 20/min 对比 |
|---|---|---|---|
| 账号间（信息流） | 3~5s | 24~40/min（突发） | ⚠️ 略超（批次休息摊平后 ~7/min ✅） |
| 视频翻页 | 1s | ~60/min | ⚠️ 超出 |
| 动态翻页 | 20s | ~3/min | ✅ |
| 微博翻页 | 20s | ~3/min | ✅ |
| 帖子详情（逐帖） | 0.5~2s | ~30~60/min | ⚠️ 超出（仅新帖发生时） |
| 微博长文 extend | 0.5~1.5s（enrich 后） | ~40/min | ⚠️ 超出（仅长文帖） |
| WBI 密钥 | 30min 缓存 | ~0 | ✅ |
| B 站会话检查 | 30min | ~0 | ✅ |
| 微博登录态 | 无后台轮询 | 0 | ✅ |

> 结论：**列表页翻页与账号信息是安全的；超出预算的是「逐帖详情补全」与
> 「视频翻页 1s」。** 目前靠 §7.2 的风控兜底（事后冷却）而非事前节流，
> 偶发风控属预期行为。

---

## 9. 配置与常量

| 名称 | 值 | 位置 |
|---|---|---|
| `FETCH_INTERVAL_MINUTES` | 5 | config.py |
| `FETCH_JITTER_SECONDS` | 30 | config.py |
| `REQUEST_INTERVAL_MIN/MAX` | 3.0 / 5.0 s | config.py |
| `FETCH_BATCH_SIZE` | 10 账号 | config.py |
| `FETCH_BATCH_COOLDOWN` | 60 s | config.py |
| `RATE_LIMIT_COOLDOWN` | 600 s | config.py |
| `_PAGE_RETRIES` | 2 | scheduler.py:602 |
| `_POST_BATCH_SIZE` | 50 条/commit | scheduler.py:599 |
| `RATE_LIMIT_CODES` | {-509, -412, -799, 412} | fetcher.py:23 |
| WBI `CACHE_TTL` | 1800 s | wbi.py:23 |
| B 站超时 | 15s（任务级 client） | scheduler.py |
| 详情间隔 | uniform(0.5, 2.0)s | scheduler.py:800/826/846 |
| 视频页间 | 1s | scheduler.py:723 |
| 动态/微博页间 | 20s | scheduler.py:864/987 |

---

## 10. 已知优化方向（截至 2026-09-04 **未实施**）

1. **详情链节流**：0.5~2s → 2~3s（均匀随机），或按最近风控事件做拥塞窗口自适应
   （风控后速率减半、10 分钟无风控恢复）；
2. **视频翻页 1s → 3s**；
3. **账号抓取分层频率**：每轮只拉 `acc/info`（直播状态实时性优先），`relation/stat`
   粉丝数与统计快照改为每 30 分钟一次——每轮请求量减半且为直播检测腾出余量；
4. **帖子详情合并**：无批量 API，1 帖 1 请求为完整性必要成本，不可再压缩；
5. 不改动建议：增量模式（stop_on_existing 第 1 页即停）已是当前最优；
   `x/web-interface/card` 合并接口拿不到直播状态且旧接口稳定性差，不采用。
