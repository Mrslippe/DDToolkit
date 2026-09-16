//! 壳侧文件日志（R22-B2e，devlog/112）。
//!
//! 起因：数据目录迁移连着三次真机失败，而**壳的 `println!` 在打包版里等于没有输出** ——
//! 每次我只能靠后端日志（`logs/app.log`、`logs/sidecar.log`）去反推壳走到了哪一步。
//! 第一次甚至要靠"三次启动都在同一端口"这种间接证据才能判断回滚成功。
//!
//! 现在把壳在乎的事写进 `<数据目录>\logs\shell.log`：
//! - 启动时：数据目录 + 来源（`env` / `migrated` / `default`）+ 指针是否可用；
//! - 迁移每一步：选了哪个目录、计划（文件数/字节数/跳过项）、复制、校验、写指针、
//!   拉起后端与探活、以及**任何一步失败的原因与回滚动作**。
//!
//! 三条克制：
//! 1. **只追加、不轮转**（这个文件只在关键动作时写几行，一年也长不到几十 KB），
//!    真要看体积时 `dir_stats()` 的日志分组里能看到它；
//! 2. **写失败绝不影响主流程**（拿不到目录/没权限就静默放弃 —— 日志是诊断手段，不是功能）；
//! 3. 落在 `logs/` 下 ⇒ 迁移时会**跳过**该目录，不会把壳日志抄进新数据目录。

use std::io::Write;
use std::path::Path;

/// 本地时间戳 `YYYY-MM-DD HH:MM:SS`（Windows 上走 `GetLocalTime`；
/// 其它平台退回 epoch 秒 —— 本项目只发布 Windows，够用且不引依赖）。
pub fn now_stamp() -> String {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::SystemInformation::GetLocalTime;
        // 签名是 `GetLocalTime(*mut SYSTEMTIME)`（写进调用方给的缓冲区）
        let mut t: windows_sys::Win32::Foundation::SYSTEMTIME = unsafe { std::mem::zeroed() };
        // SAFETY: 传的是本栈上的可写结构体指针
        unsafe { GetLocalTime(&mut t) };
        return format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("epoch {secs}")
    }
}

/// 追加一行到 `<data_dir>\logs\shell.log`（目录不存在会创建）。
/// **任何失败都静默** —— 日志写不进去不该让迁移/启动失败。
pub fn log(data_dir: &Path, msg: &str) {
    let dir = data_dir.join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("shell.log"))
    else {
        return;
    };
    let _ = writeln!(f, "[{}] {}", now_stamp(), msg);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时数据目录；**用完自删**（`TempRoot` 的 `Drop`，devlog/134）。
    /// 注意 `write_failure_is_silent` 会把 `root` 本身写成文件 —— `Drop` 两条路都收拾。
    fn temp_root(tag: &str) -> crate::testtmp::TempRoot {
        crate::testtmp::TempRoot::new("ddtk-shelllog", tag)
    }

    #[test]
    fn stamp_looks_like_a_timestamp() {
        let s = now_stamp();
        // Windows：`YYYY-MM-DD HH:MM:SS`（19 字符、位置固定）
        assert_eq!(s.len(), 19, "时间戳格式不对：{s}");
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], " ");
        assert_eq!(&s[13..14], ":");
        // 年份必须是 4 位数字（不是 epoch、也不是空）
        assert!(s[..4].chars().all(|c| c.is_ascii_digit()), "{s}");
    }

    #[test]
    fn appends_without_truncating_and_creates_logs_dir() {
        let root = temp_root("append");
        log(&root, "第一条");
        log(&root, "第二条");
        let body = std::fs::read_to_string(root.join("logs").join("shell.log")).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2, "应当是追加而不是覆盖：{body}");
        assert!(lines[0].ends_with("第一条"));
        assert!(lines[1].ends_with("第二条"));
    }

    #[test]
    fn write_failure_is_silent() {
        // 拿一个**不存在的父级**当数据目录是会创建成功的，所以这里用一个"路径被文件占住"的
        // 情形：`root/logs` 是个文件 ⇒ create_dir_all 失败 ⇒ 应当静默返回、不 panic
        let root = temp_root("blocked");
        std::fs::write(root.join("logs"), "我是文件不是目录").unwrap();
        log(&root, "这条写不进去，但不许炸");
    }
}
