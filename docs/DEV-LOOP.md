# 开发态快速验证（DEV-LOOP）——不打包也能验证改动

> 起因（2026-09-08）：连续两个 bug（NSIS 资源打平、扫码轮询读错字段）都只能靠 `npm run release`（PyInstaller + cargo + NSIS，4–6 分钟）出包后人工试出来 —— 而**绝大多数改动都不需要整包重建**，把「要验的状态」搬到能秒级复现的环境里即可。

## 零、流程预算与准入（2026-09-25 定）——**开工前读这一节就够**

**唯一判据：一个流程动作值不值，只看它有没有缩短「改错 → 发现」的时间。**

（判据/探针 → 缩短 ✅；反向验证 → 缩短 ✅；**开工前通读规范、写叙述性长文 → 不缩短 ❌**。）

### 0.1 每批的预算

| 允许 | 不许 |
|---|---|
| **会红的判据**（探针 / 测试）—— 必需 | 叙述性长文（那是 devlog 的体裁，不是规范的） |
| **活文档**：改了才同步，**1–2 行 + 指针** | **复述真源**（改一次要同步 N 处，见 0.4） |
| **devlog：每需求 1 篇、≤40 行**；字母级微调（`-E2`/`-F`）**并进现有篇** | 同一需求的每个字母各开一篇 |
| **机器判据优先**（能写成断言就别写成散文） | **流程新规默认不加** |

### 0.2 新规矩的准入门槛

**同类事故 ≥2 次**才升级成"规矩"（进本文件 / skill）；**只发生一次的写进 devlog 即可**。
判据一句话：**这条经验三个月后还成立吗？** 成立 → 提炼；只对本批次成立 → 留 devlog。

### 0.3 文档也要能退役

仓库已有"**判据**退役"的纪律（前提消失就删），这条补上"**文档**退役"：

- **前提消失**的规矩 → 删（已删过的例子：「导航标题 == 卡片标题」对账、§七 的已落地条目）；
- **从立起来就没红过**的规矩 → 每几批审一次，删；
- **能从真源重建**的段落 → 压成指针。

### 0.4 复述 = 负债（能引用就别复述）

实测（2026-09-25）：同一条规则的复述面 **37 处 / 14 份文件**，单条搜索词覆盖率最高 49%。
**而且已经出过真事故**：skill 里写「`MIGRATION_HEAD` 当前值 `f004`（17 个版本）」，
真值 **`f007` / 20** —— 门禁正则匹配不到那种写法 ⇒ `doc_check` 一直报"数字一致 ✓"，
一份**错误事实**挂在"开工前必读"里，没人发现。

⇒ **规范只有两个合法落点：真源（代码 / 测试 / 脚本）与指针。**

### 0.5 成本纪律（2026-09-25 实测，读数：`python scripts/usage.py`）

```
花费 ≈ 步数 × 每步上下文 × 缓存单价 ＋ 输出 × 输出单价
```

实测一个"改 1 行 CSS"的批次：**101 步 × 148k 上下文 = 15.05M token ≈ 0.51 元**（空闲时段）。
四条推论：

1. **成本与需求大小几乎无关** ⇒ 小需求也按批收尾（别攒着一起做）；
2. **99.4% 的量是缓存命中**（单价是未命中的 1/50）⇒ 别把 `totalTokens` 当"新输入"看；
3. 触发收尾的信号是**上下文体量**（>200k 就该收），**不是"轮次"**；
4. 该丢的是**工作台**（一次性读进来的原文、长门禁输出），**不该丢的是需求知识** ——
   后者压成一份稳定档案（稳定 = 缓存命中 = 几乎免费）。实测对照：**724k/步** 的轮
   vs **147k/步** 的轮 —— 后者步数是前者的 2 倍，成本只有它的 **41%**。

### 0.6 门禁分档（机器：`python scripts/gate.py`）

| 档 | 触发 | 实测 |
|---|---|---|
| **C** 局部/表现 | 样式值 / 探针 / 文档 / devlog | **46s** |
| **B** 跨层/特性 | `frontend/src/**`（除 `styles/`·`dev/`）· `package.json` · `UI-MAP` | ~70s |
| **A** 数据/契约 | `app/` · `alembic/` · `tests/` · `backend_main.py` · **`frontend/src-tauri/**`** · **`pyproject.toml` / `uv.lock`** · 三个有 pytest 护栏的脚本 | ~250s + cargo |
| `--tier full` | 发版前 / 拿不准 | ~250s（含 pytest 与后端冒烟） |

⚠️ **探针永远跑满三档**：实测单档 28.3s、三档 26.6s —— 成本全在启动，少跑档只损失覆盖面。
⚠️ **读门禁结果别把 stderr 灌进 PowerShell 管道**（`python scripts/gate.py 2>&1 | ...`）：cargo 的链接器警告
走 stderr，PowerShell 会把它包成 ErrorRecord ⇒ **每步都 ok 也叫 `exit code 1`**（2026-09-25 实测）。
判据是脚本自己那行 `=== 汇总 ===` / `全部通过`，**不是 shell 退出码**；不重定向就不会有这个问题
（这与 `gate.py` 内部那条"`shell=True` 时别拿 `run()` 的返回值当整数、否则成功也判 FAIL"是同一类错的两次现身）。
⚠️ **档位映射本身会写错** ⇒ `--plan` 会打印"哪条路径把档位顶上去的"，收尾用 `full` 兜一次。
⚠️ **档位映射漏一格 = 那个文件从此没人守**（2026-09-25 已抓到两次：`scripts/doc_check.py` 与
`frontend/src-tauri/**`——后者意味着改**删除数据目录**那条 Rust 命令时 `cargo test` 一次都不跑）。
现在这份映射被 `tests/test_gate.py` 的用例钉住，改它要同时过那些断言。

⚠️ **Rust 档只在 A 档跑**（`cargo test` 首次含编译，分钟级；增量秒级）——它**不能**像探针那样
无脑跑满三档：探针是"启动成本固定"，cargo 是"编译成本真实存在"，两者是不同性质的代价。

### 0.6.1 CI 跑什么、本地跑什么（2026-09-25 起）

**真源 = `.github/workflows/`**（两个文件：`ci.yml` 跨平台腿 / `ci-windows.yml` Windows 腿）。
这里只记「为什么是这么分的」，命令本身不复述 —— 复述一份就多一个漂移点。

分腿的唯一理由：**`src-tauri` 编译不了非 Windows**（`windows-sys` + DWM / Job Object /
`ShellExecuteW`），所以 Rust 腿固定在 Windows，Linux 腿只做与平台无关的那些。

三条本地看不出来、只有 CI 会告诉你的：

1. **`uv sync --frozen --no-group build` 在 3.12 上也能过** —— 本地只有 3.14 一套环境，
   `requires-python` 的下界从来没被真正验证过。
2. **干净 clone 上 `cargo test` 需要 `binaries/backend/` 里有文件**（2026-09-25 实测）：
   `tauri.conf.json` 的资源 glob 是 `binaries/backend/**/*`，而该目录由 PyInstaller 生成且被
   gitignore ⇒ glob 匹配不到任何文件时 `tauri-build` 直接让 build.rs 失败。CI 里造一个占位文件
   即可（**不用**真跑 PyInstaller、**也不用**前端 `dist/`）。`gen/` 不需要入库，build.rs 会自己重建。
3. **注释里的命令会让文本型断言假绿** —— 见 `tests/test_gate.py` 的 `_run_commands`：
   那组 CI 断言只认 `run:` 里真正会执行的命令（第一版在全文里找 `uv sync` / `cargo test`，
   而两个 workflow 的注释里恰好都写着它们 ⇒ 把命令删掉、注释留着，断言照样绿）。

⚠️ **CI 里跑不了的**（写在这里是为了不让人以为有覆盖）：`scripts/ui_probe.py`（要真浏览器与视口）、
托盘隐藏/唤回/深休眠、数据目录迁移与删旧目录、更新器安装 —— 都是 OS 级交互，入口是本文 §一/§四
与 `docs/TODO.md` §1.3 的真机清单。

### 0.7 反向验证要挑「真的能破坏它的改法」

改不动就用更极端的手段（显式尺寸 / 负偏移 / 直接改被测元素），**直到它红 ——
红不了就说明那条断言是装饰**，删掉或改写。实例：R45-F 的"标题不出面板"用
`max-width: none` **改不动**（绝对定位是 shrink-to-fit，本来就出不去），
得用 `width: 200%` 才红。

> ⚠️ **变异必须保证能终止**（2026-09-27 加，devlog/238）：把"循环推进"本身改掉时
> （例：游标没带回去 ⇒ 每轮都重抓第一页），被测代码会**不推进**，
> 于是反向验证脚本自己挂死。那次实测的后果有两条，都要防：
> ① 脚本被超时杀掉 ⇒ **`finally` 里的逐字节恢复没跑到**，工作区里留着一个变异版本
>    （下次跑门禁会以"莫名其妙的行为"出现）；② 白等十分钟。
> 两条防线：**给 subprocess 加 `timeout=`**（超时当作"红"，但要打印出来），
> 以及**给测试替身加硬闸**（"同一个游标最多服务 N 次之后就返回空页"）——
> 让"不推进"变成一条失败的断言，而不是死循环。

> ⚠️ **"没发生 X"这类断言必须配正对照**（2026-09-27 加，devlog/239）：反向验证时，
> 「熔断后不再发请求」那条判据把补丁**打在错函数名上**（`fake_videos` vs 实际走的
> `fetch_bilibili_dynamics`）⇒ 计数恒为 0，断言**永远成立**、变异后照样绿。
> 修法不是改断言，而是**先断言一次"没熔断时确实会打一发"**（正对照）：
> 它同时锁住"补丁打对了函数"和"这条路径真的会走到那儿"。
> 同类断言（"没有调用 / 没有日志 / 没有落库"）都要问一句：**凭什么相信它本来会调用？**

## 一、先分清「要验的是什么」

打包版会坏通常不是「打包」本身，而是打包版才有的状态：

| 打包版独有的状态 | 开发态默认没有 | 怎么在开发态复现 |
|---|---|---|
| 全新数据目录（无 `.env` / 空库） | 项目根 `.env` + 老库 | `DDTOOLKIT_DATA_DIR=<空目录>` |
| 冻结运行时（PyInstaller `_internal`） | 源码直跑 | `python scripts/build_backend.py` 后直接跑 exe |
| Tauri 资源映射（installer 布局） | 无 | **只有它需要整包重建**（改 `tauri.conf.json` 时） |
| 前端产物（`dist/` 打包进 exe） | Vite dev server | `npm run dev` + `VITE_API_BASE` 指到后端 + **两处 dev token**（不设 ⇒ 每个业务请求 401，页面表现是"数据全空"⇒ 像布局坏了；取值口径见 `docs/ARCHITECTURE.md` §6 第 26 条） |

