"""DDToolkit 发布工具：创建 GitHub Release + 上传两个资产。

用法:
    $env:GITHUB_TOKEN = "ghp_xxx"      # token 走环境变量，不落盘
    python scripts/upload_release_assets.py v0.9.2

行为:
    1. 校验 token（api.github.com/user）与 tag（git ls-remote 确认已推送）
    2. 创建 Release（描述优先从 docs/release-notes-<v>.md 读取，缺省用内置文本）
    3. 上传 dist-release/DDtoolkit_<v>_x64-setup.exe + DDtoolkit-portable-win64.zip
    4. 打印 Release URL

依赖: Python 3.11+（urllib，无第三方包）；本机代理 7897（见 docs/RELEASE.md §6）。
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "Mrslippe/DDToolkit"
PROXY = os.environ.get("DDTOOLKIT_GITHUB_PROXY", "http://127.0.0.1:7897")
API_BASE = f"https://api.github.com/repos/{REPO}"
UPLOAD_BASE = f"https://uploads.github.com/repos/{REPO}/releases"

DEFAULT_BODY = (
    "请查看 docs/release-notes-<version>.md 获取本版本说明。\n\n"
    "资产:\n"
    "- DDtoolkit_<version>_x64-setup.exe (Windows 安装包)\n"
    "- DDtoolkit-portable-win64.zip (便携版, 解压即用)"
)


def opener():
    proxy = urllib.request.ProxyHandler({"https": PROXY})
    return urllib.request.build_opener(proxy)


def auth(token: str):
    return {"Authorization": "token " + token, "User-Agent": "ddtoolkit-release"}


def api_get(token: str, url: str, timeout: int = 20):
    req = urllib.request.Request(url, headers=auth(token))
    with opener().open(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def api_post(token: str, url: str, payload: dict, timeout: int = 30):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={**auth(token), "Content-Type": "application/json"})
    with opener().open(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def upload_asset(token: str, rel_id: int, path: Path, ctype: str):
    url = f"{UPLOAD_BASE}/{rel_id}/assets?name={urllib.parse.quote(path.name)}"
    with open(path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={**auth(token), "Content-Type": ctype})
    with opener().open(req, timeout=300) as r:
        return json.loads(r.read().decode())


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python scripts/upload_release_assets.py v<版本>")
        return 1
    version = sys.argv[1].lstrip("v")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("[错误] 未设置 GITHUB_TOKEN 环境变量")
        return 1

    # 1. 校验 token
    try:
        user = api_get(token, "https://api.github.com/user")
        print(f"[1/4] token 有效 (login={user['login']})")
    except Exception as e:
        print(f"[错误] token 无效: {e}")
        return 1

    # 2. 确认 tag 已推送（git ls-remote；必须带 §6 定案参数——裸调用会撞
    #    schannel: SEC_E_NO_CREDENTIALS，2026-09-08 实测）
    import subprocess
    tag = f"v{version}"
    r = subprocess.run(
        ["git",
         "-c", "http.sslBackend=openssl",
         "-c", "http.sslVerify=false",
         "-c", f"http.proxy={PROXY}",
         "ls-remote", "--tags", "https://github.com/Mrslippe/DDToolkit.git", tag],
        capture_output=True, text=True, timeout=60,
    )
    if not r.stdout.strip():
        print(f"[错误] tag {tag} 未推送——请先: git tag -a {tag} -m ... && git push origin {tag}")
        if r.stderr.strip():
            print(f"       git 报错: {r.stderr.strip().splitlines()[0]}")
        return 1

    # 3. 创建 Release（描述优先读 notes 文件；两种命名都认）
    notes_candidates = [
        ROOT / "docs" / f"release-notes-v{version}.md",
        ROOT / "docs" / f"release-notes-{version}.md",
    ]
    notes_path = next((p for p in notes_candidates if p.exists()), None)
    body = notes_path.read_text(encoding="utf-8") if notes_path else DEFAULT_BODY
    print(f"[2/4] 描述来源: {notes_path.name if notes_path else '内置默认文本'}")
    try:
        rel = api_post(token, API_BASE + "/releases", {
            "tag_name": tag, "name": tag, "body": body,
            "draft": False, "prerelease": False,
        })
        rel_id = rel["id"]
        print(f"[2/4] Release created  (id {rel_id})")
    except Exception as e:
        print(f"[错误] 创建 Release 失败: {e}\n      （可能已存在——若已创建可跳过，到浏览器补传资产）")
        return 1

    # 4. 上传资产
    assets = [
        (ROOT / "dist-release" / f"DDtoolkit_{version}_x64-setup.exe", "application/octet-stream"),
        (ROOT / "dist-release" / "DDtoolkit-portable-win64.zip", "application/zip"),
    ]
    for path, ctype in assets:
        if not path.exists():
            print(f"[警告] 缺少资产 {path.name}，跳过（请先 npm run release）")
            continue
        try:
            up = upload_asset(token, rel_id, path, ctype)
            print(f"[3/4] 上传 {path.name} ... OK ({up['size']/1048576:.1f} MB)")
        except Exception as e:
            print(f"[3/4] 上传 {path.name} ... 失败: {e}")
            return 1

    print(f"[4/4] 完成: {rel['html_url']}")
    print("      ⚠️ 发布完成后建议吊销本次 PAT（token 经环境变量/日志暴露）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
