"""T2 的尺子：生成人工标注集 + **把标注落档** + **一键评测**（只读真库，不改代码）。

用户口径（2026-10-11/12）：尺子 = **基础规则 + 人工标注相结合**。
没有这份真值，T3 改规则只能叫「换个口味」，不能叫「更准」（方案 §5）。

三个动作：

```bash
# ① 生成标注页（固定种子 ⇒ 可复现）
python scripts/make_label_set.py
# ② 用户填完「我（用户）的判断」那一段之后，解析它 ⇒ 固定回归集
python scripts/make_label_set.py --collect
# ③ 评测：当前规则在这份回归集上的吻合率 + 错在哪（T3 每次改规则都跑）
python scripts/make_label_set.py --ruler
```

⚠️ 只在**开发机**上有意义（要真机库）：找不到库时**直接报错停下**，不静默产出空结果。
"""
from __future__ import annotations

import argparse
import json
import random
import re
import shutil
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

REAL_DB = Path(r"E:\test\DDToolkit-data\DDToolkit-data\vtuber.db")
COPY = ROOT / "tmp_label_set.db"
SEED = 20261012
PER_STRATUM = 20

#: 允许的真值（含 `?`，见 `--ruler` 的说明：故意放进 label 里当作「人眼也判不出」的记录）
#: ⚠️ 必须与 `app/services/live_type.py::CATEGORY_KEYS` 同集 ——
#: 2026-10-12 两次体系改动都碰过这里：健身→助眠（`devlog/468`）、新加 `3d`（`devlog/469`）。
#: 漏改的症状是 `--collect` 把**合法真值**判成"不在允许清单里"（用户填了却收不进来）。
VALID_TRUTH = {"game", "chat", "watch", "upload", "song", "sleep", "3d",
               "radio", "collab", "special", "live", "?"}


def _copy_real_db() -> None:
    """真库副本（真库停在旧迁移上，补齐 f010–f016 的**纯加列**部分）。

    ⚠️ 这是**开发机专用**的取样脚本（真库路径写死）：路径不存在就**直接报错停下来** ——
    静默产出空表比报错更糟（用户会以为"库里没有场次"）。
    """
    if not REAL_DB.exists():
        raise SystemExit(
            f"找不到真机库：{REAL_DB}\n"
            "本脚本用于从开发机的真库抽样生成人工标注集；"
            "换机器时把 REAL_DB 指到你的数据目录（或先跑应用生成库）。")
    for suffix in ("", "-wal", "-shm"):
        src = Path(str(REAL_DB) + suffix)
        if src.exists():
            shutil.copyfile(src, str(COPY) + suffix)
    con = sqlite3.connect(COPY)
    for sql in (
        "ALTER TABLE live_sessions ADD COLUMN vod_url TEXT",
        "ALTER TABLE live_sessions ADD COLUMN category TEXT",
        "ALTER TABLE live_sessions ADD COLUMN category_from TEXT",
        "ALTER TABLE vtubers ADD COLUMN sort_order INTEGER DEFAULT 0",
        "ALTER TABLE vtubers ADD COLUMN background_focus TEXT",
        "ALTER TABLE vtubers ADD COLUMN background_video_path VARCHAR",
        "ALTER TABLE vtubers ADD COLUMN background_video_focus TEXT",
        "ALTER TABLE vtubers ADD COLUMN group_name TEXT",
        "ALTER TABLE vtubers ADD COLUMN group_uuid TEXT",
        "ALTER TABLE vtubers ADD COLUMN vod_account_uid TEXT",
    ):
        try:
            con.execute(sql)
        except sqlite3.OperationalError:
            pass
    con.commit()
    con.close()


