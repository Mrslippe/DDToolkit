# -*- coding: utf-8 -*-
"""P2 全文搜索：posts.body_text 提取逻辑测试（app/services/post_text.py）。

覆盖 body_json 各实际形态：B站动态 text / 图文 OPUS content(HTML) /
专栏 delta+text / 视频 description / 转发 origin.text 叠加 /
微博正文 / 无效或空输入容错。
"""
import json

from app.services.post_text import extract_post_text


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


# ── 各类型形态 ──────────────────────────────────────────────────────

def test_bilibili_dynamic_text():
    body = _dump({"text": "今晚八点开播！", "images": []})
    assert extract_post_text(body) == "今晚八点开播！"


def test_weibo_text():
    body = _dump({"text": "转评赞一条龙", "images": ["u"]})
    assert extract_post_text(body) == "转评赞一条龙"


def test_content_html_stripped():
    body = _dump({"content": "<p>第一段<br>换行</p><p>第二段 &amp; 符号</p>", "images": []})
    # </p><p> 段边界 → 双换行（段落分隔），<br> → 单换行
    assert extract_post_text(body) == "第一段\n换行\n\n第二段 & 符号"


def test_article_delta_text_priority():
    """专栏富文本：delta 场景下 text（delta_text）优先于 content(HTML)。"""
    body = _dump({
        "cv_id": 123, "delta": {"ops": []},
        "text": "纯文本版内容", "content": "<p>HTML版内容</p>",
    })
    assert extract_post_text(body) == "纯文本版内容"


def test_video_description():
    body = _dump({"bvid": "BV1", "description": "完整视频简介 很长很长", "duration": "10:00"})
    assert extract_post_text(body) == "完整视频简介 很长很长"


def test_repost_appends_origin():
    """转发动态：附言 + 原文都进检索正文。"""
    body = _dump({"text": "转发理由", "origin": {"text": "原文内容", "title": "原帖"}})
    assert extract_post_text(body) == "转发理由\n原文内容"


def test_repost_without_own_text():
    body = _dump({"text": "", "origin": {"text": "只有原文"}})
    assert extract_post_text(body) == "只有原文"


def test_weibo_origin_image_repost():
    """微博转发图帖：body.text 为转发附言，原文带图无正文 → 只有附言。"""
    body = _dump({"text": "看看这个", "origin": {"type": "image", "images": [{"url": "u"}]}})
    assert extract_post_text(body) == "看看这个"


# ── 容错 ───────────────────────────────────────────────────────────

def test_none_and_empty():
    assert extract_post_text(None) is None
    assert extract_post_text("") is None
    assert extract_post_text("not json") is None
    assert extract_post_text('"just string"') is None
    assert extract_post_text("[]") is None


def test_whitespace_normalized():
    body = _dump({"text": "  连续  空格\t和换行\n\n\n结尾  "})
    assert extract_post_text(body) == "连续 空格 和换行\n\n结尾"


def test_empty_body_dict():
    assert extract_post_text(_dump({"images": []})) is None
