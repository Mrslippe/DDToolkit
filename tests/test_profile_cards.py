# -*- coding: utf-8 -*-
"""档案视图卡片布局（R37-P2，devlog/142）护栏。

用户口径（2026-09-17）：「以卡片为基本单位，用户可以编辑卡片的大小、位置、排布」。
本批是 P2 的**落库那一半**（拖拽手势在前端，由探针守），所以这里钉四件事：

1. **整版替换**是原子的：写第二次不会留下第一次的残行（否则画布上会冒出幽灵卡片）；
2. **越界 / 重复 card_key 报错而不是夹取** —— 夹取会把前端的排布 bug 静默写进库，
   用户下次打开只会觉得"卡片自己动了"，且查不出是谁改的；
3. **删 V 必须连布局一起清**（`profile_cards` 挂 `vtubers.id` 外键）——
   漏清会让 `DELETE FROM vtubers` 被外键挡下、**整次事务回滚**（devlog/040 那次事故的形态）；
4. 空列表 = 「还没排过」而不是错误：前端据此用默认布局渲染。
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.core.database import Base, get_db
from app.main import app
from app.models.vtuber import Account, Post, ProfileCard, VTuber
from app.repositories.vtuber_repo import ProfileCardRepo
from app.services.purge import purge_vtuber

# ⚠️ 必须用**文件库**而不是 `sqlite://` 内存库：TestClient 把请求跑在另一个线程里，
# 内存库每个新连接都是一份**空**数据库（第一版就撞上 "no such table: vtubers"）。
# 与 tests/test_vtuber_api.py 同款，另加外键 PRAGMA —— 没有它，"删 V 被外键挡下"
# 这类事故（本文件第 ③ 组要守的）根本测不出来。
test_engine = create_engine("sqlite:///./test_profile_cards.db",
                            connect_args={"check_same_thread": False})


@event.listens_for(test_engine, "connect")
def _fk_on(dbapi_connection, _record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


TestingSession = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.drop_all(bind=test_engine)
    Base.metadata.create_all(bind=test_engine)
    yield


@pytest.fixture
def db():
    s = TestingSession()
    yield s
    s.close()


@pytest.fixture
def client(db):
    """装上本文件的 get_db 覆盖，用完**还原**（不是 `clear()`）。

    ⚠️ 第一版在 teardown 里 `app.dependency_overrides.clear()` —— 而
    `tests/test_vtuber_api.py` 是在**模块导入时**就装好覆盖的，于是本文件跑完把它的
    覆盖一起清掉，那个文件里 **35 条用例**当场全红（KeyError）。跨模块的全局状态
    只能"存旧值 → 换新值 → 还原"，不能清场。
    """
    def _override():
        yield db
    prev = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override
    yield TestClient(app)
    if prev is not None:
        app.dependency_overrides[get_db] = prev
    else:
        app.dependency_overrides.pop(get_db, None)


def _mk_v(db, name="V") -> VTuber:
    v = VTuber(name=name)
    db.add(v)
    db.commit()
    return v


def _card(key="anniversary", kind=None, x=0, y=0, w=5, h=3) -> dict:
    return {"card_key": key, "kind": kind or key, "x": x, "y": y, "w": w, "h": h}


# ── ① Repo：整版替换 ────────────────────────────────────────────────

def test_replace_all_is_a_full_replacement(db):
    v = _mk_v(db)
    repo = ProfileCardRepo(db)
    repo.replace_all(v.id, [_card("a", x=0), _card("b", x=5, w=7)])
    assert [(c.card_key, c.x) for c in repo.by_vtuber(v.id)] == [("a", 0), ("b", 5)]

    # 第二次只留一张 ⇒ 旧的 b 必须消失（不是"追加"）
    repo.replace_all(v.id, [_card("a", x=6, w=6)])
    rows = repo.by_vtuber(v.id)
    assert [c.card_key for c in rows] == ["a"]
    assert rows[0].x == 6 and rows[0].w == 6


def test_replace_all_with_empty_clears(db):
    v = _mk_v(db)
    repo = ProfileCardRepo(db)
    repo.replace_all(v.id, [_card("a")])
    repo.replace_all(v.id, [])
    assert repo.by_vtuber(v.id) == []


def test_by_vtuber_sorted_by_reading_order(db):
    v = _mk_v(db)
    ProfileCardRepo(db).replace_all(v.id, [
        _card("low", x=6, y=4), _card("top", x=0, y=0), _card("top-right", x=6, y=0),
    ])
    assert [c.card_key for c in ProfileCardRepo(db).by_vtuber(v.id)] == [
        "top", "top-right", "low"]


def test_layout_is_per_vtuber(db):
    a, b = _mk_v(db, "A"), _mk_v(db, "B")
    repo = ProfileCardRepo(db)
    repo.replace_all(a.id, [_card("a1")])
    repo.replace_all(b.id, [_card("b1"), _card("b2", x=5, w=7)])
    assert [c.card_key for c in repo.by_vtuber(a.id)] == ["a1"]
    assert [c.card_key for c in repo.by_vtuber(b.id)] == ["b1", "b2"]


def test_same_key_twice_in_one_save_is_rejected_by_db(db):
    """DB 侧唯一键兜底（路由层的校验是主闸，这里是第二道）。"""
    from sqlalchemy.exc import IntegrityError
    v = _mk_v(db)
    with pytest.raises(IntegrityError):
        ProfileCardRepo(db).replace_all(v.id, [_card("dup"), _card("dup")])


# ── ② 路由契约 ──────────────────────────────────────────────────────

def test_get_empty_layout_means_not_arranged_yet(client, db):
    v = _mk_v(db)
    r = client.get(f"/vtuber/{v.id}/profile-cards")
    assert r.status_code == 200
    assert r.json() == []


def test_get_unknown_vtuber_404(client):
    assert client.get("/vtuber/9999/profile-cards").status_code == 404


def test_put_then_get_roundtrip(client, db):
    v = _mk_v(db)
    payload = {"cards": [_card("anniversary", x=0, w=5), _card("top-posts", x=5, w=7)]}
    r = client.put(f"/vtuber/{v.id}/profile-cards", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert [(c["card_key"], c["x"], c["w"]) for c in body] == [
        ("anniversary", 0, 5), ("top-posts", 5, 7)]
    assert all(c["id"] > 0 for c in body)          # 服务端重新分配 id

    again = client.get(f"/vtuber/{v.id}/profile-cards").json()
    assert [c["card_key"] for c in again] == ["anniversary", "top-posts"]


def test_put_rejects_out_of_grid(client, db):
    """x + w > 12 ⇒ 422（**不夹取**：夹取会把前端 bug 静默写进库）。"""
    v = _mk_v(db)
    r = client.put(f"/vtuber/{v.id}/profile-cards",
                   json={"cards": [_card("a", x=8, w=6)]})
    assert r.status_code == 422
    assert client.get(f"/vtuber/{v.id}/profile-cards").json() == []


def test_put_rejects_duplicate_keys(client, db):
    v = _mk_v(db)
    r = client.put(f"/vtuber/{v.id}/profile-cards",
                   json={"cards": [_card("same"), _card("same", x=6, w=6)]})
    assert r.status_code == 422


def test_put_rejects_bad_ranges(client, db):
    v = _mk_v(db)
    for bad in (_card("z", w=0), _card("z", h=0), _card("z", x=-1), _card("z", y=-1)):
        assert client.put(f"/vtuber/{v.id}/profile-cards",
                          json={"cards": [bad]}).status_code == 422


def test_put_unknown_vtuber_404(client):
    r = client.put("/vtuber/9999/profile-cards", json={"cards": [_card("a")]})
    assert r.status_code == 404


def test_put_too_many_cards_rejected(client, db):
    v = _mk_v(db)
    cards = [_card(f"k{i}", x=i % 12, w=1) for i in range(51)]
    assert client.put(f"/vtuber/{v.id}/profile-cards",
                      json={"cards": cards}).status_code == 422


# ── ③ 删 V 连带清布局（外键陷阱） ───────────────────────────────────

def test_purge_vtuber_clears_profile_cards(db):
    v = _mk_v(db)
    db.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid="1"))
    db.add(Post(platform="bilibili", platform_uid="1", platform_post_id="p1", type="text"))
    db.commit()
    ProfileCardRepo(db).replace_all(v.id, [_card("a"), _card("b", x=5, w=7)])

    counts = purge_vtuber(db, v)
    db.commit()
    assert counts["profile_cards"] == 2
    assert db.query(ProfileCard).count() == 0

    # 清干净之后 ORM 级联删得掉（漏清的话这里会被外键挡下 → 整次回滚）
    db.delete(v)
    db.commit()
    assert db.query(VTuber).count() == 0


def test_profile_card_table_has_no_orphan_rows_after_purge(db):
    """第二道：purge 之后库里不许留下指向已删 V 的卡片行。"""
    v = _mk_v(db)
    ProfileCardRepo(db).replace_all(v.id, [_card("a")])
    purge_vtuber(db, v)
    db.commit()
    db.delete(v)
    db.commit()
    assert db.query(ProfileCard).filter(ProfileCard.vtuber_id == v.id).count() == 0