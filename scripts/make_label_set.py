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
#: ⚠️ 2026-10-12（T3）：`fitness` 已换成 `sleep`（助眠）—— 与
#: `app/services/live_type.py::CATEGORY_KEYS` 同集，否则 `--collect` 会把
#: 合法真值判成"不在允许清单里"。
VALID_TRUTH = {"game", "chat", "watch", "upload", "song", "sleep",
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
        if r["from"] == "fallback":
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
        "not-scope: 规则本身（T3 才改）；这份文件只装「人给的真值」",
        "expires: 2027-03-31",
        "---",
        "",
        "# 场次类型：人工标注集（T2 尺子）",
        "",
        "> 用途：T3 要改类型规则（健身→助眠 + 打那 31.7% 未定出来的场次）。**没有这份真值，",
        "> 规则怎么改都只能叫「换个口味」，不能叫「更准」**（方案 §5）。",
        ">",
        "> 怎么填：看每一行的**标题 + 分区**，在「你的判断」里写一个类型 key（写在最后面那张表里）。",
        "> **拿不准就写 `?`** —— 那本身就是有用的信息（说明这一场人眼也判不出来，",
        "> 规则判不出来不算错）。",
        "",
        "## 类型 key（沿用现有 10 类）",
        "",
        "| key | 标签 | 大致的判定边界 |",
        "|---|---|---|",
        "| `chat` | 杂谈 | 聊天/陪伴/杂谈/谢 SC/看弹幕互动（**没有明确内容主体**的那种） |",
        "| `game` | 游戏 | 主体是打游戏（含联机、练枪、通关、看游戏实况一起吐槽？→ 见说明） |",
        "| `watch` | 观影 | 一起看番/剧/电影/综艺/特摄（**看的不是游戏**） |",
        "| `upload` | 投稿 | 主体是看投稿/切片/评论自己的二创 |",
        "| `song` | 歌回 | 唱歌/歌回/练歌/演唱会/音乐向 |",
        "| `radio` | 电台 | 电台/谈心/深夜陪聊/ASMR/哄睡（**与 `chat` 的边界：有「节目感」的算电台**） |",
        "| `collab` | 联动 | 与人联动/嘉宾/连麦/合唱 |",
        "| `special` | 特殊 | 生日/周年/出道纪念/毕业/跨年等**一次性事件** |",
        "| `sleep` | 助眠 | 助眠/哄睡/白噪音/ASMR 这类**明确的助眠内容**（判不准就别硬套） |",
        "| `live` | 直播 | 中性兜底（**判不出来时选它**） |",
        "",
        "## 抽样与口径",
        "",
        f"- 来源：真机库只读副本（{len(rows)} 场合并场次），**固定种子 {SEED}** ⇒ 可复现；",
        "- 分层：按**现有判定档位**取（`fallback` 未定出来 / `area` 靠分区 / `title` 靠标题等）；",
        "- 每层取了若干条，**不用全填**（填 30–40 条就够当尺子）；",
        "- ⚠️ 「现有判断」栏是**今天规则给出的答案**，不是提示 —— 觉得它错了请照实写你的判断。",
        "",
    ]

    titles = {"fallback": "第一层：未定出来（今天的 `live` 兜底）",
              "area": "第二层：靠房间分区定的",
              "title": "第三层：靠标题关键词定的"}
    for name in ("fallback", "area", "title"):
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
                f"| {name[:4]}-{i} | {_clean(r['title'])} | {area} "
                f"| `{r['category']}`（{r['from']}） |  |")
        lines.append("")

    lines += [
        "## 我（用户）的判断",
        "",
        "> 把这部分回给我即可：`fallback-1 = game`、`area-3 = ?` 这样写就行。",
        "",
        "```",
        "# fallback 层",
        "",
        "# area 层",
        "",
        "# title 层",
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

_LABEL_RE = re.compile(r"^\s*(fall|area|titl)-(\d+)\s*=\s*([A-Za-z?]+)\s*$")


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
    by_id: dict[str, dict] = {}
    for name, rows in picked.items():
        for i, r in enumerate(rows, 1):
            by_id[f"{name[:4]}-{i}"] = r
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

