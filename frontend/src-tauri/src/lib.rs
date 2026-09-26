use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, State, WindowEvent};

/// 小窗被销毁时广播给前端的事件名（与 `frontend/src/utils/widgetWindow.ts` 的
/// `WIDGET_CLOSED_EVENT` **必须一致**）。定义在 Rust 侧是因为**两条销毁路径都在这里**
/// （设置开关 → `hide_widget_window`，小窗 Alt+F4 → `destroy_widget_window`），
/// 前端只负责听。
const WIDGET_CLOSED_EVENT: &str = "widget:closed";

/// 「正在创建小窗」的标志（重入保护）。
///
/// **为什么需要**（2026-09-24 第六轮真机反馈）：用户拖小窗时发现"原地残留了一个" ——
/// 日志显示 `show_widget_window` 被调了两次、建出两个窗口（重叠在一起，一拖就分开）。
/// 根因是前端 `main.tsx` 的 `React.StrictMode`：**开发模式下每个 effect 故意跑两次**
/// （挂载→卸载→再挂载），而那条"启动按偏好开小窗"的 effect 没有 cleanup。
///
/// 前端当然也要修（加幂等 + cleanup），但**命令本身不幂等**这件事更根本：
/// 任何重入（StrictMode / 快速双击 / 并发）都会建出第二个窗口，而窗口一旦建出来
/// 就不会自己消失。所以这里挡住。
static CREATING_WIDGET: AtomicBool = AtomicBool::new(false);

/// 小窗 URL 探针**只跑一次**（2026-09-25 加，用户反馈"日志里一堆报错"）。
///
/// 那个探针的使命是查明"页面到底有没有执行"（devlog/178~180）—— **已经完成了**。
/// 留着每次开窗都跑，只会在 WebView 未就绪时刷出 `failed to receive message from webview`，
/// 而那**不是故障、是正常时序**，长得却跟真错误一样。
static WIDGET_PROBED: AtomicBool = AtomicBool::new(false);

use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// 数据目录指针（R22-B2a，devlog/105）：`%APPDATA%\DDToolkit\data-dir.txt` 决定实际数据目录。
///
/// ⚠️ 目前**指针停用**（`resolve_data_dir(..., false)`）：迁移动作、以及"便携版怎么识别"
/// 都还没定（实测发现壳会无条件覆盖 `DDTOOLKIT_DATA_DIR`，所以现在没有"便携版"这个可判定的状态）。
/// 这一步先把"指针坏了必须回退默认目录、并且要把原因告诉界面"这套判定落地，并用用例钉住。
#[allow(dead_code)]
mod datadir;

/// 数据目录迁移的**核心逻辑**（R22-B2c，devlog/107）：规划 / 复制 / 逐文件校验。
///
/// ⚠️ 目前**尚未接线**（还没有"选目录 → 复制 → 切换指针 → 重启后端"这条命令）：
/// 这一版先把最容易弄丢数据的那部分（复制与校验）落地并用例钉住。
/// 接线与界面是下一步（要动 sidecar 启停，只能在真机上验收）。
#[allow(dead_code)]
mod migrate;

/// 壳侧文件日志（R22-B2e，devlog/112）：`<数据目录>\logs\shell.log`。
/// 打包版里 `println!` 等于没有输出 —— 迁移连着三次真机失败，每次都得靠后端日志反推壳走到了哪一步。
mod shelllog;

/// 测试临时目录的公共载体（devlog/134）：三处用例此前**只建不删**，
/// `%TEMP%` 里堆了 215 个残留目录 / 504MB。`TempRoot` 在 `Drop` 时自删。
#[cfg(test)]
mod testtmp;

// 启动计时基线（冷启动优化，见 devlog/021）：各阶段毫秒时间戳输出到终端
static T0: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

fn perf(step: &str) {
    let t0 = *T0.get_or_init(std::time::Instant::now);
    println!("[ddtoolkit][perf] {step} +{}ms", t0.elapsed().as_millis());
}

/// 后端进程句柄，退出时 kill 防止孤儿进程
struct BackendChild(Mutex<Option<CommandChild>>);

/// 后端监听端口，供前端经 get_backend_port 查询
struct BackendPort(Mutex<u16>);

/// 这次启动实际用的数据目录 + 来源（R22-B2b，devlog/106）。
/// 界面要能回答"我的数据到底在哪、为什么在那儿" —— 尤其是**回退过**的情况。
#[derive(Default)]
struct DataDirState(Mutex<Option<datadir::Startup>>);

/// 「上一次成功迁移留下哪份旧目录」的一次性授权票据（2026-09-25，devlog/198）。
///
/// **为什么需要它**：原先 `delete_old_data_dir(dir: String)` 直接收前端给的**原始路径**，
/// 只在四道判据上做检查，而这四道**全都可以绕过**（实测见 devlog/198）：
/// 裸 `PathBuf` 相等比较（`..` / 大小写 / 8.3 短名 / 尾随 `.` 都是"另一个字符串"）、
/// `is_dir()` 跟随链接、特征文件是 `||` 而不是合取。
/// ⇒ 传一个指向**当前数据目录**的 junction 或等价写法，就能让正在被 SQLite 使用的活目录
/// 进入 `remove_dir_all`。
///
/// 现在：迁移成功时把 `{canonical_path, id}` 记在这里，前端只拿得到 **id**；
/// 删除时按 id 查表、重新 canonicalize 并**严格等于**记录，成功后立刻清空（防重放）。
///
/// ⚠️ **故意只存在内存里**：进程重启后票据消失 ⇒ "迁移完但重启了"就删不了旧目录，
/// 用户需要手动删（会在界面上明说）。写进磁盘的代价是"多一份可被伪造的授权文件"，
/// 与这里要防的东西直接冲突。
#[derive(Default)]
struct MigrationRecord(Mutex<Option<MigrationStub>>);

#[derive(Clone)]
struct MigrationStub {
    /// 迁移前那个目录的**规范路径**（`canonicalize` 过，消掉 `..` / 大小写 / 8.3 短名）
    canonical: PathBuf,
    /// 给前端的一次性票据
    id: String,
}

/// 迁移源目录必须命中的 **DDToolkit 特征**（合取，至少 3 项）。
///
/// ⚠️ 原先是 `vtuber.db || .env` —— **任一命中即放行**，于是"任意含 `.env` 的目录"都能删。
/// 合取还要"至少 3 项"而不是"全部 4 项"：真实数据目录里 `vtubers.csv` 与 `logs/`
/// 可能分别缺失（用户删过 csv / 从没跑过写日志的路径），要求全部反而会挡下合法删除。
const MIGRATION_SOURCE_MARKERS: [&str; 4] = ["vtuber.db", "vtubers.csv", "logs", "static"];
const MIGRATION_SOURCE_MIN_MARKERS: usize = 3;

/// 票据里那个目录够不够像"一份 DDToolkit 数据目录"。
///
/// **必须是合取**：`vtuber.db` 是硬要求（没有它就不是数据目录），其余 3 项里再命中 2 项。
fn looks_like_data_dir(p: &std::path::Path) -> bool {
    if !p.join("vtuber.db").exists() {
        return false;
    }
    let hits = MIGRATION_SOURCE_MARKERS
        .iter()
        .filter(|m| p.join(m).exists())
        .count();
    hits >= MIGRATION_SOURCE_MIN_MARKERS
}

/// 生成一次性票据（16 字节随机 → 32 位十六进制）。
fn new_migration_id() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| format!("随机数生成失败：{e}"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

// ── 会话 token（S1，devlog/201）────────────────────────────────────────────
//
// 后端监听 127.0.0.1 上的**随机端口**，但端口可以扫（65536 个，几秒）。
// 在没有 token 之前，本机任何进程、以及任何网页（那时 CORS 默认 `*`）都能读到
// 全部归档、改数据、触发抓取；而数据目录的 `.env` 里是**活的登录凭据**。
//
// 这里的口径：**每次启动生成**（不复用、不落盘、不进 argv），经子进程 env 传给 sidecar；
// 前端要用的那一份走 `get_api_token` 命令（**并校验调用方窗口 label**，见那条命令的注释）。

/// 本次启动的 API token（只存内存）。
#[derive(Default)]
struct ApiToken(Mutex<String>);

/// 生成高熵 token。`getrandom::fill` 走操作系统 CSPRNG。
fn new_api_token() -> Result<String, String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| format!("随机数生成失败：{e}"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// 从"HTTP 响应正文"判定手动任务是否在跑 —— **纯函数，便于单测**。
///
/// 返回值三态，对应三种不同的处置（这是 S1 落地时最容易踩的地方）：
/// - `Ok(Some(true/false))`：真问到了；
/// - `Ok(None)`：**问不到**（非 200、或读到的东西不像响应）⇒ 调用方按"没在跑"处理
///   （用户点的是退出，不该因为问不到就退不出去）；
/// - `Err(401)`：**带了 token 却被拒** ⇒ 那是"这个壳与这个后端对不上"（比如旧壳配新后端），
///   不是"没有任务"。**必须保守当成"在跑"** —— 否则手动抓取会被静默掐掉一轮
///   （R20 花大力气修好的行为，devlog/095/097/129）。
///
/// 判定故意做得**粗**：去掉空白后找 `"manual_running":true`。uvicorn 可能回 chunked
/// （正文多出分块长度前缀），为这一处引入 HTTP 客户端或手写分块解码都不值当；
/// 字段名是我们自己的，够用且不会误判成 true。
fn manual_running_from_response(raw: &str) -> Result<Option<bool>, u16> {
    let status = raw.lines().next().unwrap_or("");
    let code = status
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok());
    match code {
        Some(200) => {
            let compact: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
            Ok(Some(compact.contains("\"manual_running\":true")))
        }
        Some(401) | Some(403) => Err(code.unwrap_or(401)),
        _ => Ok(None),
    }
}

/// 删旧数据目录的**全部判据**（拆成纯逻辑：只有它能被单测，命令壳只做状态读取）。
///
/// 顺序有意为之：**先认"是不是当前目录"，再谈特征文件** ——
/// 一个指向当前数据目录的 junction 会命中第一条，而不是靠"它里面确实有 vtuber.db"混过去。
fn prepare_old_dir_deletion(    id: &str,
    recorded: Option<&MigrationStub>,
    current: &std::path::Path,
) -> Result<PathBuf, String> {
    let Some(rec) = recorded else {
        return Err("没有待删除的旧数据目录（迁移记录不存在或已使用过；\
                    若应用重启过，请手动删除旧目录）"
            .to_string());
    };
    if rec.id != id {
        return Err("这次删除请求与迁移记录不匹配，已拒绝".to_string());
    }
    // 按票据指向的路径**重新**取规范路径（不信票据里那个字符串）
    let target = std::fs::canonicalize(&rec.canonical)
        .map_err(|e| format!("旧目录已不可访问（{}）：{e}", rec.canonical.display()))?;
    let cur_c = std::fs::canonicalize(current)
        .map_err(|e| format!("当前数据目录无法规范化：{e}"))?;
    if target == cur_c {
        return Err("这是当前正在使用的数据目录，不能删".to_string());
    }
    if target.starts_with(&cur_c) {
        return Err("这个目录在当前数据目录里面，不在可删除范围内".to_string());
    }
    if cur_c.starts_with(&target) {
        return Err("这个目录是当前数据目录的上级目录，不在可删除范围内".to_string());
    }
    // ⚠️ **必须在 canonicalize 之前判 reparse**：canonicalize 会把它解成目标，
    // 之后就再也看不出"这原本是个链接"了（实测：junction 与它目标的 canonicalize 完全相同）。
    match std::fs::symlink_metadata(&target) {
        Ok(md) if md.file_type().is_symlink() => {
            return Err("这个路径是符号链接/junction，拒绝删除（请手动处理）".to_string());
        }
        Ok(_) => {}
        Err(e) => return Err(format!("读不到目录属性：{e}")),
    }
    if !looks_like_data_dir(&target) {
        return Err(format!(
            "这个目录不像 ddtoolkit 数据目录（需要 vtuber.db，且 {} 里至少命中 {} 项），拒绝删除",
            MIGRATION_SOURCE_MARKERS.join(" / "),
            MIGRATION_SOURCE_MIN_MARKERS
        ));
    }
    Ok(target)
}


/// 托盘里那行「状态」菜单项的句柄（R29）：运行时改文案用它。
///
/// 为什么存句柄而不是每次去拿：`TrayIcon` **没有** `menu()` getter（只有 `set_menu`），
/// 所以"改一行字"这件事只能靠建菜单时留个引用。
struct TrayStatusItem(Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>);

/// 给界面的数据目录信息（`storage_info` 命令）
#[derive(serde::Serialize)]
struct DataDirInfo {
    dir: String,
    /// `env`（用户显式指定 = 便携/自定义）· `migrated`（应用内迁移过）· `default`
    source: String,
    /// 便携/自定义安装：界面**不给迁移入口**（整个文件夹一起搬才是便携的本意）
    portable: bool,
    /// 有迁移记录但用不了（已回退默认目录）：界面要提醒，不能静默
    pointer_unusable: Option<String>,
}

#[tauri::command]
fn storage_info(window: tauri::Window, state: State<'_, DataDirState>) -> DataDirInfo {
    if !guard_window(&window, "storage_info") {
        return DataDirInfo { dir: String::new(), source: "denied".to_string(), portable: false, pointer_unusable: None };
    }

    let guard = state.0.lock().unwrap();
    match guard.as_ref() {
        Some(s) => DataDirInfo {
            dir: s.dir.to_string_lossy().to_string(),
            source: s.source.as_str().to_string(),
            portable: s.portable,
            pointer_unusable: s.pointer_unusable.clone(),
        },
        None => DataDirInfo {
            dir: String::new(),
            source: "unknown".to_string(),
            portable: false,
            pointer_unusable: None,
        },
    }
}

// ── 数据目录迁移（R22-B2d，devlog/108）───────────────────────────────
//
// 这是 R22 里唯一"会动用户数据"的动作，所以流程写死成一条**可回滚**的线：
//
//   选目录 → 规划校验（migrate::plan_migration，有 7 条用例）
//        → 停后端 → 复制 → 逐文件校验
//        → 写指针 → 用新目录拉起后端 → **探活**
//        → 探活失败：回滚指针 + 用旧目录重启（**旧目录从头到尾没动过**）
//
// 三条不变式：① 旧目录全程不动（删除是事后单独一步、要用户确认）；
// ② 指针没写之前任何失败 = 什么都没发生；③ 探活成功才叫成功。

/// 后端是否已经能应答（迁移后**必须**探活成功才算成功）。
fn backend_healthy(port: u16) -> bool {
    use std::io::{Read, Write};
    if port == 0 {
        return false;
    }
    let Ok(addr) = format!("127.0.0.1:{port}").parse::<std::net::SocketAddr>() else {
        return false;
    };
    let Ok(mut sock) = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(400))
    else {
        return false;
    };
    let _ = sock.set_read_timeout(Some(Duration::from_millis(800)));
    if sock
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut raw = String::new();
    if sock.read_to_string(&mut raw).is_err() {
        return false;
    }
    raw.starts_with("HTTP/1.1 200") || raw.starts_with("HTTP/1.0 200")
}

/// 进程是否还活着（Windows：OpenProcess + GetExitCodeProcess）。
fn process_alive(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(h, &mut code);
            let _ = windows_sys::Win32::Foundation::CloseHandle(h);
            ok != 0 && code == STILL_ACTIVE
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
        false
    }
}

