"""桌面端后端入口（Tauri sidecar）。

由 Tauri 启动器以子进程方式拉起，注入环境变量：
- DDTOOLKIT_PORT      监听端口（启动器已抢占的空闲端口；缺省自动选择）
- DDTOOLKIT_DATA_DIR  数据目录（数据库/日志/凭据/缓存所在，见 app/core/config.py）

首次运行时把随包分发的 vtubers.csv 引导复制到数据目录。
"""
import asyncio
import os
import shutil
import socket
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

# 启动计时基线（冷启动优化，见 devlog/021）：各阶段以毫秒记入 sidecar.log
_t0 = time.perf_counter()


def _slog(msg: str) -> None:
    """观测日志：桌面端启动链路各阶段事实落盘 <DATA_DIR>/logs/sidecar.log。

    安装版为无控制台程序，stdout 不可见；任何环境出问题先看这个文件。
    """
    try:
        data_dir = Path(
            os.environ.get("DDTOOLKIT_DATA_DIR")
            or Path(__file__).resolve().parent
        )
        log_dir = data_dir / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(log_dir / "sidecar.log", "a", encoding="utf-8") as f:
            f.write(f"[{stamp}] {msg}\n")
    except OSError:
        pass  # 日志失败绝不影响主流程


def _perf(msg: str) -> None:
    _slog(f"[perf] {msg} +{int((time.perf_counter() - _t0) * 1000)}ms")


def _data_dir() -> Path:
    return Path(
        os.environ.get("DDTOOLKIT_DATA_DIR")
        or Path(__file__).resolve().parent
    )


def _bootstrap_resources(data_dir: Path) -> None:
    """把打包内置的初始资源（名单 csv）落到数据目录，仅首次。"""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    src = base / "vtubers.csv"
    dst = data_dir / "vtubers.csv"
    try:
        if src.exists() and not dst.exists():
            data_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            print(f"[sidecar] 已引导资源: {dst}", flush=True)
    except OSError as e:
        print(f"[sidecar] 资源引导失败(忽略): {e}", flush=True)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _watch_parent(parent_pid: int) -> None:
    """父进程（Tauri 壳）退出后立即自尽。

    兜底孤儿进程：PyInstaller onefile 的真实工作进程与引导器的关系
    不可靠（启动器侧 taskkill /T 可能杀不到），改为后端自己监视
    父进程句柄，无论壳以何种方式退出都能保证清理。
    """
    if os.name != "nt":
        return
    import ctypes

    k32 = ctypes.windll.kernel32
    SYNCHRONIZE = 0x00100000
    INFINITE = 0xFFFFFFFF
    handle = k32.OpenProcess(SYNCHRONIZE, False, parent_pid)
    if not handle:
        _slog(f"watchdog FAILED OpenProcess(parent={parent_pid}) err={ctypes.GetLastError()}")
        print(f"[sidecar] 无法打开父进程 {parent_pid}，看门狗未启用", flush=True)
        return
    _slog(f"watchdog armed (parent={parent_pid}, handle={handle})")
    k32.WaitForSingleObject(handle, INFINITE)
    _slog("watchdog fired -> os._exit(0)")
    print("[sidecar] 检测到父进程退出，看门狗触发自尽", flush=True)
    os._exit(0)


def main() -> None:
    _perf("进程启动")
    data_dir = _data_dir()
    os.environ.setdefault("DDTOOLKIT_DATA_DIR", str(data_dir))
    _bootstrap_resources(data_dir)

    port_env = os.environ.get("DDTOOLKIT_PORT", "")
    parent_env = os.environ.get("DDTOOLKIT_PARENT_PID", "")
    _slog(
        f"boot: data_dir={data_dir} port={port_env!r} "
        f"parent_pid={parent_env!r} frozen={getattr(sys, 'frozen', False)}"
    )

    # 父进程存活看门狗（Tauri 注入 DDTOOLKIT_PARENT_PID）
    if parent_env.isdigit():
        threading.Thread(
            target=_watch_parent, args=(int(parent_env),), daemon=True
        ).start()
    else:
        _slog("watchdog NOT armed: DDTOOLKIT_PARENT_PID missing/invalid")

    import uvicorn
    _perf("import uvicorn 完成")

    from app.main import app  # noqa: E402  延迟导入，确保环境变量先就位
    _perf("import app.main 完成")

    port = int(port_env or _free_port())
    _perf(f"准备监听 127.0.0.1:{port}")
    # 用 Server API 而不是 uvicorn.run：只有在 bind + 启动完成后才打就绪标记，
    # 避免「进程活着但端口没监听」的假就绪（首启卡幕排查需要真实信号）。
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)

    async def _serve() -> None:
        task = asyncio.create_task(server.serve())
        while not server.started and not task.done():
            await asyncio.sleep(0.05)
        if server.started:
            print(f"DDTOOLKIT_READY http://127.0.0.1:{port}", flush=True)
            _perf("uvicorn 已监听（就绪）")
        await task

    try:
        asyncio.run(_serve())
    except BaseException as e:  # noqa: BLE001
        # 安装版是无控制台程序：uvicorn 自身的报错（最常见=端口被占 bind 失败）
        # 只进 stderr 等于消失。落 sidecar.log，否则首启卡幕将无从诊断。
        import traceback
        _slog(f"FATAL uvicorn 退出: {type(e).__name__}: {e}")
        _slog("traceback:\n" + traceback.format_exc())
        raise


if __name__ == "__main__":
    main()
