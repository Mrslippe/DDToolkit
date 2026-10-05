---
doc: plans/browser-extension-cookie-sync-execution
class: plan
scope: 浏览器扩展一键同步 cookie 的**分批执行方案**：E1–E5 每批的改动面、先补哪个会失败的判据、怎么反向验证、门禁与文档义务、停止条件与已知缺口
not-scope: 方案本身（为什么必须是扩展 / 权限面 / 分期动机）→ design/browser-extension-cookie-sync.md；各平台登录与能力现状 → backend/AUTH-CAPABILITIES.md；发版与打包 → ops/RELEASE.md
expires: 2026-12-31
---

# 浏览器扩展 · 一键同步各平台 cookie —— 分批执行方案（交给执行 Agent）

> 规格与动机 = `docs/design/browser-extension-cookie-sync.md`；**本文是执行细化**：
> 批次怎么切、每批动什么、**先补哪个会失败的判据**、怎么反向验证、门禁几档、什么时候停下。
> 文中"现状"与行号是 `2026-10-06` 的快照 —— **开工前重新 read 目标文件，别按本文行号改**。

## 0. 给执行 Agent 的指令

1. **一次只开一个会话改代码**（`docs/DEV-LOOP.md` §七）：一批一个提交、一批一次收尾。
2. **停止条件（§5）命中 ⇒ 停下报告**，不许自己放宽（尤其"为了让扩展跑通而放宽 CORS / 放宽鉴权"）。
3. **不引新依赖**：扩展侧**零构建、零 npm 依赖**（原生 ES module + HTML/CSS）；后端只用标准库与现有 httpx。
4. **两条假绿通道主动巡检**（`DEV-LOOP` §0.7）：① 替身形状与真身不同（`monkeypatch` 的假上游 / 假 status）；
   ② "没发请求"这类断言必须配正对照（先证明本来会发）。
5. ⚠️ **扩展本身没有自动化判据**（§9 已列成已知缺口）⇒ 每条"只能真机判"的必须写进手工清单**并真的跑一遍**；
   **不许拿"端点绿了"充当"扩展能用"**。
6. 本批碰路由契约 + 壳 + 前端三处 ⇒ **A 档门禁**，活文档按 §6 逐份同步。

## 1. 已拍板的四条口径（2026-10-06，用户）

| 决定 | 选定 | 影响 |
|---|---|---|
| **端口发现** | **直接做自动发现**：壳优先固定端口区间 `8765–8769`，扩展探测 `/healthz` 认领 | 要改 Rust 壳；P1 就零配置（不经过"手填"那一档）|
| **配对 token 寿命** | **持久化在数据目录**（重启不变，直到点「重置配对」）| 落 `app_meta`；扩展配一次长期有效 |
| **抖音 client hints** | **先不存** `sec-ch-ua`，记为已知缺口 | 落盘键与契约不动；`§9` 记缺口 |
| **同步范围** | popup 要有**「同步全部四个平台」** | 逐平台回执；一个平台失败不影响其余三个 |

> 另外两条由本方案定（低风险、与设计案 §5 的建议一致）：**配对 token 的展示位置 = 设置 → 登录里新增一栏**
> （与粘贴框同屏）；**商店上架（P4）不在本方案内**。

## 2. 范围与完成定义

### 2.1 做完长什么样

**浏览器里已经登录好四个平台时，点一次扩展 = 应用拿到可用的凭据，不用再开 DevTools 抄 Cookie。**

| 能力 | 改动前（2026-10-06） | 做完 |
|---|---|---|
| B 站凭据 | 只能**扫码**（`/auth/bilibili/qr/*`）；浏览器里已登录也得再扫一次 | 扩展直接推 `SESSDATA`/`bili_jct`/设备号… |
| 微博凭据 | 只能扫码 | 扩展推整条 cookie（**PC 域**，见 §3.3）|
| 小红书 / 抖音 | 手抄整条 Cookie（抖音还要手抄 UA）**粘进设置窗** | 扩展读（含 HttpOnly）+ 带上那个浏览器的 UA |
| 抄错/抄漏 | 缺键只在**抓取时**才炸（缺 `a1` → 签名器直接报错） | 导入那一刻就回执"缺哪个键"，**不落盘** |
| 过期 | 只能靠"抓取失败 + 通知"发现，然后重新手抄 | 同上，但重抄变成"点一下扩展" |

