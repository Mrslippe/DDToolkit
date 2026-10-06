# -*- coding: utf-8 -*-
"""**用户协议 / 使用须知声明的同意状态**（2026-10-06）。

> 「第一次启动应用或者更新至这个版本时，都要阅读一个用户协议或者公告，内容类似于这个应用的
> 功能简介和各类风险，并且使用带来的后果由用户承担，阅读完同意才可以关闭窗口」

## 口径（2026-10-06 第二次拍板后定稿，四条都写进用例）

1. **要同意的版本 = `NOTICE_VERSION`（声明自己的版本），不是应用版本。**
   用户口径：「**不要每次版本更新都让用户确认一次**，如果用户协议没有更新那么就不用让用户确认了；
   我希望的效果是在这次推送的版本更新中**所有用户都需要确认**（因为之前并没有用户协议），
   而这次之后则**只有首次使用这个应用的用户**需要确认。」
   ⇒ 应用版本怎么涨都不再打扰老用户；**只有正文改了、把 `NOTICE_VERSION` 往上提**，
   才会再要求所有人确认一次。
2. **本次（1.1.0）为什么所有人都要确认**：这是第一条声明的第一次落地 ——
   任何老用户库里都没有 `NOTICE_VERSION` 那一条记录 ⇒ `needed=true`。
   （升级前的键值语义是"应用版本"，所以历史那行 `1.0.2` 天然对不上，不需要迁移脚本。）
3. **同意状态存 `app_meta`**（`AppMetaRecord`）：跟数据目录走、跟迁移走，重启不丢。
   键：`legal.accepted_version`（存的是**声明版本**）/ `legal.accepted_at`。
4. **只认"当次要求的那个版本"**：拿别的版本号来同意一律拒（400）——
   否则前端传个空串或旧版本就能把闸门绕过去（那是"假装读过了"）。

⚠️ 这里**不存协议正文**：正文是前端那份组件里的常量（它要排版、要能滚动）。
**改正文时请同步改这个常量**（`NOTICE_VERSION`，用生效日期当版本号，一眼能看出新旧）；
真要做成"改一个字就重弹"，把要同意的版本换成**正文哈希**即可 —— 那时再加。
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.repositories.vtuber_repo import AppMetaRepo

logger = logging.getLogger(__name__)

#: **声明自己的版本**（= 生效日期）。⚠️ **改 `LegalNotice.tsx` 的正文时把它一起改**，
#: 否则老用户不会再看到新正文（这是"不要每次版本更新都弹"的代价，见模块头第 1 条）。
NOTICE_VERSION = "2026-10-06"

#: 已同意的**声明版本**（空 = 还没同意过任何版本）
ACCEPTED_KEY = "legal.accepted_version"
#: 同意时刻（ISO8601，UTC；给人看/留痕用，不参与判定）
ACCEPTED_AT_KEY = "legal.accepted_at"


def required_version() -> str:
    """当前要求同意的**声明版本**（不是应用版本，见模块头第 1 条）。"""
    return NOTICE_VERSION


def state(db: Session) -> dict:
    """给人看的当前状态（前端据此决定要不要弹闸门、设置里那一栏显示什么）。"""
    repo = AppMetaRepo(db)
    accepted = (repo.get(ACCEPTED_KEY) or "").strip()
    return {
        "required": required_version(),
        "accepted": accepted or None,
        "accepted_at": repo.get(ACCEPTED_AT_KEY) or None,
        "needed": accepted != required_version(),
        # 应用版本单独给（界面要显示"应用 v1.1.0"；**它与要不要弹无关**）
        "app_version": str(settings.VERSION),
    }


def accept(db: Session, version: str) -> dict:
    """记下"这个声明版本已同意"。`version` 必须**正好是当次要求的那个**（见模块头第 4 条）。"""
    want = required_version()
    got = (version or "").strip()
    if got != want:
        raise ValueError(f"当前要求同意的是 {want}，收到的是 {got or '（空）'}")
    repo = AppMetaRepo(db)
    repo.set(ACCEPTED_KEY, want)
    repo.set(ACCEPTED_AT_KEY, datetime.now(timezone.utc).isoformat(timespec="seconds"))
    db.commit()
    logger.info(f"用户已同意声明 {want}（{ACCEPTED_AT_KEY} 已记录）")
    return state(db)
