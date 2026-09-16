"""`scripts/perf_report.py` 的纯函数护栏（devlog/134）。

为什么只测这几个：脚本的价值全在**口径**上，而口径最容易坏在解析里——
比如端口取第一条还是最后一条（多轮启动的日志是追加的，取错就量到上一轮死进程）、
阶段耗时怎么从 `[perf] 标签 +Nms` 里抠。这些坏了不会报错，只会出**看着像数的错数**。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import perf_report as P  # noqa: E402

# 一段真的 sidecar.log（两轮启动，第二轮端口不同 —— 这正是踩过的那个坑）
SIDECAR = """[2026-09-17 00:19:13] [perf] 进程启动 +0ms
[2026-09-17 00:19:13] boot: data_dir=C:\\tmp\\a port='63624' parent_pid='33336' frozen=True
[2026-09-17 00:19:13] [perf] import uvicorn 完成 +109ms
[2026-09-17 00:19:14] [perf] import app.main 完成 +1324ms
[2026-09-17 00:19:16] [perf] uvicorn 已监听（就绪） +2200ms
[2026-09-17 00:21:59] [perf] 进程启动 +0ms
[2026-09-17 00:21:59] boot: data_dir=C:\\tmp\\a port='60255' parent_pid='35736' frozen=True
[2026-09-17 00:21:59] [perf] import uvicorn 完成 +68ms
[2026-09-17 00:22:00] [perf] import app.main 完成 +957ms
[2026-09-17 00:22:00] [perf] uvicorn 已监听（就绪） +1473ms
"""


def test_parse_stages_picks_labels_and_ms():
    st = P.parse_stages(SIDECAR)
    assert st["import uvicorn 完成"] == 68, "同名阶段应当以后一轮（较新）的为准"
    assert st["import app.main 完成"] == 957
    assert st["uvicorn 已监听（就绪）"] == 1473
    assert "进程启动" in st and st["进程启动"] == 0
    assert P.parse_stages("没有任何 perf 行") == {}


def test_parse_port_takes_the_last_boot_line():
    """第一版取的是**第一条** ⇒ 深休眠那步连到上一轮已死的端口（WinError 10061）。"""
    assert P.parse_port(SIDECAR) == 60255
    assert P.parse_port("port=''") is None
    assert P.parse_port("[perf] 没有 boot 行") is None


def test_has_ready_only_matches_the_ready_mark():
    assert P.has_ready(SIDECAR) is True
    assert P.has_ready("[perf] 进程启动 +0ms") is False


def test_totals_sums_the_tree():
    rows = [
        {"threads": 12, "handles": 219, "priv_mb": 96.7, "ws_mb": 119.2, "cpu_s": 1.5},
        {"threads": 30, "handles": 500, "priv_mb": 60.1, "ws_mb": 103.2, "cpu_s": 2.25},
    ]
    t = P.totals(rows)
    assert t["procs"] == 2
    assert t["threads"] == 42
    assert t["handles"] == 719
    assert t["priv_mb"] == 156.8
    assert t["ws_mb"] == 222.4
    assert t["cpu_s"] == 3.75


def test_totals_tolerates_missing_and_none_fields():
    """采到一半进程退出 ⇒ 字段可能是 None/缺键；不许抛，也不许算成 NaN。"""
    t = P.totals([{"priv_mb": None}, {}, {"priv_mb": 10.0, "threads": None}])
    assert t["procs"] == 3
    assert t["priv_mb"] == 10.0
    assert t["threads"] == 0
    assert t["cpu_s"] == 0
