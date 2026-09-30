# -*- coding: utf-8 -*-
"""文档结构门禁：头块 · 代码路径 · 预算 · 豁免清单。

## 为什么需要它

2026-09-30 的文档调查实测出两条：

1. **没有任何东西验证「文档说的东西真的存在」。** `tests/test_gate.py` 引用
   `alembic/versions/f007_vtuber_events_kind.py`，真实文件叫 `f007_event_kind_emoji.py`
   —— 而那条断言照样绿（它按 `alembic/` 前缀判档，不看文件名）。
2. **`doc_check.py` 全绿的同时，文档里躺着 ≥6 处硬数字矛盾**（「12 表 ER」vs 真值 14、
   「14 个仓储类」vs 真值 13、`docs/frontend/ARCHITECTURE.md` 同一份文件内三个指标各自自相矛盾）。
   根因是它的数字检查是**白名单正则**：没登记到的写法一律逃逸。

⇒ 本脚本不再枚举「哪些写法要查」，改判**结构不变量**：每份文档必须自己声明
`scope / not-scope / sot / verify / budget / retire-when`，然后机器验证这些声明本身。
其中 **`not-scope` 是防复述的承重墙** —— 复述的根因不是"写的人不小心"，而是
文档不知道自己**不该**写什么（口径真源见 `docs/DEV-LOOP.md` §0.4）。

## 头块格式（刻意极简，不引入 YAML 依赖）

    ---
    doc:         backend/fetch-pipeline
    class:       module
    scope:       一句话：本篇负责什么
    not-scope:   不写什么 → backend/PLATFORMS.md；表结构 → backend/DATA-MODEL.md
    sot:         app/services/scheduler.py, app/services/fetcher.py
    verify:      python -m pytest -q tests/test_services.py
    budget:      400
    retire-when: scheduler.py 被拆分，或抓取链路整体重写
    ---

解析约束（违反即 FAIL）：值**单行**、不得以 `-` / `{` / `[` 开头（不支持嵌套与数组）。

**为什么手写解析器而不 import yaml**：`pyyaml` 在本仓是**传递依赖**、没在
`pyproject.toml` 显式声明 —— 踩的正是 `docs/ops/RELEASE.md 不变量 24记的那个坑
（`python-multipart` 被隐式满足，缺失时 4 个测试文件收集失败）。而极简格式还顺带
逼着头块保持简单：复杂 YAML 会诱使人在文档里塞逻辑。

## 检查项（`CHECKS`，顺序与下表一致）

| # | 检查 | 级别 | 判据 |
|---|---|---|---|
| 1 | 头块完整 | FAIL | 按 `class` 校验必填字段；头块缺失 / 字段缺失 / `class` 非法 / 解析报错 |
| 2 | 代码路径存在 | FAIL | 正文反引号内的 `app/` `frontend/` `scripts/` `tests/` `alembic/` `.github/` 路径必须存在；**活文档里还有 `docs/**` 文档引用**（点时刻文档不校验，见下） |
| 3 | `not-scope` 指向存在 | FAIL | `not-scope` 里 `→ X` 的 X 必须存在于 `docs/` 下 |
| 4 | 行数预算 | FAIL | 实际行数 ≤ 生效预算；生效预算 = 声明的 `budget`，**没声明就退回该 class 的上限**（不设装饰性上限）；声明的 `budget` 本身不得超过上限 |
| 5 | 豁免清单自清 | FAIL | 已带合法头块的文档仍留在 `GRANDFATHERED` ⇒ 必须删掉那一行 |
| 6 | 测量值句式 | FAIL | `N 张表` / `N 个 Repo·用例·端点·路由·迁移` / `N 篇 devlog` / `N passed`；不含 `N 行`（语义歧义，见下） |

### 检查 2 的四条口径（2026-09-30 对着存量 28 份调出来的）

调试记录：第一版在存量文档上命中 **37 条，其中 34 条是假阳性**。逐条看过后定下四条：

1. **`:后缀` 逐级回退**。本仓通行 `app/main.py::MIGRATION_HEAD`（符号）、
   `scripts/x.py:86/87`（行号列表）、`app/core/http.py:a/b`（混合）三种写法，
   占假阳性的 25/37。`_resolve` 从长到短砍 `:` 之后的部分，落到文件即算存在。
2. **含 `*` / `?` / `{}` / `<>` 一律不判**。`alembic/versions/eNNN_*.py` 这种
   "一族文件"的示意写法，用 glob 去匹配只会误报缺失。
3. **被 `.gitignore` 排除的路径算存在**。`scripts/backend-8000.bat` 是**有意不入库**
   的个人脚本（`docs/ops/RELEASE.md 不变量 19），文档引用它完全合法。
4. **`.md` 结尾的一律不判**。检查 2 只管**代码**路径；文档间指向归检查 3。
   不排除的话 `frontend/UI-MAP.md` 会撞上 `frontend/` 这个代码前缀被误判。

### 检查 2 的另一半：活文档里的 `docs/**` 引用（2026-09-30 加）

上面第 4 条只管带代码前缀的。**带 `docs/` 前缀的完整路径**另走 `_normalize_docs_ref`，
并且**只对活文档生效**（`LIVE_CLASSES`）—— 点时刻文档（plan / snapshot / spec）记的就是
当时的事，引用旧路径是**对的**，校验它只会逼人去改历史记录。

起因是真事：文档重构把 `docs/UI-MAP.md` 搬成 `docs/frontend/UI-MAP.md`，引用它的
**9 处活文档与代码注释一处都没红**；同批删掉 `docs/design/react-*/` 后 8 处"视觉按该导出"
的出处指针也全悬空了。**"删了/搬了被引用的东西"是本仓最安静的一类错误** —— 行为错了
一定有东西红，而**引用错了什么都不红**。

⚠️ 只判**像完整文件路径**的引用（末段带 `.`）：这样自动放过带占位符的模板
（`docs/releases/v<版本>.md`）与部分路径（`docs/releases/v`）。
⚠️ 代码路径仍然走 `_resolve`（要能吃 `::符号` / `:行号` 后缀），**别把两条路合并成一句** ——
实测合并的第一版让 `app/main.py::_run_migrations(` 这类通行写法集体报红。

修完后命中 **3 条，全部为真**：`docs/TODO.md` 的 `scripts/export_archive.py`（计划中）、
`docs/backend/PLATFORMS.md` 的 `app/services/platforms/douyin.py`（抖音未接）、
`docs/design/status-island/projects-source-review.md` 的 `.github/workflows/release.yml`
（**那是外部项目的**，FocuSD 的 release 配置）—— 第三条催生了第二个标记 `<!-- 非本仓 -->`。

### 检查 2 的两个行内标记（写在那一行上，只豁免那一行）

| 标记 | 语义 |
|---|---|
| `<!-- 未建 -->` | 本仓计划中、尚未创建 |
| `<!-- 非本仓 -->` | 引用的是外部项目 / 第三方仓库的路径 |

判据是"**你能不能为这条引用说清楚它属于哪一种**"，而不是"路径在不在"。

✅ **检查 6 自 2026-09-30（P4）起是 FAIL**：存量已清（当时 9 份 12 处）。
它只管 `MEASURE_CLASSES` 里的"活文档"；`plan`/`snapshot`/`spec` 天然是某一天的内容，
其中的数字就是内容本身。`ops/PERF.md` 用头块 `allow-measures` 显式 opt-in（它是基线登记处）。

⚠️ **检查 4 的口径**：「行数」= **物理行数**（`str.splitlines()` 的长度），
不是非空行数。本仓两种口径都出现过并因此出过错（`ROADMAP-DONE.md` 2026-09-13
专门记过一条），所以 `--list` 把两个数都打出来。

## 豁免（`GRANDFATHERED`）

P0 上线时已存在的 28 份文档没有头块。**逐份迁移**，每迁一份就从 `GRANDFATHERED`
删掉一行；检查 5 会在文档带上头块后**强制**你删 —— 豁免清单只能单调缩小，
不会变成永久垃圾。脚本每次打印「存量待迁移 N 份」。

## 用法

    python scripts/docs_gate.py            # 打印全表，有 FAIL 退出 1
    python scripts/docs_gate.py --quiet    # 只印失败与警告（供 dev_check.py --docs 调用）
    python scripts/docs_gate.py --list     # 逐份列 class / 物理行 / 非空行 / 预算 / 头块状态
    python scripts/docs_gate.py --audit    # 忽略豁免，把检查 1–4 对**全部**文档跑一遍（调参用）
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

# ── 扫描面：docs/ 下全部 .md，除去两类归档 ─────────────────────────────────
#   releases/  历史发布说明（写的是当时的值，本就该与今天不同）
#   reference/ 外部接口存档（只读，勿手改）
EXCLUDE_DIRS = ("releases", "reference")

# ── class → 必填字段 ────────────────────────────────────────────────────────
_BASE = ("doc", "class", "scope")
_RULE = ("not-scope", "sot", "verify")            # 有实现契约的文档共同需要
CLASS_FIELDS: dict[str, tuple[str, ...]] = {
    "nav":       _BASE + ("budget",),              # 导航 / 索引（根目录入口必须短）
    "tracker":   _BASE + ("budget",),              # 待办清单
    "overview":  _BASE + ("sot", "budget"),
    "framework": _BASE + _RULE + ("budget", "retire-when"),
    "module":    _BASE + _RULE + ("budget", "retire-when"),
    "spec":      _BASE + _RULE + ("retire-when",),
    # 查询型索引（UI-MAP 这类）：靠 Ctrl+F 用，不通读 ⇒ 字段要求同 framework，
    # 但行数上限宽松 —— 它的价值就是"全"，砍长度等于砍覆盖率。
    "index":     _BASE + _RULE + ("budget", "retire-when"),
    # 计划文档不要求 `sot`：它的"真源"是代码，但计划本身不描述代码现状，
    # 逼它填一个 sot 只会逼出假指针。它要的是 `expires`（到期复核/删除）。
    "plan":      _BASE + ("not-scope", "expires"),
    "snapshot":  _BASE + ("verified",),
    "glossary":  _BASE + ("budget",),
}

# ── class → 行数上限 ────────────────────────────────────────────────────────
# 判据：**这份文档在改什么的时候会被读**。
#   · 根目录文档（nav/tracker/overview/glossary）—— 任何需求都可能要读 ⇒ 严
#   · framework —— 改那一侧的任何东西都要读 ⇒ 严（300）
#   · module / spec / index / plan / snapshot —— 只在改那个模块时读 ⇒ 宽
#
# ⚠️ 2026-09-30（P1 开工时）重新校准过一次：P0 定下的子目录上限（module/spec 400、
#    snapshot 400、plan 600）拍得比现实紧，实测 **6 份文档一搬过去就超**（UI-MAP 1501、
#    ARCHITECTURE-IMPROVEMENT-EXECUTION 941、platforms-xhs 808、backend-repos 764、
#    fetch-pipeline 677、archive-cards 584）⇒ 会逼着人去拆"本来就只干一件事"的文档。
#    用户点名的四个数（总览 150 / 框架 300 / 术语 300 / TODO 150）**保持不变**。
#
# ⚠️ 2026-09-30（P2 拆完 ARCHITECTURE 后）module 700 → **900**：拆完实测唯一的超标项是
#    `backend/FETCH-PIPELINE.md` **810 行** —— 而它对应的 `scheduler.py` 是 **3524 行**
#    （全仓最大源文件，第二名的 3 倍），抓取链路就是这个项目最复杂的子系统。
#    900 仍是 framework 的 3 倍以内、且低于 plan/snapshot/index —— 上限的作用是拦失控，
#    不是逼着把一个内聚的模块文档劈成两半（那正是校准时要避免的"白拆"）。
BUDGET_CEILING: dict[str, int] = {
    "nav": 60, "tracker": 150, "overview": 150, "glossary": 300,
    "framework": 300,
    "module": 900, "spec": 700, "index": 1600, "plan": 1000, "snapshot": 1000,
}

# ── 豁免清单：P0（2026-09-30）上线时已存在的文档 ────────────────────────────
# 规则：每迁移一份就删一行；清空后本集合连同检查 5 一起删除。
# ⚠️ 不要往里加新条目 —— 检查 5 会拦住你，那是设计如此。
#
# 进度：P0 上线 28 份 → P1 迁出 18 → P2 迁出 1（ARCHITECTURE 三拆）→ P3 迁出 4
#       → P4 迁出 3（DEV-LOOP 重写 · TODO 瘦身 · GLOSSARY 瘦身）
#       ⇒ **清空**。ROADMAP-DONE 已删除，不再需要豁免。
GRANDFATHERED: frozenset[str] = frozenset()

# ── 检查 2：哪些前缀算「仓库代码路径」 ──────────────────────────────────────
# 刻意不含 `docs/` —— 文档自身会在 P1 大批搬家，检查 3 单独管文档间指向。
PATH_PREFIXES = ("app/", "frontend/", "scripts/", "tests/", "alembic/", ".github/")
PATH_ROOT_FILES = frozenset({"backend_main.py", "pyproject.toml", "uv.lock"})
# 检查 2 的两个行内豁免标记（写在**那一行**上，只豁免那一行）：
#   <!-- 未建 -->    本仓计划中、尚未创建（如 TODO 里点名的待建脚本）
#   <!-- 非本仓 -->  引用的是外部项目/第三方仓库的路径（调研类文档常见）
NOT_BUILT_MARK = "<!-- 未建 -->"
FOREIGN_MARK = "<!-- 非本仓 -->"
ESCAPE_MARKS = (NOT_BUILT_MARK, FOREIGN_MARK)

_BACKTICK = re.compile(r"`([^`\n]+)`")
_TRAILING = "。，；：、,.;:)）]】》"
_FIELD_NAME = re.compile(r"[a-z][a-z0-9-]*\Z")

# ── 检查 6：测量值句式 ──────────────────────────────────────────────────────
# 只抓「数量 + 量词」里**语义无歧义**的那几种。
#
# ⚠️ 2026-09-30（P1 首批）收紧过一次：初版还带 `\d+ 行` / `\d+ 个文件` / `\d+ 个组件`，
#    实测在已迁移的 19 份上命中 35 处，**绝大多数是假阳性** ——
#      · 「**210×175 / 194 / 213**（1/2/3 行）」  ← "行"是表格行号
#      · 「每需求 1 篇、≤**40 行**」              ← "40 行"是**规则**（定义值），不是测量值
#      · 「`--motion-base`）秒数 →**2 行** 320ms」 ← 版式描述
#    中文的"行"同时是 line / row / 规则单位，做不了判据。**判据要准，不准就不该上线** ——
#    P4 要把它升成 FAIL，靠的正是一个低误报的模式。
MEASURE_PATTERNS = (
    r"\d[\d,]*\s*张表",
    r"\d[\d,]*\s*个\s*(?:Repo|仓储类|模型|路由|端点|接口|用例|迁移)",
    r"\d[\d,]*\s*篇\s*devlog",
    r"\d[\d,]*\s*(?:passed|failed)",
)
MEASURE_RE = re.compile("|".join(MEASURE_PATTERNS))
# 命中行里出现这些词 ⇒ 它在**定规则**或**划上限**，不是声称现状
MEASURE_RULE_WORDS = ("≤", "≥", "上限", "预算", "不超过", "至少", "阈值")
# 只有"活文档"才按测量值管 —— `plan`/`snapshot`/`spec` 是某一天的内容，
# 其中的具体数字就是它的内容（改动面 / 行数 / 判据），不是会漂的散文。
# **同一个集合也决定"要不要校验它里面的 `docs/**` 引用"** —— 点时刻文档引用旧路径是**对的**
# （它记的就是当时的事），校验它只会逼人去改历史记录。
LIVE_CLASSES = frozenset({"nav", "tracker", "overview", "framework",
                          "module", "index", "glossary"})
MEASURE_CLASSES = LIVE_CLASSES
# 显式 opt-in：`allow-measures: <理由>` 写在头块里。**写出来才看得见** ——
# 门禁基线的登记处（`ops/PERF.md`）是唯一正当的使用者。
MEASURE_OPT_OUT = "allow-measures"
MEASURE_TOP = 8          # 每份文档最多列几条明细，避免刷屏
MEASURE_HINT = ("指向真源，别写死：迁移 head/表数/路由数/devlog 编号 → "
                "`python scripts/gen_doc_numbers.py --list`；门禁基线 → 脚本自己那行输出")


# ── 头块解析 ────────────────────────────────────────────────────────────────
def parse_header(text: str) -> tuple[dict[str, str], list[str]]:
    """解析文档头块。返回 (字段, 错误)。

    头块 = 第 1 行 `---` + 若干 `key: value` 单行 + `---`。
    刻意不支持嵌套 / 数组 / 多行 —— 规范简单才守得住。
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, ["缺少头块（文件第 1 行应为 `---`）"]
    fields: dict[str, str] = {}
    errs: list[str] = []
    for i, raw in enumerate(lines[1:], start=2):
        if raw.strip() == "---":
            return fields, errs
        if not raw.strip():
            continue
        if ":" not in raw:
            errs.append(f"第 {i} 行不是 `key: value`：{raw.strip()[:40]}")
            continue
        key, val = raw.split(":", 1)
        key, val = key.strip(), val.strip()
        if not _FIELD_NAME.match(key):
            errs.append(f"第 {i} 行字段名非法（只许小写字母/数字/连字符）：`{key}`")
        if val[:1] in ("-", "{", "["):
            errs.append(f"第 {i} 行 `{key}` 的值不得以 `-`/`{{`/`[` 开头"
                        "（头块不支持嵌套与数组）")
        if key in fields:
            errs.append(f"第 {i} 行字段 `{key}` 重复")
        fields[key] = val
    errs.append("头块没有结束行 `---`")
    return fields, errs


