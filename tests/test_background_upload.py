# -*- coding: utf-8 -*-
"""背景上传加固（M3b，批次 11b，devlog/214）。

改前的实现是「先删旧文件、再写新文件」（`routers/vtuber.py`）：
**写新文件失败就把用户原来的背景弄丢了**，而 DB 里还指着那个已经不存在的路径。
本文件钉住四条不变量（每条都能被一种"改回去"的写法弄红）：

| # | 不变量 | 改回旧写法会怎样 |
|---|---|---|
| ① | 限额在**读的时候**生效（按块读、超限立刻停） | 先 `await file.read()` 全量进内存再判大小 |
| ② | 类型按**文件头**判（声明只是提示，矛盾时拒绝） | 只看 `content_type` ⇒ 把 HTML 改成 .jpg 就能存进来 |
| ③ | **新背景提交成功之后**才删旧文件 | 先删旧 ⇒ 写盘失败即丢背景 |
| ④ | 任何失败都**不留临时文件**、DB 值不动 | 半份 `.uploading` 留在目录里 / DB 指向不存在的文件 |

⚠️ "写盘失败"是**真的注入**的（`_open_for_write` 与 `os.replace` 两个缝），
不是只测 happy path —— ③ 这条不变量本来就是为失败路径存在的。
"""
from __future__ import annotations

import asyncio
import atexit
import shutil
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.core.database import Base, get_db
from app.main import app
from app.models.vtuber import VTuber
from app.services import vtuber_background as bg

_TMPDIR = Path(tempfile.mkdtemp(prefix="ddtoolkit-test-bg-"))
atexit.register(shutil.rmtree, _TMPDIR, ignore_errors=True)

test_engine = create_engine(f"sqlite:///{(_TMPDIR / 'bg.db').as_posix()}",
                            connect_args={"check_same_thread": False})
TestingSession = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 200          # 真文件头 + 垃圾体（够判类型）
JPEG = b"\xff\xd8\xff\xe0" + b"0" * 200
WEBP = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"0" * 200


def _override_get_db():
    db = TestingSession()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _env(tmp_path_factory, monkeypatch):
    """测试库 + 独立数据目录（走工作区临时目录：`%TEMP%` 在本机不一定有权限）。"""
    from app.core.config import settings

    data_dir = _TMPDIR / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "DATA_DIR", data_dir)

    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db
    Base.metadata.create_all(bind=test_engine)
    yield data_dir
    if previous is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous
    Base.metadata.drop_all(bind=test_engine)
    shutil.rmtree(data_dir, ignore_errors=True)


@pytest.fixture
def client():
    """⚠️ 不用 `with TestClient(app)`：那会跑 lifespan ⇒ 起真调度器、碰真数据目录。"""
    return TestClient(app)


def _mk_v() -> int:
    db = TestingSession()
    try:
        v = VTuber(name="背景测试")
        db.add(v)
        db.commit()
        db.refresh(v)
        return v.id
    finally:
        db.close()


def _db_path(vid: int) -> str | None:
    db = TestingSession()
    try:
        return db.query(VTuber).filter(VTuber.id == vid).one().background_path
    finally:
        db.close()


def _upload(client, vid, data, content_type, name="bg.bin"):
    return client.post(f"/vtuber/{vid}/background",
                       files={"file": (name, data, content_type)})


def _files(data_dir: Path) -> list[str]:
    d = data_dir / "static" / "custom_bg"
    return sorted(p.name for p in d.iterdir()) if d.exists() else []


# ── happy path + 替换 ──────────────────────────────────────────────────

def test_upload_then_replace_keeps_only_the_new_file(client, _env):
    vid = _mk_v()
    r1 = _upload(client, vid, PNG, "image/png", "a.png")
    assert r1.status_code == 200
    first = r1.json()["background_path"]
    assert first.startswith("static/custom_bg/") and first.endswith(".png")
    assert (_env / first).exists()

    r2 = _upload(client, vid, JPEG, "image/jpeg", "b.jpg")
    assert r2.status_code == 200
    second = r2.json()["background_path"]
    assert second.endswith(".jpg") and second != first
    assert (_env / second).exists()
    assert not (_env / first).exists(), "换了新背景，旧文件该在**提交成功之后**删掉"
    assert _db_path(vid) == second
    assert _files(_env) == [Path(second).name], f"目录里留下了不该有的东西：{_files(_env)}"


# ── ② 类型：内容说了算 ─────────────────────────────────────────────────

def test_content_wins_over_a_missing_or_unknown_declaration(client, _env):
    """声明不认识（octet-stream）但内容是真 PNG ⇒ 收（旧实现会因为声明不在白名单而 415）。"""
    vid = _mk_v()
    r = _upload(client, vid, PNG, "application/octet-stream")
    assert r.status_code == 200
    assert r.json()["background_path"].endswith(".png")


def test_declared_type_contradicting_the_content_is_rejected(client, _env):
    """真 JPEG 却说自己是 PNG ⇒ 415（吵闹的失败），且**一个文件都不留**。"""
    vid = _mk_v()
    r = _upload(client, vid, JPEG, "image/png", "lie.png")
    assert r.status_code == 415
    assert "声明" in r.json()["detail"]
    assert _db_path(vid) is None
    assert _files(_env) == [], f"被拒的上传留下了文件：{_files(_env)}"


def test_html_disguised_as_an_image_is_rejected_by_magic_bytes(client, _env):
    """改扩展名把 HTML 存进 static 是这条判据要防的事（旧实现只看 content_type）。"""
    vid = _mk_v()
    r = _upload(client, vid, b"<html><script>alert(1)</script></html>", "image/png")
    assert r.status_code == 415
    assert _files(_env) == []
    assert _db_path(vid) is None


