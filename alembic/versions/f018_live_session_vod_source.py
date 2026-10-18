"""f018: `live_sessions.vod_source` —— 记账"这条录播地址是谁写的"

## 为什么需要它（2026-10-15 用户报"清空后录播地址依旧在"）

改前的"清空已匹配"是**先真扫一遍**（19 次上游请求、十几秒）再逐条清：
- 用户点确认后请求要挂十几秒，看起来像"点了没反应 / 库被卡住"；
- 而判据只能靠"库里这个地址是否等于本次扫描结果"——**每次都重扫**，慢且脆。

更根本的是：`live_sessions.vod_url` 是 f013 起的**用户手填字段**（不变量 39），
而"扫描写入"与"用户手填"在库里**长得一模一样** ⇒ "清空扫出来的"只能靠重扫去猜。

⇒ 加一列**只由写入方维护**的记账：

| 取值 | 谁写的 | 清空时 |
|---|---|---|
| `NULL` | 还没人写（绝大多数历史行） | 不动 |
| `'match'` | `vod-apply`（自动匹配） | **清**（并清掉这一格） |
| `'manual'` | 用户（`PATCH` 手填 / 单场补录播） | **保留** |

⚠️ 历史行**一律留 NULL**（不猜）：迁移只加列，不做回填 ——
把"看起来像自动写的"回填成 `match` 会在用户手填过的库上误清（不可再生字段，不变量 39）。
代价是**历史写入的那些录播清不掉**（它们的来源无人记录）；用户口径允许，
而且下次扫描写入的就会被正确记账。

Revision ID: f018
Revises: f017
"""
from alembic import op
import sqlalchemy as sa

revision = "f018"
down_revision = "f017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("live_sessions", sa.Column("vod_source", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("live_sessions") as batch:
        batch.drop_column("vod_source")