/// 停掉后端并等它**真的退出**、端口也让出来；返回它原来的端口（重启时尽量复用，前端不必重新引导）。
///
/// ⚠️ 两步缺一不可（R22-B2e，devlog/112）：
/// ① **等进程消失**：端口不再响应 ≠ 文件句柄已释放 —— 复制 `vtuber.db`/`-wal` 时
///    会撞上 Windows 的"另一个程序正在使用此文件"（`migrate::copy_tree` 现在也会重试兜底）；
/// ② **等端口让出来**：新进程要 bind 同一个端口。
fn stop_backend(app: &tauri::AppHandle) -> u16 {
    let port = *app.state::<BackendPort>().0.lock().unwrap();
    let mut pid = 0u32;
    if let Some(child) = app.state::<BackendChild>().0.lock().unwrap().take() {
        pid = child.pid();
        let _ = child.kill();
    }
    for _ in 0..50 {
        if pid == 0 || !process_alive(pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    for _ in 0..25 {
        if !backend_healthy(port) {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    port
}

/// 用指定数据目录拉起后端并等它就绪（最多 30s）。
fn start_backend_and_wait(
    app: &tauri::AppHandle,
    port: u16,
    dir: &std::path::Path,
) -> Result<(), String> {
    // 复用**同一个** token（迁移只换数据目录，不换会话）
    let api_token = app.state::<ApiToken>().0.lock().unwrap().clone();
    let child = spawn_backend(app, port, dir, &api_token).map_err(|e| format!("拉起后端失败：{e}"))?;
    let pid = child.pid();
    *app.state::<BackendChild>().0.lock().unwrap() = Some(child);
    #[cfg(target_os = "windows")]
    {
        let job = *app.state::<BackendJob>().0.lock().unwrap();
        if job != 0 {
            winjob::assign_process(job, pid);
        }
    }
    // 探活窗口：**不能贴着 `busy_timeout`（30s）** —— 真机实测（devlog/110）里新后端
    // 因为复制来的 `-shm` 等锁卡满 30s，而这里也恰好 30s，差几毫秒就判成失败。
    // 现在给到 60s，并在超时后**杀掉这个没起来的子进程**（否则它会继续占着库与端口）。
    for _ in 0..120 {
        if backend_healthy(port) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    if let Some(child) = app.state::<BackendChild>().0.lock().unwrap().take() {
        let _ = child.kill();
    }
    Err("后端 60 秒内没有就绪".to_string())
}

/// 迁移结果（给界面显示"搬了什么、旧目录在哪"）
#[derive(serde::Serialize)]
struct MigrateReport {
    data_dir: String,
    old_dir: String,
    files: usize,
    bytes: u64,
    skipped: Vec<String>,
    port: u16,
    /// 删旧目录要出示的一次性票据（devlog/198）。**前端只拿得到它，拿不到删除权**。
    migration_id: String,
}

/// 选一个目录并把数据迁过去（系统文件夹选择框，用户口径 2026-09-16）。
#[tauri::command]
async fn migrate_data_dir(window: tauri::Window, app: tauri::AppHandle) -> Result<MigrateReport, String> {
    if !guard_window(&window, "migrate_data_dir") {
        return Err("该窗口无权调用 migrate_data_dir".to_string());
    }

    use tauri_plugin_dialog::DialogExt;

    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Err("已取消选择目录".to_string());
    };
    let target = picked
        .into_path()
        .map_err(|e| format!("路径解析失败：{e}"))?;

    let (current, portable) = {
        // ⚠️ `app.state::<…>()` 是**临时值**：必须先用 let 绑定，否则借用在语句结束就被释放
        let state = app.state::<DataDirState>();
        let g = state.0.lock().unwrap();
        match g.as_ref() {
            Some(s) => (s.dir.clone(), s.portable),
            None => return Err("数据目录状态未知（壳还没完成启动？）".to_string()),
        }
    };
    // 便携/自定义安装（用环境变量指定目录）**不给迁移入口**，这里再兜一次底
    if portable {
        return Err("当前数据目录由 DDTOOLKIT_DATA_DIR 指定（便携/自定义安装），\
                    应用内不迁移 —— 直接把整个文件夹搬走即可"
            .to_string());
    }

    let plan = migrate::plan_migration(&current, &target)?;
    shelllog::log(&current, &format!(
        "迁移计划：源 {} → 目标 {}（{} 个文件 / {} 字节，跳过 {:?}）",
        plan.source.display(), plan.data_dir.display(), plan.files, plan.bytes, plan.skipped));

    let port = stop_backend(&app);
    shelllog::log(&current, &format!("已停后端（端口 {port}），开始复制"));
    let report = match migrate::copy_tree(&plan)
        .and_then(|r| migrate::verify_copy(&plan).map(|_| r))
    {
        Ok(r) => r,
        Err(why) => {
            // 复制/校验失败时**指针还没动**：把后端用旧目录拉回来就恢复原状
            shelllog::log(&current, &format!("复制/校验失败：{why} —— 回滚（指针未动）"));
            let _ = start_backend_and_wait(&app, port, &current);
            return Err(format!("{why}（已放弃迁移，数据目录没有改变）"));
        }
    };
    shelllog::log(&current, &format!(
        "复制并校验通过：{} 个文件 / {} 字节", report.files, report.bytes));

    let prev_pointer = datadir::read_pointer().ok().flatten();
    datadir::write_pointer(&plan.data_dir)?;
    shelllog::log(&current, &format!("已写指针 → {}，用新目录拉起后端", plan.data_dir.display()));
    if let Err(why) = start_backend_and_wait(&app, port, &plan.data_dir) {
        // 探活失败 ⇒ 回滚指针并用旧目录重启（旧目录里的数据一直没动过）
        shelllog::log(&current, &format!("新目录启动失败：{why} —— 回滚指针并用旧目录重启"));
        match &prev_pointer {
            Some(p) => {
                let _ = datadir::write_pointer(p);
            }
            None => {
                let _ = datadir::clear_pointer();
            }
        }
        let _ = start_backend_and_wait(&app, port, &current);
        return Err(format!("新目录启动失败：{why}（已回退到原目录）"));
    }
    shelllog::log(&current, &format!(
        "迁移完成：数据目录 = {}（旧目录仍保留在 {}，等用户确认后再删）",
        plan.data_dir.display(), current.display()));
    *app.state::<DataDirState>().0.lock().unwrap() = Some(datadir::Startup {
        dir: plan.data_dir.clone(),
        source: datadir::DirSource::Migrated,
        portable: false,
        pointer_unusable: None,
    });
    // 记下"哪份旧目录可以被删"的一次性票据（devlog/198）。
    // 规范路径在这里取：`current` 来自启动时的解析结果，可能带 `..` 或大小写差异。
    let migration_id = new_migration_id()?;
    let canonical = std::fs::canonicalize(&current).unwrap_or_else(|_| current.clone());
    *app.state::<MigrationRecord>().0.lock().unwrap() = Some(MigrationStub {
        canonical,
        id: migration_id.clone(),
    });
    println!(
        "[ddtoolkit] 数据目录已迁移：{} → {}（{} 个文件 / {} 字节，跳过 {:?}）",
        current.display(),
        plan.data_dir.display(),
        report.files,
        report.bytes,
        plan.skipped
    );
    Ok(MigrateReport {
        data_dir: plan.data_dir.to_string_lossy().to_string(),
        old_dir: current.to_string_lossy().to_string(),
        files: report.files,
        bytes: report.bytes,
        skipped: plan.skipped,
        port,
        migration_id,
    })
}

/// 用系统默认程序打开一个**路径或网址**（`ShellExecuteW`）。
///
/// ⚠️ 只给"路径由壳自己决定"的调用方用（发布页常量、数据目录状态）——**不要**把它
/// 包成一个"前端传什么就开什么"的命令：那等于把任意打开/执行的能力交给页面
/// （外链口径见批次 4ab，S2 的净化只管 HTML 边界）。
#[cfg(target_os = "windows")]
fn shell_open(target: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide: Vec<u16> = target.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let op: Vec<u16> = std::ffi::OsStr::new("open").encode_wide().chain(std::iter::once(0)).collect();
    // SAFETY: 三个参数都是以 NUL 结尾的宽字符串（或用 null）
    let rc = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW 的返回值 >32 才算成功（≤32 是错误码，见 Win32 文档）
    if rc as isize <= 32 {
        return Err(format!("打开失败（ShellExecuteW rc={}）", rc as isize));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn shell_open(_target: &std::path::Path) -> Result<(), String> {
    Err("只有 Windows 端支持用系统程序打开路径".to_string())
}

/// 在资源管理器里打开**数据目录**（批次 16，devlog/207）：迁移失败后"到这里找回"的出口。
///
/// ⚠️ 路径取自壳自己的解析结果（`DataDirState`），**不接受前端传路径** ⇒ 它不可能被
/// 用来打开任意目录。
#[tauri::command]
fn open_data_dir(window: tauri::Window, state: State<'_, DataDirState>) -> Result<String, String> {
    if !guard_window(&window, "open_data_dir") {
        return Err("该窗口无权调用 open_data_dir".to_string());
    }

    let dir = {
        let g = state.0.lock().unwrap();
        match g.as_ref() {
            Some(s) => s.dir.clone(),
            None => return Err("数据目录状态未知（壳还没完成启动？）".to_string()),
        }
    };
    shell_open(&dir)?;
    Ok(dir.to_string_lossy().to_string())
}

/// 打开发布页（R23b）：连不上 GitHub 时的兜底出口。
///
/// 为什么直接调 Windows API 而不是插件：前端没装 `@tauri-apps/plugin-shell` 的 JS 包；
/// `tauri-plugin-shell` 的 Rust `open()` 已标记废弃（官方让换 `tauri-plugin-opener`），
/// 而为了"打开一个固定网址"再引一个插件不值得 —— `ShellExecuteW` 就够，且 URL 是常量
/// （比"前端随便传 URL"安全）。
#[tauri::command]
fn open_release_page(window: tauri::Window, ) -> Result<(), String> {
    if !guard_window(&window, "open_release_page") {
        return Err("该窗口无权调用 open_release_page".to_string());
    }

    const URL: &str = "https://github.com/Mrslippe/DDToolkit/releases/latest";
    shell_open(std::path::Path::new(URL))
}

/// 探测"本地有没有代理在监听"（R23c，devlog/115）。
///
/// 为什么需要：`reqwest` 编译时带了 `system-proxy`，所以**系统代理模式**下更新器本来就走代理；
/// 但代理只配在浏览器/git 里、或系统代理开关关着时，应用会直连失败 —— 而用户明明有个能用的代理。
/// 这里按常见端口探一遍（TCP connect 即可，不打扰任何进程），失败路径上再重试一次。
fn probe_ports(ports: &[u16], timeout: Duration) -> Option<u16> {
    use std::net::{TcpStream, ToSocketAddrs};
    for port in ports {
        let addr = format!("127.0.0.1:{port}");
        let Ok(mut addrs) = addr.to_socket_addrs() else { continue };
        if let Some(sa) = addrs.next() {
            if TcpStream::connect_timeout(&sa, timeout).is_ok() {
                return Some(*port);
            }
        }
    }
    None
}

/// 常见本地代理端口（Clash 7890/7891/7897、v2rayN 10809、通用 1080/2080/8889）
const PROXY_PORTS: [u16; 7] = [7890, 7891, 7897, 10809, 1080, 2080, 8889];

/// 探测本地代理，返回 `http://127.0.0.1:<port>`（没探测到 = `None`）。
#[tauri::command]
fn probe_local_proxy(window: tauri::Window, ) -> Option<String> {
    if !guard_window(&window, "probe_local_proxy") {
        return None;
    }

    let found = probe_ports(&PROXY_PORTS, Duration::from_millis(150));
    match found {
        Some(port) => {
            println!("[ddtoolkit] 检测到本地代理 127.0.0.1:{port}");
            Some(format!("http://127.0.0.1:{port}"))
        }
        None => {
            println!("[ddtoolkit] 未检测到本地代理（常见端口都没有监听）");
            None
        }
    }
}

/// 把代理写进**本进程**的 `HTTPS_PROXY`/`HTTP_PROXY`，让 reqwest 之后的请求走它（R23c）。
///
/// ⚠️ `set_var` 不是线程安全的：这里只在"直连失败后重试一次"这一条窄路径上调用，
/// 且只影响**新构造**的 HTTP 客户端（reqwest 在建 client 时读环境变量）。
/// 不写注册表、不改系统设置 —— 对用户环境零副作用。
#[tauri::command]
fn set_process_proxy(window: tauri::Window, url: String) -> Result<(), String> {
    if !guard_window(&window, "set_process_proxy") {
        return Err("该窗口无权调用 set_process_proxy".to_string());
    }

    if !url.starts_with("http://127.0.0.1:") {
        return Err(format!("只接受本机 http 代理地址，实得 {url}"));
    }
    std::env::set_var("HTTPS_PROXY", &url);
    std::env::set_var("HTTP_PROXY", &url);
    println!("[ddtoolkit] 已为本进程设置代理 {url}（仅影响应用内请求）");
    Ok(())
}

fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0;
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    for entry in entries.flatten() {
        let p = entry.path();
        match std::fs::symlink_metadata(&p) {
            Ok(meta) if meta.is_dir() => total += dir_size(&p),
            Ok(meta) if meta.is_file() => total += meta.len(),
            _ => {}
        }
    }
    total
}

/// 删掉迁移前的旧数据目录（用户口径：**迁移成功后问一次**，不自动删）。
///
/// 2026-09-25（devlog/198）**改为收"一次性票据"而不是路径**，并补上五道判据。
/// 改造前的四道全部可绕过，最坏路径能删到正在使用的活目录（实测见 devlog §一）。
/// 判据本体在 `prepare_old_dir_deletion`（纯函数，单测覆盖）；这里只做状态读取与执行。
#[tauri::command]
fn delete_old_data_dir(window: tauri::Window, app: tauri::AppHandle, id: String) -> Result<u64, String> {
    if !guard_window(&window, "delete_old_data_dir") {
        return Err("该窗口无权调用 delete_old_data_dir".to_string());
    }

    let current = app
        .state::<DataDirState>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.dir.clone())
        .ok_or_else(|| "数据目录状态未知（壳还没完成启动？）".to_string())?;

    let recorded = app.state::<MigrationRecord>().0.lock().unwrap().clone();
    let path = prepare_old_dir_deletion(&id, recorded.as_ref(), &current)?;

    let freed = dir_size(&path);
    std::fs::remove_dir_all(&path).map_err(|e| format!("删除失败：{e}"))?;
    // 成功后立刻清掉票据 ⇒ 同一个 id 不能重放
    *app.state::<MigrationRecord>().0.lock().unwrap() = None;
    println!("[ddtoolkit] 已删除旧数据目录 {}（释放 {} 字节）", path.display(), freed);
    Ok(freed)
}

/// Job Object 句柄（KILL_ON_JOB_CLOSE），壳退出时内核杀光整个后端进程树。
/// 非 Windows 平台恒为 0，不参与逻辑。
struct BackendJob(Mutex<isize>);

// ── 托盘 / 隐藏 / 深休眠（R18，devlog/095）──────────────────────────────
//
// 用户口径：「关闭前端界面隐藏到系统托盘，后台抓取照样进行，但不用渲染前端」，
// 并且拍板了「首次点 ✕ 问一次、之后按选择记住」+「P1 与深休眠 P2 一起做」。
//
// 三个状态是这批的命门，写错任何一个都会变成"点了没反应"或"关不掉"：
// 1. `QUITTING`：托盘「退出」/前端确认退出时置真 → `CloseRequested` **不再拦截**。
//    忘了它 = 点了退出却只是隐藏。
// 2. `HIDDEN_SINCE`：隐藏时刻（0 = 当前可见）。深休眠线程据此判断"隐藏够久了吗"。
// 3. `DEEP_SLEPT`：WebView 已被销毁（省内存）。托盘点击据此决定"show 还是重建窗口"。
static QUITTING: AtomicBool = AtomicBool::new(false);
static HIDDEN_SINCE: AtomicU64 = AtomicU64::new(0);
/// 这扇窗口的圆角是**系统（DWM）画的**吗（R34，devlog/136）。
/// 前端据此决定用不用 CSS 圆角（`html.dwm-corners`）；Win10 上探测会失败 ⇒ 保持 false。
static DWM_CORNERS: AtomicBool = AtomicBool::new(false);

/// 「用不用系统圆角」的判据（**纯函数**，便于单测）：只看**圆角**那次调用的 HRESULT。
///
/// 为什么不看描边色那次：`DWMWA_BORDER_COLOR` 是"顺手去掉系统那 1px 描边"，
/// 它在较早的 Win11 build 上可能不支持（返回失败）—— 那不该连累圆角。
fn dwm_corners_ok(corner_hr: i32, border_hr: i32) -> bool {
    let _ = border_hr;
    corner_hr == 0
}

/// 让 **Windows 自己**画窗口圆角（R34，devlog/136）。
///
/// 为什么不再自己画：透明窗口 + CSS 圆角必然在弧上留下 1~3px 的抗锯齿混色
/// （用户报的"白边"与"角有点虚"都是它），而且"最大化/吸附时该不该方角"得我们自己判。
/// 交给 DWM 之后（2026-09-17 实测，devlog/136）：
/// - 浮动 ⇒ 系统圆角（~8px，平滑、无混色）；
/// - **吸附**（Win+← 等，实测窗口变成 (0,30)-(960,1080)）⇒ 四角**全方**、完全填满，
///   连屏幕中间那两个角也是方的 ⇒ 是整窗状态判定，我们一行都不用写；
/// - 最大化 ⇒ 方、填满。
/// 返回是否探测成功（= Win11 且 API 可用）；Win10 没有这个属性 ⇒ 返回 false，
/// 前端保留 CSS 圆角（`--radius-window` 的兜底值），不会变成"裸方角"。
#[cfg(target_os = "windows")]
fn apply_dwm_corners(window: &tauri::WebviewWindow) -> bool {
    use std::ffi::c_void;
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWCP_ROUND: i32 = 2; // 1=不圆 / 2=圆 / 3=小圆
    const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: isize,
            attr: u32,
            value: *const c_void,
            size: u32,
        ) -> i32;
    }

    let Ok(handle) = window.hwnd() else {
        return false;
    };
    let hwnd = handle.0 as isize;
    let corner = DWMWCP_ROUND;
    let border = DWMWA_COLOR_NONE;
    let (hr_corner, hr_border) = unsafe {
        (
            DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
                                  &corner as *const i32 as *const c_void, 4),
            DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR,
                                  &border as *const u32 as *const c_void, 4),
        )
    };
    let ok = dwm_corners_ok(hr_corner, hr_border);
    if ok {
        // 窗口形状变了：让 DWM 重算一次非客户区（不加这句有时不立即生效）
        const SWP_NOMOVE: u32 = 0x2;
        const SWP_NOSIZE: u32 = 0x1;
        const SWP_NOZORDER: u32 = 0x4;
        const SWP_FRAMECHANGED: u32 = 0x20;
        #[link(name = "user32")]
        extern "system" {
            fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32,
                            cx: i32, cy: i32, flags: u32) -> i32;
        }
        unsafe {
            SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                         SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
        }
    }
    DWM_CORNERS.store(ok, Ordering::SeqCst);
    ok
}

