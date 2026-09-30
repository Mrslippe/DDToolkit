"""轻资产长期储存模块（L1，devlog/257）：稳定键 + 索引 + 落盘。

## 一句话

把「**小、不变、反复要**」的远端资源（头像 / 帖子封面…）按**稳定键**固化进数据目录，
配一份 SQLite 索引（`local_assets`）⇒「再要一次」从**再发一次请求**变成**读盘**。
规格是 `docs/backend/ASSETS.md`，分批方案是 `docs/plans/light-assets-execution.md`。

## 为什么必须有"稳定键"（实测证据见 `tests/fixtures/light_assets.json`）

微博头像 URL **只有约 3 小时有效期**（`Expires` + `ssig` 每次都换）：

```
…/0089C3d5ly8gwpjla9gx0j30n00n0abc.jpg?KID=imgbed,tva&Expires=1790539776&ssig=%2Bi5AJrTZen
…/0089C3d5ly8gwpjla9gx0j30n00n0abc.jpg?KID=imgbed,tva&Expires=1790626278&ssig=jLCQn6IyIx
```

两次抓取是**同一张图**（盘上两个文件 sha256 逐字节相同），但 URL 不同。按 URL 存 ⇒
每轮都当新资源：重复下载、重复落盘、账本里同一张脸变成两个版本。
⇒ 索引/去重/查盘一律按 `key_of(url)`（丢掉**白名单**里的签名参数）；
回源仍用**完整 URL**（存在 `local_assets.url`），这样"丢掉签名参数"永远不会让下载失败。

## 四条不变量（判据在 `tests/test_assets.py`）

1. **先写文件、再写索引**（`put`）：反过来会在崩溃后留下"索引说有一份、盘上没有"的死条目，
   而 `get()` 若信索引就会返回一个不存在的路径 ⇒ 破图。所以 `get()` 命中要求**文件与索引都在**；
2. **`get()` 命中 ⇒ 零网络请求**（键命中就够了，不去回源核对）；
3. **`remember()` 只登记、绝不搬迁**（`static/avatars/` 里的历史文件留在原地）——
   用户磁盘上的文件只许增、不许减/不许改（方案 §4 S-1）；
4. **`prune()` 只删"未 pin 且未被引用"的**：被 `vtubers.avatar`（用户选中）/ 账号现值 /
   历次头像账本引用的，一律留着（少了这道保护，用户的头像会在某次清理后变成破图）。

## 与 `static/img-cache/` 的边界（`routers/img_proxy.py`）

| | `static/img-cache/` | `static/assets/`（本模块） |
|---|---|---|
| 是什么 | **任意远端图的临时缓存**（看一眼就够） | **认定的长期资源**（不能丢） |
| 键 | `md5(完整 URL)`（签名一换就是新键） | `kind + 稳定键`（跨签名同一份） |
| 失效 | 7 天 TTL + 300MB，可随时清 | 只按 pin / LRU / 上限淘汰；被引用的不许清 |
| 判据 | **清空它，应用外观不变** | 清它**会**破图（所以它有索引与保护） |

## 已知取舍（写清楚，别当它没代价）

`key` 命中就**不重新下载** —— 万一平台"换了图但没换 URL 的文件名"，我们会一直用旧图。
实测微博/B 站换图都会换文件名（两个同 sha256 的样本正好反证"URL 变了图没变"才是常态），
换来的是"每轮抓取零图片请求"。留的口子是 L4 的 `prune_assets --verify`（≥7 天一次强制回源核对）。

⚠️ **`data_root()` 是唯一的目录来源，也是测试的注入点**：用例把它指到 tmp_path，
就绝不会写到真机数据目录（`conftest.py` 有一条 autouse 守卫）。
"""
from __future__ import annotations

import hashlib
import logging
import os
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.vtuber import (Account, LocalAsset, Post, VTuber,
                                 VtuberAvatarHistory)

logger = logging.getLogger(__name__)

#: 资源种类（模块化扩展点：L3 的 `cover`、L4 的企划徽标…）
KIND_AVATAR = "avatar"
KIND_COVER = "cover"
KINDS: tuple[str, ...] = (KIND_AVATAR, KIND_COVER)

#: **白名单**（不是黑名单）：列在这里的 query 参数一律不参与稳定键 ——
#: 没列进去的一律保留（少归一化只是多存一份，误删参数会让不同资源撞成一个键）
SIGNATURE_PARAMS = frozenset({
    "expires", "ssig", "kid", "sign", "signature", "token", "x-expires", "x-signature",
})

