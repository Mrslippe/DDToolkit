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


def test_build_extra_words_shapes():
    """`build_extra_words`：把 V 名/企划/昵称整理成能进 jieba 词典的条目。

    规则都刻意"宁少勿错"：带空格的名字要拆开（否则灌进去的是一条带空格的怪词）、
    单字碎片丢掉（单字当词只会污染分词）、重复项只留一次。
    """
    from app.services.danmaku_words import build_extra_words

    assert build_extra_words(["七海 Nana7mi"]) == ["七海", "Nana7mi"]
    assert build_extra_words(["明前奶绿", "VirtuaReal"]) == ["明前奶绿", "VirtuaReal"]
    # 去重（V 名与昵称常常一样）+ 顺序稳定
    assert build_extra_words(["明前奶绿", "明前奶绿", "奶绿社"]) == ["明前奶绿", "奶绿社"]
    # 空值 / None / 纯分隔符 / 单字 → 全部丢掉
    assert build_extra_words([None, "", "   ", "·", "甲", "()", "乙乙"]) == ["乙乙"]
    # 括号与顿号也当分隔符（企划名常写成「XX（中国）」这种）；
    # 注意单字母同样会被 MIN_TOKEN_LEN 滤掉（这里用 AB/CD 才留得下）
    assert build_extra_words(["XX（中国）", "AB、CD"]) == ["XX", "中国", "AB", "CD"]


def test_build_extra_words_actually_prevents_splitting():
    """接线后的**真实收益**：不加词"喵喵机长真棒"被切成 `机长`，加词后是 `喵喵机长`。

    这条是 2026-09-13 实测出来的（`机长` 出现 3 次而 `喵喵` 消失）——
    主播名被切碎就等于词云里丢了最重要的那个词。
    """
    from app.services.danmaku_words import build_extra_words, count_tokens

    texts = ["喵喵机长真棒", "喵喵机长真棒", "喵喵机长加油"]
    before = dict(count_tokens(texts, engine="jieba"))
    after = dict(count_tokens(texts, engine="jieba",
                             extra_words=build_extra_words(["喵喵机长"])))
    assert "机长" in before and "喵喵机长" not in before
    assert after.get("喵喵机长") == 3 and "机长" not in after


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


# ── 词典空闲释放（`devlog/447`，TODO §1「词云词典空闲卸载」）──────────────
#
# 为什么要有这一组：R24/T2（`devlog/117`）只解决了"**没人用词云时不要占**那 56MB"
# （取消启动预热），没解决"**用过一次之后永远占着**" —— 看一场直播的词云，之后那本
# 前缀词典就一直挂在进程里。这一组钉住三件事：到点真的释放、释放不是降级、
# 自定义词不会因为释放而丢。

def _fresh_tokenizer():
    """新起一个分词器（**不碰**全局那份 `TOKENIZERS["jieba"]`，免得影响别的用例）。"""
    from app.services.danmaku_words import JiebaTokenizer

    tk = JiebaTokenizer()
    tk.cut("预热")                     # 真把词典建起来（0.7s 一次，用例里只做一次）
    return tk


def test_idle_release_really_frees_the_prefix_dict():
    """★ 超时 ⇒ `FREQ` 真的空掉、`initialized` 落下；**没超时不许动**（正对照）。"""
    tk = _fresh_tokenizer()
    assert tk.loaded is True
    assert len(tk._impl.dt.FREQ) > 100_000, "前缀词典应当真的建起来了（60 万条量级）"

    # 正对照：刚用过（now = 上一次使用那一刻）⇒ 什么都不做。
    # 少了这一条，"释放了"与"永远释放"分不开。
    assert tk.release_if_idle(now=tk._last_used, idle_sec=600) is False
    assert tk.loaded is True

    assert tk.release_if_idle(now=tk._last_used + 601, idle_sec=600) is True
    assert tk.loaded is False
    assert len(tk._impl.dt.FREQ) == 0, "那 56MB 就是 FREQ，必须真的空掉"
    tk.cancel_timer()


def test_release_is_not_a_downgrade_to_regex():
    """★ 释放后**下次仍然走 jieba**（只是多等一次重建），结果与释放前逐字一致。"""
    tk = _fresh_tokenizer()
    before = list(tk.cut("喵喵机长真棒，今天也很可爱"))
    assert tk.release_if_idle(now=tk._last_used + 601, idle_sec=600) is True
    after = list(tk.cut("喵喵机长真棒，今天也很可爱"))
    assert tk.loaded is True, "再用一次应当把词典重建起来"
    assert after == before, "重建后结果必须一致（否则用户会看到词云变了）"
    tk.cancel_timer()