#[cfg(not(target_os = "windows"))]
fn apply_dwm_corners(_window: &tauri::WebviewWindow) -> bool {
    DWM_CORNERS.store(false, Ordering::SeqCst);
    false
}

/// 前端问"这扇窗口的圆角是系统画的吗"（R34）：true ⇒ 用系统圆角，CSS 半径归零。
#[tauri::command]
fn window_corners_mode(window: tauri::Window, ) -> bool {
    if !guard_window(&window, "window_corners_mode") {
        return false;
    }

    DWM_CORNERS.load(Ordering::SeqCst)
}

static DEEP_SLEPT: AtomicBool = AtomicBool::new(false);

/// 深休眠阈值：隐藏满这么久就销毁 WebView 释放内存（用户口径 10 分钟）。
/// 环境变量覆盖**只给测试用**（人工验收时用 20 秒就能验完整条链路）。
fn deep_sleep_after() -> Duration {
    let secs = std::env::var("DDTOOLKIT_TRAY_SLEEP_SECONDS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(600);
    if secs == 0 {
        Duration::from_secs(u64::MAX / 2) // 0 = 关闭深休眠
    } else {
        Duration::from_secs(secs)
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 隐藏窗口到托盘：hide + 从任务栏摘掉 + 告诉前端"停表"（它靠这个停止轮询与渲染）。
fn hide_to_tray_impl(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
        let _ = w.set_skip_taskbar(true);
    }
    HIDDEN_SINCE.store(now_ms(), Ordering::SeqCst);
    let _ = app.emit("shell:hidden", ());
    println!("[ddtoolkit] 已隐藏到托盘（后台抓取继续）");
}

/// 显示主窗口（托盘点击 / 二次启动）。若已被深休眠销毁，则**重建窗口**。
fn show_main_impl(app: &tauri::AppHandle) {
    HIDDEN_SINCE.store(0, Ordering::SeqCst);
    if DEEP_SLEPT.swap(false, Ordering::SeqCst) {
        match rebuild_main_window(app) {
            Ok(_) => println!("[ddtoolkit] 深休眠唤醒：已重建窗口"),
            Err(e) => println!("[ddtoolkit] 重建窗口失败：{e}"),
        }
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_skip_taskbar(false);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    let _ = app.emit("shell:shown", ());
}

/// 深休眠：销毁 WebView 释放内存（隐藏满 `deep_sleep_after()` 之后）。
/// 之所以真销毁而不是"导航到 about:blank"：只有窗口销毁才会让 WebView2 的
/// 渲染进程一起退出，内存才是真的还回去（导航到空白页只丢 DOM，进程还在）。
fn deep_sleep_impl(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.destroy();
    }
    DEEP_SLEPT.store(true, Ordering::SeqCst);
    println!("[ddtoolkit] 深休眠：已销毁界面释放内存（后台抓取不受影响）");
}

/// 重建主窗口。参数必须与 `tauri.conf.json` 里那份**等价**：
/// 无边框 / 透明 / 最小尺寸 / 居中 / 先隐藏（等前端调用 present_window 再显示，
/// 保持"白屏闪一下"那个既有修复）。
/// 恢复现场靠 URL 上的 `?restored=1`：前端读到标记后把路由与视图还原回去
/// （不能直接把深链接当 URL —— 资源协议下 SPA 深链接会 404）。
fn rebuild_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let w = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App("index.html?restored=1".into()),
    )
    .title("DDtoolkit")
    .inner_size(1440.0, 800.0)
    .min_inner_size(960.0, 600.0)
    .center()
    .decorations(false)
    .transparent(true)
    // 与 tauri.conf.json 那份**等价**（含四角白边的修复）：WebView 背景必须透明，
    // 否则 CSS 圆角的抗锯齿像素会跟白底混出白边（devlog/135）
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .visible(false)
    .skip_taskbar(false)
    .build()?;
    // 重建的窗口同样要按系统圆角（R34）：与 `setup()` 那条路径保持一致，
    // 否则深休眠唤醒之后圆角会变回"CSS 自绘"（用户会看到观感跳一下）
    apply_dwm_corners(&w);
    let _ = w.set_focus();
    Ok(w)
}

/// 把小窗的 **DWM 外框**摘干净（2026-09-24 第三轮真机反馈加）。
///
/// 这是本仓**自己记过**的一课：`setup()` 里给主窗口做那段 DWM 处理时写着
/// 「关 DWM 阴影/**边框描线（矩形轮廓的来源）**」—— 而那段代码写死了
/// `get_webview_window("main")`，**小窗完全没走**。于是小窗拿到的是 Windows 默认外框：
/// **一圈系统描边**（用户看到的"有边框"）+ DWM 给无边框透明窗口补的底色（"半透明"）。
///
/// 主窗口靠两件事摘掉它：`set_shadow(false)` + `apply_dwm_corners()`
/// （后者设 `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE`，正是"去掉描线"）。
/// 这里对小窗做同一套，另加 `DWMWCP_DONOTROUND` ——
/// 胶囊的圆角是 CSS 的 `999px`，系统的 ~8px 圆角会跟它打架（与主窗口同理）。
///
/// 失败只记日志、不报错：外框难看 ≠ 功能不可用，不该让窗口建不出来。
#[cfg(target_os = "windows")]
fn strip_dwm_frame_for_widget(w: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };
    let _ = w.set_shadow(false);
    // 描线 / 系统圆角（主窗口用的是同一个 `apply_dwm_corners`）
    let ok = apply_dwm_corners(w);
    let mut corner_ok = false;
    if let Ok(hwnd) = w.hwnd() {
        let pref = DWMWCP_DONOTROUND; // 3
        let hr = unsafe {
            DwmSetWindowAttribute(
                hwnd.0,
                DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                &pref as *const _ as *const core::ffi::c_void,
                4,
            )
        };
        corner_ok = hr == 0; // S_OK
    }
    println!(
        "[ddtoolkit] 小窗 DWM 外框处理：描线/圆角={} · 不圆角={}",
        if ok { "ok" } else { "失败" },
        if corner_ok { "ok" } else { "失败" }
    );
}

#[cfg(not(target_os = "windows"))]
fn strip_dwm_frame_for_widget(_w: &tauri::WebviewWindow) {}

/// 把小窗诊断**同时写进日志文件**（2026-09-24 第五轮）。
///
/// 为什么不能只 `println!`：用户是在 `npm run tauri:dev` 的控制台里看的，
/// **输出会滚、也不方便整段发给我** —— 上一轮他就只截到 `RunEvent::Ready +34ms`，
/// 而我加的探针在 +1500ms 才打印，于是"日志里什么都没有"变成了一个**假证据**
/// （我据此推断"命令没被调用"，差点走错方向）。
///
/// 写进数据目录的 `shell.log`（`shelllog` 那套），用户可以整份发过来、也不会丢帧。
fn widget_log(app: &tauri::AppHandle, msg: &str) {
    println!("[ddtoolkit] {msg}");
    let dir = app
        .state::<DataDirState>()
        .0
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.dir.clone()));
    if let Some(dir) = dir {
        shelllog::log(&dir, msg);
    }
}

/// 桌面状态控件（R38 批 5b，devlog/173）：创建或显示那个 200×40 的无边框小窗。
///
/// **位置由前端给** —— 规格 §7 说"位置持久化（`utils/shellState` 同款做法）"，
/// 也就是 localStorage 存、跨启动活着。这里只负责"按给的坐标摆好并显示"；
/// 传 `None` 时退到右下角留边（第一次开启的落点）。
///
/// 与主窗口的三点不同：**置顶**（`always_on_top`）、**不进任务栏**（`skip_taskbar`）、
/// **不可缩放**（它是个控件不是窗口）。透明 + 无边框与主窗口一致 ——
/// 桌面上要看见的是圆角胶囊，不是一块方板。
///
/// > ⚠️ **窗口创建的收尾必须同步**（2026-09-24 实测踩过）：`WebviewWindowBuilder` 里那些
/// > `set_*` 在**别的平台**上可能变成 `dispatch`，于是 `build()` 返回时窗口还带着默认外观
/// > （带边框、可缩放、不置顶）。所以要在**同一个同步块**里用 `w.set_*()` 把
/// > 装饰/缩放/置顶/任务栏再钉一遍 —— 这些是同步调用，一定在 `build()` 之后生效。
/// > 少了这一步，桌面上会出现一个**带标题栏的方窗**（那正是"透明背景小窗"的观感来源）。
/// ⚠️ **必须是 `async fn`**（2026-09-24 第六轮，可能是本 bug 的真凶）。
///
/// Tauri v2 里**同步命令跑在主线程**。而 `WebviewWindowBuilder::build()` 要创建第二个
/// WebView2 —— 它会和主线程的消息泵打交道。在**已有一个 webview** 的进程里于主线程
/// 同步建第二个，实测会**卡在这里**：日志停在"被调用"、UI 不再响应、
/// 托盘菜单点了也没用（全部现象见 devlog/175–179）。
///
/// 改成 `async fn` 之后 Tauri 会把它放到**异步运行时**（不是主线程）执行，
/// 消息泵就空出来了。代价：`WebviewWindow` 等类型不是 `Send`，跨 await 持有要小心 ——
/// 本函数内没有 await，所以是安全的。
#[tauri::command]
async fn show_widget_window(window: tauri::Window, app: tauri::AppHandle, x: Option<i32>, y: Option<i32>) -> Result<(), String> {
    if !guard_window(&window, "show_widget_window") {
        return Err("该窗口无权调用 show_widget_window".to_string());
    }

    // ⚠️ **入口就打印**（2026-09-24 第四轮补）：原来只在 `build()` **成功之后**才打印，
    // 于是"窗口创建失败"和"命令压根没被调用"在日志里**长得一模一样**（都是什么都没有）。
    // 这一行把两者分开 —— 没有它，下一次还是只能猜。
    widget_log(&app, &format!("show_widget_window 被调用 x={x:?} y={y:?}"));
    const W: f64 = 200.0;
    const H: f64 = 40.0;
    // ⚠️ **这里必须做"重入保护"**（2026-09-24 第六轮真机反馈）：
    // 用户拖小窗时发现"原地残留了一个"，日志显示 `show_widget_window` 被调了**两次**、
    // 建出了**两个窗口**（重叠在一起，一拖就分开）。根因是前端 `main.tsx` 的
    // `React.StrictMode` —— **开发模式下每个 effect 故意跑两次**（挂载→卸载→再挂载），
    // 而那条"启动时按偏好开小窗"的 effect 没有 cleanup。
    //
    // 只在前端修是不够的：命令本身不幂等，任何重入（StrictMode / 快速双击 / 并发）都会建两个。
    // 所以这里也要挡住 —— 正在建的时候再进来直接返回。
    if CREATING_WIDGET.swap(true, Ordering::SeqCst) {
        widget_log(&app, "已有一次创建在进行中 ⇒ 本次调用直接返回（重入保护）");
        return Ok(());
    }
    // 用一个 guard 保证任何 return 路径都会复位标志
    struct ResetOnDrop;
    impl Drop for ResetOnDrop {
        fn drop(&mut self) {
            CREATING_WIDGET.store(false, Ordering::SeqCst);
        }
    }
    let _guard = ResetOnDrop;

    // 已存在就只挪位置 + 显示：开关反复切换不该重建窗口（那会丢 webview 状态，
    // 也会让"关掉再打开"多花一次冷启动）
    if let Some(w) = app.get_webview_window("widget") {
        // ⚠️ **这条分支也必须留痕**（2026-09-24 第六轮）：原来它静默返回，
        // 于是日志里只有"被调用"、没有"已创建" —— 两种完全不同的原因
        //（"走提前返回" vs "build() 卡住"）在日志里**长得一模一样**。
        // 用户 17:14 那次就撞在这上面：我从"没有已创建"推出"build 卡住"，又一次推错方向。
        widget_log(&app, "小窗已存在（走提前返回：只挪位置 + show）");
        if let (Some(x), Some(y)) = (x, y) {
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
        let _ = w.show();
        return Ok(());
    }
    widget_log(&app, "小窗不存在，开始创建 …");
    let w = tauri::WebviewWindowBuilder::new(
        &app,
        "widget",
        tauri::WebviewUrl::App("widget.html".into()),
    )
    .title("DDtoolkit 状态控件")
    .inner_size(W, H)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .build()
    .map_err(|e| {
        // 创建失败必须**说清楚**，否则前端只会收到一个 false，用户看到的是"点了没反应"
        widget_log(&app, &format!("小窗创建失败：{e}"));
        e.to_string()
    })?;
    widget_log(&app, "小窗已创建（200×40 无边框置顶）");
    // ⚠️⚠️ **把这个窗口实际加载的地址打出来**（2026-09-24 第四轮）。
    //
    // 前三轮我改的都是**修饰**（启动幕 / 背景色 / `backdrop-filter` / DWM 外框），
    // 而用户每次看到的东西**一模一样** —— 直到确认"连自检条都没画出来"才明白：
    // **那个窗口里根本没有渲染我们的页面**，修饰一行都没机会执行。
    //
    // ⚠️ **这一轮不再猜，先把事实钉死 —— 双向探针**（2026-09-24 第四轮加的）：
    //   ① **Rust 侧读 URL**：不依赖页面，哪怕空白也读得到。
    //      URL 不对（join 拼歪 / 走了资源协议）⇒ 查 Rust 侧。
    //   ② **页面侧回传**（`widget_diag` 命令）：页面真的跑起来了才会发。
    //      **这条日志不出现 = 页面没执行**。
    //
    // ⚠️⚠️ **2026-09-25 收敛**（用户反馈"日志里一堆报错"）：
    // 原来无条件在 1.5s / 5s 各读一次 URL。实测在**窗口刚建好、WebView 还没就绪**时
    // `url()` 会返回 `runtime error: failed to receive message from webview` ——
    // **那是正常时序，不是故障**，但它在日志里长得跟真错误一模一样，
    // 攒了 19 条噪音（用户看到的就是这个）。
    //
    // 现在改成：
    //   · **只在第一次创建窗口时探一次**（`WIDGET_PROBED` 一次性开关）——
    //     它的使命（查明"页面到底有没有执行"）在 devlog/180 已经完成，不该每次开窗都跑；
    //   · **失败只记一次、且降级成明确的"时序说明"**，不再逐条刷 `读不到`；
    //   · 页面侧那条 `[widget] 页面自检` **照旧每次都发** —— 那才是现在真正有用的那半条
    //     （它同时带 URL 查询串、胶囊尺寸、条目数）。
    if !WIDGET_PROBED.swap(true, Ordering::SeqCst) {
        let probe = w.clone();
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(3000));
            match probe.url() {
                Ok(u) => widget_log(&app2, &format!("小窗 URL = {u}")),
                // 读不到**不是错误**：WebView 尚未就绪时就是这样（见上）。
                // 页面侧的自检日志才是权威。
                Err(_) => widget_log(
                    &app2,
                    "小窗 URL 一时读不到（WebView 未就绪，正常时序）—— \
                     以页面侧 `[widget] 页面自检` 那行为准",
                ),
            }
        });
    }
    // 同步钉一遍（理由见文档注释）：这些都是同步调用，`build()` 之后一定生效
    let _ = w.set_decorations(false);
    let _ = w.set_resizable(false);
    let _ = w.set_always_on_top(true);
    let _ = w.set_skip_taskbar(true);
    // ⚠️ **小窗必须自己摘 DWM 外框**（2026-09-24 第三轮真机反馈加）：
    // 主窗口在 `setup()` 里做了，而那段写死了 `get_webview_window("main")` —— 小窗没做，
    // 于是拿到 Windows 默认外框（一圈描边 + DWM 给无边框透明窗口补的底色）。
    strip_dwm_frame_for_widget(&w);
    // 尺寸也钉一遍：`inner_size` 在 builder 里同样可能被延迟应用
    let _ = w.set_size(tauri::LogicalSize::new(W, H));
    match (x, y) {
        (Some(x), Some(y)) => {
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
        _ => {
            // 没存过位置 ⇒ 落右下角（按缩放系数换算，留 24px 边、避开任务栏）
            if let Ok(Some(mon)) = w.current_monitor() {
                let sc = mon.scale_factor();
                let s = mon.size();
                let px = s.width as i32 - (W * sc) as i32 - (24.0 * sc) as i32;
                let py = s.height as i32 - (H * sc) as i32 - (72.0 * sc) as i32;
                let _ = w.set_position(tauri::PhysicalPosition::new(px, py));
            }
        }
    }
    Ok(())
}