#: 认得的图片扩展名（与 `services/vtuber_background.sniff_image` 同集合）
IMAGE_EXTS = frozenset({".jpg", ".jpeg", ".png", ".gif", ".webp"})
DEFAULT_EXT = ".jpg"

#: 相对路径前缀（前端 `resolveAsset()` 与 `/static` 挂载点认它）
REL_ROOT = "static/assets"

#: 临时文件后缀（与最终文件同目录 ⇒ `os.replace` 才是原子的）
TMP_SUFFIX = ".part"

#: 每 kind 的默认容量上限；`None` = 不限。
#: 头像不限（用户口径：pin 的全留、抓到的都留）；封面默认 1GB，超出按 LRU 淘汰未 pin 的。
DEFAULT_MAX_BYTES: dict[str, int | None] = {KIND_AVATAR: None, KIND_COVER: 1024 ** 3}


def _now() -> datetime:
    """naive UTC（库内 datetime 一律 naive，与 `vtuber_avatars._now` 同口径）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ── 目录与路径 ─────────────────────────────────────────────────────────

def data_root() -> Path:
    """数据目录（库内相对路径的基准）。**唯一来源 + 测试注入点**，见模块头部末段。"""
    return Path(settings.DATA_DIR)


def assets_dir(kind: str, *, data_dir: Path | None = None) -> Path:
    return (data_dir or data_root()) / REL_ROOT / kind


def abs_path(rel: str, *, data_dir: Path | None = None) -> Path:
    """库内相对路径（`static/...`）→ 绝对路径；已经是绝对路径的原样返回。"""
    p = Path(rel)
    return p if p.is_absolute() else (data_dir or data_root()) / p


def rel_path(kind: str, url: str, *, hint: str | None = None, ext: str | None = None) -> str:
    """**可预测**的文件名：下载**之前**就能算出该看哪个文件 —— 这才叫"少发请求"。

    ⚠️ 摘要取**稳定键**的 sha1（不是完整 URL）：否则微博每次换签名都会算出新文件名，
    "同一张图存两份"的毛病会原样保留（R47 的 `{uid}_{sha1(url)[:8]}` 就是这个形态）。
    """
    digest = hashlib.sha1(key_of(url).encode("utf-8")).hexdigest()[:8]
    suffix = ext or ext_of(url)
    name = _clean_hint(hint)
    return f"{REL_ROOT}/{kind}/{name}_{digest}{suffix}" if name else f"{REL_ROOT}/{kind}/{digest}{suffix}"


def is_managed(path: str) -> bool:
    """这个路径是不是**本模块自己写的**（`static/assets/` 下）？

    用来区分两种"已存在的文件"：我们自己写的可以原地覆盖（一个键一个文件名）；
    用户盘上的历史文件（`static/avatars/`）**一律不碰**（只许 `remember` 登记）。
    """
    return (path or "").replace("\\", "/").startswith(f"{REL_ROOT}/")


def ext_of(url: str) -> str:
    """从 URL 路径推扩展名；未知/无扩展名时回退 `.jpg`（不猜内容 —— 内容验在 L4）。"""
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    return suffix if suffix in IMAGE_EXTS else DEFAULT_EXT


def _clean_hint(hint: str | None) -> str:
    """文件名前缀（头像用 `{platform}_{uid}`）：只留安全字符，防路径穿越。"""
    return "".join(c if (c.isalnum() or c in "._-") else "_" for c in (hint or "")).strip("_")


# ── 稳定键 ─────────────────────────────────────────────────────────────

def key_of(url: str) -> str:
    """`key` = 丢掉**签名参数**、去掉 fragment、query 按参数名排序后的 URL。

    - 丢 `Expires` / `ssig` / `KID` / `sign` … （白名单，见 `SIGNATURE_PARAMS`）；
    - query **排序**：防"参数顺序漂移"造出假不同的键；
    - 保留 scheme/netloc/path 与**其余全部** query；
    - 空串 ⇒ 空键（调用方据此判"这个 URL 没法固化"）。
    """
    raw = (url or "").strip()
    if not raw:
        return ""
    parts = urllib.parse.urlsplit(raw)
    pairs = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
             if k.lower() not in SIGNATURE_PARAMS]
    pairs.sort()
    return urllib.parse.urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path,
                                    urllib.parse.urlencode(pairs), ""))


# ── 落盘（原子写）──────────────────────────────────────────────────────

def _open_for_write(path: Path):
    """写临时文件的**唯一入口**。留成函数是为了让"写盘失败"能被**真的注入**
    （判据要求：失败时既不许留半截文件、也不许留索引行）—— 与 `vtuber_background` 同款。"""
    return path.open("wb")


def write_bytes(path: Path, data: bytes) -> None:
    """临时文件 → `os.replace` 原子改名。半截文件一定会被 `get()` 当成命中 ⇒ 必须原子。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + TMP_SUFFIX)
    try:
        with _open_for_write(tmp) as fh:
            fh.write(data)
        os.replace(tmp, path)          # 同目录 rename ⇒ 原子
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:                # 清临时文件失败不掩盖原始异常
            logger.warning(f"临时文件清理失败：{tmp}")
        raise