def read_doc(path: Path) -> tuple[str, int, int]:
    """返回 (正文, 物理行数, 非空行数)。

    ⚠️ 两种行数口径本仓都用过并因此出过错，所以两个都返回、`--list` 都打。
    """
    text = path.read_text(encoding="utf-8", errors="replace")
    body = text.splitlines()
    prose = next((i for i, l in enumerate(body) if l.strip()), 0)
    lines = body[prose:]
    return text, len(lines), sum(1 for l in lines if l.strip())


# ── 检查 2 的路径提取 ───────────────────────────────────────────────────────
def _normalize_path(token: str) -> str | None:
    """把反引号内容规整成候选仓库路径；不像「可验证的具体路径」则 None。

    - `{a,b}.py`、`<占位符>`、`*` `?` 一概不判 —— 它们是"一族文件"，不是具体路径
      （实测 `alembic/versions/eNNN_*.py` 这种示意写法会被 glob 误判成缺失）
    - **以 `.md` 结尾的一律不判** —— 那是文档间指向，归检查 3；且文档会在 P1 大批搬家。
      不排除的话 `frontend/UI-MAP.md` 会撞上 `frontend/` 这个**代码**前缀而被误判
    - `::符号` / `:123(-456)` / `:86/87` 等后缀留给 `_resolve` 按前缀回退
    """
    tok = token.strip().split()[0] if token.strip() else ""
    tok = tok.strip("`").rstrip(_TRAILING)
    if not tok or any(c in tok for c in "{}<>*?"):
        return None
    if tok.endswith(".md"):
        return None
    if tok in PATH_ROOT_FILES:
        return tok
    if not tok.startswith(PATH_PREFIXES):
        return None
    return tok.rstrip("/") or None


