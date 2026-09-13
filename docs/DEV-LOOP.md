# 开发态快速验证（DEV-LOOP）——不打包也能验证改动

> 起因（2026-09-08）：连续两个 bug（NSIS 资源打平、扫码轮询读错字段）都只能靠
> `npm run release`（PyInstaller + cargo + NSIS，4–6 分钟）出包后人工试出来，
> 一轮排查要十几分钟。实际上**绝大多数改动都不需要整包重建**——把「要验的状态」
> 搬到能秒级复现的环境里即可。

## 一、先分清「要验的是什么」

打包版之所以会坏，通常不是因为「打包」本身，而是因为打包版才具备的状态：

| 打包版独有的状态 | 开发态默认没有 | 怎么在开发态复现 |
|---|---|---|
| 全新数据目录（无 `.env` / 空库） | 项目根 `.env` + 老库 | `DDTOOLKIT_DATA_DIR=<空目录>` |
| 冻结运行时（PyInstaller `_internal`） | 源码直跑 | `python scripts/build_backend.py` 后直接跑 exe |
| Tauri 资源映射（installer 布局） | 无 | 只有它需要整包重建（改 `tauri.conf.json` 时） |
| 前端产物（`dist/` 打包进 exe） | Vite dev server | `npm run dev` + `VITE_API_BASE` 指到后端 |

**结论**：后端逻辑 / 登录 / 首启 / 迁移类改动 → 秒级或 1 分钟级就能验完；
只有动到 Rust（`src-tauri/src`）、`tauri.conf.json`、或需要真机确认前端产物时才整包重建。

## 二、一条命令的快速自检

```powershell
python scripts/dev_check.py             # 单测 + 开发态后端冒烟（约 20 秒）
python scripts/dev_check.py --frozen    # 追加：冻结后端 exe 冒烟（需先 build_backend，约 1 分钟）
python scripts/dev_check.py --portable  # 追加：重打便携 zip（免 cargo/NSIS，约 2 分钟）
python scripts/dev_check.py --full      # = --frozen --portable
```

它做三件事：

1. `pytest tests/` —— 266 个用例的回归网（含 B 站扫码四态、同名 cookie 冲突、
   账号白名单回填、首启标记等回归用例）；
   **另加前端三条**：`npm run lint`（eslint，`--max-warnings 0`）、
   `npm run test`（vitest，纯函数单测）、`npm run check:dates`（日期区间 30 条断言）
   —— 已并入 `dev_check.py` 的 `frontend logic` 一项；缺 `frontend/node_modules`
   时显式打印 `[skip]` 而非静默通过；
2. **空数据目录**起后端（源码或冻结 exe）→ 验 `/healthz` + 扫码状态机
   （`qr/start` → 连续 `qr/check` 必须停在 `waiting`，防「读错 code 字段」回归）；
3. 需要时重打便携 zip。

失败时会把现场数据目录打印出来（`console.log` / `logs/sidecar.log`）便于定位。

### 桌面端图标（LOGO 变更后重生成）

```powershell
python scripts/make_icons.py     # 从 docs/design/png/NGNlogo无底.png 生成
```

品牌粉圆角底 + 白猫脸，输出 `frontend/src-tauri/icons/`（含多尺寸 `icon.ico`、
`icon.png`、Windows 商店 `Square*Logo.png`、`icon.icns`）。改 LOGO 后跑一次即可。

## 二·五、布局类改动的机器验证（`scripts/ui_probe.py`）

布局问题（原生滚动条、内容出窗、出现滚动条导致宽度跳动）肉眼难复现、打包才暴露。
2026-09-08 起固化为可复跑的探针：

