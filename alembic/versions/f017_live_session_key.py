"""场次身份列：让按类型聚合真的能直查索引 — v1.2.x

Revision ID: f017
Revises: f016
Create Date: 2026-10-13

新增一列 + 一个索引：
- `live_sessions.session_key` TEXT NULL —— **合并组的锚**（只写在"代表行"上）；
- `(account_id, session_key)` 索引 —— 物化时按"场次"取成员行走它。

## 为什么还要这一列（f016 之后实测出来的两个缺口）

f016 落了 `category`/`category_from`，但两个入口**仍然只能读合并视图**：把统计改成
`GROUP BY category` 会同时错两头（`scripts/check_type_index_parity.py`，真机 14 账号实测）：

| 缺口 | 实测 | 成因 |
|---|---|---|
| 兜底看不见 | 合并 7,639 场 vs 按列 3,948 行 | f016 有意让 `fallback` **不落库**（写 NULL）⇒ 任何 SQL 聚合都漏掉这批（约 55%） |
| 按行数多算 | 14/14 账号全不齐，合计多 **123 行** | 同一场可能有多行（danmakus + feed、self 快照并入）⇒ `GROUP BY` 数行、合并数场次 |

⚠️ 还有一条更隐蔽的：组内各行的 `category` **可能不一致**——实测 123 个多行组里
**57 组**是两个值（那是不同规则版本下分别落库留下的）。所以"取哪一行"必须是**规则**，
不能是运气。

## 这一列怎么定（两条规则，与 `live_settle.materialize` 一一对应）

1. **代表行** = 组里**源优先级最高**的那个真源 id 对应的行（与 `merged()` 定对外 id 同一条
   规则）⇒ 只有它有 `session_key`，**同组其余行一律 NULL**。于是
   `GROUP BY category WHERE session_key IS NOT NULL` = 每场一次。
2. **兜底也落库**：`category='live'` + `category_from='fallback'`。
   `category_from` 仍是"这一行定稿过没有"的**唯一信号**（NULL = 还没定稿），
   而 `category` 从此总是"这一场该显示什么"⇒ 按列聚合与日历同源。

## 与"写时定稿"的关系（口径没变，只是补齐了读侧）

用户口径是「写这一行就定稿这一行、不回头改别的行」。合并分组**天生要看邻近行**
（room/dup/interrupt/restart 都是时间判据），所以"哪些行是同一场"只能在读路径算出来
——本列就是**读路径把算出来的分组顺手记住**（惰性物化，规则见 f016 那套：迁移会自动跑、
回填脚本不会）。它不改类型本身，只回答"这一场是谁"。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f017'
down_revision: Union[str, Sequence[str], None] = 'f016'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('live_sessions', sa.Column('session_key', sa.Text(), nullable=True))
    op.create_index('ix_live_sessions_account_session', 'live_sessions',
                    ['account_id', 'session_key'])


def downgrade() -> None:
    op.drop_index('ix_live_sessions_account_session', table_name='live_sessions')
    with op.batch_alter_table('live_sessions') as batch:
        batch.drop_column('session_key')