**结论**：后端逻辑 / 登录 / 首启 / 迁移类改动 → 秒级或 1 分钟级就能验完；只有动到 Rust（`src-tauri/src`）、`tauri.conf.json`、或需要真机确认前端产物时才整包重建。

### 真机现场：**升级失败 / 迁移失败**（批次 16，devlog/207）

这两条**只能真机走**（CI 与探针都碰不到"库坏掉"这条路），造法各一条命令：

```powershell
# ① 迁移失败 ⇒ 必须"能起来 + 提示可找回 + 备份在位"
#    先把库改成"迁移链上但版本落后"，再让迁移炸掉（把 alembic_version 指到一个不存在的版本）
$d = "$env:APPDATA\com.ddtoolkit.app-dev"          # 或 DDTOOLKIT_DATA_DIR 指定的目录
python -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE alembic_version SET version_num='zzzz'\"); c.commit()" "$d\vtuber.db"
#    起后端（或直接起应用）：期望 —— 应用照常起来、横幅说"上次升级没有完成（数据没有丢）"、
#    $d\vtuber.db.failed-<时间戳> 存在、$d\backups\ 里有迁移前那一版的备份、/healthz 的
#    migration.status == 'failed'。判据：**不是"日志里有异常"，而是"用户能自己找回"**。

# ② 迁移中途失败 ⇒ 指针与旧目录未动
#    ⚠️ 2026-09-27 起**四条失败路径已有集成测试**（`migrate::tests::orchestrate`，devlog/225）：
#       替身注入「复制失败 / 校验失败 / 指针写失败 / 探活失败」⇒ 断言“指针未变 + 旧目录内容未动
#       + 后端仍被拉回旧目录”。真机这一趟仍然值得走（验的是**真进程与真对话框**），
#       但它现在是"复验"而不是"唯一判据"。
#    在设置里点「迁移数据目录」，选一个**只读**的目标目录（或者复制到一半拔掉移动盘）
#    期望：提示失败原因、数据目录来源没变、旧目录内容与时间戳没变、后端仍在旧目录上跑。
```

⚠️ **别拿真档案试**：先 `Copy-Item $d "$env:TEMP\dd-backup" -Recurse`（或者直接把 `DDTOOLKIT_DATA_DIR` 指到一份副本上再玩）。

### 关停（优雅停止）：**已有真进程冒烟**（批次 6 的补充，devlog/226）

```powershell
python scripts/shutdown_smoke.py   # 起真后端 → 发 CTRL_BREAK → 断言 ≤15s 退出、码 0、日志命中
```

它顶掉的是原来那句"只能真机看 `app.log`"。⚠️ **但它验的是"后端被礼貌叫停时会不会优雅收摊"**，
而**打包版今天根本不走这条路**：关窗/托盘退出是 Job Object / `taskkill /F`，壳被杀是后端看门狗
`os._exit(0)`，迁移是 `child.kill()` —— **三条都是硬杀**。要让真机也优雅停止，得先给壳加礼貌
通道（`POST /shutdown` 或 CTRL_BREAK 到子进程组），**这是待拍板项**（TODO §1.1，devlog/226 §五）。

### 哪些"看着像真机"的其实机器能验（批次 15，devlog/215）

文件 SQLite 的并发面（WAL 读写并行、`busy_timeout` 排队、多 session 竞争写、T0 ∥ 帖子写入、
checkpoint + 重开、`dispose()` 之后文件才改得动名）**已经全部有真库用例**：
`tests/test_sqlite_concurrency.py`（**不得用内存库宣称验证 WAL** —— 内存库连"两个连接看见
同一份数据"都不成立）。别再把它当成"只能真机看"的事。

**仍然只能真机/人工的**（`ui_probe` 跑在无头 Edge 里，没有 Tauri 窗口、没有托盘）：
托盘隐藏 / 唤回 / **深休眠**、托盘菜单与退出、主窗 ✕ 与最小化、小窗拖拽手感、
更新器的失败分类、以及上面那两个迁移现场。清单与逐条期望见 `docs/TODO.md` §1.3。

## 二、一条命令的快速自检

```powershell
python scripts/dev_check.py             # 语法扫描 + 单测 + 开发态后端冒烟（约 20 秒）
python scripts/dev_check.py --frozen    # 追加：冻结后端 exe 冒烟（需先 build_backend，约 1 分钟）
python scripts/dev_check.py --portable  # 追加：重打便携 zip（免 cargo/NSIS，约 2 分钟）
python scripts/dev_check.py --full      # = --frozen --portable --docs --upstream
```
它做三件事（真源：`scripts/dev_check.py` 头部注释）：① **全仓 Python 语法扫描**（`ast.parse`）—— 没有任何其它门禁会编译 `scripts/`，所以工具脚本的语法错误会**静默绕过全部红灯**（devlog/131 一次性事故，这一步就是为它加的）；② `pytest tests/` 回归网 —— **基线数字只在 `docs/TODO.md` §6.2 维护**，别处一律不复述；③ **空数据目录**起后端（源码或冻结 exe）→ 验 `/healthz` + 扫码状态机（`qr/start` → 连续 `qr/check` 必须停在 `waiting`，防「读错 code 字段」回归）。前端三条（`npm run lint`（eslint，`--max-warnings 0`）/ `npm run test`（vitest）/ `npm run check:dates`）已并入其中的 `frontend logic` 一项；缺 `frontend/node_modules` 时显式打印 `[skip]` 而非静默通过。失败时会把现场数据目录打印出来（`console.log` / `logs/sidecar.log`）便于定位。

### 桌面端图标（LOGO 变更后重生成）
`python scripts/make_icons.py`（从 `docs/design/png/NGNlogo无底.png` 生成）→ `frontend/src-tauri/icons/` 全套（多尺寸 `icon.ico`、`icon.png`、Windows 商店 `Square*Logo.png`、`icon.icns`）。改 LOGO 后跑一次即可。

## 二·五、布局类改动的机器验证（`scripts/ui_probe.py`）

布局问题（原生滚动条、内容出窗、出现滚动条导致宽度跳动）肉眼难复现、打包才暴露；2026-09-08 起固化为可复跑的探针。**模式表就是真源**：`python scripts/ui_probe.py --help`（每个 flag 的用途、断言项、前置条件都写在 help 串里）。常用起手：
```powershell
python scripts/ui_probe.py                            # 1100 / 1280 / 1440 三档宽度
python scripts/ui_probe.py --width 1100 --height 680  # 指定宽度 / 矮窗（验弹窗高度兜底路径）
python scripts/ui_probe.py --archive --archive-print --vtuber 15  # 取「日历格内文本」基线
python scripts/ui_probe.py --hero-print --vtuber 15   # 建基线；重构后带 --hero-expect <sha256> 比对
python scripts/ui_probe.py --status-island            # 顶栏状态岛（R12a，devlog/089、090）
python scripts/ui_probe.py --status-widget            # 小窗独立入口 widget.html —— §6.1 / §6.5 / §6.8 的判据命令（devlog/185、187、188）
python scripts/ui_probe.py --cell-pop                 # 日历格 hover 悬浮窗 —— §6.9 / §6.11 的判据命令（devlog/186、188）
python scripts/ui_probe.py --vtuber 15 --messages     # 推送通道端到端（M0b，devlog/242）—— 三档主流程也跑它，这条是单跑定位用
```
⚠️ 需要完整权限（Vite 的 esbuild 与无头浏览器在受限沙箱会失败）；失败时保留 `_ui_probe_tmp/`（DOM dump + 截图 profile）供定位。`--shot*` 系列**只截图、不参与断言** —— 布局不变量只管「在不在框里」，配色/密度这类还得看图。
它自动：复制开发数据目录 → 起后端 → 起 Vite → 无头浏览器加载 `/vtubers/<id>?probe=1`（`frontend/src/dev/probe.ts` 依次切四个视图、在列表页跑一遍筛选弹窗全链路（开 → 预设 → 确认 → 重置 → Esc）、再点一次「投稿」筛选，共八段测量），断言八组不变量（**每条断言的"为什么"都写在 `ui_probe.py` / `probe.ts` 的对应注释里**）：

| 不变量 | 含义 |
|---|---|
| **探针完整性** | **「跑通了」必须等于「量到了」**：量测段数须等于契约序列（`EXPECTED_TAGS`，八段）· 不得量到空置页（`empty`）· 页面自报的 `degraded`（视图钮点不中 / 投稿 chip 缺失 / 无视图光条）一律判失败。反例：`_first_vtuber` 一失败路由就落到 `/`，探针只 emit 一段 `empty`、**所有卡片与筛选断言静默空转，脚本照旧打印 `[ok]` 退出 0**（2026-09-11 静态审计点出的假通过路径） |
| `scrollbarPx == [0,0]` | 文档层永不出现滚动条（窗口级滚动条 = 内容宽度跳 12px 的根源） |
| 无可见出窗 / 无容器横向溢出 / 无原生滚动条 | 没有元素越过窗口左右缘（被 `overflow:hidden` 裁掉的折叠组不算）· `overflow-x:auto/scroll` 容器不得 `scrollWidth > clientWidth`（白名单 `.type-chips` 有意横滚）· 滚动容器统一 OverlayScroll |
| 列表卡片列宽契约 | `.list-inner` ≤ 900px · 卡片铺满该列且等宽 · 封面恒 220 且不被左缘裁切（2026-09-08 事故固化：OverlayScroll 插层让 `.list-scroll > .list-inner` 静默失效，列宽随内容在 566～1350px 之间乱跳）。**列宽量测已与「列表里有没有帖子」解耦**（`measure().contract` 常驻）—— 旧写法把守卫写在 `cards` 非空分支里，列表一空断言就失效 |
| 筛选弹窗不出右栏 + 交互链 | `.post-filter-pop` 完整落在 `.posts-panel` 可视区内（该容器 `overflow:hidden`，越界＝静默裁掉）、可见月份面板 = 2 且各 42 格、预设 = 6 · 草稿态不改触发器（`筛选`）→ 预设高亮 → 「确认」关窗且触发器变 `筛选 · 1` → `重置`+Esc 回 `筛选` |
| 顶栏展示策略 | 采样当时若**只有自动节拍在跑** → 顶栏必须是空闲态（不亮容器、文案不是任务进度）。⚠️ **外部第三方数据任务在跑时跳过**（顶栏按设计要显示 `正在同步…`，`busy = … || external.running`）—— 旧口径只看 post/account，于是三档宽度一起报"只有自动节拍在跑却亮起了事件容器"（**假失败**，devlog/083） |

