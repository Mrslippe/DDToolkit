# 084-20260915-一键发布脚本（release.py）与幂等 Release 上传

> 用户：「那把打版、推送、更新 release 整个流程给写成一个自动化脚本吧，之后直接调用这个脚本就行。」
>
> 方案确认时三个口径拍板：① 版本号**显式传** + `--bump` 兜底；② 门禁默认跑
> pytest/tsc/eslint/vitest，探针 `--probes` 选开；③ token **只走环境变量**，
> 推送优先走 GCM，没有才把 token 拼进 URL。

---

## 一、为什么值得做

发布原是 8 步手工流程（`docs/RELEASE.md`），每次要盯十几分钟，而**每一步都有静默错法**：

| 手工步骤 | 错了会怎样 |
|---|---|
| 版本号改 6 处 | 漏一处 → 安装包名/程序版本/前端包版本互相不一致（历史上真发生过 0.8.0 / 0.1.0） |
| `Cargo.lock` 同步 | **盲替字符串会改掉依赖版本**（`serde = "1.0.0"` 与项目同版本），锁文件一坏后面全崩 |
| 产物形态校验 | 安装脚本把后端目录"打平"→ 装完起不来、启动幕永久卡住（devlog/036） |
| tag / 推送 | tag 没推上去就建 Release → 指向不存在的 tag；tag 覆盖 → 已发布的东西被换掉 |
| Release 上传 | 中途失败重跑撞 422 `already_exists`，或落下半份资产 |

所以这不是"省几条命令"，而是**把每一步的判据固化下来**。

## 二、做了什么

### 2.1 `scripts/release.py`（新，编排层）

十步：`preflight → version → gates → build → verify → commit → tag → push → release → report`，
**不重写已有脚本**，而是复用 `npm run release`（= `build_backend.py` + `tauri build` +
`collect_release.py`）与 `upload_release_assets.py`。

关键设计：

- **失败即停且不写文件**：`preflight` 全是只读检查（分支、工作树、工具链、发布说明、
  版本号一致性、GitHub 可达性、token）；不满足就在**没动过任何东西**的状态下退出；
- **定点替换**：六处版本号各有一条锚点正则，`Cargo.lock` 只认 `name = "ddtoolkit"` 块；
  锚点找不到就**报错**（宁可停，不静默漏改）；
- **续跑**：每个失败都打印 `--from <步骤>`；`tag` 已存在且指向 HEAD 时按续跑处理，
  指向别的提交则拒绝（**不覆盖已发布的 tag**）；
- **幂等**：`release` 步骤调的上传脚本改成"已存在则复用 + PATCH 描述 + 补传缺失资产"，
  所以网络抖动后重跑不会撞 422，也不会落下半份资产；
- **产物形态是机器判据**：资产大小区间、旧版本残留、NSIS 打平行数、便携包结构、
  主程序 `FileVersion` 全部实测，报告落 `dist-release/release-report-<版本>.md`（gitignore 内）。

常用的四个入口：

```powershell
python scripts/release.py 1.0.1            # 完整发布
python scripts/release.py --bump patch     # 版本号自动 +1
python scripts/release.py 1.0.1 --dry-run  # 只预检 + 打印计划（含将改的文件），不动任何东西
python scripts/release.py --check-version  # 只校验六处版本号一致
```

### 2.2 `scripts/upload_release_assets.py`（改：幂等）

- Release 已存在 → `GET /releases/tags/<tag>` 复用 + `PATCH` 覆盖描述（此前描述写错要手工 PATCH，
  v0.9.2 就这么修过一次）；
- 资产：同名同大小**跳过**、同名不同大小**删旧重传**（重打版后续跑是常态）；
- 收尾复核远端资产列表 —— 少一个就是"用户下不到包"，不能只看上传返回。

## 三、这次踩到的判据陷阱（值得单独记一笔）

写 NSIS 判据的用例时，我按"想当然"的行形状造了样本，结果是**绿的**；
但把判据拿去量**真实** `installer.nsi`（本机 v1.0.0 构建产物）时才发现形状是：

```
File /a "/oname=binaries\backend\_internal\MSVCP140.dll" "E:\…\backend\_internal\MSVCP140.dll"
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 目标路径**带引号**
```

引用 `docs/RELEASE.md` §3 里那条正则时，我的样本漏了 `/oname=` 前面的引号 →
正则永不命中。也就是说：**"打平行 = 0" 完全可能是"正则根本不对"**，
而它长得跟"真没打平"一模一样（正是本仓反复出现的那个模式：安静地失败）。

处理：

1. 用例的行形状**改为照抄真实文件**，并新增一条**拿本机 `installer.nsi` 直接量**的用例
   （`kept > 0` 且 `flattened == 0`）——判据自己要能被真实数据证伪；
2. `classify_nsis` 的 docstring 里贴上真实行形状 + "别漏那个引号"的警告；
3. `docs/RELEASE.md` §3 的手工判据下补同一句提醒。

顺带确认：本机 v1.0.0 的安装脚本 **890 行保留 `_internal`、打平 0 行** ——
即之前那条"0"是真的 0（这次有真文件撑着）。

## 四、验证

| 项 | 结果 |
|---|---|
| `tests/test_release_script.py` | **28 项**新增（版本号解析/递增、六处定点替换、**Cargo.lock 不误伤依赖**、锚点漂移必须报错、NSIS 分类、真实 installer.nsi、发布说明校验、步骤表与 `step_*` 一一对应、步骤选择与依赖摘除） |
| `--check-version` | 六处实测全 `1.0.0`，exit 0 |
| `--bump patch --dry-run` | 算出 `1.0.1`、打印十步计划、在设计好的"工作树脏"处停下（exit 1，附续跑命令） |
| `--dry-run --allow-dirty` | 前进到"缺发布说明 docs/releases/v1.0.1.md"处停下（另一条守卫） |
| `--only verify` | 拿现存 `dist-release/`（v1.0.0 产物）真实量：便携包 70.3MB/892 条目、**NSIS 保留 890 / 打平 0**；并按预期报出"缺 1.0.1 安装包 / 旧版本残留 / 主程序 FileVersion=1.0.0≠1.0.1" |
| 参数校验 | `--from nope` 洁净报错（不打 traceback）；`release.py 1.0.0`（不递增）被 preflight 拦下 |

## 五、留给用户的（脚本刻意不做）

- **装一次直装版 + 便携版解压启动**：要人工点安装向导、扫码登录，脚本代做不了（RELEASE.md §7）；
- **PAT 吊销**：token 进过对话/日志就吊销 —— 报告文件末尾每次都会提醒；
- **发布说明与 devlog 的内容**：`preflight` 只校验"存在且不像占位符"，写什么是人的事。

## 六、下一步（没做，等需求）

- 目前 `--probes` 跑的是本机开发数据目录的探针五模式（默认 `--vtuber 15`），
  换机器要带 `--probe-vtuber`；若以后要进 CI，得先解决"探针需要一份有数据的开发库"。
