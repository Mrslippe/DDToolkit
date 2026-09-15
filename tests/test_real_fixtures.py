# -*- coding: utf-8 -*-
"""**真实产物 fixtures** 的消费用例（devlog/085）。

## 为什么有这一组

2026-09-15 那批工作里，我写的判据出过两次"自造样本绿、真实现场红"：

- NSIS「后端目录被打平」的正则：自造样本漏了目标路径的引号 → **永不命中**，
  而"打平 0 行"看起来跟"真的没打平"一模一样；
- 候选池索引来源的收录路径：按 id 抽样前 200 行得出"只有 3 条不在池里"，
  而**按关键词命中的那批**是 19/37 —— 前端因此把索引行送进了池内路径，用户一点就报错。

两条的共同解法：**判据至少有一条用例吃真实数据**。`tests/fixtures/` 里的文件都由
`python scripts/smoke_upstream.py --capture` 从真上游 / 真构建产物刷出来，
（除了真正的接口存档）不要手改；要更新就跑那条命令并说明来源与日期。
"""
import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parent / "fixtures"
RAW_SEARCH = FIXTURES / "bili_user_search_raw.json"
ENDPOINT_SEARCH = FIXTURES / "bili_search_endpoint.json"
INDEX_ROW = FIXTURES / "pool_search_index_row.json"
NSIS_EXCERPT = FIXTURES / "nsis_installer_excerpt.txt"


def _load(path: Path) -> dict:
    if not path.exists():
        pytest.skip(f"缺 fixture {path.name}（跑 python scripts/smoke_upstream.py --capture 生成）")
    return json.loads(path.read_text(encoding="utf-8"))


# ── 上游原始回包：字段映射必须对得上真形状 ─────────────────────────────

def test_map_search_item_against_real_upstream_body():
    """用**真上游回包**测 `map_search_item`：字段名读错时这条必须红。

    ⚠️ 第一版这条用例**是空转的**（反向验证当场抓到）：只断言"名字非空、没有高亮标签"，
    而映射器把读不到的字段兜底成 uid（`... or str(mid)`）—— 名字变成 "1265680561" 也照样通过。
    所以现在**逐字段与原始值对齐**（`uname`/`usign`/`fans`/`upic`/`official_verify.desc`），
    读错任何一个字段，输出就对不上。
    """
    from app.services import bili_search as bs

    doc = _load(RAW_SEARCH)
    assert doc["code"] == 0, "fixture 应是成功回包（失败回包证明不了字段映射）"
    raw_items = doc["data"]["result"]
    assert raw_items, "fixture 里没有结果条目"

    for raw in raw_items:
        got = bs.map_search_item(raw)
        assert got, "真回包里出现了映射不出来的条目（缺 mid？）"
        # 逐字段对齐：读错字段名 → 这里必红（兜底值对不上原始值）
        assert got["name"] == (bs.strip_highlight(raw.get("uname")) or str(raw["mid"]))
        assert got["name"] != str(raw["mid"]), \
            f"名字退化成了 uid —— `uname` 没读到（真回包字段名变了？）raw keys={sorted(raw)[:8]}"
        assert got["sign"] == bs.strip_highlight(raw.get("usign"))
        assert got["followers"] == int(raw.get("fans") or 0)
        assert got["verified"] == bs.strip_highlight((raw.get("official_verify") or {}).get("desc"))
        assert got["avatar"].startswith("https://"), f"头像没补 https：{got['avatar']!r}"
        assert raw["upic"].lstrip("/").split("/")[-1] in got["avatar"], "头像不是从 upic 来的"
        assert got["platform"] == "bilibili"
        assert got["platform_uid"] == str(raw["mid"])


