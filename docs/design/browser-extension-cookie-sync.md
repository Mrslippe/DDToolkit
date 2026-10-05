---
doc: design/browser-extension-cookie-sync
class: plan
scope: 浏览器扩展（Edge/Chrome，MV3）一键把各平台 cookie 同步进 DDToolkit 的**方案**：为什么必须是扩展而不是油猴脚本、本地端点 + 一次性配对令牌的形状、扩展侧的权限与流程、分期与待用户拍板的点
not-scope: 各平台凭据现在怎么贴、怎么判过期 → backend/AUTH-CAPABILITIES.md；各平台抓取链路本身 → backend/PLATFORMS.md；发版与打包动作 → ops/RELEASE.md
expires: 2026-12-31
---

# 浏览器扩展：一键同步各平台 cookie 到 DDToolkit

> 用户 2026-10-05：「我想做一个浏览器插件或者浏览器脚本，主要是 edge 和 chrome，用来方便的获取
> 应用中需要的 cookie 并同步」+ 选择「**本地 HTTP 端点 + 扩展直接推送**」。
> **本文只是方案，不含实现**（用户：「先不执行给我方案」）。

## 1. 要解决什么

现在每个平台的凭据都得**手动从 DevTools 里抄整条 Cookie，再粘到设置窗口**：

| 平台 | 需要的键 | 现在怎么拿 |
|---|---|---|
| B 站 | `SESSDATA` + `bili_jct`（+ `DedeUserID` / `buvid3` / `refresh_token` 更完整）| 复制整条 Cookie 头 → 设置 → 登录 → B 站 |
| 微博 | 整条 Cookie（`SUB` 等，271 字符）| 同上 |
| 小红书 | 整条（**至少 `a1` + `web_session`**，实测 856 字符）| 同上（devlog/233） |
| 抖音 | 整条（**`s_v_web_id` + `uifid` + `ttwid`**，实测 6356 字符）**外加那个浏览器的 `navigator.userAgent`** | 同上（devlog/333） |

痛点有三：① 抄错/抄漏键（缺 `a1` 时签名器直接报 `Missing 'a1' in cookies`）；② 抖音还要手抄 UA；
③ **cookie 会过期**（小红书那条实测活了 ~2–3 天），每换一次都要再抄一遍。

## 2. 关键约束（决定方案形状）

1. **必须要"扩展"，不能只做 userscript**：`SESSDATA` / `web_session` 这些是 **HttpOnly**，
   `document.cookie` 读不到 —— 油猴脚本只有在少数浏览器 + `GM_cookie` 下才摸得到。
   Chrome/Edge 的 MV3 扩展有 `chrome.cookies` API，**能读 HttpOnly**（这是官方能力，不是绕过）。
2. **只在本机通信**：扩展与应用的通道绑 `127.0.0.1`，且要**一次性配对 token**，
   不能让"任何本地进程/网页"都能往里灌 cookie（那是把凭据送人的口子）。
3. **不落明文到别处**：cookie 只走"浏览器 → 应用"这一跳，应用侧写入沿用现成的
   `env_store.save_env_keys`（数据目录 `.env`，已有先例），扩展**不持久化** cookie
   （只放内存，可选 `chrome.storage.session`）。
4. **两个浏览器一套代码**：Edge 与 Chrome 都是 Chromium MV3 ⇒ **同一份扩展**，两边都能装
   （Edge 走"加载解压缩的扩展"/企业策略，Chrome 同上；上架商店是后话）。

## 3. 架构

```
[浏览器: 各平台已登录]                     [DDToolkit 桌面应用]
  content script / popup                    FastAPI 后端（已存在）
        │  chrome.cookies.getAll({url})          │
        │  （能读 HttpOnly）                      │
        ▼                                        ▼
   扩展 popup（列出四个平台 + 同步按钮）
        │  fetch POST http://127.0.0.1:<port>/auth/import
        │  { platform, cookie, ua?, token }
        └──────────────────────────────────────────► 新端点：校验 token → 分平台校验键
                                                        → save_env_keys → 回执（哪些键、长度）
                                                              │
                                                              ▼
                                                     设置窗口显示「刚刚同步」
```

### 3.1 应用侧（新增，约 1 个端点 + 1 个配对界面）

- `POST /auth/import`：body `{platform, cookie, ua?, token}`；**只允许来自 127.0.0.1**；
  校验 `token`（见 3.3）；**复用各平台已有的校验器**：
  - bilibili：`auth_manager` 那套（`SESSDATA`/`bili_jct`）；
  - weibo：`weibo_auth_manager`；
  - xiaohongshu：`xhs_auth_manager.apply_cookie()`（**已实现"先校验 `a1`+`web_session` 再落盘"**）；
  - douyin：`douyin_auth_manager.apply_cookie()`（含 `ua_configured`）。
  ⇒ 前端那三个"粘贴框"的校验逻辑**一行都不用重写**，扩展推来的就是同一个入口。
- 回执：`{ok, platform, keys: [...], missing: [...], note}` —— 缺键时**如实说缺哪个**
  （扩展侧直接显示，用户不用猜）。
