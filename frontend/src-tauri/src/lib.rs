use std::sync::Mutex;

use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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

/// Job Object 句柄（KILL_ON_JOB_CLOSE），壳退出时内核杀光整个后端进程树。
/// 非 Windows 平台恒为 0，不参与逻辑。
struct BackendJob(Mutex<isize>);

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
            // 二次启动：聚焦已有窗口
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(BackendPort(Mutex::new(0)))
        .manage(BackendChild(Mutex::new(None)))
        .manage(BackendJob(Mutex::new(0)))
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            present_window
        ])
        .setup(|app| {
            perf("setup 开始");

            let port = free_port();
            let mut data_dir = app.path().app_data_dir()?;
            // dev 构建使用独立数据目录，避免调试抓取/登录写进「生产」数据
            #[cfg(debug_assertions)]
            {
                data_dir = data_dir.with_file_name(format!(
                    "{}-dev",
                    data_dir.file_name().unwrap_or_default().to_string_lossy()
                ));
            }
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
                RunEvent::ExitRequested { code, .. } => {
                    println!("[ddtoolkit] RunEvent::ExitRequested code={code:?}")
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
