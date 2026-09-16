use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, State, WindowEvent};
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
fn storage_info(state: State<'_, DataDirState>) -> DataDirInfo {
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
    let child = spawn_backend(app, port, dir).map_err(|e| format!("拉起后端失败：{e}"))?;
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
}

/// 选一个目录并把数据迁过去（系统文件夹选择框，用户口径 2026-09-16）。
#[tauri::command]
async fn migrate_data_dir(app: tauri::AppHandle) -> Result<MigrateReport, String> {
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
    })
}

/// 打开发布页（R23b）：连不上 GitHub 时的兜底出口。
///
/// 为什么直接调 Windows API 而不是插件：前端没装 `@tauri-apps/plugin-shell` 的 JS 包；
/// `tauri-plugin-shell` 的 Rust `open()` 已标记废弃（官方让换 `tauri-plugin-opener`），
/// 而为了"打开一个固定网址"再引一个插件不值得 —— `ShellExecuteW` 就够，且 URL 是常量
/// （比"前端随便传 URL"安全）。
#[tauri::command]
fn open_release_page() -> Result<(), String> {
    const URL: &str = "https://github.com/Mrslippe/DDToolkit/releases/latest";
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let wide: Vec<u16> = std::ffi::OsStr::new(URL)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let op: Vec<u16> = std::ffi::OsStr::new("open")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
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
            return Err(format!("打开发布页失败（ShellExecuteW rc={}）", rc as isize));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("只有 Windows 端支持打开发布页".to_string())
    }
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
#[tauri::command]
fn delete_old_data_dir(app: tauri::AppHandle, dir: String) -> Result<u64, String> {
    let path = std::path::PathBuf::from(&dir);
    if let Some(cur) = app
        .state::<DataDirState>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.dir.clone())
    {
        if path == cur {
            return Err("这是当前正在使用的数据目录，不能删".to_string());
        }
    }
    if !path.is_dir() {
        return Err(format!("目录不存在：{dir}"));
    }
    // 只删"看起来就是数据目录"的：防止界面传进来一个无关路径（或用户手改过）
    if !path.join("vtuber.db").exists() && !path.join(".env").exists() {
        return Err("这个目录里没有 ddtoolkit 数据（vtuber.db 与 .env 都不在），拒绝删除"
            .to_string());
    }
    let freed = dir_size(&path);
    std::fs::remove_dir_all(&path).map_err(|e| format!("删除失败：{e}"))?;
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
    .visible(false)
    .skip_taskbar(false)
    .build()?;
    let _ = w.set_focus();
    Ok(w)
}

