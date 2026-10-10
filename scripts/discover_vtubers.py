"""
独立脚本：从 vdb.vtbs.moe 拉取 VTuber 名册（含**企划**与跨平台账号），可选补 B站粉丝数，
按粉丝数降序写入 `vtubers.csv`，并写一份 `vtubers.meta.json`（产物校验 + 可追溯）。

用法:
    python scripts/discover_vtubers.py                   # 增量：只给**新**条目问粉丝数（推荐）
    python scripts/discover_vtubers.py --refresh-followers  # 全量重问（约 1 万次请求，很慢）
    python scripts/discover_vtubers.py --no-stats        # 完全不问，粉丝数沿用旧值/为 0
    python scripts/discover_vtubers.py --limit 50        # 只写前 50 名（调试）
    python scripts/discover_vtubers.py --list-json <路径> # 用本地缓存跑（离线重跑 / 用例）

## 上游与口径（2026-10-08，需求 7 的 C2 批，`devlog/457`）

- **主源 = vdb.vtbs.moe `list.json`**（`{"meta":…,"vtbs":[…]}`）：132 万字节级、免鉴权，是**唯一**
  同时给"名册 + 企划归属（`group`/`group_name`）+ 跨平台账号 + 稳定 `uuid`"的接口。
  实测一次拉取 12–50 秒不等（不稳定）⇒ 支持 `--list-json` 用缓存重跑。
- **只收 `type == "official"` 的 B 站账号**（实测 official 9,797 / relay 60）：`relay` 是搬运/转播号，
  不是本人；没有 official B 站账号的条目（362 条）**收不进来也不该收**（我们没有它的账号可抓）。
- **`type == "group"` 的条目要跳过**：vdb 把"企划本身"也当条目放进 `vtbs`（`group == uuid`、无账号），
  照收会多出一批没有账号的"V"。
- **跨平台账号只写进 `extra_accounts` 一列（仅展示，不进检索池）**：实测非 B 站账号是长尾
  （twitter 695 / youtube 621 / userlocal 233 / twitch 45 / acfun 36 / **weibo 30**），
  而本应用只能抓四家 ⇒ 把它们当"候选条目"会造出一堆**点不动的搜索结果**。
- ⚠️ vdb **没有使用条款与限流说明**（未找到 ≠ 不存在）⇒ 自限速（`--concurrency`/`--delay`）
  ＋本脚本产物**随包**、应用**不在运行时**访问 vdb。
"""
import argparse
import asyncio
import csv
import json
import random
import sys
from pathlib import Path

import httpx

VTBS_MOE_URL = "https://vdb.vtbs.moe/json/list.json"
ROOT = Path(__file__).parent.parent
OUTPUT_FILE = ROOT / "vtubers.csv"
META_FILE = ROOT / "vtubers.meta.json"

#: 列定义（**加列要同步** `app/services/pool.py` 的读取与 `tests/test_pool_csv.py` 的校验；
#: `flag` 是历史列（`--min-fans` 的自动标记），池子检索不用它，保留是为了导入路径兼容）
OUTPUT_COLUMNS = ["flag", "vtuber_name", "platform", "platform_uid", "follower",
                  "uuid", "group_name", "group_uuid", "extra_accounts"]
#: 跨平台账号最多写几个（长尾里有人有 5+ 个；写太多只让 CSV 变胖，展示也不需要）
EXTRA_LIMIT = 6

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
}


