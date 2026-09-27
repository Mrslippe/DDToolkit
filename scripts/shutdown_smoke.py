"""关停冒烟：**真进程**验证「被礼貌叫停 ⇒ 调度运行时优雅停止」（批次 6 的补充，devlog/226）。

## 为什么要单独一个脚本
`scripts/dev_check.py` 的后端冒烟收尾走 `proc.terminate()` —— Windows 上那是
**TerminateProcess（硬杀）**，lifespan 根本不跑 ⇒ 批次 6 做的"调度运行时优雅停止"
**一条自动化判据都没有**（tests/test_scheduler_lifecycle.py 那条是拿替身直接驱动
`app.main.lifespan`，不起真进程）。

## 它怎么"礼貌叫停"
Windows 上没有可投递的软 SIGTERM（`os.kill(pid, SIGTERM)` 也是硬杀），父进程唯一的
礼貌通道是控制台 **CTRL_BREAK** ⇒ 子进程收到 `SIGBREAK`。`backend_main.py` 把 SIGBREAK
接到了 uvicorn 的优雅路径上（`server.should_exit = True`）。

## 判据（缺一不可）
1. **前提**：日志里有「调度运行时已启动」—— 没起来过的话"没停"这件事毫无意义（空转不是通过）；
2. 发 CTRL_BREAK 后进程 **≤15s 内退出**、退出码 0；
3. `logs/app.log` 出现「调度运行时已停止（N 个线程已退出…）」。

⚠️ **没有控制台时发不出 CTRL_BREAK** ⇒ 打印 SKIP 并按**失败**计（不是"通过"）：
这条冒烟的要点正是那份"优雅"，发不出信号就等于什么都没验。

用法：`python scripts/shutdown_smoke.py`（退出码 0 = 三条判据全过）
"""
from __future__ import annotations

import ctypes
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
CREATE_NEW_PROCESS_GROUP = 0x00000200
CTRL_BREAK_EVENT = 1
EXIT_BUDGET_S = 15.0
START_BUDGET_S = 90.0          # 首启要跑迁移 + 起调度，给足

# 开发态固定 token（S1 起后端要 `X-DDToolkit-Token`）：本进程自己起的后端也必须拿到它，
# 否则**业务端点逐条 401**，而症状看起来像网络/上游坏了 —— 这条规矩有专门的门禁用例
# （`tests/test_dev_token.py`，2026-09-27 本脚本第一版就是被它拦下的）。
sys.path.insert(0, str(ROOT / "scripts"))
from dev_token import backend_env  # noqa: E402


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _get(url: str, timeout: float = 3.0) -> int:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310 (本机)
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def main() -> int:
    port = _free_port()
    stamp = int(time.time() * 1000)
    data_dir = ROOT / "_shutdown_smoke_tmp" / f"run-{stamp}"
    data_dir.mkdir(parents=True, exist_ok=True)
    console_log = data_dir / "console.log"
    app_log = data_dir / "logs" / "app.log"

    env = {
        **os.environ,
        "DDTOOLKIT_DATA_DIR": str(data_dir),
        "DDTOOLKIT_PORT": str(port),
        "DDTOOLKIT_PARENT_PID": "0",   # 不启用父进程看门狗（看门狗是 os._exit，会绕过优雅停止）
        **backend_env(),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    print(f"[冒烟] 数据目录 {data_dir}")
    print(f"[冒烟] 端口 {port}")

    log = open(console_log, "wb")
    proc = subprocess.Popen(  # noqa: S603
        [PY, "backend_main.py"], cwd=ROOT, env=env,
        stdout=log, stderr=subprocess.STDOUT,
        creationflags=CREATE_NEW_PROCESS_GROUP,   # 让子进程自成进程组，好定向发 CTRL_BREAK
    )
    k32 = ctypes.windll.kernel32          # type: ignore[attr-defined]
    base = f"http://127.0.0.1:{port}"
    try:
        # ── 等就绪 ────────────────────────────────────────────────────────────
        t0 = time.time()
        while time.time() - t0 < START_BUDGET_S:
            if proc.poll() is not None:
                print(f"[失败] 后端提前退出（码 {proc.returncode}），见 {console_log}")
                return 1
            if _get(f"{base}/healthz") == 200:
                break
            time.sleep(0.5)
        else:
            print(f"[失败] {START_BUDGET_S:.0f}s 内没就绪，见 {console_log}")
            return 1
        print(f"[冒烟] /healthz 就绪（{time.time() - t0:.1f}s）")

        # ── 前提：调度运行时**确实起来过**（否则"没停"毫无意义）──────────────
        text = app_log.read_text(encoding="utf-8", errors="replace") if app_log.exists() else ""
        if "调度运行时已启动" not in text:
            print("[失败] 前提不成立：logs/app.log 里没有「调度运行时已启动」——")
            print("       没起来过就谈不上优雅停止（空转不是通过）。")
            return 1
        print("[冒烟] 前提成立：调度运行时已启动")

        # ── 礼貌叫停：CTRL_BREAK → 子进程收到 SIGBREAK ────────────────────────
        if not k32.GetConsoleWindow():
            print("[跳过→按失败计] 本进程没有控制台，发不出 CTRL_BREAK ——")
            print("       这条冒烟的要点就是那份「优雅」，发不出信号等于什么都没验。")
            return 1
        # 顺手让**我们自己**忽略 Ctrl+C：同控制台里别的进程也可能收到事件
        k32.SetConsoleCtrlHandler(None, True)
        try:
            if not k32.GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, proc.pid):
                err = ctypes.get_last_error() if hasattr(ctypes, "get_last_error") else "?"
                print(f"[失败] GenerateConsoleCtrlEvent 失败（err={err}）"
                      f"—— pid {proc.pid} 不是独立进程组？")
                return 1
            print(f"[冒烟] 已发 CTRL_BREAK 给进程组 {proc.pid}，等它自己收摊 …")
            t1 = time.time()
            try:
                code = proc.wait(timeout=EXIT_BUDGET_S)
            except subprocess.TimeoutExpired:
                print(f"[失败] {EXIT_BUDGET_S:.0f}s 内没退出（优雅停止卡住了）")
                return 1
            elapsed = time.time() - t1
        finally:
            k32.SetConsoleCtrlHandler(None, False)

        # ── 判据 2/3 ─────────────────────────────────────────────────────────
        text = app_log.read_text(encoding="utf-8", errors="replace")
        stopped = [ln for ln in text.splitlines() if "调度运行时已停止" in ln]
        ok = True
        if code != 0:
            print(f"[失败] 退出码 {code}（期望 0）")
            ok = False
        else:
            print(f"[冒烟] 进程已退出，码 0，用时 {elapsed:.2f}s（预算 {EXIT_BUDGET_S:.0f}s）")
        if not stopped:
            print("[失败] logs/app.log 里没有「调度运行时已停止」—— 优雅停止没跑到")
            ok = False
        else:
            print(f"[冒烟] 日志命中：{stopped[-1].strip()[:110]}")
        print(f"\n{'[ok] 关停冒烟通过' if ok else '[FAIL] 关停冒烟未通过'}"
              f"（数据目录留档：{data_dir}）")
        return 0 if ok else 1
    finally:
        if proc.poll() is None:                 # 失败路径别留孤儿
            proc.kill()
            proc.wait(timeout=10)
        log.close()


if __name__ == "__main__":
    sys.exit(main())