> **量不到 ≠ 通过**：`max-width`/`coverW`/`confirmDisabled` 等取值一旦为 `null`（选择器踩空）都直接判失败，不再静默放过 —— 「断言被 null 中和」与「断言通过」在报告里必须区分得开；全部失败条目都会打印（旧版只印前 8 条，后面的被吞）。
> **`--hero-expect` / `--calendar-expect`（位级回归护栏）**：前者哈希 cards 视图的平台药丸（数量 / 每集切分 / 逐枚顺序），后者哈希日历 42 格 `day|badge|body` —— 它们覆盖「**取数 → 分类 → 渲染**」这条链路，而**布局不变量对「药丸少一排 / 某些天没内容了 / 月份错位」完全无感**（那正是"搬坏了但探针全绿"的形态，devlog/056、057）。⚠️ 两个签名都**受真实数据变化影响**（粉丝数、新场次入库、danmakus 收录延迟、分类校正），只适合**「重构前后立刻各跑一次」的短窗口比对**，不要当长期稳定基线；`--calendar-expect` **跨天必然失败**（无场次的格子按 `key < todayKey` 显示「休息」否则「待定」，`LiveCalendar.tsx`），跨天只能先 `--archive-print` 取当天值再比对。
> **纯逻辑（无浏览器）**：日期区间算术（预设量纲 / 月位移夹取 / 本地解析 / 6×7 网格）在 `frontend/src/utils/dateRange.ts`，`node scripts/check_date_range.mjs` 直跑（30 条断言）。
> ⚠️ `--archive` 固定点「**最近一场**」：若最近一场刚下播、danmakus 还没收录，会量到 `弹幕行 [] / 词云格 0` 并显示「第三方收录中」占位 —— 此时它**什么都没验证**却仍然退出 0；要确认词云/弹幕实渲染，用 `--archive-day` / `--vtuber` 挑一个近期有收录的 V（内容缺失类问题靠它定位，devlog/052）。
> ⚠️ `--first-run` 走**独立契约**（探针用 `?probe=first-run`，只断言登录浮窗、不做布局断言）：空数据目录下页面落在 `/`、**本来就没有视图光条**，若照常走四视图量测会被判「量到空置页 + 缺八段」三条失败 —— 那是 2026-09-11 第一轮加固引入的**必然假失败**（该命令曾恒退出 1）。
⚠️ **虚拟时间的三条硬事实**（探针所有动画/几何断言都建在它上面，devlog/147、150、151）：① **CSS 过渡不推进** —— `getAnimations()` 里过渡是 `running` 但 `currentTime` 恒为 0，`getComputedStyle().transform` 永远停在**过渡起点**，所以动画类断言只能判「我们**提交了什么**」（读 `element.style.transform` 内联值）与「过渡**有没有登记**」（读 `transition-duration`）；想看动画真怎么走用调测页 0.25× 慢放，别指望 computed。② **rAF 几乎不被服务**（实测 400ms 里只被叫 **0–1 次**）⇒ 自动滚动的循环是 **rAF + 定时器双驱动**（真机靠 rAF 跟帧率、探针靠定时器可观测，两者共用一个 8ms 闸门防两倍速）。③ **图片加载永远完不成** ⇒ 图片类断言读**为可测性挂上的属性**（**别当冗余删掉**）：`.vtuber-item[data-src]` / `.hero[data-avatar-src]` 是**解析出来的源 URL**（口径），`ProxyImage` 输出节点上的 `data-render-src` 是**首帧决定用的 src**（接线，回落到占位也还在）。
> ⚠️ **R46（devlog/249）补充：别只比"解析出来的 URL"**。radix `AvatarImage` 只在**加载成功**后才挂 `<img>`（虚拟时间下永远不挂）⇒ 左栏头像长期只能读 `data-src`；而 `data-src` 相同**不代表渲染相同** —— 微博图床那张，右栏 hero 走 `/img-proxy` 拿得到、左栏裸 `<img>` 直连被 403 打成灰底首字，出事时**两边的 `data-src` 一模一样**。R46 把左栏也换成 `ProxyImage`（img 立即挂载、决策挂 `data-render-src`）之后，`--profile-sync` 才能比出这条差异。**推论：一条判据只比"数据"不比"渲染"时，先问一句"这两个渲染点是不是同一段代码"**。
⇒ 推论：**量"有没有生效"就掐掉动画/过渡，量"动画对不对"才让它开着**。量 chevron 之前**必须先注入 `transition:none !important`**（且读过渡时长要在注入之前），否则虚拟时间会把 `transition: transform .2s` 冻在中途、读到的是**过渡进度**而不是"规则有没有生效" —— 2026-09-15 因此得到过一条**时绿时红**的判据（同一天两次跑，一次 `matrix(-1,…)`、一次 `matrix(1,…)`）。
⚠️ **判据本身会错，且错法很难看**：① **先怀疑判据，再怀疑被测对象** —— radix 的 `Presence` 会把关闭后的内容留着播退场动画，虚拟时间下动画不跑完 ⇒ **节点永远在**；曾因此得出错误结论「radix 的 Esc 在本应用里不生效」（还照此自挂了一条 Esc 监听，复测后确认多余、已删）。判「弹窗关没关」**必须看 `data-state`**，不能看节点在不在。② **采集要每次重查节点** —— 切页 = 卸载重挂，早先抓到的 `input` 是游离节点，写它不触发 React `onChange`（表现成"保存了但服务端没变"）；`--scene` 同理（devlog/071 记的"永久停在 scene-exit"就是拿了点击前的旧节点，真相反转记在 devlog/080）。③ **文案匹配别写死** —— 按钮从「全部恢复默认」改成「恢复全部默认」，正则 `/恢复默认/` 就再也匹配不到（判据把测试坑了）；改成 `/恢复.*默认/` 并把按钮文案打进结果（`resetBtnLabel`），下次改名一眼能看出来。
⚠️ **`:hover` 在 `--dump-dom` 里无法模拟** —— `.stat-sets` 上挂了 React 维护的 `data-hover`，探针派发 `pointerover`/`pointerout` 翻转它；**这个属性就是为可测性存在的，别当冗余删掉**。
⚠️ **探针打印里的排版字符**（`✕` U+2715、`−` U+2212 等）**不在 GBK 码表里** —— Windows 控制台是 cp936 时，一句 `print` 就抛 `UnicodeEncodeError` 把整条探针从中间打断（症状很误导：**退出码 1 但一条失败行都没有**）；2026-09-16 踩到后已在启动时把 stdout 的编码错误降级成 `?`，脚本里新增文案尽量用 ASCII 的 `-`。
⚠️ **探针自己造现场，别靠数据碰运气**（开发库未必有未来预约 / 置顶帖 / 多账号）：`--reservations` / `--pinned` / `--seed-accounts N` 都往**数据目录副本**种数据。`--pinned` 必须跑在**未登录副本**上 —— 第一次实现跑在有凭据的副本上，后端起来就抓动态流，而 R35 的置顶集合同步会把种下的假置顶帖当场撤销 ⇒ 断言时绿时红；牙口在**时间戳**（种 2020 年的置顶帖，排序一旦失效必掉到列表末尾）。`--reservations` 的 `desc1` 用**完整日期**而不是"明天 HH:mm"（后者按帖子发布日推断，与运行时刻耦合，devlog/088、139）。
⚠️ **合成 `pointermove` 必须派发在网格上**（监听挂在 `.board-grid`，派发到祖先不会向下冒泡）；两段手势之间要**等保存落地**（`busy` 期间 `beginDrag` 不接新手势）。
⚠️ **采样必须按真实输入节奏连续**：`--motion-trace` 存在的理由就是抽两点采样会**假绿** —— 第一版只量"同格 +30"与"跨一格"，恰好一个不跨格、一个跨格、两点都对，而真实输入的每一步都在错（误差 212.5px）。手感类断言一律**连续采样 + 把误差写成数字**。
⚠️ **会写盘的探针（`--app-settings`，R14a/R17，devlog/091、094）跑在数据目录副本上，绝不碰开发库**；保存后的对账**不看界面回显**，而是在页面里**再打一次 `GET /settings`** —— 回显可以来自本地草稿，"存了没生效"照样能让回显正确。越界值断言「保存钮禁用 + 红字」（前端那道），后端的 400 由 `tests/test_runtime_settings.py` 钉；主题（R14b）也在这条里（切「跟随系统」→ **再问一次后端**确认偏好落库 → 断言 `html[data-theme]`，本机默认浅色系统，验深色支要额外给 Edge 加 `--force-dark-mode`）；`--shot` 的 `&keepOpen=1` 让探针跳过收尾的 Esc，能截到"弹窗开着"的图做视觉存档。
⚠️ **托盘 / 窗口这类 OS 级能力无头浏览器测不到**，但"隐藏之后该发生什么"可以断言 —— 开发构建里有 dev 钩子 `window.__ddtoolkitSetShellHidden(true/false)` 与 `__ddtoolkitCloseClick()`（`import.meta.env.DEV` 下才有）。**第一段是灵魂**：可见时必须先证明轮询在跑（基线），否则"隐藏后没请求"这件事，一个彻底卡死的应用也能满足。两个真 bug：① **停表判据要读同步源** `isShellHidden()`（React 状态要等下一次渲染才落地，定时器可能恰好落在那道缝里）；② **"排程时判"不够，触发时还要判一次**（隐藏前排下的 10s 轮询隐藏后照样到点触发 —— 实测漏网时刻 `22063`，而它是 `12053` 那次轮询结束时排的）。深休眠（10 分钟，调试可用 `DDTOOLKIT_TRAY_SLEEP_SECONDS=20`）与托盘菜单只能人工验；R20 起托盘退出**两种现场各验一次**：没任务应**直接退出** / 有任务应**唤回窗口 + 弹确认框**（原先只发事件等前端确认，深休眠时没人接 ⇒ 根本退不出去，devlog/095、097、129）。
⚠️ `--add-v` 的牙口是「敲键只打本地 `/vtuber/pool/search`，`/vtuber/bili/search` **必须 0 次**」—— 改回"输入即搜"时界面看不出异常，但**风控预算会被无声烧掉**（这条决策的机器判据，devlog/083）。探针**不点结果行、不点「搜索 B 站」**（前者是真收录+真抓取，后者是真上游调用），关键词也不猜（先问池搜索，没命中就打印 `[跳过] 行级断言`）。结果区必须是 `OverlayScroll`（`.av-list.os-root > .os-scroll`），原生滚动条会被判失败。
⚠️ **文字矩形要用 `Range` 框文案节点，不能量元素矩形**（`--filter-pill`，用户 2026-09-15 口径：「list 视图中的筛选按钮的样式跟随左栏工具栏中的筛选按钮」）—— 量元素矩形会把 caret 的宽度算进去，"文字到底居没居中"就量不出来（**R5/R15 两次误判的同源原因**）；文案节点可能裸着、也可能套在 `.pf-label` 里，探针两种都要认（devlog/093）。
⚠️ **`--settings` 加"可点性"断言的起因**（devlog/075）：几何全绿但用户**点不动** —— 面板 portal 到 body 继承了 radix 给 body 的 `pointer-events:none`。所以除几何外还要 `elementFromPoint` 命中测试与"点一行会怎样"；同宽看 `offsetWidth`（布局宽），不看视觉矩形。
⚠️ **`--status-island` 的空闲轮播当前是下线态**（用户口径 R19，devlog/096：「顶栏状态栏空置的时候轮播的语录集暂时下线，等之后库中真有了条目再上线」）：空闲文案必须恒为「数据服务运行中」、索引恒为 0、`data-idle-carousel === 'off'`，池内**不许出现进度词**（`轮询`/`抓取中`/`同步` —— 语录是长期驻留文案，写成进度词就破坏了「自动节拍不占顶栏」）。**上线时是两处一起改**：`IDLE_CAROUSEL_ENABLED = true` + 恢复"必须轮播/索引前进/文案不重复"那组断言（探针读的 `data-idle-carousel` 会对不上而报红，**故意的**，省得悄悄开了没人知道）。入场动画量的是 `getComputedStyle(panel).animationName` 与 `getAnimations()` —— **CSS 文件里写了不算数**；reduce 支用 `--force-prefers-reduced-motion` 跑一次，且 **reduce 下不许把状态指示一起减掉**（减的应该是位移与插值）。
⚠️ **只比窗高是假绿**（`--archive` 的 R36 段，devlog/140）：窗高在内容顶到 `max-height` 后**恒等** —— 反向验证实测把预留高度改成 0、窗高仍然相等；有牙口的是**内容高**（`.lc-dlg-body .os-scroll` 的 `scrollHeight`）。另：后端对上游有 **10 分钟缓存**，探针得自己把 `/upstream` 压后 2.5s 来**造**未到位态，否则第二次跑同一场次两格都采到位态（判据空转）。
⚠️ `--switch-perf` 耗时**只打印**（单次下限本来就是刻意退场 `useSceneTransition.EXIT_MS`，为了全程不出现「正在加载」闪帧），判失败的两条是「切换没落地」与「**连点重播了退场**」（连点该比单次**更快** —— 退场只播一次；devlog/132、133）。⚠️ **窗口层的问题探针看不见**（不是 DOM）—— 如「四角白边」只能人工取证（一次性手段，未进仓库）。

