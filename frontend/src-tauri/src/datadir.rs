//! 数据目录的**指针文件**（R22-B2a，devlog/105）。
//!
//! 背景（用户 2026-09-16）："数据库放置在 C 盘中会不会导致数据量很大了之后挤占太多 C 盘空间？"
//! A/D/B1 三批把占用管住、显示出来、并能当场清理；这一批解决"**把数据搬到别的盘**"。
//!
//! 为什么要有指针文件：数据目录现在是"壳在启动时算出来的"（`app_data_dir()`，即
//! `%APPDATA%\com.ddtoolkit.app`）。要让用户搬到 D 盘，就得有个**壳在下次启动时能读到**的
//! 持久记录 —— 而且它**不能放在数据目录里**（旧目录删掉就丢了）。所以放在与数据目录平级的
//! 固定位置：`%APPDATA%\DDToolkit\data-dir.txt`（一行绝对路径）。
//!
//! 三条纪律：
//! 1. **指针坏了不能丢数据**：读不到 / 路径不存在 / 不是绝对路径 ⇒ 一律回退默认目录
//!    （旧数据还在那儿），并把"回退过"这件事**告诉界面** —— 按仓库纪律，
//!    "静默失败看起来像没数据"是不可接受的；
//! 2. 写指针用**原子替换**（临时文件 + rename），中途断电不会留下半个路径；
//! 3. 便携版**不参与**这套（用户口径：便携版整个文件夹一起搬，数据分出去反而容易丢）——
//!    由调用方通过 `resolve_data_dir(..., allow_pointer)` 决定。
//!
//! 结构上刻意分成两层：**纯函数**（`read_pointer_at` / `write_pointer_to` / `resolve_with`，
//! 路径由调用方给）+ **薄包装**（用 `pointer_path()` 找真实位置）。用例测的是前者 ——
//! 不是"抄一份逻辑再测一遍"。

use std::path::{Path, PathBuf};

/// 指针文件所在目录（与数据目录平级：删数据目录不会连它一起删）
const POINTER_DIR: &str = "DDToolkit";
/// 指针文件名（内容是一行绝对路径）
const POINTER_FILE: &str = "data-dir.txt";

/// 解析结果：最终用哪个目录 + 界面需要知道的两种"异常"
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub dir: PathBuf,
    /// 指针有效并生效（= 用户迁移过）
    pub custom: bool,
    /// 指针存在但**用不了**（不存在/不是绝对路径/读失败）—— 已回退默认目录。
    /// 界面要据此提醒用户，不能静默。
    pub pointer_unusable: Option<String>,
}

/// 指针文件的完整路径：`%APPDATA%\DDToolkit\data-dir.txt`。
/// 非 Windows（不发布）没有 `APPDATA` ⇒ `None`，整套机制自动停用。
pub fn pointer_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(base).join(POINTER_DIR).join(POINTER_FILE))
}

// ── 纯函数层（路径由调用方给，便于用临时目录测真行为）────────────────

/// 读指定位置的指针。`Ok(None)` = 没设过；`Err(原因)` = 设过但用不了。
pub fn read_pointer_at(pointer: &Path) -> Result<Option<PathBuf>, String> {
    let raw = match std::fs::read_to_string(pointer) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读不到指针文件 {}：{e}", pointer.display())),
    };
    // 允许用户手改这个文件：容忍首尾空白与不小心带上的引号
    let text = raw.trim().trim_matches('"').trim();
    if text.is_empty() {
        return Err("指针文件是空的".to_string());
    }
    let dir = PathBuf::from(text);
    if !dir.is_absolute() {
        return Err(format!("指针里的路径不是绝对路径：{text}"));
    }
    if !dir.is_dir() {
        return Err(format!("指针指向的目录不存在：{text}"));
    }
    Ok(Some(dir))
}

/// 原子写指针到指定位置（临时文件 + rename）。会先建好父目录。
pub fn write_pointer_to(pointer: &Path, dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() {
        return Err(format!("只能写入绝对路径：{}", dir.display()));
    }
    if let Some(parent) = pointer.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("建指针目录失败 {}：{e}", parent.display()))?;
    }
    let tmp = pointer.with_extension("txt.tmp");
    std::fs::write(&tmp, format!("{}\n", dir.display()))
        .map_err(|e| format!("写指针失败 {}：{e}", tmp.display()))?;
    std::fs::rename(&tmp, pointer)
        .map_err(|e| format!("替换指针失败 {}：{e}", pointer.display()))?;
    Ok(())
}

