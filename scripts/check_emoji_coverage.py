"""诊断：第一源（我们自己载荷里的表情）到底能解析出多少（只读、离线、可当探针）。

用法：

    $env:DDTOOLKIT_DATA_DIR = "$env:APPDATA\\com.ddtoolkit.app-dev"
    python scripts/check_emoji_coverage.py [--min 90] [--panel] [--show 30]

它做的事：读 `posts.raw_json`，用**生产同一套**解析器（`bili_emote.scan_payloads`）建索引，
再拿正文里的 token（`body_json.text`，按前端 `emojiText.ts` 同款方括号规则切）去 `resolve`，
报两个覆盖率和"没解析出来的都是些什么"。

**口径**：量的是 `body_json.text` —— **前端详情页真正渲染的那个字段**（`PostText` 拿的就是它）。
`body_text`（列表摘要/全文检索那一列）另有 8 个 `[3P]`…`[13P]` 分P 标记 ⇒ 数字更大，
**两个字段的数不能混着比**（`devlog/483` 就是在这里把两个数对上账的）。脚本会把两者都印出来。

**为什么要有这个脚本**：覆盖率 99% 是 2026-10-13 一次性的实测结论（`devlog/483`），
而它依赖两个会变的东西 —— ①B站 载荷的形状（上游改字段就全塌）；②我们的抓取口径
（比如哪天只存了提取后的纯文本、raw_json 留空）。两种塌法都**不会报错**：帖子里就是
退回一串方括号。所以留一个能一条命令量出来的探针，别等用户来报"表情又不显示了"。

全绿退出码 0；低于阈值（默认 90%）退出码 1。

`--panel` 会**出网**再量一遍第二源（上游整表）的覆盖 —— 默认不跑：那个数**账号相关**，
换台机器就变，不该当门槛（实测本机 28%，`devlog/483`）。

⚠️ **只读**：sqlite `mode=ro`，不写 `app_meta`、不扫表进缓存。
"""
import argparse
import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))   # 与其它 scripts/ 同款：允许直跑

# 中文控制台是 GBK：打不出的字符直接替换，别把脚本打断（同 check_danmaku_fetch.py）
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")

from app.core.config import settings                                    # noqa: E402
from app.services import bili_emote                                     # noqa: E402

#: 与前端 `frontend/src/utils/emojiText.ts` 的 `TOKEN_RE` **必须一致**（改一处要改两处）
TOKEN_RE = re.compile(r"\[([^\[\]\s]{1,60})\]")
#: 与前端 `NOT_EMOJI` 一致：微博话题标记，不是表情
NOT_EMOJI = {"话题"}

ap = argparse.ArgumentParser()
ap.add_argument("--min", type=float, default=90.0, help="覆盖率下限（百分比，默认 90）")
ap.add_argument("--panel", action="store_true", help="额外出网量第二源（账号相关，仅供参考）")
ap.add_argument("--show", type=int, default=20, help="最多列几个没解析出来的 token")
args = ap.parse_args()

DB = settings.DATABASE_URL.replace("sqlite:///", "")
if not Path(DB).exists():
    raise SystemExit(f"库不存在：{DB}\n请先设 DDTOOLKIT_DATA_DIR 指向开发数据目录。")
print(f"目标库（只读）: {DB}\n")

con = sqlite3.connect(f"file:{Path(DB).as_posix()}?mode=ro", uri=True)
try:
    rows = con.execute("SELECT raw_json FROM posts WHERE raw_json IS NOT NULL").fetchall()
    body_rows = con.execute(
        "SELECT body_json, body_text FROM posts").fetchall()
finally:
    con.close()

# ① 建索引：**走生产函数**（这样解析规则一改，探针量的就是改后的）
index = bili_emote.scan_payloads([rj for (rj,) in rows])
pkgs = {p for _u, p, _s in index.values() if p}


def cut(text: str | None) -> Counter:
    """切 token（与前端同一套规则；`[话题]` 是微博话题标记，排除）。"""
    return Counter(t for t in TOKEN_RE.findall(text or "") if t not in NOT_EMOJI)


