"""整机性能体检：启动 / 内存 / CPU / 深休眠，量的是**整棵进程树**（壳 + WebView2 + 后端）。

## 为什么需要它（devlog/134）

用户问"这应用在较低性能的机器上跑得怎样、最低限度要求什么性能"。要回答这个，
**只有后端那一个数字是不够的**（`ARCHITECTURE.md` §3.12 量的是后端单进程 128.7MB）——
使用者在任务管理器里看到的是**一整片**：壳 + 五六个 WebView2 进程 + 后端 + conhost。
这个脚本就是把这棵树一次量全，并且**可复跑**（性能数字会随版本漂移，靠记忆复述没用）。

## 两把尺子的口径（别混）

- **内存** = Windows 性能计数器 `\\Process(*)\\Working Set - Private`（= 任务管理器「内存」列，
  也是用户截图里那个数）。它**不等于** `GetProcessMemoryInfo().PrivateUsage`（那是私有提交），
  两者差 5~15MB。所以这里**借 PowerShell 取计数器**，不自己用 ctypes 近似 —— 口径一致比省一次调用重要。
- **CPU** = 各进程 `TotalProcessorTime` 的增量 ÷ 墙钟（秒/分钟），比瞬时百分比稳。

## 用法

    python scripts/perf_report.py                    # 便携版 zip 自动解压到 %TEMP%，冷启 + 热启两轮
    python scripts/perf_report.py --exe <exe 路径>   # 量已安装/已解压的那个（不想解压 zip）
    python scripts/perf_report.py --quick            # 跳过空闲采样与深休眠（约 25 秒）
    python scripts/perf_report.py --idle 120         # 空闲采样时长（默认 60s）
    python scripts/perf_report.py --affinity-proxy   # 额外做"单核亲和"实验：近似弱 CPU 下的启动耗时
    python scripts/perf_report.py --json out.json    # 落一份机器可读结果（做版本间对比）
    python scripts/perf_report.py --keep             # 保留解压目录与数据目录（默认跑完就清）

⚠️ 它**不是门禁**：性能数字随机器与负载波动，这里没有阈值判定，只打印事实与读法。
   唯一会判失败的是"压根没起来"（起不来还打表 = 假数据，宁可红）。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from dev_token import backend_env, headers as dev_headers  # noqa: E402

RELEASE_DIR = ROOT / "dist-release"
PORTABLE_ZIP = RELEASE_DIR / "DDtoolkit-portable-win64.zip"
EXE_IN_ZIP = Path("DDtoolkit") / "ddtoolkit.exe"
BACKEND_IN_ZIP = Path("DDtoolkit") / "binaries" / "backend" / "ddtoolkit-backend.exe"
WORK = Path(os.environ.get("TEMP", ".")) / "ddtk-perf"
SLEEP_ENV = "DDTOOLKIT_TRAY_SLEEP_SECONDS"
READY_MARK = "就绪"


# ---------------------------------------------------------------- 纯函数（可单测）

def parse_stages(text: str) -> dict[str, int]:
    """从 sidecar.log 抓启动分阶段耗时：`[perf] 标签 +123ms` → {标签: 123}。"""
    out: dict[str, int] = {}
    for m in re.finditer(r"\[perf\]\s*(.+?)\s*\+(\d+)ms", text):
        out[m.group(1).strip()] = int(m.group(2))
    return out


def parse_port(text: str) -> int | None:
    """从 sidecar.log 的 boot 行抓后端端口（`port='51234'`）；取**最后一条**。

    ⚠️ 必须取最后一条：日志是**追加**的，多轮启动会留下多个 boot 行 ——
    取第一条会连到**上一轮已经死掉的**端口上（第一版就踩了：深休眠那步报
    `WinError 10061 目标计算机积极拒绝`，其实是拿第一轮的端口去问第二轮）。
    """
    hits = re.findall(r"port='(\d+)'", text)
    return int(hits[-1]) if hits else None


def has_ready(text: str) -> bool:
    """后端是否打了就绪标记（`_perf` 的那条）。"""
    return READY_MARK in text


def totals(rows: list[dict]) -> dict:
    """逐进程行 → 合计（进程数 / 线程 / 句柄 / 私有工作集 / 工作集 / CPU 秒）。"""
    return {
        "procs": len(rows),
        "threads": sum(int(r.get("threads") or 0) for r in rows),
        "handles": sum(int(r.get("handles") or 0) for r in rows),
        "priv_mb": round(sum(float(r.get("priv_mb") or 0) for r in rows), 1),
        "ws_mb": round(sum(float(r.get("ws_mb") or 0) for r in rows), 1),
        "cpu_s": round(sum(float(r.get("cpu_s") or 0) for r in rows), 2),
    }


# ---------------------------------------------------------------- PowerShell 采样

# 一个进程树快照：先按 ParentProcessId 找出整棵树，再逐进程取
# ① 性能计数器的私有工作集（任务管理器口径）② 工作集 ③ 线程/句柄 ④ CPU 累计时间。
#
# ⚠️ 全程 try/catch 并**总是输出 JSON**：PowerShell 的终止性错误会走 stderr，而
#    `-EncodedCommand` 这一路的退出码并不可靠 —— 实测出现过"rc=0 + stdout 空"，
#    那会被解析成"0 个进程 / 0 MB"（假数据）。所以这里把 ok/error 也当成一等字段返回，
#    让调用方**永远分得清**「真没进程」与「没量到」。
PS_SAMPLE = r"""
$ErrorActionPreference = 'Stop'
$rootPid = __ROOT_PID__
try {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $pids = New-Object System.Collections.Generic.List[int]
  $q = New-Object System.Collections.Generic.Queue[int]
  $q.Enqueue($rootPid); $pids.Add($rootPid)
  while ($q.Count -gt 0) {
    $cur = $q.Dequeue()
    foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $cur })) {
      $cid = [int]$c.ProcessId
      if (-not $pids.Contains($cid)) { $pids.Add($cid); $q.Enqueue($cid) }
    }
  }
  $perf = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
            Where-Object { $pids -contains [int]$_.IDProcess })
  $rows = @()
  foreach ($p in $perf) {
    $proc = Get-Process -Id ([int]$p.IDProcess) -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    $rows += [pscustomobject]@{
      name    = $p.Name
      pid     = [int]$p.IDProcess
      priv_mb = [math]::Round([double]$p.WorkingSetPrivate / 1MB, 1)
      ws_mb   = [math]::Round([double]$p.WorkingSet / 1MB, 1)
      threads = [int]$p.ThreadCount
      handles = [int]$p.HandleCount
      cpu_s   = [math]::Round($proc.TotalProcessorTime.TotalSeconds, 2)
    }
  }
  $out = [pscustomobject]@{ ok = $true; error = ''; tree = @($pids); rows = @($rows) }
} catch {
  $out = [pscustomobject]@{ ok = $false; error = "$($_.Exception.Message)";
                            tree = @(); rows = @() }
}
ConvertTo-Json -InputObject $out -Compress -Depth 6
"""


def _ps(script: str, timeout: float = 120.0) -> str:
    """跑一段 PowerShell（`-EncodedCommand` 免引号地狱），返回 stdout。失败即抛。"""
    enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    p = subprocess.run(["powershell", "-NoProfile", "-NonInteractive",
                        "-EncodedCommand", enc],
                       capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"PowerShell 失败 rc={p.returncode}: {p.stderr.strip()[:400]}")
    return p.stdout


def snapshot(root_pid: int, tries: int = 3) -> tuple[list[dict], dict]:
    """量一次整棵进程树。返回 (逐进程行, 合计)；行可为空但**合计一定自洽**。

    「树里有进程、但计数器一行都没读到」⇒ 重试；仍读不到就抛 ——
    这种情况**绝不允许**退化成一排 0（那正是第一版在深休眠那步犯的错：
    探针报「9 → 0 进程、省 232MB」，其实应用活得好好的，是尺子自己读空了）。
    """
    last_err = "没读到任何进程"
    for i in range(max(1, tries)):
        raw = _ps(PS_SAMPLE.replace("__ROOT_PID__", str(root_pid))).strip()
        if not raw:
            last_err = "PowerShell 没吐 JSON（stdout 为空）"
            time.sleep(0.8)
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"PowerShell 输出不是 JSON（{e}）：{raw[:200]}") from e
        if isinstance(obj, list):                 # 兼容旧形状
            obj = {"ok": True, "tree": [], "rows": obj}
        if not obj.get("ok"):
            last_err = str(obj.get("error") or "未知错误")
            time.sleep(0.8)
            continue
        rows = obj.get("rows") or []
        if isinstance(rows, dict):
            rows = [rows]
        tree = obj.get("tree") or []
        if not rows and tree:
            last_err = f"树里有 {len(tree)} 个进程，但性能计数器一行都没读到"
            time.sleep(0.8)
            continue
        for r in rows:
            r["name"] = str(r.get("name") or "?")
        return rows, totals(rows)
    raise RuntimeError(f"采样失败（{tries} 次）：{last_err}")


# ---------------------------------------------------------------- 环境准备

def unzip_portable() -> Path:
    """把便携版 zip 解到 %TEMP%/ddtk-perf（已解压则复用）。"""
    exe = WORK / EXE_IN_ZIP
    if exe.is_file():
        return exe
    if not PORTABLE_ZIP.is_file():
        raise SystemExit(f"找不到 {PORTABLE_ZIP}（先发一轮版，或用 --exe 指定 exe）")
    WORK.mkdir(parents=True, exist_ok=True)
    print(f"[unzip] {PORTABLE_ZIP.name} → {WORK}")
    with zipfile.ZipFile(PORTABLE_ZIP) as z:
        z.extractall(WORK)
    return exe


def fresh_data_dir(path: Path) -> Path:
    import shutil
    shutil.rmtree(path, ignore_errors=True)
    path.mkdir(parents=True, exist_ok=True)
    return path


# ---------------------------------------------------------------- 流程

def launch(exe: Path, data: Path, sleep_s: int) -> subprocess.Popen:
    env = {**os.environ, "DDTOOLKIT_DATA_DIR": str(data), SLEEP_ENV: str(sleep_s)}
    env.pop("DDTOOLKIT_PORT", None)          # 让壳自己挑端口
    env.pop("DDTOOLKIT_PARENT_PID", None)
    # 子进程的 stdout 别倒进报告里（侧车那两行会插进表格中间）；
    # 出问题要看原因就翻 <数据目录>/logs/sidecar.log 与 app.log —— 那才是真源。
    return subprocess.Popen([str(exe)], env=env, cwd=str(exe.parent),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wait_ready(data: Path, proc: subprocess.Popen, since: int, timeout: float) -> tuple[bool, int]:
    """等后端就绪。`since` = 启动前的日志字节数（只看新增部分，避免读到上一轮的就绪行）。"""
    log = data / "logs" / "sidecar.log"
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(0.05)
        if log.is_file():
            text = log.read_text(encoding="utf-8", errors="replace")
            if has_ready(text[since:]):
                return True, int((time.time() - t0) * 1000)
        if proc.poll() is not None:
            return False, int((time.time() - t0) * 1000)
    return False, int((time.time() - t0) * 1000)


def log_text(data: Path) -> str:
    log = data / "logs" / "sidecar.log"
    return log.read_text(encoding="utf-8", errors="replace") if log.is_file() else ""


def stop_tree(pid: int) -> None:
    """按进程树结束（WebView2 的子进程要一起走，否则留一堆孤儿）。"""
    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                   capture_output=True, text=True, errors="replace")


def hide_to_tray(shell_pid: int, port: int) -> tuple[bool, str]:
    """把关闭语义设成"最小化到托盘"，再发 WM_CLOSE（= 点 ✕）。返回 `(成功?, 说明)`。

    ⚠️ **S1 起这一步在"壳模式"下量不了**（2026-09-26 发现）：会话 token 由**壳自己**
    每次启动生成、只存内存，而 `PUT /settings/prefs` 是业务端点 ⇒ 本脚本（壳外的进程）
    **拿不到那个 token**，只能收到 401。于是"深休眠"那一段的结论作废 —— 所以这里
    **返回 False 让调用方整段跳过**，而不是留一个看起来量到了的假数字
    （不写 prefs 就发 WM_CLOSE 的话，默认 `close_action="ask"` 会弹确认框，
    量到的是"窗口还开着"的树）。
    要恢复得先定口径（让壳支持外部注入 token / 或本脚本改用直接写库），见 `docs/TODO.md`。
    """
    body = json.dumps({"values": {"close_action": "tray"}}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/settings/prefs", data=body,
                                 method="PUT", headers={"Content-Type": "application/json",
                                                        **dev_headers()})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            if r.status >= 400:
                return False, f"prefs 写入失败 HTTP {r.status}"
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return False, ("prefs 写入被 401 拒绝 —— S1 起壳自生成的 token 外部拿不到，"
                           "深休眠段**没量到**（不是 0，也不是省了多少）")
        return False, f"prefs 写入失败 HTTP {e.code}"
    _ps(f"(Get-Process -Id {shell_pid}).CloseMainWindow() | Out-Null")
    return True, "已发 WM_CLOSE（隐藏到托盘）"


def affinity_proxy(backend: Path, data: Path, rounds: int = 1) -> list[dict]:
    """单核亲和实验：后端启动路径本来是串行的，限制到 1 个逻辑核 ≈ 弱 CPU 下的启动耗时。

    ⚠️ 它是**代理指标**，不是"低配机实测"：只削并行度，不削单核主频/IPC。
    ⚠️ 每种模式**先热身一轮再量**：空库首启要跑 17 步 Alembic 迁移，
       那一步在单核上能吃掉好几秒（第一版实测 742ms → 4951ms），会把"import 路径"的信号淹掉。
       热身（同目录再起一次，迁移已是 no-op）+ 取"再启动"的耗时，量的才是日常启动。
    """
    import ctypes
    from ctypes import wintypes
    PROCESS_SET_INFORMATION = 0x0200
    PROCESS_QUERY_INFORMATION = 0x0400
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.SetProcessAffinityMask.argtypes = [wintypes.HANDLE, ctypes.c_size_t]
    k32.SetProcessAffinityMask.restype = wintypes.BOOL
    k32.CloseHandle.argtypes = [wintypes.HANDLE]

    def one(mask: int, port: int, quiet: bool) -> tuple[bool, int, dict]:
        d = data.parent / f"{data.name}-aff"
        if not quiet:
            fresh_data_dir(d)
        env = {**os.environ, "DDTOOLKIT_DATA_DIR": str(d), "DDTOOLKIT_PORT": str(port),
               **backend_env()}
        env.pop("DDTOOLKIT_PARENT_PID", None)
        base = len(log_text(d))
        t0 = time.time()
        p = subprocess.Popen([str(backend)], env=env, cwd=str(backend.parent),
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if mask:
            h = k32.OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION,
                                False, p.pid)
            if not h or not k32.SetProcessAffinityMask(h, mask):
                print(f"  [!] 亲和性设置失败（err={ctypes.get_last_error()}）——本轮按全核计")
            if h:
                k32.CloseHandle(h)
        ok, ms = wait_ready(d, p, base, timeout=180)
        stages = parse_stages(log_text(d)[base:])
        stop_tree(p.pid)
        time.sleep(1.5)
        return ok, ms, stages

    out: list[dict] = []
    for i, (mask, label) in enumerate(((0, "全核"), (1, "单核亲和"))):
        port = 45990 + i * 10
        one(mask, port, quiet=False)                      # 热身：把首启迁移那一步消化掉
        ok, ms, stages = one(mask, port + 1, quiet=True)  # 量：同目录再启动
        out.append({"mode": label, "ms": ms, "ok": ok, "stages": stages})
        print(f"  [{label}] 再启动就绪 {ms}ms（ok={ok}）"
              f"  import app.main={stages.get('import app.main 完成')}ms")
    return out


# ---------------------------------------------------------------- 主流程

def main() -> int:
    ap = argparse.ArgumentParser(
        description="整机性能体检：启动 / 内存 / CPU / 深休眠（量的是整棵进程树）",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--exe", type=Path, help="要测量的 ddtoolkit.exe（默认从便携版 zip 解压）")
    ap.add_argument("--backend", type=Path, help="后端 exe（默认按 --exe 同目录推导，供 --affinity-proxy）")
    ap.add_argument("--idle", type=int, default=60, help="空闲 CPU 采样时长秒（默认 60）")
    ap.add_argument("--sleep", type=int, default=30, help="深休眠触发秒数（默认 30，写 DDTOOLKIT_TRAY_SLEEP_SECONDS）")
    ap.add_argument("--rounds", type=int, default=2, help="启动轮数（第 1 轮=首启，第 2 轮起=热启动）")
    ap.add_argument("--quick", action="store_true", help="跳过空闲采样与深休眠")
    ap.add_argument("--affinity-proxy", action="store_true", help="额外做单核亲和实验（弱 CPU 代理）")
    ap.add_argument("--json", type=Path, help="把结果写一份 JSON（做版本间对比）")
    ap.add_argument("--keep", action="store_true", help="保留解压目录与数据目录")
    args = ap.parse_args()

    exe = args.exe or unzip_portable()
    if not exe.is_file():
        raise SystemExit(f"exe 不存在：{exe}")
    backend = args.backend or (exe.parent / "binaries" / "backend" / "ddtoolkit-backend.exe")
    data = WORK / "data"
    report: dict = {"exe": str(exe), "starts": [], "snapshots": []}

    print(f"[perf] exe = {exe}")
    shell: subprocess.Popen | None = None
    shell_pid = 0
    try:
        for i in range(1, max(1, args.rounds) + 1):
            first = (i == 1)
            if first:
                fresh_data_dir(data)
            base = len(log_text(data))
            t0 = time.time()
            shell = launch(exe, data, args.sleep)
            shell_pid = shell.pid
            ok, ms = wait_ready(data, shell, base, timeout=180)
            wall = int((time.time() - t0) * 1000)
            stages = parse_stages(log_text(data)[base:])
            label = "首启（空数据目录）" if first else "热启动（复用数据目录）"
            report["starts"].append({"round": i, "kind": label, "wall_ms": wall,
                                     "backend_ready_ms": ms, "ok": ok, "stages": stages})
            print(f"[start {i}] {label}：点图标 → 后端就绪 {wall}ms（后端自报 {ms}ms，ok={ok}）")
            for k, v in stages.items():
                print(f"    · {k} +{v}ms")
            if not ok:
                print("[FAIL] 后端没起来 —— 不打印内存表（起不来还打表 = 假数据）")
                print(f"       现场：{data / 'logs' / 'sidecar.log'} 与 "
                      f"{data / 'logs' / 'app.log'}")
                return 1
            if i < args.rounds:
                stop_tree(shell_pid)
                time.sleep(2)

        def try_snapshot(label: str):
            """量一次；量不到就**说清量不到**（绝不退化成一排 0）。"""
            try:
                return snapshot(shell_pid)
            except RuntimeError as e:
                print(f"  [!] {label} 采样失败：{e}")
                return None, None

        rows, tot = try_snapshot("首次")
        if tot is None:
            print("[FAIL] 内存表没量到 —— 不打印 0（那会看起来像「很省内存」）")
            return 1
        report["snapshots"].append({"label": "空闲（界面在）", "total": tot, "rows": rows})
        print(f"\n=== 整机占用（{tot['procs']} 进程 / {tot['threads']} 线程 / "
              f"{tot['handles']} 句柄）===")
        for r in sorted(rows, key=lambda x: -x["priv_mb"]):
            print(f"    {r['name']:<26} pid={r['pid']:<7} 私有 {r['priv_mb']:>7} MB   "
                  f"工作集 {r['ws_mb']:>7} MB")
        print(f"  合计：私有工作集 {tot['priv_mb']} MB / 工作集 {tot['ws_mb']} MB / "
              f"CPU 累计 {tot['cpu_s']}s")

        if not args.quick:
            print(f"\n[idle] 静置 {args.idle}s 量空闲 CPU ……")
            time.sleep(args.idle)
            rows2, tot2 = try_snapshot("空闲")
            exited = shell.poll() is not None
            if tot2 is not None and (tot2["procs"] == 0 or exited):
                # 「量到 0」必须说清是"不耗资源"还是"进程没了"
                print(f"  [!] 进程树里已经没东西了（壳退出={exited}"
                      f"{'，退出码 ' + str(shell.returncode) if exited else ''}）"
                      f" —— 这一段没量到。日志尾：")
                for line in log_text(data).splitlines()[-4:]:
                    print(f"      {line}")
            if tot2 is None:
                print(f"  [!] 空闲这 {args.idle}s 的 CPU/内存没量到（不当成 0）")
            else:
                dcpu = round(tot2["cpu_s"] - tot["cpu_s"], 2)
                cores = os.cpu_count() or 1
                print(f"[idle] 这 {args.idle}s 用了 CPU {dcpu}s"
                      f"（≈ {round(dcpu / args.idle * 100, 2)}% 单核；{cores} 核机器上"
                      f" {round(dcpu / args.idle / cores * 100, 2)}% 整机）")
                report["snapshots"].append({"label": f"空闲 {args.idle}s 后",
                                            "total": tot2, "rows": rows2})
                report["idle"] = {"seconds": args.idle, "cpu_s": dcpu,
                                  "pct_one_core": round(dcpu / args.idle * 100, 2)}

            port = parse_port(log_text(data))
            print(f"  [port] 后端端口 = {port}（取日志**最后一条** boot 行；"
                  f"多轮启动的日志是追加的）")
            if port and not exited:
                print(f"\n[sleep] 隐藏到托盘，等深休眠（{args.sleep}s 后销毁 WebView）……")
                hidden, msg = hide_to_tray(shell_pid, port)
                print(f"  {msg}")
                if not hidden:
                    # ⚠️ 没切成托盘语义就别往下量：默认 `close_action="ask"` 会弹确认框，
                    #    量到的树是"窗口还开着"的，却被当成"深休眠后"打印出来（假数字）。
                    print("  [!] 深休眠这一段**整段跳过**（不是 0，也不是省了多少）")
                else:
                    time.sleep(args.sleep + 20)
                    rows3, tot3 = try_snapshot("深休眠")
                    if tot3 is not None:
                        report["snapshots"].append({"label": "深休眠后（WebView 已销毁）",
                                                    "total": tot3, "rows": rows3})
                        base = tot2 if tot2 is not None else tot
                        print(f"  进程 {base['procs']} → {tot3['procs']}，私有工作集 "
                              f"{base['priv_mb']} → {tot3['priv_mb']} MB"
                              f"（省 {round(base['priv_mb'] - tot3['priv_mb'], 1)} MB）")
            else:
                print("  [!] 读不到端口或壳已退出，跳过深休眠")
    finally:
        if shell_pid:
            stop_tree(shell_pid)
        if args.affinity_proxy and backend.is_file():
            print("\n[affinity] 单核亲和实验（弱 CPU 的**代理**指标，不是真低配机实测）")
            aff = affinity_proxy(backend, data)
            report["affinity_proxy"] = aff
            full = [a for a in aff if a["mode"] == "全核"]
            one = [a for a in aff if a["mode"] == "单核亲和"]
            if full and one:
                f, o = full[0]["ms"], one[0]["ms"]
                print(f"  → 后端就绪 {f}ms（全核）→ {o}ms（单核）：×{round(o / f, 2)}")
        if not args.keep:
            import shutil
            shutil.rmtree(WORK, ignore_errors=True)
            print(f"\n[clean] 已删除 {WORK}（--keep 可保留）")

    if args.json:
        args.json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[json] 结果写入 {args.json}")
    print("\n[读法] 内存=任务管理器「内存」列口径；启动=点图标→后端就绪的墙钟；"
          "\n       本机数字只作**基线**，跨机器请比同一台机的前后版本。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
