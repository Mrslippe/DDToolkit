"""B 站图床的**取数规格**：给封面 URL 加尺寸/格式后缀，省掉大部分体积。

## 为什么要有这个模块

L3 轻资产落盘时把封面原图整张存下来（`scheduler._pin_account_covers`），
而 B 站图床原图**非常大**：2026-10-14 在本机真库（3,336 张封面）上实测，
单张最大 **14 MB**、动态封面常见的 3 MB 级。图床自己提供了一套 `@<w>w_<h>h.webp`
的处理参数，加上去之后同一张图变成 **672 宽级别的 WebP**，实测降到 **0.1%–14%**。

## 规格怎么定的（**别改成带 `1c` 的版本**）

`@672w_378h.webp` —— **不带 `1c`**。`1c` 是**居中裁剪**，而：

| 封面类型 | 原图 | `@672w_378h.webp` | `@672w_378h_1c.webp` |
|---|---|---|---|
| 视频封面（`/bfs/archive/`，16:9） | 1920×1080 · 281 KB | 672×378 · **39 KB** | 672×378 · 39 KB（**完全相同**） |
| 动态封面（`/bfs/new_dyn/`，比例不定） | 3000×1875 · 3.27 MB | 605×378 · **30 KB**（等比装进框内） | 672×378 · 34 KB（**内容被裁**） |

真库里 **动态封面占多数**（`new_dyn` 1820 / `archive` 772 / 其它 390），
而详情页封面**点开是灯箱看完整图**（`PostDetailDrawer` 的 `coverList` → `ImageViewer`）
⇒ 裁掉就是真丢内容，且省下的字节反而更少（30 KB vs 34 KB）。
⚠️ **不带 `1c` 时宽高表达"等比装进这个框"**（实测 3000×1875 → 605×378，比例保持不变），
不是拉伸 —— 这条是选它的依据，别凭直觉改回 `1c`。

## 代价（用户 2026-10-14 已知并同意）

- **动图变单帧**：`.gif` 封面（真库 224 张 / 6.7%）会被转成单帧 WebP
  （实测 96 KB→85 KB、371 KB→86 KB、660 KB→179 KB）；
- 只对**白名单图床**有效（B 站的 `hdslb.com` 与 `album.biliimg.com` 都认，
  两家实测都返回真图：672×378）；别的平台（微博图床等）加后缀**毫无作用**，所以不加。

## 边界

- **只影响"下载下来的那一份"**：`posts.cover_url` 里存的仍是平台原文 URL，
  资产键也仍按原文 URL 算（`assets.key_of`）—— 换规格不会让已固化的封面失配。
- 反复调用**幂等**：URL 已带 `@` 后缀就原样返回（不叠第二个），否则同样的输入永远同样输出。
"""

from __future__ import annotations

#: 目标规格：宽 672、高 378 为上限，**等比装进这个框**（见模块头：为什么不是 `1c`）
COVER_SPEC = "@672w_378h.webp"

#: 认这套参数的图床后缀（实测两家都认；其它平台加了没用，不加）
SPEC_HOSTS: tuple[str, ...] = ("hdslb.com", "biliimg.com")


def supports_spec(url: str | None) -> bool:
    """这个 URL 的图床认不认 B 站的 `@` 参数？"""
    host = _host_of(url)
    return bool(host) and any(host == h or host.endswith("." + h) for h in SPEC_HOSTS)


def cover_fetch_url(url: str | None) -> str:
    """**下载用**的封面 URL：白名单图床加规格，其余原样返回。

    ⚠️ 调用方必须仍用**原 URL** 作为资产键与 `posts.cover_url` 的取值 ——
    这个函数只回答"该去哪个地址取字节"，不改变"这张封面是谁"。
    """
    raw = (url or "").strip()
    if not raw or not supports_spec(raw):
        return raw
    if "@" in raw.rsplit("/", 1)[-1]:        # 已在路径末段带 `@…` 后缀 ⇒ 不叠加
        return raw
    head, sep, tail = raw.partition("?")     # 规格属于路径，必须落在 `?` 之前
    return f"{head}{COVER_SPEC}{sep}{tail}"


def _host_of(url: str | None) -> str:
    """取主机名（小写）。不引 urllib 只为了这一件事 —— 这里只处理 http(s) 绝对地址。"""
    raw = (url or "").strip().lower()
    for scheme in ("https://", "http://"):
        if raw.startswith(scheme):
            raw = raw[len(scheme):]
            return raw.split("/", 1)[0].split("?", 1)[0]
    return ""
