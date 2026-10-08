"""量「分词词典空闲释放」到底还回去多少内存（`devlog/447`）。

用法（**必须在仓库根跑，解释器走 `.venv`**）：

```powershell
$env:PYTHONPATH = "E:\\work\\Project\\DDToolkit"      # 脚本在 scripts/ 下，要能 import app
.venv\\Scripts\\python.exe scripts\\measure_tokenizer_memory.py
```

口径与 `app/main.py` 里那句"加载它 +56.4MB"、`docs/ops/PERF.md` §1 的分段归因**同一把尺子**：
**当前进程的工作集**（Windows `GetProcessMemoryInfo().WorkingSetSize`），分段读。

⚠️ **`ctypes` 调 `GetProcessMemoryInfo` 必须声明 `argtypes`**：`GetCurrentProcess()` 返回的伪句柄是
-1，不声明会按 32 位传 ⇒ **工作集恒读到 0.0MB**（看起来像"一点内存都没占"）。这条坑早就写在
`docs/ops/PERF.md` §1 的复测方法里，2026-10-08 我写这个脚本时又踩了一次 —— 所以这里把它钉进代码。
"""
import ctypes
import ctypes.wintypes as wt
import gc
import sys

if sys.platform != "win32":          # pragma: no cover - 本仓的产物只有 Windows
    raise SystemExit("这条尺子用的是 Windows 的 GetProcessMemoryInfo；本仓发布产物只有 Windows。")


class _PMC(ctypes.Structure):
    _fields_ = [
        ("cb", wt.DWORD), ("PageFaultCount", wt.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
    ]


_psapi = ctypes.WinDLL("psapi", use_last_error=True)
_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.GetCurrentProcess.restype = wt.HANDLE
_psapi.GetProcessMemoryInfo.argtypes = [wt.HANDLE, ctypes.POINTER(_PMC), wt.DWORD]
_psapi.GetProcessMemoryInfo.restype = wt.BOOL


def ws_mb() -> float:
    """当前进程的工作集（MB）。⚠️ argtypes 缺一不可，见文件头。"""
    c = _PMC()
    c.cb = ctypes.sizeof(c)
    if not _psapi.GetProcessMemoryInfo(_k32.GetCurrentProcess(), ctypes.byref(c), ctypes.sizeof(c)):
        raise OSError(f"GetProcessMemoryInfo 失败: {ctypes.get_last_error()}")
    return c.WorkingSetSize / 1048576


def _line(tag: str) -> None:
    print(f"{tag:<26} 工作集 {ws_mb():7.1f} MB")


def main() -> int:
    from app.services.danmaku_words import JiebaTokenizer

    tk = JiebaTokenizer()
    tk.cancel_timer()                       # 本脚本手工驱动，不要定时器插一脚
    _line("① 未加载（延迟导入）")

    tk.cut("预热一下")
    _line("② 词典加载后")
    freq = len(tk._impl.dt.FREQ)
    print(f"{'   FREQ 条目数':<26} {freq:,}")

    assert tk.release() is True, "加载之后 release() 必须真的释放"
    _line("③ release() 之后")
    gc.collect()
    _line("④ release() + gc.collect()")

    tk.cut("再用一次")
    _line("⑤ 重建之后（下次用词云）")
    assert tk.loaded and len(tk._impl.dt.FREQ) == freq, "重建必须与首次规模一致"
    print(f"重建后的 FREQ 条目数一致 ✓（{freq:,}）")
    tk.cancel_timer()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
