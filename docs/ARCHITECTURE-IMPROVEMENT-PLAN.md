# DDToolkit 架构改进执行方案

> 状态：待执行。
> 适用基线：当前 `main`，迁移 head 与版本等动态事实以代码和 `python scripts/gen_doc_numbers.py --list` 为准。
> 目标读者：负责实际修改代码的执行 Agent。本文件是实施路线与验收合同，不代替 `docs/ARCHITECTURE.md` 的现行架构真源。
> 总原则：**不重写、不微服务化、不换技术栈**；保留 Tauri + FastAPI sidecar + SQLite + React 的模块化单体，只收紧安全边界、生命周期、事务边界和高复杂度模块。

---

## 0. 给执行 Agent 的直接指令

执行本方案时必须遵守以下规则：

1. **一次只做一个批次**。每批独立建立护栏、修改、验收、写 devlog，不允许把安全改造、模块拆分和视觉改动混在同一个提交。
2. 开工前读取：`docs/ARCHITECTURE.md` §5/§6、`docs/GLOSSARY.md`、`docs/DEV-LOOP.md` §0、本批涉及的深度文档、`.dsh/skills/ddtoolkit-conventions/SKILL.md`；需要同步文档时再读 `ddtoolkit-docs-devlog`。
3. **保护现有工作树**。开工先执行 `git status --short`；用户已有改动不得覆盖、重置、暂存或顺手整理。审查时已知 `frontend/src/dev/probe.ts` 有未提交改动，执行时必须重新核实。
4. Bug 修复先补能失败的回归测试；新机制先补拒绝路径/故障路径，再写成功路径。
5. 不凭注释判断实现完成；沿实际调用链核实。新增断言必须做反向验证：人为破坏后应变红，恢复后变绿。
6. 不写死会漂移的测试数、迁移数和文档数；查询真源。
7. 涉及路由、模型、迁移、`purge.py` 或全局不变量属于 A 档，必须同步代码、测试、活文档、devlog 和门禁。
8. 每批结束只报告：改了什么、为什么、风险、验证命令及真实结果、尚未验证项。环境导致的 skip/fail 不能冒充通过。
9. 禁止借机更换数据库/ORM，引入微服务、Redis、Celery、全局状态大框架，全仓格式化，或在安全批同时大拆 `scheduler.py`。

---

## 1. 改进目标与完成定义

### 1.1 总目标

将项目从“功能成熟、依赖经验维持边界”提升为“安全边界显式、运行时可关闭、事务归属明确、核心模块可分工维护”的本地桌面产品。

### 1.2 总体验收标准

全部计划完成后，应同时满足：

- 普通网页和未持有本次启动 token 的本机请求不能读取业务 JSON、修改数据、触发抓取或修改设置；
- 平台 HTML 在进入 React DOM 前经过白名单净化；
- FastAPI lifespan 退出后，T0、综合档、外部调度及后台任务不再继续执行；重复启动不会产生双份调度线程；
- 多表业务的 commit/rollback 由明确的任务或应用服务边界控制；
- `scheduler.py`、`routers/vtuber.py`、`PostsPage.tsx` 按职责拆分，但 API 与用户行为兼容；
- 新平台的账号、内容、直播、鉴权能力由显式 capability 描述，不再隐式绑定 B 站；
- 键盘焦点可见；模态框具备标题关联、焦点圈定、Esc 关闭和焦点恢复；
- 前后端关键 DTO 有自动生成或运行时验证的契约；
- 质量门禁进入 CI，Windows 专属行为有最小真机 smoke；
- 旧库迁移、数据目录迁移、托盘退出、深休眠和抓取不变量不被破坏。

### 1.3 非目标

不做云同步、多用户、远程服务化、PostgreSQL、消息队列、UI 全面重设计、全量重写抓取器、全局状态框架迁移、独立 npm 组件库或 SDK 包。

---

## 2. 优先级与依赖图