### 2.2 非目标（本方案不做）

见 §8。与设计案 §1 的分工：**规格问题回设计案，执行边界看本文。**

### 2.3 验收矩阵（先说清哪些验得了、哪些验不了）

| 只能机器判 | 只能真机判（写进手工清单，必须真跑） |
|---|---|
| `pytest`：`/auth/import` 的 401（无/错配对 token）· 403（非回环）· 400（缺键**且 `.env` 字节未变**）· 200（落盘 + 回执**只给键名不给值**）· 429（尝试过密）；`/healthz` 加字段后既有键不变 | **`chrome.cookies` 真的读得到 HttpOnly**（`SESSDATA`/`web_session`）——这是整个方案的前提 |
| `node --test extension/test/*.test.mjs`：cookie 拼接顺序、端口候选顺序、回执/缺键文案、平台 URL 表 | **扩展页面的 fetch 打到 `http://127.0.0.1:8765` 不被 CORS 拦**（`host_permissions` 生效）——**P1 第一件要实测的事**，不通就停下（§5）|
| `cargo test`：端口候选表的挑选与回退策略 | Chrome 与 Edge **各装一次**都能跑（同一份代码）|
| `vitest` + 探针：设置窗新区块（打码/显示/复制/重置确认）+ 既有 4 个 Tab 与凭据说明仍在 | **微博同步后浏览器里仍登录着**（见 §3.3 的坑）|
| `scripts/extension_smoke.py`：模拟扩展的请求序列（探测 → 认领 → 配对 → 四平台导入），端到端对 `.env` 与回执 | **同步完真的能用**：立刻抓一次该平台内容（不是"回执 200"就当过）| <!-- 未建 -->

## 3. 动手前必须先定死的技术决定

### 3.1 端点鉴权：`/auth/import` 必须"中间件放行 + 端点自带凭证"

现状（`app/core/api_auth.py`）：**所有**业务端点都要 `X-DDToolkit-Token`，而那是 Tauri 每次启动生成、
只注入给自家前端的（`devlog/201`）。扩展**拿不到、也不该拿到**它 —— 那个 token 等于整个 API 的钥匙。

⇒ 口径三条：

1. `PUBLIC_EXACT` 增加 `("POST", "/auth/import")`（与 `/img-proxy` 同族的"白名单条目"，**方法限死**）；
   注释里写清**为什么它敢公开**：端点自带第二凭证 + 只允许回环 + **只写不读**。
2. 端点内校验**配对 token**（§3.2）+ `client.host` 是回环。`is_loopback(host)` 做成纯函数（好测）。
3. **不进 `CORS_ORIGINS`** —— 普通网页发不出去（设计案 §3.3 第③条）。⚠️ 但**扩展自己**的 fetch
   走的是 `host_permissions` 的特权通道，**不受 CORS 约束** —— 这条是浏览器行为，**P1 第一件实测**（§2.3）。

> ⚠️ **2026-10-06 修正（E1 落地时读到的现况）**：本仓的 CORS 默认是 `"*"`，而且那是**有意**的
> （`devlog/201`《CORS 不是主防线》—— 拿不到 token 的网页即使读到响应也只是 401）。
> 所以**不要**给 `/auth/import` 写"响应里没有 `access-control-allow-origin`"这种判据
> （它必红），也不要为了扩展去动 CORS。这条端点的防线是**配对 token + 回环 + 节流**。

⚠️ 判据要**故意用错 token 建客户端**（`tests/test_api_auth.py` 的既有写法，`devlog/292`）：
防的是"以后有人把 `/auth/import` 从前缀白名单里放宽成 `startswith('/auth/')`"。

### 3.2 配对凭证：落点、寿命、传输、回执

