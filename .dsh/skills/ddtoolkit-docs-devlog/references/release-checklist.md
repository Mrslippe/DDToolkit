# 发版文档动作清单（release-checklist）

> 权威来源：`docs/RELEASE.md` 与 `scripts/release.py`（源码）。
> 日常发布只需一条命令；下面是它的每一步与**只有文档侧要做的动作**。

## 一、一条命令

```powershell
$env:GITHUB_TOKEN = "ghp_xxx"          # 只建 Release 需要；推代码走 GCM 可省
python scripts/release.py <版本>        # 版本同步 → 门禁 → 打版 → 校验 → 提交/tag → 推送 → Release
python scripts/release.py --bump patch|minor|major   # 不想数版本号时
python scripts/release.py <版本> --dry-run           # 只预检 + 打印计划，**不动任何文件**
python scripts/release.py --check-version            # 只校验六处版本号一致（提交前/CI）
python scripts/release.py <版本> --from <步骤>        # 断点续跑
```

十步：`preflight → version → gates → build → verify → commit → tag → push → release → report`
（`--only` / `--skip` 用逗号分隔；`--probes` 追加 UI 探针五模式约 +8 分钟；`--no-remote-release` 只到推送为止）。

| 步骤 | 干什么 | 守卫（不满足即停，且不写任何文件） |
|---|---|---|
| `preflight` | 分支 / 工作树 / 工具链 / 发布说明 / 版本号一致性 / **文档漂移** / 网络可达 / token | 工作树脏、notes 缺失或不合格、新版本不大于旧版本、**`doc_check` 有 FAIL**、要发布但没 token → 停 |
| `version` | 六处版本号**定点**同步 | 逐文件锚点替换，改完复核六处一致 |
| `gates` | pytest / tsc / eslint / vitest（`--probes` 追加探针） | 任一非 0 → 停 |
| `build` | `npm run release`（§四） | 非 0 → 停 |
| `verify` | 两个资产 + 无旧版本残留 + NSIS 未打平 + 便携包结构 + 主程序 FileVersion | devlog/036 的事故形态在这里被机器拦住 |
| `commit` / `tag` / `push` | `git add -A` + 提交 → `git tag -a v<版本>` → 推分支与 tag | tag 已存在且不指向 HEAD → 停；tag 没推上去 → 停 |
| `release` | `scripts/upload_release_assets.py`（**幂等**） | 无 token / tag 未推 → 停 |
| `report` | 写 `dist-release/release-report-<版本>.md`（gitignore 内） | —— |

> **续跑**：失败时脚本自己打印 `修好后续跑: python scripts/release.py <版本> --from <步骤>`；
> `release` 幂等 ⇒ 重跑不会撞 422 `already_exists`，也不会留下半份资产。

## 二、版本号同步：**6 个锚点**（5 个文件 + README 徽章）

权威清单 = `release.py` 的 `VERSION_FILES`。基准是 `app/core/config.py` 的 `VERSION`，其余向它对齐。

| # | 文件 | 字段 / 形态 | `release.py` 的锚点（定点替换，不做全文 replace） |
|---|---|---|---|
| 1 | `app/core/config.py` | `VERSION: str = "x.y.z"` | `VERSION:\s*str\s*=\s*"([^"]+)"` |
| 2 | `frontend/src-tauri/tauri.conf.json` | `"version": "x.y.z"`（决定安装包文件名） | `"version"\s*:\s*"([^"]+)"` |
| 3 | `frontend/src-tauri/Cargo.toml` | `version = "x.y.z"`（**只改 `[package]` 那处**） | `(?m)^version\s*=\s*"([^"]+)"` |
| 4 | `frontend/src-tauri/Cargo.lock` | `name = "ddtoolkit"` 块下的 `version`（**只动这一块**，同文件里 serde 等依赖也常是别的版本） | `\[\[package\]\]\s*\nname\s*=\s*"ddtoolkit"\s*\nversion\s*=\s*"([^"]+)"` |
| 5 | `frontend/package.json` | `"version": "x.y.z"` | `"version"\s*:\s*"([^"]+)"` |
| 6 | `README.md` | 徽章 `version-x.y.z-ffa2b4` | `version-(\d+\.\d+\.\d+)-` |

