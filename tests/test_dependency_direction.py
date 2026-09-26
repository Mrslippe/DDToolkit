# -*- coding: utf-8 -*-
"""分层依赖方向（M1a，批次 8）：**仓库层不许反向 import 服务层**。

起因（`ARCHITECTURE-IMPROVEMENT-EXECUTION.md` §2.7 核实）：`repositories/vtuber_repo.py`
为了一个纯字符串函数 `normalize_title` 去 import `app.services.live_type` —— 一条**反向边**。
它今天不炸，但它让"仓库层能不能被单独复用/理解"取决于 services 的整条依赖链，
而且下一个"顺手"的反向 import 会照它抄。

本文件钉住的规矩（反向改法都能红，见 devlog/213）：

| 规矩 | 为什么 |
|---|---|
| `app/repositories/**` 不许 import `app.services.**` | 依赖方向：routers → services → repositories → models |
| `app/models/**` 不许 import `app.services.**` / `app.repositories.**` / `app.routers.**` | ORM 是更下面的那层；它 import 上层 = 环 |
| `app/domain/**` 是**叶子**：不许 import 上面任何一层（含 `app.core`——`core.config` 读环境变量），也不许 import `sqlalchemy` / `httpx` / `fastapi` | 放这儿的必须是无 IO 的纯函数 —— 否则它只是"换个地方的服务层" |
| `normalize_title` 的家 = `app.domain.text`，`services.live_type` 只是**同一个对象**的再导出 | 搬家不许搬成副本（副本会各自漂移） |
| `LiveSessionRepo.upsert_danmakus` 的 `platform` **由调用方传入且没有默认值** | 仓库层不许替平台做决定（§2.7 第二条越界） |

⚠️ 判据一律走 **AST**，不做文本搜索：`vtuber_repo.py` 的注释里就写着
"`from app.services.live_type import normalize_title`" 这句历史说明，文本搜会命中它。
"""
from __future__ import annotations

import ast
import inspect
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP = REPO / "app"

#: 分层：键 = 目录，值 = 该层**不许**出现的 import 前缀
FORBIDDEN = {
    "repositories": ("app.services",),
    "models": ("app.services", "app.repositories", "app.routers"),
    # domain 连 `app.core` 都不许碰：`core.config` 读环境变量 / `.env`，那是 IO。
    # 真需要某个配置值 ⇒ 由调用方当参数传进来（纯函数才放这一层）。
    "domain": ("app.services", "app.repositories", "app.models", "app.routers", "app.core",
               "sqlalchemy", "httpx", "fastapi"),
}


def _imports(path: Path) -> list[tuple[str, int]]:
    """文件里的绝对 import（模块名, 行号）。相对 import 是包内引用，不算跨层。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: list[tuple[str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.extend((alias.name, node.lineno) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:                     # from . import x / from .y import z
                continue
            out.append((node.module or "", node.lineno))
    return out


def _violations(layer: str) -> list[str]:
    bad: list[str] = []
    for path in sorted((APP / layer).rglob("*.py")):
        for mod, line in _imports(path):
            for prefix in FORBIDDEN[layer]:
                if mod == prefix or mod.startswith(prefix + "."):
                    bad.append(f"{path.relative_to(APP)}:{line} → {mod}")
    return bad


def test_repositories_do_not_import_services():
    bad = _violations("repositories")
    assert not bad, "仓库层出现了反向边（repositories → services）：" + "、".join(bad)


def test_models_do_not_import_upper_layers():
    bad = _violations("models")
    assert not bad, "ORM 层 import 了上层（成环）：" + "、".join(bad)


def test_domain_is_a_leaf_without_io():
    bad = _violations("domain")
    assert not bad, "domain 层不纯（要么 import 了上层，要么拖进了 IO 库）：" + "、".join(bad)


def test_normalize_title_lives_in_domain_and_is_reexported_not_copied():
    """搬家的判据：家在 `app.domain.text`，`services.live_type` 上的那个是**同一个对象**。"""
    from app.domain.text import normalize_title as home
    from app.services.live_type import normalize_title as reexported

    assert reexported is home, "services.live_type 上是一份副本 —— 两份实现迟早漂移"
    assert home("【歌回】周一 20:00 第12期") == "歌回"
    assert home("晚上好！") == "晚上好"
    assert home("杂谈  回") == "杂谈回"        # 标点/空格剥离
    assert home(None) == "" and home("") == ""


def test_upsert_danmakus_takes_the_platform_from_the_caller():
    """§2.7 第二条越界：仓库层曾经把 `"platform": "bilibili"` 写死在自己肚子里。"""
    from app.repositories.vtuber_repo import LiveSessionRepo

    params = inspect.signature(LiveSessionRepo.upsert_danmakus).parameters
    assert "platform" in params, "platform 必须由调用方传入（仓库层不替平台做决定）"
    assert params["platform"].default is inspect.Parameter.empty, \
        "给 platform 一个默认值 = 又把「平台」这个决定塞回了仓库层"
