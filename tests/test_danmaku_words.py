"""弹幕分词与词云自建（2026-09-13，danmakus 上游断供后的方案 a，见 devlog/061）。

## 测试策略

分词与计数是**纯逻辑**，所以主要用合成弹幕断言行为契约（过滤规则、排序、上限、
payloadKind 字段名差异），只有一条用例打真实网络（标 `@pytest.mark.network`
的语义由"失败即 skip"实现，避免离线环境红）。

**最关键的一条**是 `test_iter_texts_reads_raw_text_not_only_text`：
2026-09-13 实测踩到过 —— 普通弹幕的文本在 `payload.rawText`，而 `payload.text`
只用于 SC/系统提示。按单一键统计时某场 18764 条只能数出 **34 条**（漏掉 96%+），
当时差点据此得出"原始弹幕也没有文字"的相反结论。
"""
import asyncio

import pytest


# ── 记录 → 文本（payloadKind 字段名差异） ─────────────────────────────

def test_iter_texts_reads_raw_text_not_only_text():
    """回归（2026-09-13 实测）：普通弹幕在 `rawText`，SC/系统提示在 `text`，两种都要收。"""
    from app.services.danmaku_words import iter_texts_from_records

    records = [
        {"payloadKind": 0, "payload": None},                          # 进入类：无文本
        {"payloadKind": 1, "payload": {"rawText": "其实还没睡（）"}},   # 普通弹幕
        {"payloadKind": 2, "payload": {"roomEmojiId": 0}},            # 房间表情：无文本
        {"payloadKind": 3, "payload": {"name": "星光点点", "count": 1}},  # 礼物：无文本
        {"payloadKind": 5, "payload": {"price": 30, "text": "祝顺利晋级"}},  # SC
        {"payloadKind": 9, "payload": {"text": "来自 某某 谢谢喵"}},       # 系统提示
        {"payloadKind": 10, "payload": None},
    ]
    assert list(iter_texts_from_records(records)) == [
        "其实还没睡（）", "祝顺利晋级", "来自 某某 谢谢喵",
    ]


def test_iter_texts_ignores_malformed_records():
    """形状不对的记录（None / 非 dict / payload 非 dict / 空串）一律跳过，不抛错。"""
    from app.services.danmaku_words import iter_texts_from_records

    records = [None, "x", 42, {}, {"payload": None}, {"payload": "text"},
               {"payload": {"rawText": ""}}, {"payload": {"rawText": "   "}},
               {"payload": {"rawText": "有效"}}]
    assert list(iter_texts_from_records(records)) == ["有效"]


def test_iter_texts_prefers_raw_text_when_both_present():
    """两个键都在时优先 `rawText`（普通弹幕是主流），且一条记录只产出一次。"""
    from app.services.danmaku_words import iter_texts_from_records

    out = list(iter_texts_from_records([{"payload": {"rawText": "甲", "text": "乙"}}]))
    assert out == ["甲"]


# ── 过滤规则 ──────────────────────────────────────────────────────────

def test_is_meaningful_filters_noise():
    from app.services.danmaku_words import is_meaningful

    # 收：有信息量的词
    for ok in ("苹果", "朱元璋", "dog", "sweety", "发布会", "音姐"):
        assert is_meaningful(ok), ok
    # 丢：单字 / 纯符号 / 纯数字 / 停用词 / 空白
    for bad in ("的", "，", "。", "（", "……", "123", "42", "哈哈", "哈哈哈", "the", "   ", ""):
        assert not is_meaningful(bad), bad


def test_normalize_token_lowercases_ascii_only():
    """回归（2026-09-13 实测）：`Sweety` 与 `sweety` 曾被算成两个词、各 60 次。"""
    from app.services.danmaku_words import normalize_token

    assert normalize_token("Sweety") == "sweety"
    assert normalize_token("DOG") == "dog"
    assert normalize_token("  Apple  ") == "apple"
    # 中文不动（没有大小写，也不该动全角/半角）
    assert normalize_token("音音") == "音音"
    assert normalize_token("（全角）") == "（全角）"


# ── 计数 ──────────────────────────────────────────────────────────────

def test_count_tokens_orders_and_limits():
    from app.services.danmaku_words import count_tokens

    texts = ["苹果 苹果 苹果", "苹果 华为", "华为 华为", "小米", "小米"]
    words = count_tokens(texts, engine="jieba")
    d = dict(words)
    assert d["苹果"] == 4 and d["华为"] == 3 and d["小米"] == 2
    # 降序
    counts = [c for _w, c in words]
    assert counts == sorted(counts, reverse=True)


