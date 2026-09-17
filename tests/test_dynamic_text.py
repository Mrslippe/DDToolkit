# -*- coding: utf-8 -*-
"""B 站动态的标题 / 正文提取口径（2026-09-17，devlog/143）。

起因是用户截图：弥月那条置顶动态在列表里的标题是 **`cv409088396`**、摘要只有一个 `[9P]`。
去库里查真数据（devlog/143 §一）确认了两层根因，本文件把**后端那一层**钉住：

1. `_extract_dynamic_title` 原来对**任何** major 类型都用 `data["id"]` 拼 `cv<id>` 当标题 ——
   而 DRAW/OPUS 的 `data.id` 是 opus/专栏 id，不是标题 ⇒ 标题变成一串 cv 号。
   口径：**只有专栏（ARTICLE）**才用 `cv<id>` 兜底；其余类型没有标题就返回空串，
   由展示侧从 `body_json.text` 取正文首行。
2. `_extract_dynamic_text` 对 DRAW 返回 `[<n>P]`（图片张数）当正文 ⇒ 摘要变成「[9P]」。
   口径：**只有 title 才算正文**，张数是结构信息（`body_json.images` 里本来就有）。
"""
from app.services.fetcher import _extract_dynamic_text, _extract_dynamic_title


def _opus(text: str = "", title: str = "") -> dict:
    data: dict = {"summary": {"text": text}}
    if title:
        data["title"] = title
    return {"type": "MAJOR_TYPE_OPUS", "opus": data}


def _draw(title: str = "", items: int = 9, aid: int | None = None) -> dict:
    data: dict = {"items": [{"url": f"http://x/{i}.png"} for i in range(items)]}
    if title:
        data["title"] = title
    if aid is not None:
        data["id"] = aid
    return {"type": "MAJOR_TYPE_DRAW", "draw": data}


def _article(aid: int = 409088396, summary: str = "正文摘要") -> dict:
    return {"type": "MAJOR_TYPE_ARTICLE",
            "article": {"id": aid, "summary": summary, "title": ""}}


# ── 标题：只有专栏才用 cv 号兜底 ─────────────────────────────────────

def test_draw_without_title_does_not_fake_a_cv_title():
    """回归（用户截图）：图文动态的 `data.id` 不是标题 —— 不许再拼 `cv<id>`。"""
    assert _extract_dynamic_title(_draw(aid=409088396)) == ""


def test_draw_with_title_keeps_title():
    assert _extract_dynamic_title(_draw(title="本周周表")) == "本周周表"


def test_opus_without_title_is_empty():
    assert _extract_dynamic_title(_opus(text="正文")) == ""


def test_opus_with_title_keeps_title():
    assert _extract_dynamic_title(_opus(text="正文", title="标题")) == "标题"


def test_article_falls_back_to_cv_id():
    """专栏没有标题时，`cv<id>` 是它唯一可读的标识 —— 这条兜底要留着。"""
    assert _extract_dynamic_title(_article(aid=123)) == "cv123"


def test_article_with_title_prefers_title():
    major = _article(aid=123)
    major["article"]["title"] = "侵权声明"
    assert _extract_dynamic_title(major) == "侵权声明"


def test_title_is_stripped_and_capped():
    assert _extract_dynamic_title(_draw(title="  空格  ")) == "空格"
    assert len(_extract_dynamic_title(_draw(title="长" * 900))) == 500


# ── 正文：`[nP]` 不是正文 ───────────────────────────────────────────

def test_draw_text_is_title_only_never_the_picture_count():
    """回归：`[9P]` 曾被当正文存成摘要（卡片第二行只有一个「[9P]」）。"""
    assert _extract_dynamic_text(_draw(items=9)) == ""
    assert _extract_dynamic_text(_draw(title="周表", items=9)) == "周表"


def test_opus_text_comes_from_summary_text():
    assert _extract_dynamic_text(_opus(text="真正文")) == "真正文"


def test_article_text_comes_from_summary():
    assert _extract_dynamic_text(_article(summary="专栏摘要")) == "专栏摘要"


def test_common_major_uses_desc_text():
    assert _extract_dynamic_text({"type": "MAJOR_TYPE_COMMON", "common": {}},
                                 desc_text="转发附言") == "转发附言"