## 二·六、第三方数据「抓不下来」的定性 + 端到端上游冒烟

上游（danmakus）会**间歇性变慢**：同一场次同一份代码实测在 **1.1s ↔ 15.6s** 之间摆（devlog/062）。所以「最近的数据都抓不到」这类报障，先分清是**超时 / 断供 / 真没弹幕**，不要直接当成数据问题：
```powershell
$env:DDTOOLKIT_DATA_DIR = "$env:APPDATA\com.ddtoolkit.app-dev"   # 必设：否则读项目根的裸跑残留库
python scripts/check_danmaku_fetch.py          # 最近 6 个 danmakus 场次：词云状态 + 事件数 + 耗时
python scripts/check_danmaku_fetch.py 10 --self  # 顺带跑自建路径（v3 原始弹幕 + 分词，很慢）
```
**只读**（sqlite `mode=ro`，不写库不删数据）；全绿退出 0、有失败退出 1，可当探针。库路径跟随 `DDTOOLKIT_DATA_DIR`，未设该变量时会告警指明用的是哪个库。
有些链路**只在真环境里才暴露**：登录态、上游回包形态、池外收录（候选池与索引不一致）。这类问题过去靠"临时写脚本 + 用户实测"发现（2026-09-15 那批写了 5 个一次性脚本，其中 3 个抓到真问题 —— 但都被删了），现在固化成常驻护栏：
```powershell
python scripts/smoke_upstream.py              # 真上游（数据目录副本 + 真后端）：B 站检索 / uid 直查 / 候选池来源标注 / 池外收录 / 场次上游
python scripts/smoke_upstream.py --cold       # 冷进程：空数据目录 + 清空凭据，断言未登录时的降级形态
python scripts/smoke_upstream.py --capture    # 顺带把真实回包刷进 tests/fixtures/
python scripts/dev_check.py --upstream        # 接进一把梭（真上游 + 冷进程各一次）
```
判定口径：`[ok]` 真验到了 · `[skip]` **环境不成立没验到**（未登录 / 上游不可用，必须打印原因）· `[FAIL]` 链路真坏了。⚠️ 池外收录检查会在**副本**里真建一个 V（副本每次重建，不碰真库）；两条实测澄清（「空数据目录」≠「候选池为空」、凭据要**显式清空**才算冷）**已写进 `docs/ARCHITECTURE.md` §6.21**（2026-09-25 前在 `GLOSSARY.md` §8，该节已并入 §6），此处不复述。

### 看日志（2026-09-13 起按天轮转，devlog/077）
```powershell
$log = "$env:APPDATA\com.ddtoolkit.app-dev\logs"
Get-ChildItem $log                                   # app.log（今天）+ app.log.YYYY-MM-DD（最近 7 天）
Get-Content "$log\app.log" -Encoding UTF8 | Select-String -Pattern '\[(ERROR|CRITICAL)\]'
```
⚠️ 两份日志不要混：`app.log` 是**后端**（`app/core/logging_setup.py` 配置，双通道 + 按天轮转），`sidecar.log` 是 **Tauri 启动器**（就绪信号 / 性能打点 / 父进程看门狗）。排查报障时**先按天切一刀**再读 —— 轮转前的老文件跨了几个月，八月的旧记录容易被当成现行问题（devlog/076）。`app.log` 里的 `httpx` 行占大头，按 `[ERROR]` 过滤最省事。

## 二·七、文档漂移门禁（`scripts/doc_check.py`）

索引类文档最容易漏，而且**不会让任何测试红**：`ROADMAP-DONE.md` 的「批次 → devlog 索引」、`docs/README.md` 的 releases 列表（漏了新版本）、六处版本号。
```powershell
python scripts/doc_check.py            # 只读，有 FAIL 退出 1
python scripts/dev_check.py --docs     # 接进一把梭
```
**条目表就是真源**：`scripts/doc_check.py` 的 `CHECKS`（devlog 索引覆盖 / **文件名重号** / 六处版本号 / 发布说明与导航 / 文档数字与代码一致 / TODO 无已落地残留 / 规格现状断言可追溯）。`scripts/release.py` 的预检也会调它 —— 发布前先拦，别让"这版改了什么"日后查不到。

## 二·八、未登录能力边界（`scripts/capability_matrix.py` + `ui_probe --capabilities`）

用户口径：「未登录也尽可能用所有功能，并明确告知限制」。边界**必须实测**（devlog/086）：
```powershell
python scripts/capability_matrix.py                    # 两态 × 轻量接口，打印矩阵
python scripts/capability_matrix.py --include-content   # 额外量投稿/动态（**会触发 IP 级 412**，别勤跑）
python scripts/capability_matrix.py --write             # 刷新 tests/fixtures/capability_matrix.json
python scripts/ui_probe.py --capabilities               # 未登录现场的界面提示（数据副本删 .env）
```
结论（2026-09-15 实测）：匿名可用 = 本地归档 / 第三方历史 / **检索（名称搜、uid 直查）** / 粉丝数 / 直播状态；**内容抓取（投稿 + 动态）与微博必须登录**（匿名被 `412 request was banned`）。

> ⚠️ 两条纪律（都是踩出来的）：① **一个进程只发一条请求** —— 前一条的失败会波及后面，混在一个进程里量出来的矩阵是错的；② **匿名探测本身有代价**（会脏 IP，且**不连累登录态**，已实测），所以默认不量内容接口。冷态清凭据见 §二·六。
`--capabilities` 断言的是**两条相反**的错法：该说的没说（顶栏/说明窗/去登录缺失）与**过度限制**（受限功能被隐藏、或归档/账号信息被一起禁掉）。

## 三、手动复现打包版状态（脚本没覆盖时）

```powershell

# ① 全新数据目录跑后端（验首启迁移 / 登录 / 抓取）
$env:DDTOOLKIT_DATA_DIR = "E:\tmp\dd-fresh"; $env:DDTOOLKIT_PORT = "8131"; python backend_main.py

# ② 验冻结运行时（PyInstaller 相关，如 alembic 资源缺失）
python scripts/build_backend.py
$env:DDTOOLKIT_DATA_DIR = "E:\tmp\dd-fresh2"; $env:DDTOOLKIT_PORT = "8132"
frontend\src-tauri\binaries\backend\ddtoolkit-backend.exe

# ③ 验前端（对着上面的后端跑 dev server，浏览器打开即可）
cd frontend; $env:VITE_API_BASE = "http://127.0.0.1:8131"; npm run dev

# ④ 免安装包验证「打包后的应用」（后端热替换：便携版直接换 binaries\backend）
python scripts/collect_release.py --portable-only     # 重打 dist-release\DDToolkit-portable-win64.zip
```

## 四、什么时候必须整包重建

- `frontend/src-tauri/src/*.rs`（Rust 壳）、`tauri.conf.json`（窗口/资源/CSP）；
- 需要确认**安装包布局**（如 `_internal` 事故）—— 只有 `npm run tauri:build` 产出的 `installer.nsi` / setup.exe 能反映；
- 发布前：**`python scripts/release.py <版本>`** 一条命令把"版本同步 → 门禁 → 整包重建 → 产物校验（含安装包布局）→ 提交/tag → 推送 → Release"全跑一遍（devlog/084；只想预演用 `--dry-run`，手工分步与排查见 `docs/RELEASE.md`）。

## 五、新增回归用例的约定

修 bug 时**先补用例**（`tests/test_auth.py` 等），命名里带现场信息，docstring 写清「用户看到什么 / 根因是什么」：
```python
def test_bili_poll_reads_inner_data_code():
    """回归（2026-09-08 实机）：扫码状态在 data.code，外层 code 恒为 0。..."""
```
判据：`Select-String -Path tests/*.py -Pattern '"""回归'`。这样下次同类问题在 `pytest` 里几秒就能拦住，不必等出包。

## 六、拆前端入口 / 抽共用样式时的坑（2026-09-24 加，devlog/181）

小窗拆成独立 HTML 入口（`widget.html` → `src/widgetMain.tsx`）踩到的三类问题。**共同点：它们都不在任何 import 图里，所以编译、类型检查、单测全是绿的。**

### 6.1 「顺带生效的东西」是拆入口最容易漏的一类依赖（样式 + 启动副作用）
漏掉的**从来不是组件自己**，而是"原来顺带生效的全局东西"。这条纪律到目前**犯了五次**：

