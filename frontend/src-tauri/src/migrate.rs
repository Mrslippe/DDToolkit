//! 数据目录迁移的**核心**：规划、复制、校验（R22-B2c，devlog/107）。
//!
//! 这一步改的是"数据在哪"，是整个 R22 里唯一可能**弄丢用户数据**的地方。所以把它单独成模块、
//! 只依赖 `std`（+ Windows 的磁盘余量 API），把三条判定写成可测的纯逻辑：
//!
//! 1. **能迁到哪**（`plan_migration`）：目标必须是存在的绝对路径目录、不能等于/包含/被包含于
//!    当前目录（否则复制会自我递归）、目标盘可用空间要 ≥ 待复制体积 × 1.15（留余量）；
//! 2. **复制什么**（`copy_tree`）：**跳过 `logs/` 与 `static/img-cache/`** —— 用户口径
//!    （2026-09-16）：日志是诊断用的、图片缓存可再生，两者都是"大而无所谓"的部分；
//!    遇到符号链接一律跳过（不跟随：跟随可能复制出循环，也可能把链接指向的外部数据抄进来）；
//! 3. **复制对不对**（`verify_copy`）：逐文件比对相对路径与字节数，**任何一处不一致都算失败** ——
//!    复制完就切指针、之后才发现少文件，用户是没有任何补救机会的。
//!
//! 纪律：**旧目录在整套流程里从头到尾不动**（删除是事后单独一步、且要用户确认）。
//! 所以"复制失败/校验失败"最坏的结果只是"新目录里有半份数据被丢掉"，用户的原始数据始终在。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 迁移时要跳过的**顶层文件**（R22-B2d 修复二，devlog/110）。
///
/// `vtuber.db-shm` 是 SQLite WAL 的**共享内存索引**：它记录锁状态与 WAL 索引，
/// **必须由每个进程自己重建**，拷贝它是不安全操作（官方明确要求不要复制 `-shm`）。
/// 真机实测（2026-09-16 dev 模式重试）：带着源进程留下的锁状态，新后端在
/// `_run_migrations()` 里**等锁**，而 `busy_timeout` 恰好 30000ms、探活超时也恰好 30s
/// ⇒ 必然判"后端 30 秒内没有就绪"，其实它再等一会儿就能自己恢复。
///
/// `-wal` **要复制**：里面可能还有最近几小时尚未 checkpoint 的写入，丢了就是丢数据。
/// 新进程会用 `-wal` 做恢复并自建 `-shm`，那是 SQLite 支持的路径。
pub const SKIP_FILES: [&str; 1] = ["vtuber.db-shm"];

/// 迁移时要跳过的顶层相对路径（用户口径）
pub const SKIP_DIRS: [&str; 2] = ["logs", "static/img-cache"];

/// 目标盘空间余量系数：待复制体积 × 1.15（元数据/簇对齐留一点，别卡在 100% 上）
const SPACE_MARGIN: f64 = 1.15;

/// 迁移计划（全部通过校验才会产出）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// 当前数据目录（复制源；**全程不动**）
    pub source: PathBuf,
    /// 用户在对话框里选的目录（真正的数据落在它下面的 `DDToolkit-data`）
    pub target_root: PathBuf,
    /// 新的数据目录 = `target_root/DDToolkit-data`
    pub data_dir: PathBuf,
    /// 待复制文件数与字节数（已扣除跳过项）
    pub files: usize,
    pub bytes: u64,
    /// 实际跳过的相对路径（会被写进日志与界面提示）
    pub skipped: Vec<String>,
}

/// 复制/校验的报告
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CopyReport {
    pub files: usize,
    pub bytes: u64,
}

/// 目标目录下的固定子目录名（用户口径：**自动建子目录**，不把库直接扔在所选目录里）
const DATA_SUBDIR: &str = "DDToolkit-data";

