# -*- coding: utf-8 -*-
"""B站裸 fMP4 的**段表**（2026-10-04，devlog/311；MSE spike 的第一步）。

## 为什么要它

真机七次复现指向同一件事（`devlog/310`）：**seek 之后 Chromium 有一段"解码追赶"**
（曲线里第 1 秒爆发 153 帧、随后 2–4 秒一帧不出），而数据、时钟、音频全都正常。
根因是**裸 fMP4 + `src=` 直喂**：Chromium 的 MP4 demuxer 不读 `sidx`，
"跳到第 N 秒"只能按码率猜字节位置、再从关键帧解码丢弃到目标。

`docs/plans/bili-mse-kernel-execution.md` 的 S1 就是验证"MSE 能不能根治"，
而 MSE 的前提是**时间 → 字节**的映射 —— 那份映射就在流开头的 `sidx` 里。

## 实测到的结构（一条 1080P 视频）

```
ftyp 36B | moov 912B | sidx 680B | moof 1,900B | mdat 1,567,961B | …
sidx: v0 / reference_ID=1 / timescale=16000 / EPT=0 / first_offset=0
      reference_count=54，每条 12 字节 = [size][duration][SAP]
      第一条：size=1,569,861（正好等于紧随其后的 moof+mdat）、duration=80,000 ticks = **5.0s**
      ⇒ 54 × 5s ≈ 270s ≈ 片长 265s，且每条都从关键帧开始
```

⇒ **init 段** = `ftyp`+`moov`（前 948 字节）；**媒体段**从 `sidx` 之后开始，按表切。
"""
from __future__ import annotations

import logging
import struct
import time

import httpx

from app.core.http import new_async_client
from app.routers.video_proxy import _host_of, is_allowed_url, policy_for

logger = logging.getLogger(__name__)

#: 头部取多少（ftyp+moov+sidx 实测 <2KB；给足余量，且大了也只多一次小请求）
HEAD_BYTES = 64 * 1024
#: 段表缓存：地址是短时效的（见 `bili_play`），缓存久了会拿到过期 URL
CACHE_TTL = 110.0

_cache: dict[str, tuple[dict, float]] = {}


class SegmentsError(RuntimeError):
    """拿不到段表（网络/结构不认识）。**如实说明**，别假装有表。"""

    def __init__(self, message: str, *, kind: str = "failed"):
        super().__init__(message)
        self.message = message
        self.kind = kind          # failed / no_sidx / upstream


def _u16(b: bytes, off: int) -> int:
    return struct.unpack(">H", b[off:off + 2])[0]


def _u32(b: bytes, off: int) -> int:
    return struct.unpack(">I", b[off:off + 4])[0]


def _u64(b: bytes, off: int) -> int:
    return struct.unpack(">Q", b[off:off + 8])[0]


def walk_boxes(buf: bytes, limit: int = 32) -> list[tuple[str, int, int]]:
    """顺序走盒子：返回 `[(type, size, offset)]`（size 为 0/1 按 ISO 规则处理）。"""
    out: list[tuple[str, int, int]] = []
    off = 0
    while off + 8 <= len(buf) and len(out) < limit:
        size = _u32(buf, off)
        btype = buf[off + 4:off + 8].decode("latin-1")
        header = 8
        if size == 1 and off + 16 <= len(buf):
            size = _u64(buf, off + 8)
            header = 16
        elif size == 0:
            size = len(buf) - off
        out.append((btype, size, off))
        if size < header:
            break
        off += size
    return out


def parse_sidx(body: bytes, box_len: int) -> dict | None:
    """解析 `sidx` 的**负载**（不含 8 字节盒子头）。

    返回 `{timescale, first_offset, entries:[{size,dur,sap}]}`；结构对不上返回 None。
    ⚠️ 判据是**算术自洽**而不是"版本号说该是几字节"：`版本字段` 与实测布局在真数据上
    并不总是一致（我们这条流 v0 但按 v0 读出来的 count 与盒长对不上），
    而 `盒头 + 固定字段 + count×12 == 盒长` 这条**唯一确定**该用哪种布局。
    """
    if len(body) < 16:
        return None
    version = body[0] >> 24
    for ept_size in ((8 if version == 1 else 4), (4 if version == 1 else 8)):
        # 固定字段（count **之前**）：ver/flags + reference_ID + timescale + EPT + first_offset + reserved
        # ⚠️ 别漏 timescale 那 4 字节（第一版就漏了，count 读成 0 ⇒ 整条流被判成"没有表"）
        fixed = 4 + 4 + 4 + ept_size + ept_size + 2
        if fixed + 2 > len(body):
            continue
        count = _u16(body, fixed)
        if 8 + fixed + 2 + count * 12 != box_len:     # 盒长必须**正好**装下这些条目
            continue
        timescale = _u32(body, 8)
        first_offset = _u64(body, 12 + ept_size) if ept_size == 8 else _u32(body, 12 + ept_size)
        entries = []
        p = fixed + 2
        for _ in range(count):
            w1 = _u32(body, p)
            dur = _u32(body, p + 4)
            w3 = _u32(body, p + 8)
            entries.append({"size": w1 & 0x7FFFFFFF, "dur": dur,
                            "sap": bool(w3 >> 31)})
            p += 12
        return {"timescale": timescale or 1, "first_offset": first_offset, "entries": entries}
    return None


