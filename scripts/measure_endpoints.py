# -*- coding: utf-8 -*-
"""端点耗时快照：把「读路径有多慢」变成一个**可重复跑的数字**（`devlog/460`，补 `devlog/459` 的缺口）。

## 为什么要有这个脚本

`devlog/459` 那次回归（`/live-sessions` 从 32ms 变 8.9s）**此前没有任何仪器能发现** ——
`scripts/perf_report.py` 量的是进程内存/启动，判据里也没有"端点耗时"这一项，
所以是用户先感觉到卡。这个脚本补的就是那条缺口：一串读端点的**中位数耗时**，
值登记进 `docs/ops/PERF.md`（那是唯一允许写测量值的活文档）。

## 口径（四条，缺一条结论就不可信）

1. **只读**：真机库以 `mode=ro` 打开（脚本**不可能**写用户数据）；
2. **进程内打真实端点**（`TestClient`）—— 含 Pydantic 序列化，这才是用户等的那一份；
3. **跳过会出网/会写的端点**：`…/upstream`（打 danmakus）在只读库上还会尝试写库 ⇒ 不量它，
   免得把"网络慢"记成"我们慢"；
4. **非 200 一律当失败，不打数字**（见下）。

## ⚠️ 为什么 ④ 是必须的（2026-10-10 第一次跑就踩了）

第一版忘了带 `X-DDToolkit-Token`（S1 起后端要它），于是**八个端点全 401**，
而 401 是中间件里**没进业务代码**就返回的 —— 表里于是整整齐齐印着「3ms」，
判决行还写着「最慢的一项中位数：4ms」。**这不是"没测出来"，这是"仪器在说谎"**：
一次真实的 8.9s 回归（`devlog/459`）与它同框也看不出来。所以现在**任何非 200 直接
终止并退出码 1**，宁可不给数字，也不给一份"看起来全绿"的表。

用法：
    .venv\\Scripts\\python.exe scripts/measure_endpoints.py                 # 用真机数据目录
    .venv\\Scripts\\python.exe scripts/measure_endpoints.py --db <路径>      # 指定库
    .venv\\Scripts\\python.exe scripts/measure_endpoints.py --runs 7        # 每端点跑几次（默认 5）
    .venv\\Scripts\\python.exe scripts/measure_endpoints.py --breakdown     # 再拆一次最慢那项
"""
from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from dev_token import (  # noqa: E402
    ENV as DEV_TOKEN_ENV,
    PROD_ENV as PROD_TOKEN_ENV,
    headers as dev_headers,
    token as dev_token_value,
)

# ⚠️ **必须在任何 `app.*` 导入之前**：`app/core/config.py` 是在**导入时**读环境变量的，
#    晚一行设就等于没设 —— 而症状就是上面 ④ 说的那张"全 401 的假绿表"。
os.environ[DEV_TOKEN_ENV] = dev_token_value()
os.environ[PROD_TOKEN_ENV] = ""

from fastapi.testclient import TestClient              # noqa: E402
from sqlalchemy import create_engine, text             # noqa: E402
from sqlalchemy.orm import sessionmaker                # noqa: E402

#: 每个端点跑几次取中位数（首跑含冷缓存，中位数比均值稳 —— 同 `_fmt_ms_stats` 的口径）
DEFAULT_RUNS = 5


def _default_db() -> Path | None:
    """真机数据目录（与 `scripts/ui_probe.py` 同一套定位口径）。"""
    import os

    env = os.environ.get("DDTOOLKIT_DATA_DIR")
    if env:
        p = Path(env) / "vtuber.db"
        if p.exists():
            return p
    appdata = Path(os.environ.get("APPDATA", "")) / "com.ddtoolkit.app-dev" / "vtuber.db"
    return appdata if appdata.exists() else None


def _readonly_session(db_path: Path):
    """**只读**引擎（`mode=ro`）：本脚本在任何情况下都写不了用户数据。"""
    uri = f"sqlite:///file:{db_path.as_posix()}?mode=ro&uri=true"
    engine = create_engine(uri, connect_args={"check_same_thread": False})
    return sessionmaker(bind=engine)


