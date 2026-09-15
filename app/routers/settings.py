"""设置端点（R14a/R14b，devlog/091、092）：

    GET  /settings   → 规格表（含范围/单位/生效时机/当前值）+ 只读信息
    PUT  /settings   → 保存一组改动（白名单 + 类型 + 范围 + 跨字段校验），返回最终生效值
    POST /settings/reset  → 全部恢复默认
    GET  /prefs      → 界面偏好（R14b：主题）
    PUT  /prefs      → 保存界面偏好（枚举校验）

口径见 `app/core/runtime_settings.py` 的模块注释：**只收"每轮读取"的键**，
保存后下一轮生效、不用重启；启动期读取的项不在这里，只在 `readonly` 里如实列出原因。

PUT 的语义是**部分更新**（只提交要改的键）；`null` / 空串 = 删掉覆盖、回到默认值。
白名单之外、类型不对、越界、上限小于下限 —— 一律 400 并把原因写进 detail，
**不静默忽略**（静默忽略会让界面显示"已保存"而实际没生效）。

`/prefs` 与 `/settings` 分开的理由（R14b）：它们**语义不同** ——
settings 是"抓取参数"，有范围与"下一轮生效"的概念；prefs 是"界面长什么样"，
`light|system` 这类枚举立即生效、没有范围。混在一个 PUT 里会让两套校验规则纠缠，
也会让界面上"外观"分区被迫挂上"下一轮生效"这种不相干的说明。
两者都落 `app_meta`，只是前缀不同（`settings.` / `prefs.`）。
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

# ── 界面偏好（R14b）──────────────────────────────────────────────────
# 白名单在**后端**：前端传什么都得先过这里，不然"用户偏好"会变成"任意 KV 都能写"。
PREFS_PREFIX = "prefs."

# 主题说明：**如实**描述当前能力 —— 深色主题还没实现（三个 CSS 里 243 处硬编码色值
# 要单独一批收敛），所以 `system` 在系统是深色时仍解析为浅色。
# 它放在这里是"当前能力的事实"，不是界面文案偏好：下一批深色落地时改这一处，
# 而 `tests/test_runtime_settings.py` 有一条**跨语言契约**把它与前端
# `utils/theme.ts::DARK_IMPLEMENTED` 绑在一起（改一边不改另一边就红）。
THEME_NOTE = ("深色主题尚未实现：选「跟随系统」时，系统为深色也仍按浅色显示"
              "（偏好已记住，深色落地后自动生效）")


def _theme_note() -> str:
    return THEME_NOTE


PREFS: dict[str, tuple] = {
    "theme": ("light", "light", "system"),
}


class SettingsUpdate(BaseModel):
    """`{"values": {"REQUEST_INTERVAL_MIN": 1.5, "FETCH_BATCH_SIZE": null}}`"""

    values: dict[str, object]


class PrefsUpdate(BaseModel):
    """`{"values": {"theme": "system"}}`；`null`/空串 = 回默认（删行）"""

    values: dict[str, str | None]


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


# ── 界面偏好（R14b，devlog/092）───────────────────────────────────────

def _load_prefs(db: Session) -> dict[str, str]:
    """读偏好：库里没有 / 存的值不在白名单内 → 用默认值（**不报错**：
    旧版本写的值不该让设置窗口打不开；但会在日志里留一条 warning）。"""
    from app.repositories.vtuber_repo import AppMetaRepo
    stored = AppMetaRepo(db).all_with_prefix(PREFS_PREFIX)
    out: dict[str, str] = {}
    for key, (default, *allowed) in PREFS.items():
        raw = stored.get(key)
        if raw is None:
            out[key] = default
        elif raw in allowed:
            out[key] = raw
        else:
            logger.warning("偏好 %s 的值 %r 不在允许集合 %s 内，按默认值 %r 处理",
                           key, raw, allowed, default)
            out[key] = default
    return out


@router.get("/prefs")
def get_prefs(db: Session = Depends(get_db)):
    from app.repositories.vtuber_repo import AppMetaRepo
    stored = AppMetaRepo(db).all_with_prefix(PREFS_PREFIX)
    return {
        "values": _load_prefs(db),
        "defaults": {k: v[0] for k, v in PREFS.items()},
        # 每个键的允许取值 + 说明：界面文案同样由后端下发（与 specs 一个口径）
        "specs": [
            {"key": "theme", "label": "主题", "group": "外观",
             "options": [{"value": "light", "label": "浅色"},
                         {"value": "system", "label": "跟随系统"}],
             "note": THEME_NOTE},
        ],
        "changed": sorted(k for k in PREFS if k in stored),
    }


@router.put("/prefs")
def update_prefs(payload: PrefsUpdate, db: Session = Depends(get_db)):
    """部分更新；`null`/空串 = 回默认。未知键或不在白名单内的取值一律 400。"""
    from app.repositories.vtuber_repo import AppMetaRepo
    if not payload.values:
        raise HTTPException(400, "没有需要保存的偏好项")
    unknown = [k for k in payload.values if k not in PREFS]
    if unknown:
        raise HTTPException(400, f"不认识的偏好项：{', '.join(sorted(unknown))}")
    repo = AppMetaRepo(db)
    for key, raw in payload.values.items():
        default, *allowed = PREFS[key]
        if raw is None or raw == "":
            repo.delete(PREFS_PREFIX + key)
            continue
        if raw not in allowed:
            raise HTTPException(
                400, f"{key} 只能取 {'/'.join(allowed)}，实得 {raw!r}")
        repo.set(PREFS_PREFIX + key, raw)
    return {"ok": True, "changed": sorted(payload.values), "values": _load_prefs(db)}