```text
阶段 S：安全边界
  S1 sidecar token + CORS
  S2 HTML 净化
  S3 Tauri capability / 外链 / 删除目录
        ↓
阶段 R：运行时可靠性
  R1 调度器可停止生命周期
  R2 状态存储并发一致性
  R3 事务边界收口
        ↓
阶段 M：模块边界
  M1 后端纯依赖与平台 capability
  M2 scheduler 拆分
  M3 routers 拆分
  M4 PostsPage 行为拆分
        ↓
阶段 Q：契约、可访问性与交付
  Q1 API 契约生成/校验
  Q2 焦点与模态框
  Q3 CI + 文件 SQLite + Windows smoke
  Q4 依赖锁定与凭据保护
```

约束：S1 最先完成；R1/R2 完成前不拆 scheduler；R3 完成前不大拆 repositories/router；模块拆分后再生成 API 契约。

---

# 3. 阶段 S：安全边界

## S1. sidecar 会话认证与 CORS 收口（发布阻断项）

### 目标设计

每次桌面应用启动生成高熵、仅存内存的 `api_token`：

```text
Tauri 生成 token
  ├─ 启动 sidecar 时注入 DDTOOLKIT_API_TOKEN
  ├─ 主窗口经受限 command 获取 token
  └─ widget 经受限 command 获取 token
FastAPI middleware/dependency
  └─ 校验 X-DDToolkit-Token，使用常量时间比较
```

开发浏览器模式允许显式环境变量配置固定开发 token，但生产不得默认空 token。

### 路由分级

| 类别 | token | 说明 |
|---|---:|---|
| `/healthz` | 否 | 只返回最小启动信息 |
| `/static/*` | 暂否 | 现有 `<img>` 直接加载；以后可做签名 URL |
| `GET /img-proxy` | 暂否 | 保留主机白名单、逐跳校验、类型/体积上限；不加入 CORS 允许源 |
| 其余 GET JSON | 是 | 防本地数据被网页读取 |
| POST/PUT/PATCH/DELETE | 是 | 保护全部副作用操作 |

失败统一 401，错误文本不得回显 token。

### 修改位置

- `frontend/src-tauri/src/lib.rs`：生成/保存 token、注入 sidecar、新增读取命令；
- `frontend/src-tauri/Cargo.toml`：CSPRNG 依赖；
- `frontend/src-tauri/capabilities/*.json`：限制命令窗口；
- `backend_main.py`、`app/core/config.py`；
- 新建 `app/core/api_auth.py`；
- `app/main.py`：认证与 CORS；
- `frontend/src/api/api.ts`：自动带 header；
- `frontend/src/main.tsx`、`widgetMain.tsx`：业务请求前完成 base + token 注入。

### CORS 决策

- 禁止生产默认 `*`；开发只允许显式 Vite origin；
- Tauri production origin 必须真机记录后配置，不凭印象写死；
- token 是主安全边界，Origin/CORS 是纵深防御；
- 不使用 cookie 鉴权。

### 必测

- 无/错/正确 token；所有写方法无 token；公开路径；token 不入日志/异常/OpenAPI 示例；任意 Origin 不获允许头；
- 前端 request 自动带 token，注入前不发业务请求，主窗/widget 独立初始化，401 不泄露秘密；
- Rust token 非空、同进程一致、不同启动重新生成，命令只对指定窗口开放。

### 验收

浏览器直访 `/vtuber/list` 为 401；Tauri 主窗、小窗、图片、登录、抓取正常；开发态显式 token 可用；日志与 DOM 无 token。

---

## S2. 平台 HTML 白名单净化

保留库中原始 HTML 作为证据层，在展示边界使用成熟 sanitizer。允许段落、换行、强调、列表、引用、代码、表格等必要子集；链接仅 `http/https`。禁止 script、style、iframe、form、object、embed、SVG、事件属性、内联样式和危险 scheme。

修改：新增 `frontend/src/utils/sanitizePlatformHtml.ts`；`PostDetailDrawer.tsx` 只消费净化结果；添加依赖和真实/恶意 fixture 测试；不得放宽 CSP。

测试必须覆盖 script、事件属性、`javascript:`、`data:text/html`、SVG、iframe/form、畸形嵌套，以及正常排版不过度损坏。反向改回原始 HTML 时测试必须红。

---

