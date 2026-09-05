"""vtuber_events — 重要日期·大型活动（P7 档案视图细化，手动维护事件表）

Revision ID: e005
Revises: e004
Create Date: 2026-09-06

新增：
- vtuber_events  重要日期/大型活动手动条目（title + event_date "YYYY-MM-DD"），
  与 VTuber.birthday/debut_date（年循环纪念日）互补；CRUD API 见 routers/vtuber.py。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e005'
down_revision: Union[str, Sequence[str], None] = 'e004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'vtuber_events',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('vtuber_id', sa.Integer(), sa.ForeignKey('vtubers.id'), nullable=False),
        sa.Column('title', sa.String(), nullable=False),
        sa.Column('event_date', sa.String(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_vtuber_events_vtuber_date', 'vtuber_events',
                    ['vtuber_id', 'event_date'])


def downgrade() -> None:
    op.drop_index('ix_vtuber_events_vtuber_date', table_name='vtuber_events')
    op.drop_table('vtuber_events')