def main() -> int:
    ap = argparse.ArgumentParser(description="读端点耗时快照（真机库只读）")
    ap.add_argument("--db", default="", help="sqlite 路径（默认自动找真机数据目录）")
    ap.add_argument("--runs", type=int, default=DEFAULT_RUNS, help="每端点跑几次取中位数")
    ap.add_argument("--account", type=int, default=0, help="指定账号 id（默认取场次最多的那个）")
    ap.add_argument("--breakdown", action="store_true",
                    help="把 /live-sessions 那一项再拆到段（取数/聚类/推断/序列化）")
    args = ap.parse_args()

    db_path = Path(args.db) if args.db else _default_db()
    if db_path is None or not db_path.exists():
        print("找不到库（用 --db 指定，或设 DDTOOLKIT_DATA_DIR）")
        return 2
    print(f"库：{db_path}（**只读**打开）")

    Session = _readonly_session(db_path)
    probe = Session()
    if args.account:
        aid = args.account
    else:
        aid = probe.execute(text(
            "SELECT account_id FROM live_sessions GROUP BY account_id "
            "ORDER BY COUNT(*) DESC LIMIT 1")).scalar() or 0
    lid = probe.execute(text(
        "SELECT live_id FROM live_sessions WHERE account_id=:a AND live_id IS NOT NULL "
        "ORDER BY start_at DESC LIMIT 1"), {"a": aid}).scalar() or ""
    n_sessions = probe.execute(text("SELECT COUNT(*) FROM live_sessions WHERE account_id=:a"),
                               {"a": aid}).scalar() or 0
    probe.close()
    print(f"账号 {aid}（表内 {n_sessions} 场，最新场次 {lid}）｜每端点 {args.runs} 次取中位数\n")

    # 让进程内那个 app 也连**只读副本**；池子指向仓库那份（新列齐全）
    from app.core import config as cfg
    from app.core.database import get_db
    from app.main import app
    from app.services import pool

    cfg.settings.VTUBER_LIST_FILE = str(ROOT / "vtubers.csv")
    pool.reload_pool()

    def _override():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _override
    client = TestClient(app)
    headers = dev_headers()
    print(f"请求头：{'、'.join(headers)}（开发态固定值，见 scripts/dev_token.py）\n")

    endpoints: list[tuple[str, str]] = [
        ("场次列表（数据视图的日历卡）", f"/account/{aid}/live-sessions"),
        ("场次详情（点日期格的弹窗）", f"/account/{aid}/live-sessions/{lid}"),
        ("粉丝趋势（数据视图的折线卡）", f"/account/{aid}/fan-trend"),
        ("礼物日聚合", f"/account/{aid}/gift-days"),
        ("V 列表（左栏，含企划）", "/vtuber/list"),
        ("候选池检索（9.6k 行线性扫）", "/vtuber/pool/search?kw=%E5%A1%94%E8%8F%B2"),
        ("能力矩阵（每次开设置窗都打）", "/capabilities"),
        ("通知汇总（顶栏状态岛轮询）", "/vtuber/notices"),
    ]

    rows: list[tuple[str, float, float, float]] = []
    bad: list[str] = []
    for label, url in endpoints:
        times: list[float] = []
        r = None
        for _ in range(args.runs):
            t0 = time.perf_counter()
            r = client.get(url, headers=headers)
            times.append((time.perf_counter() - t0) * 1000)
        assert r is not None
        if r.status_code != 200:
            # ④：**不给数字**。非 200 的耗时是"被拒得多快"，与读路径无关。
            bad.append(f"  GET {url} → {r.status_code}｜{label}\n     {r.text[:160]}")
            continue
        rows.append((label, statistics.median(times), min(times), max(times)))

    if bad:
        print("❌ 有端点没通，**本次不产出任何耗时结论**（否则就是一份假绿表）：")
        print("\n".join(bad))
        print("\n先查：DDTOOLKIT_DEV_API_TOKEN 是否与请求头同值（scripts/dev_token.py）。")
        app.dependency_overrides.clear()
        return 1

    print(f"{'端点':<28}{'中位':>9}{'最快':>9}{'最慢':>9}   状态")
    print("-" * 72)
    for label, med, lo, hi in rows:
        print(f"{label:<28}{med:>7.0f}ms{lo:>7.0f}ms{hi:>7.0f}ms   200")
    print("-" * 72)
    meds = sorted((med, label) for label, med, _, _ in rows)
    worst_med, worst_label = meds[-1]
    print(f"最慢的一项：{worst_label} 中位 {worst_med:.0f}ms"
          f"（判据：读端点该在百毫秒级；>=1000ms 基本就是「循环里干了每请求一次的重活」）")
    print(f"八项中位数合计 {sum(m for m, _ in meds):.0f}ms"
          f" —— 用户打开数据视图那一屏串行拉这些卡片的量级下限")
    if args.breakdown:
        _breakdown(Session, aid, args.runs)
    app.dependency_overrides.clear()
    return 0