/// 把"指针读取结果"折算成"这次用哪个目录"。
pub fn resolve_with(pointer: Result<Option<PathBuf>, String>, default: PathBuf) -> Resolved {
    match pointer {
        Ok(Some(dir)) => Resolved { dir, custom: true, pointer_unusable: None },
        Ok(None) => Resolved { dir: default, custom: false, pointer_unusable: None },
        Err(why) => Resolved { dir: default, custom: false, pointer_unusable: Some(why) },
    }
}

// ── 薄包装层（用真实位置）────────────────────────────────────────────

pub fn read_pointer() -> Result<Option<PathBuf>, String> {
    match pointer_path() {
        Some(p) => read_pointer_at(&p),
        None => Ok(None),
    }
}

pub fn write_pointer(dir: &Path) -> Result<(), String> {
    match pointer_path() {
        Some(p) => write_pointer_to(&p, dir),
        None => Err("当前系统没有 APPDATA，指针机制不可用".to_string()),
    }
}

pub fn clear_pointer() -> Result<(), String> {
    let Some(p) = pointer_path() else { return Ok(()) };
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删指针失败 {}：{e}", p.display())),
    }
}

/// 决定这次启动用哪个数据目录（`allow_pointer = false` 时指针整套停用）。
pub fn resolve_data_dir(default: PathBuf, allow_pointer: bool) -> Resolved {
    if !allow_pointer {
        return Resolved { dir: default, custom: false, pointer_unusable: None };
    }
    resolve_with(read_pointer(), default)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例一个独立临时目录（用完删掉），避免相互干扰。
    fn temp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ddtk-ptr-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn pointer_path_is_absolute_under_appdata() {
        if std::env::var_os("APPDATA").is_some() {
            let p = pointer_path().expect("Windows 上应当有指针路径");
            assert!(p.is_absolute());
            assert!(p.ends_with(Path::new(POINTER_DIR).join(POINTER_FILE)));
        }
    }

    #[test]
    fn missing_pointer_is_not_an_error() {
        let root = temp_root("missing");
        let got = read_pointer_at(&root.join("nope.txt"));
        assert_eq!(got, Ok(None), "没设过指针不是错误（新装用户就是这种）");
    }

    #[test]
    fn empty_relative_or_missing_dir_are_reported() {
        let root = temp_root("bad");
        let p = root.join("data-dir.txt");

        std::fs::write(&p, "   \n").unwrap();
        assert!(read_pointer_at(&p).is_err(), "空内容要报错");

        std::fs::write(&p, "relative\\dir\n").unwrap();
        assert!(read_pointer_at(&p).is_err(), "相对路径要报错");

        std::fs::write(&p, "Z:\\definitely\\not\\here\\ddtk\n").unwrap();
        assert!(read_pointer_at(&p).is_err(), "目录不存在要报错");
    }

    #[test]
    fn write_then_read_roundtrip_tolerates_quotes_and_spaces() {
        let root = temp_root("roundtrip");
        let target = root.join("moved-data");
        std::fs::create_dir_all(&target).unwrap();
        let p = root.join(POINTER_DIR).join(POINTER_FILE);

        write_pointer_to(&p, &target).unwrap();
        assert_eq!(read_pointer_at(&p).unwrap(), Some(target.clone()));

        // 用户手改过（带引号/缩进）也要认
        std::fs::write(&p, format!("  \"{}\"  \n", target.display())).unwrap();
        assert_eq!(read_pointer_at(&p).unwrap(), Some(target));
    }

    #[test]
    fn resolve_uses_pointer_when_usable_else_falls_back_with_reason() {
        let default = PathBuf::from("C:\\default-dir");
        let moved = PathBuf::from("D:\\DDToolkit-data");

        let good = resolve_with(Ok(Some(moved.clone())), default.clone());
        assert_eq!(good.dir, moved);
        assert!(good.custom);
        assert!(good.pointer_unusable.is_none());

        let none = resolve_with(Ok(None), default.clone());
        assert_eq!(none.dir, default);
        assert!(!none.custom);

        // ⚠️ 指针坏了**必须回退默认目录**（旧数据还在那儿），并把原因带给界面 ——
        // 绝不能"在坏路径上新建一个空库"，那会让用户以为数据没了
        let bad = resolve_with(Err("目录不存在：Z:\\gone".into()), default.clone());
        assert_eq!(bad.dir, default);
        assert!(!bad.custom);
        assert!(bad.pointer_unusable.is_some());
    }

    #[test]
    fn pointer_is_ignored_when_not_allowed() {
        let default = PathBuf::from("C:\\portable\\data");
        let got = resolve_data_dir(default.clone(), false);
        assert_eq!(got.dir, default);
        assert!(!got.custom);
        assert!(got.pointer_unusable.is_none());
    }
}