def test_count_tokens_drops_singletons_and_respects_top_n():
    from app.services.danmaku_words import count_tokens

    texts = ["只出现一次"] + ["反复出现"] * 5
    words = count_tokens(texts, engine="jieba")
    assert "只出现一次" not in dict(words)          # 出现 1 次 → 丢弃（除非是整词）
    assert dict(words).get("反复") == 5 or dict(words).get("反复出现") == 5
    assert len(count_tokens(["甲" * 2] * 3, engine="jieba", top_n=1)) <= 1


def test_count_tokens_does_not_double_count_ascii():
    """回归（2026-09-13 自己踩到）：jieba 把 `Sweety` 整串当一个 token，
    若再无脑补捞 ASCII，同一个词会被计两次（实测得到 6 而不是 3）。"""
    from app.services.danmaku_words import count_tokens

    words = dict(count_tokens(["Sweety", "sweety", "SWEETY"], engine="jieba"))
    assert words == {"sweety": 3}          # 合并大小写，且**不翻倍**


def test_count_tokens_merges_ascii_case_variants():
    """大小写不同的同一个英文词必须合并成一条（回归，见 normalize_token）。"""
    from app.services.danmaku_words import count_tokens

    d = dict(count_tokens(["Sweety", "sweety", "SWEETY", "苹果"], engine="jieba"))
    assert d["sweety"] == 3


def test_count_tokens_empty_input():
    from app.services.danmaku_words import count_tokens

    assert count_tokens([], engine="jieba") == []
    assert count_tokens(["", "   "], engine="jieba") == []


# ── 引擎可替换（扩展点） ──────────────────────────────────────────────

def test_regex_engine_is_usable_fallback():
    """jieba 不可用时的兜底引擎：能分词、能计数（精度低但不消失）。

    ⚠️ 记录两个**实测性质**（不是期望行为，是它的固有上限）：

    1. `RegexTokenizer` 把**连续 CJK 整块**当一个 token —— `"苹果苹果苹果"` 得到
       `("苹果苹果苹果", 1)`，只出现 1 次还会被 `min_count` 滤掉。真实弹幕有空格/标点，
       所以兜底路径仍有产出（见下），但它**不是 jieba 的等价替代**。
    2. 它**不捞纯数字**（实测 `"233 点赞"` → `["点赞"]`，`233` 丢失）。
       这是有意的取舍：`is_meaningful` 本来就把纯数字判为噪声。
    """
    from app.services.danmaku_words import count_tokens

    # 有分隔（真实弹幕的常态）→ 正常出词
    assert dict(count_tokens(["苹果 苹果", "苹果"], engine="regex"))["苹果"] == 3
    # 纯连续中文 → 整块保留 + 只出现 1 次被滤掉
    assert count_tokens(["苹果苹果苹果"], engine="regex") == []
    # 英文照常能数（且大小写合并、不翻倍）
    assert dict(count_tokens(["Sweety 好耶", "sweety"], engine="regex"))["sweety"] == 2
    # 纯数字不进词云
    assert "233" not in dict(count_tokens(["233 233 点赞 点赞"], engine="regex"))


def test_unknown_engine_falls_back_to_regex_not_crash():
    from app.services.danmaku_words import get_tokenizer

    assert get_tokenizer("不存在的引擎").name == "regex"


def test_register_tokenizer_extension_point():
    """扩展点 1：实现 `cut()` 即可注册新分词器，接口与前端都不用改。"""
    from app.services.danmaku_words import TOKENIZERS, get_tokenizer, register_tokenizer

    class _DictTokenizer:
        name = "test_dict"

        def cut(self, text):
            return text.split()

    try:
        register_tokenizer("test_dict", _DictTokenizer())
        tk = get_tokenizer("test_dict")
        assert tk.name == "test_dict"
        assert list(tk.cut("甲 乙 丙")) == ["甲", "乙", "丙"]
    finally:
        TOKENIZERS.pop("test_dict", None)      # 不污染其他用例


def test_extra_words_extension_point_keeps_name_intact():
    """扩展点 2：灌入自定义词后，主播名不再被切碎。"""
    from app.services.danmaku_words import count_tokens

    texts = ["明前奶绿"] * 3
    # 不灌词典时 jieba 会切成 明前/奶绿；灌入后应保留整名
    words = dict(count_tokens(texts, engine="jieba", extra_words=["明前奶绿"]))
    assert words.get("明前奶绿") == 3


# ── 服务层：三种结果 + 缓存 ────────────────────────────────────────────

