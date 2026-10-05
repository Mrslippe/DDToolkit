# 365-20261006-扩展读不到指纹键的真凶是 host permission 的 scheme

> 上一批（`devlog/364`）把"读法"加到五趟里的**全量读**，理由是"host/path/分区由平台自己说了算"。
> 用户重新加载后再跑：**还是 4 / 22 条** ——
> `小红书：读到 4 条（URL 12 · 域扫 4 · 全量 4 · 分区 4）`。
> 而他在**同一个窗口**的 Console 里跑 `document.cookie`，`a1` / `s_v_web_id` 明明都在。

## 一、真凶：`https://` 的 host permission **看不见非 Secure 的 cookie**

cookies API 的可见性由 host permission 的 **scheme** 决定 —— MDN 的 cookies 权限表正面写着：
`http://*.example.com/` 能读**非 Secure** 的、**读不到 Secure 的**；`*://*.example.com/` 两种都能读。
反过来读同一张表：**`https://*.example.com/` 只能读到 Secure 的那一半**。

而平台那些**页面 JS 铸的指纹键**（小红书 `a1`、抖音 `s_v_web_id`、`odin_tt`、`d_ticket`…）
**多是非 Secure**（`document.cookie` 读得到就是证据之一）⇒ 它们对扩展**根本不存在**，
连 `getAll({})`（整库读）也看不见 —— 这解释了为什么"四趟读 + 整库读"全都只有 4 / 22 条，
也解释了为什么"URL 那一趟"同样漏（返回的每条 cookie 都要过**按 cookie 域 + Secure 标志**的权限检查）。

## 二、修法

- `manifest.json` 的四个平台权限从 `https://*.<域>/*` 改成
  **`*://*.<域>/*` + `*://<域>/*`**（两种 scheme + 裸域；`http://127.0.0.1/*` 不动）；
- 再加一趟 **按名取** `get({url, name})`（`logic.js::byNamePlan`：只问必需键与会用到的键，
  每个键 × 该平台每个 URL）—— 既补读，也把"这个键到底能不能问到"变成可读的答案；
- `describeCookie` 加 **`[非Secure]`** 标志：这类 cookie 就是被权限挡掉的那一类，
  诊断里必须一眼可见（上一轮就是因为它不可见才连猜三次）；
- 诊断第一行变成 `读到 N 条（URL a · 域扫 b · 全量 c · 按名 d · 分区 e）`，
  第二行 `按名取：a1=有@.xiaohongshu.com/`。

## 三、判据与反向验证

`node --test` **21 → 23**：新增「按名取的问法」（只问必需+会用到的键、每个键 × 每个 URL、
空平台不炸）与**权限清单对账**（四个平台必须同时有 `*://*.<域>/*` 与 `*://<域>/*`，
且**不许出现写死 scheme 的平台权限**——那正是这次的坑）；`describeCookie` 那条补 `[非Secure]`。
反向验证：把 `*://*.xiaohongshu.com/*` 改回 `https://…` ⇒ **正好那一条红**。

## 四、为什么没在本地先量出来（如实记）

本想先在**无头 Edge** 里用临时扩展量一遍（同一份 cookie 库、只差 host permission，A/B 对拍）。
实测这个 Edge 版本**根本不加载 `--load-extension`**：`--headless=new` 下扩展页直接
`ERR_BLOCKED_BY_CLIENT`，改成窗口模式 + 独立 `user-data-dir` 也一样（profile 的 `Preferences`
里一个扩展都没注册）；CDP 那条路（离屏窗口 + `--remote-debugging-port`）同样打不开扩展页。
⇒ 这条"想自动化驱动 MV3 popup 得先解决无头加载扩展"的结论已写进 `extension/README.md`。
本批的验证因此落在**用户真机下一轮**：重新加载扩展 → 看 `全量`/`按名` 两处是否出现
`a1` / `s_v_web_id`（`[非Secure]` 会标出来）。

## 五、前两批的结论怎么错的（教训）

两次都把"我们读不到"当成了"它不存在"或"环境不对"：
① 第一次靠 `len=2` 判掉"改名"之后，顺手推出"浏览器里没有"（跳了一步）；
② 第二次靠"四趟都读不到"推出"配置不是同一个"（再跳一步）。
**两次都缺同一样东西：一条"这个键到底在不在"的独立判据**（现在有了：按名取 + 权限清单对账）。
⇒ 凡是从"我们量不到"推到"世界上没有"，先问一句**我们的量具有没有盲区**。