| 项 | 口径 | 为什么 |
|---|---|---|
| 生成 | 首次需要时 `secrets.token_urlsafe(32)` | 不写进代码、不进日志 |
| 落点 | `app_meta` 键 `pairing.token`（`app_meta` 已是"小状态"的既有落点：已读集合 / 限流窗口）| 零迁移；随数据目录备份/迁移 |
| 寿命 | **持久**，只有用户点「重置配对」才换（新 token 立即生效，旧 token 立即失效）| 用户口径（§1）：不用每次开应用重配 |
| 传输 | 头 `X-DDToolkit-Pair`（**独立头**，不复用 `X-DDToolkit-Token`）| 两个凭证**不可能互相冒充**；也让"这条请求用的是哪把钥匙"在日志里一眼看得出 |
| 回执 | 只给 `keys`（键名列表）与"缺哪个"，**绝不回显 cookie 值**；`note` 给一句人话 | 回执会进日志/界面，值进去了就是二次泄露 |
| 防爆破 | 失败计数（内存，滑动窗口）超阈值 ⇒ `429`，并记一条 warning（**不记 token 片段**）| 端点公开 ⇒ 至少别让它成为无限次数的猜谜机 |

> ⚠️ 与设计案的差异：设计案 §3.1 把 token 放在 **body** 里。改成**独立头**，理由见上表；
> 设计案那一行随后同步（它自己写着"实现时按这些名字写"）。

### 3.3 四平台统一 `apply_cookie(cookie_str) -> (ok, why)`，且**先校验后落盘**

现状（`2026-10-06` read 过）：

| 平台 | 现在的入口 | 缺口 |
|---|---|---|
| 小红书 | `xhs_auth_manager.apply_cookie(cookie) -> (ok, why)` | ✅ 已"先校验再落盘"，直接用 |
| 抖音 | `douyin_auth_manager.apply_cookie(cookie, ua) -> (ok, why)` | ✅ 直接用（UA 一起收）|
| B 站 | **只有扫码路径**（`auth_manager._apply_cookies(dict)` 私有 + `check_session()`）| ⚠️ **要新写**一个公开的 `apply_cookie(cookie_str)` |
| 微博 | `weibo_auth_manager.apply_cookie(cookie, uid, name) -> None` | ⚠️ **没有校验**（直接 `_valid = True` + 落盘）⇒ 要补探活 |

统一口径（四家同形，端点里一张表分派）：

1. 把整条 cookie 串解析成 `name=value` 字典（**顺序保留**，`; ` 分隔，容忍多余空格）；
2. **临时应用**到内存 → 探活（bili `nav` / weibo `check_valid()` / xhs、douyin 用各自已有的校验）；
3. **成功才落盘**（`env_store.save_env_keys`），**失败必须还原内存里的旧值**（并且不碰 `.env`）；
4. 返回 `(ok, why)` —— `why` 就是给用户看的那句（例如"缺 a1 与 web_session"）。

⚠️ 两个真坑：
- **"先校验后落盘"在 bili 上是"临时应用 → 探活 → 失败还原"**：探活必须带着新 cookie 发出去，
  所以内存会被改；还原要**连 `.env` 一起不动**（`tests` 里有"失败后 `.env` 字节未变"的反向判据）。
- **微博是 PC 域**：`WEIBO_COOKIE` 只在 `weibo.com` 域有效（`services/platforms/weibo.py` 头部实测），
  所以扩展取微博 cookie 的目标 URL 必须是 `https://weibo.com/`。另外 `config.py` 写着
  "同一账号不允许多个网页端同时登录" ⇒ 手工清单里必须有一条**"同步完浏览器里微博仍登录着"**。

### 3.4 端口发现：固定区间优先 + `/healthz` 认领

现状：Tauri 壳 `frontend/src-tauri/src/lib.rs::free_port()` 每次绑 `127.0.0.1:0`（**随机**）⇒ 扩展猜不到。
口径：

1. 壳改成 `preferred_port()`：**依次试 `8765..8769`**（`TcpListener::bind` 成功即用），全被占才退回 `127.0.0.1:0`；
   `DDTOOLKIT_PORT` 仍可显式覆盖（探针/脚本路径不变）。