/// 关掉桌面状态控件。**销毁而不是隐藏** —— 关掉开关就不该再留一个 webview；
/// 位置已经由前端存进 localStorage，下次开启会回到原处。
///
/// 幂等：窗口不在（本来就没开）也算成功。这个命令会从**两条路**被调到 ——
/// 主窗口的开关，以及小窗自己的退出兜底 —— 不幂等就会出现"第二次调用报错"。
///
/// 销毁后**广播 `widget:closed`** 给前端：主窗口据此把 `prefs.widget_enabled` 落成 `off`。
/// 不做的话用户按 Alt+F4 关掉小窗之后偏好还是 `on`，下次启动又开一个 —— 观感就是"关不掉"。
///
/// 同样改 `async fn`：`destroy()` 也会碰 WebView2 的消息泵，
/// 理由见 `show_widget_window` 那段注释（**同步命令跑在主线程 ⇒ 卡死**）。
#[tauri::command]
async fn hide_widget_window(window: tauri::Window, app: tauri::AppHandle) {
    if !guard_window(&window, "hide_widget_window") {
        return;
    }

    if let Some(w) = app.get_webview_window("widget") {
        let _ = w.destroy();
        let _ = app.emit(crate::WIDGET_CLOSED_EVENT, ());
    }
}

/// 小窗页面自检回传（R38 批 5b，2026-09-24 第四轮）。
///
/// **这是"页面到底有没有执行"的唯一硬证据**：小窗是 200×40 + 置顶 + 无边框，
/// 用户没法开 devtools；而前三轮我改的修饰（启动幕 / 背景 / `backdrop-filter` / DWM 外框）
/// 在真机上**一行都没生效**，我却一直在从截图里猜。
///
/// 页面跑起来就调它 → 控制台出现 `[widget] 页面自检 …`；
/// **如果这条日志从不出现，那就是"页面没执行"**，方向立刻转到 Rust / WebView 侧。
#[tauri::command]
fn widget_diag(window: tauri::Window, app: tauri::AppHandle, info: String) {
    if !guard_window(&window, "widget_diag") {
        return;
    }

    widget_log(&app, &format!("[widget] 页面自检 {info}"));
}

/// 窗口是否已经存在（给前端/排查用）。
///
/// 2026-09-24 第六轮加：`show_widget_window` 的"提前返回"分支以前不留痕，
/// 于是"窗口早就存在"与"窗口没建出来"在日志里**长得一模一样**。
/// 这条命令让前端可以在调用前后各问一次，把状态钉死。
#[tauri::command]
fn widget_window_exists(window: tauri::Window, app: tauri::AppHandle) -> bool {
    if !guard_window(&window, "widget_window_exists") {
        return false;
    }

    app.get_webview_window("widget").is_some()
}

// ── 小窗三项增强（R38 批 5d，2026-09-24）──────────────────────────────
//
// 三项都来自 LuckyIsland 的做法（README「参考与致谢」）。共同点：
// **它们都不是"看起来更好"，而是让小窗能被安静地摆在桌面上** ——
// 一个常驻的置顶控件如果会挡点击、会在你看全屏视频时冒出来，用户最后只能把它关掉。

/// 设置小窗的**鼠标穿透**（`click_through`，来自 LuckyIsland）。
///
/// ## 为什么常驻控件需要它
///
/// 小窗是 **200×40 · 置顶 · 无边框** 的常驻控件，默认会**吃掉它覆盖的那块区域的点击**。
/// 用户把它摆在右下角，那块地方恰好可能是别的程序的按钮 —— 于是小窗从"帮手"变成"路障"。
///
/// 穿透打开后，鼠标事件直接穿到下面的窗口；**代价是小窗自己也点不到了**，
/// 所以这是**用户主动打开的开关**（设置里那个），不是默认行为。想点它时先关掉穿透
/// （设置窗口在托盘菜单里，永远够得着 —— 这是这个开关**不会把人锁死**的原因）。
///
/// ## 为什么用自定义命令而不是前端的 `setIgnoreCursorEvents()`
///
/// `core:window:allow-set-ignore-cursor-events` **不在 `core:window:default` 里**
/// （已核 `tauri-2.11.5` 的 `permissions/window/autogenerated/reference.md`：
/// default 集只有 28 项，且全是查询类，不含它）。走前端就得再动 ACL ——
/// 而 **Tauri v2 里自定义命令不走 ACL**（本仓已在 `destroy_widget_window` 上踩过这个坑，
/// devlog/175），所以这里直接用命令，少一个会漂的配置点。
#[tauri::command]
async fn set_widget_click_through(window: tauri::Window, app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if !guard_window(&window, "set_widget_click_through") {
        return Err("该窗口无权调用 set_widget_click_through".to_string());
    }

    let Some(w) = app.get_webview_window("widget") else {
        // 幂等：小窗没开时设置穿透是无意义的**成功**，不该报错
        // （用户可能在没开小窗时就调了设置项）。
        return Ok(());
    };
    w.set_ignore_cursor_events(enabled).map_err(|e| {
        widget_log(&app, &format!("小窗设置鼠标穿透失败（enabled={enabled}）：{e}"));
        e.to_string()
    })?;
    widget_log(&app, &format!("小窗鼠标穿透 = {enabled}"));
    Ok(())
}

