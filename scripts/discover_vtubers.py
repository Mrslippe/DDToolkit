"""
独立脚本：从 vtbs.moe 拉取 VTuber 名单，获取 B站粉丝数，按粉丝数降序写入 vtubers.csv。

用法:
    python scripts/discover_vtubers.py                      # 全量，flag 全为 0（手动选择）
    python scripts/discover_vtubers.py --min-fans 10000     # 粉丝 >= 1万自动 flag=1
    python scripts/discover_vtubers.py --limit 50           # 仅前 50 名
    python scripts/discover_vtubers.py --no-stats           # 跳过粉丝数，快速导出
"""
import asyncio
import argparse
import csv
import random
import sys
from pathlib import Path

import httpx

VTBS_MOE_URL = "https://vdb.vtbs.moe/json/list.json"
OUTPUT_FILE = Path(__file__).parent.parent / "vtubers.csv"
OUTPUT_COLUMNS = ["flag", "vtuber_name", "platform", "platform_uid", "follower"]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
}


async def fetch_vtbs_list() -> list[dict]:
    """从 vtbs.moe 获取 VTuber 名单，筛出 B站官方账号"""
    print("[1/3] 正在从 vtbs.moe 获取名单...")
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(VTBS_MOE_URL)
        resp.raise_for_status()
        data = resp.json()

    vtbs: list[dict] = []
    for v in data.get("vtbs", []):
        name_obj = v.get("name", {})
        name = name_obj.get("cn") or name_obj.get("en") or name_obj.get("jp", "")
        if not name:
            continue
        for acc in v.get("accounts", []):
            if acc.get("platform") == "bilibili" and acc.get("type") == "official":
                uid = acc.get("id")
                if uid:
                    vtbs.append({"name": name, "uid": uid, "follower": 0})
                break
    print(f"    找到 {len(vtbs)} 个 B站 虚拟主播")
    return vtbs


async def fetch_one_follower(v: dict, client: httpx.AsyncClient, sem: asyncio.Semaphore,
                             counter: list[int], delay: float):
    """获取单个 VTuber 的粉丝数"""
    async with sem:
        await asyncio.sleep(delay + random.uniform(0, delay))
        try:
            url = f"https://api.bilibili.com/x/relation/stat?vmid={v['uid']}"
            resp = await client.get(url, headers=HEADERS, timeout=10.0)
            data = resp.json()
            if data.get("code") == 0:
                v["follower"] = data["data"].get("follower", 0)
        except Exception:
            pass
        counter[0] += 1
        if counter[0] % 500 == 0:
            print(f"    进度: {counter[0]}/{counter[1]}")


async def main():
    args = parse_args()

    # 1. 获取名单
    vtbs = await fetch_vtbs_list()
    if not vtbs:
        print("未获取到任何 VTuber，退出。")
        sys.exit(1)

    # 2. 并发获取粉丝数（可跳过）
    if not args.no_stats:
        print(f"[2/3] 正在获取粉丝数（{args.concurrency} 并发, {args.delay}s 间隔）...")
        sem = asyncio.Semaphore(args.concurrency)
        counter = [0, len(vtbs)]
        async with httpx.AsyncClient(timeout=10.0) as client:
            tasks = [fetch_one_follower(v, client, sem, counter, args.delay) for v in vtbs]
            await asyncio.gather(*tasks)
        print(f"    进度: {counter[0]}/{counter[1]} — 完成")

        vtbs.sort(key=lambda v: v["follower"], reverse=True)

        # --min-fans: 达到门槛的自动标记为 1，其余为 0（不做过滤，全部写入）
        threshold = args.min_fans
        if threshold:
            for v in vtbs:
                v["flag"] = 1 if v["follower"] >= threshold else 0
        else:
            for v in vtbs:
                v["flag"] = 0
    else:
        print("[2/2] 跳过粉丝数获取，直接写入...")
        for v in vtbs:
            v["flag"] = 0

    if args.limit:
        vtbs = vtbs[:args.limit]

    # 3. 写入 CSV
    print(f"[写入] 正在写入 {OUTPUT_FILE} ...")
    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(OUTPUT_COLUMNS)
        for v in vtbs:
            writer.writerow([v["flag"], v["name"], "bilibili", v["uid"], v["follower"]])

    auto_count = sum(1 for v in vtbs if v["flag"] == 1)
    print(f"完成：{len(vtbs)} 个 VTuber 已写入 (自动标记 {auto_count} 个)")
    if vtbs:
        top = [v for v in vtbs[:3]]
        try:
            print(f"TOP 3: {top[0]['name']}({top[0]['follower']}), "
                  f"{top[1]['name']}({top[1]['follower']}), "
                  f"{top[2]['name']}({top[2]['follower']})")
        except UnicodeEncodeError:
            print("TOP 3: (含特殊字符，无法显示)")


def parse_args():
    p = argparse.ArgumentParser(description="VTuber 发现工具：从 vtbs.moe 拉取名单并写入 vtubers.csv")
    p.add_argument("--min-fans", type=int, default=0,
                   help="粉丝数 >= 此值的自动标记 flag=1，其余为 0")
    p.add_argument("--limit", type=int, default=0, help="最多写入人数")
    p.add_argument("--concurrency", type=int, default=2, help="并发请求数（默认 2）")
    p.add_argument("--delay", type=float, default=0.5, help="请求间隔秒数（默认 0.5）")
    p.add_argument("--no-stats", action="store_true", help="跳过粉丝数获取，全部 flag=0 快速导出")
    return p.parse_args()


if __name__ == "__main__":
    asyncio.run(main())