```powershell
python scripts/ui_probe.py                          # 1100 / 1280 / 1440 三档宽度
python scripts/ui_probe.py --width 1100             # 指定宽度
python scripts/ui_probe.py --height 680             # 矮窗（视口 ≈541）：验弹窗高度兜底路径
python scripts/ui_probe.py --shot                    # 额外每档宽度存一张「筛选弹窗打开态」图
python scripts/ui_probe.py --archive                 # 只跑一档：dump 直播日历每格实渲染 + 最近一场详情弹窗内容
python scripts/ui_probe.py --first-run --width 1100 # 空数据目录：验首启登录浮窗（走独立契约，不做布局断言）
python scripts/ui_probe.py --vtuber 15 --width 1280  # 指定 V（默认取列表第一条）——用于命中多平台药丸等特定数据形态
python scripts/ui_probe.py --hero-print --vtuber 15  # 只打印 cards 视图 hero 药丸签名与实测明细（建立基线用）
python scripts/ui_probe.py --hero-expect <sha256>    # 位级回归：hero 药丸签名必须与基线一致，否则退出 1
python scripts/ui_probe.py --archive --archive-print --vtuber 15      # 取「日历格内文本」基线（A-2 取数链路护栏）
python scripts/ui_probe.py --archive --calendar-expect <sha256> --vtuber 15  # 重构后比对日历格签名
python scripts/ui_probe.py --archive --archive-day 11 --vtuber 14    # 点指定日号的格子（最近一场常未收录弹幕/热词）
python scripts/ui_probe.py --settings --vtuber 15   # 档案设置弹窗：几何 + **可点性** + 点候选行换来源（两个带签名账号）
python scripts/ui_probe.py --settings --vtuber 14   # 同上但只有一行且签名长：断言渐隐/可滚距离，切换断言打印 [跳过]
```

> `--settings`（2026-09-13 起，devlog/075）测 21 项，除了几何还有**可点性**：
> `elementFromPoint` 命中测试（`panelHit`/`rowHit`）与"点一行会怎样"（`pickValueMatches`/
> `pickKeepsDialog`/`pickClosedPanel`/`restoredSource`）。加它们的起因是几何全绿但用户
> **点不动**（面板 portal 到 body 继承了 radix 给 body 的 `pointer-events:none`）。
> 另外两点测量口径：① 探针跑在**虚拟时间**下，入场动画会被冻在中途 → 量之前先注入
> `animation:none; transition:none`；② 同宽看 `offsetWidth`（布局宽），不看视觉矩形。

它自动：复制开发数据目录 → 起后端 → 起 Vite → 无头浏览器加载
`/vtubers/<id>?probe=1`（`frontend/src/dev/probe.ts` 会依次切四个视图、在列表页跑一遍
**筛选弹窗全链路**（开 → 预设 → 确认 → 重置 → Esc）、再点一次「投稿」筛选，共八段测量），
断言八组不变量：

| 不变量 | 含义 |
|---|---|
| **探针完整性**（2026-09-11 两轮加固）| **「跑通了」必须等于「量到了」**：量测段数须等于契约序列（`EXPECTED_TAGS`，八段）、不得量到空置页（`empty`）、页面自报的 `degraded`（视图钮点不中 / 投稿 chip 缺失 / 无视图光条）一律判失败。此前 `_first_vtuber` 一失败路由就落到 `/`，探针只 emit 一段 `empty`、**所有卡片与筛选断言静默空转，脚本照旧打印 `[ok]` 退出 0**（静态审计 2026-09-11 点出的假通过路径）。<br>**第二轮（同日）补掉剩余 5 处空转**：顶栏未采到（`ok=false`）现按契约失败、`overflowing`/`scrollers` 缺键不再当空列表、`cards.innerMaxW` 为 `null` 判失败、卡片段无内容时报「未量到」 |
| `scrollbarPx == [0,0]` | 文档层永不出现滚动条（窗口级滚动条 = 内容宽度跳 12px 的根源） |
| 无可见出窗元素 | 没有元素越过窗口左右缘（被 `overflow:hidden` 裁掉的折叠组不算） |
| 无容器横向溢出 | `overflow-x:auto/scroll` 容器不得 `scrollWidth > clientWidth`（白名单：`.type-chips` 有意横滚） |
| 无原生滚动条 | 滚动容器统一 OverlayScroll，否则出现/消失会挤动布局 |
| 列表卡片列宽契约 | 列表页 `.list-inner` ≤ 900px、卡片铺满该列且宽度一致、封面恒 220 且不被左缘裁切（2026-09-08 回归事故固化：OverlayScroll 插层让 `.list-scroll > .list-inner` 静默失效，列宽随内容在 566～1350px 之间乱跳）。**列宽契约量测已与「列表里有没有帖子」解耦**（`measure().contract` 常驻）——旧写法把守卫写在 `cards` 非空分支里，列表一空断言就失效 |
| 筛选弹窗不出右栏 | `.post-filter-pop` 完整落在 `.posts-panel` 可视区内（该容器 `overflow:hidden`，越界＝静默裁掉左月历/底部按钮）、可见月份面板 = 2 且各 42 格、预设 = 6、初始「确认」可用（2026-09-10 P10-A 固化：首跑即抓到弹窗超出可用高度 50px 与窄窗降级反而更高） |
| 筛选弹窗交互链 | 草稿态不改触发器（`筛选`）→ 点预设高亮 → 点「确认」关窗且触发器变 `筛选 · 1` → `重置`+Esc 回 `筛选` 且关窗 |
| 顶栏展示策略 | 采样当时若**只有自动节拍在跑**（`post.auto`/`account.auto` 且无手动任务）→ 顶栏必须是空闲态（不亮容器、文案不是任务进度）。2026-09-10 起探针每次运行会打印一帧「后端事实 vs 顶栏渲染」采样，用于核对 |

