"""弹幕分词与词频统计（2026-09-13，词云自建路径）。

## 为什么需要它

上游 danmakus 的 `/api/v2/live` 原本直接给出预计算好的 `extra.wordCloud`，
但 2026-09-13 实测该字段**整个消失**（见 devlog/060），词云因此静默失效。
原始弹幕仍然公开可取（`/api/v3/lives/{id}/danmakus`，实测单场 5798 条原文），
所以改为**本地自建词云**。

## 扩展点（刻意留出的空间）

分词策略被抽成 `Tokenizer` 协议 + `TOKENIZERS` 注册表，因此后续可以：

1. **换成别的分词器**（pkuseg / thulac / 自训练）→ 实现 `Tokenizer` 后
   `register_tokenizer("pkuseg", PkusegTokenizer())`，再用 `count_tokens(..., engine="pkuseg")`；
   默认引擎挂在 `settings` 上（见 `DEFAULT_ENGINE`），前端与接口都不用改。
2. **加热词/自定义词典** → `JiebaTokenizer.add_words([...])`（把主播名、梗词、舰队名灌进去，
   避免"明前奶绿"被切成"明前/奶绿"）。
3. **加停用词** → `STOPWORDS`（虚词/语气词）与 `MIN_TOKEN_LEN` 已参数化。
4. **加弹幕特化规则**（颜文字、舰队弹幕、复读串）→ 在 `count_tokens` 前插一个
   "文本规范化"步骤即可，计数与排序逻辑不用动。

## 为什么把纯算法与 IO 分开

`iter_texts_from_records()` 只做"记录 → 文本"的提取（纯函数，可单测）；
`fetch_raw_danmakus()` 负责网络。这样分词与计数可以在没有网络的情况下验证 ——
本模块的用例正是这么写的。
"""
from __future__ import annotations

import logging
import re
from collections import Counter
from typing import Callable, Iterable, Protocol

logger = logging.getLogger(__name__)

# ── 可调参数（未来从 settings 暴露时只有这里需要改） ──────────────────
DEFAULT_ENGINE = "jieba"
MIN_TOKEN_LEN = 2          # 单字噪声太多（"的/了/我"），词云里没有信息量
MIN_COUNT = 2              # 只出现一次的词不进词云
TOP_N = 40                 # 与上游 top40 对齐（前端 MosaicCloud 也按 40 设计）

# 虚词/语气词/弹幕高频无信息词。**刻意保守**：只放"几乎不可能有信息量"的，
# 拿不准的一律保留（宁可词云里多一个"哈哈"，也不要误杀真词）。
STOPWORDS: frozenset[str] = frozenset({
    "这个", "那个", "什么", "怎么", "为什么", "可以", "没有", "就是", "不是",
    "还是", "但是", "因为", "所以", "如果", "已经", "现在", "自己", "他们",
    "我们", "你们", "这些", "那些", "一个", "真的", "感觉", "觉得", "应该",
    "可能", "好像", "然后", "而且", "不过", "这样", "那样", "时候", "东西",
    # 2026-09-13 用真实弹幕（泽音 2 场）跑出来再补的一批：都是"在句子里当连接/程度词、
    # 单独看没有信息量"的。**仍然保守** —— "确实/喜欢/晚安"这类有情绪或指代的词一律保留。
    "这么", "那么", "还有", "有点", "不如", "反正", "居然", "竟然", "到底",
    "一下", "一样", "一次", "一定", "一直", "一起", "不是", "不会", "不能",
    "哈哈", "哈哈哈", "哈哈哈哈", "哈哈哈哈哈哈",   # 笑声：复读串，进词云只会占面积
    "呵呵", "嘿嘿", "嘻嘻", "呜呜", "嘤嘤",
    "the", "and", "you", "for", "are", "but", "not", "with", "this", "that",
})

# 纯符号/空白：分词器会把「，」「。」「（」当独立 token 吐出来
_PUNCT_ONLY = re.compile(r"^[\W_]+$", re.UNICODE)
# 英文/数字串（至少 2 位）：jieba 对英文按空格切，长串会被当成一个 token，
# 这里单独保底提取，保证 "promax"、"iphone" 这类词能被统计到
_ASCII_WORD = re.compile(r"[A-Za-z][A-Za-z0-9']{1,}")


class Tokenizer(Protocol):
    """分词器协议：实现 `cut(text) -> Iterable[str]` 即可接入。"""

    name: str

    def cut(self, text: str) -> Iterable[str]:  # pragma: no cover - 协议声明
        ...