## S3. Tauri 最小权限、外链和删除目录

### S3-A 分窗 capability

拆成 `main.json` 与 `widget.json`；widget 只留必要窗口/事件权限，主窗保留 dialog/updater/restart 等。Rust command 同时校验 caller window label，不能只信 capability。

### S3-B 外链白名单

改为 Rust 固定命令：只允许 `https` 和真实业务白名单主机；拒绝 userinfo、file、自定义 scheme、localhost 与编码绕过。前端不再对后端提供的任意 URL调用通用 shell open。

### S3-C 删除旧数据目录

替换 `delete_old_data_dir(dir)`：迁移成功后 Rust 保存 `{canonical_path, migration_id}`；前端只传 opaque id。删除前重新 canonicalize，严格等于本次迁移记录；拒绝当前目录、祖先/子目录、symlink/reparse point；用多个 DDToolkit 特征文件确认；成功后清除 id，禁止重放。

必测 capability 矩阵、危险 URL、任意 `.env` 目录、`..`/大小写/短路径/symlink/junction/当前目录等价路径、id 重放与正常删除。

---

# 4. 阶段 R：运行时可靠性与事务

## R1. 调度运行时可停止

建立 `SchedulerRuntime`，统一持有 `stop_event`、live/tier thread、APScheduler 和后台任务。循环用 `stop_event.wait(timeout)` 替代不可中断 sleep；stop 顺序为停止接新任务→通知线程→取消任务→join→关闭 APScheduler/HTTP client。start/stop 幂等；超时退出必须告警；daemon 只作兜底。

测试：线程各只有一份；stop 后计数不增长；start-stop-start 无残留；等待/冷却中可停止；连续 TestClient lifespan 不双跑。

## R2. FetchStatusStore

把 `_status`、`_external_labels`、序号和 recent 收进 `FetchStatusStore`，用短持有 `threading.RLock` 原子更新。`snapshot()` 返回独立副本，recent 用有界 deque；锁内不得网络、数据库或重 IO。

测试多线程 start/finish 后 running/label/seq 一致、并发 snapshot 稳定、recent 上限、未知 token 行为和现有 API 字段兼容。

## R3. 事务边界收口

原则：Repository 默认不 commit，只 flush；application service/任务是事务 owner；Router 只映射 HTTP；网络请求不持有长写事务。

先处理删除账号、删除 VTuber、T0 live 状态+跳变快照、profile cards 替换、收录 V+Account。逐一搜索 `.commit()` 并标注 owner，不一次改完所有 Repo。

必测：purge 中途失败全回滚；快照失败时 live 状态回滚；布局半途失败保留旧布局；账号唯一冲突不留孤儿 V；锁冲突后 session 可继续使用。

---

# 5. 阶段 M：模块边界与扩展性

## M1. 依赖方向与平台 capability

将 `normalize_title` 下沉到无 IO 的 domain/util，消除 `repositories → services`。

扩展 `BasePlatform` 的显式能力：内容是否需登录、账号/帖子/直播支持、帖子流集合，并提供平台级 `content_fetch_allowed()` 与可选 `fetch_live_batch()`。微博登录不受 B 站状态阻断；B 站双流显式表达；T0 只调用支持 live batch 的平台；unsupported 必须结构化返回。

测试 B站/微博四种登录组合、只支持账号的 fake platform、多平台风控隔离。同步 `platforms-extension-guide.md`，取消“一行注册获得全部能力”的过度承诺。

## M2. 拆 scheduler，保留 façade

目标：

```text
app/services/scheduling/
  runtime.py
  status.py
  arbitration.py
  pacing.py
  account_jobs.py
  post_jobs.py
  live_jobs.py
  external_jobs.py
app/services/scheduler.py  # 兼容 façade
```

一次只搬一个职责；先纯逻辑，再 jobs，最后 runtime。旧公开入口暂时重导出；不改变状态字段、锁语义、节流常量、stop reason；模块级禁用 asyncio 原语的不变量继续成立。

完成时 façade 只剩组装/兼容导出，无循环 import，抢占、平台并发、增量停止和 T0 测试均保持。

## M3. 拆 Router 与应用服务

