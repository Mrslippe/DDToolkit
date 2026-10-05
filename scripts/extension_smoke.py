# -*- coding: utf-8 -*-
"""扩展链路的**端到端冒烟**（E4）：把扩展会发的那些请求用 Python 复刻一遍。

跑法：`python scripts/extension_smoke.py`（`scripts/gate.py` 也会跑它）。

## 为什么用 Python 复刻（而不是驱动真扩展）

MV3 的 popup 没法在无头 CI 里自动化驱动（要真浏览器 + 真 cookie + 稳定扩展 id），
所以"扩展那一侧"的自动化判据落在两处：纯逻辑进 `node --test`（`extension/test/`），
**接线**在这里 —— 复刻的是扩展**真实的请求序列**：

```
① GET  /healthz×候选端口   → 认领：body.app == "ddtoolkit"（扩展靠它认出应用）
② GET  /auth/pairing       → 拿配对 token（要应用 token；扩展那边是用户手抄的）
③ POST /auth/import ×4     → 四平台各推一条（头 X-DDToolkit-Pair）
```

## 三条口径

1. **用临时数据目录**（不是真机目录）：这一跑会写 `.env`，绝不能碰用户那份；
2. 后端起在**随机端口**（不去抢 8765–8769）：那五个端口可能坐着**用户正在用的应用**，
   抢它们等于干扰用户；候选端口的探测顺序由 `extension/test/logic.test.mjs` 判（纯函数）。
3. 只走**离线校验**的平台做成功路径（小红书/抖音），B 站/微博只判"缺键 ⇒ 400"
   （它们要打上游探活，冒烟里没有真 cookie，也不该打真上游）。
"""
from __future__ import annotations

import atexit
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from dev_token import DEV_TOKEN, HEADER as DEV_TOKEN_HEADER  # noqa: E402

#: 应用 token（开发态固定值）+ 扩展用的配对头（与 `services/cookie_import.PAIR_HEADER` 同名）
APP_HEADERS = {DEV_TOKEN_HEADER: DEV_TOKEN}
PAIR_HEADER = "X-DDToolkit-Pair"