2. ⚠️ **探针与 `ui_probe.py` 继续用随机端口**：它会与**正在运行的应用**同时存在，去抢固定区间等于"两个实例互相挤"
   （`DEV-LOOP` 记一条）。
3. `/healthz`（公开）加一个**认领标识**：`"app": "ddtoolkit"`（**只加字段，不动既有键** —— 前端在轮询它，
   且它是"没有 token 时唯一能带出启动故障的通路"，见 `main.py` 的 docstring）。
4. 扩展探测：对四个候选端口依次 `GET /healthz`（超时 400ms）→ 命中 `app==="ddtoolkit"` 就记住（`chrome.storage.local`）。
5. ⚠️ **认到别的实例怎么办**：dev 与打包版可能同时开着（8765/8766 各一个）。端口不是身份，
   **配对 token 才是** ⇒ 探测到的实例上配对失败时，**继续试下一个候选**，全都失败才报"没找到应用/配对不对"，
   并把"试过哪些端口"显示出来（不静默）。

### 3.5 扩展读 cookie 的确定口径：`getAll({url})`，不是 `{domain}` 猜

| 决定 | 口径 |
|---|---|
| 读法 | ⚠️ **2026-10-06（用户实测后修正）**：**一个 URL 不够** —— 只读 `www.` 那一侧时小红书的 `a1`、抖音的 `s_v_web_id` 读不到（那一行的同步按钮只能是灰的）。**五趟取并集**：① 每个平台一组 URL（主站 + API 网关，如 `edith.xiaohongshu.com`）；② `getAll({domain})` 域扫描；③ **全量读** `getAll({})` + `getAll({partitionKey:{}})` 再按域过滤（`logic.js::cookiesForDomain`，过滤是硬安全阀）；④ **按名取** `get({url, name})`（`byNamePlan`：只问必需键与会用到的键）—— **真凶就在权限这一层**：host permission 只写 `https://` 时**读不到非 Secure 的 cookie**，而 `a1` / `s_v_web_id` 正好多是非 Secure ⇒ 连 `getAll({})` 都看不见（MDN 权限表正读）；定稿 manifest 用 **`*://*.{域}/*` + `*://{域}/*`**；⑤ 还缺必需键时带 `partitionKey` 再读一趟（分区 cookie/CHIPS）。按 `name + path + domain` 去重、先到的赢；判键名**不区分大小写**（与后端同一把尺子）。每趟的条数与报错都进诊断，`describeCookie` 带 `[非Secure]` 标志（`devlog/364`/`365`）|
| URL 表（+ 域扫描） | bilibili `api.bilibili.com/x/web-interface/nav` + `www.bilibili.com/` · weibo `weibo.com/` · xiaohongshu `www.xiaohongshu.com/explore` + **`edith.xiaohongshu.com/`** · douyin `www.douyin.com/` + `/discover` + `/user/self` |
| 去重 | **不按 name 去重**（同名不同 path 由平台自己处理）；多个 URL 的结果并集后再按 name+path 去重 |
| UA | douyin 额外带 `navigator.userAgent`（**扩展所在浏览器的**，这正是手抄最容易错的地方）|

### 3.6 扩展的代码形态

| 项 | 决定 |
|---|---|
| 位置 | 仓库根 `extension/`（与 `frontend/`、`scripts/` 平级；它是**第四个宿主**，同 `OVERVIEW.md` 的"宿主"口径）|
| 构建 | **零构建**：`manifest.json` + `popup.html` + `popup.css` + `src/*.js`（原生 ES module，`type="module"`）|
| 图标 | ✅ **2026-10-06 补上**：`icons/{16,32,48,128}.png` 由 `scripts/make_icons.py` 从 `docs/design/svg/LOGO.svg` **同一份源**生成（≤32 实心猫头 / ≥48 线稿猫 + 白色 ⇄）；`manifest.icons` 与 `action.default_icon` 都写全，`node --test` 有一条"四档都要在盘上"的判据 |
| 纯逻辑 | `extension/src/logic.js`（cookie 拼接 / 端口候选顺序 / 回执与缺键文案 / 平台 URL 表）**不 import 任何 `chrome.*`** ⇒ 能被 `node --test` 直接跑 |
| 稳定 id | `manifest.json` 里放 `key`（固定 dev id），扩展页面 URL 才是确定的 —— 自动化与排查都靠它。⚠️ **2026-10-06（E4）实测后搁置**：生成一对合法 SPKI 需要工具链，而 P1 没有"自动化驱动 popup"的需求（真机验收走手工清单）⇒ 先不写 `key`，缺口记在 `extension/README.md`；真要自动化时再补 |
| 存储 | `chrome.storage.local` **只放端口与配对 token**；cookie **只在内存**里过一手，随用随弃 |
| 权限 | `cookies` + `storage`；`host_permissions` 只列四个平台 + `http://127.0.0.1/*`；**不要** `tabs`/`scripting`，没有 content script |