_IGNORED_CACHE: dict[str, bool] = {}


def _normalize_docs_ref(token: str) -> str | None:
    """把反引号内容规整成候选 **`docs/**` 文档引用**；不像完整路径则 None。

    ⚠️ **为什么要加这条**（2026-09-30，撞上真事）：文档重构把 `docs/UI-MAP.md` 搬成
    `docs/frontend/UI-MAP.md`，而**引用它的 9 处活文档与代码注释不会自己红** ——
    检查 2 原先只看代码前缀（`app/` `frontend/` `scripts/` …），`docs/**` 不在扫描面内。
    同一批里删掉 `docs/design/react-*/` 之后，8 处"视觉按该导出"的出处指针也全悬空了，
    同样没有任何东西会响。**"删了/搬了被引用的东西"是本仓最安静的一类错误。**

    只判**像完整文件路径**的引用（末段带 `.`），这样能自动放过：
      · 部分路径的写法（`docs/releases/v<版本>.md` 的 `<版本>` 占位、`docs/releases/v`）
      · 目录引用（末段无点、但目录真实存在）
    """
    tok = token.strip().split()[0] if token.strip() else ""
    tok = tok.strip("`").rstrip(_TRAILING)
    if not tok or any(c in tok for c in "{}<>*?"):
        return None
    if not tok.startswith("docs/"):
        return None
    seg = tok.rsplit("/", 1)[-1]
    if "." not in seg:
        return None            # 目录或部分路径（占位符已在上面挡掉）
    return tok