def test_release_keeps_custom_words():
    """★ 释放会丢掉 `add_word` 灌进去的词 ⇒ 重建时必须**重灌**（否则主播名又被切碎）。"""
    tk = _fresh_tokenizer()
    tk.add_words(["喵喵机长"])
    assert "喵喵机长" in list(tk.cut("喵喵机长真棒"))

    assert tk.release_if_idle(now=tk._last_used + 601, idle_sec=600) is True
    assert "喵喵机长" in list(tk.cut("喵喵机长真棒")), \
        "重灌失败 ⇒ 主播名会被切成『机长』（vtuber.py 里那条注释说的就是这个）"
    tk.cancel_timer()


def test_release_before_load_is_a_noop():
    """没加载过 ⇒ `release()` 返回 False（不报错）；连着放两次，第二次也是 False。"""
    from app.services.danmaku_words import JiebaTokenizer

    tk = JiebaTokenizer()
    assert tk.release() is False
    tk.cut("预热")
    assert tk.release() is True
    assert tk.release() is False


def test_idle_zero_disables_the_mechanism(monkeypatch):
    """`TOKENIZER_IDLE_SEC = 0` ⇒ **永不释放**（这颗旋钮就是"关掉这个机制"）。"""
    from app.services import danmaku_words as dw

    monkeypatch.setattr(dw, "TOKENIZER_IDLE_SEC", 0.0)
    tk = _fresh_tokenizer()
    assert tk.release_if_idle(now=tk._last_used + 10_000) is False
    assert tk.loaded is True
    assert dw.release_idle_tokenizers() == []


def test_timer_drives_the_release_and_rearms_on_use(monkeypatch):
    """定时器（真驱动）也能到点释放；**再用一次会重新武装**。

    用 0.05s 的阈值把等待压到毫秒级（真机默认 10 分钟）—— 这是驱动层的唯一一条用例，
    状态机本身的判据都在上面那几条（注入假时钟，不受调度影响）。
    """
    import time as _time

    from app.services import danmaku_words as dw

    monkeypatch.setattr(dw, "TOKENIZER_IDLE_SEC", 0.05)
    tk = _fresh_tokenizer()
    assert tk.loaded is True
    _time.sleep(0.6)
    assert tk.loaded is False, "到点应当被定时器释放"
    tk.cut("再来一次")
    assert tk.loaded is True, "再用一次应当重建"
    tk.cancel_timer()


def test_release_refuses_while_a_cut_is_in_flight(monkeypatch):
    """★ **切词途中绝不许释放**（真并发窗口，不是理论问题）。

    时序：定时器在 T+600s 醒来 → 某个请求**刚好**开始切词（还没走到结尾那次刷新）⇒
    若此时把 `FREQ` 抽空，这次 `lcut` 已经过了 `check_initialized()` ⇒
    **不抛错、但整句被切成单字**（静默的错误结果，用户看到的是"词云全变成单字"）。
    这里把那一次 `lcut` 卡在事件上，期间尝试释放 —— 必须拒绝。
    """
    import threading

    tk = _fresh_tokenizer()
    entered = threading.Event()
    unblock = threading.Event()
    real_lcut = tk._impl.lcut

    def slow_lcut(text):
        entered.set()
        unblock.wait(5)
        return real_lcut(text)

    monkeypatch.setattr(tk._impl, "lcut", slow_lcut)
    th = threading.Thread(target=lambda: list(tk.cut("在途的一次切词")))
    th.start()
    assert entered.wait(5), "那次 cut 应当已经进到 lcut 里"

    # 期间"空闲"时间怎么算都不该放行（阈值给 0 都拒 —— 判的是"有人在用"）
    assert tk.release_if_idle(now=tk._last_used + 10_000, idle_sec=600) is False
    assert tk.release() is False
    assert tk.loaded is True

    unblock.set()
    th.join(10)
    assert tk._in_flight == 0, "切完要把在途计数还回去"
    assert tk.loaded is True
    tk.cancel_timer()


def test_tokenizer_state_is_observable():
    """状态可观测（探针读的就是它）：loaded / idle_sec / releases / 自定义词数。"""
    from app.services.danmaku_words import JiebaTokenizer, tokenizer_state

    tk = JiebaTokenizer()
    assert tk.state()["loaded"] is False
    tk.cut("预热")
    tk.add_words(["某主播"])
    tk.release()
    st = tk.state()
    assert st["loaded"] is False and st["releases"] == 1 and st["custom_words"] == 1
    assert "jieba" in tokenizer_state()
    tk.cancel_timer()


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