def _sha256_file(path: Path) -> str | None:
    h = hashlib.sha256()
    try:
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(64 * 1024), b""):
                h.update(chunk)
    except OSError as e:
        logger.warning(f"读文件求摘要失败 {path}: {type(e).__name__}: {e}")
        return None
    return h.hexdigest()


# ── 索引查询 ───────────────────────────────────────────────────────────

def lookup(db: Session, kind: str, url: str) -> LocalAsset | None:
    """按稳定键查索引（**只看索引**：不查盘、不发请求、不 touch）。"""
    key = key_of(url)
    if not key:
        return None
    return (db.query(LocalAsset)
            .filter(LocalAsset.kind == kind, LocalAsset.key == key)
            .first())


def lookup_keys(db: Session, kind: str, keys) -> dict[str, LocalAsset]:
    """**一次查完**一批键（`/vtuber/list` 的批量派生走这条，不许 N+1）。"""
    ks = sorted({k for k in keys if k})
    if not ks:
        return {}
    rows = (db.query(LocalAsset)
            .filter(LocalAsset.kind == kind, LocalAsset.key.in_(ks))
            .all())
    return {r.key: r for r in rows}


def get(db: Session, kind: str, url: str, *, touch: bool = True) -> LocalAsset | None:
    """命中（`kind + 稳定键`）**且文件在盘** ⇒ 返回；否则 `None`（调用方去下载）。

    ⚠️ 文件缺失时**当未命中**，不是"报个错"：调用方会重下，`put()` 复用同一行修复
    （老教训 `_avatar_missing`：只查 URL 变化会永远补不下）。
    ⚠️ 命中时 **一个网络请求都不发**（这是本模块的收益本身，判据在
    `tests/test_vtuber_avatars.py`，配"第一次必须发"的正对照）。
    """
    row = lookup(db, kind, url)
    if row is None:
        return None
    if not abs_path(row.path).exists():
        logger.info(f"轻资产索引命中但文件不在盘上（当未命中，将重下）：{row.path}")
        return None
    if touch:
        row.last_used_at = _now()
    return row


# ── 写入 ───────────────────────────────────────────────────────────────

def put(db: Session, kind: str, url: str, data: bytes, *,
        ext: str | None = None, hint: str | None = None,
        pinned: bool | None = None) -> LocalAsset:
    """落盘 + 入库（**唯一**会写文件的入口）。**不提交**，随调用方的事务一起收口。

    - 文件名按稳定键可预测 ⇒ 同一个键永远是同一个文件（换签名不会多出一份）；
    - 已有一行且其路径在 `static/assets/` 下 ⇒ **原地覆盖**（幂等）；
      路径在别处（`remember` 登记的历史文件）⇒ 写到新的受管路径并把行指过来 ——
      **绝不覆盖用户的文件**（S-1）；
    - 先写文件、再 add/更新行（模块头部不变量 1）。
    """
    key = key_of(url)
    if not key:
        raise ValueError("url 为空，无法求稳定键")
    if not data:
        raise ValueError("空内容不落盘（0 字节文件会被当成有效副本）")

    row = (db.query(LocalAsset)
           .filter(LocalAsset.kind == kind, LocalAsset.key == key)
           .first())
    target = row.path if (row is not None and is_managed(row.path)) \
        else rel_path(kind, url, hint=hint, ext=ext)
    write_bytes(abs_path(target), data)

    digest = hashlib.sha256(data).hexdigest()
    suffix = Path(target).suffix.lstrip(".").lower() or None
    stamp = _now()
    if row is None:
        row = LocalAsset(kind=kind, key=key, url=url, path=target, ext=suffix,
                         bytes=len(data), sha256=digest, pinned=bool(pinned),
                         created_at=stamp, last_used_at=stamp)
        db.add(row)
    else:
        row.url = url
        row.path = target
        row.ext = suffix
        row.bytes = len(data)
        row.sha256 = digest
        row.last_used_at = stamp
        if pinned is not None:
            row.pinned = bool(pinned)
    # ⚠️ 先 flush：`SessionLocal` 是 `autoflush=False`，不 flush 的话本会话里紧接着的
    #    查询看不见这一行（同一个资源会被登记两次、撞 UNIQUE(kind, key)）。
    db.flush()
    return row


