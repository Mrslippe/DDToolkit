# -*- coding: utf-8 -*-
"""`scripts/release.py` 的纯逻辑用例（版本号定点替换 / NSIS 打平判据 / notes 校验）。

为什么专测这几条：发布脚本的错法**都是"静默改坏文件"**——
盲替版本号会毁 `Cargo.lock`（同名版本号成百上千），锚点漂了会漏改一处，
NSIS 判据写反了则 devlog/036 那种"装完起不来"照样放行。
这些函数全是不碰文件系统与网络的纯函数，所以能直接测。
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import release as R  # noqa: E402


# ── 版本号解析 / 递增 ─────────────────────────────────────────────────

def test_parse_version_accepts_v_prefix_and_rejects_junk():
    assert R.parse_version("1.2.3") == (1, 2, 3)
    assert R.parse_version("v0.9.10") == (0, 9, 10)
    assert R.parse_version(" 1.0.0 ") == (1, 0, 0)
    assert R.parse_version("1.2") is None
    assert R.parse_version("1.2.3.4") is None
    assert R.parse_version("") is None
    assert R.parse_version(None) is None


def test_bump_clears_lower_components():
    assert R.bump("1.0.0", "patch") == "1.0.1"
    assert R.bump("1.0.9", "minor") == "1.1.0"      # patch 必须清零
    assert R.bump("1.9.9", "major") == "2.0.0"      # minor/patch 都要清零
    with pytest.raises(ValueError):
        R.bump("1.0.0", "huge")


def test_new_version_must_be_greater():
    """预检用的比较：发一个"更小"的版本是最容易犯又最贵的错。"""
    assert R.parse_version("1.0.1") > R.parse_version("1.0.0")
    assert not (R.parse_version("1.0.0") > R.parse_version("1.0.0"))
    assert not (R.parse_version("0.9.9") > R.parse_version("1.0.0"))


# ── 六处版本号的定点替换 ─────────────────────────────────────────────

CONFIG = '''class Settings:
    VERSION: str = "1.0.0"   # 与 devlog 最新版本保持一致（v1.0.0：…）
    APP_NAME: str = "DDToolkit"
'''

TAURI = '''{
  "productName": "DDtoolkit",
  "version": "1.0.0",
  "identifier": "com.ddtoolkit.app"
}
'''

CARGO = '''[package]
name = "ddtoolkit"
version = "1.0.0"
edition = "2021"

[dependencies]
serde = "1.0.0"
'''

CARGO_LOCK = '''version = 4

[[package]]
name = "ddtoolkit"
version = "1.0.0"
dependencies = [
 "serde",
]

[[package]]
name = "serde"
version = "1.0.0"
'''

PKG = '''{
  "name": "ddtoolkit-frontend",
  "version": "1.0.0",
  "dependencies": {}
}
'''

README = "![Version](https://img.shields.io/badge/version-1.0.0-ffa2b4) ![License](x)\n"

SAMPLES = {"config": CONFIG, "tauri": TAURI, "cargo": CARGO,
           "cargolock": CARGO_LOCK, "pkg": PKG, "readme": README}


@pytest.mark.parametrize("kind", sorted(SAMPLES))
def test_set_version_writes_and_reads_back(kind):
    new = R.set_version(SAMPLES[kind], kind, "2.3.4")
    assert R.read_version(new, kind) == "2.3.4"
    assert R.read_version(SAMPLES[kind], kind) == "1.0.0"     # 原文本不动


def test_cargo_lock_only_touches_the_ddtoolkit_block():
    """**最危险的一处**：Cargo.lock 里 serde 也是 1.0.0，盲替会一起改掉。"""
    new = R.set_version(CARGO_LOCK, "cargolock", "2.3.4")
    assert 'name = "ddtoolkit"\nversion = "2.3.4"' in new
    assert 'name = "serde"\nversion = "1.0.0"' in new          # 依赖必须原样
    assert new.count("2.3.4") == 1


def test_cargo_toml_touches_package_version_not_dependencies():
    new = R.set_version(CARGO, "cargo", "2.3.4")
    assert 'name = "ddtoolkit"\nversion = "2.3.4"' in new
    assert 'serde = "1.0.0"' in new                            # 依赖版本不动


def test_tauri_and_pkg_only_change_the_version_field():
    t = R.set_version(TAURI, "tauri", "2.3.4")
    assert '"version": "2.3.4"' in t and '"identifier": "com.ddtoolkit.app"' in t
    p = R.set_version(PKG, "pkg", "2.3.4")
    assert '"version": "2.3.4"' in p and '"name": "ddtoolkit-frontend"' in p


def test_config_keeps_comment_and_readme_updates_badge():
    c = R.set_version(CONFIG, "config", "2.3.4")
    assert 'VERSION: str = "2.3.4"' in c
    assert "APP_NAME" in c                                     # 同文件其它字段不动
    r = R.set_version(README, "readme", "2.3.4")
    assert "version-2.3.4-ffa2b4" in r


@pytest.mark.parametrize("kind", sorted(SAMPLES))
def test_missing_anchor_raises_instead_of_silently_skipping(kind):
    """锚点漂了必须**报错**：静默漏改一处 = 发布出去版本号不一致。"""
    broken = SAMPLES[kind].replace("version", "ver").replace("VERSION", "VER")
    with pytest.raises(ValueError):
        R.set_version(broken, kind, "2.3.4")


def test_unknown_kind_raises():
    with pytest.raises(ValueError):
        R.set_version("x", "nope", "1.0.0")


# ── NSIS「打平」判据（devlog/036 的事故形态）──────────────────────────
# ⚠️ 行形状必须照抄真实文件：目标路径**带引号**（`File /a "/oname=…" "src"`）。
#    第一版用例漏了那个引号 → 判据看起来"工作"，其实永不命中（空话）。

def test_classify_nsis_counts_kept_and_flattened():
    lines = [
        r'File /a "/oname=binaries\backend\_internal\python314.dll" "E:\x\backend\_internal\python314.dll"',
        r'File /a "/oname=binaries\backend\_internal\base_library.zip" "E:\x\backend\_internal\base_library.zip"',
        r'File /a "/oname=binaries\backend\ddtoolkit-backend.exe" "E:\x\backend\ddtoolkit-backend.exe"',
        # 打平：目标少了 _internal，源却在 _internal 里 —— 装了起不来
        r'File /a "/oname=binaries\backend\python314.dll" "E:\x\backend\_internal\python314.dll"',
    ]
    kept, flattened = R.classify_nsis(lines)
    assert kept == 2
    assert flattened == 1


def test_classify_nsis_clean_install_script_has_zero_flattened():
    lines = [
        r'File /a "/oname=binaries\backend\_internal\a.dll" "x\backend\_internal\a.dll"',
        r'File /a "/oname=binaries\backend\ddtoolkit-backend.exe" "x\backend\ddtoolkit-backend.exe"',
    ]
    kept, flattened = R.classify_nsis(lines)
    assert kept == 1 and flattened == 0


def test_classify_nsis_against_real_installer_script_if_present():
    """拿**真实构建产物**验一次判据（判据自己错了的话，测试必须红）。

    这条是本批的教训：判据的"0 命中"既可能是"真没打平"，也可能是"正则根本不对"。
    有真文件时必须真的量一次。
    """
    nsi = (Path(__file__).resolve().parent.parent / "frontend" / "src-tauri" /
           "target" / "release" / "nsis" / "x64" / "installer.nsi")
    if not nsi.exists():
        pytest.skip("本机没有 tauri 构建产物（installer.nsi），跳过真实文件校验")
    kept, flattened = R.classify_nsis(nsi.read_text(encoding="utf-8", errors="replace").splitlines())
    assert kept > 0, "在真实安装脚本里一条 _internal 行都没认出来 —— 判据/格式漂了"
    assert flattened == 0, f"真实安装脚本里有 {flattened} 行把后端目录打平了（devlog/036 形态）"


# ── 发布说明与资产预期 ───────────────────────────────────────────────

def test_notes_problems_flags_short_and_placeholder():
    assert R.notes_problems("太短") != []
    assert any("占位符" in p for p in R.notes_problems("x" * 300 + "\nTODO: 写点什么\n"))
    long_ok = "## v1.0.1\n\n" + "本次修复若干问题。" * 40
    assert R.notes_problems(long_ok) == []


def test_asset_expectations_names_and_ranges():
    exp = dict((n, (lo, hi)) for n, lo, hi in R.asset_expectations("1.2.3"))
    assert "DDtoolkit_1.2.3_x64-setup.exe" in exp          # 文件名带版本
    assert "DDtoolkit-portable-win64.zip" in exp           # 便携包不带版本（沿用既有命名）
    for lo, hi in exp.values():
        assert 0 < lo < hi


def test_steps_and_version_files_are_wired():
    """六处版本号必须都在 STEPS 依赖的表里，且步骤名与 step_* 函数一一对应。"""
    assert len(R.VERSION_FILES) == 6
    kinds = {k for k, _, _ in R.VERSION_FILES}
    assert kinds == {"config", "tauri", "cargo", "cargolock", "pkg", "readme"}
    for name in R.STEPS:
        assert callable(getattr(R, f"step_{name}", None)), f"缺 step_{name}"


def test_token_only_required_when_actually_publishing():
    """`--no-remote-release`（只打版推送）**不该**要 token —— 2026-09-15 实测踩到：
    该开关只在 `step_release` 里生效，preflight 却仍按"计划里有 release"要 token，
    把"先打版推送、稍后拿 token 补 Release"这条正当用法整轮拦下。

    判错的代价：没有 token 时**连构建都做不了**（而那一步根本不需要 token）。
    """
    assert R.needs_token(["release"], False) is True          # 真要建 Release → 要 token
    assert R.needs_token(["release"], True) is False          # 只到推送为止 → 不要
    assert R.needs_token(["push"], False) is False            # 计划里没有 release → 不要


def test_select_steps_from_skip_and_only():
    class A:
        only = None
        from_step = None
        skip = None
    a = A()
    assert R.select_steps(a) == R.STEPS
    a.from_step = "verify"
    assert R.select_steps(a)[0] == "verify"
    a.from_step = None
    a.skip = "gates,build"
    sel = R.select_steps(a)
    assert "gates" not in sel and "build" not in sel and "verify" in sel
    a.skip = None
    a.only = "verify"
    assert R.select_steps(a) == ["verify"]


def test_release_step_is_dropped_only_when_the_remote_lacks_the_tag():
    """Release 依赖"tag 已在远端"，但判据必须是**远端事实**，不能拿"计划里有没有 push"推断。

    2026-09-16 用户实测踩到：tag 早已推上去，只是这次用 `--from release` 续跑（计划里没有 push），
    旧的推断把 release 静默摘掉 —— 命令打印"全部完成（0.0 分钟）"却只跑了 report。
    """
    class A:
        version = "1.0.2"
        only = "release,report"      # 没有 push
        from_step = None
        skip = None

    # 远端查得到该 tag（续跑的正常情形）→ 保留，并确认查的就是 `v<版本>`
    seen: list[str] = []
    assert "release" in R.select_steps(A(), remote_tag_check=lambda tag: seen.append(tag) or True)
    assert seen == ["v1.0.2"]

    # 远端确实没有 → 摘掉（否则建 Release 必失败）
    assert "release" not in R.select_steps(A(), remote_tag_check=lambda tag: False)

    # 查询失败（网络/代理）⇒ 未知，保守摘掉，但 report 照跑
    sel = R.select_steps(A(), remote_tag_check=lambda tag: None)
    assert "release" not in sel and "report" in sel

    class B:
        version = "1.0.2"
        only = "push,release,report"  # 计划里有 push：tag 马上就推了，不必问远端
        from_step = None
        skip = None
    asked: list[str] = []
    sel = R.select_steps(B(), remote_tag_check=lambda tag: asked.append(tag) or False)
    assert "release" in sel and asked == [], "计划里已有 push 时不该再查远端"


def test_remote_has_tag_distinguishes_absent_from_unknown(monkeypatch):
    """`ls-remote` 失败 ≠ "远端没有这个 tag"：判错会把人引去重推一个已经在的 tag。"""
    class R0:
        def __init__(self, code: int, out: str = ""):
            self.returncode, self.stdout = code, out

    monkeypatch.setattr(R, "git", lambda *a, **k: R0(0, "abc123\trefs/tags/v1.0.2\n"))
    assert R.remote_has_tag("v1.0.2") is True
    monkeypatch.setattr(R, "git", lambda *a, **k: R0(0, ""))
    assert R.remote_has_tag("v1.0.2") is False
    monkeypatch.setattr(R, "git", lambda *a, **k: R0(128, ""))
    assert R.remote_has_tag("v1.0.2") is None
    assert R.remote_has_tag("") is None      # 没版本号时别去问网络
