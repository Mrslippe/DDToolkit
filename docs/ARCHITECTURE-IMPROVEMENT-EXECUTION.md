# DDToolkit 架构改进 · 核实后的分批执行方案

> 状态：**待执行**。本文件是 `docs/ARCHITECTURE-IMPROVEMENT-PLAN.md` 的**执行细化**，不是真源。
> 核实日期：**2026-09-25**（本文件里所有"现状"结论都是这一天沿真实调用链读出来的，带行号；行号是快照，不要照抄）。
> **修订记录**：**rev 2（2026-09-25）** —— 用户确认三条产品口径（**很多人用** / **即将接入小红书与抖音** / **继续发版**）后，重排了执行顺序、翻转了 S2 与 Q2 的定性、砍掉了 M2/M3 的整体拆分、新增了**批次 16（升级与迁移安全）**，并把平台采集相关工作移入"等调研结论"的第 4 阶段。改动集中在 **§1**，其余各批正文里加了 `⚠️ 2026-09-25 修正` 标注。
> 纪律：**本文件不得成为规则真源**——不变量落 `docs/ARCHITECTURE.md` §6，门禁口径落 `scripts/`，测量值一律指向真源（`python scripts/gen_doc_numbers.py --list` / `docs/TODO.md` §6.2）。本文件只回答"**先做哪个、改哪里、怎么变红、什么时候算完、什么时候必须停**"。

---

## 0. 给执行 Agent 的指令（母计划 §0 之上补五条）

母计划 §0 的九条全部继续有效。核实之后补这五条，它们是本次核实的**主要产出**：

1. **本仓一次只开一个会话改代码**（`docs/DEV-LOOP.md` §七）。"分批执行"= 一批一个会话、一批一次收尾，**不是**并行推进。
2. **开工前不要相信行号。** 核实发现 `scheduler.py`（3487 行，母计划写 ~2670）、`routers/vtuber.py`（1315，写 ~964）、`repositories/vtuber_repo.py`（1353，写 ~1114）、`PostsPage.tsx`（1066，写 ~857）都比母计划描述的更大。重新 `read` 目标函数，别按本文件的行号直接改。
3. **两条假绿通道，拆分批上必须主动巡检**（本次核实最值钱的两条）：
   - **后端**：全仓 **86 处** `monkeypatch.setattr(sch|scheduler, <名字>, ...)`。函数搬进新模块后若仍按本模块名字调用同族函数，patch **静默失效** ⇒ 测试照旧全绿，那条断言什么都没验。
   - **Tauri**：`build.rs` 是裸 `tauri_build::build()`（无 app manifest）⇒ 按 `tauri-2.11.5` 的 `webview/mod.rs:1819-1852`，**应用自定义命令默认不查 ACL**，main 与 widget 两扇窗对 21 条命令**完全等价可达**。⇒ **只拆 `capabilities/*.json` 的安全收益≈0**，必须同时加 Rust 侧 caller label 校验。
   两条的处理方式相同：**改坏它，必须变红**（`docs/DEV-LOOP.md` §6.4）。
4. **每批只报告母计划 §7 那张表要求的东西。** 不写叙述性长文；成本口径见 `docs/DEV-LOOP.md` §0.5。
5. **本文件里的每个"必测"都写清了反向验证怎么做。** 只跑一遍看它是绿的，不算做过。

---

## 1. 批次总表（2026-09-25 二次修正：按"会不会真的吃亏"重排）

**三个产品口径已确认**（用户 2026-09-25 拍板）：① 目标是**很多人用**的工具；② **小红书 / 抖音即将接入，后续可能还有**；③ **会继续发版**。这三条改掉了几处定性，见 §1.3。

### 1.1 执行顺序（照这个顺序做，批次编号保持不变以便与母计划 / 核实记录对照）

```text
第 0 阶段 · 地基（与用户量无关，本来就要做）
  0.1  依赖锁定 + 门禁脚本补 Rust/CI 预检        ← 必须最先：现在没有可复现的基线
  0.2  CI（Windows leg 才是真价值）+ 前端测试环境  ← 与 0.1 同批收尾

第 1 阶段 · 会丢数据 / 会泄凭据（按严重度，不按母计划顺序）
  4c   S3-C 安全删除旧数据目录                   ← 一次调用不可逆，且今天是单击即删
  1    S1 会话 token：Rust 生成 + 后端校验        ← .env 里是活凭据；也是 S2 的使能前提
  2    S1b 前端启动等待 + token 注入 + 真机验证
  ★新★ 16  升级 / 迁移安全 + 诊断包               ← 母计划完全没有；"继续发版"把它顶到高
  3    S2 平台 HTML 白名单净化                    ← 已从"顺手修"升为必做（见 §1.3）
  4ab  S3-A/B 命令 label 校验 + capability 分窗 + 外链白名单

第 2 阶段 · 稳定性与正确性（有用户之后优先级回升）
  5    R2 FetchStatusStore 并发一致性             ← 含两个"改了设置不生效"的真实 bug
  6    R1 调度生命周期可停止                      ← 第 4 阶段的前置
  7    R3 事务边界收口 → **只做五个流程的失败用例 + 修 (c)**，不做 69 处重构（见 §1.3）
  8    M1a 依赖方向（normalize_title 下沉 + 仓库层平台硬编码）
  11b  M3 背景上传加固（**只做这一半**，router 不拆）
  15   Q3 文件 SQLite 并发 + Windows 真机 smoke

第 3 阶段 · 有用户之后才成立
  13   Q1 ApiError + 解析校验（契约生成暂缓，等第二个消费方）
  14   Q2 可访问性（分三段相位推进）
  12   M4 拆三台 hook —— **且必须"抽 hook 同时带出 hook 测试"**，否则不做

第 4 阶段 · 等调研结论（现在一行代码都别写，见 §1.4）
  9    M1b 平台采集能力 —— 前提已被推翻，必须重新设计
  12x  B站双流从 scheduler 隔离
  10   M2 scheduler 整体拆分
  11a  M3 router 拆分
```

### 1.2 依赖硬约束（违反就会出现"改了但验证不到"）

| 约束 | 原因（已核实） |
|---|---|
| 0.1 → 其它全部 | `requirements.txt` 全是 `>=` 且**无锁文件**（无 `uv.lock` / 无 `pyproject.toml` / 无 `requirements.in`）⇒ 干净环境装出来的是"当天最新"。对比：`frontend/package-lock.json`（235KB）与 `frontend/src-tauri/Cargo.lock` **都已入库**。"继续发版"让它从"最好有"变成硬要求：**发出去的版本必须可复现** |
| 0.2 → 12 / 13 / 14 | vitest **无配置**（`vite.config.ts` 没有 `test` 段）⇒ 走默认 `environment: 'node'`；`@testing-library/react` / `user-event` / `jest-dom` / `jsdom` / `happy-dom` / `axe-core` / `vitest-axe` **实测全部不存在**；42 个测试文件**全是 `.test.ts`，0 个组件测试** |
| 1 → 2 | 后端先能校验，前端注入才有东西可验 |
| **4c → 1** | 4c 是唯一"一次调用毁掉别人档案"的项；token 是理论攻击面。**先修不可逆的** |
| **16 → 后面所有发版** | 16 之前，任何一次迁移炸掉都是**别人的**档案，而且你够不着、无法远程诊断 |
| 1 → 3 | token 是 S2 的**使能前提**：没有 token，净化器只是纵深；有了 token，它才是"防绕过唯一那道锁" |
| 5/6 → 10 / 12x | `scheduler.py` 现在 **4 条线程、5 处不可中断 `time.sleep`、tier 线程完全没有停止手段**（`while True:` + `time.sleep`，无 stop 标志）⇒ 先拆再修等于在流沙上做手术 |
| 11a → 13 | 拆 router 会改变 OpenAPI 的 `operationId`，契约门禁必须在拆分之后才可能稳定 |

### 1.3 三个口径带来的定性翻转（相对母计划）

| 项 | 母计划 | 修正后 | 为什么 |
|---|---|---|---|
| **S2 HTML 净化** | 安全批次的一项 | **必做，不再降级** | 别人的机器上渲染平台给的 HTML。出事不再是"你自己机器上的理论风险" |
| **Q2 可访问性** | 与其它并列 | **该做，但排在数据安全之后**；axe/RTL 那套基建优先级最低 | 有真实用户就有真实键盘用户。但它仍是全计划投入产出比最低的一条（成本全在验证侧），所以是"该做、别最先"，**不是"不做"** |
| **Q1 API 契约** | 生成 DTO + 门禁 | **只做 `ApiError` + 解析校验**；生成放最后 | 有用户后理由从"防我自己改名"变成**兼容性**——每个版本都有人停在上面。但生成管道是新增会漂的东西，先做便宜的那半 |
| **R3 事务边界** | 收口 69 处 commit | **只补 5 条失败用例 + 修 (c)** | (a)(b)(d)(e) 四个流程**靠"仓库末尾顺手 commit"恰好是原子的**（逐条追过）。给这个规模的工具引入 application service 层是过度设计；**先补用例，再决定要不要动结构** |
| **M1b 平台 capability** | 加 10 个能力成员 | **必须重新设计，不是加成员** | 现有 `BasePlatform` 的三个前提（HTTP-only / 有稳定 uid / cookie 鉴权）对抖音小红书**全不成立**。而且**先落平台、后提炼**才对（见 §1.4） |
| **M2 scheduler 拆分** | 拆成 8 个文件 | **搁置**；只做 §1.4 那一刀 | 风险（6 对双向纠缠 + 86 处 monkeypatch + conftest 读写模块全局）**随用户量上升而放大**，收益仍是审美性的 |
| **M3 router 拆分** | 拆成 7 个文件 | **只做背景上传加固** | 收益是"文件更短"；风险是 `include_router` 顺序（错了静默 422）、`api_route` 计数门禁、`img_proxy` 三个符号必须再导出、6 处 monkeypatch 打在 router 模块属性上 |
| **升级 / 迁移安全** | 母计划未列 | **★新增批次 16★** | "很多人用" + "继续发版" ⇒ 迁移失败是**别人的**档案丢失，且你无法远程诊断 |

### 1.4 ⚠️ 平台接入的前提已被推翻（这一节决定第 4 阶段的形状）

**用户口径（2026-09-25）**：新平台是**小红书、抖音**，后续可能还有；**采集引擎选型（A 纯 HTTP 逆向签名 / B 真实浏览器驱动 / C 混合）用户决定延后，等调研完这两个平台的抓取策略再定。**

**核实到的现状**：
- 全仓对抖音 / 小红书**零基础**（`grep 抖音|小红书|douyin|xiaohongshu` 零命中）。
- **数据模型能直接容纳它们，不用改表**：`Account.platform_uid` 是 `String`，唯一键 `(platform, platform_uid)`；`platform` 列注释本来就写着 `bilibili / youtube / twitter ...`。
- ⇒ 卡点**不在存储层**，在**采集层**。

**为什么现在不能设计 `BasePlatform` 的能力成员**：现有接口的隐含前提是「**有稳定字符串 uid + 直接用 `httpx` 带 Cookie 打接口**」。这两个平台三条全不成立 —— 需要**签名头**（抖音 `a_bogus` / `X-Bogus`、小红书 `x-s` / `x-t`，算法混淆且会变）、**没有用户会输入的稳定 uid**（用户手上只有抖音号 / 小红书号这种可变 ID）、**大量接口只对真实浏览器会话开放**。⇒ 现在凭空设计接口，是在没看过第二个平台的情况下猜，**只会猜错**。**正确顺序：先用现有 `BasePlatform` 尽量写，看哪里必须改，落完之后再提炼。**

**第 4 阶段的两条硬边界（调研结论回来之前不要动）**：
1. **采集引擎会不会是"非 HTTP"的**（浏览器驱动）。这条决定 `BasePlatform` 的接口长相，也决定调度生命周期要不要为"浏览器采集器"另起一套。
2. **`BasePlatform` 是否需要一个"不支持则结构化返回"的统一出口**。现有 unsupported 路径是**静默丢弃**（T0 的 `isdigit()` 过滤连 `result.failed` 都不计），新平台一上来就会踩这条。

