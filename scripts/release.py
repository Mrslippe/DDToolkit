"""DDToolkit 一键发布（版本同步 → 门禁 → 打版 → 产物校验 → 提交/tag → 推送 → Release）。

## 为什么要它

发布原是 8 步手工流程（`docs/RELEASE.md`）：版本号要改**六处**、门禁四跑、
`npm run release` 6 分钟、产物有两条形态校验（NSIS 是否把 `_internal` 打平、便携 zip 结构）、
再是 tag / 推送 / 建 Release 传资产。手工跑一次要盯十几分钟，**漏一步就是一次坏发布**
（devlog/036 就是"装完起不来"：安装脚本把后端目录打平了，而当时没人有机器判据）。

本脚本把这条链子串起来，**复用**已有的三个脚本而不是重写：
`build_backend.py` / `collect_release.py`（经 `npm run release`）+ `upload_release_assets.py`。

## 用法

    python scripts/release.py 1.0.1                 # 完整流程
    python scripts/release.py --bump patch          # 版本号自动 +1（不想数版本号时）
    python scripts/release.py 1.0.1 --dry-run       # 只预检 + 打印计划，**不动任何东西**
    python scripts/release.py --check-version       # 只校验六处版本号一致（CI/提交前用）
    python scripts/release.py 1.0.1 --from build     # 从某步续跑（失败后的常规操作）
    python scripts/release.py 1.0.1 --only verify    # 只跑一步
    python scripts/release.py 1.0.1 --skip gates     # 跳过某几步（逗号分隔）
    python scripts/release.py 1.0.1 --probes         # 门禁额外跑 UI 探针五个模式（约 +8 分钟）
    python scripts/release.py 1.0.1 --message-file msg.txt   # 用现成的提交信息

## 步骤与守卫

| 步骤 | 干什么 | 守卫（不满足即停，且**不写任何文件**） |
|---|---|---|
| `preflight` | 分支 / 工作树 / 工具链 / notes / 版本号一致性 / 网络可达 | 工作树脏、notes 缺失、新版本不大于旧版本、要发布但没 token → 停 |
| `version` | 六处版本号定点同步 | 逐文件**定点替换**（Cargo.lock 只动 `ddtoolkit` 块），改完复核六处一致 |
| `gates` | pytest -q / tsc / eslint / vitest（`--probes` 追加探针） | 任一非 0 退出 → 停 |
| `build` | `npm run release`（PyInstaller → tauri build → collect） | 非 0 → 停（输出实时透传，构建日志不吞） |
| `verify` | 两个资产存在且大小合理、无旧版本残留、**NSIS 打平行数 = 0**、便携 zip 结构、主程序 FileVersion | devlog/036 的事故形态在这里被机器拦住 |
| `commit` | `git add -A` + 提交（版本号 + notes + devlog） | 无改动则跳过（不造空提交） |
| `tag` | `git tag -a v<版本>` | tag 已存在且不指向 HEAD → 停（不覆盖已发布的 tag） |
| `push` | 推分支 + 推 tag（代理/直连自动切换 + 重试） | 推完 `ls-remote` 复核；tag 没推上去 → 停（Release 不许抢跑） |
| `release` | 调 `upload_release_assets.py`（幂等：已存在则复用 + 补传缺失资产） | 无 token、tag 未推 → 停 |
| `report` | 写 `dist-release/release-report-<版本>.md`（gitignore 内）+ 打印可粘贴的执行记录表 | —— |

## 安全与网络（沿用 `docs/RELEASE.md` §6 的定案）

- **token 只走环境变量** `GITHUB_TOKEN`，不落盘、不进进程参数；推送**优先用 GCM**
  （已授权时不必给 token），只有 GCM 不可用时才把 token 拼进 URL；
- 推送按 §6.2 的定案参数跑：`http.sslBackend=openssl` + `http.sslVerify=false`，
  先走代理（`DDTOOLKIT_GITHUB_PROXY`，默认 `http://127.0.0.1:7897`），失败再换直连；
- 每次网络动作重试 2 轮 × 2 变体，仍失败则打印 §6.3 的三条排查命令。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
TAURI = FRONTEND / "src-tauri"
DIST = ROOT / "dist-release"
REPO_SLUG = "Mrslippe/DDToolkit"
REPO_URL = f"https://github.com/{REPO_SLUG}.git"
PROXY = os.environ.get("DDTOOLKIT_GITHUB_PROXY", "http://127.0.0.1:7897")

STEPS = ["preflight", "version", "gates", "build", "verify",
         "commit", "tag", "push", "release", "report"]

OK = "[ok]"
FAIL = "[FAIL]"
WARN = "[warn]"


# ── 纯函数区（`tests/test_release_script.py` 直接测这些，不碰网络与文件系统）──

def parse_version(s: str) -> tuple[int, int, int] | None:
    """`1.2.3` / `v1.2.3` → (1,2,3)；不合法返回 None。"""
    m = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", (s or "").strip())
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def bump(version: str, kind: str) -> str:
    """`--bump patch|minor|major`：patch 进位清零、minor 清 patch、major 清 minor+patch。"""
    cur = parse_version(version)
    if cur is None:
        raise ValueError(f"当前版本号无法解析: {version!r}")
    major, minor, patch = cur
    if kind == "patch":
        patch += 1
    elif kind == "minor":
        minor, patch = minor + 1, 0
    elif kind == "major":
        major, minor, patch = major + 1, 0, 0
    else:
        raise ValueError(f"未知的 bump 类型: {kind!r}")
    return f"{major}.{minor}.{patch}"


# 六处版本号：kind → (相对路径, 人读名字)。**定点替换**，不做全文 replace ——
# `Cargo.lock` 里同名版本号成百上千（依赖），盲替一次就毁锁文件（RELEASE.md §2 的警告）。
VERSION_FILES: list[tuple[str, str, str]] = [
    ("config", "app/core/config.py", "后端 VERSION"),
    ("tauri", "frontend/src-tauri/tauri.conf.json", "桌面壳 version"),
    ("cargo", "frontend/src-tauri/Cargo.toml", "crate 版本"),
    ("cargolock", "frontend/src-tauri/Cargo.lock", "lock（只动 ddtoolkit 块）"),
    ("pkg", "frontend/package.json", "前端包版本"),
    ("readme", "README.md", "README 徽章"),
]


def set_version(text: str, kind: str, new: str) -> str:
    """在**单个文件内容**里定点写入新版本号；找不到锚点则抛错（宁可停，不静默漏改）。"""
    if kind == "config":
        pat = r'(VERSION:\s*str\s*=\s*")([^"]+)(")'
    elif kind == "tauri":
        pat = r'("version"\s*:\s*")([^"]+)(")'
    elif kind == "cargo":
        pat = r'(?m)^(version\s*=\s*")([^"]+)(")'
    elif kind == "cargolock":
        # 只认 name = "ddtoolkit" 之后紧邻的 version 行（块内第一处）
        pat = r'(\[\[package\]\]\s*\nname\s*=\s*"ddtoolkit"\s*\nversion\s*=\s*")([^"]+)(")'
    elif kind == "pkg":
        pat = r'("version"\s*:\s*")([^"]+)(")'
    elif kind == "readme":
        pat = r"(version-)(\d+\.\d+\.\d+)(-)"
    else:
        raise ValueError(f"未知 kind: {kind}")
    new_text, n = re.subn(pat, lambda m: m.group(1) + new + m.group(3), text, count=1)
    if n != 1:
        raise ValueError(f"锚点没找到（{kind}）—— 文件结构变了？请看 VERSION_FILES 的正则")
    return new_text


def read_version(text: str, kind: str) -> str | None:
    """从文件内容读出当前版本号（与 `set_version` 同锚点）。"""
    pats = {
        "config": r'VERSION:\s*str\s*=\s*"([^"]+)"',
        "tauri": r'"version"\s*:\s*"([^"]+)"',
        "cargo": r'(?m)^version\s*=\s*"([^"]+)"',
        "cargolock": r'\[\[package\]\]\s*\nname\s*=\s*"ddtoolkit"\s*\nversion\s*=\s*"([^"]+)"',
        "pkg": r'"version"\s*:\s*"([^"]+)"',
        "readme": r"version-(\d+\.\d+\.\d+)-",
    }
    m = re.search(pats[kind], text)
    return m.group(1) if m else None


def classify_nsis(lines: list[str]) -> tuple[int, int]:
    """NSIS 安装脚本的两类行计数：保留 `_internal` 层级的行 / **被打平**的行。

    真实行形状（`frontend/src-tauri/target/release/nsis/x64/installer.nsi`，2026-09-15 实取）：

        File /a "/oname=binaries\\backend\\_internal\\MSVCP140.dll" "E:\\…\\backend\\_internal\\MSVCP140.dll"
        File /a "/oname=binaries\\backend\\ddtoolkit-backend.exe"    "E:\\…\\backend\\ddtoolkit-backend.exe"

    ⚠️ 目标路径是**带引号的**（`"/oname=…"`）—— 写判据时别漏了那个引号：漏了会让正则
    永不命中（"打平行 = 0" 变成一句空话）。这类判据必须拿**真实文件**验证一次。

    打平 = `oname` 指向 `binaries\\backend\\<文件>`（少了 `_internal`）而**源路径里有
    `_internal`** —— 装完 exe 起不来、启动幕永久卡住（devlog/036）。**打平必须为 0**。
    """
    kept = flattened = 0
    for line in lines:
        if "/oname=binaries\\backend\\_internal" in line:
            kept += 1
        elif re.search(r'/oname=binaries\\backend\\[^\\]+"\s+"[^"]*_internal', line):
            flattened += 1
    return kept, flattened


def notes_problems(text: str) -> list[str]:
    """发布说明的最低要求（缺了就别发：Release 页会是一片空白）。"""
    bad: list[str] = []
    if len(text.strip()) < 200:
        bad.append(f"内容太短（{len(text.strip())} 字符 < 200）")
    for marker in ("TODO", "待填", "xxx", "<版本>"):
        if marker in text:
            bad.append(f"还留着占位符 {marker!r}")
    return bad


def asset_expectations(version: str) -> list[tuple[str, float, float]]:
    """(文件名, 最小 MB, 最大 MB) —— 大小是"产物形态对不对"的粗判据（v1.0.0 实测 56.3 / 70.3）。"""
    return [
        (f"DDtoolkit_{version}_x64-setup.exe", 20.0, 300.0),
        ("DDtoolkit-portable-win64.zip", 25.0, 400.0),
    ]


# ── 执行环境 ─────────────────────────────────────────────────────────

class Ctx:
    """运行上下文：参数、测量结果、失败即停的记账。"""

    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.results: dict[str, object] = {}
        self.warnings: list[str] = []
        self.t0 = time.time()

    @property
    def version(self) -> str:
        return self.args.version

    @property
    def tag(self) -> str:
        return f"v{self.version}"

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)
        print(f"  {WARN} {msg}")


def run(cmd: list[str], cwd: Path = ROOT, capture: bool = False,
        env: dict | None = None, check: bool = False) -> subprocess.CompletedProcess:
    """跑一个子进程。`capture=False` 时输出**实时透传**（构建/测试日志不吞）。"""
    printable = " ".join(str(c) for c in cmd)
    print(f"  $ {printable}" + ("" if cwd == ROOT else f"   (cwd={cwd})"))
    return subprocess.run(
        cmd, cwd=cwd, env=env, check=check,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
        text=capture, encoding="utf-8" if capture else None,
        errors="replace" if capture else None,
    )


def git(*args: str, capture: bool = True) -> subprocess.CompletedProcess:
    return run(["git", *args], capture=capture)


def git_out(*args: str) -> str:
    r = git(*args)
    return (r.stdout or "").strip()


def npm_cmd() -> list[str]:
    """Windows 上 `npm` 是 `npm.cmd`（脚本名要带扩展名，否则 CreateProcess 找不到）。"""
    exe = shutil.which("npm.cmd") or shutil.which("npm") or "npm"
    return [exe]


# ── 步骤实现 ─────────────────────────────────────────────────────────

def step_preflight(ctx: Ctx) -> None:
    a = ctx.args
    print(f"  版本: {a.version}   分支: {a.branch}   平台: {sys.platform}")

    # ① 版本号必须"比当前大"：发一个更小的版本是最容易犯又最贵的错
    current = current_version()
    cur_v, new_v = parse_version(current or ""), parse_version(a.version)
    if new_v is None:
        raise Fail(f"目标版本号不合法: {a.version!r}（要 x.y.z）")
    if cur_v and new_v <= cur_v:
        raise Fail(f"新版本 {a.version} 不大于当前 {current} —— 发布请递增版本号")
    print(f"  {OK} 版本递增: {current} → {a.version}")

    # ② 工作树干净（构建会把 dist-release/ 等 gitignore 目录写脏，但**已跟踪**文件必须干净）
    dirty = git_out("status", "--porcelain", "--untracked-files=no")
    if dirty and not a.allow_dirty:
        raise Fail("工作树有未提交改动（--allow-dirty 可放行）:\n    " +
                   "\n    ".join(dirty.splitlines()[:10]))

    # ③ 分支
    branch = git_out("rev-parse", "--abbrev-ref", "HEAD")
    if branch != a.branch:
        raise Fail(f"当前分支 {branch!r} ≠ {a.branch!r}")

    # ④ notes（Release 描述来源）
    notes = ROOT / "docs" / "releases" / f"v{a.version}.md"
    if not notes.exists():
        raise Fail(f"缺发布说明 {notes.relative_to(ROOT)} —— 先写它（历史版本见 docs/releases/）")
    problems = notes_problems(notes.read_text(encoding="utf-8"))
    if problems:
        raise Fail("发布说明不合格: " + "；".join(problems))
    print(f"  {OK} 发布说明: {notes.relative_to(ROOT)}（{len(notes.read_text(encoding='utf-8'))} 字符）")

    # ⑤ 版本号六处目前是否一致（不一致就先对齐，别把漂移带进发布）
    drift = version_drift()
    if drift:
        msg = "版本号六处不一致: " + "、".join(f"{n}={v}" for n, v in drift.items())
        if not a.align_version:
            raise Fail(msg + "（加 --align-version 可强制对齐到 config.py）")
        ctx.warn(msg + " → --align-version：将全部对齐到 config.py")

    # ⑤-b 文档漂移（devlog 索引 / 发布说明与导航）：这类漂移不会让任何测试红，
    #     却会让"这版改了什么"日后查不到（devlog/085 实测缺 082/084）
    try:
        import doc_check
        doc_fails, doc_warns = doc_check.run(quiet=True)
        for w in doc_warns:
            ctx.warn(w)
        if doc_fails:
            raise Fail("文档索引漂移（scripts/doc_check.py）:\n    - "
                       + "\n    - ".join(doc_fails))
        print(f"  {OK} 文档索引一致（devlog 索引 / 发布说明 / 版本号）")
    except ImportError:
        ctx.warn("没找到 scripts/doc_check.py，跳过文档漂移检查")

    # ⑥ 工具链（只查计划里要用的步骤）
    plan = ctx.results.get("plan") or []
    if "build" in plan:
        tools = [([sys.executable, "-m", "PyInstaller", "--version"], "PyInstaller"),
                 (["cargo", "--version"], "cargo"),
                 ([*npm_cmd(), "--version"], "npm")]
        for cmd, name in tools:
            r = run(cmd, capture=True)
            if r.returncode != 0:
                raise Fail(f"构建工具链缺失: {name}（{r.stdout or ''}）")
            print(f"  {OK} {name}: {(r.stdout or '').strip().splitlines()[0]}")

    # ⑦ 网络：只要计划里有 push/release，就先确认能连上 GitHub
    if {"push", "release"} & set(plan):
        reachable, detail = github_reachable()
        if not reachable:
            if ctx.args.skip_network_check:
                ctx.warn(f"连不上 GitHub（{detail}）—— --skip-network-check：只打版不发布")
            elif ctx.args.dry_run:
                # 预演要把"缺什么"一次说清，所以这两条在 dry-run 里降级为警告
                ctx.warn(f"连不上 GitHub（{detail}）—— 真跑时这里会停；"
                         f"排查见 docs/RELEASE.md §6.3")
            else:
                raise Fail(f"连不上 GitHub（{detail}）—— 先启动代理或加 --skip-network-check "
                           f"只打版不发布；排查清单见 docs/RELEASE.md §6.3")
        else:
            print(f"  {OK} GitHub 可达性: {detail}")

    # ⑧ token：只有 release 步骤需要（推送优先走 GCM）
    if "release" in plan and not os.environ.get("GITHUB_TOKEN"):
        if ctx.args.dry_run:
            ctx.warn("缺 GITHUB_TOKEN —— 真跑时 release 步骤会停（推送仍可走 GCM）")
        else:
            raise Fail("缺 GITHUB_TOKEN —— 建 Release/传资产必须用 API token（推送可走 GCM）")


def step_version(ctx: Ctx) -> None:
    changed: list[str] = []
    for kind, rel, label in VERSION_FILES:
        path = ROOT / rel
        old_text = path.read_text(encoding="utf-8")
        old = read_version(old_text, kind)
        if old == ctx.version:
            print(f"  {OK} {label:<22} 已是 {ctx.version}（{rel}）")
            continue
        new_text = set_version(old_text, kind, ctx.version)
        if ctx.args.dry_run:
            print(f"  [dry] {label:<22} {old} → {ctx.version}（{rel}）")
        else:
            path.write_text(new_text, encoding="utf-8", newline="")
            print(f"  {OK} {label:<22} {old} → {ctx.version}（{rel}）")
        changed.append(rel)
    ctx.results["version_changed"] = changed

    if not ctx.args.dry_run:
        drift = version_drift()
        if drift:
            raise Fail("同步后仍不一致: " + "、".join(f"{n}={v}" for n, v in drift.items()))
        print(f"  {OK} 六处版本号一致 = {ctx.version}")


def step_gates(ctx: Ctx) -> None:
    a = ctx.args
    if a.skip_gates:
        ctx.warn("--skip-gates：门禁整段跳过（发布前请确认你自己跑过）")
        ctx.results["gates_skipped"] = True      # 报告里要如实写"没跑"，不能留一个 None
        return
    gates: list[tuple[str, list[str], Path]] = [
        ("pytest", [sys.executable, "-m", "pytest", "-q"], ROOT),
        ("tsc", [*npm_cmd(), "exec", "--", "tsc", "-p", "tsconfig.json", "--noEmit"], FRONTEND),
        ("eslint", [*npm_cmd(), "run", "lint"], FRONTEND),
        ("vitest", [*npm_cmd(), "run", "test"], FRONTEND),
    ]
    results: dict[str, int] = {}
    for name, cmd, cwd in gates:
        print(f"\n  ── 门禁: {name} ──")
        rc = run(cmd, cwd=cwd).returncode
        results[name] = rc
        if rc != 0:
            ctx.results["gates"] = results
            raise Fail(f"门禁 {name} 失败（rc={rc}）—— 修完再发；已跑: {results}")
        print(f"  {OK} {name} 通过")

    if a.probes:
        probe_modes = [
            ["--hero-expect", a.hero_expect, "--vtuber", str(a.probe_vtuber)],
            ["--settings", "--vtuber", str(a.probe_vtuber)],
            ["--scene", "--vtuber", str(a.probe_vtuber)],
            ["--add-v", "--vtuber", str(a.probe_vtuber)],
            ["--archive", "--vtuber", str(a.probe_vtuber)],
        ]
        for extra in probe_modes:
            mode = extra[0].lstrip("-")
            print(f"\n  ── 门禁: ui_probe {mode} ──")
            rc = run([sys.executable, "scripts/ui_probe.py", *extra]).returncode
            results[f"probe:{mode}"] = rc
            if rc != 0:
                ctx.results["gates"] = results
                raise Fail(f"探针 {mode} 失败（rc={rc}）")
            print(f"  {OK} 探针 {mode} 通过")
    ctx.results["gates"] = results


def step_build(ctx: Ctx) -> None:
    print("  （PyInstaller + cargo + NSIS，实测 ~6 分钟；日志实时透传）")
    t0 = time.time()
    rc = run([*npm_cmd(), "run", "release"], cwd=FRONTEND).returncode
    took = time.time() - t0
    if rc != 0:
        raise Fail(f"npm run release 失败（rc={rc}，耗时 {took:.0f}s）")
    print(f"  {OK} 构建完成（{took/60:.1f} 分钟）")
    ctx.results["build_seconds"] = round(took)


def step_verify(ctx: Ctx) -> None:
    problems: list[str] = []
    sizes: dict[str, float] = {}
    if not DIST.exists():
        raise Fail(f"没有 {DIST.relative_to(ROOT)} —— 构建产出了吗？")

    for name, lo, hi in asset_expectations(ctx.version):
        path = DIST / name
        if not path.exists():
            problems.append(f"缺资产 {name}")
            continue
        mb = path.stat().st_size / 1048576
        sizes[name] = round(mb, 1)
        print(f"  {OK} {name}  {mb:.1f} MB")
        if not (lo <= mb <= hi):
            problems.append(f"{name} 大小异常（{mb:.1f} MB 不在 {lo}~{hi} MB）")

    # 旧版本残留：装的时候会让人拿错包（RELEASE.md §3 明确要求删）
    for f in DIST.glob("DDtoolkit_*_x64-setup.exe"):
        if f.name not in dict((n, 1) for n, _, _ in asset_expectations(ctx.version)):
            problems.append(f"旧版本安装包残留: {f.name} —— 删除后重跑本步")

    # NSIS：后端目录被"打平"过（devlog/036），装了起不来
    nsi = TAURI / "target" / "release" / "nsis" / "x64" / "installer.nsi"
    if nsi.exists():
        kept, flattened = classify_nsis(nsi.read_text(encoding="utf-8", errors="replace").splitlines())
        ctx.results["nsis"] = {"kept": kept, "flattened": flattened}
        print(f"  {OK if flattened == 0 and kept else FAIL} NSIS 布局: "
              f"保留 _internal 的行={kept}，被打平的行={flattened}（必须 0）")
        if flattened:
            problems.append(f"NSIS 把后端目录打平了（{flattened} 行）—— "
                            f"检查 tauri.conf.json 的 bundle.resources 是否被改成 map 形式")
        if not kept:
            problems.append("NSIS 安装脚本里没有任何 _internal 行 —— 形态不对")
    else:
        ctx.warn(f"没找到 {nsi.relative_to(ROOT)}（跳过后端布局校验）")

    # 便携 zip 结构：顶层 DDtoolkit/ + 主程序 + 后端 _internal
    zip_path = DIST / "DDtoolkit-portable-win64.zip"
    if zip_path.exists():
        import zipfile
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
        has_exe = any(n.endswith("DDtoolkit/ddtoolkit.exe") or n.endswith("DDtoolkit/DDtoolkit.exe")
                      for n in names)
        has_internal = any("/binaries/backend/_internal/" in n for n in names)
        ctx.results["portable"] = {"entries": len(names), "has_exe": has_exe,
                                   "has_internal": has_internal}
        print(f"  {OK if has_exe and has_internal else FAIL} 便携包: {len(names)} 条目、"
              f"主程序={has_exe}、_internal={has_internal}")
        if not has_exe:
            problems.append("便携包里没有主程序 ddtoolkit.exe")
        if not has_internal:
            problems.append("便携包里没有 binaries/backend/_internal/（后端目录形态不对）")

    # 主程序版本号（devlog/082 手工查过这条，现在固定下来）
    exe = TAURI / "target" / "release" / "ddtoolkit.exe"
    if exe.exists():
        fv = file_version(exe)
        ctx.results["exe_version"] = fv
        if fv == ctx.version:
            print(f"  {OK} 主程序 FileVersion = {fv}")
        elif fv is None:
            ctx.warn("读不到主程序 FileVersion（PowerShell 不可用？）")
        else:
            problems.append(f"主程序 FileVersion={fv} ≠ {ctx.version}（版本号没进构建？）")

    ctx.results["asset_sizes_mb"] = sizes
    if problems:
        raise Fail("产物校验未通过:\n    - " + "\n    - ".join(problems))


def step_commit(ctx: Ctx) -> None:
    if ctx.args.dry_run:
        print("  [dry] 跳过提交")
        return
    git("add", "-A", capture=False)
    staged = git_out("diff", "--cached", "--name-only")
    if not staged:
        ctx.warn("没有需要提交的改动（版本号/说明都已提交过）→ 跳过提交")
        ctx.results["commit"] = None
        return
    files = staged.splitlines()
    msg = commit_message(ctx, files)
    # 提交信息落**系统临时目录**，不落仓库（仓库里留个 _*.txt 会被下一次 git add -A 收进去）
    import tempfile
    fd, tmp_name = tempfile.mkstemp(prefix="ddtoolkit-release-", suffix=".txt")
    os.close(fd)
    msg_file = Path(tmp_name)
    msg_file.write_text(msg, encoding="utf-8", newline="\n")
    try:
        r = run(["git", "commit", "-F", str(msg_file)], capture=True)
        if r.returncode != 0:
            raise Fail(f"提交失败: {r.stdout}")
    finally:
        msg_file.unlink(missing_ok=True)
    sha = git_out("rev-parse", "--short", "HEAD")
    ctx.results["commit"] = sha
    print(f"  {OK} 已提交 {sha}（{len(files)} 个文件）")


def step_tag(ctx: Ctx) -> None:
    if ctx.args.dry_run:
        print(f"  [dry] 跳过打 tag {ctx.tag}")
        return
    existing = git_out("tag", "--list", ctx.tag)
    head = git_out("rev-parse", "HEAD")
    if existing:
        tag_sha = git_out("rev-list", "-n", "1", ctx.tag)
        if tag_sha == head:
            ctx.warn(f"tag {ctx.tag} 已存在且指向 HEAD → 跳过（续跑场景）")
            ctx.results["tag"] = "existing"
            return
        raise Fail(f"tag {ctx.tag} 已存在且指向别的提交（{tag_sha[:8]}）—— "
                   f"已发布的 tag 不许覆盖；请换版本号或手工处理")
    r = run(["git", "tag", "-a", ctx.tag, "-m", f"DDtoolkit {ctx.tag}"], capture=True)
    if r.returncode != 0:
        raise Fail(f"打 tag 失败: {r.stdout}")
    ctx.results["tag"] = git_out("rev-list", "-n", "1", ctx.tag)[:8]
    print(f"  {OK} tag {ctx.tag} → {ctx.results['tag']}")


def step_push(ctx: Ctx) -> None:
    if ctx.args.dry_run:
        print("  [dry] 跳过推送")
        return
    refs = [f"refs/heads/{ctx.args.branch}", f"refs/tags/{ctx.tag}"]
    ok, detail = push_with_retry(refs)
    if not ok:
        raise Fail("推送失败：\n    " + detail.replace("\n", "\n    ") +
                   "\n    排查（RELEASE.md §6.3）：Test-NetConnection 127.0.0.1 -Port 7897 / "
                   "Resolve-DnsName github.com / 浏览器能否打开仓库页")
    print(f"  {OK} 推送完成（{detail}）")
    ctx.results["push"] = detail

    # 远端复核：Release 不许抢在 tag 之前
    remote = git_out("ls-remote", "--tags", REPO_URL, ctx.tag)
    if not remote:
        raise Fail(f"远端仍看不到 tag {ctx.tag} —— 等一下或重跑 --from push")
    print(f"  {OK} 远端已确认 tag {ctx.tag}")

    # 推送是**按 URL** 推的（`git push <url> <refs>`），git 不会更新本地的
    # `refs/remotes/origin/<branch>` —— 于是 `git status -sb` 会一直显示"领先 N 个提交"，
    # 让人以为没推上去（v1.0.1 实跑时就先被这个假象误导过一次）。这里按"刚推成功"把
    # tracking ref 对齐到本地 HEAD：不联网、不改远端，只让本地状态不撒谎。
    head = git_out("rev-parse", "HEAD")
    if git("update-ref", f"refs/remotes/origin/{ctx.args.branch}", head).returncode == 0:
        print(f"  {OK} 本地 origin/{ctx.args.branch} 已对齐到 {head[:8]}")


def step_release(ctx: Ctx) -> None:
    if ctx.args.dry_run:
        print(f"  [dry] 跳过建 Release {ctx.tag}")
        return
    if ctx.args.release_only_local:
        ctx.warn("--no-remote-release：只打版不建 Release")
        return
    env = {**os.environ, "DDTOOLKIT_GITHUB_PROXY": PROXY}
    r = run([sys.executable, "scripts/upload_release_assets.py", ctx.tag], env=env)
    if r.returncode != 0:
        raise Fail("建 Release / 传资产失败（上面有原因）")
    info = release_info(os.environ.get("GITHUB_TOKEN", ""), ctx.tag)
    if info:
        ctx.results["release"] = info
        names = [a["name"] for a in info.get("assets", [])]
        print(f"  {OK} Release id={info['id']} 资产={names}")
        print(f"  {OK} URL: {info['html_url']}")
    else:
        ctx.warn("Release 建好了，但 API 复核没读到（token 权限？）—— 去网页确认一下")


def step_report(ctx: Ctx) -> None:
    if ctx.args.dry_run:
        return
    gates = ctx.results.get("gates")
    gates_text = ("（**未跑**：本次带了 --skip-gates）" if ctx.results.get("gates_skipped")
                  else (str(gates) if gates else "（未跑）"))
    lines = [
        f"# DDToolkit v{ctx.version} 发布报告",
        "",
        f"- 时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"- 版本：{ctx.version}（六处已同步）",
        f"- 本次计划步骤：{' → '.join(ctx.results.get('plan') or [])}",
        f"- 分支：{ctx.args.branch}　提交：{ctx.results.get('commit') or '（本次无新提交）'}",
        f"- tag：{ctx.tag} → {ctx.results.get('tag')}",
        f"- 推送：{ctx.results.get('push')}",
        f"- 构建耗时：{ctx.results.get('build_seconds')}s" if ctx.results.get("build_seconds")
        else "- 构建耗时：（本次未跑 build 步骤）",
        f"- 资产：{ctx.results.get('asset_sizes_mb')}",
        f"- NSIS：{ctx.results.get('nsis')}（flattened 必须 0）",
        f"- 便携包：{ctx.results.get('portable')}",
        f"- 主程序 FileVersion：{ctx.results.get('exe_version')}",
        f"- 门禁：{gates_text}",
        f"- Release：{(ctx.results.get('release') or {}).get('html_url', '（未建）')}",
        "",
        "## 待人工确认（脚本不做）",
        "- [ ] 装一次直装版：`binaries\\backend\\_internal\\` 存在 + 首启越过启动幕",
        "- [ ] 便携版解压可启动（含 B 站扫码登录）",
        "- [ ] 吊销本次 PAT（若 token 进过对话/日志）",
    ]
    DIST.mkdir(exist_ok=True)
    path = DIST / f"release-report-{ctx.version}.md"
    path.write_text("\n".join(l for l in lines if l != "") + "\n", encoding="utf-8", newline="\n")
    print(f"  {OK} 报告: {path}")
    if ctx.warnings:
        print(f"  ⚠️ 本次有 {len(ctx.warnings)} 条警告：")
        for w in ctx.warnings:
            print(f"     - {w}")


# ── 辅助 ─────────────────────────────────────────────────────────────

class Fail(Exception):
    """步骤失败（消息直接给用户看）。"""


def current_version() -> str | None:
    return read_version((ROOT / "app/core/config.py").read_text(encoding="utf-8"), "config")


def version_drift() -> dict[str, str | None]:
    """六处版本号里与 config.py 不一致的（返回 {名字: 实测值}）。"""
    base = current_version()
    drift: dict[str, str | None] = {}
    for kind, rel, label in VERSION_FILES:
        path = ROOT / rel
        if not path.exists():
            drift[label] = "文件缺失"
            continue
        v = read_version(path.read_text(encoding="utf-8"), kind)
        if v != base:
            drift[label] = v
    return drift


def file_version(exe: Path) -> str | None:
    """读 Windows 可执行文件的 FileVersion（PowerShell 一行；失败返回 None）。"""
    ps = shutil.which("powershell") or shutil.which("pwsh")
    if not ps:
        return None
    r = run([ps, "-NoProfile", "-Command",
             f"(Get-Item '{exe}').VersionInfo.FileVersion"], capture=True)
    return (r.stdout or "").strip() or None


def github_reachable(timeout: int = 15) -> tuple[bool, str]:
    """先试代理再试直连（RELEASE.md §6：直连 github.com 在国内不稳）。"""
    for label, proxy in (("代理 " + PROXY, PROXY), ("直连", None)):
        try:
            handlers = [urllib.request.ProxyHandler({"https": proxy})] if proxy else \
                [urllib.request.ProxyHandler({})]
            opener = urllib.request.build_opener(*handlers)
            req = urllib.request.Request(f"https://api.github.com/repos/{REPO_SLUG}",
                                         headers={"User-Agent": "ddtoolkit-release"})
            with opener.open(req, timeout=timeout):
                return True, f"{label} 通"
        except Exception as e:                                    # noqa: BLE001
            last = f"{label} 不通（{type(e).__name__}: {e}）"
    return False, last


def push_with_retry(refs: list[str]) -> tuple[bool, str]:
    """推送：代理/直连两变体 × 各自重试 2 次；token 有就拼 URL，没有就走 GCM。"""
    token = os.environ.get("GITHUB_TOKEN", "")
    url = (f"https://x-access-token:{token}@github.com/{REPO_SLUG}.git" if token else REPO_URL)
    base = ["git", "-c", "http.sslBackend=openssl", "-c", "http.sslVerify=false"]
    variants = [("代理", ["-c", f"http.proxy={PROXY}"]),
                ("直连", ["-c", "http.proxy=", "-c", "https.proxy="])]
    log: list[str] = []
    for label, net in variants:
        for attempt in (1, 2):
            r = run([*base, *net, "push", url, *refs], capture=True)
            head = (r.stdout or "").strip().splitlines()
            tail = head[-1] if head else ""
            if r.returncode == 0:
                return True, f"{label}（第 {attempt} 次）{tail}"
            log.append(f"{label} 第 {attempt} 次失败: {tail or r.returncode}")
            time.sleep(4)
    return False, "\n".join(log)


def release_info(token: str, tag: str) -> dict | None:
    if not token:
        return None
    try:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"https": PROXY}))
        req = urllib.request.Request(
            f"https://api.github.com/repos/{REPO_SLUG}/releases/tags/{tag}",
            headers={"Authorization": "token " + token, "User-Agent": "ddtoolkit-release"})
        with opener.open(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except Exception:                                             # noqa: BLE001
        return None


def commit_message(ctx: Ctx, files: list[str]) -> str:
    if ctx.args.message_file:
        return Path(ctx.args.message_file).read_text(encoding="utf-8")
    listed = "\n".join(f"- {f}" for f in files[:30])
    gates = ctx.results.get("gates") or {}
    gate_line = "、".join(f"{k} rc={v}" for k, v in gates.items()) or "（跳过）"
    return (
        f"release: v{ctx.version} —— 版本号同步 + 发布说明\n\n"
        f"本提交由 `python scripts/release.py {ctx.version}` 生成，只做发布准备（无功能改动）：\n\n"
        f"- 版本号六处同步：config.py / tauri.conf.json / Cargo.toml / Cargo.lock(ddtoolkit) / "
        f"package.json / README 徽章 → **{ctx.version}**；\n"
        f"- 发布说明：docs/releases/v{ctx.version}.md（Release 描述来源）；\n"
        f"- 门禁：{gate_line}；\n"
        f"- 涉及文件（{len(files)}）：\n{listed}\n"
    )


def select_steps(args: argparse.Namespace) -> list[str]:
    steps = list(STEPS)
    if args.only:
        wanted = [s.strip() for s in args.only.split(",") if s.strip()]
        bad = [s for s in wanted if s not in STEPS]
        if bad:
            raise Fail(f"未知步骤 {bad}；可选: {', '.join(STEPS)}")
        steps = wanted
    elif args.from_step:
        if args.from_step not in STEPS:
            raise Fail(f"未知步骤 {args.from_step}；可选: {', '.join(STEPS)}")
        steps = STEPS[STEPS.index(args.from_step):]
    if args.skip:
        dropped = {s.strip() for s in args.skip.split(",") if s.strip()}
        bad = dropped - set(STEPS)
        if bad:
            raise Fail(f"未知步骤 {sorted(bad)}；可选: {', '.join(STEPS)}")
        steps = [s for s in steps if s not in dropped]
    # 依赖：Release 需要 tag 已在远端；没有 push 就别假装能建
    if "release" in steps and "push" not in steps:
        steps = [s for s in steps if s != "release"]
        print(f"  {WARN} 计划里没有 push → 自动去掉 release（tag 不在远端建 Release 必失败）")
    return steps


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="DDToolkit 一键发布（版本同步 → 门禁 → 打版 → 校验 → 提交/tag → 推送 → Release）",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("version", nargs="?", help="目标版本号（如 1.0.1）；--bump 时可省略")
    ap.add_argument("--bump", choices=["patch", "minor", "major"],
                    help="从当前版本号自动推算目标版本（不想手写版本号时用）")
    ap.add_argument("--check-version", action="store_true",
                    help="只校验六处版本号一致（不发版、不构建），可用于提交前检查")
    ap.add_argument("--dry-run", action="store_true", help="只预检 + 打印计划，不动任何东西")
    ap.add_argument("--from", dest="from_step", help=f"从该步开始跑（{'/'.join(STEPS)}）")
    ap.add_argument("--only", help="只跑这些步（逗号分隔）")
    ap.add_argument("--skip", help="跳过这些步（逗号分隔）")
    ap.add_argument("--skip-gates", action="store_true", help="门禁整段跳过")
    ap.add_argument("--probes", action="store_true", help="门禁里追加 UI 探针五个模式（约 +8 分钟）")
    ap.add_argument("--probe-vtuber", type=int, default=15, help="探针用的 VTuber id（默认 15）")
    ap.add_argument("--hero-expect", default="c11548580e73d910ca667047b8120075a4ab121fa3fa098ff6654326ed183666",
                    help="探针 hero 药丸签名基线（默认取 v1.0.0 实测值）")
    ap.add_argument("--branch", default="main", help="发布分支（默认 main）")
    ap.add_argument("--allow-dirty", action="store_true", help="允许工作树有未提交改动")
    ap.add_argument("--align-version", action="store_true",
                    help="六处版本号漂移时强制对齐到 config.py（历史事故：0.8.0/0.1.0 不一致）")
    ap.add_argument("--skip-network-check", action="store_true", help="预检不查 GitHub 可达性")
    ap.add_argument("--no-remote-release", dest="release_only_local", action="store_true",
                    help="只到推送为止，不建 GitHub Release")
    ap.add_argument("--message-file", help="用现成的提交信息文件（默认自动生成）")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])

    if args.check_version:
        base = current_version()
        print(f"[check] config.py 的 VERSION = {base}")
        drift = version_drift()
        for kind, rel, label in VERSION_FILES:
            v = read_version((ROOT / rel).read_text(encoding="utf-8"), kind) \
                if (ROOT / rel).exists() else None
            flag = OK if v == base else FAIL
            print(f"  {flag} {label:<24} {v}   ({rel})")
        if drift:
            print(f"{FAIL} 有 {len(drift)} 处与 config.py 不一致 —— 跑 release.py <版本> 会一并修正")
            return 1
        print(f"{OK} 六处版本号一致")
        return 0

    if not args.version:
        if args.bump:
            cur = current_version()
            if not cur:
                print(f"{FAIL} 读不到当前版本号（app/core/config.py）")
                return 1
            args.version = bump(cur, args.bump)
            print(f"[bump] {cur} → {args.version}（{args.bump}）")
        else:
            print("用法: python scripts/release.py <版本> [--dry-run] [--probes] …\n"
                  "      不知道版本号时用 --bump patch|minor|major")
            return 1
    if parse_version(args.version) is None:
        print(f"{FAIL} 版本号要形如 1.0.1，收到 {args.version!r}")
        return 1

    ctx = Ctx(args)
    try:
        steps = select_steps(args)
    except Fail as e:
        print(f"{FAIL} {e}")
        return 1
    ctx.results["plan"] = steps

    print(f"\n=== DDToolkit 发布 v{args.version} ===")
    print(f"计划: {' → '.join(steps)}" + ("   [dry-run]" if args.dry_run else ""))
    print(f"token: {'已设置（GITHUB_TOKEN）' if os.environ.get('GITHUB_TOKEN') else '未设置'}"
          f"　代理: {PROXY}")

    if args.dry_run:
        steps = ["preflight", "version"]      # dry 只做只读预检 + 打印将要改什么
        print("（dry-run：只跑 preflight 与 version 的预演，均不写文件）")

    for i, name in enumerate(steps, 1):
        print(f"\n[{i}/{len(steps)}] ── {name} ──")
        try:
            globals()[f"step_{name}"](ctx)
        except Fail as e:
            print(f"\n{FAIL} 步骤 {name} 未通过：{e}")
            nxt = STEPS[STEPS.index(name)]
            print(f"      修好后续跑: python scripts/release.py {args.version} --from {nxt}")
            return 1
        except KeyboardInterrupt:
            print(f"\n{WARN} 被中断；续跑: python scripts/release.py {args.version} --from {name}")
            return 130

    took = time.time() - ctx.t0
    print(f"\n{'[dry-run] ' if args.dry_run else ''}全部完成（{took/60:.1f} 分钟）")
    if not args.dry_run:
        rel = (ctx.results.get("release") or {}).get("html_url")
        if rel:
            print(f"Release: {rel}")
        print("别忘了（脚本不做）：装一次直装版确认 binaries\\backend\\_internal\\ 存在、"
              "便携版解压可启动；token 进过对话就吊销。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
