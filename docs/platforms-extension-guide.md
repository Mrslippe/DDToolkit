# 平台爬虫框架（app/services/platforms）

> 多平台订阅架构：同一 VTuber 可挂多个平台账号（bilibili / 微博 / …），
> 每个账号独立抓取账号信息与帖子；帖子统一存 `posts` 表按 `platform` 区分。

## 架构

```
app/services/platforms/
├── base.py      # BasePlatform 协议（爬虫框架接口）
├── registry.py  # 平台注册表：get_fetcher(platform)
├── bilibili.py  # B 站适配（包装 app/services/fetcher 既有实现）
└── weibo.py     # 微博适配（m.weibo.cn 公开接口）
```

scheduler 统一消费框架：

- **账号信息抓取** `_fetch_one_account`：`registry.get_fetcher(acc.platform)` → `fetch_user_info(uid)`，
  统一回填 `display_name / sign / avatar / followers_count / url`（平台附加字段如 live_* 一并处理）。
  头像落盘按 `{platform}_{uid}{ext}` 命名防跨平台撞名。
- **帖子抓取** `_fetch_posts_for_account(acc, ...)` 按平台分发：
  - bilibili → 专属双流核心 `_fetch_posts_core`（视频+动态、归档边界、视频总数比对）
  - weibo 等单流平台 → 通用循环 `_fetch_platform_posts`（复用批量落库/去重/归档边界/
    定时任务让位/风控断点续抓/stop_reason/完成报告全链路）
- 全量（`async_fetch_all_posts`）、按名全量（`async_fetch_vtuber_posts`）、
  增量更新（`async_update_unarchived_posts`）均遍历**所有平台**账号。
- 风控统一走 `fetcher._detect_rate_limit`（HTTP 412/418/429 + json 风控文案），
  冷却/重试/断点续抓由 scheduler 兜底。

## 新平台接入步骤（以抖音为例）

1. **实现适配器**（`app/services/platforms/douyin.py`）：

```python
from app.services.platforms.base import BasePlatform
from app.services.fetcher import _client_ctx, _detect_rate_limit

class DouyinPlatform(BasePlatform):
    platform = "douyin"

    async def fetch_user_info(self, uid, client=None) -> dict | None:
        # → {name, sign, avatar, followers_count, url, ...附加字段}
        ...

    async def fetch_post_page(self, uid, page, client=None) -> dict | None:
        # 一页帖子流（时间倒序）→ {"items": [...], "has_more": bool}
        # item: {platform, platform_uid, platform_post_id,
        #        type(text/image/video/repost/article), title, summary,
        #        cover_url, permalink, body_json, stats_json,
        #        published_at(naive UTC), raw_json}
        ...

    async def enrich(self, item, client=None) -> bool:
        # 详情补全（就地修改 item），返回是否发起过网络请求
        ...

fetcher = DouyinPlatform()
```

2. **注册**（`registry.py`）：`_REGISTRY["douyin"] = douyin.fetcher`
3. **配置**（`app/core/config.py`）：`IMG_PROXY_ALLOWED_HOSTS` 追加该平台图床域名
4. **前端**：`PostsPage` 的 `PLATFORM_LABEL` 与添加账号弹窗的平台下拉各加一项；
   `tauri.conf.json` CSP `img-src` 追加图床域名。
5. **测试**：按 `tests/test_weibo.py` 模板补适配器单测（httpx mock + 映射 + 分发）。

## 微博接口速查（m.weibo.cn）

| 用途 | 接口 |
|---|---|
| 用户信息 | `GET https://m.weibo.cn/api/container/getIndex?type=uid&value={uid}` → `data.userInfo` |
| 微博列表 | `GET .../getIndex?containerid=230413{uid}_-_WEIBO_SECOND_PROFILE_WEIBO&page=N` → `data.cards[].mblog`（旧容器 `107603{uid}` 已失效，勿用） |
| 长文全文 | `GET https://m.weibo.cn/statuses/extend?id={mid}` → `data.longTextContent` |

- 请求头统一走 `weibo_auth.build_headers()`：iPhone UA + Referer + X-Requested-With + Cookie（扫码登录后自动携带）
- 类型映射：`pics`→image、`retweeted_status`→repost（origin 结构）、`page_info.type=video`→video、其余→text
- 时间：`created_at`（`%a %b %d %H:%M:%S %z %Y`）解析为 naive UTC；相对时间兜底
- 风控：HTTP 418/429 + `{"ok":0,"msg":"…频繁…"}`

## 扫码登录（B 站 / 微博统一 UI）

- 端点：`POST /auth/{platform}/qr/start` → `{qr_id, url|image}`；`GET /auth/{platform}/qr/check?qr_id=` 轮询（waiting/scanned/confirmed/expired/failed，confirmed 时后端同步完成取 cookie 并写入 `.env`）；`GET /auth/{platform}/status` 登录态
- 前端：TopBar 登录按钮（B 站会话过期红点徽章）→ `LoginDialog` 双 Tab（B 站用 react-qr-code 渲染 url，微博显示 base64 图）→ 2s 轮询 → 成功 toast
- B 站流程：generate → poll（qrcode_key）→ 回调 URL 种 SESSDATA 等 → nav 校验 → `.env`
- 微博流程：`passport.weibo.com/sso/v2/qrcode/image`（回退 `login.sina.com.cn` JSONP）→ check（50114001/50114002/20000000/50114004）→ `login.php?alt=` 种 SUB/SUBP 等 → crossDomainUrlList 补种 → `.env`
- `.env` 原子写共享：`app/services/env_store.py`（B 站 `auth.py`、微博 `weibo_auth.py` 共用）

## 使用方式（前端）

- 「添加账号」按钮（帖子面板总操作按钮组）：选择平台 + 输入 UID → 入库后自动抓取账号信息
- 「账号切换器」（操作按钮组行首）：同一 V 的 bilibili/微博账号间切换，
  帖子列表/统计/抓取按钮均跟随所选账号的 `(platform, uid)`
- 抓取帖子/更新动态按所选账号平台执行（`/vtuber/fetch-posts?platform=weibo`）