**调研结论回来后，第 4 阶段的顺序固定为**：① 把 B站专属双流逻辑从 `_fetch_posts_core` 隔离成平台适配器（**这一刀的目标不是"支持新平台"，而是"让 scheduler 不再假设自己是 B站"**）；② 测试按平台参数化（好消息：只有 **2 处**把平台集合钉死——`tests/test_capabilities.py:42`、`tests/test_services.py:2129`）；③ 修 3 处平台分支 bug（`capabilities._logged_in:122` 的 `else weibo`、`routers/vtuber.py:947` 的越权闸门、`scheduler.py:2656` 的 T0 平台过滤）；④ 接**一个**平台端到端打通；⑤ 落完之后再提炼 capability。

**分期建议**（用户量 + 发版 + 新平台三条同时成立时，风险是"**承诺**"不是"技术债"）：先只把**一个**平台做到"能登录 + 能抓账号信息 + 能抓帖子流"（**不含直播、不含第三方源、不含日历**），发一个 beta 给人试。这条路两周能拿到真反馈，而不是两个月后拿到"两个平台都半成品"。

**另有一条产品级风险，代码改不动它**：抖音 / 小红书会**封号**，风控比 B站凶得多（B站 412 是 IP 级且**不连累登录态**；这两家会打到**用户自己的账号**上）。很多人各自采集，风险落在用户账号上。加上"很多人用"之后，**默认节流参数需要按"很多人同时用"重定** —— 这是独立的口径决策，不属于任何一个代码批次，与调研结论一起定。

---

## 2. 与母计划不一致的十七处（核实结论）

> 逐条给证据。**§2.2 / §2.3 是"母计划会做成假绿或做出回归"的两条，请优先读。**

### 2.1 CSP 已经比母计划写的强 —— S2 的威胁模型要改口径