def remember(db: Session, kind: str, url: str, path: str, *,
             pinned: bool = False) -> LocalAsset | None:
    """**只登记**盘上已有的文件（历史遗留 / 随包资源）：不下载、不复制、不搬迁、不改名。

    - 文件不在盘上 ⇒ 返回 `None`（先文件后索引：不留"指向虚空"的索引行）；
    - 同一个稳定键已有行 ⇒ 只 touch `last_used_at`、把 `url` 跟到最新；
      **绝不改已有的 `path`** —— 盘上两份文件（R47 前后各一份）都在时，改路径等于换图；
    - 内容摘要只在**新行或行里还没有摘要**时读盘算一次（稳态抓取不该每轮重读整个文件）。

    ⚠️ S-1：这是历史文件进索引的**唯一**通道，它一个字节都不会动用户的文件。
    """
    key = key_of(url)
    rel = (path or "").strip().replace("\\", "/")
    if not key or not rel:
        return None
    target = abs_path(rel)
    if not target.exists():
        logger.warning(f"轻资产登记跳过（盘上没有这个文件）：{rel}")
        return None

    row = (db.query(LocalAsset)
           .filter(LocalAsset.kind == kind, LocalAsset.key == key)
           .first())
    stamp = _now()
    if row is None:
        row = LocalAsset(kind=kind, key=key, url=url, path=rel,
                         ext=Path(rel).suffix.lstrip(".").lower() or None,
                         bytes=target.stat().st_size, sha256=_sha256_file(target),
                         pinned=bool(pinned), created_at=stamp, last_used_at=stamp)
        db.add(row)
    else:
        row.url = url
        row.last_used_at = stamp
        if not row.bytes:
            row.bytes = target.stat().st_size
        if not row.sha256:
            row.sha256 = _sha256_file(target)
        if pinned:
            row.pinned = True
    db.flush()
    return row


def pin(db: Session, kind: str, url: str, on: bool = True) -> LocalAsset | None:
    """长留标记（用户选过的头像 / 手动 pin）。索引里没有它 ⇒ 返回 `None`（不凭空造行）。

    已经是要设的值 ⇒ 不写（免得每次保存档案都产生一条无意义的 UPDATE）。
    """
    row = lookup(db, kind, url)
    if row is None:
        return None
    if bool(row.pinned) != bool(on):
        row.pinned = bool(on)
        db.flush()
    return row


# ── 统计与清理 ─────────────────────────────────────────────────────────

def stats(db: Session, kind: str | None = None) -> dict:
    """按 kind 报数：文件数 / 字节 / pin 数 / **索引有盘上没有的条数** / 最旧一份的创建时刻。

    ⚠️ 测量口径是**盘上真实存在的文件**（`files`）—— 索引行数会骗人（备份还原后
    `static/` 不跟着回来，见规格 §6 第 4 条）。`missing` 就是那类死条目的计数。
    """
    kinds = (kind,) if kind else KINDS
    rows = db.query(LocalAsset).filter(LocalAsset.kind.in_(kinds)).all()
    out: dict[str, dict] = {k: {"files": 0, "bytes": 0, "pinned": 0, "missing": 0,
                                "oldest": None, "rows": 0} for k in kinds}
    for r in rows:
        bucket = out.setdefault(r.kind, {"files": 0, "bytes": 0, "pinned": 0, "missing": 0,
                                         "oldest": None, "rows": 0})
        bucket["rows"] += 1
        if abs_path(r.path).exists():
            bucket["files"] += 1
            bucket["bytes"] += int(r.bytes or 0)
        else:
            bucket["missing"] += 1
        if r.pinned:
            bucket["pinned"] += 1
        if r.created_at and (bucket["oldest"] is None or r.created_at.isoformat() < bucket["oldest"]):
            bucket["oldest"] = r.created_at.isoformat()
    for k in kinds:
        out[k]["max_bytes"] = DEFAULT_MAX_BYTES.get(k)
    return out


