---
doc: desktop/shell
class: module
scope: Tauri 壳：进程生命周期（单例 / Job Object / 托盘 / 深休眠 / 退出）、窗口、会话 token 的生成与准入、数据目录的选择与迁移、更新器
not-scope: 前端界面怎么画 → frontend/UI-MAP.md；后端业务逻辑 → backend/ARCHITECTURE.md
sot: frontend/src-tauri/src/lib.rs, frontend/src-tauri/tauri.conf.json
verify: cargo test --manifest-path frontend/src-tauri/Cargo.toml
budget: 700
retire-when: 桌面壳换掉 Tauri，或改成多进程模型
---

## 1. 桌面壳生命周期：隐藏 / 深休眠 / 退出（2026-09-15，R18 devlog/095 + R20 devlog/097）

壳（Tauri）与后端是**两个进程**，`✕`、托盘、深休眠各自触发不同的事件。三条规则：

1. **关闭 ≠ 退出**：`CloseRequested` 被拦成 `hide()` + `set_skip_taskbar(true)` + `emit(shell:hidden)`
   （后台抓取照常、前端**停表**）；`RunEvent::ExitRequested` 在非主动退出时 `prevent_exit()`
   —— 深休眠销毁 WebView 也会走到这里，少这一句整个应用会被"休眠"带走。关闭语义由
   `prefs.close_action` 决定（`ask` 默认 / `tray` / `quit`，首次问一次并记住）。
2. **隐藏 ≠ 停止**：隐藏期间前端停掉顶栏两条轮询与状态岛轮播，**恢复时立刻补一轮**。判据必须读
   **同步源** `isShellHidden()`，且"排程"与"触发"两处都要判 —— 只判一处会漏掉隐藏前排下的那一发
   （实测漏网时刻 `22063`，隐藏发生在 `14349`）。
   **唯一的例外（R29，devlog/129）**：`hooks/useTrayStatus` 在隐藏期间保留一个 **60s 心跳**
   （只为了让托盘那行「风控冷却中 · …」不过期），且**刻意不在隐藏瞬间打第一发** ——
   隐藏时界面刚同步过（≤2s 旧），而停表判据（探针 `--tray-suspend`）看的正是"隐藏后有没有请求"。
3. **退出路径不依赖前端**（R20 用户实测事故的结论）：原先托盘「退出」只 `emit(shell:quit-requested)`
   等前端确认，而深休眠/未加载时**没人接这个事件** ⇒ 选过"最小化到托盘"后根本退不出去。现在 Rust
   先问后端**单一事实来源**（`GET /vtuber/fetch-status` 的 `manual_running`）：**没任务在跑就 `exit(0)`**，
   有任务才唤回窗口 + 发事件让前端确认（`quit_app` 置 `QUITTING` 再 `exit(0)`）。通用纪律：
   **"必须成功"的动作不能建立在可被销毁的一侧**；判据由 `cargo test` 2 条守着。
4. **隐藏期间后端保持"尽可能快"的抓取节奏 —— 不要降频**（R24b 被明确取消，2026-09-16 用户口径）：
   托盘模式的目的是"后台照抓"，而且**已规划的消息推送（TODO R25：把开播/新动态推到其他平台）
   直接依赖这条** —— 隐藏时把 T0 直播轮询从 60s 调成 5 分钟，就等于把推送时效拖慢 5 倍。
   所以：**隐藏只影响"前端渲染与前端轮询"**（`useShellHidden` 停的是界面自己那两条链），
   **后端调度节奏与隐藏状态无关**。将来若要省电，只能在这条约束之外另找办法
   （例如系统级节能、或用户显式选择"省电模式"，且必须在界面上写清会拖慢推送）。

**深休眠（P2）**：隐藏满 10 分钟销毁 WebView 省内存（`DDTOOLKIT_TRAY_SLEEP_SECONDS` 仅供测试覆盖），
唤回时**重建窗口**并加载 `index.html?restored=1`（SPA 深链接在资源协议下会 404）；位置与视图从
`localStorage` 的 `ddtoolkit.shell-state` 恢复，`?restored=1` 是**唯一的恢复开关**（普通启动不恢复）。

## 2. 数据目录与磁盘占用（2026-09-16，R22 devlog/103）

数据目录默认在 `%APPDATA%\com.ddtoolkit.app`（便携版可用 `DDTOOLKIT_DATA_DIR` 指定）。
实测开发档（8 个 V / 11 账号）：**库 54.3MB**（其中 `posts.raw_json` 占 **46%**，5.9KB/帖）、
**图片缓存 101.7MB**、日志 5.7MB ⇒ 涨得最快的是**图片缓存**，其次是库里的原文 JSON。

