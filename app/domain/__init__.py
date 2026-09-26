"""无 IO 的纯领域函数（M1a，批次 8，devlog/213）。

**这一层是叶子**：不许 import `app.services` / `app.repositories` / `app.models` /
`app.routers`，也不许 import `sqlalchemy` / `httpx` / `fastapi` ——
放这儿的必须是**没有副作用、没有依赖**的纯函数。
判据：`tests/test_dependency_direction.py::test_domain_is_a_leaf_without_io`（AST 扫）。

**为什么要有这一层**：`repositories` 曾经为了一个纯字符串函数（`normalize_title`）
去 import `app.services.live_type` —— 一条反向边（`ARCHITECTURE-IMPROVEMENT-EXECUTION.md`
§2.7）。纯函数下沉到这里，上下两层都能用，谁也不必回头看谁。
"""
