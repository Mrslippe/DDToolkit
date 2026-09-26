"""vtubers.sort_order — 左栏主播手排顺序（R51，devlog/228）

Revision ID: f008
Revises: f007
Create Date: 2026-09-27

背景（用户 2026-09-27）：「长按鼠标左键可以拖动主播进行排序」。

左栏原来的"默认顺序"就是**数据库返回顺序**（等价于 id 序），前端无 localStorage
约定（与 P8-B 平台徽章同一条纪律：用户手改的顺序一律落库，否则刷新/重装就回到原样）。
于是照 `accounts.sort_order`（f002）的先例给 `vtubers` 加一列：

- 默认 0 ⇒ 没排过的那些仍按 id 序（老数据行为不变）；
- 拖动后按新顺序重写为 0,1,2…，列表查询按 `(sort_order, id)` 升序。

新增：`vtubers.sort_order` Integer NOT NULL DEFAULT 0
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f008'
down_revision: Union[str, Sequence[str], None] = 'f007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('vtubers', sa.Column('sort_order', sa.Integer(),
                                       nullable=False, server_default='0'))


def downgrade() -> None:
    with op.batch_alter_table('vtubers') as batch:
        batch.drop_column('sort_order')
