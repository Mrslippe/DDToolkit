# -*- coding: utf-8 -*-
"""改动档位门禁自身的用例（`scripts/gate.py`）。

为什么给它写用例：`gate.py` 决定"**改哪些文件要跑哪些门禁**"。它判错的后果不是自己红，
而是**别的文件从此没人守**——本仓已踩过一次（原先把 `scripts/**` 一律归 C 档，
于是改 `doc_check.py` 的判据逻辑时不会跑 pytest，而它恰恰被 24 条用例守着；
2026-09-25 才补上 `scripts/doc_check.py` / `gen_doc_numbers.py` / `release.py` 三条映射）。

2026-09-25（devlog/197）再加两类映射，各自对应一个"会静默失去守护"的缺口：
  · `frontend/src-tauri/**` —— 原先落 C 档（只跑 tsc + eslint + 探针），
    改 Rust 壳（含**删除数据目录**那条命令）时 `cargo test` 一次都不跑；
  · `pyproject.toml` / `uv.lock` —— 改依赖来源不跑 pytest，等于"改了运行环境没人验"。

判据口径：**每个映射都要能被一条断言钉住**，且断言必须在"映射被删掉"时真的红
（反向验证做法见每条用例的 docstring）。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import gate as G  # noqa: E402


# ── 档位映射 ────────────────────────────────────────────────────────────────

def test_pick_tier_returns_tier_and_reason():
    """`pick_tier` 的返回形状是契约：理由要能指出**是哪条路径**把档位顶上去的。

    反向验证：把 `return "a", f` 改成 `return "a", ""` ⇒ 第二条断言红。
    """
    tier, why = G.pick_tier(["app/main.py"])
    assert tier == "a"
    assert why, "档位理由不能为空 —— 它是收尾时判断'是不是映射写错了'的唯一线索"


def test_backend_and_tests_files_are_tier_a():
    """后端代码 / 后端测试必须跑 pytest（A 档）。

    反向验证：把 `A_PREFIXES` 里的 `"tests/"` 删掉 ⇒ 本用例自己会变成 C 档…
    注意这正是"用例守自己"的循环，所以**必须有一条钉住具体文件名的断言**（下面那条）。
    """
    for f in ("app/main.py", "app/services/scheduler.py", "backend_main.py",
              "tests/test_gate.py", "alembic/versions/f007_vtuber_events_kind.py"):
        tier, _why = G.pick_tier([f])
        assert tier == "a", f"{f} 应落 A 档（跑 pytest），实际 {tier.upper()}"


def test_rust_shell_files_must_not_fall_into_tier_c():
    """`frontend/src-tauri/**` 必须落 A 档 —— 否则改 Rust 壳时 `cargo test` 不跑。

    为什么它不是"C 档够用"：Rust 侧住着**唯一一条不可逆的破坏性操作**
    （`lib.rs::delete_old_data_dir`，一次调用 `remove_dir_all`）。
    C 档只跑 tsc + eslint + 探针 + doc_check，**一行 Rust 都不编译**。

    反向验证：删掉 `A_PREFIXES`/`A_FILES` 里的 src-tauri 映射 ⇒ 本用例红。
    """
    for f in ("frontend/src-tauri/src/lib.rs",
              "frontend/src-tauri/src/migrate.rs",
              "frontend/src-tauri/Cargo.toml",
              "frontend/src-tauri/tauri.conf.json",
              "frontend/src-tauri/capabilities/default.json"):
        tier, _why = G.pick_tier([f])
        assert tier == "a", f"{f} 应落 A 档（跑 cargo test），实际 {tier.upper()}"


def test_rust_step_is_in_the_plan_for_tier_a():
    """A 档的步骤表里必须真的有一条 Rust 步骤 —— 档位对了但没步骤等于没做。

    反向验证：把 `steps()` 里那条 cargo 步骤删掉 ⇒ 本用例红
    （档位映射还在，所以上一条用例**抓不到**这个缺口 —— 两条断言各守一半）。
    """
    names = [n for n, _c, _d in G.steps("a")]
    assert any("cargo" in n for n in names), \
        f"A 档步骤里没有 cargo 步骤：{names}"


def test_dependency_lock_files_are_tier_a():
    """依赖来源（`pyproject.toml` / `uv.lock`）必须落 A 档。

    为什么：这两份文件决定"CI / 打包 / 用户拿到的运行时到底是哪些版本"。
    改了它们却只跑 C 档 = **改了运行环境而一条后端用例都没跑**。
    2026-09-25（devlog/197）从 `>=` 无锁切到 `uv.lock` 时立的这条。

    反向验证：把 `A_FILES` 里的 `"uv.lock"` 删掉 ⇒ 本用例红。
    """
    for f in ("pyproject.toml", "uv.lock"):
        tier, _why = G.pick_tier([f])
        assert tier == "a", f"{f} 应落 A 档（依赖来源变更要跑 pytest），实际 {tier.upper()}"


def test_dev_token_tooling_is_tier_a():
    """"打自己后端的开发态脚本"必须落 A 档 —— 它们的价值全在那几条结构判据上。

    为什么（2026-09-26，devlog/203）：S1 给后端加门禁后，这一组脚本**逐个失效**，
    而症状分别伪装成"布局坏了 / 网络不可达 / 上游挂了"，没有一个像门禁问题。
    现在它们由 `tests/test_dev_token.py` 守着（三处字面量同值 + 起后端必须给 token），
    而 C 档**不跑 pytest** ⇒ 落 C 就等于"判据写了但永远不会跑"。

    反向验证：把 `A_FILES` 里的 `"scripts/dev_check.py"` 删掉 ⇒ 本用例红。
    """
    for f in ("scripts/dev_token.py", "scripts/dev_check.py",
              "scripts/smoke_upstream.py", "scripts/perf_report.py"):
        tier, _why = G.pick_tier([f])
        assert tier == "a", \
            f"{f} 应落 A 档（被 tests/test_dev_token.py 守着），实际 {tier.upper()}"


def test_frontend_lock_file_is_at_least_tier_b():
    """`frontend/package-lock.json` 不许落 C 档 —— 否则"只改了锁"时一条前端用例都不跑。

    与 197 补 `uv.lock` 是同一类漏洞的另一半（2026-09-26，S2 批次顺手抓到）：
    `npm install <pkg>` 有时只改 lock（版本/完整性），`package.json` 一个字不动 ⇒
    按文件判档的话它落 C，而 C 档**不跑 vitest**。

    反向验证：把 `B_FILES` 里的 `"frontend/package-lock.json"` 删掉 ⇒ 本用例红。
    """
    tier, _why = G.pick_tier(["frontend/package-lock.json"])
    assert tier in ("a", "b"), f"前端锁文件应至少 B 档（跑 vitest），实际 {tier.upper()}"


# ── 映射表自身的卫生 ────────────────────────────────────────────────────────

def test_every_mapped_specific_file_exists():
    """`A_FILES` 里写死的路径必须真实存在 —— 否则是一条**永不生效**的映射。

    这是"配置写了不等于生效"的一种：文件名改了、映射没跟着改，
    门禁照旧绿，而那个文件其实已经回到 C 档（`doc_check.py` 的事件就是这么发生的）。

    反向验证：往 `A_FILES` 里加一个 `"scripts/does_not_exist.py"` ⇒ 本用例红。
    """
    missing = [f for f in G.A_FILES if not (G.ROOT / f).exists()]
    assert not missing, f"A_FILES 里有不存在的路径（映射已失效）：{missing}"


def test_tier_ordering_is_monotonic():
    """档位只能"往上顶"：A 档的步骤必须包含 B 档的全部，B 档包含 C 档的全部。

    为什么重要：`pick_tier` 是"命中即返回"，一旦某天有人把 B 档改成"只跑 vitest"，
    一次跨层改动就会**少跑 tsc/eslint**，而且不会有人发现。
    """
    def names(tier: str) -> set[str]:
        return {n for n, _c, _d in G.steps(tier)}

    c, b, a = names("c"), names("b"), names("a")
    assert c <= b <= a, (
        f"档位不单调：C={sorted(c)} B={sorted(b)} A={sorted(a)}\n"
        f"C−B={sorted(c - b)}  B−A={sorted(b - a)}"
    )


# ── CI 与依赖来源必须同一套口径（devlog/199）────────────────────────────────
#
# 「CI 绿」只有在 CI **真的跑门禁**时才说明问题。而 CI 与本地最容易分家的地方就是
# **装依赖那一步**：本地按 `uv.lock` 装，CI 若写回 `pip install -r requirements.txt`
# 就会装出"当天最新" ⇒ 同一份代码在两处表现不同，且没人会发现。
# 下面这组断言把"CI 引用锁文件"变成机器判据。

WORKFLOWS = ROOT / ".github" / "workflows"


def _workflow_files() -> list[Path]:
    """所有 workflow 文件；**一个都没有时直接失败**。

    为什么要这条守卫：下面几条断言都是 `for wf in files` 的形式 —— 文件列表为空时循环不执行，
    断言**空转通过**（本组第一版就是这样：首跑只红了 3 条而不是 5 条）。
    "没有可检查的对象"必须显式算失败。
    """
    files = sorted(WORKFLOWS.glob("*.y*ml")) if WORKFLOWS.is_dir() else []
    assert files, f"找不到任何 workflow 文件（{WORKFLOWS}）—— 断言没有可检查的对象，按失败处理"
    return files


def _run_commands(text: str) -> str:
    """只取 workflow 里 `run:` 后面的**真正会执行的命令**，丢掉注释与说明文字。

    ⚠️ 为什么必须这样（2026-09-25 反向验证实测）：第一版断言直接在**全文**里找
    `uv sync` / `cargo test`，而两个 workflow 的注释里恰好都写着它们
    （"依赖必须走 uv.lock（uv sync --frozen）"、"（含 junction 危险路径矩阵）cargo test"…）
    ⇒ **把真正的命令删掉、注释留着，断言照样绿**。这是"判据被自己的说明文字喂饱"，
    与被测对象无关的假绿。

    做法：只支持 workflow 里实际用到的两种写法 —— `run: <单行>` 与 `run: |` 的块标量。
    真实的 GitHub Actions 语法比这丰富，但**够用且不假装通用**：多解析出来的花样
    只会再制造一次"看起来在检查"。
    """
    out: list[str] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if stripped.startswith("run:"):
            rest = stripped[len("run:"):].strip()
            if rest and rest != "|":          # 单行形式
                out.append(rest)
            elif rest == "|":                  # 块标量：取到缩进回落到 run: 同级为止
                base = len(line) - len(line.lstrip())
                i += 1
                while i < len(lines):
                    nxt = lines[i]
                    if nxt.strip() and (len(nxt) - len(nxt.lstrip())) <= base:
                        break
                    out.append(nxt.strip())
                    i += 1
                continue
        i += 1
    return "\n".join(out)


def _all_run_commands() -> str:
    return "\n".join(_run_commands(p.read_text(encoding="utf-8")) for p in _workflow_files())


def test_ci_workflows_exist():
    """必须有 workflow —— 否则"CI 绿"根本无从谈起（本仓 2026-09-25 之前没有 `.github/`）。

    反向验证：删掉整个 `.github/workflows/` ⇒ 本用例红。
    """
    files = _workflow_files()
    assert any(p.name.startswith("ci") for p in files), \
        f"没有名字以 ci 开头的 workflow：{[p.name for p in files]}"


def test_ci_installs_from_the_lock_not_from_a_loose_requirements_file():
    """每个 workflow 都必须**真的执行** `uv sync`（= 按 `uv.lock` 装），不得回退到裸 pip。

    为什么单列一条：这是"本地绿、CI 红（或反过来）"最常见的成因，而且**不会自己响**
    —— 两边各自都能跑通，只是装的东西不一样。

    反向验证：把某个 workflow 里 `run:` 的 `uv sync` 换成 `pip install -r requirements.txt` ⇒ 红；
    只把命令删掉、注释留着 ⇒ **也必须红**（见 `_run_commands` 的说明）。
    """
    bad: list[str] = []
    for wf in _workflow_files():
        cmds = _run_commands(wf.read_text(encoding="utf-8"))
        if "uv sync" not in cmds:
            bad.append(f"{wf.name}: `run:` 里没有 `uv sync`（依赖来源不是 uv.lock）")
        for line in cmds.splitlines():
            if "pip install" in line and "requirements.txt" in line and "--require-hashes" not in line:
                bad.append(f"{wf.name}: 裸 `{line}` —— 锁文件带 hash，必须 `--require-hashes`")
    assert not bad, "CI 与本地依赖口径分家了：\n  - " + "\n  - ".join(bad)


def test_ci_hash_checked_requirements_is_a_real_export():
    """`requirements.txt` 必须真是 `uv export` 的**带 hash** 产物。

    它现在是导出物而不是真源（`pyproject.toml` + `uv.lock` 才是），所以"有人手改回
    `pkg>=x` 的清单"这种回退必须能被抓住。

    反向验证：把文件换成一行 `fastapi>=0.115` ⇒ 两条断言都红。
    """
    req = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    assert "--hash=sha256:" in req, "requirements.txt 里一个 hash 都没有（不是 uv export 产物？）"
    offenders = [ln.strip() for ln in req.splitlines()
                 if ">=" in ln or ln.strip().startswith("-r ")]
    assert not offenders, f"requirements.txt 里出现未钉死的写法：{offenders[:3]}"


def test_ci_covers_the_rust_leg():
    """Rust 必须在 CI 里**真的被编译** —— `frontend/src-tauri/**` 住着删除数据目录那条命令。

    反向验证：把 workflow 里 `run:` 的 `cargo test` 删掉（注释里那个词留着）⇒ 红。
    """
    assert "cargo test" in _all_run_commands(), \
        "没有任何 workflow 真的执行 `cargo test`（Rust 壳没进 CI）"


def test_ci_provides_the_sidecar_placeholder_that_cargo_needs():
    """`cargo test` 在干净 clone 上需要 `binaries/backend/` 里**至少有一个文件**。

    为什么（2026-09-25 实测，devlog/199）：`tauri.conf.json` 的资源 glob 是
    `binaries/backend/**/*`，而该目录由 PyInstaller 生成且被 gitignore ⇒ 干净 clone 上
    glob **匹配不到任何文件**，`tauri-build` 直接让 build.rs 失败：
    `glob pattern binaries/backend/**/* path not found or didn't match any files.`
    实测确认：放**任意一个占位文件**进去就能通过（不需要真跑 PyInstaller、也不需要前端 `dist/`）。
    ⇒ 这条断言守的是"CI 别忘了那一步"，而不是 Rust 代码本身。

    反向验证：把 `run:` 里那条路径改掉 ⇒ 红。
    """
    assert "binaries/backend" in _all_run_commands(), (
        "没有 workflow 在 `run:` 里为 cargo 准备 `binaries/backend/` 占位文件 —— "
        "干净 clone 上 build.rs 会因资源 glob 匹配不到而失败"
    )

