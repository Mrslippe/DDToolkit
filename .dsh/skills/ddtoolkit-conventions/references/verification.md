# DDToolkit 验收 / 门禁命令（到哪查）

> ⚠️ **逐字命令的真源是脚本自己的 `--help` 与 `docs/DEV-LOOP.md`** —— 本文件只留"去哪查"、三条探针陷阱与两条口径提醒。
> 命令与模式随批次加，抄在这里就是给自己埋第二个漂移点（实测：本文件曾写 `--full = --frozen --portable`，实际还有 `--docs --upstream`）。
> 工作目录：仓库根（前端命令用 `--prefix frontend` 或先 `cd frontend`）。

| 要验什么 | 去哪查（真源） |
|---|---|
| 一把梭：单测 + 后端冒烟 + 前端 logic（`--frozen` / `--portable` / `--docs` / `--upstream` / `--full`） | `python scripts/dev_check.py --help`（DEV-LOOP §二） |
| 按改动档位选门禁（C / B / A / full） | `python scripts/gate.py`（DEV-LOOP §0.6） |
| 布局 / 交互探针 —— **模式表就是 help 串**（每加一个 flag 都不用手改两处） | `python scripts/ui_probe.py --help`（DEV-LOOP §二·五） |
| 前端门禁（lint / vitest / `check:dates`；类型与词云 sha 见 `docs/TODO.md` §6.2） | `frontend/package.json` 的 `scripts` |
| 真上游冒烟（`--cold` / `--capture`） | `python scripts/smoke_upstream.py --help`（DEV-LOOP §二·六） |
| 文档漂移门禁 | `scripts/doc_check.py` 的 `CHECKS`（DEV-LOOP §二·七） |
| 未登录能力边界 | `scripts/capability_matrix.py`（DEV-LOOP §二·八） |
| 第三方数据"抓不下来"的定性 / 看日志 | DEV-LOOP §二·六 |
| 手动复现打包版状态（冻结 exe / 免安装包） | DEV-LOOP §三 / §四 |

## 基线数字（本文件不复述）

后端回归本身仍是 `python -m pytest -q`，桌面壳是 `cargo test`（工作目录 `frontend/src-tauri`）。
**基线（pytest / cargo / vitest / 探针 / 上游冒烟）只在 `docs/TODO.md` §6.2「当前门禁基线」维护。**
⚠️ 这里曾写死过用例数快照 —— 早就漂了，而**门禁查不到散文里的数字**。**现场实跑优先。**

## 探针三条最容易踩的陷阱（其余全在 `ui_probe.py` / `probe.ts` 的注释与 help 里）

1. **位级签名含实时数据**：`--hero-expect` / `--calendar-expect` 只适合"改动前后短窗口对比"；
   `--calendar-expect` **跨天必然失败**（「待定/休息」按 `key < todayKey` 翻转）。
2. **会写盘 / 种数据的模式跑在数据目录副本上**（`--settings` / `--app-settings` / `--reservations`），绝不碰开发库。
3. **量不到 ≠ 通过**：取值一旦为 `null`（选择器踩空）直接判失败；探针跑在**虚拟时间**下 ——
   量"有没有生效"先注入 `animation:none; transition:none`，量"动画对不对"才让它开着。

## 口径提醒

1. **哪些数字不可派生 → 不写死，也没有门禁**：用例数（实跑 `passed`）就属这类 ——
   `gen_doc_numbers.py` 只能数 `def test_` 的**静态条数**，参数化会展开、环境差异会产生 error，
   拿它当判据必然假红。用例数的真源只有 `docs/TODO.md` §6.2，**现场实跑优先**。
2. **路由的三种数法**（装饰器 / `app.routes` 对象 / 方法×路径）：那三个数是**测量值**，会随批次漂 ——
   口径表与当前值见 `docs/backend-repositories-and-routers.md` §3
   （只有「装饰器」那一种有门禁，另两种要人肉重数，复核命令也在那节）。
