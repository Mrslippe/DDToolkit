# -*- coding: utf-8 -*-
"""开发态固定会话 token 的**唯一真源**（S1，devlog/201/202）。

## 为什么需要它

S1 起后端要求 `X-DDToolkit-Token`（`app/core/api_auth.py`），而**所有"没有 Tauri"的开发态
形态**都拿不到那份"每次启动生成、只存内存"的生产 token：
探针（`ui_probe.py`）· `dev_check.py` 的后端冒烟 · `smoke_upstream.py` · `npm run dev`。
它们走后端留的 `DDTOOLKIT_DEV_API_TOKEN` 通路 —— 于是"这个固定值"成了多个脚本的公共依赖，
必须有**一处**真源。

⚠️ **2026-09-26 才抽出来，代价是一次真实的漏**：S1b 只修了探针与 `probe.ts`，
`dev_check.py` 与 `smoke_upstream.py` 在 S1 之后**一直 401**（`dev_check` 还把它
误报成"当前网络不可达"）。教训写进 `docs/DEV-LOOP.md` §6.13：
**加了门禁就要把所有开发态调用方过一遍**。

## 复述点（无法 import Python，只能靠判据钉住）

`frontend/vite.config.ts` 的 `define` 默认值 与 `frontend/src/api/api.ts` 的
`DEV_API_TOKEN` fallback —— 三处**必须同值**，`tests/test_dev_token.py` 有结构扫描钉着。
不一致的症状是"页面/冒烟里所有数据为空"，看起来像功能坏了（devlog/201 §四 真实踩过）。

值本身没有意义（开发态两端自洽即可）；名字里的 `ui-probe` 是历史遗留 —— 最初只有探针用它。
"""
import os

DEV_TOKEN = "dsh-ui-probe-dev-token"

#: 后端认的请求头名（真源是 `app/core/api_auth.py::TOKEN_HEADER`，判据在 tests 里对账）
HEADER = "X-DDToolkit-Token"

#: 后端读的环境变量名（真源是 `app/core/config.py::DEV_API_TOKEN`）
ENV = "DDTOOLKIT_DEV_API_TOKEN"

#: 生产 token 的环境变量名 —— **开发态脚本必须把它清成空**（见 `backend_env()`）
PROD_ENV = "DDTOOLKIT_API_TOKEN"


def token() -> str:
    """本次该用的开发态 token：**环境变量优先**（手动起的后端可能设了别的值），否则用默认值。

    自动化工具（自己起后端、自己发请求）请用 `backend_env()` 一起固定两端；
    手动工具（后端是人自己起的，如 `smoke_delete.py`）用 `headers()` 就好。
    """
    return os.environ.get(ENV) or DEV_TOKEN


def headers() -> dict[str, str]:
    """脚本侧给 `urllib.request.Request` 用的头 —— 别再手写这个头名。"""
    return {HEADER: token()}


def backend_env() -> dict[str, str]:
    """**自己起后端**的脚本要并进子进程 env 的那两项。

    ① 固定开发态 token（两端同值）；
    ② **清掉 `DDTOOLKIT_API_TOKEN`**：`api_auth._expected_token()` **优先读它**，
       于是 shell 里任何一次手动运行留下的残留会让子后端选另一个值，
       而脚本发的是 dev token ⇒ 又变成 401（本仓"本地残留环境恰好满足条件"的老毛病）。
    """
    return {ENV: token(), PROD_ENV: ""}
