"""打包形态的数据路径用例（2026-10-18）。

三条判据，都是"打包出去会坏、开发环境看不出来"的那类：

1. **全新安装**：数据根不存在时，`resolve_data_dir(create=True)` 要**创建**它
   —— 否则采集在 `mkdir` 之前就抛了（`collect()` 第一行就是解析数据根）。
2. **开发检出不许污染仓库**：`DATA_DIR == PROJECT_ROOT` 时 `create=True` **不许**建
   `<repo>/fan-structure`。
3. **主播清单是动态的**：来自库里的 B 站账号，子目录按 `subdir_for(mid)`（开发样本沿用
   `pilot_v3_*`，其余 `bili-<mid>`）—— 不是硬编码那三个样本。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.fan import loader


class _Settings:
    """替身：只改 DATA_DIR / PROJECT_ROOT，避免真去动全局配置。"""

    def __init__(self, data_dir: Path, project_root: Path) -> None:
        self.DATA_DIR = data_dir
        self.PROJECT_ROOT = project_root


@pytest.fixture()
def fake_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    def _apply(data_dir: Path, project_root: Path) -> None:
        monkeypatch.setitem(loader.__dict__, "settings", _Settings(data_dir, project_root))
        monkeypatch.delenv(loader.DATA_DIR_ENV, raising=False)

    return _apply


# ── 1. 全新安装：按需创建 ─────────────────────────────────────────────────
def test_create_makes_prod_dir_on_fresh_install(tmp_path: Path, fake_settings) -> None:
    """打包形态（DATA_DIR ≠ 仓库根）且数据根不存在 ⇒ create=True 要把它建出来。"""
    data_dir = tmp_path / "user-data"
    data_dir.mkdir()
    fake_settings(data_dir, tmp_path / "repo")

    with pytest.raises(loader.FanDataNotFound):
        loader.resolve_data_dir(create=False)      # 只读解析：不建，抛

    got = loader.resolve_data_dir(create=True)
    assert got == data_dir / loader.PROD_SUBDIR
    assert got.is_dir(), "create=True 必须真的建出目录"


def test_ensure_data_dir_is_create_alias(tmp_path: Path, fake_settings) -> None:
    data_dir = tmp_path / "d"
    data_dir.mkdir()
    fake_settings(data_dir, tmp_path / "repo")
    assert loader.ensure_data_dir().is_dir()


# ── 2. 开发检出不许往仓库里建 ─────────────────────────────────────────────
def test_dev_checkout_never_creates_in_repo(tmp_path: Path, fake_settings) -> None:
    """`DATA_DIR == PROJECT_ROOT` ⇒ create=True 也不许建 `<repo>/fan-structure`。"""
    repo = tmp_path / "repo"
    repo.mkdir()
    fake_settings(repo, repo)

    with pytest.raises(loader.FanDataNotFound):
        loader.resolve_data_dir(create=True)
    assert not (repo / loader.PROD_SUBDIR).exists(), "开发检出被污染了"


def test_dev_checkout_prefers_existing_dev_dir(tmp_path: Path, fake_settings) -> None:
    repo = tmp_path / "repo"
    dev = repo.joinpath(*loader.DEV_SUBDIR)
    dev.mkdir(parents=True)
    fake_settings(repo, repo)
    assert loader.resolve_data_dir(create=True) == dev


def test_env_override_wins_and_is_created(tmp_path: Path, fake_settings,
                                          monkeypatch: pytest.MonkeyPatch) -> None:
    """显式指定 `DDTOOLKIT_FAN_DATA_DIR` 时，create=True 也按它建。"""
    fake_settings(tmp_path / "d", tmp_path / "repo")
    target = tmp_path / "explicit"
    monkeypatch.setenv(loader.DATA_DIR_ENV, str(target))
    assert loader.resolve_data_dir(create=True) == target
    assert target.is_dir()


# ── 3. 动态清单 ───────────────────────────────────────────────────────────
def test_subdir_for_keeps_dev_names_and_mid_keys_the_rest() -> None:
    assert loader.subdir_for("1789460279") == "pilot_v3_mizuki"
    assert loader.subdir_for("123456") == "bili-123456"


def test_list_vtubers_from_db(tmp_path: Path, fake_settings, monkeypatch) -> None:
    """库里有 B 站账号的主播要出现在清单里，子目录按 mid 生成。"""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    from app.models.vtuber import Account, VTuber

    engine = create_engine(f"sqlite:///{(tmp_path / 'db.sqlite').as_posix()}")
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    try:
        v = VTuber(name="某个新主播")
        db.add(v)
        db.flush()
        db.add(Account(vtuber_id=v.id, platform="bilibili", platform_uid="999888"))
        db.commit()

        data_dir = tmp_path / "user-data"
        (data_dir / loader.PROD_SUBDIR).mkdir(parents=True)
        fake_settings(data_dir, tmp_path / "repo")

        got = loader.list_vtubers(db)
        assert [x.mid for x in got] == ["999888"]
        assert got[0].subdir == "bili-999888"
        assert got[0].name == "某个新主播"
    finally:
        db.close()


def test_list_vtubers_falls_back_to_legacy_only_when_data_exists(
    tmp_path: Path, fake_settings,
) -> None:
    """空库时只补**数据目录真的存在**的开发样本 —— 免得界面出现点进去没数据的条目。"""
    data_dir = tmp_path / "user-data"
    base = data_dir / loader.PROD_SUBDIR
    (base / "pilot_v3_mizuki" / "stats").mkdir(parents=True)
    fake_settings(data_dir, tmp_path / "repo")

    got = loader.list_vtubers(None)
    assert [x.short for x in got] == ["弥月"], "只有真存在数据的那个样本该出现"


def test_get_vtuber_accepts_mid_and_subdir(tmp_path: Path, fake_settings) -> None:
    data_dir = tmp_path / "u"
    (data_dir / loader.PROD_SUBDIR).mkdir(parents=True)
    fake_settings(data_dir, tmp_path / "repo")
    assert loader.get_vtuber("1789460279").short == "弥月"
    assert loader.get_vtuber("pilot_v3_mizuki").short == "弥月"


# ── 4. 采集在全新安装上能跑（目录不存在也不炸）────────────────────────────
def test_collect_creates_data_dir_on_fresh_install(tmp_path: Path, fake_settings,
                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    """闭环的另一半：`collect()` 第一行解析数据根，全新安装时不能抛。"""
    import asyncio

    from app.services.fan import collector as col

    data_dir = tmp_path / "fresh"
    data_dir.mkdir()
    fake_settings(data_dir, tmp_path / "repo")

    async def fake_get(client, path, params, **kw):
        return {"data": {"data": {"danmakus": [
            {"type": 0, "uId": 1, "uName": "a", "sendDate": 1_790_000_000_000}
        ] * 200}}}

    monkeypatch.setattr(col, "_get_json", fake_get)
    v = loader.VtuberRef("新V", "bili-777", "777", "新V")
    prog = asyncio.run(col.collect(
        v, "2026-09-01", "2026-09-30", root=None,
        progress=col.CollectProgress("新V", "a", "b"),
        sessions=[col.SessionPlan("aaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "2026-09-15 20:00:00")]))

    assert prog.done == 1, prog.message
    assert (data_dir / loader.PROD_SUBDIR / "bili-777" / "stats").is_dir()
