"""小红书收录（`POST /vtuber/adopt`，第 4 阶段 ④ 第三刀-3，devlog/234）。

小红书**没有可用的搜索接口**（搜索要 `xsec_token`，调研 §2.4），所以收录走
"uid → 主页信息"这条路：既复核"这个人真的存在"，又拿到规范名（与 B 站那条
"池外必须服务端复核"的纪律一致）。

⚠️ 不起真 app（`TestClient` 会带起 lifespan，实测与别的用例互相干扰）⇒ 这里直接调
端点函数，`background` 用替身（收录的响应不该等抓取，见端点 docstring）。
"""
import asyncio
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.vtuber import Account, VTuber
from app.routers import vtuber as R


class FakeBG:
    def __init__(self):
        self.tasks = []

    def add_task(self, fn, *a, **kw):
        self.tasks.append((fn, a, kw))


class FakeXhs:
    platform = "xiaohongshu"

    def __init__(self, info=None, kind=None):
        self._info = info
        self.last_error = {"kind": kind} if kind else None
        self.calls: list[str] = []

    async def fetch_user_info(self, uid, client=None):
        self.calls.append(str(uid))
        return self._info


def _db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _data(uid="u1", platform="xiaohongshu", source="xiaohongshu"):
    return R.AdoptRequest(platform=platform, platform_uid=uid, source=source)


def _patch(monkeypatch, fake):
    monkeypatch.setattr(R.registry, "get_fetcher", lambda p: fake if p == "xiaohongshu" else None)
    # 池里没有 ⇒ 走池外分支
    monkeypatch.setattr(R.pool, "find_in_pool", lambda p, u: None)
    monkeypatch.setattr(R, "_adopt_background", lambda *a, **kw: None)


def test_adopt_xiaohongshu_creates_account_and_uses_server_side_name(monkeypatch):
    db = _db()
    fake = FakeXhs(info={"name": "服务端查到的名字", "followers_count": 12})
    _patch(monkeypatch, fake)
    bg = FakeBG()

    out = asyncio.run(R.adopt_vtuber(data=_data(), background=bg, db=db))

    assert fake.calls == ["u1"], "必须用 uid 去复核"
    acc = db.query(Account).first()
    assert acc is not None and acc.platform == "xiaohongshu" and acc.platform_uid == "u1"
    assert db.query(VTuber).first().name == "服务端查到的名字", "名字只认服务端复核结果"
    assert out.name == "服务端查到的名字"
    db.close()


def test_adopt_xiaohongshu_without_cookie_is_503_not_404(monkeypatch):
    """没配 cookie（或失效）要说"我们没问到"，**不能**报成"小红书没这个人"。"""
    db = _db()
    _patch(monkeypatch, FakeXhs(info=None, kind="cookie_invalid"))

    with pytest.raises(HTTPException) as e:
        asyncio.run(R.adopt_vtuber(data=_data(), background=FakeBG(), db=db))
    assert e.value.status_code == 503 and "cookie" in str(e.value.detail)
    assert db.query(Account).count() == 0, "复核没过不许建库"
    db.close()


def test_adopt_xiaohongshu_not_found_is_404(monkeypatch):
    db = _db()
    _patch(monkeypatch, FakeXhs(info=None))      # 没有 last_error = 上游确实说没有

    with pytest.raises(HTTPException) as e:
        asyncio.run(R.adopt_vtuber(data=_data(), background=FakeBG(), db=db))
    assert e.value.status_code == 404
    db.close()


def test_adopt_xiaohongshu_source_requires_matching_platform(monkeypatch):
    """`source='xiaohongshu'` 却给了 `platform='weibo'` ⇒ 400（别静默换平台）。"""
    db = _db()
    _patch(monkeypatch, FakeXhs(info={"name": "x"}))

    with pytest.raises(HTTPException) as e:
        asyncio.run(R.adopt_vtuber(data=_data(platform="weibo"), background=FakeBG(), db=db))
    assert e.value.status_code == 400
    db.close()