def _referenced_keys(db: Session, kind: str) -> set[str]:
    """**还被引用的稳定键**（prune 的保护名单）。

    头像的三处引用：`vtubers.avatar`（用户显式选中）/ 账号 `avatar_url`（平台现值）/
    `vtuber_avatar_history.avatar_url`（历次头像账本）。少了这道保护，清理会把
    用户正看着的那张头像删掉（规格 §6 第 5 条）。

    **封面**（L3，devlog/261）的引用面是 `posts.cover_url`，且**只看未归档的帖**：
    归档帖本来就不在列表里滚，它的封面副本被清掉是可接受的（下次要看时还能重下），
    而未归档帖的封面是"列表首屏就要画"的东西 —— 那正是我们主动固化的理由。
    ⚠️ 这条查询会扫全部未归档帖（万级行），但它只在**手动清理**时跑一次，不在热路径上。
    """
    if kind == KIND_COVER:
        keys = set()
        for (u,) in (db.query(Post.cover_url)
                     .filter(Post.is_archived == False,          # noqa: E712 —— SQLAlchemy 需要 ==
                             Post.cover_url.isnot(None)).all()):
            k = key_of(u or "")
            if k:
                keys.add(k)
        return keys
    if kind != KIND_AVATAR:
        return set()
    urls: set[str] = set()
    for (value,) in db.query(VTuber.avatar).filter(VTuber.avatar.isnot(None)).all():
        urls.add(value)
    for (value,) in db.query(Account.avatar_url).filter(Account.avatar_url.isnot(None)).all():
        urls.add(value)
    for (value,) in (db.query(VtuberAvatarHistory.avatar_url)
                     .filter(VtuberAvatarHistory.avatar_url.isnot(None)).all()):
        urls.add(value)
    return {key_of(u) for u in urls if key_of(u)}


def prune(db: Session, kind: str | None = None, *, max_bytes: int | None = None,
          dry_run: bool = True) -> dict:
    """按 LRU 淘汰**未 pin 且未被引用**的资产，直到该 kind 的字节数 ≤ 上限。

    - `max_bytes=None` ⇒ 用 `DEFAULT_MAX_BYTES[kind]`（头像不限、封面 1GB）；
      `max_bytes=0` = 清空未受保护的（设置页的"清理未使用"就是这个语义）；
    - `dry_run=True`（默认）⇒ **一个字节都不删**，只回候选集合；
      ⚠️ dry-run 与实际删除**必须是同一个集合**（设置页上"将要清理"才不是骗人的）；
    - 淘汰顺序 = `last_used_at` 最旧优先（命中会刷新它 ⇒ 近似 LRU）；
    - 删行之后**连文件一起删**（只删行的话盘只增不减），最后 `flush()` 让调用方
      （或同一会话里的下一个查询）立刻看得见。**不提交**：由调用方收口。
    """
    kinds = [kind] if kind else list(KINDS)
    report: dict = {"dry_run": bool(dry_run), "kinds": {}}
    for k in kinds:
        cap = DEFAULT_MAX_BYTES.get(k) if max_bytes is None else max_bytes
        rows = (db.query(LocalAsset)
                .filter(LocalAsset.kind == k)
                .order_by(LocalAsset.last_used_at.asc().nullsfirst(), LocalAsset.id.asc())
                .all())
        live = [r for r in rows if abs_path(r.path).exists()]
        total = sum(int(r.bytes or 0) for r in live)
        protected = _referenced_keys(db, k)
        entry = {
            "max_bytes": cap, "before_files": len(live), "before_bytes": total,
            "protected": len(protected), "evicted": [], "freed_bytes": 0,
        }
        if cap is not None and total > cap:
            for r in live:
                if total <= cap:
                    break
                if r.pinned or r.key in protected:
                    continue
                entry["evicted"].append(_evict_entry(r))
                entry["freed_bytes"] += int(r.bytes or 0)
                total -= int(r.bytes or 0)
            if not dry_run:
                for e in entry["evicted"]:
                    row = db.get(LocalAsset, e["id"])
                    if row is not None:
                        db.delete(row)
                    try:
                        abs_path(e["path"]).unlink(missing_ok=True)
                    except OSError as ex:
                        logger.warning(f"轻资产文件删除失败（留下孤儿文件 {e['path']}）: {ex}")
        entry["after_files"] = entry["before_files"] - len(entry["evicted"])
        entry["after_bytes"] = entry["before_bytes"] - entry["freed_bytes"]
        report["kinds"][k] = entry
    db.flush()          # 让同一会话里的下一个查询看得见删除（autoflush=False）
    return report


