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

`manifest.json` + `src/` + `icons/` + `README.md`（给人看）。**不拷** `test/`（`node --test`
的用例，浏览器用不到）与任何 `__pycache__` —— 以后 `extension/` 里多出什么都不至于被打进安装包。
`frontend/src-tauri/extension/` 是构建产物（已 gitignore），**不要手改它**：改 `extension/` 里的源。
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"
DST = ROOT / "frontend" / "src-tauri" / "extension"

#: 进产物的条目（白名单）。`README.md` 也在里面：用户打开那个目录时总得有句话说怎么装。
ITEMS = ("manifest.json", "src", "icons", "README.md")
#: 四档图标少一个，浏览器工具栏就是一格空白（`extension/test/logic.test.mjs` 也钉着这条）。
ICON_SIZES = ("16", "32", "48", "128")


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
