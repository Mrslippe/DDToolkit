"""冒烟：解订阅（DELETE /vtuber/{id}）是否真的把帖子与子表清干净。

用法（需要先有一个在跑的**开发态**后端）:

    $env:DDTOOLKIT_DATA_DIR = "$env:APPDATA\\com.ddtoolkit.app-dev"   # 必须！见下
    python backend_main.py            # 另开一个窗口，记下端口
    python scripts/smoke_delete.py <port> [uid]

它会：adopt 一个候选池账号 → 直接往库里插一条帖子 → DELETE 该 V →
断言 vtubers / accounts / posts 三表都不再有它。

⚠️ 这是**破坏性冒烟**（会对真实数据目录 adopt 再 delete）。因此：

- 库路径**从 `settings` 推导**（跟随 `DDTOOLKIT_DATA_DIR`），不再硬编码某台机器的绝对路径
  —— 2026-09-13 复查硬编码路径时发现旧写法写死了 `C:\\Users\\zx\\...`，
  既绕过了数据目录约定，也在换机器 / 改用户名 / 改盘符后静默指向错误（或不存在的）库；
- **必须显式设 `DDTOOLKIT_DATA_DIR`**：不设时 `settings` 会回退到**项目根**的库
  （那是裸跑残留，不是真库），此时本脚本会拒绝运行；
- 路径**必须含 `-dev`**（开发库）才肯继续，防止手滑对着安装版数据目录跑。
  确需对别的库跑，设 `DDTOOLKIT_SMOKE_ALLOW_ANY_DB=1` 显式放行。
"""
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))   # 与其它 scripts/ 同款：允许直跑
sys.path.insert(0, str(Path(__file__).parent))          # 开发态 token 真源在 scripts/ 下

from app.core.config import settings  # noqa: E402
import dev_token  # noqa: E402

if len(sys.argv) < 2:
    raise SystemExit("用法: python scripts/smoke_delete.py <后端端口> [platform_uid]")

port = sys.argv[1]
uid = sys.argv[2] if len(sys.argv) > 2 else "282994"

# 从 settings 推导（= DATABASE_URL 去掉 sqlite:/// 前缀），与全仓其它脚本口径一致
_db_path = settings.DATABASE_URL.replace("sqlite:///", "")
db = str(_db_path)

if "-dev" not in db and os.getenv("DDTOOLKIT_SMOKE_ALLOW_ANY_DB") != "1":
    raise SystemExit(
        f"拒绝运行：目标库看起来不是开发库（{db}）。\n"
        f"本脚本会对它 adopt 再 delete。开发库路径应含 '-dev'；\n"
        f"若确实要对该库跑，请设 DDTOOLKIT_SMOKE_ALLOW_ANY_DB=1。"
    )
print(f"目标库: {db}")


def req(method, path, body=None):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode() if body is not None else None
    # ⚠️ S1 起业务端点要 token（2026-09-26 补）：本脚本打的是**人手动起的**后端，
    #    所以取值口径是"环境变量优先"（`dev_token.token()`）—— 你起后端时设了什么，
    #    这里就用什么；都没设就用真源默认值（两边一致才通）。
    headers = {**dev_token.headers()}
    if body:
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print(f"\n[!] 401：后端要 token，而本脚本发的与它认的不一致。\n"
                  f"    起后端时请设 {dev_token.ENV}={dev_token.token()}，"
                  f"或在本 shell 里设同一个变量后重跑本脚本。")
        return e.code, json.loads(e.read()) if e.headers.get("Content-Type", "").startswith("application/json") else None


st, adopt = req("POST", "/vtuber/adopt", {"platform": "bilibili", "platform_uid": uid})
print("adopt:", st, adopt.get("name") if isinstance(adopt, dict) else adopt)
vid = adopt["id"]

conn = sqlite3.connect(db)
conn.execute("INSERT INTO posts (platform, platform_uid, platform_post_id, type, title, is_archived) VALUES (?,?,?,?,?,0)",
             ("bilibili", uid, "smoke_post_1", "text", "SMOKE"))
conn.commit()
n1 = conn.execute("SELECT COUNT(*) FROM posts WHERE platform_uid=?", (uid,)).fetchone()[0]
print("posts before delete:", n1)

st2, _ = req("DELETE", f"/vtuber/{vid}")
print("delete:", st2)

v = conn.execute("SELECT COUNT(*) FROM vtubers WHERE id=?", (vid,)).fetchone()[0]
a = conn.execute("SELECT COUNT(*) FROM accounts WHERE vtuber_id=?", (vid,)).fetchone()[0]
p = conn.execute("SELECT COUNT(*) FROM posts WHERE platform_uid=?", (uid,)).fetchone()[0]
conn.close()
print("after delete -> vtubers:", v, "accounts:", a, "posts:", p)
print("PASS" if (v == 0 and a == 0 and p == 0 and st == 201 and st2 == 204) else "FAIL")
