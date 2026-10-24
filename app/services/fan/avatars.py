"""头像抓取：连接池 + face 缓存 + 后台预热。

## 为什么要单独一个模块

2026-10-24 实测：**缓存命中 5.4 ms/个**，**冷启动 466–726 ms/个**。冷启动的三段开销是

1. 每个请求新建 `httpx.AsyncClient` ⇒ 与 B 站重新 TLS 握手（150–300 ms）；
2. 调 card 接口拿 `face` URL（50–160 ms）；
3. 下载 80px 缩略图（45–70 ms）。

这里把三件事分别收掉：**全局连接池**（省握手）、**uid→face 磁盘缓存**（省第 2 步）、
**后台预热**（用户滚到名单时已经好了）。

## 数据布局

```
<data>/avatars/<uid>.jpg     缩略图（80px，约 1.7–2.5 KB）
<data>/avatars/_face.json    uid → 原始 face URL（避免重复调 card 接口）
```
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

import httpx

from app.core.useragent import UA_CHROME

logger = logging.getLogger(__name__)

CARD_API = "https://api.bilibili.com/x/web-interface/card"
HEADERS = {"User-Agent": UA_CHROME, "Referer": "https://www.bilibili.com/"}
#: 缩略图后缀：原图 230 KB+，80px 只要 ~1.7 KB
THUMB_SUFFIX = "@80w_80h.jpg"

_client: httpx.AsyncClient | None = None
_client_loop: object | None = None
_faces: dict[str, str] | None = None
_face_path: Path | None = None
_lock = asyncio.Lock()
#: 后台预热任务（持有引用，避免被 GC 掉）
_tasks: set[asyncio.Task] = set()


def _client_get() -> httpx.AsyncClient:
    """全局客户端：复用连接，省掉每个头像的 TLS 握手。

    ⚠️ 必须**绑定事件循环**：客户端不能在另一个 loop 里复用，否则报
    `Event loop is closed`（测试里每个请求一个 loop，真机上是同一个）。
    """
    global _client, _client_loop
    loop = asyncio.get_running_loop()
    if _client is not None and (_client_loop is not loop or _client.is_closed):
        _client = None
    if _client is None:
        _client_loop = loop
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(8.0, connect=5.0),
            limits=httpx.Limits(max_connections=16, max_keepalive_connections=8),
            headers=HEADERS,
            trust_env=False,
        )
    return _client


async def aclose() -> None:
    """进程退出时调用（可省略，但显式关掉更干净）。"""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _load_faces(data_dir: Path) -> dict[str, str]:
    global _faces, _face_path
    if _faces is not None:
        return _faces
    _face_path = data_dir / "avatars" / "_face.json"
    try:
        _faces = json.loads(_face_path.read_text(encoding="utf-8"))
        if not isinstance(_faces, dict):
            _faces = {}
    except (OSError, ValueError):
        _faces = {}
    return _faces


def _save_faces() -> None:
    if _faces is None or _face_path is None:
        return
    try:
        _face_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = _face_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(_faces, ensure_ascii=False), encoding="utf-8")
        tmp.replace(_face_path)          # 原子替换，避免半截文件
    except OSError:
        logger.warning("face 缓存写入失败", exc_info=True)


async def get_face(uid: str, data_dir: Path) -> str | None:
    """uid → face URL（先查内存/磁盘缓存，再打 card 接口）。"""
    faces = _load_faces(data_dir)
    if uid in faces:
        return faces[uid]
    try:
        r = await _client_get().get(CARD_API, params={"mid": uid})
        face = (((r.json() or {}).get("data") or {}).get("card") or {}).get("face")
    except (httpx.HTTPError, ValueError):
        return None
    if not face:
        return None
    faces[uid] = face
    _save_faces()
    return face


async def fetch_avatar(uid: str, data_dir: Path) -> tuple[bytes, str] | None:
    """返回 `(图片字节, content-type)`；失败 `None`。命中磁盘缓存则不发任何请求。"""
    cache_dir = data_dir / "avatars"
    cache = cache_dir / f"{uid}.jpg"
    if cache.is_file():
        try:
            return cache.read_bytes(), "image/jpeg"
        except OSError:
            return None

    face = await get_face(uid, data_dir)
    if not face:
        return None
    url = face + THUMB_SUFFIX if face.endswith((".jpg", ".png")) else face
    try:
        r = await _client_get().get(url)
    except httpx.HTTPError:
        return None
    if r.status_code != 200 or not r.content:
        return None
    cache_dir.mkdir(parents=True, exist_ok=True)
    try:
        cache.write_bytes(r.content)
    except OSError:
        logger.warning("头像缓存写入失败 uid=%s", uid)
    return r.content, r.headers.get("content-type", "image/jpeg")


async def _warm(uids: list[str], data_dir: Path, concurrency: int = 6) -> None:
    sem = asyncio.Semaphore(concurrency)

    async def one(uid: str) -> None:
        async with sem:
            try:
                await fetch_avatar(uid, data_dir)
            except Exception:  # noqa: BLE001  预热失败绝不冒泡
                pass

    await asyncio.gather(*(one(u) for u in uids), return_exceptions=True)


def prefetch(uids: list[str], data_dir: Path, *, concurrency: int = 6) -> None:
    """**后台**预热若干头像。不阻塞调用方，失败静默。

    测试环境不预热：`PYTEST_CURRENT_TEST` 存在时直接返回 —— 否则后台任务会在用例
    结束后继续发请求，制造难查的偶发失败。
    """
    if not uids or os.environ.get("PYTEST_CURRENT_TEST"):
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(_warm(uids, data_dir, concurrency))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