| 次 | 漏掉的 | 表现 | 为什么难发现 |
|---|---|---|---|
| 1（devlog/181） | Tailwind preflight 的 `box-sizing`（只在 `index.css` 里） | 胶囊宽 **224px** 而非规格的 200px（退回浏览器默认 `content-box` ⇒ 宽高各多出 padding + border） | 尺寸差看得见 |
| 2（devlog/185） | `layout.css` 里的 `.os-*` 样式（`OverlayScroll` 用得到） | 面板里条目与页脚**叠在一起**（没有 `display:flex`）—— **比 preflight 那次更容易漏，因为它是"我们自己另一个文件里的样式"** | 排版坏了看得见 |
| **3（devlog/188）** | **`main.tsx` 的启动副作用**（`setApiBase` 注入后端端口） | **每 2 秒一个 `ECONNREFUSED`**（`/api` 在桌面端没人代理，真后端在动态端口上） | ⚠️ **界面完全正常** |
| **5（devlog/264）** | **`layout.css` 里的胶囊"解剖"**（`display:flex`/`gap`/`border-radius`/字号/点的 7×7） | 真窗口里胶囊是**方角 + 非 flex 行**、字号 16、**点 0×0（紧迫度整个通道看不见）** | ⚠️ **探针一直在"主窗口"里量**（`?density=widget`），那份文件它加载得到 |
| **6（devlog/264）** | **`layout.css` 的 `body { font-family: var(--font-family) }`** | 真窗口里胶囊与面板用的是 **WebView2 默认字体**（实测 `"Noto Sans SC"`，顶栏是 Alimama）—— 而且 `tokens.css` 的 `@font-face` **下载了却没人用** | ⚠️ 同上：字号/宽高都对，只有**字体族**不对（肉眼能看出"字体不一样"，但没人量过） |
| **7（devlog/265）** | **`layout.css` 的 `@keyframes si-panel-in-fade`** | 引用它的 **reduce 分支在共用文件里** ⇒ 小窗在 `prefers-reduced-motion` 下引用一条**不存在的动画名**（等于没有入场） | ⚠️ 只在**开了 reduce 的机器**上、且**只看小窗**才现形（definitely"没人量过"） |

**第三次最危险**：前两次是**样式**（肉眼能看出不对），这次是**副作用** —— 面板照样显示、胶囊照样亮，只是后台一直在打一个死端口。**"界面看起来对"完全不能推出"它在正常工作"。** 而**副作用漏了不会红**：没有测试、没有类型错误、探针也不查（它只看界面）；唯一能兜住的是**看日志** —— 所以"用户说日志里有报错"永远值得当成正经线索查到底。
**第 4 次没有发生**（devlog/202，S1 会话 token）：小窗是独立入口，**也要**注入 token —— 这次是按下面第 3 条清单逐条过时**提前抓到**的（小窗到 S1 前只注入端口）。⇒ 清单是能用的，别等它红。
**第 5/6 次（2026-09-30）的教训与前面四次不同**：漏的东西都是**样式**（好发现），但**判据的坐标系错了** ——
`--status-widget` 有两段，第一段在 `index.html?density=widget`（主窗口，加载 `layout.css`），
第二段才在 `widget.html`。解剖与字体只被第一段量过 ⇒ 绿。
**"漏了东西"和"漏了坐标系"会互相掩护**：只要有一条判据在错的地方量，前者就永远不会红。
⇒ 拆完入口后**每一条新判据都要问一句"我量的是哪个坐标系"**（§6.5），
并且**共用文件的搬家方向必须单向**：大文件 → 共用文件（D1 就是把 `.topbar-status*` 的共享部分
搬进 `status-island.css`，**搬不是抄** —— 留一份就又变成两个真源）。
⚠️ **第 6 次还教了一件**：新加的那条判据在顶栏宿主里是**正对照**（那条继承链必然成立）——
小窗那条红了就只能是入口差异，不必再论证"胶囊本来就该用全站字体"。**判据成对写，因果更省事。**
**规矩**：
1. **新建/拆分入口后，逐个核「当前布局与运行靠哪些全局东西兜着」** —— preflight / base 层（⚠️ **`body` 上的 `font-family` / `color` / `line-height` 这一类和 `box-sizing` 一样会漏**）/ reset / 自定义属性（`tokens.css`）/ 被跳过的那个入口模块的**顶层副作用**。判据：*这个属性我在组件里没写过，那是谁给的？* 找不到出处，就当它不存在，**显式补上**。
2. **审计办法（可复用）**：从组件源码抓出所有 `className`，逐个查"是否**只**在另一个入口的 CSS 里定义" —— `used − classes_in(小窗能拿到的 CSS) − classes_in(小窗拿不到的 CSS)` ⇒ **判据不是「它看起来属于哪一块」，而是「用到它的入口有几个」**。共用组件的样式必须放**共用文件**；搬家方向是单向的（大文件 → 共用文件），反过来不行（小窗引 `layout.css` 正是独立入口要避免的那 153KB）。
3. **顶层副作用清单**（逐条过）：`setApiBase` / 任何 `api.*` 的基地址注入 · 全局监听（`window.onerror` / `unhandledrejection` / `resize`）· 定时器与轮询的启动 · 埋点 / 主题应用 / `localStorage` 迁移 · 静态启动幕的摘除与根元素上的标记属性。判据还是那句：**「这个东西是谁设置的？新入口里有人设置它吗？」**
4. **共用文件必须自包含**：抽 `status-island.css` 时开头几行 reset 是两个入口都需要的，一度只留在主入口那份 ⇒ 表现是"主窗口正常、小窗错位"。**共用样式文件不假设调用方设好了什么**，要复用的 reset / 变量跟着内容一起搬。
5. ⚠️ **「只在真机上生效的修复」等于没法验证的修复**：`--widget-panel-max-h` 的赋值曾写在"展开就 resize"那个 effect 里，而那条 effect **第一行就** `if (!('__TAURI_INTERNALS__' in window)) return` ⇒ **探针里这个变量永远设不上**，走的还是那条有 bug 的 `60vh` 分支。**"我修了、我验了、但验的不是我修的那条路"比不修更危险**，因为它让人以为已经安全。修复若依赖"只在真机存在的条件"（Tauri 存在 / 有真窗口 / 有托盘），**它的验证也必须在真机上**，或者把**前提挪到环境无关的地方**（这次就是把变量准备单拆一条 effect）；写修复时问一句 **「这条路径在探针/CI 里跑得到吗？」** 跑不到 → 要么挪，要么在 `TODO.md` 里显式记下"只能真机验"。
判据命令：`python scripts/ui_probe.py --status-widget`。

### 6.3 反例：别用"症状"当跳过断言的前提
`--status-island` 的空闲语义断言在真机上必然误报（探针自己起的后端会跑启动外部补抓）。第一版修法写成"**胶囊亮着** ⇒ 判为环境问题 ⇒ 跳过" —— **这是循环论证**：把"空闲却常亮"这个**真 bug** 一起当环境问题放过了，而"空闲不占顶栏"正是那段断言要守的东西。**跳过等于把断言删了。**
**规矩**：跳过断言必须**取独立凭据**（这里是后端 `/vtuber/fetch-status` 的 `external.running`），不能拿被测对象的症状当自己的前提。四种分支（**已实现在 `ui_probe.py` 的 status-island 段**）：前提成立 → 照常断言；前提不成立且有独立凭据 → 跳过并**打印**凭据说明原因；症状表明可能有问题、但凭据取不到 → 跳过（环境判不了，但**绝不伪造成"失败"**）；**症状表明有问题 + 凭据确认没问题 → 报红**（这正是要抓的回归）。

### 6.4 绿色 ≠ 断言有效（反向验证）
跳过逻辑一旦写错，**绿色的含义就变了**：它可能什么都没验。所以新增/修改断言后**必须反向验证**：人为破坏 → 必须红 → 恢复 → 绿。
例（devlog/181）：伪造"后端说没任务"（`_backend_ok = True; _busy = []`）再跑 —— 确实红了、退出码 1，才证明那条断言有牙齿。**这一步不能省。**
**⚠️ 反向验证还会告诉你「这条断言根本咬不动」**（2026-09-25 加，devlog/189）：R45-F 的「标题不许出面板」按直觉把 `max-width` 改成 `none` —— **照样绿**（绝对定位元素没写 `width` 时是 **shrink-to-fit**，可用宽 = 包含块宽 − `left` ⇒ `max-width` 再大，盒子也**越不出包含块**）。真能破坏它的是**显式 `width`**（`width: 200%` ⇒ 实测红，报「右缘 1626 越过内缘 1060」）。⇒ ① 反向验证要挑**真的能破坏它的那个改法**，改不动就用更极端的手段（显式尺寸 / 负偏移 / 直接改被测元素），直到它红 —— **红不了就说明这条断言是装饰**，删掉或改写；② 找不到任何能破坏它的改法时，**这条断言现在没有牙齿**（哪怕它将来可能有用）—— 要么改成能咬的（量一个别的量），要么在注释里写明"它守的是哪一类改动"，免得下一个人以为这块有守卫。
**⚠️ 判「谁盖住谁」要找「层叠上下文那一层」**：写"工具条必须盖住标题"时，第一版去读 `.view-switch` 的 `z-index` —— **读到 `auto`**（`z-index: 3` 写在它的**父级** `.view-toolbar` 上）⇒ 8 帧全红。机制是：`.view-body { z-index: 1 }` 是标题的**包含块**，非 `auto` ⇒ 自成层叠上下文，标题那个 `z-index: 2` 只是**它内部**的层级、**爬不出** `.view-body`。⇒ 一个元素能不能压过另一个，取决于**各自所属的层叠上下文**，**不是各自 `z-index` 的大小**（把标题改成 `z-index: 9999` 也照样被盖住）。判据判的是 `viewBodyZ < toolbarZoneZ`，而不是标题自己那个数（代码在 `ui_probe.py` 的 glow 段，默认三档就跑）。

### 6.5 「在大容器里绿」推不出「在小容器里能用」（2026-09-24 加，devlog/183）
**这是本仓踩过的最隐蔽的一类假绿。** 小窗（200×40）里的通知面板 `top = 胶囊底(40) + 6 = 46` —— **整个落在窗口外**，宽 280 也超出 200。**用户从来没看见过那个面板**，而所有探针一路绿：`--status-island` 一直在**主窗口的视口**（1100×800）里量状态岛那套样式，"在 1100 宽的视口里，280 宽的面板当然在视口内、可命中"。**它量的是「这套样式在一个大视口里对不对」，而不是「在小窗里能不能用」—— 判据的坐标系错了。**
**规矩**：
1. **同一个组件被塞进不同尺寸的容器时，"在大容器里绿"完全不能推出"在小容器里能用"。** 判据必须跑在**实际会被使用的坐标系**里（这里就是 `widget.html` 本身）。
2. 新写一条判据时，问一句：**它的坐标系是谁的？** 如果答案不是"最终用户看到的那个盒子"，它就是在替**另一个**东西把关。
3. **布局类改动别只看算出来的数字** —— 先手算一遍几何（宽/高/左右边界 vs 容器），常常一眼就能看出"这东西根本装不下"（devlog/183 就是这么发现的：做 hover 之前顺手算了一下 `top`，当场对不上）。
4. **量出来要连原始矩形一起报**（`shellRect` / `islandRect` / `viewport`），不要只报一个"误差 = −290px"—— 只给差值的话，偏了也**不知道是谁的尺寸不对**（容器不是视口高？元素被撑高？父级没撑开？），只能猜。
5. ⚠️ **「视口尺寸不对」是一种系统性盲区，比"漏写某条断言"严重**（devlog/185）：所有判据都跑在**浏览器视口**（约 1076×621）里，而小窗真窗口是 **200×40** —— 凡是按 `vh` 算的尺寸在 621px 下**全都显得正常**（`calc(60vh − 74px) = 298px`，夹不住任何东西），而真窗口 40px 高时它是 **−50px** ⇒ 滚动体归零、条目压到页脚上（**用户第二次截图就是这个**）。**修法**：另跑一段**按真窗口尺寸**（200 宽 **× 90 高**）的判据。**只改宽度是不够的** —— 第一版只把宽改成 200、高度照旧 760，结果**绿的但什么都没验到**；**盲区的形状是"尺寸"，不是"宽度"**。
6. **外框对 ≠ 里面没坏**：验一个浮层时，别只量它外面（在不在视口内 / 点不点得着 / 总高多少）—— 还要量**内部各段的位置**是否首尾相接。真机上外框完全正常、里面却是叠的（devlog/185）；做法是量头部/滚动体/页脚三段的 `getBoundingClientRect()`，断言两两不交叠、且**中间的滚动体不能被压成 0 高**（0 高 = 条目一条都看不见）。
判据命令：`python scripts/ui_probe.py --status-widget`（里面就有"真尺寸 200×90"那一段，机制注释在 `ui_probe.py` 的 status-widget 段）。