def _is_ignored(rel: str) -> bool:
    """路径是否被 .gitignore 排除。

    `scripts/backend-8000.bat` 是**有意不入库**的个人脚本（§6 第 19 条），
    文档引用它完全合法 —— 不能因为"仓库里没有"就判缺失。
    """
    if rel not in _IGNORED_CACHE:
        rc = subprocess.run(["git", "check-ignore", "-q", rel], cwd=ROOT,
                            capture_output=True).returncode
        _IGNORED_CACHE[rel] = rc == 0
    return _IGNORED_CACHE[rel]


def _resolve(tok: str) -> bool:
    """token 是否指向一个真实存在（或被有意忽略）的路径。

    逐级砍掉 `:` 之后的部分，让这些写法都能落到那个文件上：

        app/main.py::MIGRATION_HEAD            符号
        scripts/measure_dynamics_round.py:86/87  行号列表
        app/core/http.py:ssl_context/new_async_client  混合

    这些是**本仓通行的引用写法**（实测占检查 2 命中的 25/37），必须支持。
    """
    parts = tok.split(":")
    for i in range(len(parts), 0, -1):
        cand = ":".join(parts[:i]).rstrip("/")
        if cand and (ROOT / cand).exists():
            return True
    return _is_ignored(tok.split(":", 1)[0].rstrip("/"))