class JiebaTokenizer:
    """默认分词器：jieba 精确模式 + 内置词典。

    首次 `cut` 会构建前缀词典（本机实测 0.70s，之后每次 ~0.1ms/条），
    因此**不要在请求路径上首次调用**——`warmup()` 供启动期预热。
    """

    name = "jieba"

    def __init__(self) -> None:
        self._impl = None
        self._extra_words: list[str] = []

    def _load(self):
        if self._impl is None:
            import jieba  # 延迟导入：不让 jieba 进冷启动关键路径
            self._impl = jieba
            for w in self._extra_words:
                jieba.add_word(w)
            self._extra_words.clear()
        return self._impl

    def warmup(self) -> None:
        """预热词典（启动期调用一次；失败只记日志，不影响抓取）。"""
        try:
            self._load().lcut("预热")
        except Exception as e:  # pragma: no cover - 依赖缺失/词典损坏
            logger.warning(f"jieba 预热失败（词云将退回正则分词）: {type(e).__name__}: {e}")

    def add_words(self, words: Iterable[str]) -> None:
        """灌入自定义词（主播名/梗词/舰队名），避免被切碎。"""
        words = [w for w in words if w]
        if not words:
            return
        if self._impl is None:
            self._extra_words.extend(words)      # 还没加载：先攒着，加载时统一灌
            return
        for w in words:
            self._impl.add_word(w)

    def cut(self, text: str) -> Iterable[str]:
        return self._load().lcut(text)


class RegexTokenizer:
    """兜底分词器：连续中文块 + 英文/数字串。

    精度明显低于 jieba（"哈哈哈哈"这种复读串会被整块保留、长句会被当成长词），
    只在 jieba 不可用时启用——**保证功能降级而不是消失**。
    """

    name = "regex"

    _CJK_RUN = re.compile(r"[\u4e00-\u9fff]+")

    def cut(self, text: str) -> Iterable[str]:
        for run in self._CJK_RUN.findall(text):
            yield run
        for w in _ASCII_WORD.findall(text):
            yield w


TOKENIZERS: dict[str, Tokenizer] = {
    "jieba": JiebaTokenizer(),
    "regex": RegexTokenizer(),
}


def register_tokenizer(name: str, tokenizer: Tokenizer) -> None:
    """注册新分词器（扩展点 1）。"""
    TOKENIZERS[name] = tokenizer


def get_tokenizer(engine: str | None = None) -> Tokenizer:
    """按名字取分词器；**jieba 不可用时自动退回 regex**（不是报错）。"""
    name = engine or DEFAULT_ENGINE
    tk = TOKENIZERS.get(name)
    if tk is None:
        logger.warning(f"未知分词引擎 {name!r}，退回 regex")
        return TOKENIZERS["regex"]
    if isinstance(tk, JiebaTokenizer):
        try:
            tk._load()
        except Exception as e:
            logger.warning(f"分词引擎 {name} 加载失败（{type(e).__name__}），退回 regex")
            return TOKENIZERS["regex"]
    return tk


def normalize_token(token: str) -> str:
    """规范化 token（**先规范化再计数**，否则同一个词会被拆成两条）。

    实测踩到过：`Sweety` 与 `sweety` 各自成条、各 60 次，白白占掉两个词位
    （jieba 对英文大小写敏感）。因此**纯 ASCII 的 token 一律转小写**；
    含中文的 token 原样返回（中文没有大小写，且不该动全角/半角）。
    """
    t = token.strip()
    if not t:
        return t
    return t.lower() if t.isascii() else t


def is_meaningful(token: str) -> bool:
    """这个词值不值得进词云。

    过滤：空白 / 纯符号 / 过短 / 停用词 / 纯数字。
    """
    t = normalize_token(token)
    if len(t) < MIN_TOKEN_LEN:
        return False
    if _PUNCT_ONLY.match(t):
        return False
    if t.isdigit():
        return False
    return t not in STOPWORDS


