# DDToolkit 发布手册（Release Playbook）

> 每次发布按本文档执行。所有命令均为**本机验证过**的参数组合（尤其网络部分，见 §6）。
> 首次发布：v0.9.1（2026-09-08，[GitHub Release](https://github.com/Mrslippe/DDToolkit/releases/tag/v0.9.1)）。

---

## 1. 发布前清单（Pre-flight）

- [ ] 已确认目标版本号（例：`v0.9.2`），devlog 已写并提交
- [ ] 本地 `main` 干净，`git status` 无非预期文件
- [ ] 代理软件已启动（本机 `7897` 或你的实际端口，见 §6）
- [ ] GitHub token 有效（classic PAT，`repo` scope）或 GCM 已授权
- [ ] `python -m PyInstaller --version`、`cargo --version` 可用（构建工具链）

---

## 2. 版本号同步（先于构建，5 处必须一致）

当前版本号分散在 5 个文件（历史上曾有 0.8.0/0.1.0 不一致——**必须全部改齐**）：

| 文件 | 字段 | 说明 |
|---|---|---|
| `app/core/config.py` | `VERSION: str = "x.y.z"` | 后端版本（注释同步 devlog 版本） |
| `frontend/src-tauri/tauri.conf.json` | `"version": "x.y.z"` | 桌面壳版本（决定安装包文件名） |
| `frontend/src-tauri/Cargo.toml` | `version = "x.y.z"` | Rust crate 版本 |
| `frontend/src-tauri/Cargo.lock` | `[[package]] name="ddtoolkit"` 下 `version = "x.y.z"` | lock 同步（`[[package]]` 块第一处即本项目） |
| `frontend/package.json` | `"version": "x.y.z"` | 前端包版本 |

一次性替换示例（PowerShell，注意编码 UTF8）：

```powershell
$old = "0.9.1"; $new = "0.9.2"
foreach ($f in @(
  "app/core/config.py",
  "frontend/src-tauri/tauri.conf.json",
  "frontend/src-tauri/Cargo.toml",
  "frontend/package.json"
)) {
  $c = Get-Content $f -Raw -Encoding UTF8
  $c = $c.Replace($old, $new)
  [IO.File]::WriteAllText((Join-Path $PWD $f), $c, [Text.UTF8Encoding]::new($false))
}
# Cargo.lock 单独处理（只改 ddtoolkit 块，勿动其他包）
```

> ⚠️ Cargo.lock 里 `name = "ddtoolkit"` 块的 `version` 必须同步——漏改会导致 tauri build 产物版本错乱。

---

## 3. 构建产物（三步，产物统一 `dist-release/`）

> 💡 **大多数改动不用走这一步**：后端/登录/首启类改动用
> `python scripts/dev_check.py`（约 20 秒）就能验完，详见 `docs/DEV-LOOP.md`。
> 只有动到 Rust 壳 / `tauri.conf.json` / 需要确认安装包布局时才必须整包重建。

```powershell
cd frontend
npm run release
```

`release` = `build:backend`（PyInstaller onedir → `src-tauri/binaries/backend/`，约 89MB）
→ `tauri:build`（前端构建 + Rust release + NSIS 安装包，约 3-5 分钟）
→ `collect:release`（聚合到 `dist-release/`：安装包 + 便携 zip）。

**验证产物**：

```powershell
Get-ChildItem dist-release | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB)}}
# 期望两个文件:
#   DDtoolkit_<新版本>_x64-setup.exe   (~40 MB)
#   DDtoolkit-portable-win64.zip      (~52 MB)
# 若出现旧版本安装包残留（如 0.1.0），删除之
```

**验证「后端目录没被安装包打平」**（2026-09-08 事故，见 devlog/036）：

```powershell
# 安装脚本里的安装目标必须保留 _internal/ 层级
Select-String frontend/src-tauri/target/release/nsis/x64/installer.nsi `
  -Pattern '/oname=binaries\\backend\\_internal' | Measure-Object   # 期望 ≈851 行
# 打平（oname 不含 _internal 但源在 _internal）的行数必须为 0
(Select-String frontend/src-tauri/target/release/nsis/x64/installer.nsi `
  -Pattern '/oname=binaries\\backend\\[^\\]+"\s+"[^"]*_internal' | Measure-Object).Count
```

> ⚠️ **资源打包契约（勿改回）**：`tauri.conf.json` 的 `bundle.resources` 必须用
> **数组形式** `["binaries/backend/**/*"]`。改成 map + glob 形式
> （`{"binaries/backend/**/*": "binaries/backend/"}`）会让 tauri-utils 按
> `dest.join(file_name())` 处理——**只保留文件名**，把后端 onedir 的 `_internal/`
> 摊平，装完 exe 起不来、启动幕永久卡住（便携 zip 直接打包构建产物，不受影响，
> 所以只有直装版会坏）。

> ⚠️ 构建环境注意：`npm run release` 需在**完整权限**下执行（PyInstaller/esbuild/cargo/makensis 子进程在受限沙箱会 EPERM）。

---

## 4. 发布（tag + Release + 资产）

### 4.1 打 tag 并推送

```powershell
git tag -a v0.9.2 -m "DDtoolkit v0.9.2"
git -c http.sslBackend=openssl -c http.sslVerify=false -c http.proxy=http://127.0.0.1:7897 push https://<TOKEN>@github.com/Mrslippe/DDToolkit.git v0.9.2
```

### 4.2 创建 Release（API）

推荐用 Python 脚本（避免 PowerShell/curl 中文与 TLS 问题）——**通用脚本**：

`scripts/upload_release_assets.py`（见 §5），支持：创建 Release + 上传两个资产 + 输出 Release URL。

也可手动方式：浏览器 → `https://github.com/Mrslippe/DDToolkit/releases/new` → 选 tag → 粘贴 release notes → 拖入两个资产 → Publish。

### 4.3 Release 描述（notes）

每次发布从 `docs/release-notes-v<版本>.md` 复制（首次为 v0.9.1 的范本）。

---

## 5. 可复用脚本

### `scripts/upload_release_assets.py`

调用（token 走环境变量，不落盘）：

```powershell
$env:GITHUB_TOKEN = "ghp_xxx"
python scripts/upload_release_assets.py v0.9.2
```

行为：
1. 校验 `GITHUB_TOKEN` 与 tag（`git ls-remote` 确认已推送）
2. `POST /releases` 创建 Release（从 `docs/release-notes-v0.9.2.md` 读描述，缺省用内置文本）
3. 上传 `dist-release/DDtoolkit_<v>_x64-setup.exe` + `DDtoolkit-portable-win64.zip`
4. 打印 Release URL

输出示例：
```
[1/4] tag v0.9.2 已推送, 开始发布
[2/4] Release created  (id 384558707)
[3/4] 上传 DDtoolkit_0.9.2_x64-setup.exe  ... OK (40.4 MB)
[4/4] 上传 DDtoolkit-portable-win64.zip  ... OK (52.4 MB)
URL: https://github.com/Mrslippe/DDToolkit/releases/tag/v0.9.2
```

---

## 6. 网络：本机到 GitHub 的坑与定案（本发布最大教训）

### 6.1 现象回顾

- `git`/`curl` 默认后端报 `schannel: SEC_E_NO_CREDENTIALS`（本地 TLS 栈问题，**非网络**——0.004s 就失败）
- 直连 `github.com`（DNS 解析到 `20.205.x` 亚太节点）**对中国网络极不稳定**：间歇性 21s 超时
- 代理 `7897` **已配置但未运行时**，git 指向死代理 → 假失败
- 认证失败有时是**抖动假象**（网络通时同一 token `ls-remote` 却成功——公开仓库匿名可读）

### 6.2 定案参数（本机验证有效）

```powershell
# git 推送/拉取统一加:
-c http.sslBackend=openssl    # 豁免 schannel 凭据问题
-c http.sslVerify=false       # 豁免证书链问题（本地 MITM/代理环境）
-c http.proxy=http://127.0.0.1:7897   # 走代理（代理必须已启动）
```

此组合**首次即成功**；不带代理参数则失败率极高。

### 6.3 检查清单（连不上 GitHub 时按序查）

```powershell
# ① 代理端口是否在监听（Clash 等必须启动）
Test-NetConnection 127.0.0.1 -Port 7897
# ② DNS 是否解析（若为 20.205.x 且超时 = 需走代理）
Resolve-DnsName github.com
# ③ 浏览器能否打开仓库页（ProxyEnable 应为 0 时即直连；浏览器能开 ≠ git 能通）
Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" |
  Select-Object ProxyEnable, ProxyServer
```

### 6.4 token 安全

- token **进入过对话/命令行即视为泄露**——发布完成后吊销（Settings → Developer settings → Personal access tokens），下次发布重新生成
- GCM（`git credential-manager`）浏览器授权后可**永久免 token**做 `git push`；但 **GitHub API 创建 Release/传资产仍需 token**（GCM 不覆盖 API）
- 临时 token 使用 `$env:GITHUB_TOKEN` 传参，**不要**写进脚本文件

---

## 7. 发布后检查

- [ ] `https://github.com/Mrslippe/DDToolkit/releases/tag/v<版本>` 可访问
- [ ] 两个资产可下载（大小与 dist-release 一致）
- [ ] **装一次直装版**：安装目录 `binaries\backend\_internal\` 存在，
      首启能越过启动幕（安装版首启坏了历史上就是这一步没验，见 devlog/036）
- [ ] 便携版解压启动正常（含 B 站扫码登录能真正拿到凭据）
- [ ] 吊销本次 PAT（如 token 经对话/日志暴露）
- [ ] 本地 `git status` 干净（`dist-release/`、`scripts/backend-8000.bat`、`_nondistribute/` 均 gitignore，不应出现）
- [ ] README 顶部的 Version 徽章已更新（README.md 头部 `version-x.y.z`）

---

## 8. 语义约定（半自动流程）

| 动作 | 命令/方式 |
|---|---|
| 构建 | `npm run release --prefix frontend`（完整权限） |
| 推代码 | `git push`（GCM 授权后免 token） |
| 推 tag + 建 Release + 传资产 | `scripts/upload_release_assets.py v<版本>`（token 走环境变量） |
| 浏览器兜底 | 手动 upload（§4.2） |
