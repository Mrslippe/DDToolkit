"""应用内更新的发布产物（R23，devlog/113）。

判错的代价**全是静默的**：
- `platforms` 的键写错（不是 `windows-x86_64`）⇒ 所有 Windows 客户端都收不到更新；
- `signature` 为空 ⇒ updater 拒绝安装（用户只看到"更新失败"，不知道是产物的问题）；
- `url` 指向 `latest/download` 而不是 `download/v<版本>` ⇒ 用户下到"最新版"的包却配着旧签名，
  校验必失败 —— 而且只在**发下一个版本时**才暴露。

所以这里对纯函数 `latest_json()` 逐项钉住契约。
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _load(name: str, rel: str):
    """按路径加载脚本（`scripts/` 不是包，用 importlib 最省事）。"""
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


cr = _load("collect_release_mod", "scripts/collect_release.py")

SIG = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIG1pbmlzaWduCg=="


def test_latest_json_has_the_fields_the_updater_needs():
    payload = cr.latest_json("1.0.2", "# 发布说明\n\n- 一条", SIG,
                             "DDtoolkit_1.0.2_x64-setup.nsis.zip")
    assert payload["version"] == "1.0.2"
    assert payload["notes"].startswith("# 发布说明")
    # pub_date 必须是 ISO8601 的 UTC（以 Z 结尾）—— 解析失败会让 updater 直接报错
    assert payload["pub_date"].endswith("Z") and "T" in payload["pub_date"]
    plat = payload["platforms"]["windows-x86_64"]
    assert plat["signature"] == SIG
    assert plat["url"].endswith("/DDtoolkit_1.0.2_x64-setup.nsis.zip")


def test_url_is_pinned_to_the_version_not_latest():
    """`latest/download` 会让"旧版本客户端"下到新包、却配旧签名 ⇒ 校验必失败。"""
    url = cr.latest_json("1.0.2", "x", SIG, "a.zip")["platforms"]["windows-x86_64"]["url"]
    assert "/releases/download/v1.0.2/" in url
    assert "latest/download" not in url


def test_empty_signature_is_rejected_loudly():
    """产物没签名 = 更新一定失败；宁可在打包时就炸，也别发一个"点了没反应"的版本。"""
    with pytest.raises(ValueError):
        cr.latest_json("1.0.2", "x", "   ", "a.zip")


def test_long_notes_are_trimmed_with_a_pointer():
    payload = cr.latest_json("1.0.2", "说明" * 2000, SIG, "a.zip")
    assert len(payload["notes"]) <= cr.NOTES_LIMIT + 40
    assert payload["notes"].endswith("（完整说明见发布页）")


def test_notes_and_signature_are_whitespace_trimmed():
    payload = cr.latest_json("1.0.2", "\n\n  说明  \n\n", f"\n{SIG}\n", "a.zip")
    assert payload["notes"] == "说明"
    assert payload["platforms"]["windows-x86_64"]["signature"] == SIG


def test_version_comes_from_package_json():
    """版本号真源只有一个（六处同步里的 package.json），不是从命令行传进来的。"""
    assert cr._version() == json.loads(
        (ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))["version"]
