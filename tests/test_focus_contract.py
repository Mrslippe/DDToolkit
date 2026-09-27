"""焦点契约的结构判据（批次 14a/14b，devlog/227）。

为什么是"扫源码"而不是"看浏览器"：`:focus-visible` 的匹配靠**真实的键盘交互**，
而 `ui_probe.py` 只能派发合成事件（`el.focus()` 不产生 `:focus-visible`）⇒ 在无头探针里
"焦点环有没有画出来"量不准。所以机器判据钉**契约**（规则在不在、色值收没收敛到令牌），
而"键盘走查"留在 `docs/TODO.md` §1.3 的人工清单里 —— 两者缺一不可，别互相替代。

⚠️ 这些断言是**结构**判断（扫 AST 式的"规则块"），不是文本搜索：`tests/test_quiet_hours.py`
那次教训（判据的举例命中判据自己）在本文件里的体现 = 先把注释剥掉再找规则。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend" / "src"
INDEX = SRC / "index.css"
TOKENS = SRC / "styles" / "tokens.css"
CSS_FILES = sorted(SRC.rglob("*.css"))

COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)


def strip_comments(text: str) -> str:
    """剥掉 `/* … */`（**必须先剥**：判据自己举的例子就写在注释里）。"""
    return COMMENT_RE.sub("", text)


def rules(text: str) -> list[tuple[str, str]]:
    """把 CSS 粗切成 (选择器, 声明块) —— 只有一层 `{}`，够用（本仓没有嵌套 CSS）。"""
    out: list[tuple[str, str]] = []
    body = strip_comments(text)
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", body):
        out.append((m.group(1).strip(), m.group(2)))
    return out


def test_global_outline_none_is_gone_but_focus_visible_still_has_a_ring():
    """14b：**那条"连 `:focus-visible` 一起关"的全局规则必须不在**，取而代之是品牌焦点环。

    反向验证：把它加回 `index.css` ⇒ 本用例红。
    """
    text = strip_comments(INDEX.read_text(encoding="utf-8"))
    assert "outline: none" in text, "前提失效：index.css 里一条 outline:none 都没有了？"
    # ① 不许再有"同时命中 :focus 与 :focus-visible 且 outline:none"的全局规则
    for sel, body in rules(INDEX.read_text(encoding="utf-8")):
        sels = {s.strip() for s in sel.split(",")}
        both = ":focus" in sels and ":focus-visible" in sels
        assert not (both and "outline: none" in body), (
            f"全局 `:focus, :focus-visible {{ outline: none }}` 又回来了 —— "
            f"它会把**所有**键盘焦点视觉一起删掉（devlog/227）：{sel}"
        )
    # ② 必须有全局品牌焦点环，且走令牌
    ring = [(s, b) for s, b in rules(INDEX.read_text(encoding="utf-8"))
            if ":focus-visible" in s and "outline: var(--focus-ring)" in b]
    assert ring, "index.css 里找不到 `:focus-visible { outline: var(--focus-ring) }`"
    # ③ 原注释那半条理由收窄成 canvas/svg（不是连 :focus-visible 一起关）
    narrow = [(s, b) for s, b in rules(INDEX.read_text(encoding="utf-8"))
              if "canvas:focus" in s and "svg:focus" in s and "outline: none" in b]
    assert narrow, "canvas:focus / svg:focus 的收窄规则不见了（图表获焦会描环）"


def test_focus_ring_tokens_exist_and_are_the_only_focus_colours():
    """14a：三个令牌在 `tokens.css` 里定义；**焦点规则里不许再出现那 5 种散落色**。

    反向验证：把任意一处焦点规则改回 `var(--ring)` / `#fff` / `var(--c-primary-deep)` /
    `var(--pill-ring)` ⇒ 本用例红。
    """
    tok = strip_comments(TOKENS.read_text(encoding="utf-8"))
    for name in ("--focus-ring:", "--focus-ring-inset:", "--focus-ring-on-dark:"):
        assert name in tok, f"tokens.css 少了 {name}"
    # `--focus-ring` 必须真的是主色（别把令牌定义成另一个散落色）
    assert re.search(r"--focus-ring:\s*2px solid var\(--c-primary\)", tok), \
        "--focus-ring 的定义不再是「2px 主色」"

    banned = ["var(--ring)", "var(--c-primary-deep)", "var(--pill-ring)"]
    offenders: list[str] = []
    for path in CSS_FILES:
        for sel, body in rules(path.read_text(encoding="utf-8")):
            if ":focus" not in sel:            # 只看**焦点**规则块
                continue
            for bad in banned:
                if bad in body:
                    offenders.append(f"{path.relative_to(SRC)}  {sel}  →  {bad}")
            if "#fff" in body.lower() and "--focus-ring-on-dark" not in body:
                offenders.append(f"{path.relative_to(SRC)}  {sel}  →  硬编码 #fff")
    assert not offenders, (
        "焦点规则里又出现了散落的环色（应当只用 --focus-ring / -inset / -on-dark）：\n  "
        + "\n  ".join(offenders)
    )


def test_forced_colors_and_prefers_contrast_are_handled():
    """高对比度 / 强制颜色：系统焦点色优先，用户要更高对比时加粗。反向：删掉 ⇒ 红。"""
    text = strip_comments(INDEX.read_text(encoding="utf-8"))
    assert "forced-colors: active" in text, "缺 @media (forced-colors: active) —— 系统焦点色会被品牌色压掉"
    assert "prefers-contrast: more" in text, "缺 @media (prefers-contrast: more) —— 高对比用户拿不到更醒目的焦点"
    assert re.search(r"forced-colors[^{]*\{[^}]*Highlight", text), \
        "forced-colors 块里没有用系统色（Highlight）"
