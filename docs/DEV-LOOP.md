# 开发态快速验证（DEV-LOOP）——不打包也能验证改动

> 起因（2026-09-08）：连续两个 bug（NSIS 资源打平、扫码轮询读错字段）都只能靠
> `npm run release`（PyInstaller + cargo + NSIS，4–6 分钟）出包后人工试出来，
> 一轮排查要十几分钟。实际上**绝大多数改动都不需要整包重建**——把「要验的状态」
> 搬到能秒级复现的环境里即可。

## 一、先分清「要验的是什么」

打包版之所以会坏，通常不是因为「打包」本身，而是因为打包版才具备的状态：

| 打包版独有的状态 | 开发态默认没有 | 怎么在开发态复现 |
|---|---|---|
| 全新数据目录（无 `.env` / 空库） | 项目根 `.env` + 老库 | `DDTOOLKIT_DATA_DIR=<空目录>` |
| 冻结运行时（PyInstaller `_internal`） | 源码直跑 | `python scripts/build_backend.py` 后直接跑 exe |
| Tauri 资源映射（installer 布局） | 无 | 只有它需要整包重建（改 `tauri.conf.json` 时） |
| 前端产物（`dist/` 打包进 exe） | Vite dev server | `npm run dev` + `VITE_API_BASE` 指到后端 |

**结论**：后端逻辑 / 登录 / 首启 / 迁移类改动 → 秒级或 1 分钟级就能验完；
只有动到 Rust（`src-tauri/src`）、`tauri.conf.json`、或需要真机确认前端产物时才整包重建。

## 二、一条命令的快速自检

```powershell
python scripts/dev_check.py             # 单测 + 开发态后端冒烟（约 20 秒）
python scripts/dev_check.py --frozen    # 追加：冻结后端 exe 冒烟（需先 build_backend，约 1 分钟）
python scripts/dev_check.py --portable  # 追加：重打便携 zip（免 cargo/NSIS，约 2 分钟）
python scripts/dev_check.py --full      # = --frozen --portable
```

它做三件事：

1. `pytest tests/` —— 204 个用例的回归网（含 B 站扫码四态、同名 cookie 冲突、
   账号白名单回填、首启标记等回归用例）；
2. **空数据目录**起后端（源码或冻结 exe）→ 验 `/healthz` + 扫码状态机
   （`qr/start` → 连续 `qr/check` 必须停在 `waiting`，防「读错 code 字段」回归）；
3. 需要时重打便携 zip。

失败时会把现场数据目录打印出来（`console.log` / `logs/sidecar.log`）便于定位。

### 桌面端图标（LOGO 变更后重生成）

```powershell
python scripts/make_icons.py     # 从 docs/design/png/NGNlogo无底.png 生成
```

品牌粉圆角底 + 白猫脸，输出 `frontend/src-tauri/icons/`（含多尺寸 `icon.ico`、
`icon.png`、Windows 商店 `Square*Logo.png`、`icon.icns`）。改 LOGO 后跑一次即可。

## 二·五、布局类改动的机器验证（`scripts/ui_probe.py`）

布局问题（原生滚动条、内容出窗、出现滚动条导致宽度跳动）肉眼难复现、打包才暴露。
2026-09-08 起固化为可复跑的探针：

```powershell
python scripts/ui_probe.py                          # 1100 / 1280 / 1440 三档宽度
python scripts/ui_probe.py --width 1100             # 指定宽度
python scripts/ui_probe.py --first-run --width 1100 # 空数据目录：验首启登录浮窗
```

它自动：复制开发数据目录 → 起后端 → 起 Vite → 无头浏览器加载
`/vtubers/<id>?probe=1`（`frontend/src/dev/probe.ts` 会依次切四个视图、并在列表页
额外点一次「投稿」筛选，共五段测量），断言五组不变量：

| 不变量 | 含义 |
|---|---|
| `scrollbarPx == [0,0]` | 文档层永不出现滚动条（窗口级滚动条 = 内容宽度跳 12px 的根源） |
| 无可见出窗元素 | 没有元素越过窗口左右缘（被 `overflow:hidden` 裁掉的折叠组不算） |
| 无容器横向溢出 | `overflow-x:auto/scroll` 容器不得 `scrollWidth > clientWidth`（白名单：`.type-chips` 有意横滚） |
| 无原生滚动条 | 滚动容器统一 OverlayScroll，否则出现/消失会挤动布局 |
| 列表卡片列宽契约 | 列表页 `.list-inner` ≤ 900px、卡片铺满该列且宽度一致、封面恒 220 且不被左缘裁切（2026-09-08 回归事故固化：OverlayScroll 插层让 `.list-scroll > .list-inner` 静默失效，列宽随内容在 566～1350px 之间乱跳） |

`--first-run` 额外断言：空数据目录下 `?firstRun=1` 必须**自动弹出登录浮窗**，
且浮窗内含「凭据仅保存在本机」说明。

⚠️ 需要完整权限（Vite 的 esbuild 与无头浏览器在受限沙箱会失败）；失败时保留
`_ui_probe_tmp/`（含 DOM dump 与截图用的 profile 目录）供定位。

## 三、手动复现打包版状态（脚本没覆盖时）

```powershell
# ① 全新数据目录跑后端（验首启迁移 / 登录 / 抓取）
$env:DDTOOLKIT_DATA_DIR = "E:\tmp\dd-fresh"
$env:DDTOOLKIT_PORT = "8131"
python backend_main.py

# ② 验冻结运行时（PyInstaller 相关，如 alembic 资源缺失）
python scripts/build_backend.py
$env:DDTOOLKIT_DATA_DIR = "E:\tmp\dd-fresh2"; $env:DDTOOLKIT_PORT = "8132"
frontend\src-tauri\binaries\backend\ddtoolkit-backend.exe

# ③ 验前端（对着上面的后端跑 dev server，浏览器打开即可）
cd frontend; $env:VITE_API_BASE = "http://127.0.0.1:8131"; npm run dev

# ④ 免安装包验证「打包后的应用」（后端热替换：便携版直接换 binaries\backend）
python scripts/build_backend.py
python scripts/collect_release.py --portable-only     # 重打 dist-release\DDtoolkit-portable-win64.zip
```

## 四、什么时候必须整包重建

- `frontend/src-tauri/src/*.rs`（Rust 壳）、`tauri.conf.json`（窗口/资源/CSP）；
- 需要确认**安装包布局**（如本次 `_internal` 事故）——只有 `npm run tauri:build`
  产出的 `installer.nsi` / setup.exe 能反映；
- 发布前（`docs/RELEASE.md` §3 的三步 + §3 的产物校验）。

## 五、新增回归用例的约定

修 bug 时**先补用例**（`tests/test_auth.py` 等），命名里带现场信息，注释写清「用户看到什么 /
根因是什么」，例：

```python
def test_bili_poll_reads_inner_data_code():
    """回归（2026-09-08 实机）：扫码状态在 data.code，外层 code 恒为 0。..."""
```

这样下次同类问题在 `pytest` 里 6 秒就能拦住，不必等出包。
