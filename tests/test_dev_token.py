# -*- coding: utf-8 -*-
"""开发态 token 的**单源与调用方覆盖**（S1，devlog/201/202/203）。

为什么给它写用例：S1 给后端加了门禁之后，**开发态打自己后端的脚本逐个失效**，
而它们失效的样子非常不像"门禁问题"：

| 脚本 | 症状 |
|---|---|
| `ui_probe.py` / `probe.ts` | 探针 60 条 401 ⇒ 报"布局/内容坏了"（S1b 修） |
| `dev_check.py` | 后端冒烟 401，却被**误报成"当前网络不可达"**（排查方向被带偏） |
| `smoke_upstream.py` | 5 腿里 4 腿 `HTTP Error 401` ⇒ 看起来像**上游挂了** |
| `perf_report.py` | `PUT /settings/prefs` 401 ⇒ 深休眠那一段量到的是"窗口还开着"的树 |

⇒ 判据两条：**① 三处字面量必须同值**；**② 谁起后端就必须给后端 token**。
两条都能反向验证（见各自 docstring），且都**不需要真跑后端**。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import dev_token  # noqa: E402

from app.core import api_auth  # noqa: E402


# ── ① 单源：Python 常量 ←→ 两个 TS 复述点 ───────────────────────────────────

def test_dev_token_literal_matches_both_frontend_copies():
    """三处字面量必须同值：`scripts/dev_token.py` · `vite.config.ts` · `api.ts`。

    为什么不能 import：TS 侧读不到 Python 常量，所以只能结构扫描 —— 但**必须有**，
    否则改了 Python 那侧、忘了 TS 那侧的症状是"页面所有数据为空 ⇒ 像功能坏了"
    （devlog/201 §四 真实踩过一次）。

    反向验证：把 `dev_token.DEV_TOKEN` 改成别的值 ⇒ 两条断言都红。
    """
    vite = (ROOT / "frontend" / "vite.config.ts").read_text(encoding="utf-8")
    m = re.search(r"VITE_DEV_API_TOKEN'\s*:\s*JSON\.stringify\(\s*"
                  r"process\.env\.VITE_DEV_API_TOKEN \?\? '([^']+)'", vite)
    assert m, "vite.config.ts 里找不到 `VITE_DEV_API_TOKEN` 的 define 默认值"
    assert m.group(1) == dev_token.DEV_TOKEN, \
        f"vite.config.ts 的默认值 {m.group(1)!r} ≠ dev_token.DEV_TOKEN"

    api = (ROOT / "frontend" / "src" / "api" / "api.ts").read_text(encoding="utf-8")
    m2 = re.search(r"VITE_DEV_API_TOKEN as string \| undefined\) \?\? '([^']+)'", api)
    assert m2, "api.ts 里找不到 `DEV_API_TOKEN` 的 fallback"
    assert m2.group(1) == dev_token.DEV_TOKEN, \
        f"api.ts 的 fallback {m2.group(1)!r} ≠ dev_token.DEV_TOKEN"


def test_dev_token_names_match_the_backend_truth():
    """头名与环境变量名也要对账（它们各有自己的真源）。

    反向验证：把 `dev_token.HEADER` 改成 `"X-Token"` ⇒ 红（后端只认那一个头名）。
    """
    assert dev_token.HEADER == api_auth.TOKEN_HEADER, \
        "请求头名与 app/core/api_auth.py 不一致"

    config = (ROOT / "app" / "core" / "config.py").read_text(encoding="utf-8")
    assert f'os.getenv("{dev_token.ENV}"' in config, \
        f"`{dev_token.ENV}` 不是 config.py 读的那个变量名"
    assert f'os.getenv("{dev_token.PROD_ENV}"' in config, \
        f"`{dev_token.PROD_ENV}` 不是 config.py 读的那个变量名"


# ── ② 覆盖：谁起后端，谁就得给后端 token ────────────────────────────────────

def _scripts_that_start_a_backend_server() -> list[Path]:
    """判据不是"提到 backend_main.py"，而是**给子进程设 `DDTOOLKIT_PORT`** ——
    那才是"我在起一个后端服务器"的标志（build_backend.py 只是打包，不算）。
    """
    found = []
    for p in sorted((ROOT / "scripts").glob("*.py")):
        text = p.read_text(encoding="utf-8", errors="replace")
        if "DDTOOLKIT_PORT" in text and "Popen(" in text:
            found.append(p)
    return found


def test_every_script_that_starts_a_backend_passes_the_dev_token():
    """起后端的脚本必须**真的把 token 并进子进程 env**（S1 之后漏一个就是整条腿 401）。

    ⚠️ 判据必须匹配"并入 env 这个动作"，不能只找字符串 —— 第一版写成
    `"backend_env(" in text`，结果**只留 import 也照样绿**（反向验证当场抓到）。
    认两种写法：
      · `**backend_env()` / `**dev_token.backend_env()`（推荐，两端一起固定）；
      · 显式的键值对 `"DDTOOLKIT_DEV_API_TOKEN": …`（探针用它钉确定值）。

    反向验证：删掉 `dev_check.py` 里的 `**backend_env(),` ⇒ 本用例红（点名那个文件）。
    """
    scripts = _scripts_that_start_a_backend_server()
    assert len(scripts) >= 3, f"判据本身失效了 —— 只找到 {len(scripts)} 个起后端的脚本"

    injects = re.compile(r"\*\*\s*(?:dev_token\.)?backend_env\(\)"
                         r'|"' + re.escape(dev_token.ENV) + r'"\s*:')
    missing = [p.name for p in scripts
               if not injects.search(p.read_text(encoding="utf-8", errors="replace"))]
    assert not missing, (
        f"这些脚本起了后端但没把 token 并进它的 env：{missing} —— S1 起它们打自己的后端会逐条"
        f" 401，而症状看起来像网络/上游坏了（见本文件 docstring 的表）。"
        f"修法：`from dev_token import backend_env`，然后在 env 字典里 `**backend_env()`。"
    )


def test_scripts_that_call_the_backend_send_the_header():
    """打后端业务端点的脚本必须发 token 头（本脚本自己也覆盖 `dev_token` 的使用）。

    判据取"文件里出现过 `dev_token.headers()`"：这是脚本侧**唯一**该用的写法
    （头名只写在 `dev_token.py` 一处）。

    反向验证：把 `smoke_delete.py` 里的 `dev_token.headers()` 换成手写的 `{}` ⇒ 红。
    """
    for name in ("dev_check.py", "smoke_upstream.py", "smoke_delete.py", "perf_report.py",
                 "ui_probe.py"):
        text = (ROOT / "scripts" / name).read_text(encoding="utf-8", errors="replace")
        assert "dev_token" in text, f"{name} 没有接开发态 token（S1 起它会 401）"


#: 后端**业务**路径前缀（要 token）；公开四处（`/healthz`、`/static/`、`/img-proxy`、
#: `/video-proxy`）是有意不鉴权的，见 `app/core/api_auth.py` 的 docstring。
_BUSINESS_PATHS = ("/vtuber", "/account", "/posts", "/post/", "/externals", "/settings",
                   "/auth", "/capabilities", "/messages", "/healthz")
_PUBLIC_PATHS = ("/healthz", "/static/", "/img-proxy", "/video-proxy")


def test_probe_backend_calls_send_the_token():
    """`ui_probe.py` 里**从 Python 侧**打后端业务端点的每一发都要带头（devlog/242）。

    为什么单列一条：S1 之后探针里留了**三处裸 `urlopen`**（`_first_vtuber` 与两处
    `profile-cards` 对账），恒定 401，而症状**都长得不像认证问题**：
    `_first_vtuber` 失败 ⇒ 路由落到 `/` ⇒ 只量到 `empty`、所有布局断言空转；
    `--board-cards` 报"读不回卡片布局"。`gate.py` 显式传 `--vtuber 15`，把第一处遮住了
    —— 同一类漏在 `dev_check.py`/`smoke_upstream.py` 上已经发生过一次
    （`DEV-LOOP.md` §6.13），这是第三次。

    认两种写法：`urlopen(Request(url, headers=…))` 与 `urlopen(url, headers=…)`；
    判据是"**裸 URL 那一发**窗口里必须有 `headers=`"，公开路径三处豁免。
    反向验证：把 `_first_vtuber` 里的 `Request(..., headers=DEV_HEADERS)` 还原成裸
    `urlopen(f"…/vtuber/list")` ⇒ 本用例红并点名行号。
    """
    text = (ROOT / "scripts" / "ui_probe.py").read_text(encoding="utf-8", errors="replace")
    offenders: list[str] = []
    for m in re.finditer(r"urllib\.request\.urlopen\(", text):
        window = text[m.end(): m.end() + 260]
        if "127.0.0.1" not in window and "localhost" not in window:
            continue                       # 参数是变量（`req`）：URL 在上一句的 Request 里
        if not any(p in window for p in _BUSINESS_PATHS):
            continue
        if any(p in window for p in _PUBLIC_PATHS):
            continue                       # 公开路径：有意不鉴权
        if "headers=" in window:
            continue
        line = text[: m.start()].count("\n") + 1
        offenders.append(f"ui_probe.py:{line}")
    # `Request(...)` 那一半：URL 写在 Request 里时，同一句必须有 headers
    for m in re.finditer(r"urllib\.request\.Request\(", text):
        window = text[m.end(): m.end() + 260]
        if not any(p in window for p in _BUSINESS_PATHS):
            continue
        if any(p in window for p in _PUBLIC_PATHS):
            continue
        if "headers=" in window:
            continue
        line = text[: m.start()].count("\n") + 1
        offenders.append(f"ui_probe.py:{line}(Request)")
    assert not offenders, (
        f"这些地方打后端业务端点却没带 token 头：{offenders} —— S1 起会 401，"
        f"而症状看着像布局/数据坏了（见本用例 docstring）。"
        f"修法：`urllib.request.Request(url, headers=DEV_HEADERS)` 再传给 urlopen。"
    )