# ② 收正文 token（按出现次数排序，因为"少画一枚热门表情"比"少画一枚冷门"严重得多）
tokens: Counter[str] = Counter()
ref_text: Counter[str] = Counter()      # 参照：body_text 那一列（口径不同，只印不判）
for bj, bt in body_rows:
    try:
        body = json.loads(bj)
    except (TypeError, ValueError):
        body = None
    tokens += cut(body.get("text") if isinstance(body, dict) else None)
    ref_text += cut(bt)

if not tokens:
    raise SystemExit("正文里一个表情 token 都没有 —— 要么库是空的，要么切词规则和前端不一致了。")

hits = bili_emote.resolve(list(tokens), index)
miss = [(t, n) for t, n in tokens.most_common() if t not in hits]
hit_n = sum(n for t, n in tokens.items() if t in hits)
total_n = sum(tokens.values())
ok_rate = len(hits) / len(tokens) * 100
occ_rate = hit_n / total_n * 100
# 兜底规则的依据：两级都解析不出来的那些，**是不是真表情**（带下划线只可能是表情）
miss_emote_like = [(t, n) for t, n in miss if "_" in t]
# 两类大小（B站 自己的 `size` 字段）：命中里各占多少 —— 这个分布决定"按 18px 一律画"错得多远
small_occ = sum(n for t, n in tokens.items() if hits.get(t, (None, None))[1] == 1)
large_occ = sum(n for t, n in tokens.items() if hits.get(t, (None, None))[1] == 2)

print(f"载荷行数     {len(rows)}")
print(f"索引名字     {len(index)}（包 {len(pkgs)} 个）")
print(f"正文 token   {len(tokens)} 种 / {total_n} 次   ← `body_json.text`（前端渲染的那个字段）")
print(f"  参照       {len(ref_text)} 种 / {sum(ref_text.values())} 次   ← `body_text`"
      f"（口径不同：多出 {sorted(set(ref_text) - set(tokens))[:8]} 这类分P 标记，别混着比）")
print(f"覆盖率       种类 {len(hits)}/{len(tokens)} = {ok_rate:.1f}%   "
      f"次数 {hit_n}/{total_n} = {occ_rate:.1f}%")
print(f"两类大小     小（size=1）{small_occ} 次 / 大（size=2）{large_occ} 次"
      f"   ⇒ 大表情占 {large_occ / max(small_occ + large_occ, 1) * 100:.0f}% 的出现次数")
print(f"\n没解析出来的（最多列 {args.show} 个，按出现次数）：")
for t, n in miss[:args.show]:
    print(f"  {n:5d}×  [{t}]")
if len(miss) > args.show:
    print(f"  …还有 {len(miss) - args.show} 个")
print(f"其中**像表情**的（带下划线）：{len(miss_emote_like)} 个"
      + ("" if not miss_emote_like
         else f" ← ⚠️ {miss_emote_like[:8]}"
              "\n  ⇒ 这些才是真「漏了」；上面那些 `1P`/`▓▓` 本来就**不该画**（分P 标记/被屏蔽词）"))

failed = []
for label, rate in (("种类", ok_rate), ("次数", occ_rate)):
    if rate < args.min:
        failed.append(f"{label}覆盖率 {rate:.1f}% < {args.min}%")

if args.panel:
    import asyncio

    print("\n第二源（**出网**，账号相关，仅供参考）：")
    pidx, why = asyncio.run(bili_emote.emote_index(force=True))
    if why:
        print(f"  拉取有问题：{why}")
    phits = bili_emote.resolve(list(tokens), pidx)
    union = set(hits) | set(phits)
    print(f"  单独第二源 {len(phits)}/{len(tokens)} = {len(phits)/len(tokens)*100:.1f}%"
          f"   两级并集 {len(union)}/{len(tokens)} = {len(union)/len(tokens)*100:.1f}%")

print()
if failed:
    print("不达标：" + "；".join(failed)
          + "\n  ⇒ 先查载荷形状是否变了（`rich_text_nodes[*].emoji`），"
            "再查抓取是否还在存 raw_json。")
    sys.exit(1)
print(f"覆盖率达标（下限 {args.min}%）")
