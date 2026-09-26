# 213-20260926-M1a依赖方向：normalize_title下沉与平台不再写死

批次 8 = 计划 §M1a（低成本、去环）。两条越界都来自 §2.7 的核实：
**仓库层 import 服务层**、**仓库层替平台做决定**。

## 一、`normalize_title` 下沉到 `app/domain/text.py`

`repositories/vtuber_repo.py` 为了一个**纯字符串函数**去
`from app.services.live_type import normalize_title` —— 反向边。它今天不炸，
但它让"仓库层能不能被单独理解"取决于 services 的整条依赖链，而且**下一个顺手 import 会照它抄**。

- 新增 **`app/domain/`**（叶子层：无 IO 纯函数）+ `text.py`（`normalize_title` 与两条骨架正则）。
- `services/live_type.py` 改成 `from app.domain.text import normalize_title` ——
  **同一个对象的再导出**（不是副本：判据断言 `is`）。它内部两处调用（`plan_series` /
  分类骨架）跟原来一样用。
- `repositories/vtuber_repo.py` 改 import 到 `app.domain.text`；
  `tests/test_live_sessions.py` 的 import 路径跟着改（那条用例直接测这个函数，
  不改就是 ImportError —— 计划特意点过这个坑）。

## 二、`upsert_danmakus` 的 `platform` 由调用方传入

`LiveSessionRepo.upsert_danmakus` 的 fields 里写死 `"platform": "bilibili"`，
而它自称"其他数据源接入接口" —— **仓库层替平台做了决定**。

改签名：`upsert_danmakus(account_id, items, *, platform: str)`，**刻意没有默认值**
（给默认值 = 把决定权又收回来，判据直接断言 `default is empty`）。
三个调用方各传各自的平台：danmakus 源适配器（`acc.platform`）、回填脚本、19 处测试调用点。

## 三、判据（`tests/test_dependency_direction.py`，5 条）+ 行为判据 1 条

| 判据 | 内容 |
|---|---|
| `repositories` 不许 import `app.services` | 依赖方向：routers → services → repositories → models |
| `models` 不许 import `services`/`repositories`/`routers` | ORM 是最下面那层 |
| `domain` 是叶子：也不许 `sqlalchemy`/`httpx`/`fastapi` | 否则它只是"换个地方的服务层" |
| `normalize_title` 的家在 domain，services 上那个**是同一个对象** | 搬家不许搬成副本 |
| `upsert_danmakus` 的 `platform` 无默认值 | 仓库层不许替平台做决定 |
| （行为）非 bilibili 平台写进去就是它 | 写死那版会把它悄悄存成 bilibili，而行数/字段断言**全都照样绿** |

⚠️ 判据一律走 **AST**，不做文本搜索：`vtuber_repo.py` 的注释里就写着那句历史 import，
`purge.py` 的文档串里也写着"不提交" —— 本仓"判据的举例命中判据自己"已经踩过 5 次。

**反向验证（4/4 真红）**：把反向边加回去 · domain 里 `import sqlalchemy` ·
给 `platform` 一个默认值 · 参数收了但字段里又写死 bilibili。

## 四、顺带补齐的复述面（批次 7 改的规则，本批补搜）

批次 7 把"仓库层写操作当场 commit"改成了"多数末尾 commit + 三类例外"，但只在
`ARCHITECTURE.md` §5/§6 与仓库文档里改了。本批按"改规则要**多词**搜一遍"的纪律补搜
（`当场 commit` / `12 个 Repo` / `12 个类` 三种词形），补上漏掉的 4 处：
根 `README.md`、`docs/README.md`、skill 的 `change-recipes.md`（C1 第 4 步）与
`doc-map.md`（§2 描述）。**仓库里没有第二处"当场 commit"了**。

## 五、提炼

- 不变量 → `ARCHITECTURE.md` §6 第 33 条（依赖方向 + 纯函数下沉 + 仓库层不替平台做决定）；
- `ARCHITECTURE.md` §5 的分层图与目录表新增 `app/domain/`；
- `backend-repositories-and-routers.md` §2.4/§4 同步签名与分层注意点。

## 六、没做

- `docs/tools/gen_diagrams.py` 的图 1（系统整体分层）**没跟着改**：它是 2026-09-13 的
  手绘快照（里面还写着"11 个模型 / 16 个端点 / alembic f004"），只补一格反而更误导 ——
  要改就整张重画，那是另一批的事。
