# -*- coding: utf-8 -*-
"""段表解析（`app/services/bili_segments.py`，devlog/311）的判据。

**用真机抓下来的字节**当锚点：这些数字（moov 912B / sidx 680B / 54 段 / 每条 5.0s /
第一条 1,569,861B）是 2026-10-04 从一条 1080P 流上量出来的，改解析器时它们会先红。
"""
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
