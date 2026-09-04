"""帖子正文纯文本提取 — P2 全文搜索深度升级

从 `posts.body_json` 提取可检索的纯文本（新列 `posts.body_text`）。
写入路径（scheduler 两个 _flush_pending、路由 create_post）与存量回填脚本
（scripts/backfill_post_body_text.py）共用本模块，保证单一语义。

文本来源优先级（按 body_json 实际形态，见 fetcher.py / platforms/weibo.py：
- text        纯文本（B站动态 full_text / OPUS 富文本 delta_text / 微博正文）
- content     富文本 HTML（B站图文 detail 的 content、专栏全文）→ 剥标签 + 实体反转义
- description 视频简介（B站 video 投稿 / video_dynamic extras）
- origin.text 转发原文（repost / 微博 retweeted_status）换行叠加
归一化：压缩连续空白；空串 → None；解析失败 → None（容错风格同 _safe_json_parse）。
"""
import html
import json
import re

# HTML 剥标签：换行元素保底断行（专栏正文用 <p> 分段）
_BLOCK_TAGS_RE = re.compile(r"(?i)</?(?:p|br|div|li|tr|h[1-6]|blockquote)[^>]*>")
_ANY_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"[ \t\f\v]+")
_MULTI_NEWLINE_RE = re.compile(r"\n{3,}")


def _strip_html(src: str) -> str:
    """粗粒度富文本 → 纯文本：换行标签 → \\n，残余标签剔除，实体反转义。"""
    src = _BLOCK_TAGS_RE.sub("\n", src)
    src = _ANY_TAG_RE.sub("", src)
    src = html.unescape(src)
    return src


def _normalize(src: str) -> str | None:
    src = _MULTI_NEWLINE_RE.sub("\n\n", src)
    src = _WHITESPACE_RE.sub(" ", src).strip()
    return src or None


def extract_post_text(body_json: str | None) -> str | None:
    """从 body_json（JSON 字符串）提取纯文本；无法解析/无文本 → None。"""
    if not body_json:
        return None
    try:
        body = json.loads(body_json)
    except (ValueError, TypeError):
        return None
    if not isinstance(body, dict):
        return None

    parts: list[str] = []
    for key in ("text", "content", "description"):
        v = body.get(key)
        if isinstance(v, str) and v.strip():
            text = _strip_html(v) if key == "content" else v.strip()
            if text:
                parts.append(text)
        if parts:
            break  # 优先级：首个有文本的来源即可

    origin = body.get("origin")
    if isinstance(origin, dict):
        ov = origin.get("text")
        if isinstance(ov, str) and ov.strip():
            parts.append(ov.strip())

    if not parts:
        return None
    return _normalize("\n".join(parts))