> **量不到 ≠ 通过**：`max-width`/`coverW`/`confirmDisabled` 等取值一旦为 `null`（选择器踩空）
> 都直接判失败，不再静默放过——「断言被 null 中和」与「断言通过」在报告里必须区分得开。
> 全部失败条目都会打印（旧版只印前 8 条，后面的被吞）。

> **纯逻辑（无浏览器）**：日期区间算术（预设量纲 / 月位移夹取 / 本地解析 / 6×7 网格）
> 在 `frontend/src/utils/dateRange.ts`，可直接跑
> `node scripts/check_date_range.mjs`（Node 24 类型擦除直读 `.ts`，30 条断言）。
>
> **`--archive`（内容类排查）**：把直播日历每格的**实渲染文本**与「最近一场详情弹窗」
> 的弹幕/词云/动态行数落进探针 JSON 并打印——内容缺失类问题（不是布局）靠它定位，
> 2026-09-10 修「近期场次详情空白」（devlog/052）即用它做的端到端复验。
>
> ⚠️ `--archive` 固定点「**最近一场**」：若最近一场刚下播、danmakus 还没收录，会量到
> `弹幕行 [] / 词云格 0` 并显示「第三方收录中」占位 —— 此时它**什么都没验证**却仍然退出 0。
> 要确认词云/弹幕实渲染，先用 `--vtuber <id>` 选一个近期有收录的 V，或等收录后再跑。
>
> **`--hero-expect`（位级回归护栏）**：cards 视图的平台药丸（数量 / 每集切分 / 逐枚
> `索引:色系:展示数值` 顺序）哈希后比对。加它的原因很具体：2026-09-13 的 P2 批次把
> `orderAccounts`（拖拽排序）/ `chunkBy`（每 3 枚切集）/ `accountHomeUrl`（主页兜底）
> 搬出了 `PostsPage`，而**布局不变量对「药丸少一排 / 顺序变了 / 切集错了」完全无感**
> —— 那正是"搬坏了但探针全绿"的形态。改这三段逻辑前后各跑一次比对即可（见 devlog/056）。
>
> **`--calendar-expect`（位级回归护栏）**：日历 42 格 `day|badge|body` 的 sha256，
> 覆盖「**取数 → 分类 → 渲染**」这条链路 —— 拆 `useLiveSessions`（A-2）时布局不变量
> **完全覆盖不到**它（搬坏了表现为"某些天没内容了 / 月份错位"，不是元素出窗）。
> 见 devlog/057。
> ⚠️ 两个签名都**受真实数据变化影响**（粉丝数、新场次入库、danmakus 收录延迟、分类校正），
> 只适合**「重构前后立刻各跑一次」的短窗口比对**，不要当长期稳定基线。

`--first-run` 额外断言：空数据目录下 `?firstRun=1` 必须**自动弹出登录浮窗**，
且浮窗内含「凭据仅保存在本机」说明。

> ⚠️ `--first-run` 走**独立契约**（探针用 `?probe=first-run`，只断言浮窗，不做布局断言）：
> 空数据目录下页面落在 `/`、**本来就没有视图光条**，若照常走四视图量测会被判「量到空置页 +
> 缺八段」三条失败 —— 那是 2026-09-11 第一轮加固引入的**必然假失败**（该命令曾恒退出 1），
> 第二轮修掉。