def _breakdown(Session, account_id: int, runs: int) -> None:
    """把 `/live-sessions` 的中位数**拆到段**（`--breakdown`）。

    ## 为什么它不是"顺手加的"

    表里最慢那一项（场次列表）**本来有两个数**：`devlog/459` 记的是 **32ms**，
    而这次端到端量出来是 **155ms** —— 差 5 倍。查下来两个都对，量的是**不同东西**：
    459 量的是「聚类 + 词库」那一段（正是出 O(n²) 的地方），32ms 与这里的
    `_infer_basis + 推断循环`（9 + 36 = 45ms）同量级；差值在**取数**与**序列化**上。
    也就是说，**只报一个端到端数字，就没法判断"这次改动到底动了哪一段"**——
    而这恰恰是修回归时最需要的那句话。所以拆段在这里是仪器的组成部分，不是附件。

    ⚠️ 与主表不同，这里 import 的是 `app` 内部（仓库层 + 路由私有函数）⇒ **会随重构漂**。
    漂了就直说（打印一行"拆段脚本没跟上重构"并返回），不要抛栈 ——
    它是排查工具，不该在排查时自己变成第二个问题。
    """
    print("\n【拆段】/live-sessions 的耗时构成（同一进程、同一只读库）")
    try:
        from app.repositories.vtuber_repo import AccountStatSnapshotRepo, LiveSessionRepo
        from app.routers.vtuber import (
            _infer_basis, _infer_session, _live_infer_ctx, _session_payload,
        )
        from app.schemas.vtuber import LiveSessionOut
    except ImportError as exc:                                  # pragma: no cover
        print(f"  ⚠️ 拆段脚本没跟上重构：{exc}")
        print("  （主表不受影响；修 `_breakdown()` 里的 import 即可）")
        return

    db = Session()

    def ms(fn):
        ts = []
        r = None
        for _ in range(runs):
            t0 = time.perf_counter()
            r = fn()
            ts.append((time.perf_counter() - t0) * 1000)
        return statistics.median(ts), r

    try:
        m_ctx, ctx = ms(lambda: _live_infer_ctx(db, account_id))
        account, vtuber, event_dates, overrides = ctx
        if not account:
            print(f"  （账号 {account_id} 不在库里，拆不了）")
            return
        m_merged, sessions = ms(lambda: LiveSessionRepo(db).merged(account_id))
        m_basis, basis = ms(lambda: _infer_basis(sessions, overrides))
        m_loop, inferred = ms(lambda: [
            _infer_session(s, vtuber=vtuber, event_dates=event_dates, overrides=overrides,
                           basis=basis, live_id=s.get("live_id"))
            for s in sessions])
        m_payload, payloads = ms(lambda: [
            _session_payload(s, account_id, c, f) for s, (c, f) in zip(sessions, inferred)])
        m_schema, _ = ms(lambda: [LiveSessionOut(**p) for p in payloads])
        # 取数内部再拆一层：ORM 装载 vs 纯 Python 合并
        m_rows, table_rows = ms(lambda: LiveSessionRepo(db).list_by_account(account_id))
        m_snap, snaps = ms(lambda: AccountStatSnapshotRepo(db).live_sessions(account_id))
    finally:
        db.close()

    total = m_ctx + m_merged + m_basis + m_loop + m_payload + m_schema
    print(f"  场次数 {len(sessions)}（表内 {len(table_rows)} 行 + 自观测快照 {len(snaps)} 行）")
    for label, v in (("_live_infer_ctx（账号/V/纪念日/校正）", m_ctx),
                     ("repo.merged（合并视图）", m_merged),
                     ("  ├ list_by_account（ORM 装载）", m_rows),
                     ("  ├ live_sessions 快照", m_snap),
                     ("  └ 分组合并（纯 Python）", max(m_merged - m_rows - m_snap, 0.0)),
                     ("_infer_basis（聚类+词库，循环外一次）", m_basis),
                     ("推断循环（逐场次）", m_loop),
                     ("_session_payload", m_payload),
                     ("Pydantic 序列化", m_schema)):
        share = f"{v / total * 100:4.0f}%" if total else "  n/a"
        print(f"  {label:<38}{v:>8.1f}ms  {share}")
    print(f"  {'合计':<38}{total:>8.1f}ms")
    print("  ⚠️ 端到端会比这个合计再高一些（TestClient + JSON 编码），差额看主表那一行。")


if __name__ == "__main__":
    sys.exit(main())
