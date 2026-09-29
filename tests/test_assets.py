# -*- coding: utf-8 -*-
"""轻资产长期储存模块（L1，devlog/257）。

## 这个模块要解决的问题（都有 2026-09-29 实测证据，见 `docs/design-light-assets.md` §0）

| # | 问题 | 本批的判据 |
|---|---|---|
| ① | **远端 URL 会死**：微博头像签名只有约 3 小时有效期，V#16 那张实测已过期 21 小时 | 命中稳定键 ⇒ **一次图片请求都不发**（`tests/test_vtuber_avatars.py` 里配正对照） |
| ② | **同一张图有多个 URL**：`weibo_7471118487.jpg` 与 `weibo_7471118487_3d2b0b8a.jpg` **sha256 逐字节相同**（真实样本在 `tests/fixtures/light_assets.json`） | 换签名 ⇒ 仍然**一份文件、一行索引** |
| ③ | 用户选过的那张没有锚点 | 选中即 `pin`（`PUT /vtuber/{id}` 顺手打标记） |
| ④ | 索引说有、盘上没有（备份/手工删/淘汰）⇒ 绝不能返回一个不存在的路径 | `get()` 当**未命中** ⇒ 调用方重下；`put()` 复用**同一行**修复 |

## 判据为什么这么写

- **"不发请求"是收益本身**，不是实现细节 ⇒ 它在调度侧用**计数客户端**量（正对照：第一次必须发），
  本文件只量"命中/未命中"这个可判定的接口行为；
- **S-1（只许新增与登记）**：`remember()` 是给**盘上已有的历史文件**登记用的，
  判据明写"文件内容与所在位置都不许变"、且"不许顺手复制到 assets 目录"；
- **失败注入**：写盘失败必须是"既不留半截文件、也不留索引行"，否则崩溃后 `get()` 会信一行死索引。
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, LocalAsset, VTuber, VtuberAvatarHistory
from app.services import assets

FIXTURE = Path(__file__).parent / "fixtures" / "light_assets.json"
FX = json.loads(FIXTURE.read_text(encoding="utf-8"))
#: 真实样本：同一张图的两次抓取（微博每次换 Expires/ssig）
PAIR = FX["rotated_pairs"][0]
OLD_URL, NEW_URL = PAIR["old"]["url"], PAIR["new"]["url"]
BILI_URL = FX["bilibili_stable"]["url"]


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{(tmp_path / 'assets.db').as_posix()}",
                           connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    yield session
    session.close()


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """资产根（`<DATA_DIR>/static/assets`）指到 tmp_path。

    ⚠️ 真实运行时这里是**用户的数据目录**：不注入的话用例会往仓库根的
    `static/` 里写东西（而它不会红 —— 与 devlog/200 那批"后台任务连了开发库"同类）。
    与 `conftest.py` 的全局守卫同源，这里显式再声明一次是为了让判据自解释。
    """
    monkeypatch.setattr(assets, "data_root", lambda: tmp_path)
    return tmp_path


def _files(data_dir: Path, kind: str = assets.KIND_AVATAR) -> list[Path]:
    root = data_dir / "static" / "assets" / kind
    return sorted(p for p in root.rglob("*") if p.is_file()) if root.exists() else []


# ── 判据②：稳定键 ──────────────────────────────────────────────────────

def test_key_of_collapses_the_real_rotated_signature():
    """② 真实样本：同一张图的两次抓取（签名轮换）必须归一到**同一个键**。

    判据为什么必须有：键不归一 ⇒ 每轮抓取都是"新资源" ⇒ 重复下载 + 重复存储 +
    账本里同一张脸变成两个版本（这正是 2026-09-29 实测到的形态）。
    """
    for pair in FX["rotated_pairs"]:
        old, new = pair["old"]["url"], pair["new"]["url"]
        assert old != new, "样本本身必须是两个不同的 URL"
        assert assets.key_of(old) == assets.key_of(new), (
            f"签名轮换后键变了：{assets.key_of(old)!r} != {assets.key_of(new)!r}")
        key = assets.key_of(new)
        assert "Expires" not in key and "ssig" not in key and "KID" not in key
        # 业务部分（path）必须留着 —— 归一化只许丢签名参数
        assert urlparse(new).path in key
    # 对照组：B 站 URL 不带签名 ⇒ 键就是 URL 本身（归一化不许改变无签名 URL）
    assert assets.key_of(BILI_URL) == BILI_URL


def test_key_of_keeps_every_param_it_does_not_know():
    """白名单之外的参数**一律保留**：少归一化只是多存一份，误删参数会让不同资源撞成一个键。"""
    assert assets.key_of("https://x/a.jpg?w=100&h=200") == assets.key_of("https://x/a.jpg?h=200&w=100")
    assert assets.key_of("https://x/a.jpg?w=100") != assets.key_of("https://x/a.jpg?w=200")
    assert "w=100" in assets.key_of("https://x/a.jpg?w=100")
    assert assets.key_of("https://x/a.jpg#frag") == assets.key_of("https://x/a.jpg")
    assert assets.key_of("") == "" and assets.key_of("   ") == ""


# ── 判据①②：落盘 + 命中 ────────────────────────────────────────────────

def test_put_writes_the_file_and_second_sight_is_a_disk_hit(db, data_dir):
    row = assets.put(db, assets.KIND_AVATAR, NEW_URL, b"IMG-BYTES", hint="weibo_7471118487")
    db.commit()

    assert row.path.startswith("static/assets/avatar/weibo_7471118487_")
    assert row.path.endswith(".jpg"), "扩展名从 URL 路径推（不是从内容猜）"
    assert (data_dir / row.path).read_bytes() == b"IMG-BYTES"
    assert row.bytes == 9
    assert row.sha256 == hashlib.sha256(b"IMG-BYTES").hexdigest()
    assert row.pinned is False, "抓取来的默认不 pin（pin 是用户选择的结果）"

    hit = assets.get(db, assets.KIND_AVATAR, NEW_URL)
    assert hit is not None and hit.id == row.id and hit.path == row.path


def test_rotated_signature_reuses_the_same_file_and_row(db, data_dir):
    """② 真实事故形态：换签名 ⇒ **一份文件、一行索引**（不许复制第二份）。"""
    first = assets.put(db, assets.KIND_AVATAR, OLD_URL, b"IMG-BYTES", hint="weibo_7471118487")
    db.commit()

    # 第二次抓取：`get()` 按稳定键就命中了（调用方根本不会去下载）
    hit = assets.get(db, assets.KIND_AVATAR, NEW_URL)
    assert hit is not None, "换了签名的同一个资源必须命中"
    assert hit.path == first.path

    # 就算真的又下了一次，也只许落到同一个文件/同一行
    second = assets.put(db, assets.KIND_AVATAR, NEW_URL, b"IMG-BYTES", hint="weibo_7471118487")
    db.commit()
    assert second.id == first.id
    assert db.query(LocalAsset).count() == 1
    assert [p.name for p in _files(data_dir)] == [Path(first.path).name]
    assert second.url == NEW_URL, "行要记住最近一次见到的**完整** URL（回源用）"


def test_missing_file_is_a_miss_and_put_repairs_the_same_row(db, data_dir):
    """④ 索引说有、盘上没有 ⇒ 当**未命中**（否则 `get()` 会返回一个不存在的路径 ⇒ 破图）。"""
    row = assets.put(db, assets.KIND_AVATAR, NEW_URL, b"IMG-BYTES", hint="weibo_7471118487")
    db.commit()
    (data_dir / row.path).unlink()

    assert assets.get(db, assets.KIND_AVATAR, NEW_URL) is None, (
        "文件都不在了还报命中 —— 渲染侧会拿到一个死路径")
    assert assets.lookup(db, assets.KIND_AVATAR, NEW_URL) is not None, "行还在（诊断要看得出'索引有盘上没有'）"

    again = assets.put(db, assets.KIND_AVATAR, NEW_URL, b"IMG-BYTES", hint="weibo_7471118487")
    db.commit()
    assert again.id == row.id, "补下要复用同一行（不许留下两条指向同一张图的索引）"
    assert db.query(LocalAsset).count() == 1
    assert (data_dir / again.path).read_bytes() == b"IMG-BYTES"


def test_write_failure_leaves_neither_file_nor_row(db, data_dir, monkeypatch):
    """崩溃安全：先写文件、再写索引；写文件失败必须**什么都不留**。"""
    def boom(path):                      # noqa: ANN001 - 注入写盘失败
        raise OSError("磁盘满了")

    monkeypatch.setattr(assets, "_open_for_write", boom)
    with pytest.raises(OSError):
        assets.put(db, assets.KIND_AVATAR, NEW_URL, b"IMG-BYTES", hint="weibo_7471118487")
    db.rollback()
    assert _files(data_dir) == [], f"写盘失败留下了文件：{_files(data_dir)}"
    assert db.query(LocalAsset).count() == 0, "写盘失败却留下了索引行（`get()` 会信它）"


# ── S-1：`remember` 只登记，绝不搬迁/复制 ────────────────────────────────

def test_remember_registers_a_legacy_file_without_moving_it(db, data_dir):
    """S-1：`static/avatars/` 里的历史文件**留在原地**，只登记进索引。"""
    legacy_rel = PAIR["old"]["local_file"]
    legacy = data_dir / legacy_rel
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_bytes(b"REAL-CONTENT")
    stamp = legacy.stat().st_mtime_ns

    row = assets.remember(db, assets.KIND_AVATAR, OLD_URL, legacy_rel)
    db.commit()

    assert row is not None and row.path == legacy_rel
    assert row.bytes == len(b"REAL-CONTENT")
    assert legacy.read_bytes() == b"REAL-CONTENT", "登记动了用户的文件内容"
    assert legacy.stat().st_mtime_ns == stamp, "登记动了用户的文件（mtime 变了）"
    assert not (data_dir / "static" / "assets").exists(), "登记不许顺手把文件复制/搬迁到 assets 目录"
    # 换签名也认得它（不下载、不新登记）
    hit = assets.get(db, assets.KIND_AVATAR, NEW_URL)
    assert hit is not None and hit.id == row.id


def test_remember_merges_one_image_kept_in_two_legacy_files(db, data_dir):
    """② 的真实形态：同一张图在盘上有两个文件（R47 前后各一份，sha256 相同）⇒ 索引只有一行。"""
    first_rel, second_rel = PAIR["old"]["local_file"], PAIR["new"]["local_file"]
    for rel in (first_rel, second_rel):
        p = data_dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"REAL-CONTENT")

    a = assets.remember(db, assets.KIND_AVATAR, OLD_URL, first_rel)
    b = assets.remember(db, assets.KIND_AVATAR, NEW_URL, second_rel)
    db.commit()

    assert a is not None and b is not None
    assert a.id == b.id, "同一张图登记出两行（去重没生效）"
    assert db.query(LocalAsset).count() == 1
    assert b.url == NEW_URL, "要跟到最近一次见到的 URL"
    assert b.path == first_rel, "不许把已登记的路径改到另一个文件上（改路径 = 换图）"
    assert (data_dir / first_rel).exists() and (data_dir / second_rel).exists(), "两个文件都不许被删"


def test_remember_refuses_a_path_that_is_not_on_disk(db, data_dir):
    """先文件后索引：盘上没有的东西不许登记（否则留下一行指向虚空的索引）。"""
    assert assets.remember(db, assets.KIND_AVATAR, OLD_URL, "static/avatars/nope.jpg") is None
    assert db.query(LocalAsset).count() == 0


# ── 判据⑤：pin 与 prune ────────────────────────────────────────────────

def _seed(db, *urls: str, size: int = 100):
    """按顺序造资产，`last_used_at` 递增（LRU 顺序确定：越早越旧）。"""
    base = datetime(2026, 9, 29, 10, 0, 0)
    rows = []
    for i, url in enumerate(urls):
        row = assets.put(db, assets.KIND_AVATAR, url, b"x" * size, hint=f"w{i}")
        row.last_used_at = base + timedelta(minutes=i)
        row.created_at = base + timedelta(minutes=i)
        rows.append(row)
    db.commit()
    return rows


def _kind_report(report: dict, kind: str = assets.KIND_AVATAR) -> dict:
    """prune 的报告**永远**是"按 kind 分账"的（一种形状，不给单 kind 特例）。"""
    return report["kinds"][kind]


def test_prune_keeps_pinned_and_evicts_the_oldest(db, data_dir):
    """⑤ 用户选过的（pin）**永不被清**；其余的按 LRU 淘汰到上限以内。"""
    rows = _seed(db, "https://x/0.jpg", "https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg")
    assets.pin(db, assets.KIND_AVATAR, "https://x/0.jpg")
    db.commit()

    got = _kind_report(assets.prune(db, assets.KIND_AVATAR, max_bytes=250, dry_run=False))

    left = {r.key for r in db.query(LocalAsset).all()}
    assert assets.key_of("https://x/0.jpg") in left, "pin 的那份被清掉了（用户的选择会破图）"
    assert assets.key_of("https://x/3.jpg") in left, "该留最新用的那份"
    assert assets.key_of("https://x/1.jpg") not in left and assets.key_of("https://x/2.jpg") not in left
    assert (data_dir / rows[0].path).exists(), "pin 的文件不许删"
    assert not (data_dir / rows[1].path).exists(), "淘汰要连文件一起删（否则盘只增不减）"
    assert got["freed_bytes"] == 200
    assert got["after_bytes"] == 200 and got["after_files"] == 2
    assert {c["key"] for c in got["evicted"]} == {assets.key_of("https://x/1.jpg"),
                                                 assets.key_of("https://x/2.jpg")}


def test_prune_never_deletes_an_asset_still_referenced(db, data_dir):
    """被引用的不许清：`vtubers.avatar`（选中）/ 账号 `avatar_url` / 历次头像账本。

    ⚠️ 封面（`posts.cover_local`）那条引用要等 L3 —— 本批还没有 cover 资产。
    """
    rows = _seed(db, "https://x/0.jpg", "https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg")

    v = VTuber(name="引用V", avatar="https://x/0.jpg")          # 用户显式选中
    db.add(v)
    db.flush()
    db.add(Account(vtuber_id=v.id, platform="weibo", platform_uid="w1",
                   avatar_url="https://x/1.jpg", followers_count=0))   # 账号现值
    db.add(VtuberAvatarHistory(vtuber_id=v.id, avatar_url="https://x/2.jpg",
                               avatar_path=rows[2].path, platform="weibo"))   # 账本行
    db.commit()

    assets.prune(db, assets.KIND_AVATAR, max_bytes=0, dry_run=False)   # 0 = 想清空

    assert sorted(p.name for p in _files(data_dir)) == sorted(
        Path(r.path).name for r in rows[:3]), "被引用的三份应当原样留着，只清掉没人引用的那份"
    left_keys = {r.key for r in db.query(LocalAsset).all()}
    assert assets.key_of("https://x/3.jpg") not in left_keys


def test_prune_dry_run_matches_the_real_run(db, data_dir):
    """dry-run 与实际删除**必须是同一个集合**（否则设置页上的"将要清理"是骗人的）。"""
    _seed(db, "https://x/0.jpg", "https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg")

    dry = assets.prune(db, assets.KIND_AVATAR, max_bytes=250, dry_run=True)
    assert dry["dry_run"] is True
    assert len(_kind_report(dry)["evicted"]) == 2
    assert len(_files(data_dir)) == 4 and db.query(LocalAsset).count() == 4, "dry-run 不许动任何东西"

    real = assets.prune(db, assets.KIND_AVATAR, max_bytes=250, dry_run=False)
    assert ([c["key"] for c in _kind_report(real)["evicted"]]
            == [c["key"] for c in _kind_report(dry)["evicted"]])
    assert _kind_report(real)["freed_bytes"] == _kind_report(dry)["freed_bytes"]


def test_prune_leaves_a_kind_without_a_cap_alone(db, data_dir):
    """头像没有上限（用户口径：pin 的全留、抓到的都留）⇒ 默认 prune 一个都不许删。"""
    _seed(db, "https://x/0.jpg", "https://x/1.jpg")
    report = assets.prune(db, assets.KIND_AVATAR, dry_run=False)
    assert _kind_report(report)["evicted"] == [] and len(_files(data_dir)) == 2
    assert _kind_report(report)["max_bytes"] is None, "头像的默认上限就是'不限'"


def test_stats_counts_files_bytes_and_reports_dead_rows(db, data_dir):
    rows = _seed(db, "https://x/0.jpg", "https://x/1.jpg")
    assets.pin(db, assets.KIND_AVATAR, "https://x/0.jpg")
    db.commit()
    (data_dir / rows[1].path).unlink()          # 盘上少了一份

    st = assets.stats(db)
    av = st[assets.KIND_AVATAR]
    assert av["files"] == 1 and av["bytes"] == 100
    assert av["pinned"] == 1
    assert av["missing"] == 1, "索引有、盘上没有的条数必须报出来（否则'哪块在长/哪块在漏'答不了）"
    assert av["oldest"] is not None
