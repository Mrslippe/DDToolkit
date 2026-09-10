"""accounts.sort_order + locked_fields — 账号排序与字段锁定（P8-B，v0.9.7）

Revision ID: f002
Revises: f001
Create Date: 2026-09-10

背景（用户 2026-09-10 P8-3/P8-4）：
1. card 视图的平台徽章要支持**长按拖动重排** → 需要持久化顺序（前端无 localStorage
   约定，数据一律落库）：`accounts.sort_order`（升序，缺省 0 时退回 id 序）；
2. 「档案设置」窗口允许手动改昵称/签名/头像，但抓取会以平台值为准覆盖
   （`_fetch_one_account` 里 `info.get("name") or acc.display_name`）→
   需要**字段锁定**：`accounts.locked_fields`（逗号分隔的字段名，如
   `display_name,sign`），抓取侧跳过被锁字段（见 scheduler._field_locked）。

新增：
- accounts.sort_order     Integer NOT NULL DEFAULT 0
- accounts.locked_fields  String  NULL
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f002'
down_revision: Union[str, Sequence[str], None] = 'f001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('accounts', sa.Column('sort_order', sa.Integer(),
                                        nullable=False, server_default='0'))
    op.add_column('accounts', sa.Column('locked_fields', sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('accounts') as batch:
        batch.drop_column('locked_fields')
        batch.drop_column('sort_order')
