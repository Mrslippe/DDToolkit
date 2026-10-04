"""注解里的名字必须在模块里真的存在（CI 3.12 与本地 3.14 的**口径差**，devlog/236）。

## 为什么需要这条

2026-09-27 两次踩到同一件事：本地 `.venv` 是 **3.14**（PEP 649，函数注解**惰性**求值），
而 CI 的 3.12 腿在 `def` 语句执行时就把注解算出来。于是"注解里写了个没导入的名字"
这种错的表现是：

| 本地（3.14） | CI（3.12） |
|---|---|
| `tsc`/`eslint`/`pytest`/探针**全绿** | 四条腿全红（import 期 `NameError`） |

- 第一次：`scheduler.py` 两处 `-> Any` 而没导入 `Any`（devlog/229 的修复提交）；
- 第二次：`platforms/bilibili_posts.py` 的 `client: httpx.AsyncClient | None` 而没
  `import httpx`（devlog/236）。

第二次说明"写进 `DEV-LOOP` 当教训"不够 —— 教训要靠判据兜住。所以这里把 `app/` 下
**每个模块的函数/类注解主动求值一次**（`typing.get_type_hints`）：算不出来就是错，
3.14 也能提前发现 3.12 的问题。

⚠️ 反向验证：删掉 `bilibili_posts.py` 里的 `import httpx` ⇒ 本用例当场红。

## 判据的边界（如实交代）

只检查**没有** `from __future__ import annotations` 的模块 —— 那才是"3.12 会在 import 时炸"
的那一类。带这行的模块（如 `routers/img_proxy.py`：它为了冷启动把 httpx **故意**延迟加载，
注解写成 `httpx.AsyncClient | None` 也不会被求值）不在本判据范围内，这是**设计如此**，
不是漏网：本判据要挡的是"本地绿 / CI 红"，不是"注解写得漂不漂亮"。

跳过的模块会被数出来并打印，且断言"跳过的都确实带那行" ⇒ 这份豁免名单不会悄悄变长。
"""
from __future__ import annotations

import importlib
import inspect
import pathlib
import typing

import app as app_pkg

_FUTURE_IMPORT = "from __future__ import annotations"


def _app_sources() -> list[tuple[str, str]]:
    """(模块导入路径, 源码) 列表（跳过 `__init__`）。"""
    root = pathlib.Path(app_pkg.__file__).parent
    out: list[tuple[str, str]] = []
    for p in sorted(root.rglob("*.py")):
        if p.name == "__init__.py":
            continue
        rel = p.relative_to(root.parent).with_suffix("")
        out.append((".".join(rel.parts), p.read_text(encoding="utf-8")))
    return out


def _eager_modules() -> tuple[list[str], list[str]]:
    """(要检查的模块, 豁免的模块)。豁免 = 源码里有 `from __future__ import annotations`。"""
    eager: list[str] = []
    exempt: list[str] = []
    for name, src in _app_sources():
        (exempt if _FUTURE_IMPORT in src else eager).append(name)
    return eager, exempt


def _callables(mod: object, module_name: str) -> list[tuple[str, object]]:
    """模块里**定义在本地**的函数与方法（含 staticmethod / classmethod 的真身）。"""
    found: list[tuple[str, object]] = []
    for name, obj in vars(mod).items():
        if inspect.isfunction(obj) and obj.__module__ == module_name:
            found.append((name, obj))
        elif inspect.isclass(obj) and obj.__module__ == module_name:
            for mname, m in vars(obj).items():
                raw = m.__func__ if isinstance(m, (staticmethod, classmethod)) else m
                if inspect.isfunction(raw):
                    found.append((f"{name}.{mname}", raw))
    return found


def test_every_app_annotation_resolves():
    """每个模块的注解都要能在**自己的模块命名空间**里算出来。"""
    eager, exempt = _eager_modules()
    assert eager, "一个待检查模块都没有，像是枚举坏了"
    # ⚠️ 这里原先断言 `len(exempt) < len(eager)`（"豁免不能比受检还多"）。2026-10-04 接抖音时
    #    它红了：新加的模块（适配器/登录态，以及 vendored 的三个签名文件）**全都带**那行
    #    `from __future__ import annotations` ⇒ 豁免数自然超过受检数，而判据本身并没有空转。
    #    改成给**受检模块**一个绝对下限：这才真正对应"判据别空转"，且不会因为
    #    "多写了几个规范模块"而红。豁免的正当性由 `_eager_modules` 的构造保证（带那行才进豁免）。
    assert len(eager) >= 20, f"待检查模块太少（{len(eager)}），判据快空转了"

    bad: list[str] = []
    checked = 0
    for module_name in eager:
        mod = importlib.import_module(module_name)
        for label, fn in _callables(mod, module_name):
            checked += 1
            try:
                typing.get_type_hints(fn)
            except Exception as exc:  # noqa: BLE001 —— 名字缺失/写错都要点名
                bad.append(f"{module_name}.{label}: {type(exc).__name__}: {exc}")

    assert checked > 50, f"只检查了 {checked} 个函数，像是模块枚举坏了"
    print(f"[注解判据] 检查 {len(eager)} 个模块 / {checked} 个函数；"
          f"豁免 {len(exempt)} 个（带 `from __future__ import annotations`）")
    assert bad == [], (
        "这些注解在模块命名空间里算不出来（3.12 会在 import 时就炸，本地 3.14 不会）：\n  "
        + "\n  ".join(bad)
    )


def test_dataclass_field_annotations_resolve():
    """带注解的**类属性**（dataclass / pydantic 模型）同样要求名字存在。

    这类更隐蔽：`@dataclass` 会在类创建时读注解，而 pydantic 模型在**实例化**时才读 ——
    漏一个 `Optional` / 自定义类型，可能是"跑起来才炸"。
    """
    eager, _ = _eager_modules()
    bad: list[str] = []
    for module_name in eager:
        mod = importlib.import_module(module_name)
        for name, obj in vars(mod).items():
            if not (inspect.isclass(obj) and obj.__module__ == module_name):
                continue
            try:
                typing.get_type_hints(obj)
            except Exception as exc:  # noqa: BLE001
                bad.append(f"{module_name}.{name}: {type(exc).__name__}: {exc}")

    assert bad == [], "类注解算不出来：\n  " + "\n  ".join(bad)