def _rows() -> list[dict]:
    """合并视图 + 生效类型（只读）。

    ⚠️ 结束时必须 `engine.dispose()`：否则 SQLite 文件句柄不放，调用方删副本会
    `PermissionError: [WinError 32]`（Windows 上踩过）。
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.models.vtuber import Account
    from app.repositories.vtuber_repo import (
        LiveCategoryOverrideRepo, LiveSessionRepo,
    )
    from app.routers.vtuber import _resolve_categories

    engine = create_engine(f"sqlite:///{COPY.as_posix()}")
    db = sessionmaker(bind=engine)()
    repo = LiveSessionRepo(db)
    out: list[dict] = []
    for acc in db.query(Account).order_by(Account.id).all():
        sessions = repo.merged(acc.id, with_ids=True)
        if not sessions:
            continue
        cats = _resolve_categories(
            db, sessions, LiveCategoryOverrideRepo(db).map_by_account(acc.id))
        for s, (cat, src) in zip(sessions, cats):
            out.append({
                "account_id": acc.id,
                "live_id": s.get("live_id"),
                "start_at": str(s.get("start_at")),
                "title": (s.get("live_title") or "").strip(),
                "area": s.get("area_name") or "",
                "parent_area": s.get("parent_area_name") or "",
                "category": cat,
                "from": src,
            })
    db.close()
    engine.dispose()
    return out


def _clean(text: str) -> str:
    """markdown 表格里不许出现竖线与换行。"""
    return text.replace("|", "｜").replace("\n", " ").replace("\r", " ")


def generate(args) -> None:
    _copy_real_db()
    rows = _rows()
    rng = random.Random(SEED)

    strata: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        # ⚠️ 3D **单独一层**（2026-10-12 新加）：它是新类、真机上量最大的一类之一
        # （389 场），而它与其他层的关系正是最需要人判的（"3d歌回"到底算歌回还是 3D）。
        # 显式排除"不是 3D 直播"的误命中（`晕3d了谢会sc`）。
        low = (r["title"] or "").lower()
        if "3d" in low and not any(x in low for x in ("晕3d", "3d晕", "3ds")):
            strata["threed"].append(r)
        elif r["from"] == "fallback":
            strata["fallback"].append(r)
        elif r["from"] == "area":
            strata["area"].append(r)
        elif r["from"] in ("title", "series", "learned", "date"):
            strata["title"].append(r)
        # override 不进标注集：那是用户已经给过的真值

    picked: dict[str, list[dict]] = {}
    for name, pool in strata.items():
        pool = [r for r in pool if r["title"]]        # 没标题的没法判，别浪费用户的时间
        rng.shuffle(pool)
        picked[name] = pool[:args.per_stratum]

    lines = [
        "---",
        "doc: plans/live-type-label-set",
        "class: plan",
        f"scope: T2 的人工标注集（固定种子 {SEED} 抽样；用户逐个给真值 ⇒ 形成回归集）",
        "not-scope: 规则本身（改规则是 T3）；这份文件只装「人给的真值」",
        "expires: 2027-03-31",
        "---",
        "",
        "# 场次类型：人工标注集（T2 尺子）",
        "",
        "> 用途：给类型规则一个**能证伪的尺子**。规则已经改过两轮（`devlog/468` 健身→助眠、",
        "> `devlog/469` 加 `3d` + watch 扩边界），但**没有基线** ⇒ 现在只能说「换了口径」，",
        "> 不能说「更准」。这份真值就是那个基线（方案 §5：基础规则 + 人工标注相结合）。",
        ">",
        "> **怎么填**：看每一行的**标题 + 分区**，在最后一节的 `key-N = 类型` 里写一个类型 key。",
        "> - **拿不准就写 `?`** —— 那本身有用（说明人眼也判不出来，规则判不出不算错），",
        ">   评测时不计入吻合率、但会单独报出来；",
        "> - ⚠️「现有判断」栏是**今天规则给出的答案**，不是提示 —— 觉得错就照实写你的；",
        "> - **不用全填**，每层填十几条就够当尺子（但 `3d` 那层建议认真填，它是新类）。",
        "",
        "## 类型 key（现在的 11 类）",
        "",
        "| key | 标签 | 判定边界 |",
        "|---|---|---|",
        "| `chat` | 杂谈 | 聊天/陪伴/杂谈/谢 SC/看弹幕互动 —— **没有明确内容主体**的那种 |",
        "| `game` | 游戏 | 主体是打游戏（含联机、练枪、通关、看游戏实况一起吐槽） |",
        "| `watch` | 观影 | 一起看番/剧/电影/综艺/特摄，**或者视频、投稿等以观看视频为主体**的 |",
        "| `upload` | 投稿 | 主体是**放自己的**新作/预告/剪辑（「看别人的投稿」归 `watch`） |",
        "| `song` | 歌回 | 唱歌/歌回/练歌/演唱会/音乐向 |",
        "| `radio` | 电台 | 电台/谈心/深夜陪聊/**在电台区开播**（与 `chat` 的边界：有「节目感」的算电台） |",
        "| `collab` | 联动 | 与人联动/嘉宾/连麦/合唱 |",
        "| `special` | 特殊 | 生日/周年/出道纪念/毕业/跨年等**一次性事件** |",
        "| `sleep` | 助眠 | 助眠/哄睡/白噪音/ASMR 这类**明确的助眠内容**（真机上今天 0 场） |",
        "| `3d` | 3D | **3D 形式**呈现的直播（口径：**内容类优先** ⇒ `3d歌回` 算歌回、只有判不出内容的才归 3D） |",
        "| `live` | 直播 | 中性兜底（**判不出来时选它**） |",
        "",
        "## 抽样与口径",
        "",
        f"- 来源：真机库只读副本（{len(rows)} 场合并场次），**固定种子 {SEED}** ⇒ 可复现；",
        "- 分层：按**现有判定档位**取（`fallback` 未定出来 / `area` 靠分区 / `title` 靠标题）"
        "＋**单独一层 `3d`**（新类，按标题含 3D 取，已排除「晕3d」这类误命中）；",
        "- 每层取了一批，**不用全填**；",
        "",""
    ]

    titles = {"threed": "第一层：标题含 3D（新类的现场）",
              "fallback": "第二层：未定出来（今天的 `live` 兜底）",
              "area": "第三层：靠房间分区定的",
              "title": "第四层：靠标题关键词定的"}
    #: 层 → 页面上的 ID 前缀。⚠️ **显式写出来，不用 `name[:4]` 切**：
    #: 切出来的 `fallback` → `fall`、`title` → `titl` 与提示里的名字**不一致**，
    #: 用户按页面提示写 `fallback-1 = game` 会被解析器当"认不出的行"丢掉。
    #: 这类坑的症状是"我明明填了，吻合率却没算进去"—— 很难自己发现。
    prefixes = {"threed": "3d", "fallback": "fallback", "area": "area", "title": "title"}
    for name in ("threed", "fallback", "area", "title"):
        got = picked.get(name) or []
        if not got:
            continue
        lines += [
            f"## {titles[name]}（{len(got)} 条）",
            "",
            "| # | 标题 | 分区 | 现有判断 | 你的判断 |",
            "|---|---|---|---|---|",
        ]
        for i, r in enumerate(got, 1):
            area = _clean(r["area"] or "—")
            if r["parent_area"] and r["parent_area"] != r["area"]:
                area = f"{_clean(r['parent_area'])}/{area}"
            lines.append(
                f"| {prefixes[name]}-{i} | {_clean(r['title'])} | {area} "
                f"| `{r['category']}`（{r['from']}） |  |")
        lines.append("")

    lines += [
        "## 我（用户）的判断",
        "",
        "> 按 `fallback-1 = game` 这种形状写在下面（前缀就是表格里那个 ID 的前半段：",
        "> `3d-` / `fallback-` / `area-` / `title-`）。",
        "> 不填的条目会被跳过；写 `?` = 人眼也判不出。",
        "",
        "```",
        "# 3D 层（新类，建议认真填）",
        "",
        "# 未定出来那层",
        "",
        "# 分区层",
        "",
        "# 标题层",
        "",
        "```",
        "",
        "## 附：这张表怎么被用掉",
        "",
        "1. 你的判断 → 一份固定回归集（**跟着本文件留档**），由脚本落档：",
        "   `python scripts/make_label_set.py --collect`（读下面那段、写 `live-type-truth.json`）；",
        "2. T3 每改一次规则都跑 `python scripts/make_label_set.py --ruler` ⇒ 输出",
        "   **吻合率 + 按档拆解 + 判错清单**（哪些原来对的变错了）；",
        "3. 另配两个连续指标（`fallback` 率、人工校正率）—— ⚠️ 它们**单独不够**：",
        "   区分不了「更准」与「把错换了个错法」，必须配这份固定集。",
        "4. ⚠️ 标 `?` 的条目不进吻合率（人眼也判不出），但会单独报出来；",
        "   库里已不存在的场次会被跳过并说明 —— **不静默少算**（少算会让吻合率看起来更好）。",
        "",
    ]

    out = ROOT / args.out
    out.write_text("\n".join(lines), encoding="utf-8")
    side = out.with_suffix(".json")
    side.write_text(json.dumps(
        {"seed": SEED, "picked": {k: v for k, v in picked.items()}},
        ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"写出 {out}（{sum(len(v) for v in picked.values())} 条）")
    print(f"写出 {side}（对账用：每条对应的场次 id）")
    print("分层条数:", {k: len(v) for k, v in picked.items()})
    print("池子大小:", {k: len(v) for k, v in strata.items()})
    for suffix in ("", "-wal", "-shm"):
        Path(str(COPY) + suffix).unlink(missing_ok=True)


# ── 标注解析（把用户填的那一段变成固定回归集）──────────────────────

_LABEL_RE = re.compile(r"^\s*([a-z0-9]+)-(\d+)\s*=\s*([A-Za-z?0-9]+)\s*$")


def parse_answers(md_path: Path) -> dict[str, str]:
    """从标注页里读「我（用户）的判断」那一段 ⇒ `{id: truth}`。

    ⚠️ 只认 `fall-1 = game` 这种**独立成行**的写法（用户按页面提示回给我就是这个形状）。
    认不出的行**报出来**（不是静默跳过）：静默跳过会让"我填了但它没算进去"变成一个
    只在吻合率上差几个百分点的现象 —— 而那个数字正是要拿来做决定的。
    """
    text = md_path.read_text(encoding="utf-8")
    block = text.split("## 我（用户）的判断", 1)
    body = block[1] if len(block) > 1 else text
    out: dict[str, str] = {}
    bad: list[str] = []
    for raw in body.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("```") or line.startswith(">"):
            continue
        m = _LABEL_RE.match(line)
        if not m:
            if "=" in line:
                bad.append(line)
            continue
        _, num, truth = m.groups()
        key = m.group(0).strip().split("=")[0].strip()
        if truth.lower() not in VALID_TRUTH:
            bad.append(f"{line}（真值不在允许清单里）")
            continue
        out[key] = truth.lower()
    if bad:
        raise SystemExit("这些行没解析成功，请按 `fall-1 = game` 的写法改一下：\n  "
                         + "\n  ".join(bad[:10]))
    return out


def collect(args) -> None:
    md = ROOT / args.out
    truth = parse_answers(md)
    if not truth:
        raise SystemExit("没读到任何标注 —— 请先在标注页的「我（用户）的判断」里填写。")
    side = json.loads(md.with_suffix(".json").read_text(encoding="utf-8"))
    picked = side["picked"]
    # id → 那一场的键（真值要靠它跟"现在的规则怎么说"对上）
    # ⚠️ 前缀必须与 `generate()` 的 `prefixes` 表**同源**（`3d` 不是 `threed`）
    prefixes = {"threed": "3d", "fallback": "fallback", "area": "area", "title": "title"}
    by_id: dict[str, dict] = {}
    for name, rows in picked.items():
        for i, r in enumerate(rows, 1):
            by_id[f"{prefixes.get(name, name)}-{i}"] = r
    out: dict[str, dict] = {}
    unknown = [k for k in truth if k not in by_id]
    if unknown:
        raise SystemExit(f"这些 id 不在抽样里（标注页重新生成过？）：{unknown}")
    for key, t in truth.items():
        r = by_id[key]
        out[key] = {
            "truth": t,
            "account_id": r["account_id"],
            "live_id": r["live_id"],
            "start_at": r["start_at"],
            "title": r["title"],
            "area": r["area"],
            "at_label_time": r["category"],
            "from_at_label_time": r["from"],
        }
    dst = ROOT / args.truth
    dst.write_text(json.dumps(
        {"seed": SEED, "source": args.out, "labels": out},
        ensure_ascii=False, indent=1), encoding="utf-8")
    counts = Counter(v["truth"] for v in out.values())
    print(f"写出 {dst}（{len(out)} 条真值）")
    print("真值分布:", dict(counts.most_common()))
    unsure = counts.get("?", 0)
    if unsure:
        print(f"⚠️ 其中 {unsure} 条标了 `?`（人眼也判不出）—— 评测时**不计入吻合率**，"
              f"但单独报出来（它说明这类场次规则判不出不算错）")


# ── 评测（尺子本体）────────────────────────────────────────────────

def ruler(args) -> None:
    """当前规则在固定回归集上的表现：吻合率 + 错在哪 + 分档拆解。

    ⚠️ 比的是**读取时的生效值**（override > 落库值 > 同一口径现算），也就是用户
    在日历上真看到的那个类型 —— 不是 `settle()` 单独的输出。
    """
    truth = json.loads((ROOT / args.truth).read_text(encoding="utf-8"))["labels"]
    _copy_real_db()
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.repositories.vtuber_repo import LiveCategoryOverrideRepo, LiveSessionRepo
    from app.routers.vtuber import _resolve_categories

    engine = create_engine(f"sqlite:///{COPY.as_posix()}")
    # ⚠️⚠️ **先把两列清空**（2026-10-12 踩到）：读路径的口径是
    # 「**有落库值就用落库值** ← 没有才现算」，而副本一旦被上一次尺子跑过，
    # 惰性回填就把**当时的规则结果**写进了列里 ⇒ 之后改规则再跑尺子，
    # 量到的全是**库里的旧值**，新规则一条都没生效（实测：直调 `settle()` 是
    # `game`、尺子报 `chat`，我差点按错的那个去改规则）。
    # 清空之后尺子量的才是"**当前规则**在这份真值上的表现" —— 这也正是产品上
    # 日同步/新写入会发生的事（老库那 8,515 行的列会在下次同步时被重判）。
    con = sqlite3.connect(COPY)
    con.execute("UPDATE live_sessions SET category = NULL, category_from = NULL")
    con.commit()
    con.close()
    db = sessionmaker(bind=engine)()
    repo = LiveSessionRepo(db)

    # 按账号分组：同一账号一次 merged()（评测脚本也是"别为每行算一遍全量"）
    by_acc: dict[int, list[str]] = defaultdict(list)
    for key, rec in truth.items():
        by_acc[rec["account_id"]].append(key)

    hit = miss = 0
    skipped: list[str] = []
    wrong: list[str] = []
    by_from: dict[str, list[int]] = defaultdict(lambda: [0, 0])   # 档 → [对, 总]
    for acc_id, keys in sorted(by_acc.items()):
        sessions = repo.merged(acc_id, with_ids=True)
        if not sessions:
            continue
        cats = _resolve_categories(
            db, sessions, LiveCategoryOverrideRepo(db).map_by_account(acc_id))
        index: dict[str, tuple[str, str]] = {}
        for s, pair in zip(sessions, cats):
            if s.get("live_id"):
                index[str(s["live_id"])] = pair
        for key in keys:
            rec = truth[key]
            got = index.get(str(rec["live_id"]))
            if got is None:
                skipped.append(f"{key}（这一场在库里找不到了：{rec['title']!r}）")
                continue
            if rec["truth"] == "?":
                skipped.append(f"{key}（人眼判不出，不计入）")
                continue
            ok = got[0] == rec["truth"]
            hit += ok
            miss += not ok
            bucket = by_from[rec["from_at_label_time"]]
            bucket[0] += ok
            bucket[1] += 1
            if not ok:
                wrong.append(
                    f"  {key}: 真值 `{rec['truth']}` vs 现在 `{got[0]}`（{got[1]}）"
                    f"  {rec['title']!r} [{rec['area']}]")

    total = hit + miss
    print(f"\n=== 尺子：{total} 条计入（另有 {len(skipped)} 条跳过）===")
    if total:
        print(f"吻合率 **{hit / total:.1%}**（{hit}/{total}）")
    print("\n按「当时靠哪一档定出来」拆：")
    for name, (h, t) in sorted(by_from.items(), key=lambda kv: -kv[1][1]):
        print(f"  {name:<8} {h}/{t} = {h / max(t, 1):.0%}")
    if wrong:
        print(f"\n判错的 {len(wrong)} 条：")
        print("\n".join(wrong))
    if skipped:
        print(f"\n跳过 {len(skipped)} 条：")
        print("\n".join(f"  {s}" for s in skipped[:10]))
    db.close()
    engine.dispose()
    for suffix in ("", "-wal", "-shm"):
        Path(str(COPY) + suffix).unlink(missing_ok=True)


# ── 入口 ───────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="T2 尺子：标注集生成 / 落档 / 评测")
    ap.add_argument("--out", default="docs/plans/live-type-label-set.md")
    ap.add_argument("--truth", default="docs/plans/live-type-truth.json",
                    help="固定回归集（--collect 写、--ruler 读）")
    ap.add_argument("--per-stratum", type=int, default=PER_STRATUM)
    ap.add_argument("--collect", action="store_true",
                    help="解析标注页里的用户判断 ⇒ 固定回归集")
    ap.add_argument("--ruler", action="store_true",
                    help="在当前规则上跑回归集（吻合率 + 错在哪）")
    args = ap.parse_args()

    if args.collect:
        collect(args)
    elif args.ruler:
        ruler(args)
    else:
        generate(args)


if __name__ == "__main__":
    main()