def test_webp_and_gif_magic_are_recognised(client, _env):
    vid = _mk_v()
    assert _upload(client, vid, WEBP, "image/webp").json()["background_path"].endswith(".webp")
    assert _upload(client, vid, b"GIF89a" + b"0" * 100, "image/gif").status_code == 200


# ── ① 限额：读的时候就停 ───────────────────────────────────────────────

def test_oversized_upload_is_rejected(client, _env):
    vid = _mk_v()
    too_big = PNG + b"0" * (bg.MAX_BYTES + 1)
    r = _upload(client, vid, too_big, "image/png")
    assert r.status_code == 413
    assert _db_path(vid) is None
    assert _files(_env) == []


def test_size_header_short_circuits_without_reading():
    """有 `size`（Content-Length）时**一个字节都不读** —— 防的是"先吃满内存再判大小"。"""
    class _Upload:
        content_type = "image/png"
        size = bg.MAX_BYTES + 1
        reads = 0

        async def read(self, _n):
            type(self).reads += 1
            return b"x"

    with pytest.raises(bg.BackgroundTooLarge):
        asyncio.run(bg.save_background(1, _Upload(), _TMPDIR / "short"))
    assert _Upload.reads == 0, "超限的请求不该被读进来"
    assert not (_TMPDIR / "short").exists(), "被拒的上传不该建目录/留文件"


# ── ③④ 失败路径：旧背景不许丢，临时文件不许留 ──────────────────────────

def _seed_background(client, vid) -> str:
    r = _upload(client, vid, PNG, "image/png", "old.png")
    assert r.status_code == 200
    return r.json()["background_path"]


def test_write_failure_keeps_the_old_background(client, _env, monkeypatch):
    vid = _mk_v()
    old = _seed_background(client, vid)

    def _boom(_path):
        raise OSError("磁盘满")

    monkeypatch.setattr(bg, "_open_for_write", _boom)
    with pytest.raises(OSError):
        _upload(client, vid, JPEG, "image/jpeg")

    assert (_env / old).exists(), "写盘失败把旧背景弄丢了（改前就是这个毛病）"
    assert _db_path(vid) == old
    assert _files(_env) == [Path(old).name]


def test_partial_write_failure_leaves_no_temp_file(client, _env, monkeypatch):
    """写到一半炸（真实的"磁盘满"形态）：半份临时文件必须清掉，旧背景还在。"""
    vid = _mk_v()
    old = _seed_background(client, vid)

    class _HalfWriter:
        def __init__(self, path):
            self._fh = path.open("wb")
            self._writes = 0

        def write(self, data):
            self._writes += 1
            if self._writes > 1:
                raise OSError("磁盘满（写到一半）")
            return self._fh.write(data)

        def close(self):
            self._fh.close()

    monkeypatch.setattr(bg, "_open_for_write", _HalfWriter)
    with pytest.raises(OSError):
        _upload(client, vid, PNG + b"0" * (bg.CHUNK_BYTES * 2), "image/png")

    assert _files(_env) == [Path(old).name], f"留下了半成品：{_files(_env)}"
    assert _db_path(vid) == old
    assert (_env / old).exists()


def test_rename_failure_keeps_the_old_background(client, _env, monkeypatch):
    vid = _mk_v()
    old = _seed_background(client, vid)

    def _boom(*_a, **_k):
        raise OSError("rename 失败")

    monkeypatch.setattr(bg.os, "replace", _boom)
    with pytest.raises(OSError):
        _upload(client, vid, JPEG, "image/jpeg")

    assert _files(_env) == [Path(old).name]
    assert _db_path(vid) == old
    assert (_env / old).exists()


def test_commit_failure_removes_the_new_file_and_keeps_the_old_one(client, _env, monkeypatch):
    """新文件写好了但 DB 提交失败 ⇒ 删掉新文件（孤儿），旧背景与 DB 值原样不动。"""
    vid = _mk_v()
    old = _seed_background(client, vid)

    def _boom(self, *a, **k):
        raise RuntimeError("提交失败")

    monkeypatch.setattr(Session, "commit", _boom)
    with pytest.raises(RuntimeError):
        _upload(client, vid, JPEG, "image/jpeg")
    monkeypatch.undo()

    assert _files(_env) == [Path(old).name], f"提交失败留下的新文件成了孤儿：{_files(_env)}"
    assert _db_path(vid) == old
    assert (_env / old).exists()


def test_missing_old_file_is_not_an_error(client, _env):
    """旧文件被用户手工删过：换新背景照常成功（`unlink(missing_ok)` 语义）。"""
    vid = _mk_v()
    old = _seed_background(client, vid)
    (_env / old).unlink()

    r = _upload(client, vid, JPEG, "image/jpeg")
    assert r.status_code == 200
    assert _files(_env) == [Path(r.json()["background_path"]).name]


# ── 清除背景走同一套删除逻辑 ───────────────────────────────────────────

def test_clear_background_removes_file_and_field(client, _env):
    vid = _mk_v()
    rel = _seed_background(client, vid)
    r = client.delete(f"/vtuber/{vid}/background")
    assert r.status_code == 200 and r.json()["background_path"] is None
    assert not (_env / rel).exists()
    assert _files(_env) == []


def test_background_path_cannot_escape_the_directory(client, _env):
    """库里的值只取文件名 —— 一个被写坏的 `background_path` 不能删到目录外。"""
    outside = _TMPDIR / "outside.txt"
    outside.write_text("别删我", encoding="utf-8")
    assert bg.remove_background(_env / "static" / "custom_bg",
                                "../../outside.txt") is False
    assert outside.exists()
