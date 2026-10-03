# -*- coding: utf-8 -*-
"""段表解析（`app/services/bili_segments.py`，devlog/311）的判据。

**用真机抓下来的字节**当锚点：这些数字（moov 912B / sidx 680B / 54 段 / 每条 5.0s /
第一条 1,569,861B）是 2026-10-04 从一条 1080P 流上量出来的，改解析器时它们会先红。
"""
import httpx
import pytest

from app.services import bili_segments as seg


def _box(btype: str, payload: bytes) -> bytes:
    """按 ISO 规则造盒子：**size 字段含 8 字节头**（第一版漏了，整批用例的偏移全歪）。"""
    return (8 + len(payload)).to_bytes(4, "big") + btype.encode("latin-1") + payload


def _sidx_body(*, timescale: int, entries: list[tuple[int, int]], version: int = 0,
               first_offset: int = 0) -> bytes:
    head = bytearray()
    head += bytes([version, 0, 0, 0])
    head += (1).to_bytes(4, "big")                      # reference_ID
    head += timescale.to_bytes(4, "big")
    if version == 1:
        head += (0).to_bytes(8, "big") + first_offset.to_bytes(8, "big")
    else:
        head += (0).to_bytes(4, "big") + first_offset.to_bytes(4, "big")
    head += (0).to_bytes(2, "big")                      # reserved
    head += len(entries).to_bytes(2, "big")
    for size, dur in entries:
        head += size.to_bytes(4, "big") + dur.to_bytes(4, "big")
        head += (1 << 31).to_bytes(4, "big")            # starts_with_SAP
    return bytes(head)


def test_parse_sidx_reads_the_real_shape():
    """真机那条：timescale=16000、54 条、每条 80,000 ticks = **5.0s**、第一条 1,569,861B。"""
    body = _sidx_body(timescale=16000,
                      entries=[(1_569_861, 80_000)] * 54)
    box_len = 8 + len(body)
    got = seg.parse_sidx(body, box_len)
    assert got is not None
    assert got["timescale"] == 16000
    assert len(got["entries"]) == 54
    assert got["entries"][0] == {"size": 1_569_861, "dur": 80_000, "sap": True}
    assert got["entries"][0]["dur"] / got["timescale"] == 5.0


def test_parse_sidx_rejects_when_count_does_not_fit_the_box():
    """**算术自洽**是唯一判据：说 54 条但盒长只装得下 3 条 ⇒ 拒绝，不要瞎读。

    为什么不用"版本号说该几字节"：真数据上 v0 的字段宽度与标准并不总一致；
    而 `盒头 + 固定字段 + count×12 == 盒长` 这条是硬的。
    """
    body = _sidx_body(timescale=16000, entries=[(1000, 80_000)] * 3)
    assert seg.parse_sidx(body, 8 + len(body)) is not None
    assert seg.parse_sidx(body, 8 + len(body) - 12) is None      # 盒长少一条


def test_segment_table_maps_time_to_bytes():
    """段表要给出**闭区间**的 init 与逐段字节范围，且与总字节数对得上。"""
    ftyp = _box("ftyp", b"iso5" + b"\x00" * 24)                  # 36B（与真机一致）
    moov = _box("moov", b"\x00" * 904)                           # 912B
    entries = [(1_569_861, 80_000)] * 4
    sidx = _box("sidx", _sidx_body(timescale=16000, entries=entries))
    head = ftyp + moov + sidx
    total = len(head) + sum(s for s, _ in entries)

    t = seg.segment_table(head, total_bytes=total)
    assert t["init"] == {"start": 0, "end": 36 + 912 - 1}         # ftyp+moov
    assert t["sid"] == {"start": 36 + 912, "end": 36 + 912 + len(sidx) - 1}
    assert len(t["segments"]) == 4
    first = t["segments"][0]
    assert first["start"] == 36 + 912 + len(sidx)                 # 紧跟 sidx
    assert first["end"] - first["start"] + 1 == 1_569_861
    assert first["dur_s"] == 5.0 and first["sap"] is True
    # 逐段相接、最后一段正好到文件末尾
    assert t["segments"][1]["start"] == first["end"] + 1
    assert t["segments"][-1]["end"] + 1 == total
    assert t["covers_total"] is True
    assert t["duration_s"] == 20.0


def test_segment_table_says_so_when_there_is_no_sidx():
    """**没有 sidx 就明说**（`no_sidx`）—— MSE 方案的前提不成立，别假装有表。"""
    ftyp = _box("ftyp", b"iso5" + b"\x00" * 28)
    moov = _box("moov", b"\x00" * 904)
    with pytest.raises(seg.SegmentsError) as ei:
        seg.segment_table(ftyp + moov)
    assert ei.value.kind == "no_sidx"
    assert "sidx" in ei.value.message


def test_segment_table_says_so_when_head_is_truncated():
    """头部不够（连 moov 都没凑齐）⇒ 如实报 failed，别产出一张空表。"""
    with pytest.raises(seg.SegmentsError) as ei:
        seg.segment_table(_box("ftyp", b"iso5"))
    assert ei.value.kind == "failed"


def test_walk_boxes_handles_64bit_sizes():
    """`size == 1` 时后面 8 字节是 largesize（ISO 规则，别只读 4 字节）。"""
    payload = b"\x00" * 8                       # 4+4+8+8 = 24 = 声明的 largesize
    big = (1).to_bytes(4, "big") + b"mdat" + (24).to_bytes(8, "big") + payload
    assert seg.walk_boxes(big) == [("mdat", 24, 0)]


# ── S2：把段表交给 MSE 内核（`stream_tables`，devlog/312）─────────────────────