## 4. 逐批方案

### 批次 E1 — 后端：配对凭证 + 统一导入端点（**地基**）

**改动面**：新增 `app/services/pairing.py`（生成/读取/重置/校验 + 失败节流）· <!-- 未建 -->
`app/routers/auth.py` 新增 `GET /auth/pairing`（要 S1 token，给设置窗读）·
`POST /auth/pairing/reset` · `POST /auth/import`（公开 + 自带配对校验）·
`app/core/api_auth.py` 白名单加一条 · `app/services/auth.py` 新增 `apply_cookie` ·
`app/services/weibo_auth.py` 补校验 · `/healthz` 加 `app` 标识。

**先补的判据（旧代码上必须是红的 = 404/不存在）**：`tests/test_auth_import.py`（新建）+ <!-- 未建 -->
`tests/test_api_auth.py`（补两条）：

1. 无/错配对 token ⇒ 401；**故意用错 token 建客户端**的那条放在 `test_api_auth.py`；
2. 非回环来源 ⇒ 403（`is_loopback` 纯函数 + 端点用例注入 `client=("1.2.3.4", 1)`）；
3. 小红书只给 `web_session`（缺 `a1`）⇒ **400 且 `.env` 字节未变**；
4. B 站有效 cookie ⇒ 200 且 `.env` 出现 `BILI_SESSDATA`（上游 `nav` 打桩）；
5. B 站无效 cookie（`nav` 回 `-101`）⇒ 400、`.env` 未变、**内存里的旧 sessdata 也还原**（反向判据）；
6. 微博探活失败 ⇒ 400 且未落盘（这条就是补上的那个缺口的判据）；
7. 回执**不含**提交的 cookie 值（结构判据：响应体里 grep 不到那段串）；
8. `/auth/import` 响应**没有** `access-control-allow-origin`；
9. `/healthz`：新增 `app` 字段，且**既有键一个不少**（契约用例）；
10. 失败节流：连续错 token 超阈值 ⇒ 429（用例里把窗口调小，别真等）。

**反向验证**：把 `app/services/auth.py` 的"失败还原"删掉 ⇒ 第 5 条必须红；把 `/auth/import` 加进
`PUBLIC_PREFIXES`（而非 `PUBLIC_EXACT`）⇒ 第 1 条必须红。

**收尾**：A 档门禁 · 活文档 `backend/HTTP-CONTRACT.md`（三个新端点）· `backend/AUTH-CAPABILITIES.md`（配对凭证 + 四平台统一入口）·
`GLOSSARY.md`（「配对令牌」「导入端点」）· devlog 一篇。

### 批次 E2 — 壳：固定端口区间 + 认领标识

**改动面**：`frontend/src-tauri/src/lib.rs`（`free_port()` → `preferred_port()`；候选表做成常量/可注入）·
`app/main.py` 的 `/healthz`（E1 已加字段，这里只复核）· `docs/dev` 侧记一条"探针继续随机"。

**判据**：Rust 单测三条 —— ① 区间内第一个可用就被选中；② 第一个被占则用第二个（用例里真的 bind 一个占住）；
③ 全被占 ⇒ 回退随机且**不 panic**。真机一条（写进手工清单）：开着应用再起第二个实例 ⇒ 落 `8766`。