def test_real_upstream_body_has_fields_the_mapper_reads():
    """反向：映射器读的原始字段名必须在真回包里**存在**（上游改名 = 静默全空）。"""
    from app.services import bili_search as bs

    doc = _load(RAW_SEARCH)
    raw = doc["data"]["result"][0]
    for field in ("mid", "uname", "usign", "fans", "upic"):
        assert field in raw, f"真回包里没有 {field} —— map_search_item 会静默取到空值"
    # official_verify 是嵌套的（认证说明），也要在
    assert "official_verify" in raw
    # 顺便固定住分页字段（前端"加载更多"依赖它）
    assert isinstance(doc["data"].get("numPages"), int)


# ── 端点回包：类型形状（前端 TS 类型与它对齐）──────────────────────────

def test_endpoint_fixture_shape_matches_frontend_contract():
    """端点回包的形状 = 前端 `BiliSearchResult` 的契约（字段错了前端会静默空白）。"""
    doc = _load(ENDPOINT_SEARCH)
    body = doc["body"]
    for key in ("items", "page", "total_pages", "has_more", "error", "hint", "exact", "cached"):
        assert key in body, f"回包缺 {key}（前端 BiliSearchResult 有这一项）"
    item = body["items"][0]
    for key in ("platform", "platform_uid", "name", "sign", "followers", "avatar",
                "verified", "is_live", "room_id", "videos", "level", "exact", "in_library"):
        assert key in item, f"条目缺 {key}（前端 BiliSearchItem 有这一项）"


# ── 索引来源那一行：收录路径的依据（用户实测报过的那个 bug）────────────

def test_index_origin_row_is_really_outside_the_pool():
    """`origin='index'` 的行**确实不在候选池**里 —— 前端据此送 `source='bilibili'`。

    这条 fixture 是那条 bug 的现场存档：`thirdparty_vtubers` 覆盖"池快照之后的新 V"，
    把它们按池内路径提交必然 404（devlog/083 §十一）。
    """
    doc = _load(INDEX_ROW)
    row = doc["row"]
    assert row["origin"] == "index"
    assert row["in_pool"] is False, "记录里说它在池内 —— fixture 与结论矛盾"
    assert row["platform"] == "bilibili"
    assert str(row["platform_uid"]).isdigit()
    # 结论要写在 fixture 里，免得日后有人只改数据不改注释
    assert "source='bilibili'" in doc["note"]


def test_index_origin_row_is_not_adoptable_via_pool_path(monkeypatch):
    """后端侧的行为：池外条目不带 `source` 必须 404（**不是** 500、不是 201）。

    用真 fixture 的那一行走一遍端点，确保"前端送错 source"时的表现与文档一致。
    """
    from fastapi.testclient import TestClient

    import app.routers.vtuber as router_mod
    from app.main import app

    doc = _load(INDEX_ROW)
    uid = str(doc["row"]["platform_uid"])
    monkeypatch.setattr(router_mod.pool, "find_in_pool", lambda p, u: None)   # 池里没有（真实现场）

    async def noop_background(*_a, **_k) -> None:
        return None
    monkeypatch.setattr(router_mod, "_adopt_background", noop_background)

    with TestClient(app) as client:
        r = client.post("/vtuber/adopt", json={"platform": "bilibili", "platform_uid": uid})
    assert r.status_code == 404
    assert "source='bilibili'" in r.json()["detail"], \
        "404 文案要指路（用户唯一能看懂的线索）"


# ── NSIS：真 install 脚本片段（判据必须能在真形状上命中）──────────────

def test_nsis_judgment_on_real_excerpt():
    """用真 `installer.nsi` 片段验判据：`kept > 0`（认得出）且 `flattened == 0`。"""
    if not NSIS_EXCERPT.exists():
        pytest.skip("缺 nsis_installer_excerpt.txt（跑 scripts/smoke_upstream.py --capture）")
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
    import release as R

    lines = NSIS_EXCERPT.read_text(encoding="utf-8").splitlines()
    assert lines, "fixture 是空的"
    assert any("/oname=" in l for l in lines), "fixture 里没有 oname 行（抓错内容了？）"
    kept, flattened = R.classify_nsis(lines)
    assert kept > 0, "真 install 脚本片段里一条 _internal 行都没认出来 —— 判据与真实格式脱节"
    assert flattened == 0
