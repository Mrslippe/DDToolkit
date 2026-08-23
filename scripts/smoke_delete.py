import sys, json, sqlite3, urllib.request, urllib.error

port = sys.argv[1]
uid = sys.argv[2] if len(sys.argv) > 2 else "282994"
db = r"C:\Users\zx\AppData\Roaming\com.ddtoolkit.app-dev\vtuber.db"

def req(method, path, body=None):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json"} if body else {})
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read()) if e.headers.get("Content-Type","").startswith("application/json") else None

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
print("PASS" if (v==0 and a==0 and p==0 and st==201 and st2==204) else "FAIL")