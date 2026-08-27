"""vtuber_background — vtubers.background_path 列（卡片页自定义背景）

Revision ID: d002
Revises: d001
Create Date: 2026-08-26

背景：右栏卡片页自定义背景端口，VTuber 存 static/custom_bg/ 相对路径。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd002'
down_revision: Union[str, Sequence[str], None] = 'd001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('vtubers', sa.Column('background_path', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('vtubers', 'background_path')