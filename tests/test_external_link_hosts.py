"""外链白名单必须覆盖**应用自己会产出的原文/主页链接**（2026-10-08，`devlog/448`）。

## 起因

用户点帖子详情里的「打开原文」⇒ 报：

```
[action] 打开链接失败
这个主机不在允许打开的名单里：t.bilibili.com
https://t.bilibili.com/1256111632951541782
```

名单（`frontend/src-tauri/src/lib.rs` 的 `EXTERNAL_HOSTS`）是**手工维护**的，
而链接是后端各平台的 permalink 构造器拼出来的 —— 两边**没有任何机器联系**。
`lib.rs` 里那句注释（"接入新平台时要同时加这里"）是**写给人看的**，
而写给人做的检查 = 不会做的检查：这次就漏了两个（`t.bilibili.com` 与 `m.weibo.cn`，
后者让微博的「打开原文」同样是坏的，只是还没人点到）。

## 判据（两条，一条管"会长的"，一条管"写死的"）

① `fetcher._dynamic_url` 的**实际产出**（B 站动态/视频/专栏三条分支 —— 它是**随内容类型
   增长**的那一处）主机必须在白名单里；
② 各平台模块里出现的**用户可见链接主机字面量**必须在白名单里（扫源码对账）。

⚠️ ② 的扫描只认"应用会拿给用户点"的那几个子域（`t./m./www./space./live.` + 裸域），
**故意不认 `api.` / `passport.`** —— 那些是接口地址，不是给用户点的链接，
混进来会让这条判据天天红（然后就没人看了）。
"""
import re
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
LIB_RS = ROOT / "frontend" / "src-tauri" / "src" / "lib.rs"

#: 会产出"给用户点的链接"的源码（新增平台时把它加进来）
LINK_SOURCES = (
    "app/services/fetcher.py",
    "app/services/platforms/weibo.py",
    "app/services/platforms/xiaohongshu.py",
    "app/services/platforms/douyin.py",
    "app/services/platforms/bilibili_posts.py",
)

#: 用户可见链接的主机形状（**不含 api./passport.** 这类接口域名）
USER_FACING_HOST = re.compile(
    r"https://("
    r"(?:t|m|www|space|live)\.(?:bilibili\.com|weibo\.cn|weibo\.com|xiaohongshu\.com|douyin\.com)"
    r"|(?:bilibili\.com|weibo\.com|xiaohongshu\.com|douyin\.com)"
    r")(?=[/\"'?]|$)",
    re.MULTILINE,
)


def _allowlist() -> set[str]:
    """从 `lib.rs` 里抠出 `EXTERNAL_HOSTS`（真源只有一个，这里只是读它）。"""
    src = LIB_RS.read_text(encoding="utf-8")
    m = re.search(r"const EXTERNAL_HOSTS: &\[&str\] = &\[(.*?)\];", src, re.S)
    assert m, "lib.rs 里找不到 `EXTERNAL_HOSTS`（改名了？）"
    hosts = set(re.findall(r'"([^"]+)"', m.group(1)))
    assert hosts, "`EXTERNAL_HOSTS` 是空的 —— 那所有外链都会被拒"
    return hosts


def test_allowlist_has_no_duplicates():
    """名单里不许有重复项（重复通常意味着"补过一次又补一次"，而补错的那次没删）。"""
    src = LIB_RS.read_text(encoding="utf-8")
    m = re.search(r"const EXTERNAL_HOSTS: &\[&str\] = &\[(.*?)\];", src, re.S)
    hosts = re.findall(r'"([^"]+)"', m.group(1))
    assert len(hosts) == len(set(hosts)), f"名单里有重复：{hosts}"


def test_dynamic_url_hosts_are_allowlisted():
    """① `_dynamic_url` 三条分支的产出主机都必须在白名单里。

    ⚠️ 这一条的价值在"下一次"：B 站再出一种 major_type（例如番剧/直播回放）时，
    这里加一行就够；忘了加白名单 ⇒ 这条红，而不是等用户点「打开原文」才发现。
    """
    from app.services.fetcher import _dynamic_url

    allowed = _allowlist()
    cases = [
        ("ARCHIVE", "MAJOR_TYPE_ARCHIVE", {"bvid": "BV1xx411c7mD"}),
        ("ARTICLE", "MAJOR_TYPE_ARTICLE", {"id": "3000000"}),
        ("DYNAMIC", "MAJOR_TYPE_NONE", {}),
    ]
    for name, major_type, data in cases:
        url = _dynamic_url("1256111632951541782", major_type, data)
        assert url, f"{name} 没产出链接（用例该更新了）"
        host = urlsplit(url).hostname or ""
        assert host in allowed, (
            f"{name} 分支产出 {url}，主机 {host!r} 不在 `EXTERNAL_HOSTS` 里 "
            f"⇒ 用户点「打开原文」会弹「这个主机不在允许打开的名单里」"
        )


def test_user_facing_hosts_in_sources_are_allowlisted():
    """② 各平台模块里写死的用户可见链接主机，必须在白名单里（源码对账）。"""
    allowed = _allowlist()
    missing: dict[str, str] = {}
    for rel in LINK_SOURCES:
        path = ROOT / rel
        if not path.exists():          # 平台模块改名/删除时不该让这条假红
            continue
        text = path.read_text(encoding="utf-8")
        for host in USER_FACING_HOST.findall(text):
            if host not in allowed:
                missing.setdefault(host, rel)
    assert not missing, "这些主机是应用会拿给用户点的，但不在白名单里：\n  " + "\n  ".join(
        f"{host}（出现在 {where}）" for host, where in sorted(missing.items())
    )
    # 正对照：扫描器**真的**扫到了东西（否则"没漏"可能只是正则没匹配上）
    scanned = {
        host
        for rel in LINK_SOURCES
        if (ROOT / rel).exists()
        for host in USER_FACING_HOST.findall((ROOT / rel).read_text(encoding="utf-8"))
    }
    assert {"t.bilibili.com", "m.weibo.cn"} <= scanned, (
        f"扫描器没扫到已知的两个主机 ⇒ 正则坏了（扫到的是 {sorted(scanned)}）"
    )