| 机制 | 规则 | 为什么 |
|---|---|---|
| 图片缓存 | TTL 7 天；**容量上限 `IMG_CACHE_MAX_MB`（默认 300）**，超限按 **mtime 最旧优先**淘汰 | 缓存是纯可再生数据。**命中会刷新 mtime** ⇒ 淘汰近似 LRU，热图（头像/常看封面）不会因"抓得早"被误删 |
| **轻资产长期副本**（`static/assets/`） | 与图片缓存**两套**：按 `(kind, 稳定键)` 去重、一个键一个文件；命中稳定键 ⇒ **不再回源**；只按 pin / LRU / 每 kind 上限淘汰，**被引用的不许清** | 图片缓存是"看一眼就够"的临时数据，**清空它应用外观不变**；而固化副本是"认定的长期资源"（远端 URL 会死、会被防盗链拦）⇒ 必须有索引与 pin/引用保护。判据：清空 `img-cache` 后外观不变（L2） |
| 库回收 | 启动时把库切成 `auto_vacuum=INCREMENTAL`（**超 512MB 跳过**）；解除订阅/删账号之后调 `incremental_vacuum()` | SQLite 默认 `NONE`：删掉的行只进 freelist，**文件永不缩小**；而全库 VACUUM 的临时空间≈库大小，不适合在升级路径上做 |
| 体检 | `app/services/db_maintenance.py::dir_stats()`：库（含 `-wal`/`-shm`）/ 缓存 / 日志 / 其余 + 磁盘剩余 + **遗留备份清单** | "哪块在长"必须能被回答；`vtuber.db.bak-*` 这类手工备份不会自己消失 |

> **数据目录怎么定**（`frontend/src-tauri/src/datadir.rs`，devlog/105–112）：优先级 =
> **环境变量 `DDTOOLKIT_DATA_DIR` > 应用内迁移记录（指针） > 默认目录**。默认目录有两份：
> 安装版 `%APPDATA%\com.ddtoolkit.app`、**dev 构建加 `-dev` 后缀**（`lib.rs` 的
> `cfg(debug_assertions)` 分支 —— 免得调试抓取/登录写进生产数据）；**后缀只加在默认目录上**，
> 因为环境变量与迁移指针都是"用户显式指定"，不该被改。指针文件 =
> `%APPDATA%\DDToolkit\data-dir.txt`（**刻意与数据目录平级**：放数据目录里会被"删除旧目录"一起删掉），
> 一行绝对路径、原子写（临时文件 + rename）。目标目录不存在 / 不是绝对路径 / 读失败 ⇒
> **回退默认目录并把原因带给界面（关于页红字），绝不在坏路径上新建空库**。
>
> ⚠️ **指针文件不带构建标识 ⇒ dev 构建与安装版共用同一份迁移记录**（2026-09-16 实测踩到：
> 用户装完构建产物后发现两边用同一个库 —— 在 dev 里迁到 `E:\test\DDToolkit-data`，安装版读到
> 同一条记录就跟了过去）。对**普通用户无影响**（只装一份安装版）；另外**卸载时 NSIS 不会删这个指针**。
> 收口方案（指针按构建分家 + 加"清除迁移记录"入口）记在 `docs/TODO.md` §1.4。

> ⚠️ 两条 PRAGMA（`auto_vacuum` / `VACUUM`）**不能在事务里执行** —— 维护代码走 DBAPI 的
> autocommit 连接，不套 SQLAlchemy 的隐式事务（`tests/test_db_maintenance.py` 用真库钉住）。

## 壳侧不变量

25. **删旧数据目录只认"一次性票据"**（2026-09-25，devlog/198）：`delete_old_data_dir` 收的是
    `migration_id` 而不是路径。迁移成功时 Rust 把 `{canonical_path, id}` 记在**内存**里
    （进程重启即失效 ⇒ 重启后删不了，只能手动删）；删除时按 id 查表、**重新 `canonicalize`**
    并严格等于记录，再依次拒绝：当前目录 / 当前目录的子孙 / 当前目录的祖先 / reparse 点 /
    "不像数据目录"（`vtuber.db` **且** 4 项特征里再命中 2 项 —— **合取，不是或**）；
    成功后立刻清票据（**防重放**）。界面上这一步**必须有二次确认**。
    ⚠️ **为什么这么严**：改造前的四道判据全部可绕 —— 裸 `PathBuf` 相等比不出 `..` / 大小写 /
    8.3 短名 / 尾随 `.`；`is_dir()` 跟随链接；特征是 `\|\|`（于是"任意含 `.env` 的目录"都能删）；
    全无链接检查。
    ⚠️ **两条实测事实**（本机 `mklink /J` 验证；`mklink /D` 需管理员特权而 **junction 不需要**，
    所以 junction 才是真实威胁的那一半）：① `canonicalize` 会**把 junction 解成目标** ⇒
    拿它当判据能识破"用 junction 冒充旧目录"；② `remove_dir_all(junction)` **不会穿进目标**
    （实测目标内容完好）⇒ 删链接本身不危险，真正的风险是①被绕过之后**直接删到活目录**。

