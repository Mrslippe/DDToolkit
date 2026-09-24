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

# ── 档位判定：路径前缀 → 归属 ────────────────────────────────────────────────
# A：只有这些能让 pytest 有意义（后端代码或后端测试本身）
A_PREFIXES = ("app/", "alembic/", "tests/")
A_FILES = ("backend_main.py",)
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
        ("doc_check", [sys.executable, "scripts/doc_check.py"], "文档门禁（实测 0–2s）"),
        # ⚠️ **永远跑满三档**：实测单档 28.3s / 三档 26.6s —— 成本全在启动，
        #    少跑档只损失覆盖面、不省时间（2026-09-25 实测）。
        ("ui_probe", [sys.executable, "scripts/ui_probe.py",
                      "--vtuber", "15", "--seed-accounts", "8"],
         "版式不变量（三档 × 10 帧，实测 36s）"),
    ]
    if tier == "full":
        # dev_check 自带 eslint + vitest + pytest + 语法扫描 + 后端冒烟 ⇒ 别再单跑一遍
        s.append(("dev_check", [sys.executable, "scripts/dev_check.py"],
                  "一把梭（含 pytest 与后端冒烟，实测 180–208s）"))
        return s
    s.insert(1, ("eslint", [npx, "eslint", "src", "--max-warnings", "0"],
                 "静态检查（实测 4s）"))
    if tier in ("b", "a"):
        s.append(("vitest", [npx, "vitest", "run"], "前端单测（~25s）"))
    if tier == "a":
        s.append(("pytest", [sys.executable, "-m", "pytest", "-q"],
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