/// 深休眠看门狗：每秒看一眼"隐藏够久了吗"。
/// 独立线程而不是 timer 回调：逻辑简单、退出时无需注销（进程结束就没了）。
fn spawn_deep_sleep_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
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
/// 判断故意做得**粗**：把响应里的空白去掉后找 `"manual_running":true` —— uvicorn 可能回
/// chunked（正文会多出分块长度前缀），为这一处引入 HTTP 客户端或手写分块解码都不值当；
/// 字段名是我们自己的（`fetch-status` 的 `manual_running`），够用且不会误判成 true。
fn backend_manual_running(port: u16) -> Option<bool> {
    use std::io::{Read, Write};
    if port == 0 {
        return None;
    }
    let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().ok()?;
    let mut sock = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
    sock.set_read_timeout(Some(Duration::from_millis(800))).ok()?;
    sock.write_all(
        b"GET /vtuber/fetch-status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .ok()?;
    let mut raw = String::new();
    sock.read_to_string(&mut raw).ok()?;
    if !raw.starts_with("HTTP/1.1 200") && !raw.starts_with("HTTP/1.0 200") {
        return None;                       // 非 200：当作问不到，别猜
    }
    let compact: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    Some(compact.contains("\"manual_running\":true"))
}

/// 托盘「退出」：没手动任务在跑就**直接退**（不依赖前端）；在跑才唤回窗口让用户确认。
fn tray_quit_impl(app: &tauri::AppHandle) {
    let port = *app.state::<BackendPort>().0.lock().unwrap();
    match backend_manual_running(port) {
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
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("show", "显示主界面").build(app)?;
    let status = MenuItemBuilder::with_id("status", "后台运行中")
        .enabled(false)
        .build(app)?;
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
fn get_backend_port(port: State<'_, BackendPort>) -> u16 {
    *port.0.lock().unwrap()
}

/// 显示主窗口。窗口默认 visible:false（见 tauri.conf.json），页面绘制完成后
/// 由前端 invoke 显示，避免 WebView2 首绘前的白屏（白色闪屏修复，见 devlog/021）。
/// show() 幂等：重复调用无副作用。
#[tauri::command]
fn present_window(window: tauri::Window) {
    let _ = window.show();
}

/// 隐藏到托盘（前端点 ✕ 且偏好为「最小化到托盘」时调用）。
#[tauri::command]
fn hide_to_tray(app: tauri::AppHandle) {
    hide_to_tray_impl(&app);
}

/// 真退出：先置标志（否则 `CloseRequested` 又把它拦成"隐藏"），再退出。
/// 退出路径仍走 `RunEvent::Exit` —— 那里负责 kill 后端子进程。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
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
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            present_window,
            hide_to_tray,
            quit_app,
            storage_info,
            migrate_data_dir,
            delete_old_data_dir,
            open_release_page
        ])
        .on_window_event(|window, event| {
            // ✕ 不再等于"退出"（R18，devlog/095）：关闭请求被拦下，改成隐藏到托盘，
            // 后台抓取照常。真正的退出只有两条路：托盘「退出」→ 前端确认 → `quit_app`，
            // 或系统注销/关机（那种情况下 `QUITTING` 不置真，但 `WindowEvent::Destroyed`
            // 之后 Tauri 仍会走 ExitRequested → 退出）。
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    hide_to_tray_impl(window.app_handle());
                }
            }
        })
        .setup(|app| {
            perf("setup 开始");

            let port = free_port();
            // ── 数据目录的**启动优先级**（R22-B2b，devlog/106）────────────────
            // 环境变量 > 迁移指针 > 默认目录（判定本身在 `datadir::resolve_startup`，有单测）。
            // 之前这里是无条件用 `app_data_dir()` 覆盖 `DDTOOLKIT_DATA_DIR`，
            // 于是 README 里"便携版可改这个变量自定义"是假的（实测见 devlog/105）。
            let mut default_dir = app.path().app_data_dir()?;
            // dev 构建使用独立数据目录，避免调试抓取/登录写进「生产」数据。
            // ⚠️ 只改**默认**目录：用户显式指定的（环境变量/迁移指针）不该被加后缀。
            #[cfg(debug_assertions)]
            {
                default_dir = default_dir.with_file_name(format!(
                    "{}-dev",
                    default_dir.file_name().unwrap_or_default().to_string_lossy()
                ));
            }
            let env_dir = std::env::var_os("DDTOOLKIT_DATA_DIR")
                .map(std::path::PathBuf::from)
                .filter(|p| p.is_absolute());
            let startup = datadir::resolve_startup(env_dir, datadir::read_pointer(), default_dir);
            if let Some(why) = startup.pointer_unusable.as_deref() {
                println!("[ddtoolkit] WARN: 数据目录指针不可用，已回退默认目录：{why}");
            }
            println!("[ddtoolkit] data dir = {}（来源 {}）",
                     startup.dir.display(), startup.source.as_str());
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

            let child = spawn_backend(app.handle(), port, &data_dir)?;
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
    /// 托盘退出那条判据的**解析部分**（`cargo test` 跑）。
    ///
    /// 判错的代价（2026-09-15 实测的 bug）：托盘「退出」点了没反应 —— 根因是它只发了一个
    /// 事件给前端，而前端没人接、深休眠时更收不到。现在"没手动任务在跑就直接退"，
    /// 于是"到底在不在跑"的判断必须可靠：**问不到（后端挂了/非 200/端口 0）要当成"没在跑"**
    /// （用户点的是退出，不能因为问不到就退不出去），但不能把"在跑"误判成"没在跑"
    /// （那会在用户毫不知情时掐掉一轮抓取）。
    fn parse(body: &str) -> Option<bool> {
        // 与 `backend_manual_running` 的正文判定同一套规则（去掉空白后找字段）
        let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        Some(compact.contains("\"manual_running\":true"))
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
}
