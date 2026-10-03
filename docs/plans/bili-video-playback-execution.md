# 执行方案：B站视频播放（C1+C2，默认 C2）

> 用户口径（2026-10-03）：「那就 C1+C2 吧，不过**响应和播放内核默认 C2 的选项**」。
> 即：**默认按 DASH 取流并用 MSE 内核播**，durl（单 mp4）只作回落 —— 因为实测只有 DASH
> 能拿到 1080P，而用户是登录态（非大会员）。

## 一、实测基线（2026-10-03，用 `.env` 里的 cookie 真打）

| 请求 | 格式 | 游客 | 登录（本账号 `vipStatus=0`） |
|---|---|---|---|
| `playurl?fnval=1` | durl 单 mp4 | 720P | **仍 720P（封顶）** |
| `playurl?fnval=16` | DASH（音视频分离） | 720P（4 条流） | **1080P**（8 条流，`quality=80`） |
| 要 1080P+ / 1080P60 / 4K | — | — | **全部回落到 1080P**（大会员档，账号没有） |
| 媒体 CDN | — | **不带 Referer → 403**；带 `Referer: https://www.bilibili.com/` → 206 | 同 |
| 小红书 CDN | — | **带 Referer → 403**；不带 → 206 | 同（对照） |

⇒ 两条硬结论：① **只有 DASH 能到 1080P**；② **代理必须按主机分 Referer 策略**（两家要求相反）。

## 二、分批（每批独立可交付 + 过 A 档门禁 + devlog + 提交）

### 批 1：后端取流与代理策略（约 1 天）
1. `app/services/bili_play.py`（新）：
   - `resolve_cid(bvid)`：`x/web-interface/view`（进程内缓存，含 title/duration）；
   - `play_info(bvid, qn=None)`：`x/player/playurl`，**默认 `fnval=16`（DASH）+ `fourk=1`**，
     同时带回 `durl`（回落用）与 `accept_quality/accept_description`（清晰度菜单的数据源）；
   - 凭据：从 `settings.BILI_SESSDATA/bili_jct/DedeUserID/buvid3` 拼 Cookie（**只在请求头里用，
     不进日志、不进响应**）；UA/Referer 走 `core/useragent` 与固定 `bilibili.com`；
   - 错误映射（**如实**）：`-404` 视频不存在 / `-403` 无权限（充电专属等）/ `-352` 风控冷却中 /
     其它 → 通用失败；**绝不把"没权限"说成"取不到"**。
2. `GET /posts/{post_id}/play`（`app/routers/vtuber.py` 或新 router）：按 `post_id` 找 B站帖 →
   `bvid` → `play_info`；响应**只给前端要用的**：`{quality, accept[], dash:{video[], audio[]},
   durl[], expires_in}`，**URL 里的签名参数照原样**（前端直接喂 MSE/代理）。
   ⚠️ 该端点必须**按需调用**（用户点播放），不可预取、不可扫库。
3. `/video-proxy` 扩展：主机策略表 —— `bilivideo.com`（及 `*.bilivideo.com`、`upos-*.bilivideo.com`）
   **带 Referer + UA**；`xhscdn.com` **不带 Referer**（现状）。白名单加 bilivideo 域。
4. 判据：`tests/test_bili_play.py` —— 错误映射矩阵、`fnval=16` 默认、cookie 只在请求头、
   **响应与日志都不含 Cookie 值**（植哨兵断言）；`tests/test_video_proxy.py` 扩：按主机加/去 Referer。

### 批 2：前端 DASH 内核（约 1–1.5 天）
5. 引入 `dash.js`（**新增前端依赖**，约 300KB min）或用原生 MSE 手写 —— 默认前者；
6. `VideoPlayer` 增加"内核"分支：`dash` ⇒ `dash.js`（MSE）+ 现有自绘控件（进度/音量/倍速/全屏
   全部接到 MSE 的 `buffered`/`seekable`）；`durl`/小红书直链 ⇒ 现有 `<video src>` 路径不变；
7. 清晰度菜单：列 `accept_quality`，**默认选账号可得的最高档**（本账号=1080P），
   大会员档（1080P+/1080P60/4K）显示但标注「需大会员」且**不可选**（如实，不假装能到 4K）；
8. 播放地址过期（`expires_in`）时**自动重取一次**再播（URL 短时效是已知约束）；
9. 判据：`VideoPlayer.test.tsx` 扩（内核选择、清晰度默认档、大会员档禁用、重取一次）；
   `PostDetailDrawer` 侧：B站帖从 iframe 切回自绘播放器（iframe 保留为"播不了时的兜底"？——待定，
   倾向**移除 iframe**，因为自绘内核已覆盖且控件统一）。

### 批 3：微博视频映射 + 收尾（约半天）
10. 微博 `body.video` 补 `page_info.media_info`（`stream_url` / `mp4_*`）→ 走 `/video-proxy`（带 Referer）；
11. 文档：`docs/frontend/UI-MAP.md` 播放器段、`docs/backend/FETCH-PIPELINE.md`（新端点与风控口径）、
    `docs/GLOSSARY.md`（代理主机策略）、PERF 条数；devlog 每批一篇。

## 三、风险与对策（实现时逐条落）

| 风险 | 对策 |
|---|---|
| playurl 短时效 + 绑 IP | 播放时现取 + 前端过期自动重取一次；**不入库** |
| 风控（`-352`） | 只在点击时调用 + 复用 `identity_limit`/rate_limit + 短缓存；错误如实显示并给"稍后重试" |
| 权益上限（用户非大会员） | 清晰度菜单如实标注；默认选**可得最高档**（1080P） |
| DASH 与自绘控件对齐 | 进度/缓冲/seek 全部读 MSE 的 `buffered`/`seekable`；拖拽 seek 用 `currentTime` 直写 |
| 凭据泄漏 | Cookie 只在请求头；响应/日志/前端状态都不含；**植哨兵测试**断言 |
| dash.js 体积与新依赖 | 决定引入前先量一次包体（打包后首屏影响），必要时按需 `import()` 懒加载 |
