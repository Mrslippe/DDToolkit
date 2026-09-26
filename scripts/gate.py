# -*- coding: utf-8 -*-
"""按**改动档位**选门禁 —— 把"文档里写的分档纪律"变成机器动作。

## 为什么需要它

`python scripts/dev_check.py` 一把梭里最贵的一步是 pytest（**实测 180–208s**，占它
绝大部分），而前端改动根本碰不到后端测试。2026-09-25 实测一次"改 1 行 CSS + 探针"
的批次：墙上 12 分钟里 **dev_check 独占 208s**，全是纯等待。

## 三条实测事实（都是量出来的，不是估的）

| 命令 | 实测 |
|---|---|
| `ui_probe --width 1100`（**单档**） | 28.3s |
| `ui_probe`（**三档 + 2 张截图**） | 26.6 / 33.8 / 43.3s（首次直接测 **36s**） |
| `npx tsc --noEmit` | **6s** |
| `npm run lint` | **4s** |
| `pytest -q` | 137 / 183 / 194s |
| `dev_check.py`（含 pytest） | 180 / 208s |
| **C 档合计（tsc+eslint+doc_check+探针）** | **46s** |

⚠️ **我自己在这张表上错过一次，值得记**：最初把 tsc 标成 29–40s、lint 标成 28–37s ——
那两个数来自**后台作业的等待时长**（`job_output`），里面含并发争用与排队；
直接跑同一命令是 **6s / 4s**。⇒ **"等待它完成"的时长 ≠ "它跑了多久"**，
量耗时要在命令自己那一侧量（本脚本每步都自测 `dt` 并打印，就是为了不再犯这个错）。

⇒ ① **探针的成本几乎全是固定启动**（起后端 + Vite + 浏览器），单档与三档等价
（28s vs 27s）—— 所以**别为了省时间少跑档，永远跑满三档**（覆盖面白得）。
② 唯一值得切的是 **pytest**：它按"改动碰没碰后端"整块决定，没有中间态。

## 档位（判据是**文件**，不是"看起来像不像 UI"）

| 档 | 触发 | 跑什么 | 实测 |
|---|---|---|---|
| **C** 局部/表现 | 其余一切（样式值、探针、文档、devlog） | tsc + eslint + **探针三档** + doc_check | ~100s |
| **B** 跨层/特性 | `frontend/src/**`（除 `styles/`·`dev/`）· `frontend/package.json` · `docs/UI-MAP.md` | C + vitest | ~140s |
| **A** 数据/契约 | `app/` · `alembic/` · `tests/` · `backend_main.py` | B + pytest | ~320s |
| **全量** | `--tier full`（发版前 / 拿不准时） | B + `dev_check.py`（含 pytest + 后端冒烟） | ~400s |

⚠️ **拿不准就往上一档靠**（本仓规矩）：路径认不出来 → 按 B 处理并打印理由。
⚠️ **档位映射本身会写错**，所以 `--plan` 会把"哪条路径把档位顶上去的"打出来；
   收尾时（或每隔几批）用 `--tier full` 兜一次。

用法：
    python scripts/gate.py                 # 自动判档并执行
    python scripts/gate.py --plan           # 只说要跑什么，不执行
    python scripts/gate.py --tier b         # 强制 B 档
    python scripts/gate.py --base origin/main
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"


def project_python() -> str:
    """跑子步骤用的解释器：**优先项目 venv**（2026-09-25，devlog/197）。

    为什么不能直接用 `sys.executable`：依赖的真源变成了 `uv.lock`，而"按锁装出来的环境"
    是仓库根的 `.venv`。用户完全可能用系统 Python 调本脚本（`python scripts/gate.py`），
    那时 `sys.executable` 指向的是**另一套版本**——pytest 会用错的依赖跑，
    甚至因为缺包直接崩（实测：缺 `python-multipart` 时 4 个测试文件收集失败）。
    ⇒ 有 `.venv` 就用它；没有就退回 `sys.executable`（不强迫每个人先装环境）。
    """
    venv_py = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return str(venv_py) if venv_py.exists() else sys.executable


PY = project_python()

# ── 档位判定：路径前缀 → 归属 ────────────────────────────────────────────────
# A：只有这些能让 pytest 有意义（后端代码 / 后端测试 / **有 pytest 护栏的脚本** / **Rust 壳**）
#
# ⚠️ `frontend/src-tauri/` 归 A 档而不是 B/C（2026-09-25，devlog/197）：
#    原先它落 C 档 ⇒ 只跑 tsc + eslint + 探针 + doc_check，**一行 Rust 都不编译**。
#    而 Rust 侧住着**全仓唯一一条不可逆的破坏性操作**（`lib.rs::delete_old_data_dir`
#    一次调用 `remove_dir_all`）与整个进程生命周期（sidecar 启停 / Job Object / 托盘 /
#    深休眠 / 窗口重建）。改它而不跑 `cargo test` 是本仓最贵的一种"改对了没人知道"。
#    **它同时顶掉 B 档的 `frontend/src/` 前缀匹配**：`src-tauri/` 不在 `frontend/src/` 下，
#    所以这两条前缀不重叠，但判定是"命中即返回"，A 组必须排在 B 组之前（`pick_tier` 已如此）。
A_PREFIXES = ("app/", "alembic/", "tests/", "frontend/src-tauri/")
A_FILES = (
    "backend_main.py",
    # ⚠️ 2026-09-25 补（**这个漏洞是被本仓自己的改动方式抓到的**）：原先 `scripts/**`
    #    一律落 C 档，于是改 `doc_check.py` 的判据逻辑时**不会跑 pytest** ——
    #    而它恰恰是被 `tests/test_doc_check.py`（24 条）与 `tests/test_release_script.py`
    #    守着的。**档位映射漏一格 = 那个文件从此没人守**，而且不会自己响。
    #    其余 `scripts/*.py` 仍留 C 档：它们的护栏是"跑它自己"（如 `ui_probe.py`）。
    "scripts/doc_check.py",      # ← tests/test_doc_check.py
    "scripts/gen_doc_numbers.py",  # ← doc_check #5 转调它（数字门禁本体）
    "scripts/release.py",        # ← tests/test_release_script.py
    "scripts/gate.py",           # ← tests/test_gate.py（档位映射自身的用例）
    # 开发态 token 的单源与调用方覆盖（2026-09-26，devlog/203）：
    #   S1 加了门禁之后，**打自己后端的开发态脚本逐个失效**（探针/dev_check/smoke/perf_report），
    #   而症状分别伪装成"布局坏了 / 网络不可达 / 上游挂了"。现在这四者由
    #   `tests/test_dev_token.py` 的结构判据守着 ⇒ 改它们要跑 pytest 才有意义。
    "scripts/dev_token.py",      # ← tests/test_dev_token.py
    "scripts/dev_check.py",      # ← tests/test_dev_token.py（起后端的脚本必须给 token）
    "scripts/smoke_upstream.py",  # ← 同上
    "scripts/perf_report.py",    # ← 同上
    # 依赖来源（2026-09-25，devlog/197）：改成"依赖来源只认 uv.lock"时立的。
    # 为什么它属于 A 档：这两份文件决定 **CI / 打包 / 用户拿到的运行时到底是哪些版本**
    # （实测一次切换就把 `uvicorn` 0.46→0.54、`starlette` 0.4x→1.7 抬了上来）。
    # 改了它们却只跑 C 档 = 改了运行环境而一条后端用例都没跑。
    "pyproject.toml",
    "uv.lock",
)
# B：前端逻辑、共享令牌与 UI 规格（vitest 覆盖得到；UI-MAP 是"现状真源"，
#    改它意味着版式口径变了，值得把单测也跑一遍）
B_PREFIXES = ("frontend/src/utils/", "frontend/src/components/", "frontend/src/api/",
              "frontend/src/hooks/", "frontend/src/pages/", "frontend/src/dev/")
B_FILES = ("frontend/package.json", "docs/UI-MAP.md", "frontend/src/styles/tokens.css")


def changed_files(base: str) -> list[str]:
    """本次改动涉及的文件（相对仓库根、正斜杠）。含未跟踪的新文件。

    ⚠️ 两个坑（首跑都踩到了，2026-09-25）：
      ① **`core.quotePath`**：git 默认把非 ASCII 路径转义成八进制
         （`devlog/190-…-R46规范审计.md` → `"devlog/190-…/350/247/204…"`），
         于是档位判定与打印都拿到乱码 ⇒ 必须 `-c core.quotePath=false`；
      ② **编码**：Windows 上 `text=True` 按本地代码页（GBK）解码 ⇒ 中文路径直接崩，
         必须显式 `encoding="utf-8"`。
      —— 这两个都不是"退出码能发现"的错误（脚本照样返回 0），**只有看输出才发现**。
    """
    out: list[str] = []
    for args in (["diff", "--name-only", base],
                 ["ls-files", "--others", "--exclude-standard"]):
        r = subprocess.run(["git", "-c", "core.quotePath=false", *args], cwd=ROOT,
                           capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if r.returncode == 0:
            out += [ln.strip().replace("\\", "/") for ln in r.stdout.splitlines() if ln.strip()]
    return sorted(set(out))


def pick_tier(files: list[str]) -> tuple[str, str]:
    """返回 (档位, 理由)。理由要能让人一眼看出是哪条路径顶上去的。"""
    for f in files:
        if f.startswith(A_PREFIXES) or f in A_FILES:
            return "a", f
    for f in files:
        if f.startswith(B_PREFIXES) or f in B_FILES:
            return "b", f
    if files:
        return "c", f"{len(files)} 个文件（都是样式/探针/文档一类）"
    return "c", "无改动（当成 C 档）"


# ── 步骤定义：(名字, 命令, 是否只在某档以上跑, 说明) ─────────────────────────
def steps(tier: str) -> list[tuple[str, list[str], str]]:
    npx = "npx.cmd" if os.name == "nt" else "npx"
    s: list[tuple[str, list[str], str]] = [
        ("tsc", [npx, "tsc", "--noEmit"], "类型检查（实测 6s）"),
        ("doc_check", [PY, "scripts/doc_check.py"], "文档门禁（实测 0–2s）"),
        # ⚠️ 全仓 Python 语法扫描（~1s）：**原先门禁里没有这一步**，而 CI 的 Linux 腿有
        #    （`dev_check.py --syntax-only`）⇒ 2026-09-26 实测被咬了：一个测试文件被写进
        #    UTF-8 BOM，本地 tsc/eslint/doc_check/pytest/gate 全绿、只有 CI 红。
        #    "只有 CI 会红的东西"要么补进门禁、要么写清为什么不在门禁里 —— 这一步只花 1s。
        ("syntax", [PY, "scripts/dev_check.py", "--syntax-only"],
         "全仓 Python 语法（实测 ~1s）"),
    ]
    if tier in ("a", "full"):
        # Rust 壳（devlog/197）。**只在 A 档跑**：改了 `app/` 也跑它是不必要的重复，
        # 而改 `frontend/src-tauri/**` 必然落 A 档（见 A_PREFIXES 的注释）。
        # ⚠️ 首次编译慢（cargo 冷构建分钟级），之后增量秒级 —— 这与"探针成本全在启动"
        #    是两类不同的成本，所以它**不能**像探针那样无脑跑满三档。
        s.append(("cargo", ["cargo", "test", "--manifest-path",
                            str(FRONTEND / "src-tauri" / "Cargo.toml")],
                  "Rust 壳单测（首跑含编译，几分钟；增量秒级）"))
    s.append(
        # ⚠️ **永远跑满三档**：实测单档 28.3s / 三档 26.6s —— 成本全在启动，
        #    少跑档只损失覆盖面、不省时间（2026-09-25 实测）。
        ("ui_probe", [PY, "scripts/ui_probe.py",
                      "--vtuber", "15", "--seed-accounts", "8"],
         "版式不变量（三档 × 10 帧，实测 36s）"),
    )
    if tier == "full":
        # dev_check 自带 eslint + vitest + pytest + 语法扫描 + 后端冒烟 ⇒ 别再单跑一遍
        s.append(("dev_check", [PY, "scripts/dev_check.py"],
                  "一把梭（含 pytest 与后端冒烟，实测 180–208s）"))
        return s
    s.insert(1, ("eslint", [npx, "eslint", "src", "--max-warnings", "0"],
                 "静态检查（实测 4s）"))
    if tier in ("b", "a"):
        s.append(("vitest", [npx, "vitest", "run"], "前端单测（~25s）"))
    if tier == "a":
        # ⚠️ 用 `-m pytest` 而不是 `pytest` 可执行文件（devlog/199）：
        #    后者**不把 CWD 加进 sys.path**，于是 `tests/conftest.py` 的
        #    `from app.services import ...` 直接 ImportError。CI 首跑就是这么红的。
        #    `pytest.ini` 里现在显式写了 `pythonpath = .`（治本），这里保持 `-m` 是第二层。
        s.append(("pytest", [PY, "-m", "pytest", "-q", "-p", "no:cacheprovider"],
                  "后端单测（实测 180–194s）"))
    return s


def main() -> int:
    ap = argparse.ArgumentParser(description="按改动档位选门禁（见文件头注释）")
    ap.add_argument("--tier", choices=["auto", "c", "b", "a", "full"], default="auto")
    ap.add_argument("--base", default="HEAD", help="比较基线（默认 HEAD = 只看工作区改动）")
    ap.add_argument("--plan", action="store_true", help="只打印将跑什么，不执行")
    args = ap.parse_args()

    if args.tier == "auto":
        files = changed_files(args.base)
        tier, why = pick_tier(files)
        print(f"[gate] 改动 {len(files)} 个文件 → **{tier.upper()} 档**（依据：{why}）")
        if files and len(files) <= 12:
            for f in files:
                print(f"        · {f}")
    else:
        tier, files = args.tier, changed_files(args.base)
        print(f"[gate] 强制 **{tier.upper()} 档**（改动 {len(files)} 个文件）")

    todo = steps(tier)
    print(f"[gate] 将跑 {len(todo)} 步：" +
          " · ".join(f"{n}({d})" for n, _c, d in todo))
    if args.plan:
        return 0

    fails, t_all = [], time.time()
    for name, cmd, desc in todo:
        print(f"\n=== {name} —— {desc} ===", flush=True)
        t0 = time.time()
        # ⚠️ 必须取 `.returncode`：`shell=True` 时 `run()` 返回的仍是 CompletedProcess，
        #    直接当整数用会把**成功也判成 FAIL**（2026-09-25 首跑踩到，四步全红）。
        rc = subprocess.run(cmd, cwd=(FRONTEND if cmd[0].endswith(("npx", "npx.cmd"))
                                      else ROOT),
                            shell=(os.name == "nt")).returncode
        dt = time.time() - t0
        flag = "ok" if rc == 0 else f"FAIL rc={rc}"
        print(f"--- {name}: {flag}（{dt:.0f}s）", flush=True)
        if rc != 0:
            fails.append(name)

    print(f"\n=== 汇总（{tier.upper()} 档，{time.time() - t_all:.0f}s）===")
    for name, _c, _d in todo:
        print(f"  [{'FAIL' if name in fails else 'ok'}] {name}")
    if fails:
        print(f"\n[FAIL] {len(fails)} 步失败：{', '.join(fails)}")
        return 1
    print("\n全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