### 6.6 ⚠️ **新写的探针字段，先用已知量对一次再拿去判据**（2026-09-24 加，devlog/186）
**探针字段本身也是代码，也会错** —— 而它错了的时候，症状是"产品看起来错了"。R45-E 实测：新量一个「主体内容顶」读到 **109**，而设计值是 **103**（= 让开带 52+51），差 6px。顺着"产品哪里多了 6px"查了三轮（怀疑过 `::before`、margin、`scene-in` 动画）**全错** —— 真因是**这把新尺子自己**：`barR.top − --toolbar-top` 用工具条反推面板原点，而工具条**隐藏态**带 `transform: translateY(-6px)`（显隐动画的 rest 态）⇒ 面板原点算成 34（真值 40）⇒ **所有"面板内坐标"系统性多 6px**。
**规矩**：
1. **能用元素自己的 rect 就别从别人身上推** —— `.posts-panel` 就在那儿，直接读它的 rect，一切"面板内坐标"以它为准；反推那一版还**多背了一个 `--toolbar-top` 的耦合**（令牌一改，尺子跟着偏）。
2. **新尺子上线前，先量一个"答案已知"的对象对一次**：这里只要先量 `getBoundingClientRect()` 的视口值就会发现（首块内容 y=143、面板 y=40，差 **103**），一眼就对上了，根本不用查产品。
3. **虚拟时间下动画可能停在起点，量几何前要杀掉** —— 同一次里 `cards` 帧的 `.view-body` 读到 `matrix(1,0,0,1,0,8)`（`scene-in` 的 from 帧 `translateY(8px)` 没推进）⇒ 那一帧多 8px。**又是尺子问题**；做法与 `.view-switch-thumb`/`.view-btn` 杀过渡完全一样。
4. **判据红了先问"是不是我量错了"**，再问"产品错没错"。判别法子：把原始矩形一起印出来（视口坐标 + 容器坐标 + 容器自己的 rect）—— 只报一个差值，偏了也不知道是谁的尺寸不对。
⚠️ **活反例（尚未修）**：`frontend/src/dev/probe.ts` 的 `heroTop.topInPanel` **仍用 `barR.top − --toolbar-top` 反推** —— 正是第 1 条骂的那种写法，同一个 6px 偏差还在，别拿它当正面样板。

### 6.7 **手算的"堆叠常数"过不了数据这一关 —— 改成量**（2026-09-24 加，devlog/186）
弹窗的 `max-height` 一直是 `calc(100vh − <手算常数>)`，注释写着"弹窗顶端最坏落在 243px"。R45-E 把它拆成逐项相加（`42 + 10 + 63 + 6 + 8`）—— **看着更严谨，其实一样错**：**因为要减掉的那一摞里有"会换行的行"，而换不换行取决于数据** —— `.header-actions`（账号切换器行）2 个账号时 1 行 30px、8 个账号时 **2 行 68px**（`flex-wrap`）；`.type-chips-row`（筛选行，窄档）1 行 25px / **2 行 66px**。实测（1100 档 + `--seed-accounts 8`）：弹窗顶落在面板内 **264px**，手算公式只减了 115px ⇒ 上限给到 349px ⇒ **弹窗底部越出面板 25px，被 `.posts-panel` 的 `overflow:hidden` 裁掉**。
**规矩**：
1. **"最坏情况常数"只对"行数固定"的堆叠成立**：一旦某一层会被内容/宽度**换行**，这个常数就**没有正确值** —— 加得再大也只是把失效点往后推，而且会让正常档位的弹窗白白变矮（多出内部滚动）。
2. 判据：**这个数能从现成的 rect 减出来吗？** 能 ⇒ 就别写常数，量它 —— 这里就是 `面板下缘 − 触发器下缘 − 间隙 − 呼吸位`，两个 rect 都是现成的。
3. **量出来的值要挂上 `ResizeObserver` + `resize`**，否则换行条件一变（改窗口宽度、账号数变化）它就过期了 —— 而过期的测量值比常数更危险：**它看起来是"实测"的**。
4. **样式表里留一条保守兜底**（首帧 / JS 未跑），并写清它只是兜底；兜底宁可偏小（矮一点、内部滚动），不要偏大（越界被裁 —— 那是"内容够不着"）。
5. **跨语言的两段距离只留一份真源**：间隙/呼吸位定义成 CSS 自定义属性（`--pop-gap` / `--pop-breath`），TS 侧 `getPropertyValue` 读，**不各写一份数字**。

### 6.8 ⚠️ **自指循环**：别用"会被自己的结果决定"的量当参照系（2026-09-25 加，devlog/187）
小窗的面板高度 → 决定**窗口**高度（窗口 = 40 + 6 + 面板高）→ 而面板的**高度上限**又按窗口高算 ⇒ **循环闭合**，面板被永久压在某个值上。同一个循环换过**三件外衣**，每一件看着都很合理：`max-height: 60vh`（`vh` = 窗口高的 1%，折叠态窗口 40px ⇒ `60vh=24px` ⇒ 面板压成一条）· `max-height: innerHeight - 120`（**`innerHeight` 就是小窗自己的高** ⇒ 收敛在 120px 下限，**永远长不开**）· `max-height: screen.availHeight - 120`（屏幕高**与窗口无关** ⇒ 不闭合 ✅）。
**判据（比"别用 vh"更本质）**：
> 给小窗（或任何"尺寸被内容决定"的容器）里**按尺寸算**的值选参照系时，先问一句 **「这个值会不会因为我算出来的结果而变？」** —— 会，就不能用。
⚠️ `vh` 只是这个循环**最显眼**的一件外衣。换成 `innerHeight` / `clientHeight` / `getBoundingClientRect().height` **全都一样会闭合** —— 要的是**外部参照系**（屏幕 / 显示器 / 任务栏），不是"换一个词"。
**同一循环的第二处**（这次一起修的）：`StatusIsland.place()` 原来自己按 `innerHeight` 判"下面放不下就往上翻"，在顶栏宿主里对（那是稳定的应用窗口高），在小窗宿主里就是同一个循环（展开前后 `innerHeight` 从 40 跳到面板高）⇒ 判据乱跳，面板被放到窗口外（`top = -126`）。修法是**跟随窗口那边写下的方向属性**（屏幕级几何的唯一事实源；D1 起叫 `data-dir`，原来是只有上/下两态的 `data-flip`），并用 `MutationObserver` 盯这个属性变化重排 —— **不让窗口去调组件**（组件不该知道窗口存在）。
> ⚠️ **D1 给这条纪律补了个横向的副本**：同一个"两个主人"问题换到横轴上 —— `.widget-shell` 的 `justify-content: center` 与几何抢"胶囊在窗口里靠哪一边"（面板向左长时 CSS 把胶囊按回中间）。修法一样：`flex-start` + `margin-left: var(--widget-capsule-x)`，偏移**只由几何给**。**凡是"某个元素该在哪"的问题，先数主人有几个。**
**推论：诊断仪器有寿命。** 探针回答完它那个问题之后就该校准或撤掉，否则从"提供事实"变成"制造噪音"—— 而噪音的代价是**真错误会淹没在里面**（用户这次就以为小窗又坏了）。
判据命令：`python scripts/ui_probe.py --status-widget`（含"真尺寸 200×90"那一段）。同一条纪律另见 `UI-MAP.md` §F2 末条；"收起必须回到展开前记下的位置"有 `widgetWindow.test.ts` 的 10 轮循环单测守。

### 6.9 ⚠️ 「位置」只能有一个主人：布局推算 vs 几何计算（2026-09-25 加，devlog/188）
"胶囊在小窗里的位置"有两个来源：`widgetExpandGeom` 算出的**窗口矩形**，与 CSS 自己认定的"翻上去就贴窗口**底**边"（`justify-content: flex-end`）。**大部分情况下它们碰巧一致**（没被夹时窗口底边就是胶囊底边）—— **这正是它难发现的原因**：只有**夹取/边界条件**才让两个主人分开（胶囊 y=10、高 40 ⇒ 向上翻要 y = 50 − 183 = −133 ⇒ 被夹到 0；真实偏移 = 10 − 0 = 10，而 CSS 给 143（= 183 − 40）⇒ **差 133px，胶囊跳到窗口中间**）。
**规矩**：当"一个东西的位置"能由**布局推算**也能由**几何计算**得到时，**只留一个主人**（这里是几何 —— 它知道夹取），另一个只负责**用**那个值（写进 CSS 变量 `--widget-capsule-offset`）。
**判据**：写完一段几何代码后问一句 —— **「这个值布局会不会自己算出一个不同的答案？」** 会，就得把它显式钉住。
判据命令：`python scripts/ui_probe.py --status-widget`。