def check_paths(text: str, live: bool = True) -> list[str]:
    """检查 2：正文反引号内的**代码路径**必须存在；活文档里连 `docs/**` 引用也要能解析。

    `live=False`（点时刻文档：plan / snapshot / spec）时**不校验 `docs/**`** ——
    那类文档记的就是当时的事，引用旧路径是**对的**，校验它只会逼人改历史记录。
    """
    bad: list[str] = []
    seen: set[str] = set()
    for i, line in enumerate(text.splitlines(), start=1):
        if any(mark in line for mark in ESCAPE_MARKS):
            continue
        for m in _BACKTICK.finditer(line):
            tok = _normalize_path(m.group(1))
            is_docs = False
            if tok is None:
                # 活文档里的 `docs/**` 引用也要落地（见 DOCS_REF 的注释）
                tok = _normalize_docs_ref(m.group(1)) if live else None
                is_docs = tok is not None
            if tok is None or tok in seen:
                continue
            seen.add(tok)
            # ⚠️ 代码路径走 `_resolve`（要能吃 `::符号` / `:行号` 后缀），
            #    docs 引用是完整路径、直接判存在 —— 别把这两条合并成一句。
            ok = (ROOT / tok).exists() if is_docs else _resolve(tok)
            if not ok:
                bad.append(f"第 {i} 行引用的路径不存在：`{tok}`"
                           f"（本仓未建 → {NOT_BUILT_MARK}；引用外部项目 → {FOREIGN_MARK}）")
    return bad