/// 查询当前是否有**全屏程序在跑**（`hide_in_fullscreen` 的判据，来自 LuckyIsland）。
///
/// ## 为什么不能只看"我们自己是不是全屏"
///
/// 小窗要躲的是**别人的**全屏 —— 用户全屏看视频 / 打游戏时，一个置顶控件压在画面上，
/// 观感是"删不掉的牛皮癣"。而小窗自己**永远不全屏**（200×40 固定），
/// 所以 `window.is_fullscreen()` 在这里恒为 false，**问了等于没问**。
///
/// ## 判据：`SHQueryUserNotificationState`
///
/// Windows 为"现在该不该弹通知"提供的官方接口（shell32），它已经把
/// "有全屏程序"这件事判好了（`QUNS_RUNNING_D3D_FULL_SCREEN` / `QUNS_PRESENTATION_MODE`
/// / `QUNS_BUSY`）。自己用 `GetForegroundWindow` + 窗口矩形比对屏幕来推是**不可靠的**
/// （多显示器、无边框全屏、UWP 都会误判），没必要重造。
///
/// 返回 `true` = **建议隐藏**（有全屏 / 演示 / 免打扰）。取不到状态时返回 `false`
/// —— **默认不隐藏**：宁可偶尔多露一下，也不要因为探测失败让小窗**永远不出现**
/// （那才是更难查的 bug）。
#[tauri::command]
fn is_fullscreen_app_running(window: tauri::Window, ) -> bool {
    if !guard_window(&window, "is_fullscreen_app_running") {
        return false;
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::Shell::{
            SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE,
            QUNS_RUNNING_D3D_FULL_SCREEN, QUERY_USER_NOTIFICATION_STATE,
        };
        let mut state: QUERY_USER_NOTIFICATION_STATE = 0;
        // SAFETY：`state` 是栈上的合法可写指针；该 API 只写这一个 out 参数。
        let hr = unsafe { SHQueryUserNotificationState(&mut state) };
        if hr < 0 {
            return false; // 拿不到状态：按"没有全屏"处理（见文档注释的取舍）
        }
        return state == QUNS_RUNNING_D3D_FULL_SCREEN
            || state == QUNS_PRESENTATION_MODE
            || state == QUNS_BUSY;
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 把小窗**改成任意矩形**（`resize` 通路，R38 批 5d）。
///
/// ## 为什么非有这条不可
///
/// 规格 §3 写了小窗展开是「**280 × 面板高**」，但窗口尺寸一直**写死 200×40**。
/// 后果是个**真 bug**：面板 `top = 胶囊底(40) + 6 = 46`，**在 40px 高的窗口外面**，
/// 宽度 280 也超出 200 ⇒ 小窗里那个通知面板**用户从来没看见过**
/// （实测 `可命中=False / 在视口内=False`）。
///
/// ## 为什么 `set_size` + `set_position` 要一起做
///
/// 光改尺寸的话，窗口以**左上角**为锚向外长 ⇒ 200→280 时右边缘窜出去 80px、
/// 胶囊在屏幕上**横向跳一下**。所以调用方（`widgetExpandGeom`）把新位置也算好了，
/// 这里两条一起下发，**顶边中心不动**。
///
/// ⚠️ 顺序：**先 `set_size` 再 `set_position`**。反过来的话，窗口会先在旧位置变大
/// （有一帧是"错位的、更大的窗口"），再被挪到位 —— 虽然只有一帧，但那是可见的窜动。
/// 先改尺寸、再归位，中间那一帧的问题只是"尺寸对了位置还差一点"。
///
/// 尺寸用**逻辑像素**（`LogicalSize` / `LogicalPosition`）：调用方算的是 CSS px，
/// 而本仓主窗口那条 resize 通路也是逻辑像素 —— 混用会在 125%/150% 缩放的屏幕上错位。
#[tauri::command]
async fn resize_widget_window(
    window: tauri::Window,
    app: tauri::AppHandle,
    w: f64,
    h: f64,
    x: i32,
    y: i32,
) -> Result<(), String> {
    if !guard_window(&window, "resize_widget_window") {
        return Err("该窗口无权调用 resize_widget_window".to_string());
    }

    let Some(win) = app.get_webview_window("widget") else {
        // 幂等：小窗没开时"调整它的尺寸"是无意义的成功（与另两条命令同款口径）
        return Ok(());
    };
    // 防御：调用方给 0 或负数会把窗口搞成不可见且拖不回来（无边框 + 不进任务栏 ⇒ 没有救回入口）
    if !(w.is_finite() && h.is_finite()) || w < 1.0 || h < 1.0 {
        return Err(format!("拒绝非法尺寸 {w}x{h}（会让小窗变成点不到的一条缝）"));
    }
    win.set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    win.set_position(tauri::LogicalPosition::new(x as f64, y as f64))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 按"是否有全屏程序"显示 / 隐藏小窗（**只动可见性，不销毁**）。
///
/// 与 `hide_widget_window` 的区别很重要：那条是**关掉小窗**（销毁 webview + 通知前端
/// 把偏好落成 `off`，用户主动关的）。这条只是**临时躲一下** —— 全屏结束要能立刻回来，
/// 所以绝不能走销毁路径（销毁了就得重建，而重建有成本：新建 WebView2 要几十毫秒，
/// 且位置要靠前端重新推）。用 `show` / `hide`，窗口一直活着。
///
/// 幂等 + 只在小窗**存在**时动作：小窗没开就什么都不做（成功）。
#[tauri::command]
async fn set_widget_visible(window: tauri::Window, app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    if !guard_window(&window, "set_widget_visible") {
        return Err("该窗口无权调用 set_widget_visible".to_string());
    }

    let Some(w) = app.get_webview_window("widget") else {
        return Ok(());
    };
    if visible {
        w.show().map_err(|e| e.to_string())?;
    } else {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 兜底：**把小窗的 webview 弄走**（Tauri v2 的 ACL 下命令不走 capability，所以这条一定可达）。
///
/// 2026-09-24 真机反馈：开了小窗之后主窗口点 ✕ / 最小化都没反应，托盘退出也杀不掉进程。
/// 根因在 `capabilities/default.json`（作用域只写了 `"main"` ⇒ 小窗一条窗口权限都没有，
/// `startDragging()` 抛错成未处理 rejection ⇒ IPC 通道坏掉，见 `widgetWindow.ts` 那段注释）。
/// 权限已修，但**已经中招的机器**还留着一个半死的小窗：小窗里 `getCurrentWindow().close()`
/// 同样要权限（一样会失败），所以**必须有一条不走 ACL 的路**。
///
/// 这里**只 destroy 小窗**（前端随后重拉主窗口可见性），不碰 `QUITTING`：
/// 它不该顺手把整个应用退出 —— 用户的诉求是"把那个小窗口弄掉"。
#[tauri::command]
async fn destroy_widget_window(window: tauri::Window, app: tauri::AppHandle) {
    if !guard_window(&window, "destroy_widget_window") {
        return;
    }

    if let Some(w) = app.get_webview_window("widget") {
        let _ = w.destroy();
        let _ = app.emit(crate::WIDGET_CLOSED_EVENT, ());
        widget_log(&app, "小窗被兜底命令销毁（label=widget）");
    }
}

/// 深休眠看门狗：每秒看一眼"隐藏够久了吗"。
/// 独立线程而不是 timer 回调：逻辑简单、退出时无需注销（进程结束就没了）。
/// 深休眠看门狗**下一次睡多久**（R24/T1，devlog/117）。
///
/// 原来是一个死循环里 `sleep(1s)`：**隐藏期间每秒醒一次**，笔记本上会一直把系统从低功耗
/// 状态拽起来（而这段时间本来什么都不用做）。现在按"离阈值还有多远"决定：
/// - 没在隐藏（`hidden_ms = 0`）：5 秒一次足够（隐藏动作本身会立刻置位，最多晚 5 秒发现）；
/// - 离阈值还远（> 60s）：30 秒一次；
/// - 快到点了（≤ 60s）：1 秒一次，保证"隐藏满 10 分钟"这一刻的精度。
///
/// 抽成纯函数是为了能直接量它（休眠节奏这种东西，出问题只表现为"费电"，界面上看不出来）。
fn watchdog_nap(hidden_ms: u64, threshold: Duration) -> Duration {
    if hidden_ms == 0 {
        return Duration::from_secs(5);
    }
    let remaining = threshold.saturating_sub(Duration::from_millis(hidden_ms));
    if remaining > Duration::from_secs(60) {
        Duration::from_secs(30)
    } else {
        Duration::from_secs(1)
    }
}

fn spawn_deep_sleep_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let since = HIDDEN_SINCE.load(Ordering::SeqCst);
        let hidden_ms = if since == 0 { 0 } else { now_ms().saturating_sub(since) };
        // 先睡再判：睡多久由"当前状态"决定（见 watchdog_nap 的说明）
        std::thread::sleep(watchdog_nap(hidden_ms, deep_sleep_after()));
        let since = HIDDEN_SINCE.load(Ordering::SeqCst);
        if since == 0 || QUITTING.load(Ordering::SeqCst) || DEEP_SLEPT.load(Ordering::SeqCst) {
            continue;
        }
        let hidden_for = Duration::from_millis(now_ms().saturating_sub(since));
        if hidden_for >= deep_sleep_after() {
            deep_sleep_impl(&app);
        }
    });
}

/// 问后端"有没有**手动**任务在跑"（只用于决定托盘「退出」要不要先确认）。
///
/// 返回 `None` = 没问到（后端没起来/超时）—— 调用方按"没在跑"处理：
/// **用户点的是退出，不该因为问不到就退不出去**（2026-09-15 实测的那个 bug 正是
/// "点了退出没反应"：原先托盘退出只发事件给前端，而前端没人接、深休眠时更收不到）。
///
/// ⚠️ S1 起要带 token（devlog/201）：这条探活是**手写裸 TCP**（为了一处判定不值得引 HTTP 客户端），
/// 而 token 中间件生效后它会拿到 401。**401 不能当成"没在跑"** —— 详见
/// `manual_running_from_response` 的三态说明。
fn backend_manual_running(port: u16, token: &str) -> Option<bool> {
    use std::io::{Read, Write};
    if port == 0 {
        return None;
    }
    let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().ok()?;
    let mut sock = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
    sock.set_read_timeout(Some(Duration::from_millis(800))).ok()?;
    // 头值是我们自己生成的十六进制，不含 CR/LF，拼进请求行是安全的
    let req = format!(
        "GET /vtuber/fetch-status HTTP/1.1\r\nHost: 127.0.0.1\r\n\
         X-DDToolkit-Token: {token}\r\nConnection: close\r\n\r\n"
    );
    sock.write_all(req.as_bytes()).ok()?;
    let mut raw = String::new();
    sock.read_to_string(&mut raw).ok()?;
    match manual_running_from_response(&raw) {
        Ok(v) => v,
        Err(401) => {
            println!("[ddtoolkit] 托盘退出：探活被 401 拒绝（token 不匹配）→ 保守判定为「有任务在跑」");
            Some(true)
        }
        Err(_) => None,
    }
}

/// 托盘「退出」：没手动任务在跑就**直接退**（不依赖前端）；在跑才唤回窗口让用户确认。
fn tray_quit_impl(app: &tauri::AppHandle) {
    let port = *app.state::<BackendPort>().0.lock().unwrap();
    let token = app.state::<ApiToken>().0.lock().unwrap().clone();
    match backend_manual_running(port, &token) {
        Some(true) => {
            println!("[ddtoolkit] 托盘退出：有手动任务在跑 → 唤回窗口确认");
            show_main_impl(app);
            let _ = app.emit("shell:quit-requested", ());
        }
        other => {
            println!("[ddtoolkit] 托盘退出：直接退出（手动任务在跑={other:?}）");
            QUITTING.store(true, Ordering::SeqCst);
            app.exit(0);
        }
    }
}

/// 建托盘：左键单击 = 显示主界面；菜单 = 显示主界面 / 后台运行中（禁用）/ 退出。
/// 托盘状态行的两行文案（菜单项 / tooltip）——纯函数，便于 `cargo test`。
///
/// `None` / 空串 / 全空白 = 恢复默认「后台运行中」（R29：风控冷却结束后前端传 None 复位）。
fn tray_status_texts(status: Option<&str>) -> (String, String) {
    let line = status
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("后台运行中");
    (line.to_string(), format!("DDtoolkit · {line}"))
}

/// 更新托盘的那行状态（R29，devlog/129）。
///
/// 为什么走托盘：后端把「风控冷却」做进了顶栏状态岛，但**收进托盘后没人看界面** ——
/// 用户既不知道被限流、也不知道该等多久。壳这边本来就有现成的落点（菜单项 `status`
/// 与 tray tooltip），改它**不需要任何新插件/依赖**。
///
/// 失败只写壳日志（`logs/shell.log`）：托盘文案是提示，不该影响任何功能。
#[tauri::command]
fn set_tray_status(window: tauri::Window, app: tauri::AppHandle, state: State<'_, DataDirState>,
                   item: State<'_, TrayStatusItem>, text: Option<String>) {
    if !guard_window(&window, "set_tray_status") {
        return;
    }

    let (line, tooltip) = tray_status_texts(text.as_deref());
    let dir = state.0.lock().unwrap().as_ref().map(|s| s.dir.clone());
    let log = |msg: String| {
        if let Some(d) = dir.as_deref() {
            shelllog::log(d, &msg);
        }
    };
    match app.tray_by_id("main-tray") {
        Some(tray) => {
            if let Err(e) = tray.set_tooltip(Some(tooltip.as_str())) {
                log(format!("set_tray_status: 设置 tooltip 失败 {e}"));
            }
        }
        None => log("set_tray_status: 找不到托盘（已忽略）".to_string()),
    }
    match item.0.lock().unwrap().as_ref() {
        Some(mi) => {
            if let Err(e) = mi.set_text(line.as_str()) {
                log(format!("set_tray_status: 设置菜单项失败 {e}"));
            }
        }
        None => log("set_tray_status: 菜单项句柄还没就绪（已忽略）".to_string()),
    }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("show", "显示主界面").build(app)?;
    let status = MenuItemBuilder::with_id("status", "后台运行中")
        .enabled(false)
        .build(app)?;
    // R29：把这一项的句柄存起来 —— 运行时改文案（`TrayIcon` 没有 menu() getter）
    if let Some(state) = app.try_state::<TrayStatusItem>() {
        *state.0.lock().unwrap() = Some(status.clone());
    }
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&status)
        .separator()
        .item(&quit)
        .build()?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("DDtoolkit · 后台运行中")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_impl(app),
            "quit" => tray_quit_impl(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_impl(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

#[tauri::command]
fn get_backend_port(window: tauri::Window, port: State<'_, BackendPort>) -> u16 {
    if !guard_window(&window, "get_backend_port") {
        return 0;
    }

    *port.0.lock().unwrap()
}

/// 把本次启动的会话 token 交给页面（S1，devlog/201）。
///
/// ## 为什么**必须**校验调用方窗口 label
///
/// Tauri 只在三种情况下查 ACL：插件命令、应用定义了自己的 ACL manifest、
/// 或请求来自**非本地** origin。本仓 `build.rs` 是裸 `tauri_build::build()`（无 app manifest），
/// 两扇窗又都是本地 origin ⇒ **应用自定义命令默认完全不查 ACL**
/// （证据：vendored `tauri-2.11.5/src/webview/mod.rs:1819-1852` 的那个 `if`）。
/// 也就是说：**只拆 capability JSON 对自定义命令一点用都没有**，
/// 命令自己判 label 才是唯一有效的那一半。
///
/// 当前允许 `main` 与 `widget`（两者都要发业务请求）。等 S3-A 收紧时，
/// 这张表会与 capability 文件一起收敛。
#[tauri::command]
fn get_api_token(window: tauri::Window, token: State<'_, ApiToken>) -> Result<String, String> {
    if !guard_window(&window, "get_api_token") {
        return Err("该窗口无权调用 get_api_token".to_string());
    }

    let label = window.label().to_string();
    if !CALLER_LABELS_ALLOWED.contains(&label.as_str()) {
        println!("[ddtoolkit] 拒绝 get_api_token：调用方窗口 label = {label}");
        return Err("该窗口无权获取访问令牌".to_string());
    }
    let t = token.0.lock().unwrap().clone();
    if t.is_empty() {
        // 空 token 会让前端把空头发出去 —— 那种"看起来配了其实没有"的状态最难查
        return Err("访问令牌尚未生成（壳还没完成启动？）".to_string());
    }
    Ok(t)
}

/// 允许读取会话 token 的窗口 label（`get_api_token` 的准入表）。
///
/// ⚠️ 2026-09-26（S3-0）起**并进 `COMMAND_ACL`**：一个类型（`BOTH`）、一处真源。
/// 判据也搬了过去（`command_acl_*` 那几条）—— 别再单独维护一份。
const CALLER_LABELS_ALLOWED: &[&str] = BOTH;

// ── 命令级准入表（S3-0，devlog/208）─────────────────────────────────────
//
// ⚠️ **为什么必须自己判 label**：本应用的自定义命令**默认完全不查 ACL**
// （证据：vendored `tauri-2.11.5/src/webview/mod.rs:1819-1852` 的那个 `if`；两扇窗都是
// 本地 origin）⇒ **只拆 capability JSON 一点用都没有**，命令自己判才是唯一有效的那一半。
//
// 口径：**默认拒绝** —— 没登记在这里的命令，任何窗口都调不了。
// 新增命令时必须在这里表态（有判据：`command_acl_matches_the_registered_handler`）。
//
// 判据清单见 `tests` 里的 `command_acl_*` / `every_command_guards_*` 四条；
// 反向验证：删掉一条 ⇒ 覆盖用例红；把危险命令改成 `BOTH` ⇒ 矩阵用例红。

/// 只有主窗口能调
const MAIN_ONLY: &[&str] = &["main"];
/// 两扇窗都要用（小窗也要发业务请求 / 管自己的窗口）
const BOTH: &[&str] = &["main", "widget"];

/// 每条自定义命令允许的调用方窗口 label。
///
/// ⚠️ **别按"这命令看起来该谁用"填** —— 小窗真的会调 `resize_widget_window` /
/// `set_widget_visible` / `set_widget_click_through`（`components/StatusWidgetWindow.tsx`
/// 里那三处 `await import('../utils/shellBridge')`），填错就是把小窗点坏
/// （devlog/175 的"IPC 通道坏掉"就是这么来的）。
const COMMAND_ACL: &[(&str, &[&str])] = &[
    // —— 两扇窗都用 ——
    ("get_backend_port", BOTH),
    ("get_api_token", CALLER_LABELS_ALLOWED),
    ("widget_diag", BOTH),
    ("resize_widget_window", BOTH),
    ("set_widget_visible", BOTH),
    ("set_widget_click_through", BOTH),
    // ⚠️ 这两条**曾经被我填成 MAIN_ONLY**（2026-09-26 真机复验抓到）：它们同样是
    // `StatusWidgetWindow` 在调的 —— 小窗自己的关闭请求（`onCloseRequested` → 销毁自己）
    // 与全屏隐藏逻辑。漏的原因见下方 `widget_reachable_commands_are_allowed` 那条判据的说明。
    ("destroy_widget_window", BOTH),
    ("is_fullscreen_app_running", BOTH),
    // —— 只有主窗口 ——
    ("present_window", MAIN_ONLY),
    ("hide_to_tray", MAIN_ONLY),
    ("quit_app", MAIN_ONLY),
    ("storage_info", MAIN_ONLY),
    ("open_data_dir", MAIN_ONLY),
    ("open_external", MAIN_ONLY),
    ("open_release_page", MAIN_ONLY),
    ("probe_local_proxy", MAIN_ONLY),
    ("set_process_proxy", MAIN_ONLY),
    ("window_corners_mode", MAIN_ONLY),
    // 数据目录迁移 / 删旧目录：**唯一两条不可逆或会动用户数据**的命令
    ("migrate_data_dir", MAIN_ONLY),
    ("delete_old_data_dir", MAIN_ONLY),
    ("set_tray_status", MAIN_ONLY),
    // 小窗的窗口管理（由主窗口的设置页/顶栏发起）
    ("show_widget_window", MAIN_ONLY),
    ("hide_widget_window", MAIN_ONLY),
    ("widget_window_exists", MAIN_ONLY),
];

/// 这条命令允不允许这个窗口调（表里查不到 ⇒ **拒绝**）。
fn command_allowed(command: &str, label: &str) -> bool {
    COMMAND_ACL
        .iter()
        .find(|(name, _)| *name == command)
        .is_some_and(|(_, labels)| labels.contains(&label))
}

/// 命令入口的准入检查。**拒绝时留痕**（stdout + `<数据目录>/logs/shell.log`）。
///
/// 为什么还要落 shell.log：release 版没有控制台，`println!` 会丢 ——
/// "某个窗口越权调了命令"这种事必须留得下来（否则就是静默失效）。
///
/// ⚠️ 用法（**每条命令的第一句**）：`if !guard_window(&window, "cmd_name") { return …; }`
/// —— 有判据扫源码钉住"每条命令都调了它"。
fn guard_window(window: &tauri::Window, command: &str) -> bool {
    let label = window.label();
    if command_allowed(command, label) {
        return true;
    }
    let msg = format!("拒绝 {command}：调用方窗口 label = {label}（不在准入表里）");
    println!("[ddtoolkit] {msg}");
    if let Ok(dir) = data_dir_of(window.app_handle()) {
        shelllog::log(&dir, &msg);
    }
    false
}

/// 取数据目录（给"留痕"用；拿不到就只打 stdout）。
fn data_dir_of(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let state = app.state::<DataDirState>();
    let g = state.0.lock().unwrap();
    g.as_ref()
        .map(|s| s.dir.clone())
        .ok_or_else(|| "数据目录状态未知".to_string())
}

// ── 外链白名单（S3-B，devlog/208）──────────────────────────────────────
//
// 现状问题（`ARCHITECTURE-IMPROVEMENT-EXECUTION.md` §2.17）：`plugin:shell|open` 用的是
// 插件内置正则 `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+` —— **无主机白名单**、
// 不拒 userinfo、末端无 `$` 锚点 ⇒ 今天任何 https 主机都能被打开。
// 换成自己的命令 + **严格白名单**：只 https、只这几个主机、拒 userinfo/端口/编码/点结尾。

/// 允许被"打开外部链接"的主机（**全小写、精确匹配**）。
///
/// ⚠️ 接入新平台（抖音/小红书）时要**同时**加这里 —— 否则"打开主页"会失败并提示原因
/// （前端会把原因显示出来，不静默）。这条纪律见 `docs/ARCHITECTURE.md` §6 第 29 条。
const EXTERNAL_HOSTS: &[&str] = &[
    "bilibili.com",
    "www.bilibili.com",
    "space.bilibili.com",
    "live.bilibili.com",
    "weibo.com",
    "www.weibo.com",
];

/// 校验一个外部 URL：**返回它的小写主机名**，或给用户看的原因。
///
/// 规则（每条都有用例，见 `tests` 里的 `external_url_*`）：
/// - 只 `https://`（`http:` / `file:` / 自定义 scheme / `javascript:` 一律拒）；
/// - 主机必须**精确等于**白名单里的一条（先转小写 ⇒ `BiLiBiLi.CoM` 合法，
///   而 `bilibili.com.evil.com` / `bilibili.com.` / `%62ilibili.com` 都不等 ⇒ 拒）；
/// - 拒 userinfo（`https://bilibili.com@evil.com/`）、拒端口（`:443`/`:8080`）；
/// - 主机字符集只允许 `[a-z0-9.-]` ⇒ 空格/控制符/`%`/`\`/unicode 同形字全被挡住；
/// - 允许路径与查询（`https://space.bilibili.com/123?x=1` 合法）。
fn external_url_host(url: &str) -> Result<String, String> {
    let raw = url.trim();
    if raw.is_empty() {
        return Err("链接是空的".to_string());
    }
    let rest = raw
        .strip_prefix("https://")
        .or_else(|| raw.strip_prefix("HTTPS://"))
        .ok_or_else(|| "只允许打开 https 链接".to_string())?;
    // authority = 到第一个 `/`、`?`、`#` 为止
    let end = rest
        .find(|c| c == '/' || c == '?' || c == '#')
        .unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() {
        return Err("链接里没有主机名".to_string());
    }
    if authority.contains('@') {
        return Err("链接里带了 userinfo（`@`），不接受".to_string());
    }
    if authority.contains(':') {
        return Err("链接里带了端口，不接受".to_string());
    }
    let host = authority.to_ascii_lowercase();
    if !host
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
    {
        return Err("主机名里有不接受的字符".to_string());
    }
    if !EXTERNAL_HOSTS.contains(&host.as_str()) {
        return Err(format!("这个主机不在允许打开的名单里：{host}"));
    }
    Ok(host)
}

/// 用系统默认浏览器打开一个**白名单内**的外部链接（S3-B）。
///
/// ⚠️ 只走这一个入口：`shell:allow-open` 已从 capability 里删掉（否则旧通路还在、
/// 两扇窗都能调，而那个通路**没有主机白名单**）。
#[tauri::command]
fn open_external(url: String, window: tauri::Window) -> Result<(), String> {
    if !guard_window(&window, "open_external") {
        return Err("该窗口无权打开外部链接".to_string());
    }
    let host = external_url_host(&url)?;
    println!("[ddtoolkit] 打开外部链接（{host}）");
    shell_open(std::path::Path::new(&url))
}

/// 显示主窗口。窗口默认 visible:false（见 tauri.conf.json），页面绘制完成后
/// 由前端 invoke 显示，避免 WebView2 首绘前的白屏（白色闪屏修复，见 devlog/021）。
/// show() 幂等：重复调用无副作用。
///
/// **系统圆角在这里设**（R34，devlog/136）：实测在 `setup()`（窗口还 `visible:false`）
/// 里设 `DWMWA_WINDOW_CORNER_PREFERENCE` **会被随后的显示流程冲掉**（角是方的），
/// 而窗口可见之后再设就生效 —— 所以挂在"显示"这个动作上，天然同时覆盖
/// 首次显示与深休眠唤醒后的重建（重建窗口也是加载完页面后走这里）。
#[tauri::command]
fn present_window(window: tauri::Window) {
    if !guard_window(&window, "present_window") {
        return;
    }

    let _ = window.show();
    if let Some(w) = window.app_handle().get_webview_window("main") {
        apply_dwm_corners(&w);
    }
}

/// 隐藏到托盘（前端点 ✕ 且偏好为「最小化到托盘」时调用）。
#[tauri::command]
fn hide_to_tray(window: tauri::Window, app: tauri::AppHandle) {
    if !guard_window(&window, "hide_to_tray") {
        return;
    }

    hide_to_tray_impl(&app);
}

/// 真退出：先置标志（否则 `CloseRequested` 又把它拦成"隐藏"），再退出。
/// 退出路径仍走 `RunEvent::Exit` —— 那里负责 kill 后端子进程。
#[tauri::command]
fn quit_app(window: tauri::Window, app: tauri::AppHandle) {
    if !guard_window(&window, "quit_app") {
        return;
    }

    QUITTING.store(true, Ordering::SeqCst);
    println!("[ddtoolkit] 用户确认退出");
    app.exit(0);
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("绑定空闲端口失败")
        .local_addr()
        .expect("读取端口失败")
        .port()
}

#[cfg(target_os = "windows")]
mod winjob {
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    // windows-sys 0.59 缺失这两个绑定的声明，按 kernel32 实际签名补齐
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(
            lpjobattributes: *const core::ffi::c_void,
            lpname: *const u16,
        ) -> HANDLE;
        fn SetInformationJobObject(
            hjob: HANDLE,
            jobobjectinformationclass: i32,
            lpjobobjectinformation: *const core::ffi::c_void,
            cbjobobjectinformationlength: u32,
        ) -> BOOL;
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

    /// 创建带 KILL_ON_JOB_CLOSE 的 Job：壳进程死亡瞬间内核终止全部成员
    /// （成员资格随子进程继承，可覆盖 PyInstaller onefile 脱离树的孙进程）
    pub fn create_kill_on_close_job() -> Option<isize> {
        unsafe {
            let job = CreateJobObjectW(ptr::null(), ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(job);
                return None;
            }
            Some(job as isize)
        }
    }

    /// 把已启动的进程收编进 Job（按 PID 打开，需 SET_QUOTA+TERMINATE 权限）
    pub fn assign_process(job_handle: isize, pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if h.is_null() {
                return false;
            }
            let ok = AssignProcessToJobObject(job_handle as _, h);
            CloseHandle(h);
            ok != 0
        }
    }
}

/// 启动后端并接管其输出流；返回子进程句柄。
/// - release：onedir 后端目录（Tauri resources 打包，免 onefile 解压开销）
/// - debug：直接跑 `python backend_main.py` —— 改后端零打包、日志直出终端
fn spawn_backend(
    app: &tauri::AppHandle,
    port: u16,
    data_dir: &std::path::Path,
    api_token: &str,
) -> Result<CommandChild, Box<dyn std::error::Error>> {
    let (mut rx, child) = {
        #[cfg(not(debug_assertions))]
        {
            // 多候选探测：resource_dir 与主程序同级的 binaries/backend 布局差异防御
            let mut candidates: Vec<std::path::PathBuf> = Vec::new();
            if let Ok(res) = app.path().resource_dir() {
                candidates.push(res.join("binaries").join("backend"));
            }
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    candidates.push(dir.join("binaries").join("backend"));
                    candidates.push(dir.to_path_buf());
                }
            }
            let backend_dir = candidates
                .iter()
                .find(|d| d.join("ddtoolkit-backend.exe").exists())
                .cloned()
                .ok_or("未找到后端目录 binaries/backend/ddtoolkit-backend.exe")?;
            println!("[ddtoolkit] backend dir = {}", backend_dir.display());
            app.shell()
                .command(backend_dir.join("ddtoolkit-backend.exe").to_string_lossy().to_string())
                .current_dir(&backend_dir)
                .env("DDTOOLKIT_PORT", port.to_string())
                .env("DDTOOLKIT_DATA_DIR", data_dir.to_string_lossy().to_string())
                .env("DDTOOLKIT_PARENT_PID", std::process::id().to_string())
                // S1（devlog/201）：本机后端的会话 token。只存内存、每次启动不同，
                // 前端要用的那一份走 `get_api_token` 命令。
                .env("DDTOOLKIT_API_TOKEN", api_token)
                // 强制子进程 UTF-8 输出（onedir 同样生效）
                .env("PYTHONUTF8", "1")
                .env("PYTHONIOENCODING", "utf-8")
                .spawn()?
        }
        #[cfg(debug_assertions)]
        {
            // 项目根 = src-tauri 上两级（backend_main.py 所在处）
            let project_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(2)
                .expect("定位项目根失败")
                .to_path_buf();
            println!(
                "[ddtoolkit] dev 模式：python backend_main.py（cwd={}）",
                project_root.display()
            );
            app.shell()
                .command("python")
                .args(["backend_main.py"])
                .current_dir(&project_root)
                .env("DDTOOLKIT_PORT", port.to_string())
                .env("DDTOOLKIT_DATA_DIR", data_dir.to_string_lossy().to_string())
                .env("DDTOOLKIT_PARENT_PID", std::process::id().to_string())
                // S1（devlog/201）：与 release 分支**同一个**注入点 —— 少一处就是
                // "开发态没有门、生产才有"，而那正是最难发现的不一致。
                .env("DDTOOLKIT_API_TOKEN", api_token)
                // 强制子进程 UTF-8 输出，避免管道模式下回退 GBK 导致终端乱码
                .env("PYTHONUTF8", "1")
                .env("PYTHONIOENCODING", "utf-8")
                .spawn()?
        }
    };
    let pid_for_log = child.pid();

    // 持续排空子进程输出（防止管道写阻塞后端 stdout）
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    if !text.trim().is_empty() {
                        print!("[backend] {text}");
                    }
                }
                CommandEvent::Stderr(line) => {
                    eprint!("[backend] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Terminated(payload) => {
                    println!("[ddtoolkit] backend terminated: {:?}", payload.code)
                }
                _ => {}
            }
        }
    });
    println!("[ddtoolkit] backend spawned (pid {pid_for_log})");
    Ok(child)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动：**唤回**已有窗口。R18 起不能只 set_focus ——
            // 窗口可能是隐藏的（在托盘里），甚至是深休眠被销毁过的，
            // 那样"点了没反应"就变成用户眼里的 bug。
            show_main_impl(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // 应用内更新（R23）：updater 负责"检查 + 下载 + 签名校验 + 安装"，
        // process 只用来在装完后重启自己（`relaunch()`）。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(BackendPort(Mutex::new(0)))
        .manage(BackendChild(Mutex::new(None)))
        .manage(BackendJob(Mutex::new(0)))
        .manage(DataDirState(Mutex::new(None)))
        .manage(MigrationRecord(Mutex::new(None)))
        .manage(ApiToken(Mutex::new(String::new())))
        .manage(TrayStatusItem(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            get_api_token,
            open_data_dir,
            open_external,
            present_window,
            hide_to_tray,
            quit_app,
            storage_info,
            migrate_data_dir,
            delete_old_data_dir,
            set_tray_status,
            open_release_page,
            probe_local_proxy,
            set_process_proxy,
            window_corners_mode,
            show_widget_window,
            hide_widget_window,
            destroy_widget_window,
            widget_diag,
            widget_window_exists,
            set_widget_click_through,
            is_fullscreen_app_running,
            set_widget_visible,
            resize_widget_window
        ])
        .on_window_event(|window, event| {
            // ✕ 不再等于"退出"（R18，devlog/095）：关闭请求被拦下，改成隐藏到托盘，
            // 后台抓取照常。真正的退出只有两条路：托盘「退出」→ 前端确认 → `quit_app`，
            // 或系统注销/关机（那种情况下 `QUITTING` 不置真，但 `WindowEvent::Destroyed`
            // 之后 Tauri 仍会走 ExitRequested → 退出）。
            if let WindowEvent::CloseRequested { api, .. } = event {
                // ⚠️ **只拦主窗口**（R38 批 5b）：桌面控件小窗的 `close()` 是"关掉开关"的
                // 正常路径，拦下来会变成"顺手把**主窗口**藏进托盘" —— 而用户压根没点过它。
                // 这条判断在只有一个窗口时是多余的，加了第二个窗口之后就是必需的。
                if window.label() == "main" && !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    hide_to_tray_impl(window.app_handle());
                }
            }
        })
        .setup(|app| {
            perf("setup 开始");

            // 四角白边（2026-09-17，devlog/135）：`transparent(true)` 只让**窗口**透明，
            // WebView 自己的背景仍是**白色** —— CSS 那 4px 圆角的抗锯齿像素会跟它混出 1~2px 白边
            // （实测量到的正是"底色往白混"：rail `#4B5A6F` → 边缘 `#727B8A`；
            //   先把 DWM 的圆角/描边关掉复测，数值一字不变 ⇒ 与 DWM 无关）。
            // `set_background_color` 会**同时**设窗口与 WebView 两层（Tauri 2.11），
            // 这一步在窗口 show 之前跑（`visible: false`，等前端 present_window），看不到闪烁。
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                // ⚠️ 系统圆角**不在这里设**：窗口还是 visible:false，实测设了会被
                // 随后的显示流程冲掉（角变回方的）。改在 `present_window`（显示之后）设。
            }

            let port = free_port();
            // S1（devlog/201）：**每次启动生成一个 token**，注入 sidecar，并存进壳状态
            // 供 `get_api_token` 命令读取。只存内存：重启即换新（前端也重新取）。
            let api_token = new_api_token()?;
            *app.state::<ApiToken>().0.lock().unwrap() = api_token.clone();
            println!(
                "[ddtoolkit] api token 已生成（长度 {}，值不打印）",
                api_token.len()
            );
            // ── 数据目录的**启动优先级**（R22-B2b，devlog/106）────────────────
            // 环境变量 > 迁移指针 > 默认目录（判定本身在 `datadir::resolve_startup`，有单测）。
            // 之前这里是无条件用 `app_data_dir()` 覆盖 `DDTOOLKIT_DATA_DIR`，
            // 于是 README 里"便携版可改这个变量自定义"是假的（实测见 devlog/105）。
            let base_dir = app.path().app_data_dir()?;
            // dev 构建使用独立数据目录，避免调试抓取/登录写进「生产」数据。
            // ⚠️ 只改**默认**目录：用户显式指定的（环境变量/迁移指针）不该被加后缀。
            // ⚠️ 用 `cfg` 分支表达式而不是 `let mut` + 赋值：release 构建里那段不参与编译，
            //    `mut` 会变成"不需要的可变"警告（2026-09-16 出正式包时实测到）。
            let default_dir = {
                #[cfg(debug_assertions)]
                {
                    base_dir.with_file_name(format!(
                        "{}-dev",
                        base_dir.file_name().unwrap_or_default().to_string_lossy()
                    ))
                }
                #[cfg(not(debug_assertions))]
                {
                    base_dir
                }
            };
            let env_dir = std::env::var_os("DDTOOLKIT_DATA_DIR")
                .map(std::path::PathBuf::from)
                .filter(|p| p.is_absolute());
            let startup = datadir::resolve_startup(env_dir, datadir::read_pointer(), default_dir);
            if let Some(why) = startup.pointer_unusable.as_deref() {
                println!("[ddtoolkit] WARN: 数据目录指针不可用，已回退默认目录：{why}");
            }
            println!("[ddtoolkit] data dir = {}（来源 {}）",
                     startup.dir.display(), startup.source.as_str());
            // 圆角走系统还是 CSS 是"用户看得见但只在真机上才暴露"的差异，
            // 打包版没有 stdout ⇒ 落一行壳日志（排查时一眼能看出这台机器走的是哪条路）
            shelllog::log(&startup.dir, &format!(
                "DWM 系统圆角 = {}", DWM_CORNERS.load(Ordering::SeqCst)));
            shelllog::log(&startup.dir, &format!(
                "启动：数据目录 = {}（来源 {}）· 便携={} · 指针问题={:?}",
                startup.dir.display(), startup.source.as_str(),
                startup.portable, startup.pointer_unusable));
            *app.state::<DataDirState>().0.lock().unwrap() = Some(startup.clone());
            let data_dir = startup.dir;
            std::fs::create_dir_all(&data_dir)?;
            println!("[ddtoolkit] data dir = {}", data_dir.display());
            println!("[ddtoolkit] backend port = {}", port);

            *app.state::<BackendPort>().0.lock().unwrap() = port;

            #[cfg(target_os = "windows")]
            match winjob::create_kill_on_close_job() {
                Some(h) => {
                    *app.state::<BackendJob>().0.lock().unwrap() = h;
                    println!("[ddtoolkit] Kill-On-Close Job Object 就绪");
                }
                None => println!("[ddtoolkit] WARN: Job Object 创建失败，仅剩双兜底"),
            }

            let child = spawn_backend(app.handle(), port, &data_dir, &api_token)?;
            let backend_pid = child.pid();
            perf("后端已 spawn");

            #[cfg(target_os = "windows")]
            {
                let job = *app.state::<BackendJob>().0.lock().unwrap();
                if job != 0 && winjob::assign_process(job, backend_pid) {
                    println!("[ddtoolkit] backend(pid {backend_pid}) 已收编进 Job");
                } else {
                    println!("[ddtoolkit] WARN: backend 未进入 Job");
                }
            }

            *app.state::<BackendChild>().0.lock().unwrap() = Some(child);

            // 窗口轮廓统一交给前端 CSS 圆角：
            // 1) 关 DWM 阴影/边框描线（矩形轮廓的来源）
            // 2) 关 Win11 系统圆角（~8px，与前端 12px 双弧线打架）
            #[cfg(target_os = "windows")]
            {
                use windows_sys::Win32::Graphics::Dwm::{
                    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
                    DWMWCP_DONOTROUND,
                };
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_shadow(false);
                    if let Ok(hwnd) = w.hwnd() {
                        let pref = DWMWCP_DONOTROUND; // 3
                        unsafe {
                            DwmSetWindowAttribute(
                                hwnd.0,
                                DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                                &pref as *const _ as *const core::ffi::c_void,
                                4,
                            );
                        }
                    }
                }
            }

            // 窗口以 visible:true 创建（见 tauri.conf.json）：静态粉幕随 WebView
            // 首绘即显示，不再依赖 JS show() 链路，故原 8 秒兜底显示线程已删除。
            //
            // R18：托盘与深休眠看门狗（用户口径「关闭 = 隐藏到托盘，后台照抓」）
            if let Err(e) = build_tray(app.handle()) {
                // 托盘建不起来（极少数环境）不能让应用起不来：照旧可用，只是点 ✕
                // 会走"隐藏但没法唤回"——所以这里必须留痕，别静默。
                println!("[ddtoolkit] 托盘创建失败：{e}");
            } else {
                println!("[ddtoolkit] 托盘就绪（左键显示 / 菜单可退出）");
            }
            spawn_deep_sleep_watchdog(app.handle().clone());
            perf("setup 完成");

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 初始化失败")
        .run(|app_handle, event| {
            // 诊断：记录退出路径（点 VTuber 后窗口消失——定位是窗口销毁/退出请求/宿主请求）
            match &event {
                RunEvent::Ready => {
                    println!("[ddtoolkit] RunEvent::Ready");
                    perf("RunEvent::Ready")
                }
                RunEvent::ExitRequested { code, api, .. } => {
                    // R18（devlog/095）：**窗口全关 ≠ 退出应用**。托盘还在，后台抓取还要继续，
                    // 所以非主动退出（没置 `QUITTING`）时把退出请求拦下来 ——
                    // 否则"点 ✕ 隐藏"会连应用一起带走（那正是改造前的行为）。
                    // ⚠️ 深休眠销毁 WebView 也会走到这里，所以这一条是**必须**的。
                    if !QUITTING.load(Ordering::SeqCst) {
                        println!("[ddtoolkit] RunEvent::ExitRequested code={code:?} → 拦下（托盘常驻）");
                        api.prevent_exit();
                    } else {
                        println!("[ddtoolkit] RunEvent::ExitRequested code={code:?} → 放行（用户确认退出）");
                    }
                }
                RunEvent::Exit => println!("[ddtoolkit] RunEvent::Exit"),
                RunEvent::WindowEvent { label, event: ev, .. } => match ev {
                    tauri::WindowEvent::CloseRequested { .. } => {
                        println!("[ddtoolkit] WindowEvent[{label}] CloseRequested")
                    }
                    tauri::WindowEvent::Destroyed => {
                        println!("[ddtoolkit] WindowEvent[{label}] Destroyed")
                    }
                    _ => {}
                },
                _ => {}
            }
            if let RunEvent::Exit = event {
                if let Some(child) =
                    app_handle.state::<BackendChild>().0.lock().unwrap().take()
                {
                    #[cfg(target_os = "windows")]
                    {
                        use std::os::windows::process::CommandExt;
                        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

                        // 先探活：Job Object 通常已瞬间清理整棵进程树，
                        // 此时 taskkill 只会报「没有找到进程」——直接跳过
                        fn alive(pid: u32) -> bool {
                            unsafe {
                                let h = windows_sys::Win32::System::Threading::OpenProcess(
                                    windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION,
                                    0,
                                    pid,
                                );
                                if h.is_null() {
                                    return false;
                                }
                                let mut code: u32 = 0;
                                let ok = windows_sys::Win32::System::Threading::GetExitCodeProcess(
                                    h, &mut code,
                                );
                                windows_sys::Win32::Foundation::CloseHandle(h);
                                ok != 0 && code == 259 // STILL_ACTIVE
                            }
                        }

                        let pid = child.pid();
                        if !alive(pid) {
                            println!("[ddtoolkit] backend already exited (job cleanup)");
                        } else {
                            // 兜底强杀进程树；只记录结果不回显系统本地化 stderr（避免 GBK 乱码）
                            let ok = std::process::Command::new("taskkill")
                                .args(["/PID", &pid.to_string(), "/T", "/F"])
                                .creation_flags(CREATE_NO_WINDOW)
                                .status()
                                .map(|s| s.success())
                                .unwrap_or(false);
                            println!(
                                "[ddtoolkit] backend tree {} (pid {pid})",
                                if ok { "terminated" } else { "terminate FAILED" },
                            );
                        }
                    }
                    println!("[ddtoolkit] exit cleanup done");
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **系统圆角的能力探测判据**（R34，devlog/136）：只看圆角那次调用的 HRESULT。
    /// 判错的代价很直观 —— 把"不支持"当"支持"⇒ Win10 用户拿到一扇**裸方角**窗口
    /// （CSS 半径被归零、系统又不画）；把"支持"当"不支持"⇒ 只是没吃到系统圆角，无害。
    #[test]
    fn dwm_corners_ok_is_decided_by_the_corner_hresult_only() {
        assert!(dwm_corners_ok(0, 0), "两次都成功 ⇒ 用系统圆角");
        assert!(
            dwm_corners_ok(0, -2147024809),
            "描边色不支持（较早的 Win11 build）不该连累圆角 —— 圆角那次成功就算成功"
        );
        assert!(
            !dwm_corners_ok(-2147024809, 0),
            "圆角那次失败（Win10 没有这个属性）⇒ 必须回退 CSS 圆角"
        );
        assert!(!dwm_corners_ok(-2147024809, -2147024809), "两次都失败 ⇒ 回退");
    }

    /// **代理探测**（R23c）：起一个真的本地监听，确认能探到、且探不到时返回 None。
    /// 判错的代价：把「没有代理」当成有 ⇒ 更新检查被导向一个死地址；反之则错过能用的代理。
    #[test]
    fn probe_ports_finds_a_listening_port_and_misses_the_others() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("起本地监听");
        let port = listener.local_addr().unwrap().port();
        // 探到在监听的那个（顺序在后面的也要能探到）
        assert_eq!(probe_ports(&[port], Duration::from_millis(150)), Some(port));
        assert_eq!(
            probe_ports(&[port], Duration::from_millis(150)),
            Some(port),
            "同一个端口重复探测结果应当稳定"
        );
        // 一个**几乎不可能有人监听**的端口：探不到就是 None（不能瞎猜成"有代理"）
        assert_eq!(probe_ports(&[9], Duration::from_millis(50)), None);
    }

    /// **托盘状态行文案**（R29）：冷却中显示冷却文案，其余情况一律回到默认。
    /// 判错的代价是"冷却早结束了、托盘还挂着限流提示"（用户以为一直没恢复）。
    #[test]
    fn tray_status_texts_defaults_and_overrides() {
        assert_eq!(
            tray_status_texts(None),
            ("后台运行中".to_string(), "DDtoolkit · 后台运行中".to_string())
        );
        // 空串 / 全空白都当"没有状态"（前端复位时可能传空串）
        assert_eq!(tray_status_texts(Some("   ")).0, "后台运行中");
        let (line, tooltip) = tray_status_texts(Some(" 风控冷却中 · 剩余 8 分钟 "));
        assert_eq!(line, "风控冷却中 · 剩余 8 分钟"); // 两端空白裁掉
        assert_eq!(tooltip, "DDtoolkit · 风控冷却中 · 剩余 8 分钟");
    }

    /// **深休眠看门狗的休眠节奏**（R24/T1）：原来每秒醒一次（隐藏期间也醒），
    /// 笔记本上会一直把系统从低功耗状态拽起来。判据：没隐藏 5s · 离阈值 >60s 用 30s ·
    /// 快到点（≤60s）才 1s（这一段要保证"隐藏满 10 分钟"的精度）。
    #[test]
    fn watchdog_nap_backs_off_when_nothing_to_do() {
        let th = Duration::from_secs(600);
        assert_eq!(watchdog_nap(0, th), Duration::from_secs(5), "没隐藏：5 秒足够");
        assert_eq!(watchdog_nap(60_000, th), Duration::from_secs(30), "还早：30 秒一次");
        assert_eq!(watchdog_nap(590_000, th), Duration::from_secs(1), "快到了：1 秒一次");
        // 已经超过阈值也要返回 1 秒（下一轮就该动手，别睡太久）
        assert_eq!(watchdog_nap(900_000, th), Duration::from_secs(1));
    }

    /// 托盘退出那条判据的**解析部分**（`cargo test` 跑）。
    ///
    /// 判错的代价（2026-09-15 实测的 bug）：托盘「退出」点了没反应 —— 根因是它只发了一个
    /// 事件给前端，而前端没人接、深休眠时更收不到。现在"没手动任务在跑就直接退"，
    /// 于是"到底在不在跑"的判断必须可靠：**问不到（后端挂了/非 200/端口 0）要当成"没在跑"**
    /// （用户点的是退出，不能因为问不到就退不出去），但不能把"在跑"误判成"没在跑"
    /// （那会在用户毫不知情时掐掉一轮抓取）。
    fn parse(body: &str) -> Option<bool> {
        // `manual_running_from_response` 要求首行是状态行 —— 测试里补一条 200 的
        manual_running_from_response(&format!("HTTP/1.1 200 OK\r\n\r\n{body}"))
            .expect("200 不该走 Err 分支")
    }

    #[test]
    fn manual_running_field_is_recognised() {
        assert_eq!(parse(r#"{"account":{"running":false},"manual_running":false}"#), Some(false));
        assert_eq!(parse(r#"{"manual_running":true,"account":{}}"#), Some(true));
        // uvicorn 的紧凑输出（无空格）与带空格两种写法都要认
        assert_eq!(parse("{\"manual_running\": true}"), Some(true));
        assert_eq!(parse("{\"manual_running\": false}"), Some(false));
        // chunked 编码会给正文加上十六进制长度前缀 —— 字段文本本身不受影响
        assert_eq!(parse("1a\r\n{\"manual_running\":true}\r\n0\r\n\r\n"), Some(true));
    }

    #[test]
    fn missing_or_odd_field_counts_as_not_running() {
        // 旧后端没有该字段 → 不算"在跑"（退出优先，不该被一个缺失字段挡住）
        assert_eq!(parse(r#"{"account":{"running":true}}"#), Some(false));
        // 相似字段名不该被误当成 manual_running
        assert_eq!(parse(r#"{"auto_manual_running":true}"#), Some(false));
    }

    /// 三态判定的另外两态（S1 落地时最容易踩的地方，devlog/201）。
    ///
    /// `401` **必须是 `Err`，不能是 `Ok(None)`**：`Ok(None)` 的语义是"问不到 ⇒ 当没在跑
    /// ⇒ 直接退出"，而 401 的真实含义是"这个壳与这个后端对不上"（旧壳配新后端 / token 不同步），
    /// 那时**很可能正有手动任务在跑** —— 当成"没在跑"就会在用户毫不知情时掐掉一轮抓取，
    /// 而那正是 R20（devlog/095/097/129）花大力气修好的行为。
    ///
    /// 反向验证：把 `Some(401) | Some(403) => Err(...)` 改成 `=> Ok(None)` ⇒ 本用例红。
    #[test]
    fn unauthorized_is_an_error_not_a_quiet_no() {
        let resp = "HTTP/1.1 401 Unauthorized\r\ncontent-length: 55\r\n\r\n\
                    {\"detail\":\"缺少或无效的访问令牌（本机应用启动时生成）\"}";
        assert_eq!(manual_running_from_response(resp), Err(401),
                   "401 必须与\"没有任务\"区分开 —— 否则托盘退出会静默掐掉一轮抓取");

        let forbidden = "HTTP/1.0 403 Forbidden\r\n\r\n{}";
        assert_eq!(manual_running_from_response(forbidden), Err(403));
    }

    #[test]
    fn other_statuses_are_a_quiet_no_so_quit_always_works() {
        // 后端没起来 / 端口没监听 / 代理插了一脚：都该让用户**退得出去**
        for resp in ["", "garbage", "HTTP/1.1 502 Bad Gateway\r\n\r\n",
                     "HTTP/1.1 204 No Content\r\n\r\n"] {
            assert_eq!(manual_running_from_response(resp), Ok(None),
                       "非 200/401/403 一律当\"问不到\"：{resp:?}");
        }
    }

    /// token 生成的形状：够长、是十六进制、两次不同（S1）。
    ///
    /// 判错代价：token 可预测 = 门形同虚设；两次相同 = 跨启动复用。
    #[test]
    fn api_token_is_long_random_and_hex() {
        let a = new_api_token().expect("生成 token");
        let b = new_api_token().expect("生成 token");
        assert_eq!(a.len(), 64, "32 字节 → 64 个十六进制字符");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()), "必须是十六进制：{a}");
        assert_ne!(a, b, "两次启动/两次生成不能相同");
    }

    /// 准入表就是 `get_api_token` 的判据 —— 它必须**只**含预期的那两个窗口。
    ///
    /// ⚠️ 2026-09-26（S3-0）：准入表并进了 `COMMAND_ACL`，判据也搬过去
    /// （`only_expected_windows_may_read_the_token` 在新那一组里，多了未知窗口的断言）。
    /// 这里只留"类型没被写错"这一条最小断言。
    #[test]
    fn caller_labels_const_matches_the_acl() {
        assert_eq!(CALLER_LABELS_ALLOWED, ["main", "widget"]);
    }

    // ── 删旧数据目录的判据（devlog/198）───────────────────────────────────
    //
    // 这一组守的是**不可逆操作**：一次调用就 `remove_dir_all`。改造前的四道判据
    // （裸 PathBuf 相等 / is_dir() 跟随链接 / `.env` 或 `vtuber.db` 任一命中 / 无链接检查）
    // 全部可绕过，最坏路径能删到正在使用的活数据目录。
    //
    // 夹具刻意做成**真实目录 + 真实 junction**（本机实测 `mklink /J` 不需要管理员特权，
    // 所以它才是真实威胁；`mklink /D` 需要特权，普通用户造不出）。
    mod delete_old_dir {
        use super::*;

        /// 每个用例一格试验田；**用 `testtmp::TempRoot`**（Drop 时自清，devlog/134），
        /// 别自己 `mkdtemp` —— 那正是 "215 个残留目录 / 504MB" 的成因。
        fn scratch(tag: &str) -> crate::testtmp::TempRoot {
            crate::testtmp::TempRoot::new("ddtk-del", tag)
        }

        /// 造一份"看起来就是数据目录"的目录（4 项特征里命中 ≥3 项）。
        ///
        /// `env_only = true` 时刻意造出"只有 `.env` + logs + static、**没有 vtuber.db**"
        /// 的形态 —— 改造前的判据是 `vtuber.db || .env`，这种目录会被放行。
        fn fake_data_dir(at: &std::path::Path, env_only: bool) {
            std::fs::create_dir_all(at).expect("建目录");
            if env_only {
                std::fs::write(at.join(".env"), b"BILI_SESSDATA=x").unwrap();
            } else {
                std::fs::write(at.join("vtuber.db"), b"x").unwrap();
                std::fs::write(at.join("vtubers.csv"), b"a,b\n").unwrap();
            }
            std::fs::create_dir_all(at.join("logs")).unwrap();
            std::fs::create_dir_all(at.join("static")).unwrap();
        }

        fn stub(dir: &std::path::Path, id: &str) -> MigrationStub {
            MigrationStub {
                canonical: std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf()),
                id: id.to_string(),
            }
        }

        /// 建一个指向 `target` 的 junction；本机不支持时返回 false（用例跳过）。
        ///
        /// `mklink /J` **不需要管理员特权**（本机实测；`mklink /D` 需要）——
        /// 所以 junction 才是真实威胁模型里的那一半。
        fn make_junction(link: &std::path::Path, target: &std::path::Path) -> bool {
            let _ = std::fs::remove_dir_all(link);
            std::process::Command::new("cmd")
                .args([
                    "/c",
                    "mklink",
                    "/J",
                    &link.to_string_lossy(),
                    &target.to_string_lossy(),
                ])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }

        #[test]
        fn rejects_without_a_record() {
            let root = scratch("no-record");
            let cur = root.join("cur");
            fake_data_dir(&cur, false);
            let err = prepare_old_dir_deletion("whatever", None, &cur).unwrap_err();
            assert!(err.contains("没有待删除"), "实得：{err}");
        }

        #[test]
        fn rejects_a_mismatched_id() {
            let root = scratch("bad-id");
            let old = root.join("old");
            fake_data_dir(&old, false);
            let cur = root.join("cur");
            fake_data_dir(&cur, false);
            let rec = stub(&old, "the-real-id");
            let err = prepare_old_dir_deletion("a-forged-id", Some(&rec), &cur).unwrap_err();
            assert!(err.contains("不匹配"), "实得：{err}");
        }

        #[test]
        fn rejects_the_current_data_dir_and_its_equivalents() {
            let root = scratch("equiv");
            let cur = root.join("cur");
            fake_data_dir(&cur, false);
            std::fs::create_dir_all(cur.join("sub")).unwrap();
            // 三种等价写法：改造前用裸 `PathBuf` 比较，它们都是"另一个字符串" ⇒ 全部放行
            for p in [cur.clone(), cur.join("."), cur.join("sub").join("..")] {
                let rec = MigrationStub {
                    canonical: p.clone(),
                    id: "i".into(),
                };
                let err = prepare_old_dir_deletion("i", Some(&rec), &cur).unwrap_err();
                assert!(
                    err.contains("当前正在使用"),
                    "等价写法 {p:?} 必须被认成当前目录，实得：{err}"
                );
            }
        }

        #[test]
        fn rejects_an_ancestor_of_the_current_dir() {
            let root = scratch("ancestor");
            let cur = root.join("cur");
            fake_data_dir(&cur, false);
            let rec = stub(&root, "i"); // 记录的是当前目录的**上级**
            let err = prepare_old_dir_deletion("i", Some(&rec), &cur).unwrap_err();
            assert!(err.contains("上级目录"), "实得：{err}");
        }

        #[test]
        fn rejects_a_subdir_of_the_current_dir() {
            let root = scratch("subdir");
            let cur = root.join("cur");
            fake_data_dir(&cur, false);
            let rec = stub(&cur.join("static"), "i");
            let err = prepare_old_dir_deletion("i", Some(&rec), &cur).unwrap_err();
            assert!(err.contains("里面"), "实得：{err}");
        }

        #[test]
        fn rejects_a_junction_pointing_at_the_current_dir() {
            let root = scratch("junction-cur");
            let cur = root.join("cur");
            fake_data_dir(&cur, false);
            let link = root.join("link");
            if !make_junction(&link, &cur) {
                eprintln!("跳过：本机造不出 junction");
                return;
            }
            // 伪装成"旧目录"的 junction，目标其实是当前数据目录。
            // 本机实测：两者 `canonicalize` 后**完全相等** ⇒ 必须被第一条拦下。
            let rec = MigrationStub {
                canonical: link.clone(),
                id: "i".into(),
            };
            let err = prepare_old_dir_deletion("i", Some(&rec), &cur).unwrap_err();
            assert!(
                err.contains("当前正在使用"),
                "指向当前目录的 junction 必须被识破，实得：{err}"
            );
            assert!(cur.join("vtuber.db").exists(), "拒绝之后活目录必须毫发无损");
        }

        /// junction 作为删除目标时，**真正被删的是它指向的那个真实目录**，
        /// 而 junction 自己会变成孤立链接。
        ///
        /// ⚠️ 这条用例的第一版写错了预期（期望"junction 被拒"），跑出来是 `Ok(target)`。
        /// 查清之后这是**正确行为**，而且它同时推翻了规格里的一个假设：
        ///   · 本机实测 `remove_dir_all(junction)` **不会穿进目标**（`link_junction` 删掉后
        ///     `real/` 与 `real/sub/marker.txt` 都还在）⇒ "删链接会毁掉目标"的原始恐惧不成立；
        ///   · `canonicalize` 会把 junction **解成目标** ⇒ 删除路径上拿到的永远是真实目录，
        ///     "拒 reparse"那道判据在删除路径上**不可达**（它仍保留，因为 `canonicalize`
        ///     失败时不该退回原始路径，见那一段注释）。
        /// ⇒ 所以对 junction 真正需要拦的是"**解出来的目标是不是当前目录**"，
        ///    而那条由 `rejects_a_junction_pointing_at_the_current_dir` 守着（绿）。
        /// 这条用例守的是剩下那一半：**解出来的目标是别处时，删的必须是那个真实目录**，
        /// 而不是把 junction 当普通目录、留一堆半死不活的东西。
        #[test]
        fn a_junction_resolves_to_its_real_target_before_deleting() {
            let root = scratch("junction-old");
            let old = root.join("old");
            fake_data_dir(&old, false);
            let cur = root.join("cur");
            fake_data_dir(&cur, false);
            let link = root.join("link");
            if !make_junction(&link, &old) {
                eprintln!("跳过：本机造不出 junction");
                return;
            }
            let rec = MigrationStub {
                canonical: link.clone(),
                id: "i".into(),
            };
            let got = prepare_old_dir_deletion("i", Some(&rec), &cur)
                .expect("junction 解出的目标是别处 ⇒ 放行，但删的必须是真实目录");
            assert_eq!(
                got,
                std::fs::canonicalize(&old).unwrap(),
                "删除目标必须是 junction 指向的真实目录，而不是链接本身"
            );
            assert!(cur.join("vtuber.db").exists(), "活目录必须毫发无损");
            assert!(old.join("vtuber.db").exists(), "还没删之前目标当然还在");
        }

        #[test]
        fn rejects_a_dir_with_only_dot_env() {
            let root = scratch("env-only");
            let old = root.join("old");
            fake_data_dir(&old, true); // 只有 .env + logs + static，没有 vtuber.db
            let cur = root.join("cur");
            fake_data_dir(&cur, false);
            let rec = stub(&old, "i");
            let err = prepare_old_dir_deletion("i", Some(&rec), &cur).unwrap_err();
            assert!(
                err.contains("不像 ddtoolkit 数据目录"),
                "「有 .env 就算数据目录」是改造前 `||` 的漏洞，必须红。实得：{err}"
            );
        }

        #[test]
        fn rejects_a_missing_target() {
            let root = scratch("missing");
            let cur = root.join("cur");
            fake_data_dir(&cur, false);
            let rec = stub(&root.join("gone"), "i");
            let err = prepare_old_dir_deletion("i", Some(&rec), &cur).unwrap_err();
            assert!(err.contains("不可访问"), "实得：{err}");
        }

        #[test]
        fn accepts_a_legitimate_old_dir_and_return_path_is_canonical() {
            let root = scratch("ok");
            let old = root.join("old");
            fake_data_dir(&old, false);
            let cur = root.join("cur");
            fake_data_dir(&cur, false);
            // 票据里存的是"带 `.`"的等价写法 —— 必须仍然放行，但返回的要是**规范路径**
            // （删除用的是返回值，不是票据里那个字符串）
            let rec = MigrationStub {
                canonical: old.join("."),
                id: "i".into(),
            };
            let got = prepare_old_dir_deletion("i", Some(&rec), &cur).expect("合法旧目录应放行");
            assert_eq!(got, std::fs::canonicalize(&old).unwrap());
            assert!(got.join("vtuber.db").exists());
        }
    }

    // ── S3-0：命令级准入（devlog/208）────────────────────────────────────
    //
    // ⚠️ 两条口径：**默认拒绝**（没登记 = 谁都不能调）+ **每条命令都要真的调 guard**。
    // 前者靠"注册表 ↔ 准入表"对账，后者靠扫函数体 —— 因为自定义命令**不查 ACL**，
    // 只有命令自己判才算数（`ARCHITECTURE-IMPROVEMENT-EXECUTION.md` §2.2）。

    const SRC: &str = include_str!("lib.rs");

    /// 从源码里抠出 `invoke_handler(generate_handler![…])` 的命令名。
    fn registered_commands(src: &str) -> Vec<String> {
        let start = src.find("generate_handler![").expect("找不到 generate_handler");
        let rest = &src[start..];
        let end = rest.find("])").expect("找不到 generate_handler 的收尾");
        rest[..end]
            .lines()
            .filter_map(|l| {
                let t = l.trim().trim_end_matches(',');
                if t.is_empty() || t.contains('[') || t.contains(']') {
                    None
                } else {
                    Some(t.to_string())
                }
            })
            .collect()
    }

    /// 从源码里抠出 `COMMAND_ACL` 里登记的命令名。
    fn acl_commands(src: &str) -> Vec<String> {
        let start = src.find("const COMMAND_ACL").expect("找不到 COMMAND_ACL");
        let rest = &src[start..];
        let end = rest.find("];").expect("找不到 COMMAND_ACL 的收尾");
        rest[..end]
            .lines()
            .filter(|l| l.trim_start().starts_with("(\""))
            .map(|l| {
                l.trim_start()
                    .trim_start_matches("(\"")
                    .split('"')
                    .next()
                    .unwrap_or_default()
                    .to_string()
            })
            .collect()
    }

    /// 某条命令函数体的前 400 **字符**（给"有没有调 guard"用）。
    ///
    /// ⚠️ 按字符取而不是按字节切：源码里到处是中文注释，`src[at..at+400]` 会切进
    /// 多字节字符中间 ⇒ `panic: byte index is not a char boundary`（第一版就这么崩的）。
    fn command_head(src: &str, name: &str) -> String {
        let pat = format!("fn {name}(");
        let at = src.find(&pat).unwrap_or_else(|| panic!("找不到 fn {name}"));
        src[at..].chars().take(400).collect()
    }

    #[test]
    fn command_acl_matches_the_registered_handler() {
        // 两个方向的差集都必须为空：**新增命令没表态**会红；登记了不存在的命令也会红。
        // 反向验证：删掉 COMMAND_ACL 里任意一条 ⇒ 本用例红。
        let mut registered = registered_commands(SRC);
        let mut acl = acl_commands(SRC);
        registered.sort();
        acl.sort();
        assert_eq!(
            registered, acl,
            "COMMAND_ACL 与 invoke_handler 的注册表对不上 —— 新命令必须在 COMMAND_ACL 里表态"
        );
    }

    #[test]
    fn every_command_guards_on_the_caller_label() {
        // ⚠️ 本批最要紧的一条：自定义命令**不查 ACL**，命令自己不调 guard 就等于没门。
        let missing: Vec<String> = registered_commands(SRC)
            .into_iter()
            .filter(|c| !command_head(SRC, c).contains(&format!("guard_window(&window, \"{c}\")")))
            .collect();
        assert!(
            missing.is_empty(),
            "这些命令没有在入口调 guard_window（等于对任何窗口开放）：{missing:?}"
        );
        // 反向验证：删掉任意一条命令里的 guard_window 行 ⇒ 本用例红。
    }

    #[test]
    fn widget_may_call_only_what_the_widget_window_actually_uses() {
        // ⚠️ 这份清单是**手工维护的快照**（判据的真源是前端那条派生用例
        // `frontend/src/utils/widgetCommands.test.ts`：它从 `StatusWidgetWindow.tsx` /
        // `widgetMain.tsx` 的动态 import 里**推出**小窗能碰到哪些命令）。
        // 2026-09-26 真机复验抓到本表少了两条（`destroy_widget_window` /
        // `is_fullscreen_app_running`）—— 手工清单会漏，所以必须有一条派生的判据兜底。
        let mut allowed: Vec<&str> = COMMAND_ACL
            .iter()
            .filter(|(_, labels)| labels.contains(&"widget"))
            .map(|(name, _)| *name)
            .collect();
        allowed.sort_unstable();
        assert_eq!(
            allowed,
            vec![
                "destroy_widget_window",
                "get_api_token",
                "get_backend_port",
                "is_fullscreen_app_running",
                "resize_widget_window",
                "set_widget_click_through",
                "set_widget_visible",
                "widget_diag",
            ],
            "小窗可调命令集变了 —— 若是有意为之，先确认真机上小窗还点得动"
        );
    }

    #[test]
    fn dangerous_and_data_moving_commands_are_main_only() {
        // 计划点名的六条 + 本批新增的两条：**只有主窗口**能调。
        for cmd in [
            "delete_old_data_dir", // 唯一不可逆：删旧数据目录
            "migrate_data_dir",    // 会动用户数据：迁移数据目录
            "quit_app",
            "hide_to_tray",
            "open_release_page",
            "set_process_proxy",
            "open_external", // 外链白名单的入口（也别让小窗开）
            "open_data_dir",
        ] {
            assert!(command_allowed(cmd, "main"), "{cmd} 应当允许主窗口");
            assert!(!command_allowed(cmd, "widget"), "{cmd} 不该允许小窗");
            assert!(!command_allowed(cmd, "evil"), "{cmd} 不该允许未知窗口");
        }
    }

    #[test]
    fn unknown_commands_are_denied_by_default() {
        assert!(!command_allowed("no_such_command", "main"));
        assert!(!command_allowed("no_such_command", "widget"));
        assert!(!command_allowed("", "main"));
    }

    #[test]
    fn only_expected_windows_may_read_the_token() {
        // 反向验证：把 ACCESS 表里 get_api_token 的标签改成 ["main"] ⇒ 红（小窗读不到令牌）。
        assert!(command_allowed("get_api_token", "main"));
        assert!(command_allowed("get_api_token", "widget"));
        assert!(!command_allowed("get_api_token", "evil"));
        assert_eq!(CALLER_LABELS_ALLOWED, ["main", "widget"]);
    }

    // ── S3-B：外链白名单（devlog/208）────────────────────────────────────

    #[test]
    fn external_url_allows_whitelisted_hosts_with_paths_and_queries() {
        for ok in [
            "https://space.bilibili.com/434334701",
            "https://www.bilibili.com/read/cv3000000",
            "https://bilibili.com",
            "https://live.bilibili.com/123?x=1",
            "https://weibo.com/u/1234567",
            "https://www.weibo.com/u/1#frag",
            "HTTPS://BILIBILI.COM/x", // 大写不算绕过：规范化后就是同一个主机
            "  https://bilibili.com  ", // 两侧空白 trim 掉
        ] {
            assert!(external_url_host(ok).is_ok(), "应当放行：{ok}");
        }
    }

    // ── S3-A：capability 分窗（devlog/208）──────────────────────────────

    const CAP_BASE: &str = include_str!("../capabilities/default.json");
    const CAP_MAIN: &str = include_str!("../capabilities/main.json");

    /// 取 capability 文件里**真正的权限表**（不是整段文本 —— 描述里提到某个权限名
    /// 不等于授予它；第一版就是被自己的说明文字弄红的，本仓第 4 次踩这个坑）。
    fn cap_permissions(src: &str) -> Vec<String> {
        let v: serde_json::Value = serde_json::from_str(src).expect("capability 不是合法 JSON");
        v["permissions"]
            .as_array()
            .expect("permissions 必须是数组")
            .iter()
            .map(|p| p.as_str().unwrap_or_default().to_string())
            .collect()
    }

    #[test]
    fn capability_never_grants_the_unrestricted_open_path() {
        // ⚠️ S3-B 的关键一半：**旧通路必须一起删掉**。留着 `shell:allow-open` 的话，
        // 那个走插件内置正则（没有主机白名单）的通路仍在，而且两扇窗都能调 ⇒
        // 新命令 `open_external` 就只是"多了一条更严的路"。反向验证：把它加回去 ⇒ 红。
        for (name, src) in [("default.json", CAP_BASE), ("main.json", CAP_MAIN)] {
            let perms = cap_permissions(src);
            assert!(
                !perms.iter().any(|p| p == "shell:allow-open"),
                "{name} 又给了 shell:allow-open —— 外链必须只走 open_external（带主机白名单）"
            );
            assert!(
                !perms.iter().any(|p| p == "dialog:allow-open"),
                "{name} 给了 dialog:allow-open —— JS 侧从未使用（Rust 侧系统对话框不走 ACL）"
            );
        }
    }

    #[test]
    fn main_only_extras_are_not_in_the_wildcard_baseline() {
        // 主窗独有的两项（更新 + 重启进程）不该出现在通配基线里。
        let base = cap_permissions(CAP_BASE);
        let main = cap_permissions(CAP_MAIN);
        for perm in ["updater:default", "process:allow-restart"] {
            assert!(!base.iter().any(|p| p == perm), "基线里不该有 {perm}（它属于 main.json）");
            assert!(main.iter().any(|p| p == perm), "main.json 少了 {perm}");
        }
        // ⚠️ 基线**必须**留通配：小窗是运行时创建的，而"显式 label 能否命中运行时窗口"
        // 在本仓没有验证过（计划 §S3-A）。改成按 label 拆 ⇒ 有可能把 IPC 通道整个关掉。
        let v: serde_json::Value = serde_json::from_str(CAP_BASE).unwrap();
        assert_eq!(v["windows"].as_array().unwrap().len(), 1, "基线的窗口作用域应当只有一项");
        assert_eq!(v["windows"][0].as_str(), Some("*"),
                   "通配基线被删了 —— 小窗的 capability 命中未经真机验证，别在这一批冒险");
        let vm: serde_json::Value = serde_json::from_str(CAP_MAIN).unwrap();
        assert_eq!(vm["windows"][0].as_str(), Some("main"), "main.json 的作用域应当是主窗口");
    }

    #[test]
    fn external_url_rejects_everything_else() {
        // ⚠️ 这张表就是"外链只能去白名单"这句承诺的牙齿：少一条断言，就多一条通路。
        for bad in [
            "http://bilibili.com",              // 只允许 https
            "file:///C:/Windows/System32",      // 本地文件
            "javascript:alert(1)",              // 脚本
            "ms-settings:",                     // 自定义 scheme
            "https://bilibili.com@evil.com/",   // userinfo 绕过
            "https://evil.com/?x=bilibili.com", // 主机不是白名单
            "https://bilibili.com.evil.com/",   // 后缀伪装
            "https://evilbilibili.com/",        // 前缀伪装
            "https://bilibili.com./",           // 结尾点
            "https://%62ilibili.com/",          // 百分号编码
            "https://bilibili.com:443/",        // 带端口
            "https://127.0.0.1/",               // IP 字面量
            "https://localhost/",
            "https://[::1]/",
            "https://bilibili.com\\@evil.com",  // 反斜杠
            "https://bili bili.com/",           // 空白
            "https://bіlibili.com/",            // 西里尔同形字（非 ASCII）
            "",
            "   ",
        ] {
            assert!(external_url_host(bad).is_err(), "必须拒绝：{bad}");
        }
    }
}
