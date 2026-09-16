"""DDToolkit 发布工具：创建/复用 GitHub Release + 上传两个资产（**幂等**）。

用法:
    $env:GITHUB_TOKEN = "ghp_xxx"      # token 走环境变量，不落盘
    python scripts/upload_release_assets.py v1.0.1

行为（`scripts/release.py` 的 `release` 步骤直接调它）:
    1. 校验 token（api.github.com/user）与 tag（git ls-remote 确认已推送）
    2. Release：**已存在则复用**（`GET /releases/tags/<tag>`），并用 notes 文件内容
       `PATCH` 覆盖描述（历史事故：描述误用内置默认文本，v0.9.2 时手工 PATCH 修过）
    3. 上传 dist-release/DDtoolkit_<v>_x64-setup.exe + DDtoolkit-portable-win64.zip；
       同名资产已存在且**大小一致 → 跳过**，大小不同 → 删掉重传（重打版后续跑的场景）
    4. 打印 Release URL

幂等的意义：发布中途失败（网络/TLS/资产没打完）时，重跑不会撞 422
（"already_exists"），也不会落下半份资产 —— `release.py --from release` 依赖这一点。

依赖: Python 3.11+（urllib，无第三方包）；本机代理 7897（见 docs/RELEASE.md §6）。
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "Mrslippe/DDToolkit"
PROXY = os.environ.get("DDTOOLKIT_GITHUB_PROXY", "http://127.0.0.1:7897")
API_BASE = f"https://api.github.com/repos/{REPO}"
UPLOAD_BASE = f"https://uploads.github.com/repos/{REPO}/releases"

DEFAULT_BODY = (
    "请查看 docs/releases/v<version>.md 获取本版本说明。\n\n"
    "资产:\n"
    "- DDtoolkit_<version>_x64-setup.exe (Windows 安装包)\n"
    "- DDtoolkit-portable-win64.zip (便携版, 解压即用)"
)


def opener():
    proxy = urllib.request.ProxyHandler({"https": PROXY})
    return urllib.request.build_opener(proxy)


def auth(token: str):
    return {"Authorization": "token " + token, "User-Agent": "ddtoolkit-release"}


def api_request(token: str, url: str, method: str = "GET", payload: dict | None = None,
                timeout: int = 30):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = auth(token)
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with opener().open(req, timeout=timeout) as r:
        body = r.read().decode()
        return json.loads(body) if body.strip() else None


def api_get_or_none(token: str, url: str):
    """GET，404 返回 None（"还没建"与"出错"要分开）。"""
    try:
        return api_request(token, url)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def upload_asset(token: str, rel_id: int, path: Path, ctype: str):
    url = f"{UPLOAD_BASE}/{rel_id}/assets?name={urllib.parse.quote(path.name)}"
    with open(path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={**auth(token), "Content-Type": ctype})
    with opener().open(req, timeout=300) as r:
        return json.loads(r.read().decode())


def notes_body(version: str) -> tuple[str, str]:
    """返回 (描述正文, 来源标注)。新路径优先，兼容旧命名。"""
    for p in (ROOT / "docs" / "releases" / f"v{version}.md",
              ROOT / "docs" / f"release-notes-v{version}.md",
              ROOT / "docs" / f"release-notes-{version}.md"):
        if p.exists():
            return p.read_text(encoding="utf-8"), p.name
    return DEFAULT_BODY, "内置默认文本"


def tag_pushed(version: str) -> tuple[bool, str]:
    """确认 tag 已在远端（git ls-remote；**必须带 §6 定案参数** —— 裸调用会撞
    schannel: SEC_E_NO_CREDENTIALS，2026-09-08 实测）。"""
    import subprocess
    tag = f"v{version}"
    r = subprocess.run(
        ["git",
         "-c", "http.sslBackend=openssl",
         "-c", "http.sslVerify=false",
         "-c", f"http.proxy={PROXY}",
         "ls-remote", "--tags", f"https://github.com/{REPO}.git", tag],
        capture_output=True, text=True, timeout=60,
    )
    if r.stdout.strip():
        return True, r.stdout.strip().splitlines()[0].split("\t")[0]
    # 代理不通时再试一次直连（release.py 的推送也是这个策略）
    r2 = subprocess.run(
        ["git", "-c", "http.sslBackend=openssl", "-c", "http.sslVerify=false",
         "-c", "http.proxy=", "-c", "https.proxy=",
         "ls-remote", "--tags", f"https://github.com/{REPO}.git", tag],
        capture_output=True, text=True, timeout=60,
    )
    if r2.stdout.strip():
        return True, r2.stdout.strip().splitlines()[0].split("\t")[0]
    return False, (r.stderr or r2.stderr or "").strip().splitlines()[0] if (r.stderr or r2.stderr) else ""


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python scripts/upload_release_assets.py v<版本>")
        return 1
    version = sys.argv[1].lstrip("v")
    tag = f"v{version}"
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("[错误] 未设置 GITHUB_TOKEN 环境变量")
        return 1

    # 1. 校验 token
    try:
        user = api_request(token, "https://api.github.com/user")
        print(f"[1/5] token 有效 (login={user['login']})")
    except Exception as e:                                        # noqa: BLE001
        print(f"[错误] token 无效: {e}")
        return 1

    # 2. tag 必须已在远端（否则 Release 会指向一个不存在的 tag）
    ok, detail = tag_pushed(version)
    if not ok:
        print(f"[错误] tag {tag} 未推送——请先: git push origin {tag}")
        if detail:
            print(f"       git 报错: {detail}")
        return 1
    print(f"[2/5] tag {tag} 已在远端（{detail[:8]}）")

    # 3. Release：已存在则复用 + PATCH 描述；不存在则创建
    body, src = notes_body(version)
    existing = api_get_or_none(token, f"{API_BASE}/releases/tags/{tag}")
    if existing:
        rel = api_request(token, f"{API_BASE}/releases/{existing['id']}", method="PATCH",
                          payload={"body": body, "name": tag})
        print(f"[3/5] Release 复用 (id {rel['id']})，描述已覆盖自 {src}")
    else:
        try:
            rel = api_request(token, API_BASE + "/releases", method="POST", payload={
                "tag_name": tag, "name": tag, "body": body,
                "draft": False, "prerelease": False,
            })
        except Exception as e:                                    # noqa: BLE001
            print(f"[错误] 创建 Release 失败: {e}")
            return 1
        print(f"[3/5] Release created  (id {rel['id']})，描述来源 {src}")

    # 4. 资产：同名同大小跳过；同名不同大小删了重传（重打版后续跑的常态）
    have = {a["name"]: a for a in (rel.get("assets") or [])}
    assets = [
        (ROOT / "dist-release" / f"DDtoolkit_{version}_x64-setup.exe", "application/octet-stream"),
        (ROOT / "dist-release" / "DDtoolkit-portable-win64.zip", "application/zip"),
        # 应用内更新（R23）：updater 先取 latest.json，再按里面的 url 下**安装包 exe**
        # （NSIS 的更新流程就是"下载安装包 + 静默运行"，没有单独的 zip 载体）。
        # 签名不单独传 —— 它写在 latest.json 的 `signature` 字段里。
        (ROOT / "dist-release" / "latest.json", "application/json"),
    ]
    for path, ctype in assets:
        if not path.exists():
            print(f"[警告] 缺少资产 {path.name}，跳过（请先 npm run release）")
            continue
        local_size = path.stat().st_size
        old = have.get(path.name)
        if old and old.get("size") == local_size:
            print(f"[4/5] {path.name} 已存在且大小一致，跳过（{local_size/1048576:.1f} MB）")
            continue
        if old:
            api_request(token, f"{API_BASE}/releases/assets/{old['id']}", method="DELETE")
            print(f"[4/5] {path.name} 大小变了（远端 {old.get('size')} ≠ 本地 {local_size}）→ 已删旧资产")
        try:
            up = upload_asset(token, rel["id"], path, ctype)
        except Exception as e:                                    # noqa: BLE001
            print(f"[4/5] 上传 {path.name} ... 失败: {e}")
            return 1
        print(f"[4/5] 上传 {path.name} ... OK ({up['size']/1048576:.1f} MB)")

    # 5. 复核：资产齐不齐（少一个就是"用户下不到包"）
    final = api_get_or_none(token, f"{API_BASE}/releases/tags/{tag}") or rel
    names = sorted(a["name"] for a in (final.get("assets") or []))
    print(f"[5/5] 远端资产: {names}")
    print(f"      {final['html_url']}")
    print("      ⚠️ 发布完成后建议吊销本次 PAT（token 经环境变量/日志暴露）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
