"""设置端点（R14a，devlog/091）：

    GET  /settings   → 规格表（含范围/单位/生效时机/当前值）+ 只读信息
    PUT  /settings   → 保存一组改动（白名单 + 类型 + 范围 + 跨字段校验），返回最终生效值

口径见 `app/core/runtime_settings.py` 的模块注释：**只收"每轮读取"的键**，
保存后下一轮生效、不用重启；启动期读取的项不在这里，只在 `readonly` 里如实列出原因。

PUT 的语义是**部分更新**（只提交要改的键）；`null` / 空串 = 删掉覆盖、回到默认值。
白名单之外、类型不对、越界、上限小于下限 —— 一律 400 并把原因写进 detail，
**不静默忽略**（静默忽略会让界面显示"已保存"而实际没生效）。
"""
import logging
import os

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core import runtime_settings
from app.core.config import settings
from app.core.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingsUpdate(BaseModel):
    """`{"values": {"REQUEST_INTERVAL_MIN": 1.5, "FETCH_BATCH_SIZE": null}}`"""

    values: dict[str, object]


def _readonly(request: Request) -> dict[str, object]:
    """只读信息：界面**照实显示**，不给改（每项的"为什么"在 `runtime_settings.READONLY_NOTES`）。"""
    # 延迟导入：`app.main` 在模块级 include 本路由，顶层反向 import 会成环
    from app.main import MIGRATION_HEAD
    # 端口取"客户端实际连上的那个"（桌面端由启动器抢空闲端口后注入，
    # 开发态 uvicorn --port 也没写进 settings）；拿不到才退回环境变量
    port = request.url.port or (int(os.getenv("DDTOOLKIT_PORT"))
                                if (os.getenv("DDTOOLKIT_PORT") or "").isdigit() else None)
    return {
        "app_name": settings.APP_NAME,
        "version": settings.VERSION,
        "data_dir": str(settings.DATA_DIR),
        "database": settings.DATABASE_URL,
        "port": port,
        "migration_head": MIGRATION_HEAD,
        "log_file": settings.LOG_FILE,
        "cors_origins": settings.CORS_ORIGINS,
        "env_file": str(settings.DATA_DIR / ".env"),
        "pid": os.getpid(),
    }


@router.get("")
def get_settings(request: Request):
    return {
        "specs": runtime_settings.spec_table(),
        "readonly": runtime_settings.readonly_info(),
        "info": _readonly(request),
        "overrides": runtime_settings.overrides(),
    }


@router.put("")
def update_settings(payload: SettingsUpdate, db: Session = Depends(get_db)):
    if not payload.values:
        raise HTTPException(400, "没有需要保存的设置项")
    try:
        merged = runtime_settings.apply(payload.values, db)
    except KeyError as e:
        raise HTTPException(400, str(e).strip("\"'"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:                      # 落库失败：内存未被替换，如实报错
        logger.error("设置保存失败: %s", e)
        raise HTTPException(500, f"保存失败：{e}")
    changed = sorted(payload.values)
    return {
        "ok": True,
        "changed": changed,
        "values": {k: merged[k] for k in changed},
        "overrides": runtime_settings.overrides(),
    }


@router.post("/reset")
def reset_settings(db: Session = Depends(get_db)):
    """整表恢复默认（界面的「全部恢复默认」）。"""
    keys = {k: None for k in runtime_settings.HOT_KEYS}
    merged = runtime_settings.apply(keys, db)
    return {"ok": True, "changed": sorted(keys), "values": merged,
            "overrides": runtime_settings.overrides()}
