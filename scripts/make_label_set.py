"""生成 T2 的人工标注集（只读真库副本，不改代码、不写真库）。

用户口径（2026-10-11/12）：尺子 = **基础规则 + 人工标注相结合**。
本脚本产出那份"人工标注"的候选页：按**现有判定档位**分层抽样，
把「标题 + 分区 + 现有判断」摆出来，用户逐个给真值 ⇒ 形成固定回归集。

分层（按方案 §5）：未定出来（fallback）· 靠分区（area）· 靠标题/其它（title 等）。
抽样：**固定种子**的确定性随机（同一个库跑两次结果一样 ⇒ 可复现、可对账）。

用法: python scripts/make_label_set.py [--out docs/plans/live-type-label-set.md]
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

REAL_DB = Path(r"E:\test\DDToolkit-data\DDToolkit-data\vtuber.db")
COPY = ROOT / "tmp_label_set.db"
SEED = 20261012
PER_STRATUM = 20


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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="docs/plans/live-type-label-set.md")
    ap.add_argument("--per-stratum", type=int, default=PER_STRATUM)
    args = ap.parse_args()

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
        "| `fitness` | 健身 | ⚠️ **本批要换成「助眠」** —— 见到健身类请照旧标 `fitness`，我会在 T3 一起处理 |",
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
        "1. 你的判断 → 一份固定回归集（**跟着本文件留档**，进 `tests/` 的判据）；",
        "2. T3 每改一次规则，都跑一遍这份回归集 ⇒ 输出「吻合率 + 错在哪」（哪些原来对的变错了）；",
        "3. 另配两个连续指标（`fallback` 率、人工校正率）—— ⚠️ 它们**单独不够**：",
        "   区分不了「更准」与「把错换了个错法」，必须配这份固定集。",
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


if __name__ == "__main__":
    main()
