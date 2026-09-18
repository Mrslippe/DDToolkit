"""vtuber_events 加 kind / emoji（R42-A，devlog/162）

Revision ID: f007
Revises: f006
Create Date: 2026-09-19

用户口径（2026-09-19）：「纪念日卡片**开放给用户自行添加纪念日**，并且可以自定义
**名称、日期、emoji** 等」+「大事记用**时间轴**的形式来呈现」。

为什么复用 `vtuber_events` 而不是新建一张表（用户拍板）：
这张表当初（P7）的注释写的就是「**手动维护的纪念日/活动条目**……卡片可增删」——
它本来就是为这件事建的，只是 UI 一直没接。两张卡各自按 `kind` 取自己的条目、互不串。

- `kind`：`anniversary`（纪念日卡）/ `event`（大事记时间轴）；**默认 `event`**
  （既有行都是活动条目 ⇒ 回填成 event 才符合原语义）；
- `emoji`：纪念日的自定义图标（可空 —— 老行与不填的行都不该被逼着给一个）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f007'
down_revision: Union[str, Sequence[str], None] = 'f006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ⚠️ 必须走 `batch_alter_table`：**SQLite 不支持 `ALTER COLUMN`**
    # （第一版直接 `op.alter_column(...)` 摘默认值 ⇒ `sqlite3.OperationalError: near "ALTER":
    #   syntax error`，被 `test_orm_metadata_matches_migration_chain` 当场抓住）。
    # 批量模式下 alembic 会重建表，加列 + 回填 + 建索引都在里面完成。
    # server_default='event' 让**既有行**一并回填成 'event'（它们是 P7 的活动条目）；
    # 这个默认值**保留在库里**，与模型上的 `server_default="event"` 对齐
    # （摘掉它反而要再来一次重建，且 autogenerate 比对会报差异）。
    with op.batch_alter_table('vtuber_events') as batch:
        batch.add_column(sa.Column('kind', sa.String(), nullable=False, server_default='event'))
        batch.add_column(sa.Column('emoji', sa.String(), nullable=True))
    op.create_index('ix_vtuber_events_vtuber_kind', 'vtuber_events', ['vtuber_id', 'kind'])


def downgrade() -> None:
    op.drop_index('ix_vtuber_events_vtuber_kind', table_name='vtuber_events')
    op.drop_column('vtuber_events', 'emoji')
    op.drop_column('vtuber_events', 'kind')