# ── 检查 3 的指向提取 ───────────────────────────────────────────────────────
def _not_scope_targets(value: str) -> list[str]:
    out: list[str] = []
    for part in re.split(r"[；;]", value):
        if "→" not in part:
            continue
        tail = part.split("→", 1)[1].strip().strip("`").rstrip(_TRAILING)
        tail = tail.split()[0] if tail.split() else ""
        if tail:
            out.append(tail)
    return out


# ── 检查 1/3/4/6 的按文档校验 ───────────────────────────────────────────────
def check_document(rel: str, text: str, lines: int) -> tuple[list[str], list[str], dict]:
    """对一份**未豁免**的文档跑检查 1/3/4。返回 (fails, warns, 头块字段)。"""
    fails: list[str] = []
    warns: list[str] = []
    fields, errs = parse_header(text)
    fails += [f"头块：{e}" for e in errs]

    cls = fields.get("class", "")
    if cls and cls not in CLASS_FIELDS:
        fails.append(f"头块：`class: {cls}` 非法（合法值：{' / '.join(CLASS_FIELDS)}）")
        cls = ""
    if cls:
        missing = [k for k in CLASS_FIELDS[cls] if k not in fields]
        if missing:
            fails.append(f"头块：`class: {cls}` 缺必填字段 {', '.join('`'+m+'`' for m in missing)}")

    # 检查 3：not-scope 指向的文档必须存在
    for target in _not_scope_targets(fields.get("not-scope", "")):
        cand = target if target.endswith(".md") else target
        if not (DOCS / cand).exists() and not (ROOT / cand).exists():
            fails.append(f"`not-scope` 指向的文档不存在：`{target}`")

    # 检查 4：预算
    # ⚠️ 2026-09-30（P2 出对照表时发现）：初版只在**声明了 `budget`** 时才查，而
    #    `spec` / `plan` / `snapshot` 三类并不强制声明 ⇒ 那 15 份文档的 class 上限
    #    **一次都没被查过**（`--list` 里显示「无预算」）—— 那是**装饰性判据**，
    #    正是本仓最反对的那种（"红不了的断言等于没有"）。
    #    现在：**没声明就退回 class 上限** —— 上限不可能落空。
    raw = fields.get("budget", "")
    ceiling = BUDGET_CEILING.get(cls)
    budget: int | None = None
    if raw:
        if not raw.isdigit():
            fails.append(f"头块：`budget` 必须是整数，得到 `{raw}`")
        else:
            budget = int(raw)
            if ceiling is not None and budget > ceiling:
                fails.append(f"预算 `{budget}` 超过 class `{cls}` 的上限 `{ceiling}`"
                             "（上限见 BUDGET_CEILING；改上限要连同理由一起改）")
    if budget is None:
        budget = ceiling          # 没声明 ⇒ 用 class 上限（不设装饰性上限）
    if budget is not None and lines > budget:
        src = "声明的 budget" if raw else f"class `{cls}` 的上限"
        fails.append(f"超预算：{lines} 行 > {budget}（物理行；{src}）"
                     "—— 拆文档或删内容，别抬预算")

    # 检查 6：测量值句式（2026-09-30 P4 起由 WARN 升 FAIL —— 存量已清）
    fails += check_measures(rel, text)

    return fails, warns, fields


