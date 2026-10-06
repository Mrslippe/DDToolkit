fn main() {
    // 图标是 Tauri 构建脚本的输入（tauri-build → tauri-codegen 生成 context，
    // 其中 default_window_icon = icons/icon.ico 的**目录首项**，再由 tao 设为
    // ICON_SMALL → Win11 任务栏图标；exe 资源图标同样由 tauri-build/winres 内嵌），
    // 但 tauri-build 只对 config / resources / capabilities / frontendDist 声明了
    // rerun-if-changed，**图标不在其中** —— 于是只改图标时 cargo 认为「无事发生」，
    // 不重跑构建脚本，窗口图标与 exe 资源都保持旧值。
    //
    // 实测（2026-09-09）：icons/icon.ico 于 01:22 更新，01:36 的 release 构建
    // 仍内嵌旧图标（从 exe 提取出的图标与旧 32px 层逐像素一致）。
    //
    // 这里显式声明图标依赖；改图标后 cargo 会重跑本脚本 → 重新生成 context
    // 与 resource.lib → 重新编译链接，任务栏/资源管理器图标随之更新。
    for icon in [
        "icons/icon.ico",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/128x128.png",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }

    // ⚠️ 资源 glob 匹配不到文件时，tauri-build 只会丢一句
    //    `glob pattern extension/**/* path not found or didn't match any files.`
    //    —— 与"扩展根本没暂存"这件事毫无字面关系（干净 clone / `cargo test` 前必踩，
    //    2026-10-06 CI 实测）。这里先自己说一句人话，紧跟着才是 tauri-build 的报错。
    //    来源：`scripts/stage_extension.py`（`npm run stage:extension`，构建里自动跑）。
    if !std::path::Path::new("extension").join("manifest.json").exists() {
        println!("cargo:warning=extension/ 还没暂存 —— 先跑 `npm run stage:extension`；\
                  现在 bundle.resources 的 extension/**/* 匹配不到任何文件，构建会失败");
    }
    tauri_build::build()
}
