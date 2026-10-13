"""B站表情名 → 图片地址（2026-10-13，用户第 5 条）。

## 用户口径

「我希望帖子内容中的 `[xx表情包_aaa]` 可以被渲染出来」——帖子正文（`body_json.text`）里
带方括号的表情 token 现在是一串字面文字，要换成真表情图。

## 真机数据（2026-10-13 现数，5,056 帖）

| 形状 | 出现次数 | 说明 |
|---|---|---|
| `UPOWER_<uid>_<名>` | 3,207 | **发帖 UP 自己的**动态表情 |
| `<包名>_<名>`（如 `明前奶绿收藏集表情包_石化`） | 2,285 | 收藏集/自定义包 |
| 无下划线（如 `1P`、`▓▓`） | 514 | **不是表情**（分P 标记、被屏蔽词）⇒ 不动它 |
| `UP_<uid>_<名>` | 174 | 视频 owner 表情 |
| `[话题]` | 214 | **微博话题标记**（`#xxx[话题]#`）⇒ 必须排除 |

## 能解析多少（实测，不是估计）

合并「全局动态表情包（匿名 225 个）」+「用户表情面板（鉴权 431 个）」两个来源，
再按形状归一化（`UPOWER_<uid>_贴贴` → 试 `贴贴`；`<包>_<名>` → 也试裸名）：

**142 / 501 个 token 能解析出图片地址（28%）**。

⇒ 剩下的**必须**有兜底（用户也认了这个方案）：前端把解析不出来的渲染成
**名字 chip**（`[包名_名]` 那样一枚小标签），而不是原样留着方括号 —— "这是一枚表情，
只是本机没有它"比"一串看不懂的方括号"清楚。

## 为什么解析率只有 28%（写下来免得下次当 bug 查）

## 两个来源（2026-10-13 起，第一源才是主力）

**第一源 = 我们自己的载荷**。B站 的内容载荷**自带**每个表情的图床地址：

```json
modules.module_dynamic.desc.rich_text_nodes[1].emoji = {
  "type": 11, "size": 2,
  "text": "[UPOWER_1891335475_闪亮]",                    // 与正文 token **逐字相同**
  "icon_url": "https://i0.hdslb.com/bfs/garb/….png",     // ← 图床地址
  "gif_url": "", "webp_url": "",
  "package_id": "18626", "id": "287839"                  // 包 id + 表情 id
}
```

（opus 型帖在 `modules.module_dynamic.major.opus.summary.rich_text_nodes[*].emoji`，字段一样。）
抓帖子时整个载荷存进了 `posts.raw_json` ⇒ **答案本来就在库里**：不出网、不碰第三方数据。

实测（真机 5,058 帖；`scripts/check_emoji_coverage.py` 一条命令可复现）：

| 口径 | 覆盖 |
|---|---|
| 种类（498 个 token，量 `body_json.text` —— 前端真正渲染的那个字段） | 493 = **99.0%** |
| 次数（6,172 次出现） | 5,975 = **96.8%** |

缺的 5 个是 `1P`(114) · `▓▓`(76) · `0P`(4) · `9P`(2) · `2P`(1) —— **一个带下划线的都没有**
⇒ 真表情**一枚没漏**，没解析出来的全是本来就该保持原样文字的东西（分P 标记、被屏蔽词）。
⚠️ 别拿 `body_text` 那一列的数跟这里比：它多出 `[3P]`…`[13P]` 八个分P 标记（506 种 / 6,448 次），
口径不同（`devlog/483` 对过账）。
⚠️ 顺带修正一条直觉：**"无下划线 ⇒ 不是表情"只对"没解析出来的那些"成立**。
真机里 `打call`/`爱心`/`笑哭`/`给心心`/`捂脸`/`脱单doge`… 这些**官方裸名表情**恰恰不带下划线，
而它们全被载荷解析出来了 ⇒ 前端的"不带下划线 ⇒ 原样文字"兜底规则在本机数据上**一次都没误伤**。

**第二源 = 上游整表**（全局动态包 + 本机账号的表情面板）：覆盖第一源没碰到的（老数据、
只出现在视频标题里的 `石化R` 那类）。⚠️ 它**账号相关**（面板只给本机账号能看到的包），
所以是**兜底**不是主源 —— 单独用它只有 28%。

⇒ 两个来源都解析不出来的，前端渲染成**名字 chip**（`[包名_名]` 那样一枚小标签），
而不是原样留着方括号："这是一枚表情，只是本机没有它"比"一串看不懂的方括号"清楚。

## 索引的键用**原样名**（含 `UPOWER_<uid>_` 前缀）—— 2026-10-13 实测定的

归一化（把 `UPOWER_<uid>_` 去掉，让"同一个名字"跨 UP 通用）看着更划算，真机数据说**不划算**：

| 口径 | 覆盖（498 个正文 token） | 同名不同图 |
|---|---|---|
| 原样（现在这样） | 493 = **99.0%** | 0 |
| 归一化 | 493 = **99.0%**（多救回 **0** 个） | **14 组** |

缺的那 5 个两边一样，全是 `1P`/`0P`/`9P`/`2P`/`▓▓` —— **根本不是表情**（分P 标记、被屏蔽词）。
归一化唯一的效果是让 `打call`/`爱你`/`干杯`/`喜欢`… 这 14 个名字变成"一个名字对应 2 张图"
（不同 UP 各自的自定义表情）⇒ 会把 A 的表情画成 B 的。**覆盖一样、风险更大，所以不归一化。**

## 为什么第二源只有 28%（写下来免得下次当 bug 查）

`UPOWER_<uid>_<名>` 里那个 uid 是**发帖那个 UP** 的，而表情面板接口给的是
**本机登录账号能看到的那几包**（实测 `up_id=<别人的 uid>` 匿名/鉴权都拿不到别人的包）。

## 缓存

- **第一源**：扫 `posts.raw_json` 建索引实测 **0.71s / 5,058 行**（取行本身只要 0.09s）
  ⇒ 太慢，不能放读路径（`devlog/473`：读端点不许干重活）。按本仓既有做法
  （`devlog/475`"启动期只在真需要补时才扫 + 记号"）：
  索引与**扫到哪个 post id** 一起存 `app_meta`；**启动期**只扫 `id > 记号` 的新行
  （平时 0 行、近乎零成本）；读路径只读内存那份，**不写库、不扫表**。
- **第二源**：面板接口一次返回几百个表情，**不是**按 token 查（没有"按名查"的端点）
  ⇒ 拉一次整表建索引，进程内缓存 `PANEL_TTL`（默认 30 分钟）。
  **按需拉**（`resolve_all_async`）：只有"第一源漏了"才出网 —— 载荷覆盖 99% ⇒ 平时根本不走；
  拉失败后 `RETRY_AFTER`（60s）内不再试（失败不写 `at`，没有这道闸就会每个请求打一次上游）。
  ⚠️ **别改成"启动期预取"**（试过 `prefetch_panel_index()`，没人调 ⇒ 兜底在运行期是死的、
  还不报错）。要改就先接上调用点，并给它一个短超时（离线时 15s 会挂在启动路径上）。
- 上游失败**不抛错**：返回空索引，前端全走 chip 兜底（表情不该让正文渲染失败）。
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Iterable

logger = logging.getLogger(__name__)

#: 面板/全局包多久重拉一次（秒）。上游是几百 KB 的整表，30 分钟足够新鲜
PANEL_TTL = 30 * 60
#: 第二源**拉失败之后**多久才再试一次（秒）：失败不写 `at`，没有这道闸就会每个请求打一次上游
RETRY_AFTER = 60
#: 单次请求最多解析多少个 token（前端一次一批；防有人拿它当探测接口刷上游）
MAX_TOKENS = 200

#: `app_meta` 里存第一源索引与记号的键
KEY_RAW_INDEX = "emoji.raw_index"
KEY_SCANNED_UPTO = "emoji.scanned_upto"
#: 递归找 emoji 节点的最大深度（载荷是 `modules.module_dynamic…`，实测最深 8 层上下）
_MAX_DEPTH = 14

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
_HEADERS = {"Referer": "https://www.bilibili.com/", "User-Agent": _UA}

#: 一次拿整表的两条路：全局动态包（匿名可拿）+ 用户面板（要登录态，多出自己收藏的包）
_PANEL_URL = "https://api.bilibili.com/x/emote/user/panel/web"
_GLOBAL_URL = "https://api.bilibili.com/x/emote/package"

#: `UPOWER_<uid>_<名>` / `UP_<uid>_<名>`：前缀是**发帖人**的 uid，不是表情名的一部分
_UID_PREFIX = re.compile(r"^UP(?:OWER)?_\d+_(.+)$")

_cache: dict[str, object] = {"at": 0.0, "index": {}, "why": None, "last_try": 0.0}


def normalize_candidates(token: str) -> list[str]:
    """一个 token 的**候选名**（按优先级）：原样 → 去掉 uid 前缀 → 下划线后半段。

    ⚠️ 顺序有意义：`UPOWER_1203217682_贴贴` 的原样在表里**一定**查不到（表里只有 `贴贴`），
    但先试原样零成本，而且少数包名里真的带下划线（`doge_金箍`）—— 那种必须原样命中。
    """
    out = [token]
    m = _UID_PREFIX.match(token)
    if m:
        out.insert(0, m.group(1))
    if "_" in token:
        out.append(token.split("_", 1)[1])
    # 去重且保序
    seen: set[str] = set()
    return [c for c in out if c and not (c in seen or seen.add(c))]


def build_index(packages: list[dict]) -> dict[str, str]:
    """`[{emote: [{text, url}]}]` → `{名: url}`（纯函数，便于用假数据验证）。

    表里的 `text` 形如 `[doge_金箍]`（**带方括号**），我们的 token 不含方括号 ⇒ 两边都剥掉。
    """
    index: dict[str, str] = {}
    for pkg in packages or []:
        for face in (pkg or {}).get("emote") or []:
            name = str(face.get("text") or "").strip().strip("[]")
            url = face.get("url") or ""
            if name and url:
                index.setdefault(name, url)
    return index


def resolve(tokens: list[str], index: dict[str, str]) -> dict[str, str]:
    """token → 图片地址（查不到的**不出现在结果里**，由调用方走 chip 兜底）。"""
    out: dict[str, str] = {}
    for tok in tokens:
        for cand in normalize_candidates(tok):
            url = index.get(cand)
            if url:
                out[tok] = url
                break
    return out


# ── 第一源：从 posts.raw_json 里把表情节点抠出来（2026-10-13）──────────────
#
# 为什么这是主力：B站 的载荷自带 `{text, icon_url, package_id}`，`text` 与正文 token 逐字相同
# ⇒ 我们抓帖子时已经把答案存下来了（实测覆盖 99% 的 token / 97% 的出现次数）。
# ⚠️ 只扫**载荷**（raw_json），不扫我们自己拼的 body_json —— 后者是提取后的纯文本，
#    图床地址在那一步就丢了。

def collect_emotes(node, index: dict[str, tuple[str, str | None]], depth: int = 0) -> None:
    """递归把载荷里所有 `{emoji: {text, icon_url, package_id}}` 收进 `index`（**原地修改**）。

    `index` 的值是 `(url, package_id)`：包 id 现在没用上，但它是**将来要整包**时的种子
    （官方 `/bapis/…/EmoteService/PackageDetail` 或第三方快照都按包 id 查），
    而重新扫一遍全库要 0.7s ⇒ 顺手存下来比将来再扫便宜。

    键是 `emoji.text` **原样**（只去方括号）：**不**去掉 `UPOWER_<uid>_` 前缀 ——
    理由与实测在模块 docstring 的"索引的键用原样名"一节（覆盖一样、归一化反而会撞名）。
    """
    if depth > _MAX_DEPTH:
        return
    if isinstance(node, dict):
        emo = node.get("emoji")
        if isinstance(emo, dict):
            name = str(emo.get("text") or "").strip().strip("[]")
            url = emo.get("icon_url") or emo.get("gif_url") or emo.get("webp_url") or ""
            if name and url:
                pkg = emo.get("package_id")
                index[name] = (str(url), str(pkg) if pkg else None)
        for v in node.values():
            collect_emotes(v, index, depth + 1)
    elif isinstance(node, list):
        for v in node:
            collect_emotes(v, index, depth + 1)


def scan_payloads(raws: Iterable[str | None],
                  index: dict[str, tuple[str, str | None]] | None = None
                  ) -> dict[str, tuple[str, str | None]]:
    """一批 `raw_json` 字符串 → `{名字: (url, package_id)}`（纯函数，可用假数据验证）。

    后扫到的**覆盖**先扫到的（同一枚表情被 UP 换过图时，新的那次才是当下有效的地址）；
    调用方按 `id` 升序喂进来即可。
    """
    index = index if index is not None else {}
    for rj in raws:
        if not rj:
            continue
        try:
            raw = json.loads(rj)
        except (TypeError, ValueError):
            continue          # 库里有畸形 JSON（历史遗留）：跳过，别让一条坏行毁掉整个索引
        collect_emotes(raw, index)
    return index


def _post_raw_rows(db, after_id: int = 0):
    """按 id 升序取 `raw_json`（`after_id` 之后的新行）。

    直接写 SQL 而不是走模型：只取两列，整表 5 千行 0.09s；也因此不必在模块顶层
    import 模型（避免 `services` → `models` 的导入环）。
    """
    from sqlalchemy import text

    rows = db.execute(
        text("SELECT id, raw_json FROM posts WHERE id > :after ORDER BY id"),
        {"after": after_id},
    ).all()
    return rows


#: 第一源的进程内副本（读路径只读它；启动期由 `warm_raw_index` 填）
#: ⚠️ 定义在 `warm_raw_index` **之前**：那个函数是唯一填它的人，放下面容易让人以为还有别的入口。
_raw_cache: dict[str, object] = {"index": {}}


def warm_raw_index(db, force: bool = False) -> dict:
    """启动期调用：把**新行**的表情扫进 `app_meta` 里的索引（幂等、失败不挡启动）。

    返回一份统计（`scanned` / `names` / `packages` / `last_id`），给日志与用例看。
    ⚠️ **唯一填 `_raw_cache` 的地方**：不调它 ⇒ 第一源静默缺席（只剩第二源的 28%）。
    全量重扫用 `force=True`（改过解析规则后重建）。

    ⚠️ 为什么不是"每次都全扫"：全扫 0.71s，而"只在有新行时扫"平时是 0 ——
    与 `devlog/475` 那条（启动期那 485ms 只在真需要补时才扫）同一个做法。
    ⚠️ 写在**启动期**而不是读路径：`devlog/473`（读端点不许写库）。
    """
    from app.repositories.vtuber_repo import AppMetaRepo

    repo = AppMetaRepo(db)
    stored: dict[str, tuple[str, str | None]] = {}
    last_id = 0
    if not force:
        try:
            last_id = int(repo.get(KEY_SCANNED_UPTO) or 0)
        except (TypeError, ValueError):
            last_id = 0
        raw = repo.get(KEY_RAW_INDEX)
        if raw:
            try:
                stored = {k: (v[0], v[1]) for k, v in json.loads(raw).items()}
            except (TypeError, ValueError, IndexError):
                stored = {}          # 存坏了就当作没存（下面会重建）
                last_id = 0

    rows = _post_raw_rows(db, 0 if force else last_id)
    if not rows and stored:
        # ⚠️ 这里**必须回填进程内副本**：没有新行是**第二次之后的每次启动**的常态，
        #    只 return 统计就会让第一源在那些启动里静默缺席（退化成只有 28% 的第二源）。
        _raw_cache["index"] = stored
        return {"scanned": 0, "names": len(stored),
                "packages": len({p for _u, p in stored.values() if p}), "last_id": last_id}

    index = dict(stored)
    scan_payloads((r[1] for r in rows), index)
    new_last = max([last_id] + [r[0] for r in rows])
    # 只在**真变了**的时候写（幂等：`--force` 之外的第二遍调用零写）
    if rows or force:
        repo.set(KEY_RAW_INDEX, json.dumps(
            {k: [u, p] for k, (u, p) in index.items()}, ensure_ascii=False))
        repo.set(KEY_SCANNED_UPTO, str(new_last))
    _raw_cache["index"] = index
    return {"scanned": len(rows), "names": len(index),
            "packages": len({p for _u, p in index.values() if p}), "last_id": new_last}


def raw_index() -> dict[str, tuple[str, str | None]]:
    """第一源索引（读路径用；没热过就是空的 —— 那时全靠第二源，功能不坏只是少解析）

    ⚠️ 它**只**由启动期的 `warm_raw_index` 填：所以 `/emoji/packages` 报
    `payload_names: 0` 就等于"第一源没热上"（而不是"库里没有表情"）。
    """
    return _raw_cache["index"]  # type: ignore[return-value]


def resolve_all(tokens: list[str]) -> tuple[dict[str, str], dict[str, str]]:
    """**两级解析**（同步：只读内存里的两份索引）：第一源（离线载荷）→ 第二源（上游整表缓存）。

    返回 `(命中, 来源)`；`来源` 只是给诊断/用例看的（哪个 token 是哪一级给的）。
    第二源失败**不抛错** —— 表情解析失败不该让正文渲染失败。
    """
    raw = {k: url for k, (url, _pkg) in raw_index().items()}
    hit = resolve(tokens, raw)
    origin = {t: "payload" for t in hit}
    rest = [t for t in tokens if t not in hit]
    if rest:
        pkg_index = _sync_panel_index()
        hit2 = resolve(rest, pkg_index)
        hit.update(hit2)
        origin.update({t: "panel" for t in hit2})
    return hit, origin


async def resolve_all_async(tokens: list[str]) -> tuple[dict[str, str], dict[str, str]]:
    """端点用的两级解析：**第一源没盖住时才去拉第二源**（拉回来的那份带 30 分钟缓存）。

    ⚠️ 为什么必须有这个 async 版本（而不是让端点只调同步的 `resolve_all`）：
    同步版只认**已有的**缓存，而"谁来把缓存填上"必须有答案。曾经写过
    `prefetch_panel_index()` 打算放启动期，但**没人调它** ⇒ 第二源在运行期其实是死的
    （文档里写着有兜底、实际永远命中不了，且一声不响）—— 这就是那条教训。
    现在改成**按需**：只在"第一源漏了"时出网一次，之后 30 分钟内都吃缓存；
    载荷覆盖 99% ⇒ 平时这条路径根本不会走到。

    出网失败也**不抛**：端点返回已命中的 + `why`（`panel_why()`），正文照常渲染。
    """
    hit, origin = resolve_all(tokens)
    if len(hit) < len(tokens) and _panel_needs_fetch():
        # ⚠️ **在调用点**记下"试过了"（不是只在 `emote_index` 里记）：退避要拦的是
        #    "这次请求又去打了一次上游"，那就得由发起方记账 —— 只靠被调方记账时，
        #    任何替换/包装第二源的地方都会让这道闸失效（用例里就是这么发现的）。
        _note_panel_attempt()
        await emote_index()                    # 从不抛错；失败只记 `why`
        hit, origin = resolve_all(tokens)      # 用刚拉回来的缓存重算（第一源结果不变）
    return hit, origin


async def _fetch_packages(url: str, params: dict, cookie: str | None) -> list[dict]:
    import httpx

    headers = dict(_HEADERS)
    if cookie:
        headers["Cookie"] = cookie
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(url, params=params, headers=headers)
        body = r.json()
    if body.get("code") != 0:
        raise RuntimeError(f"上游 code={body.get('code')} {str(body.get('message'))[:40]}")
    return (body.get("data") or {}).get("packages") or []


def _note_panel_attempt() -> None:
    """记一笔"刚试过拉第二源"（退避用；失败也算试过）"""
    _cache["last_try"] = time.time()


def _panel_needs_fetch() -> bool:
    """第二源该不该现在去拉：新鲜就不拉；**刚失败过也要等一会儿**（别把上游刷爆）。

    ⚠️ 失败时 `emote_index` 不会更新 `at`（它只在真拿到索引时才写），所以这里必须看
    `last_try` —— 只看 `at` 的话，上游一挂，**每个**带漏项的表情请求都会再打一次上游。
    纯判断、不记账（记账在 `_note_panel_attempt`，由发起方调）。
    """
    now = time.time()
    if _cache["index"] and now - float(_cache["at"]) < PANEL_TTL:
        return False
    return now - float(_cache["last_try"]) >= RETRY_AFTER


async def emote_index(force: bool = False) -> tuple[dict[str, str], str | None]:
    """整表索引（带缓存）。返回 `(索引, 失败原因或 None)` —— **从不抛错**。

    为什么要两条路合起来：全局动态包匿名就有（225 个），但**本机账号收藏的那些包**
    （实测 431 个，含 `明前奶绿收藏集表情包_*`）只在鉴权那条路上 —— 少一条就少一半解析率。
    """
    now = time.time()
    if not force and _cache["index"] and now - float(_cache["at"]) < PANEL_TTL:
        return _cache["index"], _cache["why"]  # type: ignore[return-value]

    _note_panel_attempt()         # 直接调它的路径（预取/探针）也记账：这是"试过"的唯一出处
    from app.services.auth import auth_manager

    errors: list[str] = []
    packages: list[dict] = []
    for label, url, params, cookie in (
        ("全局动态包", _GLOBAL_URL, {"business": "dynamic", "ids": 1}, None),
        ("用户面板", _PANEL_URL, {"business": "dynamic"}, auth_manager.cookie_str),
    ):
        try:
            packages += await _fetch_packages(url, params, cookie)
        except Exception as e:  # noqa: BLE001 —— 上游怎么坏都不该让正文渲染失败
            errors.append(f"{label}: {e}")
            logger.warning("[emote] %s 拉取失败：%s", label, e)

    index = build_index(packages)
    why = ("；".join(errors) if errors else None)
    _cache["why"] = why       # 拉失败的原因要**留在缓存里**：读路径（同步）看不到异常，
    if index:                 # 只能靠这里记下来，`/emoji/resolve` 才报得出"兜底缺席"
        _cache["index"] = index
        _cache["at"] = now
    return index, why


def panel_why() -> str | None:
    """第二源最近一次拉取的失败原因（没失败过就是 `None`）—— 给读路径回报降级用。"""
    return _cache["why"]  # type: ignore[return-value]


def _sync_panel_index() -> dict[str, str]:
    """第二源的**同步**取用（读路径用）：有缓存就给缓存，没有就给空。

    ⚠️ 为什么不在读路径上现拉：`resolve_all` 是**同步**函数，而 `emote_index` 是 async 的
    （要走 HTTP）。所以同步这条路只认缓存；要"现拉"就走 `resolve_all_async`（端点用的是它）。
    ⚠️ 拼错成"在这里 `asyncio.run(...)`"是不行的：端点本身可能已经在事件循环里（真踩过这类）。
    """
    return _cache["index"] or {}  # type: ignore[return-value]


async def prefetch_panel_index() -> str | None:
    """可选：**启动期**就把第二源拉进来（当前没人调 —— 见 `resolve_all_async` 的说明）。

    留着是因为它是个明确的能力（"宁可启动慢一点也不让第一个漏项请求等网络"），
    但**默认不接**：那会给每次启动都加一次出网 + 离线时卡满超时（15s）。
    """
    try:
        _index, why = await emote_index()
        return why
    except Exception as e:  # noqa: BLE001
        logger.warning("[emote] 面板索引预取失败：%s", e)
        return str(e)


def index_stats() -> dict:
    """诊断：两级索引各自有多少名字、见过多少个包（`GET /emoji/packages` 用）。"""
    raw = raw_index()
    pkgs = sorted({p for _u, p in raw.values() if p})
    return {
        "payload_names": len(raw),
        "payload_packages": len(pkgs),
        "payload_package_ids": pkgs[:50],
        "panel_names": len(_cache["index"] or {}),
        "panel_at": float(_cache["at"]) or None,
        "panel_why": panel_why(),
    }


def reset_caches() -> None:
    """清空两级索引的进程内副本 —— **只给用例用**（与前端 `resetEmojiCache()` 同一路数）。

    ⚠️ 必须导出：两个缓存都是**模块级**的，而一个测试文件里多个用例共用同一个模块实例 ——
    不清就会命中上一条用例留下的结果（症状是"接口明明该问上游却一次都没问"）。
    """
    _raw_cache["index"] = {}
    _cache["index"] = {}
    _cache["at"] = 0.0
    _cache["why"] = None
    _cache["last_try"] = 0.0
