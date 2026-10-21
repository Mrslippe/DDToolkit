"""v1（重复率）vs v2（时间分布）判定对比。

直接读 raw（`mt`/`mh` 序列在 raw 里），不依赖 loader 的 UserFact。

用法：python scripts/spam_v2_compare.py
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from app.services.fan.spam import is_spam
from app.services.fan.spam2 import Trace, feed, verdict

ROOT = Path("E:/work/Project/database/dev/fan-structure")
VS = ("pilot_v3_mingqian", "pilot_v3_xingtong", "pilot_v3_mizuki")


def main() -> None:
    for sub in VS:
        d = ROOT / sub
        traces: dict[str, Trace] = {}
        for idx, f in enumerate(sorted((d / "raw").glob("*.json"))):
            raw = json.loads(f.read_text(encoding="utf-8"))
            for uid, a in raw.items():
                if not isinstance(a, dict) or not a.get("mh"):
                    continue
                tr = traces.get(uid)
                if tr is None:
                    tr = traces[uid] = Trace()
                feed(tr, session_idx=idx, mt=a.get("mt") or [], mh=a.get("mh") or [])

        v1 = set(); v2 = set(); rules = Counter(); msgs = 0
        for uid, tr in traces.items():
            if tr.messages < 20:
                continue
            msgs += tr.messages
            flag1 = is_spam(uniq=tr.uniq, maxrep=tr.maxrep, m=tr.messages)
            if flag1:
                v1.add(uid)
            flag2, rule = verdict(tr)
            rules[rule] += 1
            if flag2:
                v2.add(uid)
        v2_msgs = sum(traces[u].messages for u in v2)
        print(f"\n{sub}: 活跃用户 {sum(1 for t in traces.values() if t.messages >= 20):,}"
              f" · 消息 {msgs:,}")
        print(f"  v1 判定 {len(v1):,} 人（{len(v1)/max(1,len(traces)):.2%}）")
        print(f"  v2 判定 {len(v2):,} 人（{len(v2)/max(1,len(traces)):.2%}），覆盖消息 {v2_msgs:,}")
        print(f"  交集 {len(v1 & v2):,} · 只有 v1 抓到 {len(v1 - v2):,} · 只有 v2 抓到 {len(v2 - v1):,}")
        print(f"  v2 规则分布: {dict(rules)}")
        new = sorted(v2 - v1, key=lambda u: -traces[u].messages)[:3]
        for u in new:
            t = traces[u]
            print(f"    新增 {u}: 消息 {t.messages:,} · 不同文本 {t.uniq:,}"
                  f"（{t.variety:.1%}）· 低多样性场次 {t.low_variety_sessions}"
                  f" · 单场最高重复 {t.maxrep} · 跨场 {t.cross_sessions}")


if __name__ == "__main__":
    main()
