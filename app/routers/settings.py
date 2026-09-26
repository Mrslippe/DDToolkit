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
    # 关闭窗口的语义（R18，devlog/095）：`ask` = 首次点 ✕ 时问一次（用户选定"首次问一次、
    # 之后按选择记住"）；`tray` = 直接隐藏到托盘；`quit` = 直接退出。
    # 存在后端而不是 localStorage：它是**用户偏好**，要和主题一样跨启动、跨清缓存活着。
    "close_action": ("ask", "ask", "tray", "quit"),
    # 桌面状态控件（R38 批 5b，devlog/173）：`on` = 在桌面上常驻一个 200×40 的无边框小窗。
    # 它和顶栏胶囊**并存**（用户 2026-09-24 拍板）：顶栏那个是"应用内状态"，
    # 小窗是"桌面状态" —— 应用被别的窗口盖住时小窗仍然可见，那正是它的价值。
    "widget_enabled": ("off", "off", "on"),
    # 小窗鼠标穿透（R38 批 5d，2026-09-24）：`on` = 鼠标事件**穿过**小窗落到下面的窗口。
    # 为什么是用户开关而不是默认开：穿透打开后**小窗自己也点不到了**（面板/拖动都没了）
    # —— 那是"我愿意让它纯粹当个显示牌"的主动选择，不能替用户决定。
    "widget_click_through": ("off", "off", "on"),
    # 小窗全屏时隐藏（R38 批 5d）：`on` = 检测到**别的程序**全屏（看视频/演示/游戏）时
    # 自动把小窗藏起来，退出全屏再放回来。置顶控件压在别人的全屏画面上很碍事，
    # 而"自己是不是全屏"在这里恒为 false（小窗固定 200×40），所以判据走系统通知状态。
    "widget_hide_fullscreen": ("on", "off", "on"),
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


# ── 「发一条测试通知」的取材（R50b，devlog/226）────────────────────────
# 用户口径（2026-09-27）：「测试通知修改为固定发送明前奶绿的最新动态」——
# 通用文案验不出真实观感，而真动态能一次验完头像 / 折行 / 链接 / 点进去是不是那条。
TEST_VTUBER_NAME = "明前奶绿"


def _account_icon(acc) -> str | None:
    """账号头像的绝对路径（卡片左上角的图标）；没有 / 文件不在就返回 None（退回 App 图标）。"""
    from pathlib import Path
    try:
        if not acc.avatar_path:
            return None
        p = Path(acc.avatar_path)
        p = p if p.is_absolute() else settings.DATA_DIR / p
        return str(p) if p.exists() else None
    except Exception:
        return None


def latest_post_of(db: Session, name: str):
    """找 `name` 这个 VTuber 的**最新一条动态**，返回 `(V 名, 账号, 帖子)`；找不到返回 None。

    取材口径：
    - 优先精确匹配 `vtubers.name`，没有再退到模糊匹配（用户可能把名字写得长一点）；
    - 账号优先主平台（bilibili），同平台按 id 稳定排序；
    - 帖子取**她最新的一条内容**（`published_at` 倒序、空值排最后、`id` 兜底）——
      **不按类型挑**：实测她的动态流里是「图文 / 转发」两类（B 站把带图的动态建成
      `image`、纯文字才是 `dynamic`），按 `type='dynamic'` 挑反而会挑到更旧的一条；
      "最新"就该是时间上的最新。拿到的是哪一类写在 `source` 里，用户一眼能看出。
    - `is_(None)` 前缀是 SQLite 上不必依赖 `NULLS LAST` 的等价写法。
    """
    from app.models.vtuber import Account, Post, VTuber

    v = (db.query(VTuber).filter(VTuber.name == name).first()
         or db.query(VTuber).filter(VTuber.name.like(f"%{name}%")).first())
    if v is None:
        return None
    accounts = db.query(Account).filter(Account.vtuber_id == v.id).all()
    accounts.sort(key=lambda a: (a.platform != "bilibili", a.id))
    for acc in accounts:
        base = db.query(Post).filter(
            Post.platform == acc.platform,
            Post.platform_uid == str(acc.platform_uid),
            Post.is_archived == False,           # noqa: E712
        )
        order = (Post.published_at.is_(None), Post.published_at.desc(), Post.id.desc())
        post = base.order_by(*order).first()
        if post is not None:
            return v.name, acc, post
    return None