#: `/healthz` 里认领用的标识（与 `app/main.py::APP_IDENTIFIER` 同名）
APP_IDENTIFIER = "ddtoolkit"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _get(port: int, path: str, headers: dict | None = None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(body or "null")
        except ValueError:
            return e.code, {"raw": body}


def _post(port: int, path: str, payload: dict, headers: dict):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(body or "null")
        except ValueError:
            return e.code, {"raw": body}


def main() -> int:
    bad: list[str] = []
    data = Path(tempfile.mkdtemp(prefix="ddtoolkit-ext-smoke-"))
    atexit.register(shutil.rmtree, data, ignore_errors=True)
    port = _free_port()
    env = {
        **os.environ,
        "DDTOOLKIT_DATA_DIR": str(data),
        "DDTOOLKIT_PORT": str(port),
        "DDTOOLKIT_PARENT_PID": "0",
        "DDTOOLKIT_DEV_API_TOKEN": DEV_TOKEN,
        "DDTOOLKIT_API_TOKEN": "",
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    log = open(data / "backend.log", "wb")
    be = subprocess.Popen([sys.executable, "backend_main.py"], cwd=ROOT, env=env,
                          stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(240):
            try:
                _get(port, "/healthz")
                break
            except Exception:
                time.sleep(0.5)
        else:
            print("[FAIL] 后端没起来（见", data / "backend.log", "）")
            return 1

        # ① 认领：扩展读的就是这一个字段
        status, health = _get(port, "/healthz")
        if status != 200 or health.get("app") != APP_IDENTIFIER:
            bad.append(f"/healthz 没有应用标识（status={status} body={health}）⇒ 扩展认不出应用")
        else:
            print(f"  ① 认领：/healthz app={health['app']!r} version={health.get('version')!r}")

        # ② 配对 token：没带应用 token ⇒ 401（它是钥匙本身，不能公开）
        status, _ = _get(port, "/auth/pairing")
        if status != 401:
            bad.append(f"/auth/pairing 没带应用 token 却是 {status}（应当 401）")
        status, pair = _get(port, "/auth/pairing", APP_HEADERS)
        token = (pair or {}).get("token") or ""
        if status != 200 or len(token) < 32:
            bad.append(f"拿配对 token 失败：status={status} body={pair}")
        else:
            print(f"  ② 配对：token 长度 {len(token)}（值不打印）、"
                  f"上次同步={pair.get('last_sync')!r}")

        # ③ 四平台导入：两个走离线校验（成功路径）、两个判缺键（不碰上游）
        #    ⚠️ cookie 值一律带 `smoke-` 标记：回执"不泄值"那条判据才有牙口
        #    （第一版用 `SSOLoginState=1`，而回执里本来就有 `cookie_keys: 1` ⇒ 假红）。
        cases = [
            ("xiaohongshu", "a1=smoke-a1-value; web_session=smoke-session-value", 200),
            ("douyin", "uifid=smoke-uifid; s_v_web_id=smoke-v; ttwid=smoke-ttwid", 200),
            ("bilibili", "buvid3=smoke-only-device-id", 400),     # 缺 SESSDATA/bili_jct
            ("weibo", "SSOLoginState=smoke-wei-state", 400),       # 缺 SUB
        ]
        for platform, cookie, want in cases:
            body = {"platform": platform, "cookie": cookie}
            if platform == "douyin":
                body["ua"] = "Mozilla/5.0 (extension-smoke)"
            status, receipt = _post(port, "/auth/import", body, {PAIR_HEADER: token})
            ok = bool((receipt or {}).get("ok"))
            print(f"  ③ {platform}: HTTP {status} ok={ok} keys={(receipt or {}).get('keys')} "
                  f"missing={(receipt or {}).get('missing')}")
            if status != want:
                bad.append(f"{platform} 期望 {want} 实得 {status}：{receipt}")
            # 回执里**不许**出现 cookie 的值（只认带标记的那一段）
            leaked = [v for v in cookie.split("; ") if "smoke-" in v.split("=", 1)[-1]
                      and v.split("=", 1)[-1] in json.dumps(receipt, ensure_ascii=False)]
            if leaked:
                bad.append(f"{platform} 的回执回显了 cookie 值：{leaked}")

        # ④ 落盘：`/auth/pairing` 的 last_sync 只该说"小红书/抖音"，且只有键名
        status, pair2 = _get(port, "/auth/pairing", APP_HEADERS)
        last = (pair2 or {}).get("last_sync") or {}
        print(f"  ④ 上次同步：{last.get('label')!r} keys={last.get('keys')!r} "
              f"verified={last.get('verified')!r}")
        if last.get("platform") != "douyin":
            bad.append(f"「上次同步」不是最后成功的那一个：{last}")
        if "smoke-" in json.dumps(pair2, ensure_ascii=False):
            bad.append("「上次同步」里带了 cookie 值")

        # ⑤ `.env` 真的写进去了（在**临时目录**里，不碰用户那份）
        env_text = (data / ".env").read_text(encoding="utf-8") if (data / ".env").exists() else ""
        for want in ("XHS_COOKIE=a1=smoke-a1-value", "DOUYIN_COOKIE=uifid=smoke-uifid",
                     "DOUYIN_UA=Mozilla/5.0 (extension-smoke)"):
            if want not in env_text:
                bad.append(f"`.env` 里没有 {want!r}")
        # ⚠️ 判"**有值**"而不是"键在不在"：`.env` 里本来就可能有一行空的占位
        #    （`_save_to_env` 会把六个键都写一遍）—— 第一版就是被这行空值判成假红的。
        if re.search(r"^BILI_SESSDATA=\S", env_text, re.M):
            bad.append("B 站那条缺键被拒了，`.env` 里却写进了 BILI_SESSDATA 的值")
        print(f"  ⑤ .env 写入：{len(env_text)} 字节（临时目录 {data.name}）"
              f"｜B 站那行={'有值' if re.search(r'^BILI_SESSDATA=\S', env_text, re.M) else '空/无'}")

        # ⑥ 错的配对 token ⇒ 401（扩展侧要能把这句话显示出来）
        status, _ = _post(port, "/auth/import",
                          {"platform": "xiaohongshu", "cookie": "a1=x; web_session=y"},
                          {PAIR_HEADER: "wrong"})
        if status != 401:
            bad.append(f"错的配对 token 却是 {status}（应当 401）")
        print(f"  ⑥ 错 token：HTTP {status}")
    finally:
        be.terminate()
        try:
            be.wait(timeout=10)
        except Exception:
            be.kill()
        log.close()

    if bad:
        print("\n[FAIL] 扩展链路冒烟没过：")
        for b in bad:
            print("  -", b)
        return 1
    print("\n[ok] 扩展链路冒烟通过（认领 / 配对 / 四平台导入 / 回执不泄值 / .env 落盘）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
