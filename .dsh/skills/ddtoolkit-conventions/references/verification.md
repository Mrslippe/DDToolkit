# DDToolkit 验收 / 门禁命令全表

> 命令**逐字**取自 `docs/DEV-LOOP.md`（标注「DEV-LOOP §x」）与 `docs/TODO.md` **§6.2 当前门禁基线**
> （标注「TODO §6.2」）。两者不一致时不合并、照实并列，见文末「口径提醒」。
> 工作目录：仓库根 `E:\work\Project\DDToolkit`（前端命令用 `--prefix frontend` 或先 `cd frontend`）。

---

## 0. 一把梭（先跑这个）

```powershell
python scripts/dev_check.py             # 单测 + 开发态后端冒烟（约 20 秒）
python scripts/dev_check.py --frozen    # 追加：冻结后端 exe 冒烟（需先 build_backend，约 1 分钟）
python scripts/dev_check.py --portable  # 追加：重打便携 zip（免 cargo/NSIS，约 2 分钟）
python scripts/dev_check.py --full      # = --frozen --portable
```

DEV-LOOP §二：它做三件事 —— ① `pytest tests/`；② **空数据目录**起后端 → 验 `/healthz` + 扫码状态机
（`qr/start` → 连续 `qr/check` 必须停在 `waiting`）；③ 需要时重打便携 zip。失败时会把现场数据目录
打印出来（`console.log` / `logs/sidecar.log`）。
同节「前端 logic」三项已并入本命令：`npm run lint`（`--max-warnings 0`）、`npm run test`（vitest）、
`npm run check:dates`；缺 `frontend/node_modules` 时显式打印 `[skip]` 而非静默通过。

其它 `dev_check.py` 开关（取自 DEV-LOOP 各节）：

```powershell
python scripts/dev_check.py --docs      # 文档漂移门禁（DEV-LOOP §二·七）
python scripts/dev_check.py --upstream  # 接进一把梭（真上游 + 冷进程各一次）（DEV-LOOP §二·六）
```

## 1. 后端单测 / 门禁基线

```powershell
python -m pytest -q
```

- **基线数字只在 `docs/TODO.md` §6.2 维护，本文件不复述**（2026-09-23 改）。
  ⚠️ 此前这里写死过「**434 passed**」—— 早就漂到 578 了，而门禁查不到散文里的数字。
  `DEV-LOOP.md` §二 也是同样处理（只写"基线只在 §6.2 维护"）。**现场实跑优先。**
- 分项构成（哪些用例来自哪个批次）在 `docs/TODO.md` §6.2 那一行的括号里，不在这里重复。
- 另有桌面壳门禁：`cargo test`（工作目录 `frontend/src-tauri`），基线同样见 §6.2。

## 2. 前端门禁（TODO §6.2）

```powershell
npx tsc --noEmit                     # 前端类型：0 错（npm run build 也会跑）
npm --prefix frontend run lint       # 前端 lint：0 错（--max-warnings 0）
npm --prefix frontend run test       # 前端单测：基线见 §6.2（本文件不复述数字）
node scripts/check_wordcloud_layout.mjs   # 词云布局：sha256 断言
```

DEV-LOOP §二·五另记一条纯逻辑（无浏览器）通路：

```powershell
node scripts/check_date_range.mjs   # Node 24 类型擦除直读 .ts，30 条断言
```

## 3. 布局 / 交互探针 `scripts/ui_probe.py`（DEV-LOOP §二·五）

