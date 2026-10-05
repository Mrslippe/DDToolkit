# -*- coding: utf-8 -*-
"""**用户协议 / 免责声明的同意状态**（2026-10-06，用户口径）。

> 「第一次启动应用或者更新至这个版本时，都要阅读一个用户协议或者公告，内容类似于这个应用的
> 功能简介和各类风险，并且使用带来的后果由用户承担，阅读完同意才可以关闭窗口」

口径（三条，都写进用例）：

1. **要同意的版本 = `settings.VERSION`**（单一真源：`app/core/config.py`）。
   版本一变就要重看一遍 —— 这正是"或更新至这个版本时"的字面意思，也免了内容小改就重弹。
2. **同意状态存 `app_meta`**（`AppMetaRepo`）：跟着数据目录走、跟着迁移走，重启不丢。
   键：`legal.accepted_version` / `legal.accepted_at`。
3. **只认"当次要求的那个版本"**：拿别的版本号来同意一律拒（400）——
   否则前端传个空串或旧版本就能把闸门绕过去（那是"假装读过了"）。

⚠️ 这里**不存协议正文**：正文是前端那份组件里的常量（它要排版、要能滚动）。
以后若要"同意时留一份当时看到的文本"，该存的是**正文的哈希**，不是版本号 —— 那时再加。
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.repositories.vtuber_repo import AppMetaRepo

logger = logging.getLogger(__name__)

#: 已同意的版本（空 = 还没同意过任何版本）
ACCEPTED_KEY = "legal.accepted_version"
#: 同意时刻（ISO8601，UTC；给人看/留痕用，不参与判定）
ACCEPTED_AT_KEY = "legal.accepted_at"


def required_version() -> str:
    """当前要求同意的版本（= 应用版本）。"""
    return str(settings.VERSION)


def state(db: Session) -> dict:
    """给人看的当前状态（前端据此决定要不要弹）。"""
    repo = AppMetaRepo(db)
    accepted = (repo.get(ACCEPTED_KEY) or "").strip()
    return {
        "required": required_version(),
        "accepted": accepted or None,
        "accepted_at": repo.get(ACCEPTED_AT_KEY) or None,
        "needed": accepted != required_version(),
    }


def accept(db: Session, version: str) -> dict:
    """记下"这个版本已同意"。`version` 必须**正好是当次要求的那个**（见模块头第 3 条）。"""
    want = required_version()
    got = (version or "").strip()
    if got != want:
        raise ValueError(f"当前要求同意的是 {want}，收到的是 {got or '（空）'}")
    repo = AppMetaRepo(db)
    repo.set(ACCEPTED_KEY, want)
    repo.set(ACCEPTED_AT_KEY, datetime.now(timezone.utc).isoformat(timespec="seconds"))
    db.commit()
    logger.info(f"用户已同意 {want} 版协议（{ACCEPTED_AT_KEY} 已记录）")
    return state(db)