目标路由按 vtubers/accounts/posts/live_sessions/profile/fetch_tasks 拆，复杂事务进入 `services/application/`。HTTP 路径和 schema 保持兼容。Router 不直接写文件、不 commit、不编排复杂业务；背景任务统一由 runtime/task service 管理。

同时修背景上传：限额流式读取、魔数/解码校验、临时文件+原子 rename、新文件成功后再删旧文件、失败不破坏旧背景。测试伪 MIME、超大文件和写盘失败。

## M4. 拆 PostsPage 行为

提取 `usePostQueryState`、`usePostPagination`、`useSelectedAccount`、`useToolbarVisibility`、`useVtuberRealtimeSync`。每个 hook 拥有完整状态转移，不为减行数机械搬 state；typed event 模块集中事件名与 payload；不引入全局状态库。

测试切 V 取消旧请求、筛选重置分页、追加去重、短任务实时同步、工具条状态机、StrictMode 双 effect。UI probe 管几何，hook 测试管行为。

---

# 6. 阶段 Q：契约、可访问性与交付

## Q1. API 契约

先从 FastAPI OpenAPI 离线生成 TS DTO，手写 `api.ts` 暂保留行为封装；高风险响应增加运行时 schema；CI 检查重新生成无 diff。`ApiError` 保存 status/detail/path。动态 JSON 可保留 unknown，但消费点必须解析。

验收：后端字段漂移在生成检查/类型检查中变红；关键响应不再裸 `JSON.parse(...) as T`；401/403/409/422 分类稳定。

## Q2. 可访问性

- 删除全局无条件 `outline:none`，建立 focus token 和统一 `:focus-visible`；
- `LiveSessionDialog` 迁已有 Radix Dialog，补标题、初始焦点、focus trap、Esc、背景 inert、焦点恢复；
- 无限滚动增加 live region 和“加载更多”备选；ECharts 提供摘要和数据表；
- 引入 Testing Library + user-event + axe，覆盖关键弹窗和键盘主路径。axe 不能替代手工键盘验收。

## Q3. CI、真实 SQLite 与 Windows smoke

跨平台 CI：Python syntax、pytest、tsc、eslint、vitest、doc_check、OpenAPI 无 diff。Windows：cargo test、前端 build、文件 SQLite/WAL 测试、sidecar 冒烟；可选 nightly 真窗口 smoke。

文件 SQLite 必测多 session 竞争写、WAL 读写并行、busy timeout、T0 与帖子并发、checkpoint/重开、shutdown 后连接释放。不得用内存库宣称验证 WAL。

Windows smoke：启动、token API、widget、托盘隐藏/唤回/深休眠、迁移失败回滚、托盘退出、无孤儿进程、更新器失败分类。

## Q4. 依赖锁定与凭据

选择 `uv.lock`，或 `requirements.in` + hash-pinned lock，只保留一个真源；区分运行/开发依赖，PyInstaller 使用锁，依赖更新独立批次。

近期限制 `.env` 当前用户可读并对日志/诊断脱敏；后续用 DPAPI/Credential Manager。旧明文迁移必须可回滚，成功后才清理旧值，便携模式风险写清。

---

# 7. 每批执行与汇报模板

## 开工

```text
批次：S1 / R1 / ...
改动档位：A / B / C
用户可见行为：
本批不做：
涉及不变量：
现有脏文件：
计划新增的失败测试：
```

## 顺序

读取真源→建立失败测试→反向确认→最小实现→局部测试→跨层测试→同步活文档→写 devlog→跑对应 gate→`git diff --check`/`git status --short`→报告未验证项。不得自行发布。

## 完成报告

```text
完成：
关键设计决定：
修改文件：
新增/修改测试：
反向验证：
门禁结果：
环境导致的 skip/fail：
兼容性与迁移：
剩余风险：
下一批前置条件：
```

---

# 8. 批次门禁

命令以脚本 `--help` 为准，不在此固化基线数字。