```powershell
python scripts/ui_probe.py                          # 1100 / 1280 / 1440 三档宽度
python scripts/ui_probe.py --width 1100             # 指定宽度
python scripts/ui_probe.py --height 680             # 矮窗（视口 ≈541）：验弹窗高度兜底路径
python scripts/ui_probe.py --shot                    # 额外每档宽度存一张「筛选弹窗打开态」图
python scripts/ui_probe.py --archive                 # 只跑一档：dump 直播日历每格实渲染 + 最近一场详情弹窗内容
python scripts/ui_probe.py --first-run --width 1100 # 空数据目录：验首启登录浮窗（走独立契约，不做布局断言）
python scripts/ui_probe.py --vtuber 15 --width 1280  # 指定 V（默认取列表第一条）——用于命中多平台药丸等特定数据形态
python scripts/ui_probe.py --hero-print --vtuber 15  # 只打印 cards 视图 hero 药丸签名与实测明细（建立基线用）
python scripts/ui_probe.py --hero-expect <sha256>    # 位级回归：hero 药丸签名必须与基线一致，否则退出 1
python scripts/ui_probe.py --archive --archive-print --vtuber 15      # 取「日历格内文本」基线（A-2 取数链路护栏）
python scripts/ui_probe.py --archive --calendar-expect <sha256> --vtuber 15  # 重构后比对日历格签名
python scripts/ui_probe.py --archive --archive-day 11 --vtuber 14    # 点指定日号的格子（最近一场常未收录弹幕/热词）
python scripts/ui_probe.py --settings --vtuber 15   # 档案设置弹窗：几何 + **可点性** + 点候选行换来源（两个带签名账号）
python scripts/ui_probe.py --settings --vtuber 14   # 同上但只有一行且签名长：断言渐隐/可滚距离，切换断言打印 [跳过]
python scripts/ui_probe.py --scene --vtuber 15      # 场景切换机（切 V）：预取→退场→提交是否走完 + fetch 全程
python scripts/ui_probe.py --add-v --vtuber 15      # 添加 V 浮窗：本地/上游**来源分流** + 行可命中 + UID 换档
python scripts/ui_probe.py --polish                 # R15 三处前端打磨（devlog/087）
python scripts/ui_probe.py --reservations           # R13 预约进日历（devlog/088）：脚本先往**数据副本**种一条
python scripts/ui_probe.py --capabilities            # 未登录提示：该说的都说了 + 功能没被过度限制
python scripts/ui_probe.py --status-island           # R12a/R12b 顶栏状态岛（devlog/089、090）
python scripts/ui_probe.py --app-settings            # R14a 应用设置（devlog/091）
python scripts/ui_probe.py --filter-pill             # R16 两枚「筛选」浮片逐项对账（devlog/093）
python scripts/ui_probe.py --tray-suspend            # R18 托盘隐藏后的**停表**验证（devlog/095）
```

TODO §6.2 另记一条（DEV-LOOP 尚未收录）：

```powershell
python scripts/ui_probe.py --close-ask    # R20 首次点 ✕ 的询问流程：ask 弹框 → 记住 → 隐藏 → 再点不再问
```

**基线与陷阱**（TODO §6.2 / DEV-LOOP §二·五）：

- 位级基线：`python scripts/ui_probe.py --hero-expect c11548580e73d910ca667047b8120075a4ab121fa3fa098ff6654326ed183666 --vtuber 15`；
  `--archive` 日历签名记录值 **`50b78ec0…`**（2026-09-15 20:5x 实测；17:00 那次 `48519bae…` 的
  差异来自当晚 V15 新落库两场直播 —— **数据漂移、非代码**）。
- `--hero-expect` / `--calendar-expect` 的签名**含实时数据**，只适合"改动前后短窗口对比"，
  **不适合当跨天基线**；`--calendar-expect` **跨天必然失败**（「待定/休息」按 `key < todayKey` 翻转）。
- `--settings` / `--app-settings` / `--reservations` 会写盘或种数据，**跑在数据目录副本上**，绝不碰开发库。
- 探针跑在**虚拟时间**下：量"有没有生效"要先注入 `animation:none; transition:none`，
  量"动画对不对"才让它开着。
- 需要完整权限（Vite 的 esbuild 与无头浏览器在受限沙箱会失败）；失败时保留 `_ui_probe_tmp/`。
- **量不到 ≠ 通过**：取值一旦为 `null`（选择器踩空）直接判失败。

## 4. 真上游冒烟 `scripts/smoke_upstream.py`（DEV-LOOP §二·六）

```powershell
python scripts/smoke_upstream.py              # 真上游（数据目录副本 + 真后端）：B 站检索 /
                                              # uid 直查 / 候选池来源标注 / 池外收录 / 场次上游
python scripts/smoke_upstream.py --cold       # 冷进程：空数据目录 + **清空凭据**，
                                              # 断言未登录时的降级形态（不是"能不能用"）
python scripts/smoke_upstream.py --only bili  # 只跑名字匹配的检查
python scripts/smoke_upstream.py --capture    # 顺带把真实回包刷进 tests/fixtures/
python scripts/dev_check.py --upstream        # 接进一把梭（真上游 + 冷进程各一次）
```

判定口径（DEV-LOOP §二·六）：`[ok]` 真验到了 · `[skip]` **环境不成立没验到**（未登录 / 上游不可用，
**必须打印原因**）· `[FAIL]` 链路真坏了。TODO §6.2 基线：真上游 **5 ok / 0 FAIL**；冷进程
**3 ok / 0 FAIL**（未登录三态）。
⚠️ 池外收录检查会在**副本**里真建一个 V（副本每次重建，不碰真库）。

## 5. 文档漂移门禁 `scripts/doc_check.py`（DEV-LOOP §二·七）

```powershell
python scripts/doc_check.py            # 只读，有 FAIL 退出 1
python scripts/dev_check.py --docs     # 接进一把梭
```