`frontend/src-tauri/tauri.conf.json` 现为：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
font-src 'self' data:; img-src 'self' http://127.0.0.1:* https://*.hdslb.com ... blob:;
connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:*
```

- `script-src 'self'` **没有 `unsafe-inline` / `unsafe-eval`** ⇒ 注入的 `<script>`、`onerror=`、`javascript:` 在**真机上本来就被 CSP 挡**（`bootDiag.ts` 头部记过内联脚本被它拦掉的教训）。
- `style-src 'self' 'unsafe-inline'` ⇒ **注入的 `<style>` 与 `style=` 会生效**。
- `connect-src` 只允许本机 ⇒ 外传通道受限。
- 未声明 `object-src` / `base-uri` / `frame-ancestors`；无 `devCsp`。

**⇒ S2 的真实剩余风险是三层**：① **UI 伪装 / 点击劫持**（注入 CSS 把危险操作做成显眼的下一步）——**真风险，CSP 管不了**；② **开发态浏览器里渲染未净化 HTML**（`npm run dev` 走 Vite，未在真机核实 CSP 是否生效）；③ 将来任何一次**放宽 CSP** 会让 S2 从"纵深防御"变成"唯一防线"。

**执行要求**：S2 批次的 devlog **不要把"防 XSS"当唯一卖点**；要写"防的是样式注入导致的 UI 伪装 + 为将来放宽 CSP 留闸门"，并且**净化边界与 CSP 复核（diff 应为空）写进同一篇**。

### 2.2 ⚠️ 只拆 capability 是假绿：自定义命令默认不走 ACL

`build.rs` 全文只有裸 `tauri_build::build()`（无 `Attributes::app_manifest`）。按 vendored `tauri-2.11.5/src/webview/mod.rs:1819-1852`：

```rust
// Check ACL on plugin commands, when the app defined its ACL manifest,
// or when the request comes from a non-local (remote) origin.
if (plugin_command.is_some() || has_app_acl_manifest || !is_local) && ... {
    invoke.resolver.reject(format!("Command {} not allowed by ACL", request.cmd));
```

本仓 `has_app_acl_manifest == false`，两扇窗都是本地 origin ⇒ **21 条命令对 `main` 与 `widget` 完全等价可达**。仓库自己的注释也记着（`lib.rs:977-978`、`1101`，devlog/175、183）。

**后果**：小窗页面（或被注入的 JS）今天就能调 `delete_old_data_dir` / `quit_app` / `migrate_data_dir` / `set_process_proxy` / `open_release_page`。
**⇒ 母计划 §S3-A「拆成 main.json 与 widget.json」单独做，安全收益≈0。** 必须二选一：
- **(推荐) Rust 侧逐条校验 caller label**（把 `tauri::Window` / `WebviewWindow` 作为命令参数，`window.label()` 必须 ∈ 允许集合）；或
- 给应用自定义命令定义 ACL manifest（`build.rs` 里 `Attributes::app_manifest`）——**新增一个"配置会漂"的点**，要在门禁里钉住。
母计划 §S3-A 那句"Rust command 同时校验 caller window label，不能只信 capability"是**对的**，但它不是"补充"，而是**唯一有效的那一半**。

### 2.3 ⚠️ S1 会打坏托盘退出判据（母计划完全没提，且是老 bug 复发）

`lib.rs:1169-1188` 的 `backend_manual_running` 用**裸 TCP GET** 问后端：

```rust
sock.write_all(b"GET /vtuber/fetch-status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").ok()?;
if !raw.starts_with("HTTP/1.1 200") && !raw.starts_with("HTTP/1.0 200") { return None; }  // 非 200：当作问不到
```

而 `/vtuber/fetch-status` 属于"其余 GET JSON ⇒ 需 token"。**加了 token 之后它会 401 ⇒ 返回 `None`**，而 `tray_quit_impl`（`lib.rs:1191-1205`）对 `None` 的处理是：

```rust
match backend_manual_running(port) {
    Some(true) => { show_main_impl(app); app.emit("shell:quit-requested", ()); }
    other => { QUITTING.store(true, Ordering::SeqCst); app.exit(0); }   // 问不到也直接退
}
```

**⇒ 手动抓取进行中点托盘退出，会不弹确认、静默掐掉一轮抓取。** 这正是 R20（devlog/095、097、129）花大力气修好的行为。

**两种修法，任选但必须显式决策并写进 devlog**：① 给这条 client 加 token 头（需要把 token 传进 `tray_quit_impl`）；② **把 401 定义成"问不到 ⇒ 保守判定为在跑"**（更稳：宁可多问一次，不可静默丢任务）。
**必测**：手动任务运行时 + 探活拿不到 token ⇒ **必须走"唤回 + 弹确认"分支**。反向验证：把 `other =>` 改回直接退出 ⇒ 必红。

### 2.4 ⚠️ T0 直播轮询里有**五层**平台假设，母计划只点了一层

`app/services/scheduler.py:2640-2695`：

```python
def _bili_accounts() -> list[Account]:
    return db.query(Account).filter(Account.platform == "bilibili", ...).all()   # ① 只查 bilibili
...
chunk = [a for a in accounts[idx:idx+100] if str(a.platform_uid).isdigit()]       # ② uid 必须是十进制数字
data = await fetch_bilibili_live_batch(...)                                       # ③ 假定存在批量接口
for acc in chunk:
    hit = data.get(str(acc.platform_uid))                                         # ④ 假定返回 dict[uid]
```

加 **⑤：`scheduler.py:30-31` 直接 `import fetcher.fetch_bilibili_live_batch`，绕过 `platforms/registry.py`** —— 对比账号信息路径 `scheduler.py:478-481` 是走 registry 的（`pf = registry.get_fetcher(acc.platform); if pf is None: skip`）。

`BasePlatform`（`app/services/platforms/base.py`，36 行）**只有 `platform` / `fetch_user_info` / `fetch_post_page` / `enrich`**——没有 `supports_live_status`、没有 `fetch_live_batch`、没有 uid 形态约束。**微博账号永远不会进 T0。** `str(...).isdigit()` 过滤失败时**静默丢弃且不计入 `result.failed`**（`:2670-2672`）。

### 2.5 微博"被 B 站登录态误阻断"——抓取面**没有**，能力面**有**

- 抓取名单层**正确**：`scheduler.py:2597-2602` 微博只看 `weibo_auth_manager.needs_login`，B 站分支才问 `capabilities.content_fetch_allowed()`。
- **缺陷在 `app/services/capabilities.py:119-122`**：

```python
def _logged_in(platform: str | None, bili: bool, weibo: bool) -> bool:
    if platform is None: return True
    return bili if platform == "bilibili" else weibo     # ← else 兜底：任何非 bilibili 都看微博
```

今天只有两个平台所以**行为恰好正确**；加第三个平台（或拼写变体 `"Bilibili"`）就**静默错**。
- 还有一处**真实存在的越界拦截**：`routers/vtuber.py:947` 的 `_require_content_fetch()` 无条件问 B 站闸门，而 `POST /vtuber/fetch-posts` 的 `platform` 可传 `"weibo"`（`:931` 默认 `"bilibili"`）⇒ **传 weibo 会被 B 站登录态 403**。前端目前不这么调，所以没有报障——**正是"没有牙口的越界"**。
- `tests/test_capabilities.py:42` 有 `assert f.platform in (None, "bilibili", "weibo")`——**它把"只有两个平台"钉成了测试事实**，批次 9 必须一起改。

### 2.6 R3 的第一号真实缺陷不是"没 owner"，是**一个流程有两个 commit**

`app/services/scheduler.py:2685-2711`：

```python
prev_status = acc.live_status
acc.live_status = hit.get("live_status", 0)
...
db.commit()                          # 事务 1：live 字段
if acc.live_status != prev_status:
    _record_stat_snapshot(db, acc)   # 只 add 不提交
    db.commit()                      # 事务 2：跳变快照
```

**`:2700` 失败 ⇒ live 状态已落盘、跳变快照缺失；下一轮 `prev_status == acc.live_status`，跳变边沿被永久吞掉**（直播日历少一场 / 少一个 edge）。`:2711` 的 `db.rollback()` 救不回来。这条**必须**是 R3 的第一个用例——母计划必测第 2 条命中了，但没指出它今天是**必然**可复现而非理论风险。
另两条结构性事实：T0 用**独立守护线程 + 每轮新建 Session**、**不占 `_fetch_lock`**、**不写 `last_result`、不进状态通道**（`scheduler.py:2644-2646`）⇒ 前端无法感知它失败。

### 2.7 仓库层有两条越界，母计划只点了 `normalize_title`

- `app/repositories/vtuber_repo.py:13` → `from app.services.live_type import normalize_title`（反向边，母计划已点名）。
- **新发现**：`app/repositories/vtuber_repo.py:407` 在 `LiveSessionRepo.upsert_danmakus` 里**硬编码平台**：

```python
fields = { "platform": "bilibili", ... }
```

该方法注释自称"其他数据源接入接口"（`:342-343`），却把唯一平台写死——**仓库层替平台做决定**。

### 2.8 `_status` 的"GIL 下线程安全"断言已被自己的代码破坏

`scheduler.py:90` 写着 `# ── 实时状态（供 /vtuber/fetch-status 轮询；仅简单赋值，GIL 下线程安全）──`。同文件里有一批**无锁读-改-写**：

| 全局 | 行 | 写者线程数 |
|---|---|---|
| `_dynamics_idle_streak`（`+= 1`） | 3207 / 3237 | **4**（uvicorn 循环、T0、tier、`note_dynamics_activity`） |
| `_external_done_seq`（`+= 1`） | 123 | 3 |
| `_last_result_seq`（`+= 1`） | 241 | 3 |
| `_bili_account_id_cache`（dict 写入） | 1507 / 1518 | 2 |
| `_PlatformBudget._prune` 在**读路径** `wait_seconds` 里改 `_hits` | 3048-3052 | 1（但改的是共享状态） |

⇒ **R2 的范围要扩到这张表**，不止 `_status` / `_external_labels` / 序号 / recent。

### 2.9 两个模块级单例是 **import 期 settings 快照**，不吃热更

```python
3108: _dynamics_budget = _PlatformBudget(settings.DYNAMICS_BUDGET_RPM)
3159: _dynamics_pacer  = _PlatformPacer(settings.STARTUP_DYNAMICS_INTERVAL_MIN,
3160:                                    settings.STARTUP_DYNAMICS_INTERVAL_MAX)
```

`app/core/runtime_settings.py` 的承诺是"**每一轮读一次**"（`config.py` 的 `__getattribute__` 拦截 + `SPECS`）。这两个对象在模块导入时取一次值就固定 ⇒ **用户在设置里改 `DYNAMICS_BUDGET_RPM`，预算不会变。** 归入批次 5 顺手修，并补"改热更值 ⇒ 预算真的变"的用例。

### 2.10 R1 的"不可中断 sleep"是 5 处，且 tier 线程**完全无法停止**

| 线程 | 启动点 | 睡眠（逐字） | 能否停 |
|---|---|---|---|
| APScheduler 工作线程 | `start_scheduler()` 865-893 | 无自有 sleep，但 `_wait_for_manual_tasks` 里 `time.sleep(poll_seconds)` **最多 1800s** | 只能 `shutdown(wait=False)` |
| `startup-external` | `start_external_catchup()` 2998-3010 | 无 | 一次性 |
| `t0-live-poller` | `start_live_poller()` 3195-3197 | `3179`、`3189 time.sleep(_tier_delay(LIVE_POLL_SECONDS, ...))` | 只能靠 `LIVE_POLL_SECONDS <= 0` 在 while 判断处退出 |
| `tier-scheduler` | `start_tier_scheduler()` 3485-3487 | `3413`、`3436 time.sleep(max(1, TIER_TICK_SECONDS))`，`while True:` | **❌ 无任何停止手段** |

**全模块 `Event.wait` 零命中。** 且 `start_scheduler()` / `start_live_poller()` / `start_tier_scheduler()` **每次调用无条件再起一份**（唯一幂等守卫是 `_rl_loaded`）⇒ 连续两次 `TestClient(app)` lifespan 会**真的双跑**。

### 2.11 前端有一个**真实的启动竞态**，是 S1 的前置条件

`frontend/src/main.tsx`：`Root` 在 `state !== 'pending'` 时挂载 `<Main/>`（第 220 行），而 `setApiBase(base)` 在**异步的** `tauriBootstrap()` 里（第 45 行，`useEffect` 第 149 行启动）。

⇒ **业务组件比 `setApiBase` 先运行**，靠的是"启动幕 ≥750ms + healthz 轮询"这段窗口里**没有业务请求自动发出**。

**后果**：若按直觉"在 `api.ts` 的 `request()` 里加 token header"，token 的获取（`invoke` → 异步）会**晚于**第一批业务请求 ⇒ 桌面端首启必然 401。**必须先把"业务请求等待 base + token"做成显式闸门**，再谈注入。这是批次 2 存在的唯一理由。

### 2.12 前端没有任何组件级测试能力

见 §1 依赖表那一行。另：仓库自己在 **5 处**注释里承认"组件渲染测不了"（`live/sessionGlance.ts:11`、`utils/sceneStep.ts:5`、`utils/toolbarZone.ts:14`、`utils/statusIslandText.ts:6`、`profile/layoutModel.ts:14`）。

### 2.13 全局 `outline:none` 的后果比"键盘看不见焦点"更复杂

`frontend/src/index.css:62-71`：

```css
@layer base {
  :focus, :focus-visible { outline: none; }
}
```

- **同时命中 `:focus-visible`**，且**在 `@layer base`** ⇒ Tailwind v4 的 utilities 层优先 ⇒ shadcn 组件显式写的 `focus-visible:ring-*` **仍然生效**（这就是"看起来有焦点环"的原因）。
- 全仓另有 **10 处**局部 `outline:none`：**7 处有真替代**（`outline: 2px` 或 `box-shadow` ring），**`posts.css:778 .live-tag.clickable:focus-visible` 等 2 处没有替代**。
- 焦点环颜色散落 **5 种**硬编码（`var(--ring)` / `var(--c-primary)` / `var(--c-primary-deep)` / `#fff` / `var(--pill-ring)`），**无 `--focus-ring` 令牌**，**无 `forced-colors` / `prefers-contrast`**。
- 摘掉全局规则会给**所有未声明替代的原生控件**（`.type-chip` / `.filter-chip` / `.view-btn` / `.lc-cell` / `.back-to-top` / `.fan-preset` / `.aps-nav-item` …）**新加上浏览器默认 outline**。

### 2.14 `ApiError` 不存在，且 `JSON.parse` 连 try/catch 都没有

`frontend/src/api/api.ts:25-36`：

```ts
if (!resp.ok) {
  let detail = `${resp.status} ${resp.statusText}`
  try { const body = await resp.json(); if (body?.detail) detail = String(body.detail) } catch {}
  throw new Error(detail)                                  // ← 裸 Error，status/detail/path 全丢
}
const text = await resp.text()
return (text ? JSON.parse(text) : null) as T                // ← 无 try/catch；54 个端点共用
```

- 全仓**无 `ApiError` 类**。调用方只能读响应体里的 `status: 'skipped'` 绕过（`pages/useVtuberActions.ts` 6 处），HTTP 层 409/400/风控**不可判别**。
- 服务端 `ok:true` 但响应非 JSON ⇒ 抛裸 `SyntaxError`，而调用方按 `e.name === 'AbortError'` 分流（`PostsPage.tsx:597`）⇒ **会被当成业务错误弹 toast**。
- `types.ts` 有 **60 个 DTO interface + 3 个 union**，文件头自述"与后端 Pydantic schema 对齐"——**100% 手工抄写**，无生成器、无生成脚本、无运行时校验。

### 2.15 删旧数据目录：比母计划描述的更弱，而且**单击即删、无二次确认**

`lib.rs:461-488` 的 `delete_old_data_dir` 只有四道判断：`path == cur`（**裸 `PathBuf` 相等，无 canonicalize**）→ `path.is_dir()`（**跟随链接**）→ `vtuber.db` **或** `.env` `exists()`（**或，不是合取**）→ `remove_dir_all`。**全程无 symlink / junction / reparse 检查。**

⇒ **最坏路径成立**：小窗（或注入的 JS，见 §2.2）传入当前数据目录的等价写法（`…\.` / 大小写变形 / 8.3 短名 / junction）⇒ `path == cur` 不成立 ⇒ `is_dir()` 成立 ⇒ `vtuber.db` 存在 ⇒ **正在被 SQLite 使用的活数据目录被 `remove_dir_all`**。
**UI 侧同样没有确认框**：`AppSettingsDialog.tsx:980-988` 的 `FloatPill` 直接 `onClick={() => void doDeleteOld()}`；`shellBridge.ts:246` 的注释"用户确认后才调"与实现不符。
`migrate.rs` 里的 canonicalize（`:194-204`）**只用于包含关系判定**，且刻意不外传（`\\?\` verbatim 问题，`:188-193`）。

### 2.16 另外三条 Tauri 侧应修项（母计划没列）

- `set_process_proxy`（`lib.rs:435-444`）用 `url.starts_with("http://127.0.0.1:")` 判据，**不是 URL 解析** ⇒ `http://127.0.0.1:8080@evil.com:3128` 通过（userinfo 伪装），会把**整个进程**后续新建的 HTTP 客户端（含 updater 的 reqwest）指向 `evil.com`。updater 有 minisign 签名兜底，但这是应修项。另：`std::env::set_var` 在多线程进程中是已知不安全操作。
- `widget_diag(info: String)`（`lib.rs:940-943`）→ `shelllog::log` 把前端任意字符串原样 `writeln!` 进 `<数据目录>\logs\shell.log`，**无长度上限、无换行/控制字符清洗** ⇒ 可伪造日志行、可膨胀日志。
- `capabilities/default.json` 里 **`dialog:allow-open` 无人使用**（选目录是 Rust 侧 `blocking_pick_folder()`，`lib.rs:258`，不经 ACL）⇒ 可直接删。`shell:allow-open` 是 JS 唯一用到的 shell 权限，外链改造完成后也应删；否则**旧通路仍在，任何窗口可调**。

### 2.17 外链通路的真实强度：默认正则**允许任意 https 主机**

`HeroCardsView.tsx:45-55` 的 `openExternal` 把 **DB 直出的 `account.url` / `live_url`** 原样交给 `plugin:shell|open`。`tauri.conf.json` **没有 `plugins.shell.open` 配置** ⇒ 插件用内置默认正则（vendored `tauri-plugin-shell-2.3.5/src/lib.rs:147-160`）：

```rust
Some(Regex::new(r"^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+").unwrap())
```

**无主机白名单、不拒 userinfo（`https://x@evil.com` 通过）、末端无 `$` 锚点、放行 `mailto:`/`tel:`。** ⇒ 今天任何 https 主机都能被打开；唯一挡住 `file:`/自定义 scheme 的就是这个正则。
另有两处**未验证**：`PostDetailDrawer.tsx:120/226`、`DeltaRenderer.tsx:44` 的 `<a target="_blank">` 在 WebView2 里的真实行为（无 `on_navigation` 拦截）——**如果它被 WebView2 接管跳转，就是又一条未受控的外链通路**，且离开 `tauri.localhost` origin（届时 `is_local=false`，自定义命令会被 ACL 拒——既是保护也是功能事故）。

---

## 3. 逐批方案

> 每批字段固定：目标 / 改动面 / **先补的失败用例（含"怎么让它红"）** / 验收 / 门禁 / 文档义务 / 停止条件。

---

### 批次 0.1 — 依赖锁定与可复现基线

**目标**：让"重构前后对比"成为一件有意义的事。

**为什么必须最先做**：见 §1 依赖表第一行。补充：`scripts/build_backend.py`（PyInstaller 冻结后端）**用同一份 `requirements.txt`** ⇒ **发布产物本身不可复现**。

**改动面**：
- 选 **`uv`**（本机 Python 3.14；对 `requires-python` 与平台轮子处理最省事），产出 `pyproject.toml` + `uv.lock`；`requirements.txt` **保留为导出产物**（`uv export --no-dev`）**或删除并把 `build_backend.py` / 文档指向 `uv.lock`**——**只留一个真源**。
- 区分运行 / 开发依赖（`pytest` 现在是运行依赖，**PyInstaller 会把它打进产物**）。
- `scripts/build_backend.py` 改用锁文件安装。
- `scripts/gate.py` 档位表加 **Rust**：`frontend/src-tauri/src/**` / `Cargo.toml` / `tauri.conf.json` / `capabilities/**` → 需 `cargo test`。**今天只有 A/B/C 三档，改 Rust 会落进 C 档只跑 tsc+eslint+探针 ⇒ `cargo test` 一次都不跑。**

**先补的失败用例（怎么让它红）**：
- 加一条门禁：`build_backend.py` 的依赖来源必须是锁文件（断死"改回 `requirements.txt` 直装"）。反向验证：改回 `-r requirements.txt` ⇒ 必红。
- `scripts/gate.py --plan` 对 `frontend/src-tauri/src/lib.rs` 必须打印 Rust 步骤。反向验证：删掉那条映射 ⇒ `--plan` 输出里应看不到 Rust 步骤（**这条今天必然红，因为功能不存在**）。

**验收**：干净虚拟环境 + `uv sync --frozen` 两次安装产出**逐字节相同的包集合**；`python scripts/build_backend.py` 后冻结 exe 能起。

**门禁**：`--tier full`。

**文档义务**：B 档。`docs/RELEASE.md`（依赖来源）+ `docs/DEV-LOOP.md`（档位表若变）+ devlog。

**停止条件**：锁出来的版本集合与当前开发环境**大版本不一致**（如 `sqlalchemy`/`fastapi` 跳大版本）⇒ **停下问用户**，不要顺手升级（那是另一个批次）。

---

### 批次 0.2 — CI（跨平台 + Windows）+ 前端测试环境

**目标**：让门禁从"我记得跑"变成"机器跑"，并让批次 14 有地方写断言。

**核实结论**：**仓库里没有 `.github/`**（`Get-ChildItem .github` 只命中 `node_modules` 里的第三方目录）⇒ **CI 完全不存在**。

**一条必须先实测的真机依赖**：`frontend/src-tauri/gen/` **被 `.gitignore` 忽略**（只入库了 `Cargo.lock` / `Cargo.toml` / `build.rs` / `icons/**` / `capabilities/default.json`）。`cargo test` 依赖 `tauri-build` 在 `build.rs` 里生成它 ⇒ **干净 clone 上 `cargo test` 到底能不能跑，必须在批次 0.2 第一次就实测**。跑不了就直接决定 CI 的 Rust leg 怎么写。

**改动面**：
- `.github/workflows/ci.yml`（ubuntu-latest）：全仓 Python 语法扫描（`ast.parse`）→ `pytest` → `tsc --noEmit` → `eslint --max-warnings 0` → `vitest run` → `doc_check.py`（OpenAPI 无 diff 在批次 13 之后启用）。
- `.github/workflows/ci-windows.yml`（windows-latest）：`cargo test` + 前端 `npm run build` + **文件 SQLite/WAL 测试**（批次 15 落地）+ sidecar 冒烟。
- **前端测试环境提前装好**：`jsdom` + `@testing-library/react` + `@testing-library/user-event` + `@testing-library/jest-dom` + `vitest-axe`，并在 `vite.config.ts` 显式写 `test: { environment: 'jsdom', setupFiles: [...] }`。**同时必须证明它没破坏现有 42 个纯逻辑测试文件**（它们按 node 环境写的，切 jsdom 可能暴露 `window` 依赖假设）。
- 补仓库**没有任何测试**的三块：`delete_old_data_dir`（0 条）、`spawn_backend` 的 env 注入、`migrate_data_dir` 的编排与回滚。Rust 测试现状：**32 条，全在 `#[cfg(test)]` 模块里**（`lib.rs` 6 / `migrate.rs` 10 / `datadir.rs` 10 / `shelllog.rs` 3 / `testtmp.rs` 3），**没有 `tests/` 目录**——新用例按现有风格加到对应文件的 `#[cfg(test)]`。

**先补的失败用例**：一条门禁"workflow 存在且引用的是锁文件"（防 CI 与本地两套口径）。反向验证：把安装命令改成 `pip install -r requirements.txt` ⇒ 红。

**验收**：干净 clone → CI 全绿；**并且跑一次"故意改坏"**（例如把 `MIGRATION_HEAD` 改错）确认 CI **真的红**——"CI 绿"本身不是证据。

**文档义务**：B 档。`docs/DEV-LOOP.md` 加一张"CI 跑什么 / 本地跑什么"表（**指向 workflow 文件本身，不复述命令**）+ devlog。

**停止条件**：Windows runner 上 `cargo test` 因 `gen/` 缺失或 WebView2 依赖失败且 30 分钟内无法解决 ⇒ **停**，把 Rust leg 标 `continue-on-error` 并在 `docs/TODO.md` §1.2 记下口径问题，**不要在 CI 里塞一个永不生效的步骤**。

---

### 批次 1 — S1：sidecar 会话 token（Rust 生成 + 后端校验）

**目标**：普通网页与未持 token 的本机请求读不到业务 JSON、改不了数据。

**核实结论**：
- `lib.rs:1441-1470` 注入的 env 是 `DDTOOLKIT_PORT` / `DDTOOLKIT_DATA_DIR` / `DDTOOLKIT_PARENT_PID` / `PYTHONUTF8` / `PYTHONIOENCODING`——**没有任何 token；无 argv 传参；无临时文件；无 stdin 握手**。
- `app/core/uvicorn_setup.py:24` 已钉死 `host="127.0.0.1"`（**好**：外网进不来；但不挡本机网页与本机其它进程）。
- `app/main.py:290-300` 的 CORS：`allow_origins` 来自 `settings.CORS_ORIGINS`，**默认 `"*"`**（`config.py:168`），`allow_methods=["*"]`、`allow_headers=["*"]`。
- **不存在任何返回凭据的命令**（最敏感的是 `storage_info` 返回数据目录绝对路径与 `get_backend_port` 返回端口）⇒ token 是**新增面**。

**改动面（只做后端 + Rust 生成，前端留到批次 2）**：
1. `frontend/src-tauri/Cargo.toml`：加 CSPRNG 直接依赖（`getrandom` 在依赖树里但需显式声明才能 `use`）。
2. `lib.rs`：仿 `BackendPort`（`:74`）新增 `struct ApiToken(Mutex<String>)`，在 `setup()`（`:1573` 生成 port 处）生成；`spawn_backend` 的**两处** env 块（`1441-1446` 与 `1465-1470`）都加 `.env("DDTOOLKIT_API_TOKEN", …)`；`.manage(...)`（`:1515-1519`）；新增 `get_api_token` 命令并注册进 `invoke_handler`（`:1520-1542`）——**该命令必须校验 caller label**（见 §2.2）。
3. `app/core/config.py`：读 `DDTOOLKIT_API_TOKEN`，**默认空**；开发态允许显式 `DDTOOLKIT_DEV_API_TOKEN`。
4. 新建 `app/core/api_auth.py`：`hmac.compare_digest` 常量时间比较；失败统一 401，**错误文本不回显 token、不把 token 写进 OpenAPI example**。
5. `app/main.py`：接中间件；`CORS_ORIGINS` 默认从 `"*"` 改为**空/显式列表**（Tauri production origin 必须真机记录后再写——母计划 §9 已列停止条件）。
6. **`backend_manual_running` 一起改**（见 §2.3）。**这是本批的隐形地雷。**
7. `backend_main.py` **不改**（env 已透传）；但确认 `_slog` 只记 `port`/`parent_pid`，**绝不要加 token**。

**路由分级的核实补充**：`/static/*` 与 `GET /img-proxy` 保持公开**是必须的**——`<img>` 直接加载（`api.ts:409-414` 的 `imgProxyUrl`、`components/common/ProxyImage.tsx`），加 token 就得改 blob 管道（母计划 §9 停止条件之一）。**但要在 devlog 里显式记下"这两个端点仍是本机可读"**，别让它变成"以为都锁上了"。
另：**`/healthz` 必须保持免鉴权**——`backend_healthy`（`lib.rs:131-155`）也用手写裸 TCP 打它；若顺手纳入鉴权，迁移与启动探活全线失效（`start_backend_and_wait` 会 60s 超时并杀掉刚起的后端）。

**先补的失败用例（怎么让它红）**：

| 用例 | 反向验证 |
|---|---|
| 无 token 访问 `GET /vtuber/list` ⇒ 401 | 把中间件从 `app.main` 摘掉 ⇒ 必红 |
| **所有写方法**无 token 一律 401（**逐路由枚举** 64 条里的全部写路由） | 只放行一条写路由当白名单 ⇒ 红 |
| `/healthz` 无 token 仍 200 且只返回最小信息 | 往 `/healthz` 塞 `data_dir` ⇒ 必须红 |
| token 不出现在日志 / 异常 / OpenAPI JSON | 在 401 的 detail 里回显 token ⇒ 红 |
| **托盘退出：手动任务在跑 + 探活拿不到 token ⇒ 必须走"唤回 + 弹确认"**（§2.3） | 把 `other =>` 改回直接退出 ⇒ 必红 |
| Rust：token 非空、同进程内一致、两次启动不同 | — |
| 错误 token ⇒ 401 | ⚠️ **"错 token 与对 token 耗时相同"这条不要写**——等时性单测验不出来，写了就是**装饰性断言**（`docs/DEV-LOOP.md` §0.7） |

**验收**：浏览器直访 `http://127.0.0.1:<port>/vtuber/list` 为 401；Tauri 主窗/小窗/图片/登录/抓取正常（**真机，批次 2 一起做**）；日志与 DOM 无 token。

**门禁**：认证/API 测试 + `cargo test` + `tsc` + A 档 gate。

**文档义务**：**A 档**。`docs/ARCHITECTURE.md` §6 加不变量（"sidecar 业务端点必须持本次启动 token；`/healthz`、`/static/*`、`/img-proxy` 是显式豁免且必须在此登记"）+ 护栏用例 + devlog + 第 5 节映射的活文档（`docs/backend-repositories-and-routers.md` 的路由契约节、`docs/GLOSSARY.md`）。

**停止条件**：无法确认 Tauri production origin；或发现 token 只能放 URL（会进日志/历史）。

---

### 批次 2 — S1b：前端启动等待 + token 注入 + 真机验证

**目标**：让批次 1 的锁**真的锁在业务请求前面**，而不是锁在启动竞态之后。

**为什么必须单独一批**：见 §2.11。

**改动面**：
1. `api.ts`：`request()`（`:24`）是**唯一注入点**（54 个方法全经它）。必须 `new Headers(init?.headers)` 合并 —— `uploadBackground` 走 `FormData`，**不能覆盖 `Content-Type`**（否则 multipart boundary 丢）。
2. 同文件：加**启动闸门**，或把 base + token 的注入时机改成"在 `Main` 挂载前完成"。**两种实现都行，但必须在 devlog 里写清选了哪种、为什么。**
3. **两个入口各自初始化**：`main.tsx`（主窗）与 `widgetMain.tsx`（小窗，已经在 `injectBackendPort().finally(render)` 里 await 了）。**主窗要向小窗对齐**——`docs/DEV-LOOP.md` §6.1 第 3 条正是"新入口漏掉顶层副作用"，**犯了三次**。
4. 401 的处理：不要只弹 toast，要与 `bootState` / 启动幕的失败态接线。
5. **探针通路**：`scripts/ui_probe.py` 走无头 Edge + 真后端，**没有 Tauri** ⇒ token 走开发态显式 `DDTOOLKIT_DEV_API_TOKEN`；`dev/probe.ts` 里有十余处裸 `fetch`（1161/1931/3079/3114/3429/3896/4978…）会 401。**必须在批次 2 里确认探针没红**——否则整条布局回归网会因为 401 集体假绿（`ui_probe` 是布局的唯一机器判据）。

**先补的失败用例（怎么让它红）**：
- **能在 node 环境写的**（不依赖 jsdom）：`api.test.ts` 已有"signal 透传"风格，加"注入后每个请求都带 token header""`FormData` 请求不带 `Content-Type`""未就绪时 `request()` 不发出 fetch（用一个可控 promise 拦住 ready）"。
- 反向验证：把 header 注入注释掉 ⇒ **必红**（这条最容易"看起来在测其实没测"，因为 `fetch` 在 node 里也跑）。

**验收**：Tauri 真机 —— 主窗、小窗、图片、登录、抓取全正常；浏览器直访业务 API 401；DOM 与日志无 token。

**门禁**：tsc + eslint + vitest + **探针三档**（`ui_probe` 成本全在启动，永远跑满三档）+ 真机冒烟。

**文档义务**：A 档（碰路由契约的消费面）。devlog + `docs/FRONTEND-ARCH.md`（api 层的初始化契约）。

**停止条件**：图片鉴权迫使一次性大改 blob 管道。

---

### 批次 3 — S2：平台 HTML 白名单净化

> ⚠️ **2026-09-25 定性翻转**：本批**不再是"顺手修"，而是必做**——目标是"很多人用"的工具 ⇒ 平台给的 HTML 会渲染在**别人的机器**上。执行顺序见 §1.1（排在第 1 阶段末尾，因为批次 1 的 token 是它的使能前提）。

**目标**：平台 HTML 进 React DOM 之前过白名单，**保留库中原始 HTML 作为证据层**。

**核实结论**：全仓**只有一处** `dangerouslySetInnerHTML`：`frontend/src/components/PostDetailDrawer.tsx:297`，上一行注释写着"本地工具场景直接渲染，如部署公网建议净化处理"——**这条注释是错的**（威胁模型见 §2.1）。`OriginCard`（`:311-314`）渲染同源数据，**要一起过**。

**改动面**：
- 新增 `frontend/src/utils/sanitizePlatformHtml.ts`（`dompurify`）；放行段落/换行/强调/列表/引用/代码/表格；链接仅 `http|https`（**并加 `rel="noopener noreferrer"` 与 `target` 策略**）；禁 script/style/iframe/form/object/embed/SVG、事件属性、内联 style、危险 scheme。
- `PostDetailDrawer.tsx:290-301` 只消费净化结果。
- **不得放宽 CSP**（`tauri.conf.json` 一个字都不改）。

**先补的失败用例（怎么让它红）**：
- 矩阵：`<script>`、`onerror=`、`javascript:`、`data:text/html`、SVG（`<svg onload>`）、`<iframe>`/`<form>`、畸形嵌套、**以及正常排版不过度损坏**（表格/引用/列表/换行必须活下来）。
- **反向验证的正确做法**：不是"换个 payload"，而是**把净化调用去掉、改回 `body.content`** ⇒ 恶意用例必须红、正常排版必须绿。**这条要写进 devlog**，否则下一个人会以为"payload 变了还绿 = 净化有效"。
- **真实数据 fixture**：`docs/ARCHITECTURE.md` §6 第 22 条要求"判据至少有一条用例吃真实数据"。取一条**真实专栏 HTML** 放 `tests/fixtures/`（不是手写样本）。

**验收**：sanitizer 单测 + tsc/eslint/vitest + build + **CSP 复核（diff 应为空）**。

**文档义务**：B 档。devlog（**写清 §2.1 的三层威胁模型**）+ `docs/FRONTEND-ARCH.md`。

**停止条件**：净化后真实专栏排版严重损坏（用户可见退化）⇒ 停，问用户"接受降级 / iframe 沙箱 / 只给纯文本"。

---

### 批次 4 — S3：命令 label 校验 + capability 分窗 + 外链白名单 + 安全删除旧目录

**目标**：破坏性命令只对 main 可用；外链只有白名单主机；删旧目录必须有票据且不可绕过。

**⚠️ 顺序要求**：**先做"S3-0 命令可达性收口"，再做 capability 拆分。** 否则拆 JSON 只是"看起来收紧了"（§2.2）。

**S3-0 命令可达性收口（本批唯一真正有效的一半）**
- 给每条命令加 caller label 校验。**最需要收口的六条**：`delete_old_data_dir`、`migrate_data_dir`、`quit_app`、`open_release_page`、`set_process_proxy`、`hide_to_tray`；`storage_info` / `get_backend_port` / `get_api_token` 也要（小窗只需要 `get_backend_port` + `get_api_token`）。
- 实现方式见 §2.2 的两个选项。**推荐 Rust 侧判 label**（不引入"配置会漂"的新点）。
- **必测**：逐命令的"main 可调 / widget 被拒"矩阵。反向验证：把 label 校验注释掉 ⇒ widget 用例必红。

**S3-A capability 分窗**（在 S3-0 之后）
- `capabilities/default.json` → `main.json` / `widget.json`（`tauri.conf.json` 无 `capabilities` 字段 ⇒ 目录内文件全生效）。
- **可安全删除**：`dialog:allow-open`（JS 未用，Rust 侧对话框不走 ACL）、`shell:allow-open`（S3-B 完成后）。
- **小窗必须保留**（否则重演 devlog/175 的"IPC 通道坏掉、主窗点 ✗ 没反应"）：`core:default` 或至少 `core:event:allow-listen` / `allow-emit`、`core:window:allow-start-dragging`、以及 `core:window:allow-get-all-windows` + `allow-is-visible` + `allow-show` + `allow-set-focus`（`utils/widgetWindow.ts:336-357` 的 `resurfaceMainWindow` 用到）。
- **未验证、必须先测**：运行时创建的 `widget` 窗口能否被显式 label 的 capability 命中（无测试证据）。

**S3-B 外链白名单**（现状见 §2.17）
- 新增 Rust 命令 `open_external(url)`，**复用 `open_release_page`（`lib.rs:352-390`）的 `ShellExecuteW` 范式**；真 URL 解析校验：仅 `https`；主机白名单（`space.bilibili.com` / `live.bilibili.com` / `bilibili.com` / `www.bilibili.com` / `weibo.com` / `www.weibo.com`）；**拒 userinfo**、拒 `file:` / 自定义 scheme / `localhost` / IP 字面量、拒 `%`-编码与大小写绕过。
- `HeroCardsView.tsx:47-55` 改为 `invoke('open_external', …)`，**保留浏览器分支的 `window.open` 回退**（前端不复制主机表——跨语言两份真源会漂）。
- **删除 `shell:allow-open`**，否则旧通路仍在、两扇窗都能调。
- **别顺手删 `open_release_page`**（"打开发布页"是另一套入口）。
- 风险：`accountHomeUrl` **盲信 DB 里的 `account.url`**（`utils/postTypes.ts:66`）⇒ 白名单过严会让新平台"打开主页"静默失效，**要在 UI 上禁用并说明**，不要在命令里静默 `Err`。

**S3-C 安全删除旧目录**（现状见 §2.15）
- `MigrateReport`（`lib.rs:242-251`）加 `migration_id`；`migrate_data_dir` 在**探活成功后**（`:322-343`）把 `{canonical_path, migration_id}` 存进壳状态（新增 `struct MigrationRecord(Mutex<Option<...>>)`）。
- `delete_old_data_dir` 改成 `(app, id: String)`：查表命中才算 → `canonicalize` 后与记录**严格相等** → 拒当前目录、拒与当前目录互为祖先/子目录 → `symlink_metadata` + reparse tag 判据拒 symlink/junction → **多个 DDToolkit 特征文件合取**（不是"或"）→ 删除成功即清记录（**防重放**）。
- 前端：`shellBridge.ts:247-254` 改传 id；`AppSettingsDialog.tsx:173/193/208/980-988` 改存/传 id，并**补二次确认对话框**（现在单击即删）。
- **跨重启可删 vs 不可删是产品口径**：今天 `oldDir` 是组件 state，**重启后本来就删不掉**；改成 id 后依然删不掉。若要跨重启，记录必须落 `%APPDATA%\DDToolkit\`（`datadir.rs:26-46` 的指针目录，**绝不放数据目录内**）。**在 devlog 里说清选了哪一种。**

**先补的失败用例**：
- 命令矩阵（逐命令 main / widget）；反向验证：注释掉 label 校验 ⇒ 必红。
- 危险 URL：userinfo、`file:`、`javascript:`、`localhost`、IP 字面量、`%2e%2e`、大小写混淆主机。
- 目录：任意含 `.env` 的目录、`..`、大小写、8.3 短路径、symlink、junction、**当前目录的等价路径**（`E:\a\..\a` 与 `E:\A`）、**id 重放**、以及**正常删除仍成功**。
- 反向验证：把 canonicalize 拿掉 ⇒ 等价路径用例必红；把合取改回 `||` ⇒ "任意 `.env` 目录"用例必红。

**⚠️ 开工前必须先做一次真机实验（否则这一批可能建在错的机制上）**：Windows 上 **junction / mount point** 的 `Path::is_dir()`、`FileType::is_symlink()`（Rust 的 `is_symlink` 对 reparse tag 的覆盖范围）与 `std::fs::remove_dir_all`（是否穿入目标删除内容）的**确切行为**。做法：`mklink /J` 造一个指向真实数据目录的 junction，分别打印 `symlink_metadata().file_type()` 的 `is_symlink()` / `is_dir()`，再在**一次性临时目录**上验证 `remove_dir_all` 的实删范围。**仓库自己的停止条件里就有"无法可靠识别 reparse point"**（母计划 §9）——这条实验就是决定"停不停"的依据。

**验收**：`cargo test` + capability/label 矩阵 + **Windows 真机**迁移与窗口 smoke。

**文档义务**：A 档（破坏性操作 + 不变量）。`docs/ARCHITECTURE.md` §6 加"删除旧数据目录的准入条件"；`docs/DEV-LOOP.md` §四（整包重建条件）若变则同步。

---

### 批次 5 — R2：`FetchStatusStore` 并发一致性（建议提前到此位）

**目标**：把跨线程状态从"靠 GIL 的约定"变成"靠锁的构造"。

**核实结论**：范围**比母计划写的更大**（§2.8 + §2.9）。除 `_status`(93) / `_external_labels`(105) / `_external_done_seq`(106) / `_last_result_seq`(236) / `recent`（`_push_account_snapshot:138-149`）外，还要收 `_dynamics_idle_streak`(3207) / `_bili_account_id_cache`(1507) / `_PlatformBudget._prune`(3048-3052)，并顺手修两个 import 期快照。

**改动面**：短持有 `threading.RLock`；`snapshot()` 返回独立副本；`recent` 用有界 `deque`；**锁内不得网络/数据库/重 IO**。

**先补的失败用例**：多线程 start/finish 后 running/label/seq 一致；并发 `snapshot()` 稳定；`recent` 上限；未知 token 行为；**现有 API 字段兼容**（`get_fetch_status` 的键集合有测试守着：`test_services.py:3021`）；"改热更值 ⇒ 预算真的变"。

**反向验证**：把锁去掉、在临界区加 `time.sleep(0)` 放大竞态 ⇒ 并发用例**必须真红**。红不了就加大线程数/轮数直到能复现——"改不动就说明断言是装饰"。

**门禁**：多线程状态测试 + fetch-status 契约 + A 档 gate。

**文档义务**：A 档（`/vtuber/fetch-status` 是前端契约）。devlog + `docs/ARCHITECTURE.md` §6——**把"GIL 下线程安全"那句删掉或改写成新的锁约定。这是本批最重要的一条，因为那条注释是错的。**

**为什么提前到批次 6 之前**：便宜、独立、不碰 scheduler 结构；而且 `FetchStatusStore` 是批次 10 要搬走的第一个"叶子"——先把它做成**有锁的类**，拆分时就不用同时改语义和搬位置。

---

### 批次 6 — R1：调度生命周期可停止

**目标**：lifespan 退出后，T0、综合档、外部调度与后台任务不再执行；重复启动不产生双份线程。

**核实结论**：见 §2.10。

**改动面**：
- 建立 `SchedulerRuntime`：统一持有 `stop_event`、live/tier 线程句柄、APScheduler、后台任务。
- 循环 `time.sleep(n)` → `stop_event.wait(n)`；**stop 顺序**：停止接新任务 → 通知线程 → 取消任务 → join → 关闭 APScheduler / HTTP client。
- `start()` / `stop()` **幂等**；超时退出必须**告警**；daemon 只作兜底。
- **`_wait_for_manual_tasks`（`:896-914`）也必须进 stop 语义**——否则"关闭"最坏要等半小时。
- **不变量 `ARCHITECTURE.md` §6 第 15 条继续成立**：模块级对象**不得**持有 asyncio 原语（`test_services.py:1365` 遍历 `vars(pacer)` 守着）。用 `threading.Event`。

**先补的失败用例**：线程各只有一份；stop 后计数不增长；**start-stop-start 无残留**；等待/冷却中可停止（含"正在 `_wait_for_manual_tasks` 里"这一支）；**连续 `TestClient(app)` lifespan 不双跑**。

**反向验证**：把 `stop_event.wait(n)` 改回 `time.sleep(n)` ⇒ "等待中可停止"必红。

**已知的测试环境坑**：`tests/test_real_fixtures.py:132-135` 记录过"`TestClient(app)` 会跑 lifespan 起线程并**抢占 `scheduler._fetch_lock`**，让后续 7 条锁用例连带变红"。**本批会改变线程启动/停止语义 ⇒ 很可能移动这个泄漏面**，预期要跟着修 fixture，**不要改产品代码去迎合**。

**门禁**：生命周期测试 + pytest 相关集 + 启停冒烟。

**文档义务**：A 档。`ARCHITECTURE.md` §1（运行时线程/协程表）+ §6 + devlog。

**停止条件**：scheduler 无稳定测试基线（母计划 §9）——**本批必须先跑通一次完整 `pytest` 并记录基线**，跑不通就停。

---

### 批次 7 — R3：事务边界收口（五个流程）

> ⚠️ **2026-09-25 修正：只做两件事 —— ① 补全五条失败路径用例；② 修 (c) 的双 commit。不做"69 处 commit 收口 / 引入 application service 层"。**
> 核实结论是：(a)(b)(d)(e) 四个流程**今天靠"仓库末尾顺手 commit"恰好是原子的**（逐条追过调用链）。给这个规模的工具引入一层新的 owner 抽象是过度设计——它会新增一个你必须记住的层，而它防的是"将来有人往中间插一个会 commit 的调用"这种尚未发生的事。**先补用例；用例补完如果没咬出问题，本批就到此为止。**
> **(c) 是唯一今天就必然复现的缺陷**（`scheduler.py:2696/2700` 两次独立 commit ⇒ 第二笔失败时 live 状态已落盘、跳变快照永久缺失），它必须修。

**目标**：多表业务的 commit/rollback 由明确的任务或应用服务边界控制；**事务 owner 能从代码直接看出**。

**核实结论**：`app/` 内 **69 处** `.commit()`/`.rollback()`（分布见附录 A）。五个流程：

| 流程 | 今天的 owner | 中途失败会怎样 |
|---|---|---|
| (a) 删账号 `routers/vtuber.py:358-376` | `AccountRepo.delete`（`vtuber_repo.py:162`）内的 commit | 靠"仓库末尾顺手 commit"原子；**无失败路径用例** |
| (b) 删 VTuber `routers/vtuber.py:254-269` | `VTuberRepo.delete`（`vtuber_repo.py:52`） | 同上；风险是"将来在 purge 与 delete 之间插入任何会 commit 的仓库调用（如 `AppMetaRepo.set:75`）就把原子性切成两半" |
| **(c) T0 live + 跳变快照** `scheduler.py:2685-2705` | **无 owner，两次独立 commit** | **❌ 真半写且必然可复现**（§2.6） |
| (d) profile 布局 `ProfileCardRepo.replace_all`（`vtuber_repo.py:1147-1171`） | 仓库层，**全仓唯一在 Repo 内成对 try/commit/rollback** | 本流程最安全；缺口是唯一键冲突冒成 500（未映射 409/422） |
| (e) 收录 V + Account `routers/vtuber.py:1251-1281` | **Router 本体**（`:1269`） | 单事务两行（原子 OK），但 HTTP 层持有 `Depends(get_db)` 会话做 flush/commit/refresh |

**先补的失败用例**（母计划 §R3 必测，核实后**全部确实缺失**）：

| 必测 | 今天的覆盖 |
|---|---|
| purge 中途失败全回滚 | ❌ **无** |
| 快照失败时 live 状态回滚 | ❌ **无**（第一号用例，见 §2.6） |
| 布局半途失败保留旧布局 | ⚠️ 半个（`test_profile_cards.py:141` 只断言 `pytest.raises(IntegrityError)`，**没断言旧布局还在**） |
| 账号唯一冲突不留孤儿 V | ❌ **无并发用例** |
| 锁冲突后 session 可继续使用 | ⚠️ 半个（`test_services.py:1054` 覆盖风控冷却重连，非锁冲突） |

**反向验证**：合并 (c) 的两个 commit 之前，先**制造 `_record_stat_snapshot` 抛错**并断言"`acc.live_status` 仍是旧值 + 快照零新增"——**今天这条必然红**，正好当"先补失败用例"的证明。

**原则**（母计划原文，核实后完全同意）：Repository 默认不 commit 只 flush；application service / 任务做 owner；Router 只映射 HTTP；网络请求不持长写事务。**但必须同时改 `docs/ARCHITECTURE.md:622`**——那行白纸黑字写着"写操作当场 commit"，否则文档与代码两份口径。

**门禁**：文件 SQLite 故障测试 + 删除/收录/profile/T0 回归 + A 档 gate。

**文档义务**：**A 档全套**。`ARCHITECTURE.md` §5 分层表（`repositories` 行）+ §6 + `docs/backend-repositories-and-routers.md`（12 个 Repo 的方法表全部加"是否 commit"列）+ devlog。

**停止条件**：事务改造出现跨请求共享 Session。

---

### 批次 8 — M1a：依赖方向（低成本、去环）

**改动面**：
1. `repositories/vtuber_repo.py:13` 的 `from app.services.live_type import normalize_title` → 下沉到**无 IO 的** `app/domain/text.py`；`live_type.py` 与仓库双向都 import 新模块。**注意**：`tests/test_live_sessions.py::test_normalize_title_skeleton:624` 直接测这个函数，**import 路径要跟着改**（否则用例 ImportError，可能被当成"环境问题"放过）。
2. `repositories/vtuber_repo.py:407` 的 `"platform": "bilibili"` → 由调用方（danmakus 源适配器）传入。

**先补的失败用例**：一条**架构护栏**——"`app/repositories/**` 不得 import `app.services.**`"（用 `ast` 扫 import，比 grep 可靠）。反向验证：加回那行 import ⇒ 必红。

**门禁**：pytest 相关集 + A 档 gate。**文档义务**：B 档。`ARCHITECTURE.md` §5 + devlog。

---

### 批次 9 — M1b：平台 capability（登录闸门按平台）

> ⚠️ **2026-09-25 修正：本批的前提已被推翻，从"加能力成员"改为"必须重新设计"，并移入第 4 阶段（等调研结论）。**
> 用户已确认新平台是**小红书、抖音**（后续可能还有）。现有 `BasePlatform` 的三个前提——**HTTP-only / 有稳定字符串 uid / cookie 鉴权**——对这两家**全不成立**（要签名头、没有用户会输入的稳定 uid、大量接口只对真实浏览器会话开放）。现在凭空设计接口只会设计错。
> **详见 §1.4。** 本批**在调研结论回来之前不要动**。下面保留的是原始核实结论，供设计时当输入，不要当结论用。

**核实结论**：见 §2.4 / §2.5。

**改动面**：
- `BasePlatform` 增补（**全部带默认实现**，不改 weibo 现状行为）：`content_requires_login` / `content_fetch_allowed(auth)` / `is_logged_in(auth)` / `supports_account_info` / `supports_post_stream` / `post_streams`（B 站 = `("video", "dynamic")` 显式表达双流）/ `supports_live_status` / `live_batch_size`（0 = 不支持）/ `fetch_live_batch(...)` / `normalize_uid(...)`。
- `registry.py` 加 `platforms_supporting(capability)`；**T0 改为遍历 registry 能力**，而不是 `Account.platform == "bilibili"`；unsupported **必须结构化返回**（不是静默丢弃）。
- 修 `_logged_in` 的 `else weibo`；修 `routers/vtuber.py:947` 的越界闸门。
- **`platforms-extension-guide.md` 取消"一行注册获得全部能力"的过度承诺**——`base.py:3-7` 的 docstring 写着"3. scheduler 自动获得：账号信息抓取、全量/增量帖子抓取、风控退避、完成报告"，而 `bilibili.py:3-5` 自认**没实现 `fetch_post_page`**（帖子抓取走 scheduler 专属双流）。
- 改 `tests/test_capabilities.py:42` 的平台白名单断言为"platform 必须已注册"。

**先补的失败用例**：B站/微博四种登录组合；只支持账号的 fake platform；**多平台风控隔离**；`isdigit()` 静默丢弃改成结构化失败。反向验证：把 `else weibo` 改成 `else False` ⇒ 微博能力断言必红。

**门禁**：平台 capability 矩阵 + 扩展指南门禁 + A 档 gate。**文档义务**：B 档偏 A。`platforms-extension-guide.md`（大改）+ `ARCHITECTURE.md` §3.3/§7 + devlog。

---

### 批次 10 — M2：scheduler 拆分（**8 步，一次一步**）

> ⚠️ **2026-09-25 修正：整体拆分搁置，移入第 4 阶段。**
> 理由变了但结论没变："很多人用"确实让 bug 影响面变大——**而这恰恰意味着"重构 3487 行有状态并发代码"更不该做**，换来的风险同样放大（6 对双向纠缠 + 86 处 monkeypatch 静默失联 + conftest 直接读写模块全局）。
> **第 4 阶段只做 §1.4 那一刀**：把 B站专属双流逻辑从 `_fetch_posts_core` 隔离成平台适配器（目标是"让 scheduler 不再假设自己是 B站"，不是"为了拆而拆"）。下面的 8 步拆分方案与顺序**保留备查**，是那一刀做完之后如果仍需要拆分时的输入。

**目标**：按职责拆分，但 API 与用户行为兼容；façade 只剩组装/兼容导出。

**核实结论（本方案里风险最高的一批）**：

1. **母计划的 8 个文件名里没有 tier 的家。** `_primary_accounts` / `_dynamics_lanes` / `_lane_skip_reason` / `_active_dynamics_lanes` / `_lane_gap` / `run_latest_dynamics_sweep` / `_run_combined_tier` / `_tier_loop` / `start_tier_scheduler` **在 `runtime/status/arbitration/pacing/account_jobs/post_jobs/live_jobs/external_jobs` 里都无处安放**。建议：`scheduler.py` 保留为**组合根**（装 tier + 全量 re-export），**或**补第 9 个文件 `tier.py`。
2. **有 6 对双向纠缠**（`arbitration ↔ account_jobs`、`arbitration ↔ post_jobs`、`status ↔ arbitration`、`pacing ↔ tier`、`tier ↔ post_jobs`、`tier ↔ external_jobs`）。**必须先做两步解环**：
   - 把 `_fetch_running` / `_fetch_scope` / `_post_fetch_running` / `_external_running` / 4 个 Event / 2 把锁 / 2 个队列 / `FetchResult` / `_tier_delay` / **`any_fetch_running()` / `manual_task_running()`** 提到 `runtime.py`。这一步做完，`status ↔ arbitration` 与 `arbitration → account_jobs/post_jobs` 两条环**同时消失**。
   - **`pacing ↔ tier` 的环要选路**（母计划没提，最隐蔽）：`pacing._dynamics_next_due` → `pacing._next_dynamics_cost` → `tier._active_dynamics_lanes` → `tier._dynamics_lanes`，同时 `tier._tier_loop` → `pacing._dynamics_due_or_retry`。
     - (i) 把 `_dynamics_lanes` / `_lane_skip_reason` / `_active_dynamics_lanes` / `_lane_gap` / `_next_dynamics_cost` 一起搬进 `pacing.py`（几何闭合，但"名单"这个领域概念漏进节拍模块）；
     - (ii) 改签名 `_dynamics_next_due(cost, *, since=None)`，把 `db` 依赖上移。**推荐 (ii)，代价必须一次付清**：`db` 位置参数被 **6 处测试 + 1 个脚本**用（`test_dynamics_backoff.py:109/113/117/133`、`test_quiet_hours.py:118/122/131`、`test_services.py:1970/1977/2802/2803/2810`、`scripts/measure_dynamics_round.py:86/87`），且 `test_services.py:2000/2008` 把它 patch 成 `lambda _db, since=None:` / `def _boom(_db)` ⇒ **签名一改立刻 TypeError**。
3. **86 处 monkeypatch 是最大的假绿通道**（§0.3）。
4. `conftest.py` 的 **autouse fixture 直接读写 3 个模块全局**（`_rl_states` / `_rl_loaded` / `_dynamics_idle_streak`）。**新模块若自持同名全局，conftest 重置的将是外壳上的无关属性** ⇒ 那类跨用例串台**必然复发**。这三个名字必须以"同一对象"的身份在外壳可见。
5. 两个单例 `_dynamics_budget` / `_dynamics_pacer` 必须**同一实例**（`test_services.py:1352-1362/1365-1383` 直接摸实例内部 `dict`）。
6. **`test_quiet_hours.py:142` 对 `_live_poller_loop` 做 `inspect.getsource` 源码级断言** —— 函数体文本必须继续含 `LIVE_POLL_SECONDS` / `LIVE_POLL_JITTER_SECONDS` 且不含 `quiet`。**搬函数不能顺手重命名常量引用。**
7. `scripts/measure_dynamics_round.py` 是**仓库外调用点**，依赖 `_lane_gap` 与 `_dynamics_next_due(db, since=)` 的现签名。

**拆分顺序（按"先消除环"排，每步可独立绿）**：
1. `live_jobs.py` —— 零入边叶子，先拿它验证 re-export 机制。
2. `runtime.py` —— 解环关键一步。**不改任何调用点语义。**
3. `status.py` —— 依赖 2 过后才没有环。
4. `pacing.py` —— 先决策 (i)/(ii)。
5. `external_jobs.py`
6. `post_jobs.py`
7. `account_jobs.py` + `arbitration.py` **一起收尾**（`_auto_yield_account_with:1107-1123` 是唯一"仲裁模块写别人全局"的点）。
8. `scheduler.py` 定型为组合根（tier + 全量 re-export）。

**兼容外壳的硬约束**：跨模块调用**必须经外壳在调用时解析**（`from app.services import scheduler as _facade; _facade._fetch_one_account(...)`），否则那 86 处 patch 要全部重写。

**先补的失败用例（每搬一步都要做）**：
- 跑该模块相关的 scheduler 测试集；
- **并且**挑 1–2 处 `monkeypatch.setattr(sch, "X", ...)`，把被测函数改成"返回错误值" ⇒ 如果测试**仍然绿**，说明 patch 已失联 ⇒ **这一步不算完成**；
- 四个不变量用例保持绿：抢占、平台并发、增量停止、T0。

**门禁**：每搬一模块跑 scheduler 测试；收尾 `--tier full`。

**文档义务**：B 档。`docs/backend-fetch-pipeline.md` + `ARCHITECTURE.md` §1/§3 + devlog（**一次拆分一篇**，不逐个字母各写一篇）。

**停止条件**：scheduler 无稳定测试基线；或某步 patch 失联无法在不改 86 处的前提下解决 ⇒ 停，改为"先批量把 patch 目标迁到新模块"的独立批次。

---

### 批次 11 — M3：router 拆分 + 应用服务 + 背景上传加固

> ⚠️ **2026-09-25 修正：本批只做"背景上传加固"（即下表"同时修背景上传"那一段），router 拆分**移入第 4 阶段且**倾向不做**。
> 拆 router 的收益是"文件更短"；风险是具体的四条：`include_router` 顺序本身是契约（错了静默 422）、`api_route` 双方法不能改（会顶红文档数字门禁）、`img_proxy` 三个符号必须再导出（那两条路径 pytest 覆盖不到）、6 处 monkeypatch 打在 router 模块属性上。
> **背景上传是真缺陷、今天就能咬人**：`routers/vtuber.py:218-221` 是**先删旧文件再写新文件** ⇒ 写新失败就丢了旧背景。这一段必做。

**目标**：HTTP 路径与 schema 保持兼容；复杂事务进入 `services/application/`；Router 不写文件、不 commit、不编排。

**核实结论（母计划没提的四个硬约束）**：

1. **`app/main.py:302-305` 的 `include_router` 顺序本身是契约**。`routers/vtuber.py:156` 有注释硬约束"`/vtuber/fetch-status` 必须**先于** `/vtuber/{vtuber_id}` 注册"；`:1189-1191` 记录过"`/vtuber/bili/search` 写成一段会被 `/vtuber/{vtuber_id}` 抢走 → 422"的实测踩坑。**顺序错了就是静默 422。**
2. **`@router.api_route(..., methods=["GET","POST"])` 必须保留**（`:890`、`:907`）。`tests/test_gen_doc_numbers.py:37` 专门断言路由计数要含 `api_route` ⇒ 改成两个装饰器会让**文档数字门禁变红**（那不是误报，是真变化）。
3. **`routers/img_proxy` 有三个外部符号必须保留再导出**：`close_client`（`app/main.py:284`）、`cache_stats` / `clear_cache`（`routers/settings.py:267,284`）。搬走后不 re-export 就静默 ImportError，而**这两条路径 pytest 覆盖不到**。
4. **6+ 条用例的 monkeypatch 直接打在 router 模块属性上**：`tests/test_vtuber_api.py:132/225/556/584/618/673` patch `router_mod._adopt_background`，`:197` patch `router_mod.asyncio.create_task`。**拆文件必须同步改这些目标**，否则改的是"旧模块的属性"而产品代码走新模块 ⇒ 静默失去守护（与批次 10 同款假绿）。

**同时修背景上传**（`routers/vtuber.py:198-242`）：
- 今天：`content_type` 白名单 + 10MB 上限，**但读的是 `await file.read()` 全量入内存、无魔数校验、先删旧文件再写新文件**（`:218-221` 的顺序 = **写新文件失败就丢了旧背景**）。
- 改为：限额**流式**读取 → 魔数/解码校验 → 写临时文件 → **原子 rename** → **新文件成功后**才删旧文件 → 失败不动旧文件。
- 测试：伪 MIME、超大文件、写盘失败（**"写盘失败"要能真的注入**，别只测 happy path）。

**先补的失败用例**：OpenAPI **paths + methods + response_model schema 名** diff（**不要比 `operationId`**——它随函数名/模块变化，会产生大面积无关 diff，母计划 §9 的停止条件之一）；API tests；背景上传三条；re-export 符号存在性（一条 import 断言即可）。

**门禁**：OpenAPI 路径 diff + API tests + `--tier full`。

**文档义务**：B 档偏 A。`docs/backend-repositories-and-routers.md`（路由表 + 新的 `services/application/` 层）+ `ARCHITECTURE.md` §5 + §7 + devlog。

**停止条件**：结构批改变用户交互；或 OpenAPI 工具产生大面积无关 diff。

---

### 批次 12 — M4：`PostsPage` 拆 hook + typed event

**核实结论：五台机器里只有三台今天能干净抽出。**

| hook | 能否抽出 | 依据 / 风险 |
|---|---|---|
| `usePostQueryState` | ✅ 低风险 | 7 个 state 的唯一外部写入方是 6 个 handler；**但 E9 与 scene 提交之间是隐式时序契约**（注释 517-519：必须在 `EXIT_MS` 提交前跑完，否则 `filterRef` 残留导致种子指纹错配）⇒ 抽 hook 时**原样保留为内部 effect**，不得改成"提交时重置" |
| `usePostPagination` | ✅ 中风险 | 抽 `posts`/`total`/`page`/`loadingMore`/`loadMoreError` + IO 哨兵 + `hasMore` + 回顶；**取数 effect（E11）不要一起搬** |
| `useSelectedAccount` | ✅ 中风险 | `accountKey` 已是显式稳定代理；`liveAcc`/`heroAcc` 是纯派生。**但 E7 同时写 `vtuberLoadedRef`（场景机的记账）** ⇒ 记账要留在页面或显式暴露 `markLoaded` |
| `useToolbarVisibility` | ✅ 低-中风险 | 最自洽的一台。**三条硬约束**：① 模块级 `toolbarFlashedThisSession`（"切 V 重挂不重闪"）必须随 hook 搬到模块作用域，**不能变 ref**；② `wantFlashRef` 的**渲染期判断**（270-273）是 StrictMode 正确性的关键，**禁止**改放进 effect（注释 262-268 记录了实测翻车：`restored: shown=1 opacity=1` 永久卡住）；③ E4 的 `subtree: true` MutationObserver 是跨组件隐式契约 |
| `useVtuberRealtimeSync` | ❌ **今天抽不干净** | E6/E8 **同时写** M2 的 `page`/`refreshTick`/`trendTick` 与 M3 的 `vtuber`/`selectedAccount`，而这两个 state 的**所有权在 `useSceneTransition.onCommit`**（一次原子提交 7~8 个 state，注释 421）⇒ 抽成独立 hook 会出**双写者**，`accountKey` 引用抖动直接改变请求时序。**前置条件**：先把身份写入收口到单一 owner |

**另有两处母计划没点的**：
- **E11（取数机）不能与 M2 一起抽**：`seededPostsKeyRef` 由 `onCommit` 写、由 E11 读（跨场景机↔分页机的隐式单次令牌）；错误分流依赖 `page === 1`；依赖数组 10 项横跨四台机器。
- **不要顺手改 `drawerPost`/`drawerOpen` 的分离**（110-112 注释：Radix 退场动画要求）。

**通用风险（仓库自己写过）**：`PostListView.tsx:9-11` 明写"那些 effect 的**顺序与依赖数组是契约**，搬动它们才会真正改变行为"。⇒ **任何 hook 抽取必须保持 effect 注册顺序与依赖数组字面量不变**。

**先补的失败用例**：切 V 取消旧请求；筛选重置分页；追加去重；短任务实时同步；工具条状态机；StrictMode 双 effect。**UI probe 管几何，hook 测试管行为。**

**门禁**：hook/component tests + 探针（`--toolbar` / `--scene` / `--archive`）+ tsc/eslint/vitest。

**文档义务**：B 档。`docs/FRONTEND-ARCH.md` + devlog。

---

### 批次 13 — Q1：API 契约

> ⚠️ **2026-09-25 修正**：**本批只做"便宜的那一半"——`ApiError`（带 `status`/`detail`/`path`）+ `JSON.parse` 的 try/catch + 关键响应的运行时校验。**
> OpenAPI 生成 + CI 无 diff 门禁**暂缓**：它是新增一条会漂的管道，而第二个消费方（社区脚本 / MCP / 插件）目前并不存在。有用户之后本批的理由从"防我自己改名"升级为**兼容性**（每个版本都有人停在上面），但它仍然排在第 3 阶段。

**核实结论**：见 §2.14。

**改动面**：
- 从 FastAPI OpenAPI **离线生成** TS DTO；`api.ts` 手写封装**暂保留行为**；CI 检查"重新生成无 diff"。
- 手写 `ApiError`（`status` / `detail` / `path`），替换 `api.ts:33` 的 `throw new Error(detail)`。**这会改变所有 `catch` 分支的行为**——`pages/useVtuberActions.ts` 有 6 处读 `r.status === 'skipped'` 绕行，要一起审。
- 关键响应加运行时校验（zod / valibot）；**动态 JSON 可保留 unknown 但消费点必须解析**。
- 顺手给 `JSON.parse` 加 try/catch（现在服务端 `ok:true` + 非 JSON 会抛裸 `SyntaxError`）。

**先补的失败用例**：生成无 diff；关键响应不再裸 `JSON.parse(...) as T`；401/403/409/422 分类稳定。反向验证：改一个后端 schema 字段名 ⇒ 生成检查 / 类型检查必红。

**门禁**：生成无 diff + contract tests + 前后端 build。**文档义务**：B 档。`docs/FRONTEND-ARCH.md` + devlog。

**注意**：必须在批次 11 之后。

---

### 批次 14 — Q2：可访问性（**视觉回归面最大，拆三段**）

> ⚠️ **2026-09-25 修正**：**从"砍掉"改为"该做，但排在第 3 阶段"** —— 有真实用户就有真实键盘用户与真实报障。
> **但要保留这个判断**：它仍是全计划**投入产出比最低**的一条（成本全在验证侧：摘掉 `outline:none` 会让一整族原生控件冒出默认边框，得逐个走查）。所以：
> - **优先做**：14c 里 `LiveSessionDialog` 迁 Radix Dialog（它顺手修掉"Esc 由父组件卸载、不播退场"这个**功能性**毛病），以及无限滚动的 live region（几行）。
> - **相位推进、可缓**：14a 的 focus 令牌体系、ECharts 的 sr-only 数据表、以及**整套 axe/RTL 基建**（只在批次 0.2 已经把测试环境装上、且你确实要长期维护前端时才做）。

**核实结论**：见 §2.13。前端现状：`aria-live` 全仓 **0 命中**；`role="status"` / `role="log"` **0 命中**；无限滚动只有 1px 不可见哨兵 + "加载中…" 文本，**无 live region、无显式"加载更多"按钮**（只在失败后给"重试"）；`FanTrendChart` 用 `CanvasRenderer`（DOM 里没有任何可读文本），只有 `fan-chart-summary` 三个差分值，**无 `<table>`、无 sr-only 摘要、无 `role="img"`**，`dataZoom` 平移**只能鼠标**。

**14a — focus 令牌 + 逐控件替换（不动全局规则）**
- 立 `--focus-ring` 令牌；收敛散落的 5 种环色；给**目前没有替代的 2 处**（`posts.css:778 .live-tag.clickable:focus-visible` 等）补上；补 `forced-colors` / `prefers-contrast` 的 `@media`。
- 验收：探针 + **人工键盘走查**（登录 / 添加 V / 筛选 / 详情开关四件事能用键盘完成）。

**14b — 摘掉 `index.css` 的全局 `:focus, :focus-visible { outline: none }`**
- **单独一段、单独可回滚**（"一行改动、全站视觉变化"的那种）。
- 已知会**新出现浏览器默认 outline** 的控件族：`.type-chip` / `.filter-chip` / `.view-btn` / `.lc-cell` / `.lc-dlg-*` / `.back-to-top` / `.fan-preset` / `.aps-nav-item` 等。
- 原注释的理由"图表 SVG 描粉"应改成更窄的规则（`canvas:focus, svg:focus`），**不要连 `:focus-visible` 一起关**。
- 反向验证：加回那条全局规则 ⇒ 键盘走查里的焦点必须重新不可见（否则说明令牌没接到需要的控件上）。

**14c — 对话框与 live region**
- `LiveSessionDialog` 迁已有 Radix Dialog，补齐**六项**：标题关联（现在标题是普通 `<span>`，`aria-labelledby` 全仓只有 1 处且不在它身上）、初始焦点、focus trap、Esc（**今天由父组件 `LiveCalendar.tsx:267-277` 提供且直接 `setDetail(null)` 卸载、不播退场**——迁移时注意别制造双重关闭）、背景 inert、焦点恢复。**`StatusIsland:332` 是另一处手搓 `role="dialog"`，同款。**
- 无限滚动：加 `aria-live` / `role="status"` + 显式"加载更多"备选；`loadMoreError` 也进 live region。
- ECharts：给 canvas `aria-label` + **sr-only 数据表**；`MosaicCloud` 的 SVG 补 role/label。

**门禁**：RTL/user-event/axe + 探针 + **手工键盘流程**（axe 不能替代手工键盘验收）。

**文档义务**：B 档。`docs/UI-MAP.md`（焦点令牌 + 对话框契约）+ `docs/FRONTEND-ARCH.md` + devlog。

---

### 批次 15 — Q3：真实 SQLite 与 Windows 真机 smoke

**核实结论**：已有 `tests/test_db_maintenance.py` 用**真实文件库**验 PRAGMA（含 `incremental_vacuum` / `checkpoint_wal` / `dir_stats`）⇒ "文件 SQLite"不是从零开始，**缺的是竞争/并发面**。

**改动面**：
- 文件 SQLite 必测：多 session 竞争写、WAL 读写并行、`busy_timeout`、T0 与帖子并发、checkpoint/重开、shutdown 后连接释放。**不得用内存库宣称验证 WAL。**
- Windows smoke：启动、token API、widget、托盘隐藏/唤回/深休眠、迁移失败回滚、托盘退出、无孤儿进程、更新器失败分类。
- **`docs/TODO.md` §1.3 已有用户侧待复验清单**（小窗 200×40 胶囊、拖拽、主窗 ✕、托盘退出后无残留进程、迁移、深休眠）——本批把其中**可脚本化的**升级为"有记录的真机 smoke"，并同步那张清单（该删的删）。**深休眠与托盘菜单只能人工验**（`ui_probe` 原理上验不到），要如实标注。

**门禁**：CI 绿 + Windows smoke 证据。**文档义务**：B 档。`docs/DEV-LOOP.md` §一/§四 + `docs/TODO.md` §1.3 + devlog。**本批必须纳入批次 16 的"迁移失败 / 升级失败"两个真机现场**（见批次 16 验收）。

---

### 批次 16 — ★新增★ 升级与迁移安全 + 诊断包

**为什么新增（母计划没有这一批）**："很多人用" + "继续发版"两条同时成立之后，**这一类故障的严重度超过了本文档里的任何一条**：

- 用户的档案在他自己机器上，**你看不见、够不着、无法远程诊断**。
- 迁移 / 升级失败 = **别人的数据**丢了。你自己机器上失败了还能翻日志重试。
- 而今天的迁移回滚编排（`lib.rs:286-317`）**一条集成测试都没有**，只能靠真机。

**核实到的现状（全部逐条读过）**：

| 面 | 现状 | 缺口 |
|---|---|---|
| 数据目录迁移 | `migrate_data_dir`（`lib.rs:254-344`）顺序：选目录 → 拒便携版 → `plan_migration` 校验 → `stop_backend` → 复制+逐文件校验 → 写指针 → 重启探活；失败会**回滚指针并用旧目录重启**（`:292-298`、`:306-317`） | 设计是对的（"旧目录全程不动"），但**这条回滚路径 0 条测试**，且只在真机上跑过一次 |
| **启动期 schema 迁移** | `app/main.py::_run_migrations()`（4 种库形态）——**这才是每次升级都会跑的迁移** | **无备份**。今天唯一的保护是"迁移在事务里、失败即回滚"（alembic + SQLite 的事务能力）；一旦中途失败（磁盘满 / 断电 / SQLite 报 locked），用户面对的是"打不开 + 没有任何退路" |
| 启动失败文案 | `main.tsx::Splash` 的 `failed` 态只有一句"内置后端服务未能在时限内就绪……请关闭应用后重新打开"，加一句"**请勿删除数据目录**" | **无法区分**"迁移失败"与"端口占用 / 杀软首扫慢 / 后端崩了"。用户拿不到可操作的下一步 |
| 诊断材料 | `bootDiag` / `window.__bootLog` / `sidecar.log` / `widget_diag` / `logs/app.log`（按天轮转）都在 | 散落在三处，**没有"一键导出成一份能给开发者看的东西"** |
| 升级回滚 | 只有"重装旧版"。而 NSIS 会覆盖 `binaries/backend/ddtoolkit.exe` | **没有内置回退路径**，用户不知道"旧版能不能装回来、数据会不会被降级的后端改坏" |

**改动面（按性价比排序，前两条必做，后三条可按预算裁）**：

1. **【必做】启动期迁移前自动备份 `vtuber.db`。** 位置 `<DATA_DIR>/backups/vtuber-<MIGRATION_HEAD>-<时间戳>.db`。**要复制 `-wal`、不要复制 `-shm`**（`migrate.rs:20-30` 已经记录过原因：`-shm` 是共享内存索引，必须由进程自己重建）。仅当"库形态需要真正跑迁移"时才备份（`_run_migrations` 的快路径要跳过，别拖慢常态启动）。保留最近 N 份 + 体积上限，超限按最旧淘汰。
2. **【必做】失败路径：迁移失败时绝不留下打不开的库，并且要告诉用户**。`_run_migrations()` 抛错时：把库移到 `vtuber.db.failed-<时间戳>`，**用空库继续启动**（应用可用），并在 `/healthz` 或启动标记里带出"上次启动的库迁移失败"；前端把它变成一句人话 + 一个"打开数据目录"的按钮 + 一个"导出诊断"的按钮。**判据是"用户能自己找回数据"，不是"日志里有异常"。**
3. **诊断包导出**：把 `sidecar.log`（尾部）+ `app.log`（当天）+ 库形态（`alembic_version` / 表数 / 文件大小）+ 迁移备份清单 + 应用与 WebView2 的版本号 + OS 版本，打包成一份用户可复制的文本或 zip。仓库里 `bootDiag` 与 `widget_diag` 已有雏形，缺"打包"。**注意：诊断包里绝不含 `.env` / cookie / token**（`docs/ARCHITECTURE.md` §6 第 10 条）。
4. **`migrate_data_dir` 的回滚编排补集成测试**（用一次性临时目录，不碰真数据目录）：复制失败 / 校验失败 / 指针写失败 / 探活失败四条路径，各断言"指针未变 + 旧目录内容未动 + 后端仍在旧目录上跑"。
5. **数据目录迁移的用户流程加强**：迁移前显式提示"将复制 N 个文件 / X MB、跳过 `logs` 与 `img-cache`"，并给"先备份"选项。

**先补的失败用例（怎么让它红）**：
| 用例 | 反向验证 |
|---|---|
| 令迁移在中间抛错 ⇒ 断言备份文件存在、`vtuber.db.failed-*` 存在、应用**仍能启动**、`/healthz`/启动标记带出失败信息 | 把"移走失败库 + 用空库启动"的逻辑去掉 ⇒ 必红（应用会起不来） |
| 迁移失败的分类：只有"schema 迁移失败"才提示"可找回"，端口占用/超时**不得**误报成数据问题 | 把分类写死成"任何启动失败都提示迁移失败" ⇒ 必红 |
| 备份：跳过 `-shm`、包含 `-wal`、快路径**不备份**、超出保留份数按最旧淘汰 | 把快路径也接上备份 ⇒ `_run_migrations` 的冷启动打点必须变红（`_perf` 有分阶段时间戳，正好可断言） |
| 诊断包**不含** `.env` / cookie / token | 把 `.env` 加进打包 ⇒ 必红（这条与批次 1 的 token 用例同源，**别重复写两份**） |
| `migrate_data_dir` 四条回滚路径 | 把指针提前写 ⇒ 必红 |

**验收**：**Windows 真机**两个现场各走一次 —— ① 把库改坏（或人为让迁移失败）后启动，确认"能起来 + 提示可找回 + 备份在位"；② 真做一次数据目录迁移并在中途制造失败，确认指针与旧目录未动。

**门禁**：A 档 gate + CI 绿 + 上面两个真机现场的证据。**文档义务**：**A 档**。`docs/ARCHITECTURE.md` §6 加不变量（"跑 schema 迁移前必须先备份；迁移失败不得留下打不开的库，且必须把失败分类告诉用户"）+ `docs/DEV-LOOP.md`（真机验证清单）+ `docs/RELEASE.md`（备份位置 / 诊断包位置 / 用户可回退到什么程度）+ `docs/GLOSSARY.md`（备份与诊断包的名词）+ devlog。

**停止条件**：备份在真实库上造成不可接受的启动延迟或磁盘占用（实测后定阈值）；或诊断包无法在不含凭据的前提下提供足够信息 ⇒ 停，先问用户"要不要让用户手动勾选要打包的日志"。

---

## 4. 每批的收尾检查清单（照抄，别自由发挥）

```text
[ ] 开工先 git status --short（核实当天：只有 docs/README.md 被改 + docs/ARCHITECTURE-IMPROVEMENT-PLAN.md 未跟踪；
    本文件加入后再核实一次 —— 用户改动不得覆盖/重置/暂存/顺手整理）
[ ] 先补能失败的用例 → 跑一次确认它红 → 再写实现
[ ] 新增/修改断言都做反向验证：改坏要红、恢复要绿（改不动就换更极端的改法 —— DEV-LOOP §0.7）
[ ] 不写死测量值（测试数/迁移数/文档数）→ 查 python scripts/gen_doc_numbers.py --list
[ ] 同步活文档（逆索引见 .dsh/skills/ddtoolkit-docs-devlog/references/doc-map.md）
[ ] 写 devlog（编号查 --list；每需求 1 篇、≤40 行；脱离本批仍成立的经验提炼进 ARCHITECTURE §6 / DEV-LOOP / design-*）
[ ] python scripts/gate.py --plan 看清档位 → 跑对应档 → 收尾用 --tier full 兜一次
[ ] git diff --check / git status --short
[ ] 报告只写母计划 §7 那张表要求的字段；不发布
```

---

## 5. 本方案不做什么

母计划 §1.3 的非目标全部保留。**另加四条**：

1. **不在同一批里既拆 scheduler 又修安全边界**（批次 4 与批次 10 必须隔开）。
2. **不为"行数变少"而搬代码**。本仓有明确记录（`PostListView.tsx:9-11`）："effect 的顺序与依赖数组是契约"。抽 hook / 拆模块的判据是"**能不能对每个模块单独写出一条有牙口的用例**"，不是行数。
3. **不复制本文件里的行号与数字去写文档**。本文件的数字是 **2026-09-25 的带日期快照**；写进 devlog 时该写当时实测值，写进活文档时该指向真源。
4. **不新增"复述型"规矩**。若要写文档，遵循本仓已定的两条：**能引用就别复述**（指向 `scripts/` 的真源）；**必须复述的保持短，且行为要有门禁兜底**（`docs/DEV-LOOP.md` §0.4：实测同一条规则的复述面达 37 处 / 14 份文件，单条搜索词覆盖率最高 49%）。

---

## 附录 A：事务 owner 清单（批次 7 的输入）

`app/` 内 `.commit()` / `.rollback()` 共 69 处，按文件分布：

| 文件 | commit | rollback | 备注 |
|---|---:|---:|---|
| `repositories/vtuber_repo.py` | 21 | 1 | 唯一在 Repo 内成对 try/rollback 的是 `ProfileCardRepo.replace_all:1167/1169`；`PostRepo.create(commit=True)` 是唯一带 `commit=False` 的口子 |
| `routers/vtuber.py` | 3 | 7 | `adopt_vtuber:1269` 是 router 自己提交 |
| `services/scheduler.py` | 10 | 19 | 覆盖 13 个任务/循环 |
| `services/tombstone.py` | 2 | 0 | |
| `services/importer.py` | 1 | 1 | 整批导入一个事务 |
| `services/externals/*.py` | 3 | 1 | runner 的 rollback 做单任务异常隔离 |

> 逐行清单（含宿主函数与事务覆盖范围）在本次核实底稿里。执行批次 7 时**重新生成**，不要照抄：
> `Select-String -Path app\**\*.py -Pattern '\.commit\(\)|\.rollback\(\)'`

## 附录 B：本批核实用到的六条查法（可复用）

1. **"这个能力接线了吗"要顺着调用链看，别只搜一层**（`docs/TODO.md` §1.1 记录过一次误判：只 grep 了 `count_tokens(` 的调用方，漏了路由器调的是 `build_word_cloud`）。
2. **"某文件多少行"要用 `read` 的行号口径**（`Measure-Object -Line` 会漏空行：实测 `scheduler.py` 报 2673，真值 3487）。
3. **判定"权限 / 能力边界"要枚举端点，不要抽查**（64 条路由里任何一条漏配就是一个洞）。
4. **判"这条用例到底在测什么"时先看 conftest 的 autouse fixture**（本仓有两个：隔离风控状态、钉死未登录态）。
5. **"配置写了"不等于"生效"**——`build.rs` 的证据说明：capability JSON 对自定义命令**根本不参与判定**。
6. **容器 / 沙箱里跑不起来的门禁（pytest 需要可写 temp、esbuild 需要 spawn 权限）要在正常权限环境复跑，不得改产品代码迎合沙箱**（母计划 §8 原文；本次核实中 `pytest` 正是因"无可写临时目录"而未能实跑，**基线数字因此未经本轮复核**）。
