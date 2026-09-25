# DDToolkit 发布手册（Release Playbook）

> **日常发布只需一条命令**（2026-09-15 起，devlog/084）：
>
> ```powershell
> $env:GITHUB_TOKEN = "ghp_xxx"          # 只建 Release 需要；推代码走 GCM 可省
> python scripts/release.py 1.0.1        # 版本同步 → 门禁 → 打版 → 校验 → 提交/tag → 推送 → Release
> ```
>
> 不知道版本号时用 `--bump patch|minor|major`；只想看会做什么用 `--dry-run`；
> 中途失败按提示 `--from <步骤>` 续跑。**本文档余下部分是那条命令背后的每一步**，
> 用于排查、手工兜底与理解守卫（脚本失败时会指向对应小节）。
>
> 首次发布：v0.9.1（2026-09-08）；最近发布：**v1.0.1**（2026-09-15，
> [GitHub Release](https://github.com/Mrslippe/DDToolkit/releases/tag/v1.0.1)，release id 389029336）。
>
> **v1.0.2 已打 tag 并推送（2026-09-16）**：tag `v1.0.2` = **`36a7ba1`**（发布前把 R20–R24 的实测问题都修完
> 才定版，期间按用户口径**移动过三次**），产物按该提交重建并已校验：setup **57.5MB** / 便携 **71.9MB** /
> `latest.json`（签名 420 字符，载体 = 安装包）。**GitHub Release 尚未创建**（本机无 PAT）——
> 补建只需一条命令，资产已在 `dist-release/`：
> `$env:GITHUB_TOKEN="ghp_xxx"; python scripts/release.py 1.0.2 --from release`
> （续跑会先打印一行 `远端已有 tag v1.0.2 → 保留 release` —— 这一步**问的是远端事实**，
> 不再按"计划里有没有 push"推断，见 devlog/120）。

---

## 0. 一键脚本 `scripts/release.py`（推荐入口）

| 步骤 | 干什么 | 守卫（不满足即停，且**不写任何文件**） |
|---|---|---|
| `preflight` | 分支 / 工作树 / 工具链 / 发布说明 / 版本号一致性 / 网络可达 / token | 工作树脏、notes 缺失、新版本不大于旧版本、要发布但没 token → 停 |
| `version` | 六处版本号**定点**同步（§2） | 逐文件锚点替换（Cargo.lock 只动 `ddtoolkit` 块），改完复核六处一致 |
| `gates` | pytest / tsc / eslint / vitest（`--probes` 追加 UI 探针五模式） | 任一非 0 → 停 |
| `build` | `npm run release`（§3） | 非 0 → 停；日志实时透传 |
| `verify` | 两个资产 + 无旧版本残留 + **NSIS 未打平** + 便携包结构 + 主程序 FileVersion | devlog/036 的事故形态在这里被机器拦住 |
| `commit` | `git add -A` + 提交（版本号 + 发布说明 + devlog） | 无改动则跳过（不造空提交） |
| `tag` | `git tag -a v<版本>` | tag 已存在且不指向 HEAD → 停（不覆盖已发布的 tag） |
| `push` | 推分支 + 推 tag（代理/直连自动切换 + 重试，§6） | 推完 `ls-remote` 复核；tag 没上去 → 停 |
| `release` | `scripts/upload_release_assets.py`（幂等，§5） | 无 token / tag 未推 → 停 |
| `report` | 写 `dist-release/release-report-<版本>.md`（gitignore 内）+ 打印待人工确认项 | —— |

常用参数：`--dry-run`（只预检 + 打印计划）、`--from <步骤>`（续跑）、`--only` / `--skip`、
`--skip-gates`、`--probes`（+8 分钟）、`--align-version`（版本号漂移时强制对齐）、
`--allow-dirty`、`--message-file <文件>`（自定义提交信息）、`--no-remote-release`（只到推送为止）。
另有 `python scripts/release.py --check-version`：只校验六处版本号一致（提交前/CI 可用）。

---

## 1. 发布前清单（Pre-flight）

- [ ] 目标版本号已定，devlog 已写并提交；发布说明 `docs/releases/v<版本>.md` 已写好（preflight 要求 ≥200 字符、无占位符）
- [ ] 本地 `main` 干净；代理软件已启动（本机 `7897`，见 §6）；GitHub token 有效（classic PAT，`repo` scope）或 GCM 已授权
- [ ] **依赖环境已按 `uv.lock` 装好**（`uv sync`）—— 真源见 §3.0
- [ ] 构建工具链可用：`python -m PyInstaller --version`、`cargo --version`

> 这几条**就是 `release.py preflight` 检查的东西**（缺哪条它会指名道姓地说），别在别处再抄一份清单。

---

## 2. 版本号同步（先于构建）

**锚点清单的真源 = `scripts/release.py` 的 `VERSION_FILES`**（6 个锚点 = 5 个文件 + README 徽章，
`tests/test_release_script.py` 有一条 `len(VERSION_FILES) == 6` 的用例钉住）。这里**不复述那张表** ——
清单、每处的锚点正则、"改完复核六处一致" 都在脚本里：`python scripts/release.py <版本>` 会自动做这一步，
`python scripts/release.py --check-version` 只校验一致性。历史上曾出现 0.8.0 / 0.1.0 不一致 ⇒ 必须全部改齐。

⚠️ 唯一容易改错的一处：`Cargo.lock` **只动 `name = "ddtoolkit"` 那一块**
（同文件里 serde 等依赖的 `version` 也常是 `1.0.0`）—— 漏改会让 tauri build 产物版本错乱。

---
## 3. 构建产物（三步，产物统一 `dist-release/`）

### 3.0 依赖环境只认 `uv.lock`（2026-09-25，devlog/197）

**真源 = `pyproject.toml` + `uv.lock`**（`requirements.txt` 是 `uv export` 的**只读导出产物**，
带 hash，给 CI/容器用；**它不再是手改的地方**）。

```powershell
uv sync                 # dev 组（含 pytest）；build_backend 会自动补装 build 组
```

装出来的环境就是**发布环境**：`pytest` 在 `dev` 组、`PyInstaller` 在 `build` 组，
两者都**不进**冻结产物（这是"用户拿到的包"与"开发机装的包"第一次真正分开）。

- `scripts/build_backend.py` 会**拒绝在非 `.venv` 环境里构建**，并在构建前用
  `uv sync --frozen --dry-run` 复核"环境与锁文件一致"——不一致直接停。
  这是为了修掉一个真实缺口：迁移之前 `requirements.txt` 只有 `>=`，
  **冻结出来的 exe 装的是"跑构建那天的版本"**，产物不可复现。
- 加依赖的姿势：改 `pyproject.toml` → `uv lock` → `uv sync` → `uv export --frozen --no-dev --no-emit-project --no-annotate --format requirements.txt -o requirements.txt`。
  **依赖更新单独一批**，别混进功能批次（一次切换实测把 `uvicorn` 0.46→0.54、`starlette` 0.4x→1.7 抬了上来，需要整套回归）。

> 💡 **大多数改动不用走这一步**：后端/登录/首启类改动用
> `python scripts/dev_check.py`（约 20 秒）就能验完，详见 `docs/DEV-LOOP.md`。
> 只有动到 Rust 壳 / `tauri.conf.json` / 需要确认安装包布局时才必须整包重建。

**应用内更新（R23 起）**：`tauri:build` 会额外产出更新载体与其签名，**必须先提供签名私钥**，
否则这一步直接失败（密钥从哪来、怎么保管见 §3.1）：

```powershell
cd frontend
$env:TAURI_SIGNING_PRIVATE_KEY          = (Get-Content -Raw 'E:\work\Project\ddtoolkit-updater.key')
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw 'E:\work\Project\ddtoolkit-updater.password.txt')
npm run release
```

`release` = `build:backend`（PyInstaller onedir → `src-tauri/binaries/backend/`）
→ `tauri:build`（前端构建 + Rust release + NSIS 安装包，**实测 6m09s**）
→ `collect:release`（聚合到 `dist-release/`：安装包 + 便携 zip + **`latest.json`**）。

> ⚠️ **后端产物的体积以构建输出为准，不在这里写死**（它是测量值）。
> 但有一条**方向性事实**值得知道：2026-09-25 切到 `uv.lock` 并显式区分运行/开发依赖之后，
> 产物**明显变小**（旧记录 118.8MB → 实测 71.7MB），因为 `pytest` / `PyInstaller` /
> `werkzeug` / `email_validator` / `numpy` 这些**本来就被误打进去的包不再进冻结产物**了
> —— 出包后跑一次 `python scripts/release.py <版本> --only verify`，以它报的数字为准。

**验证产物**：

```powershell
python scripts/release.py 1.0.2 --only verify        # 含更新清单校验，见下
Get-ChildItem dist-release | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB)}}
# 期望三个文件（**大小随依赖增长，不写死**，看上一条命令的实际输出）:
#   DDtoolkit_<新版本>_x64-setup.exe   ← 也是应用内更新的**载体**（见 §3.1）
#   DDtoolkit-portable-win64.zip
#   latest.json                       (更新清单：版本 / 说明 / url + 签名)
# 若出现旧版本安装包残留（如 1.0.1），删除之
```

### 3.1 应用内更新：签名密钥与更新产物（R23，**下次发版必读**）

**更新载体就是安装包本身**。Tauri 的 Windows/NSIS 更新流程是"下载安装包 → 静默运行它"，
所以 `tauri:build` 产出的是：

| 文件（在 `frontend/src-tauri/target/release/bundle/nsis/`） | 是什么 |
|---|---|
| `DDtoolkit_<版本>_x64-setup.exe` | 安装包，**同时是更新载体** |
| `DDtoolkit_<版本>_x64-setup.exe.sig` | 它的 minisign 签名（`bundle.createUpdaterArtifacts: true` 才有） |

⚠️ **没有 `*.nsis.zip`**（2026-09-16 真机构建实测确认）。最初按 zip 写，症状是
**`latest.json` 一直生成不出来**（脚本在找一个不存在的文件）——排错时先看这一条。

`collect:release` 会把签名**嵌进** `dist-release/latest.json`（`platforms.windows-x86_64.signature`），
`url` 指向 `releases/download/v<版本>/DDtoolkit_<版本>_x64-setup.exe` —— 注意是**版本化的地址**，
不是 `latest/download`（后者会让旧版本客户端下到新包却配旧签名，且只在下次发版才暴露）。

**密钥（仓库外，务必与代码分开备份）**：

```
E:\work\Project\ddtoolkit-updater.key            私钥（构建时用；丢了就再也发不了更新）
E:\work\Project\ddtoolkit-updater.password.txt   密码（32 位随机；丢了同样发不了）
E:\work\Project\ddtoolkit-updater.key.pub        公钥 → 已写进 tauri.conf.json 的 plugins.updater.pubkey
```

- 生成（**在仓库外**，`--password=` 的空值在非交互下走不通，见下）：
  `npx tauri signer generate -w <仓库外路径> --password=<密码> --force`
- 构建时给的是**私钥内容**（`TAURI_SIGNING_PRIVATE_KEY`）而不是路径 —— CLI 这版不认 `_PATH`；
- ⚠️ **密码不能为空**：空密码时 CLI 会**直接从终端读密码**（绕过 stdin），在脚本/CI 里表现为
  **无输出地挂住**（实测 180 秒无返回）。PowerShell 里 `$env:X = ''` 其实是**删除**变量，
  同样会被当成"没提供密码"。所以：私钥必须有密码，且构建时用 `Get-Content -Raw` 喂进去。
- **公钥必须与签名私钥成对**：换了密钥就要同步改 `tauri.conf.json` 的 `pubkey`
  （否则客户端校验失败、更新装不上），并重打产物。

**校验**（`release.py --only verify` 已内置）：版本一致 · 签名非空 · `url` 以安装包名结尾 ·
该安装包在产物目录里；另外旧的 `latest.json`/旧版本安装包残留都会被拦下。

**验证「后端目录没被安装包打平」**（2026-09-08 事故，见 devlog/036）：

```powershell
# 安装脚本里的安装目标必须保留 _internal/ 层级
Select-String frontend/src-tauri/target/release/nsis/x64/installer.nsi `
  -Pattern '/oname=binaries\\backend\\_internal' | Measure-Object   # 期望 ≈851 行（v1.0.0 实测 890）
# 打平（oname 不含 _internal 但源在 _internal）的行数必须为 0
(Select-String frontend/src-tauri/target/release/nsis/x64/installer.nsi `
  -Pattern '/oname=binaries\\backend\\[^\\]+"\s+"[^"]*_internal' | Measure-Object).Count
```

> ⚠️ 这两条判据**在真实文件上验过一次**才算数（`tests/test_release_script.py` 里有一条
> 拿本机 `installer.nsi` 直接量的用例）。真实行形状是
> `File /a "/oname=binaries\backend\_internal\MSVCP140.dll" "E:\…\_internal\MSVCP140.dll"`
> —— 目标路径**带引号**；判据少写那个引号就会永不命中，"打平行 = 0" 变成一句空话。
> `release.py verify` 现在自动跑这两条，并把行数打进报告。

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

> ✅ `release.py` 的 `commit` / `tag` / `push` 三步就是这段，并额外做两件事：
> 推送**代理/直连自动切换 + 各重试 2 次**（`RELEASE.md` §6 的两种网络环境都走过），
> 推完用 `ls-remote` **复核 tag 真在远端**才继续（Release 不许抢跑）。

### 4.2 创建 Release（API）

推荐用 Python 脚本（避免 PowerShell/curl 中文与 TLS 问题）——**通用脚本**：

`scripts/upload_release_assets.py`（见 §5），支持：创建 Release + 上传两个资产 + 输出 Release URL。

也可手动方式：浏览器 → `https://github.com/Mrslippe/DDToolkit/releases/new` → 选 tag → 粘贴 release notes → 拖入两个资产 → Publish。

### 4.3 Release 描述（notes）

每次发布写 `docs/releases/v<版本>.md`（历史版本即 v0.9.1 / v0.9.2 的范本）。

---

## 5. 可复用脚本

### `scripts/upload_release_assets.py`

调用（token 走环境变量，不落盘）：

```powershell
$env:GITHUB_TOKEN = "ghp_xxx"
python scripts/upload_release_assets.py v0.9.2
```

行为（**幂等**，2026-09-15 起，devlog/084）：
1. 校验 `GITHUB_TOKEN` 与 tag（`git ls-remote` **带 §6 定案参数**：裸调用会撞
   `schannel: SEC_E_NO_CREDENTIALS`，2026-09-08 实测；代理不通会自动再试直连）
2. Release **已存在则复用**（`GET /releases/tags/<tag>`）并用 notes 文件内容 `PATCH` 覆盖描述；
   不存在才新建（描述读 `docs/releases/v<版本>.md`，兼容旧的 `docs/release-notes-v<版本>.md`）
3. 上传 `dist-release/DDtoolkit_<v>_x64-setup.exe` + `DDtoolkit-portable-win64.zip`；
   **同名资产已存在且大小一致 → 跳过**，大小不同 → 删旧重传（重打版后续跑的常态）
4. 复核远端资产列表并打印 Release URL

> 幂等的意义：发布中途失败（网络/TLS/资产没打完）时重跑不会撞 422 `already_exists`，
> 也不会落下半份资产 —— `release.py --from release` 依赖这一点。
> 若描述写错，直接重跑即可覆盖（v0.9.2 时是手工 `PATCH` 修的，现在自动）。

输出示例：
```
[1/5] token 有效 (login=…)
[2/5] tag v1.0.1 已在远端（0acdbce…）
[3/5] Release created  (id 389029336)，描述来源 v1.0.1.md
[4/5] 上传 DDtoolkit_1.0.1_x64-setup.exe ... OK (56.3 MB)
[4/5] DDtoolkit-portable-win64.zip 已存在且大小一致，跳过（70.3 MB）
[5/5] 远端资产: ['DDtoolkit-portable-win64.zip', 'DDtoolkit_1.0.1_x64-setup.exe']
      https://github.com/Mrslippe/DDToolkit/releases/tag/v1.0.1
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

> 前两条与最后一条 `release.py` 已自动做完并把实测值写进
> `dist-release/release-report-<版本>.md`（含可直接粘进 devlog 的执行记录表）。
> **装一次直装版 / 便携版这两条脚本做不了**（要人工点安装向导与扫码），
> 每次发布都要你亲自过一遍。

---

## 8. 语义约定（一键为主，分步兜底）

| 动作 | 命令/方式 |
|---|---|
| **一键发布**（推荐） | `python scripts/release.py <版本>`（`--bump` / `--dry-run` / `--from` 见 §0） |
| 只查版本号一致性 | `python scripts/release.py --check-version` |
| 版本号同步 | 由 `release.py version` 自动做（清单 = `VERSION_FILES`，见 §2） |
| 构建 | `npm run release --prefix frontend`（完整权限） |
| 推代码 | `git push`（GCM 授权后免 token） |
| 推 tag + 建 Release + 传资产 | `scripts/upload_release_assets.py v<版本>`（token 走环境变量，幂等） |
| 浏览器兜底 | 手动 upload（§4.2） |