### 6.11 ⚠️ 优先级**相同**的两条规则，谁赢只看**文件加载顺序**（2026-09-24 加，devlog/186）
`.os-root { position: relative }`（在 `status-island.css`）与 `.lc-pop { position: fixed }`（在 `posts.css`）**都是单个类** ⇒ 优先级都是 (0,1,0)；同优先级下 CSS 不比较"谁更具体"，**只看谁在后面**。真正的坑不是"这条规则写错了"，而是：**它平时碰巧是对的** —— `.os-root` 从前住 `layout.css`（`layout.css` → `posts.css`，`.lc-pop` 赢 ✓），R38 批 5e 搬进 `status-island.css` 之后，`PostsPage`（`App.tsx` 第 7 行）先于它（第 12 行）加载 ⇒ **`.os-root` 赢 ✗**。批 5e 是一次**纯粹的"文件整理"**，没人会认为整理文件会改变行为 —— 这就是它的全部杀伤力。
**症状**：hover 直播日历日期格，浮窗**完全不出现**（探针实测计算 `position` 是 `relative`，浮层留在 `body` 的普通流里，落在视口 `y≈930`，而视口只有 621 高）。**为什么极难查**：① 浮层是 `createPortal` 到 `document.body` 的 ⇒ 它**在视觉上"没有祖先"**，"某个祖先的样式压住了它"这条直觉根本想不到；② "改 `position` 的后果"长得**像布局数学问题**（`left/top` 算错），第一嫌疑永远落在 `left/top` 上，而那部分**一直是对的**；③ 它**不会红**（没有测试、类型也查不出，`position` 是合法计算值）。
**规矩**：
1. **共享组件的基类不允许靠"顺序"输。** 消费者要改 `position` / `display` 这类**基类自己也会设的**属性时，**用两个类**（`.os-root.lc-pop`，抬到 (0,2,0)），把结果钉在**与加载顺序无关**的地方；单类靠顺序赢的写法，会被任何一次搬家或 import 调整打碎。
2. **搬家样式 = 改级联**，不是整理文件。挪一条规则到另一个样式表（哪怕只是调 import 顺序）时问一句：**「有没有同优先级、本来靠先后决出胜负的选择器？」**
3. 探针要**判两条**：计算 `position` 是否真是 `fixed`（**机制**）＋ 矩形是否落在视口内且命中测试命中自己（**效果**）。只判效果的话，"浮窗被算到屏幕外"和"浮窗根本没渲染"永远分不开（本批正是靠"机制"那条一眼定位的）。

> **补充**：红线**不是**本批引入的 —— 是 R38 批 5e 那次"样式搬家"埋的。**先确认"是不是我改的"，再去修**，比先怀疑自己省时间得多。查法要**只读**（`git log -S` / 看这条规则住在哪个文件 + `App.tsx` 的 import 顺序），别用会动工作区的命令去回答只读问题（见 §7.2）。
判据命令：`python scripts/ui_probe.py --cell-pop`（**机制 + 效果两条都在里面**，注释在 `ui_probe.py` 的 cell-pop 段）；同一条纪律见 `UI-MAP.md` §F2 末条 / §F3。

### 6.12 ⚠️ 用例不许碰**真实数据目录**（同类事故 2 次，2026-09-26 升级成规矩）
`DATA_DIR` 默认**就是项目根**，于是测试进程里的 `settings.DATA_DIR` 与模块级单例全都指着开发者那套真实数据，而这类越界的症状一律是"**什么都不红**"：

| 次 | 越界 | 症状 |
|---|---|---|
| 1（devlog/200） | 后台任务用 `scheduler.SessionLocal`（`dependency_overrides` **只管路由**） | CI 上报 `no such table: accounts`，本地因为"开发库恰好有那张表"而绿 |
| 2（devlog/202） | 本批新写的 `test_api_auth` 打 `/healthz`（首次访问会写 `DATA_DIR/.first-run-done`） | 仓库根多一个未跟踪文件，且**吃掉开发态首启那一态**（之后手动起后端，登录浮窗不再弹） |

**判据**：新增用例只要**打真应用**（`TestClient(app)`）或**起后台任务**，就问一句「**它读写的 `DATA_DIR` 是谁的？**」漏网的三条路是**后台任务 / 落盘副作用 / 模块级单例**。修法统一放 `tests/conftest.py`（每进程独立测试库 + `/healthz` 标记重定向），别在每个用例文件里各写一遍。守卫用例：`tests/test_api_auth.py::test_healthz_writes_its_first_run_marker_outside_the_real_data_dir`。

### 6.13 ⚠️ 加了门禁之后，把**所有**"打自己后端"的调用方过一遍（2026-09-26 加，devlog/203）
S1 给后端加了 token 之后，**前端两个入口 + 四个开发态脚本**逐个失效，而它们各自的症状
**没有一个像门禁问题**（"布局坏了 / 网络不可达 / 上游挂了 / 后端坏了"）。
判据命令（一条就够）：**谁给子进程设 `DDTOOLKIT_PORT`，谁就在起后端** ⇒ 它必须同时给
`DDTOOLKIT_DEV_API_TOKEN`。

```powershell
# 起后端的脚本：既要 Popen 又要 DDTOOLKIT_PORT（build_backend.py 只是打包，不算）
Select-String -Path scripts\*.py -Pattern "DDTOOLKIT_PORT" | Select-Object Filename -Unique
# 打后端的调用方（含前端）：裸 fetch / 裸 urlopen 都要走带 token 的那条路
Select-String -Path scripts\*.py,frontend\src\**\*.ts -Pattern "urlopen\(|fetch\(" |
  Where-Object { $_.Line -notmatch "authFetch|dev_token|headers=" }
```

开发态那个固定值**只有一处真源**：`scripts/dev_token.py`（三个 TS/Python 复述点由
`tests/test_dev_token.py` 结构扫描钉住）；起后端的脚本一律 `**backend_env()`
（它还负责**清掉 `DDTOOLKIT_API_TOKEN` 残留** —— 否则子后端会优先读它而两端不一致）。

> ⚠️ **2026-09-27 第三次同类漏（devlog/242）**：`ui_probe.py` 里还有**三处**裸 `urlopen`
> （`_first_vtuber` 与两处 `profile-cards` 落库对账）一直没带 token —— 上面那条命令
> **查得出来**，但它是"写给人跑的"。症状又是三个不像认证问题的样子：手动裸跑探针时路由落到
> `/`（只量到 `empty`、**所有布局断言静默空转**）、`--board-cards` 报"读不回卡片布局"。
> ⇒ 这条现在也有 pytest 判据了：`tests/test_dev_token.py::test_probe_backend_calls_send_the_token`
> （从 Python 侧打后端业务路径的每一发都要 `headers=`，公开三处豁免）。
> **复用教训：能写成判据的检查，别只写成命令。**

### 6.14 ⚠️ 「文件被程序占着」类判据**必须分平台**（2026-09-26 加，devlog/215）
POSIX **允许**改名 / 删除**打开中**的文件，Windows **不允许**（撞"另一个程序正在使用此文件"）。
批次 15 里 `test_dispose_releases_the_file_so_it_can_be_renamed` 的"不 dispose 就改不动名"
那半条写成无条件 `pytest.raises(OSError)`，**Linux 两条腿一起挂在 `DID NOT RAISE` 上**
（Windows 腿反而是绿的 —— 本地那条腿永远看不见）。

**规矩**：凡判据依赖"文件被占用 / 删不掉 / 改不了名"这类**操作系统语义**，就
① 用 `os.name == "nt"` 分开断言，② **可移植的那一半要在两个平台都断言**
（这里 = "dispose 之后一定改得动"），③ 边界写进 docstring —— 别让它变成一条"只在 CI 上红"
的谜题。同族坑：Rust 侧 `delete_old_dir` 的 junction 用例、`migrate.rs` 的文件占用重试。

### 6.15 ⚠️ 临时脚本"写回原文件"必须**逐字节**（换行会被翻译）（2026-09-27 加，devlog/219）
反向验证的套路是"改坏 → 跑红 → 写回"。写回那一步若用
`pathlib.Path.write_text(text)`（`newline=None`）默认会把 `\n` 翻成 `os.linesep`
⇒ Windows 上整份文件变 **CRLF**、`git status` 立刻报该文件被改，
而 `git diff` / `--numstat` 却是**空的**（`.gitattributes` 归一到 LF 之后内容确实没差）
—— 于是"已还原"的自动核对**看不出来**，下次 `git add -A` 就可能把整份文件的行尾改掉。
**规矩**：① 读用 `read_bytes`、写用 `write_bytes`（或 `open(..., newline='')`）；
② 还原后核对的**不是 `git diff --stat`，而是 `git status --porcelain`**（只有它看得见行尾差异）；
③ 真被翻过就 `git checkout -- <file>` 从索引取回。
④ **同一个文件要改多处时，"原样"必须在动手前按文件取一次**（2026-09-28 实测踩到，devlog/251）：
   按"每处补丁各取一次原样"写，第二处取到的是**已经被第一处改过**的内容 ⇒ 还原时把第一处变异
   **写回树里**，而且 sha256 核对的是那份错的快照、**照样通过**（"校验通过"与"真的还原了"是两件事）。
   症状：`git stash pop` 报 `probe.ts 有本地改动`，翻出一个留在树里的探针变异。
   ⇒ 结构上写成 `saved: dict[文件 → 原样]`（`setdefault`），一个文件只存一份。

### 6.16 ⚠️ 探针不许靠**等待**去等 rAF 产物（虚拟时间下"等待"不产生帧）（2026-09-27 加，devlog/219）
`ui_probe.py` 跑在 Chrome 的虚拟时间里：**定时器照常推进，`requestAnimationFrame` 却经常不被服务**
（本仓已记过"400ms 里只被叫 0–1 次"）。于是任何"由 rAF 写出来的 DOM 信号"（`OverlayScroll`
的 `data-scrolled` / `data-scroll-dir` 就是这样）都不能用 `await sleep(…)` 去等。
`--toolbar` 的滚动那一步因此**假红过**：读到的是**挂载时那次同步 `sync()`** 写的旧值 `'up'`
（`OverlayScroll` 首次 `sync()` 是直接调用，之后才走 rAF），于是报出"方向信号没接上"+
"工具条没立即让位"两条 —— **同样的代码再跑一次就绿**，看着像产品 flake，其实是尺子。

⚠️ **第一次修错了**（值得记）：改成"有界轮询等方向真翻"（上限 ~2s）—— **没好**。
虚拟时间里 `sleep` 只是把虚拟钟快进，**并不会让浏览器多排一帧**，所以"多等一会儿"
买不到任何东西，红绿照旧随机。
**真正管用的两条**：
① **能顶掉就顶掉**：让产品在 `import.meta.env.DEV` 下把**同一个**内部函数挂到 `window` 上
（`OverlayScroll` ⇒ `__ddtoolkitOsSync`），探针显式调它。被绕过的只是**浏览器排帧**，
被测逻辑一个字节没动 —— 本仓已有同款先例（`__ddtoolkitSetShellHidden` / `__ddtoolkitCloseClick` /
`__ddtoolkitCorners` / `__ddtoolkitSeedReport`）。**钩子不在就等于空转** ⇒ 探针要把它当**前提**
查出来（`osSyncHook <= 0` 直接判红），别让它悄悄退化成赌运气。
② 顶不掉就**只把"信号到达"当判据、别把"等了多久"当判据**，并把"信号没到"报成**前提失败**
（例如"上滚后 `data-scroll-dir` 应为 `up`"）—— 否则那条判据是**空转通过**。
判红之后**仍要做反向验证**（§0.7）：把产品那一侧真切断，确认红的还是那几条、
且不是被新的等待/钩子掩盖。同族：`nextFrame()` 是 `rAF`+50ms 定时器**双保险**（dev 探针里的工具），
要用它，别自己写裸 `requestAnimationFrame`。