**收尾**：`cargo test` · `desktop/SHELL.md`（端口策略与"为什么探针不抢固定端口"）· devlog 一篇（可与 E1 合并成一篇，但**两个提交**）。

### 批次 E3 — 设置窗口：「浏览器扩展」栏

**改动面**：`frontend/src/components/LoginDialog.tsx` 新增区块 `.lc-ext`（**不动** 4 个平台 Tab）·
`api.ts` / `types.ts` 接 `GET /auth/pairing` 与 `POST /auth/pairing/reset` · `posts.css`（或 login 那一族样式）。

**内容四条**：① 配对 token（**默认打码**，一枚「显示」、一枚「复制」）；② 「重置配对」（**二次确认**，
写清"扩展那边要重贴"）；③ 「上次同步」（平台 + 相对时间 + 键名列表，来自 `GET /auth/pairing`）；
④ 一段"怎么装这个扩展"（指向 `extension/README.md` 的步骤，别在界面里写长文）。

**判据**：`vitest` —— 打码/显示/复制（`navigator.clipboard` 打桩）/ 重置要确认 / 上次同步渲染 / **token 不整段进 DOM 文本节点（打码态）**；
探针 —— `--first-run`（登录浮窗仍有 4 个 Tab + "凭据仅保存在本机"）与 `--app-settings`（导航仍与后端分组一致）**都要照旧绿**。

**收尾**：`UI-MAP.md`（登录窗那一节）· devlog 一篇。

### 批次 E4 — 扩展本体（四个平台 + 一键全部 + 回执）

**改动面**：`extension/manifest.json` · `extension/popup.html` / `popup.css` / `src/logic.js` / `src/popup.js` ·
`extension/icons/*` · `extension/README.md`（装法与手工验收清单）· `extension/test/logic.test.mjs` ·
`scripts/check_extension.mjs`（或直接 `node --test`）· `scripts/extension_smoke.py`。 <!-- 未建 -->

**界面**：四行 = 平台 / 读到的键数与总长度 / 上次同步时间 / 一枚「同步」；顶部一枚**「同步全部四个平台」**；
底部一块「设置」（端口手填兜底 + 配对 token + 「重新探测」）。回执逐平台显示：**成功给键名列表**、
缺键给"缺哪个"、没登录给"这个浏览器里还没登录 → 去登录页"。

**判据**：
- `node`（纯逻辑，**不需要浏览器**）：cookie 拼接顺序与去重 · 端口候选顺序与超时 · 缺键文案 ·
  平台 URL 表与 `platforms/*.py` 的必需键清单一致（**这条要有**：后端加了必需键而扩展没跟上，症状是"同步成功但抓不到"）；
- `scripts/extension_smoke.py`：起开发后端 → 用 Python 复刻扩展的请求序列（探测 → 配对 → 导入四平台）→ <!-- 未建 -->
  断言 `.env` 与回执；⚠️ 它打后端**必须带开发态 token 头**（`tests/test_dev_token.py` 会扫，别栽在那条上）；
- 手工清单（`extension/README.md`，必须真跑）：Chrome + Edge 各一次完整流程 · 只登录部分平台 ·
  故意改错配对 token · 同步完立刻抓一次内容 · 微博同步后浏览器仍登录。

**收尾**：`OVERVIEW.md`（新增宿主）· `backend/HTTP-CONTRACT.md` 复核 · `UI-MAP.md`（凭据来源那句）· devlog 一篇（**本批是本方案的收口篇**）。

### 批次 E5 —（可选）过期闭环

cookie 失效时那条通知（`services/notices.py` 的 `login-expired` / 小红书 `invalidated`）现在的动作是
「去登录」。要做"点它直接开扩展 popup"，**先要改通知契约** —— `NoticeOut.action` 是**单数**
（`{label, kind}`），要变成"两个动作"就得动契约 + 前端渲染 + 探针。
⇒ **默认不做**；要做先按 A 档走（契约 + 迁移式兼容 + 判据），并单独开一批。

## 5. 停止条件（**必须停下报告**）

1. **扩展的 fetch 被 CORS 拦住**（`host_permissions` 不生效）⇒ 说明方案的地基不成立，
   回到设计案重选通道（**不许**为了让扩展跑通去放宽 `CORS_ORIGINS`）。