def test_mime_of_builds_the_exact_codecs_string():
    """MSE 认的是 `video/mp4; codecs="avc1.640033"` **整串**（纯容器类型在真 append 时才炸）。

    缺 codecs 时**不猜**：只回容器类型，让上层的 `isTypeSupported` 判定"不支持"⇒ 退渐进式。
    """
    assert seg.mime_of({"mime": "video/mp4", "codecs": "avc1.640033"}, "video") \
        == 'video/mp4; codecs="avc1.640033"'
    assert seg.mime_of({"mime": "audio/mp4", "codecs": "mp4a.40.2"}, "audio") \
        == 'audio/mp4; codecs="mp4a.40.2"'
    # 上游已经带 codecs 就别叠第二份（叠了 isTypeSupported 直接 false）
    assert seg.mime_of({"mime": 'video/mp4; codecs="avc1"', "codecs": "avc1"}, "video") \
        == 'video/mp4; codecs="avc1"'
    # 没给容器类型 ⇒ 按轨道类型兜；没给 codecs ⇒ 如实只给容器
    assert seg.mime_of({}, "audio") == "audio/mp4"
    assert seg.mime_of({"mime": "video/mp4"}, "video") == "video/mp4"


def _play_payload(video_urls=("https://cn-x.bilivideo.com/v.m4s", "https://up-y.bilivideo.com/v.m4s"),
                  audio_urls=("https://cn-x.bilivideo.com/a.m4s",)):
    def stream(urls, codecs):
        return {"base_url": urls[0], "urls": list(urls), "codecs": codecs,
                "mime": "video/mp4" if "/v." in urls[0] else "audio/mp4"}
    return {"dash": {"video": [stream(video_urls, "avc1.640033")],
                     "audio": [stream(audio_urls, "mp4a.40.2")]}}


def _head_of(seg_count=4, size=1000):
    ftyp = _box("ftyp", b"iso5" + b"\x00" * 24)
    moov = _box("moov", b"\x00" * 904)
    sidx = _box("sidx", _sidx_body(timescale=16000, entries=[(size, 80_000)] * seg_count))
    return ftyp + moov + sidx, len(ftyp) + len(moov) + len(sidx) + size * seg_count


class _HeadClient:
    """假客户端：按 URL 给不同头部（**音轨那条故意短一半**，用来钉"取长的时长"）。"""

    def __init__(self, video_segs=4, audio_segs=2, fail_on=()):
        self.video_segs, self.audio_segs, self.fail_on = video_segs, audio_segs, fail_on
        self.calls: list[str] = []

    async def get(self, url, headers=None):
        self.calls.append(url)
        if any(f in url for f in self.fail_on):
            raise _Boom()
        n = self.audio_segs if "/a." in url else self.video_segs
        head, total = _head_of(n)
        return _HeadResp(head, total)

class _HeadResp:
    def __init__(self, content, total):
        self.content, self.status_code = content, 200
        self.headers = {"content-range": f"bytes 0-{len(content) - 1}/{total}"}


class _Boom(httpx.HTTPError):
    """网络失败（真实现里 `httpx` 抛的就是它这一类）。"""

    def __init__(self):
        super().__init__("boom")


@pytest.fixture(autouse=True)
def _clean_cache():
    """段表有 110s 缓存 ⇒ 用例之间必须清（否则第二条拿到上一条的表，判据假绿）。"""
    seg.clear_cache()
    yield
    seg.clear_cache()


def test_stream_tables_gives_both_tracks_and_takes_the_longer_duration():
    """两条流各一张表；`duration_s` 取**长的**（音轨结尾补齐方式不同，取短的会被截尾）。"""
    import asyncio

    c = _HeadClient(video_segs=4, audio_segs=2)
    out = asyncio.run(seg.stream_tables(_play_payload(), client=c))

    assert out["video"]["mime"] == 'video/mp4; codecs="avc1.640033"'
    assert out["audio"]["mime"] == 'audio/mp4; codecs="mp4a.40.2"'
    assert len(out["video"]["segments"]) == 4 and len(out["audio"]["segments"]) == 2
    assert out["duration_s"] == out["video"]["duration_s"] == 20.0
    # 镜像链要一起带下去：段取不到时前端才能自己换下一条（不必回后端）
    assert out["video"]["urls"] == ["https://cn-x.bilivideo.com/v.m4s",
                                    "https://up-y.bilivideo.com/v.m4s"]


def test_stream_tables_falls_back_to_the_next_mirror():
    """首选镜像取不到 ⇒ **换下一条**（B站 `baseUrl` 常是 P2P 主机，实测见 `bili_play`）。"""
    import asyncio

    c = _HeadClient(fail_on=("cn-x.bilivideo.com/v.m4s",))
    out = asyncio.run(seg.stream_tables(_play_payload(), client=c))
    assert out["video"]["url"] == "https://up-y.bilivideo.com/v.m4s", \
        "没有换镜像就是拿不到表就退渐进式"


def test_stream_tables_needs_both_tracks():
    """**音轨没有表 ⇒ 整条路不成立**：视频走 MSE、音轨还是独立 `<audio>` 就是两个钟（旧病）。"""
    import asyncio

    c = _HeadClient(fail_on=("cn-x.bilivideo.com/a.m4s",))
    with pytest.raises(seg.SegmentsError) as ei:
        asyncio.run(seg.stream_tables(_play_payload(), client=c))
    assert ei.value.kind == "upstream", "音轨取不到要**如实**说是上游的问题，别说成结构不认识"

    with pytest.raises(seg.SegmentsError):
        asyncio.run(seg.stream_tables({"dash": {"video": []}}, client=c))