@router.post("/test-notification")
def test_notification(db: Session = Depends(get_db)):
    """用**当前外观**立刻发一条测试通知，返回投递判据（R50，devlog/219 / 226）。

    为什么需要一个真投递的端点：通知的可见性受一堆因素影响（总开关、系统是否允许、
    卡片是否画得出来）。调「字号 / 颜色 / 不透明度」时如果只能等真有人开播，
    这个设置就等于没法调 —— 用户得当场看到效果。

    **内容固定为「{TEST_VTUBER_NAME}」的最新动态**（用户口径 2026-09-27，第二次修订）：
    通用的"DDtoolkit 测试通知"看不出真实观感（没有头像、标题太短、点进去是示例站），
    而真实动态能一次验完四件事 —— 主播头像、折行、链接能不能点、点进去是不是那条帖子。
    **不再有"通用文案"这条路**：库里没有她（或她还没有帖子）时，用**最小卡片**
    （标题仍是「{TEST_VTUBER_NAME} 更新了动态」、正文只有"1 条新内容"）——
    既不编造内容，也不会让用户看到另一种完全不同的通知长相。

    ⚠️ 用 `kind="test"`：它**绕过**「开播提醒 / 动态更新提醒」两个事件开关
    （那正是这个按钮要让人看到的东西），但**总开关仍然生效**（关着就是关着）。
    `force=True` **加一次性去重键**：连着点几下试样式，既不该被自己人限流，
    也不该因为"同一条帖子刚弹过"被去重挡掉
    （实测踩过：用户拖滑杆连测 8 次后按钮"突然失效"）。
    """
    import time as _time

    from app.services import notifier

    picked = latest_post_of(db, TEST_VTUBER_NAME)
    if picked is None:
        # 最小卡片：走**同一个 composer**、同一个标题，只是没有具体内容可填
        # （compose_new_posts 会过滤空行，所以这里给一条只有类型的占位）
        item = notifier.compose_new_posts(TEST_VTUBER_NAME, "bilibili",
                                          [{"type": "dynamic"}])
        title, body, url, icon_path = item.title, item.body, item.url, None
        source = f"{TEST_VTUBER_NAME} 的最新动态（库里暂无数据：最小卡片）"
    else:
        name, account, post = picked
        item = notifier.compose_new_posts(
            name, account.platform,
            [{"type": post.type, "platform_post_id": post.platform_post_id,
              "title": post.title, "summary": post.summary, "permalink": post.permalink}],
            account_url=account.url, icon_path=_account_icon(account))
        title, body, url, icon_path = item.title, item.body, item.url, item.icon_path
        label = notifier.POST_TYPE_LABELS.get(post.type or "", "动态")
        source = f"{name} 的最新动态（{label}）"

    queued = notifier.notify("test", title, body, key=f"settings-test:{_time.time()}",
                             url=url, icon_path=icon_path, force=True)
    verdict: dict = {}
    deadline = _time.monotonic() + 2.0          # 投递线程通常 <0.5s 就出结果
    while _time.monotonic() < deadline:
        got = notifier.last_delivery()
        if got and got.get("title") == title:
            verdict = got
            break
        _time.sleep(0.1)
    return {
        "queued": bool(queued), "title": title, "body": body, "url": url,
        "source": source,
        "popup": bool(verdict.get("popup")), "icon": bool(verdict.get("icon")),
        "detail": str(verdict.get("detail") or ""),
    }


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


def prefs_specs() -> list[dict]:
    """偏好项的规格表（界面文案 + 允许取值）。

    抽成模块级函数而不是写在 `get_prefs` 里：`tests/test_runtime_settings.py` 要扫这些文案
    （用户可见文案是**纯文本**，混进 Markdown 标记会原样显示 —— 2026-09-15 踩过），
    直接在路由函数里拼就扫不到了。
    """
    return [
        {"key": "theme", "label": "主题", "group": "外观",
         "options": [{"value": "light", "label": "浅色"},
                     {"value": "system", "label": "跟随系统"}],
         "note": THEME_NOTE},
        {"key": "close_action", "label": "关闭窗口时", "group": "外观",
         "options": [{"value": "ask", "label": "每次询问"},
                     {"value": "tray", "label": "最小化到托盘"},
                     {"value": "quit", "label": "直接退出"}],
         # ⚠️ 这里是**纯文本**（前端按原样渲染，不做 Markdown）—— 别写 `**粗体**`，
         #    那会连星号一起显示出来（2026-09-15 用户截图反馈）。
         "note": "最小化到托盘时后台抓取照常进行（界面不再刷新与轮询），"
                 "点托盘图标或再次启动即可唤回；隐藏 10 分钟后会释放界面内存，"
                 "唤回时自动恢复到你离开的位置"},
        {"key": "widget_enabled", "label": "桌面状态控件", "group": "外观",
         "options": [{"value": "off", "label": "关闭"},
                     {"value": "on", "label": "开启"}],
         # ⚠️ 纯文本（同 close_action 那条，别写 Markdown）
         "note": "在桌面上常驻一个小窗，显示与顶栏状态胶囊相同的内容；"
                 "它与顶栏那个并存 —— 主窗口被别的窗口盖住时小窗仍然可见。"
                 "小窗可拖动，位置会记住；开关立即生效，不用重启"},
        {"key": "widget_click_through", "label": "小窗鼠标穿透", "group": "外观",
         "options": [{"value": "off", "label": "关闭（可点击）"},
                     {"value": "on", "label": "开启（点击穿过）"}],
         # ⚠️ 纯文本（同上，别写 Markdown）
         "note": "开启后鼠标点击会穿过小窗落到下面的窗口，小窗变成纯显示牌"
                 "（它自己也点不动了）；想操作小窗里的面板时先关掉这一项"},
        {"key": "widget_hide_fullscreen", "label": "全屏时隐藏小窗", "group": "外观",
         "options": [{"value": "on", "label": "开启"},
                     {"value": "off", "label": "关闭（全屏也显示）"}],
         # ⚠️ 纯文本（同上，别写 Markdown）
         "note": "检测到别的程序进入全屏（看视频、演示、游戏）时自动把小窗藏起来，"
                 "退出全屏后自动恢复 —— 避免置顶小窗压在别人的全屏画面上"},
    ]


