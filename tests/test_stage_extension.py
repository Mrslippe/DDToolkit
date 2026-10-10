# -*- coding: utf-8 -*-
"""扩展暂存（`scripts/stage_extension.py`）：**产物必须是一份浏览器真的能加载的扩展**。

## 为什么有这一组（2026-10-08，`devlog/456`）

用户截图里的登录浮窗把「扩展目录」指到 `target/debug/extension`（打包版是 `<安装目录>\\extension`），
而那份产物**没有 `popup.html`** —— `manifest.json` 的 `action.default_popup` 正指着它，
而暂存白名单 `ITEMS` 里只有 `manifest.json` + `src` + `icons` + `README.md`。
症状很远：按界面路径「加载解压缩的扩展」能装上，但**点图标什么都不出来**
（token 输入框与「同步」按钮都在那个弹窗里）—— 而且这一路此前**没有任何判据**。

三条：① 抽取器抽得出 manifest 引用的文件（**正对照**，免得"没漏"只是没扫到）；
② 真·跑一遍暂存 ⇒ 引用到的每个文件都在产物里；③ **反例**：白名单漏一个 ⇒ `assert_loadable` 必须拦下
（这条是判据的判据 —— 少了它，"②绿"分不清"没漏"与"检查没牙"）。
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _mod():
    """按路径加载 `scripts/stage_extension.py`（`scripts/` 不是包）。"""
    if "stage_extension_under_test" in sys.modules:
        return sys.modules["stage_extension_under_test"]
    spec = importlib.util.spec_from_file_location(
        "stage_extension_under_test", ROOT / "scripts" / "stage_extension.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _copy_src(tmp_path: Path) -> Path:
    """仓库根那份扩展的副本（用例不许改真源）。"""
    dst = tmp_path / "extension"
    shutil.copytree(ROOT / "extension", dst)
    return dst


def test_manifest_refs_extraction_has_teeth():
    """① 正对照：抽取器必须真的抽出东西，且包含那个出过事的 `popup.html`。"""
    refs = _mod().manifest_refs(ROOT / "extension")
    assert refs, "一个引用都没抽出来 ⇒ 判据会静默空转（'没漏'与'没扫到'分不开）"
    assert "popup.html" in refs, "`action.default_popup` 没被抽出来（这条就是 2026-10-08 那个 bug）"
    for size in ("16", "32", "48", "128"):
        assert f"icons/{size}.png" in refs, f"icons.{size} 没被抽出来"
    assert not [r for r in refs if r.startswith(("http", "*"))], "外链/通配不该出现在要拷的清单里"


def test_staged_extension_contains_everything_manifest_needs(tmp_path):
    """② 真跑一遍暂存：manifest（与弹窗 HTML）引用到的每个文件都在产物里。"""
    mod = _mod()
    out = tmp_path / "staged"
    mod.stage(ROOT / "extension", out)

    refs = mod.manifest_refs(ROOT / "extension")
    missing = [r for r in refs if not (out / r).is_file()]
    assert missing == [], f"产物里缺 manifest 引用的文件：{missing}（用户点扩展图标会什么都不出来）"
    # 弹窗那一层也要在：`popup.html` 自己引用的 css/js
    for inner in mod.html_refs(ROOT / "extension" / "popup.html"):
        assert (out / inner).is_file(), f"popup.html 引用的 {inner} 没进产物"
    # 反面：test/ 与源码里的用例不该被打进产物（白名单的意义）
    assert not (out / "test").exists(), "test/ 被打进产物了（浏览器用不到）"
    assert (out / "manifest.json").is_file() and (out / "README.md").is_file()


def test_staging_refuses_a_manifest_reference_outside_the_whitelist(tmp_path):
    """③ 反例（判据的判据）：白名单漏了 manifest 引用的文件 ⇒ 必须**当场拦下**。

    做法：在副本的 manifest 里加一个真实存在、但不在 `ITEMS` 里的文件引用。
    没有这条，②那条绿就分不清"真的没漏"与"检查根本没牙"。
    """
    mod = _mod()
    src = _copy_src(tmp_path)
    (src / "extra-options.html").write_text("<!doctype html><title>x</title>", encoding="utf-8")
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    manifest["options_page"] = "extra-options.html"
    (src / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(SystemExit) as e:
        mod.stage(src, tmp_path / "staged")
    assert "extra-options.html" in str(e.value), "拦是拦了，但没说清是哪个文件（排查会白跑）"


def test_staging_refuses_a_missing_popup(tmp_path):
    """③b 反例之二：源里**根本没有** `popup.html`（manifest 还指着它）⇒ 也要拦下。"""
    mod = _mod()
    src = _copy_src(tmp_path)
    (src / "popup.html").unlink()
    with pytest.raises(SystemExit) as e:
        mod.stage(src, tmp_path / "staged")
    assert "popup.html" in str(e.value)


def test_popup_html_references_exist_in_source():
    """④ 源目录自己就是一份能加载的扩展（`assert_loadable` 对真源不抛）。"""
    _mod().assert_loadable(ROOT / "extension")