/// 挑一个**干净**的目标子目录（R22-B2d 修复，devlog/109）。
///
/// ⚠️ 真机实测（2026-09-16）第一次迁移就撞在这上面：用户选的 `E:\test` 下面**早就有**
/// 一份完整的数据目录 `DDToolkit-data\`，我的代码直接往里复制 ⇒ 嵌出一层同名目录、
/// 逐文件校验自然失败；**而且失败留下的半成品会让之后每一次重试都必然失败**（死胡同）。
///
/// 现在的规则：
/// 1. `DDToolkit-data` 不存在或**是空目录** ⇒ 用它（最常见、最干净）；
/// 2. 已存在且非空 ⇒ 改用 `DDToolkit-data-<epoch 秒>`，**绝不动用户已有的东西**，
///    而且这一次尝试一定有一个空的目标（重试永远有机会成功）。
fn pick_data_dir(root: &Path) -> Result<PathBuf, String> {
    let preferred = root.join(DATA_SUBDIR);
    if !preferred.exists() {
        return Ok(preferred);
    }
    if preferred.is_dir() && is_empty_dir(&preferred)? {
        return Ok(preferred);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let alt = root.join(format!("{DATA_SUBDIR}-{stamp}"));
    if alt.exists() {
        return Err(format!(
            "目标目录下 {} 与 {} 都已存在，请换一个目录",
            preferred.display(),
            alt.display()
        ));
    }
    Ok(alt)
}

fn is_empty_dir(p: &Path) -> Result<bool, String> {
    let mut entries = std::fs::read_dir(p).map_err(|e| format!("读目录失败 {}：{e}", p.display()))?;
    Ok(entries.next().is_none())
}

/// 递归收集要复制的文件：`(相对路径, 字节数)`。跳过 `SKIP_DIRS` 与符号链接。
pub fn collect(source: &Path) -> Result<(BTreeMap<PathBuf, u64>, Vec<String>), String> {
    let mut out = BTreeMap::new();
    let mut skipped = Vec::new();
    walk(source, source, &mut out, &mut skipped)?;
    for s in &SKIP_DIRS {
        if source.join(s).exists() {
            skipped.push((*s).to_string());
        }
    }
    Ok((out, skipped))
}

fn walk(
    root: &Path,
    dir: &Path,
    out: &mut BTreeMap<PathBuf, u64>,
    _skipped: &mut Vec<String>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("读目录失败 {}：{e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("遍历 {} 失败：{e}", dir.display()))?;
        let path = entry.path();
        let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
        // 跳过项：按**顶层相对路径**匹配（目录 `logs` / `static/img-cache`，文件 `vtuber.db-shm`）
        if SKIP_DIRS.iter().any(|s| rel == Path::new(s))
            || SKIP_FILES.iter().any(|s| rel == Path::new(s))
        {
            continue;
        }
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("读属性失败 {}：{e}", path.display()))?;
        if meta.file_type().is_symlink() {
            continue; // 不跟随：可能成环，也可能把外部数据抄进来
        }
        if meta.is_dir() {
            walk(root, &path, out, _skipped)?;
        } else if meta.is_file() {
            out.insert(rel, meta.len());
        }
    }
    Ok(())
}

/// 指定路径所在盘的可用字节数（Windows；拿不到时 `None` ⇒ 调用方**不该**据此拒绝迁移）。
#[cfg(target_os = "windows")]
pub fn free_space(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut free: u64 = 0;
    // SAFETY: 传的是以 NUL 结尾的宽字符串与三个可写指针
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut free,
        )
    };
    if ok == 0 {
        None
    } else {
        Some(free)
    }
}

#[cfg(not(target_os = "windows"))]
pub fn free_space(_path: &Path) -> Option<u64> {
    None
}

