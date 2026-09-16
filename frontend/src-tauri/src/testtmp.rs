//! 测试用临时目录的**公共**载体（2026-09-17，devlog/134）。
//!
//! ## 为什么要有它
//!
//! `migrate.rs` / `datadir.rs` / `shelllog.rs` 三处用例各自建 `%TEMP%\ddtk-*` 目录，
//! 而且**只建不删** —— 用户报"低配机器跑得怎样"时我顺手看了一眼 `%TEMP%`：
//! **215 个残留目录、504MB**（`ddtk-mig-*` 138 个 / `ddtk-ptr-*` 57 个 / `ddtk-shelllog-*` 14 个）。
//! 单个目录不大，但每跑一次 `cargo test` 就再堆一批。
//!
//! 修法不是"在每个用例末尾手写 `remove_dir_all`"（漏一个就回到原样），
//! 而是让目录**自己带着清理责任**：`TempRoot` 在 `Drop` 时删掉自己 ——
//! 用例中途 `panic` 也会走到（测试档是 unwind）。
//!
//! `Deref<Target = Path>` 是为了让调用点几乎不用改：`root.join("x")`、`log(&root, …)`
//! 这些写法照旧（`&TempRoot → &Path` 有 deref coercion）。

use std::path::{Path, PathBuf};

/// 一个"用完即删"的临时根目录。
pub struct TempRoot(PathBuf);

impl TempRoot {
    /// 建一个 `<前缀>-<pid>-<tag>` 的临时目录（同名残留先清掉，避免上一轮影响这一轮）。
    pub fn new(prefix: &str, tag: &str) -> Self {
        let d = std::env::temp_dir().join(format!("{prefix}-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("建临时目录失败");
        Self(d)
    }

    /// 拿到底层路径（要 `PathBuf` 而不是 `&Path` 时用）。
    pub fn to_path_buf(&self) -> PathBuf {
        self.0.clone()
    }
}

impl std::ops::Deref for TempRoot {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        // 两种占法都要收拾：目录，或"路径被文件占住"（`shelllog` 的失败路径用例就是这么造的）
        if std::fs::remove_dir_all(&self.0).is_err() {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derefs_to_path_and_creates_the_dir() {
        let root = TempRoot::new("ddtk-testtmp", "create");
        assert!(root.is_dir(), "目录应当已建好：{}", root.display());
        assert!(root.join("child.txt").starts_with(std::env::temp_dir()));
    }

    #[test]
    fn drop_removes_the_dir() {
        let path = {
            let root = TempRoot::new("ddtk-testtmp", "drop");
            std::fs::write(root.join("f.txt"), b"x").unwrap();
            root.to_path_buf()
        };
        assert!(!path.exists(), "Drop 之后目录应当没了：{}", path.display());
    }

    #[test]
    fn drop_also_cleans_when_the_path_is_a_file() {
        // 复刻 `shelllog` 的失败路径用例：`root` 本身被一个文件占住 ⇒ remove_dir_all 会失败，
        // 必须退回 remove_file，否则这个残留会一直留着
        let path = {
            let root = TempRoot::new("ddtk-testtmp", "file");
            let p = root.to_path_buf();
            std::fs::remove_dir_all(&p).unwrap();
            std::fs::write(&p, b"i am a file").unwrap();
            p
        };
        assert!(!path.exists(), "被文件占住时也要清掉：{}", path.display());
    }
}