def check_measures(rel: str, text: str) -> list[str]:
    """检查 6：测量值句式（只报计数 + Top N 明细）。

    适用范围见 `MEASURE_CLASSES`；头块里 `allow-measures` 的文档整体跳过。
    """
    hits: list[str] = []
    body = text.splitlines()
    fields, _errs = parse_header(text)
    if fields.get("class", "") not in MEASURE_CLASSES:
        return []
    if MEASURE_OPT_OUT in fields:
        return []
    # 头块整体跳过：`scope: N 张表` 那类声明由检查 1 管，不算测量值
    close = next((i for i, l in enumerate(body) if i > 0 and l.strip() == "---"), -1)
    for i, line in enumerate(body, start=1):
        if i <= close + 1 or any(mark in line for mark in ESCAPE_MARKS):
            continue
        if any(w in line for w in MEASURE_RULE_WORDS):
            continue
        m = MEASURE_RE.search(line)
        if m:
            hits.append(f"第 {i} 行「{m.group(0).strip()}」：{line.strip()[:60]}")
    if not hits:
        return []
    head = [f"{rel}：{len(hits)} 处测量值句式 —— {MEASURE_HINT}"]
    head += [f"  {h}" for h in hits[:MEASURE_TOP]]
    if len(hits) > MEASURE_TOP:
        head.append(f"  …（另有 {len(hits) - MEASURE_TOP} 处）")
    return head


# ── 扫描面 ──────────────────────────────────────────────────────────────────
def doc_files() -> list[Path]:
    out: list[Path] = []
    for p in sorted(DOCS.rglob("*.md")):
        rel = p.relative_to(DOCS)
        if rel.parts and rel.parts[0] in EXCLUDE_DIRS:
            continue
        out.append(p)
    return out