/// 规划并校验一次迁移。任何一条不满足都返回 `Err(给用户看的中文原因)`。
pub fn plan_migration(source: &Path, target_root: &Path) -> Result<Plan, String> {
    if !source.is_dir() {
        return Err(format!("当前数据目录不存在：{}", source.display()));
    }
    if !target_root.is_absolute() {
        return Err(format!("目标目录必须是绝对路径：{}", target_root.display()));
    }
    if !target_root.is_dir() {
        return Err(format!("目标目录不存在：{}", target_root.display()));
    }
    // ⚠️ **规范路径只用于"包含关系"校验**（消除 `..`、大小写、8.3 短名），
    //    但对外**一律用用户看到的原始路径**：`canonicalize()` 在 Windows 上会加 `\\?\`
    //    verbatim 前缀，而那个前缀一旦进了 `DDTOOLKIT_DATA_DIR`（进而进 `sqlite:///`），
    //    Python/SQLAlchemy 就**打不开库** —— 真机实测（devlog/111）：
    //    `sqlalchemy.exc.OperationalError: unable to open database file`，
    //    后端直接退出，迁移被误判成"新目录启动失败"。
    let src_c = canonical(source)?;
    let dst_c = canonical(target_root)?;
    if dst_c == src_c {
        return Err("目标目录与当前数据目录是同一个".to_string());
    }
    if dst_c.starts_with(&src_c) {
        return Err("目标目录在当前数据目录里面（复制会自我递归）".to_string());
    }
    if src_c.starts_with(&dst_c) {
        return Err("当前数据目录在目标目录里面".to_string());
    }

    let (files, skipped) = collect(&src_c)?;
    let bytes: u64 = files.values().sum();
    // 目标子目录要**干净**：已存在且非空就换一个带时间戳的（见 `pick_data_dir` 的说明）
    let data_dir = pick_data_dir(target_root)?;
    if data_dir.starts_with(source) {
        return Err("新数据目录会在当前数据目录里面".to_string());
    }
    if let Some(free) = free_space(target_root) {
        let need = (bytes as f64 * SPACE_MARGIN) as u64;
        if free < need {
            return Err(format!(
                "目标盘空间不足：需要约 {} MB，可用 {} MB",
                need / 1048576,
                free / 1048576
            ));
        }
    }
    Ok(Plan {
        source: source.to_path_buf(),
        target_root: target_root.to_path_buf(),
        data_dir,
        files: files.len(),
        bytes,
        skipped,
    })
}

fn canonical(p: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(p).map_err(|e| format!("路径解析失败 {}：{e}", p.display()))
}

/// 复制一个文件，**遇到"文件被占用"类错误重试**（R22-B2e，devlog/112）。
///
/// 为什么需要：`stop_backend()` 杀掉后端后，端口可能先于**文件句柄**释放 ——
/// Windows 上这时复制 `vtuber.db` / `-wal` 会直接 `拒绝访问`/`另一个程序正在使用`。
/// 这台机器上没撞到（复制时机刚好），但它是真实存在的竞态，不该赌。
fn copy_with_retry(from: &Path, to: &Path, rel: &Path) -> Result<(), String> {
    const ATTEMPTS: u32 = 4;
    let mut last: Option<std::io::Error> = None;
    for i in 0..ATTEMPTS {
        match std::fs::copy(from, to) {
            Ok(_) => return Ok(()),
            Err(e) => {
                let busy = is_busy(&e);
                last = Some(e);
                if !busy {
                    break; // 不是占用类问题：重试也没用
                }
                if i + 1 < ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                }
            }
        }
    }
    Err(format!(
        "复制失败 {} → {}：{}",
        rel.display(),
        to.display(),
        last.map(|e| e.to_string()).unwrap_or_default()
    ))
}

/// 是不是"文件被占用"类错误（值得重试）：
/// 5 = ERROR_ACCESS_DENIED、32 = ERROR_SHARING_VIOLATION、33 = ERROR_LOCK_VIOLATION。
fn is_busy(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
}

