"""B站表情名 → 图片地址（2026-10-13，用户第 5 条）。

## 用户口径

「我希望帖子内容中的 `[xx表情包_aaa]` 可以被渲染出来」——帖子正文（`body_json.text`）里
带方括号的表情 token 现在是一串字面文字，要换成真表情图。

## 真机数据（2026-10-13 现数，5,056 帖）

| 形状 | 出现次数 | 说明 |
|---|---|---|
| `UPOWER_<uid>_<名>` | 3,207 | **发帖 UP 自己的**动态表情 |
| `<包名>_<名>`（如 `明前奶绿收藏集表情包_石化`） | 2,285 | 收藏集/自定义包 |
| 无下划线（如 `1P`、`▓▓`） | 514 | **不是表情**（分P 标记、被屏蔽词）⇒ 不动它 |
| `UP_<uid>_<名>` | 174 | 视频 owner 表情 |
| `[话题]` | 214 | **微博话题标记**（`#xxx[话题]#`）⇒ 必须排除 |

## 能解析多少（实测，不是估计）

合并「全局动态表情包（匿名 225 个）」+「用户表情面板（鉴权 431 个）」两个来源，
再按形状归一化（`UPOWER_<uid>_贴贴` → 试 `贴贴`；`<包>_<名>` → 也试裸名）：

**142 / 501 个 token 能解析出图片地址（28%）**。

⇒ 剩下的**必须**有兜底（用户也认了这个方案）：前端把解析不出来的渲染成
**名字 chip**（`[包名_名]` 那样一枚小标签），而不是原样留着方括号 —— "这是一枚表情，
只是本机没有它"比"一串看不懂的方括号"清楚。

## 为什么解析率只有 28%（写下来免得下次当 bug 查）

`UPOWER_<uid>_<名>` 里那个 uid 是**发帖那个 UP** 的，而表情面板接口给的是
**本机登录账号能看到的那几包**（实测 `up_id=<别人的 uid>` 匿名/鉴权都拿不到别人的包）。
所以"能渲染几个"取决于本机账号收藏了哪些包 —— 这是**账号相关**的，不是缺陷。

## 缓存

面板接口一次返回几百个表情，**不是**按 token 查（没有"按名查"的端点）。所以：
拉一次整表 → 建 `名字 → url` 索引 → 进程内缓存 `PANEL_TTL`（默认 30 分钟）。
上游失败**不抛错**：返回空索引，前端全走 chip 兜底（表情不该让正文渲染失败）。
"""
from __future__ import annotations

import logging
import re
import time

logger = logging.getLogger(__name__)

#: 面板/全局包多久重拉一次（秒）。上游是几百 KB 的整表，30 分钟足够新鲜
PANEL_TTL = 30 * 60
#: 单次请求最多解析多少个 token（前端一次一批；防有人拿它当探测接口刷上游）
MAX_TOKENS = 200

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
_HEADERS = {"Referer": "https://www.bilibili.com/", "User-Agent": _UA}

#: 一次拿整表的两条路：全局动态包（匿名可拿）+ 用户面板（要登录态，多出自己收藏的包）
_PANEL_URL = "https://api.bilibili.com/x/emote/user/panel/web"
_GLOBAL_URL = "https://api.bilibili.com/x/emote/package"

#: `UPOWER_<uid>_<名>` / `UP_<uid>_<名>`：前缀是**发帖人**的 uid，不是表情名的一部分
_UID_PREFIX = re.compile(r"^UP(?:OWER)?_\d+_(.+)$")

_cache: dict[str, object] = {"at": 0.0, "index": {}}


def normalize_candidates(token: str) -> list[str]:
    """一个 token 的**候选名**（按优先级）：原样 → 去掉 uid 前缀 → 下划线后半段。

    ⚠️ 顺序有意义：`UPOWER_1203217682_贴贴` 的原样在表里**一定**查不到（表里只有 `贴贴`），
    但先试原样零成本，而且少数包名里真的带下划线（`doge_金箍`）—— 那种必须原样命中。
    """
    out = [token]
    m = _UID_PREFIX.match(token)
    if m:
        out.insert(0, m.group(1))
    if "_" in token:
        out.append(token.split("_", 1)[1])
    # 去重且保序
    seen: set[str] = set()
    return [c for c in out if c and not (c in seen or seen.add(c))]


def build_index(packages: list[dict]) -> dict[str, str]:
    """`[{emote: [{text, url}]}]` → `{名: url}`（纯函数，便于用假数据验证）。

    表里的 `text` 形如 `[doge_金箍]`（**带方括号**），我们的 token 不含方括号 ⇒ 两边都剥掉。
    """
    index: dict[str, str] = {}
    for pkg in packages or []:
        for face in (pkg or {}).get("emote") or []:
            name = str(face.get("text") or "").strip().strip("[]")
            url = face.get("url") or ""
            if name and url:
                index.setdefault(name, url)
    return index


def resolve(tokens: list[str], index: dict[str, str]) -> dict[str, str]:
    """token → 图片地址（查不到的**不出现在结果里**，由调用方走 chip 兜底）。"""
    out: dict[str, str] = {}
    for tok in tokens:
        for cand in normalize_candidates(tok):
            url = index.get(cand)
            if url:
                out[tok] = url
                break
    return out


async def _fetch_packages(url: str, params: dict, cookie: str | None) -> list[dict]:
    import httpx

    headers = dict(_HEADERS)
    if cookie:
        headers["Cookie"] = cookie
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(url, params=params, headers=headers)
        body = r.json()
    if body.get("code") != 0:
        raise RuntimeError(f"上游 code={body.get('code')} {str(body.get('message'))[:40]}")
    return (body.get("data") or {}).get("packages") or []


async def emote_index(force: bool = False) -> tuple[dict[str, str], str | None]:
    """整表索引（带缓存）。返回 `(索引, 失败原因或 None)` —— **从不抛错**。

    为什么要两条路合起来：全局动态包匿名就有（225 个），但**本机账号收藏的那些包**
    （实测 431 个，含 `明前奶绿收藏集表情包_*`）只在鉴权那条路上 —— 少一条就少一半解析率。
    """
    now = time.time()
    if not force and _cache["index"] and now - float(_cache["at"]) < PANEL_TTL:
        return _cache["index"], None  # type: ignore[return-value]

    from app.services.auth import auth_manager

    errors: list[str] = []
    packages: list[dict] = []
    for label, url, params, cookie in (
        ("全局动态包", _GLOBAL_URL, {"business": "dynamic", "ids": 1}, None),
        ("用户面板", _PANEL_URL, {"business": "dynamic"}, auth_manager.cookie_str),
    ):
        try:
            packages += await _fetch_packages(url, params, cookie)
        except Exception as e:  # noqa: BLE001 —— 上游怎么坏都不该让正文渲染失败
            errors.append(f"{label}: {e}")
            logger.warning("[emote] %s 拉取失败：%s", label, e)

    index = build_index(packages)
    if index:
        _cache["index"] = index
        _cache["at"] = now
    return index, ("；".join(errors) if errors else None)
