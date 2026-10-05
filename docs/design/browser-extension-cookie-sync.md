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

- `POST /auth/import`：body `{platform, cookie, ua?}` + 头 **`X-DDToolkit-Pair`**；
  **只允许来自 127.0.0.1**（⚠️ 2026-10-06 定：配对 token **走独立头**，不放进 body —— 与
  `X-DDToolkit-Token` 是两把不同的钥匙，混在一个位置迟早有人拿错；见执行方案 §3.2）；
  校验配对 token（见 3.3）；**复用各平台已有的校验器**：
  - bilibili：`auth_manager` 那套（`SESSDATA`/`bili_jct`）——⚠️ 现在**只有扫码入口**，
    要补一个公开的 `apply_cookie(cookie_str)`（执行方案 §3.3）；
  - weibo：`weibo_auth_manager`（⚠️ 现有 `apply_cookie` **不校验**，要补探活）；
  - xiaohongshu：`xhs_auth_manager.apply_cookie()`（**已实现"先校验 `a1`+`web_session` 再落盘"**）；
  - douyin：`douyin_auth_manager.apply_cookie()`（含 `ua_configured`）。
  ⇒ 前端那三个"粘贴框"的校验逻辑**一行都不用重写**，扩展推来的就是同一个入口。
- 回执：`{ok, platform, keys: [...], missing: [...], note}` —— **只给键名与"缺哪个"，绝不回显值**；
  缺键时**如实说缺哪个**（扩展侧直接显示，用户不用猜）。
- 配对：设置 → 登录里加一栏「浏览器扩展」，显示**配对 token** +「复制」+「重置配对」。
  ⚠️ 2026-10-06 用户拍板：token **持久化在数据目录**（`app_meta`，重启不变，直到点「重置配对」）——
  不是原方案的"每次启动随机"（那会逼用户每开一次应用就重贴一次）。

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
- **读 cookie**：⚠️ 2026-10-06 定成**按目标 URL 取**（`chrome.cookies.getAll({url})`，每个平台一张 URL 表，
  按返回顺序拼 `name=value; …`）—— 理由：我们要的就是"浏览器发给那个平台的那条 Cookie 头"。
  ⚠️ **同日用户实测后修正：一个 URL 不够** —— 只读 `www.` 那一侧时小红书的 `a1`、抖音的
  `s_v_web_id` 读不到 ⇒ 每个平台读**一组** URL（含 `edith.xiaohongshu.com` 这类 API 网关）、
  **加一次域扫描**、缺键时再带 `partitionKey` 读一趟（分区 cookie）。
  ⚠️ **2026-10-06 晚再修正（`devlog/364`）：以上三趟都可能空手而归** —— 用户把 DevTools 里
  那条真 Cookie 头抄下来，里面有 `a1` / `s_v_web_id`，而扩展三趟加起来只有 4 / 22 条
  ⇒ host、path、分区这三件事**平台自己说了算**，靠"猜它挂哪儿"永远会漏。
  加一趟全量读 `getAll({})`（+ `getAll({partitionKey:{}})` 拿任意分区）**再按域过滤**
  （`logic.js::cookiesForDomain`：只留 `domain == 平台域` 或 `*.平台域`，
  **后缀必须是完整标签** ⇒ `evildouyin.com` / `douyin.com.evil.com` 不算）。
  ⚠️ 这一趟是**唯一"一次拿到整库"**的动作 ⇒ 过滤是硬安全阀（有用例专门盯泄漏），
  且每趟的**条数与报错**都要进诊断（读不到时要能说出是哪一趟空手而归）。
  ⚠️ **2026-10-06 深夜定稿（`devlog/365`）：全量读也没解决，真凶在权限那一层** ——
  cookies API 的可见性**由 host permission 的 scheme 决定**：只写 `https://*.<域>/*` 时
  **读不到非 Secure 的 cookie**（MDN 那张权限表：`http://*.example.com/` 能读非 Secure 的、
  读不到 Secure 的；`*://*.example.com/` 两种都能读），而平台页面 JS 铸的指纹键多是非 Secure
  ⇒ 连 `getAll({})` 都看不见它们。定稿：**`*://*.{域}/*` + `*://{域}/*`（四平台各两条）**
  ＋一趟**按名取**（`get({url, name})`，只问必需键与会用到的键，`logic.js::byNamePlan`）
  ＋诊断里加 `[非Secure]` 标志与逐个键的"能不能问到"。细节见执行方案 §3.5；
- **UA**：抖音需要"那个浏览器的 UA" ⇒ 直接 `navigator.userAgent`（**必须取自扩展所在的浏览器**，
  这正是手抄最容易错的地方）；
- **POST**：`fetch('http://127.0.0.1:<port>/auth/import', {method:'POST', body})`；
  端口从哪来：**应用把端口写进一个众所周知的文件**？不行（扩展读不到文件）。
  ⚠️ 2026-10-06 用户拍板：**直接做自动发现** —— 桌面壳改成**优先绑固定区间 `8765–8769`**（全占用才退回随机），
  `/healthz` 带一个应用标识，扩展依次探候选端口并**用配对 token 认领**（端口不是身份、token 才是）；
  手填端口只作为兜底留在扩展设置里（见执行方案 §3.4）。
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
| P1（最小可用） | 应用侧 `/auth/import` + 配对 token + 设置里的「浏览器扩展」栏；扩展 popup 四个平台 + 端口自动发现 | 一键同步四个平台（含抖音 UA），零配置 |
| P2 | 上次同步时间、缺键提示、扩展设置里的手填端口兜底 | 更好用 |
| P3（可选） | 过期提醒：应用侧 cookie 失效时（例如 `devlog/353` 那条小红书判定）发一条通知，点它直接开扩展 popup；扩展侧"该平台当前没登录"预检 | 闭环 |
| P4（可选） | 商店上架（Edge Add-ons / Chrome Web Store）、图标与隐私说明（`cookies` 权限必须写用途）| 分发 |

> ⚠️ **2026-10-06 起"怎么做"不在这份文档里**：分批、判据、停止条件、已知缺口见
> **`docs/plans/browser-extension-cookie-sync-execution.md`**（本文只留"为什么这样设计"）。

## 5. 待拍板的点 —— **已于 2026-10-06 拍完**（留档）

1. **端口** ⇒ **自动发现**（壳优先绑 `8765–8769`，扩展探 `/healthz` 认领，`§3.2` 已同步）；
2. **token 展示** ⇒ 「**设置 → 登录**」新一栏（与粘贴框同屏）；
3. **抖音 client hints** ⇒ **先不存** `sec-ch-ua`，作为已知缺口记在执行方案 §9；
4. **同步范围** ⇒ popup 要**「同步全部四个平台」**（逐平台回执，一个失败不影响其余）。

## 6. 与现状的接口（实现时按这些名字写，别新造）

- 凭据落盘：`app/services/env_store.py::save_env_keys`
- 四个平台的校验/落盘入口：`services/auth.py`（bili，**要新增 `apply_cookie`**）、
  `services/weibo_auth.py`（**补校验**）、`services/xhs_auth.py::apply_cookie`、
  `services/douyin_auth.py::apply_cookie`
- 端点风格与鉴权：`app/routers/auth.py`（现有 `POST /auth/{platform}/cookie` 就是同族，
  新增的 `/auth/import` 应当是**它们的批量化**，不是另一套语义）
- 设置界面：`frontend/src/components/LoginDialog.tsx`（四个 Tab 的粘贴框就在这里，新栏加在它下方）
