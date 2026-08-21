"""post_archived — posts 表新增 is_archived 列

Revision ID: c001
Revises: b001
Create Date: 2026-08-06

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c001'
down_revision: Union[str, Sequence[str], None] = 'b001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('posts',
        sa.Column('is_archived', sa.Boolean(), nullable=False, server_default='0')
    )


def downgrade() -> None:
    op.drop_column('posts', 'is_archived')
