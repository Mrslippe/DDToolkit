# -*- coding: utf-8 -*-
"""`scripts/fetch_danmakus_spec.py` 的判据（2026-10-14）。

只测**能离线判的三件事**：

1. **坏 JSON 的修复**（`repair`）—— 上游 swagger 的 `"kindValue": ,` 是真事故，
   不修就 `json.loads` 直接抛；纯函数必须有判据，否则"哪天正则被改坏"没人知道。
2. **摘要口径**（`summarize`）—— paths / operations / schemas / repairs 四个数
   是 `docs/backend/DANMAKUS-API.md` §8 那张表的来源，算错了文档就跟着错。
3. **坏响应不许把巡检脚本炸掉** —— WAF 页 / 空体是常态，函数要**返回结论**。

**不测网络**：抓取那一段要真上游（且 120 请求/分钟限流），属于人工巡检
（`python scripts/fetch_danmakus_spec.py --check`），不进 pytest。
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load():
    """按路径加载脚本（`scripts/` 不是包）。"""
    spec = importlib.util.spec_from_file_location(
        "fetch_danmakus_spec", ROOT / "scripts" / "fetch_danmakus_spec.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


fx = _load()


# ── 1. 坏 JSON 的修复 ────────────────────────────────────────────────────────

def test_repair_fixes_empty_enum_values():
    """上游真实形态：`: ,` 要变成 `: null,`，并数出来几处。"""
    bad = '{"x": {"kindValue": , "args": [ ]}, "y": {"kindValue": , "args": [ ]}}'
    fixed, n = fx.repair(bad)
    assert n == 2
    assert json.loads(fixed) == {"x": {"kindValue": None, "args": []},
                                 "y": {"kindValue": None, "args": []}}


def test_repair_leaves_good_json_untouched():
    """已经合法的 JSON 不许被改内容、也不该被数成"修了一处"。"""
    good = json.dumps({"a": {"b": None}, "c": [1, 2, 3]}, ensure_ascii=False)
    fixed, n = fx.repair(good)
    assert n == 0
    assert json.loads(fixed) == json.loads(good)


def test_repair_on_a_string_containing_the_pattern_still_yields_parseable_json():
    """⚠️ 正则的边界：`: ,` 出现在**字符串值里**时会被误伤。

    这条**故意钉住现状**而不是宣称它是对的 —— 上游 spec 里没有这种串，
    真出现了要改成按 token 修。写下来是为了真踩到时能立刻认出是哪一步。
    """
    text = '{"note": "写法是 : , 这样", "v": 1}'
    fixed, n = fx.repair(text)
    assert n == 1
    assert json.loads(fixed)["v"] == 1          # 仍是合法 JSON：下游不会崩


# ── 2. 摘要口径 ──────────────────────────────────────────────────────────────

def test_summarize_counts_paths_operations_and_schemas():
    payload = {
        "info": {"title": "Danmakus API", "version": "v2"},
        "paths": {
            "/a": {"get": {}, "post": {}},
            "/b": {"get": {}, "parameters": ["不是方法，不该计数"]},
        },
        "components": {"schemas": {"S1": {}, "S2": {}}},
    }
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    info = fx.summarize("v2", raw, raw.decode("utf-8"))
    assert info["parse"] == "ok"
    assert (info["paths"], info["operations"], info["schemas"]) == (2, 3, 2)
    assert info["version"] == "v2"
    assert info["repairs"] == 0


# ── 3. 坏响应 ────────────────────────────────────────────────────────────────

def test_summarize_reports_parse_failure_instead_of_raising():
    """抓到一个非 JSON 的响应（WAF 页）时**返回结论**，别把巡检脚本炸掉。"""
    raw = b"<html>blocked</html>"
    info = fx.summarize("v2", raw, raw.decode("utf-8"))
    assert info["parse"].startswith("FAIL")
    assert "paths" not in info


def test_summarize_survives_the_empty_object_body():
    """`/swagger/combined/` 实测就是 **12 字节的 `{}`** —— 解析成功，但一个路径都没有。"""
    raw = b"{}"
    info = fx.summarize("combined", raw, "{}")
    assert info["parse"] == "ok"
    assert (info["paths"], info["operations"], info["schemas"]) == (0, 0, 0)