⚠️ `RELEASE.md` §2 的标题写「5 处必须一致」，同节正文却写「共 6 处」并列出 6 行 —— **以 6 为准**
（`doc_check.py`、`release.py`、`devlog/084` 都按六处）。

## 三、发布前的文档动作（这几件脚本只**检查**、不代写）

- [ ] **发布说明** `docs/releases/v<版本>.md` 已写：preflight 要求正文 ≥200 字符，
     且不含占位符 `TODO` / `待填` / `xxx` / `<版本>`；它是 Release notes 的来源。
- [ ] **回填 `docs/README.md` §4 的 releases 列表那一行**（每个 `docs/releases/*.md` 都必须出现在那里，
      否则 `doc_check.py` FAIL —— 它就是这么被抓过）。
- [ ] **devlog 已写并提交**：发布批次单独一篇（对照 `082-20260914-v1.0.0发布.md`），
      并在 `docs/ROADMAP-DONE.md`「批次 → devlog 索引」补一行**裸编号**。
- [ ] **`python scripts/doc_check.py` 0 FAIL**（preflight 会自己调一次，FAIL 直接停）。
- [ ] `docs/TODO.md` §1.3 发布状态更新（已发布版本 / Release 链接 / Release 待建等）。
- [ ] 版本号同步结果复核：六处一致 + `ddtoolkit.exe` 的 FileVersion 实测 = 目标版本
      （`verify` 步骤会量，报告里能看到）。

## 四、构建与产物契约（`npm run release`，在 `frontend/` 下）

三步：`build:backend`（PyInstaller onedir → `src-tauri/binaries/backend/`）
→ `tauri:build`（前端构建 + Rust release + NSIS 安装包）
→ `collect:release`（聚合到 `dist-release/`：安装包 + 便携 zip）。

`verify` 步骤的判据：

| 判据 | 期望 |
|---|---|
| 两个资产 | `dist-release/DDtoolkit_<版本>_x64-setup.exe`（20–300 MB）、`DDtoolkit-portable-win64.zip`（25–400 MB） |
| 旧版本残留 | `dist-release/` 里不得留 `DDtoolkit_*_x64-setup.exe` 的旧版本（会让人拿错包） |
| **NSIS 未打平** | `installer.nsi` 里含 `_internal` 的 `oname` 行 > 0，**被打平的行必须 = 0**（v1.0.0 实测保留 890 行；devlog/036 事故形态：装完 exe 起不来、启动幕永久卡住） |
| 便携包结构 | 顶层 `DDtoolkit/` 含 `ddtoolkit.exe`，且含 `binaries/backend/_internal/` |
| 主程序版本 | `src-tauri/target/release/ddtoolkit.exe` 的 FileVersion = 目标版本 |

⚠️ **资源打包契约（勿改回）**：`tauri.conf.json` 的 `bundle.resources` 必须是**数组形式**
`["binaries/backend/**/*"]`；改成 map + glob 形式会让 tauri-utils 只保留文件名、把 `_internal/` 摊平。

## 五、发布后检查（脚本已做前两条与徽章，其余人工）

- [ ] Release 页可访问、两个资产可下载（大小与 `dist-release/` 一致）
- [ ] **装一次直装版**：安装目录 `binaries\backend\_internal\` 存在、首启能越过启动幕
- [ ] 便携版解压启动正常（含 B 站扫码登录能真正拿到凭据）
- [ ] 吊销本次 PAT（token 进过对话/日志即视为泄露；下次重新生成）
- [ ] 本地 `git status` 干净（`dist-release/`、`_nondistribute/` 等均 gitignore）

> 前两条与「README 徽章已更新」`release.py` 自动做完并把实测值写进
> `dist-release/release-report-<版本>.md`（含可直接粘进 devlog 的执行记录表）；
> **装一次直装版 / 便携版脚本做不了**（要人工点安装向导与扫码）。

## 六、网络与凭据（只在排查时用）

- 推送统一加定案参数：`-c http.sslBackend=openssl -c http.sslVerify=false -c http.proxy=http://127.0.0.1:7897`；
  `release.py` 会**代理/直连自动切换 + 各重试 2 次**，推完用 `ls-remote` 复核 tag 真在远端才继续。
- 连不上 GitHub 时按序查：`Test-NetConnection 127.0.0.1 -Port 7897` → `Resolve-DnsName github.com` →
  浏览器能否打开仓库页（`docs/RELEASE.md` §6.3）。