/// 按计划复制（**跳过项不复制**）。返回实际复制的文件数与字节数。
pub fn copy_tree(plan: &Plan) -> Result<CopyReport, String> {
    let (files, _) = collect(&plan.source)?;
    std::fs::create_dir_all(&plan.data_dir)
        .map_err(|e| format!("建新数据目录失败 {}：{e}", plan.data_dir.display()))?;
    let mut report = CopyReport::default();
    for (rel, size) in &files {
        let to = plan.data_dir.join(rel);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("建目录失败 {}：{e}", parent.display()))?;
        }
        copy_with_retry(&plan.source.join(rel), &to, rel)?;
        report.files += 1;
        report.bytes += size;
    }
    Ok(report)
}

/// 校验复制结果：**逐文件比对相对路径与字节数**，不一致就返回明细（最多列 5 条）。
pub fn verify_copy(plan: &Plan) -> Result<(), String> {
    let (want, _) = collect(&plan.source)?;
    let (got, _) = collect(&plan.data_dir)?;

    let mut problems: Vec<String> = Vec::new();
    for (rel, size) in &want {
        match got.get(rel) {
            None => problems.push(format!("缺文件 {}", rel.display())),
            Some(actual) if actual != size => problems.push(format!(
                "大小不符 {}：应 {size} 字节，实 {actual}",
                rel.display()
            )),
            Some(_) => {}
        }
        if problems.len() >= 5 {
            break;
        }
    }
    if problems.is_empty() {
        for rel in got.keys() {
            if !want.contains_key(rel) {
                problems.push(format!("多出文件 {}", rel.display()));
                if problems.len() >= 5 {
                    break;
                }
            }
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "复制校验失败（源 {} 个文件 / 目标 {} 个文件）：{}",
            want.len(),
            got.len(),
            problems.join("；")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ddtk-mig-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 造一份"像真的"数据目录：库 + 凭据 + 静态资源 + 要被跳过的两个大块
    fn fake_data_dir(root: &Path) -> PathBuf {
        let d = root.join("当前数据");
        std::fs::create_dir_all(d.join("logs")).unwrap();
        std::fs::create_dir_all(d.join("static").join("img-cache")).unwrap();
        std::fs::write(d.join("vtuber.db"), vec![b'x'; 4096]).unwrap();
        std::fs::write(d.join("vtuber.db-wal"), vec![b'w'; 512]).unwrap();
        // `-shm` 是 SQLite 的共享内存索引：**必须被跳过**（带过去会让新进程等锁，devlog/110）
        std::fs::write(d.join("vtuber.db-shm"), vec![b's'; 128]).unwrap();
        std::fs::write(d.join(".env"), b"TOKEN=secret\n").unwrap();
        std::fs::write(d.join("vtubers.csv"), b"name,uid\n").unwrap();
        std::fs::write(d.join("logs").join("app.log"), vec![b'l'; 9999]).unwrap();
        std::fs::write(d.join("static").join("img-cache").join("a.bin"), vec![b'c'; 7777]).unwrap();
        std::fs::write(d.join("static").join("logo.png"), vec![b'p'; 64]).unwrap();
        d
    }

    #[test]
    fn plan_skips_logs_and_image_cache() {
        let root = temp_root("skip");
        let src = fake_data_dir(&root);
        let target = root.join("目标盘");
        std::fs::create_dir_all(&target).unwrap();

        let plan = plan_migration(&src, &target).unwrap();
        assert!(plan.skipped.contains(&"logs".to_string()));
        assert!(plan.skipped.contains(&"static/img-cache".to_string()));
        // 只算"真要搬的"：库 4096 + wal 512 + .env + csv + logo 64
        assert_eq!(plan.bytes, 4096 + 512 + "TOKEN=secret\n".len() as u64
            + "name,uid\n".len() as u64 + 64);
        assert_eq!(plan.files, 5);
        assert!(plan.data_dir.ends_with("DDToolkit-data"));
    }

    #[test]
    fn copy_then_verify_is_clean_and_skips_stay_behind() {
        let root = temp_root("copy");
        let src = fake_data_dir(&root);
        let target = root.join("目标盘");
        std::fs::create_dir_all(&target).unwrap();

        let plan = plan_migration(&src, &target).unwrap();
        let report = copy_tree(&plan).unwrap();
        assert_eq!(report.files, plan.files);
        assert_eq!(report.bytes, plan.bytes);
        verify_copy(&plan).unwrap();

        // 关键内容真的过去了
        assert_eq!(std::fs::read(plan.data_dir.join(".env")).unwrap(), b"TOKEN=secret\n");
        assert!(plan.data_dir.join("vtuber.db").is_file());
        // 跳过项**没有**被复制（日志与图片缓存的体积不该出现在新目录）
        assert!(!plan.data_dir.join("logs").exists());
        assert!(!plan.data_dir.join("static").join("img-cache").exists());
        // 关键：`-shm` 必须**没有**被复制（它是 SQLite 的共享内存索引，带过去会让新进程等锁
        // —— 真机 dev 模式重试正是死在这里：日志停在 lifespan 开始、卡满 busy_timeout 30s）
        assert!(!plan.data_dir.join("vtuber.db-shm").exists(), "-shm 不该被复制");
        // `-wal` 必须复制（里面可能还有没 checkpoint 的写入，丢了就是丢数据）
        assert_eq!(std::fs::read(plan.data_dir.join("vtuber.db-wal")).unwrap().len(), 512);
        // 源目录**一个文件都没少**（纪律：全程不动旧目录）
        assert!(src.join("logs").join("app.log").is_file());
        assert!(src.join("vtuber.db-shm").is_file(), "源目录的 -shm 也不该被动");
        assert!(src.join("vtuber.db").is_file());
    }

    #[test]
    fn verify_catches_a_missing_file() {
        let root = temp_root("missing");
        let src = fake_data_dir(&root);
        let target = root.join("目标盘");
        std::fs::create_dir_all(&target).unwrap();
        let plan = plan_migration(&src, &target).unwrap();
        copy_tree(&plan).unwrap();
        std::fs::remove_file(plan.data_dir.join(".env")).unwrap();     // 模拟复制丢文件

        let err = verify_copy(&plan).unwrap_err();
        assert!(err.contains("缺文件"), "要说清是缺文件：{err}");
        assert!(err.contains(".env"));
    }

    #[test]
    fn verify_catches_a_size_mismatch() {
        let root = temp_root("size");
        let src = fake_data_dir(&root);
        let target = root.join("目标盘");
        std::fs::create_dir_all(&target).unwrap();
        let plan = plan_migration(&src, &target).unwrap();
        copy_tree(&plan).unwrap();
        // ⚠️ 覆盖内容必须**长度不同**：第一版写成 "truncated"（9 字节），
        //    而原文件 "name,uid\n" 也是 9 字节 ⇒ 大小校验当然通过，
        //    用例变成"什么都没测"（是这条用例自己抓出来的）
        std::fs::write(plan.data_dir.join("vtubers.csv"), b"x").unwrap();

        let err = verify_copy(&plan).unwrap_err();
        assert!(err.contains("大小不符"), "{err}");
    }

    #[test]
    fn rejects_same_nested_and_containing_targets() {
        let root = temp_root("nested");
        let src = fake_data_dir(&root);

        // 同一个目录
        assert!(plan_migration(&src, &src).is_err());
        // 目标在源里面
        let inside = src.join("sub");
        std::fs::create_dir_all(&inside).unwrap();
        assert!(plan_migration(&src, &inside).is_err());
        // 源在目标里面
        let outer = root.clone();
        assert!(plan_migration(&src, &outer).is_err(), "当前目录在所选目录里也要拦下");
    }

    #[test]
    fn rejects_missing_or_relative_target() {
        let root = temp_root("badtarget");
        let src = fake_data_dir(&root);
        assert!(plan_migration(&src, &root.join("不存在")).is_err());
        assert!(plan_migration(&src, Path::new("相对路径")).is_err());
    }

    /// **回归用例（真机失败复现，devlog/109）**：目标目录下**已有一份非空的
    /// `DDToolkit-data`** 时（用户之前实验留下的），迁移必须自动改用带时间戳的子目录，
    /// 而不是往旧目录里嵌一层 —— 后者会让逐文件校验永远失败，重试也永远失败。
    #[test]
    fn dirty_target_dir_falls_back_to_a_fresh_subdir_and_then_succeeds() {
        let root = temp_root("dirty");
        let src = fake_data_dir(&root);
        let target = root.join("目标盘");
        std::fs::create_dir_all(&target).unwrap();

        // 先造出"目标里已有一份完整数据目录"的现场（正是真机上发生的事）
        let occupied = target.join(DATA_SUBDIR);
        std::fs::create_dir_all(occupied.join("logs")).unwrap();
        std::fs::write(occupied.join("vtuber.db"), b"old-db").unwrap();
        std::fs::write(occupied.join("logs").join("app.log"), b"old-log").unwrap();

        let plan = plan_migration(&src, &target).unwrap();
        // ⚠️ **回归断言（真机失败复现，devlog/111）**：对外路径**绝不能带 `\\?\` verbatim 前缀** ——
        //    它进了 `DDTOOLKIT_DATA_DIR` / `sqlite:///` 会让 Python 打不开库，
        //    表现为"新目录启动失败"（后端日志只有两行 + stderr 里 OperationalError）。
        assert!(
            !plan.data_dir.to_string_lossy().starts_with(r"\\?\"),
            "数据目录不能带 verbatim 前缀：{}",
            plan.data_dir.display()
        );
        assert_ne!(plan.data_dir, occupied, "不能复用已有内容的目录");
        assert_eq!(plan.data_dir.parent().unwrap(), target);
        // 关键：这一次尝试**能成功**（旧内容一个字节都不动）
        copy_tree(&plan).unwrap();
        verify_copy(&plan).unwrap();
        assert_eq!(std::fs::read(occupied.join("vtuber.db")).unwrap(), b"old-db");
        assert_eq!(
            std::fs::read(occupied.join("logs").join("app.log")).unwrap(),
            b"old-log"
        );
    }

    /// 空的 `DDToolkit-data` 可以复用（重试时会留下这样的空壳，不该逼用户换目录）
    #[test]
    fn empty_target_subdir_is_reused() {
        let root = temp_root("empty-sub");
        let src = fake_data_dir(&root);
        let target = root.join("目标盘");
        std::fs::create_dir_all(target.join(DATA_SUBDIR)).unwrap();

        let plan = plan_migration(&src, &target).unwrap();
        assert_eq!(plan.data_dir, target.join(DATA_SUBDIR));   // 对外是原始路径，不带 verbatim 前缀
        copy_tree(&plan).unwrap();
        verify_copy(&plan).unwrap();
    }

    #[test]
    fn busy_errors_are_recognised_for_retry() {
        // 占用类错误值得重试；其它（比如路径不存在）重试也没用
        for code in [5, 32, 33] {
            let e = std::io::Error::from_raw_os_error(code);
            assert!(is_busy(&e), "code {code} 应当算占用类");
        }
        let other = std::io::Error::from_raw_os_error(2);   // ERROR_FILE_NOT_FOUND
        assert!(!is_busy(&other));
        let generic = std::io::Error::new(std::io::ErrorKind::Other, "x");
        assert!(!is_busy(&generic));
    }

    #[test]
    fn free_space_is_reported_for_an_existing_dir() {
        let root = temp_root("space");
        // Windows 上应当拿得到数字（拿不到就返回 None，调用方不该据此拒绝迁移）
        if cfg!(target_os = "windows") {
            let f = free_space(&root);
            assert!(f.is_some(), "Windows 上应当能问到磁盘余量");
            assert!(f.unwrap() > 0);
        }
    }
}