def segment_table(head: bytes, *, total_bytes: int | None = None) -> dict:
    """头部字节 → 段表（**纯函数**，可单测）。

    `start`/`end` 都是**闭区间字节偏移**（给 `Range: bytes=start-end` 用）。
    """
    boxes = walk_boxes(head)
    types = [b[0] for b in boxes]
    if "moov" not in types:
        raise SegmentsError("头部里没有 moov（拿到的字节不够？）", kind="failed")
    if "sidx" not in types:
        raise SegmentsError("这条流没有 sidx ⇒ 做不了按时间取段（MSE 不成立）", kind="no_sidx")

    moov = next(b for b in boxes if b[0] == "moov")
    sidx = next(b for b in boxes if b[0] == "sidx")
    init_end = moov[2] + moov[1] - 1                      # init = ftyp+moov（含）
    box_len = sidx[1]
    body = head[sidx[2] + 8: sidx[2] + box_len]
    parsed = parse_sidx(body, box_len)
    if parsed is None:
        raise SegmentsError("sidx 结构不认识（盒长与条目数对不上）", kind="no_sidx")

    offset = sidx[2] + box_len + parsed["first_offset"]
    ts = parsed["timescale"]
    segments = []
    for i, e in enumerate(parsed["entries"]):
        end = offset + e["size"] - 1
        segments.append({"i": i, "start": offset, "end": end,
                         "dur_s": round(e["dur"] / ts, 3), "sap": e["sap"]})
        offset = end + 1
    return {
        "init": {"start": 0, "end": init_end},
        "sid": {"start": sidx[2], "end": sidx[2] + box_len - 1},
        "timescale": ts,
        "segments": segments,
        "duration_s": round(sum(s["dur_s"] for s in segments), 2),
        "total_bytes": total_bytes,
        "covers_total": (total_bytes is None or offset == total_bytes),
        "box_types": types[:8],
    }


async def fetch_table(url: str, *, client: httpx.AsyncClient | None = None) -> dict:
    """取某个流（视频或音轨）的段表（带短缓存）。

    ⚠️ 地址是**短时效**的（`bili_play` 那边 120s 缓存），所以这里的缓存也要短（`CACHE_TTL`），
    过期就重取 —— 不然会把过期签名当"段不存在"用。
    """
    hit = _cache.get(url)
    if hit and time.monotonic() - hit[1] < CACHE_TTL:
        return hit[0]
    if not is_allowed_url(url):
        raise SegmentsError(f"这个主机不在白名单里：{_host_of(url)}", kind="failed")
    headers = {"Range": f"bytes=0-{HEAD_BYTES - 1}"}
    headers.update(policy_for(_host_of(url)))
    own = client is None
    if own:
        client = new_async_client(20.0)
    try:
        resp = await client.get(url, headers=headers)
        if resp.status_code >= 400:
            raise SegmentsError(f"取头部失败：HTTP {resp.status_code}", kind="upstream")
        total = None
        cr = resp.headers.get("content-range") or ""
        if "/" in cr:
            try:
                total = int(cr.rsplit("/", 1)[1])
            except ValueError:
                total = None
        table = segment_table(resp.content, total_bytes=total)
    finally:
        if own:
            await client.aclose()
    table["url"] = url                       # 调用方要用它拼 Range 请求（不落库、不进日志）
    _cache[url] = (table, time.monotonic())
    logger.info(f"段表 {_host_of(url)} 段数={len(table['segments'])} "
                f"段长≈{table['segments'][0]['dur_s'] if table['segments'] else '?'}s "
                f"总时长≈{table['duration_s']}s init={table['init']['end'] + 1}B")
    return table


def clear_cache() -> None:
    _cache.clear()