@router.get("/prefs")
def get_prefs(db: Session = Depends(get_db)):
    from app.repositories.vtuber_repo import AppMetaRepo
    stored = AppMetaRepo(db).all_with_prefix(PREFS_PREFIX)
    return {
        "values": _load_prefs(db),
        "defaults": {k: v[0] for k, v in PREFS.items()},
        # 每个键的允许取值 + 说明：界面文案同样由后端下发（与 specs 一个口径）
        "specs": prefs_specs(),
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


# ── 存储占用与维护（R22-B，devlog/104）────────────────────────────────
# 起因（用户 2026-09-16）："数据库放置在 C 盘中会不会导致数据量很大了之后挤占太多 C 盘空间？"
# A/D 两批已经把"涨得最快的缓存"管住、并让删数据真的还盘；这里把**占用显示出来**、
# 给两个能立刻动手的按钮，并在磁盘快满时提醒一次。
#
# ⚠️ 这些端点都**真扫目录**（`dir_stats` 递归统计），所以只给「关于」页打开时取一次，
#    不要拿去做轮询。

# 低空间提醒阈值（用户口径 2026-09-16：状态岛提醒一次 + 关于页显示；阈值不做成设置项）
LOW_SPACE_THRESHOLD_BYTES = 5 * 1024 ** 3      # 5GB


def _storage_payload() -> dict:
    """「关于」页存储面板的数据：谁在占地方 + 缓存上限 + 磁盘余量 + 是否该提醒。"""
    from app.routers import img_proxy
    from app.services import db_maintenance

    st = db_maintenance.dir_stats()
    st["img_cache"] = img_proxy.cache_stats()
    st["low_space_threshold_bytes"] = LOW_SPACE_THRESHOLD_BYTES
    st["low_space"] = bool(st["disk"]["total"]) and st["disk"]["free"] < LOW_SPACE_THRESHOLD_BYTES
    return st


@router.get("/storage")
def get_storage():
    """存储占用体检（库 / 图片缓存 / 日志 / 迁移备份 / 其余 + 磁盘剩余 + 遗留备份）。"""
    return _storage_payload()


@router.get("/diagnostics")
def get_diagnostics():
    """诊断包（批次 16，devlog/207）：用户"一键拿到一份能发给开发者的东西"。

    ⚠️ **没有进公开白名单**（`app/core/api_auth.py`）⇒ 它要会话 token ——
    里面是日志尾部与库形态，不该让"扫到端口的任何本机进程"随便读。
    **不含凭据**（`.env` / cookie / token 一律不读），判据在
    `tests/test_migration_safety.py::test_diagnostics_*`。
    """
    from app.services import diagnostics

    return diagnostics.build_diagnostics()


@router.post("/storage/prune-cache")
def prune_img_cache():
    """清空图片缓存 —— 用户主动点的按钮，口径是**全清**（缓存可再生，删了下次重下）。"""
    from app.routers import img_proxy

    got = img_proxy.clear_cache()
    logger.info(f"手动清理图片缓存：{got['files']} 个文件 / {got['bytes']} 字节")
    return {**got, "storage": _storage_payload()}


@router.post("/storage/maintenance")
def run_storage_maintenance():
    """整理数据库：回收 WAL + 把空闲页还盘（与启动时的自动维护用同一套函数）。

    为什么值得有按钮：删数据本身**不会**让文件变小（SQLite 默认把空闲页留在 freelist），
    而"删完发现没腾出地方"是最容易让人怀疑软件坏了的一件事。
    """
    from app.services import db_maintenance

    wal = db_maintenance.checkpoint_wal()
    freed_pages = db_maintenance.incremental_vacuum()
    logger.info(f"手动整理数据库：WAL {wal['before']} → {wal['after']} 字节，"
                f"还盘 {freed_pages} 页")
    return {"wal_before": wal["before"], "wal_after": wal["after"],
            "freed_pages": freed_pages, "storage": _storage_payload()}
