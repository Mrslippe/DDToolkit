# -*- coding: utf-8 -*-
"""**配对凭证**：浏览器扩展往本机后端灌凭据时用的第二把钥匙（E1）。

## 为什么需要它（而不是把应用 token 给扩展）

`app/core/api_auth.py` 的 `X-DDToolkit-Token` 是 Tauri 每次启动生成、只注入给自家前端的
**整机 API 钥匙**（`devlog/201`）。扩展是**另一个宿主**，把它交出去等于把"读全部归档 / 改数据 /
触发抓取"的权限一起交出去 —— 而扩展只需要"写一次凭据"这一件事。
所以另发一把**只对 `POST /auth/import` 有效**的钥匙，两把钥匙不共用头、不互相冒充。

## 口径（用户 2026-10-06 拍板）

| 项 | 口径 | 为什么 |
|---|---|---|
| 生成 | 首次需要时 `secrets.token_urlsafe(32)` | 不写进代码、不进日志 |
| 落点 | `app_meta` 键 `pairing.token` | 零迁移；与数据目录一起备份/迁移（同"已读集合""限流窗口"） |
| 寿命 | **持久**，只有用户点「重置配对」才换 | 用户口径：配一次长期有效，不用每次开应用重配 |
| 传输 | 独立头（`cookie_import.PAIR_HEADER`） | 与应用 token 不可能混用；日志里一眼看得出用的是哪把 |
| 比较 | `hmac.compare_digest` | 与 `api_auth` 同一条纪律（常量时间） |
| 节流 | 60 秒窗口内失败 ≥ `MAX_FAILURES` ⇒ 拒绝（端点回 429） | 端点是**公开路径**（中间件放行、凭证自带）⇒ 不能是无限次数的猜谜机 |

⚠️ **绝不打日志、绝不进通知、绝不回显**：`current_token()` 的返回值只应出现在
「设置 → 登录」那一个界面与用户的粘贴板里。失败日志连长度都不写（同 `api_auth` 的口径）。
"""
from __future__ import annotations

import hmac
import logging
import secrets
import threading
import time
from collections import deque

from sqlalchemy.orm import Session

from app.repositories.vtuber_repo import AppMetaRepo

logger = logging.getLogger(__name__)

#: `app_meta` 里的键（改它 = 老用户的配对失效，所以带上模块名前缀）
PAIR_KEY = "pairing.token"

#: 节流：窗口内允许的失败次数（第 `MAX_FAILURES + 1` 次起拒绝）
MAX_FAILURES = 10
WINDOW_SECONDS = 60.0

_lock = threading.Lock()
_failures: deque[float] = deque()


def _new_token() -> str:
    return secrets.token_urlsafe(32)


def current_token(db: Session) -> str:
    """当前配对 token；**没有就生成一个并落库**（幂等，可安全重复调用）。

    ⚠️ 生成写在"读"里是有意的：「设置 → 登录」那一栏打开时就要有东西可显示/可复制，
    而不是逼用户先点一次「生成」。
    """
    repo = AppMetaRepo(db)
    token = (repo.get(PAIR_KEY) or "").strip()
    if token:
        return token
    token = _new_token()
    repo.set(PAIR_KEY, token)
    logger.info("已生成浏览器扩展的配对 token（%d 字符；值不进日志）", len(token))
    return token


def read_token(db: Session) -> str | None:
    """只读（**不生成**）—— 校验路径用它：没人配过就不该因为"来了一次校验"而凭空生成。"""
    token = (AppMetaRepo(db).get(PAIR_KEY) or "").strip()
    return token or None


def reset_token(db: Session) -> str:
    """换一把新的（旧 token 立即失效）。用户点「重置配对」时调用。"""
    token = _new_token()
    AppMetaRepo(db).set(PAIR_KEY, token)
    logger.info("浏览器扩展的配对 token 已重置（旧值立即失效）")
    return token


def verify(db: Session, presented: str | None) -> bool:
    """`presented` 是不是当前配对 token（常量时间比较；没配过一律 False）。"""
    expected = read_token(db)
    if not expected or not presented:
        return False
    return hmac.compare_digest(presented, expected)


# ── 失败节流（进程内；重启即清空 —— 它挡的是"此刻正在猜"，不是"历史上有过失败"）────

def note_failure() -> None:
    with _lock:
        _failures.append(time.monotonic())


def note_success() -> None:
    """成功一次就清空窗口：合法用户偶尔手滑不该把自己锁在门外。"""
    with _lock:
        _failures.clear()


def is_throttled() -> bool:
    """窗口内失败次数是否已达上限。"""
    now = time.monotonic()
    with _lock:
        while _failures and now - _failures[0] > WINDOW_SECONDS:
            _failures.popleft()
        return len(_failures) >= MAX_FAILURES


def recent_failures() -> int:
    """窗口内失败了几次（**只给日志用**：日志要能看出"是不是有人在猜"）。"""
    now = time.monotonic()
    with _lock:
        while _failures and now - _failures[0] > WINDOW_SECONDS:
            _failures.popleft()
        return len(_failures)


def reset_throttle() -> None:
    """清空节流窗口（**用例用**：模块级状态跨用例串味会让 429 判据时绿时红）。"""
    with _lock:
        _failures.clear()