查（2026-09-23 起 **6 项**，完整判据表见 `ddtoolkit-docs-devlog` 技能 §8）：
devlog 索引**有则必填**（编号 > 61；≤ 61 的历史欠账只 WARN）· 索引**无重号** · 索引**无幽灵行** ·
六处版本号一致 · 发布说明与 `docs/README.md` 导航 · **文档数字与代码一致**（`gen_doc_numbers.py`）。
`scripts/release.py` 预检也会调它。基线见 `docs/TODO.md` §6.2。

## 6. 未登录能力边界（DEV-LOOP §二·八）

```powershell
python scripts/capability_matrix.py                    # 两态 × 轻量接口，打印矩阵
python scripts/capability_matrix.py --include-content   # 额外量投稿/动态（**会触发 IP 级 412**，别勤跑）
python scripts/capability_matrix.py --write             # 刷新 tests/fixtures/capability_matrix.json
python scripts/ui_probe.py --capabilities               # 未登录现场的界面提示（数据副本删 .env）
```

三条纪律：① **一个进程只发一条请求**；② 冷态要**显式清空凭据**（shell 里残留的 `BILI_SESSDATA`
会被子进程继承）；③ 匿名探测本身有代价（会脏 IP，**不连累登录态**），默认不量内容接口。

## 7. 第三方数据「抓不下来」的定性（DEV-LOOP §二·六）

```powershell
$env:DDTOOLKIT_DATA_DIR = "$env:APPDATA\com.ddtoolkit.app-dev"   # 必设：否则读项目根的裸跑残留库
python scripts/check_danmaku_fetch.py          # 最近 6 个 danmakus 场次：词云状态 + 事件数 + 耗时
python scripts/check_danmaku_fetch.py 10 --self  # 顺带跑自建路径（v3 原始弹幕 + 分词，很慢）
```

**只读**（sqlite `mode=ro`，不写库不删数据）；全绿退出 0、有失败退出 1，可当探针。
上游会**间歇性变慢**（同一场次同一份代码实测 **1.1s ↔ 15.6s**，2026-09-13 devlog/062）。

看日志（DEV-LOOP §二·六，2026-09-13 起按天轮转，devlog/077）：

```powershell
$log = "$env:APPDATA\com.ddtoolkit.app-dev\logs"
Get-ChildItem $log                                  # app.log（今天）+ app.log.YYYY-MM-DD（最近 7 天）
Get-Content "$log\app.log" -Encoding UTF8 | Select-String -Pattern '\[(ERROR|CRITICAL)\]'
```

⚠️ 两份日志不要混：`app.log` 是**后端**，`sidecar.log` 是**Tauri 启动器**。排查先"按天切一刀"再读。

## 8. 手动复现打包版状态（DEV-LOOP §三）

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

DEV-LOOP §四：**只有**动 `frontend/src-tauri/src/*.rs`（Rust 壳）、`tauri.conf.json`（窗口/资源/CSP）、
或需要确认**安装包布局**时，才必须整包重建（`npm run tauri:build`）；发布用
`python scripts/release.py <版本>`（只想预演加 `--dry-run`），手册 `docs/RELEASE.md`。

## 9. 其它常用一次性命令（DEV-LOOP 各节）

```powershell
python scripts/make_icons.py     # LOGO 变更后重生成前端图标（DEV-LOOP §二）
```

---

## 口径提醒（两处文档不一致，别照抄错了）

1. **用例数**：真源只有 `TODO.md` §6.2；`DEV-LOOP.md` §二 已改成只指向 §6.2、**不再复述数字**
   （2026-09-16 修正，此前那里写「266 个用例」）。**现场实跑优先。**
   ⚠️ 本文件此前在这里写死过「434 passed」—— 那类快照会随批次漂，**已删**，别再写回来。
   用例数**没有门禁**：`gen_doc_numbers.py` 能数出 `def test_` 的**静态条数**，但那不等于实跑
   `passed`（参数化会展开、环境差异会产生 error），拿它当判据必然假红。
2. **`app.routes` 计数**：`backend-repositories-and-routers.md` §3 自带口径说明 ——
   装饰器 **64** / `app.routes` 对象 **70** / 方法×路径 **67**（2026-09-23 实测）。
   `ARCHITECTURE.md`、`docs/README.md`、根 `README.md` 已在 2026-09-16 改成**指向该节**、不再复述数字
   （旧文写「54 个 HTTP 操作」）。
   **只有「装饰器」这一口径有门禁**（`python scripts/gen_doc_numbers.py`，它会连
   `@router.api_route(...)` 一起数）；另两种口径要人肉重数，复核用
   `python -c "import app.main as m; print(len(m.app.routes))"`，**别留着当装饰**。