⚠️ 需要完整权限（Vite 的 esbuild 与无头浏览器在受限沙箱会失败）；失败时保留
`_ui_probe_tmp/`（含 DOM dump 与截图用的 profile 目录）供定位。`--shot` 存图
（`_ui_probe_tmp/shot-<宽>.png`，筛选弹窗打开态）时同样保留该目录——**不参与断言，
纯视觉存档**：布局不变量只管「在不在框里」，配色/密度这类还得看图。

## 二·六、第三方数据「抓不下来」的定性（`scripts/check_danmaku_fetch.py`）

上游（danmakus）会**间歇性变慢**：同一场次同一份代码实测在 **1.1s ↔ 15.6s** 之间摆
（2026-09-13，devlog/062）。所以「最近的数据都抓不到」这类报障，先分清是
**超时 / 断供 / 真没弹幕**，不要直接当成数据问题：

```powershell
$env:DDTOOLKIT_DATA_DIR = "$env:APPDATA\com.ddtoolkit.app-dev"   # 必设：否则读项目根的裸跑残留库
python scripts/check_danmaku_fetch.py          # 最近 6 个 danmakus 场次：词云状态 + 事件数 + 耗时
python scripts/check_danmaku_fetch.py 10 --self  # 顺带跑自建路径（v3 原始弹幕 + 分词，很慢）
```

**只读**（sqlite `mode=ro`，不写库不删数据）；全绿退出 0、有失败退出 1，可当探针。
库路径跟随 `DDTOOLKIT_DATA_DIR`（不硬编码机器路径），未设该变量时会告警指明用的是哪个库。

### 看日志（2026-09-13 起按天轮转，devlog/077）

```powershell
$log = "$env:APPDATA\com.ddtoolkit.app-dev\logs"
Get-ChildItem $log                                  # app.log（今天）+ app.log.YYYY-MM-DD（最近 7 天）
Get-Content "$log\app.log" -Encoding UTF8 | Select-String -Pattern '\[(ERROR|CRITICAL)\]'
```

⚠️ 两份日志不要混：`app.log` 是**后端**（`app/core/logging_setup.py` 配置，双通道 + 按天轮转），
`sidecar.log` 是**Tauri 启动器**（就绪信号 / 性能打点 / 父进程看门狗）。
排查报障时**先按天切一刀**再读 —— 轮转前的老文件跨了几个月，八月的旧记录容易被当成现行问题
（devlog/076 的教训）。`app.log` 里的 `httpx` 行占大头（每个请求一行），按 `[ERROR]` 过滤最省事。

## 三、手动复现打包版状态（脚本没覆盖时）

```powershell
# ① 全新数据目录跑后端（验首启迁移 / 登录 / 抓取）
$env:DDTOOLKIT_DATA_DIR = "E:\tmp\dd-fresh"
$env:DDTOOLKIT_PORT = "8131"
python backend_main.py

# ② 验冻结运行时（PyInstaller 相关，如 alembic 资源缺失）
python scripts/build_backend.py
$env:DDTOOLKIT_DATA_DIR = "E:\tmp\dd-fresh2"; $env:DDTOOLKIT_PORT = "8132"
frontend\src-tauri\binaries\backend\ddtoolkit-backend.exe

# ③ 验前端（对着上面的后端跑 dev server，浏览器打开即可）
cd frontend; $env:VITE_API_BASE = "http://127.0.0.1:8131"; npm run dev

# ④ 免安装包验证「打包后的应用」（后端热替换：便携版直接换 binaries\backend）
python scripts/build_backend.py
python scripts/collect_release.py --portable-only     # 重打 dist-release\DDtoolkit-portable-win64.zip
```

## 四、什么时候必须整包重建

- `frontend/src-tauri/src/*.rs`（Rust 壳）、`tauri.conf.json`（窗口/资源/CSP）；
- 需要确认**安装包布局**（如本次 `_internal` 事故）——只有 `npm run tauri:build`
  产出的 `installer.nsi` / setup.exe 能反映；
- 发布前（`docs/RELEASE.md` §3 的三步 + §3 的产物校验）。

## 五、新增回归用例的约定

修 bug 时**先补用例**（`tests/test_auth.py` 等），命名里带现场信息，注释写清「用户看到什么 /
根因是什么」，例：

```python
def test_bili_poll_reads_inner_data_code():
    """回归（2026-09-08 实机）：扫码状态在 data.code，外层 code 恒为 0。..."""
```

这样下次同类问题在 `pytest` 里 6 秒就能拦住，不必等出包。
