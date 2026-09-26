"""标题文本的纯函数（M1a：从 `services/live_type.py` 下沉，devlog/213）。

**这里不许有任何 IO**（见 `app/domain/__init__.py` 的分层规矩）：
`live_type`（服务层，做分类推断）与 `repositories`（仓库层，做场次合并）都要用它，
所以它的家只能在两者**下面**。
"""
from __future__ import annotations

import re

# 标题骨架清洗：仅剥离日期/时间/序号词汇，保留主题词（【歌回】周一 → 歌回）
_SKELETON_STRIP_RE = re.compile(
    r"第\d+[期场回次弹]|"
    r"\d{4}年\d{1,2}月\d{1,2}(?:日|号)?|"
    r"\d{1,2}月\d{1,2}(?:日|号)?|"
    r"\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|"
    r"\d{1,2}:\d{2}|"
    r"\d{1,2}点(?:半)?|"
    r"周[一二三四五六日天]|星期[一二三四五六日天]|\d+"
)
# 骨架仅保留中日韩 + 字母数字
_SKELETON_KEEP_RE = re.compile(r"[\u4e00-\u9fffa-z0-9]")


def normalize_title(title: str | None) -> str:
    """标题 → 系列骨架：剥离日期/时间/序号/标点/emoji，只留主题词。

    「【歌回】周一 XX:00 第12期」 → 「歌回」；「晚上好！」 → 「晚上好」。
    骨架过短（<2 字符）或无内容 → ""（不参与系列）。
    """
    t = (title or "").strip().lower()
    if not t:
        return ""
    t = _SKELETON_STRIP_RE.sub("", t)
    return "".join(_SKELETON_KEEP_RE.findall(t))