def pick_name(v: dict) -> str:
    """vdb 的名字字段：`cn` 最全，其次 `en`/`jp`，再退到 `default` 指的那门语言。

    ⚠️ 实测有脏键（`CN` / `cn+` / `水镜Beryl` / `ID(印度尼西亚)` …）⇒ **逐个候选试**，
    最后才退回字典里第一个非空值 —— 早先只认三个键，那些条目会被整条丢掉。
    """
    name_obj = v.get("name") or {}
    for key in ("cn", "CN", "en", "EN", "jp", "JP"):
        val = (name_obj.get(key) or "").strip()
        if val:
            return val
    default = (name_obj.get("default") or "").strip()
    if default and (name_obj.get(default) or "").strip():
        return name_obj[default].strip()
    for key, val in name_obj.items():
        if key != "extra" and isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def parse_roster(data: dict) -> tuple[list[dict], dict]:
    """vdb → 名册行（只含 official B 站账号的条目）+ 统计。**纯函数，可单独用例。**"""
    rows: list[dict] = []
    seen: dict[str, int] = {}
    skipped_group_entry = skipped_no_official = 0
    for v in data.get("vtbs") or []:
        if (v.get("type") or "") == "group":       # 企划本身不是人（见文件头）
            skipped_group_entry += 1
            continue
        name = pick_name(v)
        accounts = v.get("accounts") or []
        official = next((a for a in accounts
                         if (a.get("platform") or "").lower() == "bilibili"
                         and a.get("type") == "official" and str(a.get("id") or "").strip()),
                        None)
        if not name or official is None:
            if official is None:
                skipped_no_official += 1
            continue
        uid = str(official["id"]).strip()
        extras = [f"{(a.get('platform') or '').lower()}:{a.get('id')}"
                  for a in accounts
                  if (a.get("platform") or "").lower() not in ("bilibili", "")
                  and str(a.get("id") or "").strip()][:EXTRA_LIMIT]
        row = {
            "name": name, "uid": uid, "follower": 0,
            "uuid": (v.get("uuid") or "").strip(),
            # ⚠️ `group` 是**企划的 uuid**、`group_name` 是它的名字；两者缺一都按"没有企划"处理
            "group_name": (v.get("group_name") or "").strip(),
            "group_uuid": (v.get("group") or "").strip(),
            "extra_accounts": "|".join(extras),
        }
        if uid in seen:                            # 上游真出重复时留信息更全的那条
            old = rows[seen[uid]]
            if not old["group_name"] and row["group_name"]:
                rows[seen[uid]] = row
            continue
        seen[uid] = len(rows)
        rows.append(row)
    stats = {"group_entries_skipped": skipped_group_entry,
             "no_official_skipped": skipped_no_official,
             "with_group": sum(1 for r in rows if r["group_name"]),
             "groups": len({r["group_name"] for r in rows if r["group_name"]}),
             "with_extra": sum(1 for r in rows if r["extra_accounts"])}
    return rows, stats


def load_existing_followers(path: Path) -> dict[str, int]:
    """旧 CSV 的 `uid → follower`（增量模式复用，免得为了刷新名册把 1 万次请求重打一遍）。"""
    if not path.exists():
        return {}
    out: dict[str, int] = {}
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            uid = str(row.get("platform_uid") or row.get("uid") or "").strip()
            try:
                out[uid] = int(str(row.get("follower") or "0").strip() or 0)
            except ValueError:
                out[uid] = 0
    return out


async def fetch_vtbs_list(url: str) -> dict:
    print(f"[1/3] 拉 vdb 名册 {url} …")
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(url, headers=HEADERS)
        resp.raise_for_status()
        return resp.json()


async def fetch_one_follower(row: dict, client: httpx.AsyncClient,
                             sem: asyncio.Semaphore, counter: list[int], delay: float):
    async with sem:
        await asyncio.sleep(delay + random.uniform(0, delay))
        try:
            url = f"https://api.bilibili.com/x/relation/stat?vmid={row['uid']}"
            resp = await client.get(url, headers=HEADERS, timeout=10.0)
            data = resp.json()
            if data.get("code") == 0:
                row["follower"] = data["data"].get("follower", 0)
        except Exception:
            pass
        counter[0] += 1
        if counter[0] % 200 == 0:
            print(f"    进度: {counter[0]}/{counter[1]}")


def write_csv(rows: list[dict], path: Path) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(OUTPUT_COLUMNS)
        for r in rows:
            writer.writerow([r["flag"], r["name"], "bilibili", r["uid"], r["follower"],
                             r["uuid"], r["group_name"], r["group_uuid"], r["extra_accounts"]])


def parse_args():
    p = argparse.ArgumentParser(description="VTuber 名册刷新：vdb → vtubers.csv（+ meta）")
    p.add_argument("--min-fans", type=int, default=0,
                   help="粉丝数 >= 此值的自动标记 flag=1，其余为 0")
    p.add_argument("--limit", type=int, default=0, help="最多写入人数（调试用）")
    p.add_argument("--concurrency", type=int, default=2, help="并发请求数（默认 2）")
    p.add_argument("--delay", type=float, default=0.5, help="请求间隔秒数（默认 0.5）")
    p.add_argument("--no-stats", action="store_true", help="完全不问粉丝数（沿用旧值）")
    p.add_argument("--refresh-followers", action="store_true",
                   help="**重问全部**粉丝数（默认只问新条目；全量约 1 万次请求）")
    p.add_argument("--list-json", default="", help="用本地 list.json 缓存（离线重跑 / 用例）")
    p.add_argument("--out", default=str(OUTPUT_FILE), help="输出 CSV 路径")
    return p.parse_args()