| 批次 | 最低门禁 |
|---|---|
| S1 | 认证/API 测试 + cargo test + tsc + 开发/真机启动冒烟 + A 档 gate |
| S2 | sanitizer 单测 + tsc/eslint/vitest + build + CSP 复核 |
| S3 | cargo test + capability 检查 + Windows 迁移/窗口 smoke |
| R1 | 生命周期测试 + pytest 相关集 + 启停冒烟 |
| R2 | 多线程状态测试 + fetch-status 契约 |
| R3 | 文件 SQLite 故障测试 + 删除/收录/profile/T0 回归 + A 档 gate |
| M1 | 平台 capability 矩阵 + 扩展指南门禁 |
| M2 | 每搬一模块跑 scheduler 测试，收尾 full gate |
| M3 | OpenAPI 路径 diff + API tests + full gate |
| M4 | hook/component tests + UI probe + tsc/eslint/vitest |
| Q1 | 生成无 diff + contract tests + 前后端 build |
| Q2 | RTL/user-event/axe + UI probe + 手工键盘流程 |
| Q3 | CI 绿 + Windows smoke 证据 |
| Q4 | 干净环境可复现安装 + frozen/portable 冒烟 |

受限环境出现 `esbuild spawn EPERM`、临时目录不可写时应在正常权限环境复跑，不能修改产品代码迎合沙箱。

---

# 9. 停止条件

以下情况必须停下报告：无法确认 production Origin；token 只能放 URL；图片鉴权迫使一次性大改 blob 管道；scheduler 无稳定测试基线；事务改造出现跨请求共享 Session；无法可靠识别 reparse point；OpenAPI 工具产生大面积无关 diff；结构批改变用户交互；用户改动冲突；full gate 出现真实回归。

---

# 10. 推荐提交序列

1. `security: protect sidecar API with per-launch token`
2. `security: sanitize platform HTML before rendering`
3. `security: narrow Tauri capabilities and destructive commands`
4. `runtime: make scheduler lifecycle stoppable`
5. `runtime: serialize fetch status transitions`
6. `data: establish explicit transactions for multi-table actions`
7. `platforms: make authentication and capabilities platform-scoped`
8. `refactor: split scheduler internals behind compatibility facade`
9. `refactor: split HTTP routers and application services`
10. `refactor: split PostsPage state machines into hooks`
11. `contract: generate frontend DTOs from OpenAPI`
12. `a11y: restore focus semantics and standardize dialogs`
13. `ci: add cross-platform gates and Windows smoke`
14. `build: lock dependencies and harden credential storage`

禁止 squash 成一个大提交；也不要为机械搬文件逐个写 devlog，同一需求子批按仓库纪律合并记录。

---

# 11. 最终目标图

```text
Tauri Shell
  ├─ ProcessSupervisor（token / port / process / Job / data migration）
  ├─ Main capability
  └─ Widget minimal capability
FastAPI
  ├─ Security boundary
  ├─ Thin routers
  ├─ Application services / transaction owners
  ├─ Scheduling runtime（arbitration/status/pacing/jobs）
  ├─ Platform adapters + capabilities
  ├─ Repositories（query/flush）
  └─ SQLite WAL + Alembic
React
  ├─ Generated/validated API contract + ApiClient
  ├─ Server-state hooks
  ├─ Typed event bridge
  ├─ Accessible primitives/common components
  ├─ Feature components
  └─ Thin pages
```

部署形态不变，仍是单机模块化单体。

---

# 12. 最终复审问题

1. 无 token 能否调用业务 API？
2. token 是否出现在 URL、日志、DOM 或异常？
3. 恶意 HTML 能否形成脚本、危险链接或 Tauri 调用？
4. lifespan 退出后是否仍有业务线程/协程？
5. 多表失败是否保持完整旧/新状态而非中间态？
6. 微博是否仍受 B 站登录状态误阻断？
7. 新平台 capability 是否代码/文档一致？
8. 事务 owner 能否从代码直接看出？
9. 键盘能否完成登录、添加 V、筛选和详情开关？
10. schema 漂移能否在 CI 被发现？
11. CI 能否在干净环境复现构建？
12. 数据迁移、删除、托盘退出、深休眠是否有 Windows 实测证据？

全部有代码、测试或真机记录作证，才算本轮完成。