### 6.17 ⚠️ 本地门禁跑的是 **3.14**：注解里"名字没导入"这类错**本地永远看不见**（2026-09-27 加，devlog/229）
**实测事故**：给两个包装函数写了 `-> Any`，而那个模块**没导入 `Any`**。
Python **3.14** 有 PEP 649（**惰性注解**，注解到被读取时才求值）⇒ 本地 `.venv` 的
`pytest` / `tsc` / 全套 A 档**全绿**；**3.12 在 `def` 那一刻就求值** ⇒ 导入即 `NameError`，
而 `tests/conftest.py` 第一行就导入该模块 ⇒ **整个收集阶段失败**。CI 三条 job 全红，
退出码 **4**（pytest 的"用法错误"）——这个症状极易被误读成"命令行参数写错了"。

**两条规矩**：
1. **改了模块级函数签名/注解之后，补一次干净克隆自检**（`uv` 按 `requires-python`
   **下界 3.12** 建环境，正好补上本地 3.14 的盲区）：
   ```powershell
   git clone . ..\ddtk-cisim; cd ..\ddtk-cisim; uv run pytest tests/ -q   # 期望 753 passed / 1 skipped
   ```
   顺手删掉克隆目录。这条同时也是"下界版本到底能不能装/能跑"的唯一低成本自检。
2. **CI 红了先读退出码**（GitHub 的 job 日志要登录，但 **check-run annotations 接口匿名可读**：
   `https://api.github.com/repos/<o>/<r>/check-runs/<id>/annotations`）：
   `1`=有用例失败 / `2`=收集被中断（含 import 错）/ `3`=pytest 内部错 / `4`=**用法错**
   （含 conftest 导入失败）/ `5`=没收集到用例。**别拿"本地绿"当反证** —— 本地与 CI 的
   Python 版本可以差一个大版本。

> **2026-09-27 第二次踩（devlog/236）＋ 这次上了机器判据**：同一个坑以另一个形状复发 ——
> 新模块 `platforms/bilibili_posts.py` 里写了 `client: httpx.AsyncClient | None` 而
> **没 `import httpx`**：本地 A 档 8 步全绿，CI **四条腿全红**（连 Rust 腿也红，因为它的
> 冒烟要起冻结后端）。⇒ 教训靠"记住"不够，现在有判据了：
> `tests/test_annotations_resolve.py` 把 `app/` 下每个模块的函数/类注解**主动求值一次**
> （`typing.get_type_hints`），3.14 也能提前发现 3.12 的问题。
> 边界：只查**没有** `from __future__ import annotations` 的模块（带那行的模块在 3.12 上
> 本来就不求值，如实豁免并数出来）。**新增/搬家模块后如果忘了导入注解里用到的名字，这条会红。**
> ⚠️ **新模块默认不要带那行**：它 = 主动申请豁免，而这条判据带一个配额（豁免 < 待检查）。
> 2026-09-27 三个新模块一带就把配额撑破、**判据自己红了**（"豁免太多，判据快空转了"）。
> 只有像 `routers/img_proxy.py` 那样**为了冷启动故意延迟 import** 的模块才该带它。
> 判据喊"我快空转了"时，**先看自己是不是在薅豁免**。

### 6.18 ⚠️ 「挂死」不是「变红」：先抓栈，别猜；「单跑绿」不算数（2026-09-27 加，devlog/241）

**实测事故**：消息中心的 drain 写成 `await loop.run_in_executor(None, self._inbox.get)`
（"阻塞读丢给工作线程"那套，看着很标准）。单跑 `tests/test_messages.py` **全绿、3.8s**；
全量跑卡在 **68%** —— CPU 冻结、**18 分钟没有任何输出**。`faulthandler` 抓到的栈是决定性的：

```
MainThread   asyncio/runners.py close → run_until_complete(shutdown_default_executor)
Thread-1     futures/thread.py shutdown → threading.join
asyncio_0    queue.py get              ← 卡在这里
```

`stop()` 取消了 drain，但那个工作线程**仍阻塞在 `get()` 上**，而 `asyncio.run()` 收尾要
`shutdown_default_executor(wait=True)` 去 join 它 ⇒ 永远等下去。

**三条规矩**：
1. **卡住先抓栈**：`python -m pytest -o faulthandler_timeout=25 <用例>`（pytest 的 ini 项，
   不需要装插件）—— 它会打出**每个线程**的栈。比"读代码猜哪儿死了"快一个数量级。
2. **"单跑绿"不算数**：这个坑只在"真 lifespan 跑两次"的路径上出现，而那条路径在一个与本批
   **毫无关系**的测试文件里（`test_scheduler_lifecycle.py::test_two_consecutive_lifespans_do_not_double_run`）。
   **碰了生命周期 / 线程 / 事件循环的东西，就跑全量。**
3. **跨线程 + 事件循环的标准形态**：投递必须发生在**应用循环的线程**里（订阅者的队列绑在那个
   循环上），而发布方可能是**没有循环的线程**（T0 守护线程）⇒ `queue.Queue` 中转 +
   `loop.call_soon_threadsafe(wake.set)` 唤醒 + 协程里 `get_nowait` 清空。
   **不要在协程里 `run_in_executor(queue.get)`**：它既留下"收不掉的工作线程"，又给每条消息
   白加一次线程池往返（而降延迟正是这类通道的全部意义）。

### 6.19 ⚠️ 别**采样过渡中的文案**：要断言"界面收到了什么"，去看**结构**（2026-09-27 加，devlog/243）

M1 的探针第一版断言"推来的开播告警让顶栏文案变成『XXX 开播了』"——**红**，而被测的行为是对的：
`.si-text` 是**两段式**（淡出旧的 → 换新的），虚拟时间下 CSS 过渡不推进（§二·五），
采到的永远是**上一相位**的文案（实测读到的是更早那条瞬时消息）。**加长等待救不了**
（同 §6.16：等待不产生帧）。

⇒ 规矩：**判"某某进了界面"要看结构，不看过渡中的文案**。
界面若提供列表/面板（如状态岛 `.si-panel` 的 `.si-item[data-kind]`），就用它 ——
面板是**一次渲染直接列出**的，不经过任何动画相位。判"文案最终是什么"才需要等相位，
而那属于视觉评审，不是不变量。

⚠️ 这条**不需要新工具**：同一份 DOM 里通常已经有"按类型列出来"的那一层（`data-kind` / `data-*`
就是为可测性挂的，见 §6.6 的反面教训：**别把为可测性挂的属性当冗余删掉**）。

### 6.20 ⚠️ `SessionLocal` 是 `autoflush=False`：写一行再查它，**查不到自己刚写的那行**（2026-09-28 加，devlog/249）

R47 的头像账本服务第一版没写 `flush`，于是"先查有没有同一 URL 的行 → 没有就追加"这个
**幂等 upsert 在同一个未提交会话里连续调用时会重复插入**（上一次 `db.add()` 还在
`session.new` 里，查询看不到它）⇒ 撞唯一键 `uq_vtuber_avatar_url`，而它是
**整批抓取的 commit 时**才炸 —— 症状与"抓取偶尔整批失败"一模一样，离现场很远。

两条相关事实：
- 本仓 `app/core/database.py::SessionLocal = sessionmaker(autocommit=False, autoflush=False, ...)`
  ⇒ **`autoflush=False` 不是默认值**，从别处搬来的"查一下就有了"的经验在这里不成立；
- 被 `db.delete(row)` 标删的行**同理**：不 flush 的话下一次查询**还会看到它**（删除还没下发）。

⇒ 规矩：**服务层里"读-改-写"同一个会话时，读之前先 `db.flush()`**（判据 = 那次调用
必须能看见本次会话里之前写/删的行）。护栏写法见 `tests/test_vtuber_avatars.py` 的封顶用例：
**不 flush 就会多出一行**，是能跑红的，不是纸面规矩。

---

## 七、并行开发：**本仓不采用**（2026-09-24 定）＋ 两条通用教训

### 7.1 结论：**一次只开一个会话改代码**
实测过 `git worktree` 之后**决定不用**：建立成本不高（前端约 2.3 分钟、纯后端 9 秒），但**协调成本更高** —— 两个会话实际重叠了 `probe.ts` / `ui_probe.py` / `ROADMAP-DONE.md` 三个文件，为协调付出的代价（让 devlog 编号、两次手写 blob 暂存、一次差点扫走对方 6 个文件）约 15–20 分钟，**已是建立成本的数倍**（数字证据见 devlog/184）。想并行推进，就在**一个会话里分批次**做（R38 批 5c / 5d 就是这么做的）。
> ⚠️ **别照抄外部的 worktree 教程** —— §7.2 记的是"为什么不划算"，**不是操作指南**。本仓的枢纽文件太集中（`ui_probe.py` / `tokens.css` / `TopBar.tsx` / 共享文档），并行时必冲突。

### 7.2 但下面两条**与并行无关**，任何时候都适用
当初是为评估并行才查的，查完发现它们**在单会话下同样会咬人**。

#### ⚠️ `git stash -u` 是**全仓**操作，别拿它回答只读问题
判断"某个 tsc 报错是不是我引入的"时用了 `git stash push -u` —— 结果 stash 到了**另一个进程正在改的 6 个文件**。这次两次 stash 都完整 pop 回来了（核对过 `git stash list` 为空、diff 规模未变），**没丢东西**，但这是**运气好**。
**规矩**：① 判断"报错是不是我的"用**只读**办法 —— `npx tsc --noEmit | Select-String <我改过的文件名>`；② 真要 stash，**先 `git diff --stat` 记下范围**，事后逐条核对；③ **别用会动工作区的命令去回答一个只读问题。**

#### ⚠️ 全新检出（或任何干净副本）**开箱不能构建 Rust 壳**
`frontend/src-tauri/tauri.conf.json` 的 `bundle.resources` 是 `["binaries/backend/**/*"]`，而 **`frontend/src-tauri/binaries/` 被 gitignore**（PyInstaller 产物）。⇒ 少了它，`cargo check` / `tauri dev` **必然失败**：`glob pattern binaries/backend/**/* path not found or didn't match any files`。
**规矩**：在任何干净副本上开工前，先 `python scripts/build_backend.py`（或者从已有工作区把 `frontend/src-tauri/binaries/` 拷过来）。**看到这条报错别怀疑编译器或 Tauri 版本** —— 是构建产物没生成。`git clone` 到新机器、`git clean -xfd`、CI 冷构建都会命中同一个坑。
> ⚠️ 测试库必须是**每进程独立目录**（`tempfile.mkdtemp`）—— 曾有两条规矩（并发跑门禁会撞库 / 仓库根会堆出 119MB 的 `test_vtuber.db`）都是它的症状。