2. 需要**放宽鉴权**才能让扩展工作（例如"干脆把 S1 token 给扩展"）⇒ 停下，那是另一套威胁模型。
3. 需要**新依赖**（扩展侧 npm 包 / 后端的加密库）⇒ 停下。
4. 需要**改用户数据目录里 `.env` 的落点或格式**（凭据落点与备份口径是既有约定）⇒ 停下。
5. 发现某个平台**必须**注入页面脚本（content script）才能拿到凭据 ⇒ 停下（那会推翻"权限面最小"的口径）。
6. 要**上架商店 / 处理隐私政策**⇒ 超出本方案（§8），停下问。
7. 手工验收里出现"回执 200 但抓取仍失败"⇒ 停下，先把回执的判据补上再继续（**回执说谎比不回执更糟**）。

## 6. 每批收尾清单（照抄，别自由发挥）

1. `python scripts/gate.py --tier a` 全绿（E2 含 `cargo`；E4 另跑 `node --test` 与 `extension_smoke.py`）；
2. 活文档按 §4 每批列的那几份同步（改前先查 `.dsh/skills/ddtoolkit-docs-devlog/references/doc-map.md`）；
3. `python scripts/doc_check.py` 与 `docs_gate.py` 0 FAIL；
4. devlog 一篇（≤40 行；**只在真的跨层/影响不变量时**才写长）；
5. **一条提交**（`git add` 显式列文件，别 `git add -A`）；
6. 手工清单里本批新增的条目**真的跑过**，结果写进 devlog（跑了没跑、跑出什么）。

## 7. 推荐提交序列

| # | 提交 | 内容 |
|---|---|---|
| 1 | `feat(auth): 配对凭证 + POST /auth/import（四平台统一入口）` | E1 |
| 2 | `feat(shell): 后端优先固定端口区间 8765–8769 + /healthz 认领标识` | E2 |
| 3 | `feat(settings): 登录窗新增「浏览器扩展」栏（配对 token / 重置 / 上次同步）` | E3 |
| 4 | `feat(extension): MV3 扩展（四平台一键同步 cookie）` | E4 |

（E1 与 E2 可以一个会话里连着做，但**两个提交**：出问题时能单独回退。）

## 8. 本方案不做什么

- **商店上架**（Edge Add-ons / Chrome Web Store）、隐私政策、图标规范 —— 设计案 P4，另行决定；
- **content script / 注入页面**、后台常驻同步、定时自动同步（凭据过期就等用户点一下）；
- **客户端 hints**（`sec-ch-ua`）—— 已拍板先不存（§1），记在 §9；
- **改各平台的抓取链路**（本方案只解决"凭据怎么进来"）；
- **多用户 / 多机器**（本工具是单机个人工具，配对是"本机的一个浏览器"）。

## 9. 已知缺口（诚实清单）

| 缺口 | 影响 | 现在的兜底 |
|---|---|---|
| 扩展**没有自动化判据**（自动化驱动 MV3 popup + `chrome.cookies` 是新地，见 §0.5）| 扩展侧回归靠人 | 纯逻辑进 `node --test`（能覆盖的部分）+ 端点侧端到端冒烟 + 手工清单；**下批若要自动化，先评估 headless `--load-extension` 可行性**（不成则继续手工并记在这里）|
| `sec-ch-ua` 不存 | 平台若开始校验 client hints，抖音会失败 | 现有 UA 实测够用；缺口记在此处与 `design/browser-extension-cookie-sync.md` |
| 微博"同一账号不许多网页端同时登录" | 同步后可能出现"应用能用、浏览器被踢"或反之 | 手工清单里逐条确认；若真冲突，改为"微博不提供一键同步，保留扫码" |
| 端口区间被占满（5 个实例） | 回退随机 ⇒ 扩展探测不到 | 扩展显示"试过哪些端口 + 手动填端口兜底" |
| Cookie 过期仍要用户主动点扩展 | 不是全自动 | 通知里那句补救指引（"设置 → 登录"）后续可改成"点扩展"（E5）|