- 配对：设置 → 登录里加一栏「浏览器扩展」，显示**本次配对 token**（应用启动时随机生成，
  写在 `app_meta`/内存里）+「复制」按钮；扩展那边粘一次就记住了。

### 3.2 扩展侧（MV3）

```jsonc
// manifest.json（要点）
{
  "manifest_version": 3,
  "permissions": ["cookies", "storage", "notifications"],
  "host_permissions": [
    "https://*.bilibili.com/*", "https://*.weibo.com/*",
    "https://*.xiaohongshu.com/*", "https://*.douyin.com/*",
    "http://127.0.0.1/*"                      // ← 只回环，别写 "*://*/*"
  ],
  "action": { "default_popup": "popup.html" }
}
```

- **popup**：四行（B站 / 微博 / 小红书 / 抖音），每行显示"当前读到的键 / 长度 / 上次同步时间"，
  一枚「同步到 DDToolkit」；
- **读 cookie**：`chrome.cookies.getAll({ domain })` 逐个平台取（`bilibili.com` 要同时取
  `.bilibili.com` 与 `bilibili.com` 两种 domain 写法；拿 `.xiaohongshu.com` 同理）；
- **UA**：抖音需要"那个浏览器的 UA" ⇒ 直接 `navigator.userAgent`（**必须取自扩展所在的浏览器**，
  这正是手抄最容易错的地方）；
- **POST**：`fetch('http://127.0.0.1:<port>/auth/import', {method:'POST', body})`；
  端口从哪来：**应用把端口写进一个众所周知的文件**？不行（扩展读不到文件）。
  两条可行路：
  - **固定端口候选表**（如 8765/8766/8767）：扩展依次试 `/healthz`（回一个应用标识）⇒ 找到就记住
    （推荐：零配置，且 `127.0.0.1` 上抢端口的成本很低）；
  - 用户在扩展里手填端口（最笨但最稳，作为兜底）。
- **不注入任何页面脚本**（不需要 content script）⇒ 不碰页面 DOM、不申请 `scripting`/`tabs`，
  扩展权限面越小越好（只碰 cookie + 回环 HTTP）。

### 3.3 安全（这一节是方案的重点，不是附录）

| 风险 | 处理 |
|---|---|
| 别的东西往应用里灌假 cookie | ① 只绑 `127.0.0.1`；② **一次性配对 token**（应用生成、显示在设置里、可重置）；③ 端点**不放进** CORS 白名单（浏览器页面发不出去）|
| 扩展被别的东西调用 | MV3 默认 `externally_connectable` 为空 ⇒ 只有扩展自己的 popup 能发；`host_permissions` 只列那四个平台 + 回环 |
| cookie 落盘位置 | 仍然是应用的数据目录 `.env`（与今天人手粘贴**同一个落点**，权限/备份口径不变）；扩展只放内存 |
| token 泄露 | 只在本机显示 + 可一键重置（旧 token 立即失效）；不写日志（沿用 `logging_setup` 对凭据的脱敏口径） |
| 误点 | 同步前在 popup 里显示"将写入哪些键"，且**只写不删**（清理由用户在设置里做）|

## 4. 分期

| 阶段 | 内容 | 产出 |
|---|---|---|
| P1（最小可用） | 应用侧 `/auth/import` + 配对 token + 设置里的「浏览器扩展」栏；扩展 popup 四个平台 + 手动填端口 | 一键同步四个平台（含抖音 UA）|
| P2 | 端口自动发现（候选表 + `/healthz` 标识）、上次同步时间、缺键提示 | 零配置 |
| P3（可选） | 过期提醒：应用侧 cookie 失效时（例如 `devlog/353` 那条小红书判定）发一条通知，点它直接开扩展 popup；扩展侧"该平台当前没登录"预检 | 闭环 |
| P4（可选） | 商店上架（Edge Add-ons / Chrome Web Store）、图标与隐私说明（`cookies` 权限必须写用途）| 分发 |

## 5. 需要用户后续拍板的点（实现前再确认）

1. **端口**：走 P1 的"手填"还是直接做 P2 的"自动发现"（我建议直接 P2，成本差不多）；
2. **token 展示**：放「设置 → 登录」新一栏，还是放「关于」页（我建议前者，与粘贴框同屏）；
3. **抖音 UA**：要不要顺手把 `sec-ch-ua` 那几项也存下（现在只存 UA；实测签名只吃 UA，
   但如果哪天平台开始看 client hints，这里是个已知缺口）；
4. **同步范围**：是否需要"一次同步全部四个平台"的按钮（否则默认一个一个来）。

## 6. 与现状的接口（实现时按这些名字写，别新造）

- 凭据落盘：`app/services/env_store.py::save_env_keys`
- 三个平台的校验/落盘入口：`services/auth.py`（bili）、`services/weibo_auth.py`、
  `services/xhs_auth.py::apply_cookie`、`services/douyin_auth.py::apply_cookie`
- 端点风格与鉴权：`app/routers/auth.py`（现有 `POST /auth/{platform}/cookie` 就是同族，
  新增的 `/auth/import` 应当是**它们的批量化**，不是另一套语义）
- 设置界面：`frontend/src/components/LoginDialog.tsx`（三个 Tab 的粘贴框就在这里）