async def main() -> int:
    args = parse_args()
    out = Path(args.out)

    if args.list_json:
        data = json.loads(Path(args.list_json).read_text(encoding="utf-8"))
    else:
        data = await fetch_vtbs_list(VTBS_MOE_URL)

    rows, stats = parse_roster(data)
    if not rows:
        print("名册为空（上游结构变了？）—— 不写文件，保留旧的。")
        return 1
    print(f"[2/3] 名册 {len(rows)} 条｜带企划 {stats['with_group']}"
          f"（{stats['groups']} 个企划）｜带跨平台账号 {stats['with_extra']}"
          f"｜跳过：企划条目 {stats['group_entries_skipped']} / 无 official 账号 "
          f"{stats['no_official_skipped']}")

    # ⚠️ 沿用旧粉丝数要读**实际存在的那份**：`--out` 指向新文件（或用例里的临时路径）时，
    # 若只读它就会"一条都沿用不到" ⇒ 退化成重问全部 1 万条（写这脚本时踩过一次）。
    known = load_existing_followers(out if out.exists() else OUTPUT_FILE)
    reused = sum(1 for r in rows if known.get(r["uid"]))
    to_fetch = rows if args.refresh_followers else [r for r in rows if not known.get(r["uid"])]
    for r in rows:
        if not args.refresh_followers and known.get(r["uid"]):
            r["follower"] = known[r["uid"]]

    if args.no_stats:
        print(f"[2/3] --no-stats：沿用旧值 {reused} 条，其余记 0")
    elif not to_fetch:
        print(f"[2/3] 没有新条目需要问粉丝数（沿用 {reused} 条旧值）")
    else:
        print(f"[2/3] 问粉丝数：{len(to_fetch)} 条（沿用 {reused} 条）"
              f"｜并发 {args.concurrency} 间隔 {args.delay}s")
        sem = asyncio.Semaphore(args.concurrency)
        counter = [0, len(to_fetch)]
        async with httpx.AsyncClient(timeout=10.0) as client:
            await asyncio.gather(*[fetch_one_follower(r, client, sem, counter, args.delay)
                                   for r in to_fetch])
        print(f"    进度: {counter[0]}/{counter[1]} — 完成")

    # 排序：粉丝降序 + **名字兜底**（并列时顺序不再取决于上游返回顺序 ⇒ 产物 diff 可读、可复现）
    rows.sort(key=lambda r: (-r["follower"], r["name"]))
    for r in rows:
        r["flag"] = 1 if (args.min_fans and r["follower"] >= args.min_fans) else 0
    if args.limit:
        rows = rows[:args.limit]

    write_csv(rows, out)
    meta = {
        "fetched_at": __import__("time").strftime("%Y-%m-%d %H:%M:%S"),
        "source": VTBS_MOE_URL,
        "vdb_timestamp": (data.get("meta") or {}).get("timestamp"),
        "rows": len(rows),
        "with_group": sum(1 for r in rows if r["group_name"]),
        "groups": len({r["group_name"] for r in rows if r["group_name"]}),
        "with_extra": sum(1 for r in rows if r["extra_accounts"]),
        "followers_reused": reused,
        "followers_fetched": 0 if (args.no_stats or not to_fetch) else len(to_fetch),
        "skipped": {"group_entries": stats["group_entries_skipped"],
                    "no_official_account": stats["no_official_skipped"]},
        "columns": OUTPUT_COLUMNS,
    }
    meta_path = META_FILE if out == OUTPUT_FILE else out.with_suffix(".meta.json")
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[3/3] 已写入 {out}（{len(rows)} 行）与 {meta_path.name}")
    for r in rows[:3]:
        print(f"    TOP: {r['name']}（{r['follower']} 粉"
              f"{'，企划 ' + r['group_name'] if r['group_name'] else ''}）")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