29. **自定义命令的准入表默认拒绝**（S3-0，devlog/208）：`lib.rs::COMMAND_ACL` 逐条列出
    "这条命令允许哪些窗口 label"，**没登记 = 谁都不能调**；每条命令入口第一句是
    `if !guard_window(&window, "<自己的名字>") { … }`，拒绝时留痕（stdout +
    `<数据目录>/logs/shell.log`）。
    - ⚠️ **为什么必须自己判**：本应用的自定义命令**默认完全不查 ACL**
      （vendored `tauri-2.11.5/src/webview/mod.rs:1819-1852`）⇒ **只拆 capability JSON 一点用
      都没有**，命令自己判才是唯一有效的那一半。
    - ⚠️ **别按"这命令看起来该谁用"填**：2026-10-01 前这里分**两档**，第二档是**小窗**（运行时
      创建的窗口 —— 它能调的只有六条，且后三条是组件**自己**在调的：展开就 resize / 全屏隐藏 /
      穿透；填错就是把小窗点坏，devlog/175 的形态）。小窗整窗退役后两档**合并成一个
      `ALLOWED_CALLER = "main"`**（`devlog/270`）。
    - 判据（`cargo test`）：注册表 ↔ 准入表**双向对账**、每条命令都调了 guard（扫源码）、
      危险/动数据的命令 main-only、未知命令默认拒。

30. **外链只走 `open_external`，主机有白名单**（S3-B，devlog/208）：
    `lib.rs::external_url_host` 只认 `https`、主机必须**精确等于** `EXTERNAL_HOSTS` 里的一条
    （先转小写 —— 大写不算绕过，而 `bilibili.com.evil.com` / `bilibili.com.` / `%62ilibili.com`
    都不等）、拒 userinfo、拒端口、主机字符集只允许 `[a-z0-9.-]`。
    - ⚠️ **`shell:allow-open` 必须保持删除状态**：那条通路用的是插件内置正则
      `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+` —— **没有主机白名单、不拒 userinfo、
      末端无 `$`**（计划 §2.17 实测）。留着它 = 新命令只是"多了一条更严的路"。
    - ⚠️ **接新平台（抖音/小红书）时要同时加 `EXTERNAL_HOSTS`**：否则「打开主页」会失败 ——
      但**不会静默**（命令返回中文原因、前端 toast 出来）。
    - 前端**不复制那张表**（`shellBridge.openExternal` 只负责转发与抛出原因）：跨语言两份真源必漂。
    - ⚠️ capability 的**通配基线刻意保留**（`default.json` 的 `windows: ["*"]`）：**按 label 硬拆
      一旦猜错就是 devlog/175 那种"IPC 通道坏掉"**，而"显式 label 能否命中**运行时创建**的窗口"
      至今**没有验证过**（计划 §S3-A）—— 当年那个运行时窗口（小窗）已整窗退役（`devlog/270`），
      但这条结论对"将来再开运行时窗口"照样成立。主窗独有的两项（updater / process.restart）
      拆去了 `main.json`（主窗是静态 label，命中确定）；`shell:allow-open` 与
      `dialog:allow-open` 直接删掉。

    
> **31 号不变量已随小窗一起删除**（2026-10-03）：那一条讲的是"桌面小窗挂在宿主窗口下、靠子窗口
> 身份去掉 DWM 系统阴影"（`ensure_widget_host` / `SetParent` / 区域镜像 / 坐标口径）。用户当天决定
> **彻底放弃悬浮胶囊这条线**（成本远超收益，`devlog/274`），壳侧那整套（宿主窗口、区域穿透、外框自愈、
> 三条 widget 命令与准入表第二档）已全部删除，因此**这条不变量没有对象了**。
> 保留它的**唯一价值**是那份实测结论（如果哪天又要做"无系统阴影的自绘悬浮窗"）：
> DWM 只给顶层窗口画框；`SetParent` 成子窗口后阴影一点不剩且可逆；宿主配方里
> `LAYERED + LWA_ALPHA(1)` 会把整棵子树乘 1/255、`LAYERED + 色键` 会让子窗口收不到鼠标，
> 只有 `WS_EX_NOREDIRECTIONBITMAP | NOACTIVATE | TOOLWINDOW`（无背景刷）三者兼得。
> 细节与数字在 `devlog/272`（宿主方案）与 `devlog/273`（原生重建 N0 实测：ULW 路线无阴影、
> 按像素穿透、p95 16.6 ms、空闲 0 帧、工作集 8.4 MB）。

## 只能真机走的两个现场

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
