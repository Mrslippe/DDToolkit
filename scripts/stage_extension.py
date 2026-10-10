r"""把仓库根的 `extension/` 暂存到 `frontend/src-tauri/extension/`，好让 `tauri build` 打进产物。

用法: `python scripts/stage_extension.py`（由 `npm run tauri:build` 自动调用，也可单跑）

## 为什么需要这一步（2026-10-06 用户口径）

> 「可以在构建的时候直接打包进包体中吗，这样直装版也直接在文件目录中就有拓展」

- Tauri 的 `bundle.resources` 只能收 **tauri 目录（`frontend/src-tauri/`）里**的文件，
  而扩展本体住在**仓库根**的 `extension/`（它同时还得是"能直接加载解压缩"的那份源码）；
- 所以构建前拷一份过去，`tauri.conf.json` 里写 `extension/**/*`（**数组形式**；改成 map + glob
  会把目录摊平 —— `binaries/backend` 那次事故见 `devlog/036`）；
- 装出来的落点：直装版 `<安装目录>\extension\…`、便携版 `DDtoolkit\extension\…`，
  于是新用户**不必再 clone 仓库**：设置 → 登录 → 浏览器扩展 那一栏会把路径显示出来，
  点「打开目录」就是资源管理器里的那个文件夹，把它填进 `edge://extensions` 的
  「加载解压缩的扩展」即可（浏览器只接受"商店"或"本地目录 + 开发人员模式"两种来源）。

## 拷什么（白名单，不是黑名单）

`manifest.json` + `popup.html` + `popup.css` + `src/` + `icons/` + `README.md`（给人看）。
**不拷** `test/`（`node --test` 的用例，浏览器用不到）与任何 `__pycache__` ——
以后 `extension/` 里多出什么都不至于被打进安装包。

⚠️ **白名单漏一个"manifest 引用的文件"= 打出一份坏扩展，而且症状很远**（2026-10-08 修，
`devlog/456`）：`manifest.json` 的 `action.default_popup` 指着 `popup.html`，而它原先**不在
`ITEMS` 里** ⇒ 暂存产物（开发构建里的 `target/debug/extension`、安装包里的 `<安装目录>\extension`）
**没有弹窗**：用户按界面给的路径加载完，点扩展图标什么都不出来（token 输入框与「同步」按钮
都在那个弹窗里）。所以现在 `assert_loadable()` 会把 manifest 引用到的**每一个**路径逐个查一遍，
`popup.html` 自己引用的 `popup.css` / `src/popup.js` 也查 —— 判据在
`tests/test_stage_extension.py`（含"抽引用"那一步的正对照与一条反例）。
`frontend/src-tauri/extension/` 是构建产物（已 gitignore），**不要手改它**：改 `extension/` 里的源。
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"
DST = ROOT / "frontend" / "src-tauri" / "extension"

#: 进产物的条目（白名单）。`README.md` 也在里面：用户打开那个目录时总得有句话说怎么装。
#: ⚠️ 加/删这一行前先读上面那段：**manifest 引用到的文件必须在这里**（有判据兜着）。
ITEMS = ("manifest.json", "popup.html", "popup.css", "src", "icons", "README.md")
#: 四档图标少一个，浏览器工具栏就是一格空白（`extension/test/logic.test.mjs` 也钉着这条）。
ICON_SIZES = ("16", "32", "48", "128")

#: manifest 里"指向文件"的键（值可能是字符串、字符串数组，或 `{尺寸: 路径}` 这样的字典）。
#: ⚠️ 只认这些键 —— manifest 里**新加**一种引用（如 `side_panel`）时要一起加进来，
#: 否则它又会变成"漏拷一个文件、打出一份坏扩展"。
_MANIFEST_REF_KEYS = (
    "icons", "default_icon", "default_popup", "options_page", "options_ui",
    "service_worker", "scripts", "js", "css", "page", "resources",
    "chrome_url_overrides", "web_accessible_resources", "content_scripts",
    "background", "action", "declarative_net_request", "sandbox",
)
#: 认成"文件"的字符串形状（`run_at: "document_idle"`、`matches: "*://…"` 这类不算）。
#: ⚠️ 通配（`web_accessible_resources` 里可以有 `icons/*`）按设计跳过：那不是单个文件。
_ASSET_EXT = (".js", ".mjs", ".css", ".html", ".png", ".json", ".svg", ".wasm")
#: HTML 里引用本地文件的两条（`popup.html` → `popup.css` / `src/popup.js`）
_HTML_REF_RE = re.compile(r'(?:src|href)\s*=\s*"([^"]+)"')


def manifest_refs(src: Path) -> list[str]:
    """manifest.json 引用到的**本地文件**路径（去重、保持出现顺序）。

    做法是**递归扫**上面那几个键下的所有字符串值，再按 `_ASSET_EXT` 认成文件 ——
    比逐键手写路径不容易漏（`icons` 与 `action.default_icon` 都是 `{尺寸: 路径}` 字典、
    `content_scripts` 是数组套字典）。外链、`data:`、含 `*` 的通配都跳过：它们不是要拷的文件。
    """
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    found: list[str] = []
    seen: set[str] = set()

    def collect(node) -> None:
        if isinstance(node, dict):
            for v in node.values():
                collect(v)
            return
        if isinstance(node, list):
            for v in node:
                collect(v)
            return
        if not isinstance(node, str):
            return
        val = node.strip()
        if not val or val.startswith(("http://", "https://", "data:", "//", "*")):
            return
        if "*" in val or not val.lower().endswith(_ASSET_EXT):
            return
        if val not in seen:
            seen.add(val)
            found.append(val)

    for key in _MANIFEST_REF_KEYS:
        if key in manifest:
            collect(manifest[key])
    return found


def html_refs(path: Path) -> list[str]:
    """HTML 里引用的本地文件（`<script src>` / `<link href>`），外链与 data: 跳过。"""
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    out: list[str] = []
    for ref in _HTML_REF_RE.findall(text):
        if ref.startswith(("http://", "https://", "data:", "//", "#")):
            continue
        if ref not in out:
            out.append(ref)
    return out


def assert_loadable(src: Path = SRC) -> None:
    """源目录必须是一份"浏览器真的能加载"的扩展 —— 不合格就停手，别打出一个坏产物。"""
    missing = [i for i in ITEMS if not (src / i).exists()]
    if missing:
        raise SystemExit(f"[stage] {src.name}/ 缺这些条目：{missing} —— 源目录不完整，拒绝继续")
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3:
        raise SystemExit("[stage] manifest_version ≠ 3 —— 这样打出来的产物浏览器不认")
    if not manifest.get("icons") or not manifest.get("action", {}).get("default_icon"):
        raise SystemExit("[stage] manifest.json 没声明图标（工具栏会是一格空白）")
    for size in ICON_SIZES:
        if not (src / "icons" / f"{size}.png").is_file():
            raise SystemExit(f"[stage] 缺 icons/{size}.png（四档必须齐）")
    # ⚠️ **manifest 引用到的每个文件都必须真的在**，而且必须在 `ITEMS` 里
    #    （在源里但不在白名单 ⇒ 产物里没有 ⇒ 用户加载完点图标什么都不出来）
    refs = manifest_refs(src)
    if not refs:
        raise SystemExit("[stage] 从 manifest 里一个文件引用都没抽出来 —— 抽取逻辑坏了？")
    gone = [r for r in refs if not (src / r).is_file()]
    if gone:
        raise SystemExit(f"[stage] manifest 引用了这些文件，但源目录里没有：{gone}")
    not_copied = [r for r in refs if not _covered_by_items(r)]
    if not_copied:
        raise SystemExit(
            f"[stage] manifest 引用了这些文件，但它们在 `ITEMS` 白名单外（产物里会缺）：{not_copied}"
            f" —— 把它们加进 ITEMS，或改 manifest")
    # HTML 内部引用（popup.html → popup.css / src/popup.js）同一条道理，深一层
    for page in refs:
        if page.endswith(".html"):
            inner = html_refs(src / page)
            bad = [r for r in inner if not (src / r).is_file() or not _covered_by_items(r)]
            if bad:
                raise SystemExit(f"[stage] {page} 引用了这些文件，但它们缺失或不在白名单里：{bad}")


def _covered_by_items(rel: str) -> bool:
    """相对路径是否被 `ITEMS` 覆盖（`src/popup.js` 由 `src` 这一条覆盖）。"""
    return any(rel == item or rel.startswith(item.rstrip("/") + "/") for item in ITEMS)


def stage(src: Path = SRC, dst: Path = DST) -> list[str]:
    """拷贝白名单条目到 `dst`（先清空）并返回拷了哪些；不打印，方便用例直接调。"""
    assert_loadable(src)
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    for item in ITEMS:
        s, d = src / item, dst / item
        if s.is_dir():
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)
    return list(ITEMS)


def _summary(dst: Path) -> tuple[int, int]:
    files = [f for f in dst.rglob("*") if f.is_file()]
    return len(files), sum(f.stat().st_size for f in files)


def main() -> int:
    ap = argparse.ArgumentParser(description="把 extension/ 暂存进 src-tauri（给 tauri build 打包）")
    ap.add_argument("--src", default=str(SRC), help="扩展源目录（默认仓库根的 extension/）")
    ap.add_argument("--dst", default=str(DST), help="暂存目标（默认 frontend/src-tauri/extension/）")
    args = ap.parse_args()

    src, dst = Path(args.src), Path(args.dst)
    staged = stage(src, dst)
    n, size = _summary(dst)
    rel = dst.relative_to(ROOT) if dst.is_relative_to(ROOT) else dst
    print(f"[stage] {src} -> {rel}  （{n} 个文件 / {size / 1024:.1f} KB；{', '.join(staged)}）")
    print("[stage] 不拷 test/（node --test 的用例，产物里用不着）；改扩展请改 extension/ 里的源")
    return 0


if __name__ == "__main__":
    sys.exit(main())