def count_tokens(
    texts: Iterable[str],
    engine: str | None = None,
    top_n: int = TOP_N,
    min_count: int = MIN_COUNT,
    extra_words: Iterable[str] | None = None,
) -> list[tuple[str, int]]:
    """弹幕文本 → `[(词, 次数)]`（降序，已过滤，最多 `top_n` 条）。

    纯函数（除分词器内部状态外无副作用），可离线单测。
    """
    tk = get_tokenizer(engine)
    if extra_words and isinstance(tk, JiebaTokenizer):
        tk.add_words(extra_words)
    # ⚠️ 这里**刻意不再补捞 ASCII 词**。曾经加过一个"非 CJK token 再跑一遍
    # `_ASCII_WORD.findall`"的分支，结果连踩两次重复计数（2026-09-13 实测）：
    #   ① `["Sweety","sweety","SWEETY"]` → 6 而不是 3（jieba 整串吐出 ASCII 词，又被补捞一次）；
    #   ② regex 引擎把混合串 `"Sweety 好耶"` 整块返回时同理翻倍。
    # 实测两个引擎**都已经**把 ASCII 词切好：jieba `'Only Apple Can Do'` →
    # `['Only',' ','Apple',' ','Can',' ','Do']`；regex → `['Only','Apple','Can','Do']`。
    # 所以补捞纯属多余，删掉即正确。
    counter: Counter[str] = Counter()
    for text in texts:
        if not text:
            continue
        # 长文本（复读刷屏）限量：避免单条超长弹幕主导统计
        for token in tk.cut(text[:200]):
            if is_meaningful(token):
                counter[normalize_token(token)] += 1
    return [(w, c) for w, c in counter.most_common(top_n) if c >= min_count]


def _is_cjk(s: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in s)


def iter_texts_from_records(records: Iterable[dict]) -> Iterable[str]:
    """danmakus v3 弹幕记录 → 文本（纯函数，可单测）。

    ⚠️ 字段名按 `payloadKind` **不同**（2026-09-13 实测，见 devlog/060）：

    | payloadKind | 含义 | 文本字段 |
    |---|---|---|
    | 1 | 普通弹幕 | `payload.rawText` |
    | 5 | SC（醒目留言） | `payload.text` |
    | 9 | 系统提示 | `payload.text` |
    | 0 / 2 / 3 / 10 | 进入·表情·礼物·其他 | 无文本 |

    按单一键（比如只取 `text`）统计会漏掉 **96% 以上**的弹幕 ——
    实测某场 18764 条里只有 34 条带 `text`，而带 `rawText` 的有 5798 条。
    """
    for r in records:
        if not isinstance(r, dict):
            continue
        p = r.get("payload")
        if not isinstance(p, dict):
            continue
        for key in ("rawText", "text"):
            v = p.get(key)
            if isinstance(v, str) and v.strip():
                yield v.strip()
                break


def summarize_word_cloud(
    records: Iterable[dict],
    engine: str | None = None,
    top_n: int = TOP_N,
) -> tuple[int, list[tuple[str, int]]]:
    """弹幕记录 → `(文本弹幕条数, [(词, 次数)])`。"""
    texts = list(iter_texts_from_records(records))
    return len(texts), count_tokens(texts, engine=engine, top_n=top_n)


# 分隔符：空白、中点、斜杠、顿号逗号、中英文括号 —— 名字里这些都不该进词典
_EXTRA_SPLIT = re.compile(r"[\s·・/|,，、（）()\[\]【】「」]+")


def build_extra_words(values: Iterable[str | None]) -> list[str]:
    """把 V 名 / 企划名 / 昵称整理成**自定义词典**条目（扩展点 2 的接线工具）。

    实测量化过收益（2026-09-13）：弹幕里"喵喵机长真棒"不加词被切成 `机长`，
    加词后是 `喵喵机长` —— 主播名/企划名/梗词是词云里最该出现的那几个词，
    被切碎就等于丢掉了它们。

    规则（都是"宁少勿错"）：
    - 按空白/中点/斜杠/标点拆开（`七海 Nana7mi` → 两条，而不是灌一条带空格的怪词）；
    - 丢掉长度 < `MIN_TOKEN_LEN` 的碎片（单字当词只会污染分词）；
    - 去重并保持输入顺序。
    """
    out: list[str] = []
    seen: set[str] = set()
    for v in values:
        if not v:
            continue
        for part in _EXTRA_SPLIT.split(str(v).strip()):
            p = part.strip()
            if len(p) < MIN_TOKEN_LEN or p in seen:
                continue
            seen.add(p)
            out.append(p)
    return out


# 供调用方注入"某场次要用哪些自定义词"（扩展点 2 的接线处）
ExtraWordsHook = Callable[[str], Iterable[str]]
