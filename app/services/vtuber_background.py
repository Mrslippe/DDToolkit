"""V 卡片页自定义背景的落盘（M3b，批次 11b，devlog/214）。

改前的实现只有三行，而且顺序是**先删旧文件、再写新文件**
（`routers/vtuber.py:218-221`）：写新文件失败（磁盘满 / 权限 / 断电）就把用户原来的
背景弄丢了，而 DB 里还指着那个已经不存在的路径 ⇒ 卡片页背景变空白且**无法恢复**。
本模块把这一段收成三个可判据的不变量：

  ① **限额在"读"的时候生效**：原来是 `await file.read()` 全量进内存**之后**才判 10MB
     —— 一个 2GB 的上传会先把内存吃满。现在按块读、超限立刻停（有 `size` 时连读都不读）；
  ② **按文件头判类型**：`content_type` 是客户端声明的，改个扩展名就能把 HTML 存成 .jpg
     再由 `/static` 原样吐出来。内容说了算；声明与内容**矛盾**时拒绝（吵闹的失败）；
  ③ **先写临时文件 → 原子 rename**，旧文件由**调用方在 DB 提交成功之后**才删：
     任何一步失败，旧背景（文件 + DB 里的路径）都原样还在，且不留临时文件。
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

logger = logging.getLogger(__name__)

#: 单张背景上限（与前端提示、413 文案保持一致）
MAX_BYTES = 10 * 1024 * 1024
#: 读块大小（流式读取的粒度）
CHUNK_BYTES = 64 * 1024
#: 临时文件后缀（与最终文件同目录 ⇒ `os.replace` 才是原子的）
TMP_SUFFIX = ".uploading"
#: 相对路径前缀（前端与 `/static` 挂载点认它）
REL_PREFIX = "static/custom_bg"

#: 文件头 → 扩展名
_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)

#: 客户端声明的 content-type → 它"应该"是什么内容（声明只是提示，矛盾时才用得上）
DECLARED_ALIASES = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",       # 非标准写法，浏览器里真实存在
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}


class BackgroundTooLarge(Exception):
    """超过 `MAX_BYTES`（路由映射成 413）。"""


class BackgroundUnsupported(Exception):
    """不是受支持的图片（路由映射成 415）。"""


def sniff_image(head: bytes) -> str | None:
    """文件头 → 扩展名；认不出来返回 None（含 webp：`RIFF....WEBP`）。"""
    for magic, ext in _MAGIC:
        if head.startswith(magic):
            return ext
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def _open_for_write(path: Path):
    """写临时文件的**唯一入口**。

    留成一个函数是为了让"写盘失败"能被**真的注入**（批次 11b 的判据要求：
    别只测 happy path —— 这条不变量本来就是"写失败时旧背景不许丢"）。
    """
    return path.open("wb")


def remove_background(custom_dir: Path, rel_path: str) -> bool:
    """删掉一个背景文件，返回是否真的删掉了。

    **只取文件名**：库里的 `background_path` 不该能指到 `custom_bg/` 之外。
    失败只记日志、不抛 —— 背景是纯展示资源，删不掉最多留个孤儿文件，
    不该把整个请求打成 500（也不要盖掉调用方正在处理的原始异常）。
    """
    name = Path(rel_path).name
    if not name:
        return False
    try:
        (custom_dir / name).unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError as e:
        logger.warning(f"背景文件删除失败（留下孤儿文件 {name}）: {type(e).__name__}: {e}")
        return False


async def save_background(vtuber_id: int, upload, custom_dir: Path, *,
                          now_ms: int | None = None) -> str:
    """流式读 + 魔数校验 + 原子落盘；返回相对路径 `static/custom_bg/<name>`。

    失败（超限 / 类型不支持 / 写盘出错）时**抛异常且不留任何文件**（临时文件也清掉）。
    **旧文件不归它管**：调用方要等 DB 提交成功之后才删（见模块头部 ③）。
    """
    size = getattr(upload, "size", None)
    if isinstance(size, int) and size > MAX_BYTES:
        raise BackgroundTooLarge()          # 有 Content-Length 就先拒，一个字节都不读

    custom_dir.mkdir(parents=True, exist_ok=True)
    tmp = custom_dir / f".{vtuber_id}{TMP_SUFFIX}"
    head = b""
    total = 0
    try:
        fh = _open_for_write(tmp)
        try:
            while True:
                chunk = await upload.read(CHUNK_BYTES)
                if not chunk:
                    break
                if len(head) < 16:
                    head = (head + chunk)[:16]
                total += len(chunk)
                if total > MAX_BYTES:
                    raise BackgroundTooLarge()
                fh.write(chunk)
        finally:
            fh.close()

        ext = sniff_image(head)
        if ext is None:
            raise BackgroundUnsupported("不是有效的 jpeg / png / webp / gif")
        declared = DECLARED_ALIASES.get((upload.content_type or "").lower())
        if declared and declared != ext:
            raise BackgroundUnsupported(f"文件内容像 {ext}，但声明是 {declared}")

        final = custom_dir / f"{vtuber_id}_{now_ms or int(time.time() * 1000)}.{ext}"
        os.replace(tmp, final)              # 同目录 rename ⇒ 原子
        return f"{REL_PREFIX}/{final.name}"
    except BaseException:
        remove_background(custom_dir, f".{vtuber_id}{TMP_SUFFIX}")
        raise