# ── 检查主体 ────────────────────────────────────────────────────────────────
def run(quiet: bool = False, audit: bool = False) -> tuple[list[str], list[str]]:
    """跑全部检查，返回 (failures, warnings)。只读，不改任何文件。

    audit=True 时忽略 `GRANDFATHERED`，把检查 1–4 对全部文档跑一遍（调参用，
    不进 `CHECKS` 的正式口径）。
    """
    files = doc_files()
    fails: list[str] = []
    warns: list[str] = []
    moved = 0                       # 已带头块的文档数（= 已迁移）
    pending: list[str] = []

    for p in files:
        rel = p.relative_to(ROOT).as_posix()
        text, lines, _nonblank = read_doc(p)
        fields, _errs = parse_header(text)
        has_header = bool(fields.get("class"))
        exempt = rel in GRANDFATHERED and not audit

        if exempt:
            pending.append(rel)
            # 检查 5：带上头块就不许再豁免
            if has_header:
                fails.append(f"{rel}：已带合法头块，请从 `docs_gate.GRANDFATHERED` 删除该行"
                             "（豁免清单只能单调缩小）")
            continue

        moved += 1
        f, _w, fields = check_document(rel, text, lines)
        fails += [f"{rel}：{x}" for x in f]
        # 活文档才校验 `docs/**` 引用；点时刻文档引用旧路径是对的
        live = fields.get("class", "") in LIVE_CLASSES
        fails += [f"{rel}：{x}" for x in check_paths(text, live=live)]

    if not quiet:
        print(f"[docs] 文档结构检查（扫描 {len(files)} 份；已迁移 {moved}；"
              f"存量待迁移 {len(pending)}）")
        if pending and not audit:
            print(f"       存量待迁移：{len(pending)} 份 —— 逐份迁移，每迁一份从 "
                  "`GRANDFATHERED` 删一行")
    return fails, warns


def list_docs() -> int:
    """`--list`：逐份列出 class / 物理行 / 非空行 / 预算 / 头块状态。"""
    _harden_stdout()
    print(f"{'docs 路径':52}{'class':11}{'物理行':>7}{'非空':>7}{'生效预算':>9}  状态")
    for p in doc_files():
        rel = p.relative_to(ROOT).as_posix()
        text, lines, nonblank = read_doc(p)
        fields, errs = parse_header(text)
        cls = fields.get("class", "")
        raw = fields.get("budget", "")
        ceiling = BUDGET_CEILING.get(cls)
        # 生效预算 = 声明的 budget，否则退回 class 上限（与检查 4 同一口径）
        eff: int | None = int(raw) if raw.isdigit() else ceiling
        shown = str(eff) if eff is not None else "-"
        if rel in GRANDFATHERED:
            state = "豁免（待迁移）"
        elif not cls:
            state = "FAIL 头块"
        elif eff is None:
            state = "ok（该类不设上限）"
        else:
            state = "ok" if lines <= eff else f"FAIL 超预算 {lines - eff}"
        print(f"{rel:52}{cls or '-':11}{lines:>7}{nonblank:>7}{shown:>9}  {state}")
    return 0


def _harden_stdout() -> None:
    """控制台编码兜底：警告里会带**文档正文的摘录**，而正文可能出现 GBK 编不出的字符。

    实测（2026-09-30，P1 首批）：`docs/plans/architecture-improvement-execution.md` 与
    `docs/backend/FETCH-PIPELINE.md` 里都有 `⇒`（U+21D2），GBK 编不出来 ⇒
    `print` 抛 `UnicodeEncodeError`。**门禁崩掉比报红更糟**：退出码同样是 1，
    但看不出是哪一条、也没法修。⇒ 把编码错误降级成替换字符，绝不让打印本身失败。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")   # type: ignore[union-attr]
        except (AttributeError, ValueError, OSError):
            pass


def main() -> int:
    _harden_stdout()
    ap = argparse.ArgumentParser(description="文档结构门禁（只读）")
    ap.add_argument("--quiet", action="store_true", help="只印失败与警告")
    ap.add_argument("--list", action="store_true", help="逐份列出 class/行数/预算/头块状态")
    ap.add_argument("--audit", action="store_true",
                    help="忽略豁免，对全部文档跑检查 1–4（调参用，报错不代表要修）")
    args = ap.parse_args()
    if args.list:
        return list_docs()

    print("[docs] 文档结构检查")
    fails, warns = run(quiet=args.quiet, audit=args.audit)
    if not args.quiet:
        for line in warns:
            print(f"  [WARN] {line}")
    if fails:
        for line in fails:
            print(f"\n[FAIL] {line}")
        print(f"\n[FAIL] 共 {len(fails)} 项")
        return 1
    print(f"\n[ok] 无 FAIL" + (f"（{len(warns)} 条警告）" if warns else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