def test_build_word_cloud_fetch_failed(monkeypatch):
    from app.services import danmaku_cloud

    async def _fail(_lid, max_records=0):
        return None

    monkeypatch.setattr(danmaku_cloud, "fetch_raw_danmakus", _fail)
    danmaku_cloud.clear_cache()
    r = asyncio.run(danmaku_cloud.build_word_cloud("L1"))
    assert r["status"] == "fetch_failed"
    assert r["words"] == []


def test_build_word_cloud_no_text_records(monkeypatch):
    """成功但一条文本弹幕都没有 → no_danmaku（与"拉取失败"区分开）。"""
    from app.services import danmaku_cloud

    async def _only_gifts(_lid, max_records=0):
        return [{"payloadKind": 0, "payload": None},
                {"payloadKind": 3, "payload": {"name": "礼物", "count": 1}}]

    monkeypatch.setattr(danmaku_cloud, "fetch_raw_danmakus", _only_gifts)
    danmaku_cloud.clear_cache()
    r = asyncio.run(danmaku_cloud.build_word_cloud("L2"))
    assert r["status"] == "no_danmaku"
    assert r["text_count"] == 0 and r["words"] == []


def test_build_word_cloud_ok_and_cached(monkeypatch):
    from app.services import danmaku_cloud

    calls = {"n": 0}

    async def _records(_lid, max_records=0):
        calls["n"] += 1
        return [{"payload": {"rawText": "苹果 苹果"}},
                {"payload": {"rawText": "苹果 华为"}}]

    monkeypatch.setattr(danmaku_cloud, "fetch_raw_danmakus", _records)
    danmaku_cloud.clear_cache()
    r1 = asyncio.run(danmaku_cloud.build_word_cloud("L3"))
    assert r1["status"] == "ok"
    assert dict(r1["words"])["苹果"] == 3
    assert r1["text_count"] == 2
    assert r1["total"] == 2
    # 第二次命中缓存 → 不再打上游
    r2 = asyncio.run(danmaku_cloud.build_word_cloud("L3"))
    assert r2 == r1
    assert calls["n"] == 1


def test_build_word_cloud_failure_is_not_cached(monkeypatch):
    """失败**不缓存**：用户点重试必须真的重试，而不是拿缓存的失败结果。"""
    from app.services import danmaku_cloud

    calls = {"n": 0}

    async def _fail(_lid, max_records=0):
        calls["n"] += 1
        return None

    monkeypatch.setattr(danmaku_cloud, "fetch_raw_danmakus", _fail)
    danmaku_cloud.clear_cache()
    asyncio.run(danmaku_cloud.build_word_cloud("L4"))
    asyncio.run(danmaku_cloud.build_word_cloud("L4"))
    assert calls["n"] == 2


def test_cache_evicts_when_full(monkeypatch):
    from app.services import danmaku_cloud

    async def _records(_lid, max_records=0):
        return [{"payload": {"rawText": "苹果 苹果"}}]

    monkeypatch.setattr(danmaku_cloud, "fetch_raw_danmakus", _records)
    monkeypatch.setattr(danmaku_cloud, "_CACHE_MAX", 2)
    danmaku_cloud.clear_cache()
    for i in range(3):
        asyncio.run(danmaku_cloud.build_word_cloud(f"E{i}"))
    assert len(danmaku_cloud._CACHE) <= 2


# ── 真实网络（离线自动跳过） ──────────────────────────────────────────

def test_fetch_raw_danmakus_against_live_endpoint():
    """一条**真打上游**的冒烟：确认 v3 端点仍公开、能取到弹幕原文。

    上游随时可能变化（`extra.wordCloud` 就是这么消失的），所以这条用例的价值是
    **尽早发现"自建路径也断了"**。网络不可用时 skip，不让离线环境红。
    """
    from app.services.externals.danmakus import fetch_raw_danmakus

    try:
        # 取一页就够（不拉全量，避免测试跑几十秒）
        records = asyncio.run(fetch_raw_danmakus(
            "c99fb5a9-e266-4e15-8f3c-437e8a5a0969", max_records=200))
    except Exception as e:                                   # noqa: BLE001
        pytest.skip(f"网络不可用：{type(e).__name__}: {e}")
    if records is None:
        pytest.skip("上游不可达（网络或上游变更）")
    assert records, "应当至少取到一条弹幕记录"
    texts = [t for r in records if (t := (r.get("payload") or {}).get("rawText"))]
    assert texts, "200 条记录里应当有带 rawText 的普通弹幕"
