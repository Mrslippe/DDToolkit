use std::sync::Mutex;

use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// 后端子进程句柄，退出时 kill 防止孤儿进程
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
/// - release：PyInstaller sidecar exe（Tauri 外部二进制约定）
/// - debug：直接跑 `python backend_main.py` —— 改后端零打包、日志直出终端
fn spawn_backend(
    app: &tauri::AppHandle,
    port: u16,
    data_dir: &std::path::Path,
) -> Result<CommandChild, Box<dyn std::error::Error>> {
    let (mut rx, child) = {
        #[cfg(not(debug_assertions))]
        {
            app.shell()
                .sidecar("ddtoolkit-backend")?
                .env("DDTOOLKIT_PORT", port.to_string())
                .env("DDTOOLKIT_DATA_DIR", data_dir.to_string_lossy().to_string())
                .env("DDTOOLKIT_PARENT_PID", std::process::id().to_string())
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
        .invoke_handler(tauri::generate_handler![get_backend_port])
        .setup(|app| {
            let port = free_port();
            let data_dir = app.path().app_data_dir()?;
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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 初始化失败")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(child) =
                    app_handle.state::<BackendChild>().0.lock().unwrap().take()
                {
                    let pid = child.pid();
                    let _ = child.kill();
                    // 第一道防线：按引导器进程树强杀（onefile 孙进程可能脱离树，
                    // 由 Job Object 与后端看门狗兜底）
                    #[cfg(target_os = "windows")]
                    {
                        use std::os::windows::process::CommandExt;
                        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                        match std::process::Command::new("taskkill")
                            .args(["/PID", &pid.to_string(), "/T", "/F"])
                            .creation_flags(CREATE_NO_WINDOW)
                            .output()
                        {
                            Ok(o) if o.status.success() => {
                                println!("[ddtoolkit] taskkill /T ok (pid {pid})")
                            }
                            Ok(o) => println!(
                                "[ddtoolkit] taskkill failed: {}",
                                String::from_utf8_lossy(&o.stderr)
                            ),
                            Err(e) => println!("[ddtoolkit] taskkill spawn err: {e}"),
                        }
                    }
                    println!("[ddtoolkit] backend process killed (pid {pid})");
                }
            }
        });
}