# ── L4：强制回源核对（"稳定键命中就不回源"那条取舍的逃生口）────────────────

#: 默认复核节流：只核对**至少这么旧**的副本（规格 §2.1 / §7 第 3 条：≥7 天一次）
VERIFY_MIN_AGE_DAYS = 7


async def verify(db: Session, kind: str | None = None, *, min_age_days: int = VERIFY_MIN_AGE_DAYS,
                 limit: int = 50, fetch=None, apply: bool = False,
                 now: datetime | None = None) -> dict:
    """**强制回源**核对一份份副本，返回报告（L4，devlog/262）。**不替调用方 commit**。

    ## 为什么需要它

    `get()` 命中稳定键就**不回源**（那是本模块的主要收益）——代价写在规格 §2.1：
    万一平台"换了图却没换文件名"，我们会一直用旧图。实测微博/B 站换图都会换文件名，
    所以这条取舍值；但**必须留一个口子**：这个函数就是那个口子（规格 §7 第 3 条）。

    三条纪律：
    - **节流 ≥ `min_age_days`**（默认 7 天）：以副本的 `created_at` 为基准 —— 复核是**额外**请求，
      不能变成每轮都做（那是把收益又还回去）；想立刻全量复核就显式传 `min_age_days=0`；
    - **只读优先**：默认 `apply=False` ⇒ 只报告不一致，**不动**文件与索引；
      `apply=True` 才用刚取回的新字节覆盖（`put`，原子写）并把 `sha256/bytes` 更新；
    - **失败只记账**：取不到就记 `unreachable`（图床挂了不等于我们的副本坏了）。
    """
    now = now or _now()
    kinds = [kind] if kind else list(KINDS)
    cutoff = now - timedelta(days=max(0, int(min_age_days)))
    rows = (db.query(LocalAsset)
            .filter(LocalAsset.kind.in_(kinds))
            .order_by(LocalAsset.created_at.asc())
            .all())
    report: dict = {"checked": 0, "ok": 0, "mismatch": [], "unreachable": [],
                    "skipped_fresh": 0, "applied": bool(apply),
                    "min_age_days": int(min_age_days)}
    for row in rows:
        if report["checked"] >= limit:
            break
        if row.created_at and row.created_at > cutoff:
            report["skipped_fresh"] += 1          # 还"新" ⇒ 这一轮不核对它
            continue
        if not abs_path(row.path).exists():
            report["unreachable"].append({"kind": row.kind, "path": row.path,
                                          "why": "本地副本不在盘上"})
            continue
        if fetch is None:
            break                                  # 没给取数函数 ⇒ 只能回报"该核对哪些"
        try:
            data = await fetch(row.url)
        except Exception as e:  # noqa: BLE001 —— 单份失败不该中断整轮
            report["unreachable"].append({"kind": row.kind, "url": row.url,
                                          "why": f"{type(e).__name__}: {e}"})
            continue
        report["checked"] += 1
        if not data:
            report["unreachable"].append({"kind": row.kind, "url": row.url, "why": "取不到字节"})
            continue
        digest = hashlib.sha256(data).hexdigest()
        if digest == (row.sha256 or ""):
            report["ok"] += 1
            continue
        report["mismatch"].append({"kind": row.kind, "url": row.url, "path": row.path,
                                   "was": row.sha256, "now": digest})
        if apply:
            put(db, row.kind, row.url, data, hint=None)
    db.flush()
    return report


def _evict_entry(row: LocalAsset) -> dict:
    return {"id": row.id, "key": row.key, "path": row.path, "bytes": int(row.bytes or 0),
            "last_used_at": row.last_used_at.isoformat() if row.last_used_at else None}
